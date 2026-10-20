package tools

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"modernc.org/sqlite"
	"os"
	"regexp"
	"sort"
	"strings"
	"time"
)

type sqlRunner interface {
	ExecContext(context.Context, string, ...any) (sql.Result, error)
	QueryContext(context.Context, string, ...any) (*sql.Rows, error)
}

func openDB(path string) (*sql.DB, error) {
	db, e := sql.Open("sqlite", path+"?_pragma=foreign_keys(1)&_pragma=busy_timeout(5000)")
	if e == nil {
		db.SetMaxOpenConns(1)
	}
	return db, e
}
func sqlStatements(raw, mode string) ([]string, error) {
	if len(raw) > 160000 {
		return nil, errors.New("SQL超过160000字符")
	}
	out := []string{}
	var b strings.Builder
	quote := rune(0)
	r := []rune(raw)
	for i := 0; i < len(r); i++ {
		c := r[i]
		if quote != 0 {
			b.WriteRune(c)
			if c == quote {
				if i+1 < len(r) && r[i+1] == quote {
					b.WriteRune(r[i+1])
					i++
				} else {
					quote = 0
				}
			}
			continue
		}
		if c == '\'' || c == '"' || c == '`' {
			quote = c
			b.WriteRune(c)
			continue
		}
		if c == '-' && i+1 < len(r) && r[i+1] == '-' {
			for i < len(r) && r[i] != '\n' {
				i++
			}
			b.WriteRune(' ')
			continue
		}
		if c == '/' && i+1 < len(r) && r[i+1] == '*' {
			i += 2
			for i+1 < len(r) && !(r[i] == '*' && r[i+1] == '/') {
				i++
			}
			i++
			b.WriteRune(' ')
			continue
		}
		if c == ';' {
			if s := strings.TrimSpace(b.String()); s != "" {
				out = append(out, s)
			}
			b.Reset()
		} else {
			b.WriteRune(c)
		}
	}
	if quote != 0 {
		return nil, errors.New("SQL字符串未闭合")
	}
	if s := strings.TrimSpace(b.String()); s != "" {
		out = append(out, s)
	}
	if len(out) == 0 {
		return nil, errors.New("SQL为空")
	}
	pattern := map[string]string{"design": `(?i)^CREATE\s+(TABLE|(?:UNIQUE\s+)?INDEX)\b`, "insert": `(?i)^INSERT\s+INTO\b`, "select": `(?i)^(SELECT|WITH)\b`, "test": `(?i)^(INSERT\s+INTO|UPDATE\b|DELETE\s+FROM|SELECT\b|WITH\b)`}[mode]
	ban := regexp.MustCompile(`(?i)\b(ATTACH|DETACH|PRAGMA|VACUUM|LOAD_EXTENSION|WRITABLE_SCHEMA|VIRTUAL\s+TABLE|readfile|writefile|randomblob|zeroblob|sqlite_dbpage|sqlite_dbdata)\b`)
	for _, s := range out {
		if !regexp.MustCompile(pattern).MatchString(s) || ban.MatchString(s) {
			return nil, errors.New("SQL包含不允许的语句、扩展或跨文件操作")
		}
		if mode == "select" && regexp.MustCompile(`(?i)\b(INSERT|UPDATE|DELETE|REPLACE)\b`).MatchString(s) {
			return nil, errors.New("查询只能读取数据")
		}
	}
	return out, nil
}
func queryMaps(ctx context.Context, db sqlRunner, q string, args ...any) ([]map[string]any, error) {
	rows, e := db.QueryContext(ctx, q, args...)
	if e != nil {
		return nil, e
	}
	defer rows.Close()
	cols, e := rows.Columns()
	if e != nil {
		return nil, e
	}
	out := []map[string]any{}
	for rows.Next() {
		vals := make([]any, len(cols))
		ptr := make([]any, len(cols))
		for i := range vals {
			ptr[i] = &vals[i]
		}
		if e = rows.Scan(ptr...); e != nil {
			return nil, e
		}
		m := map[string]any{}
		for i, k := range cols {
			if b, ok := vals[i].([]byte); ok {
				m[k] = string(b)
			} else {
				m[k] = vals[i]
			}
		}
		out = append(out, m)
		if len(out) > 100 {
			break
		}
	}
	return out, rows.Err()
}
func execSQL(ctx context.Context, db sqlRunner, raw, mode string, args []any) ([]map[string]any, error) {
	ss, e := sqlStatements(raw, mode)
	if e != nil {
		return nil, e
	}
	if len(args) > 0 && len(ss) != 1 {
		return nil, errors.New("参数数组仅支持单条SQL")
	}
	out := []map[string]any{}
	for _, s := range ss {
		if regexp.MustCompile(`(?i)^(SELECT|WITH)\b`).MatchString(s) {
			out, e = queryMaps(ctx, db, s, args...)
		} else {
			_, e = db.ExecContext(ctx, s, args...)
		}
		if e != nil {
			return out, e
		}
	}
	return out, nil
}
func runChecks(ctx context.Context, db *sql.DB, checks []map[string]any) ([]map[string]any, error) {
	if len(checks) > 30 {
		return nil, errors.New("验收最多30项")
	}
	out := []map[string]any{}
	for i, c := range checks {
		expectValue, expectExists := c["expectError"]
		if !expectExists {
			expectValue, expectExists = c["expect_error"]
		}
		if expectExists {
			v := expectValue
			if _, valid := v.(bool); !valid {
				return nil, errors.New("expectError必须为布尔值")
			}
		}
		if v, ok := c["expectedRows"]; ok {
			n := number(v)
			numeric := false
			switch v.(type) {
			case float64, float32, int, int32, int64, json.Number:
				numeric = true
			}
			if !numeric || math.IsNaN(n) || math.IsInf(n, 0) || n < 0 || n > 100 || n != float64(int(n)) {
				return nil, errors.New("expectedRows须为0至100整数")
			}
		}
		if v, ok := c["params"]; ok {
			switch v.(type) {
			case []any, []string:
			default:
				return nil, errors.New("SQL参数params必须是数组")
			}
		}
		if v, ok := c["name"]; ok {
			title, valid := v.(string)
			if !valid || strings.TrimSpace(title) == "" || len([]rune(title)) > 160 {
				return nil, errors.New("数据库验收用例名称须为1至160字文本")
			}
		}
		if _, ok := c["sql"].(string); !ok {
			return nil, errors.New("验收SQL必须为文本")
		}
		if v, ok := c["setupSql"]; ok {
			if _, ok := v.(string); !ok {
				return nil, errors.New("样本准备SQL必须为文本")
			}
		}
		title := str(c["name"])
		if title == "" {
			title = fmt.Sprintf("测试%d", i+1)
		}
		tx, e := db.BeginTx(ctx, nil)
		if e != nil {
			return nil, e
		}
		phase := "setup"
		var rows []map[string]any
		if s := str(c["setupSql"]); s != "" {
			_, e = execSQL(ctx, tx, s, "test", nil)
		}
		if e == nil {
			phase = "test"
			params, _ := c["params"].([]any)
			if xs, ok := c["params"].([]string); ok {
				for _, x := range xs {
					params = append(params, x)
				}
			}
			rows, e = execSQL(ctx, tx, str(c["sql"]), "test", params)
		}
		_ = tx.Rollback()
		constraint := false
		var sqe *sqlite.Error
		if errors.As(e, &sqe) && sqe.Code()&255 == 19 && phase == "test" {
			constraint = true
		}
		expect := expectValue == true
		passed := e == nil
		if expect {
			passed = constraint
		}
		if expected, ok := c["expectedRows"]; ok && e == nil {
			passed = passed && len(rows) == int(number(expected))
		}
		reason := "符合本条SQL验收合同"
		if !passed {
			reason = "SQL未符合验收合同"
			if e != nil {
				reason = e.Error()
			}
		} else if expect {
			reason = "已按预期拒绝违反约束的数据"
		}
		entry := map[string]any{"name": title, "sql": c["sql"], "setupSql": c["setupSql"], "passed": passed, "expectedError": expect, "constraintError": constraint, "rows": rows, "reason": reason}
		if e != nil {
			entry["error"] = e.Error()
			entry["errorPhase"] = phase
		}
		out = append(out, entry)
	}
	return out, nil
}
func declaredChecks(v any) ([]map[string]any, error) {
	checks, err := strictMaps(v, "数据库验收合同")
	if err != nil {
		return nil, err
	}
	if v == nil {
		return checks, nil
	}
	if len(checks) < 1 || len(checks) > 30 {
		return nil, errors.New("databaseChecks需要1至30项显式SQL合同")
	}
	for _, c := range checks {
		title, ok := c["name"].(string)
		if !ok || strings.TrimSpace(title) == "" || len([]rune(title)) > 160 {
			return nil, errors.New("原始数据库合同须有1至160字明确名称")
		}
	}
	return checks, nil
}
func quoteIdent(s string) string { return `"` + strings.ReplaceAll(s, `"`, `""`) + `"` }
func (t *Toolbox) database(ctx context.Context, name string, a map[string]any) (map[string]any, []string, error) {
	ctx, cancel := context.WithTimeout(ctx, 35*time.Second)
	defer cancel()
	switch name {
	case "design_database":
		ddl := str(a["ddl"])
		ss, e := sqlStatements(ddl, "design")
		if e != nil {
			return nil, nil, e
		}
		db, e := openDB(":memory:")
		if e != nil {
			return nil, nil, e
		}
		defer db.Close()
		for _, s := range ss {
			if _, e = db.ExecContext(ctx, s); e != nil {
				return nil, nil, e
			}
		}
		tables, e := queryMaps(ctx, db, "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")
		if e != nil || len(tables) == 0 {
			return nil, nil, errors.New("DDL没有建立业务表")
		}
		checks, err := declaredChecks(t.config.Input["databaseChecks"])
		if err != nil {
			return nil, nil, err
		}
		var contract any
		files := []string{"database/schema.sql", "database/design.json"}
		if t.config.Input["databaseChecks"] != nil {
			if len(checks) == 0 {
				return nil, nil, errors.New("databaseChecks需要1至30项")
			}
			results, e := runChecks(ctx, db, checks)
			if e != nil {
				return nil, nil, e
			}
			for _, r := range results {
				if r["passed"] != true {
					return nil, nil, fmt.Errorf("DDL未通过实际SQL验收：%s：%s。请修正DDL，NOT NULL和CHECK须实际落库", r["name"], r["reason"])
				}
			}
			contract = map[string]any{"passed": true, "tests": results, "allChangesRolledBack": true, "testCount": len(results)}
			_ = t.put("database/design-checks.json", contract)
			files = append(files, "database/design-checks.json")
		}
		schema := map[string]any{}
		names := []string{}
		for _, tb := range tables {
			n := str(tb["name"])
			names = append(names, n)
			rr, e := queryMaps(ctx, db, "PRAGMA table_info("+quoteIdent(n)+")")
			if e != nil {
				return nil, nil, e
			}
			schema[n] = rr
		}
		ev := map[string]any{"tables": names, "schema": schema, "description": a["description"], "assumptions": a["assumptions"], "sourceRequirements": t.config.Input["requirements"], "designChecks": contract}
		_ = t.put("database/schema.sql", ddl)
		_ = t.put("database/design.json", ev)
		return receipt(fmt.Sprintf("DDL已在真实内存SQLite验证，包含%d个业务表", len(tables)), ev), files, nil
	case "build_database":
		p, e := t.safe("database/schema.sql")
		if e != nil {
			return nil, nil, e
		}
		b, e := os.ReadFile(p)
		if e != nil {
			return nil, nil, errors.New("请先设计并验证DDL")
		}
		target, e := t.safe("database/company.sqlite")
		if e != nil {
			return nil, nil, e
		}
		_ = os.Remove(target)
		db, e := openDB(target)
		if e != nil {
			return nil, nil, e
		}
		success := false
		defer func() {
			db.Close()
			if !success {
				os.Remove(target)
			}
		}()
		ss, e := sqlStatements(string(b), "design")
		if e != nil {
			return nil, nil, e
		}
		for _, s := range ss {
			if _, e = db.ExecContext(ctx, s); e != nil {
				return nil, nil, e
			}
		}
		tx, e := db.BeginTx(ctx, nil)
		if e != nil {
			return nil, nil, e
		}
		defer tx.Rollback()
		_, _ = tx.ExecContext(ctx, "PRAGMA defer_foreign_keys=ON")
		raw, e := source(t.config.Input["data"])
		if e != nil {
			return nil, nil, e
		}
		imported := 0
		var data map[string]any
		var array []map[string]any
		isArray := false
		switch raw.(type) {
		case []any, []map[string]any:
			isArray = true
			array, e = strictMaps(raw, "数据库导入资料")
			if e != nil {
				return nil, nil, e
			}
		}
		if isArray && len(array) > 0 {
			table := str(a["table"])
			if table == "" {
				tabs, e := queryMaps(ctx, tx, "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")
				if e != nil || len(tabs) != 1 {
					return nil, nil, errors.New("多表导入数组时必须指定table")
				}
				table = str(tabs[0]["name"])
			}
			data = map[string]any{table: array}
		} else {
			data, _ = raw.(map[string]any)
			if raw != nil && raw != "" && !isArray && data == nil {
				return nil, nil, errors.New("数据库资料须为JSON表名映射或CSV行数组")
			}
		}
		for table, value := range data {
			switch value.(type) {
			case []any, []map[string]any:
			default:
				return nil, nil, errors.New("表 " + table + " 的资料必须是行对象数组，不能为null或文本")
			}
			cols, e := queryMaps(ctx, tx, "PRAGMA table_info("+quoteIdent(table)+")")
			if e != nil || len(cols) == 0 {
				return nil, nil, errors.New("不存在的导入表：" + table)
			}
			allowed := map[string]bool{}
			for _, c := range cols {
				allowed[str(c["name"])] = true
			}
			rows, err := strictMaps(value, "导入表 "+table)
			if err != nil {
				return nil, nil, err
			}
			for _, row := range rows {
				keys := []string{}
				for k := range row {
					if !allowed[k] {
						return nil, nil, errors.New("导入字段不存在：" + k)
					}
					keys = append(keys, k)
				}
				sort.Strings(keys)
				if len(keys) == 0 {
					return nil, nil, errors.New("导入行不能为空")
				}
				ids, params, values := []string{}, []string{}, []any{}
				for _, k := range keys {
					ids = append(ids, quoteIdent(k))
					params = append(params, "?")
					v := row[k]
					if n, ok := v.(interface{ String() string }); ok {
						v = n.String()
					}
					values = append(values, v)
				}
				if _, e = tx.ExecContext(ctx, "INSERT INTO "+quoteIdent(table)+" ("+strings.Join(ids, ",")+") VALUES ("+strings.Join(params, ",")+")", values...); e != nil {
					return nil, nil, e
				}
				imported++
			}
		}
		sample := str(a["sampleSql"])
		if sample != "" {
			if imported > 0 {
				return nil, nil, errors.New("有用户数据时不能混入验证样本")
			}
			if _, e = execSQL(ctx, tx, sample, "insert", nil); e != nil {
				return nil, nil, e
			}
		}
		if e = tx.Commit(); e != nil {
			return nil, nil, e
		}
		counts := map[string]int{}
		tabs, _ := queryMaps(ctx, db, "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")
		for _, tb := range tabs {
			n := str(tb["name"])
			var count int
			_ = db.QueryRowContext(ctx, "SELECT COUNT(*) FROM "+quoteIdent(n)).Scan(&count)
			counts[n] = count
		}
		example := sample != "" || t.config.Input["isExample"] == true || t.config.Input["example"] == true
		business := imported
		if example {
			business = 0
		}
		ev := map[string]any{"tables": counts, "importedRows": imported, "importedBusinessRows": business, "validationSamplesOnly": example, "foreignKeysEnabled": true, "foreignKeysValidatedAtCommit": true}
		totalRows := 0
		for _, n := range counts {
			totalRows += n
		}
		sampleRows := 0
		if example {
			sampleRows = totalRows
		}
		sampleSource := "empty"
		if sample != "" {
			sampleSource = "sample_sql"
		} else if example && imported > 0 {
			sampleSource = "explicit_example_input"
		} else if imported > 0 {
			sampleSource = "user_upload"
		}
		ev["persistedRows"] = totalRows
		ev["validationSampleRows"] = sampleRows
		ev["sampleSource"] = sampleSource
		ev["emptyDatabase"] = totalRows == 0
		ev["rollbackScope"] = "build_database数据已提交并保留；后续test_database仅回滚各用例临时变更，不会清空建库时保留的数据。"
		_ = t.put("database/build.json", ev)
		success = true
		_ = os.Chmod(target, 0600)
		return receipt(fmt.Sprintf("真实建立SQLite，用户业务记录%d条，保留验证样本%d条，现存总计%d条；后续用例回滚不清除建库样本", business, sampleRows, totalRows), ev), []string{"database/company.sqlite", "database/build.json"}, nil
	case "test_database":
		p, e := t.safe("database/company.sqlite")
		if e != nil {
			return nil, nil, e
		}
		if _, e = os.Stat(p); e != nil {
			return nil, nil, errors.New("请先建库")
		}
		db, e := openDB(p)
		if e != nil {
			return nil, nil, e
		}
		defer db.Close()
		checks, err := declaredChecks(t.config.Input["databaseChecks"])
		if err != nil {
			return nil, nil, err
		}
		tests := maps(a["tests"])
		contractOnly := t.config.Input["databaseTestMode"] == "contract-only"
		queries := stringsOf(a["queries"])
		if contractOnly && (len(tests) > 0 || len(queries) > 1 || len(checks) == 0) {
			return nil, nil, errors.New("合同验收只接受tests:[]和至多一条查询")
		}
		tr, e := runChecks(ctx, db, tests)
		if e != nil {
			return nil, nil, e
		}
		cr, e := runChecks(ctx, db, checks)
		if e != nil {
			return nil, nil, e
		}
		var integrity string
		_ = db.QueryRowContext(ctx, "PRAGMA integrity_check").Scan(&integrity)
		fk, e := queryMaps(ctx, db, "PRAGMA foreign_key_check")
		if e != nil {
			return nil, nil, e
		}
		schema, e := queryMaps(ctx, db, "SELECT type,name,tbl_name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name")
		if e != nil {
			return nil, nil, e
		}
		qr := []map[string]any{}
		for _, q := range queries {
			ss, e := sqlStatements(q, "select")
			if e != nil {
				return nil, nil, e
			}
			if contractOnly && len(ss) > 1 {
				return nil, nil, errors.New("合同验收模式最多一条SELECT，不接受拼接多条SQL")
			}
			for _, statement := range ss {
				rows, e := queryMaps(ctx, db, statement)
				if e != nil {
					return nil, nil, e
				}
				qr = append(qr, map[string]any{"sql": statement, "rows": rows[:min(100, len(rows))], "truncated": len(rows) > 100})
			}
		}
		passed := integrity == "ok" && len(fk) == 0
		for _, r := range append(tr, cr...) {
			passed = passed && r["passed"] == true
		}
		ev := map[string]any{"passed": passed, "integrity": integrity, "foreignKeyViolations": fk, "schema": schema, "tests": tr, "contractTests": cr, "queries": qr, "allChangesRolledBack": true, "testCoverage": "仅限实际执行的SQL合同、结构和完整性，不代表全部业务验收"}
		_ = t.put("database/tests.json", ev)
		return receipt(fmt.Sprintf("实际执行%d项回滚用例，通过：%t", len(tr)+len(cr), passed), ev), []string{"database/tests.json"}, nil
	}
	return nil, nil, errors.New("数据库工具无效")
}
