// Other expressions of a glossary term. Each has its own fields: names can hold any character.
import { makeButton } from './utils.mjs';

function makeAliasInput(role, value, label, placeholder) {
  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'text-input glossary-input';
  input.dataset.role = role;
  input.value = value || '';
  input.placeholder = placeholder;
  input.setAttribute('aria-label', label);
  input.autocomplete = 'off';
  input.spellcheck = false;
  return input;
}

function renderAliasRow(alias, termLabel, termTarget) {
  const row = document.createElement('div');
  row.className = 'glossary-alias-row';
  row.dataset.aliasRow = '';
  row.append(
    makeAliasInput('alias-source', alias.source, `${termLabel}的其他写法`, '其他写法'),
    // A copy of the term's translation shows blank again, so it keeps following that translation.
    makeAliasInput('alias-target', alias.target === termTarget ? '' : alias.target,`${termLabel}这个写法的译文`, '译文（留空沿用上方译文）'),
    makeButton('移除', 'button button-ghost-danger glossary-delete', () => row.remove(), `移除${termLabel}的这个写法`)
  );
  return row;
}

export function renderAliases(aliases, index, termTarget) {
  const list = document.createElement('div');
  list.className = 'glossary-aliases';
  list.append(...(aliases || []).map((alias) => renderAliasRow(alias, `第 ${index + 1} 条术语`, termTarget)));
  return list;
}

/** Add an empty alias row to a term's list and put the cursor in it. */
export function addAlias(list, index) {
  const row = renderAliasRow({}, `第 ${index + 1} 条术语`);
  list.append(row);
  row.querySelector('[data-role="alias-source"]').focus();
}

/** The aliases on screen; one without a translation uses the term's. */
export function readAliases(termRow, target) {
  return Array.from(termRow.querySelectorAll('[data-alias-row]'), (row) => ({
    source: row.querySelector('[data-role="alias-source"]').value,
    target: row.querySelector('[data-role="alias-target"]').value.trim() || target
  }));
}
