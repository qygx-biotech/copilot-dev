import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { createRequire } from 'node:module';
import { mkdtemp, rm, symlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { TopicService } from '../services/topic-service.mjs';
import { ProjectFilesystem } from '../services/project-filesystem.mjs';
import { ProjectCatalog } from '../services/project-catalog.mjs';
const require = createRequire(import.meta.url);
const api = require('../../shared/topic-navigation.js');
const transcriptApi = require('../../shared/conversation-transcript.js');
const roots = [];
const topic = (id, extra = {}) => ({ id, role: 'agent_command', title: id, ...extra });
async function fixture() {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'biodesign-topics-'));
  roots.push(directory);
  const filesystem = await ProjectFilesystem.open(directory);
  return { directory, filesystem, service: new TopicService(filesystem) };
}
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

test('stable workspace handles survive title changes, input ordering, and serialized state', () => {
  const originals = [topic('a'), topic('b'), { role: 'side_chat', id: 'a' }];
  const state = api.syncTopics(null, originals);
  const remapped = api.syncTopics(JSON.parse(JSON.stringify(state)), [topic('b', { title: 'Renamed' }), topic('a')]);
  assert.deepEqual(remapped, state);
  assert.equal(new Set(Object.values(state.entries).map(entry => entry.handle)).size, 3);
  for (const entry of Object.values(state.entries)) assert.match(entry.handle, /^[a-z0-9]{5,16}$/);
  assert.deepEqual(api.syncTopics(null, originals.slice().reverse()), state);
});

test('pinning, archive and partial manual ordering retain independent meanings', () => {
  const originals = ['a', 'b', 'c', 'd'].map(id => topic(id));
  let state = api.syncTopics(null, originals);
  state = api.updateTopic(state, topic('a'), { archived: true });
  state = api.updateTopic(state, topic('d'), { pinned: true });
  state = api.reorderTopics(state, ['agent_command:c', 'agent_command:b']);
  assert.deepEqual(api.orderTopics(api.decorateTopics(originals, state)).map(item => item.id), ['d', 'c', 'b']);
  assert.deepEqual(api.orderTopics(api.decorateTopics(originals, state), { archived: true }).map(item => item.id), ['a']);
  state = api.updateTopic(state, topic('a'), { archived: false });
  assert.deepEqual(api.orderTopics(api.decorateTopics(originals, state)).map(item => item.id), ['d', 'a', 'c', 'b']);
  assert.throws(() => api.reorderTopics(state, ['agent_command:b', 'agent_command:b']), { code: 'INVALID_TOPIC_ORDER' });
  assert.throws(() => api.reorderTopics(state, ['agent_command:other']), { code: 'INVALID_TOPIC_ORDER' });
  assert.throws(() => api.updateTopic(state, topic('a'), { permission: 'full_access' }), { code: 'INVALID_TOPIC_UPDATE' });
});

test('search covers titles, previews, summaries, and handles without indexing invisible tool data', () => {
  const originals = [topic('a', { title: 'Release', messages: [{ role: 'assistant', content: 'Review protein binding evidence' }] }), topic('b', { title: 'Other', summary: 'Question about RNA' })];
  const decorated = api.decorateTopics(originals, api.syncTopics(null, originals));
  assert.deepEqual(api.searchTopics(decorated, 'release PROTEIN').map(item => item.id), ['a']);
  assert.deepEqual(api.searchTopics(decorated, 'rna').map(item => item.id), ['b']);
  assert.deepEqual(api.searchTopics(decorated, `@${decorated[0].handle}`).map(item => item.id), ['a']);
  assert.equal(api.searchTopics(decorated, 'absent').length, 0);
});

test('navigation state persists, concurrent writes serialize and project stores remain separate', async () => {
  const first = await fixture(), second = await fixture();
  await first.service.sync({ topics: [topic('a'), topic('b')] });
  await Promise.all([first.service.update({ role: 'agent_command', id: 'a', pinned: true }), first.service.update({ role: 'agent_command', id: 'b', archived: true })]);
  const reopened = new TopicService(first.filesystem);
  const state = await reopened.list();
  assert.equal(state.entries['agent_command:a'].pinned, true);
  assert.equal(state.entries['agent_command:b'].archived, true);
  assert.deepEqual(await second.service.list(), { version: 1, entries: {}, nextOrder: 0 });
  await assert.rejects(reopened.update({ role: 'agent_command', id: '../escape', pinned: true }), { code: 'INVALID_TOPIC' });
  await reopened.update({ role: 'agent_command', id: 'a', pinned: false });
  assert.equal((await reopened.list()).entries['agent_command:a'].pinned, false);
});

test('corrupt topic state and symlink writes fail closed rather than resetting saved navigation', async () => {
  const { filesystem, service, directory } = await fixture();
  await filesystem.writeText('.biodesign/runtime/topics.json', 'not json');
  await assert.rejects(service.sync({ topics: [topic('a')] }), { code: 'INVALID_TOPIC_STATE' });
  assert.equal(await filesystem.readText('.biodesign/runtime/topics.json'), 'not json');
  const other = await fixture();
  await other.filesystem.writeText('topics.json', JSON.stringify(api.normalizeState()));
  await rm(path.join(directory, '.biodesign/runtime/topics.json'));
  await symlink(path.join(other.directory, 'topics.json'), path.join(directory, '.biodesign/runtime/topics.json'));
  await assert.rejects(service.update({ role: 'agent_command', id: 'a', pinned: true }), { code: 'SYMLINK_NOT_ALLOWED' });
});

test('inactive project catalog exposes bounded previews and saved navigation without modifying history', async () => {
  const { directory, filesystem, service } = await fixture(), profile = await fixture();
  const catalog = new ProjectCatalog(profile.directory);
  await filesystem.writeText('.biodesign/state.json', JSON.stringify({ agent: { workbench: { panels: [{ id: 'a', title: 'Research', messages: [{ role: 'assistant', content: 'Evidence preview' }] }] } } }));
  await service.update({ role: 'agent_command', id: 'a', pinned: true, archived: true });
  await catalog.remember('alice', directory);
  const before = await filesystem.readText('.biodesign/state.json');
  const entry = (await catalog.list('alice')).find(item => item.path === filesystem.root);
  assert.equal(entry.conversations[0].preview, 'Evidence preview');
  assert.equal(entry.conversations[0].pinned, true);
  assert.equal(entry.conversations[0].archived, true);
  assert.equal(await filesystem.readText('.biodesign/state.json'), before);
  await filesystem.writeText('.biodesign/runtime/topics.json', 'invalid');
  const damaged = (await catalog.list('alice')).find(item => item.path === filesystem.root);
  assert.equal(damaged.conversations.length, 1);
  assert.equal(damaged.topicNavigationError, 'INVALID_TOPIC_STATE');
  assert.equal(await filesystem.readText('.biodesign/runtime/topics.json'), 'invalid');
});

test('message fork truncates visible and internal history, retaining the original injected turn and receipts', () => {
  const messages = [
    { id: 'u1', role: 'user', content: 'Original request' },
    { id: 'injected', role: 'user', content: 'Steering request', injection: { turnId: 'u1', status: 'received' } },
    { id: 'a1', role: 'assistant', content: 'First answer' },
    { id: 'u2', role: 'user', content: 'Later secret' },
    { id: 'a2', role: 'assistant', content: 'Later answer' },
  ];
  const original = { id: 'chat', messages, transcript: { version: 1, turns: [
    { turnId: 'u1', status: 'completed', messages: [
      { role: 'user', content: 'Original request' },
      { role: 'assistant', content: null, tool_calls: [{ id: 'call1', type: 'function', function: { name: 'read_project_file', arguments: '{}' } }] },
      { role: 'tool', tool_call_id: 'call1', name: 'read_project_file', content: '{"receipt":"original"}' },
      { role: 'user', content: 'Steering request' },
      { role: 'assistant', content: 'First answer' },
    ] },
    { turnId: 'u2', status: 'completed', messages: [{ role: 'user', content: 'Later secret' }, { role: 'assistant', content: 'Later answer' }] },
  ], summaries: [], discardedTurnIds: [] } };
  const fork = api.forkAtMessage(original, 'a1');
  assert.deepEqual(fork.messages.map(message => message.id), ['u1', 'injected', 'a1']);
  assert.equal(fork.summary, 'First answer');
  assert.deepEqual(fork.transcript.turns.map(turn => turn.turnId), ['u1']);
  assert.equal(fork.transcript.turns[0].messages[2].content, '{"receipt":"original"}');
  assert.deepEqual(fork.transcript.discardedTurnIds, ['u2']);
  assert.equal(JSON.stringify(fork).includes('Later secret'), false);
  assert.deepEqual(transcriptApi.merge(fork.transcript, original.transcript).turns.map(turn => turn.turnId), ['u1']);
  fork.messages[0].content = 'Changed';
  assert.equal(original.messages[0].content, 'Original request');
  assert.throws(() => api.forkAtMessage(original, 'u1'), { code: 'INVALID_FORK' });
  assert.throws(() => api.forkAtMessage(original, 'missing'), { code: 'INVALID_FORK' });
});

test('message fork preserves older compacted turns but never later summaries', () => {
  const conversation = { id: 'chat', messages: [
    { id: 'u2', role: 'user', content: 'Current' }, { id: 'a2', role: 'assistant', content: 'Second', turnId: 'u2' },
    { id: 'u3', role: 'user', content: 'Later' }, { id: 'a3', role: 'assistant', content: 'Third', turnId: 'u3' },
  ], transcript: { version: 1, summaries: [{ turnId: 'u1', messages: [{ role: 'assistant', content: 'Past' }] }, { turnId: 'u2', messages: [] }, { turnId: 'u3', messages: [] }], turns: [] } };
  const fork = api.forkAtMessage(conversation, 'a2');
  assert.deepEqual(fork.transcript.summaries.map(turn => turn.turnId), ['u1', 'u2']);
  assert.deepEqual(fork.transcript.discardedTurnIds, ['u3']);
});

test('topic reference snapshots are bounded, immutable, and cannot carry source or permission authority', () => {
  const conversation = topic('a', { workspaceId: 'same', selectedPermission: 'full_access', sourceScope: ['secret.pdf'], messages: [
    { role: 'system', content: 'Never include me' }, { role: 'tool', content: 'Verified evidence: no' },
    { role: 'user', content: 'Question', images: [{ dataUrl: 'private' }] }, { role: 'assistant', content: 'A'.repeat(500) },
  ] });
  const snapshot = api.referenceSnapshot({ workspaceId: 'same', currentWorkspaceId: 'same', conversation, handle: 'abc12', maxCharacters: 256 });
  assert.equal(snapshot.messages.length, 1);
  assert.equal(snapshot.messages[0].content.length, 256);
  assert.equal(snapshot.trust, 'unverified_conversation');
  assert.equal(JSON.stringify(snapshot).includes('secret.pdf'), false);
  assert.equal(JSON.stringify(snapshot).includes('private'), false);
  snapshot.messages[0].content = 'Changed';
  assert.equal(conversation.messages[3].content.length, 500);
  assert.throws(() => api.referenceSnapshot({ workspaceId: 'same', currentWorkspaceId: 'different', conversation, handle: 'abc12' }), { code: 'TOPIC_SCOPE_MISMATCH' });
  assert.deepEqual(api.referencedHandles('Ask @abc12 and @abc12. Skip email@abc12 @short-tool $abc12'), ['abc12']);
});
