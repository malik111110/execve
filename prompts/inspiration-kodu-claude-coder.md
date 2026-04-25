# Inspiration Notes from Kodu AI Claude Coder

This repository was reviewed for architectural inspiration, especially around:

- tool-calling format
- prompt layering
- language parsing flow
- file modification safety

## Patterns Worth Reusing

1. Prompt layering
- Separate main agent prompt, planner prompt, and tool prompts.
- Keep tool descriptions explicit and schema-like.

2. Strict action format
- Use parser-friendly structured envelopes for tool calls.
- Enforce one clear action at a time for reliable execution.

3. Prompt builder approach
- Build prompts from templates with placeholders.
- Inject environment details and enabled tools at runtime.

4. File editing guardrails
- Require latest content before edits.
- Prefer minimal edits over full rewrites.
- Keep clear mode boundaries (edit vs whole write semantics).

5. Context-first navigation
- Explore files/symbols before editing.
- Encourage dependency-aware changes and verification.

## Local LLM Adaptation

For local models, keep prompt segments smaller and tighter:

- concise tool schemas
- reduced instruction redundancy
- deterministic tool-first shortcuts where possible
- explicit timeout and fallback handling

## Current Mapping in This Project

- prompts/agents/* for role prompts
- prompts/tools/* for action format and catalog
- prompts/parsing/* for parser and file policy
- prompts/templates/* for reusable task framing
