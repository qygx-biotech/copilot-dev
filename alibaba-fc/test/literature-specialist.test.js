'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { runSideChatAgent } = require('../../shared/agent/side-chat-agent.js');
const { withResults } = require('../../shared/agent/receipt-admission.js');
const contract = require('../../shared/literature-agent.js');
const specialist = require('../../shared/agent/literature-specialist.js');
const call = (name, args, id = name) => ({ id, type: 'function', function: { name, arguments: JSON.stringify(args) } });
const run = (requestTurn, extra = {}) => runSideChatAgent({ originalRequest: 'Find relevant enzyme papers and write a report.', conversationMessages: [{ role: 'user', content: 'Find relevant enzyme papers and write a report.' }],
  workspaceContext: { localWorkspaceContext: { project: { workspaceId: 'project-1' }, agentLoop: { version: 1 } } }, model: 'selected/model', surface: 'agent_command', desktopLiterature: true, desktopAcademic: true,
  systemPrompt: 'Complete the user deliverable.', parseFinalAnswer: reply => ({ reply }), requestTurn, ...extra });

test('general main answers without a classification or mandatory literature call; retrieval is offered behind the confirmation card, never in plan mode', async () => {
  let count = 0;
  // Consent is the renderer's one-click card, so wording no longer decides whether retrieval is offered.
  const result = await run(async request => { count++; assert(request.tools.some(t => t.function?.name === 'discover_papers')); assert(request.tools.some(t => t.function?.name === 'retrieve_papers')); assert(!request.tools.some(t => t.function?.name === 'plan_literature_search')); return { ok: true, message: { content: 'A direct answer.' } }; }, { originalRequest: 'Rewrite this sentence.' });
  assert.equal(count, 1); assert.equal(result.data.reply, 'A direct answer.');
  const planned = await run(async request => { assert(request.tools.some(t => t.function?.name === 'discover_papers')); assert(!request.tools.some(t => t.function?.name === 'retrieve_papers')); return { ok: true, message: { content: 'A plan.' } }; },
    { originalRequest: 'Plan a literature review and download papers.', collaborationMode: 'plan', downloadPermission: 'workspace_write' });
  assert.equal(planned.data.reply, 'A plan.');
});

test('signed handoffs keep browser snapshots in the specialist and main completes the report', async () => {
  const task = { objective: 'enzyme evidence', queries: ['enzyme'] };
  const first = await run(async () => ({ ok: true, message: { tool_calls: [call('discover_papers', task)] } }));
  assert.equal(first.data.desktopToolCalls[0].name, 'literature_worker');
  let state = first.continuationState;
  const job_id = 'lit_' + 'a'.repeat(24);
  state = withResults(state, [{ id: state.pending[0].id, result: { job_id, tools: [contract.tool('finish_discovery', 'Finish', contract.object({ candidates: contract.array(contract.candidate, 40), limitations: contract.array(contract.text(2000), 30) }))], observation: 'RAW_SNAPSHOT_ONLY_IN_SPECIALIST [ref=e1]' } }]);
  const second = await run(async request => {
    assert.equal(request.stage, 'literature-specialist'); assert(JSON.stringify(request.messages).includes('RAW_SNAPSHOT_ONLY_IN_SPECIALIST'));
    assert.deepEqual(JSON.parse(request.messages.filter(message => message.role === 'user')[1].content), { observation: 'RAW_SNAPSHOT_ONLY_IN_SPECIALIST [ref=e1]' });
    assert.equal(request.tools[0].function.name, 'finish_discovery');
    return { ok: true, message: { tool_calls: [call('finish_discovery', { candidates: [], limitations: ['No match in attempted query.'] })] } };
  }, { resume: state });
  assert(!JSON.stringify(second.continuationState.agentMessages).includes('RAW_SNAPSHOT_ONLY_IN_SPECIALIST'));
  const final = { version: 1, job_id, status: 'partial', candidates: [], searches: [{ query: 'enzyme', source: 'catalogue' }], limitations: ['No match in attempted query.'] };
  state = withResults(second.continuationState, [{ id: second.continuationState.pending[0].id, result: { final } }]);
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
test('specialist model receives full large observations on resume and after browser calls', async () => {
  const snapshot = '- paragraph "Library result details"\n'.repeat(1000) + '- link "Final paper" [ref=e45]';
  for (const resumed of [true, false]) {
    const state = ready();
    if (resumed) specialist.accept(state, { job_id: state.jobId, tools: state.schemas, observation: snapshot });
    else {
      state.pendingModelCall = { id: 'snapshot' };
      specialist.accept(state, { result: { status: 'observed', snapshot, truncated: false } });
    }
    let requested = false;
    await specialist.advance(state, { requestTurn: async request => {
      requested = true;
      const content = JSON.parse(request.messages.at(-1).content);
      assert.equal(resumed ? content.observation : content.snapshot, snapshot);
      return { ok: true, message: { tool_calls: [call('finish_discovery', { candidates: [], limitations: ['Fixture result'] })] } };
    } });
    assert.equal(requested, true);
  }
});

test('specialist handoff keeps schemas and access rules outside the observation-only user message', () => {
  const state = ready();
  assert.deepEqual(JSON.parse(state.messages.at(-1).content), { observation: '' });
  const tools = state.schemas;
  specialist.accept(state, {
    job_id: state.jobId, tools, observation: 'Refreshed library snapshot [ref=e2]',
    checkpoint: { status: 'partial' }, access: { open_access_only: true }
  });
  assert.equal(state.schemas, tools);
  assert.equal(state.openAccessOnly, true);
  assert.match(state.messages.at(-2).content, /institutional browsing is disabled/); assert.match(state.messages.at(-2).content, /do not omit strong candidates/);
  assert.deepEqual(JSON.parse(state.messages.at(-1).content), { observation: 'Refreshed library snapshot [ref=e2]' });
  state.pendingModelCall = { id: 'click' };
  const receipt = { status: 'stale_reference', snapshot: 'Updated snapshot [ref=e3]', generation: 2 };
  specialist.accept(state, { result: receipt });
  assert.deepEqual(state.messages.at(-1), { role: 'tool', tool_call_id: 'click', content: JSON.stringify(receipt) });
});
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
  const resumed = withResults(first.continuationState, [{ id: first.data.desktopToolCalls[0].id, result: { job_id: 'lit_' + 'a'.repeat(24), tools: [] } }]);
  const result = await run(async () => ({ ok: false, error: 'LlmRequestFailed', message: 'fetch failed', transportError: { causeCode: 'ECONNRESET' } }), { resume: resumed });
  assert.equal(result.ok, false); assert.equal(result.error, 'LlmRequestFailed'); assert.equal(result.failure.transportError.causeCode, 'ECONNRESET');
  assert.equal(result.data.desktopToolCalls, undefined); assert.equal(resumed.specialist.final, undefined);
});
test('nested hosted-search failure propagates through the real search stage and specialist', async t => {
  t.mock.method(console, 'error', () => {});
  const first = await run(async () => ({ ok: true, message: { tool_calls: [call('discover_papers', { objective: 'enzyme', queries: ['enzyme'] })] } }));
  const resumed = withResults(first.continuationState, [{ id: first.data.desktopToolCalls[0].id, result: { job_id: 'lit_' + 'a'.repeat(24), tools: [] } }]);
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

const snapshotTool = contract.tool('browser_snapshot', 'Observe the page', contract.object({}));
const restoreWithReceipt = (state, response) => {
  const pending = specialist.handoff(state), binding = { model: 'selected/model', project: 'project-1' };
  const restored = { specialist: state, pending: [pending] };
  return withResults(restored, [{ id: pending.id, result: response }]).specialist;
};
test('a mixed batch drains in order across signed continuations before requesting the next model turn', async () => {
  let state = ready(); state.schemas.push(snapshotTool);
  const batch = [call('browser_snapshot', {}, 'first'), call('browser_snapshot', {}, 'second'), call('search_web', { query: 'enzyme' }, 'third')];
  let models = 0, searches = 0;
  const options = { supportsWebSearch: true, search: async () => { searches++; return 'Verified enzyme metadata'; }, requestTurn: async request => {
    models++;
    if (models === 1) return { ok: true, message: { content: 'Observe twice, then search.', tool_calls: batch } };
    const assistantIndex = request.messages.findIndex(message => message.role === 'assistant');
    assert.deepEqual(request.messages[assistantIndex].tool_calls, batch);
    const replies = request.messages.slice(assistantIndex + 1);
    assert.deepEqual(replies.map(message => message.role), ['tool', 'tool', 'tool']);
    assert.deepEqual(replies.map(message => message.tool_call_id), ['first', 'second', 'third']);
    assert.match(replies[0].content, /STALE_REFERENCE/); assert.match(replies[1].content, /fresh snapshot/);
    assert.match(replies[2].content, /Verified enzyme metadata/); assert.match(replies[2].content, /recorded/);
    return { ok: true, message: { tool_calls: [call('finish_discovery', { candidates: [], limitations: ['No matching papers.'] })] } };
  } };
  await specialist.advance(state, options);
  const first = specialist.handoff(state); assert.equal(specialist.handoff(state).id, first.id);
  assert.equal(state.pending.name, 'browser_snapshot'); assert.equal(models, 1); assert.equal(searches, 0);
  state = restoreWithReceipt(state, { error: 'STALE_REFERENCE', message: 'The page changed.' });
  await specialist.advance(state, options);
  const second = specialist.handoff(state);
  assert.equal(second.args.name, 'browser_snapshot'); assert.notEqual(second.id, first.id);
  assert.equal(models, 1); assert.equal(searches, 0);
  state = restoreWithReceipt(state, { result: { snapshot: 'fresh snapshot' } });
  await specialist.advance(state, options);
  assert.equal(state.pending.action, 'web_receipt'); assert.equal(models, 1); assert.equal(searches, 1);
  state = restoreWithReceipt(state, { result: { recorded: true } });
  await specialist.advance(state, options);
  assert.equal(models, 2); assert.equal(state.pending.name, 'finish_discovery');
});
test('cancellation between queued calls prevents the remaining tools and model requests', async () => {
  let state = ready(); state.schemas.push(snapshotTool);
  const controller = new AbortController(); let models = 0, searches = 0;
  const options = { signal: controller.signal, supportsWebSearch: true, search: async () => { searches++; }, requestTurn: async () => {
    models++; return { ok: true, message: { tool_calls: [call('browser_snapshot', {}), call('search_web', { query: 'enzyme' })] } };
  } };
  await specialist.advance(state, options);
  state = restoreWithReceipt(state, { result: { snapshot: 'observed' } });
  controller.abort();
  await assert.rejects(specialist.advance(state, options), { code: 'OPERATION_ABORTED' });
  assert.equal(models, 1); assert.equal(searches, 0); assert.equal(state.pending, null);
});
for (const status of ['needs_login', 'cancelled', 'completed']) test(`host terminal status ${status} stops queued tools`, async () => {
  let state = ready(); state.schemas.push(snapshotTool); let models = 0;
  const options = { requestTurn: async () => { models++; return { ok: true, message: { tool_calls: [call('browser_snapshot', {}, 'first'), call('browser_snapshot', {}, 'second')] } }; } };
  await specialist.advance(state, options);
  state = restoreWithReceipt(state, { final: { version: 1, job_id: state.jobId, status, candidates: [], searches: [], limitations: [] } });
  await specialist.advance(state, options);
  assert.equal(models, 1); assert.equal(state.pending, null); assert.deepEqual(state.queuedCalls, []);
});
test('an invalid later tool cannot bypass validation by riding behind a valid tool', async t => {
  const state = ready(); state.schemas.push(snapshotTool); t.mock.method(console, 'error', () => {});
  let models = 0;
  await specialist.advance(state, { requestTurn: async () => {
    models++;
    return { ok: true, message: { tool_calls: models === 1
      ? [call('browser_snapshot', {}), call('browser_run_code_unsafe', { code: 'unsafe' })]
      : [call('finish_discovery', { candidates: [], limitations: ['Corrected tool selection.'] })] } };
  } });
  assert.equal(models, 2); assert.equal(state.calls, 1); assert.equal(state.pending.name, 'finish_discovery');
});
test('retrieval batches execute requested papers in order before finalization', async () => {
  const paper = { title: 'enzyme', authors: [], source_urls: [] };
  let state = specialist.create('retrieve_papers', { papers: [paper, { ...paper, title: 'another enzyme' }], accepted_versions: ['published'] }, 'main');
  specialist.accept(state, { job_id: 'lit_' + 'b'.repeat(24), tools: [contract.tool('retrieve_next', 'Retrieve', contract.object({ index: { type: 'integer' } })), contract.tool('finish_retrieval', 'Finish', contract.object({}))] });
  let models = 0;
  const options = { requestTurn: async () => { models++; return { ok: true, message: { tool_calls: [call('retrieve_next', { index: 0 }, 'first'), call('retrieve_next', { index: 1 }, 'second'), call('finish_retrieval', {})] } }; } };
  for (const index of [0, 1]) {
    await specialist.advance(state, options); assert.equal(state.pending.name, 'retrieve_next'); assert.equal(state.pending.args.index, index);
    state = restoreWithReceipt(state, { result: { status: 'access_unavailable', reason: 'No authorized download route.' } });
  }
  await specialist.advance(state, options); assert.equal(state.pending.name, 'finish_retrieval'); assert.equal(models, 1);
});

const inputLimit = () => ({ ok: false, status: 429, error: 'LlmHttpError', message: 'Input token quota exceeded', inputQuota: { retryAfterMs: 25, evidence: 'structured_input_quota_code' } });
async function withToolHistory() {
  let state = ready(); state.schemas.push(snapshotTool);
  const contents = ['older '.repeat(80), 'x'.repeat(120), 'oldest large result '.repeat(50), 'newest result '.repeat(80)];
  for (let index = 0; index < contents.length; index++) {
    await specialist.advance(state, { requestTurn: async () => ({ ok: true, message: { tool_calls: contents.map((_, i) => call('browser_snapshot', {}, `history_${i}`)) } }) });
    state = restoreWithReceipt(state, { result: contents[index] });
  }
  // The 120-character boundary is measured on actual serialized tool content.
  state.messages.filter(message => message.role === 'tool')[1].content = 'x'.repeat(120);
  return state;
}
test('only a confirmed input quota failure compacts old tool results, preserves the newest and retries the same specialist', async () => {
  const state = await withToolHistory(), before = structuredClone(state.messages), events = [];
  let requests = 0;
  await specialist.advance(state, { onProgress: async event => events.push(event), requestTurn: async request => {
    requests++;
    if (requests === 1) { assert.deepEqual(request.messages, before); return inputLimit(); }
    assert.equal(request.retryAfterMs, 25);
    const results = request.messages.filter(message => message.role === 'tool');
    assert.equal(results[0].content, '[Earlier tool result compacted. Re-run if needed.]');
    assert.equal(results[2].content, results[0].content);
    assert.equal(results[1].content.length, 120);
    assert.deepEqual(results[3], before.filter(message => message.role === 'tool')[3]);
    assert.deepEqual(request.messages.filter(message => message.role !== 'tool'), before.filter(message => message.role !== 'tool'));
    assert.deepEqual(results.map(message => message.tool_call_id), ['history_0', 'history_1', 'history_2', 'history_3']);
    return { ok: true, message: { tool_calls: [call('browser_snapshot', {}, 'retry_first'), call('finish_discovery', { candidates: [], limitations: ['Explicit model finish'] })] } };
  } });
  assert.equal(requests, 2); assert.equal(state.pending.name, 'browser_snapshot'); assert.equal(state.queuedCalls[0].call.function.name, 'finish_discovery');
  assert.equal(events.filter(event => event.stage === 'literature-specialist-compacted')[0].replacedToolResults, 2);
  const resumed = restoreWithReceipt(state, { result: 'fresh snapshot' });
  await specialist.advance(resumed, { requestTurn: async () => assert.fail('Queued tool must not call the model') });
  assert.equal(resumed.pending.name, 'finish_discovery');
});
for (const outcome of [
  { ok: true, message: { tool_calls: [call('browser_snapshot', {})] } },
  { ok: false, status: 429, error: 'LlmHttpError', message: 'Too many requests' },
  { ok: false, status: 429, error: { code: 'output_token_rate_limit', message: 'Output token quota exceeded' } },
  { ok: false, status: 401, error: 'UNAUTHORIZED' },
]) test(`no preflight compaction or compaction for unrelated response ${JSON.stringify(outcome)}`, async t => {
  const state = await withToolHistory(), before = structuredClone(state.messages); let requests = 0;
  t.mock.method(console, 'error', () => {});
  await specialist.advance(state, { requestTurn: async request => { requests++; assert.deepEqual(request.messages, before); return outcome; } });
  assert.equal(requests, 1); assert.deepEqual(state.messages.slice(0, before.length), before);
});
test('a repeated input quota failure stops with the real error once nothing more can be compacted', async t => {
  const state = await withToolHistory(); let requests = 0; t.mock.method(console, 'error', () => {});
  const result = await specialist.advance(state, { requestTurn: async () => { requests++; return inputLimit(); } });
  assert.equal(requests, 2); assert.equal(result.ok, false); assert.equal(result.error, 'LlmHttpError');
  assert.equal(state.pending, null); assert.equal(state.final, undefined);
  const single = ready(); single.messages.push({ role: 'tool', tool_call_id: 'only', content: 'Keep this newest result'.repeat(20) });
  requests = 0;
  await specialist.advance(single, { requestTurn: async () => { requests++; return inputLimit(); } });
  assert.equal(requests, 1); assert.match(single.messages.at(-1).content, /Keep this newest result/);
});
test('thrown input quota errors recover, and cancellation after compaction prevents a retry', async t => {
  t.mock.method(console, 'error', () => {});
  const state = await withToolHistory(); let requests = 0;
  await specialist.advance(state, { requestTurn: async () => {
    if (++requests === 1) throw Object.assign(new Error('Input token quota exceeded'), { status: 429, code: 'input_token_quota_exceeded' });
    return { ok: true, message: { tool_calls: [call('browser_snapshot', {})] } };
  } });
  assert.equal(requests, 2);
  const cancelled = await withToolHistory(), controller = new AbortController(); requests = 0;
  await assert.rejects(specialist.advance(cancelled, { signal: controller.signal,
    onProgress: async event => { if (event.stage === 'literature-specialist-compacted') controller.abort(); },
    requestTurn: async () => { requests++; return inputLimit(); },
  }), { code: 'OPERATION_ABORTED' });
  assert.equal(requests, 1); assert.equal(cancelled.pending, null);
});

// Deterministic retrieval: the host works through every paper without model turns.
const retrievalTools = names => names.map(name => contract.tool(name, name, contract.object({})));
const retrievalPaper = title => ({ title, authors: ['A. Author'], year: 2024, source_urls: [] });
const retrievalState = (count, access) => {
  const state = specialist.create('retrieve_papers', { papers: Array.from({ length: count }, (_, i) => retrievalPaper(`Paper ${i}`)), accepted_versions: ['published'] }, 'main');
  specialist.accept(state, { job_id: 'lit_' + 'c'.repeat(24), tools: retrievalTools(['retrieve_next', 'finish_retrieval']), checkpoint: {}, observation: '',
    access: { open_access_only: false, library_url: 'https://library.example.edu', deterministic: true, browsing: false, library_browsing: true, ...access } });
  return state;
};
const noModel = { requestTurn: async () => assert.fail('The deterministic sequence must not call the model') };
const outcome = status => ({ result: { requested: retrievalPaper('x'), status, document_version: 'unknown', attempts: [], reason: `${status} fixture` } });
test('retrieval runs every paper, requests access once, retries, and browses the library only for papers still missing', async () => {
  let state = retrievalState(3), progress = [];
  const steps = [];
  const drive = async (receipt, options = noModel) => {
    await specialist.advance(state, { ...options, onProgress: async event => progress.push(event) });
    steps.push(state.pending.name + (Number.isInteger(state.pending.args.index) ? `:${state.pending.args.index}` : ''));
    state = restoreWithReceipt(state, receipt);
  };
  await drive(outcome('downloaded'));
  await drive(outcome('needs_login'));
  await drive(outcome('unresolved'));
  // The resumed job after the user signed in.
  await drive({ job_id: state.jobId, tools: retrievalTools(['retrieve_next', 'finish_retrieval']), checkpoint: {}, observation: '', access: { deterministic: true }, resumed: true });
  await drive(outcome('downloaded'));
  await drive({ job_id: state.jobId, tools: retrievalTools(['browser_snapshot', 'capture_article', 'record_access', 'finish_retrieval']), checkpoint: {}, observation: 'Library home [ref=e1]', access: { deterministic: true, browsing: true } });
  assert.deepEqual(steps, ['retrieve_next:0', 'retrieve_next:1', 'retrieve_next:2', 'request_access', 'retrieve_next:1', 'start_browsing']);
  assert.deepEqual(progress.filter(event => event.paper).map(event => `${event.paper}/${event.papers}`), ['1/3', '2/3', '3/3', '2/3']);
  // Per-paper receipts stay out of the model conversation; only the open papers' summary is given for browsing.
  assert(!state.messages.some(message => message.role !== 'system' && /fixture/.test(message.content)));
  assert(!state.messages.some(message => /downloaded fixture|needs_login fixture/.test(message.content)));
  let models = 0;
  await specialist.advance(state, { requestTurn: async request => {
    models++;
    const summary = request.messages.find(message => message.role === 'system' && message.content.includes('Papers still without a verified download'));
    assert.match(summary.content, /"index":2/); assert.doesNotMatch(summary.content, /"index":[01]/);
    assert.equal(JSON.parse(request.messages.at(-1).content).observation, 'Library home [ref=e1]');
    assert.deepEqual(request.tools.map(tool => tool.function.name), ['browser_snapshot', 'capture_article', 'record_access', 'finish_retrieval']);
    return { ok: true, message: { tool_calls: [call('finish_retrieval', {})] } };
  } });
  assert.equal(models, 1); assert.equal(state.pending.name, 'finish_retrieval');
  const results = ['downloaded', 'downloaded', 'unresolved'].map((status, i) => ({ requested: retrievalPaper(`Paper ${i}`), status, document_version: 'unknown',
    attempts: Array.from({ length: 10 }, (_, n) => ({ route: 'open_access', reason: `attempt ${n}` })), reason: 'fixture' }));
  state = restoreWithReceipt(state, { final: { version: 1, job_id: state.jobId, status: 'partial', results, limitations: [] } });
  assert.equal(state.final.status, 'partial'); assert.equal(state.final.results[2].attempts.length, 4);
});
test('without library browsing the sequence finishes after its access round with no model call', async () => {
  let state = retrievalState(2, { library_browsing: false, open_access_only: true }), steps = [];
  for (const receipt of [outcome('downloaded'), outcome('unresolved')]) {
    await specialist.advance(state, noModel); steps.push(state.pending.name); state = restoreWithReceipt(state, receipt);
  }
  await specialist.advance(state, noModel); steps.push(state.pending.name);
  assert.deepEqual(steps, ['retrieve_next', 'retrieve_next', 'finish_retrieval']);
  assert(!state.messages.some(message => message.role === 'system' && /search only open-access papers|institutional browsing is disabled/.test(message.content)), 'Discovery access rules do not apply to retrieval');
});
test('an access round the user skips ends the job with the papers already saved', async () => {
  let state = retrievalState(1, { library_browsing: false });
  await specialist.advance(state, noModel); state = restoreWithReceipt(state, outcome('needs_login'));
  await specialist.advance(state, noModel); assert.equal(state.pending.name, 'request_access');
  const results = [{ requested: retrievalPaper('Paper 0'), status: 'needs_login', document_version: 'unknown', attempts: [], reason: 'Sign in' }];
  state = restoreWithReceipt(state, { final: { version: 1, job_id: state.jobId, status: 'cancelled', results, limitations: [] } });
  assert.equal(state.final.status, 'cancelled'); assert.equal(state.pending, null);
});
test('model-directed library browsing is bounded and finishes with host receipts', async () => {
  let state = retrievalState(1);
  await specialist.advance(state, noModel); state = restoreWithReceipt(state, outcome('unresolved'));
  await specialist.advance(state, noModel); assert.equal(state.pending.name, 'start_browsing');
  state = restoreWithReceipt(state, { job_id: state.jobId, tools: retrievalTools(['browser_snapshot', 'finish_retrieval']), checkpoint: {}, observation: 'Library', access: { deterministic: true } });
  state.driver.modelTurns = 20;
  await specialist.advance(state, noModel);
  assert.equal(state.pending.name, 'finish_retrieval');
});
test('oversized page observations are shortened instead of failing the specialist', () => {
  const state = ready();
  state.pendingModelCall = { id: 'snapshot' };
  specialist.accept(state, { result: { status: 'observed', snapshot: '- paragraph "row"\n'.repeat(12000) } });
  const message = state.messages.at(-1);
  assert(message.content.length < 150000); assert.match(message.content, /shortened by the host; use browser_find/);
});
test('library browsing keeps only the latest page observation in full; earlier ones become a short note', async () => {
  let state = retrievalState(1);
  await specialist.advance(state, noModel); state = restoreWithReceipt(state, outcome('unresolved'));
  await specialist.advance(state, noModel);
  const tools = retrievalTools(['browser_snapshot', 'browser_click', 'finish_retrieval']);
  state = restoreWithReceipt(state, { job_id: state.jobId, tools, checkpoint: {}, observation: 'Library', access: { deterministic: true } });
  const page = n => `- link "Result ${n}" [ref=e${n}]\n` + '- paragraph "Catalogue record details"\n'.repeat(200);
  let turn = 0;
  const options = { requestTurn: async request => {
    turn++;
    const observations = request.messages.filter(message => message.role === 'tool').map(message => JSON.parse(message.content));
    if (turn === 3) {
      assert.equal(observations.length, 2);
      assert.match(observations[0].snapshot, /Earlier page observation omitted/); assert.equal(observations[0].status, 'observed');
      assert.match(observations[1].snapshot, /Result 2/);
      return { ok: true, message: { tool_calls: [call('finish_retrieval', {}, `finish`)] } };
    }
    return { ok: true, message: { tool_calls: [call('browser_click', { target: `e${turn}` }, `click_${turn}`)] } };
  } };
  for (const n of [1, 2]) { await specialist.advance(state, options); state = restoreWithReceipt(state, { result: { status: 'observed', snapshot: page(n) } }); }
  await specialist.advance(state, options);
  assert.equal(state.pending.name, 'finish_retrieval'); assert.equal(turn, 3);
});
