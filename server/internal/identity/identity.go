// Package identity owns the persisted employee directory and credential lifecycle.
// Its JSON format is compatible with the original office identity store.
package identity

import (
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"sync"
	"time"
	"unicode/utf16"

	"golang.org/x/crypto/scrypt"
)

var Roles = []string{"admin", "manager", "procurement", "warehouse", "project_manager", "employee", "finance", "hr"}

type Error struct {
	Status     int
	Message    string
	RetryAfter int
}

func (e *Error) Error() string              { return e.Message }
func Fail(status int, message string) error { return &Error{Status: status, Message: message} }

type PublicEmployee struct {
	ID         string   `json:"id"`
	Username   string   `json:"username"`
	Name       string   `json:"name"`
	Department string   `json:"department"`
	Title      string   `json:"title"`
	Roles      []string `json:"roles"`
	Active     bool     `json:"active"`
	Status     string   `json:"status"`
	Source     string   `json:"source,omitempty"`
	CreatedAt  string   `json:"createdAt,omitempty"`
	UpdatedAt  string   `json:"updatedAt,omitempty"`
}
type Actor struct {
	PublicEmployee
	Epoch int64 `json:"epoch"`
}
type employee struct {
	ID           string   `json:"id"`
	Username     string   `json:"username"`
	Name         string   `json:"name"`
	Department   string   `json:"department"`
	Title        string   `json:"title"`
	Roles        []string `json:"roles"`
	Status       string   `json:"status"`
	Source       string   `json:"source"`
	PasswordHash *string  `json:"passwordHash"`
	Epoch        int64    `json:"epoch"`
	CreatedAt    string   `json:"createdAt"`
	UpdatedAt    string   `json:"updatedAt"`
}
type invitation struct {
	ID         string  `json:"id"`
	Kind       string  `json:"kind,omitempty"`
	EmployeeID string  `json:"employeeId"`
	CreatedBy  string  `json:"createdBy"`
	CreatedAt  string  `json:"createdAt"`
	ExpiresAt  string  `json:"expiresAt"`
	UsedAt     *string `json:"usedAt"`
	TokenHash  *string `json:"tokenHash"`
}
type Audit struct {
	ID         string   `json:"id"`
	Action     string   `json:"action"`
	ActorID    string   `json:"actorId"`
	EmployeeID string   `json:"employeeId"`
	At         string   `json:"at"`
	Roles      []string `json:"roles,omitempty"`
	Status     string   `json:"status,omitempty"`
}
type state struct {
	Version     int          `json:"version"`
	Employees   []employee   `json:"employees"`
	Invitations []invitation `json:"invitations"`
	Audit       []Audit      `json:"audit"`
}
type InvitationInput struct {
	Username              string   `json:"username"`
	Name                  string   `json:"name"`
	Department            string   `json:"department"`
	Title                 string   `json:"title"`
	Roles                 []string `json:"roles"`
	ExpiresInHours        int      `json:"expiresInHours"`
	expiresInHoursPresent bool
}

func (input *InvitationInput) UnmarshalJSON(data []byte) error {
	type plain InvitationInput
	var next plain
	if err := json.Unmarshal(data, &next); err != nil {
		return err
	}
	var fields map[string]json.RawMessage
	if err := json.Unmarshal(data, &fields); err != nil {
		return err
	}
	if raw, exists := fields["expiresInHours"]; exists && string(raw) != "null" {
		next.expiresInHoursPresent = true
	}
	*input = InvitationInput(next)
	return nil
}

type InvitationResult struct {
	ID        string         `json:"id"`
	Kind      string         `json:"kind"`
	Token     string         `json:"token"`
	ExpiresAt string         `json:"expiresAt"`
	Employee  PublicEmployee `json:"employee"`
}
type Store struct {
	mu                                  sync.RWMutex
	filePath, legacyUsername, dummyHash string
	data                                state
	now                                 func() time.Time
}

var usernamePattern = regexp.MustCompile(`^[A-Za-z0-9_.@-]{1,80}$`)
var idPattern = regexp.MustCompile(`^(bootstrap|[0-9a-f-]{36})$`)
var b64Pattern = regexp.MustCompile(`^[-_A-Za-z0-9]+$`)
var tokenPattern = regexp.MustCompile(`^[-_A-Za-z0-9]{43}$`)
var digestPattern = regexp.MustCompile(`^[a-f0-9]{64}$`)

func usernameOf(v string) (string, error) {
	if !usernamePattern.MatchString(v) {
		return "", Fail(400, "账号需为1至80位字母、数字或 . _ @ -。")
	}
	return strings.ToLower(v), nil
}
func textOf(v, label string, required bool) (string, error) {
	if len(utf16.Encode([]rune(v))) > 80 {
		return "", Fail(400, label+"填写不正确。")
	}
	for _, r := range v {
		if r < 32 || r == 127 {
			return "", Fail(400, label+"填写不正确。")
		}
	}
	v = strings.TrimSpace(v)
	if required && v == "" {
		return "", Fail(400, label+"填写不正确。")
	}
	return v, nil
}
func rolesOf(v []string) ([]string, error) {
	if len(v) == 0 || len(v) > len(Roles) {
		return nil, Fail(400, "请选择有效岗位角色。")
	}
	out := []string{}
	for _, r := range v {
		if !contains(Roles, r) {
			return nil, Fail(400, "请选择有效岗位角色。")
		}
		if !contains(out, r) {
			out = append(out, r)
		}
	}
	sort.Strings(out)
	return out, nil
}
func contains(v []string, x string) bool {
	for _, y := range v {
		if x == y {
			return true
		}
	}
	return false
}
func randomString(n int) string {
	b := make([]byte, n)
	if _, err := rand.Read(b); err != nil {
		panic(err)
	}
	return base64.RawURLEncoding.EncodeToString(b)
}
func uuid() string {
	b := make([]byte, 16)
	if _, err := rand.Read(b); err != nil {
		panic(err)
	}
	b[6] = (b[6] & 15) | 64
	b[8] = (b[8] & 63) | 128
	return fmt.Sprintf("%x-%x-%x-%x-%x", b[:4], b[4:6], b[6:8], b[8:10], b[10:])
}
func timestamp(t time.Time) string { return t.UTC().Format("2006-01-02T15:04:05.000Z") }
func parseTime(v string) bool      { _, err := time.Parse(time.RFC3339Nano, v); return err == nil }
func tokenDigest(v string) string  { h := sha256.Sum256([]byte(v)); return hex.EncodeToString(h[:]) }
func decode(v string, n int) []byte {
	if !b64Pattern.MatchString(v) {
		return nil
	}
	b, e := base64.RawURLEncoding.DecodeString(v)
	if e != nil || len(b) != n || base64.RawURLEncoding.EncodeToString(b) != v {
		return nil
	}
	return b
}
func ParsePasswordHash(value string) (salt, key []byte, ok bool) {
	p := strings.Split(value, "$")
	if len(p) != 6 || p[0] != "scrypt" || p[1] != "16384" || p[2] != "8" || p[3] != "1" {
		return nil, nil, false
	}
	salt = decode(p[4], 16)
	key = decode(p[5], 64)
	return salt, key, salt != nil && key != nil
}
func HashPassword(password string) (string, error) {
	if len(utf16.Encode([]rune(password))) < 12 || len([]byte(password)) > 1024 {
		return "", Fail(400, "密码需至少12个字符，且不超过1024字节。")
	}
	salt := make([]byte, 16)
	if _, e := rand.Read(salt); e != nil {
		return "", e
	}
	key, e := scrypt.Key([]byte(password), salt, 16384, 8, 1, 64)
	if e != nil {
		return "", e
	}
	return "scrypt$16384$8$1$" + base64.RawURLEncoding.EncodeToString(salt) + "$" + base64.RawURLEncoding.EncodeToString(key), nil
}
func PasswordMatches(password, passwordHash string) (bool, error) {
	salt, key, ok := ParsePasswordHash(passwordHash)
	if !ok {
		return false, fmt.Errorf("员工口令记录损坏。")
	}
	shape := len([]byte(password)) <= 1024
	if !shape {
		password = "invalid-credential-placeholder"
	}
	candidate, e := scrypt.Key([]byte(password), salt, 16384, 8, 1, 64)
	return e == nil && shape && subtle.ConstantTimeCompare(candidate, key) == 1, e
}
func public(e employee) PublicEmployee {
	return PublicEmployee{e.ID, e.Username, e.Name, e.Department, e.Title, append([]string{}, e.Roles...), e.Status == "active", e.Status, e.Source, e.CreatedAt, e.UpdatedAt}
}
func trusted(e employee) *Actor { return &Actor{public(e), e.Epoch} }
func clone(d state) state       { b, _ := json.Marshal(d); var v state; _ = json.Unmarshal(b, &v); return v }

func Open(filePath, legacyUsername string) (*Store, error) {
	return OpenWithClock(filePath, legacyUsername, time.Now)
}
func OpenWithClock(filePath, legacyUsername string, now func() time.Time) (*Store, error) {
	if filePath == "" {
		return nil, fmt.Errorf("需要员工账号文件路径。")
	}
	path, e := filepath.Abs(filePath)
	if e != nil {
		return nil, e
	}
	if legacyUsername == "" {
		legacyUsername = "office"
	}
	legacyUsername, e = usernameOf(legacyUsername)
	if e != nil {
		return nil, e
	}
	if now == nil {
		now = time.Now
	}
	s := &Store{filePath: path, legacyUsername: legacyUsername, now: now}
	stat, e := os.Lstat(path)
	if os.IsNotExist(e) {
		date := timestamp(now())
		s.data = state{Version: 1, Employees: []employee{{ID: "bootstrap", Username: legacyUsername, Name: "系统管理员", Department: "总经办", Title: "管理员", Roles: []string{"admin"}, Status: "active", Source: "legacy", Epoch: 1, CreatedAt: date, UpdatedAt: date}}, Invitations: []invitation{}, Audit: []Audit{}}
		if e = atomicSave(path, s.data); e != nil {
			return nil, e
		}
	} else if e != nil {
		return nil, e
	} else {
		if !stat.Mode().IsRegular() || stat.Size() > 16*1024*1024 {
			return nil, fmt.Errorf("员工账号文件不可读取。")
		}
		f, e := os.Open(path)
		if e != nil {
			return nil, e
		}
		defer f.Close()
		opened, e := f.Stat()
		if e != nil || !os.SameFile(stat, opened) {
			return nil, fmt.Errorf("员工账号文件不可读取。")
		}
		b, e := io.ReadAll(io.LimitReader(f, 16*1024*1024+1))
		if e != nil || len(b) > 16*1024*1024 {
			return nil, fmt.Errorf("员工账号文件不可读取。")
		}
		if e = json.Unmarshal(b, &s.data); e != nil {
			return nil, fmt.Errorf("员工账号文件格式不正确: %w", e)
		}
		if e = validateState(s.data); e != nil {
			return nil, e
		}
	}
	s.dummyHash, e = HashPassword(randomString(32))
	return s, e
}
func atomicSave(filePath string, d state) error {
	dir := filepath.Dir(filePath)
	if e := os.MkdirAll(dir, 0700); e != nil {
		return e
	}
	f, e := os.OpenFile(filepath.Join(dir, "."+filepath.Base(filePath)+"."+randomString(12)+".tmp"), os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0600)
	if e != nil {
		return e
	}
	tmp := f.Name()
	defer os.Remove(tmp)
	b, e := json.Marshal(d)
	if e == nil {
		_, e = f.Write(append(b, '\n'))
	}
	if e == nil {
		e = f.Sync()
	}
	ce := f.Close()
	if e == nil {
		e = ce
	}
	if e != nil {
		return e
	}
	if e = os.Rename(tmp, filePath); e != nil {
		return e
	}
	if e = os.Chmod(filePath, 0600); e != nil {
		return e
	}
	df, e := os.Open(dir)
	if e != nil {
		return e
	}
	defer df.Close()
	return df.Sync()
}
func validateState(d state) error {
	bad := func() error { return fmt.Errorf("员工账号记录损坏。") }
	if d.Version != 1 || d.Employees == nil || len(d.Employees) > 2000 || d.Invitations == nil || len(d.Invitations) > 10000 || d.Audit == nil || len(d.Audit) > 10000 {
		return fmt.Errorf("员工账号文件格式不正确。")
	}
	ids, names := map[string]bool{}, map[string]bool{}
	admin := false
	for _, e := range d.Employees {
		u, err := usernameOf(e.Username)
		if err != nil || u != e.Username || ids[e.ID] || names[e.Username] || !idPattern.MatchString(e.ID) || e.Epoch < 1 || e.Epoch > 9007199254740991 || !contains([]string{"active", "invited", "disabled"}, e.Status) || !contains([]string{"legacy", "employee"}, e.Source) {
			return bad()
		}
		if _, err := rolesOf(e.Roles); err != nil {
			return bad()
		}
		for _, v := range []struct {
			v, l string
			r    bool
		}{{e.Name, "姓名", true}, {e.Department, "部门", false}, {e.Title, "岗位", false}} {
			if _, err := textOf(v.v, v.l, v.r); err != nil {
				return bad()
			}
		}
		if e.Source == "employee" && e.Status == "active" && e.PasswordHash == nil {
			return bad()
		}
		if e.PasswordHash != nil {
			if _, _, ok := ParsePasswordHash(*e.PasswordHash); !ok {
				return bad()
			}
		}
		if !parseTime(e.CreatedAt) || !parseTime(e.UpdatedAt) {
			return bad()
		}
		ids[e.ID] = true
		names[e.Username] = true
		if e.Status == "active" && contains(e.Roles, "admin") {
			admin = true
		}
	}
	iids, hashes := map[string]bool{}, map[string]bool{}
	for _, i := range d.Invitations {
		if i.ID == "" || iids[i.ID] || !ids[i.EmployeeID] || !ids[i.CreatedBy] || (i.Kind != "" && i.Kind != "join" && i.Kind != "reset") || !parseTime(i.ExpiresAt) || !parseTime(i.CreatedAt) || (i.UsedAt != nil && !parseTime(*i.UsedAt)) {
			return fmt.Errorf("员工邀请记录损坏。")
		}
		if i.TokenHash != nil {
			if !digestPattern.MatchString(*i.TokenHash) || hashes[*i.TokenHash] {
				return fmt.Errorf("员工邀请记录损坏。")
			}
			hashes[*i.TokenHash] = true
		}
		iids[i.ID] = true
	}
	if !admin {
		return fmt.Errorf("员工账号缺少有效管理员。")
	}
	return nil
}
func (s *Store) transact(fn func(*state) (any, error)) (any, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	next := clone(s.data)
	value, e := fn(&next)
	if e != nil {
		return nil, e
	}
	if e = validateState(next); e != nil {
		return nil, e
	}
	if e = atomicSave(s.filePath, next); e != nil {
		return nil, e
	}
	s.data = next
	return value, nil
}
func find(d *state, id string) *employee {
	for i := range d.Employees {
		if d.Employees[i].ID == id {
			return &d.Employees[i]
		}
	}
	return nil
}
func active(d *state, id string) (*employee, error) {
	e := find(d, id)
	if e == nil || e.Status != "active" {
		return nil, Fail(403, "员工账号不可用。")
	}
	return e, nil
}
func administrator(d *state, id string) (*employee, error) {
	e, err := active(d, id)
	if err != nil {
		return nil, err
	}
	if !contains(e.Roles, "admin") {
		return nil, Fail(403, "需要管理员权限。")
	}
	return e, nil
}
func (s *Store) audit(d *state, action, actorID, employeeID string, roles []string, status string) {
	d.Audit = append(d.Audit, Audit{uuid(), action, actorID, employeeID, timestamp(s.now()), append([]string(nil), roles...), status})
	if len(d.Audit) > 10000 {
		d.Audit = d.Audit[len(d.Audit)-10000:]
	}
}
func (s *Store) newInvitation(d *state, actorID string, e *employee, hours int, kind string) (*InvitationResult, error) {
	if hours < 1 || hours > 168 {
		return nil, Fail(400, "邀请有效期需为1至168小时。")
	}
	for n := range d.Invitations {
		if d.Invitations[n].EmployeeID == e.ID && d.Invitations[n].UsedAt == nil {
			d.Invitations[n].TokenHash = nil
		}
	}
	token := randomString(32)
	hash := tokenDigest(token)
	i := invitation{ID: uuid(), Kind: kind, EmployeeID: e.ID, CreatedBy: actorID, CreatedAt: timestamp(s.now()), ExpiresAt: timestamp(s.now().Add(time.Duration(hours) * time.Hour)), TokenHash: &hash}
	kept := []invitation{}
	for _, old := range d.Invitations {
		expiry, _ := time.Parse(time.RFC3339Nano, old.ExpiresAt)
		if old.TokenHash != nil && expiry.After(s.now()) {
			kept = append(kept, old)
		}
	}
	d.Invitations = append(kept, i)
	action := "invitation.created"
	if kind == "reset" {
		action = "password.reset.requested"
	}
	s.audit(d, action, actorID, e.ID, nil, "")
	return &InvitationResult{i.ID, kind, token, i.ExpiresAt, public(*e)}, nil
}
func (s *Store) GetEmployee(id string) *PublicEmployee {
	s.mu.RLock()
	defer s.mu.RUnlock()
	if e := find(&s.data, id); e != nil {
		p := public(*e)
		return &p
	}
	return nil
}
func (s *Store) ResolveLegacy(username string) *Actor {
	s.mu.RLock()
	defer s.mu.RUnlock()
	if username == "" {
		username = s.legacyUsername
	}
	for _, e := range s.data.Employees {
		if e.Source == "legacy" && e.Username == strings.ToLower(username) && e.Status == "active" {
			return trusted(e)
		}
	}
	return nil
}
func (s *Store) ResolveSession(id string, epoch int64) *Actor {
	s.mu.RLock()
	defer s.mu.RUnlock()
	e := find(&s.data, id)
	if e != nil && e.Status == "active" && e.Epoch == epoch {
		return trusted(*e)
	}
	return nil
}
func (s *Store) Authenticate(username, password string) (*Actor, error) {
	u, _ := usernameOf(username)
	s.mu.RLock()
	var before *employee
	for _, e := range s.data.Employees {
		if e.Username == u && e.Source == "employee" {
			c := e
			before = &c
			break
		}
	}
	hash := s.dummyHash
	if before != nil && before.PasswordHash != nil {
		hash = *before.PasswordHash
	}
	s.mu.RUnlock()
	ok, err := PasswordMatches(password, hash)
	if err != nil {
		return nil, err
	}
	s.mu.RLock()
	defer s.mu.RUnlock()
	if !ok || before == nil {
		return nil, nil
	}
	current := find(&s.data, before.ID)
	if current != nil && current.Status == "active" && current.Epoch == before.Epoch && current.PasswordHash != nil && before.PasswordHash != nil && *current.PasswordHash == *before.PasswordHash {
		return trusted(*current), nil
	}
	return nil, nil
}
func (s *Store) ListEmployees(actorID string) ([]PublicEmployee, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	if _, e := administrator(&s.data, actorID); e != nil {
		return nil, e
	}
	out := []PublicEmployee{}
	for _, v := range s.data.Employees {
		out = append(out, public(v))
	}
	return out, nil
}
func (s *Store) ListDirectory(actorID string) ([]PublicEmployee, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	if _, e := active(&s.data, actorID); e != nil {
		return nil, e
	}
	out := []PublicEmployee{}
	for _, v := range s.data.Employees {
		if v.Status == "active" {
			p := public(v)
			p.Source = ""
			p.CreatedAt = ""
			p.UpdatedAt = ""
			out = append(out, p)
		}
	}
	return out, nil
}
func (s *Store) ListAudit(actorID string) ([]Audit, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	if _, e := administrator(&s.data, actorID); e != nil {
		return nil, e
	}
	d := clone(s.data)
	return d.Audit, nil
}
func (s *Store) CreateInvitation(actorID string, input InvitationInput) (*InvitationResult, error) {
	u, e := usernameOf(input.Username)
	if e != nil {
		return nil, e
	}
	name, e := textOf(input.Name, "姓名", true)
	if e != nil {
		return nil, e
	}
	department, e := textOf(input.Department, "部门", false)
	if e != nil {
		return nil, e
	}
	title, e := textOf(input.Title, "岗位", false)
	if e != nil {
		return nil, e
	}
	if input.Roles == nil {
		input.Roles = []string{"employee"}
	}
	roles, e := rolesOf(input.Roles)
	if e != nil {
		return nil, e
	}
	hours := input.ExpiresInHours
	if hours == 0 && !input.expiresInHoursPresent {
		hours = 72
	}
	v, e := s.transact(func(d *state) (any, error) {
		if _, e := administrator(d, actorID); e != nil {
			return nil, e
		}
		if len(d.Employees) >= 2000 {
			return nil, Fail(409, "员工账号数量已达上限。")
		}
		for _, old := range d.Employees {
			if old.Username == u {
				return nil, Fail(409, "账号已存在。")
			}
		}
		date := timestamp(s.now())
		d.Employees = append(d.Employees, employee{ID: uuid(), Username: u, Name: name, Department: department, Title: title, Roles: roles, Status: "invited", Source: "employee", Epoch: 1, CreatedAt: date, UpdatedAt: date})
		return s.newInvitation(d, actorID, &d.Employees[len(d.Employees)-1], hours, "join")
	})
	if e != nil {
		return nil, e
	}
	return v.(*InvitationResult), nil
}
func (s *Store) ReissueInvitation(actorID, id string, hours int) (*InvitationResult, error) {
	if hours == 0 {
		hours = 72
	}
	v, e := s.transact(func(d *state) (any, error) {
		if _, e := administrator(d, actorID); e != nil {
			return nil, e
		}
		person := find(d, id)
		if person == nil || person.Source != "employee" || person.PasswordHash != nil || !contains([]string{"invited", "disabled"}, person.Status) {
			return nil, Fail(409, "仅未完成入驻的账号可以重新邀请。")
		}
		if person.Status == "disabled" {
			person.Status = "invited"
			person.Epoch++
			person.UpdatedAt = timestamp(s.now())
		}
		return s.newInvitation(d, actorID, person, hours, "join")
	})
	if e != nil {
		return nil, e
	}
	return v.(*InvitationResult), nil
}
func (s *Store) CreatePasswordReset(actorID, id string, hours int) (*InvitationResult, error) {
	if hours == 0 {
		hours = 24
	}
	v, e := s.transact(func(d *state) (any, error) {
		if _, e := administrator(d, actorID); e != nil {
			return nil, e
		}
		person, e := active(d, id)
		if e != nil {
			return nil, e
		}
		if person.Source == "legacy" {
			return nil, Fail(409, "管理员原始登录口令由服务器配置维护。")
		}
		return s.newInvitation(d, actorID, person, hours, "reset")
	})
	if e != nil {
		return nil, e
	}
	return v.(*InvitationResult), nil
}
func (s *Store) AcceptInvitation(token, password string) (*Actor, error) {
	hash := tokenDigest(token)
	available := func(d *state) *invitation {
		for i := range d.Invitations {
			v := &d.Invitations[i]
			expiry, _ := time.Parse(time.RFC3339Nano, v.ExpiresAt)
			if v.TokenHash != nil && *v.TokenHash == hash && v.UsedAt == nil && expiry.After(s.now()) {
				return v
			}
		}
		return nil
	}
	s.mu.RLock()
	found := tokenPattern.MatchString(token) && available(&s.data) != nil
	s.mu.RUnlock()
	if !found {
		return nil, Fail(410, "邀请无效或已过期。")
	}
	passwordHash, e := HashPassword(password)
	if e != nil {
		return nil, e
	}
	v, e := s.transact(func(d *state) (any, error) {
		invite := available(d)
		if invite == nil {
			return nil, Fail(410, "邀请无效或已过期。")
		}
		person := find(d, invite.EmployeeID)
		reset := invite.Kind == "reset"
		status := "invited"
		if reset {
			status = "active"
		}
		if person == nil || person.Source != "employee" || person.Status != status {
			return nil, Fail(410, "邀请无效或已过期。")
		}
		person.PasswordHash = &passwordHash
		person.Status = "active"
		person.Epoch++
		date := timestamp(s.now())
		person.UpdatedAt = date
		invite.UsedAt = &date
		invite.TokenHash = nil
		action := "employee.joined"
		if reset {
			action = "password.reset.completed"
		}
		s.audit(d, action, person.ID, person.ID, nil, "")
		return trusted(*person), nil
	})
	if e != nil {
		return nil, e
	}
	return v.(*Actor), nil
}
func (s *Store) UpdateEmployee(actorID, id string, input map[string]any) (*PublicEmployee, error) {
	allowed := map[string]bool{"active": true, "roles": true, "name": true, "department": true, "title": true}
	for k := range input {
		if !allowed[k] {
			return nil, Fail(400, "员工资料字段不正确。")
		}
	}
	v, e := s.transact(func(d *state) (any, error) {
		if _, e := administrator(d, actorID); e != nil {
			return nil, e
		}
		person := find(d, id)
		if person == nil {
			return nil, Fail(404, "员工不存在。")
		}
		nextRoles := append([]string{}, person.Roles...)
		if val, exists := input["roles"]; exists {
			list := []string{}
			switch a := val.(type) {
			case []string:
				list = a
			case []any:
				for _, r := range a {
					x, ok := r.(string)
					if !ok {
						return nil, Fail(400, "请选择有效岗位角色。")
					}
					list = append(list, x)
				}
			default:
				return nil, Fail(400, "请选择有效岗位角色。")
			}
			var e error
			nextRoles, e = rolesOf(list)
			if e != nil {
				return nil, e
			}
		}
		nextStatus := person.Status
		if val, exists := input["active"]; exists {
			b, ok := val.(bool)
			if !ok {
				return nil, Fail(400, "员工状态不正确。")
			}
			if b {
				if person.Status == "invited" {
					return nil, Fail(409, "员工需要先完成邀请入驻。")
				}
				if person.Source == "employee" && person.PasswordHash == nil {
					return nil, Fail(409, "请重新邀请员工完成入驻。")
				}
				nextStatus = "active"
			} else {
				nextStatus = "disabled"
			}
		}
		changed := strings.Join(nextRoles, "\x00") != strings.Join(person.Roles, "\x00")
		if actorID == id && (nextStatus != "active" || changed) {
			return nil, Fail(409, "不能停用自己或修改自己的角色。")
		}
		if person.Status == "active" && contains(person.Roles, "admin") && (nextStatus != "active" || !contains(nextRoles, "admin")) {
			other := false
			for _, x := range d.Employees {
				if x.ID != id && x.Status == "active" && contains(x.Roles, "admin") {
					other = true
				}
			}
			if !other {
				return nil, Fail(409, "至少保留一名有效管理员。")
			}
		}
		for _, item := range []struct{ k, l string }{{"name", "姓名"}, {"department", "部门"}, {"title", "岗位"}} {
			if val, exists := input[item.k]; exists {
				x, ok := val.(string)
				if !ok {
					return nil, Fail(400, item.l+"填写不正确。")
				}
				x, e := textOf(x, item.l, item.k == "name")
				if e != nil {
					return nil, e
				}
				switch item.k {
				case "name":
					person.Name = x
				case "department":
					person.Department = x
				case "title":
					person.Title = x
				}
			}
		}
		oldStatus := person.Status
		person.Roles = nextRoles
		person.Status = nextStatus
		if changed || oldStatus != nextStatus {
			person.Epoch++
		}
		if nextStatus == "disabled" {
			for i := range d.Invitations {
				if d.Invitations[i].EmployeeID == id {
					d.Invitations[i].TokenHash = nil
				}
			}
		}
		person.UpdatedAt = timestamp(s.now())
		s.audit(d, "employee.updated", actorID, id, nextRoles, nextStatus)
		p := public(*person)
		return &p, nil
	})
	if e != nil {
		return nil, e
	}
	return v.(*PublicEmployee), nil
}
func (s *Store) ChangePassword(actorID, currentPassword, newPassword string) (*Actor, error) {
	s.mu.RLock()
	person, e := active(&s.data, actorID)
	if e != nil {
		s.mu.RUnlock()
		return nil, e
	}
	before := *person
	s.mu.RUnlock()
	if before.Source == "legacy" {
		return nil, Fail(409, "管理员原始登录口令由服务器配置维护。")
	}
	ok, e := PasswordMatches(currentPassword, *before.PasswordHash)
	if e != nil {
		return nil, e
	}
	if !ok {
		return nil, Fail(401, "原密码不正确。")
	}
	hash, e := HashPassword(newPassword)
	if e != nil {
		return nil, e
	}
	v, e := s.transact(func(d *state) (any, error) {
		person, e := active(d, actorID)
		if e != nil {
			return nil, e
		}
		if person.Epoch != before.Epoch || person.PasswordHash == nil || *person.PasswordHash != *before.PasswordHash {
			return nil, Fail(409, "账号已变更，请重新登录。")
		}
		person.PasswordHash = &hash
		person.Epoch++
		person.UpdatedAt = timestamp(s.now())
		s.audit(d, "password.changed", actorID, actorID, nil, "")
		return trusted(*person), nil
	})
	if e != nil {
		return nil, e
	}
	return v.(*Actor), nil
}
func (s *Store) AssertCanApprove(actorID, requesterID string, requiredRoles []string) (*PublicEmployee, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	person, e := active(&s.data, actorID)
	if e != nil {
		return nil, e
	}
	if requesterID == "" {
		return nil, Fail(400, "缺少申请人。")
	}
	if actorID == requesterID {
		return nil, Fail(403, "申请人不能审批自己的申请。")
	}
	for _, r := range requiredRoles {
		if !contains(Roles, r) {
			return nil, Fail(400, "审批角色不正确。")
		}
	}
	permitted := contains(person.Roles, "admin")
	for _, r := range requiredRoles {
		if contains(person.Roles, r) {
			permitted = true
		}
	}
	if !permitted {
		return nil, Fail(403, "没有此项审批权限。")
	}
	p := public(*person)
	return &p, nil
}
