'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createLocalizedContext } = require('../helpers/i18n');

const root = path.join(__dirname, '../..');
const extensionId = 'abcdefghijklmnopabcdefghijklmnop';
const extensionUrl = `chrome-extension://${extensionId}/`;
const sessionId = '12345678-1234-4234-8234-123456789abc';
const otherId = '12345678-1234-4234-8234-123456789def';
const MSG = { IMAGE_PANEL_UPDATE: 'dsht:imagePanelUpdate', IMAGE_PANEL_CLOSED: 'dsht:imagePanelClosed',
  IMAGE_PANEL_READY: 'dsht:imagePanelReady' };
const secret = 'sensitive OCR result';
const model = { visible: true, items: [{ status: 'done', hasText: true,
  thumbnail: 'data:image/jpeg;base64,AA==', original: secret, translation: secret }] };
const owner = { id: extensionId, tab: { id: 7 }, frameId: 0,
  documentId: 'document-1', url: 'https://example.test/' };

function event() {
  const listeners = [];
  return { addListener(fn) { listeners.push(fn); }, emit(...args) { for (const fn of listeners) fn(...args); } };
}

function loadBroker() {
  const connect = event(), updated = event(), removed = event();
  const sent = [], timers = new Set();
  const context = createLocalizedContext({ URL, console,
    DSHT: { config: { MSG, LIMITS: { IMAGE_MAX_COUNT: 6, IMAGE_MAX_DATA_URL_CHARS: 8388608 } } },
    setTimeout(fn) { timers.add(fn); return fn; }, clearTimeout(fn) { timers.delete(fn); },
    chrome: { runtime: { id: extensionId, getURL: (file) => extensionUrl + file, onConnect: connect },
      tabs: { onUpdated: updated, onRemoved: removed,
        async sendMessage(...args) { sent.push(args); } } } });
  vm.runInContext(fs.readFileSync(path.join(root, 'background/worker-image-panel.js'), 'utf8'), context);
  return { context, connect, updated, removed, sent, timers,
    update(message, sender = owner) { return context.handleImagePanelUpdate({ sessionId, model, ...message }, sender); } };
}

function viewer(overrides = {}) {
  const sender = { id: extensionId, tab: { id: 7 }, frameId: 3, documentId: 'viewer-1',
    origin: extensionUrl.slice(0, -1), url: `${extensionUrl}content/image-results.html#${sessionId}`, ...overrides };
  const messages = [];
  const port = { name: `dsht:image-panel:${sessionId}`, sender, onMessage: event(), onDisconnect: event(),
    disconnected: false, postMessage(message) { messages.push(JSON.parse(JSON.stringify(message))); },
    disconnect() { this.disconnected = true; this.onDisconnect.emit(); } };
  return { port, messages };
}

test('broker acknowledges owners without returning models and rejects changed owner identity', () => {
  const broker = loadBroker();
  assert.deepEqual(JSON.parse(JSON.stringify(broker.update({}))), { ok: true });
  for (const invalid of [undefined, { ...owner, id: 'another-extension' },
    { ...owner, tab: { id: 8 } }, { ...owner, frameId: 2 },
    { ...owner, documentId: 'new-document' }, { ...owner, documentId: undefined },
    { ...owner, url: extensionUrl + 'content/image-results.html' }]) {
    assert.throws(() => broker.update({}, invalid === undefined ? {} : invalid));
  }
});

test('only exact same-tab extension renderers receive models; duplicate viewers are bounded', () => {
  const broker = loadBroker();
  broker.update({});
  for (const invalid of [
    { id: 'another-extension' }, { tab: { id: 8 } }, { frameId: 0 },
    { origin: 'null' }, { origin: 'https://example.test' },
    { url: `https://example.test/content/image-results.html#${sessionId}` },
    { url: `${extensionUrl}content/image-results.html.evil#${sessionId}` },
    { url: `${extensionUrl}content/image-results.html?export=1#${sessionId}` },
    { url: `${extensionUrl}content/image-results.html#${otherId}` }
  ]) {
    const rejected = viewer(invalid);
    broker.connect.emit(rejected.port);
    assert.equal(rejected.port.disconnected, true);
    assert.equal(rejected.messages.length, 0);
  }
  const accepted = viewer();
  broker.connect.emit(accepted.port);
  assert.equal(accepted.messages[0].model.items[0].original, secret);
  const duplicate = viewer({ documentId: 'viewer-2', frameId: 4 });
  broker.connect.emit(duplicate.port);
  assert.equal(duplicate.port.disconnected, true);
  assert.equal(duplicate.messages.length, 0);
});

test('close never forwards viewer payload, clears buffers and targets only the owner document', async () => {
  const broker = loadBroker();
  broker.update({});
  const accepted = viewer();
  broker.connect.emit(accepted.port);
  accepted.port.onMessage.emit({ type: 'close', model, tabId: 99, documentId: 'attacker' });
  await Promise.resolve();
  assert.equal(accepted.port.disconnected, true);
  assert.deepEqual(JSON.parse(JSON.stringify(broker.sent.at(-1))), [7,
    { type: MSG.IMAGE_PANEL_CLOSED, sessionId }, { documentId: owner.documentId }]);
  const reopened = viewer();
  broker.connect.emit(reopened.port);
  assert.equal(reopened.port.disconnected, true);
  assert.equal(reopened.messages.length, 0);
});

test('renderer disconnect, tab removal and unclaimed-session expiry release models', () => {
  for (const cleanup of ['disconnect', 'expiry', 'removed']) {
    const broker = loadBroker();
    broker.update({});
    const accepted = viewer();
    if (cleanup !== 'expiry') broker.connect.emit(accepted.port);
    if (cleanup === 'removed') broker.removed.emit(7);
    if (cleanup === 'disconnect') accepted.port.disconnect();
    if (cleanup === 'expiry') for (const expire of [...broker.timers]) expire();
    const after = viewer();
    broker.connect.emit(after.port);
    assert.equal(after.port.disconnected, true, cleanup);
    assert.equal(after.messages.length, 0, cleanup);
  }
});

test('same-document navigation keeps the session and its port', () => {
  const broker = loadBroker();
  broker.update({});
  const accepted = viewer();
  broker.connect.emit(accepted.port);
  broker.updated.emit(7, { status: 'loading' });
  assert.ok(!accepted.port.disconnected);
  const received = accepted.messages.length;
  broker.update({});
  assert.equal(accepted.messages.length, received + 1, 'the session still reaches its renderer');
});

test('the owner hears the window is ready only once its renderer connected', () => {
  const broker = loadBroker();
  broker.update({});
  assert.equal(broker.sent.length, 0);
  broker.connect.emit(viewer().port);
  assert.deepEqual(JSON.parse(JSON.stringify(broker.sent)), [[7,
    { type: MSG.IMAGE_PANEL_READY, sessionId }, { documentId: owner.documentId }]]);
});

function node(tag) {
  const result = { tagName: tag.toUpperCase(), children: [], attributes: {}, style: { setProperty() {} },
    setAttribute(key, value) { this.attributes[key] = String(value); },
    appendChild(child) { this.children.push(child); child.parentNode = this; return child; },
    remove() { if (this.parentNode) this.parentNode.children = this.parentNode.children.filter((x) => x !== this); },
    attachShadow() { return node('shadow'); },
    addEventListener() {}, classList: { add() {}, remove() {} } };
  return result;
}

function loadBridge(sendMessage) {
  const messages = event(), pagehide = event();
  const layer = node('div');
  const bytesOf = (id) => id.replaceAll('-', '').match(/../g).map((pair) => parseInt(pair, 16));
  const nextId = (() => { let count = 0; return () => count++ ? otherId : sessionId; })();
  const context = createLocalizedContext({
    // Only getRandomValues: crypto.randomUUID does not exist on http pages.
    crypto: { getRandomValues(bytes) { bytes.set(bytesOf(nextId())); return bytes; } },
    setTimeout, clearTimeout,
    document: { createElement: node }, addEventListener(type, fn) { if (type === 'pagehide') pagehide.addListener(fn); },
    DSHT: { config: { MSG }, overlayParts: { setImportant() {} } },
    chrome: { runtime: { id: extensionId, getURL: (file) => extensionUrl + file,
      onMessage: messages, sendMessage } } });
  vm.runInContext(fs.readFileSync(path.join(root, 'content/overlay-image-frame.js'), 'utf8'), context);
  const bridge = context.DSHT.overlayParts.createImageFrame({});
  bridge.build(layer);
  const fromWorker = (message) => messages.emit(message, { id: extensionId });
  return { bridge, layer, messages, pagehide, fromWorker };
}

const tick = () => new Promise(setImmediate);

test('bridge leaves no model in page DOM and delayed updates cannot resurrect a hidden session', async () => {
  const pending = [], updates = [];
  const { bridge, layer } = loadBridge((message) => {
    updates.push(JSON.parse(JSON.stringify(message)));
    return new Promise((resolve) => pending.push(resolve));
  });
  bridge.render(model);
  await tick();
  assert.equal(layer.children.length, 0, 'renderer attaches after private model registration');
  bridge.hide();
  bridge.render({ ...model, emptyMessage: 'new run' });
  pending.shift()({ ok: true });
  await tick();
  assert.equal(layer.children.length, 0, 'old response cannot attach a stale iframe');
  pending.shift()({ ok: true });
  await tick();
  pending.shift()({ ok: true });
  await tick();
  assert.equal(layer.children.length, 1);
  const iframe = layer.children[0];
  assert.equal(iframe.src, `${extensionUrl}content/image-results.html#${otherId}`);
  assert.equal(JSON.stringify(iframe.attributes).includes(secret), false);
  assert.equal(iframe.children.length, 0);
  assert.equal(updates.at(-1).model.emptyMessage, 'new run');
});

test('bridge absorbs runtime errors and pagehide closes the private session', async () => {
  const failed = loadBridge(async () => { throw new Error(secret); });
  failed.bridge.render(model);
  await tick();
  assert.equal(failed.layer.children.length, 0);
  const updates = [];
  const active = loadBridge(async (message) => { updates.push(message); return { ok: true }; });
  active.bridge.render(model);
  await tick();
  active.pagehide.emit({ isTrusted: false });
  assert.equal(active.layer.children.length, 1);
  active.pagehide.emit({ isTrusted: true });
  await tick();
  assert.equal(active.layer.children.length, 0);
  assert.equal(updates.at(-1).model.visible, false);
});

test('a generated session id is a valid v4 UUID without randomUUID', async () => {
  const updates = [];
  const context = createLocalizedContext({ crypto: { getRandomValues: (bytes) => bytes.fill(0xff) },
    document: { createElement: node }, addEventListener() {},
    DSHT: { config: { MSG }, overlayParts: { setImportant() {} } },
    chrome: { runtime: { id: extensionId, getURL: (file) => extensionUrl + file, onMessage: event(),
      sendMessage: async (message) => { updates.push(message); return { ok: true }; } } } });
  vm.runInContext(fs.readFileSync(path.join(root, 'content/overlay-image-frame.js'), 'utf8'), context);
  const bridge = context.DSHT.overlayParts.createImageFrame({});
  bridge.build(node('div'));
  bridge.render(model);
  await tick();
  assert.equal(updates[0].sessionId, 'ffffffff-ffff-4fff-bfff-ffffffffffff');
});

test('ready waits for the renderer and reports a window that never connects', async () => {
  const active = loadBridge(async () => ({ ok: true }));
  active.bridge.render(model);
  await tick();
  const waiting = active.bridge.ready(1000);
  active.fromWorker({ type: MSG.IMAGE_PANEL_READY, sessionId });
  assert.equal(await waiting, true);
  assert.equal(await active.bridge.ready(1000), true);
  const blocked = loadBridge(async () => ({ ok: true }));
  blocked.bridge.render(model);
  await tick();
  assert.equal(await blocked.bridge.ready(1), false);
});

test('a finished wait cannot cancel the next one', async () => {
  const { bridge, fromWorker } = loadBridge(async () => ({ ok: true }));
  bridge.render(model);
  await tick();
  const first = bridge.ready(1);
  const second = bridge.ready(1000);
  assert.equal(await first, false);
  fromWorker({ type: MSG.IMAGE_PANEL_READY, sessionId });
  assert.equal(await second, true);
});

test('a window that failed to register ends the wait at once', async () => {
  const { bridge } = loadBridge(async () => { throw new Error('no worker'); });
  bridge.render(model);
  const waiting = bridge.ready(60000);
  await tick();
  assert.equal(await waiting, false);
});

test('moving the host rebuilds the window around the same model', async () => {
  const updates = [];
  const { bridge, layer } = loadBridge(async (message) => { updates.push(message); return { ok: true }; });
  bridge.render(model);
  await tick();
  let attachedWhileMoving = null;
  bridge.reattach(() => { attachedWhileMoving = layer.children.length; });
  await tick();
  assert.equal(attachedWhileMoving, 0, 'the old iframe is gone before the move');
  assert.equal(layer.children[0].src, `${extensionUrl}content/image-results.html#${otherId}`);
  assert.equal(updates.at(-1).model.items[0].original, secret);
});

test('renderer uses a private runtime port and clears its DOM when disconnected', () => {
  const accepted = viewer();
  const rendered = [], events = [], intervals = new Set();
  const context = createLocalizedContext({ URL, location: { hash: `#${sessionId}` },
    document: { body: node('body'), createElement: node },
    addEventListener(type) { events.push(type); },
    setInterval(fn) { intervals.add(fn); return fn; }, clearInterval(fn) { intervals.delete(fn); },
    chrome: { runtime: { connect() { return accepted.port; } } },
    DSHT: { overlayParts: { baseCss: '', imageCss: '', createImages() {
      return { build() {}, render(value) { rendered.push(value); }, hide() { rendered.push({ visible: false }); } } } } }
  });
  vm.runInContext(fs.readFileSync(path.join(root, 'content/image-results.js'), 'utf8'), context);
  accepted.port.onMessage.emit({ type: 'model', model });
  assert.equal(rendered.at(-1).items[0].original, secret);
  accepted.port.disconnect();
  assert.equal(rendered.at(-1).visible, false);
  assert.equal(intervals.size, 0);
  assert.equal(events.includes('message'), false);
  const source = fs.readFileSync(path.join(root, 'content/image-results.js'), 'utf8');
  assert.doesNotMatch(source, /postMessage\s*\(\s*[^)]*,\s*['"]\*|window\.name|(?:parent|top)\.(?:postMessage|location|name)/);
});
