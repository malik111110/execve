package agent

import (
	"regexp"
	"strings"
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
		commandCandidate := stripExecutionDirectiveSuffix(strings.TrimSpace(match[1]))
		command := normalizeCommandCandidate(commandCandidate)
		if command != "" {
			return command, true
		}
	}

	return "", false
}

func stripExecutionDirectiveSuffix(command string) string {
	trimmed := strings.TrimSpace(command)
	lower := strings.ToLower(trimmed)

	patterns := []string{
		" in background",
		" and continue later",
		" continue later",
		" don't wait",
		" do not wait",
		" and stream output",
		" stream output",
	}

	for _, pattern := range patterns {
		if idx := strings.Index(lower, pattern); idx >= 0 {
			trimmed = strings.TrimSpace(trimmed[:idx])
			lower = strings.ToLower(trimmed)
		}
	}

	return trimmed
}

func promptRequestsContinueCommand(prompt string) bool {
	lowerPrompt := strings.ToLower(strings.TrimSpace(prompt))
	if lowerPrompt == "" {
		return false
	}

	continuePatterns := []string{
		"continue command",
		"continue terminal",
		"continue output",
		"continue previous command",
		"more command output",
		"follow command output",
	}

	for _, pattern := range continuePatterns {
		if strings.Contains(lowerPrompt, pattern) {
			return true
		}
	}

	return false
}

func promptRequestsStopCommand(prompt string) bool {
	lowerPrompt := strings.ToLower(strings.TrimSpace(prompt))
	if lowerPrompt == "" {
		return false
	}

	stopPatterns := []string{
		"stop command",
		"stop running command",
		"stop terminal",
		"stop process",
		"cancel command",
		"kill command",
	}

	for _, pattern := range stopPatterns {
		if strings.Contains(lowerPrompt, pattern) {
			return true
		}
	}

	return false
}

func promptRequestsBackgroundExecution(prompt string) bool {
	lowerPrompt := strings.ToLower(strings.TrimSpace(prompt))
	if lowerPrompt == "" {
		return false
	}

	backgroundPatterns := []string{
		"in background",
		"run in background",
		"don't wait",
		"do not wait",
		"continue later",
		"start and continue",
		"stream output",
	}

	for _, pattern := range backgroundPatterns {
		if strings.Contains(lowerPrompt, pattern) {
			return true
		}
	}

	return false
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
