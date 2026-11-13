/** Page behavior for the content script. */
(function registerContentModule(globalScope) {
  'use strict';
  const { t } = globalScope.DSHT.i18n;
  const modules = globalScope.DSHT.contentModules ||= {};
  modules['page'] = function createModule(app) {
  const { languages, textUtils, novelUtils, MSG, LIMITS, FATAL_ERROR_CODES, page, overlay } = app;

  /**
   * Remember a translation for this tab. Novel chapters are left out: they
   * have their own cache and their glossary changes from run to run.
   */
  function rememberTranslation(text, translation, polished) {
    const memory = page.translationMemory;
    if (page.novelMode || (!polished && memory.has(text))) return;
    memory.delete(text);
    memory.set(text, { text: translation, polished });
    if (memory.size > LIMITS.TRANSLATION_MEMORY_MAX_ITEMS) memory.delete(memory.keys().next().value);
  }

  /** The terms one request can use: the library itself may be far larger. */
  function requestGlossary(texts, context) {
    if (page.glossary.length === 0) return page.glossary;
    return novelUtils.requestGlossary(page.glossary, texts, context);
  }

  function applyTranslationsForBatch(batch, translationList, plan, options) {
    const opts = options || {};
    const translations = new Map();
    if (Array.isArray(translationList)) {
      for (const item of translationList) {
        if (item && item.id !== undefined && typeof item.text === 'string') {
          translations.set(String(item.id), item.text);
        }
      }
    }

    let appliedTargetCount = 0;
    for (const segment of batch) {
      const raw = translations.get(String(segment.id));
      const translation = typeof raw === 'string' ? raw.trim() : '';
      const targets = plan.targetsBySegment.get(String(segment.id)) || [];
      let applied = false;

      if (translation) {
        for (const target of targets) {
          try {
            const nodes = Array.isArray(target.nodes) ? target.nodes : [target.node];
            if (nodes.some((node) => !node.isConnected)) continue;
            if (target.node.nodeValue !== target.original) continue;
            if (nodes.some((node, index) => {
              return index > 0 &&
                Array.isArray(target.nodeOriginals) &&
                node.nodeValue !== target.nodeOriginals[index];
            })) continue;
            const value = `${target.leading}${translation}${target.trailing}`;
            target.node.nodeValue = value;
            page.translatedNodes.set(target.node, {
              original: target.original,
              translated: value
            });
            for (let index = 1; index < nodes.length; index += 1) {
              const node = nodes[index];
              const prev = page.translatedNodes.get(node);
              page.translatedNodes.set(node, {
                // A node emptied by an earlier group keeps its real original.
                original: prev && node.nodeValue === prev.translated ? prev.original : node.nodeValue,
                translated: ''
              });
              node.nodeValue = '';
            }
            if (typeof app.hideRubyReadings === 'function') {
              app.hideRubyReadings(target.rubyReadings);
            }
            target.applied = true;
            target.lastApplied = value;
            if (target.anchorRecord) target.anchorRecord.applied = true;
            applied = true;
            appliedTargetCount += 1;
          } catch (_error) {
            // The node may have been detached by the page.
          }
        }
      }

      if (applied) {
        page.initialTranslations.set(String(segment.id), translation);
        rememberTranslation(segment.text, translation, false);
      } else if (opts.updateProgress) {
        page.progress.failed += 1;
      }
    }

    if (opts.updateProgress) {
      page.progress.done += batch.length;
      app.renderPagePanel();
    }
    return appliedTargetCount;
  }

  function addDiscardedCost({ discardedBilling }) {
    for (const billing of discardedBilling || []) app.addPageCost(billing);
  }

  function pageBatches(segments, divisor = 1) {
    return textUtils.createBatches(segments, {
      maxChars: LIMITS.TEXT_MAX_BATCH_CHARS / divisor,
      maxItems: LIMITS.TEXT_MAX_BATCH_ITEMS / divisor
    });
  }

  /**
   * Send `batches`. Unless this is the last pass, what came back empty is returned for
   * one more try, and a batch that failed is returned in halves: resending it whole often
   * fails the same way.
   */
  async function translateSegments(job, batches, lastPass) {
    const { plan, targetCode, sourceHint, runId } = job;
    const retry = { segments: [], batches: [] };
    let cursor = 0;

    const worker = async () => {
      while (true) {
        if (runId !== page.runId || page.abortFatal) return;
        app.assertPageRoute();
        const index = cursor;
        cursor += 1;
        if (index >= batches.length) return;
        const batch = batches[index];
        try {
          const context = textUtils.contextBefore(
            page.requestContext, plan.segments, batch[0], (segment) => segment.text,
            LIMITS.CONTEXT_PRECEDING_CHARS
          );
          const response = await app.sendRuntime({
            type: MSG.TRANSLATE_BATCH,
            targetCode,
            sourceHint,
            glossary: requestGlossary(batch.map((segment) => segment.text), context),
            context,
            segments: batch.map((segment) => ({ id: segment.id, text: segment.text }))
          });
          if (runId !== page.runId) return;
          app.addPageCost(response.billing);
          addDiscardedCost(response);
          app.assertPageRoute();
          const list = Array.isArray(response.translations) ? response.translations : [];
          const answered = new Set(list
            .filter((item) => item && typeof item.text === 'string' && item.text.trim())
            .map((item) => String(item.id)));
          const unanswered = lastPass ? [] : batch.filter((segment) => !answered.has(String(segment.id)));
          retry.segments.push(...unanswered);
          const settled = batch.filter((segment) => !unanswered.includes(segment));
          applyTranslationsForBatch(settled, response.translations, plan, { updateProgress: true });
        } catch (error) {
          if (runId !== page.runId) return;
          if (error.code === 'PAGE_CHANGED') throw error;
          addDiscardedCost(error);
          const fatal = FATAL_ERROR_CODES.has(String(error.code || ''));
          const truncated = error.code === 'OUTPUT_TRUNCATED' && batch.length > 1;
          if (!lastPass && !fatal && (error.retryable === true || truncated)) {
            const middle = Math.ceil(batch.length / 2);
            retry.batches.push(...[batch.slice(0, middle), batch.slice(middle)].filter((half) => half.length > 0));
            continue;
          }
          page.progress.done += batch.length;
          page.progress.failed += batch.length;
          if (!page.error) page.error = error.message || t('content_some_translation_failed');
          if (!page.errorCode) page.errorCode = error.code || '';
          if (fatal) page.abortFatal = true;
          app.renderPagePanel();
        }
      }
    };

    const workerCount = Math.max(1, Math.min(LIMITS.TEXT_MAX_CONCURRENCY, batches.length));
    await Promise.all(Array.from({ length: workerCount }, () => worker()));
    return retry;
  }

  async function runPageTranslation(job) {
    const { plan, targetCode, sourceHint, runId } = job;
    const cached = await app.resolveChapterPretranslation(job);
    if (runId !== page.runId) return;
    app.assertPageRoute();
    let saveCache = !cached;
    if (cached) {
      const cachedResult = await app.applyCachedChapter(job, cached);
      if (runId !== page.runId) return;
      // Cached pretranslation may contain only an unpolished first draft. When
      // proofreading is enabled for this site, polish it now instead of leaving
      // a permanent "润色未完成" warning.
      if (cachedResult && cachedResult.needsPolish &&
          page.initialTranslations.size > 0 && !page.abortFatal) {
        await app.runPolish(plan, targetCode, sourceHint, runId);
        if (runId !== page.runId) return;
        page.phase = '';
        saveCache = true;
      }
    } else {
      page.phase = 'translating';
      page.pretranslationStatus = '';
      page.pretranslationNote = '';
      page.pretranslationChapterUrl = '';
      app.renderPagePanel();
      await app.ensureChapterContext(runId);
      if (runId !== page.runId) return;
      app.assertPageRoute();
      const recalled = textUtils.recallTranslations(plan.segments, page.translationMemory);
      if (recalled.known.length > 0) {
        applyTranslationsForBatch(recalled.known, recalled.translations, plan, { updateProgress: true });
      }
      const retry = await translateSegments(job, pageBatches(recalled.fresh), false);
      await translateSegments(job, [...pageBatches(retry.segments, 2), ...retry.batches], true);

      if (runId !== page.runId) return;
      // Captions follow the first draft, as on the cache path; polishing only rewrites target text.
      if (page.bilingual) app.applyBilingualCaptions(plan.anchors);

      if (page.proofreadEnabled && page.initialTranslations.size > 0 && !page.abortFatal) {
        await app.runPolish(plan, targetCode, sourceHint, runId);
        if (runId !== page.runId) return;
        page.phase = '';
      }
    }

    if (page.bilingual && plan.anchors.length > 0) {
      app.applyBilingualCaptions(plan.anchors);
    }

    page.phase = '';

    if (page.translatedNodes.size === 0) {
      page.status = 'error';
      page.error = page.error || t('content_nothing_translated');
    } else if (page.progress.failed > 0 || page.abortFatal) {
      page.status = 'partial';
    } else {
      page.status = 'done';
    }
    // A panel hidden during the run comes back for failures the user has to see.
    if (page.status !== 'done' || page.polishError) page.panelDismissed = false;

    app.renderPagePanel();
    app.notifyBadge(page.status);
    if (page.translatedNodes.size > 0) {
      if (page.status === 'done' || (page.status === 'partial' && !page.abortFatal)) {
        app.startDynamicObserver();
        void app.finishNovelChapter({ plan, targetCode, sourceHint, runId, saveCache });
      }
    }
  }

  async function startPageTranslation(message) {
    const request = message || {};
    if (page.status === 'running') {
      return { started: false, reason: 'running' };
    }

    if (page.translatedNodes.size > 0 || page.status !== 'idle') {
      restorePage({ silent: true });
    }

    page.runId += 1;
    const runId = page.runId;
    page.status = 'running';
    page.phase = 'translating';
    page.translatedRoute = app.currentRoute();
    page.panelDismissed = false;
    page.error = '';
    page.errorCode = '';
    page.polishError = '';
    if (page.polishTimer) {
      clearInterval(page.polishTimer);
      page.polishTimer = 0;
    }
    page.polishProgress = { done: 0, total: 0, failed: 0 };
    page.polishStartedAt = 0;
    page.proofreadEnabled = false;
    page.estimatedCostUsd = 0;
    page.costCurrency = 'USD';
    page.abortFatal = false;
    page.truncated = false;
    page.progress = { done: 0, total: 0, failed: 0 };
    page.bilingual = false;
    page.targetCode = null;
    page.targetLabel = '';
    page.initialTranslations.clear();
    page.novel = null;
    page.novelMode = false;
    page.novelMeta = null;
    page.glossary = [];
    page.requestContext = null;
    page.pretranslateEnabled = false;
    page.pretranslationStatus = '';
    page.pretranslationNote = '';
    page.pretranslationProgress = { stage: '', done: 0, total: 0 };
    page.pretranslationScope = 'next';
    page.pretranslationChapterUrl = '';
    page.cachedPretranslation = false;
    page.pretranslateBusy = false;

    try {
      const settings = await app.readSettings();
      if (runId !== page.runId) return { started: false, reason: 'cancelled' };
      app.assertPageRoute();
      const features = app.siteFeatures(settings);
      page.proofreadEnabled = features.polish;
      page.pretranslateEnabled = features.pretranslate;
      page.presetId = features.presetId || '';
      page.requestContext = app.contextEnabled(settings) ? {} : null;
      const targetCode = languages.normalizeTarget(
        request.targetCode !== undefined ? request.targetCode : settings.targetLang
      );
      const translationKey = app.translationKey(settings, targetCode);
      if (request.force || translationKey !== page.translationKey) page.translationMemory.clear();
      page.translationKey = translationKey;
      const novelChapter = app.currentNovelChapter();
      page.novel = novelChapter;
      page.novelMode = Boolean(novelChapter && novelChapter.isChapter);
      if (page.novelMode) {
        const novelContext = await app.loadNovelContext(novelChapter, targetCode);
        if (runId !== page.runId) return { started: false, reason: 'cancelled' };
        app.assertPageRoute();
        page.novelMeta = novelContext.meta;
        page.glossary = novelContext.glossary || [];
        page.novelMeta = novelUtils.addChapterToMeta(page.novelMeta, novelChapter);
      }
      const target = languages.getTargetLanguage(targetCode);
      const bilingual =
        typeof request.bilingual === 'boolean' ? request.bilingual : Boolean(settings.bilingual);
      const roots = page.novelMode
        ? app.collectNovelRoots(document, novelChapter)
        : app.collectComposedTextRoots(document);
      page.translatedDocuments = new WeakSet(roots.map((root) => root.ownerDocument || document));
      if (roots.length === 0) {
        throw new Error(t('content_page_not_ready'));
      }

      const collected = app.collectTargets(roots, { bilingual });
      if (collected.targets.length === 0) {
        page.status = 'idle';
        page.phase = '';
        page.truncated = false;
        page.progress = { done: 0, total: 0, failed: 0 };
        overlay.hidePanel();
        app.notifyBadge('idle');
        const message = app.noTranslatableTextMessage();
        overlay.showToast(message, 'info');
        return {
          ok: false,
          error: { code: 'NO_TRANSLATABLE_TEXT', message }
        };
      }

      const plan = app.buildPagePlan(collected.targets, bilingual);
      const source = app.detectFromTargets(collected.targets);
      const cacheRecord =
        request.autoCacheRecord && novelUtils
          ? novelUtils.normalizeCacheRecord(request.autoCacheRecord)
          : null;
      const validCache =
        cacheRecord && cacheRecord.targetCode === targetCode ? cacheRecord : null;
      page.cachedPretranslation = false;
      page.targetCode = targetCode;
      page.targetLabel = globalScope.DSHT.i18n.languageLabel(target.code);
      page.bilingual = bilingual;
      page.source = source;
      page.truncated = collected.truncated;
      page.detectionCache = { value: source, at: Date.now() };
      page.progress = {
        done: 0,
        total: plan.segments.length,
        failed: 0
      };

      app.renderPagePanel();
      app.notifyBadge('running');

      void runPageTranslation({
        plan,
        targetCode,
        sourceHint: source.code,
        runId,
        cacheRecord: validCache,
        force: request.force === true
      }).catch((error) => {
        if (runId !== page.runId) return;
        page.phase = '';
        page.status = page.translatedNodes.size > 0 ? 'partial' : 'error';
        page.error = error.message || t('content_page_failed_short');
        page.errorCode = error.code || '';
        page.panelDismissed = false;
        app.renderPagePanel();
        app.notifyBadge(page.status);
      });

      return { started: true, totalSegments: plan.segments.length };
    } catch (error) {
      if (runId !== page.runId) return { started: false, reason: 'cancelled' };
      page.phase = '';
      page.status = page.translatedNodes.size > 0 ? 'partial' : 'error';
      page.error = error.message || t('content_page_failed_retry');
      page.errorCode = error.code || '';
      app.renderPagePanel();
      app.notifyBadge(page.status);
      return { ok: false, error: app.errorPayload(error) };
    }
  }

  function restorePage(options) {
    const opts = options || {};
    const hadTranslation =
      page.translatedNodes.size > 0 ||
      page.captions.size > 0 ||
      page.status === 'running' ||
      page.status === 'done' ||
      page.status === 'partial' ||
      page.status === 'error';

    app.cancelPretranslation();
    if (hadTranslation) void app.sendRuntime({ type: MSG.STOP_PAGE_REQUESTS }).catch(() => {});
    page.runId += 1;
    app.disconnectDynamicObserver();
    if (page.dynamicTimer) {
      clearTimeout(page.dynamicTimer);
      page.dynamicTimer = 0;
    }
    page.dynamicQueue.clear();
    app.restoreTranslatedNodes();
    if (typeof app.restoreRubyReadings === 'function') app.restoreRubyReadings();
    app.removeBilingualCaptions();
    page.status = 'idle';
    page.phase = '';
    page.targetCode = null;
    page.targetLabel = '';
    page.bilingual = false;
    page.proofreadEnabled = false;
    page.polishError = '';
    if (page.polishTimer) {
      clearInterval(page.polishTimer);
      page.polishTimer = 0;
    }
    page.polishProgress = { done: 0, total: 0, failed: 0 };
    page.polishStartedAt = 0;
    page.estimatedCostUsd = 0;
    page.costCurrency = 'USD';
    page.novel = null;
    page.novelMode = false;
    page.novelMeta = null;
    page.glossary = [];
    page.requestContext = null;
    page.pretranslateEnabled = false;
    page.pretranslationStatus = '';
    page.pretranslationNote = '';
    page.pretranslationProgress = { stage: '', done: 0, total: 0 };
    page.pretranslationScope = 'next';
    page.pretranslationChapterUrl = '';
    page.cachedPretranslation = false;
    page.pretranslateBusy = false;
    page.source = null;
    page.detectionCache = null;
    page.progress = { done: 0, total: 0, failed: 0 };
    page.truncated = false;
    page.error = '';
    page.errorCode = '';
    page.abortFatal = false;
    page.panelDismissed = false;
    page.dynamicBusy = false;
    page.dynamicNodeCount = 0;
    page.dynamicCharCount = 0;
    page.initialTranslations.clear();
    overlay.hidePanel();
    app.notifyBadge('idle');
    if (!opts.silent && hadTranslation) {
      overlay.showToast(t('content_page_restored'), 'success');
    }
    return hadTranslation;
  }

  return {
    addDiscardedCost,
    requestGlossary,
    rememberTranslation,
    applyTranslationsForBatch,
    runPageTranslation,
    startPageTranslation,
    restorePage
  };
  };
})(globalThis);
