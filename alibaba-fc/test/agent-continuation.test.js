'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const zlib = require('node:zlib');
const continuation = require('../agent-continuation.js');
const state = { step: 2, pending: [], agentMessages: [] };
const binding = { account: 'fixture', turnId: 'turn', permission: 'read_only' };
const secret = 'offline-fixture-key';

test('signed continuation remains valid beyond fifteen minutes and carries no expiry', t => {
  const now = Date.now();
  const token = continuation.seal(state, binding, secret);
  const payload = JSON.parse(zlib.inflateSync(Buffer.from(token.split('.')[0], 'base64url')));
  assert.equal(Object.hasOwn(payload, 'expires'), false);
  t.mock.method(Date, 'now', () => now + 365 * 24 * 60 * 60000);
  assert.deepEqual(continuation.open(token, binding, secret), state);
});

test('previously issued signed tokens no longer fail their old expiry cutoff', () => {
  const payload = zlib.deflateSync(Buffer.from(JSON.stringify({ state,
    binding: crypto.createHash('sha256').update(JSON.stringify(binding)).digest('hex'), expires: 1 }))).toString('base64url');
  const signature = crypto.createHmac('sha256', secret).update(`source-tools-v1:${payload}`).digest('base64url');
  assert.deepEqual(continuation.open(`${payload}.${signature}`, binding, secret), state);
});

test('signature, request binding, framing and payload limits remain enforced', () => {
  const token = continuation.seal(state, binding, secret);
  for (const [value, scope, key] of [[token, { ...binding, permission: 'full_access' }, secret],
    [token, binding, 'wrong-key'], [token + '.extra', binding, secret],
    ['bad.' + token.split('.')[1], binding, secret], ['x'.repeat(950001), binding, secret]]) {
    assert.throws(() => continuation.open(value, scope, key), { code: 'INVALID_TOOL_CONTINUATION' });
  }
  assert.throws(() => continuation.seal({ text: 'x'.repeat(700000) }, binding, secret), { code: 'LOCAL_CONTEXT_TRANSPORT_LIMIT' });
});
