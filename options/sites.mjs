// Settings-page sites.
import { FEEDBACK_CLEAR_MS, KEYS, state, ui } from './context.mjs';
import { presetDisplayName } from './presets.mjs';
import { isObject, persist, setFeedback } from './utils.mjs';

/* ---------- 站点设置 ---------- */

export function normalizeSiteHost(raw) {
  let text = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
  if (!text) return { ok: false, message: '请输入站点域名，例如 example.com。' };
  if (/^https?:\/\//.test(text)) {
    try {
      text = new URL(text).hostname.toLowerCase();
    } catch (_error) {
      return { ok: false, message: '站点地址格式不正确。' };
    }
  }
  if (text.includes('/')) text = text.split('/')[0];
  if (text.includes(':')) text = text.split(':')[0];
  if (!text) return { ok: false, message: '请输入站点域名，例如 example.com。' };
  if (text === 'localhost') return { ok: true, host: text };
  const isIp = /^(?:\d{1,3}\.){3}\d{1,3}$/.test(text);
  const isDomain =
    /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/.test(text);
  if (!isIp && !isDomain) {
    return { ok: false, message: '域名格式不正确，例如 example.com 或 sub.example.com。' };
  }
  return { ok: true, host: text };
}

export function siteSettingsWith(host, patch) {
  const all = isObject(state.siteSettings) ? Object.assign({}, state.siteSettings) : {};
  const currentValue = all[host];
  const current = isObject(currentValue)
    ? currentValue
    : typeof currentValue === 'boolean'
      ? { polish: currentValue }
      : {};
  all[host] = Object.assign({ polish: false, pretranslate: false }, current, patch || {});
  return all;
}

export async function saveSiteSettings(next, message) {
  try {
    await persist({ [KEYS.SITE_SETTINGS]: next });
    state.siteSettings = next;
    renderSiteSettings();
    if (message) setFeedback(ui.siteFeedback, message, 'success', FEEDBACK_CLEAR_MS);
    return true;
  } catch (_error) {
    setFeedback(ui.siteFeedback, '保存站点设置失败，请重试。', 'error');
    return false;
  }
}

export function renderSiteSettings() {
  if (!ui.siteList) return;
  const all = isObject(state.siteSettings) ? state.siteSettings : {};
  const hosts = Object.keys(all).sort();
  ui.siteList.textContent = '';
  if (ui.siteEmptyHint) ui.siteEmptyHint.hidden = hosts.length > 0;
  const presetMetas =
    state.presetIndex && Array.isArray(state.presetIndex.presets) ? state.presetIndex.presets : [];
  const followLabel = `跟随全局（当前 ${presetDisplayName(state.presetId)}）`;

  for (const host of hosts) {
    const value = all[host];
    const polish = typeof value === 'boolean' ? value : Boolean(value && value.polish === true);
    const pretranslate = Boolean(value && typeof value === 'object' && value.pretranslate === true);
    const sitePresetId =
      value && typeof value === 'object' && typeof value.presetId === 'string'
        ? value.presetId.trim()
        : '';

    const row = document.createElement('div');
    row.className = 'site-row';
    row.dataset.host = host;

    const hostEl = document.createElement('span');
    hostEl.className = 'site-host';
    hostEl.textContent = host;
    hostEl.title = host;

    const presetWrap = document.createElement('span');
    presetWrap.className = 'select-wrap site-preset-wrap';
    const presetSelect = document.createElement('select');
    presetSelect.className = 'select site-preset-select';
    presetSelect.dataset.role = 'site-preset';
    presetSelect.setAttribute('aria-label', `为 ${host} 选择提示词预设`);
    const followOption = document.createElement('option');
    followOption.value = '';
    followOption.textContent = followLabel;
    presetSelect.appendChild(followOption);
    for (const meta of presetMetas) {
      const option = document.createElement('option');
      option.value = meta.id;
      option.textContent = meta.name;
      presetSelect.appendChild(option);
    }
    presetSelect.value = presetMetas.some((meta) => meta.id === sitePresetId) ? sitePresetId : '';
    presetSelect.addEventListener('change', () => {
      const chosen = presetSelect.value;
      const next = siteSettingsWith(host, chosen ? { presetId: chosen } : {});
      if (!chosen) delete next[host].presetId;
      void saveSiteSettings(
        next,
        chosen
          ? `${host} 的提示词预设已设为 ${presetDisplayName(chosen)}。`
          : `${host} 的提示词预设已改为跟随全局。`
      );
    });
    presetWrap.appendChild(presetSelect);

    const polishLabel = document.createElement('label');
    polishLabel.className = 'site-toggle site-toggle-polish';
    const polishInput = document.createElement('input');
    polishInput.type = 'checkbox';
    polishInput.checked = polish;
    polishInput.dataset.role = 'site-polish';
    polishInput.setAttribute('aria-label', `为 ${host} 开启整页润色`);
    const polishText = document.createElement('span');
    polishText.textContent = '润色';
    polishLabel.appendChild(polishInput);
    polishLabel.appendChild(polishText);
    polishInput.addEventListener('change', () => {
      const next = siteSettingsWith(host, { polish: polishInput.checked === true });
      void saveSiteSettings(next, `${host} 的润色已${polishInput.checked ? '开启' : '关闭'}。`);
    });

    const preLabel = document.createElement('label');
    preLabel.className = 'site-toggle site-toggle-pretranslate';
    const preInput = document.createElement('input');
    preInput.type = 'checkbox';
    preInput.checked = pretranslate;
    preInput.dataset.role = 'site-pretranslate';
    preInput.setAttribute('aria-label', `为 ${host} 开启预翻译下一章`);
    const preText = document.createElement('span');
    preText.textContent = '预翻译';
    preLabel.appendChild(preInput);
    preLabel.appendChild(preText);
    preInput.addEventListener('change', () => {
      const next = siteSettingsWith(host, { pretranslate: preInput.checked === true });
      void saveSiteSettings(next, `${host} 的预翻译已${preInput.checked ? '开启' : '关闭'}。`);
    });

    const removeButton = document.createElement('button');
    removeButton.type = 'button';
    removeButton.className = 'button button-ghost-danger site-remove';
    removeButton.textContent = '移除';
    removeButton.setAttribute('aria-label', `移除 ${host} 的站点设置`);
    removeButton.addEventListener('click', () => {
      const next = Object.assign({}, state.siteSettings);
      delete next[host];
      void saveSiteSettings(next, `已移除站点设置：${host}。`);
    });

    row.appendChild(hostEl);
    row.appendChild(presetWrap);
    row.appendChild(polishLabel);
    row.appendChild(preLabel);
    row.appendChild(removeButton);
    ui.siteList.appendChild(row);
  }
}

export function handleAddSite() {
  const validation = normalizeSiteHost(ui.siteHostInput.value);
  if (!validation.ok) {
    setFeedback(ui.siteFeedback, validation.message, 'error');
    ui.siteHostInput.focus();
    return;
  }
  if (Object.prototype.hasOwnProperty.call(state.siteSettings, validation.host)) {
    setFeedback(ui.siteFeedback, `站点 ${validation.host} 已在列表中。`, 'warning');
    return;
  }
  const next = siteSettingsWith(validation.host, { polish: false, pretranslate: false });
  void saveSiteSettings(next, `已添加站点：${validation.host}。`).then((saved) => {
    if (saved && ui.siteHostInput) ui.siteHostInput.value = '';
  });
}
