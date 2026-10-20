package tools

import (
	"context"
	"errors"
	"fmt"
	"github.com/xuri/excelize/v2"
	"math"
	"math/big"
	"os"
	"regexp"
	"strconv"
	"strings"
)

var financeFields = []string{"revenue", "cost", "operating_expense", "other_income", "tax", "opening_cash", "cash_in", "cash_out", "closing_cash"}
var aliases = map[string]string{"年份": "year", "年度": "year", "月份": "month", "营收": "revenue", "收入": "revenue", "营业收入": "revenue", "营业成本": "cost", "成本": "cost", "经营费用": "operating_expense", "营业费用": "operating_expense", "其他收益": "other_income", "其他收入": "other_income", "所得税": "tax", "税费": "tax", "期初现金": "opening_cash", "现金流入": "cash_in", "现金流出": "cash_out", "期末现金": "closing_cash"}

func Cents(v any) (int64, error) {
	if v == nil || strings.TrimSpace(str(v)) == "" {
		return 0, errors.New("金额缺失")
	}
	s := strings.ReplaceAll(strings.TrimSpace(str(v)), ",", "")
	if len(s) > 128 || !regexp.MustCompile(`^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$`).MatchString(s) {
		return 0, errors.New("金额必须为十进制数值，不能包含分数或其他表达式")
	}
	if pos := strings.IndexAny(s, "eE"); pos >= 0 {
		exp, err := strconv.Atoi(s[pos+1:])
		if err != nil || exp > 18 || exp < -18 {
			return 0, errors.New("金额精度或范围超出支持范围")
		}
	}
	r, ok := new(big.Rat).SetString(s)
	if !ok {
		return 0, errors.New("金额无效")
	}
	r.Mul(r, big.NewRat(100, 1))
	if !r.IsInt() || !r.Num().IsInt64() {
		return 0, errors.New("金额最多两位小数且须在精确范围内")
	}
	n := r.Num().Int64()
	if n > 100000000000000 || n < -100000000000000 {
		return 0, errors.New("金额超出范围")
	}
	return n, nil
}
func (t *Toolbox) finance(ctx context.Context, name string, a map[string]any) (map[string]any, []string, error) {
	if name == "import_finance" {
		raw, e := source(t.config.Input["data"])
		if e != nil {
			return nil, nil, e
		}
		if m, ok := raw.(map[string]any); ok {
			for _, k := range []string{"rows", "records", "data"} {
				if m[k] != nil {
					raw = m[k]
					break
				}
			}
		}
		rows, err := strictMaps(raw, "财务资料")
		if err != nil {
			return nil, nil, err
		}
		if len(rows) != 24 {
			return nil, nil, errors.New("财务数据需要汇报年度及上一年度各12个月，共24条记录")
		}
		year := int(number(t.config.Input["year"]))
		if a["year"] != nil {
			year = int(number(a["year"]))
		}
		if year < 2000 || year > 2200 {
			return nil, nil, errors.New("汇报年度超出范围")
		}
		normalized := []map[string]any{}
		seen := map[string]bool{}
		for i, row := range rows {
			r := map[string]any{}
			for k, v := range row {
				k = strings.TrimSpace(k)
				if a, ok := aliases[k]; ok {
					k = a
				}
				r[k] = v
			}
			y, m := int(number(r["year"])), int(number(r["month"]))
			if (y != year && y != year-1) || m < 1 || m > 12 || number(r["year"]) != float64(y) || number(r["month"]) != float64(m) {
				return nil, nil, fmt.Errorf("第%d行年月无效", i+2)
			}
			key := fmt.Sprintf("%d-%02d", y, m)
			if seen[key] {
				return nil, nil, errors.New("重复月份：" + key)
			}
			seen[key] = true
			n := map[string]any{"year": y, "month": m}
			for _, f := range financeFields {
				c, e := Cents(r[f])
				if e != nil {
					return nil, nil, fmt.Errorf("第%d行%s：%w", i+2, f, e)
				}
				if c < 0 && f != "other_income" {
					return nil, nil, errors.New("非负字段出现负值：" + f)
				}
				n[f] = c
			}
			if n["opening_cash"].(int64)+n["cash_in"].(int64)-n["cash_out"].(int64) != n["closing_cash"].(int64) {
				return nil, nil, errors.New(key + "现金不平衡")
			}
			normalized = append(normalized, n)
		}
		p, e := t.safe("finance/finance.sqlite")
		if e != nil {
			return nil, nil, e
		}
		_ = os.MkdirAll(strings.TrimSuffix(p, "/finance.sqlite"), 0700)
		_ = os.Remove(p)
		db, e := openDB(p)
		if e != nil {
			return nil, nil, e
		}
		defer db.Close()
		cols := []string{}
		for _, f := range financeFields {
			cols = append(cols, f+" INTEGER NOT NULL")
		}
		_, e = db.ExecContext(ctx, "CREATE TABLE monthly_finance(year INTEGER NOT NULL,month INTEGER NOT NULL CHECK(month BETWEEN 1 AND 12),"+strings.Join(cols, ",")+",PRIMARY KEY(year,month))")
		if e != nil {
			return nil, nil, e
		}
		for _, r := range normalized {
			v := []any{r["year"], r["month"]}
			for _, f := range financeFields {
				v = append(v, r[f])
			}
			if _, e = db.ExecContext(ctx, "INSERT INTO monthly_finance VALUES (?,?,?,?,?,?,?,?,?,?,?)", v...); e != nil {
				return nil, nil, e
			}
		}
		rr, e := queryMaps(ctx, db, "SELECT * FROM monthly_finance ORDER BY year,month")
		if e != nil {
			return nil, nil, e
		}
		for i := 1; i < len(rr); i++ {
			if rr[i-1]["closing_cash"] != rr[i]["opening_cash"] {
				_ = os.Remove(p)
				return nil, nil, errors.New("跨月现金期初与上月期末不衔接")
			}
		}
		meta := map[string]any{"company": t.config.Input["company"], "year": year, "currency": "CNY", "rows": 24, "unit": "输入金额单位元；数据库按分存储", "isExample": t.config.Input["isExample"] == true || t.config.Input["example"] == true, "checks": []string{"两年各12个月完整", "年月唯一", "金额精确到分", "月度现金平衡", "跨月现金衔接"}}
		if t.config.Input["currency"] != nil {
			meta["currency"] = t.config.Input["currency"]
		}
		_ = t.put("finance/import.json", meta)
		csvRows := [][]any{{"year", "month"}}
		for _, f := range financeFields {
			csvRows[0] = append(csvRows[0], f)
		}
		for _, r := range rr {
			row := []any{r["year"], r["month"]}
			for _, f := range financeFields {
				row = append(row, number(r[f])/100)
			}
			csvRows = append(csvRows, row)
		}
		_ = t.put("finance/monthly.csv", writeCSV(csvRows))
		_ = os.Chmod(p, 0600)
		return receipt("已导入24个月财务数据并通过完整性与现金检查", meta), []string{"finance/finance.sqlite", "finance/import.json", "finance/monthly.csv"}, nil
	}
	var meta map[string]any
	if e := t.read("finance/import.json", &meta); e != nil {
		return nil, nil, errors.New("请先导入财务数据")
	}
	p, e := t.safe("finance/finance.sqlite")
	if e != nil {
		return nil, nil, e
	}
	db, e := openDB(p)
	if e != nil {
		return nil, nil, e
	}
	defer db.Close()
	rows, e := queryMaps(ctx, db, "SELECT * FROM monthly_finance ORDER BY year,month")
	if e != nil || len(rows) != 24 {
		return nil, nil, errors.New("财务底稿月份不完整")
	}
	year := int(number(meta["year"]))
	years := map[string]map[string]any{}
	centsByYear := map[int]map[string]int64{}
	for _, y := range []int{year - 1, year} {
		rr := []map[string]any{}
		for _, r := range rows {
			if int(number(r["year"])) == y {
				rr = append(rr, r)
			}
		}
		if len(rr) != 12 {
			return nil, nil, errors.New("财务月份不完整")
		}
		sums := map[string]int64{}
		for _, f := range financeFields {
			if f == "opening_cash" {
				sums[f] = int64(number(rr[0][f]))
			} else if f == "closing_cash" {
				sums[f] = int64(number(rr[11][f]))
			} else {
				for _, r := range rr {
					sums[f] += int64(number(r[f]))
				}
			}
		}
		sums["gross_profit"] = sums["revenue"] - sums["cost"]
		sums["operating_profit"] = sums["gross_profit"] - sums["operating_expense"]
		sums["net_profit"] = sums["operating_profit"] + sums["other_income"] - sums["tax"]
		sums["net_cash_flow"] = sums["cash_in"] - sums["cash_out"]
		values := map[string]any{}
		for k, n := range sums {
			values[k] = float64(n) / 100
		}
		if sums["revenue"] == 0 {
			values["gross_margin_pct"] = nil
		} else {
			values["gross_margin_pct"] = math.Round(float64(sums["gross_profit"])/float64(sums["revenue"])*1e6) / 1e4
		}
		years[strconv.Itoa(y)] = values
		centsByYear[y] = sums
	}
	yoy := map[string]any{}
	for _, k := range []string{"revenue", "cost", "gross_profit", "operating_profit", "net_profit", "closing_cash", "net_cash_flow"} {
		p, c := centsByYear[year-1][k], centsByYear[year][k]
		if p == 0 {
			yoy[k] = nil
		} else {
			yoy[k] = math.Round(float64(c-p)/math.Abs(float64(p))*1e6) / 1e4
		}
	}
	ev := map[string]any{"company": meta["company"], "year": year, "currency": meta["currency"], "isExample": meta["isExample"], "years": years, "yoyPct": yoy, "formulas": map[string]string{"gross_profit": "revenue-cost", "operating_profit": "gross_profit-operating_expense", "net_profit": "operating_profit+other_income-tax", "net_cash_flow": "cash_in-cash_out", "yoy_pct": "(本年-上年)/abs(上年)*100；分母为0则未知"}, "limitations": []string{"管理口径，不构成法定资产负债表或审计意见。", "现金流入流出未分经营、投资、筹资，不能称经营活动净现金。", "数据计算正确不代表原始数据真实。"}}
	ev["amountUnit"] = "本工具years金额为元；原始SQLite按分存储，已完成换算，不可再次除以或乘以100。"
	formatted := map[string]any{}
	for y, values := range years {
		row := map[string]string{}
		for k, n := range values {
			if strings.HasSuffix(k, "_pct") {
				continue
			}
			row[k] = fmt.Sprintf("%.2f 元", number(n))
		}
		formatted[y] = row
	}
	ev["amountsYuan"] = formatted
	if name == "audit_finance" {
		var integrity string
		_ = db.QueryRowContext(ctx, "PRAGMA integrity_check").Scan(&integrity)
		issues := []string{}
		if integrity != "ok" {
			issues = append(issues, "SQLite完整性失败")
		}
		for i, r := range rows {
			if number(r["opening_cash"])+number(r["cash_in"])-number(r["cash_out"]) != number(r["closing_cash"]) {
				issues = append(issues, "月度现金不平衡")
			}
			if i > 0 && number(rows[i-1]["closing_cash"]) != number(r["opening_cash"]) {
				issues = append(issues, "跨月现金不衔接")
			}
		}
		audit := map[string]any{"passed": len(issues) == 0, "independentRecalculation": true, "rowCount": len(rows), "integrityCheck": integrity, "errors": issues, "recalculated": ev, "checks": meta["checks"], "limitations": ev["limitations"]}
		_ = t.put("finance/audit.json", audit)
		return receipt("已从SQLite原始底稿独立重算与审校，计算不构成审计意见", audit), []string{"finance/audit.json"}, nil
	}
	_ = t.put("finance/annual.json", ev)
	_ = t.put("finance/metrics.json", ev)
	csvRows := [][]any{{"metric", strconv.Itoa(year - 1), strconv.Itoa(year), "yoyPct"}}
	for _, k := range append(financeFields, "gross_profit", "operating_profit", "net_profit", "net_cash_flow") {
		csvRows = append(csvRows, []any{k, years[strconv.Itoa(year-1)][k], years[strconv.Itoa(year)][k], yoy[k]})
	}
	_ = t.put("finance/annual.csv", writeCSV(csvRows))
	f := excelize.NewFile()
	_ = f.SetSheetName("Sheet1", "年度指标")
	for i, row := range csvRows {
		for j, v := range row {
			cell, _ := excelize.CoordinatesToCellName(j+1, i+1)
			_ = f.SetCellValue("年度指标", cell, v)
		}
	}
	_, _ = f.NewSheet("月度底稿")
	monthly := [][]any{{"year", "month"}}
	for _, field := range financeFields {
		monthly[0] = append(monthly[0], field)
	}
	for _, r := range rows {
		row := []any{r["year"], r["month"]}
		for _, field := range financeFields {
			row = append(row, number(r[field])/100)
		}
		monthly = append(monthly, row)
	}
	for i, row := range monthly {
		for j, v := range row {
			cell, _ := excelize.CoordinatesToCellName(j+1, i+1)
			_ = f.SetCellValue("月度底稿", cell, v)
		}
	}
	_, _ = f.NewSheet("口径与限制")
	for i, line := range stringsOf(ev["limitations"]) {
		_ = f.SetCellValue("口径与限制", fmt.Sprintf("A%d", i+1), line)
	}
	for _, sheet := range f.GetSheetList() {
		_ = f.SetColWidth(sheet, "A", "K", 22)
		_ = f.SetPanes(sheet, &excelize.Panes{Freeze: true, YSplit: 1, TopLeftCell: "A2", ActivePane: "bottomLeft"})
	}
	xp, _ := t.safe("finance/annual.xlsx")
	if e = f.SaveAs(xp); e != nil {
		return nil, nil, e
	}
	legacyXLSX, _ := t.safe("finance/annual-report.xlsx")
	if e = f.SaveAs(legacyXLSX); e != nil {
		return nil, nil, e
	}
	_ = os.Chmod(legacyXLSX, 0600)
	_ = f.Close()
	_ = os.Chmod(xp, 0600)
	md := "币种：" + str(meta["currency"]) + "。数据来源：用户提供资料。\n\n|指标|上年|本年|同比%|\n|---|---:|---:|---:|\n"
	for _, row := range csvRows[1:] {
		md += "|" + str(row[0]) + "|" + str(row[1]) + "|" + str(row[2]) + "|" + str(row[3]) + "|\n"
	}
	md += "\n## 口径与限制\n\n"
	for _, line := range stringsOf(ev["limitations"]) {
		md += "- " + line + "\n"
	}
	_ = t.put("finance/annual-report.html", ReportDocument(str(meta["company"])+" "+str(meta["year"])+"年度财务报表", ReportHTML(md)))
	return receipt("按分完成两年指标、现金与同比计算，已生成XLSX/CSV/HTML报表", ev), []string{"finance/metrics.json", "finance/annual.json", "finance/annual.csv", "finance/annual.xlsx", "finance/annual-report.xlsx", "finance/annual-report.html"}, nil
}
