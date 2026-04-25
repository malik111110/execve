package agent

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"strings"
	"time"

	agentapi "github.com/digitalcenter/vscode-ex-llm/runtime/internal/api"
	"github.com/digitalcenter/vscode-ex-llm/runtime/internal/storage"
)

type conversationStore interface {
	EnsureSession(context.Context, storage.SessionUpsertInput) (storage.SessionState, error)
	RecordRequest(context.Context, storage.RequestRecord) error
	RecordResponse(context.Context, storage.ResponseRecord) error
	LoadRecentMessages(ctx context.Context, sessionID string, limit int) ([]agentapi.SessionMessage, error)
}

func (s *Service) ensureRequestSession(
	ctx context.Context,
	req agentapi.AgentRequest,
	mode string,
) (string, []agentapi.Observation) {
	memoryKey := s.commandMemoryKey(req.Context)
	sessionID := strings.TrimSpace(req.SessionID)

	if req.StartNewSession {
		sessionID = ""
	}

	created := false
	if sessionID == "" {
		sessionID = s.activeSessionID(memoryKey)
	}

	if sessionID == "" {
		sessionID = generateSessionIDFallback()
		created = true
	}

	if s.store != nil {
		state, err := s.store.EnsureSession(ctx, storage.SessionUpsertInput{
			SessionID:     sessionID,
			WorkspaceRoot: resolveWorkspaceRoot(req.Context),
			Mode:          mode,
			Prompt:        req.Prompt,
			StartNew:      req.StartNewSession,
		})
		if err != nil {
			s.setActiveSessionID(memoryKey, sessionID)
			return sessionID, []agentapi.Observation{{
				Source:  "storage.session",
				Message: fmt.Sprintf("failed to persist session metadata: %v", err),
			}}
		}

		if strings.TrimSpace(state.ID) != "" {
			sessionID = strings.TrimSpace(state.ID)
		}

		created = created || state.Created
	}

	s.setActiveSessionID(memoryKey, sessionID)

	return sessionID, []agentapi.Observation{{
		Source:  "storage.session",
		Message: fmt.Sprintf("session=%s created=%t", sessionID, created),
	}}
}

func (s *Service) persistRequestRecord(
	ctx context.Context,
	requestID string,
	req agentapi.AgentRequest,
) *agentapi.Observation {
	if s.store == nil || strings.TrimSpace(req.SessionID) == "" {
		return nil
	}

	if err := s.store.RecordRequest(ctx, storage.RequestRecord{
		SessionID: req.SessionID,
		RequestID: requestID,
		Prompt:    req.Prompt,
		Context:   req.Context,
		Settings:  req.Settings,
	}); err != nil {
		return &agentapi.Observation{
			Source:  "storage.sqlite",
			Message: fmt.Sprintf("failed to persist request: %v", err),
		}
	}

	return nil
}

func (s *Service) persistResponseRecord(
	ctx context.Context,
	requestID string,
	response agentapi.AgentResponse,
) *agentapi.Observation {
	if s.store == nil || strings.TrimSpace(response.SessionID) == "" {
		return nil
	}

	if err := s.store.RecordResponse(ctx, storage.ResponseRecord{
		SessionID: response.SessionID,
		RequestID: requestID,
		Provider:  s.provider.Name(),
		Response:  response,
	}); err != nil {
		return &agentapi.Observation{
			Source:  "storage.sqlite",
			Message: fmt.Sprintf("failed to persist response: %v", err),
		}
	}

	return nil
}

func (s *Service) activeSessionID(memoryKey string) string {
	s.sessionMu.Lock()
	defer s.sessionMu.Unlock()

	return strings.TrimSpace(s.activeSession[memoryKey])
}

func (s *Service) setActiveSessionID(memoryKey string, sessionID string) {
	memoryKey = strings.TrimSpace(memoryKey)
	sessionID = strings.TrimSpace(sessionID)
	if memoryKey == "" || sessionID == "" {
		return
	}

	s.sessionMu.Lock()
	defer s.sessionMu.Unlock()
	s.activeSession[memoryKey] = sessionID
}

func generateSessionIDFallback() string {
	buffer := make([]byte, 6)
	if _, err := rand.Read(buffer); err != nil {
		return fmt.Sprintf("sess-%d", time.Now().UnixNano())
	}

	return fmt.Sprintf("sess-%d-%s", time.Now().UnixNano(), hex.EncodeToString(buffer))
}
