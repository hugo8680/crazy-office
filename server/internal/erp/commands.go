package erp

import "sort"

func sortStrings(v []string) { sort.Strings(v) }
func uniqueStrings(raw any, label string, max int) []string {
	if raw == nil {
		fail("项目成员须为数组")
	}
	items := list(raw)
	if len(items) > max {
		fail("项目成员最多200人")
	}
	set := map[string]bool{}
	for _, v := range items {
		set[text(v, label, 100, true)] = true
	}
	out := []string{}
	for v := range set {
		out = append(out, v)
	}
	sort.Strings(out)
	return out
}
func (q *ledger) command(a Actor, action string, p map[string]any) map[string]any {
	switch action {
	case "product.create":
		requireRole(a, "procurement", "warehouse", "manager")
		id, stamp := uid("PRD"), now()
		sku := text(p["sku"], "产品编码", 80, true)
		if !skuPattern.MatchString(sku) {
			fail("产品编码仅支持字母、数字、点、短横线和下划线")
		}
		q.exec("INSERT INTO products VALUES(?,?,?,?,?,?)", id, sku, text(p["name"], "产品名称", 200, true), text(def(p, "unit", "件"), "单位", 30, true), integer(def(p, "priceCents", 0), "参考单价分", 0, 1000000000000), stamp)
		q.audit(a.ID, action, id, nil)
		return q.one("SELECT id,sku,name,unit,price_cents AS priceCents,created_at AS createdAt FROM products WHERE id=?", id)
	case "project.create":
		requireRole(a, "project_manager", "manager")
		id, stamp := uid("PROJ"), now()
		members := uniqueStrings(def(p, "members", []any{}), "成员编号", 200)
		owner := text(def(p, "ownerId", a.ID), "项目负责人", 100, true)
		if owner != a.ID && !role(a, "manager") {
			fail("只能创建自己负责的项目", "FORBIDDEN", 403)
		}
		if !has(members, a.ID) {
			members = append(members, a.ID)
		}
		if !has(members, owner) {
			members = append(members, owner)
		}
		q.exec("INSERT INTO projects VALUES(?,?,?,?,?,?,?,?)", id, text(p["name"], "项目名称", 200, true), text(p["customer"], "客户", 200, true), owner, a.Department, dump(members), "draft", stamp)
		q.audit(a.ID, action, id, nil)
		return q.project(id)
	case "project.update":
		id := text(p["id"], "项目编号", 100, true)
		project := q.checkProject(a, id)
		if project["ownerId"] != a.ID {
			requireRole(a, "manager")
		}
		members := uniqueStrings(def(p, "members", project["members"]), "成员编号", 200)
		owner := text(def(p, "ownerId", project["ownerId"]), "项目负责人", 100, true)
		if !has(members, owner) {
			fail("新项目负责人必须在本项目成员中")
		}
		name := text(def(p, "name", project["name"]), "项目名称", 200, true)
		customer := text(def(p, "customer", project["customer"]), "客户", 200, true)
		department := text(def(p, "department", project["department"]), "项目部门", 100, false)
		if department != project["department"] {
			requireRole(a, "admin")
		}
		for _, employee := range stringsOf(project["members"]) {
			if !has(members, employee) && q.one("SELECT 1 FROM tasks WHERE project_id=? AND assignee_id=? AND status IN ('pending','submitted') LIMIT 1", id, employee) != nil {
				fail("被移出成员仍有待办或待验收任务，请先退回并转交任务", "OPEN_TASKS", 409)
			}
		}
		before := map[string]any{}
		for _, k := range []string{"name", "customer", "ownerId", "members", "department"} {
			before[k] = project[k]
		}
		after := map[string]any{"name": name, "customer": customer, "ownerId": owner, "members": members, "department": department}
		q.exec("UPDATE projects SET name=?,customer=?,owner_id=?,members_json=?,department=? WHERE id=?", name, customer, owner, dump(members), department, id)
		q.audit(a.ID, action, id, map[string]any{"before": before, "after": after})
		return q.project(id)
	case "document.create":
		return q.createDocument(a, p)
	case "task.create", "task.complete", "task.accept", "task.return", "task.reassign":
		return q.taskCommand(a, action, p)
	}
	if !has([]string{"document.revise", "document.submit", "document.approve", "document.reject", "document.receive", "document.ship", "document.post"}, action) {
		fail("不支持的业务操作")
	}
	id := text(p["id"], "单据编号", 100, true)
	d := q.rawDocument(id, &a)
	if v, ok := p["version"]; ok && v != nil && integer(v, "单据版本", 1, 1000000000) != num(d["version"]) {
		fail("单据已更新，请刷新后核对", "VERSION_CONFLICT", 409)
	}
	switch action {
	case "document.revise":
		return q.reviseDocument(a, d, p)
	case "document.submit":
		if d["requester_id"] != a.ID && !has(a.Roles, "admin") {
			fail("须由申请人确认并提交方案", "FORBIDDEN", 403)
		}
		if d["status"] != "draft" || str(d["agent_run_id"]) == "" || str(d["proposal_json"]) == "" {
			fail("须先完成真实虚拟员工协作并核对草案", "AGENT_REQUIRED", 409)
		}
		q.updateDocument(d, "awaiting_approval", nil)
	case "document.approve", "document.reject":
		if d["status"] != "awaiting_approval" {
			fail("此单据当前不在审批中", "STATE_CONFLICT", 409)
		}
		chain := Chains[str(d["type"])]
		index := int(num(d["approval_index"]))
		if index >= len(chain) {
			fail("此单据当前不在审批中", "STATE_CONFLICT", 409)
		}
		required := chain[index]
		requireRole(a, required)
		if a.ID == d["requester_id"] {
			fail("申请人不能审批自己的单据", "SELF_APPROVAL", 403)
		}
		if q.one("SELECT 1 FROM approvals WHERE document_id=? AND actor_id=? AND decision='approved' AND round=?", id, a.ID, d["approval_round"]) != nil {
			fail("两级审批须由不同员工处理", "SEPARATION_REQUIRED", 403)
		}
		note := text(def(p, "note", ""), "审批意见", 4000, false)
		approved := action == "document.approve"
		decision, status := "rejected", "rejected"
		if approved {
			decision = "approved"
		}
		if !approved && note == "" {
			fail("退回时请说明需要修改的内容")
		}
		q.exec("INSERT INTO approvals VALUES(?,?,?,?,?,?,?,?,?,?)", uid("APP"), id, index, required, a.ID, a.DisplayName, decision, note, now(), d["approval_round"])
		if approved {
			index++
			status = "awaiting_approval"
			if index == len(chain) {
				status = "approved"
			}
			q.updateDocument(d, status, map[string]any{"approval_index": index})
		} else {
			q.updateDocument(d, status, nil)
		}
	case "document.receive":
		q.receipt(a, d, p, "receive")
	case "document.ship":
		q.receipt(a, d, p, "ship")
	case "document.post":
		q.post(a, d, p)
	}
	q.audit(a.ID, action, id, map[string]any{"fromStatus": d["status"]})
	return q.document(id, &a)
}
func (q *ledger) task(id string) map[string]any {
	t := q.one("SELECT * FROM tasks WHERE id=?", id)
	if t == nil {
		fail("任务不存在", "NOT_FOUND", 404)
	}
	return t
}
func (q *ledger) taskCommand(a Actor, action string, p map[string]any) map[string]any {
	if action == "task.create" {
		project := q.checkProject(a, text(p["projectId"], "项目编号", 100, true))
		if project["ownerId"] != a.ID {
			requireRole(a, "project_manager", "manager")
		}
		assignee := text(p["assigneeId"], "任务负责人", 100, true)
		if !has(stringsOf(project["members"]), assignee) && assignee != project["ownerId"] {
			fail("任务负责人必须是项目成员")
		}
		id := uid("TASK")
		q.exec("INSERT INTO tasks(id,project_id,title,assignee_id,created_by,due_date,status,result,evidence_json,created_at,completed_at,submitted_at,accepted_by) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)", id, project["id"], text(p["title"], "任务名称", 200, true), assignee, a.ID, date(p["dueDate"], "截止日期", false), "pending", "", "[]", now(), nil, nil, nil)
		q.audit(a.ID, action, id, nil)
		return q.taskFor(id, &a)
	}
	id := text(p["id"], "任务编号", 100, true)
	t := q.task(id)
	project := q.checkProject(a, str(t["project_id"]))
	if action == "task.complete" {
		if t["assignee_id"] != a.ID {
			fail("须由任务负责人提交交付", "FORBIDDEN", 403)
		}
		if t["status"] != "pending" {
			fail("该任务已经交付，不能重复确认", "STATE_CONFLICT", 409)
		}
		evidence := list(def(p, "evidence", []any{}))
		if len(evidence) == 0 || len(evidence) > 50 || len([]rune(dump(evidence))) > 30000 {
			fail("提交交付须附至少一项真实文件地址或交付凭证编号")
		}
		validated := []any{}
		for _, r := range evidence {
			receipt := obj(r)
			validated = append(validated, map[string]any{"name": text(def(receipt, "name", "交付凭证"), "凭证名称", 200, true), "reference": text(receipt["reference"], "凭证地址或编号", 1000, true)})
		}
		result := text(p["result"], "实际交付说明", 8000, true)
		stamp := now()
		q.exec("UPDATE tasks SET status='submitted',result=?,evidence_json=?,submitted_at=?,completed_at=NULL,accepted_by=NULL WHERE id=?", result, dump(validated), stamp, id)
		q.exec("INSERT INTO task_events VALUES(?,?,?,?,?,?,?)", uid("TEV"), id, "submitted", a.ID, result, dump(validated), stamp)
		q.audit(a.ID, action, id, nil)
		return q.taskFor(id, &a)
	}
	if action == "task.reassign" {
		if project["ownerId"] != a.ID {
			requireRole(a, "manager")
		}
		if t["status"] != "pending" {
			fail("仅待办任务可转交；待验收任务请先退回，已验收任务不能改负责人", "STATE_CONFLICT", 409)
		}
		assignee := text(p["assigneeId"], "新负责人", 100, true)
		if !has(stringsOf(project["members"]), assignee) {
			fail("新任务负责人必须在本项目成员中", "FORBIDDEN", 403)
		}
		if assignee == t["assignee_id"] {
			fail("请选择不同的任务负责人")
		}
		note := text(p["note"], "转交原因", 4000, true)
		before := map[string]any{"assigneeId": t["assignee_id"], "result": t["result"], "evidence": parse(t["evidence_json"]), "submittedAt": t["submitted_at"]}
		q.exec("UPDATE tasks SET assignee_id=?,result='',evidence_json='[]',submitted_at=NULL,completed_at=NULL,accepted_by=NULL WHERE id=?", assignee, id)
		detail := map[string]any{"before": before, "after": map[string]any{"assigneeId": assignee}, "note": note}
		q.exec("INSERT INTO task_events VALUES(?,?,?,?,?,?,?)", uid("TEV"), id, "reassigned", a.ID, note, dump([]any{detail}), now())
		q.audit(a.ID, action, id, detail)
		return q.taskFor(id, &a)
	}
	if a.ID == t["assignee_id"] {
		fail("交付者不能验收或退回自己的任务", "SELF_APPROVAL", 403)
	}
	if project["ownerId"] != a.ID {
		requireRole(a, "manager")
	}
	if t["status"] != "submitted" || action == "task.accept" && len(list(parse(t["evidence_json"]))) == 0 {
		fail("须先提交交付说明和凭证，再由负责人验收", "STATE_CONFLICT", 409)
	}
	note := text(def(p, "note", ""), "验收意见", 4000, action == "task.return")
	stamp, kind := now(), "returned"
	if action == "task.accept" {
		q.requireActive(str(t["project_id"]))
		q.exec("UPDATE tasks SET status='completed',completed_at=?,accepted_by=? WHERE id=?", stamp, a.ID, id)
		kind = "accepted"
	} else {
		q.exec("UPDATE tasks SET status='pending',completed_at=NULL,accepted_by=NULL WHERE id=?", id)
	}
	q.exec("INSERT INTO task_events VALUES(?,?,?,?,?,?,?)", uid("TEV"), id, kind, a.ID, note, t["evidence_json"], stamp)
	q.audit(a.ID, action, id, map[string]any{"note": note})
	return q.taskFor(id, &a)
}
func (q *ledger) taskFor(id string, a *Actor) map[string]any {
	r := q.one("SELECT id,project_id AS projectId,title,assignee_id AS assigneeId,created_by AS createdBy,due_date AS dueDate,status,result,evidence_json,created_at AS createdAt,completed_at AS completedAt,submitted_at AS submittedAt,accepted_by AS acceptedBy FROM tasks WHERE id=?", id)
	if r == nil {
		fail("任务不存在", "NOT_FOUND", 404)
	}
	r["evidence"] = parse(r["evidence_json"])
	delete(r, "evidence_json")
	history := q.rows("SELECT action,actor_id AS actorId,result,evidence_json,created_at AS createdAt FROM task_events WHERE task_id=? ORDER BY rowid", id)
	for _, event := range history {
		event["evidence"] = parse(event["evidence_json"])
		delete(event, "evidence_json")
	}
	r["history"] = history
	actions := []string{}
	if a != nil {
		project := q.checkProject(*a, str(r["projectId"]))
		manages := project["ownerId"] == a.ID || role(*a, "manager")
		if r["status"] == "pending" {
			if r["assigneeId"] == a.ID {
				actions = append(actions, "complete")
			}
			if manages {
				actions = append(actions, "reassign")
			}
		} else if r["status"] == "submitted" && r["assigneeId"] != a.ID && manages {
			if project["status"] == "active" && len(list(r["evidence"])) > 0 {
				actions = append(actions, "accept")
			}
			actions = append(actions, "return")
		}
	}
	r["allowedActions"] = actions
	return r
}
