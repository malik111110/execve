package agent

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	agentapi "github.com/digitalcenter/vscode-ex-llm/runtime/internal/api"
)

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
