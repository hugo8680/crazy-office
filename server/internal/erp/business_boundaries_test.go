package erp

import (
	"strings"
	"testing"
	"time"
)

func boundaryInput(typ string) map[string]any {
	switch typ {
	case "project_setup":
		return map[string]any{"objective": "交付客户平台"}
	case "project_delivery":
		return map[string]any{"deliveryNote": "客户清单待核对", "acceptanceCriteria": "核对签收与实际成果"}
	case "weekly_report":
		today := time.Now().Format("2006-01-02")
		return map[string]any{"periodStart": today, "periodEnd": today}
	case "onboarding":
		return map[string]any{"employeeId": employee.ID, "position": "项目专员", "resourceRequirements": "办公账号准备"}
	}
	return nil
}

func TestPostingRolesFollowTheBusinessTypeAndProjectScope(t *testing.T) {
	for _, typ := range []string{"project_setup", "project_delivery", "weekly_report", "onboarding"} {
		t.Run(typ, func(t *testing.T) {
			f := newFixture(t, typ != "project_setup")
			requester := employee
			if typ == "onboarding" {
				requester = manager
			}
			d := f.approve(f.doc(typ, boundaryInput(typ), nil, requester), requester)
			denied, permitted := hr, pm
			if typ == "onboarding" {
				denied, permitted = pm, hr
			}
			if has(stringsOf(f.specificDocument(d["id"], denied)["allowedActions"]), "post") {
				t.Fatal("unrelated role received posting action")
			}
			reject(t, f.s, denied, "document.post", map[string]any{"id": d["id"], "reference": "FORBIDDEN-POST", "type": "onboarding"}, "FORBIDDEN")
			reject(t, f.s, outsider, "document.post", map[string]any{"id": d["id"], "reference": "OUTSIDE-PROJECT"}, "FORBIDDEN")
			if !has(stringsOf(f.specificDocument(d["id"], permitted)["allowedActions"]), "post") {
				t.Fatal("actual business role lost posting action")
			}
			f.cmd(permitted, "document.post", map[string]any{"id": d["id"], "reference": "AUTHORIZED-" + typ})
		})
	}
}

func (f *fixture) specificDocument(id any, a Actor) map[string]any {
	f.t.Helper()
	for _, d := range f.snapshot(a)["documents"].([]map[string]any) {
		if d["id"] == id {
			return d
		}
	}
	f.t.Fatal("authorized test document missing")
	return nil
}

func TestNonStockConfirmationPersistsItsReceiptAndCannotBeRewritten(t *testing.T) {
	for _, typ := range []string{"project_setup", "project_delivery", "weekly_report", "onboarding"} {
		t.Run(typ, func(t *testing.T) {
			f := newFixture(t, typ != "project_setup")
			requester := employee
			if typ == "onboarding" {
				requester = hr
			}
			d := f.approve(f.doc(typ, boundaryInput(typ), nil, requester), requester)
			reject(t, f.s, admin, "document.post", map[string]any{"id": d["id"], "version": d["version"]}, "VALIDATION")
			p := map[string]any{"id": d["id"], "version": d["version"], "reference": "CONFIRM-" + typ, "note": "用户提供的凭证编号，客户签名仍须人工核对"}
			key := uid("confirm-key")
			out, err := f.s.Command(ctx, admin, "document.post", p, key)
			if err != nil {
				t.Fatal(err)
			}
			confirmation := obj(out["confirmation"])
			if confirmation["reference"] != p["reference"] || confirmation["note"] != p["note"] || confirmation["actorId"] != admin.ID || confirmation["actorName"] != admin.DisplayName || confirmation["createdAt"] == "" {
				t.Fatal("confirmation facts were dropped", confirmation)
			}
			replay, err := f.s.Command(ctx, admin, "document.post", p, key)
			if err != nil || dump(replay["confirmation"]) != dump(confirmation) {
				t.Fatal("idempotent replay rewrote receipt", err)
			}
			changed := map[string]any{"id": d["id"], "version": d["version"], "reference": "REPLACED", "note": "覆盖旧凭证"}
			_, err = f.s.Command(ctx, admin, "document.post", changed, key)
			expectCode(t, err, "IDEMPOTENCY_CONFLICT")
			reject(t, f.s, admin, "document.post", changed, "VERSION_CONFLICT")
			fresh := f.specificDocument(d["id"], admin)
			if dump(fresh["confirmation"]) != dump(confirmation) {
				t.Fatal("later attempt changed immutable confirmation")
			}
			found := false
			for _, event := range f.snapshot(admin)["audit"].([]map[string]any) {
				if event["entityId"] == d["id"] && event["action"] == "document.post" && strings.Contains(dump(event["detail"]), str(p["reference"])) {
					found = true
				}
			}
			if !found {
				t.Fatal("receipt missing from business audit")
			}
		})
	}
}
