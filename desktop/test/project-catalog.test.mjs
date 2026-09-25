import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, rename, symlink } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { ProjectCatalog } from '../services/project-catalog.mjs';
import { EventEmitter } from 'node:events';
import channels from '../ipc/channels.cjs';
import { registerIpcHandlers } from '../ipc/register-handlers.mjs';

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'biodesign-projects-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return { root, catalog: new ProjectCatalog(path.join(root, 'profile')) };
}

test('chat-first startup provides an account-specific default workspace without a folder picker', async t => {
  const { catalog } = await fixture(t);
  const [alice] = await catalog.list('alice');
  const [bob] = await catalog.list('bob');
  assert.equal(alice.id, 'default'); assert.equal(alice.managed, true);
  assert.equal(alice.initialized, false); assert.deepEqual(alice.conversations, []);
  assert.notEqual(alice.path, bob.path);
  assert.deepEqual(await catalog.get('alice', 'default'), { id: alice.id, name: 'Chats', path: alice.path, managed: true });
  await assert.rejects(catalog.get('alice', '/tmp/arbitrary-directory'), { code: 'UNKNOWN_PROJECT' });
});

test('remembered projects list original histories without activating or rewriting them', async t => {
  const { root, catalog } = await fixture(t);
  const project = path.join(root, 'Research');
  await mkdir(path.join(project, '.biodesign/chat'), { recursive: true });
  const index = JSON.stringify({ conversations: [{ id: 'side-1', title: 'Evidence', messageCount: 2, updatedAt: '2026-09-18' }] });
  const state = JSON.stringify({ project: { goal: 'Existing goal' }, agent: { workbench: { version: 1, panels: [{ id: 'agent-1', title: 'Download papers', messages: [{ role: 'user', content: 'Download' }], updatedAt: '2026-09-19' }] } } });
  await writeFile(path.join(project, '.biodesign/chat/index.json'), index);
  await writeFile(path.join(project, '.biodesign/state.json'), state);
  await writeFile(path.join(project, '.biodesign/workspace.json'), '{}');
  const entry = await catalog.remember('alice', project);
  assert.equal((await catalog.remember('alice', project)).id, entry.id);
  const restarted = new ProjectCatalog(path.join(root, 'profile'));
  const groups = await restarted.list('alice');
  assert.equal(groups.length, 2);
  assert.deepEqual(groups[1].conversations.map(chat => chat.role), ['agent_command']);
  assert.equal((await restarted.list('bob')).length, 1);
  assert.equal(await readFile(path.join(project, '.biodesign/state.json'), 'utf8'), state);
  assert.equal(await readFile(path.join(project, '.biodesign/chat/index.json'), 'utf8'), index);
});

test('missing or replaced project folders never silently retarget a remembered project', async t => {
  const { root, catalog } = await fixture(t);
  const original = path.join(root, 'Research'), moved = path.join(root, 'Moved');
  await mkdir(original);
  const entry = await catalog.remember('alice', original);
  await rename(original, moved);
  assert.equal((await catalog.list('alice'))[1].unavailable, true);
  await symlink(moved, original, 'dir');
  await assert.rejects(catalog.get('alice', entry.id), { code: 'PROJECT_PATH_CHANGED' });
});

test('corrupt shell registry is preserved and rejected instead of overwritten', async t => {
  const { root, catalog } = await fixture(t);
  await catalog.list('alice');
  const filename = path.join(catalog.accountRoot('alice'), 'projects.json');
  await writeFile(filename, '{invalid registry');
  await assert.rejects(catalog.remember('alice', root));
  assert.equal(await readFile(filename, 'utf8'), '{invalid registry');
});

test('project navigation IPC rejects untrusted frames and renderer-supplied paths', async t => {
  const { catalog } = await fixture(t);
  const handlers = new Map();
  const webContents = { getURL: () => 'file:///app/docs/desktop.html' };
  let opens = 0;
  const sessionManager = new EventEmitter();
  sessionManager.open = async () => { opens++; return { projectId: 'session-1', initialized: false }; };
  const dispose = registerIpcHandlers({ ipcMain: { handle: (key, fn) => handlers.set(key, fn), removeHandler() {} },
    getWindow: () => ({ isDestroyed: () => false, webContents }), sessionManager, projectCatalog: catalog,
    dialog: { showOpenDialog: async () => ({ canceled: true, filePaths: [] }) }, runtimeInfo: () => ({}) });
  t.after(dispose);
  const event = { sender: webContents, senderFrame: { url: webContents.getURL() } };
  const list = handlers.get(channels.projectList), activate = handlers.get(channels.projectActivate);
  assert.equal((await list(event, { account: 'alice' })).ok, true);
  assert.equal((await list({ senderFrame: { url: 'https://example.com' } }, { account: 'alice' })).error.code, 'UNTRUSTED_IPC_SENDER');
  assert.equal((await activate(event, { account: 'alice', catalogId: 'default', path: '/tmp' })).ok, false);
  assert.equal((await activate(event, { account: 'alice', catalogId: '/tmp' })).error.code, 'UNKNOWN_PROJECT');
  assert.equal(opens, 0);
  assert.equal((await activate(event, { account: 'alice', catalogId: 'default' })).ok, true);
  assert.equal(opens, 1);
  assert.deepEqual(await handlers.get(channels.projectChoose)(event, { account: 'alice' }), { ok: true, value: null });
});
