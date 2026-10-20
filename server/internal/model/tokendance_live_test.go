package model

import (
	"bufio"
	"context"
	"encoding/json"
	"flag"
	"os"
	"strings"
	"testing"
	"time"
)

var tokenDancePrivateConfig = flag.String("tokendance-private-config", "", "0600 TokenDance config for explicitly opted-in real protocol acceptance")

// This acceptance test uses only fixed arithmetic and no company records. It
// must be explicitly opted into; normal CI never calls an external model.
func TestTokenDanceLiveNativeRoundTrip(t *testing.T) {
	if os.Getenv("OFFICE_REAL_TOKENDANCE_ACCEPTANCE") != "1" {
		t.Skip("real TokenDance protocol acceptance is opt-in")
	}
	if *tokenDancePrivateConfig == "" {
		t.Fatal("a private TokenDance config is required")
	}
	file, e := os.Open(*tokenDancePrivateConfig)
	if e != nil {
		t.Fatal("private model config is unreadable")
	}
	defer file.Close()
	info, e := file.Stat()
	if e != nil || info.Mode().Perm() != 0600 {
		t.Fatal("private model config must have mode 0600")
	}
	allowed := map[string]bool{"TOKENDANCE_API_KEY": true, "OFFICE_MODEL": true, "OFFICE_TOKENDANCE_URL": true, "OFFICE_MODEL_TIMEOUT_MS": true}
	scanner := bufio.NewScanner(file)
	for scanner.Scan() {
		key, value, ok := strings.Cut(strings.TrimSpace(scanner.Text()), "=")
		if ok && allowed[key] {
			t.Setenv(key, strings.Trim(strings.TrimSpace(value), "\"'"))
		}
	}
	if e = scanner.Err(); e != nil {
		t.Fatal("private model config is invalid")
	}
	t.Setenv("OFFICE_PROVIDER", "tokendance")
	t.Setenv("OFFICE_DATA_DIR", t.TempDir())
	provider := NewFromEnv()
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()
	started := time.Now()
	status, e := provider.Status(ctx, true)
	if e != nil || !status.Ready || status.Provider != "tokendance" || status.Model != "qwen3.7-plus" {
		t.Fatal("real TokenDance connection check failed")
	}
	request := Request{
		Role:  Role{ID: "protocol_check", Name: "验收计算员", Role: "计算", Instructions: "计算只能调用calculate。收到实际回执后交付回执中的数值，不重复调用。"},
		Goal:  "请调用calculate计算17加25；收到实际工具回执后只交付结果。",
		Tools: []Definition{{Name: "calculate", Description: "计算两个整数的和", Parameters: map[string]any{"type": "object", "properties": map[string]any{"a": map[string]any{"type": "integer"}, "b": map[string]any{"type": "integer"}}, "required": []string{"a", "b"}, "additionalProperties": false}}},
	}
	first, e := provider.Decide(ctx, request)
	if e != nil || first.Action != "tool" || first.Tool != "calculate" || first.Args["a"] != float64(17) || first.Args["b"] != float64(25) {
		t.Fatal("real model did not request the authorized native calculation tool")
	}
	actual := int(first.Args["a"].(float64)) + int(first.Args["b"].(float64))
	decisionJSON, _ := json.Marshal(first)
	receiptJSON, _ := json.Marshal(map[string]any{"total": actual, "success": true})
	request.Messages = []Message{{Role: "assistant", Content: string(decisionJSON)}, {Role: "tool", Content: string(receiptJSON)}}
	second, e := provider.Decide(ctx, request)
	if e != nil || second.Action != "finish" || !strings.Contains(second.Output, "42") {
		t.Fatal("real model did not finish from the actual native tool receipt")
	}
	t.Logf("provider=tokendance model=%s native_calls=1 actual_total=%d direct_no_proxy=true elapsed_seconds=%.2f", first.Model, actual, time.Since(started).Seconds())
}
