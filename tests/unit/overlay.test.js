'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadOverlay } = require('../helpers/overlay.js');

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
