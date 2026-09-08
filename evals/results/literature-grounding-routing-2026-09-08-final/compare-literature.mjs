#!/usr/bin/env node
// Evaluation-only analysis. This file never changes frozen cases or production code.
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { gzipSync, gunzipSync } from 'node:zlib';
import { dirname, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SCORE_VERSION, retrievalMetrics, bootstrapMean, jaccard, quantile, compareReports } from '../../lib/scoring.mjs';

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const repository = resolve(scriptDirectory, '../../..');
const argv = Object.fromEntries(process.argv.slice(2).filter(arg => arg.startsWith('--')).map(arg => {
  const position = process.argv.indexOf(arg); return [arg.slice(2), process.argv[position + 1]];
}));
const output = resolve(argv.out || scriptDirectory);
const baselinePath = resolve(argv.baseline || '/tmp/literature-routing-baseline/baseline.json');
const candidatePath = argv.candidate ? resolve(argv.candidate) : null;
const selectionPath = resolve(argv.selection || resolve(scriptDirectory, '../literature-grounding-routing-2026-09-08/selection.json'));
const options = { seed: 20260907, bootstrapSamples: 2000 };
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const finite = value => typeof value === 'number' && Number.isFinite(value);
const key = row => `${row.caseId}:${row.repeat ?? 0}`;
const count = values => values.reduce((result, value) => { result[value] = (result[value] || 0) + 1; return result; }, {});
const categories = new Set(['lookup', 'discovery', 'retrieval', 'search', 'semantic_retrieval']);
const readBytes = async path => { const bytes = await readFile(path); return path.endsWith('.gz') ? gunzipSync(bytes) : bytes; };
async function runIntegrity(reportPath) {
  try {
    const value = JSON.parse(await readFile(resolve(dirname(reportPath), 'production-integrity.json'), 'utf8'));
    if (value.unchanged !== true || value.before !== value.after || value.changedFiles?.length) throw new Error('Production changed during an evaluated run.');
    return value;
  } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}
const json = value => `${JSON.stringify(value, null, 2)}\n`;
async function immutable(name, bytes) {
  const path = resolve(output, name);
  try { await writeFile(path, bytes, { flag: 'wx' }); }
  catch (error) {
    if (error.code !== 'EEXIST' || digest(await readFile(path)) !== digest(bytes)) throw new Error(`Refusing to replace immutable artifact: ${path}`);
  }
}
function aggregate(rows) {
  const metrics = [...new Set(rows.flatMap(row => Object.keys(row.metrics)))];
  return { observations: rows.length, independentCases: new Set(rows.map(row => row.caseId)).size,
    metrics: Object.fromEntries(metrics.map(metric => [metric, bootstrapMean(rows.map(row => ({ cluster: row.caseId, value: row.metrics[metric] })), options)])) };
}
function pairedMetrics(before, after, cluster = 'caseId') {
  const index = new Map(after.map(row => [key(row), row]));
  const differences = [];
  const pairedBaseline = [], pairedCandidate = [], missingCandidateMetrics = [], missingBaselineMetrics = [];
  const regressions = [];
  for (const left of before) {
    const right = index.get(key(left)); if (!right) continue;
    const values = {}, baselineValues = {}, candidateValues = {};
    for (const metric of new Set([...Object.keys(left.metrics), ...Object.keys(right.metrics)])) {
      const a = left.metrics[metric], b = right.metrics[metric];
      if (finite(a) && finite(b)) {
        baselineValues[metric] = a; candidateValues[metric] = b; values[metric] = b - a;
        if (values[metric] < 0 && !metric.includes('AbsoluteGap')) regressions.push({ caseId: left.caseId, repeat: left.repeat, metric, baseline: a, candidate: b, delta: values[metric] });
      } else if (finite(a)) missingCandidateMetrics.push({ caseId: left.caseId, repeat: left.repeat, metric, baseline: a });
      else if (finite(b)) missingBaselineMetrics.push({ caseId: left.caseId, repeat: left.repeat, metric, candidate: b });
    }
    differences.push({ caseId: left[cluster], metrics: values });
    pairedBaseline.push({ caseId: left[cluster], metrics: baselineValues });
    pairedCandidate.push({ caseId: left[cluster], metrics: candidateValues });
  }
  return { ...aggregate(differences), baseline: aggregate(pairedBaseline), candidate: aggregate(pairedCandidate),
    regressions, missingCandidateMetrics, missingBaselineMetrics,
    interpretation: 'Each metric uses only observations measurable on both sides. Baseline/candidate means, delta, and interval share exactly the same per-metric observations and clusters. Newly unmeasurable metrics remain explicit coverage limitations.' };
}

await mkdir(output, { recursive: true });
const [baselineBytes, selectionBytes, fixtureBytes, oldAuditBytes, scorerBytes, frozenCaseBytes] = await Promise.all([
  readBytes(baselinePath), readFile(selectionPath),
  readFile(resolve(repository, 'evals/biodesign-eval-v1/fixtures/project.json')),
  readFile(resolve(repository, 'evals/results/baseline-2026-09-07/ranked-retrieval-audit.json')),
  readFile(resolve(repository, 'evals/lib/scoring.mjs')),
  readFile(resolve(repository, 'evals/biodesign-eval-v1/cases.jsonl')),
]);
const selection = JSON.parse(selectionBytes);
const baseline = JSON.parse(baselineBytes);
const fixture = JSON.parse(fixtureBytes);
const oldAudit = JSON.parse(oldAuditBytes);
const sources = new Map(fixture.sources.map(source => [source.id, source]));
function validate(report) {
  if (report.summary.scoreVersion !== SCORE_VERSION) throw new Error('Scorer version differs. Rescore immutable observations under one version first.');
  if (report.config.evaluationHarnessHashes['evals/lib/scoring.mjs'] !== digest(scorerBytes)) throw new Error('Scorer source hash differs from captured run.');
  if (report.config.suiteManifest.files['fixtures/project.json'].sha256 !== digest(fixtureBytes)) throw new Error('Frozen fixture manifest mismatch.');
  if (report.config.suiteManifest.files['cases.jsonl'].sha256 !== digest(frozenCaseBytes)) throw new Error('Frozen case/gold file manifest mismatch.');
  const actualIds = report.testCases.map(row => row.id).sort();
  if (JSON.stringify(actualIds) !== JSON.stringify([...selection.ids].sort())) throw new Error('Run differs from preselected literature cases.');
}
validate(baseline);
function scoreRun(report) {
  const cases = new Map(report.testCases.map(row => [row.id, row]));
  const eligible = [], departures = [];
  for (const observation of report.observations) {
    const testCase = cases.get(observation.caseId);
    const declared = testCase.categories || [];
    if (declared.includes('corpus') || !declared.some(category => categories.has(category))) continue;
    if (observation.status !== 'completed' || observation.actual?.corpus?.workflowId) {
      departures.push({ caseId: observation.caseId, repeat: observation.repeat, status: observation.status,
        reason: observation.actual?.corpus?.workflowId ? 'actual_corpus_workflow' : 'incomplete_observation' });
      continue;
    }
    const retrieval = observation.actual?.retrieval || {};
    const raw = Array.isArray(retrieval.results) ? retrieval.results : null;
    const aliases = observation.provenance?.sourceIdentityAliases || {};
    const paperIds = raw?.map(hit => aliases[hit.paperId || hit.sourceId] || hit.paperId || hit.sourceId || null);
    const pageIds = raw?.map((hit, rank) => {
      const source = sources.get(paperIds[rank]);
      if (!source || !Number.isInteger(hit.page) ||
          (hit.verifiedFixtureVersion != null && String(hit.verifiedFixtureVersion) !== String(source.version))) return null;
      return source.pages?.find(page => page.page === hit.page)?.evidenceId || null;
    });
    const inputs = {
      'ranked.paper': paperIds?.every(Boolean) ? paperIds : null,
      'ranked.evidence': pageIds?.every(Boolean) ? pageIds : null,
      'context.paper': retrieval.paperIds,
      'context.evidence': retrieval.evidenceIds,
    };
    const metrics = {};
    for (const [prefix, ids] of Object.entries(inputs)) {
      const gold = testCase.gold?.[prefix.endsWith('paper') ? 'paperIds' : 'evidenceIds'];
      for (const [metric, value] of Object.entries(retrievalMetrics(ids, gold))) metrics[`${prefix}.${metric}`] = value;
    }
    eligible.push({ caseId: observation.caseId, repeat: observation.repeat, cacheState: observation.cacheState,
      split: testCase.split, domain: testCase.domain, language: testCase.language, pairId: testCase.pairId,
      metrics, rankedPaperIds: paperIds, rankedPageEvidenceIds: pageIds,
      contextPaperIds: retrieval.paperIds, contextEvidenceIds: retrieval.evidenceIds,
      rawResultCount: raw?.length ?? null, unmappablePages: pageIds?.filter(value => !value).length ?? null,
      emptyPaperGold: !testCase.gold?.paperIds?.length, emptyEvidenceGold: !testCase.gold?.evidenceIds?.length,
      searchCalls: observation.trace.filter(item => item.entrypoint === 'LiteratureTools.searchPapers').length,
      backendCounts: count((raw || []).map(hit => hit.retrievalBackend || 'unknown')),
    });
  }
  const grouping = field => Object.fromEntries([...new Set(eligible.map(row => row[field]))].map(value => [value, aggregate(eligible.filter(row => row[field] === value))]));
  return { runId: report.runId, datasetHash: report.datasetHash, scoreVersion: SCORE_VERSION,
    totalCases: report.testCases.length, totalObservations: report.observations.length,
    statuses: count(report.observations.map(row => row.status)),
    eligible: aggregate(eligible), observedSearchCallsOnly: aggregate(eligible.filter(row => row.searchCalls > 0)),
    bySplit: grouping('split'), byDomain: grouping('domain'), byLanguage: grouping('language'),
    departures, maximumSavedRankDepth: Math.max(0, ...eligible.map(row => row.rawResultCount || 0)),
    rawHitsWithUnknownPages: eligible.reduce((sum, row) => sum + (row.unmappablePages || 0), 0),
    emptyPaperGoldObservations: eligible.filter(row => row.emptyPaperGold).length,
    emptyEvidenceGoldObservations: eligible.filter(row => row.emptyEvidenceGold).length,
    perObservation: eligible,
  };
}
function bilingual(rows) {
  const groups = new Map();
  for (const row of rows.filter(row => row.pairId)) {
    const id = `${row.pairId}:${row.repeat}`;
    groups.set(id, [...(groups.get(id) || []), row]);
  }
  const pairs = [];
  for (const members of groups.values()) {
    const en = members.filter(row => /^en\b/.test(row.language));
    const zh = members.filter(row => /^zh\b/.test(row.language));
    if (en.length !== 1 || zh.length !== 1) continue;
    const metrics = {};
    for (const prefix of ['ranked.paper', 'ranked.evidence', 'context.paper', 'context.evidence']) {
      const a = en[0].metrics[`${prefix}.recall5`], b = zh[0].metrics[`${prefix}.recall5`];
      if (finite(a) && finite(b)) Object.assign(metrics, {
        [`${prefix}.recall5En`]: a, [`${prefix}.recall5Zh`]: b,
        [`${prefix}.recall5EnMinusZh`]: a - b, [`${prefix}.recall5AbsoluteGap`]: Math.abs(a - b),
      });
    }
    metrics['ranked.paper.top5Jaccard'] = jaccard(en[0].rankedPaperIds?.slice(0, 5), zh[0].rankedPaperIds?.slice(0, 5));
    metrics['context.paper.top5Jaccard'] = jaccard(en[0].contextPaperIds?.slice(0, 5), zh[0].contextPaperIds?.slice(0, 5));
    pairs.push({ caseId: en[0].pairId, pairId: en[0].pairId, repeat: en[0].repeat, metrics });
  }
  return { ...aggregate(pairs), pairs };
}
function operations(report) {
  const observations = report.observations;
  const corpusCaseIds = new Set(report.testCases.filter(row => row.categories?.includes('corpus')).map(row => row.id));
  const declaredCorpus = observations.filter(row => corpusCaseIds.has(row.caseId));
  const roles = ['semantic_parser', 'search_planner', 'reranker', 'corpus_mapper', 'native_pdf', 'combined_text_paper_card', 'answer'];
  const cloud = observations.map(row => row.actual?.semantic?.telemetry?.cloudCalls);
  const corpus = observations.filter(row => row.actual?.corpus?.workflowId).map(row => {
    const data = row.actual.corpus, coverage = data.coverage || {};
    const snapshotCount = coverage.papersIncludedInSnapshot ?? data.papersTotal ?? null;
    const analyzedCount = coverage.papersSuccessfullyAnalyzed ?? data.papersAnalyzed ?? null;
    return { caseId: row.caseId, repeat: row.repeat, cacheState: row.cacheState, status: data.status,
      observationStatus: row.status,
      snapshotCount, analyzedCount, coverageComplete: finite(snapshotCount) && finite(analyzedCount) ? snapshotCount === analyzedCount : null,
      mapsCreated: row.provenance?.counters?.maps ?? null,
    };
  });
  const backend = count(observations.flatMap(row => (row.actual?.retrieval?.results || []).map(hit => hit.retrievalBackend || 'unknown')));
  const fallback = count(observations.map(row => {
    const tool = row.actual?.rawToolObservations?.filter(item => item.entrypoint === 'LiteratureTools.searchPapers').at(-1)?.result;
    return tool?.diagnostics?.fallbackReason || tool?.retrievalDecision?.fallbackReason || 'not_recorded';
  }));
  const qmdEvidence = observations.filter(row => row.actual?.retrieval?.results?.some(hit => hit.retrievalBackend === 'legacy'));
  return { latency: Object.fromEntries(['cold', 'warm'].map(state => {
    const values = observations.filter(row => row.cacheState === state && row.status === 'completed').map(row => row.timing?.latencyMs).filter(finite);
    return [state, { observations: values.length, p50Ms: quantile(values, .5), p95Ms: quantile(values, .95) }];
  })),
    logicalCloudCalls: Object.fromEntries(roles.map(role => [role, { calls: cloud.some(row => finite(row?.[role])) ? cloud.reduce((sum, row) => sum + (row?.[role] || 0), 0) : null, observationsWithCounter: cloud.filter(row => finite(row?.[role])).length }])),
    controlledLocalCounters: Object.fromEntries(['qmdSearches', 'qmdUpdates', 'cards', 'maps', 'nativePdf'].map(role => [role, observations.reduce((sum, row) => sum + (row.provenance?.counters?.[role] || 0), 0)])),
    providerMode: [...new Set(observations.map(row => row.provenance?.providerMode))],
    semanticRoutes: count(observations.map(row => row.actual?.semantic?.telemetry?.semantic?.route || 'not_recorded')),
    backendCounts: backend, recordedFallbackReasons: fallback,
    legacyRuntimeEvidence: { observations: qmdEvidence.length,
      qmdAvailable: qmdEvidence.filter(row => row.provenance?.qmdAvailable).length,
      onlyEmptyQmdTraces: qmdEvidence.filter(row => { const traces = row.trace.filter(item => item.entrypoint === 'ProjectQmdManager.search'); return traces.length && traces.every(item => !item.resultIds.length); }).length },
    corpus: { observations: corpus.length, complete: corpus.filter(row => row.coverageComplete === true).length,
      incomplete: corpus.filter(row => row.coverageComplete === false).length,
      observationStatuses: count(corpus.map(row => row.observationStatus)),
      workflowStatuses: count(corpus.map(row => row.status)),
      completedObservationsWithFullCoverage: corpus.filter(row => row.coverageComplete === true && row.observationStatus === 'completed').length,
      declaredRequests: { observations: declaredCorpus.length,
        statuses: count(declaredCorpus.map(row => row.status)),
        withWorkflow: declaredCorpus.filter(row => row.actual?.corpus?.workflowId).length,
        withoutWorkflow: declaredCorpus.filter(row => !row.actual?.corpus?.workflowId).length },
      blockedOrFailed: observations.filter(row => (corpusCaseIds.has(row.caseId) || row.actual?.corpus?.workflowId) && row.status !== 'completed')
        .map(row => ({ caseId: row.caseId, repeat: row.repeat, status: row.status, errors: row.errors, limitations: row.limitations })),
      meanCoverage: bootstrapMean(corpus.map(row => ({ cluster: row.caseId, value: row.snapshotCount ? row.analyzedCount / row.snapshotCount : null })), options), perObservation: corpus },
    liveProviderCalls: null, citationResolutionRate: null, pdfPageLocalizationCoverage: null,
    unsupportedClaimRate: null, contradictedClaimRate: null, liveJudgeScore: null,
    unavailableReason: 'Controlled local provider lane records retrieval/context/tool behavior, not generated live answers or paid provider execution. Citation and claim rates require live answer audits; controlled card/map counters are not provider calls.',
  };
}
function requestDiagnostics(report) {
  const rows = report.observations.map(row => ({ caseId: row.caseId, repeat: row.repeat,
    value: row.actual?.context?.literature?.diagnostics })).filter(row => row.value);
  return { observationsWithDiagnostics: rows.length,
    parser: Object.fromEntries(['attempted', 'succeeded', 'fallback'].map(field => [field, rows.filter(row => row.value.parser?.[field] === true).length])),
    targetedEvidenceCompletionCalls: rows.reduce((sum, row) => sum + (row.value.targetedEvidenceCompletionCalls || 0), 0),
    canonicalEnglishAvailable: rows.filter(row => row.value.canonicalEnglishAvailable === true).length,
    fallbackReasons: count(rows.map(row => row.value.fallbackReason || 'none')),
    resolvedContextEvidenceHandles: rows.reduce((sum, row) => sum + (row.value.citationResolution?.resolved || 0), 0),
    localizedContextPages: rows.reduce((sum, row) => sum + (row.value.evidencePages || []).length, 0),
    interpretation: 'Host context diagnostics, not emitted final-answer citations or independently audited claim support. Missing baseline diagnostics are unavailable, not zero.',
    perObservation: rows,
  };
}
const baselineAudit = scoreRun(baseline);
const baselineArchivePath = resolve(argv['baseline-archive'] || resolve(scriptDirectory, '../literature-grounding-routing-2026-09-08/baseline.json.gz'));
if (digest(gunzipSync(await readFile(baselineArchivePath))) !== digest(baselineBytes)) throw new Error('Shared immutable baseline archive does not match input baseline.');
await immutable('baseline-archive-reference.json', json({ path: relative(output, baselineArchivePath), originalSha256: digest(baselineBytes) }));
await immutable('baseline-archive.json', json({ runId: baseline.runId, gitCommit: baseline.config.gitCommit,
  originalBytes: baselineBytes.length, originalSha256: digest(baselineBytes),
  compressedSha256: digest(gzipSync(baselineBytes)), scorerVersion: SCORE_VERSION, scorerSha256: digest(scorerBytes),
  datasetHash: baseline.datasetHash, fixtureSha256: digest(fixtureBytes), selectionSha256: digest(selectionBytes) }));
await immutable('selection.json', selectionBytes);
await immutable('baseline-audit.json', json(baselineAudit));
await immutable('baseline-operations.json', json(operations(baseline)));
if (!candidatePath) {
  console.log(json({ baselineArchived: true, baselineSha256: digest(baselineBytes), eligible: baselineAudit.eligible, candidate: 'not supplied' }));
} else {
  const candidateBytes = await readBytes(candidatePath), candidate = JSON.parse(candidateBytes);
  validate(candidate);
  if (candidate.datasetHash !== baseline.datasetHash || JSON.stringify(candidate.testCases) !== JSON.stringify(baseline.testCases)) throw new Error('Candidate dataset or selected frozen cases changed.');
  const candidateAudit = scoreRun(candidate);
  const productionIntegrity = { baseline: await runIntegrity(baselinePath), candidate: await runIntegrity(candidatePath) };
  const beforeKeys = new Set(baselineAudit.perObservation.map(key)), afterKeys = new Set(candidateAudit.perObservation.map(key));
  const before = baselineAudit.perObservation.filter(row => afterKeys.has(key(row)));
  const after = candidateAudit.perObservation.filter(row => beforeKeys.has(key(row)));
  const baselineBilingual = bilingual(before), candidateBilingual = bilingual(after);
  const comparison = {
    scoreVersion: SCORE_VERSION, scorerSha256: digest(scorerBytes), datasetHash: baseline.datasetHash,
    baselineSha256: digest(baselineBytes), candidateSha256: digest(candidateBytes),
    baselineRevision: baseline.config.gitCommit, candidateRevision: candidate.config.gitCommit,
    candidateWorkingTreeHash: candidate.config.productionTreeHash,
    productionIntegrity,
    selection: { reason: selection.reason, cases: selection.ids.length, dev: selection.dev, heldout: selection.heldout },
    methods: { ...oldAudit.methods,
      cohortPairing: 'Apply frozen eligibility rule independently, then compare only common case/cache observations. Per-run totals and corpus departures remain separately visible.',
      sourceVersionLimit: 'Page aliases come from manifest-verified frozen project fixture. Raw hit hash/version availability is not inferred from registry state.',
      uncertainty: 'Existing SCORE_VERSION 1.0.1 bootstrapMean, fixed seed 20260907, 2000 percentile case-cluster samples. Cold/warm share case clusters; EN/ZH comparisons share pair clusters.',
    },
    baseline: baselineAudit.eligible, candidate: candidateAudit.eligible,
    commonCohort: { baseline: aggregate(before), candidate: aggregate(after), delta: pairedMetrics(before, after) },
    perRunOnly: { baseline: baselineAudit.perObservation.filter(row => !afterKeys.has(key(row))).map(key), candidate: candidateAudit.perObservation.filter(row => !beforeKeys.has(key(row))).map(key) },
    bySplit: Object.fromEntries(['dev', 'heldout'].map(split => [split, { baseline: aggregate(before.filter(row => row.split === split)), candidate: aggregate(after.filter(row => row.split === split)), delta: pairedMetrics(before.filter(row => row.split === split), after.filter(row => row.split === split)) }])),
    bilingual: { baseline: baselineBilingual, candidate: candidateBilingual, delta: pairedMetrics(baselineBilingual.pairs, candidateBilingual.pairs) },
    operations: { baseline: operations(baseline), candidate: operations(candidate) },
    requestDiagnostics: { baseline: requestDiagnostics(baseline), candidate: requestDiagnostics(candidate) },
    limitations: [
      'The preselected 45-case literature subset contains 35 development and 10 held-out cases, each cold and warm; the raw ranked subset is smaller by the unchanged eligibility rule.',
      'Small synthetic fixtures and dependent cold/warm observations do not establish broad reliability. Intervals including zero are inconclusive for improvement.',
      'Do not compare this local lane as a candidate against the old live-provider lane. The fresh paired baseline includes the earlier committed race and evidence-order fixes.',
      'Context evidence Recall@5 is emitted-evidence prefix coverage. It is not raw search Recall@5 or final answer correctness.',
      'Latency is a single local cold/warm execution per case, with filesystem and scheduler noise; no live latency or pricing conclusion follows.',
    ],
  };
  const originalComparison = compareReports(baseline, candidate, options);
  await immutable('candidate.json.gz', gzipSync(candidateBytes));
  if (productionIntegrity.candidate) await immutable('production-integrity.json', json(productionIntegrity.candidate));
  await immutable('candidate-audit.json', json(candidateAudit));
  await immutable('candidate-operations.json', json(comparison.operations.candidate));
  await immutable('comparison.json', json(comparison));
  await immutable('existing-scorer-comparison.json', json(originalComparison));
  const fmt = value => finite(value) ? value.toFixed(3) : 'unmeasured';
  const metricRows = ['ranked.paper.recall5', 'ranked.evidence.recall5', 'ranked.paper.mrr', 'ranked.evidence.mrr', 'context.paper.recall5', 'context.evidence.recall5'].map(metric => {
    const delta = comparison.commonCohort.delta.metrics[metric];
    return `| ${metric} | ${fmt(comparison.commonCohort.delta.baseline.metrics[metric]?.mean)} | ${fmt(comparison.commonCohort.delta.candidate.metrics[metric]?.mean)} | ${fmt(delta?.mean)} | ${delta?.ci95?.map(fmt).join(' to ') || 'unmeasured'} | ${delta?.n || 0} / ${delta?.clusters || 0} |`;
  });
  const languageRows = ['ranked.paper.recall5En', 'ranked.paper.recall5Zh', 'ranked.paper.top5Jaccard'].map(metric => `| ${metric} | ${fmt(baselineBilingual.metrics[metric]?.mean)} | ${fmt(candidateBilingual.metrics[metric]?.mean)} |`);
  const latencyRows = ['cold', 'warm'].map(state => `| ${state} p50 / p95 (ms) | ${fmt(comparison.operations.baseline.latency[state].p50Ms)} / ${fmt(comparison.operations.baseline.latency[state].p95Ms)} | ${fmt(comparison.operations.candidate.latency[state].p50Ms)} / ${fmt(comparison.operations.candidate.latency[state].p95Ms)} |`);
  const missingCandidate = comparison.commonCohort.delta.missingCandidateMetrics;
  const missingCases = [...new Set(missingCandidate.map(row => row.caseId))];
  const latencyRegressions = originalComparison.regressions.filter(row => row.metric?.startsWith('latency.'));
  const nonLatencyRegressions = originalComparison.regressions.filter(row => !row.metric?.startsWith('latency.'));
  const bilingualRegressionText = originalComparison.bilingualRegressions.length
    ? `The existing scorer also flags **${originalComparison.bilingualRegressions.length} bilingual metric regressions**: ${originalComparison.bilingualRegressions.map(row => `\`${row.pairId}\` repeat ${row.repeat}: \`${row.metric}\` ${fmt(row.baseline)} → ${fmt(row.candidate)}`).join('; ')}. These measure cross-language overlap of the emitted context evidence prefix, separately from paper recall or supporting-evidence recall; they remain recorded as regressions.`
    : 'The existing scorer flags no bilingual metric regressions.';
  const evaluationLimit = `Missing raw-metric coverage is tracked separately from observed numeric regressions: ${missingCandidate.length} previously measurable raw/context metric entries across ${missingCases.length} cases became unmeasurable. ${missingCases.length ? `Affected cases: ${missingCases.map(id => `\`${id}\``).join(', ')}. Unlocalized metadata-only ranked hits make page metrics unknown under the original strict audit rule; known page-backed hits and selected context remain recorded.` : ''}`;
  await immutable('REPORT.md', `# Literature grounding and routing: paired local evaluation\n\n` +
    `Fresh baseline commit \`${baseline.config.gitCommit.slice(0, 12)}\`, candidate branch \`${candidate.config.branch}\`. Both use scorer **${SCORE_VERSION}** and the same frozen fixture, case selection, and application execution lane. Raw snapshots are compressed and hash identified in [comparison.json](comparison.json).\n\n` +
    `There are ${selection.ids.length} preselected literature cases (${selection.dev} dev, ${selection.heldout} held-out), run cold and warm. The common raw-ranked cohort contains ${before.length} observations in ${new Set(before.map(row => row.caseId)).size} case clusters. Original eligibility rules exclude corpus declarations and actual corpus workflows. Per-run cohorts and departures remain in the audit files.\n\n` +
    `| Metric on matched evaluable observations | Baseline | Candidate | Paired delta | 95% case-cluster interval | Observations / case clusters |\n|---|---:|---:|---:|---|---:|\n${metricRows.join('\n')}\n\n` +
    `Each row uses its own identical, jointly measurable observations for both means and the paired delta; empty frozen relevant sets and unknown page identities are excluded explicitly. Baseline/candidate marginal means over all separately measurable observations remain in comparison.json and must not be subtracted across different denominators. Confidence intervals that include zero do not establish improvement. Context evidence metrics measure emitted-evidence prefix coverage, independently from saved search ranks.\n\n${evaluationLimit}\n\n` +
    `| Matched EN/ZH metric | Baseline | Candidate |\n|---|---:|---:|\n${languageRows.join('\n')}\n\n` +
    `The bilingual analysis has ${baselineBilingual.independentCases} independent pair clusters; cold/warm repeats remain clustered. Top-five overlap is set Jaccard. Full paired intervals, dev/held-out breakdowns, and observed regressions are in [comparison.json](comparison.json).\n\n${bilingualRegressionText}\n\n` +
    `| Local latency | Baseline | Candidate |\n|---|---:|---:|\n${latencyRows.join('\n')}\n\n` +
    `Observed workflow records with full snapshot coverage: **${comparison.operations.baseline.corpus.complete}/${comparison.operations.baseline.corpus.observations} → ${comparison.operations.candidate.corpus.complete}/${comparison.operations.candidate.corpus.observations}**. Completed request observations with full workflow coverage: **${comparison.operations.baseline.corpus.completedObservationsWithFullCoverage} → ${comparison.operations.candidate.corpus.completedObservationsWithFullCoverage}**. Individual snapshot/analyzed counts and controlled map creation counts are in the operations files. A stored workflow can cover all papers while its overall evaluation observation is blocked.\n\n` +
    `Declared corpus-category requests: **${comparison.operations.baseline.corpus.declaredRequests.observations} → ${comparison.operations.candidate.corpus.declaredRequests.observations}**; request statuses **${JSON.stringify(comparison.operations.baseline.corpus.declaredRequests.statuses)} → ${JSON.stringify(comparison.operations.candidate.corpus.declaredRequests.statuses)}**; requests with an observed workflow **${comparison.operations.baseline.corpus.declaredRequests.withWorkflow} → ${comparison.operations.candidate.corpus.declaredRequests.withWorkflow}**. Missing workflow invocations and failed/blocked observations are retained separately; these are not counted as full corpus successes. Coverage does not establish factual answer completeness. See the operations files for failure-injection limitations.\n\n` +
    `Provider role counters, retrieval backend distributions, and fallback reasons are recorded separately in [baseline-operations.json](baseline-operations.json) and [candidate-operations.json](candidate-operations.json). Controlled card/map generation counters are not paid provider calls.\n\n` +
    `Live citation resolution, PDF citation page-localization coverage, unsupported/contradicted claim rates, live judge scores, and real provider calls are **unmeasured (null)** because this lane does not generate live answers. Unit regressions can validate citation mechanics but cannot supply those live metrics.\n\n` +
    `The unchanged compareReports result is preserved in [existing-scorer-comparison.json](existing-scorer-comparison.json). Its \`passed\` value is **${originalComparison.passed}**. Of its ${originalComparison.regressions.length} individual regressions, **${latencyRegressions.length} are latency increases and ${nonLatencyRegressions.length} are non-latency metric/check/coverage regressions**. It also reports ${originalComparison.operationalRegressions.length} aggregate operational regressions, ${originalComparison.candidateHardFailures.length} candidate hard failures, and ${originalComparison.candidateUnknownHardChecks.length} unknown hard checks. Every operational regression is retained in the JSON; a single noisy latency run is neither dismissed nor treated as a reliable performance estimate. Unknown checks remain unknown. The custom raw-ranked audit additionally exposes the missing page-metric coverage described above, which the existing context scorer does not measure. This result is not a broad release certification.\n\n` +
    `Reproduce: \`node evals/results/literature-grounding-routing-2026-09-08-final/compare-literature.mjs --baseline PATH --candidate PATH --selection PATH\`. Outputs are write-once; supplying different input snapshots requires a new result directory. Frozen expected answers were not edited.\n`);
  console.log(json({ comparison: resolve(output, 'comparison.json'), report: resolve(output, 'REPORT.md'), commonCohort: comparison.commonCohort, corpus: { baseline: comparison.operations.baseline.corpus.complete, candidate: comparison.operations.candidate.corpus.complete } }));
}
