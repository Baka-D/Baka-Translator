// Novel glossary editor for the advanced settings tab.
import { FEEDBACK_CLEAR_MS, languages, novelUtils, state, ui } from './context.mjs';
import { readTermRow, renderTermRow } from './glossary-row.mjs';
import { renderTidyUndo, wireGlossaryTidy } from './glossary-tidy.mjs';
import { makeButton, setFeedback } from './utils.mjs';

const GLOSSARY_PREFIX = 'novelGlossary:';
const GLOSSARY_MIN_PAGE_SIZE = 30;
const META_PREFIX = 'novelMeta:';
const CLEAR_CONFIRM_MS = 5000;

function targetLabel(code) {
  const target = languages.getTargetLanguage(code);
  return target ? target.label : String(code || '中文');
}

function siteLabel(siteId) {
  const adapter = novelUtils && novelUtils.SITE_ADAPTERS
    ? novelUtils.SITE_ADAPTERS[siteId]
    : null;
  return adapter && adapter.name ? adapter.name : siteId;
}

/** Parse a storage key such as novelGlossary:kakuyomu:123:en. */
export function parseGlossaryKey(key) {
  if (typeof key !== 'string' || !key.startsWith(GLOSSARY_PREFIX)) return null;
  const parts = key.split(':');
  if (parts.length < 3 || !parts[1] || !parts[2]) return null;
  const siteId = parts[1];
  const workId = parts[2];
  const rawTarget = parts[3] || 'zh';
  const targetCode = languages.normalizeTarget(rawTarget);
  const suffix = targetCode === 'zh' ? '' : `:${targetCode}`;
  return {
    key,
    siteId,
    workId,
    targetCode,
    metaKey: `${META_PREFIX}${siteId}:${workId}${suffix}`,
    tidyKey: `novelGlossaryTidy:${siteId}:${workId}${suffix}`
  };
}

/** Which rows a page shows; an out-of-range page moves to the nearest one. */
export function glossaryPageRange(total, page, size) {
  const pages = Math.max(1, Math.ceil(total / size));
  const current = Math.min(Math.max(page, 0), pages - 1);
  return { page: current, pages, start: current * size, end: Math.min(total, (current + 1) * size) };
}

/** Normalize terms for editing without silently dropping duplicate sources. */
export function normalizeGlossaryRows(rows) {
  const terms = [];
  const seen = new Map();
  for (const [index, row] of (Array.isArray(rows) ? rows : []).entries()) {
    const source = String((row && row.source) || '').trim();
    const target = String((row && row.target) || '').trim();
    if (!source && !target) continue;
    if (!source || !target) {
      return { error: `第 ${index + 1} 行需要同时填写原文和译文。`, row: index };
    }
    const normalized = novelUtils.normalizeTerm({
      source,
      target,
      category: row.category,
      note: row.note,
      gender: row.gender,
      aliases: row.aliases
    });
    if (!normalized) {
      return { error: `第 ${index + 1} 行术语格式不正确，请检查原文和译文。`, row: index };
    }
    // An alias is matched like a source, so it must be unique among them too.
    for (const { source: spelling } of [normalized, ...(normalized.aliases || [])]) {
      const key = novelUtils.termKey(spelling);
      if (seen.has(key)) {
        return {
          error: `第 ${index + 1} 行“${spelling}”与第 ${seen.get(key)} 行重复。`,
          row: index,
          other: seen.get(key) - 1
        };
      }
      seen.set(key, index + 1);
    }
    terms.push(normalized);
  }
  if (terms.length === 0) return { error: '请至少保留一条术语，或使用“清空术语库”。' };
  return { terms };
}

/** Add terms stored since the draft opened; rows the user removed stay removed. */
// shortcut: only new sources are merged, so a note or gender added to a term already in the
// draft is overwritten, merge per field if that loss shows up.
export function withNewStoredTerms(edited, stored, opened) {
  const known = new Set([...opened, ...edited].map((term) => novelUtils.termKey(term.source)));
  const added = novelUtils.mergeGlossary(stored, []);
  return edited.concat(added.filter((term) => !known.has(novelUtils.termKey(term.source))));
}

export function describeGlossary(key, terms, allValues) {
  const parsed = parseGlossaryKey(key);
  if (!parsed) return null;
  const meta = novelUtils.normalizeMeta((allValues || {})[parsed.metaKey]);
  const normalizedTerms = novelUtils.mergeGlossary(terms, []);
  return {
    ...parsed,
    title: (meta && meta.title) || parsed.workId,
    siteName: siteLabel(parsed.siteId),
    targetLabel: targetLabel(parsed.targetCode),
    meta,
    tidy: (allValues || {})[parsed.tidyKey] || null,
    terms: normalizedTerms
  };
}

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
    const edit = makeButton('编辑', 'button button-secondary button-compact', () => {
      openGlossaryEditor(entry.key);
    }, `编辑 ${entry.title} 的术语库`);
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
  state.glossaryOpened = entry.terms;
  state.glossaryDraft = entry.terms.length > 0 ? entry.terms.map((term) => ({ ...term })) : [{}];
  // Kept index-aligned with the draft so each row knows whether it was edited.
  state.glossarySaved = entry.terms.length > 0 ? entry.terms.slice() : [null];
  renderTidyUndo(entry);
  showGlossaryPage(state.glossaryPage);
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

function addGlossaryTermRow() {
  syncGlossaryDraft();
  state.glossaryDraft.push({});
  state.glossarySaved.push(null);
  focusGlossaryRow(state.glossaryDraft.length - 1);
}

/** `rowIndex` is the row whose own save button was used; it keeps the keyboard there. */
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
    if (stored[entry.tidyKey]?.tidiedAt !== entry.tidy?.tidiedAt) {
      setFeedback(ui.glossaryFeedback, '术语库刚被自动整理过，请点“刷新列表”并重新打开后再修改。', 'error');
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
  } catch (_error) {
    setFeedback(ui.glossaryFeedback, '保存术语库失败，请检查扩展存储空间。', 'error');
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
  ui.glossaryList.addEventListener('click', (event) => {
    const button = event.target && event.target.closest
      ? event.target.closest('[data-glossary-edit]')
      : null;
    if (button && button.dataset.glossaryEdit) openGlossaryEditor(button.dataset.glossaryEdit);
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
    ui.glossaryCloseButton.addEventListener('click', () => closeGlossaryEditor());
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
