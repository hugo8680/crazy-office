// verify-lab is an opt-in, real-model acceptance harness. Its sample approvals
// are explicitly test-operator actions; it never opens production data.
package main

import (
	"bufio"
	"context"
	"crazyoffice/server/internal/agent"
	"crazyoffice/server/internal/model"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

type M = map[string]any
type measuredProvider struct {
	model.Provider
	mu     sync.Mutex
	calls  int
	models map[string]int
	record *os.File
}

func (p *measuredProvider) Decide(ctx context.Context, r model.Request) (model.Decision, error) {
	started := time.Now()
	d, e := p.Provider.Decide(ctx, r)
	p.mu.Lock()
	defer p.mu.Unlock()
	p.calls++
	if d.Model != "" {
		p.models[d.Model]++
	}
	row := M{"startedAt": started.UTC().Format(time.RFC3339Nano), "durationSeconds": time.Since(started).Seconds(), "role": r.Role.ID, "decision": d, "success": e == nil, "request": r}
	if e != nil {
		row["error"] = e.Error()
	}
	raw, _ := json.Marshal(row)
	_, _ = p.record.Write(append(raw, '\n'))
	_ = p.record.Sync()
	return d, e
}
func emit(v any) { b, _ := json.Marshal(v); fmt.Println(string(b)) }
func write(path string, v any) error {
	b, e := json.MarshalIndent(v, "", "  ")
	if e != nil {
		return e
	}
	if e = os.WriteFile(path, append(b, '\n'), 0600); e != nil {
		return e
	}
	return os.Chmod(path, 0600)
}
func privateConfig(path string) error {
	f, e := os.Open(path)
	if e != nil {
		return errors.New("验收模型私有配置不可读取")
	}
	defer f.Close()
	scanner := bufio.NewScanner(f)
	scanner.Buffer(make([]byte, 4096), 65536)
	allowed := map[string]bool{"DASHSCOPE_API_KEY": true, "OFFICE_DASHSCOPE_URL": true, "OPENAI_API_KEY": true, "OFFICE_OPENAI_URL": true, "TOKENDANCE_API_KEY": true, "OFFICE_TOKENDANCE_URL": true, "OFFICE_MODEL": true, "OFFICE_MODEL_TIMEOUT_MS": true}
	provider := "dashscope"
	for scanner.Scan() {
		key, value, ok := strings.Cut(strings.TrimSpace(scanner.Text()), "=")
		if !ok || (!allowed[key] && key != "OFFICE_PROVIDER") {
			continue
		}
		value = strings.Trim(strings.TrimSpace(value), "\"'")
		if key == "OFFICE_PROVIDER" {
			if value != "dashscope" && value != "tokendance" && value != "openai" {
				return errors.New("验收私有配置中的模型服务无效")
			}
			provider = value
			continue
		}
		if e = os.Setenv(key, value); e != nil {
			return e
		}
	}
	if e = scanner.Err(); e != nil {
		return errors.New("私有配置格式无效")
	}
	return os.Setenv("OFFICE_PROVIDER", provider)
}
func object(v any) M { m, _ := v.(map[string]any); return m }
func objects(v any) []M {
	out := []M{}
	switch xs := v.(type) {
	case []M:
		return xs
	case []any:
		for _, v := range xs {
			if m, ok := v.(map[string]any); ok {
				out = append(out, m)
			}
		}
	}
	return out
}
func str(v any) string {
	if v == nil {
		return ""
	}
	return fmt.Sprint(v)
}
func read(path string) (M, error) {
	b, e := os.ReadFile(path)
	if e != nil {
		return nil, e
	}
	var m M
	e = json.Unmarshal(b, &m)
	return m, e
}
func resultEvidence(run M, tool string) M {
	var last M
	for _, t := range objects(run["tasks"]) {
		for _, r := range objects(t["toolResults"]) {
			if r["tool"] == tool {
				last = object(object(r["result"])["evidence"])
			}
		}
	}
	return last
}
func automaticChecks(sid string, run M) []M {
	out := []M{}
	check := func(name string, passed bool) { out = append(out, M{"name": name, "passed": passed}) }
	check("真实引擎完成", run["status"] == "completed")
	roles := map[string]bool{}
	calls := 0
	for _, t := range objects(run["tasks"]) {
		roles[str(t["agentId"])] = true
		if n, ok := t["toolCalls"].(float64); ok {
			calls += int(n)
		}
	}
	check("至少三种独立虚拟岗位及实际工具调用", len(roles) >= 3 && calls >= len(objects(run["tasks"])))
	check("实际登记产物", len(objects(run["artifacts"])) > 0)
	switch sid {
	case "finance":
		v := resultEvidence(run, "audit_finance")
		check("财务24月独立重算通过", v["passed"] == true && v["independentRecalculation"] == true && v["rowCount"] == float64(24))
	case "database":
		v := resultEvidence(run, "test_database")
		check("实际SQLite用例通过", v["passed"] == true && len(objects(v["tests"]))+len(objects(v["contractTests"])) > 0)
	case "ddos":
		v := resultEvidence(run, "verify_network")
		check("带真值日志隔离重放通过", v["verifiedRestored"] == true && v["unknownLabelRequests"] == float64(0))
	case "onboarding":
		v := resultEvidence(run, "register_onboarding")
		check("示例员工册实际写入", v["registered"] == true && v["isExample"] == true && v["externalAccountsCreated"] == false && v["equipmentAssigned"] == false)
	case "investment":
		v := resultEvidence(run, "build_investment_memo")
		check("未批准投资或付款", v["investmentAuthorized"] == false && v["paymentExecuted"] == false)
		check("保留虚构项目的尽调缺口", len(objects(resultEvidence(run, "review_investment")["findings"])) > 0 && v["recommendation"] != "continue_diligence")
	case "delivery":
		v := resultEvidence(run, "review_delivery")
		check("需求和计划来源核对", object(v["checks"])["sourceQuotesMatch"] == true && object(v["checks"])["coverageComplete"] == true)
		check("未冒充客户验收", v["customerApproved"] == false)
	case "procurement":
		v := resultEvidence(run, "fetch_quote")
		quotes := objects(v["quotes"])
		check("真实网络抓取留痕", len(quotes) > 0)
		priced := 0
		for _, q := range quotes {
			if q["status"] == "priced" {
				priced++
			}
		}
		out = append(out, M{"name": "有效整机价格正向样本", "passed": priced > 0, "informational": true, "pricedCount": priced, "note": "缺价处理可技术验收通过；不能据此声称正向报价验收通过"})
	}
	return out
}
func run() error {
	config := flag.String("private-config", ".office-data/dashscope-private.env", "private model settings; never printed")
	only := flag.String("scenarios", "finance,database,ddos,delivery,onboarding,investment,procurement", "comma-separated scenarios, run sequentially")
	receipt := flag.Bool("receipt-handoff", false, "finish single-tool tasks from actual tool receipts; default false exercises model handoff text")
	flag.Parse()
	if os.Getenv("OFFICE_REAL_LAB_ACCEPTANCE") != "1" {
		return errors.New("真实验收需显式设置 OFFICE_REAL_LAB_ACCEPTANCE=1；样例审批仅为隔离测试操作")
	}
	if e := privateConfig(*config); e != nil {
		return e
	}
	dir, e := os.MkdirTemp(".office-data", "legacy-real-acceptance-go-")
	if e != nil {
		return e
	}
	dir, _ = filepath.Abs(dir)
	_ = os.Chmod(dir, 0700)
	_ = os.Setenv("OFFICE_DATA_DIR", dir)
	callsFile, e := os.OpenFile(filepath.Join(dir, "model-calls.jsonl"), os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0600)
	if e != nil {
		return e
	}
	defer callsFile.Close()
	p := &measuredProvider{Provider: model.NewFromEnv(), models: map[string]int{}, record: callsFile}
	ctx, cancel := context.WithTimeout(context.Background(), 50*time.Minute)
	defer cancel()
	status, e := p.Status(ctx, true)
	if e != nil || !status.Ready {
		return fmt.Errorf("真实模型连接检查未通过：%s", status.Message)
	}
	engine, e := agent.New(agent.Config{DataDir: filepath.Join(dir, "runs"), Provider: p, ReceiptHandoff: *receipt, IsolatedAcceptance: true})
	if e != nil {
		return e
	}
	defer func() {
		c, stop := context.WithTimeout(context.Background(), 8*time.Second)
		defer stop()
		_ = engine.Shutdown(c)
	}()
	report := M{"startedAt": time.Now().UTC().Format(time.RFC3339Nano), "provider": status.Provider, "model": status.Model, "engine": "native-go", "fixtureModel": false, "isolation": "独立样例工作区；未访问生产数据；所有样例审批为验收脚本操作，不代表真实业务人类审批验收", "receiptHandoff": *receipt, "results": []M{}, "contentReview": "pending_independent_review"}
	results := []M{}
	emit(M{"event": "start", "directory": dir, "provider": status.Provider, "model": status.Model})
	for _, sid := range strings.Split(*only, ",") {
		sid = strings.TrimSpace(sid)
		example, e := read(filepath.Join("data", "examples", sid+".json"))
		if e != nil {
			return e
		}
		input := object(example["input"])
		if input["example"] != true && input["isExample"] != true {
			return errors.New("验收入口只接受明确标记的公开样例")
		}
		started := time.Now()
		created, e := engine.Create(ctx, M{"scenarioId": sid, "input": input})
		if e != nil {
			results = append(results, M{"scenario": sid, "createError": e.Error(), "technicalPassed": false, "contentReview": "not_started"})
			continue
		}
		id := str(created["id"])
		emit(M{"event": "scenario_started", "scenario": sid, "runId": id})
		stream, unsubscribe, e := engine.Subscribe(id)
		if e != nil {
			return e
		}
		timeout := time.NewTimer(9 * time.Minute)
		var final M
		approvals := []M{}
		lastProgress := ""
		finished := false
		for !finished {
			select {
			case state := <-stream:
				if state == nil {
					return errors.New("验收状态流关闭")
				}
				if state["status"] == "awaiting_approval" {
					approval := object(state["approval"])
					note := "隔离样例验收账号 local-acceptance-operator 的脚本操作；仅批准此样例工作区，不代表真实业务审批或录用/采购/投资授权。"
					if _, e = engine.Approve(id, M{"approvalId": approval["id"], "approved": true, "note": note}); e == nil {
						approvals = append(approvals, M{"approvalId": approval["id"], "kind": approval["kind"], "operator": "local-acceptance-operator", "operation": "scripted_isolated_acceptance", "approved": true, "note": note})
						emit(M{"event": "isolated_test_approval", "scenario": sid, "kind": approval["kind"]})
					}
				}
				progress := []string{}
				for _, task := range objects(state["tasks"]) {
					if task["status"] == "running" {
						progress = append(progress, str(task["id"]))
					}
				}
				key := str(state["status"]) + ":" + strings.Join(progress, ",")
				if key != lastProgress {
					emit(M{"event": "progress", "scenario": sid, "status": state["status"], "tasks": progress})
					lastProgress = key
				}
				if state["status"] == "completed" || state["status"] == "failed" || state["status"] == "cancelled" {
					final = state
					finished = true
				}
			case <-timeout.C:
				_, _ = engine.Cancel(id)
				final, _ = engine.Get(id)
				finished = true
			case <-ctx.Done():
				_, _ = engine.Cancel(id)
				return ctx.Err()
			}
		}
		timeout.Stop()
		unsubscribe()
		b, _ := json.Marshal(final)
		_ = json.Unmarshal(b, &final)
		checks := automaticChecks(sid, final)
		passed := true
		for _, c := range checks {
			if c["passed"] != true && c["informational"] != true {
				passed = false
			}
		}
		summary := M{"scenario": sid, "runId": id, "status": final["status"], "error": final["error"], "outcome": final["outcome"], "durationSeconds": time.Since(started).Seconds(), "approvals": approvals, "technicalPassed": passed, "checks": checks, "contentReview": "pending_independent_review"}
		results = append(results, summary)
		_ = write(filepath.Join(dir, sid+"-public-run.json"), final)
		report["results"] = results
		p.mu.Lock()
		report["modelCalls"] = p.calls
		report["actualModels"] = p.models
		p.mu.Unlock()
		report["updatedAt"] = time.Now().UTC().Format(time.RFC3339Nano)
		_ = write(filepath.Join(dir, "acceptance.json"), report)
		emit(M{"event": "scenario_finished", "scenario": sid, "runId": id, "status": final["status"], "technicalPassed": passed, "validationStatus": object(final["outcome"])["validationStatus"]})
	}
	report["finishedAt"] = time.Now().UTC().Format(time.RFC3339Nano)
	technical := true
	for _, r := range results {
		technical = technical && r["technicalPassed"] == true
	}
	report["technicalPassed"] = technical
	if e = write(filepath.Join(dir, "acceptance.json"), report); e != nil {
		return e
	}
	emit(M{"event": "finished", "directory": dir, "modelCalls": report["modelCalls"], "technicalPassed": technical, "contentReview": "pending_independent_review"})
	if !technical {
		return errors.New("至少一个场景未通过技术链路验收；证据已保存，内容复核另记")
	}
	return nil
}
func main() {
	if e := run(); e != nil {
		fmt.Fprintln(os.Stderr, e.Error())
		os.Exit(1)
	}
}
