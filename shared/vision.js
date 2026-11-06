/** Locally learned negative vision capabilities; never stores keys or image content. */
(function initVision(globalScope) {
  'use strict';

  function endpointFor(model, provider) {
    try {
      const url = new URL(model?.endpoint || provider?.endpoint || '');
      if (!['https:', 'http:'].includes(url.protocol)) return '';
      url.username = '';
      url.password = '';
      url.search = '';
      url.hash = '';
      return url.toString().replace(/\/+$/, '');
    } catch (_error) {
      return '';
    }
  }

  function keyFor(model, provider) {
    const endpoint = endpointFor(model, provider);
    const name = typeof model?.model === 'string' ? model.model.trim() : '';
    const id = typeof provider?.id === 'string' ? provider.id.trim() : '';
    const protocol = typeof provider?.protocol === 'string' ? provider.protocol : 'openai';
    if (!endpoint || endpoint.length > 2048 || !id || id.length > 128 || !name || name.length > 200) return '';
    return JSON.stringify([id, protocol, endpoint, name]);
  }

  function normalizeCache(raw) {
    const result = {};
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return result;
    for (const [key, value] of Object.entries(raw)) {
      if (value !== true || key.length > 2600) continue;
      try {
        const tuple = JSON.parse(key);
        if (!Array.isArray(tuple) || tuple.length !== 4 || tuple.some((part) => typeof part !== 'string')) continue;
        const [id, protocol, endpoint, model] = tuple;
        if (keyFor({ endpoint, model }, { id, protocol }) === key) result[key] = true;
      } catch (_error) {
        // Ignore malformed or obsolete entries.
      }
    }
    return result;
  }

  function isDisabled(model, provider, rawCache) {
    return model?.supportsVision === false || rawCache?.[keyFor(model, provider)] === true;
  }

  function applyToRegistry(registry, rawCache) {
    if (!registry || !Array.isArray(registry.models)) return registry;
    const cache = normalizeCache(rawCache);
    return { ...registry, models: registry.models.map((model) => {
      const provider = registry.providers?.[model.provider];
      return cache[keyFor(model, provider)] === true
        ? { ...model, supportsVision: false, visionUnsupported: true, visionUnverified: false }
        : model;
    }) };
  }

  const api = Object.freeze({ keyFor, normalizeCache, isDisabled, applyToRegistry });
  globalScope.DSHT = globalScope.DSHT || {};
  globalScope.DSHT.vision = api;
  if (typeof module === 'object' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
