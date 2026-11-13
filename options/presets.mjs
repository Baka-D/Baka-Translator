// Settings-page presets.
import { t, i18n, FEEDBACK_CLEAR_MS, KEYS, config, presetsTools, state, ui } from './context.mjs';
import { renderSiteSettings } from './sites.mjs';
import { isObject, persist, setFeedback } from './utils.mjs';

const RESET_CONFIRM_MS = 5000;

// Prompt text last loaded into or saved from the editor, to spot unsaved typing.
let loadedPrompts = null;
let resetArmed = false;
let resetTimer = 0;

function rememberPrompts() {
  loadedPrompts = { translation: ui.translationPromptInput.value, polish: ui.polishPromptInput.value };
}

function promptsEdited() {
  return Boolean(loadedPrompts && ui.translationPromptInput) &&
    (ui.translationPromptInput.value !== loadedPrompts.translation ||
      ui.polishPromptInput.value !== loadedPrompts.polish);
}

/* ---------- 提示词预设 ---------- */

export function populatePresetSelect() {
  const select = ui.presetSelect;
  if (!select) return;
  select.textContent = '';
  if (!state.presetIndex || !Array.isArray(state.presetIndex.presets)) {
    const option = document.createElement('option');
    option.value = '';
    option.textContent = t('opt_preset_unavailable');
    select.appendChild(option);
    select.disabled = true;
    return;
  }
  select.disabled = false;
  for (const preset of state.presetIndex.presets) {
    const option = document.createElement('option');
    option.value = preset.id;
    option.textContent = i18n.presetName(preset.id, preset.name);
    select.appendChild(option);
  }
}

export async function loadPresetIndex() {
  const path = config.PRESET_INDEX_PATH || 'preset/index.json';
  try {
    const response = await fetch(chrome.runtime.getURL(path), { cache: 'no-store' });
    if (!response || !response.ok) throw new Error('PRESET_INDEX_FETCH_FAILED');
    const raw = await response.json();
    const index = presetsTools ? presetsTools.normalizePresetIndex(raw) : null;
    if (!index || !Array.isArray(index.presets) || index.presets.length === 0) {
      throw new Error('PRESET_INDEX_EMPTY');
    }
    state.presetIndex = index;
  } catch (_error) {
    state.presetIndex = presetsTools
      ? presetsTools.normalizePresetIndex({})
      : { defaultPresetId: 'general', presets: [] };
  }
  populatePresetSelect();
}

export function presetMeta(presetId) {
  if (presetsTools && typeof presetsTools.getPresetMeta === 'function') {
    return presetsTools.getPresetMeta(state.presetIndex, presetId);
  }
  if (!state.presetIndex || !Array.isArray(state.presetIndex.presets)) return null;
  return state.presetIndex.presets.find((preset) => preset.id === presetId) || null;
}

export function presetDisplayName(presetId) {
  const meta = presetMeta(presetId);
  return i18n.presetName(presetId, meta?.name || presetId);
}

export async function ensurePreset(presetId) {
  if (state.presetCache.has(presetId)) return state.presetCache.get(presetId);
  const meta = presetMeta(presetId) || { id: presetId, name: presetId, file: 'general.json' };
  const token = ++state.presetLoadToken;
  let preset = null;
  try {
    const response = await fetch(chrome.runtime.getURL(`preset/${meta.file}`), { cache: 'no-store' });
    if (!response || !response.ok) throw new Error('PRESET_FETCH_FAILED');
    const raw = await response.json();
    preset = presetsTools
      ? presetsTools.normalizePreset(raw, presetId)
      : { id: presetId, name: meta.name, description: '', translationPrompt: '', polishPrompt: '' };
  } catch (_error) {
    preset = presetsTools
      ? presetsTools.normalizePreset({ id: presetId, name: meta.name }, presetId)
      : { id: presetId, name: meta.name, description: '', translationPrompt: '', polishPrompt: '' };
  }
  if (token !== state.presetLoadToken) return preset;
  state.presetCache.set(presetId, preset);
  return preset;
}

export function renderPromptPlaceholders() {
  if (!ui.promptPlaceholders) return;
  const placeholders =
    presetsTools && Array.isArray(presetsTools.PLACEHOLDERS)
      ? presetsTools.PLACEHOLDERS
      : ['targetLanguage', 'targetNative', 'sourceHint'];
  ui.promptPlaceholders.textContent = t('opt_prompt_placeholders', [placeholders.map((name) => `{{${name}}}`).join(t('opt_list_separator'))]);
}

export async function loadPromptEditor() {
  const presetId = state.presetId;
  const preset = await ensurePreset(presetId);
  if (!preset || !ui.translationPromptInput) return;
  if (state.presetId !== presetId) return;
  const overridesRaw = isObject(state.promptOverrides) ? state.promptOverrides[presetId] : null;
  const overrides = isObject(overridesRaw) ? overridesRaw : {};
  const merged =
    presetsTools && typeof presetsTools.mergePromptOverrides === 'function'
      ? presetsTools.mergePromptOverrides(preset, overrides)
      : Object.assign({}, preset, overrides);
  ui.translationPromptInput.value = merged.translationPrompt || '';
  ui.polishPromptInput.value = merged.polishPrompt || '';
  rememberPrompts();
  disarmReset();
  if (ui.presetDescription) {
    ui.presetDescription.textContent = i18n.presetDescription(presetId, preset.description || preset.name || '');
  }
  const hasOverride = Boolean(overrides.translationPrompt || overrides.polishPrompt);
  if (ui.promptStatus) {
    ui.promptStatus.textContent = hasOverride
      ? t('opt_prompt_custom_active')
      : t('opt_prompt_default_active');
  }
  renderPromptPlaceholders();
}

export function handlePresetChange() {
  const value = ui.presetSelect.value;
  if (!value) return;
  if (promptsEdited() && !window.confirm(t('opt_prompt_discard_confirm'))) {
    ui.presetSelect.value = state.presetId;
    return;
  }
  state.presetId = value;
  persist({ [KEYS.PRESET_ID]: value }).then(
    () => {
      setFeedback(
        ui.behaviorFeedback,
        t('opt_preset_saved', [presetDisplayName(value)]),
        'success',
        FEEDBACK_CLEAR_MS
      );
    },
    () => {
      setFeedback(ui.behaviorFeedback, t('opt_preset_save_failed'), 'error');
    }
  );
  void loadPromptEditor();
  renderSiteSettings();
}

export async function handleSavePrompts() {
  if (!ui.translationPromptInput) return;
  const preset = await ensurePreset(state.presetId);
  const translationPrompt = ui.translationPromptInput.value.trim();
  const polishPrompt = ui.polishPromptInput.value.trim();
  if (!translationPrompt) {
    setFeedback(ui.promptFeedback, t('opt_translation_prompt_required'), 'error');
    return;
  }
  if (!polishPrompt) {
    setFeedback(ui.promptFeedback, t('opt_polish_prompt_required'), 'error');
    return;
  }
  if (!preset) {
    setFeedback(ui.promptFeedback, t('opt_prompt_preset_load_failed'), 'error');
    return;
  }
  const overrides = isObject(state.promptOverrides) ? Object.assign({}, state.promptOverrides) : {};
  const entry = {};
  if (translationPrompt !== preset.translationPrompt) entry.translationPrompt = translationPrompt;
  if (polishPrompt !== preset.polishPrompt) entry.polishPrompt = polishPrompt;
  if (Object.keys(entry).length > 0) overrides[state.presetId] = entry;
  else delete overrides[state.presetId];
  try {
    await persist({ [KEYS.PROMPT_OVERRIDES]: overrides });
    state.promptOverrides = overrides;
    rememberPrompts();
    if (ui.promptStatus) {
      ui.promptStatus.textContent =
        Object.keys(entry).length > 0
          ? t('opt_prompt_custom_active')
          : t('opt_prompt_default_active');
    }
    setFeedback(ui.promptFeedback, t('opt_prompts_saved'), 'success', FEEDBACK_CLEAR_MS);
  } catch (_error) {
    setFeedback(ui.promptFeedback, t('opt_prompts_save_failed'), 'error');
  }
}

function disarmReset() {
  resetArmed = false;
  window.clearTimeout(resetTimer);
  resetTimer = 0;
  if (!ui.resetPromptsButton) return;
  ui.resetPromptsButton.textContent = t('opt_restore_defaults');
  ui.resetPromptsButton.classList.remove('is-confirming');
  ui.resetPromptsButton.removeAttribute('aria-label');
}

export async function handleResetPrompts() {
  const custom = isObject(state.promptOverrides) && isObject(state.promptOverrides[state.presetId]);
  if ((custom || promptsEdited()) && !resetArmed) {
    resetArmed = true;
    ui.resetPromptsButton.textContent = t('opt_restore_defaults_confirm');
    ui.resetPromptsButton.classList.add('is-confirming');
    ui.resetPromptsButton.setAttribute('aria-label', t('opt_restore_defaults_aria'));
    resetTimer = window.setTimeout(disarmReset, RESET_CONFIRM_MS);
    return;
  }
  disarmReset();
  const preset = await ensurePreset(state.presetId);
  if (!preset) return;
  const overrides = isObject(state.promptOverrides) ? Object.assign({}, state.promptOverrides) : {};
  delete overrides[state.presetId];
  try {
    await persist({ [KEYS.PROMPT_OVERRIDES]: overrides });
    state.promptOverrides = overrides;
    if (ui.translationPromptInput) ui.translationPromptInput.value = preset.translationPrompt || '';
    if (ui.polishPromptInput) ui.polishPromptInput.value = preset.polishPrompt || '';
    if (ui.translationPromptInput) rememberPrompts();
    if (ui.promptStatus) ui.promptStatus.textContent = t('opt_prompt_default_active');
    setFeedback(ui.promptFeedback, t('opt_prompt_defaults_restored'), 'success', FEEDBACK_CLEAR_MS);
  } catch (_error) {
    setFeedback(ui.promptFeedback, t('opt_prompt_defaults_failed'), 'error');
  }
}
