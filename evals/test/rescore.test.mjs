import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { rescoreFrozenBaseline } from '../rescore.mjs';
import { SCORE_VERSION } from '../lib/scoring.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');
const provenance = { parentSHA: 'a'.repeat(64), scorerSHA256: 'b'.repeat(64), createdAt: '2026-09-07T00:00:00.000Z' };
const fixture = () => ({
  schemaVersion: '1', runId: 'synthetic-old-run', datasetHash: 'sha256:frozen-synthetic-suite',
  config: { gitCommit: 'original-execution-commit', productionTreeHash: 'original-production-tree', options: { seed: 9 } },
  testCases: [{ id: 'c1', categories: ['search'], query: 'Find source one.', gold: { paperIds: ['p1'], evidenceIds: ['e1'], hardChecks: [] } }],
  observations: [{ caseId: 'c1', repeat: 0, status: 'completed', executionMode: 'protocol', actual: { retrieval: { paperIds: ['p1'], evidenceIds: ['e1'] } }, timing: { latencyMs: 11, cacheState: 'cold' } }],
  cases: [{ caseId: 'c1', repeat: 0, metrics: { deliberately_stale_metric: 123 } }],
  summary: { scoreVersion: 'old-synthetic-scorer', dataset: { total: 1, selected: 1, fixture: 'synthetic' }, metrics: { stale: 123 } },
  failures: [{ stale: true }], judgeScores: { status: 'parent-only' },
});

test('rescore uses original raw evidence, replaces stale scores and preserves execution identity and missing release evidence', () => {
  const parent = fixture(); const original = JSON.stringify(parent);
  const result = rescoreFrozenBaseline(parent, provenance, { bootstrapSamples: 50 });
  assert.equal(JSON.stringify(parent), original);
  assert.deepEqual(result.observations, parent.observations);
  assert.deepEqual(result.testCases, parent.testCases);
  assert.deepEqual(result.config, parent.config);
  assert.equal(result.parentSHA, provenance.parentSHA);
  assert.equal(result.scoreVersion, SCORE_VERSION); assert.equal(result.summary.scoreVersion, SCORE_VERSION);
  assert.equal(result.rescore.parent.scoreVersion, 'old-synthetic-scorer');
  assert.equal(result.rescore.scoring.seed, 9); assert.equal(result.rescore.scoring.moduleSHA256, provenance.scorerSHA256);
  assert.equal(result.rescore.rawSourceIdentity.unchanged, true);
  assert.equal(result.rescore.rawSourceIdentity.datasetHash, parent.datasetHash);
  assert.match(result.rescore.rawSourceIdentity.observationsSHA256, /^[a-f\d]{64}$/);
  assert.equal(result.cases[0].metrics['retrieval.paper.recall5'], 1);
  assert.equal(result.cases[0].metrics.deliberately_stale_metric, undefined);
  assert.equal(result.summary.hardGates.status, 'unknown'); assert.equal(result.summary.releaseEligible, false);
  assert.equal(result.failures, undefined); assert.equal(result.judgeScores, undefined);
  const reordered = fixture(); reordered.observations[0] = Object.fromEntries(Object.entries(reordered.observations[0]).reverse());
  assert.equal(rescoreFrozenBaseline(reordered, provenance).rescore.rawSourceIdentity.observationsSHA256, result.rescore.rawSourceIdentity.observationsSHA256);
});

test('rescore rejects unavailable frozen inputs, ambiguous observation identities and unknown case references', () => {
  for (const key of ['testCases', 'observations']) {
    const source = fixture(); delete source[key];
    assert.throws(() => rescoreFrozenBaseline(source, provenance), /embedded/);
  }
  const duplicateCase = fixture(); duplicateCase.testCases.push(duplicateCase.testCases[0]);
  assert.throws(() => rescoreFrozenBaseline(duplicateCase, provenance), /Duplicate frozen case/);
  const duplicateObservation = fixture(); duplicateObservation.observations.push(duplicateObservation.observations[0]);
  assert.throws(() => rescoreFrozenBaseline(duplicateObservation, provenance), /Duplicate frozen observation/);
  const unknown = fixture(); unknown.observations[0].caseId = 'unknown';
  assert.throws(() => rescoreFrozenBaseline(unknown, provenance), /unknown frozen case/);
  assert.throws(() => rescoreFrozenBaseline(fixture(), provenance, { bootstrapSamples: 0 }), /samples must be positive/);
});

test('Node rescore CLI verifies frozen parent SHA, writes exclusively new output and leaves baseline bytes unchanged', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'rescore-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const input = join(dir, 'baseline.json'); const output = join(dir, 'rescored.json');
  const raw = `${JSON.stringify(fixture(), null, 2)}\n`; const parentSHA = hash(raw);
  await writeFile(input, raw); await writeFile(join(dir, 'baseline.sha256'), `${parentSHA}\n`);
  const cli = fileURLToPath(new URL('../rescore.mjs', import.meta.url));
  const args = [cli, '--baseline', input, '--output', output, '--expected-parent-sha', parentSHA];
  const result = spawnSync(process.execPath, args, { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  const reportBytes = await readFile(output, 'utf8'); const report = JSON.parse(reportBytes);
  assert.equal(report.parentSHA, parentSHA); assert.equal(report.summary.scoreVersion, SCORE_VERSION);
  assert.equal(report.rescore.parentDigestVerification.sidecarVerified, true);
  assert.equal(report.rescore.parentDigestVerification.expectedSHA256Verified, true);
  assert.equal(await readFile(input, 'utf8'), raw);
  const repeated = spawnSync(process.execPath, args, { encoding: 'utf8' });
  assert.equal(repeated.status, 1); assert.match(repeated.stderr, /EEXIST/);
  assert.equal(await readFile(output, 'utf8'), reportBytes); assert.equal(await readFile(input, 'utf8'), raw);
  const samePath = spawnSync(process.execPath, [cli, '--baseline', input, '--output', input], { encoding: 'utf8' });
  assert.equal(samePath.status, 1); assert.match(samePath.stderr, /immutable baseline/);
  await writeFile(join(dir, 'baseline.sha256'), `${'0'.repeat(64)}\n`);
  const rejectedOutput = join(dir, 'rejected.json');
  const invalidSHA = spawnSync(process.execPath, [cli, '--baseline', input, '--output', rejectedOutput], { encoding: 'utf8' });
  assert.equal(invalidSHA.status, 1); assert.match(invalidSHA.stderr, /frozen sidecar/);
  await assert.rejects(readFile(rejectedOutput), { code: 'ENOENT' });
  assert.equal(await readFile(input, 'utf8'), raw);
});
