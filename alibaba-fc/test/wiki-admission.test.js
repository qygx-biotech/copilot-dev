'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { createFixture } = require('./helpers/preflight-fixture.js');
const { automaticPageCeiling } = require('../../docs/literature-wiki.js');
const { createRuntimeLogger } = require('../../docs/runtime-log.js');
const contract = require('../../shared/literature-wiki.js');
const model = 'google/gemma-4-31b-it';
const clone = value => JSON.parse(JSON.stringify(value));
async function fixture(n = 4, options = {}) {
  const f = await createFixture(options);
  if (!options.workspace) for (let i = 0; i < n; i++) f.workspace.set(`literature/p${i}.pdf`, `Current evidence on enzyme engineering and thermostability in study ${i}.`);
  if (options.labels) f.system.topicService.labelsFromCard = () => options.labels;
  f.wiki = f.system.literatureWiki; f.requests = [];
  f.wiki.getPaperCardConfiguration = async (_signal, context) => ({ schemaVersion: 2, promptVersion: 'fixture-v1', modelSignature: 'fixture-model', wikiConfiguration: contract.configuration(context?.model || model) });
  f.wiki.generateWikiPage = async input => {
    f.requests.push(clone(input));
    assert.equal(input.configuration.modelSignature, model);
    if (options.failWiki) throw Object.assign(new Error('Fixture provider failure'), { code: 'PROVIDER_UNAVAILABLE', attempts: 1 });
    return { configuration: input.configuration, attempts: 1,
      page: contract.markdownPage(input.papers.map(paper => `${paper.evidence[0].text} [[cite:${paper.evidence[0].reference}]]`).join('\n\n')) };
  };
  f.run = (id, extra = {}) => f.pipeline.preflight({ turnId: id, surface: 'side_chat', question: 'Explain these papers.', callContext: { model }, ...extra });
  return f;
}
function candidate(f, id, label, paperIds) {
  const topic = { topicId: id, label, pageKind: 'concept', paperIds, parentTopicIds: [], summaryStatus: 'stale' };
  f.system.topicService.topics.push(topic); return topic;
}
const reserved = f => f.system.topicService.topics.filter(topic => topic.wikiAdmission);

test('automatic page ceiling formula includes boundaries and saturation', () => {
  for (const [n, expected] of [[0,0],[1,0],[2,3],[4,3],[12,3],[13,4],[20,5],[40,10],[80,20],[119,30],[120,30],[500,30]])
    assert.equal(automaticPageCeiling(n), expected, String(n));
});

test('zero/one-paper projects never fill thin Wiki pages; failed Cards still count as project papers', async () => {
  for (const n of [0,1,20]) {
    const f = await fixture(n, { cardFailure: () => n === 20 });
    const result = await f.run(`count-${n}`);
    assert.equal(result.wikiMaintenance.admission.projectPaperCount, n);
    assert.equal(result.wikiMaintenance.admission.automaticPageCeiling, automaticPageCeiling(n));
    assert.equal(result.wikiMaintenance.generationCalls, 0);
    assert.equal(reserved(f).length, 0);
    if (n === 1) assert.ok(result.wikiMaintenance.admission.deferredReasons.insufficient_support > 0);
    if (n === 20) assert.equal(f.system.registry.list().filter(source => source.parseStatus === 'ready').length, 20);
  }
});

test('initial admission is capped, distinct topics sharing papers remain distinct, and concurrent requests cannot multiply reservations', async () => {
  const f = await fixture();
  const runs = await Promise.all([f.run('a'), f.run('b')]);
  assert.equal(f.requests.length, 3);
  assert.equal(reserved(f).length, 3);
  assert.deepEqual(reserved(f).map(topic => topic.topicId).sort(), ['ectd', 'enzyme-engineering', 'thermostability']);
  assert.equal(runs[0].wikiMaintenance.admission.existingReservedPageCount, 0);
  assert.ok(runs.every(run => run.wikiMaintenance.admission.totalReservedPageCount === 3));
  assert.equal(runs[0].wikiMaintenance.admission.remainingHeadroom, 0);
  assert.equal(runs[0].wikiMaintenance.admission.deferredReasons.page_ceiling, 1);
  const saved = await f.workspace.readJson('.biodesign/knowledge/topics/index.json');
  assert.equal(saved.topics.filter(topic => topic.wikiAdmission).length, 3);
  const cards = f.calls.cards, parses = f.calls.parses;
  await f.run('unchanged');
  assert.equal(f.requests.length, 3); assert.equal(f.calls.cards, cards); assert.equal(f.calls.parses, parses);
  assert.ok(f.workspace.writes.every(path => path.startsWith('.biodesign/')));
  assert.deepEqual(f.workspace.state.agent.currentRecommendation, { id: 'R1' });
});

test('failed reservations survive restarts and additional candidates without replacement generation', async () => {
  const f = await fixture(4, { failWiki: true }); await f.run('fail');
  const ids = reserved(f).map(topic => topic.topicId).sort();
  for (let i = 0; i < 12; i++) candidate(f, `candidate-${i}`, `Different concept ${i}`, reserved(f)[0].paperIds);
  await f.system.topicService.persist();
  const restarted = await fixture(4, { workspace: f.workspace });
  const result = await restarted.run('restart');
  assert.equal(restarted.requests.length, 0); assert.equal(restarted.calls.cards, 0); assert.equal(restarted.calls.parses, 0);
  assert.deepEqual(reserved(restarted).map(topic => topic.topicId).sort(), ids);
  assert.equal(result.wikiMaintenance.admission.existingReservedPageCount, 3);
  assert.equal(result.wikiMaintenance.admission.deferredReasons.page_ceiling, 13);
  assert.ok(reserved(restarted).every(topic => topic.wikiMaintenance.lastFailure.code === 'PROVIDER_UNAVAILABLE'));
});

test('clear label variants prefer an existing page; admission, missing pages, model changes and restart do not authorize generation', async () => {
  const f = await fixture(2, { labels: ['Thermostability'] }); await f.run('seed');
  const base = reserved(f)[0];
  candidate(f, 'alias-id', '  THERMOSTABILITY  ', base.paperIds);
  candidate(f, 'new-method', 'Distinct mechanism', base.paperIds);
  const result = await f.wiki.maintain({ callContext: { model: 'different-selected-model' } });
  assert.equal(result.generationCalls, 0);
  assert.equal(result.admission.admittedCandidateCount, 1);
  assert.equal(result.admission.deferredReasons.redundant_candidate, 1);
  assert.equal(result.admission.remainingHeadroom, 1, 'ceiling is not a target');
  assert.equal(f.system.topicService.topics.find(topic => topic.topicId === 'new-method').wikiEvidence.eligibleFingerprint, null);
  const restarted = await fixture(2, { workspace: f.workspace }); await restarted.run('restart');
  assert.equal(restarted.requests.length, 0);
  assert.equal(reserved(restarted).length, 2);
});

test('legacy pages over the ceiling are preserved and eligible updates still run; explicit creation uses headroom', async () => {
  const f = await fixture(2); await f.run('seed');
  // Seed a valid historical fourth page, as produced before admission was unified.
  const base = reserved(f)[0], legacy = { ...clone(base), topicId: 'legacy-distinct-subject', label: 'Legacy distinct subject' };
  const record = await f.wiki.read(base); record.pageId = legacy.topicId;
  legacy.wiki.path = `.biodesign/knowledge/wiki_pages/${legacy.topicId}/legacy.json`;
  await f.workspace.writeJson(legacy.wiki.path, record); f.system.topicService.topics.push(legacy);
  const explicit = await f.wiki.maintain({ action: 'update', callContext: { model } });
  assert.equal(explicit.admission.existingReservedPageCount, 4);
  assert.equal(explicit.admission.admittedCandidateCount, 0);
  assert.equal(explicit.admission.remainingHeadroom, 0);
  const pages = reserved(f); assert.ok(pages.every(topic => topic.wiki));
  const pointers = pages.map(topic => [topic.topicId, clone(topic.wiki)]);
  for (const topic of pages) delete topic.wikiAdmission; // pre-admission saved index
  candidate(f, 'fresh-topic', 'New distinct topic', pages[0].paperIds);
  await f.system.topicService.persist();
  const restarted = await fixture(2, { workspace: f.workspace });
  const unchanged = await restarted.run('over-limit');
  assert.equal(unchanged.wikiMaintenance.admission.existingReservedPageCount, 4);
  assert.equal(restarted.requests.length, 0);
  for (const [id, pointer] of pointers) assert.deepEqual(restarted.system.topicService.topics.find(topic => topic.topicId === id).wiki, pointer);
  const labels = restarted.system.topicService.labelsFromCard.bind(restarted.system.topicService);
  restarted.system.topicService.labelsFromCard = card => [...labels(card), 'Legacy distinct subject'];
  restarted.workspace.set('literature/p0.pdf', 'Changed raw enzyme engineering evidence with revised thermostability results.', Date.now() - 1000);
  const changed = await restarted.run('changed');
  assert.equal(changed.wikiMaintenance.generationCalls, 4);
  assert.equal((await restarted.run('changed-remainder')).wikiMaintenance.generationCalls, 0);
  assert.equal(reserved(restarted).length, 4);
  assert.ok(restarted.requests.every(input => pointers.some(([id]) => id === input.pageId)));
  assert.ok(restarted.system.topicService.topics.find(topic => topic.topicId === 'fresh-topic') && !restarted.system.topicService.topics.find(topic => topic.topicId === 'fresh-topic').wikiAdmission);
});

test('project-wide count does not widen hard-selected generation, including explicit operations', async () => {
  const labels = ['Concept A', 'Concept B', 'Concept C', 'Concept D', 'Concept E', 'Concept F'];
  const f = await fixture(20, { labels });
  f.system.topicService.labelsFromCard = card => ['p0.pdf', 'p1.pdf'].includes(card.fileName) ? labels : [];
  const run = await f.run('selected', { selectedPaths: ['literature/p0.pdf', 'literature/p1.pdf'] });
  assert.equal(run.wikiMaintenance.admission.projectPaperCount, 20);
  assert.equal(run.wikiMaintenance.admission.automaticPageCeiling, 5);
  assert.equal(f.requests.length, 5);
  await f.run('selected-remainder', { selectedPaths: ['literature/p0.pdf', 'literature/p1.pdf'] });
  assert.equal(f.requests.length, 5);
  const ids = ['literature/p0.pdf', 'literature/p1.pdf'].map(path => f.system.registry.getByPath(path).sourceId);
  assert.ok(f.requests.every(input => input.papers.length === 2 && input.papers.every(paper => ids.includes(paper.paperId))));
  const denied = await f.wiki.maintain({ action: 'update', hardSelection: true, paperIds: [], callContext: { model } });
  assert.equal(denied.generationCalls, 0);
  const explicit = await f.wiki.maintain({ action: 'incorporate', analysisRequest: 'Concept F', hardSelection: true, paperIds: ids, callContext: { model } });
  // The existing subject matcher may match multiple concept labels; scope is still hard.
  assert.equal(explicit.admission.admittedCandidateCount, 0);
  assert.ok(explicit.pages.some(page => page.pageId === 'concept-f' && page.reason === 'page_ceiling'));
  assert.ok(f.requests.every(input => input.papers.every(paper => ids.includes(paper.paperId))));
});

test('admission cannot cross the provider boundary when reservation persistence fails', async () => {
  const f = await fixture(2, { labels: ['Thermostability'] }); await f.run('seed');
  candidate(f, 'unreserved', 'New method', reserved(f)[0].paperIds);
  const persist = f.system.topicService.persist.bind(f.system.topicService);
  f.system.topicService.persist = async () => {
    if (f.system.topicService.topics.find(topic => topic.topicId === 'unreserved').wikiAdmission) throw new Error('Storage failure');
    return persist();
  };
  await assert.rejects(f.wiki.maintain({ changedPaperIds: reserved(f)[0].paperIds, callContext: { model } }), /Storage failure/);
  assert.equal(f.requests.length, 1);
  assert.equal(reserved(f).length, 1);
});

test('admission logs only safe counts and fixed reasons', async () => {
  const f = await fixture();
  const log = createRuntimeLogger({ sink: null, heartbeatMs: 0 }); f.pipeline.log = log;
  await f.run('observability');
  const event = log.entries().find(entry => entry.event === 'wiki.admission');
  assert.equal(event.details.projectPaperCount, 4);
  assert.equal(event.details.automaticPageCeiling, 3);
  assert.equal(event.details.existingReservedPageCount, 0);
  assert.equal(event.details.totalReservedPageCount, 3);
  assert.equal(event.details.rejectedCandidateCount, 1);
  assert.equal(log.entries().find(entry => entry.event === 'wiki.admission-outcome').details.reason, 'page_ceiling');
  assert.doesNotMatch(log.exportText(), /Current evidence|enzyme engineering|literature\/p/);
});

test('orthographic aliases deduplicate but chemical charge and comparison pages stay distinct', async () => {
  const f = await fixture(20, { labels: ['enzyme engineering'] }); await f.run('seed');
  const ids = reserved(f)[0].paperIds, existing = reserved(f).length;
  candidate(f, 'orthographic', 'Enzyme—engineering', ids);
  candidate(f, 'nad', 'NAD', ids);
  candidate(f, 'nad-plus', 'NAD+', ids);
  const comparison = candidate(f, 'comparison', 'enzyme engineering', ids); comparison.pageKind = 'comparison';
  const result = await f.wiki.maintain();
  assert.equal(result.admission.deferredReasons.redundant_candidate, 1);
  assert.equal(result.admission.admittedCandidateCount, 3);
  assert.equal(result.generationCalls, 0, 'new labels/admission cannot authorize a provider call');
  assert.equal(reserved(f).length, existing + 3);
});

test('reconciled deletion reduces project count without deleting saved Wiki pages or freeing reservations', async () => {
  const f = await fixture(2); await f.run('seed');
  const saved = reserved(f).map(topic => ({ id: topic.topicId, pointer: clone(topic.wiki) }));
  f.workspace.files.delete('literature/p1.pdf');
  const result = await f.run('deleted');
  assert.equal(result.wikiMaintenance.admission.projectPaperCount, 1);
  assert.equal(result.wikiMaintenance.admission.automaticPageCeiling, 0);
  assert.equal(result.wikiMaintenance.admission.existingReservedPageCount, 3);
  assert.equal(result.wikiMaintenance.generationCalls, 0);
  for (const { id, pointer } of saved) {
    const topic = f.system.topicService.topics.find(topic => topic.topicId === id);
    assert.deepEqual(topic.wiki, pointer);
    assert.ok(await f.workspace.fileExists(pointer.path));
    assert.equal(await f.wiki.readForUse(topic), null, 'deleted-source knowledge cannot be reused as current');
  }
});

test('explicit and automatic requests use the same evidence, duplicate and ceiling checks', async () => {
  const snapshots = [];
  for (const action of [undefined, 'update']) {
    const f = await fixture(2, { labels: ['Thermostability'] }); await f.run('seed');
    const base = reserved(f)[0], ids = base.paperIds;
    candidate(f, 'thin', 'Thin topic', [ids[0]]);
    candidate(f, 'alias', ' THERMOSTABILITY ', ids);
    candidate(f, 'missing', 'Missing evidence', [ids[0], 'absent']);
    candidate(f, 'overscope', 'Too many papers', Array(21).fill(ids[0]));
    candidate(f, 'valid-a', 'Distinct A', ids); candidate(f, 'valid-b', 'Distinct B', ids); candidate(f, 'valid-c', 'Distinct C', ids);
    const result = await f.wiki.maintain({ action, callContext: { model } });
    snapshots.push(result.pages.filter(p => p.stage === 'admission').map(p => [p.pageId, p.reason]).sort());
    assert.equal(result.admission.existingReservedPageCount, 1);
    assert.equal(result.admission.admittedCandidateCount, 2);
    assert.equal(result.admission.totalReservedPageCount, 3);
    assert.equal(result.counts.rejected, 5);
    assert.equal(result.automaticRetryScheduled, false);
    assert.ok(f.requests.every(r => !['thin', 'alias', 'missing', 'overscope', 'valid-c'].includes(r.pageId)));
    assert.ok(result.pages.some(p => p.pageId === 'thin' && p.reason === 'insufficient_support'));
  }
  assert.deepEqual(snapshots[0], snapshots[1]);
});

test('admission runs the exact input builder before reserving a page and preserves original data', async () => {
  for (const action of [undefined, 'update']) {
    const f = await fixture(2, { labels: ['Thermostability'] }); await f.run('seed');
    const base = reserved(f)[0], original = await f.wiki.read(base), path = base.wiki.path;
    const artifact = await f.system.preparation.readPaperArtifact(base.paperIds[0]);
    const topic = candidate(f, 'bad-input', 'Input too large', base.paperIds);
    topic.wikiMaintenance = { analysisRequest: 'x'.repeat(2001) };
    const before = f.requests.length;
    const result = await f.wiki.maintain({ action, callContext: { model } });
    assert.equal(result.pages.find(p => p.pageId === topic.topicId).reason, 'input_size_limit');
    assert.equal(topic.wikiAdmission, undefined);
    assert.equal(result.admission.admittedCandidateCount, 0);
    assert.equal(f.requests.length, before);
    assert.deepEqual(await f.workspace.readJson(path), original);
    assert.deepEqual(await f.system.preparation.readPaperArtifact(base.paperIds[0]), artifact);
  }
});

test('readiness and provenance failures are caught before generation even for reserved pages', async () => {
  const f = await fixture(2, { labels: ['Thermostability'] }); await f.run('seed');
  const base = reserved(f)[0], pointer = clone(base.wiki), source = f.system.registry.get(base.paperIds[0]);
  const before = f.requests.length;
  source.hashStatus = 'stale';
  let result = await f.wiki.maintain({ action: 'update', callContext: { model } });
  assert.equal(result.pages[0].reason, 'source_not_ready');
  source.hashStatus = 'ready'; f.workspace.set(source.path, 'Changed bytes awaiting reconciliation.');
  result = await f.wiki.maintain({ action: 'update', callContext: { model } });
  assert.equal(result.pages[0].code, 'WIKI_SOURCE_CHANGED');
  assert.ok(result.pages[0].validationProblems.includes('stale-source'));
  assert.equal(f.requests.length, before); assert.deepEqual(base.wiki, pointer);
  assert.equal(result.admission.existingReservedPageCount, 1);
  assert.equal(result.admission.admittedCandidateCount, 0);
});

test('more than three eligible pages finish sequentially, and refreshes reuse their slots', async () => {
  const labels = ['Alpha', 'Beta', 'Gamma', 'Delta', 'Epsilon'];
  const f = await fixture(20, { labels });
  const first = await f.run('five');
  assert.equal(first.wikiMaintenance.counts.updated, 5);
  assert.equal(first.wikiMaintenance.generationCalls, 5);
  assert.equal(first.wikiMaintenance.admission.admittedCandidateCount, 5);
  const next = await f.wiki.maintain({ action: 'update', callContext: { model } });
  assert.equal(next.counts.reused, 5); assert.equal(next.generationCalls, 0);
  assert.equal(next.admission.existingReservedPageCount, 5); assert.equal(next.admission.admittedCandidateCount, 0);
  f.workspace.set('literature/p0.pdf', 'Changed authoritative evidence.', Date.now() - 1000);
  const refreshed = await f.run('refresh');
  assert.equal(refreshed.wikiMaintenance.generationCalls, 5);
  assert.equal(refreshed.wikiMaintenance.admission.admittedCandidateCount, 0);
  assert.equal(refreshed.wikiMaintenance.admission.totalReservedPageCount, 5);
  assert.equal(new Set(f.requests.slice(5).map(r => r.pageId)).size, 5);
});

test('deadline preserves completed pages, marks remaining work pending, and resumes fairly without a timer', async () => {
  const f = await fixture(20, { labels: ['Alpha', 'Beta', 'Gamma', 'Delta', 'Epsilon'] });
  let now = Date.now(), calls = 0;
  f.wiki.now = () => now;
  const generate = f.wiki.generateWikiPage;
  f.wiki.generateWikiPage = async (...args) => { calls++; const response = await generate(...args); now += 150000; return response; };
  // Give the scheduler measured 60s history so two 150s fixture responses reach the deadline.
  f.wiki.estimatedDuration = () => 60000;
  const run = await f.run('deadline');
  assert.equal(run.wikiMaintenance.generationCalls, 2);
  assert.equal(run.wikiMaintenance.counts.updated, 2);
  assert.equal(run.wikiMaintenance.counts.deferred, 3);
  assert.equal(run.wikiMaintenance.deadlineReached, true);
  assert.equal(run.wikiMaintenance.pendingPages.length, 3);
  assert.equal(run.wikiMaintenance.automaticRetryScheduled, false);
  const published = f.system.topicService.topics.filter(t => t.wiki).map(t => clone(t.wiki));
  await new Promise(resolve => setImmediate(resolve)); assert.equal(calls, 2);
  f.wiki.generateWikiPage = generate;
  const next = await f.run('resume');
  assert.equal(next.wikiMaintenance.counts.updated, 3); assert.equal(next.wikiMaintenance.counts.reused, 2);
  for (const pointer of published) assert.ok(await f.workspace.fileExists(pointer.path));
  assert.equal(new Set(f.requests.map(r => r.pageId)).size, 5);
});

test('unknown attempts and generation-versus-repair timing survive safe per-page logs', async () => {
  const f = await fixture(2, { labels: ['Thermostability'] });
  const logger = createRuntimeLogger({ sink: null, heartbeatMs: 0 }); f.pipeline.log = logger;
  const generate = f.wiki.generateWikiPage;
  f.wiki.generateWikiPage = async (...args) => {
    const result = await generate(...args); delete result.attempts;
    result.generationAudit = { calls: [{ stage: 'generation', durationMs: 40 }, { stage: 'repair', durationMs: 25 }], outputs: [] };
    return result;
  };
  const run = await f.run('unknown');
  assert.equal(run.wikiMaintenance.providerAttempts, null);
  assert.equal(run.wikiMaintenance.knownProviderAttempts, 0);
  assert.equal(run.wikiMaintenance.unknownProviderAttempts, 1);
  const entry = logger.entries().find(e => e.event === 'wiki.page-outcome');
  assert.equal(entry.details.pageId, 'thermostability'); assert.equal(entry.details.providerAttemptsKnown, false);
  assert.equal(entry.details.providerAttempts, null);
  assert.equal(entry.details.initialGenerationMs, 40); assert.equal(entry.details.repairMs, 25);
  assert.equal(entry.details.stage, 'publication');
  assert.doesNotMatch(logger.exportText(), /Current evidence on|Bearer|rawPage|literature\/p/);
});

test('missing compatible cards or invalid evidence cannot pass admission in either mode', async () => {
  for (const mode of ['card', 'evidence']) for (const action of [undefined, 'update']) {
    const f = await fixture(2, { labels: ['Thermostability'] }); await f.run('seed');
    const base = reserved(f)[0], old = await f.wiki.read(base), before = f.requests.length;
    if (mode === 'card') f.wiki.corpusWorkflows.readValidPaperCardForCorpusMap = async () => null;
    else {
      const read = f.wiki.preparation.readPaperArtifact.bind(f.wiki.preparation);
      f.wiki.preparation.readPaperArtifact = async (...args) => ({ ...await read(...args), chunks: [] });
    }
    const result = await f.wiki.maintain({ action, callContext: { model } });
    assert.equal(result.pages[0].code, mode === 'card' ? 'WIKI_COMPATIBLE_CARD_REQUIRED' : 'WIKI_INVALID_EVIDENCE');
    assert.equal(f.requests.length, before);
    assert.deepEqual(await f.wiki.read(base), old);
    assert.equal(result.admission.admittedCandidateCount, 0);
  }
});

test('configuration waiting consumes the original maintenance deadline and never dispatches generation', async () => {
  const f = await fixture(2, { labels: ['Thermostability'] }); await f.run('seed');
  let now = Date.now(); f.wiki.now = () => now;
  const before = f.requests.length;
  f.wiki.getPaperCardConfiguration = () => new Promise(() => {});
  f.wiki.setMaintenanceTimeout = (fn, ms) => setTimeout(() => { now += ms; fn(); }, 0);
  const result = await f.wiki.maintain({ action: 'update', deadline: now + 25, callContext: { model } });
  assert.equal(result.deadlineReached, true);
  assert.equal(result.durationMs, 25);
  assert.equal(result.providerAttempts, 0);
  assert.equal(result.counts.deferred, 1);
  assert.equal(result.pendingPages[0].reason, 'maintenance_deadline');
  assert.equal(result.automaticRetryScheduled, false); assert.equal(f.requests.length, before);
});

test('legacy generation journals reserve slots while preparation-only labels do not', async () => {
  const f = await fixture(2, { labels: ['Thermostability'] }); await f.run('seed');
  const ids = reserved(f)[0].paperIds;
  const legacy = candidate(f, 'legacy-pending', 'Legacy pending', ids);
  legacy.wikiMaintenance = { attempts: [{ stage: 'generation', status: 'failed', providerAttempts: null }], status: 'pending' };
  const label = candidate(f, 'only-label', 'Only label', ids);
  label.wikiMaintenance = { analysisRequest: 'x'.repeat(2001), attempts: [{ stage: 'preparation', status: 'failed', providerAttempts: 0 }] };
  const result = await f.wiki.maintain({ callContext: { model } });
  assert.equal(result.admission.existingReservedPageCount, 2);
  assert.equal(result.admission.admittedCandidateCount, 0);
  assert.equal(result.admission.totalReservedPageCount, 2);
  assert.ok(legacy.wikiAdmission);
  assert.equal(label.wikiAdmission, undefined);
  assert.equal(result.generationCalls, 0);
});
