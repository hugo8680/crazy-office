package httpapi

import (
	"testing"

	"crazyoffice/server/internal/erpflow"
)

func TestHTTPPersonalAppearancePreservesSeatAndRejectsIdentitySpoofing(t *testing.T) {
	f := newApp(t)
	person, cookie := f.officePerson("wardrobe-http", []string{"business"}, []string{"商务部"}, []string{"business_staff_001"})
	id := erpflow.S(person["id"])
	headers := map[string]string{"X-Office-Actor": id}
	p := httpOfficePerson(t, f.expect(f.send("GET", "/api/erp/presence", cookie, nil, nil), 200), id)
	p = httpOfficePerson(t, f.expect(f.send("PUT", "/api/erp/presence", cookie, M{"operation": "sit", "seatId": "business_staff_001", "expectedRevision": p["revision"]}, headers), 200), id)
	out := f.expect(f.send("POST", "/api/erp/identity/appearance", cookie, M{"outfitId": "marine", "id": "bootstrap", "roles": []string{"admin"}, "department": "财务部"}, headers), 200)
	session := erpflow.Map(out.json["session"])
	updated := erpflow.Map(session["actor"])
	if session["authenticated"] != true || updated["id"] != id || updated["outfitId"] != "marine" || updated["department"] != "商务部" {
		t.Fatalf("unexpected appearance response: %s", out.body)
	}
	current := httpOfficePerson(t, f.expect(f.send("PUT", "/api/erp/presence", cookie, M{"operation": "heartbeat"}, headers), 200), id)
	if current["outfitId"] != "marine" || current["seatId"] != p["seatId"] || current["posture"] != "seated" || current["revision"] != p["revision"] || current["x"] != p["x"] || current["y"] != p["y"] {
		t.Fatalf("wardrobe moved avatar or retained old outfit: %#v", current)
	}
	directory := f.expect(f.send("GET", "/api/erp/organization", cookie, nil, nil), 200)
	found := false
	for _, member := range erpflow.Rows(directory.json["employees"]) {
		if member["username"] == "wardrobe-http@laisengou.com" {
			found = member["outfitId"] == "marine"
		}
	}
	if !found {
		t.Fatal("offline directory lost the employee's outfit")
	}
	again := f.login("wardrobe-http@laisengou.com", "admin123")
	restored := erpflow.Map(erpflow.Map(f.expect(f.send("GET", "/api/session", again, nil, nil), 200).json["session"])["actor"])
	if restored["outfitId"] != "marine" {
		t.Fatal("new login lost chosen outfit")
	}
	f.expect(f.send("POST", "/api/erp/identity/appearance", "", M{"outfitId": "cloud"}, nil), 401)
	f.expect(f.send("POST", "/api/erp/identity/appearance", again, M{"outfitId": "cloud"}, map[string]string{"X-Office-Actor": "bootstrap"}), 401)
	for _, body := range []M{{}, {"outfitId": 1}, {"outfitId": "unknown"}, {"outfitId": ""}} {
		f.expect(f.send("POST", "/api/erp/identity/appearance", again, body, headers), 400)
	}
}
