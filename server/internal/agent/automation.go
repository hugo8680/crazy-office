package agent

import (
	"context"
	_ "embed"
	"encoding/json"
	"errors"
	"fmt"
	"math/rand/v2"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

//go:embed company-templates.json
var companyTemplates []byte

type AutomationConfig struct {
	Engine      *Engine
	StateFile   string
	CompanyFile string
}
type Automation struct {
	mu                  sync.Mutex
	opMu                sync.Mutex
	config              AutomationConfig
	state               map[string]any
	wake                chan struct{}
	ctx                 context.Context
	cancel              context.CancelFunc
	wg                  sync.WaitGroup
	closed, dispatching bool
	generation          uint64
}

func NewAutomation(c AutomationConfig) (*Automation, error) {
	if c.Engine == nil {
		return nil, errors.New("自动派工需要任务引擎")
	}
	if c.StateFile == "" {
		c.StateFile = filepath.Join(c.Engine.config.DataDir, "automation.json")
	}
	ctx, cancel := context.WithCancel(context.Background())
	a := &Automation{config: c, state: map[string]any{"version": 1, "enabled": false, "minIntervalMinutes": 3, "maxIntervalMinutes": 5, "scenarioIds": []string{"database", "delivery", "procurement"}, "taskInputs": map[string]any{}, "nextRunAt": nil, "lastRunId": nil, "lastDispatchedAt": nil, "lastError": nil, "history": []map[string]any{}}, wake: make(chan struct{}, 1), ctx: ctx, cancel: cancel}
	if raw, e := os.ReadFile(c.StateFile); e == nil {
		var saved map[string]any
		if json.Unmarshal(raw, &saved) != nil {
			cancel()
			return nil, errors.New("自动派工配置JSON无效")
		}
		if e = a.validate(saved, true); e != nil {
			cancel()
			return nil, e
		}
		for k, v := range saved {
			a.state[k] = v
		}
	} else if !os.IsNotExist(e) {
		cancel()
		return nil, e
	}
	if a.state["enabled"] == true {
		a.state["nextRunAt"] = a.nextTime(a.state, 0)
		if e := a.persist(a.state); e != nil {
			cancel()
			return nil, e
		}
	} else {
		a.state["nextRunAt"] = nil
	}
	a.wg.Add(1)
	go a.loop()
	return a, nil
}
func (a *Automation) validate(p map[string]any, loading bool) error {
	allowed := map[string]bool{"enabled": true, "minIntervalMinutes": true, "maxIntervalMinutes": true, "scenarioIds": true, "taskInputs": true}
	for k, v := range p {
		if !loading && !allowed[k] {
			return apiError(400, "自动派工配置包含未知字段")
		}
		switch k {
		case "enabled":
			if _, ok := v.(bool); !ok {
				return apiError(400, "自动派工开关需要布尔值")
			}
		case "minIntervalMinutes", "maxIntervalMinutes":
			n := toNumber(v)
			if n < 1 || n > 60 || n != float64(int(n)) {
				return apiError(400, "随机间隔须为1至60整数分钟")
			}
		case "scenarioIds":
			switch v.(type) {
			case []any, []string:
			default:
				return apiError(400, "任务场景须为数组")
			}
			ids := stringsList(v)
			if len(ids) == 0 || len(ids) > len(scenarios) {
				return apiError(400, "请至少选择一个有效任务场景")
			}
			for _, id := range ids {
				if _, ok := scenarios[id]; !ok {
					return apiError(400, "任务场景无效")
				}
			}
		case "taskInputs":
			m, ok := v.(map[string]any)
			if !ok || len(asJSON(v)) > 8_000_000 {
				return apiError(400, "任务资料无效或过大")
			}
			for id := range m {
				if _, ok := scenarios[id]; !ok {
					return apiError(400, "任务资料含未知场景")
				}
				if value, ok := m[id].(map[string]any); !ok || value == nil {
					return apiError(400, "每个场景的任务资料必须是对象")
				}
			}
		}
	}
	minN, maxN := toNumber(a.state["minIntervalMinutes"]), toNumber(a.state["maxIntervalMinutes"])
	if p["minIntervalMinutes"] != nil {
		minN = toNumber(p["minIntervalMinutes"])
	}
	if p["maxIntervalMinutes"] != nil {
		maxN = toNumber(p["maxIntervalMinutes"])
	}
	if minN > maxN {
		return apiError(400, "最短间隔不能大于最长间隔")
	}
	return nil
}
func toNumber(v any) float64 {
	switch x := v.(type) {
	case float64:
		return x
	case int:
		return float64(x)
	}
	return 0
}
func (a *Automation) nextTime(s map[string]any, delay time.Duration) string {
	if delay == 0 {
		minN, maxN := int(toNumber(s["minIntervalMinutes"])), int(toNumber(s["maxIntervalMinutes"]))
		delay = time.Duration(minN+rand.IntN(maxN-minN+1)) * time.Minute
	}
	return time.Now().Add(delay).UTC().Format(time.RFC3339Nano)
}
func (a *Automation) persist(s map[string]any) error {
	if e := os.MkdirAll(filepath.Dir(a.config.StateFile), 0700); e != nil {
		return e
	}
	b, e := json.MarshalIndent(s, "", "  ")
	if e != nil {
		return e
	}
	tmp := a.config.StateFile + ".tmp"
	if e = os.WriteFile(tmp, b, 0600); e != nil {
		return e
	}
	return os.Rename(tmp, a.config.StateFile)
}
func (a *Automation) signal() {
	select {
	case a.wake <- struct{}{}:
	default:
	}
}
func (a *Automation) loop() {
	defer a.wg.Done()
	for {
		a.mu.Lock()
		enabled := a.state["enabled"] == true
		at := text(a.state["nextRunAt"])
		gen := a.generation
		a.mu.Unlock()
		delay := 24 * time.Hour
		if enabled {
			dt, e := time.Parse(time.RFC3339Nano, at)
			if e == nil {
				delay = max(time.Millisecond, time.Until(dt))
			}
		}
		timer := time.NewTimer(delay)
		select {
		case <-a.ctx.Done():
			timer.Stop()
			return
		case <-a.wake:
			timer.Stop()
			continue
		case <-timer.C:
			if enabled {
				_, _ = a.attempt(a.ctx, true, gen)
			}
		}
	}
}
func (a *Automation) profile() map[string]any {
	p := map[string]any{"name": "吉林云投莱森购数字科技有限公司", "source": "user-provided", "verifiedFacts": []any{}, "sources": []any{}, "updatedAt": nil}
	if a.config.CompanyFile != "" {
		if raw, e := os.ReadFile(a.config.CompanyFile); e == nil {
			var saved map[string]any
			if json.Unmarshal(raw, &saved) == nil {
				for _, k := range []string{"name", "source", "verifiedFacts", "sources", "updatedAt"} {
					if saved[k] != nil {
						p[k] = saved[k]
					}
				}
			}
		}
	}
	return p
}
func (a *Automation) taskInput(id string, s, profile map[string]any) (map[string]any, string, string, string) {
	inputs, _ := s["taskInputs"].(map[string]any)
	if input, ok := inputs[id].(map[string]any); ok {
		if input["example"] == true || input["isExample"] == true {
			return nil, "", "", "自动任务需要真实资料，示例请手动运行"
		}
		if e := ValidateInput(id, input); e != nil {
			return nil, "", "", e.Error()
		}
		return copyJSON(input), "provided-" + id, "真实员工提供的任务资料", ""
	}
	var templates map[string]map[string]any
	raw := strings.ReplaceAll(string(companyTemplates), "{{COMPANY_NAME}}", strings.ReplaceAll(text(profile["name"]), `"`, `\"`))
	if json.Unmarshal([]byte(raw), &templates) != nil {
		return nil, "", "", "内部模板无法读取"
	}
	if t := templates[id]; t != nil {
		input, _ := t["input"].(map[string]any)
		if e := ValidateInput(id, input); e != nil {
			return nil, "", "", e.Error()
		}
		return input, text(t["templateId"]), text(t["inputBasis"]), ""
	}
	reasons := map[string]string{"finance": "尚未提供公司真实财务数据。", "onboarding": "尚未提供已确认录用员工登记资料。", "investment": "尚未提供投资项目与尽调材料。", "ddos": "尚未提供访问日志与演练范围。"}
	return nil, "", "", reasons[id]
}
func runSummary(run map[string]any) any {
	if run == nil {
		return nil
	}
	return map[string]any{"id": run["id"], "title": run["title"], "status": run["status"], "scenarioId": run["scenarioId"], "createdAt": run["createdAt"]}
}
func (a *Automation) Status(ctx context.Context) (map[string]any, error) {
	a.mu.Lock()
	s := copyJSON(a.state)
	dispatching := a.dispatching
	a.mu.Unlock()
	runs := a.config.Engine.List()
	var activeRun, lastRun map[string]any
	for _, r := range runs {
		if active(text(r["status"])) {
			activeRun = r
		}
		if r["id"] == s["lastRunId"] {
			lastRun = r
		}
	}
	profile := a.profile()
	availability := []map[string]any{}
	available := false
	for _, id := range ScenarioIDs() {
		input, _, basis, reason := a.taskInput(id, s, profile)
		availability = append(availability, map[string]any{"id": id, "available": input != nil, "reason": reason, "inputBasis": basis})
		if input != nil && contains(stringsList(s["scenarioIds"]), id) {
			available = true
		}
	}
	provider, e := a.config.Engine.config.Provider.Status(ctx, false)
	if e != nil {
		return nil, e
	}
	status, pause := "scheduled", ""
	switch {
	case s["enabled"] != true:
		status = "disabled"
		if s["lastError"] != nil {
			status = "error"
			pause = text(s["lastError"])
		}
	case dispatching:
		status = "dispatching"
	case activeRun != nil:
		status = "waiting_task"
		pause = "已有任务执行中，完成后再派发。"
		if activeRun["status"] == "awaiting_approval" {
			status = "awaiting_approval"
			pause = "等待真实员工审批，暂停新任务。"
		} else if activeRun["id"] == s["lastRunId"] {
			status = "running"
		}
	case !provider.Ready:
		status = "waiting_model"
		pause = "模型尚未连接，恢复后再派发。"
	case !available:
		status = "waiting_task"
		pause = "所选场景缺少真实任务资料。"
	case s["lastError"] != nil:
		status = "error"
		pause = text(s["lastError"])
	}
	delete(s, "taskInputs")
	delete(s, "version")
	s["status"] = status
	s["pauseReason"] = pause
	s["companyName"] = profile["name"]
	s["companyProfile"] = profile
	s["scenarioAvailability"] = availability
	s["activeRun"] = runSummary(activeRun)
	s["lastRun"] = runSummary(lastRun)
	s["updatedAt"] = stamp()
	return s, nil
}
func (a *Automation) Update(ctx context.Context, p map[string]any) (map[string]any, error) {
	a.mu.Lock()
	if e := a.validate(p, false); e != nil {
		a.mu.Unlock()
		return nil, e
	}
	if p["enabled"] == false {
		a.generation++
		a.state["enabled"] = false
		a.state["nextRunAt"] = nil
		a.signal()
	}
	a.mu.Unlock()
	a.opMu.Lock()
	defer a.opMu.Unlock()
	a.mu.Lock()
	if a.closed {
		a.mu.Unlock()
		return nil, apiError(400, "自动派工已停止")
	}
	next := copyJSON(a.state)
	for k, v := range p {
		next[k] = copyJSON(v)
	}
	next["lastError"] = nil
	if next["enabled"] == true {
		next["nextRunAt"] = a.nextTime(next, 0)
	} else {
		next["nextRunAt"] = nil
	}
	if e := a.persist(next); e != nil {
		a.state["enabled"] = false
		a.state["nextRunAt"] = nil
		a.state["lastError"] = "配置保存失败，已停止后续派发"
		a.generation++
		a.mu.Unlock()
		a.signal()
		return nil, e
	}
	a.state = next
	a.generation++
	a.mu.Unlock()
	a.signal()
	return a.Status(ctx)
}
func (a *Automation) Dispatch(ctx context.Context) (map[string]any, error) {
	a.mu.Lock()
	gen := a.generation
	a.mu.Unlock()
	return a.attempt(ctx, false, gen)
}
func (a *Automation) attempt(ctx context.Context, scheduled bool, gen uint64) (map[string]any, error) {
	a.opMu.Lock()
	defer a.opMu.Unlock()
	a.mu.Lock()
	if a.closed || gen != a.generation || (scheduled && a.state["enabled"] != true) {
		a.mu.Unlock()
		status, _ := a.Status(ctx)
		return map[string]any{"automation": status, "run": nil, "skipped": true, "reason": "派工计划已停止或更新。"}, nil
	}
	a.dispatching = true
	s := copyJSON(a.state)
	a.mu.Unlock()
	var run map[string]any
	reason := ""
	if a.config.Engine.Active() > 0 {
		reason = "已有任务或审批进行中，未派发新任务。"
	} else {
		provider, e := a.config.Engine.config.Provider.Status(ctx, false)
		if e != nil || !provider.Ready {
			reason = "模型尚未连接，未派发任务。"
		} else {
			profile := a.profile()
			available := []map[string]any{}
			for _, id := range stringsList(s["scenarioIds"]) {
				input, template, basis, _ := a.taskInput(id, s, profile)
				if input != nil {
					available = append(available, map[string]any{"id": id, "input": input, "template": template, "basis": basis})
				}
			}
			if len(available) == 0 {
				reason = "所选场景缺少真实任务资料，未使用示例代替。"
			} else {
				selected := available[rand.IntN(len(available))]
				a.mu.Lock()
				valid := !a.closed && gen == a.generation && (!scheduled || a.state["enabled"] == true)
				a.mu.Unlock()
				if valid {
					r, e := a.config.Engine.Create(ctx, map[string]any{"scenarioId": selected["id"], "input": selected["input"], "source": "automation", "automation": map[string]any{"companyName": profile["name"], "templateId": selected["template"], "inputBasis": selected["basis"], "dispatchedAt": stamp()}})
					if e != nil {
						reason = cleanError(e)
					} else {
						run = r
					}
				} else {
					reason = "派工计划已停止或更新。"
				}
			}
		}
	}
	a.mu.Lock()
	a.dispatching = false
	if run != nil {
		a.state["lastRunId"] = run["id"]
		a.state["lastDispatchedAt"] = stamp()
		a.state["lastError"] = nil
		history := objects(a.state["history"])
		history = append(history, map[string]any{"runId": run["id"], "scenarioId": run["scenarioId"], "title": run["title"], "dispatchedAt": stamp()})
		if len(history) > 30 {
			history = history[len(history)-30:]
		}
		a.state["history"] = history
	}
	if a.state["enabled"] == true && gen == a.generation {
		delay := time.Duration(0)
		if reason != "" {
			delay = time.Minute
		}
		a.state["nextRunAt"] = a.nextTime(a.state, delay)
	}
	if e := a.persist(a.state); e != nil {
		a.state["enabled"] = false
		a.state["nextRunAt"] = nil
		a.state["lastError"] = "派工记录保存失败，已停止后续派发"
		a.generation++
	}
	a.mu.Unlock()
	a.signal()
	status, e := a.Status(ctx)
	result := map[string]any{"automation": status, "run": run, "skipped": run == nil}
	if reason != "" {
		result["reason"] = reason
	}
	return result, e
}
func (a *Automation) Shutdown(ctx context.Context) error {
	a.mu.Lock()
	a.closed = true
	a.generation++
	a.cancel()
	a.mu.Unlock()
	done := make(chan struct{})
	go func() { a.wg.Wait(); a.opMu.Lock(); a.opMu.Unlock(); close(done) }()
	select {
	case <-done:
		return nil
	case <-ctx.Done():
		return fmt.Errorf("自动派工停止等待：%w", ctx.Err())
	}
}

func (a *Automation) PublicStatus(ctx context.Context) (map[string]any, error) { return a.Status(ctx) }
