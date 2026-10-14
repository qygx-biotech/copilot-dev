import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readdir, readFile, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { ExecutionRuntime } from '../services/execution-runtime.mjs';
import { ScratchRuntime } from '../services/scratch-runtime.mjs';
import { AdvancedRuntimeService } from '../services/advanced-runtime-service.mjs';
import { ProjectFilesystem } from '../services/project-filesystem.mjs';
import { validateWindowsRelease } from '../main/windows-updater.mjs';

const native = process.env.BIODESIGN_SANDBOX_TEST === '1';
const realArchive = process.env.BIODESIGN_RUNTIME_ARCHIVE;
const target = `${process.platform}-${process.arch}`;
const sha256 = bytes => crypto.createHash('sha256').update(bytes).digest('hex');

async function temporary(t, label) {
  const directory = await realpath(await mkdtemp(path.join(os.tmpdir(), `biodesign-${label}-`)));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}
// A runtime archive shaped like the real one, with a shell-script python3.
async function fixtureArchive(t, { runtimeVersion = 'test-1', archiveTarget = target, pythonExecutable = 'python/bin/python3' } = {}) {
  const tree = await temporary(t, 'runtime-tree');
  await mkdir(path.join(tree, 'python', 'bin'), { recursive: true }); await mkdir(path.join(tree, 'node', 'bin'), { recursive: true });
  await writeFile(path.join(tree, 'python', 'bin', 'python3.12'), '#!/bin/sh\necho "fixture-python $*"\n'); await chmod(path.join(tree, 'python', 'bin', 'python3.12'), 0o755);
  await symlink('python3.12', path.join(tree, 'python', 'bin', 'python3'));
  await writeFile(path.join(tree, 'node', 'bin', 'node'), '#!/bin/sh\necho fixture-node\n'); await chmod(path.join(tree, 'node', 'bin', 'node'), 0o755);
  await writeFile(path.join(tree, 'BIODESIGN_RUNTIME.json'), JSON.stringify({ version: 1, runtimeVersion, target: archiveTarget,
    python: { version: '3.12.15', executable: pythonExecutable }, node: { version: 'v24.21.0', executable: 'node/bin/node' }, packages: {} }));
  const archive = path.join(tree, 'runtime.tar.gz');
  execFileSync('tar', ['-czf', archive, '-C', tree, 'BIODESIGN_RUNTIME.json', 'python', 'node']);
  return readFile(archive);
}
const manifestFor = (bytes, overrides = {}) => ({ version: 1, runtimeVersion: 'test-1', baseUrl: 'https://downloads.example/runtime',
  assets: { [target]: { file: 'runtime.tar.gz', sha256: sha256(bytes), size: bytes.length } }, ...overrides });
// A fetch serving bytes in chunks; `gate` pauses after the first chunk.
function serve(bytes, { status = 200, gate = null, url = '', length = bytes.length } = {}) {
  const calls = [];
  const fetchImpl = async (requested, options = {}) => {
    calls.push(requested);
    const body = new ReadableStream({
      async start(controller) {
        const chunks = [bytes.subarray(0, Math.floor(bytes.length / 2)), bytes.subarray(Math.floor(bytes.length / 2))];
        controller.enqueue(chunks[0]);
        if (gate) await gate;
        if (options.signal?.aborted) return controller.error(Object.assign(new Error('aborted'), { name: 'AbortError' }));
        controller.enqueue(chunks[1]); controller.close();
      },
    });
    return { ok: status >= 200 && status < 300, status, url, body, headers: new Headers({ 'content-length': String(length) }) };
  };
  return { fetchImpl, calls };
}

test('the runtime downloads once, verifies its pinned hash and installs atomically', async t => {
  const bytes = await fixtureArchive(t), root = await temporary(t, 'runtimes');
  await mkdir(path.join(root, 'old-version'));
  const { fetchImpl, calls } = serve(bytes);
  const runtime = new ExecutionRuntime({ root, manifest: manifestFor(bytes), fetchImpl });
  assert.deepEqual(await runtime.status(), { state: 'not_installed', version: 'test-1', downloadBytes: bytes.length });
  const progress = []; runtime.on('progress', event => progress.push(event.receivedBytes));
  const installed = await runtime.ensure();
  assert.deepEqual(calls, ['https://downloads.example/runtime/runtime.tar.gz']);
  assert.equal(progress.at(-1), bytes.length);
  assert.equal(installed.root, path.join(root, `test-1-${sha256(bytes).slice(0, 16)}`));
  assert.deepEqual([installed.python, installed.node], [path.join(installed.root, 'python/bin/python3'), path.join(installed.root, 'node/bin/node')]);
  assert.equal(execFileSync(installed.python, ['-c', 'x']).toString(), 'fixture-python -c x\n');
  assert.deepEqual((await readdir(root)).sort(), ['.downloads', path.basename(installed.root)], 'Older versions are removed');
  assert.deepEqual(await readdir(path.join(root, '.downloads')), [], 'No download is left behind');
  assert.deepEqual(await runtime.status(), { state: 'ready', version: 'test-1', downloadBytes: bytes.length, python: '3.12.15', node: 'v24.21.0' });

  const again = new ExecutionRuntime({ root, manifest: manifestFor(bytes), fetchImpl });
  await again.ensure();
  assert.equal(calls.length, 1, 'An installed runtime is reused without downloading');
  await writeFile(path.join(installed.root, '.biodesign-runtime.json'), JSON.stringify({ sha256: '0'.repeat(64) }));
  const stale = new ExecutionRuntime({ root, manifest: manifestFor(bytes), fetchImpl });
  await stale.ensure();
  assert.equal(calls.length, 2, 'A marker for another archive is reinstalled');
});

test('wrong hashes, sizes, failed or insecure downloads leave nothing installed and can be retried', async t => {
  const bytes = await fixtureArchive(t);
  const cases = [
    ['hash', { manifest: manifestFor(bytes, { assets: { [target]: { file: 'runtime.tar.gz', sha256: 'f'.repeat(64), size: bytes.length } } }) }, 'RUNTIME_DOWNLOAD_INVALID'],
    ['truncated', { serveBytes: bytes.subarray(0, bytes.length - 10), length: 0 }, 'RUNTIME_DOWNLOAD_INVALID'],
    ['oversized', { serveBytes: Buffer.concat([bytes, Buffer.from('extra')]), length: 0 }, 'RUNTIME_DOWNLOAD_INVALID'],
    ['declared length', { length: bytes.length + 1 }, 'RUNTIME_DOWNLOAD_INVALID'],
    ['http 404', { status: 404 }, 'RUNTIME_DOWNLOAD_FAILED'],
    ['redirect to http', { url: 'http://downloads.example/runtime.tar.gz' }, 'RUNTIME_DOWNLOAD_FAILED'],
  ];
  for (const [name, options, code] of cases) {
    const root = await temporary(t, `runtime-${name.replaceAll(' ', '-')}`);
    const runtime = new ExecutionRuntime({ root, manifest: options.manifest || manifestFor(bytes), fetchImpl: serve(options.serveBytes || bytes, options).fetchImpl });
    await assert.rejects(runtime.ensure(), { code }, name);
    assert.deepEqual(await runtime.status(), { state: 'failed', version: 'test-1', downloadBytes: bytes.length, error: code }, name);
    assert.deepEqual((await readdir(root)).filter(entry => entry !== '.downloads'), [], `${name}: nothing installed`);
    assert.deepEqual(await readdir(path.join(root, '.downloads')).catch(() => []), [], `${name}: no partial download`);
    if (name === 'http 404') {
      runtime.fetch = serve(bytes).fetchImpl;
      assert.equal((await runtime.ensure()).pythonVersion, '3.12.15', 'A failed install can be retried');
    }
  }
});

test('the archive must describe the pinned runtime for this platform', async t => {
  for (const [name, options] of [['version', { runtimeVersion: 'other' }], ['target', { archiveTarget: 'win32-x64' }], ['escape', { pythonExecutable: '../outside/python3' }]]) {
    const bytes = await fixtureArchive(t, options), root = await temporary(t, `runtime-archive-${name}`);
    const runtime = new ExecutionRuntime({ root, manifest: manifestFor(bytes), fetchImpl: serve(bytes).fetchImpl });
    await assert.rejects(runtime.ensure(), { code: 'RUNTIME_ARCHIVE_INVALID' }, name);
    assert.deepEqual((await readdir(root)).filter(entry => entry !== '.downloads'), [], `${name}: staging removed`);
  }
  const bytes = await fixtureArchive(t), root = await temporary(t, 'runtime-unsupported');
  for (const manifest of [null, manifestFor(bytes, { assets: {} }), manifestFor(bytes, { baseUrl: 'http://downloads.example' }),
    manifestFor(bytes, { assets: { [target]: { file: '../runtime.tar.gz', sha256: sha256(bytes), size: bytes.length } } })]) {
    const runtime = new ExecutionRuntime({ root, manifest, fetchImpl: serve(bytes).fetchImpl });
    assert.deepEqual(await runtime.status(), { state: 'unsupported' });
    await assert.rejects(runtime.ensure(), { code: 'RUNTIME_UNSUPPORTED' });
  }
});

test('concurrent turns share one download; a waiter can stop waiting and closing aborts it', async t => {
  const bytes = await fixtureArchive(t), root = await temporary(t, 'runtime-concurrent');
  let release; const gate = new Promise(resolve => { release = resolve; });
  const { fetchImpl, calls } = serve(bytes, { gate });
  const runtime = new ExecutionRuntime({ root, manifest: manifestFor(bytes), fetchImpl });
  const controller = new AbortController();
  const first = runtime.ensure(), waiting = runtime.ensure({ signal: controller.signal });
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal((await runtime.status()).state, 'installing');
  controller.abort();
  await assert.rejects(waiting, { code: 'OPERATION_ABORTED' });
  release();
  await first;
  assert.equal(calls.length, 1);

  const closingRoot = await temporary(t, 'runtime-closing');
  let never; const stalled = new Promise(resolve => { never = resolve; });
  const closing = new ExecutionRuntime({ root: closingRoot, manifest: manifestFor(bytes), fetchImpl: serve(bytes, { gate: stalled }).fetchImpl });
  const pending = closing.ensure();
  await new Promise(resolve => setTimeout(resolve, 20));
  const closed = closing.close(); never();
  await assert.rejects(pending, { code: 'OPERATION_ABORTED' });
  await closed;
  assert.deepEqual(await readdir(path.join(closingRoot, '.downloads')), []);
});

test('the Windows updater ignores the runtime release', () => {
  const release = { tag_name: 'execution-runtime-2026.10.1', draft: false, prerelease: false,
    html_url: 'https://github.com/qygx-biotech/copilot-dev/releases/tag/execution-runtime-2026.10.1',
    assets: [{ name: 'biodesign-runtime-2026.10.1-win32-x64.tar.gz' }, { name: 'biodesign-runtime-2026.10.1-darwin-arm64.tar.gz' }] };
  for (const currentVersion of ['0.1.7', '0.1.7-beta.7']) assert.equal(validateWindowsRelease(release, { currentVersion }), null);
});

test('project grants start the runtime download, the approval reports its size and wait_for_environment waits for it', async t => {
  const bytes = await fixtureArchive(t), root = await temporary(t, 'runtime-service');
  let release; const gate = new Promise(resolve => { release = resolve; });
  const { fetchImpl, calls } = serve(bytes, { gate });
  const runtime = new ExecutionRuntime({ root, manifest: manifestFor(bytes), fetchImpl });
  const project = await temporary(t, 'runtime-project');
  const scratch = { available: async () => false, projectAvailable: async () => true, openProject: async () => {}, closeOwner: async () => {}, close: async () => {},
    call: async (_owner, name) => name === 'wait_for_environment' ? { status: 'ready', environment: 'project' } : { ran: name } };
  const service = new AdvancedRuntimeService({ filesystem: await ProjectFilesystem.open(project), scratch, runtime });
  t.after(() => service.close());
  const owner = crypto.randomUUID();
  const capabilities = await service.open({ owner, surface: 'agent_command', permission: 'workspace_write' });
  assert.deepEqual(capabilities.runtime, { state: 'not_installed', downloadBytes: bytes.length });
  assert.ok(!capabilities.unavailableDependencies.includes('CODE_RUNTIME_UNAVAILABLE'), 'A downloadable runtime is not missing');
  const grant = await service.grant(owner, 'project_execution');
  assert.equal(grant.runtime.state, 'installing');
  assert.match(grant.runtime.note, /wait_for_environment/);
  for (let i = 0; i < 100 && !calls.length; i++) await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(calls.length, 1, 'The grant starts the download');
  setTimeout(release, 20);
  const environment = await service.call({ owner, call: { id: 'env', name: 'wait_for_environment', args: {} } });
  assert.deepEqual(environment, { status: 'ready', environment: 'project', runtime: { state: 'ready', version: 'test-1', downloadBytes: bytes.length, python: '3.12.15', node: 'v24.21.0' } });
});

test('code cells and file tools use the runtime Node, and say why when none is available yet', async t => {
  const bytes = await fixtureArchive(t), root = await temporary(t, 'runtime-node');
  const runtime = new ExecutionRuntime({ root, manifest: manifestFor(bytes), fetchImpl: serve(bytes).fetchImpl });
  // null: no system Node (undefined would select the default).
  const withoutNode = new ScratchRuntime({ platform: 'darwin', executable: null, runtime });
  await assert.rejects(withoutNode.nodeExecutable(), { code: 'CODE_RUNTIME_UNAVAILABLE' });
  runtime.state = 'installing';
  await assert.rejects(withoutNode.nodeExecutable(), { code: 'RUNTIME_PREPARING' });
  runtime.state = 'not_installed';
  const installed = await runtime.ensure();
  assert.equal(await withoutNode.nodeExecutable(), installed.node);
  assert.equal(await new ScratchRuntime({ platform: 'darwin', executable: process.execPath, runtime }).nodeExecutable(), installed.node, 'The runtime Node is preferred');
  await withoutNode.close();
});

test('real project sandbox runs the runtime python3 from PATH and cannot modify the runtime', { skip: !native }, async t => {
  const bytes = await fixtureArchive(t), root = await temporary(t, 'runtime-sandbox');
  const runtime = new ExecutionRuntime({ root, manifest: manifestFor(bytes), fetchImpl: serve(bytes).fetchImpl });
  const installed = await runtime.ensure();
  const project = await temporary(t, 'runtime-sandbox-project');
  const sandbox = new ScratchRuntime({ runtime }); t.after(() => sandbox.close());
  await sandbox.openProject('owner', { root: project });
  let result = await sandbox.call('owner', 'exec_command', { cmd: 'command -v python3; python3 --version', yield_time_ms: 5000 });
  assert.equal(result.output, `${installed.pythonBin}/python3\nfixture-python --version\n`, JSON.stringify(result));
  result = await sandbox.call('owner', 'exec_command', { cmd: `echo changed > '${installed.pythonBin}/python3.12'`, yield_time_ms: 5000 });
  assert.notEqual(result.exit_code, 0);
  assert.match(await readFile(path.join(installed.pythonBin, 'python3.12'), 'utf8'), /fixture-python/);
});

test('the built runtime runs pandas and matplotlib into output/ and serves cells without a system Node', { skip: !native || !realArchive }, async t => {
  const bytes = await readFile(realArchive);
  const record = JSON.parse(await readFile(`${realArchive}.json`, 'utf8'));
  assert.equal(sha256(bytes), record.sha256);
  const lock = JSON.parse(await readFile(new URL('../scripts/execution-runtime/lock.json', import.meta.url), 'utf8'));
  const root = await temporary(t, 'runtime-real');
  const runtime = new ExecutionRuntime({ root, target: record.target, fetchImpl: serve(bytes).fetchImpl,
    manifest: { version: 1, runtimeVersion: lock.runtimeVersion, baseUrl: 'https://downloads.example', assets: { [record.target]: { file: record.file, sha256: record.sha256, size: record.size } } } });
  await runtime.ensure();
  const project = await temporary(t, 'runtime-real-project');
  await mkdir(path.join(project, 'data'));
  await writeFile(path.join(project, 'data', 'fermentation.csv'), 'hour,titre\n0,0.1\n12,2.4\n24,6.8\n36,9.9\n48,11.6\n');
  const sandbox = new ScratchRuntime({ executable: null, runtime }); t.after(() => sandbox.close());
  assert.equal(await sandbox.available(), true, 'Scratch and cells need no system Node once the runtime is installed');
  await sandbox.openProject('owner', { root: project });
  const script = [
    'import pandas as pd, matplotlib.pyplot as plt, scipy.stats as st, openpyxl',
    "df = pd.read_csv('data/fermentation.csv')",
    'fit = st.linregress(df.hour, df.titre)',
    "df.describe().to_csv('output/summary.csv')",
    "ax = df.plot(x='hour', y='titre', marker='o'); ax.figure.savefig('output/titre.png')",
    "print(f'slope={fit.slope:.3f}')",
  ].join('\n');
  await writeFile(path.join(project, 'data', 'analyse.py'), script);
  const started = Date.now();
  let result = await sandbox.call('owner', 'exec_command', { cmd: 'python3 data/analyse.py', yield_time_ms: 10000, timeout_ms: 120000 });
  while (result.status === 'running') result = await sandbox.call('owner', 'write_stdin', { process_id: result.process_id, yield_time_ms: 10000 });
  assert.equal(result.exit_code, 0, JSON.stringify(result));
  assert.ok(!result.stderr.includes('building the font cache'), 'The installed font cache is reused');
  assert.ok(Date.now() - started < 20000, `The first analysis finishes promptly (${Date.now() - started} ms)`);
  assert.match(result.output, /^slope=0\.2\d\d\n$/);
  assert.match(await readFile(path.join(project, 'output', 'summary.csv'), 'utf8'), /^,hour,titre\ncount,5\.0,5\.0/);
  assert.deepEqual([...(await readFile(path.join(project, 'output', 'titre.png'))).subarray(1, 4)].map(code => String.fromCharCode(code)).join(''), 'PNG');
  result = await sandbox.call('owner', 'run_code', { code: "const fs = await import('node:fs/promises'); return (await fs.readFile('output/summary.csv', 'utf8')).split('\\n')[0];", yield_time_ms: 5000 });
  if (result.status === 'running') result = await sandbox.call('owner', 'wait_code', { cell_id: result.cell_id, yield_time_ms: 5000 });
  assert.equal(result.value, ',hour,titre', JSON.stringify(result));
  assert.equal((await sandbox.call('owner', 'apply_patch', { patch: '*** Begin Patch\n*** Add File: output/notes.md\n+Titre rises linearly.\n*** End Patch' })).scope, 'project_output');
  assert.ok((await stat(path.join(project, 'output', 'notes.md'))).isFile());
});
