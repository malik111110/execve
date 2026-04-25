import * as path from "node:path";
import * as vscode from "vscode";
import { StudioDiffSnapshot } from "./studioPanel";

const MAX_EVENTS_PER_FILE = 80;

/**
 * Stores diff snapshots per file for in-process access.
 *
 * Note: VS Code's Timeline API (registerTimelineProvider) was a proposed API
 * and is not available in the current @types/vscode baseline. This class retains
 * snapshot data for potential future re-integration; it is NOT registered with
 * any VS Code API.
 */
export class LocalAgentWorkspaceTimelineProvider implements vscode.Disposable {
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
      const next = [
        snapshot,
        ...current.filter((entry) => entry.id !== snapshot.id)
      ].slice(0, MAX_EVENTS_PER_FILE);

      this.snapshotsByFile.set(absolutePath, next);
    }
  }

  getSnapshotsForFile(absolutePath: string): StudioDiffSnapshot[] {
    return this.snapshotsByFile.get(path.normalize(absolutePath)) ?? [];
  }

  dispose(): void {
    this.snapshotsByFile.clear();
  }
}
