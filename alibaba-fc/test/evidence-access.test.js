"use strict";
const test = require('node:test');
const assert = require('node:assert/strict');
const { createFixture } = require('./helpers/preflight-fixture.js');
const { ProjectContextService } = require('../../docs/project-context-service.js');
const contract = require('../../shared/side-chat-tools.js');
const agent = require('../side-chat-agent.js');
const backend = require('../index.js');
const continuation = require('../agent-continuation.js');
const transcript = require('../../shared/conversation-transcript.js');
const model = 'google/gemma-4-31b-it';
async function fixture(question = 'What are the major themes in the project literature?', options = {}) {
  const f = await createFixture(options);
  f.workspace.set('literature/ectoine.pdf', 'Methane supplies carbon for ectoine production. Osmotic stress induces compatible solutes. Reactor pH was 7.2.');
  f.workspace.set('literature/reactor.pdf', 'Salinity and reactor configuration alter methane transfer. Software availability: https://example.invalid/repo.');
  f.workspace.set('literature/other.pdf', 'A163V improved stability.');
  // Seed existing derived artifacts explicitly; request context preparation is metadata-only.
  await f.pipeline.preflight({ turnId: "seed-fixture" });
  f.service = new ProjectContextService({ workspace: f.workspace, literature: f.literature, sourceSystem: f.system, requestPipeline: f.pipeline,
    semanticInterpreter: { interpret() { throw Error('No compulsory semantic planner'); } } });
  f.options = { question, surface: 'side_chat', turnId: 'evidence-turn', callContext: { model } };
  f.context = await f.service.buildContext(f.options);
  f.ids = f.context.sourceMap.paperSources.map(s => s.sourceId);
  f.tool = async (name, args, id = name) => {
    const response = await f.service.executeAgentTool({ id, name, args }, { turnId: f.options.turnId });
    assert.equal(response.result.ok, true, JSON.stringify(response));
    return response;
  };
  return f;
}
async function loop(f, requestTurn, resume) {
  return agent.runSideChatAgent({ workspaceContext: { localWorkspaceContext: backend._test.sanitizeLocalWorkspaceContext(f.context, f.options.question) },
    originalRequest: f.options.question, conversationMessages: [{ role: 'user', content: f.options.question }],
    conversationTranscript: transcript.normalize(), turnId: f.options.turnId, model, systemPrompt: 'Answer from sufficient evidence.',
    parseFinalAnswer: reply => reply ? { reply } : null, projectToolsEnabled: true, supportsTools: true, requestTurn, resume });
}
const toolCall = (name, args, id) => ({ id, type: 'function', function: { name, arguments: JSON.stringify(args) } });

test('contract defaults, strict validation and authoritative scope preserve legacy arguments', () => {
  assert.deepEqual(contract.validate('search_project_knowledge', { query: 'themes' }), { query: 'themes', paper_ids: [] });
  const requirement = contract.resolveRequirement('retrieve_project_evidence', { query: 'pH' }, ['A', 'B'], true);
  assert.deepEqual(requirement, { task: 'lookup', domains: ['literature'], scope: { type: 'selected_sources', sourceIds: ['A', 'B'] }, coverage: 'targeted', granularity: 'passage', freshness: 'current', claimSupport: 'required' });
  for (const requirement of [{ freshness: 'stale' }, { layer: 'L1' }, { granularity: 'full_pdf' }, { scope: { type: 'single_source' } }]) {
    assert.throws(() => contract.validate('search_project_knowledge', { query: 'x', requirement }));
  }
  assert.throws(() => contract.validate('search_project_knowledge', { query: 'x', requirement: { domains: ['experiments'] } }), { code: 'UNSUPPORTED_EVIDENCE_DOMAIN' });
  assert.throws(() => contract.validate('retrieve_project_evidence', { query: 'x', paper_ids: ['A'], requirement: { scope: { sourceIds: ['B'] } } }), { code: 'CONFLICTING_EVIDENCE_SCOPE' });
  assert.deepEqual(contract.resolveRequirement('run_corpus_workflow', { requirement: { scope: { sourceIds: ['A'] } } }, ['A', 'B']).scope.sourceIds, ['A', 'B']);
  assert.equal(contract.definitions.length, 3);
  assert.doesNotMatch(JSON.stringify(contract.definitions), /search_l[0-4]|"L[0-4]"/);
});

test('CASE 1: general knowledge can answer directly with zero knowledge searches or corpus execution', async () => {
  const f = await fixture('What is Bayesian optimization?');
  assert.deepEqual(f.context.files, []);
  f.service.retrieveLayeredKnowledge = f.system.literatureTools.searchPapers = f.system.corpusWorkflows.run = () => { throw Error('Unexpected retrieval'); };
  let calls = 0;
  const answer = await loop(f, async request => {
    calls++;
    assert.ok(request.messages.some(m => /general questions can be answered directly/.test(m.content)));
    return { ok: true, message: { content: 'Bayesian optimization uses a probabilistic surrogate and an acquisition function.' } };
  });
  assert.equal(calls, 1); assert.match(answer.data.reply, /surrogate/);
  assert.equal(f.service.agentTurns.get(f.options.turnId).calls, 0);
});

test('CASE 2: orientation prefers reusable cards and never reads original artifacts to rank papers', async () => {
  const f = await fixture();
  const cardCount = f.calls.cards;
  f.system.literatureTools.searchPapers = f.system.preparation.readPaperArtifact = () => { throw Error('Orientation must not read raw chunks'); };
  const { result } = await f.tool('search_project_knowledge', { query: 'major themes', requirement: { coverage: 'broad' } });
  assert.equal(result.paperCards.length, 3);
  assert.ok(result.evidenceBundle.items.every(item => item.evidenceKind === 'paper_card' && item.derived && item.current));
  assert.equal(result.evidenceBundle.coverage.complete, false);
  assert.equal(f.calls.cards, cardCount);
  assert.ok(result.evidenceBundle.escalationHints.some(hint => /retrieve_project_evidence/.test(hint)));
});

test('CASE 3 + 8: understanding can progress from cards to original evidence and final answer in the same loop', async () => {
  const f = await fixture('Why is methane important for ectoine production according to these papers?');
  const request = { query: 'methane ectoine', requirement: { task: 'explanation', granularity: 'concept' } };
  const first = await loop(f, async () => ({ ok: true, message: { tool_calls: [toolCall('search_project_knowledge', request, 'orientation')] } }));
  const firstResult = await f.tool(first.data.desktopToolCalls[0].name, first.data.desktopToolCalls[0].args, 'orientation');
  assert.equal(firstResult.result.evidenceBundle.resolvedRequirement.coverage, 'relevant');
  const second = await loop(f, async req => {
    assert.ok(req.messages.some(m => m.role === 'tool' && /paper_card/.test(m.content)));
    return { ok: true, message: { tool_calls: [toolCall('retrieve_project_evidence', { query: 'methane ectoine carbon', paper_ids: [f.ids[0]], requirement: { granularity: 'claim_support' } }, 'support')] } };
  }, continuation.withResults(first.continuationState, [firstResult]));
  const secondResult = await f.tool(second.data.desktopToolCalls[0].name, second.data.desktopToolCalls[0].args, 'support');
  const bundle = secondResult.result.evidenceBundle;
  assert.equal(bundle.items[0].derived, false); assert.equal(bundle.items[0].current, true);
  assert.equal(bundle.coverage.complete, false); assert.equal(bundle.resolvedRequirement.granularity, 'claim_support');
  const ref = bundle.items[0].references[0];
  const final = await loop(f, async () => ({ ok: true, message: { content: `Methane supplies carbon. [[cite:${ref.reference}]]` } }), continuation.withResults(second.continuationState, [secondResult]));
  assert.equal(final.data.citations[0].sourceId, f.ids[0]); assert.equal(final.data.citations[0].page, 1);
  assert.equal(final.data.conversationTurn.messages.filter(m => m.role === 'tool').length, 2);
  assert.equal(f.calls.cards, 3);
});

test('CASE 4: exact values require original support, with requested page/section preserved', async () => {
  const f = await fixture('What pH did paper X use?');
  const orientation = await f.tool('search_project_knowledge', { query: 'pH', paper_ids: [f.ids[0]], requirement: { granularity: 'claim_support' } });
  assert.equal(orientation.result.evidenceBundle.sufficiency, 'needs_original_evidence');
  const source = f.system.registry.get(f.ids[0]);
  const path = source.artifacts.paperText.path;
  const artifact = await f.workspace.readJson(path);
  artifact.chunks = [
    { chunkId: 'abstract', page: 1, section: 'Abstract', text: 'Reactor development.' },
    { chunkId: 'methods', page: 3, section: 'Methods', text: 'The reactor pH was 7.2.' },
    { chunkId: 'discussion', page: 4, section: 'Discussion', text: 'Previous work used pH 6.5.' },
  ];
  await f.workspace.writeJson(path, artifact);
  const { result } = await f.tool('retrieve_project_evidence', { query: 'pH', paper_ids: [f.ids[0]], page: 3, requirement: { granularity: 'page' } });
  assert.match(result.files[0].content, /7.2/); assert.doesNotMatch(result.files[0].content, /6.5/);
  assert.equal(result.evidenceBundle.items[0].evidenceKind, 'original_page');
  assert.equal(result.evidenceBundle.items[0].references[0].page, 3);
  const section = await f.tool('retrieve_project_evidence', { query: 'pH', paper_ids: [f.ids[0]], section: 'Methods', requirement: { granularity: 'section' } }, 'section');
  assert.equal(section.result.evidenceBundle.items[0].evidenceKind, 'original_section');
  assert.doesNotMatch(section.result.files[0].content, /6.5/);
});

test('CASE 5: source-code queries expand locally, and missing matches never assert no release', async () => {
  const f = await fixture('Does paper X provide source code?');
  const { result } = await f.tool('retrieve_project_evidence', { query: '有源代码吗', paper_ids: [f.ids[1]], requirement: { task: 'source_verification' } });
  assert.match(result.files[0].content, /Software availability/);
  assert.equal(result.evidenceBundle.resolvedRequirement.claimSupport, 'required');
  assert.ok(contract.evidenceTerms('source code').includes('github'));
  const absent = await f.tool('retrieve_project_evidence', { query: 'source code', paper_ids: [f.ids[2]] }, 'absent');
  assert.ok(absent.result.evidenceBundle.gaps.some(gap => /not proof of absence/.test(gap)));
  assert.match(absent.result.limitation, /Missing matches do not establish absence/);
});

test('CASE 6: Chinese all-paper review keeps original request, measured coverage, selected model and warm caches', async () => {
  const f = await fixture('帮我整理一下所有文献，写个综述。');
  const run = f.system.corpusWorkflows.run.bind(f.system.corpusWorkflows);
  f.system.corpusWorkflows.run = (question, options) => {
    assert.equal(question, f.options.question); assert.equal(options.callContext.model, model);
    assert.equal(options.requireQueryEvidence, false); return run(question, options);
  };
  const first = await loop(f, async () => ({ ok: true, message: { tool_calls: [toolCall('run_corpus_workflow', {}, 'corpus')] } }));
  const response = await f.tool('run_corpus_workflow', {}, 'corpus');
  assert.deepEqual(response.result.evidenceBundle.coverage, { requested: 3, included: 3, complete: true, analyzed: 3, failed: 0, missing: 0 });
  const final = await loop(f, async () => ({ ok: true, message: { content: '逐篇总结及综述：比较研究主题和已有证据的限制。' } }), continuation.withResults(first.continuationState, [response]));
  assert.match(final.data.reply, /综述/); assert.equal(final.data.corpusCoverage.complete, true);
  await f.tool('run_corpus_workflow', {}, 'warm'); assert.equal(f.calls.cards, 3);
  const searched = await f.tool('search_project_knowledge', { query: 'all papers', requirement: { coverage: 'exhaustive' } });
  assert.equal(searched.result.evidenceBundle.coverage.complete, false);
  assert.ok(searched.result.evidenceBundle.escalationHints.includes('run_corpus_workflow'));
});

test('CASE 7: failed card does not block current original evidence or cause card regeneration', async () => {
  const f = await fixture('What pH was used?', { cardFailure: () => true });
  const count = f.calls.cards;
  const orientation = await f.tool('search_project_knowledge', { query: 'pH', paper_ids: [f.ids[0]] });
  assert.equal(orientation.result.paperCards.length, 0);
  assert.equal(orientation.result.evidenceBundle.items[0].evidenceKind, 'metadata');
  const original = await f.tool('retrieve_project_evidence', { query: 'pH', paper_ids: [f.ids[0]] });
  assert.match(original.result.files[0].content, /7.2/); assert.equal(f.calls.cards, count);
});

test('CASE 9: requirement scope and old paper_ids cannot widen hard selection; corpus cannot silently shrink it', async () => {
  const f = await fixture();
  f.options = { ...f.options, turnId: 'selected', selectedPaperIds: f.ids.slice(0, 2) };
  f.context = await f.service.buildContext(f.options);
  const orientation = await f.tool('search_project_knowledge', { query: 'themes' });
  assert.deepEqual(orientation.result.evidenceBundle.scope.sourceIds, f.ids.slice(0, 2));
  for (const args of [{ query: 'pH', paper_ids: [f.ids[2]] }, { query: 'pH', requirement: { scope: { type: 'single_source', sourceIds: [f.ids[2]] } } }]) {
    const denied = await f.service.executeAgentTool({ id: JSON.stringify(args), name: 'retrieve_project_evidence', args }, { turnId: 'selected' });
    assert.equal(denied.result.error, 'SOURCE_OUTSIDE_SCOPE');
  }
  const narrowed = await f.service.executeAgentTool({ id: 'narrow', name: 'run_corpus_workflow', args: { requirement: { scope: { sourceIds: [f.ids[0]] } } } }, { turnId: 'selected' });
  assert.equal(narrowed.result.ok, true);
  assert.deepEqual(narrowed.result.evidenceBundle.scope.sourceIds, f.ids.slice(0, 2));
  assert.equal(narrowed.result.scopeResolution.legacyArgumentsNormalized, true);
});

test('CASE 10: multi-facet corpus collects local evidence without workers, reuses it, and preserves scope and write protections', async () => {
  const question = 'Compare methane supply, salinity and reactor configuration across all selected papers.';
  const f = await fixture(question); const inputs = [];
  f.options = { ...f.options, turnId: 'facets', selectedPaperIds: [f.ids[0], f.ids[1]] };
  f.context = await f.service.buildContext(f.options);
  f.system.corpusWorkflows.mapWorker = async (input, options) => {
    inputs.push(input); assert.equal(input.question, question); assert.ok(f.ids.slice(0, 2).includes(input.paperId));
    assert.equal(input.messages, undefined); assert.equal(input.tools, undefined); assert.equal(input.permissions, undefined);
    assert.equal(options.callContext.model, model); assert.ok(input.evidence.length <= 8);
    return { relevance: 'high', themes: ['reactor conditions'], findings: input.evidence.map(item => ({ claim: item.claimCandidate, evidenceRefs: [item.evidenceRef] })), methods: [], limitations: [] };
  };
  const first = await f.tool('run_corpus_workflow', { requirement: { task: 'comparison', granularity: 'concept' } });
  assert.equal(inputs.length, 0); assert.equal(first.result.evidenceBundle.coverage.analyzed, 2);
  await f.tool('run_corpus_workflow', { requirement: { task: 'comparison', granularity: 'concept' } }, 'warm'); assert.equal(inputs.length, 0);
  assert.equal(f.calls.cards, 3);
  assert.equal(first.result.findings.papers.length, 2);
  assert.ok(first.result.findings.papers.every(paper => paper.originalEvidence.length && paper.orientation));
  assert.deepEqual(f.workspace.state.agent.currentRecommendation, { id: 'R1' });
  assert.ok(f.workspace.writes.every(path => path.startsWith('.biodesign/')));
});

test('corpus collection performs no query-time provider work, including when all Paper Cards failed', async () => {
  const f = await fixture('帮我总结所有文献，写个综述。', { cardFailure: () => true });
  const cardsBefore = f.calls.cards;
  f.system.corpusWorkflows.mapWorker = () => { throw Error('Per-paper provider work is forbidden'); };
  f.system.corpusWorkflows.getWorkflowSharedRetrievalPlan = () => { throw Error('Provider search planning is forbidden'); };
  f.system.preparation.generatePaperCard = () => { throw Error('Query-time Paper Card regeneration is forbidden'); };
  const search = f.system.literatureTools.searchPaperContent.bind(f.system.literatureTools);
  let searches = 0;
  f.system.literatureTools.searchPaperContent = (id, query, options) => {
    searches++; assert.equal(options.retrievalProfile, 'light');
    assert.equal(query, f.options.question); return search(id, query, options);
  };
  let providerCalls = 0;
  const first = await loop(f, async () => {
    providerCalls++;
    return { ok: true, message: { tool_calls: [toolCall('run_corpus_workflow', { requirement: { task: 'literature_review', granularity: 'concept' } }, 'collect')] } };
  });
  const response = await f.tool('run_corpus_workflow', { requirement: { task: 'literature_review', granularity: 'concept' } }, 'collect');
  assert.equal(searches, 3); assert.equal(f.calls.cards, cardsBefore);
  assert.equal(response.result.collectionMode, 'local-evidence');
  assert.deepEqual(response.result.findings.papers.map(p => p.sourceId), f.ids);
  assert.ok(response.result.findings.papers.every(p => p.originalEvidence.length && !p.orientation));
  assert.equal(response.result.findings.synthesisInputCoverage.withOriginalEvidence, 3);
  const reference = response.result.findings.papers[0].originalEvidence[0].reference;
  const final = await loop(f, async input => {
    providerCalls++;
    assert.ok(input.messages.some(message => message.role === 'tool' && message.content.includes('local-evidence')));
    return { ok: true, message: { content: `逐篇总结及综述：甲烷与渗透应激相关。[[cite:${reference}]]` } };
  }, continuation.withResults(first.continuationState, [response]));
  assert.equal(providerCalls, 2, 'One main-agent tool decision, then one main-agent synthesis; no per-paper LLM calls');
  assert.equal(final.data.corpusCoverage.complete, true);
  assert.equal(final.data.citations[0].sourceId, f.ids[0]);
  await f.tool('run_corpus_workflow', { requirement: { task: 'literature_review', granularity: 'concept' } }, 'warm-local');
  assert.equal(searches, 3, 'Compatible local evidence collection is reused');
  const resumed = await f.system.corpusWorkflows.run(f.options.question, { workflowId: response.result.workflowId, paperIds: f.ids });
  const value = resumed.resultHandle ? await f.system.results.read(resumed.resultHandle) : resumed;
  assert.equal(value.processingAccounting.providerMapRequests, 0);
  assert.equal(value.knowledgeConfiguration.evidenceCollection, 'local-corpus-evidence-v1');
  assert.equal(f.calls.cards, cardsBefore);
});

test('a larger corpus shares a bounded synthesis budget across every paper and invalidates changed evidence locally', async () => {
  const f = await fixture('Compare methane and salinity across all papers.');
  for (let n = 0; n < 17; n++) f.workspace.set(`literature/extra-${n}.pdf`, `Paper ${n}: Methane and salinity conditions. `.repeat(60));
  f.options = { ...f.options, turnId: 'larger-collection' };
  f.context = await f.service.buildContext(f.options);
  f.ids = f.context.sourceMap.paperSources.map(source => source.sourceId);
  f.system.corpusWorkflows.mapWorker = () => { throw Error('Unexpected provider mapper'); };
  const collected = await f.tool('run_corpus_workflow', { requirement: { task: 'comparison', granularity: 'concept' } });
  assert.equal(collected.result.findings.papers.length, 20);
  assert.ok(collected.result.findings.papers.every(paper => paper.originalEvidence.length));
  assert.ok(JSON.stringify(collected).length < 150000, 'Fits the existing desktop-continuation tool-result budget');
  const source = f.context.sourceMap.paperSources.find(item => item.path.includes('ectoine.pdf'));
  const oldHash = collected.result.findings.papers.find(paper => paper.sourceId === source.sourceId).contentHash;
  f.workspace.set('literature/ectoine.pdf', 'New source version: methane measurements now report pH 6.5.');
  f.options = { ...f.options, turnId: 'changed-evidence' };
  f.context = await f.service.buildContext(f.options);
  const current = await f.tool('run_corpus_workflow', { requirement: { task: 'comparison', granularity: 'concept' } }, 'changed');
  const paper = current.result.findings.papers.find(item => item.sourceId === source.sourceId);
  assert.notEqual(paper.contentHash, oldHash);
  assert.match(JSON.stringify(paper.originalEvidence), /6\.5/);
  assert.doesNotMatch(JSON.stringify(paper.originalEvidence), /7\.2/);
  assert.equal(current.result.findings.papers.length, 20);
});

test('debug events retain decisions and bounded IDs but drop reasoning, queries and document text', () => {
  const { createRuntimeLogger } = require('../../docs/runtime-log.js');
  const logger = createRuntimeLogger({ sink: null });
  const entry = logger.record('knowledge.access', { tool: 'retrieve_project_evidence', scopeType: 'selected_sources', sourceIds: ['paper-1'], granularity: 'claim_support',
    localKnowledgeUsed: true, originalEvidenceEscalation: true, subagentSpawned: false, analyzed: 2, reasoning: 'private', query: 'private', text: 'private' });
  assert.equal(entry.details.granularity, 'claim_support'); assert.deepEqual(entry.details.sourceIds, ['paper-1']);
  assert.doesNotMatch(JSON.stringify(entry), /private/);
});

test('saved synthesis currentness includes source/configuration compatibility; old saved files remain readable historical context', async () => {
  const f = await fixture('Summarize all papers.');
  const { result } = await f.tool('run_corpus_workflow', {});
  const id = result.workflowId;
  f.system.knowledgeService.searchPreviousSyntheses = async () => ({ results: [{ sourceId: id, title: 'Saved review', snippet: 'discovery only' }] });
  const current = await f.tool('search_project_knowledge', { query: 'review' }, 'current-synthesis');
  const saved = current.result.evidenceBundle.items.find(item => item.evidenceKind === 'historical_synthesis');
  assert.ok(saved); assert.equal(saved.current, true); assert.equal(saved.derived, true);
  const path = f.system.corpusWorkflows.workflowPath(id);
  const journal = await f.workspace.readJson(path); delete journal.knowledgeConfiguration;
  await f.workspace.writeJson(path, journal);
  const historical = await f.tool('search_project_knowledge', { query: 'review' }, 'legacy-synthesis');
  assert.equal(historical.result.evidenceBundle.items.find(item => item.artifactId === id).current, false);
  assert.equal(f.calls.cards, 3);
});

test('a legacy projection is replaced by current local evidence without a mapper call', async () => {
  const f = await fixture('Compare methane supply and salinity in all papers.');
  await f.system.corpusWorkflows.run(f.options.question, { paperIds: f.ids, callContext: { model } });
  let maps = 0;
  f.system.corpusWorkflows.mapWorker = async input => {
    maps++;
    return { relevance: 'high', themes: ['conditions'], findings: input.evidence.slice(0, 1).map(item => ({ claim: item.claimCandidate, evidenceRefs: [item.evidenceRef] })), methods: [], limitations: [] };
  };
  await f.tool('run_corpus_workflow', { requirement: { task: 'comparison', granularity: 'concept' } }); assert.equal(maps, 0);
  await f.tool('run_corpus_workflow', { requirement: { task: 'comparison', granularity: 'concept' } }, 'query-cache'); assert.equal(maps, 0);
  assert.equal(f.calls.cards, 3);
});

test('invalid, oversized, conflicting or permission-bearing requirements fail locally', () => {
  for (const args of [
    { query: 'x'.repeat(2001) }, { query: 'pH', page: 0 }, { query: 'pH', page: 1.5 },
    { query: 'pH', section: 'x'.repeat(201) }, { query: 'pH', paper_ids: ['../private'] },
    { query: 'pH', requirement: { permissions: 'write' } }, { query: 'pH', requirement: { scope: { sourceIds: ['A', 'A'] } } },
  ]) assert.throws(() => contract.validate('retrieve_project_evidence', args));
});
