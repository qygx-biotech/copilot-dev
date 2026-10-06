import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { ScratchRuntime, outputChunk } from '../services/scratch-runtime.mjs';
import { AdvancedRuntimeService } from '../services/advanced-runtime-service.mjs';
import { ProjectFilesystem } from '../services/project-filesystem.mjs';
import continuation from '../../alibaba-fc/agent-continuation.js';
const native = process.env.BIODESIGN_SANDBOX_TEST === '1';

test('serialized chunks respect escaped text and Unicode boundaries and support exact rereads', () => {
  const text = '🧬漢\t\u0001"\\'.repeat(20000); let cursor = 0, restored = '';
  while (cursor < text.length) {
    const chunk = outputChunk(text, cursor);
    assert(JSON.stringify(chunk.text).length <= 16000);
    assert.deepEqual(outputChunk(text, cursor), chunk);
    assert(chunk.end > cursor); assert(!/[\uD800-\uDBFF]$/.test(chunk.text));
    restored += chunk.text; cursor = chunk.end;
  }
  assert.equal(restored, text);
  assert.throws(() => outputChunk(text, 1), { code: 'INVALID_OUTPUT_CURSOR' });
});

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'process-output-')); t.after(() => rm(root, { recursive: true, force: true }));
  const filesystem = await ProjectFilesystem.open(root), scratch = new ScratchRuntime();
  const service = new AdvancedRuntimeService({ filesystem, scratch }); t.after(() => service.close());
  const owner = crypto.randomUUID(); await service.open({ owner, surface: 'agent_command', permission: 'workspace_write' }); await service.grant(owner);
  let sequence = 0;
  const call = (name, args, id = `call-${++sequence}`) => service.call({ owner, call: { id, name, args } });
  return { filesystem, scratch, service, owner, call };
}

test('large completed commands retain status and cursor across receipts, retries and transport', { skip: !native }, async t => {
  const f = await fixture(t);
  const args = { cmd: "printf x >> once.txt; i=0; while [ $i -lt 12000 ]; do printf '\\360\\237\\247\\254\\346\\274\\242\\t\\001'; i=$((i+1)); done", yield_time_ms: 1000 };
  const first = await f.call('exec_command', args, 'execute-once');
  assert.equal(first.status, 'completed', JSON.stringify(first)); assert(first.output_remaining > 0);
  assert.deepEqual(await f.call('exec_command', args, 'execute-once'), first);
  let result = first, output = result.output, polls = 0;
  while (result.output_remaining) {
    const poll = { process_id: first.process_id, output_cursor: result.output_cursor, yield_time_ms: 0 };
    result = await f.call('write_stdin', poll, `poll-${++polls}`);
    assert.deepEqual(await f.call('write_stdin', poll, `poll-${polls}`), result);
    assert.equal(result.status, 'completed'); assert.equal(result.exit_code, 0);
    const request = { id: `poll-${polls}`, name: 'write_stdin', args: poll };
    const receipt = { id: request.id, result: { ok: true, runtimeCall: request, value: result } };
    assert(JSON.stringify(receipt).length < 80000);
    continuation.withResults({ runtimeVersion: 1, totalToolCalls: 0, pending: [request], agentMessages: [{ role: 'tool', tool_call_id: request.id, content: 'pending' }] }, [receipt]);
    output += result.output;
  }
  assert.equal(output, '🧬漢\t\u0001'.repeat(12000)); assert(!output.includes('\uFFFD'));
  assert.equal((await f.call('write_stdin', { process_id: first.process_id, yield_time_ms: 0 })).output, '');
  const again = await f.call('write_stdin', { process_id: first.process_id, output_cursor: 0, yield_time_ms: 0 });
  assert.equal(again.output, first.output);
  const reconstructed = new AdvancedRuntimeService({ filesystem: f.filesystem, scratch: f.scratch });
  await reconstructed.open({ owner: f.owner, surface: 'agent_command', permission: 'workspace_write' });
  assert.deepEqual(await reconstructed.call({ owner: f.owner, call: { id: 'execute-once', name: 'exec_command', args } }), first);
  assert.equal(await f.scratch.session(f.owner).fs.readText('once.txt'), 'x');
  for (const file of await f.filesystem.list('.biodesign/runtime/tool-receipts')) assert.equal(JSON.parse(await f.filesystem.readText(`.biodesign/runtime/tool-receipts/${file.name}`)).status, 'completed');
});

test('output retention overflow reports truncation without killing a successful command', { skip: !native }, async t => {
  const f = await fixture(t);
  const result = await f.call('exec_command', { cmd: "printf '%0300000d' 0", yield_time_ms: 1000 });
  assert.equal(result.status, 'completed'); assert.equal(result.exit_code, 0);
  assert.equal(result.output_truncated, true); assert.equal(result.output_available, 262144); assert.equal(result.error, undefined);
});

test('background completion, cancellation, invalid cursors and owners preserve process identity', { skip: !native }, async t => {
  const f = await fixture(t);
  const running = await f.call('exec_command', { cmd: 'read line; printf "%s" "$line"', yield_time_ms: 0 });
  assert.equal(running.status, 'running');
  await assert.rejects(f.call('write_stdin', { process_id: running.process_id, output_cursor: 5, chars: 'should-not-write\n' }), { code: 'INVALID_OUTPUT_CURSOR' });
  const other = crypto.randomUUID(); await f.service.open({ owner: other, surface: 'agent_command', permission: 'workspace_write' }); await f.service.grant(other);
  await assert.rejects(f.service.call({ owner: other, call: { id: 'foreign', name: 'write_stdin', args: { process_id: running.process_id } } }), { code: 'PROCESS_NOT_FOUND' });
  const done = await f.call('write_stdin', { process_id: running.process_id, chars: 'finished\n', yield_time_ms: 1000 });
  assert.equal(done.process_id, running.process_id); assert.equal(done.status, 'completed'); assert.equal(done.output, 'finished');
  const next = await f.call('exec_command', { cmd: 'read line', yield_time_ms: 0 });
  const cancelled = await f.call('write_stdin', { process_id: next.process_id, terminate: true, yield_time_ms: 1000 });
  assert.equal(cancelled.process_id, next.process_id); assert.equal(cancelled.status, 'failed'); assert.match(cancelled.error, /SIGNAL/);
  await f.service.closeOwner(f.owner);
  await assert.rejects(f.call('write_stdin', { process_id: running.process_id }), { code: 'RUNTIME_OWNER_EXPIRED' });
});

test('large cell return values are readable JSON output, not uncertain executions', { skip: !native }, async t => {
  const f = await fixture(t), result = await f.call('run_code', { code: "return {text: '🧬'.repeat(40000)};", yield_time_ms: 1000 });
  assert.equal(result.status, 'completed'); assert.equal(result.value_delivery, 'output_json');
  let current = result, output = current.output;
  while (current.output_remaining) { current = await f.call('wait_code', { cell_id: result.cell_id, output_cursor: current.output_cursor, yield_time_ms: 0 }); output += current.output; }
  assert.equal(JSON.parse(output).text, '🧬'.repeat(40000)); assert.equal(current.status, 'completed');
});
