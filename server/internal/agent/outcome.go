package agent

import (
	"fmt"
	"path/filepath"
	"regexp"
	"strings"
)

// BuildOutcome separates actual business verification from model narration and run progress.
func BuildOutcome(run map[string]any) map[string]any {
	receipts := map[string]map[string]any{}
	results := map[string]map[string]any{}
	perTask := map[string]map[string]any{}
	registered := map[string]map[string]any{}
	for _, a := range objects(run["artifacts"]) {
		registered[text(a["id"])] = a
	}
	for _, t := range objects(run["tasks"]) {
		for _, r := range objects(t["toolResults"]) {
			result, _ := r["result"].(map[string]any)
			result = copyJSON(result)
			ev, _ := result["evidence"].(map[string]any)
			if ev == nil {
				ev = result
			}
			name := text(r["tool"])
			results[name] = result
			perTask[text(t["id"])+":"+name] = map[string]any{"tool": name, "result": result, "evidence": ev}
			if result == nil || result["ok"] == false || text(result["error"]) != "" || ev["ok"] == false || text(ev["error"]) != "" {
				receipts[name] = nil
			} else {
				receipts[name] = ev
			}
		}
	}
	findings := []map[string]any{}
	next := []string{}
	status, label, summary := "incomplete", "交付证据不完整", "尚缺必要的真实工具回执或交付文件。"
	add := func(name string, value any, s string) {
		findings = append(findings, map[string]any{"label": name, "value": fmt.Sprint(value), "status": s})
	}
	verified := func(s string) { status = "verified"; label = "已通过本次检查"; summary = s }
	needs := func(s string) { status = "needs_review"; label = "需要复核"; summary = s }
	has := func(names ...string) bool {
		for _, name := range names {
			if receipts[name] == nil {
				return false
			}
		}
		return true
	}
	countTool := func(name string) int {
		n := 0
		for _, entry := range perTask {
			if entry["tool"] == name {
				r, _ := entry["result"].(map[string]any)
				ev, _ := entry["evidence"].(map[string]any)
				if r["ok"] != false && text(r["error"]) == "" && ev["ok"] != false && text(ev["error"]) == "" {
					n++
				}
			}
		}
		return n
	}
	hasFile := func(tool, pattern string) bool {
		re := regexp.MustCompile(pattern)
		for _, a := range objects(results[tool]["artifacts"]) {
			if actual := registered[text(a["id"])]; actual != nil && re.MatchString(text(actual["name"])) {
				return true
			}
		}
		for _, f := range stringsList(results[tool]["files"]) {
			for _, actual := range registered {
				if (text(actual["path"]) == f || text(actual["name"]) == filepath.Base(f)) && re.MatchString(text(actual["name"])) {
					return true
				}
			}
		}
		return false
	}
	sid := text(run["scenarioId"])
	switch sid {
	case "finance":
		r, audit := receipts["calculate_finance"], receipts["audit_finance"]
		if has("import_finance", "calculate_finance", "audit_finance", "write_report") {
			year := text(r["year"])
			years, _ := r["years"].(map[string]any)
			current, _ := years[year].(map[string]any)
			for _, k := range []string{"revenue", "net_profit", "closing_cash"} {
				if current[k] != nil {
					add(k, text(current[k])+" "+text(r["currency"]), "verified")
				}
			}
			recalculated, _ := audit["recalculated"].(map[string]any)
			checkedYears, _ := recalculated["years"].(map[string]any)
			checked, _ := checkedYears[year].(map[string]any)
			consistent := true
			complete := current != nil
			for _, k := range []string{"revenue", "net_profit", "closing_cash"} {
				complete = complete && current[k] != nil
				if checked[k] != nil && checked[k] != current[k] {
					consistent = false
				}
			}
			if !complete {
				break
			}
			if audit["passed"] == true && audit["independentRecalculation"] == true && strings.EqualFold(text(audit["integrityCheck"]), "ok") && len(stringsList(audit["errors"])) == 0 && toNumber(audit["rowCount"]) == 24 && toNumber(receipts["import_finance"]["rows"]) == 24 && text(r["currency"]) != "" && consistent && results["audit_finance"]["passed"] != false {
				verified("已按分完成管理口径指标与底稿重算；不构成财务审计。")
			} else {
				needs("财务底稿检查存在问题，不能确认完整交付。")
			}
		}
		next = append(next, "由财务负责人核对原始凭证与管理口径。")
	case "database":
		test := receipts["test_database"]
		if test != nil {
			add("独立数据库测试", fmt.Sprintf("通过：%v", test["passed"]), "verified")
		}
		if has("design_database", "build_database", "test_database", "write_report") {
			checks := append(objects(test["tests"]), objects(test["contractTests"])...)
			passed := test["passed"] == true && results["test_database"]["passed"] != false && strings.EqualFold(text(test["integrity"]), "ok") && len(objects(test["foreignKeyViolations"])) == 0
			for _, c := range checks {
				passed = passed && c["passed"] == true
			}
			designChecks, _ := receipts["design_database"]["designChecks"].(map[string]any)
			passed = passed && designChecks["passed"] != false
			if !hasFile("build_database", `(?i)\.sqlite$`) {
				break
			}
			if passed && len(checks) > 0 {
				verified("真实建库、导入与实际执行的SQLite约束测试通过；范围以测试合同为准。")
			} else {
				needs("数据库测试未通过或尚无业务SQL用例，不能作为完整业务验收。")
			}
		}
		next = append(next, "评审生产迁移、备份和业务权限后再部署数据库。")
	case "ddos":
		v := receipts["verify_network"]
		if v != nil {
			for _, k := range []string{"normalRequests", "normalPassed", "falsePositives", "maliciousRequests", "maliciousBlocked", "unknownLabelRequests"} {
				add(k, v[k], "verified")
			}
		}
		if has("inspect_network", "analyze_traffic", "apply_defense", "verify_network", "write_report") {
			if v["verifiedRestored"] == true && results["verify_network"]["verifiedRestored"] != false && v["approved"] == true && receipts["apply_defense"]["approved"] == true && toNumber(v["normalRequests"]) > 0 && toNumber(v["maliciousRequests"]) > 0 && toNumber(v["normalPassRate"]) == 1 && toNumber(v["maliciousBlockRate"]) == 1 && toNumber(v["normalPassed"]) == toNumber(v["normalRequests"]) && toNumber(v["maliciousBlocked"]) == toNumber(v["maliciousRequests"]) && toNumber(v["falsePositives"]) == 0 && v["unknownLabelRequests"] != nil && toNumber(v["unknownLabelRequests"]) == 0 {
				verified("本次带标签日志的隔离重放通过，正常请求无误伤且恶意请求全部拦截；不代表生产网络恢复。")
			} else {
				needs("离线验证尚不能确认恢复；核对审批、标签、误伤和漏拦。")
			}
		}
		next = append(next, "生产网络变更需另行评审和真实监控验证。")
	case "procurement":
		quotes := objects(receipts["fetch_quote"]["quotes"])
		priced := 0
		for _, q := range quotes {
			if q["status"] == "priced" {
				priced++
			}
		}
		add("实际候选", len(quotes), "verified")
		add("唯一公开标价", priced, "needs_review")
		if has("search_web", "fetch_quote", "compare_quotes", "write_report") && countTool("compare_quotes") >= 2 {
			needs("已保存实际网页取证与比价申请；配置、税费和最终报价需供应商确认，未执行采购。")
		}
		next = append(next, "向供应商核实具体配置、书面报价、税费、保修和库存。")
	case "delivery":
		r := receipts["review_delivery"]
		if r != nil {
			add("计划一致性审查", fmt.Sprintf("通过：%v", r["passed"]), "verified")
		}
		if has("extract_requirements", "estimate_delivery", "review_delivery", "write_report") {
			checks, _ := r["checks"].(map[string]any)
			passed := r["passed"] == true && results["review_delivery"]["passed"] != false
			for _, key := range []string{"sourceQuotesMatch", "uniqueRequirementIds", "planExists", "coverageComplete", "calculationConsistent", "dependencyScheduleValid"} {
				passed = passed && checks[key] == true
			}
			for _, v := range checks {
				passed = passed && v == true
			}
			passed = passed && len(stringsList(r["issues"])) == 0 && len(stringsList(r["missingRequirementIds"])) == 0 && len(stringsList(r["openQuestions"])) == 0 && len(stringsList(receipts["extract_requirements"]["questions"])) == 0 && toNumber(receipts["estimate_delivery"]["budgetDifference"]) <= 0
			if countTool("estimate_delivery") < 2 || len(objects(receipts["extract_requirements"]["requirements"])) == 0 || len(objects(receipts["estimate_delivery"]["packages"])) == 0 {
				break
			}
			if passed {
				verified("需求引用、工作包覆盖、依赖和费用通过底稿一致性核对；客户验收尚未执行。")
			} else {
				needs("需求或计划存在待确认、遗漏或不一致事项。")
			}
		}
		next = append(next, "由真实负责人确认范围、估算假设和验收条件。")
	case "investment":
		r := receipts["review_investment"]
		if r != nil {
			add("关键缺口", len(stringsList(r["criticalGaps"])), "needs_review")
		}
		if has("prepare_investment", "research_investment", "analyze_investment_financials", "review_investment", "build_investment_memo", "request_investment_review", "write_report") {
			if !contains([]string{"continue_diligence", "request_information", "pause"}, text(receipts["build_investment_memo"]["recommendation"])) || !contains([]string{"continue_diligence", "pause"}, text(receipts["request_investment_review"]["decision"])) {
				break
			}
			needs("已交付投前研究与老板审阅记录；公开来源与数学核算不能替代线下审计和法律核验，未授权投资。")
		}
		next = append(next, "补充材料并执行法定主体、银行流水、股权与合同核验。")
	case "onboarding":
		r := receipts["register_onboarding"]
		if r != nil {
			add("本地员工册写入", r["registered"], "verified")
		}
		if has("prepare_onboarding", "review_onboarding", "plan_onboarding_resources", "request_onboarding_approval", "register_onboarding", "write_report") {
			review := receipts["review_onboarding"]
			approved := receipts["request_onboarding_approval"]["approved"] == true
			passed := review["passed"] == true && results["review_onboarding"]["passed"] != false && len(objects(review["checks"])) > 0
			for _, c := range objects(review["checks"]) {
				passed = passed && c["passed"] == true
			}
			if r["registered"] == true && r["registryWritten"] == true && r["status"] == "registered" && approved && passed {
				if r["approvalActorKind"] == "isolated_test_operator" {
					needs("隔离测试账号提交样例回执，示例员工册已写入；不代表真人业务审批，资源仍待办理。")
				} else {
					needs("真人已批准并完成本地登记；设备、账号与权限仍待真实负责人办理。")
				}
			} else {
				needs("本次未完成登记，保留未登记回执；没有创建外部账号或分配设备。")
			}
		}
		next = append(next, "办理并逐项确认设备、账号与最小权限。")
	}
	if (status == "verified" || status == "needs_review") && !hasFile("write_report", `(?i)\.(html|md)$`) {
		status = "incomplete"
		label = "交付证据不完整"
		summary = "缺少实际登记的正式报告文件，不能确认完整交付。"
	}
	if run["status"] == "completed" {
		for _, task := range objects(run["tasks"]) {
			if task["status"] != "done" {
				status = "incomplete"
				label = "任务记录需核对"
				summary = "仍有未完成岗位步骤，不能确认完整交付。"
			}
		}
	}
	validation := status
	execution := text(run["status"])
	switch execution {
	case "queued", "running":
		status = "running"
		label = "协作进行中"
		done := 0
		ts := objects(run["tasks"])
		for _, t := range ts {
			if t["status"] == "done" {
				done++
			}
		}
		summary = fmt.Sprintf("已完成%d/%d项岗位任务，结果仍在形成。", done, len(ts))
		next = []string{}
	case "awaiting_approval":
		status = "awaiting_approval"
		label = "等待真人审批"
		approval, _ := run["approval"].(map[string]any)
		summary = text(approval["title"])
		next = []string{"请指定的真实审批人审阅方案并提交决定。"}
	case "failed":
		status = "failed"
		label = "执行中断"
		summary = "流程未完整结束，已保留工具证据和已生成文件。"
		next = []string{"核对中断步骤和错误，修正输入后重新运行。"}
	case "cancelled":
		status = "cancelled"
		label = "已取消"
		summary = "流程已停止，未完成步骤不计为交付。"
	case "completed":
		for _, t := range objects(run["tasks"]) {
			if t["status"] != "done" {
				status = "incomplete"
				label = "任务记录需核对"
				summary = "仍有未完成岗位步骤，不能确认完整交付。"
			}
		}
	}
	groups := map[string][]map[string]any{"deliverables": {}, "checks": {}, "sources": {}, "records": {}}
	for _, a := range objects(run["artifacts"]) {
		id := text(a["id"])
		name := text(a["name"])
		p := strings.ToLower(text(a["path"]))
		if p == "" {
			p = strings.ToLower(name)
		}
		g := "sources"
		switch {
		case id == "execution-evidence":
			g = "records"
		case regexp.MustCompile(`audit|verification|tests\.|design-checks|review|receipt|decision`).MatchString(p):
			g = "checks"
		case strings.Contains(p, "reports/") || regexp.MustCompile(`\.(sqlite|sql|xlsx)$|annual\.(csv|json)|plan\.(csv|json)|comparison-|decision-memo|employee-registration|nginx-defense`).MatchString(p):
			g = "deliverables"
		}
		art := map[string]any{"id": id, "name": filepath.Base(name), "mimeType": a["mimeType"], "bytes": a["bytes"], "url": "/api/runs/" + text(run["id"]) + "/artifacts/" + id}
		groups[g] = append(groups[g], art)
	}
	artifactGroups := []map[string]any{}
	for _, pair := range [][2]string{{"deliverables", "交付文件"}, {"checks", "检查与审批回执"}, {"sources", "原始资料与工作底稿"}, {"records", "执行记录"}} {
		if len(groups[pair[0]]) > 0 {
			artifactGroups = append(artifactGroups, map[string]any{"id": pair[0], "label": pair[1], "artifacts": groups[pair[0]]})
		}
	}
	input, _ := run["input"].(map[string]any)
	return map[string]any{"status": status, "label": label, "summary": summary, "findings": findings, "nextActions": next, "executionStatus": execution, "validationStatus": validation, "example": input["example"] == true || input["isExample"] == true, "artifactGroups": artifactGroups}
}
