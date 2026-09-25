import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
const require = createRequire(import.meta.url);
for (const loading of ['files', 'asar']) test(`React desktop workbench preserves project, chat, role, continuation and persistence contracts (${loading})`, {
  timeout: 90000,
  skip: process.platform === 'linux' && !process.env.DISPLAY ? 'Requires an Electron display' : false,
}, async () => {
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  const { stdout } = await promisify(execFile)(require('electron'), [fileURLToPath(new URL('./react-workbench-fixture/main.cjs', import.meta.url)), loading], { env, timeout: 85000, maxBuffer: 2 * 1024 * 1024 });
  const line = stdout.split('\n').find(value => value.startsWith('REACT_WORKBENCH_RESULT '));
  assert.ok(line, stdout);
  const result = JSON.parse(line.slice('REACT_WORKBENCH_RESULT '.length));
  assert.deepEqual(result.failed, []); assert.deepEqual(result.errors, []);
  assert.ok(result.passed.length >= 25);
  console.log(`React workbench (${loading}): ${result.passed.length} checks passed; screenshots: ${result.screenshots.join(', ')}`);
});
