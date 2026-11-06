// Settings-page API Key controls for the provider shown in the detail panel.
import { CONFIRM_RESET_MS, FEEDBACK_CLEAR_MS, KEYS, KEY_MAX_LENGTH, KEY_MIN_LENGTH, MSG, state, ui } from './context.mjs';
import { isCustomProvider, providerKeyFor } from './models.mjs';
import { getProvider, keyRequired, renderProviders, selectedProvider } from './providers.mjs';
import { maskKey, persist, sendMessage, setFeedback } from './utils.mjs';

/* ---------- 当前服务商的 API Key ---------- */

function providerName(provider) {
  return (provider && (provider.name || provider.id)) || '';
}

export function renderKeyPanel(provider) {
  const draft = !provider;
  if (ui.providerKeyFields) ui.providerKeyFields.hidden = draft;
  if (ui.providerDraftHint) ui.providerDraftHint.hidden = !(draft && state.providerDraft);
  if (draft) {
    ui.keyStatus.textContent = state.providerDraft ? '尚未保存' : '模型清单不可用';
    ui.keyStatus.dataset.tone = state.providerDraft ? 'muted' : 'error';
    if (ui.testConnectionButton) ui.testConnectionButton.disabled = true;
    return;
  }
  const key = providerKeyFor(provider.id);
  const required = keyRequired(provider);
  const name = providerName(provider);

  if (ui.providerKeyLabel) ui.providerKeyLabel.textContent = provider.apiKeyLabel || `${name} API Key`;
  ui.apiKeyInput.placeholder = provider.apiKeyPlaceholder || (required ? 'sk-...' : '可选，按服务要求填写');
  if (ui.apiKeyHint) {
    ui.apiKeyHint.textContent = required
      ? '保存后此处只显示 Key 的末尾四位，不会回显明文。'
      : '该服务不强制要求 API Key；如服务需要，请填写后保存。';
  }
  if (key) {
    ui.keyStatus.textContent = `已保存 · ${maskKey(key)}`;
    ui.keyStatus.dataset.tone = 'success';
  } else {
    ui.keyStatus.textContent = required ? '未配置 API Key' : '无需 API Key';
    ui.keyStatus.dataset.tone = 'muted';
  }

  ui.saveKeyButton.textContent = key ? '替换 API Key' : '保存 API Key';
  ui.saveKeyButton.setAttribute('aria-label', `${key ? '替换' : '保存'} ${name} API Key`);
  ui.saveKeyButton.disabled = state.busy;
  ui.clearKeyButton.hidden = !key;
  ui.clearKeyButton.disabled = state.busy;
  if (state.confirmClear !== provider.id) {
    ui.clearKeyButton.classList.remove('is-confirming');
    ui.clearKeyButton.textContent = '清除 API Key';
    ui.clearKeyButton.setAttribute('aria-label', `清除本机保存的 ${name} API Key`);
  }
  ui.apiKeyInput.disabled = state.busy;
  ui.toggleKeyVisibility.disabled = state.busy;
  if (ui.testConnectionButton) {
    ui.testConnectionButton.setAttribute('aria-label', `测试 ${name} 连接`);
    ui.testConnectionButton.disabled = state.busy || (required && !key) ||
      (isCustomProvider(provider) && !provider.endpoint);
  }
}

export function validateProviderKey(provider, raw) {
  const required = keyRequired(provider);
  const key = typeof raw === 'string' ? raw.trim() : '';
  if (!key) {
    return {
      ok: false,
      message: required
        ? '请先输入 API Key。'
        : '该服务不强制要求 API Key；如需清除已保存的 Key，请使用“清除 API Key”。'
    };
  }
  if (key.length > KEY_MAX_LENGTH) return { ok: false, message: 'API Key 过长，请检查输入。' };
  if (isCustomProvider(provider)) {
    if (/\s/.test(key) || /[\r\n]/.test(key)) {
      return { ok: false, message: 'API Key 不能包含空白字符。' };
    }
    return { ok: true, key };
  }
  const prefix = (provider && provider.apiKeyPrefix) || '';
  if (!key.startsWith(prefix)) return { ok: false, message: `API Key 应以 ${prefix} 开头。` };
  if (key.length < KEY_MIN_LENGTH) {
    return { ok: false, message: 'API Key 长度不足，请检查是否复制完整。' };
  }
  if (!/^[A-Za-z0-9_.-]+$/.test(key)) {
    return { ok: false, message: 'API Key 只能包含字母、数字、点、短横线和下划线。' };
  }
  return { ok: true, key };
}

export function setKeyBusy(busy) {
  state.busy = Boolean(busy);
  if (state.busy) ui.saveKeyButton.setAttribute('aria-busy', 'true');
  else ui.saveKeyButton.removeAttribute('aria-busy');
  renderProviders();
}

export async function handleSaveKey() {
  if (state.busy) return;
  const provider = selectedProvider();
  if (!provider) return;
  const providerIdValue = provider.id;
  const validation = validateProviderKey(provider, ui.apiKeyInput.value);
  if (!validation.ok) {
    setFeedback(ui.keyFeedback, validation.message, 'error');
    ui.apiKeyInput.focus();
    return;
  }

  setKeyBusy(true);
  setFeedback(ui.keyFeedback, '正在保存…', 'muted');
  try {
    const nextKeys = Object.assign({}, state.providerKeys);
    nextKeys[providerIdValue] = validation.key;
    const update = { [KEYS.PROVIDER_KEYS]: nextKeys };
    if (providerIdValue === 'deepseek') update[KEYS.API_KEY] = validation.key;
    await persist(update);
    state.providerKeys = nextKeys;
    if (providerIdValue === 'deepseek') state.legacyApiKey = validation.key;
    ui.apiKeyInput.value = '';
    setKeyVisibility(false);
    setFeedback(ui.keyFeedback, `${providerName(provider)} API Key 已保存。`, 'success', FEEDBACK_CLEAR_MS);
  } catch (_error) {
    setFeedback(ui.keyFeedback, '保存 API Key 失败，请重试。', 'error');
  } finally {
    setKeyBusy(false);
  }
}

export function setKeyVisibility(visible) {
  if (!ui.apiKeyInput || !ui.toggleKeyVisibility) return;
  const name = providerName(selectedProvider());
  ui.apiKeyInput.type = visible ? 'text' : 'password';
  ui.toggleKeyVisibility.setAttribute('aria-pressed', visible ? 'true' : 'false');
  ui.toggleKeyVisibility.setAttribute('aria-label', [visible ? '隐藏' : '显示', name, 'API Key'].filter(Boolean).join(' '));
  ui.toggleKeyVisibility.textContent = visible ? '隐藏' : '显示';
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
  ui.clearKeyButton.textContent = '清除 API Key';
  ui.clearKeyButton.setAttribute('aria-label', `清除本机保存的 ${providerName(selectedProvider())} API Key`);
}

export async function clearKey(providerIdValue) {
  const provider = getProvider(providerIdValue);
  resetClearConfirm();
  setKeyBusy(true);
  let cleared = false;
  try {
    const nextKeys = Object.assign({}, state.providerKeys);
    delete nextKeys[providerIdValue];
    const update = { [KEYS.PROVIDER_KEYS]: nextKeys };
    if (providerIdValue === 'deepseek') update[KEYS.API_KEY] = '';
    await persist(update);
    state.providerKeys = nextKeys;
    if (providerIdValue === 'deepseek') state.legacyApiKey = '';
    cleared = true;
  } catch (_error) {
    setFeedback(ui.keyFeedback, '清除 API Key 失败，请重试。', 'error');
  } finally {
    setKeyBusy(false);
  }
  if (!cleared) return;
  setFeedback(ui.keyFeedback, `${providerName(provider)} API Key 已清除。`, 'success', FEEDBACK_CLEAR_MS);
  ui.saveKeyButton.focus();
}

export function handleClearKeyClick() {
  if (state.busy) return;
  const provider = selectedProvider();
  if (!provider || !providerKeyFor(provider.id)) return;
  if (state.confirmClear !== provider.id) {
    resetClearConfirm();
    state.confirmClear = provider.id;
    ui.clearKeyButton.textContent = '确认清除？';
    ui.clearKeyButton.classList.add('is-confirming');
    ui.clearKeyButton.setAttribute('aria-label', `再次点击以确认清除本机保存的 ${providerName(provider)} API Key`);
    setFeedback(ui.keyFeedback, '再次点击“确认清除？”将删除本机保存的 API Key。', 'warning');
    state.clearTimer = window.setTimeout(resetClearConfirm, CONFIRM_RESET_MS);
    return;
  }
  void clearKey(provider.id);
}

export function testErrorMessage(error, provider) {
  const code = error && typeof error.code === 'string' ? error.code : 'UNKNOWN_ERROR';
  const base =
    error && typeof error.message === 'string' && error.message.trim()
      ? error.message.trim()
      : '测试连接失败，请重试。';
  if (code === 'MISSING_API_KEY') return `${providerName(provider)} 尚未配置所需的 API Key，请先保存后再测试。`;
  if (code === 'AUTH_FAILED') return `${base} 请检查 API Key 是否正确或已被撤销。`;
  if (code === 'BACKGROUND_UNAVAILABLE') return base;
  if (code === 'INVALID_SENDER') return '请在扩展设置页面中执行测试连接。';
  return base;
}

export async function handleTestConnection() {
  if (state.busy) return;
  const provider = selectedProvider();
  if (!provider) return;
  if (keyRequired(provider) && !providerKeyFor(provider.id)) {
    setFeedback(ui.keyFeedback, `请先保存 ${providerName(provider)} 的 API Key 后再测试连接。`, 'warning');
    ui.apiKeyInput.focus();
    return;
  }

  setKeyBusy(true);
  setFeedback(ui.keyFeedback, `正在测试 ${providerName(provider)} 连接…`, 'muted');
  const response = await sendMessage({ type: MSG.TEST_CONNECTION, providerId: provider.id });
  setKeyBusy(false);

  if (!response || response.ok === false) {
    const error =
      response && response.error
        ? response.error
        : { code: 'UNKNOWN_ERROR', message: '测试连接失败，请重试。' };
    setFeedback(ui.keyFeedback, testErrorMessage(error, provider), 'error');
    return;
  }

  const parts = [`${providerName(provider)} 连接成功`];
  if (typeof response.modelName === 'string' && response.modelName) parts.push(response.modelName);
  if (Number.isFinite(response.latencyMs)) parts.push(`耗时 ${Math.round(response.latencyMs)} ms`);
  if (response.modelAvailable === true) parts.push('模型可用');
  else if (response.modelAvailable === false) parts.push('但模型列表中未找到当前模型，请确认账户权限');
  const tone = response.modelAvailable === false ? 'warning' : 'success';
  setFeedback(ui.keyFeedback, `${parts.join(' · ')}。`, tone);
}
