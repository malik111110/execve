import * as childProcess from "node:child_process";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { promisify } from "node:util";
import * as vscode from "vscode";
import { RuntimeClient } from "./runtimeClient";
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

const execFileAsync = promisify(childProcess.execFile);

type SessionMode = "agent" | "chat" | "plan";

export type ContextInsertKind = "activeSymbol" | "gitDiff" | "failingTests";

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

export interface StudioDiffFileChange {
  path: string;
  additions: number;
  deletions: number;
  hunkCount: number;
  preview: string;
}

export interface StudioDiffSnapshot {
  id: string;
  workspaceRoot: string;
  reason: string;
  generatedAt: number;
  summary: string;
  truncatedDiff: string;
  files: StudioDiffFileChange[];
  isEmpty: boolean;
}

export interface AgentStudioPanelOptions {
  onDiffSnapshot?: (snapshot: StudioDiffSnapshot) => void;
}

type StudioIncomingMessage =
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
  | { type: "focusInput" };

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
const MAX_PAYLOAD_PREVIEW_CHARS = 220;
const MAX_PAYLOAD_TEXT_CHARS = 16000;
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
          await this.handleSubmit(message.prompt, message.mode);
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
        default:
          return;
      }
    });
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

      const snapshot = createWorkspaceDiffSnapshot(workspaceRoot, rawDiff, reason);
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
      summary = "Test command failed, but no standard failure markers were found.\n" + truncateText(combinedOutput, 2600);
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
    let workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? "";

    if (!workspaceRoot && activeFilePath) {
      workspaceRoot = path.dirname(activeFilePath);
    }

    if (!workspaceRoot && configuredDefaultRoot) {
      workspaceRoot = configuredDefaultRoot;
    }

    if (!workspaceRoot && allowRootPicker) {
      const pickedFolder = await vscode.window.showOpenDialog({
        canSelectFiles: false,
        canSelectFolders: true,
        canSelectMany: false,
        openLabel: "Select Project Root"
      });

      if (pickedFolder && pickedFolder.length > 0) {
        workspaceRoot = pickedFolder[0].fsPath;
      }
    }

    return workspaceRoot;
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
      :root {
        --canvas: radial-gradient(circle at 15% 15%, #fff2da 0%, transparent 45%),
          radial-gradient(circle at 80% 0%, #b9d2c4 0%, transparent 35%),
          linear-gradient(160deg, #f6efe3 0%, #e8eee9 55%, #dfebe5 100%);
        --panel: rgba(255, 255, 255, 0.72);
        --panel-edge: rgba(16, 54, 53, 0.24);
        --ink: #182324;
        --muted: #4c5d5f;
        --accent: #c45334;
        --accent-alt: #0c6268;
        --ok: #2c7455;
        --warn: #a9522c;
        --error: #9d2f34;
        --mono: "IBM Plex Mono", "SFMono-Regular", Menlo, Consolas, monospace;
        --display: "Space Grotesk", "Avenir Next", "Trebuchet MS", sans-serif;
      }

      * {
        box-sizing: border-box;
      }

      html,
      body {
        margin: 0;
        height: 100%;
        color: var(--ink);
        background: var(--canvas);
        font-family: var(--display);
      }

      body {
        padding: 16px;
      }

      .shell {
        display: grid;
        grid-template-rows: auto auto auto minmax(320px, 1fr) auto;
        gap: 12px;
        height: calc(100vh - 32px);
      }

      .glass {
        background: var(--panel);
        border: 1px solid var(--panel-edge);
        border-radius: 16px;
        backdrop-filter: blur(8px);
        box-shadow: 0 8px 28px rgba(13, 34, 36, 0.08);
      }

      .masthead {
        padding: 14px;
        display: flex;
        justify-content: space-between;
        align-items: center;
        gap: 12px;
      }

      .brand {
        display: flex;
        align-items: center;
        gap: 10px;
      }

      .mark {
        width: 36px;
        height: 36px;
        border-radius: 11px;
        background: linear-gradient(145deg, var(--accent), #eb8f65);
        color: #fff7f2;
        font-size: 18px;
        font-weight: 700;
        display: flex;
        align-items: center;
        justify-content: center;
      }

      .title {
        font-size: 17px;
        font-weight: 700;
        letter-spacing: 0.2px;
      }

      .subtitle {
        font-size: 12px;
        color: var(--muted);
      }

      .header-actions {
        display: flex;
        flex-wrap: wrap;
        justify-content: flex-end;
        align-items: center;
        gap: 8px;
      }

      .control-stack {
        display: inline-flex;
        align-items: center;
        gap: 8px;
      }

      .toolbar-btn {
        border: 1px solid rgba(76, 93, 95, 0.3);
        background: rgba(255, 255, 255, 0.76);
        color: var(--muted);
        border-radius: 10px;
        font-family: var(--display);
        font-size: 11px;
        font-weight: 700;
        padding: 7px 11px;
        cursor: pointer;
      }

      .toolbar-btn.stop {
        border-color: rgba(157, 47, 52, 0.34);
        color: var(--error);
      }

      .approval-picker {
        display: inline-flex;
        align-items: center;
        gap: 8px;
        border: 1px solid rgba(76, 93, 95, 0.26);
        border-radius: 10px;
        background: rgba(255, 255, 255, 0.74);
        padding: 5px 8px;
      }

      .approval-picker .picker-label {
        font-size: 11px;
        font-weight: 700;
        color: var(--muted);
      }

      .approval-picker select {
        border: 1px solid rgba(76, 93, 95, 0.32);
        border-radius: 7px;
        background: rgba(255, 255, 255, 0.96);
        color: var(--ink);
        font-size: 11px;
        font-family: var(--display);
        font-weight: 600;
        padding: 4px 6px;
      }

      .status-line {
        display: flex;
        align-items: center;
        gap: 8px;
      }

      .status-pill {
        border-radius: 999px;
        padding: 5px 10px;
        border: 1px solid rgba(12, 98, 104, 0.28);
        color: var(--accent-alt);
        background: rgba(12, 98, 104, 0.09);
        font-size: 12px;
        font-weight: 600;
      }

      .dot {
        width: 9px;
        height: 9px;
        border-radius: 999px;
        background: var(--ok);
        box-shadow: 0 0 0 6px rgba(44, 116, 85, 0.14);
      }

      .segment {
        display: inline-flex;
        background: rgba(255, 255, 255, 0.74);
        border: 1px solid rgba(76, 93, 95, 0.25);
        border-radius: 999px;
        padding: 3px;
        gap: 4px;
      }

      .segment button {
        border: none;
        border-radius: 999px;
        padding: 8px 14px;
        background: transparent;
        color: var(--muted);
        font-family: var(--display);
        font-size: 12px;
        font-weight: 700;
        cursor: pointer;
      }

      .segment button.active {
        background: linear-gradient(140deg, var(--accent), #df734d);
        color: #ffffff;
      }

      .context {
        padding: 12px;
        display: grid;
        grid-template-columns: repeat(4, minmax(0, 1fr));
        gap: 10px;
      }

      .workspace-grid {
        min-height: 0;
        display: grid;
        grid-template-columns: minmax(220px, 0.42fr) minmax(0, 1fr);
        gap: 12px;
      }

      .session-stack {
        min-height: 0;
        display: grid;
        grid-template-rows: minmax(180px, 1fr) minmax(160px, 0.8fr);
        gap: 12px;
      }

      .history-panel {
        min-height: 0;
        padding: 12px;
        display: grid;
        grid-template-rows: auto auto auto minmax(0, 1fr);
        gap: 10px;
      }

      .history-head {
        display: flex;
        justify-content: space-between;
        align-items: flex-start;
        gap: 10px;
      }

      .history-title {
        font-size: 12px;
        font-weight: 700;
        color: var(--muted);
        letter-spacing: 0.5px;
        text-transform: uppercase;
      }

      .history-meta {
        font-size: 11px;
        color: var(--muted);
      }

      .history-search {
        border: 1px solid rgba(76, 93, 95, 0.26);
        border-radius: 10px;
        background: rgba(255, 255, 255, 0.76);
        padding: 7px 9px;
      }

      .history-search input {
        width: 100%;
        border: none;
        background: transparent;
        color: var(--ink);
        font-size: 12px;
        font-family: var(--display);
      }

      .history-search input:focus {
        outline: none;
      }

      .history-empty {
        font-size: 12px;
        color: var(--muted);
        padding: 10px;
        border: 1px dashed rgba(76, 93, 95, 0.28);
        border-radius: 10px;
        background: rgba(255, 255, 255, 0.55);
      }

      .history-list {
        overflow: auto;
        display: flex;
        flex-direction: column;
        gap: 10px;
      }

      .history-group {
        display: grid;
        gap: 7px;
      }

      .history-group-title {
        font-size: 10px;
        color: var(--muted);
        text-transform: uppercase;
        letter-spacing: 0.55px;
        font-weight: 700;
      }

      .history-item {
        border: 1px solid rgba(76, 93, 95, 0.26);
        border-radius: 12px;
        background: rgba(255, 255, 255, 0.86);
        padding: 9px;
        display: grid;
        gap: 5px;
        cursor: pointer;
      }

      .history-item.active {
        border-color: rgba(12, 98, 104, 0.44);
        box-shadow: inset 0 0 0 1px rgba(12, 98, 104, 0.2);
        background: rgba(235, 247, 246, 0.96);
      }

      .history-item.disabled {
        opacity: 0.68;
        cursor: default;
      }

      .history-item-row {
        display: flex;
        justify-content: space-between;
        align-items: baseline;
        gap: 8px;
      }

      .history-item-title {
        font-size: 12px;
        font-weight: 700;
        color: var(--ink);
        line-height: 1.25;
      }

      .history-item-time {
        font-size: 10px;
        color: var(--muted);
        font-family: var(--mono);
        white-space: nowrap;
      }

      .history-item-meta {
        font-size: 10px;
        color: var(--muted);
        text-transform: uppercase;
        letter-spacing: 0.4px;
      }

      .history-item-preview {
        font-size: 11px;
        color: #2b3a3b;
        line-height: 1.35;
        border-left: 2px solid rgba(12, 98, 104, 0.32);
        padding-left: 7px;
      }

      .history-item-actions {
        display: flex;
        justify-content: flex-end;
        gap: 6px;
      }

      .history-action-btn {
        border: 1px solid rgba(76, 93, 95, 0.28);
        border-radius: 8px;
        background: rgba(255, 255, 255, 0.92);
        color: var(--muted);
        font-size: 10px;
        font-weight: 700;
        padding: 4px 7px;
        cursor: pointer;
      }

      .history-action-btn.danger {
        border-color: rgba(157, 47, 52, 0.3);
        color: var(--error);
      }

      .history-action-btn:disabled {
        opacity: 0.55;
        cursor: default;
      }

      .card {
        border-radius: 12px;
        border: 1px solid rgba(76, 93, 95, 0.2);
        background: rgba(255, 255, 255, 0.82);
        padding: 10px;
      }

      .label {
        font-size: 10px;
        color: var(--muted);
        text-transform: uppercase;
        letter-spacing: 0.9px;
        margin-bottom: 5px;
      }

      .value {
        font-size: 12px;
        line-height: 1.4;
        word-break: break-word;
      }

      .conversation {
        padding: 12px;
        overflow: auto;
        display: flex;
        flex-direction: column;
        gap: 10px;
      }

      .plan-board {
        padding: 12px;
        display: grid;
        gap: 8px;
      }

      .plan-header {
        display: flex;
        justify-content: space-between;
        align-items: center;
        gap: 8px;
      }

      .plan-title {
        font-size: 12px;
        font-weight: 700;
        color: var(--muted);
        letter-spacing: 0.5px;
        text-transform: uppercase;
      }

      .plan-empty {
        font-size: 12px;
        color: var(--muted);
        padding: 8px 10px;
        border: 1px dashed rgba(76, 93, 95, 0.28);
        border-radius: 10px;
        background: rgba(255, 255, 255, 0.55);
      }

      .plan-list {
        margin: 0;
        padding-left: 18px;
        display: grid;
        gap: 7px;
      }

      .plan-item {
        display: flex;
        justify-content: space-between;
        align-items: center;
        gap: 10px;
        font-size: 12px;
      }

      .plan-step {
        line-height: 1.4;
        color: var(--ink);
      }

      .plan-badge {
        border-radius: 999px;
        font-size: 10px;
        font-weight: 700;
        letter-spacing: 0.4px;
        padding: 4px 8px;
        text-transform: uppercase;
      }

      .plan-badge.pending {
        border: 1px solid rgba(169, 82, 44, 0.35);
        color: var(--warn);
        background: rgba(169, 82, 44, 0.1);
      }

      .plan-badge.in_progress {
        border: 1px solid rgba(12, 98, 104, 0.36);
        color: var(--accent-alt);
        background: rgba(12, 98, 104, 0.11);
      }

      .plan-badge.completed {
        border: 1px solid rgba(44, 116, 85, 0.36);
        color: var(--ok);
        background: rgba(44, 116, 85, 0.11);
      }

      .bubble {
        max-width: 85%;
        padding: 10px 12px;
        border-radius: 14px;
        border: 1px solid rgba(76, 93, 95, 0.2);
        white-space: pre-wrap;
        line-height: 1.45;
        font-size: 13px;
      }

      .bubble.user {
        margin-left: auto;
        background: linear-gradient(145deg, #ffe1cf 0%, #ffd4bc 100%);
        border-color: rgba(196, 83, 52, 0.35);
      }

      .bubble.assistant {
        margin-right: auto;
        background: rgba(255, 255, 255, 0.84);
      }

      .bubble.assistant.error {
        border-color: rgba(157, 47, 52, 0.4);
        background: rgba(255, 232, 233, 0.95);
      }

      .trace-wrap {
        padding: 12px;
        overflow: hidden;
        display: grid;
        grid-template-rows: auto minmax(0, 1fr);
      }

      .trace-head {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 8px;
      }

      .trace-title {
        font-size: 12px;
        font-weight: 700;
        color: var(--muted);
        letter-spacing: 0.5px;
        text-transform: uppercase;
      }

      .trace-list {
        margin-top: 8px;
        overflow: auto;
        display: flex;
        flex-direction: column;
        gap: 8px;
      }

      .trace-empty {
        font-size: 12px;
        color: var(--muted);
        padding: 10px;
        border: 1px dashed rgba(76, 93, 95, 0.28);
        border-radius: 10px;
        background: rgba(255, 255, 255, 0.55);
      }

      .trace-card {
        border: 1px solid rgba(76, 93, 95, 0.25);
        border-radius: 12px;
        background: rgba(255, 255, 255, 0.82);
        padding: 9px 10px;
        display: grid;
        gap: 6px;
      }

      .trace-card.error {
        border-color: rgba(157, 47, 52, 0.42);
      }

      .trace-card.fallback {
        border-color: rgba(169, 82, 44, 0.45);
      }

      .trace-row {
        display: flex;
        justify-content: space-between;
        align-items: baseline;
        gap: 10px;
      }

      .trace-name {
        font-size: 12px;
        font-weight: 700;
      }

      .trace-meta {
        font-family: var(--mono);
        font-size: 10px;
        color: var(--muted);
      }

      .trace-preview {
        border-left: 3px solid rgba(12, 98, 104, 0.38);
        padding-left: 8px;
        font-family: var(--mono);
        font-size: 11px;
        white-space: pre-wrap;
        line-height: 1.4;
        color: #233335;
      }

      .trace-actions {
        display: flex;
        justify-content: flex-end;
      }

      .copy-btn {
        border: 1px solid rgba(12, 98, 104, 0.28);
        border-radius: 8px;
        background: rgba(255, 255, 255, 0.92);
        color: var(--accent-alt);
        font-size: 11px;
        font-weight: 700;
        padding: 5px 9px;
        cursor: pointer;
      }

      .trace-details summary {
        cursor: pointer;
        color: var(--muted);
        font-size: 11px;
        font-weight: 700;
      }

      .trace-details pre {
        margin: 8px 0 0;
        max-height: 180px;
        overflow: auto;
        font-family: var(--mono);
        font-size: 11px;
        line-height: 1.35;
        background: rgba(250, 252, 251, 0.95);
        border: 1px solid rgba(76, 93, 95, 0.18);
        border-radius: 8px;
        padding: 8px;
        white-space: pre-wrap;
        word-break: break-word;
      }

      .composer {
        padding: 12px;
        display: grid;
        gap: 10px;
      }

      .follow-up-card {
        border: 1px solid rgba(12, 98, 104, 0.28);
        border-radius: 12px;
        background: rgba(255, 255, 255, 0.82);
        padding: 10px;
        display: grid;
        gap: 8px;
      }

      .follow-up-title {
        font-size: 12px;
        font-weight: 700;
        color: var(--accent-alt);
      }

      .follow-up-list {
        display: flex;
        flex-wrap: wrap;
        gap: 7px;
      }

      .follow-up-item {
        border: 1px solid rgba(12, 98, 104, 0.32);
        border-radius: 999px;
        background: rgba(255, 255, 255, 0.95);
        color: var(--accent-alt);
        font-size: 11px;
        font-weight: 700;
        padding: 6px 10px;
        cursor: pointer;
      }

      .quick-row,
      .context-row {
        display: flex;
        flex-wrap: wrap;
        gap: 8px;
      }

      .quick,
      .context-btn {
        border: 1px solid rgba(12, 98, 104, 0.22);
        border-radius: 999px;
        background: rgba(255, 255, 255, 0.82);
        color: var(--accent-alt);
        font-size: 11px;
        font-weight: 700;
        padding: 6px 10px;
        cursor: pointer;
      }

      .context-btn.pending {
        color: var(--warn);
        border-color: rgba(169, 82, 44, 0.45);
      }

      .input-row {
        display: grid;
        grid-template-columns: minmax(0, 1fr) auto;
        gap: 10px;
      }

      textarea {
        resize: vertical;
        min-height: 86px;
        max-height: 200px;
        border-radius: 12px;
        border: 1px solid rgba(76, 93, 95, 0.34);
        padding: 10px;
        font-size: 13px;
        font-family: var(--display);
        background: rgba(255, 255, 255, 0.9);
        color: var(--ink);
      }

      textarea:focus {
        outline: 2px solid rgba(196, 83, 52, 0.3);
        outline-offset: 1px;
      }

      .send {
        align-self: end;
        border: none;
        border-radius: 12px;
        background: linear-gradient(145deg, var(--accent-alt), #15929b);
        color: #ffffff;
        min-width: 108px;
        height: 46px;
        font-weight: 700;
        font-family: var(--display);
        cursor: pointer;
      }

      .send[disabled],
      textarea[disabled],
      .quick[disabled],
      .context-btn[disabled],
      .toolbar-btn[disabled],
      .approval-picker select[disabled] {
        opacity: 0.58;
        cursor: default;
      }

      @media (max-width: 920px) {
        .context {
          grid-template-columns: repeat(2, minmax(0, 1fr));
        }

        .workspace-grid {
          grid-template-columns: minmax(0, 1fr);
          grid-template-rows: auto minmax(0, 1fr);
        }

        .history-panel {
          max-height: 260px;
        }
      }

      @media (max-width: 640px) {
        body {
          padding: 10px;
        }

        .shell {
          height: calc(100vh - 20px);
          grid-template-rows: auto auto auto minmax(220px, 1fr) auto;
        }

        .masthead {
          flex-direction: column;
          align-items: flex-start;
        }

        .context {
          grid-template-columns: minmax(0, 1fr);
        }

        .bubble {
          max-width: 100%;
        }

        .session-stack {
          grid-template-rows: minmax(180px, 1fr) minmax(150px, 0.75fr);
        }

        .input-row {
          grid-template-columns: minmax(0, 1fr);
        }

        .send {
          width: 100%;
        }
      }
    </style>
  </head>
  <body>
    <div class="shell">
      <header class="masthead glass">
        <div class="brand">
          <div class="mark">LA</div>
          <div>
            <div class="title">Local Agent Studio</div>
            <div class="subtitle">Rich prompt workspace for local model execution</div>
          </div>
        </div>
        <div class="header-actions">
          <button id="continue-command" class="toolbar-btn" type="button">Continue Cmd</button>
          <button id="stop-command" class="toolbar-btn stop" type="button">Stop Cmd</button>
          <button id="open-latest-diff" class="toolbar-btn" type="button">Open Latest Diff</button>
          <button id="accept-latest-diff" class="toolbar-btn" type="button">Accept Diff</button>
          <button id="reject-latest-diff" class="toolbar-btn" type="button">Reject Diff</button>
          <button id="new-conversation" class="toolbar-btn" type="button">New Conversation</button>
          <div class="control-stack">
            <label class="approval-picker" for="approval-mode">
              <span class="picker-label">Approvals</span>
              <select id="approval-mode" aria-label="Approval mode">
                <option value="defaultApproval">Default Approvals</option>
                <option value="bypassApproval">Bypass Approvals</option>
                <option value="autopilot">Autopilot</option>
              </select>
            </label>
            <div class="status-line">
              <div class="dot" aria-hidden="true"></div>
              <div class="status-pill" id="status-pill">Idle</div>
              <div class="segment" role="tablist" aria-label="Session mode">
                <button id="mode-agent" role="tab" data-mode="agent">Agent</button>
                <button id="mode-chat" role="tab" data-mode="chat">Chat</button>
                <button id="mode-plan" role="tab" data-mode="plan">Plan</button>
              </div>
            </div>
          </div>
        </div>
      </header>

      <section class="context glass" aria-label="Session context">
        <article class="card">
          <div class="label">Workspace</div>
          <div class="value" id="context-workspace">Not resolved yet</div>
        </article>
        <article class="card">
          <div class="label">Active File</div>
          <div class="value" id="context-file">None</div>
        </article>
        <article class="card">
          <div class="label">Selection</div>
          <div class="value" id="context-selection">No active selection</div>
        </article>
        <article class="card">
          <div class="label">Runtime</div>
          <div class="value" id="context-runtime">Not connected</div>
        </article>
      </section>

      <section class="plan-board glass" aria-label="Todo plan">
        <div class="plan-header">
          <div class="plan-title">Todo Plan</div>
          <div class="subtitle">Live plan status from runtime stream</div>
        </div>
        <div id="plan-empty" class="plan-empty">No plan steps yet. Switch to Plan mode to generate structured todos.</div>
        <ol id="plan-list" class="plan-list"></ol>
      </section>

      <section class="workspace-grid" aria-label="Session workspace">
        <aside class="history-panel glass" aria-label="Session history">
          <div class="history-head">
            <div>
              <div class="history-title">History</div>
              <div class="subtitle">Recent sessions for this workspace</div>
            </div>
            <button id="refresh-history" class="toolbar-btn" type="button">Refresh</button>
          </div>
          <label class="history-search" for="history-search">
            <input
              id="history-search"
              type="text"
              placeholder="Search sessions"
              autocomplete="off"
              spellcheck="false"
            />
          </label>
          <div id="history-meta" class="history-meta">Loading sessions...</div>
          <div id="history-list" class="history-list" aria-live="polite">
            <div id="history-empty" class="history-empty">No sessions yet. Start a conversation to populate history.</div>
          </div>
        </aside>

        <div class="session-stack">
          <section id="conversation" class="conversation glass" aria-label="Conversation transcript"></section>

          <section class="trace-wrap glass">
            <div class="trace-head">
              <div class="trace-title">Tool Trace</div>
              <div class="subtitle">Collapsible payload cards with copy actions</div>
            </div>
            <div id="trace-list" class="trace-list" aria-live="polite">
              <div id="trace-empty" class="trace-empty">No trace entries yet. Run a prompt to capture runtime activity.</div>
            </div>
          </section>
        </div>
      </section>

      <form id="composer" class="composer glass">
        <div id="follow-up-panel" class="follow-up-card" hidden>
          <div class="follow-up-title">Clarifications Needed</div>
          <div class="subtitle">Click a question to insert it into the composer and answer it.</div>
          <div id="follow-up-list" class="follow-up-list"></div>
        </div>
        <div class="quick-row">
          <button type="button" class="quick" data-quick="Analyze the currently selected code and suggest improvements.">Analyze Selection</button>
          <button type="button" class="quick" data-quick="Plan a safe refactor for the active file and list potential risks.">Plan Refactor</button>
          <button type="button" class="quick" data-quick="Explain the architecture of this project in practical terms.">Explain Architecture</button>
        </div>
        <div class="context-row">
          <button type="button" class="context-btn" data-context-kind="activeSymbol">Insert Active Symbol</button>
          <button type="button" class="context-btn" data-context-kind="gitDiff">Insert Git Diff</button>
          <button type="button" class="context-btn" data-context-kind="failingTests">Insert Failing Tests</button>
        </div>
        <div class="input-row">
          <textarea id="prompt" placeholder="Describe what you want the local agent to do..."></textarea>
          <button id="send" class="send" type="submit">Run</button>
        </div>
      </form>
    </div>

    <script nonce="${nonce}">
      (() => {
        const vscode = acquireVsCodeApi();

        const state = {
          mode: ${JSON.stringify(initialMode)},
          permissionMode: "defaultApproval",
          busy: false,
          assistantMessageId: null,
          activeSessionId: null,
          statusResetTimer: null,
          traceIds: new Set(),
          planSteps: [],
          followUpQuestions: [],
          historySessions: [],
          historyLoading: false,
          historyError: "",
          historyFilterQuery: ""
        };

        const statusPill = document.getElementById("status-pill");
        const conversation = document.getElementById("conversation");
        const traceList = document.getElementById("trace-list");
        const traceEmpty = document.getElementById("trace-empty");
        const promptInput = document.getElementById("prompt");
        const sendButton = document.getElementById("send");
        const planList = document.getElementById("plan-list");
        const planEmpty = document.getElementById("plan-empty");
        const followUpPanel = document.getElementById("follow-up-panel");
        const followUpList = document.getElementById("follow-up-list");
        const newConversationButton = document.getElementById("new-conversation");
        const continueCommandButton = document.getElementById("continue-command");
        const stopCommandButton = document.getElementById("stop-command");
        const openLatestDiffButton = document.getElementById("open-latest-diff");
        const acceptLatestDiffButton = document.getElementById("accept-latest-diff");
        const rejectLatestDiffButton = document.getElementById("reject-latest-diff");
        const refreshHistoryButton = document.getElementById("refresh-history");
        const historySearchInput = document.getElementById("history-search");
        const historyMeta = document.getElementById("history-meta");
        const historyList = document.getElementById("history-list");
        const historyEmpty = document.getElementById("history-empty");
        const approvalModeSelect = document.getElementById("approval-mode");

        const modeButtons = {
          agent: document.getElementById("mode-agent"),
          chat: document.getElementById("mode-chat"),
          plan: document.getElementById("mode-plan")
        };

        const contextFields = {
          workspace: document.getElementById("context-workspace"),
          file: document.getElementById("context-file"),
          selection: document.getElementById("context-selection"),
          runtime: document.getElementById("context-runtime")
        };

        const quickButtons = Array.from(document.querySelectorAll(".quick"));
        const contextButtons = Array.from(document.querySelectorAll(".context-btn"));

        function setStatus(text) {
          statusPill.textContent = text;
        }

        function pulseStatus(text) {
          setStatus(text);

          if (state.statusResetTimer) {
            clearTimeout(state.statusResetTimer);
          }

          state.statusResetTimer = setTimeout(() => {
            if (!state.busy) {
              setStatus("Idle");
            }
          }, 1300);
        }

        function scrollToBottom(container) {
          container.scrollTop = container.scrollHeight;
        }

        function findBubbleById(messageId) {
          if (!messageId) {
            return null;
          }

          const bubbles = conversation.querySelectorAll(".bubble");
          for (const bubble of bubbles) {
            if (bubble.dataset.messageId === messageId) {
              return bubble;
            }
          }

          return null;
        }

        function createBubble(role, text, messageId, variant) {
          const bubble = document.createElement("article");
          bubble.className = "bubble " + role;
          bubble.textContent = text;

          if (messageId) {
            bubble.dataset.messageId = messageId;
          }

          if (role === "assistant" && variant === "error") {
            bubble.classList.add("error");
          }

          conversation.appendChild(bubble);
          scrollToBottom(conversation);
          return bubble;
        }

        function upsertAssistantMessage(messageId, text, variant, append) {
          let bubble = findBubbleById(messageId);
          if (!bubble) {
            bubble = createBubble("assistant", "", messageId, variant);
          }

          if (append) {
            if (bubble.textContent === "Thinking...") {
              bubble.textContent = "";
            }
            bubble.textContent += text;
          } else {
            bubble.textContent = text;
          }

          bubble.classList.toggle("error", variant === "error");
          state.assistantMessageId = messageId || state.assistantMessageId;
          scrollToBottom(conversation);
        }

        function normalizePlanStatus(status) {
          const normalized = String(status || "pending").toLowerCase();

          if (normalized === "in_progress") {
            return "in_progress";
          }

          if (normalized === "completed" || normalized === "done") {
            return "completed";
          }

          return "pending";
        }

        function planStatusLabel(status) {
          if (status === "in_progress") {
            return "In Progress";
          }

          if (status === "completed") {
            return "Completed";
          }

          return "Pending";
        }

        function renderPlan() {
          planList.innerHTML = "";

          if (!Array.isArray(state.planSteps) || state.planSteps.length === 0) {
            planEmpty.style.display = "block";
            return;
          }

          planEmpty.style.display = "none";

          state.planSteps
            .slice()
            .sort((left, right) => left.step - right.step)
            .forEach((step) => {
              const item = document.createElement("li");
              item.className = "plan-item";

              const label = document.createElement("span");
              label.className = "plan-step";
              label.textContent = step.step + ". " + String(step.title || "Untitled step");

              const badge = document.createElement("span");
              badge.className = "plan-badge " + step.status;
              badge.textContent = planStatusLabel(step.status);

              item.appendChild(label);
              item.appendChild(badge);
              planList.appendChild(item);
            });
        }

        function clearPlan() {
          state.planSteps = [];
          renderPlan();
        }

        function upsertPlanStep(step) {
          const index = Number(step && step.step);
          if (!Number.isFinite(index) || index <= 0) {
            return;
          }

          const normalized = {
            step: index,
            title: String((step && step.title) || "Untitled step"),
            status: normalizePlanStatus(step && step.status)
          };

          const existingIndex = state.planSteps.findIndex((candidate) => candidate.step === index);
          if (existingIndex >= 0) {
            state.planSteps[existingIndex] = normalized;
          } else {
            state.planSteps.push(normalized);
          }

          renderPlan();
        }

        function parseFollowUpQuestions(messageText) {
          const text = String(messageText || "");
          if (!text.trim()) {
            return [];
          }

          const lines = text
            .split(/\r?\n/)
            .map((line) => line.trim())
            .filter(Boolean);

          const bulletQuestions = lines
            .filter((line) => line.startsWith("- "))
            .map((line) => line.slice(2).trim())
            .filter((line) => line.length > 0);

          if (bulletQuestions.length > 0) {
            return bulletQuestions;
          }

          const numberedQuestions = lines
            .map((line) => {
              const match = /^\d+[.)]\s+(.+)$/.exec(line);
              return match ? match[1].trim() : "";
            })
            .filter((line) => line.length > 0);

          return numberedQuestions;
        }

        function renderFollowUpPanel() {
          followUpList.innerHTML = "";

          if (!Array.isArray(state.followUpQuestions) || state.followUpQuestions.length === 0) {
            followUpPanel.hidden = true;
            return;
          }

          followUpPanel.hidden = false;
          state.followUpQuestions.forEach((question) => {
            const item = document.createElement("button");
            item.type = "button";
            item.className = "follow-up-item";
            item.textContent = question;
            item.addEventListener("click", () => {
              const current = promptInput.value.trim();
              const prefix = current.length > 0 ? "\n" : "";
              promptInput.value = promptInput.value + prefix + "- " + question + "\n  Answer: ";
              promptInput.focus();
              promptInput.selectionStart = promptInput.selectionEnd = promptInput.value.length;
            });
            followUpList.appendChild(item);
          });
        }

        function setFollowUpQuestions(questions) {
          const normalized = Array.isArray(questions)
            ? questions.map((question) => String(question || "").trim()).filter(Boolean)
            : [];

          state.followUpQuestions = normalized;
          renderFollowUpPanel();
        }

        function clearFollowUpQuestions() {
          state.followUpQuestions = [];
          renderFollowUpPanel();
        }

        function setMode(mode) {
          const normalized = mode === "chat" || mode === "plan" ? mode : "agent";
          state.mode = normalized;
          modeButtons.agent.classList.toggle("active", normalized === "agent");
          modeButtons.chat.classList.toggle("active", normalized === "chat");
          modeButtons.plan.classList.toggle("active", normalized === "plan");
          promptInput.placeholder =
            normalized === "agent"
              ? "Describe what you want the local agent to do..."
              : normalized === "plan"
                ? "Describe the goal and constraints to generate a step-by-step todo plan..."
                : "Ask a question or discuss an implementation approach...";
        }

        function isPermissionMode(mode) {
          return (
            mode === "defaultApproval" ||
            mode === "bypassApproval" ||
            mode === "autopilot"
          );
        }

        function permissionModeLabel(mode) {
          if (mode === "bypassApproval") {
            return "Bypass Approvals";
          }

          if (mode === "autopilot") {
            return "Autopilot";
          }

          return "Default Approvals";
        }

        function setPermissionMode(mode) {
          const normalized = isPermissionMode(mode) ? mode : "defaultApproval";
          state.permissionMode = normalized;

          if (approvalModeSelect && approvalModeSelect.value !== normalized) {
            approvalModeSelect.value = normalized;
          }

          const runtimeValue = String(contextFields.runtime.textContent || "");
          if (runtimeValue.includes(" | timeout ")) {
            const base = runtimeValue.split(" | approvals ")[0];
            contextFields.runtime.textContent =
              base + " | approvals " + permissionModeLabel(normalized);
          }
        }

        function setBusy(busy) {
          state.busy = busy;
          sendButton.disabled = busy;
          promptInput.disabled = busy;
          quickButtons.forEach((button) => {
            button.disabled = busy;
          });
          contextButtons.forEach((button) => {
            button.disabled = busy;
          });
          newConversationButton.disabled = busy;
          continueCommandButton.disabled = busy;
          stopCommandButton.disabled = busy;
          openLatestDiffButton.disabled = busy;
          acceptLatestDiffButton.disabled = busy;
          rejectLatestDiffButton.disabled = busy;
          refreshHistoryButton.disabled = busy || state.historyLoading;
          historySearchInput.disabled = busy;
          approvalModeSelect.disabled = busy;

          const historyItems = historyList.querySelectorAll(".history-item");
          historyItems.forEach((item) => {
            item.classList.toggle("disabled", Boolean(busy || state.historyLoading));
          });

          const historyActionButtons = historyList.querySelectorAll(".history-action-btn");
          historyActionButtons.forEach((button) => {
            button.disabled = Boolean(busy || state.historyLoading);
          });

          if (busy) {
            setStatus("Running");
          } else if (statusPill.textContent === "Running") {
            setStatus("Idle");
          }
        }

        function setContext(context) {
          if (!context) {
            return;
          }

          contextFields.workspace.textContent = context.workspaceRoot || "Not resolved";
          contextFields.file.textContent = context.activeFilePath || "No active file";
          contextFields.selection.textContent = context.hasSelection
            ? context.selectionPreview
            : "No active selection";

          const permissionMode = isPermissionMode(context.permissionMode)
            ? context.permissionMode
            : "defaultApproval";
          setPermissionMode(permissionMode);

          contextFields.runtime.textContent =
            context.runtimeUrl +
            " | timeout " +
            context.timeoutMs +
            "ms | dryRun " +
            context.dryRun +
            " | approvals " +
            permissionModeLabel(permissionMode);
        }

        function toHistoryTimeLabel(isoValue) {
          const parsed = Date.parse(String(isoValue || ""));
          if (!Number.isFinite(parsed)) {
            return "";
          }

          const date = new Date(parsed);
          return date.toLocaleString([], {
            month: "short",
            day: "numeric",
            hour: "2-digit",
            minute: "2-digit"
          });
        }

        function toHistoryGroup(isoValue) {
          const parsed = Date.parse(String(isoValue || ""));
          if (!Number.isFinite(parsed)) {
            return "Older";
          }

          const now = new Date();
          const startOfToday = new Date(
            now.getFullYear(),
            now.getMonth(),
            now.getDate()
          ).getTime();
          const startOfYesterday = startOfToday - 24 * 60 * 60 * 1000;

          if (parsed >= startOfToday) {
            return "Today";
          }

          if (parsed >= startOfYesterday) {
            return "Yesterday";
          }

          return "Older";
        }

        function toHistorySessionTitle(session) {
          const title = String(session && session.title ? session.title : "").trim();
          if (title) {
            return title;
          }

          const fallback = String(session && session.lastMessage ? session.lastMessage : "").trim();
          if (fallback) {
            return fallback;
          }

          return "Untitled session";
        }

        function toHistorySessionPreview(session) {
          const text = String(session && session.lastMessage ? session.lastMessage : "")
            .replace(/\s+/g, " ")
            .trim();

          if (!text) {
            return "No captured messages yet.";
          }

          return text.length > 140 ? text.slice(0, 137) + "..." : text;
        }

        function toHistorySessionSearchText(session) {
          const title = toHistorySessionTitle(session);
          const preview = toHistorySessionPreview(session);
          const mode = String(session && session.mode ? session.mode : "agent");
          return [title, preview, mode].join(" ").toLowerCase();
        }

        function requestOpenHistorySession(sessionId) {
          if (state.busy || state.historyLoading) {
            return;
          }

          state.activeSessionId = sessionId;
          state.historyLoading = true;
          state.historyError = "";
          renderHistorySessions();
          historyMeta.textContent = "Loading selected session...";

          vscode.postMessage({
            type: "openHistorySession",
            sessionId
          });
        }

        function createHistorySessionItem(session) {
          const sessionId = String(session && session.id ? session.id : "").trim();
          if (!sessionId) {
            return null;
          }

          const item = document.createElement("article");
          item.className = "history-item";
          item.dataset.sessionId = sessionId;
          if (state.activeSessionId && state.activeSessionId === sessionId) {
            item.classList.add("active");
          }

          const row = document.createElement("div");
          row.className = "history-item-row";

          const title = document.createElement("div");
          title.className = "history-item-title";
          title.textContent = toHistorySessionTitle(session);

          const time = document.createElement("div");
          time.className = "history-item-time";
          time.textContent = toHistoryTimeLabel(session && session.updatedAt);

          row.appendChild(title);
          row.appendChild(time);

          const mode = String(session && session.mode ? session.mode : "agent").toUpperCase();
          const count = Number(session && session.messageCount ? session.messageCount : 0);
          const meta = document.createElement("div");
          meta.className = "history-item-meta";
          meta.textContent = mode + " • " + count + " message" + (count === 1 ? "" : "s");

          const preview = document.createElement("div");
          preview.className = "history-item-preview";
          preview.textContent = toHistorySessionPreview(session);

          const actions = document.createElement("div");
          actions.className = "history-item-actions";

          const renameButton = document.createElement("button");
          renameButton.type = "button";
          renameButton.className = "history-action-btn";
          renameButton.textContent = "Rename";
          renameButton.disabled = Boolean(state.busy || state.historyLoading);
          renameButton.addEventListener("click", (event) => {
            event.stopPropagation();

            if (state.busy || state.historyLoading) {
              return;
            }

            const currentTitle = toHistorySessionTitle(session);
            const nextTitle = window.prompt("Rename session", currentTitle);
            if (nextTitle === null) {
              return;
            }

            const normalizedTitle = nextTitle.trim();
            if (!normalizedTitle || normalizedTitle === currentTitle) {
              return;
            }

            state.historyLoading = true;
            state.historyError = "";
            renderHistorySessions();
            historyMeta.textContent = "Renaming session...";

            vscode.postMessage({
              type: "renameHistorySession",
              sessionId,
              title: normalizedTitle
            });
          });

          const deleteButton = document.createElement("button");
          deleteButton.type = "button";
          deleteButton.className = "history-action-btn danger";
          deleteButton.textContent = "Delete";
          deleteButton.disabled = Boolean(state.busy || state.historyLoading);
          deleteButton.addEventListener("click", (event) => {
            event.stopPropagation();

            if (state.busy || state.historyLoading) {
              return;
            }

            const confirmed = window.confirm("Delete this session and its saved history?");
            if (!confirmed) {
              return;
            }

            state.historyLoading = true;
            state.historyError = "";
            renderHistorySessions();
            historyMeta.textContent = "Deleting session...";

            vscode.postMessage({
              type: "deleteHistorySession",
              sessionId
            });
          });

          actions.appendChild(renameButton);
          actions.appendChild(deleteButton);

          item.appendChild(row);
          item.appendChild(meta);
          item.appendChild(preview);
          item.appendChild(actions);

          if (state.busy || state.historyLoading) {
            item.classList.add("disabled");
          }

          item.addEventListener("click", () => {
            requestOpenHistorySession(sessionId);
          });

          return item;
        }

        function renderHistorySessions() {
          historyList.innerHTML = "";
          historyList.appendChild(historyEmpty);

          const sessions = Array.isArray(state.historySessions) ? state.historySessions : [];
          const normalizedQuery = String(state.historyFilterQuery || "").trim().toLowerCase();
          const filteredSessions = normalizedQuery
            ? sessions.filter((session) =>
                toHistorySessionSearchText(session).includes(normalizedQuery)
              )
            : sessions;

          if (!sessions.length) {
            historyEmpty.textContent = "No sessions yet. Start a conversation to populate history.";
            historyEmpty.style.display = "block";
          } else if (!filteredSessions.length) {
            historyEmpty.textContent = "No sessions match this search.";
            historyEmpty.style.display = "block";
          } else {
            historyEmpty.style.display = "none";

            const grouped = {
              Today: [],
              Yesterday: [],
              Older: []
            };

            filteredSessions.forEach((session) => {
              const group = toHistoryGroup(session && session.updatedAt);
              grouped[group].push(session);
            });

            ["Today", "Yesterday", "Older"].forEach((groupName) => {
              const items = grouped[groupName];
              if (!Array.isArray(items) || items.length === 0) {
                return;
              }

              const groupContainer = document.createElement("section");
              groupContainer.className = "history-group";

              const groupTitle = document.createElement("div");
              groupTitle.className = "history-group-title";
              groupTitle.textContent = groupName;
              groupContainer.appendChild(groupTitle);

              items.forEach((session) => {
                const item = createHistorySessionItem(session);
                if (item) {
                  groupContainer.appendChild(item);
                }
              });

              historyList.appendChild(groupContainer);
            });
          }

          if (state.historyLoading) {
            historyMeta.textContent = "Loading sessions...";
          } else if (state.historyError) {
            historyMeta.textContent = "History unavailable: " + state.historyError;
          } else {
            if (!sessions.length) {
              historyMeta.textContent = "No sessions yet for this workspace.";
            } else if (!filteredSessions.length) {
              historyMeta.textContent = "No matches for the current search.";
            } else if (filteredSessions.length === sessions.length) {
              historyMeta.textContent =
                sessions.length + " recent session" + (sessions.length === 1 ? "" : "s");
            } else {
              historyMeta.textContent =
                "Showing " +
                filteredSessions.length +
                " of " +
                sessions.length +
                " sessions";
            }
          }

          refreshHistoryButton.disabled = Boolean(state.busy || state.historyLoading);
        }

        function setHistorySessions(sessions, currentSessionId, loading, error) {
          state.historySessions = Array.isArray(sessions) ? sessions : [];
          const normalizedSessionId =
            typeof currentSessionId === "string" ? currentSessionId.trim() : "";
          state.activeSessionId = normalizedSessionId || null;
          state.historyLoading = Boolean(loading);
          state.historyError = String(error || "").trim();

          if (historySearchInput && historySearchInput.value !== state.historyFilterQuery) {
            historySearchInput.value = state.historyFilterQuery;
          }

          renderHistorySessions();
        }

        function formatTime(createdAt) {
          if (typeof createdAt !== "number") {
            return "";
          }

          return new Date(createdAt).toLocaleTimeString();
        }

        function createTraceCard(trace) {
          const card = document.createElement("article");
          card.className = "trace-card " + String(trace.kind || "");
          card.dataset.traceId = String(trace.id || "");

          const row = document.createElement("div");
          row.className = "trace-row";

          const title = document.createElement("div");
          title.className = "trace-name";
          title.textContent = String(trace.title || "trace");

          const meta = document.createElement("div");
          meta.className = "trace-meta";
          meta.textContent = String(trace.kind || "event") + " | " + formatTime(trace.createdAt);

          row.appendChild(title);
          row.appendChild(meta);

          const preview = document.createElement("div");
          preview.className = "trace-preview";
          preview.textContent = String(trace.preview || "(no preview)");

          const actions = document.createElement("div");
          actions.className = "trace-actions";

          const copyButton = document.createElement("button");
          copyButton.type = "button";
          copyButton.className = "copy-btn";
          copyButton.textContent = "Copy Payload";
          copyButton.addEventListener("click", () => {
            vscode.postMessage({
              type: "copyPayload",
              payload: String(trace.payload || "")
            });
          });

          actions.appendChild(copyButton);

          const details = document.createElement("details");
          details.className = "trace-details";

          const summary = document.createElement("summary");
          summary.textContent = "Payload";

          const payload = document.createElement("pre");
          payload.textContent = String(trace.payload || "");

          details.appendChild(summary);
          details.appendChild(payload);

          card.appendChild(row);
          card.appendChild(preview);
          card.appendChild(actions);
          card.appendChild(details);

          return card;
        }

        function updateTraceEmptyState() {
          traceEmpty.style.display = state.traceIds.size === 0 ? "block" : "none";
        }

        function addTrace(trace) {
          if (!trace || !trace.id || state.traceIds.has(trace.id)) {
            return;
          }

          state.traceIds.add(trace.id);
          traceList.appendChild(createTraceCard(trace));
          updateTraceEmptyState();
          scrollToBottom(traceList);
        }

        function renderHistory(conversationEntries, traceEntries) {
          conversation.innerHTML = "";
          traceList.innerHTML = "";
          traceList.appendChild(traceEmpty);

          state.traceIds = new Set();
          state.assistantMessageId = null;

          const safeConversation = Array.isArray(conversationEntries) ? conversationEntries : [];
          safeConversation.forEach((entry) => {
            const role = entry.role === "user" ? "user" : "assistant";
            const variant = entry.variant === "error" ? "error" : "default";
            createBubble(role, String(entry.text || ""), String(entry.id || ""), variant);
            if (role === "assistant") {
              state.assistantMessageId = String(entry.id || "");
            }
          });

          const safeTraces = Array.isArray(traceEntries) ? traceEntries : [];
          safeTraces.forEach((trace) => {
            addTrace(trace);
          });

          updateTraceEmptyState();
        }

        function setContextPending(kind, pending) {
          const button = contextButtons.find((candidate) => candidate.dataset.contextKind === kind);
          if (!button) {
            return;
          }

          button.classList.toggle("pending", pending);
          button.disabled = pending || state.busy;
        }

        function appendContextBlock(label, content) {
          const safeLabel = String(label || "Context");
          const safeContent = String(content || "").trim();
          if (!safeContent) {
            return;
          }

          const block = "### " + safeLabel + "\n" + safeContent;
          const prefix = promptInput.value.trim().length > 0 ? "\n\n" : "";
          promptInput.value = promptInput.value + prefix + block;
          promptInput.focus();
          promptInput.selectionStart = promptInput.selectionEnd = promptInput.value.length;
        }

        document.getElementById("composer").addEventListener("submit", (event) => {
          event.preventDefault();

          if (state.busy) {
            return;
          }

          const prompt = promptInput.value.trim();
          if (!prompt) {
            return;
          }

          vscode.postMessage({
            type: "submitPrompt",
            mode: state.mode,
            prompt
          });

          promptInput.value = "";
        });

        modeButtons.agent.addEventListener("click", () => {
          if (state.busy) {
            return;
          }

          setMode("agent");
          vscode.postMessage({ type: "setMode", mode: "agent" });
        });

        modeButtons.chat.addEventListener("click", () => {
          if (state.busy) {
            return;
          }

          setMode("chat");
          vscode.postMessage({ type: "setMode", mode: "chat" });
        });

        modeButtons.plan.addEventListener("click", () => {
          if (state.busy) {
            return;
          }

          setMode("plan");
          vscode.postMessage({ type: "setMode", mode: "plan" });
        });

        newConversationButton.addEventListener("click", () => {
          if (state.busy) {
            return;
          }

          vscode.postMessage({ type: "newConversation" });
        });

        refreshHistoryButton.addEventListener("click", () => {
          if (state.busy) {
            return;
          }

          state.historyLoading = true;
          renderHistorySessions();
          vscode.postMessage({ type: "refreshHistory" });
        });

        historySearchInput.addEventListener("input", () => {
          state.historyFilterQuery = String(historySearchInput.value || "");
          renderHistorySessions();
        });

        continueCommandButton.addEventListener("click", () => {
          if (state.busy) {
            return;
          }

          vscode.postMessage({ type: "continueCommand" });
        });

        stopCommandButton.addEventListener("click", () => {
          if (state.busy) {
            return;
          }

          vscode.postMessage({ type: "stopCommand" });
        });

        approvalModeSelect.addEventListener("change", () => {
          if (state.busy) {
            return;
          }

          const selectedMode = String(approvalModeSelect.value || "");
          if (!isPermissionMode(selectedMode)) {
            setPermissionMode("defaultApproval");
            return;
          }

          setPermissionMode(selectedMode);
          vscode.postMessage({ type: "setPermissionMode", mode: selectedMode });
          pulseStatus("Approvals set to " + permissionModeLabel(selectedMode));
        });

        openLatestDiffButton.addEventListener("click", () => {
          vscode.postMessage({ type: "openLatestDiff" });
        });

        acceptLatestDiffButton.addEventListener("click", () => {
          if (state.busy) {
            return;
          }

          vscode.postMessage({ type: "acceptLatestDiff" });
        });

        rejectLatestDiffButton.addEventListener("click", () => {
          if (state.busy) {
            return;
          }

          vscode.postMessage({ type: "rejectLatestDiff" });
        });

        quickButtons.forEach((button) => {
          button.addEventListener("click", () => {
            const quick = button.getAttribute("data-quick") || "";
            promptInput.value = quick;
            promptInput.focus();
          });
        });

        contextButtons.forEach((button) => {
          button.addEventListener("click", () => {
            if (state.busy) {
              return;
            }

            const kind = button.dataset.contextKind;
            if (!kind) {
              return;
            }

            vscode.postMessage({
              type: "insertContext",
              kind
            });
          });
        });

        window.addEventListener("message", (event) => {
          const message = event.data;

          switch (message.type) {
            case "hydrate":
              if (message.mode) {
                setMode(message.mode);
              }
              setContext(message.context);
              state.activeSessionId = String(message.currentSessionId || "") || null;
              renderHistory(message.conversation, message.traces);
              clearPlan();
              clearFollowUpQuestions();
              pulseStatus("Studio ready");
              break;
            case "history-sync":
              state.activeSessionId = String(message.currentSessionId || "") || null;
              renderHistory(message.conversation, message.traces);
              clearPlan();
              clearFollowUpQuestions();
              break;
            case "history-sessions":
              setHistorySessions(
                message.sessions,
                message.currentSessionId,
                Boolean(message.loading),
                message.error
              );
              break;
            case "mode":
              setMode(message.mode);
              break;
            case "permission-mode":
              setPermissionMode(message.mode);
              break;
            case "busy":
              setBusy(Boolean(message.busy));
              break;
            case "run-started":
              setMode(String(message.mode || state.mode));
              setContext(message.context);
              clearPlan();
              clearFollowUpQuestions();
              createBubble("user", String(message.prompt || ""), String(message.userMessageId || ""), "default");
              createBubble("assistant", "Thinking...", String(message.assistantMessageId || ""), "default");
              state.assistantMessageId = String(message.assistantMessageId || "");
              break;
            case "stream-status":
              setStatus(String(message.status || "Running"));
              break;
            case "stream-plan":
              if (message.step) {
                upsertPlanStep(message.step);
              }
              break;
            case "stream-observation": {
              const observation = message.observation || {};
              const source = String(observation.source || "");
              const observationMessage = String(observation.message || "");

              if (source === "tool.ask_follow_up_question") {
                const questions = parseFollowUpQuestions(observationMessage);
                if (questions.length > 0) {
                  setFollowUpQuestions(questions);
                  pulseStatus("Follow-up questions ready");
                }
              }

              break;
            }
            case "stream-token": {
              const assistantMessageId = String(
                message.assistantMessageId || state.assistantMessageId || ""
              );
              if (!assistantMessageId) {
                break;
              }

              upsertAssistantMessage(assistantMessageId, String(message.token || ""), "default", true);
              break;
            }
            case "run-complete": {
              const assistantMessageId = String(
                message.assistantMessageId || state.assistantMessageId || ""
              );
              const response = message.response || {};
              const responseSessionId = String(response.sessionId || "").trim();
              if (responseSessionId) {
                state.activeSessionId = responseSessionId;
                renderHistorySessions();
              }
              const responsePlan = Array.isArray(response.plan) ? response.plan : [];
              responsePlan.forEach((step) => {
                upsertPlanStep(step);
              });

              if (String(response.status || "") === "needs_follow_up") {
                const questions = parseFollowUpQuestions(response.finalMessage);
                if (questions.length > 0) {
                  setFollowUpQuestions(questions);
                }
              } else {
                clearFollowUpQuestions();
              }

              const fallbackMessage = String(response.finalMessage || "Completed.");
              const existing = findBubbleById(assistantMessageId);

              if (!existing || !existing.textContent.trim() || existing.textContent === "Thinking...") {
                upsertAssistantMessage(assistantMessageId, fallbackMessage, "default", false);
              }

              setStatus("Idle");
              break;
            }
            case "run-error": {
              const assistantMessageId = String(
                message.assistantMessageId || state.assistantMessageId || ""
              );
              upsertAssistantMessage(
                assistantMessageId,
                String(message.message || "Runtime error"),
                "error",
                false
              );
              clearFollowUpQuestions();
              setStatus("Error");
              break;
            }
            case "trace-add":
              addTrace(message.trace);
              break;
            case "payload-copy-result":
              if (message.ok) {
                pulseStatus("Payload copied");
              } else {
                pulseStatus("Copy failed");
              }
              break;
            case "insert-context-pending":
              setContextPending(String(message.kind || ""), Boolean(message.pending));
              break;
            case "insert-context-result":
              if (message.ok) {
                appendContextBlock(message.label, message.content);
                pulseStatus("Context inserted");
              } else {
                pulseStatus("Context unavailable");
              }
              break;
            case "focus-input":
              promptInput.focus();
              break;
            case "status-announcement":
              pulseStatus(String(message.text || "Status updated"));
              break;
            default:
              break;
          }
        });

        setMode(state.mode);
        setPermissionMode(state.permissionMode);
        renderHistorySessions();
        setBusy(false);
        vscode.postMessage({ type: "ready" });
      })();
    </script>
  </body>
</html>`;
  }
}

function parseIncomingMessage(rawMessage: unknown): StudioIncomingMessage | undefined {
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

function normalizePermissionMode(value: string | undefined): PermissionMode {
  const normalized = (value || "").trim().toLowerCase();
  if (normalized === "bypassapproval" || normalized === "bypass_approval") {
    return "bypassApproval";
  }

  if (normalized === "autopilot" || normalized === "auto") {
    return "autopilot";
  }

  return "defaultApproval";
}

function permissionModeLabel(mode: PermissionMode): string {
  if (mode === "bypassApproval") {
    return "Bypass Approvals";
  }

  if (mode === "autopilot") {
    return "Autopilot";
  }

  return "Default Approvals";
}

function readStringArraySetting(
  configuration: vscode.WorkspaceConfiguration,
  key: string
): string[] {
  const raw = configuration.get<unknown>(key, []);
  if (!Array.isArray(raw)) {
    return [];
  }

  return raw
    .map((entry) => String(entry).trim())
    .filter((entry) => entry.length > 0);
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

function uniqueDiffPaths(snapshot: StudioDiffSnapshot): string[] {
  const seen = new Set<string>();
  const normalized: string[] = [];

  for (const file of snapshot.files) {
    const candidate = file.path.trim();
    if (!candidate || seen.has(candidate)) {
      continue;
    }

    seen.add(candidate);
    normalized.push(candidate);
  }

  return normalized;
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

function extractFailingTestExcerpt(output: string): string {
  const lines = output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  const failingLines = lines.filter((line) =>
    /(--- FAIL:|FAIL\b|\bfailing\b|\bfailed\b|not ok\b|\u2715|AssertionError|panic:|\berror\b)/i.test(
      line
    )
  );

  if (failingLines.length === 0) {
    return "";
  }

  return truncateText(failingLines.slice(0, 80).join("\n"), 2600);
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

function toSelectionPreview(selection: string): string {
  const normalized = selection.replace(/\s+/g, " ").trim();
  if (normalized.length <= 180) {
    return normalized;
  }

  return `${normalized.slice(0, 177)}...`;
}

function toPayloadText(payload: unknown): string {
  if (typeof payload === "string") {
    return truncateText(payload, MAX_PAYLOAD_TEXT_CHARS);
  }

  try {
    return truncateText(JSON.stringify(payload, null, 2), MAX_PAYLOAD_TEXT_CHARS);
  } catch {
    return "(unable to serialize payload)";
  }
}

function toPayloadPreview(payload: string): string {
  const normalized = payload.replace(/\s+/g, " ").trim();
  if (!normalized) {
    return "(empty payload)";
  }

  return truncateText(normalized, MAX_PAYLOAD_PREVIEW_CHARS);
}

function truncateText(value: string, maxChars: number): string {
  if (value.length <= maxChars) {
    return value;
  }

  return value.slice(0, maxChars - 3) + "...";
}

function shortSessionID(sessionID: string): string {
  const trimmed = sessionID.trim();
  if (!trimmed) {
    return "session";
  }

  if (trimmed.length <= 14) {
    return trimmed;
  }

  return `${trimmed.slice(0, 6)}...${trimmed.slice(-4)}`;
}

function createWorkspaceDiffSnapshot(
  workspaceRoot: string,
  rawDiff: string,
  reason: string
): StudioDiffSnapshot {
  const files = parseUnifiedDiffFileChanges(rawDiff);
  const totalAdditions = files.reduce((count, file) => count + file.additions, 0);
  const totalDeletions = files.reduce((count, file) => count + file.deletions, 0);
  const truncatedDiff = generateTruncatedStructuredDiff(rawDiff);

  const summary =
    files.length === 0
      ? "Workspace currently has no unstaged changes."
      : `${files.length} file(s) changed (+${totalAdditions}/-${totalDeletions})`;

  return {
    id: createId("diff"),
    workspaceRoot,
    reason,
    generatedAt: Date.now(),
    summary,
    truncatedDiff,
    files,
    isEmpty: files.length === 0
  };
}

function parseUnifiedDiffFileChanges(rawDiff: string): StudioDiffFileChange[] {
  if (!rawDiff.trim()) {
    return [];
  }

  const lines = rawDiff.split(/\r?\n/);
  const files: StudioDiffFileChange[] = [];

  let current:
    | {
        path: string;
        additions: number;
        deletions: number;
        hunkCount: number;
        previewLines: string[];
      }
    | undefined;

  const flushCurrent = (): void => {
    if (!current) {
      return;
    }

    files.push({
      path: current.path,
      additions: current.additions,
      deletions: current.deletions,
      hunkCount: current.hunkCount,
      preview: current.previewLines.length > 0 ? current.previewLines.join("\n") : "(no hunks captured)"
    });

    current = undefined;
  };

  for (const line of lines) {
    if (line.startsWith("diff --git ")) {
      flushCurrent();

      const parsedPath = parseDiffPathFromHeader(line);
      current = {
        path: parsedPath,
        additions: 0,
        deletions: 0,
        hunkCount: 0,
        previewLines: []
      };
      continue;
    }

    if (!current) {
      continue;
    }

    if (line.startsWith("@@")) {
      current.hunkCount += 1;
      if (current.previewLines.length < 14) {
        current.previewLines.push(line);
      }
      continue;
    }

    if (line.startsWith("+") && !line.startsWith("+++")) {
      current.additions += 1;
      if (current.previewLines.length < 14) {
        current.previewLines.push(line);
      }
      continue;
    }

    if (line.startsWith("-") && !line.startsWith("---")) {
      current.deletions += 1;
      if (current.previewLines.length < 14) {
        current.previewLines.push(line);
      }
    }
  }

  flushCurrent();
  return files;
}

function parseDiffPathFromHeader(headerLine: string): string {
  const match = /^diff --git a\/(.+?) b\/(.+)$/.exec(headerLine.trim());
  if (!match) {
    return "unknown";
  }

  const left = match[1];
  const right = match[2];
  if (right === "dev/null") {
    return left;
  }

  return right;
}

/**
 * Generates a truncated diff highlighting changes while preserving code structure.
 * This implementation follows these key principles:
 * 1. Always preserve class and function definitions for context
 * 2. Show changes with surrounding lines for readability
 * 3. Use ellipsis to indicate omitted unchanged code
 * 4. Maintain proper indentation and structure
 */
function generateTruncatedStructuredDiff(rawDiff: string): string {
  if (!rawDiff.trim()) {
    return "No workspace changes detected.";
  }

  const contextLines = 2;
  const maxHunksPerFile = 4;
  const maxTotalLines = 320;

  const lines = rawDiff.split(/\r?\n/);
  const output: string[] = [];
  let lineIndex = 0;

  while (lineIndex < lines.length && output.length < maxTotalLines) {
    const line = lines[lineIndex];

    if (!line.startsWith("diff --git ")) {
      lineIndex += 1;
      continue;
    }

    output.push(line);
    lineIndex += 1;

    while (
      lineIndex < lines.length &&
      !lines[lineIndex].startsWith("@@") &&
      !lines[lineIndex].startsWith("diff --git ") &&
      output.length < maxTotalLines
    ) {
      output.push(lines[lineIndex]);
      lineIndex += 1;
    }

    let emittedHunks = 0;
    let skippedHunks = 0;

    while (
      lineIndex < lines.length &&
      !lines[lineIndex].startsWith("diff --git ") &&
      output.length < maxTotalLines
    ) {
      if (!lines[lineIndex].startsWith("@@")) {
        lineIndex += 1;
        continue;
      }

      const hunkHeader = lines[lineIndex];
      lineIndex += 1;
      const hunkBody: string[] = [];

      while (
        lineIndex < lines.length &&
        !lines[lineIndex].startsWith("@@") &&
        !lines[lineIndex].startsWith("diff --git ")
      ) {
        hunkBody.push(lines[lineIndex]);
        lineIndex += 1;
      }

      if (emittedHunks >= maxHunksPerFile) {
        skippedHunks += 1;
        continue;
      }

      emittedHunks += 1;
      output.push(hunkHeader);
      output.push(...truncateHunkBody(hunkBody, contextLines));
    }

    if (skippedHunks > 0 && output.length < maxTotalLines) {
      output.push("  ...");
    }
  }

  if (lineIndex < lines.length && output[output.length - 1] !== "...") {
    output.push("...");
  }

  return output.join("\n");
}

function truncateHunkBody(hunkLines: string[], contextLines: number): string[] {
  if (hunkLines.length === 0) {
    return [];
  }

  const keepIndexes = new Set<number>();

  for (let index = 0; index < hunkLines.length; index += 1) {
    const line = hunkLines[index];
    const isChanged =
      (line.startsWith("+") && !line.startsWith("+++")) ||
      (line.startsWith("-") && !line.startsWith("---"));

    if (isChanged) {
      addIndexRange(keepIndexes, index - contextLines, index + contextLines, hunkLines.length);
      continue;
    }

    if (isDefinitionLikeDiffLine(line)) {
      addIndexRange(keepIndexes, index - 1, index + 1, hunkLines.length);
    }
  }

  const output: string[] = [];
  let previousWasEllipsis = false;

  for (let index = 0; index < hunkLines.length; index += 1) {
    if (keepIndexes.has(index)) {
      output.push(hunkLines[index]);
      previousWasEllipsis = false;
      continue;
    }

    if (!previousWasEllipsis) {
      output.push("  ...");
      previousWasEllipsis = true;
    }
  }

  return output;
}

function addIndexRange(
  target: Set<number>,
  start: number,
  end: number,
  length: number
): void {
  const boundedStart = Math.max(0, start);
  const boundedEnd = Math.min(length - 1, end);

  for (let index = boundedStart; index <= boundedEnd; index += 1) {
    target.add(index);
  }
}

function isDefinitionLikeDiffLine(line: string): boolean {
  const sourceLine = line.replace(/^[ +-]/, "");
  const definitionPattern =
    /\b(class|interface|enum|type|function|def|func|struct|namespace|module)\b|=>\s*\{|\)\s*\{/;

  return definitionPattern.test(sourceLine);
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
