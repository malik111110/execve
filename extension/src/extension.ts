import * as vscode from "vscode";
import { AgentStudioPanel } from "./studioPanel";

export function activate(context: vscode.ExtensionContext): void {
  const output = vscode.window.createOutputChannel("Local LLM Agent");
  context.subscriptions.push(output);

  const openStudioCommand = vscode.commands.registerCommand(
    "localAgent.openStudio",
    () => {
      AgentStudioPanel.createOrShow(output, "agent");
    }
  );

  const startAgentCommand = vscode.commands.registerCommand(
    "localAgent.startAgentSession",
    () => {
      AgentStudioPanel.createOrShow(output, "agent");
    }
  );

  const startChatCommand = vscode.commands.registerCommand(
    "localAgent.startChatSession",
    () => {
      AgentStudioPanel.createOrShow(output, "chat");
    }
  );

  // Backward-compatible command alias.
  const legacyStartCommand = vscode.commands.registerCommand(
    "localAgent.startSession",
    () => {
      AgentStudioPanel.createOrShow(output, "agent");
    }
  );

  context.subscriptions.push(
    openStudioCommand,
    startAgentCommand,
    startChatCommand,
    legacyStartCommand
  );
}

export function deactivate(): void {}
