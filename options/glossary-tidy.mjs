// Automatic glossary tidying: its settings and undoing the last run.
import { FEEDBACK_CLEAR_MS, KEYS, config, novelUtils, ui } from './context.mjs';
import { persist, setFeedback } from './utils.mjs';

const UNDO_CONFIRM_MS = 5000;
let undoArmed = false;
let undoTimer = 0;

/** Only what the tidy touched goes back; every other entry stays as it is now. */
export function undoneTerms(tidy, stored) {
  const key = (term) => novelUtils.termKey(term.source);
  const touched = new Set(Array.isArray(tidy.touched) ? tidy.touched : []);
  const current = novelUtils.mergeGlossary(stored, []);
  const byKey = new Map(current.map((term) => [key(term), term]));
  const restored = novelUtils.mergeGlossary(tidy.terms, []).flatMap((term) => {
    if (touched.has(key(term))) return [term];
    return byKey.has(key(term)) ? [byKey.get(key(term))] : [];
  });
  const kept = new Set(restored.map(key));
  return restored.concat(current.filter((term) => !kept.has(key(term))));
}

function resetUndoButton() {
  undoArmed = false;
  window.clearTimeout(undoTimer);
  ui.glossaryUndoButton.textContent = '撤销这次整理';
  ui.glossaryUndoButton.classList.remove('is-confirming');
}

export function renderTidyUndo(entry) {
  if (!ui.glossaryUndoRow) return;
  resetUndoButton();
  const tidy = entry.tidy;
  ui.glossaryUndoRow.hidden = !(tidy && Array.isArray(tidy.terms));
  if (ui.glossaryUndoRow.hidden) return;
  const when = new Date(Number(tidy.tidiedAt) || 0).toLocaleString('zh-CN');
  ui.glossaryUndoText.textContent = `最近一次自动整理（${when}）：移除 ${tidy.dropped} 条，合并 ${tidy.merged} 组。`;
}

async function undoTidy(entry, reload) {
  try {
    const stored = await chrome.storage.local.get([entry.key, entry.tidyKey]);
    const tidy = stored[entry.tidyKey];
    if (!tidy || !Array.isArray(tidy.terms)) return;
    // Words earlier tidies dropped stay dropped; only this run is undone.
    await chrome.storage.local.set({
      [entry.key]: undoneTerms(tidy, stored[entry.key]),
      [entry.tidyKey]: { removed: Array.isArray(tidy.earlierRemoved) ? tidy.earlierRemoved : [] }
    });
    await reload();
    setFeedback(ui.glossaryFeedback, '已撤销这次整理。', 'success', FEEDBACK_CLEAR_MS);
  } catch (_error) {
    setFeedback(ui.glossaryFeedback, '撤销失败，请重试。', 'error');
  }
}

function saveTidySetting(values, message) {
  persist(values).then(
    () => setFeedback(ui.glossaryTidyFeedback, message, 'success', FEEDBACK_CLEAR_MS),
    () => setFeedback(ui.glossaryTidyFeedback, '保存设置失败，请重试。', 'error')
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
    setFeedback(ui.glossaryTidyFeedback, '读取设置失败，请刷新页面后重试。', 'error');
  });
  ui.glossaryTidyToggle.addEventListener('change', () => {
    const enabled = ui.glossaryTidyToggle.checked;
    saveTidySetting({ [KEYS.GLOSSARY_TIDY_ENABLED]: enabled }, enabled ? '自动整理已开启。' : '自动整理已关闭。');
  });
  ui.glossaryTidyChapters.addEventListener('change', () => {
    const wanted = Number(ui.glossaryTidyChapters.value);
    const chapters = config.glossaryTidyChapters(wanted);
    if (chapters !== wanted) {
      setFeedback(ui.glossaryTidyFeedback, `请填写 1 到 ${config.GLOSSARY_TIDY_MAX_CHAPTERS} 的整数，设置没有改动。`, 'warning');
      void loadTidySettings();
      return;
    }
    saveTidySetting({ [KEYS.GLOSSARY_TIDY_CHAPTERS]: chapters }, `每 ${chapters} 章整理一次。`);
  });
  ui.glossaryTidyModel.addEventListener('change', () => {
    const model = ui.glossaryTidyModel.value === 'polish' ? 'polish' : 'translation';
    saveTidySetting({ [KEYS.GLOSSARY_TIDY_MODEL]: model }, `整理改用${model === 'polish' ? '润色' : '翻译'}模型。`);
  });
  if (ui.glossaryUndoButton) {
    ui.glossaryUndoButton.addEventListener('click', () => {
      const entry = activeGlossary();
      if (!entry) return;
      if (undoArmed) {
        resetUndoButton();
        void undoTidy(entry, reload);
        return;
      }
      undoArmed = true;
      ui.glossaryUndoButton.textContent = '确认撤销？未保存的修改会丢失';
      ui.glossaryUndoButton.classList.add('is-confirming');
      undoTimer = window.setTimeout(resetUndoButton, UNDO_CONFIRM_MS);
    });
  }
}
