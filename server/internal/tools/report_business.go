package tools

import (
	"errors"
	"fmt"
	"regexp"
	"strings"
)

func positiveClaim(content, pattern string) bool {
	re := regexp.MustCompile(pattern)
	for _, m := range re.FindAllStringIndex(content, -1) {
		prefix := []rune(content[:m[0]])
		if len(prefix) > 8 {
			prefix = prefix[len(prefix)-8:]
		}
		if regexp.MustCompile(`(?:尚未|并未|未|不|无|没有|并非|不能|无需|未曾|未计入|不包含|不包括|未增加|未设置|不含|如需|若需|需另行|待确认)(?:任何|额外|独立|新增)?[\s“"'‘]*$`).MatchString(string(prefix)) {
			continue
		}
		return true
	}
	return false
}
func scriptedApproval(results map[string]any) bool {
	for _, name := range []string{"apply_defense", "request_onboarding_approval", "register_onboarding", "request_investment_review"} {
		m, _ := results[name].(map[string]any)
		if m["approvalActorKind"] == "isolated_test_operator" {
			return true
		}
		note := str(m["approvalNote"])
		if note == "" {
			note = str(m["note"])
		}
		if strings.Contains(note, "local-acceptance-operator") && strings.Contains(note, "脚本操作") {
			return true
		}
	}
	return false
}
func validateBusinessReport(content string, results map[string]any) error {
	if scriptedApproval(results) && positiveClaim(content, `(?:已获(?:得)?|获得|已|经|通过|获|取得|由)[^。；\n]{0,12}真人(?:负责人)?(?:审批|批准)|真人(?:负责人)?(?:已|确认)[^。；\n]{0,6}(?:批准|审批)`) {
		return errors.New("本次审批来自隔离测试账号脚本，不能写成已获得真人审批或真人批准；请明确样例范围后重新交付")
	}
	if scriptedApproval(results) && positiveClaim(content, `(?:老板|真人|真实(?:人事)?负责人)[^。；\n]{0,8}(?:已(?:经)?|实际)(?:决定|批准|同意|选择)|老板(?:选择|决定)(?:继续尽调|暂缓项目)`) {
		return errors.New("本次是隔离测试账号脚本回执，不可写成老板或真实负责人实际作出的业务决定")
	}
	if _, ok := results["review_investment"]; ok {
		if err := validateInvestmentClaims(content); err != nil {
			return err
		}
	}
	if build, ok := results["build_database"].(map[string]any); ok {
		// Reports cite the executed schema and test receipts. Optional write examples
		// have not been exercised against the delivered database and can conflict
		// with retained validation rows; do not present them as ready to execute.
		for _, block := range regexp.MustCompile("(?is)```sql\\s*\\n(.*?)```").FindAllStringSubmatch(content, -1) {
			if regexp.MustCompile(`(?im)^\s*(?:INSERT\s+INTO|UPDATE\s+|DELETE\s+FROM)`).MatchString(block[1]) {
				return errors.New("数据库报告请引用已执行的schema.sql与tests.json，不输出未经验证的INSERT/UPDATE/DELETE写入示例；示例可能与现存验证样本冲突，请移除后交付")
			}
		}
		tables, _ := build["tables"].(map[string]any)
		count := 0
		for _, n := range tables {
			count += int(number(n))
		}
		if count > 0 && positiveClaim(content, `数据库[^。；\n]{0,10}(?:仅(?:有|包含|保留)结构(?:定义)?|(?:是|为)空库|没有(?:任何)?(?:记录|数据))|(?:全部|所有)?测试数据[^。；\n]{0,8}(?:完全|全部|均已|已经全部)回滚|测试(?:数据|样本)[^。；\n]{0,6}已完全回滚`) {
			return fmt.Errorf("实际交付数据库仍保留%d条记录；build样本已提交，只有后续测试用例临时变更回滚，不能说仅结构或所有测试数据已清空", count)
		}
	}
	if registration, ok := results["register_onboarding"].(map[string]any); ok && registration["registered"] == true && registration["registryWritten"] == true {
		for _, clause := range regexp.MustCompile(`[。；;\n]`).Split(content, -1) {
			historical := regexp.MustCompile(`预检|早期|登记前|预审|初审`).MatchString(clause) && !regexp.MustCompile(`当前|最终|目前|现在`).MatchString(clause)
			if !historical && positiveClaim(clause, `(?:主册|员工(?:登记)?册|员工台账|员工登记|行政登记)[^。；\n]{0,20}(?:未(?:完成|写入|最终)|待(?:最终|确认|写入|登记)|尚未(?:完成|写入))|(?:未|尚未|尚需)[^。；\n]{0,8}(?:写入|登记)[^。；\n]{0,8}(?:主册|员工台账|员工登记册)`) {
				return errors.New("最终登记回执已确认registered=true且registryWritten=true；可以保留早期预检未写入的历史，但不能把最终状态写为未登记。设备、账号、权限仍按资源待办办理")
			}
			if registration["employmentConfirmedBySubmitter"] == true && !regexp.MustCompile(`正式业务|转正式|真实业务`).MatchString(clause) && regexp.MustCompile(`(?:需|需要|待|尚需)[^。；\n]{0,24}(?:最终)?录用审批`).MatchString(clause) {
				return errors.New("提交方已确认录用，本次行政登记已完成；不能把本次录用改为待最终审批。若说明样例转正式条件，请明确正式业务需按真实材料重新办理行政流程")
			}
		}
		if positiveClaim(content, `录用(?:决定|状态|资格|条件)[^。；\n]{0,10}(?:不明|未知|未确认|待确认|尚未确认)|(?:再次确认|重新审批)[^。；\n]{0,8}录用`) {
			return errors.New("原始输入已由提交者确认录用；employmentDecisionMade=false表示工具未作录用决定，不代表录用状态未知")
		}
	}
	if analysis, ok := results["analyze_traffic"].(map[string]any); ok {
		defense, _ := results["apply_defense"].(map[string]any)
		re := regexp.MustCompile(`(?:阈值|滑动|每来源|限速)[^\n]{0,30}?([0-9]+(?:\.[0-9]+)?)\s*(?:次|请求)\s*[/／每]\s*([0-9]+(?:\.[0-9]+)?)\s*秒`)
		for _, m := range re.FindAllStringSubmatch(content, -1) {
			rate, window := number(m[1]), number(m[2])
			valid := rate == number(analysis["threshold"]) && window == number(analysis["windowSeconds"])
			if defense["rateLimit"] != nil {
				valid = valid || rate == number(defense["rateLimit"]) && window == number(defense["windowSeconds"])
			}
			if !valid {
				return fmt.Errorf("报告中的阈值/滑动时间窗与实际分析或策略不一致：分析为%v次/%v秒；日志总跨度不能冒充滑窗", analysis["threshold"], analysis["windowSeconds"])
			}
		}
	}
	if _, ok := results["estimate_delivery"]; ok {
		if regexp.MustCompile(`工期\s*[（(]\s*天\s*[)）]`).MatchString(content) {
			return errors.New("工作包days字段是人日，表格须标人日；工作日用startDay/endDay及总排期表示，不能混为工期(天)")
		}
		for _, clause := range regexp.MustCompile(`[。；;\n，,！!？?]`).Split(content, -1) {
			if regexp.MustCompile(`不(?:增加|延长|含|包含)|未(?:增加|含|包含|计入|设置|预留)|无(?:时间|工期)|(?:如需|若需|待确认|另行确认)`).MatchString(clause) {
				continue
			}
			if positiveClaim(clause, `(?:时间|工期|排期|日历|日程|工作日)[^。；\n，,]{0,14}(?:缓冲|预留|余量)|(?:缓冲|预留)[^。；\n，,]{0,14}(?:时间|工期|工作日)`) {
				return errors.New("bufferPct只计算费用缓冲，不增加工作日；报告须区分人日、工作日和成本缓冲，不能称已加入时间或工期缓冲")
			}
		}
	}
	return nil
}
func validateInvestmentClaims(content string) error {
	if regexp.MustCompile(`(?:公开渠道|全网|互联网|公共记录中|所有公开(?:来源|记录))[^。；\n，,]{0,4}(?:无(?:任何)?(?:工商登记|知识产权|融资新闻|融资|诉讼|处罚|记录|证据)|没有|不存在|未存在)`).MatchString(content) {
		return errors.New("本次访问或检索未取得匹配证据，不等于公开渠道、全网或法律记录不存在；请限定到实际访问的来源和本次检索范围")
	}
	return nil
}
