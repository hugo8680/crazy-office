// verify-erp performs an explicitly opted-in, real-model acceptance run against
// an isolated employee directory and ledger. None of its approvals or receipts
// describe company business and no existing database is modified.
package main

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"time"

	"crazyoffice/server/internal/erp"
	"crazyoffice/server/internal/erpflow"
	"crazyoffice/server/internal/identity"
	"crazyoffice/server/internal/model"
)

type M = map[string]any
type acceptance struct {
	dir                             string
	ids                             *identity.Store
	store                           *erp.Store
	service                         *erpflow.Service
	admin, requester, first, second *identity.Actor
	project, product                M
	checks                          []M
	model                           string
}

func emit(value any) { b, _ := json.Marshal(value); fmt.Println(string(b)) }
func safe(message string) string {
	for _, name := range []string{"DASHSCOPE_API_KEY", "OPENAI_API_KEY", "TOKENDANCE_API_KEY", "OFFICE_SESSION_SECRET"} {
		if value := os.Getenv(name); value != "" {
			message = strings.ReplaceAll(message, value, "[凭据已隐藏]")
		}
	}
	return regexp.MustCompile(`sk-[A-Za-z0-9._-]+|Bearer\s+[A-Za-z0-9._-]+`).ReplaceAllString(message, "[凭据已隐藏]")
}
func writePrivate(path string, value any) error {
	raw, e := json.MarshalIndent(value, "", "  ")
	if e != nil {
		return e
	}
	if e = os.WriteFile(path, append(raw, '\n'), 0600); e != nil {
		return e
	}
	return os.Chmod(path, 0600)
}
func check(condition bool, message string) error {
	if !condition {
		return errors.New(message)
	}
	return nil
}
func privateConfig(path string) error {
	if path == "" {
		return nil
	}
	f, e := os.Open(path)
	if e != nil {
		return fmt.Errorf("验收专用模型配置不可读取")
	}
	defer f.Close()
	allowed := map[string]bool{"DASHSCOPE_API_KEY": true, "OFFICE_DASHSCOPE_URL": true, "OPENAI_API_KEY": true, "OFFICE_OPENAI_URL": true, "TOKENDANCE_API_KEY": true, "OFFICE_TOKENDANCE_URL": true, "OFFICE_MODEL": true, "OFFICE_MODEL_TIMEOUT_MS": true}
	provider := "dashscope"
	scanner := bufio.NewScanner(f)
	scanner.Buffer(make([]byte, 4096), 64*1024)
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		key, value, ok := strings.Cut(line, "=")
		if !ok || (!allowed[key] && key != "OFFICE_PROVIDER") {
			continue
		}
		value = strings.TrimSpace(value)
		if len(value) >= 2 && ((value[0] == '\'' && value[len(value)-1] == '\'') || (value[0] == '"' && value[len(value)-1] == '"')) {
			value = value[1 : len(value)-1]
		}
		if key == "OFFICE_PROVIDER" {
			if value != "dashscope" && value != "tokendance" && value != "openai" {
				return errors.New("验收私有配置中的模型服务无效")
			}
			provider = value
			continue
		}
		if e = os.Setenv(key, value); e != nil {
			return e
		}
	}
	if e = scanner.Err(); e != nil {
		return errors.New("验收专用模型配置格式或大小不正确")
	}
	return os.Setenv("OFFICE_PROVIDER", provider)
}
func (a *acceptance) command(actor *identity.Actor, action string, payload M) (M, error) {
	return a.store.Command(context.Background(), erpflow.Actor(actor), action, payload, "acceptance-"+erpflow.ID())
}
func (a *acceptance) employee(username string, roles []string) (*identity.Actor, error) {
	v, e := a.ids.CreateInvitation(a.admin.ID, identity.InvitationInput{Username: username, Name: "隔离验收 " + username, Department: "隔离验收部门", Title: "功能验收岗位", Roles: roles})
	if e != nil {
		return nil, e
	}
	password := erpflow.ID() + "Aa7!"
	if _, e = a.ids.AcceptInvitation(v.Token, password); e != nil {
		return nil, e
	}
	return a.ids.Authenticate(username, password)
}
func (a *acceptance) act(actor *identity.Actor, doc M, action string, input M) (M, error) {
	if input == nil {
		input = M{}
	}
	input["expectedVersion"] = doc["version"]
	result, e := a.service.Action(context.Background(), actor, erpflow.S(doc["id"]), action, input, "acceptance-"+erpflow.ID())
	return erpflow.Map(result["document"]), e
}
func (a *acceptance) business(typ string, input M, lines []M, post string) (M, error) {
	emit(M{"phase": "running", "type": typ})
	if lines == nil {
		lines = []M{}
	}
	made, e := a.service.Create(context.Background(), a.requester, M{"type": typ, "title": "隔离验收 " + typ, "projectId": a.project["id"], "input": input, "lines": lines}, "acceptance-create-"+erpflow.ID())
	if e != nil {
		return nil, e
	}
	id := erpflow.S(erpflow.Map(made["document"])["id"])
	ctx, cancel := context.WithTimeout(context.Background(), 12*time.Minute)
	defer cancel()
	run, e := a.service.Wait(ctx, id)
	if e != nil {
		return nil, e
	}
	if e = writePrivate(filepath.Join(a.dir, "last-run.json"), run); e != nil {
		return nil, e
	}
	if run["status"] != "completed" {
		return nil, fmt.Errorf("%s协作未完成：%s", typ, erpflow.S(run["error"]))
	}
	tasks := erpflow.Rows(run["tasks"])
	if len(tasks) != 2 || tasks[0]["agentId"] == tasks[1]["agentId"] {
		return nil, errors.New("缺少两个独立虚拟岗位")
	}
	taskChecks := []M{}
	toolCount := int64(0)
	for _, task := range tasks {
		if task["status"] != "done" || erpflow.N(task["toolCalls"]) < 2 {
			return nil, errors.New("虚拟岗位未完成真实工具调用")
		}
		taskChecks = append(taskChecks, M{"name": task["name"], "agentId": task["agentId"], "toolCalls": task["toolCalls"], "status": task["status"]})
		toolCount += erpflow.N(task["toolCalls"])
	}
	if erpflow.Map(tasks[1]["result"])["passed"] != true {
		return nil, errors.New("独立复核未通过")
	}
	doc, e := a.service.Document(context.Background(), a.requester, id)
	if e != nil {
		return nil, e
	}
	if doc["status"] != "awaiting_approval" || len(erpflow.Rows(doc["approvals"])) != 0 {
		return nil, errors.New("协作未正确进入真人审批")
	}
	for _, actor := range []*identity.Actor{a.first, a.second} {
		current, e := a.service.Document(context.Background(), actor, id)
		if e != nil {
			return nil, e
		}
		doc, e = a.act(actor, current, "approve", M{"note": "隔离功能验收审批，不代表真实公司业务"})
		if e != nil {
			return nil, e
		}
	}
	if doc["status"] != "approved" {
		return nil, errors.New("两级审批未完成")
	}
	if post == "post" {
		doc, e = a.act(a.second, doc, "post", M{"reference": "隔离验收-" + typ})
		if e != nil {
			return nil, e
		}
	}
	report, e := a.service.Report(context.Background(), a.requester, id)
	if e != nil {
		return nil, e
	}
	if !strings.Contains(string(report), "report-header") {
		return nil, errors.New("报告内容不完整")
	}
	actors := []string{}
	for _, row := range erpflow.Rows(doc["approvals"]) {
		actors = append(actors, erpflow.S(row["actorId"]))
	}
	if len(actors) != 2 || actors[0] == actors[1] || actors[0] == a.requester.ID || actors[1] == a.requester.ID {
		return nil, errors.New("审批人员未正确分离")
	}
	quotes := erpflow.Rows(erpflow.Map(run["quoteEvidence"])["quotes"])
	priced := 0
	for _, q := range quotes {
		if q["status"] == "priced" {
			priced++
		}
	}
	a.checks = append(a.checks, M{"type": typ, "documentId": id, "agentRunId": run["id"], "model": run["model"], "tasks": taskChecks, "status": doc["status"], "approvalActors": actors, "reportBytes": len(report), "quoteCandidates": len(quotes), "pricedCandidates": priced})
	emit(M{"phase": "passed", "type": typ, "documentId": id, "status": doc["status"], "toolCalls": toolCount, "quoteCandidates": len(quotes), "pricedCandidates": priced})
	return doc, nil
}
func (a *acceptance) complete() {
	for _, c := range a.checks {
		if doc, e := a.service.Document(context.Background(), a.admin, erpflow.S(c["documentId"])); e == nil {
			c["status"] = doc["status"]
		}
	}
}
func (a *acceptance) execute() error {
	var e error
	if _, e = a.business("project_setup", M{"objective": "仅隔离验收：采购服务器、入库、发货、借还、盘点和任务验收，核对每项真实工具结果。", "expectedDate": "2026-12-01"}, nil, "post"); e != nil {
		return e
	}
	purchase, e := a.business("purchase", M{"partner": "公开供应商 仅查报价不采购"}, []M{{"productId": a.product["id"], "quantity": 8, "unitPriceCents": 1200000}}, "receive")
	if e != nil {
		return e
	}
	for i, n := range []int{3, 5} {
		purchase, e = a.act(a.second, purchase, "receive", M{"lines": []M{{"lineId": erpflow.Rows(purchase["lines"])[0]["id"], "quantity": n}}, "reference": fmt.Sprintf("隔离验收收货-%d", i)})
		if e != nil {
			return e
		}
	}
	if e = check(purchase["status"] == "completed", "分批收货未完成"); e != nil {
		return e
	}
	sale, e := a.business("sales", M{"partner": "虚构客户 仅功能验收"}, []M{{"productId": a.product["id"], "quantity": 3, "unitPriceCents": 1300000}}, "ship")
	if e != nil {
		return e
	}
	for i, n := range []int{1, 2} {
		sale, e = a.act(a.second, sale, "ship", M{"lines": []M{{"lineId": erpflow.Rows(sale["lines"])[0]["id"], "quantity": n}}, "reference": fmt.Sprintf("隔离验收发货-%d", i)})
		if e != nil {
			return e
		}
	}
	if e = check(sale["status"] == "completed", "分批发货未完成"); e != nil {
		return e
	}
	issue, e := a.business("resource", M{"operation": "issue", "employeeId": a.requester.ID, "purpose": "隔离功能验收领用"}, []M{{"productId": a.product["id"], "quantity": 2}}, "post")
	if e != nil {
		return e
	}
	if _, e = a.business("resource", M{"operation": "return", "employeeId": a.requester.ID, "purpose": "隔离功能验收归还", "originalDocumentId": issue["id"]}, []M{{"productId": a.product["id"], "quantity": 1}}, "post"); e != nil {
		return e
	}
	if _, e = a.business("stocktake", M{"note": "隔离验收账实差异调整，实盘样本6台"}, []M{{"productId": a.product["id"], "countedQuantity": 6}}, "post"); e != nil {
		return e
	}
	task, e := a.command(a.first, "task.create", M{"projectId": a.project["id"], "title": "隔离验收设备交付资料", "assigneeId": a.requester.ID})
	if e != nil {
		return e
	}
	if _, e = a.command(a.requester, "task.complete", M{"id": task["id"], "result": "已提交隔离测试交付清单", "evidence": []M{{"name": "隔离验收凭证", "reference": "QA-DELIVERY-001"}}}); e != nil {
		return e
	}
	if _, e = a.command(a.first, "task.accept", M{"id": task["id"], "note": "已核对隔离测试凭证，确认交付"}); e != nil {
		return e
	}
	if _, e = a.business("project_delivery", M{"acceptanceCriteria": "核对8台收货、3台发货、2台领用与1台归还；本案例只验证软件功能。", "deliveryNote": "隔离测试记录已保存并可从单据和库存流水复核，不能用作真实客户交付凭证。"}, nil, "post"); e != nil {
		return e
	}
	today := time.Now().In(time.FixedZone("Asia/Shanghai", 8*3600)).Format("2006-01-02")
	if _, e = a.business("weekly_report", M{"periodStart": today, "periodEnd": today, "summary": "仅汇总本次隔离验收中真实完成并由另一账号验收的1项任务。"}, nil, "post"); e != nil {
		return e
	}
	if _, e = a.business("onboarding", M{"employeeId": a.requester.ID, "position": "功能验收测试岗位", "resourceRequirements": "整理本系统使用方法和已批准物品领用记录，不创建外部账号或权限。"}, nil, "post"); e != nil {
		return e
	}
	snapshot, e := a.store.Snapshot(context.Background(), erpflow.Actor(a.admin))
	if e != nil {
		return e
	}
	inventory, loans, performance := erpflow.Rows(snapshot["inventory"]), erpflow.Rows(snapshot["loans"]), erpflow.Rows(snapshot["performance"])
	if len(inventory) != 1 || erpflow.N(inventory[0]["quantity"]) != 6 {
		return errors.New("最终库存不是6台")
	}
	if len(loans) != 1 || erpflow.N(loans[0]["quantity"])-erpflow.N(loans[0]["returnedQuantity"]) != 1 {
		return errors.New("借用未归还余额不是1台")
	}
	if len(performance) != 1 {
		return errors.New("周报事实记录数量不是1")
	}
	unique := map[string]bool{}
	for _, c := range a.checks {
		unique[erpflow.S(c["type"])] = true
	}
	if len(unique) != 8 || len(a.checks) != 9 {
		return errors.New("未完成8类业务9次协作")
	}
	a.complete()
	documents := []M{}
	for _, d := range erpflow.Rows(snapshot["documents"]) {
		documents = append(documents, M{"id": d["id"], "type": d["type"], "status": d["status"]})
	}
	result := M{"version": "2.0-go", "scope": "全部业务为隔离功能验收，审批与收发凭证均为测试数据", "model": a.model, "createdAt": time.Now().UTC().Format(time.RFC3339Nano), "checks": a.checks, "inventory": inventory, "loans": loans, "performance": performance, "documents": documents, "passed": true, "semanticReview": "pending independent review; technical assertions alone do not certify model content or commercial readiness"}
	if e = writePrivate(filepath.Join(a.dir, "acceptance.json"), result); e != nil {
		return e
	}
	emit(M{"phase": "complete", "passed": true, "workflows": 8, "runs": 9, "report": filepath.Join(a.dir, "acceptance.json"), "semanticReview": "pending"})
	return nil
}
func run() error {
	private := flag.String("private-config", "", "验收专用模型配置路径，只读取百炼配置，不输出内容")
	base := flag.String("data-dir", ".office-data", "隔离验收目录的父目录")
	flag.Parse()
	if os.Getenv("OFFICE_REAL_ERP_ACCEPTANCE") != "1" {
		return errors.New("真实模型验收需要显式设置 OFFICE_REAL_ERP_ACCEPTANCE=1")
	}
	if e := privateConfig(*private); e != nil {
		return e
	}
	if e := os.MkdirAll(*base, 0700); e != nil {
		return e
	}
	dir, e := os.MkdirTemp(*base, "erp-real-acceptance-go-")
	if e != nil {
		return e
	}
	dir, e = filepath.Abs(dir)
	if e != nil {
		return e
	}
	a := &acceptance{dir: dir, checks: []M{}}
	defer func() {
		if a.service != nil {
			ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
			defer cancel()
			_ = a.service.Shutdown(ctx)
		}
		if a.store != nil {
			_ = a.store.Close()
		}
	}()
	perform := func() error {
		a.ids, e = identity.Open(filepath.Join(dir, "erp", "identities.json"), "isolated-admin")
		if e != nil {
			return e
		}
		a.admin = a.ids.ResolveLegacy("isolated-admin")
		if a.requester, e = a.employee("qa-requester", []string{"employee", "warehouse", "hr"}); e != nil {
			return e
		}
		if a.first, e = a.employee("qa-reviewer", []string{"project_manager", "manager", "hr"}); e != nil {
			return e
		}
		if a.second, e = a.employee("qa-controller", []string{"manager", "finance", "warehouse"}); e != nil {
			return e
		}
		if a.store, e = erp.Open(dir); e != nil {
			return e
		}
		provider := model.NewFromEnv()
		status, e := provider.Status(context.Background(), true)
		if e != nil {
			return e
		}
		if !status.Ready {
			return errors.New(status.Message)
		}
		a.model = status.Model
		if a.service, e = erpflow.New(a.store, a.ids, provider, dir); e != nil {
			return e
		}
		if a.project, e = a.command(a.admin, "project.create", M{"name": "隔离验收客户服务器交付", "customer": "虚构客户 仅功能验收", "ownerId": a.first.ID, "members": []string{a.requester.ID, a.first.ID, a.second.ID}}); e != nil {
			return e
		}
		if a.product, e = a.command(a.admin, "product.create", M{"sku": "QA-SERVER-01", "name": "Dell PowerEdge T350 32GB内存 1TB SSD 塔式服务器", "unit": "台", "priceCents": 1200000}); e != nil {
			return e
		}
		emit(M{"phase": "start", "directory": dir, "model": status.Model, "scope": "isolated functional test only"})
		return a.execute()
	}
	if e = perform(); e != nil {
		a.complete()
		_ = writePrivate(filepath.Join(dir, "acceptance.json"), M{"version": "2.0-go", "passed": false, "error": safe(e.Error()), "checks": a.checks, "scope": "隔离功能验收数据，不代表真实业务"})
		emit(M{"phase": "failed", "message": safe(e.Error()), "directory": dir})
		return e
	}
	return nil
}
func main() {
	if e := run(); e != nil {
		fmt.Fprintln(os.Stderr, safe(e.Error()))
		os.Exit(1)
	}
}
