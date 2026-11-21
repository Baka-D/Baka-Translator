'use strict';

const { installI18n } = require('../helpers/i18n');

const { test } = require('node:test');
const assert = require('node:assert/strict');

function element() {
  return {
    textContent: '', value: '', checked: false, hidden: false, disabled: false,
    dataset: {}, style: {}, attributes: {}, children: [], listeners: {},
    classList: { add() {}, remove() {}, toggle() {} },
    setAttribute(key, value) { this.attributes[key] = value; },
    removeAttribute(key) { delete this.attributes[key]; },
    appendChild(child) { this.children.push(child); },
    addEventListener(event, handler) { this.listeners[event] = handler; }
  };
}

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

test('popup startup cannot silently replace user settings while responses are pending', async (t) => {
  const originalFetch = global.fetch;
  const nodes = new Map();
  global.document = {
    getElementById(id) {
      if (!nodes.has(id)) nodes.set(id, element());
      return nodes.get(id);
    },
    createElement: element,
    createDocumentFragment: element
  };
  global.window = { addEventListener() {}, setTimeout, clearTimeout, close() {} };
  const config = require('../../shared/config.js');
  global.DSHT = {
    config,
    languages: require('../../shared/languages.js'),
    presets: require('../../shared/presets.js')
  };
  let configReply;
  let pageReply;
  let values;
  let storageListener;
  global.chrome = {
    tabs: { async query() { return [{ id: 1, url: 'https://example.com/article' }]; } },
    runtime: {
      getURL(path) { return `chrome-extension://test/${path}`; },
      sendMessage(message) {
        return message.type === config.MSG.GET_CONFIG ? configReply.promise : pageReply.promise;
      }
    },
    storage: {
      local: {
        async get() { return structuredClone(values); },
        async set(update) { Object.assign(values, structuredClone(update)); }
      },
      onChanged: { addListener(listener) { storageListener = listener; } }
    }
  };
  global.fetch = async () => ({ ok: true, async json() {
    return { presets: [{ id: 'general', name: '常规', file: 'general.json' }] };
  } });

  try {
    installI18n();
    const { init } = await import('../../popup/popup-main.mjs');
    const { state } = await import('../../popup/popup-state.mjs');
    const initial = structuredClone(state);
    const target = nodes.get('targetSelect');
    const bilingual = nodes.get('bilingualToggle');
    const flush = () => new Promise((resolve) => setImmediate(resolve));
    const loadedConfig = { ok: true, hasApiKey: true, targetLang: 'zh', bilingual: false };
    const loadedPage = { ok: true, info: {
      status: 'done', pageTranslated: true, targetCode: 'zh', bilingual: false,
      progress: { done: 1, total: 1, failed: 0 }
    } };
    const changeSettings = () => {
      // Disabled native controls do not dispatch user changes.
      if (!target.disabled) { target.value = 'en'; target.listeners.change(); }
      if (!bilingual.disabled) { bilingual.checked = true; bilingual.listeners.change(); }
    };

    for (const stage of ['configuration', 'page state']) {
      await t.test(`waits for the initial ${stage} before accepting settings`, async () => {
        Object.assign(state, structuredClone(initial));
        configReply = deferred();
        pageReply = deferred();
        values = {};
        const initializing = init();
        await flush();
        if (stage === 'page state') {
          configReply.resolve(loadedConfig);
          await flush();
        }
        changeSettings();
        const disabledDuringLoad = [target.disabled, bilingual.disabled];
        assert.equal(nodes.get('statusText').textContent, '正在读取页面状态…',
          `the ${stage} wait must not display an unknown page`);
        configReply.resolve(loadedConfig);
        pageReply.resolve(loadedPage);
        await initializing;

        assert.deepEqual(disabledDuringLoad, [true, true]);
        assert.deepEqual(values, {}, 'no preference can be saved and then visually reverted during loading');
        assert.deepEqual([target.disabled, bilingual.disabled], [false, false]);
        changeSettings();
        assert.equal(values[config.STORAGE_KEYS.TARGET], 'en');
        assert.equal(values[config.STORAGE_KEYS.BILINGUAL], true);
        assert.equal(state.settings.targetCode, 'en');
        assert.equal(state.settings.bilingual, true);
      });
    }

    await t.test('unlocks settings when configuration fails', async () => {
      Object.assign(state, structuredClone(initial));
      configReply = deferred();
      pageReply = deferred();
      values = {};
      const initializing = init();
      configReply.resolve({ ok: false });
      await initializing;
      assert.deepEqual([target.disabled, bilingual.disabled], [false, false]);
      changeSettings();
      assert.equal(values[config.STORAGE_KEYS.TARGET], 'en');
      assert.equal(values[config.STORAGE_KEYS.BILINGUAL], true);
    });

    await t.test('unlocks settings when the first page response fails', async () => {
      Object.assign(state, structuredClone(initial));
      configReply = deferred();
      pageReply = deferred();
      values = {};
      const initializing = init();
      configReply.resolve(loadedConfig);
      await flush();
      assert.deepEqual([target.disabled, bilingual.disabled], [true, true]);
      pageReply.resolve({ ok: false, error: { code: 'NO_PAGE_ACCESS' } });
      await initializing;
      assert.deepEqual([target.disabled, bilingual.disabled], [false, false]);
      changeSettings();
      assert.equal(values[config.STORAGE_KEYS.TARGET], 'en');
      assert.equal(values[config.STORAGE_KEYS.BILINGUAL], true);
    });

    await t.test('initial config cannot undo a newer provider or preset response', async () => {
      Object.assign(state, structuredClone(initial));
      const first = deferred();
      configReply = first;
      pageReply = deferred();
      values = {};
      const initializing = init();
      await flush();
      configReply = deferred();
      storageListener({ [config.STORAGE_KEYS.POLISH_MODEL_ID]: { newValue: 'new' } }, 'local');
      configReply.resolve({ ...loadedConfig, hasApiKey: false, polishHasApiKey: false, presetId: 'academic' });
      await flush();
      first.resolve(loadedConfig);
      pageReply.resolve(loadedPage);
      await initializing;
      assert.equal(state.hasApiKey, false);
      assert.equal(state.polishHasApiKey, false);
      assert.equal(state.globalPresetId, 'academic');

      configReply = deferred();
      storageListener({ [config.STORAGE_KEYS.PRESET_ID]: { newValue: 'general' } }, 'local');
      configReply.resolve(loadedConfig);
      await flush();
      assert.equal(state.globalPresetId, 'general');
    });
  } finally {
    delete global.document;
    delete global.window;
    delete global.chrome;
    delete global.DSHT;
    global.fetch = originalFetch;
  }
});
