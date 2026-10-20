package agent

import (
	"context"
	"crazyoffice/server/internal/model"
	"crazyoffice/server/internal/tools"
	"encoding/json"
	"errors"
	"fmt"
	"github.com/google/uuid"
	"math"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
)

type HTTPError struct {
	Status  int
	Message string
}

func (e *HTTPError) Error() string        { return e.Message }
func (e *HTTPError) StatusCode() int      { return e.Status }
func apiError(status int, s string) error { return &HTTPError{Status: status, Message: s} }

type Config struct {
	DataDir        string
	Provider       model.Provider
	ReceiptHandoff bool
	// IsolatedAcceptance labels programmatic approvals of explicit example inputs.
	// The production server never enables this flag.
	IsolatedAcceptance bool
	ToolboxFactory     func(tools.Config) (*tools.Toolbox, error)
}
type control struct {
	ctx      context.Context
	cancel   context.CancelFunc
	approval chan map[string]any
}
type Engine struct {
	mu          sync.RWMutex
	createMu    sync.Mutex
	config      Config
	runs        map[string]map[string]any
	controls    map[string]*control
	subscribers map[string]map[chan map[string]any]bool
	wg          sync.WaitGroup
	stopping    bool
}

func New(c Config) (*Engine, error) {
	if c.Provider == nil {
		c.Provider = model.NewFromEnv()
	}
	if c.ToolboxFactory == nil {
		c.ToolboxFactory = tools.New
	}
	dir, e := filepath.Abs(c.DataDir)
	if e != nil {
		return nil, e
	}
	c.DataDir = dir
	if e = os.MkdirAll(dir, 0700); e != nil {
		return nil, e
	}
	engine := &Engine{config: c, runs: map[string]map[string]any{}, controls: map[string]*control{}, subscribers: map[string]map[chan map[string]any]bool{}}
	entries, e := os.ReadDir(dir)
	if e != nil {
		return nil, e
	}
	for _, entry := range entries {
		if !entry.IsDir() || !safeID(entry.Name()) {
			continue
		}
		raw, e := os.ReadFile(filepath.Join(dir, entry.Name(), "run.json"))
		if e != nil {
			continue
		}
		var run map[string]any
		if json.Unmarshal(raw, &run) != nil || text(run["id"]) != entry.Name() {
			continue
		}
		if _, ok := scenarios[text(run["scenarioId"])]; !ok {
			continue
		}
		oldDir := text(run["runDir"])
		if oldDir != "" {
			for _, a := range objects(run["artifacts"]) {
				p := text(a["path"])
				if filepath.IsAbs(p) {
					if rel, err := filepath.Rel(oldDir, p); err == nil && rel != ".." && !strings.HasPrefix(rel, ".."+string(filepath.Separator)) {
						a["path"] = rel
					}
				}
			}
		}
		run["runDir"] = filepath.Join(dir, entry.Name())
		if active(text(run["status"])) {
			run["status"] = "failed"
			run["approval"] = nil
			run["error"] = "服务重启中断了任务。已保留输入与工具证据，可重新运行。"
			run["finishedAt"] = stamp()
			for _, t := range objects(run["tasks"]) {
				if text(t["status"]) == "pending" || text(t["status"]) == "running" {
					t["status"] = "failed"
					t["finishedAt"] = stamp()
				}
			}
		}
		engine.runs[entry.Name()] = run
		_ = engine.persistLocked(run)
	}
	return engine, nil
}
func safeID(id string) bool { return regexp.MustCompile(`^[a-zA-Z0-9_-]{1,120}$`).MatchString(id) }
func active(s string) bool  { return s == "queued" || s == "running" || s == "awaiting_approval" }
func stamp() string         { return time.Now().UTC().Format(time.RFC3339Nano) }
func text(v any) string {
	if v == nil {
		return ""
	}
	if s, ok := v.(string); ok {
		return s
	}
	return fmt.Sprint(v)
}
func objects(v any) []map[string]any {
	switch xs := v.(type) {
	case []map[string]any:
		return xs
	case []any:
		out := []map[string]any{}
		for _, x := range xs {
			if m, ok := x.(map[string]any); ok {
				out = append(out, m)
			}
		}
		return out
	}
	return nil
}
func stringsList(v any) []string {
	switch a := v.(type) {
	case []string:
		return a
	case []any:
		r := []string{}
		for _, v := range a {
			r = append(r, text(v))
		}
		return r
	case string:
		return strings.FieldsFunc(a, func(r rune) bool { return r == '\r' || r == '\n' })
	}
	return nil
}
func copyJSON[T any](v T) T {
	raw, _ := json.Marshal(v)
	var out T
	_ = json.Unmarshal(raw, &out)
	return out
}
func asJSON(v any) string { b, _ := json.Marshal(v); return string(b) }
func contains(xs []string, s string) bool {
	for _, v := range xs {
		if v == s {
			return true
		}
	}
	return false
}
func cleanError(err error) string {
	s := err.Error()
	s = regexp.MustCompile(`(?i)(?:sk-[A-Za-z0-9._-]+|Bearer\s+[A-Za-z0-9._-]+)`).ReplaceAllString(s, "[已隐藏凭据]")
	return clip(s, 1400)
}
func clip(s string, n int) string {
	r := []rune(s)
	if len(r) > n {
		return string(r[:n])
	}
	return s
}
func (e *Engine) persistLocked(run map[string]any) error {
	dir := text(run["runDir"])
	if dir == "" {
		return errors.New("任务工作区缺失")
	}
	b, err := json.MarshalIndent(run, "", "  ")
	if err != nil {
		return err
	}
	p := filepath.Join(dir, "run.json")
	tmp := p + ".tmp"
	if err = os.WriteFile(tmp, b, 0600); err != nil {
		return err
	}
	return os.Rename(tmp, p)
}
func (e *Engine) publicLocked(run map[string]any) map[string]any {
	visible := copyJSON(run)
	delete(visible, "input")
	delete(visible, "configs")
	delete(visible, "runDir")
	tasks := objects(run["tasks"])
	publicAgents := []map[string]any{}
	for _, a := range agentPublic {
		p := copyJSON(a)
		id := text(a["id"])
		selected := false
		status := "idle"
		var last, working map[string]any
		allDone := true
		for _, t := range tasks {
			if t["agentId"] != id {
				continue
			}
			selected = true
			allDone = allDone && t["status"] == "done"
			if t["startedAt"] != nil && text(t["startedAt"]) != "" {
				last = t
			}
			if t["status"] == "running" {
				working = t
			}
			if t["status"] == "failed" {
				status = "error"
			}
		}
		p["task"] = "待命"
		p["action"] = ""
		p["result"] = ""
		if selected && allDone {
			status = "done"
		}
		if working != nil {
			status = "working"
			last = working
		}
		if last != nil {
			p["nodeId"] = last["nodeId"]
			p["task"] = last["title"]
			p["action"] = last["action"]
			p["result"] = last["result"]
		}
		p["status"] = status
		p["selected"] = selected
		p["configured"] = true
		if configs, ok := run["configs"].(map[string]any); ok {
			if c, ok := configs[id].(map[string]any); ok {
				p["instructions"] = c["instructions"]
				p["tools"] = c["tools"]
			}
		}
		publicAgents = append(publicAgents, p)
	}
	visible["agents"] = publicAgents
	arts := []map[string]any{}
	for _, a := range objects(run["artifacts"]) {
		p := copyJSON(a)
		delete(p, "path")
		p["url"] = "/api/runs/" + text(run["id"]) + "/artifacts/" + text(a["id"])
		arts = append(arts, p)
	}
	visible["artifacts"] = arts
	created, _ := time.Parse(time.RFC3339Nano, text(run["createdAt"]))
	end := time.Now()
	if f := text(run["finishedAt"]); f != "" {
		if dt, er := time.Parse(time.RFC3339Nano, f); er == nil {
			end = dt
		}
	}
	visible["elapsedSeconds"] = max(0, int(end.Sub(created).Seconds()))
	visible["outcome"] = BuildOutcome(run)
	return visible
}
func (e *Engine) publishLocked(run map[string]any) {
	run["updatedAt"] = stamp()
	if err := e.persistLocked(run); err != nil {
		run["persistenceError"] = "任务记录写入失败，请检查存储"
	}
	state := e.publicLocked(run)
	for ch := range e.subscribers[text(run["id"])] {
		select {
		case ch <- copyJSON(state):
		default:
			select {
			case <-ch:
			default:
			}
			select {
			case ch <- copyJSON(state):
			default:
			}
		}
	}
}
func (e *Engine) eventLocked(run map[string]any, kind, s string, extra map[string]any) {
	ev := copyJSON(extra)
	if ev == nil {
		ev = map[string]any{}
	}
	ev["id"] = uuid.NewString()
	ev["createdAt"] = stamp()
	created, _ := time.Parse(time.RFC3339Nano, text(run["createdAt"]))
	ev["time"] = int(time.Since(created).Seconds())
	ev["type"] = kind
	ev["text"] = clip(s, 2200)
	if data, ok := ev["data"]; ok && len(asJSON(data)) > 12000 {
		ev["data"] = map[string]any{"summary": clip(asJSON(ModelEvidence(data, "", 0)), 10000)}
	}
	events := objects(run["events"])
	events = append(events, ev)
	if len(events) > 400 {
		events = events[len(events)-400:]
	}
	run["events"] = events
	e.publishLocked(run)
}
func (e *Engine) List() []map[string]any {
	e.mu.RLock()
	defer e.mu.RUnlock()
	out := []map[string]any{}
	for _, r := range e.runs {
		out = append(out, e.publicLocked(r))
	}
	sort.Slice(out, func(i, j int) bool { return text(out[i]["createdAt"]) > text(out[j]["createdAt"]) })
	if len(out) > 60 {
		out = out[:60]
	}
	return out
}
func (e *Engine) Get(id string) (map[string]any, error) {
	e.mu.RLock()
	defer e.mu.RUnlock()
	r := e.runs[id]
	if r == nil {
		return nil, apiError(404, "找不到这个任务")
	}
	return e.publicLocked(r), nil
}
func (e *Engine) Active() int {
	e.mu.RLock()
	defer e.mu.RUnlock()
	n := 0
	for _, r := range e.runs {
		if active(text(r["status"])) {
			n++
		}
	}
	return n
}
func (e *Engine) Subscribe(id string) (<-chan map[string]any, func(), error) {
	e.mu.Lock()
	defer e.mu.Unlock()
	r := e.runs[id]
	if r == nil {
		return nil, nil, apiError(404, "找不到这个任务")
	}
	ch := make(chan map[string]any, 1)
	if e.subscribers[id] == nil {
		e.subscribers[id] = map[chan map[string]any]bool{}
	}
	e.subscribers[id][ch] = true
	ch <- e.publicLocked(r)
	var once sync.Once
	cancel := func() { once.Do(func() { e.mu.Lock(); defer e.mu.Unlock(); delete(e.subscribers[id], ch); close(ch) }) }
	return ch, cancel, nil
}
func ValidateInput(scenarioID string, input map[string]any) error {
	s, ok := scenarios[scenarioID]
	if !ok {
		return apiError(400, "请选择支持的办公任务")
	}
	if input == nil {
		return apiError(400, "请填写任务输入")
	}
	for _, f := range s.Fields {
		v := input[text(f["name"])]
		if f["required"] == true && (v == nil || v == "") {
			return apiError(400, "请提供"+text(f["label"]))
		}
		if raw, ok := v.(string); ok && len(raw) > 4_000_000 {
			return apiError(400, "输入内容过长")
		}
		if f["type"] == "select" && v != nil && !contains(stringsList(f["options"]), text(v)) {
			return apiError(400, "选项无效："+text(f["label"]))
		}
		if v != nil && f["type"] == "number" {
			n, err := strconv.ParseFloat(text(v), 64)
			if err != nil || math.IsNaN(n) || math.IsInf(n, 0) || n < 0 {
				return apiError(400, "需要有效的非负数："+text(f["label"]))
			}
		}
	}
	if scenarioID == "onboarding" {
		if err := tools.ValidateOnboardingInput(input); err != nil {
			return apiError(400, err.Error())
		}
		if input["employmentConfirmed"] != true {
			return apiError(400, "请确认公司已完成录用决定")
		}
		if !regexp.MustCompile(`^[A-Za-z0-9_-]{1,40}$`).MatchString(text(input["employeeNumber"])) {
			return apiError(400, "工号格式无效")
		}
		if _, err := time.Parse("2006-01-02", text(input["startDate"])); err != nil {
			return apiError(400, "入职日期无效")
		}
	}
	if len(stringsList(input["urls"])) > 8 {
		return apiError(400, "最多8个候选链接")
	}
	for _, raw := range stringsList(input["urls"]) {
		u, err := url.Parse(strings.TrimSpace(raw))
		if err != nil || u.Hostname() == "" || u.User != nil || (u.Scheme != "https" && u.Scheme != "http") {
			return apiError(400, "候选链接须为不带凭据的完整HTTP(S)网址")
		}
	}
	if (scenarioID == "delivery" || scenarioID == "database") && len([]rune(text(input["requirements"]))) > 24000 {
		return apiError(400, "需求最多24000字，不会静默截断")
	}
	textFile := func(v any) (string, error) {
		if v == nil {
			return "", nil
		}
		if s, ok := v.(string); ok {
			return s, nil
		}
		if m, ok := v.(map[string]any); ok {
			if m["base64"] != nil {
				return "", apiError(400, "此资料仅接受TXT、JSON或CSV文本，不接受未解析二进制文件")
			}
			if s, ok := m["text"].(string); ok {
				return s, nil
			}
		}
		return "", apiError(400, "此资料必须是文本文件")
	}
	if scenarioID == "delivery" {
		supplement, err := textFile(input["data"])
		if err != nil {
			return err
		}
		if len([]rune(text(input["requirements"])))+len([]rune(supplement)) > 24000 {
			return apiError(400, "需求和补充资料合计最多24000字，不会静默截断")
		}
	}
	if scenarioID == "investment" {
		supplement, err := textFile(input["data"])
		if err != nil {
			return err
		}
		financial, err := textFile(input["financials"])
		if err != nil {
			return err
		}
		if len([]rune(text(input["projectName"])))+len([]rune(text(input["projectBrief"])))+len([]rune(supplement)) > 24000 {
			return apiError(400, "项目名称、简介与补充资料合计最多24000字，不会静默截断")
		}
		if len([]rune(financial)) > 240000 {
			return apiError(400, "财务文本最多240000字")
		}
	}
	if scenarioID == "finance" {
		year, err := strconv.Atoi(text(input["year"]))
		if err != nil || year < 1900 || year > 2200 {
			return apiError(400, "汇报年度无效")
		}
	}
	if input["budget"] != nil {
		n, _ := strconv.ParseFloat(text(input["budget"]), 64)
		if n <= 0 {
			return apiError(400, "预算须大于零")
		}
	}
	return nil
}
func (e *Engine) Create(ctx context.Context, args map[string]any) (map[string]any, error) {
	e.createMu.Lock()
	defer e.createMu.Unlock()
	sid := text(args["scenarioId"])
	input, ok := args["input"].(map[string]any)
	if !ok {
		return nil, apiError(400, "任务输入须为对象")
	}
	if err := ValidateInput(sid, input); err != nil {
		return nil, err
	}
	s := scenarios[sid]
	e.mu.RLock()
	stopping := e.stopping
	busy := false
	for _, r := range e.runs {
		busy = busy || active(text(r["status"]))
	}
	e.mu.RUnlock()
	if stopping {
		return nil, apiError(503, "服务正在停止")
	}
	if busy {
		return nil, apiError(409, "已有任务执行中，请先完成或取消")
	}
	configs := map[string]any{}
	for _, r := range agents {
		configs[r.ID] = map[string]any{"instructions": r.Instructions, "tools": append([]string{}, r.Tools...)}
	}
	for _, c := range objects(args["agentConfigs"]) {
		r := roleByID(text(c["id"]))
		if r.ID == "" {
			return nil, apiError(400, "员工身份无效")
		}
		config := configs[r.ID].(map[string]any)
		if v, ok := c["instructions"]; ok {
			ss, valid := v.(string)
			if !valid || strings.TrimSpace(ss) == "" || len([]rune(ss)) > 1800 {
				return nil, apiError(400, "岗位职责需1至1800字")
			}
			config["instructions"] = ss
		}
		if v, ok := c["tools"]; ok {
			for _, n := range stringsList(v) {
				if !contains(r.Tools, n) {
					return nil, apiError(400, "只能授权岗位已拥有的工具")
				}
			}
			config["tools"] = stringsList(v)
		}
	}
	for _, t := range s.Tasks {
		config := configs[t.AgentID].(map[string]any)
		for _, n := range t.RequiredTools {
			if !contains(stringsList(config["tools"]), n) {
				return nil, apiError(400, t.Title+"缺少工具授权："+n)
			}
		}
	}
	status, err := e.config.Provider.Status(ctx, false)
	if err == nil && !status.Ready {
		status, err = e.config.Provider.Status(ctx, true)
	}
	if err != nil {
		return nil, err
	}
	if !status.Ready {
		return nil, apiError(503, status.Message)
	}
	id := uuid.NewString()
	dir := filepath.Join(e.config.DataDir, id)
	if err = os.MkdirAll(dir, 0700); err != nil {
		return nil, err
	}
	tasks := []map[string]any{}
	for _, t := range s.Tasks {
		tasks = append(tasks, map[string]any{"id": t.ID, "title": t.Title, "agentId": t.AgentID, "nodeId": t.NodeID, "dependencies": t.Dependencies, "status": "pending", "action": "", "result": "", "output": "", "toolCalls": 0, "startedAt": nil, "finishedAt": nil})
	}
	nodes := map[string]any{}
	for _, n := range []string{"internet", "firewall", "core", "server", "storage", "ups", "access", "workstations", "meeting", "executive", "reception", "finance", "investment", "general_office"} {
		nodes[n] = map[string]any{"status": "online"}
	}
	run := map[string]any{"id": id, "scenarioId": sid, "title": s.Title, "status": "queued", "createdAt": stamp(), "updatedAt": stamp(), "provider": status.Provider, "model": status.Model, "inputSummary": "用户提供的任务输入", "input": copyJSON(input), "configs": configs, "runDir": dir, "tasks": tasks, "events": []map[string]any{}, "artifacts": []map[string]any{}, "approval": nil, "summary": "", "error": nil, "nodes": nodes, "source": "manual"}
	if input["example"] == true || input["isExample"] == true {
		run["inputSummary"] = "明确选择的示例输入"
	}
	if args["source"] == "automation" {
		run["source"] = "automation"
		run["automation"] = copyJSON(args["automation"])
		run["inputSummary"] = "自动派工：待审内部准备任务"
	}
	runCtx, cancel := context.WithCancel(context.Background())
	e.mu.Lock()
	if e.stopping {
		e.mu.Unlock()
		cancel()
		return nil, apiError(503, "服务正在停止")
	}
	e.runs[id] = run
	e.controls[id] = &control{ctx: runCtx, cancel: cancel}
	e.publishLocked(run)
	public := e.publicLocked(run)
	e.wg.Add(1)
	e.mu.Unlock()
	go func() {
		defer e.wg.Done()
		if err := e.execute(runCtx, id); err != nil {
			e.fail(id, err)
		}
	}()
	return public, nil
}
