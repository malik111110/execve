# 🧠 Local LLM Coding Agent for VS Code (Go-Based)

## 1. Overview

This project aims to build a **local-first coding agent** integrated into VS Code, powered by local LLMs (Ollama, MLX, GGUF, etc.), with a focus on:

* Deterministic behavior (no “magic agent hallucinations”)
* High performance (low latency, efficient context handling)
* Full local execution (privacy + control)
* Practical developer workflows (not just chat)

---

## 2. High-Level Architecture

```
[ VS Code Extension (TypeScript) ]
              ↓
[ Go Agent Runtime (Core Logic) ]
              ↓
[ Model Provider Layer ]
              ↓
[ Tools Layer (FS, Git, Terminal, AST) ]
```

---

## 3. Core Components

### 3.1 VS Code Extension (Frontend)

**Responsibilities:**

* UI (chat panel, diff preview, logs)
* Capture context (open files, selection, workspace)
* Send structured requests to Go backend

**Tech:**

* TypeScript
* VS Code Extension API
* Webview (for advanced UI)

---

### 3.2 Go Agent Runtime (Backend)

This is the **brain** of the system.

**Responsibilities:**

* Agent loop execution
* Context management
* Tool orchestration
* Communication with LLM providers

**Design Principles:**

* Deterministic steps
* Observable behavior (logs, traces)
* No hidden reasoning

---

### 3.3 Model Provider Layer

Abstracts different local model backends.

**Supported Backends:**

* Ollama (REST API)
* MLX (custom server)
* GGUF (llama.cpp server)
* OpenAI-compatible APIs (optional)

**Interface Example:**

```go
type LLMProvider interface {
    Generate(prompt string, opts GenerateOptions) (<-chan StreamChunk, error)
}
```

---

### 3.4 Tools Layer

This transforms the system from a chatbot into a **real coding agent**.

**Minimum Tools:**

* File Reader
* File Writer (diff-based)
* Code Search (ripgrep-style)
* Git Diff
* Terminal Execution (sandboxed)

**Advanced Tools:**

* AST parsing (Tree-sitter)
* Test runner integration
* Dependency graph analysis

---

## 4. Agent Execution Model

### 4.1 Deterministic Agent Loop

```
1. Receive request
2. Gather context
3. Generate plan (LLM)
4. Execute tool
5. Observe result
6. Repeat until done
```

### 4.2 Key Rules

* No blind execution
* Every action must be verified
* Tools return structured outputs (JSON)
* LLM reasons on real data, not assumptions

---

## 5. Context Management Strategy

### Problem:

LLMs fail when context is too large or irrelevant.

### Solution:

* File chunking
* Semantic + keyword search
* AST-aware extraction
* Only include relevant code sections

---

## 6. Code Modification Strategy

### ❌ Avoid:

* Overwriting full files

### ✅ Use:

* Diff-based updates

Example:

```diff
- old line
+ new line
```

**Workflow:**

1. Generate diff
2. Show preview in VS Code
3. Apply after user validation

---

## 7. Communication Layer

### VS Code ↔ Go Runtime

Options:

* REST API (simple, reliable)
* WebSocket (streaming, real-time)
* gRPC (structured, performant)

**Recommended MVP:**
→ REST + streaming (chunked responses)

---

## 8. MVP Scope

### Phase 1 (Core)

* Chat with local LLM
* Inject current file context
* Generate code edits
* Diff preview + apply

### Phase 2 (Enhanced)

* Multi-file context
* Code search integration
* Basic agent loop

### Phase 3 (Advanced)

* Autonomous workflows:

  * Fix bugs
  * Refactor modules
  * Generate tests

---

## 9. Performance Considerations

* Streaming responses
* Context size optimization
* Model selection (quantized vs full)
* Caching embeddings / search results

---

## 10. Security Considerations

* Sandbox terminal execution
* Restrict file system access
* Validate all tool inputs
* Avoid executing arbitrary LLM outputs

---

## 11. Future Enhancements

* Multi-agent collaboration
* Fine-tuned local models
* IDE telemetry for smarter context
* Integration with CI/CD pipelines

---

## 12. Project Goals

This is not:

* A simple chatbot in VS Code
* A clone of Copilot

This is:

* A **local-first coding agent**
* A **controlled AI system**
* A **developer productivity tool built on real engineering principles**

---

## 13. Suggested Project Structure

```
/project-root
  /extension        # VS Code extension (TS)
  /runtime          # Go backend
    /agent
    /providers
    /tools
    /context
  /api              # shared schemas
  /docs             # documentation
```

---

## 14. Final Notes

Focus on:

* Simplicity first
* Observability (logs > magic)
* Control over autonomy

Avoid:

* Overengineering
* Premature multi-agent systems
* “AI hype features” with no real utility

```
```
