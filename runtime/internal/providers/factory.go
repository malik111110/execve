package providers

import (
	"fmt"
	"os"
	"strings"

	"github.com/digitalcenter/vscode-ex-llm/runtime/internal/providers/lmstudio"
	"github.com/digitalcenter/vscode-ex-llm/runtime/internal/providers/mock"
	"github.com/digitalcenter/vscode-ex-llm/runtime/internal/providers/ollama"
)

func NewProviderFromEnv() (Provider, error) {
	providerKind := strings.ToLower(strings.TrimSpace(os.Getenv("AGENT_PROVIDER")))
	if providerKind == "" {
		providerKind = "mock"
	}

	globalModel := strings.TrimSpace(os.Getenv("AGENT_MODEL"))

	switch providerKind {
	case "mock":
		return mock.NewProvider(), nil
	case "ollama":
		baseURL := strings.TrimSpace(os.Getenv("OLLAMA_BASE_URL"))
		model := firstNonEmpty(strings.TrimSpace(os.Getenv("OLLAMA_MODEL")), globalModel, "llama3.2:3b")
		return ollama.NewProvider(baseURL, model, nil), nil
	case "lmstudio", "lm-studio", "lm_studio":
		baseURL := strings.TrimSpace(os.Getenv("LMSTUDIO_BASE_URL"))
		model := firstNonEmpty(strings.TrimSpace(os.Getenv("LMSTUDIO_MODEL")), globalModel, "local-model")
		return lmstudio.NewProvider(baseURL, model, nil), nil
	default:
		return nil, fmt.Errorf("unsupported AGENT_PROVIDER: %s", providerKind)
	}
}

func firstNonEmpty(values ...string) string {
	for _, value := range values {
		if strings.TrimSpace(value) != "" {
			return strings.TrimSpace(value)
		}
	}

	return ""
}
