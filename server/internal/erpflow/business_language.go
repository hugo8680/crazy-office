package erpflow

import (
	"regexp"
	"sort"
	"strings"
)

// Business deliverables retain facts and source references. Internal wire names
// and the current document's transient workflow status are not deliverable facts.
// Reject them before saving; the existing correction loop asks the actual model
// to rewrite the text. Nothing here edits a submitted result or invents a fact.
var businessSourceURL = regexp.MustCompile(`https?://[^\s<>"'，。；、（）\[\]「」)]+`)
var internalBusinessField = regexp.MustCompile(`\b(?:quoteEvidence|publicQuotes|sourceUrl|fetchedAt|documentCount|typeCount|typeCounts|typeName|approvalRoleNames|businessDocumentSummary|approvalChain|approvalIndex|approvalHistory|businessRules|calculation|hasAmount|totalCents|unitPriceCents|lineTotalCents|totalYuan|unitPriceYuan|lineTotalYuan|amountScope|moneyUnit|currentInventory|currentQuantity|currentStock|bookQuantity|bookQuantityAtCreation|countedQuantity|systemQuantity|postedStocktakes|relatedDocuments|projectMembers|projectRole|requesterProfile|employeeRelationship|employeeProfile|employeeLoans|employeeId|documentId|projectId|requesterId|agentId|agentRunId|runId|periodStart|periodEnd|stateAtPeriodEnd|assigneeIdAtPeriodEnd|acceptedDeliveries|businessParticipation|assignedTasks|submittedTasks|completedTasks|pendingTasks|overdueTasks|scoresAssigned|read_work_context|prepare_plan|review_plan|search_web|fetch_quote)\b`)
var internalBusinessWord = regexp.MustCompile(`\b(?:project_manager|manager|procurement|warehouse|finance|employee|admin|hr|project_setup|project_delivery|weekly_report|stocktake|onboarding|resource|purchase|sales|input|facts|upstream|passed|summary|steps|checks|missing|Agent|agent|(?i:uuid|issue|return))\b`)
var internalBusinessStatus = regexp.MustCompile(`(?i)\b(?:draft|agent_running|agent_failed|agent_ready|awaiting_agent|awaiting_approval|approved|rejected|posted|completed|pending|submitted|partially_received|partially_shipped|pending_inquiry|priced|unpriced|unverified|multiple_price_candidates|active|inactive|disabled|invited|done|running|queued|cancelled|failed|error)\b`)
var rawEmployeeUUID = regexp.MustCompile(`(?i)[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}`)
var businessReferencePrefix = regexp.MustCompile(`(?:DOC|TASK|PRD|PROJ|LIN|MOV|REF|INV|PERF|APP|AGR|REV|RECEIPT)-$`)
var referenceLabel = regexp.MustCompile(`(?:凭证|单据|订单|报价|回执|流水|编号|单号|验收号)[^。；;\n]{0,12}$`)
var missingProjectMemberNames = regexp.MustCompile(`(?:项目)?成员(?:的)?(?:对应)?(?:姓名|实名|名字)(?:均|尚|还|仍|暂)?(?:未(?:提供|列明|核实|确认|给出)|缺失|缺少|待(?:确认|提供|补充)|不详|未知)|(?:未(?:提供|列明|给出)|缺少|需补充|待补充)(?:项目)?成员(?:的)?(?:对应)?(?:姓名|实名|名字)`)

var currentDocumentStatus = []*regexp.Regexp{
	regexp.MustCompile(`(?:当前|目前|现在)(?:的)?(?:工作单|单据|流程|审批|办理)?状态[^。；;\n]{0,10}(?:草稿|处理中|待提交|待审批|等待审批|审批中|已完成|已批准|已通过|已退回|已取消|部分收货|部分发货|draft|awaiting_approval|approved|completed|rejected|active|inactive|running|pending)`),
	regexp.MustCompile(`(?:本(?:工作)?单(?:据)?|当前(?:工作)?单(?:据)?|本周报|本次(?:采购申请|销售申请|盘点单|岗位准备单|交付验收单|立项单))(?:的)?(?:(?:当前|目前|现在|现时|仍|尚|还|现)){0,3}(?:的)?(?:流程|审批|办理)?(?:状态(?:是|为|[:：])?|处于|处在|尚处|仍为|现为|目前为|当前为|为|是)[^。；;\n]{0,6}(?:草稿|处理中|待提交|待审批|等待审批|审批中|已完成|已批准|已通过|已退回|已取消|部分收货|部分发货|draft|awaiting_approval|approved|completed|rejected|active|inactive|running|pending)`),
	regexp.MustCompile(`(?:^|[。；;，,\n])\s*(?:本(?:工作)?单(?:据)?|当前(?:工作)?单(?:据)?|本周报)(?:现已|已经|已|当前已|目前已)(?:批准|通过审批|退回|完成|取消|提交|送审)(?:[。；;，,\n]|$)`),
}

func validateBusinessLanguage(text string, contexts ...M) error {
	// A real source URL can legitimately contain /finance, /completed or field
	// names. Preserve the URL in output; exclude only its literal from this check.
	prose := businessSourceURL.ReplaceAllString(text, " ")
	softProse := prose
	literals := []string{}
	for _, context := range contexts {
		literals = append(literals, Strings(context["names"])...)
	}
	sort.SliceStable(literals, func(i, j int) bool { return len(literals[i]) > len(literals[j]) })
	for _, literal := range literals {
		if literal != "" {
			softProse = strings.ReplaceAll(softProse, literal, " ")
		}
	}
	terms := []string{}
	seen := map[string]bool{}
	collect := func(pattern *regexp.Regexp, source string, allowCodes bool) {
		for _, location := range pattern.FindAllStringIndex(source, -1) {
			if allowCodes && (location[0] > 0 && source[location[0]-1] == '-' || location[1] < len(source) && source[location[1]] == '-') {
				continue
			}
			term := source[location[0]:location[1]]
			if !seen[term] {
				seen[term] = true
				terms = append(terms, term)
			}
		}
	}
	collect(internalBusinessField, prose, false)
	collect(internalBusinessWord, softProse, true)
	collect(internalBusinessStatus, softProse, true)
	messages := []string{}
	if len(terms) > 0 {
		if len(terms) > 16 {
			terms = terms[:16]
		}
		messages = append(messages, "结果含内部标识（"+strings.Join(terms, "、")+"），角色、业务类型、字段和历史状态必须改成业务中文；保留原始数字、凭证及来源")
	}
	for _, match := range rawEmployeeUUID.FindAllStringIndex(prose, -1) {
		prefix := prose[:match[0]]
		if businessReferencePrefix.MatchString(prefix) {
			continue
		}
		allowedReference := false
		for _, context := range contexts {
			for _, ref := range Strings(context["references"]) {
				if ref == "" {
					continue
				}
				for start := 0; start < len(prose); {
					offset := strings.Index(prose[start:], ref)
					if offset < 0 {
						break
					}
					offset += start
					end := offset + len(ref)
					if match[0] >= offset && match[1] <= end {
						if len(ref) > match[1]-match[0] || referenceLabel.MatchString(prefix) {
							allowedReference = true
						}
					}
					start = end
				}
			}
		}
		if !allowedReference {
			messages = append(messages, "不得用员工UUID标识人员，请使用已提供的姓名或岗位称谓；真实业务单号和凭证编号仍须保留")
			break
		}
	}
	shortPersonID := false
	for _, context := range contexts {
		for _, id := range Strings(context["employeeIDs"]) {
			if !rawEmployeeUUID.MatchString(id) || len(id) < 8 {
				continue
			}
			pattern := regexp.MustCompile(`(?:员工|人员|申请人|负责人|验收人|领用人|归还人)[（(：:\s]*` + regexp.QuoteMeta(id[:8]) + `(?:[0-9a-fA-F-]{0,28})?`)
			if pattern.MatchString(prose) {
				shortPersonID = true
				break
			}
		}
	}
	if shortPersonID {
		messages = append(messages, "不得用员工UUID的截断片段标识人员，请使用已提供的姓名或岗位称谓")
	}
	for _, context := range contexts {
		if context["projectMemberNamesComplete"] == true && missingProjectMemberNames.MatchString(softProse) {
			messages = append(messages, "工具已提供当前项目全部成员姓名，不得声称成员姓名缺失；请按实际成员资料核对，只有未提供的岗位或职责等事项才能列待确认")
			break
		}
	}
	for _, context := range contexts {
		if err := validateRequestParties(prose, context); err != nil {
			messages = append(messages, err.Error())
			break
		}
	}
	for _, pattern := range currentDocumentStatus {
		if pattern.MatchString(prose) {
			messages = append(messages, "不得在方案中断言本工作单当前流程状态；该状态由页面实时显示。请只保留业务事实、相关历史记录及必需的后续办理条件")
			break
		}
	}
	if len(messages) > 0 {
		return failure(400, strings.Join(messages, "；")+"。请修正全部summary、steps、checks、missing后重新提交，不得改变事实或省略限制。")
	}
	return nil
}

func validateRequestParties(text string, context M) error {
	if context["differentRequestParties"] != true {
		return nil
	}
	requester, subject, role := S(context["requesterName"]), S(context["subjectName"]), S(context["subjectRole"])
	if requester == "" || subject == "" {
		return nil
	}
	applicantLabel := `(?:申请人|申请者|申请员工|提交人|发起人)`
	identityLink := `[\s:：=＝（(“「"]*(?:(?:姓名)?(?:为|是)[\s:：=＝“「"]*)?`
	mislabels := []*regexp.Regexp{}
	if requester != subject {
		mislabels = append(mislabels,
			regexp.MustCompile(applicantLabel+identityLink+regexp.QuoteMeta(subject)),
			regexp.MustCompile(regexp.QuoteMeta(subject)+`[\s”」"）)]*(?:为|是|担任|作为)`+applicantLabel),
			regexp.MustCompile(regexp.QuoteMeta(subject)+`[\s（(]+`+applicantLabel+`[）)]`),
			regexp.MustCompile(applicantLabel+`(?:与|和|及|、)(?:领用人|归还人|岗位准备对象)(?:均|都)?(?:为|是)`+`[\s:：“「"]*`+regexp.QuoteMeta(subject)),
		)
		if role != "" {
			mislabels = append(mislabels, regexp.MustCompile(regexp.QuoteMeta(role)+identityLink+regexp.QuoteMeta(requester)))
		}
	}
	mislabels = append(mislabels, regexp.MustCompile(applicantLabel+`(?:与|和|及)(?:领用人|归还人|岗位准备对象)(?:为|是|系)?(?:同一(?:名)?(?:人|员工)|相同|一致)`))
	for _, pattern := range mislabels {
		if pattern.MatchString(text) {
			return failure(400, "人员归属与本单不符：实际申请人为"+requester+"，"+role+"为"+subject+"，属于代办。请按此对应关系修正全部人员称谓，不得调换两人身份；保留原始数量、凭证和限制")
		}
	}
	return nil
}

// languageContext extracts only typed business names and recorded references.
// It does not trust objectives, notes or any user instruction as a whitelist.
func languageContext(actorName string, d, scope, calculation M) M {
	names := []string{actorName, S(d["title"]), S(Map(d["input"])["partner"]), S(Map(scope["project"])["name"]), S(Map(scope["project"])["customer"]), S(Map(scope["employeeProfile"])["name"]), S(Map(scope["requesterProfile"])["name"])}
	references := []string{S(d["id"]), S(Map(d["input"])["quotationReference"]), S(Map(d["input"])["originalDocumentId"]), S(Map(d["input"])["sourceOnboardingDocumentId"])}
	for _, line := range Rows(calculation["lines"]) {
		names = append(names, S(line["product"]), S(line["sku"]))
		references = append(references, S(line["lineId"]))
	}
	for _, line := range Rows(d["lines"]) {
		names = append(names, S(line["name"]), S(line["sku"]))
	}
	for _, item := range Rows(scope["currentInventory"]) {
		names = append(names, S(item["name"]), S(item["sku"]))
	}
	for _, item := range Rows(scope["relatedDocuments"]) {
		references = append(references, S(item["id"]))
	}
	for _, item := range Rows(scope["movements"]) {
		references = append(references, S(item["reference"]))
	}
	employeeIDs := []string{S(d["requesterId"]), S(Map(d["input"])["employeeId"]), S(Map(scope["employeeProfile"])["id"]), S(Map(scope["project"])["ownerId"])}
	employeeIDs = append(employeeIDs, Strings(Map(scope["project"])["members"])...)
	for _, task := range Rows(scope["tasks"]) {
		employeeIDs = append(employeeIDs, S(task["assigneeId"]), S(task["acceptedBy"]))
	}
	for _, employee := range Rows(Map(calculation["facts"])["employees"]) {
		employeeIDs = append(employeeIDs, S(employee["employeeId"]))
	}
	members := Rows(scope["projectMembers"])
	complete := len(members) > 0
	for _, member := range members {
		names = append(names, S(member["name"]))
		employeeIDs = append(employeeIDs, S(member["id"]))
		if strings.TrimSpace(S(member["name"])) == "" {
			complete = false
		}
	}
	result := M{"names": names, "references": references, "employeeIDs": employeeIDs, "projectMemberNamesComplete": complete}
	if d["type"] == "resource" || d["type"] == "onboarding" {
		relation := Map(scope["employeeRelationship"])
		result["requesterName"], result["subjectName"], result["subjectRole"] = relation["申请人"], relation["办理对象"], relation["对象身份"]
		result["differentRequestParties"] = relation["代办"]
	}
	return result
}
