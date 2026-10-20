package identity

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

const testPassword = "node-compatible-password-2026"

// Produced by Node crypto.scryptSync using salt 00112233445566778899aabbccddeeff.
const nodeHash = "scrypt$16384$8$1$ABEiM0RVZneImaq7zN3u_w$eGE4qF8n4m3juolywes1cciDplvCzB9kLAsOSu0w8cOq2tPb7NJr-_YbrwvCi_pxJtfB4kzXCwDbPUd6rK0IcA"

func fixture(t *testing.T) (*Store, string) {
	t.Helper()
	path := filepath.Join(t.TempDir(), "private", "identities.json")
	s, e := Open(path, "office")
	if e != nil {
		t.Fatal(e)
	}
	return s, path
}
func status(t *testing.T, e error, want int) {
	t.Helper()
	var f *Error
	if !errors.As(e, &f) || f.Status != want {
		t.Fatalf("error=%v want status %d", e, want)
	}
}
func join(t *testing.T, s *Store, username string, roles []string) *Actor {
	t.Helper()
	v, e := s.CreateInvitation("bootstrap", InvitationInput{Username: username, Name: "张明", Department: "项目部", Title: "项目经理", Roles: roles})
	if e != nil {
		t.Fatal(e)
	}
	a, e := s.AcceptInvitation(v.Token, testPassword)
	if e != nil {
		t.Fatal(e)
	}
	return a
}

func TestNodeScryptCompatibility(t *testing.T) {
	ok, e := PasswordMatches(testPassword, nodeHash)
	if e != nil || !ok {
		t.Fatalf("node fixture incompatible: %v", e)
	}
	ok, e = PasswordMatches("wrong", nodeHash)
	if e != nil || ok {
		t.Fatal("wrong password accepted")
	}
	for _, v := range []string{strings.Replace(nodeHash, "16384", "1048576", 1), nodeHash + "=", strings.Replace(nodeHash, "$8$", "$9$", 1)} {
		if _, _, ok := ParsePasswordHash(v); ok {
			t.Fatal("malformed hash accepted")
		}
	}
	if _, e := HashPassword("short"); e == nil {
		t.Fatal("weak password accepted")
	}
	if _, e := HashPassword(strings.Repeat("a", 1025)); e == nil {
		t.Fatal("oversized password accepted")
	}
}
func TestBootstrapPublicDataAndPersistence(t *testing.T) {
	s, path := fixture(t)
	if s.ResolveLegacy("").ID != "bootstrap" || s.ResolveLegacy("other") != nil {
		t.Fatal("legacy mapping")
	}
	invite, e := s.CreateInvitation("bootstrap", InvitationInput{Username: "ZHANG", Name: "张明"})
	if e != nil {
		t.Fatal(e)
	}
	raw, _ := os.ReadFile(path)
	if strings.Contains(string(raw), invite.Token) || strings.Contains(string(raw), testPassword) {
		t.Fatal("secret stored in clear")
	}
	st, _ := os.Stat(path)
	if st.Mode().Perm() != 0600 {
		t.Fatal("unsafe mode")
	}
	people, e := s.ListEmployees("bootstrap")
	if e != nil {
		t.Fatal(e)
	}
	b, _ := json.Marshal(people)
	if strings.Contains(string(b), "passwordHash") || strings.Contains(string(b), "epoch") {
		t.Fatal("private fields exposed")
	}
	people[0].Roles[0] = "employee"
	if s.ResolveLegacy("").Roles[0] != "admin" {
		t.Fatal("alias mutates store")
	}
	reopened, e := Open(path, "office")
	if e != nil {
		t.Fatal(e)
	}
	a, e := reopened.AcceptInvitation(invite.Token, testPassword)
	if e != nil || a.Username != "zhang" {
		t.Fatalf("persisted invitation: %v", e)
	}
}
func TestInviteSingleUseExpiryAndReissue(t *testing.T) {
	clock := time.Date(2026, 10, 20, 0, 0, 0, 0, time.UTC)
	s, e := OpenWithClock(filepath.Join(t.TempDir(), "identity.json"), "office", func() time.Time { return clock })
	if e != nil {
		t.Fatal(e)
	}
	v, e := s.CreateInvitation("bootstrap", InvitationInput{Username: "zhang", Name: "张明", ExpiresInHours: 1})
	if e != nil {
		t.Fatal(e)
	}
	clock = clock.Add(time.Hour)
	_, e = s.AcceptInvitation(v.Token, testPassword)
	status(t, e, 410)
	second, e := s.ReissueInvitation("bootstrap", v.Employee.ID, 72)
	if e != nil {
		t.Fatal(e)
	}
	third, e := s.ReissueInvitation("bootstrap", v.Employee.ID, 72)
	if e != nil {
		t.Fatal(e)
	}
	_, e = s.AcceptInvitation(second.Token, testPassword)
	status(t, e, 410)
	a, e := s.AcceptInvitation(third.Token, testPassword)
	if e != nil || a.Epoch != 2 {
		t.Fatalf("join: %v", e)
	}
	_, e = s.AcceptInvitation(third.Token, testPassword)
	status(t, e, 410)
}
func TestConcurrentInviteExchange(t *testing.T) {
	s, _ := fixture(t)
	v, _ := s.CreateInvitation("bootstrap", InvitationInput{Username: "zhang", Name: "张明"})
	var wg sync.WaitGroup
	results := make(chan error, 3)
	for i := 0; i < 3; i++ {
		wg.Add(1)
		go func() { defer wg.Done(); _, e := s.AcceptInvitation(v.Token, testPassword); results <- e }()
	}
	wg.Wait()
	close(results)
	success := 0
	for e := range results {
		if e == nil {
			success++
		} else {
			status(t, e, 410)
		}
	}
	if success != 1 {
		t.Fatalf("accepted %d exchanges", success)
	}
}
func TestRolesDisableRevokeEpochAndDirectory(t *testing.T) {
	s, _ := fixture(t)
	a := join(t, s, "zhang", []string{"employee"})
	if s.ResolveSession(a.ID, a.Epoch) == nil {
		t.Fatal("missing session")
	}
	_, e := s.CreateInvitation(a.ID, InvitationInput{Username: "victim", Name: "王莉", Roles: []string{"admin"}})
	status(t, e, 403)
	_, e = s.ListEmployees(a.ID)
	status(t, e, 403)
	_, e = s.UpdateEmployee(a.ID, a.ID, map[string]any{"roles": []string{"admin"}})
	status(t, e, 403)
	_, e = s.UpdateEmployee("bootstrap", a.ID, map[string]any{"roles": []any{"warehouse", "employee"}})
	if e != nil {
		t.Fatal(e)
	}
	if s.ResolveSession(a.ID, a.Epoch) != nil {
		t.Fatal("old privilege session remains")
	}
	current, _ := s.Authenticate("ZHANG", testPassword)
	if current == nil || current.Epoch != a.Epoch+1 {
		t.Fatal("new login lacks new roles")
	}
	_, _ = s.UpdateEmployee("bootstrap", a.ID, map[string]any{"active": false})
	if s.ResolveSession(current.ID, current.Epoch) != nil {
		t.Fatal("disabled session remains")
	}
	login, _ := s.Authenticate("zhang", testPassword)
	if login != nil {
		t.Fatal("disabled login")
	}
	_, _ = s.UpdateEmployee("bootstrap", a.ID, map[string]any{"active": true})
	if s.ResolveSession(current.ID, current.Epoch) != nil {
		t.Fatal("reenabled stale cookie")
	}
	pending, _ := s.CreateInvitation("bootstrap", InvitationInput{Username: "waiting", Name: "等待"})
	dir, e := s.ListDirectory(a.ID)
	if e != nil || len(dir) != 2 {
		t.Fatalf("directory=%v error=%v", dir, e)
	}
	b, _ := json.Marshal(dir)
	for _, secret := range []string{"epoch", "passwordHash", "source", "createdAt", "updatedAt", pending.Employee.ID} {
		if strings.Contains(string(b), secret) {
			t.Fatal("directory leaks " + secret)
		}
	}
	dir[0].Roles[0] = "finance"
	if s.ResolveLegacy("").Roles[0] != "admin" {
		t.Fatal("directory alias")
	}
}
func TestApprovalAndAdministratorProtection(t *testing.T) {
	s, _ := fixture(t)
	_, e := s.UpdateEmployee("bootstrap", "bootstrap", map[string]any{"active": false})
	status(t, e, 409)
	_, e = s.UpdateEmployee("bootstrap", "bootstrap", map[string]any{"roles": []string{"employee"}})
	status(t, e, 409)
	a := join(t, s, "manager", []string{"manager"})
	_, e = s.AssertCanApprove(a.ID, a.ID, []string{"manager"})
	status(t, e, 403)
	_, e = s.AssertCanApprove("bootstrap", "bootstrap", []string{"admin"})
	status(t, e, 403)
	_, e = s.AssertCanApprove(a.ID, "other", []string{"finance"})
	status(t, e, 403)
	_, e = s.AssertCanApprove(a.ID, "other", nil)
	status(t, e, 403)
	_, e = s.AssertCanApprove(a.ID, "", []string{"manager"})
	status(t, e, 400)
	if _, e = s.AssertCanApprove(a.ID, "bootstrap", []string{"manager"}); e != nil {
		t.Fatal(e)
	}
	admin := join(t, s, "admin2", []string{"admin"})
	_, e = s.UpdateEmployee(admin.ID, "bootstrap", map[string]any{"active": false})
	if e != nil {
		t.Fatal(e)
	}
	if s.ResolveLegacy("") != nil {
		t.Fatal("disabled bootstrap valid")
	}
	_, e = s.UpdateEmployee(admin.ID, admin.ID, map[string]any{"roles": []string{"employee"}})
	status(t, e, 409)
}
func TestPasswordResetAndChange(t *testing.T) {
	s, path := fixture(t)
	a := join(t, s, "zhang", []string{"finance", "employee"})
	_, e := s.ChangePassword(a.ID, "wrong", testPassword+"-new")
	status(t, e, 401)
	v, e := s.CreatePasswordReset("bootstrap", a.ID, 24)
	if e != nil {
		t.Fatal(e)
	}
	other, e := s.CreatePasswordReset("bootstrap", a.ID, 24)
	if e != nil {
		t.Fatal(e)
	}
	_, e = s.AcceptInvitation(v.Token, testPassword)
	status(t, e, 410)
	changed, e := s.AcceptInvitation(other.Token, testPassword+"-reset")
	if e != nil {
		t.Fatal(e)
	}
	if s.ResolveSession(a.ID, a.Epoch) != nil {
		t.Fatal("reset retained session")
	}
	login, _ := s.Authenticate("zhang", testPassword)
	if login != nil {
		t.Fatal("old password")
	}
	login, _ = s.Authenticate("zhang", testPassword+"-reset")
	if login == nil {
		t.Fatal("new password")
	}
	newer, e := s.ChangePassword(changed.ID, testPassword+"-reset", testPassword+"-changed")
	if e != nil {
		t.Fatal(e)
	}
	if s.ResolveSession(changed.ID, changed.Epoch) != nil || s.ResolveSession(newer.ID, newer.Epoch) == nil {
		t.Fatal("change revocation")
	}
	_, e = s.CreatePasswordReset("bootstrap", "bootstrap", 24)
	status(t, e, 409)
	raw, _ := os.ReadFile(path)
	if strings.Contains(string(raw), testPassword) || strings.Contains(string(raw), other.Token) {
		t.Fatal("secret persistence")
	}
	audit, _ := s.ListAudit("bootstrap")
	if len(audit) < 5 {
		t.Fatal("missing audit")
	}
}
func TestRevokeUnjoinedInvitationAndStrictInputs(t *testing.T) {
	s, _ := fixture(t)
	for _, input := range []InvitationInput{{Username: "../admin", Name: "张"}, {Username: "zhang", Name: " "}, {Username: "zhang", Name: "张", Department: "a\nsecret"}, {Username: "zhang", Name: "张", Roles: []string{"root"}}, {Username: "zhang", Name: "张", Roles: []string{}}, {Username: "zhang", Name: "张", ExpiresInHours: 169}} {
		if _, e := s.CreateInvitation("bootstrap", input); e == nil {
			t.Fatalf("invalid invite accepted: %+v", input)
		}
	}
	v, _ := s.CreateInvitation("bootstrap", InvitationInput{Username: "zhang", Name: "张明"})
	_, _ = s.UpdateEmployee("bootstrap", v.Employee.ID, map[string]any{"active": false})
	_, e := s.UpdateEmployee("bootstrap", v.Employee.ID, map[string]any{"active": true})
	status(t, e, 409)
	_, e = s.AcceptInvitation(v.Token, testPassword)
	status(t, e, 410)
	reissued, e := s.ReissueInvitation("bootstrap", v.Employee.ID, 72)
	if e != nil {
		t.Fatal(e)
	}
	if _, e = s.AcceptInvitation(reissued.Token, testPassword); e != nil {
		t.Fatal(e)
	}
	_, e = s.UpdateEmployee("bootstrap", v.Employee.ID, map[string]any{"epoch": 100})
	status(t, e, 400)
}
func TestDamagedFileSymlinkAndSizeRejected(t *testing.T) {
	s, path := fixture(t)
	_ = s
	link := filepath.Join(t.TempDir(), "symlink.json")
	if e := os.Symlink(path, link); e != nil {
		t.Fatal(e)
	}
	if _, e := Open(link, "office"); e == nil {
		t.Fatal("symlink accepted")
	}
	if e := os.WriteFile(path, []byte(`{"version":1,"employees":[]}`), 0600); e != nil {
		t.Fatal(e)
	}
	if _, e := Open(path, "office"); e == nil {
		t.Fatal("damaged store rebuilt")
	}
	f, e := os.Create(filepath.Join(t.TempDir(), "huge"))
	if e != nil {
		t.Fatal(e)
	}
	_ = f.Truncate(16*1024*1024 + 1)
	_ = f.Close()
	if _, e = Open(f.Name(), "office"); e == nil {
		t.Fatal("huge accepted")
	}
}

func TestExistingNodeIdentityFile(t *testing.T) {
	date := "2026-10-20T00:00:00.000Z"
	e := employee{ID: "22222222-2222-4222-8222-222222222222", Username: "old-employee", Name: "旧员工", Department: "研发部", Title: "工程师", Roles: []string{"employee"}, Status: "active", Source: "employee", PasswordHash: func() *string { v := nodeHash; return &v }(), Epoch: 7, CreatedAt: date, UpdatedAt: date}
	bootstrap := employee{ID: "bootstrap", Username: "office", Name: "系统管理员", Department: "总经办", Title: "管理员", Roles: []string{"admin"}, Status: "active", Source: "legacy", Epoch: 1, CreatedAt: date, UpdatedAt: date}
	d := state{Version: 1, Employees: []employee{bootstrap, e}, Invitations: []invitation{}, Audit: []Audit{}}
	path := filepath.Join(t.TempDir(), "identity.json")
	b, _ := json.Marshal(d)
	_ = os.WriteFile(path, b, 0600)
	s, err := Open(path, "office")
	if err != nil {
		t.Fatal(err)
	}
	a, err := s.Authenticate("old-employee", testPassword)
	if err != nil || a == nil || a.Epoch != 7 {
		t.Fatalf("existing Node data: %v", err)
	}
}

func TestInvitationJSONExpiryAndInvalidTypes(t *testing.T) {
	s, _ := fixture(t)
	for _, raw := range []string{`{"username":"zero","name":"员工","expiresInHours":0}`, `{"username":"negative","name":"员工","expiresInHours":-1}`, `{"username":"float","name":"员工","expiresInHours":1.5}`, `{"username":"wrong","name":"员工","expiresInHours":"72"}`} {
		var input InvitationInput
		if err := json.Unmarshal([]byte(raw), &input); err == nil {
			_, err = s.CreateInvitation("bootstrap", input)
			status(t, err, 400)
		}
	}
	var input InvitationInput
	if err := json.Unmarshal([]byte(`{"username":"default-hours","name":"员工"}`), &input); err != nil {
		t.Fatal(err)
	}
	if _, err := s.CreateInvitation("bootstrap", input); err != nil {
		t.Fatal(err)
	}
	people, _ := s.ListEmployees("bootstrap")
	if len(people) != 2 {
		t.Fatal("invalid invitation left a dirty employee")
	}
}

func TestConcurrentDisableCannotLeaveUsableLogin(t *testing.T) {
	s, _ := fixture(t)
	a := join(t, s, "zhang", []string{"employee"})
	started := make(chan struct{})
	result := make(chan *Actor, 1)
	go func() { close(started); actor, _ := s.Authenticate("zhang", testPassword); result <- actor }()
	<-started
	if _, err := s.UpdateEmployee("bootstrap", a.ID, map[string]any{"active": false}); err != nil {
		t.Fatal(err)
	}
	actor := <-result
	if actor != nil && s.ResolveSession(actor.ID, actor.Epoch) != nil {
		t.Fatal("in-flight login created usable disabled session")
	}
	if actor, _ := s.Authenticate("zhang", testPassword); actor != nil {
		t.Fatal("disabled login accepted")
	}
}
