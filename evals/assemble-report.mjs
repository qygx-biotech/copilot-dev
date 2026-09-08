#!/usr/bin/env node
// Assemble separately scored lanes without blending their denominators.
import fs from 'node:fs/promises';
import path from 'node:path';
import { captureMetadata, sha256, verifyFrozenSuite } from './lib/reproducibility.mjs';
const opts = {};
for (let i = 2; i < process.argv.length; i += 2) opts[process.argv[i].replace(/^--/, '')] = process.argv[i + 1];
if (!opts.local || !opts.live || !opts.output) throw new Error('Usage: node evals/assemble-report.mjs --local LOCAL_RESULT_DIR --live LIVE_RESULT_DIR --output NEW_RESULT_DIR');
const local = path.resolve(opts.local), live = path.resolve(opts.live), out = path.resolve(opts.output);
const read = async (dir, name) => JSON.parse(await fs.readFile(path.join(dir, name), 'utf8'));
const [lb, ub, ranked, judges, grounding, telemetry, citations, adversarial, ladversarial, gates, meta, suite] = await Promise.all([
  read(local, 'baseline.json'), read(live, 'baseline.json'), read(local, 'ranked-retrieval-audit.json'),
  read(live, 'judge-scores.json'), read(live, 'grounding-scores-v1.0.1.json'), read(live, 'telemetry-complete.json'),
  read(live, 'citation-audit.json'), read(live, 'live-adversarial-complete.json'), read(local, 'adversarial-findings.json'),
  read('evals', 'release-gates.json'), captureMetadata(process.cwd()), verifyFrozenSuite('evals/biodesign-eval-v1'),
]);
if (lb.datasetHash !== ub.datasetHash || lb.datasetHash !== suite.hash) throw new Error('Dataset identity mismatch');
for (const dir of [local, live]) {
  const raw = await fs.readFile(path.join(dir, 'baseline.json'));
  if (sha256(raw) !== (await fs.readFile(path.join(dir, 'baseline.sha256'), 'utf8')).trim()) throw new Error('Baseline hash mismatch');
}
const source = async (dir, file) => ({ path: path.join(dir, file), sha256: sha256(await fs.readFile(path.join(dir, file))) });
const provenance = await Promise.all([[local, 'baseline.json'], [live, 'baseline.json'], [local, 'ranked-retrieval-audit.json'], [live, 'judge-scores.json'], [live, 'grounding-scores-v1.0.1.json'], [live, 'telemetry-complete.json']].map(([d, f]) => source(d, f)));
const config = { ...meta, suiteVersion: 'biodesign-eval-v1', datasetHash: suite.hash, sourceArtifacts: provenance, productionUnchanged: meta.productionTreeHash === lb.config.productionTreeHash, evaluationOnly: true, scientificFixtures: 'Synthetic, not production scientific evidence' };
const cost = { live: { observedFcRequests: telemetry.combinedClientRequests.totalStarts, auxiliary: telemetry.backendRequests.started, auxiliaryFailures: telemetry.backendRequests.failed, finalChatRequests: telemetry.mainChatRequests.started, byRoleEndpoint: telemetry.backendRequests.byRoleEndpoint, savedLogicalCounts: telemetry.savedTelemetryTotals.roles, ...telemetry.tokensAndCost }, localControlled: { actualFcRequests: 0, actualRequestyCalls: 0, actualProviderTokens: 0, limitation: 'No live provider in this lane; local callback work is not billed model usage.' }, provenance: path.join(live, 'telemetry-complete.json') };
const before = await read(live, 'state-before-answer.json'), after = await read(live, 'state-after-all.json');
const permissions = { releaseEligible: false, experimentArithmeticGate: 'failed', recommendationUnchanged: JSON.stringify(before.agent.currentRecommendation) === JSON.stringify(after.agent.currentRecommendation), recommendationInitialValue: before.agent.currentRecommendation, scope: 'One isolated project; null recommendation before/after. No complete live adversarial overwrite, egress or cross-project audit.', proposedGates: gates, localRequiredChecks: lb.summary.hardGates, citationResolution: citations.counts };
const summary = { schemaVersion: 'layered-evaluation-report-v1', dataset: { cases: 96, dev: 72, heldOut: 24, primaryEctd: 24, novelDomainStress: 72, synthetic: true }, execution: { local: { observations: lb.observations.length, completed: lb.summary.validObservations, finalAnswers: 0 }, live: { observations: ub.observations.length, uniqueCases: ub.summary.uniqueCases, heldOut: ub.summary.heldOut }, independentJudges: { samples: judges.nSamples, cases: judges.nIndependentCases } }, correctness: { liveExperiments: ub.summary.deterministic, localExperimentScope: 'See local frozen/rescored baseline; not merged with live answer arithmetic.' }, retrieval: ranked.overall.ranked, multilingual: ranked.bilingual, grounding: grounding.byArtifactType, judges: judges.byArtifactType, cost, latency: { local: lb.summary.latency, live: ub.summary.latency }, permissions, pairwise: ub.pairwise, productionUnchanged: config.productionUnchanged, limitations: ['No overall composite score.', 'Curated synthetic data and small eligible heldout/live subsets do not establish broad reliability.', 'FC deployed revision/final model and upstream billing unverified.', 'Different execution lanes cannot be treated as before/after candidates.', 'Semantic judges are fallible; retain exact claim audits and deterministic gates.'] };
await fs.mkdir(out, { recursive: false });
const write = (name, value) => fs.writeFile(path.join(out, name), JSON.stringify(value, null, 2) + '\n', { flag: 'wx' });
for (const [file, value] of Object.entries({ 'config.json': config, 'summary.json': summary, 'deterministic-scores.json': { live: ub.summary.deterministic, localBaseline: provenance[0] }, 'retrieval-scores.json': ranked, 'judge-scores.json': judges, 'grounding-scores.json': grounding, 'pairwise.json': ub.pairwise, 'cost.json': cost, 'latency.json': summary.latency, 'failures.json': { localIndependentFindings: ladversarial, liveIndependentFindings: adversarial, permissions }, 'permission-gates.json': permissions })) await write(file, value);
const records = [{ lane: 'local-controlled', report: lb, directory: local }, { lane: 'live-ui', report: ub, directory: live }].flatMap(({ lane, report, directory }) => report.observations.map((o, i) => ({ lane, caseId: o.caseId, repeat: o.repeat, status: o.status, source: path.join(directory, 'baseline.json'), jsonPointer: `/observations/${i}` })));
await fs.writeFile(path.join(out, 'cases.jsonl'), records.map(r => JSON.stringify(r)).join('\n') + '\n', { flag: 'wx' });
console.log(JSON.stringify({ output: out, traceableObservations: records.length, productionUnchanged: config.productionUnchanged, fcRequests: cost.live.observedFcRequests, releaseEligible: false }));
