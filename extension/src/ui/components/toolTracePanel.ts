export function renderToolTracePanel(): string {
  return `
          <section class="trace-wrap glass">
            <div class="trace-head">
              <div class="trace-title">Tool Trace</div>
              <div class="subtitle">Collapsible payload cards with copy actions</div>
            </div>
            <div id="trace-list" class="trace-list" aria-live="polite">
              <div id="trace-empty" class="trace-empty">
                No trace entries yet. Run a prompt to capture runtime activity.
              </div>
            </div>
          </section>`;
}
