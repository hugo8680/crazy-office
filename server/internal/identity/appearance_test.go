package identity

import "testing"

func TestAppearancePersistsWithoutChangingAuthorityOrSession(t *testing.T) {
	s, path := fixture(t)
	person := join(t, s, "wardrobe", []string{"employee"})
	before := s.GetEmployee(person.ID)
	for _, outfit := range []string{"atelier", "linen", "marine", "terracotta", "plum", "cloud"} {
		updated, err := s.SetAppearance(person, outfit)
		if err != nil || updated.OutfitID != outfit || updated.Epoch != person.Epoch {
			t.Fatalf("saving %s: %#v %v", outfit, updated, err)
		}
	}
	reopened, err := Open(path, "office")
	if err != nil {
		t.Fatal(err)
	}
	after := reopened.ResolveSession(person.ID, person.Epoch)
	if after == nil || after.OutfitID != "cloud" || after.Department != before.Department || after.Username != before.Username || len(after.Roles) != 1 || after.Roles[0] != "employee" {
		t.Fatalf("appearance changed identity or was lost: %#v", after)
	}
	if _, err := reopened.Authenticate("wardrobe", testPassword); err != nil {
		t.Fatalf("appearance changed credentials: %v", err)
	}
}

func TestAppearanceRejectsInvalidAndStaleIdentity(t *testing.T) {
	s, _ := fixture(t)
	person := join(t, s, "outfit-owner", []string{"employee"})
	for _, id := range []string{"", "Marine", "marine ", "admin", "<script>", "../../cloud"} {
		_, err := s.SetAppearance(person, id)
		status(t, err, 400)
	}
	_, err := s.SetAppearance(nil, "marine")
	status(t, err, 401)
	stale := *person
	stale.Epoch++
	_, err = s.SetAppearance(&stale, "marine")
	status(t, err, 401)
	if s.GetEmployee(person.ID).OutfitID != "" {
		t.Fatal("rejected preference was saved")
	}
	_, err = s.UpdateEmployee("bootstrap", person.ID, map[string]any{"active": false})
	if err != nil {
		t.Fatal(err)
	}
	_, err = s.SetAppearance(person, "marine")
	status(t, err, 403)
}
