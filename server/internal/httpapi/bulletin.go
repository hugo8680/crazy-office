package httpapi

import (
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"regexp"
	"strings"

	"crazyoffice/server/internal/erp"
	"crazyoffice/server/internal/erpflow"
	"crazyoffice/server/internal/identity"
)

var messageDeletePath = regexp.MustCompile(`^/api/erp/bulletin/messages/([A-Za-z0-9_-]{1,100})/delete$`)

func (a *App) bulletinDirectory(actorID string) (map[string]erp.BulletinEmployee, error) {
	employees, err := a.Identity.ListDirectory(actorID)
	if err != nil {
		return nil, err
	}
	directory := make(map[string]erp.BulletinEmployee, len(employees))
	for _, employee := range employees {
		directory[employee.ID] = erp.BulletinEmployee{ID: employee.ID, Name: employee.Name, Department: employee.Department}
	}
	return directory, nil
}
func bulletinError(w http.ResponseWriter, err error) error {
	var domain *erp.Error
	if errors.As(err, &domain) && domain.Status == 429 {
		if details, ok := domain.Details.(map[string]any); ok {
			if retry, ok := details["retryAfterSeconds"].(int64); ok && retry > 0 {
				w.Header().Set("Retry-After", fmt.Sprint(retry))
			}
		}
	}
	return err
}
func (a *App) bulletinOfficialHosts() []string {
	hosts := []string{"office.laisengou.com", "laisengou.com", "www.laisengou.com"}
	if origin, err := url.Parse(a.Config.PublicOrigin); err == nil && origin.Hostname() != "" {
		hosts = append(hosts, origin.Hostname())
	}
	return append(hosts, a.Config.BulletinVideoHosts...)
}
func (a *App) bulletin(w http.ResponseWriter, r *http.Request, actor *identity.Actor) error {
	if r.URL.Path == "/api/erp/bulletin" {
		if r.Method != http.MethodGet {
			w.Header().Set("Allow", "GET")
			return fail(405, "公开栏仅支持读取。")
		}
		directory, err := a.bulletinDirectory(actor.ID)
		if err != nil {
			return err
		}
		board, err := a.Store.Bulletin(r.Context(), erpflow.Actor(actor), erp.BulletinOptions{Directory: directory, PeriodStart: r.URL.Query().Get("periodStart"), PeriodEnd: r.URL.Query().Get("periodEnd"), MessageBeforeID: r.URL.Query().Get("messageBefore")})
		if err != nil {
			return err
		}
		write(w, 200, M{"board": board})
		return nil
	}
	if r.URL.Path == "/api/erp/bulletin/messages" {
		if r.Method == http.MethodGet {
			messages, err := a.Store.BulletinMessages(r.Context(), erpflow.Actor(actor), r.URL.Query().Get("before"))
			if err != nil {
				return err
			}
			write(w, 200, M{"messages": messages})
			return nil
		}
		if r.Method != http.MethodPost {
			w.Header().Set("Allow", "GET, POST")
			return fail(405, "留言仅支持读取和发布。")
		}
		payload, err := body(w, r, 16384)
		if err != nil {
			return err
		}
		key, err := erpflow.RequestID(payload)
		if err != nil {
			return err
		}
		message, err := a.Store.PostBulletinMessage(r.Context(), erpflow.Actor(actor), payload, key)
		if err != nil {
			return bulletinError(w, err)
		}
		write(w, 201, M{"message": message})
		return nil
	}
	if match := messageDeletePath.FindStringSubmatch(r.URL.Path); match != nil {
		if r.Method != http.MethodPost {
			w.Header().Set("Allow", "POST")
			return fail(405, "此地址仅支持删除留言。")
		}
		payload, err := body(w, r, 8192)
		if err != nil {
			return err
		}
		key, err := erpflow.RequestID(payload)
		if err != nil {
			return err
		}
		message, err := a.Store.DeleteBulletinMessage(r.Context(), erpflow.Actor(actor), match[1], payload, key)
		if err != nil {
			return err
		}
		write(w, 200, M{"message": message})
		return nil
	}
	if r.URL.Path == "/api/erp/bulletin/training" {
		if r.Method != http.MethodPost {
			w.Header().Set("Allow", "POST")
			return fail(405, "此地址仅支持录入训练成绩。")
		}
		if !hasRole(actor, "admin") && !hasRole(actor, "manager") {
			return fail(403, "训练成绩由负责人录入。")
		}
		payload, err := body(w, r, 1048576)
		if err != nil {
			return err
		}
		key, err := erpflow.RequestID(payload)
		if err != nil {
			return err
		}
		directory, err := a.bulletinDirectory(actor.ID)
		if err != nil {
			return err
		}
		result, err := a.Store.RecordTrainingScores(r.Context(), erpflow.Actor(actor), payload, key, directory)
		if err != nil {
			return err
		}
		write(w, 200, result)
		return nil
	}
	if r.URL.Path == "/api/erp/bulletin/video" {
		if r.Method != http.MethodPost {
			w.Header().Set("Allow", "POST")
			return fail(405, "此地址仅支持设置宣传片。")
		}
		if !hasRole(actor, "admin") {
			return fail(403, "宣传片由管理员设置。")
		}
		payload, err := body(w, r, 32768)
		if err != nil {
			return err
		}
		key, err := erpflow.RequestID(payload)
		if err != nil {
			return err
		}
		video, err := a.Store.ConfigureBulletinVideo(r.Context(), erpflow.Actor(actor), payload, key, a.bulletinOfficialHosts())
		if err != nil {
			return err
		}
		write(w, 200, M{"video": video})
		return nil
	}
	if strings.HasPrefix(r.URL.Path, "/api/erp/bulletin/") {
		return fail(404, "公开栏地址不存在。")
	}
	return fail(404, "公开栏地址不存在。")
}
