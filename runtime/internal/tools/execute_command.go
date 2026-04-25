package tools

import (
	"bytes"
	"context"
	"fmt"
	"os"
	"os/exec"
	"strings"
	"time"
)

const (
	defaultExecuteTimeoutMs = 120000
	defaultExecuteMaxBytes  = 64 * 1024
)

type ExecuteCommandTool struct{}

func NewExecuteCommandTool() *ExecuteCommandTool {
	return &ExecuteCommandTool{}
}

func (t *ExecuteCommandTool) Name() string {
	return "execute_command"
}

func (t *ExecuteCommandTool) Run(ctx context.Context, input map[string]any) (map[string]any, error) {
	workspaceRoot := stringInput(input, "workspace_root")
	if workspaceRoot == "" {
		return nil, fmt.Errorf("workspace_root is required")
	}

	command := rawStringInput(input, "command")
	command = strings.TrimSpace(command)
	if command == "" {
		return nil, fmt.Errorf("command is required")
	}

	timeoutMs := intInput(input, "timeout_ms", defaultExecuteTimeoutMs)
	if timeoutMs <= 0 {
		timeoutMs = defaultExecuteTimeoutMs
	}

	maxBytes := intInput(input, "max_output_bytes", defaultExecuteMaxBytes)
	if maxBytes <= 0 {
		maxBytes = defaultExecuteMaxBytes
	}

	dryRun := boolInput(input, "dry_run", false)
	if dryRun {
		return map[string]any{
			"command":     command,
			"cwd":         workspaceRoot,
			"dry_run":     true,
			"exit_code":   0,
			"stdout":      "",
			"stderr":      "",
			"truncated":   false,
			"duration_ms": 0,
		}, nil
	}

	if !isCommandExecutionEnabled() {
		return nil, fmt.Errorf("command execution disabled: set AGENT_ALLOW_COMMANDS=true to enable")
	}

	if blockedReason := blockedCommandReason(command); blockedReason != "" {
		return nil, fmt.Errorf("blocked command: %s", blockedReason)
	}

	timedCtx, cancel := context.WithTimeout(ctx, time.Duration(timeoutMs)*time.Millisecond)
	defer cancel()

	started := time.Now()
	shell := envOrDefault("AGENT_SHELL", "sh")
	cmd := exec.CommandContext(timedCtx, shell, "-lc", command)
	cmd.Dir = workspaceRoot

	var stdoutBuf bytes.Buffer
	var stderrBuf bytes.Buffer
	cmd.Stdout = &stdoutBuf
	cmd.Stderr = &stderrBuf

	runErr := cmd.Run()
	statusCode := 0
	if runErr != nil {
		if exitErr, ok := runErr.(*exec.ExitError); ok {
			statusCode = exitErr.ExitCode()
		} else if timedCtx.Err() == context.DeadlineExceeded {
			statusCode = 124
		} else {
			statusCode = 1
		}
	}

	stdout, stdoutTruncated := truncateText(stdoutBuf.String(), maxBytes)
	stderr, stderrTruncated := truncateText(stderrBuf.String(), maxBytes)

	result := map[string]any{
		"command":     command,
		"cwd":         workspaceRoot,
		"dry_run":     false,
		"exit_code":   statusCode,
		"stdout":      stdout,
		"stderr":      stderr,
		"truncated":   stdoutTruncated || stderrTruncated,
		"duration_ms": time.Since(started).Milliseconds(),
	}

	if timedCtx.Err() == context.DeadlineExceeded {
		result["timed_out"] = true
	}

	return result, nil
}

func isCommandExecutionEnabled() bool {
	value := strings.TrimSpace(strings.ToLower(os.Getenv("AGENT_ALLOW_COMMANDS")))
	return value == "1" || value == "true" || value == "yes"
}

func blockedCommandReason(command string) string {
	trimmed := strings.ToLower(strings.TrimSpace(command))
	dangerous := []string{
		"rm -rf /",
		"mkfs",
		":(){",
		"shutdown",
		"reboot",
		"poweroff",
		"dd if=/dev/zero",
	}

	for _, pattern := range dangerous {
		if strings.Contains(trimmed, pattern) {
			return pattern
		}
	}

	return ""
}

func truncateText(value string, maxBytes int) (string, bool) {
	if len(value) <= maxBytes {
		return value, false
	}

	return value[:maxBytes], true
}

func envOrDefault(key string, fallback string) string {
	value := strings.TrimSpace(os.Getenv(key))
	if value == "" {
		return fallback
	}

	return value
}
