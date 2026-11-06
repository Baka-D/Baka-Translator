/** Glossary terms: normalization, merging and picking what a request actually uses. */
(function initGlossary(globalScope) {
  'use strict';

  // A library has no size limit; only what one request carries is bounded.
  const MAX_REQUEST_TERMS = 200;
  const CHARACTER_CATEGORY = /^(characters?|person|people|人物|角色|キャラ(クター)?)$/i;
  const GENDERS = Object.freeze(['male', 'female', 'none']);
  // Scripts that separate words, so "Al" must not match inside "Hal".
  const WORD_CHAR = /[\p{Script=Latin}\p{Script=Cyrillic}\p{Script=Greek}\p{N}]/u;

  function isCharacterCategory(category) {
    return CHARACTER_CATEGORY.test(String(category || '').trim());
  }

  function normalizeTerm(item) {
    if (!item || typeof item !== 'object') return null;
    const source = String(item.source || item.term || '').trim();
    const target = String(item.target || item.translation || '').trim();
    if (!source || !target) return null;
    const category = String(item.category || 'term').trim() || 'term';
    const note = String(item.note || '').trim();
    const gender = String(item.gender || '').trim().toLowerCase();
    return {
      source,
      target,
      category,
      note,
      ...(isCharacterCategory(category) && GENDERS.includes(gender) ? { gender } : {})
    };
  }

  /**
   * One key for spellings of a source that differ only in width, case or runs of
   * spaces. Wider NFKC folding would also join different terms such as ① and 1.
   */
  function termKey(source) {
    return String(source || '')
      .replace(/[\u3000\uFF00-\uFFEF]+/g, (text) => text.normalize('NFKC'))
      .toLowerCase()
      .replace(/\s+/g, ' ')
      .trim();
  }

  function mergeGlossary(existing, incoming) {
    const terms = [];
    const bySource = new Map();
    const add = (term, stored) => {
      const normalized = normalizeTerm(term);
      if (!normalized) return;
      const key = termKey(normalized.source);
      const previous = bySource.get(key);
      // Two stored spellings with different translations may be a user's edit:
      // keep both for the editor to resolve instead of dropping one silently.
      if (previous && !(stored && previous.target !== normalized.target)) {
        // Keep the established translation and gender for consistency, but
        // accept a richer category/note/gender from later chapters.
        if (normalized.note) previous.note = normalized.note;
        // A character stays one: reclassifying it would drop its gender.
        const keepsCharacter =
          isCharacterCategory(previous.category) && !isCharacterCategory(normalized.category);
        if (normalized.category && normalized.category !== 'term' && !keepsCharacter) {
          previous.category = normalized.category;
        }
        if (normalized.gender && !previous.gender) previous.gender = normalized.gender;
        return;
      }
      const copy = { ...normalized };
      terms.push(copy);
      if (!previous) bySource.set(key, copy);
    };
    for (const term of Array.isArray(existing) ? existing : []) add(term, true);
    for (const term of Array.isArray(incoming) ? incoming : []) add(term, false);
    return terms;
  }

  function glossaryForPrompt(glossary) {
    return (Array.isArray(glossary) ? glossary : [])
      .map(normalizeTerm)
      .filter(Boolean)
      .map((term) => ({
        source: term.source,
        target: term.target,
        category: term.category,
        ...(term.note ? { note: term.note } : {}),
        ...(term.gender && term.gender !== 'none' ? { gender: term.gender } : {})
      }));
  }

  function foldText(value) {
    return String(value || '').normalize('NFKC').toLowerCase().replace(/\s+/g, ' ');
  }

  // Only the left edge is checked: "dragon" must still match "dragons".
  function termOccurs(text, term) {
    if (!term) return false;
    if (!WORD_CHAR.test(term[0])) return text.includes(term);
    for (let at = text.indexOf(term); at >= 0; at = text.indexOf(term, at + 1)) {
      if (at === 0 || !WORD_CHAR.test(text[at - 1])) return true;
    }
    return false;
  }

  /** Terms whose source appears in `texts`; a non-array glossary passes through. */
  function selectGlossary(glossary, texts) {
    if (!Array.isArray(glossary)) return glossary;
    const text = (Array.isArray(texts) ? texts : []).map(foldText).join('\n');
    return glossary.filter(
      (item) => item && termOccurs(text, foldText(item.source || item.term).trim())
    );
  }

  /** What one request may carry: terms in `texts` first, then those only in nearby context. */
  function requestGlossary(glossary, texts, context) {
    if (!Array.isArray(glossary)) return [];
    const found = new Set(selectGlossary(glossary, texts));
    const nearby = context ? [context.precedingText || context.previousChapter] : [];
    for (const term of selectGlossary(glossary, nearby)) found.add(term);
    return Array.from(found).slice(0, MAX_REQUEST_TERMS);
  }

  /** A character without a gender stays extractable, so a later chapter can supply it. */
  function isSettledTerm(term) {
    return Boolean(term.gender) || !isCharacterCategory(term.category);
  }

  /** The stored terms in `texts` that term extraction need not return again. */
  function knownTerms(glossary, texts) {
    return requestGlossary(Array.isArray(glossary) ? glossary.filter(isSettledTerm) : [], texts);
  }

  const api = Object.freeze({
    MAX_REQUEST_TERMS,
    isCharacterCategory,
    normalizeTerm,
    termKey,
    mergeGlossary,
    glossaryForPrompt,
    selectGlossary,
    requestGlossary,
    isSettledTerm,
    knownTerms
  });

  globalScope.DSHT = globalScope.DSHT || {};
  globalScope.DSHT.glossary = api;

  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this);
