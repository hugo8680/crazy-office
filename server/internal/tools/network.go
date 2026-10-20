package tools

import (
	"context"
	"errors"
	"fmt"
	"net"
	"regexp"
	"sort"
	"strings"
	"time"
)

func (t *Toolbox) network(ctx context.Context, name string, a map[string]any) (map[string]any, []string, error) {
	switch name {
	case "inspect_network":
		raw, e := source(t.config.Input["logs"])
		if e != nil {
			return nil, nil, e
		}
		if m, ok := raw.(map[string]any); ok {
			for _, k := range []string{"requests", "logs", "data"} {
				if m[k] != nil {
					raw = m[k]
					break
				}
			}
		}
		if text, ok := raw.(string); ok {
			pattern := regexp.MustCompile(`^(\S+)\s+\S+\s+\S+\s+\[([^]]+)\]\s+"(\S+)\s+([^ ]+)\s+[^"]+"\s+(\d{3})`)
			rows := []map[string]any{}
			for _, l := range strings.Split(text, "\n") {
				if strings.TrimSpace(l) == "" {
					continue
				}
				m := pattern.FindStringSubmatch(l)
				if m == nil {
					return nil, nil, errors.New("access log格式错误")
				}
				dt, e := time.Parse("02/Jan/2006:15:04:05 -0700", m[2])
				if e != nil {
					return nil, nil, e
				}
				rows = append(rows, map[string]any{"ip": m[1], "timestamp": dt.Format(time.RFC3339), "method": m[3], "path": m[4], "status": m[5]})
			}
			raw = rows
		}
		rr, err := strictMaps(raw, "访问日志")
		if err != nil {
			return nil, nil, err
		}
		if len(rr) == 0 || len(rr) > 100000 {
			return nil, nil, errors.New("访问日志需要1至100000条记录")
		}
		rows := []map[string]any{}
		ips := map[string]bool{}
		labels := map[string]int{"normal": 0, "malicious": 0, "unknown": 0}
		errorsN := 0
		for i, r := range rr {
			ip := str(r["ip"])
			if ip == "" {
				ip = str(r["source_ip"])
			}
			if net.ParseIP(ip) == nil {
				return nil, nil, fmt.Errorf("第%d条IP无效", i+1)
			}
			ip = net.ParseIP(ip).String()
			stamp := str(r["timestamp"])
			if stamp == "" {
				stamp = str(r["time"])
			}
			dt, e := time.Parse(time.RFC3339Nano, stamp)
			if e != nil {
				return nil, nil, fmt.Errorf("第%d条时间须为带时区ISO8601", i+1)
			}
			status := int(number(r["status"]))
			if r["status"] == nil {
				status = 200
			}
			if status < 100 || status > 599 {
				return nil, nil, errors.New("HTTP状态码应为100至599")
			}
			label := strings.ToLower(str(r["label"]))
			if label == "" {
				label = "unknown"
			}
			if _, ok := labels[label]; !ok {
				return nil, nil, errors.New("label只支持normal/malicious/unknown")
			}
			labels[label]++
			if status >= 500 {
				errorsN++
			}
			ips[ip] = true
			method := str(r["method"])
			if method == "" {
				method = "GET"
			}
			path := str(r["path"])
			if path == "" {
				path = "/"
			}
			rows = append(rows, map[string]any{"id": i + 1, "ip": ip, "timestamp": stamp, "epoch": float64(dt.Unix()) + float64(dt.Nanosecond())/1e9, "method": method, "path": path, "status": status, "label": label})
		}
		sort.SliceStable(rows, func(i, j int) bool { return number(rows[i]["epoch"]) < number(rows[j]["epoch"]) })
		ev := map[string]any{"requests": len(rows), "sources": len(ips), "windowStart": rows[0]["timestamp"], "windowEnd": rows[len(rows)-1]["timestamp"], "windowSeconds": max(1, number(rows[len(rows)-1]["epoch"])-number(rows[0]["epoch"])), "errorRequests": errorsN, "labels": labels, "environment": "本次任务隔离请求重放；不连接或改变生产网络"}
		_ = t.put("network/requests.json", rows)
		var access strings.Builder
		for _, row := range rows {
			access.WriteString(asJSONString(row))
			access.WriteByte('\n')
		}
		_ = t.put("network/access.log", access.String())
		_ = t.put("network/inspection.json", ev)
		return receipt(fmt.Sprintf("读取%d条真实输入日志，%d个来源", len(rows), len(ips)), ev), []string{"network/requests.json", "network/inspection.json", "network/access.log"}, nil
	case "analyze_traffic":
		var rows []map[string]any
		if e := t.read("network/requests.json", &rows); e != nil {
			return nil, nil, errors.New("请先读取日志")
		}
		threshold := int(number(a["threshold"]))
		if a["threshold"] == nil {
			threshold = int(number(t.config.Input["threshold"]))
		}
		if a["threshold"] == nil && t.config.Input["threshold"] == nil {
			threshold = 20
		}
		window := int(number(a["windowSeconds"]))
		if a["windowSeconds"] == nil {
			window = 60
		}
		if threshold < 1 || threshold > 100000 || window < 1 || window > 3600 {
			return nil, nil, errors.New("阈值或时间窗超出范围")
		}
		by := map[string][]map[string]any{}
		for _, r := range rows {
			ip := str(r["ip"])
			by[ip] = append(by[ip], r)
		}
		sources := []map[string]any{}
		suspected := []string{}
		for ip, rs := range by {
			peak, start, errorsN := 0, 0, 0
			paths := map[string]int{}
			for end, r := range rs {
				for start <= end && number(rs[start]["epoch"]) <= number(r["epoch"])-float64(window) {
					start++
				}
				peak = max(peak, end-start+1)
				if number(r["status"]) >= 500 {
					errorsN++
				}
				paths[str(r["path"])]++
			}
			sources = append(sources, map[string]any{"ip": ip, "requests": len(rs), "peakRequestsPerWindow": peak, "windowSeconds": window, "threshold": threshold, "overThreshold": peak > threshold, "errorRequests": errorsN, "topPaths": paths, "evidenceSample": rs[:min(3, len(rs))]})
			if peak > threshold {
				suspected = append(suspected, ip)
			}
		}
		sort.Slice(sources, func(i, j int) bool {
			return number(sources[i]["peakRequestsPerWindow"]) > number(sources[j]["peakRequestsPerWindow"])
		})
		ev := map[string]any{"threshold": threshold, "windowSeconds": window, "sources": sources, "suspectedSources": suspected, "limitations": []string{"高频可能包含共享出口，不能凭数量认定攻击。", "规则只对本次离线重放有效，生产DDoS需要上游清洗及监控。"}}
		_ = t.put("network/analysis.json", ev)
		return receipt(fmt.Sprintf("滑动时间窗分析完成，%d个来源超阈值", len(suspected)), ev), []string{"network/analysis.json"}, nil
	case "apply_defense":
		var analysis map[string]any
		if e := t.read("network/analysis.json", &analysis); e != nil {
			return nil, nil, errors.New("先完成日志分析")
		}
		known := map[string]bool{}
		for _, s := range maps(analysis["sources"]) {
			known[str(s["ip"])] = true
		}
		blocked := unique(stringsOf(a["blockedIps"]))
		for i, ip := range blocked {
			parsed := net.ParseIP(ip)
			if parsed == nil {
				return nil, nil, errors.New("封禁IP无效")
			}
			ip = parsed.String()
			blocked[i] = ip
			if !known[ip] {
				return nil, nil, errors.New("不能封禁无效或未出现在证据中的IP")
			}
		}
		var limit any
		if a["rateLimit"] != nil {
			n := number(a["rateLimit"])
			if n < 1 || n > 100000 || n != float64(int(n)) {
				return nil, nil, errors.New("速率阈值无效")
			}
			limit = int(n)
		}
		window := int(number(a["windowSeconds"]))
		if window == 0 {
			window = int(number(analysis["windowSeconds"]))
		}
		if window < 1 || window > 3600 || len(blocked) == 0 && limit == nil {
			return nil, nil, errors.New("需基于证据的IP或速率策略")
		}
		reason := strings.TrimSpace(str(a["reason"]))
		if reason == "" {
			return nil, nil, errors.New("方案需说明证据与误伤风险")
		}
		policy := map[string]any{"blockedIps": blocked, "rateLimit": limit, "windowSeconds": window, "reason": reason, "environment": "仅本次run隔离副本，不修改主机或生产网络", "createdAt": now()}
		_ = t.put("network/proposal.json", policy)
		_, _ = t.register("network/proposal.json")
		if t.config.Approval == nil {
			return nil, nil, errors.New("缺少真人审批入口")
		}
		decision, e := t.config.Approval(ctx, map[string]any{"title": "批准隔离防护方案", "description": "仅在本次离线日志副本应用，生成配置并独立重放验证。", "kind": "ddos", "agentId": "zhang", "targetHumanId": "it_owner", "details": policy})
		if e != nil {
			return nil, nil, e
		}
		policy["approved"] = decision["approved"] == true
		policy["approvalNote"] = decision["note"]
		policy["approvalActorKind"] = approvalActorKind(decision)
		policy["approvedAt"] = now()
		_ = t.put("network/defense.json", policy)
		files := []string{"network/proposal.json", "network/defense.json"}
		summary := "真人拒绝方案，未应用防护"
		if decision["approved"] == true {
			lines := []string{"# 隔离策略交付片段；未安装或修改任何生产服务"}
			for _, ip := range blocked {
				lines = append(lines, "deny "+ip+";")
			}
			if limit != nil {
				lines = append(lines, fmt.Sprintf("# http context\nlimit_req_zone $binary_remote_addr zone=office_rescue:10m rate=%dr/m;\n# server/location context\nlimit_req zone=office_rescue burst=%d nodelay;", max(1, int(number(limit)/float64(window)*60)), int(number(limit))))
			}
			_ = t.put("network/nginx-defense.conf", strings.Join(lines, "\n")+"\n")
			files = append(files, "network/nginx-defense.conf")
			summary = "真人批准，策略写入本次隔离重放配置"
		}
		if policy["approvalActorKind"] == "isolated_test_operator" {
			summary = "隔离测试账号已提交样例审批回执；仅写入本次隔离重放配置，不代表真人业务审批"
		}
		return receipt(summary, policy), files, nil
	case "verify_network":
		var rows []map[string]any
		if e := t.read("network/requests.json", &rows); e != nil {
			return nil, nil, e
		}
		policy := map[string]any{}
		_ = t.read("network/defense.json", &policy)
		approved := policy["approved"] == true
		blockedIPs := map[string]bool{}
		if approved {
			for _, ip := range stringsOf(policy["blockedIps"]) {
				blockedIPs[ip] = true
			}
		}
		limit := 0
		if approved {
			limit = int(number(policy["rateLimit"]))
		}
		window := number(policy["windowSeconds"])
		if window == 0 {
			window = 60
		}
		history := map[string][]float64{}
		results := []map[string]any{}
		normal, bad, unknown, normalpass, badblock, accepted := 0, 0, 0, 0, 0, 0
		for _, r := range rows {
			ip := str(r["ip"])
			epoch := number(r["epoch"])
			hh := history[ip]
			for len(hh) > 0 && hh[0] <= epoch-window {
				hh = hh[1:]
			}
			limited := limit > 0 && len(hh) >= limit
			pass := !blockedIPs[ip] && !limited
			history[ip] = append(hh, epoch)
			if pass {
				accepted++
			}
			switch str(r["label"]) {
			case "normal":
				normal++
				if pass {
					normalpass++
				}
			case "malicious":
				bad++
				if !pass {
					badblock++
				}
			default:
				unknown++
			}
			reason := "允许"
			if blockedIPs[ip] {
				reason = "IP规则拒绝"
			} else if limited {
				reason = "速率规则拒绝"
			}
			results = append(results, map[string]any{"id": r["id"], "ip": ip, "path": r["path"], "label": r["label"], "accepted": pass, "reason": reason, "originalStatus": r["status"]})
		}
		restored := approved && normal > 0 && bad > 0 && unknown == 0 && normalpass == normal && badblock == bad
		ev := map[string]any{"approved": approved, "totalRequests": len(rows), "accepted": accepted, "blocked": len(rows) - accepted, "normalRequests": normal, "normalPassed": normalpass, "falsePositives": normal - normalpass, "maliciousRequests": bad, "maliciousBlocked": badblock, "unknownLabelRequests": unknown, "verifiedRestored": restored, "normalPassRate": ratio(normalpass, normal), "maliciousBlockRate": ratio(badblock, bad), "limitations": []string{"离线重放不等于生产恢复；验收标签来自原始输入。"}}
		_ = t.put("network/replay.json", results)
		csv := [][]any{{"id", "ip", "path", "label", "accepted", "reason", "originalStatus"}}
		for _, r := range results {
			csv = append(csv, []any{r["id"], r["ip"], r["path"], r["label"], r["accepted"], r["reason"], r["originalStatus"]})
		}
		_ = t.put("network/replay.csv", writeCSV(csv))
		_ = t.put("network/verification.json", ev)
		summary := "隔离重放尚不能确认恢复，检查漏拦、误伤与缺失标签"
		if restored {
			summary = "隔离重放符合本次带标签日志验收条件"
		}
		return receipt(summary, ev), []string{"network/replay.json", "network/verification.json", "network/replay.csv"}, nil
	}
	return nil, nil, errors.New("网络工具无效")
}
func ratio(n, d int) any {
	if d == 0 {
		return nil
	}
	return float64(n) / float64(d)
}
