package storage

import (
	"context"
	"crypto/rand"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"

	agentapi "github.com/digitalcenter/vscode-ex-llm/runtime/internal/api"
	_ "modernc.org/sqlite"
)

const (
	defaultSessionListLimit  = 40
	defaultMessageListLimit  = 80
	defaultResponseListLimit = 80
	maxListLimit             = 200
)

type SQLiteStore struct {
	db *sql.DB
}

type SessionState struct {
	ID      string
	Created bool
}

type SessionUpsertInput struct {
	SessionID     string
	WorkspaceRoot string
	Mode          string
	Prompt        string
	StartNew      bool
}

type RequestRecord struct {
	SessionID string
	RequestID string
	Prompt    string
	Context   agentapi.AgentContext
	Settings  agentapi.AgentSettings
}

type ResponseRecord struct {
	SessionID string
	RequestID string
	Provider  string
	Response  agentapi.AgentResponse
}

func ResolveDefaultSQLitePath() string {
	if configured := strings.TrimSpace(os.Getenv("AGENT_SQLITE_PATH")); configured != "" {
		return configured
	}

	homeDir, err := os.UserHomeDir()
	if err == nil && strings.TrimSpace(homeDir) != "" {
		return filepath.Join(homeDir, ".local-agent", "agentd.sqlite")
	}

	return filepath.Join(".", "agentd.sqlite")
}

func NewSQLiteStore(dbPath string) (*SQLiteStore, error) {
	dbPath = strings.TrimSpace(dbPath)
	if dbPath == "" {
		dbPath = ResolveDefaultSQLitePath()
	}

	if err := os.MkdirAll(filepath.Dir(dbPath), 0o755); err != nil {
		return nil, fmt.Errorf("create sqlite directory: %w", err)
	}

	db, err := sql.Open("sqlite", dbPath)
	if err != nil {
		return nil, fmt.Errorf("open sqlite database: %w", err)
	}

	db.SetMaxOpenConns(1)
	db.SetMaxIdleConns(1)
	db.SetConnMaxLifetime(0)

	store := &SQLiteStore{db: db}
	if err := store.initSchema(context.Background()); err != nil {
		_ = db.Close()
		return nil, err
	}

	return store, nil
}

func (s *SQLiteStore) Close() error {
	if s == nil || s.db == nil {
		return nil
	}

	return s.db.Close()
}

func (s *SQLiteStore) EnsureSession(ctx context.Context, input SessionUpsertInput) (SessionState, error) {
	if s == nil || s.db == nil {
		return SessionState{}, fmt.Errorf("sqlite store is not initialized")
	}

	workspaceRoot := strings.TrimSpace(input.WorkspaceRoot)
	if workspaceRoot == "" {
		workspaceRoot = "__global__"
	}

	mode := strings.TrimSpace(input.Mode)
	if mode == "" {
		mode = "agent"
	}

	sessionID := strings.TrimSpace(input.SessionID)
	if input.StartNew || sessionID == "" {
		sessionID = generateSessionID()
	}

	now := time.Now().UTC().Format(time.RFC3339Nano)
	title := deriveSessionTitle(input.Prompt)

	created := false
	exists, err := s.sessionExists(ctx, sessionID)
	if err != nil {
		return SessionState{}, err
	}

	if !exists {
		created = true
		if _, err := s.db.ExecContext(
			ctx,
			`INSERT INTO sessions (id, workspace_root, mode, title, metadata_json, created_at, updated_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?)`,
			sessionID,
			workspaceRoot,
			mode,
			title,
			"{}",
			now,
			now,
		); err != nil {
			return SessionState{}, fmt.Errorf("insert session: %w", err)
		}
	} else {
		if _, err := s.db.ExecContext(
			ctx,
			`UPDATE sessions
			 SET workspace_root = ?, mode = ?, title = CASE WHEN title = '' THEN ? ELSE title END, updated_at = ?
			 WHERE id = ?`,
			workspaceRoot,
			mode,
			title,
			now,
			sessionID,
		); err != nil {
			return SessionState{}, fmt.Errorf("update session: %w", err)
		}
	}

	return SessionState{ID: sessionID, Created: created}, nil
}

func (s *SQLiteStore) RecordRequest(ctx context.Context, record RequestRecord) error {
	if s == nil || s.db == nil {
		return fmt.Errorf("sqlite store is not initialized")
	}

	sessionID := strings.TrimSpace(record.SessionID)
	if sessionID == "" {
		return fmt.Errorf("session id is required")
	}

	requestID := strings.TrimSpace(record.RequestID)
	if requestID == "" {
		return fmt.Errorf("request id is required")
	}

	now := time.Now().UTC().Format(time.RFC3339Nano)
	contextJSON, err := json.Marshal(record.Context)
	if err != nil {
		return fmt.Errorf("marshal context: %w", err)
	}

	settingsJSON, err := json.Marshal(record.Settings)
	if err != nil {
		return fmt.Errorf("marshal settings: %w", err)
	}

	if _, err := s.db.ExecContext(
		ctx,
		`INSERT INTO messages (session_id, request_id, role, content, context_json, settings_json, created_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?)`,
		sessionID,
		requestID,
		"user",
		record.Prompt,
		string(contextJSON),
		string(settingsJSON),
		now,
	); err != nil {
		return fmt.Errorf("insert user message: %w", err)
	}

	for _, item := range relevantContextItems(record) {
		if _, err := s.db.ExecContext(
			ctx,
			`INSERT INTO relevant_context (session_id, request_id, key, value, source, created_at)
			 VALUES (?, ?, ?, ?, ?, ?)`,
			sessionID,
			requestID,
			item.Key,
			item.Value,
			item.Source,
			now,
		); err != nil {
			return fmt.Errorf("insert relevant context %q: %w", item.Key, err)
		}
	}

	if _, err := s.db.ExecContext(
		ctx,
		`UPDATE sessions SET updated_at = ? WHERE id = ?`,
		now,
		sessionID,
	); err != nil {
		return fmt.Errorf("touch session after request: %w", err)
	}

	return nil
}

func (s *SQLiteStore) RecordResponse(ctx context.Context, record ResponseRecord) error {
	if s == nil || s.db == nil {
		return fmt.Errorf("sqlite store is not initialized")
	}

	sessionID := strings.TrimSpace(record.SessionID)
	if sessionID == "" {
		return fmt.Errorf("session id is required")
	}

	requestID := strings.TrimSpace(record.RequestID)
	if requestID == "" {
		return fmt.Errorf("request id is required")
	}

	now := time.Now().UTC().Format(time.RFC3339Nano)
	planJSON, err := json.Marshal(record.Response.Plan)
	if err != nil {
		return fmt.Errorf("marshal plan: %w", err)
	}

	observationsJSON, err := json.Marshal(record.Response.Observations)
	if err != nil {
		return fmt.Errorf("marshal observations: %w", err)
	}

	if _, err := s.db.ExecContext(
		ctx,
		`INSERT INTO messages (session_id, request_id, role, content, context_json, settings_json, created_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?)`,
		sessionID,
		requestID,
		"assistant",
		record.Response.FinalMessage,
		"{}",
		"{}",
		now,
	); err != nil {
		return fmt.Errorf("insert assistant message: %w", err)
	}

	if _, err := s.db.ExecContext(
		ctx,
		`INSERT INTO api_responses (
			session_id,
			request_id,
			status,
			duration_ms,
			final_message,
			plan_json,
			observations_json,
			provider,
			created_at
		 ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		sessionID,
		requestID,
		record.Response.Status,
		record.Response.DurationMs,
		record.Response.FinalMessage,
		string(planJSON),
		string(observationsJSON),
		strings.TrimSpace(record.Provider),
		now,
	); err != nil {
		return fmt.Errorf("insert api response: %w", err)
	}

	if _, err := s.db.ExecContext(
		ctx,
		`UPDATE sessions SET updated_at = ? WHERE id = ?`,
		now,
		sessionID,
	); err != nil {
		return fmt.Errorf("touch session after response: %w", err)
	}

	return nil
}

func (s *SQLiteStore) ListSessions(
	ctx context.Context,
	workspaceRoot string,
	limit int,
) ([]agentapi.SessionSummary, error) {
	if s == nil || s.db == nil {
		return nil, fmt.Errorf("sqlite store is not initialized")
	}

	workspaceRoot = strings.TrimSpace(workspaceRoot)
	limit = normalizeLimit(limit, defaultSessionListLimit)

	rows, err := s.db.QueryContext(
		ctx,
		`SELECT
			s.id,
			s.workspace_root,
			s.mode,
			s.title,
			s.created_at,
			s.updated_at,
			COALESCE((SELECT COUNT(*) FROM messages m WHERE m.session_id = s.id), 0) AS message_count,
			COALESCE((SELECT content FROM messages m WHERE m.session_id = s.id ORDER BY m.id DESC LIMIT 1), '') AS last_message
		 FROM sessions s
		 WHERE (? = '' OR s.workspace_root = ?)
		 ORDER BY s.updated_at DESC
		 LIMIT ?`,
		workspaceRoot,
		workspaceRoot,
		limit,
	)
	if err != nil {
		return nil, fmt.Errorf("list sessions: %w", err)
	}
	defer rows.Close()

	summaries := make([]agentapi.SessionSummary, 0, limit)
	for rows.Next() {
		var summary agentapi.SessionSummary
		if err := rows.Scan(
			&summary.ID,
			&summary.WorkspaceRoot,
			&summary.Mode,
			&summary.Title,
			&summary.CreatedAt,
			&summary.UpdatedAt,
			&summary.MessageCount,
			&summary.LastMessage,
		); err != nil {
			return nil, fmt.Errorf("scan session summary: %w", err)
		}

		summaries = append(summaries, summary)
	}

	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate sessions: %w", err)
	}

	return summaries, nil
}

func (s *SQLiteStore) ListSessionMessages(
	ctx context.Context,
	sessionID string,
	limit int,
) ([]agentapi.SessionMessage, error) {
	if s == nil || s.db == nil {
		return nil, fmt.Errorf("sqlite store is not initialized")
	}

	sessionID = strings.TrimSpace(sessionID)
	if sessionID == "" {
		return nil, fmt.Errorf("session id is required")
	}

	limit = normalizeLimit(limit, defaultMessageListLimit)

	rows, err := s.db.QueryContext(
		ctx,
		`SELECT id, session_id, request_id, role, content, created_at
		 FROM messages
		 WHERE session_id = ?
		 ORDER BY id DESC
		 LIMIT ?`,
		sessionID,
		limit,
	)
	if err != nil {
		return nil, fmt.Errorf("list messages: %w", err)
	}
	defer rows.Close()

	messages := make([]agentapi.SessionMessage, 0, limit)
	for rows.Next() {
		var message agentapi.SessionMessage
		if err := rows.Scan(
			&message.ID,
			&message.SessionID,
			&message.RequestID,
			&message.Role,
			&message.Content,
			&message.CreatedAt,
		); err != nil {
			return nil, fmt.Errorf("scan message: %w", err)
		}

		messages = append(messages, message)
	}

	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate messages: %w", err)
	}

	reverseSessionMessages(messages)
	return messages, nil
}

func (s *SQLiteStore) ListSessionResponses(
	ctx context.Context,
	sessionID string,
	limit int,
) ([]agentapi.SessionAPIResponse, error) {
	if s == nil || s.db == nil {
		return nil, fmt.Errorf("sqlite store is not initialized")
	}

	sessionID = strings.TrimSpace(sessionID)
	if sessionID == "" {
		return nil, fmt.Errorf("session id is required")
	}

	limit = normalizeLimit(limit, defaultResponseListLimit)

	rows, err := s.db.QueryContext(
		ctx,
		`SELECT id, session_id, request_id, status, duration_ms, final_message, provider, created_at
		 FROM api_responses
		 WHERE session_id = ?
		 ORDER BY id DESC
		 LIMIT ?`,
		sessionID,
		limit,
	)
	if err != nil {
		return nil, fmt.Errorf("list api responses: %w", err)
	}
	defer rows.Close()

	responses := make([]agentapi.SessionAPIResponse, 0, limit)
	for rows.Next() {
		var response agentapi.SessionAPIResponse
		if err := rows.Scan(
			&response.ID,
			&response.SessionID,
			&response.RequestID,
			&response.Status,
			&response.DurationMs,
			&response.FinalMessage,
			&response.Provider,
			&response.CreatedAt,
		); err != nil {
			return nil, fmt.Errorf("scan api response: %w", err)
		}

		responses = append(responses, response)
	}

	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate api responses: %w", err)
	}

	reverseSessionResponses(responses)
	return responses, nil
}

func (s *SQLiteStore) UpdateSessionTitle(
	ctx context.Context,
	sessionID string,
	title string,
) (bool, error) {
	if s == nil || s.db == nil {
		return false, fmt.Errorf("sqlite store is not initialized")
	}

	sessionID = strings.TrimSpace(sessionID)
	if sessionID == "" {
		return false, fmt.Errorf("session id is required")
	}

	title = strings.TrimSpace(title)
	if title == "" {
		return false, fmt.Errorf("session title is required")
	}

	now := time.Now().UTC().Format(time.RFC3339Nano)
	result, err := s.db.ExecContext(
		ctx,
		`UPDATE sessions SET title = ?, updated_at = ? WHERE id = ?`,
		title,
		now,
		sessionID,
	)
	if err != nil {
		return false, fmt.Errorf("update session title: %w", err)
	}

	rowsAffected, err := result.RowsAffected()
	if err != nil {
		return false, fmt.Errorf("update session title rows affected: %w", err)
	}

	return rowsAffected > 0, nil
}

func (s *SQLiteStore) DeleteSession(
	ctx context.Context,
	sessionID string,
) (bool, error) {
	if s == nil || s.db == nil {
		return false, fmt.Errorf("sqlite store is not initialized")
	}

	sessionID = strings.TrimSpace(sessionID)
	if sessionID == "" {
		return false, fmt.Errorf("session id is required")
	}

	result, err := s.db.ExecContext(
		ctx,
		`DELETE FROM sessions WHERE id = ?`,
		sessionID,
	)
	if err != nil {
		return false, fmt.Errorf("delete session: %w", err)
	}

	rowsAffected, err := result.RowsAffected()
	if err != nil {
		return false, fmt.Errorf("delete session rows affected: %w", err)
	}

	return rowsAffected > 0, nil
}

func (s *SQLiteStore) initSchema(ctx context.Context) error {
	if _, err := s.db.ExecContext(ctx, `PRAGMA journal_mode = WAL;`); err != nil {
		return fmt.Errorf("set sqlite pragma journal_mode: %w", err)
	}

	if _, err := s.db.ExecContext(ctx, `PRAGMA foreign_keys = ON;`); err != nil {
		return fmt.Errorf("set sqlite pragma foreign_keys: %w", err)
	}

	statements := []string{
		`CREATE TABLE IF NOT EXISTS sessions (
			id TEXT PRIMARY KEY,
			workspace_root TEXT NOT NULL,
			mode TEXT NOT NULL,
			title TEXT NOT NULL DEFAULT '',
			metadata_json TEXT NOT NULL DEFAULT '{}',
			created_at TEXT NOT NULL,
			updated_at TEXT NOT NULL
		);`,
		`CREATE INDEX IF NOT EXISTS idx_sessions_workspace_updated
		 ON sessions(workspace_root, updated_at DESC);`,
		`CREATE TABLE IF NOT EXISTS messages (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			session_id TEXT NOT NULL,
			request_id TEXT NOT NULL,
			role TEXT NOT NULL,
			content TEXT NOT NULL,
			context_json TEXT NOT NULL DEFAULT '{}',
			settings_json TEXT NOT NULL DEFAULT '{}',
			created_at TEXT NOT NULL,
			FOREIGN KEY(session_id) REFERENCES sessions(id) ON DELETE CASCADE
		);`,
		`CREATE INDEX IF NOT EXISTS idx_messages_session_created
		 ON messages(session_id, id DESC);`,
		`CREATE TABLE IF NOT EXISTS api_responses (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			session_id TEXT NOT NULL,
			request_id TEXT NOT NULL,
			status TEXT NOT NULL,
			duration_ms INTEGER NOT NULL DEFAULT 0,
			final_message TEXT NOT NULL,
			plan_json TEXT NOT NULL DEFAULT '[]',
			observations_json TEXT NOT NULL DEFAULT '[]',
			provider TEXT NOT NULL DEFAULT '',
			created_at TEXT NOT NULL,
			FOREIGN KEY(session_id) REFERENCES sessions(id) ON DELETE CASCADE
		);`,
		`CREATE INDEX IF NOT EXISTS idx_api_responses_session_created
		 ON api_responses(session_id, id DESC);`,
		`CREATE TABLE IF NOT EXISTS relevant_context (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			session_id TEXT NOT NULL,
			request_id TEXT NOT NULL,
			key TEXT NOT NULL,
			value TEXT NOT NULL,
			source TEXT NOT NULL,
			created_at TEXT NOT NULL,
			FOREIGN KEY(session_id) REFERENCES sessions(id) ON DELETE CASCADE
		);`,
		`CREATE INDEX IF NOT EXISTS idx_relevant_context_session_created
		 ON relevant_context(session_id, id DESC);`,
	}

	for _, statement := range statements {
		if _, err := s.db.ExecContext(ctx, statement); err != nil {
			return fmt.Errorf("initialize sqlite schema: %w", err)
		}
	}

	return nil
}

func (s *SQLiteStore) sessionExists(ctx context.Context, sessionID string) (bool, error) {
	var exists int
	err := s.db.QueryRowContext(
		ctx,
		`SELECT 1 FROM sessions WHERE id = ? LIMIT 1`,
		sessionID,
	).Scan(&exists)
	if err == nil {
		return true, nil
	}

	if err == sql.ErrNoRows {
		return false, nil
	}

	return false, fmt.Errorf("check session existence: %w", err)
}

func deriveSessionTitle(prompt string) string {
	prompt = strings.TrimSpace(prompt)
	if prompt == "" {
		return "Untitled session"
	}

	firstLine := strings.TrimSpace(strings.Split(prompt, "\n")[0])
	if len(firstLine) <= 120 {
		return firstLine
	}

	return firstLine[:120] + "..."
}

func generateSessionID() string {
	buffer := make([]byte, 6)
	if _, err := rand.Read(buffer); err != nil {
		return fmt.Sprintf("sess-%d", time.Now().UnixNano())
	}

	return fmt.Sprintf("sess-%d-%s", time.Now().UnixNano(), hex.EncodeToString(buffer))
}

type relevantContextItem struct {
	Key    string
	Value  string
	Source string
}

func relevantContextItems(record RequestRecord) []relevantContextItem {
	items := make([]relevantContextItem, 0, 6)

	if value := strings.TrimSpace(record.Context.WorkspaceRoot); value != "" {
		items = append(items, relevantContextItem{Key: "workspace_root", Value: value, Source: "request.context"})
	}

	if value := strings.TrimSpace(record.Context.ActiveFilePath); value != "" {
		items = append(items, relevantContextItem{Key: "active_file_path", Value: value, Source: "request.context"})
	}

	if value := strings.TrimSpace(record.Context.SelectedText); value != "" {
		items = append(items, relevantContextItem{Key: "selected_text", Value: truncateValue(value, 2000), Source: "request.context"})
	}

	if value := strings.TrimSpace(record.Settings.Mode); value != "" {
		items = append(items, relevantContextItem{Key: "mode", Value: value, Source: "request.settings"})
	}

	if value := strings.TrimSpace(record.Settings.PermissionMode); value != "" {
		items = append(items, relevantContextItem{Key: "permission_mode", Value: value, Source: "request.settings"})
	}

	items = append(items, relevantContextItem{Key: "prompt_excerpt", Value: truncateValue(record.Prompt, 2000), Source: "request.prompt"})
	return items
}

func truncateValue(value string, maxChars int) string {
	trimmed := strings.TrimSpace(value)
	if len(trimmed) <= maxChars {
		return trimmed
	}

	return trimmed[:maxChars] + "..."
}

func normalizeLimit(limit int, fallback int) int {
	if limit <= 0 {
		limit = fallback
	}

	if limit > maxListLimit {
		limit = maxListLimit
	}

	return limit
}

func reverseSessionMessages(values []agentapi.SessionMessage) {
	for left, right := 0, len(values)-1; left < right; left, right = left+1, right-1 {
		values[left], values[right] = values[right], values[left]
	}
}

func reverseSessionResponses(values []agentapi.SessionAPIResponse) {
	for left, right := 0, len(values)-1; left < right; left, right = left+1, right-1 {
		values[left], values[right] = values[right], values[left]
	}
}
