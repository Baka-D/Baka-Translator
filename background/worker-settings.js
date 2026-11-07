// Service-worker helpers; loaded in the worker global scope.

function fetchExtensionJson(path) {
  return fetch(chrome.runtime.getURL(path), { cache: 'no-store' }).then(async (response) => {
    if (!response || !response.ok) {
      throw new PageAccessError('MODEL_CONFIG_ERROR', `无法加载 ${path}`);
    }
    return response.json();
  });
}

async function loadRegistry() {
  if (!registryPromise) {
    registryPromise = modelUtils.loadRegistryFiles(fetchExtensionJson, config.MODEL_REGISTRY_PATH)
      .then((registry) => {
        if (!registry || registry.models.length === 0) {
          throw new PageAccessError(
            'MODEL_CONFIG_ERROR',
            'profile/ 中没有可用模型，请检查配置。'
          );
        }
        return registry;
      })
      .catch((error) => {
        registryPromise = null;
        if (error instanceof PageAccessError) throw error;
        throw new PageAccessError(
          'MODEL_CONFIG_ERROR',
          `无法读取 profile/ 下的模型配置：${error.message || '未知错误'}`
        );
      });
  }
  return registryPromise;
}

async function loadPresetIndex() {
  if (!presetIndexPromise) {
    presetIndexPromise = fetchExtensionJson(config.PRESET_INDEX_PATH)
      .then((raw) => presetUtils.normalizePresetIndex(raw))
      .catch((error) => {
        presetIndexPromise = null;
        throw new PageAccessError(
          'PRESET_CONFIG_ERROR',
          `无法读取 preset/index.json：${error.message || '未知错误'}`
        );
      });
  }
  return presetIndexPromise;
}

async function loadPreset(id, file) {
  const key = `${id}:${file}`;
  if (presetCache.has(key)) return presetCache.get(key);
  const promise = fetchExtensionJson(`preset/${file}`)
    .then((raw) => presetUtils.normalizePreset(raw, id))
    .catch(() => presetUtils.normalizePreset({ id, name: id }, id));
  presetCache.set(key, promise);
  return promise;
}

async function getActivePreset(settings, presetId) {
  const requested =
    typeof presetId === 'string' && presetId.trim() ? presetId.trim() : settings.presetId;
  try {
    const index = await loadPresetIndex();
    const meta =
      presetUtils.getPresetMeta(index, requested) ||
      presetUtils.getPresetMeta(index, index.defaultPresetId) ||
      index.presets[0];
    const preset = await loadPreset(meta.id, meta.file);
    const override =
      settings.promptOverrides && typeof settings.promptOverrides === 'object'
        ? settings.promptOverrides[meta.id]
        : null;
    return presetUtils.mergePromptOverrides(preset, override);
  } catch (_error) {
    return presetUtils.normalizePreset({ id: requested }, requested);
  }
}

function normalizeProviderKeys(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const keys = {};
  for (const [providerId, value] of Object.entries(raw)) {
    if (typeof value !== 'string') continue;
    const key = value.trim();
    if (key) keys[providerId] = key;
  }
  return keys;
}

function normalizeCustomProvider(raw) {
  const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  return {
    endpoint: typeof source.endpoint === 'string' ? source.endpoint.trim() : '',
    model: typeof source.model === 'string' ? source.model.trim() : '',
    name: typeof source.name === 'string' ? source.name.trim() : ''
  };
}

function normalizeOverrides(raw) {
  return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
}

function normalizeTargetCode(value) {
  return languages.normalizeTarget(value);
}

function normalizeBilingual(value) {
  return value === true;
}

function normalizeSiteSettings(raw) {
  return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
}

function hostnameFromUrl(url) {
  try {
    const parsed = new URL(String(url || ''));
    return parsed.hostname.toLowerCase();
  } catch (_error) {
    return '';
  }
}

function hostnameFromSender(sender) {
  return hostnameFromUrl(sender && sender.tab && sender.tab.url);
}

function sitePresetId(settings, hostname) {
  if (hostname) {
    const site = settings.siteSettings && settings.siteSettings[hostname];
    if (site && typeof site === 'object' && typeof site.presetId === 'string' && site.presetId.trim()) {
      return site.presetId.trim();
    }
  }
  return settings.presetId;
}

async function readSettings() {
  const values = await chrome.storage.local.get(Object.values(config.STORAGE_KEYS));
  const legacyKey =
    typeof values[config.STORAGE_KEYS.API_KEY] === 'string'
      ? values[config.STORAGE_KEYS.API_KEY].trim()
      : '';
  const providerKeys = normalizeProviderKeys(values[config.STORAGE_KEYS.PROVIDER_KEYS]);
  if (!providerKeys.deepseek && legacyKey) providerKeys.deepseek = legacyKey;
  const legacyModelId =
    typeof values[config.STORAGE_KEYS.MODEL_ID] === 'string'
      ? values[config.STORAGE_KEYS.MODEL_ID].trim()
      : '';
  const legacyEffort =
    typeof values[config.STORAGE_KEYS.EFFORT] === 'string'
      ? values[config.STORAGE_KEYS.EFFORT].trim()
      : '';
  const translationModelId =
    (typeof values[config.STORAGE_KEYS.TRANSLATION_MODEL_ID] === 'string' &&
      values[config.STORAGE_KEYS.TRANSLATION_MODEL_ID].trim()) ||
    legacyModelId ||
    config.DEFAULT_MODEL_ID;
  const translationEffortLevel =
    typeof values[config.STORAGE_KEYS.TRANSLATION_EFFORT] === 'string'
      ? values[config.STORAGE_KEYS.TRANSLATION_EFFORT].trim()
      : legacyEffort;
  const polishModelIdRaw =
    typeof values[config.STORAGE_KEYS.POLISH_MODEL_ID] === 'string'
      ? values[config.STORAGE_KEYS.POLISH_MODEL_ID].trim()
      : '';
  const polishEffortRaw =
    typeof values[config.STORAGE_KEYS.POLISH_EFFORT] === 'string'
      ? values[config.STORAGE_KEYS.POLISH_EFFORT].trim()
      : '';
  const polishModelId = polishModelIdRaw || translationModelId;
  const polishEffortLevel =
    polishEffortRaw ||
    (polishModelId === translationModelId ? translationEffortLevel : '');
  return {
    engine: JSON.stringify(config.TRANSLATION_ENGINE_KEYS.map((key) => values[key] ?? null)),
    hasStoredKey: Object.keys(providerKeys).length > 0,
    legacyApiKey: legacyKey,
    targetLang: normalizeTargetCode(values[config.STORAGE_KEYS.TARGET]),
    bilingual: normalizeBilingual(values[config.STORAGE_KEYS.BILINGUAL]),
    usage: usageUtils.normalizeStoredUsage(values[config.STORAGE_KEYS.USAGE]),
    translationModelId,
    translationEffortLevel,
    polishModelId,
    polishEffortLevel,
    polishInheritsModel: !polishModelIdRaw,
    polishInheritsEffort: !polishEffortRaw && polishModelId === translationModelId,
    // Legacy aliases kept for older UI builds and tests.
    modelId: translationModelId,
    effortLevel: translationEffortLevel,
    presetId:
      typeof values[config.STORAGE_KEYS.PRESET_ID] === 'string' &&
      values[config.STORAGE_KEYS.PRESET_ID].trim()
        ? values[config.STORAGE_KEYS.PRESET_ID].trim()
        : config.DEFAULT_PRESET_ID,
    providerKeys,
    customProvider: normalizeCustomProvider(values[config.STORAGE_KEYS.CUSTOM_PROVIDER]),
    customProviders: modelUtils.normalizeCustomProviders(
      values[config.STORAGE_KEYS.CUSTOM_PROVIDERS],
      values[config.STORAGE_KEYS.CUSTOM_PROVIDER]
    ),
    userModels: modelUtils.normalizeUserModels(values[config.STORAGE_KEYS.USER_MODELS]),
    visionCapabilities: { ...visionUtils.normalizeCache(values[config.STORAGE_KEYS.VISION_CAPABILITIES]), ...learnedVisionCapabilities },
    promptOverrides: normalizeOverrides(values[config.STORAGE_KEYS.PROMPT_OVERRIDES]),
    siteSettings: normalizeSiteSettings(values[config.STORAGE_KEYS.SITE_SETTINGS]),
    glossaryTidyEnabled: values[config.STORAGE_KEYS.GLOSSARY_TIDY_ENABLED] === true,
    glossaryTidyChapters: config.glossaryTidyChapters(values[config.STORAGE_KEYS.GLOSSARY_TIDY_CHAPTERS]),
    glossaryTidyPurpose: values[config.STORAGE_KEYS.GLOSSARY_TIDY_MODEL] === 'polish' ? 'polish' : 'translation'
  };
}

function runtimeSettingsForPurpose(settings, purpose, registry) {
  const polish = purpose === 'polish';
  const inheritsModel = polish && (settings.polishInheritsModel ||
    Boolean(registry && !modelUtils.getModel(registry, settings.polishModelId)));
  const inheritsEffort = polish && (settings.polishInheritsEffort ||
    (inheritsModel && !settings.polishEffortLevel));
  return {
    purpose: polish ? 'polish' : 'translation',
    label: polish ? '润色模型' : '翻译模型',
    modelId: polish && !inheritsModel ? settings.polishModelId : settings.translationModelId,
    effortLevel: polish && !inheritsEffort ? settings.polishEffortLevel : settings.translationEffortLevel,
    inheritsModel,
    inheritsEffort
  };
}

function getProviderApiKey(provider, settings) {
  if (!provider) return '';
  const key = settings.providerKeys[provider.id] || '';
  if (key) return key;
  if (provider.id === 'deepseek' && settings.legacyApiKey) return settings.legacyApiKey;
  return '';
}

/** The bundled registry plus the user's added providers and model names. */
function settingsRegistry(registry, settings) {
  return visionUtils.applyToRegistry(modelUtils.withUserModels(
    modelUtils.withCustomProviders(registry, settings.customProviders),
    settings.userModels
  ), settings.visionCapabilities);
}

/**
 * For a per-provider connection test: the translation or polish selection
 * when it uses this provider, otherwise the provider's first model.
 */
function providerTestSelection(settings, registry, providerId) {
  for (const purpose of ['translation', 'polish']) {
    const selection = runtimeSettingsForPurpose(settings, purpose, registry);
    const model = modelUtils.getModel(registry, selection.modelId);
    if (model && model.provider === providerId) return selection;
  }
  const model = modelUtils.listModels(registry, providerId)[0];
  if (!model) throw new PageAccessError('MODEL_CONFIG_ERROR', '该服务商没有可用的模型。');
  return { purpose: 'translation', label: model.name, modelId: model.id, effortLevel: model.defaultEffort };
}

async function resolveRuntime(purpose, hostname, providerId, settings) {
  settings ||= await readSettings();
  const registry = settingsRegistry(await loadRegistry(), settings);
  const selection = providerId
    ? providerTestSelection(settings, registry, providerId)
    : runtimeSettingsForPurpose(settings, purpose, registry);
  let resolved;
  try {
    resolved = modelUtils.resolveModel(registry, {
      modelId: selection.modelId,
      effortLevel: selection.effortLevel
    });
  } catch (error) {
    throw new PageAccessError(
      error.code || 'MODEL_CONFIG_ERROR',
      error.message || `${selection.label}配置不完整。`
    );
  }
  const apiKey = getProviderApiKey(resolved.provider, settings);
  if (resolved.provider.apiKeyRequired !== false && !apiKey) {
    throw new PageAccessError(
      'MISSING_API_KEY',
      `尚未配置 ${resolved.provider.name} 的 API Key（${selection.label}），请先在扩展设置中填写。`
    );
  }
  const activePresetId = sitePresetId(settings, hostname);
  const preset = await getActivePreset(settings, activePresetId);
  return {
    registry,
    settings,
    resolved,
    apiKey,
    preset,
    purpose: selection.purpose,
    hostname: hostname || '',
    requestedPresetId: activePresetId,
    presetId: preset && preset.id ? preset.id : activePresetId
  };
}
