'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { loadOverlay } = require('../helpers/overlay.js');
const { createLocalizedContext } = require('../helpers/i18n');

test('image translation failures show their empty-state explanation', () => {
  const { images, imageElement } = loadOverlay();
  images.render({ visible: true, items: [], emptyMessage: '截图失败，请重新授权后重试。' });
  const message = imageElement('dsht-image-empty');
  assert.equal(message.classList.contains('dsht-hidden'), false);
  assert.equal(message.textContent, '截图失败，请重新授权后重试。');
});

test('a new empty image search resets the previous error explanation', () => {
  const { images, imageElement } = loadOverlay();
  images.render({ visible: true, items: [], emptyMessage: '截图失败' });
  images.render({ visible: true, items: [] });
  assert.equal(imageElement('dsht-image-empty').textContent,
    '当前画面中没有找到可翻译的图片。滚动到图片位置后再试。');
  images.render({ visible: true, items: [{ status: 'done', hasText: false }] });
  assert.equal(imageElement('dsht-image-empty').classList.contains('dsht-hidden'), true);
});

test('synthetic, hidden and disabled controls cannot start work or change settings', () => {
  const calls = [];
  const h = loadOverlay({
    onPanelAction: action => calls.push(action), onBubbleRetry: () => calls.push('retry'),
    onBubbleTargetChange: code => calls.push(code), onBubbleSettings: () => calls.push('settings')
  });
  h.ui.renderPanel({ visible: true, actions: [{ id: 'restore', label: '还原' }] });
  h.ui.renderBubble({ visible: true, loading: false, original: 'hello', canRetry: true });
  h.element('dsht-panel-actions').children[0].dispatch('click', { isTrusted: false });
  h.element('dsht-select').value = 'ja';
  h.element('dsht-select').dispatch('change', { isTrusted: false });
  h.element('dsht-bubble-foot').children[1].dispatch('click', { isTrusted: false });
  h.element('dsht-bubble-foot').children[2].dispatch('click', { isTrusted: true });
  assert.deepEqual(calls, []);
  const button = h.element('dsht-panel-actions').children[0];
  button.disabled = true;
  button.dispatch('click', { isTrusted: true });
  assert.deepEqual(calls, []);
  button.disabled = false;
  button.dataset.action = 'retry';
  button.dispatch('click', { isTrusted: true });
  h.element('dsht-select').dispatch('change', { isTrusted: true });
  h.element('dsht-bubble-foot').children[1].dispatch('click', { isTrusted: true });
  assert.deepEqual(calls, ['restore', 'ja', 'retry']);
  assert.equal(h.host.shadowRoot, null);
});

test('image renderer accepts screenshot JPEGs and treats OCR as text', () => {
  const h = loadOverlay();
  h.images.render({ visible: true, items: [{ thumbnail: 'https://attacker.invalid/pixel',
    status: 'done', hasText: true, original: '<script>original</script>', translation: '<img onerror=alert(1)>' }] });
  assert.equal(h.imageElement('dsht-thumb'), undefined);
  assert.equal(h.imageElement('dsht-image-translation').textContent, '<img onerror=alert(1)>');
  h.images.render({ visible: true, items: [{ thumbnail: 'data:image/jpeg;base64,AA==', status: 'loading' }] });
  assert.equal(h.imageElement('dsht-thumb').src, 'data:image/jpeg;base64,AA==');
});

test('another image finishing preserves completed rows, expanded originals and thumbnails', () => {
  const h = loadOverlay();
  const done = { thumbnail: 'data:image/jpeg;base64,AA==', status: 'done',
    hasText: true, original: 'original', translation: '译文' };
  const pending = { status: 'loading' };
  h.images.render({ visible: true, items: [done, pending] });
  const list = h.imageElement('dsht-image-list');
  const row = list.children[0];
  const thumb = h.imageElement('dsht-thumb');
  const details = h.imageElement('dsht-image-original');
  details.open = true;
  // The runtime passes freshly cloned records for every progress update.
  h.images.render({ visible: true, subtitle: '识别完成', items: [{ ...done }, { ...done, original: 'second' }] });
  assert.ok(list.children[0] === row);
  assert.ok(h.imageElement('dsht-thumb') === thumb);
  assert.ok(h.imageElement('dsht-image-original') === details);
  assert.equal(details.open, true);
  assert.equal(list.children.length, 2);
});

test('image updates and shrinking or reopening the panel never reuse stale rows', () => {
  const h = loadOverlay();
  const item = { status: 'loading' };
  h.images.render({ visible: true, items: [item, { status: 'pending' }] });
  const list = h.imageElement('dsht-image-list');
  const loading = list.children[0];
  Object.assign(item, { status: 'done', hasText: true, translation: 'finished' });
  h.images.render({ visible: true, items: [item] });
  assert.notEqual(list.children[0], loading);
  assert.equal(list.children.length, 1);
  assert.equal(h.imageElement('dsht-image-translation').textContent, 'finished');
  h.images.hide();
  assert.equal(list.children.length, 0);
  h.images.render({ visible: true, items: [item] });
  assert.equal(list.children.length, 1);
});

test('page progress keeps unchanged action buttons attached for keyboard focus', () => {
  const calls = [];
  const h = loadOverlay({ onPanelAction: id => calls.push(id) });
  const model = { visible: true, showProgress: true, progressRatio: 0.1,
    actions: [{ id: 'restore', label: '还原', variant: 'danger' }] };
  h.ui.renderPanel(model);
  const list = h.element('dsht-panel-actions');
  const focused = list.children[0];
  h.ui.renderPanel({ ...model, progressRatio: 0.8, actions: model.actions.map(action => ({ ...action })) });
  assert.ok(list.children[0] === focused, 'focused button must not be detached by a progress update');
  focused.dispatch('click', { isTrusted: true });
  assert.deepEqual(calls, ['restore']);
  h.ui.renderPanel({ ...model, actions: [{ id: 'retry', label: '重试', variant: 'primary' }] });
  assert.equal(list.children.length, 1);
  assert.equal(list.children[0].textContent, '重试');
  list.children[0].dispatch('click', { isTrusted: true });
  assert.deepEqual(calls, ['restore', 'retry']);
});

test('the selection bubble stays inside the viewport when its anchor scrolls out', () => {
  const h = loadOverlay();
  const rect = { left: 60, top: 30, bottom: 50, width: 200 };
  h.ui.renderBubble({ visible: true, canRetry: true, rect });
  const bubble = h.element('dsht-bubble');
  assert.equal(bubble.style.top, '58px');

  h.ui.positionBubble({ ...rect, top: -80, bottom: -60 });
  assert.equal(bubble.style.top, '12px');
});

test('expanding and collapsing the original text repositions the selection bubble', () => {
  const h = loadOverlay();
  const rect = { left: 60, top: 440, bottom: 460, width: 200 };
  h.ui.renderBubble({ visible: true, canRetry: true, original: 'Original text', rect });
  const bubble = h.element('dsht-bubble');
  const details = h.element('dsht-original');
  bubble.getBoundingClientRect = () => ({ width: 300, height: details.open ? 360 : 200 });

  details.open = true;
  details.dispatch('toggle');
  assert.equal(bubble.style.top, '72px');

  details.open = false;
  details.dispatch('toggle');
  assert.equal(bubble.style.top, '468px');
});

test('rebuilding the overlay discards the old selection bubble position', () => {
  const h = loadOverlay();
  const rect = { left: 60, top: 30, bottom: 50, width: 200 };
  h.ui.renderBubble({ visible: true, canRetry: true, rect });
  const oldHost = h.host;
  oldHost.isConnected = false;
  oldHost.parentNode.removeChild(oldHost);

  h.ui.renderPanel({ visible: true });
  const rebuilt = h.element('dsht-bubble');
  assert.equal(rebuilt.classList.contains('dsht-hidden'), true);
  h.ui.positionBubble(rect);
  assert.equal(rebuilt.style.top, undefined);
});

test('selection scrolls coalesce into one position update per animation frame', () => {
  const listeners = new Map();
  const frames = [];
  const positions = [];
  const rect = { left: 0, top: 20, right: 50, bottom: 40, width: 50, height: 20 };
  const bubble = {
    open: true,
    range: {
      startContainer: { isConnected: true },
      getBoundingClientRect: () => rect
    }
  };
  const context = createLocalizedContext({
    document: { addEventListener() {} },
    window: {
      addEventListener(type, callback, options) { listeners.set(type, { callback, options }); },
      requestAnimationFrame(callback) { frames.push(callback); }
    }
  });
  const file = require.resolve('../../content/content-selection.js');
  vm.runInContext(fs.readFileSync(file, 'utf8'), context, { filename: file });
  const app = context.DSHT.contentModules.selection({
    bubble, overlay: { positionBubble: rect => positions.push(rect) }
  });
  app.bindBubbleListeners();
  const { callback: scroll, options } = listeners.get('scroll');
  scroll();
  rect.top = 50;
  scroll();
  assert.equal(options.capture, true);
  assert.equal(options.passive, true);
  assert.equal(frames.length, 1);
  assert.equal(positions.length, 0);
  frames.shift()();
  assert.equal(positions.length, 1);
  assert.equal(positions[0].top, 50);
  app.handleBubbleClosed();
  scroll();
  assert.equal(frames.length, 0);
});
