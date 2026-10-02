import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { ProjectSessionManager } from '../services/project-session.mjs';
import { registerIpcHandlers } from '../ipc/register-handlers.mjs';
import channels from '../ipc/channels.cjs';

test('project extension workflows retain scope and skill availability across lifecycle changes', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'biodesign-runtime-session-'));
  const manager = new ProjectSessionManager({ appPath: process.cwd(), qmdCacheRoot: path.join(root, 'cache') });
  try {
    await manager.open(root);
    const active = manager.active;
    const workflows = active.execution.list().map(item => item.id);
    for (const id of ['runtime_skills_list', 'runtime_skills_context', 'runtime_skills_save', 'runtime_mcp_list', 'runtime_mcp_call', 'literature_worker', 'download_sources']) assert.ok(workflows.includes(id), id);
    await active.execution.run('runtime_skills_save', { name: 'research', content: '---\nname: research\ndescription: Use scoped research tools.\n---\nCheck evidence.' });
    assert.equal((await active.execution.run('runtime_skills_context', { text: '$research' })).active[0].name, 'research');
    await active.execution.run('runtime_skills_enable', { name: 'research', enabled: false });
    assert.equal((await active.execution.run('runtime_skills_read', { name: 'research' })).enabled, false);
    await assert.rejects(() => active.execution.run('runtime_skills_read', { name: 'research', forAgent: true }), { code: 'SKILL_UNAVAILABLE' });
    await assert.rejects(() => active.execution.run('runtime_skills_context', { text: '$research', bypass: true }), { code: 'UNKNOWN_FIELD' });
    assert.deepEqual(await active.execution.run('runtime_mcp_definitions', {}), { tools: [] });
    await assert.rejects(() => active.execution.run('runtime_mcp_call', { call: { id: 'call-1', name: 'mcp_example_read', args: {} }, surface: 'side_chat', permission: 'full_access' }), { code: 'MCP_SCOPE_DENIED' });
    let closed = false;
    const close = active.genericMcp.close.bind(active.genericMcp);
    active.genericMcp.close = async () => { closed = true; await close(); };
    await manager.close();
    assert.equal(closed, true);
    assert.equal(active.sourceDownloads.signal.aborted, true);
    await assert.rejects(() => active.execution.run('runtime_skills_save', { name: 'after-close', content: 'ignored' }), { code: 'PROJECT_MISMATCH' });
  } finally { await manager.close(); await rm(root, { recursive: true, force: true }); }
});

test('runtime extension IPC requires both active project identity and the trusted desktop frame', async () => {
  const handlers = new Map(), calls = [];
  const webContents = { getURL: () => 'file:///app/docs/desktop.html' };
  const trusted = { sender: webContents, senderFrame: { url: webContents.getURL() } };
  const sessionManager = new EventEmitter();
  sessionManager.requireActive = () => ({ filesystem: { id: 'project-123' }, execution: { run: async (id, input) => { calls.push({ id, input }); return {}; } } });
  const dispose = registerIpcHandlers({
    ipcMain: { handle: (name, handler) => handlers.set(name, handler), removeHandler: name => handlers.delete(name) },
    sessionManager, getWindow: () => ({ isDestroyed: () => false, webContents }),
  });
  try {
    const run = handlers.get(channels.executionRun);
    const payload = { projectId: 'project-123', workflowId: 'runtime_mcp_save', input: { name: 'extra' } };
    assert.equal((await run(trusted, payload)).ok, true);
    assert.equal((await run({ sender: webContents, senderFrame: { url: 'https://remote.example/' } }, payload)).error.code, 'UNTRUSTED_IPC_SENDER');
    assert.equal((await run(trusted, { ...payload, projectId: 'wrong-project' })).error.code, 'PROJECT_MISMATCH');
    assert.equal(calls.length, 1);
  } finally { dispose(); }
});

test('per-call cancellation aborts duplicate deliveries without cancelling another turn or the project', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'biodesign-runtime-cancel-'));
  const manager = new ProjectSessionManager({ appPath: process.cwd(), qmdCacheRoot: path.join(root, 'cache') });
  try {
    await manager.open(root);
    const active = manager.active;
    const signals = [];
    active.genericMcp.call = async (_call, { signal }) => {
      signals.push(signal);
      await new Promise((resolve, reject) => {
        if (signal.aborted) reject(Object.assign(new Error('Aborted'), { code: 'OPERATION_ABORTED' }));
        else signal.addEventListener('abort', () => reject(Object.assign(new Error('Aborted'), { code: 'OPERATION_ABORTED' })), { once: true });
      });
    };
    const request = id => active.execution.run('runtime_mcp_call', { call: { id, name: 'mcp_example_read', args: {} }, surface: 'agent_command', permission: 'full_access' });
    const first = request('turn-1:call-1'), duplicate = request('turn-1:call-1'), other = request('turn-2:call-1');
    // Register rejection handlers before requesting cancellation.
    const results = Promise.allSettled([first, duplicate, other]);
    assert.equal(active.genericMcpCalls.get('turn-1:call-1').count, 2);
    assert.deepEqual(await active.execution.run('runtime_mcp_cancel', { callId: 'missing:call' }), { callId: 'missing:call', cancelled: false });
    assert.deepEqual(await active.execution.run('runtime_mcp_cancel', { callId: 'turn-1:call-1' }), { callId: 'turn-1:call-1', cancelled: true });
    assert.equal(signals[0].aborted, true);
    assert.equal(signals[1].aborted, true);
    assert.equal(signals[2].aborted, false);
    assert.equal(active.sourceDownloads.signal.aborted, false);
    await active.execution.run('runtime_mcp_cancel', { callId: 'turn-2:call-1' });
    assert.deepEqual((await results).map(result => result.reason.code), ['OPERATION_ABORTED', 'OPERATION_ABORTED', 'OPERATION_ABORTED']);
    assert.equal(active.genericMcpCalls.size, 0);
  } finally { await manager.close(); await rm(root, { recursive: true, force: true }); }
});
