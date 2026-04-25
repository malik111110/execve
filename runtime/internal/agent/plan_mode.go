package agent

import (
	"context"
	"errors"
	"fmt"
	"regexp"
	"strings"

	agentapi "github.com/digitalcenter/vscode-ex-llm/runtime/internal/api"
	"github.com/digitalcenter/vscode-ex-llm/runtime/internal/tools"
)

const (
	defaultPlanQuestionLimit = 3
)

func buildPlanForMode(mode string, maxSteps int, prompt string) []agentapi.PlanStep {
	if mode == "plan" {
		return buildTodoPlan(prompt, maxSteps)
	}

	return buildPlan(maxSteps)
}

func buildTodoPlan(prompt string, maxSteps int) []agentapi.PlanStep {
	tasks := extractTodoTasks(prompt)
	if len(tasks) == 0 {
		tasks = []string{
			"Clarify the objective and constraints",
			"Draft implementation steps",
			"Review risks and validation strategy",
		}
	}

	limit := maxSteps
	if limit <= 0 {
		limit = len(tasks)
	}
	if limit > len(tasks) {
		limit = len(tasks)
	}

	plan := make([]agentapi.PlanStep, 0, limit)
	for idx := 0; idx < limit; idx += 1 {
		plan = append(plan, agentapi.PlanStep{
			Step:   idx + 1,
			Title:  tasks[idx],
			Status: "pending",
		})
	}

	return plan
}

func extractTodoTasks(prompt string) []string {
	cleaned := strings.TrimSpace(prompt)
	if cleaned == "" {
		return nil
	}

	separator := regexp.MustCompile(`(?i)\bthen\b|\band\b|\n|;|,`)
	rawParts := separator.Split(cleaned, -1)

	tasks := make([]string, 0, len(rawParts))
	seen := map[string]struct{}{}

	for _, rawPart := range rawParts {
		part := normalizeTaskFragment(rawPart)
		if part == "" {
			continue
		}

		key := strings.ToLower(part)
		if _, exists := seen[key]; exists {
			continue
		}

		seen[key] = struct{}{}
		tasks = append(tasks, part)
	}

	return tasks
}

func normalizeTaskFragment(fragment string) string {
	cleaned := strings.TrimSpace(fragment)
	if cleaned == "" {
		return ""
	}

	prefixes := []string{
		"please ",
		"i need to ",
		"need to ",
		"can you ",
		"help me ",
	}

	lower := strings.ToLower(cleaned)
	for _, prefix := range prefixes {
		if strings.HasPrefix(lower, prefix) {
			cleaned = strings.TrimSpace(cleaned[len(prefix):])
			lower = strings.ToLower(cleaned)
			break
		}
	}

	cleaned = strings.Trim(cleaned, ".:;,- ")
	if len(cleaned) < 4 {
		return ""
	}

	return strings.ToUpper(cleaned[:1]) + cleaned[1:]
}

func (s *Service) askPlanFollowUpQuestions(
	ctx context.Context,
	req agentapi.AgentRequest,
) ([]string, []agentapi.Observation) {
	result, err := s.registry.Run(ctx, "ask_follow_up_question", map[string]any{
		"prompt":           req.Prompt,
		"selected_text":    req.Context.SelectedText,
		"active_file_path": req.Context.ActiveFilePath,
		"max_questions":    defaultPlanQuestionLimit,
	})
	if err != nil {
		if errorsIsToolNotFound(err) {
			return nil, nil
		}

		return nil, []agentapi.Observation{{
			Source:  "tool.ask_follow_up_question",
			Message: fmt.Sprintf("failed: %v", err),
		}}
	}

	needsFollowUp := mapBool(result, "needs_follow_up")
	questions := mapStringSlice(result, "questions")
	if !needsFollowUp || len(questions) == 0 {
		return nil, []agentapi.Observation{{
			Source:  "tool.ask_follow_up_question",
			Message: "prompt is specific enough; no follow-up questions needed",
		}}
	}

	lines := make([]string, 0, len(questions)+1)
	lines = append(lines, "Follow-up questions:")
	for _, question := range questions {
		lines = append(lines, "- "+question)
	}

	return questions, []agentapi.Observation{{
		Source:  "tool.ask_follow_up_question",
		Message: strings.Join(lines, "\n"),
	}}
}

func errorsIsToolNotFound(err error) bool {
	return errors.Is(err, tools.ErrToolNotFound)
}

func followUpFinalMessage(questions []string) string {
	if len(questions) == 0 {
		return "No follow-up questions are required."
	}

	var builder strings.Builder
	builder.WriteString("Before I can create an actionable todo plan, please clarify:\n")
	for _, question := range questions {
		builder.WriteString("- ")
		builder.WriteString(strings.TrimSpace(question))
		builder.WriteString("\n")
	}

	return strings.TrimSpace(builder.String())
}

func setPlanStatus(plan []agentapi.PlanStep, status string) []agentapi.PlanStep {
	updated := make([]agentapi.PlanStep, len(plan))
	copy(updated, plan)
	for idx := range updated {
		updated[idx].Status = status
	}

	return updated
}
