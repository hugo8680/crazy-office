package erpflow

import (
	"crazyoffice/server/internal/report"
	"encoding/csv"
	"encoding/json"
	"fmt"
	"html"
	"net/url"
	"sort"
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
func RenderReport(d M, r *Run, snapshot M) string {
	var b strings.Builder
	b.WriteString("<p>" + esc(rules(d)["title"]) + " · " + esc(d["id"]) + "</p><p>本报告保留虚拟员工的方案与独立核对。审批与实际办理见下方业务记录。</p>")
	for _, t := range r.Tasks {
		if t.Result == nil {
			continue
		}
		b.WriteString("<h2>" + esc(t.Name) + " " + esc(t.Role) + "</h2><p>" + esc(t.Result["summary"]) + "</p>")
		if len(Strings(t.Result["steps"])) > 0 {
			b.WriteString("<h3>办理步骤</h3>" + list(t.Result["steps"]))
		}
		b.WriteString("<h3>核对事项</h3>" + list(t.Result["checks"]))
		if len(Strings(t.Result["missing"])) > 0 {
			b.WriteString("<h3>待确认</h3>" + list(t.Result["missing"]))
		}
	}
	if quotes := Rows(r.QuoteEvidence["quotes"]); len(quotes) > 0 {
		b.WriteString("<h2>真实报价来源</h2><p>本次实际抓取的候选网页；价格、配置、税费及保修分别核对。</p><table><thead><tr><th>候选及来源</th><th>标价</th><th>获取时间</th><th>状态及缺口</th></tr></thead><tbody>")
		for _, q := range quotes {
			link := esc(q["sourceUrl"])
			if u, e := url.Parse(S(q["sourceUrl"])); e == nil && (u.Scheme == "https" || u.Scheme == "http") && u.User == nil && u.Hostname() != "" {
				link = `<a href="` + esc(u.String()) + `" target="_blank" rel="noopener noreferrer">` + esc(u.Hostname()) + `</a>`
			}
			price := "待询价"
			if q["status"] == "priced" && q["price"] != nil {
				price = esc(q["currency"]) + " " + esc(q["price"])
			}
			b.WriteString("<tr><td>" + esc(q["title"]) + "<br>" + link + "</td><td>" + price + "</td><td>" + esc(q["fetchedAt"]) + "</td><td>" + esc(q["status"]) + " " + esc(q["reason"]) + "</td></tr>")
		}
		b.WriteString("</tbody></table>")
	}
	lines := Rows(r.Calculation["lines"])
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
		b.WriteString(fmt.Sprintf("<h2>工具核算</h2><p>%s %s 元。", label, money(N(r.Calculation["totalCents"]))))
		if d["type"] == "stocktake" {
			var delta int64
			for _, l := range lines {
				delta += N(l["difference"]) * N(l["unitPriceCents"])
			}
			b.WriteString(fmt.Sprintf("差异参考额 %s 元；数量原因和调整仍待真人确认。", money(delta)))
		} else {
			b.WriteString("价格以工作单输入为准。")
		}
		b.WriteString("</p><table><thead><tr><th>产品</th><th>申请／实盘数量</th><th>核对时库存</th><th>参考单价 元</th><th>参考金额 元</th></tr></thead><tbody>")
		for _, l := range lines {
			b.WriteString(fmt.Sprintf("<tr><td>%s</td><td>%d</td><td>%d</td><td>%s</td><td>%s</td></tr>", esc(l["product"]), N(l["quantity"]), N(l["currentStock"]), money(N(l["unitPriceCents"])), money(N(l["lineTotalCents"]))))
		}
		b.WriteString("</tbody></table>")
	}
	statuses := map[string]string{"draft": "草稿", "awaiting_approval": "等待审批", "approved": "已批准，等待实际办理", "completed": "已完成", "partially_received": "部分收货", "partially_shipped": "部分发货", "rejected": "已退回"}
	status := statuses[S(d["status"])]
	if status == "" {
		status = S(d["status"])
	}
	b.WriteString(fmt.Sprintf("<h2>当前业务与真人办理</h2><p>单据状态 %s，版本 %d。</p>", esc(status), N(d["version"])))
	if approvals := Rows(d["approvals"]); len(approvals) > 0 {
		b.WriteString("<table><thead><tr><th>审批人</th><th>意见</th><th>北京时间</th></tr></thead><tbody>")
		for _, a := range approvals {
			b.WriteString("<tr><td>" + esc(a["actorName"]) + "</td><td>" + esc(a["decision"]) + " " + esc(a["note"]) + "</td><td>" + esc(bj(a["createdAt"])) + "</td></tr>")
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
		b.WriteString("<h3>实际库存流水</h3><table><thead><tr><th>凭证</th><th>数量变动</th><th>变动后余额</th><th>北京时间</th></tr></thead><tbody>")
		for _, m := range moves {
			b.WriteString(fmt.Sprintf("<tr><td>%s</td><td>%d</td><td>%d</td><td>%s</td></tr>", esc(m["reference"]), N(m["delta"]), N(m["balance"]), esc(bj(m["createdAt"]))))
		}
		b.WriteString("</tbody></table>")
	}
	count := 0
	for _, e := range r.Events {
		if e["type"] == "tool" {
			count++
		}
	}
	b.WriteString(fmt.Sprintf("<h2>执行记录</h2><p>模型 %s。%d 个独立岗位，%d 次工具调用。</p>", esc(r.Model), len(r.Tasks), count))
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
