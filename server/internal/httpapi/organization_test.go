package httpapi

import (
	"crazyoffice/server/internal/erpflow"
	"crazyoffice/server/internal/identity"
	"strings"
	"testing"
)

func TestHTTPOrganizationDirectoryIsAuthenticatedAndUsesPersistedAccountMemberships(t *testing.T) {
	f := newApp(t)
	f.expect(f.send("GET", "/api/erp/organization", "", nil, nil), 401)
	initial := f.expect(f.send("GET", "/api/erp/organization", f.admin, nil, nil), 200)
	if len(erpflow.Rows(initial.json["employees"])) != 0 {
		t.Fatal("empty directory invented organizational identities")
	}
	r := identity.Roster{Version: 1, Revision: "http-roster-test", Employees: []identity.RosterEmployee{{PersonID: "employee:directory-test", Username: "directory-test@laisengou.com", Name: "目录测试", PrimaryDepartmentID: "research", DepartmentIDs: []string{"research", "maintenance"}, Departments: []string{"研发部", "运维部"}, SeatIDs: []string{"research_staff_001", "maintenance_manager_001"}, Roles: []string{"employee"}}}}
	if _, err := f.a.Identity.ImportRoster(r, identity.ImportOptions{InitialPassword: "admin123"}); err != nil {
		t.Fatal(err)
	}
	cookie := f.login(r.Employees[0].Username, "admin123")
	response := f.expect(f.send("GET", "/api/erp/organization", cookie, nil, nil), 200)
	list := erpflow.Rows(response.json["employees"])
	if len(list) != 1 || list[0]["name"] != "目录测试" || len(erpflow.Strings(list[0]["departmentIds"])) != 2 || len(erpflow.Strings(list[0]["seatIds"])) != 2 {
		t.Fatalf("directory mismatch: %s", response.body)
	}
	for _, private := range []string{"passwordHash", "epoch", "roles", "source", "createdAt", "admin123"} {
		if strings.Contains(string(response.body), private) {
			t.Fatal("directory leaked " + private)
		}
	}
	if response.header.Get("Cache-Control") != "no-store" {
		t.Fatal("directory may be cached publicly")
	}
	f.expect(f.send("GET", "/api/erp/organization", cookie, nil, map[string]string{"X-Office-Actor": "bootstrap"}), 401)
	users, err := f.a.Identity.ListEmployees("bootstrap")
	if err != nil {
		t.Fatal(err)
	}
	var id string
	for _, p := range users {
		if p.Username == r.Employees[0].Username {
			id = p.ID
		}
	}
	if _, err = f.a.Identity.UpdateEmployee("bootstrap", id, map[string]any{"active": false}); err != nil {
		t.Fatal(err)
	}
	f.expect(f.send("GET", "/api/erp/organization", cookie, nil, nil), 401)
	after := f.expect(f.send("GET", "/api/erp/organization", f.admin, nil, nil), 200)
	if len(erpflow.Rows(after.json["employees"])) != 0 {
		t.Fatal("disabled employee remains on authenticated map")
	}
}
