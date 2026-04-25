export function renderStudioStyles(): string {
  return `
      :root {
        --fg: var(--vscode-foreground, #e6edf3);
        --fg-muted: var(--vscode-descriptionForeground, #99a4b3);
        --fg-soft: color-mix(in srgb, var(--fg-muted) 72%, transparent);
        --bg: var(--vscode-editor-background, #0f141a);
        --bg-elev: color-mix(in srgb, var(--vscode-sideBar-background, #111821) 78%, transparent);
        --bg-elev-2: color-mix(in srgb, var(--vscode-input-background, #15202b) 82%, transparent);
        --bg-elev-3: color-mix(in srgb, var(--bg-elev-2) 70%, black 30%);
        --border: var(--vscode-panel-border, rgba(160, 178, 198, 0.22));
        --border-strong: var(--vscode-input-border, rgba(186, 204, 223, 0.34));
        --accent: var(--vscode-button-background, #0e7dc3);
        --accent-fg: var(--vscode-button-foreground, #ffffff);
        --accent-hover: var(--vscode-button-hoverBackground, #0f93e3);
        --accent-soft: color-mix(in srgb, var(--accent) 22%, transparent);
        --danger: var(--vscode-errorForeground, #f48771);
        --warn: var(--vscode-editorWarning-foreground, #e2b043);
        --ok: var(--vscode-charts-green, #47d4a7);
        --link: var(--vscode-textLink-foreground, #40a4ff);
        --shadow-sm: 0 2px 8px rgba(0, 0, 0, 0.18);
        --shadow-md: 0 10px 26px rgba(0, 0, 0, 0.3);
        --shadow-lg: 0 20px 40px rgba(0, 0, 0, 0.42);
        --radius-sm: 8px;
        --radius-md: 12px;
        --radius-lg: 18px;
        --radius-xl: 24px;
        --font-ui: var(--vscode-font-family, "Avenir Next", "Segoe UI", sans-serif);
        --font-mono: var(--vscode-editor-font-family, "SFMono-Regular", Menlo, Consolas, monospace);
      }

      * {
        box-sizing: border-box;
      }

      html,
      body {
        margin: 0;
        height: 100%;
        color: var(--fg);
        background: var(--bg);
        font-family: var(--font-ui);
        font-size: 13px;
        line-height: 1.5;
      }

      body {
        overflow: hidden;
        position: relative;
        isolation: isolate;
        background:
          radial-gradient(1200px 560px at 16% -8%, color-mix(in srgb, var(--accent) 20%, transparent), transparent 62%),
          radial-gradient(680px 400px at 100% 18%, color-mix(in srgb, var(--link) 10%, transparent), transparent 70%),
          linear-gradient(
            180deg,
            color-mix(in srgb, var(--bg) 90%, black 10%) 0%,
            color-mix(in srgb, var(--bg) 82%, black 18%) 100%
          );
      }

      body::before {
        content: "";
        position: absolute;
        inset: 0;
        pointer-events: none;
        background-image: linear-gradient(
          to bottom,
          rgba(255, 255, 255, 0.035) 0,
          rgba(255, 255, 255, 0.035) 1px,
          transparent 1px,
          transparent 56px
        );
        background-size: 100% 56px;
        opacity: 0.22;
        z-index: -2;
      }

      body::after {
        content: "";
        position: absolute;
        inset: 0;
        pointer-events: none;
        background:
          radial-gradient(28% 38% at 24% 20%, color-mix(in srgb, var(--accent) 14%, transparent), transparent 78%),
          radial-gradient(26% 34% at 84% 72%, color-mix(in srgb, var(--ok) 10%, transparent), transparent 82%);
        z-index: -1;
      }

      button,
      input,
      textarea,
      select {
        font-family: inherit;
      }

      /* ---------- generic primitives ---------- */
      .glass {
        background: color-mix(in srgb, var(--bg-elev) 84%, transparent);
        border: 1px solid color-mix(in srgb, var(--border) 85%, transparent);
        box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.03);
        backdrop-filter: blur(6px);
      }

      .subtitle {
        margin-top: 1px;
        color: var(--fg-muted);
        font-size: 10px;
        letter-spacing: 0.3px;
      }

      .toolbar-btn {
        border: 1px solid var(--border-strong);
        border-radius: var(--radius-sm);
        background: color-mix(in srgb, var(--bg-elev-2) 88%, transparent);
        color: var(--fg);
        font-size: 11px;
        font-weight: 600;
        padding: 5px 10px;
        cursor: pointer;
        transition: background 120ms ease, border-color 120ms ease, transform 120ms ease;
      }

      .toolbar-btn:hover {
        background: color-mix(in srgb, var(--bg-elev-2) 68%, var(--accent-soft));
        border-color: color-mix(in srgb, var(--accent) 55%, var(--border-strong));
      }

      .toolbar-btn:active {
        transform: translateY(1px);
      }

      /* ---------- shell layout ---------- */
      .shell {
        position: relative;
        height: 100vh;
        display: grid;
        grid-template-rows: auto auto minmax(0, 1fr) auto auto;
        animation: shell-enter 280ms ease-out both;
      }

      .shell::before {
        content: "";
        position: absolute;
        inset: 0;
        pointer-events: none;
        background: linear-gradient(
          180deg,
          color-mix(in srgb, var(--accent) 10%, transparent) 0%,
          transparent 22%,
          transparent 100%
        );
        opacity: 0.45;
      }

      .layout {
        display: grid;
        grid-template-columns: minmax(0, 1fr);
        min-height: 0;
      }

      .layout:has(.side-rail:not([hidden])) {
        grid-template-columns: minmax(0, 1fr) 320px;
      }

      /* ---------- top bar ---------- */
      .topbar {
        position: relative;
        z-index: 12;
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 12px;
        padding: 9px 14px;
        min-height: 50px;
        border-bottom: 1px solid color-mix(in srgb, var(--border) 82%, transparent);
        background: color-mix(in srgb, var(--bg-elev) 80%, transparent);
        backdrop-filter: blur(14px);
        animation: fade-up 220ms ease-out both;
      }

      .topbar::after {
        content: "";
        position: absolute;
        left: 14px;
        right: 14px;
        bottom: -1px;
        height: 1px;
        background: linear-gradient(
          90deg,
          transparent 0%,
          color-mix(in srgb, var(--accent) 35%, var(--border)) 50%,
          transparent 100%
        );
      }

      .brand {
        display: flex;
        align-items: center;
        gap: 9px;
        min-width: 0;
        flex-shrink: 0;
      }

      .mark {
        width: 24px;
        height: 24px;
        border-radius: 7px;
        background:
          linear-gradient(
            145deg,
            color-mix(in srgb, var(--accent) 78%, white 22%),
            color-mix(in srgb, var(--accent) 78%, black 22%)
          );
        border: 1px solid color-mix(in srgb, var(--accent) 72%, white 28%);
        color: var(--accent-fg);
        font-size: 10px;
        font-weight: 800;
        letter-spacing: 0.35px;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        box-shadow: 0 0 0 1px color-mix(in srgb, var(--accent) 40%, transparent), 0 6px 14px color-mix(in srgb, var(--accent) 33%, transparent);
      }

      .title {
        font-size: 12.5px;
        font-weight: 700;
        letter-spacing: 0.15px;
        color: var(--fg);
        white-space: nowrap;
      }

      .status-line {
        margin-left: 3px;
        padding: 2px 6px;
        border-radius: 999px;
        border: 1px solid color-mix(in srgb, var(--border) 80%, transparent);
        background: color-mix(in srgb, var(--bg-elev-2) 76%, transparent);
        display: inline-flex;
        align-items: center;
        gap: 6px;
      }

      .dot {
        width: 7px;
        height: 7px;
        border-radius: 999px;
        background: var(--ok);
        box-shadow: 0 0 0 0 color-mix(in srgb, var(--ok) 45%, transparent);
        animation: status-pulse 1800ms ease-out infinite;
      }

      .status-pill {
        font-size: 10px;
        color: var(--fg-muted);
        text-transform: uppercase;
        letter-spacing: 0.62px;
        font-weight: 700;
      }

      .topbar-center {
        display: flex;
        justify-content: center;
        flex: 1;
        min-width: 0;
      }

      .topbar-actions {
        display: flex;
        align-items: center;
        gap: 5px;
        flex-shrink: 0;
      }

      .icon-btn {
        width: 30px;
        height: 30px;
        border-radius: 9px;
        border: 1px solid transparent;
        background: transparent;
        color: var(--fg-muted);
        font-size: 14px;
        line-height: 1;
        cursor: pointer;
        list-style: none;
        padding: 0;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        transition: background 120ms ease, color 120ms ease, border-color 120ms ease, transform 120ms ease;
      }

      .icon-btn svg {
        width: 14px;
        height: 14px;
        pointer-events: none;
      }

      .icon-btn:hover {
        color: var(--fg);
        border-color: color-mix(in srgb, var(--accent) 50%, var(--border));
        background: color-mix(in srgb, var(--bg-elev-2) 65%, var(--accent-soft));
      }

      .icon-btn:active {
        transform: translateY(1px);
      }

      .icon-btn[aria-pressed="true"] {
        color: var(--accent-fg);
        border-color: color-mix(in srgb, var(--accent) 64%, transparent);
        background: color-mix(in srgb, var(--accent) 72%, black 18%);
      }

      summary.icon-btn::-webkit-details-marker {
        display: none;
      }

      summary.icon-btn::marker {
        content: "";
      }

      .segment {
        display: inline-flex;
        background: color-mix(in srgb, var(--bg-elev-2) 88%, transparent);
        border: 1px solid color-mix(in srgb, var(--border) 88%, transparent);
        border-radius: 999px;
        padding: 2px;
        gap: 2px;
        box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.03);
      }

      .segment button {
        border: none;
        border-radius: 999px;
        padding: 5px 14px;
        min-width: 58px;
        background: transparent;
        color: var(--fg-muted);
        font-size: 11px;
        font-weight: 700;
        letter-spacing: 0.2px;
        cursor: pointer;
        transition: background 120ms ease, color 120ms ease, transform 120ms ease;
      }

      .segment button:hover {
        color: var(--fg);
      }

      .segment button.active {
        color: var(--accent-fg);
        background: linear-gradient(
          160deg,
          color-mix(in srgb, var(--accent) 82%, white 18%),
          color-mix(in srgb, var(--accent) 85%, black 15%)
        );
        box-shadow: 0 4px 12px color-mix(in srgb, var(--accent) 33%, transparent);
      }

      .overflow-menu {
        position: relative;
      }

      .overflow-menu[open] > .icon-btn {
        color: var(--fg);
        border-color: color-mix(in srgb, var(--accent) 48%, var(--border));
        background: color-mix(in srgb, var(--bg-elev-2) 60%, var(--accent-soft));
      }

      .overflow-panel {
        position: absolute;
        right: 0;
        top: calc(100% + 6px);
        z-index: 50;
        min-width: 238px;
        padding: 7px;
        display: flex;
        flex-direction: column;
        gap: 2px;
        border: 1px solid var(--border-strong);
        border-radius: var(--radius-md);
        background: color-mix(in srgb, var(--vscode-menu-background, var(--bg-elev)) 92%, black 8%);
        color: var(--vscode-menu-foreground, var(--fg));
        box-shadow: var(--shadow-lg);
        backdrop-filter: blur(10px);
        animation: fade-up 120ms ease-out both;
      }

      .menu-section {
        padding: 4px 6px 3px;
      }

      .menu-section-title {
        padding-bottom: 5px;
        font-size: 9px;
        font-weight: 800;
        text-transform: uppercase;
        letter-spacing: 0.62px;
        color: var(--fg-muted);
      }

      .menu-item {
        text-align: left;
        border: none;
        border-radius: var(--radius-sm);
        padding: 7px 10px;
        font-size: 12px;
        color: inherit;
        background: transparent;
        cursor: pointer;
        transition: background 120ms ease, color 120ms ease;
      }

      .menu-item:hover {
        background: var(--vscode-menu-selectionBackground, color-mix(in srgb, var(--accent) 80%, black 20%));
        color: var(--vscode-menu-selectionForeground, var(--accent-fg));
      }

      .menu-item.danger {
        color: var(--danger);
      }

      .menu-sep {
        height: 1px;
        margin: 5px 3px;
        background: linear-gradient(
          90deg,
          transparent,
          color-mix(in srgb, var(--border) 88%, transparent),
          transparent
        );
      }

      .approval-picker {
        display: flex;
        align-items: center;
        gap: 6px;
        padding: 5px 7px;
        height: 30px;
        border-radius: var(--radius-sm);
        border: 1px solid color-mix(in srgb, var(--border) 92%, transparent);
        background: color-mix(in srgb, var(--bg-elev-2) 84%, transparent);
      }

      .approval-picker .picker-label {
        display: none;
      }

      .approval-picker select {
        appearance: none;
        width: 100%;
        border: none;
        padding: 0 2px;
        background: transparent;
        color: var(--fg);
        font-size: 12px;
        font-weight: 600;
        font-family: inherit;
        cursor: pointer;
      }

      .approval-picker select:focus {
        outline: none;
      }

      /* ---------- context strip ---------- */
      .context-strip {
        position: relative;
        z-index: 8;
        display: flex;
        flex-wrap: wrap;
        gap: 6px 10px;
        padding: 7px 12px;
        border-bottom: 1px solid color-mix(in srgb, var(--border) 76%, transparent);
        background: color-mix(in srgb, var(--bg-elev) 70%, transparent);
        overflow-x: auto;
        animation: fade-up 240ms ease-out both;
        animation-delay: 40ms;
      }

      .ctx-chip {
        max-width: min(360px, 100%);
        display: inline-flex;
        align-items: center;
        gap: 6px;
        padding: 3px 8px;
        border-radius: 999px;
        border: 1px solid color-mix(in srgb, var(--border) 82%, transparent);
        background: color-mix(in srgb, var(--bg-elev-2) 84%, transparent);
        box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.02);
      }

      .ctx-key {
        flex-shrink: 0;
        text-transform: uppercase;
        letter-spacing: 0.55px;
        font-size: 9px;
        font-weight: 800;
        color: var(--fg-soft);
      }

      .ctx-val {
        min-width: 0;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        font-family: var(--font-mono);
        font-size: 10.5px;
        color: var(--fg);
      }

      /* ---------- thread ---------- */
      .thread-wrap {
        min-height: 0;
        overflow: hidden;
        display: flex;
        flex-direction: column;
      }

      .thread {
        flex: 1;
        min-height: 0;
        overflow-y: auto;
        overflow-x: hidden;
        display: flex;
        justify-content: center;
      }

      .conversation {
        width: 100%;
        max-width: 860px;
        padding: 30px 24px 40px;
        display: flex;
        flex-direction: column;
        gap: 14px;
        position: relative;
      }

      /* empty state */
      .empty-state {
        width: 100%;
        max-width: 640px;
        margin: auto;
        padding: 34px 26px;
        border-radius: var(--radius-xl);
        border: 1px solid color-mix(in srgb, var(--border-strong) 90%, transparent);
        background:
          linear-gradient(
            180deg,
            color-mix(in srgb, var(--bg-elev-2) 88%, transparent),
            color-mix(in srgb, var(--bg-elev) 86%, transparent)
          );
        box-shadow: var(--shadow-md), inset 0 1px 0 rgba(255, 255, 255, 0.03);
        display: flex;
        flex-direction: column;
        align-items: center;
        gap: 10px;
        text-align: center;
        animation: fade-up 260ms ease both;
      }

      .empty-mark {
        width: 52px;
        height: 52px;
        border-radius: 16px;
        color: var(--accent-fg);
        font-size: 17px;
        font-weight: 800;
        letter-spacing: 0.25px;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        margin-bottom: 7px;
        background:
          linear-gradient(
            150deg,
            color-mix(in srgb, var(--accent) 82%, white 18%),
            color-mix(in srgb, var(--accent) 82%, black 18%)
          );
        box-shadow:
          0 0 0 1px color-mix(in srgb, var(--accent) 38%, transparent),
          0 12px 30px color-mix(in srgb, var(--accent) 32%, transparent);
      }

      .empty-title {
        margin: 0;
        font-size: 30px;
        line-height: 1.12;
        font-weight: 750;
        letter-spacing: -0.2px;
        color: var(--fg);
      }

      .empty-sub {
        margin: 0 0 14px;
        max-width: 470px;
        font-size: 13px;
        color: var(--fg-muted);
      }

      .empty-suggestions {
        width: 100%;
        display: grid;
        gap: 8px;
      }

      .suggestion {
        display: grid;
        gap: 2px;
        text-align: left;
        cursor: pointer;
        font-family: inherit;
        color: var(--fg);
        padding: 11px 13px;
        border-radius: var(--radius-md);
        border: 1px solid color-mix(in srgb, var(--border) 86%, transparent);
        background:
          linear-gradient(
            160deg,
            color-mix(in srgb, var(--bg-elev-2) 88%, transparent),
            color-mix(in srgb, var(--bg-elev) 84%, transparent)
          );
        transition: transform 140ms ease, border-color 140ms ease, background 140ms ease, box-shadow 140ms ease;
        animation: fade-up 260ms ease-out both;
      }

      .empty-suggestions .suggestion:nth-child(1) {
        animation-delay: 70ms;
      }

      .empty-suggestions .suggestion:nth-child(2) {
        animation-delay: 110ms;
      }

      .empty-suggestions .suggestion:nth-child(3) {
        animation-delay: 150ms;
      }

      .suggestion:hover {
        transform: translateY(-1px);
        border-color: color-mix(in srgb, var(--accent) 55%, var(--border));
        background:
          linear-gradient(
            160deg,
            color-mix(in srgb, var(--bg-elev-2) 78%, var(--accent-soft)),
            color-mix(in srgb, var(--bg-elev) 84%, transparent)
          );
        box-shadow: var(--shadow-sm);
      }

      .sg-title {
        font-size: 13px;
        font-weight: 700;
      }

      .sg-sub {
        font-size: 11px;
        color: var(--fg-muted);
      }

      .conversation:has(.bubble) .empty-state {
        display: none;
      }

      /* messages */
      .bubble {
        max-width: min(100%, 840px);
        padding: 11px 13px;
        border-radius: 14px;
        border: 1px solid color-mix(in srgb, var(--border) 90%, transparent);
        background:
          linear-gradient(
            165deg,
            color-mix(in srgb, var(--bg-elev-2) 92%, transparent),
            color-mix(in srgb, var(--bg-elev) 86%, transparent)
          );
        box-shadow: var(--shadow-sm);
        word-wrap: break-word;
        font-size: 13.4px;
        line-height: 1.58;
        animation: bubble-enter 170ms ease-out both;
      }

      .bubble.user {
        margin-left: auto;
        max-width: min(88%, 760px);
        border-color: color-mix(in srgb, var(--accent) 46%, var(--border));
        background:
          linear-gradient(
            160deg,
            color-mix(in srgb, var(--accent) 18%, var(--bg-elev-2)),
            color-mix(in srgb, var(--accent) 8%, var(--bg-elev))
          );
      }

      .bubble.assistant {
        margin-right: auto;
      }

      .bubble.assistant.error {
        color: color-mix(in srgb, var(--danger) 90%, white 10%);
        border-color: color-mix(in srgb, var(--danger) 58%, var(--border));
        background: color-mix(in srgb, var(--danger) 10%, var(--bg-elev-2));
      }

      .bubble-body {
        display: grid;
        gap: 8px;
      }

      .bubble-body > :first-child {
        margin-top: 0;
      }

      .bubble-body > :last-child {
        margin-bottom: 0;
      }

      .bubble-body p,
      .bubble-body ul,
      .bubble-body ol,
      .bubble-body blockquote,
      .bubble-body h1,
      .bubble-body h2,
      .bubble-body h3 {
        margin: 0;
      }

      .bubble-body h1,
      .bubble-body h2,
      .bubble-body h3 {
        font-size: 12px;
        letter-spacing: 0.32px;
        text-transform: uppercase;
        color: color-mix(in srgb, var(--fg-muted) 74%, var(--fg));
      }

      .bubble-body ul,
      .bubble-body ol {
        padding-left: 20px;
        display: grid;
        gap: 4px;
      }

      .bubble-body blockquote {
        padding: 6px 10px;
        border-left: 2px solid color-mix(in srgb, var(--accent) 64%, var(--border));
        border-radius: 0 8px 8px 0;
        color: color-mix(in srgb, var(--fg) 92%, var(--fg-muted));
        background: color-mix(in srgb, var(--bg-elev) 80%, transparent);
      }

      .bubble-body code {
        font-family: var(--font-mono);
        font-size: 12px;
        padding: 1px 5px;
        border-radius: 6px;
        background: color-mix(in srgb, var(--bg-elev-2) 90%, black 10%);
        border: 1px solid color-mix(in srgb, var(--border) 90%, transparent);
      }

      .bubble-body .msg-code-wrap {
        display: grid;
        gap: 4px;
      }

      .bubble-body .msg-code-lang {
        font-size: 10px;
        font-weight: 700;
        letter-spacing: 0.48px;
        text-transform: uppercase;
        color: var(--fg-muted);
      }

      .bubble-body pre.msg-code {
        margin: 0;
        padding: 10px 12px;
        border-radius: var(--radius-md);
        border: 1px solid color-mix(in srgb, var(--border) 92%, transparent);
        background: color-mix(in srgb, var(--bg) 84%, black 16%);
        overflow-x: auto;
      }

      .bubble-body pre.msg-code code {
        background: transparent;
        border: none;
        padding: 0;
        border-radius: 0;
        white-space: pre;
        display: block;
        color: var(--fg);
      }

      .bubble-body .diff-code span {
        display: block;
        padding: 0 2px;
      }

      .bubble-body .diff-code .diff-add {
        color: color-mix(in srgb, #8ef2ba 88%, white 12%);
        background: color-mix(in srgb, #1a7a45 24%, transparent);
      }

      .bubble-body .diff-code .diff-del {
        color: color-mix(in srgb, #ffada8 88%, white 12%);
        background: color-mix(in srgb, #8f2f2a 24%, transparent);
      }

      .bubble-body .diff-code .diff-hunk {
        color: color-mix(in srgb, #8ec7ff 86%, white 14%);
        background: color-mix(in srgb, #2e4f8f 24%, transparent);
      }

      .bubble-body .diff-code .diff-meta {
        color: color-mix(in srgb, var(--fg-muted) 90%, white 10%);
      }

      .bubble-body .reasoning-block {
        border: 1px solid color-mix(in srgb, var(--border) 88%, transparent);
        border-radius: var(--radius-md);
        background: color-mix(in srgb, var(--bg-elev) 92%, transparent);
        overflow: hidden;
      }

      .bubble-body .reasoning-block summary {
        cursor: pointer;
        list-style: none;
        user-select: none;
        padding: 6px 10px;
        font-size: 11px;
        font-weight: 700;
        text-transform: uppercase;
        letter-spacing: 0.44px;
        color: var(--fg-muted);
      }

      .bubble-body .reasoning-block summary::-webkit-details-marker {
        display: none;
      }

      .bubble-body .reasoning-content {
        display: grid;
        gap: 6px;
        padding: 0 10px 10px;
      }

      /* ---------- side rail ---------- */
      .side-rail {
        border-left: 1px solid color-mix(in srgb, var(--border) 92%, transparent);
        background: color-mix(in srgb, var(--bg-elev) 88%, transparent);
        backdrop-filter: blur(10px);
        display: flex;
        flex-direction: column;
        min-height: 0;
        overflow-y: auto;
      }

      .side-rail[hidden] {
        display: none !important;
      }

      .drawer {
        border-bottom: 1px solid color-mix(in srgb, var(--border) 85%, transparent);
      }

      .drawer-summary {
        list-style: none;
        cursor: pointer;
        user-select: none;
        padding: 9px 12px;
        display: flex;
        align-items: center;
        gap: 8px;
      }

      .drawer-summary::-webkit-details-marker {
        display: none;
      }

      .drawer-summary::marker {
        content: "";
      }

      .drawer-label {
        font-size: 11px;
        font-weight: 800;
        letter-spacing: 0.58px;
        text-transform: uppercase;
        color: var(--fg);
      }

      .drawer-hint {
        flex: 1;
        min-width: 0;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        font-size: 11px;
        color: var(--fg-muted);
      }

      .chev {
        font-size: 10px;
        color: var(--fg-muted);
        transition: transform 160ms ease;
      }

      .drawer[open] .chev {
        transform: rotate(180deg);
      }

      .drawer-summary:hover {
        background: color-mix(in srgb, var(--bg-elev-2) 72%, transparent);
      }

      .drawer-body {
        padding: 6px 12px 12px;
      }

      /* plan drawer above composer — width-matched to chat */
      #plan-drawer {
        border-top: 1px solid color-mix(in srgb, var(--border) 85%, transparent);
        border-bottom: none;
        background: transparent;
        width: 100%;
        max-width: 860px;
        margin: 0 auto;
        align-self: center;
      }

      #plan-drawer .drawer-summary {
        padding: 8px 14px;
      }

      #plan-drawer .drawer-body {
        padding: 4px 14px 10px;
      }

      .hint-block {
        padding: 9px 11px;
        border-radius: var(--radius-md);
        border: 1px dashed color-mix(in srgb, var(--border-strong) 90%, transparent);
        color: var(--fg-muted);
        font-size: 12px;
        background: color-mix(in srgb, var(--bg-elev-2) 58%, transparent);
      }

      .plan-list {
        margin: 9px 0 0;
        padding-left: 20px;
        display: grid;
        gap: 7px;
        font-size: 12px;
      }

      .plan-item {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 10px;
      }

      .plan-step {
        line-height: 1.45;
        color: var(--fg);
      }

      .plan-badge {
        border-radius: 999px;
        border: 1px solid color-mix(in srgb, var(--border-strong) 85%, transparent);
        padding: 2px 8px;
        font-size: 9px;
        font-weight: 800;
        text-transform: uppercase;
        letter-spacing: 0.52px;
        color: var(--fg-muted);
        background: color-mix(in srgb, var(--bg-elev-2) 72%, transparent);
      }

      .plan-badge.pending {
        color: var(--warn);
        border-color: color-mix(in srgb, var(--warn) 54%, transparent);
      }

      .plan-badge.in_progress {
        color: var(--link);
        border-color: color-mix(in srgb, var(--link) 54%, transparent);
      }

      .plan-badge.completed {
        color: var(--ok);
        border-color: color-mix(in srgb, var(--ok) 54%, transparent);
      }

      /* history */
      .history-panel {
        display: flex;
        flex-direction: column;
        gap: 9px;
        background: transparent;
        border: none;
        padding: 0;
      }

      .history-head {
        display: flex;
        align-items: flex-start;
        justify-content: space-between;
        gap: 8px;
      }

      .history-title {
        display: none;
      }

      .history-meta {
        font-size: 11px;
        color: var(--fg-muted);
      }

      .history-search {
        border: 1px solid var(--border-strong);
        border-radius: var(--radius-sm);
        background: color-mix(in srgb, var(--bg-elev-2) 86%, transparent);
        padding: 6px 8px;
      }

      .history-search input {
        width: 100%;
        border: none;
        background: transparent;
        color: var(--fg);
        font-size: 12px;
        font-family: inherit;
      }

      .history-search input:focus {
        outline: none;
      }

      .history-empty {
        border: 1px dashed color-mix(in srgb, var(--border-strong) 92%, transparent);
        border-radius: var(--radius-sm);
        padding: 8px;
        font-size: 11px;
        color: var(--fg-muted);
      }

      .history-list {
        display: flex;
        flex-direction: column;
        gap: 8px;
        max-height: 300px;
        overflow-y: auto;
      }

      .history-group {
        display: grid;
        gap: 4px;
      }

      .history-group-title {
        font-size: 9px;
        font-weight: 800;
        text-transform: uppercase;
        letter-spacing: 0.6px;
        color: var(--fg-muted);
      }

      .history-item {
        border: 1px solid color-mix(in srgb, var(--border) 90%, transparent);
        border-radius: var(--radius-sm);
        background:
          linear-gradient(
            165deg,
            color-mix(in srgb, var(--bg-elev-2) 88%, transparent),
            color-mix(in srgb, var(--bg-elev) 82%, transparent)
          );
        padding: 7px 8px;
        display: grid;
        gap: 4px;
        cursor: pointer;
        font-size: 12px;
        transition: border-color 130ms ease, background 130ms ease, transform 130ms ease;
      }

      .history-item:hover {
        transform: translateY(-1px);
        border-color: color-mix(in srgb, var(--accent) 46%, var(--border));
        background:
          linear-gradient(
            165deg,
            color-mix(in srgb, var(--bg-elev-2) 78%, var(--accent-soft)),
            color-mix(in srgb, var(--bg-elev) 86%, transparent)
          );
      }

      .history-item.active {
        border-color: color-mix(in srgb, var(--accent) 58%, transparent);
        background: color-mix(in srgb, var(--accent) 14%, var(--bg-elev-2));
      }

      .history-item.disabled {
        opacity: 0.62;
        cursor: default;
      }

      .history-item-row {
        display: flex;
        justify-content: space-between;
        align-items: baseline;
        gap: 6px;
      }

      .history-item-title {
        font-size: 12px;
        font-weight: 650;
        color: var(--fg);
      }

      .history-item-time {
        font-family: var(--font-mono);
        font-size: 10px;
        color: var(--fg-muted);
        white-space: nowrap;
      }

      .history-item-meta {
        font-size: 9px;
        color: var(--fg-muted);
        text-transform: uppercase;
        letter-spacing: 0.52px;
      }

      .history-item-preview {
        border-left: 2px solid color-mix(in srgb, var(--border-strong) 88%, transparent);
        padding-left: 6px;
        font-size: 11px;
        line-height: 1.4;
        color: var(--fg-muted);
      }

      .history-item-actions {
        display: flex;
        justify-content: flex-end;
        gap: 4px;
      }

      .history-action-btn {
        border: 1px solid var(--border-strong);
        border-radius: var(--radius-sm);
        background: transparent;
        color: var(--fg-muted);
        font-size: 10px;
        font-weight: 700;
        padding: 3px 7px;
        cursor: pointer;
      }

      .history-action-btn:hover {
        color: var(--fg);
        border-color: color-mix(in srgb, var(--accent) 46%, var(--border-strong));
        background: color-mix(in srgb, var(--bg-elev-2) 65%, transparent);
      }

      .history-action-btn.danger {
        color: var(--danger);
      }

      .history-action-btn:disabled {
        opacity: 0.5;
        cursor: default;
      }

      /* tool trace */
      .trace-wrap {
        display: flex;
        flex-direction: column;
        gap: 8px;
        background: transparent;
        border: none;
        padding: 0;
      }

      .trace-head {
        display: none;
      }

      .trace-list {
        display: flex;
        flex-direction: column;
        gap: 7px;
        max-height: 320px;
        overflow-y: auto;
      }

      .trace-empty {
        border: 1px dashed color-mix(in srgb, var(--border-strong) 92%, transparent);
        border-radius: var(--radius-sm);
        padding: 8px;
        font-size: 11px;
        color: var(--fg-muted);
      }

      .trace-card {
        border: 1px solid color-mix(in srgb, var(--border) 90%, transparent);
        border-radius: var(--radius-sm);
        padding: 8px;
        display: grid;
        gap: 6px;
        background:
          linear-gradient(
            165deg,
            color-mix(in srgb, var(--bg-elev-2) 88%, transparent),
            color-mix(in srgb, var(--bg-elev) 82%, transparent)
          );
      }

      .trace-card.error {
        border-color: color-mix(in srgb, var(--danger) 56%, transparent);
      }

      .trace-card.fallback {
        border-color: color-mix(in srgb, var(--warn) 56%, transparent);
      }

      .trace-row {
        display: flex;
        justify-content: space-between;
        align-items: baseline;
        gap: 8px;
      }

      .trace-name {
        font-size: 11px;
        font-weight: 700;
        color: var(--fg);
      }

      .trace-meta {
        font-family: var(--font-mono);
        font-size: 10px;
        color: var(--fg-muted);
      }

      .trace-preview {
        border-left: 2px solid color-mix(in srgb, var(--accent) 72%, transparent);
        padding-left: 8px;
        font-family: var(--font-mono);
        font-size: 11px;
        line-height: 1.38;
        white-space: pre-wrap;
        color: var(--fg);
      }

      .trace-actions {
        display: flex;
        justify-content: flex-end;
      }

      .copy-btn {
        border: 1px solid var(--border-strong);
        border-radius: var(--radius-sm);
        background: transparent;
        color: var(--fg-muted);
        font-size: 10px;
        font-weight: 700;
        padding: 3px 7px;
        cursor: pointer;
      }

      .copy-btn:hover {
        color: var(--fg);
        border-color: color-mix(in srgb, var(--accent) 48%, var(--border-strong));
        background: color-mix(in srgb, var(--bg-elev-2) 68%, transparent);
      }

      .trace-details summary {
        cursor: pointer;
        color: var(--fg-muted);
        font-size: 10px;
        font-weight: 700;
      }

      .trace-details pre {
        margin: 7px 0 0;
        max-height: 180px;
        overflow: auto;
        border-radius: var(--radius-sm);
        border: 1px solid color-mix(in srgb, var(--border) 90%, transparent);
        background: color-mix(in srgb, var(--bg) 84%, black 16%);
        padding: 8px;
        color: var(--fg);
        font-family: var(--font-mono);
        font-size: 11px;
        line-height: 1.4;
        white-space: pre-wrap;
        word-break: break-word;
      }

      /* ---------- composer ---------- */
      .composer {
        position: relative;
        z-index: 10;
        padding: 11px 16px 14px;
        border-top: 1px solid color-mix(in srgb, var(--border) 85%, transparent);
        background: color-mix(in srgb, var(--bg-elev) 70%, transparent);
        display: flex;
        flex-direction: column;
        gap: 8px;
        animation: fade-up 300ms ease-out both;
        animation-delay: 80ms;
      }

      .composer-pill {
        width: 100%;
        max-width: 860px;
        margin: 0 auto;
        padding: 11px 12px 9px;
        border-radius: var(--radius-xl);
        border: 1px solid color-mix(in srgb, var(--border-strong) 90%, transparent);
        background:
          linear-gradient(
            170deg,
            color-mix(in srgb, var(--bg-elev-2) 92%, transparent),
            color-mix(in srgb, var(--bg-elev) 86%, transparent)
          );
        display: flex;
        flex-direction: column;
        gap: 6px;
        box-shadow: var(--shadow-md), inset 0 1px 0 rgba(255, 255, 255, 0.04);
        transition: border-color 140ms ease, box-shadow 140ms ease;
      }

      .composer-pill:focus-within {
        border-color: color-mix(in srgb, var(--border-strong) 90%, transparent);
        box-shadow: var(--shadow-md), inset 0 1px 0 rgba(255, 255, 255, 0.04);
      }

      textarea#prompt {
        width: 100%;
        min-height: 24px;
        max-height: 220px;
        resize: none;
        border: none;
        background: transparent;
        color: var(--fg);
        font-family: inherit;
        font-size: 13.5px;
        line-height: 1.5;
        padding: 4px 2px;
      }

      textarea#prompt:focus {
        outline: none;
      }

      textarea#prompt::placeholder {
        color: var(--fg-muted);
      }

      .composer-bar {
        display: flex;
        align-items: center;
        justify-content: flex-end;
        gap: 8px;
      }

      .composer-chips {
        display: flex;
        flex-wrap: wrap;
        gap: 4px;
        flex: 1;
        min-width: 0;
      }

      .chip {
        border: 1px solid color-mix(in srgb, var(--border) 90%, transparent);
        border-radius: 999px;
        background: transparent;
        color: var(--fg-muted);
        font-size: 11px;
        font-weight: 600;
        padding: 3px 9px;
        cursor: pointer;
        white-space: nowrap;
        transition: border-color 130ms ease, color 130ms ease, background 130ms ease;
      }

      .chip:hover {
        color: var(--fg);
        border-color: color-mix(in srgb, var(--accent) 45%, var(--border-strong));
        background: color-mix(in srgb, var(--bg-elev-2) 70%, transparent);
      }

      .chip.pending {
        color: var(--warn);
        border-color: color-mix(in srgb, var(--warn) 45%, transparent);
      }

      .send {
        flex-shrink: 0;
        width: 32px;
        height: 32px;
        border-radius: 999px;
        border: 1px solid color-mix(in srgb, var(--accent) 52%, transparent);
        background:
          linear-gradient(
            160deg,
            color-mix(in srgb, var(--accent) 84%, white 16%),
            color-mix(in srgb, var(--accent) 84%, black 16%)
          );
        color: var(--accent-fg);
        cursor: pointer;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        box-shadow: 0 8px 18px color-mix(in srgb, var(--accent) 38%, transparent);
        transition: transform 120ms ease, box-shadow 120ms ease, filter 120ms ease;
      }

      .send:hover {
        filter: brightness(1.06);
        box-shadow: 0 10px 20px color-mix(in srgb, var(--accent) 45%, transparent);
      }

      .send:active {
        transform: translateY(1px) scale(0.97);
      }

      .composer-foot {
        font-size: 10px;
        color: var(--fg-muted);
        text-align: center;
        opacity: 0.72;
      }

      /* accessibility states */
      button:focus-visible,
      summary:focus-visible,
      .history-item:focus-visible,
      .history-search input:focus-visible,
      .approval-picker select:focus-visible {
        outline: 2px solid color-mix(in srgb, var(--accent) 58%, white 10%);
        outline-offset: 2px;
      }

      textarea#prompt:focus-visible {
        outline: none;
      }

      /* disabled states */
      .send[disabled],
      textarea[disabled],
      .chip[disabled],
      .icon-btn[disabled],
      .menu-item[disabled],
      .approval-picker select[disabled],
      .suggestion[disabled],
      .toolbar-btn[disabled] {
        opacity: 0.5;
        cursor: not-allowed;
      }

      /* ---------- scrollbars ---------- */
      ::-webkit-scrollbar {
        width: 10px;
        height: 10px;
      }

      ::-webkit-scrollbar-thumb {
        border-radius: 999px;
        background: var(--vscode-scrollbarSlider-background, rgba(255, 255, 255, 0.12));
      }

      ::-webkit-scrollbar-thumb:hover {
        background: var(--vscode-scrollbarSlider-hoverBackground, rgba(255, 255, 255, 0.2));
      }

      ::-webkit-scrollbar-track {
        background: transparent;
      }

      /* ---------- responsive ---------- */
      @media (max-width: 900px) {
        .conversation,
        .composer-pill {
          max-width: 100%;
        }

        .conversation {
          padding: 20px 14px 30px;
        }

        .composer {
          padding-left: 10px;
          padding-right: 10px;
        }

        .empty-state {
          padding: 26px 16px;
        }

        .empty-title {
          font-size: 24px;
        }
      }

      @media (max-width: 720px) {
        .layout:has(.side-rail:not([hidden])) {
          grid-template-columns: minmax(0, 1fr);
        }

        .side-rail {
          display: none !important;
        }

        .topbar {
          padding: 8px 10px;
          gap: 8px;
        }

        .segment button {
          min-width: 0;
          padding-left: 10px;
          padding-right: 10px;
        }

        .context-strip {
          gap: 6px;
          padding-left: 10px;
          padding-right: 10px;
        }

        .empty-title {
          font-size: 22px;
        }
      }

      @media (prefers-reduced-motion: reduce) {
        *,
        *::before,
        *::after {
          animation: none !important;
          transition: none !important;
        }
      }

      /* ---------- motion ---------- */
      @keyframes shell-enter {
        from {
          opacity: 0;
          transform: translateY(4px);
        }

        to {
          opacity: 1;
          transform: translateY(0);
        }
      }

      @keyframes fade-up {
        from {
          opacity: 0;
          transform: translateY(8px);
        }

        to {
          opacity: 1;
          transform: translateY(0);
        }
      }

      @keyframes bubble-enter {
        from {
          opacity: 0;
          transform: translateY(6px);
        }

        to {
          opacity: 1;
          transform: translateY(0);
        }
      }

      @keyframes status-pulse {
        0% {
          box-shadow: 0 0 0 0 color-mix(in srgb, var(--ok) 44%, transparent);
        }

        70% {
          box-shadow: 0 0 0 6px color-mix(in srgb, var(--ok) 0%, transparent);
        }

        100% {
          box-shadow: 0 0 0 0 color-mix(in srgb, var(--ok) 0%, transparent);
        }
      }
    `;
}
