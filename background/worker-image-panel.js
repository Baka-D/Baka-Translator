/** Private runtime broker for image results; the web-visible hash is only a route. */
const imagePanelSessions = new Map();
const imagePanelResource = new URL(chrome.runtime.getURL('content/image-results.html'));
const imagePanelIdPattern = /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i;
const imagePanelConfig = globalThis.DSHT.config;

function imagePanelInvalid() {
  return Object.assign(new Error(t('bg_image_panel_expired')), { code: 'INVALID_IMAGE_PANEL' });
}

function imagePanelOwner(sender) {
  if (sender?.id !== chrome.runtime.id || !Number.isInteger(sender.tab?.id) ||
      !Number.isInteger(sender.frameId) || sender.frameId < 0 ||
      typeof sender.documentId !== 'string' || !sender.documentId ||
      typeof sender.url !== 'string' || !/^(https?:|file:)\/\//i.test(sender.url)) {
    throw imagePanelInvalid();
  }
  return { tabId: sender.tab.id, frameId: sender.frameId, documentId: sender.documentId };
}

function sameImagePanelOwner(a, b) {
  return a.tabId === b.tabId && a.frameId === b.frameId && a.documentId === b.documentId;
}

function tellImagePanelOwner(session, type) {
  void chrome.tabs.sendMessage(session.owner.tabId, { type, sessionId: session.id },
    { documentId: session.owner.documentId }).catch(() => {});
}

function forgetImagePanel(session, notifyOwner = false) {
  if (imagePanelSessions.get(session.id) !== session) return;
  imagePanelSessions.delete(session.id);
  clearTimeout(session.expiry);
  session.model = null;
  const port = session.port;
  session.port = null;
  if (port) {
    try { port.disconnect(); } catch (_error) { /* Already disconnected. */ }
  }
  if (notifyOwner) tellImagePanelOwner(session, imagePanelConfig.MSG.IMAGE_PANEL_CLOSED);
}

function imagePanelModel(model) {
  if (!model || model.visible !== true || !Array.isArray(model.items) ||
      model.items.length > imagePanelConfig.LIMITS.IMAGE_MAX_COUNT) throw imagePanelInvalid();
  const string = (value, limit = 100000) => typeof value === 'string' ? value.slice(0, limit) : '';
  return {
    visible: true, title: string(model.title, 120), subtitle: string(model.subtitle, 1000),
    footer: string(model.footer, 2000), emptyMessage: string(model.emptyMessage, 4000),
    items: model.items.map((item) => {
      if (!item || typeof item !== 'object') throw imagePanelInvalid();
      const thumbnail = string(item.thumbnail, imagePanelConfig.LIMITS.IMAGE_MAX_DATA_URL_CHARS);
      if (thumbnail && !/^data:image\/jpeg;base64,[A-Za-z0-9+/]+={0,2}$/.test(thumbnail)) {
        throw imagePanelInvalid();
      }
      return { thumbnail, thumbnailAlt: string(item.thumbnailAlt, 240),
        status: ['pending', 'loading', 'error', 'done'].includes(item.status) ? item.status : 'error',
        stateLabel: string(item.stateLabel, 120), hasText: item.hasText === true,
        translation: string(item.translation), original: string(item.original),
        sourceLabel: string(item.sourceLabel, 120), error: string(item.error, 4000) };
    })
  };
}

function handleImagePanelUpdate(message, sender) {
  const owner = imagePanelOwner(sender);
  if (!imagePanelIdPattern.test(message.sessionId)) throw imagePanelInvalid();
  let session = imagePanelSessions.get(message.sessionId);
  if (session && !sameImagePanelOwner(session.owner, owner)) throw imagePanelInvalid();
  if (message.model?.visible === false) {
    if (session) forgetImagePanel(session);
    return { ok: true };
  }
  const model = imagePanelModel(message.model);
  if (!session) {
    for (const previous of imagePanelSessions.values()) {
      if (sameImagePanelOwner(previous.owner, owner)) forgetImagePanel(previous);
    }
    if (imagePanelSessions.size >= 32) throw imagePanelInvalid();
    session = { id: message.sessionId, owner, model, port: null, expiry: null };
    imagePanelSessions.set(session.id, session);
    // A blocked iframe must not leave screenshot buffers waiting indefinitely.
    session.expiry = setTimeout(() => forgetImagePanel(session, true), 30000);
  } else {
    session.model = model;
  }
  if (session.port) {
    try { session.port.postMessage({ type: 'model', model }); }
    catch (_error) { forgetImagePanel(session, true); }
  }
  return { ok: true };
}

function imagePanelRenderer(port, session) {
  const sender = port.sender;
  if (sender?.id !== chrome.runtime.id || sender.tab?.id !== session.owner.tabId ||
      !Number.isInteger(sender.frameId) || sender.frameId <= 0 ||
      typeof sender.documentId !== 'string' || !sender.documentId) return false;
  try {
    const url = new URL(sender.url);
    const origin = new URL(sender.origin);
    return url.protocol === imagePanelResource.protocol && url.host === imagePanelResource.host &&
      origin.protocol === imagePanelResource.protocol && origin.host === imagePanelResource.host &&
      url.pathname === imagePanelResource.pathname && !url.search && url.hash === `#${session.id}`;
  } catch (_error) { return false; }
}

chrome.runtime.onConnect.addListener((port) => {
  if (!port.name.startsWith('dsht:image-panel:')) return;
  const id = port.name.slice('dsht:image-panel:'.length);
  const session = imagePanelSessions.get(id);
  if (!session || session.port || !imagePanelRenderer(port, session)) {
    port.disconnect();
    return;
  }
  session.port = port;
  clearTimeout(session.expiry);
  port.onDisconnect.addListener(() => forgetImagePanel(session, true));
  port.onMessage.addListener((message) => {
    if (message?.type === 'close') forgetImagePanel(session, true);
  });
  try {
    port.postMessage({ type: 'model', model: session.model });
    tellImagePanelOwner(session, imagePanelConfig.MSG.IMAGE_PANEL_READY);
  } catch (_error) { forgetImagePanel(session, true); }
});

function forgetTabImagePanels(tabId) {
  for (const session of imagePanelSessions.values()) {
    if (session.owner.tabId === tabId) forgetImagePanel(session);
  }
}

// No onUpdated cleanup: it also fires for pushState and hash changes, which keep the panel.
// Real navigation unloads the iframe, so the port disconnect above releases the session.
chrome.tabs.onRemoved.addListener(forgetTabImagePanels);
