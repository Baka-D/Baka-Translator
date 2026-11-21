'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { installI18n } = require('../helpers/i18n');
const { readFile } = require('node:fs/promises');
const path = require('node:path');
const config = require('../../shared/config');
require('../../shared/languages');
const models = require('../../shared/models');
installI18n();

const elements = new Map();
function element() {
  return {
    value: '', textContent: '', dataset: {}, disabled: false, isConnected: true, children: [],
    classList: { add() {}, remove() {} },
    setAttribute() {}, removeAttribute() {}, addEventListener() {},
    append(...children) { this.children.push(...children); },
    appendChild(child) { this.children.push(child); },
    replaceChildren(...children) { this.children = children; },
    prepend(child) { this.children.unshift(child); },
    querySelectorAll() { return []; }, contains() { return false; },
    focus() { document.activeElement = this; }
  };
}
global.document = {
  body: {},
  getElementById(id) {
    if (!elements.has(id)) elements.set(id, element());
    return elements.get(id);
  },
  createElement: element
};
global.window = { setTimeout: () => 1, clearTimeout() {} };

const writes = [];
const stored = {};
const read = async (keys) => Object.fromEntries(keys
  .filter((key) => key in stored).map((key) => [key, structuredClone(stored[key])]));
const write = async (update) => {
  writes.push(structuredClone(update));
  Object.assign(stored, structuredClone(update));
};
global.chrome = { runtime: {}, storage: { local: { get: read, set: write } } };

const custom = { id: 'custom', name: 'Gateway', endpoint: 'https://gateway.example/v1', model: 'gateway-model' };

async function setupProvider() {
  const { state, ui } = await import('../../options/context.mjs');
  const { applyCustomProviders } = await import('../../options/model-selection.mjs');
  const { selectProvider } = await import('../../options/providers.mjs');
  for (const key of Object.keys(stored)) delete stored[key];
  stored.customProviders = [custom];
  chrome.storage.local.get = read;
  chrome.storage.local.set = write;
  writes.length = 0;
  const baseRegistry = await models.loadRegistryFiles(
    async (file) => JSON.parse(await readFile(path.resolve(__dirname, '../..', file), 'utf8')),
    config.MODEL_REGISTRY_PATH
  );
  Object.assign(state, {
    baseRegistry, providerDraft: false, shownProviderId: null, customProviders: [custom],
    userModels: { custom: ['manual'] }, storedTranslationModel: true, modelId: 'deepseek-flash',
    staleModelId: '', polishModelIdRaw: '', providerKeys: {}, confirmDeleteProvider: '',
    busy: false, customBusy: false
  });
  document.activeElement = document.body;
  applyCustomProviders();
  selectProvider('custom');
  return { state, ui };
}
const tick = () => new Promise(setImmediate);

test('provider edits and key requests exclude each other while the model list stays mounted', async () => {
  const { state, ui } = await setupProvider();
  const { handleTestConnection } = await import('../../options/keys.mjs');
  const { handleDeleteProviderClick } = await import('../../options/custom-provider.mjs');
  let finishRequest;
  chrome.runtime.sendMessage = () => new Promise((resolve) => { finishRequest = resolve; });
  const previousRow = ui.providerModelList.children.at(-1);
  const pendingRequest = handleTestConnection();
  assert.equal(ui.saveCustomProviderButton.disabled, true);
  assert.equal(ui.deleteProviderButton.disabled, true);
  assert.equal(ui.reloadModelsButton.disabled, true);
  assert.equal(ui.providerModelList.children.at(-1), previousRow);
  assert.equal(previousRow.children[1].disabled, true);
  await handleDeleteProviderClick();
  assert.equal(state.confirmDeleteProvider, '');
  finishRequest({ ok: true });
  await pendingRequest;
  assert.equal(previousRow.children[1].disabled, false);

  const originalGet = chrome.storage.local.get;
  let releaseDelete;
  chrome.storage.local.get = async (keys) => {
    await new Promise((resolve) => { releaseDelete = resolve; });
    return originalGet(keys);
  };
  const pendingDelete = handleDeleteProviderClick();
  assert.equal(ui.testConnectionButton.disabled, true);
  assert.equal(ui.apiKeyInput.disabled, true);
  await handleDeleteProviderClick();
  await tick();
  releaseDelete();
  await pendingDelete;
  chrome.storage.local.get = originalGet;
  assert.equal(state.confirmDeleteProvider, 'custom', 'one pending click cannot also confirm deletion');
});

test('a saved key cancels a clear confirmation and rejects invalid custom header characters', async () => {
  const { state, ui } = await setupProvider();
  const { handleClearKeyClick, handleSaveKey, validateProviderKey } = await import('../../options/keys.mjs');
  state.providerKeys = { custom: 'previous-key' };
  const valid = { custom: true, id: 'custom', apiKeyRequired: false };
  assert.equal(validateProviderKey(valid, 'abc\u0000def').ok, false);
  assert.equal(validateProviderKey(valid, '密钥').ok, false);
  assert.equal(validateProviderKey(valid, 'key:here').ok, true);
  handleClearKeyClick();
  assert.equal(state.confirmClear, 'custom');
  ui.apiKeyInput.value = 'replacement-key';
  await handleSaveKey();
  assert.equal(state.confirmClear, false);
  assert.equal(state.providerKeys.custom, 'replacement-key');
  const beforeConfirm = writes.length;
  handleClearKeyClick();
  assert.equal(writes.length, beforeConfirm);
});

test('discovery cannot recreate models for a provider deleted during the API request', async () => {
  const { state } = await setupProvider();
  const { handleFetchModels } = await import('../../options/provider-models.mjs');
  let finishRequest;
  chrome.runtime.sendMessage = () => new Promise((resolve) => { finishRequest = resolve; });
  const previousWrites = writes.length;
  const pendingRequest = handleFetchModels();
  stored.customProviders = [];
  finishRequest({ ok: true, models: ['unused-model'] });
  await pendingRequest;
  assert.equal(writes.length, previousWrites);
  assert.equal(state.busy, false);
});

test('restoring a missing custom model restores its selection and saved effort', async () => {
  const { state, ui } = await setupProvider();
  const { applyCustomProviders, applyResolvedModel } = await import('../../options/model-selection.mjs');
  const { persistDefaultsIfMissing } = await import('../../options/storage.mjs');
  state.registry = null;
  applyResolvedModel();
  assert.equal(ui.polishEffortSelect.disabled, true);
  Object.assign(state, {
    storedTranslationModel: false, storedTranslationEffort: false, storedPolishModel: true,
    storedPolishEffort: true, storedPresetId: 'general',
    customProviders: [], staleModelId: '', modelId: 'custom-model', effortLevel: 'high',
    userModels: {}, providerDraft: false, polishModelIdRaw: ''
  });
  applyCustomProviders();
  applyResolvedModel();
  assert.equal(state.staleModelId, 'custom-model');
  assert.equal(state.effortLevel, 'high');
  assert.equal(ui.effortSelect.disabled, true);
  assert.equal(ui.polishEffortSelect.disabled, false);
  await persistDefaultsIfMissing();
  assert.equal(writes.length, 0);
  state.customProviders = [{ id: 'custom', name: 'Gateway', endpoint: 'https://gateway.example/v1', model: 'restored' }];
  applyCustomProviders();
  applyResolvedModel();
  assert.equal(state.modelId, 'custom-model');
  assert.equal(state.staleModelId, '');
  assert.equal(ui.modelSelect.value, 'custom-model');
  assert.equal(state.effortLevel, 'high');
});

test('Popup and Options merge site changes and preserve the last persisted value on failure', async () => {
  const { ui, state } = await import('../../options/context.mjs');
  const { saveSiteSettings, normalizeSiteHost } = await import('../../options/sites.mjs');
  const { saveSiteFlag } = await import('../../popup/popup-site.mjs');
  const { patchSiteSettings } = await import('../../shared/site-settings.mjs');
  stored.siteSettings = { 'example.com': { polish: true, presetId: 'academic' } };
  assert.deepEqual(await Promise.all([
    saveSiteFlag('example.com', { repairFonts: false }),
    saveSiteSettings('example.com', (previous) => patchSiteSettings(previous, { pretranslate: true }, ['presetId'])),
    saveSiteSettings('another.example', (previous) => patchSiteSettings(previous, { polish: true }))
  ]), [true, true, true]);
  assert.deepEqual(stored.siteSettings, {
    'example.com': { polish: true, pretranslate: true, repairFonts: false },
    'another.example': { polish: true, pretranslate: false }
  });

  chrome.storage.local.set = async () => { throw new Error('Write failed'); };
  try {
    ui.siteList.children.length = 0;
    const saved = await saveSiteSettings('example.com', (previous) => patchSiteSettings(previous, { polish: false }));
    assert.equal(saved, false);
    assert.deepEqual(state.siteSettings, stored.siteSettings);
    const row = ui.siteList.children.find((item) => item.dataset.host === 'example.com');
    assert.equal(row.children[2].children[0].checked, true);
    assert.equal(ui.siteFeedback.dataset.tone, 'error');
  } finally {
    chrome.storage.local.set = write;
  }
  assert.deepEqual(normalizeSiteHost('http://[::1]:8080/path'), { ok: true, host: '[::1]' });
  assert.equal(normalizeSiteHost('999.999.4.1').ok, false);
});

test('resetting usage returns keyboard focus to the confirmed action', async () => {
  const { ui } = await import('../../options/context.mjs');
  const { handleResetUsage } = await import('../../options/settings.mjs');
  ui.resetUsageButton.focus();
  let finish;
  chrome.runtime.sendMessage = () => new Promise((resolve) => { finish = resolve; });
  const pending = handleResetUsage();
  assert.equal(ui.resetUsageButton.disabled, true);
  document.activeElement = document.body;
  finish({ ok: true, usage: {} });
  await pending;
  assert.equal(ui.resetUsageButton.disabled, false);
  assert.equal(document.activeElement, ui.resetUsageButton);
});
