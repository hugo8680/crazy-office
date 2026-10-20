package erp

import "time"

func businessDate(value any) string {
	s := str(value)
	if s == "" {
		return ""
	}
	t, e := time.Parse(time.RFC3339Nano, s)
	if e != nil {
		return ""
	}
	return t.In(time.FixedZone("Asia/Shanghai", 8*3600)).Format("2006-01-02")
}
func within(s, start, end string) bool           { return s >= start && s <= end }
func addString(m map[string]any, key, id string) { m[key] = append(m[key].([]string), id) }
func (q *ledger) weeklyFacts(pid, start, end string) map[string]any {
	tasks := q.rows("SELECT id,title,assignee_id AS employeeId,completed_at AS completedAt,accepted_by AS acceptedBy FROM tasks WHERE project_id=? AND status='completed' AND accepted_by IS NOT NULL AND date(completed_at,'+8 hours')>=? AND date(completed_at,'+8 hours')<=? ORDER BY completed_at,id", pid, start, end)
	people := map[string]map[string]any{}
	ordered := []map[string]any{}
	person := func(id string) map[string]any {
		p := people[id]
		if p == nil {
			p = map[string]any{"employeeId": id, "assignedTasks": 0, "submittedTasks": 0, "pendingTasks": 0, "overdueTasks": 0, "completedTasks": int64(0), "acceptedDeliveries": 0, "businessParticipation": 0}
			for _, k := range []string{"taskIds", "assignedTaskIds", "submittedTaskIds", "pendingTaskIds", "overdueTaskIds", "acceptedDeliveryIds", "businessDocumentIds"} {
				p[k] = []string{}
			}
			people[id] = p
			ordered = append(ordered, p)
		}
		return p
	}
	for _, task := range tasks {
		p := person(str(task["employeeId"]))
		p["completedTasks"] = num(p["completedTasks"]) + 1
		addString(p, "taskIds", str(task["id"]))
	}
	taskFacts := []map[string]any{}
	for _, task := range q.rows("SELECT * FROM tasks WHERE project_id=? ORDER BY created_at,id", pid) {
		if businessDate(task["created_at"]) > end {
			continue
		}
		events := q.rows("SELECT * FROM task_events WHERE task_id=? ORDER BY rowid", task["id"])
		original := str(task["assignee_id"])
		for _, ev := range events {
			if ev["action"] == "reassigned" {
				entries := list(parse(ev["evidence_json"]))
				if len(entries) > 0 {
					original = str(obj(obj(entries[0])["before"])["assigneeId"])
				}
				break
			}
		}
		type assignment struct{ id, stamp string }
		assignments := []assignment{{original, str(task["created_at"])}}
		current, state := original, "pending"
		submitted := map[string]bool{}
		hasSubmitted := false
		for _, ev := range events {
			ed := businessDate(ev["created_at"])
			assigned := ""
			if ev["action"] == "reassigned" {
				entries := list(parse(ev["evidence_json"]))
				assigned = str(obj(obj(entries[0])["after"])["assigneeId"])
				assignments = append(assignments, assignment{assigned, str(ev["created_at"])})
			}
			if ev["action"] == "submitted" {
				hasSubmitted = true
				if within(ed, start, end) {
					submitted[str(ev["actor_id"])] = true
				}
			}
			if ed <= end {
				switch ev["action"] {
				case "reassigned":
					current, state = assigned, "pending"
				case "submitted":
					state = "submitted"
				case "returned":
					state = "pending"
				case "accepted":
					state = "completed"
				}
			}
		}
		if !hasSubmitted && str(task["submitted_at"]) != "" {
			sd := businessDate(task["submitted_at"])
			if within(sd, start, end) {
				submitted[current] = true
			}
			if sd <= end && state == "pending" {
				state = "submitted"
			}
		}
		if task["status"] == "completed" && str(task["accepted_by"]) != "" && businessDate(task["completed_at"]) <= end {
			state = "completed"
		}
		assignedPeople := map[string]bool{}
		for _, assignment := range assignments {
			if within(businessDate(assignment.stamp), start, end) {
				assignedPeople[assignment.id] = true
			}
		}
		assignedIDs, submittedIDs := []string{}, []string{}
		for id := range assignedPeople {
			assignedIDs = append(assignedIDs, id)
		}
		for id := range submitted {
			submittedIDs = append(submittedIDs, id)
		}
		sortStrings(assignedIDs)
		sortStrings(submittedIDs)
		for _, id := range assignedIDs {
			addString(person(id), "assignedTaskIds", str(task["id"]))
		}
		for _, id := range submittedIDs {
			addString(person(id), "submittedTaskIds", str(task["id"]))
		}
		pending := state != "completed"
		due := str(task["due_date"])
		overdue := pending && due != "" && due <= end
		if pending {
			addString(person(current), "pendingTaskIds", str(task["id"]))
		}
		if overdue {
			addString(person(current), "overdueTaskIds", str(task["id"]))
		}
		taskFacts = append(taskFacts, map[string]any{"id": task["id"], "title": task["title"], "assigneeIdAtPeriodEnd": current, "stateAtPeriodEnd": state, "dueDate": task["due_date"], "assignedEmployeeIds": assignedIDs, "submittedEmployeeIds": submittedIDs, "overdueAtPeriodEnd": overdue})
	}
	confirmed := []map[string]any{}
	for _, d := range q.rows("SELECT id,type,title,requester_id,updated_at FROM documents WHERE project_id=? AND status='completed' AND date(updated_at,'+8 hours')>=? AND date(updated_at,'+8 hours')<=? ORDER BY updated_at,id", pid, start, end) {
		participants := map[string]bool{str(d["requester_id"]): true}
		for _, r := range q.rows("SELECT actor_id FROM approvals WHERE document_id=? AND decision='approved' AND round=(SELECT approval_round FROM documents WHERE id=?)", d["id"], d["id"]) {
			participants[str(r["actor_id"])] = true
		}
		for _, r := range q.rows("SELECT actor_id FROM movements WHERE document_id=?", d["id"]) {
			participants[str(r["actor_id"])] = true
		}
		for _, r := range q.rows("SELECT actor_id FROM audit WHERE entity_id=? AND action='document.post'", d["id"]) {
			participants[str(r["actor_id"])] = true
		}
		ids := []string{}
		for id := range participants {
			ids = append(ids, id)
		}
		sortStrings(ids)
		for _, id := range ids {
			addString(person(id), "businessDocumentIds", str(d["id"]))
		}
		if d["type"] == "project_delivery" {
			addString(person(str(d["requester_id"])), "acceptedDeliveryIds", str(d["id"]))
		}
		confirmed = append(confirmed, map[string]any{"id": d["id"], "type": d["type"], "title": d["title"], "completedAt": d["updated_at"], "requesterId": d["requester_id"], "participantIds": ids})
	}
	metrics := map[string]string{"assignedTasks": "assignedTaskIds", "submittedTasks": "submittedTaskIds", "pendingTasks": "pendingTaskIds", "overdueTasks": "overdueTaskIds", "acceptedDeliveries": "acceptedDeliveryIds", "businessParticipation": "businessDocumentIds"}
	for _, p := range ordered {
		for metric, ids := range metrics {
			set := map[string]bool{}
			for _, id := range p[ids].([]string) {
				set[id] = true
			}
			p[metric] = len(set)
		}
	}
	assigned, submitted, pending, overdue, deliveries := 0, 0, 0, 0, 0
	for _, t := range taskFacts {
		if len(t["assignedEmployeeIds"].([]string)) > 0 {
			assigned++
		}
		if len(t["submittedEmployeeIds"].([]string)) > 0 {
			submitted++
		}
		if t["stateAtPeriodEnd"] != "completed" {
			pending++
		}
		if t["overdueAtPeriodEnd"] == true {
			overdue++
		}
	}
	for _, d := range confirmed {
		if d["type"] == "project_delivery" {
			deliveries++
		}
	}
	return map[string]any{"assignedTasks": assigned, "submittedTasks": submitted, "pendingTasks": pending, "overdueTasks": overdue, "completedTasks": len(tasks), "acceptedDeliveries": deliveries, "businessParticipation": len(confirmed), "tasks": tasks, "taskFacts": taskFacts, "businessDocuments": confirmed, "employees": ordered, "scoresAssigned": false, "timezone": "Asia/Shanghai", "basis": "分配与提交按期间内事实去重；验收按真实负责人确认日期；待办及逾期按北京时间期末日结束统计，含待验收；交付归属原申请人，业务参与按已完成单据去重，人员间可重叠。截止生成时冻结，不生成工时、收入归属、评分或排名。"}
}
