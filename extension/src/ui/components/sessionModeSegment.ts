export function renderSessionModeSegment(): string {
  return `
              <div class="segment" role="tablist" aria-label="Session mode">
                <button id="mode-agent" role="tab" data-mode="agent">Agent</button>
                <button id="mode-chat" role="tab" data-mode="chat">Chat</button>
                <button id="mode-plan" role="tab" data-mode="plan">Plan</button>
              </div>`;
}
