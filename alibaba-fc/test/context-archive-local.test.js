'use strict';
// Context archives of the desktop agent loop live under the project
// (.biodesign/runtime/context-archives/). Archived originals are read back by
// content hash within the same account scope; journal claims are exclusive.
const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs/promises'), os = require('node:os'), path = require('node:path');
const { ContextRecovery } = require('../../shared/agent/context-recovery.js');

async function root(t, label) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), `context-archive-${label}-`));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return directory;
}

test('archives are read back by a resumed recovery in the same account scope and never from corrupt bytes', async t => {
  const options = { config: { root: await root(t, 'read') }, archiveAccount: 'account/project', model: 'fixture' };
  const first = new ContextRecovery(options), ref = await first.store('Complete original evidence, not a summary.');
  const resumed = new ContextRecovery({ ...options, state: first.snapshot() });
  assert.equal((await resumed.readArchive(ref)).content, 'Complete original evidence, not a summary.');
  assert.equal(resumed.state.archiveDurability, 'local_filesystem');
  const other = new ContextRecovery({ ...options, state: first.snapshot(), archiveAccount: 'other/project' });
  assert.equal((await other.readArchive(ref)).error, 'ARCHIVE_UNAVAILABLE', 'Another account scope cannot read the archive');
  const [file] = (await fs.readdir(options.config.root, { recursive: true, withFileTypes: true })).filter(entry => entry.name === `${ref}.txt`);
  await fs.writeFile(path.join(file.parentPath, file.name), 'corrupt');
  assert.equal((await resumed.readArchive(ref)).error, 'ARCHIVE_UNAVAILABLE', 'Corrupt bytes are never returned as the original');
});

test('journal claims are exclusive and durable for a resumed recovery; a missing archive reports no record', async t => {
  const directory = await root(t, 'journal');
  const first = new ContextRecovery({ config: { root: directory }, archiveAccount: 'account' });
  assert.equal(await first.archive.record('pending'), null);
  const values = [{ status: 'pending', args: 'bound' }, { status: 'changed' }];
  const claims = await Promise.all(values.map(value => first.archive.record('pending', value)));
  assert.deepEqual(claims.toSorted(), [false, true], 'Exactly one concurrent claim wins');
  const resumed = new ContextRecovery({ config: { root: directory }, archiveAccount: 'account', state: first.snapshot() });
  assert.deepEqual(await resumed.archive.record('pending'), values[claims.indexOf(true)]);
  assert.equal(await resumed.archive.record('pending', { status: 'later' }), false, 'A claim cannot be replaced');
  const elsewhere = new ContextRecovery({ config: { root: path.join(directory, 'other') }, archiveAccount: 'account', state: first.snapshot() });
  assert.equal(await elsewhere.archive.record('pending'), null, 'Another archive root has no record of the claim');
});
