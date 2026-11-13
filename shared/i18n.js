/** UI localization only. Translation targets, prompts and user data stay unchanged. */
(function initI18n(globalScope) {
  'use strict';
  const root = globalScope.DSHT ||= {};
  // Node's test harness has no extension locale service.
  const catalog = typeof module === 'object' && module.exports
    ? require('../locales/zh-cn.json') : null;
  const templates = new Map();
  const markers = Array.from({ length: 9 }, (_value, index) => `\uFFF0dsht${index + 1}\uFFF1`);
  const markerPattern = /\uFFF0dsht([1-9])\uFFF1/g;
  let invalidated = false;

  function t(key, substitutions = []) {
    const values = (Array.isArray(substitutions) ? substitutions : [substitutions])
      .map((value) => String(value ?? ''));
    const render = (message) => message.replace(markerPattern, (_match, index) => values[Number(index) - 1] ?? '');
    if (templates.has(key)) return render(templates.get(key));
    const native = globalScope.chrome?.i18n;
    if (!invalidated && native?.getMessage) {
      try {
        // Keep templates, never interpolated user text or a growing list of progress values.
        const message = native.getMessage(key, markers);
        if (message) {
          templates.set(key, message);
          return render(message);
        }
      } catch (error) {
        if (!/Extension context invalidated/i.test(String(error?.message))) throw error;
        invalidated = true;
      }
    }
    if (invalidated && templates.has('content_extension_updated')) {
      return render(templates.get('content_extension_updated'));
    }
    const message = catalog?.[key];
    return typeof message === 'string'
      ? message.replace(/\$([1-9])/g, (_match, index) => values[Number(index) - 1] ?? '')
      : key;
  }

  function languageLabel(code, fallback) {
    const primary = String(code || '').toLowerCase().split(/[-_]/)[0];
    return ['zh', 'en', 'ko', 'ja', 'ru'].includes(primary)
      ? t(`language_${primary}`) : fallback || t('language_unknown');
  }

  function presetKey(id) {
    return ['general', 'academic', 'light-novel'].includes(id) ? id.replaceAll('-', '_') : '';
  }

  function presetName(id, fallback = '') {
    const key = presetKey(id);
    return fallback || (key ? t(`preset_${key}_name`) : id);
  }

  function presetDescription(id, fallback = '') {
    const key = presetKey(id);
    return fallback || (key ? t(`preset_${key}_description`) : '');
  }

  function providerName(id, fallback = '') {
    return fallback || (id === 'custom' ? t('provider_custom_name') : id);
  }

  function modelName(id, fallback = '') {
    return fallback || (id === 'custom-model' ? t('model_custom_name') : id);
  }

  function localizeDocument(doc = globalScope.document) {
    if (!doc?.querySelectorAll) return;
    if (doc.documentElement) doc.documentElement.lang = t('ui_language');
    for (const node of doc.querySelectorAll('[data-i18n]')) {
      node.textContent = t(node.getAttribute('data-i18n'));
    }
    for (const attribute of ['title', 'aria-label', 'placeholder']) {
      for (const node of doc.querySelectorAll(`[data-i18n-${attribute}]`)) {
        node.setAttribute(attribute, t(node.getAttribute(`data-i18n-${attribute}`)));
      }
    }
  }

  const api = Object.freeze({
    t, languageLabel, presetName, presetDescription, providerName, modelName, localizeDocument,
    get locale() { return t('ui_language'); }
  });
  root.i18n = api;
  if (typeof module === 'object' && module.exports) module.exports = api;
})(globalThis);
