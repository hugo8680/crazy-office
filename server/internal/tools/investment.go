package tools

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"net/url"
	"strings"
)

func (t *Toolbox) investment(ctx context.Context, name string, a map[string]any) (map[string]any, []string, error) {
	var dossier, research, financial, review, memo map[string]any
	_ = t.read("investment/dossier.json", &dossier)
	_ = t.read("investment/research.json", &research)
	_ = t.read("investment/financial-analysis.json", &financial)
	_ = t.read("investment/risk-review.json", &review)
	_ = t.read("investment/decision-memo.json", &memo)
	sources := []map[string]any{}
	_ = t.read("investment/sources.json", &sources)
	switch name {
	case "prepare_investment":
		body := strings.TrimSpace(str(t.config.Input["projectBrief"]) + "\n\n" + originalText(t.config.Input["data"]))
		if body == "" {
			return nil, nil, errors.New("项目原文不能为空")
		}
		materials := []map[string]any{{"id": "U1", "title": "项目方简介与补充材料", "kind": "project_material", "text": body, "status": "provided", "publisher": "项目方", "independentlyVerified": false}}
		fin, _ := source(t.config.Input["financials"])
		if fin != nil && str(fin) != "" {
			text := str(fin)
			if _, ok := fin.(string); !ok {
				b, _ := json.Marshal(fin)
				text = string(b)
			}
			materials = append(materials, map[string]any{"id": "U2", "title": "项目方财务资料（未审计）", "kind": "project_financial_material", "text": text, "status": "provided", "publisher": "项目方", "independentlyVerified": false})
		}
		claims := maps(a["claims"])
		if len(claims) < 1 || len(claims) > 20 {
			return nil, nil, errors.New("需提供1至20条待核查说法")
		}
		seen := map[string]bool{}
		for _, c := range claims {
			id, quote := str(c["id"]), str(c["sourceQuote"])
			if id == "" || seen[id] || str(c["claim"]) == "" || quote == "" {
				return nil, nil, errors.New("说法需唯一编号、内容和逐字引用")
			}
			matched := ""
			for _, m := range materials {
				if strings.Contains(str(m["text"]), quote) {
					matched = str(m["id"])
					break
				}
			}
			if matched == "" {
				return nil, nil, errors.New("sourceQuote未逐字匹配项目原文或财务材料")
			}
			seen[id] = true
			c["sourceId"] = matched
			c["status"] = "project_claim_not_verified"
		}
		for _, m := range materials {
			sum := sha256.Sum256([]byte(str(m["text"])))
			m["sha256"] = hex.EncodeToString(sum[:])
			m["receivedAt"] = now()
		}
		ev := map[string]any{"projectName": t.config.Input["projectName"], "projectType": t.config.Input["projectType"], "claims": claims, "questions": stringsOf(a["questions"]), "createdAt": now(), "isExample": t.config.Input["example"] == true || t.config.Input["isExample"] == true, "scope": "投前初步尽调与决策支持，不构成审计、法律认定或收益保证"}
		_ = t.put("investment/dossier.json", ev)
		_ = t.put("investment/sources.json", materials)
		_ = t.put("investment/project-material.txt", body)
		return receipt(fmt.Sprintf("登记%d条项目方说法与原文，均尚未独立核实", len(claims)), ev), []string{"investment/dossier.json", "investment/sources.json", "investment/project-material.txt"}, nil
	case "research_investment":
		if dossier == nil {
			return nil, nil, errors.New("先提取项目说法")
		}
		queries := stringsOf(a["queries"])
		if len(queries) == 0 {
			queries = []string{str(t.config.Input["projectName"]) + " 主体 官方 财务"}
		}
		if len(queries) > 3 {
			return nil, nil, errors.New("最多3组检索词")
		}
		explicit := unique(append(stringsOf(t.config.Input["urls"]), stringsOf(a["urls"])...))
		if len(explicit) > 8 {
			return nil, nil, errors.New("明确指定URL合计最多8个，不静默丢弃")
		}
		candidates := append([]string{}, explicit...)
		attempts := []any{}
		files := []string{}
		for _, q := range queries {
			res, fs, e := t.procurement(ctx, "search_web", map[string]any{"query": q, "limit": 8})
			files = append(files, fs...)
			if e != nil {
				attempts = append(attempts, map[string]any{"query": q, "error": e.Error()})
				continue
			}
			ev, _ := res["evidence"].(map[string]any)
			attempts = append(attempts, ev["attempts"])
			for _, c := range maps(ev["candidates"]) {
				candidates = append(candidates, str(c["url"]))
			}
		}
		candidates = unique(candidates)
		kept := []map[string]any{}
		for _, s := range sources {
			if s["status"] == "provided" {
				kept = append(kept, s)
			}
		}
		sources = kept
		retrieved := 0
		matchedSubject := 0
		for i, raw := range candidates[:min(8, len(candidates))] {
			id := fmt.Sprintf("W%d", i+1)
			s := map[string]any{"id": id, "url": raw, "requestedUrl": raw, "title": raw, "status": "unavailable", "text": "", "accessedAt": now(), "independentlyVerified": false, "publisherIndependence": "not_verified"}
			page, e := t.config.Fetch(ctx, raw)
			if e != nil {
				s["error"] = e.Error()
			} else {
				s["httpStatus"] = page.Status
				s["url"] = page.URL
				s["accessedAt"] = page.FetchedAt
				u, _ := url.Parse(page.URL)
				s["publisher"] = u.Hostname()
				body := ""
				if page.Status >= 200 && page.Status < 300 && (strings.Contains(page.ContentType, "text/") || strings.Contains(page.ContentType, "json")) {
					body = truncate(plainHTML(page.Text), 60000)
				}
				if body != "" {
					s["status"] = "retrieved"
					s["text"] = body
					s["subjectMentioned"] = strings.Contains(strings.ToLower(body), strings.ToLower(str(t.config.Input["projectName"])))
					if s["subjectMentioned"] == true {
						matchedSubject++
					}
					retrieved++
				}
				sum := sha256.Sum256([]byte(page.Text))
				s["sha256"] = hex.EncodeToString(sum[:])
				s["kind"] = "public_page_not_independently_verified"
				s["limitation"] = "发布方说法，主体、真实性、时效和发布方独立性未核实"
				f := "investment/" + id + "-source.html"
				_ = t.put(f, page.Text)
				files = append(files, f)
			}
			sources = append(sources, s)
		}
		skipped := []string{}
		if len(candidates) > 8 {
			skipped = candidates[8:]
		}
		ev := map[string]any{"queries": queries, "searchAttempts": attempts, "sources": sources, "explicitUrls": explicit, "attemptedPageCount": min(8, len(candidates)), "retrievedPageCount": retrieved, "skippedCandidateUrls": skipped, "scope": "仅列出实际尝试的网页，未找到不代表无风险。官网与报道不等于独立证明。"}
		ev["subjectMatchedPageCount"] = matchedSubject
		ev["unmatchedReadablePageCount"] = retrieved - matchedSubject
		ev["countMeaning"] = "retrievedPageCount只计成功读取正文，不表示相关行业资料或项目证据；完整主体匹配另计subjectMatchedPageCount，即使匹配也不代表独立核实。"
		_ = t.put("investment/research.json", ev)
		_ = t.put("investment/sources.json", sources)
		files = append(files, "investment/research.json", "investment/sources.json")
		return receipt(fmt.Sprintf("真实检索%d组、尝试%d页、读到%d页正文；完整项目主体匹配%d页，其余不作项目证据", len(queries), min(8, len(candidates)), retrieved, matchedSubject), ev), files, nil
	case "analyze_investment_financials":
		raw, e := source(t.config.Input["financials"])
		if e != nil {
			return nil, nil, e
		}
		if m, ok := raw.(map[string]any); ok {
			raw = m["records"]
		}
		rows, err := strictMaps(raw, "投资财务资料")
		if err != nil {
			return nil, nil, err
		}
		if len(rows) > 120 {
			return nil, nil, errors.New("最多120期财务资料")
		}
		fields := []string{"revenue", "gross_profit", "net_profit", "cash", "monthly_burn", "debt"}
		normalized := []map[string]any{}
		seen := map[string]bool{}
		currency := str(t.config.Input["currency"])
		if currency == "" {
			currency = "CNY"
		}
		for _, r := range rows {
			period := str(r["period"])
			if period == "" || seen[period] {
				return nil, nil, errors.New("每期需要唯一period")
			}
			seen[period] = true
			if r["currency"] != nil && r["currency"] != currency {
				return nil, nil, errors.New("财务币种不一致，不自动换汇")
			}
			if unit := str(r["unit"]); unit != "" && unit != "元" && unit != "1" && unit != currency {
				return nil, nil, errors.New("金额须为原始币种单位，不接受万元隐含单位")
			}
			record := map[string]any{"period": period, "recordNature": "项目方提供，历史或预测属性未核验"}
			exact := map[string]any{}
			for _, f := range fields {
				if r[f] == nil || str(r[f]) == "" {
					record[f] = nil
					exact[f] = nil
					continue
				}
				n, e := Cents(r[f])
				if e != nil {
					return nil, nil, fmt.Errorf("%s：%w", f, e)
				}
				if (f == "revenue" || f == "cash" || f == "debt") && n < 0 {
					return nil, nil, errors.New("营收、现金或债务不能为负")
				}
				record[f] = float64(n) / 100
				exact[f] = fmt.Sprint(n)
			}
			if record["revenue"] == nil {
				return nil, nil, errors.New("每期必须提供revenue，缺项不补零")
			}
			record["amountsCents"] = exact
			record["grossMarginPct"] = nullableRatio(record["gross_profit"], record["revenue"], 100)
			record["netMarginPct"] = nullableRatio(record["net_profit"], record["revenue"], 100)
			record["cashRunwayMonths"] = nullableRatio(record["cash"], record["monthly_burn"], 1)
			normalized = append(normalized, record)
		}
		var growth, terms any
		missing := []string{}
		if len(normalized) >= 2 {
			p, c := normalized[len(normalized)-2], normalized[len(normalized)-1]
			growth = nullableRatio(number(c["revenue"])-number(p["revenue"]), math.Abs(number(p["revenue"])), 100)
		}
		if len(normalized) == 0 {
			missing = []string{"historical_financials", "cash_and_burn", "debt", "audited_statements"}
		} else {
			for _, f := range fields {
				if normalized[len(normalized)-1][f] == nil {
					missing = append(missing, f)
				}
			}
		}
		if t.config.Input["plannedInvestment"] != nil && t.config.Input["preMoneyValuation"] != nil {
			p, e := Cents(t.config.Input["plannedInvestment"])
			if e != nil {
				return nil, nil, e
			}
			v, e := Cents(t.config.Input["preMoneyValuation"])
			if e != nil {
				return nil, nil, e
			}
			if p < 0 || v < 0 {
				return nil, nil, errors.New("拟投金额和估值不能为负")
			}
			if p > 0 && v > 0 {
				terms = map[string]any{"plannedInvestment": float64(p) / 100, "projectStatedPreMoneyValuation": float64(v) / 100, "impliedPostMoneyValuation": float64(p+v) / 100, "impliedOwnershipPct": float64(p) / float64(p+v) * 100, "meaning": "仅简化普通股增资数学关系，不是公允估值或投资建议"}
			}
		}
		ev := map[string]any{"currency": currency, "recordCount": len(rows), "records": normalized, "revenueGrowthPct": growth, "terms": terms, "missing": missing, "source": "项目方上传资料，真实性未审计", "limitations": []string{"金额按整数分核算，缺项不补零。", "最近两期按上传顺序，不默认期间可比或属于历史实绩。", "数学一致不等于审计、银行流水或合同核验。"}}
		_ = t.put("investment/financial-analysis.json", ev)
		return receipt(fmt.Sprintf("确定性核算%d期资料，保留缺项与真实性限制", len(rows)), ev), []string{"investment/financial-analysis.json"}, nil
	case "review_investment":
		if dossier == nil || research == nil {
			return nil, nil, errors.New("先完成说法提取与真实联网取证")
		}
		claims := map[string]map[string]any{}
		for _, c := range maps(dossier["claims"]) {
			claims[str(c["id"])] = c
		}
		by := map[string]map[string]any{}
		for _, s := range sources {
			by[str(s["id"])] = s
		}
		seen := map[string]bool{}
		findings := maps(a["findings"])
		if err := validateInvestmentClaims(asJSONString(a)); err != nil {
			return nil, nil, err
		}
		gaps := stringsOf(a["additionalGaps"])
		for _, f := range findings {
			id := str(f["claimId"])
			if claims[id] == nil || seen[id] {
				return nil, nil, errors.New("审查必须引用已有且不重复的claimId")
			}
			seen[id] = true
			verdict := str(f["verdict"])
			if !map[string]bool{"source_supported": true, "corroborated": true, "issuer_claim": true, "conflict": true, "unverified": true}[verdict] {
				return nil, nil, errors.New("审查结论无效")
			}
			citations := maps(f["citations"])
			web, matched := 0, 0
			publishers := map[string]bool{}
			for _, c := range citations {
				s := by[str(c["sourceId"])]
				quote := str(c["quote"])
				if s == nil || (s["status"] != "retrieved" && s["status"] != "provided") || quote == "" || len([]rune(quote)) > 500 || !strings.Contains(str(s["text"]), quote) {
					return nil, nil, errors.New("引用须逐字匹配已取得正文的来源，最多500字")
				}
				c["url"] = s["url"]
				if s["url"] != nil {
					web++
					publishers[str(s["publisher"])] = true
					if s["subjectMentioned"] == true {
						matched++
					}
				}
			}
			if (verdict == "source_supported" || verdict == "conflict" || verdict == "corroborated") && len(citations) == 0 {
				return nil, nil, errors.New("支持或冲突结论需要实际引用")
			}
			if verdict == "corroborated" {
				if len(publishers) < 2 {
					return nil, nil, errors.New("多源说法须来自两个不同域的实际网页")
				}
				verdict = "source_supported"
			}
			if verdict == "source_supported" && web == 0 {
				verdict = "issuer_claim"
			}
			if (verdict == "source_supported" || verdict == "conflict") && matched < web {
				verdict = "unverified"
				gaps = append(gaps, id+"的来源未匹配准确项目主体")
			}
			if web == 0 || matched == 0 {
				gaps = append(gaps, id+"没有主体匹配的外部正文支持")
			}
			f["verdict"] = verdict
			f["independentlyVerified"] = false
			f["claim"] = claims[id]["claim"]
		}
		missing := []string{}
		for id := range claims {
			if !seen[id] {
				missing = append(missing, id)
			}
		}
		if len(missing) > 0 {
			gaps = append(gaps, "尚未逐项审查说法："+strings.Join(missing, "、"))
		}
		if number(financial["recordCount"]) == 0 {
			gaps = append(gaps, "缺少历史财务、现金及审计资料")
		}
		if number(research["retrievedPageCount"]) == 0 {
			gaps = append(gaps, "未取得可读公开网页正文")
		}
		mandatory := []string{"核实准确法定主体、股权及最终受益人", "核对登记、资质、诉讼处罚，未查到不代表不存在", "用审计、流水、合同及客户访谈核对收入", "核对知识产权、关联交易、稀释与退出条款"}
		ev := map[string]any{"findings": findings, "risks": stringsOf(a["risks"]), "criticalGaps": unique(gaps), "claimCoverage": map[string]any{"total": len(claims), "reviewed": len(findings), "missing": missing}, "mandatoryOfflineChecks": mandatory, "formalDueDiligenceComplete": false, "publisherIndependenceVerified": false, "guaranteedReturn": false}
		_ = t.put("investment/risk-review.json", ev)
		return receipt(fmt.Sprintf("审查%d条说法，保留%d项关键缺口，未独立证实项目事实", len(findings), len(gaps)), ev), []string{"investment/risk-review.json"}, nil
	case "build_investment_memo":
		if review == nil {
			return nil, nil, errors.New("缺少独立风险审查")
		}
		recommendation := str(a["recommendation"])
		labels := map[string]string{"continue_diligence": "进入下一轮尽调", "request_information": "补充材料后再评审", "pause": "暂缓推进"}
		if labels[recommendation] == "" {
			return nil, nil, errors.New("只能继续尽调、补材料或暂缓")
		}
		if len(stringsOf(review["criticalGaps"])) > 0 && recommendation == "continue_diligence" {
			recommendation = "request_information"
		}
		rationale := str(a["rationale"])
		if err := validateInvestmentClaims(rationale); err != nil {
			return nil, nil, err
		}
		if len([]rune(rationale)) < 80 {
			return nil, nil, errors.New("需至少80字证据判断及限制")
		}
		ev := map[string]any{"projectName": t.config.Input["projectName"], "recommendation": recommendation, "recommendationLabel": labels[recommendation], "rationale": rationale, "nextSteps": stringsOf(a["nextSteps"]), "criticalGaps": review["criticalGaps"], "financial": financial, "review": review, "sourceRegister": sources, "createdAt": now(), "investmentAuthorized": false, "paymentExecuted": false, "executionBoundary": "仅支持后续尽调方向，不批准投资、不签约、不付款"}
		_ = t.put("investment/decision-memo.json", ev)
		md := "# " + str(t.config.Input["projectName"]) + " · 投前初步尽调\n\n## " + labels[recommendation] + "\n\n" + rationale + "\n\n## 关键缺口\n\n"
		for _, g := range stringsOf(review["criticalGaps"]) {
			md += "- " + g + "\n"
		}
		md += "\n## 后续核查\n\n"
		for _, s := range append(stringsOf(a["nextSteps"]), stringsOf(review["mandatoryOfflineChecks"])...) {
			md += "- " + s + "\n"
		}
		md += "\n仅支持后续尽调，不批准投资、签约或付款。\n"
		_ = t.put("investment/decision-memo.md", md)
		_ = t.put("investment/decision-memo.html", ReportDocument(str(t.config.Input["projectName"])+" · 投前初步尽调", ReportHTML(md)))
		return receipt("投前简报已生成："+labels[recommendation]+"，未授权投资或付款", ev), []string{"investment/decision-memo.json", "investment/decision-memo.md", "investment/decision-memo.html"}, nil
	case "request_investment_review":
		if memo == nil || t.config.Approval == nil {
			return nil, nil, errors.New("尚无简报或真人审批入口")
		}
		answer, e := t.config.Approval(ctx, map[string]any{"kind": "investment", "agentId": "invest_risk", "targetHumanId": "owner", "title": "请老板审阅投前尽调结果", "description": "只选择继续尽调或暂缓，不批准投资、签约或付款。", "details": map[string]any{"summary": str(memo["recommendationLabel"]) + "：" + str(memo["rationale"]), "criticalGaps": memo["criticalGaps"], "environment": memo["executionBoundary"]}})
		if e != nil {
			return nil, nil, e
		}
		decision := "pause"
		label := "老板选择暂缓项目"
		if answer["approved"] == true {
			decision = "continue_diligence"
			label = "老板选择继续尽调"
		}
		ev := map[string]any{"projectName": t.config.Input["projectName"], "decision": decision, "decisionLabel": label, "note": answer["note"], "recordedAt": now(), "investmentAuthorized": false, "paymentExecuted": false}
		ev["approvalActorKind"] = approvalActorKind(answer)
		if approvalActorKind(answer) == "isolated_test_operator" {
			label = "隔离测试账号脚本提交样例尽调方向回执，不代表老板真人业务决定"
			ev["decisionLabel"] = label
		}
		_ = t.put("investment/owner-decision.json", ev)
		return receipt(label+"，未授权投资或付款", ev), []string{"investment/owner-decision.json"}, nil
	}
	return nil, nil, errors.New("尽调工具无效")
}
func nullableRatio(n, d any, scale float64) any {
	if n == nil || d == nil || number(d) <= 0 {
		return nil
	}
	return math.Round(number(n)/number(d)*scale*100) / 100
}
