#!/usr/bin/env node
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { compareReports, createBlindPackets } from './lib/scoring.mjs';

export function parseArgs(args) {
  const parsed = {};
  for (let i = 0; i < args.length; i++) {
    const key = args[i];
    if (key === '--help' || key === '-h') { parsed.help = true; continue; }
    if (!['--baseline', '--candidate', '--out', '--blind-out', '--mapping-out', '--seed', '--bootstrap-samples', '--tolerance'].includes(key)) throw new Error(`Unknown option ${key}`);
    if (!args[i + 1] || args[i + 1].startsWith('--')) throw new Error(`Missing value for ${key}`);
    parsed[key.slice(2)] = args[++i];
  }
  return parsed;
}
const usage = 'Usage: node evals/compare.mjs --baseline immutable-baseline.json --candidate candidate.json [--out comparison.json] [--blind-out judge-packets.json --mapping-out private-order.json] [--seed 20260907]';

export async function main(args = process.argv.slice(2)) {
  const options = parseArgs(args);
  if (options.help) { console.log(usage); return; }
  if (!options.baseline || !options.candidate) throw new Error(usage);
  if (Boolean(options['blind-out']) !== Boolean(options['mapping-out'])) throw new Error('--blind-out and --mapping-out must be supplied together, in separate files.');
  const baselinePath = resolve(options.baseline); const candidatePath = resolve(options.candidate);
  const outputPaths = [options.out, options['blind-out'], options['mapping-out']].filter(Boolean).map(path => resolve(path));
  if (new Set(outputPaths).size !== outputPaths.length || outputPaths.some(path => [baselinePath, candidatePath].includes(path))) throw new Error('Output paths must be distinct from one another and both input reports. Baselines are immutable.');
  const [baseline, candidate] = await Promise.all([readFile(baselinePath, 'utf8').then(JSON.parse), readFile(candidatePath, 'utf8').then(JSON.parse)]);
  if (!Array.isArray(baseline.cases ?? baseline.scoreRows) || !baseline.summary || !Array.isArray(candidate.cases ?? candidate.scoreRows) || !candidate.summary) throw new Error('Each report must contain cases (or scoreRows) and summary.');
  const settings = { seed: Number(options.seed ?? 20260907), bootstrapSamples: Number(options['bootstrap-samples'] ?? 2000), tolerance: Number(options.tolerance ?? 0) };
  if (!Number.isSafeInteger(settings.seed) || !Number.isSafeInteger(settings.bootstrapSamples) || settings.bootstrapSamples < 1 || !Number.isFinite(settings.tolerance) || settings.tolerance < 0) throw new Error('Seed/samples must be integers, samples positive, and tolerance nonnegative.');
  const result = compareReports(baseline, candidate, settings);
  const save = async (path, data) => { await mkdir(dirname(resolve(path)), { recursive: true }); await writeFile(path, `${JSON.stringify(data, null, 2)}\n`, { flag: 'wx' }); };
  if (options.out) await save(options.out, result);
  if (options['blind-out']) {
    const { packets, orderMapping, ...metadata } = createBlindPackets(baseline, candidate, settings);
    await save(options['blind-out'], { ...metadata, packets });
    await save(options['mapping-out'], { seed: settings.seed, orderMapping });
  }
  console.log(JSON.stringify(result, null, 2));
  process.exitCode = result.passed ? 0 : 1;
  return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main().catch(error => { console.error(error.message); process.exitCode = 2; });
