/**
 * Model registry helpers. The actual registry lives in profile/ (one file per provider) so
 * users can edit model names, endpoints, context sizes, efforts and pricing
 * without touching extension code.
 */
(function initModels(globalScope) {
  'use strict';

  function isObject(value) {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
  }

  function trimString(value, fallback) {
    return typeof value === 'string' && value.trim() ? value.trim() : fallback;
  }

  function positiveInteger(value, fallback) {
    const number = Number(value);
    if (!Number.isFinite(number) || number <= 0) return fallback;
    return Math.floor(number);
  }

  function normalizePath(value, fallback) {
    const path = trimString(value, fallback);
    return path.startsWith('/') ? path : `/${path}`;
  }

  function normalizeEndpoint(value) {
    const text = trimString(value, '');
    if (!text) return '';
    try {
      const url = new URL(text);
      if (url.protocol !== 'https:' && url.protocol !== 'http:') return '';
      return text.replace(/\/+$/, '');
    } catch (_error) {
      return '';
    }
  }

  function uniqueStrings(values) {
    if (!Array.isArray(values)) return [];
    const out = [];
    const seen = new Set();
    for (const value of values) {
      if (typeof value !== 'string') continue;
      const text = value.trim();
      if (!text || seen.has(text)) continue;
      seen.add(text);
      out.push(text);
    }
    return out;
  }

  function normalizeProvider(raw, id) {
    if (!isObject(raw)) return null;
    const providerId = trimString(raw.id, id);
    if (!providerId) return null;
    return {
      id: providerId,
      name: trimString(raw.name, providerId),
      endpoint: normalizeEndpoint(raw.endpoint),
      completionsPath: normalizePath(raw.completionsPath, '/chat/completions'),
      modelsPath: normalizePath(raw.modelsPath, '/models'),
      protocol: trimString(raw.protocol, 'openai'),
      requestShape: trimString(raw.requestShape, 'openai'),
      requiresEndpoint: raw.requiresEndpoint === true,
      apiKeyRequired: raw.apiKeyRequired !== false,
      apiKeyLabel: trimString(raw.apiKeyLabel, `${providerId} API Key`),
      apiKeyPlaceholder: trimString(raw.apiKeyPlaceholder, ''),
      apiKeyPrefix: trimString(raw.apiKeyPrefix, ''),
      imageDetail: raw.imageDetail !== false,
      docsUrl: trimString(raw.docsUrl, '')
    };
  }

  function normalizeModel(raw, providers) {
    if (!isObject(raw)) return null;
    const id = trimString(raw.id, '');
    const providerId = trimString(raw.provider, '');
    if (!id || !providers[providerId]) return null;
    const provider = providers[providerId];
    const effortLevels = uniqueStrings(raw.effortLevels);
    const levels = effortLevels.length > 0 ? effortLevels : ['none'];
    const defaultEffort = levels.includes(trimString(raw.defaultEffort, ''))
      ? trimString(raw.defaultEffort, '')
      : levels[0];
    return {
      id,
      provider: providerId,
      name: trimString(raw.name, id),
      model: trimString(raw.model, ''),
      endpoint: normalizeEndpoint(raw.endpoint) || provider.endpoint,
      contextWindow: positiveInteger(raw.contextWindow, 128000),
      maxOutputTokens: positiveInteger(raw.maxOutputTokens, 8192),
      outputFloor: positiveInteger(raw.outputFloor, 0),
      effortLevels: levels,
      defaultEffort,
      thinkingParam: trimString(raw.thinkingParam, '') || null,
      effortParam: trimString(raw.effortParam, '') || null,
      supportsVision: raw.supportsVision === true,
      supportsJson: raw.supportsJson !== false,
      maxTokensParam: trimString(raw.maxTokensParam, 'max_tokens'),
      refusalFallback: raw.refusalFallback === true,
      pricing: isObject(raw.pricing) ? raw.pricing : null
    };
  }

  /** Raw registry from profile/index.json and its per-provider files. */
  function assembleRegistry(index, providerFiles) {
    const source = isObject(index) ? index : {};
    const providers = {};
    const models = [];
    for (const file of providerFiles || []) {
      if (!isObject(file)) continue;
      const { models: list, ...provider } = file;
      providers[provider.id] = provider;
      for (const model of Array.isArray(list) ? list : []) models.push({ ...model, provider: provider.id });
    }
    return { version: source.version, defaultModelId: source.defaultModelId, providers, models };
  }

  /** @param {(path:string)=>Promise<object>} readJson reads an extension file */
  async function loadRegistryFiles(readJson, indexPath) {
    const index = await readJson(indexPath);
    const folder = indexPath.slice(0, indexPath.lastIndexOf('/') + 1);
    const ids = isObject(index) && Array.isArray(index.providers) ? index.providers : [];
    const files = await Promise.all(ids.map((id) => readJson(`${folder}${id}.json`)));
    return normalizeRegistry(assembleRegistry(index, files));
  }

  function normalizeRegistry(raw) {
    const source = isObject(raw) ? raw : {};
    const providers = {};
    if (isObject(source.providers)) {
      for (const [id, providerRaw] of Object.entries(source.providers)) {
        const provider = normalizeProvider(providerRaw, id);
        if (provider) providers[provider.id] = provider;
      }
    }

    const models = [];
    const seen = new Set();
    if (Array.isArray(source.models)) {
      for (const modelRaw of source.models) {
        const model = normalizeModel(modelRaw, providers);
        if (!model || seen.has(model.id)) continue;
        seen.add(model.id);
        models.push(model);
      }
    }

    let defaultModelId = trimString(source.defaultModelId, '');
    if (!seen.has(defaultModelId)) {
      defaultModelId = models.length > 0 ? models[0].id : '';
    }

    return {
      version: positiveInteger(source.version, 1),
      defaultModelId,
      providers,
      models
    };
  }

  function getModel(registry, modelId) {
    if (!registry || !Array.isArray(registry.models)) return null;
    // A user-added name the provider later gained as its own model keeps working under the stored id.
    return registry.models.find((model) => (
      model.id === modelId || userModelId(model.provider, model.model) === modelId
    )) || null;
  }

  function getProvider(registry, providerId) {
    if (!registry || !isObject(registry.providers)) return null;
    return registry.providers[providerId] || null;
  }

  function listModels(registry, providerId) {
    if (!registry || !Array.isArray(registry.models)) return [];
    return providerId
      ? registry.models.filter((model) => model.provider === providerId)
      : registry.models.slice();
  }

  function joinEndpoint(endpoint, path) {
    const base = normalizeEndpoint(endpoint);
    if (!base) return '';
    const suffix = normalizePath(path, '/chat/completions');
    return base + suffix;
  }

  /**
   * Resolve the selected model plus any custom-provider overrides.
   * @returns {{model:object, provider:object, endpoint:string, requestUrl:string}}
   */
  function resolveModel(registry, options) {
    const opts = options || {};
    if (isCustomModelId(opts.modelId) && !getModel(registry, opts.modelId)) {
      // Never send text to a different provider than the one the user picked.
      const error = new Error('所选的自定义服务商或模型已不存在，请在设置页重新添加，或改选其他模型。');
      error.code = 'MISSING_CUSTOM_PROVIDER';
      throw error;
    }
    const model = getModel(registry, opts.modelId) || getModel(registry, registry && registry.defaultModelId);
    if (!model) {
      const error = new Error('没有可用的模型，请检查 profile/ 下的模型配置。');
      error.code = 'NO_MODELS';
      throw error;
    }
    const provider = getProvider(registry, model.provider);
    if (!provider) {
      const error = new Error(`模型 ${model.id} 的 provider 不存在。`);
      error.code = 'MISSING_PROVIDER';
      throw error;
    }

    const custom = isObject(opts.customProvider) ? opts.customProvider : {};
    const isCustom = provider.id === 'custom' || provider.requiresEndpoint;
    const endpoint = normalizeEndpoint(
      isCustom ? custom.endpoint || model.endpoint : model.endpoint || provider.endpoint
    );
    if (!endpoint) {
      const error = new Error(
        isCustom ? '请先在高级设置中填写自定义接口地址。' : `模型 ${model.id} 缺少接口地址。`
      );
      error.code = isCustom ? 'MISSING_CUSTOM_ENDPOINT' : 'MISSING_ENDPOINT';
      throw error;
    }

    const modelName = isCustom ? trimString(custom.model, model.model) : model.model;
    if (!modelName) {
      const error = new Error('请先在高级设置中填写自定义模型名称。');
      error.code = 'MISSING_MODEL_NAME';
      throw error;
    }

    const effort = model.effortLevels.includes(opts.effortLevel)
      ? opts.effortLevel
      : model.defaultEffort;

    return {
      model: { ...model, model: modelName, endpoint },
      provider,
      endpoint,
      requestUrl: joinEndpoint(endpoint, provider.completionsPath),
      modelsUrl: joinEndpoint(endpoint, provider.modelsPath),
      effort
    };
  }

  const CUSTOM_TEMPLATE_ID = 'custom';
  const CUSTOM_ID_PATTERN = /^custom(-[a-z0-9]{1,24})?$/;
  const MAX_CUSTOM_PROVIDERS = 20;
  const MAX_USER_MODELS = 500;

  function customModelId(providerId) {
    return `${providerId}-model`;
  }

  /** Ids that exist only through the user's settings, so they can go missing. */
  function isCustomModelId(modelId) {
    return typeof modelId === 'string' &&
      (/^custom(-[a-z0-9]{1,24})?-model$/.test(modelId) || modelId.startsWith('user:'));
  }

  function userModelId(providerId, name) {
    return `user:${providerId}:${name}`;
  }

  /** `{providerId: [model names]}` the user added on top of the provider's own models. */
  function normalizeUserModels(raw) {
    const result = {};
    if (!isObject(raw)) return result;
    for (const [providerId, names] of Object.entries(raw)) {
      const clean = uniqueStrings(names).filter((name) => name.length <= 200 && !/\s/.test(name));
      if (clean.length > 0) result[providerId] = clean.slice(0, MAX_USER_MODELS);
    }
    return result;
  }

  /**
   * Add model names with the provider's endpoint and conservative request defaults.
   * shortcut: capabilities and pricing are unknown; add a profile for exact values.
   */
  function withUserModels(registry, userModels) {
    if (!registry || !Array.isArray(registry.models)) return registry;
    const models = registry.models.slice();
    for (const [providerId, names] of Object.entries(userModels || {})) {
      const template = registry.models.find((model) => model.provider === providerId);
      if (!template) continue;
      for (const name of names) {
        if (models.some((model) => model.provider === providerId && model.model === name)) continue;
        models.push({
          ...template, id: userModelId(providerId, name), name, model: name,
          effortLevels: ['none'], defaultEffort: 'none', thinkingParam: null, effortParam: null,
          outputFloor: 0, maxOutputTokens: 4096, supportsJson: false,
          supportsVision: true, visionUnverified: true,
          pricing: null, refusalFallback: false, userAdded: true
        });
      }
    }
    return { ...registry, models };
  }

  /**
   * User-added OpenAI-compatible providers. Falls back to the legacy single
   * `customProvider` slot, which becomes the provider with id `custom`.
   */
  function normalizeCustomProviders(list, legacy) {
    const source = Array.isArray(list)
      ? list
      : isObject(legacy) && (trimString(legacy.endpoint, '') || trimString(legacy.model, ''))
        ? [{ ...legacy, id: CUSTOM_TEMPLATE_ID }]
        : [];
    const seen = new Set();
    const result = [];
    for (const raw of source) {
      if (!isObject(raw)) continue;
      const id = trimString(raw.id, '');
      if (!CUSTOM_ID_PATTERN.test(id) || seen.has(id)) continue;
      seen.add(id);
      result.push({
        id,
        name: trimString(raw.name, '').slice(0, 60),
        endpoint: normalizeEndpoint(raw.endpoint),
        model: trimString(raw.model, '').slice(0, 200)
      });
      if (result.length >= MAX_CUSTOM_PROVIDERS) break;
    }
    return result;
  }

  /** Replace the `custom` template with one provider + model per user-added provider. */
  function withCustomProviders(registry, customProviders) {
    if (!registry || !isObject(registry.providers) || !Array.isArray(registry.models)) return registry;
    const template = registry.providers[CUSTOM_TEMPLATE_ID];
    const templateModel = registry.models.find((model) => model.provider === CUSTOM_TEMPLATE_ID);
    if (!template || !templateModel) return registry;
    const providers = { ...registry.providers };
    delete providers[CUSTOM_TEMPLATE_ID];
    const models = registry.models.filter((model) => model.provider !== CUSTOM_TEMPLATE_ID);
    for (const entry of customProviders || []) {
      providers[entry.id] = {
        ...template, id: entry.id, name: entry.name || template.name, endpoint: entry.endpoint, custom: true
      };
      models.push({
        ...templateModel,
        id: customModelId(entry.id),
        provider: entry.id,
        name: entry.model || templateModel.name,
        model: entry.model,
        endpoint: entry.endpoint
      });
    }
    const defaultModelId = models.some((model) => model.id === registry.defaultModelId)
      ? registry.defaultModelId
      : (models[0] && models[0].id) || '';
    return {
      ...registry, providers, models, defaultModelId,
      customTemplate: { provider: template, model: templateModel }
    };
  }

  function apiKeyRequired(resolved) {
    return Boolean(resolved && resolved.provider && resolved.provider.apiKeyRequired);
  }

  const api = Object.freeze({
    normalizeRegistry,
    normalizeProvider,
    normalizeModel,
    normalizeEndpoint,
    getModel,
    getProvider,
    listModels,
    resolveModel,
    joinEndpoint,
    apiKeyRequired,
    customModelId,
    isCustomModelId,
    userModelId,
    normalizeCustomProviders,
    normalizeUserModels,
    withCustomProviders,
    withUserModels,
    assembleRegistry,
    loadRegistryFiles,
    MAX_CUSTOM_PROVIDERS,
    MAX_USER_MODELS
  });

  globalScope.DSHT = globalScope.DSHT || {};
  globalScope.DSHT.models = api;

  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this);
