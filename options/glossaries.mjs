// Novel glossary editor for the advanced settings tab.
import { FEEDBACK_CLEAR_MS, languages, novelUtils, state, ui } from './context.mjs';
import { setFeedback } from './utils.mjs';

const GLOSSARY_PREFIX = 'novelGlossary:';
const GLOSSARY_MIN_PAGE_SIZE = 30;
const META_PREFIX = 'novelMeta:';
const CLEAR_CONFIRM_MS = 5000;
const GENDER_OPTIONS = [['none', '无'], ['male', '男'], ['female', '女']];

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
    metaKey: `${META_PREFIX}${siteId}:${workId}${suffix}`
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
      gender: row.gender
    });
    if (!normalized) {
      return { error: `第 ${index + 1} 行术语格式不正确，请检查原文和译文。`, row: index };
    }
    const key = novelUtils.termKey(normalized.source);
    if (seen.has(key)) {
      return {
        error: `第 ${index + 1} 行“${normalized.source}”与第 ${seen.get(key)} 行重复。`,
        row: index,
        other: seen.get(key) - 1
      };
    }
    seen.set(key, index + 1);
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

function makeButton(label, className, onClick, ariaLabel) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = className;
  button.textContent = label;
  if (ariaLabel) button.setAttribute('aria-label', ariaLabel);
  button.addEventListener('click', onClick);
  return button;
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

function makeGenderSelect(term, index) {
  const select = document.createElement('select');
  select.className = 'select glossary-input';
  select.dataset.role = 'gender';
  select.setAttribute('aria-label', `第 ${index + 1} 条术语的角色性别`);
  // Unset differs from a chosen 无, which stops later chapters filling in a gender.
  const unset = new Option('性别', '');
  unset.hidden = true;
  select.add(unset);
  for (const [value, label] of GENDER_OPTIONS) select.add(new Option(label, value));
  select.value = term.gender || '';
  return select;
}

function renderTermRow(term, index) {
  const row = document.createElement('div');
  row.className = 'glossary-term-row';
  row.dataset.glossaryRow = String(index);
  const values = term || {};
  const makeInput = (role, value, label, placeholder) => {
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'text-input glossary-input';
    input.dataset.role = role;
    input.value = typeof value === 'string' ? value : '';
    input.placeholder = placeholder || '';
    input.setAttribute('aria-label', label);
    input.autocomplete = 'off';
    input.spellcheck = false;
    return input;
  };
  const category = makeInput('category', values.category || 'term', `第 ${index + 1} 条术语分类`, 'term');
  category.setAttribute('list', 'glossaryCategoryOptions');
  const gender = makeGenderSelect(values, index);
  const syncGender = () => {
    gender.classList.toggle('is-unused', !novelUtils.isCharacterCategory(category.value));
  };
  category.addEventListener('input', syncGender);
  syncGender();
  row.append(
    makeInput('source', values.source, `第 ${index + 1} 条术语原文`, '原文/名称'),
    makeInput('target', values.target, `第 ${index + 1} 条术语译文`, '译文'),
    category,
    gender,
    makeInput('note', values.note, `第 ${index + 1} 条术语备注`, '备注（可选）')
  );
  const remove = makeButton('删除', 'button button-ghost-danger glossary-delete', () => {
    syncGlossaryDraft();
    state.glossaryDraft.splice(index, 1);
    if (state.glossaryDraft.length === 0) state.glossaryDraft.push({});
    showGlossaryPage(state.glossaryPage);
    // Rows were rebuilt: keep the keyboard where the deleted row was.
    const next = Math.min(index, state.glossaryDraft.length - 1);
    const button = ui.glossaryRows.querySelector(`[data-glossary-row="${next}"] .glossary-delete`);
    if (button) button.focus();
  }, `删除第 ${index + 1} 条术语`);
  row.append(remove);
  return row;
}

function renderGlossaryEditor() {
  const entry = activeGlossary();
  if (!entry || !ui.glossaryEditor) return;
  resetClearButton();
  ui.glossaryEditor.hidden = false;
  ui.glossaryEditorTitle.textContent = `${entry.title} · ${entry.siteName} · ${entry.targetLabel}`;
  if (ui.glossaryTitleInput) ui.glossaryTitleInput.value = entry.title;
  state.glossaryOpened = entry.terms;
  state.glossaryDraft = entry.terms.length > 0 ? entry.terms.map((term) => ({ ...term })) : [{}];
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
    ...draft.slice(start, end).map((term, offset) => renderTermRow(term, start + offset))
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
  resetClearButton();
  if (ui.glossaryEditor) ui.glossaryEditor.hidden = true;
  if (ui.glossaryRows) ui.glossaryRows.replaceChildren();
  if (ui.glossaryFeedback) setFeedback(ui.glossaryFeedback, '', '');
}

/** Copy the rows on screen back into the draft. */
function syncGlossaryDraft() {
  if (!ui.glossaryRows) return;
  for (const row of ui.glossaryRows.querySelectorAll('[data-glossary-row]')) {
    const value = (role) => {
      const input = row.querySelector(`[data-role="${role}"]`);
      return input ? input.value : '';
    };
    state.glossaryDraft[Number(row.dataset.glossaryRow)] = {
      source: value('source'),
      target: value('target'),
      category: value('category'),
      note: value('note'),
      gender: value('gender')
    };
  }
}

function addGlossaryTermRow() {
  syncGlossaryDraft();
  state.glossaryDraft.push({});
  focusGlossaryRow(state.glossaryDraft.length - 1);
}

async function saveGlossary() {
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
    const stored = await chrome.storage.local.get([entry.key, entry.metaKey]);
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
    await chrome.storage.local.remove(entry.key);
    await loadGlossaries();
    closeGlossaryEditor();
    renderGlossaryList();
    setFeedback(ui.glossaryFeedback, '术语库已清空。', 'success', FEEDBACK_CLEAR_MS);
  } catch (_error) {
    setFeedback(ui.glossaryFeedback, '清空术语库失败，请重试。', 'error');
  }
}

export function wireGlossaryEvents() {
  if (!ui.glossaryList) return;
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
