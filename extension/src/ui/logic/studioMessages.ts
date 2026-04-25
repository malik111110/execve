import type { PermissionMode } from "../../types";

export type SessionMode = "agent" | "chat" | "plan";

export type ContextInsertKind = "activeSymbol" | "gitDiff" | "failingTests";

export type StudioIncomingMessage =
  | { type: "ready" }
  | { type: "setMode"; mode: SessionMode }
  | { type: "setPermissionMode"; mode: PermissionMode }
  | { type: "submitPrompt"; prompt: string; mode: SessionMode }
  | { type: "copyPayload"; payload: string }
  | { type: "insertContext"; kind: ContextInsertKind }
  | { type: "refreshHistory" }
  | { type: "openHistorySession"; sessionId: string }
  | { type: "renameHistorySession"; sessionId: string; title: string }
  | { type: "deleteHistorySession"; sessionId: string }
  | { type: "newConversation" }
  | { type: "continueCommand" }
  | { type: "stopCommand" }
  | { type: "openLatestDiff" }
  | { type: "acceptLatestDiff" }
  | { type: "rejectLatestDiff" }
  | { type: "focusInput" }
  | { type: "webviewError"; message: string; stack?: string; source?: string; line?: number; col?: number };

export function parseIncomingMessage(rawMessage: unknown): StudioIncomingMessage | undefined {
  if (!rawMessage || typeof rawMessage !== "object") {
    return undefined;
  }

  const candidate = rawMessage as Record<string, unknown>;
  const type = candidate.type;

  if (type === "ready") {
    return { type };
  }

  if (type === "newConversation") {
    return { type };
  }

  if (type === "refreshHistory") {
    return { type };
  }

  if (type === "openHistorySession" && typeof candidate.sessionId === "string") {
    return {
      type,
      sessionId: candidate.sessionId
    };
  }

  if (
    type === "renameHistorySession" &&
    typeof candidate.sessionId === "string" &&
    typeof candidate.title === "string"
  ) {
    return {
      type,
      sessionId: candidate.sessionId,
      title: candidate.title
    };
  }

  if (type === "deleteHistorySession" && typeof candidate.sessionId === "string") {
    return {
      type,
      sessionId: candidate.sessionId
    };
  }

  if (type === "continueCommand") {
    return { type };
  }

  if (type === "stopCommand") {
    return { type };
  }

  if (type === "openLatestDiff") {
    return { type };
  }

  if (type === "acceptLatestDiff") {
    return { type };
  }

  if (type === "rejectLatestDiff") {
    return { type };
  }

  if (type === "focusInput") {
    return { type };
  }

  if (type === "webviewError") {
    return {
      type,
      message: typeof candidate.message === "string" ? candidate.message : String(candidate.message ?? "unknown"),
      stack: typeof candidate.stack === "string" ? candidate.stack : undefined,
      source: typeof candidate.source === "string" ? candidate.source : undefined,
      line: typeof candidate.line === "number" ? candidate.line : undefined,
      col: typeof candidate.col === "number" ? candidate.col : undefined
    };
  }

  if (type === "setPermissionMode" && isPermissionMode(candidate.mode)) {
    return {
      type,
      mode: candidate.mode
    };
  }

  if (type === "setMode" && isSessionMode(candidate.mode)) {
    return {
      type,
      mode: candidate.mode
    };
  }

  if (
    type === "submitPrompt" &&
    typeof candidate.prompt === "string" &&
    isSessionMode(candidate.mode)
  ) {
    return {
      type,
      prompt: candidate.prompt,
      mode: candidate.mode
    };
  }

  if (type === "copyPayload" && typeof candidate.payload === "string") {
    return {
      type,
      payload: candidate.payload
    };
  }

  if (type === "insertContext" && isContextInsertKind(candidate.kind)) {
    return {
      type,
      kind: candidate.kind
    };
  }

  return undefined;
}

function isSessionMode(value: unknown): value is SessionMode {
  return value === "agent" || value === "chat" || value === "plan";
}

function isPermissionMode(value: unknown): value is PermissionMode {
  return value === "defaultApproval" || value === "bypassApproval" || value === "autopilot";
}

function isContextInsertKind(value: unknown): value is ContextInsertKind {
  return value === "activeSymbol" || value === "gitDiff" || value === "failingTests";
}
