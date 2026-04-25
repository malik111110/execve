# File Modification Policy

This policy keeps edits safe and deterministic.

## Core Rules

- Use minimal diffs.
- Preserve coding style and formatting.
- Avoid unrelated files.
- Never claim edits before execution completes.

## Create vs Edit

- create_file for new files.
- edit existing files only after reading latest content.
- whole-file rewrite only when unavoidable.

## Path Safety

- Keep operations inside workspace root.
- Reject path traversal.
- Prefer relative paths in prompts and tool calls.

## Validation

After changes, run closest checks:

- language build/lint
- unit/integration tests where relevant
- runtime smoke checks for behavior changes

## Failure Handling

- Report precise failing command and error.
- Keep applied changes minimal while iterating.
- If blocked, provide next actionable step.
