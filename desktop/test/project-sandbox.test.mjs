import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import net from 'node:net';
import { lstat, mkdir, mkdtemp, readFile, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { seatbeltProfile, seatbeltArgs, projectPaths, projectPolicy, executableReadRoots } from '../services/sandbox-policy.mjs';
import { ScratchRuntime } from '../services/scratch-runtime.mjs';
import { applyPatch } from '../services/scratch-patch.mjs';
const { createScratchFilesystem } = createRequire(import.meta.url)('../workers/scratch-files.cjs');
const native = process.env.BIODESIGN_SANDBOX_TEST === '1';
const SECRET = 'mcp-credential-fixture';

async function temporary(t, label) {
  const directory = await realpath(await mkdtemp(path.join(os.tmpdir(), `biodesign-${label}-`)));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}
async function projectFixture(t) {
  const base = await temporary(t, 'project-sandbox');
  const root = path.join(base, 'project');
  await mkdir(path.join(root, 'literature'), { recursive: true }); await mkdir(path.join(root, 'data'));
  await mkdir(path.join(root, '.biodesign', 'runtime'), { recursive: true });
  await writeFile(path.join(root, 'literature', 'paper.txt'), 'original evidence');
  await writeFile(path.join(root, 'data', 'a.csv'), 'x,y\n1,2\n3,4\n');
  await writeFile(path.join(root, '.biodesign', 'runtime', 'mcp.json'), SECRET);
  await writeFile(path.join(base, 'outside.txt'), 'outside the project');
  return { base, root };
}
const caseInsensitive = async directory => {
  try { await stat(directory.toUpperCase()); return directory.toUpperCase() !== directory; } catch { return false; }
};
const gone = async pid => {
  for (let i = 0; i < 100; i++) {
    try { process.kill(pid, 0); } catch (error) { if (error.code === 'ESRCH') return true; }
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  return false;
};

test('profiles carry paths only as parameters, with hidden paths excluded from every allow', () => {
  const odd = '/tmp/proj (q"uote) )(allow file-write*)';
  const { profile, params } = seatbeltProfile({ read: [odd], write: [`${odd}/output`], hidden: [`${odd}/.biodesign`], anchors: [`${odd}/output`], fork: true });
  assert.ok(!profile.includes(odd) && !profile.includes('q"uote'), 'No path text is interpolated into the profile');
  assert.deepEqual(params.map(([key]) => key.split('_')[0]), ['HIDDEN', 'READ', 'WRITE', 'ANCHOR']);
  assert.match(profile, /\(allow process-fork\)/);
  assert.match(profile, /\(allow file-read-metadata \(require-all \(require-not \(literal \(param "HIDDEN_0"\)\)\)/);
  assert.match(profile, /\(deny file-write-unlink \(require-all \(literal \(param "ANCHOR_3"\)\) \(vnode-type DIRECTORY\)\)\)/);
  assert.match(profile.split('\n').at(-1), /^\(deny file-read\* file-read-metadata file-write\* \(literal \(param "HIDDEN_0"\)\)/);
  assert.doesNotMatch(seatbeltProfile({ read: ['/tmp/a'] }).profile, /process-fork|HIDDEN/);
  const argv = seatbeltArgs({ read: ['/tmp/a'] }, '/bin/sh', ['-c', 'true']);
  assert.deepEqual(argv.slice(0, 2), ['-D', 'READ_0=/tmp/a']);
  assert.deepEqual(argv.slice(-3), ['/bin/sh', '-c', 'true']);
  for (const bad of ['relative/path', '/tmp/a/../b', '/tmp/a\n(allow default)', '/tmp/a/'])
    assert.throws(() => seatbeltProfile({ read: [bad] }), { code: 'INVALID_SANDBOX_PATH' }, bad);
});

test('executables outside system folders bring only their own install locations', () => {
  assert.deepEqual(executableReadRoots('/opt/homebrew/Cellar/node/26.3.0/bin/node'),
    ['/opt/homebrew/Cellar/node/26.3.0/bin/node', '/opt/homebrew/Cellar', '/opt/homebrew/opt', '/opt/homebrew/lib']);
  assert.deepEqual(executableReadRoots('/Applications/BioDesign.app/Contents/MacOS/BioDesign'),
    ['/Applications/BioDesign.app/Contents/MacOS/BioDesign', '/Applications/BioDesign.app']);
});

test('project paths are canonical; output/ is created and must be a real directory inside the project', async t => {
  const { base, root } = await projectFixture(t);
  const paths = await projectPaths(root);
  const tasks = path.join(root, 'output', 'agent-tasks');
  assert.deepEqual(paths, { project: root, output: path.join(root, 'output'), outputRoot: path.join(root, 'output'), tasks, own: null, hidden: path.join(root, '.biodesign') });
  assert.ok((await lstat(paths.output)).isDirectory(), 'output/ is created when missing');
  assert.deepEqual(projectPolicy({ ...paths, privateRoot: '/tmp/private' }),
    { read: [root], write: [paths.output, '/tmp/private'], protect: [tasks], reopen: [], hidden: [paths.hidden], anchors: [paths.output, tasks], fork: true });
  if (await caseInsensitive(root)) assert.deepEqual(await projectPaths(root.toUpperCase()), paths, 'Seatbelt needs the on-disk case');
  await assert.rejects(projectPaths('relative'), { code: 'INVALID_PROJECT_ROOT' });

  const linked = path.join(base, 'linked'); await mkdir(linked);
  await symlink(path.join(root, 'literature'), path.join(linked, 'output'));
  await assert.rejects(projectPaths(linked), { code: 'INVALID_OUTPUT_DIRECTORY' });
  const file = path.join(base, 'file-output'); await mkdir(file); await writeFile(path.join(file, 'output'), 'not a folder');
  await assert.rejects(projectPaths(file), { code: 'INVALID_OUTPUT_DIRECTORY' });
  const metadata = path.join(base, 'metadata'); await mkdir(metadata);
  await symlink(base, path.join(metadata, '.biodesign'));
  await assert.rejects(projectPaths(metadata), { code: 'INVALID_PROJECT_METADATA' });
});

test('the project file worker reads outside .biodesign/ and writes only inside output/', async t => {
  const { root } = await projectFixture(t);
  await mkdir(path.join(root, 'output'));
  const files = createScratchFilesystem(root, { writable: 'output', hidden: '.biodesign' });
  assert.equal(await files.readText('literature/paper.txt'), 'original evidence');
  for (const name of ['.biodesign/runtime/mcp.json', '.BIODESIGN/runtime/mcp.json']) await assert.rejects(files.readText(name), { code: 'PATH_NOT_READABLE' }, name);
  for (const name of ['literature/paper.txt', 'new.txt', 'output']) await assert.rejects(files.writeText(name, 'x'), { code: 'PATH_NOT_WRITABLE' }, name);
  await assert.rejects(files.remove('literature/paper.txt'), { code: 'PATH_NOT_WRITABLE' });
  await files.writeText('output/sub/a.txt', 'generated');
  assert.equal(await readFile(path.join(root, 'output', 'sub', 'a.txt'), 'utf8'), 'generated');

  const add = name => `*** Add File: ${name}\n+text`;
  await assert.rejects(applyPatch(files, `*** Begin Patch\n${add('output/first.md')}\n${add('literature/second.md')}\n*** End Patch`), { code: 'PATH_NOT_WRITABLE' });
  await assert.rejects(stat(path.join(root, 'output', 'first.md')), { code: 'ENOENT' }, 'Nothing is written when any target is not writable');
  await assert.rejects(applyPatch(files, '*** Begin Patch\n*** Update File: output/sub/a.txt\n*** Move to: data/a.txt\n@@\n-generated\n+moved\n*** End Patch'), { code: 'PATH_NOT_WRITABLE' });
  const result = await applyPatch(files, `*** Begin Patch\n${add('output/report.md')}\n*** End Patch`);
  assert.equal(result.scope, 'project_output');
  assert.equal(createScratchFilesystem(root).scope, 'scratch');
});

// Parallel tasks (docs/codex-parity-features.md, decision 5).
test('task folders live in output/agent-tasks/, which a turn writing output/ can never write except its own', async t => {
  const { root } = await projectFixture(t);
  await assert.rejects(projectPaths(root, { task: 'Titre/Plot' }), { code: 'INVALID_TASK_FOLDER' });
  await assert.rejects(projectPaths(root, { readOnly: true, task: 'titre-plot-abc123' }), { code: 'INVALID_TASK_FOLDER' });
  await assert.rejects(projectPaths(root, { task: 'titre-plot-abc123', ownTask: 'titre-plot-abc123' }), { code: 'INVALID_TASK_FOLDER' });
  const tasks = path.join(root, 'output', 'agent-tasks');
  const paths = await projectPaths(root, { task: 'titre-plot-abc123' });
  assert.deepEqual([paths.output, paths.outputRoot, paths.tasks], [path.join(tasks, 'titre-plot-abc123'), path.join(root, 'output'), tasks]);
  assert.ok((await lstat(paths.output)).isDirectory());
  await symlink(path.join(root, 'literature'), path.join(tasks, 'linked-task'));
  await assert.rejects(projectPaths(root, { task: 'linked-task' }), { code: 'INVALID_OUTPUT_DIRECTORY' });
  await assert.rejects(projectPaths(root, { ownTask: 'linked-task' }), { code: 'INVALID_OUTPUT_DIRECTORY' });

  const task = projectPolicy({ ...paths, privateRoot: '/private/tmp/turn' });
  assert.deepEqual([task.write, task.protect, task.reopen, task.anchors], [[paths.output, '/private/tmp/turn'], [], [], [paths.outputRoot, tasks, paths.output]]);
  const whole = await projectPaths(root, { ownTask: 'summary-def456' });
  assert.equal(whole.own, path.join(tasks, 'summary-def456'));
  await assert.rejects(lstat(whole.own), { code: 'ENOENT' }, 'The own folder is created only when the turn writes there');
  const policy = projectPolicy({ ...whole, privateRoot: '/private/tmp/turn' });
  assert.deepEqual([policy.protect, policy.reopen], [[tasks], [whole.own]]);
  const { profile, params } = seatbeltProfile(policy);
  const key = (prefix, value) => params.find(([name, item]) => name.startsWith(prefix) && item === value)?.[0];
  const deny = profile.indexOf(`(deny file-write* (literal (param "${key('PROTECT_', tasks)}")) (subpath (param "${key('PROTECT_', tasks)}")))`);
  const allow = profile.indexOf(`(subpath (param "${key('REOPEN_', whole.own)}"))`);
  assert.ok(deny > 0 && allow > deny, 'The own folder is allowed again after the reserved folder is denied');
  assert.ok(!profile.includes(tasks), 'Paths travel only as parameters');

  // The file worker applies the same scope.
  const taskFiles = createScratchFilesystem(root, { writable: 'output/agent-tasks/titre-plot-abc123', hidden: '.biodesign' });
  await taskFiles.writeText('output/agent-tasks/titre-plot-abc123/plot.txt', 'plot');
  for (const name of ['output/top.txt', 'output/agent-tasks/other/x.txt', 'output/agent-tasks/titre-plot-abc123']) await assert.rejects(taskFiles.writeText(name, 'x'), { code: 'PATH_NOT_WRITABLE' }, name);
  const files = createScratchFilesystem(root, { writable: 'output', hidden: '.biodesign', protected: ['output/agent-tasks'], reopened: ['output/agent-tasks/summary-def456'] });
  await files.writeText('output/summary.md', 'summary');
  await files.writeText('output/agent-tasks/summary-def456/table.csv', 'a,b');
  for (const name of ['output/agent-tasks/titre-plot-abc123/plot.txt', 'output/AGENT-TASKS/titre-plot-abc123/new.txt', 'output/agent-tasks/new.txt', 'output/agent-tasks'])
    await assert.rejects(files.writeText(name, 'x'), { code: 'PATH_NOT_WRITABLE' }, name);
  await assert.rejects(files.remove('output/agent-tasks/titre-plot-abc123/plot.txt'), { code: 'PATH_NOT_WRITABLE' });
});

async function projectRuntime(t) {
  const fixture = await projectFixture(t);
  const runtime = new ScratchRuntime(); t.after(() => runtime.close());
  assert.equal(await runtime.projectAvailable(), true);
  await runtime.openProject('owner', { root: fixture.root });
  const run = async (cmd, options = {}) => runtime.call('owner', 'exec_command', { cmd, yield_time_ms: 5000, ...options });
  return { ...fixture, runtime, run };
}

test('real project sandbox reads the project, writes only output/ and hides .biodesign/', { skip: !native }, async t => {
  const { base, root, runtime, run } = await projectRuntime(t);
  let r = await run('cat literature/paper.txt && cat data/a.csv | wc -l | tr -d " "');
  assert.equal(r.exit_code, 0, JSON.stringify(r)); assert.equal(r.output, 'original evidence3\n');
  assert.deepEqual(await runtime.call('owner', 'wait_for_environment', {}),
    { status: 'ready', environment: 'project', network: false, project_access: 'read', writable: ['output/'], not_writable: ['output/agent-tasks/'], hidden: ['.biodesign/'], child_processes: true });

  const hiddenPaths = ['.biodesign/runtime/mcp.json', `/System/Volumes/Data${root}/.biodesign/runtime/mcp.json`,
    ...(await caseInsensitive(root) ? ['.BIODESIGN/runtime/mcp.json'] : [])];
  for (const file of hiddenPaths) {
    r = await run(`cat '${file}'`);
    assert.notEqual(r.exit_code, 0, file); assert.ok(!r.output.includes(SECRET), file);
  }
  r = await run('stat .biodesign/runtime/mcp.json'); assert.notEqual(r.exit_code, 0, 'Metadata of hidden files is denied');
  r = await run(`cat '${path.join(base, 'outside.txt')}'`); assert.notEqual(r.exit_code, 0); assert.ok(!r.output.includes('outside the project'));

  for (const cmd of ['echo changed > literature/paper.txt', 'echo x > new-at-root.txt', 'echo x > .biodesign/injected',
    'ln literature/paper.txt output/hard.txt', 'ln -s ../literature/paper.txt output/soft.txt; echo changed > output/soft.txt', 'mv output renamed'])
    assert.notEqual((await run(cmd)).exit_code, 0, cmd);
  r = await run('rm -rf output; test -d output && echo kept'); assert.equal(r.output, 'kept\n', 'The output/ anchor survives');
  assert.equal(await readFile(path.join(root, 'literature', 'paper.txt'), 'utf8'), 'original evidence');
  await assert.rejects(stat(path.join(root, 'new-at-root.txt')), { code: 'ENOENT' });

  r = await run('mkdir -p output/figures && printf "a\\nb\\n" | sort -r > output/figures/sorted.txt && cat output/figures/sorted.txt');
  assert.equal(r.output, 'b\na\n', JSON.stringify(r));
});

test('real project sandbox starts with a private home, an allowlisted environment and no network', { skip: !native }, async t => {
  process.env.BIODESIGN_PROJECT_SANDBOX_SECRET = SECRET; t.after(() => { delete process.env.BIODESIGN_PROJECT_SANDBOX_SECRET; });
  const { root, runtime, run } = await projectRuntime(t);
  const privateRoot = runtime.session('owner').privateRoot;
  let r = await run('printf "%s|%s\\n" "$HOME" "$TMPDIR"; echo tmp > "$TMPDIR/t"; env');
  assert.equal(r.output.split('\n')[0].split('|').slice(0, 2).join('|'), `${privateRoot}|${privateRoot}`);
  assert.ok(!r.output.includes(SECRET), 'The app environment is not inherited');
  assert.ok(!privateRoot.startsWith(root), 'The private folder is outside the project');

  let connections = 0;
  const server = net.createServer(socket => { connections++; socket.destroy(); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); t.after(() => server.close());
  const { port } = server.address();
  r = await run(`/usr/bin/nc -z -w 2 127.0.0.1 ${port}`); assert.notEqual(r.exit_code, 0);
  r = await runtime.call('owner', 'run_code', { yield_time_ms: 5000, code: `const net = await import('node:net');
    return await new Promise(resolve => net.connect(${port}, '127.0.0.1').on('connect', () => resolve('connected')).on('error', error => resolve(error.code)));` });
  if (r.status === 'running') r = await runtime.call('owner', 'wait_code', { cell_id: r.cell_id, yield_time_ms: 5000 });
  assert.notEqual(r.value, 'connected', JSON.stringify(r));
  assert.equal(connections, 0, 'No sandboxed connection reached the local server');
});

test('real project code cells and file tools follow the same scope', { skip: !native }, async t => {
  const { root, runtime } = await projectRuntime(t);
  let r = await runtime.call('owner', 'run_code', { yield_time_ms: 5000, code: `const fs = await import('node:fs/promises');
    const rows = (await fs.readFile('data/a.csv', 'utf8')).trim().split('\\n').length - 1;
    await fs.writeFile('output/summary.json', JSON.stringify({ rows }));
    const denied = [];
    for (const attempt of [() => fs.readFile('.biodesign/runtime/mcp.json'), () => fs.writeFile('literature/paper.txt', 'changed')])
      await attempt().catch(error => denied.push(error.code));
    return denied;` });
  if (r.status === 'running') r = await runtime.call('owner', 'wait_code', { cell_id: r.cell_id, yield_time_ms: 5000 });
  assert.equal(r.status, 'completed', JSON.stringify(r)); assert.deepEqual(r.value, ['EPERM', 'EPERM']);
  assert.deepEqual(JSON.parse(await readFile(path.join(root, 'output', 'summary.json'), 'utf8')), { rows: 2 });

  r = await runtime.call('owner', 'apply_patch', { patch: '*** Begin Patch\n*** Add File: output/report.md\n+# Report\n*** End Patch' });
  assert.deepEqual(r, { applied: [{ action: 'add', path: 'output/report.md' }], scope: 'project_output', source_evidence: false });
  await assert.rejects(runtime.call('owner', 'apply_patch', { patch: '*** Begin Patch\n*** Update File: literature/paper.txt\n@@\n-original evidence\n+changed\n*** End Patch' }), { code: 'PATH_NOT_WRITABLE' });
  assert.equal(await runtime.session('owner').fs.readText('literature/paper.txt'), 'original evidence');
  await assert.rejects(runtime.session('owner').fs.readText('.biodesign/runtime/mcp.json'), { code: 'PATH_NOT_READABLE' });
});

test('real project processes end with their command, timeout or turn; closing keeps the project', { skip: !native }, async t => {
  const { root, runtime, run } = await projectRuntime(t);
  let r = await run('(sleep 1; echo late > output/late.txt) & echo started');
  assert.equal(r.output, 'started\n', JSON.stringify(r));
  await new Promise(resolve => setTimeout(resolve, 1500));
  await assert.rejects(stat(path.join(root, 'output', 'late.txt')), { code: 'ENOENT' }, 'A background job ends with its command');

  r = await run('sleep 30 & echo $! > output/timeout.pid; wait', { yield_time_ms: 1000, timeout_ms: 300 });
  if (r.status === 'running') r = await runtime.call('owner', 'write_stdin', { process_id: r.process_id, yield_time_ms: 2000 });
  assert.equal(r.error, 'EXECUTION_TIMEOUT', JSON.stringify(r));
  assert.ok(await gone(Number(await readFile(path.join(root, 'output', 'timeout.pid'), 'utf8'))), 'A timeout kills descendants');

  r = await run('sleep 60 & echo $! > output/turn.pid; sleep 60', { yield_time_ms: 300 });
  assert.equal(r.status, 'running');
  const pid = Number(await readFile(path.join(root, 'output', 'turn.pid'), 'utf8'));
  const privateRoot = runtime.session('owner').privateRoot;
  await runtime.closeOwner('owner');
  assert.ok(await gone(pid), 'Closing the turn kills descendants');
  await assert.rejects(stat(privateRoot), { code: 'ENOENT' }, 'The private folder is removed');
  assert.equal(await readFile(path.join(root, 'literature', 'paper.txt'), 'utf8'), 'original evidence');
  assert.equal(await readFile(path.join(root, '.biodesign', 'runtime', 'mcp.json'), 'utf8'), SECRET);
  assert.ok((await stat(path.join(root, 'output', 'turn.pid'))).isFile(), 'Generated files stay in the project');
});

test('an owner keeps one mode and one project', { skip: !native }, async t => {
  const { base, root, runtime } = await projectRuntime(t);
  await runtime.openProject('owner', { root });
  await assert.rejects(runtime.open('owner'), { code: 'RUNTIME_OWNER_CONFLICT' });
  const other = path.join(base, 'other'); await mkdir(other);
  await assert.rejects(runtime.openProject('owner', { root: other }), { code: 'RUNTIME_OWNER_CONFLICT' });
  await runtime.open('scratch-owner');
  await assert.rejects(runtime.openProject('scratch-owner', { root }), { code: 'RUNTIME_OWNER_CONFLICT' });
});

test('real sandboxes: a task writes only its folder, and no command of a turn writing output/ can write another task\'s folder', { skip: !native }, async t => {
  const { root } = await projectFixture(t);
  const runtime = new ScratchRuntime(); t.after(() => runtime.close());
  const run = async (owner, cmd, wait = 5000) => runtime.call(owner, 'exec_command', { cmd, yield_time_ms: wait });
  const folder = path.join(root, 'output', 'agent-tasks', 'titre-plot-abc123');
  // The first turn starts alone and keeps its conversation's own folder writable.
  await runtime.openProject('first', { root, ownTask: 'summary-def456' });
  assert.deepEqual((await runtime.call('first', 'wait_for_environment', {})).writable, ['output/', 'output/agent-tasks/summary-def456/']);
  assert.equal((await run('first', 'mkdir -p output/agent-tasks/summary-def456 && echo own > output/agent-tasks/summary-def456/notes.txt && echo top > output/summary.md && echo ok')).output, 'ok\n');
  // A command it started before the second task began (the earlier hole)...
  const early = await run('first', 'sleep 1.5; mkdir -p output/agent-tasks/titre-plot-abc123; echo from-first > output/agent-tasks/titre-plot-abc123/plot.txt; echo exit=$?', 100);
  assert.equal(early.status, 'running');
  await runtime.openProject('second', { root, task: 'titre-plot-abc123' });
  assert.deepEqual((await runtime.call('second', 'wait_for_environment', {})).writable, ['output/agent-tasks/titre-plot-abc123/']);
  assert.equal((await run('second', 'echo plot > output/agent-tasks/titre-plot-abc123/plot.txt && cat literature/paper.txt')).output, 'original evidence');
  // ...cannot write the task's folder, because it never could.
  const late = await runtime.call('first', 'write_stdin', { process_id: early.process_id, yield_time_ms: 5000 });
  assert.equal(late.status, 'completed'); assert.doesNotMatch(late.output, /exit=0/, JSON.stringify(late));
  assert.equal(await readFile(path.join(folder, 'plot.txt'), 'utf8'), 'plot\n');
  for (const cmd of ['echo x > output/top.txt', 'mkdir output/agent-tasks/other', 'mv output/agent-tasks/titre-plot-abc123 output/agent-tasks/moved', 'echo x > literature/new.txt'])
    assert.notEqual((await run('second', cmd)).exit_code, 0, cmd);
  const intrusions = ['echo x > output/agent-tasks/titre-plot-abc123/plot.txt', 'rm output/agent-tasks/titre-plot-abc123/plot.txt', 'mv output/agent-tasks output/moved',
    'rm -rf output/agent-tasks/titre-plot-abc123', 'echo x > output/agent-tasks/new.txt', ...(await caseInsensitive(root) ? ['echo x > output/AGENT-TASKS/titre-plot-abc123/plot.txt'] : [])];
  for (const cmd of intrusions) assert.notEqual((await run('first', cmd)).exit_code, 0, cmd);
  await assert.rejects(runtime.call('first', 'apply_patch', { patch: '*** Begin Patch\n*** Add File: output/agent-tasks/titre-plot-abc123/x.md\n+x\n*** End Patch' }), { code: 'PATH_NOT_WRITABLE' });
  assert.equal(await readFile(path.join(folder, 'plot.txt'), 'utf8'), 'plot\n');
  await assert.rejects(runtime.openProject('second', { root }), { code: 'RUNTIME_OWNER_CONFLICT' }, 'A session keeps its task');
  // Even after the task ends, only its own conversation can write its folder.
  await runtime.closeOwner('second');
  assert.notEqual((await run('first', 'echo later > output/agent-tasks/titre-plot-abc123/later.txt')).exit_code, 0);
  await runtime.openProject('third', { root, ownTask: 'titre-plot-abc123' });
  assert.equal((await run('third', 'echo later > output/agent-tasks/titre-plot-abc123/later.txt')).exit_code, 0);
});

test('a read-only (plan mode) project sandbox reads the project and changes nothing in it', { skip: !native }, async t => {
  const { root } = await projectFixture(t);
  await assert.rejects(stat(path.join(root, 'output')), { code: 'ENOENT' });
  const runtime = new ScratchRuntime(); t.after(() => runtime.close());
  await runtime.openProject('planner', { root, readOnly: true });
  await assert.rejects(stat(path.join(root, 'output')), { code: 'ENOENT' }, 'A read-only session does not create output/');
  const run = async cmd => runtime.call('planner', 'exec_command', { cmd, yield_time_ms: 5000 });
  let r = await run('wc -l < data/a.csv | tr -d " "; echo scratch > "$TMPDIR/note" && cat "$TMPDIR/note"');
  assert.equal(r.output, '3\nscratch\n', JSON.stringify(r));
  for (const cmd of ['mkdir output', 'echo x > literature/new.txt', 'echo x > plan.md', 'cat .biodesign/runtime/mcp.json'])
    assert.notEqual((await run(cmd)).exit_code, 0, cmd);
  await assert.rejects(stat(path.join(root, 'output')), { code: 'ENOENT' });
  assert.equal((await runtime.call('planner', 'wait_for_environment', {})).read_only, true);
  await assert.rejects(runtime.call('planner', 'apply_patch', { patch: '*** Begin Patch\n*** Add File: output/plan.md\n+x\n*** End Patch' }), { code: 'PATH_NOT_WRITABLE' });
  await assert.rejects(runtime.openProject('planner', { root }), { code: 'RUNTIME_OWNER_CONFLICT' }, 'A session keeps its read-only mode');
});
