/** Render translation status and available actions. */
import { KEY_NOTICE_TEXT, VISION_NOTICE_TEXT, languages, ui, state, labelOf, renderUsage } from './popup-state.mjs';
import { renderSiteToggles, renderCost } from './popup-site.mjs';

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
    message = info.error || '翻译失败，请重试。';
    tone = 'error';
  } else if (info && info.polishError) {
    message = `润色未完成：${info.polishError}（页面已保留初译）`;
    tone = 'warning';
  } else if (info && info.pretranslationStatus === 'error' && info.pretranslationNote) {
    const detail = info.pretranslationNote.replace(/^预翻译(?:下一章|本章)?失败[：:]\s*/, '');
    message = `预翻译失败：${detail}`;
    tone = 'warning';
  } else if (info && info.cachedPretranslation) {
    message = '本章来自预翻译缓存，已自动应用译文。';
    tone = 'info';
  } else if (info && info.pretranslationStatus === 'ready' && info.pretranslationNote) {
    message = info.pretranslationNote;
    tone = 'info';
  } else if (info && info.truncated) {
    message = '页面内容超出单次翻译上限，仅翻译了前面一部分。';
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
  const stageLabels = { fetching: '读取章节', translating: '翻译', polishing: '润色', saving: '保存译文' };
  let tone = 'idle';
  let text = '正在读取页面状态…';

  if (state.loading && !info) {
    tone = 'running';
    text = '正在读取页面状态…';
  } else if (state.pageError) {
    tone = 'error';
    text = '无法在此页面使用';
  } else if (!info) {
    tone = 'warn';
    text = '页面状态未知';
  } else if (info.status === 'running') {
    tone = 'running';
    if (info.phase === 'polishing') {
      text = '正在润色…';
    } else {
      text = info.progress.total > 0 ? `正在翻译… ${info.progress.done}/${info.progress.total}` : '正在翻译…';
    }
  } else if (info.status === 'done') {
    tone = 'done';
    text = `已翻译为${labelOf(info.targetCode || state.settings.targetCode)}${info.bilingual ? '（双语）' : ''}${info.proofreadEnabled && !info.polishError ? ' · 已润色' : ''}`;
  } else if (info.status === 'partial') {
    tone = 'warn';
    const total = info.progress.total > 0 ? info.progress.total : info.progress.done;
    text = `部分完成：${info.progress.done}/${total}${info.progress.failed > 0 ? `，${info.progress.failed} 处失败` : ''}`;
  } else if (info.status === 'error') {
    tone = 'error';
    text = '翻译失败';
  } else {
    tone = 'idle';
    text = info.imagePanelOpen ? '图片翻译面板已打开' : '页面尚未翻译';
  }

  if (pretranslating) {
    tone = 'running';
    const prefix = info.pretranslationScope === 'current' ? '正在接续本章预翻译' : '正在预翻译下一章';
    const stage = stageLabels[pretranslationProgress.stage] || '准备中';
    const counts = pretranslationProgress.total > 0
      ? ` ${Math.min(pretranslationProgress.done, pretranslationProgress.total)}/${pretranslationProgress.total} 段`
      : '…';
    text = `${prefix} · ${stage}${counts}`;
  }

  ui.statusDot.dataset.tone = tone;
  if (ui.statusText.textContent !== text) ui.statusText.textContent = text;

  const detected =
    info && info.source && info.source.code && info.source.code !== 'unknown'
      ? info.source.label || languages.getLanguageLabel(info.source.code)
      : '未检测';
  ui.sourceLabel.textContent = info ? detected : '—';

  const activeTarget =
    info && info.pageTranslated
      ? info.targetLabel || labelOf(info.targetCode)
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
    const label = pretranslating ? stageLabels[pretranslationProgress.stage] || '预翻译' : '已翻译';
    ui.progressTrack.setAttribute('aria-valuetext', `${label} ${done}/${total} 段`);
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
  return targetDiff || info.bilingual !== state.settings.bilingual || state.siteDirty;
}

function computeMainAction() {
  if (state.busy) return { kind: 'busy', label: '处理中…', disabled: true };
  if (!state.tabId || state.pageError) {
    return { kind: 'none', label: '翻译此页面', disabled: true };
  }

  const info = state.info;
  if (info && info.status === 'running') {
    return { kind: 'stop', label: '停止并还原', disabled: false };
  }
  if (!state.hasApiKey && !(info && info.pageTranslated)) {
    return { kind: 'translate', label: '翻译此页面', disabled: true };
  }
  if (!info) {
    return {
      kind: 'translate',
      label: '翻译此页面',
      disabled: state.loading || state.initialFetch || !state.hasApiKey
    };
  }
  if (info.pageTranslated) {
    if (settingsDirty()) {
      return { kind: 'retranslate', label: '按新设置重新翻译', disabled: !state.hasApiKey };
    }
    return { kind: 'restore', label: '还原原始页面', disabled: false };
  }
  if (state.loading || state.initialFetch) {
    return { kind: 'translate', label: '翻译此页面', disabled: true };
  }
  if (info.status === 'error') {
    return { kind: 'retry', label: '重试', disabled: false };
  }
  return { kind: 'translate', label: '翻译此页面', disabled: false };
}

function renderMainButton() {
  const action = computeMainAction();
  state.mainAction = action;
  if (ui.mainButton.textContent !== action.label) ui.mainButton.textContent = action.label;
  ui.mainButton.disabled = action.disabled;
  ui.mainButton.dataset.action = action.kind;

  const pageUsable = Boolean(state.tabId) && !state.pageError;
  const running = Boolean(state.info && state.info.status === 'running');
  const locked = state.busy || state.loading || state.initialFetch;
  ui.selectionButton.disabled = !pageUsable || !state.hasApiKey || running || locked;
  ui.imagesButton.disabled = !pageUsable || !state.hasApiKey || !state.supportsVision || running || locked;
  const imageLabel = state.supportsVision ? '翻译画面图片' : VISION_NOTICE_TEXT;
  ui.imagesButton.setAttribute('aria-label', imageLabel);
  ui.imagesButton.setAttribute('title', imageLabel);
}

function renderControls() {
  ui.targetSelect.disabled = state.busy;
  ui.bilingualToggle.disabled = state.busy;
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
