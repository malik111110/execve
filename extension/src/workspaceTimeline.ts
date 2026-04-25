import * as path from "node:path";
import * as vscode from "vscode";
import { StudioDiffSnapshot } from "./studioPanel";

const MAX_EVENTS_PER_FILE = 80;

export interface TimelineItemLike {
  id: string;
  timestamp: number;
  label: string;
  description?: string;
  tooltip?: string | vscode.MarkdownString;
  iconPath?: vscode.ThemeIcon;
  command?: vscode.Command;
}

export interface TimelineResultLike {
  items: TimelineItemLike[];
  paging?: { cursor: string };
}

export interface TimelineProviderLike {
  readonly id: string;
  readonly label: string;
  readonly onDidChange?: vscode.Event<{ uri?: vscode.Uri; reset?: boolean }>;
  provideTimeline(
    uri: vscode.Uri,
    options: { cursor?: string; limit?: number },
    token: vscode.CancellationToken
  ): vscode.ProviderResult<TimelineResultLike>;
}

export class LocalAgentWorkspaceTimelineProvider
  implements TimelineProviderLike, vscode.Disposable
{
  readonly id = "localAgent.workspaceTimeline";
  readonly label = "Local Agent Workspace Changes";

  private readonly onDidChangeEmitter = new vscode.EventEmitter<{
    uri?: vscode.Uri;
    reset?: boolean;
  }>();
  readonly onDidChange = this.onDidChangeEmitter.event;

  private readonly snapshotsByFile = new Map<string, StudioDiffSnapshot[]>();

  recordDiffSnapshot(snapshot: StudioDiffSnapshot): void {
    if (snapshot.files.length === 0) {
      return;
    }

    for (const fileChange of snapshot.files) {
      const absolutePath = path.normalize(
        path.resolve(snapshot.workspaceRoot, fileChange.path)
      );

      const current = this.snapshotsByFile.get(absolutePath) ?? [];
      const next = [snapshot, ...current.filter((entry) => entry.id !== snapshot.id)].slice(
        0,
        MAX_EVENTS_PER_FILE
      );

      this.snapshotsByFile.set(absolutePath, next);
      this.onDidChangeEmitter.fire({
        uri: vscode.Uri.file(absolutePath),
        reset: false
      });
    }
  }

  provideTimeline(
    uri: vscode.Uri,
    options: { cursor?: string; limit?: number },
    _token: vscode.CancellationToken
  ): vscode.ProviderResult<TimelineResultLike> {
    const fileKey = path.normalize(uri.fsPath);
    const snapshots = this.snapshotsByFile.get(fileKey) ?? [];

    const cursorValue = Number(options.cursor ?? 0);
    const startIndex = Number.isFinite(cursorValue) ? Math.max(0, cursorValue) : 0;
    const limit = Math.max(1, options.limit ?? 20);

    const page = snapshots.slice(startIndex, startIndex + limit);
    const items = page.map((snapshot, index) =>
      this.toTimelineItem(uri, snapshot, startIndex + index)
    );

    const nextCursor = startIndex + page.length;

    return {
      items,
      paging:
        nextCursor < snapshots.length
          ? {
              cursor: String(nextCursor)
            }
          : undefined
    };
  }

  dispose(): void {
    this.onDidChangeEmitter.dispose();
  }

  private toTimelineItem(
    uri: vscode.Uri,
    snapshot: StudioDiffSnapshot,
    index: number
  ): TimelineItemLike {
    const filePath = path.normalize(uri.fsPath);
    const fileChange = snapshot.files.find(
      (entry) =>
        path.normalize(path.resolve(snapshot.workspaceRoot, entry.path)) === filePath
    );

    const additions = fileChange?.additions ?? 0;
    const deletions = fileChange?.deletions ?? 0;
    const hunkCount = fileChange?.hunkCount ?? 0;

    const tooltip = new vscode.MarkdownString(
      [
        `**Local Agent Change**`,
        ``,
        `Reason: ${escapeMarkdown(snapshot.reason)}`,
        `Summary: ${escapeMarkdown(snapshot.summary)}`,
        `Hunks: ${hunkCount}, +${additions}, -${deletions}`,
        ``,
        `\`\`\`diff`,
        truncateForTooltip(snapshot.truncatedDiff, 3600),
        `\`\`\``
      ].join("\n")
    );

    tooltip.isTrusted = false;

    return {
      id: `${snapshot.id}:${index}:${uri.fsPath}`,
      timestamp: snapshot.generatedAt,
      label: `${snapshot.reason} (+${additions}/-${deletions})`,
      description: snapshot.summary,
      tooltip,
      iconPath: new vscode.ThemeIcon("history"),
      command: {
        command: "vscode.open",
        title: "Open File",
        arguments: [uri]
      }
    };
  }
}

function truncateForTooltip(value: string, maxChars: number): string {
  if (value.length <= maxChars) {
    return value;
  }

  return `${value.slice(0, maxChars - 3)}...`;
}

function escapeMarkdown(value: string): string {
  return value.replace(/[\\`*_{}[\]()#+\-.!]/g, "\\$&");
}
