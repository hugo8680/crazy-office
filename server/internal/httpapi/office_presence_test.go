package httpapi

import (
	"strings"
	"testing"

	"crazyoffice/server/internal/erpflow"
	"crazyoffice/server/internal/identity"
)

func (f *appFixture) officePerson(name string, deptIDs, departments, seats []string) (M, string) {
	f.t.Helper()
	r := identity.Roster{Version: 1, Revision: "http-office-lease", Employees: []identity.RosterEmployee{{PersonID: "employee:" + name, Username: name + "@laisengou.com", Name: name, PrimaryDepartmentID: deptIDs[0], DepartmentIDs: deptIDs, Departments: departments, SeatIDs: seats, Roles: []string{"employee"}}}}
	if _, err := f.a.Identity.ImportRoster(r, identity.ImportOptions{InitialPassword: "admin123"}); err != nil {
		f.t.Fatal(err)
	}
	cookie := f.login(r.Employees[0].Username, "admin123")
	session := f.expect(f.send("GET", "/api/session", cookie, nil, nil), 200)
	return erpflow.Map(erpflow.Map(session.json["session"])["actor"]), cookie
}
func httpOfficePerson(t *testing.T, r response, id string) M {
	t.Helper()
	for _, person := range erpflow.Rows(r.json["online"]) {
		if person["id"] == id {
			return person
		}
	}
	t.Fatalf("employee %s absent from online response: %s", id, r.body)
	return nil
}
func TestHTTPOfficeLoginUsesActualDepartmentAndAtomicSeatRaceWithIndependentCookies(t *testing.T) {
	f := newApp(t)
	a, ca := f.officePerson("seat-alpha", []string{"business"}, []string{"商务部"}, []string{"business_staff_001"})
	b, cb := f.officePerson("seat-beta", []string{"business"}, []string{"商务部"}, []string{"business_staff_002"})
	if ca == cb {
		t.Fatal("employees shared a session cookie")
	}
	pa := httpOfficePerson(t, f.expect(f.send("GET", "/api/erp/presence", ca, nil, nil), 200), erpflow.S(a["id"]))
	pb := httpOfficePerson(t, f.expect(f.send("GET", "/api/erp/presence", cb, nil, nil), 200), erpflow.S(b["id"]))
	if pa["nodeId"] != "business" || pa["posture"] != "standing" || pa["appearanceKey"] != "business_staff_001" {
		t.Fatalf("login did not initialize real department: %#v", pa)
	}
	replies := make(chan response, 2)
	start := make(chan struct{})
	for _, v := range []struct {
		person M
		cookie string
		p      M
	}{{a, ca, pa}, {b, cb, pb}} {
		go func(person M, cookie string, p M) {
			<-start
			replies <- f.send("PUT", "/api/erp/presence", cookie, M{"operation": "sit", "seatId": "business_staff_003", "expectedRevision": p["revision"], "departmentIds": []string{"finance"}, "roles": []string{"admin"}}, map[string]string{"X-Office-Actor": erpflow.S(person["id"])})
		}(v.person, v.cookie, v.p)
	}
	close(start)
	ok, conflict := 0, 0
	for range 2 {
		r := <-replies
		if r.status == 200 {
			ok++
		} else if r.status == 409 {
			conflict++
		} else {
			t.Fatalf("seat race returned HTTP %d: %s", r.status, r.body)
		}
	}
	if ok != 1 || conflict != 1 {
		t.Fatalf("race success %d conflict %d", ok, conflict)
	}
	after := f.expect(f.send("GET", "/api/erp/presence", ca, nil, nil), 200)
	seated := []M{}
	for _, p := range erpflow.Rows(after.json["online"]) {
		if p["seatId"] == "business_staff_003" {
			seated = append(seated, p)
		}
	}
	if len(seated) != 1 {
		t.Fatalf("duplicate seat occupancy: %s", after.body)
	}
	for _, p := range erpflow.Rows(after.json["online"]) {
		for _, key := range []string{"roles", "username", "epoch", "session", "passwordHash", "lease"} {
			if _, ok := p[key]; ok {
				t.Fatalf("online response leaked %s", key)
			}
		}
	}
}
func TestHTTPOfficeLogoutReleasesOnlyItsBrowserLeaseAndRejectsLateHeartbeat(t *testing.T) {
	f := newApp(t)
	person, first := f.officePerson("lease-employee", []string{"business"}, []string{"商务部"}, []string{"business_staff_001"})
	id := erpflow.S(person["id"])
	p := httpOfficePerson(t, f.expect(f.send("GET", "/api/erp/presence", first, nil, nil), 200), id)
	f.expect(f.send("PUT", "/api/erp/presence", first, M{"operation": "sit", "seatId": "business_staff_001", "expectedRevision": p["revision"]}, nil), 200)
	second := f.login("lease-employee@laisengou.com", "admin123")
	current := httpOfficePerson(t, f.expect(f.send("GET", "/api/erp/presence", second, nil, nil), 200), id)
	if current["posture"] != "standing" || current["seatId"] != "" {
		t.Fatal("independent login retained old seat reservation")
	}
	f.expect(f.send("PUT", "/api/erp/presence", first, M{"operation": "heartbeat"}, nil), 401)
	f.expect(f.send("POST", "/api/session/logout", first, M{}, nil), 200)
	if httpOfficePerson(t, f.expect(f.send("GET", "/api/erp/presence", second, nil, nil), 200), id)["revision"] != current["revision"] {
		t.Fatal("old cookie logout evicted newer independent login")
	}
	bad := f.expect(f.send("POST", "/api/session/logout", second, M{}, map[string]string{"X-Office-Actor": "bootstrap"}), 401)
	if bad.header.Get("Set-Cookie") != "" {
		t.Fatal("mismatched screen logged out new cookie")
	}
	logout := f.expect(f.send("POST", "/api/session/logout", second, M{}, map[string]string{"X-Office-Actor": id}), 200)
	if !strings.Contains(logout.header.Get("Set-Cookie"), "Max-Age=0") {
		t.Fatal("logout retained browser cookie")
	}
	for _, p := range f.a.Flow.Online() {
		if p["id"] == id {
			t.Fatal("logout kept online employee")
		}
	}
	f.expect(f.send("PUT", "/api/erp/presence", second, M{"operation": "heartbeat"}, nil), 401)
	f.expect(f.send("PUT", "/api/erp/presence", second, M{"operation": "stand", "expectedRevision": current["revision"]}, nil), 401)
}
func TestHTTPOfficeDualMembershipFreeSittingAndHeartbeatStaleness(t *testing.T) {
	f := newApp(t)
	person, cookie := f.officePerson("dual-office", []string{"research", "maintenance"}, []string{"研发部", "运维部"}, []string{"research_staff_003", "maintenance_manager_001"})
	id := erpflow.S(person["id"])
	headers := map[string]string{"X-Office-Actor": id}
	me := httpOfficePerson(t, f.expect(f.send("GET", "/api/erp/presence", cookie, nil, nil), 200), id)
	if me["nodeId"] != "research" {
		t.Fatal("primary department ignored at login")
	}
	for _, seat := range []string{"research_staff_001", "maintenance_manager_001"} {
		r := f.expect(f.send("PUT", "/api/erp/presence", cookie, M{"operation": "sit", "seatId": seat, "expectedRevision": me["revision"]}, headers), 200)
		me = httpOfficePerson(t, r, id)
	}
	seated := me
	r := f.expect(f.send("PUT", "/api/erp/presence", cookie, M{"operation": "heartbeat", "nodeId": "finance", "x": 100, "y": 600, "expectedRevision": -1}, headers), 200)
	me = httpOfficePerson(t, r, id)
	if me["revision"] != seated["revision"] || me["seatId"] != "maintenance_manager_001" {
		t.Fatal("heartbeat overwrote sitting action")
	}
	r = f.expect(f.send("PUT", "/api/erp/presence", cookie, M{"operation": "stand", "expectedRevision": me["revision"]}, headers), 200)
	me = httpOfficePerson(t, r, id)
	if me["x"] != seated["x"] || me["y"] != seated["y"] {
		t.Fatal("standing teleported user")
	}
	f.expect(f.send("PUT", "/api/erp/presence", cookie, M{"operation": "sit", "seatId": "research_staff_001", "expectedRevision": seated["revision"]}, headers), 409)
	f.expect(f.send("PUT", "/api/erp/presence", cookie, M{"operation": "sit", "seatId": "finance_manager_001", "expectedRevision": me["revision"]}, headers), 403)
	for _, point := range []M{{"x": 560, "y": 470}, {"x": 1110, "y": 975}} {
		point["operation"] = "sit"
		point["expectedRevision"] = me["revision"]
		r = f.expect(f.send("PUT", "/api/erp/presence", cookie, point, headers), 200)
		me = httpOfficePerson(t, r, id)
		if me["posture"] != "seated" || me["seatId"] != "" {
			t.Fatal("public free sitting did not persist")
		}
	}
}
func TestHTTPOfficeWalkCannotGrantBusinessAccessAndDisabledEmployeeCannotRetainSeat(t *testing.T) {
	f := newApp(t)
	person, cookie := f.officePerson("scoped-office", []string{"business"}, []string{"商务部"}, []string{"business_staff_004"})
	id := erpflow.S(person["id"])
	private := f.project([]string{"bootstrap"})
	before := f.expect(f.send("GET", "/api/erp/snapshot", cookie, nil, nil), 200)
	if strings.Contains(string(before.body), erpflow.S(private["id"])) {
		t.Fatal("fixture was already allowed to private project")
	}
	me := httpOfficePerson(t, f.expect(f.send("GET", "/api/erp/presence", cookie, nil, nil), 200), id)
	f.expect(f.send("PUT", "/api/erp/presence", cookie, M{"operation": "move", "x": 100, "y": 650, "expectedRevision": me["revision"], "roles": []string{"admin", "finance"}, "department": "财务部"}, map[string]string{"X-Office-Actor": "bootstrap"}), 401)
	moved := f.expect(f.send("PUT", "/api/erp/presence", cookie, M{"operation": "move", "x": 100, "y": 650, "expectedRevision": me["revision"], "roles": []string{"admin", "finance"}, "department": "财务部"}, map[string]string{"X-Office-Actor": id}), 200)
	me = httpOfficePerson(t, moved, id)
	if me["nodeId"] != "finance" || me["department"] != "商务部" {
		t.Fatal("walking changed employment membership")
	}
	after := f.expect(f.send("GET", "/api/erp/snapshot", cookie, nil, nil), 200)
	if strings.Contains(string(after.body), erpflow.S(private["id"])) {
		t.Fatal("walking granted private project access")
	}
	f.expect(f.send("POST", "/api/erp/masterdata", cookie, M{"_requestId": "walking-grant-check", "kind": "products", "record": M{"sku": "FORGED", "name": "forged", "unit": "个"}}, nil), 403)
	f.expect(f.send("PUT", "/api/erp/presence", cookie, M{"operation": "sit", "seatId": "finance_manager_001", "expectedRevision": me["revision"]}, nil), 403)
	if _, err := f.a.Identity.UpdateEmployee("bootstrap", id, M{"active": false}); err != nil {
		t.Fatal(err)
	}
	f.expect(f.send("PUT", "/api/erp/presence", cookie, M{"operation": "heartbeat"}, nil), 401)
	admin := f.expect(f.send("GET", "/api/erp/presence", f.admin, nil, nil), 200)
	for _, p := range erpflow.Rows(admin.json["online"]) {
		if p["id"] == id {
			t.Fatal("disabled employee retained live presence")
		}
	}
}

func TestHTTPOfficeSameCookieTabsCannotApplyTwoStaleMoves(t *testing.T) {
	f := newApp(t)
	person, cookie := f.officePerson("two-tabs", []string{"business"}, []string{"商务部"}, []string{"business_staff_005"})
	id := erpflow.S(person["id"])
	me := httpOfficePerson(t, f.expect(f.send("GET", "/api/erp/presence", cookie, nil, nil), 200), id)
	start := make(chan struct{})
	replies := make(chan response, 2)
	for _, x := range []int{560, 600} {
		go func(x int) {
			<-start
			replies <- f.send("PUT", "/api/erp/presence", cookie, M{"operation": "move", "x": x, "y": 470, "expectedRevision": me["revision"]}, map[string]string{"X-Office-Actor": id})
		}(x)
	}
	close(start)
	ok, stale := 0, 0
	for range 2 {
		r := <-replies
		switch r.status {
		case 200:
			ok++
		case 409:
			stale++
		default:
			t.Fatalf("concurrent tab returned HTTP %d: %s", r.status, r.body)
		}
	}
	if ok != 1 || stale != 1 {
		t.Fatalf("tabs applied %d moves and %d conflicts", ok, stale)
	}
	after := httpOfficePerson(t, f.expect(f.send("GET", "/api/erp/presence", cookie, nil, nil), 200), id)
	heartbeat := f.expect(f.send("PUT", "/api/erp/presence", cookie, M{"operation": "heartbeat", "x": -100, "y": 900, "nodeId": "data_center"}, nil), 200)
	fresh := httpOfficePerson(t, heartbeat, id)
	if fresh["revision"] != after["revision"] || fresh["x"] != after["x"] || fresh["y"] != after["y"] {
		t.Fatal("old tab heartbeat changed successful move")
	}
}
