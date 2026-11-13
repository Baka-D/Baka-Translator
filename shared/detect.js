/**
 * Lightweight, fully local language detection for the five supported source
 * languages. It never sends page text anywhere. The detector is based on the
 * writing system plus Japanese kana / Korean hangul signals, which is robust
 * for zh/ja/ko/ru. Other Latin-script languages are reported as English by
 * design (the translation prompt still lets the model infer the real source).
 */
(function initDetect(globalScope) {
  'use strict';
  const i18n = globalScope.DSHT?.i18n ||
    (typeof require === 'function' ? require('./i18n.js') : null);

  const LABELS = Object.freeze({
    zh: i18n.languageLabel('zh'),
    en: i18n.languageLabel('en'),
    ko: i18n.languageLabel('ko'),
    ja: i18n.languageLabel('ja'),
    ru: i18n.languageLabel('ru'),
    unknown: i18n.languageLabel('unknown')
  });

  const MAX_ANALYZED_CHARS = 50000;

  function isHan(cp) {
    return (
      (cp >= 0x3400 && cp <= 0x4dbf) ||
      (cp >= 0x4e00 && cp <= 0x9fff) ||
      (cp >= 0xf900 && cp <= 0xfaff) ||
      (cp >= 0x20000 && cp <= 0x2fa1f)
    );
  }

  function isKana(cp) {
    return (
      (cp >= 0x3040 && cp <= 0x30ff) ||
      (cp >= 0x31f0 && cp <= 0x31ff) ||
      (cp >= 0xff66 && cp <= 0xff9d)
    );
  }

  function isHangul(cp) {
    return (
      (cp >= 0x1100 && cp <= 0x11ff) ||
      (cp >= 0x3130 && cp <= 0x318f) ||
      (cp >= 0xac00 && cp <= 0xd7af)
    );
  }

  function isCyrillic(cp) {
    return (
      (cp >= 0x0400 && cp <= 0x052f) ||
      (cp >= 0x2de0 && cp <= 0x2dff) ||
      (cp >= 0xa640 && cp <= 0xa69f)
    );
  }

  function isLatin(cp) {
    return (
      (cp >= 0x0041 && cp <= 0x005a) ||
      (cp >= 0x0061 && cp <= 0x007a) ||
      (cp >= 0x00c0 && cp <= 0x024f) ||
      (cp >= 0x1e00 && cp <= 0x1eff)
    );
  }

  function countScripts(text) {
    const counts = { han: 0, kana: 0, hangul: 0, cyrillic: 0, latin: 0 };
    const sample = typeof text === 'string' ? text.slice(0, MAX_ANALYZED_CHARS) : '';

    for (const char of sample) {
      const cp = char.codePointAt(0);
      if (cp === undefined) continue;
      if (isHan(cp)) counts.han += 1;
      else if (isKana(cp)) counts.kana += 1;
      else if (isHangul(cp)) counts.hangul += 1;
      else if (isCyrillic(cp)) counts.cyrillic += 1;
      else if (isLatin(cp)) counts.latin += 1;
    }

    return counts;
  }

  function languageLabel(code) {
    return LABELS[code] || LABELS.unknown;
  }

  function detectLanguage(text) {
    const counts = countScripts(text);
    const totalLetters =
      counts.han + counts.kana + counts.hangul + counts.cyrillic + counts.latin;

    if (totalLetters === 0) {
      return {
        code: 'unknown',
        label: LABELS.unknown,
        confidence: 0,
        mixed: false,
        counts,
        source: 'text'
      };
    }

    const scores = {
      ja: counts.kana > 0 ? counts.kana * 4 + counts.han * 0.35 : 0,
      ko: counts.hangul > 0 ? counts.hangul * 4 + counts.han * 0.35 : 0,
      zh: counts.han * (counts.kana > 0 || counts.hangul > 0 ? 0.5 : 1),
      ru: counts.cyrillic * 3.2,
      en: counts.latin
    };

    const ranked = Object.entries(scores).sort((a, b) => b[1] - a[1]);
    const [code, topScore] = ranked[0];
    const secondScore = ranked[1] ? ranked[1][1] : 0;
    const sumScores = ranked.reduce((sum, entry) => sum + entry[1], 0);

    const groupLetters =
      code === 'ja'
        ? counts.kana + counts.han
        : code === 'ko'
          ? counts.hangul + counts.han
          : code === 'zh'
            ? counts.han
            : code === 'ru'
              ? counts.cyrillic
              : counts.latin;

    return {
      code: topScore > 0 ? code : 'unknown',
      label: topScore > 0 ? LABELS[code] : LABELS.unknown,
      confidence: Number(Math.min(1, groupLetters / totalLetters).toFixed(2)),
      mixed: sumScores > 0 ? secondScore / sumScores >= 0.28 : false,
      counts,
      source: 'text'
    };
  }

  function fromHtmlLang(value) {
    if (!value) return null;
    const primary = String(value).toLowerCase().trim().split(/[-_]/)[0];
    return Object.prototype.hasOwnProperty.call(
      { zh: 1, en: 1, ko: 1, ja: 1, ru: 1 },
      primary
    )
      ? primary
      : null;
  }

  /**
   * Page-level convenience: use <html lang> only when the content sample is
   * empty or extremely ambiguous. Visible text always wins otherwise.
   */
  function detectPageLanguage(sampleText, htmlLang) {
    const detected = detectLanguage(sampleText);
    if (detected.code === 'unknown' || detected.confidence < 0.2) {
      const hinted = fromHtmlLang(htmlLang);
      if (hinted) {
        return {
          ...detected,
          code: hinted,
          label: LABELS[hinted],
          confidence: Math.max(detected.confidence, 0.2),
          source: 'html-lang'
        };
      }
    }
    return detected;
  }

  const api = Object.freeze({
    detectLanguage,
    detectPageLanguage,
    countScripts,
    fromHtmlLang,
    languageLabel,
    LABELS
  });

  globalScope.DSHT = globalScope.DSHT || {};
  globalScope.DSHT.detect = api;

  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this);
