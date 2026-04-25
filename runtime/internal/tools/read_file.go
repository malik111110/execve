package tools

import (
	"bufio"
	"context"
	"fmt"
	"os"
	"strings"
)

const defaultReadFileMaxBytes = 64 * 1024

type ReadFileTool struct{}

func NewReadFileTool() *ReadFileTool {
	return &ReadFileTool{}
}

func (t *ReadFileTool) Name() string {
	return "read_file"
}

func (t *ReadFileTool) Run(ctx context.Context, input map[string]any) (map[string]any, error) {
	select {
	case <-ctx.Done():
		return nil, ctx.Err()
	default:
	}

	workspaceRoot := stringInput(input, "workspace_root")
	requestedPath := stringInput(input, "path")
	resolvedPath, err := resolvePath(workspaceRoot, requestedPath)
	if err != nil {
		return nil, err
	}

	startLine := intInput(input, "start_line", 1)
	endLine := intInput(input, "end_line", startLine+199)
	maxBytes := intInput(input, "max_bytes", defaultReadFileMaxBytes)

	if startLine < 1 {
		startLine = 1
	}

	if endLine < startLine {
		endLine = startLine
	}

	if maxBytes <= 0 {
		maxBytes = defaultReadFileMaxBytes
	}

	file, err := os.Open(resolvedPath)
	if err != nil {
		return nil, fmt.Errorf("open file: %w", err)
	}
	defer file.Close()

	scanner := bufio.NewScanner(file)
	scanner.Buffer(make([]byte, 0, 64*1024), 1024*1024)

	lineNumber := 0
	lineEnd := startLine
	var builder strings.Builder
	truncated := false

	for scanner.Scan() {
		lineNumber++

		if lineNumber < startLine {
			continue
		}

		if lineNumber > endLine {
			break
		}

		line := scanner.Text()
		if builder.Len()+len(line)+1 > maxBytes {
			truncated = true
			break
		}

		builder.WriteString(line)
		builder.WriteString("\n")
		lineEnd = lineNumber
	}

	if err := scanner.Err(); err != nil {
		return nil, fmt.Errorf("scan file: %w", err)
	}

	return map[string]any{
		"path":       resolvedPath,
		"line_start": startLine,
		"line_end":   lineEnd,
		"content":    builder.String(),
		"truncated":  truncated,
	}, nil
}
