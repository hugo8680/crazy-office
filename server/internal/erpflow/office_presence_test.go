package erpflow

import (
	"context"
	"encoding/json"
	"math"
	"sort"
	"sync"
	"testing"
	"time"

	"crazyoffice/server/internal/identity"
)

func presenceRosterPerson(t *testing.T, ids *identity.Store, name string, departments, labels, seats []string) *identity.Actor {
	t.Helper()
	r := identity.Roster{Version: 1, Revision: "office-presence-test", Employees: []identity.RosterEmployee{{PersonID: "employee:" + name, Username: name + "@laisengou.com", Name: name, PrimaryDepartmentID: departments[0], DepartmentIDs: departments, Departments: labels, SeatIDs: seats, Roles: []string{"employee"}}}}
	if _, err := ids.ImportRoster(r, identity.ImportOptions{InitialPassword: "admin123"}); err != nil {
		t.Fatal(err)
	}
	a, err := ids.Authenticate(r.Employees[0].Username, "admin123")
	if err != nil || a == nil {
		t.Fatalf("real employee login failed: %v", err)
	}
	return a
}
func ownPresence(t *testing.T, people []M, id string) M {
	t.Helper()
	for _, p := range people {
		if p["id"] == id {
			return p
		}
	}
	t.Fatalf("employee %s is offline", id)
	return nil
}
func officeHeartbeat(t *testing.T, s *Service, a *identity.Actor) M {
	t.Helper()
	out, err := s.UpdateOfficePresence(a, M{"operation": "heartbeat"})
	if err != nil {
		t.Fatal(err)
	}
	return ownPresence(t, out, a.ID)
}
func officeAction(t *testing.T, s *Service, a *identity.Actor, op string, p M) M {
	t.Helper()
	if p == nil {
		p = M{}
	}
	p["operation"] = op
	p["expectedRevision"] = ownPresence(t, s.Online(), a.ID)["revision"]
	out, err := s.UpdateOfficePresence(a, p)
	if err != nil {
		t.Fatal(err)
	}
	return ownPresence(t, out, a.ID)
}
func TestOfficePresenceUsesActualMembershipAndStableWhitelistedIdentity(t *testing.T) {
	f := newFlow(t)
	real := presenceRosterPerson(t, f.ids, "dual-presence", []string{"research", "maintenance"}, []string{"研发部", "运维部"}, []string{"research_staff_002", "maintenance_manager_001"})
	fake := *real
	fake.Department = "财务部"
	fake.DepartmentIDs = []string{"finance"}
	fake.OrganizationSeatIDs = []string{"finance_manager_001"}
	fake.Name = "forged"
	fake.Roles = []string{"admin"}
	fake.Active = false
	me := officeHeartbeat(t, f.svc, &fake)
	if me["nodeId"] != "research" || me["department"] != "研发部" || me["name"] != real.Name || me["appearanceKey"] != "research_staff_002" {
		t.Fatalf("caller forged actual identity: %#v", me)
	}
	_, err := f.svc.UpdateOfficePresence(&fake, M{"operation": "sit", "seatId": "finance_manager_001", "expectedRevision": me["revision"]})
	domainStatus(t, err, 403)
	for _, seat := range []string{"research_staff_001", "maintenance_manager_001"} {
		me = officeAction(t, f.svc, &fake, "sit", M{"seatId": seat})
		if me["posture"] != "seated" || me["seatId"] != seat || me["appearanceKey"] != "research_staff_002" {
			t.Fatalf("dual department seat failed: %#v", me)
		}
	}
	raw, _ := json.Marshal(me)
	for _, key := range []string{"roles", "username", "passwordHash", "epoch", "session", "lease"} {
		var v M
		_ = json.Unmarshal(raw, &v)
		if _, ok := v[key]; ok {
			t.Fatalf("private field %s leaked", key)
		}
	}
	me["nodeId"] = "forged"
	if ownPresence(t, f.svc.Online(), real.ID)["nodeId"] != "maintenance" {
		t.Fatal("response mutated stored presence")
	}
}
func TestOfficeSeatRaceIsAtomicAndAllReleasePathsFreeTheSeat(t *testing.T) {
	f := newFlow(t)
	a, b := f.employee, f.approver
	pa, pb := officeHeartbeat(t, f.svc, a), officeHeartbeat(t, f.svc, b)
	gate := make(chan struct{})
	errors := make(chan error, 2)
	for i, person := range []*identity.Actor{a, b} {
		p := []M{pa, pb}[i]
		go func(a *identity.Actor, p M) {
			<-gate
			_, err := f.svc.UpdateOfficePresence(a, M{"operation": "sit", "seatId": "business_staff_001", "expectedRevision": p["revision"]})
			errors <- err
		}(person, p)
	}
	close(gate)
	wins, conflicts := 0, 0
	for range 2 {
		if err := <-errors; err == nil {
			wins++
		} else {
			domainStatus(t, err, 409)
			conflicts++
		}
	}
	if wins != 1 || conflicts != 1 {
		t.Fatalf("seat winners %d conflicts %d", wins, conflicts)
	}
	var seated, waiting *identity.Actor
	for _, a := range []*identity.Actor{a, b} {
		if ownPresence(t, f.svc.Online(), a.ID)["posture"] == "seated" {
			seated = a
		} else {
			waiting = a
		}
	}
	before := ownPresence(t, f.svc.Online(), seated.ID)
	stand := officeAction(t, f.svc, seated, "stand", nil)
	if stand["x"] != before["x"] || stand["y"] != before["y"] || stand["posture"] != "standing" || stand["seatId"] != "" {
		t.Fatal("standing teleported employee or retained seat")
	}
	officeAction(t, f.svc, waiting, "sit", M{"seatId": "business_staff_001"})
	officeAction(t, f.svc, waiting, "move", M{"x": 560, "y": 470})
	officeAction(t, f.svc, seated, "sit", M{"seatId": "business_staff_001"})
	f.svc.presenceMu.Lock()
	f.svc.presence[seated.ID]["updatedAt"] = time.Now().UnixMilli() - officePresenceTTL
	f.svc.presenceMu.Unlock()
	officeAction(t, f.svc, waiting, "sit", M{"seatId": "business_staff_001"})
	f.svc.LeaveOffice(waiting.ID)
	officeHeartbeat(t, f.svc, seated)
	officeAction(t, f.svc, seated, "sit", M{"seatId": "business_staff_001"})
}
func TestOfficeFreePointSeatsEnforceDistanceAndPublicAreaRules(t *testing.T) {
	f := newFlow(t)
	officeHeartbeat(t, f.svc, f.employee)
	officeHeartbeat(t, f.svc, f.approver)
	me := officeAction(t, f.svc, f.employee, "sit", M{"x": 560.0, "y": 470.0, "nodeId": "finance"})
	if me["posture"] != "seated" || me["seatId"] != "" || me["nodeId"] != "courtyard" {
		t.Fatal("free point sitting ignored authoritative coordinates")
	}
	for _, delta := range []float64{0, 17, 17.999} {
		_, err := f.svc.UpdateOfficePresence(f.approver, M{"operation": "sit", "x": 560 + delta, "y": 470, "expectedRevision": ownPresence(t, f.svc.Online(), f.approver.ID)["revision"]})
		domainStatus(t, err, 409)
	}
	officeAction(t, f.svc, f.approver, "sit", M{"x": 578, "y": 470})
	for _, p := range []M{{"x": 100, "y": 600}, {"x": -20, "y": 900}, {"x": 300, "y": 310}} {
		p["operation"] = "sit"
		p["expectedRevision"] = me["revision"]
		_, err := f.svc.UpdateOfficePresence(f.employee, p)
		if err == nil {
			t.Fatalf("invalid private/void free seat accepted: %#v", p)
		}
	}
	officeAction(t, f.svc, f.employee, "sit", M{"x": 1100, "y": 980})
	officeAction(t, f.svc, f.employee, "sit", M{"x": 1000, "y": 180})
}
func TestOfficeHeartbeatsAndLegacyClientsNeverOverrideModernAction(t *testing.T) {
	f := newFlow(t)
	officeHeartbeat(t, f.svc, f.employee)
	seated := officeAction(t, f.svc, f.employee, "sit", M{"seatId": "business_staff_001"})
	for _, payload := range []M{{"operation": "heartbeat", "nodeId": "finance", "x": 900, "y": 900, "posture": "standing", "seatId": "finance_manager_001", "expectedRevision": -1}, {"nodeId": "finance"}} {
		out, err := f.svc.UpdateOfficePresence(f.employee, payload)
		if err != nil {
			t.Fatal(err)
		}
		me := ownPresence(t, out, f.employee.ID)
		for _, field := range []string{"revision", "seatId", "posture", "nodeId", "x", "y"} {
			if me[field] != seated[field] {
				t.Fatalf("late heartbeat changed %s: %#v", field, me)
			}
		}
	}
	moved := officeAction(t, f.svc, f.employee, "move", M{"x": 560, "y": 470})
	_, err := f.svc.UpdateOfficePresence(f.employee, M{"operation": "sit", "seatId": "business_staff_002", "expectedRevision": seated["revision"]})
	domainStatus(t, err, 409)
	if ownPresence(t, f.svc.Online(), f.employee.ID)["revision"] != moved["revision"] {
		t.Fatal("stale action changed state")
	}
	for _, bad := range []any{nil, "2", -1, 1.5, math.NaN(), math.Inf(1), float64(9007199254740992)} {
		_, err := f.svc.UpdateOfficePresence(f.employee, M{"operation": "stand", "expectedRevision": bad})
		domainStatus(t, err, 400)
	}
}
func TestOfficeBrowserLeasesBlockStaleHeartbeatsAndOldLogout(t *testing.T) {
	f := newFlow(t)
	a := f.employee
	out, err := f.svc.JoinOffice(a, "cookie-one")
	if err != nil {
		t.Fatal(err)
	}
	me := ownPresence(t, out, a.ID)
	_, err = f.svc.UpdateOfficePresenceSession(a, M{"operation": "sit", "seatId": "business_staff_001", "expectedRevision": me["revision"]}, "cookie-one")
	if err != nil {
		t.Fatal(err)
	}
	out, err = f.svc.JoinOffice(a, "cookie-two")
	if err != nil {
		t.Fatal(err)
	}
	newMe := ownPresence(t, out, a.ID)
	if newMe["posture"] != "standing" || N(newMe["revision"]) <= N(me["revision"]) {
		t.Fatal("new browser login did not reset default or advance revision")
	}
	_, err = f.svc.UpdateOfficePresenceSession(a, M{"operation": "heartbeat"}, "cookie-one")
	domainStatus(t, err, 401)
	f.svc.LeaveOfficeSession(a.ID, "cookie-one")
	if ownPresence(t, f.svc.Online(), a.ID)["revision"] != newMe["revision"] {
		t.Fatal("old logout evicted current independent login")
	}
	f.svc.LeaveOfficeSession(a.ID, "cookie-two")
	if len(f.svc.Online()) != 0 {
		t.Fatal("current logout retained lease")
	}
	_, err = f.svc.UpdateOfficePresenceSession(a, M{"operation": "heartbeat"}, "cookie-two")
	domainStatus(t, err, 401)
	_, err = f.svc.UpdateOfficePresenceSession(a, M{"operation": "sit", "seatId": "business_staff_001", "expectedRevision": newMe["revision"]}, "cookie-two")
	domainStatus(t, err, 401)
}
func TestOfficePresenceRejectsInvalidOrDisabledIdentitiesAndIsTransient(t *testing.T) {
	f := newFlow(t)
	for _, a := range []*identity.Actor{nil, {PublicEmployee: identity.PublicEmployee{ID: "unknown", Active: true}, Epoch: 1}} {
		_, err := f.svc.UpdateOfficePresence(a, M{"operation": "heartbeat"})
		domainStatus(t, err, 401)
	}
	officeHeartbeat(t, f.svc, f.employee)
	officeAction(t, f.svc, f.employee, "sit", M{"seatId": "business_staff_001"})
	if _, err := f.ids.UpdateEmployee("bootstrap", f.employee.ID, M{"active": false}); err != nil {
		t.Fatal(err)
	}
	_, err := f.svc.UpdateOfficePresence(f.employee, M{"operation": "heartbeat"})
	domainStatus(t, err, 401)
	if len(f.svc.Online()) != 0 {
		t.Fatal("disabled employee retained a seat")
	}
	fresh := &Service{Identity: f.ids}
	if len(fresh.Online()) != 0 {
		t.Fatal("restart restored an online seat")
	}
	officeHeartbeat(t, fresh, f.approver)
	if err := f.svc.Shutdown(context.Background()); err != nil {
		t.Fatal(err)
	}
	_, err = f.svc.UpdateOfficePresence(f.approver, M{"operation": "heartbeat"})
	domainStatus(t, err, 503)
	if len(f.svc.Online()) != 0 {
		t.Fatal("shutdown retained online seats")
	}
}
func TestOfficeGeometryAndCoordinatesAreAuthoritativeFiniteAndOrdered(t *testing.T) {
	if len(officeLayout.Seats) != 251 || len(officeLayout.Rooms) != 12 {
		t.Fatal("organization geometry is incomplete")
	}
	ids := map[string]bool{}
	for _, seat := range officeLayout.Seats {
		if ids[seat.ID] || officeRoomAt(seat.X, seat.Y) != seat.DepartmentID {
			t.Fatalf("invalid seat geometry: %#v", seat)
		}
		ids[seat.ID] = true
	}
	f := newFlow(t)
	officeHeartbeat(t, f.svc, f.employee)
	for _, bad := range []M{{"x": nil, "y": 470}, {"x": "560", "y": 470}, {"x": math.NaN(), "y": 470}, {"x": math.Inf(1), "y": 470}, {"x": -156, "y": 900}, {"x": -20, "y": 470}, {"x": 1371, "y": 470}, {"x": 560, "y": 1081}} {
		bad["operation"] = "move"
		bad["expectedRevision"] = ownPresence(t, f.svc.Online(), f.employee.ID)["revision"]
		_, err := f.svc.UpdateOfficePresence(f.employee, bad)
		domainStatus(t, err, 400)
	}
	officeAction(t, f.svc, f.employee, "move", M{"x": -155, "y": 900})
	officeAction(t, f.svc, f.employee, "move", M{"x": 1370, "y": 1080})
	officeHeartbeat(t, f.svc, f.approver)
	people := f.svc.Online()
	got := []string{}
	for _, person := range people {
		got = append(got, S(person["id"]))
	}
	if !sort.StringsAreSorted(got) {
		t.Fatal("presence order is unstable")
	}
}
func TestOfficeConcurrentHeartbeatMoveAndDirectoryChangesHaveNoDeadlocks(t *testing.T) {
	f := newFlow(t)
	officeHeartbeat(t, f.svc, f.employee)
	var wg sync.WaitGroup
	for range 8 {
		wg.Go(func() {
			for range 30 {
				_, _ = f.svc.UpdateOfficePresence(f.employee, M{"operation": "heartbeat"})
				_ = f.svc.Online()
			}
		})
	}
	wg.Go(func() {
		for range 10 {
			if _, err := f.ids.UpdateEmployee("bootstrap", f.employee.ID, M{"title": "办公员工"}); err != nil {
				t.Error(err)
			}
		}
	})
	done := make(chan struct{})
	go func() { wg.Wait(); close(done) }()
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("identity/presence lock ordering deadlocked")
	}
}

func TestOfficeDepartmentTransferReleasesOldSeatWithoutGrantingNewPermissions(t *testing.T) {
	f := newFlow(t)
	officeHeartbeat(t, f.svc, f.employee)
	before := officeAction(t, f.svc, f.employee, "sit", M{"seatId": "business_staff_001"})
	if _, err := f.ids.UpdateEmployee("bootstrap", f.employee.ID, M{"department": "财务部"}); err != nil {
		t.Fatal(err)
	}
	after := ownPresence(t, f.svc.Online(), f.employee.ID)
	if after["posture"] != "standing" || after["seatId"] != "" || after["department"] != "财务部" || N(after["revision"]) <= N(before["revision"]) {
		t.Fatalf("transfer retained obsolete department seat: %#v", after)
	}
	_, err := f.svc.UpdateOfficePresence(f.employee, M{"operation": "sit", "seatId": "business_staff_001", "expectedRevision": after["revision"]})
	domainStatus(t, err, 403)
	officeHeartbeat(t, f.svc, f.approver)
	officeAction(t, f.svc, f.approver, "sit", M{"seatId": "business_staff_001"})
}

func TestOfficeRejectsExplicitInternalOperationAndExpiredRevisionCannotReappear(t *testing.T) {
	f := newFlow(t)
	me := officeHeartbeat(t, f.svc, f.employee)
	for _, op := range []any{"legacy", "teleport", M{}, 123} {
		_, err := f.svc.UpdateOfficePresence(f.employee, M{"operation": op, "nodeId": "unknown"})
		domainStatus(t, err, 400)
	}
	f.svc.presenceMu.Lock()
	f.svc.presence[f.employee.ID]["updatedAt"] = time.Now().UnixMilli() - 45001
	f.svc.presenceMu.Unlock()
	_, err := f.svc.UpdateOfficePresence(f.employee, M{"operation": "move", "x": 560, "y": 470, "expectedRevision": me["revision"]})
	domainStatus(t, err, 409)
	if len(f.svc.Online()) != 0 {
		t.Fatal("expired action recreated a lease")
	}
	fresh := officeHeartbeat(t, f.svc, f.employee)
	if N(fresh["revision"]) <= N(me["revision"]) {
		t.Fatal("expiry recycled an old revision")
	}
}
