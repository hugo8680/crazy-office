package tools

import (
	"errors"
	"fmt"
	"math/big"
	"regexp"
	"strings"
)

// ValidateReport checks explicit finance amounts against deterministic receipts.
// It does not approve prose, source authenticity, or unsupplied financial claims.
func ValidateReport(content string, state map[string]any) error {
	toolResults, _ := state["toolResults"].(map[string]any)
	toolResults = clone(toolResults)
	if err := validateBusinessReport(content, toolResults); err != nil {
		return err
	}
	metrics, _ := toolResults["calculate_finance"].(map[string]any)
	if metrics == nil {
		return nil
	}
	// Normalize typed Go maps as well as persisted generic JSON maps.
	metrics = clone(metrics)
	years, _ := metrics["years"].(map[string]any)
	fields := map[string]string{"营业收入": "revenue", "营收": "revenue", "毛利": "gross_profit", "经营利润": "operating_profit", "净利润": "net_profit", "期末现金": "closing_cash", "现金流入": "cash_in", "现金流出": "cash_out", "净现金流": "net_cash_flow"}
	amounts := map[string]map[int64]bool{}
	for _, metric := range fields {
		amounts[metric] = map[int64]bool{}
		values := []int64{}
		for _, value := range years {
			row, _ := value.(map[string]any)
			if n, err := Cents(row[metric]); err == nil {
				amounts[metric][n] = true
				values = append(values, n)
			}
		}
		if len(values) == 2 {
			amounts[metric][values[0]-values[1]] = true
			amounts[metric][values[1]-values[0]] = true
		}
	}
	re := regexp.MustCompile(`(营业收入|营收|毛利|经营利润|净利润|期末现金|现金流入|现金流出|净现金流)[^0-9+\-\n]{0,12}([+-]?[0-9][0-9,]*(?:\.[0-9]+)?)\s*(亿元|万元|万人民币|元|CNY|USD)`)
	for _, m := range re.FindAllStringSubmatch(content, -1) {
		currency := str(metrics["currency"])
		if (m[3] == "USD" || m[3] == "CNY") && currency != "" && m[3] != currency {
			return errors.New("报告币种与财务底稿不一致，未保存")
		}
		r, ok := new(big.Rat).SetString(strings.ReplaceAll(m[2], ",", ""))
		if !ok {
			return errors.New("报告金额无效")
		}
		scale := int64(100)
		if m[3] == "万元" || m[3] == "万人民币" {
			scale = 1000000
		} else if m[3] == "亿元" {
			scale = 10000000000
		}
		r.Mul(r, big.NewRat(scale, 1))
		if !r.IsInt() || !r.Num().IsInt64() || !amounts[fields[m[1]]][r.Num().Int64()] {
			return fmt.Errorf("报告中%s%s%s与确定性财务底稿不一致，请核对元/万元/分和年份；报告尚未保存", m[1], m[2], m[3])
		}
	}
	return nil
}
