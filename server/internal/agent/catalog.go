// Package agent coordinates real model-selected office workflows.
package agent

import (
	"crazyoffice/server/internal/model"
	_ "embed"
	"encoding/json"
)

//go:embed catalog.json
var catalogJSON []byte

type TaskSpec struct {
	ID            string   `json:"id"`
	Title         string   `json:"title"`
	AgentID       string   `json:"agentId"`
	NodeID        string   `json:"nodeId"`
	Dependencies  []string `json:"dependencies"`
	Tools         []string `json:"tools"`
	RequiredTools []string `json:"requiredTools"`
	Goal          string   `json:"goal"`
}
type Scenario struct {
	ID     string           `json:"id"`
	Title  string           `json:"title"`
	Fields []map[string]any `json:"fields"`
	Tasks  []TaskSpec       `json:"tasks"`
}

var agents []model.Role
var scenarios map[string]Scenario
var catalog map[string]any
var agentPublic []map[string]any

func init() {
	if e := json.Unmarshal(catalogJSON, &catalog); e != nil {
		panic(e)
	}
	var typed struct {
		Agents    []model.Role `json:"agents"`
		Scenarios []Scenario   `json:"scenarios"`
	}
	if e := json.Unmarshal(catalogJSON, &typed); e != nil {
		panic(e)
	}
	agents = typed.Agents
	scenarios = map[string]Scenario{}
	for _, s := range typed.Scenarios {
		scenarios[s.ID] = s
	}
	agentPublic = objects(catalog["agents"])
}
func Catalog() map[string]any {
	c := copyJSON(catalog)
	for _, s := range objects(c["scenarios"]) {
		for _, t := range objects(s["tasks"]) {
			delete(t, "goal")
			delete(t, "requiredTools")
		}
	}
	return c
}
func roleByID(id string) model.Role {
	for _, a := range agents {
		if a.ID == id {
			return a
		}
	}
	return model.Role{}
}
func ScenarioIDs() []string {
	out := []string{}
	for _, s := range objects(catalog["scenarios"]) {
		out = append(out, text(s["id"]))
	}
	return out
}
