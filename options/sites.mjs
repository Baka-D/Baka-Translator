// Settings-page sites.
import { t, FEEDBACK_CLEAR_MS, KEYS, state, ui } from './context.mjs';
import { presetDisplayName } from './presets.mjs';
import { isObject, setFeedback } from './utils.mjs';
import { patchSiteSettings, updateSiteSettings } from '../shared/site-settings.mjs';

/* ---------- 站点设置 ---------- */

export function normalizeSiteHost(raw) {
  const text = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
  if (!text) return { ok: false, message: t('opt_site_domain_required') };
  const fullUrl = /^https?:\/\//.test(text);
  let host;
  try {
    const url = new URL(fullUrl ? text : `http://${text}`);
    if (!fullUrl && (url.username || url.password)) throw new Error('INVALID_HOST');
    host = url.hostname;
  } catch (_error) {
    return { ok: false, message: t(fullUrl ? 'opt_site_url_invalid' : 'opt_site_domain_invalid') };
  }
  const isIp = host.startsWith('[') || /^(?:\d{1,3}\.){3}\d{1,3}$/.test(host);
  const isDomain =
    /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/.test(host);
  if (host === 'localhost' || isIp || isDomain) return { ok: true, host };
  return { ok: false, message: t('opt_site_domain_invalid') };
}

export async function saveSiteSettings(host, change, message) {
  try {
    const { settings, changed } = await updateSiteSettings(KEYS.SITE_SETTINGS, host, change);
    state.siteSettings = settings;
    renderSiteSettings();
    if (changed) {
      setFeedback(ui.siteFeedback, message, 'success', FEEDBACK_CLEAR_MS);
    } else {
      setFeedback(ui.siteFeedback, t('opt_site_exists', [host]), 'warning');
    }
    return changed;
  } catch (_error) {
    renderSiteSettings();
    setFeedback(ui.siteFeedback, t('opt_site_save_failed'), 'error');
    return false;
  }
}

/** Rows are rebuilt on every change: put the keyboard back on the same control. */
function restoreSiteFocus(hosts, host, role) {
  // A removed row hands focus to the next one in the sorted list.
  const target = hosts.includes(host) ? host : hosts.find((other) => other > host);
  const control = target
    ? ui.siteList.querySelector(`[data-host="${CSS.escape(target)}"] [data-role="${role}"]`)
    : null;
  (control || ui.siteHostInput)?.focus();
}

export function renderSiteSettings() {
  if (!ui.siteList) return;
  const all = isObject(state.siteSettings) ? state.siteSettings : {};
  const hosts = Object.keys(all).sort();
  const active = document.activeElement;
  const focusRole = active && ui.siteList.contains(active) ? active.dataset.role : '';
  const focusHost = focusRole ? active.closest('.site-row')?.dataset.host : '';
  ui.siteList.textContent = '';
  if (ui.siteEmptyHint) ui.siteEmptyHint.hidden = hosts.length > 0;
  const presetMetas =
    state.presetIndex && Array.isArray(state.presetIndex.presets) ? state.presetIndex.presets : [];
  const followLabel = t('opt_site_follow_global', [presetDisplayName(state.presetId)]);

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
    presetSelect.setAttribute('aria-label', t('opt_site_preset_aria', [host]));
    const followOption = document.createElement('option');
    followOption.value = '';
    followOption.textContent = followLabel;
    presetSelect.appendChild(followOption);
    for (const meta of presetMetas) {
      const option = document.createElement('option');
      option.value = meta.id;
      option.textContent = presetDisplayName(meta.id);
      presetSelect.appendChild(option);
    }
    presetSelect.value = presetMetas.some((meta) => meta.id === sitePresetId) ? sitePresetId : '';
    presetSelect.addEventListener('change', () => {
      const chosen = presetSelect.value;
      void saveSiteSettings(
        host,
        (previous) => patchSiteSettings(previous, { presetId: chosen }, chosen ? [] : ['presetId']),
        chosen
          ? t('opt_site_preset_saved', [host, presetDisplayName(chosen)])
          : t('opt_site_preset_follow_saved', [host])
      );
    });
    presetWrap.appendChild(presetSelect);

    const polishLabel = document.createElement('label');
    polishLabel.className = 'site-toggle site-toggle-polish';
    const polishInput = document.createElement('input');
    polishInput.type = 'checkbox';
    polishInput.checked = polish;
    polishInput.dataset.role = 'site-polish';
    polishInput.setAttribute('aria-label', t('opt_site_polish_aria', [host]));
    const polishText = document.createElement('span');
    polishText.textContent = t('opt_polish_label');
    polishLabel.appendChild(polishInput);
    polishLabel.appendChild(polishText);
    polishInput.addEventListener('change', () => {
      const checked = polishInput.checked === true;
      void saveSiteSettings(host, (previous) => patchSiteSettings(previous, { polish: checked }),
        t(checked ? 'opt_site_polish_on' : 'opt_site_polish_off', [host]));
    });

    const preLabel = document.createElement('label');
    preLabel.className = 'site-toggle site-toggle-pretranslate';
    const preInput = document.createElement('input');
    preInput.type = 'checkbox';
    preInput.checked = pretranslate;
    preInput.dataset.role = 'site-pretranslate';
    preInput.setAttribute('aria-label', t('opt_site_pretranslate_aria', [host]));
    const preText = document.createElement('span');
    preText.textContent = t('opt_pretranslate_label');
    preLabel.appendChild(preInput);
    preLabel.appendChild(preText);
    preInput.addEventListener('change', () => {
      const checked = preInput.checked === true;
      void saveSiteSettings(host, (previous) => patchSiteSettings(previous, { pretranslate: checked }),
        t(checked ? 'opt_site_pretranslate_on' : 'opt_site_pretranslate_off', [host]));
    });

    const removeButton = document.createElement('button');
    removeButton.type = 'button';
    removeButton.className = 'button button-ghost-danger site-remove';
    removeButton.textContent = t('opt_remove');
    removeButton.dataset.role = 'site-remove';
    removeButton.setAttribute('aria-label', t('opt_site_remove_aria', [host]));
    removeButton.addEventListener('click', () => {
      void saveSiteSettings(host, () => null, t('opt_site_removed', [host]));
    });

    row.appendChild(hostEl);
    row.appendChild(presetWrap);
    row.appendChild(polishLabel);
    row.appendChild(preLabel);
    row.appendChild(removeButton);
    ui.siteList.appendChild(row);
  }
  if (focusHost) restoreSiteFocus(hosts, focusHost, focusRole);
}

export function handleAddSite() {
  const validation = normalizeSiteHost(ui.siteHostInput.value);
  if (!validation.ok) {
    setFeedback(ui.siteFeedback, validation.message, 'error');
    ui.siteHostInput.focus();
    return;
  }
  const { host } = validation;
  const typed = ui.siteHostInput.value;
  void saveSiteSettings(host,
    (previous) => previous === undefined ? patchSiteSettings(null, {}) : undefined,
    t('opt_site_added', [host])
  ).then((saved) => {
    if (saved && ui.siteHostInput.value === typed) ui.siteHostInput.value = '';
  });
}
