/** Shared popup state, document references, and usage display. */
const root = globalThis.DSHT || {};
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
const KEY_NOTICE_TEXT = '尚未填写所选模型的 API Key，请在设置中填写，或改用已配置 Key 的模型。';
const VISION_NOTICE_TEXT = '当前模型不支持图像识别，图片翻译已禁用；请选择支持图片的模型。';
const EXT_PAGE_MESSAGE = '当前标签页是扩展自身页面，无法翻译，请在普通网页上使用。';
const PAGE_ERROR_MESSAGES = Object.freeze({
  UNSUPPORTED_PAGE: '此页面是浏览器内置页面或受保护页面，浏览器不允许扩展修改它，请在普通网页上使用。',
  FILE_ACCESS_DISABLED: '无法访问本地文件。请在扩展详情中启用“允许访问文件网址”。',
  NO_PAGE_ACCESS: '无法访问此页面，请刷新页面后重试。',
  TAB_CLOSED: '页面已关闭。',
  INVALID_SENDER: '请从浏览器工具栏的扩展图标打开此面板来操作页面。',
  INVALID_TAB: '没有可操作的标签页。',
  BACKGROUND_UNAVAILABLE: '扩展后台暂时不可用，请关闭后重试。'
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
  mainAction: { kind: 'none', label: '翻译此页面', disabled: true },
  stateLoaded: false,
  usage: null,
  usageKnown: false,
  host: '',
  siteSettings: {},
  presetIndex: null,
  globalPresetId: config.DEFAULT_PRESET_ID || 'general',
  polishHasApiKey: true,
  siteDirty: false,
  pollTimer: 0
};

function labelOf(code) {
  return LABEL_BY_CODE.get(languages.normalizeTarget(code)) || '中文';
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
    return safe.toLocaleString('zh-CN');
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
      `累计 Token 使用量：${formatted} tokens（按服务商返回的 usage 统计，仅供参考）`
    );
  }
}


export { config, languages, MSG, KEYS, TARGETS, LABEL_BY_CODE, usageTools, billingTools, novelUtils, presetsTools, POLL_INTERVAL_MS, PRETRANSLATE_POLL_MS, KEY_NOTICE_TEXT, VISION_NOTICE_TEXT, EXT_PAGE_MESSAGE, PAGE_ERROR_MESSAGES, ui, state, labelOf, normalizeUsage, renderUsage };
