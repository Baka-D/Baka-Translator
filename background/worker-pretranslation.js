// Chapter jobs belong to the worker so navigating away does not discard results.
const pretranslationNovel = globalThis.DSHT.novel;
const pretranslationText = globalThis.DSHT.textUtils;
const pretranslationJobs = new Map();
const pretranslationOwners = new Map();
let pretranslationCacheWrites = Promise.resolve();

function pretranslationRequest(message, sender) {
  const source = pretranslationNovel.detectChapter(sender && sender.tab && sender.tab.url);
  const chapter = pretranslationNovel.detectChapter(message && message.chapterUrl);
  if (!sender || !sender.tab || !Number.isInteger(sender.tab.id) || sender.tab.id < 0 ||
      !source || !source.isChapter || !chapter || !chapter.isChapter ||
      source.siteId !== chapter.siteId || source.workId !== chapter.workId) {
    throw new PageAccessError('INVALID_SENDER', '只能预翻译当前小说作品的章节。');
  }
  const targetCode = validateTargetCode(message.targetCode);
  const cacheKey = pretranslationNovel.cacheKeyForChapter(chapter);
  return { chapter, targetCode, cacheKey, key: `${cacheKey}:${targetCode}` };
}

function pretranslationSegments(value) {
  if (!Array.isArray(value) || !value.length || value.length > LIMITS.PAGE_MAX_NODES) {
    throw new PageAccessError('INVALID_REQUEST', '下一章文本为空或片段过多。');
  }
  let chars = 0;
  const ids = new Set();
  const segments = value.map((segment) => {
    if (!segment || segment.id === undefined || typeof segment.text !== 'string' ||
        !segment.text.trim() || segment.text.length > LIMITS.API_MAX_SEGMENT_CHARS) {
      throw new PageAccessError('INVALID_REQUEST', '下一章文本格式不正确或片段过长。');
    }
    const id = String(segment.id);
    if (!id || ids.has(id)) throw new PageAccessError('INVALID_REQUEST', '下一章文本片段编号重复。');
    ids.add(id);
    chars += segment.text.length;
    return { id, text: segment.text };
  });
  if (chars > LIMITS.NOVEL_PRETRANSLATE_MAX_CHARS) {
    throw new PageAccessError('TEXT_TOO_LONG', '下一章过长，跳过预翻译。');
  }
  return segments;
}

function pretranslationSnapshot(job) {
  if (!job) return { status: 'none', progress: { stage: 'translating', done: 0, total: 0 }, note: '' };
  return {
    status: job.status,
    progress: { ...job.progress },
    note: job.note || '',
    ...(job.error ? { error: { ...job.error } } : {})
  };
}

function pretranslationActive(job) {
  return job.status === 'running' && !job.failed && !job.cancelled &&
    pretranslationOwners.get(job.cacheKey) === job;
}

function stopPretranslation(job) {
  if (!job) return;
  job.cancelled = true;
  job.status = 'none';
  job.note = '已停止预翻译。';
}

function trimPretranslationJobs() {
  for (const [key, job] of pretranslationJobs) {
    if (pretranslationJobs.size < LIMITS.NOVEL_MAX_CACHE_CHAPTERS) break;
    if (job.status === 'running') continue;
    pretranslationJobs.delete(key);
    if (pretranslationOwners.get(job.cacheKey) === job) pretranslationOwners.delete(job.cacheKey);
  }
}

async function readPretranslationCache(request) {
  const values = await chrome.storage.local.get(request.cacheKey);
  const record = pretranslationNovel.normalizeCacheRecord(values[request.cacheKey]);
  if (!record || record.targetCode !== request.targetCode) return null;
  if (record.createdAt && Date.now() - record.createdAt > LIMITS.NOVEL_CACHE_TTL_MS) return null;
  return record;
}

async function prunePretranslationCache(job, stillWanted = pretranslationActive) {
  const prefix = `novelCache:${job.chapter.siteId}:${job.chapter.workId}:`;
  const all = await chrome.storage.local.get(null);
  const entries = [];
  const remove = [];
  for (const [key, value] of Object.entries(all)) {
    if (!key.startsWith('novelCache:')) continue;
    const created = Number(value && value.createdAt) || 0;
    if (key !== job.cacheKey && created && Date.now() - created > LIMITS.NOVEL_CACHE_TTL_MS) {
      remove.push(key);
    } else if (key.startsWith(prefix)) {
      entries.push({ key, created });
    }
  }
  entries.sort((a, b) => b.created - a.created);
  for (const entry of entries.slice(LIMITS.NOVEL_MAX_CACHE_CHAPTERS)) {
    if (entry.key !== job.cacheKey) remove.push(entry.key);
  }
  if (remove.length && stillWanted(job)) await chrome.storage.local.remove(remove);
}

function pretranslationRecord(job, polished) {
  return pretranslationNovel.normalizeCacheRecord({
    chapterUrl: job.chapter.canonicalUrl,
    chapterTitle: job.chapterTitle,
    targetCode: job.targetCode,
    polished,
    createdAt: Date.now(),
    costUsd: job.costUsd,
    translationKey: job.translationKey,
    entries: job.segments.map((segment) => ({
      source: segment.text,
      translation: job.translations.get(segment.id)
    }))
  });
}

function savePretranslationCache(job, polished) {
  pretranslationCacheWrites = pretranslationCacheWrites.catch(() => {}).then(async () => {
    if (!pretranslationActive(job)) return false;
    const record = pretranslationRecord(job, polished);
    if (!record || record.entries.length !== job.segments.length) {
      throw new PageAccessError('INCOMPLETE_TRANSLATION', '下一章翻译结果不完整。');
    }
    await chrome.storage.local.set({ [job.cacheKey]: record });
    job.hasDraft = true;
    await prunePretranslationCache(job);
    return true;
  });
  return pretranslationCacheWrites;
}

function addPretranslationCost(job, billing) {
  if (billing && billing.available) job.costUsd += Number(billing.costUsd) || 0;
}

function addPretranslationResult(job, result, segments) {
  const expected = new Set(segments.map((segment) => segment.id));
  for (const item of Array.isArray(result.translations) ? result.translations : []) {
    if (item && expected.has(String(item.id)) && typeof item.text === 'string' && item.text.trim()) {
      job.translations.set(String(item.id), item.text);
      expected.delete(String(item.id));
    }
  }
  addPretranslationCost(job, result.billing);
  for (const billing of result.discardedBilling || []) addPretranslationCost(job, billing);
  if (expected.size) throw new PageAccessError('INCOMPLETE_TRANSLATION', '下一章翻译结果不完整。');
}

function mergeTranslationBatchResults(first, second) {
  const left = (first && first.billing) || {};
  const right = (second && second.billing) || {};
  return {
    translations: [
      ...((first && first.translations) || []),
      ...((second && second.translations) || [])
    ],
    discardedBilling: [
      ...((first && first.discardedBilling) || []),
      ...((second && second.discardedBilling) || [])
    ],
    billing: {
      available: Boolean(left.available || right.available),
      costUsd:
        Math.round((((Number(left.costUsd) || 0) + (Number(right.costUsd) || 0)) * 1e10)) / 1e10,
      currency: left.currency || right.currency || 'USD',
      period: 'mixed'
    }
  };
}

async function translatePretranslationBatch(job, batch, depth = 0) {
  let result;
  const context = textUtils.contextBefore(
    job.context, job.segments, batch[0], (segment) => segment.text,
    LIMITS.CONTEXT_PRECEDING_CHARS
  );
  const texts = batch.map((segment) => segment.text);
  try {
    result = await handleTranslateBatch({
      segments: batch, targetCode: job.targetCode, sourceHint: job.sourceHint,
      glossary: pretranslationNovel.requestGlossary(job.glossary, texts, context),
      context
    }, job.sender, () => !pretranslationActive(job), job.translationRuntime);
  } catch (error) {
    for (const billing of error?.discardedBilling || []) addPretranslationCost(job, billing);
    // A long batch can come back incomplete (usually output truncation or a
    // malformed id). Retrying the same large batch often fails the same way;
    // split it so the successful halves can still be saved.
    if (
      !error ||
      !['INCOMPLETE_TRANSLATION', 'OUTPUT_TRUNCATED'].includes(error.code) ||
      depth >= 2 ||
      batch.length < 2 ||
      !pretranslationActive(job)
    ) {
      throw error;
    }
    const middle = Math.ceil(batch.length / 2);
    const first = await translatePretranslationBatch(job, batch.slice(0, middle), depth + 1);
    if (!pretranslationActive(job)) return first;
    const second = await translatePretranslationBatch(job, batch.slice(middle), depth + 1);
    return mergeTranslationBatchResults(first, second);
  }
  // Keep what came back and ask again only for the ids the model skipped.
  const missing = new Set(result.missing);
  if (missing.size === 0 || !pretranslationActive(job)) return result;
  if (depth >= 2) throw new PageAccessError('INCOMPLETE_TRANSLATION', '下一章翻译结果不完整。');
  const rest = batch.filter((segment) => missing.has(segment.id));
  return mergeTranslationBatchResults(
    result,
    await translatePretranslationBatch(job, rest, depth + 1)
  );
}

async function translatePretranslationBatches(job) {
  const batches = pretranslationText.createBatches(job.segments, {
    maxChars: LIMITS.TEXT_MAX_BATCH_CHARS,
    maxItems: LIMITS.TEXT_MAX_BATCH_ITEMS
  });
  let cursor = 0;
  const worker = async () => {
    while (pretranslationActive(job)) {
      const batch = batches[cursor++];
      if (!batch) return;
      try {
        const result = await translatePretranslationBatch(job, batch);
        if (!pretranslationActive(job)) return;
        addPretranslationResult(job, result, batch);
        job.progress.done += batch.length;
      } catch (error) {
        job.failed = true;
        throw error;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(LIMITS.TEXT_MAX_CONCURRENCY, batches.length) }, worker));
}

async function polishPretranslation(job) {
  if (job.polishRuntimeError) throw job.polishRuntimeError;
  const pairs = job.segments.map((segment) => ({
    id: segment.id, original: segment.text, translation: job.translations.get(segment.id)
  }));
  job.progress = { stage: 'polishing', done: 0, total: pairs.length };
  job.note = '初译已缓存，正在润色下一章…';
  // Keep the outer chunk loop so the pretranslation panel advances its
  // progress between chunks. handlePolishSegments parallelizes the inner
  // chunks of each slice.
  for (const chunk of chunkPolishSegments(pairs, 24000)) {
    if (!pretranslationActive(job)) return;
    const context = textUtils.contextBefore(
      job.context, pairs, chunk[0], textUtils.pairText, LIMITS.CONTEXT_PRECEDING_CHARS
    );
    const texts = chunk.map((pair) => pair.original);
    const result = await handlePolishSegments({
      segments: chunk, targetCode: job.targetCode, sourceHint: job.sourceHint,
      glossary: pretranslationNovel.requestGlossary(job.glossary, texts, context),
      context
    }, job.sender, () => !pretranslationActive(job), job.polishRuntime);
    if (!pretranslationActive(job)) return;
    // Surface the provider's real failure instead of a generic incomplete-result error.
    if (result.polishError) {
      addPretranslationCost(job, result.billing);
      throw new PageAccessError('POLISH_FAILED', result.polishError);
    }
    addPretranslationResult(job, result, chunk);
    job.progress.done += chunk.length;
  }
}

async function runPretranslation(job) {
  try {
    const hostname = hostnameFromSender(job.sender);
    const settings = await readSettings();
    if (job.translationKey && job.translationKey !== config.translationCacheKey(settings, job.targetCode, hostname)) {
      throw new PageAccessError('SETTINGS_CHANGED', '翻译设置已更改，请重新开始本章翻译。');
    }
    const cached = await readPretranslationCache(job);
    if (!pretranslationActive(job)) return;
    if (cached && pretranslationNovel.cacheMatchesSettings(cached, job.translationKey) &&
        pretranslationNovel.mapCachedTranslations(job.segments, cached.entries).complete) {
      job.status = 'ready';
      job.progress = { stage: 'saving', done: job.segments.length, total: job.segments.length };
      job.note = cached.polished ? '下一章已有完整预翻译缓存。' : '下一章已有完整初译缓存。';
      return;
    }
    // Every batch belongs to the same settings snapshot as the chapter's cache key.
    job.translationRuntime = await resolveRuntime('translation', hostname, null, settings);
    if (job.polish) {
      try {
        job.polishRuntime = await resolveRuntime('polish', hostname, null, settings);
      } catch (error) {
        job.polishRuntimeError = error;
      }
    }
    if (!pretranslationActive(job)) return;
    await translatePretranslationBatches(job);
    if (!pretranslationActive(job)) return;
    job.progress.stage = 'saving';
    job.note = '正在保存下一章初译…';
    await savePretranslationCache(job, false);
    if (!pretranslationActive(job)) return;
    if (job.polish) {
      await polishPretranslation(job);
      if (!pretranslationActive(job)) return;
      job.progress.stage = 'saving';
      job.note = '正在保存下一章润色结果…';
      await savePretranslationCache(job, true);
      if (!pretranslationActive(job)) return;
    }
    job.status = 'ready';
    job.note = job.polish ? '下一章预翻译及润色已完成。' : '下一章预翻译已完成。';
  } catch (error) {
    const superseded = () => job.cancelled || pretranslationOwners.get(job.cacheKey) !== job;
    if (superseded()) return;
    const detail = errorPayload(error);
    // The draft was saved before polish was billed; the record should carry that cost too.
    if (job.hasDraft) await savePretranslationCache(job, false).catch(() => {});
    if (superseded()) return;
    job.status = job.hasDraft ? 'ready' : 'error';
    job.note = job.hasDraft
      ? `下一章初译已缓存，润色未完成：${detail.message}`
      : `预翻译下一章失败：${detail.message}`;
    if (!job.hasDraft) job.error = detail;
  }
}

async function handlePretranslateChapter(message, sender) {
  const request = pretranslationRequest(message, sender);
  const segments = pretranslationSegments(message.segments);
  const translationKey = typeof message.translationKey === 'string' ? message.translationKey : '';
  const existing = pretranslationJobs.get(request.key);
  if (existing && existing.status === 'running' && existing.translationKey === translationKey) {
    return pretranslationSnapshot(existing);
  }
  // The legacy cache key has no language suffix. New language jobs supersede
  // older writers for this chapter so a late response cannot replace the cache.
  stopPretranslation(pretranslationOwners.get(request.cacheKey));
  trimPretranslationJobs();
  const job = {
    ...request, segments,
    sender: { tab: { ...sender.tab } },
    sourceHint: typeof message.sourceHint === 'string' ? message.sourceHint.slice(0, 20) : '',
    glossary: normalizeGlossaryPayload(message.glossary, LIMITS.GLOSSARY_CHAPTER_MAX_TERMS),
    context: normalizeContextPayload(message.context),
    chapterTitle: typeof message.chapterTitle === 'string' ? message.chapterTitle : '',
    polish: message.polish === true,
    translationKey,
    status: 'running', progress: { stage: 'translating', done: 0, total: segments.length },
    note: '正在预翻译下一章…', translations: new Map(), costUsd: 0,
    hasDraft: false, failed: false, cancelled: false
  };
  pretranslationJobs.set(request.key, job);
  pretranslationOwners.set(request.cacheKey, job);
  void runPretranslation(job);
  return pretranslationSnapshot(job);
}

/** Keep a chapter the reader translated by hand, so reopening it costs nothing. */
async function saveChapterCache(message, sender) {
  const request = pretranslationRequest(message, sender);
  const owner = pretranslationOwners.get(request.cacheKey);
  if (owner && owner.status === 'running') return { saved: false };
  const entries = Array.isArray(message.entries) ? message.entries : [];
  const record = pretranslationNovel.normalizeCacheRecord({
    chapterUrl: request.chapter.canonicalUrl,
    chapterTitle: message.chapterTitle,
    targetCode: request.targetCode,
    polished: message.polished,
    createdAt: Date.now(),
    costUsd: message.costUsd,
    translationKey: message.translationKey,
    entries
  });
  if (!record || record.entries.length !== entries.length) {
    throw new PageAccessError('INCOMPLETE_TRANSLATION', '本章翻译结果不完整。');
  }
  const chars = record.entries.reduce((sum, entry) => sum + entry.source.length, 0);
  if (chars > LIMITS.PAGE_MAX_CHARS) throw new PageAccessError('TEXT_TOO_LONG', '本章过长，跳过缓存。');
  let saved = false;
  pretranslationCacheWrites = pretranslationCacheWrites.catch(() => {}).then(async () => {
    // A chapter has one slot; another language's paid translation keeps it until it expires.
    const values = await chrome.storage.local.get(request.cacheKey);
    const existing = pretranslationNovel.normalizeCacheRecord(values[request.cacheKey]);
    const expired = existing && Date.now() - existing.createdAt > LIMITS.NOVEL_CACHE_TTL_MS;
    if (existing && !expired && existing.targetCode !== request.targetCode) return;
    await chrome.storage.local.set({ [request.cacheKey]: record });
    await prunePretranslationCache(request, () => true);
    saved = true;
  });
  await pretranslationCacheWrites;
  return { saved };
}

async function getPretranslation(message, sender) {
  const request = pretranslationRequest(message, sender);
  const job = pretranslationJobs.get(request.key);
  if (job) return pretranslationSnapshot(job);
  const cached = await readPretranslationCache(request);
  if (!cached) return pretranslationSnapshot(null);
  return {
    status: 'ready',
    progress: { stage: 'saving', done: cached.entries.length, total: cached.entries.length },
    note: cached.polished ? '本章已有预翻译缓存。' : '本章已有初译缓存。'
  };
}

async function cancelPretranslation(message, sender) {
  const request = pretranslationRequest(message, sender);
  const job = pretranslationJobs.get(request.key);
  stopPretranslation(job);
  return pretranslationSnapshot(job);
}
