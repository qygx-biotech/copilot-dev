import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
const require = createRequire(import.meta.url);
test('runtime interaction works in the sandboxed Electron renderer', {
  timeout: 30000, skip: process.platform === 'linux' && !process.env.DISPLAY ? 'Requires an Electron display' : false,
}, async () => {
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  const { stdout } = await promisify(execFile)(require('electron'), [fileURLToPath(new URL('./runtime-interaction-fixture/main.cjs', import.meta.url))], { env, timeout: 25000 });
  const line = stdout.split('\n').find(line => line.startsWith('RUNTIME_INTERACTION_RESULT '));
  assert.ok(line, stdout); assert.equal(JSON.parse(line.slice('RUNTIME_INTERACTION_RESULT '.length)).passed, 15);
});
