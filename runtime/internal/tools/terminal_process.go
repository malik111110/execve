package tools

import (
	"bufio"
	"context"
	"fmt"
	"io"
	"os/exec"
	"strings"
	"sync"
	"time"
)

const (
	defaultTerminalMaxStoredLines  = 4000
	defaultTerminalMaxBufferedSize = 512 * 1024
	maxTerminalScannerTokenSize    = 1024 * 1024
)

type TerminalLineEvent struct {
	Offset      int
	Stream      string
	Text        string
	TimestampMs int64
}

type TerminalSnapshot struct {
	TerminalID              string
	TerminalName            string
	WorkspaceRoot           string
	Command                 string
	Running                 bool
	TimedOut                bool
	ExitCode                *int
	StartedAt               time.Time
	CompletedAt             *time.Time
	DurationMs              int64
	Stdout                  string
	Stderr                  string
	StdoutTruncated         bool
	StderrTruncated         bool
	OutputHistoryTruncated  bool
	LineEvents              []TerminalLineEvent
	RequestedLineOffset     int
	CursorLineOffset        int
	AvailableLineOffset     int
	BaseLineOffset          int
	LineHistoryTruncated    bool
	InternalBufferTruncated bool
}

type TerminalStartOptions struct {
	TerminalID     string
	TerminalName   string
	WorkspaceRoot  string
	Command        string
	Shell          string
	Timeout        time.Duration
	MaxStoredLines int
	MaxBufferBytes int
}

type TerminalProcess struct {
	id            string
	terminalName  string
	workspaceRoot string
	command       string

	startedAt time.Time

	maxStoredLines int
	maxBufferBytes int

	mu                      sync.RWMutex
	running                 bool
	timedOut                bool
	hasExitCode             bool
	exitCode                int
	completedAt             time.Time
	lineBaseOffset          int
	lineHistoryTruncated    bool
	outputHistoryTruncated  bool
	internalBufferTruncated bool
	stdoutBuffer            []byte
	stderrBuffer            []byte
	lines                   []TerminalLineEvent

	done         chan struct{}
	updateSignal chan struct{}
	cancel       context.CancelFunc
}

func newTerminalProcess(options TerminalStartOptions) (*TerminalProcess, error) {
	if strings.TrimSpace(options.TerminalID) == "" {
		return nil, fmt.Errorf("terminal id is required")
	}

	if strings.TrimSpace(options.WorkspaceRoot) == "" {
		return nil, fmt.Errorf("workspace_root is required")
	}

	commandText := strings.TrimSpace(options.Command)
	if commandText == "" {
		return nil, fmt.Errorf("command is required")
	}

	timeout := options.Timeout
	if timeout <= 0 {
		timeout = 120 * time.Second
	}

	maxStoredLines := options.MaxStoredLines
	if maxStoredLines <= 0 {
		maxStoredLines = defaultTerminalMaxStoredLines
	}

	maxBufferBytes := options.MaxBufferBytes
	if maxBufferBytes <= 0 {
		maxBufferBytes = defaultTerminalMaxBufferedSize
	}

	shell := strings.TrimSpace(options.Shell)
	if shell == "" {
		shell = envOrDefault("AGENT_SHELL", "sh")
	}

	runCtx, cancel := context.WithTimeout(context.Background(), timeout)
	cmd := exec.CommandContext(runCtx, shell, "-lc", commandText)
	cmd.Dir = options.WorkspaceRoot

	stdoutPipe, err := cmd.StdoutPipe()
	if err != nil {
		cancel()
		return nil, fmt.Errorf("stdout pipe: %w", err)
	}

	stderrPipe, err := cmd.StderrPipe()
	if err != nil {
		cancel()
		return nil, fmt.Errorf("stderr pipe: %w", err)
	}

	if err := cmd.Start(); err != nil {
		cancel()
		return nil, fmt.Errorf("start command: %w", err)
	}

	process := &TerminalProcess{
		id:             options.TerminalID,
		terminalName:   normalizeTerminalName(options.TerminalName),
		workspaceRoot:  options.WorkspaceRoot,
		command:        commandText,
		startedAt:      time.Now().UTC(),
		maxStoredLines: maxStoredLines,
		maxBufferBytes: maxBufferBytes,
		running:        true,
		done:           make(chan struct{}),
		updateSignal:   make(chan struct{}, 1),
		cancel:         cancel,
	}

	go process.captureStream(stdoutPipe, "stdout")
	go process.captureStream(stderrPipe, "stderr")
	go process.waitForCompletion(runCtx, cmd)

	return process, nil
}

func (p *TerminalProcess) ID() string {
	return p.id
}

func (p *TerminalProcess) TerminalName() string {
	return p.terminalName
}

func (p *TerminalProcess) Command() string {
	return p.command
}

func (p *TerminalProcess) WorkspaceRoot() string {
	return p.workspaceRoot
}

func (p *TerminalProcess) IsRunning() bool {
	p.mu.RLock()
	defer p.mu.RUnlock()

	return p.running
}

func (p *TerminalProcess) IsCompleted() bool {
	p.mu.RLock()
	defer p.mu.RUnlock()

	return !p.running
}

func (p *TerminalProcess) Wait(ctx context.Context) bool {
	select {
	case <-p.done:
		return true
	case <-ctx.Done():
		return false
	}
}

func (p *TerminalProcess) Stop() bool {
	p.mu.RLock()
	running := p.running
	p.mu.RUnlock()

	if !running {
		return false
	}

	p.cancel()
	return true
}

func (p *TerminalProcess) WaitForOutput(ctx context.Context, lineOffset int) {
	for {
		if p.hasOutputSince(lineOffset) || p.IsCompleted() {
			return
		}

		select {
		case <-ctx.Done():
			return
		case <-p.updateSignal:
		}
	}
}

func (p *TerminalProcess) Snapshot(
	lineOffset int,
	maxLineEvents int,
	maxOutputBytes int,
	includeLineEvents bool,
) TerminalSnapshot {
	if lineOffset < 0 {
		lineOffset = 0
	}

	if maxLineEvents <= 0 {
		maxLineEvents = 120
	}

	p.mu.RLock()
	defer p.mu.RUnlock()

	effectiveOffset := lineOffset
	if effectiveOffset < p.lineBaseOffset {
		effectiveOffset = p.lineBaseOffset
	}

	availableLineOffset := p.lineBaseOffset + len(p.lines)
	cursorLineOffset := effectiveOffset

	lineEvents := make([]TerminalLineEvent, 0)
	if includeLineEvents && effectiveOffset < availableLineOffset {
		start := effectiveOffset - p.lineBaseOffset
		end := len(p.lines)
		if end-start > maxLineEvents {
			end = start + maxLineEvents
		}

		lineEvents = append(lineEvents, p.lines[start:end]...)
		cursorLineOffset = p.lineBaseOffset + end
	}

	stdout, stdoutTruncated := truncateBytesToString(p.stdoutBuffer, maxOutputBytes)
	stderr, stderrTruncated := truncateBytesToString(p.stderrBuffer, maxOutputBytes)

	durationMs := time.Since(p.startedAt).Milliseconds()
	if !p.running {
		durationMs = p.completedAt.Sub(p.startedAt).Milliseconds()
	}

	var completedAt *time.Time
	if !p.running {
		copyTime := p.completedAt
		completedAt = &copyTime
	}

	var exitCode *int
	if p.hasExitCode {
		copyCode := p.exitCode
		exitCode = &copyCode
	}

	return TerminalSnapshot{
		TerminalID:              p.id,
		TerminalName:            p.terminalName,
		WorkspaceRoot:           p.workspaceRoot,
		Command:                 p.command,
		Running:                 p.running,
		TimedOut:                p.timedOut,
		ExitCode:                exitCode,
		StartedAt:               p.startedAt,
		CompletedAt:             completedAt,
		DurationMs:              durationMs,
		Stdout:                  stdout,
		Stderr:                  stderr,
		StdoutTruncated:         stdoutTruncated,
		StderrTruncated:         stderrTruncated,
		OutputHistoryTruncated:  p.outputHistoryTruncated,
		LineEvents:              lineEvents,
		RequestedLineOffset:     lineOffset,
		CursorLineOffset:        cursorLineOffset,
		AvailableLineOffset:     availableLineOffset,
		BaseLineOffset:          p.lineBaseOffset,
		LineHistoryTruncated:    p.lineHistoryTruncated,
		InternalBufferTruncated: p.internalBufferTruncated,
	}
}

func (p *TerminalProcess) captureStream(reader io.Reader, stream string) {
	scanner := bufio.NewScanner(reader)
	scanner.Buffer(make([]byte, 1024), maxTerminalScannerTokenSize)

	for scanner.Scan() {
		line := scanner.Text()
		p.appendLine(stream, line)
	}

	if err := scanner.Err(); err != nil {
		p.appendLine("system", fmt.Sprintf("[%s stream error] %v", stream, err))
	}
}

func (p *TerminalProcess) waitForCompletion(runCtx context.Context, cmd *exec.Cmd) {
	defer close(p.done)
	defer p.cancel()

	runErr := cmd.Wait()
	exitCode := 0

	if runErr != nil {
		if exitErr, ok := runErr.(*exec.ExitError); ok {
			exitCode = exitErr.ExitCode()
		} else if runCtx.Err() == context.DeadlineExceeded {
			exitCode = 124
		} else {
			exitCode = 1
		}
	}

	timedOut := runCtx.Err() == context.DeadlineExceeded

	p.mu.Lock()
	p.running = false
	p.timedOut = timedOut
	p.exitCode = exitCode
	p.hasExitCode = true
	p.completedAt = time.Now().UTC()
	p.notifyUpdateLocked()
	p.mu.Unlock()
}

func (p *TerminalProcess) hasOutputSince(lineOffset int) bool {
	p.mu.RLock()
	defer p.mu.RUnlock()

	available := p.lineBaseOffset + len(p.lines)
	return lineOffset < available
}

func (p *TerminalProcess) appendLine(stream string, line string) {
	p.mu.Lock()
	defer p.mu.Unlock()

	normalizedText := strings.TrimRight(line, "\r")
	timestampMs := time.Now().UTC().UnixMilli()

	offset := p.lineBaseOffset + len(p.lines)
	p.lines = append(p.lines, TerminalLineEvent{
		Offset:      offset,
		Stream:      stream,
		Text:        normalizedText,
		TimestampMs: timestampMs,
	})

	if len(p.lines) > p.maxStoredLines {
		overflow := len(p.lines) - p.maxStoredLines
		p.lines = p.lines[overflow:]
		p.lineBaseOffset += overflow
		p.lineHistoryTruncated = true
	}

	lineWithNewline := normalizedText + "\n"
	if stream == "stderr" {
		updated, truncated := appendLimitedBuffer(p.stderrBuffer, lineWithNewline, p.maxBufferBytes)
		p.stderrBuffer = updated
		if truncated {
			p.outputHistoryTruncated = true
		}
	} else {
		updated, truncated := appendLimitedBuffer(p.stdoutBuffer, lineWithNewline, p.maxBufferBytes)
		p.stdoutBuffer = updated
		if truncated {
			p.outputHistoryTruncated = true
		}
	}

	p.notifyUpdateLocked()
}

func (p *TerminalProcess) notifyUpdateLocked() {
	select {
	case p.updateSignal <- struct{}{}:
	default:
	}
}

func appendLimitedBuffer(current []byte, addition string, maxBytes int) ([]byte, bool) {
	if maxBytes <= 0 {
		return current, false
	}

	if len(addition) >= maxBytes {
		return []byte(addition[len(addition)-maxBytes:]), true
	}

	combined := append(current, addition...)
	if len(combined) <= maxBytes {
		return combined, false
	}

	overflow := len(combined) - maxBytes
	return combined[overflow:], true
}

func truncateBytesToString(value []byte, maxBytes int) (string, bool) {
	if maxBytes <= 0 || len(value) <= maxBytes {
		return string(value), false
	}

	return string(value[len(value)-maxBytes:]), true
}
