// Settings-page user-added OpenAI-compatible providers (add, edit, rename, delete).
import { CONFIRM_RESET_MS, FEEDBACK_CLEAR_MS, KEYS, LOCAL_HTTP_HOSTS, modelsTools, state, ui, t } from './context.mjs';
import { applyCustomProviders, renderModelArea } from './model-selection.mjs';
import { isCustomProvider, providerKeyFor } from './models.mjs';
import { focusCurrentProvider, providerUses, renderProviders, selectedProvider } from './providers.mjs';
import { persist, restoreFocus, setFeedback, storedModelIds } from './utils.mjs';

/* ---------- 自定义 OpenAI 兼容接口 ---------- */

let busyFocus = null;

export function setCustomBusy(busy) {
  state.customBusy = Boolean(busy);
  if (state.customBusy) busyFocus = document.activeElement;
  const disabled = state.customBusy;
  for (const input of [ui.providerNameInput, ui.customEndpointInput, ui.customModelInput]) {
    if (input) input.disabled = disabled;
  }
  ui.saveCustomProviderButton.disabled = disabled;
  if (ui.deleteProviderButton) ui.deleteProviderButton.disabled = disabled;
  if (state.customBusy) ui.saveCustomProviderButton.setAttribute('aria-busy', 'true');
  else ui.saveCustomProviderButton.removeAttribute('aria-busy');
  if (state.customBusy) return;
  restoreFocus(busyFocus);
  busyFocus = null;
}

export function validateCustomProviderInput(endpointRaw, modelRaw) {
  const endpointText = typeof endpointRaw === 'string' ? endpointRaw.trim() : '';
  const modelText = typeof modelRaw === 'string' ? modelRaw.trim() : '';
  if (!endpointText) return { ok: false, message: t('opt_provider_endpoint_required') };
  const normalized =
    modelsTools && typeof modelsTools.normalizeEndpoint === 'function'
      ? modelsTools.normalizeEndpoint(endpointText)
      : '';
  if (!normalized) return { ok: false, message: t('opt_provider_endpoint_invalid') };
  let url;
  try {
    url = new URL(normalized);
  } catch (_error) {
    return { ok: false, message: t('opt_provider_endpoint_invalid') };
  }
  if (url.protocol === 'http:') {
    if (!LOCAL_HTTP_HOSTS.includes(url.hostname.toLowerCase())) {
      return { ok: false, message: t('opt_provider_https_required') };
    }
  } else if (url.protocol !== 'https:') {
    return { ok: false, message: t('opt_provider_endpoint_protocol') };
  }
  if (!modelText) return { ok: false, message: t('opt_provider_model_required') };
  if (modelText.length > 200) return { ok: false, message: t('opt_provider_model_too_long') };
  return { ok: true, endpoint: normalized, model: modelText };
}

function storedEntry(providerIdValue) {
  return state.customProviders.find((entry) => entry.id === providerIdValue) || null;
}

/** Show the editable fields for a user-added provider (or a new draft). */
export function renderCustomFields(provider, switched) {
  if (!ui.customProviderFields) return;
  const editable = state.providerDraft || isCustomProvider(provider);
  ui.customProviderFields.hidden = !editable;
  if (!editable) return;
  // Prefill only when the panel switches provider, so re-renders keep unsaved typing.
  if (switched) {
    const entry = state.providerDraft ? null : storedEntry(provider.id);
    ui.providerNameInput.value = entry ? entry.name : '';
    ui.customEndpointInput.value = entry ? entry.endpoint : '';
    ui.customModelInput.value = entry ? entry.model : '';
    setFeedback(ui.customProviderFeedback, '');
    state.confirmMoveProvider = '';
  }
  const confirming = !state.providerDraft && state.confirmMoveProvider === (provider && provider.id);
  ui.saveCustomProviderButton.textContent = confirming ? t('opt_provider_confirm_save')
    : state.providerDraft ? t('opt_provider_add') : t('opt_provider_save');
  if (ui.deleteProviderButton) {
    ui.deleteProviderButton.hidden = state.providerDraft;
    if (state.confirmDeleteProvider !== (provider && provider.id)) {
      ui.deleteProviderButton.textContent = t('opt_provider_delete');
      ui.deleteProviderButton.classList.remove('is-confirming');
    }
  }
}

const MOVE_WARNING = t('opt_provider_move_warning');
const DELETE_WARNING = t('opt_provider_delete_warning');

/** An expired confirm must not erase a message written after its warning. */
function clearFeedbackIf(warning) {
  if (ui.customProviderFeedback.textContent === warning) setFeedback(ui.customProviderFeedback, '');
}

function resetMoveConfirm() {
  window.clearTimeout(state.moveConfirmTimer);
  state.moveConfirmTimer = 0;
  if (!state.confirmMoveProvider) return;
  state.confirmMoveProvider = '';
  ui.saveCustomProviderButton.textContent = t('opt_provider_save');
}

function hostMoved(previous, endpoint) {
  return Boolean(previous?.endpoint) && new URL(previous.endpoint).origin !== new URL(endpoint).origin;
}

function nextCustomId() {
  const taken = new Set(state.customProviders.map((entry) => entry.id));
  if (!taken.has('custom')) return 'custom';
  for (let index = 2; ; index += 1) {
    if (!taken.has(`custom-${index}`)) return `custom-${index}`;
  }
}

function defaultName(providerIdValue) {
  const index = providerIdValue === 'custom' ? 1 : Number(providerIdValue.split('-')[1]) || 1;
  return index === 1 ? t('opt_provider_default_name') : t('opt_provider_default_numbered_name', [index]);
}

/** Another options tab may have changed the list since this one loaded it. */
async function refreshCustomProviders() {
  const values = await chrome.storage.local.get([KEYS.CUSTOM_PROVIDERS, KEYS.CUSTOM_PROVIDER]);
  state.customProviders = modelsTools.normalizeCustomProviders(
    values[KEYS.CUSTOM_PROVIDERS], values[KEYS.CUSTOM_PROVIDER]
  );
}

async function commitCustomProviders(list, extraUpdate) {
  await persist({ [KEYS.CUSTOM_PROVIDERS]: list, ...(extraUpdate || {}) });
  state.customProviders = modelsTools.normalizeCustomProviders(list);
  applyCustomProviders();
}

export async function handleSaveCustomProvider() {
  if (state.customBusy) return;
  const adding = state.providerDraft;
  const current = selectedProvider();
  if (!adding && !isCustomProvider(current)) return;
  if (adding && state.customProviders.length >= modelsTools.MAX_CUSTOM_PROVIDERS) {
    setFeedback(ui.customProviderFeedback, t('opt_provider_limit', [modelsTools.MAX_CUSTOM_PROVIDERS]), 'error');
    return;
  }
  const validation = validateCustomProviderInput(ui.customEndpointInput.value, ui.customModelInput.value);
  if (!validation.ok) {
    resetMoveConfirm();
    setFeedback(ui.customProviderFeedback, validation.message, 'error');
    return;
  }
  // Moving to another host drops the saved key, so that save takes a second click.
  if (!adding && state.confirmMoveProvider !== current.id && providerKeyFor(current.id) &&
    hostMoved(storedEntry(current.id), validation.endpoint)) {
    state.confirmMoveProvider = current.id;
    ui.saveCustomProviderButton.textContent = t('opt_provider_confirm_save');
    setFeedback(ui.customProviderFeedback, MOVE_WARNING, 'warning');
    window.clearTimeout(state.moveConfirmTimer);
    state.moveConfirmTimer = window.setTimeout(() => {
      state.moveConfirmTimer = 0;
      if (state.confirmMoveProvider !== current.id) return;
      state.confirmMoveProvider = '';
      clearFeedbackIf(MOVE_WARNING);
      renderProviders();
    }, CONFIRM_RESET_MS);
    return;
  }
  resetMoveConfirm();

  setCustomBusy(true);
  setFeedback(ui.customProviderFeedback, '', '');
  let saved = null;
  let droppedKey = false;
  try {
    await refreshCustomProviders();
    if (!adding && !storedEntry(current.id)) {
      // Writing it back would undo the other tab's delete, and its key is already gone.
      setCustomBusy(false);
      applyCustomProviders();
      renderModelArea();
      setFeedback(ui.keyFeedback, t('opt_provider_deleted_elsewhere', [current.name]), 'warning');
      return;
    }
    const id = adding ? nextCustomId() : current.id;
    const previous = adding ? null : storedEntry(id);
    const moved = hostMoved(previous, validation.endpoint);
    const name = ui.providerNameInput.value.trim().slice(0, 60) || defaultName(id);
    const entry = { id, name, endpoint: validation.endpoint, model: validation.model };
    const list = adding
      ? state.customProviders.concat(entry)
      : state.customProviders.map((item) => (item.id === id ? entry : item));
    // A reused id must not inherit a key or model names left behind by an earlier provider.
    const nextKeys = Object.assign({}, state.providerKeys);
    const nextModels = Object.assign({}, state.userModels);
    if (adding) {
      delete nextKeys[id];
      delete nextModels[id];
      state.userModels = nextModels;
    }
    // A key belongs to the host it was issued by; a path change on the same host keeps it.
    droppedKey = moved && Boolean(nextKeys[id]);
    if (moved) delete nextKeys[id];
    await commitCustomProviders(
      list,
      adding
        ? { [KEYS.PROVIDER_KEYS]: nextKeys, [KEYS.USER_MODELS]: nextModels }
        : moved ? { [KEYS.PROVIDER_KEYS]: nextKeys } : undefined
    );
    if (adding || moved) state.providerKeys = nextKeys;
    saved = entry;
  } catch (_error) {
    setFeedback(ui.customProviderFeedback, t('opt_provider_save_failed'), 'error');
  } finally {
    setCustomBusy(false);
  }
  if (!saved) return;
  state.providerDraft = false;
  state.selectedProviderId = saved.id;
  state.shownProviderId = null;
  renderModelArea();
  setFeedback(
    ui.customProviderFeedback,
    adding ? t('opt_provider_added', [saved.name])
      : droppedKey ? t('opt_provider_saved_key_cleared', [saved.name]) : t('opt_provider_saved', [saved.name]),
    'success',
    droppedKey ? undefined : FEEDBACK_CLEAR_MS
  );
}

export async function handleDeleteProviderClick() {
  if (state.customBusy) return;
  const provider = selectedProvider();
  if (!isCustomProvider(provider)) return;
  const uses = providerUses(provider.id);
  const stored = (await storedModelIds()).map((id) => modelsTools.getModel(state.registry, id));
  if (uses.length > 0 || stored.some((model) => model && model.provider === provider.id)) {
    setFeedback(
      ui.customProviderFeedback,
      t('opt_provider_in_use', [provider.name, uses.join(t('opt_provider_usage_separator')) || t('opt_provider_other_settings')]),
      'warning'
    );
    return;
  }
  if (state.confirmDeleteProvider !== provider.id) {
    resetMoveConfirm();
    state.confirmDeleteProvider = provider.id;
    ui.deleteProviderButton.textContent = t('opt_provider_confirm_delete');
    ui.deleteProviderButton.classList.add('is-confirming');
    setFeedback(ui.customProviderFeedback, DELETE_WARNING, 'warning');
    window.clearTimeout(state.deleteConfirmTimer);
    state.deleteConfirmTimer = window.setTimeout(() => {
      state.deleteConfirmTimer = 0;
      if (state.confirmDeleteProvider !== provider.id) return;
      state.confirmDeleteProvider = '';
      clearFeedbackIf(DELETE_WARNING);
      renderProviders();
    }, CONFIRM_RESET_MS);
    return;
  }

  state.confirmDeleteProvider = '';
  window.clearTimeout(state.deleteConfirmTimer);
  setCustomBusy(true);
  let deleted = false;
  try {
    await refreshCustomProviders();
    const nextKeys = Object.assign({}, state.providerKeys);
    delete nextKeys[provider.id];
    const nextModels = Object.assign({}, state.userModels);
    delete nextModels[provider.id];
    state.userModels = nextModels;
    await commitCustomProviders(
      state.customProviders.filter((entry) => entry.id !== provider.id),
      { [KEYS.PROVIDER_KEYS]: nextKeys, [KEYS.USER_MODELS]: nextModels }
    );
    state.providerKeys = nextKeys;
    deleted = true;
  } catch (_error) {
    setFeedback(ui.customProviderFeedback, t('opt_provider_delete_failed'), 'error');
  } finally {
    setCustomBusy(false);
  }
  if (!deleted) return;
  state.selectedProviderId = '';
  renderModelArea();
  focusCurrentProvider();
  setFeedback(ui.keyFeedback, t('opt_provider_deleted', [provider.name]), 'success', FEEDBACK_CLEAR_MS);
}
