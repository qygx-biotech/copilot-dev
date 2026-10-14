'use strict';
// Trusted code, executed ONLY under the owner's OS sandbox. Path validation is
// defense in depth, not the boundary: a replaced parent must still be denied by
// the kernel before an out-of-root read/write. Never run this worker in main.
const fs = require('node:fs/promises');
const { constants } = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const invalid = code => Object.assign(new Error(code), { code });
const MAX_BYTES = 10 * 1024 * 1024;
// scope (project mode): { writable, hidden, protected, reopened }. hidden is a
// top-level folder name; writable is output or a parallel task's
// output/agent-tasks/<task>; protected folders (output/agent-tasks) are not
// writable except the reopened ones (the turn's own task folder). Reads exclude
// the hidden folder in any case, since volumes may be case-insensitive; writes
// and removals are limited to files inside the writable folder (none when it is
// null: a read-only project session) and outside protected folders.
function createScratchFilesystem(root, scope = null) {
  const candidate = name => {
    if (typeof name !== 'string' || name.includes('\\') || /[\x00-\x1f]/.test(name) || name.split('/').some(p => !p || p === '.' || p === '..')) throw invalid('INVALID_SCRATCH_PATH');
    if (scope && name.split('/')[0].toLowerCase() === scope.hidden.toLowerCase()) throw invalid('PATH_NOT_READABLE');
    return path.join(root, name);
  };
  const inside = (name, folder, caseless = false) => {
    const [a, b] = caseless ? [name.toLowerCase(), folder.toLowerCase()] : [name, folder];
    return a.startsWith(`${b}/`);
  };
  const assertWritable = name => {
    candidate(name);
    const within = (folder, caseless) => (caseless ? name.toLowerCase() === folder.toLowerCase() : name === folder) || inside(name, folder, caseless);
    if (scope && (!scope.writable || !inside(name, scope.writable) ||
      ((scope.protected || []).some(folder => within(folder, true)) && !(scope.reopened || []).some(folder => inside(name, folder))))) throw invalid('PATH_NOT_WRITABLE');
  };
  async function checked(name, parents = false, create = false) {
    candidate(name);
    const parts = name.split('/'); if (parents) parts.pop();
    let current = root;
    for (let i = 0; i < parts.length; i++) {
      current = path.join(current, parts[i]);
      if (create) await fs.mkdir(current).catch(e => { if (e.code !== 'EEXIST') throw e; });
      const info = await fs.lstat(current);
      if (info.isSymbolicLink()) throw invalid('SYMLINK_NOT_ALLOWED');
      if ((parents || i < parts.length - 1) && !info.isDirectory()) throw invalid('NOT_A_DIRECTORY');
    }
    return candidate(name);
  }
  const api = {
    candidate,
    assertWritable,
    scope: scope ? 'project_output' : 'scratch',
    async exists(name) { try { await checked(name); return true; } catch (e) { if (e.code === 'ENOENT') return false; throw e; } },
    async readBinary(name) {
      const file = await checked(name);
      const handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const info = await handle.stat();
        if (!info.isFile() || info.nlink !== 1) throw invalid('INVALID_READ_TARGET');
        if (info.size > MAX_BYTES) throw invalid('FILE_TOO_LARGE');
        const bytes = await handle.readFile();
        if (bytes.length > MAX_BYTES) throw invalid('FILE_TOO_LARGE');
        return bytes;
      } finally { await handle.close(); }
    },
    async readText(name) { return (await api.readBinary(name)).toString('utf8'); },
    async writeBinary(name, bytes) {
      assertWritable(name);
      if (bytes.length > MAX_BYTES) throw invalid('FILE_TOO_LARGE');
      const file = await checked(name, true, true);
      try { const info = await fs.lstat(file); if (info.isSymbolicLink() || !info.isFile()) throw invalid('INVALID_WRITE_TARGET'); }
      catch (e) { if (e.code !== 'ENOENT') throw e; }
      // Fresh inode + rename avoids modifying an existing hard-linked inode.
      const temporary = path.join(path.dirname(file), `.scratch-${crypto.randomUUID()}`);
      const handle = await fs.open(temporary, 'wx', 0o600);
      try { await handle.writeFile(bytes); await handle.sync(); }
      finally { await handle.close(); }
      try { await fs.rename(temporary, file); }
      catch (e) { await fs.unlink(temporary).catch(() => {}); throw e; }
      return { path: name, bytes: bytes.length };
    },
    async writeText(name, text) { return api.writeBinary(name, Buffer.from(text)); },
    async remove(name) {
      assertWritable(name);
      const file = await checked(name), info = await fs.lstat(file);
      if (!info.isFile()) throw invalid('INVALID_REMOVE_TARGET');
      await fs.unlink(file);
    },
  };
  return api;
}
async function runFileWorker(applyPatch) {
  try {
    let input = '';
    process.stdin.setEncoding('utf8');
    for await (const chunk of process.stdin) { input += chunk; if (input.length > 15 * 1024 * 1024) throw invalid('FILE_TOO_LARGE'); }
    const { operation, args, scope } = JSON.parse(input);
    const folder = value => typeof value === 'string' && /^output(\/[a-z0-9-]+){0,2}$/.test(value);
    const folders = value => value === undefined || (Array.isArray(value) && value.every(folder));
    if (scope !== undefined && ((scope?.writable !== null && !folder(scope?.writable)) || typeof scope?.hidden !== 'string' ||
      !folders(scope.protected) || !folders(scope.reopened))) throw invalid('INVALID_FILE_OPERATION');
    const files = createScratchFilesystem(process.cwd(), scope || null);
    let value;
    if (operation === 'patch') value = await applyPatch(files, args.patch);
    else if (operation === 'read') value = { data: (await files.readBinary(args.path)).toString('base64') };
    else if (operation === 'write') value = await files.writeBinary(args.path, Buffer.from(args.data, 'base64'));
    else if (operation === 'exists') value = await files.exists(args.path);
    else throw invalid('INVALID_FILE_OPERATION');
    process.stdout.write(JSON.stringify({ ok: true, value }));
  } catch (e) { process.stdout.write(JSON.stringify({ ok: false, error: /^[A-Z_]{1,100}$/.test(e.code || '') ? e.code : 'SCRATCH_FILE_FAILED' })); process.exitCode = 1; }
}
module.exports = { createScratchFilesystem, runFileWorker };
