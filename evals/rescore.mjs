#!/usr/bin/env node
/** Deterministic evaluation only: rescore frozen observations without rerunning the application. */
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, extname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { SCORE_VERSION, scoreCase, summarize } from './lib/scoring.mjs';

const usage = 'Usage: node evals/rescore.mjs --baseline FROZEN_JSON --output NEW_JSON [--seed INTEGER] [--bootstrap-samples INTEGER] [--expected-parent-sha SHA256]\nUses only embedded frozen testCases and observations; never launches Electron, calls providers, or reads current suite gold. Existing output files are refused.';
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const stable = value => Array.isArray(value) ? value.map(stable) : object(value)
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])])) : value;
const contentHash = value => hash(JSON.stringify(stable(value)));

export function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--help' || argv[i] === '-h') return { help: true };
    const key = argv[i].startsWith('--') ? argv[i].slice(2) : '';
    if (!['baseline', 'output', 'seed', 'bootstrap-samples', 'expected-parent-sha'].includes(key)) throw new Error(`Unknown option ${argv[i]}`);
    if (Object.hasOwn(args, key)) throw new Error(`Duplicate option --${key}`);
    if (!argv[i + 1] || argv[i + 1].startsWith('--')) throw new Error(`Missing value for --${key}`);
    args[key] = argv[++i];
  }
  if (!args.baseline || !args.output) throw new Error(usage);
  for (const key of ['seed', 'bootstrap-samples']) if (args[key] !== undefined) {
    if (!/^-?\d+$/.test(args[key]) || !Number.isSafeInteger(Number(args[key]))) throw new Error(`--${key} must be a safe integer`);
    args[key] = Number(args[key]);
  }
  if (args['bootstrap-samples'] !== undefined && args['bootstrap-samples'] < 1) throw new Error('--bootstrap-samples must be positive');
  if (args['expected-parent-sha'] !== undefined && !/^[a-f\d]{64}$/i.test(args['expected-parent-sha'])) throw new Error('--expected-parent-sha must be a SHA-256 hex digest');
  return args;
}

function validateFrozenInput(parent) {
  if (!object(parent)) throw new Error('Frozen baseline must be a JSON object.');
  for (const key of ['runId', 'datasetHash']) if (typeof parent[key] !== 'string' || !parent[key].trim()) throw new Error(`Frozen baseline requires ${key}.`);
  for (const key of ['testCases', 'observations']) if (!Array.isArray(parent[key]) || !parent[key].length) throw new Error(`Frozen baseline requires nonempty embedded ${key}; no current suite or synthetic replacements are used.`);
  const cases = new Map();
  for (const testCase of parent.testCases) {
    if (!object(testCase) || typeof testCase.id !== 'string' || !testCase.id.trim() || !object(testCase.gold)) throw new Error('Every frozen testCase requires its original id and gold object.');
    if (cases.has(testCase.id)) throw new Error(`Duplicate frozen case ID ${testCase.id}.`);
    cases.set(testCase.id, testCase);
  }
  const seen = new Set();
  for (const observation of parent.observations) {
    if (!object(observation) || !cases.has(observation.caseId)) throw new Error(`Observation refers to an unknown frozen case: ${observation?.caseId}.`);
    const repeat = observation.repeat ?? 0;
    if (!Number.isSafeInteger(repeat) || repeat < 0) throw new Error('Observation repeat must be a nonnegative integer.');
    const key = JSON.stringify([observation.caseId, repeat]);
    if (seen.has(key)) throw new Error(`Duplicate frozen observation case/repeat: ${key}.`);
    seen.add(key);
  }
  return cases;
}

function rawIdentity(parent) {
  return {
    algorithm: 'SHA-256 of recursively key-sorted JSON; array order preserved',
    runId: parent.runId, datasetHash: parent.datasetHash,
    observationsSHA256: contentHash(parent.observations),
    testCasesSHA256: contentHash(parent.testCases),
    executionConfigSHA256: contentHash(parent.config ?? null),
    nObservations: parent.observations.length, nFrozenCases: parent.testCases.length,
  };
}

/** Reuses immutable raw fields, recomputes only deterministic scores, and never imports execution code. */
export function rescoreFrozenBaseline(parent, provenance, options = {}) {
  const cases = validateFrozenInput(parent);
  const seed = options.seed ?? parent.config?.options?.seed ?? 20260907;
  const bootstrapSamples = options.bootstrapSamples ?? 2000;
  if (!Number.isSafeInteger(seed) || !Number.isSafeInteger(bootstrapSamples) || bootstrapSamples < 1) throw new Error('Seed and bootstrap samples must be integers; samples must be positive.');
  for (const key of ['parentSHA', 'scorerSHA256']) if (!/^[a-f\d]{64}$/i.test(provenance?.[key] ?? '')) throw new Error(`Rescore provenance requires ${key}.`);
  const before = rawIdentity(parent);
  const scoreRows = parent.observations.map(observation => scoreCase(cases.get(observation.caseId), observation));
  const summary = summarize(parent.testCases, parent.observations, scoreRows, { seed, bootstrapSamples });
  if (parent.summary?.dataset !== undefined) summary.dataset = parent.summary.dataset;
  const after = rawIdentity(parent);
  if (JSON.stringify(before) !== JSON.stringify(after)) throw new Error('Scoring changed frozen observations, test cases or execution identity; no output will be written.');
  const createdAt = provenance.createdAt ?? new Date().toISOString();
  return {
    schemaVersion: '1', reportType: 'deterministic-rescore',
    runId: `${parent.runId}--rescore-${SCORE_VERSION}-${provenance.parentSHA.slice(0, 12)}`,
    parentSHA: provenance.parentSHA, scoreVersion: SCORE_VERSION, datasetHash: parent.datasetHash,
    ...(Object.hasOwn(parent, 'config') ? { config: parent.config } : {}),
    testCases: parent.testCases, observations: parent.observations, cases: scoreRows, summary,
    rescore: {
      createdAt,
      parent: { path: provenance.parentPath ?? null, sha256: provenance.parentSHA, runId: parent.runId, scoreVersion: parent.summary?.scoreVersion ?? parent.scoreVersion ?? null },
      scoring: { version: SCORE_VERSION, moduleSHA256: provenance.scorerSHA256, seed, bootstrapSamples },
      rawSourceIdentity: { ...before, unchanged: true },
      parentDigestVerification: provenance.parentDigestVerification ?? null,
      boundary: 'Deterministic rescore of embedded frozen observations and gold. Original execution config and raw observations are preserved; no application, Electron or provider execution occurred. Parent judgments and diagnostics remain in the immutable parent report.',
    },
  };
}

async function verifyParentDigest(inputPath, parentSHA, expectedSHA) {
  if (expectedSHA && expectedSHA.toLowerCase() !== parentSHA) throw new Error('Parent SHA-256 does not match --expected-parent-sha.');
  const suffix = extname(inputPath);
  const sidecarPath = `${suffix ? inputPath.slice(0, -suffix.length) : inputPath}.sha256`;
  let sidecar;
  try { sidecar = (await readFile(sidecarPath, 'utf8')).trim(); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (sidecar !== undefined && (!/^[a-f\d]{64}$/i.test(sidecar) || sidecar.toLowerCase() !== parentSHA)) throw new Error(`Parent SHA-256 does not match frozen sidecar ${sidecarPath}.`);
  return { expectedSHA256Verified: Boolean(expectedSHA), sidecarPath: sidecar === undefined ? null : sidecarPath, sidecarVerified: sidecar === undefined ? null : true };
}

export async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  if (args.help) { process.stdout.write(`${usage}\n`); return; }
  const inputPath = resolve(args.baseline); const outputPath = resolve(args.output);
  if (inputPath === outputPath) throw new Error('Output must be a new file distinct from the immutable baseline.');
  const [raw, scorerBytes] = await Promise.all([readFile(inputPath), readFile(new URL('./lib/scoring.mjs', import.meta.url))]);
  const parentSHA = hash(raw);
  const parentDigestVerification = await verifyParentDigest(inputPath, parentSHA, args['expected-parent-sha']);
  const report = rescoreFrozenBaseline(JSON.parse(raw.toString('utf8')), {
    parentSHA, parentPath: inputPath, scorerSHA256: hash(scorerBytes), parentDigestVerification,
  }, { seed: args.seed, bootstrapSamples: args['bootstrap-samples'] });
  if (hash(await readFile(inputPath)) !== parentSHA) throw new Error('Parent file changed while rescoring; no output will be written.');
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, { flag: 'wx' });
  process.stdout.write(`Rescored ${report.observations.length} frozen observations with scorer ${SCORE_VERSION}; wrote ${outputPath}\nParent SHA-256: ${parentSHA}\n`);
  return report;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => { process.stderr.write(`Rescore rejected: ${error.message}\n`); process.exitCode = 1; });
}
