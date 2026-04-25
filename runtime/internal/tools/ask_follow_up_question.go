package tools

import (
	"context"
	"fmt"
	"regexp"
	"strings"
)

const (
	defaultFollowUpQuestionCount = 3
	maxFollowUpQuestionCount     = 5
)

type AskFollowUpQuestionTool struct{}

func NewAskFollowUpQuestionTool() *AskFollowUpQuestionTool {
	return &AskFollowUpQuestionTool{}
}

func (t *AskFollowUpQuestionTool) Name() string {
	return "ask_follow_up_question"
}

func (t *AskFollowUpQuestionTool) Run(_ context.Context, input map[string]any) (map[string]any, error) {
	prompt := strings.TrimSpace(stringInput(input, "prompt"))
	if prompt == "" {
		return nil, fmt.Errorf("prompt is required")
	}

	selectedText := strings.TrimSpace(stringInput(input, "selected_text"))
	activeFilePath := strings.TrimSpace(stringInput(input, "active_file_path"))
	maxQuestions := intInput(input, "max_questions", defaultFollowUpQuestionCount)
	if maxQuestions <= 0 {
		maxQuestions = defaultFollowUpQuestionCount
	}
	if maxQuestions > maxFollowUpQuestionCount {
		maxQuestions = maxFollowUpQuestionCount
	}

	questions := buildFollowUpQuestions(prompt, selectedText, activeFilePath)
	if len(questions) > maxQuestions {
		questions = questions[:maxQuestions]
	}

	needsFollowUp := len(questions) > 0
	reason := "prompt is sufficiently specific"
	if needsFollowUp {
		reason = "prompt is missing details needed for an actionable plan"
	}

	return map[string]any{
		"needs_follow_up": needsFollowUp,
		"question_count":  len(questions),
		"questions":       questions,
		"reason":          reason,
	}, nil
}

func buildFollowUpQuestions(prompt string, selectedText string, activeFilePath string) []string {
	trimmedPrompt := strings.TrimSpace(prompt)
	lowerPrompt := strings.ToLower(trimmedPrompt)

	questions := make([]string, 0, 5)
	seen := map[string]struct{}{}
	addQuestion := func(question string) {
		normalized := strings.TrimSpace(question)
		if normalized == "" {
			return
		}

		key := strings.ToLower(normalized)
		if _, exists := seen[key]; exists {
			return
		}

		seen[key] = struct{}{}
		questions = append(questions, normalized)
	}

	wordCount := len(strings.Fields(trimmedPrompt))
	if wordCount < 6 {
		addQuestion("What exact outcome do you want from this task?")
	}

	hasTargetPath := regexp.MustCompile(`(?i)\b[a-z0-9._/-]+\.[a-z0-9]+\b|[/\\]`).MatchString(trimmedPrompt)
	if !hasTargetPath && strings.TrimSpace(selectedText) == "" {
		addQuestion("Which file, module, or feature area should this plan target?")
	}

	if regexp.MustCompile(`\b(it|this|that|these|those|thing|stuff)\b`).MatchString(lowerPrompt) && strings.TrimSpace(selectedText) == "" {
		addQuestion("Can you clarify what 'it/this/that' refers to in the codebase?")
	}

	hasAcceptanceCriteria := regexp.MustCompile(`(?i)\b(test|verify|acceptance|done when|success|expected result|criteria)\b`).MatchString(lowerPrompt)
	if !hasAcceptanceCriteria {
		addQuestion("How should we verify the task is complete (tests, behavior, or output)?")
	}

	if activeFilePath == "" && !hasTargetPath {
		addQuestion("Are there workspace constraints or folders I should avoid while planning?")
	}

	return questions
}
