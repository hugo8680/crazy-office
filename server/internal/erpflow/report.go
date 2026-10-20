package erpflow

import (
	"crazyoffice/server/internal/report"
	"encoding/csv"
	"encoding/json"
	"fmt"
	"html"
	"math"
	"math/big"
	"net/url"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"unicode"
)

func esc(v any) string {
	if v == nil {
		return ""
	}
	return html.EscapeString(fmt.Sprint(v))
}
func list(v any) string {
	var b strings.Builder
	b.WriteString("<ul>")
	for _, s := range Strings(v) {
		b.WriteString("<li>" + esc(s) + "</li>")
	}
	b.WriteString("</ul>")
	return b.String()
}
func money(cents int64) string {
	sign := ""
	if cents < 0 {
		sign = "-"
		cents = -cents
	}
	return fmt.Sprintf("%s%d.%02d", sign, cents/100, cents%100)
}

var reportPriceNumber = regexp.MustCompile(`(?i)^[+]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$`)

func renderQuoteSources(evidence M) string {
	priced, pending := []M{}, []M{}
	validPrice := func(q M) bool {
		if q["status"] != "priced" || q["price"] == nil {
			return false
		}
		raw := strings.TrimSpace(fmt.Sprint(q["price"]))
		if !reportPriceNumber.MatchString(raw) {
			return false
		}
		v, err := strconv.ParseFloat(raw, 64)
		return err == nil && !math.IsNaN(v) && !math.IsInf(v, 0) && v >= 0
	}
	for _, q := range Rows(evidence["quotes"]) {
		if validPrice(q) {
			priced = append(priced, q)
		} else {
			pending = append(pending, q)
		}
	}
	var b strings.Builder
	table := func(quotes []M, isPriced bool) {
		column := "确认事项"
		if isPriced {
			column = "公开标价"
		}
		b.WriteString("<table><thead><tr><th>来源</th><th>" + column + "</th><th>获取日期</th><th>配置与条款</th></tr></thead><tbody>")
		for _, q := range quotes {
			title := S(q["title"])
			if title == "" {
				title = "来源页面"
			}
			link := "来源链接不可用"
			rawURL := S(q["sourceUrl"])
			if u, err := url.Parse(rawURL); err == nil && (u.Scheme == "https" || u.Scheme == "http") && u.User == nil && u.Hostname() != "" && strings.IndexFunc(rawURL, unicode.IsSpace) < 0 && !strings.Contains(rawURL, `\`) {
				link = `<a href="` + esc(u.String()) + `" target="_blank" rel="noopener noreferrer">` + esc(u.Hostname()) + `</a>`
			}
			value := "未取得可用标价"
			if isPriced {
				price, _ := strconv.ParseFloat(strings.TrimSpace(fmt.Sprint(q["price"])), 64)
				currency := S(q["currency"])
				if currency == "" {
					currency = "币种未确认"
				}
				value = strconv.FormatFloat(price, 'f', -1, 64) + " " + currency
			} else if q["status"] == "multiple_price_candidates" {
				value = "同页多价，待核对"
			} else if q["status"] == "pending_inquiry" || q["status"] == "unpriced" {
				value = "待询价"
			}
			notes := []string{}
			if reason := S(q["reason"]); reason != "" {
				notes = append(notes, reason)
			} else if limitation := S(q["limitation"]); limitation != "" {
				notes = append(notes, limitation)
			}
			if selected := Strings(q["selectedConfiguration"]); len(selected) > 0 {
				notes = append(notes, "选定配置："+strings.Join(selected, "；"))
			} else if configuration := Strings(q["configurationEvidence"]); len(configuration) > 0 {
				notes = append(notes, "页面配置："+strings.Join(configuration, "；"))
			}
			for _, field := range []struct{ key, label string }{{"tax", "税费"}, {"shipping", "运费"}, {"warranty", "保修"}} {
				if value := S(q[field.key]); value != "" {
					notes = append(notes, field.label+"："+value)
				}
			}
			if len(notes) == 0 {
				notes = append(notes, "配置、税费、运输及保修待确认")
			}
			b.WriteString("<tr><td>" + esc(title) + "<br>" + link + "</td><td>" + esc(value) + "</td><td>" + esc(bj(q["fetchedAt"])) + "</td><td>" + esc(strings.Join(notes, "；")) + "</td></tr>")
		}
		b.WriteString("</tbody></table>")
	}
	if len(priced) > 0 {
		b.WriteString("<h2>公开标价</h2>")
		table(priced, true)
	} else {
		b.WriteString("<p>尚未取得可用报价</p>")
	}
	if len(pending) > 0 {
		b.WriteString(fmt.Sprintf("<details><summary>待确认来源（%d）</summary>", len(pending)))
		table(pending, false)
		b.WriteString("</details>")
	}
	return b.String()
}

func RenderReport(d M, r *Run, snapshot M) string {
	var b strings.Builder
	if r == nil {
		r = &Run{}
	}
	names := map[string]string{}
	for _, user := range Rows(snapshot["users"]) {
		names[S(user["id"])] = S(user["name"])
	}
	name := func(value any) string {
		if n := names[S(value)]; n != "" {
			return esc(n)
		}
		return esc(value)
	}
	products := map[string]string{}
	for _, p := range Rows(snapshot["products"]) {
		products[S(p["id"])] = S(p["name"])
	}
	statuses := map[string]string{"draft": "草稿", "awaiting_approval": "等待审批", "approved": "已批准", "completed": "已完成", "partially_received": "部分收货", "partially_shipped": "部分发货", "rejected": "已退回", "submitted": "待验收", "pending": "待处理", "posted": "已办理"}
	status := func(value any) string {
		if label := statuses[S(value)]; label != "" {
			return label
		}
		return S(value)
	}
	b.WriteString("<p>" + esc(rules(d)["title"]) + " · " + esc(d["id"]) + " · " + esc(status(d["status"])) + "</p>")
	proposal := Map(d["proposal"])
	plan, review := Map(proposal["plan"]), Map(proposal["review"])
	for i, t := range r.Tasks {
		if t == nil {
			continue
		}
		if len(plan) == 0 && (t.ID == "prepare" || i == 0) {
			plan = t.Result
		}
		if len(review) == 0 && (t.ID == "review" || i == 1) {
			review = t.Result
		}
	}
	if S(plan["summary"]) != "" {
		b.WriteString("<h2>办理内容</h2><p>" + esc(plan["summary"]) + "</p>")
	}
	combined := func(values ...any) []string {
		out := []string{}
		seen := map[string]bool{}
		for _, value := range values {
			for _, item := range Strings(value) {
				if item != "" && !seen[item] {
					seen[item] = true
					out = append(out, item)
				}
			}
		}
		return out
	}
	writeList := func(title string, values []string) {
		if len(values) > 0 {
			b.WriteString("<h3>" + esc(title) + "</h3>" + list(values))
		}
	}
	writeList("办理事项", Strings(plan["steps"]))
	writeList("待补充", combined(plan["missing"], review["missing"]))
	writeList("核对结论", combined(plan["checks"], review["checks"]))
	if summary := S(review["summary"]); summary != "" && summary != S(plan["summary"]) {
		b.WriteString("<p>" + esc(summary) + "</p>")
	}
	if _, present := r.QuoteEvidence["quotes"]; present {
		b.WriteString(renderQuoteSources(r.QuoteEvidence))
	}
	calculation := r.Calculation
	if len(calculation) == 0 {
		calculation = Map(proposal["calculation"])
	}
	lines := Rows(calculation["lines"])
	if len(lines) > 0 {
		label := "物品参考总额"
		switch d["type"] {
		case "purchase":
			label = "申请采购金额"
		case "sales":
			label = "申请销售金额"
		case "stocktake":
			label = "实盘参考总额"
		}
		b.WriteString("<h2>数量与金额</h2><p>" + esc(label) + " " + money(N(calculation["totalCents"])) + " 元。")
		if d["type"] == "stocktake" {
			var delta big.Int
			for _, l := range lines {
				var term big.Int
				term.Mul(big.NewInt(N(l["difference"])), big.NewInt(N(l["unitPriceCents"])))
				delta.Add(&delta, &term)
			}
			absolute := new(big.Int).Abs(new(big.Int).Set(&delta))
			whole, remainder := new(big.Int), new(big.Int)
			whole.QuoRem(absolute, big.NewInt(100), remainder)
			sign := ""
			if delta.Sign() < 0 {
				sign = "-"
			}
			b.WriteString(fmt.Sprintf("差异参考额 %s%s.%02d 元。", sign, whole.String(), remainder.Int64()))
		}
		b.WriteString("</p><table><thead><tr><th>产品</th><th>申请／实盘数量</th><th>核对时库存</th>")
		if d["type"] == "stocktake" {
			b.WriteString("<th>账面数量</th><th>差异</th>")
		}
		b.WriteString("<th>单价 元</th><th>金额 元</th></tr></thead><tbody>")
		for _, l := range lines {
			b.WriteString(fmt.Sprintf("<tr><td>%s</td><td>%d</td><td>%d</td>", esc(l["product"]), N(l["quantity"]), N(l["currentStock"])))
			if d["type"] == "stocktake" {
				b.WriteString(fmt.Sprintf("<td>%d</td><td>%d</td>", N(l["bookQuantity"]), N(l["difference"])))
			}
			b.WriteString("<td>" + money(N(l["unitPriceCents"])) + "</td><td>" + money(N(l["lineTotalCents"])) + "</td></tr>")
		}
		b.WriteString("</tbody></table>")
	}
	input := Map(d["input"])
	fields := []struct{ key, label string }{{"partner", "往来单位"}, {"expectedDate", "预计日期"}, {"objective", "项目目标"}, {"acceptanceCriteria", "验收标准"}, {"deliveryNote", "交付内容"}, {"operation", "办理类型"}, {"employeeId", "员工"}, {"originalDocumentId", "原领用单"}, {"position", "岗位"}, {"resourceRequirements", "设备与账号需求"}, {"periodStart", "开始日期"}, {"periodEnd", "结束日期"}, {"summary", "补充事项"}, {"purpose", "物品用途"}, {"sourceOnboardingDocumentId", "岗位准备单"}, {"quotationReference", "报价凭证"}, {"quotationNotes", "报价条件"}, {"note", "盘点依据"}}
	b.WriteString("<h2>申请资料</h2><table><tbody>")
	for _, f := range fields {
		value := S(input[f.key])
		if value == "" {
			continue
		}
		if f.key == "operation" {
			if value == "issue" {
				value = "领用"
			} else if value == "return" {
				value = "归还"
			}
		}
		text := esc(value)
		if f.key == "employeeId" {
			text = name(value)
		}
		b.WriteString("<tr><th>" + f.label + "</th><td>" + text + "</td></tr>")
	}
	b.WriteString("</tbody></table>")
	if d["type"] == "weekly_report" {
		facts := Map(input["facts"])
		if len(facts) > 0 {
			counts := businessDocumentSummary(facts)
			b.WriteString(fmt.Sprintf("<h2>本期工作记录</h2><p>%d份业务单据 · %d种业务类型</p>", N(counts["documentCount"]), N(counts["typeCount"])))
			b.WriteString("<table><thead><tr><th>员工</th><th>本期分配</th><th>本期提交</th><th>已验收</th><th>期末未结</th><th>期末逾期</th><th>交付验收</th></tr></thead><tbody>")
			for _, person := range Rows(facts["employees"]) {
				b.WriteString(fmt.Sprintf("<tr><td>%s</td><td>%d</td><td>%d</td><td>%d</td><td>%d</td><td>%d</td><td>%d</td></tr>", name(person["employeeId"]), N(person["assignedTasks"]), N(person["submittedTasks"]), N(person["completedTasks"]), N(person["pendingTasks"]), N(person["overdueTasks"]), N(person["acceptedDeliveries"])))
			}
			b.WriteString("</tbody></table>")
			if tasks := Rows(facts["tasks"]); len(tasks) > 0 {
				b.WriteString("<h3>本期已验收任务</h3><table><thead><tr><th>任务</th><th>负责人</th><th>验收人</th><th>验收日期</th></tr></thead><tbody>")
				for _, task := range tasks {
					b.WriteString("<tr><td>" + esc(task["title"]) + "</td><td>" + name(task["employeeId"]) + "</td><td>" + name(task["acceptedBy"]) + "</td><td>" + esc(bj(task["completedAt"])) + "</td></tr>")
				}
				b.WriteString("</tbody></table>")
			}
			if tasks := Rows(facts["taskFacts"]); len(tasks) > 0 {
				b.WriteString("<h3>期末任务明细</h3><table><thead><tr><th>任务</th><th>负责人</th><th>期末状态</th><th>截止日期</th></tr></thead><tbody>")
				for _, task := range tasks {
					b.WriteString("<tr><td>" + esc(task["title"]) + "</td><td>" + name(task["assigneeIdAtPeriodEnd"]) + "</td><td>" + esc(status(task["stateAtPeriodEnd"])) + "</td><td>" + esc(task["dueDate"]) + "</td></tr>")
				}
				b.WriteString("</tbody></table>")
			}
		}
	}
	if confirmation := Map(d["confirmation"]); S(confirmation["reference"]) != "" {
		actor := esc(confirmation["actorName"])
		if actor == "" {
			actor = name(confirmation["actorId"])
		}
		b.WriteString("<h2>办理确认</h2><table><tbody><tr><th>办理凭证</th><td>" + esc(confirmation["reference"]) + "</td></tr><tr><th>办理人</th><td>" + actor + "</td></tr><tr><th>办理日期</th><td>" + esc(bj(confirmation["createdAt"])) + "</td></tr><tr><th>办理意见</th><td>" + esc(confirmation["note"]) + "</td></tr></tbody></table>")
	}
	if approvals := Rows(d["approvals"]); len(approvals) > 0 {
		b.WriteString("<h2>审批记录</h2><table><thead><tr><th>审批人</th><th>结果</th><th>意见</th><th>日期</th></tr></thead><tbody>")
		for _, a := range approvals {
			approver := esc(a["actorName"])
			if approver == "" {
				approver = name(a["actorId"])
			}
			decision := status(a["decision"])
			if a["decision"] == "approved" {
				decision = "同意"
			}
			b.WriteString("<tr><td>" + approver + "</td><td>" + esc(decision) + "</td><td>" + esc(a["note"]) + "</td><td>" + esc(bj(a["createdAt"])) + "</td></tr>")
		}
		b.WriteString("</tbody></table>")
	}
	moves := []M{}
	for _, m := range Rows(snapshot["movements"]) {
		if m["documentId"] == d["id"] {
			moves = append(moves, m)
		}
	}
	if len(moves) > 0 {
		b.WriteString("<h2>实际库存流水</h2><table><thead><tr><th>产品</th><th>凭证</th><th>数量变动</th><th>结存</th><th>经办人</th><th>日期</th></tr></thead><tbody>")
		for _, m := range moves {
			product := products[S(m["productId"])]
			if product == "" {
				product = S(m["productId"])
			}
			b.WriteString(fmt.Sprintf("<tr><td>%s</td><td>%s</td><td>%d</td><td>%d</td><td>%s</td><td>%s</td></tr>", esc(product), esc(m["reference"]), N(m["delta"]), N(m["balance"]), name(m["actorId"]), esc(bj(m["createdAt"]))))
		}
		b.WriteString("</tbody></table>")
	}
	return report.Document(S(d["title"]), b.String())
}

func CSV(rows []M) string {
	if len(rows) == 0 {
		return "\ufeff"
	}
	keys := []string{}
	for key := range rows[0] {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	safe := func(v any) string {
		if v == nil {
			return ""
		}
		var text string
		switch x := v.(type) {
		case string:
			text = x
		case map[string]any, []any, []M:
			raw, _ := json.Marshal(v)
			text = string(raw)
		default:
			text = fmt.Sprint(x)
		}
		trim := strings.TrimLeftFunc(text, unicode.IsSpace)
		if len(trim) > 0 && strings.ContainsRune("=+@-", rune(trim[0])) {
			text = "'" + text
		}
		return text
	}
	var b strings.Builder
	b.WriteString("\ufeff")
	w := csv.NewWriter(&b)
	w.UseCRLF = true
	header := []string{}
	for _, k := range keys {
		header = append(header, safe(k))
	}
	_ = w.Write(header)
	for _, row := range rows {
		values := []string{}
		for _, k := range keys {
			values = append(values, safe(row[k]))
		}
		_ = w.Write(values)
	}
	w.Flush()
	return b.String()
}
