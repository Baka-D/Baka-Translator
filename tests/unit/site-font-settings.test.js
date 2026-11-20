'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createLocalizedContext, installI18n } = require('../helpers/i18n');
const config = require('../../shared/config');

test('a live font preference supersedes a pending settings read without invalidating translations', () => {
  const host = 'reader.example';
  let onChange;
  const applied = [];
  const context = createLocalizedContext({
    location: { hostname: host },
    chrome: { storage: { onChanged: { addListener(fn) { onChange = fn; } } } }
  });
  const file = path.join(__dirname, '../../content/content-runtime.js');
  vm.runInContext(fs.readFileSync(file, 'utf8'), context, { filename: file });
  const runtime = context.DSHT.contentModules.runtime({ config, setFontRepairEnabled: value => applied.push(value) });
  const legacy = { siteSettings: { [host]: true } };
  const disabled = { siteSettings: { [host]: { polish: true, repairFonts: false } } };
  assert.equal(runtime.siteFeatures(legacy).repairFonts, true);
  assert.equal(runtime.siteFeatures(legacy).polish, true);
  assert.equal(runtime.siteFeatures(disabled).repairFonts, false);
  assert.equal(runtime.translationKey(legacy, 'zh'), runtime.translationKey(disabled, 'zh'));

  runtime.bindFontRepairChanges();
  onChange({ siteSettings: { newValue: disabled.siteSettings } }, 'sync');
  onChange({ targetLang: { newValue: 'ru' } }, 'local');
  assert.deepEqual(applied, []);
  onChange({ siteSettings: { newValue: disabled.siteSettings } }, 'local');
  assert.equal(runtime.siteFeatures(legacy).repairFonts, false);
  onChange({ siteSettings: { oldValue: disabled.siteSettings } }, 'local');
  assert.equal(runtime.siteFeatures(disabled).repairFonts, true);
  assert.deepEqual(applied, [false, true]);
});

test('the popup remembers font repair per host and preserves legacy and unrelated settings', async () => {
  const host = 'reader.example';
  const secondHost = 'other.example';
  const previous = { presetId: 'academic', pretranslate: true, repairFonts: false };
  let stored = { [host]: true, [secondHost]: previous };
  global.document = { getElementById() { return {}; } };
  global.DSHT = { config: require('../../shared/config'), languages: require('../../shared/languages') };
  global.chrome = { storage: { local: {
    async get() { return { siteSettings: structuredClone(stored) }; },
    async set({ siteSettings }) { stored = structuredClone(siteSettings); }
  } } };
  installI18n();
  const { state, ui } = await import('../../popup/popup-state.mjs');
  const { renderSiteToggles, saveSiteFlag, readSiteSettings } = await import('../../popup/popup-site.mjs');
  Object.assign(state, { loading: false, host, siteSettings: await readSiteSettings() });
  const toggle = ui.repairFontsToggle;
  renderSiteToggles();
  assert.equal(toggle.checked, true);
  assert.equal(toggle.disabled, false);

  await saveSiteFlag(host, { repairFonts: false });
  renderSiteToggles();
  assert.equal(toggle.checked, false);
  assert.deepEqual(stored[host], { polish: true, pretranslate: false, repairFonts: false });
  assert.deepEqual(stored[secondHost], previous);

  state.host = secondHost;
  state.siteSettings = await readSiteSettings();
  renderSiteToggles();
  assert.equal(toggle.checked, false);
  await saveSiteFlag(secondHost, { repairFonts: true });
  renderSiteToggles();
  assert.equal(toggle.checked, true);
  assert.deepEqual(stored[secondHost], { ...previous, polish: false, repairFonts: true });
  assert.equal(stored[host].repairFonts, false);

  state.host = 'new.example';
  renderSiteToggles();
  assert.equal(toggle.checked, true);
  state.host = '';
  renderSiteToggles();
  assert.equal(toggle.disabled, true);
});
