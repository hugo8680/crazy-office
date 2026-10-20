package tools

import (
	"context"
	"crazyoffice/server/internal/model"
	"encoding/json"
	"net"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func box(t *testing.T, input map[string]any) *Toolbox {
	t.Helper()
	b, e := New(Config{RunDir: filepath.Join(t.TempDir(), "runs", "isolated"), Input: input, Approval: func(context.Context, map[string]any) (map[string]any, error) {
		return map[string]any{"approved": true, "targetHumanId": "hr_owner"}, nil
	}})
	if e != nil {
		t.Fatal(e)
	}
	return b
}
func call(t *testing.T, b *Toolbox, name, role string, args map[string]any) map[string]any {
	t.Helper()
	r, e := b.Execute(context.Background(), name, args, model.Role{ID: role})
	if e != nil {
		t.Fatalf("%s: %v", name, e)
	}
	return r
}
func ev(r map[string]any) map[string]any { return r["evidence"].(map[string]any) }
func TestToolPermissionsAndSchema(t *testing.T) {
	b := box(t, nil)
	cases := []struct {
		name, role string
		args       map[string]any
	}{{"inspect_network", "finance", nil}, {"shell", "zhang", nil}, {"analyze_traffic", "liu", map[string]any{"threshold": true}}, {"analyze_traffic", "liu", map[string]any{"threshold": 1.5}}, {"inspect_network", "ops", map[string]any{"unexpected": "value"}}}
	for _, c := range cases {
		if _, e := b.Execute(context.Background(), c.name, c.args, model.Role{ID: c.role}); e == nil {
			t.Fatalf("accepted %+v", c)
		}
	}
}
func TestPublicAddressAndURLGuards(t *testing.T) {
	for _, s := range []string{"127.0.0.1", "10.0.0.1", "172.20.0.1", "192.168.1.3", "100.64.2.1", "169.254.169.254", "198.18.1.2", "203.0.113.1", "::1", "fc00::1", "2001:db8::2", "2002::1234"} {
		if IsPublicAddress(net.ParseIP(s)) {
			t.Errorf("accepted %s", s)
		}
	}
	for _, s := range []string{"8.8.8.8", "2606:4700:4700::1111"} {
		if !IsPublicAddress(net.ParseIP(s)) {
			t.Errorf("rejected %s", s)
		}
	}
	for _, u := range []string{"file:///etc/passwd", "http://localhost/", "http://127.0.0.1/", "http://169.254.169.254/", "https://x.local/", "https://user:pass@example.com/", "https://example.com:1234/"} {
		if _, _, e := ValidatePublicURL(context.Background(), u); e == nil {
			t.Error(u)
		}
	}
}
func TestSafeArtifacts(t *testing.T) {
	b := box(t, nil)
	for _, p := range []string{"../secret", "/etc/passwd", "x/../../../escape"} {
		if e := b.put(p, "x"); e == nil {
			t.Fatal(p)
		}
	}
	outside := t.TempDir()
	if e := os.Symlink(outside, filepath.Join(b.config.RunDir, "linked")); e != nil {
		t.Fatal(e)
	}
	if e := b.put("linked/test", "x"); e == nil {
		t.Fatal("followed symlink")
	}
	if e := b.put("nested/proof.txt", "real evidence"); e != nil {
		t.Fatal(e)
	}
	a, e := b.register("nested/proof.txt")
	if e != nil || a.Bytes != 13 {
		t.Fatal(a, e)
	}
}
func TestCents(t *testing.T) {
	for _, tt := range []struct {
		v   any
		n   int64
		bad bool
	}{{"12.34", 1234, false}, {"0", 0, false}, {"-3.20", -320, false}, {"1.001", 0, true}, {nil, 0, true}, {"NaN", 0, true}, {"1000000000001", 0, true}} {
		n, e := Cents(tt.v)
		if (e != nil) != tt.bad || !tt.bad && n != tt.n {
			t.Fatalf("%v => %d %v", tt.v, n, e)
		}
	}
}
func TestFinanceRealSQLiteXLSXAndIndependentAudit(t *testing.T) {
	rows := []map[string]any{}
	cash := 1000.0
	for y := 2024; y <= 2025; y++ {
		for m := 1; m <= 12; m++ {
			r := map[string]any{"year": y, "month": m, "revenue": "100.10", "cost": "20.01", "operating_expense": "10.00", "other_income": "0", "tax": "1.00", "opening_cash": cash, "cash_in": "100.10", "cash_out": "50.10", "closing_cash": cash + 50}
			cash += 50
			rows = append(rows, r)
		}
	}
	b := box(t, map[string]any{"year": 2025, "company": "隔离验收", "data": rows})
	r := call(t, b, "import_finance", "ops", nil)
	if ev(r)["rows"] != 24 {
		t.Fatal(r)
	}
	r = call(t, b, "calculate_finance", "finance", nil)
	years := ev(r)["years"].(map[string]map[string]any)
	if years["2025"]["revenue"] != 1201.2 {
		t.Fatal(years)
	}
	audit := call(t, b, "audit_finance", "liu", nil)
	if ev(audit)["passed"] != true {
		t.Fatal(audit)
	}
	for _, n := range []string{"finance/finance.sqlite", "finance/annual.xlsx", "finance/audit.json"} {
		p, _ := b.safe(n)
		if st, e := os.Stat(p); e != nil || st.Size() == 0 {
			t.Fatalf("missing %s %v", n, e)
		}
	}
}
func TestFinanceRejectsInvalidCoverageAndCash(t *testing.T) {
	for _, data := range []any{[]any{}, []any{map[string]any{"year": 2025, "month": 1}}} {
		b := box(t, map[string]any{"year": 2025, "data": data})
		if _, e := b.Execute(context.Background(), "import_finance", nil, model.Role{ID: "ops"}); e == nil {
			t.Fatal("incomplete data accepted")
		}
	}
}
func TestDatabaseBuildConstraintsRollbackAndImport(t *testing.T) {
	checks := []map[string]any{{"name": "unique email", "setupSql": "INSERT INTO customers(id,email) VALUES(1,'one@example.test')", "sql": "INSERT INTO customers(id,email) VALUES(2,'one@example.test')", "expectError": true}, {"name": "positive amount", "setupSql": "INSERT INTO customers(id,email) VALUES(1,'one@example.test')", "sql": "INSERT INTO orders(customer_id,amount) VALUES(1,-1)", "expectError": true}}
	b := box(t, map[string]any{"requirements": "客户订单库", "databaseChecks": checks, "data": map[string]any{"customers": []map[string]any{{"id": 7, "email": "customer@example.test"}}, "orders": []map[string]any{{"id": 3, "customer_id": 7, "amount": 120}}}})
	ddl := "CREATE TABLE customers(id INTEGER PRIMARY KEY,email TEXT NOT NULL UNIQUE);CREATE TABLE orders(id INTEGER PRIMARY KEY,customer_id INTEGER NOT NULL REFERENCES customers(id),amount INTEGER NOT NULL CHECK(amount>=0));"
	call(t, b, "design_database", "zhang", map[string]any{"ddl": ddl})
	r := call(t, b, "build_database", "ops", nil)
	if ev(r)["importedRows"] != 2 {
		t.Fatal(r)
	}
	r = call(t, b, "test_database", "liu", map[string]any{"tests": []any{}, "queries": []string{"SELECT * FROM customers"}})
	if ev(r)["passed"] != true {
		t.Fatal(r)
	}
	p, _ := b.safe("database/company.sqlite")
	db, e := openDB(p)
	if e != nil {
		t.Fatal(e)
	}
	defer db.Close()
	var count int
	_ = db.QueryRow("SELECT COUNT(*) FROM customers").Scan(&count)
	if count != 1 {
		t.Fatal("test changes did not roll back", count)
	}
}
func TestDatabaseRejectsUnsafeSQLAndFalseConstraintPass(t *testing.T) {
	for _, s := range []string{"ATTACH DATABASE '/tmp/x' AS x", "CREATE VIRTUAL TABLE x USING fts5(a)", "CREATE TABLE x(a);PRAGMA writable_schema=1", "SELECT readfile('/etc/passwd')", "SELECT zeroblob(100000000)"} {
		if _, e := sqlStatements(s, "design"); e == nil {
			t.Error(s)
		}
	}
	db, e := openDB(":memory:")
	if e != nil {
		t.Fatal(e)
	}
	defer db.Close()
	_, _ = db.Exec("CREATE TABLE x(a INTEGER CHECK(a>0))")
	r, e := runChecks(context.Background(), db, []map[string]any{{"name": "bad SQL not constraint", "sql": "INSERT INTO missing(a) VALUES(1)", "expectError": true}, {"name": "setup failure not constraint", "setupSql": "INSERT INTO missing(a) VALUES(1)", "sql": "INSERT INTO x(a) VALUES(-1)", "expectError": true}})
	if e != nil {
		t.Fatal(e)
	}
	for _, x := range r {
		if x["passed"] == true {
			t.Fatal(x)
		}
	}
}
func TestDDOSRealReplayApprovalAndNoFalseRestore(t *testing.T) {
	logs := []map[string]any{{"ip": "198.51.100.1", "timestamp": "2026-10-20T01:00:00Z", "status": 200, "label": "normal"}, {"ip": "203.0.113.2", "timestamp": "2026-10-20T01:00:00Z", "status": 503, "label": "malicious"}, {"ip": "203.0.113.2", "timestamp": "2026-10-20T01:00:01Z", "status": 503, "label": "malicious"}}
	b := box(t, map[string]any{"logs": logs})
	call(t, b, "inspect_network", "ops", nil)
	r := call(t, b, "analyze_traffic", "liu", map[string]any{"threshold": 1, "windowSeconds": 60})
	if len(ev(r)["suspectedSources"].([]string)) != 1 {
		t.Fatal(r)
	}
	call(t, b, "apply_defense", "zhang", map[string]any{"blockedIps": []string{"203.0.113.2"}, "reason": "两次请求503，证据带攻击标签；评估共享出口误伤风险"})
	r = call(t, b, "verify_network", "liu", nil)
	if ev(r)["verifiedRestored"] != true {
		t.Fatal(r)
	}
	policy := map[string]any{"approved": false}
	_ = b.put("network/defense.json", policy)
	r = call(t, b, "verify_network", "liu", nil)
	if ev(r)["verifiedRestored"] == true {
		t.Fatal("rejected policy falsely restored")
	}
}
func TestQuoteNoFabrication(t *testing.T) {
	cases := []struct {
		name, html, status string
		price              any
	}{{"jsonld", `<title>Server</title><script type="application/ld+json">{"@type":"Product","name":"Dell server","offers":{"@type":"Offer","price":"1299.00","priceCurrency":"USD"}}</script>`, "priced", 1299.0}, {"multi", `<script type="application/ld+json">[{"@type":"Offer","price":1200,"priceCurrency":"USD"},{"@type":"Offer","price":1500,"priceCurrency":"USD"}]</script>`, "pending_inquiry", nil}, {"textunbound", `<title>服务器报价</title><p>￥1500</p>`, "priced", 1500.0}, {"missing", `<title>产品目录</title><p>请询价</p>`, "pending_inquiry", nil}}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			q := ExtractQuote(Page{Text: c.html})
			if q["status"] != c.status || q["price"] != c.price {
				t.Fatal(q)
			}
		})
	}
}
func TestDeliveryTraceabilityAndCost(t *testing.T) {
	b := box(t, map[string]any{"requirements": "R1：员工登录。R2：记录审批。", "dailyRate": 1500})
	call(t, b, "extract_requirements", "business", map[string]any{"requirements": []map[string]any{{"id": "R1", "description": "登录", "source": "员工登录", "acceptance": "可登录"}, {"id": "R2", "description": "审批", "source": "记录审批", "acceptance": "审批可追溯"}}})
	r := call(t, b, "estimate_delivery", "business", map[string]any{"packages": []map[string]any{{"id": "P1", "name": "登录", "days": 2, "dependsOn": []string{}, "requirementIds": []string{"R1"}, "deliverable": "登录功能"}, {"id": "P2", "name": "审批", "days": 3, "dependsOn": []string{"P1"}, "requirementIds": []string{"R2"}, "deliverable": "审批功能"}}})
	if ev(r)["totalCost"] != 7500.0 || ev(r)["elapsedWorkingDays"] != 5.0 {
		t.Fatal(r)
	}
	r = call(t, b, "review_delivery", "liu", nil)
	if ev(r)["passed"] != true {
		t.Fatal(r)
	}
	if _, e := b.Execute(context.Background(), "extract_requirements", map[string]any{"requirements": []map[string]any{{"id": "R1", "description": "false", "source": "不存在原文", "acceptance": "wrong"}}}, model.Role{ID: "business"}); e == nil {
		t.Fatal("fabricated quote accepted")
	}
}
func TestOnboardingPersonalIsolationIdempotencyAndConflict(t *testing.T) {
	input := map[string]any{"employeeNumber": "E001", "employeeName": "仅本地张三", "department": "研发", "position": "工程师", "startDate": "2026-10-20", "workEmail": "one@example.test", "employmentConfirmed": true, "resourceRequirements": "笔记本电脑\n代码库只读权限"}
	b := box(t, input)
	for _, op := range []struct{ name, role string }{{"prepare_onboarding", "hr"}, {"review_onboarding", "liu"}, {"plan_onboarding_resources", "ops"}, {"request_onboarding_approval", "hr"}, {"register_onboarding", "hr"}} {
		r := call(t, b, op.name, op.role, nil)
		raw, _ := json.Marshal(ev(r))
		if strings.Contains(string(raw), "仅本地张三") || strings.Contains(string(raw), "one@example.test") {
			t.Fatal("PII reached model evidence")
		}
	}
	r := call(t, b, "register_onboarding", "hr", nil)
	if ev(r)["idempotent"] != true {
		t.Fatal(r)
	}
	input["employeeName"] = "已改动"
	if _, e := b.Execute(context.Background(), "register_onboarding", nil, model.Role{ID: "hr"}); e == nil {
		t.Fatal("stale approval used")
	}
}
func TestReportsEscapeAndPreserveOfficeSkin(t *testing.T) {
	body := ReportDocument("<script>bad</script>", ReportHTML("# 标题\n\n<script>bad</script>\n\n[bad](javascript:alert(1))"))
	if strings.Contains(body, "<script>bad") || strings.Contains(body, `href="javascript:`) {
		t.Fatal(body)
	}
	if !strings.Contains(body, "report-document") {
		t.Fatal("existing design lost")
	}
}

func TestReportFinanceUnitsCannotMultiplyCentsAgain(t *testing.T) {
	state := map[string]any{"toolResults": map[string]any{"calculate_finance": map[string]any{"currency": "CNY", "years": map[string]any{"2024": map[string]any{"revenue": 90000.0, "net_profit": 10000.0}, "2025": map[string]any{"revenue": 96000.0, "net_profit": 12000.0}}}}}
	for _, line := range []string{"营业收入9.6万元，净利润1.2万元。", "营收96000元。", "营业收入较上年增长6000元。"} {
		if e := ValidateReport(line, state); e != nil {
			t.Fatal(line, e)
		}
	}
	for _, line := range []string{"营业收入960万元。", "净利润96000元。", "营业收入96000 USD。"} {
		if e := ValidateReport(line, state); e == nil {
			t.Fatal("accepted wrong unit/metric", line)
		}
	}
}

func TestReportUsesCommittedDatabaseAndLatestEmployeeReceipt(t *testing.T) {
	db := map[string]any{"toolResults": map[string]any{"build_database": map[string]any{"tables": map[string]any{"customers": 1, "orders": 1}, "validationSampleRows": 2, "emptyDatabase": false}}}
	for _, text := range []string{"当前数据库仅包含结构定义。", "测试数据已完全回滚。"} {
		if err := ValidateReport(text, db); err == nil {
			t.Fatal("false database state accepted", text)
		}
	}
	if err := ValidateReport("建库保留2条验证样本；约束测试的临时变更已回滚，未导入真实业务记录。", db); err != nil {
		t.Fatal(err)
	}
	hr := map[string]any{"toolResults": map[string]any{"register_onboarding": map[string]any{"registered": true, "registryWritten": true, "employmentConfirmedBySubmitter": true}, "review_onboarding": map[string]any{"registryWritten": false}}}
	for _, text := range []string{"员工登记主册尚未写入，待最终确认。", "录用状态未知，需要再次确认录用。"} {
		if err := ValidateReport(text, hr); err == nil {
			t.Fatal("outdated employee state accepted", text)
		}
	}
	if err := ValidateReport("最终回执已写入示例员工册，设备账号权限仍待办理。本工具未作录用决定。", hr); err != nil {
		t.Fatal(err)
	}
}
func TestDatabaseReportOnlyCitesExecutedSQLAndReceipts(t *testing.T) {
	state := map[string]any{"toolResults": map[string]any{"build_database": map[string]any{"tables": map[string]any{"orders": 3}}}}
	if err := ValidateReport("请使用schema.sql和tests.json。\n```sql\nSELECT * FROM orders;\n```", state); err != nil {
		t.Fatal(err)
	}
	for _, query := range []string{"INSERT INTO orders(order_id) VALUES ('ORD003');", "UPDATE orders SET order_id='ORD003';", "DELETE FROM orders;"} {
		if err := ValidateReport("未经实际验证的演示\n```sql\n"+query+"\n```", state); err == nil {
			t.Fatal("unverified write example accepted", query)
		}
	}
}
func TestReportCannotUpgradeTestScriptApprovalOrChangeTrafficWindow(t *testing.T) {
	state := map[string]any{"toolResults": map[string]any{"apply_defense": map[string]any{"approvalActorKind": "isolated_test_operator", "approved": true, "windowSeconds": 88}, "analyze_traffic": map[string]any{"threshold": 20, "windowSeconds": 88}}}
	for _, line := range []string{"已获得真人审批。", "已获真人批准（审批账号local-acceptance-operator）。", "通过滑动时间窗分析（阈值：20次/88.5秒）。"} {
		if err := ValidateReport(line, state); err == nil {
			t.Fatal("false claim accepted", line)
		}
	}
	if err := ValidateReport("隔离测试账号脚本提交样例回执，不代表真人业务审批。阈值：20次/88秒，日志总跨度88.5秒。", state); err != nil {
		t.Fatal(err)
	}
}
func TestDeliveryRejectsMissingRequirementMappingAndTimeBufferClaims(t *testing.T) {
	b := box(t, map[string]any{"requirements": "员工登录", "dailyRate": 1500})
	call(t, b, "extract_requirements", "business", map[string]any{"requirements": []map[string]any{{"id": "R1", "description": "登录", "source": "员工登录", "acceptance": "可以登录"}}})
	args := map[string]any{"packages": []map[string]any{{"id": "P1", "name": "登录", "days": 1, "requirementIds": []string{}, "deliverable": "登录功能"}}}
	if _, err := b.Execute(context.Background(), "estimate_delivery", args, model.Role{ID: "business"}); err == nil {
		t.Fatal("unmapped requirement persisted")
	}
	p, _ := b.safe("delivery/plan.json")
	if _, err := os.Stat(p); !os.IsNotExist(err) {
		t.Fatal("invalid plan saved")
	}
	args["packages"] = []map[string]any{{"id": "P1", "name": "登录", "days": 1, "requirementIds": []string{"R1"}, "deliverable": "登录功能"}}
	args["assumptions"] = []string{"已预留15%工期缓冲"}
	if _, err := b.Execute(context.Background(), "estimate_delivery", args, model.Role{ID: "business"}); err == nil {
		t.Fatal("cost buffer treated as time")
	}
	args["assumptions"] = []string{"未计入额外时间缓冲"}
	call(t, b, "estimate_delivery", "business", args)
}
func TestInvestmentNoSearchResultsDoNotProveAbsence(t *testing.T) {
	state := map[string]any{"toolResults": map[string]any{"review_investment": map[string]any{}}}
	if err := ValidateReport("公开渠道无工商登记、知识产权或融资新闻记录。", state); err == nil {
		t.Fatal("absence invented")
	}
	if err := ValidateReport("本次已访问来源未提供匹配的工商登记、知识产权或融资新闻证据；未检到不代表不存在。", state); err != nil {
		t.Fatal(err)
	}
}
