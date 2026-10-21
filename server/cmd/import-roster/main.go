// import-roster is an offline identity migration, never a public HTTP endpoint.
package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"

	"crazyoffice/server/internal/identity"
	"golang.org/x/sys/unix"
)

func execute(args []string, stdout io.Writer) error {
	flags := flag.NewFlagSet("import-roster", flag.ContinueOnError)
	file := flags.String("identity-file", ".office-data/erp/identities.json", "现有员工账号文件")
	rosterPath := flags.String("roster", ".office-data/provisioning/employee-roster.json", "已核对的员工名册")
	passwordPath := flags.String("initial-password-file", "", "初始密码文件，需0600权限；也可用OFFICE_ROSTER_INITIAL_PASSWORD")
	actorID := flags.String("actor", "bootstrap", "执行导入的管理员ID")
	legacyUsername := flags.String("legacy-username", "office", "现有管理员登录名")
	apply := flags.Bool("apply", false, "提交原子导入；默认只预览")
	dryRun := flags.Bool("dry-run", false, "只预览，不修改账号或审计")
	offline := flags.Bool("offline", false, "确认API已停止，且没有其他写入进程")
	verify := flags.Bool("verify-logins", false, "提交后验证所有新账号的初始密码")
	if err := flags.Parse(args); err != nil {
		return err
	}
	if len(flags.Args()) != 0 {
		return fmt.Errorf("不接受位置参数")
	}
	if *apply && *dryRun {
		return fmt.Errorf("--apply与--dry-run不能同时使用")
	}
	if *apply && !*offline {
		return fmt.Errorf("请先停止API服务，再使用--apply --offline提交导入")
	}
	stat, err := os.Lstat(*file)
	if err != nil {
		return fmt.Errorf("需指定已有账号文件: %w", err)
	}
	if !stat.Mode().IsRegular() {
		return fmt.Errorf("账号文件必须为普通文件")
	}
	rosterFile, err := os.Open(*rosterPath)
	if err != nil {
		return err
	}
	defer rosterFile.Close()
	roster, err := identity.ReadRoster(rosterFile)
	if err != nil {
		return err
	}
	password := ""
	if *apply {
		password = os.Getenv("OFFICE_ROSTER_INITIAL_PASSWORD")
		if *passwordPath != "" {
			st, err := os.Lstat(*passwordPath)
			if err != nil {
				return err
			}
			if !st.Mode().IsRegular() || st.Mode().Perm()&0077 != 0 || st.Size() > 1025 {
				return fmt.Errorf("初始密码文件必须为0600权限的普通文件")
			}
			content, err := os.ReadFile(*passwordPath)
			if err != nil {
				return err
			}
			password = strings.TrimSuffix(strings.TrimSuffix(string(content), "\n"), "\r")
		}
	}
	// A second import cannot race this one. The API must separately be stopped:
	// its in-memory identity store deliberately does not reload external changes.
	var lock *os.File
	if *apply {
		lock, err = os.OpenFile(filepath.Clean(*file)+".roster-import.lock", os.O_CREATE|os.O_RDWR, 0600)
		if err != nil {
			return err
		}
		defer lock.Close()
		if err = unix.Flock(int(lock.Fd()), unix.LOCK_EX|unix.LOCK_NB); err != nil {
			return fmt.Errorf("另一个名册导入正在执行")
		}
		defer unix.Flock(int(lock.Fd()), unix.LOCK_UN)
	}
	store, err := identity.Open(*file, *legacyUsername)
	if err != nil {
		return err
	}
	before, err := store.ListEmployees(*actorID)
	if err != nil {
		return err
	}
	existing := map[string]bool{}
	for _, e := range before {
		existing[e.Username] = true
	}
	report, err := store.ImportRoster(roster, identity.ImportOptions{ActorID: *actorID, InitialPassword: password, DryRun: !*apply})
	if err != nil {
		return err
	}
	verified := 0
	if *verify && *apply {
		for _, e := range roster.Employees {
			if existing[e.Username] {
				continue
			}
			actor, err := store.Authenticate(e.Username, password)
			if err != nil {
				return err
			}
			if actor == nil || actor.Name != e.Name || actor.OrganizationPersonID != e.PersonID || actor.Department != e.Departments[0] || actor.Title != e.Title || actor.Placeholder != e.Placeholder || strings.Join(actor.Departments, "\x00") != strings.Join(e.Departments, "\x00") || strings.Join(actor.DepartmentIDs, "\x00") != strings.Join(e.DepartmentIDs, "\x00") || strings.Join(actor.OrganizationSeatIDs, "\x00") != strings.Join(e.SeatIDs, "\x00") || strings.Join(actor.Roles, "\x00") != strings.Join(e.Roles, "\x00") {
				return fmt.Errorf("新账号验证失败: %s", e.Username)
			}
			verified++
		}
	}
	result := struct {
		*identity.ImportReport
		VerifiedNewLogins int `json:"verifiedNewLogins"`
	}{report, verified}
	encoder := json.NewEncoder(stdout)
	encoder.SetIndent("", "  ")
	return encoder.Encode(result)
}
func main() {
	if err := execute(os.Args[1:], os.Stdout); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}
