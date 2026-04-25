package lmstudio

import (
	"bufio"
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
		baseURL = "http://127.0.0.1:1234"
	}

	if strings.TrimSpace(model) == "" {
		model = "local-model"
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
	return fmt.Sprintf("lmstudio/%s", p.model)
}

func (p *Provider) Generate(ctx context.Context, prompt string) (string, error) {
	body, err := p.newChatBody(prompt, false)
	if err != nil {
		return "", err
	}

	req, err := http.NewRequestWithContext(ctx, http.MethodPost, p.baseURL+"/v1/chat/completions", strings.NewReader(body))
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
		return "", fmt.Errorf("lm studio request failed (%d): %s", resp.StatusCode, strings.TrimSpace(string(message)))
	}

	var payload chatResponse
	if err := json.NewDecoder(resp.Body).Decode(&payload); err != nil {
		return "", fmt.Errorf("decode lm studio response: %w", err)
	}

	if len(payload.Choices) == 0 {
		return "", fmt.Errorf("lm studio response contained no choices")
	}

	return payload.Choices[0].Message.Content, nil
}

func (p *Provider) GenerateStream(ctx context.Context, prompt string, onToken func(string) error) error {
	body, err := p.newChatBody(prompt, true)
	if err != nil {
		return err
	}

	req, err := http.NewRequestWithContext(ctx, http.MethodPost, p.baseURL+"/v1/chat/completions", strings.NewReader(body))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "text/event-stream")

	resp, err := p.client.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		message, _ := io.ReadAll(io.LimitReader(resp.Body, 8*1024))
		return fmt.Errorf("lm studio request failed (%d): %s", resp.StatusCode, strings.TrimSpace(string(message)))
	}

	scanner := bufio.NewScanner(resp.Body)
	scanner.Buffer(make([]byte, 0, 64*1024), 1024*1024)

	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if line == "" || strings.HasPrefix(line, ":") {
			continue
		}

		if !strings.HasPrefix(line, "data:") {
			continue
		}

		data := strings.TrimSpace(strings.TrimPrefix(line, "data:"))
		if data == "[DONE]" {
			return nil
		}

		var chunk streamResponse
		if err := json.Unmarshal([]byte(data), &chunk); err != nil {
			return fmt.Errorf("decode lm studio stream chunk: %w", err)
		}

		if len(chunk.Choices) == 0 {
			continue
		}

		token := chunk.Choices[0].Delta.Content
		if token == "" || onToken == nil {
			continue
		}

		if err := onToken(token); err != nil {
			return err
		}
	}

	if err := scanner.Err(); err != nil {
		return fmt.Errorf("read lm studio stream: %w", err)
	}

	return nil
}

func (p *Provider) newChatBody(prompt string, stream bool) (string, error) {
	type message struct {
		Role    string `json:"role"`
		Content string `json:"content"`
	}

	type request struct {
		Model       string    `json:"model"`
		Messages    []message `json:"messages"`
		Stream      bool      `json:"stream"`
		Temperature float64   `json:"temperature"`
	}

	encoded, err := json.Marshal(request{
		Model: p.model,
		Messages: []message{
			{Role: "user", Content: prompt},
		},
		Stream:      stream,
		Temperature: 0.2,
	})
	if err != nil {
		return "", err
	}

	return string(encoded), nil
}

type chatResponse struct {
	Choices []struct {
		Message struct {
			Content string `json:"content"`
		} `json:"message"`
	} `json:"choices"`
}

type streamResponse struct {
	Choices []struct {
		Delta struct {
			Content string `json:"content"`
		} `json:"delta"`
	} `json:"choices"`
}
