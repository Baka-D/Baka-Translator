// Settings-page user-added OpenAI-compatible providers (add, edit, rename, delete).
import { CONFIRM_RESET_MS, FEEDBACK_CLEAR_MS, KEYS, LOCAL_HTTP_HOSTS, modelsTools, state, ui } from './context.mjs';
import { applyCustomProviders, renderModelArea } from './model-selection.mjs';
import { isCustomProvider } from './models.mjs';
import { focusCurrentProvider, providerUses, renderProviders, selectedProvider } from './providers.mjs';
import { persist, setFeedback, storedModelIds } from './utils.mjs';

/* ---------- 自定义 OpenAI 兼容接口 ---------- */

export function setCustomBusy(busy) {
  state.customBusy = Boolean(busy);
  const disabled = state.customBusy;
  for (const input of [ui.providerNameInput, ui.customEndpointInput, ui.customModelInput]) {
    if (input) input.disabled = disabled;
  }
  ui.saveCustomProviderButton.disabled = disabled;
  if (ui.deleteProviderButton) ui.deleteProviderButton.disabled = disabled;
  if (state.customBusy) ui.saveCustomProviderButton.setAttribute('aria-busy', 'true');
  else ui.saveCustomProviderButton.removeAttribute('aria-busy');
}

export function validateCustomProviderInput(endpointRaw, modelRaw) {
  const endpointText = typeof endpointRaw === 'string' ? endpointRaw.trim() : '';
  const modelText = typeof modelRaw === 'string' ? modelRaw.trim() : '';
  if (!endpointText) return { ok: false, message: '请填写自定义接口的 base URL。' };
  const normalized =
    modelsTools && typeof modelsTools.normalizeEndpoint === 'function'
      ? modelsTools.normalizeEndpoint(endpointText)
      : '';
  if (!normalized) return { ok: false, message: '接口地址必须是有效的 http(s) URL。' };
  let url;
  try {
    url = new URL(normalized);
  } catch (_error) {
    return { ok: false, message: '接口地址必须是有效的 http(s) URL。' };
  }
  if (url.protocol === 'http:') {
    if (!LOCAL_HTTP_HOSTS.includes(url.hostname.toLowerCase())) {
      return { ok: false, message: 'http 接口仅支持 localhost / 127.0.0.1，请改用 https。' };
    }
  } else if (url.protocol !== 'https:') {
    return { ok: false, message: '接口地址必须是 http(s) URL。' };
  }
  if (!modelText) return { ok: false, message: '请填写发送给接口的模型名称。' };
  if (modelText.length > 200) return { ok: false, message: '模型名称过长，请检查输入。' };
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
  }
  ui.saveCustomProviderButton.textContent = state.providerDraft ? '添加服务商' : '保存服务商';
  if (ui.deleteProviderButton) {
    ui.deleteProviderButton.hidden = state.providerDraft;
    if (state.confirmDeleteProvider !== (provider && provider.id)) {
      ui.deleteProviderButton.textContent = '删除服务商';
      ui.deleteProviderButton.classList.remove('is-confirming');
    }
  }
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
  return index === 1 ? '自定义接口' : `自定义接口 ${index}`;
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
    setFeedback(ui.customProviderFeedback, `最多添加 ${modelsTools.MAX_CUSTOM_PROVIDERS} 个自定义服务商。`, 'error');
    return;
  }
  const validation = validateCustomProviderInput(ui.customEndpointInput.value, ui.customModelInput.value);
  if (!validation.ok) {
    setFeedback(ui.customProviderFeedback, validation.message, 'error');
    return;
  }

  setCustomBusy(true);
  setFeedback(ui.customProviderFeedback, '', '');
  let saved = null;
  let moved = false;
  try {
    await refreshCustomProviders();
    if (!adding && !storedEntry(current.id)) {
      // Writing it back would undo the other tab's delete, and its key is already gone.
      setCustomBusy(false);
      applyCustomProviders();
      renderModelArea();
      setFeedback(ui.keyFeedback, `${current.name} 已在其他设置页删除，本次修改未保存。`, 'warning');
      return;
    }
    const id = adding ? nextCustomId() : current.id;
    const previous = adding ? null : storedEntry(id);
    moved = Boolean(previous?.endpoint) && new URL(previous.endpoint).origin !== new URL(validation.endpoint).origin;
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
    setFeedback(ui.customProviderFeedback, '保存服务商失败，请重试。', 'error');
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
    adding ? `已添加 ${saved.name}，可继续填写 API Key。`
      : moved ? `已保存 ${saved.name}。接口地址换了主机，原 API Key 已清除，请重新填写。` : `已保存 ${saved.name}。`,
    'success',
    FEEDBACK_CLEAR_MS
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
      `${provider.name} 正被${uses.join('、') || '其他设置页'}使用，请先在「高级 → 模型行为」切换到其他服务商。`,
      'warning'
    );
    return;
  }
  if (state.confirmDeleteProvider !== provider.id) {
    state.confirmDeleteProvider = provider.id;
    ui.deleteProviderButton.textContent = '确认删除？';
    ui.deleteProviderButton.classList.add('is-confirming');
    setFeedback(ui.customProviderFeedback, '再次点击“确认删除？”将删除该服务商及其 API Key。', 'warning');
    window.clearTimeout(state.deleteConfirmTimer);
    state.deleteConfirmTimer = window.setTimeout(() => {
      state.deleteConfirmTimer = 0;
      if (state.confirmDeleteProvider !== provider.id) return;
      state.confirmDeleteProvider = '';
      setFeedback(ui.customProviderFeedback, '');
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
    setFeedback(ui.customProviderFeedback, '删除服务商失败，请重试。', 'error');
  } finally {
    setCustomBusy(false);
  }
  if (!deleted) return;
  state.selectedProviderId = '';
  renderModelArea();
  focusCurrentProvider();
  setFeedback(ui.keyFeedback, `已删除 ${provider.name}。`, 'success', FEEDBACK_CLEAR_MS);
}
