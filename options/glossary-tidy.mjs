// Automatic glossary tidying: its settings and undoing the last run.
import { FEEDBACK_CLEAR_MS, KEYS, config, i18n, novelUtils, t, ui } from './context.mjs';
import { persist, setFeedback } from './utils.mjs';
import { beginGlossaryOperation, editGlossary, glossaryBusy } from './glossary-operation.mjs';

const UNDO_CONFIRM_MS = 5000;
let undoArmed = false;
let undoTimer = 0;
let shownTidyAt = null;

export const undoneTerms = novelUtils.undoneTerms;

function resetUndoButton() {
  undoArmed = false;
  window.clearTimeout(undoTimer);
  ui.glossaryUndoButton.textContent = t('opt_glossary_undo_tidy');
  ui.glossaryUndoButton.classList.remove('is-confirming');
}

export function renderTidyUndo(entry) {
  if (!ui.glossaryUndoRow) return;
  resetUndoButton();
  const tidy = entry.tidy;
  shownTidyAt = tidy?.tidiedAt ?? null;
  ui.glossaryUndoRow.hidden = !(tidy && Array.isArray(tidy.terms));
  if (ui.glossaryUndoRow.hidden) return;
  const when = new Date(Number(tidy.tidiedAt) || 0).toLocaleString(i18n.locale);
  ui.glossaryUndoText.textContent = t('opt_glossary_last_tidy', [when, tidy.dropped, tidy.merged]);
}

async function undoTidy(entry, reload) {
  const finish = beginGlossaryOperation();
  if (!finish) return;
  setFeedback(ui.glossaryFeedback, t('opt_glossary_undoing_tidy'), '');
  try {
    const result = await editGlossary(entry, 'undo', { expectedTidyAt: shownTidyAt });
    await reload();
    setFeedback(ui.glossaryFeedback, result.undone ? t('opt_glossary_tidy_undone') : t('opt_glossary_tidy_already_undone'), 'success', FEEDBACK_CLEAR_MS);
  } catch (error) {
    setFeedback(ui.glossaryFeedback, error.code === 'GLOSSARY_CHANGED' ? error.message : t('opt_glossary_undo_failed'), 'error');
  } finally {
    finish();
  }
}

function saveTidySetting(values, message) {
  persist(values).then(
    () => setFeedback(ui.glossaryTidyFeedback, message, 'success', FEEDBACK_CLEAR_MS),
    () => setFeedback(ui.glossaryTidyFeedback, t('opt_glossary_tidy_settings_save_failed'), 'error')
  );
}

async function loadTidySettings() {
  const values = await chrome.storage.local.get([
    KEYS.GLOSSARY_TIDY_ENABLED, KEYS.GLOSSARY_TIDY_CHAPTERS, KEYS.GLOSSARY_TIDY_MODEL
  ]);
  ui.glossaryTidyToggle.checked = values[KEYS.GLOSSARY_TIDY_ENABLED] === true;
  ui.glossaryTidyChapters.value = String(config.glossaryTidyChapters(values[KEYS.GLOSSARY_TIDY_CHAPTERS]));
  ui.glossaryTidyModel.value = values[KEYS.GLOSSARY_TIDY_MODEL] === 'polish' ? 'polish' : 'translation';
}

export function wireGlossaryTidy(activeGlossary, reload) {
  if (!ui.glossaryTidyToggle) return;
  void loadTidySettings().catch(() => {
    setFeedback(ui.glossaryTidyFeedback, t('opt_glossary_tidy_settings_load_failed'), 'error');
  });
  ui.glossaryTidyToggle.addEventListener('change', () => {
    const enabled = ui.glossaryTidyToggle.checked;
    saveTidySetting({ [KEYS.GLOSSARY_TIDY_ENABLED]: enabled }, enabled ? t('opt_glossary_tidy_enabled') : t('opt_glossary_tidy_disabled'));
  });
  ui.glossaryTidyChapters.addEventListener('change', () => {
    const wanted = Number(ui.glossaryTidyChapters.value);
    const chapters = config.glossaryTidyChapters(wanted);
    if (chapters !== wanted) {
      setFeedback(ui.glossaryTidyFeedback, t('opt_glossary_tidy_interval_invalid', [config.GLOSSARY_TIDY_MAX_CHAPTERS]), 'warning');
      void loadTidySettings();
      return;
    }
    saveTidySetting({ [KEYS.GLOSSARY_TIDY_CHAPTERS]: chapters }, t('opt_glossary_tidy_interval_saved', [chapters]));
  });
  ui.glossaryTidyModel.addEventListener('change', () => {
    const model = ui.glossaryTidyModel.value === 'polish' ? 'polish' : 'translation';
    saveTidySetting({ [KEYS.GLOSSARY_TIDY_MODEL]: model }, t('opt_glossary_tidy_model_saved', [model === 'polish' ? t('opt_glossary_model_polish') : t('opt_glossary_model_translation')]));
  });
  if (ui.glossaryUndoButton) {
    ui.glossaryUndoButton.addEventListener('click', () => {
      if (glossaryBusy()) return;
      const entry = activeGlossary();
      if (!entry) return;
      if (undoArmed) {
        resetUndoButton();
        void undoTidy(entry, reload);
        return;
      }
      undoArmed = true;
      ui.glossaryUndoButton.textContent = t('opt_glossary_undo_confirm');
      ui.glossaryUndoButton.classList.add('is-confirming');
      undoTimer = window.setTimeout(resetUndoButton, UNDO_CONFIRM_MS);
    });
  }
}
