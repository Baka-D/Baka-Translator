/** Render translation status and available actions. */
import { t, i18n, KEY_NOTICE_TEXT, VISION_NOTICE_TEXT, languages, ui, state, labelOf, renderUsage } from './popup-state.mjs';
import { siteFlagFor, sitePresetValueFor, renderSiteToggles, renderCost } from './popup-site.mjs';

/* ---------- 渲染 ---------- */

function renderKeyNotice() {
  const show = state.configLoaded && !state.hasApiKey;
  const notice = state.modelError || KEY_NOTICE_TEXT;
  if (show && ui.keyNoticeText.textContent !== notice) {
    ui.keyNoticeText.textContent = notice;
  }
  ui.keyNotice.hidden = !show;
}

function setNoticeTone(element, tone) {
  element.classList.remove('notice-info', 'notice-warning', 'notice-error');
  if (tone === 'error') element.classList.add('notice-error');
  else if (tone === 'warning') element.classList.add('notice-warning');
  else element.classList.add('notice-info');
}

function renderPageNotice() {
  const info = state.info;
  let message = '';
  let tone = 'info';

  if (state.pageError) {
    message = state.pageError.message;
    tone = 'error';
  } else if (state.pageMessage) {
    message = state.pageMessage.message;
    tone = state.pageMessage.tone || 'info';
  } else if (info && info.status === 'error') {
    message = info.error || t('pop_translate_failed');
    tone = 'error';
  } else if (info && info.polishError) {
    message = t('pop_polish_warning', [info.polishError]);
    tone = 'warning';
  } else if (info && info.pretranslationStatus === 'error' && info.pretranslationNote) {
    message = info.pretranslationNote;
    tone = 'warning';
  } else if (info && info.cachedPretranslation) {
    message = t('pop_cached');
    tone = 'info';
  } else if (info && info.pretranslationStatus === 'ready' && info.pretranslationNote) {
    message = info.pretranslationNote;
    tone = 'info';
  } else if (info && info.truncated) {
    message = t('pop_truncated');
    tone = 'info';
  }

  if (!message) {
    ui.pageNotice.hidden = true;
    return;
  }
  setNoticeTone(ui.pageNotice, tone);
  if (ui.pageNoticeText.textContent !== message) ui.pageNoticeText.textContent = message;
  ui.pageNotice.hidden = false;
}

function renderStatus() {
  const info = state.info;
  const pretranslating = Boolean(info && !state.pageError && info.pretranslationStatus === 'running' &&
    (info.status !== 'running' || info.phase === 'pretranslating'));
  const pretranslationProgress = info?.pretranslationProgress || {};
  const stageLabels = { fetching: t('pop_stage_fetch'), translating: t('pop_stage_translate'), polishing: t('pop_stage_polish'), saving: t('pop_stage_save') };
  let tone = 'idle';
  let text = t('pop_loading');
  // Counts stay out of the live region so screen readers are not re-announced on every poll.
  let count = '';

  if ((state.loading || state.initialFetch) && !info) {
    tone = 'running';
    text = t('pop_loading');
  } else if (state.pageError) {
    tone = 'error';
    text = t('pop_page_unavailable');
  } else if (!info) {
    tone = 'warn';
    text = t('pop_page_unknown');
  } else if (info.status === 'running') {
    tone = 'running';
    if (info.phase === 'polishing') {
      text = t('pop_polishing');
    } else {
      text = t('pop_translating');
      count = info.progress.total > 0 ? `${info.progress.done}/${info.progress.total}` : '';
    }
  } else if (info.status === 'done') {
    tone = 'done';
    text = t('pop_done', [labelOf(info.targetCode || state.settings.targetCode),
      info.bilingual ? t('pop_bilingual') : '', info.proofreadEnabled && !info.polishError ? t('pop_polished') : '']);
  } else if (info.status === 'partial') {
    tone = 'warn';
    const total = info.progress.total > 0 ? info.progress.total : info.progress.done;
    text = t('pop_partial', [info.progress.done, total,
      info.progress.failed > 0 ? t('pop_failed_count', [info.progress.failed]) : '']);
  } else if (info.status === 'error') {
    tone = 'error';
    text = t('pop_failed');
  } else {
    tone = 'idle';
    text = info.imagePanelOpen ? t('pop_image_open') : t('pop_idle');
  }

  if (pretranslating) {
    tone = 'running';
    const prefix = info.pretranslationScope === 'current' ? t('pop_resume') : t('pop_pretranslating');
    const stage = stageLabels[pretranslationProgress.stage] || t('pop_preparing');
    const hasCount = pretranslationProgress.total > 0;
    count = hasCount
      ? t('pop_segments', [Math.min(pretranslationProgress.done, pretranslationProgress.total), pretranslationProgress.total])
      : '';
    text = `${prefix} · ${stage}${hasCount ? '' : '…'}`;
  }

  ui.statusDot.dataset.tone = tone;
  if (ui.statusText.textContent !== text) ui.statusText.textContent = text;
  if (ui.statusCount.textContent !== count) ui.statusCount.textContent = count;

  const detected =
    info && info.source && info.source.code && info.source.code !== 'unknown'
      ? i18n.languageLabel(info.source.code)
      : t('pop_not_detected');
  ui.sourceLabel.textContent = info ? detected : '—';

  const activeTarget =
    info && info.pageTranslated
      ? labelOf(info.targetCode)
      : labelOf(state.settings.targetCode);
  ui.targetLabel.textContent = activeTarget;

  const running = Boolean(info && info.status === 'running');
  const progress = pretranslating ? pretranslationProgress : running ? info.progress : {};
  const total = progress.total || 0;
  const done = progress.done || 0;
  const hasProgress = (running || pretranslating) && total > 0;
  const percent = hasProgress ? Math.max(0, Math.min(100, Math.round((done / total) * 100))) : 0;

  ui.progressTrack.classList.toggle('is-active', hasProgress);
  ui.progressTrack.setAttribute('aria-hidden', hasProgress ? 'false' : 'true');
  ui.progressTrack.setAttribute('aria-valuenow', String(percent));
  if (hasProgress) {
    const label = pretranslating ? stageLabels[pretranslationProgress.stage] || t('pop_pretranslation') : t('pop_translated');
    ui.progressTrack.setAttribute('aria-valuetext', t('pop_progress', [label, done, total]));
    ui.progressFill.style.width = `${percent}%`;
  } else {
    ui.progressTrack.removeAttribute('aria-valuetext');
    ui.progressFill.style.width = '0%';
  }
}

function settingsDirty() {
  const info = state.info;
  if (!info || !info.pageTranslated) return false;
  const targetDiff = Boolean(info.targetCode) && info.targetCode !== state.settings.targetCode;
  const site = (flag) => siteFlagFor(state.siteSettings, state.host, flag);
  const presetDiff = Boolean(info.presetId) &&
    info.presetId !== (sitePresetValueFor(state.host) || state.globalPresetId);
  // Turning pretranslation off needs no new run; turning it on does, on chapter pages only.
  const pretranslateDiff = !info.pretranslateEnabled && site('pretranslate') && info.novel?.isChapter === true;
  return targetDiff || info.bilingual !== state.settings.bilingual ||
    info.proofreadEnabled !== site('polish') || presetDiff || pretranslateDiff;
}

function computeMainAction() {
  if (state.busy) return { kind: 'busy', label: t('pop_busy'), disabled: true };
  if (!state.tabId || state.pageError) {
    return { kind: 'none', label: t('pop_translate_page'), disabled: true };
  }

  const info = state.info;
  if (info && info.status === 'running') {
    return { kind: 'stop', label: t('pop_stop_restore'), disabled: false };
  }
  if (!state.hasApiKey && !(info && info.pageTranslated)) {
    return { kind: 'translate', label: t('pop_translate_page'), disabled: true };
  }
  if (!info) {
    return {
      kind: 'translate',
      label: t('pop_translate_page'),
      disabled: state.loading || state.initialFetch || !state.hasApiKey
    };
  }
  if (info.pageTranslated) {
    if (settingsDirty()) {
      return { kind: 'retranslate', label: t('pop_retranslate_settings'), disabled: !state.hasApiKey };
    }
    if (info.status === 'partial') {
      // Chapters keep no translation memory, so a retry there sends every segment again.
      const label = info.novel?.isChapter ? t('pop_retranslate_page') : t('pop_retry_failed');
      return { kind: 'retry', label, disabled: !state.hasApiKey };
    }
    return { kind: 'restore', label: t('pop_restore_page'), disabled: false };
  }
  if (state.loading || state.initialFetch) {
    return { kind: 'translate', label: t('pop_translate_page'), disabled: true };
  }
  if (info.status === 'error') {
    return { kind: 'retry', label: t('pop_retry'), disabled: false };
  }
  return { kind: 'translate', label: t('pop_translate_page'), disabled: false };
}

function renderMainButton() {
  const action = computeMainAction();
  state.mainAction = action;
  if (ui.mainButton.textContent !== action.label) ui.mainButton.textContent = action.label;
  ui.mainButton.disabled = action.disabled;
  ui.mainButton.dataset.action = action.kind;
  // Retry and retranslate take the main slot, so keep restore reachable beside them.
  ui.restoreButton.hidden = !(state.info?.pageTranslated && (action.kind === 'retry' || action.kind === 'retranslate'));

  const pageUsable = Boolean(state.tabId) && !state.pageError;
  const running = Boolean(state.info && state.info.status === 'running');
  const locked = state.busy || state.loading || state.initialFetch;
  ui.selectionButton.disabled = !pageUsable || !state.hasApiKey || running || locked;
  ui.imagesButton.disabled = !pageUsable || !state.hasApiKey || running || locked;
  // Stay focusable when vision is unsupported so a click can explain why.
  ui.imagesButton.setAttribute('aria-disabled', String(!state.supportsVision));
  const imageLabel = state.supportsVision ? t('pop_images') : VISION_NOTICE_TEXT;
  ui.imagesButton.setAttribute('aria-label', imageLabel);
  ui.imagesButton.setAttribute('title', imageLabel);
}

function renderControls() {
  // Initial config and page state both set these values before edits are safe.
  const locked = state.busy || state.loading || state.initialFetch;
  ui.targetSelect.disabled = locked;
  ui.bilingualToggle.disabled = locked;
}

function render() {
  renderUsage();
  renderSiteToggles();
  renderCost();
  renderKeyNotice();
  renderPageNotice();
  renderStatus();
  renderControls();
  renderMainButton();
}


export { render, computeMainAction, renderStatus };
