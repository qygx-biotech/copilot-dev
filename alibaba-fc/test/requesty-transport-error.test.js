'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { requestRequestyMessage } = require('../index.js')._test;
const request = { model: 'fixture/model', messages: [{ role: 'user', content: 'PRIVATE_PROMPT' }] };

test('fetch retry and terminal failure retain original message and network cause code', async t => {
  const logs = [], waits = []; let calls = 0;
  for (const method of ['warn', 'error']) t.mock.method(console, method, (...args) => logs.push(args));
  t.mock.method(require('node:timers/promises'), 'setTimeout', async delay => waits.push(delay));
  t.mock.method(globalThis, 'fetch', async () => {
    calls++;
    throw new TypeError('fetch failed', { cause: Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:443'), { code: 'ECONNREFUSED' }) });
  });
  const result = await requestRequestyMessage(request, 'fixture-secret');
  assert.equal(calls, 2); assert.equal(waits.length, 1);
  assert.equal(result.error, 'LlmRequestFailed'); assert.equal(result.terminalProviderFailure, true);
  assert.deepEqual(result.transportError, { name: 'TypeError', message: 'fetch failed', causeCode: 'ECONNREFUSED' });
  assert.match(result.message, /fetch failed.*ECONNREFUSED/);
  assert.equal(logs.length, 2); assert(logs.every(entry => entry[1].transportError.causeCode === 'ECONNREFUSED'));
  assert.doesNotMatch(JSON.stringify([logs, result]), /PRIVATE_PROMPT|fixture-secret|stack/);
});

test('transport diagnostics redact credentials and URLs and exclude attached objects', async t => {
  const logs = [];
  t.mock.method(console, 'error', (...args) => logs.push(args));
  t.mock.method(globalThis, 'fetch', async () => {
    const error = Object.assign(new Error('fetch failed fixture-secret https://user:password@example.test/path?token=hidden Authorization: Bearer other-secret'), {
      cause: Object.assign(new Error('socket closed\nPRIVATE_BODY'), { code: 'UND_ERR_SOCKET', headers: { cookie: 'COOKIE_SECRET' } }),
      request, stack: 'PRIVATE_STACK',
    });
    throw error;
  });
  const result = await requestRequestyMessage(request, 'fixture-secret', false, null, { maxAttempts: 1 });
  assert.equal(result.transportError.causeCode, 'UND_ERR_SOCKET');
  assert.equal(result.transportError.causeMessage, undefined, 'Arbitrary exception prose is never retained');
  assert.match(result.transportError.message, /fetch failed/);
  assert.doesNotMatch(JSON.stringify([logs, result]), /fixture-secret|user:password|other-secret|token=hidden|PRIVATE_|COOKIE_SECRET/);
});

test('cancellation retains the existing abort contract and never retries', async t => {
  const controller = new AbortController(); let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => { calls++; controller.abort(); throw new Error('cancelled'); });
  await assert.rejects(requestRequestyMessage(request, 'fixture-secret', false, null, { signal: controller.signal }), { code: 'OPERATION_ABORTED' });
  assert.equal(calls, 1);
});
