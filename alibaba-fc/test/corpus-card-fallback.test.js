'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs/promises'), os = require('node:os'), path = require('node:path');
const { ContextRecovery } = require('../context-recovery.js');
const lifecycle = require('../provider-lifecycle.js');
const configuration = lifecycle.configuration({ AGENT_PROVIDER_ADAPTERS_JSON: JSON.stringify({ fixture: { api: 'responses', endpoint: 'https://offline.invalid/v1/responses', apiKeyEnv: 'FIXTURE_KEY', model: 'fixture' } }), FIXTURE_KEY: 'offline' }, 'fixture');
const overflow = { ok: false, status: 400, error: { code: 'context_length_exceeded', message: 'maximum context length exceeded' }, attempts: 1 };
const full = 'Long derived card detail. '.repeat(1000) + 'BEYOND_ORIENTATION';
const mixed = { ok: true, collectionMode: 'local-evidence', workflowId: 'workflow', findings: { papers: [{ sourceId: 'p1', originalEvidence: [{ text: 'ORIGINAL_PASSAGE' }], orientation: { content: 'short', truncated: true } }] }, knowledge: { content: 'SUPPLEMENTARY_TOPIC' }, evidenceBundle: { content: 'DUPLICATE_PREVIEW' } };
const bundle = { version: 1, workflowId: 'workflow', cards: [{ sourceId: 'p1', contentHash: 'v1', cardIdentity: 'card1', card: { shortSummary: full } }], missingCards: [{ sourceId: 'missing', reason: 'CURRENT_COMPATIBLE_CARD_UNAVAILABLE' }], failures: [] };
const messages = () => [{ role: 'system', content: 'Canonical authorization' }, { role: 'user', content: 'Review my corpus' }, { role: 'assistant', tool_calls: [{ id: 'corpus', type: 'function', function: { name: 'run_corpus_workflow', arguments: '{}' } }] }, { role: 'tool', tool_call_id: 'corpus', content: JSON.stringify(mixed), corpus_card_fallback: structuredClone(bundle) }, { role: 'user', content: 'Keep my unrelated correction.' }];
const bindings = [{ sourceId: 'p1', identity: 'source:p1', version: 'v1', current: true }];
async function fixture(t, extra = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'corpus-fallback-')); t.after(() => fs.rm(root, { recursive: true, force: true }));
  const { config = {}, ...rest } = extra;
  return new ContextRecovery({ config: { root, maxAttempts: 1, ...config }, model: 'fixture', ...rest });
}
const options = () => ({ messages: messages(), corpusSourceBindings: bindings, tools: [], maxTokens: 100 });
const success = { ok: true, attempts: 1, message: { content: 'A derived overview.' } };
const quota = { ok: false, status: 429, attempts: 1, error: { code: 'input_token_quota_exceeded', details: { input_token_limit: 16000, retry_after_ms: 0 } } };

for (const rejection of [overflow, quota]) test(`actual Responses body uses full card-only retry after ${rejection.status} before generic recovery`, async t => {
  const manager = await fixture(t), original = options(), before = structuredClone(original), bodies = [];
  manager.compact = () => assert.fail('Generic recovery must not run first');
  const result = await manager.run(original, request => lifecycle.responses(configuration, { ...request, max_tokens: 100 }, { fetchImpl: async (_url, init) => {
    const body = JSON.parse(init.body); bodies.push(body);
    if (bodies.length === 1) return new Response(JSON.stringify({ error: rejection.error }), { status: rejection.status });
    return new Response(JSON.stringify({ status: 'completed', output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Done' }] }] }));
  } }));
  assert(result.ok, JSON.stringify(result)); assert.equal(bodies.length, 2); assert.equal(manager.recoverySteps, 0);
  assert.equal(manager.callCounters.dispatched, 2);
  assert.deepEqual(original, before);
  const first = bodies[0].input.find(m => m.type === 'function_call_output');
  assert.deepEqual(JSON.parse(first.output), mixed);
  assert(!JSON.stringify(bodies[0]).includes('BEYOND_ORIENTATION'));
  const second = bodies[1].input.find(m => m.type === 'function_call_output');
  assert.equal(second.call_id, 'corpus');
  const view = JSON.parse(second.output);
  assert.equal(view.paperCards[0].card.shortSummary, full);
  assert.equal(view.paperCards[0].cardIdentity, 'card1'); assert.equal(view.paperCards[0].contentHash, 'v1');
  assert.equal(view.coverage.withCurrentCompatibleCards, 1); assert.equal(view.coverage.exhaustiveContentCoverage, false);
  assert.equal(view.missingCards.length, 1);
  assert(!/ORIGINAL_PASSAGE|SUPPLEMENTARY_TOPIC|DUPLICATE_PREVIEW/.test(second.output));
  assert.match(view.guidance, /retrieve_project_evidence/);
  assert.deepEqual(bodies[0].input.filter(m => m.type !== 'function_call_output'), bodies[1].input.filter(m => m.type !== 'function_call_output'));
});

test('accepted first request is unchanged and fallback is never proactively estimated', async t => {
  const manager = await fixture(t, { config: { window: 10 } });
  let calls = 0;
  await manager.run(options(), async request => { calls++; assert.deepEqual(JSON.parse(request.messages[3].content), mixed); assert(!JSON.stringify(request.messages).includes('BEYOND_ORIENTATION')); return success; });
  assert.equal(calls, 1); assert.equal(manager.recoverySteps, 0);
  assert(Object.values(manager.state.corpusCardFallbacks).every(entry => !entry.active));
});

test('invalid corpus summaries fail explicitly without spending generic allowance or creating previews', async t => {
  const manager = await fixture(t); let calls = 0, compactions = 0;
  manager.compact = async request => {
    compactions++; assert.equal(manager.recoverySteps, 1);
    assert(JSON.parse(request.messages[3].content).corpusCardProjection);
    return request.messages.map((m, i) => i === 3 ? { ...m, content: '{"contextArchive":"fixture","preview":"derived cards"}' } : m);
  };
  const result = await manager.run(options(), async () => ++calls <= 2 ? overflow : success);
  assert(!result.ok); assert.equal(calls, 4); assert.equal(compactions, 0); assert.equal(manager.recoverySteps, 0); assert(!result.contextMessages[3].content.includes('contextArchive'));
  const next = await manager.run({ ...options(), messages: result.contextMessages }, async () => assert.fail('Failed corpus summary must not become a preview retry'));
  assert(!next.ok);
});

for (const failure of [{ status: 401, error: { code: 'authentication_error' } }, { status: 429, error: { code: 'rate_limit_exceeded' } }, { status: 503, error: { code: 'unavailable' } }, { ok: true, finish_reason: 'length' }]) test(`non-size failure ${failure.status || 'output length'} never activates card fallback`, async t => {
  const manager = await fixture(t);
  await manager.run(options(), async () => ({ ok: false, attempts: 1, ...failure }));
  assert(Object.values(manager.state.corpusCardFallbacks).every(entry => !entry.active));
});

test('durable marker prevents repetition after cold start with an older checkpoint; revocation and version changes filter cards', async t => {
  const remote = new Map(), store = { put: async (key, text) => remote.set(key, text), get: async key => remote.get(key) };
  const manager = await fixture(t, { archiveStorage: store }); let saved;
  let initialCalls = 0;
  await manager.run(options(), async () => { if (++initialCalls === 1) { saved = manager.snapshot(); return overflow; } return success; });
  assert(Object.values(saved.corpusCardFallbacks).every(entry => !entry.active));
  // Snapshot deliberately predates fallback admission. The durable marker still records it.
  // Use the same archive session on a different empty local filesystem.
  const cold = await fixture(t, { archiveStorage: store, state: saved });
  let calls = 0;
  const result = await cold.run({ ...options(), corpusSourceBindings: [] }, async request => {
    calls++; const view = JSON.parse(request.messages[3].content);
    assert(view.corpusCardProjection); assert.equal(view.paperCards.length, 0);
    assert(view.missingCards.some(m => m.reason === 'SOURCE_OUTSIDE_CURRENT_SCOPE')); return success;
  });
  assert(result.ok); assert.equal(calls, 1);
  const stale = await cold.run({ ...options(), corpusSourceBindings: [{ ...bindings[0], version: 'v2' }] }, async request => {
    const view = JSON.parse(request.messages[3].content); assert.equal(view.paperCards.length, 0);
    assert(view.missingCards.some(m => m.reason === 'SOURCE_STALE_OR_UNAVAILABLE')); return success;
  });
  assert(stale.ok);
  await cold.run({ ...options(), corpusSourceBindings: [{ ...bindings[0], cardStatus: 'stale' }] }, async request => {
    assert.equal(JSON.parse(request.messages[3].content).paperCards.length, 0); return success;
  });
  await cold.run({ ...options(), corpusSourceBindings: [{ ...bindings[0], cardStatus: 'ready', cardCacheKey: 'changed-config' }] }, async request => {
    assert.equal(JSON.parse(request.messages[3].content).paperCards.length, 0); return success;
  });
});

test('cancellation after rejection prevents retry and expired deadline prevents any provider request', async t => {
  const manager = await fixture(t), controller = new AbortController(); let calls = 0;
  await assert.rejects(manager.run({ ...options(), signal: controller.signal }, async () => { calls++; controller.abort(); return overflow; }), { code: 'OPERATION_ABORTED' });
  assert.equal(calls, 1);
  const deadline = await fixture(t);
  const result = await deadline.run({ ...options(), deadlineAt: Date.now() - 1 }, () => assert.fail('Expired deadline'));
  assert.equal(result.ok, false);
});


test('archive staging obeys cancellation and deadlines without dispatching a provider', async t => {
  let started; const ready = new Promise(resolve => { started = resolve; });
  const store = { put: async () => { started(); return new Promise(() => {}); }, get: async () => undefined };
  const manager = await fixture(t, { archiveStorage: store }), controller = new AbortController();
  const running = manager.run({ ...options(), signal: controller.signal }, () => assert.fail('No provider before staging'));
  await ready; controller.abort();
  await assert.rejects(running, { code: 'OPERATION_ABORTED' });
  const deadline = await fixture(t, { archiveStorage: store });
  const result = await deadline.run({ ...options(), deadlineAt: Date.now() + 25 }, () => assert.fail('No provider after deadline'));
  assert.equal(result.ok, false); assert.equal(result.recoveryStopReason, 'hard_request_deadline_exhausted');
});

test('an unavailable durable card archive fails honestly and cannot restore mixed context', async t => {
  const manager = await fixture(t); let calls = 0;
  await manager.run(options(), async () => ++calls === 1 ? overflow : success);
  const snapshot = manager.snapshot();
  const cold = await fixture(t, { state: snapshot }); // Different host, no shared store configured.
  const result = await cold.run(options(), () => assert.fail('No fabricated or mixed fallback'));
  assert.equal(result.ok, false); assert.equal(result.recoveryStopReason, 'archive_unavailable');
});

for (const first of [quota, overflow]) for (const second of [quota, overflow]) test(`fallback shares one admission across ${first.status} then ${second.status} rejection`, async t => {
  const manager = await fixture(t); let calls = 0, compactions = 0;
  manager.compact = async request => {
    compactions++; assert.equal(manager.recoverySteps, 1);
    assert(JSON.parse(request.messages[3].content).corpusCardProjection);
    return request.messages.map((m, i) => i === 3 ? { ...m, content: 'ordinary recovery preview' } : m);
  };
  const result = await manager.run(options(), async request => {
    calls++;
    if (calls === 1) return first;
    if (calls === 2) {
      assert.equal(manager.recoverySteps, 0);
      assert.equal(JSON.parse(request.messages[3].content).paperCards[0].card.shortSummary, full);
      return second;
    }
    return success;
  });
  assert(!result.ok); assert.equal(compactions, 0);
  assert.equal(calls, 4); assert.equal(manager.recoverySteps, 0);
  assert.equal(manager.corpusDispatchAllowance, calls - 1);
});

test('quota card retry respects confirmed cooldown and preserves normal recovery allowance', async t => {
  let time = 1800000000000, calls = 0, waited = 0;
  const manager = await fixture(t, { now: () => time, monotonic: () => time,
    sleep: async ms => { waited += ms; time += ms; } });
  manager.compact = () => assert.fail('Card retry must precede generic quota recovery');
  const result = await manager.run(options(), async request => {
    calls++;
    if (calls === 1) return { ...quota, error: { ...quota.error, details: { input_token_limit: 16000, retry_after_ms: 2000 } } };
    assert.equal(waited, 2000);
    assert(JSON.parse(request.messages[3].content).corpusCardProjection);
    return success;
  });
  assert(result.ok); assert.equal(calls, 2); assert.equal(result.recoveryMode, 'input_quota');
  assert.equal(manager.recoverySteps, 0); assert.equal(manager.quotaFields().quotaCapacity, 16000);
  assert.equal(manager.callCounters.dispatched, 2);
  const saved = manager.snapshot();
  const cold = new ContextRecovery({ config: manager.config, model: 'fixture', state: saved, now: () => time, monotonic: () => time });
  await cold.run(options(), async request => {
    assert(JSON.parse(request.messages[3].content).corpusCardProjection); return success;
  });
  assert.equal(cold.corpusDispatchAllowance, 0);
});

for (const cancelled of [true, false]) test(`quota card retry ${cancelled ? 'cancels during cooldown' : 'cannot overrun the hard deadline'}`, async t => {
  let time = 1800000000000, calls = 0;
  const controller = new AbortController();
  const manager = await fixture(t, { now: () => time, monotonic: () => time,
    sleep: async ms => { time += ms; controller.abort(); } });
  const run = manager.run({ ...options(), signal: controller.signal, deadlineAt: time + (cancelled ? 10000 : 1000) }, async () => {
    calls++; return { ...quota, error: { ...quota.error, details: { retry_after_ms: 2000 } } };
  });
  if (cancelled) await assert.rejects(run, { code: 'OPERATION_ABORTED' });
  else assert.equal((await run).recoveryStopReason, 'hard_request_deadline_exhausted');
  assert.equal(calls, 1);
});


test('native Responses preserves only classified quota metadata and excludes ordinary 429s', async () => {
  for (const [code, confirmed] of [['input_token_quota_exceeded', true], ['rate_limit_exceeded', false], ['output_token_quota_exceeded', false], ['insufficient_quota', false]]) {
    const result = await lifecycle.responses(configuration, { messages: [{ role: 'user', content: 'Fixture' }], tools: [] }, {
      fetchImpl: async () => new Response(JSON.stringify({ error: { code, message: 'PRIVATE_REQUEST_DETAILS', details: { input_token_limit: 16000 } } }), { status: 429, headers: { 'retry-after': '2' } }),
    });
    assert.equal(Boolean(result.inputQuota), confirmed);
    if (confirmed) { assert.equal(result.inputQuota.capacity, 16000); assert.equal(result.inputQuota.retryAfterMs, 2000); }
    assert(!JSON.stringify(result).includes('PRIVATE_REQUEST_DETAILS'));
  }
});
