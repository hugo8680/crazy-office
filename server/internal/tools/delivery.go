package tools

import (
	"context"
	"errors"
	"fmt"
	"math"
	"regexp"
	"strings"
	"unicode/utf8"
)

func (t *Toolbox) rawRequirements() string {
	s := originalText(t.config.Input["data"])
	return strings.TrimSpace(str(t.config.Input["requirements"]) + "\n\n" + s)
}
func numberedClauses(raw string) (map[string][]string, []string) {
	markers := regexp.MustCompile(`\b(R\d+)\s*[:：]`).FindAllStringSubmatchIndex(raw, -1)
	ids := map[string]bool{}
	for _, m := range markers {
		ids[raw[m[2]:m[3]]] = true
	}
	if len(ids) < 2 {
		return nil, nil
	}
	clauses := map[string][]string{}
	shared := []string{}
	footer := regexp.MustCompile(`[。；;.!?\r\n][ \t]*(?:#{1,6}[ \t]+)?(?:共同(?:交付)?(?:说明|要求)|统一(?:交付)?(?:说明|要求)|通用(?:交付)?(?:说明|要求)|交付(?:说明|要求|清单)|补充说明|后续说明|交付(?:\s*(?:[A-Za-z]|数据|文件|报告|成果|产物|清单))|拆成|拆分成|需求拆为)`)
	for i, m := range markers {
		end := len(raw)
		if i+1 < len(markers) {
			end = markers[i+1][0]
		}
		contentStart := m[1]
		body := raw[contentStart:end]
		clauseEnd := end
		for _, f := range footer.FindAllStringIndex(body, -1) {
			if strings.TrimSpace(body[:f[0]]) != "" {
				_, size := utf8.DecodeRuneInString(body[f[0]:])
				clauseEnd = contentStart + f[0] + size
				shared = append(shared, strings.TrimSpace(raw[clauseEnd:end]))
				break
			}
		}
		id := raw[m[2]:m[3]]
		clauses[id] = append(clauses[id], strings.TrimSpace(raw[m[0]:clauseEnd]))
	}
	return clauses, shared
}
func (t *Toolbox) delivery(ctx context.Context, name string, a map[string]any) (map[string]any, []string, error) {
	if e := ctx.Err(); e != nil {
		return nil, nil, e
	}
	switch name {
	case "extract_requirements":
		src := t.rawRequirements()
		rr := maps(a["requirements"])
		if len(rr) == 0 || len(rr) > 100 {
			return nil, nil, errors.New("需提供1至100条带原文引用的需求")
		}
		seen := map[string]bool{}
		clauses, shared := numberedClauses(src)
		for _, r := range rr {
			id := str(r["id"])
			quote := str(r["source"])
			if id == "" || seen[id] || quote == "" || !strings.Contains(src, quote) || strings.TrimSpace(str(r["description"])) == "" || strings.TrimSpace(str(r["acceptance"])) == "" {
				return nil, nil, errors.New("需求需唯一ID、描述、逐字原文引用和验收条件")
			}
			seen[id] = true
			if clauses != nil {
				scope := clauses[id]
				if scope == nil {
					scope = shared
				}
				matched := false
				for _, section := range scope {
					matched = matched || strings.Contains(section, quote)
				}
				if !matched {
					return nil, nil, errors.New("需求" + id + "的引用须来自同编号业务条款；共同交付说明须作为单独额外需求")
				}
			}
			r["confirmedByCustomer"] = false
		}
		for id := range clauses {
			if !seen[id] {
				return nil, nil, errors.New("遗漏原文需求编号：" + id)
			}
		}
		ev := map[string]any{"project": t.config.Input["company"], "source": src, "requirements": rr, "entities": stringsOf(a["entities"]), "questions": stringsOf(a["questions"]), "exclusions": stringsOf(a["exclusions"]), "assumptions": stringsOf(a["assumptions"]), "customerApproved": false}
		if ev["project"] == nil {
			ev["project"] = "本次业务需求"
		}
		_ = t.put("delivery/requirements.json", ev)
		md := "# 需求与范围\n\n"
		for _, r := range rr {
			md += "## " + str(r["id"]) + " · " + str(r["description"]) + "\n\n原文：" + str(r["source"]) + "\n\n验收：" + str(r["acceptance"]) + "\n\n"
		}
		for _, pair := range []struct{ label, key string }{{"待确认问题", "questions"}, {"排除范围", "exclusions"}, {"假设", "assumptions"}} {
			md += "## " + pair.label + "\n\n"
			for _, line := range stringsOf(ev[pair.key]) {
				md += "- " + line + "\n"
			}
		}
		_ = t.put("delivery/requirements.md", md)
		return receipt(fmt.Sprintf("保存%d条有原文依据的需求与验收条件", len(rr)), ev), []string{"delivery/requirements.json", "delivery/requirements.md"}, nil
	case "estimate_delivery":
		var req map[string]any
		if e := t.read("delivery/requirements.json", &req); e != nil {
			return nil, nil, errors.New("请先提取需求")
		}
		var old map[string]any
		_ = t.read("delivery/plan.json", &old)
		packages := maps(a["packages"])
		if len(packages) == 0 {
			packages = maps(old["packages"])
		} else if old != nil {
			return nil, nil, errors.New("工作包已保存；财务复核请省略packages，复用底稿")
		}
		if len(packages) == 0 || len(packages) > 50 {
			return nil, nil, errors.New("首次需提供1至50个具体工作包")
		}
		rate := number(t.config.Input["dailyRate"])
		if rate == 0 {
			rate = 1500
		}
		if a["dailyRate"] != nil {
			if t.config.Input["dailyRate"] != nil && number(a["dailyRate"]) != rate {
				return nil, nil, errors.New("不能改写用户人日单价")
			}
			rate = number(a["dailyRate"])
		}
		team := number(a["teamSize"])
		if team == 0 {
			team = number(old["teamSize"])
		}
		if team == 0 {
			team = 1
		}
		buffer := number(a["bufferPct"])
		if a["bufferPct"] == nil {
			buffer = number(old["bufferPct"])
		}
		if rate <= 0 || rate > 1000000 || team < 1 || team > 50 || team != math.Trunc(team) || buffer < 0 || buffer > 100 {
			return nil, nil, errors.New("单价、团队人数或缓冲比例无效")
		}
		allowed := map[string]bool{}
		for _, r := range maps(req["requirements"]) {
			allowed[str(r["id"])] = true
		}
		by := map[string]map[string]any{}
		for _, p := range packages {
			id := str(p["id"])
			days := number(p["days"])
			if id == "" || by[id] != nil || days <= 0 || days > 1000 || str(p["name"]) == "" || str(p["deliverable"]) == "" {
				return nil, nil, errors.New("工作包需唯一ID、名称、有效人日与产物")
			}
			for _, r := range stringsOf(p["requirementIds"]) {
				if !allowed[r] {
					return nil, nil, errors.New("工作包引用不存在的需求")
				}
			}
			by[id] = p
		}
		visiting, computed := map[string]bool{}, map[string]map[string]any{}
		cursor := 0.0
		var schedule func(string) (map[string]any, error)
		schedule = func(id string) (map[string]any, error) {
			if r := computed[id]; r != nil {
				return r, nil
			}
			p := by[id]
			if p == nil || visiting[id] {
				return nil, errors.New("工作包依赖不存在或循环")
			}
			visiting[id] = true
			dep := 0.0
			for _, d := range unique(stringsOf(p["dependsOn"])) {
				r, e := schedule(d)
				if e != nil {
					return nil, e
				}
				dep = max(dep, number(r["endDay"]))
			}
			start := max(cursor, dep)
			end := math.Round((start+number(p["days"])/team)*1e4) / 1e4
			cursor = end
			r := map[string]any{"id": id, "name": p["name"], "days": p["days"], "dependsOn": stringsOf(p["dependsOn"]), "requirementIds": stringsOf(p["requirementIds"]), "deliverable": p["deliverable"], "startDay": start, "endDay": end, "cost": math.Round(number(p["days"])*rate*100) / 100}
			computed[id] = r
			delete(visiting, id)
			return r, nil
		}
		rows := []map[string]any{}
		covered := []string{}
		days, subtotal := 0.0, 0.0
		for _, p := range packages {
			r, e := schedule(str(p["id"]))
			if e != nil {
				return nil, nil, e
			}
			rows = append(rows, r)
			days += number(r["days"])
			subtotal += number(r["cost"])
			covered = append(covered, stringsOf(r["requirementIds"])...)
		}
		contingency := math.Round(subtotal*buffer) / 100
		days = math.Round(days*1e4) / 1e4
		missingCoverage := []string{}
		for id := range allowed {
			if !containsString(covered, id) {
				missingCoverage = append(missingCoverage, id)
			}
		}
		if len(missingCoverage) > 0 {
			return nil, nil, fmt.Errorf("工作包遗漏需求映射：%s；请为每个工作包填写requirementIds并覆盖所有已提取需求，未保存计划", strings.Join(missingCoverage, ","))
		}
		for _, line := range stringsOf(a["assumptions"]) {
			if positiveClaim(line, `(?:时间|工期|排期|工作日)[^。；\n]{0,20}(?:缓冲|预留|余量)|(?:缓冲|预留)[^。；\n]{0,20}(?:时间|工期|工作日)`) {
				return nil, nil, errors.New("bufferPct只计算成本缓冲，未增加排期；请更正假设，不得把费用比例写成已预留时间")
			}
		}
		ev := map[string]any{"project": req["project"], "packages": rows, "personDays": days, "dailyRate": rate, "teamSize": team, "bufferPct": buffer, "subtotal": subtotal, "contingency": contingency, "totalCost": math.Round((subtotal+contingency)*100) / 100, "currency": "CNY", "elapsedWorkingDays": cursor, "requirementsCovered": unique(covered), "assumptions": a["assumptions"], "notContractQuote": true, "schedulingMethod": "保守串行工作包，依赖优先，使用同一团队；人日不等于日历天"}
		if a["assumptions"] == nil {
			ev["assumptions"] = old["assumptions"]
		}
		ev["roundingMethod"] = "各工作包先按分四舍五入，再求和；缓冲按小计比例取分"
		ev["daysUnit"] = "packages.days与personDays均为人日；startDay/endDay/elapsedWorkingDays为工作日，不是日历天。"
		ev["costBufferPct"] = buffer
		ev["timeContingencyApplied"] = false
		ev["elapsedWorkingDaysExcludesTimeContingency"] = true
		ev["requestedBudget"] = nil
		ev["budgetSource"] = nil
		ev["budgetDifference"] = nil
		if m := regexp.MustCompile(`(?i)预算\s*(?:为|约|上限|[:：])?\s*([0-9]+(?:\.[0-9]+)?)\s*(万|千)?\s*(?:元|人民币|CNY)`).FindStringSubmatch(str(t.config.Input["requirements"])); m != nil {
			budget := number(m[1])
			if m[2] == "万" {
				budget *= 10000
			} else if m[2] == "千" {
				budget *= 1000
			}
			ev["requestedBudget"] = budget
			ev["budgetSource"] = m[0]
			ev["budgetDifference"] = math.Round((number(ev["totalCost"])-budget)*100) / 100
		}
		_ = t.put("delivery/plan.json", ev)
		csv := [][]any{{"ID", "工作包", "人日", "开始工作日", "结束工作日", "成本CNY", "产物"}}
		for _, r := range rows {
			csv = append(csv, []any{r["id"], r["name"], r["days"], r["startDay"], r["endDay"], r["cost"], r["deliverable"]})
		}
		_ = t.put("delivery/plan.csv", writeCSV(csv))
		return receipt(fmt.Sprintf("确定性计算%.2f人日，估算¥%.2f，%.2f工作日", days, number(ev["totalCost"]), cursor), ev), []string{"delivery/plan.json", "delivery/plan.csv"}, nil
	case "review_delivery":
		var req, plan map[string]any
		if e := t.read("delivery/requirements.json", &req); e != nil {
			return nil, nil, errors.New("没有需求底稿")
		}
		_ = t.read("delivery/plan.json", &plan)
		covered := map[string]bool{}
		for _, id := range stringsOf(plan["requirementsCovered"]) {
			covered[id] = true
		}
		missing := []string{}
		sourceOK := true
		checklist := []map[string]any{}
		for _, r := range maps(req["requirements"]) {
			id := str(r["id"])
			if !covered[id] {
				missing = append(missing, id)
			}
			sourceOK = sourceOK && strings.Contains(str(req["source"]), str(r["source"]))
			checklist = append(checklist, map[string]any{"id": id, "acceptance": r["acceptance"], "status": "待交付后验收，非已通过"})
		}
		sum := 0.0
		depOK := true
		by := map[string]map[string]any{}
		for _, p := range maps(plan["packages"]) {
			by[str(p["id"])] = p
			sum += number(p["cost"])
		}
		for _, p := range maps(plan["packages"]) {
			for _, d := range stringsOf(p["dependsOn"]) {
				if by[d] == nil || number(p["startDay"]) < number(by[d]["endDay"]) {
					depOK = false
				}
			}
		}
		issues := stringsOf(a["issues"])
		checks := map[string]bool{"sourceQuotesMatch": sourceOK, "uniqueRequirementIds": true, "planExists": plan != nil, "coverageComplete": plan != nil && len(missing) == 0, "calculationConsistent": plan != nil && math.Abs(number(plan["totalCost"])-sum-number(plan["contingency"])) < .011, "dependencyScheduleValid": plan != nil && depOK}
		passed := len(issues) == 0
		for _, b := range checks {
			passed = passed && b
		}
		ev := map[string]any{"passed": passed, "checks": checks, "missingRequirementIds": missing, "issues": issues, "risks": stringsOf(a["risks"]), "openQuestions": req["questions"], "assumptions": req["assumptions"], "checklist": checklist, "customerApproved": false, "notContractQuote": true}
		t.serial++
		file := fmt.Sprintf("delivery/review-%d.json", t.serial)
		_ = t.put(file, ev)
		csv := [][]any{{"需求ID", "验收条件", "覆盖工作包", "状态"}}
		for _, r := range checklist {
			packages := []string{}
			for _, p := range maps(plan["packages"]) {
				if containsString(stringsOf(p["requirementIds"]), str(r["id"])) {
					packages = append(packages, str(p["id"]))
				}
			}
			r["coveredBy"] = packages
			csv = append(csv, []any{r["id"], r["acceptance"], strings.Join(packages, ";"), r["status"]})
		}
		_ = t.put("delivery/acceptance-checklist.csv", writeCSV(csv))
		_ = t.put(file, ev)
		return receipt("独立核对需求、排期和费用；客户验收尚未执行", ev), []string{file, "delivery/acceptance-checklist.csv"}, nil
	}
	return nil, nil, errors.New("交付工具无效")
}
func containsString(xs []string, s string) bool {
	for _, x := range xs {
		if x == s {
			return true
		}
	}
	return false
}
