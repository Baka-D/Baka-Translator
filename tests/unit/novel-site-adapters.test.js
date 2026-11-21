'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const novel = require('../../shared/novel.js');

test('the Syosetu family uses the same chapter and cache format on every subdomain', () => {
  for (const host of ['ncode.syosetu.com', 'novel18.syosetu.com', 'reader.example.syosetu.com']) {
    const chapter = novel.detectChapter(`https://${host}/n0193jx/2/`);
    assert.equal(chapter?.isChapter, true);
    assert.equal(chapter.host, host);
    assert.equal(novel.cacheKeyForChapter(chapter), 'novelCache:syosetu:n0193jx:2');
  }
  assert.equal(novel.detectChapter('https://yomou.syosetu.com/search.php'), null);
  for (const host of ['notsyosetu.com', 'ncode.syosetu.com.example.com', 'syosetu.org.example.com']) {
    assert.equal(novel.isSupportedUrl(`https://${host}`), false);
  }
});

test('Hameln distinguishes chapters from work indexes and uses its own storage keys', () => {
  const chapter = novel.detectChapter('https://syosetu.org/novel/313861/2.html#honbun');
  assert.equal(chapter?.isChapter, true);
  assert.equal(chapter.siteId, 'hameln');
  assert.equal(chapter.chapterOrder, 2);
  assert.equal(chapter.canonicalUrl, 'https://syosetu.org/novel/313861/2.html');
  assert.equal(chapter.workUrl, 'https://syosetu.org/novel/313861/');
  assert.equal(novel.cacheKeyForChapter(chapter), 'novelCache:hameln:313861:2');
  assert.equal(novel.glossaryKeyForWork(chapter), 'novelGlossary:hameln:313861');
  assert.equal(novel.detectChapter(chapter.workUrl)?.isToc, true);
  assert.equal(novel.detectChapter('https://h.syosetu.org/novel/313861/2.html')?.siteId, 'hameln');
  assert.equal(novel.detectChapter('https://syosetu.org/novel/313861/2/'), null);
});

test('Hameln uses chapter navigation and skips links to other works', () => {
  const origin = 'https://syosetu.org';
  const url = `${origin}/novel/313861/2.html`;
  const selectors = {
    '#nextpage a.next_page_link': [{ href: '/novel/123/3.html' }, { href: './3.html' }],
    '#nextpage a[href]': [
      { href: './1.html', textContent: '<< 前の話' },
      { href: './', textContent: '目次' }
    ],
    'a[href]': [{ href: './1.html', textContent: '次の話' }]
  };
  const doc = { querySelectorAll: (selector) => selectors[selector] || [] };
  assert.equal(novel.findNextChapterUrl(doc, url), `${origin}/novel/313861/3.html`);
  assert.equal(novel.findPreviousChapterUrl(doc, url), `${origin}/novel/313861/1.html`);
  delete selectors['#nextpage a.next_page_link'];
  assert.equal(novel.findNextChapterUrl(doc, url), '');
  selectors['#nextpage a[href]'] = [{ href: './3.html', textContent: '次の話 >>' }];
  assert.equal(novel.findNextChapterUrl(doc, url), `${origin}/novel/313861/3.html`);
  assert.equal(novel.findPreviousChapterUrl(doc, url), '');
});

test('the options page can edit the glossary of a Hameln work', () => {
  const options = 'chrome-extension://test-extension/options/options.html';
  const context = vm.createContext({
    DSHT: { novel }, URL,
    chrome: { runtime: { getURL: () => options } },
    validateTargetCode: (targetCode) => targetCode
  });
  vm.runInContext(fs.readFileSync(path.resolve(__dirname, '../../background/worker-novel-storage.js'), 'utf8'), context);
  const { chapter, targetCode } = context.glossaryEditRequest({
    siteId: 'hameln', workId: '313861', targetCode: 'en', action: 'save'
  }, { url: options });
  assert.equal(chapter.isWorkPage, true);
  assert.equal(novel.glossaryKeyForWork(chapter, targetCode), 'novelGlossary:hameln:313861:en');
});
