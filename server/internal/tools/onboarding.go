package tools

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"github.com/google/uuid"
	"net/mail"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"time"
)

var hrKeys = []string{"employeeNumber", "employeeName", "department", "position", "startDate", "workEmail", "manager", "resourceRequirements"}

func ValidateOnboardingInput(input map[string]any) error { _, _, err := validateHR(input); return err }

func validateHR(input map[string]any) (map[string]any, string, error) {
	allowed := map[string]bool{"employmentConfirmed": true, "example": true, "isExample": true}
	for _, k := range hrKeys {
		allowed[k] = true
	}
	for k := range input {
		if !allowed[k] {
			return nil, "", errors.New("入职登记只接受列明行政字段")
		}
	}
	r := map[string]any{}
	var b strings.Builder
	b.WriteByte('{')
	for i, k := range hrKeys {
		v := input[k]
		if v != nil {
			if _, ok := v.(string); !ok {
				return nil, "", errors.New("行政字段必须是文本")
			}
		}
		s := strings.TrimSpace(str(v))
		limit := 80
		switch k {
		case "employeeNumber":
			limit = 40
		case "startDate":
			limit = 10
		case "workEmail":
			limit = 254
		case "resourceRequirements":
			limit = 3000
		}
		if len([]rune(s)) > limit || regexp.MustCompile(`[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]`).MatchString(s) {
			return nil, "", errors.New("行政字段过长或包含控制字符")
		}
		if k != "resourceRequirements" && strings.ContainsAny(s, "\r\n\t") {
			return nil, "", errors.New("行政字段不能换行")
		}
		if k == "workEmail" {
			s = strings.ToLower(s)
		}
		r[k] = s
		if i > 0 {
			b.WriteByte(',')
		}
		key, _ := json.Marshal(k)
		val, _ := json.Marshal(s)
		b.Write(key)
		b.WriteByte(':')
		b.Write(val)
	}
	b.WriteString(`,"employmentConfirmed":true}`)
	r["employmentConfirmed"] = true
	for _, k := range hrKeys[:5] {
		if r[k] == "" {
			return nil, "", errors.New("员工原始行政资料缺少必填项")
		}
	}
	if !regexp.MustCompile(`^[A-Za-z0-9_-]{1,40}$`).MatchString(str(r["employeeNumber"])) {
		return nil, "", errors.New("工号仅支持英文字母、数字、下划线或短横线")
	}
	if _, e := time.Parse("2006-01-02", str(r["startDate"])); e != nil {
		return nil, "", errors.New("入职日期无效")
	}
	if r["workEmail"] != "" {
		m, e := mail.ParseAddress(str(r["workEmail"]))
		if e != nil || m.Address != r["workEmail"] {
			return nil, "", errors.New("工作邮箱格式无效")
		}
	}
	if input["employmentConfirmed"] != true {
		return nil, "", errors.New("真实员工须确认公司已完成录用决定")
	}
	canonical := strings.NewReplacer(`\u003c`, "<", `\u003e`, ">", `\u0026`, "&").Replace(b.String())
	sum := sha256.Sum256([]byte(canonical))
	return r, hex.EncodeToString(sum[:]), nil
}
func (t *Toolbox) hrRegistry(ctx context.Context, write bool, r map[string]any, hash, ref string) (map[string]any, error) {
	example := t.config.Input["example"] == true || t.config.Input["isExample"] == true
	name := "employee-registry.sqlite"
	if example {
		name = "example-registry.sqlite"
	}
	dir := filepath.Join(filepath.Dir(t.config.RunDir), "hr")
	p := filepath.Join(dir, name)
	if !write {
		if _, e := os.Stat(p); os.IsNotExist(e) {
			return map[string]any{"status": "new"}, nil
		}
	}
	if e := os.MkdirAll(dir, 0700); e != nil {
		return nil, e
	}
	db, e := openDB(p)
	if e != nil {
		return nil, e
	}
	defer db.Close()
	_, e = db.ExecContext(ctx, `CREATE TABLE IF NOT EXISTS employees(employee_number TEXT PRIMARY KEY, work_email_normalized TEXT NOT NULL,payload_hash TEXT NOT NULL,employee_ref TEXT UNIQUE NOT NULL,receipt_id TEXT UNIQUE NOT NULL,record_json TEXT NOT NULL,created_at TEXT NOT NULL);CREATE UNIQUE INDEX IF NOT EXISTS unique_nonempty_work_email ON employees(work_email_normalized) WHERE work_email_normalized<>''`)
	if e != nil {
		return nil, e
	}
	_ = os.Chmod(p, 0600)
	tx, e := db.BeginTx(ctx, &sql.TxOptions{})
	if e != nil {
		return nil, e
	}
	defer tx.Rollback()
	rows, e := tx.QueryContext(ctx, `SELECT employee_number,payload_hash,employee_ref,receipt_id,created_at FROM employees WHERE employee_number=? OR (work_email_normalized<>'' AND work_email_normalized=?)`, r["employeeNumber"], r["workEmail"])
	if e != nil {
		return nil, e
	}
	out := []map[string]any{}
	for rows.Next() {
		var n, h, er, receipt, created string
		if e = rows.Scan(&n, &h, &er, &receipt, &created); e != nil {
			rows.Close()
			return nil, e
		}
		out = append(out, map[string]any{"employeeNumber": n, "hash": h, "employeeRef": er, "receiptId": receipt, "createdAt": created})
	}
	rows.Close()
	if len(out) > 0 {
		if len(out) == 1 && out[0]["employeeNumber"] == r["employeeNumber"] && out[0]["hash"] == hash {
			result := out[0]
			delete(result, "employeeNumber")
			delete(result, "hash")
			result["status"] = "existing_identical"
			return result, nil
		}
		if write {
			return nil, errors.New("工号或工作邮箱与已有登记冲突，未覆盖原记录")
		}
		return map[string]any{"status": "conflict"}, nil
	}
	if !write {
		return map[string]any{"status": "new"}, nil
	}
	raw, _ := json.Marshal(r)
	receiptID, created := uuid.NewString(), now()
	_, e = tx.ExecContext(ctx, `INSERT INTO employees(employee_number,work_email_normalized,payload_hash,employee_ref,receipt_id,record_json,created_at) VALUES(?,?,?,?,?,?,?)`, r["employeeNumber"], r["workEmail"], hash, ref, receiptID, string(raw), created)
	if e != nil {
		return nil, errors.New("员工册写入失败，未确认登记结果")
	}
	if e = ctx.Err(); e != nil {
		return nil, e
	}
	if e = tx.Commit(); e != nil {
		return nil, e
	}
	return map[string]any{"status": "inserted", "employeeRef": ref, "receiptId": receiptID, "createdAt": created}, nil
}
func (t *Toolbox) hr(ctx context.Context, name string, a map[string]any) (map[string]any, []string, error) {
	r, hash, e := validateHR(t.config.Input)
	if e != nil {
		return nil, nil, e
	}
	if t.onboarding["hash"] != nil && t.onboarding["hash"] != hash {
		return nil, nil, errors.New("原始资料已变化，审批作废，请重新发起")
	}
	ref := str(t.onboarding["employeeRef"])
	if ref == "" {
		ref = "EMP-" + uuid.NewString()
		t.onboarding["employeeRef"] = ref
	}
	example := t.config.Input["example"] == true || t.config.Input["isExample"] == true
	ev := func(extra map[string]any) map[string]any {
		extra["employeeRef"] = ref
		extra["isExample"] = example
		extra["personalDataSharedWithModel"] = false
		return extra
	}
	if name != "prepare_onboarding" && t.onboarding["hash"] == nil {
		return nil, nil, errors.New("请先冻结原始登记资料")
	}
	switch name {
	case "prepare_onboarding":
		t.onboarding["hash"] = hash
		t.onboarding["record"] = r
		_ = t.put("onboarding/employee-material.json", map[string]any{"employeeRef": ref, "isExample": example, "record": r, "payloadHash": hash, "frozenAt": now()})
		return receipt("已在本地冻结员工行政资料，个人字段未提供给模型", ev(map[string]any{"prepared": true, "employmentConfirmed": true, "requiredFieldsComplete": true})), []string{"onboarding/employee-material.json"}, nil
	case "review_onboarding":
		dup, e := t.hrRegistry(ctx, false, r, hash, ref)
		if e != nil {
			return nil, nil, e
		}
		checks := []map[string]any{{"name": "行政资料格式与必填项", "passed": true}, {"name": "已确认录用决定完成", "passed": true}, {"name": "本地工号邮箱唯一性预检", "passed": dup["status"] != "conflict", "status": dup["status"]}}
		review := ev(map[string]any{"passed": dup["status"] != "conflict", "checks": checks, "duplicateStatus": dup["status"], "identityVerified": false, "registryWritten": false})
		t.onboarding["review"] = review
		_ = t.put("onboarding/registration-review.json", review)
		return receipt("完成行政字段与本地重复预检，仍需真人审批", review), []string{"onboarding/registration-review.json"}, nil
	case "plan_onboarding_resources":
		requests := stringsOf(r["resourceRequirements"])
		if len(requests) > 60 {
			return nil, nil, errors.New("资源申请最多60行")
		}
		items := []map[string]any{}
		csv := [][]any{{"编号", "原始申请", "状态", "负责人", "验收"}}
		for i, s := range requests {
			category, owner, verification := "other", "人事负责人（建议，待公司确认）", "按原始申请确认交付"
			switch {
			case regexp.MustCompile(`权限|授权|门禁|(?i)access`).MatchString(s):
				category = "access"
				owner = "IT负责人（建议，待公司确认）"
				verification = "核对最小权限并由负责人确认"
			case regexp.MustCompile(`账号|帐号|邮箱|账户|(?i)account|email`).MatchString(s):
				category = "account"
				owner = "IT负责人（建议，待公司确认）"
				verification = "依公司流程开通后由本人确认可登录"
			case regexp.MustCompile(`电脑|笔记本|设备|键盘|鼠标|工位|显示器`).MatchString(s):
				category = "equipment"
				owner = "IT负责人（建议，待公司确认）"
				verification = "设备序列号和领用交付确认"
			}
			id := fmt.Sprintf("R%d", i+1)
			items = append(items, map[string]any{"id": id, "request": s, "category": category, "status": "pending_manual", "suggestedOwner": owner, "verification": verification, "externalActionExecuted": false})
			csv = append(csv, []any{id, s, "待人工处理", owner, verification})
		}
		t.onboarding["plan"] = items
		_ = t.put("onboarding/resource-requests.json", map[string]any{"employeeRef": ref, "isExample": example, "items": items, "requestCount": len(items), "unprovidedRequirements": len(items) == 0, "status": "pending_manual", "externalActionExecuted": false})
		_ = t.put("onboarding/resource-requests.csv", writeCSV(csv))
		return receipt(fmt.Sprintf("整理%d项资源申请，全部待人工处理，没有开通或分配", len(items)), ev(map[string]any{"requestCount": len(items), "status": "pending_manual", "externalActionExecuted": false})), []string{"onboarding/resource-requests.json", "onboarding/resource-requests.csv"}, nil
	case "request_onboarding_approval":
		review, _ := t.onboarding["review"].(map[string]any)
		if review["passed"] != true || t.onboarding["plan"] == nil {
			return nil, nil, errors.New("登记校验与资源待办须先完成")
		}
		if t.config.Approval == nil {
			return nil, nil, errors.New("没有真实审批入口")
		}
		if existing, ok := t.onboarding["decision"].(map[string]any); ok {
			return receipt("本次登记已有真实审批回执", ev(map[string]any{"approved": existing["approved"] == true, "registryWritten": false})), []string{"onboarding/human-decision.json"}, nil
		}
		decision, e := t.config.Approval(ctx, map[string]any{"kind": "onboarding", "agentId": "hr", "targetHumanId": "hr_owner", "title": "请人事负责人确认入职行政登记", "description": "仅写入本地员工册，设备账号仍待处理。", "details": map[string]any{"employeeRecord": r, "checks": review["checks"], "resourcePlan": t.onboarding["plan"], "environment": "不作录用决定、不签约、不发薪、不创建外部账号", "isExample": example}})
		if e != nil {
			return nil, nil, e
		}
		if decision["targetHumanId"] != nil && decision["targetHumanId"] != "hr_owner" {
			return nil, nil, errors.New("审批处理人与人事负责人不符")
		}
		t.onboarding["decision"] = decision
		_ = t.put("onboarding/human-decision.json", decision)
		label := "真实人事负责人已作出登记审批选择"
		if approvalActorKind(decision) == "isolated_test_operator" {
			label = "隔离测试账号脚本提交样例登记回执，不代表真人业务审批"
		}
		return receipt(label, ev(map[string]any{"approved": decision["approved"] == true, "approvalActorKind": approvalActorKind(decision), "registryWritten": false})), []string{"onboarding/human-decision.json"}, nil
	case "register_onboarding":
		decision, _ := t.onboarding["decision"].(map[string]any)
		if decision == nil {
			return nil, nil, errors.New("须先取得真实人事负责人审批")
		}
		registered := false
		stored := map[string]any{}
		if decision["approved"] == true {
			stored, e = t.hrRegistry(ctx, true, r, hash, ref)
			if e != nil {
				return nil, nil, e
			}
			registered = true
			ref = str(stored["employeeRef"])
		}
		status := "not_registered"
		if registered {
			status = "registered"
		}
		result := ev(map[string]any{"registered": registered, "status": status, "registryWritten": registered, "idempotent": stored["status"] == "existing_identical", "resourceRequestCount": len(maps(t.onboarding["plan"])), "resourceStatus": "pending_manual", "externalAccountsCreated": false, "equipmentAssigned": false, "employmentDecisionMade": false, "receiptId": stored["receiptId"], "createdAt": stored["createdAt"], "recordedAt": now()})
		result["approvalActorKind"] = approvalActorKind(decision)
		result["employmentConfirmedBySubmitter"] = true
		result["stageMeaning"] = "此为最终登记回执；早期review.registryWritten=false仅表示预检阶段未写入，不能覆盖本回执。employmentDecisionMade=false表示工具未作录用决定，不表示原始录用确认未知。"
		_ = t.put("onboarding/registration-receipt.json", result)
		_ = t.put("onboarding/employee-registration.json", map[string]any{"receipt": result, "record": r})
		csv := [][]any{{"登记状态", "工号", "员工姓名", "部门", "岗位", "入职日期", "工作邮箱"}, {registered, r["employeeNumber"], r["employeeName"], r["department"], r["position"], r["startDate"], r["workEmail"]}}
		_ = t.put("onboarding/employee-registration.csv", writeCSV(csv))
		checklist := [][]any{{"项目", "状态", "说明"}, {"录用确认", "已由提交者确认", "本流程不决定是否录用"}, {"行政资料校验", "已完成", "未核验身份或外部证明"}, {"真实人事负责人审批", decision["approved"], "仅授权本地登记"}, {"本地员工册", status, "设备账号权限仍待办理"}}
		for _, item := range maps(t.onboarding["plan"]) {
			checklist = append(checklist, []any{item["request"], "待人工处理", str(item["suggestedOwner"]) + "；" + str(item["verification"])})
		}
		_ = t.put("onboarding/onboarding-checklist.csv", writeCSV(checklist))
		md := "本地登记状态：" + status + "。\n\n|字段|原始资料|\n|---|---|\n"
		for _, k := range hrKeys {
			md += "|" + k + "|" + strings.ReplaceAll(strings.ReplaceAll(str(r[k]), "|", "\\|"), "\n", "；") + "|\n"
		}
		md += "\n设备、账号和权限仍待真实负责人办理。本流程未作录用决定、签合同或发薪。"
		_ = t.put("onboarding/employee-registration.html", ReportDocument("员工入职行政登记回执", ReportHTML(md)))
		return receipt(fmt.Sprintf("本地登记状态：%t；资源待办仍需真实负责人办理", registered), result), []string{"onboarding/registration-receipt.json", "onboarding/employee-registration.json", "onboarding/employee-registration.csv", "onboarding/employee-registration.html", "onboarding/onboarding-checklist.csv"}, nil
	}
	return nil, nil, errors.New("入职工具无效")
}
