/** Page state polling and translation / restore commands. */
import { languages, POLL_INTERVAL_MS, PRETRANSLATE_POLL_MS, VISION_NOTICE_TEXT, ui, state } from './popup-state.mjs';
import { errorText, pageCommand } from './popup-transport.mjs';
import { render, computeMainAction } from './popup-view.mjs';

/* ---------- 页面状态归一化 ---------- */

function extractInfo(response) {
  if (!response || response.ok === false) return null;
  if (response.info && typeof response.info === 'object') return response.info;
  // 兼容 content script 把全部字段直接放在顶层的返回形态。
  if (typeof response.status === 'string' || response.pageTranslated !== undefined) return response;
  return null;
}

function normalizeInfo(raw) {
  const value = raw && typeof raw === 'object' ? raw : {};
  const knownStatus = { idle: 1, running: 1, done: 1, partial: 1, error: 1 };
  const status = Object.prototype.hasOwnProperty.call(knownStatus, value.status) ? value.status : 'idle';
  const progressRaw = value.progress && typeof value.progress === 'object' ? value.progress : {};
  const pretranslationRaw = value.pretranslationProgress || {};
  const progressCount = (count) => Number.isFinite(Number(count)) ? Math.max(0, Math.floor(Number(count))) : 0;
  const sourceRaw = value.source && typeof value.source === 'object' ? value.source : null;
  const targetLanguage = languages.getTargetLanguage(value.targetCode);
  const phase = typeof value.phase === 'string' ? value.phase : '';
  const rawCost =
    value.estimatedCostUsd !== undefined && value.estimatedCostUsd !== null
      ? value.estimatedCostUsd
      : value.costUsd;
  const costNumber = Number(rawCost);
  const estimatedCostUsd =
    rawCost === undefined || rawCost === null || !Number.isFinite(costNumber) || costNumber < 0
      ? null
      : costNumber;
  const costCurrency =
    typeof value.costCurrency === 'string' && value.costCurrency
      ? value.costCurrency
      : typeof value.currency === 'string' && value.currency
        ? value.currency
        : '';
  const novelRaw =
    value.novel && typeof value.novel === 'object'
      ? {
          siteId: typeof value.novel.siteId === 'string' ? value.novel.siteId : '',
          siteName: typeof value.novel.siteName === 'string' ? value.novel.siteName : '',
          workId: typeof value.novel.workId === 'string' ? value.novel.workId : '',
          chapterId: typeof value.novel.chapterId === 'string' ? value.novel.chapterId : '',
          isChapter: value.novel.isChapter === true
        }
      : null;

  return {
    status,
    phase,
    estimatedCostUsd,
    costCurrency,
    novel: novelRaw,
    pretranslateEnabled: value.pretranslateEnabled === true,
    pretranslationStatus:
      typeof value.pretranslationStatus === 'string' ? value.pretranslationStatus : '',
    pretranslationNote:
      typeof value.pretranslationNote === 'string' ? value.pretranslationNote.trim() : '',
    pretranslationScope: value.pretranslationScope === 'current' ? 'current' : 'next',
    pretranslationProgress: {
      stage: typeof pretranslationRaw.stage === 'string' ? pretranslationRaw.stage : '',
      done: progressCount(pretranslationRaw.done),
      total: progressCount(pretranslationRaw.total)
    },
    cachedPretranslation: value.cachedPretranslation === true,
    polishError:
      typeof value.polishError === 'string' && value.polishError.trim()
        ? value.polishError.trim()
        : null,
    proofreadEnabled: value.proofreadEnabled === true,
    pageTranslated: value.pageTranslated === true,
    targetCode: targetLanguage ? targetLanguage.code : null,
    targetLabel: targetLanguage
      ? targetLanguage.label
      : typeof value.targetLabel === 'string' && value.targetLabel
        ? value.targetLabel
        : null,
    bilingual: value.bilingual === true,
    source: sourceRaw
      ? {
          code: typeof sourceRaw.code === 'string' ? sourceRaw.code : 'unknown',
          label:
            typeof sourceRaw.label === 'string' && sourceRaw.label
              ? sourceRaw.label
              : languages.getLanguageLabel(sourceRaw.code),
          confidence: Number.isFinite(Number(sourceRaw.confidence)) ? Number(sourceRaw.confidence) : 0,
          mixed: sourceRaw.mixed === true
        }
      : null,
    progress: {
      done: Math.max(0, Math.floor(Number(progressRaw.done) || 0)),
      total: Math.max(0, Math.floor(Number(progressRaw.total) || 0)),
      failed: Math.max(0, Math.floor(Number(progressRaw.failed) || 0))
    },
    truncated: value.truncated === true,
    error: typeof value.error === 'string' && value.error.trim() ? value.error.trim() : null,
    imagePanelOpen: value.imagePanelOpen === true
  };
}

function syncControlsToApplied(info) {
  if (!info.pageTranslated) return;
  if (info.targetCode) {
    state.settings.targetCode = info.targetCode;
    ui.targetSelect.value = info.targetCode;
  }
  state.settings.bilingual = info.bilingual;
  ui.bilingualToggle.checked = info.bilingual;
}

function applyStateResponse(response) {
  const raw = extractInfo(response);
  if (!raw) {
    if (!state.info) {
      state.pageMessage = { tone: 'warning', message: '暂时无法读取页面状态，请刷新页面后重试。' };
    }
    render();
    return;
  }
  const info = normalizeInfo(raw);
  const prev = state.info;
  // A new failure must not stay hidden behind an older info/warning notice.
  if (state.pageMessage && state.pageMessage.tone !== 'error' &&
      ((info.status === 'error' && prev?.status !== 'error') ||
       (info.polishError && !prev?.polishError))) {
    state.pageMessage = null;
  }
  state.info = info;
  state.pageError = null;
  if (!state.stateLoaded) {
    state.stateLoaded = true;
    syncControlsToApplied(info);
  }
  render();
}

/* ---------- 状态刷新与轮询 ---------- */

function stopPolling() {
  if (state.pollTimer) {
    window.clearTimeout(state.pollTimer);
    state.pollTimer = 0;
  }
}

function schedulePoll(intervalMs) {
  stopPolling();
  state.pollTimer = window.setTimeout(() => {
    void refreshState();
  }, intervalMs || POLL_INTERVAL_MS);
}

async function refreshState() {
  if (!state.tabId) return;
  const response = await pageCommand('getState');
  if (response.ok === false) {
    const error = response.error || {};
    if (error.code === 'MISSING_API_KEY') {
      state.hasApiKey = false;
    } else {
      state.info = null;
      state.pageError = { code: error.code || 'UNKNOWN_ERROR', message: errorText(error) };
    }
    stopPolling();
    render();
    return;
  }
  applyStateResponse(response);
  const pageRunning = Boolean(state.info && state.info.status === 'running');
  const pretranslateRunning = Boolean(
    state.info && state.info.pretranslationStatus === 'running'
  );
  if (pageRunning || pretranslateRunning) {
    schedulePoll(pageRunning ? POLL_INTERVAL_MS : PRETRANSLATE_POLL_MS);
  } else {
    stopPolling();
  }
}

/* ---------- 页面操作 ---------- */

function setBusy(busy) {
  state.busy = Boolean(busy);
  if (state.busy) ui.mainButton.setAttribute('aria-busy', 'true');
  else ui.mainButton.removeAttribute('aria-busy');
}

async function startPageTranslation() {
  if (!state.hasApiKey || state.busy) return;
  setBusy(true);
  state.pageMessage = null;
  if (state.info) {
    // 重新翻译时清空旧进度，避免状态区短暂残留上一次的计数。
    state.info = Object.assign({}, state.info, {
      status: 'running',
      phase: '',
      pretranslationStatus: '',
      pretranslationScope: 'next',
      pretranslationProgress: { stage: '', done: 0, total: 0 },
      progress: { done: 0, total: 0, failed: 0 }
    });
  }
  render();

  const response = await pageCommand('translate', {
    targetCode: state.settings.targetCode,
    bilingual: state.settings.bilingual
  });
  setBusy(false);

  if (response.ok === false) {
    const error = response.error || {};
    if (error.code === 'MISSING_API_KEY') state.hasApiKey = false;
    state.pageMessage = { tone: 'error', message: errorText(error) };
    if (state.info && state.info.status === 'running') {
      state.info = Object.assign({}, state.info, { status: 'idle' });
    }
    render();
    void refreshState();
    return;
  }

  if (response.started === false) {
    if (response.reason === 'running') {
      state.pageMessage = { tone: 'info', message: '整页翻译已在进行中。' };
    } else if (response.reason === 'cancelled') {
      state.pageMessage = { tone: 'info', message: '翻译已取消。' };
    } else {
      state.pageMessage = { tone: 'warning', message: '页面中没有找到可翻译的文本。' };
    }
    if (state.info) state.info = Object.assign({}, state.info, { status: 'idle' });
    render();
    void refreshState();
    return;
  }

  state.pageMessage = null;
  render();
  schedulePoll();
}

async function restorePage() {
  if (state.busy) return;
  setBusy(true);
  state.pageMessage = null;
  render();

  const response = await pageCommand('restore');
  setBusy(false);

  if (response.ok === false) {
    const error = response.error || {};
    state.pageMessage = { tone: 'error', message: errorText(error) };
    render();
    return;
  }

  if (response.restored === false || response.hadTranslation === false) {
    state.pageMessage = { tone: 'info', message: '页面没有可还原的翻译内容。' };
    await refreshState();
    return;
  }

  state.pageMessage = null;
  state.info = {
    status: 'idle',
    phase: '',
    estimatedCostUsd: null,
    costCurrency: '',
    novel: state.info ? state.info.novel : null,
    pretranslateEnabled: false,
    pretranslationStatus: '',
    pretranslationNote: '',
    pretranslationScope: 'next',
    pretranslationProgress: { stage: '', done: 0, total: 0 },
    cachedPretranslation: false,
    polishError: null,
    proofreadEnabled: false,
    pageTranslated: false,
    targetCode: null,
    targetLabel: null,
    bilingual: false,
    source: state.info ? state.info.source : null,
    progress: { done: 0, total: 0, failed: 0 },
    truncated: false,
    error: null,
    imagePanelOpen: false
  };
  render();
  await refreshState();
}

async function runQuickCommand(kind) {
  if (state.busy || !state.hasApiKey) return;
  if (kind === 'images' && !state.supportsVision) {
    state.pageMessage = { tone: 'info', message: VISION_NOTICE_TEXT };
    render();
    return;
  }
  const modelKey = state.modelKey;
  setBusy(true);
  state.pageMessage = null;
  render();

  const response = await pageCommand(kind, { targetCode: state.settings.targetCode });
  setBusy(false);

  if (response.ok === false) {
    const error = response.error || {};
    if (error.code === 'MISSING_API_KEY') state.hasApiKey = false;
    if (kind === 'images' && error.code === 'VISION_UNSUPPORTED') {
      if (modelKey !== state.modelKey) { render(); return; }
      state.supportsVision = false;
      state.pageMessage = { tone: 'info', message: VISION_NOTICE_TEXT };
    } else state.pageMessage = { tone: 'error', message: errorText(error) };
    render();
    return;
  }

  if (response.started === false) {
    let message;
    if (kind === 'images' && response.reason === 'model-changed') {
      state.pageMessage = { tone: 'info', message: '模型已切换，请重新发起图片翻译。' };
      render();
      return;
    }
    if (kind === 'images' && response.reason === 'vision-unsupported') {
      if (modelKey !== state.modelKey) { render(); return; }
      state.supportsVision = false;
      state.pageMessage = { tone: 'info', message: VISION_NOTICE_TEXT };
      render();
      return;
    } else if (response.reason === 'running') {
      message =
        kind === 'selection' ? '划词翻译已在进行中，请稍候。' : '图片识别已在进行中，请稍候。';
    } else {
      message =
        kind === 'selection'
          ? '未检测到选中的文本，请先在页面上选择文字。'
          : '当前画面中没有找到可翻译的图片。';
    }
    state.pageMessage = { tone: 'warning', message };
    render();
    return;
  }

  render();
  // 划词与图片翻译的界面在页面内展示，关闭 popup 让用户直接看到结果。
  window.close();
}

async function handleMainAction() {
  const action = state.mainAction || computeMainAction();
  if (action.disabled) return;
  if (action.kind === 'restore' || action.kind === 'stop') {
    await restorePage();
    return;
  }
  if (action.kind === 'translate' || action.kind === 'retry' || action.kind === 'retranslate') {
    await startPageTranslation();
  }
}


export { normalizeInfo, stopPolling, refreshState, handleMainAction, runQuickCommand };
