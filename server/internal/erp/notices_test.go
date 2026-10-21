package erp

import (
	"errors"
	"strings"
	"sync"
	"testing"
)

func noticeStatus(t *testing.T, err error, want int) {
	t.Helper()
	var domain *Error
	if !errors.As(err, &domain) || domain.Status != want {
		t.Fatalf("want status %d, got %v", want, err)
	}
}

func TestNoticePermissionsAuthorshipEditAndArchive(t *testing.T) {
	f := newFixture(t, false)
	empty, err := f.s.Notices(ctx, employee)
	if err != nil || len(empty["notices"].([]map[string]any)) != 0 || empty["canPublish"] != false {
		t.Fatalf("empty notice board must contain no sample notices: %#v %v", empty, err)
	}
	_, err = f.s.Notices(ctx, Actor{})
	noticeStatus(t, err, 401)
	for _, reader := range []Actor{employee, manager, finance, warehouse, pm} {
		_, err = f.s.PublishNotice(ctx, reader, map[string]any{"title": "公告", "body": "正文"}, uid("KEY"))
		noticeStatus(t, err, 403)
	}
	creator := hr
	creator.DisplayName = "行政负责人"
	created, err := f.s.PublishNotice(ctx, creator, map[string]any{"title": "办公安排", "body": "周五进行设备盘点。", "authorId": "forged", "authorName": "伪造姓名"}, "notice-create-0001")
	if err != nil || created["authorId"] != hr.ID || created["authorName"] != creator.DisplayName || num(created["version"]) != 1 || created["archived"] != false {
		t.Fatalf("server authorship missing: %#v %v", created, err)
	}
	id := str(created["id"])
	_, err = f.s.UpdateNotice(ctx, employee, id, map[string]any{"title": "篡改", "body": "失败", "expectedVersion": 1})
	noticeStatus(t, err, 403)
	updated, err := f.s.UpdateNotice(ctx, admin, id, map[string]any{"title": "办公安排调整", "body": "改为下周一进行设备盘点。", "expectedVersion": 1, "authorId": "forged"})
	if err != nil || num(updated["version"]) != 2 || updated["authorId"] != hr.ID || updated["createdAt"] != created["createdAt"] {
		t.Fatalf("notice edit lost authorship/history: %#v %v", updated, err)
	}
	_, err = f.s.UpdateNotice(ctx, admin, id, map[string]any{"archived": true, "expectedVersion": 1})
	noticeStatus(t, err, 409)
	archived, err := f.s.UpdateNotice(ctx, admin, id, map[string]any{"archived": true, "expectedVersion": 2})
	if err != nil || archived["archived"] != true || num(archived["version"]) != 3 {
		t.Fatalf("archive failed: %#v %v", archived, err)
	}
	public, _ := f.s.Notices(ctx, employee)
	adminView, _ := f.s.Notices(ctx, admin)
	if len(public["notices"].([]map[string]any)) != 0 || len(adminView["notices"].([]map[string]any)) != 1 || adminView["canPublish"] != true {
		t.Fatal("archived notice leaked to employee or disappeared from management")
	}
	_, err = f.s.UpdateNotice(ctx, hr, id, map[string]any{"title": "不能改归档", "body": "正文", "expectedVersion": 3})
	noticeStatus(t, err, 409)
	var count int
	if err = f.s.db.QueryRow("SELECT COUNT(*) FROM audit WHERE entity_id=? AND action IN ('notice.create','notice.update','notice.archive')", id).Scan(&count); err != nil || count != 3 {
		t.Fatalf("notice audit count %d: %v", count, err)
	}
}

func TestNoticeIdempotencyValidationAndVersionRace(t *testing.T) {
	f := newFixture(t, false)
	payload := map[string]any{"title": strings.Repeat("题", 80), "body": strings.Repeat("文", 5000)}
	first, err := f.s.PublishNotice(ctx, admin, payload, "notice-idempotency-0001")
	if err != nil {
		t.Fatal(err)
	}
	again, err := f.s.PublishNotice(ctx, admin, payload, "notice-idempotency-0001")
	if err != nil || first["id"] != again["id"] {
		t.Fatalf("repeated request duplicated notice: %#v %v", again, err)
	}
	_, err = f.s.PublishNotice(ctx, admin, map[string]any{"title": "不同内容", "body": "正文"}, "notice-idempotency-0001")
	noticeStatus(t, err, 409)
	for _, invalid := range []map[string]any{{"title": "", "body": "正文"}, {"title": strings.Repeat("题", 81), "body": "正文"}, {"title": "标题", "body": strings.Repeat("文", 5001)}, {"title": "标题", "body": "坏\x00字"}} {
		_, err = f.s.PublishNotice(ctx, admin, invalid, uid("KEY"))
		noticeStatus(t, err, 400)
	}
	id := str(first["id"])
	_, err = f.s.UpdateNotice(ctx, hr, id, map[string]any{"title": "新标题", "body": "正文"})
	noticeStatus(t, err, 400)
	_, err = f.s.UpdateNotice(ctx, hr, "missing", map[string]any{"title": "新标题", "body": "正文", "expectedVersion": 1})
	noticeStatus(t, err, 404)
	var wg sync.WaitGroup
	results := make(chan error, 2)
	for i := 0; i < 2; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			_, e := f.s.UpdateNotice(ctx, hr, id, map[string]any{"title": "并发修改", "body": "仅一次成功", "expectedVersion": 1})
			results <- e
		}()
	}
	wg.Wait()
	close(results)
	success, conflicts := 0, 0
	for e := range results {
		if e == nil {
			success++
		} else {
			noticeStatus(t, e, 409)
			conflicts++
		}
	}
	if success != 1 || conflicts != 1 {
		t.Fatalf("version race success=%d conflicts=%d", success, conflicts)
	}
}

func TestNoticeMigrationPersistenceLimitAndTransactionRollback(t *testing.T) {
	f := newFixture(t, false)
	if _, err := f.s.db.Exec("DROP TABLE office_notices; PRAGMA user_version=4"); err != nil {
		t.Fatal(err)
	}
	if err := f.s.Close(); err != nil {
		t.Fatal(err)
	}
	var err error
	f.s, err = Open(f.dir)
	if err != nil {
		t.Fatal(err)
	}
	snapshot, err := f.s.Snapshot(ctx, admin)
	if err != nil || len(snapshot["products"].([]map[string]any)) != 1 || len(snapshot["projects"].([]map[string]any)) != 1 {
		t.Fatalf("additive notice migration changed existing business: %#v %v", snapshot, err)
	}
	if _, err = f.s.db.Exec("CREATE TRIGGER reject_notice_audit BEFORE INSERT ON audit WHEN NEW.action='notice.create' BEGIN SELECT RAISE(ABORT,'reject isolated audit'); END"); err != nil {
		t.Fatal(err)
	}
	_, err = f.s.PublishNotice(ctx, admin, map[string]any{"title": "事务回滚", "body": "不会提交"}, "notice-rollback-0001")
	if err == nil {
		t.Fatal("audit failure committed notice")
	}
	var count int
	if err = f.s.db.QueryRow("SELECT COUNT(*) FROM office_notices").Scan(&count); err != nil || count != 0 {
		t.Fatalf("partial notice write survived rollback: %d %v", count, err)
	}
	if err = f.s.db.QueryRow("SELECT COUNT(*) FROM idempotency WHERE key='notice-rollback-0001'").Scan(&count); err != nil || count != 0 {
		t.Fatalf("partial request key survived rollback: %d %v", count, err)
	}
	if _, err = f.s.db.Exec("DROP TRIGGER reject_notice_audit"); err != nil {
		t.Fatal(err)
	}
	for i := 0; i < 105; i++ {
		if _, err = f.s.PublishNotice(ctx, hr, map[string]any{"title": "真实测试公告", "body": "测试正文"}, uid("KEY")); err != nil {
			t.Fatal(err)
		}
	}
	if err = f.s.Close(); err != nil {
		t.Fatal(err)
	}
	f.s, err = Open(f.dir)
	if err != nil {
		t.Fatal(err)
	}
	listed, err := f.s.Notices(ctx, employee)
	if err != nil || len(listed["notices"].([]map[string]any)) != 100 {
		t.Fatalf("latest notice list not bounded/persistent: %#v %v", listed, err)
	}
	if err = f.s.db.QueryRow("SELECT COUNT(*) FROM office_notices").Scan(&count); err != nil || count != 105 {
		t.Fatalf("list limit deleted announcements: %d %v", count, err)
	}
}
