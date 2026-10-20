package agent

import (
	"archive/zip"
	"bytes"
	"context"
	"crazyoffice/server/internal/model"
	"crazyoffice/server/internal/tools"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

type fixtureProvider struct {
	mu        sync.Mutex
	calls     []model.Request
	blocked   bool
	neverTool bool
}

func (p *fixtureProvider) Status(context.Context, bool) (model.Status, error) {
	return model.Status{Provider: "fixture", Model: "test-only-model", Ready: true, Message: "仅测试模型"}, nil
}
func (p *fixtureProvider) Decide(ctx context.Context, r model.Request) (model.Decision, error) {
	p.mu.Lock()
	p.calls = append(p.calls, r)
	p.mu.Unlock()
	if p.blocked {
		<-ctx.Done()
		return model.Decision{}, ctx.Err()
	}
	if p.neverTool {
		return model.Decision{Action: "finish", Output: "不能凭空完成", Summary: "尚无证据"}, nil
	}
	c := r.Context.(map[string]any)
	progress := c["taskProgress"].(map[string]any)
	used := stringsList(progress["successfulTools"])
	for _, d := range r.Tools {
		if d.Name == "list_artifacts" || contains(used, d.Name) {
			continue
		}
		a := map[string]any{}
		input := c["input"].(map[string]any)
		switch d.Name {
		case "fetch_quote":
			a["urls"] = []string{"https://8.8.8.8/server"}
		case "search_web":
			a["query"] = "server price"
		case "analyze_traffic":
			a["threshold"] = 1
		case "apply_defense":
			a = map[string]any{"blockedIps": []string{"203.0.113.2"}, "reason": "带标签日志中的恶意来源；不封禁正常请求IP，仍需离线验证"}
		case "extract_requirements":
			src := text(input["requirements"])
			a["requirements"] = []map[string]any{{"id": "R1", "description": src, "source": src, "acceptance": "真实工具执行与交付文件可查"}}
		case "design_database":
			a["ddl"] = "CREATE TABLE customers(id INTEGER PRIMARY KEY,email TEXT NOT NULL UNIQUE);CREATE TABLE orders(id INTEGER PRIMARY KEY,customer_id INTEGER NOT NULL REFERENCES customers(id),amount INTEGER NOT NULL CHECK(amount>=0));"
			a["description"] = "客户订单与外键非负约束"
		case "test_database":
			a["tests"] = []map[string]any{{"name": "拒绝负金额", "setupSql": "INSERT INTO customers(id,email) VALUES(900,'sample@example.test')", "sql": "INSERT INTO orders(customer_id,amount) VALUES(900,-1)", "expectError": true}}
			a["queries"] = []string{"SELECT * FROM customers"}
		case "estimate_delivery":
			if len(objects(c["workspace"].(map[string]any)["plan"])) == 0 && r.Role.ID == "business" {
				a["packages"] = []map[string]any{{"id": "P1", "name": "执行需求", "days": 2, "dependsOn": []string{}, "requirementIds": []string{"R1"}, "deliverable": "本次工具底稿与报告"}}
			}
		case "prepare_investment":
			a["claims"] = []map[string]any{{"id": "C1", "claim": "提供内部系统", "sourceQuote": "本项目提供内部办公系统", "area": "业务"}}
		case "research_investment":
			a["queries"] = []string{"隔离测试科技"}
			a["urls"] = []string{"https://8.8.8.8/server"}
		case "review_investment":
			a["findings"] = []map[string]any{{"claimId": "C1", "verdict": "issuer_claim", "reason": "只有项目方材料", "citations": []map[string]any{{"sourceId": "U1", "quote": "本项目提供内部办公系统"}}}}
		case "build_investment_memo":
			a["recommendation"] = "request_information"
			a["rationale"] = strings.Repeat("已核对现有来源和本次确定性核算；项目方材料尚未经过独立审计，主体、合同、流水、客户和融资条款均需补充核验，不能据此批准投资或作收益保证。", 2)
		case "write_report":
			a["title"] = "隔离测试正式交付"
			a["content"] = strings.Repeat("本报告依据本次实际工具回执整理。数据、工作文件和审批过程均保存在隔离工作区；工具已执行的检查只覆盖声明范围，缺失项目仍待真实负责人确认，不能把模型文字作为采购、上线、审计或投资授权。", 2)
		}
		return model.Decision{Action: "tool", Tool: d.Name, Args: a, Summary: "测试模型选择真实工具 " + d.Name, Model: "test-only-model"}, nil
	}
	return model.Decision{Action: "finish", Output: "已根据实际工具回执交付，缺项与边界见证据。", Summary: "真实工具回执已交接", Model: "test-only-model"}, nil
}
func newTestEngine(t *testing.T, p model.Provider) *Engine {
	t.Helper()
	e, err := New(Config{DataDir: t.TempDir(), Provider: p, ReceiptHandoff: true, ToolboxFactory: func(c tools.Config) (*tools.Toolbox, error) {
		c.Fetch = func(ctx context.Context, url string) (tools.Page, error) {
			if strings.Contains(url, "bing.com") || strings.Contains(url, "duckduckgo.com") {
				return tools.Page{URL: url, Status: 200, ContentType: "text/html", Text: `<li class="b_algo"><a href="https://8.8.8.8/server">服务器报价</a></li>`, FetchedAt: stamp()}, nil
			}
			return tools.Page{URL: url, Status: 200, ContentType: "text/html", Text: `<title>Server hardware</title><p>隔离测试科技提供内部办公系统</p><script type="application/ld+json">{"@type":"Product","name":"server","offers":{"@type":"Offer","price":1200,"priceCurrency":"CNY"}}</script>`, FetchedAt: stamp()}, nil
		}
		return tools.New(c)
	}})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
		defer cancel()
		_ = e.Shutdown(ctx)
	})
	return e
}
func await(t *testing.T, e *Engine, id string, approve bool) map[string]any {
	t.Helper()
	deadline := time.After(8 * time.Second)
	ticker := time.NewTicker(2 * time.Millisecond)
	defer ticker.Stop()
	for {
		run, err := e.Get(id)
		if err != nil {
			t.Fatal(err)
		}
		if run["status"] == "awaiting_approval" && approve {
			a := run["approval"].(map[string]any)
			_, err = e.Approve(id, map[string]any{"approvalId": a["id"], "approved": true, "note": "仅测试审批"})
			if err != nil {
				t.Fatal(err)
			}
		}
		if !active(text(run["status"])) {
			return run
		}
		select {
		case <-deadline:
			t.Fatal("timed out", run["status"])
			return nil
		case <-ticker.C:
		}
	}
}
func financeInput() map[string]any {
	rows := []map[string]any{}
	cash := 1000
	for y := 2024; y <= 2025; y++ {
		for m := 1; m <= 12; m++ {
			rows = append(rows, map[string]any{"year": y, "month": m, "revenue": 100, "cost": 20, "operating_expense": 10, "other_income": 0, "tax": 1, "opening_cash": cash, "cash_in": 100, "cash_out": 50, "closing_cash": cash + 50})
			cash += 50
		}
	}
	return map[string]any{"company": "隔离测试", "year": 2025, "data": rows}
}
func TestSevenScenariosUseRealGoToolsAndIndependentRoles(t *testing.T) {
	inputs := map[string]map[string]any{"finance": financeInput(), "procurement": {"requirements": "服务器32GB内存和1TB SSD", "budget": 30000, "currency": "CNY", "urls": "https://8.8.8.8/server"}, "ddos": {"requirements": "仅隔离日志验收", "logs": []map[string]any{{"ip": "198.51.100.1", "timestamp": "2026-10-20T01:00:00Z", "status": 200, "label": "normal"}, {"ip": "203.0.113.2", "timestamp": "2026-10-20T01:00:00Z", "status": 503, "label": "malicious"}, {"ip": "203.0.113.2", "timestamp": "2026-10-20T01:00:01Z", "status": 503, "label": "malicious"}}}, "database": {"requirements": "客户唯一邮箱，订单关联客户且金额非负", "data": map[string]any{"customers": []map[string]any{{"id": 1, "email": "one@example.test"}}}}, "delivery": {"requirements": "登记任务并由真人审批，验收关联交付文件", "company": "隔离测试", "dailyRate": 1500}, "onboarding": {"employeeNumber": "TEST001", "employeeName": "不进入模型的姓名", "department": "产品", "position": "工程师", "startDate": "2026-10-20", "employmentConfirmed": true, "resourceRequirements": "电脑与只读权限"}, "investment": {"projectName": "隔离测试科技", "projectBrief": "本项目提供内部办公系统", "currency": "CNY", "urls": "https://8.8.8.8/server", "financials": `[{"period":"2024","revenue":"100.00","cash":"50.00","monthly_burn":"10.00"},{"period":"2025","revenue":"120.00","cash":"60.00","monthly_burn":"10.00"}]`}}
	for id, input := range inputs {
		t.Run(id, func(t *testing.T) {
			p := &fixtureProvider{}
			e := newTestEngine(t, p)
			run, err := e.Create(context.Background(), map[string]any{"scenarioId": id, "input": input})
			if err != nil {
				t.Fatal(err)
			}
			result := await(t, e, text(run["id"]), true)
			if result["status"] != "completed" {
				t.Fatalf("%s: %v", result["status"], result["error"])
			}
			roles := map[string]bool{}
			for _, task := range objects(result["tasks"]) {
				if task["status"] != "done" || toInt(task["toolCalls"]) < 1 {
					t.Fatal(task)
				}
				roles[text(task["agentId"])] = true
			}
			if len(roles) < 3 {
				t.Fatal("missing independent roles")
			}
			if len(objects(result["artifacts"])) < 3 {
				t.Fatal("missing actual files")
			}
			if result["input"] != nil || result["runDir"] != nil || result["configs"] != nil {
				t.Fatal("private data leaked")
			}
			p.mu.Lock()
			for _, r := range p.calls {
				if id == "onboarding" && strings.Contains(asJSON(r), "不进入模型的姓名") {
					t.Fatal("onboarding PII reached model")
				}
			}
			p.mu.Unlock()
			data, err := e.Archive(text(run["id"]))
			if err != nil {
				t.Fatal(err)
			}
			z, err := zip.NewReader(bytes.NewReader(data), int64(len(data)))
			if err != nil || len(z.File) < 4 {
				t.Fatal(err, len(z.File))
			}
		})
	}
}
func TestCannotFinishWithoutRequiredToolReceipts(t *testing.T) {
	e := newTestEngine(t, &fixtureProvider{neverTool: true})
	run, err := e.Create(context.Background(), map[string]any{"scenarioId": "database", "input": map[string]any{"requirements": "客户库"}})
	if err != nil {
		t.Fatal(err)
	}
	r := await(t, e, text(run["id"]), true)
	if r["status"] != "failed" {
		t.Fatal(r["status"])
	}
	if strings.Contains(text(r["summary"]), "完成") {
		t.Fatal("fake summary")
	}
}
func TestCancelBusySubscribeAndShutdown(t *testing.T) {
	e := newTestEngine(t, &fixtureProvider{blocked: true})
	r, err := e.Create(context.Background(), map[string]any{"scenarioId": "database", "input": map[string]any{"requirements": "客户库"}})
	if err != nil {
		t.Fatal(err)
	}
	id := text(r["id"])
	ch, unsubscribe, err := e.Subscribe(id)
	if err != nil {
		t.Fatal(err)
	}
	defer unsubscribe()
	if got := <-ch; got["id"] != id {
		t.Fatal(got)
	}
	if _, err = e.Create(context.Background(), map[string]any{"scenarioId": "database", "input": map[string]any{"requirements": "客户库"}}); err == nil {
		t.Fatal("concurrent creation allowed")
	}
	if _, err = e.Approve(id, map[string]any{"approvalId": "fake", "approved": true}); err == nil {
		t.Fatal("fake approval allowed")
	}
	if _, err = e.Cancel(id); err != nil {
		t.Fatal(err)
	}
	result := await(t, e, id, false)
	if result["status"] != "cancelled" {
		t.Fatal(result)
	}
	if _, err = e.Cancel(id); err == nil {
		t.Fatal("cancelled twice")
	}
}
func TestRestartRecoveryAndHistoricalArtifactMove(t *testing.T) {
	dir := t.TempDir()
	id := "historical-run"
	runDir := filepath.Join(dir, id)
	_ = os.MkdirAll(runDir, 0700)
	_ = os.WriteFile(filepath.Join(runDir, "proof.txt"), []byte("old actual proof"), 0600)
	oldDir := "/old/workspace/data/" + id
	run := map[string]any{"id": id, "scenarioId": "database", "status": "running", "runDir": oldDir, "createdAt": stamp(), "tasks": []map[string]any{{"id": "design", "status": "running"}}, "artifacts": []map[string]any{{"id": "proof", "name": "proof.txt", "path": oldDir + "/proof.txt", "mimeType": "text/plain"}}}
	_ = os.WriteFile(filepath.Join(runDir, "run.json"), []byte(asJSON(run)), 0600)
	e, err := New(Config{DataDir: dir, Provider: &fixtureProvider{}})
	if err != nil {
		t.Fatal(err)
	}
	r, err := e.Get(id)
	if err != nil || r["status"] != "failed" {
		t.Fatal(r, err)
	}
	a, err := e.Artifact(id, "proof")
	if err != nil || a.Path != filepath.Join(runDir, "proof.txt") {
		t.Fatal(a, err)
	}
	outside := filepath.Join(dir, "secret.txt")
	_ = os.WriteFile(outside, []byte("secret"), 0600)
	e.mu.Lock()
	e.runs[id]["artifacts"] = append(objects(e.runs[id]["artifacts"]), map[string]any{"id": "escape", "name": "secret", "path": "../secret.txt"})
	e.mu.Unlock()
	if _, err = e.Artifact(id, "escape"); err == nil {
		t.Fatal("artifact escape")
	}
}
func TestInputLimitsAreRejectedBeforeModelContext(t *testing.T) {
	for _, tt := range []struct {
		id    string
		input map[string]any
	}{{"database", map[string]any{"requirements": strings.Repeat("长", 24001)}}, {"delivery", map[string]any{"requirements": strings.Repeat("长", 23999), "data": map[string]any{"text": "补充材料"}}}, {"investment", map[string]any{"projectName": "项目", "projectBrief": strings.Repeat("长", 24000)}}, {"onboarding", map[string]any{"employeeNumber": "E1", "employeeName": "姓名", "department": "产品", "position": "开发", "startDate": "2026-02-30", "employmentConfirmed": true}}, {"procurement", map[string]any{"requirements": "服务器", "budget": -1}}, {"procurement", map[string]any{"requirements": "服务器", "budget": 100, "urls": "http://key:secret@example.com"}}} {
		if err := ValidateInput(tt.id, tt.input); err == nil {
			t.Fatalf("accepted %s", tt.id)
		}
	}
}
func TestHTTPErrorStatus(t *testing.T) {
	var target interface{ StatusCode() int }
	err := apiError(409, "冲突")
	if !errors.As(err, &target) || target.StatusCode() != 409 {
		t.Fatal(err)
	}
}
func TestAutomationNoExampleReplacementAndIndependentConfig(t *testing.T) {
	e := newTestEngine(t, &fixtureProvider{})
	a, err := NewAutomation(AutomationConfig{Engine: e, StateFile: filepath.Join(t.TempDir(), "automation.json")})
	if err != nil {
		t.Fatal(err)
	}
	defer a.Shutdown(context.Background())
	s, err := a.Update(context.Background(), map[string]any{"scenarioIds": []string{"finance"}, "minIntervalMinutes": 1, "maxIntervalMinutes": 1})
	if err != nil {
		t.Fatal(err)
	}
	if s["taskInputs"] != nil {
		t.Fatal("private inputs leaked")
	}
	r, err := a.Dispatch(context.Background())
	if err != nil || r["skipped"] != true {
		t.Fatal(r, err)
	}
	if e.Active() != 0 {
		t.Fatal("invented finance")
	}
	if _, err = a.Update(context.Background(), map[string]any{"unknown": true}); err == nil {
		t.Fatal("unknown config")
	}
	if _, err = a.Update(context.Background(), map[string]any{"taskInputs": map[string]any{"finance": map[string]any{"example": true}}}); err != nil {
		t.Fatal(err)
	}
	r, _ = a.Dispatch(context.Background())
	if r["skipped"] != true {
		t.Fatal("used example")
	}
	if _, err = a.Update(context.Background(), map[string]any{"taskInputs": map[string]any{"finance": financeInput()}}); err != nil {
		t.Fatal(err)
	}
	r, err = a.Dispatch(context.Background())
	if err != nil || r["skipped"] == true {
		t.Fatal(r, err)
	}
	run := r["run"].(map[string]any)
	result := await(t, e, text(run["id"]), true)
	if result["source"] != "automation" {
		t.Fatal(result)
	}
	raw, err := os.ReadFile(a.config.StateFile)
	if err != nil {
		t.Fatal(err)
	}
	var saved map[string]any
	if json.Unmarshal(raw, &saved) != nil || saved["lastRunId"] != run["id"] {
		t.Fatal(saved)
	}
}

func TestStructuredModelPreviewsAndEvidenceAreBounded(t *testing.T) {
	rows := []any{}
	for i := 0; i < 100000; i++ {
		rows = append(rows, map[string]any{"ip": "8.8.8.8", "path": "/"})
	}
	preview := ModelInput(map[string]any{"logs": rows}, "ddos")
	if len(asJSON(preview)) > 3000 {
		t.Fatal("raw structured input sent to model")
	}
	nested := ModelInput(map[string]any{"logs": map[string]any{"requests": rows}}, "ddos")
	if len(asJSON(nested)) > 20000 {
		t.Fatal("nested structured input sent to model")
	}
	full := strings.Repeat("需求", 12000)
	p := ModelInput(map[string]any{"requirements": full}, "delivery")
	if p["requirements"] != full {
		t.Fatal("valid 24k requirements truncated")
	}
	evidence := ModelEvidence(map[string]any{"sources": rows, "html": strings.Repeat("x", 100000)}, "", 0)
	if len(asJSON(evidence)) > 20000 {
		t.Fatal("evidence not bounded")
	}
}

type lateUnauthorizedProvider struct {
	fixtureProvider
	once sync.Once
	sent bool
}

func (p *lateUnauthorizedProvider) Decide(ctx context.Context, r model.Request) (model.Decision, error) {
	inject := false
	if r.Role.ID == "business" && len(r.Messages) >= 4 {
		p.once.Do(func() { inject = true; p.sent = true })
	}
	if inject {
		return model.Decision{}, &model.ProtocolError{Code: "UNAUTHORIZED_TOOL", ToolName: "list_artifacts", Message: "本轮未授权list_artifacts"}
	}
	return p.fixtureProvider.Decide(ctx, r)
}
func TestUnauthorizedToolGetsBoundedFeedbackEvenAfterEarlierTools(t *testing.T) {
	p := &lateUnauthorizedProvider{}
	e := newTestEngine(t, p)
	r, err := e.Create(context.Background(), map[string]any{"scenarioId": "procurement", "input": map[string]any{"requirements": "32GB内存、1TB SSD服务器", "budget": 30000, "currency": "CNY", "urls": "https://8.8.8.8/server"}})
	if err != nil {
		t.Fatal(err)
	}
	result := await(t, e, text(r["id"]), true)
	if result["status"] != "completed" || !p.sent {
		t.Fatal(result["status"], result["error"])
	}
	corrected := false
	for _, event := range objects(result["events"]) {
		if event["formatCorrection"] != nil {
			corrected = true
		}
	}
	if !corrected {
		t.Fatal("missing actual correction event")
	}
}
