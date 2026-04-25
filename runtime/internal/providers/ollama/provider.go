package ollama

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"
)

type Provider struct {
	baseURL string
	model   string
	client  *http.Client
}

func NewProvider(baseURL string, model string, client *http.Client) *Provider {
	if strings.TrimSpace(baseURL) == "" {
		baseURL = "http://127.0.0.1:11434"
	}

	if strings.TrimSpace(model) == "" {
		model = "llama3.2:3b"
	}

	if client == nil {
		client = &http.Client{Timeout: 2 * time.Minute}
	}

	return &Provider{
		baseURL: strings.TrimRight(baseURL, "/"),
		model:   strings.TrimSpace(model),
		client:  client,
	}
}

func (p *Provider) Name() string {
	return fmt.Sprintf("ollama/%s", p.model)
}

func (p *Provider) Generate(ctx context.Context, prompt string) (string, error) {
	body, err := p.newGenerateBody(prompt, false)
	if err != nil {
		return "", err
	}

	req, err := http.NewRequestWithContext(ctx, http.MethodPost, p.baseURL+"/api/generate", strings.NewReader(body))
	if err != nil {
		return "", err
	}

	req.Header.Set("Content-Type", "application/json")

	resp, err := p.client.Do(req)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		message, _ := io.ReadAll(io.LimitReader(resp.Body, 8*1024))
		return "", fmt.Errorf("ollama request failed (%d): %s", resp.StatusCode, strings.TrimSpace(string(message)))
	}

	var payload generateResponse
	if err := json.NewDecoder(resp.Body).Decode(&payload); err != nil {
		return "", fmt.Errorf("decode ollama response: %w", err)
	}

	if strings.TrimSpace(payload.Error) != "" {
		return "", fmt.Errorf("ollama error: %s", strings.TrimSpace(payload.Error))
	}

	return payload.Response, nil
}

func (p *Provider) GenerateStream(ctx context.Context, prompt string, onToken func(string) error) error {
	body, err := p.newGenerateBody(prompt, true)
	if err != nil {
		return err
	}

	req, err := http.NewRequestWithContext(ctx, http.MethodPost, p.baseURL+"/api/generate", strings.NewReader(body))
	if err != nil {
		return err
	}

	req.Header.Set("Content-Type", "application/json")

	resp, err := p.client.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		message, _ := io.ReadAll(io.LimitReader(resp.Body, 8*1024))
		return fmt.Errorf("ollama request failed (%d): %s", resp.StatusCode, strings.TrimSpace(string(message)))
	}

	decoder := json.NewDecoder(resp.Body)
	for {
		var chunk generateResponse
		if err := decoder.Decode(&chunk); err != nil {
			if err == io.EOF {
				return nil
			}

			return fmt.Errorf("decode ollama stream: %w", err)
		}

		if strings.TrimSpace(chunk.Error) != "" {
			return fmt.Errorf("ollama error: %s", strings.TrimSpace(chunk.Error))
		}

		if chunk.Response != "" && onToken != nil {
			if err := onToken(chunk.Response); err != nil {
				return err
			}
		}

		if chunk.Done {
			return nil
		}
	}
}

func (p *Provider) newGenerateBody(prompt string, stream bool) (string, error) {
	type request struct {
		Model  string `json:"model"`
		Prompt string `json:"prompt"`
		Stream bool   `json:"stream"`
	}

	encoded, err := json.Marshal(request{
		Model:  p.model,
		Prompt: prompt,
		Stream: stream,
	})
	if err != nil {
		return "", err
	}

	return string(encoded), nil
}

type generateResponse struct {
	Response string `json:"response"`
	Done     bool   `json:"done"`
	Error    string `json:"error"`
}
