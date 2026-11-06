(function initOverlayPart(globalScope) {
  'use strict';
  globalScope.DSHT = globalScope.DSHT || {};
  const parts = globalScope.DSHT.overlayParts = globalScope.DSHT.overlayParts || {};

  parts.imageCss = `    /* ---------- image results panel ---------- */
    .dsht-image-panel {
      left: 20px;
      bottom: 20px;
      width: 356px;
      max-height: min(70vh, 640px);
      display: flex;
      flex-direction: column;
      overflow: hidden;
    }

    .dsht-image-head {
      display: flex;
      align-items: flex-start;
      gap: 10px;
      padding: 13px 14px;
      border-bottom: 1px solid var(--dsht-line);
      flex: 0 0 auto;
    }

    .dsht-image-title {
      margin: 0;
      font-size: 13px;
      font-weight: 650;
    }

    .dsht-image-subtitle {
      margin-top: 2px;
      font-size: 10.5px;
      color: var(--dsht-muted);
    }

    .dsht-image-list {
      overflow-y: auto;
      overscroll-behavior: contain;
      flex: 1 1 auto;
    }

    .dsht-image-empty {
      padding: 22px 16px;
      color: var(--dsht-muted);
      font-size: 12px;
      text-align: center;
      line-height: 1.6;
    }

    .dsht-image-item {
      display: flex;
      gap: 10px;
      padding: 12px 14px;
      border-top: 1px solid var(--dsht-line);
    }

    .dsht-image-item:first-child {
      border-top: 0;
    }

    .dsht-thumb-wrap {
      width: 58px;
      height: 58px;
      flex: 0 0 58px;
      border-radius: 8px;
      overflow: hidden;
      background: var(--dsht-soft);
      border: 1px solid var(--dsht-line);
    }

    .dsht-thumb {
      width: 100%;
      height: 100%;
      object-fit: cover;
      display: block;
    }

    .dsht-image-copy {
      flex: 1 1 auto;
      min-width: 0;
    }

    .dsht-image-item-head {
      display: flex;
      align-items: center;
      gap: 6px;
      min-height: 16px;
    }

    .dsht-image-index {
      font-size: 10px;
      font-weight: 700;
      letter-spacing: 0.04em;
      color: var(--dsht-faint);
      text-transform: uppercase;
    }

    .dsht-image-state {
      font-size: 10px;
      color: var(--dsht-faint);
      margin-left: auto;
    }

    .dsht-image-translation {
      margin: 5px 0 0;
      font-size: 12.5px;
      line-height: 1.65;
      color: var(--dsht-ink);
      white-space: pre-wrap;
      overflow-wrap: anywhere;
      user-select: text;
    }

    .dsht-image-muted {
      margin: 5px 0 0;
      font-size: 11.5px;
      line-height: 1.55;
      color: var(--dsht-muted);
    }

    .dsht-image-error {
      margin: 5px 0 0;
      font-size: 11.5px;
      line-height: 1.55;
      color: var(--dsht-danger);
      overflow-wrap: anywhere;
    }

    .dsht-image-original {
      margin-top: 6px;
      font-size: 10.5px;
    }

    .dsht-image-original summary {
      color: var(--dsht-faint);
      cursor: pointer;
      width: fit-content;
    }

    .dsht-image-original blockquote {
      margin: 5px 0 0;
      padding-left: 8px;
      border-left: 2px solid var(--dsht-line);
      color: var(--dsht-muted);
      white-space: pre-wrap;
      overflow-wrap: anywhere;
      line-height: 1.55;
      user-select: text;
    }

    .dsht-skeleton {
      height: 9px;
      margin-top: 8px;
      border-radius: 4px;
      background: linear-gradient(90deg, #f0f2f8 25%, #e6eaf4 37%, #f0f2f8 63%);
      background-size: 400% 100%;
      animation: dsht-shimmer 1.4s ease infinite;
    }

    .dsht-skeleton:first-child {
      margin-top: 4px;
    }

    .dsht-image-foot {
      flex: 0 0 auto;
      border-top: 1px solid var(--dsht-line);
      padding: 9px 14px;
      color: var(--dsht-faint);
      background: #fbfcff;
      font-size: 10px;
      line-height: 1.5;
    }

    /* ---------- toast ---------- */
    .dsht-toast {
      position: absolute;
      left: 50%;
      bottom: 28px;
      transform: translateX(-50%) translateY(4px);
      max-width: min(460px, calc(100vw - 32px));
      padding: 10px 14px;
      border-radius: 10px;
      background: #1c2638;
      color: #fff;
      box-shadow: 0 10px 30px rgba(23, 32, 51, 0.22);
      font-size: 12px;
      line-height: 1.55;
      pointer-events: none;
      text-align: center;
      overflow-wrap: anywhere;
      animation: dsht-toast-in 160ms ease forwards;
    }

    .dsht-toast[data-tone="error"] {
      background: #7f2a2a;
    }

    .dsht-toast[data-tone="success"] {
      background: #14614a;
    }

    @keyframes dsht-rise {
      from { opacity: 0; transform: translateY(6px); }
      to { opacity: 1; transform: translateY(0); }
    }

    @keyframes dsht-pulse {
      0%, 70%, 100% { opacity: 0.35; transform: translateY(0); }
      35% { opacity: 1; transform: translateY(-2px); }
    }

    @keyframes dsht-shimmer {
      0% { background-position: 100% 0; }
      100% { background-position: 0 0; }
    }

    @keyframes dsht-toast-in {
      from { opacity: 0; transform: translateX(-50%) translateY(4px); }
      to { opacity: 1; transform: translateX(-50%) translateY(0); }
    }

    @media (max-width: 720px) {
      .dsht-panel {
        left: 12px;
        right: 12px;
        bottom: 12px;
        width: auto;
      }
      .dsht-image-panel {
        left: 12px;
        right: 12px;
        top: 12px;
        bottom: auto;
        width: auto;
        max-height: 48vh;
      }
      .dsht-bubble {
        width: calc(100vw - 20px);
      }
    }

    @media (prefers-reduced-motion: reduce) {
      .dsht-panel,
      .dsht-bubble,
      .dsht-image-panel,
      .dsht-toast,
      .dsht-dots i,
      .dsht-skeleton {
        animation: none;
      }
      .dsht-progress-fill {
        transition: none;
      }
    }
  `;

})(typeof globalThis !== 'undefined' ? globalThis : this);
