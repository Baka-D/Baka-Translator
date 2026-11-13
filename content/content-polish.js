/** Proofreading pass for the content script. */
(function registerContentModule(globalScope) {
  'use strict';
  const { t } = globalScope.DSHT.i18n;
  const modules = globalScope.DSHT.contentModules ||= {};
  modules['polish'] = function createModule(app) {
  const { textUtils, MSG, LIMITS, page } = app;

  function applyPolishResults(translationList, plan) {
    const polished = new Map();
    if (Array.isArray(translationList)) {
      for (const item of translationList) {
        if (item && item.id !== undefined && typeof item.text === 'string' && item.text.trim()) {
          polished.set(String(item.id), item.text.trim());
        }
      }
    }
    for (const [segmentId, translation] of polished) {
      const targets = plan.targetsBySegment.get(segmentId) || [];
      for (const target of targets) {
        try {
          if (!target.applied || !target.node.isConnected) continue;
          const previous =
            target.lastApplied ||
            `${target.leading}${page.initialTranslations.get(segmentId) || ''}${target.trailing}`;
          if (target.node.nodeValue !== previous) continue;
          const value = `${target.leading}${translation}${target.trailing}`;
          target.node.nodeValue = value;
          target.lastApplied = value;
          page.translatedNodes.set(target.node, {
            original: target.original,
            translated: value
          });
        } catch (_error) {
          // Ignore nodes detached while polishing.
        }
      }
      page.initialTranslations.set(segmentId, translation);
      if (targets.length > 0) app.rememberTranslation(targets[0].core, translation, true);
    }
  }

  async function runPolish(plan, targetCode, sourceHint, runId) {
    const segments = plan.segments
      .map((segment) => {
        const translation = page.initialTranslations.get(segment.id);
        return translation ? { id: segment.id, original: segment.text, translation } : null;
      })
      .filter(Boolean);
    // Only a page polished as a whole is skipped. Anything less sends every
    // segment back, so a changed neighbour can still change a polished line.
    if (segments.every((segment) => page.translationMemory.get(segment.original)?.polished)) return;

    await app.ensureChapterContext(runId);
    if (runId !== page.runId) return;
    app.assertPageRoute();
    const chunks = textUtils.chunkPolishPairs(segments, {
      maxChars: LIMITS.POLISH_CHUNK_CHARS || 16000
    });
    const failures = [];
    let cursor = 0;
    page.polishError = '';
    page.polishProgress = { done: 0, total: chunks.length, failed: 0 };
    page.polishStartedAt = Date.now();
    page.phase = 'polishing';
    app.renderPagePanel();
    app.notifyBadge('running');

    // The panel normally re-renders when a chunk finishes. A lightweight timer
    // also keeps the elapsed counter alive while a slow reasoning model is
    // working on the first chunk.
    if (page.polishTimer) clearInterval(page.polishTimer);
    // Keep this run's handle local so a cancelled run never clears a newer run's timer.
    let polishTimer = 0;
    let heartbeatTimer = 0;
    if (typeof setInterval === 'function') {
      polishTimer = setInterval(() => {
        if (runId !== page.runId || page.phase !== 'polishing') {
          clearInterval(polishTimer);
          if (page.polishTimer === polishTimer) page.polishTimer = 0;
          return;
        }
        app.renderPagePanel();
      }, 1000);
      page.polishTimer = polishTimer;
      if (typeof app.sendHeartbeat === 'function') {
        app.sendHeartbeat();
        heartbeatTimer = setInterval(() => {
          if (runId === page.runId) app.sendHeartbeat();
        }, 15000);
      }
    }

    const worker = async () => {
      while (true) {
        if (runId !== page.runId) return;
        app.assertPageRoute();
        const index = cursor;
        cursor += 1;
        if (index >= chunks.length) return;
        const chunk = chunks[index];
        try {
          const context = textUtils.contextBefore(
            page.requestContext, segments, chunk[0], textUtils.pairText,
            LIMITS.CONTEXT_PRECEDING_CHARS
          );
          const response = await app.sendRuntime({
            type: MSG.POLISH_SEGMENTS,
            targetCode,
            sourceHint,
            glossary: app.requestGlossary(chunk.map((segment) => segment.original), context),
            context,
            segments: chunk
          });
          if (runId !== page.runId) return;
          app.addPageCost(response.billing);
          app.assertPageRoute();
          // Apply each finished chunk immediately so a slow model does not
          // leave the whole page unchanged until the very end.
          applyPolishResults(response.translations, plan);
          if (response.polishError) {
            failures.push(String(response.polishError));
            page.polishProgress.failed += 1;
          }
        } catch (error) {
          if (runId !== page.runId) return;
          if (error.code === 'PAGE_CHANGED') throw error;
          failures.push((error && error.message) || t('content_polish_failed_draft_kept'));
          page.polishProgress.failed += 1;
        }
        if (runId !== page.runId) return;
        page.polishProgress.done += 1;
        app.renderPagePanel();
      }
    };

    const concurrency = Math.max(
      1,
      Math.min(LIMITS.POLISH_MAX_CONCURRENCY || 1, chunks.length)
    );
    try {
      await Promise.all(Array.from({ length: concurrency }, () => worker()));
      if (runId !== page.runId) return;
      if (failures.length > 0) {
        if (chunks.length === 1) {
          page.polishError = failures[0];
        } else if (failures.length === chunks.length) {
          page.polishError = t('content_polish_failure_detail', [failures[0]]);
        } else {
          page.polishError = t('content_polish_partial_detail', [failures.length, chunks.length, failures[0]]);
        }
      }
    } finally {
      if (heartbeatTimer) clearInterval(heartbeatTimer);
      if (polishTimer) clearInterval(polishTimer);
      if (page.polishTimer === polishTimer) page.polishTimer = 0;
    }
  }

  return { applyPolishResults, runPolish };
  };
})(globalThis);
