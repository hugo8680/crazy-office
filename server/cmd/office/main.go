package main

import (
	"bufio"
	"context"
	"errors"
	"flag"
	"fmt"
	"log"
	"net"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"time"

	"crazyoffice/server/internal/agent"
	"crazyoffice/server/internal/httpapi"
	"crazyoffice/server/internal/model"
)

var version = "4.1.1"

func env(key, fallback string) string {
	if value := os.Getenv(key); value != "" {
		return value
	}
	return fallback
}
func loadEnv(path string) error {
	if path == "" {
		return nil
	}
	file, e := os.Open(path)
	if e != nil {
		return e
	}
	defer file.Close()
	info, e := file.Stat()
	if e != nil {
		return e
	}
	if info.Mode().Perm()&0077 != 0 {
		return errors.New("私有环境文件必须为0600权限")
	}
	scanner := bufio.NewScanner(file)
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		key, value, ok := strings.Cut(line, "=")
		if !ok || strings.ContainsAny(key, " \t\r\n") {
			return errors.New("环境文件格式不正确")
		}
		value = strings.TrimSpace(value)
		if len(value) > 1 && (value[0] == '\'' && value[len(value)-1] == '\'' || value[0] == '"' && value[len(value)-1] == '"') {
			value = value[1 : len(value)-1]
		}
		if _, set := os.LookupEnv(key); !set {
			if e = os.Setenv(key, value); e != nil {
				return e
			}
		}
	}
	return scanner.Err()
}
func run() error {
	envFile := flag.String("env-file", "", "私有环境文件，仅在本进程加载")
	listenOverride := flag.String("listen", "", "监听地址，覆盖HOST/PORT")
	dataOverride := flag.String("data-dir", "", "持久数据目录，覆盖OFFICE_DATA_DIR")
	showVersion := flag.Bool("version", false, "显示服务版本")
	flag.Parse()
	if *showVersion {
		fmt.Println("crazy-office-server " + version)
		return nil
	}
	if e := loadEnv(*envFile); e != nil {
		return e
	}
	host := env("HOST", "127.0.0.1")
	port, e := strconv.Atoi(env("PORT", "8080"))
	if e != nil || port < 1 || port > 65535 {
		return errors.New("PORT无效")
	}
	address := net.JoinHostPort(host, strconv.Itoa(port))
	if *listenOverride != "" {
		address = *listenOverride
		h, p, e := net.SplitHostPort(address)
		if e != nil {
			return e
		}
		host = h
		port, e = strconv.Atoi(p)
		if e != nil {
			return e
		}
	}
	listener, e := net.Listen("tcp", address)
	if e != nil {
		return e
	}
	defer listener.Close()
	// Recovery can write run state. Only the listener owner may initialize stores.
	dataDir := env("OFFICE_DATA_DIR", ".office-data")
	if *dataOverride != "" {
		dataDir = *dataOverride
	}
	dataDir, e = filepath.Abs(dataDir)
	if e != nil {
		return e
	}
	if e = os.Setenv("OFFICE_DATA_DIR", dataDir); e != nil {
		return e
	}
	provider := model.NewFromEnv()
	engine, e := agent.New(agent.Config{DataDir: dataDir, Provider: provider, ReceiptHandoff: os.Getenv("OFFICE_RECEIPT_HANDOFF") == "1"})
	if e != nil {
		return e
	}
	automation, e := agent.NewAutomation(agent.AutomationConfig{Engine: engine, StateFile: filepath.Join(dataDir, "automation.json"), CompanyFile: env("OFFICE_COMPANY_FILE", filepath.Join("data", "company", "profile.json"))})
	if e != nil {
		return e
	}
	app, e := httpapi.New(httpapi.Config{DataDir: dataDir, DataAssetsDir: env("OFFICE_ASSETS_DIR", "data"), PublicOrigin: os.Getenv("OFFICE_PUBLIC_ORIGIN"), BindHost: host, Port: port, Username: env("OFFICE_ACCESS_USERNAME", env("OFFICE_ACCESS_USER", "office")), PasswordHash: os.Getenv("OFFICE_ACCESS_PASSWORD_HASH"), SessionSecret: os.Getenv("OFFICE_SESSION_SECRET"), Provider: provider, Lab: engine, Automation: automation, Catalog: agent.Catalog})
	if e != nil {
		return e
	}
	server := &http.Server{Handler: app, ReadHeaderTimeout: 15 * time.Second, ReadTimeout: 30 * time.Second, IdleTimeout: 60 * time.Second, MaxHeaderBytes: 32 * 1024}
	errorsCh := make(chan error, 1)
	go func() { errorsCh <- server.Serve(listener) }()
	log.Printf("Crazy Office API %s listening on %s", version, address)
	signalCtx, stopSignal := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stopSignal()
	monitorCtx, stopMonitor := context.WithCancel(signalCtx)
	defer stopMonitor()
	go monitorModels(monitorCtx, provider, automation.Status)
	select {
	case e = <-errorsCh:
		if e != nil && !errors.Is(e, http.ErrServerClosed) {
			return e
		}
	case <-signalCtx.Done():
	}
	stopMonitor()
	ctx, cancel := context.WithTimeout(context.Background(), 18*time.Second)
	defer cancel()
	applicationErr := app.Close(ctx)
	serverErr := server.Shutdown(ctx)
	return errors.Join(applicationErr, serverErr)
}
func main() {
	if e := run(); e != nil {
		log.Print(e)
		os.Exit(1)
	}
}
