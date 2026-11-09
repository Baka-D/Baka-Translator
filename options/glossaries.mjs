// Novel glossary editor for the advanced settings tab.
import { FEEDBACK_CLEAR_MS, novelUtils, state, ui } from './context.mjs';
import {
  GLOSSARY_PREFIX, describeGlossary, glossaryPageRange, normalizeGlossaryRows, withNewStoredTerms
} from './glossary-data.mjs';
import { readTermRow, renderTermRow, termRowKey } from './glossary-row.mjs';
import { renderTidyUndo, wireGlossaryTidy } from './glossary-tidy.mjs';
import { makeButton, setFeedback } from './utils.mjs';

const GLOSSARY_MIN_PAGE_SIZE = 30;
const CLEAR_CONFIRM_MS = 5000;
// The tidy the open draft started from: refreshing the list must not let a stale draft save.
let openedTidyAt = null;

export async function loadGlossaries() {
  if (!state.glossaries) state.glossaries = [];
  if (!chrome.storage || !chrome.storage.local) return state.glossaries;
  const all = await chrome.storage.local.get(null);
  state.glossaries = Object.keys(all || {})
    .filter((key) => key.startsWith(GLOSSARY_PREFIX))
    .map((key) => describeGlossary(key, all[key], all))
    .filter((entry) => entry && entry.terms.length > 0)
    .sort((left, right) =>
      `${left.siteName}\u0000${left.title}\u0000${left.targetLabel}`.localeCompare(
        `${right.siteName}\u0000${right.title}\u0000${right.targetLabel}`,
        'zh-CN'
      )
    );
  return state.glossaries;
}

function activeGlossary() {
  return (state.glossaries || []).find((entry) => entry.key === state.activeGlossaryKey) || null;
}

function resetClearButton() {
  state.glossaryClearArmed = false;
  if (state.glossaryClearTimer) {
    window.clearTimeout(state.glossaryClearTimer);
    state.glossaryClearTimer = 0;
  }
  if (ui.glossaryClearButton) {
    ui.glossaryClearButton.textContent = '清空术语库';
    ui.glossaryClearButton.classList.remove('is-confirming');
    ui.glossaryClearButton.removeAttribute('aria-label');
  }
}

function renderGlossaryList() {
  if (!ui.glossaryList) return;
  ui.glossaryList.replaceChildren();
  if (ui.glossaryEmptyHint) {
    ui.glossaryEmptyHint.hidden = (state.glossaries || []).length > 0;
  }
  const active = activeGlossary();
  if (state.activeGlossaryKey && !active) closeGlossaryEditor();

  for (const entry of state.glossaries || []) {
    const row = document.createElement('div');
    row.className = 'glossary-row';

    const info = document.createElement('div');
    info.className = 'glossary-info';
    const title = document.createElement('strong');
    title.className = 'glossary-title';
    title.textContent = entry.title;
    const meta = document.createElement('span');
    meta.className = 'glossary-meta';
    meta.textContent = `${entry.siteName} · ${entry.targetLabel} · ${entry.terms.length} 条术语`;
    info.append(title, meta);

    const actions = document.createElement('div');
    actions.className = 'glossary-actions';
    // The list's click handler opens it, after asking about unsaved edits.
    const edit = makeButton('编辑', 'button button-secondary button-compact', null, `编辑 ${entry.title} 的术语库`);
    edit.dataset.glossaryEdit = entry.key;
    actions.append(edit);

    row.append(info, actions);
    ui.glossaryList.append(row);
  }
}

function deleteGlossaryRow(index) {
  syncGlossaryDraft();
  state.glossaryDraft.splice(index, 1);
  state.glossarySaved.splice(index, 1);
  if (state.glossaryDraft.length === 0) {
    state.glossaryDraft.push({});
    state.glossarySaved.push(null);
  }
  showGlossaryPage(state.glossaryPage);
  // Rows were rebuilt: keep the keyboard where the deleted row was.
  focusRowControl(Math.min(index, state.glossaryDraft.length - 1), 'delete');
}

/** Put one row back to its saved term; a row added since opening goes away. */
function revertGlossaryRow(index) {
  syncGlossaryDraft();
  const saved = state.glossarySaved[index];
  if (saved) {
    state.glossaryDraft[index] = { ...saved };
    showGlossaryPage(state.glossaryPage);
    focusRowControl(index, 'delete');
  } else {
    deleteGlossaryRow(index);
  }
}

function focusRowControl(index, role) {
  const control = ui.glossaryRows.querySelector(`[data-glossary-row="${index}"] [data-role="${role}"]`);
  if (control) control.focus();
}

const ROW_HANDLERS = {
  onSave: (index) => { void saveGlossary(index); },
  onCancel: revertGlossaryRow,
  onDelete: deleteGlossaryRow
};

function renderGlossaryEditor() {
  const entry = activeGlossary();
  if (!entry || !ui.glossaryEditor) return;
  resetClearButton();
  ui.glossaryEditor.hidden = false;
  ui.glossaryEditorTitle.textContent = `${entry.title} · ${entry.siteName} · ${entry.targetLabel}`;
  if (ui.glossaryTitleInput) ui.glossaryTitleInput.value = entry.title;
  syncTitleButtons();
  state.glossaryOpened = entry.terms;
  openedTidyAt = entry.tidy?.tidiedAt ?? null;
  state.glossaryDraft = entry.terms.length > 0 ? entry.terms.map((term) => ({ ...term })) : [{}];
  // Kept index-aligned with the draft so each row knows whether it was edited.
  state.glossarySaved = entry.terms.length > 0 ? entry.terms.slice() : [null];
  renderTidyUndo(entry);
  showGlossaryPage(state.glossaryPage);
}

function syncTitleButtons() {
  const entry = activeGlossary();
  const changed = Boolean(entry) && ui.glossaryTitleInput.value.trim() !== entry.title;
  ui.glossaryTitleSaveButton.hidden = !changed;
  ui.glossaryTitleCancelButton.hidden = !changed;
}

function revertTitle() {
  const entry = activeGlossary();
  if (entry) ui.glossaryTitleInput.value = entry.title;
  syncTitleButtons();
  ui.glossaryTitleInput.focus();
}

async function saveTitle() {
  // A failed save has already moved the keyboard to the row that needs fixing.
  if (await saveGlossary()) ui.glossaryTitleInput.focus();
}

function wireTitleField() {
  if (!ui.glossaryTitleInput) return;
  ui.glossaryTitleInput.addEventListener('input', syncTitleButtons);
  ui.glossaryTitleInput.addEventListener('keydown', (event) => {
    if (ui.glossaryTitleSaveButton.hidden) return;
    if (event.key === 'Enter') void saveTitle();
    else if (event.key === 'Escape') revertTitle();
  });
  ui.glossaryTitleSaveButton.addEventListener('click', () => { void saveTitle(); });
  ui.glossaryTitleCancelButton.addEventListener('click', revertTitle);
}

/** Render one page of the draft; edits on other pages live in the draft until saved. */
function showGlossaryPage(requested) {
  const draft = state.glossaryDraft;
  const { page, pages, start, end } = glossaryPageRange(
    draft.length, requested, state.glossaryPageSize
  );
  state.glossaryPage = page;
  ui.glossaryRows.replaceChildren(
    ...draft.slice(start, end).map((term, offset) =>
      renderTermRow(term, start + offset, state.glossarySaved[start + offset] || null, ROW_HANDLERS))
  );
  if (!ui.glossaryPager) return;
  ui.glossaryPager.hidden = draft.length <= GLOSSARY_MIN_PAGE_SIZE;
  ui.glossaryPageInput.value = String(page + 1);
  ui.glossaryPageInput.max = String(pages);
  ui.glossaryPageTotal.textContent = `/ ${pages} 页 · 共 ${draft.length} 条`;
  ui.glossaryPrevButton.disabled = page === 0;
  ui.glossaryNextButton.disabled = page === pages - 1;
}

function changeGlossaryPage(page) {
  syncGlossaryDraft();
  showGlossaryPage(page);
  ui.glossaryRows.scrollIntoView({ block: 'start' });
}

function stepGlossaryPage(delta, button) {
  changeGlossaryPage(state.glossaryPage + delta);
  // A button disabled at the first or last page would drop the keyboard focus.
  if (button.disabled) ui.glossaryPageInput.focus();
}

function focusGlossaryRow(index) {
  showGlossaryPage(Math.floor(index / state.glossaryPageSize));
  const row = ui.glossaryRows.querySelector(`[data-glossary-row="${index}"]`);
  const source = row && row.querySelector('[data-role="source"]');
  if (source) source.focus();
  return row;
}

/** The save feedback sits below the list, so say what is wrong beside the row itself. */
function showGlossaryRowError({ error, row, other }) {
  const target = focusGlossaryRow(row);
  if (!target) return;
  const alert = document.createElement('p');
  alert.className = 'feedback glossary-row-error';
  alert.dataset.tone = 'error';
  alert.setAttribute('role', 'alert');
  alert.textContent = error;
  if (Number.isInteger(other)) {
    alert.append(' ', makeButton(`跳到第 ${other + 1} 行`, 'button button-secondary button-compact', () => {
      syncGlossaryDraft();
      focusGlossaryRow(other);
    }));
  }
  target.before(alert);
  alert.scrollIntoView({ block: 'center' });
}

function openGlossaryEditor(key) {
  state.activeGlossaryKey = key;
  state.glossaryPage = 0;
  renderGlossaryList();
  setFeedback(ui.glossaryFeedback, '', '');
  renderGlossaryEditor();
  if (ui.glossaryEditor && typeof ui.glossaryEditor.scrollIntoView === 'function') {
    ui.glossaryEditor.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }
}

function closeGlossaryEditor() {
  state.activeGlossaryKey = '';
  state.glossaryDraft = [];
  state.glossarySaved = [];
  resetClearButton();
  if (ui.glossaryEditor) ui.glossaryEditor.hidden = true;
  if (ui.glossaryRows) ui.glossaryRows.replaceChildren();
  if (ui.glossaryFeedback) setFeedback(ui.glossaryFeedback, '', '');
}

/** Copy the rows on screen back into the draft. */
function syncGlossaryDraft() {
  if (!ui.glossaryRows) return;
  for (const row of ui.glossaryRows.querySelectorAll('[data-glossary-row]')) {
    state.glossaryDraft[Number(row.dataset.glossaryRow)] = readTermRow(row);
  }
}

/** Edits not in storage yet: changed, added or deleted rows, or a new work title. */
function hasUnsavedGlossaryEdits() {
  const entry = activeGlossary();
  if (!entry) return false;
  if (ui.glossaryTitleInput && ui.glossaryTitleInput.value.trim() !== entry.title) return true;
  syncGlossaryDraft();
  const blank = termRowKey(null);
  const draft = state.glossaryDraft.map(termRowKey).filter((key) => key !== blank);
  const opened = state.glossaryOpened.map(termRowKey);
  return draft.length !== opened.length || draft.some((key, index) => key !== opened[index]);
}

function confirmDiscardGlossaryEdits() {
  return !hasUnsavedGlossaryEdits() ||
    window.confirm('术语库有未保存的修改，继续操作会丢失这些修改。确定继续吗？');
}

function addGlossaryTermRow() {
  syncGlossaryDraft();
  state.glossaryDraft.push({});
  state.glossarySaved.push(null);
  focusGlossaryRow(state.glossaryDraft.length - 1);
}

/** A row's own save button should not fail silently while the feedback is off screen. */
function showSaveError(error, rowIndex) {
  if (Number.isInteger(rowIndex)) showGlossaryRowError({ error, row: rowIndex });
  setFeedback(ui.glossaryFeedback, error, 'error');
}

/** `rowIndex` is the row whose own save button was used; it keeps the keyboard there. Resolves true once saved. */
async function saveGlossary(rowIndex) {
  const entry = activeGlossary();
  if (!entry) return;
  resetClearButton();
  syncGlossaryDraft();
  const normalized = normalizeGlossaryRows(state.glossaryDraft);
  if (normalized.error) {
    if (Number.isInteger(normalized.row)) showGlossaryRowError(normalized);
    setFeedback(ui.glossaryFeedback, normalized.error, 'error');
    return;
  }
  const rawTitle = ui.glossaryTitleInput ? ui.glossaryTitleInput.value.trim() : entry.title;
  const title = (rawTitle || entry.title || entry.workId).slice(0, 200);
  try {
    // Re-read: chapter tabs may have added terms and chapter ids since the list loaded.
    const stored = await chrome.storage.local.get([entry.key, entry.metaKey, entry.tidyKey]);
    if ((stored[entry.tidyKey]?.tidiedAt ?? null) !== openedTidyAt) {
      // Refresh the cached entry so reopening picks up the tidy instead of hitting this again.
      await loadGlossaries();
      renderGlossaryList();
      showSaveError('术语库已被自动整理，当前修改基于整理前的内容；关闭并重新打开会丢弃这些修改。', rowIndex);
      return;
    }
    const terms = withNewStoredTerms(normalized.terms, stored && stored[entry.key], state.glossaryOpened);
    const meta = novelUtils.normalizeMeta(stored && stored[entry.metaKey]) || {
      siteId: entry.siteId,
      workId: entry.workId,
      title: '',
      titleManual: false,
      chapterIds: [],
      extractedChapterIds: []
    };
    meta.title = title;
    meta.titleManual = true;
    await chrome.storage.local.set({
      [entry.key]: terms,
      [entry.metaKey]: meta
    });
    setFeedback(ui.glossaryFeedback, `已保存 ${terms.length} 条术语和作品名称，对之后发起的翻译生效。`, 'success', FEEDBACK_CLEAR_MS);
    await loadGlossaries();
    renderGlossaryList();
    renderGlossaryEditor();
    if (Number.isInteger(rowIndex)) focusRowControl(rowIndex, 'delete');
    return true;
  } catch (_error) {
    showSaveError('保存术语库失败，请检查扩展存储空间。', rowIndex);
  }
}

async function clearGlossary() {
  const entry = activeGlossary();
  if (!entry) return;
  if (!state.glossaryClearArmed) {
    state.glossaryClearArmed = true;
    ui.glossaryClearButton.textContent = '确认清空？';
    ui.glossaryClearButton.classList.add('is-confirming');
    ui.glossaryClearButton.setAttribute('aria-label', '再次点击以确认清空该作品的术语库');
    state.glossaryClearTimer = window.setTimeout(resetClearButton, CLEAR_CONFIRM_MS);
    return;
  }
  resetClearButton();
  try {
    await chrome.storage.local.remove([entry.key, entry.tidyKey]);
    await loadGlossaries();
    closeGlossaryEditor();
    renderGlossaryList();
    setFeedback(ui.glossaryFeedback, '术语库已清空。', 'success', FEEDBACK_CLEAR_MS);
  } catch (_error) {
    setFeedback(ui.glossaryFeedback, '清空术语库失败，请重试。', 'error');
  }
}

async function reloadGlossaryEditor() {
  await loadGlossaries();
  renderGlossaryList();
  renderGlossaryEditor();
}

export function wireGlossaryEvents() {
  if (!ui.glossaryList) return;
  wireGlossaryTidy(activeGlossary, reloadGlossaryEditor);
  wireTitleField();
  window.addEventListener('beforeunload', (event) => {
    if (hasUnsavedGlossaryEdits()) event.preventDefault();
  });
  ui.glossaryList.addEventListener('click', (event) => {
    const button = event.target && event.target.closest
      ? event.target.closest('[data-glossary-edit]')
      : null;
    if (button && button.dataset.glossaryEdit && confirmDiscardGlossaryEdits()) {
      openGlossaryEditor(button.dataset.glossaryEdit);
    }
  });
  if (ui.glossaryAddButton) {
    ui.glossaryAddButton.addEventListener('click', () => addGlossaryTermRow());
  }
  if (ui.glossarySaveButton) {
    ui.glossarySaveButton.addEventListener('click', () => { void saveGlossary(); });
  }
  if (ui.glossaryClearButton) {
    ui.glossaryClearButton.addEventListener('click', () => { void clearGlossary(); });
  }
  if (ui.glossaryCloseButton) {
    ui.glossaryCloseButton.addEventListener('click', () => {
      if (confirmDiscardGlossaryEdits()) closeGlossaryEditor();
    });
  }
  if (ui.glossaryPager) {
    ui.glossaryPrevButton.addEventListener('click', () => stepGlossaryPage(-1, ui.glossaryPrevButton));
    ui.glossaryNextButton.addEventListener('click', () => stepGlossaryPage(1, ui.glossaryNextButton));
    ui.glossaryPageInput.addEventListener('change', () => {
      const wanted = Math.trunc(Number(ui.glossaryPageInput.value));
      changeGlossaryPage(wanted >= 1 ? wanted - 1 : state.glossaryPage);
    });
    ui.glossaryPageSize.addEventListener('change', () => {
      // Stay on the rows being read rather than on the same page number.
      const firstRow = state.glossaryPage * state.glossaryPageSize;
      state.glossaryPageSize = Number(ui.glossaryPageSize.value);
      changeGlossaryPage(Math.floor(firstRow / state.glossaryPageSize));
    });
  }
  if (ui.glossaryRefreshButton) {
    ui.glossaryRefreshButton.addEventListener('click', () => {
      void (async () => {
        try {
          await loadGlossaries();
          renderGlossaryList();
          setFeedback(ui.glossaryFeedback, '术语库列表已刷新。', 'success', FEEDBACK_CLEAR_MS);
        } catch (_error) {
          setFeedback(ui.glossaryFeedback, '读取术语库失败，请重试。', 'error');
        }
      })();
    });
  }
}

export async function initGlossaries() {
  renderGlossaryList();
  try {
    await loadGlossaries();
  } catch (_error) {
    setFeedback(ui.glossaryFeedback, '读取术语库失败，请重试。', 'error');
    state.glossaries = [];
  }
  renderGlossaryList();
}

export { renderGlossaryList };
export {
  describeGlossary, glossaryPageRange, normalizeGlossaryRows, parseGlossaryKey, withNewStoredTerms
} from './glossary-data.mjs';
