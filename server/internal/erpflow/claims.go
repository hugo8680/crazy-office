package erpflow

import (
	"fmt"
	"math/big"
	"regexp"
	"strconv"
	"strings"
	"unicode/utf8"
)

var currencyClaim = regexp.MustCompile(`([+-]?[0-9]+(?:,[0-9]{3})*(?:\.[0-9]+)?)\s*(亿元|万元|元|分)`)
var totalClaimPrefix = regexp.MustCompile(`(?:参考总价|参考总额|总金额|采购金额|总价|总额|合计金额|金额合计|合计)[为是约：:\s]*$`)
var documentTypeClaim = regexp.MustCompile(`([0-9]+)\s*类(?:已完成的|已完成)?(?:业务)?单据`)
var currentStockClaim = regexp.MustCompile(`(?:当前(?:系统|账面)?(?:库存|账存)|最新(?:账面)?库存|系统(?:库存)?显示)[为是有：:\s]*(?:实盘)?\s*([0-9]+)\s*台`)
var historicStockContext = regexp.MustCompile(`(?:历史|当时|创建时|盘点前|原账面|快照)`)
var uncertainClaim = regexp.MustCompile(`(?:未核验|尚未核验|未核实|尚未核实|是否|不确定|尚未确认|不能认定|不能确认|不能断言|不得断言|不代表|不能视为|并非|不是|不等于|不作|未做成本核算|未实现成本核算|未核算)`)
var costClaim = regexp.MustCompile(`(?:库存成本|采购成本|成本价)`)
var compareSalePrice = regexp.MustCompile(`(?:销售|发货|售价)`)
var compareReferencePrice = regexp.MustCompile(`(?:参考价|采购价|采购单价|库存价|库存单价|库存成本|收货单价)`)
var priceDifference = regexp.MustCompile(`(?:不一致|不同|价差|差异)`)
var priceAnomaly = regexp.MustCompile(`(?:异常|错误|需核实|需确认)`)
var repeatStockAdjustment = regexp.MustCompile(`(?:再次|重新|补做|继续|执行|办理|更新)[^。；，,;\n]{0,14}(?:盘点调整|差异调整|库存调整|库存记录)|(?:盘点|差异)[^。；，,;\n]{0,20}(?:更新库存|执行调整|调整库存|更新台账)`)
var negativeAction = regexp.MustCompile(`(?:无需|不应|不得|不必|不能|不再|禁止)`)
var conditionalNewAction = regexp.MustCompile(`(?:如发现|若发现|若有新|如有新|另行|新的差异|新差异|新证据|新增差异)`)
var falseZeroAmount = regexp.MustCompile(`(?:无实际业务金额|无有效业务金额|没有业务金额|未产生业务金额|(?:业务)?金额(?:为|是)零)`)

func clauseAt(text string, offset int) string {
	before, after := text[:offset], text[offset:]
	start := strings.LastIndexAny(before, "。；，,;！!？?\n")
	if start >= 0 {
		_, size := utf8.DecodeRuneInString(before[start:])
		before = before[start+size:]
	}
	if end := strings.IndexAny(after, "。；，,;！!？?\n"); end >= 0 {
		after = after[:end]
	}
	return before + after
}

func validateScopeClaims(text string, document, calculation M) error {
	for _, sentence := range regexp.MustCompile(`[。；，,;\n]`).Split(text, -1) {
		if uncertainClaim.MatchString(sentence) {
			continue
		}
		if costClaim.MatchString(sentence) {
			return failure(400, "系统未核算成本，不能把单据参考价称为成本价；如未核验，请明确写未核验。")
		}
		if compareSalePrice.MatchString(sentence) && compareReferencePrice.MatchString(sentence) && priceDifference.MatchString(sentence) && priceAnomaly.MatchString(sentence) {
			return failure(400, "销售价与采购或参考价口径不同，不能仅凭价差认定异常或录入错误。")
		}
		if calculation["hasAmount"] == false && falseZeroAmount.MatchString(sentence) {
			return failure(400, "本单不统计业务金额，不能将无金额明细解释成零金额。")
		}
	}
	quantities := map[int64]bool{}
	for _, row := range Rows(calculation["currentInventory"]) {
		quantities[N(row["currentQuantity"])] = true
	}
	for _, match := range currentStockClaim.FindAllStringSubmatchIndex(text, -1) {
		clause := clauseAt(text, match[0])
		if uncertainClaim.MatchString(clause) || historicStockContext.MatchString(clause) {
			continue
		}
		value, _ := strconv.ParseInt(text[match[2]:match[3]], 10, 64)
		if len(quantities) > 0 && !quantities[value] {
			return failure(400, "当前库存数字与currentInventory不符；盘点bookQuantityAtCreation是历史快照，不是当前库存。")
		}
	}
	posted := len(Rows(calculation["postedStocktakes"])) > 0
	for _, other := range Rows(calculation["relatedDocuments"]) {
		if other["type"] == "stocktake" && other["status"] != "completed" {
			posted = false
		}
	}
	if posted && document["type"] != "stocktake" {
		for _, sentence := range regexp.MustCompile(`[。；，,;\n]`).Split(text, -1) {
			if negativeAction.MatchString(sentence) || conditionalNewAction.MatchString(sentence) || strings.Contains(sentence, "已过账") || strings.Contains(sentence, "已登记") || strings.Contains(sentence, "已执行") || strings.Contains(sentence, "已完成") {
				continue
			}
			if repeatStockAdjustment.MatchString(sentence) {
				return failure(400, "相关盘点差异已过账，不能重复更新库存；可继续核查差异原因，有新证据另行办理。")
			}
		}
	}
	return nil
}

// A second model can repeat the first model's unit mistake. Claims must also
// agree with the integer ledger; this check never repairs or approves prose.
func validateClaims(text string, document, calculation M) error {
	if err := validateScopeClaims(text, document, calculation); err != nil {
		return err
	}
	known := map[string]bool{}
	var collect func(any)
	collect = func(value any) {
		switch v := value.(type) {
		case map[string]any:
			for k, child := range v {
				if strings.HasSuffix(k, "Cents") {
					known[strconv.FormatInt(N(child), 10)] = true
				} else {
					collect(child)
				}
			}
		case []M:
			for _, child := range v {
				collect(child)
			}
		case []any:
			for _, child := range v {
				collect(child)
			}
		}
	}
	collect(document)
	collect(calculation)
	for _, quote := range Rows(Map(calculation["publicQuotes"])["quotes"]) {
		if quote["status"] == "priced" && quote["currency"] == "CNY" && quote["price"] != nil {
			if r, ok := new(big.Rat).SetString(fmt.Sprint(quote["price"])); ok {
				r.Mul(r, big.NewRat(100, 1))
				if r.IsInt() {
					known[r.Num().String()] = true
				}
			}
		}
	}
	for _, match := range currencyClaim.FindAllStringSubmatchIndex(text, -1) {
		if text[match[4]:match[5]] == "分" && strings.HasPrefix(text[match[5]:], "钟") {
			continue
		}
		literal := strings.ReplaceAll(text[match[2]:match[3]], ",", "")
		amount, ok := new(big.Rat).SetString(literal)
		if !ok {
			return failure(400, "金额格式无法核对，请引用工具提供的人民币元文本。")
		}
		factor := map[string]int64{"分": 1, "元": 100, "万元": 1000000, "亿元": 10000000000}[text[match[4]:match[5]]]
		amount.Mul(amount, big.NewRat(factor, 1))
		if calculation["hasAmount"] == false && amount.Sign() == 0 && !uncertainClaim.MatchString(clauseAt(text, match[0])) {
			return failure(400, "本单没有金额统计口径，不能写成0元；请写本单不统计业务金额。")
		}
		if calculation["hasAmount"] == false && amount.Sign() == 0 && uncertainClaim.MatchString(clauseAt(text, match[0])) {
			continue
		}
		if !amount.IsInt() || !known[amount.Num().String()] {
			return failure(400, "金额“"+text[match[0]:match[1]]+"”与工具台账不符；Cents是分，请引用totalYuan、unitPriceYuan或lineTotalYuan并写元。")
		}
		if totalClaimPrefix.MatchString(text[:match[0]]) && amount.Num().Cmp(big.NewInt(N(calculation["totalCents"]))) != 0 {
			return failure(400, "总价必须等于工具totalYuan："+money(N(calculation["totalCents"]))+"元，不能使用单价或未经核实的报价。")
		}
	}
	if document["type"] == "weekly_report" {
		types := map[string]bool{}
		for _, d := range Rows(Map(calculation["facts"])["businessDocuments"]) {
			types[S(d["type"])] = true
		}
		for _, m := range documentTypeClaim.FindAllStringSubmatch(text, -1) {
			n, _ := strconv.Atoi(m[1])
			if n != len(types) {
				return failure(400, fmt.Sprintf("本期为%d份业务单据、%d种类型；份数不能写成类型数。", len(Rows(Map(calculation["facts"])["businessDocuments"])), len(types)))
			}
		}
	}
	return nil
}
