# Prompt Architecture (Local Claude-Code Style)

This document explains the prompt strategy used in this repository.

## Inspiration and Adaptation

The design draws:

- explicit prompt layering (main/planner/tools)
- strict tool-call formatting for parser reliability
- strong file-editing guardrails
- context-first execution loops

This repository adapts those ideas for local model constraints:

- smaller prompt chunks
- deterministic tool-first actions where possible
- narrow context windows and focused validation

## Layers

1. Agent prompts
   - execution behavior
   - planning behavior
   - file editing behavior
2. Tool prompts
   - canonical action format
   - argument expectations per tool
3. Parsing policies
   - symbol discovery and dependency-aware edits
   - safe file modification workflow
4. User templates
   - repeatable task framing with clear acceptance criteria

## Why This Helps Local LLMs

- Reduces ambiguity in tool invocation.
- Improves consistency for multi-step tasks.
- Decreases hallucinated operations.
- Preserves performance by limiting context noise.

## Next Integration Step

Runtime now loads these prompt files (when present) before provider generation so each request combines:

- base agent prompt
- tool catalog and format rules
- file-modification policy
- user request and selected context blocks

## Command Results Memory and Context Management

To keep command execution useful for follow-up reasoning, the runtime keeps a short-term command memory per workspace root.

- Every successful non-dry-run command stores:
   - command string
   - exit code, timeout flag, duration
   - bounded stdout/stderr snippets
- Memory is bounded to prevent prompt explosion:
   - keep last few command entries
   - truncate each output snippet to a fixed max size
   - inject only the most recent subset into model prompts

This gives the model reliable operational context from prior tool actions while preserving latency and token budget.
