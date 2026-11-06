/** Provider model discovery; plain scripts keep keys inside the service worker. */
(function initApiModels(globalScope) {
  'use strict';
  const root = globalScope.DSHT || {};
  const config = root.config || (typeof require === 'function' ? require('../shared/config.js') : null);
  const modelsUtils = root.models || (typeof require === 'function' ? require('../shared/models.js') : null);
  const transport = root.apiTransport || (typeof require === 'function' ? require('./api-transport.js') : null);
  const anthropic = root.anthropicApi || (typeof require === 'function' ? require('./api-anthropic.js') : null);
  const { ApiError, validateApiKey, requestJson, buildHeaders } = transport;
  const MAX_PAGES = 10;

  function invalidResponse() {
    return new ApiError('模型列表格式异常或分页不完整，请稍后重试。', { code: 'INVALID_MODELS_RESPONSE' });
  }

  function discoveryRequest(provider, apiKey) {
    const url = new URL(modelsUtils.joinEndpoint(provider.endpoint, provider.modelsPath));
    const headers = anthropic.isAnthropic(provider) ? anthropic.headers(apiKey, null) : buildHeaders(apiKey);
    let shape = 'openai';
    if (provider.id === 'gemini') {
      url.pathname = url.pathname.replace(/\/openai\/models$/, '/models');
      url.searchParams.set('pageSize', '1000');
      delete headers.Authorization;
      headers['x-goog-api-key'] = apiKey;
      shape = 'gemini';
    } else if (provider.id === 'xai') {
      url.pathname = url.pathname.replace(/\/models$/, '/language-models');
      shape = 'xai';
    } else if (anthropic.isAnthropic(provider)) {
      url.searchParams.set('limit', '1000');
      shape = 'anthropic';
    }
    return { url, headers, shape };
  }

  function supportsChat(item, provider, shape) {
    if (!item || typeof item !== 'object') return false;
    const id = shape === 'gemini' ? item.name : item.id;
    if (typeof id !== 'string') return false;
    if (shape === 'gemini') {
      return Array.isArray(item.supportedGenerationMethods) &&
        item.supportedGenerationMethods.includes('generateContent') &&
        !/(?:image|audio|tts|live|robotics|computer-use)/i.test(id);
    }
    if (shape === 'xai') {
      return !Array.isArray(item.output_modalities) || item.output_modalities.includes('text');
    }
    if (provider.id === 'openai') {
      // shortcut: /models has no endpoint capabilities; update this filter for new Chat families.
      const family = id.startsWith('ft:') ? id.split(':')[1] : id;
      return /^(?:gpt-|chatgpt-|o\d+(?:-|$))/i.test(family) &&
        !/(?:image|audio|realtime|transcrib|tts|codex|deep-research|search|(?:^|-)pro(?:-|$))/i.test(family);
    }
    return true;
  }

  function nextPageToken(data, shape) {
    if (shape === 'gemini') {
      if (data.nextPageToken === undefined || data.nextPageToken === '') return '';
      if (typeof data.nextPageToken !== 'string') throw invalidResponse();
      return data.nextPageToken;
    }
    if (shape !== 'anthropic' || !data.has_more) return '';
    if (typeof data.last_id !== 'string' || !data.last_id) throw invalidResponse();
    return data.last_id;
  }

  async function fetchModels(options) {
    const opts = options || {};
    const provider = opts.provider;
    if (!provider || !provider.endpoint) {
      throw new ApiError('服务商缺少接口地址，请先保存接口配置。', { code: 'MISSING_ENDPOINT' });
    }
    const apiKey = validateApiKey(opts.apiKey, provider);
    const { url, headers, shape } = discoveryRequest(provider, apiKey);
    const deadline = Date.now() + (opts.timeoutMs || config.TIMEOUTS.TEST_MS);
    const names = new Set();
    const tokens = new Set();
    for (let page = 0; page < MAX_PAGES; page += 1) {
      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) throw new ApiError('获取模型超时，请稍后重试。', { code: 'TIMEOUT' });
      const data = await requestJson(url.toString(), {
        method: 'GET', headers, redirect: 'error', fetchImpl: opts.fetchImpl,
        timeoutMs: remainingMs, providerName: provider.name || provider.id
      }).catch((error) => {
        // Providers may echo even arbitrary gateway keys in their error details.
        if (error.code === 'BAD_REQUEST') error.message = '获取模型请求被拒绝，请检查 API Key 和接口地址。';
        error.providerMessage = '';
        throw error;
      });
      const list = shape === 'gemini' || shape === 'xai' ? data.models : data.data;
      if (!Array.isArray(list)) throw invalidResponse();
      for (const item of list) {
        if (!supportsChat(item, provider, shape)) continue;
        const name = (shape === 'gemini' ? item.name.replace(/^models\//, '') : item.id).trim();
        if (name && name.length <= 200 && !/\s/.test(name)) names.add(name);
      }
      const token = nextPageToken(data, shape);
      if (!token) return Array.from(names);
      if (tokens.has(token)) throw invalidResponse();
      tokens.add(token);
      url.searchParams.set(shape === 'gemini' ? 'pageToken' : 'after_id', token);
    }
    throw invalidResponse();
  }

  const api = Object.freeze({ fetchModels });
  globalScope.DSHT = globalScope.DSHT || {};
  globalScope.DSHT.apiModels = api;
  if (typeof module === 'object' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
