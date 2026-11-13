// Automatic glossary tidying: its settings and undoing the last run.
import { FEEDBACK_CLEAR_MS, KEYS, config, novelUtils, ui } from './context.mjs';
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
  ui.glossaryUndoButton.textContent = '撤销这次整理';
  ui.glossaryUndoButton.classList.remove('is-confirming');
}

export function renderTidyUndo(entry) {
  if (!ui.glossaryUndoRow) return;
  resetUndoButton();
  const tidy = entry.tidy;
  shownTidyAt = tidy?.tidiedAt ?? null;
  ui.glossaryUndoRow.hidden = !(tidy && Array.isArray(tidy.terms));
  if (ui.glossaryUndoRow.hidden) return;
  const when = new Date(Number(tidy.tidiedAt) || 0).toLocaleString('zh-CN');
  ui.glossaryUndoText.textContent = `最近一次自动整理（${when}）：移除 ${tidy.dropped} 条，合并 ${tidy.merged} 组。`;
}

async function undoTidy(entry, reload) {
  const finish = beginGlossaryOperation();
  if (!finish) return;
  setFeedback(ui.glossaryFeedback, '正在撤销这次整理…', '');
  try {
    const result = await editGlossary(entry, 'undo', { expectedTidyAt: shownTidyAt });
    await reload();
    setFeedback(ui.glossaryFeedback, result.undone ? '已撤销这次整理。' : '这次整理已撤销，无需重复操作。', 'success', FEEDBACK_CLEAR_MS);
  } catch (error) {
    setFeedback(ui.glossaryFeedback, error.code === 'GLOSSARY_CHANGED' ? error.message : '撤销失败，请重试。', 'error');
  } finally {
    finish();
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
      if (glossaryBusy()) return;
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
