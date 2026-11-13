/** Page ui behavior for the content script. */
(function registerContentModule(globalScope) {
  'use strict';
  const { t } = globalScope.DSHT.i18n;
  const modules = globalScope.DSHT.contentModules ||= {};
  modules['page-ui'] = function createModule(app) {
  const { SETTINGS_ERROR_CODES, page, imageJob, overlay } = app;

  function buildPageInfo() {
    let source = page.source;
    if (!source) source = app.detectPageLanguage(false);
    return {
      status: page.status,
      phase: page.phase || '',
      pageTranslated: page.status === 'running' || page.translatedNodes.size > 0,
      targetCode: page.targetCode || null,
      targetLabel: page.targetLabel || null,
      bilingual: page.bilingual,
      source,
      progress: { ...page.progress },
      truncated: page.truncated,
      error: page.error || null,
      proofreadEnabled: page.proofreadEnabled,
      polishError: page.polishError || null,
      polishProgress: { done: 0, total: 0, failed: 0, ...(page.polishProgress || {}) },
      polishElapsedMs:
        page.phase === 'polishing' && page.polishStartedAt
          ? Math.max(0, Date.now() - page.polishStartedAt)
          : 0,
      estimatedCostUsd: Math.round(page.estimatedCostUsd * 1e10) / 1e10,
      costCurrency: page.costCurrency || 'USD',
      novel: page.novel
        ? {
            siteId: page.novel.siteId,
            siteName: page.novel.siteName,
            workId: page.novel.workId,
            chapterId: page.novel.chapterId,
            isChapter: page.novel.isChapter
          }
        : null,
      pretranslateEnabled: page.pretranslateEnabled,
      presetId: page.presetId || '',
      pretranslationStatus: page.pretranslationStatus || '',
      pretranslationNote: page.pretranslationNote || '',
      pretranslationScope: page.pretranslationScope === 'current' ? 'current' : 'next',
      pretranslationProgress: { stage: '', done: 0, total: 0, ...page.pretranslationProgress },
      cachedPretranslation: page.cachedPretranslation,
      imagePanelOpen: imageJob.open
    };
  }

  function errorPayload(error) {
    return {
      code: (error && error.code) || 'UNKNOWN_ERROR',
      message: (error && error.message) || t('content_unknown_error')
    };
  }

  function respondError(sendResponse, error) {
    sendResponse({ ok: false, error: errorPayload(error) });
  }

  function isSettingsError(code) {
    return SETTINGS_ERROR_CODES.has(String(code || ''));
  }

  function addPageCost(billing) {
    if (!billing || !billing.available) return;
    const cost = Number(billing.costUsd);
    if (!Number.isFinite(cost) || cost < 0) return;
    page.estimatedCostUsd += cost;
    if (typeof billing.currency === 'string' && billing.currency) {
      page.costCurrency = billing.currency;
    }
  }

  function formatPageCost() {
    if (!(page.estimatedCostUsd > 0)) return '';
    const amount = page.estimatedCostUsd;
    const digits = amount < 0.0001 ? 6 : 4;
    const formatted = amount.toFixed(digits);
    const currency = page.costCurrency || 'USD';
    return currency === 'USD' ? `≈ $${formatted}` : `≈ ${formatted} ${currency}`;
  }

  function ratio() {
    if (!page.progress.total) return 0;
    return Math.min(1, page.progress.done / page.progress.total);
  }

  function pretranslationDisplay() {
    const progress = page.pretranslationProgress || {};
    const stages = { fetching: t('content_stage_fetch'), translating: t('content_stage_translate'), polishing: t('content_stage_polish'), saving: t('content_stage_save') };
    const total = Math.max(0, Number(progress.total) || 0);
    const done = Math.max(0, Math.min(total, Number(progress.done) || 0));
    return {
      active: page.pretranslationStatus === 'running',
      title: page.pretranslationScope === 'current' ? t('content_resume_chapter') : t('content_next_chapter_pretranslating'),
      detail: t('content_stage_progress', [stages[progress.stage] || t('content_preparing'), total > 0 ? t('content_segment_progress', [done, total]) : '…']),
      showProgress: total > 0,
      ratio: total > 0 ? done / total : 0
    };
  }

  function renderPagePanel() {
    if (page.status === 'idle') {
      overlay.hidePanel();
      return;
    }
    if (page.panelDismissed) return;

    const sourceLabel = page.source?.code ? globalScope.DSHT.i18n.languageLabel(page.source.code) : t('content_auto_detect');
    const targetLabel = page.targetCode ? globalScope.DSHT.i18n.languageLabel(page.targetCode) : t('content_target_language');
    const costText = formatPageCost();
    const pretranslation = pretranslationDisplay();
    if (page.status === 'running') {
      if (page.phase === 'pretranslating') {
        overlay.renderPanel({
          visible: true,
          status: 'running',
          title: `${pretranslation.title}…`,
          subtitle: pretranslation.detail,
          showProgress: pretranslation.showProgress,
          progressRatio: pretranslation.ratio,
          actions: [{ id: 'cancel', label: t('content_stop_restore'), variant: 'ghost' }],
          showDismiss: true,
          note: ''
        });
        return;
      }
      if (page.phase === 'polishing') {
        const polish = { done: 0, total: 0, failed: 0, ...(page.polishProgress || {}) };
        const elapsed = page.polishStartedAt
          ? Math.max(0, Math.round((Date.now() - page.polishStartedAt) / 1000))
          : 0;
        overlay.renderPanel({
          visible: true,
          status: 'running',
          title: t('content_background_polish'),
          subtitle: t('content_page_polish_progress', [sourceLabel, targetLabel, polish.done, polish.total, polish.failed ? t('content_failed_chunks', [polish.failed]) : '', elapsed]),
          showProgress: polish.total > 0,
          progressRatio: polish.total > 0 ? Math.min(1, polish.done / polish.total) : 0,
          actions: [{ id: 'cancel', label: t('content_stop_restore'), variant: 'ghost' }],
          showDismiss: true,
          note: page.truncated
            ? t('content_page_truncated_processing')
            : t('content_draft_readable')
        });
        return;
      }
      const note = page.truncated
        ? t('content_page_truncated_translating')
        : '';
      overlay.renderPanel({
        visible: true,
        status: 'running',
        title: t('content_translating_page'),
        subtitle: t('content_page_translate_progress', [sourceLabel, targetLabel, page.progress.done, page.progress.total]),
        showProgress: true,
        progressRatio: ratio(),
        actions: [{ id: 'cancel', label: t('content_stop_restore'), variant: 'ghost' }],
        showDismiss: true,
        note
      });
      return;
    }

    if (page.status === 'done') {
      const notes = [];
      if (page.cachedPretranslation) {
        const cachedCost = app.formatNovelCacheCost({ costUsd: page.estimatedCostUsd });
        notes.push(
          t('content_chapter_restored', [cachedCost ? t('content_cached_cost', [cachedCost]) : ''])
        );
      }
      if (page.polishError) notes.push(t('content_draft_kept_detail', [page.polishError]));
      if (pretranslation.active) notes.push(`${pretranslation.title} · ${pretranslation.detail}`);
      else if (page.pretranslationNote) notes.push(page.pretranslationNote);
      if (page.truncated) notes.push(t('content_page_truncated_done'));
      overlay.renderPanel({
        visible: true,
        status: 'done',
        title: page.bilingual ? t('content_page_bilingual_done', [targetLabel]) : t('content_page_translated_done', [targetLabel]),
        subtitle: t('content_page_done_summary', [sourceLabel, targetLabel, page.proofreadEnabled && !page.polishError ? t('content_proofread_suffix') : '', page.progress.total, costText ? ` · ${costText}` : '']),
        showProgress: pretranslation.active && pretranslation.showProgress,
        progressRatio: pretranslation.ratio,
        actions: finishedActions(),
        showDismiss: true,
        note: notes.join('\n')
      });
      return;
    }

    if (page.status === 'partial') {
      const notes = [];
      if (page.polishError) notes.push(t('content_draft_kept_detail', [page.polishError]));
      if (pretranslation.active) notes.push(`${pretranslation.title} · ${pretranslation.detail}`);
      else if (page.pretranslationNote) notes.push(page.pretranslationNote);
      if (page.truncated) notes.push(t('content_page_truncated_done'));
      const actions = finishedActions();
      if (!page.novelMode) actions.push({ id: 'retry', label: t('content_retry'), variant: 'ghost' });
      if (isSettingsError(page.errorCode)) actions.unshift({ id: 'settings', label: t('content_open_settings'), variant: 'ghost' });
      overlay.renderPanel({
        visible: true,
        status: 'partial',
        title: t('content_page_partial'),
        subtitle: `${page.error || t('content_segments_incomplete', [page.progress.failed])}${costText ? ` · ${costText}` : ''}`,
        showProgress: pretranslation.active && pretranslation.showProgress,
        progressRatio: pretranslation.ratio,
        actions,
        showDismiss: true,
        note: notes.join('\n')
      });
      return;
    }

    // error
    const actions = [];
    if (page.translatedNodes.size > 0) {
      actions.push({ id: 'restore', label: t('content_restore_page'), variant: 'ghost' });
    }
    actions.push({ id: 'retry', label: t('content_retry'), variant: 'primary' });
    if (isSettingsError(page.errorCode)) {
      actions.unshift({ id: 'settings', label: t('content_open_settings'), variant: 'ghost' });
    }
    overlay.renderPanel({
      visible: true,
      status: 'error',
      title: t('content_page_failed'),
      subtitle: page.error || t('content_try_later'),
      showProgress: false,
      progressRatio: ratio(),
      actions,
      showDismiss: true,
      note: ''
    });
  }

  /** Chapters reopen from cache, so this is the only way to apply a new glossary to one. */
  function finishedActions() {
    const actions = [{ id: 'restore', label: t('content_restore_page'), variant: 'primary' }];
    if (page.novelMode) actions.unshift({ id: 'retranslate', label: t('content_retranslate'), variant: 'ghost' });
    return actions;
  }

  function handlePanelAction(action) {
    if (action === 'cancel' || action === 'restore') {
      app.restorePage({ silent: false });
      return;
    }
    if (action === 'dismiss') {
      page.panelDismissed = true;
      overlay.hidePanel();
      return;
    }
    if (action === 'retry' || action === 'retranslate') {
      // Only novel chapters need force to skip their chapter cache; a page retry reuses
      // the tab memory so it resends just the segments that failed.
      const force = action === 'retranslate' || page.novelMode;
      // A run that failed before resolving its target falls back to the saved settings.
      const request = page.targetCode
        ? { targetCode: page.targetCode, bilingual: page.bilingual, force }
        : { force };
      app.startPageTranslation(request).catch((error) => {
        overlay.showToast(error.message || t('content_retry_failed'), 'error');
      });
      return;
    }
    if (action === 'settings') {
      app.openOptionsPage();
    }
  }

  return {
    buildPageInfo,
    errorPayload,
    respondError,
    isSettingsError,
    addPageCost,
    formatPageCost,
    ratio,
    renderPagePanel,
    handlePanelAction
  };
  };
})(globalThis);
