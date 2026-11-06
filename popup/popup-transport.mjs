/** Background messages and loading extension configuration. */
import { MSG, KEYS, languages, config, PAGE_ERROR_MESSAGES, normalizeUsage, state } from './popup-state.mjs';

/* ---------- 与 background 通信 ---------- */

function errorText(error) {
  const code = error && typeof error.code === 'string' ? error.code : 'UNKNOWN_ERROR';
  if (PAGE_ERROR_MESSAGES[code]) return PAGE_ERROR_MESSAGES[code];
  const message = error && typeof error.message === 'string' ? error.message.trim() : '';
  return message || '操作失败，请重试。';
}

async function sendMessage(payload) {
  try {
    const response = await chrome.runtime.sendMessage(payload);
    if (!response || typeof response !== 'object') {
      return {
        ok: false,
        error: { code: 'BACKGROUND_UNAVAILABLE', message: PAGE_ERROR_MESSAGES.BACKGROUND_UNAVAILABLE }
      };
    }
    return response;
  } catch (_error) {
    return {
      ok: false,
      error: { code: 'BACKGROUND_UNAVAILABLE', message: PAGE_ERROR_MESSAGES.BACKGROUND_UNAVAILABLE }
    };
  }
}

function pageCommand(command, extra) {
  return sendMessage(
    Object.assign({ type: MSG.PAGE_COMMAND, command, tabId: state.tabId }, extra || {})
  );
}

function persistSettings(update) {
  try {
    const result = chrome.storage.local.set(update);
    if (result && typeof result.catch === 'function') result.catch(() => {});
  } catch (_error) {
    // 持久化失败不应影响本次会话中的翻译操作。
  }
}

async function openOptions() {
  const response = await sendMessage({ type: MSG.OPEN_OPTIONS });
  if (response.ok) return;
  try {
    await chrome.runtime.openOptionsPage();
  } catch (_error) {
    // 忽略：窗口可能已关闭。
  }
}

/* ---------- 初始化数据 ---------- */

async function readConfig() {
  const response = await sendMessage({ type: MSG.GET_CONFIG });
  if (response.ok && typeof response.hasApiKey === 'boolean') {
    return {
      ok: true,
      hasApiKey: response.hasApiKey,
      supportsVision: response.model?.supportsVision !== false,
      modelName: response.model?.name || response.model?.model || '',
      modelKey: JSON.stringify([response.provider?.id, response.model?.endpoint,
        response.model?.model || response.model?.id]),
      targetCode: languages.normalizeTarget(response.targetLang),
      bilingual: response.bilingual === true,
      presetId:
        typeof response.presetId === 'string' && response.presetId
          ? response.presetId
          : config.DEFAULT_PRESET_ID || 'general',
      polishHasApiKey: response.polishHasApiKey !== false,
      usage:
        response.usage && typeof response.usage === 'object'
          ? normalizeUsage(response.usage)
          : null
    };
  }
  // 不在 popup 内直接读取 storage：API Key 只由 background 接触。
  return {
    ok: false,
    error: response.error || {
      code: 'BACKGROUND_UNAVAILABLE',
      message: PAGE_ERROR_MESSAGES.BACKGROUND_UNAVAILABLE
    }
  };
}

async function queryActiveTab() {
  try {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    return Array.isArray(tabs) && tabs.length > 0 ? tabs[0] : null;
  } catch (_error) {
    return null;
  }
}

function isRestrictedUrl(url) {
  return config.isRestrictedUrl(url);
}


export { errorText, pageCommand, persistSettings, openOptions, readConfig, queryActiveTab, isRestrictedUrl };
