/**
 * Target languages exposed by the extension. At least Chinese, English,
 * Korean, Japanese and Russian are required by the product.
 */
(function initLanguages(globalScope) {
  'use strict';
  const i18n = globalScope.DSHT?.i18n ||
    (typeof require === 'function' ? require('./i18n.js') : null);

  const TARGET_LANGUAGES = Object.freeze([
    Object.freeze({
      code: 'zh',
      label: i18n.languageLabel('zh'),
      shortLabel: i18n.t('language_short_zh'),
      promptName: 'Simplified Chinese',
      nativeName: '简体中文'
    }),
    Object.freeze({
      code: 'en',
      label: i18n.languageLabel('en'),
      shortLabel: i18n.t('language_short_en'),
      promptName: 'English',
      nativeName: 'English'
    }),
    Object.freeze({
      code: 'ko',
      label: i18n.languageLabel('ko'),
      shortLabel: i18n.t('language_short_ko'),
      promptName: 'Korean',
      nativeName: '한국어'
    }),
    Object.freeze({
      code: 'ja',
      label: i18n.languageLabel('ja'),
      shortLabel: i18n.t('language_short_ja'),
      promptName: 'Japanese',
      nativeName: '日本語'
    }),
    Object.freeze({
      code: 'ru',
      label: i18n.languageLabel('ru'),
      shortLabel: i18n.t('language_short_ru'),
      promptName: 'Russian',
      nativeName: 'Русский'
    })
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
