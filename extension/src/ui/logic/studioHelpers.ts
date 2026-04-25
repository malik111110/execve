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

const DEFAULT_PAYLOAD_PREVIEW_CHARS = 220;
const DEFAULT_PAYLOAD_TEXT_CHARS = 16000;

export function toSelectionPreview(selection: string): string {
  const normalized = selection.replace(/\s+/g, " ").trim();
  if (normalized.length <= 180) {
    return normalized;
  }

  return `${normalized.slice(0, 177)}...`;
}

export function toPayloadText(payload: unknown, maxChars = DEFAULT_PAYLOAD_TEXT_CHARS): string {
  if (typeof payload === "string") {
    return truncateText(payload, maxChars);
  }

  try {
    return truncateText(JSON.stringify(payload, null, 2), maxChars);
  } catch {
    return "(unable to serialize payload)";
  }
}

export function toPayloadPreview(payload: string, maxChars = DEFAULT_PAYLOAD_PREVIEW_CHARS): string {
  const normalized = payload.replace(/\s+/g, " ").trim();
  if (!normalized) {
    return "(empty payload)";
  }

  return truncateText(normalized, maxChars);
}

export function truncateText(value: string, maxChars: number): string {
  if (value.length <= maxChars) {
    return value;
  }

  return value.slice(0, maxChars - 3) + "...";
}

export function shortSessionID(sessionID: string): string {
  const trimmed = sessionID.trim();
  if (!trimmed) {
    return "session";
  }

  if (trimmed.length <= 14) {
    return trimmed;
  }

  return `${trimmed.slice(0, 6)}...${trimmed.slice(-4)}`;
}

export function uniqueDiffPaths(snapshot: StudioDiffSnapshot): string[] {
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

export function extractFailingTestExcerpt(output: string): string {
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

export function createWorkspaceDiffSnapshot(
  workspaceRoot: string,
  rawDiff: string,
  reason: string,
  idFactory: (prefix: string) => string
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
    id: idFactory("diff"),
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
