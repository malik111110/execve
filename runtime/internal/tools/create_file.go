package tools

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
)

const defaultCreateFileMode = 0o644

type CreateFileTool struct{}

func NewCreateFileTool() *CreateFileTool {
	return &CreateFileTool{}
}

func (t *CreateFileTool) Name() string {
	return "create_file"
}

func (t *CreateFileTool) Run(ctx context.Context, input map[string]any) (map[string]any, error) {
	select {
	case <-ctx.Done():
		return nil, ctx.Err()
	default:
	}

	workspaceRoot := stringInput(input, "workspace_root")
	if workspaceRoot == "" {
		return nil, fmt.Errorf("workspace_root is required")
	}

	requestedPath := stringInput(input, "path")
	resolvedPath, err := resolvePath(workspaceRoot, requestedPath)
	if err != nil {
		return nil, err
	}

	relativePath := resolvedPath
	if rel, err := filepath.Rel(workspaceRoot, resolvedPath); err == nil {
		relativePath = rel
	}

	content := rawStringInput(input, "content")
	overwrite := boolInput(input, "overwrite", false)
	dryRun := boolInput(input, "dry_run", false)
	createDirs := boolInput(input, "create_dirs", true)

	exists := false
	isDir := false
	if info, statErr := os.Stat(resolvedPath); statErr == nil {
		exists = true
		isDir = info.IsDir()
	}

	if isDir {
		return nil, fmt.Errorf("path points to a directory: %s", relativePath)
	}

	if exists && !overwrite {
		return map[string]any{
			"path":         resolvedPath,
			"display_path": relativePath,
			"created":      false,
			"overwritten":  false,
			"exists":       true,
			"dry_run":      dryRun,
			"bytes":        len(content),
		}, nil
	}

	if dryRun {
		return map[string]any{
			"path":         resolvedPath,
			"display_path": relativePath,
			"created":      !exists,
			"overwritten":  exists && overwrite,
			"exists":       exists,
			"dry_run":      true,
			"bytes":        len(content),
		}, nil
	}

	if createDirs {
		if err := os.MkdirAll(filepath.Dir(resolvedPath), 0o755); err != nil {
			return nil, fmt.Errorf("create parent directories: %w", err)
		}
	}

	flags := os.O_WRONLY | os.O_CREATE
	if overwrite {
		flags |= os.O_TRUNC
	} else {
		flags |= os.O_EXCL
	}

	file, err := os.OpenFile(resolvedPath, flags, defaultCreateFileMode)
	if err != nil {
		return nil, fmt.Errorf("open target file: %w", err)
	}
	defer file.Close()

	if _, err := file.WriteString(content); err != nil {
		return nil, fmt.Errorf("write file: %w", err)
	}

	return map[string]any{
		"path":         resolvedPath,
		"display_path": relativePath,
		"created":      !exists,
		"overwritten":  exists && overwrite,
		"exists":       exists,
		"dry_run":      false,
		"bytes":        len(content),
	}, nil
}

func rawStringInput(input map[string]any, key string) string {
	if input == nil {
		return ""
	}

	value, ok := input[key]
	if !ok || value == nil {
		return ""
	}

	if content, ok := value.(string); ok {
		return content
	}

	return fmt.Sprintf("%v", value)
}
