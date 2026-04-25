package tools

import (
	"fmt"
	"path/filepath"
	"strconv"
	"strings"
)

func stringInput(input map[string]any, key string) string {
	if input == nil {
		return ""
	}

	value, ok := input[key]
	if !ok || value == nil {
		return ""
	}

	switch typed := value.(type) {
	case string:
		return strings.TrimSpace(typed)
	default:
		return strings.TrimSpace(fmt.Sprintf("%v", typed))
	}
}

func intInput(input map[string]any, key string, fallback int) int {
	if input == nil {
		return fallback
	}

	value, ok := input[key]
	if !ok || value == nil {
		return fallback
	}

	switch typed := value.(type) {
	case int:
		return typed
	case int64:
		return int(typed)
	case float64:
		return int(typed)
	case string:
		parsed, err := strconv.Atoi(strings.TrimSpace(typed))
		if err != nil {
			return fallback
		}

		return parsed
	default:
		return fallback
	}
}

func boolInput(input map[string]any, key string, fallback bool) bool {
	if input == nil {
		return fallback
	}

	value, ok := input[key]
	if !ok || value == nil {
		return fallback
	}

	switch typed := value.(type) {
	case bool:
		return typed
	case string:
		parsed, err := strconv.ParseBool(strings.TrimSpace(typed))
		if err != nil {
			return fallback
		}

		return parsed
	default:
		return fallback
	}
}

func resolvePath(workspaceRoot string, candidatePath string) (string, error) {
	if strings.TrimSpace(candidatePath) == "" {
		return "", fmt.Errorf("path is required")
	}

	resolved := filepath.Clean(strings.TrimSpace(candidatePath))
	if !filepath.IsAbs(resolved) {
		if strings.TrimSpace(workspaceRoot) == "" {
			return "", fmt.Errorf("workspace_root is required for relative paths")
		}

		resolved = filepath.Join(workspaceRoot, resolved)
	}

	absoluteResolved, err := filepath.Abs(resolved)
	if err != nil {
		return "", err
	}

	if strings.TrimSpace(workspaceRoot) != "" {
		absoluteRoot, err := filepath.Abs(filepath.Clean(workspaceRoot))
		if err != nil {
			return "", err
		}

		rel, err := filepath.Rel(absoluteRoot, absoluteResolved)
		if err != nil {
			return "", err
		}

		if rel == ".." || strings.HasPrefix(rel, ".."+string(filepath.Separator)) {
			return "", fmt.Errorf("path escapes workspace_root")
		}
	}

	return absoluteResolved, nil
}
