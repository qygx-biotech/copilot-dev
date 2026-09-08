#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { performance } from 'node:perf_hooks';
import { captureMetadata, verifyFrozenSuite, writeJson, sha256 } from './lib/reproducibility.mjs';
import { scoreCase, summarize } from './lib/scoring.mjs';
import { createLiveFc } from './lib/live-fc.mjs';
const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const options = { suite: 'all', repeats: 1, output: null, existing: true, warm: true, seed: 20260907 };
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === '--help') { console.log('npm run eval:agent -- [--suite all|retrieval|sync|multilingual|corpus|experiments|permissions|robustness] [--repeats N] [--output DIR] [--no-existing] [--no-warm] [--live --fc-token-file FILE] [--keep-scratch]\nDefault: frozen synthetic dataset, real local application pipeline, explicitly controlled provider adapters. Live mode uses only the existing authenticated FC client. Baselines are never overwritten.'); process.exit(0); }
  else if (a === '--no-existing') options.existing = false;
  else if (a === '--no-warm') options.warm = false;
  else if (a === '--keep-scratch') options.keepScratch = true;
  else if (a === '--live') options.live = true;
  else if (['--suite', '--repeats', '--output', '--seed', '--fc-token-file', '--fc-url', '--case'].includes(a)) {
    if (!args[i + 1] || args[i + 1].startsWith('--')) throw new Error(`Missing argument for ${a}`);
    options[a.slice(2)] = args[++i];
  } else throw new Error(`Unknown option ${a}`);
}
options.repeats = Number(options.repeats); options.seed = Number(options.seed);
if (!Number.isSafeInteger(options.repeats) || options.repeats < 1 || options.repeats > 30) throw new Error('Repeats must be an integer from 1 to 30.');

// Match the application ABI without rebuilding or modifying production dependencies.
if (!process.versions.electron && (Number(process.versions.node.split('.')[0]) < 22 || Number(process.versions.node.split('.')[0]) >= 25)) {
  const child = spawn(require('electron'), [fileURLToPath(import.meta.url), ...args], { cwd: root, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, stdio: 'inherit' });
  child.on('exit', code => process.exit(code ?? 2));
  child.on('error', error => { console.error(error.message); process.exit(2); });
} else await main();

async function subprocess(label, argv, outputDir, timeoutMs = 240000) {
  const start = performance.now();
  let stdout = '', stderr = '', timedOut = false;
  const result = await new Promise(resolve => {
    const child = spawn(process.execPath, argv, { cwd: root, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } });
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGTERM'); }, timeoutMs);
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', error => { clearTimeout(timer); resolve({ exitCode: null, error: error.code || error.name }); });
    child.on('close', exitCode => { clearTimeout(timer); resolve({ exitCode }); });
  });
  const redact = text => text.replace(/Bearer\s+[A-Za-z0-9._~-]+/gi, 'Bearer <redacted>');
  await fs.writeFile(path.join(outputDir, `${label}.stdout.txt`), redact(stdout));
  await fs.writeFile(path.join(outputDir, `${label}.stderr.txt`), redact(stderr));
  const count = key => { const match = stdout.match(new RegExp(`(?:#|ℹ) ${key} (\\d+)`)); return match ? Number(match[1]) : null; };
  return { label, argv, ...result, timedOut, latencyMs: performance.now() - start, tests: count('tests'), pass: count('pass'), fail: count('fail'), skipped: count('skipped'), output: `${label}.stdout.txt`, mode: 'existing-controlled-regression-tests' };
}

async function existingBenchmarks(outputDir) {
  await fs.mkdir(outputDir, { recursive: true });
  const fc = (await fs.readdir(path.join(root, 'alibaba-fc/test'))).filter(f => f.endsWith('.test.js')).map(f => `alibaba-fc/test/${f}`);
  const desktopNames = ['project-filesystem', 'security-boundary', 'renderer-adapters', 'cloud-retrieval', 'job-execution', 'side-chat-renderer'];
  const desktop = desktopNames.map(f => `desktop/test/${f}.test.mjs`);
  const local = (await fs.readdir(path.join(root, 'local-backend/test'))).filter(f => f.endsWith('.test.js')).map(f => `local-backend/test/${f}`);
  const groups = [['fc-regressions', ['--test', '--test-reporter=tap', ...fc]], ['desktop-regressions', ['--test', '--test-reporter=tap', ...desktop]], ['qmd-regressions', ['--test', '--test-reporter=tap', ...local]],
    ['semantic-benchmark', ['scripts/benchmark-semantic-intent.js', '--output', path.join(outputDir, 'semantic-benchmark.json')]],
    ['preflight-benchmark', ['scripts/benchmark-preflight-sync.mjs']],
    ['retrieval-replay', ['local-backend/scripts/benchmark-retrieval.js', '--fixture', '--model', 'lexical', '--repeats', '3', '--output', path.join(outputDir, 'retrieval-replay.json')]]];
  const results = [];
  for (const [label, argv] of groups) { console.log(`Existing benchmark: ${label}`); results.push(await subprocess(label, argv, outputDir)); }
  await writeJson(path.join(outputDir, 'summary.json'), results);
  return results;
}

async function main() {
  const suiteDir = path.join(root, 'evals/biodesign-eval-v1');
  const freeze = await verifyFrozenSuite(suiteDir);
  const cases = (await fs.readFile(path.join(suiteDir, 'cases.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
  if (new Set(cases.map(c => c.id)).size !== cases.length) throw new Error('Duplicate frozen case IDs.');
  const suiteAliases = { retrieval: ['lookup', 'discovery', 'semantic_retrieval'], experiments: ['experiments', 'numeric'], robustness: ['failure_injection', 'sync_failure', 'novel_domain_stress'] };
  const selectors = [options.suite, ...(suiteAliases[options.suite] || [])];
  const selected = cases.filter(c => (options.suite === 'all' || selectors.some(s => (c.suites || []).includes(s) || c.category === s || (c.categories || []).includes(s))) && (!options.case || options.case.split(',').includes(c.id)));
  if (!selected.length) throw new Error(`No cases selected by suite ${options.suite}.`);
  const runId = new Date().toISOString().replace(/[:.]/g, '-');
  const outputDir = path.resolve(root, options.output || `evals/results/${runId}`);
  await fs.mkdir(path.dirname(outputDir), { recursive: true });
  await fs.mkdir(outputDir, { recursive: false });
  const metadata = await captureMetadata(root);
  const safeOptions = { ...options, 'fc-token-file': options['fc-token-file'] ? '<provided; not logged>' : null };
  const config = { ...metadata, runId, suiteVersion: 'biodesign-eval-v1', fixtureVersion: freeze.manifest.fixtureVersion ?? freeze.manifest.fixture_version ?? 'biodesign-eval-v1', datasetHash: freeze.hash, suiteManifest: freeze.manifest,
    options: safeOptions, datasetSize: cases.length, heldOutSize: cases.filter(c => ['heldout', 'held-out', 'held_out'].includes(c.split)).length, selectedCases: selected.length,
    evaluationBoundary: 'Production ProjectContextService.buildContext; PDF/source/experiment/QMD production modules; provider substitutions explicitly labeled; no production algorithms modified.',
    costs: 'Only observed counts are values. Provider tokens, upstream attempts, and price are null unless exposed by the authorized FC route.' };
  await writeJson(path.join(outputDir, 'config.json'), config);
  await fs.copyFile(path.join(suiteDir, 'cases.jsonl'), path.join(outputDir, 'frozen-cases.jsonl'));
  const liveConfig = options.live ? await createLiveFc({ baseUrl: options['fc-url'], tokenFile: options['fc-token-file'] }) : null;
  if (options.live && !liveConfig) throw new Error('Live mode requires BIODESIGN_EVAL_FC_TOKEN or --fc-token-file from the existing authorized FC session; no provider credential is accepted.');
  if (liveConfig) { config.modelConfigurationSignatures = await liveConfig.probe(); await writeJson(path.join(outputDir, 'config.json'), config); }
  const { createAdapter } = await import('./lib/application-adapter.mjs');
  const observations = [];
  await fs.writeFile(path.join(outputDir, 'cases.jsonl'), '');
  for (let repeat = 0; repeat < options.repeats; repeat++) {
    const adapter = await createAdapter({ fixtureRoot: suiteDir, liveConfig, keepScratch: options.keepScratch, controlledProviders: !options.live });
    try {
      for (const c of selected) for (const cacheState of options.warm ? ['cold', 'warm'] : ['cold']) {
        console.log(`Case ${c.id} ${cacheState} repeat ${repeat + 1}/${options.repeats}`);
        // Gold is deliberately unavailable at the execution boundary.
        const { gold, expected, scoring, rubric, ...input } = c;
        const observation = await adapter.runCase(input, { cacheState, repeat });
        observation.repeat = repeat * 2 + (cacheState === 'warm' ? 1 : 0);
        observation.sampleRepeat = repeat;
        observation.cacheState = cacheState;
        observations.push(observation);
        await fs.appendFile(path.join(outputDir, 'cases.jsonl'), JSON.stringify(observation) + '\n');
      }
    } finally { await adapter.close(); }
  }
  const scoreRows = observations.map(o => scoreCase(cases.find(c => c.id === o.caseId), o));
  const summary = summarize(cases, observations, scoreRows, { seed: options.seed });
  summary.dataset = { total: cases.length, selected: selected.length, dev: cases.filter(c => c.split === 'dev').length, heldOut: config.heldOutSize, fixture: 'explicitly synthetic; not production scientific evidence' };
  const failures = scoreRows.flatMap(row => [
    ...row.hardFailures.map(f => ({ caseId: row.caseId, repeat: row.repeat, primaryCategory: /permission|side_effect|leak/.test(f.type) ? 'PERMISSION' : /source_rows|numeric/.test(f.type) ? 'EXPERIMENT_NORMALIZATION' : 'GROUNDING', ...f })),
    ...Object.entries(row.metrics).filter(([key, value]) => /recall|Accuracy/.test(key) && value < 1).map(([metric, value]) => ({ caseId: row.caseId, repeat: row.repeat, primaryCategory: metric.startsWith('retrieval') ? 'RETRIEVAL' : 'EXPERIMENT_NORMALIZATION', metric, value, status: 'observed_deficit', detail: 'Metric below full frozen-gold coverage; see raw output. This is not alone a semantic-answer judgment.' })),
    ...(!row.valid ? [{ caseId: row.caseId, repeat: row.repeat, primaryCategory: 'ROBUSTNESS', status: row.status, detail: observations.find(o => o.caseId === row.caseId && o.repeat === row.repeat)?.errors }] : []),
  ]);
  const judges = { status: 'pending-independent-evaluation', scores: [], answerSampleCount: scoreRows.filter(r => r.answer).length, limitation: 'No synthetic or producer self-judgment is accepted as an LLM score.' };
  const pairwise = { status: 'not-applicable-single-baseline', evaluatedCases: 0, candidateWinRate: null, baselineWinRate: null, tieRate: null, reason: 'No production candidate change was made.' };
  const corpus = observations.filter(o => o.actual?.corpus).map(o => ({ caseId: o.caseId, repeat: o.repeat, corpus: o.actual.corpus }));
  const costs = { actualFcCalls: liveConfig?.calls.length ?? 0, actualRequestyCalls: liveConfig ? null : 0, inputTokens: liveConfig ? null : 0, outputTokens: liveConfig ? null : 0,
    estimatedCostUsd: null, liveProviderMeasured: Boolean(liveConfig), actualFcTrace: liveConfig?.calls ?? [],
    perCase: observations.map(o => ({ caseId: o.caseId, repeat: o.repeat, cacheState: o.cacheState, providerMode: o.provenance?.providerMode, counters: o.provenance?.counters ?? null, telemetry: o.actual?.context?.semantic?.telemetry ?? null, cost: o.cost })),
    limitation: 'Zero actual provider calls in controlled mode describes this evaluation run only. Controlled logical work counts do not establish production provider costs.' };
  // Save baseline before inspecting failures diagnostically or running additional reviewer probes.
  const baseline = { schemaVersion: '1', runId, datasetHash: freeze.hash, config, testCases: selected, observations, cases: scoreRows, summary, judgeScores: judges, pairwise, corpus, cost: costs, failures };
  await fs.writeFile(path.join(outputDir, 'baseline.json'), JSON.stringify(baseline, null, 2) + '\n', { flag: 'wx' });
  await fs.writeFile(path.join(outputDir, 'baseline.sha256'), sha256(await fs.readFile(path.join(outputDir, 'baseline.json'))) + '\n', { flag: 'wx' });
  console.log(`Baseline frozen: ${path.join(outputDir, 'baseline.json')}`);
  await writeJson(path.join(outputDir, 'deterministic-scores.json'), scoreRows.map(({ caseId, repeat, metrics, checks, experimentDetails }) => ({ caseId, repeat, metrics, checks, experimentDetails })));
  await writeJson(path.join(outputDir, 'retrieval-scores.json'), { metrics: Object.fromEntries(Object.entries(summary.metrics).filter(([key]) => key.startsWith('retrieval.'))), bilingual: summary.bilingual, cases: scoreRows.map(({ caseId, repeat, retrieval, metrics }) => ({ caseId, repeat, retrieval, metrics })) });
  for (const [name, value] of Object.entries({ 'judge-scores': judges, pairwise, cost: costs, latency: summary.latency, failures, summary, corpus })) await writeJson(path.join(outputDir, `${name}.json`), value);
  const existing = options.existing ? await existingBenchmarks(path.join(outputDir, 'existing')) : [];
  await writeJson(path.join(outputDir, 'existing-benchmarks.json'), existing);
  const after = await captureMetadata(root);
  await writeJson(path.join(outputDir, 'production-integrity.json'), { before: metadata.productionTreeHash, after: after.productionTreeHash, unchanged: metadata.productionTreeHash === after.productionTreeHash, changedFiles: Object.keys(metadata.trackedFileHashes).filter(p => metadata.trackedFileHashes[p] !== after.trackedFileHashes[p]) });
  await fs.writeFile(path.join(outputDir, 'REPORT.md'), basicReport(baseline, existing));
  console.log(JSON.stringify({ outputDir, observations: observations.length, valid: summary.validObservations, hardGates: summary.hardGates.status, releaseEligible: summary.releaseEligible }, null, 2));
  process.exitCode = summary.hardGates.failed ? 1 : 0;
}

function basicReport(b, existing) {
  const rows = Object.entries(b.summary.metrics).map(([key, s]) => `| ${key} | ${s.mean?.toFixed(4) ?? 'unmeasured'} | ${s.clusters} | ${s.ci95?.map(x => x.toFixed(4)).join(' – ') ?? 'n/a'} |`).join('\n');
  return `# BioDesign agent evaluation baseline\n\nRun: ${b.runId}. Suite: biodesign-eval-v1. Commit: ${b.config.gitCommit}; dirty tree recorded by hashes.\n\nAll sources are clearly synthetic. Application entrypoint is ProjectContextService.buildContext. Final answers and live provider billing are unmeasured unless an authenticated FC client was used.\n\n${b.summary.dataset.total} frozen cases; ${b.summary.dataset.heldOut} held out; ${b.summary.totalObservations} observations; ${b.summary.invalidObservations} blocked/error observations.\n\n| Metric | Mean | Case clusters | Bootstrap 95% interval |\n|---|---:|---:|---|\n${rows}\n\nHard gates: ${b.summary.hardGates.status}; ${b.summary.hardGates.failed} failures, ${b.summary.hardGates.unknown} unknown checks. Release eligibility: ${b.summary.releaseEligible}. Unknowns and protocol checks do not establish live release clearance.\n\nLatency cold p50/p95: ${b.summary.latency.cold.p50Ms}/${b.summary.latency.cold.p95Ms} ms; warm: ${b.summary.latency.warm.p50Ms}/${b.summary.latency.warm.p95Ms} ms. These are measured local boundary timings, not full streamed-answer latency.\n\nIndependent judgments: ${b.judgeScores.status}. Pairwise: no candidate, n=0.\n\nExisting tests/benchmarks:\n\n${existing.map(x => `- ${x.label}: exit ${x.exitCode}; tests ${x.tests ?? 'n/a'}, pass ${x.pass ?? 'n/a'}, fail ${x.fail ?? 'n/a'}, skipped ${x.skipped ?? 'n/a'}.`).join('\n')}\n\nThe immutable baseline precedes diagnosis; post-baseline reviewer results are separate artifacts. Do not rewrite this baseline after adding diagnostics.\n`;
}
