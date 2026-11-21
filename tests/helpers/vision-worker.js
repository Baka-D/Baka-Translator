const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createLocalizedContext } = require('./i18n');
const api = require('../../background/api.js');
const root = path.resolve(__dirname, '../..');
const extensionUrl = 'chrome-extension://vision-test/';

function loadVisionWorker(overrides = {}, apiStub = {}, options = {}) {
  const stored = { apiKey: '', providerKeys: { openai: 'test-key' },
    translationModelId: 'gpt-6.1-terra', translationEffortLevel: 'none', ...overrides };
  const storageListeners = [];
  const installListeners = [];
  const menuUpdates = [];
  let captures = 0;
  let contentMessages = 0;
  const listener = { addListener() {}, removeListener() {} };
  const context = createLocalizedContext({
    URL, AbortController, setTimeout, clearTimeout, setInterval, clearInterval,
    fetch: async (url) => ({ ok: true,
      json: async () => JSON.parse(fs.readFileSync(path.join(root, url.slice(extensionUrl.length)), 'utf8')) }),
    chrome: {
      runtime: { getURL: (file) => extensionUrl + file, onMessage: listener, onConnect: listener,
        onInstalled: { addListener: (callback) => installListeners.push(callback) },
        onStartup: listener, getPlatformInfo: (callback) => callback() },
      storage: { onChanged: { addListener: (callback) => storageListeners.push(callback) }, local: {
        async get(keys) {
          const list = keys === null ? Object.keys(stored) : Array.isArray(keys) ? keys : [keys];
          return Object.fromEntries(list.filter((key) => Object.hasOwn(stored, key)).map((key) => [key, structuredClone(stored[key])]));
        },
        async set(values) {
          const changes = Object.fromEntries(Object.entries(values).map(([key, value]) => [key, {
            oldValue: structuredClone(stored[key]), newValue: value
          }]));
          Object.assign(stored, structuredClone(values));
          for (const callback of storageListeners) callback(changes, 'local');
        }
      } },
      contextMenus: { onClicked: listener, removeAll: (callback) => callback(), create: (_item, callback) => callback(),
        update: (id, update, callback) => { menuUpdates.push({ id, ...update }); callback(); }
      },
      commands: { onCommand: listener }, tabs: { onUpdated: listener,
        onActivated: listener, onRemoved: listener, onReplaced: listener,
        onDetached: listener, onAttached: listener,
        get: async () => ({ id: 1, active: true, windowId: 3, url: 'https://example.com/' }),
        captureVisibleTab: (_windowId, _options, callback) => { captures += 1; callback('data:image/png;base64,AA=='); },
        sendMessage: async () => { contentMessages += 1; return { ok: true }; }
      },
      scripting: { executeScript: async () => [{ frameId: 0, documentId: 'doc-1', result: 'https://example.com/' }] }
    }
  }, options);
  context.importScripts = (...urls) => {
    for (const url of urls) {
      const file = url.slice(extensionUrl.length);
      if (file === 'background/api.js') context.DSHT.api = { ...api, ...apiStub };
      else vm.runInContext(fs.readFileSync(path.join(root, file), 'utf8'), context, { filename: file });
    }
  };
  vm.runInContext(fs.readFileSync(path.join(root, 'background/service-worker.js'), 'utf8'), context);
  return { context, stored, menuUpdates,
    install() { for (const callback of installListeners) callback({ reason: 'install' }); },
    get captures() { return captures; }, get contentMessages() { return contentMessages; } };
}

module.exports = { loadVisionWorker, extensionUrl };
