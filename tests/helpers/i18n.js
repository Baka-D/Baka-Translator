'use strict';

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const catalogs = {
  zh_CN: require('../../locales/zh-cn.json'),
  en: require('../../locales/en.json')
};
const filename = path.resolve(__dirname, '../../shared/i18n.js');
const source = fs.readFileSync(filename, 'utf8');

/** Browser locale service for isolated tests; application code remains the real helper. */
function createChromeI18n(locale = 'zh_CN') {
  const language = /^en(?:[-_]|$)/i.test(locale) ? 'en' : 'zh_CN';
  return {
    getUILanguage: () => language.replace('_', '-'),
    getMessage(key, substitutions = []) {
      const values = Array.isArray(substitutions) ? substitutions : [substitutions];
      const message = catalogs[language][key];
      return typeof message === 'string'
        ? message.replace(/\$([1-9])/g, (_match, index) => String(values[Number(index) - 1] ?? ''))
        : '';
    }
  };
}

/** Load i18n first, as manifest/content-script and service-worker entry points do. */
function createLocalizedContext(sandbox = {}, { locale = 'zh_CN' } = {}) {
  if (sandbox.globalThis && sandbox.globalThis !== sandbox) {
    Object.assign(sandbox, sandbox.globalThis);
    delete sandbox.globalThis;
  }
  sandbox.chrome ||= {};
  if (sandbox.chrome.runtime) {
    sandbox.chrome.runtime.getManifest ||= () => structuredClone(require('../../manifest.json'));
  }
  sandbox.chrome.i18n ||= createChromeI18n(locale);
  const context = vm.createContext(sandbox);
  vm.runInContext(source, context, { filename });
  // Individual worker files share the binding created by service-worker.js.
  context.t ??= context.DSHT.i18n.t;
  return context;
}

/** Standalone popup/options imports do not pass through their HTML script loader. */
function installI18n(target = globalThis, { locale = 'zh_CN' } = {}) {
  target.chrome ||= {};
  target.chrome.i18n = createChromeI18n(locale);
  const context = createLocalizedContext({ chrome: target.chrome }, { locale });
  target.DSHT ||= {};
  target.DSHT.i18n = context.DSHT.i18n;
  return target.DSHT.i18n;
}

function loadLocalizedShared(names, options = {}) {
  const context = createLocalizedContext({}, options);
  for (const name of names) {
    const file = path.resolve(__dirname, '../../shared', `${name}.js`);
    vm.runInContext(fs.readFileSync(file, 'utf8'), context, { filename: file });
  }
  return context.DSHT;
}

module.exports = { createChromeI18n, createLocalizedContext, installI18n, loadLocalizedShared };
