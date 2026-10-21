// Package httpapi exposes the stable office API; it never serves client assets.
package httpapi

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"time"

	"crazyoffice/server/internal/access"
	"crazyoffice/server/internal/buildinfo"
	"crazyoffice/server/internal/erp"
	"crazyoffice/server/internal/erpflow"
	"crazyoffice/server/internal/identity"
	"crazyoffice/server/internal/model"
	"crazyoffice/server/internal/network"
	"crazyoffice/server/internal/tools"
)

type M = map[string]any
type Lab interface {
	List() []map[string]any
	Get(string) (map[string]any, error)
	Create(context.Context, map[string]any) (map[string]any, error)
	Approve(string, map[string]any) (map[string]any, error)
	Cancel(string) (map[string]any, error)
	Retry(context.Context, string) (map[string]any, error)
	Artifact(string, string) (tools.Artifact, error)
	Archive(string) ([]byte, error)
	Subscribe(string) (<-chan map[string]any, func(), error)
	Active() int
	Shutdown(context.Context) error
}
type Automation interface {
	PublicStatus(context.Context) (map[string]any, error)
	Update(context.Context, map[string]any) (map[string]any, error)
	Dispatch(context.Context) (map[string]any, error)
	Shutdown(context.Context) error
}
type Config struct {
	DataDir, DataAssetsDir, PublicOrigin, BindHost, Username, PasswordHash, SessionSecret string
	Port                                                                                  int
	Provider                                                                              model.Provider
	Lab                                                                                   Lab
	Automation                                                                            Automation
	Catalog                                                                               func() map[string]any
}
type App struct {
	Config    Config
	Identity  *identity.Store
	Store     *erp.Store
	Flow      *erpflow.Service
	Access    *access.Gate
	Policy    *network.Policy
	closed    chan struct{}
	closeOnce sync.Once
	attemptMu sync.Mutex
	attempts  map[string]attempt
}
type attempt struct {
	at    time.Time
	count int
}

func New(c Config) (*App, error) {
	if c.Provider == nil {
		return nil, errors.New("模型适配器未配置")
	}
	if c.Username == "" {
		c.Username = "office"
	}
	if c.Port == 0 {
		c.Port = 8080
	}
	if c.DataDir == "" {
		c.DataDir = ".office-data"
	}
	dir, e := filepath.Abs(c.DataDir)
	if e != nil {
		return nil, e
	}
	c.DataDir = dir
	ids, e := identity.Open(filepath.Join(dir, "erp", "identities.json"), c.Username)
	if e != nil {
		return nil, e
	}
	gate, e := access.New(access.Config{Identity: ids, PublicOrigin: c.PublicOrigin, Username: c.Username, PasswordHash: c.PasswordHash, SessionSecret: c.SessionSecret})
	if e != nil {
		return nil, e
	}
	policy, e := network.New(network.Config{Port: c.Port, BindHost: c.BindHost, PublicOrigin: c.PublicOrigin, AllowedPorts: []int{4173}})
	if e != nil {
		return nil, e
	}
	store, e := erp.Open(dir)
	if e != nil {
		return nil, e
	}
	flow, e := erpflow.New(store, ids, c.Provider, dir)
	if e != nil {
		store.Close()
		return nil, e
	}
	return &App{Config: c, Identity: ids, Store: store, Flow: flow, Access: gate, Policy: policy, closed: make(chan struct{}), attempts: map[string]attempt{}}, nil
}
func (a *App) Close(ctx context.Context) error {
	a.closeOnce.Do(func() { close(a.closed) })
	var out []error
	if a.Config.Automation != nil {
		out = append(out, a.Config.Automation.Shutdown(ctx))
	}
	out = append(out, a.Flow.Shutdown(ctx))
	if a.Config.Lab != nil {
		out = append(out, a.Config.Lab.Shutdown(ctx))
	}
	out = append(out, a.Store.Close())
	return errors.Join(out...)
}
func write(w http.ResponseWriter, status int, value any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(value)
}
func fail(status int, message string) error { return &identity.Error{Status: status, Message: message} }

var secret = regexp.MustCompile(`sk-[A-Za-z0-9._-]+|Bearer\s+[A-Za-z0-9._-]+`)

func respondError(w http.ResponseWriter, e error) {
	status := 500
	code := ""
	var er *erp.Error
	var ie *identity.Error
	var sc interface{ StatusCode() int }
	if errors.As(e, &er) {
		status = er.Status
		code = er.Code
	} else if errors.As(e, &ie) {
		status = ie.Status
		if ie.RetryAfter > 0 {
			w.Header().Set("Retry-After", fmt.Sprint(ie.RetryAfter))
		}
	} else if errors.As(e, &sc) {
		status = sc.StatusCode()
	}
	message := secret.ReplaceAllString(e.Error(), "[凭据已隐藏]")
	r := []rune(message)
	if len(r) > 1600 {
		message = string(r[:1600])
	}
	result := M{"error": message}
	if code != "" {
		result["code"] = code
	}
	write(w, status, result)
}
func body(w http.ResponseWriter, r *http.Request, limit int64) (M, error) {
	var out M
	d := json.NewDecoder(http.MaxBytesReader(w, r.Body, limit))
	if e := d.Decode(&out); e != nil {
		var max *http.MaxBytesError
		if errors.As(e, &max) {
			return nil, fail(413, "请求内容超过大小限制。")
		}
		if e == io.EOF {
			return M{}, nil
		}
		return nil, fail(400, "请求需要有效的JSON输入。")
	}
	if out == nil {
		return nil, fail(400, "请求需要有效JSON对象。")
	}
	if e := d.Decode(new(any)); e != io.EOF {
		return nil, fail(400, "请求不能包含多份JSON。")
	}
	return out, nil
}
func (a *App) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	defer func() {
		if recover() != nil {
			respondError(w, fail(500, "服务暂不可用，请查阅运行日志。"))
		}
	}()
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.Header().Set("Referrer-Policy", "no-referrer")
	w.Header().Set("Cache-Control", "no-store")
	if e := a.Policy.ValidateRequest(r); e != nil {
		respondError(w, e)
		return
	}
	select {
	case <-a.closed:
		respondError(w, fail(503, "服务正在停止，请稍后重试。"))
		return
	default:
	}
	if r.Method != "GET" && r.Method != "HEAD" && r.Method != "POST" && r.Method != "PUT" {
		w.Header().Set("Allow", "GET, HEAD, POST, PUT")
		w.WriteHeader(405)
		return
	}
	if e := a.route(w, r); e != nil {
		respondError(w, e)
	}
}
func (a *App) route(w http.ResponseWriter, r *http.Request) error {
	path := r.URL.Path
	ctx := r.Context()
	if path == "/api/livez" && r.Method == "GET" {
		write(w, 200, M{"ok": true, "version": buildinfo.Version, "runtime": "go"})
		return nil
	}
	if path == "/api/session" && r.Method == "GET" {
		write(w, 200, M{"session": a.Access.PublicSession(r)})
		return nil
	}
	if path == "/api/session/login" && r.Method == "POST" {
		p, e := body(w, r, 8192)
		if e != nil {
			return e
		}
		result, e := a.Access.Login(r, access.Credentials{Username: erpflow.S(p["username"]), Password: erpflow.S(p["password"])})
		if e != nil {
			return e
		}
		if result.Cookie != "" {
			w.Header().Set("Set-Cookie", result.Cookie)
		}
		write(w, 200, M{"session": result.Session})
		return nil
	}
	if path == "/api/session/logout" && r.Method == "POST" {
		w.Header().Set("Set-Cookie", a.Access.LogoutCookie())
		write(w, 200, M{"ok": true})
		return nil
	}
	if path == "/api/erp/invitations/accept" && r.Method == "POST" {
		return a.accept(w, r)
	}
	session := a.Access.Authenticate(r)
	if session == nil {
		return fail(401, "请登录办公室。")
	}
	if path == "/api/session/check" && r.Method == "GET" {
		w.WriteHeader(204)
		return nil
	}
	actor := session.Actor
	if strings.HasPrefix(path, "/api/erp/") {
		// A second browser tab may replace the shared cookie. Bind a rendered
		// employee's writes to that employee without trusting it for permissions.
		if expected := r.Header.Values("X-Office-Actor"); len(expected) > 0 && (len(expected) != 1 || expected[0] != actor.ID) {
			return fail(401, "登录信息已变更，请重新登录。")
		}
		return a.erp(w, r, actor)
	}
	admin := false
	for _, role := range actor.Roles {
		if role == "admin" {
			admin = true
		}
	}
	if !admin {
		if path == "/api/runs" && r.Method == "GET" {
			write(w, 200, M{"runs": []any{}})
			return nil
		}
		if strings.HasPrefix(path, "/api/runs") || strings.HasPrefix(path, "/api/automation") || path == "/api/provider/check" {
			return fail(403, "此操作需要管理员权限。请在业务工作台办理自己的工作。")
		}
	}
	switch {
	case path == "/api/health" && r.Method == "GET":
		status, e := a.Config.Provider.Status(ctx, false)
		if e != nil {
			return e
		}
		active := 0
		if a.Config.Lab != nil {
			active = a.Config.Lab.Active()
		}
		write(w, 200, M{"ok": true, "provider": status, "activeRuns": active, "erpActiveRuns": a.Flow.Active(), "version": buildinfo.Version, "runtime": "go"})
		return nil
	case path == "/api/catalog" && r.Method == "GET":
		if a.Config.Catalog == nil {
			return fail(503, "岗位目录尚未就绪。")
		}
		write(w, 200, a.Config.Catalog())
		return nil
	case path == "/api/provider/check" && r.Method == "POST":
		status, e := a.Config.Provider.Status(ctx, true)
		if e != nil {
			return e
		}
		write(w, 200, M{"provider": status})
		return nil
	case path == "/api/automation" && r.Method == "GET":
		if a.Config.Automation == nil {
			return fail(503, "自动派工尚未就绪。")
		}
		status, e := a.Config.Automation.PublicStatus(ctx)
		if e != nil {
			return e
		}
		write(w, 200, M{"automation": status})
		return nil
	case path == "/api/automation" && r.Method == "PUT":
		p, e := body(w, r, 128000)
		if e != nil {
			return e
		}
		if a.Config.Automation == nil {
			return fail(503, "自动派工尚未就绪。")
		}
		status, e := a.Config.Automation.Update(ctx, p)
		if e != nil {
			return e
		}
		write(w, 200, M{"automation": status})
		return nil
	case path == "/api/automation/dispatch" && r.Method == "POST":
		if a.Config.Automation == nil {
			return fail(503, "自动派工尚未就绪。")
		}
		result, e := a.Config.Automation.Dispatch(ctx)
		if e != nil {
			return e
		}
		write(w, 202, result)
		return nil
	case strings.HasPrefix(path, "/api/examples/") && r.Method == "GET":
		name := strings.TrimPrefix(path, "/api/examples/")
		if !regexp.MustCompile(`^[a-z]+$`).MatchString(name) {
			return fail(404, "示例不存在。")
		}
		raw, e := os.ReadFile(filepath.Join(a.Config.DataAssetsDir, "examples", name+".json"))
		if e != nil {
			return fail(404, "示例不存在。")
		}
		p := M{}
		if e = json.Unmarshal(raw, &p); e != nil {
			return e
		}
		input := p
		if v, ok := p["input"].(map[string]any); ok {
			input = v
		}
		input["example"] = true
		write(w, 200, M{"input": input})
		return nil
	case strings.HasPrefix(path, "/api/runs"):
		return a.lab(w, r)
	}
	return fail(404, "接口不存在。")
}
func (a *App) accept(w http.ResponseWriter, r *http.Request) error {
	address := access.ClientAddress(r)
	a.attemptMu.Lock()
	b := a.attempts[address]
	if time.Since(b.at) > 15*time.Minute {
		b = attempt{at: time.Now()}
	}
	b.count++
	a.attempts[address] = b
	if len(a.attempts) > 10000 {
		a.attempts = map[string]attempt{address: b}
	}
	a.attemptMu.Unlock()
	if b.count > 20 {
		return fail(429, "尝试过多，请15分钟后再试。")
	}
	p, e := body(w, r, 8192)
	if e != nil {
		return e
	}
	employee, e := a.Identity.AcceptInvitation(erpflow.S(p["token"]), erpflow.S(p["password"]))
	if e != nil {
		return e
	}
	// The same success response that commits the invitation must clear any
	// different employee's pre-existing browser cookie. Acceptance never signs in.
	w.Header().Set("Set-Cookie", a.Access.LogoutCookie())
	write(w, 200, M{"employee": employee.PublicEmployee})
	return nil
}

var userPath = regexp.MustCompile(`^/api/erp/users/([A-Za-z0-9_-]{1,100})(?:/(reset|invite))?$`)
var projectPath = regexp.MustCompile(`^/api/erp/projects/([A-Za-z0-9_-]{1,100})$`)
var workPath = regexp.MustCompile(`^/api/erp/workitems/([A-Za-z0-9_-]{1,100})(?:/([a-z_]+))?$`)
var taskPath = regexp.MustCompile(`^/api/erp/tasks/([A-Za-z0-9_-]{1,100})/(complete|accept|return|reassign)$`)

func (a *App) erp(w http.ResponseWriter, r *http.Request, actor *identity.Actor) error {
	path := r.URL.Path
	ctx := r.Context()
	switch {
	case path == "/api/erp/notices" || strings.HasPrefix(path, "/api/erp/notices/"):
		return a.notices(w, r, actor)
	case path == "/api/erp/organization" && r.Method == "GET":
		people, e := a.Identity.ListOrganization(actor.ID)
		if e != nil {
			return e
		}
		write(w, 200, M{"employees": people})
		return nil
	case path == "/api/erp/catalog" && r.Method == "GET":
		write(w, 200, M{"workflows": erpflow.Workflows, "roles": erpflow.RoleLabels})
		return nil
	case path == "/api/erp/snapshot" && r.Method == "GET":
		snapshot, e := a.Flow.Snapshot(ctx, actor)
		if e != nil {
			return e
		}
		write(w, 200, snapshot)
		return nil
	case path == "/api/erp/users" && r.Method == "GET":
		var users []identity.PublicEmployee
		var e error
		if hasRole(actor, "admin") {
			users, e = a.Identity.ListEmployees(actor.ID)
		} else {
			users, e = a.Identity.ListDirectory(actor.ID)
		}
		if e != nil {
			return e
		}
		write(w, 200, M{"users": users})
		return nil
	case path == "/api/erp/invitations" && r.Method == "POST":
		p, e := body(w, r, 8192)
		if e != nil {
			return e
		}
		delete(p, "_requestId")
		raw, _ := json.Marshal(p)
		var input identity.InvitationInput
		if e = json.Unmarshal(raw, &input); e != nil {
			return fail(400, "员工邀请字段不正确。")
		}
		out, e := a.Identity.CreateInvitation(actor.ID, input)
		if e != nil {
			return e
		}
		write(w, 201, out)
		return nil
	case path == "/api/erp/identity/password" && r.Method == "POST":
		p, e := body(w, r, 8192)
		if e != nil {
			return e
		}
		_, e = a.Identity.ChangePassword(actor.ID, erpflow.S(p["currentPassword"]), erpflow.S(p["newPassword"]))
		if e != nil {
			return e
		}
		w.Header().Set("Set-Cookie", a.Access.LogoutCookie())
		write(w, 200, M{"ok": true, "message": "密码已修改，请重新登录。"})
		return nil
	case userPath.MatchString(path):
		match := userPath.FindStringSubmatch(path)
		id, action := match[1], match[2]
		if r.Method == "PUT" && action == "" {
			p, e := body(w, r, 8192)
			if e != nil {
				return e
			}
			delete(p, "_requestId")
			employee, e := a.Identity.UpdateEmployee(actor.ID, id, p)
			if e != nil {
				return e
			}
			write(w, 200, M{"employee": employee})
			return nil
		}
		if r.Method == "POST" {
			var out *identity.InvitationResult
			var e error
			if action == "reset" {
				out, e = a.Identity.CreatePasswordReset(actor.ID, id, 24)
			} else if action == "invite" {
				out, e = a.Identity.ReissueInvitation(actor.ID, id, 72)
			} else {
				return fail(404, "操作不存在。")
			}
			if e != nil {
				return e
			}
			write(w, 201, out)
			return nil
		}
	case path == "/api/erp/masterdata" && r.Method == "POST":
		p, e := body(w, r, 32000)
		if e != nil {
			return e
		}
		key, e := erpflow.RequestID(p)
		if e != nil {
			return e
		}
		action := map[string]string{"products": "product.create", "product": "product.create", "projects": "project.create", "project": "project.create"}[erpflow.S(p["kind"])]
		if action == "" {
			return fail(400, "请选择产品或项目档案。")
		}
		record := erpflow.Map(p["record"])
		if action == "project.create" && erpflow.S(record["ownerId"]) == "" {
			record["ownerId"] = actor.ID
		}
		if e = a.Flow.ValidatePeople(action, record); e != nil {
			return e
		}
		out, e := a.Store.Command(ctx, erpflow.Actor(actor), action, record, key)
		if e != nil {
			return e
		}
		write(w, 201, M{"record": out})
		return nil
	case projectPath.MatchString(path) && r.Method == "PUT":
		p, e := body(w, r, 32000)
		if e != nil {
			return e
		}
		key, e := erpflow.RequestID(p)
		if e != nil {
			return e
		}
		record := p
		if v, ok := p["record"].(map[string]any); ok {
			record = v
		}
		record["id"] = projectPath.FindStringSubmatch(path)[1]
		if e = a.Flow.ValidatePeople("project.update", record); e != nil {
			return e
		}
		out, e := a.Store.Command(ctx, erpflow.Actor(actor), "project.update", record, key)
		if e != nil {
			return e
		}
		write(w, 200, M{"record": out})
		return nil
	case path == "/api/erp/workitems" && r.Method == "POST":
		p, e := body(w, r, 128000)
		if e != nil {
			return e
		}
		key, e := erpflow.RequestID(p)
		if e != nil {
			return e
		}
		out, e := a.Flow.Create(ctx, actor, p, key)
		if e != nil {
			return e
		}
		write(w, 202, out)
		return nil
	case workPath.MatchString(path):
		m := workPath.FindStringSubmatch(path)
		id, action := m[1], m[2]
		if action == "" && r.Method == "GET" {
			out, e := a.Flow.Detail(ctx, actor, id)
			if e != nil {
				return e
			}
			write(w, 200, out)
			return nil
		}
		if action == "report" && r.Method == "GET" {
			out, e := a.Flow.Report(ctx, actor, id)
			if e != nil {
				return e
			}
			w.Header().Set("Content-Type", "text/html; charset=utf-8")
			w.Header().Set("Content-Disposition", `attachment; filename="office-report.html"`)
			_, e = w.Write(out)
			return e
		}
		if action != "" && r.Method == "POST" {
			p, e := body(w, r, 128000)
			if e != nil {
				return e
			}
			key, e := erpflow.RequestID(p)
			if e != nil {
				return e
			}
			out, e := a.Flow.Action(ctx, actor, id, action, p, key)
			if e != nil {
				return e
			}
			write(w, 200, out)
			return nil
		}
	case path == "/api/erp/tasks" && r.Method == "POST":
		p, e := body(w, r, 32000)
		if e != nil {
			return e
		}
		key, e := erpflow.RequestID(p)
		if e != nil {
			return e
		}
		record := p
		if v, ok := p["record"].(map[string]any); ok {
			record = v
		}
		if e = a.Flow.ValidatePeople("task.create", record); e != nil {
			return e
		}
		out, e := a.Store.Command(ctx, erpflow.Actor(actor), "task.create", record, key)
		if e != nil {
			return e
		}
		write(w, 201, M{"task": out})
		return nil
	case taskPath.MatchString(path) && r.Method == "POST":
		p, e := body(w, r, 64000)
		if e != nil {
			return e
		}
		key, e := erpflow.RequestID(p)
		if e != nil {
			return e
		}
		m := taskPath.FindStringSubmatch(path)
		p["id"] = m[1]
		action := "task." + m[2]
		if e = a.Flow.ValidatePeople(action, p); e != nil {
			return e
		}
		out, e := a.Store.Command(ctx, erpflow.Actor(actor), action, p, key)
		if e != nil {
			return e
		}
		write(w, 200, M{"task": out})
		return nil
	case path == "/api/erp/presence":
		if r.Method == "GET" {
			write(w, 200, M{"online": a.Flow.Online(), "currentUser": actor.PublicEmployee})
			return nil
		}
		if r.Method == "PUT" {
			p, e := body(w, r, 4096)
			if e != nil {
				return e
			}
			online, e := a.Flow.Touch(actor, erpflow.S(p["nodeId"]))
			if e != nil {
				return e
			}
			write(w, 200, M{"online": online, "currentUser": actor.PublicEmployee})
			return nil
		}
	case path == "/api/erp/export" && r.Method == "POST":
		p, e := body(w, r, 4096)
		if e != nil {
			return e
		}
		kind := erpflow.S(p["kind"])
		allowed := map[string]bool{"products": true, "projects": true, "inventory": true, "movements": true, "tasks": true, "performance": true, "documents": true}
		if !allowed[kind] {
			return fail(400, "请选择有效报表。")
		}
		snapshot, e := a.Flow.Snapshot(ctx, actor)
		if e != nil {
			return e
		}
		w.Header().Set("Content-Type", "text/csv; charset=utf-8")
		w.Header().Set("Content-Disposition", `attachment; filename="office-report.csv"`)
		_, e = io.WriteString(w, erpflow.CSV(erpflow.Rows(snapshot[kind])))
		return e
	case path == "/api/erp/backup" && r.Method == "POST":
		return a.backup(w, r, actor)
	}
	return fail(404, "业务接口不存在。")
}
func hasRole(a *identity.Actor, role string) bool {
	for _, v := range a.Roles {
		if v == role {
			return true
		}
	}
	return false
}
func (a *App) backup(w http.ResponseWriter, r *http.Request, actor *identity.Actor) error {
	if !hasRole(actor, "admin") {
		return fail(403, "需要管理员办理。")
	}
	id := time.Now().UTC().Format("2006-01-02T15-04-05.000Z") + "-" + erpflow.ID()[:8]
	dest := filepath.Join(a.Config.DataDir, "backups", id+".sqlite")
	database, e := a.Store.Backup(r.Context(), erpflow.Actor(actor), dest)
	if e != nil {
		return e
	}
	raw, e := os.ReadFile(filepath.Join(a.Config.DataDir, "erp", "identities.json"))
	if e != nil {
		return e
	}
	sum := sha256.Sum256(raw)
	metadata := M{"bytes": len(raw), "sha256": hex.EncodeToString(sum[:])}
	if e = os.WriteFile(filepath.Join(a.Config.DataDir, "backups", id+".identities.json"), raw, 0600); e != nil {
		return e
	}
	manifest := M{"id": id, "createdAt": time.Now().UTC().Format(time.RFC3339Nano), "actorId": actor.ID, "database": database, "identity": metadata, "scope": "业务数据库与身份库分别生成一致副本，恢复前需在隔离环境核对"}
	data, _ := json.MarshalIndent(manifest, "", "  ")
	if e = os.WriteFile(filepath.Join(a.Config.DataDir, "backups", id+".manifest.json"), data, 0600); e != nil {
		return e
	}
	publicDB := M{"bytes": database["bytes"], "sha256": database["sha256"], "integrity": database["integrity"]}
	write(w, 201, M{"backup": M{"id": id, "createdAt": manifest["createdAt"], "database": publicDB, "identity": metadata}})
	return nil
}

var runPath = regexp.MustCompile(`^/api/runs/([A-Za-z0-9-]+)(?:/(events|approval|cancel|retry|artifacts|download)(?:/([^/]+))?)?$`)

func (a *App) lab(w http.ResponseWriter, r *http.Request) error {
	engine := a.Config.Lab
	if engine == nil {
		return fail(503, "任务服务尚未就绪。")
	}
	ctx := r.Context()
	if r.URL.Path == "/api/runs" {
		if r.Method == "GET" {
			write(w, 200, M{"runs": engine.List()})
			return nil
		}
		if r.Method == "POST" {
			p, e := body(w, r, 12*1024*1024)
			if e != nil {
				return e
			}
			out, e := engine.Create(ctx, p)
			if e != nil {
				return e
			}
			write(w, 202, M{"run": out})
			return nil
		}
	}
	m := runPath.FindStringSubmatch(r.URL.Path)
	if m == nil {
		return fail(404, "任务接口不存在。")
	}
	id, action, fileID := m[1], m[2], m[3]
	if action == "" && r.Method == "GET" {
		out, e := engine.Get(id)
		if e != nil {
			return e
		}
		write(w, 200, M{"run": out})
		return nil
	}
	if action == "events" && r.Method == "GET" {
		events, unsubscribe, e := engine.Subscribe(id)
		if e != nil {
			return e
		}
		defer unsubscribe()
		w.Header().Set("Content-Type", "text/event-stream; charset=utf-8")
		w.Header().Set("Cache-Control", "no-cache, no-transform")
		w.Header().Set("X-Accel-Buffering", "no")
		flusher, ok := w.(http.Flusher)
		if !ok {
			return fail(500, "实时事件连接不可用。")
		}
		ticker := time.NewTicker(15 * time.Second)
		defer ticker.Stop()
		for {
			select {
			case <-a.closed:
				return nil
			case <-ctx.Done():
				return nil
			case state, ok := <-events:
				if !ok {
					return nil
				}
				raw, _ := json.Marshal(M{"run": state})
				if _, e := fmt.Fprintf(w, "event: state\ndata: %s\n\n", raw); e != nil {
					return nil
				}
				flusher.Flush()
			case <-ticker.C:
				_, _ = io.WriteString(w, ": heartbeat\n\n")
				flusher.Flush()
			}
		}
	}
	if r.Method == "POST" {
		p, e := body(w, r, 128000)
		if e != nil {
			return e
		}
		var out M
		switch action {
		case "approval":
			out, e = engine.Approve(id, p)
		case "cancel":
			out, e = engine.Cancel(id)
		case "retry":
			out, e = engine.Retry(ctx, id)
		default:
			return fail(404, "任务操作不存在。")
		}
		if e != nil {
			return e
		}
		status := 200
		if action == "retry" {
			status = 202
		}
		write(w, status, M{"run": out})
		return nil
	}
	if action == "artifacts" && r.Method == "GET" {
		file, e := engine.Artifact(id, fileID)
		if e != nil {
			return e
		}
		f, e := os.Open(file.Path)
		if e != nil {
			return fail(404, "文件不存在。")
		}
		defer f.Close()
		stat, e := f.Stat()
		if e != nil {
			return e
		}
		w.Header().Set("Content-Type", file.MimeType)
		w.Header().Set("Content-Disposition", `attachment; filename="download`+filepath.Ext(file.Name)+`"`)
		http.ServeContent(w, r, file.Name, stat.ModTime(), f)
		return nil
	}
	if action == "download" && r.Method == "GET" {
		data, e := engine.Archive(id)
		if e != nil {
			return e
		}
		w.Header().Set("Content-Type", "application/zip")
		w.Header().Set("Content-Disposition", `attachment; filename="office-delivery.zip"`)
		_, e = w.Write(data)
		return e
	}
	return fail(404, "任务接口不存在。")
}
