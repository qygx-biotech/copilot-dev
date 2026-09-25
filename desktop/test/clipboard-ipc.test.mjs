import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import channels from '../ipc/channels.cjs';
import { registerIpcHandlers } from '../ipc/register-handlers.mjs';

test('clipboard writes require a trusted renderer and bounded plain text', async () => {
  const handlers = new Map(), writes = [];
  const webContents = { getURL: () => 'file:///app/docs/desktop.html' };
  const event = { sender: webContents, senderFrame: { url: webContents.getURL() } };
  const dispose = registerIpcHandlers({
    ipcMain: { handle: (name, handler) => handlers.set(name, handler), removeHandler: name => handlers.delete(name) },
    sessionManager: new EventEmitter(), getWindow: () => ({ isDestroyed: () => false, webContents }),
    writeClipboardText: text => writes.push(text),
  });
  const copy = handlers.get(channels.clipboardWriteText);
  assert.deepEqual(await copy(event, { text: '### You\n\nEvidence α\n\n### Agent\n\n结果' }), { ok: true, value: { copied: true } });
  assert.deepEqual(writes, ['### You\n\nEvidence α\n\n### Agent\n\n结果']);
  for (const payload of [{}, { text: 42 }, { text: 'x'.repeat(16 * 1024 * 1024 + 1) }, { text: 'valid', read: true }]) {
    assert.equal((await copy(event, payload)).ok, false);
  }
  for (const untrusted of [
    { sender: {}, senderFrame: event.senderFrame },
    { sender: webContents, senderFrame: { url: 'https://example.com' } },
    { sender: webContents, senderFrame: { url: 'file:///different.html' } },
  ]) assert.equal((await copy(untrusted, { text: 'blocked' })).error.code, 'UNTRUSTED_IPC_SENDER');
  assert.equal(writes.length, 1);
  dispose();
  assert.equal(handlers.has(channels.clipboardWriteText), false);
});
