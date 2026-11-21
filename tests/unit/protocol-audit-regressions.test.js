'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const billing = require('../../shared/billing.js');
const detect = require('../../shared/detect.js');
const glossary = require('../../shared/glossary.js');
const protocol = require('../../shared/protocol.js');
const text = require('../../shared/text.js');
const usage = require('../../shared/usage.js');

const chair = { source: '椅子', target: '椅子', category: 'item', note: '' };
const alice = { source: 'アリス・ローゼン', target: '爱丽丝·罗森', category: 'character' };
const short = { source: 'アリス', target: '艾莉丝', category: 'character', gender: 'female' };

test('loose JSON balances brackets and prefers a translation map to a prose array', () => {
  const answer = 'Draft ["draft"] for {name}:\n{"s1":"a [\\\"b\\\"] }"}\nDone.';
  assert.deepEqual(protocol.parseTranslationResponse(answer, ['s1']).translations,
    [{ id: 's1', text: 'a ["b"] }' }]);
  const unmatched = 'Prefix [note:\n{"s1":"translated"}\nDone.';
  assert.deepEqual(protocol.parseTranslationResponse(unmatched, ['s1']).translations,
    [{ id: 's1', text: 'translated' }]);
  const list = 'Result:\n[{"id":"s1","text":"translated"}]\nDone.';
  assert.deepEqual(protocol.parseTranslationResponse(list, ['s1']).translations,
    [{ id: 's1', text: 'translated' }]);
});

test('a JSON fence inside commentary identifies the payload', () => {
  const answer = 'Example: {"s1":"draft"}\n```json\n["translated"]\n```\nDone.';
  assert.deepEqual(protocol.parseTranslationResponse(answer, ['s1']).translations,
    [{ id: 's1', text: 'translated' }]);
});

test('translation response aliases skip empty values, and extracted terms require text', () => {
  assert.deepEqual(
    protocol.parseTranslationResponse({ s1: { text: ' ', translation: 'translated' } }, ['s1']).translations,
    [{ id: 's1', text: 'translated' }]
  );
  const terms = protocol.parseTermResponse({ terms: [
    { source: { name: 'Alice' }, target: '爱丽丝', category: 'character' },
    { source: 'Bob', target: ['鲍勃'], category: 'character' },
    { source: '', term: 'Alice', translation: '爱丽丝', note: 'a'.repeat(159) + '𠮷' }
  ] });
  assert.deepEqual(terms.terms, [{
    source: 'Alice', target: '爱丽丝', category: 'term', note: 'a'.repeat(159)
  }]);
});

test('null cache aliases fall through to nested details while zero remains authoritative', () => {
  const raw = { prompt_tokens: 100, prompt_cache_hit_tokens: null,
    prompt_tokens_details: { cached_tokens: null }, input_tokens_details: { cached_tokens: 80 } };
  assert.equal(billing.normalizeBillingUsage(raw).cachedTokens, 80);
  assert.equal(usage.normalizeApiUsage(raw).cachedTokens, 80);
  raw.prompt_cache_hit_tokens = 0;
  assert.equal(billing.normalizeBillingUsage(raw).cachedTokens, 0);
  assert.equal(usage.normalizeApiUsage(raw).cachedTokens, 0);
});

test('Japanese punctuation does not turn Chinese names into Japanese text', () => {
  for (const text of ['爱丽丝・冯・罗泽', '爱丽丝゠罗泽']) {
    const result = detect.detectLanguage(text);
    assert.equal(result.code, 'zh');
    assert.equal(result.counts.kana, 0);
  }
  assert.equal(detect.detectLanguage('アリス・ローゼン').code, 'ja');
});

test('tidying keeps a known gender regardless of the order in a merge', () => {
  const unspecified = { ...alice, gender: 'none' };
  for (const terms of [[unspecified, short], [short, unspecified]]) {
    const change = { action: 'merge', terms, targets: terms.map((term) => term.target) };
    assert.equal(glossary.applyGlossaryTidy(terms, [change]).terms[0].gender, 'female');
  }
});

test('undo restores touched spellings and preserves separately translated untouched spellings', () => {
  const original = [
    { source: 'ABC', target: '甲' }, chair, { source: 'ａｂｃ', target: '乙' }
  ];
  const current = [
    { source: 'ABC', target: '丙' }, { source: 'ａｂｃ', target: '丁' }, { source: 'abc', target: '戊' }
  ];
  const restored = glossary.undoneTerms({ terms: original, touched: [chair.source] }, current);
  assert.deepEqual(restored.map(({ source, target }) => [source, target]),
    [['ABC', '丙'], [chair.source, chair.target], ['ａｂｃ', '丁'], ['abc', '戊']]);
});

test('context and excerpts omit partial supplementary characters', () => {
  assert.equal(text.precedingText(['𠮷AB'], 1, (value) => value, 3), 'AB');
  assert.deepEqual(glossary.termExcerpts('X', ['𠮷X𠮷'], 1, 1), ['X']);
});

test('request glossary skips empty sources and stops once the list is full', () => {
  let scanned = 0;
  const terms = Array.from({ length: glossary.MAX_REQUEST_TERMS + 3 }, () => ({
    get source() {
      scanned += 1;
      return '名';
    }
  }));
  assert.deepEqual(glossary.requestGlossary(terms, [' '], {}), []);
  assert.equal(scanned, 0);
  assert.deepEqual(
    glossary.requestGlossary(terms, ['名'], { previousChapter: '名' }),
    terms.slice(0, glossary.MAX_REQUEST_TERMS)
  );
  assert.equal(scanned, glossary.MAX_REQUEST_TERMS);
});
