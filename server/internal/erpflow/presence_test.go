package erpflow

import (
	"testing"
	"time"
)

func TestPresenceCarriesOnlyStableWorkplaceAppearanceKey(t *testing.T) {
	f := newFlow(t)
	f.employee.OrganizationSeatIDs = []string{"research_staff_002", "maintenance_manager_001"}
	people, err := f.svc.Touch(f.employee, "maintenance")
	if err != nil || len(people) != 1 {
		t.Fatalf("presence failed: %v", err)
	}
	if people[0]["appearanceKey"] != "research_staff_002" {
		t.Fatal("moving between departments changed the primary workplace appearance")
	}
	for _, key := range []string{"password", "passwordHash", "roles", "username"} {
		if _, found := people[0][key]; found {
			t.Fatalf("presence should not copy identity field %s", key)
		}
	}
}

func TestPresenceAcceptsOrganizationDepartmentsAndBulletin(t *testing.T) {
	f := newFlow(t)
	areas := []string{"business", "hr_admin", "finance", "legal", "channels", "research", "operations", "general_office", "ai_data", "investment", "maintenance", "public_affairs", "bulletin"}
	if _, err := f.svc.Touch(f.approver, "general_office"); err != nil {
		t.Fatal(err)
	}
	for _, area := range areas {
		t.Run(area, func(t *testing.T) {
			before := time.Now().UnixMilli()
			people, err := f.svc.Touch(f.employee, area)
			if err != nil {
				t.Fatal(err)
			}
			if len(people) != 2 {
				t.Fatalf("location change created extra employees: %d", len(people))
			}
			var mine, other M
			for _, person := range people {
				if person["id"] == f.employee.ID {
					mine = person
				} else if person["id"] == f.approver.ID {
					other = person
				}
			}
			if mine == nil || mine["nodeId"] != area || mine["name"] != f.employee.Name || mine["department"] != f.employee.Department || mine["online"] != true || N(mine["updatedAt"]) < before {
				t.Fatalf("incorrect presence: %#v", mine)
			}
			if other == nil || other["nodeId"] != "general_office" {
				t.Fatalf("moving one employee changed a colleague: %#v", other)
			}
		})
	}
}

func TestPresenceLegacyAreasAndUnknownAreaValidation(t *testing.T) {
	f := newFlow(t)
	for _, area := range []string{"workstations", "executive", "storage", "reception", "meeting", "finance", "general_office", "investment", "server", ""} {
		people, err := f.svc.Touch(f.employee, area)
		if err != nil {
			t.Fatalf("legacy area %q: %v", area, err)
		}
		want := area
		if want == "" {
			want = "workstations"
		}
		if len(people) != 1 || people[0]["nodeId"] != want {
			t.Fatalf("legacy area %q recorded %#v", area, people)
		}
	}
	for _, invalid := range []string{"unknown", "Business", "../finance", "ai_data_team_1", "董事长"} {
		_, err := f.svc.Touch(f.employee, invalid)
		domainStatus(t, err, 400)
	}
	people := f.svc.Online()
	if len(people) != 1 || people[0]["nodeId"] != "workstations" {
		t.Fatalf("invalid area changed saved presence: %#v", people)
	}
}

func TestPresenceLocationsKeepExistingExpirationAndEmployeeChecks(t *testing.T) {
	f := newFlow(t)
	if _, err := f.svc.Touch(f.employee, "ai_data"); err != nil {
		t.Fatal(err)
	}
	f.svc.mu.Lock()
	f.svc.presence[f.employee.ID]["updatedAt"] = time.Now().UnixMilli() - 45001
	f.svc.presence["not-an-employee"] = M{"id": "not-an-employee", "nodeId": "research", "updatedAt": time.Now().UnixMilli(), "online": true}
	f.svc.mu.Unlock()
	if people := f.svc.Online(); len(people) != 0 {
		t.Fatalf("expired or unknown employees became online: %#v", people)
	}
	if _, err := f.svc.Touch(f.employee, "research"); err != nil {
		t.Fatal(err)
	}
	people := f.svc.Online()
	people[0]["nodeId"] = "tampered"
	if fresh := f.svc.Online(); len(fresh) != 1 || fresh[0]["nodeId"] != "research" {
		t.Fatalf("returned presence mutated service state: %#v", fresh)
	}
}
