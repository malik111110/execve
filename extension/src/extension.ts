import * as vscode from "vscode";
import {
  AgentStudioPanel,
  AgentStudioPanelOptions,
  ContextInsertKind,
  StudioDiffSnapshot
} from "./studioPanel";
import {
  LocalAgentWorkspaceTimelineProvider,
  TimelineProviderLike
} from "./workspaceTimeline";

export function activate(context: vscode.ExtensionContext): void {
  const output = vscode.window.createOutputChannel("Local LLM Agent");
  context.subscriptions.push(output);

  const timelineProvider = new LocalAgentWorkspaceTimelineProvider();
  context.subscriptions.push(timelineProvider);

  const workspaceWithTimeline = vscode.workspace as typeof vscode.workspace & {
    registerTimelineProvider?: (scheme: string, provider: TimelineProviderLike) => vscode.Disposable;
  };

  if (workspaceWithTimeline.registerTimelineProvider) {
    context.subscriptions.push(
      workspaceWithTimeline.registerTimelineProvider("file", timelineProvider)
    );
  } else {
    output.appendLine("[timeline] Workspace timeline API is unavailable in this VS Code runtime.");
  }

  const panelOptions: AgentStudioPanelOptions = {
    onDiffSnapshot: (snapshot: StudioDiffSnapshot) => {
      timelineProvider.recordDiffSnapshot(snapshot);
    }
  };

  const openStudio = (mode: "agent" | "chat" | "plan" = "agent"): AgentStudioPanel => {
    return AgentStudioPanel.createOrShow(context, output, mode, panelOptions);
  };

  const openStudioCommand = vscode.commands.registerCommand(
    "localAgent.openStudio",
    () => {
      openStudio("agent");
    }
  );

  const startAgentCommand = vscode.commands.registerCommand(
    "localAgent.startAgentSession",
    () => {
      openStudio("agent");
    }
  );

  const startChatCommand = vscode.commands.registerCommand(
    "localAgent.startChatSession",
    () => {
      openStudio("chat");
    }
  );

  const startPlanCommand = vscode.commands.registerCommand(
    "localAgent.startPlanSession",
    () => {
      openStudio("plan");
    }
  );

  // Backward-compatible command alias.
  const legacyStartCommand = vscode.commands.registerCommand(
    "localAgent.startSession",
    () => {
      openStudio("agent");
    }
  );

  const newConversationCommand = vscode.commands.registerCommand(
    "localAgent.studio.newConversation",
    () => {
      const panel = openStudio("agent");
      panel.startNewConversation();
      panel.focusComposer();
    }
  );

  const focusInputCommand = vscode.commands.registerCommand(
    "localAgent.studio.focusInput",
    () => {
      const panel = openStudio("agent");
      panel.focusComposer();
    }
  );

  const continueCommandOutputCommand = vscode.commands.registerCommand(
    "localAgent.studio.continueCommand",
    async () => {
      const panel = openStudio("agent");
      await panel.continueTerminalCommand();
      panel.focusComposer();
    }
  );

  const stopRunningCommandCommand = vscode.commands.registerCommand(
    "localAgent.studio.stopCommand",
    async () => {
      const panel = openStudio("agent");
      await panel.stopTerminalCommand();
      panel.focusComposer();
    }
  );

  const openLatestDiffCommand = vscode.commands.registerCommand(
    "localAgent.studio.openLatestDiff",
    async () => {
      const panel = openStudio("agent");
      await panel.openLatestDiffEditor();
      panel.focusComposer();
    }
  );

  const acceptLatestDiffCommand = vscode.commands.registerCommand(
    "localAgent.studio.acceptLatestDiff",
    async () => {
      const panel = openStudio("agent");
      await panel.acceptLatestDiffSnapshot();
      panel.focusComposer();
    }
  );

  const rejectLatestDiffCommand = vscode.commands.registerCommand(
    "localAgent.studio.rejectLatestDiff",
    async () => {
      const panel = openStudio("agent");
      await panel.rejectLatestDiffSnapshot();
      panel.focusComposer();
    }
  );

  const insertContextCommand = (kind: ContextInsertKind) => {
    const panel = openStudio("agent");
    panel.requestContextInsert(kind);
    panel.focusComposer();
  };

  const insertActiveSymbolContextCommand = vscode.commands.registerCommand(
    "localAgent.studio.insertContext.activeSymbol",
    () => {
      insertContextCommand("activeSymbol");
    }
  );

  const insertGitDiffContextCommand = vscode.commands.registerCommand(
    "localAgent.studio.insertContext.gitDiff",
    () => {
      insertContextCommand("gitDiff");
    }
  );

  const insertFailingTestsContextCommand = vscode.commands.registerCommand(
    "localAgent.studio.insertContext.failingTests",
    () => {
      insertContextCommand("failingTests");
    }
  );

  context.subscriptions.push(
    openStudioCommand,
    startAgentCommand,
    startChatCommand,
    startPlanCommand,
    legacyStartCommand,
    newConversationCommand,
    focusInputCommand,
    continueCommandOutputCommand,
    stopRunningCommandCommand,
    openLatestDiffCommand,
    acceptLatestDiffCommand,
    rejectLatestDiffCommand,
    insertActiveSymbolContextCommand,
    insertGitDiffContextCommand,
    insertFailingTestsContextCommand
  );
}

export function deactivate(): void {}
