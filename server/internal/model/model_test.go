package model

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

var testTools = []Definition{{Name: "calculate", Description: "真实计算", Parameters: map[string]any{"type": "object", "properties": map[string]any{}}}}

func TestParseResponse(t *testing.T) {
	tests := []struct {
		name, raw, action string
		fail              bool
	}{
		{"native", `{"choices":[{"finish_reason":"tool_calls","message":{"role":"assistant","tool_calls":[{"type":"function","function":{"name":"calculate","arguments":"{}"}}]}}],"model":"real"}`, "tool", false},
		{"finish", `{"choices":[{"finish_reason":"stop","message":{"role":"assistant","content":"已按真实回执计算"}}]}`, "finish", false},
		{"truncated", `{"choices":[{"finish_reason":"length","message":{"role":"assistant","content":"未完成"}}]}`, "", true},
		{"unauthorized", `{"choices":[{"finish_reason":"tool_calls","message":{"role":"assistant","tool_calls":[{"type":"function","function":{"name":"shell","arguments":"{}"}}]}}]}`, "", true},
		{"arrayargs", `{"choices":[{"finish_reason":"tool_calls","message":{"role":"assistant","tool_calls":[{"type":"function","function":{"name":"calculate","arguments":"[]"}}]}}]}`, "", true},
		{"badargs", `{"choices":[{"finish_reason":"tool_calls","message":{"role":"assistant","tool_calls":[{"type":"function","function":{"name":"calculate","arguments":"not JSON"}}]}}]}`, "", true},
		{"prototype", `{"choices":[{"finish_reason":"tool_calls","message":{"role":"assistant","tool_calls":[{"type":"function","function":{"name":"calculate","arguments":"{\"__proto__\":{}}"}}]}}]}`, "", true},
		{"multiple", `{"choices":[{"finish_reason":"tool_calls","message":{"role":"assistant","tool_calls":[{"type":"function","function":{"name":"calculate","arguments":"{}"}},{"type":"function","function":{"name":"calculate","arguments":"{}"}}]}}]}`, "", true},
		{"refusal", `{"choices":[{"finish_reason":"stop","message":{"role":"assistant","content":"拒绝","refusal":"policy"}}]}`, "", true},
		{"empty", `{"choices":[{"finish_reason":"stop","message":{"role":"assistant","content":""}}]}`, "", true},
		{"choices", `{"choices":[]}`, "", true},
		{"malformed", `abc`, "", true},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			d, e := ParseResponse([]byte(tt.raw), testTools, "configured")
			if (e != nil) != tt.fail {
				t.Fatalf("decision=%+v err=%v", d, e)
			}
			if !tt.fail && d.Action != tt.action {
				t.Fatal(d)
			}
		})
	}
}
func TestChatTranslatesPairedHistory(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer private-key" {
			t.Error("missing private key")
		}
		var p map[string]any
		_ = json.NewDecoder(r.Body).Decode(&p)
		messages := p["messages"].([]any)
		assistant := messages[2].(map[string]any)
		tool := messages[3].(map[string]any)
		if assistant["role"] != "assistant" || tool["role"] != "tool" || tool["tool_call_id"] == nil {
			t.Error(messages)
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"choices":[{"finish_reason":"stop","message":{"role":"assistant","content":"实际完成"}}],"usage":{"prompt_tokens":12}}`))
	}))
	defer server.Close()
	c := New(Config{Provider: "openai", Model: "test", URL: server.URL, APIKey: "private-key"})
	d, e := c.Decide(context.Background(), Request{Goal: "test", Tools: testTools, Messages: []Message{{Role: "assistant", Content: `{"action":"tool","tool":"calculate","args":{}}`}, {Role: "tool", Content: `{"summary":"实际工具回执"}`}}})
	if e != nil || d.Output != "实际完成" {
		t.Fatal(d, e)
	}
}
func TestHTTPFailureDoesNotLeakModelResponse(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(401)
		_, _ = w.Write([]byte(`credential: private-key`))
	}))
	defer server.Close()
	c := New(Config{Provider: "openai", Model: "test", URL: server.URL, APIKey: "private-key"})
	_, e := c.Decide(context.Background(), Request{Goal: "test"})
	if e == nil || strings.Contains(e.Error(), "private-key") {
		t.Fatal(e)
	}
}
func TestCancellation(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { <-r.Context().Done() }))
	defer server.Close()
	c := New(Config{Provider: "openai", URL: server.URL, Timeout: 30 * time.Millisecond})
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	_, e := c.Decide(ctx, Request{Goal: "test"})
	if e == nil {
		t.Fatal("cancelled request succeeded")
	}
}
func TestDashscopeRejectsUntrustedEndpoint(t *testing.T) {
	for _, u := range []string{"http://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions", "https://evil.invalid/compatible-mode/v1/chat/completions", "https://key@dashscope.aliyuncs.com/compatible-mode/v1/chat/completions", "https://dashscope.aliyuncs.com:443/compatible-mode/v1/chat/completions"} {
		c := New(Config{Provider: "dashscope", URL: u})
		if _, e := c.Decide(context.Background(), Request{}); e == nil {
			t.Fatalf("accepted %s", u)
		}
	}
}

func TestProviderStatusRequiresProbeAndPreservesFailure(t *testing.T) {
	var fail atomic.Bool
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if fail.Load() {
			w.WriteHeader(503)
			return
		}
		_, _ = w.Write([]byte(`{"choices":[{"finish_reason":"stop","message":{"role":"assistant","content":"连接成功"}}]}`))
	}))
	defer srv.Close()
	c := New(Config{Provider: "openai", Model: "test", URL: srv.URL, APIKey: "test-private"})
	initial, _ := c.Status(context.Background(), false)
	if initial.Ready {
		t.Fatal("unprobed key reported connected")
	}
	ok, e := c.Status(context.Background(), true)
	if e != nil || !ok.Ready {
		t.Fatal(ok, e)
	}
	fail.Store(true)
	bad, _ := c.Status(context.Background(), true)
	if bad.Ready {
		t.Fatal("failed probe ready")
	}
	cached, _ := c.Status(context.Background(), false)
	if cached.Ready || !strings.Contains(cached.Message, "503") {
		t.Fatal("lost failed probe", cached)
	}
}
func TestProviderDoesNotFollowRedirectWithCredentials(t *testing.T) {
	var leaked atomic.Bool
	target := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { leaked.Store(true); t.Error("followed model redirect") }))
	defer target.Close()
	source := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Location", target.URL)
		w.WriteHeader(302)
	}))
	defer source.Close()
	c := New(Config{Provider: "openai", Model: "test", URL: source.URL, APIKey: "private"})
	if _, e := c.Decide(context.Background(), Request{Goal: "test"}); e == nil {
		t.Fatal("redirect succeeded")
	}
	if leaked.Load() {
		t.Fatal("credentials followed redirect")
	}
}
func TestLocalProviderConfigAndEnvPrecedence(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("OFFICE_DATA_DIR", dir)
	t.Setenv("OFFICE_PROVIDER", "")
	t.Setenv("OFFICE_MODEL", "")
	if e := os.WriteFile(filepath.Join(dir, "provider.json"), []byte(`{"provider":"ollama","model":"existing-local-model","ollamaBase":"http://127.0.0.1:11434"}`), 0600); e != nil {
		t.Fatal(e)
	}
	p := NewFromEnv().(*Client)
	if p.Config.Provider != "ollama" || p.Config.Model != "existing-local-model" {
		t.Fatal(p.Config.Provider, p.Config.Model)
	}
	t.Setenv("OFFICE_PROVIDER", "dashscope")
	t.Setenv("OFFICE_MODEL", "explicit-model")
	p = NewFromEnv().(*Client)
	if p.Config.Provider != "dashscope" || p.Config.Model != "explicit-model" {
		t.Fatal(p.Config.Provider, p.Config.Model)
	}
	_ = os.WriteFile(filepath.Join(dir, "provider.json"), []byte(`{"provider":"ollama","apiKey":"should-not-be-saved"}`), 0600)
	p = NewFromEnv().(*Client)
	s, _ := p.Status(context.Background(), false)
	if s.Ready || !strings.Contains(s.Message, "不能保存密钥") {
		t.Fatal(s)
	}
}
func TestRejectsUnexpectedProviderURL(t *testing.T) {
	for _, u := range []string{"http://api.example.com/v1/chat/completions", "https://user:password@example.com/v1/chat/completions", "https://example.com/v1/chat/completions?key=hidden"} {
		c := New(Config{Provider: "openai", Model: "test", URL: u})
		if _, e := c.Decide(context.Background(), Request{Goal: "test"}); e == nil {
			t.Fatal(u)
		}
	}
	c := New(Config{Provider: "ollama", URL: "https://model.example.com/v1/chat/completions"})
	if _, e := c.Decide(context.Background(), Request{}); e == nil {
		t.Fatal("remote Ollama allowed")
	}
}
