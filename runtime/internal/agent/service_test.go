package agent

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"

	agentapi "github.com/digitalcenter/vscode-ex-llm/runtime/internal/api"
	"github.com/digitalcenter/vscode-ex-llm/runtime/internal/providers/mock"
	"github.com/digitalcenter/vscode-ex-llm/runtime/internal/tools"
)

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
