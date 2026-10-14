'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const budgetApi = require('../agent-budget.js');
const { withResults } = require('../../shared/agent/receipt-admission.js');
const { runSideChatAgent } = require('../../shared/agent/side-chat-agent.js');
const call = (name, args = {}, id = name) => ({ id, type: 'function', function: { name, arguments: JSON.stringify(args) } });
const working = (usage) => ({ ok: true, message: { content: 'Working.', end_turn: false }, ...(usage ? { usage } : {}) });
const local = { project: { workspaceId: 'budget-fixture' }, files: [{ name: 'notes.txt', relativePath: 'notes.txt', extension: 'txt', content: 'Measured yield: 42.' }] };
const runtimeExtensions = { version: 1, skills: { catalog: '', active: [] }, genericSubagents: false, mcpTools: [] };
const run = (requestTurn, extra = {}) => runSideChatAgent({ conversationMessages: [{ role: 'user', content: 'Inspect metadata.' }],
  originalRequest: 'Inspect metadata.', workspaceContext: { localWorkspaceContext: local }, systemPrompt: 'Read only.', model: 'fixture', requestTurn,
  parseFinalAnswer: content => ({ reply: content }), ...extra });
const stops = events => events.filter(event => event.stage === 'loop-budget-exhausted').map(event => event.reason);

test('budget configuration uses defaults, bounded overrides and allows disabling only time and token bounds', () => {
  assert.deepEqual({ ...budgetApi.configFromEnv({}) }, { ...budgetApi.DEFAULTS });
  assert.deepEqual({ ...budgetApi.configFromEnv({ AGENT_MAX_STEPS: '20', AGENT_MAX_TOOL_CALLS: '60', AGENT_TURN_BUDGET_MS: '120000', AGENT_TURN_TOKEN_BUDGET: '50000' }) },
    { maxSteps: 20, maxToolCalls: 60, turnMs: 120000, turnTokens: 50000 });
  const disabled = budgetApi.configFromEnv({ AGENT_MAX_STEPS: '0', AGENT_TURN_BUDGET_MS: '0', AGENT_TURN_TOKEN_BUDGET: '0' });
  assert.equal(disabled.maxSteps, budgetApi.DEFAULTS.maxSteps);
  assert.equal(disabled.turnMs, null); assert.equal(disabled.turnTokens, null);
  const invalid = budgetApi.configFromEnv({ AGENT_MAX_STEPS: '1', AGENT_MAX_TOOL_CALLS: 'many', AGENT_TURN_BUDGET_MS: '10' });
  assert.equal(invalid.maxSteps, budgetApi.DEFAULTS.maxSteps); assert.equal(invalid.maxToolCalls, budgetApi.DEFAULTS.maxToolCalls);
  assert.equal(invalid.turnMs, budgetApi.DEFAULTS.turnMs);
});

test('the default budget lets the model keep working past the former eight-step ceiling', async () => {
  let requests = 0;
  const result = await run(async request => {
    requests++;
    assert.ok(request.tools.length, 'tools stay available while the model is still working');
    return requests < 12 ? working() : { ok: true, message: { content: 'Answer after twelve steps.' } };
  });
  assert.equal(requests, 12); assert.equal(result.data.reply, 'Answer after twelve steps.');
});

test('an exhausted step budget still ends with the tool-free final synthesis and reports why', async () => {
  let requests = 0; const events = []; let synthesis;
  const result = await run(async request => {
    requests++;
    if (request.tools.length) return working();
    synthesis = request.messages.findLast(message => message.role === 'system').content;
    return { ok: true, message: { content: 'Synthesis from collected receipts.' } };
  }, { loopBudget: { maxSteps: 4 }, onProgress: async event => { events.push(event); } });
  assert.equal(requests, 4); assert.equal(result.data.reply, 'Synthesis from collected receipts.');
  assert.deepEqual(stops(events), ['step_budget_exhausted']);
  assert.match(synthesis, /step_budget_exhausted/);
});

test('the turn time budget spans steps and is taken from the turn state', async () => {
  const events = []; let requests = 0;
  const result = await run(async request => {
    requests++;
    assert.deepEqual(request.tools, []);
    return { ok: true, message: { content: 'Out of turn time.' } };
  }, { turnId: 'budget-turn', onProgress: async event => { events.push(event); },
    loopBudget: { turnMs: 600000 },
    resume: { step: 2, totalToolCalls: 1, loopBudget: { turnMs: 60000 }, agentMessages: [{ role: 'user', content: 'Inspect metadata.' }],
      turnUsage: { version: 1, turnId: 'budget-turn', startedAt: Date.now() - 120000 } } });
  assert.equal(requests, 1); assert.equal(result.data.reply, 'Out of turn time.');
  assert.deepEqual(stops(events), ['turn_time_budget_exhausted']);
});

test('the turn token budget counts reported usage across model requests', async () => {
  const events = []; let requests = 0;
  const result = await run(async request => {
    requests++;
    return request.tools.length ? working({ prompt_tokens: 3000, completion_tokens: 10 }) : { ok: true, message: { content: 'Out of tokens.' } };
  }, { loopBudget: { turnTokens: 5000 }, onProgress: async event => { events.push(event); } });
  assert.equal(requests, 3); assert.equal(result.data.reply, 'Out of tokens.');
  assert.deepEqual(stops(events), ['turn_token_budget_exhausted']);
});

test('host calls beyond the per-step batch limit report the limit, not an exhausted budget', async () => {
  const step = async () => ({ ok: true, message: { tool_calls: [
    call('read_skill', { name: 'a' }, 'skill-a'), call('read_skill', { name: 'b' }, 'skill-b'), call('read_skill', { name: 'c' }, 'skill-c')] } });
  assert.equal((await run(step, { runtimeExtensions })).data.desktopToolCalls.length, 3, 'The default limit (64) admits a whole step');
  const result = await run(step, { runtimeExtensions, hostBatchLimit: 2 });
  assert.deepEqual(result.data.desktopToolCalls.map(item => item.id), ['skill-a', 'skill-b']);
  const receipt = JSON.parse(result.continuationState.agentMessages.find(message => message.tool_call_id === 'skill-c').content);
  assert.equal(receipt.error.code, 'HOST_BATCH_LIMIT'); assert.match(receipt.error.message, /next step/);
});

test('nested Code Mode calls are charged against the turn budget', () => {
  const state = { runtimeVersion: 1, totalToolCalls: 30, loopBudget: { maxToolCalls: 40 }, pending: [{ id: 'code', name: 'run_code', args: { code: 'fixture' } }],
    agentMessages: [{ role: 'tool', tool_call_id: 'code', content: 'pending' }] };
  const result = nested => ({ id: 'code', result: { ok: true, runtimeCall: { name: 'run_code', args: { code: 'fixture' } }, nestedToolCalls: nested, value: { status: 'completed' } } });
  assert.equal(withResults(structuredClone(state), [result(10)]).totalToolCalls, 40);
  assert.throws(() => withResults(structuredClone(state), [result(11)]), { code: 'INVALID_TOOL_CONTINUATION' });
  assert.throws(() => withResults({ ...structuredClone(state), loopBudget: { maxToolCalls: 400 } }, [result(25)]), { code: 'INVALID_TOOL_CONTINUATION' });
});

// A child agent (spawn) declares at most eight model steps and 24 tool calls
// (shared/generic-subagent.js); the loop enforces them below the turn budget.
// Runtime turns pause at checkpoints between steps; drive() resumes them as the
// desktop host does, so the limits must hold across resumes.
const childExtensions = { ...runtimeExtensions, child: { version: 1, taskId: 'child-budget', parentSessionId: 'parent-session', parentRequestId: 'parent-turn',
  projectId: 'budget-fixture', model: 'fixture', allowedTools: ['list_workspace_items', 'read_workspace_item'] } };
// Distinct reads of a long file, so the stall detector sees progress.
const longNotes = { project: { workspaceId: 'budget-fixture' }, files: [{ name: 'notes.txt', relativePath: 'notes.txt', extension: 'txt',
  content: Array.from({ length: 400 }, (_, line) => `Measurement ${line}: yield ${line % 50}.`).join('\n') }] };
const steps = (...calls) => ({ ok: true, message: { content: '', end_turn: false, tool_calls: calls } });
// The file's handle, from the list_workspace_items receipt in the conversation so far.
const handle = request => JSON.parse(request.messages.find(message => message.role === 'tool' && message.content.includes('"items"')).content).items[0].id;
async function drive(requestTurn, extra) {
  let result, resume, resumes = 0;
  for (; resumes < 100; resumes++) {
    result = await run(requestTurn, { ...extra, ...(resume ? { resume } : {}) });
    // The host ends the turn at a final checkpoint when no input is queued.
    if (!result.continuationState || result.data.agentCheckpoint?.final !== false) return { result, resumes };
    assert.deepEqual(result.continuationState.pending || [], [], 'No host calls are pending in this fixture');
    resume = withResults(result.continuationState, []);
  }
  throw new Error('The child never finished');
}

test('a child agent stops at its declared eight model steps across resumes, within a larger turn budget', async () => {
  let requests = 0; const events = [];
  const { result, resumes } = await drive(async request => {
    requests++;
    return request.tools.length ? working() : { ok: true, message: { content: 'Child synthesis.' } };
  }, { runtimeExtensions: childExtensions, loopBudget: { maxSteps: 64, maxToolCalls: 192 }, onProgress: async event => { events.push(event); } });
  assert.equal(requests, 8, 'Seven working steps and the final synthesis');
  assert.ok(resumes >= 6, `${resumes} resumes`);
  assert.equal(result.data.reply, 'Child synthesis.');
  assert.deepEqual(stops(events), ['step_budget_exhausted']);
});

test('a child agent stops at its declared 24 tool calls across resumes', async () => {
  let requests = 0, step = 0, finalRequest; const events = [], counts = [];
  const { result } = await drive(async request => {
    requests++;
    if (!request.tools.length) { finalRequest = request; return { ok: true, message: { content: 'Child answer from 24 calls.' } }; }
    if (++step === 1) return steps(call('list_workspace_items', {}, 'list'));
    return steps(...Array.from({ length: 5 }, (_, index) => call('read_workspace_item', { item_id: handle(request), offset: ((step - 2) * 5 + index) * 200, max_characters: 200 }, `read-${step}-${index}`)));
  }, { runtimeExtensions: childExtensions, loopBudget: { maxSteps: 64, maxToolCalls: 192 }, workspaceContext: { localWorkspaceContext: longNotes },
    onProgress: async event => { events.push(event); if (event.stage === 'loop-budget-exhausted') counts.push(event.toolCalls); } });
  assert.deepEqual(stops(events), ['tool_budget_exhausted']);
  assert.ok(counts[0] >= 24 && counts[0] <= 26, `stopped after ${counts[0]} calls`);
  assert.equal(result.data.reply, 'Child answer from 24 calls.');
  assert.equal(requests, 7, 'One list, five read steps and the final synthesis');
  const answered = finalRequest.messages.filter(message => message.role === 'tool' && !/TOOL_BUDGET_EXCEEDED|bounded tool-call budget/.test(message.content));
  assert.ok(answered.length <= 24, `${answered.length} calls ran`);
});

test('a parent turn with the same runtime keeps the general budget', async () => {
  let requests = 0;
  const { result } = await drive(async request => {
    requests++;
    return requests < 12 ? working() : { ok: true, message: { content: 'Parent answer after twelve steps.' } };
  }, { runtimeExtensions, loopBudget: { maxSteps: 64, maxToolCalls: 192 } });
  assert.equal(requests, 12); assert.equal(result.data.reply, 'Parent answer after twelve steps.');
});
