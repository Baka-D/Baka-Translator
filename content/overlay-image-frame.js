/** Image models cross only the extension runtime; the iframe DOM carries no results. */
(function initImageFrame(globalScope) {
  'use strict';
  const parts = globalScope.DSHT.overlayParts;
  const MSG = globalScope.DSHT.config.MSG;

  parts.createImageFrame = function createImageFrame(callbacks) {
    let layer = null;
    let frame = null;
    let session = null;
    let queue = Promise.resolve();

    function removeFrame() {
      if (frame) frame.remove();
      frame = null;
    }

    function update(id, model) {
      return chrome.runtime.sendMessage({ type: MSG.IMAGE_PANEL_UPDATE, sessionId: id, model });
    }

    function hide() {
      const previous = session;
      session = null;
      removeFrame();
      if (!previous) return;
      previous.model = null;
      queue = queue.then(() => update(previous.id, { visible: false })).catch(() => {});
    }

    function attach(current) {
      if (frame || !layer || session !== current) return;
      frame = document.createElement('iframe');
      frame.className = 'dsht-image-frame';
      frame.title = 'Baka Translator 图片翻译';
      frame.referrerPolicy = 'no-referrer';
      frame.src = chrome.runtime.getURL('content/image-results.html') + '#' + current.id;
      // Geometry depends only on the viewport, never on OCR text or image contents.
      const styles = { position: 'absolute', left: '12px', bottom: '12px',
        width: 'min(372px, calc(100vw - 24px))', height: 'min(70vh, 656px)',
        border: '0', padding: '0', margin: '0', background: 'transparent',
        'pointer-events': 'auto', 'color-scheme': 'light' };
      for (const [key, value] of Object.entries(styles)) parts.setImportant(frame, key, value);
      layer.appendChild(frame);
    }

    function schedule(current) {
      if (current.scheduled) return;
      current.scheduled = true;
      queue = queue.then(async () => {
        current.scheduled = false;
        if (session !== current) return;
        const response = await update(current.id, current.model);
        if (!response?.ok) throw new Error('Image panel unavailable');
        if (session === current) attach(current);
      }).catch(() => {
        if (session === current) hide();
      });
    }

    function render(model) {
      if (!model?.visible) { hide(); return; }
      if (!session) session = { id: crypto.randomUUID(), model, scheduled: false };
      else session.model = model;
      schedule(session);
    }

    chrome.runtime.onMessage.addListener((message, sender) => {
      if (sender.id !== chrome.runtime.id || message?.type !== MSG.IMAGE_PANEL_CLOSED ||
          !session || message.sessionId !== session.id) return false;
      hide();
      if (callbacks.onImageClose) callbacks.onImageClose();
      return false;
    });
    globalScope.addEventListener('pagehide', (event) => {
      if (event.isTrusted === true) hide();
    });

    return { build(nextLayer) {
      removeFrame();
      layer = nextLayer;
      if (session) schedule(session);
    }, render, hide };
  };
})(globalThis);
