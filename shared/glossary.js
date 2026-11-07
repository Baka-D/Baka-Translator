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

  /** Other expressions of a term, each with its own translation; none repeats `source`. */
  function normalizeAliases(value, source) {
    const seen = new Set([termKey(source)]);
    const aliases = [];
    for (const item of Array.isArray(value) ? value : []) {
      const alias = String((item && item.source) || '').trim();
      const target = String((item && item.target) || '').trim();
      if (!alias || !target || seen.has(termKey(alias))) continue;
      seen.add(termKey(alias));
      aliases.push({ source: alias, target });
    }
    return aliases;
  }

  function normalizeTerm(item) {
    if (!item || typeof item !== 'object') return null;
    const source = String(item.source || item.term || '').trim();
    const target = String(item.target || item.translation || '').trim();
    if (!source || !target) return null;
    const category = String(item.category || 'term').trim() || 'term';
    const note = String(item.note || '').trim();
    const gender = String(item.gender || '').trim().toLowerCase();
    const aliases = normalizeAliases(item.aliases, source);
    return {
      source,
      target,
      category,
      note,
      ...(isCharacterCategory(category) && GENDERS.includes(gender) ? { gender } : {}),
      ...(aliases.length ? { aliases } : {})
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
        if (normalized.aliases) {
          previous.aliases = normalizeAliases([...(previous.aliases || []), ...normalized.aliases], previous.source);
        }
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

  /** Terms are found by source, so every alias becomes a term of its own for matching. */
  function expandAliases(glossary) {
    return (Array.isArray(glossary) ? glossary : [])
      .map(normalizeTerm)
      .filter(Boolean)
      .flatMap(({ aliases = [], ...term }) => [term, ...aliases.map((alias) => ({
        ...term, ...alias, note: `same as ${term.source}`
      }))]);
  }

  function glossaryForPrompt(glossary) {
    return expandAliases(glossary)
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

  /** People and skills stay: skill names are often ordinary words, such as 解析. */
  function isDroppableTerm(term) {
    return !isCharacterCategory(term.category) &&
      String(term.category).trim().toLowerCase() !== 'skill';
  }

  /** A character without a gender stays extractable, so a later chapter can supply it. */
  function isSettledTerm(term) {
    return Boolean(term.gender) || !isCharacterCategory(term.category);
  }

  /** The stored terms in `texts` that term extraction need not return again. */
  function knownTerms(glossary, texts) {
    return requestGlossary(expandAliases(glossary).filter(isSettledTerm), texts);
  }

  /**
   * Numbered batches for a tidy; a lower id was stored earlier. Sorting keeps spellings
   * that share a start together.
   */
  // shortcut: spellings that land in different batches are never compared, compare
  // batch leaders in a further request if works outgrow one batch.
  function tidyBatches(terms, size) {
    const sorted = terms.map((term, id) => ({ ...term, id }))
      .sort((left, right) => (termKey(left.source) < termKey(right.source) ? -1 : 1));
    const batches = [];
    for (let at = 0; at < sorted.length; at += size) batches.push(sorted.slice(at, at + size));
    return batches;
  }

  /** The changes in a model `reply` that `batch` allows; anything else in it is ignored. */
  function tidyChanges(batch, reply) {
    const byId = new Map(batch.map((term) => [term.id, term]));
    const list = (value) => (Array.isArray(value) ? value : []);
    const used = new Set();
    const changes = [];
    for (const group of list(reply.merge)) {
      const members = list(group && group.terms);
      // Strict lookups: null, "" or false must not read as id 0.
      const terms = members.map((member) => byId.get(member && member.id));
      if (terms.length < 2 || new Set(terms).size < terms.length) continue;
      if (terms.some((term) => !term || used.has(term))) continue;
      const genders = new Set(terms.map((term) => term.gender).filter((gender) => gender && gender !== 'none'));
      if (genders.size > 1) continue;
      // A person is never the same thing as a place or an item.
      if (new Set(terms.map((term) => isCharacterCategory(term.category))).size > 1) continue;
      // Only a translation already in use: the model must not coin a new one.
      const known = new Set(terms.map((term) => term.target));
      const targets = members.map(({ target }, index) => (known.has(target) ? target : terms[index].target));
      terms.forEach((term) => used.add(term));
      changes.push({ action: 'merge', targets, terms });
    }
    for (const id of list(reply.drop)) {
      const term = byId.get(id);
      // An entry with aliases was already judged a name, and dropping it would lose them.
      if (!term || used.has(term) || term.aliases || !isDroppableTerm(term)) continue;
      used.add(term);
      changes.push({ action: 'drop', terms: [term] });
    }
    return changes;
  }

  /** Up to `limit` passages around `source`, one per chapter, newest chapter first. */
  function termExcerpts(source, chapters, radius, limit) {
    const excerpts = [];
    for (const text of chapters) {
      const at = text.indexOf(source);
      if (at < 0) continue;
      excerpts.push(text.slice(Math.max(0, at - radius), at + source.length + radius));
      if (excerpts.length === limit) break;
    }
    return excerpts;
  }

  /**
   * Apply checked `changes` to `stored`; a change is skipped if any of its entries was
   * edited meanwhile, because its checks ran on the old values. A merge leaves one entry,
   * the first of the group, holding the others as aliases.
   */
  function applyGlossaryTidy(stored, changes) {
    const entry = (term) => [
      termKey(term.source), term.target, term.category, term.gender || '', (term.aliases || []).length
    ].join('\u0000');
    const terms = mergeGlossary(stored, []);
    const byEntry = new Map(terms.map((term) => [entry(term), term]));
    const gone = new Set();
    const touched = new Set();
    const removed = [];
    let merged = 0;
    for (const change of changes) {
      const found = change.terms.map((term) => byEntry.get(entry(term)));
      if (found.some((term) => !term || gone.has(term))) continue;
      found.forEach((term) => touched.add(termKey(term.source)));
      if (change.action === 'drop') {
        gone.add(found[0]);
        removed.push(termKey(found[0].source));
        continue;
      }
      const [kept, ...others] = found;
      const aliases = [...(kept.aliases || [])];
      others.forEach((term, index) => {
        aliases.push({ source: term.source, target: change.targets[index + 1] }, ...(term.aliases || []));
        kept.note ||= term.note;
        if (isCharacterCategory(term.category)) kept.category = term.category;
        kept.gender ||= term.gender;
        gone.add(term);
      });
      kept.target = change.targets[0];
      kept.aliases = normalizeAliases(aliases, kept.source);
      merged += 1;
    }
    return {
      terms: mergeGlossary(terms.filter((term) => !gone.has(term)), []),
      removed,
      touched: Array.from(touched),
      dropped: removed.length,
      merged
    };
  }

  /**
   * What extraction may add to `stored`: an alias counts for its entry, so gender and notes
   * still reach it, and a word a tidy dropped stays out unless someone stored it again.
   */
  function extractedTerms(stored, terms, tidy) {
    const entries = mergeGlossary(stored, []);
    const live = new Set(entries.map((term) => termKey(term.source)));
    const owners = new Map(entries.flatMap((term) => (term.aliases || [])
      .map((alias) => [termKey(alias.source), term])));
    const dropped = new Set(tidy && Array.isArray(tidy.removed) ? tidy.removed : []);
    return (Array.isArray(terms) ? terms : []).flatMap((term) => {
      const key = termKey(term.source);
      const owner = !live.has(key) && owners.get(key);
      if (owner) return [{ ...term, source: owner.source, target: owner.target }];
      return dropped.has(key) && !live.has(key) ? [] : [term];
    });
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
    knownTerms,
    isDroppableTerm,
    tidyBatches,
    tidyChanges,
    termExcerpts,
    applyGlossaryTidy,
    extractedTerms
  });

  globalScope.DSHT = globalScope.DSHT || {};
  globalScope.DSHT.glossary = api;

  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this);
