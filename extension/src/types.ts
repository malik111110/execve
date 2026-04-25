export interface AgentRequest {
  prompt: string;
  context: AgentContext;
  settings: AgentSettings;
}

export interface AgentContext {
  workspaceRoot: string;
  activeFilePath: string;
  selectedText: string;
}

export interface AgentSettings {
  maxSteps: number;
  dryRun: boolean;
  mode: "agent" | "chat";
}

export interface PlanStep {
  step: number;
  title: string;
  status: string;
}

export interface Observation {
  source: string;
  message: string;
}

export interface AgentResponse {
  requestId: string;
  status: string;
  plan: PlanStep[];
  observations: Observation[];
  finalMessage: string;
  durationMs: number;
}

export interface RuntimeStreamCallbacks {
  onStatus?: (status: string) => void;
  onPlan?: (step: PlanStep) => void;
  onObservation?: (observation: Observation) => void;
  onToken?: (token: string) => void;
  onDone?: (response: AgentResponse) => void;
}

