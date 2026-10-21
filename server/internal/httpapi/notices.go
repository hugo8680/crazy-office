package httpapi

import (
	"net/http"
	"regexp"

	"crazyoffice/server/internal/erpflow"
	"crazyoffice/server/internal/identity"
)

var noticePath = regexp.MustCompile(`^/api/erp/notices/([A-Za-z0-9_-]{1,100})$`)

// Authentication, origin policy and the rendered employee binding have already
// been checked by route before any notice handler is reached.
func (a *App) notices(w http.ResponseWriter, r *http.Request, actor *identity.Actor) error {
	if r.URL.Path == "/api/erp/notices" {
		switch r.Method {
		case http.MethodGet:
			result, err := a.Store.Notices(r.Context(), erpflow.Actor(actor))
			if err != nil {
				return err
			}
			write(w, 200, result)
			return nil
		case http.MethodPost:
			payload, err := body(w, r, 65536)
			if err != nil {
				return err
			}
			key, err := erpflow.RequestID(payload)
			if err != nil {
				return err
			}
			notice, err := a.Store.PublishNotice(r.Context(), erpflow.Actor(actor), payload, key)
			if err != nil {
				return err
			}
			write(w, 201, M{"notice": notice})
			return nil
		}
		w.Header().Set("Allow", "GET, POST")
		return fail(405, "公告仅支持读取和发布。")
	}
	match := noticePath.FindStringSubmatch(r.URL.Path)
	if match == nil {
		return fail(404, "公告地址不存在。")
	}
	if r.Method != http.MethodPut {
		w.Header().Set("Allow", "PUT")
		return fail(405, "此地址仅支持修改公告。")
	}
	payload, err := body(w, r, 65536)
	if err != nil {
		return err
	}
	notice, err := a.Store.UpdateNotice(r.Context(), erpflow.Actor(actor), match[1], payload)
	if err != nil {
		return err
	}
	write(w, 200, M{"notice": notice})
	return nil
}
