package erpflow

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"

	"crazyoffice/server/internal/identity"
	"crazyoffice/server/internal/model"
)

func TestBusinessDeliverablesRejectInternalTermsAcrossEveryTextField(t *testing.T) {
	for _, review := range []bool{false, true} {
		for _, field := range []string{"summary", "steps", "checks", "missing"} {
			if review && field == "steps" {
				continue
			}
			t.Run(field+map[bool]string{false: "-prepare", true: "-review"}[review], func(t *testing.T) {
				value := M{"summary": "核对本期已验收任务与业务记录。", "steps": []string{"由项目负责人、部门负责人依次审批"}, "checks": []string{"任务数量与台账一致"}, "missing": []string{}, "passed": true}
				internal := "按approvalChain交project_manager和manager审批，calculation.hasAmount=false，任务状态为completed。"
				if field == "summary" {
					value[field] = internal
				} else {
					value[field] = []string{internal}
				}
				err := validate(value, M{"type": "weekly_report"}, M{}, review)
				if err == nil || !strings.Contains(err.Error(), "内部标识") {
					t.Fatalf("internal text saved in %s: %v", field, err)
				}
			})
		}
	}
}
func TestBusinessDeliverablesRejectCurrentDocumentStateButKeepHistoricalFacts(t *testing.T) {
	for _, text := range []string{"当前状态为草稿，等待审批。", "本单当前状态为草稿。", "本工作单目前仍处于待审批状态。", "本周报仍为草稿。", "本单已完成。", "目前审批状态为已批准。"} {
		if err := validateBusinessLanguage(text); err == nil {
			t.Fatalf("transient document state accepted: %s", text)
		}
	}
	for _, text := range []string{"原领用单已完成，未归还1台。", "本期已验收任务1项，期末未结0项。", "本单引用相关采购单状态为已完成的收货记录。", "当前项目状态为草稿，须在立项批准后启用。", "本单需由项目负责人、部门负责人两名不同员工依次审批，批准后归档。", "本单不统计金额，不代表项目金额为零。", "来源 https://finance.example.test/manager/completed?approvalChain=1 ，收货凭证 Q-DRAFT-01。"} {
		if err := validateBusinessLanguage(text); err != nil {
			t.Fatalf("legitimate fact was rejected: %s / %v", text, err)
		}
	}
}
func TestInternalBusinessTextIsRejectedThenCorrectedByModelBeforeSaving(t *testing.T) {
	for _, who := range []string{"business", "liu"} {
		t.Run(who, func(t *testing.T) {
			f := newFlow(t)
			var mu sync.Mutex
			attempted := false
			original := "按approvalChain由project_manager和manager审批，当前状态为draft；calculation.hasAmount=false。"
			f.provider.decide = func(_ context.Context, r model.Request) (model.Decision, error) {
				d := normalDecision(r)
				if r.Role.ID == who && (d.Tool == "prepare_plan" || d.Tool == "review_plan") {
					mu.Lock()
					defer mu.Unlock()
					if !attempted {
						attempted = true
						d.Args["summary"] = original
					} else {
						feedback := r.Messages[len(r.Messages)-1]
						if feedback.Role != "tool" || !strings.Contains(feedback.Content, "correctAndRetry") || !strings.Contains(feedback.Content, "内部标识") {
							t.Error("model did not receive actionable correction receipt")
						}
					}
				}
				return d, nil
			}
			out := f.create(f.payload("project_setup"), "business-language-correction-"+ID())
			id := S(Map(out["document"])["id"])
			run := f.wait(id)
			doc := f.document(id)
			if run["status"] != "completed" || doc["status"] != "awaiting_approval" {
				t.Fatalf("model correction did not recover: %v", run)
			}
			taskID := "prepare"
			if who == "liu" {
				taskID = "review"
			}
			path := filepath.Join(f.svc.dir, S(run["id"]), "rejected-"+taskID+"-1.json")
			raw, err := os.ReadFile(path)
			if err != nil {
				t.Fatal(err)
			}
			var rejected M
			if err = json.Unmarshal(raw, &rejected); err != nil || Map(rejected["arguments"])["summary"] != original {
				t.Fatal("rejected original was changed or not preserved")
			}
			info, _ := os.Stat(path)
			if info.Mode().Perm() != 0600 {
				t.Fatal("rejection evidence not private")
			}
			proposal := Map(doc["proposal"])
			if err := validateBusinessLanguage(S(Map(proposal["plan"])["summary"]) + S(Map(proposal["review"])["summary"])); err != nil {
				t.Fatal("invalid text was persisted")
			}
			if len(Rows(doc["approvals"])) != 0 {
				t.Fatal("model correction performed human approval")
			}
		})
	}
}
func TestRepeatedInternalBusinessTextFailsWithoutSavingOrSubmitting(t *testing.T) {
	f := newFlow(t)
	f.provider.decide = func(_ context.Context, r model.Request) (model.Decision, error) {
		d := normalDecision(r)
		if d.Tool == "prepare_plan" {
			d.Args["missing"] = []string{"当前状态为draft，等待project_manager审批。"}
		}
		return d, nil
	}
	out := f.create(f.payload("project_setup"), "business-language-failure-"+ID())
	id := S(Map(out["document"])["id"])
	run := f.wait(id)
	doc := f.document(id)
	if run["status"] != "failed" || doc["status"] != "draft" || len(Map(doc["proposal"])) != 0 || len(Rows(doc["approvals"])) != 0 {
		t.Fatalf("invalid business text advanced workflow: %v", run)
	}
	if _, err := f.svc.Report(context.Background(), f.employee, id); err == nil {
		t.Fatal("rejected text was exported")
	}
	for i := 1; i <= 3; i++ {
		if _, err := os.Stat(filepath.Join(f.svc.dir, S(run["id"]), "rejected-prepare-"+string(rune('0'+i))+".json")); err != nil {
			t.Fatal("missing rejection evidence", i)
		}
	}
}

func TestBusinessNamesKeepFormalEnglishButCannotWhitelistFieldsStatesOrPeopleUUID(t *testing.T) {
	id := "12345678-1234-1234-1234-123456789abc"
	d := M{"id": "DOC-" + id, "title": "finance sales hr summary", "input": M{"partner": "manager active", "quotationReference": "Q-" + id, "objective": "approvalChain 当前状态为draft"}, "lines": []M{{"name": "checks steps", "sku": "sales-SERVER"}}}
	scope := M{"project": M{"name": "finance sales hr summary", "customer": "manager active"}, "employeeProfile": M{"id": id, "name": "summary"}, "movements": []M{{"reference": id}}}
	context := languageContext("summary", d, scope, M{})
	if err := validateBusinessLanguage("项目 finance sales hr summary，客户 manager active，产品 checks steps，型号 sales-SERVER。", context); err != nil {
		t.Fatal("formal business names were translated or rejected", err)
	}
	for _, text := range []string{"按approvalChain审核。", "当前状态为active。", "本单目前状态为draft。", "员工" + id + "在册。"} {
		if err := validateBusinessLanguage(text, context); err == nil {
			t.Fatal("business literal bypassed a hard constraint", text)
		}
	}
	for _, text := range []string{"业务单 DOC-" + id + "已完成收货。", "报价凭证 Q-" + id + "待确认。", "收货凭证" + id + "已登记。"} {
		if err := validateBusinessLanguage(text, context); err != nil {
			t.Fatal("real reference was rejected", text, err)
		}
	}
	if err := validateBusinessLanguage("员工状态为active。"); err == nil {
		t.Fatal("internal employee state was accepted")
	}
	if err := validateBusinessLanguage("quoteEvidence有8个pending_inquiry。"); err == nil {
		t.Fatal("internal quotation status was accepted")
	}
}

func TestWeeklyTypeCountCorrectionUsesRealFrozenLedgerOnBothRoles(t *testing.T) {
	for _, who := range []string{"business", "liu"} {
		t.Run(who, func(t *testing.T) {
			f := newFlow(t)
			f.activate()
			complete := func(payload M, action string, quantity int64) M {
				out := f.create(payload, "weekly-count-seed-"+ID())
				id := S(Map(out["document"])["id"])
				if run := f.wait(id); run["status"] != "completed" {
					t.Fatalf("seed failed: %v", run)
				}
				d := f.approved(id)
				args := M{"reference": "REF-" + ID()}
				if action == "receive" || action == "ship" {
					args["lines"] = []M{{"lineId": Rows(d["lines"])[0]["id"], "quantity": quantity}}
				}
				return f.action(f.admin, id, action, args)
			}
			complete(f.payload("purchase"), "receive", 10)
			sales := f.payload("sales")
			sales["lines"] = []M{{"productId": f.product["id"], "quantity": 2}}
			complete(sales, "ship", 2)
			issued := complete(f.payload("resource"), "post", 0)
			returned := f.payload("resource")
			Map(returned["input"])["operation"] = "return"
			Map(returned["input"])["originalDocumentId"] = issued["id"]
			complete(returned, "post", 0)
			count := f.payload("stocktake")
			count["lines"] = []M{{"productId": f.product["id"], "countedQuantity": 8}}
			complete(count, "post", 0)
			complete(f.payload("project_delivery"), "post", 0)
			var mu sync.Mutex
			attempted := false
			f.provider.decide = func(_ context.Context, r model.Request) (model.Decision, error) {
				d := normalDecision(r)
				if r.Role.ID == who && (d.Tool == "prepare_plan" || d.Tool == "review_plan") {
					mu.Lock()
					defer mu.Unlock()
					if !attempted {
						attempted = true
						d.Args["summary"] = "本期完成7种业务类型。"
					} else {
						feedback := r.Messages[len(r.Messages)-1].Content
						if !strings.Contains(feedback, "7份业务单据") || !strings.Contains(feedback, "6种业务类型") {
							t.Error("correction omitted actual document/type counts")
						}
						d.Args["summary"] = "本期已确认7份业务单据，涉及6种业务类型。"
					}
				}
				return d, nil
			}
			out := f.create(f.payload("weekly_report"), "weekly-type-correct-"+ID())
			id := S(Map(out["document"])["id"])
			run := f.wait(id)
			doc := f.document(id)
			if run["status"] != "completed" || doc["status"] != "awaiting_approval" {
				t.Fatalf("weekly model correction did not recover: %v", run)
			}
			counts := businessDocumentSummary(Map(Map(doc["input"])["facts"]))
			if N(counts["documentCount"]) != 7 || N(counts["typeCount"]) != 6 {
				t.Fatal("frozen actual ledger fixture differs from expected", counts)
			}
			key := "plan"
			if who == "liu" {
				key = "review"
			}
			if !strings.Contains(S(Map(Map(doc["proposal"])[key])["summary"]), "6种业务类型") {
				t.Fatal("model correction was not saved")
			}
			if len(Rows(doc["approvals"])) != 0 {
				t.Fatal("model correction skipped human approval")
			}
		})
	}
}

func TestOnboardingContextOffersRealNameAndChineseApprovalRoles(t *testing.T) {
	f := newFlow(t)
	d := f.payload("onboarding")
	snapshot, err := f.svc.Snapshot(context.Background(), f.employee)
	if err != nil {
		t.Fatal(err)
	}
	calculation, err := exact(d, snapshot)
	if err != nil {
		t.Fatal(err)
	}
	scope := f.svc.scoped(f.employee, d, snapshot, calculation)
	if Map(scope["employeeProfile"])["name"] != f.employee.Name {
		t.Fatal("model was not supplied permitted target name")
	}
	d["approvalChain"] = []string{"hr", "manager"}
	labels := Strings(rules(d)["approvalRoleNames"])
	if len(labels) != 2 || labels[0] != "人事" || labels[1] != "部门负责人" {
		t.Fatal("missing Chinese approval roles", labels)
	}
	context := languageContext(f.employee.Name, d, scope, calculation)
	if err = validateBusinessLanguage("员工"+f.employee.ID[:8]+"已在册。", context); err == nil {
		t.Fatal("truncated person ID accepted")
	}
}

func TestAuthorizedProjectContextOffersOnlySelectedMembersPublicNamesAndPositions(t *testing.T) {
	f := newFlow(t)
	outsiderInvitation, err := f.ids.CreateInvitation(f.admin.ID, identity.InvitationInput{Username: "outside-person", Name: "无关项目员工", Title: "无关岗位", Roles: []string{"employee"}})
	if err != nil {
		t.Fatal(err)
	}
	outsider, err := f.ids.AcceptInvitation(outsiderInvitation.Token, "outside-isolated-password-2026")
	if err != nil {
		t.Fatal(err)
	}
	snapshot, err := f.svc.Snapshot(context.Background(), f.employee)
	if err != nil {
		t.Fatal(err)
	}
	d := f.payload("project_setup")
	scope := f.svc.scoped(f.employee, d, snapshot, M{})
	members := Rows(scope["projectMembers"])
	if len(members) != 3 {
		t.Fatalf("expected selected project members once each, got %d", len(members))
	}
	for _, member := range members {
		if member["id"] == outsider.ID || member["name"] == outsider.Name {
			t.Fatal("unrelated employee escaped project scope")
		}
		if member["id"] == f.employee.ID && (member["name"] != f.employee.Name || member["title"] != "业务员" || member["projectRole"] != "项目成员") {
			t.Fatal("known public member details missing", member)
		}
		for _, key := range []string{"password", "hash", "epoch", "username", "email", "roles"} {
			if member[key] != nil {
				t.Fatal("member enrichment exposed unrelated account data", key)
			}
		}
	}
	ctx := languageContext(f.employee.Name, d, scope, M{})
	if ctx["projectMemberNamesComplete"] != true {
		t.Fatal("known member names not represented as complete")
	}
	for _, text := range []string{"成员UUID未提供对应姓名。", "物品领用（issue）。", "物品归还（return）。", "项目成员姓名未提供。", "缺少项目成员的姓名。"} {
		if err := validateBusinessLanguage(text, ctx); err == nil {
			t.Fatal("internal or false missing member claim accepted", text)
		}
	}
	for _, text := range []string{"已提供成员姓名，具体项目分工待确认。", "成员目录岗位为业务员，不等于已确认项目分工。", "领用后以仓管实际出库为准。"} {
		if err := validateBusinessLanguage(text, ctx); err != nil {
			t.Fatal("true member facts or limits rejected", text, err)
		}
	}
	scope["projectMembers"] = []M{{"id": "unavailable", "name": ""}}
	if err := validateBusinessLanguage("项目成员姓名待确认。", languageContext(f.employee.Name, d, scope, M{})); err != nil {
		t.Fatal("genuinely unavailable name was not allowed as missing", err)
	}
	d["projectId"] = "not-in-authorized-snapshot"
	if rows := Rows(f.svc.scoped(f.employee, d, snapshot, M{})["projectMembers"]); len(rows) != 0 {
		t.Fatal("project member directory expanded beyond authorized snapshot")
	}
}

func TestMemberUUIDAndResourceOperationCodesAreCorrectedOnBothRolesBeforeSaving(t *testing.T) {
	for _, typ := range []string{"project_setup", "resource"} {
		for _, who := range []string{"business", "liu"} {
			t.Run(typ+"-"+who, func(t *testing.T) {
				f := newFlow(t)
				if typ == "resource" {
					f.activate()
				}
				var mu sync.Mutex
				attempts := 0
				f.provider.decide = func(_ context.Context, r model.Request) (model.Decision, error) {
					d := normalDecision(r)
					if r.Role.ID == who && (d.Tool == "prepare_plan" || d.Tool == "review_plan") {
						mu.Lock()
						defer mu.Unlock()
						attempts++
						if attempts == 1 {
							if typ == "project_setup" {
								d.Args["missing"] = []string{"成员UUID未提供对应姓名"}
							} else {
								d.Args["checks"] = []string{"物品领用（issue）"}
							}
						} else if !strings.Contains(r.Messages[len(r.Messages)-1].Content, "correctAndRetry") {
							t.Error("model did not receive correction receipt")
						}
					}
					return d, nil
				}
				out := f.create(f.payload(typ), "member-operation-correction-"+ID())
				id := S(Map(out["document"])["id"])
				run := f.wait(id)
				if run["status"] != "completed" || f.document(id)["status"] != "awaiting_approval" || attempts != 2 {
					t.Fatal("model correction failed or bypassed human approval", run)
				}
			})
		}
	}
	formal := languageContext("", M{"title": "UUID issue return"}, M{}, M{})
	if err := validateBusinessLanguage("项目UUID issue return需要核对范围。", formal); err != nil {
		t.Fatal("actual formal name was forcibly translated", err)
	}
}

func TestDelegatedEmployeeContextSeparatesStoredRequesterFromSelectedEmployee(t *testing.T) {
	f := newFlow(t)
	snapshot, err := f.svc.Snapshot(context.Background(), f.admin)
	if err != nil {
		t.Fatal(err)
	}
	for _, typ := range []string{"resource", "onboarding"} {
		d := f.payload(typ)
		d["requesterId"] = f.admin.ID
		// A different authorized actor can later retry. The creator recorded
		// on the business document remains the applicant.
		scope := f.svc.scoped(f.approver, d, snapshot, M{})
		if Map(scope["document"])["requesterId"] != f.admin.ID || Map(scope["requesterProfile"])["name"] != f.admin.Name || Map(scope["employeeProfile"])["name"] != f.employee.Name {
			t.Fatal("applicant and employee were conflated", typ)
		}
		relation := Map(scope["employeeRelationship"])
		if relation["申请人"] != f.admin.Name || relation["办理对象"] != f.employee.Name || relation["代办"] != true {
			t.Fatal("delegation relationship lacks authoritative identities", relation)
		}
		for _, key := range []string{"password", "hash", "epoch", "username", "email", "roles"} {
			if Map(scope["requesterProfile"])[key] != nil {
				t.Fatal("requester enrichment exposed private account data", key)
			}
		}
		ctx := languageContext(f.approver.Name, d, scope, M{})
		for _, text := range []string{"申请人" + f.employee.Name + "已在册。", "申请人为：" + f.employee.Name + "。", f.employee.Name + "为申请人。", f.employee.Name + "（申请人）。", "申请人与" + S(relation["对象身份"]) + "为同一员工。"} {
			if err := validateBusinessLanguage(text, ctx); err == nil || !strings.Contains(err.Error(), "人员归属") {
				t.Fatal("incorrect applicant attribution accepted", typ, text, err)
			}
		}
		for _, text := range []string{"申请人为" + f.admin.Name + "，" + S(relation["对象身份"]) + "为" + f.employee.Name + "。", "申请人不是" + f.employee.Name + "。", f.employee.Name + "不是申请人。", "由" + f.admin.Name + "代" + f.employee.Name + "申请，实际办理以审批及交接为准。"} {
			if err := validateBusinessLanguage(text, ctx); err != nil {
				t.Fatal("accurate delegation statement rejected", typ, text, err)
			}
		}
		d["requesterId"] = f.employee.ID
		selfScope := f.svc.scoped(f.employee, d, snapshot, M{})
		if err := validateBusinessLanguage("申请人"+f.employee.Name+"本人办理。", languageContext(f.employee.Name, d, selfScope, M{})); err != nil {
			t.Fatal("self service was rejected", typ, err)
		}
	}
}

func TestDelegatedEmployeeMislabelIsCorrectedByBothRolesBeforeSaving(t *testing.T) {
	for _, typ := range []string{"resource", "onboarding"} {
		for _, who := range []string{"business", "liu"} {
			t.Run(typ+"-"+who, func(t *testing.T) {
				f := newFlow(t)
				f.activate()
				var mu sync.Mutex
				attempts := 0
				f.provider.decide = func(_ context.Context, r model.Request) (model.Decision, error) {
					decision := normalDecision(r)
					if r.Role.ID == who && (decision.Tool == "prepare_plan" || decision.Tool == "review_plan") {
						mu.Lock()
						defer mu.Unlock()
						attempts++
						if attempts == 1 {
							decision.Args["checks"] = []string{"申请人" + f.employee.Name + "已在册。"}
						} else {
							feedback := r.Messages[len(r.Messages)-1].Content
							if !strings.Contains(feedback, "correctAndRetry") || !strings.Contains(feedback, "实际申请人为"+f.admin.Name) {
								t.Error("correction omitted actual stored applicant")
							}
							role := "领用人"
							if typ == "onboarding" {
								role = "岗位准备对象"
							}
							decision.Args["checks"] = []string{"申请人为" + f.admin.Name + "，" + role + "为" + f.employee.Name + "，本单为代办。"}
						}
					}
					return decision, nil
				}
				out, err := f.svc.Create(context.Background(), f.admin, f.payload(typ), "delegated-employee-correction-"+ID())
				if err != nil {
					t.Fatal(err)
				}
				id := S(Map(out["document"])["id"])
				run := f.wait(id)
				doc := f.document(id)
				if run["status"] != "completed" || doc["status"] != "awaiting_approval" || attempts != 2 || doc["requesterId"] != f.admin.ID || Map(doc["input"])["employeeId"] != f.employee.ID {
					t.Fatal("corrected attribution did not preserve business ownership", run)
				}
				key := "plan"
				if who == "liu" {
					key = "review"
				}
				checks := strings.Join(Strings(Map(Map(doc["proposal"])[key])["checks"]), "。")
				if !strings.Contains(checks, "申请人为"+f.admin.Name) || strings.Contains(checks, "申请人"+f.employee.Name+"已在册") || len(Rows(doc["approvals"])) != 0 {
					t.Fatal("mislabel saved or human approval was skipped", checks)
				}
			})
		}
	}
}
