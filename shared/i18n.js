/** UI localization only. Translation targets, prompts and user data stay unchanged. */
(function initI18n(globalScope) {
  'use strict';
  const root = globalScope.DSHT ||= {};
  if (root.i18n) {
    if (typeof module === 'object' && module.exports) module.exports = root.i18n;
    return;
  }
  // Node's test harness has no extension locale service.
  const catalog = typeof module === 'object' && module.exports
    ? require('../locales/zh-cn.json') : null;
  const templates = new Map();
  const markers = Array.from({ length: 9 }, (_value, index) => `\uFFF0dsht${index + 1}\uFFF1`);
  const markerPattern = /\uFFF0dsht([1-9])\uFFF1/g;
  let invalidated = false;
  const localeFiles = Object.freeze({ zh: 'zh_CN', en: 'en', ko: 'ko' });
  const storageKey = 'uiLanguage';
  const storage = globalScope.chrome?.storage;
  const catalogs = new Map();
  const listeners = new Set();
  let preference = 'auto';
  let requested = 'auto';
  let selectedCatalog = null;
  let revision = 0;
  let storageChanges = 0;
  let selection = 0;
  let pending = Promise.resolve();

  function loadCatalog(language) {
    if (language === 'auto') return Promise.resolve(null);
    if (!catalogs.has(language)) {
      const url = globalScope.chrome.runtime.getURL(`_locales/${localeFiles[language]}/messages.json`);
      const loading = fetch(url).then(async (response) => {
        if (!response.ok) throw new Error(`Cannot load locale: ${language}`);
        const messages = Object.create(null);
        // Undo scripts/localize.py's encoding once, before inserting any user text.
        for (const [key, { message }] of Object.entries(await response.json())) {
          messages[key] = message.replace(/\$\$|\$arg([1-9])\$/g, (_match, index) => index ? '$' + index : '$');
        }
        return messages;
      }).catch((error) => {
        catalogs.delete(language);
        throw error;
      });
      catalogs.set(language, loading);
    }
    return catalogs.get(language);
  }

  function applyPreference(value, systemChanged = false) {
    const next = typeof value === 'string' && Object.hasOwn(localeFiles, value) ? value : 'auto';
    if (requested === next && !systemChanged) return pending;
    requested = next;
    const current = ++revision;
    pending = loadCatalog(next).then((messages) => {
      if (current !== revision) return;
      selectedCatalog = messages;
      preference = next;
      templates.clear();
      for (const listener of listeners) {
        try { listener(); } catch (error) { globalScope.reportError?.(error); }
      }
    }, () => {
      if (current === revision) requested = preference;
    });
    return pending;
  }

  async function readPreference() {
    const observed = storageChanges;
    const values = await storage?.local?.get(storageKey);
    if (observed === storageChanges) await applyPreference(values?.[storageKey]);
  }

  storage?.onChanged?.addListener((changes, area) => {
    if (area === 'local' && Object.hasOwn(changes, storageKey)) {
      storageChanges++;
      void applyPreference(changes[storageKey].newValue);
    }
  });
  globalScope.addEventListener?.('languagechange', (event) => {
    if (event.isTrusted && requested === 'auto') void applyPreference('auto', true);
  });
  const initial = readPreference().catch(() => {});

  async function whenReady() {
    await initial;
    let current;
    do {
      current = pending;
      await current;
    } while (current !== pending);
  }

  async function setPreference(value) {
    if (typeof value !== 'string' || (value !== 'auto' && !Object.hasOwn(localeFiles, value))) {
      throw new RangeError('Invalid UI language');
    }
    const latest = ++selection;
    await loadCatalog(value);
    if (latest !== selection) return;
    await storage.local.set({ [storageKey]: value });
    // Also applies the setting when this context has not received onChanged yet.
    await readPreference();
    await whenReady();
  }

  function catalogMessage(messages, key, values) {
    const message = messages?.[key];
    return typeof message === 'string'
      ? message.replace(/\$([1-9])/g, (_match, index) => values[Number(index) - 1] ?? '')
      : key;
  }

  function t(key, substitutions = []) {
    const values = (Array.isArray(substitutions) ? substitutions : [substitutions])
      .map((value) => String(value ?? ''));
    if (selectedCatalog) return catalogMessage(selectedCatalog, key, values);
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
    return catalogMessage(catalog, key, values);
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
    storageKey,
    t, languageLabel, presetName, presetDescription, providerName, modelName, localizeDocument,
    setPreference,
    onChange(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    get ready() { return whenReady(); },
    get preference() { return preference; },
    get locale() { return t('ui_language'); }
  });
  root.i18n = api;
  if (typeof module === 'object' && module.exports) module.exports = api;
})(globalThis);
