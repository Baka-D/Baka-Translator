/**
 * Background service worker: context menus, keyboard commands, page access,
 * screenshot capture and all model API calls.
 *
 * Only this worker uses the API key, and no message carries it to a content
 * script, a web page or the popup. chrome.storage.local itself stays readable
 * from content scripts, which keep their settings and novel data there.
 */
importScripts(
  chrome.runtime.getURL('shared/i18n.js'),
  chrome.runtime.getURL('shared/config.js'),
  chrome.runtime.getURL('shared/languages.js'),
  chrome.runtime.getURL('shared/detect.js'),
  chrome.runtime.getURL('shared/text.js'),
  chrome.runtime.getURL('shared/glossary.js'),
  chrome.runtime.getURL('shared/novel.js'),
  chrome.runtime.getURL('shared/models.js'),
  chrome.runtime.getURL('shared/vision.js'),
  chrome.runtime.getURL('shared/billing.js'),
  chrome.runtime.getURL('shared/presets.js'),
  chrome.runtime.getURL('preset/system-prompts.js'),
  chrome.runtime.getURL('shared/protocol-responses.js'),
  chrome.runtime.getURL('shared/protocol.js'),
  chrome.runtime.getURL('shared/usage.js'),
  chrome.runtime.getURL('background/api-transport.js'),
  chrome.runtime.getURL('background/api-anthropic.js'),
  chrome.runtime.getURL('background/api-terms.js'),
  chrome.runtime.getURL('background/api-models.js'),
  chrome.runtime.getURL('background/api-vision.js'),
  chrome.runtime.getURL('background/api.js')
);

const {
  config,
  languages,
  api,
  textUtils,
  usage: usageUtils,
  models: modelUtils,
  vision: visionUtils,
  billing: billingUtils,
  presets: presetUtils
} = globalThis.DSHT;
const { t } = globalThis.DSHT.i18n;
const MSG = config.MSG;
const LIMITS = config.LIMITS;

let usageWriteQueue = Promise.resolve();
let visionWriteQueue = Promise.resolve();
const learnedVisionCapabilities = {};
if (chrome.storage.onChanged) {
  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== 'local') return;
    const change = changes?.[config.STORAGE_KEYS.VISION_CAPABILITIES];
    if (change) {
      const next = visionUtils.normalizeCache(change.newValue);
      for (const key of Object.keys(visionUtils.normalizeCache(change.oldValue))) {
        if (!next[key]) delete learnedVisionCapabilities[key];
      }
      Object.assign(learnedVisionCapabilities, next);
    }
    const keys = config.STORAGE_KEYS;
    if ([keys.VISION_CAPABILITIES, keys.MODEL_ID, keys.TRANSLATION_MODEL_ID, keys.CUSTOM_PROVIDER,
      keys.CUSTOM_PROVIDERS, keys.USER_MODELS].some((key) => changes?.[key])) {
      void syncVisionContextMenu();
    }
  });
}
let registryPromise = null;
let presetIndexPromise = null;
const presetCache = new Map();

const CONTENT_SCRIPTS = [
  'shared/i18n.js',
  'shared/config.js',
  'shared/languages.js',
  'shared/detect.js',
  'shared/text.js',
  'shared/glossary.js',
  'shared/novel.js',
  'content/overlay-style-base.js',
  'content/overlay-style-images.js',
  'content/overlay-ui.js',
  'content/overlay-panel.js',
  'content/overlay-bubble.js',
  'content/overlay-images.js',
  'content/overlay-image-frame.js',
  'content/overlay.js',
  'content/content-runtime.js',
  'content/content-ruby.js',
  'content/content-dom.js',
  'content/content-captions.js',
  'content/content-page-ui.js',
  'content/content-page.js',
  'content/content-polish.js',
  'content/content-novel.js',
  'content/content-pretranslation.js',
  'content/content-dynamic.js',
  'content/content-selection.js',
  'content/content-image-capture.js',
  'content/content-images.js',
  'content/content.js'
];

const MENU_IDS = Object.freeze({
  ROOT: 'dsht-root',
  SELECTION: 'dsht-selection',
  PAGE: 'dsht-page',
  RESTORE: 'dsht-restore',
  IMAGES: 'dsht-images'
});

const PAGE_ACCESS_ERRORS = Object.freeze({
  UNSUPPORTED_PAGE:
    t('bg_page_restricted'),
  FILE_ACCESS_DISABLED:
    t('bg_file_access_disabled'),
  NO_PAGE_ACCESS: t('bg_page_access_failed'),
  TAB_CLOSED: t('bg_tab_closed'),
  NO_API_KEY: t('bg_current_model_missing_key'),
  MODEL_CONFIG_ERROR: t('bg_model_config_unreadable'),
  SCREENSHOT_FAILED: t('bg_screenshot_failed'),
  PAGE_LOADING: t('bg_page_loading')
});

class PageAccessError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'PageAccessError';
    this.code = code;
  }
}

importScripts(
  chrome.runtime.getURL('background/worker-settings.js'),
  chrome.runtime.getURL('background/worker-state.js'),
  chrome.runtime.getURL('background/worker-vision.js'),
  chrome.runtime.getURL('background/worker-requests.js'),
  chrome.runtime.getURL('background/worker-pretranslation.js'),
  chrome.runtime.getURL('background/worker-novel-storage.js'),
  chrome.runtime.getURL('background/worker-glossary-tidy.js'),
  chrome.runtime.getURL('background/worker-pages.js'),
  chrome.runtime.getURL('background/worker-capture.js'),
  chrome.runtime.getURL('background/worker-image-panel.js')
);

async function handleMessage(message, sender) {
  switch (message.type) {
    case MSG.GET_CONFIG:
      return getConfigSnapshot();

    case MSG.IMAGE_PANEL_UPDATE:
      return handleImagePanelUpdate(message, sender);

    case MSG.TEST_CONNECTION: {
      if (!sender.url || !sender.url.startsWith(chrome.runtime.getURL('options/'))) {
        throw new PageAccessError('INVALID_SENDER', t('bg_invalid_sender'));
      }
      const purpose = message.purpose === 'polish' ? 'polish' : 'translation';
      const providerId = typeof message.providerId === 'string' ? message.providerId : '';
      const runtime = await resolveRuntime(purpose, '', providerId);
      const result = await api.testConnection({
        apiKey: runtime.apiKey,
        model: runtime.resolved.model,
        provider: runtime.resolved.provider,
        effortLevel: runtime.resolved.effort
      });
      return {
        ...result,
        purpose: runtime.purpose,
        modelId: runtime.resolved.model.id,
        modelName: runtime.resolved.model.name,
        effortLevel: runtime.resolved.effort
      };
    }

    case MSG.FETCH_MODELS: {
      if (!sender.url || !sender.url.startsWith(chrome.runtime.getURL('options/'))) {
        throw new PageAccessError('INVALID_SENDER', t('bg_models_options_only'));
      }
      const settings = await readSettings();
      const registry = settingsRegistry(await loadRegistry(), settings);
      const providerId = typeof message.providerId === 'string' ? message.providerId : '';
      const provider = Object.hasOwn(registry.providers, providerId) && registry.providers[providerId];
      if (!provider) throw new PageAccessError('MISSING_PROVIDER', t('bg_missing_provider'));
      if (message.apiKey !== undefined && typeof message.apiKey !== 'string') {
        throw new PageAccessError('INVALID_API_KEY_FORMAT', t('bg_invalid_key_format'));
      }
      const apiKey = (message.apiKey || '').trim() || getProviderApiKey(provider, settings);
      return { models: await api.fetchModels({ provider, apiKey }) };
    }

    case MSG.RESET_VISION_CAPABILITY:
      if (!sender.url || !sender.url.startsWith(chrome.runtime.getURL('options/'))) {
        throw new PageAccessError('INVALID_SENDER', t('bg_vision_options_only'));
      }
      return resetVisionCapability(message);

    case MSG.RESET_USAGE: {
      if (!sender.url || !sender.url.startsWith(chrome.runtime.getURL('options/'))) {
        throw new PageAccessError('INVALID_SENDER', t('bg_invalid_sender'));
      }
      await resetUsage();
      const values = await chrome.storage.local.get(config.STORAGE_KEYS.USAGE);
      return {
        usage: usageUtils.normalizeStoredUsage(values[config.STORAGE_KEYS.USAGE])
      };
    }

    case MSG.PAGE_COMMAND:
      return handlePageCommand(message, sender);

    case MSG.TRANSLATE_BATCH:
      return handleTranslateBatch(message, sender);

    case MSG.POLISH_SEGMENTS:
      return handlePolishSegments(message, sender);

    case MSG.HEARTBEAT:
      return { ok: true };

    case MSG.EXTRACT_TERMS:
      return handleExtractTerms(message, sender);

    case MSG.TIDY_GLOSSARY:
      return handleTidyGlossary(message, sender);

    case MSG.LOAD_NOVEL_CONTEXT:
      return loadNovelContext(message, sender);

    case MSG.SAVE_NOVEL_GLOSSARY:
      return saveNovelGlossary(message, sender);

    case MSG.GLOSSARY_EDIT:
      return handleGlossaryEdit(message, sender);

    case MSG.PRETRANSLATE_CHAPTER:
      return handlePretranslateChapter(message, sender);

    case MSG.SAVE_CHAPTER_CACHE:
      return saveChapterCache(message, sender);

    case MSG.GET_PRETRANSLATION:
      return getPretranslation(message, sender);

    case MSG.CANCEL_PRETRANSLATION:
      return cancelPretranslation(message, sender);

    case MSG.STOP_PAGE_REQUESTS:
      return stopPageRequests(sender);

    case MSG.TRANSLATE_IMAGE:
      return handleTranslateImage(message, sender);

    case MSG.CAPTURE_SCREENSHOT:
      if (!sender.tab || sender.tab.id === undefined) {
        throw new PageAccessError('INVALID_SENDER', t('bg_invalid_sender'));
      }
      return capturePageScreenshot(sender);

    case MSG.PAGE_STATUS:
      if (sender.tab && sender.tab.id) {
        setBadge(
          sender.tab.id,
          String(message.status || 'idle'),
          String(message.targetLabel || '')
        );
      }
      return { ok: true };

    case MSG.OPEN_OPTIONS:
      await chrome.runtime.openOptionsPage();
      return { ok: true };

    default:
      return null;
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || typeof message.type !== 'string') return false;
  const known = new Set(Object.values(MSG));
  if (!known.has(message.type)) return false;
  handleMessage(message, sender)
    .then((result) => {
      if (result === null) {
        sendResponse({ ok: false, error: { code: 'UNKNOWN_MESSAGE', message: t('bg_unknown_message') } });
        return;
      }
      sendResponse({ ok: true, ...result });
    })
    .catch((error) => {
      sendResponse({ ok: false, error: errorPayload(error) });
    });
  return true;
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  void handleContextMenuClick(info, tab);
});

chrome.commands.onCommand.addListener((command, tab) => {
  void handleCommand(command, tab);
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status === 'loading') {
    setBadge(tabId, 'idle');
  }
});

function runBackgroundSetup() {
  initializeStorage().catch(() => {});
  setupContextMenus().catch(() => {});
}

chrome.runtime.onInstalled.addListener(() => {
  runBackgroundSetup();
});

chrome.runtime.onStartup.addListener(() => {
  setupContextMenus().catch(() => {});
});

// Ensure menus and defaults exist after a manual extension reload / worker wake.
runBackgroundSetup();
