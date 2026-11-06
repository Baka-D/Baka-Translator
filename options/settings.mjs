// Settings-page settings.
import { CONFIRM_RESET_MS, FEEDBACK_CLEAR_MS, KEYS, MSG, TARGETS, languages, state, ui } from './context.mjs';
import { formatCost, formatTokens, formatUpdatedAt, normalizeUsage, persist, sendMessage, setFeedback } from './utils.mjs';

/* ---------- 使用量统计 ---------- */

export function renderUsage() {
  if (!ui.usageTotal) return;
  const usage = state.usage;
  if (!usage) {
    ui.usageTotal.textContent = '—';
    if (ui.usageCost) ui.usageCost.textContent = '—';
    if (ui.usagePrompt) ui.usagePrompt.textContent = '—';
    if (ui.usageCompletion) ui.usageCompletion.textContent = '—';
    if (ui.usageCached) ui.usageCached.textContent = '—';
    if (ui.usageRequests) ui.usageRequests.textContent = '—';
    if (ui.usageUpdated) ui.usageUpdated.textContent = '—';
    if (ui.usageEmptyHint) ui.usageEmptyHint.hidden = true;
    return;
  }
  ui.usageTotal.textContent = formatTokens(usage.totalTokens);
  if (ui.usageCost) ui.usageCost.textContent = formatCost(usage.estimatedCostUsd);
  if (ui.usagePrompt) ui.usagePrompt.textContent = formatTokens(usage.promptTokens);
  if (ui.usageCompletion) ui.usageCompletion.textContent = formatTokens(usage.completionTokens);
  if (ui.usageCached) ui.usageCached.textContent = formatTokens(usage.cachedTokens);
  if (ui.usageRequests) ui.usageRequests.textContent = formatTokens(usage.requests);
  if (ui.usageUpdated) ui.usageUpdated.textContent = formatUpdatedAt(usage.updatedAt);
  const empty = usage.totalTokens === 0 && usage.requests === 0 && usage.updatedAt === 0;
  if (ui.usageEmptyHint) ui.usageEmptyHint.hidden = !empty;
}

export function resetResetUsageConfirm() {
  state.confirmResetUsage = false;
  if (state.resetUsageTimer) {
    window.clearTimeout(state.resetUsageTimer);
    state.resetUsageTimer = 0;
  }
  if (!ui.resetUsageButton) return;
  ui.resetUsageButton.classList.remove('is-confirming');
  ui.resetUsageButton.textContent = '清零使用量';
  ui.resetUsageButton.setAttribute('aria-label', '清零累计 Token 使用量');
}

export function resetUsageErrorMessage(error) {
  const code = error && typeof error.code === 'string' ? error.code : 'UNKNOWN_ERROR';
  if (code === 'UNKNOWN_MESSAGE') return '当前版本尚不支持清零，请重新加载扩展后重试。';
  if (code === 'INVALID_SENDER') return '请在扩展设置页面中执行清零操作。';
  if (code === 'BACKGROUND_UNAVAILABLE') return '扩展后台暂时不可用，请稍后重试。';
  const message = error && typeof error.message === 'string' ? error.message.trim() : '';
  return message || '清零失败，请重试。';
}

export async function handleResetUsage() {
  resetResetUsageConfirm();
  state.usageBusy = true;
  if (ui.resetUsageButton) {
    ui.resetUsageButton.disabled = true;
    ui.resetUsageButton.setAttribute('aria-busy', 'true');
  }
  setFeedback(ui.usageFeedback, '正在清零…', 'muted');
  const response = await sendMessage({ type: MSG.RESET_USAGE });
  state.usageBusy = false;
  if (ui.resetUsageButton) {
    ui.resetUsageButton.disabled = false;
    ui.resetUsageButton.removeAttribute('aria-busy');
  }
  if (!response || response.ok === false) {
    const error = response && response.error ? response.error : { code: 'UNKNOWN_ERROR' };
    setFeedback(ui.usageFeedback, resetUsageErrorMessage(error), 'error');
    return;
  }
  if (response.usage && typeof response.usage === 'object') {
    state.usage = normalizeUsage(response.usage);
    renderUsage();
  } else {
    try {
      const values = await chrome.storage.local.get([KEYS.USAGE]);
      state.usage = normalizeUsage(values[KEYS.USAGE]);
      renderUsage();
    } catch (_error) {
      // 保留当前显示。
    }
  }
  setFeedback(ui.usageFeedback, '累计使用量已清零。', 'success', FEEDBACK_CLEAR_MS);
}

export function handleResetUsageClick() {
  if (state.usageBusy) return;
  if (state.confirmResetUsage) {
    void handleResetUsage();
    return;
  }
  state.confirmResetUsage = true;
  if (ui.resetUsageButton) {
    ui.resetUsageButton.textContent = '确认清零？';
    ui.resetUsageButton.classList.add('is-confirming');
    ui.resetUsageButton.setAttribute('aria-label', '再次点击以确认清零累计 Token 使用量');
  }
  setFeedback(ui.usageFeedback, '再次点击“确认清零？”会将本机累计的使用量归零，此操作不可恢复。', 'warning');
  state.resetUsageTimer = window.setTimeout(resetResetUsageConfirm, CONFIRM_RESET_MS);
}

/* ---------- 默认设置 ---------- */

export function populateTargetSelect() {
  const fragment = document.createDocumentFragment();
  for (const language of TARGETS) {
    const option = document.createElement('option');
    option.value = language.code;
    option.textContent = language.label;
    fragment.appendChild(option);
  }
  ui.defaultTargetSelect.textContent = '';
  ui.defaultTargetSelect.appendChild(fragment);
}

export function renderDefaultSettings() {
  ui.defaultTargetSelect.value = state.targetLang;
  ui.defaultBilingualToggle.checked = state.bilingual;
}

export function handleTargetChange() {
  const code = languages.normalizeTarget(ui.defaultTargetSelect.value);
  ui.defaultTargetSelect.value = code;
  persist({ [KEYS.TARGET]: code }).then(
    () => {
      state.targetLang = code;
      setFeedback(
        ui.settingsFeedback,
        `默认目标语言已保存：${languages.getLanguageLabel(code)}。`,
        'success',
        FEEDBACK_CLEAR_MS
      );
    },
    () => {
      setFeedback(ui.settingsFeedback, '保存默认目标语言失败，请重试。', 'error');
    }
  );
}

export function handleBilingualChange() {
  const bilingual = ui.defaultBilingualToggle.checked === true;
  persist({ [KEYS.BILINGUAL]: bilingual }).then(
    () => {
      state.bilingual = bilingual;
      setFeedback(
        ui.settingsFeedback,
        bilingual ? '默认双语显示已开启。' : '默认双语显示已关闭。',
        'success',
        FEEDBACK_CLEAR_MS
      );
    },
    () => {
      setFeedback(ui.settingsFeedback, '保存双语设置失败，请重试。', 'error');
    }
  );
}
