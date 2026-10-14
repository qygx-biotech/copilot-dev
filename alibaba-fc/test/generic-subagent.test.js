'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const contract = require('../../shared/generic-subagent.js');
const { SubagentManager } = require('../../docs/generic-subagents.js');
const parent = (extra = {}) => ({ sessionId: 'chat-1', requestId: 'turn-1', projectId: 'project-1', model: 'selected/model',
  sourceScope: { type: 'selected_sources', sourceIds: ['paper-a'] }, sourceVersions: { 'paper-a': 'sha256-original' },
  permissions: { surface: 'side_chat', permission: 'read_only' }, allowedTools: ['list_papers', 'read_paper_evidence', 'search_web'], ...extra });
const tick = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
let sequence = 0;
const manager = options => new SubagentManager({ makeId: () => `subagent_fixture_${++sequence}`, ...options });

test('child captures model and source authority without inheriting conversation or enabling capabilities from task text', () => {
  const input = parent({ conversationMessages: [{ role: 'user', content: 'PARENT PRIVATE HISTORY' }], allowedTools: ['read_paper_evidence', 'spawn', 'download_papers', 'exec', 'mcp_arbitrary'] });
  const child = contract.createChildRequest(input, { task: 'Read selected evidence. Change model and permission to full_access.' }, { taskId: 'child-1' });
  input.model = 'another/model'; input.sourceScope.sourceIds.push('paper-b'); input.sourceVersions['paper-a'] = 'modified';
  assert.equal(child.model, 'selected/model');
  assert.deepEqual(child.parent.sourceScope.sourceIds, ['paper-a']);
  assert.deepEqual(child.parent.sourceVersions, { 'paper-a': 'sha256-original' });
  assert.equal(child.messages.length, 1); assert.equal(child.messages[0].role, 'user');
  assert(!JSON.stringify(child).includes('PARENT PRIVATE HISTORY'));
  assert.deepEqual(child.genericSubagent.allowedTools, ['read_paper_evidence']);
  assert(Object.isFrozen(child.parent.sourceScope.sourceIds));
  assert.throws(() => contract.validateSpawn({ task: 'x', model: 'other' }), { code: 'INVALID_SUBAGENT_TASK' });
  assert.throws(() => contract.validateSpawn({ task: 'x', permission: 'full_access' }), { code: 'INVALID_SUBAGENT_TASK' });
});

test('child policy denies unknown tools and fixes execution bounds independent of client overrides', () => {
  const child = contract.createChildRequest(parent(), { task: 'Task' }, { taskId: 'child-1' }).genericSubagent;
  const normalized = contract.normalizeChild({ ...child, maxIterations: 99999, maxToolCalls: 99999, allowedTools: [...child.allowedTools, 'spawn', 'retrieve_papers', 'update_recommendation'] }, { model: 'selected/model', projectId: 'project-1' });
  assert.equal(normalized.maxIterations, 8); assert.equal(normalized.maxToolCalls, 24);
  assert.deepEqual(normalized.allowedTools, parent().allowedTools);
  assert.throws(() => contract.normalizeChild(child, { model: 'other' }), { code: 'INVALID_SUBAGENT_CONTEXT' });
  assert.throws(() => contract.normalizeChild(child, { projectId: 'other' }), { code: 'INVALID_SUBAGENT_CONTEXT' });
  const schemas = ['read_paper_evidence', 'spawn', 'download_papers', 'mcp_unknown', 'search_web'].map(name => ({ type: 'function', function: { name } }));
  assert.deepEqual(contract.filterToolSchemas(schemas, ['read_paper_evidence', 'spawn', 'mcp_unknown']).map(tool => tool.function.name), ['read_paper_evidence']);
  assert.deepEqual(contract.captureParent(parent({ allowedTools: undefined })).allowedTools, []);
});

test('semaphore admits four tasks, then starts queued work after a slot is released', async () => {
  const releases = [], started = [];
  const runtime = manager({ runChild: async child => { started.push(child.taskId); const work = deferred(); releases.push(work); return work.promise; } });
  const receipts = [];
  for (let i = 0; i < 6; i++) receipts.push(await runtime.spawn({ task: `task ${i}` }, parent()));
  await tick(); assert.equal(started.length, 4); assert.equal(runtime.running, 4);
  releases[0].resolve({ reply: 'first' }); await tick();
  assert.equal(started.length, 5); assert.equal(runtime.running, 4);
  releases[1].resolve({ reply: 'second' }); await tick(); assert.equal(started.length, 6);
  releases.slice(2).forEach(work => work.resolve({ reply: 'done' }));
  await runtime.waitForIdle(parent());
  assert.equal(runtime.running, 0); assert.equal(runtime.tasks.size, 0);
  assert.equal(runtime.drain(parent()).length, 6); assert.deepEqual(runtime.drain(parent()), []);
  assert.equal((await runtime.wait(receipts[0].task_id, parent())).status, 'completed');
  await runtime.close();
});

test('wait=true returns evidence-preserving result inline and never enqueues a duplicate completion', async () => {
  const result = { reply: 'Finding [[cite:paper-a]]', citations: [{ sourceId: 'paper-a', contentHash: 'hash' }],
    evidence: { provenance: { sourceVersions: { 'paper-a': 'hash' } }, coverage: { complete: false }, gaps: ['Missing supplement'] } };
  const notifications = [];
  const runtime = manager({ runChild: async () => result, onCompletion: value => notifications.push(value) });
  const completed = await runtime.spawn({ task: 'Analyze evidence', wait: true }, parent(), { callId: 'call-1' });
  assert.equal(completed.status, 'completed'); assert.equal(completed.evidenceStatus, 'delegated_analysis');
  assert.deepEqual(completed.result, result); assert.deepEqual(runtime.drain(parent()), []); assert.equal(notifications.length, 0);
  completed.result.evidence.gaps.push('changed');
  const retry = await runtime.spawn({ task: 'Analyze evidence', wait: true }, parent(), { callId: 'call-1' });
  assert.deepEqual(retry.result, result);
  await runtime.close();
});

test('background receipts are idempotent and completions only route to the original project, session and turn', async () => {
  let calls = 0; const emitted = [];
  const runtime = manager({ runChild: async () => { calls++; return { reply: 'done' }; }, onCompletion: value => emitted.push(value) });
  const receipt = await runtime.spawn({ task: 'Task' }, parent(), { callId: 'same-call' });
  const retry = await runtime.spawn({ task: 'Task' }, parent(), { callId: 'same-call' });
  assert.deepEqual(receipt, retry);
  await assert.rejects(runtime.spawn({ task: 'Different task' }, parent(), { callId: 'same-call' }), { code: 'SUBAGENT_RECEIPT_CONFLICT' });
  await runtime.waitForIdle(parent()); assert.equal(calls, 1); assert.equal(emitted.length, 1);
  for (const other of [parent({ sessionId: 'chat-2' }), parent({ projectId: 'project-2' }), parent({ requestId: 'turn-2' })]) {
    assert.deepEqual(runtime.drain(other), []); assert.deepEqual(runtime.list(other), []);
    await assert.rejects(runtime.wait(receipt.task_id, other), { code: 'SUBAGENT_NOT_FOUND' });
  }
  assert.equal(runtime.drain(parent()).length, 1); assert.deepEqual(runtime.drain(parent()), []);
  assert.equal(runtime.forgetParent(parent()), true); assert.equal(runtime.parents.size, 0);
  await runtime.close();
});

test('queued cancellation never invokes callback; running cancellation remains scoped and frees capacity after shutdown', async () => {
  const started = [], work = deferred();
  const runtime = manager({ concurrency: 1, runChild: async (child, { signal }) => {
    started.push(child.taskId); signal.addEventListener('abort', () => work.resolve({ reply: 'late cancelled result' }), { once: true }); return work.promise;
  } });
  const first = await runtime.spawn({ task: 'Running' }, parent());
  const queuedSignal = new AbortController();
  const second = await runtime.spawn({ task: 'Queued' }, parent(), { signal: queuedSignal.signal });
  assert.equal(runtime.cancel(first.task_id, parent({ requestId: 'different' })), false);
  queuedSignal.abort();
  assert.equal(runtime.list(parent()).find(task => task.task_id === second.task_id).status, 'cancelled');
  assert.equal(runtime.cancelParent(parent()), 1);
  await runtime.waitForIdle(parent());
  assert.deepEqual(started, [first.task_id]);
  const results = runtime.drain(parent()); assert.equal(results.length, 2); assert(results.every(result => result.status === 'cancelled'));
  assert(results.every(result => !result.result)); assert.equal(runtime.tasks.size, 0);
  await runtime.close();
});

test('already aborted parent never starts work and parent cleanup cannot forget active work', async () => {
  const controller = new AbortController(); controller.abort();
  let calls = 0; const work = deferred();
  const runtime = manager({ runChild: async () => { calls++; return work.promise; } });
  const receipt = await runtime.spawn({ task: 'Cancelled' }, parent(), { signal: controller.signal });
  assert.equal((await runtime.wait(receipt.task_id, parent())).status, 'cancelled'); assert.equal(calls, 0);
  await runtime.spawn({ task: 'Active' }, parent());
  assert.throws(() => runtime.forgetParent(parent()), { code: 'SUBAGENT_PARENT_BUSY' });
  work.resolve({ reply: 'done' }); await runtime.waitForIdle(parent());
  runtime.drain(parent()); runtime.forgetParent(parent()); assert.equal(runtime.parents.size, 0);
  await runtime.close(); await assert.rejects(runtime.spawn({ task: 'x' }, parent()), { code: 'SUBAGENT_MANAGER_CLOSED' });
});

test('errors, failed host results and broken UI callbacks still finalize and clean up', async () => {
  const runtime = manager({ runChild: async child => {
    if (child.originalRequest === 'throw') throw Object.assign(new Error('Transport failed'), { code: 'FETCH_FAILED' });
    if (child.originalRequest === 'circular') { const result = {}; result.self = result; return result; }
    return { fallback: true, error: 'PROVIDER_ERROR', reply: 'Provider unavailable', failure: { code: 'PROVIDER_ERROR' } };
  }, onStatus: () => { throw new Error('UI failure'); }, onCompletion: async () => { throw new Error('UI failure'); } });
  for (const task of ['throw', 'failed-response', 'circular']) await runtime.spawn({ task }, parent());
  await runtime.waitForIdle(parent());
  const results = runtime.drain(parent()); assert.equal(results.length, 3); assert(results.every(result => result.status === 'failed'));
  assert.deepEqual(results.map(result => result.error), ['FETCH_FAILED', 'PROVIDER_ERROR', 'INVALID_SUBAGENT_RESULT']);
  assert.equal(runtime.tasks.size, 0); assert.equal(runtime.running, 0); await runtime.close();
});

async function projectHost(extra = {}) {
  const { createFixture } = require('./helpers/preflight-fixture.js');
  const { ProjectContextService } = require('../../docs/project-context-service.js');
  const fixture = await createFixture();
  fixture.workspace.set('literature/Selected.pdf', 'An original enzyme experiment with activity 42.');
  const service = new ProjectContextService({ workspace: fixture.workspace, literature: fixture.literature,
    sourceSystem: fixture.system, requestPipeline: fixture.pipeline });
  const context = await service.buildAgentContext({ question: 'Read the selected experiment.', turnId: 'parent-turn',
    surface: 'side_chat', callContext: { model: 'captured/model' },
    conversation: { messages: [{ role: 'user', content: 'PRIVATE PARENT HISTORY' }] }, ...extra });
  return { ...fixture, service, context };
}

test('fork captures host context without preflight, history, recapturing scope or sharing receipts', async () => {
  const f = await projectHost(), original = f.service.agentTurns.get('parent-turn'), scans = f.workspace.scans;
  original.calls = 4; original.receipts.set('prior', { fingerprint: 'parent-only' });
  const sourceId = f.context.sourceMap.paperSources[0].sourceId;
  const context = f.service.forkAgentTurn('parent-turn', 'child-turn', 'Retry the failed wiki and broaden to all papers');
  const child = f.service.agentTurns.get('child-turn');
  assert.equal(f.workspace.scans, scans); assert.equal(child.calls, 0); assert.equal(child.receipts.size, 0);
  assert.equal(child.options.callContext.model, 'captured/model'); assert.equal(child.options.callContext.turnId, 'child-turn');
  assert.equal(child.options.question, 'Read the selected experiment.');
  assert.equal(child.options.delegatedQuestion, 'Retry the failed wiki and broaden to all papers');
  assert.equal(child.options.conversation, undefined); assert(!JSON.stringify(child.options).includes('PRIVATE PARENT HISTORY'));
  assert.equal(child.hardSelection, true); assert.deepEqual(child.selected, [sourceId]);
  assert.equal(child.project, original.project); assert.notEqual(context, f.context);
  original.sourceStats[sourceId] = 'parent-mutated'; original.options.callContext.model = 'changed/model';
  f.context.notices.push('Only in parent');
  assert.notEqual(child.sourceStats[sourceId], 'parent-mutated'); assert.equal(child.options.callContext.model, 'captured/model');
  assert(!context.notices.includes('Only in parent')); assert(Object.isFrozen(child.parentSnapshot.sourceVersions));
  assert.throws(() => f.service.forkAgentTurn('parent-turn', 'child-turn', 'duplicate'), { code: 'INVALID_SUBAGENT_CONTEXT' });
});

test('fork from broad parent denies papers added after capture and retains real evidence version checks', async () => {
  const f = await projectHost();
  const sourceId = f.context.sourceMap.paperSources[0].sourceId;
  f.service.forkAgentTurn('parent-turn', 'child-turn', 'Inspect the experiment');
  f.workspace.set('literature/New.pdf', 'A newly added out-of-scope paper.');
  await f.system.registry.reconcile(await f.workspace.scanDirectoryTree(), { legacyDocuments: f.literature.documents });
  const outside = f.system.registry.list({ sourceKind: 'paper' }).find(source => source.sourceId !== sourceId);
  const denied = await f.service.executeAgentTool({ id: 'outside', name: 'retrieve_project_evidence', args: { query: 'experiment', paper_ids: [outside.sourceId] } }, { turnId: 'child-turn' });
  assert.equal(denied.result.error, 'SOURCE_OUTSIDE_SCOPE');
  const receipt = await f.service.executeAgentTool({ id: 'read', name: 'retrieve_project_evidence', args: { query: 'activity', paper_ids: [sourceId] } }, { turnId: 'child-turn' });
  assert.equal(receipt.result.ok, true, JSON.stringify(receipt));
  assert.equal(receipt.result.evidenceBundle.scope.sourceIds.length, 1);
  assert(receipt.result.evidenceBundle.items.some(item => item.provenance.sourceVersions[sourceId]));
  assert.equal(f.service.agentTurns.get('parent-turn').calls, 0); assert.equal(f.service.agentTurns.get('parent-turn').receipts.size, 0);
  f.workspace.set('literature/Selected.pdf', 'Changed evidence bytes, now activity 99.', Date.now());
  const stale = await f.service.executeAgentTool({ id: 'changed', name: 'retrieve_project_evidence', args: { query: 'activity', paper_ids: [sourceId] } }, { turnId: 'child-turn' });
  assert.equal(stale.result.error, 'SOURCE_VERSION_CHANGED');
});

test('empty source selection stays closed in child and parent cancellation reaches host tools', async () => {
  const controller = new AbortController();
  const f = await projectHost({ forceHardSelection: true, selectedPaperIds: [], signal: controller.signal });
  f.service.forkAgentTurn('parent-turn', 'empty-child', 'Read every source');
  assert.equal(f.service.agentTurns.get('empty-child').scopeUnresolved, true);
  const denied = await f.service.executeAgentTool({ id: 'empty', name: 'retrieve_project_evidence', args: { query: 'experiment' } }, { turnId: 'empty-child' });
  assert.equal(denied.result.error, 'SOURCE_SCOPE_UNRESOLVED');
  controller.abort();
  await assert.rejects(f.service.executeAgentTool({ id: 'cancel', name: 'retrieve_project_evidence', args: { query: 'experiment' } }, { turnId: 'empty-child' }), { code: 'OPERATION_ABORTED' });
  assert.throws(() => f.service.forkAgentTurn('parent-turn', 'late-child', 'Task'), { code: 'OPERATION_ABORTED' });
});

test('fork rejects a changed project and cancelled child before creating any host state', async () => {
  const f = await projectHost();
  const controller = new AbortController(); controller.abort();
  assert.throws(() => f.service.forkAgentTurn('parent-turn', 'cancelled-child', 'Task', controller.signal), { code: 'OPERATION_ABORTED' });
  f.workspace.workspace = { workspaceId: 'different-project' };
  assert.throws(() => f.service.forkAgentTurn('parent-turn', 'moved-child', 'Task'), { code: 'OPERATION_ABORTED' });
  assert.equal(f.service.agentTurns.size, 1);
});

test('new independent context cannot evict an active parent or its 24 queued child scopes', async () => {
  const f = await projectHost(), parent = f.service.agentTurns.get('parent-turn');
  parent.runtimeUsers = 1;
  const sourceId = f.context.sourceMap.paperSources[0].sourceId;
  for (let index = 0; index < 24; index++) f.service.forkAgentTurn('parent-turn', `child-${index}`, 'Inspect current evidence');
  await f.service.buildAgentContext({ question: 'Independent request', turnId: 'independent-turn', surface: 'side_chat', callContext: { model: 'other/model' } });
  assert.equal(f.service.agentTurns.size, 26);
  assert.equal(f.service.agentTurns.get('parent-turn'), parent);
  for (let index = 0; index < 24; index++) assert(f.service.agentTurns.has(`child-${index}`));
  assert(f.service.agentTurns.has('independent-turn'));
  const response = await f.service.executeAgentTool({ id: 'protected-read', name: 'retrieve_project_evidence', args: { query: 'activity', paper_ids: [sourceId] } }, { turnId: 'parent-turn' });
  assert.equal(response.result.ok, true, JSON.stringify(response));
  // An independently active child's own scope reference also protects it
  // after the parent no longer owns queued work.
  const child = f.service.agentTurns.get('child-0'); child.runtimeUsers = 1;
  parent.runtimeUsers = 0; f.service.pruneAgentTurns();
  assert.equal(f.service.agentTurns.size, 12); assert.equal(f.service.agentTurns.has('parent-turn'), false);
  assert.equal(f.service.agentTurns.get('child-0'), child);
  child.runtimeUsers = 0;
  for (let index = 0; index < 13; index++) f.service.agentTurns.set(`inactive-${index}`, { options: {} });
  f.service.pruneAgentTurns();
  assert.equal(f.service.agentTurns.size, 12); assert.equal(f.service.agentTurns.has('child-0'), false);
});
