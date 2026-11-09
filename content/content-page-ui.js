/** Page ui behavior for the content script. */
(function registerContentModule(globalScope) {
  'use strict';
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
      message: (error && error.message) || '发生未知错误，请重试。'
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
    const stages = { fetching: '读取章节', translating: '翻译', polishing: '润色', saving: '保存译文' };
    const total = Math.max(0, Number(progress.total) || 0);
    const done = Math.max(0, Math.min(total, Number(progress.done) || 0));
    return {
      active: page.pretranslationStatus === 'running',
      title: page.pretranslationScope === 'current' ? '正在接续本章预翻译' : '正在预翻译下一章',
      detail: `${stages[progress.stage] || '准备中'}${total > 0 ? ` ${done}/${total} 段` : '…'}`,
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

    const sourceLabel = (page.source && page.source.label) || '自动识别';
    const targetLabel = page.targetLabel || '目标语言';
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
          actions: [{ id: 'cancel', label: '停止并还原', variant: 'ghost' }],
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
          title: '正在后台润色…',
          subtitle: `${sourceLabel} → ${targetLabel} · 润色 ${polish.done}/${polish.total} 块${polish.failed ? ` · ${polish.failed} 块失败` : ''} · 已用 ${elapsed}s`,
          showProgress: polish.total > 0,
          progressRatio: polish.total > 0 ? Math.min(1, polish.done / polish.total) : 0,
          actions: [{ id: 'cancel', label: '停止并还原', variant: 'ghost' }],
          showDismiss: true,
          note: page.truncated
            ? '页面内容较多，正在处理可处理的前部分内容。'
            : '初译已可阅读；每块完成会自动替换。首块响应可能需要数十秒至数分钟（取决于润色模型和 effort）。'
        });
        return;
      }
      const note = page.truncated
        ? '页面内容较多，正在翻译可处理的前部分内容。'
        : '';
      overlay.renderPanel({
        visible: true,
        status: 'running',
        title: '正在翻译页面…',
        subtitle: `${sourceLabel} → ${targetLabel} · 已处理 ${page.progress.done}/${page.progress.total} 段`,
        showProgress: true,
        progressRatio: ratio(),
        actions: [{ id: 'cancel', label: '停止并还原', variant: 'ghost' }],
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
          `本章由翻译缓存直接恢复${cachedCost ? `（缓存费用 ${cachedCost}）` : ''}。`
        );
      }
      if (page.polishError) notes.push(`润色未完成，已保留初译：${page.polishError}`);
      if (pretranslation.active) notes.push(`${pretranslation.title} · ${pretranslation.detail}`);
      else if (page.pretranslationNote) notes.push(page.pretranslationNote);
      if (page.truncated) notes.push('页面较长，仅翻译了前一部分可见文本。');
      overlay.renderPanel({
        visible: true,
        status: 'done',
        title: page.bilingual ? `已双语翻译为${targetLabel}` : `已翻译为${targetLabel}`,
        subtitle: `${sourceLabel} → ${targetLabel}${page.proofreadEnabled && !page.polishError ? ' · 已润色' : ''} · ${page.progress.total} 个片段${costText ? ` · ${costText}` : ''}`,
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
      if (page.polishError) notes.push(`润色未完成，已保留初译：${page.polishError}`);
      if (pretranslation.active) notes.push(`${pretranslation.title} · ${pretranslation.detail}`);
      else if (page.pretranslationNote) notes.push(page.pretranslationNote);
      if (page.truncated) notes.push('页面较长，仅翻译了前一部分可见文本。');
      overlay.renderPanel({
        visible: true,
        status: 'partial',
        title: '页面翻译完成，但部分内容失败',
        subtitle: `${page.error || `${page.progress.failed} 个片段未完成`}${costText ? ` · ${costText}` : ''}`,
        showProgress: pretranslation.active && pretranslation.showProgress,
        progressRatio: pretranslation.ratio,
        actions: finishedActions(),
        showDismiss: true,
        note: notes.join('\n')
      });
      return;
    }

    // error
    const actions = [];
    if (page.translatedNodes.size > 0) {
      actions.push({ id: 'restore', label: '还原原文', variant: 'ghost' });
    }
    actions.push({ id: 'retry', label: '重试', variant: 'primary' });
    if (isSettingsError(page.errorCode)) {
      actions.unshift({ id: 'settings', label: '打开设置', variant: 'ghost' });
    }
    overlay.renderPanel({
      visible: true,
      status: 'error',
      title: '页面翻译失败',
      subtitle: page.error || '请稍后重试。',
      showProgress: false,
      progressRatio: ratio(),
      actions,
      showDismiss: true,
      note: ''
    });
  }

  /** Chapters reopen from cache, so this is the only way to apply a new glossary to one. */
  function finishedActions() {
    const actions = [{ id: 'restore', label: '还原原文', variant: 'primary' }];
    if (page.novelMode) actions.unshift({ id: 'retranslate', label: '重新翻译', variant: 'ghost' });
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
      // A run that failed before resolving its target falls back to the saved settings.
      const request = page.targetCode
        ? { targetCode: page.targetCode, bilingual: page.bilingual, force: true }
        : { force: true };
      app.startPageTranslation(request).catch((error) => {
        overlay.showToast(error.message || '重试失败，请稍后再试。', 'error');
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
