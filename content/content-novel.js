/** Novel behavior for the content script. */
(function registerContentModule(globalScope) {
  'use strict';
  const modules = globalScope.DSHT.contentModules ||= {};
  modules['novel'] = function createModule(app) {
  const { languages, textUtils, novelUtils, MSG, LIMITS, page, overlay } = app;

  function currentNovelChapter() {
    if (!novelUtils || typeof novelUtils.detectChapter !== 'function') return null;
    return novelUtils.detectChapter(location.href);
  }

  function collectNovelRoots(doc, chapter) {
    if (!novelUtils || !chapter || !chapter.isChapter) return [];
    const roots = novelUtils.findChapterRoots(doc, chapter);
    const adapter = novelUtils.SITE_ADAPTERS[chapter.siteId];
    if (adapter && adapter.titleSelector) {
      try {
        const title = doc.querySelector(adapter.titleSelector);
        if (title && !roots.includes(title)) roots.unshift(title);
      } catch (_error) {
        // Ignore title lookup failures.
      }
    }
    return roots;
  }

  async function loadNovelContext(chapter, targetCode) {
    if (!novelUtils || !chapter || !chapter.isChapter) {
      return { chapter: null, meta: null, glossary: [] };
    }
    return app.sendRuntime({
      type: MSG.LOAD_NOVEL_CONTEXT, chapterUrl: chapter.canonicalUrl, targetCode,
      title: novelUtils.getWorkTitle(document, chapter)
    });
  }

  async function saveNovelGlossary(chapter, meta, glossary, targetCode) {
    if (!novelUtils || !chapter) return;
    const runId = page.runId;
    const currentChapter = page.novel?.canonicalUrl;
    const currentTarget = page.targetCode;
    const result = await app.sendRuntime({
      type: MSG.SAVE_NOVEL_GLOSSARY, chapterUrl: chapter.canonicalUrl, targetCode,
      title: meta?.title || '', terms: glossary,
      extracted: Array.isArray(meta?.extractedChapterIds) && meta.extractedChapterIds.includes(chapter.chapterId)
    });
    if (!result.saved) return false;
    if (page.runId === runId && page.novel?.canonicalUrl === currentChapter && page.targetCode === currentTarget) {
      page.glossary = result.glossary;
      page.novelMeta = result.meta;
    }
    return true;
  }

  async function readNovelCache(chapter, targetCode, isCurrent = () => true) {
    if (!novelUtils || !chapter || !chapter.isChapter) return null;
    const key = novelUtils.cacheKeyForChapter(chapter);
    if (!key) return null;
    const values = await app.storageGet(key);
    if (!isCurrent()) return null;
    const record = novelUtils.normalizeCacheRecord(values[key]);
    if (!record) return null;
    const expected = languages.normalizeTarget(targetCode);
    if (record.targetCode !== expected) return null;
    const created = record.createdAt || 0;
    if (created && Date.now() - created > LIMITS.NOVEL_CACHE_TTL_MS) {
      await app.storageRemove(key);
      return null;
    }
    return record;
  }

  function formatNovelCacheCost(record) {
    if (!record || !(record.costUsd > 0)) return '';
    return `≈ $${Number(record.costUsd).toFixed(4)}`;
  }

  function delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  async function maybeExtractNovelTerms(plan, targetCode, sourceHint, runId) {
    if (!page.novelMode || !page.novel || !novelUtils) return;
    if (runId !== page.runId) return;
    let meta = page.novelMeta || novelUtils.addChapterToMeta(null, page.novel);
    if (meta.extractedChapterIds.includes(page.novel.chapterId)) return;
    if (meta.chapterIds.length < LIMITS.NOVEL_CONTEXT_CHAPTERS) return;

    const segments = [];
    let chars = 0;
    for (const segment of plan.segments) {
      const translation = page.initialTranslations.get(segment.id);
      if (!translation) continue;
      const cost = segment.text.length + translation.length;
      if (segments.length >= LIMITS.NOVEL_TERMS_MAX_SEGMENTS) break;
      if (chars + cost > LIMITS.NOVEL_TERMS_MAX_CHARS) break;
      segments.push({ id: segment.id, original: segment.text, translation });
      chars += cost;
    }
    if (segments.length === 0) return;

    try {
      // The stored form: page.glossary has lost the "no gender" choice.
      const glossaryKey = novelUtils.glossaryKeyForWork(page.novel, targetCode);
      const stored = await app.storageGet([glossaryKey]);
      const response = await app.sendRuntime({
        type: MSG.EXTRACT_TERMS,
        targetCode,
        sourceHint,
        glossary: novelUtils.knownTerms(
          stored[glossaryKey], segments.map((segment) => segment.original)
        ),
        segments
      });
      if (runId !== page.runId) return;
      app.addPageCost(response.billing);
      for (const billing of response.reviewBilling || []) app.addPageCost(billing);
      app.addDiscardedCost(response);
      meta = {
        ...meta,
        extractedChapterIds: meta.extractedChapterIds.includes(page.novel.chapterId)
          ? meta.extractedChapterIds
          : meta.extractedChapterIds.concat(page.novel.chapterId).slice(-200)
      };
      await saveNovelGlossary(page.novel, meta, response.terms || [], targetCode);
      if (runId === page.runId) app.renderPagePanel();
    } catch (error) {
      // Glossary extraction is best-effort and must not break translation.
      if (runId === page.runId) {
        app.addDiscardedCost(error);
        app.renderPagePanel();
      }
    }
  }

  /** The worker decides whether one is due; this page only reports the outcome. */
  async function tidyNovelGlossary(targetCode, runId) {
    try {
      const response = await app.sendRuntime({
        type: MSG.TIDY_GLOSSARY, chapterUrl: page.novel.canonicalUrl, targetCode
      });
      if (runId !== page.runId) return;
      for (const billing of response.tidyBilling || []) app.addPageCost(billing);
      app.addDiscardedCost(response);
      if (response.dropped || response.merged) {
        const retry = response.failed ? '部分整理未完成，5 分钟后完成章节时会重试。' : '';
        overlay.showToast(`术语表已整理：移除 ${response.dropped} 条，合并 ${response.merged} 组，可在设置中撤销。${retry}`, response.failed ? 'info' : 'success');
      } else if (response.failed) {
        overlay.showToast('术语表整理未完成，5 分钟后完成章节时会重试。', 'info');
      }
      if (response.tidyBilling) app.renderPagePanel();
    } catch (error) {
      if (runId === page.runId) {
        app.addDiscardedCost(error);
        app.renderPagePanel();
        overlay.showToast(`术语表整理失败：${error.message}`, 'error');
      }
    }
  }

  /** Keep a finished chapter so reopening it costs nothing; failing only loses that. */
  async function saveChapterCache(job) {
    if (job.runId !== page.runId || page.status !== 'done' || page.truncated) return;
    const entries = job.plan.segments.map((segment) => ({
      source: segment.text,
      translation: page.initialTranslations.get(segment.id)
    }));
    if (entries.some((entry) => !entry.translation)) return;
    await app.sendRuntime({
      type: MSG.SAVE_CHAPTER_CACHE,
      chapterUrl: page.novel.canonicalUrl,
      chapterTitle: novelUtils.getTitle(document, page.novel),
      targetCode: job.targetCode,
      polished: page.proofreadEnabled && !page.polishError,
      costUsd: page.estimatedCostUsd,
      translationKey: page.translationKey,
      entries
    }).catch(() => {});
  }

  async function fetchChapterDocument(url, timeoutMs = 30000) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(url, {
        credentials: 'include',
        cache: 'no-store',
        headers: { Accept: 'text/html,application/xhtml+xml' },
        signal: controller.signal
      });
      if (!response || !response.ok) return null;
      const html = await response.text();
      if (!html) return null;
      return new DOMParser().parseFromString(html, 'text/html');
    } finally {
      clearTimeout(timer);
    }
  }

  /** The end of the story, leaving out the author's afterword. */
  function chapterTail(plan) {
    const { afterwordSelector } = novelUtils.SITE_ADAPTERS[page.novel.siteId];
    const story = plan.segments.filter((segment) => {
      const [target] = plan.targetsBySegment.get(String(segment.id)) || [];
      const parent = target && target.node.parentElement;
      return !(afterwordSelector && parent && parent.closest(afterwordSelector));
    });
    return textUtils.precedingText(
      story, story.length, (segment) => segment.text, LIMITS.CONTEXT_PREVIOUS_CHAPTER_CHARS
    );
  }

  async function loadPreviousChapterTail() {
    const url = novelUtils.findPreviousChapterUrl(document, location.href);
    if (!url) return '';
    const doc = await app.fetchChapterDocument(url, LIMITS.CONTEXT_FETCH_MS);
    if (!doc) return '';
    const roots = novelUtils.findChapterRoots(doc, novelUtils.detectChapter(url));
    const collected = app.collectTargets(roots, { bilingual: false, allowDisconnected: true });
    return chapterTail(app.buildPagePlan(collected.targets, false));
  }

  /** Fill the chapter context once per run; a failed lookup only loses that context. */
  async function ensureChapterContext(runId) {
    if (!page.requestContext || !page.novelMode || 'workTitle' in page.requestContext) return;
    const workTitle = (page.novelMeta && page.novelMeta.title) || '';
    const previousChapter = await loadPreviousChapterTail().catch(() => '');
    if (runId === page.runId) page.requestContext = { workTitle, previousChapter };
  }

  async function finishNovelChapter(job) {
    if (!page.novelMode || !page.novel || !novelUtils) return;
    if (job.runId !== page.runId) return;
    // Updating terminology must not hold up preparing the next chapter.
    await Promise.all([
      Promise.all([
        maybeExtractNovelTerms(job.plan, job.targetCode, job.sourceHint, job.runId),
        job.saveCache ? saveChapterCache(job) : Promise.resolve()
      ]).then(() => {
        // Extraction failures and cached chapters must not block an already overdue tidy.
        if (job.runId === page.runId) void tidyNovelGlossary(job.targetCode, job.runId);
      }),
      page.pretranslateEnabled ? app.pretranslateNextChapter(job) : Promise.resolve()
    ]);
  }

  async function waitForNovelRoot(chapter, timeoutMs) {
    const deadline = Date.now() + (timeoutMs || 4000);
    while (Date.now() < deadline) {
      const root = novelUtils.findChapterRoot(document, chapter);
      if (root) return root;
      await delay(160);
    }
    return null;
  }

  async function maybeAutoApplyPretranslation() {
    if (page.autoApplyAttempted || !novelUtils) return;
    page.autoApplyAttempted = true;
    if (page.status !== 'idle') return;
    const runId = page.runId;
    const route = app.currentRoute();
    const isCurrent = () => page.runId === runId && page.status === 'idle' && app.currentRoute() === route;
    const chapter = currentNovelChapter();
    if (!chapter || !chapter.isChapter) return;
    try {
      const settings = await app.readSettings();
      if (!isCurrent()) return;
      if (!app.siteFeatures(settings).pretranslate) return;
      const root = await waitForNovelRoot(chapter, 4000);
      if (!root || !isCurrent()) return;
      const targetCode = languages.normalizeTarget(settings.targetLang);
      const saved = await readNovelCache(chapter, targetCode, isCurrent);
      if (!isCurrent()) return;
      const key = app.translationKey(settings, targetCode);
      const record = saved && novelUtils.cacheMatchesSettings(saved, key) ? saved : null;
      const pending = await app.getPretranslation(chapter, targetCode, key);
      if (!isCurrent() || (!record && pending.status !== 'running')) return;

      if (record) {
        const roots = collectNovelRoots(document, chapter);
        if (roots.length === 0) return;
        const collected = app.collectTargets(roots, { bilingual: Boolean(settings.bilingual) });
        if (collected.targets.length === 0) return;
        const plan = app.buildPagePlan(collected.targets, Boolean(settings.bilingual));
        if (!novelUtils.mapCachedTranslations(plan.segments, record.entries).complete) {
          await app.storageRemove(novelUtils.cacheKeyForChapter(chapter));
          if (!isCurrent() || pending.status !== 'running') return;
        }
      }

      const started = await app.startPageTranslation({
        targetCode,
        bilingual: Boolean(settings.bilingual),
        autoCacheRecord: record,
        autoApplied: true
      });
      if (!started?.started || app.currentRoute() !== route) return;
      overlay.showToast(record ? '已应用本章预翻译缓存。' : '正在接续本章预翻译…', record ? 'success' : 'info');
    } catch (_error) {
      // Auto-apply is best-effort; manual translation remains available.
    }
  }

  return {
    currentNovelChapter,
    collectNovelRoots,
    loadNovelContext,
    saveNovelGlossary,
    readNovelCache,
    formatNovelCacheCost,
    delay,
    maybeExtractNovelTerms,
    saveChapterCache,
    fetchChapterDocument,
    chapterTail,
    ensureChapterContext,
    finishNovelChapter,
    waitForNovelRoot,
    maybeAutoApplyPretranslation
  };
  };
})(globalThis);
