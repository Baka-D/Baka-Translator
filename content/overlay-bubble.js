(function initOverlayPart(globalScope) {
  'use strict';
  const { t } = globalScope.DSHT.i18n;
  globalScope.DSHT = globalScope.DSHT || {};
  const parts = globalScope.DSHT.overlayParts = globalScope.DSHT.overlayParts || {};

  parts.createBubble = function createBubble(callbacks, languages) {
    const { el, copyText, onTrusted } = parts;
    let bubble, bubbleDirection, bubbleLoading, bubbleText, bubbleError;
    let bubbleOriginal, bubbleOriginalText, bubbleTarget, bubbleCopy, bubbleRetry, bubbleSettings;
    let bubbleVisible = false;
    let bubbleAnchorRect = null;
    let currentTranslation = '';
    let currentOriginal = '';
    let copyResetTimer = 0;

    function buildBubble(layer) {
      bubble = el('section', 'dsht-bubble dsht-hidden');
      bubble.setAttribute('role', 'dialog');
      bubble.setAttribute('aria-label', t('content_selection_panel_label'));

      const head = el('div', 'dsht-bubble-head');
      const logo = el('div', 'dsht-logo dsht-logo-sm', t('content_translation_logo'));
      const heading = el('div', 'dsht-bubble-heading');
      const title = el('h2', 'dsht-bubble-title', t('content_selection_panel_label'));
      bubbleDirection = el('div', 'dsht-bubble-direction', `${t('content_auto_detect')} → ${globalScope.DSHT.i18n.languageLabel('zh')}`);
      heading.appendChild(title);
      heading.appendChild(bubbleDirection);
      const close = el('button', 'dsht-icon-button', '×');
      close.type = 'button';
      close.setAttribute('aria-label', t('content_close_selection'));
      onTrusted(close, 'click', closeBubble);
      head.appendChild(logo);
      head.appendChild(heading);
      head.appendChild(close);

      const body = el('div', 'dsht-bubble-body');
      bubbleLoading = el('div', 'dsht-bubble-loading');
      const dots = el('span', 'dsht-dots');
      dots.appendChild(el('i'));
      dots.appendChild(el('i'));
      dots.appendChild(el('i'));
      bubbleLoading.appendChild(dots);
      bubbleLoading.appendChild(el('span', '', t('content_translation_loading')));

      bubbleText = el('p', 'dsht-bubble-text');
      bubbleError = el('p', 'dsht-bubble-error dsht-hidden');
      bubbleError.setAttribute('role', 'alert');

      bubbleOriginal = el('details', 'dsht-original');
      const summary = el('summary', '', t('content_view_original'));
      bubbleOriginalText = el('p', 'dsht-original-text');
      bubbleOriginal.appendChild(summary);
      bubbleOriginal.appendChild(bubbleOriginalText);

      body.appendChild(bubbleLoading);
      body.appendChild(bubbleText);
      body.appendChild(bubbleError);
      body.appendChild(bubbleOriginal);

      const foot = el('div', 'dsht-bubble-foot');
      const selectWrap = el('div', 'dsht-select-wrap');
      bubbleTarget = el('select', 'dsht-select');
      bubbleTarget.setAttribute('aria-label', t('content_translation_target'));
      for (const language of languages) {
        const option = el('option', '', `${globalScope.DSHT.i18n.languageLabel(language.code)} · ${language.nativeName}`);
        option.value = language.code;
        bubbleTarget.appendChild(option);
      }
      onTrusted(bubbleTarget, 'change', () => {
        if (callbacks.onBubbleTargetChange) callbacks.onBubbleTargetChange(bubbleTarget.value);
      });
      selectWrap.appendChild(bubbleTarget);
      selectWrap.appendChild(el('span', 'dsht-select-arrow'));

      bubbleRetry = el('button', 'dsht-btn dsht-btn-ghost dsht-hidden', t('content_retry'));
      bubbleRetry.type = 'button';
      onTrusted(bubbleRetry, 'click', () => callbacks.onBubbleRetry && callbacks.onBubbleRetry());

      bubbleSettings = el('button', 'dsht-btn dsht-btn-ghost dsht-hidden', t('content_settings'));
      bubbleSettings.type = 'button';
      onTrusted(bubbleSettings, 'click', () => callbacks.onBubbleSettings && callbacks.onBubbleSettings());

      bubbleCopy = el('button', 'dsht-btn dsht-btn-primary dsht-copy-btn', t('content_copy'));
      bubbleCopy.type = 'button';
      onTrusted(bubbleCopy, 'click', async () => {
        if (!currentTranslation) return;
        const ok = await copyText(currentTranslation);
        clearTimeout(copyResetTimer);
        bubbleCopy.textContent = ok ? t('content_copied') : t('content_copy_failed');
        copyResetTimer = setTimeout(() => {
          if (bubbleCopy) bubbleCopy.textContent = t('content_copy');
        }, 1600);
      });

      foot.appendChild(selectWrap);
      foot.appendChild(bubbleRetry);
      foot.appendChild(bubbleSettings);
      foot.appendChild(bubbleCopy);

      bubble.appendChild(head);
      bubble.appendChild(body);
      bubble.appendChild(foot);
      layer.appendChild(bubble);
    }

    function closeBubble() {
      if (!bubble) return;
      bubbleVisible = false;
      bubble.classList.add('dsht-hidden');
      bubbleAnchorRect = null;
      if (callbacks.onBubbleClose) callbacks.onBubbleClose();
    }

    function renderBubble(model) {
      if (!model || !model.visible) {
        hideBubble();
        return;
      }
      if (!bubble) return;
      bubbleVisible = true;
      bubble.classList.remove('dsht-hidden');
      bubble.setAttribute('aria-busy', model.loading ? 'true' : 'false');
      bubbleDirection.textContent = model.direction || '';

      bubbleLoading.classList.toggle('dsht-hidden', !model.loading);
      bubbleText.classList.toggle('dsht-hidden', model.loading || Boolean(model.error) || !model.translation);
      bubbleError.classList.toggle('dsht-hidden', !model.error);
      bubbleError.textContent = model.error || '';

      currentTranslation = typeof model.translation === 'string' ? model.translation : '';
      currentOriginal = typeof model.original === 'string' ? model.original : '';

      if (!model.loading && model.translation) bubbleText.textContent = model.translation;
      else bubbleText.textContent = '';

      bubbleOriginal.classList.toggle('dsht-hidden', !currentOriginal || model.loading || Boolean(model.error));
      bubbleOriginalText.textContent = currentOriginal;

      bubbleTarget.value = model.targetCode || (languages[0] && languages[0].code) || 'zh';
      bubbleCopy.disabled = !currentTranslation || Boolean(model.loading);
      bubbleCopy.classList.toggle('dsht-hidden', Boolean(model.error));
      // Hiding the focused Retry button would drop keyboard focus out of the bubble.
      if (!model.canRetry && bubble.getRootNode().activeElement === bubbleRetry) bubbleTarget.focus();
      bubbleRetry.classList.toggle('dsht-hidden', !model.canRetry);
      bubbleSettings.classList.toggle('dsht-hidden', !model.showSettings);

      if (model.rect) {
        bubbleAnchorRect = model.rect;
        positionBubble(model.rect);
      } else if (bubbleAnchorRect) {
        positionBubble(bubbleAnchorRect);
      }
    }

    function hideBubble() {
      if (!bubble) return;
      bubbleVisible = false;
      bubble.classList.add('dsht-hidden');
      bubbleAnchorRect = null;
    }

    function positionBubble(rect) {
      if (!bubble || !bubbleVisible) return;
      if (rect) bubbleAnchorRect = rect;
      const anchor = bubbleAnchorRect;
      const margin = 12;
      const viewportWidth = window.innerWidth;
      const viewportHeight = window.innerHeight;
      const measured = bubble.getBoundingClientRect();
      const width = measured.width || Math.min(392, viewportWidth - margin * 2);
      const height = measured.height || 260;
      const anchorX = anchor ? Math.max(0, Math.min(viewportWidth, anchor.left + anchor.width / 2)) : viewportWidth / 2;
      const anchorTop = anchor ? anchor.top : 96;
      const anchorBottom = anchor ? anchor.bottom : 96;
      let left = anchorX - width / 2;
      left = Math.max(margin, Math.min(left, viewportWidth - width - margin));
      let top = anchorBottom + 8;
      if (top + height > viewportHeight - margin) {
        const above = anchorTop - height - 8;
        if (above >= margin) top = above;
        else top = Math.max(margin, Math.min(top, viewportHeight - height - margin));
      }
      bubble.style.left = `${Math.round(left)}px`;
      bubble.style.top = `${Math.round(top)}px`;
    }

    return {
      build: buildBubble, render: renderBubble, hide: hideBubble, close: closeBubble,
      position: positionBubble, isVisible: () => bubbleVisible
    };
  };

})(typeof globalThis !== 'undefined' ? globalThis : this);
