
      (() => {
        const vscode = acquireVsCodeApi();

        const state = {
          mode: "agent",
          permissionMode: "defaultApproval",
          busy: false,
          assistantMessageId: null,
          activeSessionId: null,
          statusResetTimer: null,
          traceIds: new Set(),
          planSteps: [],
          followUpQuestions: [],
          historySessions: [],
          historyLoading: false,
          historyError: "",
          historyFilterQuery: ""
        };

        const statusPill = document.getElementById("status-pill");
        const conversation = document.getElementById("conversation");
        const traceList = document.getElementById("trace-list");
        const traceEmpty = document.getElementById("trace-empty");
        const promptInput = document.getElementById("prompt");
        const sendButton = document.getElementById("send");
        const planList = document.getElementById("plan-list");
        const planEmpty = document.getElementById("plan-empty");
        const followUpPanel = document.getElementById("follow-up-panel");
        const followUpList = document.getElementById("follow-up-list");
        const newConversationButton = document.getElementById("new-conversation");
        const continueCommandButton = document.getElementById("continue-command");
        const stopCommandButton = document.getElementById("stop-command");
        const openLatestDiffButton = document.getElementById("open-latest-diff");
        const acceptLatestDiffButton = document.getElementById("accept-latest-diff");
        const rejectLatestDiffButton = document.getElementById("reject-latest-diff");
        const refreshHistoryButton = document.getElementById("refresh-history");
        const historySearchInput = document.getElementById("history-search");
        const historyMeta = document.getElementById("history-meta");
        const historyList = document.getElementById("history-list");
        const historyEmpty = document.getElementById("history-empty");
        const approvalModeSelect = document.getElementById("approval-mode");
        const sideRail = document.getElementById("side-rail");
        const toggleSideRailButton = document.getElementById("toggle-side-rail");

        if (toggleSideRailButton && sideRail) {
          toggleSideRailButton.addEventListener("click", () => {
            const willShow = sideRail.hasAttribute("hidden");
            if (willShow) {
              sideRail.removeAttribute("hidden");
              toggleSideRailButton.setAttribute("aria-pressed", "true");
            } else {
              sideRail.setAttribute("hidden", "");
              toggleSideRailButton.setAttribute("aria-pressed", "false");
            }
          });
        }

        const modeButtons = {
          agent: document.getElementById("mode-agent"),
          chat: document.getElementById("mode-chat"),
          plan: document.getElementById("mode-plan")
        };

        const contextFields = {
          workspace: document.getElementById("context-workspace"),
          file: document.getElementById("context-file"),
          selection: document.getElementById("context-selection"),
          runtime: document.getElementById("context-runtime")
        };

        const quickButtons = Array.from(document.querySelectorAll(".quick"));
        const contextButtons = Array.from(document.querySelectorAll(".context-btn"));

        function setStatus(text) {
          statusPill.textContent = text;
        }

        function pulseStatus(text) {
          setStatus(text);

          if (state.statusResetTimer) {
            clearTimeout(state.statusResetTimer);
          }

          state.statusResetTimer = setTimeout(() => {
            if (!state.busy) {
              setStatus("Idle");
            }
          }, 1300);
        }

        function scrollToBottom(container) {
          container.scrollTop = container.scrollHeight;
        }

        function findBubbleById(messageId) {
          if (!messageId) {
            return null;
          }

          const bubbles = conversation.querySelectorAll(".bubble");
          for (const bubble of bubbles) {
            if (bubble.dataset.messageId === messageId) {
              return bubble;
            }
          }

          return null;
        }

        function createBubble(role, text, messageId, variant) {
          const bubble = document.createElement("article");
          bubble.className = "bubble " + role;
          bubble.textContent = text;

          if (messageId) {
            bubble.dataset.messageId = messageId;
          }

          if (role === "assistant" && variant === "error") {
            bubble.classList.add("error");
          }

          conversation.appendChild(bubble);
          scrollToBottom(conversation);
          return bubble;
        }

        function upsertAssistantMessage(messageId, text, variant, append) {
          let bubble = findBubbleById(messageId);
          if (!bubble) {
            bubble = createBubble("assistant", "", messageId, variant);
          }

          if (append) {
            if (bubble.textContent === "Thinking...") {
              bubble.textContent = "";
            }
            bubble.textContent += text;
          } else {
            bubble.textContent = text;
          }

          bubble.classList.toggle("error", variant === "error");
          state.assistantMessageId = messageId || state.assistantMessageId;
          scrollToBottom(conversation);
        }

        function normalizePlanStatus(status) {
          const normalized = String(status || "pending").toLowerCase();

          if (normalized === "in_progress") {
            return "in_progress";
          }

          if (normalized === "completed" || normalized === "done") {
            return "completed";
          }

          return "pending";
        }

        function planStatusLabel(status) {
          if (status === "in_progress") {
            return "In Progress";
          }

          if (status === "completed") {
            return "Completed";
          }

          return "Pending";
        }

        function renderPlan() {
          planList.innerHTML = "";

          if (!Array.isArray(state.planSteps) || state.planSteps.length === 0) {
            planEmpty.style.display = "block";
            return;
          }

          planEmpty.style.display = "none";

          state.planSteps
            .slice()
            .sort((left, right) => left.step - right.step)
            .forEach((step) => {
              const item = document.createElement("li");
              item.className = "plan-item";

              const label = document.createElement("span");
              label.className = "plan-step";
              label.textContent = step.step + ". " + String(step.title || "Untitled step");

              const badge = document.createElement("span");
              badge.className = "plan-badge " + step.status;
              badge.textContent = planStatusLabel(step.status);

              item.appendChild(label);
              item.appendChild(badge);
              planList.appendChild(item);
            });
        }

        function clearPlan() {
          state.planSteps = [];
          renderPlan();
        }

        function upsertPlanStep(step) {
          const index = Number(step && step.step);
          if (!Number.isFinite(index) || index <= 0) {
            return;
          }

          const normalized = {
            step: index,
            title: String((step && step.title) || "Untitled step"),
            status: normalizePlanStatus(step && step.status)
          };

          const existingIndex = state.planSteps.findIndex((candidate) => candidate.step === index);
          if (existingIndex >= 0) {
            state.planSteps[existingIndex] = normalized;
          } else {
            state.planSteps.push(normalized);
          }

          renderPlan();
        }

        function parseFollowUpQuestions(messageText) {
          const text = String(messageText || "");
          if (!text.trim()) {
            return [];
          }

          const lines = text
            .split(/\r?\n/)
            .map((line) => line.trim())
            .filter(Boolean);

          const bulletQuestions = lines
            .filter((line) => line.startsWith("- "))
            .map((line) => line.slice(2).trim())
            .filter((line) => line.length > 0);

          if (bulletQuestions.length > 0) {
            return bulletQuestions;
          }

          const numberedQuestions = lines
            .map((line) => {
              const match = /^\d+[.)]\s+(.+)$/.exec(line);
              return match ? match[1].trim() : "";
            })
            .filter((line) => line.length > 0);

          return numberedQuestions;
        }

        function renderFollowUpPanel() {
          followUpList.innerHTML = "";

          if (!Array.isArray(state.followUpQuestions) || state.followUpQuestions.length === 0) {
            followUpPanel.hidden = true;
            return;
          }

          followUpPanel.hidden = false;
          state.followUpQuestions.forEach((question) => {
            const item = document.createElement("button");
            item.type = "button";
            item.className = "follow-up-item";
            item.textContent = question;
            item.addEventListener("click", () => {
              const current = promptInput.value.trim();
              const prefix = current.length > 0 ? "\n" : "";
              promptInput.value = promptInput.value + prefix + "- " + question + "\n  Answer: ";
              promptInput.focus();
              promptInput.selectionStart = promptInput.selectionEnd = promptInput.value.length;
            });
            followUpList.appendChild(item);
          });
        }

        function setFollowUpQuestions(questions) {
          const normalized = Array.isArray(questions)
            ? questions.map((question) => String(question || "").trim()).filter(Boolean)
            : [];

          state.followUpQuestions = normalized;
          renderFollowUpPanel();
        }

        function clearFollowUpQuestions() {
          state.followUpQuestions = [];
          renderFollowUpPanel();
        }

        function setMode(mode) {
          const normalized = mode === "chat" || mode === "plan" ? mode : "agent";
          state.mode = normalized;
          modeButtons.agent.classList.toggle("active", normalized === "agent");
          modeButtons.chat.classList.toggle("active", normalized === "chat");
          modeButtons.plan.classList.toggle("active", normalized === "plan");
          promptInput.placeholder =
            normalized === "agent"
              ? "Describe what you want the local agent to do..."
              : normalized === "plan"
                ? "Describe the goal and constraints to generate a step-by-step todo plan..."
                : "Ask a question or discuss an implementation approach...";
        }

        function isPermissionMode(mode) {
          return (
            mode === "defaultApproval" ||
            mode === "bypassApproval" ||
            mode === "autopilot"
          );
        }

        function permissionModeLabel(mode) {
          if (mode === "bypassApproval") {
            return "Bypass Approvals";
          }

          if (mode === "autopilot") {
            return "Autopilot";
          }

          return "Default Approvals";
        }

        function setPermissionMode(mode) {
          const normalized = isPermissionMode(mode) ? mode : "defaultApproval";
          state.permissionMode = normalized;

          if (approvalModeSelect && approvalModeSelect.value !== normalized) {
            approvalModeSelect.value = normalized;
          }

          const runtimeValue = String(contextFields.runtime.textContent || "");
          if (runtimeValue.includes(" | timeout ")) {
            const base = runtimeValue.split(" | approvals ")[0];
            contextFields.runtime.textContent =
              base + " | approvals " + permissionModeLabel(normalized);
          }
        }

        function setBusy(busy) {
          state.busy = busy;
          sendButton.disabled = busy;
          promptInput.disabled = busy;
          quickButtons.forEach((button) => {
            button.disabled = busy;
          });
          contextButtons.forEach((button) => {
            button.disabled = busy;
          });
          newConversationButton.disabled = busy;
          continueCommandButton.disabled = busy;
          stopCommandButton.disabled = busy;
          openLatestDiffButton.disabled = busy;
          acceptLatestDiffButton.disabled = busy;
          rejectLatestDiffButton.disabled = busy;
          refreshHistoryButton.disabled = busy || state.historyLoading;
          historySearchInput.disabled = busy;
          approvalModeSelect.disabled = busy;

          const historyItems = historyList.querySelectorAll(".history-item");
          historyItems.forEach((item) => {
            item.classList.toggle("disabled", Boolean(busy || state.historyLoading));
          });

          const historyActionButtons = historyList.querySelectorAll(".history-action-btn");
          historyActionButtons.forEach((button) => {
            button.disabled = Boolean(busy || state.historyLoading);
          });

          if (busy) {
            setStatus("Running");
          } else if (statusPill.textContent === "Running") {
            setStatus("Idle");
          }
        }

        function setContext(context) {
          if (!context) {
            contextFields.workspace.textContent = "No workspace open";
            contextFields.file.textContent = "—";
            contextFields.selection.textContent = "—";
            contextFields.runtime.textContent = "Not connected";
            return;
          }

          contextFields.workspace.textContent = context.workspaceRoot || "Not resolved";
          contextFields.file.textContent = context.activeFilePath || "No active file";
          contextFields.selection.textContent = context.hasSelection
            ? context.selectionPreview
            : "No active selection";

          const permissionMode = isPermissionMode(context.permissionMode)
            ? context.permissionMode
            : "defaultApproval";
          setPermissionMode(permissionMode);

          contextFields.runtime.textContent =
            context.runtimeUrl +
            " | timeout " +
            context.timeoutMs +
            "ms | dryRun " +
            context.dryRun +
            " | approvals " +
            permissionModeLabel(permissionMode);
        }

        function toHistoryTimeLabel(isoValue) {
          const parsed = Date.parse(String(isoValue || ""));
          if (!Number.isFinite(parsed)) {
            return "";
          }

          const date = new Date(parsed);
          return date.toLocaleString([], {
            month: "short",
            day: "numeric",
            hour: "2-digit",
            minute: "2-digit"
          });
        }

        function toHistoryGroup(isoValue) {
          const parsed = Date.parse(String(isoValue || ""));
          if (!Number.isFinite(parsed)) {
            return "Older";
          }

          const now = new Date();
          const startOfToday = new Date(
            now.getFullYear(),
            now.getMonth(),
            now.getDate()
          ).getTime();
          const startOfYesterday = startOfToday - 24 * 60 * 60 * 1000;

          if (parsed >= startOfToday) {
            return "Today";
          }

          if (parsed >= startOfYesterday) {
            return "Yesterday";
          }

          return "Older";
        }

        function toHistorySessionTitle(session) {
          const title = String(session && session.title ? session.title : "").trim();
          if (title) {
            return title;
          }

          const fallback = String(session && session.lastMessage ? session.lastMessage : "").trim();
          if (fallback) {
            return fallback;
          }

          return "Untitled session";
        }

        function toHistorySessionPreview(session) {
          const text = String(session && session.lastMessage ? session.lastMessage : "")
            .replace(/\s+/g, " ")
            .trim();

          if (!text) {
            return "No captured messages yet.";
          }

          return text.length > 140 ? text.slice(0, 137) + "..." : text;
        }

        function toHistorySessionSearchText(session) {
          const title = toHistorySessionTitle(session);
          const preview = toHistorySessionPreview(session);
          const mode = String(session && session.mode ? session.mode : "agent");
          return [title, preview, mode].join(" ").toLowerCase();
        }

        function requestOpenHistorySession(sessionId) {
          if (state.busy || state.historyLoading) {
            return;
          }

          state.activeSessionId = sessionId;
          state.historyLoading = true;
          state.historyError = "";
          renderHistorySessions();
          historyMeta.textContent = "Loading selected session...";

          vscode.postMessage({
            type: "openHistorySession",
            sessionId
          });
        }

        function createHistorySessionItem(session) {
          const sessionId = String(session && session.id ? session.id : "").trim();
          if (!sessionId) {
            return null;
          }

          const item = document.createElement("article");
          item.className = "history-item";
          item.dataset.sessionId = sessionId;
          if (state.activeSessionId && state.activeSessionId === sessionId) {
            item.classList.add("active");
          }

          const row = document.createElement("div");
          row.className = "history-item-row";

          const title = document.createElement("div");
          title.className = "history-item-title";
          title.textContent = toHistorySessionTitle(session);

          const time = document.createElement("div");
          time.className = "history-item-time";
          time.textContent = toHistoryTimeLabel(session && session.updatedAt);

          row.appendChild(title);
          row.appendChild(time);

          const mode = String(session && session.mode ? session.mode : "agent").toUpperCase();
          const count = Number(session && session.messageCount ? session.messageCount : 0);
          const meta = document.createElement("div");
          meta.className = "history-item-meta";
          meta.textContent = mode + " • " + count + " message" + (count === 1 ? "" : "s");

          const preview = document.createElement("div");
          preview.className = "history-item-preview";
          preview.textContent = toHistorySessionPreview(session);

          const actions = document.createElement("div");
          actions.className = "history-item-actions";

          const renameButton = document.createElement("button");
          renameButton.type = "button";
          renameButton.className = "history-action-btn";
          renameButton.textContent = "Rename";
          renameButton.disabled = Boolean(state.busy || state.historyLoading);
          renameButton.addEventListener("click", (event) => {
            event.stopPropagation();

            if (state.busy || state.historyLoading) {
              return;
            }

            const currentTitle = toHistorySessionTitle(session);
            const nextTitle = window.prompt("Rename session", currentTitle);
            if (nextTitle === null) {
              return;
            }

            const normalizedTitle = nextTitle.trim();
            if (!normalizedTitle || normalizedTitle === currentTitle) {
              return;
            }

            state.historyLoading = true;
            state.historyError = "";
            renderHistorySessions();
            historyMeta.textContent = "Renaming session...";

            vscode.postMessage({
              type: "renameHistorySession",
              sessionId,
              title: normalizedTitle
            });
          });

          const deleteButton = document.createElement("button");
          deleteButton.type = "button";
          deleteButton.className = "history-action-btn danger";
          deleteButton.textContent = "Delete";
          deleteButton.disabled = Boolean(state.busy || state.historyLoading);
          deleteButton.addEventListener("click", (event) => {
            event.stopPropagation();

            if (state.busy || state.historyLoading) {
              return;
            }

            const confirmed = window.confirm("Delete this session and its saved history?");
            if (!confirmed) {
              return;
            }

            state.historyLoading = true;
            state.historyError = "";
            renderHistorySessions();
            historyMeta.textContent = "Deleting session...";

            vscode.postMessage({
              type: "deleteHistorySession",
              sessionId
            });
          });

          actions.appendChild(renameButton);
          actions.appendChild(deleteButton);

          item.appendChild(row);
          item.appendChild(meta);
          item.appendChild(preview);
          item.appendChild(actions);

          if (state.busy || state.historyLoading) {
            item.classList.add("disabled");
          }

          item.addEventListener("click", () => {
            requestOpenHistorySession(sessionId);
          });

          return item;
        }

        function renderHistorySessions() {
          historyList.innerHTML = "";
          historyList.appendChild(historyEmpty);

          const sessions = Array.isArray(state.historySessions) ? state.historySessions : [];
          const normalizedQuery = String(state.historyFilterQuery || "").trim().toLowerCase();
          const filteredSessions = normalizedQuery
            ? sessions.filter((session) =>
                toHistorySessionSearchText(session).includes(normalizedQuery)
              )
            : sessions;

          if (!sessions.length) {
            historyEmpty.textContent = "No sessions yet. Start a conversation to populate history.";
            historyEmpty.style.display = "block";
          } else if (!filteredSessions.length) {
            historyEmpty.textContent = "No sessions match this search.";
            historyEmpty.style.display = "block";
          } else {
            historyEmpty.style.display = "none";

            const grouped = {
              Today: [],
              Yesterday: [],
              Older: []
            };

            filteredSessions.forEach((session) => {
              const group = toHistoryGroup(session && session.updatedAt);
              grouped[group].push(session);
            });

            ["Today", "Yesterday", "Older"].forEach((groupName) => {
              const items = grouped[groupName];
              if (!Array.isArray(items) || items.length === 0) {
                return;
              }

              const groupContainer = document.createElement("section");
              groupContainer.className = "history-group";

              const groupTitle = document.createElement("div");
              groupTitle.className = "history-group-title";
              groupTitle.textContent = groupName;
              groupContainer.appendChild(groupTitle);

              items.forEach((session) => {
                const item = createHistorySessionItem(session);
                if (item) {
                  groupContainer.appendChild(item);
                }
              });

              historyList.appendChild(groupContainer);
            });
          }

          if (state.historyLoading) {
            historyMeta.textContent = "Loading sessions...";
          } else if (state.historyError) {
            historyMeta.textContent = "History unavailable: " + state.historyError;
          } else {
            if (!sessions.length) {
              historyMeta.textContent = "No sessions yet for this workspace.";
            } else if (!filteredSessions.length) {
              historyMeta.textContent = "No matches for the current search.";
            } else if (filteredSessions.length === sessions.length) {
              historyMeta.textContent =
                sessions.length + " recent session" + (sessions.length === 1 ? "" : "s");
            } else {
              historyMeta.textContent =
                "Showing " +
                filteredSessions.length +
                " of " +
                sessions.length +
                " sessions";
            }
          }

          refreshHistoryButton.disabled = Boolean(state.busy || state.historyLoading);
        }

        function setHistorySessions(sessions, currentSessionId, loading, error) {
          state.historySessions = Array.isArray(sessions) ? sessions : [];
          const normalizedSessionId =
            typeof currentSessionId === "string" ? currentSessionId.trim() : "";
          state.activeSessionId = normalizedSessionId || null;
          state.historyLoading = Boolean(loading);
          state.historyError = String(error || "").trim();

          if (historySearchInput && historySearchInput.value !== state.historyFilterQuery) {
            historySearchInput.value = state.historyFilterQuery;
          }

          renderHistorySessions();
        }

        function formatTime(createdAt) {
          if (typeof createdAt !== "number") {
            return "";
          }

          return new Date(createdAt).toLocaleTimeString();
        }

        function createTraceCard(trace) {
          const card = document.createElement("article");
          card.className = "trace-card " + String(trace.kind || "");
          card.dataset.traceId = String(trace.id || "");

          const row = document.createElement("div");
          row.className = "trace-row";

          const title = document.createElement("div");
          title.className = "trace-name";
          title.textContent = String(trace.title || "trace");

          const meta = document.createElement("div");
          meta.className = "trace-meta";
          meta.textContent = String(trace.kind || "event") + " | " + formatTime(trace.createdAt);

          row.appendChild(title);
          row.appendChild(meta);

          const preview = document.createElement("div");
          preview.className = "trace-preview";
          preview.textContent = String(trace.preview || "(no preview)");

          const actions = document.createElement("div");
          actions.className = "trace-actions";

          const copyButton = document.createElement("button");
          copyButton.type = "button";
          copyButton.className = "copy-btn";
          copyButton.textContent = "Copy Payload";
          copyButton.addEventListener("click", () => {
            vscode.postMessage({
              type: "copyPayload",
              payload: String(trace.payload || "")
            });
          });

          actions.appendChild(copyButton);

          const details = document.createElement("details");
          details.className = "trace-details";

          const summary = document.createElement("summary");
          summary.textContent = "Payload";

          const payload = document.createElement("pre");
          payload.textContent = String(trace.payload || "");

          details.appendChild(summary);
          details.appendChild(payload);

          card.appendChild(row);
          card.appendChild(preview);
          card.appendChild(actions);
          card.appendChild(details);

          return card;
        }

        function updateTraceEmptyState() {
          traceEmpty.style.display = state.traceIds.size === 0 ? "block" : "none";
        }

        function addTrace(trace) {
          if (!trace || !trace.id || state.traceIds.has(trace.id)) {
            return;
          }

          state.traceIds.add(trace.id);
          traceList.appendChild(createTraceCard(trace));
          updateTraceEmptyState();
          scrollToBottom(traceList);
        }

        function renderHistory(conversationEntries, traceEntries) {
          conversation.innerHTML = "";
          traceList.innerHTML = "";
          traceList.appendChild(traceEmpty);

          state.traceIds = new Set();
          state.assistantMessageId = null;

          const safeConversation = Array.isArray(conversationEntries) ? conversationEntries : [];
          safeConversation.forEach((entry) => {
            const role = entry.role === "user" ? "user" : "assistant";
            const variant = entry.variant === "error" ? "error" : "default";
            createBubble(role, String(entry.text || ""), String(entry.id || ""), variant);
            if (role === "assistant") {
              state.assistantMessageId = String(entry.id || "");
            }
          });

          const safeTraces = Array.isArray(traceEntries) ? traceEntries : [];
          safeTraces.forEach((trace) => {
            addTrace(trace);
          });

          updateTraceEmptyState();
        }

        function setContextPending(kind, pending) {
          const button = contextButtons.find((candidate) => candidate.dataset.contextKind === kind);
          if (!button) {
            return;
          }

          button.classList.toggle("pending", pending);
          button.disabled = pending || state.busy;
        }

        function appendContextBlock(label, content) {
          const safeLabel = String(label || "Context");
          const safeContent = String(content || "").trim();
          if (!safeContent) {
            return;
          }

          const block = "### " + safeLabel + "\n" + safeContent;
          const prefix = promptInput.value.trim().length > 0 ? "\n\n" : "";
          promptInput.value = promptInput.value + prefix + block;
          promptInput.focus();
          promptInput.selectionStart = promptInput.selectionEnd = promptInput.value.length;
        }

        document.getElementById("composer").addEventListener("submit", (event) => {
          event.preventDefault();

          if (state.busy) {
            return;
          }

          const prompt = promptInput.value.trim();
          if (!prompt) {
            return;
          }

          vscode.postMessage({
            type: "submitPrompt",
            mode: state.mode,
            prompt
          });

          promptInput.value = "";
          autosizeTextarea();
        });

        function autosizeTextarea() {
          promptInput.style.height = "auto";
          const next = Math.min(promptInput.scrollHeight, 220);
          promptInput.style.height = next + "px";
        }

        promptInput.addEventListener("input", autosizeTextarea);

        promptInput.addEventListener("keydown", (event) => {
          // Cmd/Ctrl + Enter submits the form.
          if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
            event.preventDefault();
            const form = document.getElementById("composer");
            if (form && typeof form.requestSubmit === "function") {
              form.requestSubmit();
            } else if (sendButton) {
              sendButton.click();
            }
          }
        });

        modeButtons.agent.addEventListener("click", () => {
          if (state.busy) {
            return;
          }

          setMode("agent");
          vscode.postMessage({ type: "setMode", mode: "agent" });
        });

        modeButtons.chat.addEventListener("click", () => {
          if (state.busy) {
            return;
          }

          setMode("chat");
          vscode.postMessage({ type: "setMode", mode: "chat" });
        });

        modeButtons.plan.addEventListener("click", () => {
          if (state.busy) {
            return;
          }

          setMode("plan");
          vscode.postMessage({ type: "setMode", mode: "plan" });
        });

        newConversationButton.addEventListener("click", () => {
          if (state.busy) {
            return;
          }

          vscode.postMessage({ type: "newConversation" });
        });

        refreshHistoryButton.addEventListener("click", () => {
          if (state.busy) {
            return;
          }

          state.historyLoading = true;
          renderHistorySessions();
          vscode.postMessage({ type: "refreshHistory" });
        });

        historySearchInput.addEventListener("input", () => {
          state.historyFilterQuery = String(historySearchInput.value || "");
          renderHistorySessions();
        });

        continueCommandButton.addEventListener("click", () => {
          if (state.busy) {
            return;
          }

          vscode.postMessage({ type: "continueCommand" });
        });

        stopCommandButton.addEventListener("click", () => {
          if (state.busy) {
            return;
          }

          vscode.postMessage({ type: "stopCommand" });
        });

        approvalModeSelect.addEventListener("change", () => {
          if (state.busy) {
            return;
          }

          const selectedMode = String(approvalModeSelect.value || "");
          if (!isPermissionMode(selectedMode)) {
            setPermissionMode("defaultApproval");
            return;
          }

          setPermissionMode(selectedMode);
          vscode.postMessage({ type: "setPermissionMode", mode: selectedMode });
          pulseStatus("Approvals set to " + permissionModeLabel(selectedMode));
        });

        openLatestDiffButton.addEventListener("click", () => {
          vscode.postMessage({ type: "openLatestDiff" });
        });

        acceptLatestDiffButton.addEventListener("click", () => {
          if (state.busy) {
            return;
          }

          vscode.postMessage({ type: "acceptLatestDiff" });
        });

        rejectLatestDiffButton.addEventListener("click", () => {
          if (state.busy) {
            return;
          }

          vscode.postMessage({ type: "rejectLatestDiff" });
        });

        quickButtons.forEach((button) => {
          button.addEventListener("click", () => {
            const quick = button.getAttribute("data-quick") || "";
            promptInput.value = quick;
            promptInput.focus();
          });
        });

        contextButtons.forEach((button) => {
          button.addEventListener("click", () => {
            if (state.busy) {
              return;
            }

            const kind = button.dataset.contextKind;
            if (!kind) {
              return;
            }

            vscode.postMessage({
              type: "insertContext",
              kind
            });
          });
        });

        window.addEventListener("message", (event) => {
          const message = event.data;

          switch (message.type) {
            case "context-sync":
              setContext(message.context);
              break;
            case "hydrate":
              if (message.mode) {
                setMode(message.mode);
              }
              setContext(message.context);
              state.activeSessionId = String(message.currentSessionId || "") || null;
              renderHistory(message.conversation, message.traces);
              clearPlan();
              clearFollowUpQuestions();
              pulseStatus("Studio ready");
              break;
            case "history-sync":
              state.activeSessionId = String(message.currentSessionId || "") || null;
              renderHistory(message.conversation, message.traces);
              clearPlan();
              clearFollowUpQuestions();
              break;
            case "history-sessions":
              setHistorySessions(
                message.sessions,
                message.currentSessionId,
                Boolean(message.loading),
                message.error
              );
              break;
            case "mode":
              setMode(message.mode);
              break;
            case "permission-mode":
              setPermissionMode(message.mode);
              break;
            case "busy":
              setBusy(Boolean(message.busy));
              break;
            case "run-started":
              setMode(String(message.mode || state.mode));
              setContext(message.context);
              clearPlan();
              clearFollowUpQuestions();
              createBubble(
                "user",
                String(message.prompt || ""),
                String(message.userMessageId || ""),
                "default"
              );
              createBubble(
                "assistant",
                "Thinking...",
                String(message.assistantMessageId || ""),
                "default"
              );
              state.assistantMessageId = String(message.assistantMessageId || "");
              break;
            case "stream-status":
              setStatus(String(message.status || "Running"));
              break;
            case "stream-plan":
              if (message.step) {
                upsertPlanStep(message.step);
              }
              break;
            case "stream-observation": {
              const observation = message.observation || {};
              const source = String(observation.source || "");
              const observationMessage = String(observation.message || "");

              if (source === "tool.ask_follow_up_question") {
                const questions = parseFollowUpQuestions(observationMessage);
                if (questions.length > 0) {
                  setFollowUpQuestions(questions);
                  pulseStatus("Follow-up questions ready");
                }
              }

              break;
            }
            case "stream-token": {
              const assistantMessageId = String(
                message.assistantMessageId || state.assistantMessageId || ""
              );
              if (!assistantMessageId) {
                break;
              }

              upsertAssistantMessage(assistantMessageId, String(message.token || ""), "default", true);
              break;
            }
            case "run-complete": {
              const assistantMessageId = String(
                message.assistantMessageId || state.assistantMessageId || ""
              );
              const response = message.response || {};
              const responseSessionId = String(response.sessionId || "").trim();
              if (responseSessionId) {
                state.activeSessionId = responseSessionId;
                renderHistorySessions();
              }
              const responsePlan = Array.isArray(response.plan) ? response.plan : [];
              responsePlan.forEach((step) => {
                upsertPlanStep(step);
              });

              if (String(response.status || "") === "needs_follow_up") {
                const questions = parseFollowUpQuestions(response.finalMessage);
                if (questions.length > 0) {
                  setFollowUpQuestions(questions);
                }
              } else {
                clearFollowUpQuestions();
              }

              const fallbackMessage = String(response.finalMessage || "Completed.");
              const existing = findBubbleById(assistantMessageId);

              if (
                !existing ||
                !existing.textContent.trim() ||
                existing.textContent === "Thinking..."
              ) {
                upsertAssistantMessage(assistantMessageId, fallbackMessage, "default", false);
              }

              setStatus("Idle");
              break;
            }
            case "run-error": {
              const assistantMessageId = String(
                message.assistantMessageId || state.assistantMessageId || ""
              );
              upsertAssistantMessage(
                assistantMessageId,
                String(message.message || "Runtime error"),
                "error",
                false
              );
              clearFollowUpQuestions();
              setStatus("Error");
              break;
            }
            case "trace-add":
              addTrace(message.trace);
              break;
            case "payload-copy-result":
              if (message.ok) {
                pulseStatus("Payload copied");
              } else {
                pulseStatus("Copy failed");
              }
              break;
            case "insert-context-pending":
              setContextPending(String(message.kind || ""), Boolean(message.pending));
              break;
            case "insert-context-result":
              if (message.ok) {
                appendContextBlock(message.label, message.content);
                pulseStatus("Context inserted");
              } else {
                pulseStatus("Context unavailable");
              }
              break;
            case "focus-input":
              promptInput.focus();
              break;
            case "status-announcement":
              pulseStatus(String(message.text || "Status updated"));
              break;
            default:
              break;
          }
        });

        setMode(state.mode);
        setPermissionMode(state.permissionMode);
        renderHistorySessions();
        setBusy(false);
        vscode.postMessage({ type: "ready" });
      })();

