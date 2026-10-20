package erpflow

import (
	"math"
	"strings"
	"testing"
)

func TestQuoteExportSeparatesPublicPricesFromUnconfirmedSources(t *testing.T) {
	evidence := M{"quotes": []M{
		{"title": "公开配置页", "status": "priced", "price": 1999, "currency": "CNY", "sourceUrl": "https://supplier.test/config", "fetchedAt": "2026-10-20T00:00:00Z", "selectedConfiguration": []string{"32GB RAM", "1TB SSD"}, "tax": "未知", "warranty": "三年待确认", "reason": "税费待核对"},
		{"title": "供应商首页", "status": "pending_inquiry", "price": nil, "sourceUrl": "https://supplier.test/", "reason": "页面未公开整机价格"},
		{"title": "多价目录", "status": "multiple_price_candidates", "price": 123, "currency": "CNY", "sourceUrl": "https://supplier.test/catalog", "reason": "同页价格未绑定配置"},
		{"title": "<script>不可信标题</script>", "status": "unknown_internal_status", "sourceUrl": "https://user:password@supplier.test/", "reason": "<img src=x>"},
	}}
	html := RenderReport(M{"type": "purchase"}, &Run{QuoteEvidence: evidence}, nil)
	parts := strings.SplitN(html, "<details>", 2)
	if len(parts) != 2 {
		t.Fatal("unconfirmed sources must be collapsed separately")
	}
	for _, expected := range []string{"<h2>公开标价</h2>", "1999 CNY", "选定配置：32GB RAM；1TB SSD", "税费：未知；保修：三年待确认"} {
		if !strings.Contains(parts[0], expected) {
			t.Fatalf("priced section missing %q", expected)
		}
	}
	for _, unexpected := range []string{"供应商首页", "多价目录", "123 CNY"} {
		if strings.Contains(parts[0], unexpected) {
			t.Fatalf("unverified source promoted into prices: %s", unexpected)
		}
	}
	for _, expected := range []string{"待确认来源（3）", "供应商首页", "https://supplier.test/", "同页多价，待核对", "页面未公开整机价格", "&lt;script&gt;", "&lt;img"} {
		if !strings.Contains(parts[1], expected) {
			t.Fatalf("source detail missing %q", expected)
		}
	}
	for _, unexpected := range []string{"供应商报价", "pending_inquiry", "multiple_price_candidates", "unknown_internal_status", "user:password", "<script>", "<img"} {
		if strings.Contains(html, unexpected) {
			t.Fatalf("unsafe or misleading source output %q", unexpected)
		}
	}
}

func TestQuoteExportShowsNoUsablePriceForInvalidOrUnconfirmedAmounts(t *testing.T) {
	quotes := []M{}
	for _, price := range []any{nil, "", math.NaN(), math.Inf(1), -1, true, "0xFF", "0x1p2"} {
		quotes = append(quotes, M{"title": "待确认页面", "status": "priced", "price": price, "sourceUrl": "https://supplier.test/"})
	}
	quotes = append(quotes, M{"title": "数字候选页", "status": "pending_inquiry", "price": 99, "currency": "CNY"})
	html := renderQuoteSources(M{"quotes": quotes})
	for _, expected := range []string{"尚未取得可用报价", "待确认来源（9）", "数字候选页", "https://supplier.test/"} {
		if !strings.Contains(html, expected) {
			t.Fatalf("missing source fact %q", expected)
		}
	}
	for _, unexpected := range []string{"<h2>公开标价", "99 CNY", "NaN", "+Inf", "0xFF"} {
		if strings.Contains(html, unexpected) {
			t.Fatalf("invalid amount promoted into price: %s", unexpected)
		}
	}
	if !strings.Contains(renderQuoteSources(M{"quotes": []M{}}), "尚未取得可用报价") {
		t.Fatal("empty evidence hides absence of quotes")
	}
	if !strings.Contains(renderQuoteSources(M{"quotes": []M{{"status": "priced", "price": 0, "currency": "CNY"}}}), "0 CNY") {
		t.Fatal("explicit zero public price was discarded")
	}
}

func TestBusinessExportContainsResultsReceiptsAndLimitationsWithoutExecutionMetadata(t *testing.T) {
	d := M{"id": "DOC-export", "type": "purchase", "title": "采购存储服务器", "status": "completed", "input": M{"partner": "真实供应商", "quotationReference": "Q-2026-018"}, "approvals": []M{{"actorName": "王经理", "decision": "approved", "note": "配置已核对", "createdAt": "2026-10-20T00:00:00Z"}}}
	r := &Run{Model: "DO_NOT_RENDER_MODEL", Tasks: []*Task{{ID: "prepare", Name: "DO_NOT_RENDER_EMPLOYEE", Role: "DO_NOT_RENDER_ROLE", ToolCalls: 99, Result: M{"summary": "采购两台存储服务器", "steps": []string{"确认到货日期"}, "checks": []string{"数量及申请金额一致"}, "missing": []string{"保修条款待确认"}}}, {ID: "review", Result: M{"summary": "规格符合申请范围", "checks": []string{"数量及申请金额一致"}}}}, Events: []M{{"type": "tool", "message": "DO_NOT_RENDER_TRACE"}}, Calculation: M{"lines": []M{{"product": "存储服务器", "quantity": 2, "unitPriceCents": 10000, "lineTotalCents": 20000}}, "totalCents": 20000}}
	snapshot := M{"users": []M{{"id": "warehouse", "name": "刘仓管"}}, "products": []M{{"id": "server", "name": "存储服务器"}}, "movements": []M{{"documentId": "DOC-export", "productId": "server", "delta": 2, "balance": 2, "reference": "IN-020", "actorId": "warehouse", "createdAt": "2026-10-20T01:00:00Z"}}}
	html := RenderReport(d, r, snapshot)
	for _, v := range []string{"采购两台存储服务器", "规格符合申请范围", "保修条款待确认", "Q-2026-018", "IN-020", "刘仓管", "王经理", "200.00"} {
		if !strings.Contains(html, v) {
			t.Fatalf("missing business content %q", v)
		}
	}
	for _, v := range []string{"DO_NOT_RENDER", "执行记录", "工具调用", "模型", "虚拟员工", "Agent"} {
		if strings.Contains(html, v) {
			t.Fatalf("execution metadata leaked %q", v)
		}
	}
	if strings.Count(html, "数量及申请金额一致") != 1 {
		t.Fatal("duplicate shared check")
	}
}
func TestWeeklyExportContainsFrozenEmployeeAndAcceptedTaskFacts(t *testing.T) {
	d := M{"id": "week", "type": "weekly_report", "title": "项目周报", "status": "awaiting_approval", "input": M{"periodStart": "2026-10-12", "periodEnd": "2026-10-18", "facts": M{"basis": "DO_NOT_RENDER_INTERNAL_BASIS", "scoresAssigned": false, "employees": []M{{"employeeId": "employee", "assignedTasks": 2, "submittedTasks": 2, "completedTasks": 1, "pendingTasks": 1, "overdueTasks": 0}}, "tasks": []M{{"title": "交付客户清单", "employeeId": "employee", "acceptedBy": "reviewer", "completedAt": "2026-10-18T00:00:00Z"}}, "taskFacts": []M{{"title": "验收材料", "assigneeIdAtPeriodEnd": "employee", "stateAtPeriodEnd": "submitted", "dueDate": "2026-10-18"}}}}}
	html := RenderReport(d, &Run{}, M{"users": []M{{"id": "employee", "name": "李明"}, {"id": "reviewer", "name": "王经理"}}})
	for _, v := range []string{"本期工作记录", "本期分配", "本期提交", "期末未结", "交付客户清单", "李明", "王经理", "待验收", "2026-10-18 08:00:00 +08:00"} {
		if !strings.Contains(html, v) {
			t.Fatalf("missing frozen fact %q", v)
		}
	}
	if strings.Contains(html, "DO_NOT_RENDER") || strings.Contains(html, "scoresAssigned") {
		t.Fatal("internal fact annotations rendered")
	}
}
func TestStocktakeDifferenceValuationDoesNotOverflowInt64(t *testing.T) {
	d := M{"type": "stocktake", "title": "库存盘点"}
	r := &Run{Calculation: M{"totalCents": 0, "lines": []M{{"product": "设备", "quantity": 0, "unitPriceCents": int64(1000000000000), "difference": int64(-1000000000), "bookQuantity": int64(1000000000)}}}}
	html := RenderReport(d, r, nil)
	if !strings.Contains(html, "差异参考额 -10000000000000000000.00 元") {
		t.Fatal("difference value overflowed or rounded")
	}
	if !strings.Contains(html, "账面数量") || !strings.Contains(html, "差异") {
		t.Fatal("discrepancy columns omitted")
	}
}

func TestBusinessConfirmationExportPreservesUserReceiptWithoutInventingExternalAcceptance(t *testing.T) {
	d := M{"type": "project_delivery", "status": "completed", "confirmation": M{"reference": "DEL-<script>", "note": "用户提供验收编号；客户签名仍待核对", "actorName": "王经理", "actorId": "manager", "createdAt": "2026-10-20T00:00:00Z"}}
	html := RenderReport(d, nil, nil)
	for _, v := range []string{"办理确认", "DEL-&lt;script&gt;", "王经理", "2026-10-20 08:00:00 +08:00", "客户签名仍待核对"} {
		if !strings.Contains(html, v) {
			t.Fatal("confirmation export dropped a recorded fact", v)
		}
	}
	if strings.Contains(html, "<script>") || strings.Contains(html, "客户已签收") {
		t.Fatal("confirmation was unsafe or invented external acceptance")
	}
}
