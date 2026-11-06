'use strict';

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function createElement(tag) {
  const listeners = new Map();
  const node = {
    tagName: tag.toUpperCase(), className: '', textContent: '', children: [],
    dataset: {}, attributes: {}, style: { setProperty() {} }, isConnected: true,
    setAttribute(key, value) { this.attributes[key] = value; },
    appendChild(child) { this.children.push(child); child.parentNode = this; return child; },
    addEventListener(type, callback) {
      if (!listeners.has(type)) listeners.set(type, []);
      listeners.get(type).push(callback);
    },
    dispatch(type, event = {}) {
      for (const callback of listeners.get(type) || []) callback({ target: this, ...event });
    },
    closest(selector) {
      if (selector !== '.dsht-hidden') throw new Error(`Unexpected selector ${selector}`);
      return this.classList.contains('dsht-hidden') ? this : this.parentNode?.closest(selector);
    },
    attachShadow({ mode }) {
      this.testShadow = createElement('shadow');
      this.shadowRoot = mode === 'open' ? this.testShadow : null;
      return this.testShadow;
    },
    getBoundingClientRect() { return { width: 300, height: 200 }; }
  };
  node.classList = {
    contains(value) { return node.className.split(/\s+/).includes(value); },
    add(value) { this.toggle(value, true); },
    remove(value) { this.toggle(value, false); },
    toggle(value, enabled) {
      const classes = new Set(node.className.split(/\s+/).filter(Boolean));
      if (enabled) classes.add(value); else classes.delete(value);
      node.className = [...classes].join(' ');
    }
  };
  return node;
}

function find(node, className) {
  if (node.classList.contains(className)) return node;
  return node.children.map((child) => find(child, className)).find(Boolean);
}

function loadOverlay(callbacks = {}) {
  const documentElement = createElement('html');
  const context = vm.createContext({
    document: { documentElement, createElement, addEventListener() {} },
    window: { innerWidth: 1200, innerHeight: 800 }, navigator: {},
    CSSStyleSheet: class { replaceSync() {} }, setTimeout, clearTimeout
  });
  for (const file of [
    'overlay-style-base.js', 'overlay-style-images.js', 'overlay-ui.js',
    'overlay-panel.js', 'overlay-bubble.js', 'overlay-images.js', 'overlay.js'
  ]) {
    vm.runInContext(fs.readFileSync(path.join(__dirname, '../../content', file), 'utf8'), context);
  }
  // Image renderer tests exercise the extension document's component separately.
  context.DSHT.overlayParts.createImageFrame = () => ({ build() {}, render() {}, hide() {} });
  const ui = context.DSHT.overlay.createOverlay({ callbacks, languages: [{ code: 'zh', label: '中文' }] });
  const imageLayer = createElement('div');
  const images = context.DSHT.overlayParts.createImages(callbacks);
  images.build(imageLayer);
  return {
    ui, images,
    get host() { return documentElement.children[0]; },
    element(className) { return find(documentElement.children[0].testShadow, className); },
    imageElement(className) { return find(imageLayer, className); }
  };
}

module.exports = { loadOverlay, createElement };
