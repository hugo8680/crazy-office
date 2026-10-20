// Package report renders offline HTML documents with the existing office design.
package report

import (
	"bytes"
	_ "embed"
	"github.com/yuin/goldmark"
	"github.com/yuin/goldmark/extension"
	"html"
	"strings"
)

//go:embed template.html
var documentTemplate string

// Document accepts an already escaped/rendered body, never raw user HTML.
func Document(title, escapedBody string) string {
	return strings.NewReplacer("{{TITLE}}", html.EscapeString(title), "{{BODY}}", escapedBody).Replace(documentTemplate)
}

// Markdown deliberately leaves Goldmark's unsafe/raw HTML rendering disabled.
func Markdown(text string) string {
	var b bytes.Buffer
	md := goldmark.New(goldmark.WithExtensions(extension.GFM))
	if err := md.Convert([]byte(text), &b); err != nil {
		return "<p>" + html.EscapeString(text) + "</p>"
	}
	return b.String()
}
