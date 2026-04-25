package tools

import (
	"context"
	"fmt"
	"os/exec"
	"strings"
)

const defaultGitDiffMaxBytes = 64 * 1024

type GitDiffTool struct{}

func NewGitDiffTool() *GitDiffTool {
	return &GitDiffTool{}
}

func (t *GitDiffTool) Name() string {
	return "git_diff"
}

func (t *GitDiffTool) Run(ctx context.Context, input map[string]any) (map[string]any, error) {
	workspaceRoot := stringInput(input, "workspace_root")
	if workspaceRoot == "" {
		return nil, fmt.Errorf("workspace_root is required")
	}

	staged := boolInput(input, "staged", false)
	path := stringInput(input, "path")
	maxBytes := intInput(input, "max_bytes", defaultGitDiffMaxBytes)
	if maxBytes <= 0 {
		maxBytes = defaultGitDiffMaxBytes
	}

	args := []string{"-C", workspaceRoot, "--no-pager", "diff"}
	if staged {
		args = append(args, "--staged")
	}

	if path != "" {
		args = append(args, "--", path)
	}

	cmd := exec.CommandContext(ctx, "git", args...)
	output, err := cmd.CombinedOutput()
	if err != nil {
		return nil, fmt.Errorf("git diff failed: %s", strings.TrimSpace(string(output)))
	}

	diff := string(output)
	truncated := false
	if len(diff) > maxBytes {
		diff = diff[:maxBytes]
		truncated = true
	}

	return map[string]any{
		"has_changes": strings.TrimSpace(diff) != "",
		"diff":        diff,
		"truncated":   truncated,
	}, nil
}
