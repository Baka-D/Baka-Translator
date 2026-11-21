/** Extension-origin renderer. It never exchanges web messages with its parent. */
(async function showImageResults(globalScope) {
  'use strict';
  const id = location.hash.slice(1);
  if (!/^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i.test(id)) return;
  const { config, i18n, overlayParts: parts } = globalScope.DSHT;
  await i18n.ready;
  const host = document.createElement('div');
  host.id = 'image-results';
  const shadow = host.attachShadow({ mode: 'closed' });
  const style = document.createElement('style');
  style.textContent = parts.baseCss + parts.imageCss + `
    .dsht-image-panel { inset: 8px !important; width: auto !important;
      height: calc(100% - 16px); max-height: none !important; }
  `;
  shadow.appendChild(style);
  const layer = document.createElement('div');
  layer.className = 'dsht-layer';
  shadow.appendChild(layer);
  document.body.appendChild(host);
  let port = null;
  let heartbeat = null;
  let model = null;
  const images = parts.createImages({ onImageClose() {
    if (port) {
      try { port.postMessage({ type: 'close' }); } catch (_error) { disconnected(); }
    }
  } });
  images.build(layer);
  i18n.onChange(() => {
    i18n.localizeDocument(shadow);
    if (model) images.render(model);
  });

  function clear() {
    clearInterval(heartbeat);
    heartbeat = null;
    model = null;
    images.hide();
    const previous = port;
    port = null;
    if (previous) {
      try { previous.disconnect(); } catch (_error) { /* Already disconnected. */ }
    }
  }

  function disconnected() {
    void chrome.runtime.lastError;
    const wasShowingResults = Boolean(model);
    clear();
    if (wasShowingResults) {
      // A terminated worker cannot notify the content script over the old port.
      try {
        void chrome.runtime.sendMessage({ type: config.MSG.IMAGE_PANEL_DISCONNECTED, sessionId: id })
          .catch(() => {});
      } catch (_error) { /* The extension was reloaded or disabled. */ }
    }
  }

  try {
    port = chrome.runtime.connect({ name: 'dsht:image-panel:' + id });
    port.onDisconnect.addListener(disconnected);
    port.onMessage.addListener((message) => {
      if (message?.type === 'model') {
        model = message.model;
        images.render(model);
      }
    });
    // Port traffic keeps the worker alive only while this result window is open.
    heartbeat = setInterval(() => {
      try { port?.postMessage({ type: 'ping' }); } catch (_error) { disconnected(); }
    }, 25000);
  } catch (_error) { clear(); }
  globalScope.addEventListener('pagehide', clear);
})(globalThis);
