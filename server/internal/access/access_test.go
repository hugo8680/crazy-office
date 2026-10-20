package access

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"crazyoffice/server/internal/identity"
)

const password = "node-compatible-password-2026"
const hash = "scrypt$16384$8$1$ABEiM0RVZneImaq7zN3u_w$eGE4qF8n4m3juolywes1cciDplvCzB9kLAsOSu0w8cOq2tPb7NJr-_YbrwvCi_pxJtfB4kzXCwDbPUd6rK0IcA"
const secret = "test-only-session-key-at-least-thirty-two-bytes"
const origin = "https://office.example.test"

func config() Config { return Config{PublicOrigin: origin, PasswordHash: hash, SessionSecret: secret} }
func request(ip string) *http.Request {
	r := httptest.NewRequest("POST", origin+"/api/login", nil)
	r.RemoteAddr = ip
	r.Header.Set("Origin", origin)
	return r
}
func withCookie(cookie string) *http.Request {
	r := request("203.0.113.7:1234")
	r.Header.Set("Cookie", strings.Split(cookie, ";")[0])
	return r
}
func errStatus(t *testing.T, e error, n int) {
	t.Helper()
	var f *identity.Error
	if !errors.As(e, &f) || f.Status != n {
		t.Fatalf("error=%v want %d", e, n)
	}
}
func gate(t *testing.T, c Config) *Gate {
	t.Helper()
	g, e := New(c)
	if e != nil {
		t.Fatal(e)
	}
	return g
}
func signToken(value any) string {
	b, _ := json.Marshal(value)
	body := base64.RawURLEncoding.EncodeToString(b)
	h := hmac.New(sha256.New, []byte(secret))
	_, _ = h.Write([]byte(body))
	return CookieName + "=" + body + "." + base64.RawURLEncoding.EncodeToString(h.Sum(nil))
}
func TestLocalAccessAndConfigValidation(t *testing.T) {
	g := gate(t, Config{})
	if g.Enabled || g.Authenticate(request("127.0.0.1:123")) == nil || g.PublicSession(request("127.0.0.1:123"))["authenticated"] != true {
		t.Fatal("local behavior")
	}
	for _, c := range []Config{{PublicOrigin: origin}, {PublicOrigin: origin, PasswordHash: hash, SessionSecret: "short"}, {PublicOrigin: origin, PasswordHash: "malformed", SessionSecret: secret}, {PublicOrigin: "http://office.test", PasswordHash: hash, SessionSecret: secret}, {PublicOrigin: origin + "/path", PasswordHash: hash, SessionSecret: secret}, {PublicOrigin: "https://secret@office.test", PasswordHash: hash, SessionSecret: secret}, {PublicOrigin: origin, PasswordHash: hash, SessionSecret: secret, Username: "invalid name"}} {
		if _, e := New(c); e == nil {
			t.Fatalf("invalid config accepted: %+v", c)
		}
	}
}
func TestLoginCookieCompatibilityAndExpiry(t *testing.T) {
	clock := time.Date(2026, 10, 20, 2, 0, 0, 0, time.UTC)
	c := config()
	c.Now = func() time.Time { return clock }
	g := gate(t, c)
	for _, credentials := range []Credentials{{"office", "wrong"}, {"different", password}, {"office", strings.Repeat("a", 1025)}, {}} {
		_, e := g.Login(request("203.0.113.7:1"), credentials)
		errStatus(t, e, 401)
	}
	r, e := g.Login(request("203.0.113.7:1"), Credentials{"office", password})
	if e != nil {
		t.Fatal(e)
	}
	if !strings.HasSuffix(r.Cookie, "Secure; HttpOnly; SameSite=Strict") || !strings.Contains(r.Cookie, "Max-Age=43200") || strings.Contains(r.Cookie, password) {
		t.Fatal("unsafe cookie")
	}
	session := g.Authenticate(withCookie(r.Cookie))
	if session == nil || session.Username != "office" || *session.ExpiresAt != "2026-10-20T14:00:00.000Z" {
		t.Fatalf("session=%+v", session)
	}
	clock = clock.Add(12 * time.Hour)
	if g.Authenticate(withCookie(r.Cookie)) != nil {
		t.Fatal("expired session")
	}
	if g.LogoutCookie() != CookieName+"=; Path=/; Max-Age=0; Secure; HttpOnly; SameSite=Strict" {
		t.Fatal("logout")
	}
}
func TestSignedNodeV1CookieAcceptedAndTamperingRejected(t *testing.T) {
	clock := time.Date(2026, 10, 20, 2, 0, 0, 0, time.UTC)
	c := config()
	c.Now = func() time.Time { return clock }
	g := gate(t, c)
	payload := map[string]any{"v": 1, "sub": "office", "iat": clock.Unix(), "exp": clock.Unix() + SessionSeconds, "nonce": "AAECAwQFBgcICQoLDA0ODw"}
	// Captured from Node Buffer JSON + createHmac('sha256') before migration.
	nodeStyle := CookieName + "=eyJ2IjoxLCJzdWIiOiJvZmZpY2UiLCJpYXQiOjE3OTI0NjE2MDAsImV4cCI6MTc5MjUwNDgwMCwibm9uY2UiOiJBQUVDQXdRRkJnY0lDUW9MREEwT0R3In0.ZdoCjzp3URzcor0TTzxkq8w8IGO-wcVKEYnX_jjritg"
	if g.Authenticate(withCookie(nodeStyle)) == nil {
		t.Fatal("old v1 signed cookie rejected")
	}
	for _, patch := range []map[string]any{{"sub": "other"}, {"v": 2}, {"iat": clock.Unix() + 61, "exp": clock.Unix() + SessionSeconds + 61}, {"exp": clock.Unix() + SessionSeconds + 1}, {"nonce": "bad"}, {"iat": "123"}, {"iat": 1.5}, {"exp": nil}} {
		p := map[string]any{}
		for k, v := range payload {
			p[k] = v
		}
		for k, v := range patch {
			p[k] = v
		}
		if g.Authenticate(withCookie(signToken(p))) != nil {
			t.Fatalf("bad token accepted: %v", patch)
		}
	}
	for _, raw := range []string{nodeStyle + "x", CookieName + "=bad.cookie", CookieName + "=" + strings.Repeat("a", 9000), nodeStyle + "; " + nodeStyle} {
		req := request("203.0.113.7:1")
		req.Header.Set("Cookie", raw)
		if g.Authenticate(req) != nil {
			t.Fatal("malformed or duplicate cookie accepted")
		}
	}
	duplicate := withCookie(nodeStyle)
	duplicate.Header.Add("Cookie", nodeStyle)
	if g.Authenticate(duplicate) != nil {
		t.Fatal("duplicate separate headers accepted")
	}
}
func TestOriginAndRateLimits(t *testing.T) {
	clock := time.Date(2026, 10, 20, 2, 0, 0, 0, time.UTC)
	c := config()
	c.Now = func() time.Time { return clock }
	g := gate(t, c)
	for _, o := range []string{"", "null", "https://evil.test", origin + ".evil.test"} {
		r := request("203.0.113.7:1")
		r.Header.Set("Origin", o)
		_, e := g.Login(r, Credentials{"office", password})
		errStatus(t, e, 403)
	}
	for i := 0; i < 8; i++ {
		_, e := g.Login(request("203.0.113.7:1"), Credentials{"office", "wrong"})
		errStatus(t, e, 401)
	}
	_, e := g.Login(request("203.0.113.7:1"), Credentials{"office", password})
	errStatus(t, e, 429)
	if _, e := g.Login(request("203.0.113.8:1"), Credentials{"office", password}); e != nil {
		t.Fatal(e)
	}
	clock = clock.Add(15 * time.Minute)
	if _, e := g.Login(request("203.0.113.7:1"), Credentials{"office", password}); e != nil {
		t.Fatal(e)
	}
}
func TestProxyIPAndConcurrentLimits(t *testing.T) {
	g := gate(t, config())
	for i := 0; i < 8; i++ {
		r := request("198.51.100.9:1")
		r.Header.Set("X-Real-IP", "203.0.113."+string(rune('1'+i)))
		_, e := g.Login(r, Credentials{"office", "wrong"})
		errStatus(t, e, 401)
	}
	r := request("198.51.100.9:1")
	r.Header.Set("X-Real-IP", "203.0.113.77")
	_, e := g.Login(r, Credentials{"office", password})
	errStatus(t, e, 429)
	for _, ip := range []string{"127.0.0.1:123", "[::1]:123", "[::ffff:127.0.0.1]:123"} {
		r := request(ip)
		r.Header.Set("X-Real-IP", "203.0.113.55")
		if ClientAddress(r) != "203.0.113.55" {
			t.Fatal("valid proxyIP rejected")
		}
	}
	r = request("127.0.0.1:123")
	r.Header.Set("X-Real-IP", "203.0.113.55, 1.2.3.4")
	if ClientAddress(r) != "127.0.0.1" {
		t.Fatal("list accepted")
	}
	g = gate(t, config())
	var wg sync.WaitGroup
	results := make(chan error, 12)
	for i := 0; i < 12; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			_, e := g.Login(request("203.0.113.99:123"), Credentials{"office", "wrong"})
			results <- e
		}()
	}
	wg.Wait()
	close(results)
	counts := map[int]int{}
	for e := range results {
		var f *identity.Error
		if !errors.As(e, &f) {
			t.Fatal(e)
		}
		counts[f.Status]++
	}
	if counts[401] != 8 || counts[429] != 4 {
		t.Fatalf("rate limit bypass: %v", counts)
	}
}
func TestEmployeeV2CookiesTrustedAndRevocable(t *testing.T) {
	store, e := identity.Open(filepath.Join(t.TempDir(), "identity.json"), "office")
	if e != nil {
		t.Fatal(e)
	}
	v, e := store.CreateInvitation("bootstrap", identity.InvitationInput{Username: "zhang", Name: "张明", Roles: []string{"procurement"}})
	if e != nil {
		t.Fatal(e)
	}
	employee, e := store.AcceptInvitation(v.Token, password)
	if e != nil {
		t.Fatal(e)
	}
	c := config()
	c.Identity = store
	g := gate(t, c)
	r, e := g.Login(request("203.0.113.7:1"), Credentials{"zhang", password})
	if e != nil {
		t.Fatal(e)
	}
	session := g.Authenticate(withCookie(r.Cookie))
	if session == nil || session.ID != employee.ID || session.Roles[0] != "procurement" {
		t.Fatalf("employee session: %+v", session)
	}
	public := g.PublicSession(withCookie(r.Cookie))
	actor, _ := public["actor"].(map[string]any)
	if public["epoch"] != nil || actor["epoch"] != nil || actor["id"] != employee.ID {
		t.Fatal("public session must exclude the private revocation epoch")
	}
	raw := strings.Split(strings.Split(strings.Split(r.Cookie, ";")[0], "=")[1], ".")[0]
	b, _ := base64.RawURLEncoding.DecodeString(raw)
	var p map[string]any
	_ = json.Unmarshal(b, &p)
	if p["v"] != float64(2) || p["epoch"] != float64(employee.Epoch) || p["roles"] != nil {
		t.Fatal("invalid v2 token")
	}
	if gate(t, config()).Authenticate(withCookie(r.Cookie)) != nil {
		t.Fatal("no identity v2 accepted")
	}
	_, e = store.UpdateEmployee("bootstrap", employee.ID, map[string]any{"name": "张明宇"})
	if e != nil {
		t.Fatal(e)
	}
	if g.Authenticate(withCookie(r.Cookie)).Name != "张明宇" {
		t.Fatal("stale profile")
	}
	_, _ = store.UpdateEmployee("bootstrap", employee.ID, map[string]any{"roles": []string{"warehouse"}})
	if g.Authenticate(withCookie(r.Cookie)) != nil {
		t.Fatal("stale role cookie")
	}
	second, e := g.Login(request("203.0.113.7:1"), Credentials{"zhang", password})
	if e != nil {
		t.Fatal(e)
	}
	_, _ = store.UpdateEmployee("bootstrap", employee.ID, map[string]any{"active": false})
	if g.Authenticate(withCookie(second.Cookie)) != nil {
		t.Fatal("disabled cookie")
	}
	_, _ = store.UpdateEmployee("bootstrap", employee.ID, map[string]any{"active": true})
	third, e := g.Login(request("203.0.113.7:1"), Credentials{"zhang", password})
	if e != nil {
		t.Fatal(e)
	}
	_, e = store.ChangePassword(employee.ID, password, password+"-changed")
	if e != nil {
		t.Fatal(e)
	}
	if g.Authenticate(withCookie(third.Cookie)) != nil {
		t.Fatal("changed password cookie")
	}
	out, _ := json.Marshal(r)
	if strings.Contains(string(out), "passwordHash") || strings.Contains(string(out), password) {
		t.Fatal("secret in response")
	}
}
func TestLegacyIdentityCompatibilityAndLocalMapping(t *testing.T) {
	store, e := identity.Open(filepath.Join(t.TempDir(), "identity.json"), "office")
	if e != nil {
		t.Fatal(e)
	}
	old := gate(t, config())
	r, e := old.Login(request("203.0.113.7:1"), Credentials{"office", password})
	if e != nil {
		t.Fatal(e)
	}
	c := config()
	c.Identity = store
	g := gate(t, c)
	if g.Authenticate(withCookie(r.Cookie)).ID != "bootstrap" {
		t.Fatal("legacy cookie mapping")
	}
	local := gate(t, Config{Identity: store})
	if local.Authenticate(request("127.0.0.1:1")).ID != "bootstrap" {
		t.Fatal("local mapping")
	}
	v, _ := store.CreateInvitation("bootstrap", identity.InvitationInput{Username: "admin2", Name: "第二管理员", Roles: []string{"admin"}})
	a, _ := store.AcceptInvitation(v.Token, password)
	_, _ = store.UpdateEmployee(a.ID, "bootstrap", map[string]any{"active": false})
	if g.Authenticate(withCookie(r.Cookie)) != nil || local.Authenticate(request("127.0.0.1:1")) != nil {
		t.Fatal("disabled legacy mapping")
	}
}

func TestEmployeeSignedFieldsDoNotGrantRoles(t *testing.T) {
	store, err := identity.Open(filepath.Join(t.TempDir(), "identity.json"), "office")
	if err != nil {
		t.Fatal(err)
	}
	v, err := store.CreateInvitation("bootstrap", identity.InvitationInput{Username: "zhang", Name: "张明", Roles: []string{"procurement"}})
	if err != nil {
		t.Fatal(err)
	}
	a, err := store.AcceptInvitation(v.Token, password)
	if err != nil {
		t.Fatal(err)
	}
	c := config()
	c.Identity = store
	g := gate(t, c)
	now := time.Now().Unix()
	payload := map[string]any{"v": 2, "sub": a.ID, "epoch": a.Epoch, "iat": now, "exp": now + SessionSeconds, "nonce": "AAECAwQFBgcICQoLDA0ODw", "roles": []string{"admin"}, "source": "legacy"}
	session := g.Authenticate(withCookie(signToken(payload)))
	if session == nil || len(session.Roles) != 1 || session.Roles[0] != "procurement" || session.Source != "employee" {
		t.Fatal("cookie data overwrote trusted directory")
	}
	for _, patch := range []map[string]any{{"epoch": 0}, {"epoch": a.Epoch + 1}, {"epoch": "2"}, {"epoch": int64(9007199254740992)}, {"sub": "missing"}, {"v": 1, "sub": "zhang"}, {"v": 3}} {
		p := map[string]any{}
		for k, v := range payload {
			p[k] = v
		}
		for k, v := range patch {
			p[k] = v
		}
		if g.Authenticate(withCookie(signToken(p))) != nil {
			t.Fatalf("invalid employee token accepted: %v", patch)
		}
	}
}
