import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, readFile, writeFile, readdir, access, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import contextApi from '../../docs/project-context-service.js';
import transcriptApi from '../../shared/conversation-transcript.js';

async function fixture(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'biodesign-topic-forks-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const workspace = {
    workspace: { workspaceId: randomUUID() }, state: {}, createId: randomUUID,
    ensureDirectory: relative => mkdir(path.join(directory, relative), { recursive: true }),
    fileExists: relative => access(path.join(directory, relative)).then(() => true, () => false),
    readJson: async relative => JSON.parse(await readFile(path.join(directory, relative), 'utf8')),
    writeJson: async (relative, value) => { await mkdir(path.dirname(path.join(directory, relative)), { recursive: true }); await writeFile(path.join(directory, relative), JSON.stringify(value)); },
    removeFile: relative => rm(path.join(directory, relative)),
    listFiles: async relative => (await readdir(path.join(directory, relative))).map(name => ({ name, relativePath: `${relative}/${name}` })),
  };
  const store = new contextApi.WorkspaceChatStore({ workspace });
  return { workspace, store };
}
const date = '2026-10-02T12:00:00.000Z';
const messages = [
  { id: 'first-user', role: 'user', content: 'Read the paper', createdAt: date },
  { id: 'steering-user', role: 'user', content: 'Focus on limitations', injection: { turnId: 'first-user', status: 'received' }, createdAt: date },
  { id: 'first-answer', role: 'assistant', content: 'First answer', createdAt: date },
  { id: 'second-user', role: 'user', content: 'Later question', createdAt: date },
  { id: 'second-answer', role: 'assistant', content: 'Later answer', createdAt: date },
];
const checkpoint = workspaceId => ({ turnId: 'first-user', workspaceId, model: 'default', sequence: 4, status: 'completed', startedAt: date, updatedAt: date, bindings: [], messages: [
  { role: 'user', content: 'Read the paper' },
  { role: 'assistant', content: null, tool_calls: [{ id: 'read-one', type: 'function', function: { name: 'read_paper_evidence', arguments: '{"paper_id":"paper"}' } }] },
  { role: 'tool', tool_call_id: 'read-one', name: 'read_paper_evidence', content: '{"receipt":"read-original","sourceVersion":"sha256-v1"}' },
  { role: 'user', content: 'Focus on limitations' },
  { role: 'assistant', content: 'First answer' },
] });

test('saved message forks keep only selected history, preserve parent receipts, and remain separate after restart', async t => {
  const { workspace, store } = await fixture(t);
  const empty = await store.startNewConversation();
  const original = await store.saveConversation({ ...empty, messages, summary: 'Later answer' });
  await store.saveTranscriptTurn(original.id, checkpoint(workspace.workspace.workspaceId));
  await store.saveTranscriptTurn(original.id, { turnId: 'second-user', workspaceId: workspace.workspace.workspaceId, status: 'completed', sequence: 2, startedAt: date, messages: [{ role: 'user', content: 'Later question' }, { role: 'assistant', content: 'Later answer' }] });
  const fork = await store.forkConversation(original.id, 'first-answer');
  assert.notEqual(fork.id, original.id);
  assert.deepEqual(fork.messages.map(message => message.id), ['first-user', 'steering-user', 'first-answer']);
  assert.equal(fork.summary, 'First answer');
  assert.deepEqual(fork.transcript.turns.map(turn => turn.turnId), ['first-user']);
  assert.match(fork.transcript.turns[0].messages[2].content, /sourceVersion/);
  assert.deepEqual(transcriptApi.forConversation(fork).turns.map(turn => turn.turnId), ['first-user']);
  const restarted = new contextApi.WorkspaceChatStore({ workspace });
  const restored = await restarted.loadActiveConversation();
  assert.equal(restored.id, fork.id);
  assert.deepEqual(restored.transcript, fork.transcript);
  assert.equal((await restarted.activateConversation(original.id)).messages.length, 5);
  await assert.rejects(restarted.forkConversation(original.id, 'first-user'), { code: 'INVALID_FORK' });
});

test('injected messages never create duplicate legacy turns over an existing checkpoint or summary', () => {
  const turn = checkpoint('workspace');
  const base = { messages: messages.slice(0, 3), transcript: { version: 1, turns: [turn], summaries: [] } };
  const result = transcriptApi.forConversation(base);
  assert.deepEqual(result.turns.map(item => item.turnId), ['first-user']);
  assert.equal(result.turns[0].messages.filter(item => item.content === 'First answer').length, 1);
  const summarized = transcriptApi.forConversation({ ...base, transcript: { version: 1, turns: [], summaries: [transcriptApi.summarize(turn)] } });
  assert.equal(summarized.turns.length, 0);
  assert.deepEqual(summarized.summaries.map(item => item.turnId), ['first-user']);
});

test('legacy migration groups original and injected users into one exchange without fabricated tool evidence', () => {
  const migrated = transcriptApi.forConversation({ messages });
  assert.deepEqual(migrated.turns.map(turn => turn.turnId), ['first-user', 'second-user']);
  assert.deepEqual(migrated.turns[0].messages.map(message => message.content), ['Read the paper', 'Focus on limitations', 'First answer']);
  assert.equal(migrated.turns[0].messages.some(message => message.role === 'tool'), false);
});
