// Settings-page API Key controls for the provider shown in the detail panel.
import { CONFIRM_RESET_MS, FEEDBACK_CLEAR_MS, KEYS, KEY_MAX_LENGTH, KEY_MIN_LENGTH, MSG, state, ui, t } from './context.mjs';
import { isCustomProvider, providerKeyFor } from './models.mjs';
import { getProvider, keyRequired, providerDisplayName, providerInStorageMatches, providerPanelMatches, renderProviders, selectedProvider } from './providers.mjs';
import { maskKey, normalizeProviderKeys, persist, restoreFocus, sendMessage, setFeedback } from './utils.mjs';
import { withStorageLock } from '../shared/storage-lock.mjs';

/* ---------- 当前服务商的 API Key ---------- */

function providerName(provider) {
  return providerDisplayName(provider);
}

export function renderKeyPanel(provider) {
  const draft = !provider;
  if (ui.providerKeyFields) ui.providerKeyFields.hidden = draft;
  if (ui.providerDraftHint) ui.providerDraftHint.hidden = !(draft && state.providerDraft);
  if (draft) {
    ui.keyStatus.textContent = state.providerDraft ? t('opt_key_unsaved') : t('opt_key_registry_unavailable');
    ui.keyStatus.dataset.tone = state.providerDraft ? 'muted' : 'error';
    if (ui.testConnectionButton) ui.testConnectionButton.disabled = true;
    return;
  }
  const busy = state.busy || state.customBusy;
  const key = providerKeyFor(provider.id);
  const required = keyRequired(provider);
  const name = providerName(provider);

  const custom = isCustomProvider(provider);
  if (ui.providerKeyLabel) ui.providerKeyLabel.textContent =
    (!custom && provider.apiKeyLabel) || t('opt_key_label', [name]);
  ui.apiKeyInput.placeholder = (!custom && provider.apiKeyPlaceholder) || (required ? 'sk-...' : t('opt_key_optional'));
  if (ui.apiKeyHint) {
    ui.apiKeyHint.textContent = required
      ? t('opt_key_saved_hidden')
      : t('opt_key_optional_hint');
  }
  if (key) {
    ui.keyStatus.textContent = t('opt_key_saved_masked', [maskKey(key)]);
    ui.keyStatus.dataset.tone = 'success';
  } else {
    ui.keyStatus.textContent = required ? t('opt_key_missing') : t('opt_key_not_required');
    ui.keyStatus.dataset.tone = 'muted';
  }

  ui.saveKeyButton.textContent = key ? t('opt_key_replace') : t('opt_key_save');
  ui.saveKeyButton.setAttribute('aria-label', t(key ? 'opt_key_replace_named' : 'opt_key_save_named', [name]));
  ui.saveKeyButton.disabled = busy;
  ui.clearKeyButton.hidden = !key;
  ui.clearKeyButton.disabled = busy;
  if (state.confirmClear !== provider.id) {
    ui.clearKeyButton.classList.remove('is-confirming');
    ui.clearKeyButton.textContent = t('opt_key_clear');
    ui.clearKeyButton.setAttribute('aria-label', t('opt_key_clear_named', [name]));
  }
  ui.apiKeyInput.disabled = busy;
  ui.toggleKeyVisibility.disabled = busy;
  if (ui.testConnectionButton) {
    ui.testConnectionButton.setAttribute('aria-label', t('opt_key_test_named', [name]));
    ui.testConnectionButton.disabled = busy || (isCustomProvider(provider) && !provider.endpoint);
  }
}

export function validateProviderKey(provider, raw) {
  const required = keyRequired(provider);
  const key = typeof raw === 'string' ? raw.trim() : '';
  if (!key) {
    return {
      ok: false,
      message: required
        ? t('opt_key_enter_first')
        : t('opt_key_optional_clear_hint')
    };
  }
  if (key.length > KEY_MAX_LENGTH) return { ok: false, message: t('opt_key_too_long') };
  if (isCustomProvider(provider)) {
    if (/\s/.test(key)) {
      return { ok: false, message: t('opt_key_no_whitespace') };
    }
    if (!/^[\x21-\x7e]+$/.test(key)) {
      return { ok: false, message: t('opt_key_invalid_characters') };
    }
    return { ok: true, key };
  }
  const prefix = (provider && provider.apiKeyPrefix) || '';
  if (!key.startsWith(prefix)) return { ok: false, message: t('opt_key_prefix_required', [prefix]) };
  if (key.length < KEY_MIN_LENGTH) {
    return { ok: false, message: t('opt_key_too_short') };
  }
  if (!/^[A-Za-z0-9_.-]+$/.test(key)) {
    return { ok: false, message: t('opt_key_invalid_characters') };
  }
  return { ok: true, key };
}

let busyFocus = null;

export function setKeyBusy(busy) {
  state.busy = Boolean(busy);
  if (state.busy) busyFocus = document.activeElement;
  if (state.busy) ui.saveKeyButton.setAttribute('aria-busy', 'true');
  else ui.saveKeyButton.removeAttribute('aria-busy');
  renderProviders();
  if (state.busy) return;
  restoreFocus(busyFocus);
  busyFocus = null;
}

function persistProviderKey(provider, key) {
  return withStorageLock(KEYS.CUSTOM_PROVIDERS, async () => {
    const values = await chrome.storage.local.get([KEYS.PROVIDER_KEYS, KEYS.CUSTOM_PROVIDERS, KEYS.CUSTOM_PROVIDER]);
    if (!providerInStorageMatches(provider, values)) return false;
    const nextKeys = normalizeProviderKeys(values[KEYS.PROVIDER_KEYS] ?? state.providerKeys);
    if (key) nextKeys[provider.id] = key;
    else delete nextKeys[provider.id];
    const update = { [KEYS.PROVIDER_KEYS]: nextKeys };
    if (provider.id === 'deepseek') update[KEYS.API_KEY] = key;
    await persist(update);
    if (provider.id === 'deepseek') state.legacyApiKey = key;
    state.providerKeys = nextKeys;
    return true;
  });
}

export async function handleSaveKey() {
  if (state.busy || state.customBusy) return;
  const provider = selectedProvider();
  if (!provider) return;
  const validation = validateProviderKey(provider, ui.apiKeyInput.value);
  if (!validation.ok) {
    setFeedback(ui.keyFeedback, validation.message, 'error');
    ui.apiKeyInput.focus();
    return;
  }

  resetClearConfirm();
  setKeyBusy(true);
  setFeedback(ui.keyFeedback, t('opt_key_saving'), 'muted');
  try {
    if (!await persistProviderKey(provider, validation.key)) throw new Error('PROVIDER_CHANGED');
    if (!providerPanelMatches(provider)) return;
    ui.apiKeyInput.value = '';
    setKeyVisibility(false);
    setFeedback(ui.keyFeedback, t('opt_key_saved_named', [providerName(provider)]), 'success', FEEDBACK_CLEAR_MS);
  } catch (_error) {
    if (providerPanelMatches(provider)) setFeedback(ui.keyFeedback, t('opt_key_save_failed'), 'error');
  } finally {
    setKeyBusy(false);
  }
}

export function setKeyVisibility(visible) {
  if (!ui.apiKeyInput || !ui.toggleKeyVisibility) return;
  const name = providerName(selectedProvider());
  ui.apiKeyInput.type = visible ? 'text' : 'password';
  ui.toggleKeyVisibility.setAttribute('aria-pressed', visible ? 'true' : 'false');
  ui.toggleKeyVisibility.setAttribute('aria-label', t(visible ? 'opt_key_hide_named' : 'opt_key_show_named', [name]));
  ui.toggleKeyVisibility.textContent = visible ? t('opt_key_hide') : t('opt_key_show');
}

export function handleToggleKeyVisibility() {
  setKeyVisibility(ui.apiKeyInput.type !== 'text');
}

export function resetClearConfirm() {
  state.confirmClear = false;
  if (state.clearTimer) {
    window.clearTimeout(state.clearTimer);
    state.clearTimer = 0;
  }
  ui.clearKeyButton.classList.remove('is-confirming');
  ui.clearKeyButton.textContent = t('opt_key_clear');
  ui.clearKeyButton.setAttribute('aria-label', t('opt_key_clear_named', [providerName(selectedProvider())]));
}

export async function clearKey(providerIdValue) {
  const provider = getProvider(providerIdValue);
  if (!provider || state.busy || state.customBusy) return;
  resetClearConfirm();
  setKeyBusy(true);
  let cleared = false;
  try {
    cleared = await persistProviderKey(provider, '');
    if (!cleared) throw new Error('PROVIDER_CHANGED');
  } catch (_error) {
    if (providerPanelMatches(provider)) setFeedback(ui.keyFeedback, t('opt_key_clear_failed'), 'error');
  } finally {
    setKeyBusy(false);
  }
  if (!cleared || !providerPanelMatches(provider)) return;
  setFeedback(ui.keyFeedback, t('opt_key_cleared_named', [providerName(provider)]), 'success', FEEDBACK_CLEAR_MS);
  ui.saveKeyButton.focus();
}

export function handleClearKeyClick() {
  if (state.busy || state.customBusy) return;
  const provider = selectedProvider();
  if (!provider || !providerKeyFor(provider.id)) return;
  if (state.confirmClear !== provider.id) {
    resetClearConfirm();
    state.confirmClear = provider.id;
    ui.clearKeyButton.textContent = t('opt_key_confirm_clear');
    ui.clearKeyButton.classList.add('is-confirming');
    ui.clearKeyButton.setAttribute('aria-label', t('opt_key_confirm_clear_named', [providerName(provider)]));
    const warning = t('opt_key_clear_warning');
    setFeedback(ui.keyFeedback, warning, 'warning');
    state.clearTimer = window.setTimeout(() => {
      resetClearConfirm();
      // Leave any message written since, such as a test result, in place.
      if (ui.keyFeedback.textContent === warning) setFeedback(ui.keyFeedback, '');
    }, CONFIRM_RESET_MS);
    return;
  }
  void clearKey(provider.id);
}

export function testErrorMessage(error, provider) {
  const code = error && typeof error.code === 'string' ? error.code : 'UNKNOWN_ERROR';
  const base =
    error && typeof error.message === 'string' && error.message.trim()
      ? error.message.trim()
      : t('opt_key_test_failed');
  if (code === 'MISSING_API_KEY') return t('opt_key_test_missing_key', [providerName(provider)]);
  // A 403 message already names Key, region and model permission as causes.
  if (code === 'AUTH_FAILED' && error.status !== 403) return t('opt_key_test_auth_hint', [base]);
  if (code === 'BACKGROUND_UNAVAILABLE') return base;
  if (code === 'INVALID_SENDER') return t('opt_key_test_settings_only');
  return base;
}

export async function handleTestConnection() {
  if (state.busy || state.customBusy) return;
  const provider = selectedProvider();
  if (!provider) return;
  if (keyRequired(provider) && !providerKeyFor(provider.id)) {
    setFeedback(ui.keyFeedback, t('opt_key_test_save_first', [providerName(provider)]), 'warning');
    ui.apiKeyInput.focus();
    return;
  }
  // The test runs with the saved key, so a typed one would not be what gets tested.
  if (ui.apiKeyInput.value.trim()) {
    setFeedback(ui.keyFeedback, t('opt_key_test_unsaved'), 'warning');
    ui.apiKeyInput.focus();
    return;
  }

  setKeyBusy(true);
  setFeedback(ui.keyFeedback, t('opt_key_testing_named', [providerName(provider)]), 'muted');
  const response = await sendMessage({ type: MSG.TEST_CONNECTION, providerId: provider.id });
  setKeyBusy(false);
  if (!providerPanelMatches(provider)) return;

  if (!response || response.ok === false) {
    const error =
      response && response.error
        ? response.error
        : { code: 'UNKNOWN_ERROR', message: t('opt_key_test_failed') };
    setFeedback(ui.keyFeedback, testErrorMessage(error, provider), 'error');
    return;
  }

  const parts = [t('opt_key_test_success', [providerName(provider)])];
  if (typeof response.modelName === 'string' && response.modelName) parts.push(response.modelName);
  if (Number.isFinite(response.latencyMs)) parts.push(t('opt_key_test_latency', [Math.round(response.latencyMs)]));
  if (response.modelAvailable === true) parts.push(t('opt_key_model_available'));
  else if (response.modelAvailable === false) parts.push(t('opt_key_model_missing'));
  const tone = response.modelAvailable === false ? 'warning' : 'success';
  setFeedback(ui.keyFeedback, t('opt_key_test_result', [parts.join(' · ')]), tone);
}
