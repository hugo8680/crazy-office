package tools

import (
	"context"
	"crypto/tls"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	xhtml "golang.org/x/net/html"
	"html"
	"io"
	"net"
	"net/http"
	"net/url"
	"regexp"
	"strings"
	"time"
)

type Page struct {
	URL         string `json:"url"`
	Status      int    `json:"status"`
	ContentType string `json:"contentType"`
	Text        string `json:"text"`
	FetchedAt   string `json:"fetchedAt"`
}

func IsPublicAddress(ip net.IP) bool {
	if ip == nil || !ip.IsGlobalUnicast() || ip.IsPrivate() || ip.IsLoopback() || ip.IsLinkLocalUnicast() {
		return false
	}
	for _, s := range []string{"0.0.0.0/8", "100.64.0.0/10", "192.0.0.0/24", "192.0.2.0/24", "198.18.0.0/15", "198.51.100.0/24", "203.0.113.0/24", "224.0.0.0/3", "2001:db8::/32", "2001::/32", "2002::/16"} {
		_, cidr, _ := net.ParseCIDR(s)
		if cidr.Contains(ip) {
			return false
		}
	}
	if ip.To4() == nil && ip[0]&0xe0 != 0x20 {
		return false
	}
	return true
}
func directlyConnected(ip net.IP) bool {
	interfaces, e := net.Interfaces()
	if e != nil {
		return true
	}
	for _, i := range interfaces {
		addrs, _ := i.Addrs()
		for _, a := range addrs {
			_, network, e := net.ParseCIDR(a.String())
			if e == nil && network.Contains(ip) {
				return true
			}
		}
	}
	return false
}
func ValidatePublicURL(ctx context.Context, raw string) (*url.URL, []net.IP, error) {
	u, e := url.Parse(strings.TrimSpace(raw))
	if e != nil || u.Hostname() == "" || u.User != nil || !(u.Scheme == "http" || u.Scheme == "https") || (u.Port() != "" && u.Port() != "80" && u.Port() != "443") {
		return nil, nil, errors.New("仅允许无凭据的公开HTTP(S)网页80/443端口")
	}
	host := strings.ToLower(u.Hostname())
	if host == "localhost" || strings.HasSuffix(host, ".local") || strings.HasSuffix(host, ".internal") || strings.HasSuffix(host, ".test") || strings.HasSuffix(host, ".invalid") {
		return nil, nil, errors.New("拒绝本机或内网URL")
	}
	ips, e := net.DefaultResolver.LookupIP(ctx, "ip", host)
	if e != nil {
		return nil, nil, errors.New("网页域名解析失败")
	}
	if len(ips) == 0 {
		return nil, nil, errors.New("网页未解析到公开地址")
	}
	for _, ip := range ips {
		if !IsPublicAddress(ip) || directlyConnected(ip) {
			return nil, nil, errors.New("拒绝解析到非公开或直连网络的URL")
		}
	}
	u.Fragment = ""
	return u, ips, nil
}
func PublicFetch(ctx context.Context, raw string) (Page, error) {
	ctx, cancel := context.WithTimeout(ctx, 25*time.Second)
	defer cancel()
	for redirects := 0; redirects <= 4; redirects++ {
		u, ips, e := ValidatePublicURL(ctx, raw)
		if e != nil {
			return Page{}, e
		}
		dialer := &net.Dialer{Timeout: 8 * time.Second}
		selectedIP := ips[0]
		for _, ip := range ips {
			if ip.To4() != nil {
				selectedIP = ip
				break
			}
		}
		transport := &http.Transport{Proxy: nil, TLSClientConfig: &tls.Config{MinVersion: tls.VersionTLS12}, DisableCompression: false, DialContext: func(c context.Context, network, addr string) (net.Conn, error) {
			_, port, e := net.SplitHostPort(addr)
			if e != nil {
				return nil, e
			}
			return dialer.DialContext(c, network, net.JoinHostPort(selectedIP.String(), port))
		}}
		client := &http.Client{Transport: transport, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
		req, e := http.NewRequestWithContext(ctx, "GET", u.String(), nil)
		if e != nil {
			return Page{}, e
		}
		req.Header.Set("User-Agent", "Mozilla/5.0 (compatible; CrazyOffice/3.0; evidence research)")
		req.Header.Set("Accept", "text/html,application/json,text/plain")
		resp, e := client.Do(req)
		if e != nil {
			transport.CloseIdleConnections()
			return Page{}, errors.New("公开网页抓取失败：" + e.Error())
		}
		if resp.StatusCode >= 300 && resp.StatusCode < 400 {
			loc, e := resp.Location()
			resp.Body.Close()
			transport.CloseIdleConnections()
			if e != nil {
				return Page{}, errors.New("重定向缺少有效位置")
			}
			raw = loc.String()
			continue
		}
		b, e := io.ReadAll(io.LimitReader(resp.Body, 3*1024*1024+1))
		resp.Body.Close()
		transport.CloseIdleConnections()
		if e != nil {
			return Page{}, e
		}
		if len(b) > 3*1024*1024 {
			return Page{}, errors.New("网页超过3MB上限")
		}
		return Page{URL: u.String(), Status: resp.StatusCode, ContentType: resp.Header.Get("Content-Type"), Text: string(b), FetchedAt: now()}, nil
	}
	return Page{}, errors.New("重定向超过4次")
}
func plainHTML(s string) string {
	root, e := xhtml.Parse(strings.NewReader(s))
	if e != nil {
		return ""
	}
	var b strings.Builder
	var walk func(*xhtml.Node)
	walk = func(n *xhtml.Node) {
		if n.Type == xhtml.ElementNode && (n.Data == "script" || n.Data == "style") {
			return
		}
		if n.Type == xhtml.TextNode {
			b.WriteString(n.Data)
			b.WriteByte(' ')
		}
		for c := n.FirstChild; c != nil; c = c.NextSibling {
			walk(c)
		}
	}
	walk(root)
	return strings.Join(strings.Fields(b.String()), " ")
}
func ExtractQuote(page Page) map[string]any {
	plain := plainHTML(page.Text)
	title := ""
	if m := regexp.MustCompile(`(?is)<title[^>]*>(.*?)</title>`).FindStringSubmatch(page.Text); m != nil {
		title = plainHTML(m[1])
	}
	candidates := []map[string]any{}
	productType := "unverified"
	configuration := []string{}
	var walk func(any, map[string]any)
	walk = func(v any, parent map[string]any) {
		switch x := v.(type) {
		case []any:
			for _, v := range x {
				walk(v, parent)
			}
		case map[string]any:
			typ := str(x["@type"])
			if strings.Contains(strings.ToLower(typ), "product") {
				parent = x
				if strings.Contains(strings.ToLower(str(x["name"])), "server") || regexp.MustCompile(`服务器|PowerEdge|ThinkSystem|ProLiant`).MatchString(str(x["name"])) {
					productType = "server_hardware"
				}
				if title == "" {
					title = str(x["name"])
				}
				configuration = append(configuration, str(x["name"]), str(x["description"]))
			}
			if parent != nil && (strings.Contains(strings.ToLower(typ), "offer") || x["price"] != nil) {
				priceValue := x["price"]
				kind := "offer"
				if priceValue == nil {
					priceValue = x["lowPrice"]
					kind = "starting_price"
				}
				if price, e := Cents(priceValue); e == nil && price > 0 {
					currency := strings.ToUpper(str(x["priceCurrency"]))
					if regexp.MustCompile(`^[A-Z]{3}$`).MatchString(currency) {
						candidates = append(candidates, map[string]any{"price": float64(price) / 100, "amount": float64(price) / 100, "currency": currency, "kind": kind, "product": parent["name"], "evidence": truncate(asJSONString(x), 1800), "method": "JSON-LD Product offer", "evidenceType": "json_ld_offer", "availability": x["availability"]})
					}
				}
			}
			for k, v := range x {
				if k != "description" {
					walk(v, parent)
				}
			}
		}
	}
	for _, m := range regexp.MustCompile(`(?is)<script[^>]*type\s*=\s*["']application/ld\+json["'][^>]*>(.*?)</script>`).FindAllStringSubmatch(page.Text, -1) {
		var v any
		d := json.NewDecoder(strings.NewReader(html.UnescapeString(m[1])))
		d.UseNumber()
		if d.Decode(&v) == nil {
			walk(v, nil)
		}
	}
	if regexp.MustCompile(`(?i)(\bec2\b|\bvirtual\b|\bcloud\b|\bvps\b|云服务器|云主机)`).MatchString(title) {
		productType = "cloud_service"
	} else if regexp.MustCompile(`(?i)(hard drive|memory module|network adapter|power supply|rack rail|内存条|硬盘配件)`).MatchString(title) {
		productType = "component"
	}
	if productType == "unverified" {
		if regexp.MustCompile(`(?i)(cloud|云服务器|每月|/month|hourly)`).MatchString(title) {
			productType = "cloud_service"
		} else if regexp.MustCompile(`(?i)(server|服务器|PowerEdge|ThinkSystem|ProLiant)`).MatchString(title) && !regexp.MustCompile(`(?i)(RAM|memory|内存|配件|硬盘|processor|CPU only)`).MatchString(title) {
			productType = "server_hardware"
		}
	}
	if len(candidates) == 0 {
		patterns := []struct{ RE, Currency string }{{`(?i)(?:US\$|USD\s*\$?)\s*([0-9][0-9,]*(?:\.[0-9]{1,2})?)`, "USD"}, {`(?:¥|￥|CNY\s*|人民币\s*)([0-9][0-9,]*(?:\.[0-9]{1,2})?)`, "CNY"}}
		for _, p := range patterns {
			for _, m := range regexp.MustCompile(p.RE).FindAllStringSubmatch(plain, -1) {
				if n, e := Cents(m[1]); e == nil && n > 0 {
					candidates = append(candidates, map[string]any{"price": float64(n) / 100, "currency": p.Currency, "evidenceType": "visible_page_text_unbound"})
				}
			}
		}
	}
	seen := map[string]bool{}
	prices := []map[string]any{}
	for _, c := range candidates {
		key := fmt.Sprint(c["currency"], c["price"])
		if !seen[key] {
			seen[key] = true
			prices = append(prices, c)
		}
	}
	selected := []string{}
	for _, tag := range regexp.MustCompile(`(?is)<input\b[^>]*>`).FindAllString(page.Text, -1) {
		if regexp.MustCompile(`(?i)\bchecked(?:\s|=|>)`).MatchString(tag) {
			if m := regexp.MustCompile(`(?is)aria-label=["'](.*?)["']`).FindStringSubmatch(tag); m != nil {
				selected = append(selected, html.UnescapeString(m[1]))
			}
		}
	}
	for _, fragment := range regexp.MustCompile(`(?i)\b\d{1,4}\s*(?:GB|TB|MHz|GHz)\b|(?:Intel|AMD|Xeon|EPYC|Ryzen|Core\s+i\d|DDR[345]|PowerEdge|ThinkSystem|ProLiant)[^.;。]{0,100}|\b(?:SSD|HDD|NVMe|RAID|warranty|保修|质保)[^.;。]{0,80}`).FindAllString(plain, 35) {
		configuration = append(configuration, fragment)
	}
	quote := map[string]any{"title": title, "productType": productType, "status": "pending_inquiry", "price": nil, "currency": nil, "priceCandidates": prices, "sourceExcerpt": truncate(plain, 30000), "configurationEvidence": unique(configuration), "selectedConfiguration": unique(selected), "tax": "未知", "shipping": "未知", "warranty": "未知", "reason": "未取得绑定具体整机配置的唯一公开标价，需供应商确认"}
	if len(prices) > 1 {
		quote["status"] = "multiple_price_candidates"
	}
	if len(prices) == 1 && regexp.MustCompile(`^[A-Z]{3}$`).MatchString(str(prices[0]["currency"])) {
		quote["price"] = prices[0]["price"]
		quote["currency"] = prices[0]["currency"]
		quote["status"] = "priced"
		quote["priceKind"] = prices[0]["kind"]
		if prices[0]["evidenceType"] == "visible_page_text_unbound" {
			quote["priceKind"] = "visible_price_candidate"
		}
		quote["availability"] = prices[0]["availability"]
		quote["reason"] = "页面候选展示价；配置、税费与服务仍待核实，不等于已配置整机成交价"
	}
	return quote
}
func truncate(s string, n int) string {
	r := []rune(s)
	if len(r) > n {
		return string(r[:n]) + "…"
	}
	return s
}
func (t *Toolbox) procurement(ctx context.Context, name string, a map[string]any) (map[string]any, []string, error) {
	switch name {
	case "search_web":
		query := str(a["query"])
		if query == "" {
			query = str(t.config.Input["query"])
		}
		if query == "" {
			query = str(t.config.Input["requirements"])
		}
		query = truncate(strings.TrimSpace(query), 400)
		if query == "" {
			return nil, nil, errors.New("检索词不能为空")
		}
		limit := int(number(a["limit"]))
		if limit < 1 || limit > 8 {
			limit = 8
		}
		candidates := []map[string]any{}
		seen := map[string]bool{}
		for _, raw := range stringsOf(t.config.Input["urls"]) {
			u, _, e := ValidatePublicURL(ctx, raw)
			if e != nil {
				return nil, nil, e
			}
			candidates = append(candidates, map[string]any{"url": u.String(), "title": "用户指定候选", "source": "user"})
			seen[u.String()] = true
		}
		attempts := []map[string]any{}
		raw := ""
		for _, endpoint := range []string{"https://www.bing.com/search?q=" + url.QueryEscape(query) + "&cc=us&setlang=en-us", "https://html.duckduckgo.com/html/?q=" + url.QueryEscape(query)} {
			page, e := t.config.Fetch(ctx, endpoint)
			if e != nil {
				attempts = append(attempts, map[string]any{"url": endpoint, "error": e.Error(), "fetchedAt": now()})
				continue
			}
			raw = page.Text
			attempts = append(attempts, map[string]any{"url": page.URL, "status": page.Status, "fetchedAt": page.FetchedAt})
			if page.Status < 200 || page.Status >= 300 {
				continue
			}
			blocks := regexp.MustCompile(`(?is)<li[^>]*class=["'][^"']*b_algo[^"']*["'][^>]*>(.*?)</li>`).FindAllStringSubmatch(raw, -1)
			if len(blocks) == 0 {
				blocks = regexp.MustCompile(`(?is)(<a[^>]*class=["'][^"']*result__a[^"']*["'][^>]*>.*?</a>)`).FindAllStringSubmatch(raw, -1)
			}
			for _, block := range blocks {
				m := regexp.MustCompile(`(?is)<a[^>]*href=["']([^"']+)["'][^>]*>(.*?)</a>`).FindStringSubmatch(block[1])
				if m == nil {
					continue
				}
				u, e := url.Parse(html.UnescapeString(m[1]))
				if e != nil {
					continue
				}
				if unwrapped := u.Query().Get("uddg"); unwrapped != "" {
					u, e = url.Parse(unwrapped)
				}
				if e != nil {
					continue
				}
				if strings.HasSuffix(u.Hostname(), "bing.com") && u.Path == "/ck/a" {
					encoded := u.Query().Get("u")
					if strings.HasPrefix(encoded, "a1") {
						b, e := base64.RawURLEncoding.DecodeString(encoded[2:])
						if e == nil {
							u, e = url.Parse(string(b))
							if e != nil {
								continue
							}
						}
					}
				}
				if u.Hostname() == "" || strings.HasSuffix(u.Hostname(), "bing.com") || strings.HasSuffix(u.Hostname(), "duckduckgo.com") || seen[u.String()] || !(u.Scheme == "https" || u.Scheme == "http") {
					continue
				}
				seen[u.String()] = true
				candidates = append(candidates, map[string]any{"url": u.String(), "title": truncate(plainHTML(m[2]), 250), "source": "live_search"})
			}
			if len(candidates) > 0 {
				break
			}
		}
		if len(candidates) > limit {
			candidates = candidates[:limit]
		}
		ev := map[string]any{"query": query, "scope": "仅本次实际检索及用户候选，不代表全互联网", "attempts": attempts, "candidates": candidates, "retrievedAt": now()}
		_ = t.put("procurement/search.json", ev)
		_ = t.put("procurement/search-evidence.html", raw)
		return receipt(fmt.Sprintf("真实检索取得%d个候选，须继续抓取核实报价", len(candidates)), ev), []string{"procurement/search.json", "procurement/search-evidence.html"}, nil
	case "fetch_quote":
		urls := stringsOf(a["urls"])
		if len(urls) == 0 && a["url"] != nil {
			urls = []string{str(a["url"])}
		}
		urls = unique(urls)
		if len(urls) == 0 || len(urls) > 8 {
			return nil, nil, errors.New("需提供1至8个真实候选URL")
		}
		quotes := []map[string]any{}
		files := []string{}
		for _, raw := range urls {
			u, _, e := ValidatePublicURL(ctx, raw)
			if e != nil {
				return nil, nil, e
			}
			q := map[string]any{}
			for _, old := range t.quotes {
				if old["requestedUrl"] == u.String() {
					q = old
					break
				}
			}
			if len(q) > 0 {
				quotes = append(quotes, q)
				continue
			}
			id := fmt.Sprintf("Q%d", len(t.quotes)+1)
			q = map[string]any{"id": id, "requestedUrl": u.String(), "sourceUrl": u.String(), "fetchedAt": now(), "status": "pending_inquiry", "price": nil, "currency": nil}
			page, e := t.config.Fetch(ctx, u.String())
			if e != nil {
				q["reason"] = e.Error()
			} else {
				q["httpStatus"] = page.Status
				q["sourceUrl"] = page.URL
				q["fetchedAt"] = page.FetchedAt
				if strings.Contains(page.ContentType, "html") || strings.Contains(page.ContentType, "json") || strings.Contains(page.ContentType, "text/plain") {
					f := "procurement/" + id + "-source.html"
					_ = t.put(f, page.Text)
					files = append(files, f)
					for k, v := range ExtractQuote(page) {
						q[k] = v
					}
					if page.Status < 200 || page.Status >= 300 {
						q["status"] = "pending_inquiry"
						q["price"] = nil
						q["currency"] = nil
						q["reason"] = fmt.Sprintf("HTTP %d，错误页价格不采用", page.Status)
					}
				} else {
					q["reason"] = "非可解析网页，待询价"
				}
			}
			t.stateMu.Lock()
			t.quotes = append(t.quotes, q)
			t.stateMu.Unlock()
			quotes = append(quotes, q)
			f := "procurement/" + id + "-evidence.json"
			_ = t.put(f, q)
			files = append(files, f)
		}
		_ = t.put("procurement/quotes.json", t.quotes)
		files = append(files, "procurement/quotes.json")
		return receipt(fmt.Sprintf("真实抓取%d个候选；缺价或受阻保留待询价", len(quotes)), map[string]any{"quotes": quotes, "scope": "仅本次候选，价格与库存以供应商确认时为准"}), files, nil
	case "compare_quotes":
		if len(t.quotes) == 0 {
			return nil, nil, errors.New("请先抓取真实报价")
		}
		rows := []map[string]any{}
		currency := str(t.config.Input["currency"])
		if currency == "" {
			currency = "CNY"
		}
		requested := str(t.config.Input["requirements"])
		var minMem, minSSD any
		if m := regexp.MustCompile(`(?i)(\d+(?:\.\d+)?)\s*GB\s*(?:内存|RAM|memory)`).FindStringSubmatch(requested); m != nil {
			minMem = number(m[1])
		}
		if m := regexp.MustCompile(`(?i)(\d+(?:\.\d+)?)\s*(TB|GB)\s*(?:SSD|NVMe|固态)`).FindStringSubmatch(requested); m != nil {
			n := number(m[1])
			if strings.EqualFold(m[2], "TB") {
				n *= 1024
			}
			minSSD = n
		}
		comparableCount := 0
		for _, q := range t.quotes {
			row := clone(q)
			selected := stringsOf(q["selectedConfiguration"])
			var memory, ssd any
			hasHDD := false
			for _, fragment := range selected {
				if regexp.MustCompile(`(?i)DIMM|RAM|memory|内存`).MatchString(fragment) {
					for _, m := range regexp.MustCompile(`(?i)(\d+)\s*GB`).FindAllStringSubmatch(fragment, -1) {
						if memory == nil || number(m[1]) > number(memory) {
							memory = number(m[1])
						}
					}
				}
				if regexp.MustCompile(`(?i)SSD|NVMe|solid state|固态`).MatchString(fragment) {
					if m := regexp.MustCompile(`(?i)(\d+(?:\.\d+)?)\s*(TB|GB)`).FindStringSubmatch(fragment); m != nil {
						n := number(m[1])
						if strings.EqualFold(m[2], "TB") {
							n *= 1024
						}
						if ssd == nil || n > number(ssd) {
							ssd = n
						}
					}
				}
				hasHDD = hasHDD || regexp.MustCompile(`(?i)Hard Drive|HDD|硬盘`).MatchString(fragment)
			}
			var memMeets, ssdMeets any
			if minMem != nil && memory != nil {
				memMeets = number(memory) >= number(minMem)
			}
			if minSSD != nil && ssd != nil {
				ssdMeets = number(ssd) >= number(minSSD)
			} else if minSSD != nil && hasHDD {
				ssdMeets = false
			}
			checks := map[string]any{"memoryMinimumGb": minMem, "selectedMemoryModuleGb": memory, "memoryMeetsMinimum": memMeets, "ssdMinimumGb": minSSD, "selectedSsdCapacityGb": ssd, "ssdMeetsMinimum": ssdMeets}
			comparable := q["status"] == "priced" && q["productType"] == "server_hardware" && q["currency"] == currency && memMeets == true && ssdMeets == true
			if comparable {
				comparableCount++
			}
			row["technicalChecks"] = checks
			row["comparable"] = comparable
			row["sameBudgetCurrency"] = q["currency"] == currency
			if q["status"] == "priced" && q["currency"] == currency {
				row["listedPriceWithinBudget"] = number(q["price"]) <= number(t.config.Input["budget"])
			} else {
				row["listedPriceWithinBudget"] = nil
			}
			row["comparisonReason"] = "缺乏足够已选配置证据，不能认定等价或最终预算内"
			if comparable {
				row["comparisonReason"] = "公开已选配置符合可自动核对的内存和SSD下限，CPU、税费和服务仍需审查"
			} else if q["status"] != "priced" {
				row["comparisonReason"] = "未获取唯一确认标价"
			} else if q["productType"] != "server_hardware" {
				row["comparisonReason"] = "非整机或类型尚未确认"
			} else if memMeets == false || ssdMeets == false {
				row["comparisonReason"] = "页面已选配置不满足最低内存或SSD要求"
			}
			rows = append(rows, row)
		}
		purpose := str(a["purpose"])
		if purpose == "" {
			purpose = "综合审查"
		}
		ev := map[string]any{"purpose": purpose, "budget": t.config.Input["budget"], "budgetCurrency": currency, "requirements": t.config.Input["requirements"], "quotes": rows, "notes": a["notes"], "comparableQuoteCount": comparableCount, "technicalCheckScope": "仅自动核对明确内存GB及SSD容量的已选配置，不代表CPU兼容性、服务或总成本通过。", "limitations": []string{"公开网页不是书面最终报价。", "未知配置、税费、运输、保修须补充确认；不跨币种换算。", "仅比较本次抓取候选，未执行采购。"}, "purchaseExecuted": false}
		t.serial++
		f := fmt.Sprintf("procurement/comparison-%s-%d.json", sanitize(purpose), t.serial)
		_ = t.put(f, ev)
		csv := [][]any{{"ID", "产品", "状态", "标价", "币种", "来源", "抓取时间", "限制"}}
		for _, q := range rows {
			csv = append(csv, []any{q["id"], q["title"], q["status"], q["price"], q["currency"], q["sourceUrl"], q["fetchedAt"], q["comparisonReason"]})
		}
		cf := strings.TrimSuffix(f, ".json") + ".csv"
		_ = t.put(cf, writeCSV(csv))
		return receipt(fmt.Sprintf("已核对%d个候选，保留配置与总成本缺口，未执行采购", len(rows)), ev), []string{f, cf}, nil
	}
	return nil, nil, errors.New("采购工具无效")
}
