package httpapi

import (
	"testing"

	"crazyoffice/server/internal/erpflow"
)

func TestHTTPNoticesRequireSessionOriginActorAndPublishingRole(t *testing.T) {
	f := newApp(t)
	employee, employeeCookie := f.invite("notice-reader", []string{"employee"})
	hr, hrCookie := f.invite("notice-editor", []string{"hr"})
	f.expect(f.send("GET", "/api/erp/notices", "", nil, nil), 401)
	empty := f.expect(f.send("GET", "/api/erp/notices", employeeCookie, nil, nil), 200)
	if len(erpflow.Rows(empty.json["notices"])) != 0 || empty.json["canPublish"] != false {
		t.Fatal("empty board invented data or permissions")
	}
	payload := M{"title": "设备盘点通知", "body": "周五核对本部门实际设备。", "_requestId": "notice-http-create-0001", "authorId": employee["id"], "authorName": "伪造发布人"}
	f.expect(f.send("POST", "/api/erp/notices", employeeCookie, payload, nil), 403)
	f.expect(f.send("POST", "/api/erp/notices", hrCookie, payload, map[string]string{"Origin": "https://evil.test"}), 403)
	f.expect(f.send("POST", "/api/erp/notices", hrCookie, payload, map[string]string{"X-Office-Actor": erpflow.S(employee["id"])}), 401)
	created := f.expect(f.send("POST", "/api/erp/notices", hrCookie, payload, nil), 201)
	notice := erpflow.Map(created.json["notice"])
	if notice["authorId"] != hr["id"] || notice["authorName"] != hr["name"] || notice["archived"] != false {
		t.Fatalf("notice trusts client author: %#v", notice)
	}
	id := erpflow.S(notice["id"])
	retry := f.expect(f.send("POST", "/api/erp/notices", hrCookie, payload, nil), 201)
	if erpflow.Map(retry.json["notice"])["id"] != id {
		t.Fatal("POST retry duplicated notice")
	}
	payload["body"] = "不同请求内容"
	f.expect(f.send("POST", "/api/erp/notices", hrCookie, payload, nil), 409)
	f.expect(f.send("PUT", "/api/erp/notices/"+id, employeeCookie, M{"title": "越权", "body": "正文", "expectedVersion": 1}, nil), 403)
	f.expect(f.send("PUT", "/api/erp/notices/"+id, f.admin, M{"title": "修改通知", "body": "周一核对设备。"}, nil), 400)
	changed := f.expect(f.send("PUT", "/api/erp/notices/"+id, f.admin, M{"title": "修改通知", "body": "周一核对设备。", "expectedVersion": 1}, nil), 200)
	if erpflow.N(erpflow.Map(changed.json["notice"])["version"]) != 2 {
		t.Fatal("edit did not advance version")
	}
	f.expect(f.send("PUT", "/api/erp/notices/"+id, f.admin, M{"archived": true, "expectedVersion": 1}, nil), 409)
	f.expect(f.send("PUT", "/api/erp/notices/"+id, f.admin, M{"archived": true, "expectedVersion": 2}, nil), 200)
	read := f.expect(f.send("GET", "/api/erp/notices", employeeCookie, nil, nil), 200)
	if len(erpflow.Rows(read.json["notices"])) != 0 {
		t.Fatal("archived notice remains public")
	}
	manage := f.expect(f.send("GET", "/api/erp/notices", hrCookie, nil, nil), 200)
	if len(erpflow.Rows(manage.json["notices"])) != 1 || manage.json["canPublish"] != true {
		t.Fatal("HR lost archived notice management")
	}
	f.expect(f.send("GET", "/api/erp/notices/"+id, f.admin, nil, nil), 405)
	f.expect(f.send("PUT", "/api/erp/notices/missing", f.admin, M{"title": "正文", "body": "正文", "expectedVersion": 1}, nil), 404)
}
