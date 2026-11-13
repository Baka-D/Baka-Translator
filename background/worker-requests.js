// Service-worker helpers; loaded in the worker global scope.

// Per tab: how many times its page was restored. In-flight replies still land so
// their usage is recorded; only the next attempt is skipped.
// shortcut: entries stay until the worker restarts, drop them on tabs.onRemoved if that ever matters.
const pageRunStops = new Map();

function pageRunStopped(sender) {
  const tabId = sender.tab.id;
  const stops = pageRunStops.get(tabId);
  return () => pageRunStops.get(tabId) !== stops;
}

function stopPageRequests(sender) {
  if (!sender.tab || !sender.tab.id) {
    throw new PageAccessError('INVALID_SENDER', t('bg_invalid_sender'));
  }
  pageRunStops.set(sender.tab.id, (pageRunStops.get(sender.tab.id) || 0) + 1);
  return { ok: true };
}

function validateTargetCode(value) {
  if (!languages.getTargetLanguage(value)) {
    throw new PageAccessError('INVALID_TARGET', t('bg_target_unsupported'));
  }
  return String(value).toLowerCase();
}

function validateBatchMessage(message) {
  const segments = message && message.segments;
  if (!Array.isArray(segments) || segments.length === 0) {
    throw new PageAccessError('INVALID_REQUEST', t('bg_translation_request_empty'));
  }
  if (segments.length > LIMITS.API_MAX_SEGMENTS) {
    throw new PageAccessError('TOO_MANY_SEGMENTS', t('bg_translation_too_many_segments'));
  }
  let totalChars = 0;
  const normalized = segments.map((segment) => {
    if (!segment || segment.id === undefined || typeof segment.text !== 'string') {
      throw new PageAccessError('INVALID_REQUEST', t('bg_translation_request_invalid'));
    }
    const id = String(segment.id);
    const text = segment.text;
    totalChars += text.length;
    if (text.length > LIMITS.API_MAX_SEGMENT_CHARS) {
      throw new PageAccessError('SEGMENT_TOO_LONG', t('bg_translation_segment_too_long'));
    }
    return { id, text };
  });
  if (totalChars > LIMITS.API_MAX_TOTAL_CHARS) {
    throw new PageAccessError('TEXT_TOO_LONG', t('bg_translation_request_too_long'));
  }
  return {
    segments: normalized,
    targetCode: validateTargetCode(message.targetCode),
    sourceHint: typeof message.sourceHint === 'string' ? message.sourceHint.slice(0, 20) : '',
    glossary: normalizeGlossaryPayload(message.glossary),
    context: normalizeContextPayload(message.context)
  };
}

function normalizeGlossaryPayload(value, limit = LIMITS.GLOSSARY_REQUEST_MAX_TERMS) {
  if (!Array.isArray(value)) return [];
  const terms = [];
  const seen = new Set();
  for (const item of value) {
    if (!item || typeof item !== 'object') continue;
    const source = String(item.source || '').trim();
    const target = String(item.target || '').trim();
    if (!source || !target || source.length > 200 || target.length > 200) continue;
    const key = source.toLocaleLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    terms.push({
      source,
      target,
      category: String(item.category || 'term').trim().slice(0, 40) || 'term',
      note: String(item.note || '').trim().slice(0, 160),
      ...(['male', 'female', 'none'].includes(item.gender) ? { gender: item.gender } : {})
    });
    if (terms.length >= limit) break;
  }
  return terms;
}

/** Bound the page-supplied context; null while the preset does not use it. */
function normalizeContextPayload(value) {
  if (!value || typeof value !== 'object') return null;
  const text = (key) => (typeof value[key] === 'string' ? value[key].trim() : '');
  return {
    workTitle: text('workTitle').slice(0, 200),
    previousChapter: text('previousChapter').slice(-LIMITS.CONTEXT_PREVIOUS_CHAPTER_CHARS),
    precedingText: text('precedingText').slice(-LIMITS.CONTEXT_PRECEDING_CHARS)
  };
}

function validatePolishMessage(message) {
  const segments = message && message.segments;
  if (!Array.isArray(segments) || segments.length === 0) {
    throw new PageAccessError('INVALID_REQUEST', t('bg_polish_request_empty'));
  }
  if (segments.length > LIMITS.POLISH_MAX_SEGMENTS) {
    throw new PageAccessError('TOO_MANY_SEGMENTS', t('bg_polish_too_many_segments'));
  }
  let totalChars = 0;
  const normalized = segments.map((segment) => {
    if (
      !segment ||
      segment.id === undefined ||
      typeof segment.original !== 'string' ||
      typeof segment.translation !== 'string'
    ) {
      throw new PageAccessError('INVALID_REQUEST', t('bg_polish_request_invalid'));
    }
    totalChars += segment.original.length + segment.translation.length;
    return {
      id: String(segment.id),
      original: segment.original,
      translation: segment.translation
    };
  });
  if (totalChars > LIMITS.POLISH_MAX_TOTAL_CHARS) {
    throw new PageAccessError('TEXT_TOO_LONG', t('bg_polish_request_too_long'));
  }
  return {
    segments: normalized,
    targetCode: validateTargetCode(message.targetCode),
    sourceHint: typeof message.sourceHint === 'string' ? message.sourceHint.slice(0, 20) : '',
    glossary: normalizeGlossaryPayload(message.glossary),
    context: normalizeContextPayload(message.context)
  };
}

function chunkPolishSegments(segments, maxChars) {
  const chunks = [];
  let current = [];
  let chars = 0;
  for (const segment of segments) {
    const cost = segment.original.length + segment.translation.length;
    if (current.length > 0 && chars + cost > maxChars) {
      chunks.push(current);
      current = [];
      chars = 0;
    }
    current.push(segment);
    chars += cost;
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
}

async function handleTranslateBatch(message, sender, stopped, runtime) {
  if (!sender.tab || !sender.tab.id) {
    throw new PageAccessError('INVALID_SENDER', t('bg_invalid_sender'));
  }
  stopped ||= pageRunStopped(sender);
  const request = validateBatchMessage(message);
  runtime ||= await resolveRuntime('translation', hostnameFromSender(sender));
  if (stopped()) throw new PageAccessError('REQUEST_CANCELLED', t('bg_translation_stopped'));
  // Rejected replies are billed too; the page adds them to its cost, also on failure.
  const discardedBilling = [];
  const result = await withWorkerKeepalive(() => api.translateSegments({
    apiKey: runtime.apiKey,
    model: runtime.resolved.model,
    provider: runtime.resolved.provider,
    effortLevel: runtime.resolved.effort,
    preset: runtime.preset,
    segments: request.segments,
    targetCode: request.targetCode,
    sourceHint: request.sourceHint,
    glossary: request.glossary,
    context: request.context,
    stopped,
    onDiscardedUsage: discardedUsageRecorder(runtime, (billing) => discardedBilling.push(billing))
  })).catch((error) => {
    error.discardedBilling = discardedBilling;
    throw error;
  });
  const enriched = attachBilling(runtime, result);
  await recordUsage(enriched.usage, enriched.billing);
  return { ...enriched, discardedBilling };
}

async function handleTranslateImage(message, sender) {
  if (!sender.tab || !sender.tab.id) {
    throw new PageAccessError('INVALID_SENDER', t('bg_invalid_sender'));
  }
  const targetCode = validateTargetCode(message.targetCode);
  const imageDataUrl = typeof message.imageDataUrl === 'string' ? message.imageDataUrl : '';
  if (!imageDataUrl) throw new PageAccessError('INVALID_REQUEST', t('bg_image_empty'));
  const runtime = await resolveRuntime('translation', hostnameFromSender(sender));
  if (runtime.resolved.model.supportsVision === false) {
    throw new PageAccessError('VISION_UNSUPPORTED', t('bg_vision_disabled'));
  }
  const result = await withWorkerKeepalive(() => api.translateImage({
    apiKey: runtime.apiKey,
    model: runtime.resolved.model,
    provider: runtime.resolved.provider,
    effortLevel: runtime.resolved.effort,
    imageDataUrl,
    targetCode,
    sourceHint: typeof message.sourceHint === 'string' ? message.sourceHint.slice(0, 20) : '',
    onDiscardedUsage: discardedUsageRecorder(runtime)
  })).catch(async (error) => {
    if (error.code === 'VISION_UNSUPPORTED') {
      await rememberVisionUnsupported(runtime);
      error.message = t('bg_vision_learned_disabled');
    }
    throw error;
  });
  const enriched = attachBilling(runtime, result);
  await recordUsage(enriched.usage, enriched.billing);
  return enriched;
}

function startWorkerKeepalive() {
  let timer = 0;
  const ping = () => {
    try {
      if (chrome.runtime && typeof chrome.runtime.getPlatformInfo === 'function') {
        chrome.runtime.getPlatformInfo(() => {
          void chrome.runtime.lastError;
        });
      }
    } catch (_error) {
      // Keepalive is best-effort.
    }
  };
  try {
    ping();
    timer = setInterval(ping, 15000);
  } catch (_error) {
    return () => {};
  }
  return () => {
    if (timer) clearInterval(timer);
    timer = 0;
  };
}

/** Slow model responses must outlive MV3's idle window, including after navigation. */
async function withWorkerKeepalive(operation) {
  const stopKeepalive = startWorkerKeepalive();
  try {
    return await operation();
  } finally {
    stopKeepalive();
  }
}

async function handlePolishSegments(message, sender, stopped, runtime) {
  if (!sender.tab || !sender.tab.id) {
    throw new PageAccessError('INVALID_SENDER', t('bg_invalid_sender'));
  }
  stopped ||= pageRunStopped(sender);
  const request = validatePolishMessage(message);
  runtime ||= await resolveRuntime('polish', hostnameFromSender(sender));
  // Long reasoning calls can exceed the MV3 service-worker idle window. The
  // runtime API ping keeps the worker alive while chunks are in flight.
  const stopKeepalive = startWorkerKeepalive();
  try {
    const chunks = chunkPolishSegments(
      request.segments,
      LIMITS.POLISH_CHUNK_CHARS || 16000
    );
    const translations = [];
    let costUsd = 0;
    let currency = billingUtils.DEFAULT_CURRENCY;
    let available = false;
    const failures = [];
    let cursor = 0;
    const addBilling = (billing) => {
      if (!billing || !billing.available) return;
      available = true;
      costUsd += Number(billing.costUsd) || 0;
      currency = billing.currency || currency;
    };
    // Rejected-but-billed chunks still cost money; include them in the page total.
    const onDiscardedUsage = discardedUsageRecorder(runtime, addBilling);

    // Proofreading is independent per chunk. Run a small pool instead of
    // waiting for each large slice serially; this is the main latency win for
    // long pages. Individual failures do not discard successful chunks.
    const worker = async () => {
      while (true) {
        // Already-sent replies still count, but restoring a page stops new paid chunks.
        if (stopped()) return;
        const index = cursor;
        cursor += 1;
        if (index >= chunks.length) return;
        const chunk = chunks[index];
        try {
          const result = await api.polishSegments({
            apiKey: runtime.apiKey,
            model: runtime.resolved.model,
            provider: runtime.resolved.provider,
            effortLevel: runtime.resolved.effort,
            preset: runtime.preset,
            segments: chunk,
            targetCode: request.targetCode,
            sourceHint: request.sourceHint,
            glossary: request.glossary,
            context: textUtils.contextBefore(
              request.context,
              request.segments,
              chunk[0],
              textUtils.pairText,
              LIMITS.CONTEXT_PRECEDING_CHARS
            ),
            timeoutMs: config.TIMEOUTS.POLISH_MS,
            stopped,
            onDiscardedUsage
          });
          const enriched = attachBilling(runtime, result);
          await recordUsage(enriched.usage, enriched.billing);
          if (Array.isArray(enriched.translations)) translations.push(...enriched.translations);
          addBilling(enriched.billing);
        } catch (error) {
          failures.push({
            index,
            code: error && error.code ? error.code : 'POLISH_CHUNK_FAILED',
            message: (error && error.message) || t('bg_polish_failed')
          });
        }
      }
    };

    const concurrency = Math.max(
      1,
      Math.min(LIMITS.POLISH_MAX_CONCURRENCY || 1, chunks.length)
    );
    await Promise.all(Array.from({ length: concurrency }, () => worker()));

    let polishError = '';
    if (failures.length > 0) {
      const first = failures[0];
      polishError =
        failures.length === chunks.length
          ? t('bg_polish_error', [first.message])
          : t('bg_polish_partial', [failures.length, chunks.length, first.message]);
    }

    return {
      translations,
      billing: {
        available,
        costUsd: Math.round(costUsd * 1e10) / 1e10,
        currency,
        period: 'mixed'
      },
      chunks: chunks.length,
      failedChunks: failures.length,
      polishError: polishError || null,
      modelId: runtime.resolved.model.id,
      modelName: runtime.resolved.model.name,
      providerId: runtime.resolved.provider.id
    };
  } finally {
    stopKeepalive();
  }
}

function validateTermMessage(message) {
  const segments = message && message.segments;
  if (!Array.isArray(segments) || segments.length === 0) {
    throw new PageAccessError('INVALID_REQUEST', t('bg_extraction_request_empty'));
  }
  if (segments.length > LIMITS.NOVEL_TERMS_MAX_SEGMENTS) {
    throw new PageAccessError('TOO_MANY_SEGMENTS', t('bg_extraction_too_many_segments'));
  }
  let totalChars = 0;
  const normalized = segments.map((segment) => {
    if (
      !segment ||
      typeof segment.original !== 'string' ||
      typeof segment.translation !== 'string'
    ) {
      throw new PageAccessError('INVALID_REQUEST', t('bg_extraction_request_invalid'));
    }
    totalChars += segment.original.length + segment.translation.length;
    return {
      id: String(segment.id || ''),
      original: segment.original,
      translation: segment.translation
    };
  });
  if (totalChars > LIMITS.NOVEL_TERMS_MAX_CHARS) {
    throw new PageAccessError('TEXT_TOO_LONG', t('bg_extraction_too_long'));
  }
  return {
    segments: normalized,
    targetCode: validateTargetCode(message.targetCode),
    glossary: normalizeGlossaryPayload(message.glossary)
  };
}

/** Reasoning made this step six times slower; api.extractTerms reviews the result instead. */
function termEffort({ model, provider, effort }) {
  return model.userAdded || provider.custom ? effort : model.effortLevels[0];
}

async function handleExtractTerms(message, sender) {
  if (!sender.tab || !sender.tab.id) {
    throw new PageAccessError('INVALID_SENDER', t('bg_invalid_sender'));
  }
  const stopped = pageRunStopped(sender);
  const request = validateTermMessage(message);
  const runtime = await resolveRuntime('translation', hostnameFromSender(sender));
  if (stopped()) throw new PageAccessError('REQUEST_CANCELLED', t('bg_extraction_stopped'));
  const discardedBilling = [];
  const result = await withWorkerKeepalive(() => api.extractTerms({
    apiKey: runtime.apiKey,
    model: runtime.resolved.model,
    provider: runtime.resolved.provider,
    effortLevel: termEffort(runtime.resolved),
    segments: request.segments,
    targetCode: request.targetCode,
    glossary: request.glossary,
    stopped,
    onDiscardedUsage: discardedUsageRecorder(runtime, (billing) => discardedBilling.push(billing))
  })).catch((error) => {
    error.discardedBilling = discardedBilling;
    throw error;
  });
  const enriched = attachBilling(runtime, result);
  await recordUsage(enriched.usage, enriched.billing);
  const reviewBilling = [];
  for (const review of result.reviews || []) {
    const billed = attachBilling(runtime, review);
    await recordUsage(billed.usage, billed.billing);
    reviewBilling.push(billed.billing);
  }
  return { ...enriched, reviewBilling, discardedBilling };
}
