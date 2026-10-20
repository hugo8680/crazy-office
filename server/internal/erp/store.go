// Package erp owns the transactional company ledger. Model output is only a draft;
// business postings and approval transitions are enforced here, under a database transaction.
package erp

import (
	"bytes"
	"context"
	"crypto/rand"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"math"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"sync"
	"time"
	"unicode/utf8"

	_ "modernc.org/sqlite"
)

type Actor struct {
	ID          string   `json:"id"`
	DisplayName string   `json:"displayName"`
	Department  string   `json:"department"`
	Roles       []string `json:"roles"`
}
type Error struct {
	Status  int    `json:"status"`
	Code    string `json:"code"`
	Message string `json:"error"`
	Details any    `json:"details,omitempty"`
}

func (e *Error) Error() string   { return e.Message }
func (e *Error) StatusCode() int { return e.Status }
func fail(message string, detail ...any) {
	e := &Error{Status: 400, Code: "VALIDATION", Message: message}
	if len(detail) > 0 {
		e.Code = detail[0].(string)
	}
	if len(detail) > 1 {
		e.Status = detail[1].(int)
	}
	panic(e)
}
func recoverError(err *error) {
	if p := recover(); p != nil {
		switch x := p.(type) {
		case *Error:
			*err = x
		case error:
			var se interface{ Code() int }
			if errors.As(x, &se) && se.Code()&255 == 19 {
				*err = &Error{Status: 409, Code: "CONSTRAINT", Message: "资料重复或违反业务约束，事务未提交"}
			} else {
				*err = &Error{Status: 503, Code: "UNAVAILABLE", Message: "业务台账暂不可用，事务未提交"}
			}
		default:
			*err = &Error{Status: 503, Code: "UNAVAILABLE", Message: "业务台账暂不可用，事务未提交"}
		}
	}
}
func check(err error) {
	if err != nil {
		panic(err)
	}
}
func text(v any, label string, max int, required bool) string {
	if v == nil && !required {
		return ""
	}
	s, ok := v.(string)
	if !ok {
		fail(label + "须为文本")
	}
	s = strings.TrimSpace(s)
	if required && s == "" || utf8.RuneCountInString(s) > max || regexp.MustCompile(`[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]`).MatchString(s) {
		fail(label + "为空、过长或含无效字符")
	}
	return s
}
func integer(v any, label string, min, max int64) int64 {
	var n int64
	switch x := v.(type) {
	case int:
		n = int64(x)
	case int64:
		n = x
	case int32:
		n = int64(x)
	case float64:
		if math.IsNaN(x) || math.IsInf(x, 0) || math.Trunc(x) != x || x < float64(min) || x > float64(max) {
			fail(label + "须为范围内的整数")
		}
		n = int64(x)
	case json.Number:
		var err error
		n, err = x.Int64()
		if err != nil {
			fail(label + "须为范围内的整数")
		}
	default:
		fail(label + "须为范围内的整数")
	}
	if n < min || n > max {
		fail(label + "须为范围内的整数")
	}
	return n
}
func date(v any, label string, required bool) string {
	s := text(v, label, 10, required)
	if s != "" {
		t, e := time.Parse("2006-01-02", s)
		if e != nil || t.Format("2006-01-02") != s {
			fail(label + "须为有效日期YYYY-MM-DD")
		}
	}
	return s
}
func now() string { return time.Now().UTC().Format("2006-01-02T15:04:05.000Z") }
func uid(prefix string) string {
	b := make([]byte, 16)
	_, e := rand.Read(b)
	check(e)
	b[6] = b[6]&15 | 64
	b[8] = b[8]&63 | 128
	h := hex.EncodeToString(b)
	return prefix + "-" + h[:8] + "-" + h[8:12] + "-" + h[12:16] + "-" + h[16:20] + "-" + h[20:]
}
func dump(v any) string {
	var b bytes.Buffer
	e := json.NewEncoder(&b)
	e.SetEscapeHTML(false)
	check(e.Encode(v))
	return strings.TrimSuffix(strings.ReplaceAll(strings.ReplaceAll(b.String(), `\u2028`, "\u2028"), `\u2029`, "\u2029"), "\n")
}
func parse(s any) any {
	if s == nil {
		return nil
	}
	var v any
	d := json.NewDecoder(strings.NewReader(s.(string)))
	d.UseNumber()
	check(d.Decode(&v))
	return v
}
func obj(v any) map[string]any {
	m, ok := v.(map[string]any)
	if !ok {
		fail("业务资料须为对象")
	}
	return m
}
func list(v any) []any {
	if v == nil {
		return []any{}
	}
	switch x := v.(type) {
	case []any:
		return x
	case []string:
		r := []any{}
		for _, s := range x {
			r = append(r, s)
		}
		return r
	case []map[string]any:
		r := []any{}
		for _, m := range x {
			r = append(r, m)
		}
		return r
	}
	fail("业务资料格式无效")
	return nil
}
func str(v any) string {
	if v == nil {
		return ""
	}
	s, _ := v.(string)
	return s
}
func num(v any) int64 { return integer(v, "内部数值", -9007199254740991, 9007199254740991) }
func def(m map[string]any, k string, d any) any {
	if v, ok := m[k]; ok {
		return v
	}
	return d
}
func stringsOf(v any) []string {
	r := []string{}
	for _, x := range list(v) {
		r = append(r, str(x))
	}
	return r
}
func has(xs []string, s string) bool {
	for _, x := range xs {
		if x == s {
			return true
		}
	}
	return false
}
func role(a Actor, rs ...string) bool {
	if has(a.Roles, "admin") {
		return true
	}
	for _, r := range rs {
		if has(a.Roles, r) {
			return true
		}
	}
	return false
}
func requireRole(a Actor, rs ...string) {
	if !role(a, rs...) {
		fail("当前岗位不能办理此操作", "FORBIDDEN", 403)
	}
}

var allRoles = []string{"admin", "manager", "procurement", "warehouse", "project_manager", "employee", "finance", "hr"}
var Chains = map[string][]string{"project_setup": {"project_manager", "manager"}, "project_delivery": {"project_manager", "manager"}, "purchase": {"manager", "finance"}, "sales": {"manager", "finance"}, "stocktake": {"manager", "finance"}, "resource": {"manager", "warehouse"}, "weekly_report": {"project_manager", "manager"}, "onboarding": {"hr", "manager"}}

func postingRoles(typ string) []string {
	switch typ {
	case "resource", "stocktake":
		return []string{"warehouse"}
	case "onboarding":
		return []string{"hr", "manager"}
	case "project_setup", "project_delivery", "weekly_report":
		return []string{"project_manager", "manager"}
	}
	return nil
}

var Labels = map[string]string{"project_setup": "项目立项", "project_delivery": "任务交付验收", "purchase": "项目采购", "sales": "销售发货", "stocktake": "库存盘点", "resource": "资源借用归还", "weekly_report": "项目周报与贡献核对", "onboarding": "员工岗位资源准备"}

func actorFor(a Actor) Actor {
	if a.ID == "" {
		fail("请先登录员工账号", "UNAUTHORIZED", 401)
	}
	if len(a.Roles) == 0 {
		fail("员工岗位权限无效", "FORBIDDEN", 403)
	}
	for _, r := range a.Roles {
		if !has(allRoles, r) {
			fail("员工岗位权限无效", "FORBIDDEN", 403)
		}
	}
	a.ID = text(a.ID, "员工编号", 100, true)
	if a.DisplayName == "" {
		a.DisplayName = a.ID
	}
	a.DisplayName = text(a.DisplayName, "员工姓名", 100, true)
	a.Department = text(a.Department, "部门", 100, false)
	return a
}

type Store struct {
	db           *sql.DB
	mu           sync.Mutex
	DatabasePath string
	dataDir      string
}
type ledger struct {
	ctx context.Context
	tx  *sql.Tx
}

func (q *ledger) exec(query string, args ...any) {
	_, e := q.tx.ExecContext(q.ctx, query, args...)
	check(e)
}
func (q *ledger) rows(query string, args ...any) []map[string]any {
	rows, e := q.tx.QueryContext(q.ctx, query, args...)
	check(e)
	defer rows.Close()
	cols, e := rows.Columns()
	check(e)
	result := []map[string]any{}
	for rows.Next() {
		values := make([]any, len(cols))
		ptrs := make([]any, len(cols))
		for i := range values {
			ptrs[i] = &values[i]
		}
		check(rows.Scan(ptrs...))
		r := map[string]any{}
		for i, c := range cols {
			if b, ok := values[i].([]byte); ok {
				r[c] = string(b)
			} else {
				r[c] = values[i]
			}
		}
		result = append(result, r)
	}
	check(rows.Err())
	return result
}
func (q *ledger) one(query string, args ...any) map[string]any {
	rows := q.rows(query, args...)
	if len(rows) == 0 {
		return nil
	}
	return rows[0]
}
func (q *ledger) scalar(query string, args ...any) any {
	r := q.one(query, args...)
	for _, v := range r {
		return v
	}
	return nil
}
func Open(dataDir string) (s *Store, err error) {
	defer func() {
		if err != nil && s != nil {
			s.db.Close()
			s = nil
		}
	}()
	defer recoverError(&err)
	if dataDir == "" {
		fail("ERP需要持久化目录")
	}
	base, e := filepath.Abs(dataDir)
	check(e)
	dir := filepath.Join(base, "erp")
	check(os.MkdirAll(dir, 0700))
	path := filepath.Join(dir, "office-erp.sqlite")
	db, e := sql.Open("sqlite", path+"?_pragma=foreign_keys(1)&_pragma=busy_timeout(15000)&_txlock=immediate")
	check(e)
	db.SetMaxOpenConns(1)
	s = &Store{db: db, DatabasePath: path, dataDir: base}
	_, e = db.Exec(schema)
	check(e)
	check(os.Chmod(path, 0600))
	tx, e := db.BeginTx(context.Background(), nil)
	check(e)
	defer tx.Rollback()
	q := &ledger{context.Background(), tx}
	for _, m := range []struct{ table, col, ddl string }{{"document_lines", "system_movement_id", "ALTER TABLE document_lines ADD COLUMN system_movement_id TEXT NOT NULL DEFAULT ''"}, {"documents", "approval_round", "ALTER TABLE documents ADD COLUMN approval_round INTEGER NOT NULL DEFAULT 1"}, {"approvals", "round", "ALTER TABLE approvals ADD COLUMN round INTEGER NOT NULL DEFAULT 1"}, {"tasks", "submitted_at", "ALTER TABLE tasks ADD COLUMN submitted_at TEXT"}, {"tasks", "accepted_by", "ALTER TABLE tasks ADD COLUMN accepted_by TEXT"}} {
		found := false
		for _, r := range q.rows("PRAGMA table_info(" + m.table + ")") {
			if r["name"] == m.col {
				found = true
			}
		}
		if !found {
			q.exec(m.ddl)
		}
	}
	q.exec("UPDATE tasks SET status='submitted',submitted_at=COALESCE(submitted_at,completed_at),completed_at=NULL WHERE status='completed' AND accepted_by IS NULL")
	q.exec("INSERT OR IGNORE INTO agent_results SELECT 'LEGACY-' || id,id,approval_round,agent_run_id,proposal_json,evidence_json,updated_at FROM documents WHERE agent_run_id IS NOT NULL AND proposal_json IS NOT NULL")
	q.exec("PRAGMA user_version=4")
	check(tx.Commit())
	return s, nil
}
func (s *Store) Close() error { s.mu.Lock(); defer s.mu.Unlock(); return s.db.Close() }
func (s *Store) transaction(ctx context.Context, fn func(*ledger) map[string]any) (result map[string]any, err error) {
	defer recoverError(&err)
	s.mu.Lock()
	defer s.mu.Unlock()
	tx, e := s.db.BeginTx(ctx, nil)
	check(e)
	defer tx.Rollback()
	result = fn(&ledger{ctx, tx})
	check(tx.Commit())
	return result, nil
}
func (s *Store) Snapshot(ctx context.Context, actor Actor) (map[string]any, error) {
	return s.transaction(ctx, func(q *ledger) map[string]any { return q.snapshot(actorFor(actor)) })
}
func (s *Store) Command(ctx context.Context, actor Actor, action string, payload map[string]any, key string) (map[string]any, error) {
	return s.transaction(ctx, func(q *ledger) map[string]any {
		a := actorFor(actor)
		action = text(action, "业务操作", 100, true)
		key = text(key, "请求编号", 150, true)
		if payload == nil {
			payload = map[string]any{}
		}
		hash := sha256.Sum256([]byte(dump(map[string]any{"action": action, "payload": payload})))
		requestHash := hex.EncodeToString(hash[:])
		if c := q.one("SELECT * FROM idempotency WHERE actor_id=? AND key=?", a.ID, key); c != nil {
			if c["request_hash"] != requestHash {
				fail("同一请求编号不能提交不同内容", "IDEMPOTENCY_CONFLICT", 409)
			}
			result := obj(parse(c["response_json"]))
			if result["workflowId"] != nil {
				q.rawDocument(str(result["id"]), &a)
			}
			return result
		}
		result := q.command(a, action, payload)
		q.exec("INSERT INTO idempotency VALUES(?,?,?,?)", a.ID, key, requestHash, dump(result))
		return result
	})
}
func (s *Store) RecordAgentResult(ctx context.Context, payload map[string]any) (map[string]any, error) {
	return s.transaction(ctx, func(q *ledger) map[string]any { return q.recordAgent(payload) })
}
func (q *ledger) audit(actor, action, id string, detail any) {
	if detail == nil {
		detail = map[string]any{}
	}
	q.exec("INSERT INTO audit VALUES(?,?,?,?,?,?)", uid("AUD"), actor, action, id, dump(detail), now())
}
func (q *ledger) project(id string) map[string]any {
	r := q.one("SELECT * FROM projects WHERE id=?", id)
	if r == nil {
		fail("项目不存在", "NOT_FOUND", 404)
	}
	r["ownerId"] = r["owner_id"]
	delete(r, "owner_id")
	r["members"] = parse(r["members_json"])
	delete(r, "members_json")
	r["createdAt"] = r["created_at"]
	delete(r, "created_at")
	return r
}
func projectAccess(a Actor, p map[string]any) bool {
	return role(a, "admin") || p["ownerId"] == a.ID || has(stringsOf(p["members"]), a.ID) || has(a.Roles, "manager") && a.Department != "" && p["department"] == a.Department
}
func (q *ledger) checkProject(a Actor, id string) map[string]any {
	p := q.project(id)
	if !projectAccess(a, p) {
		fail("你不是此项目成员或所属部门负责人", "FORBIDDEN", 403)
	}
	return p
}
func (q *ledger) documentAccess(a Actor, d map[string]any) bool {
	if has(a.Roles, "admin") || d["requester_id"] == a.ID {
		return true
	}
	if str(d["project_id"]) != "" {
		return projectAccess(a, q.project(str(d["project_id"])))
	}
	for _, r := range append(append([]string{}, Chains[str(d["type"])]...), "warehouse") {
		if r != "manager" && has(a.Roles, r) {
			return true
		}
	}
	return has(a.Roles, "manager") && a.Department != "" && d["department"] == a.Department
}
func (q *ledger) rawDocument(id string, a *Actor) map[string]any {
	r := q.one("SELECT * FROM documents WHERE id=?", id)
	if r == nil {
		fail("业务单据不存在", "NOT_FOUND", 404)
	}
	if a != nil && !q.documentAccess(*a, r) {
		fail("没有此单据的访问权限", "FORBIDDEN", 403)
	}
	return r
}
func (q *ledger) approvals(d map[string]any, historical bool) []map[string]any {
	sql := "SELECT stage,role,actor_id AS actorId,actor_name AS actorName,decision,note,created_at AS createdAt,round FROM approvals WHERE document_id=?"
	args := []any{d["id"]}
	if !historical {
		sql += " AND round=?"
		args = append(args, d["approval_round"])
	}
	return q.rows(sql+" ORDER BY created_at,id", args...)
}
func (q *ledger) actions(a *Actor, d map[string]any) []string {
	r := []string{}
	if a == nil {
		return r
	}
	status, typ := str(d["status"]), str(d["type"])
	owns := d["requester_id"] == a.ID || has(a.Roles, "admin")
	if (status == "draft" || status == "rejected") && owns {
		r = append(r, "revise")
	}
	if status == "draft" && owns {
		r = append(r, "run_agents")
		if str(d["agent_run_id"]) != "" {
			r = append(r, "submit")
		}
	}
	if status == "awaiting_approval" {
		chain := Chains[typ]
		index := int(num(d["approval_index"]))
		prior := false
		for _, ap := range q.approvals(d, false) {
			if ap["actorId"] == a.ID && ap["decision"] == "approved" {
				prior = true
			}
		}
		if index < len(chain) && d["requester_id"] != a.ID && !prior && role(*a, chain[index]) {
			r = append(r, "approve", "reject")
		}
	}
	if has([]string{"approved", "partially_received", "partially_shipped"}, status) {
		if typ == "purchase" && role(*a, "warehouse") {
			r = append(r, "receive")
		} else if typ == "sales" && role(*a, "warehouse") {
			r = append(r, "ship")
		} else if typ != "purchase" && typ != "sales" {
			if role(*a, postingRoles(typ)...) {
				r = append(r, "post")
			}
		}
	}
	return r
}
func (q *ledger) document(id string, a *Actor) map[string]any {
	d := q.rawDocument(id, a)
	r := map[string]any{"id": d["id"], "type": d["type"], "workflowId": d["type"], "title": d["title"], "projectId": d["project_id"], "requesterId": d["requester_id"], "department": d["department"], "status": d["status"], "version": d["version"], "input": parse(d["input_json"]), "proposal": parse(d["proposal_json"]), "evidence": parse(d["evidence_json"]), "agentRunId": d["agent_run_id"], "approvalIndex": d["approval_index"], "approvalChain": Chains[str(d["type"])], "approvals": q.approvals(d, false), "approvalRound": d["approval_round"], "approvalHistory": q.approvals(d, true), "createdAt": d["created_at"], "updatedAt": d["updated_at"]}
	r["lines"] = q.rows("SELECT l.id,l.product_id AS productId,p.sku,p.name,p.unit,l.quantity,l.unit_price_cents AS unitPriceCents,l.completed_quantity AS completedQuantity,l.system_quantity AS systemQuantity FROM document_lines l JOIN products p ON p.id=l.product_id WHERE l.document_id=? ORDER BY l.rowid", id)
	r["allowedActions"] = q.actions(a, d)
	if !has([]string{"purchase", "sales", "resource", "stocktake"}, str(d["type"])) {
		if event := q.one("SELECT actor_id,detail_json,created_at FROM audit WHERE entity_id=? AND action='document.post' ORDER BY rowid DESC LIMIT 1", id); event != nil {
			detail := obj(parse(event["detail_json"]))
			if reference := str(detail["reference"]); reference != "" {
				r["confirmation"] = map[string]any{"reference": reference, "note": detail["note"], "actorId": event["actor_id"], "actorName": detail["actorName"], "createdAt": event["created_at"]}
			}
		}
	}
	r["revisions"] = q.rows("SELECT id,version,round,revised_by AS revisedBy,created_at AS createdAt FROM document_history WHERE document_id=? ORDER BY rowid", id)
	r["agentHistory"] = q.rows("SELECT round,run_id AS runId,created_at AS createdAt FROM agent_results WHERE document_id=? ORDER BY rowid", id)
	return r
}
func (q *ledger) balance(pid string) int64 {
	v := q.scalar("SELECT quantity FROM inventory WHERE product_id=?", pid)
	if v == nil {
		return 0
	}
	return num(v)
}
func (q *ledger) stockRevision(pid string) string {
	return str(q.scalar("SELECT id FROM movements WHERE product_id=? ORDER BY rowid DESC LIMIT 1", pid))
}
func (q *ledger) requireActive(pid string) {
	if pid != "" && q.project(pid)["status"] != "active" {
		fail("请先完成项目立项审批并确认启用，再办理实际交付或库存流转", "PROJECT_NOT_ACTIVE", 409)
	}
}
func (q *ledger) move(a Actor, d, l map[string]any, delta int64, kind, reference string) {
	q.requireActive(str(d["project_id"]))
	updated := q.balance(str(l["product_id"])) + delta
	if updated < 0 {
		fail("库存不足，未产生任何出库流水", "STOCK_SHORTAGE", 409)
	}
	integer(updated, "库存余额", 0, 1000000000)
	q.exec("INSERT INTO inventory(product_id,quantity) VALUES(?,?) ON CONFLICT(product_id) DO UPDATE SET quantity=excluded.quantity", l["product_id"], updated)
	q.exec("INSERT INTO movements VALUES(?,?,?,?,?,?,?,?,?,?)", uid("MOV"), d["id"], l["id"], l["product_id"], delta, updated, kind, reference, a.ID, now())
}
func (q *ledger) updateDocument(d map[string]any, status string, values map[string]any) {
	assign := []string{"status=?", "version=version+1", "updated_at=?"}
	args := []any{status, now()}
	keys := []string{}
	for k := range values {
		if !has([]string{"approval_index", "proposal_json", "evidence_json", "agent_run_id"}, k) {
			fail("无效的内部字段")
		}
		keys = append(keys, k)
	}
	sort.Strings(keys)
	for _, k := range keys {
		assign = append(assign, k+"=?")
		args = append(args, values[k])
	}
	args = append(args, d["id"])
	q.exec("UPDATE documents SET "+strings.Join(assign, ",")+" WHERE id=?", args...)
}
