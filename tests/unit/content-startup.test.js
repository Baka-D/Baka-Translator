const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createLocalizedContext } = require('../helpers/i18n');
const { test } = require('node:test');
const config = require('../../shared/config');
const languages = require('../../shared/languages');
const detect = require('../../shared/detect');
const textUtils = require('../../shared/text');

test('repeated content injection keeps a single overlay and runtime listener', async () => {
  let overlays = 0;
  const listeners = [];
  const storageListeners = [];
  let documentListeners = 0;
  let windowListeners = 0;
  const context = createLocalizedContext({
    DSHT: {
      config, languages, detect, textUtils,
      overlay: { createOverlay() { overlays += 1; return { hidePanel() {} }; } }
    },
    document: {
      addEventListener() { documentListeners += 1; },
      querySelector: () => null, querySelectorAll: () => [],
      documentElement: { lang: 'en', children: [] }
    },
    window: { addEventListener() { windowListeners += 1; } },
    Node: { ELEMENT_NODE: 1 },
    chrome: {
      storage: {
        onChanged: { addListener(listener) { storageListeners.push(listener); } },
        local: { async get() { return {}; } }
      },
      runtime: {
        onMessage: { addListener(listener) { listeners.push(listener); } },
        sendMessage(_message, callback) { callback(); }
      }
    }
  });
  const scripts = require('../../manifest.json').content_scripts.find((entry) => entry.js?.includes('content/content.js')).js;
  const sources = scripts.filter((file) => /^content\/content[-.]/.test(file))
    .map((file) => ({ file, source: fs.readFileSync(path.join(__dirname, '../..', file), 'utf8') }));
  const inject = () => {
    for (const { file, source } of sources) vm.runInContext(source, context, { filename: file });
  };
  const sharedStorageListeners = storageListeners.length;
  inject();
  const initialStorageListeners = storageListeners.length;
  assert.ok(initialStorageListeners > sharedStorageListeners);
  inject();
  assert.equal(overlays, 1);
  assert.equal(listeners.length, 1);
  assert.equal(storageListeners.length, initialStorageListeners);
  assert.equal(documentListeners, 2);
  assert.equal(windowListeners, 2);
  let response;
  response = await new Promise(resolve => listeners[0]({ type: config.MSG.PING }, {}, resolve));
  assert.equal(response.ok, true);
  listeners[0]({ type: config.MSG.RESTORE_PAGE }, {}, (value) => { response = value; });
  assert.equal(response.restored, true);
  assert.equal(response.hadTranslation, false);
});
