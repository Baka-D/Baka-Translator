/**
 * Provider client for Baka Translator. Runs only in the extension service
 * worker so API keys never enter content scripts or web pages.
 *
 * The request format is OpenAI-compatible Chat Completions, or the Anthropic
 * Messages API for `protocol: "anthropic"` providers. DeepSeek receives
 * its optional `thinking` / `reasoning_effort` fields; OpenAI-compatible
 * endpoints receive only the fields declared by their model profile.
 */
(function initApi(globalScope) {
  'use strict';

  const config =
    (globalScope.DSHT && globalScope.DSHT.config) ||
    (typeof require === 'function' ? require('../shared/config.js') : null);
  const protocol =
    (globalScope.DSHT && globalScope.DSHT.protocol) ||
    (typeof require === 'function' ? require('../shared/protocol.js') : null);
  const modelsUtils =
    (globalScope.DSHT && globalScope.DSHT.models) ||
    (typeof require === 'function' ? require('../shared/models.js') : null);

  const transport =
    (globalScope.DSHT && globalScope.DSHT.apiTransport) ||
    (typeof require === 'function' ? require('./api-transport.js') : null);
  const { ApiError, validateApiKey, requestJson, withRetries, retryOnCode, buildHeaders } = transport;
  const anthropic =
    (globalScope.DSHT && globalScope.DSHT.anthropicApi) ||
    (typeof require === 'function' ? require('./api-anthropic.js') : null);
  const discovery = (globalScope.DSHT && globalScope.DSHT.apiModels) ||
    (typeof require === 'function' ? require('./api-models.js') : null);
  const vision = (globalScope.DSHT && globalScope.DSHT.apiVision) ||
    (typeof require === 'function' ? require('./api-vision.js') : null);

  const termApi =
    (globalScope.DSHT && globalScope.DSHT.termApi) ||
    (typeof require === 'function' ? require('./api-terms.js') : null);

  function providerHeaders(apiKey, provider, model) {
    return anthropic.isAnthropic(provider) ? anthropic.headers(apiKey, model) : buildHeaders(apiKey);
  }

  function fallbackProvider() {
    return {
      id: 'deepseek',
      name: 'DeepSeek',
      endpoint: config.API_BASE_URL,
      completionsPath: config.CHAT_ENDPOINT,
      modelsPath: config.MODELS_ENDPOINT,
      protocol: 'openai',
      requestShape: 'deepseek',
      apiKeyRequired: true
    };
  }

  function fallbackModel() {
    return {
      id: config.MODEL,
      provider: 'deepseek',
      name: 'DeepSeek V4.1 Flash',
      model: config.MODEL,
      endpoint: config.API_BASE_URL,
      contextWindow: 1000000,
      maxOutputTokens: 8192,
      effortLevels: ['none', 'low', 'high', 'max'],
      defaultEffort: 'none',
      thinkingParam: 'deepseek',
      effortParam: 'reasoning_effort',
      supportsVision: true,
      supportsJson: true,
      maxTokensParam: 'max_tokens',
      pricing: null
    };
  }

  function resolveContext(options) {
    const opts = options || {};
    const provider = opts.provider || fallbackProvider();
    const model = opts.model || fallbackModel();
    const endpoint = String(model.endpoint || provider.endpoint || config.API_BASE_URL).replace(
      /\/+$/,
      ''
    );
    const requestUrl =
      opts.requestUrl ||
      (modelsUtils
        ? modelsUtils.joinEndpoint(endpoint, provider.completionsPath)
        : `${endpoint}${config.CHAT_ENDPOINT}`);
    const modelsUrl =
      opts.modelsUrl ||
      (modelsUtils
        ? modelsUtils.joinEndpoint(endpoint, provider.modelsPath)
        : `${endpoint}${config.MODELS_ENDPOINT}`);
    return {
      model,
      provider,
      endpoint,
      requestUrl,
      modelsUrl,
      providerName: provider.name || provider.id || 'API'
    };
  }

  function modelMaxTokens(model, kind) {
    const cap =
      kind === 'polish' ? 65536 : kind === 'image' ? 4096 : kind === 'terms' ? 8192 : 8192;
    const maxOutput = Number(model && model.maxOutputTokens);
    const modelCap = Number.isFinite(maxOutput) && maxOutput > 0 ? maxOutput : cap;
    // Models whose limit also covers thinking need room beyond the answer-sized caps.
    const wanted = Math.max(cap, Number(model && model.outputFloor) || 0);
    return Math.max(256, Math.min(wanted, modelCap));
  }

  function withoutImageDetail(message) {
    if (!Array.isArray(message.content)) return message;
    const content = message.content.map((part) => (
      part && part.type === 'image_url' ? { ...part, image_url: { url: part.image_url.url } } : part
    ));
    return { ...message, content };
  }

  function buildChatPayload({ model, provider, effortLevel, messages, maxTokens, temperature }) {
    const body = {
      model: model.model,
      // `detail: "original"` is OpenAI's; providers that document no such value skip it.
      messages: provider && provider.imageDetail === false ? messages.map(withoutImageDetail) : messages,
      stream: false
    };
    const tokenParam = model.maxTokensParam === 'max_completion_tokens'
      ? 'max_completion_tokens'
      : 'max_tokens';
    body[tokenParam] = Math.max(1, Math.floor(maxTokens || 4096));
    if (model.supportsJson !== false) {
      body.response_format = { type: 'json_object' };
    }

    const shape = (provider && provider.requestShape) || 'openai';
    const effort = typeof effortLevel === 'string' ? effortLevel : '';
    if (shape === 'deepseek' && model.thinkingParam === 'deepseek') {
      const disabled = !effort || effort === 'none';
      body.thinking = { type: disabled ? 'disabled' : 'enabled' };
      if (!disabled) body.reasoning_effort = effort;
      else if (typeof temperature === 'number') body.temperature = temperature;
    } else {
      const reasoning = Boolean(model.effortParam && effort && effort !== 'none');
      // OpenAI uses a model-specific default when this field is omitted.
      // Explicitly transmit "none" so the saved choice disables reasoning.
      // Keep the optional field absent for generic non-reasoning gateways.
      if (reasoning || (model.effortParam && effort === 'none' && provider && provider.id === 'openai')) {
        body[model.effortParam] = effort;
      }
      // Reasoning models reject or ignore temperature; only send it for
      // non-reasoning calls.
      if (!reasoning && !model.userAdded && typeof temperature === 'number') body.temperature = temperature;
    }
    return body;
  }

  function extractMessageContent(data, providerName) {
    const choice = data && Array.isArray(data.choices) ? data.choices[0] : null;
    if (!choice) {
      throw new ApiError(`${providerName || '模型服务'} 未返回结果，请重试。`, {
        code: 'EMPTY_RESPONSE',
        retryable: true
      });
    }
    if (choice.finish_reason === 'length') {
      throw new ApiError('翻译结果超出长度限制，请缩短文本或使用更大输出上限的模型。', {
        code: 'OUTPUT_TRUNCATED',
        retryable: false
      });
    }
    if (choice.finish_reason === 'content_filter') {
      throw new ApiError('内容被模型安全策略拦截，请尝试其他内容。', {
        code: 'CONTENT_FILTERED',
        retryable: false
      });
    }
    let content = choice.message && choice.message.content;
    if (Array.isArray(content)) {
      content = content
        .map((part) => (typeof part === 'string' ? part : part && part.text ? part.text : ''))
        .join('');
    }
    if (typeof content !== 'string' || !content.trim()) {
      throw new ApiError(`${providerName || '模型服务'} 返回了空结果，请重试。`, {
        code: 'EMPTY_RESPONSE',
        retryable: true
      });
    }
    return {
      content,
      usage: data.usage || null,
      finishReason: choice.finish_reason
    };
  }

  // The provider bills replies we reject (truncated, filtered, unparsable);
  // hand their usage to the caller so the estimate still counts them.
  function reportDiscardedUsage(options, usage, requestStartedAt) {
    if (!usage || !options || typeof options.onDiscardedUsage !== 'function') return;
    try {
      options.onDiscardedUsage(usage, requestStartedAt);
    } catch (_error) {
      // Usage accounting must never change the request outcome.
    }
  }

  async function chatCompletion(options) {
    const ctx = resolveContext(options);
    const apiKey = validateApiKey(options.apiKey, ctx.provider);
    const kind = options.kind || 'translation';
    const messages = options.messages;
    const claude = anthropic.isAnthropic(ctx.provider);
    const payload = (claude ? anthropic.buildPayload : buildChatPayload)({
      model: ctx.model,
      provider: ctx.provider,
      effortLevel: options.effortLevel,
      messages,
      maxTokens: modelMaxTokens(ctx.model, kind),
      temperature: typeof options.temperature === 'number' ? options.temperature : 0.2
    });
    const requestStartedAt = Date.now();

    const result = await withRetries(
      async () => {
        const attemptStartedAt = Date.now();
        const data = await requestJson(ctx.requestUrl, {
          method: 'POST',
          headers: providerHeaders(apiKey, ctx.provider, ctx.model),
          apiKey,
          body: JSON.stringify(payload),
          fetchImpl: options.fetchImpl,
          timeoutMs: options.timeoutMs || config.TIMEOUTS.REQUEST_MS,
          providerName: ctx.providerName
        }).catch((error) => {
          if (kind === 'image' && vision.isUnsupportedError(error)) {
            throw new ApiError('当前模型不支持图片输入，请切换到支持视觉的模型。', {
              code: 'VISION_UNSUPPORTED', retryable: false, status: error.status
            });
          }
          throw error;
        });
        let extracted;
        try {
          extracted = claude
            ? anthropic.extractContent(data, ctx.providerName)
            : extractMessageContent(data, ctx.providerName);
        } catch (error) {
          const usage = data && (claude ? anthropic.normalizeUsage(data.usage) : data.usage);
          reportDiscardedUsage(options, usage, attemptStartedAt);
          throw error;
        }
        return {
          ...extracted,
          model: ctx.model.model,
          provider: ctx.provider.id,
          requestStartedAt
        };
      },
      {
        fetchImpl: options.fetchImpl,
        timeoutMs: options.timeoutMs,
        sleep: options.sleep,
        maxRetries: options.maxRetries,
        stopped: options.stopped
      }
    );
    return result;
  }

  // `partialOk` keeps the ids that did come back: they are already billed. A
  // short reply without ids can't say which segment it skipped, so it fails.
  function translationResult(extracted, parsed, options, partialOk) {
    const usable = partialOk && parsed.translations.length > 0 && !parsed.positional;
    if (!parsed.ok && !usable) {
      reportDiscardedUsage(options, extracted.usage, extracted.requestStartedAt);
      throw new ApiError('模型返回的翻译结果不完整，请重试。', {
        code: 'INCOMPLETE_TRANSLATION',
        retryable: true
      });
    }
    return {
      translations: parsed.translations,
      missing: parsed.missing,
      usage: extracted.usage,
      finishReason: extracted.finishReason,
      model: extracted.model,
      provider: extracted.provider,
      requestStartedAt: extracted.requestStartedAt
    };
  }

  async function translateSegments(options) {
    const opts = options || {};
    if (!Array.isArray(opts.segments) || opts.segments.length === 0) {
      throw new ApiError('没有可翻译的文本。', { code: 'EMPTY_SEGMENTS', retryable: false });
    }
    const messages = protocol.buildTranslationMessages({
      segments: opts.segments,
      targetCode: opts.targetCode,
      sourceHint: opts.sourceHint,
      preset: opts.preset,
      glossary: opts.glossary,
      context: opts.context
    });
    const expectedIds = opts.segments.map((segment, index) =>
      String(segment && segment.id !== undefined ? segment.id : index + 1)
    );
    const extracted = await chatCompletion({ ...opts, messages, kind: 'translation' });
    return translationResult(
      extracted,
      protocol.parseTranslationResponse(extracted.content, expectedIds),
      opts,
      true
    );
  }

  async function polishSegments(options) {
    const opts = options || {};
    if (!Array.isArray(opts.segments) || opts.segments.length === 0) {
      throw new ApiError('没有可润色的文本。', { code: 'EMPTY_SEGMENTS', retryable: false });
    }
    const messages = protocol.buildPolishMessages({
      segments: opts.segments,
      targetCode: opts.targetCode,
      sourceHint: opts.sourceHint,
      preset: opts.preset,
      glossary: opts.glossary,
      context: opts.context
    });
    // An unreadable reply is usually a one-off, and a whole chunk rides on it.
    return retryOnCode(async () => {
      const extracted = await chatCompletion({ ...opts, messages, kind: 'polish', temperature: 0.1 });
      const parsed = protocol.parsePolishResponse(extracted.content, opts.segments);
      return translationResult(extracted, parsed, opts);
    }, 'INCOMPLETE_TRANSLATION', opts.stopped);
  }

  async function translateImage(options) {
    const opts = options || {};
    const ctx = resolveContext(opts);
    if (!ctx.model.supportsVision) {
      throw new ApiError(
        `当前模型 ${ctx.model.name || ctx.model.model} 不支持图片输入，请切换到支持视觉的模型。`,
        { code: 'VISION_UNSUPPORTED', retryable: false }
      );
    }
    const imageDataUrl = typeof opts.imageDataUrl === 'string' ? opts.imageDataUrl : '';
    if (!/^data:image\/(png|jpeg|webp|gif);base64,/i.test(imageDataUrl)) {
      throw new ApiError('图片格式不受支持。', {
        code: 'BAD_IMAGE',
        retryable: false
      });
    }
    if (imageDataUrl.length > config.LIMITS.IMAGE_MAX_DATA_URL_CHARS) {
      throw new ApiError('图片过大，请稍后再试。', {
        code: 'IMAGE_TOO_LARGE',
        retryable: false
      });
    }

    const messages = protocol.buildImageTranslationMessages({
      targetCode: opts.targetCode,
      imageDataUrl,
      sourceHint: opts.sourceHint
    });
    const extracted = await chatCompletion({ ...opts, messages, kind: 'image', temperature: 0.1 });
    const parsed = protocol.parseImageResponse(extracted.content);
    if (!parsed.ok) {
      reportDiscardedUsage(opts, extracted.usage, extracted.requestStartedAt);
      throw new ApiError(
        parsed.error === 'MISSING_IMAGE_TRANSLATION'
          ? '图片文字识别成功，但翻译结果不完整，请重试。'
          : '模型返回的图片识别结果异常，请重试。',
        { code: 'INVALID_IMAGE_RESPONSE', retryable: true }
      );
    }
    return {
      ...parsed,
      usage: extracted.usage,
      model: extracted.model,
      provider: extracted.provider,
      requestStartedAt: extracted.requestStartedAt
    };
  }

  async function extractTerms(options) {
    const opts = options || {};
    if (!Array.isArray(opts.segments) || opts.segments.length === 0) {
      throw new ApiError('没有可提取术语的文本。', {
        code: 'EMPTY_SEGMENTS',
        retryable: false
      });
    }
    const ctx = resolveContext(opts);
    const messages = protocol.buildTermExtractionMessages({
      segments: opts.segments,
      targetCode: opts.targetCode,
      glossary: opts.glossary
    });
    const extracted = await chatCompletion({
      ...opts,
      messages,
      kind: 'terms',
      temperature: 0.1
    });
    const parsed = protocol.parseTermResponse(extracted.content, 120);
    if (!parsed.ok && parsed.error !== 'NO_TERMS') {
      reportDiscardedUsage(opts, extracted.usage, extracted.requestStartedAt);
      throw new ApiError('模型返回的术语表格式异常，请重试。', {
        code: 'INVALID_TERMS_RESPONSE',
        retryable: true
      });
    }
    const review = await termApi.reviewTerms(parsed.terms, opts, chatCompletion);
    return {
      terms: review.terms,
      reviews: review.replies,
      usage: extracted.usage,
      model: extracted.model,
      provider: extracted.provider,
      requestStartedAt: extracted.requestStartedAt
    };
  }

  async function testConnection(options) {
    const opts = options || {};
    const ctx = resolveContext(opts);
    const apiKey = validateApiKey(opts.apiKey, ctx.provider);
    const startedAt = Date.now();
    const data = await requestJson(ctx.modelsUrl, {
      method: 'GET',
      headers: providerHeaders(apiKey, ctx.provider, null),
      apiKey,
      fetchImpl: opts.fetchImpl,
      timeoutMs: opts.timeoutMs || config.TIMEOUTS.TEST_MS,
      providerName: ctx.providerName
    });
    const models = Array.isArray(data.data)
      ? data.data.map((item) => String((item && item.id) || '').replace(/^models\//, '')).filter(Boolean)
      : [];
    return {
      ok: true,
      latencyMs: Date.now() - startedAt,
      modelAvailable: models.length === 0 ? null : models.includes(ctx.model.model),
      models,
      provider: ctx.provider.id,
      model: ctx.model.model,
      providerName: ctx.providerName
    };
  }

  function getErrorPayload(error) {
    if (error instanceof ApiError) {
      return {
        code: error.code,
        message: error.message,
        retryable: error.retryable,
        status: error.status
      };
    }
    return {
      code: 'UNKNOWN_ERROR',
      message: '发生未知错误，请重试。',
      retryable: false,
      status: 0
    };
  }

  const api = Object.freeze({
    ApiError,
    translateSegments,
    polishSegments,
    extractTerms,
    translateImage,
    testConnection,
    fetchModels: discovery.fetchModels,
    validateApiKey,
    getErrorPayload,
    withRetries,
    buildChatPayload,
    resolveContext
  });

  globalScope.DSHT = globalScope.DSHT || {};
  globalScope.DSHT.api = api;

  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  }
})(
  typeof globalThis !== 'undefined'
    ? globalThis
    : typeof self !== 'undefined'
      ? self
      : this
);
