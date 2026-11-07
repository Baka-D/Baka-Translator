// Service-worker helpers; loaded in the worker global scope.

function attachBilling(runtime, result) {
  const billing = billingUtils.estimateCost(
    runtime.resolved.model.pricing,
    result.usage,
    result.requestStartedAt || Date.now()
  );
  return {
    ...result,
    billing,
    modelId: runtime.resolved.model.id,
    modelName: runtime.resolved.model.name,
    providerId: runtime.resolved.provider.id
  };
}

/** onDiscardedUsage callback: record a billed-but-rejected reply's usage. */
function discardedUsageRecorder(runtime, onBilling) {
  return (usage, requestStartedAt) => {
    const enriched = attachBilling(runtime, { usage, requestStartedAt });
    void recordUsage(enriched.usage, enriched.billing, false);
    if (onBilling) onBilling(enriched.billing);
  };
}

async function getConfigSnapshot() {
  const settings = await readSettings();
  let registry = null;
  try {
    registry = settingsRegistry(await loadRegistry(), settings);
  } catch (_error) {
    registry = null;
  }

  function modelSnapshot(purpose) {
    const selection = runtimeSettingsForPurpose(settings, purpose, registry);
    if (!registry) {
      return {
        purpose: selection.purpose,
        modelId: selection.modelId,
        effortLevel: selection.effortLevel,
        model: null,
        provider: null,
        hasApiKey: false
      };
    }
    try {
      const resolved = modelUtils.resolveModel(registry, {
        modelId: selection.modelId,
        effortLevel: selection.effortLevel
      });
      const apiKey = getProviderApiKey(resolved.provider, settings);
      return {
        purpose: selection.purpose,
        modelId: resolved.model.id,
        effortLevel: resolved.effort,
        model: {
          id: resolved.model.id,
          name: resolved.model.name,
          model: resolved.model.model,
          endpoint: resolved.model.endpoint,
          contextWindow: resolved.model.contextWindow,
          maxOutputTokens: resolved.model.maxOutputTokens,
          effortLevels: resolved.model.effortLevels,
          supportsVision: resolved.model.supportsVision,
          visionUnsupported: resolved.model.visionUnsupported === true,
          visionUnverified: resolved.model.visionUnverified === true
        },
        provider: {
          id: resolved.provider.id,
          name: resolved.provider.name,
          requiresEndpoint: resolved.provider.requiresEndpoint
        },
        hasApiKey: Boolean(apiKey) || resolved.provider.apiKeyRequired === false
      };
    } catch (error) {
      return {
        purpose: selection.purpose,
        modelId: selection.modelId,
        effortLevel: selection.effortLevel,
        model: null,
        provider: null,
        hasApiKey: false,
        modelError: error.message
      };
    }
  }

  const translation = modelSnapshot('translation');
  const polish = modelSnapshot('polish');
  const polishSelection = runtimeSettingsForPurpose(settings, 'polish', registry);
  return {
    hasApiKey: translation.hasApiKey,
    polishHasApiKey: polish.hasApiKey,
    targetLang: settings.targetLang,
    bilingual: settings.bilingual,
    usage: settings.usage,
    presetId: settings.presetId,
    translationModelId: translation.modelId,
    translationEffortLevel: translation.effortLevel,
    polishModelId: polish.modelId,
    polishEffortLevel: polish.effortLevel,
    translationModel: translation.model,
    polishModel: polish.model,
    translationProvider: translation.provider,
    polishProvider: polish.provider,
    translationHasApiKey: translation.hasApiKey,
    translationModelError: translation.modelError || '',
    polishUsesTranslationModel: polishSelection.inheritsModel,
    polishUsesTranslationEffort: polishSelection.inheritsEffort,
    // Legacy aliases: translation is the default/primary model.
    modelId: translation.modelId,
    effortLevel: translation.effortLevel,
    provider: translation.provider,
    model: translation.model,
    customProvider: settings.customProvider,
    customProviders: settings.customProviders,
    siteSettings: settings.siteSettings
  };
}

async function requireRuntimeReady(purpose, hostname) {
  return resolveRuntime(purpose || 'translation', hostname);
}

async function recordUsage(apiUsage, billing, countRequest = true) {
  const normalized = usageUtils.normalizeApiUsage(apiUsage);
  if (!normalized) return;
  usageWriteQueue = usageWriteQueue
    .then(async () => {
      const values = await chrome.storage.local.get(config.STORAGE_KEYS.USAGE);
      const current = usageUtils.normalizeStoredUsage(values[config.STORAGE_KEYS.USAGE]);
      const next = usageUtils.mergeUsage(current, normalized, {
        billing, now: Date.now(), countRequest
      });
      await chrome.storage.local.set({ [config.STORAGE_KEYS.USAGE]: next });
    })
    .catch(() => {});
  return usageWriteQueue;
}

function resetUsage() {
  usageWriteQueue = usageWriteQueue
    .then(async () => {
      await chrome.storage.local.set({
        [config.STORAGE_KEYS.USAGE]: { ...usageUtils.EMPTY_USAGE }
      });
    })
    .catch(() => {});
  return usageWriteQueue;
}

async function initializeStorage() {
  const keys = Object.values(config.STORAGE_KEYS);
  const values = await chrome.storage.local.get(keys);
  const updates = {};
  if (typeof values[config.STORAGE_KEYS.API_KEY] !== 'string') {
    updates[config.STORAGE_KEYS.API_KEY] = '';
  }
  if (!languages.getTargetLanguage(values[config.STORAGE_KEYS.TARGET])) {
    updates[config.STORAGE_KEYS.TARGET] = config.DEFAULT_TARGET;
  }
  if (typeof values[config.STORAGE_KEYS.BILINGUAL] !== 'boolean') {
    updates[config.STORAGE_KEYS.BILINGUAL] = config.DEFAULT_BILINGUAL;
  }
  if (!values[config.STORAGE_KEYS.USAGE] || typeof values[config.STORAGE_KEYS.USAGE] !== 'object') {
    updates[config.STORAGE_KEYS.USAGE] = { ...usageUtils.EMPTY_USAGE };
  }
  if (typeof values[config.STORAGE_KEYS.MODEL_ID] !== 'string' || !values[config.STORAGE_KEYS.MODEL_ID]) {
    updates[config.STORAGE_KEYS.MODEL_ID] = config.DEFAULT_MODEL_ID;
  }
  if (typeof values[config.STORAGE_KEYS.EFFORT] !== 'string') {
    updates[config.STORAGE_KEYS.EFFORT] = config.DEFAULT_EFFORT;
  }
  const existingLegacyModelId =
    typeof values[config.STORAGE_KEYS.MODEL_ID] === 'string' &&
    values[config.STORAGE_KEYS.MODEL_ID].trim()
      ? values[config.STORAGE_KEYS.MODEL_ID].trim()
      : config.DEFAULT_MODEL_ID;
  const existingLegacyEffort =
    typeof values[config.STORAGE_KEYS.EFFORT] === 'string'
      ? values[config.STORAGE_KEYS.EFFORT].trim()
      : config.DEFAULT_EFFORT;
  if (
    typeof values[config.STORAGE_KEYS.TRANSLATION_MODEL_ID] !== 'string' ||
    !values[config.STORAGE_KEYS.TRANSLATION_MODEL_ID].trim()
  ) {
    updates[config.STORAGE_KEYS.TRANSLATION_MODEL_ID] = existingLegacyModelId;
  }
  if (typeof values[config.STORAGE_KEYS.TRANSLATION_EFFORT] !== 'string') {
    updates[config.STORAGE_KEYS.TRANSLATION_EFFORT] = existingLegacyEffort;
  }
  if (typeof values[config.STORAGE_KEYS.POLISH_MODEL_ID] !== 'string') {
    // Empty means "same model as translation".
    updates[config.STORAGE_KEYS.POLISH_MODEL_ID] = '';
  }
  if (typeof values[config.STORAGE_KEYS.POLISH_EFFORT] !== 'string') {
    updates[config.STORAGE_KEYS.POLISH_EFFORT] = '';
  }
  if (typeof values[config.STORAGE_KEYS.PRESET_ID] !== 'string' || !values[config.STORAGE_KEYS.PRESET_ID]) {
    updates[config.STORAGE_KEYS.PRESET_ID] = config.DEFAULT_PRESET_ID;
  }
  if (!values[config.STORAGE_KEYS.PROVIDER_KEYS] || typeof values[config.STORAGE_KEYS.PROVIDER_KEYS] !== 'object') {
    const legacyKey =
      typeof values[config.STORAGE_KEYS.API_KEY] === 'string'
        ? values[config.STORAGE_KEYS.API_KEY].trim()
        : '';
    updates[config.STORAGE_KEYS.PROVIDER_KEYS] = legacyKey ? { deepseek: legacyKey } : {};
  } else {
    const providerKeys = normalizeProviderKeys(values[config.STORAGE_KEYS.PROVIDER_KEYS]);
    const legacyKey =
      typeof values[config.STORAGE_KEYS.API_KEY] === 'string'
        ? values[config.STORAGE_KEYS.API_KEY].trim()
        : '';
    if (legacyKey && !providerKeys.deepseek) {
      providerKeys.deepseek = legacyKey;
      updates[config.STORAGE_KEYS.PROVIDER_KEYS] = providerKeys;
    }
  }
  if (!values[config.STORAGE_KEYS.CUSTOM_PROVIDER] || typeof values[config.STORAGE_KEYS.CUSTOM_PROVIDER] !== 'object') {
    updates[config.STORAGE_KEYS.CUSTOM_PROVIDER] = { endpoint: '', model: '' };
  }
  if (!values[config.STORAGE_KEYS.PROMPT_OVERRIDES] || typeof values[config.STORAGE_KEYS.PROMPT_OVERRIDES] !== 'object') {
    updates[config.STORAGE_KEYS.PROMPT_OVERRIDES] = {};
  }
  if (!values[config.STORAGE_KEYS.SITE_SETTINGS] || typeof values[config.STORAGE_KEYS.SITE_SETTINGS] !== 'object') {
    updates[config.STORAGE_KEYS.SITE_SETTINGS] = {};
  }
  if (!values[config.STORAGE_KEYS.INSTALLED_AT]) {
    updates[config.STORAGE_KEYS.INSTALLED_AT] = Date.now();
  }
  if (Object.keys(updates).length > 0) {
    await chrome.storage.local.set(updates);
  }
}
