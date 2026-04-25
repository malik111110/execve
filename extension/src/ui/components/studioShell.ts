import { renderHistoryPanel } from "./historyPanel";
import { renderPolicySelector } from "./policySelector";
import { renderSessionModeSegment } from "./sessionModeSegment";
import { renderToolTracePanel } from "./toolTracePanel";

/* Top bar — slim, Copilot-style. Only what matters: brand + status, mode segment,
   single overflow menu on the right that hosts approvals + diff/run controls. */
export function renderStudioTopBar(): string {
  return `
      <header class="topbar">
        <div class="brand">
          <div class="mark" aria-hidden="true">LA</div>
          <span class="title">Local Agent</span>
          <span class="status-line" aria-live="polite">
            <span class="dot" aria-hidden="true"></span>
            <span class="status-pill" id="status-pill">Idle</span>
          </span>
        </div>
        <div class="topbar-center">
          ${renderSessionModeSegment()}
        </div>
        <div class="topbar-actions">
          <button id="new-conversation" class="icon-btn" type="button" title="New conversation" aria-label="New conversation">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true">
              <line x1="12" y1="5" x2="12" y2="19"></line>
              <line x1="5" y1="12" x2="19" y2="12"></line>
            </svg>
          </button>
          <button id="toggle-side-rail" class="icon-btn" type="button" title="Toggle side panel" aria-label="Toggle side panel" aria-pressed="false">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <rect x="3" y="5" width="18" height="14" rx="2"></rect>
              <line x1="15" y1="5" x2="15" y2="19"></line>
            </svg>
          </button>
          <details class="overflow-menu">
            <summary class="icon-btn" title="More" aria-label="More actions">
              <span aria-hidden="true">⋯</span>
            </summary>
            <div class="overflow-panel" role="menu">
              <div class="menu-section">
                <div class="menu-section-title">Approvals</div>
                ${renderPolicySelector()}
              </div>
              <div class="menu-sep" aria-hidden="true"></div>
              <button id="continue-command" class="menu-item" type="button">Continue command</button>
              <button id="stop-command" class="menu-item danger" type="button">Stop command</button>
              <div class="menu-sep" aria-hidden="true"></div>
              <button id="open-latest-diff" class="menu-item" type="button">Open latest diff</button>
              <button id="accept-latest-diff" class="menu-item" type="button">Accept diff</button>
              <button id="reject-latest-diff" class="menu-item" type="button">Reject diff</button>
            </div>
          </details>
        </div>
      </header>`;
}

/* One-line context strip immediately under the topbar. */
export function renderStudioContextStrip(): string {
  return `
      <div class="context-strip" aria-label="Session context">
        <span class="ctx-chip"><span class="ctx-key">Workspace</span><span class="ctx-val" id="context-workspace">Resolving…</span></span>
        <span class="ctx-chip"><span class="ctx-key">File</span><span class="ctx-val" id="context-file">—</span></span>
        <span class="ctx-chip"><span class="ctx-key">Selection</span><span class="ctx-val" id="context-selection">—</span></span>
        <span class="ctx-chip"><span class="ctx-key">Runtime</span><span class="ctx-val" id="context-runtime">—</span></span>
      </div>`;
}

export function renderStudioConversation(): string {
  return `
      <main class="thread-wrap" aria-label="Conversation">
        <div class="thread">
          <section
            id="conversation"
            class="conversation"
            aria-label="Conversation transcript"
          ></section>
        </div>
      </main>`;
}

export function renderStudioPlanDrawer(): string {
  return `
      <details class="drawer" id="plan-drawer">
        <summary class="drawer-summary">
          <span class="drawer-label">Plan</span>
          <span class="drawer-hint">Live todos from runtime</span>
          <span class="chev" aria-hidden="true">▾</span>
        </summary>
        <div class="drawer-body">
          <div id="plan-empty" class="hint-block">
            No plan steps yet. Switch to Plan mode to generate structured todos.
          </div>
          <ol id="plan-list" class="plan-list"></ol>
        </div>
      </details>`;
}

export function renderStudioSidePanels(): string {
  return `
      <aside class="side-rail" id="side-rail" hidden>
        <details class="drawer">
          <summary class="drawer-summary">
            <span class="drawer-label">History</span>
            <span class="drawer-hint">Recent sessions</span>
            <span class="chev" aria-hidden="true">▾</span>
          </summary>
          <div class="drawer-body">
            ${renderHistoryPanel()}
          </div>
        </details>
        <details class="drawer">
          <summary class="drawer-summary">
            <span class="drawer-label">Tool Trace</span>
            <span class="drawer-hint">Runtime activity</span>
            <span class="chev" aria-hidden="true">▾</span>
          </summary>
          <div class="drawer-body">
            ${renderToolTracePanel()}
          </div>
        </details>
      </aside>`;
}

export function renderStudioComposerSection(): string {
  return `
      <form id="composer" class="composer">
        <div class="composer-pill">
          <textarea
            id="prompt"
            rows="1"
            placeholder="Ask the local agent anything…  (⌘↵ to run)"
          ></textarea>
          <div class="composer-bar">
            <button id="send" class="send" type="submit" title="Run (⌘↵)" aria-label="Run">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                <line x1="12" y1="19" x2="12" y2="5"></line>
                <polyline points="5 12 12 5 19 12"></polyline>
              </svg>
            </button>
          </div>
        </div>
        <div class="composer-foot">
          <span>Local Agent · ⌘↵ to send</span>
        </div>
      </form>`;
}

export function renderStudioShell(): string {
  return `
    <div class="shell">
      ${renderStudioTopBar()}
      ${renderStudioContextStrip()}
      <div class="layout">
        ${renderStudioConversation()}
        ${renderStudioSidePanels()}
      </div>
      ${renderStudioPlanDrawer()}
      ${renderStudioComposerSection()}
    </div>`;
}
