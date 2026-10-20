package httpapi

import (
	"context"
	"database/sql"
	"encoding/json"
	"strings"
	"testing"
	"time"

	"crazyoffice/server/internal/erpflow"
)

// Exercise the public HTTP contract and its authoritative ledger checks. The
// existing fixtureProvider is local and deterministic; no model or web request
// leaves this test server. SQLite seeding only supplies opening stock.
func boundaryWork(f *appFixture, cookie string, payload M) M {
	f.t.Helper()
	payload["_requestId"] = "boundary-create-" + erpflow.ID()
	r := f.expect(f.send("POST", "/api/erp/workitems", cookie, payload, nil), 202)
	id := erpflow.S(erpflow.Map(r.json["document"])["id"])
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	run, err := f.a.Flow.Wait(ctx, id)
	if err != nil || run["status"] != "completed" {
		f.t.Fatalf("isolated provider did not finish: %v, %v", run, err)
	}
	d := f.doc(cookie, id)
	if d["status"] != "awaiting_approval" {
		f.t.Fatalf("work did not reach human approval: %v", d)
	}
	return d
}

func boundaryApprove(f *appFixture, d M, first string) M {
	f.t.Helper()
	id := erpflow.S(d["id"])
	r := f.action(first, id, "approve", M{"expectedVersion": d["version"], "note": "已核对原始记录"}, 200)
	d = erpflow.Map(r.json["document"])
	r = f.action(f.admin, id, "approve", M{"expectedVersion": d["version"], "note": "同意办理"}, 200)
	d = erpflow.Map(r.json["document"])
	if d["status"] != "approved" || len(erpflow.Rows(d["approvals"])) != 2 {
		f.t.Fatalf("two distinct human approvals missing: %v", d)
	}
	return d
}

func boundaryProduct(f *appFixture, sku string, quantity int64) M {
	f.t.Helper()
	r := f.expect(f.send("POST", "/api/erp/masterdata", f.admin, M{"_requestId": "product-" + erpflow.ID(), "kind": "products", "record": M{"sku": sku, "name": "办公设备 " + sku, "unit": "台", "priceCents": 10000}}, nil), 201)
	p := erpflow.Map(r.json["record"])
	db, err := sql.Open("sqlite", f.a.Store.DatabasePath)
	if err != nil {
		f.t.Fatal(err)
	}
	defer db.Close()
	if _, err = db.Exec("INSERT INTO inventory(product_id,quantity) VALUES(?,?)", p["id"], quantity); err != nil {
		f.t.Fatal(err)
	}
	return p
}

func boundaryResource(project, employee, product any, operation string, original any, quantity int64) M {
	input := M{"operation": operation, "employeeId": employee, "purpose": "办公设备实际交接"}
	if operation == "return" {
		input["originalDocumentId"] = original
	}
	return M{"type": "resource", "projectId": project, "input": input, "lines": []M{{"productId": product, "quantity": quantity}}}
}

func TestHTTPBusinessPostingRolesRejectHRAndPayloadDisguises(t *testing.T) {
	f := newApp(t)
	requester, requesterCookie := f.invite("boundary-requester", []string{"employee"})
	reviewer, reviewerCookie := f.invite("boundary-reviewer", []string{"project_manager", "manager"})
	hr, hrCookie := f.invite("boundary-hr", []string{"hr"})
	p := f.project([]string{"bootstrap", erpflow.S(requester["id"]), erpflow.S(reviewer["id"]), erpflow.S(hr["id"])})
	today := time.Now().In(time.FixedZone("Asia/Shanghai", 8*3600)).Format("2006-01-02")
	for _, item := range []struct {
		typ   string
		input M
	}{
		{"project_setup", M{"objective": "交付客户办公系统"}},
		{"project_delivery", M{"deliveryNote": "交付资料已提交负责人", "acceptanceCriteria": "核对交付与签收记录"}},
		{"weekly_report", M{"periodStart": today, "periodEnd": today}},
	} {
		t.Run(item.typ, func(t *testing.T) {
			child := *f
			child.t = t
			f := &child
			d := boundaryApprove(f, boundaryWork(f, requesterCookie, M{"type": item.typ, "projectId": p["id"], "input": item.input}), reviewerCookie)
			id := erpflow.S(d["id"])
			if strings.Contains(strings.Join(erpflow.Strings(f.doc(hrCookie, id)["allowedActions"]), ","), "post") {
				t.Fatal("HR-only project member received business posting permission")
			}
			for _, action := range []string{"post", "complete"} {
				f.action(hrCookie, id, action, M{"expectedVersion": d["version"], "reference": "FORBIDDEN", "type": "onboarding", "roles": []string{"admin"}, "actorId": "bootstrap", "input": M{"employeeId": requester["id"]}}, 403)
			}
			fresh := f.doc(requesterCookie, id)
			if fresh["status"] != "approved" || fresh["version"] != d["version"] || fresh["confirmation"] != nil {
				t.Fatal("denied HTTP post changed the document")
			}
			f.action(reviewerCookie, id, "post", M{"expectedVersion": d["version"], "reference": "AUTHORIZED-" + item.typ}, 200)
		})
	}
}

func TestHTTPDisabledEmployeeCanOnlyReturnAnAuthorizedOutstandingLoan(t *testing.T) {
	f := newApp(t)
	requester, requesterCookie := f.invite("return-requester", []string{"employee", "hr"})
	reviewer, reviewerCookie := f.invite("return-reviewer", []string{"project_manager", "manager", "warehouse", "hr"})
	retiree, retireeCookie := f.invite("return-retiree", []string{"employee"})
	unrelated, _ := f.invite("return-unrelated", []string{"employee"})
	_, outsiderCookie := f.invite("return-outsider", []string{"employee"})
	p := f.project([]string{"bootstrap", erpflow.S(requester["id"]), erpflow.S(reviewer["id"]), erpflow.S(retiree["id"])})
	setup := boundaryApprove(f, boundaryWork(f, requesterCookie, M{"type": "project_setup", "projectId": p["id"], "input": M{"objective": "办公资源交接"}}), reviewerCookie)
	f.action(f.admin, erpflow.S(setup["id"]), "post", M{"expectedVersion": setup["version"], "reference": "RESOURCE-PROJECT"}, 200)
	product := boundaryProduct(f, "LOAN-DEVICE", 5)
	otherProduct := boundaryProduct(f, "OTHER-DEVICE", 0)
	issuePayload := func() M { return boundaryResource(p["id"], retiree["id"], product["id"], "issue", nil, 3) }
	issued := boundaryApprove(f, boundaryWork(f, requesterCookie, issuePayload()), reviewerCookie)
	issued = erpflow.Map(f.action(reviewerCookie, erpflow.S(issued["id"]), "post", M{"expectedVersion": issued["version"], "reference": "ISSUE-THREE"}, 200).json["document"])
	preparedIssue := boundaryApprove(f, boundaryWork(f, requesterCookie, boundaryResource(p["id"], retiree["id"], product["id"], "issue", nil, 1)), reviewerCookie)
	onboardingPayload := func() M {
		return M{"type": "onboarding", "projectId": p["id"], "input": M{"employeeId": retiree["id"], "position": "项目专员", "resourceRequirements": "办公账号和设备准备"}}
	}
	preparedOnboarding := boundaryApprove(f, boundaryWork(f, requesterCookie, onboardingPayload()), reviewerCookie)
	for _, person := range []M{retiree, unrelated} {
		f.expect(f.send("PUT", "/api/erp/users/"+erpflow.S(person["id"]), f.admin, M{"active": false}, nil), 200)
	}
	f.expect(f.send("GET", "/api/erp/snapshot", retireeCookie, nil, nil), 401)
	for _, payload := range []M{issuePayload(), onboardingPayload()} {
		payload["_requestId"] = "disabled-new-" + erpflow.ID()
		f.expect(f.send("POST", "/api/erp/workitems", requesterCookie, payload, nil), 400)
	}
	f.expect(f.send("POST", "/api/erp/tasks", f.admin, M{"_requestId": "disabled-task-" + erpflow.ID(), "projectId": p["id"], "title": "不得分派给停用员工", "assigneeId": retiree["id"]}, nil), 400)
	for _, d := range []M{preparedIssue, preparedOnboarding} {
		for _, action := range []string{"post", "complete"} {
			f.action(reviewerCookie, erpflow.S(d["id"]), action, M{"expectedVersion": d["version"], "reference": "DISABLED-POST", "type": "resource", "input": M{"operation": "return", "employeeId": requester["id"]}}, 400)
		}
		if fresh := f.doc(requesterCookie, erpflow.S(d["id"])); fresh["status"] != "approved" || fresh["version"] != d["version"] {
			t.Fatal("disable-after-approval changed the blocked document")
		}
	}

	returnPayload := func(quantity int64) M {
		return boundaryResource(p["id"], retiree["id"], product["id"], "return", issued["id"], quantity)
	}
	for _, test := range []struct {
		name, cookie string
		payload      M
		status       int
	}{
		{"outside scope", outsiderCookie, returnPayload(1), 404},
		{"over return", requesterCookie, returnPayload(4), 409},
		{"wrong employee", requesterCookie, boundaryResource(p["id"], unrelated["id"], product["id"], "return", issued["id"], 1), 409},
		{"wrong product", requesterCookie, boundaryResource(p["id"], retiree["id"], otherProduct["id"], "return", issued["id"], 1), 409},
		{"wrong project", requesterCookie, boundaryResource("", retiree["id"], product["id"], "return", issued["id"], 1), 400},
	} {
		t.Run(test.name, func(t *testing.T) {
			child := *f
			child.t = t
			f := &child
			test.payload["_requestId"] = "bad-return-" + erpflow.ID()
			f.expect(f.send("POST", "/api/erp/workitems", test.cookie, test.payload, nil), test.status)
		})
	}

	// A returned draft can be revised for the same retired employee, while a
	// disguised revision back to issue cannot create a new assignment.
	returned := boundaryWork(f, requesterCookie, returnPayload(1))
	id := erpflow.S(returned["id"])
	returned = erpflow.Map(f.action(reviewerCookie, id, "reject", M{"expectedVersion": returned["version"], "note": "核对实际归还数量"}, 200).json["document"])
	f.action(requesterCookie, id, "revise", M{"expectedVersion": returned["version"], "input": issuePayload()["input"]}, 400)
	revision := returnPayload(2)
	returned = erpflow.Map(f.action(requesterCookie, id, "revise", M{"expectedVersion": returned["version"], "input": revision["input"], "lines": revision["lines"]}, 200).json["document"])
	f.action(requesterCookie, id, "run_agents", M{"expectedVersion": returned["version"]}, 200)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if run, err := f.a.Flow.Wait(ctx, id); err != nil || run["status"] != "completed" {
		t.Fatalf("revised return did not finish: %v %v", run, err)
	}
	returned = boundaryApprove(f, f.doc(requesterCookie, id), reviewerCookie)
	f.action(reviewerCookie, id, "post", M{"expectedVersion": returned["version"], "reference": "RETURN-TWO"}, 200)
	remaining := boundaryApprove(f, boundaryWork(f, requesterCookie, returnPayload(1)), reviewerCookie)
	f.action(reviewerCookie, erpflow.S(remaining["id"]), "complete", M{"expectedVersion": remaining["version"], "reference": "RETURN-LAST"}, 200)
	full := returnPayload(1)
	full["_requestId"] = "fully-returned-" + erpflow.ID()
	f.expect(f.send("POST", "/api/erp/workitems", requesterCookie, full, nil), 409)

	directory := f.expect(f.send("GET", "/api/erp/users", requesterCookie, nil, nil), 200)
	if strings.Contains(string(directory.body), erpflow.S(retiree["id"])) || strings.Contains(string(directory.body), erpflow.S(unrelated["id"])) {
		t.Fatal("disabled employee entered the assignable directory")
	}
	snapshot := f.expect(f.send("GET", "/api/erp/snapshot", requesterCookie, nil, nil), 200)
	var historical M
	for _, user := range erpflow.Rows(snapshot.json["users"]) {
		if user["id"] == retiree["id"] {
			historical = user
		}
		if user["id"] == unrelated["id"] {
			t.Fatal("unrelated disabled employee leaked into snapshot")
		}
	}
	if len(historical) != 3 || historical["name"] != retiree["name"] || historical["active"] != false {
		t.Fatal("historical name exposed more than id/name/active=false", historical)
	}
	foundLoan, foundStock := false, false
	for _, loan := range erpflow.Rows(snapshot.json["loans"]) {
		if loan["documentId"] == issued["id"] {
			foundLoan = true
			if erpflow.N(loan["quantity"]) != 3 || erpflow.N(loan["returnedQuantity"]) != 3 {
				t.Fatal("actual loan balance changed incorrectly", loan)
			}
		}
	}
	for _, stock := range erpflow.Rows(snapshot.json["inventory"]) {
		if stock["productId"] == product["id"] {
			foundStock = true
			if erpflow.N(stock["quantity"]) != 5 {
				t.Fatal("returns or denied new issues changed the physical stock incorrectly", stock)
			}
		}
	}
	if !foundLoan || !foundStock {
		t.Fatal("actual loan or stock was not visible")
	}
}

func TestHTTPNonStockConfirmationRequiresReceiptAndPreservesIdempotency(t *testing.T) {
	f := newApp(t)
	requester, requesterCookie := f.invite("receipt-requester", []string{"employee"})
	reviewer, reviewerCookie := f.invite("receipt-reviewer", []string{"project_manager", "manager"})
	p := f.project([]string{"bootstrap", erpflow.S(requester["id"]), erpflow.S(reviewer["id"])})
	d := boundaryApprove(f, boundaryWork(f, requesterCookie, M{"type": "project_setup", "projectId": p["id"], "input": M{"objective": "凭证留存项目"}}), reviewerCookie)
	id := erpflow.S(d["id"])
	f.action(reviewerCookie, id, "complete", M{"expectedVersion": d["version"]}, 400)
	if fresh := f.doc(requesterCookie, id); fresh["version"] != d["version"] || fresh["status"] != "approved" || fresh["confirmation"] != nil {
		t.Fatal("missing receipt changed the document")
	}
	before := f.expect(f.send("GET", "/api/erp/snapshot", requesterCookie, nil, nil), 200)
	for _, project := range erpflow.Rows(before.json["projects"]) {
		if project["id"] == p["id"] && project["status"] != "draft" {
			t.Fatal("missing receipt activated a project without committing its confirmation")
		}
	}
	payload := M{"_requestId": "fixed-confirmation-" + erpflow.ID(), "expectedVersion": d["version"], "reference": "CONF-<receipt>", "note": "已核对 <script>user text</script> 原始凭证"}
	posted := erpflow.Map(f.action(reviewerCookie, id, "complete", payload, 200).json["document"])
	confirmation := erpflow.Map(posted["confirmation"])
	if confirmation["reference"] != payload["reference"] || confirmation["note"] != payload["note"] || confirmation["actorId"] != reviewer["id"] || confirmation["actorName"] != reviewer["name"] {
		t.Fatal("HTTP discarded actual confirmation facts", confirmation)
	}
	if _, err := time.Parse(time.RFC3339Nano, erpflow.S(confirmation["createdAt"])); err != nil {
		t.Fatal("confirmation omitted actual posting time", err)
	}
	original, _ := json.Marshal(confirmation)
	for _, result := range []M{erpflow.Map(f.action(reviewerCookie, id, "complete", payload, 200).json["document"]), f.doc(requesterCookie, id)} {
		actual, _ := json.Marshal(result["confirmation"])
		if string(actual) != string(original) {
			t.Fatal("replay or fresh read changed immutable confirmation")
		}
	}
	changed := erpflow.Clone(payload)
	changed["reference"] = "REPLACED"
	f.action(reviewerCookie, id, "complete", changed, 409)
	changed["_requestId"] = "second-confirmation-" + erpflow.ID()
	f.action(reviewerCookie, id, "post", changed, 409)
	snapshot := f.expect(f.send("GET", "/api/erp/snapshot", requesterCookie, nil, nil), 200)
	count := 0
	for _, event := range erpflow.Rows(snapshot.json["audit"]) {
		if event["entityId"] == d["id"] && event["action"] == "document.post" {
			count++
			detail := erpflow.Map(event["detail"])
			if detail["reference"] != payload["reference"] || detail["note"] != payload["note"] || event["actorId"] != reviewer["id"] {
				t.Fatal("audit dropped or changed receipt facts")
			}
		}
	}
	if count != 1 {
		t.Fatalf("confirmation produced %d postings instead of one", count)
	}
	report := f.expect(f.send("GET", "/api/erp/workitems/"+id+"/report", requesterCookie, nil, nil), 200)
	if !strings.Contains(string(report.body), "CONF-&lt;receipt&gt;") || !strings.Contains(string(report.body), "&lt;script&gt;user text&lt;/script&gt;") || strings.Contains(string(report.body), "<script>user text</script>") {
		t.Fatal("authorized report lost or failed to escape confirmation")
	}
}
