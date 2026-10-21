package main

import (
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"crazyoffice/server/internal/identity"
)

func TestOfflineCLIRequiresExplicitApplyAndPreservesCredentials(t *testing.T) {
	dir := t.TempDir()
	file := filepath.Join(dir, "identities.json")
	if _, err := identity.Open(file, "office"); err != nil {
		t.Fatal(err)
	}
	roster := identity.Roster{Version: 1, Revision: "cli-isolated-test", Employees: []identity.RosterEmployee{{PersonID: "employee:cli-test", Username: "cli-test@laisengou.com", Name: "导入测试", PrimaryDepartmentID: "research", DepartmentIDs: []string{"research"}, Departments: []string{"研发部"}, SeatIDs: []string{"research_staff_001"}, Roles: []string{"employee"}}}}
	raw, _ := json.Marshal(roster)
	source := filepath.Join(dir, "roster.json")
	if err := os.WriteFile(source, raw, 0600); err != nil {
		t.Fatal(err)
	}
	initial, _ := os.ReadFile(file)
	args := []string{"--identity-file", file, "--roster", source}
	var output bytes.Buffer
	if err := execute(args, &output); err != nil || !strings.Contains(output.String(), `"dryRun": true`) {
		t.Fatalf("preview: %s %v", output.String(), err)
	}
	after, _ := os.ReadFile(file)
	if !bytes.Equal(initial, after) {
		t.Fatal("default command mutated identity file")
	}
	if err := execute(append(args, "--apply"), &output); err == nil {
		t.Fatal("write allowed without offline confirmation")
	}
	password := filepath.Join(dir, "initial-password")
	if err := os.WriteFile(password, []byte("admin123\n"), 0600); err != nil {
		t.Fatal(err)
	}
	apply := append(append([]string(nil), args...), "--apply", "--offline", "--initial-password-file", password, "--verify-logins")
	output.Reset()
	if err := execute(apply, &output); err != nil {
		t.Fatal(err)
	}
	if strings.Contains(output.String(), "admin123") || !strings.Contains(output.String(), `"verifiedNewLogins": 1`) {
		t.Fatalf("unsafe or unverified output: %s", output.String())
	}
	before, _ := os.ReadFile(file)
	output.Reset()
	if err := execute(apply, &output); err != nil {
		t.Fatal(err)
	}
	after, _ = os.ReadFile(file)
	if !bytes.Equal(before, after) || !strings.Contains(output.String(), `"unchanged": 1`) {
		t.Fatal("repeated CLI import wrote state")
	}
	if err := os.Chmod(password, 0644); err != nil {
		t.Fatal(err)
	}
	if err := execute(apply, &output); err == nil {
		t.Fatal("public password file accepted")
	}
}
