# Local LLM Coding Agent (VS Code + Go)

This repository is scaffolded for a local-first coding agent:

- `extension/`: VS Code extension frontend (TypeScript)
- `runtime/`: deterministic Go agent runtime
- `api/`: shared request/response schema artifacts
- `docs/`: project docs and workflow notes
- `prompts/`: agent/tool/parsing prompt stack for local model orchestration

## Quick Start

1. Start the runtime:

   ```bash
   cd runtime
   go run ./cmd/agentd
   ```

   Provider selection is environment-driven:

   ```bash
   # Mock provider (default)
   AGENT_PROVIDER=mock go run ./cmd/agentd

   # Ollama
   AGENT_ALLOW_COMMANDS=true AGENT_PROVIDER=ollama OLLAMA_MODEL=llama3.2:3b go run ./cmd/agentd

   # LM Studio (OpenAI-compatible endpoint)
   AGENT_ALLOW_COMMANDS=true AGENT_PROVIDER=lmstudio LMSTUDIO_MODEL=local-model go run ./cmd/agentd
   ```

   Optional provider endpoint overrides:

   - `OLLAMA_BASE_URL` (default `http://127.0.0.1:11434`)
   - `LMSTUDIO_BASE_URL` (default `http://127.0.0.1:1234`)

2. Build the extension:

   ```bash
   cd extension
   npm install
   npm run build
   ```

3. Launch the extension host from VS Code and run command:

   - `Local Agent: Open Studio`
   - `Local Agent: Start Agent Session`
   - `Local Agent: Start Chat Session`

## Current Scope

- Deterministic request/plan/response loop
- Dedicated Studio webview for contextual prompting, stream rendering, and run timeline
- One-click agent vs chat session commands in VS Code
- Local HTTP bridge from extension to runtime
- Streaming runtime responses to extension via SSE
- Real provider integration for Ollama and LM Studio
- Runtime tool registry with `read_file`, `search_code`, `git_diff`, and `create_file`
- Runtime command execution via `execute_command` (guarded by `AGENT_ALLOW_COMMANDS=true`)
- Deterministic command output capture to markdown file for command+file prompts
- Prompt bundle loading from `prompts/` into provider context

## Prompt Library

Use the prompt stack under `prompts/` for higher quality local-agent behavior:

- `prompts/agents/`: role-level system prompts (main/planner/file-editor)
- `prompts/tools/`: tool-call format and catalog
- `prompts/parsing/`: language parsing and file-modification policy
- `prompts/templates/`: reusable user task templates

Architecture notes:

- `docs/architecture/prompt-architecture.md`

## Suggested Next Steps

1. Add provider auto-discovery and model listing endpoints.
2. Add diff-based file editing tools and approval flow.
3. Add integration tests for runtime API stream events and provider adapters.
4. Add Webview chat UI for richer streamed rendering and tool traces.
