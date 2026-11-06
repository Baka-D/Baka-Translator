/** Response parsing for translation, image OCR and terminology results. */
(function initProtocolResponses(globalScope) {
  'use strict';

  function normalizeTermItem(item) {
    if (!item || typeof item !== 'object') return null;
    const source = String(item.source || item.term || item.original || '').trim();
    const target = String(item.target || item.translation || '').trim();
    if (!source || !target || source.length > 200 || target.length > 200) return null;
    const category = String(item.category || 'term').trim() || 'term';
    const note = String(item.note || '').trim().slice(0, 160);
    const gender = String(item.gender || '').trim().toLowerCase();
    return {
      source,
      target,
      category,
      note,
      ...(gender === 'male' || gender === 'female' ? { gender } : {})
    };
  }

  function parseTermResponse(raw, limit) {
    const parsed = parseJsonValue(raw);
    if (!parsed.ok) return { ok: false, error: parsed.error || 'INVALID_JSON', terms: [] };
    const value = parsed.value;
    let list = null;
    if (Array.isArray(value)) {
      list = value;
    } else if (value && typeof value === 'object') {
      if (Array.isArray(value.terms)) list = value.terms;
      else if (Array.isArray(value.terminology)) list = value.terminology;
      else if (Array.isArray(value.translations)) list = value.translations;
      else if (Object.keys(value).length === 0) list = [];
    }
    if (!list) return { ok: false, error: 'INVALID_TERMS', terms: [] };
    const max = Number.isInteger(limit) && limit > 0 ? limit : 120;
    const bySource = new Map();
    for (const item of list) {
      const term = normalizeTermItem(item);
      if (!term) continue;
      const key = term.source.toLocaleLowerCase();
      if (!bySource.has(key) && bySource.size < max) bySource.set(key, term);
    }
    const terms = Array.from(bySource.values());
    if (terms.length === 0) {
      // Only an empty list says "no terms"; unreadable entries must not mark the chapter done.
      return { ok: false, error: list.length ? 'INVALID_TERMS' : 'NO_TERMS', terms: [] };
    }
    return { ok: true, terms };
  }

  /** Sources the review dropped; an unusable reply drops nothing. */
  function parseTermReview(raw) {
    const parsed = parseJsonValue(raw);
    const drop = parsed.ok && parsed.value ? parsed.value.drop : null;
    return Array.isArray(drop) ? drop.filter((source) => typeof source === 'string') : [];
  }

  function stripFences(raw) {
    let text = String(raw || '').replace(/^\uFEFF/, '').trim();
    if (/^```/.test(text)) {
      text = text.replace(/^```(?:json)?[ \t]*\r?\n?/i, '');
      text = text.replace(/\r?\n?```[ \t]*$/, '');
    }
    return text.trim();
  }

  function tryParse(text) {
    try {
      return { ok: true, value: JSON.parse(text) };
    } catch (_error) {
      return { ok: false, value: undefined };
    }
  }

  /** The objects of a text made of nothing but JSON objects, or null. */
  function objectSequence(text) {
    const parts = [];
    let depth = 0;
    let start = 0;
    let inString = false;
    for (let index = 0; index < text.length; index += 1) {
      const char = text[index];
      if (inString) {
        if (char === '\\') index += 1;
        else if (char === '"') inString = false;
      } else if (depth === 0 && char !== '{') {
        if (!/[\s,]/.test(char)) return null;
      } else if (char === '"') {
        inString = true;
      } else if (char === '{') {
        if (depth === 0) start = index;
        depth += 1;
      } else if (char === '}') {
        depth -= 1;
        if (depth === 0) {
          const part = tryParse(text.slice(start, index + 1));
          if (!part.ok) return null;
          parts.push(part.value);
        }
      }
    }
    return depth === 0 && parts.length > 1 ? parts : null;
  }

  /**
   * Models sometimes answer an id map with one object per id, as
   * `{"s1":"a"},{"s2":"b"}`. Merge only objects whose keys are expected ids used once;
   * anything else is left to parseJsonValue.
   */
  function mergeIdObjects(text, ids) {
    const parts = objectSequence(text);
    if (!parts) return null;
    const entries = parts.flatMap((part) => Object.entries(part));
    const keys = new Set(entries.map(([key]) => key));
    const known = keys.size === entries.length && [...keys].every((key) => ids.includes(key));
    return known ? Object.fromEntries(entries) : null;
  }

  /** The same habit under the polish contract: `{"changes":{..}},{"changes":{..}}`. */
  function mergeChangeObjects(text) {
    const parts = objectSequence(text);
    const usable = parts && parts.every(({ changes, ...rest }) => (
      changes && typeof changes === 'object' && !Array.isArray(changes) && Object.keys(rest).length === 0
    ));
    if (!usable) return null;
    const entries = parts.flatMap((part) => Object.entries(part.changes));
    const changes = Object.fromEntries(entries);
    return Object.keys(changes).length === entries.length ? { changes } : null;
  }

  function parseIdReply(raw, ids) {
    const merged = typeof raw === 'string' ? mergeIdObjects(stripFences(raw), ids) : null;
    return merged ? { ok: true, value: merged } : parseJsonValue(raw);
  }

  function parseJsonValue(raw) {
    if (raw && typeof raw === 'object') return { ok: true, value: raw };
    if (typeof raw !== 'string' || !raw.trim()) {
      return { ok: false, error: 'EMPTY_RESPONSE' };
    }

    const text = stripFences(raw);
    const direct = tryParse(text);
    if (direct.ok) return { ok: true, value: direct.value };

    const candidates = [];
    const objectStart = text.indexOf('{');
    const objectEnd = text.lastIndexOf('}');
    if (objectStart >= 0 && objectEnd > objectStart) {
      candidates.push(text.slice(objectStart, objectEnd + 1));
    }
    const arrayStart = text.indexOf('[');
    const arrayEnd = text.lastIndexOf(']');
    if (arrayStart >= 0 && arrayEnd > arrayStart) {
      candidates.push(text.slice(arrayStart, arrayEnd + 1));
    }

    // The earliest opening bracket is most likely to be the real payload.
    candidates.sort((a, b) => text.indexOf(a[0]) - text.indexOf(b[0]));
    for (const candidate of candidates) {
      const parsed = tryParse(candidate);
      if (parsed.ok) return { ok: true, value: parsed.value };
    }

    return { ok: false, error: 'INVALID_JSON' };
  }

  function normalizeId(value) {
    if (value === null || value === undefined) return '';
    return String(value).trim();
  }

  function pickText(entry) {
    if (!entry || typeof entry !== 'object') return '';
    const candidates = [
      entry.text,
      entry.translation,
      entry.translated,
      entry.translatedText,
      entry.translated_text,
      entry.value
    ];
    for (const candidate of candidates) {
      if (typeof candidate === 'string') return candidate.trim();
    }
    return '';
  }

  /**
   * @returns {{ok:boolean, translations:Array<{id:string,text:string}>,
   *            missing:string[], unexpected:number, error:string|null}}
   */
  function parseTranslationResponse(raw, expectedIds) {
    const ids = Array.isArray(expectedIds) ? expectedIds.map(String) : [];
    const expected = new Set(ids);
    const found = new Map();
    let unexpected = 0;
    let duplicates = 0;
    let positional = false;

    function add(idValue, textValue) {
      const id = normalizeId(idValue);
      if (!id || !expected.has(id)) {
        unexpected += 1;
        return;
      }
      // An empty translation would silently delete visible page content.
      // Treat it as missing so the API layer can retry / report the batch.
      if (typeof textValue !== 'string' || !textValue.trim()) return;
      if (found.has(id)) {
        duplicates += 1;
        return;
      }
      found.set(id, textValue.trim());
    }

    const parsed = parseIdReply(raw, ids);
    if (!parsed.ok || !parsed.value || typeof parsed.value !== 'object') {
      return {
        ok: false,
        translations: [],
        missing: ids.slice(),
        unexpected,
        error: parsed.error || 'INVALID_JSON'
      };
    }

    const value = parsed.value;
    let container = value;
    if (!Array.isArray(value)) {
      if (Array.isArray(value.translations)) container = value.translations;
      else if (Array.isArray(value.segments)) container = value.segments;
      else if (Array.isArray(value.results)) container = value.results;
      else if (value.translations && typeof value.translations === 'object') {
        container = value.translations;
      } else if (value.results && typeof value.results === 'object') {
        container = value.results;
      }
    }

    if (Array.isArray(container)) {
      container.forEach((entry, index) => {
        if (typeof entry === 'string') {
          positional = true;
          if (ids[index] !== undefined) add(ids[index], entry);
          else unexpected += 1;
          return;
        }
        if (!entry || typeof entry !== 'object') return;
        if (entry.id === undefined) {
          positional = true;
          if (ids[index] !== undefined) add(ids[index], pickText(entry));
          return;
        }
        add(entry.id, pickText(entry));
      });
    } else if (container && typeof container === 'object') {
      for (const [key, entry] of Object.entries(container)) {
        if (expected.has(normalizeId(key))) {
          if (typeof entry === 'string') add(key, entry);
          else add(key, pickText(entry));
        }
      }
    }

    const translations = [];
    const missing = [];
    for (const id of ids) {
      if (found.has(id)) translations.push({ id, text: found.get(id) });
      else missing.push(id);
    }

    return {
      ok: missing.length === 0,
      translations,
      missing,
      unexpected: unexpected + duplicates,
      positional,
      error: missing.length === 0 ? null : 'MISSING_TRANSLATIONS'
    };
  }

  /** Polish replies as `{id, text}` entries, from the id map or the older array shape. */
  function polishEntries(value) {
    if (Array.isArray(value.translations)) return value.translations;
    const map = value.translations && typeof value.translations === 'object'
      ? value.translations
      : value;
    return Object.entries(map).map(([id, text]) => ({ id, text }));
  }

  /** The text of one change: '' keeps the draft, null means the entry cannot be read. */
  function changeText(entry) {
    if (entry === null) return '';
    if (typeof entry === 'string') return entry.trim();
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return null;
    if (entry.text === null) return '';
    return pickText(entry) || null;
  }

  /**
   * A polish reply lists only what changed; every other segment keeps its draft exactly.
   * A reply that cannot be read fails: treating it as "no changes" would mark the
   * segments polished for good and lose the edits it was trying to make.
   */
  function applyPolishChanges(changes, ids, drafts) {
    const failed = { ok: false, translations: [], missing: ids.slice(), unexpected: 0, error: 'INVALID_POLISH_RESPONSE' };
    const pairs = Array.isArray(changes)
      ? changes.map((entry) => [entry && entry.id, entry])
      : Object.entries(changes || {});
    const texts = new Map();
    for (const [rawId, entry] of pairs) {
      const id = normalizeId(rawId);
      const text = changeText(entry);
      if (!id || text === null || texts.has(id)) return failed;
      texts.set(id, text);
    }
    const unexpected = [...texts.keys()].filter((id) => !drafts.has(id)).length;
    if (texts.size > 0 && unexpected === texts.size) return failed;
    return {
      ok: true,
      translations: ids.map((id) => ({ id, text: texts.get(id) || drafts.get(id) })),
      missing: [],
      unexpected,
      positional: false,
      error: null
    };
  }

  /** Only a reply made of the changes key alone uses the contract. */
  function isChangesReply(value) {
    const keys = Object.keys(value);
    return keys.length === 1 && keys[0] === 'changes' &&
      (value.changes === null || typeof value.changes === 'object');
  }

  /** The changes contract, or the older full replies with their no-change markers. */
  function parsePolishResponse(raw, segments) {
    const inputs = Array.isArray(segments) ? segments : [];
    const ids = inputs.map((segment, index) =>
      String(segment && segment.id !== undefined ? segment.id : index + 1)
    );
    const drafts = new Map(inputs.map((segment, index) => [ids[index], segment && segment.translation]));
    const merged = typeof raw === 'string' ? mergeChangeObjects(stripFences(raw)) : null;
    const parsed = merged ? { ok: true, value: merged } : parseIdReply(raw, ids);
    if (!parsed.ok || !parsed.value || typeof parsed.value !== 'object' || Array.isArray(parsed.value)) {
      return parseTranslationResponse(raw, ids);
    }
    if (isChangesReply(parsed.value)) return applyPolishChanges(parsed.value.changes, ids, drafts);

    const entries = polishEntries(parsed.value);
    // Full-string responses keep the legacy parser's accepted shapes. Only the
    // older null contract requires explicit, known and unique ids throughout.
    if (!entries.some((entry) => entry && typeof entry === 'object' &&
        Object.hasOwn(entry, 'text') && entry.text === null)) {
      return parseTranslationResponse(raw, ids);
    }
    const seen = new Set();
    for (const entry of entries) {
      const id = entry && typeof entry === 'object' && Object.hasOwn(entry, 'id')
        ? normalizeId(entry.id) : '';
      if (!id || !drafts.has(id) || seen.has(id)) {
        return { ...parseTranslationResponse(raw, ids), ok: false, error: 'INVALID_POLISH_RESPONSE' };
      }
      seen.add(id);
    }
    const unchanged = new Map();
    const translations = entries.map((entry) => {
      if (!Object.hasOwn(entry, 'text') || entry.text !== null) return entry;
      const id = normalizeId(entry.id);
      const draft = drafts.get(id);
      if (typeof draft !== 'string') return entry;
      unchanged.set(id, draft);
      return { ...entry, text: draft };
    });
    const result = parseTranslationResponse({ ...parsed.value, translations }, ids);
    // The common parser trims text. A no-change marker preserves the draft exactly.
    result.translations = result.translations.map((entry) => {
      const draft = unchanged.get(entry.id);
      return typeof draft === 'string'
        ? { ...entry, text: draft }
        : entry;
    });
    return result;
  }

  function firstString(...values) {
    for (const value of values) {
      if (typeof value === 'string') return value.trim();
    }
    return '';
  }

  /**
   * Normalizes the vision response into a stable shape for the image panel.
   * A missing translation for visible text is treated as a retryable failure.
   */
  function parseImageResponse(raw) {
    const parsed = parseJsonValue(raw);
    if (!parsed.ok || !parsed.value || typeof parsed.value !== 'object' || Array.isArray(parsed.value)) {
      return {
        ok: false,
        error: parsed.error || 'INVALID_IMAGE_RESPONSE',
        hasText: false,
        original: '',
        translation: '',
        sourceLanguage: ''
      };
    }

    const value = parsed.value;
    const original = firstString(
      value.original,
      value.text,
      value.ocrText,
      value.ocr_text,
      value.extractedText,
      value.transcription
    );
    const translation = firstString(
      value.translation,
      value.translatedText,
      value.translated_text,
      value.targetText,
      value.result
    );
    const hasText =
      typeof value.hasText === 'boolean'
        ? value.hasText
        : Boolean(original || translation);
    const sourceLanguage = firstString(value.sourceLanguage, value.source_language, value.language);

    // Only the prompt's own fields can say the image is empty; anything else is an unread reply.
    if (!hasText && typeof value.hasText !== 'boolean' && typeof value.original !== 'string') {
      return { ok: false, error: 'INVALID_IMAGE_RESPONSE', hasText: false, original: '', translation: '', sourceLanguage };
    }
    if (!hasText) {
      return {
        ok: true,
        hasText: false,
        original: '',
        translation: '',
        sourceLanguage
      };
    }
    if (!translation) {
      return {
        ok: false,
        error: 'MISSING_IMAGE_TRANSLATION',
        hasText: true,
        original,
        translation: '',
        sourceLanguage
      };
    }

    return {
      ok: true,
      hasText: true,
      original,
      translation,
      sourceLanguage
    };
  }

  const api = Object.freeze({
    parseJsonValue,
    parseTranslationResponse,
    parsePolishResponse,
    parseImageResponse,
    parseTermResponse,
    parseTermReview
  });

  globalScope.DSHT = globalScope.DSHT || {};
  globalScope.DSHT.protocolResponses = api;
  if (typeof module === 'object' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
