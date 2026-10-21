package erp

import (
	"encoding/json"
	"math"
	"reflect"
	"strings"
	"sync"
	"testing"
	"time"
)

func bulletinDirectory() map[string]BulletinEmployee {
	result := map[string]BulletinEmployee{}
	for _, a := range []Actor{admin, employee, manager, finance, hr, outsider} {
		result[a.ID] = BulletinEmployee{ID: a.ID, Name: "实际员工-" + a.ID, Department: a.Department}
	}
	return result
}
func bulletinBoard(t *testing.T, f *fixture, a Actor, options ...BulletinOptions) map[string]any {
	t.Helper()
	o := BulletinOptions{Directory: bulletinDirectory()}
	if len(options) > 0 {
		o = options[0]
	}
	board, err := f.s.Bulletin(ctx, a, o)
	if err != nil {
		t.Fatal(err)
	}
	return board
}
func score(employeeID string, count int64, accuracy float64, version int64) map[string]any {
	return map[string]any{"employeeId": employeeID, "completedCount": count, "accuracy": accuracy, "periodStart": "2026-10-01", "periodEnd": "2026-10-31", "expectedVersion": version}
}
func TestBulletinEmptyDefaultsAndPermissionScopedNonFinancialDashboard(t *testing.T) {
	f := newFixture(t, false)
	board := bulletinBoard(t, f, employee)
	if len(obj(board["training"])["entries"].([]map[string]any)) != 0 || obj(board["training"])["periodStart"] != "" || obj(board["video"])["src"] != "" || obj(board["video"])["configured"] != false || len(obj(board["messages"])["items"].([]map[string]any)) != 0 {
		t.Fatal("empty board invented scores, video or messages")
	}
	_, err := f.s.Bulletin(ctx, Actor{}, BulletinOptions{})
	noticeStatus(t, err, 401)
	privateAdmin := admin
	privateAdmin.Department = "保密部门"
	private := f.cmd(privateAdmin, "project.create", map[string]any{"name": "不可泄露的秘密项目", "customer": "秘密客户", "ownerId": outsider.ID, "members": []string{outsider.ID}})
	f.cmd(employee, "document.create", map[string]any{"type": "project_setup", "projectId": f.project["id"], "input": map[string]any{"objective": "成员可见立项"}, "lines": []any{}})
	f.cmd(outsider, "document.create", map[string]any{"type": "project_setup", "projectId": private["id"], "input": map[string]any{"objective": "不可公开的目标"}, "lines": []any{}})
	for _, projectID := range []any{f.project["id"], private["id"]} {
		_, err = f.s.db.Exec("INSERT INTO tasks(id,project_id,title,assignee_id,created_by,due_date,status,result,evidence_json,created_at) VALUES(?,?,?,?,?,?,'pending','','[]',?)", uid("TASK"), projectID, "不得公开的任务标题", employee.ID, admin.ID, "2026-12-01", now())
		if err != nil {
			t.Fatal(err)
		}
	}
	member := bulletinBoard(t, f, employee)
	administrator := bulletinBoard(t, f, admin)
	metrics := obj(member["dashboard"])["metrics"].([]map[string]any)
	all := obj(administrator["dashboard"])["metrics"].([]map[string]any)
	if len(metrics) != 4 || num(metrics[0]["value"]) != 1 || num(metrics[1]["value"]) != 1 || num(metrics[2]["value"]) != 1 || num(metrics[3]["value"]) != 1 || num(all[0]["value"]) != 2 || num(all[1]["value"]) != 2 || num(all[3]["value"]) != 2 {
		t.Fatalf("dashboard bypassed or lost access scope: %#v / %#v", metrics, all)
	}
	for _, metric := range metrics {
		if len(metric) != 4 || metric["id"] == nil || metric["label"] == nil || metric["value"] == nil || metric["unit"] == nil {
			t.Fatal("dashboard returned non-whitelisted details")
		}
	}
	raw := dump(member)
	for _, secret := range []string{"不可泄露", "秘密客户", "不可公开的目标", "不得公开的任务标题", "priceCents", "amount", "performance", "assigneeId", "passwordHash", str(private["id"])} {
		if strings.Contains(raw, secret) {
			t.Fatal("bulletin leaked " + secret)
		}
	}
}
func TestMessagesUseServerAuthorshipPlainTextDeleteOwnershipAndAudit(t *testing.T) {
	f := newFixture(t, false)
	creator := employee
	creator.DisplayName = "实际留言人"
	body := "<img src=x onerror=alert(1)>\n原文不是HTML"
	message, err := f.s.PostBulletinMessage(ctx, creator, map[string]any{"body": body, "authorId": "forged", "authorName": "伪造", "createdAt": "1900-01-01"}, "message-authorship-test")
	if err != nil || message["authorId"] != creator.ID || message["authorName"] != creator.DisplayName || message["body"] != body || message["deleted"] != false || message["canDelete"] != true {
		t.Fatalf("authorship/plain text mismatch %#v %v", message, err)
	}
	if _, err = time.Parse(time.RFC3339Nano, str(message["createdAt"])); err != nil || message["createdAt"] == "1900-01-01" {
		t.Fatal("timestamp did not come from server")
	}
	id := str(message["id"])
	for _, other := range []Actor{outsider, manager, hr} {
		_, err = f.s.DeleteBulletinMessage(ctx, other, id, map[string]any{"expectedVersion": 1}, uid("KEY"))
		noticeStatus(t, err, 403)
	}
	read, err := f.s.BulletinMessages(ctx, outsider, "")
	if err != nil || read["bodyFormat"] != "plain" || read["items"].([]map[string]any)[0]["canDelete"] != false {
		t.Fatal("another employee may edit the message")
	}
	own, err := f.s.DeleteBulletinMessage(ctx, creator, id, map[string]any{"expectedVersion": 1}, "message-self-delete-0001")
	if err != nil || own["deleted"] != true || num(own["version"]) != 2 {
		t.Fatalf("self delete %#v %v", own, err)
	}
	repeat, err := f.s.DeleteBulletinMessage(ctx, creator, id, map[string]any{"expectedVersion": 1}, "message-self-delete-0001")
	if err != nil || !reflect.DeepEqual(obj(parse(dump(repeat))), obj(parse(dump(own)))) {
		t.Fatal("delete retry is not idempotent")
	}
	listed, _ := f.s.BulletinMessages(ctx, employee, "")
	if len(listed["items"].([]map[string]any)) != 0 {
		t.Fatal("deleted body still published")
	}
	var deleted, audits int
	if err = f.s.db.QueryRow("SELECT COUNT(*) FROM office_messages WHERE deleted=1 AND deleted_by=?", creator.ID).Scan(&deleted); err != nil || deleted != 1 {
		t.Fatal("message was not retained as a soft deletion")
	}
	if err = f.s.db.QueryRow("SELECT COUNT(*) FROM audit WHERE entity_id=?", id).Scan(&audits); err != nil || audits != 2 {
		t.Fatal("create/delete audit missing")
	}
	second, err := f.s.PostBulletinMessage(ctx, outsider, map[string]any{"body": "另一位员工的留言"}, uid("KEY"))
	if err != nil {
		t.Fatal(err)
	}
	if _, err = f.s.DeleteBulletinMessage(ctx, admin, str(second["id"]), map[string]any{"expectedVersion": 1}, uid("KEY")); err != nil {
		t.Fatal("administrator cannot moderate others' messages")
	}
}
func TestMessageIdempotencyValidationRateLimitPersistenceAndPagination(t *testing.T) {
	f := newFixture(t, false)
	body := strings.Repeat("文", 600)
	first, err := f.s.PostBulletinMessage(ctx, employee, map[string]any{"body": body}, "message-idempotent-0001")
	if err != nil {
		t.Fatal(err)
	}
	again, err := f.s.PostBulletinMessage(ctx, employee, map[string]any{"body": body}, "message-idempotent-0001")
	if err != nil || again["id"] != first["id"] {
		t.Fatal("immediate retry hit rate limit or duplicated post")
	}
	_, err = f.s.PostBulletinMessage(ctx, employee, map[string]any{"body": "different"}, "message-idempotent-0001")
	noticeStatus(t, err, 409)
	for _, invalid := range []any{"", strings.Repeat("文", 601), "bad\x00text", 123} {
		_, err = f.s.PostBulletinMessage(ctx, employee, map[string]any{"body": invalid}, uid("KEY"))
		noticeStatus(t, err, 400)
	}
	if err = f.s.Close(); err != nil {
		t.Fatal(err)
	}
	f.s, err = Open(f.dir)
	if err != nil {
		t.Fatal(err)
	}
	_, err = f.s.PostBulletinMessage(ctx, employee, map[string]any{"body": "rate limited after restart"}, uid("KEY"))
	noticeStatus(t, err, 429)
	if _, err = f.s.DeleteBulletinMessage(ctx, employee, str(first["id"]), map[string]any{"expectedVersion": 1}, uid("KEY")); err != nil {
		t.Fatal(err)
	}
	_, err = f.s.PostBulletinMessage(ctx, employee, map[string]any{"body": "delete cannot bypass rate"}, uid("KEY"))
	noticeStatus(t, err, 429)
	for i := 0; i < 105; i++ {
		stamp := time.Now().Add(-time.Duration(i+2) * time.Minute).UTC().Format(time.RFC3339Nano)
		_, err = f.s.db.Exec("INSERT INTO office_messages(id,body,author_id,author_name,created_at,updated_at,version,deleted) VALUES(?,?,?,?,?,?,1,0)", uid("MSG"), "历史留言", outsider.ID, "实际姓名", stamp, stamp)
		if err != nil {
			t.Fatal(err)
		}
	}
	page, err := f.s.BulletinMessages(ctx, employee, "")
	if err != nil || len(page["items"].([]map[string]any)) != 100 || page["hasMore"] != true {
		t.Fatal("message list is not bounded")
	}
	cursor := str(page["nextCursor"])
	last := page["items"].([]map[string]any)[99]
	if _, err = f.s.DeleteBulletinMessage(ctx, admin, str(last["id"]), map[string]any{"expectedVersion": last["version"]}, uid("KEY")); err != nil {
		t.Fatal(err)
	}
	next, err := f.s.BulletinMessages(ctx, employee, cursor)
	if err != nil || len(next["items"].([]map[string]any)) != 5 || next["hasMore"] != false {
		t.Fatalf("soft deletion invalidated pagination %#v %v", next, err)
	}
	_, err = f.s.BulletinMessages(ctx, employee, "missing-cursor")
	noticeStatus(t, err, 400)
	// Ten persisted posts in the last hour block another even after the 15s gap.
	if _, err = f.s.db.Exec("DELETE FROM office_messages WHERE author_id=?", outsider.ID); err != nil {
		t.Fatal(err)
	}
	for i := 0; i < 10; i++ {
		stamp := time.Now().Add(-time.Duration(5+i) * time.Minute).UTC().Format("2006-01-02T15:04:05.000Z")
		_, err = f.s.db.Exec("INSERT INTO office_messages(id,body,author_id,author_name,created_at,updated_at,version,deleted) VALUES(?,?,?,?,?,?,1,?)", uid("MSG"), "历史", outsider.ID, "实际姓名", stamp, stamp, i%2)
		if err != nil {
			t.Fatal(err)
		}
	}
	_, err = f.s.PostBulletinMessage(ctx, outsider, map[string]any{"body": "hourly bound"}, uid("KEY"))
	noticeStatus(t, err, 429)
}
func TestMessageTransactionRollbackAndConcurrentRetries(t *testing.T) {
	f := newFixture(t, false)
	if _, err := f.s.db.Exec("CREATE TRIGGER reject_message_audit BEFORE INSERT ON audit WHEN NEW.action='bulletin.message.create' BEGIN SELECT RAISE(ABORT,'reject isolated audit'); END"); err != nil {
		t.Fatal(err)
	}
	_, err := f.s.PostBulletinMessage(ctx, employee, map[string]any{"body": "必须回滚"}, "message-rollback-0001")
	if err == nil {
		t.Fatal("audit failure committed post")
	}
	var count int
	f.s.db.QueryRow("SELECT COUNT(*) FROM office_messages").Scan(&count)
	if count != 0 {
		t.Fatal("partial message write")
	}
	f.s.db.QueryRow("SELECT COUNT(*) FROM idempotency WHERE key='message-rollback-0001'").Scan(&count)
	if count != 0 {
		t.Fatal("failed request consumed idempotency key")
	}
	f.s.db.Exec("DROP TRIGGER reject_message_audit")
	var wg sync.WaitGroup
	results := make(chan map[string]any, 2)
	errs := make(chan error, 2)
	for i := 0; i < 2; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			r, e := f.s.PostBulletinMessage(ctx, employee, map[string]any{"body": "并发重试"}, "message-concurrent-0001")
			results <- r
			errs <- e
		}()
	}
	wg.Wait()
	close(results)
	close(errs)
	for e := range errs {
		if e != nil {
			t.Fatal(e)
		}
	}
	ids := map[string]bool{}
	for r := range results {
		ids[str(r["id"])] = true
	}
	if len(ids) != 1 {
		t.Fatal("concurrent retries duplicated posts")
	}
}
func TestTrainingRequiresRealEmployeesUsesRecordedScoresAndKeepsVersionedAudit(t *testing.T) {
	f := newFixture(t, false)
	directory := bulletinDirectory()
	entries := []map[string]any{score(employee.ID, 200, 98.56, 0), score(outsider.ID, 200, 98.56, 0), score(manager.ID, 100, 99.99, 0)}
	entries[0]["employeeName"] = "伪造姓名"
	entries[0]["sourceRef"] = "不应公开的成绩来源"
	for _, reader := range []Actor{employee, hr, finance} {
		_, err := f.s.RecordTrainingScores(ctx, reader, map[string]any{"entries": entries}, uid("KEY"), directory)
		noticeStatus(t, err, 403)
	}
	recorded, err := f.s.RecordTrainingScores(ctx, manager, map[string]any{"entries": entries}, "training-record-0001", directory)
	if err != nil {
		t.Fatal(err)
	}
	if recorded["entries"].([]map[string]any)[0]["employeeName"] != directory[employee.ID].Name {
		t.Fatal("client forged employee name")
	}
	again, err := f.s.RecordTrainingScores(ctx, manager, map[string]any{"entries": entries}, "training-record-0001", directory)
	if err != nil || str(again["entries"].([]any)[0].(map[string]any)["id"]) != str(recorded["entries"].([]map[string]any)[0]["id"]) {
		t.Fatal("score retry duplicated records")
	}
	board := bulletinBoard(t, f, employee)
	training := obj(board["training"])
	ranks := training["entries"].([]map[string]any)
	if len(ranks) != 3 || training["canManage"] != false || num(ranks[0]["rank"]) != 1 || num(ranks[1]["rank"]) != 1 || num(ranks[2]["rank"]) != 3 {
		t.Fatalf("ranking did not use actual tied scores %#v", ranks)
	}
	if strings.Contains(dump(board), "不应公开的成绩来源") || strings.Contains(dump(board), "伪造姓名") {
		t.Fatal("rank exposed private source reference or fake name")
	}
	update := score(employee.ID, 250, 99.5, 0)
	_, err = f.s.RecordTrainingScores(ctx, admin, map[string]any{"entries": []map[string]any{update}}, uid("KEY"), directory)
	noticeStatus(t, err, 409)
	update["expectedVersion"] = 1
	changed, err := f.s.RecordTrainingScores(ctx, admin, map[string]any{"entries": []map[string]any{update}}, "training-update-0001", directory)
	if err != nil {
		t.Fatal(err)
	}
	current := changed["entries"].([]map[string]any)[0]
	if num(current["version"]) != 2 || num(current["completedCount"]) != 250 || current["accuracy"] != 99.5 {
		t.Fatal("score update failed")
	}
	var audits int
	f.s.db.QueryRow("SELECT COUNT(*) FROM audit WHERE action='bulletin.training.record' AND entity_id=?", current["id"]).Scan(&audits)
	if audits != 2 {
		t.Fatal("score history missing")
	}
	detail := map[string]any{}
	var raw string
	f.s.db.QueryRow("SELECT detail_json FROM audit WHERE action='bulletin.training.record' AND entity_id=? ORDER BY rowid DESC LIMIT 1", current["id"]).Scan(&raw)
	json.Unmarshal([]byte(raw), &detail)
	if detail["before"] == nil || detail["after"] == nil {
		t.Fatal("score change lacks before/after audit")
	}
	delete(directory, employee.ID)
	filtered := bulletinBoard(t, f, manager, BulletinOptions{Directory: directory})
	for _, p := range obj(filtered["training"])["entries"].([]map[string]any) {
		if p["employeeId"] == employee.ID {
			t.Fatal("inactive employee remains on current leaderboard")
		}
	}
}
func TestTrainingValidationAtomicBatchVersionRaceAndLatestPeriod(t *testing.T) {
	f := newFixture(t, false)
	directory := bulletinDirectory()
	invalid := []map[string]any{score("missing", 1, 90, 0), score(employee.ID, -1, 90, 0), score(employee.ID, 0, 90, 0), score(employee.ID, 1, 100.01, 0), score(employee.ID, 1, 98.123, 0), score(employee.ID, 1, math.NaN(), 0), score(employee.ID, 1, math.Inf(1), 0)}
	badPeriod := score(employee.ID, 1, 90, 0)
	badPeriod["periodStart"] = "2026-10-32"
	invalid = append(invalid, badPeriod)
	for _, p := range invalid {
		_, err := f.s.RecordTrainingScores(ctx, admin, map[string]any{"entries": []map[string]any{p}}, uid("KEY"), directory)
		noticeStatus(t, err, 400)
	}
	duplicate := score(employee.ID, 1, 90, 0)
	_, err := f.s.RecordTrainingScores(ctx, manager, map[string]any{"entries": []map[string]any{duplicate, duplicate}}, uid("KEY"), directory)
	noticeStatus(t, err, 400)
	original, err := f.s.RecordTrainingScores(ctx, manager, map[string]any{"entries": []map[string]any{score(employee.ID, 10, 90, 0), score(outsider.ID, 20, 95, 0)}}, uid("KEY"), directory)
	if err != nil {
		t.Fatal(err)
	}
	_, err = f.s.RecordTrainingScores(ctx, manager, map[string]any{"entries": []map[string]any{score(employee.ID, 99, 99, 1), score(outsider.ID, 999, 99, 0)}}, "training-batch-rollback", directory)
	noticeStatus(t, err, 409)
	current := bulletinBoard(t, f, employee)
	for _, r := range obj(current["training"])["entries"].([]map[string]any) {
		if num(r["version"]) != 1 {
			t.Fatal("batch conflict partly committed")
		}
	}
	var count int
	f.s.db.QueryRow("SELECT COUNT(*) FROM idempotency WHERE key='training-batch-rollback'").Scan(&count)
	if count != 0 {
		t.Fatal("rolled-back score batch consumed request key")
	}
	var wg sync.WaitGroup
	errors := make(chan error, 2)
	for i := 0; i < 2; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			_, e := f.s.RecordTrainingScores(ctx, manager, map[string]any{"entries": []map[string]any{score(employee.ID, 11, 91, 1)}}, uid("KEY"), directory)
			errors <- e
		}()
	}
	wg.Wait()
	close(errors)
	success, conflict := 0, 0
	for e := range errors {
		if e == nil {
			success++
		} else {
			noticeStatus(t, e, 409)
			conflict++
		}
	}
	if success != 1 || conflict != 1 {
		t.Fatal("score version race lost an update")
	}
	old := score(employee.ID, 999, 100, 0)
	old["periodStart"] = "2026-09-01"
	old["periodEnd"] = "2026-09-30"
	if _, err = f.s.RecordTrainingScores(ctx, manager, map[string]any{"entries": []map[string]any{old}}, uid("KEY"), directory); err != nil {
		t.Fatal(err)
	}
	if obj(bulletinBoard(t, f, employee)["training"])["periodStart"] != "2026-10-01" {
		t.Fatal("default leaderboard selected wrong period")
	}
	specific := bulletinBoard(t, f, employee, BulletinOptions{Directory: directory, PeriodStart: "2026-09-01", PeriodEnd: "2026-09-30"})
	if len(obj(specific["training"])["entries"].([]map[string]any)) != 1 {
		t.Fatal("period filter mixed scores")
	}
	_ = original
}
func TestVideoConfigurationUsesApprovedMediaSourcesAndOptimisticVersion(t *testing.T) {
	f := newFixture(t, false)
	payload := map[string]any{"src": "/media/company-film.mp4", "title": "公司宣传片", "expectedVersion": 0}
	for _, a := range []Actor{employee, manager, hr} {
		_, err := f.s.ConfigureBulletinVideo(ctx, a, payload, uid("KEY"), []string{"media.example.test"})
		noticeStatus(t, err, 403)
	}
	video, err := f.s.ConfigureBulletinVideo(ctx, admin, payload, "video-initial-config", nil)
	if err != nil || video["configured"] != true || num(video["version"]) != 1 {
		t.Fatalf("video %#v %v", video, err)
	}
	again, err := f.s.ConfigureBulletinVideo(ctx, admin, payload, "video-initial-config", nil)
	if err != nil || num(again["version"]) != 1 {
		t.Fatal("video retry incremented version")
	}
	_, err = f.s.ConfigureBulletinVideo(ctx, admin, payload, uid("KEY"), nil)
	noticeStatus(t, err, 409)
	for _, src := range []string{"http://media.example.test/film.mp4", "https://evil.test/film.mp4", "//evil.test/film.mp4", "javascript:/media/film.mp4", "data:video/mp4;base64,AAAA", "/api/session.mp4", "/media/../secret.mp4", "/media/%2e%2e/secret.mp4", "/media/%252e%252e/secret.mp4", "/media/%0aunsafe.mp4", "/media/%00unsafe.mp4", "/media/film.svg", "https://user:pass@media.example.test/film.mp4", "https://media.example.test:8443/film.mp4", "https://media.example.test/film.mp4?token=private", "/media/film.mp4#fragment"} {
		_, err = f.s.ConfigureBulletinVideo(ctx, admin, map[string]any{"src": src, "title": "公司", "expectedVersion": 1}, uid("KEY"), []string{"media.example.test"})
		noticeStatus(t, err, 400)
	}
	external, err := f.s.ConfigureBulletinVideo(ctx, admin, map[string]any{"src": "https://media.example.test/company.webm", "title": "真实宣传片", "expectedVersion": 1}, uid("KEY"), []string{"media.example.test"})
	if err != nil || external["src"] != "https://media.example.test/company.webm" {
		t.Fatal("configured official host rejected")
	}
	cleared, err := f.s.ConfigureBulletinVideo(ctx, admin, map[string]any{"src": "", "expectedVersion": 2}, uid("KEY"), nil)
	if err != nil || cleared["configured"] != false || cleared["src"] != "" {
		t.Fatal("video cannot be cleared")
	}
}
func TestBulletinMigrationPersistenceAndBusinessPreservation(t *testing.T) {
	f := newFixture(t, false)
	message, err := f.s.PostBulletinMessage(ctx, employee, map[string]any{"body": "持久化留言"}, uid("KEY"))
	if err != nil {
		t.Fatal(err)
	}
	if _, err = f.s.RecordTrainingScores(ctx, admin, map[string]any{"entries": []map[string]any{score(employee.ID, 30, 99, 0)}}, uid("KEY"), bulletinDirectory()); err != nil {
		t.Fatal(err)
	}
	if _, err = f.s.ConfigureBulletinVideo(ctx, admin, map[string]any{"src": "/media/film.mp4", "expectedVersion": 0}, uid("KEY"), nil); err != nil {
		t.Fatal(err)
	}
	snapshot, err := f.s.Snapshot(ctx, admin)
	if err != nil {
		t.Fatal(err)
	}
	if err = f.s.Close(); err != nil {
		t.Fatal(err)
	}
	f.s, err = Open(f.dir)
	if err != nil {
		t.Fatal(err)
	}
	board := bulletinBoard(t, f, employee)
	if len(obj(board["messages"])["items"].([]map[string]any)) != 1 || obj(board["messages"])["items"].([]map[string]any)[0]["id"] != message["id"] || len(obj(board["training"])["entries"].([]map[string]any)) != 1 || obj(board["video"])["configured"] != true {
		t.Fatal("bulletin state did not survive restart")
	}
	after, _ := f.s.Snapshot(ctx, admin)
	for _, key := range []string{"products", "projects", "documents", "inventory", "movements", "tasks", "loans", "performance"} {
		if !reflect.DeepEqual(snapshot[key], after[key]) {
			t.Fatal("bulletin migration changed business " + key)
		}
	}
	if _, err = f.s.db.Exec("DROP TABLE office_messages; DROP TABLE office_training_scores; DROP TABLE office_bulletin_video; PRAGMA user_version=5"); err != nil {
		t.Fatal(err)
	}
	f.s.Close()
	f.s, err = Open(f.dir)
	if err != nil {
		t.Fatal(err)
	}
	empty := bulletinBoard(t, f, employee)
	if len(obj(empty["messages"])["items"].([]map[string]any)) != 0 || len(obj(empty["training"])["entries"].([]map[string]any)) != 0 || obj(empty["video"])["configured"] != false {
		t.Fatal("additive migration seeded fake content")
	}
	var version int
	f.s.db.QueryRow("PRAGMA user_version").Scan(&version)
	if version != 6 {
		t.Fatal("bulletin migration version missing")
	}
	f.s.db.Exec("PRAGMA user_version=99")
	f.s.Close()
	f.s, err = Open(f.dir)
	if err != nil {
		t.Fatal(err)
	}
	f.s.db.QueryRow("PRAGMA user_version").Scan(&version)
	if version != 99 {
		t.Fatal("opening the database downgraded a future schema marker")
	}
}
