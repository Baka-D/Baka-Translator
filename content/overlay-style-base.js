(function initOverlayPart(globalScope) {
  'use strict';
  globalScope.DSHT = globalScope.DSHT || {};
  const parts = globalScope.DSHT.overlayParts = globalScope.DSHT.overlayParts || {};

  parts.baseCss = `
    :host {
      all: initial;
      --dsht-blue: #4d6bfe;
      --dsht-blue-strong: #3954e8;
      --dsht-ink: #172033;
      --dsht-muted: #68718a;
      --dsht-faint: #8d95a8;
      --dsht-line: #e5e8f2;
      --dsht-surface: #ffffff;
      --dsht-soft: #f5f7fc;
      --dsht-danger: #c43b3b;
      --dsht-success: #12805c;
      --dsht-warning: #a86513;
      --dsht-shadow: 0 16px 44px rgba(23, 32, 51, 0.18);
      --dsht-radius: 14px;
    }

    .dsht-layer, .dsht-layer * {
      box-sizing: border-box;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "Microsoft YaHei",
        "PingFang SC", "Hiragino Sans GB", sans-serif;
    }

    .dsht-layer {
      position: absolute;
      inset: 0;
      pointer-events: none;
      color: var(--dsht-ink);
      font-size: 13px;
      line-height: 1.5;
      -webkit-font-smoothing: antialiased;
      text-rendering: optimizeLegibility;
    }

    .dsht-layer button,
    .dsht-layer select,
    .dsht-layer summary {
      font: inherit;
    }

    .dsht-layer button {
      cursor: pointer;
    }

    .dsht-hidden {
      display: none !important;
    }

    .dsht-sr-only {
      position: absolute !important;
      width: 1px !important;
      height: 1px !important;
      padding: 0 !important;
      margin: -1px !important;
      overflow: hidden !important;
      clip: rect(0, 0, 0, 0) !important;
      white-space: nowrap !important;
      border: 0 !important;
    }

    .dsht-layer :focus-visible {
      outline: 2px solid var(--dsht-blue);
      outline-offset: 2px;
    }

    /* ---------- shared surfaces ---------- */
    .dsht-panel,
    .dsht-bubble,
    .dsht-image-panel {
      position: absolute;
      pointer-events: auto;
      background: var(--dsht-surface);
      border: 1px solid var(--dsht-line);
      border-radius: var(--dsht-radius);
      box-shadow: var(--dsht-shadow);
      color: var(--dsht-ink);
      animation: dsht-rise 160ms cubic-bezier(0.2, 0.8, 0.2, 1);
    }

    .dsht-logo {
      width: 30px;
      height: 30px;
      flex: 0 0 30px;
      border-radius: 9px;
      background: var(--dsht-blue);
      color: #fff;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      font-size: 15px;
      font-weight: 700;
      letter-spacing: 0;
      user-select: none;
    }

    .dsht-logo.dsht-logo-sm {
      width: 24px;
      height: 24px;
      flex-basis: 24px;
      border-radius: 7px;
      font-size: 12px;
    }

    .dsht-icon-button {
      width: 28px;
      height: 28px;
      flex: 0 0 28px;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      padding: 0;
      border: 0;
      border-radius: 7px;
      color: var(--dsht-muted);
      background: transparent;
      font-size: 19px;
      line-height: 1;
    }

    .dsht-icon-button:hover {
      background: var(--dsht-soft);
      color: var(--dsht-ink);
    }

    .dsht-btn {
      min-height: 32px;
      padding: 0 12px;
      border: 1px solid var(--dsht-line);
      border-radius: 8px;
      background: var(--dsht-surface);
      color: var(--dsht-ink);
      font-size: 12.5px;
      font-weight: 600;
      white-space: nowrap;
      transition: background-color 120ms ease, border-color 120ms ease;
    }

    .dsht-btn:hover:not(:disabled) {
      background: var(--dsht-soft);
    }

    .dsht-btn-primary {
      border-color: var(--dsht-blue);
      background: var(--dsht-blue);
      color: #fff;
    }

    .dsht-btn-primary:hover:not(:disabled) {
      background: var(--dsht-blue-strong);
      border-color: var(--dsht-blue-strong);
    }

    .dsht-btn-ghost {
      background: transparent;
      color: var(--dsht-muted);
    }

    .dsht-btn-ghost:hover:not(:disabled) {
      background: var(--dsht-soft);
      color: var(--dsht-ink);
    }

    .dsht-btn-danger {
      border-color: #f0d4d4;
      color: var(--dsht-danger);
      background: #fffafa;
    }

    .dsht-btn:disabled {
      opacity: 0.5;
      cursor: default;
    }

    /* ---------- full page progress panel ---------- */
    .dsht-panel {
      right: 20px;
      bottom: 20px;
      width: 344px;
      padding: 14px;
    }

    .dsht-panel[data-status="error"] .dsht-logo,
    .dsht-panel[data-status="partial"] .dsht-logo {
      background: var(--dsht-warning);
    }

    .dsht-panel[data-status="done"] .dsht-logo {
      background: var(--dsht-success);
    }

    .dsht-panel-head {
      display: flex;
      align-items: flex-start;
      gap: 10px;
    }

    .dsht-panel-copy {
      flex: 1 1 auto;
      min-width: 0;
      padding-top: 1px;
    }

    .dsht-panel-title {
      margin: 0;
      font-size: 13px;
      font-weight: 650;
      letter-spacing: 0.01em;
      color: var(--dsht-ink);
    }

    .dsht-panel-subtitle {
      margin-top: 3px;
      color: var(--dsht-muted);
      font-size: 11.5px;
      line-height: 1.5;
      overflow-wrap: anywhere;
    }

    .dsht-progress {
      height: 4px;
      margin: 12px 0 10px;
      border-radius: 999px;
      overflow: hidden;
      background: #edf0f8;
    }

    .dsht-progress-fill {
      height: 100%;
      width: 0%;
      border-radius: inherit;
      background: var(--dsht-blue);
      transition: width 220ms ease;
    }

    .dsht-panel-actions {
      display: flex;
      justify-content: flex-end;
      gap: 8px;
      flex-wrap: wrap;
      margin-top: 2px;
    }

    .dsht-panel-note {
      margin-top: 8px;
      padding-top: 8px;
      border-top: 1px solid var(--dsht-line);
      color: var(--dsht-faint);
      font-size: 10.5px;
      line-height: 1.5;
      white-space: pre-line;
    }

    /* ---------- selection bubble ---------- */
    .dsht-bubble {
      width: min(392px, calc(100vw - 24px));
      max-height: min(64vh, 540px);
      display: flex;
      flex-direction: column;
      overflow: hidden;
    }

    .dsht-bubble-head {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 11px 12px;
      border-bottom: 1px solid var(--dsht-line);
      flex: 0 0 auto;
    }

    .dsht-bubble-heading {
      flex: 1 1 auto;
      min-width: 0;
    }

    .dsht-bubble-title {
      margin: 0;
      font-size: 12px;
      font-weight: 650;
      color: var(--dsht-ink);
    }

    .dsht-bubble-direction {
      margin-top: 1px;
      color: var(--dsht-muted);
      font-size: 10.5px;
    }

    .dsht-bubble-body {
      padding: 13px 14px;
      overflow-y: auto;
      overscroll-behavior: contain;
      flex: 1 1 auto;
    }

    .dsht-bubble-text {
      margin: 0;
      color: #1c2638;
      font-size: 14px;
      line-height: 1.72;
      white-space: pre-wrap;
      overflow-wrap: anywhere;
      user-select: text;
    }

    .dsht-bubble-loading {
      display: flex;
      align-items: center;
      gap: 8px;
      color: var(--dsht-muted);
      font-size: 12.5px;
      padding: 6px 0 2px;
    }

    .dsht-dots {
      display: inline-flex;
      gap: 3px;
      align-items: center;
    }

    .dsht-dots i {
      width: 4px;
      height: 4px;
      border-radius: 50%;
      background: var(--dsht-blue);
      animation: dsht-pulse 1.1s ease-in-out infinite;
    }

    .dsht-dots i:nth-child(2) { animation-delay: 0.15s; }
    .dsht-dots i:nth-child(3) { animation-delay: 0.3s; }

    .dsht-bubble-error {
      margin: 0;
      color: var(--dsht-danger);
      font-size: 12.5px;
      line-height: 1.6;
      overflow-wrap: anywhere;
    }

    .dsht-original {
      margin-top: 12px;
      border-top: 1px solid var(--dsht-line);
      padding-top: 8px;
      color: var(--dsht-muted);
      font-size: 11.5px;
    }

    .dsht-original summary {
      cursor: pointer;
      width: fit-content;
      color: var(--dsht-muted);
      font-weight: 600;
      list-style-position: inside;
      padding: 2px 0;
    }

    .dsht-original summary:hover {
      color: var(--dsht-ink);
    }

    .dsht-original-text {
      margin: 7px 0 0;
      white-space: pre-wrap;
      overflow-wrap: anywhere;
      color: var(--dsht-muted);
      line-height: 1.6;
      user-select: text;
    }

    .dsht-bubble-foot {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 10px 12px;
      border-top: 1px solid var(--dsht-line);
      background: #fbfcff;
      flex: 0 0 auto;
    }

    .dsht-select-wrap {
      position: relative;
      flex: 1 1 auto;
      min-width: 0;
    }

    .dsht-select {
      width: 100%;
      height: 31px;
      padding: 0 26px 0 9px;
      border: 1px solid var(--dsht-line);
      border-radius: 7px;
      background: #fff;
      color: var(--dsht-ink);
      font-size: 11.5px;
      appearance: none;
      cursor: pointer;
    }

    .dsht-select-arrow {
      position: absolute;
      right: 9px;
      top: 50%;
      width: 0;
      height: 0;
      border-left: 3.5px solid transparent;
      border-right: 3.5px solid transparent;
      border-top: 4.5px solid #7d8599;
      transform: translateY(-35%);
      pointer-events: none;
    }

    .dsht-bubble-foot .dsht-btn {
      min-height: 31px;
      font-size: 11.5px;
    }

    .dsht-copy-btn {
      min-width: 54px;
    }

  `;

})(typeof globalThis !== 'undefined' ? globalThis : this);
