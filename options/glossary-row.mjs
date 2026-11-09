// One editable glossary term row; it shows save/cancel beside itself once edited.
import { novelUtils } from './context.mjs';
import { addAlias, readAliases, renderAliases } from './glossary-aliases.mjs';
import { makeButton } from './utils.mjs';

const GENDER_OPTIONS = [['none', '无'], ['male', '男'], ['female', '女']];

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

/** The term as the row's fields hold it now. */
export function readTermRow(row) {
  const value = (role) => {
    const input = row.querySelector(`[data-role="${role}"]`);
    return input ? input.value : '';
  };
  return {
    source: value('source'),
    target: value('target'),
    category: value('category'),
    note: value('note'),
    gender: value('gender'),
    aliases: readAliases(row, value('target'))
  };
}

/** Compare a row with its saved term the way the row displays it; blank aliases are dropped on save. */
export function termRowKey(term) {
  const values = term || {};
  const text = (value) => String(value || '').trim();
  const target = text(values.target);
  return JSON.stringify([
    text(values.source),
    target,
    text(values.category) || 'term',
    text(values.gender),
    text(values.note),
    (values.aliases || [])
      .filter((alias) => text(alias.source))
      .map((alias) => [text(alias.source), text(alias.target) || target])
  ]);
}

/**
 * `saved` is the stored term this row started from (null for a new row);
 * `handlers` gives onSave, onCancel and onDelete, each called with the row index.
 */
export function renderTermRow(term, index, saved, handlers) {
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

  const aliases = renderAliases(values.aliases, index);
  const actions = document.createElement('div');
  actions.className = 'glossary-row-actions';
  const addAliasButton = makeButton('+ 写法', 'button button-secondary glossary-delete', () => addAlias(aliases, index),
    `为第 ${index + 1} 条术语添加其他写法`);
  addAliasButton.title = '添加其他写法';
  const save = makeButton('保存', 'button button-primary glossary-delete', () => handlers.onSave(index),
    `保存术语库（含第 ${index + 1} 条的修改）`);
  const cancel = makeButton('取消', 'button button-secondary glossary-delete', () => handlers.onCancel(index),
    `撤销第 ${index + 1} 条术语未保存的修改`);
  const remove = makeButton('删除', 'button button-ghost-danger glossary-delete', () => handlers.onDelete(index),
    `删除第 ${index + 1} 条术语`);
  remove.dataset.role = 'delete';
  actions.append(addAliasButton, save, cancel, remove);
  row.append(actions, aliases);

  const savedKey = termRowKey(saved);
  const syncDirty = () => {
    const dirty = termRowKey(readTermRow(row)) !== savedKey;
    save.hidden = !dirty;
    cancel.hidden = !dirty;
    remove.hidden = dirty;
    // shortcut: no room for a fourth button, so a new spelling waits until the row is saved or reverted.
    addAliasButton.hidden = dirty;
  };
  row.addEventListener('input', syncDirty);
  row.addEventListener('change', syncDirty);
  // Adding or removing an alias changes the row without an input event; the button handler runs first.
  row.addEventListener('click', syncDirty);
  syncDirty();
  return row;
}
