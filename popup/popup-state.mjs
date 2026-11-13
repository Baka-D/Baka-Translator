/** Shared popup state, document references, and usage display. */
const root = globalThis.DSHT || {};
const i18n = root.i18n;
const { t } = i18n;
const config = root.config;
const languages = root.languages;

const MSG = config.MSG;
const KEYS = config.STORAGE_KEYS;
const TARGETS = languages.TARGET_LANGUAGES;
const LABEL_BY_CODE = new Map(TARGETS.map((language) => [language.code, language.label]));
const usageTools = root.usage || null;
const billingTools = root.billing || null;
const novelUtils = root.novel || null;
const presetsTools = root.presets || null;

const POLL_INTERVAL_MS = 900;
const PRETRANSLATE_POLL_MS = 2000;
const KEY_NOTICE_TEXT = t('pop_missing_key');
const VISION_NOTICE_TEXT = t('pop_vision_unsupported');
const EXT_PAGE_MESSAGE = t('pop_extension_page');
const PAGE_ERROR_MESSAGES = Object.freeze({
  UNSUPPORTED_PAGE: t('pop_protected_page'),
  FILE_ACCESS_DISABLED: t('pop_file_access'),
  NO_PAGE_ACCESS: t('pop_page_access'),
  TAB_CLOSED: t('pop_tab_closed'),
  INVALID_SENDER: t('pop_invalid_sender'),
  INVALID_TAB: t('pop_invalid_tab'),
  BACKGROUND_UNAVAILABLE: t('pop_background_unavailable')
});

const byId = (id) => document.getElementById(id);
const ui = {
  statusDot: byId('statusDot'),
  statusText: byId('statusText'),
  statusCount: byId('statusCount'),
  sourceLabel: byId('sourceLabel'),
  targetLabel: byId('targetLabel'),
  progressTrack: byId('progressTrack'),
  progressFill: byId('progressFill'),
  keyNotice: byId('keyNotice'),
  keyNoticeText: byId('keyNoticeText'),
  keyNoticeAction: byId('keyNoticeAction'),
  pageNotice: byId('pageNotice'),
  pageNoticeText: byId('pageNoticeText'),
  targetSelect: byId('targetSelect'),
  bilingualToggle: byId('bilingualToggle'),
  mainButton: byId('mainButton'),
  restoreButton: byId('restoreButton'),
  selectionButton: byId('selectionButton'),
  imagesButton: byId('imagesButton'),
  polishToggle: byId('polishToggle'),
  pretranslateToggle: byId('pretranslateToggle'),
  sitePresetSelect: byId('sitePresetSelect'),
  polishHint: byId('polishHint'),
  costItem: byId('costItem'),
  costLabel: byId('costLabel'),
  usageSummary: byId('usageSummary'),
  usageTokens: byId('usageTokens'),
  openOptionsTop: byId('openOptionsTop'),
  openOptionsFooter: byId('openOptionsFooter')
};

const state = {
  tabId: null,
  tabUrl: '',
  hasApiKey: false,
  modelError: '',
  supportsVision: true,
  modelName: '',
  modelKey: '',
  configLoaded: false,
  settings: {
    targetCode: languages.normalizeTarget(null),
    bilingual: config.DEFAULT_BILINGUAL === true
  },
  info: null,
  pageError: null,
  pageMessage: null,
  loading: true,
  initialFetch: false,
  busy: false,
  mainAction: { kind: 'none', label: t('pop_translate_page'), disabled: true },
  stateLoaded: false,
  usage: null,
  usageKnown: false,
  host: '',
  siteSettings: {},
  presetIndex: null,
  globalPresetId: config.DEFAULT_PRESET_ID || 'general',
  polishHasApiKey: true,
  pollTimer: 0
};

function labelOf(code) {
  return i18n.languageLabel(languages.normalizeTarget(code));
}

/* ---------- 累计用量 ---------- */

function normalizeUsage(raw) {
  if (usageTools && typeof usageTools.normalizeStoredUsage === 'function') {
    return usageTools.normalizeStoredUsage(raw);
  }
  const value = raw && typeof raw === 'object' ? raw : {};
  const tokenNumber = (input) => {
    const number = Number(input);
    return Number.isFinite(number) && number > 0 ? Math.min(Number.MAX_SAFE_INTEGER, Math.floor(number)) : 0;
  };
  return {
    totalTokens: tokenNumber(value.totalTokens),
    promptTokens: tokenNumber(value.promptTokens),
    completionTokens: tokenNumber(value.completionTokens),
    cachedTokens: tokenNumber(value.cachedTokens),
    requests: tokenNumber(value.requests),
    estimatedCostUsd: Math.max(0, Number(value.estimatedCostUsd) || 0),
    updatedAt: tokenNumber(value.updatedAt)
  };
}

function formatTokens(value) {
  if (usageTools && typeof usageTools.formatTokenCount === 'function') {
    return usageTools.formatTokenCount(value);
  }
  const number = Number(value);
  const safe = Number.isFinite(number) && number > 0 ? Math.floor(number) : 0;
  try {
    return safe.toLocaleString(i18n.locale);
  } catch (_error) {
    return String(safe).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  }
}

function renderUsage() {
  if (!ui.usageTokens) return;
  if (!state.usageKnown || !state.usage) {
    if (ui.usageTokens.textContent !== '—') ui.usageTokens.textContent = '—';
    return;
  }
  const formatted = formatTokens(state.usage.totalTokens);
  if (ui.usageTokens.textContent !== formatted) ui.usageTokens.textContent = formatted;
  if (ui.usageSummary) {
    ui.usageSummary.setAttribute(
      'title',
      t('pop_usage_title', [formatted])
    );
  }
}


export { t, i18n, config, languages, MSG, KEYS, TARGETS, LABEL_BY_CODE, usageTools, billingTools, novelUtils, presetsTools, POLL_INTERVAL_MS, PRETRANSLATE_POLL_MS, KEY_NOTICE_TEXT, VISION_NOTICE_TEXT, EXT_PAGE_MESSAGE, PAGE_ERROR_MESSAGES, ui, state, labelOf, normalizeUsage, renderUsage };
