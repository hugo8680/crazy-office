package network

import (
	"net/http/httptest"
	"testing"
)

func policy(t *testing.T, alter func(*Config)) *Policy {
	t.Helper()
	c := Config{Port: 4173, GetAddresses: func() ([]string, error) { return []string{"193.168.10.144", "100.64.10.5"}, nil }, GetHostname: func() (string, error) { return "Hugo-MacBook.local", nil }}
	if alter != nil {
		alter(&c)
	}
	p, e := New(c)
	if e != nil {
		t.Fatal(e)
	}
	return p
}
func TestExactHostAllowlist(t *testing.T) {
	p := policy(t, nil)
	for _, v := range []string{"localhost:4173", "127.0.0.1:4173", "193.168.10.144:4173", "100.64.10.5:4173", "hugo-macbook.local:4173", "Hugo-MacBook:4173"} {
		if !p.AllowsHost(v) {
			t.Fatal("rejected " + v)
		}
	}
	for _, v := range []string{"", "localhost", "localhost:80", "localhost:04173", "localhost:4174", "localhost:99999", " localhost:4173", "localhost:4173 ", "localhost:4173\r\nX-Test: yes", "localhost:4173.evil.test", "localhost.evil.test:4173", "localhost.:4173", "localhost:4173@evil.test", "evil.test@localhost:4173", "localhost:4173/path", "localhost:4173#fragment", "localhost:4173,evil.test", "2130706433:4173", "0x7f000001:4173", "127.1:4173", "192.168.1.2:4173", "193.168.10.145:4173", "evil.local:4173", "0.0.0.0:4173", "[::1]:4173"} {
		if p.AllowsHost(v) {
			t.Fatal("allowed " + v)
		}
	}
}
func TestChangingInterfacesAndURLs(t *testing.T) {
	addresses := []string{"193.168.10.144"}
	p := policy(t, func(c *Config) { c.GetAddresses = func() ([]string, error) { return addresses, nil } })
	if !p.AllowsHost("193.168.10.144:4173") {
		t.Fatal("initial interface")
	}
	addresses = []string{"10.2.3.4"}
	if p.AllowsHost("193.168.10.144:4173") || !p.AllowsHost("10.2.3.4:4173") {
		t.Fatal("stale interface")
	}
	urls := p.URLs()
	if urls.Local == nil || *urls.Local != "http://localhost:4173/" || urls.LANName == nil || *urls.LANName != "http://hugo-macbook.local:4173/" || len(urls.LAN) != 1 {
		t.Fatalf("URLs=%+v", urls)
	}
	loop := policy(t, func(c *Config) { c.BindHost = "127.0.0.1" }).URLs()
	if loop.Local == nil || loop.LANName != nil || len(loop.LAN) != 0 {
		t.Fatal("loopback advertised LAN")
	}
	for _, host := range []string{"invalid/host", "192.168.2.0"} {
		url := policy(t, func(c *Config) { c.GetHostname = func() (string, error) { return host, nil } }).URLs()
		if url.LANName != nil {
			t.Fatal("invalid .local alias")
		}
	}
}
func TestSameOriginMutations(t *testing.T) {
	p := policy(t, nil)
	if !p.AllowsOrigin("http://193.168.10.144:4173", "193.168.10.144:4173") {
		t.Fatal("same-origin rejected")
	}
	for _, v := range []string{"http://localhost:4173", "http://127.0.0.1:4173", "http://evil.test:4173", "https://193.168.10.144:4173", "http://193.168.10.144:4173/", "http://193.168.10.144:4173/path", "http://user@193.168.10.144:4173", "http://193.168.10.144:4173#x", "null"} {
		if p.AllowsOrigin(v, "193.168.10.144:4173") {
			t.Fatal("bad origin " + v)
		}
	}
	r := httptest.NewRequest("POST", "http://193.168.10.144:4173/api", nil)
	r.Header.Set("Origin", "http://193.168.10.144:4173")
	if e := p.ValidateRequest(r); e != nil {
		t.Fatal(e)
	}
	r.Header.Set("Origin", "")
	if e := p.ValidateRequest(r); e == nil {
		t.Fatal("explicit empty Origin accepted")
	}
	r.Header.Del("Origin")
	if e := p.ValidateRequest(r); e != nil {
		t.Fatal("nonbrowser rejected")
	}
	r.Header.Add("Origin", "http://193.168.10.144:4173")
	r.Header.Add("Origin", "http://evil.test")
	if e := p.ValidateRequest(r); e == nil {
		t.Fatal("multiple Origins accepted")
	}
}
func TestPublishedHTTPSAndDefaultPort(t *testing.T) {
	p := policy(t, func(c *Config) { c.PublicOrigin = "https://office.example.test" })
	if !p.AllowsHost("office.example.test") || !p.AllowsOrigin("https://office.example.test", "office.example.test") || p.AllowsOrigin("http://office.example.test", "office.example.test") {
		t.Fatal("published policy")
	}
	r := httptest.NewRequest("POST", "https://office.example.test/api", nil)
	r.Header.Set("Origin", "https://evil.test")
	if e := p.ValidateRequest(r); e == nil {
		t.Fatal("cross origin accepted")
	}
	p = policy(t, func(c *Config) { c.Port = 80 })
	if !p.AllowsHost("localhost") || !p.AllowsHost("localhost:80") || !p.AllowsOrigin("http://localhost", "localhost:80") || p.AllowsOrigin("http://localhost:80", "localhost") {
		t.Fatal("port80 canonicalization")
	}
	for _, port := range []int{0, 65536} {
		if _, e := New(Config{Port: port}); e == nil {
			t.Fatal("invalid port")
		}
	}
}

func TestExplicitDevelopmentProxyPortRetainsSameOriginGuard(t *testing.T) {
	p := policy(t, func(c *Config) { c.Port = 8080; c.AllowedPorts = []int{4173} })
	for _, host := range []string{"localhost:8080", "localhost:4173", "193.168.10.144:4173"} {
		if !p.AllowsHost(host) {
			t.Fatal("development proxy host rejected: " + host)
		}
	}
	for _, host := range []string{"localhost:4174", "localhost:5173", "localhost:04173", "evil.test:4173"} {
		if p.AllowsHost(host) {
			t.Fatal("unlisted development host accepted: " + host)
		}
	}
	if !p.AllowsOrigin("http://localhost:4173", "localhost:4173") || p.AllowsOrigin("http://localhost:8080", "localhost:4173") || p.AllowsOrigin("http://localhost:4173", "localhost:8080") {
		t.Fatal("development ports bypassed exact Origin")
	}
	p = policy(t, func(c *Config) {
		c.Port = 8080
		c.AllowedPorts = []int{4173}
		c.PublicOrigin = "https://office.example.test"
	})
	if p.AllowsHost("localhost:4173") || !p.AllowsHost("localhost:8080") || !p.AllowsHost("office.example.test") {
		t.Fatal("production retained development-only ports")
	}
}
