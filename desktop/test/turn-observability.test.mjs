import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const api = require('../../shared/turn-observability.js');
const { TurnObserver } = require('../../docs/turn-observability.js');
const { SourcePreparationService } = require('../../docs/source-system.js');

test('usage distinguishes missing reports from zero and carries cumulative totals through checkpoint replay', () => {
  const usage = api.createUsage(null, { turnId: 't', model: 'selected', now: 100 });
  api.recordUsage(usage, { id: 't:request:1', sequence: 1, startedAt: 100, endedAt: 150, ok: true,
    usage: { prompt_tokens: 100, completion_tokens: 10, prompt_tokens_details: { cached_tokens: 80 } } });
  const resumed = api.createUsage(api.usageSnapshot(usage), { turnId: 't', model: 'selected', now: 900 });
  assert.equal(api.recordUsage(resumed, { id: 't:request:1', sequence: 1, usage: { prompt_tokens: 100 } }), false);
  api.recordUsage(resumed, { id: 't:request:2', sequence: 2, startedAt: 900, endedAt: 910, ok: false });
  const summary = api.usageSnapshot(resumed);
  assert.deepEqual(summary.totals, { inputTokens: 100, outputTokens: 10, cachedTokens: 80, totalTokens: 110 });
  assert.equal(summary.coverage.requests, 2); assert.equal(summary.coverage.inputTokens, 1);
  assert.equal(summary.generationMs, 60); assert.equal(summary.complete, false);
  assert.equal(summary.rounds[1].inputTokens, null);
  assert.equal(api.normalizeTokens({ prompt_tokens: 0, completion_tokens: 0 }).inputTokens, 0);
  assert.equal(api.normalizeTokens({ input_tokens: 3, input_tokens_details: { cached_tokens: 8 } }).cachedTokens, null);
});

test('concurrent dispatch completion is deduplicated without losing earlier requests', () => {
  const usage = api.createUsage(null, { turnId: 'concurrent' });
  api.recordUsage(usage, { id: 'r2', sequence: 2, usage: { input_tokens: 20 } });
  api.recordUsage(usage, { id: 'r1', sequence: 1, usage: { input_tokens: 10 } });
  assert.equal(usage.committedThrough, 2); assert.equal(usage.totals.inputTokens, 30);
  assert.equal(api.recordUsage(usage, { id: 'duplicate', sequence: 2, usage: { input_tokens: 20 } }), false);
});

test('usage history stays bounded while old reported totals remain and unknown retry cost remains explicit', () => {
  const usage = api.createUsage(null, { turnId: 'long' });
  for (let i = 1; i <= 100; i++) api.recordUsage(usage, { id: 'r' + i, sequence: i, attempts: i === 100 ? 2 : 1,
    usage: { input_tokens: 2, output_tokens: 1, input_tokens_details: { cached_tokens: 0 } } });
  assert.equal(usage.rounds.length, 64); assert.equal(usage.totals.inputTokens, 200);
  assert.equal(api.usageSnapshot(usage).complete, false); assert.equal(usage.coverage.attempts, 101);
});

test('host receipts are exact-once, metadata-only, and a terminal failure cannot regress to running', async () => {
  const observer = new TurnObserver({ turnId: 't', model: 'selected' });
  const call = { id: 'c', name: 'retrieve_project_evidence', args: { query: 'private' } };
  let runs = 0;
  const execute = async () => { runs++; return { id: 'c', result: { ok: false, error: 'SOURCE_OUTSIDE_SCOPE', private: 'secret' } }; };
  await Promise.all([observer.runTool(call, execute), observer.runTool(call, execute)]);
  assert.equal(runs, 1);
  observer.event({ stage: 'tool-running', callId: 'c', capability: call.name });
  const details = observer.snapshot();
  assert.equal(details.activities.length, 1); assert.equal(details.activities[0].status, 'failed');
  assert.equal(details.activities[0].summary.code, 'SOURCE_OUTSIDE_SCOPE');
  assert(!JSON.stringify(details).includes('secret')); assert(!JSON.stringify(details).includes('private'));
  await assert.rejects(observer.runTool({ ...call, args: {} }, execute), { code: 'INVALID_TOOL_CONTINUATION' });
});

test('line diffs retain insert/delete attribution and bound pathological edits', () => {
  const diff = api.diffLines('heading\nold\nend', 'heading\nnew\nextra\nend');
  assert.equal(diff.added, 2); assert.equal(diff.removed, 1);
  assert.deepEqual(diff.rows.map(row => [row.type, row.oldLine, row.newLine]), [['remove', 2, null], ['add', null, 2], ['add', null, 3]]);
  const big = api.diffLines(Array.from({ length: 2000 }, (_, i) => 'a' + i).join('\n'), Array.from({ length: 2000 }, (_, i) => 'b' + i).join('\n'));
  assert.equal(big.replacement, true); assert.equal(big.rows.length, 400); assert.equal(big.truncated, true);
  assert.equal(api.diffLines('same', 'same').unchanged, true);
});

test('diffs are recorded only after successful permitted host writes, never from cloud status text', async () => {
  const observer = new TurnObserver({ turnId: 't' });
  observer.event({ stage: 'artifact-written', artifact: { origin: 'host-write', path: '.biodesign/knowledge/fake.md', diff: {} } });
  assert.equal(observer.snapshot().artifacts.length, 0);
  const input = { path: 'results/report.md', before: 'a', after: 'b', operationId: 'save', permission: 'workspace_write' };
  await assert.rejects(observer.writeArtifact({ ...input, permission: 'read_only' }, async () => {}), { code: 'ARTIFACT_DIFF_NOT_AUTHORIZED' });
  await assert.rejects(observer.writeArtifact({ ...input, operationId: 'failed' }, async () => { throw new Error('disk'); }));
  assert.equal(observer.snapshot().artifacts.length, 0);
  await observer.writeArtifact(input, async () => 'saved');
  assert.equal(observer.snapshot().artifacts.length, 1);
  assert.equal(observer.snapshot().artifacts[0].diff.removed, 1);
});

test('existing readonly-derived cache writes emit actual diffs without granting source editing', async () => {
  const files = new Map(), observer = new TurnObserver({ turnId: 'derive' });
  const workspace = { fileExists: async path => files.has(path), readFile: async path => new Blob([files.get(path)]),
    writeFile: async (path, value) => files.set(path, value) };
  const preparation = new SourcePreparationService({ workspace });
  const source = { sourceId: 'paper-a', contentHash: 'abc', path: 'literature/A.pdf' };
  const context = { surface: 'side_chat', permission: 'read_only', onProgress: event => observer.hostEvent(event) };
  await preparation.refreshPaperCardKnowledge(source, { title: 'First', summary: 'Original finding' }, context);
  await preparation.refreshPaperCardKnowledge(source, { title: 'Second', summary: 'Changed finding' }, context);
  const artifacts = observer.snapshot().artifacts;
  assert.equal(artifacts.length, 2); assert.equal(artifacts[0].path, '.biodesign/knowledge/paper_cards/paper-a.md');
  assert.equal(artifacts[0].diff.removed, 0);
  assert(artifacts[1].diff.removed > 0); assert(artifacts[1].diff.added > 0);
  assert([...files.keys()].every(path => path.startsWith('.biodesign/knowledge/')));
  workspace.writeFile = async () => { throw new Error('disk failure'); };
  await assert.rejects(preparation.refreshPaperCardKnowledge(source, { title: 'Third' }, context));
  assert.equal(observer.snapshot().artifacts.length, 2);
});

test('persisted details reject malformed artifacts and stay below the independent storage bound', () => {
  const raw = { version: 1, turnId: 't', activities: [null, { stage: 'tool-completed', callId: 'safe', summary: { secret: 'hidden' } }],
    artifacts: [{ origin: 'host-write', id: 'bad', path: '../../secret', diff: { rows: [] } },
      ...Array.from({ length: 20 }, (_, i) => ({ origin: 'host-write', id: 'artifact' + i, path: `results/${i}.md`, diff: { rows: [{ type: 'add', content: 'x'.repeat(70000), newLine: 1 }], added: 1 } }))] };
  const details = api.normalizeDetails(raw);
  assert(JSON.stringify(details).length <= 200000); assert(!JSON.stringify(details).includes('hidden'));
  assert(details.artifacts.every(item => !item.path.includes('..')));
  assert.equal(api.normalizeDetails({}), null);
});

test('observing a derived artifact cannot redirect a pending write to a switched project', async () => {
  const original = {}, replacement = {}; let writes = 0;
  const workspace = { workspace: original, fileExists: async () => { workspace.workspace = replacement; return false; },
    writeFile: async () => { writes++; } };
  const preparation = new SourcePreparationService({ workspace });
  await assert.rejects(preparation.refreshPaperCardKnowledge({ sourceId: 'paper' }, { title: 'Review' }, { onProgress() {} }), { code: 'OPERATION_ABORTED' });
  assert.equal(writes, 0);
});
