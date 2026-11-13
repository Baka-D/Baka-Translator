// Settings-page models.
import { t, i18n, modelsTools, state, ui } from './context.mjs';
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
  if (staleTranslationModelId()) return t('opt_model_unavailable');
  return translation ? i18n.modelName(translation.id, translation.name) : '—';
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
  return provider && provider.name ? i18n.providerName(provider.id, provider.name) : providerIdValue;
}

export function fillProviderOptions(select, includeInherit, inheritLabel) {
  if (!select) return;
  select.textContent = '';
  if (includeInherit) {
    const option = document.createElement('option');
    option.value = '';
    option.textContent = inheritLabel || t('opt_model_same_translation');
    select.appendChild(option);
  }
  for (const entry of listProviders()) {
    const option = document.createElement('option');
    option.value = entry.provider.id;
    option.textContent = i18n.providerName(entry.provider.id, entry.provider.name || entry.provider.id);
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
      fillProviderOptions(select, true, t('opt_model_same_translation'));
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
    option.textContent = i18n.modelName(model.id, model.name);
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
    option.textContent = t('opt_model_list_unavailable');
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
    option.textContent = t('opt_model_unavailable_name', [stale]);
    option.disabled = true;
    select.prepend(option);
    option.selected = true;
  }
  if (ui.polishModelSelect) {
    if (polishInheritsModel()) {
      ui.polishModelSelect.textContent = '';
      const option = document.createElement('option');
      option.value = '';
      option.textContent = translation ? t('opt_model_follow_named', [translationName(translation)]) : t('opt_model_follow');
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
  if (provider && provider.name) parts.push(t('opt_model_provider', [i18n.providerName(provider.id, provider.name)]));
  parts.push(t('opt_model_context', [formatNumber(model.contextWindow)]));
  parts.push(t('opt_model_output', [formatNumber(model.maxOutputTokens)]));
  const endpoint = model.endpoint || (provider && provider.endpoint) || '';
  if (endpoint) parts.push(t('opt_model_endpoint', [endpoint]));
  const caps = [];
  if (model.supportsVision) caps.push(model.visionUnverified ? t('opt_model_image_unverified') : t('opt_model_images'));
  else parts.push(model.visionUnsupported ? t('opt_model_image_disabled') : t('opt_model_image_unsupported'));
  if (model.supportsJson) caps.push('JSON');
  if (caps.length > 0) parts.push(t('opt_model_capabilities', [caps.join(' / ')]));
  return parts.join(' · ');
}

export function renderModelDetails(model) {
  if (!ui.modelDetails) return;
  const stale = staleTranslationModelId();
  ui.modelDetails.textContent = stale ? t('opt_model_choose_another', [stale]) : modelDetailText(model);
}

export function renderPolishModelDetails(model) {
  if (!ui.polishModelDetails) return;
  if (!model) {
    ui.polishModelDetails.textContent = '—';
    return;
  }
  ui.polishModelDetails.textContent = polishInheritsModel()
    ? t('opt_model_follow_description', [translationName(model)])
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
    option.textContent = followLabel || t('opt_effort_follow');
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
      ? t('opt_translation_select_first')
      : levels.length <= 1
        ? t('opt_effort_fixed', [effortLabel(levels[0])])
        : t('opt_effort_latency_hint');
  }
}

export function populatePolishEffortSelect() {
  const select = ui.polishEffortSelect;
  if (!select) return;
  const model = polishModel();
  const levels = effortLevelsFor(model);
  fillEffortOptions(select, levels, true, t('opt_effort_follow'));
  const value =
    state.polishEffortRaw && levels.includes(state.polishEffortRaw) ? state.polishEffortRaw : '';
  select.value = value;
  const translation = translationModel();
  const sameModel = Boolean(model && translation && model.id === translation.id);
  if (ui.polishEffortHint) {
    if (value) {
      ui.polishEffortHint.textContent =
        polishInheritsModel()
          ? t('opt_polish_effort_inherited', [effortLabel(value)])
          : t('opt_polish_effort_value', [effortLabel(value)]);
    } else if (polishInheritsModel()) {
      ui.polishEffortHint.textContent = t('opt_polish_follow_both', [translationName(translation)]);
    } else {
      ui.polishEffortHint.textContent = t(sameModel ? 'opt_polish_effort_default_same' : 'opt_polish_effort_default', [
        effortLabel(model ? model.defaultEffort : 'none')
      ]);
    }
    ui.polishEffortHint.textContent += t('opt_polish_effort_latency');
  }
}

export function renderSummaries() {
  const translation = translationModel();
  const polish = polishModel();
  if (ui.translationSummary) {
    ui.translationSummary.textContent = staleTranslationModelId()
      ? t('opt_translation_summary_unavailable')
      : translation
        ? t('opt_translation_summary', [i18n.modelName(translation.id, translation.name), effortLabel(state.effortLevel)])
        : t('opt_translation_summary_empty');
  }
  if (ui.polishSummary) {
    if (!polish) {
      ui.polishSummary.textContent = t('opt_polish_summary_empty');
    } else if (polishInheritsModel()) {
      ui.polishSummary.textContent = t('opt_polish_summary_follow', [translationName(polish), effortLabel(polishEffortLevel())]);
    } else {
      ui.polishSummary.textContent = t('opt_polish_summary', [i18n.modelName(polish.id, polish.name), effortLabel(polishEffortLevel())]);
    }
  }
}

export function renderMetaAbout() {
  const version = getVersion();
  if (ui.versionText) ui.versionText.textContent = version || t('opt_unknown');
  const model = translationModel();
  const polish = polishModel();
  if (ui.modelText) {
    const stale = Boolean(staleTranslationModelId());
    if (!model) ui.modelText.textContent = '—';
    else if (polish && !polishInheritsModel() && (stale || polish.id !== model.id)) {
      ui.modelText.textContent = t('opt_models_about', [translationName(model), i18n.modelName(polish.id, polish.name)]);
    } else if (polish && !polishInheritsModel()) {
      ui.modelText.textContent = `${i18n.modelName(model.id, model.name)} / ${i18n.modelName(polish.id, polish.name)}`;
    } else {
      ui.modelText.textContent = translationName(model);
    }
  }
  renderSummaries();
}
