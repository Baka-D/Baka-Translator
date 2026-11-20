'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { createChromeI18n, createLocalizedContext } = require('../helpers/i18n');

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

function runScript(context, file) {
  const filename = require.resolve(`../../${file}`);
  vm.runInContext(fs.readFileSync(filename, 'utf8'), context, { filename });
}

function browser({ saved, firstRead, catalogReads = {}, failWrite = false } = {}) {
  const values = { uiLanguage: saved, targetLang: 'ko' };
  let native = createChromeI18n('en-US');
  const storageListeners = [];
  const languageListeners = [];

  function changePreference(value) {
    const oldValue = values.uiLanguage;
    values.uiLanguage = value;
    for (const listener of storageListeners) {
      listener({ uiLanguage: { newValue: value, oldValue } }, 'local');
    }
  }

  const context = createLocalizedContext({
    chrome: {
      i18n: {
        getMessage: (...args) => native.getMessage(...args),
        getUILanguage: () => native.getUILanguage()
      },
      runtime: { getURL: (path) => 'chrome-extension://test/' + path },
      storage: {
        local: {
          async get() {
            const snapshot = { ...values };
            const gate = firstRead;
            firstRead = null;
            if (gate) await gate.promise;
            return snapshot;
          },
          async set(update) {
            if (failWrite) throw new Error('Storage write failed');
            assert.deepEqual(Object.keys(update), ['uiLanguage']);
            changePreference(update.uiLanguage);
          }
        },
        onChanged: { addListener: (listener) => storageListeners.push(listener) }
      }
    },
    async fetch(url) {
      const path = new URL(url).pathname;
      if (catalogReads[path]) await catalogReads[path].promise;
      return { ok: true, json: async () => require(`../..${path}`) };
    },
    addEventListener(type, listener) {
      if (type === 'languagechange') languageListeners.push(listener);
    }
  });
  return {
    context, i18n: context.DSHT.i18n, values, changePreference, storageListeners,
    changeSystem(language) {
      native = createChromeI18n(language);
      for (const listener of languageListeners) listener({ type: 'languagechange', isTrusted: true });
    }
  };
}

const settle = () => new Promise((resolve) => setImmediate(resolve));

test('cold start reads the saved Korean UI, preserving literal user substitutions', async () => {
  const { i18n } = browser({ saved: 'ko' });
  await i18n.ready;
  assert.equal(i18n.preference, 'ko');
  assert.equal(i18n.locale, 'ko');
  const userText = '$2 <name> $1 $&';
  const message = i18n.t('pop_segments', [userText, 8]);
  assert.ok(message.includes(userText));
  assert.ok(message.includes('8'));
});

test('every manually selected native catalog renders the original text and placeholders', async () => {
  const { i18n } = browser();
  const values = ['$2', '$&', '$arg1$', '$$', '5', '6', '7', '8', '9'];
  for (const [language, file] of [['en', 'en'], ['ko', 'ko'], ['zh', 'zh-cn']]) {
    await i18n.setPreference(language);
    const source = require(`../../locales/${file}.json`);
    for (const [key, message] of Object.entries(source)) {
      const expected = message.replace(/\$([1-9])/g, (_match, index) => values[Number(index) - 1]);
      assert.equal(i18n.t(key, values), expected, `${language}/${key}`);
    }
  }
});

test('switching back reuses the decoded messages and preserves literal dollar signs', async () => {
  const { i18n, context } = browser();
  const reads = [];
  context.fetch = async (url) => {
    reads.push(new URL(url).pathname);
    return { ok: true, json: async () => ({
      price: { message: '$$0.01 | $$arg3$$ | $$$$ | $arg1$$arg2$ | $arg1$' }
    }) };
  };
  await i18n.ready;
  assert.deepEqual(reads, []);
  await i18n.setPreference('ko');
  await i18n.setPreference('auto');
  await i18n.setPreference('ko');
  assert.deepEqual(reads, ['/_locales/ko/messages.json']);
  assert.equal(i18n.t('price', ['$2', '$&']), '$0.01 | $arg3$ | $$ | $2$& | $2');
});

for (const latest of ['en', 'auto']) {
  test(`a storage event selecting ${latest} supersedes an older initial read`, async () => {
    const firstRead = deferred();
    const { i18n, changePreference } = browser({ saved: 'ko', firstRead });
    changePreference(latest);
    firstRead.resolve();
    await i18n.ready;
    assert.equal(i18n.preference, latest);
    assert.equal(i18n.locale, 'en');
  });
}

test('out-of-order catalog reads publish only the latest stored preference', async () => {
  const korean = deferred();
  const english = deferred();
  const { i18n, changePreference } = browser({
    catalogReads: { '/_locales/ko/messages.json': korean, '/_locales/en/messages.json': english }
  });
  await i18n.ready;
  const changes = [];
  i18n.onChange(() => changes.push(i18n.preference));
  changePreference('ko');
  changePreference('en');
  english.resolve();
  await i18n.ready;
  korean.resolve();
  await settle();
  assert.equal(i18n.preference, 'en');
  assert.deepEqual(changes, ['en']);
});

test('a pending ready waiter follows a newer language selection', async () => {
  const korean = deferred();
  const english = deferred();
  const { i18n, changePreference } = browser({
    saved: 'ko', catalogReads: { '/_locales/ko/messages.json': korean, '/_locales/en/messages.json': english }
  });
  let ready = false;
  const initialized = i18n.ready.then(() => { ready = true; });
  await settle();
  changePreference('en');
  korean.resolve();
  await settle();
  assert.equal(ready, false);
  english.resolve();
  await initialized;
  assert.equal(i18n.preference, 'en');
});

test('manual selections persist in user order even when the first catalog loads last', async () => {
  const korean = deferred();
  const { i18n, values } = browser({ catalogReads: { '/_locales/ko/messages.json': korean } });
  await i18n.ready;
  const earlier = i18n.setPreference('ko');
  const latest = i18n.setPreference('en');
  await settle();
  korean.resolve();
  await Promise.all([earlier, latest]);
  assert.equal(values.uiLanguage, 'en');
  assert.equal(i18n.preference, 'en');
});

test('reinjecting the content script reuses its locale and storage subscription', async () => {
  const { i18n, context, storageListeners, changePreference } = browser({ saved: 'ko' });
  await i18n.ready;
  let changes = 0;
  i18n.onChange(() => { changes++; });
  runScript(context, 'shared/i18n.js');
  assert.equal(context.DSHT.i18n, i18n);
  assert.equal(storageListeners.length, 1);
  changePreference('zh');
  await i18n.ready;
  assert.equal(i18n.locale, 'zh-CN');
  assert.equal(changes, 1);
});

test('failed persistence keeps the previously applied language', async () => {
  const { i18n, values } = browser({ saved: 'zh', failWrite: true });
  await i18n.ready;
  await assert.rejects(i18n.setPreference('ko'), /Storage write failed/);
  assert.equal(values.uiLanguage, 'zh');
  assert.equal(i18n.preference, 'zh');
  assert.equal(i18n.locale, 'zh-CN');
});

test('returning to automatic follows native UI changes while Korean output stays selected', async () => {
  const { i18n, changeSystem, context, values } = browser({ saved: 'zh' });
  await i18n.ready;
  for (const file of ['shared/languages.js', 'shared/presets.js', 'shared/glossary.js',
    'preset/system-prompts.js', 'shared/protocol.js']) {
    runScript(context, file);
  }
  const { languages, protocol } = context.DSHT;
  const korean = languages.getTargetLanguage(values.targetLang);
  const request = () => protocol.buildTranslationMessages({
    segments: [{ id: 's1', text: 'Hello' }], targetCode: values.targetLang
  });
  const original = request();
  assert.match(original[0].content, /Korean \(한국어\)/);
  assert.equal(korean.label, '韩语');
  await i18n.setPreference('auto');
  assert.equal(i18n.locale, 'en');
  assert.equal(korean.label, 'Korean');
  changeSystem('ko-KR');
  await i18n.ready;
  assert.equal(i18n.locale, 'ko');
  assert.equal(korean.label, '한국어');
  assert.equal(values.targetLang, 'ko');
  assert.deepEqual(request(), original);
});
