import test from 'node:test';
import assert from 'node:assert/strict';
import registryApi from '../../docs/runtime-tool-registry.js';
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const tick = () => new Promise(resolve => setImmediate(resolve));
const definition = name => ({ type: 'function', function: { name } });

test('parallel-safe reads overlap; exclusive work waits and prevents subsequent reads overtaking it', async () => {
  const registry = new registryApi.Registry(() => {}), events = [], readGate = deferred(), writeGate = deferred();
  registry.register(definition('read'), async call => { events.push(call.id); if (call.id !== 'r3') await readGate.promise; return call.id; }, { parallelSafe: true });
  registry.register(definition('write'), async () => { events.push('write'); await writeGate.promise; return 'write'; });
  const calls = [registry.execute({ name: 'read', id: 'r1' }), registry.execute({ name: 'read', id: 'r2' }),
    registry.execute({ name: 'write' }), registry.execute({ name: 'read', id: 'r3' })];
  await tick(); assert.deepEqual(events, ['r1', 'r2']);
  readGate.resolve(); await tick(); assert.deepEqual(events, ['r1', 'r2', 'write']);
  writeGate.resolve(); assert.deepEqual(await Promise.all(calls), ['r1', 'r2', 'write', 'r3']);
});

test('cancellation invalidates queued work before admission and does not retry failed handlers', async () => {
  let cancelled = false, runs = 0; const gate = deferred();
  const registry = new registryApi.Registry(() => { if (cancelled) throw Object.assign(new Error(), { code: 'OPERATION_ABORTED' }); });
  registry.register(definition('exclusive'), async () => { runs++; await gate.promise; throw new Error('uncertain effect'); });
  const results = Promise.allSettled([registry.execute({ name: 'exclusive' }), registry.execute({ name: 'exclusive' })]);
  await tick(); cancelled = true; gate.resolve();
  const settled = await results;
  assert.equal(runs, 1); assert.equal(settled[0].reason.message, 'uncertain effect');
  assert.equal(settled[1].reason.code, 'OPERATION_ABORTED');
});

test('unclassified tools are serialized and a failure does not poison the admission queue', async () => {
  const registry = new registryApi.Registry(() => {}); let running = 0, maximum = 0;
  registry.register(definition('mcp_read_hint'), async call => {
    maximum = Math.max(maximum, ++running); await tick(); running--;
    if (call.id === 'first') throw new Error('failed'); return 'second';
  });
  const result = await Promise.allSettled(['first', 'second'].map(id => registry.execute({ name: 'mcp_read_hint', id })));
  assert.equal(maximum, 1); assert.equal(result[0].status, 'rejected'); assert.equal(result[1].value, 'second');
});

test('coordinator waits for earlier exclusive work without locking out its own subcalls', async () => {
  const registry = new registryApi.Registry(() => {}), gate = deferred(), events = [];
  registry.register(definition('patch'), async () => { events.push('patch-start'); await gate.promise; events.push('patch-end'); });
  registry.register(definition('note'), async () => { events.push('note'); });
  registry.register(definition('code'), async () => { events.push('code'); await registry.execute({ name: 'note' }); }, { coordinator: true });
  const patch = registry.execute({ name: 'patch' }), code = registry.execute({ name: 'code' });
  await tick(); assert.deepEqual(events, ['patch-start']);
  gate.resolve(); await Promise.all([patch, code]);
  assert.deepEqual(events, ['patch-start', 'patch-end', 'code', 'note']);
});
