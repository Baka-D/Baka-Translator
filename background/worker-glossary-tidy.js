// Glossary upkeep belongs to the worker so leaving the chapter does not lose a billed result.
const tidyNovel = globalThis.DSHT.novel;

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

/** Re-read so terms saved while the model worked are kept, and keep the old list for undo. */
async function saveGlossaryTidy(glossaryKey, tidyKey, changes) {
  const values = await chrome.storage.local.get([glossaryKey, tidyKey]);
  const before = tidyNovel.mergeGlossary(values[glossaryKey], []);
  const result = tidyNovel.applyGlossaryTidy(before, changes);
  if (!result.dropped && !result.merged) return { dropped: 0, merged: 0 };
  const earlier = values[tidyKey] && Array.isArray(values[tidyKey].removed) ? values[tidyKey].removed : [];
  await chrome.storage.local.set({
    [glossaryKey]: result.terms,
    [tidyKey]: {
      terms: before,
      removed: Array.from(new Set(earlier.concat(result.removed))).slice(-LIMITS.GLOSSARY_CHAPTER_MAX_TERMS),
      earlierRemoved: earlier,
      touched: result.touched,
      dropped: result.dropped,
      merged: result.merged,
      tidiedAt: Date.now()
    }
  });
  return { dropped: result.dropped, merged: result.merged };
}

async function handleTidyGlossary(message, sender) {
  const { chapter, targetCode } = pretranslationRequest(message, sender);
  const settings = await readSettings();
  if (!settings.glossaryTidyEnabled) return { skipped: true };
  const glossaryKey = tidyNovel.glossaryKeyForWork(chapter, targetCode);
  const metaKey = tidyNovel.metaKeyForWork(chapter, targetCode);
  const values = await chrome.storage.local.get([glossaryKey, metaKey]);
  const meta = tidyNovel.normalizeMeta(values[metaKey]);
  if (!meta || meta.chaptersSinceTidy < settings.glossaryTidyChapters) return { skipped: true };
  // Claimed first: one attempt per interval, so a failing model cannot bill every chapter.
  await chrome.storage.local.set({ [metaKey]: { ...values[metaKey], chaptersSinceTidy: 0 } });
  const terms = tidyNovel.mergeGlossary(values[glossaryKey], []);
  if (terms.length === 0) return { skipped: true };

  const runtime = await resolveRuntime(
    settings.glossaryTidyPurpose, hostnameFromSender(sender), '', settings
  );
  const discardedBilling = [];
  const switchKey = config.STORAGE_KEYS.GLOSSARY_TIDY_ENABLED;
  const cancelled = async () => (await chrome.storage.local.get(switchKey))[switchKey] !== true;
  const plan = await withWorkerKeepalive(async () => api.tidyGlossary({
    apiKey: runtime.apiKey,
    model: runtime.resolved.model,
    provider: runtime.resolved.provider,
    effortLevel: runtime.resolved.effort,
    terms,
    chapters: await tidyChapterTexts(chapter, meta),
    targetCode,
    workTitle: meta.title,
    batchTerms: LIMITS.GLOSSARY_TIDY_BATCH_TERMS,
    cancelled,
    onDiscardedUsage: discardedUsageRecorder(runtime, (billing) => discardedBilling.push(billing))
  }));
  const tidyBilling = [];
  for (const reply of plan.replies) {
    const billed = attachBilling(runtime, reply);
    await recordUsage(billed.usage, billed.billing);
    tidyBilling.push(billed.billing);
  }
  // Switched off meanwhile: the replies are billed, but the glossary stays as it is.
  const saved = await cancelled() ? { dropped: 0, merged: 0 } : await saveGlossaryTidy(
    glossaryKey, tidyNovel.tidyKeyForWork(chapter, targetCode), plan.changes
  );
  return { ...saved, failed: plan.failed, tidyBilling, discardedBilling };
}
