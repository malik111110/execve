package agent

import (
	"fmt"
	"strings"
)

func summarizeCommandResult(result map[string]any) string {
	command := mapString(result, "command")
	exitCode := mapInt(result, "exit_code")
	dryRun := mapBool(result, "dry_run")
	timedOut := mapBool(result, "timed_out")
	running := mapBool(result, "running")
	continued := mapBool(result, "continued")
	stopped := mapBool(result, "stopped")
	terminalID := mapString(result, "terminal_id")

	if dryRun {
		if stopped {
			return "Dry run: would stop the running command"
		}

		if continued {
			return "Dry run: would continue command output"
		}

		return fmt.Sprintf("Dry run: would execute command: %s", command)
	}

	if stopped {
		if running {
			if terminalID != "" {
				return fmt.Sprintf("Stop signal sent to terminal %s for command: %s", terminalID, command)
			}

			return fmt.Sprintf("Stop signal sent for command: %s", command)
		}

		if strings.TrimSpace(command) == "" {
			return "Stopped running command"
		}

		return fmt.Sprintf("Stopped command: %s", command)
	}

	if running {
		if terminalID != "" {
			return fmt.Sprintf("Command is still running in terminal %s: %s", terminalID, command)
		}

		return fmt.Sprintf("Command is still running: %s", command)
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

func previewLineEvents(result map[string]any) string {
	if result == nil {
		return ""
	}

	rawEvents, ok := result["line_events"]
	if !ok || rawEvents == nil {
		return ""
	}

	array, ok := rawEvents.([]any)
	if !ok || len(array) == 0 {
		if typed, okTyped := rawEvents.([]map[string]any); okTyped {
			if len(typed) == 0 {
				return ""
			}

			array = make([]any, 0, len(typed))
			for _, entry := range typed {
				array = append(array, entry)
			}
		} else {
			return ""
		}
	}

	previews := make([]string, 0, 4)
	for _, entry := range array {
		item, ok := entry.(map[string]any)
		if !ok {
			continue
		}

		stream := mapString(item, "stream")
		text := strings.TrimSpace(mapString(item, "text"))
		if text == "" {
			continue
		}

		if stream == "" {
			stream = "output"
		}

		previews = append(previews, fmt.Sprintf("[%s] %s", stream, text))
		if len(previews) >= 4 {
			break
		}
	}

	if len(previews) == 0 {
		return ""
	}

	joined := strings.Join(previews, "\n")
	if len(joined) > 420 {
		return joined[:420] + "..."
	}

	return joined
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

func mapStringSlice(data map[string]any, key string) []string {
	if data == nil {
		return nil
	}

	raw, ok := data[key]
	if !ok || raw == nil {
		return nil
	}

	switch typed := raw.(type) {
	case []string:
		result := make([]string, 0, len(typed))
		for _, entry := range typed {
			trimmed := strings.TrimSpace(entry)
			if trimmed != "" {
				result = append(result, trimmed)
			}
		}
		return result
	case []any:
		result := make([]string, 0, len(typed))
		for _, entry := range typed {
			trimmed := strings.TrimSpace(fmt.Sprintf("%v", entry))
			if trimmed != "" {
				result = append(result, trimmed)
			}
		}
		return result
	default:
		return nil
	}
}
