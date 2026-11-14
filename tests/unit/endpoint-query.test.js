'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const models = require('../../shared/models.js');
const api = require('../../background/api.js');

const cases = [
  ['literal slash', 'https://gateway.example/v1?path=folder/', '/v1', '?path=folder/'],
  ['encoded slash', 'https://gateway.example/v1?path=folder%2F', '/v1', '?path=folder%2F'],
  ['root', 'https://gateway.example?path=folder/', '', '?path=folder/'],
  ['nested path', 'https://gateway.example/proxy/v1///?path=folder/', '/proxy/v1', '?path=folder/'],
  ['multiple query values', 'https://gateway.example/v1?mode=plain&path=folder/', '/v1', '?mode=plain&path=folder/'],
  ['slash before another value', 'https://gateway.example/v1?path=folder/&mode=plain', '/v1', '?path=folder/&mode=plain'],
  ['completion path and fragment', 'https://gateway.example/v1/chat/completions/?path=folder//#section', '/v1', '?path=folder//']
];

for (const [name, input, pathname, query] of cases) {
  test(`endpoint normalization and joining preserve ${name}`, () => {
    const normalized = `https://gateway.example${pathname || '/'}${query}`;
    assert.equal(models.normalizeEndpoint(input), normalized);
    assert.equal(models.normalizeEndpoint(normalized), normalized, 'normalization is idempotent');
    for (const suffix of ['/chat/completions', '/models']) {
      assert.equal(models.joinEndpoint(input, suffix), `https://gateway.example${pathname}${suffix}${query}`);
    }
  });
}

test('endpoints without queries keep their existing root and completion normalization', () => {
  for (const input of ['https://gateway.example', 'https://gateway.example///',
    'https://gateway.example/chat/completions/#section']) {
    assert.equal(models.normalizeEndpoint(input), 'https://gateway.example');
    assert.equal(models.joinEndpoint(input, '/chat/completions'), 'https://gateway.example/chat/completions');
  }
  assert.equal(models.normalizeEndpoint('https://gateway.example/v1///#section'), 'https://gateway.example/v1');
});

for (const [name, input, pathname, query] of cases) {
  test(`translation, connection and discovery requests preserve ${name}`, async () => {
    const endpoint = models.normalizeEndpoint(input);
    const provider = { id: 'custom-query', endpoint, apiKeyRequired: false,
      completionsPath: '/chat/completions', modelsPath: '/models' };
    const model = { id: 'test-model', model: 'test-model', endpoint, effortLevels: ['none'] };
    const calls = [];
    const fetchImpl = async (url, init) => {
      calls.push({ url, method: init.method });
      const reply = init.method === 'POST'
        ? { choices: [{ finish_reason: 'stop', message: { content: '{"s1":"Hello"}' } }] }
        : { data: [{ id: 'test-model' }] };
      return new Response(JSON.stringify(reply), { headers: { 'content-type': 'application/json' } });
    };
    const options = { provider, model, fetchImpl, maxRetries: 0 };
    const translated = await api.translateSegments({ ...options,
      targetCode: 'en', segments: [{ id: 's1', text: '你好' }] });
    assert.deepEqual(translated.translations, [{ id: 's1', text: 'Hello' }]);
    assert.equal((await api.testConnection(options)).modelAvailable, true);
    assert.deepEqual(await api.fetchModels(options), ['test-model']);
    assert.deepEqual(calls, [
      { url: `https://gateway.example${pathname}/chat/completions${query}`, method: 'POST' },
      { url: `https://gateway.example${pathname}/models${query}`, method: 'GET' },
      { url: `https://gateway.example${pathname}/models${query}`, method: 'GET' }
    ]);
  });
}
