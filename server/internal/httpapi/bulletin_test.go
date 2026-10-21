package httpapi

import (
	"fmt"
	"strings"
	"testing"

	"crazyoffice/server/internal/erpflow"
)

func TestHTTPBulletinRequiresAuthenticationAndReturnsActualEmptyNonSensitiveData(t *testing.T) {
	f := newApp(t)
	f.expect(f.send("GET", "/api/erp/bulletin", "", nil, nil), 401)
	f.expect(f.send("POST", "/api/erp/bulletin/messages", "", M{"body": "unauthorized", "_requestId": "msg-unauthorized-0001"}, nil), 401)
	_, cookie := f.invite("board-reader", []string{"employee"})
	r := f.expect(f.send("GET", "/api/erp/bulletin", cookie, nil, nil), 200)
	board := erpflow.Map(r.json["board"])
	training, video, messages, dashboard := erpflow.Map(board["training"]), erpflow.Map(board["video"]), erpflow.Map(board["messages"]), erpflow.Map(board["dashboard"])
	if len(erpflow.Rows(training["entries"])) != 0 || training["canManage"] != false || video["src"] != "" || video["configured"] != false || len(erpflow.Rows(messages["items"])) != 0 || messages["canPost"] != true || dashboard["scope"] != "visible" || len(erpflow.Rows(dashboard["metrics"])) != 4 {
		t.Fatalf("empty board invented configuration or records %s", r.body)
	}
	for _, field := range []string{"passwordHash", "epoch", "priceCents", "performance", "salary", "idempotency", "account", "amount"} {
		if strings.Contains(string(r.body), field) {
			t.Fatal("board returned sensitive field " + field)
		}
	}
	if r.header.Get("Cache-Control") != "no-store" || !strings.Contains(r.header.Get("Content-Type"), "application/json") {
		t.Fatal("board may be cached or interpreted as HTML")
	}
	f.expect(f.send("GET", "/api/erp/bulletin?periodStart=2026-10-01", cookie, nil, nil), 400)
	f.expect(f.send("GET", "/api/erp/bulletin", cookie, nil, map[string]string{"X-Office-Actor": "bootstrap"}), 401)
	f.expect(f.send("POST", "/api/erp/bulletin", cookie, M{}, nil), 405)
	f.expect(f.send("GET", "/api/erp/bulletin/missing", cookie, nil, nil), 404)
}
func TestHTTPMessageAuthorshipPlainTextIdempotencyRateAndSelfDeletion(t *testing.T) {
	f := newApp(t)
	person, cookie := f.invite("board-author", []string{"employee"})
	other, otherCookie := f.invite("board-colleague", []string{"employee"})
	_, managerCookie := f.invite("board-moderator-cannot", []string{"manager"})
	text := "<script>alert('stored as text')</script>\n实际留言"
	payload := M{"_requestId": "board-message-create-0001", "body": text, "authorId": other["id"], "authorName": "伪造姓名", "createdAt": "1900-01-01"}
	f.expect(f.send("POST", "/api/erp/bulletin/messages", cookie, payload, map[string]string{"Origin": "https://evil.test"}), 403)
	f.expect(f.send("POST", "/api/erp/bulletin/messages", cookie, payload, map[string]string{"X-Office-Actor": erpflow.S(other["id"])}), 401)
	created := f.expect(f.send("POST", "/api/erp/bulletin/messages", cookie, payload, nil), 201)
	message := erpflow.Map(created.json["message"])
	if message["authorId"] != person["id"] || message["authorName"] != person["name"] || message["body"] != text || message["createdAt"] == "1900-01-01" {
		t.Fatalf("client spoofed message identity/time %s", created.body)
	}
	if strings.Contains(string(created.body), "<script>") || !strings.Contains(string(created.body), `\u003cscript\u003e`) {
		t.Fatal("message response is not safely encoded JSON text")
	}
	repeat := f.expect(f.send("POST", "/api/erp/bulletin/messages", cookie, payload, nil), 201)
	if erpflow.Map(repeat.json["message"])["id"] != message["id"] {
		t.Fatal("network retry duplicated post")
	}
	rate := f.expect(f.send("POST", "/api/erp/bulletin/messages", cookie, M{"_requestId": "board-message-rate-0002", "body": "too soon"}, nil), 429)
	if rate.header.Get("Retry-After") == "" {
		t.Fatal("rate limited message omitted Retry-After")
	}
	f.expect(f.send("POST", "/api/erp/bulletin/messages", cookie, M{"_requestId": "board-message-create-0001", "body": "different"}, nil), 409)
	f.expect(f.send("POST", "/api/erp/bulletin/messages", otherCookie, M{"body": "missing request id"}, nil), 400)
	f.expect(f.send("POST", "/api/erp/bulletin/messages", otherCookie, M{"_requestId": "board-message-invalid-0001", "body": strings.Repeat("长", 601)}, nil), 400)
	read := f.expect(f.send("GET", "/api/erp/bulletin/messages", otherCookie, nil, nil), 200)
	items := erpflow.Rows(erpflow.Map(read.json["messages"])["items"])
	if len(items) != 1 || items[0]["canDelete"] != false {
		t.Fatal("coworker may manage message")
	}
	path := "/api/erp/bulletin/messages/" + erpflow.S(message["id"]) + "/delete"
	deletion := M{"_requestId": "board-message-selfdelete-0001", "expectedVersion": 1}
	f.expect(f.send("POST", path, otherCookie, deletion, nil), 403)
	f.expect(f.send("POST", path, managerCookie, deletion, nil), 403)
	f.expect(f.send("POST", path, cookie, M{"_requestId": "board-message-stale-delete", "expectedVersion": 2}, nil), 409)
	deleted := f.expect(f.send("POST", path, cookie, deletion, nil), 200)
	if erpflow.Map(deleted.json["message"])["deleted"] != true {
		t.Fatal("self delete did not hide message")
	}
	f.expect(f.send("POST", path, cookie, deletion, nil), 200)
	board := f.expect(f.send("GET", "/api/erp/bulletin", otherCookie, nil, nil), 200)
	if len(erpflow.Rows(erpflow.Map(erpflow.Map(board.json["board"])["messages"])["items"])) != 0 {
		t.Fatal("deleted post still published")
	}
	adminMessage := f.expect(f.send("POST", "/api/erp/bulletin/messages", otherCookie, M{"_requestId": "board-message-moderate-0001", "body": "可管理留言"}, nil), 201)
	f.expect(f.send("POST", "/api/erp/bulletin/messages/"+erpflow.S(erpflow.Map(adminMessage.json["message"])["id"])+"/delete", f.admin, M{"_requestId": "board-admin-moderate-0001", "expectedVersion": 1}, nil), 200)
}
func TestHTTPTrainingImportsActualActiveEmployeesAndVersionedRecordedResults(t *testing.T) {
	f := newApp(t)
	employee, employeeCookie := f.invite("board-training-person", []string{"employee"})
	_, managerCookie := f.invite("board-training-manager", []string{"manager"})
	entry := M{"employeeId": employee["id"], "employeeName": "伪造姓名", "periodStart": "2026-10-01", "periodEnd": "2026-10-31", "completedCount": 123, "accuracy": 98.75, "expectedVersion": 0, "sourceRef": "私有验收批次参考"}
	payload := M{"_requestId": "training-http-import-0001", "entries": []M{entry}}
	f.expect(f.send("POST", "/api/erp/bulletin/training", employeeCookie, payload, nil), 403)
	f.expect(f.send("POST", "/api/erp/bulletin/training", managerCookie, payload, map[string]string{"Origin": "https://evil.test"}), 403)
	result := f.expect(f.send("POST", "/api/erp/bulletin/training", managerCookie, payload, nil), 200)
	items := erpflow.Rows(result.json["entries"])
	if len(items) != 1 || items[0]["employeeName"] != employee["name"] || items[0]["accuracy"] != 98.75 {
		t.Fatalf("training import mistrusted employee %s", result.body)
	}
	f.expect(f.send("POST", "/api/erp/bulletin/training", managerCookie, payload, nil), 200)
	f.expect(f.send("POST", "/api/erp/bulletin/training", managerCookie, M{"_requestId": "training-missing-employee", "entries": []M{{"employeeId": "not-real", "periodStart": "2026-10-01", "periodEnd": "2026-10-31", "completedCount": 1, "accuracy": 90, "expectedVersion": 0}}}, nil), 400)
	f.expect(f.send("POST", "/api/erp/bulletin/training", managerCookie, M{"_requestId": "training-conflict-0001", "entries": []M{entry}}, nil), 409)
	entry["expectedVersion"], entry["completedCount"] = 1, 150
	updated := f.expect(f.send("POST", "/api/erp/bulletin/training", f.admin, M{"_requestId": "training-http-update-0001", "entries": []M{entry}}, nil), 200)
	if erpflow.N(erpflow.Rows(updated.json["entries"])[0]["version"]) != 2 {
		t.Fatal("training update lost version")
	}
	r := f.expect(f.send("GET", "/api/erp/bulletin", employeeCookie, nil, nil), 200)
	training := erpflow.Map(erpflow.Map(r.json["board"])["training"])
	if len(erpflow.Rows(training["entries"])) != 1 || training["canManage"] != false || erpflow.N(erpflow.Rows(training["entries"])[0]["completedCount"]) != 150 || strings.Contains(string(r.body), "私有验收批次参考") || strings.Contains(string(r.body), "伪造姓名") {
		t.Fatalf("leaderboard is not an actual public projection %s", r.body)
	}
	f.expect(f.send("PUT", "/api/erp/users/"+erpflow.S(employee["id"]), f.admin, M{"active": false}, nil), 200)
	f.expect(f.send("POST", "/api/erp/bulletin/training", managerCookie, M{"_requestId": "training-disabled-employee", "entries": []M{entry}}, nil), 400)
	hidden := f.expect(f.send("GET", "/api/erp/bulletin", managerCookie, nil, nil), 200)
	if len(erpflow.Rows(erpflow.Map(erpflow.Map(hidden.json["board"])["training"])["entries"])) != 0 {
		t.Fatal("inactive employee remains on current leaderboard")
	}
	f.expect(f.send("GET", "/api/erp/bulletin", employeeCookie, nil, nil), 401)
}
func TestHTTPVideoConfigurationHasAdminOriginAllowListAndVersionBoundaries(t *testing.T) {
	f := newApp(t)
	_, cookie := f.invite("board-video-reader", []string{"employee"})
	_, managerCookie := f.invite("board-video-manager", []string{"manager"})
	payload := M{"_requestId": "video-http-config-0001", "src": "/media/laisen-film.mp4", "title": "莱森购", "expectedVersion": 0}
	f.expect(f.send("POST", "/api/erp/bulletin/video", cookie, payload, nil), 403)
	f.expect(f.send("POST", "/api/erp/bulletin/video", managerCookie, payload, nil), 403)
	f.expect(f.send("POST", "/api/erp/bulletin/video", f.admin, payload, map[string]string{"Origin": "https://evil.test"}), 403)
	f.expect(f.send("POST", "/api/erp/bulletin/video", f.admin, M{"_requestId": "video-evil-host-0001", "src": "https://evil.test/promo.mp4", "expectedVersion": 0}, nil), 400)
	configured := f.expect(f.send("POST", "/api/erp/bulletin/video", f.admin, payload, nil), 200)
	if erpflow.Map(configured.json["video"])["configured"] != true {
		t.Fatal("valid video not configured")
	}
	f.expect(f.send("POST", "/api/erp/bulletin/video", f.admin, payload, nil), 200)
	f.expect(f.send("POST", "/api/erp/bulletin/video", f.admin, M{"_requestId": "video-stale-config-0001", "src": "", "expectedVersion": 0}, nil), 409)
	f.a.Config.BulletinVideoHosts = []string{"official-media.example.test"}
	external := f.expect(f.send("POST", "/api/erp/bulletin/video", f.admin, M{"_requestId": "video-approved-host-0001", "src": "https://official-media.example.test/promo.webm", "expectedVersion": 1}, nil), 200)
	if erpflow.Map(external.json["video"])["src"] != "https://official-media.example.test/promo.webm" {
		t.Fatal("server-declared media host ignored")
	}
	read := f.expect(f.send("GET", "/api/erp/bulletin", cookie, nil, nil), 200)
	video := erpflow.Map(erpflow.Map(read.json["board"])["video"])
	if video["canManage"] != false || video["title"] != "公司宣传片" || video["configured"] != true {
		t.Fatal("video reader got wrong permissions")
	}
	for method, path := range map[string]string{"GET": "/api/erp/bulletin/training", "PUT": "/api/erp/bulletin/messages"} {
		f.expect(f.send(method, path, f.admin, M{}, nil), 405)
	}
	large := fmt.Sprintf(`{"_requestId":"bulletin-too-large-0001","entries":"%s"}`, strings.Repeat("a", 1048576))
	f.expect(f.send("POST", "/api/erp/bulletin/training", f.admin, large, nil), 413)
}
