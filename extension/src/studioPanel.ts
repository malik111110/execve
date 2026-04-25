import * as childProcess from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";
import * as vscode from "vscode";
import { RuntimeClient } from "./runtimeClient";
import { renderStudioShell } from "./ui/components/studioShell";
import { renderStudioClientScript } from "./ui/webview/studioClientScript";
import { parseIncomingMessage } from "./ui/logic/studioMessages";
import { renderStudioStyles } from "./ui/styles/studioStyles";
import {
  normalizePermissionMode,
  permissionModeLabel,
  readStringArraySetting
} from "./ui/logic/studioConfig";
import type { ContextInsertKind, SessionMode } from "./ui/logic/studioMessages";
import {
  createWorkspaceDiffSnapshot,
  extractFailingTestExcerpt,
  shortSessionID,
  StudioDiffFileChange,
  StudioDiffSnapshot,
  toPayloadPreview,
  toPayloadText,
  toSelectionPreview,
  truncateText,
  uniqueDiffPaths
} from "./ui/logic/studioHelpers";
import {
  AgentRequest,
  AgentResponse,
  Observation,
  PermissionMode,
  PlanStep,
  SessionAPIResponse,
  SessionMessage,
  SessionSummary
} from "./types";

export type { ContextInsertKind } from "./ui/logic/studioMessages";
export type { StudioDiffFileChange, StudioDiffSnapshot } from "./ui/logic/studioHelpers";

const execFileAsync = promisify(childProcess.execFile);

type TraceKind =
  | "request"
  | "status"
  | "plan"
  | "observation"
  | "context"
  | "diff"
  | "fallback"
  | "result"
  | "error";

type ConversationRole = "user" | "assistant";
type ConversationVariant = "default" | "error";

export interface AgentStudioPanelOptions {
  onDiffSnapshot?: (snapshot: StudioDiffSnapshot) => void;
}

interface StudioContextSnapshot {
  workspaceRoot: string;
  activeFilePath: string;
  hasSelection: boolean;
  selectionPreview: string;
  runtimeUrl: string;
  timeoutMs: number;
  dryRun: boolean;
  permissionMode: PermissionMode;
}

interface ResolvedSessionContext {
  payload: AgentRequest;
  snapshot: StudioContextSnapshot;
}

interface StudioConversationEntry {
  id: string;
  role: ConversationRole;
  text: string;
  variant: ConversationVariant;
  createdAt: number;
}

interface StudioTraceCard {
  id: string;
  kind: TraceKind;
  title: string;
  preview: string;
  payload: string;
  createdAt: number;
}

interface PersistedStudioState {
  version: number;
  mode: SessionMode;
  currentSessionId?: string;
  conversation: StudioConversationEntry[];
  traces: StudioTraceCard[];
  latestDiffSnapshot?: StudioDiffSnapshot;
  updatedAt: number;
}

interface ContextInsertBlock {
  label: string;
  content: string;
  source: string;
}

interface CommandCaptureResult {
  commandLine: string;
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

interface TestCommandSpec {
  command: string;
  args: string[];
  label: string;
}

const OUTPUT_CHANNEL_NAME = "Local LLM Agent";
const STORAGE_PREFIX = "localAgent.studio.state.v1::";
const STORAGE_VERSION = 1;
const GLOBAL_WORKSPACE_KEY = "__global__";

const MAX_CONVERSATION_ENTRIES = 80;
const MAX_TRACE_ENTRIES = 200;
const MAX_CONTEXT_CHARS = 7000;
const MAX_SELECTED_TEXT_PREVIEW_CHARS = 2000;
const TEST_TIMEOUT_MS = 30000;
const MAX_HISTORY_SESSIONS = 80;
const MAX_HISTORY_MESSAGES = 200;

export class AgentStudioPanel {
  private static currentPanel: AgentStudioPanel | undefined;

  static createOrShow(
    extensionContext: vscode.ExtensionContext,
    output: vscode.OutputChannel,
    initialMode: SessionMode,
    options?: AgentStudioPanelOptions
  ): AgentStudioPanel {
    const existing = AgentStudioPanel.currentPanel;
    if (existing) {
      existing.panel.reveal(vscode.ViewColumn.One);
      existing.setMode(initialMode);
      existing.updateOptions(options);
      void existing.hydrate();
      return existing;
    }

    const panel = vscode.window.createWebviewPanel(
      "localAgent.studio",
      "Local Agent Studio",
      vscode.ViewColumn.One,
      {
        enableScripts: true,
        retainContextWhenHidden: true
      }
    );

    AgentStudioPanel.currentPanel = new AgentStudioPanel(
      panel,
      extensionContext,
      output,
      initialMode,
      options
    );

    return AgentStudioPanel.currentPanel;
  }

  private requestInFlight = false;
  private webviewReady = false;
  private queuedMessages: unknown[] = [];
  private persistTimer: NodeJS.Timeout | undefined;
  private activeWorkspaceKey = GLOBAL_WORKSPACE_KEY;
  private currentSessionId: string | undefined;
  private sessionHistory: SessionSummary[] = [];
  private conversation: StudioConversationEntry[] = [];
  private traces: StudioTraceCard[] = [];
  private pendingAssistantMessageId: string | undefined;
  private streamedTokenCount = 0;
  private diffStreamingWorkspaceRoot: string | undefined;
  private latestDiffSnapshot: StudioDiffSnapshot | undefined;
  private lastRawWorkspaceDiff = "";
  private diffCaptureTimer: NodeJS.Timeout | undefined;
  private diffCaptureInFlight = false;
  private diffCapturePendingReason: string | undefined;
  private readonly contextSyncDisposables: vscode.Disposable[] = [];

  private constructor(
    private readonly panel: vscode.WebviewPanel,
    private readonly extensionContext: vscode.ExtensionContext,
    private readonly output: vscode.OutputChannel,
    private mode: SessionMode,
    private options?: AgentStudioPanelOptions
  ) {
    this.panel.webview.html = this.getHtml(this.mode);
    void vscode.commands.executeCommand("setContext", "localAgent.studioOpen", true);
    void vscode.commands.executeCommand("setContext", "localAgent.studioHasDiff", false);
    void vscode.commands.executeCommand("setContext", "localAgent.studioBusy", false);

    this.panel.onDidDispose(() => {
      if (this.persistTimer) {
        clearTimeout(this.persistTimer);
      }
      if (this.diffCaptureTimer) {
        clearTimeout(this.diffCaptureTimer);
      }
      for (const disposable of this.contextSyncDisposables) {
        disposable.dispose();
      }
      void this.persistState();
      void vscode.commands.executeCommand("setContext", "localAgent.studioOpen", false);
      void vscode.commands.executeCommand("setContext", "localAgent.studioHasDiff", false);
      void vscode.commands.executeCommand("setContext", "localAgent.studioBusy", false);

      if (AgentStudioPanel.currentPanel === this) {
        AgentStudioPanel.currentPanel = undefined;
      }
    });

    this.panel.webview.onDidReceiveMessage(async (rawMessage: unknown) => {
      const message = parseIncomingMessage(rawMessage);
      if (!message) {
        return;
      }

      switch (message.type) {
        case "ready":
          this.webviewReady = true;
          await this.hydrate();
          this.flushQueuedMessages();
          return;
        case "setMode":
          this.setMode(message.mode);
          return;
        case "setPermissionMode":
          try {
            await this.setPermissionMode(message.mode);
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            this.addTrace("error", "permissions.mode.error", { message });
            void vscode.window.showErrorMessage(`Local Agent Studio: ${message}`);
          }
          return;
        case "submitPrompt":
          try {
            await this.handleSubmit(message.prompt, message.mode);
          } catch (error) {
            const detail = error instanceof Error ? error.message : String(error);
            this.output.appendLine(`[submit-crash] ${detail}`);
            this.addTrace("error", "runtime.submit.crash", { message: detail });
            this.requestInFlight = false;
            this.pendingAssistantMessageId = undefined;
            this.postMessage({ type: "busy", busy: false });
            this.postMessage({
              type: "run-error",
              message: detail
            });
            void vscode.commands.executeCommand("setContext", "localAgent.studioBusy", false);
            void vscode.window.showErrorMessage(`Local Agent Studio: ${detail}`);
          }
          return;
        case "copyPayload":
          await this.copyPayload(message.payload);
          return;
        case "insertContext":
          await this.handleContextInsert(message.kind, false);
          return;
        case "refreshHistory":
          await this.refreshSessionHistory();
          return;
        case "openHistorySession":
          await this.loadSessionFromHistory(message.sessionId);
          return;
        case "renameHistorySession":
          await this.renameSessionFromHistory(message.sessionId, message.title);
          return;
        case "deleteHistorySession":
          await this.deleteSessionFromHistory(message.sessionId);
          return;
        case "newConversation":
          this.startNewConversation();
          return;
        case "continueCommand":
          await this.continueTerminalCommand();
          return;
        case "stopCommand":
          await this.stopTerminalCommand();
          return;
        case "openLatestDiff":
          await this.openLatestDiffEditor();
          return;
        case "acceptLatestDiff":
          try {
            await this.acceptLatestDiffSnapshot();
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            this.addTrace("error", "workspace.diff.accept.error", { message });
            void vscode.window.showErrorMessage(`Local Agent Studio: ${message}`);
          }
          return;
        case "rejectLatestDiff":
          try {
            await this.rejectLatestDiffSnapshot();
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            this.addTrace("error", "workspace.diff.reject.error", { message });
            void vscode.window.showErrorMessage(`Local Agent Studio: ${message}`);
          }
          return;
        case "focusInput":
          this.focusComposer();
          return;
        case "webviewError": {
          const detail = `${message.message}${message.stack ? "\n" + message.stack : ""}${message.source ? `\n@ ${message.source}:${message.line}:${message.col}` : ""}`;
          this.output.appendLine(`[webview-error] ${detail}`);
          this.addTrace("error", "webview.error", {
            message: message.message,
            stack: message.stack,
            source: message.source,
            line: message.line,
            col: message.col
          });
          void vscode.window.showErrorMessage(`Local Agent Studio (webview): ${message.message}`);
          return;
        }
        default:
          return;
      }
    });

    const syncContext = (): void => {
      void this.syncContextSnapshot();
    };

    this.contextSyncDisposables.push(
      vscode.window.onDidChangeActiveTextEditor(syncContext),
      vscode.workspace.onDidChangeWorkspaceFolders(syncContext),
      vscode.workspace.onDidOpenTextDocument(syncContext),
      vscode.workspace.onDidChangeConfiguration((event) => {
        if (
          event.affectsConfiguration("localAgent.defaultWorkspaceRoot") ||
          event.affectsConfiguration("localAgent.runtimeUrl") ||
          event.affectsConfiguration("localAgent.requestTimeoutMs") ||
          event.affectsConfiguration("localAgent.dryRun") ||
          event.affectsConfiguration("localAgent.permissions.mode")
        ) {
          syncContext();
        }
      })
    );
  }

  private updateOptions(options?: AgentStudioPanelOptions): void {
    if (!options) {
      return;
    }

    this.options = options;
  }

  focusComposer(): void {
    this.postMessage({ type: "focus-input" });
  }

  async continueTerminalCommand(): Promise<void> {
    await this.handleSubmit("continue command output", "agent");
  }

  async stopTerminalCommand(): Promise<void> {
    await this.handleSubmit("stop running command", "agent");
  }

  async setPermissionMode(mode: PermissionMode): Promise<void> {
    const config = vscode.workspace.getConfiguration("localAgent");
    const target = vscode.workspace.workspaceFolders?.length
      ? vscode.ConfigurationTarget.Workspace
      : vscode.ConfigurationTarget.Global;
    await config.update("permissions.mode", mode, target);

    this.addTrace("context", "permissions.mode", {
      mode,
      source: "studio"
    });

    this.postMessage({ type: "permission-mode", mode });
    this.postMessage({
      type: "status-announcement",
      text: `Approval mode set to ${permissionModeLabel(mode)}.`
    });
  }

  async openLatestDiffEditor(): Promise<void> {
    const snapshot = this.latestDiffSnapshot;
    if (!snapshot || !snapshot.truncatedDiff.trim()) {
      void vscode.window.showInformationMessage(
        "Local Agent Studio: no workspace diff is available yet."
      );
      return;
    }

    const document = await vscode.workspace.openTextDocument({
      content: snapshot.truncatedDiff,
      language: "diff"
    });

    await vscode.window.showTextDocument(document, {
      preview: false,
      preserveFocus: false,
      viewColumn: vscode.ViewColumn.Beside
    });
  }

  async acceptLatestDiffSnapshot(): Promise<void> {
    const snapshot = this.latestDiffSnapshot;
    if (!snapshot || snapshot.isEmpty || snapshot.files.length === 0) {
      void vscode.window.showInformationMessage(
        "Local Agent Studio: no workspace diff is available to accept."
      );
      return;
    }

    const files = uniqueDiffPaths(snapshot);
    const confirmation = await vscode.window.showInformationMessage(
      `Stage ${files.length} file(s) from the latest diff snapshot?`,
      { modal: true },
      "Accept and Stage"
    );
    if (confirmation !== "Accept and Stage") {
      return;
    }

    const addResult = await this.runCommandCapture(
      "git",
      ["-C", snapshot.workspaceRoot, "add", "--", ...files],
      snapshot.workspaceRoot,
      22000
    );

    if (addResult.exitCode !== 0) {
      throw new Error(addResult.stderr || "Failed to stage diff snapshot files.");
    }

    this.addTrace("diff", "workspace.diff.accept", {
      summary: snapshot.summary,
      files,
      action: "staged"
    });

    this.output.appendLine(`[diff] accepted snapshot and staged ${files.length} file(s)`);
    this.scheduleDiffCapture("accept");
    this.postMessage({
      type: "status-announcement",
      text: "Latest diff accepted and staged."
    });
  }

  async rejectLatestDiffSnapshot(): Promise<void> {
    const snapshot = this.latestDiffSnapshot;
    if (!snapshot || snapshot.isEmpty || snapshot.files.length === 0) {
      void vscode.window.showInformationMessage(
        "Local Agent Studio: no workspace diff is available to reject."
      );
      return;
    }

    const files = uniqueDiffPaths(snapshot);
    const confirmation = await vscode.window.showWarningMessage(
      `Discard local changes for ${files.length} file(s) from the latest diff snapshot?`,
      { modal: true },
      "Reject and Revert"
    );
    if (confirmation !== "Reject and Revert") {
      return;
    }

    const trackedFiles: string[] = [];
    const untrackedFiles: string[] = [];

    for (const filePath of files) {
      const statusResult = await this.runCommandCapture(
        "git",
        [
          "-C",
          snapshot.workspaceRoot,
          "status",
          "--porcelain",
          "--untracked-files=all",
          "--",
          filePath
        ],
        snapshot.workspaceRoot,
        8000
      );

      if (statusResult.exitCode !== 0) {
        throw new Error(statusResult.stderr || `Failed to inspect git status for ${filePath}.`);
      }

      const statusLine = statusResult.stdout.trim();
      if (statusLine.startsWith("??")) {
        untrackedFiles.push(filePath);
      } else {
        trackedFiles.push(filePath);
      }
    }

    if (trackedFiles.length > 0) {
      const restoreResult = await this.runCommandCapture(
        "git",
        [
          "-C",
          snapshot.workspaceRoot,
          "restore",
          "--staged",
          "--worktree",
          "--source=HEAD",
          "--",
          ...trackedFiles
        ],
        snapshot.workspaceRoot,
        25000
      );

      if (restoreResult.exitCode !== 0) {
        throw new Error(restoreResult.stderr || "Failed to revert tracked files.");
      }
    }

    for (const filePath of untrackedFiles) {
      const absolutePath = path.resolve(snapshot.workspaceRoot, filePath);
      await fs.rm(absolutePath, { force: true, recursive: true });
    }

    this.addTrace("diff", "workspace.diff.reject", {
      summary: snapshot.summary,
      trackedFiles,
      untrackedFiles,
      action: "reverted"
    });

    this.output.appendLine(
      `[diff] rejected snapshot and reverted ${files.length} file(s)`
    );
    this.scheduleDiffCapture("reject");
    this.postMessage({
      type: "status-announcement",
      text: "Latest diff rejected and reverted."
    });
  }

  startNewConversation(): void {
    this.currentSessionId = undefined;
    this.conversation = [];
    this.traces = [];
    this.latestDiffSnapshot = undefined;
    this.lastRawWorkspaceDiff = "";
    this.pendingAssistantMessageId = undefined;
    this.streamedTokenCount = 0;
    void vscode.commands.executeCommand("setContext", "localAgent.studioHasDiff", false);

    this.schedulePersist();

    this.postMessage({
      type: "history-sync",
      currentSessionId: this.currentSessionId ?? "",
      conversation: this.conversation,
      traces: this.traces
    });
    this.postHistorySessions();
    this.postMessage({ type: "status-announcement", text: "Conversation cleared." });
  }

  requestContextInsert(kind: ContextInsertKind): void {
    void this.handleContextInsert(kind, true);
  }

  private async hydrate(): Promise<void> {
    const context = await this.resolveSessionContext(false, this.mode, "");
    const workspaceKey = this.workspaceKeyForRoot(context?.snapshot.workspaceRoot ?? "");

    await this.loadState(workspaceKey);

    this.postMessage({
      type: "hydrate",
      mode: this.mode,
      context: context?.snapshot ?? null,
      outputChannelName: OUTPUT_CHANNEL_NAME,
      currentSessionId: this.currentSessionId ?? "",
      conversation: this.conversation,
      traces: this.traces
    });

    this.postHistorySessions(true);
    await this.refreshSessionHistory(context?.snapshot);

    // Ensure the strip reflects the latest editor/workspace even after hydrate async steps.
    await this.syncContextSnapshot();
  }

  private async syncContextSnapshot(): Promise<void> {
    const sessionContext = await this.resolveSessionContext(false, this.mode, "");

    this.postMessage({
      type: "context-sync",
      context: sessionContext?.snapshot ?? null
    });
  }

  private setMode(mode: SessionMode): void {
    this.mode = mode;
    this.schedulePersist();
    this.postMessage({ type: "mode", mode });
  }

  private async handleSubmit(prompt: string, mode: SessionMode): Promise<void> {
    const trimmedPrompt = prompt.trim();
    if (!trimmedPrompt) {
      return;
    }

    if (this.requestInFlight) {
      this.postMessage({
        type: "run-error",
        message: "A request is already running. Wait for it to finish before sending another prompt."
      });
      return;
    }

    this.requestInFlight = true;
    void vscode.commands.executeCommand("setContext", "localAgent.studioBusy", true);
    this.mode = mode;
    this.postMessage({ type: "busy", busy: true });

    const sessionContext = await this.resolveSessionContext(true, mode, trimmedPrompt);
    if (!sessionContext) {
      this.requestInFlight = false;
      this.postMessage({ type: "busy", busy: false });
      return;
    }

    const { payload, snapshot } = sessionContext;
    await this.switchWorkspaceIfNeeded(snapshot.workspaceRoot);
    void this.refreshSessionHistory(snapshot);
    this.startDiffStreaming(snapshot.workspaceRoot);

    const client = new RuntimeClient(snapshot.runtimeUrl, snapshot.timeoutMs);

    const userMessage = this.appendConversation("user", trimmedPrompt, "default");
    const assistantMessage = this.appendConversation("assistant", "Thinking...", "default");
    this.pendingAssistantMessageId = assistantMessage.id;
    this.streamedTokenCount = 0;

    this.addTrace("request", "runtime.request", {
      prompt: trimmedPrompt,
      sessionId: payload.sessionId || "(new)",
      startNewSession: Boolean(payload.startNewSession),
      context: {
        workspaceRoot: payload.context.workspaceRoot,
        activeFilePath: payload.context.activeFilePath,
        selectedText: truncateText(payload.context.selectedText, MAX_SELECTED_TEXT_PREVIEW_CHARS)
      },
      settings: payload.settings
    });

    this.output.show(true);
    this.output.appendLine(`[mode] ${mode}`);
    this.output.appendLine(`[request] ${trimmedPrompt}`);

    this.postMessage({
      type: "run-started",
      mode,
      prompt: trimmedPrompt,
      context: snapshot,
      userMessageId: userMessage.id,
      assistantMessageId: assistantMessage.id
    });

    try {
      let wroteTokenLine = false;
      let response: AgentResponse;

      try {
        response = await client.runStream(payload, {
          onStatus: (status) => {
            this.output.appendLine(`[status] ${status}`);
            this.addTrace("status", `status.${status}`, { status });
            this.postMessage({ type: "stream-status", status });
          },
          onPlan: (step: PlanStep) => {
            this.output.appendLine(`[plan] ${step.step}. ${step.title} (${step.status})`);
            this.addTrace("plan", `plan.${step.step}`, step);
            this.scheduleDiffCapture("plan");
            this.postMessage({ type: "stream-plan", step });
          },
          onObservation: (observation: Observation) => {
            this.output.appendLine(`[obs] ${observation.source}: ${observation.message}`);
            this.addTrace("observation", observation.source || "observation", observation);
            this.scheduleDiffCapture(`observation:${observation.source || "runtime"}`);
            this.postMessage({ type: "stream-observation", observation });
          },
          onToken: (token) => {
            if (!wroteTokenLine) {
              this.output.append("[stream] ");
              wroteTokenLine = true;
            }

            this.output.append(token);
            this.appendAssistantToken(assistantMessage.id, token);
            this.postMessage({
              type: "stream-token",
              token,
              assistantMessageId: assistantMessage.id
            });
          },
          onDone: () => {
            if (wroteTokenLine) {
              this.output.appendLine("");
            }
          }
        });
      } catch (streamError) {
        const streamMessage =
          streamError instanceof Error ? streamError.message : String(streamError);
        this.output.appendLine(`[stream-error] ${streamMessage}`);
        this.output.appendLine("[stream-error] falling back to non-streaming endpoint");
        this.addTrace("fallback", "runtime.stream_fallback", { message: streamMessage });
        this.postMessage({
          type: "stream-fallback",
          message: streamMessage
        });
        response = await client.run(payload);
      }

      this.output.appendLine(`[status] ${response.status}`);
      this.output.appendLine(`[durationMs] ${response.durationMs}`);
      this.output.appendLine(`[final] ${response.finalMessage}`);

      if (response.sessionId?.trim()) {
        this.currentSessionId = response.sessionId.trim();
        this.output.appendLine(`[session] ${this.currentSessionId}`);
        this.postHistorySessions();
      }

      this.finalizeAssistantMessage(assistantMessage.id, response.finalMessage);
      this.addTrace("result", "runtime.result", {
        status: response.status,
        durationMs: response.durationMs,
        finalMessage: response.finalMessage,
        planCount: response.plan.length,
        observationCount: response.observations.length
      });
      this.scheduleDiffCapture("run-complete");

      this.postMessage({
        type: "run-complete",
        response,
        assistantMessageId: assistantMessage.id
      });

      void this.refreshSessionHistory(snapshot);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.output.appendLine(`[error] ${message}`);
      this.setAssistantMessage(assistantMessage.id, message, "error");
      this.addTrace("error", "runtime.error", { message });
      this.scheduleDiffCapture("run-error");
      this.postMessage({
        type: "run-error",
        message,
        assistantMessageId: assistantMessage.id
      });
    } finally {
      this.requestInFlight = false;
      this.pendingAssistantMessageId = undefined;
      this.schedulePersist();
      this.postMessage({ type: "busy", busy: false });
      void vscode.commands.executeCommand("setContext", "localAgent.studioBusy", false);
    }
  }

  private startDiffStreaming(workspaceRoot: string): void {
    this.diffStreamingWorkspaceRoot = workspaceRoot;
    this.lastRawWorkspaceDiff = "";
    this.latestDiffSnapshot = undefined;
    void vscode.commands.executeCommand("setContext", "localAgent.studioHasDiff", false);
    this.scheduleDiffCapture("run-started");
  }

  private scheduleDiffCapture(reason: string): void {
    this.diffCapturePendingReason = reason;

    if (!this.diffStreamingWorkspaceRoot) {
      return;
    }

    if (this.diffCaptureTimer) {
      return;
    }

    this.diffCaptureTimer = setTimeout(() => {
      this.diffCaptureTimer = undefined;
      void this.captureWorkspaceDiff();
    }, 240);
  }

  private async captureWorkspaceDiff(): Promise<void> {
    if (this.diffCaptureInFlight) {
      return;
    }

    const workspaceRoot = this.diffStreamingWorkspaceRoot;
    if (!workspaceRoot) {
      return;
    }

    this.diffCaptureInFlight = true;
    const reason = this.diffCapturePendingReason ?? "update";
    this.diffCapturePendingReason = undefined;

    try {
      const diffResult = await this.runCommandCapture(
        "git",
        ["-C", workspaceRoot, "diff", "--no-color"],
        workspaceRoot,
        15000
      );

      if (diffResult.exitCode !== 0) {
        return;
      }

      const rawDiff = diffResult.stdout.trimEnd();
      if (rawDiff === this.lastRawWorkspaceDiff) {
        return;
      }

      this.lastRawWorkspaceDiff = rawDiff;

      const snapshot = createWorkspaceDiffSnapshot(workspaceRoot, rawDiff, reason, createId);
      this.latestDiffSnapshot = snapshot;

      void vscode.commands.executeCommand(
        "setContext",
        "localAgent.studioHasDiff",
        !snapshot.isEmpty
      );

      this.addTrace("diff", `workspace.diff.${reason}`, {
        summary: snapshot.summary,
        files: snapshot.files.map((file) => ({
          path: file.path,
          additions: file.additions,
          deletions: file.deletions,
          hunks: file.hunkCount
        })),
        diff: snapshot.truncatedDiff
      });

      this.options?.onDiffSnapshot?.(snapshot);
    } finally {
      this.diffCaptureInFlight = false;

      if (this.diffCapturePendingReason) {
        this.scheduleDiffCapture(this.diffCapturePendingReason);
      }
    }
  }

  private async handleContextInsert(kind: ContextInsertKind, showErrors: boolean): Promise<void> {
    this.postMessage({ type: "insert-context-pending", kind, pending: true });

    try {
      const block = await this.buildContextInsert(kind);

      this.addTrace("context", `context.${kind}`, {
        label: block.label,
        source: block.source,
        contentPreview: truncateText(block.content, 1800)
      });

      this.postMessage({
        type: "insert-context-result",
        kind,
        ok: true,
        label: block.label,
        content: block.content
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.addTrace("error", `context.${kind}.error`, { message });

      this.postMessage({
        type: "insert-context-result",
        kind,
        ok: false,
        error: message
      });

      if (showErrors) {
        void vscode.window.showWarningMessage(`Local Agent Studio: ${message}`);
      }
    } finally {
      this.postMessage({ type: "insert-context-pending", kind, pending: false });
    }
  }

  private async buildContextInsert(kind: ContextInsertKind): Promise<ContextInsertBlock> {
    switch (kind) {
      case "activeSymbol":
        return this.buildActiveSymbolContext();
      case "gitDiff":
        return this.buildGitDiffContext();
      case "failingTests":
        return this.buildFailingTestsContext();
      default:
        throw new Error("Unsupported context insert kind.");
    }
  }

  private async buildActiveSymbolContext(): Promise<ContextInsertBlock> {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      throw new Error("Open a file to insert active symbol context.");
    }

    const document = editor.document;
    const cursor = editor.selection.active;
    const selectionText = !editor.selection.isEmpty ? document.getText(editor.selection).trim() : "";

    const symbols =
      (await vscode.commands.executeCommand<vscode.DocumentSymbol[]>(
        "vscode.executeDocumentSymbolProvider",
        document.uri
      )) ?? [];

    const activeSymbol = findDeepestSymbol(symbols, cursor);

    let snippet = selectionText;
    if (!snippet && activeSymbol) {
      snippet = document.getText(activeSymbol.range).trim();
    }

    if (!snippet) {
      const currentLine = document.lineAt(cursor.line);
      snippet = currentLine.text.trim();
    }

    const wordRange = document.getWordRangeAtPosition(cursor);
    const fallbackWord = wordRange ? document.getText(wordRange) : "(none)";

    const symbolName = activeSymbol?.name ?? fallbackWord;
    const symbolKind = activeSymbol ? vscode.SymbolKind[activeSymbol.kind] : "Unknown";

    return {
      label: "Context: Active Symbol",
      source: "vscode.executeDocumentSymbolProvider",
      content: [
        `File: ${document.uri.fsPath}`,
        `Symbol: ${symbolName} (${symbolKind})`,
        `Line: ${cursor.line + 1}`,
        "",
        truncateText(snippet, MAX_CONTEXT_CHARS)
      ].join("\n")
    };
  }

  private async buildGitDiffContext(): Promise<ContextInsertBlock> {
    const workspaceRoot = await this.resolveWorkspaceRootForContextInsert();

    const unstaged = await this.runCommandCapture(
      "git",
      ["-C", workspaceRoot, "diff", "--no-color"],
      workspaceRoot,
      15000
    );

    if (unstaged.exitCode !== 0) {
      throw new Error(unstaged.stderr || "Unable to read git diff for this workspace.");
    }

    let diff = unstaged.stdout.trim();

    if (!diff) {
      const staged = await this.runCommandCapture(
        "git",
        ["-C", workspaceRoot, "diff", "--staged", "--no-color"],
        workspaceRoot,
        15000
      );

      if (staged.exitCode === 0) {
        diff = staged.stdout.trim();
      }
    }

    const body = diff || "No staged or unstaged changes detected.";

    return {
      label: "Context: Git Diff",
      source: "git diff",
      content: [`Workspace: ${workspaceRoot}`, "", truncateText(body, MAX_CONTEXT_CHARS)].join(
        "\n"
      )
    };
  }

  private async buildFailingTestsContext(): Promise<ContextInsertBlock> {
    const workspaceRoot = await this.resolveWorkspaceRootForContextInsert();
    const testCommand = await this.detectTestCommand(workspaceRoot);

    const result = await this.runCommandCapture(
      testCommand.command,
      testCommand.args,
      workspaceRoot,
      TEST_TIMEOUT_MS
    );

    const combinedOutput = [result.stdout, result.stderr].filter(Boolean).join("\n");
    const failingExcerpt = extractFailingTestExcerpt(combinedOutput);

    let summary = "";
    if (result.timedOut) {
      summary = "Test command timed out before completing.";
    } else if (failingExcerpt) {
      summary = failingExcerpt;
    } else if (result.exitCode === 0) {
      summary = "No failing tests detected in this run.";
    } else {
      summary =
        "Test command failed, but no standard failure markers were found.\n" +
        truncateText(combinedOutput, 2600);
    }

    return {
      label: "Context: Failing Tests",
      source: testCommand.label,
      content: [
        `Workspace: ${workspaceRoot}`,
        `Command: ${testCommand.label}`,
        `Exit Code: ${result.exitCode}`,
        "",
        truncateText(summary, MAX_CONTEXT_CHARS)
      ].join("\n")
    };
  }

  private async detectTestCommand(workspaceRoot: string): Promise<TestCommandSpec> {
    if (await pathExists(path.join(workspaceRoot, "go.mod"))) {
      return {
        command: "go",
        args: ["test", "./..."],
        label: "go test ./..."
      };
    }

    const packageJsonPath = path.join(workspaceRoot, "package.json");
    if (await pathExists(packageJsonPath)) {
      try {
        const packageJsonRaw = await fs.readFile(packageJsonPath, "utf8");
        const parsed = JSON.parse(packageJsonRaw) as {
          scripts?: Record<string, unknown>;
        };
        const testScript = parsed.scripts?.test;

        if (typeof testScript === "string" && !/no test specified/i.test(testScript)) {
          const hasPnpmLock = await pathExists(path.join(workspaceRoot, "pnpm-lock.yaml"));
          const hasYarnLock = await pathExists(path.join(workspaceRoot, "yarn.lock"));

          if (hasPnpmLock) {
            return {
              command: "pnpm",
              args: ["test", "--", "--watch=false"],
              label: "pnpm test -- --watch=false"
            };
          }

          if (hasYarnLock) {
            return {
              command: "yarn",
              args: ["test", "--watch=false"],
              label: "yarn test --watch=false"
            };
          }

          return {
            command: "npm",
            args: ["test", "--", "--watch=false"],
            label: "npm test -- --watch=false"
          };
        }
      } catch {
        // Ignore parse failures and continue to other strategies.
      }
    }

    if (
      (await pathExists(path.join(workspaceRoot, "pytest.ini"))) ||
      (await pathExists(path.join(workspaceRoot, "pyproject.toml")))
    ) {
      return {
        command: "pytest",
        args: ["-q"],
        label: "pytest -q"
      };
    }

    throw new Error("No supported test command detected for this workspace.");
  }

  private async runCommandCapture(
    command: string,
    args: string[],
    cwd: string,
    timeoutMs: number
  ): Promise<CommandCaptureResult> {
    const commandLine = [command, ...args].join(" ");

    try {
      const { stdout, stderr } = await execFileAsync(command, args, {
        cwd,
        timeout: timeoutMs,
        maxBuffer: 1024 * 1024 * 6,
        encoding: "utf8"
      });

      return {
        commandLine,
        exitCode: 0,
        stdout: typeof stdout === "string" ? stdout : String(stdout),
        stderr: typeof stderr === "string" ? stderr : String(stderr),
        timedOut: false
      };
    } catch (error) {
      const execError = error as NodeJS.ErrnoException & {
        stdout?: string;
        stderr?: string;
        code?: number | string;
        killed?: boolean;
      };

      return {
        commandLine,
        exitCode: typeof execError.code === "number" ? execError.code : -1,
        stdout: typeof execError.stdout === "string" ? execError.stdout : "",
        stderr:
          typeof execError.stderr === "string"
            ? execError.stderr
            : execError.message || "Command execution failed.",
        timedOut: Boolean(execError.killed)
      };
    }
  }

  private async copyPayload(payload: string): Promise<void> {
    try {
      await vscode.env.clipboard.writeText(payload);
      this.postMessage({ type: "payload-copy-result", ok: true });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.postMessage({ type: "payload-copy-result", ok: false, message });
    }
  }

  private postHistorySessions(loading = false, error?: string): void {
    this.postMessage({
      type: "history-sessions",
      sessions: this.sessionHistory,
      currentSessionId: this.currentSessionId ?? "",
      loading,
      error: error?.trim() ?? ""
    });
  }

  private async refreshSessionHistory(
    snapshot?: StudioContextSnapshot
  ): Promise<void> {
    const resolvedSnapshot =
      snapshot ?? (await this.resolveSessionContext(false, this.mode, ""))?.snapshot;

    if (!resolvedSnapshot || !resolvedSnapshot.workspaceRoot.trim()) {
      this.sessionHistory = [];
      this.postHistorySessions(false, "Workspace context is unavailable.");
      return;
    }

    const client = new RuntimeClient(resolvedSnapshot.runtimeUrl, resolvedSnapshot.timeoutMs);
    this.postHistorySessions(true);

    try {
      this.sessionHistory = await client.listSessions(
        resolvedSnapshot.workspaceRoot,
        MAX_HISTORY_SESSIONS
      );
      this.postHistorySessions(false);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.output.appendLine(`[history] ${message}`);
      this.postHistorySessions(false, message);
    }
  }

  private async loadSessionFromHistory(sessionId: string): Promise<void> {
    if (this.requestInFlight) {
      this.postHistorySessions(false);
      this.postMessage({
        type: "status-announcement",
        text: "Wait for the running request to finish before loading a past session."
      });
      return;
    }

    const normalizedSessionID = sessionId.trim();
    if (!normalizedSessionID) {
      this.postHistorySessions(false);
      return;
    }

    const sessionContext = await this.resolveSessionContext(false, this.mode, "");
    if (!sessionContext) {
      this.postHistorySessions(false, "Workspace context is unavailable.");
      return;
    }

    const { snapshot } = sessionContext;
    const client = new RuntimeClient(snapshot.runtimeUrl, snapshot.timeoutMs);
    this.postHistorySessions(true);

    try {
      const [messages, responses] = await Promise.all([
        client.listSessionMessages(normalizedSessionID, MAX_HISTORY_MESSAGES),
        client.listSessionResponses(normalizedSessionID, MAX_TRACE_ENTRIES)
      ]);

      this.currentSessionId = normalizedSessionID;
      this.conversation = messages
        .map((message) => this.mapSessionMessageToConversation(message))
        .slice(-MAX_CONVERSATION_ENTRIES);
      this.traces = responses.responses
        .map((response) => this.mapSessionResponseToTrace(response))
        .slice(-MAX_TRACE_ENTRIES);
      this.pendingAssistantMessageId = undefined;
      this.streamedTokenCount = 0;
      this.latestDiffSnapshot = undefined;
      this.lastRawWorkspaceDiff = "";
      void vscode.commands.executeCommand("setContext", "localAgent.studioHasDiff", false);

      this.schedulePersist();
      this.postMessage({
        type: "history-sync",
        currentSessionId: this.currentSessionId ?? "",
        conversation: this.conversation,
        traces: this.traces
      });
      this.postHistorySessions(false);
      this.postMessage({
        type: "status-announcement",
        text: `Loaded session ${shortSessionID(normalizedSessionID)}.`
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.output.appendLine(`[history] ${message}`);
      this.postHistorySessions(false, message);
      this.postMessage({
        type: "status-announcement",
        text: "Failed to load session history from runtime."
      });
    }
  }

  private async renameSessionFromHistory(sessionId: string, title: string): Promise<void> {
    if (this.requestInFlight) {
      this.postHistorySessions(false);
      this.postMessage({
        type: "status-announcement",
        text: "Wait for the running request to finish before renaming a session."
      });
      return;
    }

    const normalizedSessionID = sessionId.trim();
    const normalizedTitle = title.trim();
    if (!normalizedSessionID || !normalizedTitle) {
      this.postHistorySessions(false);
      return;
    }

    const sessionContext = await this.resolveSessionContext(false, this.mode, "");
    if (!sessionContext) {
      this.postHistorySessions(false, "Workspace context is unavailable.");
      return;
    }

    const { snapshot } = sessionContext;
    const client = new RuntimeClient(snapshot.runtimeUrl, snapshot.timeoutMs);
    this.postHistorySessions(true);

    try {
      await client.renameSession(normalizedSessionID, normalizedTitle);
      await this.refreshSessionHistory(snapshot);
      this.postMessage({
        type: "status-announcement",
        text: `Renamed session ${shortSessionID(normalizedSessionID)}.`
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.output.appendLine(`[history] ${message}`);
      this.postHistorySessions(false, message);
      this.postMessage({
        type: "status-announcement",
        text: "Failed to rename session."
      });
    }
  }

  private async deleteSessionFromHistory(sessionId: string): Promise<void> {
    if (this.requestInFlight) {
      this.postHistorySessions(false);
      this.postMessage({
        type: "status-announcement",
        text: "Wait for the running request to finish before deleting a session."
      });
      return;
    }

    const normalizedSessionID = sessionId.trim();
    if (!normalizedSessionID) {
      this.postHistorySessions(false);
      return;
    }

    const sessionContext = await this.resolveSessionContext(false, this.mode, "");
    if (!sessionContext) {
      this.postHistorySessions(false, "Workspace context is unavailable.");
      return;
    }

    const { snapshot } = sessionContext;
    const client = new RuntimeClient(snapshot.runtimeUrl, snapshot.timeoutMs);
    this.postHistorySessions(true);

    try {
      await client.deleteSession(normalizedSessionID);

      if (this.currentSessionId === normalizedSessionID) {
        this.currentSessionId = undefined;
        this.conversation = [];
        this.traces = [];
        this.pendingAssistantMessageId = undefined;
        this.streamedTokenCount = 0;
        this.latestDiffSnapshot = undefined;
        this.lastRawWorkspaceDiff = "";
        void vscode.commands.executeCommand("setContext", "localAgent.studioHasDiff", false);

        this.schedulePersist();
        this.postMessage({
          type: "history-sync",
          currentSessionId: "",
          conversation: this.conversation,
          traces: this.traces
        });
      }

      await this.refreshSessionHistory(snapshot);
      this.postMessage({
        type: "status-announcement",
        text: `Deleted session ${shortSessionID(normalizedSessionID)}.`
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.output.appendLine(`[history] ${message}`);
      this.postHistorySessions(false, message);
      this.postMessage({
        type: "status-announcement",
        text: "Failed to delete session."
      });
    }
  }

  private mapSessionMessageToConversation(message: SessionMessage): StudioConversationEntry {
    const role: ConversationRole = message.role === "user" ? "user" : "assistant";
    const createdAt = Date.parse(message.createdAt);

    return {
      id: `session-msg-${message.id}`,
      role,
      text: message.content,
      variant: "default",
      createdAt: Number.isFinite(createdAt) ? createdAt : Date.now()
    };
  }

  private mapSessionResponseToTrace(response: SessionAPIResponse): StudioTraceCard {
    const createdAt = Date.parse(response.createdAt);
    const kind: TraceKind = response.status === "error" ? "error" : "result";
    const payload = {
      sessionId: response.sessionId,
      requestId: response.requestId,
      status: response.status,
      durationMs: response.durationMs,
      provider: response.provider,
      finalMessage: response.finalMessage
    };

    return {
      id: `session-response-${response.id}`,
      kind,
      title: `history.${response.status || "result"}`,
      preview: toPayloadPreview(toPayloadText(payload)),
      payload: toPayloadText(payload),
      createdAt: Number.isFinite(createdAt) ? createdAt : Date.now()
    };
  }

  private async switchWorkspaceIfNeeded(workspaceRoot: string): Promise<void> {
    const workspaceKey = this.workspaceKeyForRoot(workspaceRoot);
    if (workspaceKey === this.activeWorkspaceKey) {
      return;
    }

    await this.loadState(workspaceKey);
    this.sessionHistory = [];

    this.postMessage({
      type: "history-sync",
      currentSessionId: this.currentSessionId ?? "",
      conversation: this.conversation,
      traces: this.traces
    });
    this.postHistorySessions(true);
  }

  private appendConversation(
    role: ConversationRole,
    text: string,
    variant: ConversationVariant
  ): StudioConversationEntry {
    const entry: StudioConversationEntry = {
      id: createId("msg"),
      role,
      text,
      variant,
      createdAt: Date.now()
    };

    this.conversation.push(entry);
    if (this.conversation.length > MAX_CONVERSATION_ENTRIES) {
      this.conversation = this.conversation.slice(-MAX_CONVERSATION_ENTRIES);
    }

    this.schedulePersist();
    return entry;
  }

  private setAssistantMessage(
    messageId: string,
    text: string,
    variant: ConversationVariant
  ): void {
    const entry = this.findConversationEntry(messageId);
    if (!entry) {
      return;
    }

    entry.text = text;
    entry.variant = variant;
    this.schedulePersist();
  }

  private appendAssistantToken(messageId: string, token: string): void {
    const entry = this.findConversationEntry(messageId);
    if (!entry) {
      return;
    }

    if (entry.text === "Thinking...") {
      entry.text = "";
    }

    entry.text += token;
    this.streamedTokenCount += 1;

    if (this.streamedTokenCount % 24 === 0) {
      this.schedulePersist();
    }
  }

  private finalizeAssistantMessage(messageId: string, finalMessage: string): void {
    const entry = this.findConversationEntry(messageId);
    if (!entry) {
      return;
    }

    if (this.streamedTokenCount === 0 || !entry.text.trim()) {
      entry.text = finalMessage || "Completed.";
    }

    entry.variant = "default";
    this.schedulePersist();
  }

  private findConversationEntry(messageId: string): StudioConversationEntry | undefined {
    return this.conversation.find((item) => item.id === messageId);
  }

  private addTrace(kind: TraceKind, title: string, payload: unknown): void {
    const payloadText = toPayloadText(payload);

    const trace: StudioTraceCard = {
      id: createId("trace"),
      kind,
      title,
      preview: toPayloadPreview(payloadText),
      payload: payloadText,
      createdAt: Date.now()
    };

    this.traces.push(trace);
    if (this.traces.length > MAX_TRACE_ENTRIES) {
      this.traces = this.traces.slice(-MAX_TRACE_ENTRIES);
    }

    this.schedulePersist();
    this.postMessage({ type: "trace-add", trace });
  }

  private schedulePersist(): void {
    if (this.persistTimer) {
      clearTimeout(this.persistTimer);
    }

    this.persistTimer = setTimeout(() => {
      void this.persistState();
    }, 200);
  }

  private async loadState(workspaceKey: string): Promise<void> {
    this.activeWorkspaceKey = workspaceKey;

    const stored = this.extensionContext.workspaceState.get<PersistedStudioState>(
      this.storageKey(workspaceKey)
    );

    if (!stored || stored.version !== STORAGE_VERSION) {
      this.currentSessionId = undefined;
      this.conversation = [];
      this.traces = [];
      this.latestDiffSnapshot = undefined;
      void vscode.commands.executeCommand("setContext", "localAgent.studioHasDiff", false);
      return;
    }

    this.conversation = Array.isArray(stored.conversation)
      ? stored.conversation.filter(isConversationEntry).slice(-MAX_CONVERSATION_ENTRIES)
      : [];

    this.traces = Array.isArray(stored.traces)
      ? stored.traces.filter(isTraceEntry).slice(-MAX_TRACE_ENTRIES)
      : [];

    this.currentSessionId =
      typeof stored.currentSessionId === "string" && stored.currentSessionId.trim()
        ? stored.currentSessionId.trim()
        : undefined;

    this.latestDiffSnapshot = isDiffSnapshot(stored.latestDiffSnapshot)
      ? stored.latestDiffSnapshot
      : undefined;

    void vscode.commands.executeCommand(
      "setContext",
      "localAgent.studioHasDiff",
      Boolean(this.latestDiffSnapshot && !this.latestDiffSnapshot.isEmpty)
    );
  }

  private async persistState(): Promise<void> {
    if (this.persistTimer) {
      clearTimeout(this.persistTimer);
      this.persistTimer = undefined;
    }

    const payload: PersistedStudioState = {
      version: STORAGE_VERSION,
      mode: this.mode,
      currentSessionId: this.currentSessionId,
      conversation: this.conversation,
      traces: this.traces,
      latestDiffSnapshot: this.latestDiffSnapshot,
      updatedAt: Date.now()
    };

    await this.extensionContext.workspaceState.update(
      this.storageKey(this.activeWorkspaceKey),
      payload
    );
  }

  private storageKey(workspaceKey: string): string {
    return `${STORAGE_PREFIX}${workspaceKey}`;
  }

  private workspaceKeyForRoot(workspaceRoot: string): string {
    const trimmed = workspaceRoot.trim();
    return trimmed ? path.normalize(trimmed) : GLOBAL_WORKSPACE_KEY;
  }

  private async resolveSessionContext(
    allowRootPicker: boolean,
    mode: SessionMode,
    prompt: string
  ): Promise<ResolvedSessionContext | undefined> {
    const editor = vscode.window.activeTextEditor;
    const selectedText =
      editor && !editor.selection.isEmpty
        ? editor.document.getText(editor.selection)
        : "";

    const activeFilePath = editor?.document.uri.fsPath ?? "";
    const config = vscode.workspace.getConfiguration("localAgent");
    const configuredDefaultRoot = config.get<string>("defaultWorkspaceRoot", "").trim();

    const workspaceRoot = await this.resolveWorkspaceRoot(
      activeFilePath,
      configuredDefaultRoot,
      allowRootPicker
    );

    if (!workspaceRoot) {
      if (allowRootPicker) {
        void vscode.window.showErrorMessage(
          "Local Agent needs a project root. Open a folder or select one when prompted."
        );
      }
      return undefined;
    }

    const runtimeUrl = config.get<string>("runtimeUrl", "http://127.0.0.1:8080");
    const timeoutMs = config.get<number>("requestTimeoutMs", 120000);
    const dryRun = config.get<boolean>("dryRun", false);
    const permissionMode = normalizePermissionMode(
      config.get<string>("permissions.mode", "defaultApproval")
    );
    const permissionPolicy = {
      allowedCommands: readStringArraySetting(config, "permissions.allowedCommands"),
      blockedCommands: readStringArraySetting(config, "permissions.blockedCommands"),
      allowedMcps: readStringArraySetting(config, "permissions.allowedMcps"),
      blockedMcps: readStringArraySetting(config, "permissions.blockedMcps")
    };

    const snapshot: StudioContextSnapshot = {
      workspaceRoot,
      activeFilePath,
      hasSelection: selectedText.trim().length > 0,
      selectionPreview: toSelectionPreview(selectedText),
      runtimeUrl,
      timeoutMs,
      dryRun,
      permissionMode
    };

    return {
      payload: {
        prompt,
        sessionId: this.currentSessionId,
        startNewSession: !this.currentSessionId,
        context: {
          workspaceRoot,
          activeFilePath,
          selectedText
        },
        settings: {
          maxSteps: 6,
          dryRun,
          mode,
          permissionMode,
          permissionPolicy
        }
      },
      snapshot
    };
  }

  private async resolveWorkspaceRootForContextInsert(): Promise<string> {
    const editor = vscode.window.activeTextEditor;
    const activeFilePath = editor?.document.uri.fsPath ?? "";
    const config = vscode.workspace.getConfiguration("localAgent");
    const configuredDefaultRoot = config.get<string>("defaultWorkspaceRoot", "").trim();

    const workspaceRoot = await this.resolveWorkspaceRoot(
      activeFilePath,
      configuredDefaultRoot,
      true
    );

    if (!workspaceRoot) {
      throw new Error("A workspace root is required for this context shortcut.");
    }

    return workspaceRoot;
  }

  private async resolveWorkspaceRoot(
    activeFilePath: string,
    configuredDefaultRoot: string,
    allowRootPicker: boolean
  ): Promise<string> {
    let workspaceRoot = "";

    const assignWorkspaceRoot = (candidate: string | undefined): void => {
      if (workspaceRoot) {
        return;
      }

      const normalized = String(candidate || "").trim();
      if (!normalized) {
        return;
      }

      workspaceRoot = path.normalize(normalized);
    };

    const activeEditorUri = vscode.window.activeTextEditor?.document.uri;
    if (activeEditorUri) {
      assignWorkspaceRoot(vscode.workspace.getWorkspaceFolder(activeEditorUri)?.uri.fsPath);
    }

    if (!workspaceRoot && activeFilePath) {
      assignWorkspaceRoot(vscode.workspace.getWorkspaceFolder(vscode.Uri.file(activeFilePath))?.uri.fsPath);
    }

    if (!workspaceRoot) {
      assignWorkspaceRoot(vscode.workspace.workspaceFolders?.[0]?.uri.fsPath);
    }

    if (!workspaceRoot && this.activeWorkspaceKey !== GLOBAL_WORKSPACE_KEY) {
      assignWorkspaceRoot(this.activeWorkspaceKey);
    }

    if (!workspaceRoot && configuredDefaultRoot) {
      assignWorkspaceRoot(configuredDefaultRoot);
    }

    if (!workspaceRoot && activeFilePath) {
      assignWorkspaceRoot(path.dirname(activeFilePath));
    }

    if (!workspaceRoot && allowRootPicker) {
      const pickedFolder = await vscode.window.showOpenDialog({
        canSelectFiles: false,
        canSelectFolders: true,
        canSelectMany: false,
        openLabel: "Select Project Root"
      });

      if (pickedFolder && pickedFolder.length > 0) {
        assignWorkspaceRoot(pickedFolder[0].fsPath);
      }
    }

    if (!workspaceRoot) {
      // Final fallback so the studio always has *some* root to operate from
      // (used during hydrate / context strip rendering when no folder is open).
      workspaceRoot = os.homedir();
    }

    return path.normalize(workspaceRoot);
  }

  private postMessage(message: unknown): void {
    if (!this.webviewReady) {
      this.queuedMessages.push(message);
      return;
    }

    void this.panel.webview.postMessage(message);
  }

  private flushQueuedMessages(): void {
    if (!this.webviewReady || this.queuedMessages.length === 0) {
      return;
    }

    const queued = [...this.queuedMessages];
    this.queuedMessages = [];

    for (const message of queued) {
      void this.panel.webview.postMessage(message);
    }
  }

  private getHtml(initialMode: SessionMode): string {
    const nonce = createNonce();

    return `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta
      http-equiv="Content-Security-Policy"
      content="default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}';"
    />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Local Agent Studio</title>
    <style nonce="${nonce}">
      ${renderStudioStyles()}
    </style>
  </head>
  <body>
    ${renderStudioShell()}

    <script nonce="${nonce}">
      ${renderStudioClientScript(initialMode)}
    </script>
  </body>
</html>`;
  }
}

function isConversationEntry(value: unknown): value is StudioConversationEntry {
  if (!value || typeof value !== "object") {
    return false;
  }

  const entry = value as Record<string, unknown>;
  return (
    typeof entry.id === "string" &&
    (entry.role === "user" || entry.role === "assistant") &&
    typeof entry.text === "string" &&
    (entry.variant === "default" || entry.variant === "error") &&
    typeof entry.createdAt === "number"
  );
}

function isTraceEntry(value: unknown): value is StudioTraceCard {
  if (!value || typeof value !== "object") {
    return false;
  }

  const trace = value as Record<string, unknown>;
  return (
    typeof trace.id === "string" &&
    typeof trace.kind === "string" &&
    typeof trace.title === "string" &&
    typeof trace.preview === "string" &&
    typeof trace.payload === "string" &&
    typeof trace.createdAt === "number"
  );
}

function isDiffFileChange(value: unknown): value is StudioDiffFileChange {
  if (!value || typeof value !== "object") {
    return false;
  }

  const entry = value as Record<string, unknown>;
  return (
    typeof entry.path === "string" &&
    typeof entry.additions === "number" &&
    typeof entry.deletions === "number" &&
    typeof entry.hunkCount === "number" &&
    typeof entry.preview === "string"
  );
}

function isDiffSnapshot(value: unknown): value is StudioDiffSnapshot {
  if (!value || typeof value !== "object") {
    return false;
  }

  const snapshot = value as Record<string, unknown>;
  return (
    typeof snapshot.id === "string" &&
    typeof snapshot.workspaceRoot === "string" &&
    typeof snapshot.reason === "string" &&
    typeof snapshot.generatedAt === "number" &&
    typeof snapshot.summary === "string" &&
    typeof snapshot.truncatedDiff === "string" &&
    Array.isArray(snapshot.files) &&
    snapshot.files.every(isDiffFileChange) &&
    typeof snapshot.isEmpty === "boolean"
  );
}

function findDeepestSymbol(
  symbols: vscode.DocumentSymbol[],
  position: vscode.Position
): vscode.DocumentSymbol | undefined {
  let match: vscode.DocumentSymbol | undefined;

  for (const symbol of symbols) {
    if (!symbol.range.contains(position)) {
      continue;
    }

    const childMatch = findDeepestSymbol(symbol.children, position);
    match = childMatch ?? symbol;
  }

  return match;
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

function createId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 9)}`;
}

function createNonce(): string {
  const possibleChars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let nonce = "";

  for (let index = 0; index < 32; index += 1) {
    nonce += possibleChars.charAt(Math.floor(Math.random() * possibleChars.length));
  }

  return nonce;
}
