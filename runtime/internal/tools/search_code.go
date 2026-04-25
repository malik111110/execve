package tools

import (
	"bufio"
	"bytes"
	"context"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
)

const (
	defaultSearchMaxResults  = 20
	searchPreviewLimit       = 8
	maxFallbackFileSizeBytes = 1 * 1024 * 1024
)

type SearchCodeTool struct{}

func NewSearchCodeTool() *SearchCodeTool {
	return &SearchCodeTool{}
}

func (t *SearchCodeTool) Name() string {
	return "search_code"
}

func (t *SearchCodeTool) Run(ctx context.Context, input map[string]any) (map[string]any, error) {
	workspaceRoot := stringInput(input, "workspace_root")
	if workspaceRoot == "" {
		return nil, fmt.Errorf("workspace_root is required")
	}

	query := stringInput(input, "query")
	if query == "" {
		return nil, fmt.Errorf("query is required")
	}

	maxResults := intInput(input, "max_results", defaultSearchMaxResults)
	if maxResults <= 0 {
		maxResults = defaultSearchMaxResults
	}

	if maxResults > 100 {
		maxResults = 100
	}

	includeGlob := stringInput(input, "include_glob")

	if _, err := exec.LookPath("rg"); err == nil {
		return runRipgrep(ctx, workspaceRoot, query, maxResults, includeGlob)
	}

	return runFallbackSearch(workspaceRoot, query, maxResults)
}

func runRipgrep(ctx context.Context, workspaceRoot string, query string, maxResults int, includeGlob string) (map[string]any, error) {
	args := []string{"--line-number", "--no-heading", "--color", "never", "--max-count", strconv.Itoa(maxResults)}
	if includeGlob != "" {
		args = append(args, "--glob", includeGlob)
	}

	args = append(args, query, workspaceRoot)

	cmd := exec.CommandContext(ctx, "rg", args...)
	output, err := cmd.CombinedOutput()
	if err != nil {
		var exitErr *exec.ExitError
		if ok := errors.As(err, &exitErr); ok && exitErr.ExitCode() == 1 {
			return map[string]any{
				"query":       query,
				"match_count": 0,
				"matches":     []map[string]any{},
				"preview":     "",
			}, nil
		}

		return nil, fmt.Errorf("ripgrep failed: %s", strings.TrimSpace(string(output)))
	}

	matches := parseRipgrepOutput(output, maxResults)
	return map[string]any{
		"query":       query,
		"match_count": len(matches),
		"matches":     matches,
		"preview":     buildSearchPreview(matches),
	}, nil
}

func parseRipgrepOutput(output []byte, maxResults int) []map[string]any {
	results := make([]map[string]any, 0, maxResults)
	scanner := bufio.NewScanner(bytes.NewReader(output))

	for scanner.Scan() {
		if len(results) >= maxResults {
			break
		}

		line := scanner.Text()
		parts := strings.SplitN(line, ":", 3)
		if len(parts) < 3 {
			continue
		}

		lineNumber, err := strconv.Atoi(parts[1])
		if err != nil {
			lineNumber = 0
		}

		results = append(results, map[string]any{
			"path": parts[0],
			"line": lineNumber,
			"text": strings.TrimSpace(parts[2]),
		})
	}

	return results
}

func runFallbackSearch(workspaceRoot string, query string, maxResults int) (map[string]any, error) {
	results := make([]map[string]any, 0, maxResults)
	lowerQuery := strings.ToLower(query)

	err := filepath.WalkDir(workspaceRoot, func(path string, entry fs.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}

		if len(results) >= maxResults {
			return fs.SkipAll
		}

		if entry.IsDir() {
			name := entry.Name()
			if name == ".git" || name == "node_modules" || name == "out" || name == "bin" {
				return fs.SkipDir
			}

			return nil
		}

		info, err := entry.Info()
		if err != nil {
			return nil
		}

		if info.Size() > maxFallbackFileSizeBytes {
			return nil
		}

		file, err := os.Open(path)
		if err != nil {
			return nil
		}
		defer file.Close()

		scanner := bufio.NewScanner(file)
		scanner.Buffer(make([]byte, 0, 64*1024), 1024*1024)
		lineNumber := 0

		for scanner.Scan() {
			if len(results) >= maxResults {
				return fs.SkipAll
			}

			lineNumber++
			line := scanner.Text()
			if strings.Contains(strings.ToLower(line), lowerQuery) {
				results = append(results, map[string]any{
					"path": path,
					"line": lineNumber,
					"text": strings.TrimSpace(line),
				})
			}
		}

		return nil
	})

	if err != nil && err != fs.SkipAll {
		return nil, err
	}

	return map[string]any{
		"query":       query,
		"match_count": len(results),
		"matches":     results,
		"preview":     buildSearchPreview(results),
	}, nil
}

func buildSearchPreview(matches []map[string]any) string {
	if len(matches) == 0 {
		return ""
	}

	limit := len(matches)
	if limit > searchPreviewLimit {
		limit = searchPreviewLimit
	}

	lines := make([]string, 0, limit)
	for i := 0; i < limit; i++ {
		match := matches[i]
		path := stringInput(match, "path")
		text := stringInput(match, "text")
		line := intInput(match, "line", 0)
		lines = append(lines, fmt.Sprintf("%s:%d %s", path, line, text))
	}

	return strings.Join(lines, "\n")
}
