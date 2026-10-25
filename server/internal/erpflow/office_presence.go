package erpflow

import (
	_ "embed"
	"encoding/json"
	"math"
	"sort"
	"strings"
	"time"

	"crazyoffice/server/internal/identity"
)

// Geometry contains no employee identity data. It is the server's authority for
// room membership and seat positions; clients cannot invent occupied seats.
//
//go:embed office-layout.json
var officeLayoutJSON []byte

type officePoint struct {
	X float64 `json:"x"`
	Y float64 `json:"y"`
}
type officeSeat struct {
	ID           string  `json:"id"`
	DepartmentID string  `json:"departmentId"`
	X            float64 `json:"x"`
	Y            float64 `json:"y"`
}
type officeRoom struct {
	ID          string        `json:"id"`
	X           float64       `json:"x"`
	Y           float64       `json:"y"`
	W           float64       `json:"w"`
	H           float64       `json:"h"`
	ArrivalLine [2][2]float64 `json:"arrivalLine"`
}

var officeLayout struct {
	Width   float64           `json:"width"`
	Height  float64           `json:"height"`
	Aliases map[string]string `json:"aliases"`
	Rooms   []officeRoom      `json:"rooms"`
	Seats   []officeSeat      `json:"seats"`
}

func init() {
	if err := json.Unmarshal(officeLayoutJSON, &officeLayout); err != nil {
		panic(err)
	}
}
func officeDepartment(value string) string {
	return officeLayout.Aliases[strings.ToLower(strings.ReplaceAll(strings.TrimSpace(value), " ", ""))]
}
func officeRoomAt(x, y float64) string {
	for _, r := range officeLayout.Rooms {
		if x >= r.X && x <= r.X+r.W && y >= r.Y && y <= r.Y+r.H {
			return r.ID
		}
	}
	if x >= -155 && x <= 25 && y >= 810 && y <= 1070 {
		return "data_center"
	}
	if x >= 900 && x <= 1320 && y >= 900 && y <= 1045 {
		return "bulletin"
	}
	return "courtyard"
}
func officeArrival(node string) officePoint {
	for _, r := range officeLayout.Rooms {
		if r.ID == officeDepartment(node) {
			return officePoint{(r.ArrivalLine[0][0] + r.ArrivalLine[1][0]) / 2, r.ArrivalLine[0][1]}
		}
	}
	if node == "bulletin" {
		return officePoint{1110, 975}
	}
	return officePoint{560, 470}
}
func officeNumber(v any) (float64, bool) {
	switch n := v.(type) {
	case float64:
		return n, !math.IsNaN(n) && !math.IsInf(n, 0)
	case json.Number:
		f, e := n.Float64()
		return f, e == nil && !math.IsNaN(f) && !math.IsInf(f, 0)
	case int:
		return float64(n), true
	case int64:
		return float64(n), n >= -9007199254740991 && n <= 9007199254740991
	}
	return 0, false
}

// Leases are process-local: a restart releases every seat. Cookie-derived
// lease identifiers and identity epochs never appear in the public map data.
type officeLease struct {
	epoch   int64
	session string
	legacy  bool
}

const officePresenceTTL = int64(45000)
const officeClosedLeaseTTL = int64(12 * 60 * 60 * 1000)

func (s *Service) expirePresenceLocked(resolve func(string, int64) *identity.Actor) {
	stamp := time.Now().UnixMilli()
	for id, p := range s.presence {
		lease, ok := s.presenceLeases[id]
		actual := resolve(id, lease.epoch)
		if !ok || actual == nil || stamp-N(p["updatedAt"]) >= officePresenceTTL {
			delete(s.presence, id)
			delete(s.presenceLeases, id)
			continue
		}
		// A directory transfer can change memberships without changing the
		// password epoch. Release the previous department's seat immediately.
		x, _ := officeNumber(p["x"])
		y, _ := officeNumber(p["y"])
		if p["posture"] == "seated" && !officeCanSit(actual, x, y, S(p["seatId"]), officeRoomAt(x, y)) {
			p["posture"], p["seatId"], p["revision"] = "standing", "", s.nextPresenceRevisionLocked()
		}
		enrichPresence(p, actual)
	}
	for lease, until := range s.presenceClosed {
		if until <= stamp {
			delete(s.presenceClosed, lease)
		}
	}
}
func (s *Service) onlinePresenceLocked() []M {
	out := make([]M, 0, len(s.presence))
	for _, p := range s.presence {
		out = append(out, Clone(p))
	}
	sort.Slice(out, func(i, j int) bool { return S(out[i]["id"]) < S(out[j]["id"]) })
	return out
}
func (s *Service) nextPresenceRevisionLocked() int64 {
	// Reserve a millisecond range so a restart cannot immediately recycle a
	// rendered client's old small revision. Values remain safe JS integers.
	stamp := uint64(time.Now().UnixMilli()) * 1024
	if stamp > s.presenceSerial {
		s.presenceSerial = stamp
	} else {
		s.presenceSerial++
	}
	return int64(s.presenceSerial)
}

func officeCanSit(a *identity.Actor, x, y float64, seatID, node string) bool {
	if officeDepartment(a.Department) == node {
		return true
	}
	for _, id := range a.DepartmentIDs {
		if officeDepartment(id) == node {
			return true
		}
	}
	return seatID == "" && ((node == "courtyard" && x >= 310 && x <= 810 && y >= 320 && y <= 755) || node == "bulletin")
}
func (s *Service) initialOfficePresenceLocked(a *identity.Actor) M {
	node := officeDepartment(a.Department)
	if len(a.DepartmentIDs) > 0 && officeDepartment(a.DepartmentIDs[0]) != "" {
		node = officeDepartment(a.DepartmentIDs[0])
	}
	if node == "" {
		node = "general_office"
	}
	point := officeArrival(node)
	return M{"id": a.ID, "nodeId": node, "x": point.X, "y": point.Y, "posture": "standing", "seatId": "", "revision": s.nextPresenceRevisionLocked()}
}
func enrichPresence(p M, a *identity.Actor) {
	key := a.ID
	if len(a.OrganizationSeatIDs) > 0 {
		key = a.OrganizationSeatIDs[0]
	}
	p["name"], p["department"], p["title"], p["appearanceKey"] = a.Name, a.Department, a.Title, key
	p["outfitId"] = a.OutfitID
}

// LeaveOffice is retained for trusted server-side administrative cleanup.
func (s *Service) LeaveOffice(id string) {
	s.presenceMu.Lock()
	defer s.presenceMu.Unlock()
	delete(s.presence, id)
	delete(s.presenceLeases, id)
}

// LeaveOfficeSession closes this browser lease even if an already authenticated
// heartbeat arrives late. An old independent login cannot evict a newer one.
func (s *Service) LeaveOfficeSession(id, session string) {
	if id == "" || session == "" {
		return
	}
	s.presenceMu.Lock()
	defer s.presenceMu.Unlock()
	if s.presenceClosed == nil {
		s.presenceClosed = map[string]int64{}
	}
	s.presenceClosed[session] = time.Now().UnixMilli() + officeClosedLeaseTTL
	if lease, ok := s.presenceLeases[id]; ok && lease.session == session {
		delete(s.presence, id)
		delete(s.presenceLeases, id)
	}
}

// JoinOffice is called only after an actual successful browser login. A fresh
// login establishes the default department location and takes over its avatar.
func (s *Service) JoinOffice(a *identity.Actor, session string) ([]M, error) {
	if session == "" {
		return nil, failure(401, "请先登录办公室。")
	}
	return s.updateOfficePresence(a, M{"operation": "heartbeat"}, session, true)
}
func (s *Service) UpdateOfficePresence(a *identity.Actor, input M) ([]M, error) {
	return s.UpdateOfficePresenceSession(a, input, "")
}
func (s *Service) UpdateOfficePresenceSession(a *identity.Actor, input M, session string) ([]M, error) {
	if raw, exists := input["operation"]; exists && raw != nil {
		if value, valid := raw.(string); !valid || value == "legacy" {
			return nil, failure(400, "请选择有效的办公动作。")
		}
	}
	if S(input["operation"]) == "" {
		node := S(input["nodeId"])
		if node == "" {
			node = "workstations"
		}
		if _, ok := presenceAreas[node]; !ok {
			return nil, failure(400, "请选择办公室内的工作区域。")
		}
		input = M{"operation": "legacy", "nodeId": node}
	}
	return s.updateOfficePresence(a, input, session, false)
}
func (s *Service) updateOfficePresence(a *identity.Actor, input M, session string, join bool) ([]M, error) {
	if a == nil || a.ID == "" || s.Identity == nil {
		return nil, failure(401, "请先登录办公室。")
	}
	op := S(input["operation"])
	if op != "legacy" && op != "heartbeat" && op != "move" && op != "sit" && op != "stand" {
		return nil, failure(400, "请选择有效的办公动作。")
	}
	var out []M
	err := s.Identity.ReadActiveSessions(func(resolve func(string, int64) *identity.Actor) error {
		actual := resolve(a.ID, a.Epoch)
		if actual == nil {
			return failure(401, "登录信息已变更，请重新登录。")
		}
		s.presenceMu.Lock()
		defer s.presenceMu.Unlock()
		if s.presenceStopped {
			return failure(503, "办公室正在重启，请稍后再试。")
		}
		if s.presence == nil {
			s.presence = map[string]M{}
		}
		if s.presenceLeases == nil {
			s.presenceLeases = map[string]officeLease{}
		}
		if s.presenceClosed == nil {
			s.presenceClosed = map[string]int64{}
		}
		s.expirePresenceLocked(resolve)
		if session != "" && s.presenceClosed[session] > time.Now().UnixMilli() {
			return failure(401, "此登录已退出，请重新登录。")
		}
		p := Clone(s.presence[actual.ID])
		lease, exists := s.presenceLeases[actual.ID]
		if exists && lease.session != session && !join {
			return failure(401, "此员工已在另一处登录，请重新登录后操作。")
		}
		if join {
			if exists && lease.session != "" && lease.session != session {
				s.presenceClosed[lease.session] = time.Now().UnixMilli() + officeClosedLeaseTTL
			}
			p = nil
			exists = false
		}
		if p == nil {
			p = s.initialOfficePresenceLocked(actual)
		}
		if op != "heartbeat" && op != "legacy" {
			revision, ok := officeNumber(input["expectedRevision"])
			if !ok || revision < 1 || revision > 9007199254740991 || math.Trunc(revision) != revision {
				return failure(400, "请先同步办公室位置。")
			}
			if !exists || int64(revision) != N(p["revision"]) {
				return failure(409, "位置已更新，请重新选择。")
			}
		}
		if op == "sit" {
			seatID := S(input["seatId"])
			var seat *officeSeat
			for i := range officeLayout.Seats {
				if officeLayout.Seats[i].ID == seatID {
					seat = &officeLayout.Seats[i]
					break
				}
			}
			x, y, node := float64(0), float64(0), ""
			if seat != nil {
				x, y, node = seat.X, seat.Y, seat.DepartmentID
			} else if seatID != "" {
				return failure(400, "请选择有效座位。")
			} else {
				var xok, yok bool
				x, xok = officeNumber(input["x"])
				y, yok = officeNumber(input["y"])
				if !xok || !yok || x < 20 || y < 20 || x > officeLayout.Width-20 || y > officeLayout.Height-20 {
					return failure(400, "请选择可坐下的位置。")
				}
				node = officeRoomAt(x, y)
			}
			if !officeCanSit(actual, x, y, seatID, node) {
				return failure(403, "请在本部门或公共休息区选择座位。")
			}
			for id, other := range s.presence {
				if id == actual.ID || S(other["posture"]) != "seated" {
					continue
				}
				ox, _ := officeNumber(other["x"])
				oy, _ := officeNumber(other["y"])
				if (seatID != "" && S(other["seatId"]) == seatID) || math.Hypot(x-ox, y-oy) < 18-1e-9 {
					return failure(409, "这个位置已有人，请选择其他位置。")
				}
			}
			p["seatId"], p["posture"], p["nodeId"], p["x"], p["y"] = seatID, "seated", node, x, y
		} else if op == "move" {
			x, xok := officeNumber(input["x"])
			y, yok := officeNumber(input["y"])
			if !xok || !yok || x < -155 || y < 20 || x > officeLayout.Width-20 || y > officeLayout.Height-20 || (x < 20 && officeRoomAt(x, y) != "data_center") {
				return failure(400, "请选择办公室内可到达的位置。")
			}
			p["x"], p["y"], p["nodeId"], p["seatId"], p["posture"] = x, y, officeRoomAt(x, y), "", "standing"
		} else if op == "stand" {
			p["seatId"], p["posture"] = "", "standing"
		} else if op == "legacy" && (!exists || lease.legacy) {
			node := S(input["nodeId"])
			point := officeArrival(node)
			p["nodeId"], p["x"], p["y"], p["seatId"], p["posture"] = node, point.X, point.Y, "", "standing"
		}
		legacy := op == "legacy" && (!exists || lease.legacy)
		if op != "heartbeat" && !(op == "legacy" && !legacy) {
			p["revision"] = s.nextPresenceRevisionLocked()
		}
		enrichPresence(p, actual)
		p["updatedAt"], p["online"] = time.Now().UnixMilli(), true
		s.presence[actual.ID] = p
		s.presenceLeases[actual.ID] = officeLease{epoch: actual.Epoch, session: session, legacy: legacy}
		out = s.onlinePresenceLocked()
		return nil
	})
	return out, err
}
