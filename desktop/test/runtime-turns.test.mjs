import test from 'node:test';
import assert from 'node:assert/strict';
import queueApi from '../../docs/runtime-turns.js';
const { InjectionQueue } = queueApi;

test('queued input remains pending until the backend acknowledges it and is not resent after acknowledgement', () => {
  const queue = new InjectionQueue();
  queue.enqueue('First', { id: 'first' }); queue.enqueue('Second', { id: 'second' });
  assert.deepEqual(queue.batch().map(item => item.id), ['first', 'second']);
  assert.deepEqual(queue.batch().map(item => item.id), ['first', 'second']);
  queue.acknowledge(['first', 'unknown']);
  assert.deepEqual(queue.batch().map(item => item.id), ['second']);
  assert.equal(queue.finish(), false);
  queue.acknowledge(['second']); assert.equal(queue.finish(), true);
  assert.throws(() => queue.enqueue('Too late'), { code: 'TURN_CLOSED' });
});

test('an input arriving at completion keeps the turn open; cancellation preserves delivery status', () => {
  const queue = new InjectionQueue();
  queue.enqueue('Delivered', { id: 'a' }); queue.acknowledge(['a']);
  queue.enqueue('Arrived while waiting for children', { id: 'b' });
  assert.equal(queue.finish(), false); queue.cancel();
  assert.deepEqual(queue.snapshot().map(item => item.status), ['received', 'not_received']);
  assert.throws(() => queue.enqueue('Cancelled'), { code: 'TURN_CLOSED' });
});

test('queue limits checkpoint size without dropping later entries or duplicate IDs', () => {
  const queue = new InjectionQueue();
  for (let i = 0; i < 20; i++) queue.enqueue('message', { id: String(i) });
  queue.enqueue('duplicate', { id: '1' });
  assert.equal(queue.batch().length, 16); assert.equal(queue.snapshot().length, 20);
  queue.acknowledge(queue.batch().map(item => item.id));
  assert.deepEqual(queue.batch().map(item => item.id), ['16', '17', '18', '19']);
  assert.throws(() => queue.enqueue('x'.repeat(64001)), { code: 'INJECTION_LIMIT' });
});

test('a full user queue reserves delivery slots for every permitted background child', () => {
  const queue = new InjectionQueue();
  for (let i = 0; i < 104; i++) queue.enqueue('Steering', { id: `user-${i}` });
  assert.throws(() => queue.enqueue('One more'), { code: 'INJECTION_LIMIT' });
  for (let i = 0; i < 24; i++) queue.enqueue('Child result', { id: `child-${i}`, kind: 'subagent' });
  assert.equal(queue.snapshot().length, 128);
  while (queue.hasPending()) queue.acknowledge(queue.batch().map(item => item.id));
  assert.equal(queue.finish(), true);
});
