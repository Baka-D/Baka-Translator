/**
 * Peak/off-peak pricing and token cost estimation.
 *
 * Prices are configured per model in profile/. DeepSeek uses
 * different rates during its documented peak windows; OpenAI/custom models can
 * use a flat rate. All calculations are estimates, not billing statements.
 */
(function initBilling(globalScope) {
  'use strict';

  const DEFAULT_CURRENCY = 'USD';
  const DEFAULT_UNIT = 'per_million_tokens';

  function isObject(value) {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
  }

  function nonNegativeNumber(value) {
    const number = Number(value);
    return Number.isFinite(number) && number >= 0 ? number : 0;
  }

  function tokenCount(value) {
    const number = Number(value);
    if (!Number.isFinite(number) || number <= 0) return 0;
    return Math.floor(number);
  }

  function normalizeRates(raw) {
    if (!isObject(raw)) return null;
    const rates = {
      inputCacheHit: nonNegativeNumber(raw.inputCacheHit),
      inputCacheMiss: nonNegativeNumber(raw.inputCacheMiss),
      output: nonNegativeNumber(raw.output)
    };
    if (rates.inputCacheHit === 0 && rates.inputCacheMiss === 0 && rates.output === 0) {
      return null;
    }
    return rates;
  }

  function normalizeWindows(raw) {
    if (!Array.isArray(raw)) return [];
    const windows = [];
    for (const item of raw) {
      if (!isObject(item)) continue;
      const start = Number(item.start);
      const end = Number(item.end);
      if (!Number.isFinite(start) || !Number.isFinite(end)) continue;
      if (start < 0 || start > 24 || end < 0 || end > 24 || start === end) continue;
      windows.push({ start, end });
    }
    return windows;
  }

  function normalizePricing(raw) {
    if (!isObject(raw)) return null;
    const peak = normalizeRates(raw.peak);
    const offPeak = normalizeRates(raw.offPeak);
    const flat = normalizeRates(raw.flat);
    if (!flat && (!peak || !offPeak)) return null;
    const weekdays = Array.isArray(raw.peakWeekdays)
      ? raw.peakWeekdays
          .map((day) => Number(day))
          .filter((day) => Number.isInteger(day) && day >= 0 && day <= 6)
      : [1, 2, 3, 4, 5];
    return {
      currency: typeof raw.currency === 'string' && raw.currency.trim()
        ? raw.currency.trim().toUpperCase()
        : DEFAULT_CURRENCY,
      unit: typeof raw.unit === 'string' && raw.unit.trim() ? raw.unit.trim() : DEFAULT_UNIT,
      flat,
      peak,
      offPeak,
      peakWindowsUtc: normalizeWindows(raw.peakWindowsUtc),
      peakWeekdays: weekdays,
      holidayDates: Array.isArray(raw.holidayDates)
        ? raw.holidayDates.filter((date) => typeof date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(date))
        : [],
      source: typeof raw.source === 'string' ? raw.source : ''
    };
  }

  function normalizeBillingUsage(raw) {
    const source = isObject(raw) ? raw : {};
    const promptTokens = tokenCount(
      source.promptTokens !== undefined ? source.promptTokens : source.prompt_tokens
    );
    const reported = tokenCount(
      source.completionTokens !== undefined ? source.completionTokens : source.completion_tokens
    );
    let totalTokens = tokenCount(
      source.totalTokens !== undefined ? source.totalTokens : source.total_tokens
    );
    if (!totalTokens) totalTokens = promptTokens + reported;
    // xAI and Gemini count reasoning in total_tokens only; it is billed as output.
    // The guard skips partial usage objects, where the gap means nothing.
    const hidden = promptTokens && reported ? Math.max(0, totalTokens - promptTokens - reported) : 0;
    const completionTokens = reported + hidden;

    let cachedTokens = 0;
    if (typeof source.cachedTokens !== 'undefined') cachedTokens = tokenCount(source.cachedTokens);
    else if (typeof source.cached_tokens !== 'undefined') cachedTokens = tokenCount(source.cached_tokens);
    else if (typeof source.prompt_cache_hit_tokens !== 'undefined') {
      cachedTokens = tokenCount(source.prompt_cache_hit_tokens);
    } else if (isObject(source.prompt_tokens_details)) {
      cachedTokens = tokenCount(source.prompt_tokens_details.cached_tokens);
    } else if (isObject(source.input_tokens_details)) {
      cachedTokens = tokenCount(source.input_tokens_details.cached_tokens);
    }
    cachedTokens = Math.min(promptTokens, cachedTokens);

    return { promptTokens, completionTokens, totalTokens, cachedTokens };
  }

  function isoDateUtc(date) {
    return date.toISOString().slice(0, 10);
  }

  function isPeakPeriod(pricing, at) {
    const normalized = isObject(pricing) && pricing.currency ? pricing : normalizePricing(pricing);
    if (!normalized || normalized.flat) return false;
    const date = at instanceof Date ? at : new Date(at === undefined ? Date.now() : at);
    if (Number.isNaN(date.getTime())) return false;
    if (!normalized.peakWeekdays.includes(date.getUTCDay())) return false;
    if (normalized.holidayDates.includes(isoDateUtc(date))) return false;
    if (normalized.peakWindowsUtc.length === 0) return false;
    const minutes = date.getUTCHours() * 60 + date.getUTCMinutes();
    return normalized.peakWindowsUtc.some((window) => {
      const start = window.start * 60;
      const end = window.end * 60;
      if (start < end) return minutes >= start && minutes < end;
      return minutes >= start || minutes < end;
    });
  }

  function ratesForPeriod(pricing, at) {
    const normalized = isObject(pricing) && pricing.currency ? pricing : normalizePricing(pricing);
    if (!normalized) return null;
    if (normalized.flat) return { period: 'flat', rates: normalized.flat, pricing: normalized };
    const peak = isPeakPeriod(normalized, at);
    return {
      period: peak ? 'peak' : 'offPeak',
      rates: peak ? normalized.peak : normalized.offPeak,
      pricing: normalized
    };
  }

  /**
   * @returns {{available:boolean,costUsd:number,currency:string,period:string,
   *            rates:object|null,promptTokens:number,completionTokens:number,
   *            totalTokens:number,cacheHitTokens:number,cacheMissTokens:number}}
   */
  function estimateCost(pricing, usage, at) {
    const normalizedPricing = normalizePricing(pricing);
    const normalizedUsage = normalizeBillingUsage(usage);
    if (!normalizedPricing) {
      return {
        available: false,
        costUsd: 0,
        currency: DEFAULT_CURRENCY,
        period: 'unknown',
        rates: null,
        ...normalizedUsage,
        cacheHitTokens: normalizedUsage.cachedTokens,
        cacheMissTokens: normalizedUsage.promptTokens - normalizedUsage.cachedTokens
      };
    }

    const selected = ratesForPeriod(normalizedPricing, at);
    const rates = selected.rates;
    const cacheHitTokens = Math.min(normalizedUsage.cachedTokens, normalizedUsage.promptTokens);
    const cacheMissTokens = Math.max(0, normalizedUsage.promptTokens - cacheHitTokens);
    const rawCost =
      (cacheHitTokens / 1e6) * rates.inputCacheHit +
      (cacheMissTokens / 1e6) * rates.inputCacheMiss +
      (normalizedUsage.completionTokens / 1e6) * rates.output;

    return {
      available: true,
      costUsd: Math.round(rawCost * 1e10) / 1e10,
      currency: normalizedPricing.currency,
      period: selected.period,
      rates,
      promptTokens: normalizedUsage.promptTokens,
      completionTokens: normalizedUsage.completionTokens,
      totalTokens: normalizedUsage.totalTokens,
      cacheHitTokens,
      cacheMissTokens
    };
  }

  function formatCost(value, currency, options) {
    const opts = options || {};
    const amount = Number(value);
    if (!Number.isFinite(amount) || amount < 0) return '—';
    const code = typeof currency === 'string' && currency ? currency.toUpperCase() : DEFAULT_CURRENCY;
    const fractionDigits = Number.isInteger(opts.fractionDigits) ? opts.fractionDigits : 4;
    const smallest = (1 / 10 ** fractionDigits).toFixed(fractionDigits);
    const rounded = amount.toFixed(fractionDigits);
    const isTiny = amount > 0 && Number(rounded) === 0;
    if (isTiny) return code === 'USD' ? `<$${smallest}` : `<${smallest} ${code}`;
    return code === 'USD' ? `$${rounded}` : `${rounded} ${code}`;
  }

  const api = Object.freeze({
    DEFAULT_CURRENCY,
    normalizePricing,
    normalizeBillingUsage,
    isPeakPeriod,
    ratesForPeriod,
    estimateCost,
    formatCost
  });

  globalScope.DSHT = globalScope.DSHT || {};
  globalScope.DSHT.billing = api;

  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this);
