import test from 'node:test';
import assert from 'node:assert/strict';
import sessionApi from '../../docs/runtime-session.js';
import queueApi from '../../docs/runtime-turns.js';
import projectApi from '../../docs/project-context-service.js';
import contract from '../../shared/generic-subagent.js';

const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const tick = () => new Promise(resolve => setImmediate(resolve));
const mcpTool = { type: 'function', function: { name: 'mcp_fixture_read', description: 'Read', parameters: { type: 'object', properties: {}, additionalProperties: false } } };

async function fixture(extra = {}) {
  const calls = [], childCalls = [], statuses = [], queue = new queueApi.InjectionQueue();
  const project = { workspaceId: 'project-1' }, controller = new AbortController();
  const context = { project, agentLoop: { version: 1, paperIds: ['paper-a'] }, scope: { files: ['a.pdf'] },
    sourceMap: { paperSources: [{ sourceId: 'paper-a', contentHash: 'hash-a' }] }, literature: {}, notices: [] };
  const original = { options: { turnId: 'turn-1', question: 'Original user instruction', signal: controller.signal, callContext: { model: 'default' } },
    context, project, hardSelection: true, selected: ['paper-a'], paths: ['a.pdf'], sourceVersions: { 'paper-a': 'hash-a' }, sourceStats: { 'paper-a': 'stat-a' },
    calls: 0, receipts: new Map() };
  const service = { workspace: { workspace: project }, agentTurns: new Map([['turn-1', original]]),
    forkAgentTurn: projectApi.ProjectContextService.prototype.forkAgentTurn,
    pruneAgentTurns: projectApi.ProjectContextService.prototype.pruneAgentTurns };
  let current = true;
  const options = { mode: 'side_chat', model: 'default', originalRequest: 'Original user instruction $inspect',
    callContext: { turnId: 'turn-1' }, localWorkspaceContext: context, signal: controller.signal,
    desktopTools: { projectId: project.workspaceId, permission: 'read_only' }, ...extra.options };
  const workflow = async (id, input) => {
    calls.push({ id, input });
    if (extra.workflow) { const result = await extra.workflow(id, input); if (result !== undefined) return result; }
    if (id === 'runtime_skills_context') return { catalog: [
      { name: 'inspect', description: 'Inspect scientific evidence', enabled: true, available: true },
      { name: 'missing', enabled: true, available: false }, { name: 'disabled', enabled: false, available: true },
    ], active: [{ name: 'inspect', content: 'Read current evidence.' }] };
    if (id === 'runtime_skills_read') return { name: input.name, content: '---\nname: inspect\n---\nRead current evidence.', body: 'Read current evidence.' };
    if (id === 'runtime_mcp_definitions') return { tools: [mcpTool] };
    if (id === 'runtime_mcp_call') return { result: { content: [{ type: 'text', text: 'External plugin data' }] },
      receipt: { id: input.call.id, projectId: 'project-1' }, evidence: { kind: 'external_mcp', verified: false, projectId: 'project-1' } };
    throw new Error(`Unexpected workflow ${id}`);
  };
  const session = await sessionApi.create({ options, queue, service, workflow,
    isCurrent: () => current, onStatus: value => statuses.push(value),
    requestChild: async (child, input) => { childCalls.push({ child, input }); return extra.child ? extra.child(child, input) : { reply: 'Finding [[cite:paper-a]]', citations: [{ sourceId: 'paper-a', contentHash: 'hash-a' }], corpusCoverage: { complete: false } }; } });
  return { session, options, calls, childCalls, statuses, queue, service, controller, original, setCurrent: value => { current = value; } };
}

test('initial session captures enabled skills and keeps arbitrary MCP off Side Chat and ordinary Agent Work', async () => {
  for (const options of [{ mode: 'side_chat', desktopTools: { permission: 'full_access' } }, { mode: 'agent_instruction', desktopTools: { permission: 'read_only' } }]) {
    const f = await fixture({ options });
    assert.equal(f.session.extensions.genericSubagents, true); assert.equal(f.session.extensions.skills.active[0].name, 'inspect');
    assert.equal(f.session.extensions.mcpTools.length, 0); assert(!f.calls.some(call => call.id === 'runtime_mcp_definitions'));
    const receipt = await f.session.execute({ id: 'skill', name: 'read_skill', args: { name: 'inspect' } });
    assert.equal(receipt.result.ok, true); assert.match(receipt.result.value.body, /evidence/);
    assert.deepEqual(receipt.result.runtimeCall, { name: 'read_skill', args: { name: 'inspect' } });
    assert.deepEqual(f.calls.at(-1).input, { name: 'inspect', forAgent: true });
    for (const name of ['disabled', 'missing', 'newly-added']) assert.equal((await f.session.execute({ id: name, name: 'read_skill', args: { name } })).result.error.code, 'SKILL_UNAVAILABLE');
    assert.equal((await f.session.execute({ id: 'plugin', name: 'mcp_fixture_read', args: {} })).result.error.code, 'RUNTIME_TOOL_NOT_ALLOWED');
    await f.session.close();
  }
});

test('Full Access Agent Work preserves MCP provenance, namespaces durable receipts and deduplicates requests', async () => {
  const f = await fixture({ options: { mode: 'agent_instruction', desktopTools: { permission: 'full_access' } } });
  assert.equal(f.session.extensions.mcpTools[0].function.name, 'mcp_fixture_read');
  const call = { id: 'provider-call-1', name: 'mcp_fixture_read', args: { b: 2, a: 1 } };
  const result = await f.session.execute(call);
  assert.equal(result.id, call.id); assert.equal(result.result.ok, true); assert.equal(result.result.value.evidence.verified, false);
  assert.equal(result.result.value.receipt.id, `${f.session.parent.sessionId}:${call.id}`);
  const duplicate = await f.session.execute({ ...call, args: { a: 1, b: 2 } });
  assert.deepEqual(duplicate, result); assert.equal(f.calls.filter(call => call.id === 'runtime_mcp_call').length, 1);
  assert.equal(f.calls.at(-1).input.surface, 'agent_command'); assert.equal(f.calls.at(-1).input.permission, 'full_access');
  await assert.rejects(f.session.execute({ ...call, args: { a: 2 } }), { code: 'RUNTIME_RECEIPT_CONFLICT' });
  await f.session.close();
});

test('generic child loads enabled skills with no recursive spawn or MCP regardless of requested permissions', async () => {
  const child = contract.createChildRequest({ sessionId: 'parent-chat', requestId: 'parent-turn', projectId: 'project-1', model: 'selected/model', allowedTools: contract.READ_TOOLS },
    { task: 'Use $inspect to read the selected evidence.' }, { taskId: 'child-turn' });
  const f = await fixture({ options: { mode: 'agent_instruction', model: 'selected/model', runtimeChild: child.genericSubagent,
    desktopTools: { permission: 'full_access' } } });
  f.session.bindModel('selected/model');
  assert.equal(f.session.extensions.genericSubagents, false); assert.equal(f.session.extensions.child.taskId, 'child-turn');
  assert.equal(f.session.extensions.skills.active[0].name, 'inspect'); assert.equal(f.session.extensions.mcpTools.length, 0);
  assert(!f.calls.some(call => call.id === 'runtime_mcp_definitions'));
  const skill = await f.session.execute({ id: 'child-skill', name: 'read_skill', args: { name: 'inspect' } });
  assert.equal(skill.result.ok, true); assert.equal(skill.result.value.body, 'Read current evidence.'); assert.equal(skill.result.value.content, undefined);
  const recursive = await f.session.execute({ id: 'recursive', name: 'spawn', args: { task: 'Launch another agent' } });
  assert.equal(recursive.result.error.code, 'SUBAGENT_RECURSION_DENIED'); assert.equal(f.childCalls.length, 0);
  const mcp = await f.session.execute({ id: 'plugin', name: 'mcp_fixture_read', args: {} });
  assert.equal(mcp.result.error.code, 'RUNTIME_TOOL_NOT_ALLOWED'); await f.session.close();
});

test('child skill reads cannot widen an explicitly narrower parent capability list', async () => {
  const child = contract.createChildRequest({ sessionId: 'parent-chat', requestId: 'parent-turn', projectId: 'project-1', model: 'selected/model', allowedTools: ['list_papers'] },
    { task: 'Read papers' }, { taskId: 'child-turn' });
  const f = await fixture({ options: { model: 'selected/model', runtimeChild: child.genericSubagent } });
  const result = await f.session.execute({ id: 'denied-skill', name: 'read_skill', args: { name: 'inspect' } });
  assert.equal(result.result.error.code, 'SUBAGENT_TOOL_DENIED'); assert(!f.calls.some(call => call.id === 'runtime_skills_read'));
  await f.session.close();
});

test('large valid skills deliver instruction body once without duplicating full Markdown', async () => {
  const body = 'S'.repeat(63000);
  const f = await fixture({ workflow: id => id === 'runtime_skills_read' ? { name: 'inspect', content: '---\nname: inspect\n---\n' + body, body } : undefined });
  const result = await f.session.execute({ id: 'large-skill', name: 'read_skill', args: { name: 'inspect' } });
  assert.equal(result.result.ok, true); assert.equal(result.result.value.body, body); assert.equal(result.result.value.content, undefined);
  assert(JSON.stringify(result).length < 80000); await f.session.close();
});

test('oversized MCP returns explicit bounded failure, retaining call identity without leaking truncated output', async () => {
  const raw = { result: { content: [{ type: 'text', text: 'EXTERNAL_DATA_'.repeat(15000) }] }, evidence: { verified: false }, receipt: { id: 'durable-host-receipt' } };
  const f = await fixture({ options: { mode: 'agent_instruction', desktopTools: { permission: 'full_access' } },
    workflow: id => id === 'runtime_mcp_call' ? raw : undefined });
  const call = { id: 'large-plugin', name: 'mcp_fixture_read', args: { query: 'broad' } };
  const result = await f.session.execute(call);
  assert.equal(result.result.ok, false); assert.equal(result.result.error.code, 'RUNTIME_RESULT_TOO_LARGE');
  assert.deepEqual(result.result.runtimeCall, { name: call.name, args: call.args });
  assert.equal(result.result.value, undefined); assert(JSON.stringify(result).length < 80000);
  assert(!JSON.stringify(result).includes('EXTERNAL_DATA_')); assert.equal(raw.receipt.id, 'durable-host-receipt');
  assert.deepEqual(await f.session.execute(call), result); assert.equal(f.calls.filter(call => call.id === 'runtime_mcp_call').length, 1);
  await f.session.close();
});

test('subagent requires resolved model and immutable independent host scope before entering existing HTTP path', async () => {
  const f = await fixture();
  assert.equal((await f.session.execute({ id: 'unbound', name: 'spawn', args: { task: 'Read evidence' } })).result.error.code, 'MODEL_NOT_RESOLVED');
  assert.throws(() => f.session.bindModel('default'), { code: 'MODEL_NOT_RESOLVED' });
  f.session.bindModel('selected/model');
  const result = await f.session.execute({ id: 'spawn', name: 'spawn', args: { task: 'Read evidence', wait: true } });
  assert.equal(result.result.value.status, 'completed'); assert.equal(result.result.value.result.citations[0].contentHash, 'hash-a');
  const { child, input } = f.childCalls[0];
  assert.equal(child.model, 'selected/model'); assert.equal(child.messages.length, 1); assert.equal(child.messages[0].content, 'Read evidence');
  assert.deepEqual(child.genericSubagent.allowedTools, contract.READ_TOOLS);
  assert.deepEqual(input.context.agentLoop.paperIds, ['paper-a']); assert.equal(input.context.agentLoop.hardSelection, true);
  assert.equal(f.service.agentTurns.has(child.taskId), false); assert.equal(f.original.calls, 0);
  assert.throws(() => f.session.bindModel('different/model'), { code: 'SUBAGENT_MODEL_CHANGED' });
  assert.equal(f.session.manager.drain(f.session.parent).length, 0); await f.session.close();
});

test('explicit selected model cannot be rebound by response; completion reaches original queue exactly once', async () => {
  const work = deferred();
  const f = await fixture({ options: { model: 'chosen/model' }, child: () => work.promise });
  assert.throws(() => f.session.bindModel('other/model'), { code: 'SUBAGENT_MODEL_CHANGED' });
  f.session.bindModel('chosen/model');
  const receipt = await f.session.execute({ id: 'spawn', name: 'spawn', args: { task: 'Read evidence' } });
  const initial = await f.session.atCheckpoint({ agentCheckpoint: { version: 1, final: false }, runtimeAccepted: [] });
  assert.equal(initial.shouldContinue, true); assert.deepEqual(initial.injections, []);
  let finished = false;
  const final = f.session.atCheckpoint({ agentCheckpoint: { version: 1, final: true } }).then(value => { finished = true; return value; });
  await tick(); assert.equal(finished, false);
  work.resolve({ reply: 'Finding', citations: [{ sourceId: 'paper-a', contentHash: 'hash-a' }], evidence: { provenance: { hash: 'hash-a' } } });
  const delivered = await final;
  assert.equal(delivered.shouldContinue, true); assert.equal(delivered.injections.length, 1);
  const injection = delivered.injections[0]; assert.equal(injection.kind, 'subagent'); assert.equal(injection.taskId, receipt.result.value.task_id);
  assert.equal(JSON.parse(injection.content).result.evidence.provenance.hash, 'hash-a');
  assert.equal((await f.session.atCheckpoint({ agentCheckpoint: { final: false } })).injections.length, 1, 'Unacknowledged injection is safely retried');
  const accepted = await f.session.atCheckpoint({ agentCheckpoint: { final: true }, runtimeAccepted: [injection.id] });
  assert.equal(accepted.shouldContinue, false); assert.equal(accepted.injections.length, 0); assert.equal(f.queue.closed, true);
  assert.equal(f.statuses.filter(status => status.status === 'completed').length, 1); await f.session.close();
});

test('large subagent result emits explicit failure without presenting truncated evidence', async () => {
  const f = await fixture({ child: async () => ({ reply: 'x'.repeat(65000), citations: [{ sourceId: 'paper-a' }] }) });
  f.session.bindModel('selected/model');
  await f.session.execute({ id: 'spawn', name: 'spawn', args: { task: 'Task' } });
  const checkpoint = await f.session.atCheckpoint({ agentCheckpoint: { final: true } });
  assert.equal(checkpoint.injections.length, 1);
  const result = JSON.parse(checkpoint.injections[0].content);
  assert.equal(result.error, 'SUBAGENT_RESULT_TOO_LARGE'); assert.equal(result.result, undefined);
  assert.equal(result.evidenceStatus, 'unavailable'); await f.session.close();
});

test('waited child results use the same explicit delivery limit and preserve the signed call header', async () => {
  const f = await fixture({ child: async () => ({ reply: 'x'.repeat(65000), citations: [{ sourceId: 'paper-a' }] }) });
  f.session.bindModel('selected/model');
  const call = { id: 'waited', name: 'spawn', args: { task: 'Task', wait: true } };
  const receipt = await f.session.execute(call);
  assert.equal(receipt.result.ok, true); assert.deepEqual(receipt.result.runtimeCall, { name: call.name, args: call.args });
  assert.equal(receipt.result.value.status, 'failed'); assert.equal(receipt.result.value.error, 'SUBAGENT_RESULT_TOO_LARGE');
  assert.equal(receipt.result.value.result, undefined); await f.session.close();
});

test('request invalidation blocks results and cancellation closes running children without leaking host turns', async () => {
  const f = await fixture({ child: (_child, { signal }) => new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(Object.assign(new Error('Cancelled'), { code: 'OPERATION_ABORTED' })), { once: true })) });
  f.session.bindModel('selected/model');
  await f.session.execute({ id: 'spawn', name: 'spawn', args: { task: 'Task' } });
  await tick(); assert.equal(f.service.agentTurns.size, 2);
  f.setCurrent(false);
  await assert.rejects(f.session.atCheckpoint({}), { code: 'OPERATION_ABORTED' });
  await f.session.close();
  assert.equal(f.session.manager.tasks.size, 0); assert.equal(f.session.manager.parents.size, 0); assert.equal(f.service.agentTurns.size, 1);
  await assert.rejects(f.session.execute({ id: 'late', name: 'read_skill', args: { name: 'inspect' } }), { code: 'OPERATION_ABORTED' });
});

test('tool response after project switch is rejected even if workflow successfully returns', async () => {
  const work = deferred();
  const f = await fixture({ workflow: (id) => id === 'runtime_skills_read' ? work.promise : undefined });
  const pending = f.session.execute({ id: 'skill', name: 'read_skill', args: { name: 'inspect' } });
  f.setCurrent(false); work.resolve({ name: 'inspect', body: 'Result from old project' });
  await assert.rejects(pending, { code: 'OPERATION_ABORTED' }); await f.session.close();
});

for (const action of ['abort', 'close']) test(`MCP ${action} cancels exact namespaced host call without retrying uncertain work`, async () => {
  const work = deferred();
  const f = await fixture({ options: { mode: 'agent_instruction', desktopTools: { permission: 'full_access' } },
    workflow: (id, input) => {
      if (id === 'runtime_mcp_call') return work.promise;
      if (id === 'runtime_mcp_cancel') { work.resolve({ error: 'cancelled' }); return { cancelled: true, callId: input.callId }; }
    } });
  const call = { id: 'slow-plugin', name: 'mcp_fixture_read', args: {} };
  const pending = f.session.execute(call);
  if (action === 'abort') f.controller.abort(); else await f.session.close();
  await assert.rejects(pending, { code: 'OPERATION_ABORTED' });
  const cancellations = f.calls.filter(call => call.id === 'runtime_mcp_cancel');
  assert.equal(cancellations.length, 1);
  assert.equal(cancellations[0].input.callId, `${f.session.parent.sessionId}:slow-plugin`);
  assert.equal(f.calls.filter(call => call.id === 'runtime_mcp_call').length, 1);
  await f.session.close();
});

test('queued user input is acknowledged durably and terminal checkpoint closes queue atomically', async () => {
  const f = await fixture(); f.queue.enqueue('Add comparison', { id: 'input-1' });
  const first = await f.session.atCheckpoint({ agentCheckpoint: { final: true } });
  assert.equal(first.shouldContinue, true); assert.equal(first.injections[0].kind, 'user'); assert.equal(f.queue.closed, false);
  const final = await f.session.atCheckpoint({ agentCheckpoint: { final: true }, runtimeAccepted: ['input-1'] });
  assert.equal(final.shouldContinue, false); assert.equal(f.queue.snapshot()[0].status, 'received');
  assert.throws(() => f.queue.enqueue('Too late'), { code: 'TURN_CLOSED' }); await f.session.close();
});

test('runtime session holds active scope through setup and releases it exactly once when closed', async () => {
  const f = await fixture(); assert.equal(f.original.runtimeUsers, 1);
  for (let i = 0; i < 24; i++) f.service.forkAgentTurn('turn-1', `queued-child-${i}`, 'Task');
  f.service.agentTurns.set('independent-turn', { options: {}, context: {}, project: f.original.project });
  f.service.pruneAgentTurns('independent-turn');
  assert.equal(f.service.agentTurns.size, 26); assert(f.service.agentTurns.has('turn-1'));
  await f.session.close(); assert.equal(f.original.runtimeUsers, 0); assert.equal(f.service.agentTurns.size, 12);
  assert.equal(f.service.agentTurns.has('turn-1'), false);
  await f.session.close(); assert.equal(f.original.runtimeUsers, 0);
});

test('stored conversation preserves only bounded injection delivery metadata for user messages', () => {
  const message = { id: 'm', role: 'user', content: 'Queued correction', createdAt: new Date().toISOString(), injection: { turnId: 'turn-1', status: 'queued', extra: 'drop' } };
  const normalize = input => projectApi.normalizeStoredConversation({ messages: [input] }).messages[0];
  assert.deepEqual(normalize(message).injection, { turnId: 'turn-1', status: 'queued' });
  for (const status of ['received', 'not_received']) assert.equal(normalize({ ...message, injection: { turnId: 'turn-1', status } }).injection.status, status);
  assert.equal(normalize({ ...message, role: 'assistant' }).injection, undefined);
  assert.equal(normalize({ ...message, injection: { turnId: 'x'.repeat(129), status: 'queued' } }).injection, undefined);
  assert.equal(normalize({ ...message, injection: { turnId: 'turn-1', status: 'invented' } }).injection, undefined);
});
