/**
 * Anthropic Claude Messages API adapter (raw HTTP; the worker loads plain
 * scripts, so the SDK is not bundled). Converts the shared OpenAI-style
 * messages to Messages API requests and maps replies back to the
 * `{content, usage, finishReason}` shape the rest of api.js expects.
 */
(function initAnthropicApi(globalScope) {
  'use strict';

  const transport =
    (globalScope.DSHT && globalScope.DSHT.apiTransport) ||
    (typeof require === 'function' ? require('./api-transport.js') : null);
  const { ApiError } = transport;

  const API_VERSION = '2026-10-21';
  const FALLBACK_BETA = 'server-side-fallback-2026-07-01';

  function isAnthropic(provider) {
    return Boolean(provider && provider.protocol === 'anthropic');
  }

  function headers(apiKey, model) {
    const result = {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      'anthropic-version': API_VERSION,
      // Required for requests that carry a browser (extension) Origin.
      'anthropic-dangerous-direct-browser-access': 'true'
    };
    if (apiKey) result['x-api-key'] = apiKey;
    if (model && model.refusalFallback) result['anthropic-beta'] = FALLBACK_BETA;
    return result;
  }

  function toBlock(part) {
    if (typeof part === 'string') return { type: 'text', text: part };
    if (part && part.type === 'image_url') {
      const url = (part.image_url && part.image_url.url) || '';
      const match = /^data:(image\/[a-z]+);base64,(.+)$/i.exec(url);
      if (!match) throw new ApiError('图片格式不受支持。', { code: 'BAD_IMAGE', retryable: false });
      return { type: 'image', source: { type: 'base64', media_type: match[1].toLowerCase(), data: match[2] } };
    }
    return { type: 'text', text: String((part && part.text) || '') };
  }

  /** Messages API body. No temperature/top_p: API version 2026-10-21 rejects them. */
  function buildPayload({ model, effortLevel, messages, maxTokens }) {
    const system = [];
    const turns = [];
    for (const message of messages || []) {
      if (message.role === 'system') {
        system.push(String(message.content || ''));
        continue;
      }
      turns.push({
        role: message.role,
        content: Array.isArray(message.content) ? message.content.map(toBlock) : String(message.content || '')
      });
    }
    const body = {
      model: model.model,
      max_tokens: Math.max(1, Math.floor(maxTokens || 4096)),
      messages: turns
    };
    if (system.length > 0) body.system = system.join('\n\n');
    // Thinking stays adaptive (the default); effort is the only depth control.
    if (effortLevel && effortLevel !== 'none' && model.effortLevels.includes(effortLevel)) {
      body.output_config = { effort: effortLevel };
    }
    // On a safety decline the API re-runs the request on a suitable model.
    if (model.refusalFallback) body.fallbacks = 'default';
    return body;
  }

  /** OpenAI-style usage so usage stats and billing need no provider branches. */
  function normalizeUsage(raw) {
    if (!raw || typeof raw !== 'object') return null;
    // With fallbacks, top-level usage covers only the serving attempt; iterations lists every attempt.
    const attempts = Array.isArray(raw.iterations) && raw.iterations.length > 0 ? raw.iterations : [raw];
    const sum = (field) => attempts.reduce((total, item) => total + (Number(item && item[field]) || 0), 0);
    const cacheRead = sum('cache_read_input_tokens');
    // shortcut: cache writes are billed like misses here; the extension sends no cache_control.
    // shortcut: fallback attempts are priced at the requested model's rates; price per attempt model if it matters.
    const prompt = sum('input_tokens') + cacheRead + sum('cache_creation_input_tokens');
    const completion = sum('output_tokens');
    return {
      prompt_tokens: prompt,
      completion_tokens: completion,
      total_tokens: prompt + completion,
      cached_tokens: cacheRead
    };
  }

  function extractContent(data, providerName) {
    const label = providerName || '模型服务';
    const fail = (message, code, retryable) => new ApiError(message, { code, retryable });
    if (!data || !Array.isArray(data.content)) {
      throw fail(`${label} 未返回结果，请重试。`, 'EMPTY_RESPONSE', true);
    }
    if (data.stop_reason === 'max_tokens') {
      throw fail('翻译结果超出长度限制，请缩短文本或使用更大输出上限的模型。', 'OUTPUT_TRUNCATED', false);
    }
    if (data.stop_reason === 'refusal') {
      throw fail('内容被模型安全策略拦截，请尝试其他内容。', 'CONTENT_FILTERED', false);
    }
    // Thinking and fallback blocks carry no answer text.
    const content = data.content
      .filter((block) => block && block.type === 'text' && typeof block.text === 'string')
      .map((block) => block.text)
      .join('');
    if (!content.trim()) throw fail(`${label} 返回了空结果，请重试。`, 'EMPTY_RESPONSE', true);
    return { content, usage: normalizeUsage(data.usage), finishReason: data.stop_reason };
  }

  const api = Object.freeze({ API_VERSION, isAnthropic, headers, buildPayload, normalizeUsage, extractContent });
  globalScope.DSHT = globalScope.DSHT || {};
  globalScope.DSHT.anthropicApi = api;
  if (typeof module === 'object' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
