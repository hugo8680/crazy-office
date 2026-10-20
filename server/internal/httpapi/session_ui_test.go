package httpapi

import (
	"context"
	"net/http"
	"net/http/cookiejar"
	"net/url"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"crazyoffice/server/internal/erpflow"
	"crazyoffice/server/internal/model"
)

func TestEmbeddedAccountPublicShellKeepsBusinessAuthenticationBoundary(t *testing.T) {
	f := newApp(t)
	public := f.expect(f.send("GET", "/api/session", "", nil, nil), 200)
	state := erpflow.Map(public.json["session"])
	if state["authenticated"] != false || state["enabled"] != true || len(state) != 2 {
		t.Fatalf("anonymous session leaked more than login state: %s", public.body)
	}
	if public.header.Get("Cache-Control") != "no-store" {
		t.Fatal("anonymous session may not be cached")
	}
	for _, path := range []string{"/api/erp/catalog", "/api/erp/snapshot", "/api/erp/users", "/api/catalog", "/api/health", "/api/runs", "/api/automation", "/api/session/check"} {
		f.expect(f.send("GET", path, "", nil, nil), 401)
	}
	for _, path := range []string{"/api/erp/workitems", "/api/erp/invitations", "/api/erp/masterdata", "/api/provider/check", "/api/runs", "/api/automation/dispatch"} {
		f.expect(f.send("POST", path, "", M{}, nil), 401)
	}
	// Account requests stay JSON. Navigation belongs to the public office shell.
	login := f.expect(f.send("POST", "/api/session/login", "", M{"username": "office", "password": testPassword}, nil), 200)
	if login.header.Get("Location") != "" || !strings.Contains(login.header.Get("Content-Type"), "application/json") {
		t.Fatal("login redirected instead of returning a session")
	}
	for _, flag := range []string{"__Host-office_session=", "Path=/", "Secure", "HttpOnly", "SameSite=Strict"} {
		if !strings.Contains(login.header.Get("Set-Cookie"), flag) {
			t.Fatalf("login omitted cookie protection %s", flag)
		}
	}
	for _, secret := range []string{"epoch", "passwordHash", "tokenHash", testPassword, "provider", "model"} {
		if strings.Contains(string(login.body), secret) {
			t.Fatalf("public account state leaked %s", secret)
		}
	}
	badLogout := f.expect(f.send("POST", "/api/session/logout", f.admin, M{}, map[string]string{"Origin": "https://other.example.test"}), 403)
	if badLogout.header.Get("Set-Cookie") != "" {
		t.Fatal("cross-origin logout changed the browser session")
	}
	logout := f.expect(f.send("POST", "/api/session/logout", f.admin, M{}, nil), 200)
	if logout.header.Get("Location") != "" || !strings.Contains(logout.header.Get("Set-Cookie"), "Max-Age=0") {
		t.Fatal("logout did not return same-page cookie clearing")
	}
}

func TestInvitationAndResetClearAnotherEmployeesBrowserCookieInSuccessResponse(t *testing.T) {
	for _, kind := range []string{"invitation", "reset"} {
		t.Run(kind, func(t *testing.T) {
			f := newApp(t)
			oldPerson, oldCookie := f.invite("previous-employee", []string{"employee"})
			var token string
			if kind == "invitation" {
				made := f.expect(f.send("POST", "/api/erp/invitations", f.admin, M{"username": "accepted-employee", "name": "新员工", "roles": []string{"employee"}}, nil), 201)
				token = erpflow.S(made.json["token"])
			} else {
				person, _ := f.invite("accepted-employee", []string{"employee"})
				reset := f.expect(f.send("POST", "/api/erp/users/"+erpflow.S(person["id"])+"/reset", f.admin, M{}, nil), 201)
				token = erpflow.S(reset.json["token"])
			}
			jar, e := cookiejar.New(nil)
			if e != nil {
				t.Fatal(e)
			}
			origin, _ := url.Parse(testOrigin)
			pieces := strings.SplitN(oldCookie, "=", 2)
			jar.SetCookies(origin, []*http.Cookie{{Name: pieces[0], Value: pieces[1], Path: "/", Secure: true, HttpOnly: true}})
			before := f.expect(f.send("GET", "/api/session", oldCookie, nil, nil), 200)
			if erpflow.Map(erpflow.Map(before.json["session"])["actor"])["id"] != oldPerson["id"] {
				t.Fatal("test browser did not start as the other employee")
			}
			accepted := f.expect(f.send("POST", "/api/erp/invitations/accept", oldCookie, M{"token": token, "password": testPassword + "-accepted"}, nil), 200)
			setCookies := (&http.Response{Header: accepted.header}).Cookies()
			if len(setCookies) != 1 || setCookies[0].Name != pieces[0] || setCookies[0].MaxAge != -1 || setCookies[0].Value != "" || !setCookies[0].Secure || !setCookies[0].HttpOnly {
				t.Fatal("acceptance did not atomically clear the old HttpOnly cookie")
			}
			jar.SetCookies(origin, setCookies)
			if len(jar.Cookies(origin)) != 0 {
				t.Fatal("old employee would return on browser refresh")
			}
			after := f.expect(f.send("GET", "/api/session", "", nil, nil), 200)
			if erpflow.Map(after.json["session"])["authenticated"] != false || accepted.json["session"] != nil {
				t.Fatal("acceptance automatically granted a session")
			}
			cookie := f.login("accepted-employee", testPassword+"-accepted")
			current := f.expect(f.send("GET", "/api/session", cookie, nil, nil), 200)
			if erpflow.Map(current.json["session"])["username"] != "accepted-employee" {
				t.Fatal("accepted employee could not explicitly sign in")
			}
		})
	}
}

type countedSessionProvider struct {
	fixtureProvider
	calls atomic.Int32
}

func (p *countedSessionProvider) Decide(ctx context.Context, request model.Request) (model.Decision, error) {
	p.calls.Add(1)
	return p.fixtureProvider.Decide(ctx, request)
}

func TestERPActorPreconditionRejectsCrossTabWrongIdentityBeforeModelOrBusinessWrite(t *testing.T) {
	f := newApp(t)
	oldPerson, oldCookie := f.invite("old-ui", []string{"employee"})
	newPerson, newCookie := f.invite("new-ui", []string{"employee", "project_manager", "manager"})
	oldID, newID := erpflow.S(oldPerson["id"]), erpflow.S(newPerson["id"])
	project := f.project([]string{"bootstrap", oldID, newID})
	provider := &countedSessionProvider{}
	f.a.Flow.Provider = provider
	stale := map[string]string{"X-Office-Actor": oldID}
	current := map[string]string{"X-Office-Actor": newID}
	payload := M{"_requestId": "actor-check-" + erpflow.ID(), "type": "project_setup", "projectId": project["id"], "input": M{"objective": "确认当前员工身份后办理"}}
	f.expect(f.send("POST", "/api/erp/workitems", newCookie, payload, stale), 401)
	f.expect(f.send("GET", "/api/erp/snapshot", newCookie, nil, stale), 401)
	if provider.calls.Load() != 0 {
		t.Fatal("stale employee screen called the model with the new cookie")
	}
	snapshot := f.expect(f.send("GET", "/api/erp/snapshot", newCookie, nil, current), 200)
	if len(erpflow.Rows(snapshot.json["documents"])) != 0 {
		t.Fatal("wrong employee precondition created a business document")
	}
	created := f.expect(f.send("POST", "/api/erp/workitems", newCookie, payload, current), 202)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if _, e := f.a.Flow.Wait(ctx, erpflow.S(erpflow.Map(created.json["document"])["id"])); e != nil {
		t.Fatal(e)
	}
	// Clients that predate the header remain compatible; authorization still uses
	// the actual signed employee session rather than the optional precondition.
	payload["_requestId"] = "actor-check-old-" + erpflow.ID()
	requested := f.expect(f.send("POST", "/api/erp/workitems", oldCookie, payload, nil), 202)
	id := erpflow.S(erpflow.Map(requested.json["document"])["id"])
	if _, e := f.a.Flow.Wait(ctx, id); e != nil {
		t.Fatal(e)
	}
	doc := f.doc(oldCookie, id)
	beforeCalls := provider.calls.Load()
	approval := M{"_requestId": "actor-approval-" + erpflow.ID(), "expectedVersion": doc["version"], "note": "确认审批"}
	f.expect(f.send("POST", "/api/erp/workitems/"+id+"/approve", newCookie, approval, stale), 401)
	if provider.calls.Load() != beforeCalls || len(erpflow.Rows(f.doc(oldCookie, id)["approvals"])) != 0 {
		t.Fatal("wrong employee precondition performed an approval or model call")
	}
	f.expect(f.send("POST", "/api/erp/workitems/"+id+"/approve", newCookie, approval, current), 200)
	if len(erpflow.Rows(f.doc(oldCookie, id)["approvals"])) != 1 {
		t.Fatal("correct identity could not approve with its actual role")
	}
	// Supplying an administrator ID never elevates an employee's actual session.
	f.expect(f.send("POST", "/api/erp/invitations", oldCookie, M{"username": "escalate", "name": "越权", "roles": []string{"admin"}}, map[string]string{"X-Office-Actor": "bootstrap"}), 401)
	f.expect(f.send("POST", "/api/erp/invitations", oldCookie, M{"username": "escalate", "name": "越权", "roles": []string{"admin"}}, map[string]string{"X-Office-Actor": oldID}), 403)
}

func TestEmbeddedAccountInvalidLoginRemainsLimitedAndRevokedSessionIsAnonymous(t *testing.T) {
	f := newApp(t)
	person, cookie := f.invite("embedded-staff", []string{"employee"})
	current := f.expect(f.send("GET", "/api/session", cookie, nil, nil), 200)
	state := erpflow.Map(current.json["session"])
	actor := erpflow.Map(state["actor"])
	if state["authenticated"] != true || actor["username"] != "embedded-staff" {
		t.Fatal("valid employee session not returned")
	}
	if actor["epoch"] != nil || state["epoch"] != nil {
		t.Fatal("account dialog received private revocation state")
	}
	f.expect(f.send("PUT", "/api/erp/users/"+erpflow.S(person["id"]), f.admin, M{"active": false}, nil), 200)
	revoked := f.expect(f.send("GET", "/api/session", cookie, nil, nil), 200)
	if erpflow.Map(revoked.json["session"])["authenticated"] != false {
		t.Fatal("revoked identity persisted in public session")
	}
	f.expect(f.send("GET", "/api/erp/snapshot", cookie, nil, nil), 401)
	for i := 0; i < 8; i++ {
		f.expect(f.send("POST", "/api/session/login", "", M{"username": "embedded-staff", "password": "invalid-password-2026"}, nil), 401)
	}
	limited := f.expect(f.send("POST", "/api/session/login", "", M{"username": "embedded-staff", "password": testPassword}, nil), 429)
	if limited.header.Get("Retry-After") == "" || limited.header.Get("Set-Cookie") != "" {
		t.Fatal("login limit did not preserve bounded retry without a session")
	}
}
