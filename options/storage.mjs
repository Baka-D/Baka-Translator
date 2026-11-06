// Settings-page storage.
import { KEYS, MSG, STORAGE_KEYS_TO_READ, config, languages, modelsTools, visionTools, state, ui } from './context.mjs';
import { polishEffortLevel } from './models.mjs';
import { loadPromptEditor, populatePresetSelect, presetMeta } from './presets.mjs';
import { isObject, normalizeProviderKeys, normalizeUsage, persist, sendMessage, setFeedback } from './utils.mjs';

/* ---------- 读取配置 ---------- */

export async function readConfigSnapshot() {
  const response = await sendMessage({ type: MSG.GET_CONFIG });
  if (response && response.ok !== false && typeof response === 'object') return response;
  return null;
}

export async function loadStoredData() {
  let values = {};
  try {
    values = await chrome.storage.local.get(STORAGE_KEYS_TO_READ);
  } catch (_error) {
    setFeedback(ui.keyFeedback, '读取本机设置失败，请刷新页面后重试。', 'error');
  }
  const snapshot = state.snapshot;

  state.legacyApiKey = typeof values[KEYS.API_KEY] === 'string' ? values[KEYS.API_KEY].trim() : '';
  state.providerKeys = normalizeProviderKeys(values[KEYS.PROVIDER_KEYS]);
  if (!state.providerKeys.deepseek && state.legacyApiKey) {
    state.providerKeys.deepseek = state.legacyApiKey;
  }
  state.customProviders = modelsTools
    ? modelsTools.normalizeCustomProviders(values[KEYS.CUSTOM_PROVIDERS], values[KEYS.CUSTOM_PROVIDER])
    : [];
  state.userModels = modelsTools ? modelsTools.normalizeUserModels(values[KEYS.USER_MODELS]) : {};
  state.visionCapabilities = visionTools ? visionTools.normalizeCache(values[KEYS.VISION_CAPABILITIES]) : {};
  state.promptOverrides = isObject(values[KEYS.PROMPT_OVERRIDES]) ? values[KEYS.PROMPT_OVERRIDES] : {};
  state.siteSettings = isObject(values[KEYS.SITE_SETTINGS]) ? values[KEYS.SITE_SETTINGS] : {};
  state.targetLang = languages.normalizeTarget(values[KEYS.TARGET]);
  state.bilingual = values[KEYS.BILINGUAL] === true;
  state.usage =
    values[KEYS.USAGE] === undefined || values[KEYS.USAGE] === null
      ? normalizeUsage(snapshot && snapshot.usage)
      : normalizeUsage(values[KEYS.USAGE]);

  const storedTranslationModel =
    typeof values[KEYS.TRANSLATION_MODEL_ID] === 'string'
      ? values[KEYS.TRANSLATION_MODEL_ID].trim()
      : '';
  const storedTranslationEffort =
    typeof values[KEYS.TRANSLATION_EFFORT] === 'string'
      ? values[KEYS.TRANSLATION_EFFORT].trim()
      : '';
  state.storedModelId = typeof values[KEYS.MODEL_ID] === 'string' ? values[KEYS.MODEL_ID] : '';
  state.storedEffort = typeof values[KEYS.EFFORT] === 'string' ? values[KEYS.EFFORT] : '';
  state.storedTranslationModel = Boolean(storedTranslationModel);
  state.storedTranslationEffort = Boolean(storedTranslationEffort);
  state.storedPresetId = typeof values[KEYS.PRESET_ID] === 'string' ? values[KEYS.PRESET_ID] : '';

  const snapshotModelId =
    snapshot && isObject(snapshot.model) && typeof snapshot.model.id === 'string'
      ? snapshot.model.id
      : snapshot && typeof snapshot.translationModelId === 'string'
        ? snapshot.translationModelId
        : snapshot && typeof snapshot.modelId === 'string'
          ? snapshot.modelId
          : '';
  state.modelId =
    storedTranslationModel ||
    state.storedModelId.trim() ||
    snapshotModelId ||
    config.DEFAULT_MODEL_ID ||
    'deepseek-flash';
  const snapshotEffort =
    snapshot && typeof snapshot.translationEffortLevel === 'string'
      ? snapshot.translationEffortLevel
      : snapshot && typeof snapshot.effortLevel === 'string'
        ? snapshot.effortLevel
        : '';
  state.effortLevel =
    storedTranslationEffort ||
    state.storedEffort.trim() ||
    snapshotEffort ||
    config.DEFAULT_EFFORT ||
    'none';

  const storedPolishModel =
    typeof values[KEYS.POLISH_MODEL_ID] === 'string' ? values[KEYS.POLISH_MODEL_ID].trim() : null;
  const storedPolishEffort =
    typeof values[KEYS.POLISH_EFFORT] === 'string' ? values[KEYS.POLISH_EFFORT].trim() : null;
  state.storedPolishModel = storedPolishModel !== null;
  state.storedPolishEffort = storedPolishEffort !== null;
  if (storedPolishModel !== null) {
    state.polishModelIdRaw = storedPolishModel;
  } else if (
    snapshot &&
    snapshot.polishUsesTranslationModel === false &&
    typeof snapshot.polishModelId === 'string'
  ) {
    state.polishModelIdRaw = snapshot.polishModelId;
  } else {
    state.polishModelIdRaw = '';
  }
  if (storedPolishEffort !== null) {
    state.polishEffortRaw = storedPolishEffort;
  } else if (
    snapshot &&
    snapshot.polishUsesTranslationEffort === false &&
    typeof snapshot.polishEffortLevel === 'string'
  ) {
    state.polishEffortRaw = snapshot.polishEffortLevel;
  } else {
    state.polishEffortRaw = '';
  }

  state.presetId =
    state.storedPresetId ||
    (snapshot && typeof snapshot.presetId === 'string' ? snapshot.presetId : '') ||
    config.DEFAULT_PRESET_ID ||
    'general';
}

export async function persistDefaultsIfMissing() {
  const updates = {};
  if (!state.storedTranslationModel && state.registry) {
    updates[KEYS.TRANSLATION_MODEL_ID] = state.modelId;
    updates[KEYS.MODEL_ID] = state.modelId;
  }
  if (!state.storedTranslationEffort && state.registry) {
    updates[KEYS.TRANSLATION_EFFORT] = state.effortLevel;
    updates[KEYS.EFFORT] = state.effortLevel;
  }
  if (!state.storedPolishModel && state.registry) updates[KEYS.POLISH_MODEL_ID] = state.polishModelIdRaw;
  if (!state.storedPolishEffort && state.registry) updates[KEYS.POLISH_EFFORT] = state.polishEffortRaw;
  if (!state.storedPresetId && state.presetIndex) updates[KEYS.PRESET_ID] = state.presetId;
  if (Object.keys(updates).length === 0) return;
  try {
    await persist(updates);
  } catch (_error) {
    // 默认值持久化失败不影响当前页面使用。
  }
}

export async function resolvePreset() {
  if (state.presetIndex && !presetMeta(state.presetId)) {
    state.presetId = state.presetIndex.defaultPresetId || state.presetId;
  }
  populatePresetSelect();
  if (ui.presetSelect) ui.presetSelect.value = state.presetId;
  await loadPromptEditor();
}
