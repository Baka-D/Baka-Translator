/** HTTP transport, API errors and bounded retries shared by provider calls. */
(function initApiTransport(globalScope) {
  'use strict';
  const config =
    (globalScope.DSHT && globalScope.DSHT.config) ||
    (typeof require === 'function' ? require('../shared/config.js') : null);
  const MAX_RESPONSE_BYTES = 32 * 1024 * 1024;

  class ApiError extends Error {
    constructor(message, options) {
      super(message);
      const opts = options || {};
      this.name = 'ApiError';
      this.code = opts.code || 'API_ERROR';
      this.status = opts.status || 0;
      this.retryable = Boolean(opts.retryable);
      this.retryAfterMs = opts.retryAfterMs || 0;
      this.providerMessage = opts.providerMessage || '';
    }
  }

  function missingKeyError(providerName) {
    return new ApiError(
      `尚未配置 ${providerName || '模型服务'} 的 API Key，请先在扩展设置中填写。`,
      { code: 'MISSING_API_KEY', retryable: false }
    );
  }

  function validateApiKey(apiKey, provider) {
    const key = typeof apiKey === 'string' ? apiKey.trim() : '';
    if (!key) {
      if (provider && provider.apiKeyRequired === false) return '';
      throw missingKeyError(provider && (provider.name || provider.id));
    }
    if (key.length > 512 || /[\r\n]/.test(key)) {
      throw new ApiError('API Key 格式不正确。', {
        code: 'INVALID_API_KEY_FORMAT',
        retryable: false
      });
    }
    return key;
  }

  // shortcut: only the literal key is caught, not an encoded or partial echo; drop the 400 detail if gateways do that.
  function trimProviderMessage(value, apiKey) {
    const text = String(value || '');
    return (apiKey ? text.replaceAll(apiKey, '[redacted key]') : text)
      .replace(/\b(?:sk-|xai-|AIza)[A-Za-z0-9_-]{8,}\b/g, '[redacted key]')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 300);
  }

  function mapHttpError(status, payload, rawText, headers, providerName, apiKey) {
    const label = providerName || '模型服务';
    const providerMessage = trimProviderMessage(
      (payload && payload.error && payload.error.message) ||
        (payload && payload.message) ||
        rawText,
      apiKey
    );
    const retryAfterHeader = getHeader(headers, 'retry-after');
    const retryAfterSeconds = Number(retryAfterHeader);
    const retryAfterMs =
      Number.isFinite(retryAfterSeconds) && retryAfterSeconds > 0
        ? Math.min(10000, retryAfterSeconds * 1000)
        : 0;
    const detail = providerMessage ? `（${providerMessage}）` : '';

    if (status === 401) {
      return new ApiError(`${label} API Key 无效或已失效，请在设置中更新。`, {
        code: 'AUTH_FAILED',
        status,
        retryable: false,
        providerMessage
      });
    }
    if (status === 403) {
      return new ApiError(`${label} 拒绝访问${detail}，可能是 Key 无效、地区或模型权限受限。`, {
        code: 'AUTH_FAILED',
        status,
        retryable: false,
        providerMessage
      });
    }
    if (status === 402) {
      return new ApiError(`${label} 账户余额不足，请充值后再试。`, {
        code: 'INSUFFICIENT_BALANCE',
        status,
        retryable: false,
        providerMessage
      });
    }
    if (status === 429) {
      const apiError = payload && payload.error;
      const quotaCodes = [
        'insufficient_quota',
        'credit_balance_exhausted',
        'organization_usage_limit_exceeded',
        'organization_spend_limit_exceeded',
        'project_spend_limit_exceeded'
      ];
      if (apiError && (quotaCodes.includes(apiError.code) || apiError.type === 'insufficient_quota')) {
        return new ApiError(`${label} 余额或可用额度不足，请检查 API 账户余额与用量限额。`, {
          code: 'INSUFFICIENT_BALANCE',
          status,
          retryable: false,
          providerMessage
        });
      }
      return new ApiError(`${label} 请求过于频繁，请稍后重试。`, {
        code: 'RATE_LIMITED',
        status,
        retryable: true,
        retryAfterMs
      });
    }
    if (status >= 500) {
      return new ApiError(`${label} 服务暂时不可用，请稍后重试。`, {
        code: 'SERVICE_UNAVAILABLE',
        status,
        retryable: true,
        retryAfterMs: retryAfterMs || 1200,
        providerMessage
      });
    }
    if (status === 400) {
      return new ApiError(`${label} 拒绝了请求${detail}，请重试或检查模型参数。`, {
        code: 'BAD_REQUEST',
        status,
        retryable: false,
        providerMessage
      });
    }
    if (status === 404) {
      return new ApiError(`${label} 接口或模型不存在（HTTP 404）${detail}，请检查模型接入点和模型名称。`, {
        code: 'ENDPOINT_NOT_FOUND',
        status,
        retryable: false,
        providerMessage
      });
    }
    return new ApiError(`${label} 请求失败（HTTP ${status}）${detail}，请稍后重试。`, {
      code: 'HTTP_ERROR',
      status,
      retryable: status >= 500,
      retryAfterMs,
      providerMessage
    });
  }

  function getHeader(headers, name) {
    if (!headers) return '';
    if (typeof headers.get === 'function') return headers.get(name) || '';
    const lower = name.toLowerCase();
    for (const key of Object.keys(headers)) {
      if (key.toLowerCase() === lower) return headers[key] || '';
    }
    return '';
  }

  async function readBoundedText(response, providerName) {
    if (!response.body) return response.text();
    const reader = response.body.getReader();
    const chunks = [];
    let bytes = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) return new Blob(chunks).text();
      bytes += value.byteLength;
      if (bytes > MAX_RESPONSE_BYTES) {
        reader.cancel().catch(() => {});
        throw new ApiError(`${providerName || '模型服务'} 返回的响应过大，请检查接口地址。`, {
          code: 'RESPONSE_TOO_LARGE',
          retryable: false
        });
      }
      chunks.push(value);
    }
  }

  function readResponseBody(response, providerName) {
    if (!response) return Promise.resolve({ text: '', payload: null });
    if (typeof response.text === 'function') {
      return readBoundedText(response, providerName).then((text) => {
        const raw = String(text || '').replace(/^\uFEFF/, '');
        let payload = null;
        if (raw.trim()) {
          try {
            payload = JSON.parse(raw);
          } catch (_error) {
            payload = null;
          }
        }
        return { text: raw, payload };
      });
    }
    if (typeof response.json === 'function') {
      return response
        .json()
        .then((payload) => ({ text: JSON.stringify(payload), payload }));
    }
    return Promise.resolve({ text: '', payload: null });
  }

  function defaultSleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  async function requestJson(url, options) {
    const opts = options || {};
    const fetchImpl = opts.fetchImpl || globalScope.fetch;
    if (typeof fetchImpl !== 'function') {
      throw new ApiError('当前运行环境不支持网络请求。', {
        code: 'FETCH_UNAVAILABLE',
        retryable: false
      });
    }

    const controller = new AbortController();
    const timeoutMs = opts.timeoutMs || config.TIMEOUTS.REQUEST_MS;
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetchImpl(url, {
        method: opts.method || 'GET',
        headers: opts.headers,
        body: opts.body,
        signal: controller.signal,
        credentials: 'omit',
        cache: 'no-store',
        redirect: 'manual'
      });
      // Page text must not follow a redirect to a host the user never chose.
      if (response.type === 'opaqueredirect') {
        throw new ApiError(
          `${opts.providerName || '模型服务'} 的接口地址发生了跳转，请在设置中填写跳转后的最终地址。`,
          { code: 'REDIRECT_BLOCKED' }
        );
      }
      const { text, payload } = await readResponseBody(response, opts.providerName);
      if (!response.ok) {
        throw mapHttpError(
          response.status,
          payload,
          text,
          response.headers,
          opts.providerName,
          opts.apiKey
        );
      }
      if (!payload || typeof payload !== 'object') {
        const rawText = String(text || '').trim();
        if (!rawText) {
          throw new ApiError(`${opts.providerName || '模型服务'} 返回了空响应，请重试。`, {
            code: 'EMPTY_RESPONSE',
            retryable: true
          });
        }
        const contentType = getHeader(response.headers, 'content-type');
        const html = /html/i.test(contentType);
        throw new ApiError(
          html
            ? `${opts.providerName || '模型服务'} 返回了网页而不是 JSON，可能被网络代理或网关拦截，请检查代理后重试。`
            : `${opts.providerName || '模型服务'} 返回了无法解析的响应（可能被截断）${contentType ? `，Content-Type: ${contentType}` : ''}，请重试。`,
          {
            code: 'INVALID_HTTP_RESPONSE',
            retryable: true
          }
        );
      }
      return payload;
    } catch (error) {
      if (error instanceof ApiError) throw error;
      if (
        controller.signal.aborted ||
        error.name === 'AbortError' ||
        error.name === 'TimeoutError'
      ) {
        throw new ApiError(`${opts.providerName || '模型服务'} 响应超时，请稍后重试。`, {
          code: 'TIMEOUT',
          // Long reasoning responses may legitimately exceed two minutes;
          // retrying a timed-out request blindly makes the UI appear hung.
          retryable: false
        });
      }
      throw new ApiError(
        `无法连接 ${opts.providerName || '模型服务'}，请检查网络、代理或自定义接口权限。`,
        { code: 'NETWORK_ERROR', retryable: true }
      );
    } finally {
      clearTimeout(timer);
    }
  }

  async function withRetries(operation, options) {
    const opts = options || {};
    const maxRetries =
      Number.isFinite(opts.maxRetries)
        ? opts.maxRetries
        : config.TIMEOUTS.API_MAX_RETRIES;
    const sleep = opts.sleep || defaultSleep;
    let lastError = null;

    for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
      try {
        return await operation(attempt);
      } catch (error) {
        const apiError =
          error instanceof ApiError
            ? error
            : new ApiError('翻译请求失败，请重试。', {
                code: 'UNKNOWN_ERROR',
                retryable: false
              });
        lastError = apiError;
        if (!apiError.retryable || attempt >= maxRetries) throw apiError;
        const backoff =
          apiError.retryAfterMs ||
          config.TIMEOUTS.RETRY_BASE_DELAY_MS * Math.pow(2, attempt) +
            Math.floor(Math.random() * 180);
        await sleep(backoff);
        if (opts.stopped?.()) throw apiError;
      }
    }

    throw lastError || new ApiError('翻译请求失败，请重试。', { code: 'UNKNOWN_ERROR' });
  }

  /** Run `attempt` once more when it fails with `code`, unless `stopped` says not to. */
  async function retryOnCode(attempt, code, stopped) {
    try {
      return await attempt();
    } catch (error) {
      if (!error || error.code !== code || stopped?.()) throw error;
      return attempt();
    }
  }

  function buildHeaders(apiKey) {
    const headers = {
      'Content-Type': 'application/json',
      Accept: 'application/json'
    };
    if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
    return headers;
  }

  const api = Object.freeze({ ApiError, validateApiKey, requestJson, withRetries, retryOnCode, buildHeaders });
  globalScope.DSHT = globalScope.DSHT || {};
  globalScope.DSHT.apiTransport = api;
  if (typeof module === 'object' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
