package mock

import (
	"context"
	"fmt"
	"strings"
)

type Provider struct{}

func NewProvider() *Provider {
	return &Provider{}
}

func (p *Provider) Name() string {
	return "mock"
}

func (p *Provider) Generate(ctx context.Context, prompt string) (string, error) {
	select {
	case <-ctx.Done():
		return "", ctx.Err()
	default:
	}

	cleaned := strings.TrimSpace(prompt)
	if len(cleaned) > 120 {
		cleaned = cleaned[:117] + "..."
	}

	return fmt.Sprintf("Generated deterministic draft plan for: %s", cleaned), nil
}

func (p *Provider) GenerateStream(ctx context.Context, prompt string, onToken func(string) error) error {
	message, err := p.Generate(ctx, prompt)
	if err != nil {
		return err
	}

	if onToken == nil {
		return nil
	}

	for _, token := range strings.Split(message, " ") {
		select {
		case <-ctx.Done():
			return ctx.Err()
		default:
		}

		if token == "" {
			continue
		}

		if err := onToken(token + " "); err != nil {
			return err
		}
	}

	return nil
}
