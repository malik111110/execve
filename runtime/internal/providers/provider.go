package providers

import "context"

type Provider interface {
	Name() string
	Generate(ctx context.Context, prompt string) (string, error)
	GenerateStream(ctx context.Context, prompt string, onToken func(string) error) error
}

// EmbeddingProvider is an optional extension that providers implement when
// their backend supports a native embedding endpoint.  The returned slice
// is a normalised float32 vector; its dimensionality depends on the model.
type EmbeddingProvider interface {
	Embed(ctx context.Context, text string) ([]float32, error)
}
