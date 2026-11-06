/**
 * Small pure helpers shared by the content script and tests.
 */
(function initTextUtils(globalScope) {
  'use strict';

  const LETTER_RE = /\p{L}/u;

  function isMeaningfulText(value) {
    return typeof value === 'string' && LETTER_RE.test(value) && value.trim().length > 0;
  }

  /**
   * Preserve whitespace around a DOM text node while only the meaningful core
   * is sent to the model. Inline whitespace is layout-relevant on the web.
   */
  function splitWhitespace(value) {
    const text = typeof value === 'string' ? value : '';
    const match = /^(\s*)([\s\S]*?)(\s*)$/.exec(text);
    if (!match) return { leading: '', core: text, trailing: '' };
    return { leading: match[1], core: match[2], trailing: match[3] };
  }

  function createBatches(items, options) {
    const opts = options || {};
    const maxChars = Number.isFinite(opts.maxChars) ? opts.maxChars : 2800;
    const maxItems = Number.isFinite(opts.maxItems) ? opts.maxItems : 24;
    const list = Array.isArray(items) ? items.filter(Boolean) : [];
    const batches = [];
    let current = [];
    let currentChars = 0;

    const flush = () => {
      if (current.length > 0) {
        batches.push(current);
        current = [];
        currentChars = 0;
      }
    };

    for (const item of list) {
      const length = String(item.text || '').length;
      if (
        current.length > 0 &&
        (current.length >= maxItems || currentChars + length > maxChars)
      ) {
        flush();
      }
      current.push(item);
      currentChars += length;
      if (current.length >= maxItems) flush();
    }
    flush();
    return batches;
  }

  /** Split `segments` into those with a remembered translation and the rest. */
  function recallTranslations(segments, memory) {
    const known = [];
    const translations = [];
    const fresh = [];
    for (const segment of segments) {
      const hit = memory.get(segment.text);
      if (!hit) {
        fresh.push(segment);
        continue;
      }
      known.push(segment);
      translations.push({ id: segment.id, text: hit.text });
    }
    return { known, translations, fresh };
  }

  function normalizeKey(value) {
    return String(value || '')
      .replace(/\s+/g, ' ')
      .trim()
      .toLowerCase();
  }

  function truncate(value, maxLength) {
    const text = String(value || '');
    if (text.length <= maxLength) return text;
    // A cut through a surrogate pair would leave half a character behind.
    return text.slice(0, Math.max(0, maxLength - 1)).replace(/[\uD800-\uDBFF]$/, '') + '…';
  }

  function chunkPolishPairs(items, options) {
    const opts = options || {};
    const maxChars = Number.isFinite(opts.maxChars) && opts.maxChars > 0
      ? opts.maxChars
      : 16000;
    const list = Array.isArray(items) ? items : [];
    const chunks = [];
    let current = [];
    let chars = 0;
    for (const item of list) {
      const cost =
        String((item && item.original) || '').length +
        String((item && item.translation) || '').length;
      if (current.length > 0 && chars + cost > maxChars) {
        chunks.push(current);
        current = [];
        chars = 0;
      }
      current.push(item);
      chars += cost;
    }
    if (current.length > 0) chunks.push(current);
    return chunks;
  }

  /** Up to `maxChars` of the text before `index`, oldest first. */
  function precedingText(items, index, textOf, maxChars) {
    const parts = [];
    let room = maxChars;
    for (let at = index - 1; at >= 0 && room > 0; at -= 1) {
      const text = String(textOf(items[at]) || '').trim();
      if (!text) continue;
      parts.unshift(text.slice(-room));
      room -= text.length + 1;
    }
    return parts.join('\n');
  }

  /** Source followed by draft, the text form of a polish pair in request context. */
  function pairText(pair) {
    return `${pair.original}\n${pair.translation}`;
  }

  /** `base` plus the text before `first`; undefined while context is switched off. */
  function contextBefore(base, items, first, textOf, maxChars) {
    if (!base) return undefined;
    const text = precedingText(items, items.indexOf(first), textOf, maxChars);
    return text ? { ...base, precedingText: text } : base;
  }

  const api = Object.freeze({
    isMeaningfulText,
    splitWhitespace,
    createBatches,
    recallTranslations,
    chunkPolishPairs,
    precedingText,
    pairText,
    contextBefore,
    normalizeKey,
    truncate
  });

  globalScope.DSHT = globalScope.DSHT || {};
  globalScope.DSHT.textUtils = api;

  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this);
