package model

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strings"
	"testing"
)

type tokenDanceTransport func(*http.Request) (*http.Response, error)

func (f tokenDanceTransport) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }

func TestTokenDanceConfigurationIsDistinctAndDirect(t *testing.T) {
	t.Setenv("OFFICE_DATA_DIR", t.TempDir())
	t.Setenv("OFFICE_PROVIDER", "tokendance")
	t.Setenv("OFFICE_MODEL", "")
	t.Setenv("OFFICE_TOKENDANCE_URL", "")
	t.Setenv("TOKENDANCE_API_KEY", "fixture-token-dance-not-a-real-key")
	c := NewFromEnv().(*Client)
	if c.Config.Provider != "tokendance" || c.Config.Model != "qwen3.7-plus" || c.Config.URL != "https://tokendance.space/gateway/v1/chat/completions" {
		t.Fatal("TokenDance environment was resolved as another service")
	}
	transport, ok := c.Config.Client.Transport.(*http.Transport)
	if !ok || transport.Proxy != nil {
		t.Fatal("TokenDance transport must connect directly without a proxy")
	}
	status, e := c.Status(context.Background(), false)
	if e != nil || status.Ready || status.Provider != "tokendance" {
		t.Fatal("configuration alone must not claim a verified connection")
	}
}

func TestTokenDanceRejectsOtherEndpointsBeforeSendingKey(t *testing.T) {
	for _, endpoint := range []string{"http://tokendance.space/gateway/v1/chat/completions", "https://tokendance.space.evil.test/gateway/v1/chat/completions", "https://evil.test/gateway/v1/chat/completions", "https://tokendance.space:443/gateway/v1/chat/completions", "https://tokendance.space/gateway/v1/responses", "https://tokendance.space/gateway/v1/chat/completions?key=private", "https://user:private@tokendance.space/gateway/v1/chat/completions", "https://tokendance.space/gateway/v1/chat/completions#private", "https://tokendance.space/gateway/v1/chat/%63ompletions"} {
		t.Run(endpoint, func(t *testing.T) {
			sent := false
			c := New(Config{Provider: "tokendance", Model: "qwen3.7-plus", URL: endpoint, APIKey: "fixture-secret", Client: &http.Client{Transport: tokenDanceTransport(func(*http.Request) (*http.Response, error) { sent = true; return nil, errors.New("should not send") })}})
			if _, e := c.Decide(context.Background(), Request{}); e == nil || sent {
				t.Fatal("invalid endpoint received a credentialed request")
			}
		})
	}
}

func TestTokenDanceUsesNativeFunctionsWithoutTextJSONOverride(t *testing.T) {
	c := New(Config{Provider: "tokendance", Model: "qwen3.7-plus", URL: "https://tokendance.space/gateway/v1/chat/completions", APIKey: "fixture-secret", Client: &http.Client{Transport: tokenDanceTransport(func(r *http.Request) (*http.Response, error) {
		if r.Header.Get("Authorization") != "Bearer fixture-secret" {
			t.Fatal("private header was not supplied")
		}
		var body map[string]any
		if e := json.NewDecoder(r.Body).Decode(&body); e != nil {
			t.Fatal(e)
		}
		if body["model"] != "qwen3.7-plus" || body["enable_thinking"] != false || body["parallel_tool_calls"] != false || body["tool_choice"] != "auto" || body["response_format"] != nil {
			t.Fatal("native function protocol was replaced or unsupported thinking enabled")
		}
		functions, ok := body["tools"].([]any)
		if !ok || len(functions) != 1 || functions[0].(map[string]any)["type"] != "function" {
			t.Fatal("tools were not passed as native functions")
		}
		return &http.Response{StatusCode: 200, Body: io.NopCloser(strings.NewReader(`{"model":"qwen3.7-plus","choices":[{"finish_reason":"tool_calls","message":{"role":"assistant","tool_calls":[{"type":"function","function":{"name":"calculate","arguments":"{}"}}]}}]}`)), Header: http.Header{}}, nil
	})}})
	decision, e := c.Decide(context.Background(), Request{Goal: "fixture", Tools: testTools})
	if e != nil || decision.Action != "tool" || decision.Tool != "calculate" || decision.Model != "qwen3.7-plus" {
		t.Fatal("native function response was not accepted")
	}
	status, _ := c.Status(context.Background(), false)
	if !status.Ready || status.Provider != "tokendance" {
		t.Fatal("successful native response did not update provider state")
	}
}

func TestTokenDanceTransportErrorsAndStatusDoNotRevealPrivateKey(t *testing.T) {
	secret := "fixture-private-token-dance-key"
	c := New(Config{Provider: "tokendance", Model: "qwen3.7-plus", URL: "https://tokendance.space/gateway/v1/chat/completions", APIKey: secret, Client: &http.Client{Transport: tokenDanceTransport(func(*http.Request) (*http.Response, error) { return nil, errors.New("upstream included " + secret) })}})
	_, e := c.Decide(context.Background(), Request{})
	if e == nil || strings.Contains(e.Error(), secret) {
		t.Fatal("transport error revealed credentials")
	}
	status, _ := c.Status(context.Background(), false)
	if status.Ready || strings.Contains(status.Message, secret) {
		t.Fatal("failed connection status revealed credentials")
	}
	t.Setenv("TOKENDANCE_API_KEY", secret)
	if strings.Contains(safeError("header "+secret), secret) {
		t.Fatal("environment key was not redacted")
	}
}
