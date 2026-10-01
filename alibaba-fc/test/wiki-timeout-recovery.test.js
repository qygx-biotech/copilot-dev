'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const jwt = require('jsonwebtoken'), { createHash } = require('node:crypto');
const { handler } = require('../index.js');
const { createFixture } = require('./helpers/preflight-fixture.js');
const { LiteratureApiClient } = require('../../docs/literature-module.js');
const contract = require('../../shared/literature-wiki.js');
const { createRuntimeLogger } = require('../../docs/runtime-log.js');
const model = 'google/gemma-4-31b-it';
const signature = value => createHash('sha256').update(value).digest('hex');
const markdown = input => input.papers.map(paper => `${paper.evidence[0].text} [[cite:${paper.evidence[0].reference}]]`).join('\n\n');
async function harness(t, { count = 2, labels = ['thermostability'] } = {}) {
  const state = { now: Date.now(), mode: 'success', requests: [], transports: 0, signals: [] };
  const env = { JWT_SECRET: 'wiki-timeout-fixture', ADMIN_ACCOUNT: 'wiki-timeout-fixture', REQUESTY_API_KEY: 'private-fixture-key', REQUESTY_MODEL: model };
  const prior = Object.fromEntries(Object.keys(env).map(key => [key, process.env[key]])); Object.assign(process.env, env);
  t.after(() => { for (const [key, value] of Object.entries(prior)) value === undefined ? delete process.env[key] : process.env[key] = value; });
  const nativeTimer = globalThis.setTimeout;
  // Advance the host's clock when its real deadline callback fires. No shortened
  // production budget or forged timeout error; only test wall time is accelerated.
  t.mock.method(globalThis, 'setTimeout', (fn, ms, ...args) => nativeTimer(() => { if (ms >= 60000) state.now += ms; fn(...args); }, ms >= 60000 ? (state.mode === 'unavailable' ? 1000 : 5) : ms));
  t.mock.method(globalThis, 'fetch', async (_url, options) => {
    const body = JSON.parse(options.body), input = JSON.parse(body.messages.at(-1).content);
    state.requests.push({ input, model: body.model }); state.signals.push(options.signal);
    assert.equal(input.configuration.modelSignature, signature(body.model));
    const mode = typeof state.mode === 'function' ? state.mode(input) : state.mode;
    if (mode === 'timeout') return new Promise((resolve, reject) => options.signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true }));
    if (mode === 'uncooperative') return new Promise(resolve => { state.remoteResolve = () => resolve(new Response(JSON.stringify({ choices: [{ message: { content: markdown(input) } }] }))); });
    if (mode === 'cancel') { state.cancel.abort(); throw new DOMException('Aborted', 'AbortError'); }
    if (mode === 'reject' || mode === 'unavailable') return new Response(JSON.stringify({ error: { message: 'Fixture rejection' } }), { status: mode === 'reject' ? 400 : 503, headers: { 'retry-after': '0' } });
    return new Response(JSON.stringify({ choices: [{ message: { content: mode === 'invalid' ? '' : mode === 'citation' ? 'Claim [[cite:invented:p1:c]]' : markdown(input) } }] }));
  });
  const token = jwt.sign({ account: env.ADMIN_ACCOUNT, role: 'admin' }, env.JWT_SECRET);
  async function make(workspace) {
    const f = await createFixture({ workspace });
    if (!workspace) for (let i = 0; i < count; i++) f.workspace.set(`literature/p${i}.pdf`, `Evidence of thermostability and distinct concepts in paper ${i}.`);
    f.system.topicService.labelsFromCard = () => labels;
    f.wiki = f.system.literatureWiki; f.wiki.now = () => state.now;
    f.wiki.setMaintenanceTimeout = nativeTimer; // Accelerate provider waits, not local admission I/O.
    f.log = createRuntimeLogger({ sink: null, heartbeatMs: 0 }); f.pipeline.log = f.log;
    const api = new LiteratureApiClient({ baseUrl: 'https://fixture.invalid', getHeaders: () => ({ Authorization: `Bearer ${token}` }), now: () => state.now,
      fetch: async (_url, options) => {
        state.transports++;
        const result = await handler({ httpMethod: 'POST', path: '/api/knowledge/update-wiki', headers: options.headers, body: options.body }, {}, { signal: options.signal });
        return new Response(result.body, { status: result.statusCode });
      } });
    f.wiki.getPaperCardConfiguration = async (_signal, context) => ({ schemaVersion: 2, promptVersion: 'fixture-v1', modelSignature: 'fixture-model', wikiConfiguration: contract.configuration(signature(context?.model || model)) });
    f.api = api; f.wiki.generateWikiPage = (input, options) => api.updateWikiPage(input, options);
    f.run = (id, extra = {}) => f.pipeline.preflight({ turnId: id, surface: 'side_chat', question: 'Explain these papers.', callContext: { model }, ...extra });
    f.topic = () => f.system.topicService.topics.find(topic => topic.wikiAdmission);
    return f;
  }
  return { state, make, f: await make() };
}

test('actual provider-adapter deadline timeout persists across restart, cools down, then retries current evidence successfully', async t => {
  const { state, make, f } = await harness(t);
  state.mode = 'timeout'; const first = await f.run('first');
  assert.equal(first.wikiMaintenance.generationCalls, 1);
  assert.equal(first.wikiMaintenance.pages[0].outcome, 'retryable_timeout');
  const topic = f.topic(), last = topic.wikiMaintenance.attempts.at(-1);
  assert.equal(last.status, 'retryable_timeout'); assert.equal(last.transportStarted, true);
  assert.equal(last.providerRequestStarted, null); assert.equal(last.providerCompletion, 'unknown');
  const event = f.log.entries().find(entry => entry.event === 'wiki.attempt-outcome');
  assert.equal(event.details.outcome, 'retryable_timeout');
  assert.equal(event.details.providerCompletion, 'unknown');
  assert.equal(event.details.timeoutCount, 1);
  assert.doesNotMatch(f.log.exportText(), /private-fixture-key|Evidence of thermostability|Bearer|literature\/p0.pdf/);
  assert.equal(last.generationDurationMs, 300000); assert.equal(state.signals[0].aborted, true);
  assert.equal(topic.wikiMaintenance.timeoutRecovery.nextRetryAt - state.now, 60000);
  const stored = await f.workspace.readJson('.biodesign/knowledge/topics/index.json');
  assert.equal(stored.topics.find(item => item.topicId === topic.topicId).wikiMaintenance.timeoutRecovery.timeoutCount, 1);
  const restarted = await make(f.workspace); state.mode = 'success';
  const cooling = await restarted.run('cooling');
  assert.equal(cooling.wikiMaintenance.pages[0].outcome, 'cooling_down'); assert.equal(state.requests.length, 1);
  state.now += 60000;
  const retry = await restarted.run('retry', { callContext: { model: 'nvidia/nemotron-3-nano-omni-30b-a3b-reasoning' } });
  assert.equal(retry.wikiMaintenance.generationCalls, 1);
  assert.equal(restarted.topic().wikiMaintenance.timeoutRecovery.status, 'published');
  assert.equal(state.requests.at(-1).model, 'nvidia/nemotron-3-nano-omni-30b-a3b-reasoning');
  assert.ok(await restarted.wiki.readForUse(restarted.topic()));
  assert.equal(restarted.calls.cards, 0); assert.equal(restarted.calls.parses, 0);
  await restarted.run('unchanged', { callContext: { model: 'nvidia/nemotron-3-nano-omni-30b-a3b-reasoning' } });
  assert.equal(state.transports, 2); assert.equal(state.requests.length, 2);
  assert.ok(f.workspace.writes.every(path => path.startsWith('.biodesign/')));
  assert.deepEqual(f.workspace.state.agent.currentRecommendation, { id: 'R1' });
});

test('timeout cooldowns persist without a lifetime cutoff or an automatic background retry', async t => {
  const { f, state } = await harness(t); state.mode = 'timeout';
  for (const [index, delay] of [60000, 300000, 900000, 3600000, 3600000].entries()) {
    const run = await f.run(`timeout-${index}`);
    assert.equal(run.wikiMaintenance.generationCalls, 1);
    assert.equal(f.topic().wikiMaintenance.timeoutRecovery.timeoutCount, index + 1);
    assert.equal(f.topic().wikiMaintenance.timeoutRecovery.nextRetryAt - state.now, delay);
    state.now += delay - 1;
    await f.run(`early-${index}`); assert.equal(state.transports, index + 1);
    state.now++;
    await new Promise(resolve => setImmediate(resolve)); assert.equal(state.transports, index + 1, 'clock expiry alone does not generate');
  }
  assert.equal(f.topic().wikiMaintenance.attempts.length, 4);
  assert.equal(f.topic().wikiMaintenance.timeoutRecovery.timeoutCount, 5);
});

test('fresh pages and timeout pages alternate fairly across runs and concurrent callers deduplicate', async t => {
  const { f, state } = await harness(t, { labels: ['alpha concept', 'beta concept', 'gamma concept'] });
  state.mode = input => input.pageId === 'alpha-concept' ? 'timeout' : 'success';
  await Promise.all([f.run('a'), f.run('b')]);
  assert.equal(state.requests.filter(item => item.input.pageId === 'alpha-concept').length, 1);
  assert.equal(state.requests.length, 1, 'concurrent preflight shares the same maintenance run');
  state.now = f.system.topicService.topics.find(topic => topic.topicId === 'alpha-concept').wikiMaintenance.timeoutRecovery.nextRetryAt;
  await f.run('c');
  assert.deepEqual(state.requests.map(item => item.input.pageId), ['alpha-concept', 'beta-concept', 'alpha-concept']);
  state.now = f.system.topicService.topics.find(topic => topic.topicId === 'alpha-concept').wikiMaintenance.timeoutRecovery.nextRetryAt;
  await f.run('d');
  assert.deepEqual(state.requests.map(item => item.input.pageId), ['alpha-concept', 'beta-concept', 'alpha-concept', 'gamma-concept', 'alpha-concept']);
  const attempts = f.system.topicService.topics.flatMap(topic => topic.wikiMaintenance?.attempts || []).filter(attempt => attempt.generationStarted);
  assert.ok(attempts.some(attempt => attempt.scheduledClass === 'timeout_retry'));
  assert.equal(new Set(attempts.map(attempt => attempt.scheduleSequence)).size, attempts.length);
});

test('duration estimator defers short remaining work without consuming fingerprints; no page-count cutoff', async t => {
  const { f, state } = await harness(t, { count: 20, labels: ['alpha concept', 'beta concept', 'gamma concept', 'delta concept', 'epsilon concept'] });
  state.mode = () => { state.now += 210000; return 'success'; };
  const first = await f.run('slow');
  assert.equal(first.wikiMaintenance.generationCalls, 1);
  const deferred = f.system.topicService.topics.filter(topic => topic.wikiAdmission && !topic.wiki);
  assert.equal(deferred.length, 4);
  assert.ok(deferred.every(topic => !topic.wikiEvidence.attemptedFingerprints.length && topic.wikiEvidence.eligibleFingerprint));
  assert.ok(first.wikiMaintenance.pages.some(page => page.reason === 'insufficient_remaining_time'));
  state.mode = 'success';
  const second = await f.run('next'); assert.equal(second.wikiMaintenance.generationCalls, 4);
  assert.equal((await f.run('last')).wikiMaintenance.generationCalls, 0);
  assert.equal((await f.run('cached')).wikiMaintenance.generationCalls, 0);
  assert.equal(state.transports, 5); assert.equal(new Set(state.requests.map(item => item.input.pageId)).size, 5);
});

test('explicit cancellation and unrelated failures cannot authorize timeout recovery; provider retries are not multiplied', async t => {
  for (const mode of ['cancel', 'reject', 'unavailable', 'invalid', 'citation']) await t.test(mode, async t => {
    const { f, state } = await harness(t); state.mode = mode;
    state.cancel = new AbortController();
    if (mode === 'cancel') await assert.rejects(f.run('cancel', { signal: state.cancel.signal }), { code: 'OPERATION_ABORTED' });
    else await f.run('failed');
    assert.notEqual(f.topic().wikiMaintenance.timeoutRecovery?.status, 'retryable_timeout');
    assert.equal(f.topic().wikiMaintenance.attempts.at(-1).status, mode === 'cancel' ? 'cancelled' : 'failed');
    const calls = state.requests.length;
    assert.equal(state.transports, 1);
    assert.equal(calls, mode === 'unavailable' ? 5 : mode === 'citation' ? 2 : 1, '503 allows five attempts; other bounds are unchanged and the host sends only once');
    state.now += 86400000; state.mode = 'success'; await f.run('unchanged');
    assert.equal(state.requests.length, calls);
  });
});

test('new raw evidence supersedes timeout recovery; deleted sources cannot resend old evidence', async t => {
  for (const deleted of [false, true]) await t.test(String(deleted), async t => {
    const { f, state } = await harness(t); state.mode = 'timeout'; await f.run('timeout');
    const old = f.topic().wikiMaintenance.timeoutRecovery.evidenceFingerprint;
    state.mode = 'success';
    if (deleted) f.workspace.files.delete('literature/p0.pdf');
    else f.workspace.set('literature/p0.pdf', 'Changed authoritative thermostability evidence.', Date.now() - 1000);
    const result = await f.run('changed');
    assert.notEqual(f.topic().wikiEvidence.fingerprint, old);
    assert.equal(f.topic().wikiMaintenance.timeoutRecovery.status, 'superseded');
    assert.equal(result.wikiMaintenance.generationCalls, deleted ? 0 : 1);
    if (!deleted) assert.notEqual(state.requests[0].input.papers[0].contentHash, state.requests[1].input.papers[0].contentHash);
  });
});

test('late remote completion cannot publish after local timeout; previous valid revision is preserved then updated', async t => {
  const { f, state } = await harness(t); await f.run('seed');
  const previous = await f.wiki.read(f.topic()); state.mode = 'uncooperative';
  const request = { action: 'incorporate', analysisRequest: 'Incorporate thermostability evidence', callContext: { model } };
  const failed = await f.wiki.maintain(request);
  assert.equal(failed.pages[0].outcome, 'retryable_timeout');
  assert.deepEqual(await f.wiki.read(f.topic()), previous);
  state.remoteResolve(); await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(await f.wiki.read(f.topic()), previous);
  state.now += 60000; state.mode = 'success';
  await f.run('retry');
  assert.equal((await f.wiki.read(f.topic())).analysisRequest, request.analysisRequest);
  assert.equal(f.calls.cards, 2); assert.equal(f.calls.parses, 2);
});

test('an already-valid locally published revision is reused and its projection repaired before resending', async t => {
  const { f, state } = await harness(t); await f.run('seed');
  const topic = f.topic(), current = await f.wiki.read(topic);
  topic.wikiMaintenance.timeoutRecovery = { evidenceFingerprint: topic.wikiEvidence.fingerprint, status: 'retryable_timeout', timeoutCount: 1, nextRetryAt: state.now };
  topic.wikiMaintenance.projectionPending = true;
  await f.workspace.removeFile(`.biodesign/knowledge/topics/${topic.topicId}.md`);
  await f.system.topicService.persist();
  await f.run('recover-local');
  assert.equal(state.transports, 1);
  assert.equal(topic.wikiMaintenance.timeoutRecovery.status, 'published');
  assert.equal(topic.wiki.key, current.key);
  assert.ok(await f.workspace.fileExists(`.biodesign/knowledge/topics/${topic.topicId}.md`));
});


test('journal persistence can defer before dispatch without consuming generation eligibility', async t => {
  const { f, state } = await harness(t);
  const persist = f.wiki.topics.persist.bind(f.wiki.topics);
  let delayed = false;
  f.wiki.topics.persist = async () => {
    await persist();
    if (!delayed && f.topic()?.wikiMaintenance?.attempts.at(-1)?.generationStarted) {
      delayed = true; state.now += 300000;
    }
  };
  const result = await f.run('slow-storage');
  assert.equal(state.transports, 0); assert.equal(result.wikiMaintenance.generationCalls, 0);
  assert.equal(f.topic().wikiEvidence.attemptedFingerprints.length, 0);
  assert.equal(f.topic().wikiMaintenance.attempts.at(-1).providerCompletion, 'not_started');
  assert.equal((await f.run('next-request')).wikiMaintenance.generationCalls, 1);
});

test('cancellation or invalid content during timeout recovery revokes automatic retry eligibility', async t => {
  for (const mode of ['cancel', 'invalid']) await t.test(mode, async t => {
    const { f, state } = await harness(t); state.mode = 'timeout'; await f.run('timeout');
    state.now = f.topic().wikiMaintenance.timeoutRecovery.nextRetryAt;
    state.mode = mode; state.cancel = new AbortController();
    if (mode === 'cancel') await assert.rejects(f.run('retry', { signal: state.cancel.signal }), { code: 'OPERATION_ABORTED' });
    else await f.run('retry');
    assert.equal(f.topic().wikiMaintenance.timeoutRecovery.status, mode === 'cancel' ? 'cancelled' : 'failed');
    state.now += 86400000; state.mode = 'success'; await f.run('ordinary');
    assert.equal(state.transports, 2);
  });
});


test('adapter cooldown before dispatch defers without granting timeout recovery or consuming evidence', async t => {
  for (const mode of ['long-cooldown', 'deadline']) await t.test(mode, async t => {
    const { f, state } = await harness(t);
    f.api.providerCooldownUntil = state.now + (mode === 'deadline' ? 120000 : 600000);
    if (mode === 'deadline') f.api.wait = (_ms, signal) => new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true }));
    const run = await f.run('queued');
    assert.equal(state.transports, 0); assert.equal(state.requests.length, 0);
    assert.equal(run.wikiMaintenance.generationCalls, 0);
    assert.equal(run.wikiMaintenance.pages[0].reason, 'provider_cooldown_before_dispatch');
    assert.equal(f.topic().wikiEvidence.attemptedFingerprints.length, 0);
    assert.equal(f.topic().wikiMaintenance.timeoutRecovery, undefined);
    state.now = Math.max(state.now, f.topic().wikiMaintenance.nextRetryAt);
    f.api.providerCooldownUntil = 0;
    assert.equal((await f.run('later')).wikiMaintenance.generationCalls, 1);
  });
});
