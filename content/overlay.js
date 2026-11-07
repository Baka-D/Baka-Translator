/** In-page Shadow DOM host; UI components and styles live in overlay-*.js. */
(function initOverlay(globalScope) {
  'use strict';
  const parts = globalScope.DSHT.overlayParts;
  const { el, setImportant } = parts;
  const CSS = parts.baseCss + parts.imageCss;
  const HOST_TAG = 'div';
  const HOST_ID = '__deepseek_translate_overlay__';

  function installStyles(shadow) {
    try {
      const sheet = new CSSStyleSheet();
      sheet.replaceSync(CSS);
      shadow.adoptedStyleSheets = [sheet];
    } catch (_error) {
      const style = document.createElement('style');
      style.textContent = CSS;
      shadow.appendChild(style);
    }
  }

  function createOverlay(options) {
    const opts = options || {};
    const callbacks = opts.callbacks || {};
    const languages = Array.isArray(opts.languages) ? opts.languages : [];
    const panel = parts.createPanel(callbacks);
    const bubble = parts.createBubble(callbacks, languages);
    const images = parts.createImageFrame(callbacks);
    let host = null;
    let shadow = null;
    let toast = null;
    let toastTimer = 0;
    let outsideBound = false;

    function ensureUi() {
      if (host && host.isConnected) return;
      if (!document.documentElement) return;

      host = document.createElement(HOST_TAG);
      host.id = HOST_ID;
      host.setAttribute('data-dsht-ui', 'overlay');
      setImportant(host, 'position', 'fixed');
      setImportant(host, 'inset', '0');
      setImportant(host, 'z-index', '2147483647');
      setImportant(host, 'display', 'block');
      setImportant(host, 'pointer-events', 'none');
      setImportant(host, 'margin', '0');
      setImportant(host, 'padding', '0');
      setImportant(host, 'border', '0');
      setImportant(host, 'background', 'transparent');
      setImportant(host, 'overflow', 'visible');
      setImportant(host, 'color-scheme', 'light');

      shadow = host.attachShadow({ mode: 'closed' });
      installStyles(shadow);

      const layer = el('div', 'dsht-layer');
      shadow.appendChild(layer);

      panel.build(layer);
      bubble.build(layer);
      images.build(layer);
      buildToast(layer);

      (document.fullscreenElement || document.documentElement).appendChild(host);
      bindOutsideDismiss();
    }

    function relayoutHost() {
      if (!host) return;
      const parent = document.fullscreenElement || document.documentElement;
      if (parent && host.parentNode !== parent) images.reattach(() => parent.appendChild(host));
    }

    function buildToast(layer) {
      toast = el('div', 'dsht-toast dsht-hidden');
      toast.setAttribute('role', 'status');
      toast.setAttribute('aria-live', 'polite');
      layer.appendChild(toast);
    }

    function bindOutsideDismiss() {
      if (outsideBound) return;
      outsideBound = true;
      document.addEventListener(
        'pointerdown',
        (event) => {
          if (event.isTrusted !== true) return;
          if (!bubble.isVisible()) return;
          const path = typeof event.composedPath === 'function' ? event.composedPath() : [];
          if (!path.includes(host)) bubble.close();
        },
        true
      );
      document.addEventListener(
        'keydown',
        (event) => {
          if (event.isTrusted !== true) return;
          if (event.key !== 'Escape') return;
          if (bubble.isVisible()) {
            bubble.close();
          }
        },
        true
      );
      document.addEventListener('fullscreenchange', relayoutHost);
    }

    function showToast(message, tone) {
      ensureUi();
      if (!toast) return;
      clearTimeout(toastTimer);
      toast.textContent = String(message || '');
      toast.dataset.tone = tone || 'info';
      toast.classList.remove('dsht-hidden');
      toastTimer = setTimeout(() => {
        if (toast) toast.classList.add('dsht-hidden');
      }, 3600);
    }

    /**
     * Hide all extension UI just before chrome.tabs.captureVisibleTab(), so our
     * own panels never end up inside the screenshot sent for OCR.
     */
    function setCaptureMode(hidden) {
      if (!host) return;
      if (hidden) setImportant(host, 'visibility', 'hidden');
      else setImportant(host, 'visibility', 'visible');
    }

    function renderPanel(model) {
      if (model && model.visible) ensureUi();
      panel.render(model);
    }

    function renderBubble(model) {
      if (model && model.visible) ensureUi();
      bubble.render(model);
    }

    function renderImagePanel(model) {
      if (model && model.visible) ensureUi();
      images.render(model);
    }

    return Object.freeze({
      renderPanel, hidePanel: panel.hide,
      renderBubble, hideBubble: bubble.hide, positionBubble: bubble.position,
      renderImagePanel, hideImagePanel: images.hide, waitImagePanel: images.ready,
      setCaptureMode, showToast
    });
  }

  globalScope.DSHT.overlay = Object.freeze({ createOverlay });
})(typeof globalThis !== 'undefined' ? globalThis : this);
