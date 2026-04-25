package agent

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"

	agentapi "github.com/digitalcenter/vscode-ex-llm/runtime/internal/api"
	"github.com/digitalcenter/vscode-ex-llm/runtime/internal/providers/mock"
	"github.com/digitalcenter/vscode-ex-llm/runtime/internal/storage"
	"github.com/digitalcenter/vscode-ex-llm/runtime/internal/tools"
)

type promptCaptureProvider struct {
	lastPrompt string
}

func (p *promptCaptureProvider) Name() string {
	return "capture"
}

func (p *promptCaptureProvider) Generate(_ context.Context, prompt string) (string, error) {
	p.lastPrompt = prompt
	return "captured", nil
}

func (p *promptCaptureProvider) GenerateStream(_ context.Context, prompt string, onToken func(string) error) error {
	p.lastPrompt = prompt
	if onToken != nil {
		return onToken("captured")
	}

	return nil
}

func TestRunRejectsEmptyPrompt(t *testing.T) {
	svc := NewService(mock.NewProvider(), tools.NewRegistry())

	_, err := svc.Run(context.Background(), agentapi.AgentRequest{})
	if !errors.Is(err, ErrInvalidRequest) {
		t.Fatalf("expected ErrInvalidRequest, got %v", err)
	}
}

func TestRunReturnsStructuredResponse(t *testing.T) {
	svc := NewService(mock.NewProvider(), tools.NewRegistry())

	resp, err := svc.Run(context.Background(), agentapi.AgentRequest{
		Prompt: "refactor auth module",
		Settings: agentapi.AgentSettings{
			MaxSteps: 4,
			DryRun:   true,
		},
	})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	if resp.Status != "completed" {
		t.Fatalf("expected completed status, got %q", resp.Status)
	}

	if len(resp.Plan) != 4 {
		t.Fatalf("expected 4 plan steps, got %d", len(resp.Plan))
	}

	if resp.FinalMessage == "" {
		t.Fatal("expected non-empty final message")
	}
}

func TestRunStreamEmitsDoneEvent(t *testing.T) {
	svc := NewService(mock.NewProvider(), tools.NewRegistry())

	sawToken := false
	sawDone := false

	_, err := svc.RunStream(context.Background(), agentapi.AgentRequest{
		Prompt: "describe project status",
		Settings: agentapi.AgentSettings{
			MaxSteps: 3,
			DryRun:   true,
		},
	}, func(event string, payload any) error {
		switch event {
		case "token":
			sawToken = true
		case "done":
			sawDone = true
		}

		return nil
	})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	if !sawToken {
		t.Fatal("expected at least one streamed token")
	}

	if !sawDone {
		t.Fatal("expected done event")
	}
}

func TestRunCreatesFileDeterministically(t *testing.T) {
	workspaceRoot := t.TempDir()
	registry := tools.NewRegistry()
	registry.Register(tools.NewCreateFileTool())

	svc := NewService(mock.NewProvider(), registry)

	resp, err := svc.Run(context.Background(), agentapi.AgentRequest{
		Prompt: "create a new file named notes.txt in root of the project",
		Context: agentapi.AgentContext{
			WorkspaceRoot: workspaceRoot,
		},
		Settings: agentapi.AgentSettings{
			MaxSteps: 5,
			DryRun:   false,
		},
	})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	if !strings.Contains(resp.FinalMessage, "Created file") {
		t.Fatalf("expected creation message, got %q", resp.FinalMessage)
	}

	if _, err := os.Stat(filepath.Join(workspaceRoot, "notes.txt")); err != nil {
		t.Fatalf("expected notes.txt to exist: %v", err)
	}
}

func TestRunCreatesFileUsingActiveFileDirFallback(t *testing.T) {
	workspaceRoot := t.TempDir()
	activeFilePath := filepath.Join(workspaceRoot, "active.go")
	if err := os.WriteFile(activeFilePath, []byte("package main\n"), 0o644); err != nil {
		t.Fatalf("failed to create active file fixture: %v", err)
	}

	registry := tools.NewRegistry()
	registry.Register(tools.NewCreateFileTool())

	svc := NewService(mock.NewProvider(), registry)

	resp, err := svc.Run(context.Background(), agentapi.AgentRequest{
		Prompt: "create a new file named sample_notes.md in root of the project",
		Context: agentapi.AgentContext{
			WorkspaceRoot:  "",
			ActiveFilePath: activeFilePath,
		},
		Settings: agentapi.AgentSettings{
			MaxSteps: 5,
			DryRun:   false,
		},
	})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	if !strings.Contains(resp.FinalMessage, "sample_notes.md") {
		t.Fatalf("expected response to mention sample_notes.md, got %q", resp.FinalMessage)
	}

	if _, err := os.Stat(filepath.Join(workspaceRoot, "sample_notes.md")); err != nil {
		t.Fatalf("expected sample_notes.md to exist: %v", err)
	}
}

func TestRunExecutesCommandDeterministicallyInDryRun(t *testing.T) {
	workspaceRoot := t.TempDir()
	registry := tools.NewRegistry()
	registry.Register(tools.NewExecuteCommandTool())

	svc := NewService(mock.NewProvider(), registry)

	resp, err := svc.Run(context.Background(), agentapi.AgentRequest{
		Prompt: "run command \"echo hello\"",
		Context: agentapi.AgentContext{
			WorkspaceRoot: workspaceRoot,
		},
		Settings: agentapi.AgentSettings{
			MaxSteps: 5,
			DryRun:   true,
		},
	})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	if !strings.Contains(resp.FinalMessage, "Dry run: would execute command") {
		t.Fatalf("expected dry-run execution message, got %q", resp.FinalMessage)
	}
}

func TestRunPreservesTripleDotCommandPattern(t *testing.T) {
	workspaceRoot := t.TempDir()
	registry := tools.NewRegistry()
	registry.Register(tools.NewExecuteCommandTool())

	svc := NewService(mock.NewProvider(), registry)

	resp, err := svc.Run(context.Background(), agentapi.AgentRequest{
		Prompt: `run command "go test ./..."`,
		Context: agentapi.AgentContext{
			WorkspaceRoot: workspaceRoot,
		},
		Settings: agentapi.AgentSettings{
			MaxSteps: 5,
			DryRun:   true,
		},
	})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	if !strings.Contains(resp.FinalMessage, "go test ./...") {
		t.Fatalf("expected command to keep ./... pattern, got %q", resp.FinalMessage)
	}
}

func TestRunExecutesCommandAndWritesMarkdownResult(t *testing.T) {
	workspaceRoot := t.TempDir()
	t.Setenv("AGENT_ALLOW_COMMANDS", "true")

	registry := tools.NewRegistry()
	registry.Register(tools.NewExecuteCommandTool())
	registry.Register(tools.NewCreateFileTool())

	svc := NewService(mock.NewProvider(), registry)

	resp, err := svc.Run(context.Background(), agentapi.AgentRequest{
		Prompt: "excute ls commands on the root of the project and make the results on markdown file called resultsoftest.md in the root of the project",
		Context: agentapi.AgentContext{
			WorkspaceRoot: workspaceRoot,
		},
		Settings: agentapi.AgentSettings{
			MaxSteps: 5,
			DryRun:   false,
			Mode:     "agent",
		},
	})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	if !strings.Contains(resp.FinalMessage, "resultsoftest.md") {
		t.Fatalf("expected output filename in response, got %q", resp.FinalMessage)
	}

	resultPath := filepath.Join(workspaceRoot, "resultsoftest.md")
	content, readErr := os.ReadFile(resultPath)
	if readErr != nil {
		t.Fatalf("expected markdown result file: %v", readErr)
	}

	text := string(content)
	if !strings.Contains(text, "# Command Execution Result") {
		t.Fatalf("expected markdown title, got %q", text)
	}

	if !strings.Contains(text, "Command: `ls -la`") {
		t.Fatalf("expected normalized ls command in markdown, got %q", text)
	}
}

func TestRunChatModeBypassesDeterministicActions(t *testing.T) {
	workspaceRoot := t.TempDir()
	registry := tools.NewRegistry()
	registry.Register(tools.NewCreateFileTool())

	svc := NewService(mock.NewProvider(), registry)

	resp, err := svc.Run(context.Background(), agentapi.AgentRequest{
		Prompt: "create a new file named chat_mode_should_not_exist.txt in root of the project",
		Context: agentapi.AgentContext{
			WorkspaceRoot: workspaceRoot,
		},
		Settings: agentapi.AgentSettings{
			MaxSteps: 5,
			DryRun:   false,
			Mode:     "chat",
		},
	})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	if !strings.Contains(resp.FinalMessage, "Generated deterministic draft plan") {
		t.Fatalf("expected provider-generated response in chat mode, got %q", resp.FinalMessage)
	}

	if _, statErr := os.Stat(filepath.Join(workspaceRoot, "chat_mode_should_not_exist.txt")); !errors.Is(statErr, os.ErrNotExist) {
		t.Fatalf("expected file to not be created in chat mode, stat err=%v", statErr)
	}
}

func TestRunFeedsRecentCommandResultsIntoProviderPrompt(t *testing.T) {
	workspaceRoot := t.TempDir()
	t.Setenv("AGENT_ALLOW_COMMANDS", "true")

	provider := &promptCaptureProvider{}
	registry := tools.NewRegistry()
	registry.Register(tools.NewExecuteCommandTool())

	svc := NewService(provider, registry)

	_, err := svc.Run(context.Background(), agentapi.AgentRequest{
		Prompt: `run command "echo memory-check"`,
		Context: agentapi.AgentContext{
			WorkspaceRoot: workspaceRoot,
		},
		Settings: agentapi.AgentSettings{
			MaxSteps: 5,
			DryRun:   false,
			Mode:     "agent",
		},
	})
	if err != nil {
		t.Fatalf("unexpected command execution error: %v", err)
	}

	provider.lastPrompt = ""

	_, err = svc.Run(context.Background(), agentapi.AgentRequest{
		Prompt: "summarize what happened in the previous command",
		Context: agentapi.AgentContext{
			WorkspaceRoot: workspaceRoot,
		},
		Settings: agentapi.AgentSettings{
			MaxSteps: 5,
			DryRun:   false,
			Mode:     "agent",
		},
	})
	if err != nil {
		t.Fatalf("unexpected provider generation error: %v", err)
	}

	if !strings.Contains(provider.lastPrompt, "Recent command results memory") {
		t.Fatalf("expected provider prompt to include command memory block, got %q", provider.lastPrompt)
	}

	if !strings.Contains(provider.lastPrompt, "echo memory-check") {
		t.Fatalf("expected provider prompt to include recent command, got %q", provider.lastPrompt)
	}

	if !strings.Contains(provider.lastPrompt, "memory-check") {
		t.Fatalf("expected provider prompt to include recent stdout, got %q", provider.lastPrompt)
	}
}

// --- compact conversation history tests ---

func TestCompactConversationHistoryEmpty(t *testing.T) {
	result := compactConversationHistory(nil)
	if result != "" {
		t.Fatalf("expected empty string for nil messages, got %q", result)
	}

	result = compactConversationHistory([]agentapi.SessionMessage{})
	if result != "" {
		t.Fatalf("expected empty string for empty messages, got %q", result)
	}
}

func TestCompactConversationHistoryFormatsOneTurn(t *testing.T) {
	messages := []agentapi.SessionMessage{
		{Role: "user", Content: "hello"},
		{Role: "assistant", Content: "hi there"},
	}

	result := compactConversationHistory(messages)

	if !strings.Contains(result, "User: hello") {
		t.Fatalf("expected user turn, got %q", result)
	}

	if !strings.Contains(result, "Assistant: hi there") {
		t.Fatalf("expected assistant turn, got %q", result)
	}
}

func TestCompactConversationHistoryTruncatesLongMessages(t *testing.T) {
	longContent := strings.Repeat("x", historyMaxMsgChars+100)
	messages := []agentapi.SessionMessage{
		{Role: "user", Content: longContent},
		{Role: "assistant", Content: "ok"},
	}

	result := compactConversationHistory(messages)

	if !strings.Contains(result, "...") {
		t.Fatalf("expected truncation indicator in %q", result)
	}

	userLine := ""
	for _, line := range strings.Split(result, "\n") {
		if strings.HasPrefix(line, "User: ") {
			userLine = line
			break
		}
	}

	// prefix "User: " is 6 chars, content max is historyMaxMsgChars, suffix "..." is 3
	maxLineLen := 6 + historyMaxMsgChars + 3
	if len(userLine) > maxLineLen {
		t.Fatalf("user line too long: got %d, want <= %d", len(userLine), maxLineLen)
	}
}

func TestCompactConversationHistoryOmitsEarlierTurns(t *testing.T) {
	// Build more turns than historyMaxTurns.
	messages := make([]agentapi.SessionMessage, 0, (historyMaxTurns+3)*2)
	for i := 0; i < historyMaxTurns+3; i++ {
		messages = append(messages,
			agentapi.SessionMessage{Role: "user", Content: fmt.Sprintf("q%d", i)},
			agentapi.SessionMessage{Role: "assistant", Content: fmt.Sprintf("a%d", i)},
		)
	}

	result := compactConversationHistory(messages)

	if !strings.Contains(result, "omitted") {
		t.Fatalf("expected omitted notice for excess turns, got %q", result)
	}

	// The most recent user message should be present.
	last := historyMaxTurns + 3 - 1
	if !strings.Contains(result, fmt.Sprintf("q%d", last)) {
		t.Fatalf("expected last user message q%d in history, got %q", last, result)
	}
}

func TestCompactHistoryInjectedIntoProviderPrompt(t *testing.T) {
	provider := &promptCaptureProvider{}
	svc := NewServiceWithStore(provider, tools.NewRegistry(), &stubConversationStore{
		messages: []agentapi.SessionMessage{
			{Role: "user", Content: "what is 2+2"},
			{Role: "assistant", Content: "It is 4"},
		},
	})

	_, err := svc.Run(context.Background(), agentapi.AgentRequest{
		Prompt:    "follow up question",
		SessionID: "test-session-1",
		Settings:  agentapi.AgentSettings{MaxSteps: 1},
	})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	if !strings.Contains(provider.lastPrompt, "Conversation history:") {
		t.Fatalf("expected conversation history section in prompt, got %q", provider.lastPrompt)
	}

	if !strings.Contains(provider.lastPrompt, "what is 2+2") {
		t.Fatalf("expected prior user message in prompt, got %q", provider.lastPrompt)
	}

	if !strings.Contains(provider.lastPrompt, "It is 4") {
		t.Fatalf("expected prior assistant reply in prompt, got %q", provider.lastPrompt)
	}
}

// stubConversationStore is a minimal in-memory store used by tests.
type stubConversationStore struct {
	messages []agentapi.SessionMessage
}

func (s *stubConversationStore) EnsureSession(_ context.Context, input storage.SessionUpsertInput) (storage.SessionState, error) {
	id := input.SessionID
	if id == "" {
		id = "stub-session"
	}

	return storage.SessionState{ID: id, Created: false}, nil
}

func (s *stubConversationStore) RecordRequest(_ context.Context, _ storage.RequestRecord) error {
	return nil
}

func (s *stubConversationStore) RecordResponse(_ context.Context, _ storage.ResponseRecord) error {
	return nil
}

func (s *stubConversationStore) LoadRecentMessages(_ context.Context, _ string, _ int) ([]agentapi.SessionMessage, error) {
	return s.messages, nil
}
