package agent

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"sync"
	"time"

	agentapi "github.com/digitalcenter/vscode-ex-llm/runtime/internal/api"
	"github.com/digitalcenter/vscode-ex-llm/runtime/internal/providers"
	"github.com/digitalcenter/vscode-ex-llm/runtime/internal/redismem"
	"github.com/digitalcenter/vscode-ex-llm/runtime/internal/tools"
)

var ErrInvalidRequest = errors.New("invalid request")

type StreamEmitter func(event string, payload any) error

type Service struct {
	provider      providers.Provider
	registry      *tools.Registry
	store         conversationStore
	memoryMu      sync.Mutex
	commandMemory map[string][]commandMemoryEntry
	terminalMu    sync.Mutex
	terminalState map[string]terminalContinuationState
	sessionMu     sync.Mutex
	activeSession map[string]string
	// Redis-backed context layers (optional — both may be nil).
	embedder    providers.EmbeddingProvider
	semCache    *redismem.SemanticCache
	ltmStore    *redismem.MemoryStore
}

func NewService(provider providers.Provider, registry *tools.Registry) *Service {
	return NewServiceWithStore(provider, registry, nil)
}

func NewServiceWithStore(
	provider providers.Provider,
	registry *tools.Registry,
	store conversationStore,
) *Service {
	return NewServiceWithRedis(provider, registry, store, nil, nil, nil)
}

// NewServiceWithRedis creates a Service with optional Redis-backed semantic
// caching (semCache) and long-term memory (ltmStore).  Either argument may be
// nil; the embedder is required when any Redis layer is non-nil.
func NewServiceWithRedis(
	provider providers.Provider,
	registry *tools.Registry,
	store conversationStore,
	embedder providers.EmbeddingProvider,
	semCache *redismem.SemanticCache,
	ltmStore *redismem.MemoryStore,
) *Service {
	if provider == nil {
		panic("provider is required")
	}

	if registry == nil {
		registry = tools.NewRegistry()
	}

	return &Service{
		provider:      provider,
		registry:      registry,
		store:         store,
		commandMemory: make(map[string][]commandMemoryEntry),
		terminalState: make(map[string]terminalContinuationState),
		activeSession: make(map[string]string),
		embedder:      embedder,
		semCache:      semCache,
		ltmStore:      ltmStore,
	}
}

func (s *Service) Run(ctx context.Context, req agentapi.AgentRequest) (agentapi.AgentResponse, error) {
	requestID := fmt.Sprintf("req-%d", time.Now().UnixNano())
	return s.runInternal(ctx, requestID, req, nil)
}

func (s *Service) RunStream(ctx context.Context, req agentapi.AgentRequest, emit StreamEmitter) (agentapi.AgentResponse, error) {
	if emit == nil {
		return agentapi.AgentResponse{}, fmt.Errorf("%w: stream emitter is required", ErrInvalidRequest)
	}

	requestID := fmt.Sprintf("req-%d", time.Now().UnixNano())
	if err := emit("status", map[string]string{"requestId": requestID, "status": "started"}); err != nil {
		return agentapi.AgentResponse{}, err
	}

	return s.runInternal(ctx, requestID, req, emit)
}

func (s *Service) runInternal(
	ctx context.Context,
	requestID string,
	req agentapi.AgentRequest,
	emit StreamEmitter,
) (agentapi.AgentResponse, error) {
	started := time.Now()

	if strings.TrimSpace(req.Prompt) == "" {
		err := fmt.Errorf("%w: prompt is required", ErrInvalidRequest)
		s.emitError(emit, requestID, err)
		return agentapi.AgentResponse{}, err
	}

	maxSteps := normalizeMaxSteps(req.Settings.MaxSteps)
	mode := normalizeExecutionMode(req.Settings.Mode)
	plan := buildPlanForMode(mode, maxSteps, req.Prompt)
	sessionID, sessionObservations := s.ensureRequestSession(ctx, req, mode)
	if strings.TrimSpace(sessionID) != "" {
		req.SessionID = sessionID
	}
	// Load compact conversation history BEFORE persisting the current request so the
	// current turn is not duplicated (it is already injected via req.Prompt below).
	conversationHistory := s.loadCompactHistory(ctx, req.SessionID)
	if persistObservation := s.persistRequestRecord(ctx, requestID, req); persistObservation != nil {
		sessionObservations = append(sessionObservations, *persistObservation)
	}

	if emit != nil {
		if err := emit("status", map[string]string{"requestId": requestID, "status": "planning"}); err != nil {
			return agentapi.AgentResponse{}, err
		}

		for _, step := range plan {
			if err := emit("plan", step); err != nil {
				return agentapi.AgentResponse{}, err
			}
		}
	}

	if emit != nil {
		if err := emit("status", map[string]string{"requestId": requestID, "status": "tooling"}); err != nil {
			return agentapi.AgentResponse{}, err
		}
	}

	memoryKey := s.commandMemoryKey(req.Context)
	planModeObservations := make([]agentapi.Observation, 0, 2)

	if mode == "plan" {
		followUpQuestions, followUpObservations := s.askPlanFollowUpQuestions(ctx, req)
		planModeObservations = append(planModeObservations, followUpObservations...)

		if len(followUpQuestions) > 0 {
			observations := []agentapi.Observation{{
				Source:  "runtime",
				Message: "mode=plan (awaiting follow-up answers)",
			}}
			observations = append(observations, sessionObservations...)
			observations = append(observations, planModeObservations...)

			if emit != nil {
				for _, observation := range observations {
					if err := emit("observation", observation); err != nil {
						return agentapi.AgentResponse{}, err
					}
				}
			}

			finalMessage := followUpFinalMessage(followUpQuestions)
			if emit != nil {
				if err := emit("status", map[string]string{"requestId": requestID, "status": "needs_follow_up"}); err != nil {
					return agentapi.AgentResponse{}, err
				}

				if err := emit("token", map[string]string{"requestId": requestID, "text": finalMessage}); err != nil {
					return agentapi.AgentResponse{}, err
				}
			}

			response := agentapi.AgentResponse{
				RequestID:    requestID,
				Status:       "needs_follow_up",
				Plan:         plan,
				Observations: observations,
				FinalMessage: finalMessage,
				DurationMs:   time.Since(started).Milliseconds(),
				SessionID:    sessionID,
			}

			if persistObservation := s.persistResponseRecord(ctx, requestID, response); persistObservation != nil {
				response.Observations = append(response.Observations, *persistObservation)
				if emit != nil {
					if err := emit("observation", *persistObservation); err != nil {
						return agentapi.AgentResponse{}, err
					}
				}
			}

			if emit != nil {
				if err := emit("done", response); err != nil {
					return agentapi.AgentResponse{}, err
				}
			}

			return response, nil
		}
	}

	if mode == "agent" {
		deterministicMessage, deterministicObservations, deterministicHandled, deterministicErr := s.tryDeterministicAction(ctx, req)
		if deterministicHandled {
			observations := []agentapi.Observation{{
				Source:  "runtime",
				Message: "deterministic action executed",
			}}

			toolNames := s.registry.Names()
			if len(toolNames) == 0 {
				observations = append(observations, agentapi.Observation{
					Source:  "tools",
					Message: "no tools registered yet",
				})
			} else {
				observations = append(observations, agentapi.Observation{
					Source:  "tools",
					Message: fmt.Sprintf("registered=%s", strings.Join(toolNames, ",")),
				})
			}

			observations = append(observations, deterministicObservations...)
			observations = append(observations, sessionObservations...)

			if emit != nil {
				for _, observation := range observations {
					if err := emit("observation", observation); err != nil {
						return agentapi.AgentResponse{}, err
					}
				}
			}

			if deterministicErr != nil {
				s.emitError(emit, requestID, deterministicErr)
				return agentapi.AgentResponse{}, deterministicErr
			}

			if emit != nil {
				if err := emit("status", map[string]string{"requestId": requestID, "status": "acting"}); err != nil {
					return agentapi.AgentResponse{}, err
				}

				if deterministicMessage != "" {
					if err := emit("token", map[string]string{"requestId": requestID, "text": deterministicMessage}); err != nil {
						return agentapi.AgentResponse{}, err
					}
				}
			}

			response := agentapi.AgentResponse{
				RequestID:    requestID,
				Status:       "completed",
				Plan:         plan,
				Observations: observations,
				FinalMessage: deterministicMessage,
				DurationMs:   time.Since(started).Milliseconds(),
				SessionID:    sessionID,
			}

			if persistObservation := s.persistResponseRecord(ctx, requestID, response); persistObservation != nil {
				response.Observations = append(response.Observations, *persistObservation)
				if emit != nil {
					if err := emit("observation", *persistObservation); err != nil {
						return agentapi.AgentResponse{}, err
					}
				}
			}

			if emit != nil {
				if err := emit("status", map[string]string{"requestId": requestID, "status": "completed"}); err != nil {
					return agentapi.AgentResponse{}, err
				}

				if err := emit("done", response); err != nil {
					return agentapi.AgentResponse{}, err
				}
			}

			return response, nil
		}
	}

	toolObservations, toolContextBlocks := s.runCandidateTools(ctx, req)
	if len(planModeObservations) > 0 {
		toolObservations = append(planModeObservations, toolObservations...)
	}

	if commandMemoryBlock, commandMemoryCount := s.buildCommandMemoryContext(memoryKey); commandMemoryBlock != "" {
		toolContextBlocks = append(toolContextBlocks, commandMemoryBlock)
		toolObservations = append(toolObservations, agentapi.Observation{
			Source:  "memory.command_results",
			Message: fmt.Sprintf("loaded %d recent command result(s)", commandMemoryCount),
		})
	}

	if mode == "chat" {
		toolObservations = append([]agentapi.Observation{{
			Source:  "runtime",
			Message: "mode=chat (deterministic actions disabled)",
		}}, toolObservations...)
	} else if mode == "plan" {
		toolObservations = append([]agentapi.Observation{{
			Source:  "runtime",
			Message: "mode=plan (building actionable todo plan)",
		}}, toolObservations...)
	}

	observations := []agentapi.Observation{
		{Source: "runtime", Message: "deterministic loop completed"},
		{Source: "provider", Message: fmt.Sprintf("provider=%s", s.provider.Name())},
	}

	toolNames := s.registry.Names()
	if len(toolNames) == 0 {
		observations = append(observations, agentapi.Observation{
			Source:  "tools",
			Message: "no tools registered yet",
		})
	} else {
		observations = append(observations, agentapi.Observation{
			Source:  "tools",
			Message: fmt.Sprintf("registered=%s", strings.Join(toolNames, ",")),
		})
	}

	observations = append(observations, sessionObservations...)
	observations = append(observations, toolObservations...)

	if emit != nil {
		for _, observation := range observations {
			if err := emit("observation", observation); err != nil {
				return agentapi.AgentResponse{}, err
			}
		}
	}

	if mode == "plan" {
		plan = setPlanStatus(plan, "in_progress")
		if emit != nil {
			for _, step := range plan {
				if err := emit("plan", step); err != nil {
					return agentapi.AgentResponse{}, err
				}
			}
		}
	}

	providerPrompt := buildProviderPrompt(req, toolContextBlocks, conversationHistory)

	// --- Redis context layers -------------------------------------------------
	// Embed the current prompt once and use it for both semantic cache lookup
	// and long-term memory retrieval.  All Redis operations are best-effort:
	// errors are logged as observations but never fail the request.
	var promptEmbedding []float32
	if s.embedder != nil {
		if emb, embErr := s.embedder.Embed(ctx, req.Prompt); embErr == nil {
			promptEmbedding = emb
			// Ensure indexes exist (idempotent, uses embedding dim).
			if s.semCache != nil {
				_ = s.semCache.EnsureIndex(ctx, len(emb))
			}
			if s.ltmStore != nil {
				_ = s.ltmStore.EnsureIndex(ctx, len(emb))
			}
		} else {
			observations = append(observations, agentapi.Observation{
				Source:  "redis.embed",
				Message: fmt.Sprintf("embedding failed (redis layers skipped): %v", embErr),
			})
		}
	}

	// 1. Semantic cache lookup: skip LLM if a near-identical prompt was answered.
	if s.semCache != nil && len(promptEmbedding) > 0 {
		if cached, hit := s.semCache.Get(ctx, promptEmbedding); hit {
			observations = append(observations, agentapi.Observation{
				Source:  "redis.semantic_cache",
				Message: "cache hit — returning cached response",
			})
			if emit != nil {
				_ = emit("observation", agentapi.Observation{Source: "redis.semantic_cache", Message: "cache hit"})
				_ = emit("token", map[string]string{"requestId": requestID, "text": cached})
			}

			response := agentapi.AgentResponse{
				RequestID:    requestID,
				Status:       "completed",
				Plan:         plan,
				Observations: observations,
				FinalMessage: cached,
				DurationMs:   time.Since(started).Milliseconds(),
				SessionID:    sessionID,
			}
			if persistObservation := s.persistResponseRecord(ctx, requestID, response); persistObservation != nil {
				response.Observations = append(response.Observations, *persistObservation)
			}
			if emit != nil {
				_ = emit("status", map[string]string{"requestId": requestID, "status": "completed"})
				_ = emit("done", response)
			}

			return response, nil
		}
		observations = append(observations, agentapi.Observation{
			Source:  "redis.semantic_cache",
			Message: "cache miss — invoking provider",
		})
	}

	// 2. Long-term memory retrieval: inject relevant memories as context.
	if s.ltmStore != nil && len(promptEmbedding) > 0 {
		workspaceID := resolveWorkspaceRoot(req.Context)
		memEntries, memErr := s.ltmStore.Retrieve(ctx, workspaceID, promptEmbedding, 0)
		if memErr == nil && len(memEntries) > 0 {
			if block := redismem.FormatMemoryForPrompt(memEntries); block != "" {
				toolContextBlocks = append(toolContextBlocks, "Long-term agent memory (most relevant):\n"+block)
				// Rebuild prompt now that we have LTM context.
				providerPrompt = buildProviderPrompt(req, toolContextBlocks, conversationHistory)
				observations = append(observations, agentapi.Observation{
					Source:  "redis.ltm",
					Message: fmt.Sprintf("retrieved %d long-term memory entries", len(memEntries)),
				})
			}
		} else if memErr != nil {
			observations = append(observations, agentapi.Observation{
				Source:  "redis.ltm",
				Message: fmt.Sprintf("retrieval error (skipped): %v", memErr),
			})
		}
	}
	// -------------------------------------------------------------------------

	finalMessage, err := s.generateProviderOutput(ctx, requestID, providerPrompt, emit)
	if err != nil {
		s.emitError(emit, requestID, err)
		return agentapi.AgentResponse{}, err
	}

	// 3. Post-response: store in semantic cache and long-term memory.
	if len(promptEmbedding) > 0 && strings.TrimSpace(finalMessage) != "" {
		if s.semCache != nil {
			_ = s.semCache.Set(ctx, req.Prompt, promptEmbedding, finalMessage)
		}
		if s.ltmStore != nil {
			workspaceID := resolveWorkspaceRoot(req.Context)
			_ = s.ltmStore.Store(ctx, workspaceID, "agent_response",
				fmt.Sprintf("Q: %s\nA: %s", truncateHistory(req.Prompt), truncateHistory(finalMessage)),
				promptEmbedding,
			)
		}
	}

	if mode == "plan" {
		plan = setPlanStatus(plan, "completed")
		if emit != nil {
			for _, step := range plan {
				if err := emit("plan", step); err != nil {
					return agentapi.AgentResponse{}, err
				}
			}
		}
	}

	response := agentapi.AgentResponse{
		RequestID:    requestID,
		Status:       "completed",
		Plan:         plan,
		Observations: observations,
		FinalMessage: finalMessage,
		DurationMs:   time.Since(started).Milliseconds(),
		SessionID:    sessionID,
	}

	if persistObservation := s.persistResponseRecord(ctx, requestID, response); persistObservation != nil {
		response.Observations = append(response.Observations, *persistObservation)
		if emit != nil {
			if err := emit("observation", *persistObservation); err != nil {
				return agentapi.AgentResponse{}, err
			}
		}
	}

	if emit != nil {
		if err := emit("status", map[string]string{"requestId": requestID, "status": "completed"}); err != nil {
			return agentapi.AgentResponse{}, err
		}

		if err := emit("done", response); err != nil {
			return agentapi.AgentResponse{}, err
		}
	}

	return response, nil
}

func (s *Service) loadCompactHistory(ctx context.Context, sessionID string) string {
	if s.store == nil || strings.TrimSpace(sessionID) == "" {
		return ""
	}

	messages, err := s.store.LoadRecentMessages(ctx, sessionID, historyLoadLimit)
	if err != nil || len(messages) == 0 {
		return ""
	}

	return compactConversationHistory(messages)
}

func (s *Service) generateProviderOutput(
	ctx context.Context,
	requestID string,
	prompt string,
	emit StreamEmitter,
) (string, error) {
	if emit == nil {
		return s.provider.Generate(ctx, prompt)
	}

	if err := emit("status", map[string]string{"requestId": requestID, "status": "generating"}); err != nil {
		return "", err
	}

	var builder strings.Builder
	streamErr := s.provider.GenerateStream(ctx, prompt, func(token string) error {
		token = strings.TrimRight(token, "\x00")
		if token == "" {
			return nil
		}

		builder.WriteString(token)
		return emit("token", map[string]string{"requestId": requestID, "text": token})
	})
	if streamErr != nil {
		return "", streamErr
	}

	message := strings.TrimSpace(builder.String())
	if message != "" {
		return message, nil
	}

	fallback, err := s.provider.Generate(ctx, prompt)
	if err != nil {
		return "", err
	}

	if fallback != "" {
		if err := emit("token", map[string]string{"requestId": requestID, "text": fallback}); err != nil {
			return "", err
		}
	}

	return fallback, nil
}

func normalizeMaxSteps(maxSteps int) int {
	if maxSteps <= 0 {
		return 5
	}

	if maxSteps > 10 {
		return 10
	}

	return maxSteps
}

func (s *Service) emitError(emit StreamEmitter, requestID string, runErr error) {
	if emit == nil || runErr == nil {
		return
	}

	_ = emit("error", map[string]string{
		"requestId": requestID,
		"message":   runErr.Error(),
	})
}

func buildPlan(maxSteps int) []agentapi.PlanStep {
	basePlan := []agentapi.PlanStep{
		{Step: 1, Title: "Validate request and context", Status: "completed"},
		{Step: 2, Title: "Assemble relevant execution context", Status: "completed"},
		{Step: 3, Title: "Select provider and candidate tools", Status: "completed"},
		{Step: 4, Title: "Generate deterministic response draft", Status: "completed"},
		{Step: 5, Title: "Return structured result", Status: "completed"},
	}

	if maxSteps < len(basePlan) {
		return basePlan[:maxSteps]
	}

	return basePlan
}
