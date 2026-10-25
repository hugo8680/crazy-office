package identity

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"regexp"
	"strings"
	"unicode/utf16"
)

// Roster is the reviewed company directory. Placement and membership are separate
// from authorization: positions never imply approval privileges.
type Roster struct {
	Version   int              `json:"version"`
	Revision  string           `json:"revision"`
	Employees []RosterEmployee `json:"employees"`
}
type RosterEmployee struct {
	PersonID            string   `json:"personId"`
	Username            string   `json:"username"`
	Name                string   `json:"name"`
	PrimaryDepartmentID string   `json:"primaryDepartmentId"`
	DepartmentIDs       []string `json:"departmentIds"`
	Departments         []string `json:"departments"`
	SeatIDs             []string `json:"seatIds"`
	Title               string   `json:"title"`
	Roles               []string `json:"roles"`
	Placeholder         bool     `json:"placeholder"`
}
type ImportOptions struct {
	ActorID         string
	InitialPassword string
	DryRun          bool
}
type ImportReport struct {
	Revision         string         `json:"revision"`
	DryRun           bool           `json:"dryRun"`
	Created          int            `json:"created"`
	Updated          int            `json:"updated"`
	Unchanged        int            `json:"unchanged"`
	Total            int            `json:"total"`
	DepartmentCounts map[string]int `json:"departmentCounts"`
}

var rosterIdentifierPattern = regexp.MustCompile(`^[a-z][a-z0-9_]{0,119}$`)

func uniqueText(values []string) []string {
	out := []string{}
	for _, v := range values {
		if !contains(out, v) {
			out = append(out, v)
		}
	}
	return out
}
func ReadRoster(reader io.Reader) (Roster, error) {
	var roster Roster
	decoder := json.NewDecoder(io.LimitReader(reader, 2*1024*1024))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&roster); err != nil {
		return roster, fmt.Errorf("组织名册格式不正确: %w", err)
	}
	var extra any
	if err := decoder.Decode(&extra); err != io.EOF {
		return roster, fmt.Errorf("组织名册含多余内容")
	}
	return normalizeRoster(roster)
}
func normalizeRoster(roster Roster) (Roster, error) {
	if roster.Version != 1 || len(roster.Revision) == 0 || len(roster.Revision) > 120 || len(roster.Employees) == 0 || len(roster.Employees) > 1500 {
		return roster, Fail(400, "组织名册格式不正确。")
	}
	roster.Employees = append([]RosterEmployee(nil), roster.Employees...)
	usernames, personIDs, seatIDs := map[string]bool{}, map[string]bool{}, map[string]bool{}
	for n, p := range roster.Employees {
		u, err := usernameOf(p.Username)
		if err != nil || (strings.Count(u, "@") != 1 || !strings.HasSuffix(u, "@laisengou.com")) || len(strings.TrimSuffix(u, "@laisengou.com")) == 0 || usernames[u] {
			return roster, Fail(400, "组织名册账号重复或邮箱不正确。")
		}
		p.Username = u
		usernames[u] = true
		if p.PersonID == "" || len(p.PersonID) > 160 || personIDs[p.PersonID] {
			return roster, Fail(400, "组织名册人员标识不正确。")
		}
		for _, r := range p.PersonID {
			if r < 33 || r > 126 {
				return roster, Fail(400, "组织名册人员标识不正确。")
			}
		}
		personIDs[p.PersonID] = true
		if len(p.SeatIDs) == 0 || len(p.SeatIDs) > 24 {
			return roster, Fail(400, "组织名册工位关系不正确。")
		}
		for _, seatID := range p.SeatIDs {
			if !rosterIdentifierPattern.MatchString(seatID) || seatIDs[seatID] {
				return roster, Fail(400, "组织名册工位重复或标识不正确。")
			}
			seatIDs[seatID] = true
		}
		p.Name, err = textOf(p.Name, "姓名", true)
		if err != nil {
			return roster, err
		}
		p.Title, err = textOf(p.Title, "岗位", false)
		if err != nil {
			return roster, err
		}
		if len(p.Departments) == 0 || len(p.Departments) > 12 || len(p.DepartmentIDs) != len(p.Departments) || p.PrimaryDepartmentID != p.DepartmentIDs[0] {
			return roster, Fail(400, "组织名册部门关系不正确。")
		}
		seenIDs, seenNames := map[string]bool{}, map[string]bool{}
		for i, dept := range p.Departments {
			normalized, err := textOf(dept, "部门", true)
			if err != nil || normalized != dept || seenNames[dept] || !rosterIdentifierPattern.MatchString(p.DepartmentIDs[i]) || seenIDs[p.DepartmentIDs[i]] {
				return roster, Fail(400, "组织名册部门关系不正确。")
			}
			seenIDs[p.DepartmentIDs[i]] = true
			seenNames[dept] = true
		}
		p.Roles, err = rolesOf(p.Roles)
		if err != nil {
			return roster, err
		}
		// The reviewed roster may grant confirmed business positions, never admin.
		// Finance and HR grants remain restricted to the corresponding department.
		for _, r := range p.Roles {
			if r != "employee" && r != "manager" && r != "hr" && r != "finance" {
				return roster, Fail(400, "名册导入只允许员工及已确认业务岗位角色。")
			}
		}
		if contains(p.Roles, "finance") && p.PrimaryDepartmentID != "finance" {
			return roster, Fail(400, "财务角色需属于财务部。")
		}
		if contains(p.Roles, "hr") && p.PrimaryDepartmentID != "hr_admin" {
			return roster, Fail(400, "人事角色需属于人力资源与行政管理部。")
		}

		p.Departments = append([]string(nil), p.Departments...)
		p.DepartmentIDs = append([]string(nil), p.DepartmentIDs...)
		p.SeatIDs = append([]string(nil), p.SeatIDs...)
		roster.Employees[n] = p
	}
	return roster, nil
}
func rosterMetadataEqual(e employee, p RosterEmployee) bool {
	return e.Name == p.Name && e.Department == p.Departments[0] && e.Title == p.Title && e.OrganizationPersonID == p.PersonID && strings.Join(e.Departments, "\x00") == strings.Join(p.Departments, "\x00") && strings.Join(e.DepartmentIDs, "\x00") == strings.Join(p.DepartmentIDs, "\x00") && strings.Join(e.OrganizationSeatIDs, "\x00") == strings.Join(p.SeatIDs, "\x00") && e.Placeholder == p.Placeholder
}

// ImportRoster updates identity metadata as one atomic file replacement. Existing
// credentials, roles, IDs, epochs, status and invitations are always preserved.
// Run the command with the API service stopped; it refuses if the file changed
// since this Store was opened, protecting against an obsolete import snapshot.
func (s *Store) ImportRoster(input Roster, options ImportOptions) (*ImportReport, error) {
	roster, err := normalizeRoster(input)
	if err != nil {
		return nil, err
	}
	if options.ActorID == "" {
		options.ActorID = "bootstrap"
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if _, err = administrator(&s.data, options.ActorID); err != nil {
		return nil, err
	}
	current := clone(s.data)
	report := &ImportReport{Revision: roster.Revision, DryRun: options.DryRun, Total: len(roster.Employees), DepartmentCounts: map[string]int{}}
	byUsername := map[string]*employee{}
	for n := range current.Employees {
		byUsername[current.Employees[n].Username] = &current.Employees[n]
	}
	// Do not retain pointers into a slice while adding to it.
	for _, p := range roster.Employees {
		for _, d := range p.DepartmentIDs {
			report.DepartmentCounts[d]++
		}
		old := byUsername[p.Username]
		if old != nil && old.Name != p.Name {
			return nil, Fail(409, "同邮箱的现有员工姓名不同，需先核对账号: "+p.Username)
		}
		if old == nil {
			report.Created++
		} else if rosterMetadataEqual(*old, p) {
			report.Unchanged++
		} else {
			report.Updated++
		}
	}
	if len(current.Employees)+report.Created > 2000 {
		return nil, Fail(409, "员工账号数量已达上限。")
	}
	if options.DryRun || report.Created+report.Updated == 0 {
		return report, nil
	}
	// The user explicitly selected an eight-character initial password. This narrow
	// bootstrap path does not lower the normal invitation/change-password policy.
	if report.Created > 0 && (len(utf16.Encode([]rune(options.InitialPassword))) < 8 || len([]byte(options.InitialPassword)) > 1024) {
		return nil, Fail(400, "初始密码需至少8个字符，且不超过1024字节。")
	}
	date := timestamp(s.now())
	for _, p := range roster.Employees {
		var existing *employee
		for n := range current.Employees {
			if current.Employees[n].Username == p.Username {
				existing = &current.Employees[n]
				break
			}
		}
		action := "employee.roster.updated"
		if existing != nil {
			if rosterMetadataEqual(*existing, p) {
				continue
			}
			existing.Name = p.Name
			existing.Department = p.Departments[0]
			existing.Departments = append([]string(nil), p.Departments...)
			existing.Title = p.Title
			existing.OrganizationPersonID = p.PersonID
			existing.DepartmentIDs = append([]string(nil), p.DepartmentIDs...)
			existing.OrganizationSeatIDs = append([]string(nil), p.SeatIDs...)
			existing.Placeholder = p.Placeholder
			existing.UpdatedAt = date
		} else {
			hash, err := hashPasswordWithMinimum(options.InitialPassword, 8)
			if err != nil {
				return nil, err
			}
			current.Employees = append(current.Employees, employee{ID: uuid(), Username: p.Username, Name: p.Name, Department: p.Departments[0], Departments: append([]string(nil), p.Departments...), OrganizationPersonID: p.PersonID, DepartmentIDs: append([]string(nil), p.DepartmentIDs...), OrganizationSeatIDs: append([]string(nil), p.SeatIDs...), Placeholder: p.Placeholder, Title: p.Title, Roles: append([]string(nil), p.Roles...), Status: "active", Source: "employee", PasswordHash: &hash, Epoch: 1, CreatedAt: date, UpdatedAt: date})
			existing = &current.Employees[len(current.Employees)-1]
			action = "employee.roster.created"
		}
		s.audit(&current, action, options.ActorID, existing.ID, existing.Roles, existing.Status)
		last := &current.Audit[len(current.Audit)-1]
		last.ImportID = roster.Revision
		last.Departments = append([]string(nil), p.Departments...)
	}
	if err = validateState(current); err != nil {
		return nil, err
	}
	raw, err := os.ReadFile(s.filePath)
	if err != nil {
		return nil, err
	}
	var disk state
	if err = json.Unmarshal(raw, &disk); err != nil {
		return nil, err
	}
	before, _ := json.Marshal(s.data)
	after, _ := json.Marshal(disk)
	if !bytes.Equal(before, after) {
		return nil, Fail(409, "员工账号文件已被其他进程修改，请停止服务后重新导入。")
	}
	if err = atomicSave(s.filePath, current); err != nil {
		return nil, err
	}
	s.data = current
	return report, nil
}

// OrganizationMember contains only the authenticated map directory. It omits
// authorization roles, status history, password hashes and audit details.
type OrganizationMember struct {
	PersonID            string   `json:"personId"`
	Username            string   `json:"username"`
	Name                string   `json:"name"`
	PrimaryDepartmentID string   `json:"primaryDepartmentId"`
	DepartmentIDs       []string `json:"departmentIds"`
	Departments         []string `json:"departments"`
	SeatIDs             []string `json:"seatIds"`
	Title               string   `json:"title"`
	Placeholder         bool     `json:"placeholder"`
	OutfitID            string   `json:"outfitId,omitempty"`
}

func (s *Store) ListOrganization(actorID string) ([]OrganizationMember, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	if _, err := active(&s.data, actorID); err != nil {
		return nil, err
	}
	out := []OrganizationMember{}
	for _, e := range s.data.Employees {
		if e.Status != "active" || e.OrganizationPersonID == "" || len(e.OrganizationSeatIDs) == 0 || len(e.DepartmentIDs) == 0 {
			continue
		}
		out = append(out, OrganizationMember{PersonID: e.OrganizationPersonID, Username: e.Username, Name: e.Name, PrimaryDepartmentID: e.DepartmentIDs[0], DepartmentIDs: append([]string(nil), e.DepartmentIDs...), Departments: append([]string(nil), e.Departments...), SeatIDs: append([]string(nil), e.OrganizationSeatIDs...), Title: e.Title, Placeholder: e.Placeholder, OutfitID: e.OutfitID})
	}
	return out, nil
}
