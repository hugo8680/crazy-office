// Package network protects local deployments with an exact, refreshed Host list.
package network

import (
	"fmt"
	"net"
	"net/http"
	"net/url"
	"os"
	"regexp"
	"sort"
	"strconv"
	"strings"

	"crazyoffice/server/internal/access"
	"crazyoffice/server/internal/identity"
)

type Config struct {
	Port int
	// Explicit development proxy ports; ignored for a published HTTPS origin.
	AllowedPorts           []int
	BindHost, PublicOrigin string
	GetAddresses           func() ([]string, error)
	GetHostname            func() (string, error)
}
type Policy struct {
	config    Config
	published *url.URL
}
type URLSet struct {
	Local   *string  `json:"local"`
	LANName *string  `json:"lanName"`
	LAN     []string `json:"lan"`
}

var authorityPattern = regexp.MustCompile(`(?i)^([a-z0-9.-]+)(?::([0-9]{1,5}))?$`)
var hostnamePattern = regexp.MustCompile(`^[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?$`)

func systemAddresses() ([]string, error) {
	interfaces, e := net.Interfaces()
	if e != nil {
		return nil, e
	}
	out := []string{}
	seen := map[string]bool{}
	for _, in := range interfaces {
		if in.Flags&net.FlagLoopback != 0 {
			continue
		}
		addrs, e := in.Addrs()
		if e != nil {
			continue
		}
		for _, a := range addrs {
			ip, _, e := net.ParseCIDR(a.String())
			if e == nil && ip.To4() != nil && !ip.IsUnspecified() && !ip.IsLoopback() {
				v := ip.To4().String()
				if !seen[v] {
					out = append(out, v)
					seen[v] = true
				}
			}
		}
	}
	sort.Strings(out)
	return out, nil
}
func New(c Config) (*Policy, error) {
	if c.Port < 1 || c.Port > 65535 {
		return nil, fmt.Errorf("PORT 必须是 1 至 65535 的整数。")
	}
	if c.BindHost == "" {
		c.BindHost = "0.0.0.0"
	}
	if c.GetAddresses == nil {
		c.GetAddresses = systemAddresses
	}
	if c.GetHostname == nil {
		c.GetHostname = os.Hostname
	}
	if c.PublicOrigin != "" {
		c.AllowedPorts = nil
	} else {
		c.AllowedPorts = append([]int{}, c.AllowedPorts...)
		for _, port := range c.AllowedPorts {
			if port < 1 || port > 65535 {
				return nil, fmt.Errorf("AllowedPorts 必须是 1 至 65535 的整数。")
			}
		}
	}
	p := &Policy{config: c}
	if c.PublicOrigin != "" {
		origin, e := access.HTTPSOrigin(c.PublicOrigin)
		if e != nil {
			return nil, e
		}
		p.published, _ = url.Parse(origin)
	}
	return p, nil
}
func names(v string) []string {
	v = strings.ToLower(v)
	if net.ParseIP(v) != nil || !hostnamePattern.MatchString(v) || strings.Contains(v, "..") {
		return nil
	}
	if strings.HasSuffix(v, ".local") {
		return []string{v, strings.TrimSuffix(v, ".local")}
	}
	return []string{v, v + ".local"}
}
func (p *Policy) snapshot() ([]string, map[string]bool, string) {
	addresses, _ := p.config.GetAddresses()
	machine, _ := p.config.GetHostname()
	hosts := map[string]bool{"localhost": true, "127.0.0.1": true}
	real := []string{}
	for _, v := range addresses {
		ip := net.ParseIP(v)
		if ip != nil && ip.To4() != nil && !ip.IsUnspecified() && !ip.IsLoopback() {
			hosts[v] = true
			real = append(real, v)
		}
	}
	localName := ""
	for _, n := range names(machine) {
		hosts[n] = true
		if strings.HasSuffix(n, ".local") {
			localName = n
		}
	}
	return real, hosts, localName
}
func (p *Policy) authority(value string) (host, canonical string, ok bool) {
	if len(value) > 300 || value != strings.TrimSpace(value) {
		return
	}
	m := authorityPattern.FindStringSubmatch(value)
	if m == nil {
		return
	}
	portValue := m[2]
	if portValue == "" {
		portValue = "80"
	}
	port, e := strconv.Atoi(portValue)
	acceptedPort := port == p.config.Port
	for _, allowed := range p.config.AllowedPorts {
		if allowed == port {
			acceptedPort = true
		}
	}
	if e != nil || strconv.Itoa(port) != portValue || !acceptedPort {
		return
	}
	host = strings.ToLower(m[1])
	canonical = host
	if port != 80 {
		canonical += ":" + strconv.Itoa(port)
	}
	return host, canonical, true
}
func (p *Policy) AllowsHost(value string) bool {
	if p.published != nil && value == p.published.Host {
		return true
	}
	host, _, ok := p.authority(value)
	_, hosts, _ := p.snapshot()
	return ok && hosts[host]
}

// AllowsOrigin takes an empty value only for genuinely absent Origin headers.
// Call ValidateRequest when distinguishing a supplied empty header matters.
func (p *Policy) AllowsOrigin(origin, hostHeader string) bool {
	return p.allowsOrigin(origin, hostHeader, origin != "")
}
func (p *Policy) allowsOrigin(origin, hostHeader string, present bool) bool {
	if p.published != nil && hostHeader == p.published.Host {
		return !present || origin == p.published.Scheme+"://"+p.published.Host
	}
	host, canonical, ok := p.authority(hostHeader)
	_, hosts, _ := p.snapshot()
	if !ok || !hosts[host] {
		return false
	}
	if !present {
		return true
	}
	if len(origin) > 320 {
		return false
	}
	u, e := url.Parse(origin)
	if e != nil || u.Scheme != "http" || u.User != nil || u.Path != "" || u.RawQuery != "" || u.Fragment != "" || u.Opaque != "" {
		return false
	}
	normalizedHost := strings.ToLower(u.Host)
	if strings.HasSuffix(normalizedHost, ":80") {
		normalizedHost = strings.TrimSuffix(normalizedHost, ":80")
	}
	return origin == "http://"+normalizedHost && u.Host == canonical
}
func (p *Policy) ValidateRequest(req *http.Request) error {
	if !p.AllowsHost(req.Host) {
		return identity.Fail(403, "Host not allowed")
	}
	if req.Method != "GET" && req.Method != "HEAD" {
		values, present := req.Header["Origin"]
		if present && len(values) != 1 {
			return identity.Fail(403, "只接受当前办公室页面同源发起的操作。")
		}
		if !p.allowsOrigin(req.Header.Get("Origin"), req.Host, present) {
			return identity.Fail(403, "只接受当前办公室页面同源发起的操作。")
		}
	}
	return nil
}
func (p *Policy) URLs() URLSet {
	addresses, _, name := p.snapshot()
	suffix := ""
	if p.config.Port != 80 {
		suffix = ":" + strconv.Itoa(p.config.Port)
	}
	local := "http://localhost" + suffix + "/"
	out := URLSet{LAN: []string{}}
	if p.config.BindHost == "0.0.0.0" {
		out.Local = &local
		if len(addresses) > 0 && name != "" {
			v := "http://" + name + suffix + "/"
			out.LANName = &v
		}
		for _, address := range addresses {
			out.LAN = append(out.LAN, "http://"+address+suffix+"/")
		}
	} else if p.config.BindHost == "127.0.0.1" || p.config.BindHost == "localhost" {
		out.Local = &local
	} else {
		for _, address := range addresses {
			if address == p.config.BindHost {
				out.LAN = append(out.LAN, "http://"+address+suffix+"/")
			}
		}
	}
	return out
}
