import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { EventEmitter } from 'node:events';
import path from 'node:path';
import os from 'node:os';
import { ProjectFilesystem } from '../services/project-filesystem.mjs';
import { registerIpcHandlers, revealProjectPath } from '../ipc/register-handlers.mjs';
import channels from '../ipc/channels.cjs';

// Citations open the folder that holds the cited file (docs/app.js, navigateSideChatCitation).
async function project(t) {
  const base = await realpath(await mkdtemp(path.join(os.tmpdir(), 'biodesign-reveal-')));
  t.after(() => rm(base, { recursive: true, force: true }));
  const root = path.join(base, 'project');
  await mkdir(path.join(root, 'literature', '2016-2025，Sara Cantera'), { recursive: true }); await mkdir(path.join(root, '.biodesign'));
  await writeFile(path.join(root, 'literature', '2016-2025，Sara Cantera', 'ectoine.pdf'), '%PDF');
  await writeFile(path.join(root, '.biodesign', 'state.json'), '{}');
  await writeFile(path.join(base, 'outside.pdf'), '%PDF');
  await symlink(path.join(base, 'outside.pdf'), path.join(root, 'literature', 'linked.pdf'));
  const calls = [];
  const reveal = { file: file => { calls.push(['file', file]); }, folder: async folder => { calls.push(['folder', folder]); } };
  return { root, filesystem: await ProjectFilesystem.open(root), calls, reveal };
}

test('a cited file is shown selected in its folder; a missing one opens the nearest folder that still exists', async t => {
  const { root, filesystem, calls, reveal } = await project(t);
  const folder = 'literature/2016-2025，Sara Cantera';
  assert.deepEqual(await revealProjectPath(filesystem, `${folder}/ectoine.pdf`, reveal), { revealed: 'file', relativePath: `${folder}/ectoine.pdf` });
  assert.deepEqual(await revealProjectPath(filesystem, `${folder}/moved.pdf`, reveal), { revealed: 'folder', relativePath: folder });
  assert.deepEqual(await revealProjectPath(filesystem, 'literature/gone/paper.pdf', reveal), { revealed: 'folder', relativePath: 'literature' });
  assert.deepEqual(await revealProjectPath(filesystem, 'nowhere/paper.pdf', reveal), { revealed: 'folder', relativePath: '' });
  assert.deepEqual(calls, [['file', path.join(root, folder, 'ectoine.pdf')], ['folder', path.join(root, folder)], ['folder', path.join(root, 'literature')], ['folder', root]]);
});

test('project metadata and paths leaving the project are never shown', async t => {
  const { filesystem, calls, reveal } = await project(t);
  for (const name of ['.biodesign/state.json', '.BIODESIGN/state.json', '.biodesign']) await assert.rejects(revealProjectPath(filesystem, name, reveal), { code: 'PATH_NOT_REVEALABLE' }, name);
  await assert.rejects(revealProjectPath(filesystem, 'literature/linked.pdf', reveal), { code: 'SYMLINK_NOT_ALLOWED' });
  assert.deepEqual(calls, []);
});

test('the reveal channel exists only when the host can reveal, and checks the project and path', async t => {
  const { root, filesystem, calls, reveal } = await project(t);
  const handlers = new Map();
  const ipcMain = { handle: (channel, handler) => handlers.set(channel, handler), removeHandler: channel => handlers.delete(channel) };
  const contents = Object.assign(new EventEmitter(), { getURL: () => 'file:///app/docs/desktop.html', isDestroyed: () => false });
  const sessionManager = Object.assign(new EventEmitter(), { active: { filesystem }, requireActive: () => ({ filesystem }) });
  const options = { ipcMain, dialog: {}, sessionManager, runtimeInfo: () => ({}), getWindow: () => ({ webContents: contents, isDestroyed: () => false }), getUpdaterController: () => null };
  registerIpcHandlers(options);
  assert.ok(!handlers.has(channels.filesReveal));
  registerIpcHandlers({ ...options, revealPath: reveal });
  const event = { sender: contents, senderFrame: { url: 'file:///app/docs/desktop.html' } };
  const call = payload => handlers.get(channels.filesReveal)(event, payload);
  assert.deepEqual(await call({ projectId: filesystem.id, relativePath: 'literature/2016-2025，Sara Cantera/ectoine.pdf' }), { ok: true, value: { revealed: 'file', relativePath: 'literature/2016-2025，Sara Cantera/ectoine.pdf' } });
  for (const [payload, code] of [[{ projectId: 'another', relativePath: 'literature' }, 'PROJECT_MISMATCH'], [{ projectId: filesystem.id, relativePath: '../outside.pdf' }, undefined],
    [{ projectId: filesystem.id, relativePath: path.join(root, 'literature') }, undefined], [{ projectId: filesystem.id, relativePath: 'literature', extra: 1 }, 'UNKNOWN_FIELD']]) {
    const result = await call(payload);
    assert.equal(result.ok, false, JSON.stringify(payload));
    if (code) assert.equal(result.error.code, code);
  }
  assert.equal(calls.length, 1);
});
