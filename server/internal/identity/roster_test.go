package identity

import (
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func syntheticRoster() Roster {
	return Roster{Version: 1, Revision: "isolated-roster-v1", Employees: []RosterEmployee{
		{PersonID: "employee:test-one", Username: "test-one@laisengou.com", Name: "测试甲", PrimaryDepartmentID: "research", DepartmentIDs: []string{"research", "maintenance"}, Departments: []string{"研发部", "运维部"}, SeatIDs: []string{"research_staff_001", "maintenance_manager_001"}, Roles: []string{"employee"}},
		{PersonID: "employee:test-two", Username: "test-two@laisengou.com", Name: "测试乙", PrimaryDepartmentID: "finance", DepartmentIDs: []string{"finance"}, Departments: []string{"财务部"}, SeatIDs: []string{"finance_manager_001"}, Roles: []string{"employee", "manager", "finance"}, Title: "经理"},
		{PersonID: "employee:aidata01", Username: "aidata01@laisengou.com", Name: "aidata01", PrimaryDepartmentID: "ai_data", DepartmentIDs: []string{"ai_data"}, Departments: []string{"AI数据算法部"}, SeatIDs: []string{"ai_data_staff_001"}, Roles: []string{"employee"}, Placeholder: true},
	}}
}
func TestRosterDryRunImportLoginsIdempotencyAndDirectory(t *testing.T) {
	s, path := fixture(t)
	roster := syntheticRoster()
	before, _ := os.ReadFile(path)
	plan, err := s.ImportRoster(roster, ImportOptions{DryRun: true})
	if err != nil || plan.Created != 3 || plan.Updated != 0 || plan.DepartmentCounts["maintenance"] != 1 {
		t.Fatalf("plan=%#v err=%v", plan, err)
	}
	after, _ := os.ReadFile(path)
	if !bytes.Equal(before, after) {
		t.Fatal("dry run wrote identity or audit")
	}
	_, err = s.ImportRoster(roster, ImportOptions{InitialPassword: "short"})
	status(t, err, 400)
	if _, err = HashPassword("admin123"); err == nil {
		t.Fatal("normal credential policy was lowered")
	}
	applied, err := s.ImportRoster(roster, ImportOptions{InitialPassword: "admin123"})
	if err != nil || applied.Created != 3 {
		t.Fatalf("import=%#v %v", applied, err)
	}
	salts := map[string]bool{}
	for _, e := range s.data.Employees {
		if e.PasswordHash != nil {
			if salts[*e.PasswordHash] {
				t.Fatal("accounts share password salt")
			}
			salts[*e.PasswordHash] = true
		}
	}
	var reader *Actor
	for _, p := range roster.Employees {
		a, err := s.Authenticate(p.Username, "admin123")
		if err != nil || a == nil || a.Name != p.Name || a.OrganizationPersonID != p.PersonID || strings.Join(a.Departments, "|") != strings.Join(p.Departments, "|") {
			t.Fatalf("login or membership mismatch: %#v %v", a, err)
		}
		reader = a
		wrong, err := s.Authenticate(p.Username, "wrong-password")
		if err != nil || wrong != nil {
			t.Fatal("wrong password accepted")
		}
	}
	list, err := s.ListOrganization(reader.ID)
	if err != nil || len(list) != 3 {
		t.Fatalf("directory=%#v %v", list, err)
	}
	list[0].SeatIDs[0] = "forged"
	list[0].Departments[0] = "forged"
	again, _ := s.ListOrganization(reader.ID)
	if again[0].SeatIDs[0] == "forged" || again[0].Departments[0] == "forged" {
		t.Fatal("directory result aliases identity store")
	}
	before, _ = os.ReadFile(path)
	repeat, err := s.ImportRoster(roster, ImportOptions{InitialPassword: "replacement-password"})
	if err != nil || repeat.Created != 0 || repeat.Updated != 0 || repeat.Unchanged != 3 {
		t.Fatalf("not idempotent: %#v %v", repeat, err)
	}
	after, _ = os.ReadFile(path)
	if !bytes.Equal(before, after) {
		t.Fatal("repeat import changed timestamps, credentials or audit")
	}
	if strings.Contains(string(after), "admin123") || strings.Contains(string(after), "replacement-password") {
		t.Fatal("plaintext credential persisted")
	}
	audit, err := s.ListAudit("bootstrap")
	if err != nil || len(audit) != 3 || audit[0].ImportID != roster.Revision || len(audit[0].Departments) != 2 {
		t.Fatal("missing auditable import and memberships")
	}
	reopen, err := Open(path, "office")
	if err != nil {
		t.Fatal(err)
	}
	if got, _ := reopen.Authenticate(roster.Employees[0].Username, "admin123"); got == nil {
		t.Fatal("reopened credential did not authenticate")
	}
	status(t, func() error {
		_, err := s.ImportRoster(roster, ImportOptions{ActorID: reader.ID, DryRun: true})
		return err
	}(), 403)
}
func TestRosterPreservesExistingCredentialRolesStatusAndInvitations(t *testing.T) {
	s, path := fixture(t)
	invited, err := s.CreateInvitation("bootstrap", InvitationInput{Username: "test-one@laisengou.com", Name: "测试甲", Department: "旧部门", Roles: []string{"employee", "finance"}})
	if err != nil {
		t.Fatal(err)
	}
	actor, err := s.AcceptInvitation(invited.Token, testPassword)
	if err != nil {
		t.Fatal(err)
	}
	_, err = s.UpdateEmployee("bootstrap", actor.ID, map[string]any{"active": false})
	if err != nil {
		t.Fatal(err)
	}
	old := *find(&s.data, actor.ID)
	oldInvitations := len(s.data.Invitations)
	roster := syntheticRoster()
	roster.Employees = roster.Employees[:1]
	result, err := s.ImportRoster(roster, ImportOptions{InitialPassword: "admin123"})
	if err != nil || result.Updated != 1 || result.Created != 0 {
		t.Fatalf("update=%#v %v", result, err)
	}
	current := find(&s.data, actor.ID)
	if current.Epoch != old.Epoch || current.Status != old.Status || *current.PasswordHash != *old.PasswordHash || strings.Join(current.Roles, "|") != strings.Join(old.Roles, "|") || current.CreatedAt != old.CreatedAt || len(s.data.Invitations) != oldInvitations {
		t.Fatal("import altered existing credential, access, invitation or identity")
	}
	if current.Department != "研发部" || len(current.Departments) != 2 {
		t.Fatal("requested memberships were not updated")
	}
	raw, _ := os.ReadFile(path)
	if strings.Contains(string(raw), "admin123") {
		t.Fatal("initial password leaked")
	}
}
func TestRosterRejectsConflictDuplicatesPrivilegeEscalationAndStaleFiles(t *testing.T) {
	s, path := fixture(t)
	r := syntheticRoster()
	r.Employees = r.Employees[:1]
	if _, err := s.ImportRoster(r, ImportOptions{InitialPassword: "admin123"}); err != nil {
		t.Fatal(err)
	}
	before, _ := os.ReadFile(path)
	changed := syntheticRoster()
	changed.Employees = changed.Employees[:1]
	changed.Employees[0].Name = "同邮箱另一人"
	_, err := s.ImportRoster(changed, ImportOptions{InitialPassword: "admin123"})
	status(t, err, 409)
	duplicate := syntheticRoster()
	duplicate.Employees = append(duplicate.Employees, duplicate.Employees[0])
	_, err = s.ImportRoster(duplicate, ImportOptions{DryRun: true})
	status(t, err, 400)
	admin := syntheticRoster()
	admin.Employees[0].Roles = []string{"admin"}
	_, err = s.ImportRoster(admin, ImportOptions{DryRun: true})
	status(t, err, 400)
	finance := syntheticRoster()
	finance.Employees[0].Roles = []string{"finance"}
	_, err = s.ImportRoster(finance, ImportOptions{DryRun: true})
	status(t, err, 400)
	after, _ := os.ReadFile(path)
	if !bytes.Equal(before, after) {
		t.Fatal("rejected import partially wrote employees")
	}
	stale, err := Open(path, "office")
	if err != nil {
		t.Fatal(err)
	}
	p := s.GetEmployee(s.data.Employees[1].ID)
	if _, err = s.UpdateEmployee("bootstrap", p.ID, map[string]any{"title": "外部修改"}); err != nil {
		t.Fatal(err)
	}
	_, err = stale.ImportRoster(syntheticRoster(), ImportOptions{InitialPassword: "admin123"})
	status(t, err, 409)
	latest, err := Open(path, "office")
	if err != nil {
		t.Fatal(err)
	}
	people, _ := latest.ListEmployees("bootstrap")
	if len(people) != 2 || people[1].Title != "外部修改" {
		t.Fatal("stale import overwrote the live state")
	}
}
func TestReadRosterRequiresSingleKnownSchema(t *testing.T) {
	r := syntheticRoster()
	data, _ := json.Marshal(r)
	if _, err := ReadRoster(bytes.NewReader(data)); err != nil {
		t.Fatal(err)
	}
	for _, raw := range []string{string(data) + string(data), `{"version":1,"revision":"x","employees":[],"unknown":true}`, strings.Replace(string(data), "test-one@laisengou.com", "a@b@laisengou.com", 1)} {
		if _, err := ReadRoster(strings.NewReader(raw)); err == nil {
			t.Fatal("malformed roster accepted")
		}
	}
}
func TestPrivateReviewedRosterShape(t *testing.T) {
	path := os.Getenv("OFFICE_ROSTER_TEST_FILE")
	if path == "" {
		path = filepath.Join("..", "..", ".office-data", "provisioning", "v43", "employee-roster.json")
	}
	file, err := os.Open(path)
	if os.IsNotExist(err) {
		t.Skip("private company roster is intentionally excluded from source control")
	}
	if err != nil {
		t.Fatal(err)
	}
	defer file.Close()
	roster, err := ReadRoster(file)
	if err != nil {
		t.Fatal(err)
	}
	if len(roster.Employees) != 249 {
		t.Fatalf("company account total=%d", len(roster.Employees))
	}
	placeholders, seats, counts := 0, map[string]bool{}, map[string]int{}
	for _, p := range roster.Employees {
		if p.Placeholder {
			placeholders++
		}
		for _, seat := range p.SeatIDs {
			if seats[seat] {
				t.Fatal("two people assigned same post")
			}
			seats[seat] = true
		}
		for _, dept := range p.DepartmentIDs {
			counts[dept]++
		}
	}
	if placeholders != 191 || len(seats) != 251 || counts["ai_data"] != 206 || counts["general_office"] != 2 || counts["maintenance"] != 1 {
		t.Fatalf("roster counts placeholders=%d seats=%d departments=%v", placeholders, len(seats), counts)
	}
}

// Run explicitly against the private reviewed input before deploying. The
// repository contains no company PII and CI uses the synthetic fixtures above.
func TestPrivateReviewedRosterAllLogins(t *testing.T) {
	if os.Getenv("OFFICE_ROSTER_VERIFY_ALL") != "1" {
		t.Skip("set OFFICE_ROSTER_VERIFY_ALL=1 for private account acceptance")
	}
	path := os.Getenv("OFFICE_ROSTER_TEST_FILE")
	if path == "" {
		path = filepath.Join("..", "..", ".office-data", "provisioning", "v43", "employee-roster.json")
	}
	file, err := os.Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer file.Close()
	roster, err := ReadRoster(file)
	if err != nil {
		t.Fatal(err)
	}
	store, identityPath := fixture(t)
	applied, err := store.ImportRoster(roster, ImportOptions{InitialPassword: "admin123"})
	if err != nil || applied.Created != 249 {
		t.Fatalf("acceptance import count=%#v error=%v", applied, err)
	}
	for _, p := range roster.Employees {
		a, err := store.Authenticate(p.Username, "admin123")
		if err != nil || a == nil || a.Name != p.Name || a.OrganizationPersonID != p.PersonID || strings.Join(a.Departments, "|") != strings.Join(p.Departments, "|") || strings.Join(a.DepartmentIDs, "|") != strings.Join(p.DepartmentIDs, "|") || strings.Join(a.OrganizationSeatIDs, "|") != strings.Join(p.SeatIDs, "|") {
			t.Fatalf("account or membership acceptance failed for %s: %v", p.Username, err)
		}
		if contains(a.Roles, "admin") {
			t.Fatal("company roster created an administrator")
		}
	}
	before, _ := os.ReadFile(identityPath)
	again, err := store.ImportRoster(roster, ImportOptions{InitialPassword: "unused-second-password"})
	if err != nil || again.Unchanged != 249 || again.Created != 0 || again.Updated != 0 {
		t.Fatalf("company import not idempotent: %#v %v", again, err)
	}
	after, _ := os.ReadFile(identityPath)
	if !bytes.Equal(before, after) {
		t.Fatal("company replay changed account data")
	}
	directory, err := store.ListOrganization("bootstrap")
	if err != nil || len(directory) != 249 {
		t.Fatal("authenticated directory count mismatch")
	}
	if strings.Contains(string(after), "admin123") {
		t.Fatal("plaintext password found")
	}
	t.Logf("verified %d account logins, %d organization members, %d department relations; replay unchanged", 249, len(directory), 251)
}
