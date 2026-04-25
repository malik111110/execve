package agent

import (
	"fmt"
	"path/filepath"
	"strings"
	"time"

	agentapi "github.com/digitalcenter/vscode-ex-llm/runtime/internal/api"
)

const (
	maxCommandMemoryEntries      = 6
	maxCommandMemoryPromptBlocks = 3
	maxCommandMemoryOutputChars  = 1200
)

type commandMemoryEntry struct {
	Command    string
	ExitCode   int
	TimedOut   bool
	Running    bool
	DurationMs int
	Stdout     string
	Stderr     string
	TerminalID string
	Terminal   string
	Cursor     int
	RecordedAt time.Time
}

type terminalContinuationState struct {
	TerminalID string
	Cursor     int
}

func (s *Service) commandMemoryKey(ctx agentapi.AgentContext) string {
	workspaceRoot := resolveWorkspaceRoot(ctx)
	if workspaceRoot == "" {
		return "__global__"
	}

	return filepath.Clean(workspaceRoot)
}

func (s *Service) rememberTerminalState(memoryKey string, result map[string]any) {
	if strings.TrimSpace(memoryKey) == "" || result == nil || mapBool(result, "dry_run") {
		return
	}

	terminalID := strings.TrimSpace(mapString(result, "terminal_id"))
	if terminalID == "" {
		return
	}

	cursor := mapInt(result, "next_line_offset")
	if cursor < 0 {
		cursor = 0
	}

	s.terminalMu.Lock()
	defer s.terminalMu.Unlock()

	s.terminalState[memoryKey] = terminalContinuationState{
		TerminalID: terminalID,
		Cursor:     cursor,
	}
}

func (s *Service) terminalStateSnapshot(memoryKey string) (terminalContinuationState, bool) {
	s.terminalMu.Lock()
	defer s.terminalMu.Unlock()

	state, ok := s.terminalState[memoryKey]
	if !ok {
		return terminalContinuationState{}, false
	}

	return state, true
}

func (s *Service) rememberCommandResult(memoryKey string, result map[string]any) {
	if strings.TrimSpace(memoryKey) == "" || result == nil || mapBool(result, "dry_run") {
		return
	}

	running := mapBool(result, "running")
	exitCode := mapInt(result, "exit_code")
	if (result["exit_code"] == nil || !containsKey(result, "exit_code")) && running {
		exitCode = -1
	}

	entry := commandMemoryEntry{
		Command:    mapString(result, "command"),
		ExitCode:   exitCode,
		TimedOut:   mapBool(result, "timed_out"),
		Running:    running,
		DurationMs: mapInt(result, "duration_ms"),
		Stdout:     truncateCommandMemoryOutput(mapString(result, "stdout")),
		Stderr:     truncateCommandMemoryOutput(mapString(result, "stderr")),
		TerminalID: mapString(result, "terminal_id"),
		Terminal:   mapString(result, "terminal_name"),
		Cursor:     mapInt(result, "next_line_offset"),
		RecordedAt: time.Now().UTC(),
	}

	if strings.TrimSpace(entry.Command) == "" {
		return
	}

	s.memoryMu.Lock()
	defer s.memoryMu.Unlock()

	entries := append(s.commandMemory[memoryKey], entry)
	if len(entries) > maxCommandMemoryEntries {
		entries = entries[len(entries)-maxCommandMemoryEntries:]
	}

	s.commandMemory[memoryKey] = entries
}

func (s *Service) buildCommandMemoryContext(memoryKey string) (string, int) {
	if strings.TrimSpace(memoryKey) == "" {
		return "", 0
	}

	entries := s.commandMemorySnapshot(memoryKey)
	if len(entries) == 0 {
		return "", 0
	}

	start := 0
	if len(entries) > maxCommandMemoryPromptBlocks {
		start = len(entries) - maxCommandMemoryPromptBlocks
	}

	selected := entries[start:]
	var builder strings.Builder
	builder.WriteString("Recent command results memory:\n")

	for idx, entry := range selected {
		builder.WriteString("\n")
		builder.WriteString(fmt.Sprintf("[%d] Command: %s\n", idx+1, entry.Command))
		if entry.Running {
			builder.WriteString(fmt.Sprintf("Running: true | Duration: %d ms | Timed out: %t\n", entry.DurationMs, entry.TimedOut))
		} else {
			builder.WriteString(fmt.Sprintf("Exit code: %d | Duration: %d ms | Timed out: %t\n", entry.ExitCode, entry.DurationMs, entry.TimedOut))
		}

		if strings.TrimSpace(entry.TerminalID) != "" {
			builder.WriteString(fmt.Sprintf("Terminal: %s (%s) | Cursor: %d\n", entry.TerminalID, entry.Terminal, entry.Cursor))
		}

		if strings.TrimSpace(entry.Stdout) == "" {
			builder.WriteString("Stdout: (empty)\n")
		} else {
			builder.WriteString("Stdout:\n")
			builder.WriteString(entry.Stdout)
			builder.WriteString("\n")
		}

		if strings.TrimSpace(entry.Stderr) == "" {
			builder.WriteString("Stderr: (empty)\n")
		} else {
			builder.WriteString("Stderr:\n")
			builder.WriteString(entry.Stderr)
			builder.WriteString("\n")
		}
	}

	return strings.TrimSpace(builder.String()), len(entries)
}

func (s *Service) commandMemorySnapshot(memoryKey string) []commandMemoryEntry {
	s.memoryMu.Lock()
	defer s.memoryMu.Unlock()

	entries := s.commandMemory[memoryKey]
	if len(entries) == 0 {
		return nil
	}

	cloned := make([]commandMemoryEntry, len(entries))
	copy(cloned, entries)
	return cloned
}

func truncateCommandMemoryOutput(value string) string {
	trimmed := strings.TrimSpace(value)
	if trimmed == "" {
		return ""
	}

	if len(trimmed) > maxCommandMemoryOutputChars {
		return trimmed[:maxCommandMemoryOutputChars] + "..."
	}

	return trimmed
}

func containsKey(input map[string]any, key string) bool {
	if input == nil {
		return false
	}

	_, ok := input[key]
	return ok
}
