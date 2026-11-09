// Settings-page model names the user adds to a provider, built-in ones included.
import { FEEDBACK_CLEAR_MS, KEYS, MSG, modelsTools, visionTools, state, ui } from './context.mjs';
import { setKeyBusy, validateProviderKey } from './keys.mjs';
import { applyCustomProviders, renderModelArea } from './model-selection.mjs';
import { providerKeyFor } from './models.mjs';
import { selectedProvider } from './providers.mjs';
import { persist, restoreFocus, sendMessage, setFeedback, storedModelIds } from './utils.mjs';

function modelItem(provider, model) {
  const item = document.createElement('li');
  item.className = 'provider-model-item';
  const name = document.createElement('span');
  name.className = 'provider-model-name';
  name.textContent = model.model || model.name;
  item.append(name);
  if (model.visionUnsupported) {
    const retry = document.createElement('button');
    retry.type = 'button';
    retry.className = 'button button-secondary button-compact';
    retry.textContent = '重试图片';
    retry.dataset.visionRetry = model.id;
    retry.disabled = state.busy || state.customBusy;
    retry.setAttribute('aria-label', `允许 ${model.model} 重新尝试图片翻译`);
    retry.addEventListener('click', () => void handleRetryVision(provider, model));
    item.append(retry);
  }
  if (model.userAdded) {
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'button button-ghost-danger button-compact';
    remove.textContent = '移除';
    remove.disabled = state.busy || state.customBusy;
    remove.setAttribute('aria-label', `移除模型 ${model.model}`);
    remove.addEventListener('click', () => void handleRemoveModel(provider.id, model.model));
    item.append(remove);
  }
  return item;
}

export function renderProviderModels(provider, switched) {
  if (!ui.providerModelFields) return;
  ui.providerModelFields.hidden = !provider;
  if (switched) {
    ui.userModelInput.value = '';
    setFeedback(ui.providerModelFeedback, '');
  }
  if (!provider) return;
  const busy = state.busy || state.customBusy;
  ui.fetchProviderModelsButton.disabled = busy || !provider.endpoint;
  ui.fetchProviderModelsButton.setAttribute('aria-label', `获取 ${provider.name || provider.id} 可用模型`);
  ui.addUserModelButton.disabled = busy;
  ui.userModelInput.disabled = busy;
  const models = modelsTools.listModels(state.registry, provider.id);
  ui.providerModelList.replaceChildren(...models.map((model) => modelItem(provider, model)));
}

/** Re-reads storage first: another options tab may have changed the names. */
async function commitUserModels(change) {
  const values = await chrome.storage.local.get([KEYS.USER_MODELS]);
  const next = modelsTools.normalizeUserModels(values[KEYS.USER_MODELS]);
  const result = change(next);
  await persist({ [KEYS.USER_MODELS]: next });
  state.userModels = next;
  applyCustomProviders();
  renderModelArea();
  return result;
}

export async function handleRetryVision(provider, model) {
  if (state.busy || state.customBusy || !visionTools) return;
  const previous = state.visionCapabilities;
  setKeyBusy(true);
  try {
    const response = await sendMessage({
      type: MSG.RESET_VISION_CAPABILITY, providerId: provider.id, modelName: model.model
    });
    if (!response.ok) throw new Error('VISION_RESET_FAILED');
    if (state.visionCapabilities === previous) {
      state.visionCapabilities = visionTools.normalizeCache(response.visionCapabilities);
    }
    applyCustomProviders();
    renderModelArea();
    setFeedback(ui.providerModelFeedback, `已允许 ${model.model} 重新尝试图片翻译，下次使用时会重新确认能力。`, 'success');
  } catch (_error) {
    setFeedback(ui.providerModelFeedback, '未能恢复图片翻译，请重试。', 'error');
  } finally {
    setKeyBusy(false);
    // The list was rebuilt; the retry button is new, or gone once the retry is allowed.
    const retry = [...ui.providerModelList.querySelectorAll('[data-vision-retry]')]
      .find((button) => button.dataset.visionRetry === model.id);
    restoreFocus(retry, ui.userModelInput);
  }
}

export async function handleFetchModels() {
  if (state.busy || state.customBusy) return;
  const provider = selectedProvider();
  if (!provider) return;
  const rawKey = ui.apiKeyInput.value.trim();
  if (rawKey) {
    const validation = validateProviderKey(provider, rawKey);
    if (!validation.ok) {
      setFeedback(ui.providerModelFeedback, validation.message, 'error');
      ui.apiKeyInput.focus();
      return;
    }
  } else if (provider.apiKeyRequired !== false && !providerKeyFor(provider.id)) {
    setFeedback(ui.providerModelFeedback, '请先输入或保存该服务商的 API Key。', 'error');
    ui.apiKeyInput.focus();
    return;
  }

  ui.fetchProviderModelsButton.textContent = '正在获取…';
  ui.fetchProviderModelsButton.setAttribute('aria-busy', 'true');
  setKeyBusy(true);
  setFeedback(ui.providerModelFeedback, '正在获取模型列表…', 'muted');
  try {
    const response = await sendMessage({
      type: MSG.FETCH_MODELS, providerId: provider.id, ...(rawKey ? { apiKey: rawKey } : {})
    });
    if (!response.ok) {
      setFeedback(ui.providerModelFeedback, response.error?.message || '获取模型失败，请重试。', 'error');
      return;
    }
    const names = modelsTools.normalizeUserModels({ [provider.id]: response.models })[provider.id] || [];
    if (names.length === 0) {
      setFeedback(ui.providerModelFeedback, '没有获取到适合文本翻译的模型，已有列表已保留。', 'warning');
      return;
    }
    const builtins = modelsTools.listModels(state.registry, provider.id).filter((model) => !model.userAdded);
    let skipped = 0;
    const added = await commitUserModels((next) => {
      const existing = next[provider.id] || [];
      const seen = new Set([...builtins.map((model) => model.model), ...existing]);
      const additions = names.filter((name) => !seen.has(name));
      const room = Math.max(0, modelsTools.MAX_USER_MODELS - existing.length);
      skipped = additions.length - Math.min(additions.length, room);
      next[provider.id] = existing.concat(additions.slice(0, room));
      if (next[provider.id].length === 0) delete next[provider.id];
      return Math.min(additions.length, room);
    });
    const capped = Array.isArray(response.models) && response.models.length > modelsTools.MAX_USER_MODELS;
    const limitHint = skipped || capped ? `已达本次导入或列表上限（${modelsTools.MAX_USER_MODELS} 个），部分模型未添加。` : '';
    setFeedback(ui.providerModelFeedback,
      `已获取 ${names.length} 个模型，新增 ${added} 个；可在「高级 → 模型行为」选择。${limitHint}`,
      limitHint ? 'warning' : 'success');
  } catch (_error) {
    setFeedback(ui.providerModelFeedback, '保存模型列表失败，请重试；已有列表已保留。', 'error');
  } finally {
    ui.fetchProviderModelsButton.textContent = '获取模型';
    ui.fetchProviderModelsButton.removeAttribute('aria-busy');
    setKeyBusy(false);
  }
}

export async function handleAddModel() {
  if (state.busy || state.customBusy) return;
  const provider = selectedProvider();
  if (!provider) return;
  const name = ui.userModelInput.value.trim();
  const models = modelsTools.listModels(state.registry, provider.id);
  let problem = '';
  if (!name) problem = '请填写发送给接口的模型名称。';
  else if (/\s/.test(name)) problem = '模型名称不能包含空白字符。';
  else if (name.length > 200) problem = '模型名称过长，请检查输入。';
  else if (models.some((model) => model.model === name)) problem = '该服务商已有这个模型。';
  else if ((state.userModels[provider.id] || []).length >= modelsTools.MAX_USER_MODELS) {
    problem = `每个服务商最多添加 ${modelsTools.MAX_USER_MODELS} 个模型。`;
  }
  if (problem) {
    setFeedback(ui.providerModelFeedback, problem, 'error');
    ui.userModelInput.focus();
    return;
  }
  try {
    await commitUserModels((next) => {
      next[provider.id] = (next[provider.id] || []).concat(name);
    });
    ui.userModelInput.value = '';
    setFeedback(ui.providerModelFeedback, `已添加 ${name}，可在「高级 → 模型行为」选择。`, 'success', FEEDBACK_CLEAR_MS);
  } catch (_error) {
    setFeedback(ui.providerModelFeedback, '添加模型失败，请重试。', 'error');
  }
}

export async function handleRemoveModel(providerIdValue, name) {
  if (state.busy || state.customBusy) return;
  const id = modelsTools.userModelId(providerIdValue, name);
  try {
    if ([state.modelId, state.polishModelIdRaw, ...await storedModelIds()].includes(id)) {
      setFeedback(ui.providerModelFeedback, `${name} 正在使用中，请先在「高级 → 模型行为」切换到其他模型。`, 'warning');
      return;
    }
    await commitUserModels((next) => {
      next[providerIdValue] = (next[providerIdValue] || []).filter((item) => item !== name);
      if (next[providerIdValue].length === 0) delete next[providerIdValue];
    });
    setFeedback(ui.providerModelFeedback, `已移除 ${name}。`, 'success', FEEDBACK_CLEAR_MS);
    ui.userModelInput.focus();
  } catch (_error) {
    setFeedback(ui.providerModelFeedback, '移除模型失败，请重试。', 'error');
  }
}
