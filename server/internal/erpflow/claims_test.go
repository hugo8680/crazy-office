package erpflow

import "testing"

func TestClaimsRejectUnitAndTypeHallucinations(t *testing.T) {
	d := M{"type": "purchase"}
	c := M{"totalCents": int64(9600000), "lines": []M{{"unitPriceCents": int64(1200000), "lineTotalCents": int64(9600000)}}}
	for _, text := range []string{"参考总价960万元", "总价为12000元", "总金额12000元", "合计12000元", "金额96000.001元", "报价已核实100000元"} {
		if validateClaims(text, d, c) == nil {
			t.Errorf("accepted false claim %q", text)
		}
	}
	for _, text := range []string{"参考总价96,000.00元，单价12000元", "参考总价9.6万元", "工具计算9600000分", "5分钟后再次检查"} {
		if e := validateClaims(text, d, c); e != nil {
			t.Errorf("rejected %q: %v", text, e)
		}
	}
	d["type"] = "weekly_report"
	c["facts"] = M{"businessDocuments": []M{{"type": "resource"}, {"type": "resource"}, {"type": "purchase"}}}
	if validateClaims("3类业务单据", d, c) == nil {
		t.Fatal("counted documents as types")
	}
	if e := validateClaims("3份业务单据，2类业务单据", d, c); e != nil {
		t.Fatal(e)
	}
}

func TestClaimsCheckedBeforeModelResultSaved(t *testing.T) {
	args := M{"summary": "参考总价960万元，交两名真实员工依次审批。", "steps": []string{}, "checks": []string{"已核对原始台账"}, "missing": []string{}}
	if e := validate(args, M{"type": "purchase"}, M{"totalCents": int64(9600000)}, false); e == nil {
		t.Fatal("model self verification bypassed exact money check")
	}
}

func TestApprovalRuleDoesNotCrossSentences(t *testing.T) {
	for _, text := range []string{"无需采购。仍按原流程审批", "不需要询价，归还前仍需两人审批", "无需补货；等待负责人审批"} {
		if noApproval.MatchString(text) {
			t.Errorf("false approval bypass: %s", text)
		}
	}
	for _, text := range []string{"无需审批", "不需要真人审批", "不用负责人审批", "免除人工审批"} {
		if !noApproval.MatchString(text) {
			t.Errorf("missed approval bypass: %s", text)
		}
	}
}

func TestHistoricalStockCostAndMissingAmountDoNotBecomeCurrentFacts(t *testing.T) {
	d := M{"type": "project_delivery"}
	c := M{"hasAmount": false, "currentInventory": []M{{"productId": "server", "currentQuantity": 6}}, "postedStocktakes": []M{{"documentId": "COUNT", "posted": true, "bookQuantityAtCreation": 4, "countedQuantity": 6, "postedDelta": 2}}, "relatedDocuments": []M{{"type": "stocktake", "status": "completed", "lines": []M{{"unitPriceCents": 1200000}}}}}
	for _, text := range []string{
		"当前库存实盘6台，系统显示4台，存在账实差异需处理。",
		"确认盘点差异原因并更新库存记录。",
		"盘点已登记；再次更新库存记录。",
		"参考价为库存成本价12000元。",
		"销售价与库存成本价不同需核实。",
		"销售价与参考价不一致属于异常。",
		"本周报金额为0.00元。",
		"无实际业务金额产生。",
	} {
		if e := validateClaims(text, d, c); e == nil {
			t.Errorf("unsupported assertion accepted: %s", text)
		}
	}
	for _, text := range []string{
		"创建时的历史账面4台，盘点已过账+2，当前库存6台。",
		"历史系统显示4台；当前库存6台。",
		"差异原因尚未核验，需核查原始凭证；已登记差异不重复更新库存记录。",
		"系统未做成本核算，参考单价不代表成本价。",
		"采购价与销售价口径不同，不能仅凭价差认定异常。",
		"关联采购单价12000元；本周报不统计业务金额，不代表金额为0元。",
		"库存成本价尚未核验，需要财务另行核算。",
		"如发现新的差异，另行发起盘点并更新库存记录。",
		"当前库存尚未核验，不能断言系统显示4台。",
		"仓库确认实物归还后更新库存余额。",
	} {
		if e := validateClaims(text, d, c); e != nil {
			t.Errorf("honest scope or allowed action rejected: %s: %v", text, e)
		}
	}
}
