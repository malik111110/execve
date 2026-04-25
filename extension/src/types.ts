export interface AgentRequest {
  prompt: string;
  context: AgentContext;
  settings: AgentSettings;
  sessionId?: string;
  startNewSession?: boolean;
}

export interface AgentContext {
  workspaceRoot: string;
  activeFilePath: string;
  selectedText: string;
}

export interface AgentSettings {
  maxSteps: number;
  dryRun: boolean;
  mode: "agent" | "chat" | "plan";
  permissionMode?: PermissionMode;
  permissionPolicy?: PermissionPolicy;
}

export type PermissionMode = "defaultApproval" | "bypassApproval" | "autopilot";

export interface PermissionPolicy {
  allowedCommands: string[];
  blockedCommands: string[];
  allowedMcps: string[];
  blockedMcps: string[];
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
  sessionId?: string;
}

export interface SessionSummary {
  id: string;
  workspaceRoot: string;
  mode: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  messageCount: number;
  lastMessage: string;
}

export interface SessionMessage {
  id: number;
  sessionId: string;
  requestId: string;
  role: string;
  content: string;
  createdAt: string;
}

export interface SessionAPIResponse {
  id: number;
  sessionId: string;
  requestId: string;
  status: string;
  durationMs: number;
  finalMessage: string;
  provider: string;
  createdAt: string;
}

export interface ListSessionsResponse {
  sessions: SessionSummary[];
}

export interface SessionMessagesResponse {
  sessionId: string;
  messages: SessionMessage[];
}

export interface SessionAPIResponsesResponse {
  sessionId: string;
  responses: SessionAPIResponse[];
}

export interface RuntimeStreamCallbacks {
  onStatus?: (status: string) => void;
  onPlan?: (step: PlanStep) => void;
  onObservation?: (observation: Observation) => void;
  onToken?: (token: string) => void;
  onDone?: (response: AgentResponse) => void;
}

