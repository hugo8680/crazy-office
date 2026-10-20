package erp

func validateInput(typ string, raw any) map[string]any {
	m := obj(raw)
	r := map[string]any{}
	switch typ {
	case "purchase", "sales":
		r["partner"] = text(m["partner"], "供应商或客户", 200, true)
		r["expectedDate"] = date(m["expectedDate"], "预计日期", false)
		if typ == "purchase" {
			for _, v := range []struct {
				k, l string
				n    int
			}{{"quotationReference", "供应商报价凭证或链接", 1000}, {"quotationNotes", "供应商报价依据与条件", 4000}} {
				s := text(def(m, v.k, ""), v.l, v.n, false)
				if s != "" {
					r[v.k] = s
				}
			}
		}
	case "project_setup":
		r["objective"] = text(m["objective"], "项目目标", 4000, true)
		r["expectedDate"] = date(m["expectedDate"], "预计日期", false)
	case "project_delivery":
		r["acceptanceCriteria"] = text(m["acceptanceCriteria"], "验收标准", 4000, true)
		r["deliveryNote"] = text(m["deliveryNote"], "交付说明", 8000, true)
	case "resource":
		if !has([]string{"issue", "return"}, str(m["operation"])) {
			fail("资源操作须为借出或归还")
		}
		r["operation"] = m["operation"]
		r["employeeId"] = text(m["employeeId"], "领用员工", 100, true)
		r["purpose"] = text(m["purpose"], "物品用途", 2000, true)
		if m["operation"] == "return" {
			r["originalDocumentId"] = text(m["originalDocumentId"], "原借出单号", 100, true)
		}
		if str(m["sourceOnboardingDocumentId"]) != "" {
			r["sourceOnboardingDocumentId"] = text(m["sourceOnboardingDocumentId"], "岗位准备单号", 100, true)
		}
	case "weekly_report":
		r["periodStart"] = date(m["periodStart"], "开始日期", true)
		r["periodEnd"] = date(m["periodEnd"], "结束日期", true)
		r["summary"] = text(def(m, "summary", ""), "周报说明", 8000, false)
		if str(r["periodStart"]) > str(r["periodEnd"]) {
			fail("周报结束日期不能早于开始日期")
		}
	case "onboarding":
		r["employeeId"] = text(m["employeeId"], "入驻员工", 100, true)
		r["position"] = text(m["position"], "岗位", 100, true)
		r["resourceRequirements"] = text(m["resourceRequirements"], "岗位资源需求", 4000, true)
	case "stocktake":
		r["note"] = text(m["note"], "盘点原因及依据", 4000, true)
	}
	return r
}

type prepared struct {
	typ, pid string
	input    map[string]any
	lines    []map[string]any
}

func (q *ledger) prepare(a Actor, p map[string]any) prepared {
	typ := str(p["type"])
	if Chains[typ] == nil {
		fail("不支持的业务流程")
	}
	if typ == "stocktake" {
		requireRole(a, "warehouse", "manager")
	}
	if typ == "onboarding" {
		requireRole(a, "hr", "manager")
	}
	pid := text(p["projectId"], "项目编号", 100, false)
	if has([]string{"project_setup", "project_delivery", "weekly_report"}, typ) && pid == "" {
		fail("此流程必须关联项目")
	}
	if pid != "" {
		project := q.checkProject(a, pid)
		if typ == "project_setup" && project["status"] != "draft" {
			fail("项目已启用，不必重复立项", "STATE_CONFLICT", 409)
		}
	}
	details := validateInput(typ, def(p, "input", map[string]any{}))
	if typ == "resource" && str(details["sourceOnboardingDocumentId"]) != "" {
		source := q.rawDocument(str(details["sourceOnboardingDocumentId"]), &a)
		input := obj(parse(source["input_json"]))
		if source["type"] != "onboarding" || source["status"] != "completed" || input["employeeId"] != details["employeeId"] {
			fail("岗位准备来源须为同一员工已完成且有权查看的准备单", "INVALID_SOURCE", 409)
		}
	}
	if typ == "weekly_report" {
		details["facts"] = q.weeklyFacts(pid, str(details["periodStart"]), str(details["periodEnd"]))
	}
	if value, exists := p["lines"]; exists && value == nil {
		fail("产品明细须为数组")
	}
	rawLines := list(def(p, "lines", []any{}))
	if len(rawLines) > 100 {
		fail("产品明细最多100行")
	}
	stockType := has([]string{"purchase", "sales", "stocktake", "resource"}, typ)
	if stockType && len(rawLines) == 0 {
		fail("请至少填写一项产品明细")
	}
	if !stockType && len(rawLines) > 0 {
		fail("此流程不接受库存明细")
	}
	lines := []map[string]any{}
	seen := map[string]bool{}
	var total int64
	for _, raw := range rawLines {
		item := obj(raw)
		productID := text(item["productId"], "产品编号", 100, true)
		if seen[productID] {
			fail("同一产品请合并为一行")
		}
		seen[productID] = true
		product := q.one("SELECT * FROM products WHERE id=?", productID)
		if product == nil {
			fail("产品不存在", "NOT_FOUND", 404)
		}
		qtyKey := "quantity"
		min := int64(1)
		if typ == "stocktake" {
			qtyKey = "countedQuantity"
			min = 0
		}
		qty := integer(item[qtyKey], "产品数量", min, 1000000000)
		price := integer(def(item, "unitPriceCents", product["price_cents"]), "单价分", 0, 1000000000000)
		if qty > 0 && price > 9007199254740991/qty {
			fail("单据金额超过安全整数范围")
		}
		amount := qty * price
		if total > 9007199254740991-amount {
			fail("单据总金额超过安全整数范围")
		}
		total += amount
		lines = append(lines, map[string]any{"id": uid("LIN"), "product_id": productID, "quantity": qty, "unit_price_cents": price, "system_quantity": q.balance(productID), "system_movement_id": q.stockRevision(productID)})
	}
	if typ == "resource" && details["operation"] == "return" {
		original := q.rawDocument(str(details["originalDocumentId"]), &a)
		oi := obj(parse(original["input_json"]))
		if original["type"] != "resource" || oi["operation"] != "issue" || original["status"] != "completed" || oi["employeeId"] != details["employeeId"] {
			fail("归还单必须对应同一员工的已完成借出单")
		}
		if str(original["project_id"]) != pid {
			fail("归还单与原借出单的项目必须一致")
		}
		for _, l := range lines {
			loan := q.one("SELECT * FROM loans WHERE document_id=? AND product_id=?", original["id"], l["product_id"])
			if loan == nil || num(l["quantity"]) > num(loan["quantity"])-num(loan["returned_quantity"]) {
				fail("归还数量超过未归还数量", "OVER_RETURN", 409)
			}
		}
	}
	return prepared{typ, pid, details, lines}
}
func nullable(s string) any {
	if s == "" {
		return nil
	}
	return s
}
func (q *ledger) insertLines(id string, lines []map[string]any) {
	for _, l := range lines {
		q.exec("INSERT INTO document_lines(id,document_id,product_id,quantity,unit_price_cents,completed_quantity,system_quantity,system_movement_id) VALUES(?,?,?,?,?,?,?,?)", l["id"], id, l["product_id"], l["quantity"], l["unit_price_cents"], 0, l["system_quantity"], l["system_movement_id"])
	}
}
func (q *ledger) createDocument(a Actor, p map[string]any) map[string]any {
	d := q.prepare(a, p)
	id, stamp := uid("DOC"), now()
	q.exec("INSERT INTO documents(id,type,title,project_id,requester_id,department,status,version,input_json,proposal_json,evidence_json,agent_run_id,approval_index,created_at,updated_at,approval_round) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)", id, d.typ, text(def(p, "title", Labels[d.typ]), "单据名称", 200, true), nullable(d.pid), a.ID, a.Department, "draft", 1, dump(d.input), nil, "[]", nil, 0, stamp, stamp, 1)
	q.insertLines(id, d.lines)
	q.audit(a.ID, "document.create", id, map[string]any{"type": d.typ})
	return q.document(id, &a)
}
func (q *ledger) reviseDocument(a Actor, d, p map[string]any) map[string]any {
	if d["requester_id"] != a.ID && !has(a.Roles, "admin") {
		fail("只有申请人或管理员能修订资料", "FORBIDDEN", 403)
	}
	if !has([]string{"draft", "rejected"}, str(d["status"])) {
		fail("审批中或已批准、已入账的单据不能修订", "STATE_CONFLICT", 409)
	}
	if v, ok := p["type"]; ok && v != d["type"] {
		fail("修订不能更换业务流程")
	}
	if v, ok := p["projectId"]; ok && str(v) != str(d["project_id"]) {
		fail("修订不能更换所属项目，请另建申请")
	}
	id := str(d["id"])
	current := q.document(id, &a)
	lines := []any{}
	for _, v := range current["lines"].([]map[string]any) {
		key := "quantity"
		if d["type"] == "stocktake" {
			key = "countedQuantity"
		}
		lines = append(lines, map[string]any{"productId": v["productId"], key: v["quantity"], "unitPriceCents": v["unitPriceCents"]})
	}
	merged := map[string]any{"type": d["type"], "projectId": d["project_id"], "title": def(p, "title", d["title"]), "input": def(p, "input", current["input"]), "lines": def(p, "lines", lines)}
	prepared := q.prepare(a, merged)
	title := text(merged["title"], "单据名称", 200, true)
	q.exec("INSERT INTO document_history VALUES(?,?,?,?,?,?,?)", uid("REV"), id, d["version"], d["approval_round"], dump(current), a.ID, now())
	if q.one("SELECT 1 FROM movements WHERE document_id=? LIMIT 1", id) != nil {
		fail("已有库存流水的单据不能修订", "STATE_CONFLICT", 409)
	}
	q.exec("DELETE FROM document_lines WHERE document_id=?", id)
	q.insertLines(id, prepared.lines)
	q.exec("UPDATE documents SET title=?,input_json=?,status='draft',proposal_json=NULL,evidence_json='[]',agent_run_id=NULL,approval_index=0,approval_round=approval_round+1,version=version+1,updated_at=? WHERE id=?", title, dump(prepared.input), now(), id)
	q.audit(a.ID, "document.revise", id, map[string]any{"fromVersion": d["version"], "fromRound": d["approval_round"], "toRound": num(d["approval_round"]) + 1, "previousStatus": d["status"]})
	return q.document(id, &a)
}
func (q *ledger) receipt(a Actor, d, p map[string]any, kind string) {
	requireRole(a, "warehouse")
	typ, partial := "purchase", "partially_received"
	if kind == "ship" {
		typ, partial = "sales", "partially_shipped"
	}
	if d["type"] != typ || !has([]string{"approved", partial}, str(d["status"])) {
		fail("当前单据不能办理此收发货操作", "STATE_CONFLICT", 409)
	}
	ref := text(p["reference"], "真实收发货凭证号", 150, true)
	if q.one("SELECT 1 FROM receipts WHERE document_id=? AND kind=? AND reference=?", d["id"], kind, ref) != nil {
		fail("该收发货凭证已登记，请勿重复入账", "DUPLICATE_RECEIPT", 409)
	}
	items := list(p["lines"])
	if len(items) == 0 || len(items) > 100 {
		fail("请填写本次实际收发货数量")
	}
	seen := map[string]bool{}
	for _, raw := range items {
		item := obj(raw)
		lid := text(item["lineId"], "明细编号", 100, true)
		if seen[lid] {
			fail("同一明细不能重复提交")
		}
		seen[lid] = true
		line := q.one("SELECT * FROM document_lines WHERE id=? AND document_id=?", lid, d["id"])
		if line == nil {
			fail("收发货明细不属于此单据")
		}
		qty := integer(item["quantity"], "本次实际数量", 1, 1000000000)
		if qty > num(line["quantity"])-num(line["completed_quantity"]) {
			fail("数量超过单据剩余未办理数量", "OVER_FULFILMENT", 409)
		}
		delta := qty
		if kind == "ship" {
			delta = -qty
		}
		q.move(a, d, line, delta, kind, ref)
		q.exec("UPDATE document_lines SET completed_quantity=completed_quantity+? WHERE id=?", qty, lid)
	}
	q.exec("INSERT INTO receipts VALUES(?,?,?,?,?,?)", uid("REC"), d["id"], kind, ref, a.ID, now())
	remaining := num(q.scalar("SELECT SUM(quantity-completed_quantity) FROM document_lines WHERE document_id=?", d["id"]))
	status := partial
	if remaining == 0 {
		status = "completed"
	}
	q.updateDocument(d, status, nil)
}
func (q *ledger) post(a Actor, d, p map[string]any) {
	if d["status"] != "approved" || has([]string{"purchase", "sales"}, str(d["type"])) {
		fail("当前单据尚不能确认完成", "STATE_CONFLICT", 409)
	}
	input := obj(parse(d["input_json"]))
	lines := q.rows("SELECT * FROM document_lines WHERE document_id=?", d["id"])
	if has([]string{"resource", "stocktake"}, str(d["type"])) {
		requireRole(a, "warehouse")
		ref := text(p["reference"], "实际办理凭证号", 150, true)
		if d["type"] == "stocktake" {
			for _, l := range lines {
				if q.balance(str(l["product_id"])) != num(l["system_quantity"]) || q.stockRevision(str(l["product_id"])) != l["system_movement_id"] {
					fail("盘点后库存已有变动，请重新盘点后发起调整", "STALE_STOCKTAKE", 409)
				}
			}
			for _, l := range lines {
				q.move(a, d, l, num(l["quantity"])-num(l["system_quantity"]), "stocktake", ref)
			}
		} else if input["operation"] == "issue" {
			for _, l := range lines {
				q.move(a, d, l, -num(l["quantity"]), "resource_issue", ref)
				q.exec("INSERT INTO loans VALUES(?,?,?,?,?,?)", uid("LOAN"), d["id"], l["product_id"], input["employeeId"], l["quantity"], 0)
			}
		} else {
			for _, l := range lines {
				loan := q.one("SELECT * FROM loans WHERE document_id=? AND product_id=? AND employee_id=?", input["originalDocumentId"], l["product_id"], input["employeeId"])
				if loan == nil || num(l["quantity"]) > num(loan["quantity"])-num(loan["returned_quantity"]) {
					fail("归还数量超过当前未归还数量", "OVER_RETURN", 409)
				}
				q.move(a, d, l, num(l["quantity"]), "resource_return", ref)
				q.exec("UPDATE loans SET returned_quantity=returned_quantity+? WHERE id=?", l["quantity"], loan["id"])
			}
		}
		q.exec("UPDATE document_lines SET completed_quantity=quantity WHERE document_id=?", d["id"])
	} else {
		requireRole(a, "manager", "project_manager", "hr")
		switch d["type"] {
		case "project_setup":
			if q.project(str(d["project_id"]))["status"] != "draft" {
				fail("项目已由其他立项单启用", "STATE_CONFLICT", 409)
			}
			q.exec("UPDATE projects SET status='active' WHERE id=?", d["project_id"])
		case "weekly_report":
			q.requireActive(str(d["project_id"]))
			q.exec("INSERT INTO performance VALUES(?,?,?,?,?,?,?,?)", uid("PERF"), d["id"], d["project_id"], input["periodStart"], input["periodEnd"], dump(input["facts"]), a.ID, now())
		case "project_delivery":
			q.requireActive(str(d["project_id"]))
		}
	}
	q.updateDocument(d, "completed", nil)
}
func (q *ledger) recordAgent(p map[string]any) map[string]any {
	d := q.rawDocument(text(p["documentId"], "单据编号", 100, true), nil)
	if d["status"] != "draft" {
		fail("审批开始后不能替换方案；被退回后请先修订资料", "STATE_CONFLICT", 409)
	}
	run := text(p["runId"], "真实协作运行编号", 150, true)
	proposal, evidence := p["proposal"], p["evidence"]
	valid := false
	switch v := proposal.(type) {
	case map[string]any:
		valid = len(v) > 0
	case string:
		valid = v != ""
	}
	if !valid || len([]rune(dump(proposal))) > 160000 {
		fail("协作草案为空或超过上限")
	}
	receipts := list(evidence)
	if len(receipts) < 2 || len([]rune(dump(evidence))) > 200000 {
		fail("需要至少两名虚拟员工的真实执行凭证")
	}
	agents := map[string]bool{}
	for _, raw := range receipts {
		receipt := obj(raw)
		agents[text(receipt["agentId"], "执行员工编号", 100, true)] = true
		if v, ok := receipt["success"].(bool); ok && !v {
			fail("协作仍有失败步骤，不能提交审批", "AGENT_INCOMPLETE", 409)
		}
	}
	if len(agents) < 2 {
		fail("须由不同虚拟员工完成整理与复核")
	}
	if d["agent_run_id"] == run {
		if d["proposal_json"] != dump(proposal) || d["evidence_json"] != dump(evidence) {
			fail("同一协作运行不能替换已经登记的结果", "IDEMPOTENCY_CONFLICT", 409)
		}
		return q.document(str(d["id"]), nil)
	}
	if v, ok := p["expectedVersion"]; ok && v != nil && num(v) != num(d["version"]) {
		fail("协作使用的资料版本已过期", "VERSION_CONFLICT", 409)
	}
	if q.one("SELECT 1 FROM agent_results WHERE document_id=? AND run_id=?", d["id"], run) != nil {
		fail("不能复用修订前或已替换的协作结果，请重新执行", "AGENT_STALE", 409)
	}
	q.exec("INSERT INTO agent_results VALUES(?,?,?,?,?,?,?)", uid("AGR"), d["id"], d["approval_round"], run, dump(proposal), dump(evidence), now())
	q.updateDocument(d, "draft", map[string]any{"proposal_json": dump(proposal), "evidence_json": dump(evidence), "agent_run_id": run})
	names := []string{}
	for a := range agents {
		names = append(names, a)
	}
	sortStrings(names)
	q.audit("virtual-employees", "document.agent_result", str(d["id"]), map[string]any{"runId": run, "agentIds": names})
	return q.document(str(d["id"]), nil)
}
