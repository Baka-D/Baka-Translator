// One editable glossary term row; it shows save/cancel beside itself once edited.
import { novelUtils, t } from './context.mjs';
import { addAlias, readAliases, renderAliases } from './glossary-aliases.mjs';
import { makeButton } from './utils.mjs';

const GENDER_OPTIONS = [['none', t('opt_glossary_gender_none')], ['male', t('opt_glossary_gender_male')], ['female', t('opt_glossary_gender_female')]];
const CATEGORY_OPTIONS = [
  ['character', t('opt_glossary_category_character')], ['place', t('opt_glossary_category_place')], ['organization', t('opt_glossary_category_organization')],
  ['skill', t('opt_glossary_category_skill')], ['item', t('opt_glossary_category_item')], ['term', t('opt_glossary_category_term')]
];

function makeCategorySelect(value, index) {
  const select = document.createElement('select');
  select.className = 'select glossary-input';
  select.dataset.role = 'category';
  select.setAttribute('aria-label', t('opt_glossary_row_category_label', [index + 1]));
  for (const [category, label] of CATEGORY_OPTIONS) select.add(new Option(label, category));
  const current = String(value || '').trim() || 'term';
  // A category the model wrote outside this list stays selectable as it is.
  if (!CATEGORY_OPTIONS.some(([category]) => category === current)) select.add(new Option(current, current));
  select.value = current;
  return select;
}

function makeGenderSelect(term, index) {
  const select = document.createElement('select');
  select.className = 'select glossary-input';
  select.dataset.role = 'gender';
  select.setAttribute('aria-label', t('opt_glossary_row_gender_label', [index + 1]));
  // Unset differs from a chosen 无, which stops later chapters filling in a gender.
  const unset = new Option(t('opt_glossary_gender'), '');
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
  const category = makeCategorySelect(values.category, index);
  const gender = makeGenderSelect(values, index);
  const syncGender = () => {
    gender.classList.toggle('is-unused', !novelUtils.isCharacterCategory(category.value));
  };
  category.addEventListener('input', syncGender);
  syncGender();
  row.append(
    makeInput('source', values.source, t('opt_glossary_row_source_label', [index + 1]), t('opt_glossary_source_placeholder')),
    makeInput('target', values.target, t('opt_glossary_row_target_label', [index + 1]), t('opt_glossary_translation')),
    category,
    gender,
    makeInput('note', values.note, t('opt_glossary_row_note_label', [index + 1]), t('opt_glossary_note_placeholder'))
  );

  const aliases = renderAliases(values.aliases, index);
  const actions = document.createElement('div');
  actions.className = 'glossary-row-actions';
  const addAliasButton = makeButton(t('opt_glossary_add_alias_short'), 'button button-secondary glossary-row-button', () => addAlias(aliases, index),
    t('opt_glossary_add_alias_label', [index + 1]));
  addAliasButton.title = t('opt_glossary_add_alias');
  const save = makeButton(t('opt_glossary_save'), 'button button-primary glossary-row-button', () => handlers.onSave(index),
    t('opt_glossary_save_row_label', [index + 1]));
  const cancel = makeButton(t('opt_glossary_cancel'), 'button button-secondary glossary-row-button', () => handlers.onCancel(index),
    t('opt_glossary_revert_row_label', [index + 1]));
  const remove = makeButton(t('opt_glossary_delete'), 'button button-ghost-danger glossary-delete', () => handlers.onDelete(index),
    t('opt_glossary_delete_row_label', [index + 1]));
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
