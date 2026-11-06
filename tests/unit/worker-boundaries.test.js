'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const config = require('../../shared/config.js');

const sender = { tab: { id: 5, windowId: 7 }, frameId: 0, documentId: 'top-doc' };
const screenshot = 'data:image/png;base64,AA==';

function event() {
  const listeners = new Set();
  return {
    addListener(listener) { listeners.add(listener); },
    removeListener(listener) { listeners.delete(listener); },
    emit(...args) { for (const listener of [...listeners]) listener(...args); },
    get size() { return listeners.size; }
  };
}

function loadWorker(options = {}) {
  const events = Object.fromEntries(['onActivated', 'onUpdated', 'onRemoved', 'onReplaced', 'onDetached', 'onAttached']
    .map((name) => [name, event()]));
  const messages = [], injections = [], errors = [], readyHosts = [];
  const state = { tab: { id: 5, windowId: 7, active: true, url: 'https://parent.example/' },
    documentId: 'top-doc', frameUrl: 'https://child.example/private', captures: 0, probes: 0,
    contentReady: options.contentReady !== false };
  class PageAccessError extends Error {
    constructor(code, message) { super(message); this.code = code; }
  }
  const context = vm.createContext({
    config, MSG: config.MSG, CONTENT_SCRIPTS: ['content/content.js'],
    MENU_IDS: { SELECTION: 'selection' }, PAGE_ACCESS_ERRORS: {}, PageAccessError, setTimeout,
    hostnameFromSender: () => 'parent.example', hostnameFromUrl: (url) => new URL(url).hostname,
    requireRuntimeReady: async (_purpose, hostname) => {
      readyHosts.push(hostname);
      if (options.ready) await options.ready({ state, events });
    },
    requireVisionRuntime: async () => {
      if (options.ready) await options.ready({ state, events });
    },
    chrome: {
      runtime: {},
      tabs: { ...events,
        get: async () => ({ ...state.tab }),
        captureVisibleTab: (_windowId, _options, callback) => {
          state.captures += 1;
          if (options.capture) options.capture({ state, events });
          callback(screenshot);
        },
        sendMessage: async (tabId, message, recipient) => {
          messages.push({ tabId, message, recipient });
          if (recipient?.documentId && recipient.documentId !== state.documentId) throw new Error('document navigated');
          return message.type === config.MSG.PING ? { ok: state.contentReady } : { started: true };
        }
      },
      scripting: { executeScript: async (request) => {
        if (request.files) {
          injections.push(request.target);
          if (request.target.documentIds && !request.target.documentIds.includes(state.documentId)) {
            throw new Error('document navigated');
          }
          state.contentReady = true;
          return [];
        }
        state.probes += 1;
        if (options.probe) await options.probe({ state, events });
        const frameId = request.target.frameIds[0];
        return [{ frameId, documentId: state.documentId,
          result: frameId === 0 ? state.tab.url : state.frameUrl }];
      } }
    }
  });
  for (const file of ['worker-pages.js', 'worker-capture.js']) {
    vm.runInContext(fs.readFileSync(path.join(__dirname, '../../background', file), 'utf8'), context);
  }
  context.reportActionError = async (_tabId, error) => { errors.push(error); };
  return { context, events, state, messages, injections, errors, readyHosts };
}

function assertClean(worker) {
  assert.ok(Object.values(worker.events).every((value) => value.size === 0), 'capture lifecycle listeners must be removed');
}

test('a capture keeps the requesting active document and removes its guards', async () => {
  const worker = loadWorker();
  const result = await worker.context.capturePageScreenshot(sender);
  assert.equal(result.dataUrl, screenshot);
  assert.equal(worker.state.captures, 1);
  assert.equal(worker.state.probes, 2);
  assertClean(worker);
});

test('runtime readiness cannot leave a stale active-tab authorization', async () => {
  const worker = loadWorker({ ready: async ({ state, events }) => {
    await new Promise(setImmediate);
    state.tab.active = false;
    events.onActivated.emit({ tabId: 9, windowId: 7 });
  } });
  await assert.rejects(worker.context.capturePageScreenshot(sender), { code: 'SCREENSHOT_FAILED' });
  assert.equal(worker.state.captures, 0);
  assertClean(worker);
});

test('switching away and back during capture discards the screenshot', async () => {
  const worker = loadWorker({ capture: ({ events }) => {
    events.onActivated.emit({ tabId: 9, windowId: 7 });
    events.onActivated.emit({ tabId: 5, windowId: 7 });
  } });
  await assert.rejects(worker.context.capturePageScreenshot(sender), { code: 'SCREENSHOT_FAILED' });
  assert.equal(worker.state.captures, 1);
  assertClean(worker);
});

test('switching to another tab during capture discards the screenshot', async () => {
  const worker = loadWorker({ capture: ({ state }) => { state.tab.active = false; } });
  await assert.rejects(worker.context.capturePageScreenshot(sender), { code: 'SCREENSHOT_FAILED' });
  assertClean(worker);
});

for (const [name, mutate] of [
  ['same-URL reload', ({ events }) => events.onUpdated.emit(5, { status: 'loading' })],
  ['navigation', ({ events }) => events.onUpdated.emit(5, { url: 'https://other.example/' })],
  ['replacement', ({ events }) => events.onReplaced.emit(9, 5)],
  ['removal', ({ events }) => events.onRemoved.emit(5, { windowId: 7 })],
  ['detachment', ({ events }) => events.onDetached.emit(5, { oldWindowId: 7 })],
  ['attachment', ({ events }) => events.onAttached.emit(5, { newWindowId: 9 })],
  ['window migration', ({ state }) => { state.tab.windowId = 9; }],
  ['document replacement without an update event', ({ state }) => { state.documentId = 'new-doc'; }]
]) {
  test(`${name} during capture discards bytes and removes guards`, async () => {
    const worker = loadWorker({ capture: mutate });
    await assert.rejects(worker.context.capturePageScreenshot(sender), { code: 'SCREENSHOT_FAILED' });
    assertClean(worker);
  });
}

test('unrelated-window tab activity does not interrupt the requested capture', async () => {
  const worker = loadWorker({ capture: ({ events }) => events.onActivated.emit({ tabId: 9, windowId: 8 }) });
  assert.equal((await worker.context.capturePageScreenshot(sender)).dataUrl, screenshot);
  assertClean(worker);
});

test('capture rejects child-frame and missing-document callers before reading pixels', async () => {
  for (const invalid of [{ ...sender, frameId: 4 }, { ...sender, documentId: undefined }, { ...sender, documentId: 'stale-doc' }]) {
    const worker = loadWorker();
    await assert.rejects(worker.context.capturePageScreenshot(invalid), { code: 'SCREENSHOT_FAILED' });
    assert.equal(worker.state.captures, 0);
    assertClean(worker);
  }
});

test('vision readiness failures retain their error and remove capture listeners', async () => {
  const worker = loadWorker({ ready: async () => { throw Object.assign(new Error('unsupported'), { code: 'VISION_UNSUPPORTED' }); } });
  await assert.rejects(worker.context.capturePageScreenshot(sender), { code: 'VISION_UNSUPPORTED' });
  assert.equal(worker.state.captures, 0);
  assertClean(worker);
});

function selectionInfo(extra = {}) {
  return { menuItemId: 'selection', frameId: 3, frameUrl: 'https://child.example/private',
    selectionText: 'private selected text', ...extra };
}

test('iframe selection text and injection stay in the source document', async () => {
  const worker = loadWorker({ contentReady: false });
  worker.state.documentId = 'child-doc';
  await worker.context.handleContextMenuClick(selectionInfo(), worker.state.tab);
  assert.equal(worker.errors.length, 0);
  assert.deepEqual(worker.readyHosts, ['child.example']);
  assert.deepEqual(JSON.parse(JSON.stringify(worker.injections)), [{ tabId: 5, documentIds: ['child-doc'] }]);
  const sent = worker.messages.find((entry) => entry.message.type === config.MSG.TRANSLATE_SELECTION);
  assert.equal(sent.message.text, 'private selected text');
  assert.equal(sent.recipient.documentId, 'child-doc');
  assert.ok(worker.messages.every((entry) => entry.recipient.documentId === 'child-doc'));
});

test('selection navigation after authorization fails without sending text to a replacement or parent', async () => {
  const worker = loadWorker({ ready: async ({ state }) => { state.documentId = 'replacement-doc'; } });
  worker.state.documentId = 'child-doc';
  await worker.context.handleContextMenuClick(selectionInfo(), worker.state.tab);
  assert.equal(worker.errors.length, 1);
  assert.equal(worker.messages.some((entry) => entry.message.text), false);
  assert.ok(worker.messages.every((entry) => entry.recipient.documentId === 'child-doc'));
});

test('selection from a navigated or missing source frame fails before text delivery', async () => {
  for (const extra of [{ frameUrl: 'https://previous.example/' }, { frameId: 3, frameUrl: undefined }, { frameId: -1 }]) {
    const worker = loadWorker();
    await worker.context.handleContextMenuClick(selectionInfo(extra), worker.state.tab);
    assert.equal(worker.errors.length, 1);
    assert.equal(worker.messages.length, 0);
  }
});

test('top-frame context selection remains supported with document pinning', async () => {
  const worker = loadWorker();
  await worker.context.handleContextMenuClick(selectionInfo({ frameId: 0, pageUrl: worker.state.tab.url }), worker.state.tab);
  assert.equal(worker.errors.length, 0);
  assert.equal(worker.messages.at(-1).recipient.documentId, 'top-doc');
});

test('ordinary page messages and injection explicitly target only frame zero', async () => {
  const worker = loadWorker({ contentReady: false });
  await worker.context.sendToContent(5, { type: config.MSG.TRANSLATE_IMAGES });
  assert.deepEqual(JSON.parse(JSON.stringify(worker.injections)), [{ tabId: 5, frameIds: [0] }]);
  assert.ok(worker.messages.every((entry) => entry.recipient.frameId === 0 && !entry.recipient.documentId));
});
