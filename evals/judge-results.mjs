#!/usr/bin/env node
/** Validate external judge JSON and write an exclusively new aggregate report. */
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  aggregateJudgeScores, aggregatePairwiseScores, packetsFromDocument,
  parseStrictJson, scoresFromDocument, validatePairwiseScores,
} from './lib/judge-results.mjs';

const usage = `Usage: node evals/judge-results.mjs --packets FILE --scores FILE_OR_DIRECTORY --output NEW_FILE
  [--mode absolute|pairwise] [--mapping FILE] [--seed INTEGER] [--bootstrap-samples INTEGER]

Score files contain one strict judge-contract.json object or {"scores":[objects]}.
A score directory contains only the immediate *.json files to ingest. All packets must be scored.
Pairwise identities are summarized only when --mapping supplies a separate explicit orderMapping.
The output file must not already exist. Numeric claims are extraction only; arithmetic is never judged here.`;

function argumentsFrom(argv) {
  const options = {};
  const known = ['packets', 'scores', 'output', 'mode', 'mapping', 'seed', 'bootstrap-samples'];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--help') return { help: true };
    const key = arg.startsWith('--') ? arg.slice(2) : '';
    if (!known.includes(key)) throw new Error(`Unknown argument: ${arg}`);
    if (Object.hasOwn(options, key)) throw new Error(`Duplicate argument: ${arg}`);
    if (argv[i + 1] === undefined || argv[i + 1].startsWith('--')) throw new Error(`Missing value for ${arg}`);
    options[key] = argv[++i];
  }
  for (const key of ['packets', 'scores', 'output']) if (!options[key]) throw new Error(`--${key} is required`);
  options.mode ??= 'absolute';
  if (!['absolute', 'pairwise'].includes(options.mode)) throw new Error('--mode must be absolute or pairwise');
  if (options.mapping && options.mode !== 'pairwise') throw new Error('--mapping is only valid with --mode pairwise');
  for (const key of ['seed', 'bootstrap-samples']) if (options[key] !== undefined) {
    if (!/^-?\d+$/.test(options[key]) || !Number.isSafeInteger(Number(options[key]))) throw new Error(`--${key} must be a safe integer`);
    options[key] = Number(options[key]);
  }
  if (options['bootstrap-samples'] !== undefined && options['bootstrap-samples'] < 1) throw new Error('--bootstrap-samples must be positive');
  return options;
}

async function readJson(path) {
  return parseStrictJson(await readFile(path, 'utf8'), path);
}

export async function readScoreFiles(path) {
  const info = await stat(path);
  if (!info.isDirectory()) return scoresFromDocument(await readJson(path), path);
  const files = (await readdir(path, { withFileTypes: true }))
    .filter(entry => entry.isFile() && entry.name.endsWith('.json')).map(entry => entry.name).sort();
  if (!files.length) throw new Error(`${path}: no score JSON files found`);
  const documents = await Promise.all(files.map(file => readJson(join(path, file))));
  return documents.flatMap((document, i) => scoresFromDocument(document, join(path, files[i])));
}

export async function main(argv = process.argv.slice(2)) {
  const args = argumentsFrom(argv);
  if (args.help) { process.stdout.write(`${usage}\n`); return; }
  const [packetDocument, scores] = await Promise.all([readJson(args.packets), readScoreFiles(args.scores)]);
  const packets = packetsFromDocument(packetDocument);
  const options = {
    ...(args.seed === undefined ? {} : { seed: args.seed }),
    ...(args['bootstrap-samples'] === undefined ? {} : { bootstrapSamples: args['bootstrap-samples'] }),
  };
  let report;
  if (args.mode === 'pairwise') {
    // Keep unblinding downstream of complete validation, including on the CLI read path.
    validatePairwiseScores(packets, scores);
    const mapping = args.mapping ? await readJson(args.mapping) : undefined;
    report = aggregatePairwiseScores(packets, scores, mapping, options);
  } else report = aggregateJudgeScores(packets, scores, options);
  const output = resolve(args.output);
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, `${JSON.stringify(report, null, 2)}\n`, { flag: 'wx' });
  process.stdout.write(`Validated ${scores.length} judgments; wrote ${output}\n`);
  return report;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => { process.stderr.write(`Judge results rejected: ${error.message}\n`); process.exitCode = 1; });
}
