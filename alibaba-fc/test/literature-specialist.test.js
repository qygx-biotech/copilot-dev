'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { runSideChatAgent } = require('../side-chat-agent.js');
const continuation = require('../agent-continuation.js');
const contract = require('../../shared/literature-agent.js');
const specialist = require('../literature-specialist.js');
const call = (name, args, id = name) => ({ id, type: 'function', function: { name, arguments: JSON.stringify(args) } });
const run = (requestTurn, extra = {}) => runSideChatAgent({ originalRequest: 'Find relevant enzyme papers and write a report.', conversationMessages: [{ role: 'user', content: 'Find relevant enzyme papers and write a report.' }],
  workspaceContext: { localWorkspaceContext: { project: { workspaceId: 'project-1' }, agentLoop: { version: 1 } } }, model: 'selected/model', surface: 'agent_command', desktopLiterature: true, desktopAcademic: true,
  systemPrompt: 'Complete the user deliverable.', parseFinalAnswer: reply => ({ reply }), requestTurn, ...extra });

test('general main answers without a classification or mandatory literature call; retrieval not exposed for report request', async () => {
  let count = 0;
  const result = await run(async request => { count++; assert(request.tools.some(t => t.function?.name === 'discover_papers')); assert(!request.tools.some(t => t.function?.name === 'retrieve_papers')); assert(!request.tools.some(t => t.function?.name === 'plan_literature_search')); return { ok: true, message: { content: 'A direct answer.' } }; }, { originalRequest: 'Rewrite this sentence.' });
  assert.equal(count, 1); assert.equal(result.data.reply, 'A direct answer.');
});

test('signed handoffs keep browser snapshots in the specialist and main completes the report', async () => {
  const task = { objective: 'enzyme evidence', queries: ['enzyme'] };
  const first = await run(async () => ({ ok: true, message: { tool_calls: [call('discover_papers', task)] } }));
  assert.equal(first.data.desktopToolCalls[0].name, 'literature_worker');
  const binding = { model: 'selected/model', project: 'project-1' };
  let state = continuation.open(continuation.seal(first.continuationState, binding, 'secret'), binding, 'secret');
  assert.throws(() => continuation.open(continuation.seal(state, binding, 'secret'), { ...binding, model: 'other' }, 'secret'));
  const job_id = 'lit_' + 'a'.repeat(24);
  state = continuation.withResults(state, [{ id: state.pending[0].id, result: { job_id, tools: [contract.tool('finish_discovery', 'Finish', contract.object({ candidates: contract.array(contract.candidate, 40), limitations: contract.array(contract.text(2000), 30) }))], observation: 'RAW_SNAPSHOT_ONLY_IN_SPECIALIST [ref=e1]' } }]);
  const second = await run(async request => {
    assert.equal(request.stage, 'literature-specialist'); assert(JSON.stringify(request.messages).includes('RAW_SNAPSHOT_ONLY_IN_SPECIALIST'));
    return { ok: true, message: { tool_calls: [call('finish_discovery', { candidates: [], limitations: ['No match in attempted query.'] })] } };
  }, { resume: state });
  assert(!JSON.stringify(second.continuationState.agentMessages).includes('RAW_SNAPSHOT_ONLY_IN_SPECIALIST'));
  const final = { version: 1, job_id, status: 'partial', candidates: [], searches: [{ query: 'enzyme', source: 'catalogue' }], limitations: ['No match in attempted query.'] };
  state = continuation.withResults(second.continuationState, [{ id: second.continuationState.pending[0].id, result: { final } }]);
  const third = await run(async request => { assert.equal(request.stage, 'local-tools'); assert(!JSON.stringify(request.messages).includes('RAW_SNAPSHOT_ONLY_IN_SPECIALIST')); assert(JSON.stringify(request.messages).includes('No match in attempted query.')); return { ok: true, message: { content: 'Report with explicit search limitations.' } }; }, { resume: state });
  assert.equal(third.data.reply, 'Report with explicit search limitations.');
});

test('specialist cannot invent a successful retrieval receipt or tool name', async () => {
  const state = specialist.create('discover_papers', { objective: 'papers', queries: ['enzyme'] }, 'main');
  assert.throws(() => specialist.accept(state, { final: { status: 'downloaded' } }));
  assert.throws(() => contract.validate(contract.tasks.retrieve_papers, { papers: [], accepted_versions: ['published'], permission: 'full_access' }));
  assert.throws(() => contract.validate(contract.tasks.discover_papers, { objective: 'x', queries: ['x'], code: 'process.exit()' }));
});

const ready = () => {
  const state = specialist.create('discover_papers', { objective: 'papers', queries: ['enzyme'] }, 'main');
  specialist.accept(state, { job_id: 'lit_' + 'b'.repeat(24), tools: [contract.tool('finish_discovery', 'Finish', contract.object({ candidates: contract.array(contract.candidate, 40), limitations: contract.array(contract.text(2000), 30) }))] });
  return state;
};
for (const limit of ['turns', 'calls', 'time', 'characters']) test(`specialist continues past former ${limit} cutoff and only uses model-selected finalization`, async () => {
  const state = ready();
  if (limit === 'turns') state.turns = 100;
  if (limit === 'calls') state.calls = 100;
  if (limit === 'time') state.startedAt = Date.now() - 24 * 60 * 60000;
  if (limit === 'characters') state.messages.push({ role: 'user', content: 'Observed evidence '.repeat(20000) });
  let calls = 0;
  await specialist.advance(state, { requestTurn: async () => { calls++; return { ok: true, message: { tool_calls: [call('finish_discovery', { candidates: [], limitations: ['Model-selected result'] })] } }; } });
  assert.equal(calls, 1); assert.deepEqual(state.pending.args.limitations, ['Model-selected result']);
  assert.equal(state.final, undefined);
});
test('provider failure preserves diagnostics and gathered evidence without calling finish_discovery', async t => {
  const state = ready(), logs = [], messages = JSON.stringify(state.messages);
  t.mock.method(console, 'error', (...entry) => logs.push(entry));
  const failure = await specialist.advance(state, { requestTurn: async () => ({ ok: false, error: 'LlmHttpError', message: 'HTTP 429 quota exceeded', status: 429, attempts: 2, providerCodes: ['rate_limit_exceeded'] }) });
  assert.equal(failure.error, 'LlmHttpError'); assert.equal(failure.failure.providerStatus, 429); assert.equal(failure.failure.providerAttempts, 2);
  assert.equal(failure.failure.jobId, state.jobId); assert.match(failure.reason, /quota exceeded/);
  assert.equal(state.pending, null); assert.equal(state.final, undefined); assert.equal(JSON.stringify(state.messages), messages);
  assert.equal(logs.length, 1); assert.doesNotMatch(JSON.stringify(logs), /budget exhausted|candidates/);
});
test('thrown transport cause is retained; cancellation stops the unlimited loop', async t => {
  const state = ready(); t.mock.method(console, 'error', () => {});
  const failed = await specialist.advance(state, { requestTurn: async () => { throw new TypeError('fetch failed', { cause: Object.assign(new Error('socket closed'), { code: 'UND_ERR_SOCKET' }) }); } });
  assert.equal(failed.failure.causeCode, 'UND_ERR_SOCKET'); assert.equal(failed.reason, 'fetch failed');
  const controller = new AbortController(); let calls = 0;
  await assert.rejects(specialist.advance(state, { signal: controller.signal, onProgress: async () => controller.abort(), requestTurn: async () => { calls++; } }), { code: 'OPERATION_ABORTED' });
  assert.equal(calls, 0); assert.equal(state.pending, null);
});
test('web search remains available after three calls and errors are not finalized as no candidates', async t => {
  const state = ready(); state.webCalls = 10; t.mock.method(console, 'error', () => {});
  const failed = await specialist.advance(state, { supportsWebSearch: true,
    requestTurn: async request => { assert(request.tools.some(tool => tool.function.name === 'search_web')); return { ok: true, message: { tool_calls: [call('search_web', { query: 'enzyme' })] } }; },
    search: async () => { throw Object.assign(new Error('Search provider unavailable'), { code: 'SEARCH_PROVIDER_FAILED' }); } });
  assert.equal(failed.error, 'SEARCH_PROVIDER_FAILED'); assert.equal(failed.failure.failureStage, 'literature-specialist.web-search'); assert.equal(state.pending, null);
});
test('main loop reports specialist provider failure instead of handing off an empty finalization', async t => {
  t.mock.method(console, 'error', () => {});
  const first = await run(async () => ({ ok: true, message: { tool_calls: [call('discover_papers', { objective: 'enzyme', queries: ['enzyme'] })] } }));
  const resumed = continuation.withResults(first.continuationState, [{ id: first.data.desktopToolCalls[0].id, result: { job_id: 'lit_' + 'a'.repeat(24), tools: [] } }]);
  const result = await run(async () => ({ ok: false, error: 'LlmRequestFailed', message: 'fetch failed', transportError: { causeCode: 'ECONNRESET' } }), { resume: resumed });
  assert.equal(result.ok, false); assert.equal(result.error, 'LlmRequestFailed'); assert.equal(result.failure.transportError.causeCode, 'ECONNRESET');
  assert.equal(result.data.desktopToolCalls, undefined); assert.equal(resumed.specialist.final, undefined);
});
test('nested hosted-search failure propagates through the real search stage and specialist', async t => {
  t.mock.method(console, 'error', () => {});
  const first = await run(async () => ({ ok: true, message: { tool_calls: [call('discover_papers', { objective: 'enzyme', queries: ['enzyme'] })] } }));
  const resumed = continuation.withResults(first.continuationState, [{ id: first.data.desktopToolCalls[0].id, result: { job_id: 'lit_' + 'a'.repeat(24), tools: [] } }]);
  const stages = [];
  const result = await run(async request => {
    stages.push(request.stage);
    return request.stage === 'literature-specialist'
      ? { ok: true, message: { tool_calls: [call('search_web', { query: 'enzyme' })] } }
      : { ok: false, error: 'WEB_SEARCH_PROVIDER_ERROR', message: 'The provider rejected hosted web search.', status: 422, requestId: 'search-fixture' };
  }, { resume: resumed, supportsWebSearch: true });
  assert.deepEqual(stages, ['literature-specialist', 'web-search']);
  assert.equal(result.ok, false); assert.equal(result.error, 'WEB_SEARCH_PROVIDER_ERROR');
  assert.equal(result.failure.providerStatus, 422); assert.equal(result.failure.requestId, 'search-fixture');
  assert.equal(result.failure.failureStage, 'literature-specialist.web-search');
  assert.equal(result.data.desktopToolCalls, undefined); assert.equal(resumed.specialist.final, undefined);
});
