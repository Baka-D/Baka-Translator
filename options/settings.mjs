// Settings-page settings.
import { t, i18n, CONFIRM_RESET_MS, FEEDBACK_CLEAR_MS, KEYS, MSG, TARGETS, languages, state, ui } from './context.mjs';
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
  ui.resetUsageButton.textContent = t('opt_usage_reset');
  ui.resetUsageButton.setAttribute('aria-label', t('opt_usage_reset_aria'));
}

export function resetUsageErrorMessage(error) {
  const code = error && typeof error.code === 'string' ? error.code : 'UNKNOWN_ERROR';
  if (code === 'UNKNOWN_MESSAGE') return t('opt_usage_reset_unsupported');
  if (code === 'INVALID_SENDER') return t('opt_usage_reset_options_only');
  if (code === 'BACKGROUND_UNAVAILABLE') return t('opt_background_unavailable');
  const message = error && typeof error.message === 'string' ? error.message.trim() : '';
  return message || t('opt_usage_reset_failed');
}

export async function handleResetUsage() {
  resetResetUsageConfirm();
  state.usageBusy = true;
  if (ui.resetUsageButton) {
    ui.resetUsageButton.disabled = true;
    ui.resetUsageButton.setAttribute('aria-busy', 'true');
  }
  setFeedback(ui.usageFeedback, t('opt_usage_resetting'), 'muted');
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
  setFeedback(ui.usageFeedback, t('opt_usage_reset_done'), 'success', FEEDBACK_CLEAR_MS);
}

export function handleResetUsageClick() {
  if (state.usageBusy) return;
  if (state.confirmResetUsage) {
    void handleResetUsage();
    return;
  }
  state.confirmResetUsage = true;
  if (ui.resetUsageButton) {
    ui.resetUsageButton.textContent = t('opt_usage_reset_confirm');
    ui.resetUsageButton.classList.add('is-confirming');
    ui.resetUsageButton.setAttribute('aria-label', t('opt_usage_reset_confirm_aria'));
  }
  setFeedback(ui.usageFeedback, t('opt_usage_reset_warning'), 'warning');
  state.resetUsageTimer = window.setTimeout(() => {
    resetResetUsageConfirm();
    setFeedback(ui.usageFeedback, '');
  }, CONFIRM_RESET_MS);
}

/* ---------- 默认设置 ---------- */

export function populateTargetSelect() {
  const fragment = document.createDocumentFragment();
  for (const language of TARGETS) {
    const option = document.createElement('option');
    option.value = language.code;
    option.textContent = i18n.languageLabel(language.code, language.label);
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
        t('opt_default_target_saved', [i18n.languageLabel(code)]),
        'success',
        FEEDBACK_CLEAR_MS
      );
    },
    () => {
      setFeedback(ui.settingsFeedback, t('opt_target_save_failed'), 'error');
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
        bilingual ? t('opt_keep_original_on') : t('opt_keep_original_off'),
        'success',
        FEEDBACK_CLEAR_MS
      );
    },
    () => {
      setFeedback(ui.settingsFeedback, t('opt_keep_original_save_failed'), 'error');
    }
  );
}
