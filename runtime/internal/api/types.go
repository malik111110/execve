package api

type AgentRequest struct {
	Prompt   string        `json:"prompt"`
	Context  AgentContext  `json:"context"`
	Settings AgentSettings `json:"settings"`
}

type AgentContext struct {
	WorkspaceRoot  string `json:"workspaceRoot"`
	ActiveFilePath string `json:"activeFilePath"`
	SelectedText   string `json:"selectedText"`
}

type AgentSettings struct {
	MaxSteps int    `json:"maxSteps"`
	DryRun   bool   `json:"dryRun"`
	Mode     string `json:"mode"`
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
}
