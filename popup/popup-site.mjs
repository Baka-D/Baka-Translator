/** Per-site settings, presets, novel availability, and page costs. */
import { config, billingTools, novelUtils, presetsTools, KEYS, ui, state } from './popup-state.mjs';

/* ---------- 本站润色与页面费用 ---------- */

function hostFromUrl(url) {
  if (!url) return '';
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return '';
    return parsed.hostname.toLowerCase();
  } catch (_error) {
    return '';
  }
}

function siteValueFor(settings, host) {
  if (!host || !settings || typeof settings !== 'object') return null;
  return Object.prototype.hasOwnProperty.call(settings, host) ? settings[host] : null;
}

function siteFlagFor(settings, host, flag) {
  const value = siteValueFor(settings, host);
  if (typeof value === 'boolean') return flag === 'polish' ? value : false;
  return Boolean(value && typeof value === 'object' && value[flag] === true);
}

const PRESET_NAME_FALLBACK = Object.freeze({
  general: '常规',
  academic: '学术',
  'light-novel': '轻小说'
});

function presetDisplayName(presetId) {
  if (!presetId) return '';
  const metas =
    state.presetIndex && Array.isArray(state.presetIndex.presets) ? state.presetIndex.presets : [];
  const meta = metas.find((preset) => preset.id === presetId);
  if (meta) return meta.name;
  return PRESET_NAME_FALLBACK[presetId] || presetId;
}

function sitePresetValueFor(host) {
  const value = siteValueFor(state.siteSettings, host);
  if (value && typeof value === 'object' && typeof value.presetId === 'string') {
    return value.presetId.trim();
  }
  return '';
}

function populateSitePresetSelect() {
  if (!ui.sitePresetSelect) return;
  const select = ui.sitePresetSelect;
  select.textContent = '';
  const follow = document.createElement('option');
  follow.value = '';
  follow.textContent = `跟随全局（当前 ${presetDisplayName(state.globalPresetId) || '常规'}）`;
  select.appendChild(follow);
  const metas =
    state.presetIndex && Array.isArray(state.presetIndex.presets) ? state.presetIndex.presets : [];
  for (const preset of metas) {
    const option = document.createElement('option');
    option.value = preset.id;
    option.textContent = preset.name;
    select.appendChild(option);
  }
  select.value = sitePresetValueFor(state.host);
}

function currentNovelChapter(info) {
  if (info && info.novel && typeof info.novel === 'object') return info.novel;
  if (novelUtils && typeof novelUtils.detectChapter === 'function' && state.tabUrl) {
    try {
      return novelUtils.detectChapter(state.tabUrl);
    } catch (_error) {
      return null;
    }
  }
  return null;
}

function siteFeatureHint(chapterEligible) {
  if (!state.host) return '请在普通网页上使用站点开关。';
  if (state.pageError) return '此页面不可用站点开关。';
  if (!chapterEligible) return `预翻译仅适用于受支持轻小说站点的章节页（当前：${state.host}）。`;
  return `润色与预翻译仅对 ${state.host} 生效；预翻译会缓存下一章，打开下一章自动应用。`;
}

function formatCostValue(value, currency) {
  if (billingTools && typeof billingTools.formatCost === 'function') {
    try {
      return billingTools.formatCost(value, currency || 'USD');
    } catch (_error) {
      // 落到下方兜底格式。
    }
  }
  const amount = Number(value);
  if (!Number.isFinite(amount) || amount < 0) return '—';
  const code = typeof currency === 'string' && currency ? currency.toUpperCase() : 'USD';
  return code === 'USD' ? `$${amount.toFixed(4)}` : `${amount.toFixed(4)} ${code}`;
}

function renderSiteToggles() {
  const usable = Boolean(state.host) && !state.pageError;
  const chapter = currentNovelChapter(state.info);
  const chapterEligible = usable && Boolean(chapter && chapter.isChapter);
  const locked = Boolean(state.loading);

  if (ui.polishToggle) {
    ui.polishToggle.disabled = !usable || locked;
    ui.polishToggle.checked = usable ? siteFlagFor(state.siteSettings, state.host, 'polish') : false;
  }
  if (ui.pretranslateToggle) {
    ui.pretranslateToggle.disabled = !chapterEligible || locked;
    ui.pretranslateToggle.checked = chapterEligible
      ? siteFlagFor(state.siteSettings, state.host, 'pretranslate')
      : false;
    ui.pretranslateToggle.title = chapterEligible
      ? '预翻译下一章'
      : '预翻译仅适用于受支持轻小说站点的章节页';
  }
  if (ui.polishHint) {
    ui.polishHint.textContent = siteFeatureHint(chapterEligible);
    ui.polishHint.title = ui.polishHint.textContent;
  }
  if (ui.sitePresetSelect) {
    const presetValue = usable ? sitePresetValueFor(state.host) : '';
    const metas =
      state.presetIndex && Array.isArray(state.presetIndex.presets) ? state.presetIndex.presets : [];
    const known = !presetValue || metas.some((preset) => preset.id === presetValue);
    ui.sitePresetSelect.disabled = !usable || locked;
    ui.sitePresetSelect.value = known ? presetValue : '';
  }
}

function renderCost() {
  if (!ui.costItem || !ui.costLabel) return;
  const info = state.info;
  const cost = info ? info.estimatedCostUsd : null;
  if (!(cost > 0)) {
    ui.costItem.hidden = true;
    return;
  }
  ui.costLabel.textContent = formatCostValue(cost, info.costCurrency);
  ui.costItem.hidden = false;
}

async function readSiteSettings() {
  try {
    const values = await chrome.storage.local.get([KEYS.SITE_SETTINGS]);
    const stored = values[KEYS.SITE_SETTINGS];
    return stored && typeof stored === 'object' && !Array.isArray(stored) ? stored : {};
  } catch (_error) {
    return {};
  }
}

async function saveSiteFlag(host, patch, removeKeys) {
  if (!host) return false;
  try {
    const values = await chrome.storage.local.get([KEYS.SITE_SETTINGS]);
    const stored = values[KEYS.SITE_SETTINGS];
    const all =
      stored && typeof stored === 'object' && !Array.isArray(stored)
        ? Object.assign({}, stored)
        : {};
    const currentValue = all[host];
    const current =
      currentValue && typeof currentValue === 'object' && !Array.isArray(currentValue)
        ? currentValue
        : typeof currentValue === 'boolean'
          ? { polish: currentValue }
          : {};
    const next = Object.assign({ polish: false, pretranslate: false }, current, patch || {});
    for (const key of removeKeys || []) delete next[key];
    all[host] = next;
    await chrome.storage.local.set({ [KEYS.SITE_SETTINGS]: all });
    state.siteSettings = all;
    return true;
  } catch (_error) {
    return false;
  }
}

async function loadPresetIndex() {
  const path = config.PRESET_INDEX_PATH || 'preset/index.json';
  try {
    const response = await fetch(chrome.runtime.getURL(path), { cache: 'no-store' });
    if (!response || !response.ok) throw new Error('PRESET_INDEX_FETCH_FAILED');
    const raw = await response.json();
    const index = presetsTools ? presetsTools.normalizePresetIndex(raw) : null;
    if (!index || !Array.isArray(index.presets) || index.presets.length === 0) {
      throw new Error('PRESET_INDEX_EMPTY');
    }
    state.presetIndex = index;
  } catch (_error) {
    state.presetIndex = {
      defaultPresetId: 'general',
      presets: [
        { id: 'general', name: '常规' },
        { id: 'academic', name: '学术' },
        { id: 'light-novel', name: '轻小说' }
      ]
    };
  }
}


export { hostFromUrl, siteFlagFor, sitePresetValueFor, presetDisplayName, populateSitePresetSelect, renderSiteToggles, renderCost, readSiteSettings, saveSiteFlag, loadPresetIndex };
