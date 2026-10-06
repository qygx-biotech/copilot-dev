import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, realpath, readFile, writeFile, rename, symlink, readdir, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { ScratchRuntime, sandboxProfile } from '../services/scratch-runtime.mjs';
import { AdvancedRuntimeService } from '../services/advanced-runtime-service.mjs';
import { ProjectFilesystem } from '../services/project-filesystem.mjs';
import crypto from 'node:crypto';

// Every test is offline; even the provider test below uses an injected fixture.
const native = process.env.BIODESIGN_SANDBOX_TEST === '1';
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const tick = () => new Promise(r => setImmediate(r));
const patch = name => `*** Begin Patch\n*** Add File: ${name}\n+fixture\n*** End Patch`;
async function runtimeFixture(t) {
  const runtime = new ScratchRuntime(); t.after(() => runtime.close());
  assert.equal(await runtime.available(), true); await runtime.open('owner'); return runtime;
}

for (const operation of ['write', 'read', 'remove', 'patch']) test(`kernel denies ${operation} after a validated parent is replaced with another owner's symlink`, { skip: !native }, async t => {
  const base = await realpath(await mkdtemp(path.join(os.tmpdir(), 'scratch-race-')));
  t.after(() => rm(base, { recursive: true, force: true }));
  const root = path.join(base, 'owner'), outside = path.join(base, 'other-owner');
  await mkdir(root); await mkdir(outside); await mkdir(path.join(root, 'directory'));
  await writeFile(path.join(root, 'directory', 'target'), 'inside');
  await writeFile(path.join(outside, 'target'), 'private other-owner bytes');
  const before = await readdir(outside);
  const worker = await readFile(new URL('../workers/scratch-files.cjs', import.meta.url), 'utf8');
  const parser = (await readFile(new URL('../services/scratch-patch.mjs', import.meta.url), 'utf8')).replace('export async function applyPatch', 'async function applyPatch');
  // Pause the *actual* primitive after validation. The parent performs the
  // adversarial replacement; no racy timing or production test hooks are used.
  const primitive = operation === 'remove' ? 'unlink' : 'open';
  const expression = operation === 'read' ? "await files.readText('directory/target')" : operation === 'remove' ? "await files.remove('directory/target')" : operation === 'patch' ? `await applyPatch(files, ${JSON.stringify(patch('directory/new'))})` : "await files.writeText('directory/new', 'escaped-write')";
  const source = `${worker}\n${parser}\n(async () => {
    const original = fs.${primitive}.bind(fs); let paused = false;
    fs.${primitive} = async (...args) => {
      if (!paused) { paused = true; process.stdout.write('READY\\n'); await new Promise(resolve => process.stdin.once('data', resolve)); process.stdin.pause(); }
      return original(...args);
    };
    try { const files = createScratchFilesystem(process.cwd()); const value = ${expression}; process.stdout.write(JSON.stringify({ value })); }
    catch (e) { process.stdout.write(JSON.stringify({ error: e.code })); }
  })();`;
  const executable = await realpath(process.execPath);
  const child = spawn('/usr/bin/sandbox-exec', ['-p', sandboxProfile(root, executable), executable, '-e', source], { cwd: root, env: { HOME: root, TMPDIR: root, OPENSSL_CONF: '/dev/null' }, stdio: ['pipe', 'pipe', 'pipe'] });
  t.after(() => child.kill('SIGKILL'));
  const ready = deferred(); let output = '', stderr = '';
  child.stdout.setEncoding('utf8'); child.stdout.on('data', text => { output += text; if (output.includes('READY\n')) ready.resolve(); });
  child.stderr.on('data', bytes => { stderr += bytes; });
  const closed = new Promise(resolve => child.once('close', resolve));
  const timeout = setTimeout(() => { child.kill('SIGKILL'); ready.resolve(); }, 5000); t.after(() => clearTimeout(timeout));
  await ready.promise; assert(output.includes('READY\n'), stderr);
  await rename(path.join(root, 'directory'), path.join(root, 'old'));
  await symlink(outside, path.join(root, 'directory'));
  child.stdin.end('continue'); await closed;
  const result = JSON.parse(output.split('\n').at(-1));
  assert.match(result.error, /^(EPERM|EACCES)$/);
  assert(!output.includes('private other-owner bytes'));
  assert.deepEqual(await readdir(outside), before, 'No escaped temporary or final write, even when the tool reports an error');
  assert.equal(await readFile(path.join(outside, 'target'), 'utf8'), 'private other-owner bytes');
});

test('owner lock serializes file operations and process admission; active cells fail file calls without waiting', { skip: !native }, async t => {
  const r = await runtimeFixture(t), original = r.fileWorker.bind(r), entered = deferred(), release = deferred();
  r.fileWorker = async (...args) => { entered.resolve(); await release.promise; return original(...args); };
  const write = r.call('owner', 'apply_patch', { patch: patch('first') }); await entered.promise;
  const code = r.call('owner', 'run_code', { code: 'await tools.clock_curr_time({});', yield_time_ms: 1000 });
  await tick(); assert.equal(r.session('owner').cells.size, 0);
  release.resolve(); await write;
  const cell = await code; assert.equal(cell.status, 'running');
  await assert.rejects(r.call('owner', 'apply_patch', { patch: patch('blocked') }), { code: 'SCRATCH_BUSY' });
  await assert.rejects(r.call('owner', 'view_image', { path: 'first' }), { code: 'SCRATCH_BUSY' });
  let result = await r.reply('owner', cell.cell_id, [{ id: cell.tool_calls[0].id, result: { ok: true, value: {} } }]);
  if (result.status === 'running') result = await r.call('owner', 'wait_code', { cell_id: cell.cell_id, yield_time_ms: 1000 });
  assert.equal(result.status, 'completed');
  await Promise.all([r.call('owner', 'apply_patch', { patch: patch('second') }), r.call('owner', 'apply_patch', { patch: patch('third') })]);
  assert.equal(await r.session('owner').fs.readText('second'), 'fixture\n');
});

test('owner cancellation prevents queued file writes and starts, drains the lease and preserves other owners', { skip: !native }, async t => {
  const r = await runtimeFixture(t); await r.open('other');
  const entered = deferred();
  const lease = r.withFiles('owner', async (_files, signal) => { entered.resolve(); await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true })); throw Object.assign(new Error(), { code: 'OPERATION_ABORTED' }); });
  await entered.promise;
  const results = Promise.allSettled([lease, r.call('owner', 'apply_patch', { patch: patch('never') }), r.start('owner', '/bin/sh', ['-c', 'printf never'])]);
  await r.closeOwner('owner');
  assert.deepEqual((await results).map(r => r.reason.code), ['OPERATION_ABORTED', 'RUNTIME_OWNER_EXPIRED', 'RUNTIME_OWNER_EXPIRED']);
  await r.call('other', 'apply_patch', { patch: patch('alive') });
  assert.equal(await r.session('other').fs.readText('alive'), 'fixture\n');
  await assert.rejects(r.call('owner', 'apply_patch', { patch: patch('stale') }), { code: 'RUNTIME_OWNER_EXPIRED' });
});

test('owner close kills an active file worker before removing scratch and never launches queued work', { skip: !native }, async t => {
  const r = await runtimeFixture(t), s = r.session('owner');
  // A local FIFO deterministically holds open() in the file worker. No network.
  execFileSync('/usr/bin/mkfifo', [path.join(s.root, 'blocked')]);
  const reading = assert.rejects(s.fs.readBinary('blocked'), { code: 'OPERATION_ABORTED' });
  for (let i = 0; !s.fileWorkers.size && i < 100; i++) await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(s.fileWorkers.size, 1);
  const queued = assert.rejects(r.call('owner', 'apply_patch', { patch: patch('never') }), { code: 'RUNTIME_OWNER_EXPIRED' });
  await r.closeOwner('owner'); await Promise.all([reading, queued]);
  assert.equal(s.fileWorkers.size, 0);
  await assert.rejects(readdir(s.root), { code: 'ENOENT' });
});

test('production file worker rejects traversal, static symlinks and cross-owner reads without touching the other owner', { skip: !native }, async t => {
  const r = await runtimeFixture(t); await r.open('other');
  await r.session('other').fs.writeText('secret', 'private');
  await symlink(r.session('other').root, path.join(r.session('owner').root, 'linked'));
  for (const target of ['../escape', '/absolute', 'linked/new']) {
    await assert.rejects(r.call('owner', 'apply_patch', { patch: patch(target) }));
  }
  await assert.rejects(r.session('owner').fs.readBinary('linked/secret'), { code: 'SYMLINK_NOT_ALLOWED' });
  assert.equal(await r.session('other').fs.readText('secret'), 'private');
  assert.equal(await r.session('other').fs.exists('new'), false);
  const unicode = '漢'.repeat(23000);
  await r.call('other', 'apply_patch', { patch: `*** Begin Patch\n*** Add File: unicode.txt\n+${unicode}\n*** End Patch` });
  assert.equal(await r.session('other').fs.readText('unicode.txt'), unicode + '\n', 'UTF-8 survives stdin chunk boundaries');
});

test('generated images hold the same scratch lease, reject busy cells before provider work, and cancel cleanly', { skip: !native }, async t => {
  const r = await runtimeFixture(t), root = await mkdtemp(path.join(os.tmpdir(), 'scratch-image-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const fs = await ProjectFilesystem.open(root), owner = crypto.randomUUID(), entered = deferred(), release = deferred(); let calls = 0;
  const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==';
  const service = new AdvancedRuntimeService({ filesystem: fs, scratch: r, config: { image: { endpoint: 'https://fixture.invalid/images', model: 'fixture', apiKey: 'fixture' } }, fetchImpl: async (_url, { signal }) => {
    calls++; entered.resolve(); await Promise.race([release.promise, new Promise((_, reject) => signal.addEventListener('abort', () => reject(Object.assign(new Error(), { code: 'OPERATION_ABORTED' })), { once: true }))]);
    return new Response(JSON.stringify({ data: [{ b64_json: png }] }));
  } }); t.after(() => service.close());
  await service.open({ owner, surface: 'agent_command', permission: 'workspace_write' }); await service.grant(owner);
  const running = await r.call(owner, 'run_code', { code: 'await tools.clock_curr_time({});', yield_time_ms: 1000 });
  await assert.rejects(service.call({ owner, call: { id: 'busy', name: 'image_gen_imagegen', args: { prompt: 'fixture' } } }), { code: 'SCRATCH_BUSY' }); assert.equal(calls, 0);
  await r.call(owner, 'wait_code', { cell_id: running.cell_id, terminate: true, yield_time_ms: 1000 });
  await r.session(owner).cells.get(running.cell_id).finished;
  const image = service.call({ owner, call: { id: 'cancel', name: 'image_gen_imagegen', args: { prompt: 'fixture' } } });
  const caught = assert.rejects(image, { code: 'OPERATION_ABORTED' }); await entered.promise;
  const start = r.start(owner, '/bin/sh', ['-c', 'printf never']); const denied = assert.rejects(start, { code: 'RUNTIME_OWNER_EXPIRED' });
  await tick(); assert.equal(r.session(owner).processes.size, 0);
  await service.closeOwner(owner); await Promise.all([caught, denied]);
  assert.equal(await fs.exists('.biodesign/runtime/generated-images'), false);
});
