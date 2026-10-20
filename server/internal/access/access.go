// Package access authenticates signed browser sessions and bounds password work.
package access

import (
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net"
	"net/http"
	"net/url"
	"regexp"
	"strings"
	"sync"
	"time"

	"crazyoffice/server/internal/identity"
)

const CookieName = "__Host-office_session"
const SessionSeconds = int64(43200)
const window = 15 * time.Minute

type Config struct {
	PublicOrigin, Username, PasswordHash, SessionSecret string
	Identity                                            *identity.Store
	Now                                                 func() time.Time
}
type Credentials struct {
	Username string `json:"username"`
	Password string `json:"password"`
}
type Session struct {
	*identity.Actor
	Username  string  `json:"username"`
	ExpiresAt *string `json:"expiresAt"`
}
type LoginResult struct {
	Cookie  string         `json:"cookie"`
	Session map[string]any `json:"session"`
}
type bucket struct {
	failures  []time.Time
	pending   int
	updatedAt time.Time
}
type Gate struct {
	Enabled bool
	config  Config
	secret  []byte
	mu      sync.Mutex
	clients map[string]*bucket
}

var base64Pattern = regexp.MustCompile(`^[-_A-Za-z0-9]+$`)
var usernamePattern = regexp.MustCompile(`^[A-Za-z0-9_.@-]{1,80}$`)

func New(c Config) (*Gate, error) {
	if c.Now == nil {
		c.Now = time.Now
	}
	if c.Username == "" {
		c.Username = "office"
	}
	c.PublicOrigin = strings.TrimSpace(c.PublicOrigin)
	if c.PublicOrigin != "" {
		origin, e := HTTPSOrigin(c.PublicOrigin)
		if e != nil {
			return nil, e
		}
		c.PublicOrigin = origin
	}
	g := &Gate{Enabled: c.PublicOrigin != "" || c.PasswordHash != "", config: c, clients: map[string]*bucket{}}
	if g.Enabled {
		if _, _, ok := identity.ParsePasswordHash(c.PasswordHash); !ok {
			return nil, fmt.Errorf("公网访问必须配置有效的OFFICE_ACCESS_PASSWORD_HASH。")
		}
		if len([]byte(c.SessionSecret)) < 32 || strings.TrimSpace(c.SessionSecret) == "" {
			return nil, fmt.Errorf("OFFICE_SESSION_SECRET至少需要32字节。")
		}
		if !usernamePattern.MatchString(c.Username) {
			return nil, fmt.Errorf("访问账号只接受1到80位字母、数字、点、下划线、@或短横线。")
		}
		g.secret = []byte(c.SessionSecret)
	}
	return g, nil
}
func HTTPSOrigin(value string) (string, error) {
	u, e := url.Parse(value)
	if e != nil || u.Scheme != "https" || u.Host == "" || u.User != nil || (u.Path != "" && u.Path != "/") || u.RawQuery != "" || u.Fragment != "" || u.Opaque != "" {
		return "", fmt.Errorf("OFFICE_PUBLIC_ORIGIN仅接受HTTPS来源地址，不含路径或账号密码。")
	}
	host := strings.ToLower(u.Host)
	if strings.HasSuffix(host, ":443") {
		host = strings.TrimSuffix(host, ":443")
	}
	return "https://" + host, nil
}
func decode(value string, n int) []byte {
	if !base64Pattern.MatchString(value) {
		return nil
	}
	b, e := base64.RawURLEncoding.DecodeString(value)
	if e != nil || len(b) != n || base64.RawURLEncoding.EncodeToString(b) != value {
		return nil
	}
	return b
}
func equalText(a, b string) bool {
	x, y := sha256.Sum256([]byte(a)), sha256.Sum256([]byte(b))
	return subtle.ConstantTimeCompare(x[:], y[:]) == 1
}
func (g *Gate) sign(body string) []byte {
	h := hmac.New(sha256.New, g.secret)
	_, _ = h.Write([]byte(body))
	return h.Sum(nil)
}
func randomToken() string {
	b := make([]byte, 16)
	if _, e := rand.Read(b); e != nil {
		panic(e)
	}
	return base64.RawURLEncoding.EncodeToString(b)
}
func cookie(value string) string {
	return fmt.Sprintf("%s=%s; Path=/; Max-Age=%d; Secure; HttpOnly; SameSite=Strict", CookieName, value, SessionSeconds)
}
func LogoutCookie() string {
	return CookieName + "=; Path=/; Max-Age=0; Secure; HttpOnly; SameSite=Strict"
}
func (g *Gate) LogoutCookie() string { return LogoutCookie() }
func CookieToken(req *http.Request) string {
	headers := req.Header.Values("Cookie")
	header := strings.Join(headers, ";")
	if len(header) > 8192 {
		return ""
	}
	token := ""
	count := 0
	for _, part := range strings.Split(header, ";") {
		part = strings.TrimSpace(part)
		if strings.HasPrefix(part, CookieName+"=") {
			count++
			token = strings.TrimPrefix(part, CookieName+"=")
		}
	}
	if count != 1 {
		return ""
	}
	return token
}
func ClientAddress(req *http.Request) string {
	remote := strings.ToLower(req.RemoteAddr)
	if host, _, e := net.SplitHostPort(remote); e == nil {
		remote = host
	}
	remote = strings.Trim(remote, "[]")
	ip := net.ParseIP(remote)
	forwarded := strings.TrimSpace(req.Header.Get("X-Real-IP"))
	if ip != nil && ip.IsLoopback() && len(req.Header.Values("X-Real-IP")) == 1 && net.ParseIP(forwarded) != nil {
		return strings.ToLower(forwarded)
	}
	return remote
}

type tokenSession struct {
	V     int    `json:"v"`
	Sub   string `json:"sub"`
	Epoch int64  `json:"epoch,omitempty"`
	Iat   int64  `json:"iat"`
	Exp   int64  `json:"exp"`
	Nonce string `json:"nonce"`
}

func (g *Gate) Authenticate(req *http.Request) *Session {
	if !g.Enabled {
		if g.config.Identity != nil {
			actor := g.config.Identity.ResolveLegacy("")
			if actor == nil {
				return nil
			}
			return &Session{Actor: actor, Username: actor.Username}
		}
		return &Session{}
	}
	token := CookieToken(req)
	if token == "" || len(token) > 2048 {
		return nil
	}
	pieces := strings.Split(token, ".")
	if len(pieces) != 2 {
		return nil
	}
	body, sig := pieces[0], decode(pieces[1], 32)
	if sig == nil || !base64Pattern.MatchString(body) || !hmac.Equal(g.sign(body), sig) {
		return nil
	}
	b, e := base64.RawURLEncoding.DecodeString(body)
	if e != nil || base64.RawURLEncoding.EncodeToString(b) != body {
		return nil
	}
	var session tokenSession
	if e = json.Unmarshal(b, &session); e != nil {
		return nil
	}
	current := g.config.Now().Unix()
	if (session.V != 1 && session.V != 2) || session.Iat > current+60 || session.Exp-session.Iat != SessionSeconds || session.Exp <= current || decode(session.Nonce, 16) == nil {
		return nil
	}
	expiry := time.Unix(session.Exp, 0).UTC().Format("2006-01-02T15:04:05.000Z")
	if session.V == 1 {
		if session.Sub != g.config.Username {
			return nil
		}
		if g.config.Identity != nil {
			actor := g.config.Identity.ResolveLegacy(g.config.Username)
			if actor == nil {
				return nil
			}
			return &Session{Actor: actor, Username: actor.Username, ExpiresAt: &expiry}
		}
		return &Session{Username: g.config.Username, ExpiresAt: &expiry}
	}
	if g.config.Identity == nil || len(session.Sub) > 80 || session.Epoch < 1 || session.Epoch > 9007199254740991 {
		return nil
	}
	actor := g.config.Identity.ResolveSession(session.Sub, session.Epoch)
	if actor == nil {
		return nil
	}
	return &Session{Actor: actor, Username: actor.Username, ExpiresAt: &expiry}
}
func (g *Gate) public(session *Session) map[string]any {
	out := map[string]any{"enabled": g.Enabled, "authenticated": session != nil}
	if session == nil {
		return out
	}
	out["expiresAt"] = session.ExpiresAt
	out["username"] = session.Username
	if session.Actor == nil {
		if session.Username == "" {
			out["username"] = nil
		}
		return out
	}
	b, _ := json.Marshal(session.Actor)
	var actor map[string]any
	_ = json.Unmarshal(b, &actor)
	actor["expiresAt"] = session.ExpiresAt
	for k, v := range actor {
		out[k] = v
	}
	out["actor"] = actor
	return out
}
func (g *Gate) PublicSession(req *http.Request) map[string]any { return g.public(g.Authenticate(req)) }
func (g *Gate) begin(address string) (*bucket, error) {
	g.mu.Lock()
	defer g.mu.Unlock()
	now := g.config.Now()
	cutoff := now.Add(-window)
	for key, b := range g.clients {
		kept := b.failures[:0]
		for _, t := range b.failures {
			if t.After(cutoff) {
				kept = append(kept, t)
			}
		}
		b.failures = kept
		if len(kept) == 0 && b.pending == 0 && !b.updatedAt.After(cutoff) {
			delete(g.clients, key)
		}
	}
	b := g.clients[address]
	if b == nil {
		if len(g.clients) >= 10000 {
			return nil, &identity.Error{Status: 429, Message: "登录请求过多，请稍后再试。", RetryAfter: 60}
		}
		b = &bucket{}
		g.clients[address] = b
	}
	b.updatedAt = now
	if len(b.failures)+b.pending >= 8 {
		reset := now.Add(window)
		if len(b.failures) > 0 {
			reset = b.failures[0].Add(window)
		}
		seconds := int(reset.Sub(now).Seconds() + 0.999)
		if seconds < 1 {
			seconds = 1
		}
		return nil, &identity.Error{Status: 429, Message: "登录尝试过多，请15分钟后重试。", RetryAfter: seconds}
	}
	b.pending++
	return b, nil
}
func (g *Gate) Login(req *http.Request, c Credentials) (*LoginResult, error) {
	if !g.Enabled {
		return &LoginResult{Session: g.PublicSession(req)}, nil
	}
	if g.config.PublicOrigin != "" && (len(req.Header.Values("Origin")) != 1 || req.Header.Get("Origin") != g.config.PublicOrigin) {
		return nil, identity.Fail(403, "登录请求来源无效。")
	}
	b, e := g.begin(ClientAddress(req))
	if e != nil {
		return nil, e
	}
	defer func() { g.mu.Lock(); b.pending--; g.mu.Unlock() }()
	shape := len(c.Username) <= 80 && len([]byte(c.Password)) <= 1024
	supplied := c.Password
	if !shape {
		supplied = "invalid-credential-placeholder"
	}
	var actor *identity.Actor
	accepted := false
	if g.config.Identity != nil && (!shape || !equalText(c.Username, g.config.Username)) {
		actor, e = g.config.Identity.Authenticate(c.Username, supplied)
		accepted = shape && actor != nil
	} else {
		accepted, e = identity.PasswordMatches(supplied, g.config.PasswordHash)
		accepted = accepted && shape && equalText(c.Username, g.config.Username)
		if accepted && g.config.Identity != nil {
			actor = g.config.Identity.ResolveLegacy(g.config.Username)
			accepted = actor != nil
		}
	}
	if e != nil {
		return nil, e
	}
	g.mu.Lock()
	if accepted {
		b.failures = nil
	} else {
		b.failures = append(b.failures, g.config.Now())
	}
	b.updatedAt = g.config.Now()
	g.mu.Unlock()
	if !accepted {
		return nil, identity.Fail(401, "账号或密码错误。")
	}
	issued := g.config.Now().Unix()
	payload := tokenSession{V: 1, Sub: g.config.Username, Iat: issued, Exp: issued + SessionSeconds, Nonce: randomToken()}
	if actor != nil && actor.Source == "employee" {
		payload.V = 2
		payload.Sub = actor.ID
		payload.Epoch = actor.Epoch
	}
	raw, _ := json.Marshal(payload)
	body := base64.RawURLEncoding.EncodeToString(raw)
	value := body + "." + base64.RawURLEncoding.EncodeToString(g.sign(body))
	expiry := time.Unix(payload.Exp, 0).UTC().Format("2006-01-02T15:04:05.000Z")
	return &LoginResult{Cookie: cookie(value), Session: g.public(&Session{Actor: actor, Username: c.Username, ExpiresAt: &expiry})}, nil
}
