'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');
const { createLocalizedContext } = require('../helpers/i18n');
const config = require('../../shared/config');
const textUtils = require('../../shared/text');

function harness() {
  const sent = [], costs = [], timers = new Map();
  const clock = { now: 1000 };
  const location = { origin: 'https://example.test', pathname: '/page', search: '', hash: '' };
  const document = {
    body: {}, querySelectorAll: () => [],
    defaultView: { getComputedStyle: () => ({ display: 'inline', visibility: 'visible' }) },
    createTreeWalker(root, _what, filter) {
      const nodes = [];
      const visit = node => {
        if (node.nodeType === 3) { if (!filter || filter.acceptNode(node) === 1) nodes.push(node); }
        else node.children.forEach(visit);
      };
      root.children.forEach(visit);
      let index = 0;
      return { nextNode: () => nodes[index++] || null };
    }
  };
  const sibling = node => node.parentNode?.children[node.parentNode.children.indexOf(node) + 1] || null;
  const element = (parent = null, tagName = 'SECTION') => {
    const value = {
      nodeType: 1, tagName, ownerDocument: document, isConnected: true,
      parentNode: parent, parentElement: parent, children: [], hasAttribute: () => false,
      addEventListener() {}, removeEventListener() {},
      querySelectorAll: () => [], checkVisibility: () => true,
      closest(selector) {
        for (let node = this; selector === 'ruby' && node; node = node.parentNode) {
          if (node.tagName === 'RUBY') return node;
        }
        return null;
      },
      get childNodes() { return this.children; },
      get nextSibling() { return sibling(this); },
      get textContent() { return this.children.map(child => child.nodeValue ?? child.textContent).join(''); }
    };
    parent?.children.push(value);
    return value;
  };
  const root = element();
  const addText = (text, parent = element(root)) => {
    const node = { nodeType: 3, nodeValue: text, parentNode: parent, parentElement: parent,
      ownerDocument: document, isConnected: true, get nextSibling() { return sibling(this); } };
    parent.children.push(node);
    return node;
  };
  const page = {
    status: 'done', runId: 1, truncated: true, translatedRoute: 'https://example.test/page',
    translatedDocuments: new WeakSet([document]), targetCode: 'zh', glossary: [],
    dynamicQueue: new Set(), dynamicNodeCount: 0, dynamicCharCount: 0,
    translatedNodes: new Map(), initialTranslations: new Map(), translationMemory: new Map(),
    captions: new Set(), observers: []
  };
  let observer, nextTimer = 0;
  const context = createLocalizedContext({
    DSHT: { contentModules: {} }, document, location,
    Node: { TEXT_NODE: 3, ELEMENT_NODE: 1 },
    NodeFilter: { SHOW_TEXT: 4, FILTER_ACCEPT: 1, FILTER_REJECT: 2 },
    Date: class extends Date { static now() { return clock.now; } },
    MutationObserver: class {
      constructor(callback) { observer = callback; }
      observe() {} disconnect() {}
    },
    setTimeout(callback) { timers.set(++nextTimer, callback); return nextTimer; },
    clearTimeout(id) { timers.delete(id); }
  });
  const app = {
    config, textUtils, MSG: config.MSG, LIMITS: config.LIMITS, page,
    BILINGUAL_ATTR: 'data-dsht-original', FATAL_ERROR_CODES: new Set(),
    overlay: { showToast() {}, hidePanel() {} },
    renderPagePanel() {}, notifyBadge() {}, cancelPretranslation() {},
    collectComposedTextRoots: () => [root],
    addPageCost(billing) { if (billing) costs.push(billing); },
    async sendRuntime(message) {
      if (message.type !== config.MSG.TRANSLATE_BATCH) return {};
      sent.push(...message.segments.map(segment => segment.text));
      return { billing: 1, translations: message.segments.map(({ id, text }) => ({ id, text: '译:' + text })) };
    }
  };
  for (const name of ['ruby', 'dom', 'captions', 'page', 'dynamic']) {
    const file = path.resolve(__dirname, '../../content/content-' + name + '.js');
    vm.runInContext(fs.readFileSync(file, 'utf8'), context, { filename: file });
    Object.assign(app, context.DSHT.contentModules[name](app));
  }
  app.collectComposedTextRoots = () => [root];
  app.startDynamicObserver();
  function rewrite(node, text, type = 'characterData') {
    node.nodeValue = text;
    observer([type === 'characterData' ? { type, target: node } : { type, addedNodes: [node] }]);
    clock.now += 100;
  }
  function scanAncestor(kind = 'reveal') {
    observer([kind === 'reveal'
      ? { type: 'attributes', attributeName: 'class', target: root }
      : { type: 'childList', addedNodes: [root] }]);
  }
  async function flush() {
    timers.delete(page.dynamicTimer);
    page.dynamicTimer = 0;
    await app.flushDynamicQueue();
  }
  return { app, page, clock, location, root, element, addText, rewrite, scanAncestor, flush, sent, costs, timers };
}

for (const kind of ['reveal', 'insertion']) {
  test(`an ancestor ${kind} translates stable siblings and retains live descendants for later`, async () => {
    const h = harness();
    const live = h.addText('Start');
    const stable = h.addText('Stable sibling');
    h.rewrite(live, 'First word');
    h.rewrite(live, 'Second word');
    h.scanAncestor(kind);
    await h.flush();
    assert.deepEqual(h.sent, ['Stable sibling']);
    assert.equal(stable.nodeValue, '译:Stable sibling');
    assert.equal(live.nodeValue, 'Second word');
    assert.equal(h.page.dynamicNodeCount, 1);
    assert.equal(h.page.dynamicCharCount, 'Stable sibling'.length);
    assert.equal(h.page.dynamicQueue.has(live), true);
    assert.equal(h.timers.size, 1);
    h.clock.now += 2000;
    await h.flush();
    assert.deepEqual(h.sent, ['Stable sibling', 'Second word']);
    assert.equal(live.nodeValue, '译:Second word');
    assert.deepEqual(h.costs, [1, 1]);
    assert.equal(h.page.dynamicNodeCount, 2);
    assert.equal(h.page.dynamicQueue.size, 0);
    h.scanAncestor(kind);
    await h.flush();
    assert.equal(h.sent.length, 2, 'another ancestor scan does not pay for translated text again');
    h.app.restorePage({ silent: true });
    assert.equal(live.nodeValue, 'Second word');
    assert.equal(stable.nodeValue, 'Stable sibling');
  });
}

test('repeated ancestor scans wait for the final streamed text without spending the budget', async () => {
  const h = harness();
  const live = h.addText('Start');
  h.rewrite(live, 'First word');
  for (const value of ['Second word', 'Third word', 'Final words']) {
    h.rewrite(live, value);
    h.scanAncestor();
    await h.flush();
    assert.deepEqual(h.sent, []);
    assert.equal(h.page.dynamicNodeCount, 0);
    assert.equal(h.page.dynamicCharCount, 0);
    assert.equal(h.timers.size, 1);
    h.clock.now += 750;
  }
  h.clock.now += 2000;
  await h.flush();
  assert.deepEqual(h.sent, ['Final words']);
  assert.deepEqual(h.costs, [1]);
});

for (const startsWithRuby of [false, true]) {
test(`a group starting ${startsWithRuby ? 'inside' : 'before'} ruby waits and translates once as a whole`, async () => {
  const h = harness();
  const parent = h.element(h.root);
  const ruby = startsWithRuby ? h.element(parent, 'RUBY') : null;
  const first = h.addText('Prefix ', ruby || parent);
  const live = h.addText('Start', startsWithRuby ? parent : h.element(parent, 'RUBY'));
  // Child-list updates keep the parent queued, so removing only text-node entries is insufficient.
  const type = startsWithRuby ? 'childList' : 'characterData';
  h.rewrite(live, 'First word', type);
  h.rewrite(live, 'Final word', type);
  h.scanAncestor();
  await h.flush();
  assert.deepEqual(h.sent, []);
  assert.ok(h.page.dynamicQueue.size > 0, 'retain the complete group for a later scan');
  h.clock.now += 2000;
  await h.flush();
  assert.deepEqual(h.sent, ['Prefix Final word']);
  assert.equal(first.nodeValue, '译:Prefix Final word');
  assert.equal(live.nodeValue, '');
  h.app.restorePage({ silent: true });
  assert.equal(first.nodeValue, 'Prefix ');
  assert.equal(live.nodeValue, 'Final word');
});
}

for (const stop of ['restore', 'navigate']) {
  test(`${stop} cancels text deferred by an ancestor scan`, async () => {
    const h = harness();
    const live = h.addText('Start');
    h.rewrite(live, 'First word');
    h.rewrite(live, 'Final word');
    h.scanAncestor();
    await h.flush();
    assert.deepEqual(h.sent, []);
    if (stop === 'restore') h.app.restorePage({ silent: true });
    else h.location.pathname = '/other';
    h.clock.now += 2000;
    await h.flush();
    assert.deepEqual(h.sent, []);
    assert.deepEqual(h.costs, []);
    assert.equal(h.page.dynamicQueue.size, 0);
    assert.equal(h.page.observers.length, 0);
    assert.equal(h.timers.size, 0);
  });
}
