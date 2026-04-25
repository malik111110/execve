package main

import (
	"encoding/json"
	"errors"
	"log"
	"net/http"
	"os"
	"strings"
	"time"

	"github.com/digitalcenter/vscode-ex-llm/runtime/internal/agent"
	agentapi "github.com/digitalcenter/vscode-ex-llm/runtime/internal/api"
	"github.com/digitalcenter/vscode-ex-llm/runtime/internal/providers"
	"github.com/digitalcenter/vscode-ex-llm/runtime/internal/tools"
)

func main() {
	addr := envOrDefault("AGENT_HTTP_ADDR", ":8080")

	registry := tools.NewRegistry()
	registry.Register(tools.NewReadFileTool())
	registry.Register(tools.NewSearchCodeTool())
	registry.Register(tools.NewGitDiffTool())
	registry.Register(tools.NewCreateFileTool())
	registry.Register(tools.NewExecuteCommandTool())

	provider, err := providers.NewProviderFromEnv()
	if err != nil {
		log.Fatalf("failed to initialize provider: %v", err)
	}

	service := agent.NewService(provider, registry)

	mux := http.NewServeMux()
	mux.HandleFunc("/healthz", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet {
			writeMethodNotAllowed(w, http.MethodGet)
			return
		}

		writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
	})

	mux.HandleFunc("/v1/agent/run", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			writeMethodNotAllowed(w, http.MethodPost)
			return
		}

		defer r.Body.Close()

		var req agentapi.AgentRequest
		decoder := json.NewDecoder(r.Body)
		decoder.DisallowUnknownFields()
		if err := decoder.Decode(&req); err != nil {
			writeError(w, http.StatusBadRequest, "invalid request payload")
			return
		}

		resp, err := service.Run(r.Context(), req)
		if err != nil {
			status := http.StatusInternalServerError
			if errors.Is(err, agent.ErrInvalidRequest) {
				status = http.StatusBadRequest
			}

			writeError(w, status, err.Error())
			return
		}

		writeJSON(w, http.StatusOK, resp)
	})

	mux.HandleFunc("/v1/agent/stream", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			writeMethodNotAllowed(w, http.MethodPost)
			return
		}

		defer r.Body.Close()

		var req agentapi.AgentRequest
		decoder := json.NewDecoder(r.Body)
		decoder.DisallowUnknownFields()
		if err := decoder.Decode(&req); err != nil {
			writeError(w, http.StatusBadRequest, "invalid request payload")
			return
		}

		flusher, ok := w.(http.Flusher)
		if !ok {
			writeError(w, http.StatusInternalServerError, "streaming is not supported")
			return
		}

		w.Header().Set("Content-Type", "text/event-stream")
		w.Header().Set("Cache-Control", "no-cache")
		w.Header().Set("Connection", "keep-alive")
		w.Header().Set("X-Accel-Buffering", "no")
		w.WriteHeader(http.StatusOK)
		flusher.Flush()

		_, streamErr := service.RunStream(r.Context(), req, func(event string, payload any) error {
			return writeSSE(w, flusher, event, payload)
		})
		if streamErr != nil {
			_ = writeSSE(w, flusher, "error", map[string]string{"message": streamErr.Error()})
		}
	})

	server := &http.Server{
		Addr:              addr,
		Handler:           requestLogger(mux),
		ReadHeaderTimeout: 5 * time.Second,
	}

	log.Printf("agent runtime listening on %s (provider=%s)", addr, provider.Name())
	if err := server.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
		log.Fatalf("runtime server failed: %v", err)
	}
}

func envOrDefault(key, fallback string) string {
	value := os.Getenv(key)
	if value == "" {
		return fallback
	}

	return value
}

func requestLogger(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		started := time.Now()
		next.ServeHTTP(w, r)
		log.Printf("%s %s (%s)", r.Method, r.URL.Path, time.Since(started))
	})
}

func writeMethodNotAllowed(w http.ResponseWriter, allowMethod string) {
	w.Header().Set("Allow", allowMethod)
	writeError(w, http.StatusMethodNotAllowed, "method not allowed")
}

func writeError(w http.ResponseWriter, status int, message string) {
	writeJSON(w, status, map[string]string{"error": message})
}

func writeJSON(w http.ResponseWriter, status int, payload any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)

	if err := json.NewEncoder(w).Encode(payload); err != nil {
		log.Printf("failed to write response: %v", err)
	}
}

func writeSSE(w http.ResponseWriter, flusher http.Flusher, event string, payload any) error {
	encoded, err := json.Marshal(payload)
	if err != nil {
		return err
	}

	if _, err := w.Write([]byte("event: " + strings.TrimSpace(event) + "\n")); err != nil {
		return err
	}

	if _, err := w.Write([]byte("data: " + string(encoded) + "\n\n")); err != nil {
		return err
	}

	flusher.Flush()
	return nil
}
