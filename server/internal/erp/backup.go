package erp

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"time"
)

var skuPattern = regexp.MustCompile(`^[A-Za-z0-9_.-]+$`)
var backupPattern = regexp.MustCompile(`^[A-Za-z0-9_.-]+\.sqlite$`)

// Backup uses SQLite's VACUUM INTO to include committed WAL pages in a coherent
// snapshot. A file copy of a live database would not provide this guarantee.
func (s *Store) Backup(ctx context.Context, actor Actor, destination string) (result map[string]any, err error) {
	defer recoverError(&err)
	a := actorFor(actor)
	requireRole(a, "admin")
	root := filepath.Join(s.dataDir, "backups")
	if !filepath.IsAbs(destination) || filepath.Dir(filepath.Clean(destination)) != root || !backupPattern.MatchString(filepath.Base(destination)) {
		fail("备份须位于本公司backups目录", "FORBIDDEN", 403)
	}
	check(os.MkdirAll(root, 0700))
	realBase, e := filepath.EvalSymlinks(s.dataDir)
	check(e)
	realBackup, e := filepath.EvalSymlinks(root)
	check(e)
	if realBackup != filepath.Join(realBase, "backups") {
		fail("备份目录不能指向其他位置", "FORBIDDEN", 403)
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	file, e := os.OpenFile(destination, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0600)
	if os.IsExist(e) {
		fail("备份文件已存在，不覆盖已有备份", "BACKUP_EXISTS", 409)
	}
	check(e)
	check(file.Close())
	complete := false
	defer func() {
		if !complete {
			os.Remove(destination)
		}
	}()
	deadline, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	_, e = s.db.ExecContext(deadline, "VACUUM INTO ?", destination)
	check(e)
	info, e := os.Stat(destination)
	check(e)
	if info.Size() > 512*1024*1024 {
		fail("备份超过时间或容量上限，未保留不完整文件", "LIMIT", 413)
	}
	target, e := sql.Open("sqlite", destination+"?mode=ro")
	check(e)
	defer target.Close()
	var integrity string
	check(target.QueryRowContext(deadline, "PRAGMA integrity_check").Scan(&integrity))
	rows, e := target.QueryContext(deadline, "PRAGMA foreign_key_check")
	check(e)
	hasFK := rows.Next()
	check(rows.Close())
	if integrity != "ok" || hasFK {
		fail("备份完整性检查未通过", "BACKUP_INVALID", 503)
	}
	f, e := os.Open(destination)
	check(e)
	digest := sha256.New()
	_, e = io.Copy(digest, f)
	check(e)
	check(f.Close())
	sum := hex.EncodeToString(digest.Sum(nil))
	result = map[string]any{"path": destination, "fileName": filepath.Base(destination), "bytes": info.Size(), "sha256": sum, "integrity": "ok", "createdAt": now()}
	tx, e := s.db.BeginTx(ctx, nil)
	check(e)
	defer tx.Rollback()
	q := &ledger{ctx, tx}
	q.audit(a.ID, "backup.created", filepath.Base(destination), map[string]any{"bytes": info.Size(), "sha256": sum, "integrity": "ok"})
	check(tx.Commit())
	check(os.Chmod(destination, 0600))
	complete = true
	return result, nil
}

// IntegrityCheck is useful to deployment and restore verification without exposing SQL.
func (s *Store) IntegrityCheck(ctx context.Context) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	var r string
	if e := s.db.QueryRowContext(ctx, "PRAGMA integrity_check").Scan(&r); e != nil {
		return e
	}
	if strings.TrimSpace(r) != "ok" {
		return &Error{Status: 503, Code: "BACKUP_INVALID", Message: "数据库完整性检查未通过"}
	}
	rows, e := s.db.QueryContext(ctx, "PRAGMA foreign_key_check")
	if e != nil {
		return e
	}
	defer rows.Close()
	if rows.Next() {
		return &Error{Status: 503, Code: "BACKUP_INVALID", Message: "数据库关联完整性检查未通过"}
	}
	return rows.Err()
}
