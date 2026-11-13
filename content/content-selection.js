/** Selection behavior for the content script. */
(function registerContentModule(globalScope) {
  'use strict';
  const { t } = globalScope.DSHT.i18n;
  const modules = globalScope.DSHT.contentModules ||= {};
  modules['selection'] = function createModule(app) {
  const { languages, detect, MSG, LIMITS, bubble, overlay } = app;

  let lastPointer = null;
  let bubbleListenersBound = false;

  function readSelection() {
    try {
      const selection = window.getSelection();
      if (!selection || selection.rangeCount === 0 || selection.isCollapsed) {
        return { text: '', rect: null, range: null };
      }
      const text = selection.toString().trim();
      const range = selection.getRangeAt(0).cloneRange();
      let rect = range.getBoundingClientRect();
      if (!rect || (!rect.width && !rect.height)) {
        const rects = range.getClientRects();
        rect = rects && rects.length > 0 ? rects[0] : null;
      }
      return {
        text,
        rect: rect ? rectToPlain(rect) : null,
        range
      };
    } catch (_error) {
      return { text: '', rect: null, range: null };
    }
  }

  function rectToPlain(rect) {
    return {
      left: rect.left,
      top: rect.top,
      right: rect.right,
      bottom: rect.bottom,
      width: rect.width,
      height: rect.height
    };
  }

  function fallbackAnchorRect() {
    if (lastPointer) {
      return {
        left: lastPointer.x,
        top: lastPointer.y,
        right: lastPointer.x,
        bottom: lastPointer.y,
        width: 0,
        height: 0
      };
    }
    const x = window.innerWidth / 2;
    const y = Math.min(180, window.innerHeight / 3);
    return { left: x, top: y, right: x, bottom: y, width: 0, height: 0 };
  }

  function selectionDirection(source, targetCode) {
    const target = languages.getTargetLanguage(targetCode);
    const sourceLabel =
      source && source.code && source.code !== 'unknown' ? globalScope.DSHT.i18n.languageLabel(source.code) : t('content_auto_detect');
    return `${sourceLabel} → ${target ? globalScope.DSHT.i18n.languageLabel(target.code) : t('content_target_language')}`;
  }

  function renderBubbleLoading() {
    const direction = selectionDirection(bubble.source, bubble.targetCode);
    overlay.renderBubble({
      visible: true,
      loading: true,
      direction,
      original: bubble.text,
      targetCode: bubble.targetCode,
      translation: '',
      error: '',
      canRetry: false,
      showSettings: false,
      rect: bubble.rect
    });
  }

  function renderBubbleSuccess(translation) {
    const direction = selectionDirection(bubble.source, bubble.targetCode);
    overlay.renderBubble({
      visible: true,
      loading: false,
      direction,
      original: bubble.text,
      targetCode: bubble.targetCode,
      translation,
      error: '',
      canRetry: false,
      showSettings: false,
      rect: bubble.rect
    });
  }

  function renderBubbleError(error) {
    const direction = selectionDirection(bubble.source, bubble.targetCode);
    overlay.renderBubble({
      visible: true,
      loading: false,
      direction,
      original: bubble.text,
      targetCode: bubble.targetCode,
      translation: '',
      error: (error && error.message) || t('content_translation_failed'),
      canRetry: true,
      showSettings: app.isSettingsError(error && error.code),
      rect: bubble.rect
    });
  }

  async function runSelectionTranslation(runId) {
    try {
      const response = await app.sendRuntime({
        type: MSG.TRANSLATE_BATCH,
        targetCode: bubble.targetCode,
        sourceHint: bubble.source && bubble.source.code,
        segments: [{ id: 'b1', text: bubble.text }]
      });
      if (runId !== bubble.runId || !bubble.open) return;
      const item = Array.isArray(response.translations) ? response.translations[0] : null;
      const translation = item && typeof item.text === 'string' ? item.text.trim() : '';
      if (!translation) {
        const error = new Error(t('content_selection_empty_result'));
        error.code = 'EMPTY_SELECTION_TRANSLATION';
        renderBubbleError(error);
        return;
      }
      renderBubbleSuccess(translation);
    } catch (error) {
      if (runId !== bubble.runId || !bubble.open) return;
      renderBubbleError(error);
    }
  }

  async function startSelectionTranslation(message) {
    const request = message || {};
    const selection = readSelection();
    let text = typeof request.text === 'string' ? request.text.trim() : '';
    if (!text) text = selection.text;
    if (!text) {
      overlay.showToast(t('content_select_text_notice'), 'info');
      return {
        ok: false,
        error: { code: 'NO_SELECTION', message: t('content_select_text') }
      };
    }
    if (text.length > LIMITS.SELECTION_MAX_CHARS) {
      const messageText = t('content_selection_too_long', [LIMITS.SELECTION_MAX_CHARS]);
      overlay.showToast(messageText, 'error');
      return {
        ok: false,
        error: { code: 'SELECTION_TOO_LONG', message: messageText }
      };
    }

    const runId = ++bubble.runId;
    const settings = await app.readSettings();
    if (runId !== bubble.runId) return { started: false, reason: 'cancelled' };
    const targetCode = languages.normalizeTarget(
      request.targetCode !== undefined ? request.targetCode : settings.targetLang
    );
    bubble.text = text;
    bubble.targetCode = targetCode;
    bubble.source = detect.detectLanguage(text);
    bubble.rect = selection.rect || fallbackAnchorRect();
    bubble.range = selection.range;
    bubble.open = true;
    bindBubbleListeners();
    renderBubbleLoading();
    void runSelectionTranslation(runId);
    return { started: true };
  }

  function translateSelectionAgain() {
    if (!bubble.open || !bubble.text) return;
    bubble.runId += 1;
    const runId = bubble.runId;
    renderBubbleLoading();
    void runSelectionTranslation(runId);
  }

  function handleBubbleClosed() {
    bubble.runId += 1;
    bubble.open = false;
    bubble.text = '';
    bubble.range = null;
    bubble.rect = null;
  }

  function refreshBubblePosition() {
    if (!bubble.open) return;
    try {
      if (bubble.range && bubble.range.startContainer && bubble.range.startContainer.isConnected) {
        const rect = bubble.range.getBoundingClientRect();
        if (rect && (rect.width || rect.height)) {
          bubble.rect = rectToPlain(rect);
        }
      }
    } catch (_error) {
      // Keep the last known position.
    }
    if (bubble.rect) overlay.positionBubble(bubble.rect);
  }

  function bindBubbleListeners() {
    if (bubbleListenersBound) return;
    bubbleListenersBound = true;
    document.addEventListener(
      'pointerdown',
      (event) => {
        if (event.button === 0 || event.button === 2) {
          lastPointer = { x: event.clientX, y: event.clientY };
        }
      },
      true
    );
    document.addEventListener(
      'contextmenu',
      (event) => {
        lastPointer = { x: event.clientX, y: event.clientY };
      },
      true
    );
    window.addEventListener('scroll', refreshBubblePosition, true);
    window.addEventListener('resize', refreshBubblePosition);
  }

  return {
    readSelection,
    rectToPlain,
    fallbackAnchorRect,
    selectionDirection,
    renderBubbleLoading,
    renderBubbleSuccess,
    renderBubbleError,
    runSelectionTranslation,
    startSelectionTranslation,
    translateSelectionAgain,
    handleBubbleClosed,
    refreshBubblePosition,
    bindBubbleListeners
  };
  };
})(globalThis);
