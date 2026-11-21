'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');
const novel = require('../../shared/novel.js');

const source = fs.readFileSync(path.join(__dirname, '../../background/worker-novel-storage.js'), 'utf8');
const optionsUrl = 'chrome-extension://test-extension/options/options.html';
const glossaryKey = 'novelGlossary:syosetu:n0193jx:en';
const metaKey = 'novelMeta:syosetu:n0193jx:en';
const tidyKey = 'novelGlossaryTidy:syosetu:n0193jx:en';
const cacheKey = 'novelCache:syosetu:n0193jx:2';
const legacyKey = (key) => key.replace('n0193jx', 'N0193Jx');

function loadWorker(store, { getKeys = true } = {}) {
  const reads = [];
  const local = {
    async get(keys) {
      reads.push(keys);
      return structuredClone(Object.fromEntries(
        (keys === null ? Object.keys(store) : [keys].flat())
          .filter((key) => Object.hasOwn(store, key)).map((key) => [key, store[key]])
      ));
    },
    async set(values) { Object.assign(store, structuredClone(values)); },
    async remove(keys) { for (const key of keys) delete store[key]; }
  };
  if (getKeys) local.getKeys = async () => Object.keys(store);
  const context = vm.createContext({
    DSHT: { novel }, URL,
    chrome: { storage: { local }, runtime: { getURL: () => optionsUrl } },
    validateTargetCode: (code) => code
  });
  vm.runInContext(source, context);
  return { context, local, reads };
}

test('migration consolidates uppercase records, keeps different glossary translations, and runs once', async () => {
  const legacyTranslation = { source: 'アリス', target: 'Alyce' };
  const store = {
    [glossaryKey]: [{ source: 'アリス', target: 'Alice' }],
    [legacyKey(glossaryKey)]: [legacyTranslation],
    [metaKey]: { chapterIds: ['3'], extractedChapterIds: ['3'], chaptersSinceTidy: 1 },
    [legacyKey(metaKey)]: { workId: 'N0193Jx', title: 'My title', titleManual: true,
      chapterIds: ['1', '2'], extractedChapterIds: ['2'], chaptersSinceTidy: 2 },
    [legacyKey(tidyKey)]: { tidiedAt: 4, terms: [legacyTranslation] },
    [legacyKey(cacheKey)]: { targetCode: 'en', createdAt: 10 }
  };
  const h = loadWorker(store);
  await Promise.all([h.context.ensureNovelNcodes(), h.context.ensureNovelNcodes()]);
  assert.deepEqual(store[glossaryKey].map(({ target }) => target), ['Alice', 'Alyce']);
  assert.deepEqual(store[metaKey], {
    siteId: 'syosetu', workId: 'n0193jx', title: 'My title', titleManual: true,
    chapterIds: ['1', '2', '3'], extractedChapterIds: ['2', '3'], chaptersSinceTidy: 2
  });
  assert.equal(store[tidyKey].tidiedAt, 4);
  assert.equal(store[cacheKey].targetCode, 'en');
  assert.equal(store[legacyKey(cacheKey)], undefined);
  assert.equal(h.reads.includes(null), false);
  const restarted = loadWorker(store);
  restarted.local.getKeys = () => assert.fail('migration must not scan keys again after a worker restart');
  await restarted.context.ensureNovelNcodes();
});

test('migration retries a failed write and preserves an existing cache for a different target', async () => {
  const store = {
    [cacheKey]: { targetCode: 'en' },
    [legacyKey(cacheKey)]: { targetCode: 'zh' },
    [legacyKey(glossaryKey)]: [{ source: 'アリス', target: 'Alice' }]
  };
  const h = loadWorker(store, { getKeys: false });
  const set = h.local.set;
  h.local.set = () => { throw new Error('Storage unavailable'); };
  await assert.rejects(h.context.ensureNovelNcodes(), /Storage unavailable/);
  assert.ok(store[legacyKey(glossaryKey)], 'failed migration must preserve the original data');
  h.local.set = set;
  await h.context.ensureNovelNcodes();
  assert.ok(store[glossaryKey]);
  assert.equal(store[legacyKey(glossaryKey)], undefined);
  assert.equal(store[cacheKey].targetCode, 'en');
  assert.equal(store[legacyKey(cacheKey)].targetCode, 'zh');
});

test('clearing a glossary retains the work and reading history and resets extraction bookkeeping', async () => {
  const store = {
    [glossaryKey]: [{ source: 'Chapter term', target: 'Saved term' }],
    [tidyKey]: { tidiedAt: 2 },
    [metaKey]: { siteId: 'syosetu', workId: 'n0193jx', title: 'My title', titleManual: true,
      chapterIds: ['1', '2'], extractedChapterIds: ['1', '2'], chaptersSinceTidy: 2 },
    'novelGlossary:syosetu:n0193jx': [{ source: 'Other language', target: '其他语言' }]
  };
  const h = loadWorker(store);
  const result = await h.context.handleGlossaryEdit({
    action: 'clear', siteId: 'syosetu', workId: 'n0193jx', targetCode: 'en'
  }, { url: optionsUrl });
  assert.equal(result.cleared, true);
  assert.equal(store[glossaryKey], undefined);
  assert.equal(store[tidyKey], undefined);
  assert.ok(store['novelGlossary:syosetu:n0193jx']);
  assert.deepEqual(store[metaKey], {
    siteId: 'syosetu', workId: 'n0193jx', title: 'My title', titleManual: true,
    chapterIds: ['1', '2'], extractedChapterIds: [], chaptersSinceTidy: 0
  });
});

test('retrying after legacy-key deletion fails does not duplicate translations', async () => {
  const store = {
    [glossaryKey]: [{ source: 'アリス', target: 'Alice' }],
    [legacyKey(glossaryKey)]: [{ source: 'アリス', target: 'Alyce' }]
  };
  const h = loadWorker(store);
  const remove = h.local.remove;
  h.local.remove = async () => { throw new Error('Storage unavailable'); };
  await assert.rejects(h.context.ensureNovelNcodes(), /Storage unavailable/);
  assert.ok(store[legacyKey(glossaryKey)]);
  h.local.remove = remove;
  await h.context.ensureNovelNcodes();
  assert.deepEqual(store[glossaryKey].map(({ target }) => target), ['Alice', 'Alyce']);
});

test('failed glossary clearing leaves existing terms and metadata in place', async () => {
  const terms = [{ source: 'Chapter term', target: 'Saved term' }];
  const meta = { title: 'My title', chapterIds: ['1'], extractedChapterIds: ['1'], chaptersSinceTidy: 1 };
  const store = { [glossaryKey]: terms, [metaKey]: meta };
  const h = loadWorker(store);
  h.local.remove = async () => { throw new Error('Storage unavailable'); };
  await assert.rejects(h.context.handleGlossaryEdit({
    action: 'clear', siteId: 'syosetu', workId: 'n0193jx', targetCode: 'en'
  }, { url: optionsUrl }), /Storage unavailable/);
  assert.deepEqual(store[glossaryKey], terms);
  assert.deepEqual(store[metaKey], meta);
});
