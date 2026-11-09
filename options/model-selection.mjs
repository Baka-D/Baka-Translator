// Settings-page model selection.
import { KEYS, config, fallback, modelsTools, visionTools, state, ui } from './context.mjs';
import { renderProviders } from './providers.mjs';
import { polishInheritsModel, polishModel, populateEffortSelect, populateModelSelect, populatePolishEffortSelect, populateProviderSelects, renderMetaAbout, renderModelDetails, renderPolishModelDetails, translationModel } from './models.mjs';
import { isObject, persist, setFeedback } from './utils.mjs';

export function buildFallbackRegistry(snapshot) {
  if (!modelsTools) return null;
  const modelRaw = snapshot && isObject(snapshot.model) ? snapshot.model : {};
  const providerRaw = snapshot && isObject(snapshot.provider) ? snapshot.provider : {};
  const providerIdValue = providerRaw.id || modelRaw.provider || 'deepseek';
  const modelId =
    modelRaw.id || (snapshot && snapshot.modelId) || config.DEFAULT_MODEL_ID || 'deepseek-flash';
  const raw = {
    version: 1,
    defaultModelId: modelId,
    providers: {},
    models: [
      {
        id: modelId,
        provider: providerIdValue,
        name: modelRaw.name || modelId,
        model: modelRaw.model || modelId,
        endpoint: modelRaw.endpoint || providerRaw.endpoint || config.API_BASE_URL,
        contextWindow: modelRaw.contextWindow || 128000,
        maxOutputTokens: modelRaw.maxOutputTokens || 16384,
        effortLevels:
          Array.isArray(modelRaw.effortLevels) && modelRaw.effortLevels.length > 0
            ? modelRaw.effortLevels
            : ['none'],
        defaultEffort: modelRaw.defaultEffort || 'none',
        supportsVision: modelRaw.supportsVision !== false,
        supportsJson: true,
        maxTokensParam: 'max_tokens',
        pricing: null
      }
    ]
  };
  raw.providers[providerIdValue] = {
    name: providerRaw.name || providerIdValue,
    endpoint: modelRaw.endpoint || providerRaw.endpoint || config.API_BASE_URL,
    completionsPath: '/chat/completions',
    modelsPath: '/models',
    protocol: 'openai',
    requestShape: 'openai',
    requiresEndpoint: providerRaw.requiresEndpoint === true,
    apiKeyRequired: providerIdValue !== 'custom',
    apiKeyLabel: `${providerRaw.name || providerIdValue} API Key`,
    apiKeyPlaceholder: 'sk-...'
  };
  const registry = modelsTools.normalizeRegistry(raw);
  return registry && registry.models.length > 0 ? registry : null;
}

export function renderModelsLoadError() {
  if (!ui.modelsLoadError) return;
  const show = Boolean(state.registryError);
  if (show && ui.modelsLoadErrorText) ui.modelsLoadErrorText.textContent = state.registryError;
  ui.modelsLoadError.hidden = !show;
}

export async function loadRegistry() {
  state.registryError = '';
  const readJson = async (file) => {
    const response = await fetch(chrome.runtime.getURL(file), { cache: 'no-store' });
    if (!response || !response.ok) throw new Error('MODELS_FETCH_FAILED');
    return response.json();
  };
  try {
    const registry = modelsTools
      ? await modelsTools.loadRegistryFiles(readJson, config.MODEL_REGISTRY_PATH)
      : null;
    if (!registry || !Array.isArray(registry.models) || registry.models.length === 0) {
      throw new Error('MODELS_EMPTY');
    }
    state.baseRegistry = registry;
  } catch (_error) {
    state.baseRegistry = buildFallbackRegistry(state.snapshot);
    state.registryError = state.baseRegistry
      ? '模型清单加载失败，已使用后台兜底配置（功能可能受限）。'
      : '模型清单加载失败，请在扩展详情中检查 profile/ 下的配置后重新加载扩展。';
  }
  applyCustomProviders();
  renderModelsLoadError();
}

/** Rebuild `state.registry` after the user's providers or model names change. */
export function applyCustomProviders() {
  state.registry = state.baseRegistry && modelsTools
    ? modelsTools.withUserModels(
      modelsTools.withCustomProviders(state.baseRegistry, state.customProviders),
      state.userModels
    )
    : state.baseRegistry;
  if (visionTools) state.registry = visionTools.applyToRegistry(state.registry, state.visionCapabilities);
}

export function snapshotFallbackModelId(purpose) {
  const snapshot = state.snapshot;
  if (!snapshot) return '';
  if (purpose === 'polish') {
    return snapshot.polishUsesTranslationModel === false &&
      typeof snapshot.polishModelId === 'string'
      ? snapshot.polishModelId
      : '';
  }
  if (typeof snapshot.translationModelId === 'string') return snapshot.translationModelId;
  if (isObject(snapshot.model) && typeof snapshot.model.id === 'string') return snapshot.model.id;
  if (typeof snapshot.modelId === 'string') return snapshot.modelId;
  return '';
}

export function normalizeTranslationSelection() {
  if (!state.registry || !modelsTools) return null;
  if (state.modelId && !modelsTools.getModel(state.registry, state.modelId)) state.staleModelId = state.modelId;
  if (modelsTools.isCustomModelId(state.modelId) && !modelsTools.getModel(state.registry, state.modelId)) {
    setFeedback(
      ui.behaviorFeedback,
      '原先选用的自定义服务商或模型已不存在：翻译会停用，直到你在「常规 → 服务商」重新添加它或在此改选其他模型（选择后立即生效）。',
      'warning'
    );
  } else if (state.modelId && !modelsTools.getModel(state.registry, state.modelId)) {
    setFeedback(ui.behaviorFeedback, '原先选用的模型已不存在：翻译会停用，直到你在此改选模型（选择后立即生效）。', 'warning');
  }
  let model = modelsTools.getModel(state.registry, state.modelId);
  if (!model) model = modelsTools.getModel(state.registry, snapshotFallbackModelId('translation'));
  if (!model) model = modelsTools.getModel(state.registry, state.registry.defaultModelId);
  if (!model) return null;
  state.modelId = model.id;
  if (!model.effortLevels.includes(state.effortLevel)) {
    state.effortLevel = model.defaultEffort;
  }
  return model;
}

export function normalizePolishSelection() {
  if (!state.registry || !modelsTools) return null;
  if (state.polishModelIdRaw && !modelsTools.getModel(state.registry, state.polishModelIdRaw)) {
    const fallback = snapshotFallbackModelId('polish');
    state.polishModelIdRaw =
      fallback && modelsTools.getModel(state.registry, fallback) ? fallback : '';
  }
  const model = polishModel();
  if (!model) return null;
  if (state.polishEffortRaw && !model.effortLevels.includes(state.polishEffortRaw)) {
    state.polishEffortRaw = '';
  }
  return model;
}

export function persistModels(purpose) {
  if (purpose === 'polish') {
    return persist({
      [KEYS.POLISH_MODEL_ID]: state.polishModelIdRaw,
      [KEYS.POLISH_EFFORT]: state.polishEffortRaw
    });
  }
  return persist({
    [KEYS.TRANSLATION_MODEL_ID]: state.modelId,
    [KEYS.TRANSLATION_EFFORT]: state.effortLevel,
    [KEYS.MODEL_ID]: state.modelId,
    [KEYS.EFFORT]: state.effortLevel,
    // normalizePolishSelection() may have cleared polish fields the new model can't support.
    [KEYS.POLISH_MODEL_ID]: state.polishModelIdRaw,
    [KEYS.POLISH_EFFORT]: state.polishEffortRaw
  });
}

/** Follow another options tab, so a later save here cannot write back this page's old picks. */
export function followStoredModels(changes) {
  const keys = [KEYS.TRANSLATION_MODEL_ID, KEYS.TRANSLATION_EFFORT, KEYS.POLISH_MODEL_ID, KEYS.POLISH_EFFORT];
  if (!keys.some((key) => changes[key])) return;
  const stored = (key, current) => {
    const value = changes[key]?.newValue;
    return typeof value === 'string' ? value.trim() : current;
  };
  if (changes[KEYS.TRANSLATION_MODEL_ID]) state.staleModelId = '';
  state.modelId = stored(KEYS.TRANSLATION_MODEL_ID, state.modelId) || state.modelId;
  state.effortLevel = stored(KEYS.TRANSLATION_EFFORT, state.effortLevel) || state.effortLevel;
  // An empty polish value is real: it means follow the translation model.
  state.polishModelIdRaw = stored(KEYS.POLISH_MODEL_ID, state.polishModelIdRaw);
  state.polishEffortRaw = stored(KEYS.POLISH_EFFORT, state.polishEffortRaw);
  if (state.registry) applyResolvedModel();
}

export function renderModelArea() {
  populateProviderSelects();
  populateModelSelect();
  populateEffortSelect(translationModel());
  populatePolishEffortSelect();
  renderModelDetails(translationModel());
  renderPolishModelDetails(polishModel());
  renderProviders();
  renderMetaAbout();
}

export function applyTranslationProvider(providerIdValue) {
  if (!state.registry || !modelsTools) return null;
  const models = modelsTools.listModels(state.registry, providerIdValue);
  if (models.length === 0) return null;
  const current = translationModel();
  const next = current && current.provider === providerIdValue ? current : models[0];
  state.modelId = next.id;
  state.staleModelId = '';
  if (!next.effortLevels.includes(state.effortLevel)) {
    state.effortLevel = next.defaultEffort;
  }
  normalizePolishSelection();
  renderModelArea();
  return persistModels('translation');
}

export function applyPolishProvider(providerIdValue) {
  if (!state.registry || !modelsTools) return null;
  if (!providerIdValue) {
    state.polishModelIdRaw = '';
    normalizePolishSelection();
    renderModelArea();
    return persistModels('polish');
  }
  const models = modelsTools.listModels(state.registry, providerIdValue);
  if (models.length === 0) return null;
  const current = polishModel();
  const keep =
    !polishInheritsModel() && current && current.provider === providerIdValue ? current : null;
  const next = keep || models[0];
  state.polishModelIdRaw = next.id;
  normalizePolishSelection();
  renderModelArea();
  return persistModels('polish');
}

export function applyModelSelection(modelId) {
  if (!state.registry || !modelsTools) return null;
  const model = modelsTools.getModel(state.registry, modelId);
  if (!model) return null;
  state.modelId = model.id;
  state.staleModelId = '';
  if (!model.effortLevels.includes(state.effortLevel)) {
    state.effortLevel = model.defaultEffort;
  }
  normalizePolishSelection();
  renderModelArea();
  return persistModels('translation');
}

export function applyResolvedModel() {
  if (!state.registry || !modelsTools) {
    populateModelSelect();
    if (ui.effortSelect) {
      ui.effortSelect.textContent = '';
      ui.effortSelect.disabled = true;
    }
    if (ui.polishEffortSelect) {
      ui.polishEffortSelect.textContent = '';
      ui.polishEffortSelect.disabled = true;
    }
    renderProviders();
    if (ui.modelDetails) ui.modelDetails.textContent = '请修复 profile/ 下的配置后重新加载扩展。';
    if (ui.polishModelDetails) ui.polishModelDetails.textContent = '—';
    return;
  }
  populateModelSelect();
  const model = normalizeTranslationSelection();
  if (!model) return;
  normalizePolishSelection();
  renderModelArea();
}
