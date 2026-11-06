/** Extension-origin renderer. It never exchanges web messages with its parent. */
(function showImageResults(globalScope) {
  'use strict';
  const id = location.hash.slice(1);
  if (!/^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i.test(id)) return;
  const parts = globalScope.DSHT.overlayParts;
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
  const images = parts.createImages({ onImageClose() {
    if (port) {
      try { port.postMessage({ type: 'close' }); } catch (_error) { clear(); }
    }
  } });
  images.build(layer);

  function clear() {
    clearInterval(heartbeat);
    heartbeat = null;
    images.hide();
    const previous = port;
    port = null;
    if (previous) {
      try { previous.disconnect(); } catch (_error) { /* Already disconnected. */ }
    }
  }

  try {
    port = chrome.runtime.connect({ name: 'dsht:image-panel:' + id });
    port.onDisconnect.addListener(clear);
    port.onMessage.addListener((message) => {
      if (message?.type === 'model') images.render(message.model);
    });
    // Port traffic keeps the worker alive only while this result window is open.
    heartbeat = setInterval(() => {
      try { port?.postMessage({ type: 'ping' }); } catch (_error) { clear(); }
    }, 25000);
  } catch (_error) { clear(); }
  globalScope.addEventListener('pagehide', clear);
})(globalThis);
