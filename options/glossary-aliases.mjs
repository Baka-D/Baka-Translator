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

function renderAliasRow(alias, termLabel) {
  const row = document.createElement('div');
  row.className = 'glossary-alias-row';
  row.dataset.aliasRow = '';
  row.append(
    makeAliasInput('alias-source', alias.source, `${termLabel}的其他写法`, '其他写法'),
    makeAliasInput('alias-target', alias.target, `${termLabel}这个写法的译文`, '译文（留空沿用上方译文）'),
    makeButton('移除', 'button button-ghost-danger glossary-delete', () => row.remove(), `移除${termLabel}的这个写法`)
  );
  return row;
}

export function renderAliases(aliases, index) {
  const termLabel = `第 ${index + 1} 条术语`;
  const list = document.createElement('div');
  list.className = 'glossary-aliases';
  const add = makeButton('添加其他写法', 'button button-secondary button-compact', () => {
    const row = renderAliasRow({}, termLabel);
    add.before(row);
    row.querySelector('[data-role="alias-source"]').focus();
  }, `为${termLabel}添加其他写法`);
  list.append(...(aliases || []).map((alias) => renderAliasRow(alias, termLabel)), add);
  return list;
}

/** The aliases on screen; one without a translation uses the term's. */
export function readAliases(termRow, target) {
  return Array.from(termRow.querySelectorAll('[data-alias-row]'), (row) => ({
    source: row.querySelector('[data-role="alias-source"]').value,
    target: row.querySelector('[data-role="alias-target"]').value.trim() || target
  }));
}
