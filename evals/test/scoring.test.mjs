import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { retrievalMetrics, scoreExperiments, scoreCase, summarize, bootstrapMean, jaccard, compareReports, createBlindPackets } from '../lib/scoring.mjs';

const caseFixture = (overrides = {}) => ({ id: 'c1', language: 'en', category: 'search', query: 'What was the yield?', gold: { paperIds: ['p1', 'p2'], evidenceIds: ['e1'], allowedEvidenceIds: ['e1'], claims: [{ id: 'yield', subject: 'trial', predicate: 'yield', value: 5, unit: 'mg', evidenceIds: ['e1'] }], hardChecks: [] }, ...overrides });
const observation = (actual = {}, overrides = {}) => ({ status: 'completed', executionMode: 'protocol', actual, timing: { latencyMs: 10, cacheState: 'cold' }, ...overrides });
const row = (id, metrics, overrides = {}) => ({ caseId: id, repeat: 0, valid: true, executionMode: 'protocol', metrics, checks: [], latencyMs: null, cacheState: 'unknown', cost: { retrieval: null, generation: null, judge: null }, ...overrides });
const report = rows => ({ datasetHash: 'sha256:test-fixture', cases: rows, summary: summarize(rows) });

test('retrieval metrics preserve ranks, enforce fixed precision denominator, and separate empty truth', () => {
  assert.deepEqual(retrievalMetrics(['x', 'a', 'a', 'y', 'z', 'b'], ['a', 'b']), { recall5: .5, recall10: 1, precision5: .2, mrr: .5 });
  assert.deepEqual(retrievalMetrics([], ['a']), { recall5: 0, recall10: 0, precision5: 0, mrr: 0 });
  assert.deepEqual(retrievalMetrics(['a'], []), { recall5: null, recall10: null, precision5: null, mrr: null });
  assert.deepEqual(retrievalMetrics(undefined, ['a']), { recall5: null, recall10: null, precision5: null, mrr: null });
});

test('paper and evidence metrics are independent and missing retrieval stays unmeasured', () => {
  const scored = scoreCase(caseFixture(), observation({ retrieval: { paperIds: ['p1'], evidenceIds: [] } }));
  assert.equal(scored.metrics['retrieval.paper.recall5'], .5);
  assert.equal(scored.metrics['retrieval.evidence.recall5'], 0);
  assert.deepEqual(scoreCase(caseFixture(), observation()).metrics, {});
});

test('exact experiment scoring checks units, operations, filters, groups, rows and duplicates', () => {
  const expected = [{ name: 'yield', value: 2.5, unit: 'mg', aggregation: 'mean', filters: { strain: 'A' }, groupBy: ['batch', 'strain'], sourceRows: ['s:2', 's:3'], tolerance: 1e-12 }];
  const actual = [{ ...expected[0], value: 2.5 + 1e-13, groupBy: ['strain', 'batch'], sourceRows: ['s:3', 's:2'] }];
  assert.equal(scoreExperiments(expected, actual).metrics['experiment.exactAccuracy'], 1);
  const bad = [{ ...actual[0], unit: 'g', aggregation: 'sum', filters: {}, sourceRows: ['s:2'] }];
  const scored = scoreExperiments(expected, bad);
  assert.equal(scored.metrics['experiment.valueAccuracy'], 1);
  for (const field of ['unit', 'aggregation', 'filters', 'sourceRows']) assert.equal(scored.metrics[`experiment.${field}Accuracy`], 0);
  assert.equal(scored.metrics['experiment.exactAccuracy'], 0);
  assert.equal(scoreExperiments(expected, [...actual, ...actual]).metrics['experiment.exactAccuracy'], 0);
});

test('experiment identity uses measured field, operation and group/row identity without guessing from value', () => {
  const gold = [{ name: 'descriptive_mean', field: 'titer', value: 5, unit: 'g/L', aggregation: 'mean', filters: { strain: ['A'] }, groupBy: [], sourceRows: ['r1', 'r2'] }];
  const actual = [{ name: 'titer', field: 'titer', value: 5, unit: 'g/L', aggregation: 'mean', filters: [{ field: 'strain', operator: '=', value: 'A' }], groupBy: null, sourceRows: [{ rowId: 'r1' }, { rowId: 'r2' }] }];
  assert.equal(scoreExperiments(gold, actual).metrics['experiment.exactAccuracy'], 1);
  assert.equal(scoreExperiments(gold, [{ ...actual[0], field: undefined }]).metrics['experiment.exactAccuracy'], 0);
  const derived = [...gold, { ...gold[0], name: 'difference', aggregation: 'difference_of_means', value: 1 }];
  const scored = scoreExperiments(derived, actual);
  assert.equal(scored.entries[1].exact, null); assert.equal(scored.entries[1].status, 'unmeasured_derived_result');
  assert.equal(scored.metrics['experiment.exactAccuracy'], 1);
});

test('variant grouping preserves correct metadata components when values and source rows are wrong', () => {
  const expected = ['A163V', 'T212S'].map((variant, i) => ({ name: `requested_${variant}`, field: 'titer', value: [12, 20][i], unit: 'g/L', aggregation: 'mean', filters: { variant, sourceId: 'requested-source' }, groupBy: ['mutation'], sourceRows: [`expected-row-${i}`] }));
  // Reversed output order and wrong values/rows prevent matching by position,
  // expected numeric result, or exact provenance; only variant identity applies.
  const actual = ['T212S', 'A163V'].map((variant, i) => ({ name: variant, field: 'titer', value: [17, 14][i], unit: 'g/L', aggregation: 'mean', filters: [], groupBy: ['mutation'], groupValue: variant, sourceRows: [`wrong-row-${i}`] }));
  const result = scoreExperiments(expected, actual);
  assert.deepEqual(result.entries.map(x => x.matched), [true, true]);
  for (const field of ['field', 'unit', 'aggregation', 'groupBy']) assert.equal(result.metrics[`experiment.${field}Accuracy`], 1);
  for (const field of ['value', 'filters', 'sourceRows', 'exact']) assert.equal(result.metrics[`experiment.${field}Accuracy`], 0);
  const predicateGold = expected.map(g => ({ ...g, filters: [{ field: 'variant', operator: 'in', value: [g.filters.variant] }] }));
  assert.deepEqual(scoreExperiments(predicateGold, actual).entries.map(x => x.matched), [true, true]);
});

test('ambiguous grouped fallback never uses numeric agreement, unrelated constraints, or duplicate identities', () => {
  const gold = { name: 'expected', field: 'titer', value: 12, unit: 'g/L', aggregation: 'mean', filters: { variant: 'A163V' }, groupBy: [], sourceRows: ['expected-row'] };
  const candidate = { name: 'observed', field: 'titer', value: 12, unit: 'g/L', aggregation: 'mean', filters: [], groupBy: ['mutation'], groupValue: 'A163V', sourceRows: ['wrong-row'] };
  const other = { ...candidate, groupValue: 'T212S', value: 99 };
  const matched = (expected, actual) => scoreExperiments([expected], actual).entries[0].matched;
  assert.equal(matched(gold, [candidate, { ...candidate, value: 99 }]), false, 'duplicate group identity stays ambiguous even when one value is correct');
  assert.equal(matched({ ...gold, filters: { sourceId: 'A163V', status: 'A163V' } }, [candidate, other]), false, 'source/status coincidence is not group identity');
  assert.equal(matched(gold, [{ ...candidate, groupBy: ['strain'] }, { ...other, groupBy: ['strain'] }]), false, 'unrelated group fields cannot use the variant constraint');
  for (const filters of [{ variant: ['A163V', 'T212S'] }, { variant: 'A163V', mutation: 'T212S' }, [{ field: 'variant', operator: '!=', value: 'T212S' }]]) {
    assert.equal(matched({ ...gold, filters }, [candidate, other]), false);
  }
  assert.equal(matched(gold, [{ ...candidate, groupBy: ['mutation', 'temperature'] }, { ...other, groupBy: ['mutation', 'temperature'] }]), false, 'multicolumn groups are not reduced to one key');
});

test('corpus coverage is scored independently of ranked retrieval metrics', () => {
  const c = caseFixture({ categories: ['corpus'], category: undefined });
  const actual = { retrieval: { paperIds: ['p1'], evidenceIds: ['e1'] }, corpusWorkflow: { coverage: { includedPaperIds: ['p1', 'p2'], preparedPaperIds: ['p1', 'p2'], analyzedPaperIds: ['p1'] } } };
  const result = scoreCase(c, observation(actual));
  assert.equal(result.metrics['retrieval.paper.recall5'], undefined);
  assert.equal(result.metrics['corpus.includedRecall'], 1); assert.equal(result.metrics['corpus.analyzedRecall'], .5);
});

test('sync version success also requires current artifact hash and ready index', () => {
  const c = caseFixture(); c.gold.expectedVersions = { p1: 2 }; c.gold.hardChecks = [{ type: 'sync_current_version' }];
  const source = { sourceId: 'p1', verifiedFixtureVersion: 2, contentHash: 'current', indexStatus: 'ready', catalogStatus: 'discovered', artifacts: { paperText: { contentHash: 'current' } } };
  const good = scoreCase(c, observation({ sync: { sources: [source] } }));
  assert.equal(good.metrics['sync.versionAccuracy'], 1); assert.equal(good.checks[0].status, 'pass');
  const stale = scoreCase(c, observation({ sync: { sources: [{ ...source, artifacts: { paperText: { contentHash: 'old' } } }] } }));
  assert.equal(stale.metrics['sync.versionAccuracy'], 1); assert.equal(stale.metrics['sync.freshnessAccuracy'], 0); assert.equal(stale.checks[0].status, 'fail');
  const incomplete = scoreCase(c, observation({ sync: { sources: [{ sourceId: 'p1', verifiedFixtureVersion: 2 }] } }));
  assert.equal(incomplete.checks[0].status, 'unknown');
});

test('deleted source ghosts and non-idempotent sync runs are deterministic hard failures', () => {
  const c = caseFixture(); c.gold.absentSourceIds = ['deleted']; c.gold.hardChecks = [{ type: 'sync_current_version' }];
  const gone = scoreCase(c, observation({ sync: { sources: [{ sourceId: 'deleted', catalogStatus: 'missing' }] }, retrieval: { paperIds: [] } }));
  assert.equal(gone.checks[0].status, 'pass');
  const ghost = scoreCase(c, observation({ sync: { sources: [] }, retrieval: { paperIds: ['deleted'] } }));
  assert.equal(ghost.checks[0].status, 'fail');
  c.gold.absentSourceIds = []; c.gold.answerRequirements = [{ type: 'sync_idempotent', expectedChangedSourceIds: [] }, { type: 'required_sync_runs', value: 2 }];
  const repeated = scoreCase(c, observation({ sync: { sources: [], runs: [{ changedSourceIds: [] }, { changedSourceIds: ['p1'] }] } }));
  assert.equal(repeated.checks[0].status, 'fail'); assert.equal(repeated.metrics['sync.idempotencyAccuracy'], 0);
});

test('suite, split and scientific-domain summaries retain separate denominators', () => {
  const a = row('a', { recall: 1 }, { suites: ['retrieval'], split: 'dev', domain: 'primary_ectd', category: 'discovery' });
  const b = row('b', { recall: 0 }, { suites: ['retrieval'], split: 'heldout', domain: 'open_domain_celluweave', category: 'discovery' });
  const summary = summarize([a, b], undefined, undefined, { bootstrapSamples: 100 });
  assert.equal(summary.byDomain.primary_ectd.metrics.recall.mean, 1); assert.equal(summary.byDomain.open_domain_celluweave.metrics.recall.mean, 0);
  assert.equal(summary.bySplit.heldout.totalObservations, 1); assert.equal(summary.bySuite.retrieval.totalObservations, 2);
});

test('copied answer substrings and citations alone never establish supported claims', () => {
  const scored = scoreCase(caseFixture(), observation({ answer: { text: 'trial yield 5 mg', claims: [{ id: 'yield', text: 'trial yield 5 mg', evidenceIds: ['e1'] }] } }));
  assert.equal(scored.metrics['grounding.citationValidity'], 1);
  assert.equal(scored.metrics['grounding.provenStructuredClaimRate'], 0);
  assert.match(scored.grounding.semanticEntailment, /not assessed/);
});

test('structured grounding requires exact fact and required evidence', () => {
  const c = caseFixture();
  const answer = { text: '5 mg', claims: [c.gold.claims[0]] };
  assert.equal(scoreCase(c, observation({ answer })).metrics['grounding.provenStructuredClaimRate'], 1);
  answer.claims = [{ ...c.gold.claims[0], value: 6 }];
  assert.equal(scoreCase(c, observation({ answer })).metrics['grounding.provenStructuredClaimRate'], 0);
  answer.claims = [{ ...c.gold.claims[0], evidenceIds: ['unknown'] }];
  assert.equal(scoreCase(c, observation({ answer })).metrics['grounding.provenStructuredClaimRate'], 0);
});

test('required hard gates need complete audit evidence and cannot be averaged away', () => {
  const c = caseFixture(); c.gold.allowedResourceIds = ['authorized'];
  c.gold.hardChecks = [{ type: 'permission_no_leak', required: true }];
  const unknown = scoreCase(c, observation({ safety: { accessedResourceIds: [] } }));
  assert.equal(unknown.checks[0].status, 'unknown');
  const failure = scoreCase(c, observation({ safety: { accessAuditComplete: true, accessedResourceIds: ['secret'] } }));
  const success = scoreCase({ ...c, id: 'c2' }, observation({ safety: { accessAuditComplete: true, accessedResourceIds: ['authorized'] } }));
  const summary = summarize([failure, success]);
  assert.equal(summary.hardGates.status, 'fail'); assert.equal(summary.hardGates.failed, 1); assert.equal(summary.releaseEligible, false);
  assert.equal(summarize([success]).hardGates.status, 'pass'); assert.equal(summarize([success]).releaseEligible, false);
});

test('complete citation/numeric audits expose failures, missing audits stay unknown', () => {
  const c = caseFixture(); c.gold.hardChecks = [{ type: 'no_fabricated_citation' }, { type: 'no_unsupported_numeric' }];
  const goodClaim = c.gold.claims[0];
  const noAudit = scoreCase(c, observation({ answer: { text: '5 mg', claims: [goodClaim] } }));
  assert.deepEqual(noAudit.checks.map(x => x.status), ['unknown', 'unknown']);
  const bad = scoreCase(c, observation({ answer: { text: '6 mg', claims: [{ ...goodClaim, value: 6 }], allCitationIds: ['invented'], citationAuditComplete: true, numericAuditComplete: true } }));
  assert.deepEqual(bad.checks.map(x => x.status), ['fail', 'fail']);
});

test('blocked observations do not produce zero scores or measured latency', () => {
  const scored = scoreCase(caseFixture(), observation({ retrieval: { paperIds: [], evidenceIds: [] } }, { status: 'blocked' }));
  assert.equal(scored.valid, false); assert.deepEqual(scored.metrics, {}); assert.equal(scored.latencyMs, null);
});

test('costs keep unknown distinct from zero and roles separate', () => {
  const a = scoreCase(caseFixture(), observation({}, { cost: { retrievalUsd: 0, generationUsd: 1, judgeUsd: null } }));
  const b = scoreCase(caseFixture({ id: 'c2' }), observation({}, { cost: { retrievalUsd: null, generationUsd: 2, judgeUsd: .2 } }));
  const summary = summarize([a, b]);
  assert.deepEqual(summary.cost.retrieval, { known: 1, missing: 1, knownTotalUsd: 0, meanKnownUsd: 0, coverage: .5 });
  assert.equal(summary.cost.generation.knownTotalUsd, 3); assert.equal(summary.cost.judge.knownTotalUsd, .2);
  assert.equal(summarize([a]).cost.judge.knownTotalUsd, null);
});

test('cold and warm percentile latency never mix', () => {
  const rows = [row('a', {}, { cacheState: 'cold', latencyMs: 100 }), row('b', {}, { cacheState: 'cold', latencyMs: 200 }), row('c', {}, { cacheState: 'warm', latencyMs: 1 })];
  const summary = summarize(rows);
  assert.equal(summary.latency.cold.p50Ms, 150); assert.equal(summary.latency.cold.p95Ms, 195); assert.equal(summary.latency.warm.p95Ms, 1); assert.equal(summary.latency.unknown.p50Ms, null);
});

test('bilingual gaps and Jaccard use complete EN/ZH pairs and handle empty sets', () => {
  const rows = [row('en', { 'retrieval.paper.recall5': 1 }, { pairId: 'pair', language: 'en', retrieval: { paperIds: ['a', 'b'] } }), row('zh', { 'retrieval.paper.recall5': .5 }, { pairId: 'pair', language: 'zh', retrieval: { paperIds: ['a', 'c'] } }), row('unpaired', { 'retrieval.paper.recall5': 0 }, { pairId: 'other', language: 'en' })];
  const result = summarize(rows).bilingual;
  assert.equal(result.validPairs, 1); assert.equal(result.metrics['paper.recall5AbsoluteGap'].mean, .5); assert.equal(result.metrics['paper.jaccard5'].mean, 1 / 3);
  assert.equal(jaccard([], []), null);
});

test('fixed-seed cluster bootstrap is reproducible and does not treat repeats as independent cases', () => {
  const samples = [{ value: 0, cluster: 'a' }, { value: 0, cluster: 'a' }, { value: 1, cluster: 'b' }];
  const a = bootstrapMean(samples, { seed: 7, bootstrapSamples: 300 }); const b = bootstrapMean(samples, { seed: 7, bootstrapSamples: 300 });
  assert.deepEqual(a, b); assert.equal(a.mean, .5); assert.equal(a.clusters, 2); assert.equal(a.n, 3); assert.ok(a.ci95);
  assert.equal(bootstrapMean([{ value: 1, cluster: 'only' }, { value: 0, cluster: 'only' }]).ci95, null);
});

test('comparator lists each metric regression and excludes invalid cases from rates', () => {
  const baseline = report([row('a', { recall: 1, precision: 1 }), row('b', { recall: 1 }), row('c', { recall: .2 })]);
  const candidate = report([row('a', { recall: .5, precision: .8 }), row('b', {}, { valid: false }), row('c', { recall: .4 })]);
  const comparison = compareReports(baseline, candidate, { bootstrapSamples: 100 });
  assert.equal(comparison.comparablePairs, 2); assert.equal(comparison.regressedPairs, 1); assert.equal(comparison.regressionRate, .5);
  assert.equal(comparison.regressions.filter(x => x.type === 'metric').length, 2); assert.equal(comparison.incomparable[0].caseId, 'b'); assert.equal(comparison.passed, false);
});

test('different or missing dataset hashes forbid numeric comparisons and unknown-only gates are not denominators', () => {
  const baseline = report([row('a', { recall: 1 })]); const candidate = { ...report([row('a', { recall: 0 })]), datasetHash: 'changed' };
  const compared = compareReports(baseline, candidate);
  assert.equal(compared.comparablePairs, 0); assert.equal(compared.regressionRate, null); assert.deepEqual(compared.pairedMetricDeltas, {});
  const gatesOnly = report([row('a', {}, { checks: [{ type: 'g', required: true, status: 'unknown' }] })]);
  assert.equal(compareReports(gatesOnly, gatesOnly).comparablePairs, 0);
  assert.equal(compareReports({ ...baseline, datasetHash: undefined }, { ...baseline, datasetHash: undefined }).datasetComparable, false);
});

test('scorer-version changes cannot masquerade as production improvements', () => {
  const baseline = report([row('a', { 'experiment.unitAccuracy': 0 })]);
  const candidate = report([row('a', { 'experiment.unitAccuracy': 1 })]);
  baseline.summary.scoreVersion = '1.0.0'; candidate.summary.scoreVersion = '1.0.1';
  const changed = compareReports(baseline, candidate);
  assert.equal(changed.scoreVersionComparable, false); assert.equal(changed.comparablePairs, 0); assert.equal(changed.regressionRate, null);
  assert.deepEqual(changed.pairedMetricDeltas, {}); assert.equal(changed.incomparable[0].reason, 'score_version_missing_or_changed'); assert.equal(changed.passed, false);
  assert.equal(compareReports({ ...baseline, summary: {} }, { ...candidate, summary: {} }).scoreVersionComparable, false);
  assert.equal(compareReports(baseline, baseline).scoreVersionComparable, true, 'matching archived scorer versions remain comparable');
});

test('gate regressions are explicit even when other metrics improve', () => {
  const baseline = report([row('a', { recall: 0 }, { checks: [{ type: 'privacy', required: true, status: 'pass' }] })]);
  const candidate = report([row('a', { recall: 1 }, { checks: [{ type: 'privacy', required: true, status: 'fail' }] })]);
  const result = compareReports(baseline, candidate);
  assert.equal(result.regressions[0].type, 'hard_gate'); assert.equal(result.candidateHardFailures.length, 1); assert.equal(result.passed, false);
});

test('operational comparisons pair known values instead of comparing incompatible aggregate populations', () => {
  const baseline = report([row('a', { recall: 1 }, { latencyMs: 10, cacheState: 'cold', cost: { generation: 0 } }), row('b', { recall: 1 }, { latencyMs: 1000, cacheState: 'cold' })]);
  const candidate = report([row('a', { recall: 1 }, { latencyMs: 20, cacheState: 'cold', cost: { generation: .1 } }), row('b', {}, { valid: false, latencyMs: null })]);
  const result = compareReports(baseline, candidate);
  assert.equal(result.operationalRegressions.find(x => x.metric === 'p50Ms').baseline, 10);
  assert.equal(result.operationalRegressions.find(x => x.type === 'cost').baseline, 0);
  assert.ok(result.regressions.some(x => x.metric === 'latency.coldMs'));
});

test('duplicate case/repeat keys fail rather than silently overwrite', () => {
  assert.throws(() => compareReports(report([row('a', {}), row('a', {})]), report([])), /Duplicate/);
});

test('blinded pairwise packets are reproducible, separate identities, and never generate judgments', () => {
  const baseline = report([row('a', {}, { answer: 'Old answer', query: 'Question?' })]); const candidate = report([row('a', {}, { answer: 'New answer', query: 'Question?' })]);
  const a = createBlindPackets(baseline, candidate, { seed: 7 }); const b = createBlindPackets(baseline, candidate, { seed: 7 });
  assert.deepEqual(a, b); assert.equal(a.packets.length, 1); assert.equal(a.packets[0].judgment, null); assert.equal(a.packets[0].caseId, undefined);
  const mapping = a.orderMapping[0]; assert.equal(a.packets[0].answers.A, mapping.A === 'baseline' ? 'Old answer' : 'New answer');
  assert.equal(createBlindPackets(baseline, { ...candidate, datasetHash: 'different' }).packets.length, 0);
});

test('comparator CLI preserves immutable baseline and refuses existing output files', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'eval-comparator-'));
  try {
    const baseline = join(directory, 'baseline.json'); const candidate = join(directory, 'candidate.json'); const out = join(directory, 'comparison.json');
    const data = `${JSON.stringify(report([row('a', { recall: 1 })]))}\n`;
    await Promise.all([writeFile(baseline, data), writeFile(candidate, data)]);
    const cli = fileURLToPath(new URL('../compare.mjs', import.meta.url));
    const good = spawnSync(process.execPath, [cli, '--baseline', baseline, '--candidate', candidate, '--out', out], { encoding: 'utf8' });
    assert.equal(good.status, 0, good.stderr); assert.equal((JSON.parse(await readFile(out, 'utf8'))).passed, true);
    assert.equal(await readFile(baseline, 'utf8'), data);
    const bad = spawnSync(process.execPath, [cli, '--baseline', baseline, '--candidate', candidate, '--out', baseline], { encoding: 'utf8' });
    assert.equal(bad.status, 2); assert.match(bad.stderr, /immutable/);
    const exists = spawnSync(process.execPath, [cli, '--baseline', baseline, '--candidate', candidate, '--out', out], { encoding: 'utf8' });
    assert.equal(exists.status, 2); assert.equal(await readFile(baseline, 'utf8'), data);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
