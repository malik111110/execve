# Getting Started

## Prerequisites

- Go 1.22+
- Node.js 20+
- VS Code

## 1. Run the Runtime

```bash
cd runtime
go run ./cmd/agentd
```

Choose a local model provider by environment variable:

```bash
# default
AGENT_PROVIDER=mock go run ./cmd/agentd

# ollama
AGENT_ALLOW_COMMANDS=true AGENT_PROVIDER=ollama OLLAMA_MODEL=llama3.2:3b go run ./cmd/agentd

# lm studio
AGENT_ALLOW_COMMANDS=true AGENT_PROVIDER=lmstudio LMSTUDIO_MODEL=local-model go run ./cmd/agentd
```

Health check endpoint:

```bash
curl http://127.0.0.1:8080/healthz
```

## 2. Build Extension

```bash
cd extension
npm install
npm run build
```

## 3. Launch Extension Host

1. Open this workspace in VS Code.
2. Press `F5` to launch Extension Development Host.
3. Run command: `Local Agent: Start Session`.

## 4. Try an End-to-End Request

With runtime running, execute command in extension host and submit a prompt.

Expected result:

- output channel `Local LLM Agent` streams status/plan/tool observations/tokens in real time
- notification appears with response summary

## 5. Real File Actions

To let the agent actually create files (instead of simulation), set:

- `localAgent.dryRun = false`

If `localAgent.dryRun = true`, write actions are simulated and no files are changed.

## 6. Agent Mode vs Chat Mode

Use extension setting `localAgent.mode`:

- `agent` (default): runtime prioritizes deterministic tool execution first (create file, execute command, command output to markdown file)
- `chat`: runtime skips deterministic actions and prioritizes conversational model output

This lets you switch between reliable action execution and pure chat behavior.

## 7. API Endpoints

- `POST /v1/agent/run`: non-streaming JSON response
- `POST /v1/agent/stream`: SSE stream with `status`, `plan`, `observation`, `token`, `done` events

## 8. Command Execution

When `AGENT_ALLOW_COMMANDS=true`, the runtime can execute deterministic command requests via `execute_command`.

Example prompt:

- `run command "cd extension && npm run build"`

Example prompt for deterministic command output file creation:

- `excute ls commands on the root of the project and make the results on markdown file called resultsoftest.md in the root of the project`
