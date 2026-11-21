'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const vm = require('node:vm');
const { createLocalizedContext } = require('../helpers/i18n');
const { LIMITS } = require('../../shared/config');
const textUtils = require('../../shared/text');

const TEXT_NODE = 3;
const ELEMENT_NODE = 1;

function text(nodeValue) {
  return {
    nodeType: TEXT_NODE, nodeValue,
    get previousSibling() { return this.parentNode.childNodes[this.parentNode.childNodes.indexOf(this) - 1]; },
    get nextSibling() { return this.parentNode.childNodes[this.parentNode.childNodes.indexOf(this) + 1]; }
  };
}

function matches(node, selector) {
  return selector.split(',').some((part) => {
    const s = part.trim();
    if (s === '[translate="no"]') return node.attributes.translate === 'no';
    if (s === '[contenteditable]:not([contenteditable="false"])') {
      return node.hasAttribute('contenteditable') && node.attributes.contenteditable !== 'false';
    }
    if (s === '.notranslate') return node.attributes.class === 'notranslate';
    if (s.startsWith('[')) return node.hasAttribute(s.slice(1, -1));
    return node.tagName === s.toUpperCase();
  });
}

function descendants(node) {
  return node.children.flatMap((child) => [child, ...descendants(child)]);
}

function container(tagName, parts = [], attributes = {}) {
  const node = {
    tagName: tagName.toUpperCase(), nodeType: ELEMENT_NODE, attributes, childNodes: [], isConnected: true,
    style: { setProperty() {} },
    get children() { return this.childNodes.filter((child) => child.nodeType === ELEMENT_NODE); },
    get previousSibling() { return this.parentNode?.childNodes[this.parentNode.childNodes.indexOf(this) - 1]; },
    get nextSibling() { return this.parentNode?.childNodes[this.parentNode.childNodes.indexOf(this) + 1]; },
    closest(selector) {
      for (let owner = this; owner; owner = owner.parentElement) {
        if (matches(owner, selector)) return owner;
      }
      return null;
    },
    getRootNode() {
      let root = this;
      while (root.parentNode) root = root.parentNode;
      return root;
    },
    checkVisibility() { return this.visible !== false; },
    hasAttribute(name) { return Object.hasOwn(this.attributes, name); },
    setAttribute(name, value) { this.attributes[name] = value; },
    querySelectorAll(selector) { return descendants(this).filter((child) => matches(child, selector)); },
    querySelector(selector) {
      const scoped = selector.startsWith(':scope > ');
      return scoped ? this.children.find((child) => matches(child, selector.slice(9))) :
        this.querySelectorAll(selector)[0];
    },
    appendChild(child) {
      child.parentNode = this;
      child.parentElement = this.nodeType === ELEMENT_NODE ? this : null;
      child.ownerDocument = this.ownerDocument;
      this.childNodes.push(child);
    },
    remove() { this.parentNode.childNodes.splice(this.parentNode.childNodes.indexOf(this), 1); }
  };
  for (const part of parts) node.appendChild(typeof part === 'string' ? text(part) : part);
  return node;
}

function setOwnerDocument(node, document) {
  node.ownerDocument = document;
  for (const child of node.childNodes || []) setOwnerDocument(child, document);
}

function makeDocument(...parts) {
  const body = container('body', parts);
  const documentElement = container('html', [body]);
  const document = {
    body, documentElement,
    defaultView: { getComputedStyle: () => ({ display: 'block', visibility: 'visible' }) },
    createElement: (name) => container(name),
    createTreeWalker(root, _kind, { acceptNode }) {
      function* textNodes(node) {
        for (const child of node.childNodes || []) {
          if (child.nodeType === TEXT_NODE) {
            if (acceptNode(child) === 1) yield child;
          } else {
            yield* textNodes(child);
          }
        }
      }
      const walker = textNodes(root);
      return { nextNode: () => walker.next().value || null };
    }
  };
  documentElement.parentNode = document;
  setOwnerDocument(documentElement, document);
  return document;
}

function addShadow(host, copy) {
  const root = container('shadow', [container('p', [copy])]);
  root.nodeType = 11;
  root.host = host;
  root.children[0].parentElement = null;
  host.shadowRoot = root;
  setOwnerDocument(root, host.ownerDocument);
  return root;
}

function load(document) {
  const app = { LIMITS, textUtils, BILINGUAL_ATTR: 'data-dsht-original', page: {
    translatedNodes: new Map(), captions: new Map()
  } };
  const globals = createLocalizedContext({
    DSHT: { contentModules: {} }, document,
    Node: { ELEMENT_NODE, TEXT_NODE },
    NodeFilter: { SHOW_TEXT: 4, FILTER_ACCEPT: 1, FILTER_REJECT: 2 }
  });
  for (const name of ['ruby', 'dom', 'captions']) {
    const file = path.join(__dirname, '../../content/content-' + name + '.js');
    vm.runInContext(fs.readFileSync(file, 'utf8'), globals, { filename: file });
    Object.assign(app, globals.DSHT.contentModules[name](app));
  }
  return app;
}

const reading = () => container('rt', ['ふりがな']);
const ruby = (...parts) => container('ruby', [...parts, reading()]);
const cores = (app, roots, options) => Array.from(app.collectTargets(roots, options).targets, ({ core }) => core);

test('ruby groups preserve numbers, leading punctuation and annotations for restore', () => {
  const number = ruby('１００');
  const mixed = ruby('第', container('rb', ['1']), '章');
  const level = container('p', ['レベル', number, 'になった']);
  const title = container('p', ['「', mixed, '」']);
  const count = container('p', [ruby('１０'), '個あった']);
  const document = makeDocument(level, title, count);
  const app = load(document);
  assert.deepEqual(cores(app, document.body), ['レベル１００になった', '「第1章」', '１０個あった']);
  assert.equal(app.collectTargets(level).targets[0].rubyReadings[0], number.children[0]);
});

test('ruby groups never jump across protected, hidden or already translated bases', () => {
  const protectedRuby = ruby('魔法');
  protectedRuby.attributes.translate = 'no';
  const hiddenRuby = ruby('魔法');
  hiddenRuby.visible = false;
  const translatedRuby = ruby('魔法');
  const paragraphs = [protectedRuby, hiddenRuby, translatedRuby].map((annotation) => container('p', ['青い', annotation, 'を使う']));
  const document = makeDocument(...paragraphs);
  const app = load(document);
  app.page.translatedNodes.set(translatedRuby.childNodes[0], { original: '魔術', translated: '魔法' });
  for (const paragraph of paragraphs) assert.deepEqual(cores(app, paragraph), ['青い', 'を使う']);
});

function composedFixture() {
  const firstHost = container('div');
  const visibleFrame = container('iframe');
  const hiddenFrame = container('iframe');
  const protectedFrame = container('iframe', [], { translate: 'no' });
  const wrapper = container('div', [hiddenFrame], { hidden: '' });
  const protectedHost = container('div', [], { contenteditable: '' });
  const lastHost = container('div');
  const document = makeDocument(firstHost, visibleFrame, wrapper, protectedFrame, protectedHost, lastHost);
  for (const [frame, label] of [[visibleFrame, 'Visible frame'], [hiddenFrame, 'Hidden frame'], [protectedFrame, 'Protected frame']]) {
    frame.contentDocument = makeDocument(container('p', [label]));
    frame.contentDocument.defaultView.frameElement = frame;
  }
  const first = addShadow(firstHost, 'First shadow');
  const protectedRoot = addShadow(protectedHost, 'Protected shadow');
  const last = addShadow(lastHost, 'Last shadow');
  const app = load(document);
  const roots = [document.body, first, visibleFrame.contentDocument.body, hiddenFrame.contentDocument.body,
    protectedFrame.contentDocument.body, protectedRoot, last];
  return { app, document, roots, wrapper, hiddenFrame, protectedRoot, lastHost };
}

test('composed roots are discovered in document order and remain observable', () => {
  const { app, document, roots } = composedFixture();
  assert.deepEqual(Array.from(app.collectComposedTextRoots(document), (root) => roots.indexOf(root)),
    roots.map((_root, index) => index));
});

test('hidden frames and protected shadow hosts are omitted from translation', () => {
  const { app, roots, wrapper, hiddenFrame, protectedRoot, lastHost } = composedFixture();
  assert.deepEqual(cores(app, roots), ['First shadow', 'Visible frame', 'Last shadow']);
  delete wrapper.attributes.hidden;
  assert.deepEqual(cores(app, roots), ['First shadow', 'Visible frame', 'Hidden frame', 'Last shadow']);
  hiddenFrame.visible = false;
  lastHost.visible = false;
  assert.deepEqual(cores(app, roots, { allowDisconnected: true }), ['First shadow', 'Visible frame']);
  assert.deepEqual(cores(app, protectedRoot, { allowDisconnected: true }), []);
  const detached = makeDocument(container('p', ['Parsed chapter text']));
  detached.defaultView = null;
  assert.deepEqual(cores(app, detached.body, { allowDisconnected: true }), ['Parsed chapter text']);
});

test('nested anchors keep independently rendered and removed bilingual captions', () => {
  const inner = container('p', ['Inner original']);
  const outer = container('blockquote', [inner, 'Outer original']);
  const document = makeDocument(outer);
  const app = load(document);
  const record = (anchor, original) => ({ anchor, original, applied: true });
  app.applyBilingualCaptions([record(inner, 'Inner original'), record(outer, 'Outer original')]);
  const own = ':scope > [data-dsht-original]';
  const innerCaption = inner.querySelector(own);
  const outerCaption = outer.querySelector(own);
  assert.equal(app.page.captions.get(innerCaption), 'Inner original');
  assert.equal(app.page.captions.get(outerCaption), 'Outer original');
  app.removeCaptionForNode(outer.childNodes[1]);
  assert.equal(app.page.captions.size, 1);
  assert.equal(inner.querySelector(own), innerCaption);
  assert.equal(outer.querySelector(own), undefined);
});
