package httpapi

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"crazyoffice/server/internal/erpflow"
	"crazyoffice/server/internal/model"
	"crazyoffice/server/internal/tools"
)

const testOrigin = "https://office.example.test"
const testPassword = "node-compatible-password-2026"
const testPasswordHash = "scrypt$16384$8$1$ABEiM0RVZneImaq7zN3u_w$eGE4qF8n4m3juolywes1cciDplvCzB9kLAsOSu0w8cOq2tPb7NJr-_YbrwvCi_pxJtfB4kzXCwDbPUd6rK0IcA"

type fixtureProvider struct{}

func (fixtureProvider) Status(context.Context, bool) (model.Status, error) {
	return model.Status{Ready: true, Provider: "test", Model: "isolated-test-model"}, nil
}
func (fixtureProvider) Decide(_ context.Context, r model.Request) (model.Decision, error) {
	d := model.Decision{Action: "tool", Tool: "read_work_context", Args: M{}, Model: "isolated-test-model"}
	if len(r.Messages) > 0 {
		d.Tool = "prepare_plan"
		d.Args = M{"summary": "已按真实工作单核对目标与岗位，等待两名负责人审批。", "steps": []string{"核对资料与实际办理条件", "经过两级审批后办理"}, "checks": []string{"核对本单范围与权限"}, "missing": []string{}}
		if r.Role.ID == "liu" {
			d.Tool = "review_plan"
			delete(d.Args, "steps")
			d.Args["passed"] = true
		}
	}
	return d, nil
}

type fixtureLab struct {
	mu      sync.Mutex
	created int
}

func (*fixtureLab) List() []M {
	return []M{{"id": "private-lab-run", "input": M{"secret": "lab-private"}}}
}
func (*fixtureLab) Get(id string) (M, error) { return M{"id": id}, nil }
func (l *fixtureLab) Create(context.Context, M) (M, error) {
	l.mu.Lock()
	defer l.mu.Unlock()
	l.created++
	return M{"id": "new-lab-run"}, nil
}
func (*fixtureLab) Approve(id string, _ M) (M, error)             { return M{"id": id}, nil }
func (*fixtureLab) Cancel(id string) (M, error)                   { return M{"id": id}, nil }
func (*fixtureLab) Retry(_ context.Context, id string) (M, error) { return M{"id": id}, nil }
func (*fixtureLab) Artifact(string, string) (tools.Artifact, error) {
	return tools.Artifact{}, fail(404, "test file absent")
}
func (*fixtureLab) Archive(string) ([]byte, error) { return []byte("isolated"), nil }
func (*fixtureLab) Subscribe(string) (<-chan M, func(), error) {
	ch := make(chan M, 1)
	ch <- M{"id": "private-lab-run"}
	close(ch)
	return ch, func() {}, nil
}
func (*fixtureLab) Active() int                    { return 0 }
func (*fixtureLab) Shutdown(context.Context) error { return nil }

type fixtureAutomation struct{}

func (fixtureAutomation) PublicStatus(context.Context) (M, error) { return M{"enabled": false}, nil }
func (fixtureAutomation) Update(context.Context, M) (M, error)    { return M{"enabled": false}, nil }
func (fixtureAutomation) Dispatch(context.Context) (M, error)     { return M{"dispatched": true}, nil }
func (fixtureAutomation) Shutdown(context.Context) error          { return nil }

type appFixture struct {
	t      *testing.T
	a      *App
	server *httptest.Server
	client *http.Client
	admin  string
}
type response struct {
	status int
	body   []byte
	header http.Header
	json   M
}

func newApp(t *testing.T) *appFixture {
	t.Helper()
	a, e := New(Config{DataDir: t.TempDir(), PublicOrigin: testOrigin, Port: 8080, Username: "office", PasswordHash: testPasswordHash, SessionSecret: "isolated-test-session-secret-thirty-two-bytes", Provider: fixtureProvider{}, Lab: &fixtureLab{}, Automation: fixtureAutomation{}, Catalog: func() M { return M{"agents": []M{{"id": "business"}}} }})
	if e != nil {
		t.Fatal(e)
	}
	srv := httptest.NewTLSServer(a)
	f := &appFixture{t: t, a: a, server: srv, client: srv.Client()}
	t.Cleanup(func() {
		srv.Close()
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		if e := a.Close(ctx); e != nil {
			t.Error(e)
		}
	})
	f.admin = f.login("office", testPassword)
	return f
}
func (f *appFixture) send(method, path, cookie string, p any, headers map[string]string) response {
	f.t.Helper()
	var raw []byte
	switch x := p.(type) {
	case nil:
	case string:
		raw = []byte(x)
	default:
		raw, _ = json.Marshal(p)
	}
	r, e := http.NewRequest(method, f.server.URL+path, bytes.NewReader(raw))
	if e != nil {
		f.t.Fatal(e)
	}
	r.Host = "office.example.test"
	if method != "GET" && method != "HEAD" {
		r.Header.Set("Origin", testOrigin)
	}
	if p != nil {
		r.Header.Set("Content-Type", "application/json")
	}
	if cookie != "" {
		r.Header.Set("Cookie", cookie)
	}
	for k, v := range headers {
		if strings.EqualFold(k, "Host") {
			r.Host = v
		} else {
			r.Header.Set(k, v)
		}
	}
	out, e := f.client.Do(r)
	if e != nil {
		f.t.Fatal(e)
	}
	defer out.Body.Close()
	data, e := io.ReadAll(out.Body)
	if e != nil {
		f.t.Fatal(e)
	}
	v := M{}
	_ = json.Unmarshal(data, &v)
	return response{out.StatusCode, data, out.Header, v}
}
func (f *appFixture) expect(r response, status int) response {
	f.t.Helper()
	if r.status != status {
		f.t.Fatalf("HTTP %d want %d: %s", r.status, status, r.body)
	}
	return r
}
func (f *appFixture) login(username, password string) string {
	f.t.Helper()
	r := f.expect(f.send("POST", "/api/session/login", "", M{"username": username, "password": password, "roles": []string{"admin"}, "id": "bootstrap"}, nil), 200)
	cookie := strings.Split(r.header.Get("Set-Cookie"), ";")[0]
	if !strings.HasPrefix(cookie, "__Host-office_session=") {
		f.t.Fatal("login omitted signed cookie")
	}
	return cookie
}
func (f *appFixture) invite(username string, roles []string) (M, string) {
	f.t.Helper()
	r := f.expect(f.send("POST", "/api/erp/invitations", f.admin, M{"username": username, "name": username, "department": "业务部", "title": "业务员", "roles": roles}, nil), 201)
	token := erpflow.S(r.json["token"])
	joined := f.expect(f.send("POST", "/api/erp/invitations/accept", "", M{"token": token, "password": testPassword}, nil), 200)
	if !strings.Contains(joined.header.Get("Set-Cookie"), "Max-Age=0") {
		f.t.Fatal("invite acceptance must clear old browser identity without logging in automatically")
	}
	return erpflow.Map(joined.json["employee"]), f.login(username, testPassword)
}
func (f *appFixture) project(members []string) M {
	f.t.Helper()
	r := f.expect(f.send("POST", "/api/erp/masterdata", f.admin, M{"_requestId": "project-" + erpflow.ID(), "kind": "projects", "record": M{"name": "HTTP验收项目", "customer": "测试客户", "ownerId": "bootstrap", "members": members}}, nil), 201)
	return erpflow.Map(r.json["record"])
}
func (f *appFixture) doc(cookie, id string) M {
	f.t.Helper()
	r := f.expect(f.send("GET", "/api/erp/workitems/"+id, cookie, nil, nil), 200)
	return erpflow.Map(r.json["document"])
}
func (f *appFixture) action(cookie, id, action string, p M, status int) response {
	f.t.Helper()
	if p == nil {
		p = M{}
	}
	if p["_requestId"] == nil {
		p["_requestId"] = "action-" + erpflow.ID()
	}
	return f.expect(f.send("POST", "/api/erp/workitems/"+id+"/"+action, cookie, p, nil), status)
}

func TestHTTPAuthenticationOriginHostAndAPIBoundary(t *testing.T) {
	f := newApp(t)
	f.expect(f.send("GET", "/api/livez", "", nil, nil), 200)
	f.expect(f.send("GET", "/api/health", "", nil, nil), 401)
	f.expect(f.send("GET", "/api/erp/snapshot", "", nil, nil), 401)
	health := f.expect(f.send("GET", "/api/health", f.admin, nil, nil), 200)
	if health.json["runtime"] != "go" {
		t.Fatal("health runtime")
	}
	for _, path := range []string{"/", "/index.html", "/office.js", "/scene3d.js", "/erp-ui.mjs", "/join", "/login.html", "/.env", "/.office-data/erp/identities.json", "/api/erp/../identities.json"} {
		r := f.send("GET", path, f.admin, nil, nil)
		if r.status == 200 || strings.Contains(strings.ToLower(r.header.Get("Content-Type")), "text/html") {
			t.Fatalf("Go served static/private path %s: %d", path, r.status)
		}
	}
	f.expect(f.send("POST", "/api/session/login", "", M{"username": "office", "password": testPassword}, map[string]string{"Origin": "https://evil.test"}), 403)
	f.expect(f.send("POST", "/api/erp/presence", f.admin, M{}, map[string]string{"Host": "office.example.test.attacker.test"}), 403)
	f.expect(f.send("PUT", "/api/erp/presence", f.admin, M{"nodeId": "meeting"}, map[string]string{"Origin": "https://evil.test"}), 403)
	f.expect(f.send("GET", "/api/livez", "", nil, map[string]string{"Host": "localhost:4173"}), 403)
	f.expect(f.send("GET", "/api/session/check", f.admin, nil, nil), 204)
	logout := f.expect(f.send("POST", "/api/session/logout", f.admin, M{}, nil), 200)
	if !strings.Contains(logout.header.Get("Set-Cookie"), "Max-Age=0") {
		t.Fatal("logout does not clear cookie")
	}
	if health.header.Get("X-Content-Type-Options") != "nosniff" || health.header.Get("Cache-Control") != "no-store" {
		t.Fatal("missing API security headers")
	}
}

func TestHTTPInvitationAcceptanceDirectoryIsolationAndRoleRevocation(t *testing.T) {
	f := newApp(t)
	person, cookie := f.invite("employee", []string{"employee"})
	id := erpflow.S(person["id"])
	waiting := f.expect(f.send("POST", "/api/erp/invitations", f.admin, M{"username": "waiting", "name": "待入驻", "roles": []string{"employee"}}, nil), 201)
	disabled, _ := f.invite("disabled", []string{"employee"})
	f.expect(f.send("PUT", "/api/erp/users/"+erpflow.S(disabled["id"]), f.admin, M{"active": false}, nil), 200)
	r := f.expect(f.send("GET", "/api/erp/users", cookie, nil, nil), 200)
	if len(erpflow.Rows(r.json["users"])) != 2 {
		t.Fatalf("directory includes inactive users: %s", r.body)
	}
	for _, s := range []string{"passwordHash", "epoch", "tokenHash", "source", "createdAt", "updatedAt", erpflow.S(erpflow.Map(waiting.json["employee"])["id"]), erpflow.S(disabled["id"])} {
		if strings.Contains(string(r.body), s) {
			t.Fatal("directory leaks " + s)
		}
	}
	f.expect(f.send("POST", "/api/erp/invitations", cookie, M{"username": "root", "name": "越权", "roles": []string{"admin"}}, nil), 403)
	f.expect(f.send("PUT", "/api/erp/users/"+id, cookie, M{"roles": []string{"admin"}}, nil), 403)
	f.expect(f.send("PUT", "/api/erp/users/bootstrap", f.admin, M{"active": false}, nil), 409)
	f.expect(f.send("PUT", "/api/erp/users/"+id, f.admin, M{"roles": []string{"warehouse"}}, nil), 200)
	f.expect(f.send("GET", "/api/erp/snapshot", cookie, nil, nil), 401)
	cookie = f.login("employee", testPassword)
	session := f.expect(f.send("GET", "/api/session", cookie, nil, nil), 200)
	roles := erpflow.Strings(erpflow.Map(session.json["session"])["roles"])
	if len(roles) != 1 || roles[0] != "warehouse" {
		t.Fatal("login trusted supplied roles")
	}
	f.expect(f.send("PUT", "/api/erp/users/"+id, f.admin, M{"active": false}, nil), 200)
	f.expect(f.send("GET", "/api/erp/presence", cookie, nil, nil), 401)
	f.expect(f.send("POST", "/api/session/login", "", M{"username": "employee", "password": testPassword}, nil), 401)
	accept := M{"token": waiting.json["token"], "password": testPassword}
	f.expect(f.send("POST", "/api/erp/invitations/accept", "", accept, nil), 200)
	f.expect(f.send("POST", "/api/erp/invitations/accept", "", accept, nil), 410)
}

func TestHTTPApprovalOrderVersionsReportsAndProjectScope(t *testing.T) {
	f := newApp(t)
	requester, requesterCookie := f.invite("requester", []string{"employee"})
	pm, pmCookie := f.invite("pm", []string{"project_manager"})
	manager, managerCookie := f.invite("manager", []string{"manager"})
	p := f.project([]string{"bootstrap", erpflow.S(requester["id"]), erpflow.S(pm["id"]), erpflow.S(manager["id"])})
	private := f.project([]string{"bootstrap"})
	create := M{"_requestId": "create-" + erpflow.ID(), "type": "project_setup", "projectId": p["id"], "input": M{"objective": "完成HTTP项目立项"}}
	r := f.expect(f.send("POST", "/api/erp/workitems", requesterCookie, create, nil), 202)
	id := erpflow.S(erpflow.Map(r.json["document"])["id"])
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if _, e := f.a.Flow.Wait(ctx, id); e != nil {
		t.Fatal(e)
	}
	d := f.doc(requesterCookie, id)
	if d["status"] != "awaiting_approval" {
		t.Fatalf("not awaiting: %v", d)
	}
	f.action(requesterCookie, id, "approve", M{"expectedVersion": d["version"], "note": "自己审批"}, 403)
	f.action(managerCookie, id, "approve", M{"expectedVersion": d["version"], "note": "提前审批"}, 403)
	f.action(pmCookie, id, "approve", M{"note": "缺版本"}, 400)
	first := f.action(pmCookie, id, "approve", M{"expectedVersion": d["version"], "note": "第一层批准"}, 200)
	firstDoc := erpflow.Map(first.json["document"])
	f.action(managerCookie, id, "approve", M{"expectedVersion": d["version"], "note": "旧版本"}, 409)
	f.action(pmCookie, id, "approve", M{"expectedVersion": firstDoc["version"], "note": "重复参与第二层"}, 403)
	second := f.action(managerCookie, id, "approve", M{"expectedVersion": firstDoc["version"], "note": "第二层批准"}, 200)
	approved := erpflow.Map(second.json["document"])
	if approved["status"] != "approved" || len(erpflow.Rows(approved["approvals"])) != 2 {
		t.Fatalf("approval chain=%v", approved)
	}
	f.action(f.admin, id, "post", M{"expectedVersion": approved["version"], "reference": "HTTP-PROJECT-START"}, 200)
	report := f.expect(f.send("GET", "/api/erp/workitems/"+id+"/report", requesterCookie, nil, nil), 200)
	if !strings.HasPrefix(report.header.Get("Content-Type"), "text/html") || !strings.Contains(string(report.body), "第一层批准") || !strings.Contains(string(report.body), "第二层批准") {
		t.Fatal("report lost actual approvals")
	}
	visible := f.expect(f.send("GET", "/api/erp/snapshot", requesterCookie, nil, nil), 200)
	if strings.Contains(string(visible.body), erpflow.S(private["id"])) {
		t.Fatal("private project in snapshot")
	}
	forbidden := M{"_requestId": "private-" + erpflow.ID(), "type": "project_setup", "projectId": private["id"], "input": M{"objective": "越权项目"}}
	f.expect(f.send("POST", "/api/erp/workitems", requesterCookie, forbidden, nil), 403)
	otherProject, _ := f.a.Store.Command(context.Background(), erpflow.Actor(f.a.Identity.ResolveLegacy("office")), "document.create", M{"type": "project_setup", "projectId": private["id"], "input": M{"objective": "PRIVATE-DOCUMENT"}}, "private-doc-"+erpflow.ID())
	f.expect(f.send("GET", "/api/erp/workitems/"+erpflow.S(otherProject["id"]), requesterCookie, nil, nil), 404)
	for _, version := range []any{0, 1.5, "2"} {
		f.action(f.admin, id, "post", M{"expectedVersion": version, "reference": "INVALID-VERSION"}, 400)
	}
}

func TestHTTPLegacyLabAdministratorBoundaryAndHealth(t *testing.T) {
	f := newApp(t)
	_, employee := f.invite("employee", []string{"employee"})
	r := f.expect(f.send("GET", "/api/runs", employee, nil, nil), 200)
	if len(erpflow.Rows(r.json["runs"])) != 0 || strings.Contains(string(r.body), "lab-private") {
		t.Fatal("legacy runs leaked")
	}
	for _, test := range []struct{ method, path string }{{"GET", "/api/runs/private-lab-run"}, {"POST", "/api/runs"}, {"POST", "/api/runs/private-lab-run/approval"}, {"GET", "/api/runs/private-lab-run/events"}, {"GET", "/api/runs/private-lab-run/artifacts/private"}, {"GET", "/api/automation"}, {"PUT", "/api/automation"}, {"POST", "/api/automation/dispatch"}, {"POST", "/api/provider/check"}} {
		f.expect(f.send(test.method, test.path, employee, M{}, nil), 403)
	}
	f.expect(f.send("GET", "/api/health", employee, nil, nil), 200)
	f.expect(f.send("GET", "/api/runs", f.admin, nil, nil), 200)
	f.expect(f.send("POST", "/api/runs", f.admin, M{"scenario": "database"}, nil), 202)
	f.expect(f.send("GET", "/api/automation", f.admin, nil, nil), 200)
	f.expect(f.send("POST", "/api/provider/check", f.admin, M{}, nil), 200)
	f.expect(f.send("POST", "/api/erp/backup", employee, M{}, nil), 403)
	backup := f.expect(f.send("POST", "/api/erp/backup", f.admin, M{}, nil), 201)
	for _, secret := range []string{"passwordHash", "tokenHash", testPassword, ".sqlite", "identities.json"} {
		if strings.Contains(string(backup.body), secret) {
			t.Fatal("backup API leaks " + secret)
		}
	}
}

func TestHTTPInputLimitsIdempotencyAndPasswordReset(t *testing.T) {
	f := newApp(t)
	employee, cookie := f.invite("employee", []string{"employee"})
	id := erpflow.S(employee["id"])
	for _, raw := range []string{"[]", "null", "{} {}", "{bad"} {
		f.expect(f.send("POST", "/api/erp/invitations", f.admin, raw, nil), 400)
	}
	f.expect(f.send("POST", "/api/erp/invitations", f.admin, M{"username": "invalid", "name": "员工", "expiresInHours": 0}, nil), 400)
	f.expect(f.send("POST", "/api/session/login", "", `{"username":"`+strings.Repeat("x", 9000)+`","password":"unused"}`, nil), 413)
	f.expect(f.send("POST", "/api/erp/masterdata", f.admin, M{"kind": "products", "record": M{"sku": "P", "name": "产品", "unit": "台", "priceCents": 100}}, nil), 400)
	p := M{"_requestId": "same-request-12345", "kind": "products", "record": M{"sku": "P", "name": "产品", "unit": "台", "priceCents": 100}}
	first := f.expect(f.send("POST", "/api/erp/masterdata", f.admin, p, nil), 201)
	second := f.expect(f.send("POST", "/api/erp/masterdata", f.admin, p, nil), 201)
	if erpflow.Map(first.json["record"])["id"] != erpflow.Map(second.json["record"])["id"] {
		t.Fatal("duplicate master data")
	}
	erpflow.Map(p["record"])["name"] = "不同产品"
	f.expect(f.send("POST", "/api/erp/masterdata", f.admin, p, nil), 409)
	reset := f.expect(f.send("POST", "/api/erp/users/"+id+"/reset", f.admin, M{}, nil), 201)
	if reset.json["kind"] != "reset" {
		t.Fatal("wrong reset kind")
	}
	f.expect(f.send("POST", "/api/erp/invitations/accept", "", M{"token": reset.json["token"], "password": testPassword + "-new"}, nil), 200)
	f.expect(f.send("GET", "/api/erp/snapshot", cookie, nil, nil), 401)
	newCookie := f.login("employee", testPassword+"-new")
	f.expect(f.send("POST", "/api/erp/identity/password", newCookie, M{"currentPassword": testPassword + "-new", "newPassword": testPassword + "-changed"}, nil), 200)
	f.expect(f.send("GET", "/api/erp/snapshot", newCookie, nil, nil), 401)
}

func TestHTTPDevelopmentClientProxyAndNoStaticFallback(t *testing.T) {
	a, e := New(Config{DataDir: t.TempDir(), Port: 8080, Provider: fixtureProvider{}})
	if e != nil {
		t.Fatal(e)
	}
	defer a.Close(context.Background())
	srv := httptest.NewServer(a)
	defer srv.Close()
	send := func(host, origin string, method string) *http.Response {
		r, e := http.NewRequest(method, srv.URL+"/api/session", nil)
		if e != nil {
			t.Fatal(e)
		}
		r.Host = host
		if origin != "" {
			r.Header.Set("Origin", origin)
		}
		out, e := srv.Client().Do(r)
		if e != nil {
			t.Fatal(e)
		}
		defer out.Body.Close()
		return out
	}
	if r := send("localhost:4173", "", "GET"); r.StatusCode != 200 {
		t.Fatal("Vite proxy rejected")
	}
	if r := send("localhost:8080", "", "GET"); r.StatusCode != 200 {
		t.Fatal("direct Go API rejected")
	}
	if r := send("localhost:5173", "", "GET"); r.StatusCode != 403 {
		t.Fatal("unlisted port accepted")
	}
	r, _ := http.NewRequest("PUT", srv.URL+"/api/erp/presence", strings.NewReader(`{"nodeId":"meeting"}`))
	r.Host = "localhost:4173"
	r.Header.Set("Origin", "http://localhost:4173")
	out, e := srv.Client().Do(r)
	if e != nil {
		t.Fatal(e)
	}
	io.Copy(io.Discard, out.Body)
	out.Body.Close()
	if out.StatusCode != 200 {
		t.Fatal("same-origin development mutation rejected")
	}
	r, _ = http.NewRequest("PUT", srv.URL+"/api/erp/presence", strings.NewReader(`{"nodeId":"meeting"}`))
	r.Host = "localhost:4173"
	r.Header.Set("Origin", "http://localhost:8080")
	out, e = srv.Client().Do(r)
	if e != nil {
		t.Fatal(e)
	}
	out.Body.Close()
	if out.StatusCode != 403 {
		t.Fatal("cross-port Origin accepted")
	}
}
