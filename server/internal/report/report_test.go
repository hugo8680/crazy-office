package report

import (
	"strings"
	"testing"
)

func TestDocumentPreservesSkinAndEscapesTitle(t *testing.T) {
	got := Document("<img src=x onerror=alert(1)>", "<p>实际记录</p>")
	for _, text := range []string{"report-document", "@media print", "@page", "&lt;img", "<p>实际记录</p>", "default-src 'none'"} {
		if !strings.Contains(got, text) {
			t.Errorf("missing %q", text)
		}
	}
	if strings.Contains(got, "<h1><img") {
		t.Fatal("raw title HTML")
	}
}
func TestMarkdownRejectsRawHTMLAndScriptLinks(t *testing.T) {
	got := Markdown("# 标题\n<script>alert(1)</script>\n\n[bad](javascript:alert(1))\n\n|字段|值|\n|---|---|\n|数量|2|")
	if strings.Contains(got, "<script>") || strings.Contains(got, `href="javascript:`) {
		t.Fatal(got)
	}
	if !strings.Contains(got, "<table>") {
		t.Fatal("GFM table missing")
	}
}
