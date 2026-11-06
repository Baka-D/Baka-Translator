/**
 * Content orchestrator for Baka Translator.
 *
 * Responsibilities:
 *  - extract translatable text nodes while respecting page semantics;
 *  - batch requests through the background worker (API key never lives here);
 *  - apply translations and optional bilingual "原文" captions;
 *  - render selection / page / image results through the Shadow DOM overlay;
 *  - translate new content added by SPAs, with a strict budget.
 */
(function initContent() {
  'use strict';

  if (globalThis.__DSHT_CONTENT_LOADED__) return;
  const {
    config,
    languages,
    detect,
    textUtils,
    overlay: overlayModule,
    novel: novelUtils
  } = globalThis.DSHT || {};
  if (!config || !languages || !detect || !textUtils || !overlayModule) return;

  const MSG = config.MSG;
  const LIMITS = config.LIMITS;
  const BILINGUAL_ATTR = 'data-dsht-original';

  const FATAL_ERROR_CODES = new Set([
    'MISSING_API_KEY',
    'AUTH_FAILED',
    'INSUFFICIENT_BALANCE',
    'INVALID_API_KEY_FORMAT'
  ]);

  const SETTINGS_ERROR_CODES = new Set([
    'MISSING_API_KEY',
    'AUTH_FAILED',
    'INSUFFICIENT_BALANCE',
    'INVALID_API_KEY_FORMAT'
  ]);

  const page = {
    status: 'idle',
    phase: '',
    runId: 0,
    targetCode: null,
    targetLabel: '',
    bilingual: false,
    proofreadEnabled: false,
    source: null,
    progress: { done: 0, total: 0, failed: 0 },
    truncated: false,
    error: '',
    errorCode: '',
    polishError: '',
    polishProgress: { done: 0, total: 0, failed: 0 },
    polishStartedAt: 0,
    polishTimer: 0,
    estimatedCostUsd: 0,
    costCurrency: 'USD',
    abortFatal: false,
    translatedNodes: new Map(),
    hiddenRubyReadings: new Map(),
    initialTranslations: new Map(),
    translationMemory: new Map(),
    translationKey: '',
    captions: new Set(),
    panelDismissed: false,
    observers: [],
    dynamicQueue: new Set(),
    dynamicTimer: 0,
    dynamicBusy: false,
    dynamicNodeCount: 0,
    dynamicCharCount: 0,
    detectionCache: null,
    novel: null,
    novelMode: false,
    novelMeta: null,
    glossary: [],
    requestContext: null,
    pretranslateEnabled: false,
    pretranslationStatus: '',
    pretranslationNote: '',
    pretranslationProgress: { stage: '', done: 0, total: 0 },
    pretranslationScope: 'next',
    pretranslationChapterUrl: '',
    cachedPretranslation: false,
    autoApplyAttempted: false,
    pretranslateBusy: false
  };

  const bubble = {
    open: false,
    runId: 0,
    text: '',
    targetCode: 'zh',
    source: null,
    range: null,
    rect: null
  };

  const imageJob = {
    open: false,
    running: false,
    runId: 0,
    targetCode: 'zh',
    sourceHint: '',
    items: [],
    error: '',
    subtitle: ''
  };


  const app = { config, languages, detect, textUtils, novelUtils,
    MSG, LIMITS, BILINGUAL_ATTR, FATAL_ERROR_CODES, SETTINGS_ERROR_CODES, page, bubble, imageJob };
  const overlay = overlayModule.createOverlay({
    languages: languages.TARGET_LANGUAGES,
    callbacks: {
      onPanelAction: (...args) => app.handlePanelAction(...args),
      onBubbleClose: (...args) => app.handleBubbleClosed(...args),
      onBubbleRetry: () => app.translateSelectionAgain(),
      onBubbleTargetChange: (targetCode) => {
        const code = languages.normalizeTarget(targetCode);
        bubble.targetCode = code;
        app.saveTargetLanguage(code);
        app.translateSelectionAgain();
      },
      onBubbleSettings: () => app.openOptionsPage(),
      onImageClose: (...args) => app.closeImagePanel(...args)
    }
  });

  app.overlay = overlay;
  const moduleNames = ['runtime', 'ruby', 'dom', 'captions', 'page-ui', 'page', 'polish', 'novel', 'pretranslation', 'dynamic', 'selection', 'images'];
  for (const name of moduleNames) Object.assign(app, globalThis.DSHT.contentModules[name](app));
  globalThis.__DSHT_CONTENT_LOADED__ = true;

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (!message || typeof message.type !== 'string') return false;
    switch (message.type) {
      case MSG.PING:
        sendResponse({ ok: true });
        return false;

      case MSG.PAGE_INFO:
        sendResponse({ info: app.buildPageInfo() });
        return false;

      case MSG.RESTORE_PAGE: {
        const hadTranslation = app.restorePage({ silent: false });
        sendResponse({ restored: true, hadTranslation });
        return false;
      }

      case MSG.TRANSLATE_PAGE:
        app.startPageTranslation(message)
          .then((result) => sendResponse(result || { started: true }))
          .catch((error) => app.respondError(sendResponse, error));
        return true;

      case MSG.TRANSLATE_SELECTION:
        app.startSelectionTranslation(message)
          .then((result) => sendResponse(result || { started: true }))
          .catch((error) => app.respondError(sendResponse, error));
        return true;

      case MSG.TRANSLATE_IMAGES:
        app.startImageTranslation(message)
          .then((result) => sendResponse(result || { started: true }))
          .catch((error) => app.respondError(sendResponse, error));
        return true;

      default:
        return false;
    }
  });

  app.bindBubbleListeners();
  app.bindImageCapabilityChanges();
  if (novelUtils) setTimeout(() => { void app.maybeAutoApplyPretranslation(); }, 450);
})();
