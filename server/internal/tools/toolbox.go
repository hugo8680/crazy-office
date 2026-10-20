// Package tools implements allowlisted office work against isolated files and databases.
package tools

import (
	"archive/zip"
	"bytes"
	"context"
	"crazyoffice/server/internal/model"
	"crazyoffice/server/internal/report"
	"crypto/sha256"
	_ "embed"
	"encoding/base64"
	"encoding/csv"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"github.com/xuri/excelize/v2"
	"io"
	"mime"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
	"unicode/utf8"
)

//go:embed definitions.json
var definitionsJSON []byte

//go:embed permissions.json
var permissionsJSON []byte
var definitions []model.Definition
var permissions map[string][]string

func init() {
	if e := json.Unmarshal(definitionsJSON, &definitions); e != nil {
		panic(e)
	}
	if e := json.Unmarshal(permissionsJSON, &permissions); e != nil {
		panic(e)
	}
}
func Definitions() []model.Definition { return append([]model.Definition{}, definitions...) }

type Artifact struct {
	ID       string `json:"id"`
	Name     string `json:"name"`
	MimeType string `json:"mimeType"`
	Path     string `json:"path,omitempty"`
	Bytes    int64  `json:"bytes"`
}
type Event struct {
	Type     string    `json:"type"`
	Text     string    `json:"text"`
	Tool     string    `json:"tool,omitempty"`
	Artifact *Artifact `json:"artifact,omitempty"`
	Data     any       `json:"data,omitempty"`
}
type Config struct {
	RunDir   string
	Input    map[string]any
	Emit     func(Event)
	Approval func(context.Context, map[string]any) (map[string]any, error)
	Fetch    func(context.Context, string) (Page, error)
}
type Toolbox struct {
	config     Config
	mu         sync.Mutex
	stateMu    sync.RWMutex
	registry   map[string]Artifact
	outputs    map[string]any
	serial     int
	quotes     []map[string]any
	onboarding map[string]any
}

func New(c Config) (*Toolbox, error) {
	p, e := filepath.Abs(c.RunDir)
	if e != nil {
		return nil, e
	}
	c.RunDir = p
	if e = os.MkdirAll(p, 0700); e != nil {
		return nil, e
	}
	if c.Input == nil {
		c.Input = map[string]any{}
	}
	if c.Emit == nil {
		c.Emit = func(Event) {}
	}
	if c.Fetch == nil {
		c.Fetch = PublicFetch
	}
	return &Toolbox{config: c, registry: map[string]Artifact{}, outputs: map[string]any{}, onboarding: map[string]any{}}, nil
}
func (t *Toolbox) Definitions() []model.Definition { return Definitions() }
func clone[T any](v T) T                           { raw, _ := json.Marshal(v); var c T; _ = json.Unmarshal(raw, &c); return c }
func (t *Toolbox) Artifacts() []Artifact {
	t.stateMu.RLock()
	defer t.stateMu.RUnlock()
	out := []Artifact{}
	for _, a := range t.registry {
		out = append(out, a)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Path < out[j].Path })
	return out
}
func (t *Toolbox) PublicState() map[string]any {
	t.stateMu.RLock()
	defer t.stateMu.RUnlock()
	return clone(map[string]any{"toolResults": t.outputs, "quoteCount": len(t.quotes), "artifactCount": len(t.registry)})
}
func (t *Toolbox) safe(name string) (string, error) {
	if filepath.IsAbs(name) || name == "" {
		return "", errors.New("产物路径必须为工作区内相对路径")
	}
	p := filepath.Join(t.config.RunDir, filepath.Clean(name))
	rel, e := filepath.Rel(t.config.RunDir, p)
	if e != nil || rel == ".." || strings.HasPrefix(rel, ".."+string(filepath.Separator)) {
		return "", errors.New("产物路径越界")
	}
	for parent := filepath.Dir(p); parent != t.config.RunDir && parent != filepath.Dir(parent); parent = filepath.Dir(parent) {
		if st, e := os.Lstat(parent); e == nil && st.Mode()&os.ModeSymlink != 0 {
			return "", errors.New("产物路径不能经过符号链接")
		}
	}
	if st, e := os.Lstat(p); e == nil && st.Mode()&os.ModeSymlink != 0 {
		return "", errors.New("产物不能是符号链接")
	}
	return p, nil
}
func (t *Toolbox) put(name string, v any) error {
	p, e := t.safe(name)
	if e != nil {
		return e
	}
	if e = os.MkdirAll(filepath.Dir(p), 0700); e != nil {
		return e
	}
	var b []byte
	switch s := v.(type) {
	case string:
		b = []byte(s)
	case []byte:
		b = s
	default:
		b, e = json.MarshalIndent(v, "", "  ")
		if e != nil {
			return e
		}
	}
	tmp := p + ".tmp"
	if e = os.WriteFile(tmp, b, 0600); e != nil {
		return e
	}
	return os.Rename(tmp, p)
}
func (t *Toolbox) read(name string, v any) error {
	p, e := t.safe(name)
	if e != nil {
		return e
	}
	b, e := os.ReadFile(p)
	if e != nil {
		return e
	}
	return json.Unmarshal(b, v)
}
func (t *Toolbox) register(name string) (Artifact, error) {
	p, e := t.safe(name)
	if e != nil {
		return Artifact{}, e
	}
	st, e := os.Stat(p)
	if e != nil {
		return Artifact{}, e
	}
	if !st.Mode().IsRegular() {
		return Artifact{}, errors.New("交付产物不是普通文件")
	}
	sum := sha256.Sum256([]byte(name))
	m := mime.TypeByExtension(filepath.Ext(name))
	if m == "" {
		switch filepath.Ext(name) {
		case ".sqlite":
			m = "application/vnd.sqlite3"
		case ".md":
			m = "text/markdown; charset=utf-8"
		default:
			m = "application/octet-stream"
		}
	}
	a := Artifact{ID: hex.EncodeToString(sum[:])[:18], Name: filepath.Base(name), Path: name, MimeType: m, Bytes: st.Size()}
	t.stateMu.Lock()
	t.registry[name] = a
	t.stateMu.Unlock()
	t.config.Emit(Event{Type: "artifact", Text: "生成文件：" + a.Name, Artifact: &a})
	return a, nil
}
func (t *Toolbox) Execute(ctx context.Context, name string, args map[string]any, role model.Role) (map[string]any, error) {
	if e := ctx.Err(); e != nil {
		return nil, e
	}
	valid := false
	for _, n := range permissions[role.ID] {
		if n == name {
			valid = true
		}
	}
	if !valid {
		return nil, fmt.Errorf("角色 %s 没有 %s 权限", role.ID, name)
	}
	if role.Tools != nil {
		found := false
		for _, n := range role.Tools {
			if n == name {
				found = true
			}
		}
		if !found {
			return nil, errors.New("该工具未获本次岗位授权")
		}
	}
	if args == nil {
		args = map[string]any{}
	}
	for _, definition := range definitions {
		if definition.Name == name {
			if err := validateSchema(args, definition.Parameters, "参数"); err != nil {
				return nil, err
			}
			break
		}
	}
	t.mu.Lock()
	defer t.mu.Unlock()
	t.config.Emit(Event{Type: "tool", Text: "执行 " + name, Tool: name})
	result, files, e := t.execute(ctx, name, args)
	if e != nil {
		return nil, e
	}
	registered := []Artifact{}
	for _, f := range unique(files) {
		a, e := t.register(f)
		if e != nil {
			return nil, e
		}
		a.Path = ""
		registered = append(registered, a)
	}
	result["artifacts"] = registered
	t.stateMu.Lock()
	if evidence, ok := result["evidence"]; ok {
		t.outputs[name] = evidence
	} else {
		t.outputs[name] = result
	}
	t.stateMu.Unlock()
	t.config.Emit(Event{Type: "result", Text: str(result["summary"]), Tool: name})
	return result, nil
}
func (t *Toolbox) execute(ctx context.Context, name string, a map[string]any) (map[string]any, []string, error) {
	switch name {
	case "import_finance", "calculate_finance", "audit_finance":
		return t.finance(ctx, name, a)
	case "inspect_network", "analyze_traffic", "apply_defense", "verify_network":
		return t.network(ctx, name, a)
	case "design_database", "build_database", "test_database":
		return t.database(ctx, name, a)
	case "extract_requirements", "estimate_delivery", "review_delivery":
		return t.delivery(ctx, name, a)
	case "search_web", "fetch_quote", "compare_quotes":
		return t.procurement(ctx, name, a)
	case "prepare_onboarding", "review_onboarding", "plan_onboarding_resources", "request_onboarding_approval", "register_onboarding":
		return t.hr(ctx, name, a)
	case "prepare_investment", "research_investment", "analyze_investment_financials", "review_investment", "build_investment_memo", "request_investment_review":
		return t.investment(ctx, name, a)
	case "write_report":
		title, content := strings.TrimSpace(str(a["title"])), strings.TrimSpace(str(a["content"]))
		if title == "" || len([]rune(content)) < 100 {
			return nil, nil, errors.New("报告需标题及至少100字实际正文")
		}
		if err := ValidateReport(content, t.PublicState()); err != nil {
			return nil, nil, err
		}
		t.serial++
		stem := fmt.Sprintf("reports/%s-%d", sanitize(title), t.serial)
		body := content
		if first, rest, ok := strings.Cut(content, "\n"); ok && strings.TrimSpace(first) == "# "+title {
			body = strings.TrimSpace(rest)
		}
		markdown := "# " + title + "\n\n" + body + "\n"
		if e := t.put(stem+".md", markdown); e != nil {
			return nil, nil, e
		}
		if e := t.put(stem+".html", ReportDocument(title, ReportHTML(body))); e != nil {
			return nil, nil, e
		}
		return receipt("正式报告已保存："+title, map[string]any{"title": title, "characters": len([]rune(content)), "sentExternally": false}), []string{stem + ".md", stem + ".html"}, nil
	case "list_artifacts":
		return receipt(fmt.Sprintf("本次已有%d个真实文件", len(t.Artifacts())), t.PublicState()), nil, nil
	}
	return nil, nil, errors.New("不允许的工具：" + name)
}
func receipt(summary string, evidence any) map[string]any {
	return map[string]any{"summary": summary, "evidence": evidence}
}
func asJSONString(v any) string { b, _ := json.Marshal(v); return string(b) }
func approvalActorKind(answer map[string]any) string {
	if answer["actorKind"] == "isolated_test_operator" {
		return "isolated_test_operator"
	}
	return "human"
}
func str(v any) string {
	if v == nil {
		return ""
	}
	if s, ok := v.(string); ok {
		return s
	}
	return fmt.Sprint(v)
}
func number(v any) float64 {
	switch x := v.(type) {
	case float64:
		return x
	case float32:
		return float64(x)
	case int:
		return float64(x)
	case int64:
		return float64(x)
	case json.Number:
		n, _ := x.Float64()
		return n
	case string:
		n, _ := strconv.ParseFloat(x, 64)
		return n
	}
	return 0
}
func stringsOf(v any) []string {
	out := []string{}
	switch x := v.(type) {
	case []any:
		for _, v := range x {
			out = append(out, str(v))
		}
	case []string:
		return x
	case string:
		for _, s := range strings.FieldsFunc(x, func(r rune) bool { return r == '\n' || r == '\r' }) {
			if strings.TrimSpace(s) != "" {
				out = append(out, strings.TrimSpace(s))
			}
		}
	}
	return out
}
func maps(v any) []map[string]any {
	out := []map[string]any{}
	switch x := v.(type) {
	case []any:
		for _, v := range x {
			if m, ok := v.(map[string]any); ok {
				out = append(out, m)
			}
		}
	case []map[string]any:
		return x
	}
	return out
}
func strictMaps(v any, label string) ([]map[string]any, error) {
	if v == nil || v == "" {
		return nil, nil
	}
	switch xs := v.(type) {
	case []map[string]any:
		return xs, nil
	case []any:
		out := make([]map[string]any, 0, len(xs))
		for i, row := range xs {
			m, ok := row.(map[string]any)
			if !ok {
				return nil, fmt.Errorf("%s第%d条必须是对象，未丢弃或导入损坏数据", label, i+1)
			}
			out = append(out, m)
		}
		return out, nil
	}
	return nil, fmt.Errorf("%s必须是行对象数组", label)
}
func originalText(v any) string {
	if v == nil {
		return ""
	}
	if s, ok := v.(string); ok {
		return s
	}
	if m, ok := v.(map[string]any); ok {
		if s, ok := m["text"].(string); ok {
			return s
		}
	}
	b, _ := json.Marshal(v)
	return string(b)
}
func unique(xs []string) []string {
	out := []string{}
	seen := map[string]bool{}
	for _, s := range xs {
		if !seen[s] {
			seen[s] = true
			out = append(out, s)
		}
	}
	return out
}
func sanitize(s string) string {
	s = regexp.MustCompile(`[^\pL\pN._-]+`).ReplaceAllString(s, "-")
	r := []rune(s)
	if len(r) > 80 {
		r = r[:80]
	}
	return string(r)
}
func now() string { return time.Now().UTC().Format(time.RFC3339Nano) }
func source(v any) (any, error) {
	filename := ""
	named := false
	if m, ok := v.(map[string]any); ok {
		if m["base64"] != nil || m["text"] != nil {
			named = true
			filename = str(m["name"])
			if filename == "" {
				filename = "input.json"
			}
			var raw []byte
			if val, exists := m["base64"]; exists {
				b, ok := val.(string)
				if !ok || len(b) > 14*1024*1024 || !regexp.MustCompile(`^[A-Za-z0-9+/]*={0,2}$`).MatchString(b) {
					return nil, errors.New("文件base64无效或过大")
				}
				var e error
				raw, e = base64.StdEncoding.Strict().DecodeString(b)
				if e != nil {
					return nil, errors.New("文件base64无效")
				}
			} else {
				txt, ok := m["text"].(string)
				if !ok {
					return nil, errors.New("文件正文必须为UTF-8文本")
				}
				raw = []byte(txt)
			}
			if len(raw) > 10*1024*1024 {
				return nil, errors.New("文件超过10MiB")
			}
			if strings.EqualFold(filepath.Ext(filename), ".xlsx") {
				z, e := zip.NewReader(bytes.NewReader(raw), int64(len(raw)))
				if e != nil {
					return nil, errors.New("XLSX压缩文件无效")
				}
				var expanded uint64
				if len(z.File) > 300 {
					return nil, errors.New("XLSX压缩内容超过300项")
				}
				for _, entry := range z.File {
					if entry.UncompressedSize64 > 30*1024*1024-expanded {
						return nil, errors.New("XLSX展开内容超过30MiB")
					}
					expanded += entry.UncompressedSize64
				}
				f, e := excelize.OpenReader(bytes.NewReader(raw), excelize.Options{UnzipSizeLimit: 30 * 1024 * 1024, UnzipXMLSizeLimit: 8 * 1024 * 1024})
				if e != nil {
					return nil, e
				}
				defer f.Close()
				sheets := f.GetSheetList()
				if len(sheets) == 0 {
					return nil, errors.New("XLSX没有工作表")
				}
				rows, e := f.GetRows(sheets[0], excelize.Options{RawCellValue: true})
				if e != nil {
					return nil, e
				}
				for i, row := range rows {
					for j := range row {
						cell, _ := excelize.CoordinatesToCellName(j+1, i+1)
						formula, _ := f.GetCellFormula(sheets[0], cell)
						if formula != "" {
							return nil, errors.New("不接受公式财务输入，请导出核实后的数值")
						}
					}
				}
				return rowsToMaps(rows)
			}
			if !utf8.Valid(raw) {
				return nil, errors.New("文本必须使用UTF-8编码")
			}
			v = string(raw)
		} else {
			return m, nil
		}
	}
	if s, ok := v.(string); ok {
		if len(s) > 10*1024*1024 {
			return nil, errors.New("文件超过10MiB")
		}
		if !utf8.ValidString(s) {
			return nil, errors.New("文本必须使用UTF-8编码")
		}
		s = strings.TrimPrefix(strings.TrimSpace(s), "\ufeff")
		ext := strings.ToLower(filepath.Ext(filename))
		isJSON := named && ext == ".json" || !named && (strings.HasPrefix(s, "[") || strings.HasPrefix(s, "{"))
		if isJSON {
			var out any
			d := json.NewDecoder(strings.NewReader(s))
			d.UseNumber()
			if e := d.Decode(&out); e != nil {
				return nil, e
			}
			var extra any
			if e := d.Decode(&extra); e != io.EOF {
				return nil, errors.New("JSON正文后存在多余或损坏内容")
			}
			return out, nil
		}
		isCSV := named && (ext == ".csv" || ext == ".tsv") || !named && strings.Contains(s, "\n") && strings.Contains(strings.SplitN(s, "\n", 2)[0], ",")
		if isCSV {
			reader := csv.NewReader(strings.NewReader(s))
			if ext == ".tsv" {
				reader.Comma = '\t'
			}
			rows, e := reader.ReadAll()
			if e != nil {
				return nil, e
			}
			return rowsToMaps(rows)
		}
		return s, nil
	}
	return v, nil
}
func rowsToMaps(rows [][]string) (any, error) {
	if len(rows) < 2 {
		return nil, errors.New("资料需要表头和数据行")
	}
	headers := rows[0]
	seen := map[string]bool{}
	for _, h := range headers {
		if strings.TrimSpace(h) == "" || seen[h] {
			return nil, errors.New("列名为空或重复")
		}
		seen[h] = true
	}
	out := []map[string]any{}
	for _, row := range rows[1:] {
		if len(row) > len(headers) {
			return nil, errors.New("数据列数超出表头")
		}
		m := map[string]any{}
		for i, h := range headers {
			if i < len(row) {
				m[h] = row[i]
			} else {
				m[h] = ""
			}
		}
		out = append(out, m)
	}
	return out, nil
}
func writeCSV(rows [][]any) string {
	var b strings.Builder
	b.WriteString("\ufeff")
	w := csv.NewWriter(&b)
	for _, row := range rows {
		r := []string{}
		for _, v := range row {
			s := str(v)
			if _, ok := v.(string); ok && regexp.MustCompile(`^[\s]*[=+\-@]|^[\t\r]`).MatchString(s) {
				s = "'" + s
			}
			r = append(r, s)
		}
		_ = w.Write(r)
	}
	w.Flush()
	return b.String()
}
func ReportDocument(title, body string) string { return report.Document(title, body) }
func ReportHTML(md string) string              { return report.Markdown(md) }
