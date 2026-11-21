'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { ApiError, requestJson, validateApiKey, withRetries } = require('../../background/api-transport.js');

test('a key with a hidden or non-ASCII byte fails validation before transport', () => {
  for (const value of ['example\u200bkey', 'example\x00key', 'example\uFF21key']) {
    assert.throws(() => validateApiKey(value), { code: 'INVALID_API_KEY_FORMAT', retryable: false });
  }
});

test('an array-wrapped HTTP error exposes only the sanitized provider detail', async () => {
  const apiKey = 'synthetic-key';
  const fetchImpl = async () => new Response(JSON.stringify([{ error: { message: `Bad setting (${apiKey})` } }]), {
    status: 400, headers: { 'content-type': 'application/json' }
  });
  await assert.rejects(requestJson('https://provider.example.test', { fetchImpl, apiKey }), {
    code: 'BAD_REQUEST', providerMessage: 'Bad setting ([redacted key])'
  });
});

test('a request already stopped at failure skips the retry delay', async () => {
  const failure = new ApiError('Try later', { code: 'RATE_LIMITED', retryable: true, retryAfterMs: 10000 });
  let stopped = false;
  await assert.rejects(withRetries(async () => {
    stopped = true;
    throw failure;
  }, { stopped: () => stopped, sleep: () => assert.fail('retry delay should be skipped') }), failure);
});
