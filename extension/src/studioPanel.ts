import * as path from "node:path";
import * as vscode from "vscode";
import { RuntimeClient } from "./runtimeClient";
import { AgentRequest, AgentResponse } from "./types";

type SessionMode = "agent" | "chat";

type StudioIncomingMessage =
  | { type: "ready" }
  | { type: "setMode"; mode: SessionMode }
  | { type: "submitPrompt"; prompt: string; mode: SessionMode };

interface StudioContextSnapshot {
  workspaceRoot: string;
  activeFilePath: string;
  hasSelection: boolean;
  selectionPreview: string;
  runtimeUrl: string;
  timeoutMs: number;
  dryRun: boolean;
}

interface ResolvedSessionContext {
  payload: AgentRequest;
  snapshot: StudioContextSnapshot;
}

const OUTPUT_CHANNEL_NAME = "Local LLM Agent";

export class AgentStudioPanel {
  private static currentPanel: AgentStudioPanel | undefined;

  static createOrShow(output: vscode.OutputChannel, initialMode: SessionMode): void {
    const existing = AgentStudioPanel.currentPanel;
    if (existing) {
      existing.panel.reveal(vscode.ViewColumn.One);
      existing.setMode(initialMode);
      void existing.hydrate();
      return;
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

    AgentStudioPanel.currentPanel = new AgentStudioPanel(panel, output, initialMode);
  }

  private requestInFlight = false;

  private constructor(
    private readonly panel: vscode.WebviewPanel,
    private readonly output: vscode.OutputChannel,
    private mode: SessionMode
  ) {
    this.panel.webview.html = this.getHtml(this.panel.webview, this.mode);

    this.panel.onDidDispose(() => {
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
          await this.hydrate();
          return;
        case "setMode":
          this.setMode(message.mode);
          return;
        case "submitPrompt":
          await this.handleSubmit(message.prompt, message.mode);
          return;
        default:
          return;
      }
    });
  }

  private async hydrate(): Promise<void> {
    const context = await this.resolveSessionContext(false, this.mode, "");
    this.postMessage({
      type: "hydrate",
      mode: this.mode,
      context: context?.snapshot ?? null,
      outputChannelName: OUTPUT_CHANNEL_NAME
    });
  }

  private setMode(mode: SessionMode): void {
    this.mode = mode;
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
    this.mode = mode;
    this.postMessage({ type: "busy", busy: true });

    const sessionContext = await this.resolveSessionContext(true, mode, trimmedPrompt);
    if (!sessionContext) {
      this.requestInFlight = false;
      this.postMessage({ type: "busy", busy: false });
      return;
    }

    const { payload, snapshot } = sessionContext;
    const client = new RuntimeClient(snapshot.runtimeUrl, snapshot.timeoutMs);

    this.output.show(true);
    this.output.appendLine(`[mode] ${mode}`);
    this.output.appendLine(`[request] ${trimmedPrompt}`);

    this.postMessage({
      type: "run-started",
      mode,
      prompt: trimmedPrompt,
      context: snapshot
    });

    try {
      let wroteTokenLine = false;
      let response: AgentResponse;

      try {
        response = await client.runStream(payload, {
          onStatus: (status) => {
            this.output.appendLine(`[status] ${status}`);
            this.postMessage({ type: "stream-status", status });
          },
          onPlan: (step) => {
            this.output.appendLine(`[plan] ${step.step}. ${step.title} (${step.status})`);
            this.postMessage({ type: "stream-plan", step });
          },
          onObservation: (observation) => {
            this.output.appendLine(`[obs] ${observation.source}: ${observation.message}`);
            this.postMessage({ type: "stream-observation", observation });
          },
          onToken: (token) => {
            if (!wroteTokenLine) {
              this.output.append("[stream] ");
              wroteTokenLine = true;
            }

            this.output.append(token);
            this.postMessage({ type: "stream-token", token });
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
        this.postMessage({
          type: "stream-fallback",
          message: streamMessage
        });
        response = await client.run(payload);
      }

      this.output.appendLine(`[status] ${response.status}`);
      this.output.appendLine(`[durationMs] ${response.durationMs}`);
      this.output.appendLine(`[final] ${response.finalMessage}`);

      this.postMessage({ type: "run-complete", response });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.output.appendLine(`[error] ${message}`);
      this.postMessage({ type: "run-error", message });
    } finally {
      this.requestInFlight = false;
      this.postMessage({ type: "busy", busy: false });
    }
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

    const snapshot: StudioContextSnapshot = {
      workspaceRoot,
      activeFilePath,
      hasSelection: selectedText.trim().length > 0,
      selectionPreview: toSelectionPreview(selectedText),
      runtimeUrl,
      timeoutMs,
      dryRun
    };

    return {
      payload: {
        prompt,
        context: {
          workspaceRoot,
          activeFilePath,
          selectedText
        },
        settings: {
          maxSteps: 6,
          dryRun,
          mode
        }
      },
      snapshot
    };
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
    void this.panel.webview.postMessage(message);
  }

  private getHtml(webview: vscode.Webview, initialMode: SessionMode): string {
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
        --accent-soft: #efb08e;
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
        grid-template-rows: auto auto minmax(220px, 1fr) minmax(120px, 0.5fr) auto;
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

      .timeline-wrap {
        padding: 12px;
        overflow: hidden;
        display: grid;
        grid-template-rows: auto minmax(0, 1fr);
      }

      .timeline-title {
        font-size: 12px;
        font-weight: 700;
        color: var(--muted);
        letter-spacing: 0.5px;
        text-transform: uppercase;
      }

      .timeline {
        margin-top: 8px;
        overflow: auto;
        display: flex;
        flex-direction: column;
        gap: 6px;
        font-family: var(--mono);
        font-size: 11px;
      }

      .event {
        border-left: 3px solid rgba(12, 98, 104, 0.42);
        background: rgba(255, 255, 255, 0.7);
        border-radius: 8px;
        padding: 7px 8px;
      }

      .event.warn {
        border-left-color: rgba(169, 82, 44, 0.7);
      }

      .event.error {
        border-left-color: rgba(157, 47, 52, 0.7);
      }

      .composer {
        padding: 12px;
        display: grid;
        gap: 10px;
      }

      .quick-row {
        display: flex;
        flex-wrap: wrap;
        gap: 8px;
      }

      .quick {
        border: 1px solid rgba(12, 98, 104, 0.22);
        border-radius: 999px;
        background: rgba(255, 255, 255, 0.82);
        color: var(--accent-alt);
        font-size: 11px;
        font-weight: 700;
        padding: 6px 10px;
        cursor: pointer;
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
      .quick[disabled] {
        opacity: 0.6;
        cursor: default;
      }

      @media (max-width: 920px) {
        .context {
          grid-template-columns: repeat(2, minmax(0, 1fr));
        }
      }

      @media (max-width: 640px) {
        body {
          padding: 10px;
        }

        .shell {
          height: calc(100vh - 20px);
          grid-template-rows: auto auto minmax(180px, 1fr) minmax(120px, 0.45fr) auto;
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
        <div class="status-line">
          <div class="dot" aria-hidden="true"></div>
          <div class="status-pill" id="status-pill">Idle</div>
          <div class="segment" role="tablist" aria-label="Session mode">
            <button id="mode-agent" role="tab" data-mode="agent">Agent</button>
            <button id="mode-chat" role="tab" data-mode="chat">Chat</button>
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

      <section id="conversation" class="conversation glass" aria-label="Conversation transcript"></section>

      <section class="timeline-wrap glass">
        <div class="timeline-title">Activity Timeline</div>
        <div id="timeline" class="timeline" aria-live="polite"></div>
      </section>

      <form id="composer" class="composer glass">
        <div class="quick-row">
          <button type="button" class="quick" data-quick="Analyze the currently selected code and suggest improvements.">Analyze Selection</button>
          <button type="button" class="quick" data-quick="Plan a safe refactor for the active file and list potential risks.">Plan Refactor</button>
          <button type="button" class="quick" data-quick="Explain the architecture of this project in practical terms.">Explain Architecture</button>
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
          busy: false,
          assistantBody: null,
          assistantHasText: false
        };

        const statusPill = document.getElementById("status-pill");
        const conversation = document.getElementById("conversation");
        const timeline = document.getElementById("timeline");
        const promptInput = document.getElementById("prompt");
        const sendButton = document.getElementById("send");

        const modeButtons = {
          agent: document.getElementById("mode-agent"),
          chat: document.getElementById("mode-chat")
        };

        const contextFields = {
          workspace: document.getElementById("context-workspace"),
          file: document.getElementById("context-file"),
          selection: document.getElementById("context-selection"),
          runtime: document.getElementById("context-runtime")
        };

        const quickButtons = Array.from(document.querySelectorAll(".quick"));

        function setStatus(text) {
          statusPill.textContent = text;
        }

        function scrollToBottom(container) {
          container.scrollTop = container.scrollHeight;
        }

        function createBubble(role, text) {
          const bubble = document.createElement("article");
          bubble.className = "bubble " + role;
          bubble.textContent = text;
          conversation.appendChild(bubble);
          scrollToBottom(conversation);
          return bubble;
        }

        function createTimelineEvent(text, variant) {
          const event = document.createElement("div");
          event.className = "event" + (variant ? " " + variant : "");
          event.textContent = text;
          timeline.appendChild(event);
          scrollToBottom(timeline);
        }

        function setMode(mode) {
          state.mode = mode;
          modeButtons.agent.classList.toggle("active", mode === "agent");
          modeButtons.chat.classList.toggle("active", mode === "chat");
          promptInput.placeholder =
            mode === "agent"
              ? "Describe what you want the local agent to do..."
              : "Ask a question or discuss an implementation approach...";
        }

        function setBusy(busy) {
          state.busy = busy;
          sendButton.disabled = busy;
          promptInput.disabled = busy;
          quickButtons.forEach((button) => {
            button.disabled = busy;
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
          contextFields.runtime.textContent =
            context.runtimeUrl + " | timeout " + context.timeoutMs + "ms | dryRun " + context.dryRun;
        }

        function ensureAssistantBubble() {
          if (!state.assistantBody) {
            state.assistantBody = createBubble("assistant", "Thinking...");
            state.assistantHasText = false;
          }
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

        quickButtons.forEach((button) => {
          button.addEventListener("click", () => {
            const quick = button.getAttribute("data-quick") || "";
            promptInput.value = quick;
            promptInput.focus();
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
              createTimelineEvent("Studio connected to output channel " + message.outputChannelName + ".");
              break;
            case "mode":
              setMode(message.mode);
              break;
            case "busy":
              setBusy(Boolean(message.busy));
              break;
            case "run-started":
              setContext(message.context);
              createBubble("user", message.prompt);
              state.assistantBody = createBubble("assistant", "Thinking...");
              state.assistantHasText = false;
              createTimelineEvent("Request started in " + message.mode + " mode.");
              break;
            case "stream-status":
              setStatus(String(message.status || "Running"));
              createTimelineEvent("status: " + String(message.status || ""));
              break;
            case "stream-plan": {
              const step = message.step;
              if (step && typeof step.step === "number") {
                createTimelineEvent(
                  "plan: " + step.step + ". " + String(step.title || "") + " (" + String(step.status || "") + ")"
                );
              }
              break;
            }
            case "stream-observation": {
              const observation = message.observation;
              if (observation) {
                createTimelineEvent(
                  "obs: " + String(observation.source || "runtime") + " - " + String(observation.message || "")
                );
              }
              break;
            }
            case "stream-token":
              ensureAssistantBubble();
              if (!state.assistantHasText) {
                state.assistantBody.textContent = "";
                state.assistantHasText = true;
              }
              state.assistantBody.textContent += String(message.token || "");
              scrollToBottom(conversation);
              break;
            case "stream-fallback":
              createTimelineEvent(
                "Streaming interrupted, switched to non-streaming response.",
                "warn"
              );
              break;
            case "run-complete": {
              const response = message.response;
              ensureAssistantBubble();

              if (!state.assistantHasText) {
                state.assistantBody.textContent = String(response.finalMessage || "Completed.");
                state.assistantHasText = true;
              }

              createTimelineEvent(
                "done: " + String(response.status || "ok") + " in " + String(response.durationMs || 0) + "ms"
              );
              setStatus("Idle");
              break;
            }
            case "run-error":
              ensureAssistantBubble();
              state.assistantBody.classList.add("error");
              state.assistantBody.textContent = String(message.message || "Runtime error");
              createTimelineEvent("error: " + String(message.message || "Runtime error"), "error");
              setStatus("Error");
              break;
            default:
              break;
          }
        });

        setMode(state.mode);
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

  return undefined;
}

function isSessionMode(value: unknown): value is SessionMode {
  return value === "agent" || value === "chat";
}

function toSelectionPreview(selection: string): string {
  const normalized = selection.replace(/\s+/g, " ").trim();
  if (normalized.length <= 180) {
    return normalized;
  }

  return `${normalized.slice(0, 177)}...`;
}

function createNonce(): string {
  const possibleChars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let nonce = "";

  for (let index = 0; index < 32; index += 1) {
    nonce += possibleChars.charAt(Math.floor(Math.random() * possibleChars.length));
  }

  return nonce;
}
