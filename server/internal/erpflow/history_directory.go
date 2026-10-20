package erpflow

import (
	"encoding/json"
	"sort"

	"crazyoffice/server/internal/identity"
)

// historicalEmployeeIDs accepts only the already-authorized ledger snapshot.
// Follow typed, server-recorded references, never arbitrary proposal/input JSON:
// otherwise a caller could turn a note into a lookup of an unrelated retiree.
func historicalEmployeeIDs(snapshot M) []string {
	ids := map[string]bool{}
	add := func(value any) {
		if id := S(value); id != "" {
			ids[id] = true
		}
	}
	addMany := func(value any) {
		for _, id := range Strings(value) {
			add(id)
		}
	}
	facts := func(value M) {
		for _, employee := range Rows(value["employees"]) {
			add(employee["employeeId"])
		}
		for _, task := range Rows(value["tasks"]) {
			add(task["employeeId"])
			add(task["acceptedBy"])
		}
		for _, task := range Rows(value["taskFacts"]) {
			add(task["assigneeIdAtPeriodEnd"])
			addMany(task["assignedEmployeeIds"])
			addMany(task["submittedEmployeeIds"])
		}
		for _, document := range Rows(value["businessDocuments"]) {
			add(document["requesterId"])
			addMany(document["participantIds"])
		}
	}
	for _, document := range Rows(snapshot["documents"]) {
		add(document["requesterId"])
		for _, field := range []string{"approvals", "approvalHistory"} {
			for _, approval := range Rows(document[field]) {
				add(approval["actorId"])
			}
		}
		input := Map(document["input"])
		switch document["type"] {
		case "resource", "onboarding":
			add(input["employeeId"])
		case "weekly_report":
			facts(Map(input["facts"]))
		}
	}
	for _, task := range Rows(snapshot["tasks"]) {
		add(task["assigneeId"])
		add(task["acceptedBy"])
		add(task["createdBy"])
		for _, event := range Rows(task["history"]) {
			add(event["actorId"])
		}
	}
	for _, record := range Rows(snapshot["performance"]) {
		add(record["confirmedBy"])
		facts(Map(record["facts"]))
	}
	for _, project := range Rows(snapshot["projects"]) {
		add(project["ownerId"])
		addMany(project["members"])
	}
	for _, loan := range Rows(snapshot["loans"]) {
		add(loan["employeeId"])
	}
	for _, movement := range Rows(snapshot["movements"]) {
		add(movement["actorId"])
	}
	for _, event := range Rows(snapshot["audit"]) {
		add(event["actorId"])
	}
	out := make([]string, 0, len(ids))
	for id := range ids {
		out = append(out, id)
	}
	sort.Strings(out)
	return out
}

// Keep the assignable directory unchanged. Historical rows resolve a name only;
// they expose no account, role or personnel details and remain non-assignable.
func (s *Service) directoryWithHistory(users []identity.PublicEmployee, snapshot M) []M {
	out := make([]M, 0, len(users))
	seen := map[string]bool{}
	for _, user := range users {
		raw, _ := json.Marshal(user)
		row := M{}
		_ = json.Unmarshal(raw, &row)
		out = append(out, row)
		seen[user.ID] = true
	}
	for _, id := range historicalEmployeeIDs(snapshot) {
		if seen[id] {
			continue
		}
		if employee := s.Identity.GetEmployee(id); employee != nil && !employee.Active {
			out = append(out, M{"id": employee.ID, "name": employee.Name, "active": false})
			seen[id] = true
		}
	}
	return out
}
