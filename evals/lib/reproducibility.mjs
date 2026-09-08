import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const exec = promisify(execFile);
export const sha256 = data => crypto.createHash('sha256').update(data).digest('hex');
export async function git(root, ...args) { try { return (await exec('git', args, { cwd: root, maxBuffer: 16 * 1024 * 1024 })).stdout.trim(); } catch { return null; } }
export async function captureMetadata(root) {
  const names = (await git(root, 'ls-files', '-z') || '').split('\0').filter(Boolean);
  const hashes = {};
  for (const name of names) { try { hashes[name] = sha256(await fs.readFile(path.join(root, name))); } catch { hashes[name] = null; } }
  const pkg = JSON.parse(await fs.readFile(path.join(root, 'package.json')));
  const evaluationHarnessHashes = {};
  for (const entry of await fs.readdir(path.join(root, 'evals'), { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const absolute = path.join(entry.parentPath, entry.name);
    const relative = path.relative(path.join(root, 'evals'), absolute);
    if (/^(?:results|workspaces|biodesign-eval-v1|_preflight|reviewer-notes)\//.test(relative)) continue;
    if (!/\.(?:mjs|json|py)$/.test(relative)) continue;
    evaluationHarnessHashes[`evals/${relative}`] = sha256(await fs.readFile(absolute));
  }
  return { timestamp: new Date().toISOString(), gitCommit: await git(root, 'rev-parse', 'HEAD'), branch: await git(root, 'branch', '--show-current'),
    dirtyStatus: await git(root, 'status', '--short'), trackedFileHashes: hashes, evaluationHarnessHashes, productionTreeHash: sha256(JSON.stringify(Object.entries(hashes).filter(([p]) => !p.startsWith('evals/') && p !== 'package.json' && !p.startsWith('docs/AGENT_EVALUATION_REPORT')))),
    electronVersion: pkg.devDependencies.electron, qmdVersion: pkg.dependencies['@tobilu/qmd'], appVersion: pkg.version,
    runtime: process.versions, platform: process.platform, architecture: process.arch,
    fc: { target: 'https://biodesi-api-dev-jvvowibabk.cn-beijing.fcapp.run', revision: null }, modelConfigurationSignatures: null,
    promptSchemaIdentity: Object.fromEntries(Object.entries(hashes).filter(([p]) => /^(shared\/(semantic-intent|retrieval-contract|experiment-semantics)|alibaba-fc\/(index|side-chat-agent)|docs\/(request-pipeline|source-system|project-context-service))/.test(p))),
    limitations: ['A dirty tree is identified by content hashes as well as git commit.', 'Unknown deployed FC revision/model signatures are null; local source hashes do not prove deployed revision.'] };
}
export async function verifyFrozenSuite(directory) {
  const manifest = JSON.parse(await fs.readFile(path.join(directory, 'manifest.json'), 'utf8'));
  const entries = manifest.files || manifest.hashes || manifest.file_hashes;
  if (!entries) throw new Error('Frozen manifest must contain file hashes.');
  const normalized = Array.isArray(entries) ? entries.map(x => [x.path || x.file, x.sha256 || x.hash]) : Object.entries(entries).map(([p, h]) => [p, typeof h === 'string' ? h : h.sha256 || h.hash]);
  for (const [relative, expected] of normalized) {
    if (!relative || relative.includes('..') || path.isAbsolute(relative)) throw new Error('Invalid suite manifest path.');
    const actual = sha256(await fs.readFile(path.join(directory, relative)));
    if (actual !== String(expected).replace(/^sha256:/, '')) throw new Error(`Frozen suite changed: ${relative}. Create a new eval version; do not rewrite gold.`);
  }
  return { manifest, hash: sha256(await fs.readFile(path.join(directory, 'manifest.json'))), filesVerified: normalized.length };
}
export async function writeJson(file, value) { await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, JSON.stringify(value, null, 2) + '\n'); }
