// Benchmarks the production request gate and Electron filesystem metadata scan.
// PDF parsing, card generation and QMD responses are fixture adapters during setup;
// none of those adapters may be invoked during the measured unchanged turns.
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { ProjectFilesystem } from '../desktop/services/project-filesystem.mjs';
const require = createRequire(import.meta.url);
const { SyncWorkspace, createFixture } = require('../alibaba-fc/test/helpers/preflight-fixture.js');
const { AgentRequestPipeline } = require('../docs/request-pipeline.js');
class DiskWorkspace extends SyncWorkspace {
  constructor(filesystem) { super(); this.filesystem = filesystem; }
  async fileExists(relativePath) { return this.filesystem.exists(relativePath); }
  async readFile(relativePath) {
    if (!relativePath.startsWith('.biodesign/')) this.rawReads++;
    const metadata = await this.filesystem.stat(relativePath);
    const bytes = await this.filesystem.readBinary(relativePath);
    const file = new Blob([bytes]);
    Object.defineProperties(file, { name: { value: path.basename(relativePath) },
      lastModified: { value: metadata.lastModified }, mtimeNs: { value: metadata.mtimeNs },
      filesystemFileId: { value: metadata.filesystemFileId } });
    return file;
  }
  async writeFile(relativePath, value) { this.set(relativePath, value); await this.filesystem.writeText(relativePath, String(value)); }
  async writeJson(relativePath, value) { await this.writeFile(relativePath, JSON.stringify(value)); }
  async removeFile(relativePath) { this.files.delete(relativePath); if (await this.fileExists(relativePath)) await this.filesystem.remove(relativePath); }
  async scanDirectoryTree() { this.scans++; return this.filesystem.tree(); }
}
const temporary = await mkdtemp(path.join(os.tmpdir(), 'biodesign-preflight-benchmark-'));
const originalInfo = console.info;
try {
  console.info = () => {};
  const workspace = new DiskWorkspace(await ProjectFilesystem.open(temporary));
  await workspace.writeJson('.biodesign/literature/index.json', { schemaVersion: 1, documents: [] });
  const f = await createFixture({ workspace });
  // Avoid a debounce delay in fixture setup; real requests retain the existing policy.
  f.system.preparation.debounceMilliseconds = -1;
  for (let n = 1; n <= 150; n++) await workspace.writeFile(`literature/P${n}.pdf`, `%PDF fixture ${n} EctD A163V Km evidence.`);
  const seed = await f.pipeline.preflight({ turnId: 'setup' });
  if (seed.report.status !== 'completed') throw new Error(JSON.stringify(seed.report.failures));
  const before = { reads: workspace.rawReads, cards: f.calls.cards, indexes: f.calls.indexing, hashes: f.system.preparation.metrics.fullHashCalls };
  const samples = [];
  // A new gate instance also verifies that the metadata fast path survives restart.
  f.pipeline = new AgentRequestPipeline({ workspace, literature: f.literature, sourceSystem: f.system });
  for (let n = 0; n < 10; n++) {
    const result = await f.pipeline.preflight({ turnId: `bench-${n}` });
    if (result.telemetry.syncAgentSpawned || result.diff.unchanged !== 150) throw new Error('Unexpected synchronization');
    samples.push({ reconciliationMs: result.telemetry.reconciliationMs, mainAgentStartMs: result.telemetry.mainAgentStartMs });
  }
  const delta = { rawReads: workspace.rawReads - before.reads, hashes: f.system.preparation.metrics.fullHashCalls - before.hashes,
    cards: f.calls.cards - before.cards, qmdUpdates: f.calls.indexing - before.indexes };
  if (Object.values(delta).some(Boolean)) throw new Error(`Unchanged path processed sources: ${JSON.stringify(delta)}`);
  const stats = (key) => {
    const values = samples.map((sample) => sample[key]).sort((a, b) => a - b);
    return { median: values[Math.floor(values.length / 2)], p95: values[Math.ceil(values.length * 0.95) - 1], min: values[0], max: values.at(-1) };
  };
  console.log(JSON.stringify({ benchmark: '150 unchanged synchronized source fixtures', runtime: process.version, platform: `${process.platform}/${process.arch}`,
    iterations: samples.length, reconciliationMs: stats('reconciliationMs'), mainAgentStartMs: stats('mainAgentStartMs'), operations: delta,
    limitations: 'Real Electron ProjectFilesystem tree/stat and production registry/gate; synthetic source content, fixture setup parser/provider/QMD; no live provider or end-to-end answer latency measured.', samples }, null, 2));
} finally { console.info = originalInfo; await rm(temporary, { recursive: true, force: true }); }
