#!/usr/bin/env node
// Assembly of frozen UI observations only. No application or provider execution.
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { captureMetadata, verifyFrozenSuite, sha256 } from './lib/reproducibility.mjs';
import { bootstrapMean, quantile, scoreExperiments } from './lib/scoring.mjs';
import { parseStrictJson } from './lib/judge-results.mjs';

export const UI_SCORE_VERSION = 'live-ui-audit-v1';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const object = x => x !== null && typeof x === 'object' && !Array.isArray(x);
const nonempty = x => typeof x === 'string' && x.trim().length > 0;
const finite = x => typeof x === 'number' && Number.isFinite(x);
const key = x => JSON.stringify([x.caseId, x.repeat]);
const requireValue = (condition, message) => { if (!condition) throw new Error(message); };
const usage = 'Usage: node evals/summarize-ui.mjs --directory RESULT_DIR [--numeric-extractions JSON]\nFreeze a complete predeclared UI lane. All output files must be new. No Electron or provider calls.';

export function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    if (['--help', '-h'].includes(argv[i])) return { help: true };
    requireValue(['--directory', '--numeric-extractions'].includes(argv[i]), `Unknown option ${argv[i]}`);
    const name = argv[i].slice(2);
    requireValue(!Object.hasOwn(args, name), `Duplicate option --${name}`);
    requireValue(argv[i + 1] && !argv[i + 1].startsWith('--'), `Missing value for --${name}`);
    args[name] = argv[++i];
  }
  requireValue(args.directory, usage);
  return args;
}

function uniqueStrings(values, label, { empty = false } = {}) {
  requireValue(Array.isArray(values) && (empty || values.length > 0) && values.every(nonempty), `${label} must be an array of nonempty strings`);
  requireValue(new Set(values).size === values.length, `${label} contains duplicates`);
}

function exactSpan(span, answer, label) {
  requireValue(nonempty(span) && answer.includes(span), `${label} must be a nonempty exact frozen answer span`);
}

function containsReference(text, reference) {
  const idChar = char => Boolean(char && /[\p{L}\p{N}_:.-]/u.test(char));
  for (let start = text.indexOf(reference); start !== -1; start = text.indexOf(reference, start + 1)) {
    const end = start + reference.length;
    if (!idChar(text[start - 1]) && (!idChar(text[end]) || text[end] === '.' && !idChar(text[end + 1]))) return true;
  }
  return false;
}

function statistics(values) {
  const a = values.filter(finite); const meanMs = a.length ? a.reduce((sum, x) => sum + x, 0) / a.length : null;
  return { n: a.length, missing: values.length - a.length, meanMs, p50Ms: quantile(a, .5), p95Ms: quantile(a, .95), varianceMs2: a.length > 1 ? a.reduce((sum, x) => sum + (x - meanMs) ** 2, 0) / (a.length - 1) : null };
}

/** Validation is independent of filename labels such as a corpus-specific cold suffix. */
function validateInputs(cases, observations, selection, datasetHash) {
  requireValue(Array.isArray(cases) && cases.length > 0, 'Frozen cases are required');
  uniqueStrings(cases.map(c => c.id), 'Frozen case IDs');
  const index = new Map(cases.map(c => [c.id, c]));
  requireValue(object(selection), 'Predeclared selection is required');
  uniqueStrings(selection.caseIds, 'selection.caseIds'); uniqueStrings(selection.repeatCaseIds, 'selection.repeatCaseIds', { empty: true });
  requireValue(selection.selectedBeforeAnyLiveOutput === true && Number.isFinite(Date.parse(selection.timestamp)), 'Selection must attest predeclaration and record a valid timestamp');
  requireValue(selection.caseIds.every(id => index.has(id)) && selection.repeatCaseIds.every(id => selection.caseIds.includes(id)), 'Selection contains unknown or unselected repeat case IDs');
  requireValue(selection.datasetHash === undefined || selection.datasetHash === datasetHash, 'Selection dataset hash mismatch');
  const expected = new Set(selection.caseIds.flatMap(caseId => [key({ caseId, repeat: 0 }), ...(selection.repeatCaseIds.includes(caseId) ? [key({ caseId, repeat: 1 })] : [])]));
  requireValue(Array.isArray(observations) && observations.length === expected.size, 'Predeclared live selection is incomplete or duplicated');
  const seen = new Set(); const times = new Map();
  for (const o of observations) {
    requireValue(object(o) && expected.has(key(o)) && !seen.has(key(o)), 'Duplicate, unknown or non-predeclared observation identity'); seen.add(key(o));
    requireValue(o.datasetHash === datasetHash && o.status === 'completed' && o.executionMode === 'live-electron-side-chat-ui', 'Observation dataset/status/execution mode does not match the frozen UI lane');
    const messages = o.actual?.storedConversation?.messages;
    requireValue(Array.isArray(messages), 'Stored conversation messages are required');
    const users = messages.filter(m => m.role === 'user'); const assistants = messages.filter(m => m.role === 'assistant');
    requireValue(users.length === 1 && users[0].content === index.get(o.caseId).query && assistants.length === 1, 'Conversation must contain exactly the frozen one-turn query and one final assistant answer');
    requireValue(messages.indexOf(users[0]) < messages.indexOf(assistants[0]) && nonempty(o.actual?.answer?.text) && o.actual.answer.text === assistants[0].content, 'Frozen answer must equal the stored final assistant content');
    const started = Date.parse(users[0].createdAt); const ended = Date.parse(assistants[0].createdAt);
    requireValue(Number.isFinite(started) && Number.isFinite(ended) && ended >= started && o.timing?.latencyMs === ended - started, 'Latency must exactly match valid persisted user/assistant timestamps');
    requireValue(Date.parse(selection.timestamp) <= ended, 'Selection timestamp follows an already available live answer');
    requireValue(['cold', 'warm'].includes(o.cacheState) && o.timing.cacheState === o.cacheState, 'Observation and timing cache states must agree');
    if (o.telemetry?.cloudCalls !== undefined && o.telemetry.cloudCalls !== null) requireValue(object(o.telemetry.cloudCalls) && Object.values(o.telemetry.cloudCalls).every(n => Number.isSafeInteger(n) && n >= 0), 'Logical cloud counters must be nonnegative integers');
    times.set(key(o), { started, ended });
  }
  const chronological = [...observations].sort((a, b) => times.get(key(a)).started - times.get(key(b)).started);
  requireValue(chronological.every((o, i) => o.cacheState === (i === 0 ? 'cold' : 'warm')), 'Only the first chronological request is cold in the shared workspace; every subsequent request must be warm');
  return { index, chronological };
}

function numericAudit(cases, observations, extractionDocument) {
  requireValue(object(extractionDocument) && Array.isArray(extractionDocument.extractions), 'Numeric extraction document requires an extractions array');
  const observationIndex = new Map(observations.map(o => [key(o), o])); const extractionIndex = new Map();
  for (const extraction of extractionDocument.extractions) {
    const id = key(extraction); const observation = observationIndex.get(id); const gold = cases.get(extraction.caseId)?.gold?.entries;
    requireValue(observation && Array.isArray(gold) && gold.length && !extractionIndex.has(id), 'Unknown, nonnumeric or duplicate numeric extraction identity');
    requireValue(nonempty(extraction.method) && Array.isArray(extraction.entries), 'Extraction method and entries are required');
    if (extraction.declaredAbsenceSpan !== undefined && extraction.declaredAbsenceSpan !== null) exactSpan(extraction.declaredAbsenceSpan, observation.actual.answer.text, 'declaredAbsenceSpan');
    const names = new Set();
    for (const entry of extraction.entries) {
      requireValue(object(entry) && nonempty(entry.name) && !names.has(entry.name), 'Duplicate or invalid numeric extraction entry name'); names.add(entry.name);
      requireValue(gold.some(g => g.name === entry.name), 'Numeric extraction entry must identify a frozen requested result');
      exactSpan(entry.answerSpan, observation.actual.answer.text, `Extraction ${entry.name}.answerSpan`);
      requireValue(finite(entry.value), 'Extracted numeric value must be finite');
      const literals = entry.answerSpan.replace(/−/g, '-').match(/[+-]?(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?(?:[eE][+-]?\d+)?/g) ?? [];
      requireValue(literals.some(literal => Number(literal.replaceAll(',', '')) === entry.value), 'Extracted value does not occur literally in its answerSpan; do not replace candidate arithmetic with a gold value');
      for (const field of ['unit', 'field', 'aggregation']) requireValue(entry[field] === undefined || entry[field] === null || nonempty(entry[field]), `Invalid extracted ${field}`);
      requireValue(entry.filters === undefined || entry.filters === null || object(entry.filters), 'Extracted filters must be an object or absent');
      for (const field of ['sourceRows', 'groupBy']) if (entry[field] !== undefined && entry[field] !== null) uniqueStrings(entry[field], `Extracted ${field}`, { empty: true });
      if (entry.filterSpans !== undefined) {
        requireValue(object(entry.filterSpans), 'filterSpans must map filter fields to exact answer spans');
        for (const span of Object.values(entry.filterSpans)) exactSpan(span, observation.actual.answer.text, 'filterSpans');
      }
    }
    extractionIndex.set(id, extraction);
  }
  return observations.filter(o => cases.get(o.caseId).gold.entries?.length).map(o => {
    const gold = cases.get(o.caseId).gold.entries; const extraction = extractionIndex.get(key(o));
    if (!extraction) return { caseId: o.caseId, repeat: o.repeat, status: 'unmeasured', exact: null };
    const details = gold.map(g => {
      const actual = extraction.entries.find(a => a.name === g.name);
      const dimensions = actual ? scoreExperiments([g], [actual]).entries[0].fields
        : Object.fromEntries(['value', 'unit', 'field', 'aggregation', 'filters', 'groupBy', 'sourceRows'].map(field => [field, false]));
      if (actual?.unit) dimensions.unit = Boolean(dimensions.unit && o.actual.answer.text.includes(actual.unit));
      const candidateProvenance = `${o.actual.answer.text}\n${JSON.stringify(o.actual.answer.citations ?? [])}`;
      if (actual?.sourceRows?.length) dimensions.sourceRows = Boolean(dimensions.sourceRows && actual.sourceRows.every(row => containsReference(candidateProvenance, row)));
      const explicitFilters = Boolean(dimensions.filters && Object.keys(actual?.filters ?? {}).every(field => nonempty(actual.filterSpans?.[field])));
      // An exact, candidate-evidenced row set also establishes the selected result's
      // filter fulfillment. It never supplies unobserved rows or excuses an asserted
      // extra/contradictory constraint, and does not prove hidden query execution.
      const assertedFiltersConsistent = Object.entries(actual?.filters ?? {}).every(([field, value]) =>
        Object.hasOwn(g.filters ?? {}, field) && scoreExperiments([{ ...g, filters: { [field]: g.filters[field] } }], [{ ...actual, filters: { [field]: value } }]).entries[0].fields.filters);
      const rowFilters = Boolean(dimensions.sourceRows && actual?.sourceRows?.length && assertedFiltersConsistent);
      dimensions.filters = explicitFilters || rowFilters;
      const filterEvidence = explicitFilters ? 'explicit_candidate_spans' : rowFilters ? 'exact_cited_rowset' : 'unestablished_or_conflicting';
      return { name: g.name, gold: g, observed: actual ?? null, dimensions, filterEvidence, exact: Object.values(dimensions).every(value => value === true) };
    });
    return { caseId: o.caseId, repeat: o.repeat, status: 'scored', extractionMethod: extraction.method, details, exact: details.every(d => d.exact), declaredAbsenceSpan: extraction.declaredAbsenceSpan ?? null };
  });
}

/** Pure assembly for synthetic tests; this never reads files or executes the application. */
export function assembleUiBaseline({ cases, observations, selection, datasetHash, metadata = {}, extractionDocument = { extractions: [] }, runId = 'ui-baseline' }) {
  const { index, chronological } = validateInputs(cases, observations, selection, datasetHash);
  const numeric = numericAudit(index, observations, extractionDocument); const scored = numeric.filter(n => n.exact !== null);
  const deterministic = {
    scoringVersion: 'live-ui-numeric-audit-v1', extractionPolicy: 'Literal values and nonempty exact spans are transcribed from frozen candidate answers, then compared with frozen gold by code. Filters require exact filterSpans or the exact frozen row set evidenced in candidate answer/citations; extra or contradictory asserted filters still fail. Row-based filter fulfillment concerns the selected result, not proof of hidden query execution. Missing provenance fails its dimension. This checks audited requested results, not exhaustive numeric claim coverage or semantic truth.',
    cases: numeric, exactCases: scored.filter(n => n.exact).length, evaluatedCases: scored.length,
    exactAccuracy: scored.length ? scored.filter(n => n.exact).length / scored.length : null,
    caseClusterAccuracy: bootstrapMean(scored.map(n => ({ cluster: n.caseId, value: Number(n.exact) }))),
  };
  const latency = {
    measurement: 'Persisted user-to-assistant timestamps; buffering and service time included. UI bridge delays between requests excluded. Shared workspace warms sequentially; only the first request is cold. Statistics describe observations, not independent repetitions.',
    all: statistics(observations.map(o => o.timing.latencyMs)), cold: statistics(chronological.slice(0, 1).map(o => o.timing.latencyMs)), warm: statistics(chronological.slice(1).map(o => o.timing.latencyMs)),
    firstVisibleResponseMs: null, perCase: chronological.map(o => ({ caseId: o.caseId, repeat: o.repeat, cacheState: o.cacheState, ...o.timing })),
  };
  const roleCounts = {}; const roleCoverage = {};
  for (const o of observations) for (const [role, n] of Object.entries(o.telemetry?.cloudCalls ?? {})) { roleCounts[role] = (roleCounts[role] ?? 0) + n; roleCoverage[role] = (roleCoverage[role] ?? 0) + 1; }
  const cost = { savedLogicalRoleCounts: roleCounts, roleObservationCoverage: roleCoverage, totalObservations: observations.length, actualFcRequests: null, actualRequestyCalls: null, inputTokens: null, outputTokens: null, estimatedUsd: null, limitation: 'Persisted counters omit some preflight/planner work and are not transport counts. Missing counters remain unmeasured. Upstream attempts and billing are unavailable.' };
  const selected = cases.filter(c => selection.caseIds.includes(c.id));
  const config = { ...metadata, evaluationMode: 'live-electron-side-chat-ui', datasetHash, suiteVersion: 'biodesign-eval-v1', selection, fcRevision: null, mainProcessRevisionAttested: false };
  const pairwise = { evaluatedCases: 0, candidateWinRate: null, baselineWinRate: null, tieRate: null, reason: 'One production baseline only; no two-system judgments supplied.' };
  const failures = scored.filter(n => n.exact === false).length;
  const summary = {
    scoreVersion: UI_SCORE_VERSION, scoringVersion: UI_SCORE_VERSION, observations: observations.length, uniqueCases: selected.length,
    dev: selected.filter(c => c.split === 'dev').length, heldOut: selected.filter(c => c.split === 'heldout').length,
    domains: Object.fromEntries([...new Set(selected.map(c => c.domain))].map(d => [d, selected.filter(c => c.domain === d).length])),
    deterministic, latency, cost, releaseEligible: false,
    releaseReason: `${failures ? `${failures} audited numeric observation(s) failed. ` : ''}Security, exhaustive answer grounding and deployment/usage attestations are incomplete. No release clearance is established.`,
    limitations: ['Curated synthetic subset; not a population estimate.', 'Repetitions are not independent cases.', 'Live final-answer citations do not establish ranked retrieval metrics.', 'FC deployed revision/final model are not attested.', 'Judge scores and semantic grounding are separately validated supplements.', 'UI-to-UI comparisons require this UI scorer version and UI execution mode; local application reports are incompatible.'],
  };
  const rows = observations.map(o => {
    const n = numeric.find(n => key(n) === key(o));
    return { caseId: o.caseId, repeat: o.repeat, valid: true, executionMode: o.executionMode, status: o.status, metrics: n?.exact === null || !n ? {} : { 'ui.numeric.exactAccuracy': Number(n.exact) },
      checks: [{ type: 'ui_security_and_grounding_audit', required: true, status: 'unknown', detail: 'Complete permission, side-effect and final-answer grounding audits are not available.' }],
      latencyMs: o.timing.latencyMs, cacheState: o.cacheState, cost: { retrieval: null, generation: null, judge: null }, answer: o.actual.answer.text, query: index.get(o.caseId).query };
  });
  return { schemaVersion: 'live-ui-baseline-v1', datasetHash, runId, config, testCases: selected, observations, cases: rows, summary, pairwise };
}

/** Reserve all output names first; never overwrite, including sidecars and partial prior runs. */
export async function writeUiArtifacts(directory, artifacts) {
  const reserved = [];
  try {
    for (const [name, contents] of Object.entries(artifacts)) {
      requireValue(path.basename(name) === name, 'Artifact names must be simple filenames');
      const handle = await fs.open(path.join(directory, name), 'wx');
      reserved.push({ name, handle, identity: await handle.stat(), contents });
    }
    for (const { handle, contents } of reserved) await handle.writeFile(contents);
  } catch (error) {
    for (const file of reserved) {
      const current = await fs.lstat(path.join(directory, file.name)).catch(() => null);
      if (current && current.dev === file.identity.dev && current.ino === file.identity.ino) await fs.unlink(path.join(directory, file.name));
    }
    throw error;
  } finally { await Promise.all(reserved.map(file => file.handle.close())); }
}

export async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  if (args.help) { process.stdout.write(`${usage}\n`); return; }
  const directory = path.resolve(args.directory); const suite = path.join(root, 'evals/biodesign-eval-v1');
  const frozen = await verifyFrozenSuite(suite);
  const cases = (await fs.readFile(path.join(suite, 'cases.jsonl'), 'utf8')).trim().split('\n').map((line, i) => parseStrictJson(line, `case line ${i + 1}`));
  const names = (await fs.readdir(directory)).filter(name => /^\d\d-.*\.json$/.test(name)).sort();
  const inputPaths = [path.join(directory, 'selection.json'), ...names.map(name => path.join(directory, name)), ...(args['numeric-extractions'] ? [path.resolve(args['numeric-extractions'])] : [])];
  const raw = await Promise.all(inputPaths.map(file => fs.readFile(file))); const docs = raw.map((bytes, i) => parseStrictJson(bytes.toString('utf8'), inputPaths[i]));
  const metadata = await captureMetadata(root);
  metadata.sourceObservationFiles = Object.fromEntries(names.map((name, i) => [name, sha256(raw[i + 1])]));
  metadata.selectionSHA256 = sha256(raw[0]); metadata.numericExtractionsSHA256 = args['numeric-extractions'] ? sha256(raw.at(-1)) : null;
  const baseline = assembleUiBaseline({ cases, observations: docs.slice(1, 1 + names.length), selection: docs[0], datasetHash: frozen.hash, metadata, runId: path.basename(directory), extractionDocument: args['numeric-extractions'] ? docs.at(-1) : { extractions: [] } });
  const json = value => `${JSON.stringify(value, null, 2)}\n`; const baselineText = json(baseline);
  const { config, summary, pairwise } = baseline; const { latency, cost, deterministic } = summary;
  const artifacts = Object.fromEntries(Object.entries({ config, summary, latency, cost, pairwise, 'deterministic-scores': deterministic, 'retrieval-scores': { measured: false, reason: 'UI persisted citation/context IDs are not raw ranked retrieval.' } }).map(([name, value]) => [`${name}.json`, json(value)]));
  Object.assign(artifacts, { 'cases.jsonl': baseline.observations.map(o => JSON.stringify(o)).join('\n') + '\n', 'baseline.sha256': sha256(baselineText) + '\n', 'baseline.json': baselineText });
  const reread = await Promise.all(inputPaths.map(file => fs.readFile(file)));
  requireValue(reread.every((bytes, i) => sha256(bytes) === sha256(raw[i])), 'Observation, selection or extraction inputs changed during assembly');
  await writeUiArtifacts(directory, artifacts);
  process.stdout.write(JSON.stringify({ observations: baseline.observations.length, uniqueCases: baseline.testCases.length, deterministic: { pass: deterministic.exactCases, scored: deterministic.evaluatedCases }, latency: latency.all }) + '\n');
  return baseline;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch(error => { process.stderr.write(`UI summary rejected: ${error.message}\n`); process.exitCode = 1; });
}
