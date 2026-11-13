// Glossary upkeep belongs to the worker so leaving the chapter does not lose a billed result.
const tidyNovel = globalThis.DSHT.novel;
const glossaryTidyJobs = new Map();
const GLOSSARY_TIDY_RETRY_MS = 5 * 60 * 1000;

function cancelGlossaryTidy(key) {
  const job = glossaryTidyJobs.get(key);
  if (job) job.cancelled = true;
}

chrome.storage.onChanged?.addListener((changes, area) => {
  if (area !== 'local' || !changes[config.STORAGE_KEYS.GLOSSARY_TIDY_ENABLED] ||
      changes[config.STORAGE_KEYS.GLOSSARY_TIDY_ENABLED].newValue === true) return;
  // Turning it back on starts future work; it never revives an old paid operation.
  for (const job of glossaryTidyJobs.values()) job.cancelled = true;
});

/** Source text of the work's cached chapters, newest first; any target language will do. */
async function tidyChapterTexts(chapter, meta) {
  const keys = meta.chapterIds.slice(-LIMITS.NOVEL_MAX_CACHE_CHAPTERS).reverse()
    .map((chapterId) => tidyNovel.cacheKeyForChapter({ ...chapter, isChapter: true, chapterId }));
  const values = await chrome.storage.local.get(keys);
  return keys.flatMap((key) => {
    const record = tidyNovel.normalizeCacheRecord(values[key]);
    return record ? [record.entries.map((entry) => entry.source).join('\n')] : [];
  });
}

function dueGlossaryTidy(values, keys, settings) {
  const meta = tidyNovel.normalizeMeta(values[keys.metaKey]);
  if (!meta || meta.chaptersSinceTidy < settings.glossaryTidyChapters ||
      Number(values[keys.tidyKey]?.retryAfter) > Date.now()) return null;
  const terms = tidyNovel.mergeGlossary(values[keys.glossaryKey], []);
  return terms.length ? { meta, terms, tidiedAt: values[keys.tidyKey]?.tidiedAt ?? null } : null;
}

async function claimGlossaryTidy(keys, settings) {
  return withNovelWorkWrite(keys.glossaryKey, async () => {
    const values = await chrome.storage.local.get(Object.values(keys));
    const snapshot = dueGlossaryTidy(values, keys, settings);
    if (!snapshot) return null;
    // Persist before calling the model, so a crashed worker cannot immediately bill again.
    await chrome.storage.local.set({
      [keys.tidyKey]: { ...values[keys.tidyKey], retryAfter: Date.now() + GLOSSARY_TIDY_RETRY_MS }
    });
    return snapshot;
  });
}

/** Commit terms, undo data and the chapter counter together, after any queued editor writes. */
async function finishGlossaryTidy(keys, snapshot, plan, job) {
  return withNovelWorkWrite(keys.glossaryKey, async () => {
    const switchKey = config.STORAGE_KEYS.GLOSSARY_TIDY_ENABLED;
    const values = await chrome.storage.local.get([...Object.values(keys), switchKey]);
    const meta = tidyNovel.normalizeMeta(values[keys.metaKey]);
    if (!meta || !Object.hasOwn(values, keys.glossaryKey)) return { dropped: 0, merged: 0 };
    const previous = values[keys.tidyKey] || {};
    const stopped = job.cancelled || plan.cancelled || values[switchKey] !== true ||
      (previous.tidiedAt ?? null) !== snapshot.tidiedAt;
    const completed = !stopped && !plan.failed;
    const tidy = { ...previous, retryAfter: completed ? 0 : Date.now() + GLOSSARY_TIDY_RETRY_MS };
    const updates = { [keys.tidyKey]: tidy };
    const before = tidyNovel.mergeGlossary(values[keys.glossaryKey], []);
    const result = stopped ? { dropped: 0, merged: 0 } : tidyNovel.applyGlossaryTidy(before, plan.changes);
    if (result.dropped || result.merged) {
      const earlier = Array.isArray(previous.removed) ? previous.removed : [];
      updates[keys.glossaryKey] = result.terms;
      Object.assign(tidy, {
        terms: before,
        removed: Array.from(new Set(earlier.concat(result.removed))).slice(-LIMITS.GLOSSARY_CHAPTER_MAX_TERMS),
        earlierRemoved: earlier, touched: result.touched, dropped: result.dropped, merged: result.merged,
        tidiedAt: Math.max(Date.now(), (Number(previous.tidiedAt) || 0) + 1)
      });
    }
    if (completed) {
      updates[keys.metaKey] = {
        ...values[keys.metaKey],
        chaptersSinceTidy: Math.max(0, meta.chaptersSinceTidy - snapshot.meta.chaptersSinceTidy)
      };
    }
    await chrome.storage.local.set(updates);
    return { dropped: result.dropped, merged: result.merged };
  });
}

async function delayFailedGlossaryTidy(keys) {
  await withNovelWorkWrite(keys.glossaryKey, async () => {
    const values = await chrome.storage.local.get([keys.metaKey, keys.glossaryKey, keys.tidyKey]);
    if (!values[keys.metaKey] || !Object.hasOwn(values, keys.glossaryKey)) return;
    await chrome.storage.local.set({
      [keys.tidyKey]: { ...values[keys.tidyKey], retryAfter: Date.now() + GLOSSARY_TIDY_RETRY_MS }
    });
  });
}

async function runGlossaryTidy({ chapter, targetCode }, sender, job) {
  const settings = await readSettings();
  if (!settings.glossaryTidyEnabled || job.cancelled) return { skipped: true };
  const keys = novelStorageKeys(chapter, targetCode);
  const values = await chrome.storage.local.get(Object.values(keys));
  const initial = dueGlossaryTidy(values, keys, settings);
  if (!initial) return { skipped: true };
  const runtime = await resolveRuntime(settings.glossaryTidyPurpose, hostnameFromSender(sender), '', settings);
  const chapters = await tidyChapterTexts(chapter, initial.meta);
  if (job.cancelled) return { skipped: true };
  const snapshot = await claimGlossaryTidy(keys, settings);
  if (!snapshot) return { skipped: true };
  const discardedBilling = [];
  const tidyBilling = [];
  const recorded = new Set();
  const onReply = async (reply) => {
    if (recorded.has(reply)) return;
    const billed = attachBilling(runtime, reply);
    await recordUsage(billed.usage, billed.billing);
    recorded.add(reply);
    tidyBilling.push(billed.billing);
  };
  const switchKey = config.STORAGE_KEYS.GLOSSARY_TIDY_ENABLED;
  const cancelled = async () => {
    job.cancelled ||= (await chrome.storage.local.get(switchKey))[switchKey] !== true;
    return job.cancelled;
  };
  try {
    const plan = await withWorkerKeepalive(() => api.tidyGlossary({
      apiKey: runtime.apiKey, model: runtime.resolved.model, provider: runtime.resolved.provider,
      effortLevel: runtime.resolved.effort, terms: snapshot.terms, chapters, targetCode,
      workTitle: snapshot.meta.title, batchTerms: LIMITS.GLOSSARY_TIDY_BATCH_TERMS,
      cancelled, stopped: () => job.cancelled, onReply,
      onDiscardedUsage: discardedUsageRecorder(runtime, (billing) => discardedBilling.push(billing))
    }));
    // Also accepts API implementations that return their replies without streaming callbacks.
    for (const reply of plan.replies) await onReply(reply);
    const saved = await finishGlossaryTidy(keys, snapshot, plan, job);
    return { ...saved, failed: plan.failed, tidyBilling, discardedBilling };
  } catch (error) {
    // Failure to persist must not hide costs from replies already received.
    error.discardedBilling = discardedBilling.concat(tidyBilling);
    await delayFailedGlossaryTidy(keys).catch(() => {});
    throw error;
  }
}

async function handleTidyGlossary(message, sender) {
  const request = pretranslationRequest(message, sender);
  const key = tidyNovel.glossaryKeyForWork(request.chapter, request.targetCode);
  if (glossaryTidyJobs.has(key)) return { skipped: true };
  const job = { cancelled: false };
  glossaryTidyJobs.set(key, job);
  try {
    return await runGlossaryTidy(request, sender, job);
  } finally {
    glossaryTidyJobs.delete(key);
  }
}
