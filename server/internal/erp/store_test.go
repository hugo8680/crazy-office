package erp

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"sync"
	"testing"
	"time"
)

var ctx = context.Background()

func actor(id string, roles ...string) Actor { return Actor{id, id, "业务部", roles} }

var admin = actor("admin", "admin")
var employee = actor("employee", "employee")
var manager = actor("manager", "manager")
var pm = actor("pm", "project_manager")
var finance = actor("finance", "finance")
var warehouse = actor("warehouse", "warehouse")
var hr = actor("hr", "hr")
var outsider = actor("outsider", "employee")
var roles = map[string]Actor{"admin": admin, "employee": employee, "manager": manager, "project_manager": pm, "finance": finance, "warehouse": warehouse, "hr": hr}

type fixture struct {
	t          *testing.T
	s          *Store
	dir        string
	p, project map[string]any
}

func newFixture(t *testing.T, activate bool) *fixture {
	t.Helper()
	dir := t.TempDir()
	s, e := Open(dir)
	if e != nil {
		t.Fatal(e)
	}
	t.Cleanup(func() { s.Close() })
	f := &fixture{t: t, s: s, dir: dir}
	f.p = f.cmd(admin, "product.create", map[string]any{"sku": "SERVER-01", "name": "服务器", "unit": "台", "priceCents": 100000})
	f.project = f.cmd(admin, "project.create", map[string]any{"name": "客户设备项目", "customer": "客户A", "ownerId": "pm", "members": []string{"admin", "employee", "manager", "pm", "finance", "warehouse", "hr"}})
	if activate {
		f.activate()
	}
	return f
}
func (f *fixture) cmd(a Actor, action string, p map[string]any) map[string]any {
	f.t.Helper()
	r, e := f.s.Command(ctx, a, action, p, uid("key"))
	if e != nil {
		f.t.Fatalf("%s: %v", action, e)
	}
	return r
}
func (f *fixture) doc(typ string, input map[string]any, lines []any, a Actor) map[string]any {
	f.t.Helper()
	if input == nil {
		input = map[string]any{}
	}
	if lines == nil {
		lines = []any{}
	}
	return f.cmd(a, "document.create", map[string]any{"type": typ, "projectId": f.project["id"], "input": input, "lines": lines})
}
func (f *fixture) line(qty any) []any {
	return []any{map[string]any{"productId": f.p["id"], "quantity": qty}}
}
func (f *fixture) approve(d map[string]any, a Actor) map[string]any {
	f.t.Helper()
	_, e := f.s.RecordAgentResult(ctx, map[string]any{"documentId": d["id"], "runId": uid("run"), "expectedVersion": d["version"], "proposal": map[string]any{"summary": "核对草案"}, "evidence": []any{map[string]any{"agentId": "writer", "success": true}, map[string]any{"agentId": "reviewer", "success": true}}})
	if e != nil {
		f.t.Fatal(e)
	}
	d = f.cmd(a, "document.submit", map[string]any{"id": d["id"]})
	for _, stage := range stringsOf(d["approvalChain"]) {
		approver := roles[stage]
		if approver.ID == a.ID {
			approver = admin
		}
		d = f.cmd(approver, "document.approve", map[string]any{"id": d["id"], "note": "核对通过"})
	}
	return d
}
func (f *fixture) activate() {
	d := f.approve(f.doc("project_setup", map[string]any{"objective": "客户项目交付"}, nil, employee), employee)
	f.cmd(manager, "document.post", map[string]any{"id": d["id"]})
}
func (f *fixture) stock(n int64) {
	d := f.approve(f.doc("stocktake", map[string]any{"note": "实物期初清点"}, []any{map[string]any{"productId": f.p["id"], "countedQuantity": n}}, warehouse), warehouse)
	f.cmd(warehouse, "document.post", map[string]any{"id": d["id"], "reference": uid("COUNT")})
}
func (f *fixture) snapshot(a Actor) map[string]any {
	f.t.Helper()
	r, e := f.s.Snapshot(ctx, a)
	if e != nil {
		f.t.Fatal(e)
	}
	return r
}
func (f *fixture) balance() int64 {
	for _, row := range f.snapshot(admin)["inventory"].([]map[string]any) {
		if row["productId"] == f.p["id"] {
			return num(row["quantity"])
		}
	}
	return -1
}
func expectCode(t *testing.T, e error, code string) {
	t.Helper()
	var domain *Error
	if !errors.As(e, &domain) || domain.Code != code {
		t.Fatalf("want %s, got %#v", code, e)
	}
}
func reject(t *testing.T, s *Store, a Actor, action string, p map[string]any, code string) {
	t.Helper()
	_, e := s.Command(ctx, a, action, p, uid("key"))
	expectCode(t, e, code)
}
func purchase(f *fixture, n int64) map[string]any {
	return f.approve(f.doc("purchase", map[string]any{"partner": "供应商"}, f.line(n), employee), employee)
}
func receiptPayload(d map[string]any, n int64, ref string) map[string]any {
	return map[string]any{"id": d["id"], "reference": ref, "lines": []any{map[string]any{"lineId": d["lines"].([]map[string]any)[0]["id"], "quantity": n}}}
}
func rawUpdate(t *testing.T, s *Store, query string, args ...any) {
	t.Helper()
	_, e := s.transaction(ctx, func(q *ledger) map[string]any { q.exec(query, args...); return map[string]any{} })
	if e != nil {
		t.Fatal(e)
	}
}

func TestPersistencePermissionsSQLParameters(t *testing.T) {
	f := newFixture(t, false)
	info, _ := os.Stat(f.s.DatabasePath)
	if info.Mode().Perm() != 0600 {
		t.Fatal(info.Mode())
	}
	malicious := "客户'); DROP TABLE products;--"
	f.cmd(admin, "project.create", map[string]any{"name": "注入文本", "customer": malicious})
	next, e := Open(f.dir)
	if e != nil {
		t.Fatal(e)
	}
	defer next.Close()
	snap, e := next.Snapshot(ctx, admin)
	if e != nil || len(snap["products"].([]map[string]any)) != 1 {
		t.Fatal(e, snap)
	}
	if f.balance() != 0 {
		t.Fatal("unexpected stock")
	}
}
func TestIdempotentConcurrentRequestsAndConflict(t *testing.T) {
	f := newFixture(t, true)
	payload := map[string]any{"sku": "MOUSE", "name": "鼠标"}
	var a, b map[string]any
	var ea, eb error
	var wg sync.WaitGroup
	wg.Add(2)
	go func() { defer wg.Done(); a, ea = f.s.Command(ctx, admin, "product.create", payload, "same") }()
	go func() { defer wg.Done(); b, eb = f.s.Command(ctx, admin, "product.create", payload, "same") }()
	wg.Wait()
	if ea != nil || eb != nil || dump(a) != dump(b) {
		t.Fatal(ea, eb, a, b)
	}
	_, e := f.s.Command(ctx, admin, "product.create", map[string]any{"sku": "MOUSE", "name": "改名"}, "same")
	expectCode(t, e, "IDEMPOTENCY_CONFLICT")
	_, e = f.s.Command(ctx, admin, "product.create", payload, "")
	expectCode(t, e, "VALIDATION")
}
func TestAgentCapabilityCannotBeForgedByCommand(t *testing.T) {
	f := newFixture(t, true)
	d := f.doc("purchase", map[string]any{"partner": "供应商"}, f.line(1), employee)
	reject(t, f.s, employee, "document.submit", map[string]any{"id": d["id"]}, "AGENT_REQUIRED")
	reject(t, f.s, employee, "document.agent_result", map[string]any{"id": d["id"]}, "VALIDATION")
	reject(t, f.s, admin, "inventory.set", map[string]any{"quantity": 99}, "VALIDATION")
	for _, test := range []struct {
		evidence []any
		code     string
	}{{[]any{map[string]any{"agentId": "a"}, map[string]any{"agentId": "a"}}, "VALIDATION"}, {[]any{map[string]any{"agentId": "a", "success": false}, map[string]any{"agentId": "b"}}, "AGENT_INCOMPLETE"}} {
		_, e := f.s.RecordAgentResult(ctx, map[string]any{"documentId": d["id"], "runId": "one", "proposal": "草案", "evidence": test.evidence})
		expectCode(t, e, test.code)
	}
	if f.balance() != 0 {
		t.Fatal("forged stock")
	}
}
func TestApprovalSeparationEvenForAdmin(t *testing.T) {
	f := newFixture(t, true)
	d := f.doc("purchase", map[string]any{"partner": "供应商"}, f.line(1), admin)
	r, e := f.s.RecordAgentResult(ctx, map[string]any{"documentId": d["id"], "runId": "approve-run", "proposal": "方案", "evidence": []any{map[string]any{"agentId": "a"}, map[string]any{"agentId": "b"}}})
	if e != nil {
		t.Fatal(e)
	}
	d = f.cmd(admin, "document.submit", map[string]any{"id": r["id"]})
	reject(t, f.s, admin, "document.approve", map[string]any{"id": d["id"]}, "SELF_APPROVAL")
	dual := actor("dual", "manager", "finance")
	d = f.cmd(dual, "document.approve", map[string]any{"id": d["id"]})
	reject(t, f.s, dual, "document.approve", map[string]any{"id": d["id"]}, "SEPARATION_REQUIRED")
	d = f.cmd(finance, "document.approve", map[string]any{"id": d["id"]})
	if d["status"] != "approved" {
		t.Fatal(d)
	}
	reject(t, f.s, employee, "document.receive", receiptPayload(d, 1, "R"), "FORBIDDEN")
}
func TestProjectScopeRoleAndActorValidation(t *testing.T) {
	f := newFixture(t, true)
	d := f.doc("purchase", map[string]any{"partner": "供应商"}, f.line(1), employee)
	snap := f.snapshot(outsider)
	if len(snap["documents"].([]map[string]any)) != 0 || len(snap["projects"].([]map[string]any)) != 0 {
		t.Fatal(snap)
	}
	reject(t, f.s, outsider, "document.submit", map[string]any{"id": d["id"]}, "FORBIDDEN")
	reject(t, f.s, employee, "product.create", map[string]any{"sku": "x", "name": "x"}, "FORBIDDEN")
	_, e := f.s.Snapshot(ctx, Actor{})
	expectCode(t, e, "UNAUTHORIZED")
	_, e = f.s.Snapshot(ctx, actor("bad", "root"))
	expectCode(t, e, "FORBIDDEN")
	_, e = f.s.Command(ctx, outsider, "document.create", map[string]any{"type": "purchase", "projectId": f.project["id"], "input": map[string]any{"partner": "x"}, "lines": f.line(1)}, "scope")
	expectCode(t, e, "FORBIDDEN")
}
func TestPurchasePartialReceiptsAndVersion(t *testing.T) {
	f := newFixture(t, true)
	d := purchase(f, 3)
	p := receiptPayload(d, 1, "ARRIVAL-1")
	d = f.cmd(warehouse, "document.receive", p)
	if d["status"] != "partially_received" {
		t.Fatal(d)
	}
	reject(t, f.s, warehouse, "document.receive", p, "DUPLICATE_RECEIPT")
	reject(t, f.s, warehouse, "document.receive", receiptPayload(d, 3, "OVER"), "OVER_FULFILMENT")
	p = receiptPayload(d, 2, "ARRIVAL-2")
	p["version"] = 1
	reject(t, f.s, warehouse, "document.receive", p, "VERSION_CONFLICT")
	delete(p, "version")
	d = f.cmd(warehouse, "document.receive", p)
	if d["status"] != "completed" || f.balance() != 3 {
		t.Fatal(d)
	}
	if len(f.snapshot(admin)["movements"].([]map[string]any)) != 2 {
		t.Fatal("movement count")
	}
}
func TestSalesRollbackAcrossLinesAndNegativeStock(t *testing.T) {
	f := newFixture(t, true)
	f.stock(3)
	other := f.cmd(admin, "product.create", map[string]any{"sku": "EMPTY", "name": "空产品"})
	d := f.approve(f.doc("sales", map[string]any{"partner": "客户"}, append(f.line(3), map[string]any{"productId": other["id"], "quantity": 1}), employee), employee)
	lines := []any{}
	for _, l := range d["lines"].([]map[string]any) {
		lines = append(lines, map[string]any{"lineId": l["id"], "quantity": 1})
	}
	reject(t, f.s, warehouse, "document.ship", map[string]any{"id": d["id"], "reference": "FAIL", "lines": lines}, "STOCK_SHORTAGE")
	if f.balance() != 3 {
		t.Fatal("partial transaction")
	}
	snap := f.snapshot(admin)
	for _, m := range snap["movements"].([]map[string]any) {
		if m["kind"] == "ship" {
			t.Fatal("rollback missing")
		}
	}
	d = f.cmd(warehouse, "document.ship", receiptPayload(d, 2, "SHIP-1"))
	if d["status"] != "partially_shipped" || f.balance() != 1 {
		t.Fatal(d)
	}
}
func TestConcurrentSalesAcrossStoreConnections(t *testing.T) {
	f := newFixture(t, true)
	f.stock(1)
	a := f.approve(f.doc("sales", map[string]any{"partner": "客户A"}, f.line(1), employee), employee)
	b := f.approve(f.doc("sales", map[string]any{"partner": "客户B"}, f.line(1), employee), employee)
	second, e := Open(f.dir)
	if e != nil {
		t.Fatal(e)
	}
	defer second.Close()
	errs := make(chan error, 2)
	for i, store := range []*Store{f.s, second} {
		d := []map[string]any{a, b}[i]
		go func(s *Store, d map[string]any) {
			_, e := s.Command(ctx, warehouse, "document.ship", receiptPayload(d, 1, uid("SHIP")), uid("K"))
			errs <- e
		}(store, d)
	}
	success, shortage := 0, 0
	for i := 0; i < 2; i++ {
		e := <-errs
		if e == nil {
			success++
		} else {
			var domain *Error
			if errors.As(e, &domain) && domain.Code == "STOCK_SHORTAGE" {
				shortage++
			} else {
				t.Fatal(e)
			}
		}
	}
	if success != 1 || shortage != 1 || f.balance() != 0 {
		t.Fatal(success, shortage, f.balance())
	}
}
func TestStaleStocktakeRequiresRevisionEvenWhenBalanceRestored(t *testing.T) {
	f := newFixture(t, true)
	f.stock(3)
	count := f.approve(f.doc("stocktake", map[string]any{"note": "实物清点"}, []any{map[string]any{"productId": f.p["id"], "countedQuantity": 2}}, warehouse), warehouse)
	issue := f.approve(f.doc("resource", map[string]any{"operation": "issue", "employeeId": "employee", "purpose": "使用"}, f.line(1), employee), employee)
	issue = f.cmd(warehouse, "document.post", map[string]any{"id": issue["id"], "reference": "BORROW"})
	ret := f.approve(f.doc("resource", map[string]any{"operation": "return", "employeeId": "employee", "purpose": "归还", "originalDocumentId": issue["id"]}, f.line(1), employee), employee)
	f.cmd(warehouse, "document.post", map[string]any{"id": ret["id"], "reference": "BACK"})
	if f.balance() != 3 {
		t.Fatal("balance")
	}
	reject(t, f.s, warehouse, "document.post", map[string]any{"id": count["id"], "reference": "OLD"}, "STALE_STOCKTAKE")
	f.stock(0)
	if f.balance() != 0 {
		t.Fatal("zero count")
	}
}
func TestResourcePartialReturnsAndOverReturn(t *testing.T) {
	f := newFixture(t, true)
	f.stock(4)
	issue := f.approve(f.doc("resource", map[string]any{"operation": "issue", "employeeId": "employee", "purpose": "项目测试"}, f.line(3), employee), employee)
	issue = f.cmd(warehouse, "document.post", map[string]any{"id": issue["id"], "reference": "ISSUE"})
	returnDoc := func(n int64) map[string]any {
		return f.approve(f.doc("resource", map[string]any{"operation": "return", "employeeId": "employee", "purpose": "归还设备", "originalDocumentId": issue["id"]}, f.line(n), employee), employee)
	}
	first := returnDoc(1)
	f.cmd(warehouse, "document.post", map[string]any{"id": first["id"], "reference": "BACK1"})
	a, b := returnDoc(2), returnDoc(2)
	f.cmd(warehouse, "document.post", map[string]any{"id": a["id"], "reference": "BACK2"})
	reject(t, f.s, warehouse, "document.post", map[string]any{"id": b["id"], "reference": "BACK3"}, "OVER_RETURN")
	if f.balance() != 4 {
		t.Fatal("return balance")
	}
	loans := f.snapshot(admin)["loans"].([]map[string]any)
	if num(loans[0]["returnedQuantity"]) != 3 {
		t.Fatal(loans)
	}
	_, e := f.s.Command(ctx, employee, "document.create", map[string]any{"type": "resource", "projectId": f.project["id"], "input": map[string]any{"operation": "return", "employeeId": "finance", "purpose": "错误员工", "originalDocumentId": issue["id"]}, "lines": f.line(1)}, uid("k"))
	expectCode(t, e, "VALIDATION")
}
func TestAllEightWorkflowsTasksAndContribution(t *testing.T) {
	f := newFixture(t, false)
	f.activate()
	task := f.cmd(pm, "task.create", map[string]any{"projectId": f.project["id"], "title": "设备清单", "assigneeId": "employee"})
	reject(t, f.s, manager, "task.complete", map[string]any{"id": task["id"], "result": "替他交付"}, "FORBIDDEN")
	task = f.cmd(employee, "task.complete", map[string]any{"id": task["id"], "result": "规格核对完成", "evidence": []any{map[string]any{"reference": "LIST-1"}}})
	if task["status"] != "submitted" {
		t.Fatal(task)
	}
	task = f.cmd(pm, "task.accept", map[string]any{"id": task["id"]})
	if task["status"] != "completed" {
		t.Fatal(task)
	}
	delivery := f.approve(f.doc("project_delivery", map[string]any{"acceptanceCriteria": "规格一致", "deliveryNote": "清单已交付"}, nil, employee), employee)
	f.cmd(pm, "document.post", map[string]any{"id": delivery["id"]})
	today := time.Now().In(time.FixedZone("CN", 28800)).Format("2006-01-02")
	weekly := f.doc("weekly_report", map[string]any{"periodStart": today, "periodEnd": today}, nil, employee)
	facts := obj(obj(weekly["input"])["facts"])
	if num(facts["completedTasks"]) != 1 || facts["scoresAssigned"] != false {
		t.Fatal(facts)
	}
	weekly = f.approve(weekly, employee)
	f.cmd(manager, "document.post", map[string]any{"id": weekly["id"]})
	onboard := f.approve(f.doc("onboarding", map[string]any{"employeeId": "employee", "position": "项目专员", "resourceRequirements": "资料权限待办"}, nil, hr), hr)
	onboard = f.cmd(hr, "document.post", map[string]any{"id": onboard["id"]})
	if onboard["status"] != "completed" {
		t.Fatal(onboard)
	}
	if len(f.snapshot(admin)["performance"].([]map[string]any)) != 1 {
		t.Fatal("no contribution")
	}
}
func TestRejectRevisePreservesHistoryAndRequiresNewAgents(t *testing.T) {
	f := newFixture(t, true)
	d := f.doc("purchase", map[string]any{"partner": "供应商A"}, f.line(2), employee)
	run := map[string]any{"documentId": d["id"], "runId": "original-run", "expectedVersion": d["version"], "proposal": "原方案", "evidence": []any{map[string]any{"agentId": "writer"}, map[string]any{"agentId": "reviewer"}}}
	_, e := f.s.RecordAgentResult(ctx, run)
	if e != nil {
		t.Fatal(e)
	}
	d = f.cmd(employee, "document.submit", map[string]any{"id": d["id"]})
	d = f.cmd(manager, "document.approve", map[string]any{"id": d["id"]})
	reject(t, f.s, finance, "document.reject", map[string]any{"id": d["id"]}, "VALIDATION")
	d = f.cmd(finance, "document.reject", map[string]any{"id": d["id"], "note": "减少数量"})
	_, e = f.s.RecordAgentResult(ctx, run)
	expectCode(t, e, "STATE_CONFLICT")
	oldVersion := d["version"]
	d = f.cmd(employee, "document.revise", map[string]any{"id": d["id"], "version": d["version"], "input": map[string]any{"partner": "供应商B"}, "lines": f.line(1)})
	if d["status"] != "draft" || num(d["approvalRound"]) != 2 || d["proposal"] != nil || d["agentRunId"] != nil || len(d["approvals"].([]map[string]any)) != 0 || len(d["approvalHistory"].([]map[string]any)) != 2 {
		t.Fatal(d)
	}
	if num(d["revisions"].([]map[string]any)[0]["version"]) != num(oldVersion) {
		t.Fatal("revision version")
	}
	run["expectedVersion"] = d["version"]
	_, e = f.s.RecordAgentResult(ctx, run)
	expectCode(t, e, "AGENT_STALE")
	run["runId"] = "stale-version"
	run["expectedVersion"] = 1
	_, e = f.s.RecordAgentResult(ctx, run)
	expectCode(t, e, "VERSION_CONFLICT")
	reject(t, f.s, employee, "document.submit", map[string]any{"id": d["id"]}, "AGENT_REQUIRED")
	d = f.approve(d, employee)
	if len(d["approvalHistory"].([]map[string]any)) != 4 {
		t.Fatal("historical approvals")
	}
}
func TestRevisePermissionsProjectAndStateProtection(t *testing.T) {
	f := newFixture(t, true)
	d := f.doc("purchase", map[string]any{"partner": "供应商"}, f.line(1), employee)
	reject(t, f.s, manager, "document.revise", map[string]any{"id": d["id"], "title": "越权"}, "FORBIDDEN")
	reject(t, f.s, employee, "document.revise", map[string]any{"id": d["id"], "projectId": nil}, "VALIDATION")
	reject(t, f.s, employee, "document.revise", map[string]any{"id": d["id"], "type": "sales"}, "VALIDATION")
	d = f.cmd(admin, "document.revise", map[string]any{"id": d["id"], "title": "更正"})
	d = f.approve(d, employee)
	reject(t, f.s, admin, "document.revise", map[string]any{"id": d["id"], "title": "批准后更改"}, "STATE_CONFLICT")
	d = f.cmd(warehouse, "document.receive", receiptPayload(d, 1, "R"))
	reject(t, f.s, admin, "document.revise", map[string]any{"id": d["id"]}, "STATE_CONFLICT")
}
func TestValidationIntegersAmountsDatesAndDuplicateLines(t *testing.T) {
	f := newFixture(t, true)
	for _, n := range []any{0, -1, 1.2, true, "1", nil} {
		reject(t, f.s, employee, "document.create", map[string]any{"type": "purchase", "projectId": f.project["id"], "input": map[string]any{"partner": "供应商"}, "lines": f.line(n)}, "VALIDATION")
	}
	reject(t, f.s, admin, "product.create", map[string]any{"sku": "SERVER-01", "name": "重复"}, "CONSTRAINT")
	reject(t, f.s, employee, "document.create", map[string]any{"type": "weekly_report", "projectId": f.project["id"], "input": map[string]any{"periodStart": "2026-02-30", "periodEnd": "2026-03-01"}}, "VALIDATION")
	reject(t, f.s, employee, "document.create", map[string]any{"type": "purchase", "input": map[string]any{"partner": "供应商"}, "lines": append(f.line(1), f.line(1)...)}, "VALIDATION")
	reject(t, f.s, employee, "document.create", map[string]any{"type": "onboarding", "input": map[string]any{"employeeId": "e", "position": "p", "resourceRequirements": "r"}}, "FORBIDDEN")
	for _, price := range []any{1.2, true, -1} {
		reject(t, f.s, employee, "document.create", map[string]any{"type": "purchase", "input": map[string]any{"partner": "供应商"}, "lines": []any{map[string]any{"productId": f.p["id"], "quantity": 1, "unitPriceCents": price}}}, "VALIDATION")
	}
	reject(t, f.s, employee, "document.create", map[string]any{"type": "purchase", "input": map[string]any{"partner": "供应商"}, "lines": []any{map[string]any{"productId": f.p["id"], "quantity": 1000000000, "unitPriceCents": 1000000000000}}}, "VALIDATION")
}
func TestTaskSubmissionIndependentAcceptanceReturnHistory(t *testing.T) {
	f := newFixture(t, true)
	task := f.cmd(pm, "task.create", map[string]any{"projectId": f.project["id"], "title": "配置清单", "assigneeId": "employee"})
	reject(t, f.s, employee, "task.complete", map[string]any{"id": task["id"], "result": "做完"}, "VALIDATION")
	task = f.cmd(employee, "task.complete", map[string]any{"id": task["id"], "result": "初稿", "evidence": []any{map[string]any{"reference": "DRAFT"}}})
	reject(t, f.s, employee, "task.accept", map[string]any{"id": task["id"]}, "SELF_APPROVAL")
	today := businessDate(now())
	r := f.doc("weekly_report", map[string]any{"periodStart": today, "periodEnd": today}, nil, employee)
	if num(obj(obj(r["input"])["facts"])["completedTasks"]) != 0 {
		t.Fatal("self completion counted")
	}
	task = f.cmd(pm, "task.return", map[string]any{"id": task["id"], "note": "补充"})
	task = f.cmd(employee, "task.complete", map[string]any{"id": task["id"], "result": "补充完成", "evidence": []any{map[string]any{"reference": "FINAL"}}})
	task = f.cmd(pm, "task.accept", map[string]any{"id": task["id"]})
	if task["acceptedBy"] != "pm" || len(task["history"].([]map[string]any)) != 4 {
		t.Fatal(task)
	}
}
func TestBeijingDatesAndHistoricalPeriodEnd(t *testing.T) {
	f := newFixture(t, true)
	task := f.cmd(pm, "task.create", map[string]any{"projectId": f.project["id"], "title": "跨期验收", "assigneeId": "employee", "dueDate": "2026-10-20"})
	f.cmd(employee, "task.complete", map[string]any{"id": task["id"], "result": "交付", "evidence": []any{map[string]any{"reference": "CROSS"}}})
	f.cmd(pm, "task.accept", map[string]any{"id": task["id"]})
	rawUpdate(t, f.s, "UPDATE tasks SET created_at=?,submitted_at=?,completed_at=? WHERE id=?", "2026-10-19T16:00:00.000Z", "2026-10-20T15:59:00.000Z", "2026-10-20T16:00:00.000Z", task["id"])
	rawUpdate(t, f.s, "UPDATE task_events SET created_at=? WHERE task_id=? AND action='submitted'", "2026-10-20T15:59:00.000Z", task["id"])
	rawUpdate(t, f.s, "UPDATE task_events SET created_at=? WHERE task_id=? AND action='accepted'", "2026-10-20T16:00:00.000Z", task["id"])
	facts := func(day string) map[string]any {
		r := f.doc("weekly_report", map[string]any{"periodStart": day, "periodEnd": day}, nil, employee)
		return obj(obj(r["input"])["facts"])
	}
	before, after := facts("2026-10-20"), facts("2026-10-21")
	if num(before["completedTasks"]) != 0 || num(before["pendingTasks"]) != 1 || num(before["overdueTasks"]) != 1 || num(before["submittedTasks"]) != 1 {
		t.Fatal(before)
	}
	if num(after["completedTasks"]) != 1 || num(after["pendingTasks"]) != 0 || num(after["overdueTasks"]) != 0 || num(after["submittedTasks"]) != 0 {
		t.Fatal(after)
	}
	if businessDate("2026-10-19T15:59:59.000Z") != "2026-10-19" || businessDate("2026-10-19T16:00:00.000Z") != "2026-10-20" {
		t.Fatal("Beijing boundary")
	}
}
func TestDraftProjectPreventsRealStockAndAcceptance(t *testing.T) {
	f := newFixture(t, false)
	p := purchase(f, 1)
	reject(t, f.s, warehouse, "document.receive", receiptPayload(p, 1, "PRE"), "PROJECT_NOT_ACTIVE")
	task := f.cmd(pm, "task.create", map[string]any{"projectId": f.project["id"], "title": "准备", "assigneeId": "employee"})
	f.cmd(employee, "task.complete", map[string]any{"id": task["id"], "result": "已备", "evidence": []any{map[string]any{"reference": "PREP"}}})
	reject(t, f.s, pm, "task.accept", map[string]any{"id": task["id"]}, "PROJECT_NOT_ACTIVE")
	f.activate()
	f.cmd(warehouse, "document.receive", receiptPayload(p, 1, "ACTIVE"))
	f.cmd(pm, "task.accept", map[string]any{"id": task["id"]})
}
func TestBackupWALRestoreIntegrityAndNoOverwrite(t *testing.T) {
	f := newFixture(t, true)
	f.stock(7)
	wal, e := sql.Open("sqlite", f.s.DatabasePath)
	if e != nil {
		t.Fatal(e)
	}
	defer wal.Close()
	_, e = wal.Exec("PRAGMA journal_mode=WAL")
	if e != nil {
		t.Fatal(e)
	}
	_, e = wal.Exec("INSERT INTO products VALUES(?,?,?,?,?,?)", "WAL-PRODUCT", "WAL-ONLY", "WAL已提交产品", "件", 0, "2026-10-20T00:00:00Z")
	if e != nil {
		t.Fatal(e)
	}
	before := f.snapshot(admin)
	dest := filepath.Join(f.dir, "backups", "isolated.sqlite")
	backup, e := f.s.Backup(ctx, admin, dest)
	if e != nil {
		t.Fatal(e)
	}
	data, e := os.ReadFile(dest)
	if e != nil {
		t.Fatal(e)
	}
	digest := sha256.Sum256(data)
	if backup["sha256"] != hex.EncodeToString(digest[:]) {
		t.Fatal(backup)
	}
	info, _ := os.Stat(dest)
	if info.Mode().Perm() != 0600 {
		t.Fatal(info.Mode())
	}
	restore := t.TempDir()
	os.Mkdir(filepath.Join(restore, "erp"), 0700)
	if e = os.WriteFile(filepath.Join(restore, "erp", "office-erp.sqlite"), data, 0600); e != nil {
		t.Fatal(e)
	}
	restored, e := Open(restore)
	if e != nil {
		t.Fatal(e)
	}
	defer restored.Close()
	snap, e := restored.Snapshot(ctx, admin)
	if e != nil {
		t.Fatal(e)
	}
	for _, key := range []string{"inventory", "movements", "products", "audit"} {
		if dump(snap[key]) != dump(before[key]) {
			t.Fatalf("restore %s mismatch", key)
		}
	}
	if e = restored.IntegrityCheck(ctx); e != nil {
		t.Fatal(e)
	}
	_, e = f.s.Backup(ctx, admin, dest)
	expectCode(t, e, "BACKUP_EXISTS")
	after, _ := os.ReadFile(dest)
	if !reflect.DeepEqual(data, after) {
		t.Fatal("overwritten backup")
	}
}
func TestBackupScopePermissionsSymlinks(t *testing.T) {
	f := newFixture(t, true)
	for _, dest := range []string{filepath.Join(f.dir, "outside.sqlite"), filepath.Join(f.dir, "backups", "..", "outside.sqlite"), filepath.Join(f.dir, "backups", "invalid.zip")} {
		_, e := f.s.Backup(ctx, admin, dest)
		expectCode(t, e, "FORBIDDEN")
	}
	dest := filepath.Join(f.dir, "backups", "unauthorized.sqlite")
	_, e := f.s.Backup(ctx, employee, dest)
	expectCode(t, e, "FORBIDDEN")
	if _, e = os.Stat(dest); !os.IsNotExist(e) {
		t.Fatal("unauthorized file created")
	}
	outside := t.TempDir()
	os.RemoveAll(filepath.Join(f.dir, "backups"))
	if e = os.Symlink(outside, filepath.Join(f.dir, "backups")); e != nil {
		t.Fatal(e)
	}
	_, e = f.s.Backup(ctx, admin, filepath.Join(f.dir, "backups", "symlink.sqlite"))
	expectCode(t, e, "FORBIDDEN")
	entries, _ := os.ReadDir(outside)
	if len(entries) != 0 {
		t.Fatal(entries)
	}
}
func TestProjectUpdateOwnerMembershipAndDepartment(t *testing.T) {
	f := newFixture(t, true)
	reject(t, f.s, employee, "project.update", map[string]any{"id": f.project["id"], "name": "越权"}, "FORBIDDEN")
	reject(t, f.s, outsider, "project.update", map[string]any{"id": f.project["id"]}, "FORBIDDEN")
	reject(t, f.s, pm, "project.update", map[string]any{"id": f.project["id"], "ownerId": "outsider"}, "VALIDATION")
	reject(t, f.s, pm, "project.update", map[string]any{"id": f.project["id"], "department": "其他"}, "FORBIDDEN")
	updated := f.cmd(pm, "project.update", map[string]any{"id": f.project["id"], "ownerId": "manager", "name": "更正项目", "customer": "客户B"})
	if updated["ownerId"] != "manager" || updated["status"] != "active" {
		t.Fatal(updated)
	}
	moved := f.cmd(admin, "project.update", map[string]any{"id": f.project["id"], "department": "公司项目部"})
	if moved["department"] != "公司项目部" {
		t.Fatal(moved)
	}
}
func TestReassignPreservesHistoryAndPreventsInheritedDelivery(t *testing.T) {
	f := newFixture(t, true)
	task := f.cmd(pm, "task.create", map[string]any{"projectId": f.project["id"], "title": "转交设备清单", "assigneeId": "employee"})
	reject(t, f.s, employee, "task.reassign", map[string]any{"id": task["id"], "assigneeId": "finance", "note": "自己转交"}, "FORBIDDEN")
	reject(t, f.s, pm, "task.reassign", map[string]any{"id": task["id"], "assigneeId": "outsider", "note": "跨项目"}, "FORBIDDEN")
	reject(t, f.s, pm, "task.reassign", map[string]any{"id": task["id"], "assigneeId": "finance"}, "VALIDATION")
	members := []string{"admin", "manager", "pm", "finance", "warehouse", "hr"}
	reject(t, f.s, pm, "project.update", map[string]any{"id": f.project["id"], "members": members}, "OPEN_TASKS")
	task = f.cmd(employee, "task.complete", map[string]any{"id": task["id"], "result": "旧负责人初稿", "evidence": []any{map[string]any{"reference": "OLD"}}})
	reject(t, f.s, pm, "task.reassign", map[string]any{"id": task["id"], "assigneeId": "finance", "note": "待验收"}, "STATE_CONFLICT")
	f.cmd(pm, "task.return", map[string]any{"id": task["id"], "note": "离岗退回"})
	task = f.cmd(pm, "task.reassign", map[string]any{"id": task["id"], "assigneeId": "finance", "note": "离岗接手"})
	if task["result"] != "" || task["submittedAt"] != nil || len(list(task["evidence"])) != 0 || task["assigneeId"] != "finance" {
		t.Fatal(task)
	}
	history := task["history"].([]map[string]any)
	detail := obj(list(history[len(history)-1]["evidence"])[0])
	if obj(detail["before"])["result"] != "旧负责人初稿" {
		t.Fatal(detail)
	}
	reject(t, f.s, employee, "task.complete", map[string]any{"id": task["id"], "result": "旧员工再次提交", "evidence": []any{map[string]any{"reference": "OLD2"}}}, "FORBIDDEN")
	f.cmd(pm, "project.update", map[string]any{"id": f.project["id"], "members": members})
	f.cmd(finance, "task.complete", map[string]any{"id": task["id"], "result": "新交付", "evidence": []any{map[string]any{"reference": "NEW"}}})
	task = f.cmd(pm, "task.accept", map[string]any{"id": task["id"]})
	reject(t, f.s, admin, "task.reassign", map[string]any{"id": task["id"], "assigneeId": "warehouse", "note": "改写归属"}, "STATE_CONFLICT")
}
func TestStocktakeReasonRequiredOnCreateAndRevise(t *testing.T) {
	f := newFixture(t, true)
	payload := map[string]any{"type": "stocktake", "projectId": f.project["id"], "input": map[string]any{}, "lines": []any{map[string]any{"productId": f.p["id"], "countedQuantity": 0}}}
	reject(t, f.s, warehouse, "document.create", payload, "VALIDATION")
	payload["input"] = map[string]any{"note": "季度实物复核"}
	d := f.cmd(warehouse, "document.create", payload)
	reject(t, f.s, warehouse, "document.revise", map[string]any{"id": d["id"], "input": map[string]any{"note": "  "}}, "VALIDATION")
	if num(f.snapshot(admin)["documents"].([]map[string]any)[0]["version"]) != num(d["version"]) {
		t.Fatal("invalid revision committed")
	}
}
func TestResourcePurposeAndCompletedOnboardingSource(t *testing.T) {
	f := newFixture(t, true)
	input := map[string]any{"operation": "issue", "employeeId": "employee"}
	payload := map[string]any{"type": "resource", "projectId": f.project["id"], "input": input, "lines": f.line(1)}
	reject(t, f.s, employee, "document.create", payload, "VALIDATION")
	source := f.doc("onboarding", map[string]any{"employeeId": "employee", "position": "专员", "resourceRequirements": "设备及权限准备"}, nil, hr)
	input["purpose"] = "客户项目联调"
	input["sourceOnboardingDocumentId"] = source["id"]
	reject(t, f.s, employee, "document.create", payload, "INVALID_SOURCE")
	source = f.approve(source, hr)
	f.cmd(hr, "document.post", map[string]any{"id": source["id"]})
	issue := f.cmd(employee, "document.create", payload)
	if obj(issue["input"])["sourceOnboardingDocumentId"] != source["id"] {
		t.Fatal(issue)
	}
	input["employeeId"] = "finance"
	reject(t, f.s, employee, "document.create", payload, "INVALID_SOURCE")
	input["employeeId"] = "employee"
	input["sourceOnboardingDocumentId"] = "missing"
	reject(t, f.s, employee, "document.create", payload, "NOT_FOUND")
	reject(t, f.s, employee, "document.revise", map[string]any{"id": issue["id"], "input": map[string]any{"operation": "issue", "employeeId": "employee", "purpose": " "}}, "VALIDATION")
}
func TestContributionFactualMetricsAndFrozenReport(t *testing.T) {
	f := newFixture(t, true)
	today := businessDate(now())
	tomorrow := time.Now().Add(24 * time.Hour).In(time.FixedZone("CN", 28800)).Format("2006-01-02")
	create := func(title, assignee, due string) map[string]any {
		return f.cmd(pm, "task.create", map[string]any{"projectId": f.project["id"], "title": title, "assigneeId": assignee, "dueDate": due})
	}
	submit := func(a Actor, d map[string]any) {
		f.cmd(a, "task.complete", map[string]any{"id": d["id"], "result": "真实交付", "evidence": []any{map[string]any{"reference": uid("REF")}}})
	}
	a := create("已验收", "employee", today)
	submit(employee, a)
	f.cmd(pm, "task.accept", map[string]any{"id": a["id"]})
	b := create("重复提交待验收", "employee", today)
	submit(employee, b)
	f.cmd(pm, "task.return", map[string]any{"id": b["id"], "note": "补充资料"})
	submit(employee, b)
	create("未到期", "finance", tomorrow)
	delivery := f.approve(f.doc("project_delivery", map[string]any{"acceptanceCriteria": "已核对清单", "deliveryNote": "清单引用 REF"}, nil, employee), employee)
	f.cmd(pm, "document.post", map[string]any{"id": delivery["id"]})
	unconfirmed := f.approve(f.doc("sales", map[string]any{"partner": "未发货客户"}, f.line(1), employee), employee)
	report := f.doc("weekly_report", map[string]any{"periodStart": today, "periodEnd": today}, nil, employee)
	facts := obj(obj(report["input"])["facts"])
	for key, want := range map[string]int64{"assignedTasks": 3, "submittedTasks": 2, "completedTasks": 1, "pendingTasks": 2, "overdueTasks": 1, "acceptedDeliveries": 1} {
		if num(facts[key]) != want {
			t.Fatalf("%s: %s", key, dump(facts))
		}
	}
	for _, value := range list(facts["employees"]) {
		raw := obj(value)
		if raw["employeeId"] == "employee" {
			if num(raw["submittedTasks"]) != 2 || num(raw["completedTasks"]) != 1 || !has(stringsOf(raw["acceptedDeliveryIds"]), str(delivery["id"])) || has(stringsOf(raw["businessDocumentIds"]), str(unconfirmed["id"])) {
				t.Fatal(raw)
			}
		}
	}
	frozen := dump(facts)
	f.cmd(pm, "task.accept", map[string]any{"id": b["id"]})
	report = f.approve(report, employee)
	f.cmd(manager, "document.post", map[string]any{"id": report["id"]})
	perf := f.snapshot(admin)["performance"].([]map[string]any)[0]
	if dump(perf["facts"]) != frozen {
		t.Fatal("frozen facts changed")
	}
	if facts["scoresAssigned"] != false || facts["workHours"] != nil {
		t.Fatal("invented performance")
	}
}
func TestHumanQuotationEvidencePreservedAndRevisionInvalidatesDraft(t *testing.T) {
	f := newFixture(t, true)
	d := f.doc("purchase", map[string]any{"partner": "正式供应商", "quotationReference": "SUPPLIER-001", "quotationNotes": "含税，运费到付，三年保修"}, f.line(2), employee)
	if obj(d["input"])["quotationReference"] != "SUPPLIER-001" || d["agentRunId"] != nil || len(list(d["evidence"])) != 0 {
		t.Fatal(d)
	}
	d = f.cmd(employee, "document.revise", map[string]any{"id": d["id"], "input": map[string]any{"partner": "正式供应商", "quotationReference": "https://supplier.example.test/quote?id=1", "quotationNotes": "更新为含税包运费，仍核对原件"}})
	if !strings.Contains(str(obj(d["input"])["quotationNotes"]), "包运费") || d["proposal"] != nil {
		t.Fatal(d)
	}
	reject(t, f.s, employee, "document.create", map[string]any{"type": "purchase", "input": map[string]any{"partner": "供应商", "quotationReference": strings.Repeat("x", 1001)}, "lines": f.line(1)}, "VALIDATION")
	reject(t, f.s, employee, "document.create", map[string]any{"type": "purchase", "input": map[string]any{"partner": "供应商", "quotationNotes": strings.Repeat("x", 4001)}, "lines": f.line(1)}, "VALIDATION")
}
func TestAllowedActionsRealTaskResponses(t *testing.T) {
	f := newFixture(t, true)
	task := f.cmd(pm, "task.create", map[string]any{"projectId": f.project["id"], "title": "真实任务", "assigneeId": "employee"})
	if dump(task["allowedActions"]) != `["reassign"]` {
		t.Fatal(task)
	}
	snap := f.snapshot(employee)
	task = snap["tasks"].([]map[string]any)[0]
	if dump(task["allowedActions"]) != `["complete"]` {
		t.Fatal(task)
	}
	task = f.cmd(employee, "task.complete", map[string]any{"id": task["id"], "result": "交付内容", "evidence": []any{map[string]any{"reference": "TASK-1"}}})
	if len(stringsOf(task["allowedActions"])) != 0 {
		t.Fatal(task)
	}
	task = f.snapshot(pm)["tasks"].([]map[string]any)[0]
	if dump(task["allowedActions"]) != `["accept","return"]` {
		t.Fatal(task)
	}
	task = f.cmd(pm, "task.accept", map[string]any{"id": task["id"]})
	if task["acceptedBy"] != "pm" || len(stringsOf(task["allowedActions"])) != 0 {
		t.Fatal(task)
	}
}
func TestExistingSchemaMigrationPreservesLegacyData(t *testing.T) {
	f := newFixture(t, true)
	task := f.cmd(pm, "task.create", map[string]any{"projectId": f.project["id"], "title": "旧版自报完成", "assigneeId": "employee"})
	rawUpdate(t, f.s, "UPDATE tasks SET status='completed',completed_at='2026-10-19T15:59:59.000Z',accepted_by=NULL WHERE id=?", task["id"])
	next, e := Open(f.dir)
	if e != nil {
		t.Fatal(e)
	}
	defer next.Close()
	snap, e := next.Snapshot(ctx, admin)
	if e != nil {
		t.Fatal(e)
	}
	for _, r := range snap["tasks"].([]map[string]any) {
		if r["id"] == task["id"] {
			if r["status"] != "submitted" || r["completedAt"] != nil || r["submittedAt"] != "2026-10-19T15:59:59.000Z" {
				t.Fatal(r)
			}
		}
	}
	if e = next.IntegrityCheck(ctx); e != nil {
		t.Fatal(e)
	}
}
func TestJSONNumbersAndShapeValidation(t *testing.T) {
	f := newFixture(t, true)
	var p map[string]any
	if e := json.Unmarshal([]byte(`{"type":"purchase","input":{"partner":"HTTP供应商"},"lines":[{"productId":"ID","quantity":1,"unitPriceCents":98999}]}`), &p); e != nil {
		t.Fatal(e)
	}
	obj(list(p["lines"])[0])["productId"] = f.p["id"]
	d := f.cmd(employee, "document.create", p)
	if num(d["lines"].([]map[string]any)[0]["unitPriceCents"]) != 98999 {
		t.Fatal(d)
	}
	for _, bad := range []any{true, "x", 12, map[string]any{}} {
		payload := map[string]any{"type": "purchase", "input": map[string]any{"partner": "供应商"}, "lines": bad}
		reject(t, f.s, employee, "document.create", payload, "VALIDATION")
	}
	reject(t, f.s, employee, "document.create", map[string]any{"type": "purchase", "input": []any{}, "lines": f.line(1)}, "VALIDATION")
}
func TestUpgradeOlderColumnsAndLegacyAgentEvidence(t *testing.T) {
	dir := t.TempDir()
	os.MkdirAll(filepath.Join(dir, "erp"), 0700)
	db, e := sql.Open("sqlite", filepath.Join(dir, "erp", "office-erp.sqlite"))
	if e != nil {
		t.Fatal(e)
	}
	old := strings.Replace(schema, ",system_movement_id TEXT NOT NULL DEFAULT ''", "", 1)
	old = strings.Replace(old, ",approval_round INTEGER NOT NULL DEFAULT 1", "", 1)
	old = strings.Replace(old, ",round INTEGER NOT NULL DEFAULT 1", "", 1)
	old = strings.Replace(old, ",submitted_at TEXT,accepted_by TEXT", "", 1)
	if _, e = db.Exec(old); e != nil {
		t.Fatal(e)
	}
	_, e = db.Exec("INSERT INTO projects VALUES(?,?,?,?,?,?,?,?)", "old-project", "旧项目", "客户", "pm", "业务部", `["employee","pm"]`, "active", now())
	if e != nil {
		t.Fatal(e)
	}
	_, e = db.Exec("INSERT INTO documents VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)", "old-doc", "purchase", "旧采购", "old-project", "employee", "业务部", "draft", 1, `{"partner":"供应商","expectedDate":""}`, `{"summary":"原协作"}`, `[{"agentId":"a"},{"agentId":"b"}]`, "old-agent-run", 0, now(), now())
	if e != nil {
		t.Fatal(e)
	}
	_, e = db.Exec("INSERT INTO tasks VALUES(?,?,?,?,?,?,?,?,?,?,?)", "old-task", "old-project", "旧自报完成", "employee", "pm", "", "completed", "旧交付", `[{"reference":"OLD"}]`, now(), "2026-10-19T15:59:59.000Z")
	if e != nil {
		t.Fatal(e)
	}
	db.Close()
	s, e := Open(dir)
	if e != nil {
		t.Fatal(e)
	}
	defer s.Close()
	snap, e := s.Snapshot(ctx, admin)
	if e != nil {
		t.Fatal(e)
	}
	d := snap["documents"].([]map[string]any)[0]
	if num(d["approvalRound"]) != 1 || len(d["agentHistory"].([]map[string]any)) != 1 || d["agentHistory"].([]map[string]any)[0]["runId"] != "old-agent-run" {
		t.Fatal(d)
	}
	task := snap["tasks"].([]map[string]any)[0]
	if task["status"] != "submitted" || task["completedAt"] != nil || task["submittedAt"] != "2026-10-19T15:59:59.000Z" {
		t.Fatal(task)
	}
	if e = s.IntegrityCheck(ctx); e != nil {
		t.Fatal(e)
	}
}
