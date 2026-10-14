import crypto from 'node:crypto';
import { constants } from 'node:fs';
import { copyFile, cp, lstat, mkdir, open, readdir, readFile, rename, rm, rmdir, stat, unlink } from 'node:fs/promises';
import path from 'node:path';
const fail = code => Object.assign(new Error(code), { code });

// Host-side record of what a project-mode turn changed in output/. The host
// observes the folder itself; nothing the sandboxed process reports is trusted.
// - begin: snapshot output/ and back it up (APFS clones where available).
// - observe: after each execution call, compare output/ with the snapshot and
//   record created, changed and deleted files with their SHA-256 in the turn
//   manifest (.biodesign/runtime/generated/<owner>.json) and the path index
//   (.biodesign/runtime/generated/index.json) that labels generated sources.
// - undo: restore the backup for a finished turn, keeping files edited since.
// A parallel task's turn is scoped to its folder, output/agent-tasks/<task>/;
// a turn that writes output/ skips output/agent-tasks/ except its own folder.
export const LIMITS = Object.freeze({ entries: 20000, hashBytes: 512 * 1024 * 1024, fileHashBytes: 128 * 1024 * 1024,
  backupBytes: 1024 * 1024 * 1024, backups: 10, listed: 20, indexPaths: 5000, hashesPerPath: 5 });
export const OUTPUT = 'output';
const GENERATED = '.biodesign/runtime/generated';
const BACKUPS = '.biodesign/runtime/backups';
const OWNER = /^[a-f0-9-]{36}$/;
const TURN_ID = /^[A-Za-z0-9._:-]{1,200}$/;
const SCOPE = /^output(\/[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?){0,2}$/;
const within = (relative, folder) => relative === folder || relative.startsWith(`${folder}/`);
// Paths under an excluded folder are skipped, except kept folders and the
// folders leading to them.
const skipper = (exclude, keep) => relative => exclude.some(folder => within(relative, folder)) && !keep.some(folder => within(relative, folder) || within(folder, relative));

const signature = info => `${info.type}:${info.size}:${info.mtimeMs}:${info.ctimeMs}:${info.ino}`;
const typeOf = info => info.isSymbolicLink() ? 'symlink' : info.isFile() ? 'file' : info.isDirectory() ? 'directory' : 'other';

// Walks a folder without following symlinks. Directories are traversed but not
// reported; a change to any file's content or metadata changes its ctime.
// skip(relative) leaves a path, and anything below it, out of the walk.
async function walk(directory, prefix, limit, skip = () => false) {
  const entries = new Map(), directories = new Set();
  let complete = true;
  const visit = async (absolute, relative) => {
    let names;
    try { names = await readdir(absolute); } catch (error) { if (error.code === 'ENOENT') return; throw error; }
    for (const name of names.sort()) {
      if (entries.size + directories.size >= limit) { complete = false; return; }
      const childAbsolute = path.join(absolute, name), childRelative = `${relative}/${name}`;
      if (skip(childRelative)) continue;
      let info;
      try { info = await lstat(childAbsolute); } catch (error) { if (error.code === 'ENOENT') continue; throw error; }
      const type = typeOf(info);
      if (type === 'directory') { directories.add(childRelative); await visit(childAbsolute, childRelative); }
      else entries.set(childRelative, { type, size: info.size, mtimeMs: info.mtimeMs, ctimeMs: info.ctimeMs, ino: info.ino });
    }
  };
  await visit(directory, prefix);
  return { entries, directories, complete };
}

async function hashFile(absolute, maxBytes) {
  const handle = await open(absolute, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size > maxBytes) return null;
    const hash = crypto.createHash('sha256');
    for await (const chunk of handle.createReadStream({ autoClose: false })) hash.update(chunk);
    return `sha256:${hash.digest('hex')}`;
  } finally { await handle.close(); }
}

export class OutputProvenance {
  constructor({ filesystem, limits = {} }) {
    this.fs = filesystem; this.root = filesystem.root; this.limits = { ...LIMITS, ...limits };
    this.turns = new Map(); this.queue = Promise.resolve();
  }
  // Serializes manifest and index writes across concurrent turns.
  serialized(action) { const next = this.queue.then(action); this.queue = next.catch(() => {}); return next; }
  absolute(relative) { return path.join(this.root, ...relative.split('/')); }
  // Relative output paths only, with no symlinked component below the project.
  async target(relative) {
    if (typeof relative !== 'string' || !relative.startsWith(`${OUTPUT}/`) || relative.split('/').some(part => !part || part === '.' || part === '..')) throw fail('INVALID_OUTPUT_PATH');
    const parts = relative.split('/'); let current = this.root;
    for (const part of parts.slice(0, -1)) {
      current = path.join(current, part);
      const info = await lstat(current).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
      if (info && !info.isDirectory()) throw fail('OUTPUT_PATH_REPLACED');
    }
    return path.join(current, parts.at(-1));
  }

  // scope: the folder the turn can write; exclude: folders in it the turn
  // cannot write, apart from the kept ones.
  async begin(owner, { turnId, scope = OUTPUT, exclude = [], keep = [] } = {}) {
    if (!OWNER.test(owner)) throw fail('INVALID_RUNTIME_OWNER');
    if ([scope, ...exclude, ...keep].some(folder => typeof folder !== 'string' || !SCOPE.test(folder) || !within(folder, scope))) throw fail('INVALID_OUTPUT_PATH');
    if (this.turns.has(owner)) return this.turns.get(owner).manifest.backup;
    const skip = skipper(exclude, keep);
    const baseline = await walk(this.absolute(scope), scope, this.limits.entries, skip);
    const bytes = [...baseline.entries.values()].reduce((sum, entry) => sum + (entry.type === 'file' ? entry.size : 0), 0);
    let backup = { available: false, reason: !baseline.complete ? 'OUTPUT_TOO_MANY_ENTRIES' : bytes > this.limits.backupBytes ? 'OUTPUT_TOO_LARGE' : null };
    if (!backup.reason) {
      await this.fs.ensureDirectory(BACKUPS);
      const directory = this.absolute(`${BACKUPS}/${owner}`);
      await mkdir(directory);
      // An absent folder backs up as an empty folder.
      const copy = path.join(directory, ...scope.split('/'));
      await mkdir(path.dirname(copy), { recursive: true });
      if (await lstat(this.absolute(scope)).catch(() => null)) {
        const relativeOf = source => path.relative(this.root, source).split(path.sep).join('/');
        await cp(this.absolute(scope), copy, { recursive: true, verbatimSymlinks: true, errorOnExist: true, force: false,
          preserveTimestamps: true, mode: constants.COPYFILE_FICLONE, filter: source => !skip(relativeOf(source)) });
      } else await mkdir(copy);
      backup = { available: true };
      await this.prune(owner);
    }
    const now = new Date().toISOString();
    const manifest = { version: 1, owner, turnId: TURN_ID.test(turnId || '') ? turnId : null, scope, ...(exclude.length ? { exclude, keep } : {}),
      startedAt: now, updatedAt: now, complete: baseline.complete, backup, files: {} };
    this.turns.set(owner, { scope, skip, baseline, last: baseline, hashes: new Map(), manifest });
    await this.serialized(() => this.writeManifest(manifest));
    return backup;
  }

  // Keeps the newest backups; older turns can no longer be undone.
  async prune(current) {
    const directory = this.absolute(BACKUPS);
    const owners = (await readdir(directory)).filter(name => OWNER.test(name) && name !== current);
    const dated = await Promise.all(owners.map(async name => ({ name, time: (await stat(path.join(directory, name))).mtimeMs })));
    for (const { name } of dated.sort((a, b) => b.time - a.time).slice(this.limits.backups - 1)) await rm(path.join(directory, name), { recursive: true, force: true });
  }

  async hash(turn, relative, entry, budget) {
    if (entry.type !== 'file') return null;
    const key = `${relative}\n${signature(entry)}`;
    if (turn.hashes.has(key)) return turn.hashes.get(key);
    if (entry.size > this.limits.fileHashBytes || entry.size > budget.remaining) { budget.complete = false; return null; }
    budget.remaining -= entry.size;
    const value = await hashFile(this.absolute(relative), this.limits.fileHashBytes).catch(error => { if (['ENOENT', 'ELOOP'].includes(error.code)) return null; throw error; });
    turn.hashes.set(key, value);
    return value;
  }

  // Compares the turn's folder with its snapshot, updates the manifest and
  // index, and returns the changes since the previous observation plus totals.
  async observe(owner, callId) {
    const turn = this.turns.get(owner);
    if (!turn) return null;
    const current = await walk(this.absolute(turn.scope), turn.scope, this.limits.entries, turn.skip);
    const { baseline, last } = turn;
    const budget = { remaining: this.limits.hashBytes, complete: current.complete };
    const files = {};
    for (const [relative, entry] of current.entries) {
      const before = baseline.entries.get(relative);
      if (before && signature(before) === signature(entry)) continue;
      const sha256 = await this.hash(turn, relative, entry, budget);
      const previous = turn.manifest.files[relative];
      const same = previous && previous.sha256 === sha256 && previous.size === entry.size && previous.type === entry.type;
      files[relative] = { change: before ? 'changed' : 'created', type: entry.type, size: entry.size, sha256,
        observedAfter: same ? previous.observedAfter : callId };
    }
    for (const [relative, entry] of baseline.entries) {
      if (current.entries.has(relative)) continue;
      const previous = turn.manifest.files[relative];
      files[relative] = { change: 'deleted', type: entry.type, size: entry.size, sha256: null,
        observedAfter: previous?.change === 'deleted' ? previous.observedAfter : callId };
    }
    const changedSinceLast = (relative, entry) => !last.entries.has(relative) ? 'created' : signature(last.entries.get(relative)) !== signature(entry) ? 'changed' : null;
    const delta = { created: [], changed: [], deleted: [] };
    for (const [relative, entry] of current.entries) { const kind = changedSinceLast(relative, entry); if (kind) delta[kind].push(relative); }
    for (const relative of last.entries.keys()) if (!current.entries.has(relative)) delta.deleted.push(relative);
    turn.last = current;
    turn.manifest = { ...turn.manifest, updatedAt: new Date().toISOString(), complete: turn.manifest.complete && budget.complete, files };
    await this.serialized(async () => { await this.writeManifest(turn.manifest); await this.updateIndex(turn.manifest); });
    const totals = { created: 0, changed: 0, deleted: 0 };
    for (const entry of Object.values(files)) totals[entry.change]++;
    const listed = list => list.slice(0, this.limits.listed);
    return { created: listed(delta.created), changed: listed(delta.changed), deleted: listed(delta.deleted),
      ...(Object.values(delta).some(list => list.length > this.limits.listed) ? { truncated: true } : {}),
      turn: totals, complete: turn.manifest.complete, undo_available: turn.manifest.backup.available };
  }

  // The turn's state is released even when the final record cannot be written.
  async finish(owner) {
    if (!this.turns.has(owner)) return null;
    try {
      const result = await this.observe(owner, 'turn-end');
      const turn = this.turns.get(owner);
      turn.manifest = { ...turn.manifest, finishedAt: new Date().toISOString() };
      await this.serialized(() => this.writeManifest(turn.manifest));
      return result;
    } finally { this.turns.delete(owner); }
  }

  writeManifest(manifest) { return this.fs.writeText(`${GENERATED}/${manifest.owner}.json`, JSON.stringify(manifest)); }

  async readJson(relative) {
    try { return JSON.parse(await this.fs.readText(relative)); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  }

  // path -> recent generated hashes. A source is labelled generated while its
  // content hash matches one of them.
  async updateIndex(manifest) {
    const index = (await this.readJson(`${GENERATED}/index.json`)) || { version: 1, paths: {} };
    const at = manifest.updatedAt;
    for (const [relative, entry] of Object.entries(manifest.files)) {
      if (!entry.sha256) continue;
      const hashes = (index.paths[relative] || []).filter(item => item.sha256 !== entry.sha256);
      index.paths[relative] = [{ sha256: entry.sha256, turnId: manifest.turnId, at }, ...hashes].slice(0, this.limits.hashesPerPath);
    }
    const paths = Object.entries(index.paths).sort((a, b) => String(b[1][0]?.at).localeCompare(String(a[1][0]?.at))).slice(0, this.limits.indexPaths);
    await this.fs.writeText(`${GENERATED}/index.json`, JSON.stringify({ version: 1, paths: Object.fromEntries(paths) }));
  }

  async index() { return (await this.readJson(`${GENERATED}/index.json`)) || { version: 1, paths: {} }; }

  async manifestForTurn(turnId) {
    if (!TURN_ID.test(turnId || '')) throw fail('INVALID_TURN_ID');
    const names = (await this.fs.list(GENERATED).catch(error => { if (error.code === 'ENOENT') return []; throw error; }))
      .map(item => item.relativePath).filter(name => /\/[a-f0-9-]{36}\.json$/.test(name));
    const manifests = (await Promise.all(names.map(name => this.readJson(name)))).filter(item => item?.turnId === turnId);
    return manifests.sort((a, b) => String(b.startedAt).localeCompare(String(a.startedAt)))[0] || null;
  }

  // Restores output/ for a finished turn from its backup. A file is restored or
  // removed only while it still holds what the turn left; anything edited since
  // is kept and reported as a conflict.
  async undo(turnId) {
    const manifest = await this.manifestForTurn(turnId);
    if (!manifest || !Object.keys(manifest.files).length) throw fail('NO_OUTPUT_CHANGES');
    // A turn interrupted before its final record (a crash) can still be undone
    // once it is no longer running; only files that match the record change.
    if (this.turns.has(manifest.owner)) throw fail('TURN_ACTIVE');
    if (manifest.undoneAt) throw fail('ALREADY_UNDONE');
    if (!manifest.backup?.available) throw fail('UNDO_UNAVAILABLE');
    const backup = this.absolute(`${BACKUPS}/${manifest.owner}`);
    if (!(await stat(backup).catch(() => null))?.isDirectory()) throw fail('UNDO_UNAVAILABLE');
    const result = { restored: [], removed: [], conflicts: [] };
    const unchanged = async (absolute, entry) => {
      const info = await lstat(absolute).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
      if (entry.change === 'deleted') return !info;
      if (!info || typeOf(info) !== entry.type) return false;
      if (entry.type === 'symlink') return true;
      return Boolean(entry.sha256) && entry.sha256 === await hashFile(absolute, this.limits.fileHashBytes);
    };
    for (const [relative, entry] of Object.entries(manifest.files).sort(([a], [b]) => a.localeCompare(b))) {
      let absolute;
      try { absolute = await this.target(relative); } catch { result.conflicts.push(relative); continue; }
      if (!(await unchanged(absolute, entry))) { result.conflicts.push(relative); continue; }
      if (entry.change === 'created') { await unlink(absolute); result.removed.push(relative); continue; }
      const original = path.join(backup, ...relative.split('/'));
      const originalInfo = await lstat(original).catch(() => null);
      if (!originalInfo?.isFile()) { result.conflicts.push(relative); continue; }
      await mkdir(path.dirname(absolute), { recursive: true });
      await this.target(relative);
      const temporary = path.join(path.dirname(absolute), `.biodesign-restore-${crypto.randomUUID()}`);
      try { await copyFile(original, temporary, constants.COPYFILE_EXCL | constants.COPYFILE_FICLONE); await rename(temporary, absolute); }
      catch (error) { await rm(temporary, { force: true }); throw error; }
      result.restored.push(relative);
    }
    // Folders the turn created and that are now empty are removed.
    const folders = new Set(result.removed.flatMap(relative => relative.split('/').slice(1, -1).map((_, index, parts) => `${OUTPUT}/${parts.slice(0, index + 1).join('/')}`)));
    for (const folder of [...folders].sort((a, b) => b.length - a.length)) {
      if (await lstat(path.join(backup, ...folder.split('/'))).catch(() => null)) continue;
      await rmdir(this.absolute(folder)).catch(() => {});
    }
    const undone = { ...manifest, undoneAt: new Date().toISOString(), undo: result };
    await this.serialized(() => this.writeManifest(undone));
    return { turnId, ...result };
  }
}
