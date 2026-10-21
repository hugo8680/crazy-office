package erp

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"math"
	"net/url"
	"path"
	"regexp"
	"strings"
	"time"
)

// Additive tables share the ERP's transactions, audit, idempotency and backups.
// No training scores or messages are seeded during migration.
const bulletinSchema = `
CREATE TABLE IF NOT EXISTS office_messages(id TEXT PRIMARY KEY,body TEXT NOT NULL,author_id TEXT NOT NULL,author_name TEXT NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,version INTEGER NOT NULL CHECK(version>0),deleted INTEGER NOT NULL DEFAULT 0 CHECK(deleted IN(0,1)),deleted_by TEXT,deleted_at TEXT);
CREATE INDEX IF NOT EXISTS office_messages_listing_idx ON office_messages(deleted,created_at DESC);
CREATE INDEX IF NOT EXISTS office_messages_author_rate_idx ON office_messages(author_id,created_at DESC);
CREATE TABLE IF NOT EXISTS office_training_scores(id TEXT PRIMARY KEY,employee_id TEXT NOT NULL,employee_name TEXT NOT NULL,department TEXT NOT NULL,period_start TEXT NOT NULL,period_end TEXT NOT NULL,completed_count INTEGER NOT NULL CHECK(completed_count>=0),accuracy_bp INTEGER NOT NULL CHECK(accuracy_bp>=0 AND accuracy_bp<=10000),source_ref TEXT NOT NULL,recorded_by TEXT NOT NULL,recorded_name TEXT NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,version INTEGER NOT NULL CHECK(version>0),UNIQUE(employee_id,period_start,period_end));
CREATE INDEX IF NOT EXISTS office_training_period_idx ON office_training_scores(period_end DESC,period_start DESC,completed_count DESC,accuracy_bp DESC);
CREATE TABLE IF NOT EXISTS office_bulletin_video(id TEXT PRIMARY KEY CHECK(id='company'),src TEXT NOT NULL,title TEXT NOT NULL,updated_by TEXT NOT NULL,updated_at TEXT NOT NULL,version INTEGER NOT NULL CHECK(version>0));
`
const BulletinMessageLimit = 100
const BulletinMessageLength = 600
const BulletinMessageIntervalSeconds = 15

type BulletinEmployee struct{ ID, Name, Department string }
type BulletinOptions struct {
	Directory                               map[string]BulletinEmployee
	PeriodStart, PeriodEnd, MessageBeforeID string
}

func (q *ledger) bulletinReplay(a Actor, key, action string, payload map[string]any) (map[string]any, string) {
	key = text(key, "请求编号", 150, true)
	sum := sha256.Sum256([]byte(dump(map[string]any{"action": action, "payload": payload})))
	hash := hex.EncodeToString(sum[:])
	if old := q.one("SELECT request_hash,response_json FROM idempotency WHERE actor_id=? AND key=?", a.ID, key); old != nil {
		if old["request_hash"] != hash {
			fail("同一请求编号不能提交不同内容", "IDEMPOTENCY_CONFLICT", 409)
		}
		return obj(parse(old["response_json"])), hash
	}
	return nil, hash
}
func (q *ledger) bulletinRemember(a Actor, key, hash string, result map[string]any) {
	q.exec("INSERT INTO idempotency(actor_id,key,request_hash,response_json) VALUES(?,?,?,?)", a.ID, key, hash, dump(result))
}
func (q *ledger) message(id string, a Actor) map[string]any {
	r := q.one("SELECT id,body,author_id AS authorId,author_name AS authorName,created_at AS createdAt,updated_at AS updatedAt,version,deleted FROM office_messages WHERE id=?", id)
	if r == nil {
		fail("留言不存在", "NOT_FOUND", 404)
	}
	r["deleted"] = num(r["deleted"]) != 0
	r["canDelete"] = r["deleted"] == false && (r["authorId"] == a.ID || role(a, "admin"))
	return r
}
func (q *ledger) messages(a Actor, beforeID string) map[string]any {
	beforeID = text(beforeID, "留言游标", 100, false)
	query := "SELECT id FROM office_messages WHERE deleted=0"
	args := []any{}
	if beforeID != "" {
		r := q.one("SELECT rowid AS position FROM office_messages WHERE id=?", beforeID)
		if r == nil {
			fail("留言游标已失效，请重新读取", "CURSOR_INVALID", 400)
		}
		query += " AND rowid<?"
		args = append(args, r["position"])
	}
	records := q.rows(query+" ORDER BY rowid DESC LIMIT 101", args...)
	hasMore := len(records) > BulletinMessageLimit
	if hasMore {
		records = records[:BulletinMessageLimit]
	}
	items := []map[string]any{}
	for _, r := range records {
		items = append(items, q.message(str(r["id"]), a))
	}
	cursor := ""
	if hasMore && len(items) > 0 {
		cursor = str(items[len(items)-1]["id"])
	}
	return map[string]any{"items": items, "canPost": true, "maxLength": BulletinMessageLength, "postIntervalSeconds": BulletinMessageIntervalSeconds, "hourlyLimit": 10, "limit": BulletinMessageLimit, "hasMore": hasMore, "nextCursor": cursor, "bodyFormat": "plain"}
}
func (s *Store) BulletinMessages(ctx context.Context, actor Actor, beforeID string) (map[string]any, error) {
	return s.transaction(ctx, func(q *ledger) map[string]any { return q.messages(actorFor(actor), beforeID) })
}
func (s *Store) PostBulletinMessage(ctx context.Context, actor Actor, payload map[string]any, key string) (map[string]any, error) {
	return s.transaction(ctx, func(q *ledger) map[string]any {
		a := actorFor(actor)
		body := text(payload["body"], "留言", BulletinMessageLength, true)
		previous, hash := q.bulletinReplay(a, key, "bulletin.message.create", map[string]any{"body": body})
		if previous != nil {
			return previous
		}
		current := time.Now().UTC()
		stamp := current.Format("2006-01-02T15:04:05.000Z")
		// Deleted posts still count, so deletion cannot bypass abuse limits.
		if latest := q.one("SELECT created_at FROM office_messages WHERE author_id=? ORDER BY created_at DESC,rowid DESC LIMIT 1", a.ID); latest != nil {
			date, err := time.Parse(time.RFC3339Nano, str(latest["created_at"]))
			check(err)
			remaining := time.Duration(BulletinMessageIntervalSeconds)*time.Second - current.Sub(date)
			if remaining > 0 {
				panic(&Error{Status: 429, Code: "RATE_LIMIT", Message: "请稍后再发留言", Details: map[string]any{"retryAfterSeconds": int64(math.Ceil(remaining.Seconds()))}})
			}
		}
		recent := q.rows("SELECT created_at FROM office_messages WHERE author_id=? AND created_at>=? ORDER BY created_at ASC,rowid ASC", a.ID, current.Add(-time.Hour).Format("2006-01-02T15:04:05.000Z"))
		if len(recent) >= 10 {
			oldest, err := time.Parse(time.RFC3339Nano, str(recent[0]["created_at"]))
			check(err)
			remaining := int64(math.Ceil(oldest.Add(time.Hour).Sub(current).Seconds()))
			if remaining < 1 {
				remaining = 1
			}
			panic(&Error{Status: 429, Code: "RATE_LIMIT", Message: "本小时留言已达上限，请稍后再发", Details: map[string]any{"retryAfterSeconds": remaining}})
		}
		id := uid("MSG")
		q.exec("INSERT INTO office_messages(id,body,author_id,author_name,created_at,updated_at,version,deleted) VALUES(?,?,?,?,?,?,1,0)", id, body, a.ID, a.DisplayName, stamp, stamp)
		result := q.message(id, a)
		q.audit(a.ID, "bulletin.message.create", id, map[string]any{"message": result})
		q.bulletinRemember(a, key, hash, result)
		return result
	})
}
func (s *Store) DeleteBulletinMessage(ctx context.Context, actor Actor, id string, payload map[string]any, key string) (map[string]any, error) {
	return s.transaction(ctx, func(q *ledger) map[string]any {
		a := actorFor(actor)
		id = text(id, "留言编号", 100, true)
		version := integer(payload["expectedVersion"], "留言版本", 1, 1000000000)
		before := q.message(id, a)
		if before["authorId"] != a.ID && !role(a, "admin") {
			fail("只能删除自己的留言", "FORBIDDEN", 403)
		}
		previous, hash := q.bulletinReplay(a, key, "bulletin.message.delete", map[string]any{"id": id, "expectedVersion": version})
		if previous != nil {
			return previous
		}
		if before["deleted"] == true {
			fail("留言已删除", "STATE_CONFLICT", 409)
		}
		if num(before["version"]) != version {
			fail("留言已更新，请重新读取", "VERSION_CONFLICT", 409)
		}
		stamp := now()
		q.exec("UPDATE office_messages SET deleted=1,deleted_by=?,deleted_at=?,updated_at=?,version=version+1 WHERE id=?", a.ID, stamp, stamp, id)
		result := q.message(id, a)
		q.audit(a.ID, "bulletin.message.delete", id, map[string]any{"before": before, "after": result})
		q.bulletinRemember(a, key, hash, result)
		return result
	})
}
func accuracyBP(value any) int64 {
	var n float64
	switch x := value.(type) {
	case float64:
		n = x
	case int:
		n = float64(x)
	case int64:
		n = float64(x)
	case int32:
		n = float64(x)
	case json.Number:
		var err error
		n, err = x.Float64()
		if err != nil {
			fail("准确率须为0至100的数值，最多两位小数")
		}
	default:
		fail("准确率须为0至100的数值，最多两位小数")
	}
	if math.IsNaN(n) || math.IsInf(n, 0) || n < 0 || n > 100 || math.Abs(n*100-math.Round(n*100)) > 0.0000001 {
		fail("准确率须为0至100的数值，最多两位小数")
	}
	return int64(math.Round(n * 100))
}
func trainingPeriod(startValue, endValue any) (string, string) {
	start, end := date(startValue, "周期开始日期", true), date(endValue, "周期结束日期", true)
	from, _ := time.Parse("2006-01-02", start)
	to, _ := time.Parse("2006-01-02", end)
	if end < start || to.Sub(from) > 366*24*time.Hour {
		fail("成绩周期须前后有序且不超过一年")
	}
	return start, end
}
func (q *ledger) trainingScore(id string) map[string]any {
	r := q.one("SELECT id,employee_id AS employeeId,employee_name AS employeeName,department,period_start AS periodStart,period_end AS periodEnd,completed_count AS completedCount,accuracy_bp AS accuracyBasisPoints,updated_at AS recordedAt,version FROM office_training_scores WHERE id=?", id)
	if r == nil {
		fail("训练成绩不存在", "NOT_FOUND", 404)
	}
	r["accuracy"] = float64(num(r["accuracyBasisPoints"])) / 100
	delete(r, "accuracyBasisPoints")
	return r
}
func (s *Store) RecordTrainingScores(ctx context.Context, actor Actor, payload map[string]any, key string, directory map[string]BulletinEmployee) (map[string]any, error) {
	return s.transaction(ctx, func(q *ledger) map[string]any {
		a := actorFor(actor)
		requireRole(a, "manager")
		raw := list(payload["entries"])
		if len(raw) < 1 || len(raw) > 250 {
			fail("每次录入1至250条成绩")
		}
		normalized := []map[string]any{}
		seen := map[string]bool{}
		for _, value := range raw {
			p := obj(value)
			employeeID := text(p["employeeId"], "员工编号", 100, true)
			employee, exists := directory[employeeID]
			if !exists || employee.ID != employeeID || employee.Name == "" {
				fail("成绩员工不存在或账号已停用", "EMPLOYEE_INVALID", 400)
			}
			start, end := trainingPeriod(p["periodStart"], p["periodEnd"])
			completed := integer(p["completedCount"], "完成量", 0, 1000000000)
			accuracy := accuracyBP(p["accuracy"])
			if completed == 0 && accuracy != 0 {
				fail("完成量为0时准确率须为0")
			}
			version := integer(p["expectedVersion"], "成绩版本", 0, 1000000000)
			source := text(p["sourceRef"], "成绩来源", 200, false)
			identity := employeeID + ":" + start + ":" + end
			if seen[identity] {
				fail("同批次不能重复录入同一员工的相同周期成绩")
			}
			seen[identity] = true
			normalized = append(normalized, map[string]any{"employeeId": employeeID, "periodStart": start, "periodEnd": end, "completedCount": completed, "accuracyBasisPoints": accuracy, "expectedVersion": version, "sourceRef": source})
		}
		previous, hash := q.bulletinReplay(a, key, "bulletin.training.record", map[string]any{"entries": normalized})
		if previous != nil {
			return previous
		}
		entries := []map[string]any{}
		for _, p := range normalized {
			employee := directory[str(p["employeeId"])]
			existing := q.one("SELECT id,version FROM office_training_scores WHERE employee_id=? AND period_start=? AND period_end=?", employee.ID, p["periodStart"], p["periodEnd"])
			version := num(p["expectedVersion"])
			id, stamp := uid("TRN"), now()
			var before map[string]any
			if existing == nil {
				if version != 0 {
					fail("成绩不存在，创建时版本须为0", "VERSION_CONFLICT", 409)
				}
				q.exec("INSERT INTO office_training_scores(id,employee_id,employee_name,department,period_start,period_end,completed_count,accuracy_bp,source_ref,recorded_by,recorded_name,created_at,updated_at,version) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,1)", id, employee.ID, employee.Name, employee.Department, p["periodStart"], p["periodEnd"], p["completedCount"], p["accuracyBasisPoints"], p["sourceRef"], a.ID, a.DisplayName, stamp, stamp)
			} else {
				if version != num(existing["version"]) {
					fail("训练成绩已更新，请重新核对版本", "VERSION_CONFLICT", 409)
				}
				id = str(existing["id"])
				before = q.trainingScore(id)
				q.exec("UPDATE office_training_scores SET employee_name=?,department=?,completed_count=?,accuracy_bp=?,source_ref=?,recorded_by=?,recorded_name=?,updated_at=?,version=version+1 WHERE id=?", employee.Name, employee.Department, p["completedCount"], p["accuracyBasisPoints"], p["sourceRef"], a.ID, a.DisplayName, stamp, id)
			}
			result := q.trainingScore(id)
			entries = append(entries, result)
			q.audit(a.ID, "bulletin.training.record", id, map[string]any{"before": before, "after": result, "sourceRef": p["sourceRef"]})
		}
		result := map[string]any{"entries": entries}
		q.bulletinRemember(a, key, hash, result)
		return result
	})
}
func (q *ledger) training(a Actor, options BulletinOptions) map[string]any {
	start, end := options.PeriodStart, options.PeriodEnd
	if start != "" || end != "" {
		start, end = trainingPeriod(start, end)
	} else if latest := q.one("SELECT period_start,period_end FROM office_training_scores ORDER BY period_end DESC,period_start DESC LIMIT 1"); latest != nil {
		start, end = str(latest["period_start"]), str(latest["period_end"])
	}
	entries := []map[string]any{}
	if start != "" {
		previousCount, previousAccuracy, rank := int64(-1), float64(-1), 0
		for _, r := range q.rows("SELECT id FROM office_training_scores WHERE period_start=? AND period_end=? ORDER BY completed_count DESC,accuracy_bp DESC,employee_id ASC LIMIT 2000", start, end) {
			item := q.trainingScore(str(r["id"]))
			employee, active := options.Directory[str(item["employeeId"])]
			if !active {
				continue
			}
			item["employeeName"], item["department"] = employee.Name, employee.Department
			count, accuracy := num(item["completedCount"]), item["accuracy"].(float64)
			if count != previousCount || accuracy != previousAccuracy {
				rank = len(entries) + 1
			}
			item["rank"] = rank
			entries = append(entries, item)
			previousCount, previousAccuracy = count, accuracy
		}
	}
	return map[string]any{"entries": entries, "periodStart": start, "periodEnd": end, "canManage": role(a, "manager"), "rankingBy": "completedCount", "source": "recorded", "maxBatchSize": 250}
}
func (q *ledger) bulletinDashboard(a Actor) map[string]any {
	projects, openTasks, pendingDocuments := int64(0), int64(0), int64(0)
	visible := map[string]bool{}
	for _, r := range q.rows("SELECT id FROM projects") {
		project := q.project(str(r["id"]))
		if projectAccess(a, project) {
			projects++
			visible[str(project["id"])] = true
		}
	}
	for _, r := range q.rows("SELECT project_id,status FROM tasks WHERE status<>'completed'") {
		if visible[str(r["project_id"])] {
			openTasks++
		}
	}
	for _, r := range q.rows("SELECT requester_id,project_id,type,department,status FROM documents WHERE status NOT IN ('completed','cancelled')") {
		if q.documentAccess(a, r) {
			pendingDocuments++
		}
	}
	products := num(q.scalar("SELECT COUNT(*) FROM products"))
	metrics := []map[string]any{{"id": "projects", "label": "可见项目", "value": projects, "unit": "个"}, {"id": "tasks", "label": "待完成任务", "value": openTasks, "unit": "项"}, {"id": "products", "label": "产品种类", "value": products, "unit": "种"}, {"id": "documents", "label": "未结单据", "value": pendingDocuments, "unit": "张"}}
	return map[string]any{"scope": "visible", "generatedAt": now(), "metrics": metrics}
}
func (q *ledger) bulletinVideo(a Actor) map[string]any {
	result := map[string]any{"src": "", "title": "公司宣传片", "configured": false, "canManage": has(a.Roles, "admin"), "version": int64(0), "updatedAt": ""}
	if r := q.one("SELECT src,title,version,updated_at AS updatedAt FROM office_bulletin_video WHERE id='company'"); r != nil {
		result["src"], result["title"], result["version"], result["updatedAt"] = r["src"], r["title"], r["version"], r["updatedAt"]
		result["configured"] = str(r["src"]) != ""
	}
	return result
}

var mediaExtension = regexp.MustCompile(`(?i)\.(mp4|webm|ogg)$`)

// Video is a browser media source, never fetched by the server. External hosts
// must be declared by the server operator; users cannot widen this allow-list.
func validateBulletinVideo(raw string, officialHosts []string) string {
	if raw == "" {
		return ""
	}
	u, err := url.Parse(raw)
	if err != nil || u.User != nil || u.Fragment != "" || u.RawQuery != "" || strings.ContainsAny(raw, "\\\r\n\x00") {
		fail("视频地址无效")
	}
	decoded, err := url.PathUnescape(u.EscapedPath())
	if err != nil || decoded == "" || strings.Contains(decoded, "\\") || strings.IndexFunc(decoded, func(r rune) bool { return r < 32 || r == 127 }) >= 0 || strings.Contains(decoded, "%") || path.Clean(decoded) != decoded || !mediaExtension.MatchString(decoded) {
		fail("视频地址须指向有效媒体文件")
	}
	if u.Scheme == "" && u.Host == "" {
		if !strings.HasPrefix(decoded, "/media/") && !strings.HasPrefix(decoded, "/assets/") {
			fail("站内视频须位于media或assets目录")
		}
		return u.String()
	}
	if u.Scheme != "https" || u.Host == "" || u.Opaque != "" || u.Port() != "" && u.Port() != "443" {
		fail("外部视频须使用已配置的HTTPS官方地址")
	}
	allowed := false
	for _, host := range officialHosts {
		if strings.EqualFold(strings.TrimSpace(host), u.Hostname()) && host != "" {
			allowed = true
			break
		}
	}
	if !allowed {
		fail("视频域名未列入官方媒体配置")
	}
	return u.String()
}
func (s *Store) ConfigureBulletinVideo(ctx context.Context, actor Actor, payload map[string]any, key string, officialHosts []string) (map[string]any, error) {
	return s.transaction(ctx, func(q *ledger) map[string]any {
		a := actorFor(actor)
		requireRole(a, "admin")
		src := validateBulletinVideo(text(payload["src"], "视频地址", 2048, false), officialHosts)
		title := text(def(payload, "title", "公司宣传片"), "视频标题", 80, true)
		version := integer(payload["expectedVersion"], "视频版本", 0, 1000000000)
		previous, hash := q.bulletinReplay(a, key, "bulletin.video.configure", map[string]any{"src": src, "title": title, "expectedVersion": version})
		if previous != nil {
			return previous
		}
		before := q.bulletinVideo(a)
		if num(before["version"]) != version {
			fail("视频配置已更新，请重新读取", "VERSION_CONFLICT", 409)
		}
		q.exec("INSERT INTO office_bulletin_video(id,src,title,updated_by,updated_at,version) VALUES('company',?,?,?,?,1) ON CONFLICT(id) DO UPDATE SET src=excluded.src,title=excluded.title,updated_by=excluded.updated_by,updated_at=excluded.updated_at,version=office_bulletin_video.version+1", src, title, a.ID, now())
		result := q.bulletinVideo(a)
		q.audit(a.ID, "bulletin.video.configure", "company", map[string]any{"before": before, "after": result})
		q.bulletinRemember(a, key, hash, result)
		return result
	})
}
func (s *Store) Bulletin(ctx context.Context, actor Actor, options BulletinOptions) (map[string]any, error) {
	return s.transaction(ctx, func(q *ledger) map[string]any {
		a := actorFor(actor)
		return map[string]any{"training": q.training(a, options), "dashboard": q.bulletinDashboard(a), "video": q.bulletinVideo(a), "messages": q.messages(a, options.MessageBeforeID)}
	})
}
