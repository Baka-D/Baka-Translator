'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createLocalizedContext } = require('../helpers/i18n');

const root = path.resolve(__dirname, '../..');
const extensionUrl = 'chrome-extension://pretranslation-settings-test/';
const currentUrl = 'https://ncode.syosetu.com/n0193jx/1/';
const chapterUrl = 'https://ncode.syosetu.com/n0193jx/2/';
const sender = { tab: { id: 7, url: currentUrl } };
const tick = () => new Promise(setImmediate);

async function until(predicate) {
  for (let i = 0; i < 100; i += 1) {
    if (await predicate()) return;
    await tick();
  }
  assert.fail('pretranslation did not reach the expected state');
}

function loadWorker() {
  const stored = {
    providerKeys: { openai: 'test-key-must-stay-private' },
    modelId: 'deepseek-flash', effortLevel: 'none', polishEffortLevel: '', promptOverrides: {},
    translationModelId: 'gpt-6.1-terra', translationEffortLevel: 'none',
    polishModelId: 'gpt-6.1-terra', presetId: 'general'
  };
  const calls = [], releases = [];
  const listener = { addListener() {}, removeListener() {} };
  const apiStub = { ApiError: class ApiError extends Error {} };
  for (const kind of ['translateSegments', 'polishSegments']) {
    apiStub[kind] = async (options) => {
      calls.push({ kind, model: options.model.id, preset: options.preset.id });
      if (kind === 'translateSegments' && calls.length <= 3) {
        await new Promise((resolve) => releases.push(resolve));
      }
      return {
        translations: options.segments.map((segment) => ({
          id: segment.id, text: `${options.model.id}:${options.preset.id}:${segment.text || segment.original}`
        })),
        missing: []
      };
    };
  }
  const context = createLocalizedContext({
    URL, AbortController, setTimeout, clearTimeout, setInterval, clearInterval,
    location: { hostname: new URL(currentUrl).hostname },
    fetch: async (url) => {
      assert.ok(url.startsWith(extensionUrl), 'never contact a real model provider');
      return { ok: true, json: async () => JSON.parse(fs.readFileSync(path.join(root, url.slice(extensionUrl.length)), 'utf8')) };
    },
    chrome: {
      runtime: { getURL: (file) => extensionUrl + file, getPlatformInfo: (callback) => callback(),
        onMessage: listener, onConnect: listener, onInstalled: listener, onStartup: listener },
      storage: { local: {
        async get(keys, callback) {
          const list = keys === null ? Object.keys(stored) : Array.isArray(keys) ? keys : [keys];
          const values = structuredClone(Object.fromEntries(list.filter((key) => Object.hasOwn(stored, key)).map((key) => [key, stored[key]])));
          callback?.(values);
          return values;
        },
        async set(values) { Object.assign(stored, structuredClone(values)); },
        async remove(keys) { for (const key of Array.isArray(keys) ? keys : [keys]) delete stored[key]; }
      } },
      contextMenus: { onClicked: listener, removeAll: (callback) => callback(), create: (_item, callback) => callback() },
      commands: { onCommand: listener }, tabs: { onUpdated: listener, onRemoved: listener }
    }
  });
  context.importScripts = (...urls) => {
    for (const url of urls) {
      const file = url.slice(extensionUrl.length);
      if (file === 'background/api.js') context.DSHT.api = apiStub;
      else vm.runInContext(fs.readFileSync(path.join(root, file), 'utf8'), context, { filename: file });
    }
  };
  vm.runInContext(fs.readFileSync(path.join(root, 'background/service-worker.js'), 'utf8'), context);
  vm.runInContext(fs.readFileSync(path.join(root, 'content/content-runtime.js'), 'utf8'), context);
  const config = context.DSHT.config;
  const content = context.DSHT.contentModules.runtime({ config, languages: context.DSHT.languages,
    MSG: config.MSG, page: {}, overlay: {} });
  const key = async () => content.translationKey(await content.readSettings(), 'zh');
  const request = async (overrides = {}) => ({ chapterUrl, targetCode: 'zh', polish: true,
    translationKey: await key(), segments: Array.from({ length: 240 }, (_, i) => ({ id: `s${i}`, text: `source ${i}` })), ...overrides });
  const get = () => context.getPretranslation({ chapterUrl, targetCode: 'zh' }, sender);
  return { context, stored, calls, releases, key, request, get,
    cache: () => Object.entries(stored).find(([name]) => name.startsWith('novelCache:'))?.[1] };
}

test('a chapter keeps its translation, polish and preset settings when selections change mid-job', async () => {
  const worker = loadWorker();
  const message = await worker.request();
  const response = await worker.context.handlePretranslateChapter(message, sender);
  assert.equal(JSON.stringify(response).includes('test-key-must-stay-private'), false);
  await until(() => worker.releases.length === 3);
  await worker.context.chrome.storage.local.set({ translationModelId: 'gpt-6.1-sol',
    polishModelId: 'gpt-6.1-sol', presetId: 'academic' });
  worker.releases.splice(0).forEach((release) => release());
  await until(async () => (await worker.get()).status !== 'running');
  assert.equal((await worker.get()).status, 'ready');
  assert.ok(worker.calls.some((call) => call.kind === 'polishSegments'));
  assert.ok(worker.calls.every((call) => call.model === 'gpt-6.1-terra' && call.preset === 'general'));
  assert.equal(worker.cache().translationKey, message.translationKey);
  assert.ok(worker.cache().entries.every((entry) => entry.translation.startsWith('gpt-6.1-terra:general:')));
});

test('a stale content settings key is rejected before translation or cache writes', async () => {
  const worker = loadWorker();
  const message = await worker.request();
  await worker.context.chrome.storage.local.set({ translationModelId: 'gpt-6.1-sol' });
  await worker.context.handlePretranslateChapter(message, sender);
  await until(async () => (await worker.get()).status !== 'running' || worker.calls.length > 0);
  const snapshot = await worker.get();
  worker.releases.splice(0).forEach((release) => release());
  assert.equal(snapshot.status, 'error');
  assert.equal(snapshot.error.code, 'SETTINGS_CHANGED');
  assert.equal(worker.calls.length, 0);
  assert.equal(worker.cache(), undefined);
});

test('a new settings key supersedes the old job for the same chapter and language', async () => {
  const worker = loadWorker();
  await worker.context.handlePretranslateChapter(await worker.request(), sender);
  await until(() => worker.releases.length === 3);
  await worker.context.chrome.storage.local.set({ translationModelId: 'gpt-6.1-sol',
    polishModelId: 'gpt-6.1-sol', presetId: 'academic' });
  const message = await worker.request();
  await worker.context.handlePretranslateChapter(message, sender);
  worker.releases.splice(0).forEach((release) => release());
  await until(async () => (await worker.get()).status !== 'running');
  assert.equal((await worker.get()).status, 'ready');
  assert.equal(worker.cache().translationKey, message.translationKey);
  assert.ok(worker.cache().entries.every((entry) => entry.translation.startsWith('gpt-6.1-sol:academic:')));
});

test('an unavailable polish model keeps the completed first draft', async () => {
  const worker = loadWorker();
  await worker.context.chrome.storage.local.set({ polishModelId: 'claude-opus-5-5' });
  await worker.context.handlePretranslateChapter(await worker.request(), sender);
  await until(() => worker.releases.length === 3);
  worker.releases.splice(0).forEach((release) => release());
  await until(async () => (await worker.get()).status !== 'running');
  assert.equal((await worker.get()).status, 'ready');
  assert.equal(worker.cache().polished, false);
  assert.equal(worker.cache().entries.length, 240);
  assert.match((await worker.get()).note, /初译已缓存/);
});

test('a complete cache from older settings is replaced using the current settings key', async () => {
  const worker = loadWorker();
  const message = await worker.request({ polish: false });
  const novel = worker.context.DSHT.novel;
  const cacheKey = novel.cacheKeyForChapter(novel.detectChapter(chapterUrl));
  worker.stored[cacheKey] = { chapterUrl, targetCode: 'zh', translationKey: 'old', createdAt: Date.now(),
    entries: message.segments.map((segment) => ({ source: segment.text, translation: 'Old' })) };
  await worker.context.handlePretranslateChapter(message, sender);
  await until(() => worker.releases.length === 3);
  worker.releases.splice(0).forEach((release) => release());
  await until(async () => (await worker.get()).status !== 'running');
  assert.equal((await worker.get()).status, 'ready');
  assert.equal(worker.cache().translationKey, message.translationKey);
  assert.ok(worker.cache().entries.every((entry) => entry.translation.startsWith('gpt-6.1-terra:general:')));
});
