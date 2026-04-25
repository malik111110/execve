# Prompt Stack

This folder defines the prompt architecture for the local-first coding agent.

The structure is inspired by mature agent systems (including Claude Coder style flows), but all prompt content here is authored for this project and tuned for local model constraints.

## Layout

- agents/: role-level system prompts (main executor, planner, file editor policy)
- tools/: tool catalog and strict call formatting rules
- parsing/: language parsing and file-modification guardrails
- templates/: reusable user prompt templates

## Design Principles

- Deterministic behavior first
- One clear action at a time
- Minimal and reversible file changes
- Explicit validation after changes
- Parser-friendly structured tool actions

## Current Tooling Target

Prompt files align with runtime tools currently available:

- read_file
- search_code
- git_diff
- create_file

## How to Use

1. Start from templates/default-task.md for user-facing tasks.
2. Merge with agents/main.system.md for model behavior.
3. Include tools/tool-call-format.md to enforce parseable actions.
4. Add parsing/file-modification-policy.md when edits are involved.

## Inspiration Notes

- inspiration-kodu-claude-coder.md
