import * as vscode from "vscode";
import * as path from "node:path";
import { RuntimeClient } from "./runtimeClient";
import { AgentRequest } from "./types";

export function activate(context: vscode.ExtensionContext): void {
  const output = vscode.window.createOutputChannel("Local LLM Agent");
  context.subscriptions.push(output);

  const command = vscode.commands.registerCommand(
    "localAgent.startSession",
    async () => {
      const prompt = await vscode.window.showInputBox({
        title: "Local LLM Agent",
        prompt: "Describe what you want the local agent to do"
      });

      if (!prompt || prompt.trim().length === 0) {
        return;
      }

      const editor = vscode.window.activeTextEditor;
      const selectedText =
        editor && !editor.selection.isEmpty
          ? editor.document.getText(editor.selection)
          : "";

      const config = vscode.workspace.getConfiguration("localAgent");
      let workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? "";
      const activeFilePath = editor?.document.uri.fsPath ?? "";

      if (!workspaceRoot && activeFilePath) {
        workspaceRoot = path.dirname(activeFilePath);
      }

      if (!workspaceRoot) {
        const configuredDefaultRoot = config.get<string>("defaultWorkspaceRoot", "").trim();
        if (configuredDefaultRoot) {
          workspaceRoot = configuredDefaultRoot;
        }
      }

      if (!workspaceRoot) {
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

      if (!workspaceRoot) {
        void vscode.window.showErrorMessage(
          "Local Agent needs a project root. Open a folder or select one when prompted."
        );
        return;
      }

      const runtimeUrl = config.get<string>("runtimeUrl", "http://127.0.0.1:8080");
      const timeoutMs = config.get<number>("requestTimeoutMs", 120000);
      const dryRun = config.get<boolean>("dryRun", false);
      const mode = config.get<"agent" | "chat">("mode", "agent");

      const payload: AgentRequest = {
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
      };

      const client = new RuntimeClient(runtimeUrl, timeoutMs);
      output.appendLine(`[request] ${prompt}`);
      output.show(true);

      try {
        let wroteTokenLine = false;

        let response;
        try {
          response = await client.runStream(payload, {
            onStatus: (status) => {
              output.appendLine(`[status] ${status}`);
            },
            onPlan: (step) => {
              output.appendLine(`[plan] ${step.step}. ${step.title} (${step.status})`);
            },
            onObservation: (observation) => {
              output.appendLine(`[obs] ${observation.source}: ${observation.message}`);
            },
            onToken: (token) => {
              if (!wroteTokenLine) {
                output.append("[stream] ");
                wroteTokenLine = true;
              }

              output.append(token);
            },
            onDone: () => {
              if (wroteTokenLine) {
                output.appendLine("");
              }
            }
          });
        } catch (streamError) {
          const message = streamError instanceof Error ? streamError.message : String(streamError);
          output.appendLine(`[stream-error] ${message}`);
          output.appendLine("[stream-error] falling back to non-streaming endpoint");
          response = await client.run(payload);
        }

        output.appendLine(`[status] ${response.status}`);
        output.appendLine(`[durationMs] ${response.durationMs}`);

        output.appendLine(`[final] ${response.finalMessage}`);

        void vscode.window.showInformationMessage(
          `Local Agent: ${response.finalMessage}`
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        output.appendLine(`[error] ${message}`);
        output.show(true);
        void vscode.window.showErrorMessage(`Local Agent failed: ${message}`);
      }
    }
  );

  context.subscriptions.push(command);
}

export function deactivate(): void {}
