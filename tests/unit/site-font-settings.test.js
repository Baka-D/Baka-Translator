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

function fontRepairHarness({ reading = false, hiddenReading = false } = {}) {
  const observations = [];
  const attributes = new Map();
  const document = {
    documentElement: { lang: 'ja' },
    adoptedStyleSheets: [],
    fonts: { add() {}, delete() {}, check: () => true },
    defaultView: {
      crypto: { getRandomValues: values => values },
      FontFace: class { async load() {} },
      CSSStyleSheet: class {
        cssRules = [];
        replaceSync() {}
        insertRule(rule) { this.cssRules.push(rule); }
      },
      MutationObserver: class {
        observe(target, options) { observations.push({ target, options }); }
        disconnect() {}
      },
      getComputedStyle: () => ({ content: 'none' })
    },
    createElement(tag) {
      assert.equal(tag, 'canvas');
      return {
        getContext() {
          return {
            canvas: {},
            measureText() {
              const author = this.font.includes('Author');
              const probe = this.font.includes('dsht-measure');
              return { width: author ? (probe ? 30 : 20) : 60 };
            }
          };
        }
      };
    },
    querySelectorAll: () => [anchor],
    createTreeWalker: () => {
      const nodes = [text];
      return { nextNode: () => nodes.shift() || null };
    }
  };
  const rt = { nodeType: 1, matches: selector => selector === 'rt,rp', hasAttribute: () => false };
  const anchor = {
    ownerDocument: document,
    childNodes: [],
    getRootNode: () => document,
    closest: selector => reading && selector.startsWith(':is(') ? anchor : null,
    matches: selector => reading ? false : selector === 'ruby' || selector.startsWith(':not('),
    querySelectorAll: () => [],
    hasAttribute: key => attributes.has(key),
    setAttribute: (key, value) => attributes.set(key, value),
    removeAttribute: key => attributes.delete(key)
  };
  const text = {
    ownerDocument: document, parentElement: anchor, isConnected: true,
    nodeType: 3, nodeValue: '译文'
  };
  anchor.childNodes.push(text);
  if (!reading) anchor.childNodes.push(rt);
  const route = 'https://ncode.syosetu.example/chapter';
  const app = {
    BILINGUAL_ATTR: 'data-dsht-original',
    page: {
      targetCode: 'zh', runId: 1, translatedRoute: route,
      novel: reading ? { siteId: 'syosetu', isChapter: true } : null,
      hiddenRubyReadings: new Set(hiddenReading ? [rt] : [])
    },
    currentRoute: () => route,
    novelUtils: { SITE_ADAPTERS: { syosetu: { chapterRootSelectors: ['article'], titleSelector: 'h1' } } },
    newFilterContext: () => ({}),
    isSkippedParent: () => false,
    getComputedStyleFor: () => ({ fontFamily: 'Author', fontStyle: 'normal', fontWeight: '400' })
  };
  const context = createLocalizedContext({ document, Node: { TEXT_NODE: 3, ELEMENT_NODE: 1 }, NodeFilter: { SHOW_TEXT: 4 } });
  const file = path.join(__dirname, '../../content/content-font.js');
  vm.runInContext(fs.readFileSync(file, 'utf8'), context, { filename: file });
  const font = context.DSHT.contentModules.font(app);
  return { font, text, attributes, document, observations };
}

test('translated ruby bases accept a local font repair when the readings are hidden', async () => {
  const hidden = fontRepairHarness({ hiddenReading: true });
  const visible = fontRepairHarness();
  for (const { font, text } of [hidden, visible]) font.applyTranslatedFont(text, text.nodeValue);
  await new Promise(setImmediate);
  assert.deepEqual([...hidden.attributes.values()], ['l0']);
  assert.equal(hidden.observations.length, 1);
  assert.equal(visible.attributes.size, 0);
});

test('reading-area font repair applies and clears without observing document mutations', async () => {
  const { font, text, attributes, document, observations } = fontRepairHarness({ reading: true });
  font.applyTranslatedFont(text, text.nodeValue);
  await new Promise(setImmediate);
  assert.deepEqual([...attributes.values()], ['r0']);
  assert.equal(document.adoptedStyleSheets.length, 1);
  assert.equal(observations.length, 0);
  font.clearTranslatedFonts();
  assert.equal(attributes.size, 0);
  assert.equal(document.adoptedStyleSheets.length, 0);
});
