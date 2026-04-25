package tools

import (
	"fmt"
	"regexp"
	"strings"
)

type ApprovalMode string

const (
	ApprovalModeDefault ApprovalMode = "defaultApproval"
	ApprovalModeBypass  ApprovalMode = "bypassApproval"
	ApprovalModeAuto    ApprovalMode = "autopilot"
)

type CommandApprovalPolicy struct {
	Mode            ApprovalMode
	AllowedCommands []string
	BlockedCommands []string
	AllowedMCPs     []string
	BlockedMCPs     []string
}

var defaultApprovalSafePatterns = []string{
	"echo*",
	"printf*",
	"pwd",
	"ls*",
	"cat*",
	"head*",
	"tail*",
	"wc*",
	"grep*",
	"rg*",
	"sed*",
	"awk*",
	"find*",
	"git status*",
	"git diff*",
	"git log*",
	"go test*",
	"go vet*",
	"go fmt*",
	"npm test*",
	"npm run build*",
	"npm run lint*",
	"pnpm test*",
	"pnpm run build*",
	"yarn test*",
	"pytest*",
	"python -m pytest*",
}

func parseCommandApprovalPolicy(input map[string]any) CommandApprovalPolicy {
	policyInput := mapInput(input, "permission_policy")

	mode, hasMode := stringValue(input, "permission_mode")
	if !hasMode {
		mode, hasMode = stringValue(policyInput, "mode")
	}
	if !hasMode {
		mode = envOrDefault("AGENT_PERMISSION_MODE", string(ApprovalModeDefault))
	}

	allowedCommands, hasAllowedCommands := stringSliceValue(policyInput, "allowed_commands")
	if !hasAllowedCommands {
		allowedCommands, hasAllowedCommands = stringSliceValue(input, "allowed_commands")
	}
	if !hasAllowedCommands {
		allowedCommands = splitListEnv("AGENT_ALLOWED_COMMANDS")
	}

	blockedCommands, hasBlockedCommands := stringSliceValue(policyInput, "blocked_commands")
	if !hasBlockedCommands {
		blockedCommands, hasBlockedCommands = stringSliceValue(input, "blocked_commands")
	}
	if !hasBlockedCommands {
		blockedCommands = splitListEnv("AGENT_BLOCKED_COMMANDS")
	}

	allowedMCPs, hasAllowedMCPs := stringSliceValue(policyInput, "allowed_mcps")
	if !hasAllowedMCPs {
		allowedMCPs, hasAllowedMCPs = stringSliceValue(input, "allowed_mcps")
	}
	if !hasAllowedMCPs {
		allowedMCPs = splitListEnv("AGENT_ALLOWED_MCPS")
	}

	blockedMCPs, hasBlockedMCPs := stringSliceValue(policyInput, "blocked_mcps")
	if !hasBlockedMCPs {
		blockedMCPs, hasBlockedMCPs = stringSliceValue(input, "blocked_mcps")
	}
	if !hasBlockedMCPs {
		blockedMCPs = splitListEnv("AGENT_BLOCKED_MCPS")
	}

	return CommandApprovalPolicy{
		Mode:            normalizeApprovalMode(mode),
		AllowedCommands: normalizePatternList(allowedCommands),
		BlockedCommands: normalizePatternList(blockedCommands),
		AllowedMCPs:     normalizePatternList(allowedMCPs),
		BlockedMCPs:     normalizePatternList(blockedMCPs),
	}
}

func (p CommandApprovalPolicy) ValidateCommand(command string) error {
	trimmedCommand := strings.TrimSpace(command)
	if trimmedCommand == "" {
		return fmt.Errorf("command is required")
	}

	if blockedReason := blockedCommandReason(trimmedCommand); blockedReason != "" {
		return fmt.Errorf("blocked command: %s", blockedReason)
	}

	if pattern, matched := firstMatchingPattern(trimmedCommand, p.BlockedCommands); matched {
		return fmt.Errorf("blocked by command blacklist pattern: %s", pattern)
	}

	if len(p.AllowedCommands) > 0 {
		if _, matched := firstMatchingPattern(trimmedCommand, p.AllowedCommands); !matched {
			return fmt.Errorf(
				"command is not in allowed command list (mode=%s)",
				p.Mode,
			)
		}

		return nil
	}

	if p.Mode == ApprovalModeDefault && !isDefaultApprovalCommandAllowed(trimmedCommand) {
		return fmt.Errorf(
			"command requires explicit approval in defaultApproval mode; use bypassApproval/autopilot or configure allowed commands",
		)
	}

	return nil
}

func normalizeApprovalMode(mode string) ApprovalMode {
	normalized := strings.ToLower(strings.TrimSpace(mode))
	switch normalized {
	case "bypassapproval", "bypass_approval", "bypass approval", "bypass":
		return ApprovalModeBypass
	case "autopilot", "auto", "auto_pilot":
		return ApprovalModeAuto
	case "defaultapproval", "default_approval", "default approval", "default", "":
		return ApprovalModeDefault
	default:
		return ApprovalModeDefault
	}
}

func blockedCommandReason(command string) string {
	trimmed := strings.ToLower(strings.TrimSpace(command))
	dangerous := []string{
		"rm -rf /",
		"mkfs",
		":(){",
		"shutdown",
		"reboot",
		"poweroff",
		"dd if=/dev/zero",
	}

	for _, pattern := range dangerous {
		if strings.Contains(trimmed, pattern) {
			return pattern
		}
	}

	return ""
}

func isDefaultApprovalCommandAllowed(command string) bool {
	for _, safePattern := range defaultApprovalSafePatterns {
		if matchesCommandPattern(command, safePattern) {
			return true
		}
	}

	return false
}

func firstMatchingPattern(command string, patterns []string) (string, bool) {
	for _, pattern := range patterns {
		if matchesCommandPattern(command, pattern) {
			return pattern, true
		}
	}

	return "", false
}

func matchesCommandPattern(command string, pattern string) bool {
	normalizedCommand := strings.ToLower(strings.TrimSpace(command))
	normalizedPattern := strings.ToLower(strings.TrimSpace(pattern))
	if normalizedPattern == "" {
		return false
	}

	if strings.HasPrefix(normalizedPattern, "/") && strings.HasSuffix(normalizedPattern, "/") && len(normalizedPattern) > 2 {
		re, err := regexp.Compile(normalizedPattern[1 : len(normalizedPattern)-1])
		if err != nil {
			return false
		}

		return re.MatchString(normalizedCommand)
	}

	if strings.ContainsAny(normalizedPattern, "*?") {
		quoted := regexp.QuoteMeta(normalizedPattern)
		quoted = strings.ReplaceAll(quoted, "\\*", ".*")
		quoted = strings.ReplaceAll(quoted, "\\?", ".")
		re, err := regexp.Compile("^" + quoted + "$")
		if err != nil {
			return false
		}

		return re.MatchString(normalizedCommand)
	}

	return normalizedCommand == normalizedPattern || strings.Contains(normalizedCommand, normalizedPattern)
}

func normalizePatternList(values []string) []string {
	if len(values) == 0 {
		return nil
	}

	seen := make(map[string]struct{}, len(values))
	normalized := make([]string, 0, len(values))

	for _, value := range values {
		trimmed := strings.TrimSpace(value)
		if trimmed == "" {
			continue
		}

		if _, exists := seen[trimmed]; exists {
			continue
		}

		seen[trimmed] = struct{}{}
		normalized = append(normalized, trimmed)
	}

	return normalized
}

func splitListEnv(key string) []string {
	raw := strings.TrimSpace(envOrDefault(key, ""))
	if raw == "" {
		return nil
	}

	parts := strings.Split(raw, ",")
	return normalizePatternList(parts)
}

func mapInput(input map[string]any, key string) map[string]any {
	if input == nil {
		return nil
	}

	rawValue, ok := input[key]
	if !ok || rawValue == nil {
		return nil
	}

	if typedMap, ok := rawValue.(map[string]any); ok {
		return typedMap
	}

	return nil
}

func stringValue(input map[string]any, key string) (string, bool) {
	if input == nil {
		return "", false
	}

	value, ok := input[key]
	if !ok || value == nil {
		return "", false
	}

	switch typed := value.(type) {
	case string:
		return strings.TrimSpace(typed), true
	default:
		return strings.TrimSpace(fmt.Sprintf("%v", typed)), true
	}
}

func stringSliceValue(input map[string]any, key string) ([]string, bool) {
	if input == nil {
		return nil, false
	}

	value, ok := input[key]
	if !ok {
		return nil, false
	}

	if value == nil {
		return []string{}, true
	}

	switch typed := value.(type) {
	case []string:
		return normalizePatternList(typed), true
	case []any:
		values := make([]string, 0, len(typed))
		for _, entry := range typed {
			values = append(values, strings.TrimSpace(fmt.Sprintf("%v", entry)))
		}
		return normalizePatternList(values), true
	case string:
		trimmed := strings.TrimSpace(typed)
		if trimmed == "" {
			return []string{}, true
		}
		if strings.Contains(trimmed, ",") {
			return normalizePatternList(strings.Split(trimmed, ",")), true
		}
		return []string{trimmed}, true
	default:
		return nil, false
	}
}