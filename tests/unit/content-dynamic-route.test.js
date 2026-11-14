'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');
const { createLocalizedContext } = require('../helpers/i18n');
const config = require('../../shared/config');
const textUtils = require('../../shared/text');

function harness(count = 1) {
  const location = { origin: 'https://example.test', pathname: '/first', search: '', hash: '' };
  const requests = [], costs = [], captions = [], timers = new Map();
  let disconnected = false;
  const document = {
    getElementById: (id) => id === 'chapter' ? {} : null,
    getElementsByName: () => [], querySelectorAll: () => [],
    createTreeWalker(root) {
      let visited = false;
      return { nextNode() { if (visited) return null; visited = true; return root.node; } };
    },
    createElement() {
      return {
        isConnected: true, style: { setProperty() {} }, setAttribute() {},
        remove() { this.isConnected = false; captions.splice(captions.indexOf(this), 1); }
      };
    }
  };
  const nodes = Array.from({ length: count }, (_,index) => {
    const node = { nodeType: 3, nodeValue: 'Original text ' + index, isConnected: true };
    const anchor = {
      isConnected: true, ownerDocument: document, node, querySelector: () => null,
      get innerText() { return node.nodeValue; },
      appendChild(caption) { captions.push(caption); }
    };
    node.parentNode = node.parentElement = anchor;
    return node;
  });
  const page = {
    status: 'done', runId: 1, translatedRoute: 'https://example.test/first',
    targetCode: 'zh', source: { code: 'en' }, bilingual: true, glossary: [],
    progress: { done: 1, total: 1, failed: 0 },
    dynamicQueue: new Set(nodes), dynamicNodeCount: 0, dynamicCharCount: 0,
    translatedNodes: new Map(), initialTranslations: new Map(),
    translationMemory: new Map(), captions: new Set(),
    observers: [{ disconnect() { disconnected = true; } }]
  };
  const app = {
    config, textUtils, MSG: config.MSG, BILINGUAL_ATTR: 'data-dsht-original',
    LIMITS: { ...config.LIMITS, TEXT_MAX_BATCH_ITEMS: 1 },
    FATAL_ERROR_CODES: new Set(['AUTH_FAILED']), page,
    overlay: { showToast() {}, hidePanel() {} },
    renderPagePanel() {}, notifyBadge() {}, cancelPretranslation() {},
    addPageCost(value) { if (value) costs.push(value); },
    collectTargets(roots) {
      return { targets: roots.map(node => ({
        node, core: node.nodeValue, original: node.nodeValue,
        leading: '', trailing: '', anchor: node.parentElement
      })) };
    },
    sendRuntime(message) {
      if (message.type !== config.MSG.TRANSLATE_BATCH) return Promise.resolve({});
      return new Promise((resolve, reject) => { requests.push({ message, resolve, reject }); });
    }
  };
  const context = createLocalizedContext({
    DSHT: { contentModules: {} }, document, location,
    NodeFilter: { SHOW_TEXT: 4 },
    setTimeout(callback) { const id = timers.size + 1; timers.set(id, callback); return id; },
    clearTimeout(id) { timers.delete(id); }
  });
  for (const name of ['captions', 'page', 'dynamic']) {
    const file = path.resolve(__dirname, '../../content/content-' + name + '.js');
    vm.runInContext(fs.readFileSync(file, 'utf8'), context, { filename: file });
    Object.assign(app, context.DSHT.contentModules[name](app));
  }
  function reply(request, billing = 1) {
    request.resolve({
      translations: request.message.segments.map(({ id }) => ({ id, text: 'Translated text' })),
      billing, discardedBilling: [0.25]
    });
  }
  return { app, page, location, nodes, requests, costs, captions, timers, reply,
    disconnected: () => disconnected };
}

function assertStopped(h) {
  assert.equal(h.disconnected(), true);
  assert.equal(h.page.observers.length, 0);
  assert.equal(h.page.dynamicQueue.size, 0);
  assert.equal(h.timers.size, 0);
  assert.equal(h.page.dynamicBusy, false);
  assert.equal(h.captions.length, 0);
  assert.equal(h.page.dynamicNodeCount, 0);
}

test('late dynamic replies keep their cost but never write text or captions on another route', async () => {
  const h = harness(4);
  const pending = h.app.flushDynamicQueue();
  assert.equal(h.requests.length, 2);
  h.page.dynamicQueue.add(h.nodes[0]);
  h.app.scheduleDynamicFlush();
  h.location.pathname = '/second';
  for (const request of h.requests) h.reply(request);
  await pending;
  assert.deepEqual(h.nodes.map(node => node.nodeValue), Array.from({ length: 4 }, (_, i) => 'Original text ' + i));
  assert.deepEqual(h.costs, [1, 0.25, 1, 0.25]);
  assert.equal(h.requests.length, 2, 'the remaining batches never leave the old route');
  assertStopped(h);
  h.app.restorePage({ silent: true });
  assert.equal(h.nodes[0].nodeValue, 'Original text 0');
});

test('late dynamic failures keep discarded cost without setting errors on another route', async () => {
  const h = harness();
  const pending = h.app.flushDynamicQueue();
  h.location.search = '?chapter=2';
  h.requests[0].reject(Object.assign(new Error('Old account failure'), {
    code: 'AUTH_FAILED', discardedBilling: [0.5]
  }));
  await pending;
  assert.deepEqual(h.costs, [0.5]);
  assert.equal(Boolean(h.page.abortFatal), false);
  assert.equal(h.page.error, undefined);
  assertStopped(h);
});

test('navigation after the last text write still prevents late captions and rescheduling', async () => {
  const h = harness();
  const apply = h.app.applyTranslationsForBatch;
  h.app.applyTranslationsForBatch = (...args) => {
    const result = apply(...args);
    // A page's mutation observer may navigate before Promise.all resumes.
    queueMicrotask(() => { h.location.pathname = '/second'; });
    return result;
  };
  const pending = h.app.flushDynamicQueue();
  h.page.dynamicQueue.add(h.nodes[0]);
  h.reply(h.requests[0]);
  await pending;
  assert.equal(h.nodes[0].nodeValue, 'Translated text');
  assert.deepEqual(h.costs, [1, 0.25]);
  assertStopped(h);
  h.app.restorePage({ silent: true });
  assert.equal(h.nodes[0].nodeValue, 'Original text 0');
});

test('an in-page anchor keeps translation, billing, captions and restoration working', async () => {
  const h = harness();
  const pending = h.app.flushDynamicQueue();
  h.location.hash = '#chapter';
  h.reply(h.requests[0]);
  await pending;
  assert.equal(h.nodes[0].nodeValue, 'Translated text');
  assert.deepEqual(h.costs, [1, 0.25]);
  assert.equal(h.captions.length, 1);
  assert.equal(h.page.dynamicNodeCount, 1);
  assert.equal(h.disconnected(), false);
  h.app.restorePage({ silent: true });
  assert.equal(h.nodes[0].nodeValue, 'Original text 0');
  assert.equal(h.captions.length, 0);
});

test('a restored old request cannot change the cost or scheduling state of a new run', async () => {
  const h = harness();
  const pending = h.app.flushDynamicQueue();
  h.app.restorePage({ silent: true });
  h.page.status = 'done';
  h.page.dynamicBusy = true;
  h.page.dynamicQueue.add(h.nodes[0]);
  h.app.scheduleDynamicFlush();
  h.reply(h.requests[0]);
  await pending;
  assert.equal(h.nodes[0].nodeValue, 'Original text 0');
  assert.deepEqual(h.costs, []);
  assert.equal(h.captions.length, 0);
  assert.equal(h.page.dynamicBusy, true);
  assert.equal(h.page.dynamicQueue.size, 1);
  assert.equal(h.timers.size, 1);
});
