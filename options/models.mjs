// Settings-page models.
import { modelsTools, state, ui } from './context.mjs';
import { effortLabel, formatNumber, getVersion } from './utils.mjs';

/* ---------- 模型注册表 ---------- */

export function translationModel() {
  if (!state.registry || !modelsTools) return null;
  return modelsTools.getModel(state.registry, state.modelId);
}

/** The stored translation model id that no longer exists, while a stand-in is shown. */
export function staleTranslationModelId() {
  const id = state.staleModelId;
  return id && state.registry && modelsTools && !modelsTools.getModel(state.registry, id) ? id : '';
}

/** The translation model's name, or 已失效 so the stand-in never reads as the active model. */
function translationName(translation) {
  if (staleTranslationModelId()) return '已失效';
  return translation ? translation.name : '—';
}

export function translationProvider() {
  const model = translationModel();
  if (!model || !modelsTools) return null;
  return modelsTools.getProvider(state.registry, model.provider);
}

export function selectedModel() {
  return translationModel();
}

export function selectedProvider() {
  return translationProvider();
}

export function polishModel() {
  if (!state.registry || !modelsTools) return translationModel();
  if (state.polishModelIdRaw) {
    const model = modelsTools.getModel(state.registry, state.polishModelIdRaw);
    if (model) return model;
  }
  return translationModel();
}

export function polishProvider() {
  const model = polishModel();
  if (!model || !modelsTools) return null;
  return modelsTools.getProvider(state.registry, model.provider);
}

export function polishInheritsModel() {
  return !state.polishModelIdRaw;
}

export function polishEffortLevel() {
  const model = polishModel();
  if (!model) return 'none';
  if (state.polishEffortRaw && model.effortLevels.includes(state.polishEffortRaw)) {
    return state.polishEffortRaw;
  }
  const translation = translationModel();
  if (model.id === (translation && translation.id)) return state.effortLevel;
  return model.defaultEffort;
}

export function purposeModel(purpose) {
  return purpose === 'polish' ? polishModel() : translationModel();
}

export function purposeProvider(purpose) {
  return purpose === 'polish' ? polishProvider() : translationProvider();
}

export function providerKeyFor(providerIdValue) {
  if (providerIdValue && typeof state.providerKeys[providerIdValue] === 'string') {
    return state.providerKeys[providerIdValue];
  }
  if (providerIdValue === 'deepseek' && state.legacyApiKey) return state.legacyApiKey;
  return '';
}

export function isCustomProvider(provider) {
  return Boolean(provider && (provider.requiresEndpoint === true || provider.custom === true));
}

export function listProviders() {
  if (!state.registry || !modelsTools) return [];
  const entries = [];
  const providers = state.registry.providers || {};
  for (const provider of Object.values(providers)) {
    if (!provider || !provider.id) continue;
    const models = modelsTools.listModels(state.registry, provider.id);
    if (models.length > 0) entries.push({ provider, models });
  }
  return entries;
}

export function providerNameById(providerIdValue) {
  if (!providerIdValue || !state.registry || !modelsTools) return providerIdValue || '';
  const provider = modelsTools.getProvider(state.registry, providerIdValue);
  return provider && provider.name ? provider.name : providerIdValue;
}

export function fillProviderOptions(select, includeInherit, inheritLabel) {
  if (!select) return;
  select.textContent = '';
  if (includeInherit) {
    const option = document.createElement('option');
    option.value = '';
    option.textContent = inheritLabel || '与翻译模型相同';
    select.appendChild(option);
  }
  for (const entry of listProviders()) {
    const option = document.createElement('option');
    option.value = entry.provider.id;
    option.textContent = entry.provider.name || entry.provider.id;
    select.appendChild(option);
  }
}

export function populateProviderSelects() {
  if (ui.translationProviderSelect) {
    const select = ui.translationProviderSelect;
    if (!state.registry) {
      select.textContent = '';
      select.disabled = true;
    } else {
      fillProviderOptions(select, false, '');
      select.disabled = false;
      const provider = translationProvider();
      select.value = provider ? provider.id : '';
    }
  }
  if (ui.polishProviderSelect) {
    const select = ui.polishProviderSelect;
    if (!state.registry) {
      select.textContent = '';
      select.disabled = true;
    } else {
      fillProviderOptions(select, true, '与翻译模型相同');
      select.disabled = false;
      const provider = polishInheritsModel() ? null : polishProvider();
      select.value = provider ? provider.id : '';
    }
  }
}

export function fillProviderModelOptions(select, providerIdValue, selectedId) {
  select.textContent = '';
  const models = state.registry ? modelsTools.listModels(state.registry, providerIdValue) : [];
  for (const model of models) {
    const option = document.createElement('option');
    option.value = model.id;
    option.textContent = model.name;
    select.appendChild(option);
  }
  const selected = state.registry ? modelsTools.getModel(state.registry, selectedId) : null;
  if (selected && models.includes(selected)) select.value = selected.id;
  else if (models.length > 0) select.value = models[0].id;
  return models;
}

export function populateModelSelect() {
  const select = ui.modelSelect;
  if (!select) return;
  if (!state.registry || !modelsTools) {
    select.textContent = '';
    const option = document.createElement('option');
    option.value = '';
    option.textContent = '模型清单不可用';
    select.appendChild(option);
    select.disabled = true;
    if (ui.polishModelSelect) {
      ui.polishModelSelect.textContent = '';
      ui.polishModelSelect.disabled = true;
    }
    return;
  }
  const translation = translationModel();
  select.disabled = false;
  fillProviderModelOptions(select, translation ? translation.provider : '', state.modelId);
  const stale = staleTranslationModelId();
  if (stale) {
    // Selected so that picking any real model, the stand-in included, fires a change.
    const option = document.createElement('option');
    option.value = '';
    option.textContent = `（已失效）${stale}`;
    option.disabled = true;
    select.prepend(option);
    option.selected = true;
  }
  if (ui.polishModelSelect) {
    if (polishInheritsModel()) {
      ui.polishModelSelect.textContent = '';
      const option = document.createElement('option');
      option.value = '';
      option.textContent = `跟随翻译模型${translation ? `（${translationName(translation)}）` : ''}`;
      ui.polishModelSelect.appendChild(option);
      ui.polishModelSelect.disabled = true;
    } else {
      const polish = polishModel();
      ui.polishModelSelect.disabled = false;
      fillProviderModelOptions(
        ui.polishModelSelect,
        polish ? polish.provider : '',
        state.polishModelIdRaw
      );
    }
  }
}

export function modelDetailText(model) {
  if (!model || !modelsTools) return '—';
  const provider = modelsTools.getProvider(state.registry, model.provider);
  const parts = [];
  if (provider && provider.name) parts.push(`服务商：${provider.name}`);
  parts.push(`上下文：${formatNumber(model.contextWindow)} tokens`);
  parts.push(`最大输出：${formatNumber(model.maxOutputTokens)} tokens`);
  const endpoint = model.endpoint || (provider && provider.endpoint) || '';
  if (endpoint) parts.push(`端点：${endpoint}`);
  const caps = [];
  if (model.supportsVision) caps.push(model.visionUnverified ? '图片（待确认）' : '图片');
  else parts.push(model.visionUnsupported ? '图片翻译：已禁用（模型已确认不支持）' : '图片翻译：不支持');
  if (model.supportsJson) caps.push('JSON');
  if (caps.length > 0) parts.push(`能力：${caps.join(' / ')}`);
  return parts.join(' · ');
}

export function renderModelDetails(model) {
  if (!ui.modelDetails) return;
  const stale = staleTranslationModelId();
  ui.modelDetails.textContent = stale ? `模型已失效：${stale}。请改选其他模型。` : modelDetailText(model);
}

export function renderPolishModelDetails(model) {
  if (!ui.polishModelDetails) return;
  if (!model) {
    ui.polishModelDetails.textContent = '—';
    return;
  }
  ui.polishModelDetails.textContent = polishInheritsModel()
    ? `跟随翻译模型：${translationName(model)}。`
    : modelDetailText(model);
}

export function effortLevelsFor(model) {
  if (model && Array.isArray(model.effortLevels) && model.effortLevels.length > 0) {
    return model.effortLevels;
  }
  return ['none'];
}

export function fillEffortOptions(select, levels, includeFollow, followLabel) {
  select.textContent = '';
  if (includeFollow) {
    const option = document.createElement('option');
    option.value = '';
    option.textContent = followLabel || '跟随翻译（默认）';
    select.appendChild(option);
  }
  for (const level of levels) {
    const option = document.createElement('option');
    option.value = level;
    option.textContent = effortLabel(level);
    select.appendChild(option);
  }
}

export function populateEffortSelect(model) {
  const select = ui.effortSelect;
  if (!select) return;
  const levels = effortLevelsFor(model);
  fillEffortOptions(select, levels, false, '');
  const value = levels.includes(state.effortLevel) ? state.effortLevel : levels[0];
  select.value = value;
  state.effortLevel = value;
  // While stale, `state.modelId` is the stand-in: an effort change would save it as the model.
  const stale = Boolean(staleTranslationModelId());
  select.disabled = stale || levels.length <= 1;
  if (ui.effortHint) {
    ui.effortHint.textContent = stale
      ? '翻译模型已失效，请先改选模型。'
      : levels.length <= 1
        ? `当前模型不支持调整思考强度（固定为“${effortLabel(levels[0])}”）。`
        : '思考强度越高越慢、通常也越贵；网页翻译建议关闭或使用低强度。';
  }
}

export function populatePolishEffortSelect() {
  const select = ui.polishEffortSelect;
  if (!select) return;
  const model = polishModel();
  const levels = effortLevelsFor(model);
  fillEffortOptions(select, levels, true, '跟随翻译（默认）');
  const value =
    state.polishEffortRaw && levels.includes(state.polishEffortRaw) ? state.polishEffortRaw : '';
  select.value = value;
  const translation = translationModel();
  const sameModel = Boolean(model && translation && model.id === translation.id);
  if (ui.polishEffortHint) {
    if (value) {
      ui.polishEffortHint.textContent =
        `润色思考强度：${effortLabel(value)}${polishInheritsModel() ? '（模型跟随翻译）' : ''}。`;
    } else if (polishInheritsModel()) {
      ui.polishEffortHint.textContent = `跟随翻译模型（${translationName(translation)}）与思考强度。`;
    } else {
      ui.polishEffortHint.textContent = `未指定时使用该模型默认值（${effortLabel(
        model ? model.defaultEffort : 'none'
      )}）${sameModel ? '；与翻译同模型时跟随翻译强度' : ''}。`;
    }
    ui.polishEffortHint.textContent += ' 润色强度越高等待越久：关闭思考最快，中/高强度可能等待数十秒到数分钟。';
  }
}

export function renderSummaries() {
  const translation = translationModel();
  const polish = polishModel();
  if (ui.translationSummary) {
    ui.translationSummary.textContent = staleTranslationModelId()
      ? '翻译模型：已失效'
      : translation
        ? `翻译模型：${translation.name} · 思考强度：${effortLabel(state.effortLevel)}`
        : '翻译模型：—';
  }
  if (ui.polishSummary) {
    if (!polish) {
      ui.polishSummary.textContent = '润色模型：—';
    } else if (polishInheritsModel()) {
      ui.polishSummary.textContent = `润色模型：跟随翻译（${translationName(polish)}） · 思考强度：${effortLabel(
        polishEffortLevel()
      )}`;
    } else {
      ui.polishSummary.textContent = `润色模型：${polish.name} · 思考强度：${effortLabel(
        polishEffortLevel()
      )}`;
    }
  }
}

export function renderMetaAbout() {
  const version = getVersion();
  if (ui.versionText) ui.versionText.textContent = version || '未知';
  const model = translationModel();
  const polish = polishModel();
  if (ui.modelText) {
    const stale = Boolean(staleTranslationModelId());
    if (!model) ui.modelText.textContent = '—';
    else if (polish && !polishInheritsModel() && (stale || polish.id !== model.id)) {
      ui.modelText.textContent = `翻译：${translationName(model)} / 润色：${polish.name}`;
    } else if (polish && !polishInheritsModel()) {
      ui.modelText.textContent = `${model.name} / ${polish.name}`;
    } else {
      ui.modelText.textContent = translationName(model);
    }
  }
  renderSummaries();
}
