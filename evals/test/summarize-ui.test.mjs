import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assembleUiBaseline, parseArgs, UI_SCORE_VERSION, writeUiArtifacts } from '../summarize-ui.mjs';
import { compareReports, SCORE_VERSION } from '../lib/scoring.mjs';

// Entirely synthetic. Importing the summarizer never assembles a real lane.
function fixture() {
  const answer = 'Mean titer for strain A was 12 g/L; source rows r1 and r2.';
  const cases = [
    { id: 'n1', query: 'Report strain A mean titer.', split: 'dev', domain: 'synthetic', gold: { entries: [{ name: 'mean', value: 12, tolerance: 0, unit: 'g/L', field: 'titer', aggregation: 'mean', filters: { strain: ['A'] }, groupBy: [], sourceRows: ['r1', 'r2'] }] } },
    { id: 's1', query: 'Explain the source limitations.', split: 'heldout', domain: 'synthetic', gold: { entries: [] } },
  ];
  const observation = (caseId, repeat, index) => {
    const cacheState = index === 0 ? 'cold' : 'warm';
    const start = Date.parse('2026-09-07T12:00:00.000Z') + index * 10000;
    return { caseId, repeat, datasetHash: 'frozen-synthetic-hash', status: 'completed', executionMode: 'live-electron-side-chat-ui', cacheState,
      timing: { latencyMs: (index + 1) * 1000, cacheState },
      actual: { answer: { text: answer, citations: [] }, storedConversation: { messages: [
        { role: 'user', content: cases.find(c => c.id === caseId).query, createdAt: new Date(start).toISOString() },
        { role: 'assistant', content: answer, createdAt: new Date(start + (index + 1) * 1000).toISOString() },
      ] } }, telemetry: index === 0 ? { cloudCalls: { generation: 1 } } : null,
    };
  };
  const observations = [observation('n1', 0, 0), observation('s1', 0, 1), observation('n1', 1, 2)];
  const entry = { name: 'mean', answerSpan: 'Mean titer for strain A was 12 g/L', value: 12, unit: 'g/L', field: 'titer', aggregation: 'mean', filters: { strain: ['A'] }, filterSpans: { strain: 'strain A' }, groupBy: [], sourceRows: ['r2', 'r1'] };
  return { cases, observations, datasetHash: 'frozen-synthetic-hash', selection: { caseIds: ['n1', 's1'], repeatCaseIds: ['n1'], timestamp: '2026-09-07T11:00:00.000Z', selectedBeforeAnyLiveOutput: true },
    extractionDocument: { extractions: [0, 1].map(repeat => ({ caseId: 'n1', repeat, method: 'Literal synthetic test extraction', entries: [structuredClone(entry)] })) },
  };
}

test('UI summary uses first chronological cold request and shared-warm remainder, preserves unknown cost and reports case clusters', () => {
  const input = fixture(); const original = JSON.stringify(input);
  input.observations.reverse();
  const result = assembleUiBaseline(input);
  assert.equal(result.summary.scoreVersion, UI_SCORE_VERSION);
  assert.equal(result.summary.latency.cold.n, 1); assert.equal(result.summary.latency.cold.meanMs, 1000);
  assert.equal(result.summary.latency.warm.n, 2); assert.equal(result.summary.latency.warm.meanMs, 2500);
  assert.equal(result.summary.latency.firstVisibleResponseMs, null);
  assert.equal(result.summary.cost.savedLogicalRoleCounts.generation, 1);
  assert.equal(result.summary.cost.roleObservationCoverage.generation, 1);
  assert.equal(result.summary.cost.actualFcRequests, null);
  assert.equal(result.summary.deterministic.exactAccuracy, 1);
  assert.equal(result.summary.deterministic.caseClusterAccuracy.clusters, 1);
  assert.equal(result.summary.deterministic.caseClusterAccuracy.n, 2);
  assert.equal(result.summary.deterministic.caseClusterAccuracy.ci95, null);
  assert.equal(result.summary.releaseEligible, false); assert.doesNotMatch(result.summary.releaseReason, /failed/);
  input.observations.reverse(); assert.equal(JSON.stringify(input), original);
});

test('UI selection and frozen conversation integrity reject incomplete identities, altered answers, timestamps and false cold labels', () => {
  const variants = [
    x => x.observations.pop(), x => { x.observations[2].repeat = 0; },
    x => { x.selection.repeatCaseIds = ['s1']; }, x => { x.selection.selectedBeforeAnyLiveOutput = false; },
    x => { x.selection.timestamp = '2026-09-08T12:00:00.000Z'; },
    x => { x.observations[0].actual.answer.text = 'Altered'; },
    x => { x.observations[0].actual.storedConversation.messages[0].content = 'Wrong question'; },
    x => { x.observations[0].timing.latencyMs = -1; },
    x => { x.observations[1].cacheState = 'cold'; x.observations[1].timing.cacheState = 'cold'; },
    x => { x.observations[0].telemetry.cloudCalls.generation = '1'; },
  ];
  for (const change of variants) { const input = fixture(); change(input); assert.throws(() => assembleUiBaseline(input)); }
});

test('numeric extraction preserves actual arithmetic and exact spans, rejects duplicate/unknown extraction records', () => {
  const variants = [
    x => { x.extractionDocument.extractions[0].entries[0].answerSpan = ''; },
    x => { x.extractionDocument.extractions[0].entries[0].answerSpan = 'invented'; },
    x => { x.extractionDocument.extractions[0].entries[0].value = 999; },
    x => { x.extractionDocument.extractions[0].declaredAbsenceSpan = 'not present'; },
    x => { x.extractionDocument.extractions.push(x.extractionDocument.extractions[0]); },
    x => { x.extractionDocument.extractions[0].caseId = 'unknown'; },
    x => { x.extractionDocument.extractions[0].entries.push(x.extractionDocument.extractions[0].entries[0]); },
    x => { x.extractionDocument.extractions[0].entries[0].name = 'not requested'; },
  ];
  for (const change of variants) { const input = fixture(); change(input); assert.throws(() => assembleUiBaseline(input)); }
  const wrong = fixture();
  wrong.observations[0].actual.answer.text = wrong.observations[0].actual.answer.text.replace('12', '10');
  wrong.observations[0].actual.storedConversation.messages[1].content = wrong.observations[0].actual.answer.text;
  wrong.extractionDocument.extractions[0].entries[0].answerSpan = wrong.extractionDocument.extractions[0].entries[0].answerSpan.replace('12', '10');
  wrong.extractionDocument.extractions[0].entries[0].value = 10;
  const result = assembleUiBaseline(wrong);
  assert.equal(result.summary.deterministic.cases[0].details[0].dimensions.value, false);
  assert.equal(result.summary.deterministic.exactAccuracy, .5);
  assert.match(result.summary.releaseReason, /1 audited numeric observation\(s\) failed/);
});

test('array-valued filters compare structurally while extra/unknown filters, missing grouping and unobserved rows never pass', () => {
  const dimensions = input => assembleUiBaseline(input).summary.deterministic.cases[0].details[0].dimensions;
  assert.equal(dimensions(fixture()).filters, true);
  for (const field of ['filters', 'filterSpans', 'groupBy']) {
    const input = fixture(); delete input.extractionDocument.extractions[0].entries[0][field];
    input.extractionDocument.extractions[0].entries[0].sourceRows = [];
    assert.equal(dimensions(input)[field === 'filterSpans' ? 'filters' : field], false);
  }
  const extra = fixture(); extra.extractionDocument.extractions[0].entries[0].filters.valid = true;
  assert.equal(dimensions(extra).filters, false);
  const rows = fixture();
  rows.observations[0].actual.answer.text = 'Mean titer for strain A was 12 g/L.';
  rows.observations[0].actual.storedConversation.messages[1].content = rows.observations[0].actual.answer.text;
  assert.equal(dimensions(rows).sourceRows, false);
  rows.observations[0].actual.answer.citations = [{ sourceRows: ['r1', 'r2'] }];
  assert.equal(dimensions(rows).sourceRows, true);
  rows.observations[0].actual.answer.citations = [{ sourceRows: ['r10', 'r20'] }];
  assert.equal(dimensions(rows).sourceRows, false, 'row ID prefixes are not exact provenance');
  rows.observations[0].actual.answer.citations = [{ sourceRows: ['r1', 'r2'] }];
  delete rows.extractionDocument.extractions[0].entries[0].filterSpans;
  rows.extractionDocument.extractions[0].entries[0].filters = {};
  const rowEvidence = assembleUiBaseline(rows).summary.deterministic.cases[0].details[0];
  assert.equal(rowEvidence.dimensions.filters, true);
  assert.equal(rowEvidence.filterEvidence, 'exact_cited_rowset');
  rows.extractionDocument.extractions[0].entries[0].filters = { strain: 'B' };
  assert.equal(dimensions(rows).filters, false);
});

test('unmeasured numeric audits remain null without fabricated failure or retrieval scores', () => {
  const input = fixture(); input.extractionDocument = { extractions: [] };
  const result = assembleUiBaseline(input);
  assert.equal(result.summary.deterministic.evaluatedCases, 0);
  assert.equal(result.summary.deterministic.exactAccuracy, null);
  assert.doesNotMatch(result.summary.releaseReason, /failed/);
  assert.ok(result.cases.every(row => Object.keys(row.metrics).length === 0));
});

test('UI report rows support same-UI comparison and prevent local scorer/mode comparisons from producing a quality delta', () => {
  const ui = assembleUiBaseline(fixture());
  const same = compareReports(ui, structuredClone(ui));
  assert.equal(same.scoreVersionComparable, true); assert.equal(same.comparablePairs, 3);
  assert.equal(same.passed, false, 'unknown security and grounding gates remain unknown');
  const local = structuredClone(ui); local.summary.scoreVersion = SCORE_VERSION;
  for (const row of local.cases) row.executionMode = 'protocol';
  const different = compareReports(local, ui);
  assert.equal(different.scoreVersionComparable, false); assert.equal(different.comparablePairs, 0);
  assert.equal(different.regressionRate, null);
});

test('all output names are reserved exclusively; collision cleanup never changes an existing artifact', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'ui-summary-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await writeFile(join(directory, 'baseline.sha256'), 'preserved');
  await assert.rejects(writeUiArtifacts(directory, { 'baseline.json': 'new report', 'baseline.sha256': 'new hash' }), { code: 'EEXIST' });
  assert.deepEqual(await readdir(directory), ['baseline.sha256']);
  assert.equal(await readFile(join(directory, 'baseline.sha256'), 'utf8'), 'preserved');
  await writeUiArtifacts(directory, { 'summary.json': 'new summary' });
  assert.equal(await readFile(join(directory, 'summary.json'), 'utf8'), 'new summary');
  await assert.rejects(writeUiArtifacts(directory, { '../escape.json': 'bad' }), /simple filenames/);
});

test('UI CLI argument parsing rejects misspellings, missing values and duplicate flags', () => {
  assert.deepEqual(parseArgs(['--directory', '/tmp/synthetic', '--numeric-extractions', '/tmp/numeric.json']), { directory: '/tmp/synthetic', 'numeric-extractions': '/tmp/numeric.json' });
  for (const args of [[], ['--directory'], ['--directory', 'x', '--directory', 'y'], ['--direcotry', 'x']]) assert.throws(() => parseArgs(args));
});
