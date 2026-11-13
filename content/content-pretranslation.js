/** Background-owned next-chapter jobs and foreground cache reuse. */
(function registerContentModule(globalScope) {
  'use strict';
  const { t } = globalScope.DSHT.i18n;
  const modules = globalScope.DSHT.contentModules ||= {};
  modules.pretranslation = function createModule(app) {
    const { novelUtils, MSG, LIMITS, page, overlay } = app;

    function showPretranslation(snapshot, scope, chapterUrl) {
      page.pretranslationStatus = snapshot.status || '';
      page.pretranslationNote = snapshot.note || '';
      page.pretranslationProgress = snapshot.progress || { stage: '', done: 0, total: 0 };
      page.pretranslationScope = scope;
      page.pretranslationChapterUrl = chapterUrl;
      app.renderPagePanel();
    }

    function getPretranslation(chapter, targetCode, translationKey = page.translationKey) {
      return app.sendRuntime({
        type: MSG.GET_PRETRANSLATION,
        chapterUrl: chapter.canonicalUrl,
        targetCode,
        translationKey
      });
    }

    async function pretranslateNextChapter(job) {
      if (!page.novelMode || !page.novel || page.pretranslateBusy) return;
      if (!page.pretranslateEnabled || job.runId !== page.runId) return;
      if (page.abortFatal || page.status === 'error') return;
      const nextUrl = novelUtils.findNextChapterUrl(document, location.href);
      const chapter = novelUtils.detectChapter(nextUrl);
      if (!chapter || !chapter.isChapter || chapter.workId !== page.novel.workId) return;

      page.pretranslateBusy = true;
      showPretranslation({
        status: 'running', progress: { stage: 'fetching', done: 0, total: 0 },
        note: t('content_reading_next_chapter')
      }, 'next', nextUrl);
      try {
        app.assertPageRoute();
        let snapshot = await getPretranslation(chapter, job.targetCode);
        if (job.runId !== page.runId) return;
        app.assertPageRoute();
        const saved = await app.readNovelCache(chapter, job.targetCode);
        if (job.runId !== page.runId) return;
        app.assertPageRoute();
        const cached = saved && novelUtils.cacheMatchesSettings(saved, page.translationKey);
        if (snapshot.status !== 'running' && cached) {
          snapshot = { status: 'ready', note: t('content_next_chapter_cached') };
        } else if (snapshot.status !== 'running') {
          const doc = await app.fetchChapterDocument(nextUrl);
          if (job.runId !== page.runId) return;
          app.assertPageRoute();
          if (!doc) throw new Error(t('content_next_chapter_unreadable'));
          const roots = app.collectNovelRoots(doc, chapter);
          const collected = app.collectTargets(roots, { bilingual: false, allowDisconnected: true });
          const plan = app.buildPagePlan(collected.targets, false);
          if (!plan.segments.length) throw new Error(t('content_next_chapter_empty'));
          const chars = plan.segments.reduce((sum, segment) => sum + segment.text.length, 0);
          if (collected.truncated || chars > LIMITS.NOVEL_PRETRANSLATE_MAX_CHARS) {
            throw new Error(t('content_next_chapter_too_long'));
          }
          await app.ensureChapterContext(job.runId);
          if (job.runId !== page.runId) return;
          app.assertPageRoute();
          const context = page.requestContext
            ? { ...page.requestContext, previousChapter: app.chapterTail(job.plan) }
            : undefined;
          snapshot = await app.sendRuntime({
            type: MSG.PRETRANSLATE_CHAPTER,
            chapterUrl: nextUrl,
            chapterTitle: novelUtils.getTitle(doc, chapter),
            targetCode: job.targetCode,
            sourceHint: job.sourceHint,
            // The worker narrows this to each batch, so it must cover the whole chapter.
            glossary: novelUtils.selectGlossary(
              page.glossary,
              [...plan.segments.map((segment) => segment.text), context && context.previousChapter]
            ),
            context,
            polish: page.proofreadEnabled,
            translationKey: page.translationKey,
            segments: plan.segments.map(({ id, text }) => ({ id, text }))
          });
        }
        while (job.runId === page.runId) {
          app.assertPageRoute();
          showPretranslation(snapshot, 'next', nextUrl);
          if (snapshot.status !== 'running') break;
          await app.delay(1000);
          if (job.runId !== page.runId) return;
          app.assertPageRoute();
          snapshot = await getPretranslation(chapter, job.targetCode);
        }
        if (job.runId !== page.runId) return;
        if (snapshot.status === 'ready') {
          overlay.showToast(t('content_next_chapter_done'), 'success');
        } else if (snapshot.status === 'none') {
          showPretranslation({ status: 'error', note: t('content_pretranslation_stopped') }, 'next', nextUrl);
        }
      } catch (error) {
        if (job.runId === page.runId) {
          showPretranslation({ status: 'error', note: error.message || t('content_pretranslation_failed') }, 'next', nextUrl);
        }
      } finally {
        if (job.runId === page.runId) {
          page.pretranslateBusy = false;
          app.renderPagePanel();
        }
      }
    }

    async function matchingCache(chapter, targetCode, plan, candidate) {
      const record = candidate || await app.readNovelCache(chapter, targetCode);
      if (!record || record.targetCode !== targetCode) return null;
      // Made under other settings: keep it, but this run must use the current ones.
      if (!novelUtils.cacheMatchesSettings(record, page.translationKey)) return null;
      if (novelUtils.mapCachedTranslations(plan.segments, record.entries).complete) return record;
      await app.storageRemove(novelUtils.cacheKeyForChapter(chapter));
      return null;
    }

    async function resolveChapterPretranslation(job) {
      if (!page.novelMode || job.force) return null;
      const chapter = page.novel;
      let candidate = job.cacheRecord;
      while (job.runId === page.runId) {
        app.assertPageRoute();
        const snapshot = await getPretranslation(chapter, job.targetCode);
        if (job.runId !== page.runId) return null;
        app.assertPageRoute();
        const record = await matchingCache(chapter, job.targetCode, job.plan, candidate);
        candidate = null;
        if (job.runId !== page.runId) return null;
        app.assertPageRoute();
        if (record) return { record, snapshot, chapter };
        if (snapshot.status !== 'running') return null;
        page.phase = 'pretranslating';
        showPretranslation(snapshot, 'current', chapter.canonicalUrl);
        await app.delay(500);
      }
      return null;
    }

    async function applyCachedChapter(job, cached) {
      let { record, snapshot } = cached;
      const { chapter } = cached;
      app.assertPageRoute();
      const mapped = novelUtils.mapCachedTranslations(job.plan.segments, record.entries);
      app.applyTranslationsForBatch(job.plan.segments, mapped.translations, job.plan, { updateProgress: true });
      page.cachedPretranslation = true;
      // Make the complete first draft readable while the same background job polishes it.
      if (page.bilingual) app.applyBilingualCaptions(job.plan.anchors);
      while (snapshot.status === 'running' && job.runId === page.runId) {
        app.assertPageRoute();
        page.phase = 'pretranslating';
        showPretranslation(snapshot, 'current', chapter.canonicalUrl);
        await app.delay(500);
        if (job.runId !== page.runId) return;
        app.assertPageRoute();
        snapshot = await getPretranslation(chapter, job.targetCode);
      }
      if (job.runId !== page.runId) return;
      app.assertPageRoute();
      const finalRecord = await matchingCache(chapter, job.targetCode, job.plan);
      if (job.runId !== page.runId) return;
      app.assertPageRoute();
      if (finalRecord) {
        record = finalRecord;
        const final = novelUtils.mapCachedTranslations(job.plan.segments, record.entries);
        app.applyPolishResults(final.translations, job.plan);
      }
      page.estimatedCostUsd = Number(record.costUsd) || 0;
      page.polishError = page.proofreadEnabled && !record.polished
        ? t('content_cached_draft_only')
        : '';
      page.pretranslationStatus = '';
      page.pretranslationNote = '';
      page.pretranslationProgress = { stage: '', done: 0, total: 0 };
      page.pretranslationChapterUrl = '';
      return { needsPolish: Boolean(page.proofreadEnabled && !record.polished) };
    }

    function cancelPretranslation() {
      const chapterUrl = page.pretranslationChapterUrl;
      if (!chapterUrl || page.pretranslationStatus !== 'running') return;
      void app.sendRuntime({
        type: MSG.CANCEL_PRETRANSLATION, chapterUrl, targetCode: page.targetCode,
        translationKey: page.translationKey
      }).catch(() => {});
    }

    return { showPretranslation, getPretranslation, pretranslateNextChapter,
      resolveChapterPretranslation, applyCachedChapter, cancelPretranslation };
  };
})(globalThis);
