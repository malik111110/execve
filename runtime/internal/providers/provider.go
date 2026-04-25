package providers

import "context"

type Provider interface {
	Name() string
	Generate(ctx context.Context, prompt string) (string, error)
	GenerateStream(ctx context.Context, prompt string, onToken func(string) error) error
}
