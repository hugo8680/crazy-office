package erp

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
)

// This additive migration shares the ERP ledger, its backups and transactions.
// An older server can still open the database; no existing table is rewritten.
const noticeSchema = `
CREATE TABLE IF NOT EXISTS office_notices(id TEXT PRIMARY KEY,title TEXT NOT NULL,body TEXT NOT NULL,author_id TEXT NOT NULL,author_name TEXT NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,version INTEGER NOT NULL CHECK(version>0),archived INTEGER NOT NULL DEFAULT 0 CHECK(archived IN (0,1)));
CREATE INDEX IF NOT EXISTS office_notices_listing_idx ON office_notices(archived,created_at DESC);
`

func (q *ledger) notice(id string) map[string]any {
	r := q.one("SELECT id,title,body,author_id AS authorId,author_name AS authorName,created_at AS createdAt,updated_at AS updatedAt,version,archived FROM office_notices WHERE id=?", id)
	if r == nil {
		fail("公告不存在", "NOT_FOUND", 404)
	}
	r["archived"] = num(r["archived"]) != 0
	return r
}

func (s *Store) Notices(ctx context.Context, actor Actor) (map[string]any, error) {
	return s.transaction(ctx, func(q *ledger) map[string]any {
		a := actorFor(actor)
		canPublish := role(a, "hr")
		query := "SELECT id,title,body,author_id AS authorId,author_name AS authorName,created_at AS createdAt,updated_at AS updatedAt,version,archived FROM office_notices"
		if !canPublish {
			query += " WHERE archived=0"
		}
		rows := q.rows(query + " ORDER BY created_at DESC,rowid DESC LIMIT 100")
		for _, r := range rows {
			r["archived"] = num(r["archived"]) != 0
		}
		return map[string]any{"notices": rows, "canPublish": canPublish}
	})
}

func (s *Store) PublishNotice(ctx context.Context, actor Actor, payload map[string]any, requestID string) (map[string]any, error) {
	return s.transaction(ctx, func(q *ledger) map[string]any {
		a := actorFor(actor)
		requireRole(a, "hr")
		title, body := text(payload["title"], "公告标题", 80, true), text(payload["body"], "公告正文", 5000, true)
		key := text(requestID, "请求编号", 150, true)
		hash := sha256.Sum256([]byte(dump(map[string]any{"action": "notice.create", "title": title, "body": body})))
		requestHash := hex.EncodeToString(hash[:])
		if previous := q.one("SELECT request_hash,response_json FROM idempotency WHERE actor_id=? AND key=?", a.ID, key); previous != nil {
			if previous["request_hash"] != requestHash {
				fail("同一请求编号不能提交不同内容", "IDEMPOTENCY_CONFLICT", 409)
			}
			return obj(parse(previous["response_json"]))
		}
		id, stamp := uid("NTC"), now()
		q.exec("INSERT INTO office_notices(id,title,body,author_id,author_name,created_at,updated_at,version,archived) VALUES(?,?,?,?,?,?,?,1,0)", id, title, body, a.ID, a.DisplayName, stamp, stamp)
		result := q.notice(id)
		q.audit(a.ID, "notice.create", id, map[string]any{"notice": result})
		q.exec("INSERT INTO idempotency(actor_id,key,request_hash,response_json) VALUES(?,?,?,?)", a.ID, key, requestHash, dump(result))
		return result
	})
}

func (s *Store) UpdateNotice(ctx context.Context, actor Actor, id string, payload map[string]any) (map[string]any, error) {
	return s.transaction(ctx, func(q *ledger) map[string]any {
		a := actorFor(actor)
		requireRole(a, "hr")
		id = text(id, "公告编号", 100, true)
		version := integer(payload["expectedVersion"], "公告版本", 1, 1000000000)
		before := q.notice(id)
		if num(before["version"]) != version {
			fail("公告已更新，请刷新后核对", "VERSION_CONFLICT", 409)
		}
		if before["archived"] == true {
			fail("公告已归档，不能再次修改", "STATE_CONFLICT", 409)
		}
		action := "notice.update"
		if archive, exists := payload["archived"]; exists {
			if archive != true {
				fail("归档状态无效")
			}
			action = "notice.archive"
			q.exec("UPDATE office_notices SET archived=1,updated_at=?,version=version+1 WHERE id=?", now(), id)
		} else {
			title, body := text(payload["title"], "公告标题", 80, true), text(payload["body"], "公告正文", 5000, true)
			q.exec("UPDATE office_notices SET title=?,body=?,updated_at=?,version=version+1 WHERE id=?", title, body, now(), id)
		}
		after := q.notice(id)
		q.audit(a.ID, action, id, map[string]any{"before": before, "after": after})
		return after
	})
}
