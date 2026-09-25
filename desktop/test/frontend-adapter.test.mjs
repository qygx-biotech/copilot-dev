import test from 'node:test';
import assert from 'node:assert/strict';
import frontend from '../../docs/desktop-adapter.js';

function fixture(commands = {}) {
  const state = { project: { id: 'project-a' }, activeConversationId: 'side-a', conversations: [{ id: 'side-a' }], agents: [{ id: 'agent-a' }] };
  const adapter = frontend.createFrontendAdapter();
  adapter.connect({ readSnapshot: () => state, commands });
  return { state, adapter };
}
const tick = () => new Promise(resolve => queueMicrotask(resolve));

test('copy and fork reject foreign conversations and incorrect roles before dispatch', async () => {
  let calls = 0;
  const commands = Object.fromEntries(['side.copy', 'side.fork', 'agent.copy', 'agent.fork'].map(name => [name, () => calls++]));
  const { state, adapter } = fixture(commands);
  state.activeAgentId = 'agent-a';
  for (const name of Object.keys(commands)) {
    const role = name.startsWith('side.') ? 'side_chat' : 'agent_command';
    await assert.rejects(adapter.command(name, { projectId: 'project-a', role, conversationId: 'foreign' }), { code: 'CONVERSATION_MISMATCH' });
    await assert.rejects(adapter.command(name, { projectId: 'project-a', role: 'focused-pane', conversationId: 'side-a' }), { code: 'ROLE_MISMATCH' });
  }
  assert.equal(calls, 0);
  await adapter.command('side.copy', { projectId: 'project-a', role: 'side_chat', agentPanelId: 'agent-a', conversationId: 'side-a' });
  await adapter.command('agent.fork', { projectId: 'project-a', role: 'agent_command', conversationId: 'agent-a' });
  assert.equal(calls, 2);
});

test('commands require explicit project, conversation and execution role; unsupported writes are unavailable', async () => {
  let calls = 0;
  const { adapter } = fixture({ 'side.send': () => calls++, 'agent.send': () => calls++ });
  await assert.rejects(adapter.command('side.send', { projectId: 'old', role: 'side_chat' }), { code: 'PROJECT_MISMATCH' });
  await assert.rejects(adapter.command('side.send', { projectId: 'project-a', role: 'agent_command' }), { code: 'ROLE_MISMATCH' });
  await assert.rejects(adapter.command('side.send', { projectId: 'project-a', role: 'side_chat', conversationId: 'other' }), { code: 'CONVERSATION_MISMATCH' });
  await assert.rejects(adapter.command('agent.send', { projectId: 'project-a', role: 'side_chat', conversationId: 'agent-a' }), { code: 'ROLE_MISMATCH' });
  await assert.rejects(adapter.command('recommendation.commit', { projectId: 'project-a' }), { code: 'UNSUPPORTED_ACTION' });
  await assert.rejects(adapter.command('download', { projectId: 'project-a' }), { code: 'UNSUPPORTED_ACTION' });
  assert.equal(calls, 0);
});

test('repeated sends dispatch once and pane focus is not part of the execution contract', async () => {
  let release, calls = 0;
  const gate = new Promise(resolve => { release = resolve; });
  const { adapter } = fixture({ 'side.send': async payload => { calls++; assert.equal(payload.conversationId, 'side-a'); await gate; } });
  const target = { projectId: 'project-a', role: 'side_chat', conversationId: 'side-a', text: 'evidence' };
  const first = adapter.command('side.send', target), second = adapter.command('side.send', target);
  await tick(); assert.equal(calls, 1); release(); await Promise.all([first, second]);
});

test('concurrent streams keep captured models, scope, permission, activity and errors separate', async () => {
  const { adapter } = fixture();
  const paths = ['literature/selected.pdf'];
  const side = adapter.beginTurn({ role: 'side_chat', conversationId: 'side-a', model: 'side-model', permission: 'full_access', sourcePaths: paths });
  const agent = adapter.beginTurn({ role: 'agent_command', conversationId: 'agent-a', model: 'agent-model', permission: 'workspace_write' });
  paths.push('other.pdf');
  side.event({ type: 'delta', text: 'side' }); agent.event({ type: 'status', stage: 'tool-running', capability: 'download_papers' });
  side.finish('failed', 'FC interrupted'); agent.finish(); await tick();
  const runs = adapter.getSnapshot().runs;
  assert.deepEqual(runs['side_chat:side-a'].sourcePaths, ['literature/selected.pdf']);
  assert.equal(runs['side_chat:side-a'].model, 'side-model');
  assert.equal(runs['side_chat:side-a'].permission, 'read_only');
  assert.equal(runs['side_chat:side-a'].error, 'FC interrupted');
  assert.equal(runs['agent_command:agent-a'].model, 'agent-model');
  assert.equal(runs['agent_command:agent-a'].permission, 'workspace_write');
  assert.equal(runs['agent_command:agent-a'].steps[0].capability, 'download_papers');
  assert.equal(runs['agent_command:agent-a'].outputCharacters, 0);
});

test('project invalidation aborts old turns even if the reopened workspace has the same saved ID', async () => {
  const { adapter } = fixture();
  const old = adapter.beginTurn({ role: 'side_chat', conversationId: 'side-a', model: 'default' });
  adapter.invalidateProject();
  const next = adapter.beginTurn({ role: 'side_chat', conversationId: 'side-a', model: 'next' });
  old.event({ type: 'delta', text: 'late reply' }); old.finish(); await tick();
  assert.equal(old.signal.aborted, true); assert.equal(old.isCurrent(), false);
  assert.equal(next.isCurrent(), true);
  assert.equal(adapter.getSnapshot().runs['side_chat:side-a'].outputCharacters, 0);
  assert.equal(adapter.getSnapshot().runs['side_chat:side-a'].status, 'running');
});

test('queued commands cannot cross a project close/reopen with the same saved ID', async () => {
  let calls = 0;
  const { adapter } = fixture({ 'side.send': () => calls++ });
  const task = adapter.command('side.send', { projectId: 'project-a', role: 'side_chat', conversationId: 'side-a' });
  adapter.invalidateProject();
  await assert.rejects(task, { code: 'PROJECT_MISMATCH' });
  assert.equal(calls, 0);
});

test('Side Chat cancellation does not abort Agent Work or promise cancellation of desktop writes', async () => {
  const { adapter } = fixture();
  const side = adapter.beginTurn({ role: 'side_chat', conversationId: 'side-a' });
  const agent = adapter.beginTurn({ role: 'agent_command', conversationId: 'agent-a' });
  adapter.cancel({ projectId: 'project-a', role: 'side_chat', conversationId: 'side-a' });
  assert.equal(side.signal.aborted, true); assert.equal(agent.signal.aborted, false);
  assert.throws(() => adapter.cancel({ projectId: 'project-a', role: 'agent_command', conversationId: 'agent-a' }), { code: 'CANCEL_UNSUPPORTED' });
  side.finish(); agent.finish(); await tick();
  assert.equal(adapter.getSnapshot().runs['side_chat:side-a'].status, 'cancelled');
  assert.equal(adapter.getSnapshot().runs['agent_command:agent-a'].status, 'completed');
});

test('composer project selection requires an explicit execution role', async () => {
  const received = [];
  const { adapter } = fixture({ 'project.activate': payload => received.push(payload), 'project.choose': payload => received.push(payload) });
  await assert.rejects(adapter.command('project.activate', { catalogId: 'next' }), { code: 'ROLE_MISMATCH' });
  await assert.rejects(adapter.command('project.choose', { role: 'focused-pane' }), { code: 'ROLE_MISMATCH' });
  await adapter.command('project.activate', { catalogId: 'next', role: 'side_chat' });
  await adapter.command('project.choose');
  assert.equal(received[0].role, 'side_chat');
  assert.equal(received.length, 2);
});

test('Side Chat navigation is bound to its Agent Work panel, including queued actions', async () => {
  let calls = 0;
  const { state, adapter } = fixture({ 'side.open': () => calls++ });
  state.activeAgentId = 'agent-a';
  await assert.rejects(adapter.command('side.open', { projectId: 'project-a', role: 'side_chat', agentPanelId: 'agent-b', conversationId: 'side-a' }), { code: 'CONVERSATION_MISMATCH' });
  const queued = adapter.command('side.open', { projectId: 'project-a', role: 'side_chat', agentPanelId: 'agent-a', conversationId: 'side-a' });
  state.activeAgentId = 'agent-b';
  await assert.rejects(queued, { code: 'CONVERSATION_MISMATCH' });
  assert.equal(calls, 0);
});
