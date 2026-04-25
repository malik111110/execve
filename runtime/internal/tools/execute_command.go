package tools

import (
	"context"
	"fmt"
	"os"
	"strings"
	"time"
)

const (
	defaultExecuteTimeoutMs     = 120000
	defaultExecuteMaxBytes      = 64 * 1024
	defaultExecuteWaitMs        = 400
	defaultExecuteMaxLineEvents = 160
)

type ExecuteCommandTool struct {
	terminalManager *TerminalManager
}

func NewExecuteCommandTool() *ExecuteCommandTool {
	return &ExecuteCommandTool{terminalManager: DefaultTerminalManager()}
}

func NewExecuteCommandToolWithManager(terminalManager *TerminalManager) *ExecuteCommandTool {
	if terminalManager == nil {
		terminalManager = DefaultTerminalManager()
	}

	return &ExecuteCommandTool{terminalManager: terminalManager}
}

func (t *ExecuteCommandTool) Name() string {
	return "execute_command"
}

func (t *ExecuteCommandTool) Run(ctx context.Context, input map[string]any) (map[string]any, error) {
	if t.terminalManager == nil {
		t.terminalManager = DefaultTerminalManager()
	}

	workspaceRoot := stringInput(input, "workspace_root")
	if workspaceRoot == "" {
		return nil, fmt.Errorf("workspace_root is required")
	}

	command := rawStringInput(input, "command")
	command = strings.TrimSpace(command)

	continueOnly := boolInput(input, "continue", false)
	stopOnly := boolInput(input, "stop", false)

	if continueOnly && stopOnly {
		return nil, fmt.Errorf("continue and stop are mutually exclusive")
	}

	if !continueOnly && !stopOnly && command == "" {
		return nil, fmt.Errorf("command is required")
	}
	if (continueOnly || stopOnly) && command != "" {
		return nil, fmt.Errorf("continue/stop semantics do not accept a new command; omit command when continue=true or stop=true")
	}

	timeoutMs := intInput(input, "timeout_ms", defaultExecuteTimeoutMs)
	if timeoutMs <= 0 {
		timeoutMs = defaultExecuteTimeoutMs
	}
	timeoutDuration := time.Duration(timeoutMs) * time.Millisecond

	maxBytes := intInput(input, "max_output_bytes", defaultExecuteMaxBytes)
	if maxBytes <= 0 {
		maxBytes = defaultExecuteMaxBytes
	}

	lineOffset := intInput(input, "line_offset", 0)
	if lineOffset < 0 {
		lineOffset = 0
	}

	maxLineEvents := intInput(input, "max_line_events", defaultExecuteMaxLineEvents)
	if maxLineEvents <= 0 {
		maxLineEvents = defaultExecuteMaxLineEvents
	}

	waitMs := intInput(input, "wait_ms", defaultExecuteWaitMs)
	if waitMs < 0 {
		waitMs = 0
	}

	waitForCompletion := boolInput(input, "wait_for_completion", true)
	streamLines := boolInput(input, "stream_lines", true)
	reuseTerminal := boolInput(input, "reuse_terminal", true)

	terminalID := stringInput(input, "terminal_id")
	terminalName := normalizeTerminalName(stringInput(input, "terminal_name"))
	if !reuseTerminal && !continueOnly {
		terminalName = fmt.Sprintf("%s-%d", terminalName, time.Now().UnixNano())
	}

	approvalPolicy := parseCommandApprovalPolicy(input)
	if pattern, matched := firstMatchingPattern(t.Name(), approvalPolicy.BlockedMCPs); matched {
		return nil, fmt.Errorf("blocked by MCP blacklist pattern: %s", pattern)
	}
	if len(approvalPolicy.AllowedMCPs) > 0 {
		if _, matched := firstMatchingPattern(t.Name(), approvalPolicy.AllowedMCPs); !matched {
			return nil, fmt.Errorf("tool %q is not in allowed MCP list", t.Name())
		}
	}

	if !continueOnly && !stopOnly {
		if err := approvalPolicy.ValidateCommand(command); err != nil {
			return nil, err
		}
	}

	dryRun := boolInput(input, "dry_run", false)
	if dryRun {
		return executeCommandDryRunResult(
			workspaceRoot,
			command,
			terminalName,
			lineOffset,
			continueOnly,
			stopOnly,
			approvalPolicy,
		), nil
	}

	if !isCommandExecutionEnabled() {
		return nil, fmt.Errorf("command execution disabled: set AGENT_ALLOW_COMMANDS=true to enable")
	}

	if stopOnly {
		process, err := t.terminalManager.Resolve(TerminalLookupRequest{
			TerminalID:    terminalID,
			WorkspaceRoot: workspaceRoot,
			TerminalName:  terminalName,
		})
		if err != nil {
			return nil, err
		}

		stopped := process.Stop()
		stopWaitMs := waitMs
		if stopWaitMs <= 0 {
			stopWaitMs = 1200
		}

		waitCtx, cancel := context.WithTimeout(ctx, time.Duration(stopWaitMs)*time.Millisecond)
		process.Wait(waitCtx)
		cancel()

		snapshot := process.Snapshot(lineOffset, maxLineEvents, maxBytes, streamLines)
		result := terminalSnapshotToResult(snapshot, approvalPolicy)
		result["stopped"] = stopped
		result["continued"] = false
		result["wait_for_completion"] = true
		return result, nil
	}

	if continueOnly {
		process, err := t.terminalManager.Resolve(TerminalLookupRequest{
			TerminalID:    terminalID,
			WorkspaceRoot: workspaceRoot,
			TerminalName:  terminalName,
		})
		if err != nil {
			return nil, err
		}

		if waitMs > 0 {
			waitCtx, cancel := context.WithTimeout(ctx, time.Duration(waitMs)*time.Millisecond)
			process.WaitForOutput(waitCtx, lineOffset)
			cancel()
		}

		snapshot := process.Snapshot(lineOffset, maxLineEvents, maxBytes, streamLines)
		result := terminalSnapshotToResult(snapshot, approvalPolicy)
		result["stopped"] = false
		result["continued"] = true
		return result, nil
	}

	process, reusedTerminal, err := t.terminalManager.Start(TerminalStartRequest{
		WorkspaceRoot:  workspaceRoot,
		TerminalName:   terminalName,
		Command:        command,
		Timeout:        timeoutDuration,
		MaxStoredLines: intInput(input, "max_stored_lines", defaultTerminalMaxStoredLines),
		MaxBufferBytes: intInput(input, "max_buffered_output_bytes", defaultTerminalMaxBufferedSize),
	})
	if err != nil {
		return nil, err
	}

	if waitForCompletion {
		waitCtx, cancel := context.WithTimeout(ctx, timeoutDuration+2*time.Second)
		process.Wait(waitCtx)
		cancel()
	} else if waitMs > 0 {
		waitCtx, cancel := context.WithTimeout(ctx, time.Duration(waitMs)*time.Millisecond)
		process.WaitForOutput(waitCtx, lineOffset)
		cancel()
	}

	snapshot := process.Snapshot(lineOffset, maxLineEvents, maxBytes, streamLines)
	result := terminalSnapshotToResult(snapshot, approvalPolicy)
	result["stopped"] = false
	result["continued"] = false
	result["reused_terminal"] = reusedTerminal
	result["wait_for_completion"] = waitForCompletion

	return result, nil
}

func executeCommandDryRunResult(
	workspaceRoot string,
	command string,
	terminalName string,
	lineOffset int,
	continueOnly bool,
	stopOnly bool,
	approvalPolicy CommandApprovalPolicy,
) map[string]any {
	result := map[string]any{
		"command":               command,
		"cwd":                   workspaceRoot,
		"dry_run":               true,
		"exit_code":             0,
		"stdout":                "",
		"stderr":                "",
		"truncated":             false,
		"duration_ms":           0,
		"timed_out":             false,
		"terminal_id":           "",
		"terminal_name":         terminalName,
		"running":               false,
		"completed":             true,
		"continued":             continueOnly,
		"stopped":               stopOnly,
		"line_offset":           lineOffset,
		"next_line_offset":      lineOffset,
		"available_line_offset": lineOffset,
		"base_line_offset":      lineOffset,
		"line_events":           []map[string]any{},
		"approval_mode":         string(approvalPolicy.Mode),
		"allowed_commands":      approvalPolicy.AllowedCommands,
		"blocked_commands":      approvalPolicy.BlockedCommands,
		"allowed_mcps":          approvalPolicy.AllowedMCPs,
		"blocked_mcps":          approvalPolicy.BlockedMCPs,
	}

	return result
}

func terminalSnapshotToResult(
	snapshot TerminalSnapshot,
	approvalPolicy CommandApprovalPolicy,
) map[string]any {
	result := map[string]any{
		"command":                snapshot.Command,
		"cwd":                    snapshot.WorkspaceRoot,
		"dry_run":                false,
		"stdout":                 snapshot.Stdout,
		"stderr":                 snapshot.Stderr,
		"truncated":              snapshot.StdoutTruncated || snapshot.StderrTruncated || snapshot.OutputHistoryTruncated || snapshot.LineHistoryTruncated || snapshot.InternalBufferTruncated,
		"duration_ms":            snapshot.DurationMs,
		"timed_out":              snapshot.TimedOut,
		"terminal_id":            snapshot.TerminalID,
		"terminal_name":          snapshot.TerminalName,
		"running":                snapshot.Running,
		"completed":              !snapshot.Running,
		"line_offset":            snapshot.RequestedLineOffset,
		"next_line_offset":       snapshot.CursorLineOffset,
		"available_line_offset":  snapshot.AvailableLineOffset,
		"base_line_offset":       snapshot.BaseLineOffset,
		"line_history_truncated": snapshot.LineHistoryTruncated,
		"started_at_ms":          snapshot.StartedAt.UnixMilli(),
		"approval_mode":          string(approvalPolicy.Mode),
		"allowed_commands":       approvalPolicy.AllowedCommands,
		"blocked_commands":       approvalPolicy.BlockedCommands,
		"allowed_mcps":           approvalPolicy.AllowedMCPs,
		"blocked_mcps":           approvalPolicy.BlockedMCPs,
	}

	if snapshot.CompletedAt != nil {
		result["completed_at_ms"] = snapshot.CompletedAt.UnixMilli()
	}

	if snapshot.ExitCode != nil {
		result["exit_code"] = *snapshot.ExitCode
	} else {
		result["exit_code"] = nil
	}

	result["line_events"] = lineEventsToMaps(snapshot.LineEvents)

	return result
}

func lineEventsToMaps(events []TerminalLineEvent) []map[string]any {
	if len(events) == 0 {
		return []map[string]any{}
	}

	encoded := make([]map[string]any, 0, len(events))
	for _, event := range events {
		encoded = append(encoded, map[string]any{
			"offset":       event.Offset,
			"stream":       event.Stream,
			"text":         event.Text,
			"timestamp_ms": event.TimestampMs,
		})
	}

	return encoded
}

func isCommandExecutionEnabled() bool {
	value := strings.TrimSpace(strings.ToLower(os.Getenv("AGENT_ALLOW_COMMANDS")))
	return value == "1" || value == "true" || value == "yes"
}

func envOrDefault(key string, fallback string) string {
	value := strings.TrimSpace(os.Getenv(key))
	if value == "" {
		return fallback
	}

	return value
}
