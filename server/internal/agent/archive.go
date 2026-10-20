package agent

import (
	"archive/zip"
	"bytes"
	"crazyoffice/server/internal/tools"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"golang.org/x/text/unicode/norm"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"unicode"
	"unicode/utf8"
)

func (e *Engine) Artifact(id, artifactID string) (tools.Artifact, error) {
	e.mu.RLock()
	defer e.mu.RUnlock()
	r := e.runs[id]
	if r == nil {
		return tools.Artifact{}, apiError(404, "找不到这个任务")
	}
	var found map[string]any
	for _, a := range objects(r["artifacts"]) {
		if a["id"] == artifactID {
			found = a
			break
		}
	}
	if found == nil {
		return tools.Artifact{}, apiError(404, "文件不存在")
	}
	dir := text(r["runDir"])
	path := text(found["path"])
	if !filepath.IsAbs(path) {
		path = filepath.Join(dir, path)
	}
	rel, err := filepath.Rel(dir, path)
	if err != nil || rel == ".." || strings.HasPrefix(rel, ".."+string(filepath.Separator)) {
		return tools.Artifact{}, apiError(403, "文件路径无效")
	}
	resolved, err := filepath.EvalSymlinks(path)
	if err != nil {
		return tools.Artifact{}, apiError(404, "文件不存在")
	}
	resolvedDir, err := filepath.EvalSymlinks(dir)
	if err != nil {
		return tools.Artifact{}, apiError(404, "任务目录不存在")
	}
	rel, err = filepath.Rel(resolvedDir, resolved)
	if err != nil || rel == ".." || strings.HasPrefix(rel, ".."+string(filepath.Separator)) {
		return tools.Artifact{}, apiError(403, "文件路径无效")
	}
	st, err := os.Stat(resolved)
	if err != nil || !st.Mode().IsRegular() {
		return tools.Artifact{}, apiError(404, "文件不存在")
	}
	return tools.Artifact{ID: artifactID, Name: filepath.Base(text(found["name"])), Path: path, MimeType: text(found["mimeType"]), Bytes: st.Size()}, nil
}
func (e *Engine) Archive(id string) ([]byte, error) {
	e.mu.RLock()
	r := copyJSON(e.runs[id])
	e.mu.RUnlock()
	if r == nil {
		return nil, apiError(404, "找不到这个任务")
	}
	arts := objects(r["artifacts"])
	if len(arts) == 0 {
		return nil, apiError(409, "任务尚无可下载产物")
	}
	if len(arts) > 1000 {
		return nil, apiError(400, "单次最多打包1000个文件")
	}
	var b bytes.Buffer
	w := zip.NewWriter(&b)
	manifest := map[string]any{"runId": id, "taskName": r["title"], "executionStatus": r["status"], "outcome": BuildOutcome(r)}
	files := []map[string]any{}
	used := map[string]bool{"交付清单.json": true}
	var total int64
	for i, record := range arts {
		a, err := e.Artifact(id, text(record["id"]))
		if err != nil {
			w.Close()
			return nil, err
		}
		total += a.Bytes
		if total > 100*1024*1024 {
			w.Close()
			return nil, apiError(400, "文件合计超过100MiB")
		}
		f, err := os.Open(a.Path)
		if err != nil {
			return nil, err
		}
		remaining := int64(100*1024*1024) - (total - a.Bytes)
		data, err := io.ReadAll(io.LimitReader(f, remaining+1))
		f.Close()
		if err != nil {
			w.Close()
			return nil, err
		}
		// Re-check bytes actually read: a file may have grown since the metadata lookup.
		total += int64(len(data)) - a.Bytes
		if total > 100*1024*1024 {
			w.Close()
			return nil, apiError(400, "文件实际内容合计超过100MiB")
		}
		name := regexp.MustCompile(`[\x00-\x1f<>:"|?*]`).ReplaceAllString(filepath.Base(strings.ReplaceAll(a.Name, "\\", "/")), "_")
		name = norm.NFC.String(strings.Map(func(r rune) rune {
			if unicode.Is(unicode.Cc, r) || unicode.Is(unicode.Cf, r) {
				return -1
			}
			return r
		}, name))
		name = strings.Trim(name, ". ")
		if name == "" {
			name = fmt.Sprintf("文件-%d", i+1)
		}
		if regexp.MustCompile(`(?i)^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)`).MatchString(name) {
			name = "_" + name
		}
		name = fitArchiveName(name, "")
		original := name
		for n := 2; used[strings.ToLower(name)]; n++ {
			name = fitArchiveName(original, fmt.Sprintf(" (%d)", n))
		}
		used[strings.ToLower(name)] = true
		out, err := w.Create(name)
		if err != nil {
			return nil, err
		}
		if _, err = out.Write(data); err != nil {
			return nil, err
		}
		sum := sha256.Sum256(data)
		files = append(files, map[string]any{"name": name, "bytes": len(data), "sha256": hex.EncodeToString(sum[:])})
	}
	manifest["files"] = files
	out, err := w.Create("交付清单.json")
	if err != nil {
		return nil, err
	}
	data, _ := json.MarshalIndent(manifest, "", "  ")
	_, err = out.Write(data)
	if err != nil {
		return nil, err
	}
	if err = w.Close(); err != nil {
		return nil, err
	}
	return b.Bytes(), nil
}
func fitArchiveName(name, suffix string) string {
	ext := filepath.Ext(name)
	if len(ext) > 32 {
		ext = ""
	}
	stem := strings.TrimSuffix(name, ext)
	limit := 240 - len(ext) - len(suffix)
	for len(stem) > limit {
		_, size := utf8.DecodeLastRuneInString(stem)
		stem = stem[:len(stem)-size]
	}
	return stem + suffix + ext
}
