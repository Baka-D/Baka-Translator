/**
 * Target languages exposed by the extension. At least Chinese, English,
 * Korean, Japanese and Russian are required by the product.
 */
(function initLanguages(globalScope) {
  'use strict';
  const i18n = globalScope.DSHT?.i18n ||
    (typeof require === 'function' ? require('./i18n.js') : null);

  function targetLanguage(code, promptName, nativeName) {
    return Object.freeze({
      code, promptName, nativeName,
      get label() { return i18n.languageLabel(code); },
      get shortLabel() { return i18n.t(`language_short_${code}`); }
    });
  }

  const TARGET_LANGUAGES = Object.freeze([
    targetLanguage('zh', 'Simplified Chinese', '简体中文'),
    targetLanguage('en', 'English', 'English'),
    targetLanguage('ko', 'Korean', '한국어'),
    targetLanguage('ja', 'Japanese', '日本語'),
    targetLanguage('ru', 'Russian', 'Русский')
  ]);

  const BY_CODE = new Map(TARGET_LANGUAGES.map((language) => [language.code, language]));
  const DEFAULT_TARGET = 'zh';

  function getTargetLanguage(code) {
    return BY_CODE.get(String(code || '').toLowerCase()) || null;
  }

  function normalizeTarget(code) {
    return getTargetLanguage(code) ? String(code).toLowerCase() : DEFAULT_TARGET;
  }

  function getLanguageLabel(code) {
    const language = getTargetLanguage(code);
    return language ? language.label : i18n.languageLabel('unknown');
  }

  const api = Object.freeze({
    TARGET_LANGUAGES,
    DEFAULT_TARGET,
    getTargetLanguage,
    normalizeTarget,
    getLanguageLabel
  });

  globalScope.DSHT = globalScope.DSHT || {};
  globalScope.DSHT.languages = api;

  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this);
