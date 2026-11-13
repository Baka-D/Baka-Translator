(function initOverlayPart(globalScope) {
  'use strict';
  globalScope.DSHT = globalScope.DSHT || {};
  const parts = globalScope.DSHT.overlayParts = globalScope.DSHT.overlayParts || {};

  parts.createImages = function createImages(callbacks) {
    const { el, onTrusted } = parts;
    const EMPTY_MESSAGE = '当前画面中没有找到可翻译的图片。滚动到图片位置后再试。';
    let imagePanel, imageTitle, imageSubtitle, imageList, imageEmpty, imageFoot;
    let renderedItems = [];

    function buildImagePanel(layer) {
      imagePanel = el('section', 'dsht-image-panel dsht-hidden');
      imagePanel.setAttribute('role', 'dialog');
      imagePanel.setAttribute('aria-label', 'Baka Translator 图片翻译');

      const head = el('div', 'dsht-image-head');
      const logo = el('div', 'dsht-logo', '图');
      const copy = el('div', 'dsht-panel-copy');
      imageTitle = el('h2', 'dsht-image-title', '图片翻译');
      imageSubtitle = el('div', 'dsht-image-subtitle', '');
      imageSubtitle.setAttribute('aria-live', 'polite');
      copy.appendChild(imageTitle);
      copy.appendChild(imageSubtitle);

      const close = el('button', 'dsht-icon-button', '×');
      close.type = 'button';
      close.setAttribute('aria-label', '关闭图片翻译结果');
      onTrusted(close, 'click', () => callbacks.onImageClose && callbacks.onImageClose());
      head.appendChild(logo);
      head.appendChild(copy);
      head.appendChild(close);

      imageList = el('div', 'dsht-image-list');
      renderedItems = [];
      imageEmpty = el('div', 'dsht-image-empty dsht-hidden', EMPTY_MESSAGE);
      imageFoot = el('div', 'dsht-image-foot', '仅截取当前画面中可见的图片区域并发送给所选模型服务商识别，不会上传整页截图。');

      imagePanel.appendChild(head);
      imagePanel.appendChild(imageList);
      imagePanel.appendChild(imageEmpty);
      imagePanel.appendChild(imageFoot);
      layer.appendChild(imagePanel);
    }

    function renderImagePanel(model) {
      if (!model || !model.visible) {
        hideImagePanel();
        return;
      }
      if (!imagePanel) return;
      imagePanel.classList.remove('dsht-hidden');
      imageTitle.textContent = model.title || '图片翻译';
      imageSubtitle.textContent = model.subtitle || '';
      imageFoot.textContent =
        model.footer || '仅截取当前画面中可见的图片区域并发送给所选模型服务商识别，不会上传整页截图。';

      const items = Array.isArray(model.items) ? model.items : [];
      imageEmpty.classList.toggle('dsht-hidden', items.length > 0);
      imageEmpty.textContent = model.emptyMessage || EMPTY_MESSAGE;

      // A session keeps its image order. Leave completed rows attached while other
      // images progress, preserving expanded originals, selections and decoded thumbs.
      items.forEach((item, index) => {
        const previous = renderedItems[index];
        const keys = Object.keys(item);
        if (previous && keys.length === Object.keys(previous.item).length &&
            keys.every((key) => item[key] === previous.item[key])) return;
        const row = buildImageItem(item, index);
        if (previous) imageList.replaceChild(row, previous.row);
        else imageList.appendChild(row);
        renderedItems[index] = { item: { ...item }, row };
      });
      for (const extra of renderedItems.slice(items.length)) imageList.removeChild(extra.row);
      renderedItems.length = items.length;
    }

    function buildImageItem(item, index) {
      const row = el('div', 'dsht-image-item');
      const thumbWrap = el('div', 'dsht-thumb-wrap');
      if (/^data:image\/jpeg;base64,[A-Za-z0-9+/]+={0,2}$/.test(item.thumbnail || '')) {
        const img = document.createElement('img');
        img.className = 'dsht-thumb';
        img.alt = item.thumbnailAlt || `图片 ${index + 1} 截图`;
        img.src = item.thumbnail;
        thumbWrap.appendChild(img);
      }
      row.appendChild(thumbWrap);

      const copy = el('div', 'dsht-image-copy');
      const head = el('div', 'dsht-image-item-head');
      head.appendChild(el('span', 'dsht-image-index', `图片 ${index + 1}`));
      const state = el('span', 'dsht-image-state', item.stateLabel || '');
      head.appendChild(state);
      copy.appendChild(head);

      if (item.status === 'pending' || item.status === 'loading') {
        copy.appendChild(el('div', 'dsht-skeleton'));
        copy.appendChild(el('div', 'dsht-skeleton'));
        copy.appendChild(el('div', 'dsht-skeleton'));
      } else if (item.status === 'error') {
        copy.appendChild(el('p', 'dsht-image-error', item.error || '识别失败，请重试。'));
      } else if (!item.hasText) {
        copy.appendChild(el('p', 'dsht-image-muted', '图中未检测到可翻译的文字。'));
      } else {
        const translation = el('p', 'dsht-image-translation', item.translation || '');
        copy.appendChild(translation);
        if (item.original) {
          const details = el('details', 'dsht-image-original');
          details.appendChild(el('summary', '', '识别到的原文'));
          const quote = el('blockquote', '', item.original);
          details.appendChild(quote);
          copy.appendChild(details);
        }
        if (item.sourceLabel) {
          copy.appendChild(el('p', 'dsht-image-state', item.sourceLabel));
        }
      }

      row.appendChild(copy);
      return row;
    }

    function hideImagePanel() {
      if (imagePanel) {
        imagePanel.classList.add('dsht-hidden');
        if (imageList) imageList.textContent = '';
        renderedItems = [];
      }
    }

    return { build: buildImagePanel, render: renderImagePanel, hide: hideImagePanel };
  };

})(typeof globalThis !== 'undefined' ? globalThis : this);
