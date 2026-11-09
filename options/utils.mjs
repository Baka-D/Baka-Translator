// Settings-page utils.
import { EFFORT_LABELS, KEYS, billingTools, feedbackTimers, usageTools } from './context.mjs';

/* ---------- 通用工具 ---------- */

/** Selected model ids as the worker reads them; this page's copy can be stale or a display fallback. */
export async function storedModelIds() {
  const values = await chrome.storage.local.get([KEYS.TRANSLATION_MODEL_ID, KEYS.POLISH_MODEL_ID]);
  return [values[KEYS.TRANSLATION_MODEL_ID], values[KEYS.POLISH_MODEL_ID]];
}

export function isObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

export function setFeedback(element, message, tone, autoClearMs) {
  if (!element) return;
  element.textContent = message || '';
  if (tone) element.dataset.tone = tone;
  else element.removeAttribute('data-tone');
  const pending = feedbackTimers.get(element);
  if (pending) {
    window.clearTimeout(pending);
    feedbackTimers.delete(element);
  }
  if (autoClearMs) {
    const timer = window.setTimeout(() => {
      element.textContent = '';
      element.removeAttribute('data-tone');
      feedbackTimers.delete(element);
    }, autoClearMs);
    feedbackTimers.set(element, timer);
  }
}

/** Disabling the focused control drops focus to <body>; hand it back once controls are enabled again. */
export function restoreFocus(element) {
  const active = document.activeElement;
  if (!element || !element.isConnected || element.disabled || element.hidden) return;
  if (!active || active === document.body || active === element) element.focus();
}

export function persist(update) {
  try {
    return chrome.storage.local.set(update);
  } catch (_error) {
    return Promise.reject(_error);
  }
}

export async function sendMessage(payload) {
  try {
    const response = await chrome.runtime.sendMessage(payload);
    if (!response || typeof response !== 'object') {
      return {
        ok: false,
        error: { code: 'BACKGROUND_UNAVAILABLE', message: '扩展后台暂时不可用，请稍后重试。' }
      };
    }
    return response;
  } catch (_error) {
    return {
      ok: false,
      error: { code: 'BACKGROUND_UNAVAILABLE', message: '扩展后台暂时不可用，请稍后重试。' }
    };
  }
}

export function getVersion() {
  try {
    return String(chrome.runtime.getManifest().version || '');
  } catch (_error) {
    return '';
  }
}

export function formatNumber(value) {
  const number = Number(value);
  const safe = Number.isFinite(number) && number > 0 ? Math.floor(number) : 0;
  try {
    return safe.toLocaleString('zh-CN');
  } catch (_error) {
    return String(safe).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  }
}

export function formatTokens(value) {
  if (usageTools && typeof usageTools.formatTokenCount === 'function') {
    return usageTools.formatTokenCount(value);
  }
  return formatNumber(value);
}

export function formatCost(value) {
  if (billingTools && typeof billingTools.formatCost === 'function') {
    try {
      return billingTools.formatCost(value, 'USD');
    } catch (_error) {
      // 使用下方兜底。
    }
  }
  const amount = Number(value);
  const safe = Number.isFinite(amount) && amount >= 0 ? amount : 0;
  return `$${safe.toFixed(4)}`;
}

export function formatUpdatedAt(value) {
  const timestamp = Number(value);
  if (!Number.isFinite(timestamp) || timestamp <= 0) return '—';
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return '—';
  try {
    return date.toLocaleString('zh-CN', {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false
    });
  } catch (_error) {
    const pad = (part) => String(part).padStart(2, '0');
    return `${date.getFullYear()}/${pad(date.getMonth() + 1)}/${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
  }
}

export function normalizeUsage(raw) {
  if (usageTools && typeof usageTools.normalizeStoredUsage === 'function') {
    return usageTools.normalizeStoredUsage(raw);
  }
  const value = isObject(raw) ? raw : {};
  return {
    totalTokens: Math.max(0, Math.floor(Number(value.totalTokens) || 0)),
    promptTokens: Math.max(0, Math.floor(Number(value.promptTokens) || 0)),
    completionTokens: Math.max(0, Math.floor(Number(value.completionTokens) || 0)),
    cachedTokens: Math.max(0, Math.floor(Number(value.cachedTokens) || 0)),
    requests: Math.max(0, Math.floor(Number(value.requests) || 0)),
    estimatedCostUsd: Math.max(0, Number(value.estimatedCostUsd) || 0),
    updatedAt: Math.max(0, Math.floor(Number(value.updatedAt) || 0))
  };
}

export function normalizeProviderKeys(raw) {
  if (!isObject(raw)) return {};
  const keys = {};
  for (const [providerId, value] of Object.entries(raw)) {
    if (typeof value === 'string' && value.trim()) keys[providerId] = value.trim();
  }
  return keys;
}

export function maskKey(key) {
  const text = typeof key === 'string' ? key : '';
  const prefix = text.startsWith('sk-') ? 'sk-' : '';
  // Custom keys can be short, and a 4-character tail would show most or all of one.
  const tail = text.length - prefix.length > 8 ? text.slice(-4) : '';
  return `${prefix}…${tail}`;
}

export function effortLabel(level) {
  return EFFORT_LABELS[level] || String(level || 'none');
}

export function makeButton(label, className, onClick, ariaLabel) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = className;
  button.textContent = label;
  if (ariaLabel) button.setAttribute('aria-label', ariaLabel);
  button.addEventListener('click', onClick);
  return button;
}
