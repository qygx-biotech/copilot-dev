// Build an uploadable FC archive from synchronized sources, never from a
// developer's possibly stale generated shared/ directory or environment files.
import './sync-shared.mjs';
import { cp, mkdir, mkdtemp, readdir, rename, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const scratch = await mkdtemp(path.join(tmpdir(), 'biodesign-fc-package-'));
const stage = path.join(scratch, 'runtime');
const output = path.join(root, 'Archive.zip');
try {
  await mkdir(stage);
  const files = (await readdir(root)).filter(name => name.endsWith('.js'));
  for (const name of [...files, 'src', 'shared', 'bootstrap', 'package.json', 'package-lock.json', 'node_modules']) {
    await cp(path.join(root, name), path.join(stage, name), { recursive: true });
  }
  // Health and authentication must be able to load without any deployment
  // credentials. Missing transitive imports fail here, before replacing a ZIP.
  execFileSync(process.execPath, ['-e', `
    const assert = require('node:assert/strict');
    Object.assign(process.env, { ADMIN_ACCOUNT: 'package-fixture', ADMIN_PASSWORD_HASH: require('bcryptjs').hashSync('fixture-password', 4), JWT_SECRET: 'package-fixture-signing-secret', BETA_USERS_JSON: '[]', REQUESTY_API_KEY: 'fixture-unused-key' });
    global.fetch = () => { throw new Error('Packaging checks must not access the network'); };
    const { handler } = require('./index.js');
    if (typeof handler !== 'function') throw new Error('Missing FC handler');
    if (typeof require('./src/index.js').handler !== 'function') throw new Error('Missing HTTP adapter');
    (async () => {
      assert.equal((await handler({ httpMethod: 'GET', path: '/health', headers: {} }, {})).statusCode, 200);
      const login = await handler({ httpMethod: 'POST', path: '/api/login', headers: {}, body: JSON.stringify({ account: 'package-fixture', password: 'fixture-password' }) }, {});
      assert.equal(login.statusCode, 200);
      const token = JSON.parse(login.body).token;
      assert.equal(typeof token, 'string');
      const session = await handler({ httpMethod: 'GET', path: '/api/me', headers: { Authorization: 'Bearer ' + token } }, {});
      assert.equal(session.statusCode, 200);
    })().catch(() => { process.exitCode = 1; });
  `], { cwd: stage, stdio: 'pipe', env: { PATH: process.env.PATH, NODE_ENV: 'test' } });
  const zip = path.join(scratch, 'Archive.zip');
  execFileSync('zip', ['-q', '-r', zip, '.'], { cwd: stage, stdio: 'pipe' });
  // Copy to the destination volume before the atomic rename; /tmp may be on a
  // different filesystem. An unsuccessful build keeps the previous archive.
  const pending = output + '.pending';
  await cp(zip, pending);
  await rename(pending, output);
  console.log('Validated Function Compute upload archive: alibaba-fc/Archive.zip');
} finally {
  await rm(scratch, { recursive: true, force: true });
}
