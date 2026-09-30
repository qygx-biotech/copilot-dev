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
