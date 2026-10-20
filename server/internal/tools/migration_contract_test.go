package tools

import (
	"context"
	"crazyoffice/server/internal/model"
	"encoding/base64"
	"encoding/csv"
	"encoding/json"
	"fmt"
	"github.com/xuri/excelize/v2"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
)

// Independent migration contracts exercise the old observable behavior against
// real SQLite, exact calculations, and actual generated artifacts.
func migrationRows() []any {
	rows := []any{}
	cash := int64(100000)
	money := func(n int64) string { return fmt.Sprintf("%d.%02d", n/100, n%100) }
	for year := 2024; year <= 2025; year++ {
		for month := 1; month <= 12; month++ {
			rows = append(rows, map[string]any{"year": year, "month": month, "revenue": "100.29", "cost": "20.01", "operating_expense": "10.03", "other_income": "-0.02", "tax": "1.01", "opening_cash": money(cash), "cash_in": "100.01", "cash_out": "50.00", "closing_cash": money(cash + 5001)})
			cash += 5001
		}
	}
	return rows
}
func migrationCall(t *testing.T, b *Toolbox, name, role string, args map[string]any) map[string]any {
	t.Helper()
	r, e := b.Execute(context.Background(), name, args, model.Role{ID: role})
	if e != nil {
		t.Fatalf("%s: %v", name, e)
	}
	return r
}
func migrationReject(t *testing.T, b *Toolbox, name, role string, args map[string]any) {
	t.Helper()
	if r, e := b.Execute(context.Background(), name, args, model.Role{ID: role}); e == nil {
		t.Fatalf("%s accepted invalid input: %+v", name, r)
	}
}
func migrationFiles(t *testing.T, b *Toolbox, names ...string) {
	t.Helper()
	for _, name := range names {
		p, e := b.safe(name)
		if e != nil {
			t.Fatal(e)
		}
		info, e := os.Stat(p)
		if e != nil || info.Size() == 0 {
			t.Errorf("existing deliverable %s missing/empty: %v", name, e)
		}
	}
}

func TestMigrationFinanceDecimalAndOldDeliverables(t *testing.T) {
	b := box(t, map[string]any{"year": 2025, "company": "合同测试公司", "data": migrationRows()})
	migrationCall(t, b, "import_finance", "ops", nil)
	r := migrationCall(t, b, "calculate_finance", "finance", nil)
	raw, _ := json.Marshal(ev(r)["years"])
	var years map[string]map[string]any
	json.Unmarshal(raw, &years)
	if years["2025"]["revenue"] != 1203.48 || years["2025"]["net_profit"] != 830.64 {
		t.Fatalf("integer-cent calculation differs: %+v", years["2025"])
	}
	audit := migrationCall(t, b, "audit_finance", "liu", nil)
	if ev(audit)["passed"] != true {
		t.Fatal(audit)
	}
	migrationFiles(t, b, "finance/finance.sqlite", "finance/monthly.csv", "finance/metrics.json", "finance/annual-report.xlsx", "finance/annual-report.html", "finance/audit.json")
	for _, v := range []any{"1/2", "1.001", "NaN", "Infinity", true} {
		if n, e := Cents(v); e == nil {
			t.Errorf("invalid decimal %v accepted as %d", v, n)
		}
	}
}
func TestMigrationFinanceBadRowsNeverSilentlyDropped(t *testing.T) {
	for _, bad := range []any{"broken", 7, nil, []any{}} {
		t.Run(fmt.Sprintf("%T", bad), func(t *testing.T) {
			b := box(t, map[string]any{"year": 2025, "data": append(migrationRows(), bad)})
			migrationReject(t, b, "import_finance", "ops", nil)
		})
	}
}
func TestMigrationTSVTrailingJSONAndInputLimit(t *testing.T) {
	var text strings.Builder
	w := csv.NewWriter(&text)
	w.Comma = '\t'
	headers := append([]string{"year", "month"}, financeFields...)
	w.Write(headers)
	for _, raw := range migrationRows() {
		r := raw.(map[string]any)
		row := []string{}
		for _, k := range headers {
			row = append(row, str(r[k]))
		}
		w.Write(row)
	}
	w.Flush()
	b := box(t, map[string]any{"year": 2025, "data": map[string]any{"name": "ledger.tsv", "text": text.String()}})
	migrationCall(t, b, "import_finance", "ops", nil)
	oversize := strings.Repeat("x", 10*1024*1024+1)
	for _, v := range []any{map[string]any{"name": "input.json", "text": `[{"x":1}] ignored-tail`}, map[string]any{"name": "input.txt", "text": oversize}, map[string]any{"name": "input.txt", "base64": base64.StdEncoding.EncodeToString([]byte(oversize))}} {
		if _, e := source(v); e == nil {
			t.Fatal("source accepted malformed or oversized input")
		}
	}
}
func TestMigrationSQLContractsRollbackAndStrictMode(t *testing.T) {
	checks := []map[string]any{{"name": "NOT NULL真实约束", "sql": "INSERT INTO items(id,name,quantity) VALUES(1,NULL,0)", "expectError": true}, {"name": "负数真实约束", "sql": "INSERT INTO items(id,name,quantity) VALUES(1,'item',-1)", "expectError": true}, {"name": "准备与读取", "setupSql": "INSERT INTO items(id,name,quantity) VALUES(1,'item',0)", "sql": "SELECT * FROM items WHERE id=1", "expectedRows": 1}}
	ddl := "CREATE TABLE items(id INTEGER PRIMARY KEY,name TEXT NOT NULL,quantity INTEGER NOT NULL CHECK(quantity>=0))"
	b := box(t, map[string]any{"databaseChecks": checks, "databaseTestMode": "contract-only", "data": map[string]any{"items": []any{map[string]any{"id": 8, "name": "真实记录", "quantity": 3}}}})
	migrationCall(t, b, "design_database", "zhang", map[string]any{"ddl": ddl})
	migrationCall(t, b, "build_database", "ops", nil)
	r := migrationCall(t, b, "test_database", "liu", map[string]any{"tests": []any{}, "queries": []string{"SELECT * FROM items"}})
	if ev(r)["passed"] != true || ev(r)["allChangesRolledBack"] != true {
		t.Fatal(r)
	}
	migrationReject(t, b, "test_database", "liu", map[string]any{"tests": []any{}, "queries": []string{"SELECT 1; SELECT 2"}})
	for _, bad := range []any{"broken", nil, 7} {
		badBox := box(t, map[string]any{"data": map[string]any{"items": []any{map[string]any{"id": 1, "name": "first", "quantity": 3}, bad}}})
		migrationCall(t, badBox, "design_database", "zhang", map[string]any{"ddl": ddl})
		migrationReject(t, badBox, "build_database", "ops", nil)
		p, _ := badBox.safe("database/company.sqlite")
		if _, e := os.Stat(p); !os.IsNotExist(e) {
			t.Error("failed import retained partial database")
		}
	}
}
func TestMigrationSQLSetupFailureCannotProveConstraint(t *testing.T) {
	b := box(t, map[string]any{"databaseChecks": []any{map[string]any{"name": "准备失败", "setupSql": "INSERT INTO absent VALUES(1)", "sql": "INSERT INTO items VALUES(NULL)", "expectError": true}}})
	migrationReject(t, b, "design_database", "zhang", map[string]any{"ddl": "CREATE TABLE items(name TEXT NOT NULL)"})
	for _, check := range []any{map[string]any{"name": "类型错误", "sql": "SELECT 1", "expectError": "true"}, map[string]any{"name": "结果数错误", "sql": "SELECT 1", "expectedRows": 1.5}, "broken"} {
		b = box(t, map[string]any{"databaseChecks": []any{check}})
		migrationReject(t, b, "design_database", "zhang", map[string]any{"ddl": "CREATE TABLE items(name TEXT NOT NULL)"})
	}
}
func TestMigrationNetworkCanonicalIPAndUnknownLabels(t *testing.T) {
	rows := []any{map[string]any{"ip": "2001:4860:4860::8888", "timestamp": "2026-10-20T01:00:00Z", "status": 503, "label": "malicious"}, map[string]any{"ip": "2001:4860:4860:0:0:0:0:8888", "timestamp": "2026-10-20T01:00:01Z", "status": 503, "label": "malicious"}, map[string]any{"ip": "8.8.4.4", "timestamp": "2026-10-20T01:00:02Z", "status": 200, "label": "unknown"}}
	b := box(t, map[string]any{"logs": rows})
	r := migrationCall(t, b, "inspect_network", "ops", nil)
	if ev(r)["sources"] != 2 {
		t.Errorf("equivalent IPv6 source split: %+v", ev(r))
	}
	r = migrationCall(t, b, "analyze_traffic", "liu", map[string]any{"threshold": 1, "windowSeconds": 60})
	if len(stringsOf(ev(r)["suspectedSources"])) != 1 {
		t.Errorf("canonical source threshold missed: %+v", ev(r))
	}
	migrationCall(t, b, "apply_defense", "zhang", map[string]any{"blockedIps": []string{"2001:4860:4860::8888"}, "reason": "依据来源证据拦截；未知标签不能确认恢复"})
	r = migrationCall(t, b, "verify_network", "liu", nil)
	if ev(r)["verifiedRestored"] == true {
		t.Fatal("unknown labels falsely verified restored")
	}
	migrationFiles(t, b, "network/access.log", "network/replay.csv", "network/verification.json")
}
func TestMigrationNetworkZeroThresholdAndBrokenRowsRejected(t *testing.T) {
	row := map[string]any{"ip": "8.8.8.8", "timestamp": "2026-10-20T01:00:00Z", "status": 200, "label": "normal"}
	b := box(t, map[string]any{"logs": []any{row}, "threshold": 0})
	migrationCall(t, b, "inspect_network", "ops", nil)
	migrationReject(t, b, "analyze_traffic", "liu", nil)
	b = box(t, map[string]any{"logs": []any{row, "broken"}})
	migrationReject(t, b, "inspect_network", "ops", nil)
}
func TestMigrationDeliverySourceBudgetAndExports(t *testing.T) {
	b := box(t, map[string]any{"requirements": "R1：员工登录。\nR2：记录审批。\n预算：1万元。", "dailyRate": 1500})
	requirements := []map[string]any{{"id": "R1", "description": "登录", "source": "员工登录", "acceptance": "可登录"}, {"id": "R2", "description": "审批", "source": "记录审批", "acceptance": "可追溯"}}
	migrationCall(t, b, "extract_requirements", "business", map[string]any{"requirements": requirements})
	packages := []map[string]any{{"id": "P1", "name": "登录", "days": 2, "dependsOn": []string{}, "requirementIds": []string{"R1"}, "deliverable": "登录功能"}, {"id": "P2", "name": "审批", "days": 3, "dependsOn": []string{"P1"}, "requirementIds": []string{"R2"}, "deliverable": "审批记录"}}
	r := migrationCall(t, b, "estimate_delivery", "business", map[string]any{"packages": packages})
	if ev(r)["totalCost"] != 7500.0 {
		t.Fatal(r)
	}
	if ev(r)["requestedBudget"] != 10000.0 || ev(r)["budgetDifference"] != -2500.0 {
		t.Errorf("original budget tracking lost: %+v", ev(r))
	}
	review := migrationCall(t, b, "review_delivery", "liu", nil)
	if ev(review)["passed"] != true || ev(review)["customerApproved"] != false {
		t.Fatal(review)
	}
	migrationFiles(t, b, "delivery/requirements.md", "delivery/plan.csv", "delivery/acceptance-checklist.csv")
	requirements[0]["source"] = "记录审批"
	migrationReject(t, b, "extract_requirements", "business", map[string]any{"requirements": requirements})
}
func TestMigrationQuotePositiveConfigurationComparison(t *testing.T) {
	b := box(t, map[string]any{"requirements": "32GB 内存，1TB SSD", "budget": 20000, "currency": "CNY"})
	b.quotes = []map[string]any{{"id": "Q1", "title": "Server", "status": "priced", "productType": "server_hardware", "price": 12000.0, "currency": "CNY", "selectedConfiguration": []string{"32GB RAM DIMM", "1TB SSD NVMe"}, "sourceUrl": "https://supplier.example/server", "fetchedAt": "2026-10-20T01:00:00Z"}}
	r := migrationCall(t, b, "compare_quotes", "zhang", map[string]any{"purpose": "technical"})
	if ev(r)["comparableQuoteCount"] != 1 {
		t.Errorf("valid original configuration comparison never passes: %+v", ev(r))
	}
	q := ExtractQuote(Page{Text: `<title>Server</title><script type="application/ld+json">{"@type":"Product","name":"Server","offers":{"@type":"Offer","price":"12000.00","priceCurrency":"CNY"}}</script><input checked aria-label="32GB RAM DIMM"><input checked aria-label="1TB SSD NVMe">`})
	if len(stringsOf(q["selectedConfiguration"])) != 2 {
		t.Errorf("checked configuration evidence lost: %+v", q)
	}
}
func TestMigrationInvestmentMissingEvidenceRemainsUnapproved(t *testing.T) {
	b := box(t, map[string]any{"projectName": "隔离项目", "projectBrief": "项目方称已经交付十家客户。", "projectType": "非上市公司", "financials": "", "currency": "CNY"})
	migrationCall(t, b, "prepare_investment", "invest_research", map[string]any{"claims": []any{map[string]any{"id": "C1", "claim": "十家客户", "sourceQuote": "已经交付十家客户"}}})
	r := migrationCall(t, b, "analyze_investment_financials", "invest_finance", nil)
	if ev(r)["recordCount"] != 0 || len(stringsOf(ev(r)["missing"])) == 0 {
		t.Fatal(r)
	}
	b.put("investment/research.json", map[string]any{"retrievedPageCount": 0})
	r = migrationCall(t, b, "review_investment", "invest_risk", map[string]any{"findings": []any{map[string]any{"claimId": "C1", "verdict": "unverified", "citations": []any{}}}})
	if ev(r)["formalDueDiligenceComplete"] != false || len(stringsOf(ev(r)["criticalGaps"])) == 0 {
		t.Fatal(r)
	}
	r = migrationCall(t, b, "build_investment_memo", "lead", map[string]any{"recommendation": "continue_diligence", "rationale": strings.Repeat("项目资料缺少独立核实，需要补充法定主体、银行流水、合同与客户访谈证据。", 4), "nextSteps": []string{"补齐证明"}})
	if ev(r)["recommendation"] != "request_information" || ev(r)["investmentAuthorized"] != false || ev(r)["paymentExecuted"] != false {
		t.Fatal(r)
	}
}
func TestMigrationOnboardingDeniedNeverRegisters(t *testing.T) {
	input := map[string]any{"employeeNumber": "CONTRACT-001", "employeeName": "本地员工", "department": "研发部", "position": "工程师", "startDate": "2026-10-20", "workEmail": "contract@example.test", "employmentConfirmed": true, "resourceRequirements": "电脑\n代码库只读权限"}
	b, e := New(Config{RunDir: filepath.Join(t.TempDir(), "runs", "isolated"), Input: input, Approval: func(context.Context, map[string]any) (map[string]any, error) {
		return map[string]any{"approved": false, "note": "未确认"}, nil
	}})
	if e != nil {
		t.Fatal(e)
	}
	for _, op := range []struct{ n, r string }{{"prepare_onboarding", "hr"}, {"review_onboarding", "liu"}, {"plan_onboarding_resources", "ops"}, {"request_onboarding_approval", "hr"}} {
		migrationCall(t, b, op.n, op.r, nil)
	}
	r := migrationCall(t, b, "register_onboarding", "hr", nil)
	if ev(r)["registered"] != false || ev(r)["registryWritten"] != false || ev(r)["externalAccountsCreated"] != false || ev(r)["equipmentAssigned"] != false {
		t.Fatal(r)
	}
	migrationFiles(t, b, "onboarding/employee-registration.html", "onboarding/onboarding-checklist.csv")
}

func TestMigrationDatabaseTablePayloadMustBeArrayEvenWhenEmpty(t *testing.T) {
	for _, bad := range []any{nil, "", "not rows", map[string]any{}} {
		b := box(t, map[string]any{"data": map[string]any{"items": bad}})
		migrationCall(t, b, "design_database", "zhang", map[string]any{"ddl": "CREATE TABLE items(id INTEGER PRIMARY KEY)"})
		migrationReject(t, b, "build_database", "ops", nil)
	}
}
func TestMigrationNetworkCalendarDatesDoNotOverflowNanoseconds(t *testing.T) {
	b := box(t, map[string]any{"logs": []any{
		map[string]any{"ip": "8.8.8.8", "timestamp": "2026-10-20T01:00:00Z", "status": 200, "label": "normal"},
		map[string]any{"ip": "8.8.4.4", "timestamp": "2500-10-20T01:00:00Z", "status": 503, "label": "malicious"},
	}})
	r := migrationCall(t, b, "inspect_network", "ops", nil)
	if ev(r)["windowStart"] != "2026-10-20T01:00:00Z" || ev(r)["windowEnd"] != "2500-10-20T01:00:00Z" {
		t.Fatalf("RFC3339 calendar ordering overflowed: %+v", ev(r))
	}
}

func TestMigrationSQLContractDoesNotCoerceBooleansNullOrBadParams(t *testing.T) {
	cases := []map[string]any{
		{"name": "布尔不能冒充零行", "sql": "SELECT * FROM items", "expectedRows": true},
		{"name": "空值不能冒充零行", "sql": "SELECT * FROM items", "expectedRows": nil},
		{"name": "参数必须数组", "sql": "SELECT * FROM items", "params": "silently-ignored"},
	}
	for _, check := range cases {
		t.Run(str(check["name"]), func(t *testing.T) {
			b := box(t, map[string]any{"databaseChecks": []any{check}})
			migrationReject(t, b, "design_database", "zhang", map[string]any{"ddl": "CREATE TABLE items(id INTEGER PRIMARY KEY)"})
		})
	}
}

func TestMigrationRequirementQuotesCannotUseSharedFooterOrAnotherClause(t *testing.T) {
	cases := []struct{ name, raw, wrong string }{
		{"共同交付说明不是R2业务证据", "R1：客户录入。\nR2：订单审批。\n共同交付说明：生成报告。", "生成报告"},
		{"编号空白不能跳过来源核验", "R1 ：客户录入。\nR2 ：订单审批。", "客户录入"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			b := box(t, map[string]any{"requirements": c.raw})
			migrationReject(t, b, "extract_requirements", "business", map[string]any{"requirements": []map[string]any{
				{"id": "R1", "description": "客户录入", "source": "客户录入", "acceptance": "可录入"},
				{"id": "R2", "description": "订单审批", "source": c.wrong, "acceptance": "可审批"},
			}})
		})
	}
}

func TestMigrationXLSXUsesRawFinancialValuesNotCurrencyFormatting(t *testing.T) {
	book := excelize.NewFile()
	defer book.Close()
	headers := append([]string{"year", "month"}, financeFields...)
	for col, name := range headers {
		cell, _ := excelize.CoordinatesToCellName(col+1, 1)
		if e := book.SetCellValue("Sheet1", cell, name); e != nil {
			t.Fatal(e)
		}
	}
	for row, raw := range migrationRows() {
		record := raw.(map[string]any)
		for col, name := range headers {
			value := record[name]
			if name != "year" && name != "month" {
				n, e := strconv.ParseFloat(str(value), 64)
				if e != nil {
					t.Fatal(e)
				}
				value = n
			}
			cell, _ := excelize.CoordinatesToCellName(col+1, row+2)
			if e := book.SetCellValue("Sheet1", cell, value); e != nil {
				t.Fatal(e)
			}
		}
	}
	currencyFormat := `"¥"#,##0.00`
	style, e := book.NewStyle(&excelize.Style{CustomNumFmt: &currencyFormat})
	if e != nil {
		t.Fatal(e)
	}
	if e = book.SetCellStyle("Sheet1", "C2", "K25", style); e != nil {
		t.Fatal(e)
	}
	formatted, e := book.GetCellValue("Sheet1", "C2")
	if e != nil || !strings.Contains(formatted, "¥") {
		t.Fatalf("fixture lacks currency formatting: %s %v", formatted, e)
	}
	buf, e := book.WriteToBuffer()
	if e != nil {
		t.Fatal(e)
	}
	b := box(t, map[string]any{"year": 2025, "data": map[string]any{"name": "financial.xlsx", "base64": base64.StdEncoding.EncodeToString(buf.Bytes())}})
	migrationCall(t, b, "import_finance", "ops", nil)
	r := migrationCall(t, b, "calculate_finance", "finance", nil)
	raw, _ := json.Marshal(ev(r)["years"])
	var years map[string]map[string]any
	json.Unmarshal(raw, &years)
	if years["2025"]["revenue"] != 1203.48 {
		t.Fatalf("formatted workbook changed actual values: %+v", years)
	}
}

func TestMigrationSharedHandoverMayBeSeparateRequirement(t *testing.T) {
	b := box(t, map[string]any{"requirements": "R1：客户录入。\nR2：订单审批。\n共同交付说明：生成报告。"})
	migrationCall(t, b, "extract_requirements", "business", map[string]any{"requirements": []map[string]any{
		{"id": "R1", "description": "客户录入", "source": "客户录入", "acceptance": "可录入"},
		{"id": "R2", "description": "订单审批", "source": "订单审批", "acceptance": "可审批"},
		{"id": "R3", "description": "共同交付报告", "source": "生成报告", "acceptance": "可下载"},
	}})
}
func TestMigrationQuoteZeroIsNotAPrice(t *testing.T) {
	q := ExtractQuote(Page{Text: `<title>Server</title><p>￥0</p>`})
	if q["price"] != nil || q["status"] == "priced" {
		t.Fatalf("zero is not a valid existing price candidate: %+v", q)
	}
}

func TestMigrationDeliveryCostBufferStatementsKeepTheirNegation(t *testing.T) {
	state := map[string]any{"toolResults": map[string]any{"estimate_delivery": map[string]any{
		"personDays": 38, "teamSize": 1, "elapsedWorkingDays": 38,
		"bufferPct": 10, "timeContingencyApplied": false,
	}}}
	// These are actual correct statements from the second real-model execution.
	// The word "buffer" must not cross a comma and invert a later negation.
	for _, line := range []string{
		"费用缓冲10%仅影响成本，不增加工作日。",
		"总成本：¥62,700.00（含10%费用缓冲，未增加工作日）。",
		"预计工期：38个工作日（基于1人团队串行排期，不含时间缓冲）。",
		"bufferPct仅增加成本缓冲，不增加工作日或日历时间。",
		"elapsedWorkingDays=38为纯工作包累加的工作日，未包含时间应急缓冲。",
		"工作日排期为38工作日，未包含时间缓冲。",
		"费用缓冲仅影响成本，不延长工期。",
	} {
		if err := ValidateReport(line, state); err != nil {
			t.Errorf("correct cost/time distinction rejected: %s: %v", line, err)
		}
	}
	for _, line := range []string{
		"已预留15%工期缓冲。",
		"排期已包含15%时间缓冲。",
		"工作日已增加时间余量。",
	} {
		if err := ValidateReport(line, state); err == nil {
			t.Errorf("unsupported applied time buffer accepted: %s", line)
		}
	}
}

func TestMigrationOnboardingReviewSeparatesHistoricalPreflightFromFinalReceipt(t *testing.T) {
	state := map[string]any{"toolResults": map[string]any{
		"review_onboarding": map[string]any{"registryWritten": false},
		"register_onboarding": map[string]any{
			"registered": true, "registryWritten": true, "employmentConfirmedBySubmitter": true,
		},
	}}
	for _, line := range []string{
		"预检阶段仅校验格式，未写入主册；最终登记回执已确认员工台账写入成功。",
		"早期员工登记预检尚未写入主册；最终已写入，设备账号仍待办理。",
	} {
		if err := ValidateReport(line, state); err != nil {
			t.Errorf("accurate historical stage rejected: %s: %v", line, err)
		}
	}
	for _, line := range []string{
		"当前员工台账尚未写入，需真人最终确认。",
		"录用状态未知，需要重新审批录用。",
		"需由业务负责人进行最终录用审批。",
	} {
		if err := ValidateReport(line, state); err == nil {
			t.Errorf("stale final state or repeated employment decision accepted: %s", line)
		}
	}
}

func TestMigrationInvestmentUnableToVerifyIsNotProofOfAbsence(t *testing.T) {
	state := map[string]any{"toolResults": map[string]any{"review_investment": map[string]any{}}}
	for _, line := range []string{
		"仅项目方单方陈述，未提供合同、流水或客户访谈证据，公开渠道无法核实。",
		"本次检索未取得主体匹配证据；未检到不代表公开记录不存在。",
	} {
		if err := ValidateReport(line, state); err != nil {
			t.Errorf("bounded inability to verify rejected: %s: %v", line, err)
		}
	}
	for _, line := range []string{
		"公开渠道无工商登记、知识产权或融资新闻记录。",
		"全网不存在工商登记。",
	} {
		if err := ValidateReport(line, state); err == nil {
			t.Errorf("unsupported absence claim accepted: %s", line)
		}
	}
}
