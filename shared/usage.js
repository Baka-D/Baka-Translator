/**
 * Token usage accounting helpers. Pure functions so they can be unit-tested
 * without a browser extension runtime.
 *
 * DeepSeek/OpenAI return OpenAI-compatible usage:
 *   { prompt_tokens, completion_tokens, total_tokens,
 *     prompt_cache_hit_tokens | prompt_tokens_details.cached_tokens }
 */
(function initUsage(globalScope) {
  'use strict';

  const EMPTY_USAGE = Object.freeze({
    totalTokens: 0,
    promptTokens: 0,
    completionTokens: 0,
    cachedTokens: 0,
    requests: 0,
    estimatedCostUsd: 0,
    updatedAt: 0
  });

  const MAX_TOKEN_COUNT = Number.MAX_SAFE_INTEGER;
  const MAX_COST = 1e12;

  function tokenNumber(value) {
    const number = Number(value);
    if (!Number.isFinite(number) || number <= 0) return 0;
    return Math.min(MAX_TOKEN_COUNT, Math.floor(number));
  }

  function costNumber(value) {
    const number = Number(value);
    if (!Number.isFinite(number) || number <= 0) return 0;
    return Math.min(MAX_COST, number);
  }

  function pick(object, camel, snake) {
    if (!object || typeof object !== 'object') return undefined;
    if (object[camel] !== undefined) return object[camel];
    return object[snake];
  }

  function cachedTokenNumber(raw) {
    if (!raw || typeof raw !== 'object') return 0;
    if (typeof raw.cachedTokens !== 'undefined') return tokenNumber(raw.cachedTokens);
    if (typeof raw.cached_tokens !== 'undefined') return tokenNumber(raw.cached_tokens);
    if (typeof raw.prompt_cache_hit_tokens !== 'undefined') {
      return tokenNumber(raw.prompt_cache_hit_tokens);
    }
    if (raw.prompt_tokens_details && typeof raw.prompt_tokens_details === 'object') {
      return tokenNumber(raw.prompt_tokens_details.cached_tokens);
    }
    if (raw.input_tokens_details && typeof raw.input_tokens_details === 'object') {
      return tokenNumber(raw.input_tokens_details.cached_tokens);
    }
    return 0;
  }

  function normalizeApiUsage(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const promptTokens = tokenNumber(pick(raw, 'promptTokens', 'prompt_tokens'));
    const reported = tokenNumber(pick(raw, 'completionTokens', 'completion_tokens'));
    let totalTokens = tokenNumber(pick(raw, 'totalTokens', 'total_tokens'));
    if (!totalTokens) totalTokens = promptTokens + reported;
    // xAI and Gemini count reasoning in total_tokens only; it is billed as output.
    // The guard skips partial usage objects, where the gap means nothing.
    const hidden = promptTokens && reported ? Math.max(0, totalTokens - promptTokens - reported) : 0;
    const completionTokens = reported + hidden;
    if (!promptTokens && !completionTokens && !totalTokens) return null;
    const cachedTokens = Math.min(promptTokens, cachedTokenNumber(raw));
    return { promptTokens, completionTokens, totalTokens, cachedTokens };
  }

  function normalizeStoredUsage(raw) {
    if (!raw || typeof raw !== 'object') return { ...EMPTY_USAGE };
    return {
      totalTokens: tokenNumber(pick(raw, 'totalTokens', 'total_tokens')),
      promptTokens: tokenNumber(pick(raw, 'promptTokens', 'prompt_tokens')),
      completionTokens: tokenNumber(pick(raw, 'completionTokens', 'completion_tokens')),
      cachedTokens: tokenNumber(pick(raw, 'cachedTokens', 'cached_tokens')),
      requests: tokenNumber(raw.requests),
      estimatedCostUsd: costNumber(
        raw.estimatedCostUsd !== undefined ? raw.estimatedCostUsd : raw.costUsd
      ),
      updatedAt: tokenNumber(raw.updatedAt)
    };
  }

  /**
   * Add one billed API call to the persisted totals. `requests` counts only
   * successful calls; pass `countRequest: false` for a billed reply that was rejected.
   * @param {object|null} current stored stats
   * @param {object|null} apiUsage provider `usage` object
   * @param {{now?:number,billing?:object,countRequest?:boolean}|number} [optionsOrNow]
   */
  function mergeUsage(current, apiUsage, optionsOrNow) {
    const base = normalizeStoredUsage(current);
    const delta = normalizeApiUsage(apiUsage);
    if (!delta) return base;
    const options =
      optionsOrNow && typeof optionsOrNow === 'object' ? optionsOrNow : { now: optionsOrNow };
    const billing = options.billing && typeof options.billing === 'object' ? options.billing : null;
    const cachedTokens =
      billing && Number.isFinite(Number(billing.cacheHitTokens))
        ? Math.min(delta.promptTokens, tokenNumber(billing.cacheHitTokens))
        : delta.cachedTokens;
    const costUsd =
      billing && Number.isFinite(Number(billing.costUsd))
        ? costNumber(billing.costUsd)
        : 0;

    return {
      totalTokens: Math.min(MAX_TOKEN_COUNT, base.totalTokens + delta.totalTokens),
      promptTokens: Math.min(MAX_TOKEN_COUNT, base.promptTokens + delta.promptTokens),
      completionTokens: Math.min(MAX_TOKEN_COUNT, base.completionTokens + delta.completionTokens),
      cachedTokens: Math.min(MAX_TOKEN_COUNT, base.cachedTokens + cachedTokens),
      requests: Math.min(MAX_TOKEN_COUNT, base.requests + (options.countRequest === false ? 0 : 1)),
      estimatedCostUsd: Math.min(MAX_COST, base.estimatedCostUsd + costUsd),
      updatedAt:
        Number.isFinite(Number(options.now)) && Number(options.now) > 0
          ? Math.floor(Number(options.now))
          : Date.now()
    };
  }

  function formatTokenCount(value) {
    const number = tokenNumber(value);
    try {
      return number.toLocaleString('zh-CN');
    } catch (_error) {
      return String(number).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
    }
  }

  const api = Object.freeze({
    EMPTY_USAGE,
    normalizeApiUsage,
    normalizeStoredUsage,
    mergeUsage,
    formatTokenCount,
    cachedTokenNumber
  });

  globalScope.DSHT = globalScope.DSHT || {};
  globalScope.DSHT.usage = api;

  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this);
