package main

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"crazyoffice/server/internal/erp"
	"crazyoffice/server/internal/erpflow"
	"crazyoffice/server/internal/identity"
	"crazyoffice/server/internal/model"
)

type isolatedProvider struct{}

func (isolatedProvider) Status(context.Context, bool) (model.Status, error) {
	return model.Status{Ready: true, Model: "isolated-script-logic"}, nil
}
func (isolatedProvider) Decide(_ context.Context, r model.Request) (model.Decision, error) {
	d := model.Decision{Action: "tool", Tool: "read_work_context", Args: M{}, Model: "isolated-script-logic"}
	if len(r.Messages) > 0 {
		d.Tool = "prepare_plan"
		d.Args = M{"summary": "已核对隔离测试资料，等待两名真实岗位审批。", "steps": []string{"提交两级审批", "批准后确认实际办理"}, "checks": []string{"按工具核对隔离台账"}, "missing": []string{}}
		if erpflow.Map(r.Context)["workflow"] == "purchase" {
			switch len(r.Messages) {
			case 2:
				d.Tool = "search_web"
				d.Args = M{"query": "测试报价"}
			case 4:
				d.Tool = "fetch_quote"
				d.Args = M{}
			}
		}
		if r.Role.ID == "liu" {
			d.Tool = "review_plan"
			delete(d.Args, "steps")
			d.Args["passed"] = true
		}
	}
	return d, nil
}

type isolatedQuotes struct{}

func (isolatedQuotes) Definitions() []model.Definition {
	return []model.Definition{{Name: "search_web"}, {Name: "fetch_quote"}}
}
func (isolatedQuotes) Execute(_ context.Context, name string, _ M, _ model.Role) (M, error) {
	if name == "fetch_quote" {
		return M{"evidence": M{"quotes": []M{}}}, nil
	}
	return M{"results": []M{}}, nil
}

func TestNativeAcceptanceScriptRunsAllIsolatedLedgerSteps(t *testing.T) {
	dir := t.TempDir()
	ids, e := identity.Open(filepath.Join(dir, "erp", "identities.json"), "isolated-admin")
	if e != nil {
		t.Fatal(e)
	}
	store, e := erp.Open(dir)
	if e != nil {
		t.Fatal(e)
	}
	defer store.Close()
	a := &acceptance{dir: dir, ids: ids, store: store, admin: ids.ResolveLegacy("isolated-admin"), model: "isolated-script-logic", checks: []M{}}
	if a.requester, e = a.employee("qa-requester", []string{"employee", "warehouse", "hr"}); e != nil {
		t.Fatal(e)
	}
	if a.first, e = a.employee("qa-reviewer", []string{"project_manager", "manager", "hr"}); e != nil {
		t.Fatal(e)
	}
	if a.second, e = a.employee("qa-controller", []string{"manager", "finance", "warehouse"}); e != nil {
		t.Fatal(e)
	}
	a.service, e = erpflow.New(store, ids, isolatedProvider{}, dir)
	if e != nil {
		t.Fatal(e)
	}
	defer a.service.Shutdown(context.Background())
	a.service.ToolboxFactory = func(string, M) (erpflow.Toolbox, error) { return isolatedQuotes{}, nil }
	a.project, e = a.command(a.admin, "project.create", M{"name": "隔离脚本测试", "customer": "测试客户", "ownerId": a.first.ID, "members": []string{a.requester.ID, a.first.ID, a.second.ID}})
	if e != nil {
		t.Fatal(e)
	}
	a.product, e = a.command(a.admin, "product.create", M{"sku": "TEST", "name": "服务器", "unit": "台", "priceCents": 1200000})
	if e != nil {
		t.Fatal(e)
	}
	if e = a.execute(); e != nil {
		t.Fatal(e)
	}
	raw, e := os.ReadFile(filepath.Join(dir, "acceptance.json"))
	if e != nil {
		t.Fatal(e)
	}
	var result M
	if e = json.Unmarshal(raw, &result); e != nil {
		t.Fatal(e)
	}
	if result["passed"] != true || len(erpflow.Rows(result["checks"])) != 9 {
		t.Fatal("acceptance summary incomplete")
	}
	taskCount, toolCount := 0, int64(0)
	for _, check := range erpflow.Rows(result["checks"]) {
		if check["status"] != "completed" {
			t.Fatal("business not completed")
		}
		for _, task := range erpflow.Rows(check["tasks"]) {
			taskCount++
			toolCount += erpflow.N(task["toolCalls"])
		}
	}
	if taskCount != 18 || toolCount != 38 {
		t.Fatalf("tasks=%d tools=%d", taskCount, toolCount)
	}
	info, _ := os.Stat(filepath.Join(dir, "acceptance.json"))
	if info.Mode().Perm() != 0600 {
		t.Fatal("acceptance is not private")
	}
}

func TestPrivateConfigReadsOnlyWhitelistedLiterals(t *testing.T) {
	t.Setenv("DASHSCOPE_API_KEY", "")
	t.Setenv("OFFICE_MODEL", "")
	t.Setenv("OFFICE_PROVIDER", "test")
	t.Setenv("UNTRUSTED_CONFIG_FIELD", "original")
	path := filepath.Join(t.TempDir(), "private.env")
	if e := os.WriteFile(path, []byte("DASHSCOPE_API_KEY='fixture-only-not-a-real-key'\nOFFICE_MODEL=\"fixture-model\"\nUNTRUSTED_CONFIG_FIELD=changed\nOFFICE_SESSION_SECRET=ignored\n"), 0600); e != nil {
		t.Fatal(e)
	}
	if e := privateConfig(path); e != nil {
		t.Fatal(e)
	}
	if os.Getenv("DASHSCOPE_API_KEY") != "fixture-only-not-a-real-key" || os.Getenv("OFFICE_MODEL") != "fixture-model" || os.Getenv("OFFICE_PROVIDER") != "dashscope" || os.Getenv("UNTRUSTED_CONFIG_FIELD") != "original" {
		t.Fatal("private config escaping/whitelist changed")
	}
}

func TestPrivateConfigSelectsTokenDanceWithoutChangingSessionSecrets(t *testing.T) {
	t.Setenv("TOKENDANCE_API_KEY", "")
	t.Setenv("OFFICE_MODEL", "")
	t.Setenv("OFFICE_TOKENDANCE_URL", "")
	t.Setenv("OFFICE_PROVIDER", "dashscope")
	t.Setenv("OFFICE_SESSION_SECRET", "unchanged")
	path := filepath.Join(t.TempDir(), "private.env")
	content := "OFFICE_PROVIDER=tokendance\nTOKENDANCE_API_KEY=fixture-not-real\nOFFICE_MODEL=qwen3.7-plus\nOFFICE_TOKENDANCE_URL=https://tokendance.space/gateway/v1/chat/completions\nOFFICE_SESSION_SECRET=must-not-load\n"
	if e := os.WriteFile(path, []byte(content), 0600); e != nil {
		t.Fatal(e)
	}
	if e := privateConfig(path); e != nil {
		t.Fatal(e)
	}
	if os.Getenv("OFFICE_PROVIDER") != "tokendance" || os.Getenv("TOKENDANCE_API_KEY") != "fixture-not-real" || os.Getenv("OFFICE_MODEL") != "qwen3.7-plus" || os.Getenv("OFFICE_SESSION_SECRET") != "unchanged" {
		t.Fatal("TokenDance private acceptance configuration did not remain isolated")
	}
	if strings.Contains(safe("failure fixture-not-real"), "fixture-not-real") {
		t.Fatal("acceptance output did not redact TokenDance key")
	}
	if e := os.WriteFile(path, []byte("OFFICE_PROVIDER=untrusted\n"), 0600); e != nil {
		t.Fatal(e)
	}
	if e := privateConfig(path); e == nil {
		t.Fatal("unknown model provider was accepted")
	}
}
