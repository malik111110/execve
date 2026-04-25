package agent

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"time"

	agentapi "github.com/digitalcenter/vscode-ex-llm/runtime/internal/api"
	"github.com/digitalcenter/vscode-ex-llm/runtime/internal/providers"
	"github.com/digitalcenter/vscode-ex-llm/runtime/internal/tools"
)

var ErrInvalidRequest = errors.New("invalid request")

const (
	maxCommandMemoryEntries      = 6
	maxCommandMemoryPromptBlocks = 3
	maxCommandMemoryOutputChars  = 1200
)

var (
	quotedPathPattern        = regexp.MustCompile(`["']([^"']+)["']`)
	namedPathPattern         = regexp.MustCompile(`(?i)\b(?:named|called)\s+([a-z0-9._/-]+)`)
	filePathPattern          = regexp.MustCompile(`(?i)\bfile\s+([a-z0-9._/-]+)`)
	quotedCommandPattern     = regexp.MustCompile(`(?i)\b(?:run|execute|exec|excute)(?:\s+command)?\s+["']([^"']+)["']`)
	runCommandPattern        = regexp.MustCompile(`(?i)\b(?:run|execute|exec|excute)(?:\s+command)?\s+(.+)$`)
	outputFilePattern        = regexp.MustCompile(`(?i)([a-z0-9._/-]+\.md)\b`)
	commandToFileTailPattern = regexp.MustCompile(`(?i)\s+and\s+(?:make|save|write)\b.*$`)
	rootScopePattern         = regexp.MustCompile(`(?i)\s+(?:in|on)\s+the\s+root\s+of\s+the\s+project\b`)
)

type StreamEmitter func(event string, payload any) error

type commandMemoryEntry struct {
	Command    string
	ExitCode   int
	TimedOut   bool
	DurationMs int
	Stdout     string
	Stderr     string
	RecordedAt time.Time
}

type Service struct {
	provider      providers.Provider
	registry      *tools.Registry
	memoryMu      sync.Mutex
	commandMemory map[string][]commandMemoryEntry
}

func NewService(provider providers.Provider, registry *tools.Registry) *Service {
	if provider == nil {
		panic("provider is required")
	}

	if registry == nil {
		registry = tools.NewRegistry()
	}

	return &Service{
		provider:      provider,
		registry:      registry,
		commandMemory: make(map[string][]commandMemoryEntry),
	}
}

func (s *Service) Run(ctx context.Context, req agentapi.AgentRequest) (agentapi.AgentResponse, error) {
	requestID := fmt.Sprintf("req-%d", time.Now().UnixNano())
	return s.runInternal(ctx, requestID, req, nil)
}

func (s *Service) RunStream(ctx context.Context, req agentapi.AgentRequest, emit StreamEmitter) (agentapi.AgentResponse, error) {
	if emit == nil {
		return agentapi.AgentResponse{}, fmt.Errorf("%w: stream emitter is required", ErrInvalidRequest)
	}

	requestID := fmt.Sprintf("req-%d", time.Now().UnixNano())
	if err := emit("status", map[string]string{"requestId": requestID, "status": "started"}); err != nil {
		return agentapi.AgentResponse{}, err
	}

	return s.runInternal(ctx, requestID, req, emit)
}

func (s *Service) runInternal(
	ctx context.Context,
	requestID string,
	req agentapi.AgentRequest,
	emit StreamEmitter,
) (agentapi.AgentResponse, error) {
	started := time.Now()

	if strings.TrimSpace(req.Prompt) == "" {
		err := fmt.Errorf("%w: prompt is required", ErrInvalidRequest)
		s.emitError(emit, requestID, err)
		return agentapi.AgentResponse{}, err
	}

	maxSteps := normalizeMaxSteps(req.Settings.MaxSteps)
	plan := buildPlan(maxSteps)

	if emit != nil {
		if err := emit("status", map[string]string{"requestId": requestID, "status": "planning"}); err != nil {
			return agentapi.AgentResponse{}, err
		}

		for _, step := range plan {
			if err := emit("plan", step); err != nil {
				return agentapi.AgentResponse{}, err
			}
		}
	}

	if emit != nil {
		if err := emit("status", map[string]string{"requestId": requestID, "status": "tooling"}); err != nil {
			return agentapi.AgentResponse{}, err
		}
	}

	mode := normalizeExecutionMode(req.Settings.Mode)
	memoryKey := s.commandMemoryKey(req.Context)

	if mode == "agent" {
		deterministicMessage, deterministicObservations, deterministicHandled, deterministicErr := s.tryDeterministicAction(ctx, req)
		if deterministicHandled {
			observations := []agentapi.Observation{{
				Source:  "runtime",
				Message: "deterministic action executed",
			}}

			toolNames := s.registry.Names()
			if len(toolNames) == 0 {
				observations = append(observations, agentapi.Observation{
					Source:  "tools",
					Message: "no tools registered yet",
				})
			} else {
				observations = append(observations, agentapi.Observation{
					Source:  "tools",
					Message: fmt.Sprintf("registered=%s", strings.Join(toolNames, ",")),
				})
			}

			observations = append(observations, deterministicObservations...)

			if emit != nil {
				for _, observation := range observations {
					if err := emit("observation", observation); err != nil {
						return agentapi.AgentResponse{}, err
					}
				}
			}

			if deterministicErr != nil {
				s.emitError(emit, requestID, deterministicErr)
				return agentapi.AgentResponse{}, deterministicErr
			}

			if emit != nil {
				if err := emit("status", map[string]string{"requestId": requestID, "status": "acting"}); err != nil {
					return agentapi.AgentResponse{}, err
				}

				if deterministicMessage != "" {
					if err := emit("token", map[string]string{"requestId": requestID, "text": deterministicMessage}); err != nil {
						return agentapi.AgentResponse{}, err
					}
				}
			}

			response := agentapi.AgentResponse{
				RequestID:    requestID,
				Status:       "completed",
				Plan:         plan,
				Observations: observations,
				FinalMessage: deterministicMessage,
				DurationMs:   time.Since(started).Milliseconds(),
			}

			if emit != nil {
				if err := emit("status", map[string]string{"requestId": requestID, "status": "completed"}); err != nil {
					return agentapi.AgentResponse{}, err
				}

				if err := emit("done", response); err != nil {
					return agentapi.AgentResponse{}, err
				}
			}

			return response, nil
		}
	}

	toolObservations, toolContextBlocks := s.runCandidateTools(ctx, req)
	if commandMemoryBlock, commandMemoryCount := s.buildCommandMemoryContext(memoryKey); commandMemoryBlock != "" {
		toolContextBlocks = append(toolContextBlocks, commandMemoryBlock)
		toolObservations = append(toolObservations, agentapi.Observation{
			Source:  "memory.command_results",
			Message: fmt.Sprintf("loaded %d recent command result(s)", commandMemoryCount),
		})
	}

	if mode == "chat" {
		toolObservations = append([]agentapi.Observation{{
			Source:  "runtime",
			Message: "mode=chat (deterministic actions disabled)",
		}}, toolObservations...)
	}

	observations := []agentapi.Observation{
		{Source: "runtime", Message: "deterministic loop completed"},
		{Source: "provider", Message: fmt.Sprintf("provider=%s", s.provider.Name())},
	}

	toolNames := s.registry.Names()
	if len(toolNames) == 0 {
		observations = append(observations, agentapi.Observation{
			Source:  "tools",
			Message: "no tools registered yet",
		})
	} else {
		observations = append(observations, agentapi.Observation{
			Source:  "tools",
			Message: fmt.Sprintf("registered=%s", strings.Join(toolNames, ",")),
		})
	}

	observations = append(observations, toolObservations...)

	if emit != nil {
		for _, observation := range observations {
			if err := emit("observation", observation); err != nil {
				return agentapi.AgentResponse{}, err
			}
		}
	}

	providerPrompt := buildProviderPrompt(req, toolContextBlocks)
	finalMessage, err := s.generateProviderOutput(ctx, requestID, providerPrompt, emit)
	if err != nil {
		s.emitError(emit, requestID, err)
		return agentapi.AgentResponse{}, err
	}

	response := agentapi.AgentResponse{
		RequestID:    requestID,
		Status:       "completed",
		Plan:         plan,
		Observations: observations,
		FinalMessage: finalMessage,
		DurationMs:   time.Since(started).Milliseconds(),
	}

	if emit != nil {
		if err := emit("status", map[string]string{"requestId": requestID, "status": "completed"}); err != nil {
			return agentapi.AgentResponse{}, err
		}

		if err := emit("done", response); err != nil {
			return agentapi.AgentResponse{}, err
		}
	}

	return response, nil
}

func (s *Service) generateProviderOutput(
	ctx context.Context,
	requestID string,
	prompt string,
	emit StreamEmitter,
) (string, error) {
	if emit == nil {
		return s.provider.Generate(ctx, prompt)
	}

	if err := emit("status", map[string]string{"requestId": requestID, "status": "generating"}); err != nil {
		return "", err
	}

	var builder strings.Builder
	streamErr := s.provider.GenerateStream(ctx, prompt, func(token string) error {
		token = strings.TrimRight(token, "\x00")
		if token == "" {
			return nil
		}

		builder.WriteString(token)
		return emit("token", map[string]string{"requestId": requestID, "text": token})
	})
	if streamErr != nil {
		return "", streamErr
	}

	message := strings.TrimSpace(builder.String())
	if message != "" {
		return message, nil
	}

	fallback, err := s.provider.Generate(ctx, prompt)
	if err != nil {
		return "", err
	}

	if fallback != "" {
		if err := emit("token", map[string]string{"requestId": requestID, "text": fallback}); err != nil {
			return "", err
		}
	}

	return fallback, nil
}

func (s *Service) runCandidateTools(ctx context.Context, req agentapi.AgentRequest) ([]agentapi.Observation, []string) {
	observations := make([]agentapi.Observation, 0, 3)
	contextBlocks := make([]string, 0, 3)
	lowerPrompt := strings.ToLower(req.Prompt)

	if req.Context.ActiveFilePath != "" {
		result, err := s.registry.Run(ctx, "read_file", map[string]any{
			"workspace_root": req.Context.WorkspaceRoot,
			"path":           req.Context.ActiveFilePath,
			"start_line":     1,
			"end_line":       140,
			"max_bytes":      12 * 1024,
		})
		if err != nil {
			observations = append(observations, agentapi.Observation{
				Source:  "tool.read_file",
				Message: fmt.Sprintf("failed: %v", err),
			})
		} else {
			content := mapString(result, "content")
			if content != "" {
				contextBlocks = append(contextBlocks, fmt.Sprintf(
					"Active file excerpt (%s lines %d-%d):\n%s",
					mapString(result, "path"),
					mapInt(result, "line_start"),
					mapInt(result, "line_end"),
					content,
				))
			}

			observations = append(observations, agentapi.Observation{
				Source:  "tool.read_file",
				Message: fmt.Sprintf("loaded lines %d-%d", mapInt(result, "line_start"), mapInt(result, "line_end")),
			})
		}
	}

	if req.Context.WorkspaceRoot != "" && shouldSearch(lowerPrompt, req.Context.SelectedText) {
		query := deriveSearchQuery(req)
		if query != "" {
			result, err := s.registry.Run(ctx, "search_code", map[string]any{
				"workspace_root": req.Context.WorkspaceRoot,
				"query":          query,
				"max_results":    12,
			})
			if err != nil {
				observations = append(observations, agentapi.Observation{
					Source:  "tool.search_code",
					Message: fmt.Sprintf("failed: %v", err),
				})
			} else {
				preview := mapString(result, "preview")
				if preview != "" {
					contextBlocks = append(contextBlocks, "Code search preview:\n"+preview)
				}

				observations = append(observations, agentapi.Observation{
					Source:  "tool.search_code",
					Message: fmt.Sprintf("query=%q matches=%d", query, mapInt(result, "match_count")),
				})
			}
		}
	}

	if req.Context.WorkspaceRoot != "" && shouldGetDiff(lowerPrompt) {
		result, err := s.registry.Run(ctx, "git_diff", map[string]any{
			"workspace_root": req.Context.WorkspaceRoot,
			"max_bytes":      12 * 1024,
		})
		if err != nil {
			observations = append(observations, agentapi.Observation{
				Source:  "tool.git_diff",
				Message: fmt.Sprintf("failed: %v", err),
			})
		} else {
			hasChanges := mapBool(result, "has_changes")
			diff := mapString(result, "diff")
			if hasChanges && diff != "" {
				contextBlocks = append(contextBlocks, "Git diff excerpt:\n"+diff)
			}

			message := "no local changes"
			if hasChanges {
				message = "captured workspace diff excerpt"
			}

			observations = append(observations, agentapi.Observation{
				Source:  "tool.git_diff",
				Message: message,
			})
		}
	}

	return observations, contextBlocks
}

func buildProviderPrompt(req agentapi.AgentRequest, contextBlocks []string) string {
	var builder strings.Builder

	if promptBundle := loadPromptBundle(req.Context.WorkspaceRoot); promptBundle != "" {
		builder.WriteString("Agent guidance from repository prompts:\n")
		builder.WriteString(promptBundle)
		builder.WriteString("\n\n")
	}

	builder.WriteString("User request:\n")
	builder.WriteString(strings.TrimSpace(req.Prompt))
	builder.WriteString("\n")

	if strings.TrimSpace(req.Context.SelectedText) != "" {
		builder.WriteString("\nSelected text from editor:\n")
		builder.WriteString(req.Context.SelectedText)
		builder.WriteString("\n")
	}

	if len(contextBlocks) > 0 {
		builder.WriteString("\nContext gathered by runtime tools:\n")
		for _, block := range contextBlocks {
			builder.WriteString("\n---\n")
			builder.WriteString(block)
			builder.WriteString("\n")
		}
	}

	return builder.String()
}

func loadPromptBundle(workspaceRoot string) string {
	workspaceRoot = strings.TrimSpace(workspaceRoot)
	if workspaceRoot == "" {
		return ""
	}

	bundles := []struct {
		title   string
		relPath string
		limit   int
	}{
		{title: "System", relPath: "prompts/agents/main.system.md", limit: 8 * 1024},
		{title: "Tool Catalog", relPath: "prompts/tools/catalog.json", limit: 8 * 1024},
		{title: "Edit Policy", relPath: "prompts/parsing/file-modification-policy.md", limit: 8 * 1024},
	}

	var sections []string
	for _, bundle := range bundles {
		content := loadPromptFile(workspaceRoot, bundle.relPath, bundle.limit)
		if content == "" {
			continue
		}

		sections = append(sections, fmt.Sprintf("[%s]\n%s", bundle.title, content))
	}

	return strings.Join(sections, "\n\n")
}

func loadPromptFile(workspaceRoot string, relPath string, maxBytes int) string {
	filePath := filepath.Join(workspaceRoot, relPath)
	content, err := os.ReadFile(filePath)
	if err != nil {
		return ""
	}

	if maxBytes > 0 && len(content) > maxBytes {
		content = content[:maxBytes]
	}

	return strings.TrimSpace(string(content))
}

func normalizeMaxSteps(maxSteps int) int {
	if maxSteps <= 0 {
		return 5
	}

	if maxSteps > 10 {
		return 10
	}

	return maxSteps
}

func shouldSearch(lowerPrompt string, selectedText string) bool {
	if strings.TrimSpace(selectedText) != "" {
		return true
	}

	for _, token := range []string{"search", "find", "grep", "where", "lookup", "reference"} {
		if strings.Contains(lowerPrompt, token) {
			return true
		}
	}

	return false
}

func shouldGetDiff(lowerPrompt string) bool {
	for _, token := range []string{"diff", "change", "git", "commit", "status"} {
		if strings.Contains(lowerPrompt, token) {
			return true
		}
	}

	return false
}

func deriveSearchQuery(req agentapi.AgentRequest) string {
	selected := strings.TrimSpace(req.Context.SelectedText)
	if selected != "" {
		lines := strings.Split(selected, "\n")
		candidate := strings.TrimSpace(lines[0])
		if len(candidate) > 120 {
			candidate = candidate[:120]
		}

		return candidate
	}

	prompt := strings.TrimSpace(req.Prompt)
	if len(prompt) > 120 {
		prompt = prompt[:120]
	}

	return prompt
}

func (s *Service) tryDeterministicAction(
	ctx context.Context,
	req agentapi.AgentRequest,
) (string, []agentapi.Observation, bool, error) {
	workspaceRoot := resolveWorkspaceRoot(req.Context)
	memoryKey := s.commandMemoryKey(req.Context)

	commandForFile, outputFilePath, isCommandToFileRequest := parseCommandToMarkdownFileRequest(req.Prompt)
	if isCommandToFileRequest {
		if workspaceRoot == "" {
			return "", []agentapi.Observation{{
				Source:  "tool.execute_command",
				Message: "failed: workspace root is empty",
			}}, true, fmt.Errorf("%w: workspace root is required for command execution", ErrInvalidRequest)
		}

		commandResult, commandErr := s.registry.Run(ctx, "execute_command", map[string]any{
			"workspace_root":   workspaceRoot,
			"command":          commandForFile,
			"dry_run":          req.Settings.DryRun,
			"timeout_ms":       120000,
			"max_output_bytes": 32768,
		})
		if commandErr != nil {
			return "", []agentapi.Observation{{
				Source:  "tool.execute_command",
				Message: fmt.Sprintf("failed: %v", commandErr),
			}}, true, commandErr
		}

		s.rememberCommandResult(memoryKey, commandResult)

		observations := []agentapi.Observation{{
			Source:  "tool.execute_command",
			Message: summarizeCommandResult(commandResult),
		}}

		if stdoutPreview := previewOutput(mapString(commandResult, "stdout")); stdoutPreview != "" {
			observations = append(observations, agentapi.Observation{
				Source:  "tool.execute_command.stdout",
				Message: stdoutPreview,
			})
		}

		if stderrPreview := previewOutput(mapString(commandResult, "stderr")); stderrPreview != "" {
			observations = append(observations, agentapi.Observation{
				Source:  "tool.execute_command.stderr",
				Message: stderrPreview,
			})
		}

		markdownContent := formatCommandResultMarkdown(commandResult)
		createResult, createErr := s.registry.Run(ctx, "create_file", map[string]any{
			"workspace_root": workspaceRoot,
			"path":           outputFilePath,
			"content":        markdownContent,
			"overwrite":      true,
			"dry_run":        req.Settings.DryRun,
			"create_dirs":    true,
		})
		if createErr != nil {
			observations = append(observations, agentapi.Observation{
				Source:  "tool.create_file",
				Message: fmt.Sprintf("failed: %v", createErr),
			})
			return "", observations, true, createErr
		}

		displayPath := mapString(createResult, "display_path")
		if displayPath == "" {
			displayPath = mapString(createResult, "path")
		}

		dryRun := mapBool(createResult, "dry_run")
		message := fmt.Sprintf("Executed %q and wrote results to %s", commandForFile, displayPath)
		if dryRun {
			message = fmt.Sprintf("Dry run: would execute %q and write results to %s", commandForFile, displayPath)
		}

		observations = append(observations, agentapi.Observation{
			Source:  "tool.create_file",
			Message: message,
		})

		return message, observations, true, nil
	}

	filePath, isCreateFileRequest := parseCreateFileRequest(req.Prompt)
	if isCreateFileRequest {
		if workspaceRoot == "" {
			return "", []agentapi.Observation{{
				Source:  "tool.create_file",
				Message: "failed: workspace root is empty",
			}}, true, fmt.Errorf("%w: workspace root is required for file creation", ErrInvalidRequest)
		}

		result, err := s.registry.Run(ctx, "create_file", map[string]any{
			"workspace_root": workspaceRoot,
			"path":           filePath,
			"content":        "",
			"overwrite":      false,
			"dry_run":        req.Settings.DryRun,
			"create_dirs":    true,
		})
		if err != nil {
			return "", []agentapi.Observation{{
				Source:  "tool.create_file",
				Message: fmt.Sprintf("failed: %v", err),
			}}, true, err
		}

		displayPath := mapString(result, "display_path")
		if displayPath == "" {
			displayPath = mapString(result, "path")
		}

		created := mapBool(result, "created")
		overwritten := mapBool(result, "overwritten")
		exists := mapBool(result, "exists")
		dryRun := mapBool(result, "dry_run")

		message := fmt.Sprintf("Created file %s", displayPath)
		switch {
		case dryRun && exists:
			message = fmt.Sprintf("Dry run: file already exists at %s", displayPath)
		case dryRun && overwritten:
			message = fmt.Sprintf("Dry run: would overwrite file %s", displayPath)
		case dryRun:
			message = fmt.Sprintf("Dry run: would create file %s", displayPath)
		case exists && !overwritten && !created:
			message = fmt.Sprintf("File already exists: %s", displayPath)
		case overwritten:
			message = fmt.Sprintf("Updated file %s", displayPath)
		}

		return message, []agentapi.Observation{{
			Source:  "tool.create_file",
			Message: message,
		}}, true, nil
	}

	command, isExecuteCommandRequest := parseExecuteCommandRequest(req.Prompt)
	if !isExecuteCommandRequest {
		return "", nil, false, nil
	}

	if workspaceRoot == "" {
		return "", []agentapi.Observation{{
			Source:  "tool.execute_command",
			Message: "failed: workspace root is empty",
		}}, true, fmt.Errorf("%w: workspace root is required for command execution", ErrInvalidRequest)
	}

	result, err := s.registry.Run(ctx, "execute_command", map[string]any{
		"workspace_root":   workspaceRoot,
		"command":          command,
		"dry_run":          req.Settings.DryRun,
		"timeout_ms":       120000,
		"max_output_bytes": 32768,
	})
	if err != nil {
		return "", []agentapi.Observation{{
			Source:  "tool.execute_command",
			Message: fmt.Sprintf("failed: %v", err),
		}}, true, err
	}

	s.rememberCommandResult(memoryKey, result)

	message := summarizeCommandResult(result)
	observations := []agentapi.Observation{{
		Source:  "tool.execute_command",
		Message: message,
	}}

	if stdoutPreview := previewOutput(mapString(result, "stdout")); stdoutPreview != "" {
		observations = append(observations, agentapi.Observation{
			Source:  "tool.execute_command.stdout",
			Message: stdoutPreview,
		})
	}

	if stderrPreview := previewOutput(mapString(result, "stderr")); stderrPreview != "" {
		observations = append(observations, agentapi.Observation{
			Source:  "tool.execute_command.stderr",
			Message: stderrPreview,
		})
	}

	return message, observations, true, nil
}

func resolveWorkspaceRoot(ctx agentapi.AgentContext) string {
	workspaceRoot := strings.TrimSpace(ctx.WorkspaceRoot)
	if workspaceRoot == "" && strings.TrimSpace(ctx.ActiveFilePath) != "" {
		workspaceRoot = filepath.Dir(strings.TrimSpace(ctx.ActiveFilePath))
	}

	return workspaceRoot
}

func parseExecuteCommandRequest(prompt string) (string, bool) {
	trimmedPrompt := strings.TrimSpace(prompt)
	lowerPrompt := strings.ToLower(trimmedPrompt)

	hasCommandIntent := strings.Contains(lowerPrompt, "run") || strings.Contains(lowerPrompt, "execute") || strings.Contains(lowerPrompt, "exec") || strings.Contains(lowerPrompt, "excute")
	if !hasCommandIntent {
		return "", false
	}

	if match := quotedCommandPattern.FindStringSubmatch(trimmedPrompt); len(match) >= 2 {
		command := normalizeCommandCandidate(match[1])
		if command != "" {
			return command, true
		}
	}

	if match := runCommandPattern.FindStringSubmatch(trimmedPrompt); len(match) >= 2 {
		command := normalizeCommandCandidate(match[1])
		if command != "" {
			return command, true
		}
	}

	return "", false
}

func normalizeCommandCandidate(candidate string) string {
	cleaned := strings.TrimSpace(candidate)
	cleaned = strings.Trim(cleaned, "`\"' ")
	cleaned = trimTerminalPunctuation(cleaned)
	if cleaned == "" {
		return ""
	}

	rejected := map[string]struct{}{
		"a command": {},
		"command":   {},
		"commands":  {},
		"a task":    {},
		"task":      {},
		"tasks":     {},
	}

	if _, exists := rejected[strings.ToLower(cleaned)]; exists {
		return ""
	}

	return cleaned
}

func trimTerminalPunctuation(value string) string {
	trimmed := strings.TrimSpace(value)
	for len(trimmed) > 0 {
		last := trimmed[len(trimmed)-1]
		if last == '!' || last == '?' {
			trimmed = strings.TrimSpace(trimmed[:len(trimmed)-1])
			continue
		}

		if last == '.' {
			if strings.HasSuffix(trimmed, "...") {
				break
			}

			trimmed = strings.TrimSpace(trimmed[:len(trimmed)-1])
			continue
		}

		break
	}

	return trimmed
}

func summarizeCommandResult(result map[string]any) string {
	command := mapString(result, "command")
	exitCode := mapInt(result, "exit_code")
	dryRun := mapBool(result, "dry_run")
	timedOut := mapBool(result, "timed_out")

	if dryRun {
		return fmt.Sprintf("Dry run: would execute command: %s", command)
	}

	if timedOut {
		return fmt.Sprintf("Command timed out: %s", command)
	}

	if exitCode == 0 {
		return fmt.Sprintf("Command succeeded: %s", command)
	}

	return fmt.Sprintf("Command failed (exit %d): %s", exitCode, command)
}

func previewOutput(output string) string {
	trimmed := strings.TrimSpace(output)
	if trimmed == "" {
		return ""
	}

	if len(trimmed) > 300 {
		return trimmed[:300] + "..."
	}

	return trimmed
}

func parseCreateFileRequest(prompt string) (string, bool) {
	lowerPrompt := strings.ToLower(strings.TrimSpace(prompt))
	if !strings.Contains(lowerPrompt, "create") || !strings.Contains(lowerPrompt, "file") {
		return "", false
	}

	for _, match := range quotedPathPattern.FindAllStringSubmatch(prompt, -1) {
		candidate := sanitizePathCandidate(match[1])
		if candidate != "" {
			return candidate, true
		}
	}

	for _, pattern := range []*regexp.Regexp{namedPathPattern, filePathPattern} {
		match := pattern.FindStringSubmatch(prompt)
		if len(match) < 2 {
			continue
		}

		candidate := sanitizePathCandidate(match[1])
		if candidate != "" {
			return candidate, true
		}
	}

	return "new_file.txt", true
}

func parseCommandToMarkdownFileRequest(prompt string) (string, string, bool) {
	lowerPrompt := strings.ToLower(strings.TrimSpace(prompt))
	if !strings.Contains(lowerPrompt, "file") {
		return "", "", false
	}

	if !(strings.Contains(lowerPrompt, "result") || strings.Contains(lowerPrompt, "save") || strings.Contains(lowerPrompt, "write") || strings.Contains(lowerPrompt, "make")) {
		return "", "", false
	}

	outputMatch := outputFilePattern.FindStringSubmatch(lowerPrompt)
	if len(outputMatch) < 2 {
		return "", "", false
	}

	outputFile := sanitizePathCandidate(outputMatch[1])
	if outputFile == "" {
		return "", "", false
	}

	if command, ok := extractCommandForCommandToFile(prompt); ok {
		return command, outputFile, true
	}

	if strings.Contains(lowerPrompt, " ls ") || strings.HasPrefix(lowerPrompt, "ls ") || strings.Contains(lowerPrompt, "ls command") || strings.Contains(lowerPrompt, "ls commands") {
		return "ls -la", outputFile, true
	}

	return "", "", false
}

func extractCommandForCommandToFile(prompt string) (string, bool) {
	trimmed := strings.TrimSpace(prompt)

	if match := quotedCommandPattern.FindStringSubmatch(trimmed); len(match) >= 2 {
		command := normalizeCommandCandidate(match[1])
		if command != "" {
			return command, true
		}
	}

	if match := runCommandPattern.FindStringSubmatch(trimmed); len(match) >= 2 {
		candidate := strings.TrimSpace(match[1])
		candidate = commandToFileTailPattern.ReplaceAllString(candidate, "")
		candidate = rootScopePattern.ReplaceAllString(candidate, "")
		candidate = strings.TrimSpace(candidate)

		lowerCandidate := strings.ToLower(candidate)
		if lowerCandidate == "ls" || strings.HasPrefix(lowerCandidate, "ls ") || strings.Contains(lowerCandidate, "ls command") || strings.Contains(lowerCandidate, "ls commands") {
			return "ls -la", true
		}

		command := normalizeCommandCandidate(candidate)
		if command != "" {
			return command, true
		}
	}

	return "", false
}

func normalizeExecutionMode(mode string) string {
	mode = strings.ToLower(strings.TrimSpace(mode))
	if mode == "chat" {
		return "chat"
	}

	return "agent"
}

func formatCommandResultMarkdown(result map[string]any) string {
	command := mapString(result, "command")
	if command == "" {
		command = "(unknown)"
	}

	exitCode := mapInt(result, "exit_code")
	durationMs := mapInt(result, "duration_ms")
	timedOut := mapBool(result, "timed_out")
	stdout := mapString(result, "stdout")
	stderr := mapString(result, "stderr")

	if strings.TrimSpace(stdout) == "" {
		stdout = "(empty)"
	}

	if strings.TrimSpace(stderr) == "" {
		stderr = "(empty)"
	}

	var builder strings.Builder
	builder.WriteString("# Command Execution Result\n\n")
	builder.WriteString(fmt.Sprintf("- Command: `%s`\n", command))
	builder.WriteString(fmt.Sprintf("- Exit code: `%d`\n", exitCode))
	builder.WriteString(fmt.Sprintf("- Duration: `%d ms`\n", durationMs))
	if timedOut {
		builder.WriteString("- Timed out: `true`\n")
	}

	builder.WriteString("\n## Stdout\n\n")
	builder.WriteString("```text\n")
	builder.WriteString(stdout)
	if !strings.HasSuffix(stdout, "\n") {
		builder.WriteString("\n")
	}
	builder.WriteString("```\n")

	builder.WriteString("\n## Stderr\n\n")
	builder.WriteString("```text\n")
	builder.WriteString(stderr)
	if !strings.HasSuffix(stderr, "\n") {
		builder.WriteString("\n")
	}
	builder.WriteString("```\n")

	return builder.String()
}

func (s *Service) commandMemoryKey(ctx agentapi.AgentContext) string {
	workspaceRoot := resolveWorkspaceRoot(ctx)
	if workspaceRoot == "" {
		return "__global__"
	}

	return filepath.Clean(workspaceRoot)
}

func (s *Service) rememberCommandResult(memoryKey string, result map[string]any) {
	if strings.TrimSpace(memoryKey) == "" || result == nil || mapBool(result, "dry_run") {
		return
	}

	entry := commandMemoryEntry{
		Command:    mapString(result, "command"),
		ExitCode:   mapInt(result, "exit_code"),
		TimedOut:   mapBool(result, "timed_out"),
		DurationMs: mapInt(result, "duration_ms"),
		Stdout:     truncateCommandMemoryOutput(mapString(result, "stdout")),
		Stderr:     truncateCommandMemoryOutput(mapString(result, "stderr")),
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
		builder.WriteString(fmt.Sprintf("Exit code: %d | Duration: %d ms | Timed out: %t\n", entry.ExitCode, entry.DurationMs, entry.TimedOut))

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

func sanitizePathCandidate(candidate string) string {
	trimmed := strings.TrimSpace(candidate)
	trimmed = strings.Trim(trimmed, ".,;:")
	if trimmed == "" {
		return ""
	}

	rejected := map[string]struct{}{
		"file":    {},
		"new":     {},
		"a":       {},
		"an":      {},
		"the":     {},
		"in":      {},
		"at":      {},
		"to":      {},
		"of":      {},
		"root":    {},
		"project": {},
	}

	if _, denied := rejected[strings.ToLower(trimmed)]; denied {
		return ""
	}

	if strings.ContainsAny(trimmed, " \t\n\r") {
		return ""
	}

	return trimmed
}

func (s *Service) emitError(emit StreamEmitter, requestID string, runErr error) {
	if emit == nil || runErr == nil {
		return
	}

	_ = emit("error", map[string]string{
		"requestId": requestID,
		"message":   runErr.Error(),
	})
}

func mapString(data map[string]any, key string) string {
	if data == nil {
		return ""
	}

	value, ok := data[key]
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

func mapInt(data map[string]any, key string) int {
	if data == nil {
		return 0
	}

	value, ok := data[key]
	if !ok || value == nil {
		return 0
	}

	switch typed := value.(type) {
	case int:
		return typed
	case int64:
		return int(typed)
	case float64:
		return int(typed)
	default:
		return 0
	}
}

func mapBool(data map[string]any, key string) bool {
	if data == nil {
		return false
	}

	value, ok := data[key]
	if !ok || value == nil {
		return false
	}

	typed, ok := value.(bool)
	if !ok {
		return false
	}

	return typed
}

func buildPlan(maxSteps int) []agentapi.PlanStep {
	basePlan := []agentapi.PlanStep{
		{Step: 1, Title: "Validate request and context", Status: "completed"},
		{Step: 2, Title: "Assemble relevant execution context", Status: "completed"},
		{Step: 3, Title: "Select provider and candidate tools", Status: "completed"},
		{Step: 4, Title: "Generate deterministic response draft", Status: "completed"},
		{Step: 5, Title: "Return structured result", Status: "completed"},
	}

	if maxSteps < len(basePlan) {
		return basePlan[:maxSteps]
	}

	return basePlan
}
