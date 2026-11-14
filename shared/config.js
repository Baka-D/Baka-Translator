/**
 * Shared runtime configuration. Loaded in the service worker, content script
 * and extension pages.
 */
(function initConfig(globalScope) {
  'use strict';
  const config = Object.freeze({
    isRestrictedUrl(url) {
      if (!url) return false;
      return /^(chrome(?:-untrusted|-extension|-search)?|brave(?:-search)?|edge(?:-untrusted|-search)?|about|devtools|view-source):/i.test(url)
        || /^https:\/\/(?:chromewebstore\.google\.com(?:[/?#]|$)|chrome\.google\.com\/webstore(?:[/?#]|$))/i.test(url);
    },

    API_BASE_URL: 'https://api.deepseek.com',
    CHAT_ENDPOINT: '/chat/completions',
    MODELS_ENDPOINT: '/models',
    // DeepSeek-V4.1-Flash-1017: supports text + vision and JSON output.
    MODEL: 'deepseek-flash',
    DEFAULT_TARGET: 'zh',
    DEFAULT_BILINGUAL: false,
    DEFAULT_MODEL_ID: 'deepseek-flash',
    DEFAULT_EFFORT: 'none',
    DEFAULT_PRESET_ID: 'general',
    DEFAULT_GLOSSARY_TIDY_CHAPTERS: 10,
    GLOSSARY_TIDY_MAX_CHAPTERS: 500,
    // Presets whose requests carry the surrounding text as read-only context.
    CONTEXT_PRESET_IDS: Object.freeze(['light-novel', 'academic']),
    MODEL_REGISTRY_PATH: 'profile/index.json',
    PRESET_INDEX_PATH: 'preset/index.json',

    STORAGE_KEYS: Object.freeze({
      API_KEY: 'apiKey',
      TARGET: 'targetLang',
      BILINGUAL: 'bilingual',
      USAGE: 'usageStats',
      MODEL_ID: 'modelId',
      EFFORT: 'effortLevel',
      TRANSLATION_MODEL_ID: 'translationModelId',
      TRANSLATION_EFFORT: 'translationEffortLevel',
      POLISH_MODEL_ID: 'polishModelId',
      POLISH_EFFORT: 'polishEffortLevel',
      PRESET_ID: 'presetId',
      PROVIDER_KEYS: 'providerKeys',
      CUSTOM_PROVIDER: 'customProvider',
      CUSTOM_PROVIDERS: 'customProviders',
      USER_MODELS: 'userModels',
      VISION_CAPABILITIES: 'visionCapabilities',
      PROMPT_OVERRIDES: 'promptOverrides',
      SITE_SETTINGS: 'siteSettings',
      GLOSSARY_TIDY_ENABLED: 'glossaryTidyEnabled',
      GLOSSARY_TIDY_CHAPTERS: 'glossaryTidyChapters',
      GLOSSARY_TIDY_MODEL: 'glossaryTidyModel',
      INSTALLED_AT: 'installedAt'
    }),

    TRANSLATION_ENGINE_KEYS: Object.freeze([
      'modelId', 'effortLevel', 'translationModelId', 'translationEffortLevel',
      'polishModelId', 'polishEffortLevel', 'promptOverrides', 'customProviders'
    ]),

    translationCacheKey(settings, targetCode, hostname) {
      const site = settings.siteSettings?.[hostname];
      const sitePreset = site && typeof site.presetId === 'string' ? site.presetId.trim() : '';
      return JSON.stringify([settings.engine, sitePreset || settings.presetId || 'general', targetCode]);
    },

    /** Chapters between glossary tidies. */
    glossaryTidyChapters(value) {
      const chapters = Number(value ?? this.DEFAULT_GLOSSARY_TIDY_CHAPTERS);
      return Number.isInteger(chapters) && chapters >= 1 && chapters <= this.GLOSSARY_TIDY_MAX_CHAPTERS
        ? chapters
        : this.DEFAULT_GLOSSARY_TIDY_CHAPTERS;
    },

    LIMITS: Object.freeze({
      TEXT_MAX_BATCH_CHARS: 2800,
      TEXT_MAX_BATCH_ITEMS: 60,
      TEXT_MAX_SEGMENT_CHARS: 6000,
      TEXT_MAX_CONCURRENCY: 3,
      PAGE_MAX_NODES: 4500,
      PAGE_MAX_CHARS: 120000,
      TRANSLATION_MEMORY_MAX_ITEMS: 6000,
      SELECTION_MAX_CHARS: 8000,
      DYNAMIC_MAX_NODES: 1200,
      DYNAMIC_MAX_CHARS: 60000,
      BILINGUAL_MAX_ORIGINAL_CHARS: 4000,
      IMAGE_MAX_COUNT: 6,
      IMAGE_MIN_WIDTH: 96,
      IMAGE_MIN_HEIGHT: 48,
      IMAGE_MIN_AREA: 9000,
      IMAGE_MAX_DIMENSION: 1600,
      IMAGE_JPEG_QUALITY: 0.86,
      IMAGE_MAX_CONCURRENCY: 2,
      IMAGE_MAX_DATA_URL_CHARS: 8 * 1024 * 1024,
      API_MAX_SEGMENTS: 60,
      API_MAX_TOTAL_CHARS: 12000,
      API_MAX_SEGMENT_CHARS: 10000,
      POLISH_MAX_SEGMENTS: 5000,
      POLISH_MAX_TOTAL_CHARS: 300000,
      POLISH_CHUNK_CHARS: 16000,
      POLISH_MAX_CONCURRENCY: 3,
      NOVEL_CONTEXT_CHAPTERS: 3,
      NOVEL_MAX_CACHE_CHAPTERS: 30,
      NOVEL_CACHE_TTL_MS: 30 * 24 * 60 * 60 * 1000,
      GLOSSARY_REQUEST_MAX_TERMS: 200,
      GLOSSARY_CHAPTER_MAX_TERMS: 5000,
      GLOSSARY_TIDY_BATCH_TERMS: 400,
      NOVEL_TERMS_MAX_SEGMENTS: 400,
      NOVEL_TERMS_MAX_CHARS: 60000,
      NOVEL_PRETRANSLATE_MAX_CHARS: 60000,
      CONTEXT_PREVIOUS_CHAPTER_CHARS: 800,
      CONTEXT_PRECEDING_CHARS: 300,
      CONTEXT_FETCH_MS: 4000
    }),

    TIMEOUTS: Object.freeze({
      REQUEST_MS: 90000,
      POLISH_MS: 300000,
      TEST_MS: 20000,
      API_MAX_RETRIES: 2,
      RETRY_BASE_DELAY_MS: 700
    }),

    MSG: Object.freeze({
      PING: 'dsht:ping',
      PAGE_INFO: 'dsht:getPageInfo',
      TRANSLATE_PAGE: 'dsht:translatePage',
      RESTORE_PAGE: 'dsht:restorePage',
      TRANSLATE_SELECTION: 'dsht:translateSelection',
      TRANSLATE_IMAGES: 'dsht:translateImages',
      SHOW_TOAST: 'dsht:showToast',
      CAPTURE_SCREENSHOT: 'dsht:captureScreenshot',
      IMAGE_PANEL_UPDATE: 'dsht:imagePanelUpdate',
      IMAGE_PANEL_CLOSED: 'dsht:imagePanelClosed',
      IMAGE_PANEL_READY: 'dsht:imagePanelReady',
      TRANSLATE_BATCH: 'dsht:translateBatch',
      POLISH_SEGMENTS: 'dsht:polishSegments',
      EXTRACT_TERMS: 'dsht:extractTerms',
      TIDY_GLOSSARY: 'dsht:tidyGlossary',
      LOAD_NOVEL_CONTEXT: 'dsht:loadNovelContext',
      SAVE_NOVEL_GLOSSARY: 'dsht:saveNovelGlossary',
      GLOSSARY_EDIT: 'dsht:editGlossary',
      HEARTBEAT: 'dsht:heartbeat',
      PRETRANSLATE_CHAPTER: 'dsht:pretranslateChapter',
      SAVE_CHAPTER_CACHE: 'dsht:saveChapterCache',
      GET_PRETRANSLATION: 'dsht:getPretranslation',
      CANCEL_PRETRANSLATION: 'dsht:cancelPretranslation',
      STOP_PAGE_REQUESTS: 'dsht:stopPageRequests',
      TRANSLATE_IMAGE: 'dsht:translateImage',
      PAGE_STATUS: 'dsht:pageStatus',
      OPEN_OPTIONS: 'dsht:openOptions',
      PAGE_COMMAND: 'dsht:pageCommand',
      GET_CONFIG: 'dsht:getConfig',
      TEST_CONNECTION: 'dsht:testConnection',
      FETCH_MODELS: 'dsht:fetchModels',
      RESET_VISION_CAPABILITY: 'dsht:resetVisionCapability',
      RESET_USAGE: 'dsht:resetUsage'
    })
  });

  globalScope.DSHT = globalScope.DSHT || {};
  globalScope.DSHT.config = config;

  if (typeof module === 'object' && module.exports) {
    module.exports = config;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this);
