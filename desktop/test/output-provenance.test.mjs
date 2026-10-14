import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { lstat, mkdir, mkdtemp, readdir, readFile, realpath, rm, stat, symlink, utimes, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { OutputProvenance } from '../services/output-provenance.mjs';
import { AdvancedRuntimeService } from '../services/advanced-runtime-service.mjs';
import { ProjectFilesystem } from '../services/project-filesystem.mjs';

const sha = text => `sha256:${crypto.createHash('sha256').update(text).digest('hex')}`;
const owner = () => crypto.randomUUID();
async function project(t, files = {}) {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'biodesign-provenance-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, 'output')); await mkdir(path.join(root, 'literature'));
  await writeFile(path.join(root, 'literature', 'paper.txt'), 'original evidence');
  for (const [name, text] of Object.entries(files)) { await mkdir(path.dirname(path.join(root, name)), { recursive: true }); await writeFile(path.join(root, name), text); }
  const filesystem = await ProjectFilesystem.open(root);
  return { root, filesystem, file: name => path.join(root, ...name.split('/')) };
}
const manifestOf = async (root, id) => JSON.parse(await readFile(path.join(root, '.biodesign', 'runtime', 'generated', `${id}.json`), 'utf8'));
const indexOf = async root => JSON.parse(await readFile(path.join(root, '.biodesign', 'runtime', 'generated', 'index.json'), 'utf8'));

test('the turn manifest records created, changed and deleted output files with their hashes', async t => {
  const { root, filesystem, file } = await project(t, { 'output/keep.txt': 'kept', 'output/edit.md': 'v1', 'output/old.csv': 'a,b' });
  const provenance = new OutputProvenance({ filesystem }), id = owner();
  assert.deepEqual(await provenance.begin(id, { turnId: 'turn-1' }), { available: true });
  assert.equal(await readFile(path.join(root, '.biodesign', 'runtime', 'backups', id, 'output', 'edit.md'), 'utf8'), 'v1');

  await mkdir(file('output/figures')); await writeFile(file('output/figures/plot.svg'), '<svg/>');
  await writeFile(file('output/edit.md'), 'v2'); await rm(file('output/old.csv'));
  let changes = await provenance.observe(id, 'call-1');
  assert.deepEqual(changes, { created: ['output/figures/plot.svg'], changed: ['output/edit.md'], deleted: ['output/old.csv'],
    turn: { created: 1, changed: 1, deleted: 1 }, complete: true, undo_available: true });
  let manifest = await manifestOf(root, id);
  assert.equal(manifest.turnId, 'turn-1');
  assert.deepEqual(manifest.files['output/figures/plot.svg'], { change: 'created', type: 'file', size: 6, sha256: sha('<svg/>'), observedAfter: 'call-1' });
  assert.deepEqual(manifest.files['output/edit.md'], { change: 'changed', type: 'file', size: 2, sha256: sha('v2'), observedAfter: 'call-1' });
  assert.equal(manifest.files['output/old.csv'].change, 'deleted');
  assert.ok(!('output/keep.txt' in manifest.files));

  // A later call that changes nothing keeps the first observation; a rewrite moves it.
  changes = await provenance.observe(id, 'call-2');
  assert.deepEqual([changes.created, changes.changed, changes.deleted], [[], [], []]);
  await writeFile(file('output/edit.md'), 'v3');
  await provenance.observe(id, 'call-3');
  manifest = await manifestOf(root, id);
  assert.equal(manifest.files['output/figures/plot.svg'].observedAfter, 'call-1');
  assert.deepEqual([manifest.files['output/edit.md'].sha256, manifest.files['output/edit.md'].observedAfter], [sha('v3'), 'call-3']);
  // A file written back to its original content is still recorded as rewritten by the turn.
  await writeFile(file('output/edit.md'), 'v1'); await utimes(file('output/edit.md'), new Date(), new Date());
  manifest = (await provenance.observe(id, 'call-4'), await manifestOf(root, id));
  assert.equal(manifest.files['output/edit.md'].sha256, sha('v1'), 'Rewritten files stay recorded; content equality is not inferred from metadata');

  const index = await indexOf(root);
  assert.deepEqual(index.paths['output/edit.md'].map(item => item.sha256), [sha('v1'), sha('v3'), sha('v2')]);
  assert.equal(index.paths['output/figures/plot.svg'][0].turnId, 'turn-1');
  await provenance.finish(id);
  assert.ok((await manifestOf(root, id)).finishedAt);
});

test('symlinks in output/ are recorded without being followed', async t => {
  const { root, filesystem, file } = await project(t);
  const provenance = new OutputProvenance({ filesystem }), id = owner();
  await provenance.begin(id, { turnId: 'turn-links' });
  await symlink('../literature/paper.txt', file('output/paper-link.txt'));
  const changes = await provenance.observe(id, 'link');
  assert.deepEqual(changes.created, ['output/paper-link.txt']);
  assert.deepEqual((await manifestOf(root, id)).files['output/paper-link.txt'], { change: 'created', type: 'symlink', size: (await lstat(file('output/paper-link.txt'))).size, sha256: null, observedAfter: 'link' });
  await provenance.finish(id);
  const undone = await provenance.undo('turn-links');
  assert.deepEqual(undone.removed, ['output/paper-link.txt']);
  assert.equal(await readFile(file('literature/paper.txt'), 'utf8'), 'original evidence', 'The link target is untouched');
});

test('undo restores a finished turn, keeps later edits and never writes outside output/', async t => {
  const { root, filesystem, file } = await project(t, { 'output/summary.md': 'before', 'output/data/table.csv': 'x', 'output/notes.txt': 'notes' });
  const provenance = new OutputProvenance({ filesystem }), id = owner();
  await provenance.begin(id, { turnId: 'turn-undo' });
  await mkdir(file('output/new/deep'), { recursive: true }); await writeFile(file('output/new/deep/report.md'), 'generated');
  await writeFile(file('output/summary.md'), 'after'); await rm(file('output/notes.txt'));
  await writeFile(file('output/data/table.csv'), 'y'); await writeFile(file('output/edited-later.md'), 'generated');
  await provenance.observe(id, 'run');
  await assert.rejects(provenance.undo('turn-undo'), { code: 'TURN_ACTIVE' });
  await provenance.finish(id);

  await writeFile(file('output/edited-later.md'), 'the user edited this');
  // output/data is replaced by a symlink into literature/ after the turn, where a
  // file holds exactly what the turn left: only the path check prevents a write.
  await rm(file('output/data'), { recursive: true }); await symlink('../literature', file('output/data'));
  await writeFile(file('literature/table.csv'), 'y');
  const result = await provenance.undo('turn-undo');
  assert.deepEqual(result, { turnId: 'turn-undo', restored: ['output/notes.txt', 'output/summary.md'],
    removed: ['output/new/deep/report.md'], conflicts: ['output/data/table.csv', 'output/edited-later.md'] });
  assert.equal(await readFile(file('output/summary.md'), 'utf8'), 'before');
  assert.equal(await readFile(file('output/notes.txt'), 'utf8'), 'notes');
  await assert.rejects(stat(file('output/new')), { code: 'ENOENT' }, 'Folders the turn created are removed when empty');
  assert.equal(await readFile(file('output/edited-later.md'), 'utf8'), 'the user edited this');
  assert.equal(await readFile(file('literature/table.csv'), 'utf8'), 'y', 'Nothing is written through a replaced folder');
  await assert.rejects(provenance.undo('turn-undo'), { code: 'ALREADY_UNDONE' });
  await assert.rejects(provenance.undo('unknown-turn'), { code: 'NO_OUTPUT_CHANGES' });
  await assert.rejects(provenance.undo('../escape'), { code: 'INVALID_TURN_ID' });
  assert.equal((await manifestOf(root, id)).undo.restored.length, 2);
});

test('limits mark a turn incomplete and disable undo instead of truncating silently', async t => {
  const { filesystem, file } = await project(t, { 'output/a.txt': 'aaaa', 'output/b.txt': 'bbbb' });
  const large = new OutputProvenance({ filesystem, limits: { backupBytes: 4 } }), first = owner();
  assert.deepEqual(await large.begin(first, { turnId: 'turn-large' }), { available: false, reason: 'OUTPUT_TOO_LARGE' });
  await writeFile(file('output/c.txt'), 'c');
  assert.equal((await large.observe(first, 'run')).undo_available, false);
  await large.finish(first);
  await assert.rejects(large.undo('turn-large'), { code: 'UNDO_UNAVAILABLE' });

  const many = new OutputProvenance({ filesystem, limits: { entries: 2 } }), second = owner();
  assert.equal((await many.begin(second)).reason, 'OUTPUT_TOO_MANY_ENTRIES');
  assert.equal((await many.observe(second, 'run')).complete, false);

  const hashing = new OutputProvenance({ filesystem, limits: { hashBytes: 3 } }), third = owner();
  await hashing.begin(third); await writeFile(file('output/d.txt'), 'dddd');
  assert.equal((await hashing.observe(third, 'run')).complete, false);
});

test('only the newest backups are kept', async t => {
  const { root, filesystem } = await project(t);
  const provenance = new OutputProvenance({ filesystem, limits: { backups: 2 } });
  const owners = [owner(), owner(), owner()];
  for (const id of owners) { await provenance.begin(id); await provenance.finish(id); await new Promise(resolve => setTimeout(resolve, 15)); }
  assert.deepEqual((await readdir(path.join(root, '.biodesign', 'runtime', 'backups'))).sort(), owners.slice(1).sort());
});

test('project-mode calls carry output changes, failed calls are still recorded, and undo waits for the turn to close', async t => {
  const { root, filesystem, file } = await project(t);
  let behaviour = async () => ({ status: 'completed', exit_code: 0, output: '' });
  const scratch = { available: async () => false, projectAvailable: async () => true, openProject: async () => {}, closeOwner: async () => {}, close: async () => {},
    call: async (_owner, name, args) => behaviour(name, args) };
  const service = new AdvancedRuntimeService({ filesystem, scratch }); t.after(() => service.close());
  const id = owner();
  await service.open({ owner: id, surface: 'agent_command', permission: 'workspace_write', turnId: 'turn-service' });
  await service.grant(id, 'project_execution');
  behaviour = async () => { await writeFile(file('output/report.md'), '# Report'); return { status: 'completed', exit_code: 0, output: 'done' }; };
  const result = await service.call({ owner: id, call: { id: 'write', name: 'exec_command', args: { cmd: 'write' } } });
  assert.deepEqual(result.output_changes, { created: ['output/report.md'], changed: [], deleted: [], turn: { created: 1, changed: 0, deleted: 0 }, complete: true, undo_available: true });
  behaviour = async () => { await writeFile(file('output/partial.csv'), 'x'); throw Object.assign(new Error('failed'), { code: 'EXECUTION_TIMEOUT' }); };
  await assert.rejects(service.call({ owner: id, call: { id: 'fail', name: 'exec_command', args: { cmd: 'fail' } } }), { code: 'EXECUTION_TIMEOUT' });
  assert.equal((await manifestOf(root, id)).files['output/partial.csv'].observedAfter, 'fail');
  behaviour = async () => ({ value: 'not an execution tool' });
  assert.ok(!('output_changes' in await service.call({ owner: id, call: { id: 'clock', name: 'clock_curr_time', args: {} } })));
  await assert.rejects(service.undo({ turnId: 'turn-service' }), { code: 'TURN_ACTIVE' });
  await service.closeOwner(id);
  assert.deepEqual((await service.undo({ turnId: 'turn-service' })).removed, ['output/partial.csv', 'output/report.md']);
  await assert.rejects(service.open({ owner: owner(), surface: 'agent_command', permission: 'workspace_write', turnId: 'bad turn' }), { code: 'INVALID_TURN_ID' });
});

test('a project grant fails closed when its output/ snapshot cannot be recorded', async t => {
  const { filesystem } = await project(t);
  let closed = 0;
  const scratch = { available: async () => false, projectAvailable: async () => true, openProject: async () => {}, closeOwner: async () => { closed++; }, close: async () => {} };
  const provenance = { begin: async () => { throw Object.assign(new Error('disk'), { code: 'EACCES' }); } };
  const service = new AdvancedRuntimeService({ filesystem, scratch, provenance }); t.after(() => service.close());
  const id = owner(); await service.open({ owner: id, surface: 'agent_command', permission: 'workspace_write' });
  await assert.rejects(service.grant(id, 'project_execution'), { code: 'PROVENANCE_UNAVAILABLE' });
  assert.equal(closed, 1, 'The project sandbox is closed again');
  await assert.rejects(service.call({ owner: id, call: { id: 'run', name: 'exec_command', args: { cmd: 'true' } } }), { code: 'SCRATCH_PERMISSION_REQUIRED' });
});

// Parallel tasks (docs/codex-parity-features.md, decision 5): a turn that starts
// while another can write in the project writes only output/agent-tasks/<task>/;
// a turn writing output/ never records or undoes other conversations' folders.
test('task turns write, record and undo only their own folder; a turn writing output/ skips the other task folders', async t => {
  const { root, filesystem, file } = await project(t, { 'output/shared.csv': 'v1', 'output/agent-tasks/old-task-cccccc/old.csv': 'earlier task' });
  const opened = [], effects = new Map();
  const scratch = { available: async () => false, projectAvailable: async () => true, close: async () => {}, closeOwner: async () => {},
    openProject: async (_owner, options) => { opened.push([options.task, options.ownTask]); if (options.task) await mkdir(file(`output/agent-tasks/${options.task}`), { recursive: true }); },
    call: async (_owner, _name, args) => { await effects.get(args.cmd)?.(); return { status: 'completed', exit_code: 0, output: '' }; } };
  const service = new AdvancedRuntimeService({ filesystem, scratch }); t.after(() => service.close());
  const [first, second, unnamed, duplicate] = [owner(), owner(), owner(), owner()];
  const open = (id, turnId, taskFolder) => service.open({ owner: id, surface: 'agent_command', permission: 'workspace_write', turnId, ...(taskFolder ? { taskFolder } : {}) });
  await open(first, 'turn-first', 'summary-aaaaaa'); await open(second, 'turn-second', 'titre-plot-bbbbbb');
  await open(unnamed, 'turn-unnamed'); await open(duplicate, 'turn-duplicate', 'titre-plot-bbbbbb');
  await assert.rejects(open(owner(), 'turn-bad', 'Titre/Plot'), { code: 'INVALID_TASK_FOLDER' });

  // Grants are decided one at a time, in the order they were asked for.
  const [one, two] = await Promise.all([service.grant(first, 'project_execution'), service.grant(second, 'project_execution')]);
  assert.deepEqual([one.writable, one.not_writable, one.parallel_task], [['output/', 'output/agent-tasks/summary-aaaaaa/'], ['output/agent-tasks/'], undefined], 'The first turn writes output/ and its own folder');
  assert.deepEqual([two.writable, two.parallel_task], [['output/agent-tasks/titre-plot-bbbbbb/'], true]);
  assert.match(two.note, /writes only inside output\/agent-tasks\/titre-plot-bbbbbb\//);
  assert.deepEqual(opened, [[null, 'summary-aaaaaa'], ['titre-plot-bbbbbb', null]]);
  await assert.rejects(service.grant(unnamed, 'project_execution'), { code: 'TASK_FOLDER_REQUIRED' });
  await assert.rejects(service.grant(duplicate, 'project_execution'), { code: 'TASK_FOLDER_IN_USE' });
  const backup = path.join(root, '.biodesign', 'runtime', 'backups', first, 'output');
  assert.equal(await readFile(path.join(backup, 'shared.csv'), 'utf8'), 'v1');
  await assert.rejects(stat(path.join(backup, 'agent-tasks', 'old-task-cccccc')), { code: 'ENOENT' }, 'Other task folders are not backed up');

  effects.set('summary', async () => { await writeFile(file('output/summary.md'), '# Summary'); await mkdir(file('output/agent-tasks/summary-aaaaaa')); await writeFile(file('output/agent-tasks/summary-aaaaaa/table.csv'), 'a,b'); });
  effects.set('plot', () => writeFile(file('output/agent-tasks/titre-plot-bbbbbb/plot.svg'), '<svg/>'));
  const call = (id, cmd) => service.call({ owner: id, call: { id: cmd, name: 'exec_command', args: { cmd } } });
  assert.deepEqual((await call(first, 'summary')).output_changes.created, ['output/agent-tasks/summary-aaaaaa/table.csv', 'output/summary.md']);
  assert.deepEqual((await call(second, 'plot')).output_changes.created, ['output/agent-tasks/titre-plot-bbbbbb/plot.svg']);
  const later = (await call(first, 'nothing')).output_changes;
  assert.deepEqual([later.created, later.turn], [[], { created: 2, changed: 0, deleted: 0 }], "The task's file is not the first turn's change");
  const [firstManifest, secondManifest] = [await manifestOf(root, first), await manifestOf(root, second)];
  assert.deepEqual([firstManifest.scope, firstManifest.exclude, firstManifest.keep, secondManifest.scope], ['output', ['output/agent-tasks'], ['output/agent-tasks/summary-aaaaaa'], 'output/agent-tasks/titre-plot-bbbbbb']);
  assert.deepEqual(Object.keys(secondManifest.files), ['output/agent-tasks/titre-plot-bbbbbb/plot.svg']);

  // Each undo touches only its own turn's files.
  await service.closeOwner(first); await service.closeOwner(second);
  assert.deepEqual(await service.undo({ turnId: 'turn-first' }), { turnId: 'turn-first', restored: [], removed: ['output/agent-tasks/summary-aaaaaa/table.csv', 'output/summary.md'], conflicts: [] });
  assert.equal(await readFile(file('output/agent-tasks/titre-plot-bbbbbb/plot.svg'), 'utf8'), '<svg/>');
  assert.deepEqual((await service.undo({ turnId: 'turn-second' })).removed, ['output/agent-tasks/titre-plot-bbbbbb/plot.svg']);
  assert.equal(await readFile(file('output/shared.csv'), 'utf8'), 'v1');
  assert.equal(await readFile(file('output/agent-tasks/old-task-cccccc/old.csv'), 'utf8'), 'earlier task');

  // Alone again, a turn writes output/ and its own folder: sequential use is unchanged.
  const alone = owner(); await open(alone, 'turn-alone', 'titre-plot-bbbbbb');
  assert.deepEqual((await service.grant(alone, 'project_execution')).writable, ['output/', 'output/agent-tasks/titre-plot-bbbbbb/']);
});
