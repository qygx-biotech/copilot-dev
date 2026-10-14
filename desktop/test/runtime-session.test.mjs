import test from 'node:test';
import assert from 'node:assert/strict';
import sessionApi from '../../docs/runtime-session.js';
import queueApi from '../../docs/runtime-turns.js';
import projectApi from '../../docs/project-context-service.js';
import contract from '../../shared/generic-subagent.js';
import runtime from '../../shared/runtime-extensions.js';
import toolContract from '../../shared/runtime-tools.js';
import registryApi from '../../docs/runtime-tool-registry.js';

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
    pruneAgentTurns: projectApi.ProjectContextService.prototype.pruneAgentTurns, ...extra.service };
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
    isCurrent: () => current, onStatus: value => statuses.push(value), interaction: extra.interaction,
    requestChild: async (child, input) => { childCalls.push({ child, input }); return extra.child ? extra.child(child, input) : { reply: 'Finding [[cite:paper-a]]', citations: [{ sourceId: 'paper-a', contentHash: 'hash-a' }], corpusCoverage: { complete: false } }; } });
  return { session, options, calls, childCalls, statuses, queue, service, controller, original, setCurrent: value => { current = value; } };
}

test('Code Mode excludes direct-only scratch file tools before host dispatch and continues permitted subcalls', async t => {
  const replies = [], nested = ['apply_patch', 'view_image', 'image_gen_imagegen', 'notes_write_file'];
  const f = await fixture({ options: { mode: 'agent_instruction', desktopTools: { permission: 'workspace_write' } },
    interaction: { confirm: async () => true, close() {} }, workflow: async (id, input) => {
      if (id === 'runtime_skills_context') return { advancedRuntimeVersion: 1, catalog: [], active: [] };
      if (id === 'runtime_advanced_open') return { scratch: true, image: true };
      if (id === 'runtime_advanced_close') return {};
      if (id === 'runtime_advanced_call') {
        assert.equal(input.call.name, 'run_code', 'nested file tools must never reach the host');
        return { cell_id: 'cell:fixture', status: 'running', tool_calls: nested.map((name, i) => ({ id: `cell:fixture:${i}`, name, args: name === 'notes_write_file' ? { path: 'safe', text: 'saved' } : {} })) };
      }
      if (id === 'runtime_advanced_reply') { replies.push(...input.results); return { cell_id: 'cell:fixture', status: 'completed' }; }
    } });
  t.after(() => f.session.close()); f.session.bindModel('fixture');
  const result = await f.session.execute({ id: 'code', name: 'run_code', args: { code: 'fixture' } });
  assert.equal(result.result.value.status, 'completed');
  assert.deepEqual(replies.slice(0, 3).map(reply => reply.result.error.code), Array(3).fill('NESTED_TOOL_DENIED'));
  assert.equal(replies[3].result.ok, true);
});

test('V2 agents fork scoped history, receive messages, and resume with a distinct run and retained journal', async () => {
  const gate = deferred(); let runs = 0;
  const historical = { turnId: 'parent-history', messages: [{ role: 'user', content: 'Prior observation' }], bindings: [] };
  const f = await fixture({ child: async (child, input) => {
    runs++;
    if (runs === 1) {
      assert.equal(child.conversationTranscript.turns[0].turnId, historical.turnId);
      await gate.promise;
      assert.equal(input.queue.batch()[0].content, 'Check uncertainty.');
    } else {
      assert(child.conversationTranscript.turns.some(turn => turn.turnId.endsWith(':run:1')));
      assert.equal(child.originalRequest, 'Review a second question.');
    }
    const conversationTurn = { turnId: child.taskId, messages: [{ role: 'user', content: child.originalRequest }, { role: 'assistant', content: 'Child evidence' }], bindings: [] };
    input.onTranscript(conversationTurn);
    return { reply: 'Done', conversationTurn, agentCheckpoint: { version: 1, final: true, marker: 'private-token' } };
  } });
  f.session.bindModel('selected/model'); f.session.observeTranscript(historical);
  const exec = (name, args, id = name) => f.session.execute({ id, name, args });
  const spawn = await exec('spawn_agent', { task_name: 'reader', message: 'Inspect evidence.' });
  assert.equal(spawn.result.ok, true); assert.equal(spawn.result.value.task_name, '/root/reader');
  await tick();
  await exec('send_message', { target: 'reader', message: 'Check uncertainty.' });
  gate.resolve(); await f.session.manager.waitForIdle(f.session.parent);
  const checkpoint = await f.session.atCheckpoint();
  assert.equal(checkpoint.injections.length, 1);
  assert(!checkpoint.injections[0].content.includes('private-token'));
  assert(!checkpoint.injections[0].content.includes('conversationTurn'));
  f.session.acknowledge(checkpoint.injections.map(item => item.id));
  await exec('followup_task', { target: 'reader', message: 'Review a second question.' });
  await f.session.manager.waitForIdle(f.session.parent);
  const next = await f.session.atCheckpoint();
  assert.equal(next.injections.length, 1); assert.notEqual(next.injections[0].id, checkpoint.injections[0].id);
  assert.equal(runs, 2);
  const listed = await exec('list_agents', {});
  assert.equal(listed.result.value.agents.length, 1);
  assert.equal(listed.result.value.agents[0].status, 'completed');
  await f.session.close(); assert.equal(f.session.manager.tasks.size, 0);
  assert.equal(f.service.agentTurns.size, 1);
});

test('V2 interruption cancels the current run without restarting; follow-up stays in captured scope', async () => {
  let runs = 0;
  const f = await fixture({ child: async (child, { signal }) => {
    runs++;
    if (runs === 1) return new Promise((_, reject) => signal.addEventListener('abort', () => reject(Object.assign(new Error(), { code: 'OPERATION_ABORTED' })), { once: true }));
    assert.deepEqual(child.parent.sourceScope.sourceIds, ['paper-a']);
    return { reply: 'Second bounded run.' };
  } });
  f.session.bindModel('selected/model');
  const exec = (name, args, id = name) => f.session.execute({ id, name, args });
  await exec('spawn_agent', { task_name: 'reader', message: 'Read.', fork_turns: 'none' }); await tick();
  const interrupted = await exec('interrupt_agent', { target: 'reader' });
  assert.equal(interrupted.result.value.previous_status, 'running'); assert.equal(runs, 1);
  const sent = await exec('send_message', { target: 'reader', message: 'Queued while idle.' });
  assert.equal(sent.result.value.queued, true); assert.equal(runs, 1);
  await exec('followup_task', { target: 'reader', message: 'Continue with current evidence.' });
  await f.session.manager.waitForIdle(f.session.parent); assert.equal(runs, 2);
  const denied = await exec('send_message', { target: '/another/reader', message: 'Cross-parent.' }, 'wrong-owner');
  assert.equal(denied.result.error.code, 'SUBAGENT_NOT_FOUND');
  await f.session.close();
});

test('runtime batch overlaps admitted skill reads and delivers ordered deduplicated receipts', async () => {
  const gate = deferred(); let reads = 0;
  const f = await fixture({ workflow: async id => {
    if (id === 'runtime_skills_read') { reads++; await gate.promise; return { body: 'read' }; }
  } });
  const a = { id: 'a', name: 'read_skill', args: { name: 'inspect' } }, b = { ...a, id: 'b' };
  const pending = f.session.executeBatch([a, b, a]);
  await tick(); assert.equal(reads, 2); gate.resolve();
  assert.deepEqual((await pending).map(item => item.id), ['a', 'b', 'a']);
  await f.session.close();
});

test('reusable agent follow-up refuses a changed host scope before inheriting context', async () => {
  const f = await fixture(); f.session.bindModel('selected/model');
  await f.session.execute({ id: 'spawn', name: 'spawn_agent', args: { task_name: 'reader', message: 'Read.' } });
  await f.session.manager.waitForIdle(f.session.parent);
  f.original.selected.push('new-private-paper');
  f.original.context.inventory = [{ sourceId: 'new-private-paper', summary: 'Must not leak into the child.' }];
  const receipt = await f.session.execute({ id: 'follow', name: 'followup_task', args: { target: 'reader', message: 'Continue.' } });
  assert.equal(receipt.result.error.code, 'SUBAGENT_SCOPE_CHANGED');
  assert.equal(f.childCalls.length, 1);
  await f.session.close();
});

test('agent wait observes timeout, completion, user interruption and cancellation without consuming results', async () => {
  const gate = deferred(), f = await fixture({ child: async () => { await gate.promise; return { reply: 'Done' }; } });
  f.session.bindModel('selected/model');
  const wait = options => f.session.manager.waitForUpdate(f.session.parent, { timeoutMs: 1, ...options });
  assert.equal((await wait()).reason, 'timeout');
  await f.session.execute({ id: 'spawn', name: 'spawn_agent', args: { task_name: 'reader', message: 'Read.' } });
  const pending = wait({ timeoutMs: 1000 }); gate.resolve();
  assert.equal((await pending).reason, 'agent_update');
  assert.equal((await f.session.atCheckpoint()).injections.length, 1);
  assert.equal((await wait({ interrupted: () => true })).reason, 'user_input');
  const controller = new AbortController(); controller.abort();
  await assert.rejects(wait({ signal: controller.signal }), { code: 'OPERATION_ABORTED' });
  await f.session.close();
});

test('history forks select whole recent turns and reject oversize rather than silently truncating', () => {
  const history = { version: 1, summaries: ['old summary'], turns: [{ turnId: 'first' }, { turnId: 'last' }] };
  assert.equal(contract.forkHistory(history, 'none'), undefined);
  assert.deepEqual(contract.forkHistory(history, '1'), { version: 1, summaries: [], turns: [{ turnId: 'last' }] });
  assert.deepEqual(contract.forkHistory(history), history);
  assert.throws(() => contract.forkHistory({ turns: [{ content: 'x'.repeat(400001) }] }), { code: 'SUBAGENT_CONTEXT_TOO_LARGE' });
  for (const fork_turns of ['0', '-1', '1.5', '10000']) assert.throws(() => contract.validateAgentCall('spawn_agent', { task_name: 'reader', message: 'Read.', fork_turns }), { code: 'INVALID_SUBAGENT_TASK' });
});

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

test('Codex utility contracts validate, deduplicate, and expose only captured skills and tools', async () => {
  const f = await fixture();
  const run = (name, args = {}, id = name) => f.session.execute({ id, name, args });
  assert.match((await run('clock_curr_time')).result.value.current_time, /^\d{4}-\d\d-\d\d .* UTC$/);
  assert.equal((await run('get_context_remaining')).result.error.code, 'RUNTIME_CONTEXT_UNAVAILABLE');
  const snapshot = { tokens_left: null, input_budget_tokens: null, estimated_input_tokens: 1500, output_reserve_tokens: 8192, estimated: true, measured_at: new Date().toISOString() };
  f.session.observeContext(snapshot);
  assert.deepEqual((await run('get_context_remaining', {}, 'context-after-dispatch')).result.value, snapshot);
  assert.throws(() => f.session.observeContext({ ...snapshot, tokens_left: -1 }), { code: 'INVALID_RUNTIME_CONTEXT' });
  const plan = { plan: [{ step: 'Read selected evidence', status: 'in_progress' }] };
  assert.equal((await run('update_plan', plan)).result.value.updated, true);
  await run('update_plan', plan);
  assert.equal(f.statuses.filter(item => item.type === 'plan').length, 1);
  assert.equal((await run('update_plan', { plan: [...plan.plan, ...plan.plan] }, 'bad-plan')).result.error.code, 'INVALID_RUNTIME_TOOL_INPUT');
  assert.deepEqual((await run('skills_list')).result.value.skills.map(item => item.name), ['inspect']);
  assert.equal((await run('skills_read', { name: 'disabled' })).result.error.code, 'SKILL_UNAVAILABLE');
  assert.equal((await run('skills_read', { name: 'inspect' }, 'enabled')).result.value.body, 'Read current evidence.');
  assert.equal((await run('tool_search', { query: 'clock', limit: 1 })).result.value.tools.length, 1);
  assert.equal((await run('tool_search', { query: 'mcp_fixture' }, 'hidden')).result.value.total, 0);
  for (const name of ['request_user_input', 'list_mcp_resources', 'exec_command', 'run_code', 'new_context', 'test_sync_tool']) {
    assert.equal((await run(name)).result.error.code, 'RUNTIME_TOOL_NOT_ALLOWED', name);
  }
  assert.equal((await run('clock_sleep', { duration_ms: -1 })).result.error.code, 'INVALID_RUNTIME_TOOL_INPUT');
  assert.equal((await run('clock_curr_time', { unexpected: true }, 'extra')).result.error.code, 'INVALID_RUNTIME_TOOL_INPUT');
  await f.session.close();
});

test('clock waits finish, react to steering, cancel promptly and expire with their owning session', async () => {
  const f = await fixture();
  const done = await f.session.execute({ id: 'short', name: 'clock_sleep', args: { duration_ms: 5 } });
  assert.equal(done.result.value.interrupted, false); assert(done.result.value.elapsed_ms >= 4);
  f.queue.enqueue('Please focus on the selected source.');
  assert.equal((await f.session.execute({ id: 'steered', name: 'clock_sleep', args: { duration_ms: 60000 } })).result.value.interrupted, true);
  await f.session.close();
  const other = await fixture();
  const wait = other.session.execute({ id: 'long', name: 'clock_sleep', args: { duration_ms: 60000 } });
  const rejected = assert.rejects(wait, { code: 'OPERATION_ABORTED' });
  await other.session.close(); await rejected;
});

test('registry rejects collisions, preserves structured outputs and checks lifetime after asynchronous execution', async () => {
  let current = true; const work = deferred();
  const registry = new registryApi.Registry(() => { if (!current) throw Object.assign(new Error(), { code: 'OPERATION_ABORTED' }); });
  registry.register(mcpTool, () => work.promise);
  assert.throws(() => registry.register(mcpTool, () => ({})), { code: 'RUNTIME_TOOL_COLLISION' });
  const result = registry.execute({ name: mcpTool.function.name, args: {} });
  current = false; work.resolve({ image: 'structured data' });
  await assert.rejects(result, { code: 'OPERATION_ABORTED' });
});

test('resource adapters use only the captured catalog and the existing MCP receipt/cancellation path', async () => {
  const resourceTool = { type: 'function', function: { name: 'mcp_fixture_resource_read', parameters: { type: 'object', properties: {} } } };
  const f = await fixture({ options: { mode: 'agent_instruction', desktopTools: { permission: 'full_access' } }, workflow: id => {
    if (id === 'runtime_mcp_definitions') return { resourcesAvailable: true, tools: [resourceTool],
      resources: [{ server: 'fixture', uri: 'resource://one', tool: resourceTool.function.name }],
      resourceTemplateServers: [{ server: 'fixture', tool: '@mcp-resource-templates:fixture' }] };
  } });
  const execute = (name, args, id = name) => f.session.execute({ id, name, args });
  assert.deepEqual((await execute('list_mcp_resources', {})).result.value.resources, [{ server: 'fixture', uri: 'resource://one' }]);
  assert.equal((await execute('list_mcp_resources', { cursor: 'resource:other-session:0' }, 'expired')).result.error.code, 'INVALID_RESOURCE_CURSOR');
  assert.equal((await execute('read_mcp_resource', { server: 'fixture', uri: 'resource://unobserved' })).result.error.code, 'MCP_TOOL_NOT_ALLOWED');
  const read = await execute('read_mcp_resource', { server: 'fixture', uri: 'resource://one' }, 'allowed');
  assert.equal(read.result.value.evidence.verified, false);
  const hostCall = f.calls.at(-1).input.call;
  assert.equal(hostCall.name, resourceTool.function.name); assert.equal(hostCall.id, `${f.session.parent.sessionId}:allowed`);
  assert.deepEqual(hostCall.args, {});
  await execute('read_mcp_resource', { server: 'fixture', uri: 'resource://one' }, 'allowed');
  assert.equal(f.calls.filter(item => item.id === 'runtime_mcp_call').length, 1);
  await execute('list_mcp_resource_templates', { server: 'fixture', cursor: 'opaque' });
  assert.equal(f.calls.at(-1).input.call.name, '@mcp-resource-templates:fixture');
  assert.deepEqual(f.calls.at(-1).input.call.args, { cursor: 'opaque' });
  assert.equal((await execute('list_mcp_resource_templates', { server: 'paper' }, 'protected')).result.error.code, 'MCP_TOOL_NOT_ALLOWED');
  await f.session.close();
});

test('interaction answers use the existing checkpoint queue without auto-submitting suggestions or widening authority', async () => {
  const questions = [], messages = [];
  const interaction = { plan() {}, message: message => messages.push(message), close() {}, ask(input) {
    const answer = deferred();
    const request = { ...input, answer: answer.promise, close: () => answer.resolve(null), respond: value => { input.deliver(value); answer.resolve(value); } };
    questions.push(request); return request;
  } };
  const f = await fixture({ interaction });
  const first = await f.session.execute({ id: 'ask', name: 'request_user_input_async', args: { questions: [{ title: 'Which evidence?', options: ['Selected'] }] } });
  assert.equal(first.result.value.accepted, true); assert.equal(f.queue.batch().length, 0);
  assert.equal((await f.session.atCheckpoint({ agentCheckpoint: { final: false } })).injections.length, 0);
  questions[0].respond({ answers: { q1: { answers: ['Selected'] } } }); await tick();
  const checkpoint = await f.session.atCheckpoint({ agentCheckpoint: { final: true } });
  assert.equal(checkpoint.shouldContinue, true); assert.equal(checkpoint.injections[0].kind, 'user');
  assert.equal(JSON.parse(checkpoint.injections[0].content).request_id, 'ask');
  const accepted = await f.session.atCheckpoint({ agentCheckpoint: { final: true }, runtimeAccepted: checkpoint.injections.map(item => item.id) });
  assert.equal(accepted.shouldContinue, false);
  assert.equal(f.session.extensions.mcpTools.length, 0);
  await f.session.close();
});

test('synchronous questions settle on explicit answers and are cancelled on source selection changes', async () => {
  const pending = [];
  const interaction = { plan() {}, message() {}, close() {}, ask(input) {
    const answer = deferred(); const request = { answer: answer.promise, close: () => answer.resolve(null), respond: answer.resolve };
    pending.push(request); return request;
  } };
  const args = { questions: [{ id: 'scope', header: 'Focus', question: 'Which comparison?', options: [{ label: 'A', description: 'First' }, { label: 'B', description: 'Second' }] }] };
  const f = await fixture({ interaction });
  const waiting = f.session.execute({ id: 'sync', name: 'request_user_input', args });
  let done = false; waiting.then(() => { done = true; }); await tick(); assert.equal(done, false);
  pending[0].respond({ answers: { scope: { answers: ['A'] } } });
  assert.deepEqual((await waiting).result.value.answers.scope.answers, ['A']);
  const stale = f.session.execute({ id: 'stale', name: 'request_user_input', args });
  const rejected = assert.rejects(stale, { code: 'OPERATION_ABORTED' }); f.setCurrent(false); await rejected;
  await f.session.close();
});

test('all new catalog tools remain denied to children and full-access MCP adapters stay off restricted surfaces', () => {
  const runtimeTools = toolContract.available({ interactionAvailable: true, mcpAvailable: true });
  for (const [surface, permission] of [['side_chat', 'full_access'], ['agent_command', 'workspace_write']]) {
    const envelope = runtime.normalize({ version: 1, runtimeTools });
    const names = runtime.definitions(envelope, surface, permission).map(item => item.function.name);
    for (const name of ['list_mcp_resources', 'list_mcp_resource_templates', 'read_mcp_resource']) {
      assert(!names.includes(name)); assert(!runtime.isTool(name, envelope, surface, permission));
    }
    const child = { ...envelope, child: { allowedTools: [] } };
    for (const name of runtimeTools) assert(!runtime.isTool(name, child, 'agent_command', 'full_access'));
  }
  assert.throws(() => runtime.normalize({ version: 1, runtimeTools: ['test_sync_tool'] }), { code: 'INVALID_RUNTIME_EXTENSIONS' });
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
  await tick(); // Wait for scheduler admission; queued calls have no host process to cancel.
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

test('nested cell output stays bounded with a retained handle and reread cursor instead of an oversized receipt', async t => {
  let replies = 0, starts = 0, reads = 0;
  const f = await fixture({ options: { mode: 'agent_instruction', desktopTools: { permission: 'workspace_write' } },
    interaction: { confirm: async () => true, close() {} }, workflow: async (id, input) => {
      if (id === 'runtime_skills_context') return { advancedRuntimeVersion: 1, catalog: [], active: [] };
      if (id === 'runtime_advanced_open') return { scratch: true };
      if (id === 'runtime_advanced_close') return {};
      if (id === 'runtime_advanced_call') {
        if (input.call.name === 'run_code') { starts++; return { cell_id: 'cell:bounded', status: 'running', output: 'a'.repeat(15998), output_start: 0, output_cursor: 15998, stderr_start: 0, tool_calls: [{ id: 'subcall', name: 'notes_write_file', args: { path: 'safe', text: 'saved' } }] }; }
        assert.equal(input.call.name, 'wait_code'); reads++;
        assert.equal(input.call.args.output_cursor, 0);
        return { cell_id: 'cell:bounded', status: 'completed', exit_code: 0, output: 'a'.repeat(15998), output_start: 0, output_cursor: 15998, output_remaining: 15998 };
      }
      if (id === 'runtime_advanced_reply') { replies++; return { cell_id: 'cell:bounded', status: 'completed', exit_code: 0, output: 'b'.repeat(15998), output_start: 15998, output_cursor: 31996, output_remaining: 0 }; }
    } });
  t.after(() => f.session.close()); f.session.bindModel('fixture');
  const call = { id: 'code-bounded', name: 'run_code', args: { code: 'fixture' } };
  const receipt = await f.session.execute(call);
  assert.equal(receipt.result.ok, true); assert.equal(receipt.result.value.cell_id, 'cell:bounded');
  assert.equal(receipt.result.value.status, 'completed'); assert.equal(receipt.result.value.output_remaining, 15998);
  assert(JSON.stringify(receipt.result.value.output).length <= 16000);
  assert.deepEqual(await f.session.execute(call), receipt);
  assert.deepEqual([starts, replies, reads], [1, 1, 1]);
});

test('conversation memory tools exist only while memory is on, and read through the project memory', async t => {
  const searched = [];
  const memory = { enabled: async () => true, read: async path => ({ path, content: 'remembered' }),
    search: async query => { searched.push(query); return { results: [{ path: 'MEMORY.md', heading: '# Task Group: Fermentation', snippet: 'Report titres in g/L.' }] }; } };
  const workflow = async id => {
    if (id === 'runtime_skills_context') return { advancedRuntimeVersion: 1, catalog: [], active: [] };
    if (id === 'runtime_advanced_open' || id === 'runtime_advanced_close') return {};
  };
  const on = await fixture({ service: { projectMemory: memory }, workflow });
  t.after(() => on.session.close()); on.session.bindModel('fixture');
  assert.ok(on.session.extensions.runtimeTools.includes('conversation_memory_search') && on.session.extensions.runtimeTools.includes('conversation_memory_read'));
  const result = await on.session.execute({ id: 'remember', name: 'conversation_memory_search', args: { query: 'titre units' } });
  assert.equal(result.result.value.results[0].snippet, 'Report titres in g/L.');
  assert.deepEqual(searched, ['titre units']);
  assert.equal((await on.session.execute({ id: 'open', name: 'conversation_memory_read', args: { path: 'MEMORY.md' } })).result.value.content, 'remembered');
  const off = await fixture({ service: { projectMemory: { ...memory, enabled: async () => false } }, workflow });
  t.after(() => off.session.close());
  assert.ok(!off.session.extensions.runtimeTools.some(name => name.startsWith('conversation_memory_')));
});
