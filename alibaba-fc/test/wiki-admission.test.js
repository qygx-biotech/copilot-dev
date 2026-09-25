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
  assert.ok(runs.every(run => run.wikiMaintenance.admission.existingReservedPageCount === 3));
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
  // Existing explicit update operation also creates the fourth discovered subject.
  const explicit = await f.wiki.maintain({ action: 'update', callContext: { model } });
  assert.equal(explicit.admission.existingReservedPageCount, 4);
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
  restarted.workspace.set('literature/p0.pdf', 'Changed raw enzyme engineering evidence with revised thermostability results.', Date.now() - 1000);
  const changed = await restarted.run('changed');
  assert.equal(changed.wikiMaintenance.generationCalls, 3);
  assert.equal((await restarted.run('changed-remainder')).wikiMaintenance.generationCalls, 1);
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
  assert.equal(f.requests.length, 3);
  await f.run('selected-remainder', { selectedPaths: ['literature/p0.pdf', 'literature/p1.pdf'] });
  assert.equal(f.requests.length, 5);
  const ids = ['literature/p0.pdf', 'literature/p1.pdf'].map(path => f.system.registry.getByPath(path).sourceId);
  assert.ok(f.requests.every(input => input.papers.length === 2 && input.papers.every(paper => ids.includes(paper.paperId))));
  const denied = await f.wiki.maintain({ action: 'update', hardSelection: true, paperIds: [], callContext: { model } });
  assert.equal(denied.generationCalls, 0);
  const explicit = await f.wiki.maintain({ action: 'incorporate', analysisRequest: 'Concept F', hardSelection: true, paperIds: ids, callContext: { model } });
  // The existing subject matcher may match multiple concept labels; scope is still hard.
  assert.ok(explicit.generationCalls <= contract.LIMITS.pagesPerRun);
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
  assert.equal(event.details.existingReservedPageCount, 3);
  assert.equal(event.details.deferredCandidateCount, 1);
  assert.equal(log.entries().find(entry => entry.event === 'wiki.admission-deferred').details.reason, 'page_ceiling');
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
