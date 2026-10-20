package erpflow

import (
	"context"
	"encoding/json"
	"strings"
	"testing"

	"crazyoffice/server/internal/identity"
)

func TestHistoricalDirectoryOnlyFollowsTypedLedgerReferences(t *testing.T) {
	tests := []struct {
		name     string
		snapshot M
	}{
		{"requester", M{"documents": []M{{"requesterId": "retired"}}}},
		{"resource", M{"documents": []M{{"type": "resource", "input": M{"employeeId": "retired"}}}}},
		{"onboarding", M{"documents": []M{{"type": "onboarding", "input": M{"employeeId": "retired"}}}}},
		{"approval", M{"documents": []M{{"approvals": []M{{"actorId": "retired"}}}}}},
		{"prior_approval", M{"documents": []M{{"approvalHistory": []M{{"actorId": "retired"}}}}}},
		{"task_assignee", M{"tasks": []M{{"assigneeId": "retired"}}}},
		{"task_acceptor", M{"tasks": []M{{"acceptedBy": "retired"}}}},
		{"task_history", M{"tasks": []M{{"history": []M{{"actorId": "retired"}}}}}},
		{"frozen_weekly_employee", M{"documents": []M{{"type": "weekly_report", "input": M{"facts": M{"employees": []M{{"employeeId": "retired"}}}}}}}},
		{"performance_employee", M{"performance": []M{{"facts": M{"employees": []M{{"employeeId": "retired"}}}}}}},
		{"performance_confirmed", M{"performance": []M{{"confirmedBy": "retired"}}}},
		{"frozen_assignee", M{"performance": []M{{"facts": M{"taskFacts": []M{{"assigneeIdAtPeriodEnd": "retired"}}}}}}},
		{"frozen_participant", M{"performance": []M{{"facts": M{"businessDocuments": []M{{"participantIds": []string{"retired"}}}}}}}},
		{"project_member", M{"projects": []M{{"members": []string{"retired"}}}}},
		{"loan", M{"loans": []M{{"employeeId": "retired"}}}},
		{"movement", M{"movements": []M{{"actorId": "retired"}}}},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			ids := historicalEmployeeIDs(tt.snapshot)
			if len(ids) != 1 || ids[0] != "retired" {
				t.Fatal("recorded historical participant was not resolved")
			}
		})
	}
	injected := M{"documents": []M{{"type": "project_setup", "input": M{"employeeId": "unrelated", "facts": M{"employees": []M{{"employeeId": "unrelated"}}}}, "proposal": M{"requesterId": "unrelated"}, "evidence": []M{{"actorId": "unrelated"}}}}, "audit": []M{{"detail": M{"employeeId": "unrelated"}}}}
	if len(historicalEmployeeIDs(injected)) != 0 {
		t.Fatal("arbitrary input or proposal became a private directory lookup")
	}
}

func TestDisabledHistoricalNamesRemainVisibleWithoutDirectoryOrAssignmentExpansion(t *testing.T) {
	f := newFlow(t) // Scripted fixture provider only; no external model request.
	f.activate()
	task := f.command(f.admin, "task.create", M{"projectId": f.project["id"], "title": "历史员工已验收交付", "assigneeId": f.approver.ID})
	f.command(f.approver, "task.complete", M{"id": task["id"], "result": "资料已交付", "evidence": []M{{"name": "交付记录", "reference": "HISTORY-DELIVERY-01"}}})
	f.command(f.admin, "task.accept", M{"id": task["id"], "note": "已核对"})
	weekly := f.create(f.payload("weekly_report"), "historical-weekly-"+ID())
	weeklyID := S(Map(weekly["document"])["id"])
	if f.wait(weeklyID)["status"] != "completed" {
		t.Fatal("fixture report did not finish")
	}
	f.approved(weeklyID)
	f.action(f.admin, weeklyID, "post", M{"reference": "HISTORICAL-WEEKLY-01"})
	onboard := f.payload("onboarding")
	Map(onboard["input"])["employeeId"] = f.approver.ID
	f.command(f.approver, "document.create", onboard)

	invitation, e := f.ids.CreateInvitation(f.admin.ID, identity.InvitationInput{Username: "unrelated-retired-private", Name: "无关离职人员私密姓名", Department: "无关部门", Title: "不应公开的岗位", Roles: []string{"employee", "manager"}})
	if e != nil {
		t.Fatal(e)
	}
	unrelated, e := f.ids.AcceptInvitation(invitation.Token, "unrelated-isolated-test-password-2026")
	if e != nil {
		t.Fatal(e)
	}
	privateProject := f.command(f.admin, "project.create", M{"name": "无权查看的离职项目", "customer": "无关客户", "ownerId": f.admin.ID, "members": []string{f.admin.ID, unrelated.ID}})
	f.command(unrelated, "document.create", M{"type": "project_setup", "projectId": privateProject["id"], "input": M{"objective": "仅无关项目可见"}})
	f.command(f.admin, "task.create", M{"projectId": privateProject["id"], "title": "无关离职任务", "assigneeId": unrelated.ID})
	for _, id := range []string{f.approver.ID, unrelated.ID} {
		if _, e := f.ids.UpdateEmployee(f.admin.ID, id, M{"active": false}); e != nil {
			t.Fatal(e)
		}
	}

	// Ordinary employee sees only names of inactive people actually referenced
	// by their authorized records. No disabled account/role/profile is exposed.
	snapshot, e := f.svc.Snapshot(context.Background(), f.employee)
	if e != nil {
		t.Fatal(e)
	}
	var historical M
	for _, user := range Rows(snapshot["users"]) {
		if user["id"] == f.approver.ID {
			historical = user
		}
		if user["id"] == unrelated.ID {
			t.Fatal("unrelated inactive employee entered a scoped directory")
		}
	}
	if len(historical) != 3 || historical["name"] != f.approver.Name || historical["active"] != false {
		t.Fatal("inactive history must contain only id, name and active=false")
	}
	raw, _ := json.Marshal(snapshot)
	for _, private := range []string{unrelated.ID, unrelated.Name, unrelated.Username, unrelated.Title, S(privateProject["id"])} {
		if strings.Contains(string(raw), private) {
			t.Fatal("unrelated inactive personnel or project data leaked")
		}
	}
	directory, e := f.ids.ListDirectory(f.employee.ID)
	if e != nil {
		t.Fatal(e)
	}
	for _, person := range directory {
		if person.ID == f.approver.ID || person.ID == unrelated.ID {
			t.Fatal("inactive history expanded the assignable employee directory")
		}
	}
	for _, action := range []string{"task.create", "task.reassign"} {
		domainStatus(t, f.svc.ValidatePeople(action, M{"assigneeId": f.approver.ID}), 400)
	}
	for _, action := range []string{"project.create", "project.update"} {
		domainStatus(t, f.svc.ValidatePeople(action, M{"ownerId": f.approver.ID}), 400)
	}
	for _, typ := range []string{"resource", "onboarding"} {
		domainStatus(t, f.svc.ValidatePeople("document.create", M{"type": typ, "input": M{"employeeId": f.approver.ID}}), 400)
	}
	report, e := f.svc.Report(context.Background(), f.employee, weeklyID)
	if e != nil {
		t.Fatal(e)
	}
	if !strings.Contains(string(report), f.approver.Name) || strings.Contains(string(report), f.approver.ID) || strings.Contains(string(report), unrelated.Name) || strings.Contains(string(report), unrelated.ID) {
		t.Fatal("authorized historical report failed to resolve names or leaked unrelated identities")
	}
	_, e = f.svc.Report(context.Background(), f.approver, weeklyID)
	domainStatus(t, e, 403)
}
