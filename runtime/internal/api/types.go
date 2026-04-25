package api

type AgentRequest struct {
	Prompt          string        `json:"prompt"`
	Context         AgentContext  `json:"context"`
	Settings        AgentSettings `json:"settings"`
	SessionID       string        `json:"sessionId,omitempty"`
	StartNewSession bool          `json:"startNewSession,omitempty"`
}

type AgentContext struct {
	WorkspaceRoot  string `json:"workspaceRoot"`
	ActiveFilePath string `json:"activeFilePath"`
	SelectedText   string `json:"selectedText"`
}

type AgentSettings struct {
	MaxSteps         int              `json:"maxSteps"`
	DryRun           bool             `json:"dryRun"`
	Mode             string           `json:"mode"`
	PermissionMode   string           `json:"permissionMode,omitempty"`
	PermissionPolicy PermissionPolicy `json:"permissionPolicy,omitempty"`
}

type PermissionPolicy struct {
	AllowedCommands []string `json:"allowedCommands,omitempty"`
	BlockedCommands []string `json:"blockedCommands,omitempty"`
	AllowedMCPs     []string `json:"allowedMcps,omitempty"`
	BlockedMCPs     []string `json:"blockedMcps,omitempty"`
}

type PlanStep struct {
	Step   int    `json:"step"`
	Title  string `json:"title"`
	Status string `json:"status"`
}

type Observation struct {
	Source  string `json:"source"`
	Message string `json:"message"`
}

type AgentResponse struct {
	RequestID    string        `json:"requestId"`
	Status       string        `json:"status"`
	Plan         []PlanStep    `json:"plan"`
	Observations []Observation `json:"observations"`
	FinalMessage string        `json:"finalMessage"`
	DurationMs   int64         `json:"durationMs"`
	SessionID    string        `json:"sessionId,omitempty"`
}

type SessionSummary struct {
	ID            string `json:"id"`
	WorkspaceRoot string `json:"workspaceRoot"`
	Mode          string `json:"mode"`
	Title         string `json:"title"`
	CreatedAt     string `json:"createdAt"`
	UpdatedAt     string `json:"updatedAt"`
	MessageCount  int    `json:"messageCount"`
	LastMessage   string `json:"lastMessage"`
}

type SessionMessage struct {
	ID        int64  `json:"id"`
	SessionID string `json:"sessionId"`
	RequestID string `json:"requestId"`
	Role      string `json:"role"`
	Content   string `json:"content"`
	CreatedAt string `json:"createdAt"`
}

type SessionAPIResponse struct {
	ID           int64  `json:"id"`
	SessionID    string `json:"sessionId"`
	RequestID    string `json:"requestId"`
	Status       string `json:"status"`
	DurationMs   int64  `json:"durationMs"`
	FinalMessage string `json:"finalMessage"`
	Provider     string `json:"provider"`
	CreatedAt    string `json:"createdAt"`
}

type ListSessionsResponse struct {
	Sessions []SessionSummary `json:"sessions"`
}

type SessionMessagesResponse struct {
	SessionID string           `json:"sessionId"`
	Messages  []SessionMessage `json:"messages"`
}

type SessionAPIResponsesResponse struct {
	SessionID string               `json:"sessionId"`
	Responses []SessionAPIResponse `json:"responses"`
}
