'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs/promises'), os = require('node:os'), path = require('node:path');
const { runSideChatAgent } = require('../side-chat-agent.js');
const continuation = require('../agent-continuation.js');
const progress = require('../agent-progress.js');
const { ContextRecovery } = require('../context-recovery.js');
const call = (name, args = {}, id = 'call') => ({ id, type: 'function', function: { name, arguments: JSON.stringify(args) } });
const tools = (...calls) => ({ ok: true, message: { content: null, tool_calls: calls }, finishReason: 'stop' });
const answer = reply => ({ ok: true, message: { content: JSON.stringify({ reply }) } });
const local = { project: { workspaceId: 'progress-fixture' }, files: [{ name: 'notes.txt', relativePath: 'notes.txt', extension: 'txt', content: 'Measured yield: 42. ' + 'Observation. '.repeat(80) }] };
const run = (requestTurn, extra = {}) => runSideChatAgent({ originalRequest: 'Report the measured yield and explain remaining gaps.', conversationMessages: [{ role: 'user', content: 'Report the measured yield and explain remaining gaps.' }],
  workspaceContext: { localWorkspaceContext: local }, systemPrompt: 'Answer with JSON reply.', model: 'fixture/model',
  parseFinalAnswer: text => JSON.parse(text), requestTurn, ...extra });
const receipt = request => JSON.parse(request.messages.findLast(m => m.role === 'tool').content);
const recovery = request => request.messages.find(m => m.role === 'system' && m.content.startsWith('Observable progress recovery:'));

test('production loop detects unchanged retrieval, suppresses redispatch and lets the main model choose a useful read', async () => {
  let n = 0; const receipts = [];
  const result = await run(async request => {
    n++;
    if (n <= 3) return tools(call('list_workspace_items', {}, `list-${n}`));
    receipts.push(receipt(request));
    if (n === 4) {
      assert.equal(receipts[0].error, 'UNPRODUCTIVE_REPEAT_SUPPRESSED'); assert.ok(recovery(request));
      const earlier = request.messages.filter(m => m.role === 'tool').map(m => JSON.parse(m.content));
      return tools(call('read_workspace_item', { item_id: earlier[0].items[0].id }, 'read'));
    }
    assert.match(receipt(request).content, /Measured yield: 42/);
    return answer('The supplied notes report a measured yield of 42; units and conditions remain unspecified.');
  });
  assert.equal(result.ok, true); assert.equal(n, 5); assert.match(result.data.reply, /42/);
});

test('identical validation failures are suppressed before tool charges, including signed restoration', async () => {
  let n = 0;
  const first = await run(async request => {
    n++;
    if (n === 1) return tools(call('read_workspace_item', { item_id: 'missing' }, 'invalid'));
    assert.ok(recovery(request));
    return tools(call('search_project_knowledge', { query: 'yield' }, 'handoff'));
  }, { projectToolsEnabled: true });
  assert.equal(first.continuationState.totalToolCalls, 2);
  const binding = { project: 'progress-fixture' }, secret = 'test-only';
  const state = continuation.open(continuation.seal(first.continuationState, binding, secret), binding, secret);
  continuation.withResults(state, [{ id: 'handoff', result: { ok: true, findings: [{ text: 'Yield 42', sourceId: 'notes' }] } }]);
  let resumed = 0;
  const second = await run(async request => {
    resumed++;
    if (resumed === 1) return tools(call('read_workspace_item', { item_id: 'missing' }, 'same-invalid'));
    assert.equal(receipt(request).error, 'UNPRODUCTIVE_REPEAT_SUPPRESSED');
    assert.match(JSON.stringify(receipt(request)), /Unknown workspace item/);
    return tools(call('search_project_knowledge', { query: 'conditions' }, 'next-handoff'));
  }, { projectToolsEnabled: true, resume: state });
  assert.equal(second.continuationState.totalToolCalls, 3, 'repeated failure was not charged');
  assert.ok(second.continuationState.progressState.records.some(r => JSON.stringify(r.receipt).includes('Yield 42')));
  assert.throws(() => continuation.open(continuation.seal(state, binding, secret), { project: 'other' }, secret));
});

test('pagination and status polling remain eligible and respect the overall turn budget', async () => {
  let n = 0, id;
  const result = await run(async request => {
    n++;
    if (n === 1) return tools(call('list_workspace_items', {}, 'list'));
    if (n === 2) { id = receipt(request).items[0].id; return tools(call('read_workspace_item', { item_id: id, offset: 0, max_characters: 200 }, 'p1')); }
    if (n === 3) { assert.equal(receipt(request).offset, 0); return tools(call('read_workspace_item', { item_id: id, offset: 200, max_characters: 200 }, 'p2')); }
    if (n === 4) assert.equal(receipt(request).offset, 200);
    if (n <= 7) return tools(call('get_local_worker_status', {}, `poll-${n}`));
    assert.deepEqual(request.tools, []); assert.match(JSON.stringify(request.messages), /Final synthesis/);
    assert.notEqual(receipt(request).error, 'UNPRODUCTIVE_REPEAT_SUPPRESSED');
    return answer('The notes report yield 42. Further conditions remain unverified.');
  });
  assert.equal(result.ok, true); assert.equal(n, 8);
});

for (const failure of ['empty', 'invalid', 'unavailable']) test(`experiment retrieval preserves findings when final synthesis is ${failure}`, async () => {
  let n = 0;
  const result = await run(async request => {
    n++;
    if (n === 1) return tools(call('query_experiment_results', {}, 'experiment'));
    if (failure === 'unavailable') return { ok: false, error: 'LlmRequestFailed', transportCode: 'ECONNRESET', responseDiagnostics: { requestId: 'test-request', finishReason: 'stop', usage: { output_tokens: 0 } } };
    return { ok: true, message: { content: failure === 'empty' ? '' : '{broken JSON' }, finishReason: 'stop' };
  }, { originalRequest: 'Report experiment yield.', workspaceContext: { localWorkspaceContext: { ...local, files: [{ name: 'yield.csv', relativePath: 'experiments/yield.csv', extension: 'csv', content: 'sample,yield\nA,42' }] } } });
  assert.equal(result.ok, false); assert.match(result.data.reply, /42/); assert.match(result.data.reply, /partial|unresolved/i);
  assert.doesNotMatch(result.data.reply, /StepLimit|something went wrong/);
  if (failure === 'unavailable') { assert.equal(result.data.recoveryDiagnostics.transportCode, 'ECONNRESET'); assert.equal(result.data.recoveryDiagnostics.finishReason, 'stop'); }
});

test('no evidence gives a request-specific limitation; thrown provider exceptions expose only safe diagnostics', async () => {
  const result = await run(async () => { throw Object.assign(new Error('SECRET PROMPT'), { code: 'ECONNRESET' }); });
  assert.equal(result.ok, false); assert.match(result.data.reply, /measured yield/); assert.match(result.data.reply, /partial result/);
  assert.doesNotMatch(JSON.stringify(result), /SECRET PROMPT/); assert.equal(result.data.recoveryDiagnostics.transportCode, 'ECONNRESET');
});

test('a previous usable reply is retained only while subsequent host receipts do not contradict it', async () => {
  for (const changed of [false, true]) {
    const state = progress.initial(); state.lastReply = { reply: 'Earlier measured yield is 42.', revision: 0 };
    if (changed) progress.record(state, call('read_workspace_item', {}, 'new'), JSON.stringify({ content: 'Corrected measured yield is 24.' }));
    const result = await run(async () => ({ ok: true, message: { content: '' }, finishReason: 'stop' }), {
      resume: { progressState: state, agentMessages: [{ role: 'user', content: 'Report yield.' }], step: 7, totalToolCalls: 0 } });
    assert.equal(result.ok, false);
    if (changed) { assert.match(result.data.reply, /24/); assert.doesNotMatch(result.data.reply, /Earlier measured yield is 42/); }
    else assert.match(result.data.reply, /Earlier measured yield is 42/);
  }
});

test('archive compaction retains structured findings and reads do not create nested archives', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'progress-archive-')); t.after(() => fs.rm(root, { recursive: true, force: true }));
  const manager = new ContextRecovery({ config: { root }, model: 'fixture/model', requestId: 'archive-progress' });
  const raw = JSON.stringify({ padding: 'x'.repeat(15000), findings: ['Measured yield: 42'], citations: [{ sourceId: 'S1', reference: 'S1:p1' }], limitations: ['Units unavailable'], results: [{ status: 'saved', path: 'reports/result.txt' }] });
  const messages = [{ role: 'user', content: 'Report yield' }, { role: 'assistant', tool_calls: [call('query_experiment_results', {}, 'large')] }, { role: 'tool', name: 'query_experiment_results', tool_call_id: 'large', content: raw }];
  const compacted = await manager.offload(messages, 3000);
  const projected = JSON.parse(compacted.at(-1).content);
  assert.match(JSON.stringify(projected.findings), /Measured yield: 42/); assert.match(JSON.stringify(projected.findings), /S1:p1/);
  let n = 0;
  const result = await run(async request => {
    n++;
    if (n === 1) return tools(call('read_context_archive', { reference: projected.contextArchive, offset: raw.indexOf('findings'), limit: 1000 }, 'read-archive'));
    assert.match(receipt(request).content, /Measured yield/);
    const count = manager.state.references.length;
    const again = await manager.offload(request.messages, 1);
    assert.equal(again.find(m => m.tool_call_id === 'read-archive').content, request.messages.find(m => m.tool_call_id === 'read-archive').content);
    assert.equal(manager.state.references.length, count);
    return answer('Measured yield: 42; units remain unavailable.');
  }, { contextOptions: { config: { root }, requestId: 'archive-progress' }, resume: { agentMessages: compacted, contextRecovery: manager.snapshot(), step: 0, totalToolCalls: 0 } });
  assert.equal(result.ok, true); assert.equal(n, 2);
});

test('exhausted tool capacity reserves final synthesis and permissions cannot be granted by recovery', async () => {
  let n = 0;
  const result = await run(async request => {
    n++;
    if (n === 1) return tools(call('download_sources', { sources: [{ url: 'https://example.org/a.pdf' }] }, 'denied'));
    assert.match(JSON.stringify(receipt(request)), /blocked|permission|unknown/i);
    return answer('No files were saved; this session does not permit saving.');
  }, { surface: 'side_chat', desktopDownloads: true, downloadPermission: 'read_only' });
  assert.equal(result.data.desktopToolCalls, undefined); assert.match(result.data.reply, /No files/);
  let finalCalls = 0;
  const final = await run(async request => { finalCalls++; assert.deepEqual(request.tools, []); return answer('No experiment evidence is available in the supplied results.'); },
    { resume: { agentMessages: [{ role: 'user', content: 'Report yield' }], step: 3, totalToolCalls: 24 } });
  assert.equal(finalCalls, 1); assert.equal(final.ok, true);
});

test('actual main-loop partial reply survives a failed corrective synthesis without fabricating corpus completion', async () => {
  let n = 0;
  const result = await run(async () => ++n === 1 ? answer('The supplied notes report yield 42; a complete paper review is still pending.') : { ok: true, message: { content: '' }, finishReason: 'stop' },
    { originalRequest: 'Review all papers and discuss yield.', projectToolsEnabled: true });
  assert.equal(n, 2); assert.equal(result.ok, false); assert.match(result.data.reply, /supplied notes report yield 42/);
  assert.equal(result.data.corpusCoverage.complete, false);
});

test('repeated stalls end within two feedback turns and return useful evidence if the final reply is invalid', async () => {
  let n = 0, feedbacks = 0;
  const result = await run(async request => {
    n++;
    if (!request.tools.length) { assert.match(JSON.stringify(request.messages), /Final synthesis/); return { ok: true, message: { content: '{invalid' } }; }
    if (recovery(request)) feedbacks++;
    return tools(call('list_workspace_items', {}, `repeat-${n}`));
  });
  assert.equal(result.ok, false); assert.equal(feedbacks, 2); assert.ok(n <= 8);
  assert.match(result.data.reply, /notes.txt/); assert.match(result.data.reply, /partial/);
});

test('a transient tool failure permits one identical retry and is then suppressed', async () => {
  let n = 0, resume;
  for (let attempt = 0; attempt < 2; attempt++) {
    const result = await run(async () => { n++; return tools(call('search_project_knowledge', { query: 'yield' }, `transient-${attempt}`)); }, { projectToolsEnabled: true, resume });
    assert.equal(result.data.desktopToolCalls.length, 1);
    resume = continuation.withResults(result.continuationState, [{ id: `transient-${attempt}`, result: { ok: false, error: 'PROVIDER_TIMEOUT' } }]);
  }
  let requests = 0;
  const final = await run(async request => {
    requests++;
    if (requests === 1) return tools(call('search_project_knowledge', { query: 'yield' }, 'suppressed'));
    assert.equal(receipt(request).error, 'UNPRODUCTIVE_REPEAT_SUPPRESSED');
    return answer('The local provider timed out twice. I cannot verify the requested yield.');
  }, { projectToolsEnabled: true, resume });
  assert.equal(final.ok, true); assert.equal(n, 2); assert.equal(final.data.desktopToolCalls, undefined);
});

test('changed query with reordered identical provider evidence triggers adaptation across signed handoffs', async () => {
  let resume;
  for (const [i, query] of ['yield', 'yield evidence'].entries()) {
    const pending = await run(async () => tools(call('search_project_knowledge', { query }, `pool-${i}`)), { projectToolsEnabled: true, resume });
    const findings = [{ text: 'Measured yield 42', sourceId: 'S1' }, { text: 'Units unavailable', sourceId: 'S2' }];
    resume = continuation.withResults(pending.continuationState, [{ id: `pool-${i}`, result: { ok: true, query, findings: i ? findings.reverse() : findings, timestamp: i } }]);
  }
  const final = await run(async request => {
    assert.ok(recovery(request)); assert.match(recovery(request).content, /"newInformation":false/);
    return answer('Both searches return the same two observations: yield 42, with units unavailable.');
  }, { projectToolsEnabled: true, resume });
  assert.equal(final.ok, true);
});

test('expired deadline preserves evidence without a provider call or tool dispatch', async () => {
  const state = progress.initial(); progress.record(state, call('query_experiment_results', {}, 'result'), { records: [{ sample: 'A', yield: 42 }] });
  let requests = 0;
  const result = await run(async () => { requests++; throw Error('No call permitted'); }, {
    contextOptions: { config: { deadlineAt: Date.now() - 1 } },
    resume: { progressState: state, agentMessages: [{ role: 'user', content: 'Report yield' }], step: 2, totalToolCalls: 1 },
  });
  assert.equal(requests, 0); assert.equal(result.ok, false); assert.match(result.data.reply, /42/);
  assert.match(result.data.recoveryDiagnostics.blocker, /No generation time remains/);
});
