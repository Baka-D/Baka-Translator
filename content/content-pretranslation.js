/** Background-owned next-chapter jobs and foreground cache reuse. */
(function registerContentModule(globalScope) {
  'use strict';
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

    function getPretranslation(chapter, targetCode) {
      return app.sendRuntime({
        type: MSG.GET_PRETRANSLATION,
        chapterUrl: chapter.canonicalUrl,
        targetCode
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
        note: '正在读取下一章…'
      }, 'next', nextUrl);
      try {
        let snapshot = await getPretranslation(chapter, job.targetCode);
        if (job.runId !== page.runId) return;
        const saved = await app.readNovelCache(chapter, job.targetCode);
        if (job.runId !== page.runId) return;
        const cached = saved && novelUtils.cacheMatchesSettings(saved, page.translationKey);
        if (snapshot.status !== 'running' && cached) {
          snapshot = { status: 'ready', note: '下一章已有预翻译缓存。' };
        } else if (snapshot.status !== 'running') {
          const doc = await app.fetchChapterDocument(nextUrl);
          if (job.runId !== page.runId) return;
          if (!doc) throw new Error('无法读取下一页内容。');
          const roots = app.collectNovelRoots(doc, chapter);
          const collected = app.collectTargets(roots, { bilingual: false, allowDisconnected: true });
          const plan = app.buildPagePlan(collected.targets, false);
          if (!plan.segments.length) throw new Error('下一页没有可翻译的章节正文。');
          const chars = plan.segments.reduce((sum, segment) => sum + segment.text.length, 0);
          if (collected.truncated || chars > LIMITS.NOVEL_PRETRANSLATE_MAX_CHARS) {
            throw new Error('下一章过长，跳过预翻译。');
          }
          await app.ensureChapterContext(job.runId);
          if (job.runId !== page.runId) return;
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
          showPretranslation(snapshot, 'next', nextUrl);
          if (snapshot.status !== 'running') break;
          await app.delay(1000);
          if (job.runId !== page.runId) return;
          snapshot = await getPretranslation(chapter, job.targetCode);
        }
        if (job.runId !== page.runId) return;
        if (snapshot.status === 'ready') {
          overlay.showToast('已预翻译下一章，打开时会自动应用。', 'success');
        } else if (snapshot.status === 'none') {
          showPretranslation({ status: 'error', note: '预翻译已停止，打开下一章后可继续翻译。' }, 'next', nextUrl);
        }
      } catch (error) {
        if (job.runId === page.runId) {
          showPretranslation({ status: 'error', note: error.message || '预翻译失败，请稍后重试。' }, 'next', nextUrl);
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
        const snapshot = await getPretranslation(chapter, job.targetCode);
        if (job.runId !== page.runId) return null;
        const record = await matchingCache(chapter, job.targetCode, job.plan, candidate);
        candidate = null;
        if (job.runId !== page.runId) return null;
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
      const mapped = novelUtils.mapCachedTranslations(job.plan.segments, record.entries);
      app.applyTranslationsForBatch(job.plan.segments, mapped.translations, job.plan, { updateProgress: true });
      page.cachedPretranslation = true;
      // Make the complete first draft readable while the same background job polishes it.
      if (page.bilingual) app.applyBilingualCaptions(job.plan.anchors);
      while (snapshot.status === 'running' && job.runId === page.runId) {
        page.phase = 'pretranslating';
        showPretranslation(snapshot, 'current', chapter.canonicalUrl);
        await app.delay(500);
        if (job.runId !== page.runId) return;
        snapshot = await getPretranslation(chapter, job.targetCode);
      }
      if (job.runId !== page.runId) return;
      const finalRecord = await matchingCache(chapter, job.targetCode, job.plan);
      if (job.runId !== page.runId) return;
      if (finalRecord) {
        record = finalRecord;
        const final = novelUtils.mapCachedTranslations(job.plan.segments, record.entries);
        app.applyPolishResults(final.translations, job.plan);
      }
      page.estimatedCostUsd = Number(record.costUsd) || 0;
      page.polishError = page.proofreadEnabled && !record.polished
        ? '预翻译缓存只包含初译，尚未润色。'
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
        type: MSG.CANCEL_PRETRANSLATION, chapterUrl, targetCode: page.targetCode
      }).catch(() => {});
    }

    return { showPretranslation, getPretranslation, pretranslateNextChapter,
      resolveChapterPretranslation, applyCachedChapter, cancelPretranslation };
  };
})(globalThis);
