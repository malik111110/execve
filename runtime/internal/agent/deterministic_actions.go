package agent

import (
	"context"
	"fmt"
	"path/filepath"
	"strings"

	agentapi "github.com/digitalcenter/vscode-ex-llm/runtime/internal/api"
)

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
			"workspace_root":      workspaceRoot,
			"command":             commandForFile,
			"dry_run":             req.Settings.DryRun,
			"timeout_ms":          120000,
			"max_output_bytes":    32768,
			"wait_for_completion": true,
			"permission_mode":     req.Settings.PermissionMode,
			"permission_policy": map[string]any{
				"allowed_commands": req.Settings.PermissionPolicy.AllowedCommands,
				"blocked_commands": req.Settings.PermissionPolicy.BlockedCommands,
				"allowed_mcps":     req.Settings.PermissionPolicy.AllowedMCPs,
				"blocked_mcps":     req.Settings.PermissionPolicy.BlockedMCPs,
			},
		})
		if commandErr != nil {
			return "", []agentapi.Observation{{
				Source:  "tool.execute_command",
				Message: fmt.Sprintf("failed: %v", commandErr),
			}}, true, commandErr
		}

		s.rememberTerminalState(memoryKey, commandResult)
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

	if promptRequestsContinueCommand(req.Prompt) {
		if workspaceRoot == "" {
			return "", []agentapi.Observation{{
				Source:  "tool.execute_command",
				Message: "failed: workspace root is empty",
			}}, true, fmt.Errorf("%w: workspace root is required for command continuation", ErrInvalidRequest)
		}

		terminalState, ok := s.terminalStateSnapshot(memoryKey)
		if !ok || strings.TrimSpace(terminalState.TerminalID) == "" {
			message := "No terminal command is available to continue yet. Run a command first."
			return message, []agentapi.Observation{{
				Source:  "tool.execute_command",
				Message: message,
			}}, true, nil
		}

		result, err := s.registry.Run(ctx, "execute_command", map[string]any{
			"workspace_root":   workspaceRoot,
			"continue":         true,
			"terminal_id":      terminalState.TerminalID,
			"line_offset":      terminalState.Cursor,
			"wait_ms":          900,
			"max_line_events":  120,
			"max_output_bytes": 32768,
			"permission_mode":  req.Settings.PermissionMode,
			"permission_policy": map[string]any{
				"allowed_commands": req.Settings.PermissionPolicy.AllowedCommands,
				"blocked_commands": req.Settings.PermissionPolicy.BlockedCommands,
				"allowed_mcps":     req.Settings.PermissionPolicy.AllowedMCPs,
				"blocked_mcps":     req.Settings.PermissionPolicy.BlockedMCPs,
			},
		})
		if err != nil {
			return "", []agentapi.Observation{{
				Source:  "tool.execute_command",
				Message: fmt.Sprintf("failed: %v", err),
			}}, true, err
		}

		s.rememberTerminalState(memoryKey, result)
		s.rememberCommandResult(memoryKey, result)

		message := summarizeCommandResult(result)
		observations := []agentapi.Observation{{
			Source:  "tool.execute_command",
			Message: message,
		}}

		if linePreview := previewLineEvents(result); linePreview != "" {
			observations = append(observations, agentapi.Observation{
				Source:  "tool.execute_command.stream",
				Message: linePreview,
			})
		}

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

	if promptRequestsStopCommand(req.Prompt) {
		if workspaceRoot == "" {
			return "", []agentapi.Observation{{
				Source:  "tool.execute_command",
				Message: "failed: workspace root is empty",
			}}, true, fmt.Errorf("%w: workspace root is required for command stop", ErrInvalidRequest)
		}

		terminalState, ok := s.terminalStateSnapshot(memoryKey)
		if !ok || strings.TrimSpace(terminalState.TerminalID) == "" {
			message := "No running terminal command is available to stop."
			return message, []agentapi.Observation{{
				Source:  "tool.execute_command",
				Message: message,
			}}, true, nil
		}

		result, err := s.registry.Run(ctx, "execute_command", map[string]any{
			"workspace_root":   workspaceRoot,
			"stop":             true,
			"terminal_id":      terminalState.TerminalID,
			"line_offset":      terminalState.Cursor,
			"wait_ms":          1500,
			"max_line_events":  120,
			"max_output_bytes": 32768,
			"permission_mode":  req.Settings.PermissionMode,
			"permission_policy": map[string]any{
				"allowed_commands": req.Settings.PermissionPolicy.AllowedCommands,
				"blocked_commands": req.Settings.PermissionPolicy.BlockedCommands,
				"allowed_mcps":     req.Settings.PermissionPolicy.AllowedMCPs,
				"blocked_mcps":     req.Settings.PermissionPolicy.BlockedMCPs,
			},
		})
		if err != nil {
			return "", []agentapi.Observation{{
				Source:  "tool.execute_command",
				Message: fmt.Sprintf("failed: %v", err),
			}}, true, err
		}

		s.rememberTerminalState(memoryKey, result)
		s.rememberCommandResult(memoryKey, result)

		message := summarizeCommandResult(result)
		observations := []agentapi.Observation{{
			Source:  "tool.execute_command",
			Message: message,
		}}

		if linePreview := previewLineEvents(result); linePreview != "" {
			observations = append(observations, agentapi.Observation{
				Source:  "tool.execute_command.stream",
				Message: linePreview,
			})
		}

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

	runInBackground := promptRequestsBackgroundExecution(req.Prompt)
	result, err := s.registry.Run(ctx, "execute_command", map[string]any{
		"workspace_root":      workspaceRoot,
		"command":             command,
		"dry_run":             req.Settings.DryRun,
		"timeout_ms":          120000,
		"max_output_bytes":    32768,
		"max_line_events":     120,
		"wait_for_completion": !runInBackground,
		"stream_lines":        true,
		"permission_mode":     req.Settings.PermissionMode,
		"permission_policy": map[string]any{
			"allowed_commands": req.Settings.PermissionPolicy.AllowedCommands,
			"blocked_commands": req.Settings.PermissionPolicy.BlockedCommands,
			"allowed_mcps":     req.Settings.PermissionPolicy.AllowedMCPs,
			"blocked_mcps":     req.Settings.PermissionPolicy.BlockedMCPs,
		},
	})
	if err != nil {
		return "", []agentapi.Observation{{
			Source:  "tool.execute_command",
			Message: fmt.Sprintf("failed: %v", err),
		}}, true, err
	}

	s.rememberTerminalState(memoryKey, result)
	s.rememberCommandResult(memoryKey, result)

	message := summarizeCommandResult(result)
	observations := []agentapi.Observation{{
		Source:  "tool.execute_command",
		Message: message,
	}}

	if linePreview := previewLineEvents(result); linePreview != "" {
		observations = append(observations, agentapi.Observation{
			Source:  "tool.execute_command.stream",
			Message: linePreview,
		})
	}

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

func normalizeExecutionMode(mode string) string {
	mode = strings.ToLower(strings.TrimSpace(mode))
	if mode == "chat" {
		return "chat"
	}

	if mode == "plan" {
		return "plan"
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
