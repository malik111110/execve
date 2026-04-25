export function renderHistoryPanel(): string {
  return `
        <aside class="history-panel glass" aria-label="Session history">
          <div class="history-head">
            <div>
              <div class="history-title">History</div>
              <div class="subtitle">Recent sessions for this workspace</div>
            </div>
            <button id="refresh-history" class="toolbar-btn" type="button">Refresh</button>
          </div>
          <label class="history-search" for="history-search">
            <input
              id="history-search"
              type="text"
              placeholder="Search sessions"
              autocomplete="off"
              spellcheck="false"
            />
          </label>
          <div id="history-meta" class="history-meta">Loading sessions...</div>
          <div id="history-list" class="history-list" aria-live="polite">
            <div id="history-empty" class="history-empty">
              No sessions yet. Start a conversation to populate history.
            </div>
          </div>
        </aside>`;
}
