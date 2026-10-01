'use strict';
// Scripted provider decisions exercise the real loop, host, continuation and
// citation paths. These are runtime fixtures, NOT a live model routing score.
const test = require('node:test'), assert = require('node:assert/strict');
const { createFixture } = require('./helpers/preflight-fixture.js');
const { ProjectContextService } = require('../../docs/project-context-service.js');
const contract = require('../../shared/side-chat-tools.js');
const backend = require('../index.js'), agent = require('../side-chat-agent.js');
const continuation = require('../agent-continuation.js'), transcript = require('../../shared/conversation-transcript.js');
const model = 'google/gemma-4-31b-it';
const K = 'search_project_knowledge', E = 'retrieve_project_evidence', C = 'run_corpus_workflow';
const texts = [
  ['Methane', 'Methane provides carbon and energy for ectoine biosynthesis. Osmotic stress promotes compatible-solute accumulation.'],
  ['Milking', 'Bio-milking releases ectoine by osmotic downshift while retaining viable biomass; conventional extraction disrupts cells. Salinity drives osmotic adaptation.'],
  ['Reactor', 'Membrane reactor strategies improve methane gas transfer, whereas stirred tanks mix gas and liquid. The operating pH was 7.2.'],
  ['Software', 'Code availability: implementation is available at https://example.invalid/ectoine. Data availability: deposited in a public repository.'],
];
async function fixture(question, { failedCard = false, selected = null } = {}) {
  const f = await createFixture({ cardFailure: source => failedCard && source.path.includes('Reactor') });
  for (const [name, text] of texts) f.workspace.set(`literature/${name}.pdf`, text);
  f.service = new ProjectContextService({ workspace: f.workspace, literature: f.literature, sourceSystem: f.system, requestPipeline: f.pipeline,
    semanticInterpreter: { interpret() { throw Error('Mandatory planner is forbidden'); } } });
  f.options = { question, surface: 'side_chat', turnId: 'audit', callContext: { model } };
  // Seed a previously prepared workspace; ordinary chat no longer warms artifacts.
  await f.pipeline.preflight(f.options);
  f.context = await f.service.buildContext(f.options);
  f.ids = texts.map(([name]) => f.context.sourceMap.paperSources.find(s => s.path.includes(name)).sourceId);
  for (let index = 0; index < f.ids.length; index++) {
    const source = f.system.registry.get(f.ids[index]);
    // Real saved artifact layout with distractor chunks to expose over-retrieval.
    const artifact = await f.workspace.readJson(source.artifacts.paperText.path);
    artifact.pageCount = 3;
    artifact.chunks = [
      ...Array.from({ length: 9 }, (_, n) => ({ chunkId: `${source.sourceId}-P1-C${n + 1}`, page: 1, section: 'Background', text: `Unrelated distractor ${n}: chromatography calibration and unrelated enzyme assays.` })),
      { chunkId: `${source.sourceId}-P2-C1`, page: 2, section: 'Results', text: texts[index][1] },
      { chunkId: `${source.sourceId}-P3-C1`, page: 3, section: 'Discussion', text: 'See Results for methods; this paragraph discusses unrelated chromatography.' },
    ];
    await f.workspace.writeJson(source.artifacts.paperText.path, artifact);
    if (source.artifacts.paperCard?.path) {
      const card = await f.workspace.readJson(source.artifacts.paperCard.path);
      // Summary intentionally omits precise conditions; original evidence is needed.
      Object.assign(card, { title: texts[index][0], summary: texts[index][0] + ' study overview.', shortSummary: texts[index][0] + ' study overview.',
        researchQuestion: texts[index][0] + ' research.', mainFindings: [texts[index][0] + ' study overview.'], mainConclusion: texts[index][0] + ' study overview.',
        topics: [texts[index][0]], evidenceFindings: [], keyResults: [], importantResults: [] });
      await f.workspace.writeJson(source.artifacts.paperCard.path, card);
    }
  }
  if (selected) {
    f.options = { ...f.options, turnId: 'selected-audit', selectedPaperIds: selected.map(i => f.ids[i]) };
    f.context = await f.service.buildContext(f.options);
  }
  f.workerInputs = [];
  f.system.corpusWorkflows.mapWorker = async (input, options) => {
    assert.equal(options.callContext.model, model); assert.ok(input.evidence.length <= 8);
    assert.equal(input.messages, undefined); assert.equal(input.tools, undefined); assert.equal(input.permissions, undefined);
    assert.ok((f.options.selectedPaperIds || f.ids).includes(input.paperId));
    f.workerInputs.push(input);
    return { relevance: 'high', themes: ['ectoine'], methods: [], limitations: [],
      findings: input.evidence.slice(0, 1).map(row => ({ claim: row.claimCandidate, evidenceRefs: [row.evidenceRef] })) };
  };
  f.history = transcript.normalize(); f.serial = 0; f.results = []; f.modelCalls = 0;
  f.execute = async (name, args) => {
    const output = await f.service.executeAgentTool({ id: `host-${++f.serial}`, name, args }, { turnId: f.options.turnId });
    assert.equal(output.result.ok, true, JSON.stringify(output)); return output;
  };
  f.loop = async (requestTurn, resume) => agent.runSideChatAgent({
    workspaceContext: { localWorkspaceContext: backend._test.sanitizeLocalWorkspaceContext(f.context, f.options.question) },
    originalRequest: f.options.question, conversationMessages: [{ role: 'user', content: f.options.question }], conversationTranscript: f.history,
    model, turnId: f.options.turnId, systemPrompt: 'Use sufficient current evidence.', supportsTools: true, projectToolsEnabled: true,
    parseFinalAnswer: reply => reply ? { reply } : null, resume, requestTurn: async input => { f.modelCalls++; f.observeRequest?.(input); return requestTurn(input); },
  });
  return f;
}
const action = (name, query, indices, requirement) => ({ name, args: f => ({ ...(name === C ? {} : { query }),
  ...(indices ? { paper_ids: indices.map(i => f.ids[i]) } : {}), ...(requirement ? { requirement } : {}) }) });
async function scripted(f, actions, finalText) {
  let resume;
  for (const action of actions) {
    const first = await f.loop(async () => ({ ok: true, message: { tool_calls: [{ id: `model-${++f.serial}`, type: 'function',
      function: { name: action.name, arguments: JSON.stringify(action.args(f)) } }] } }), resume);
    assert.equal(first.data?.desktopToolCalls?.length, 1, JSON.stringify(first));
    const call = first.data.desktopToolCalls[0];
    const output = await f.service.executeAgentTool(call, { turnId: f.options.turnId });
    assert.equal(output.result.ok, true, JSON.stringify(output)); f.results.push({ tool: call.name, result: output.result });
    resume = continuation.withResults(continuation.open(continuation.seal(first.continuationState, { project: 'audit' }, 'fixture'), { project: 'audit' }, 'fixture'), [output]);
  }
  const reference = f.results.flatMap(r => r.result.evidenceBundle.items).flatMap(i => i.references || [])[0];
  const derived = f.results.flatMap(r => r.result.evidenceBundle.items).find(i => i.current && i.derived && i.sourceIds.length);
  const target = reference?.reference || derived?.sourceIds[0];
  const response = await f.loop(async () => ({ ok: true, message: { content: finalText || `${reference ? 'Original evidence supports this statement.' : 'Derived overview only.'}${target ? ` [[cite:${target}]]` : ''}` } }), resume);
  assert.ok(response.data?.reply, JSON.stringify(response));
  const citations = response.data.citations || [];
  const provenance = target ? citations.some(c => c.sourceId === (reference?.sourceId || derived.sourceIds[0]) && c.status === 'resolved' && (!reference || c.page === reference.page)) : null;
  if (target) assert.equal(provenance, true, JSON.stringify(citations));
  assert.ok(f.workspace.writes.every(path => path.startsWith('.biodesign/')));
  assert.deepEqual(f.workspace.state.agent.currentRecommendation, { id: 'R1' });
  return { response, provenance, reference };
}
const rows = [];
const record = (id, query, f, final) => rows.push({ id, query, route: f.results.length ? 'tools' : 'direct',
  tools: f.results.map(r => r.tool), scopes: f.results.map(r => r.result.evidenceBundle.scope),
  granularity: f.results.map(r => r.result.evidenceBundle.resolvedRequirement.granularity),
  coverageMode: f.results.map(r => r.result.evidenceBundle.resolvedRequirement.coverage),
  derivedUsed: f.results.some(r => r.result.evidenceBundle.items.some(i => i.derived)),
  originalEscalation: f.results.some(r => r.result.evidenceBundle.items.some(item => item.evidenceKind === 'original_passage')), 
  corpusWorkflow: f.results.some(r => r.tool === C), subagentSpawned: f.workerInputs.length > 0,
  finalProvenance: final.provenance === null ? 'not-applicable' : final.provenance ? final.reference ? 'valid-original-page' : 'valid-current-paper-link' : 'invalid',
  ...(final.response.data.corpusCoverage ? { measuredCoverage: final.response.data.corpusCoverage } : {}) });

test('A–O runtime evaluation matrix (scripted selected-model decisions, no reasoning recorded)', async t => {
  const cases = [
    ['A', 'What is Bayesian optimization?', []],
    ['A2', 'Why is methane relevant to ectoine production?', []],
    ['B', 'What are the major themes in this project?', [action(K, 'major themes', null, { coverage: 'broad' })]],
    ['C', 'What is the Methane paper about?', [action(K, 'Methane overview', [0], { coverage: 'targeted' })]],
    ['D', 'Why is methane relevant to ectoine production according to this paper?', [action(K, 'methane', [0], { task: 'explanation', granularity: 'concept' }), action(E, 'methane carbon energy ectoine', [0], { granularity: 'claim_support' })]],
    ['D2', 'How does bio-milking differ from conventional extraction in the Milking paper?', [action(K, 'milking', [1], { task: 'explanation', granularity: 'concept' }), action(E, 'bio-milking extraction viable biomass', [1], { granularity: 'claim_support' })]],
    ['D3', 'Why might salinity affect ectoine production according to these studies?', [action(K, 'Milking Methane', [0, 1], { task: 'explanation', granularity: 'concept' }), action(E, 'salinity osmotic stress solute', [0, 1], { granularity: 'claim_support' })]],
    ['E', "How do the papers' reactor strategies relate to methane production?", [action(K, 'Methane Reactor', [0, 2], { task: 'explanation', granularity: 'concept' }), action(E, 'methane reactor transfer carbon', [0, 2], { granularity: 'claim_support' })]],
    ['F', 'What exact pH did the Reactor paper use?', [action(E, 'pH', [2], { granularity: 'passage' })]],
    ['G', 'Which passage supports the claim that bio-milking retains viable biomass?', [action(E, 'bio-milking viable biomass', [1], { task: 'source_verification', granularity: 'claim_support' })]],
    ['H', 'Does the Software paper provide code, data or a repository?', [action(E, 'code data repository availability', [3], { task: 'source_verification' })]],
    ['I', 'Compare the themes of these two selected papers.', [action(K, 'themes', null, { task: 'comparison', granularity: 'overview' })], { selected: [0, 1] }],
    ['J', 'Synthesize relevant project findings about methane.', [action(K, 'methane', null, { task: 'synthesis', coverage: 'relevant' }), action(E, 'methane', [0, 2], { granularity: 'claim_support' })]],
    ['K', '帮我整理一下所有文献，写个综述。', [action(C, null, null, { coverage: 'exhaustive', granularity: 'overview' })]],
    ['M', 'What pH did the paper with the failed Paper Card use?', [action(E, 'pH', [2], { granularity: 'claim_support' })], { failedCard: true }],
    ['O', 'Explain across the complete corpus how methane supply, osmotic stress and reactor configuration interact.', [action(C, null, null, { task: 'explanation', coverage: 'exhaustive', granularity: 'concept', claimSupport: 'required' })]],
  ];
  for (const [id, query, actions, options] of cases) await t.test(id, async () => {
    const f = await fixture(query, options); const before = f.calls.cards;
    const final = await scripted(f, actions, actions.length ? undefined : 'General scientific explanation without project-specific assertions.');
    if (!actions.length) { assert.equal(f.modelCalls, 1); assert.equal(f.results.length, 0); }
    if (['B', 'C', 'I'].includes(id)) assert.equal(f.workerInputs.length, 0);
    if (id === 'K') { assert.equal(final.response.data.corpusCoverage.complete, true); assert.equal(f.workerInputs.length, 0); }
    if (id === 'O') assert.equal(f.workerInputs.length, 0);
    assert.equal(f.calls.cards, before);
    record(id, query, f, final);
  });
  await t.test('L', async () => {
    const f = await fixture('What exact pH did the Reactor paper use?');
    const previous = await scripted(f, [action(E, 'pH', [2], { granularity: 'claim_support' })]);
    f.history = transcript.upsert(null, previous.response.data.conversationTurn);
    f.options = { ...f.options, turnId: 'follow-up', question: 'Which page reported that value?' };
    f.context = await f.service.buildContext(f.options); f.results = []; f.modelCalls = 0;
    f.observeRequest = request => assert.ok(request.messages.some(m => m.role === 'tool' && String(m.content).includes('7.2')));
    // Replay supplies context without reexecution. A newly selected read obtains
    // a fresh working citation, as the current history policy explicitly requires.
    const final = await scripted(f, [action(E, 'pH', [2], { granularity: 'page' })]);
    assert.equal(f.service.agentTurns.get('follow-up').calls, 1);
    assert.equal(final.response.data.citations[0].page, 2);
    record('L', f.options.question, f, final);
  });
  await t.test('N', async () => {
    const f = await fixture('What do current project findings say about methane?');
    const old = await f.system.corpusWorkflows.run('Summarize all papers.', { paperIds: f.ids, callContext: { model } });
    const saved = old.resultHandle ? await f.system.results.read(old.resultHandle) : old; const path = f.system.corpusWorkflows.workflowPath(saved.workflowId);
    const journal = await f.workspace.readJson(path); journal.status = 'stale'; journal.staleReason = 'source_changed';
    await f.workspace.writeJson(path, journal);
    f.system.knowledgeService.searchPreviousSyntheses = async () => ({ results: [{ sourceId: saved.workflowId, title: 'Old review' }] });
    const final = await scripted(f, [action(K, 'methane', null, { task: 'synthesis' }), action(E, 'methane carbon', [0], { granularity: 'claim_support' })]);
    const historical = f.results[0].result.evidenceBundle.items.find(i => i.evidenceKind === 'historical_synthesis');
    assert.equal(historical.current, false); record('N', f.options.question, f, final);
  });
  console.log('KNOWLEDGE_AUDIT_MATRIX ' + JSON.stringify(rows));
  if (process.env.KNOWLEDGE_AUDIT_OUTPUT) require('node:fs').writeFileSync(process.env.KNOWLEDGE_AUDIT_OUTPUT, JSON.stringify({ verification: 'scripted-provider-runtime-fixture', rows }, null, 2) + '\n');
});

test('stress: targeted evidence excludes zero-match distractors and no-match queries do not dump arbitrary chunks', async () => {
  const f = await fixture('What pH was used?');
  const result = (await f.execute(E, { query: 'pH', paper_ids: [f.ids[2]] })).result;
  assert.doesNotMatch(result.files[0].content, /distractor|chromatography/);
  assert.equal(result.evidenceBundle.items[0].references.length, 1);
  const absent = (await f.execute(E, { query: 'unfindable-zeta-material', paper_ids: [f.ids[2]] })).result;
  assert.equal(absent.files.length, 0); assert.ok(absent.evidenceBundle.gaps.length);
});

test('stress: relevant orientation excludes unrelated zero-score cards while broad orientation remains available', async () => {
  const f = await fixture('What does the project say about methane?');
  const result = (await f.execute(K, { query: 'methane', requirement: { coverage: 'relevant' } })).result;
  assert.deepEqual(result.paperCards.map(c => c.sourceId), [f.ids[0]]);
  const broad = (await f.execute(K, { query: 'major themes', requirement: { coverage: 'broad' } })).result;
  assert.equal(broad.paperCards.length, 4);
});

test('stress: section boundaries take precedence over incidental mentions of the section name', async () => {
  const f = await fixture('Read Results.');
  const result = (await f.execute(E, { query: 'pH', paper_ids: [f.ids[2]], section: 'Results', requirement: { granularity: 'section' } })).result;
  assert.doesNotMatch(result.files[0].content, /this paragraph|chromatography/);
});

test('stress: derived-evidence sufficiency depends on semantic requirements, not harmless wording or a keyword list', () => {
  const overview = contract.normalizeRequirement(C, { task: 'overview', granularity: 'overview', claimSupport: 'as_needed' });
  for (const query of ['Summarize all papers.', 'Please briefly summarize all papers in this folder.', '给全部文章写一份简短概览。']) {
    assert.equal(contract.cardProjectionIsSufficient(overview, query), true, query);
  }
  const complex = contract.normalizeRequirement(C, { task: 'explanation', granularity: 'concept', claimSupport: 'required' });
  for (const query of ['Compare these facets.', 'Integrate the relationships.', '解释这些联系。']) assert.equal(contract.cardProjectionIsSufficient(complex, query), false);
});

test('stress: declared exhaustive coverage survives signed continuation and cannot become a semantic subset', async () => {
  const f = await fixture('Account for the collection without omissions.');
  const first = await f.loop(async () => ({ ok: true, message: { tool_calls: [{ id: 'exhaustive-search', type: 'function', function: { name: K,
    arguments: JSON.stringify({ query: 'methane', requirement: { coverage: 'exhaustive' } }) } }] } }));
  const result = await f.service.executeAgentTool(first.data.desktopToolCalls[0], { turnId: f.options.turnId });
  const state = continuation.withResults(continuation.open(continuation.seal(first.continuationState, {}, 'fixture'), {}, 'fixture'), [result]);
  const final = await f.loop(async () => ({ ok: true, message: { content: 'This is a complete review of the collection.' } }), state);
  assert.equal(final.data.corpusCoverage?.complete, false);
  assert.equal(final.data.corpusCoverage.analyzedCount, 0);
  assert.match(final.data.reply, /not a complete review/);
});

test('stress: stale original records cannot satisfy a current support requirement', () => {
  const requirement = contract.resolveRequirement(E, { query: 'pH' }, ['paper']);
  const bundle = contract.bundle(requirement, { items: [{ sourceIds: ['paper'], evidenceKind: 'original_passage', derived: false, current: false,
    content: 'Stale value', references: [{ reference: 'paper:p2:chunk' }] }] });
  assert.equal(bundle.sufficiency, 'needs_original_evidence');
});


test('corpus phrasing and keyword-free corpus scope use measured coverage, never a semantic subset', async () => {
  for (const phrase of ['all papers', 'every paper', 'entire literature set', 'full review', 'complete corpus']) {
    const f = await fixture(`Summarize the ${phrase}.`);
    const final = await scripted(f, [action(C, null, null, { task: 'overview', granularity: 'overview', coverage: 'exhaustive' })]);
    assert.equal(final.response.data.corpusCoverage.includedCount, 4, phrase);
    assert.equal(final.response.data.corpusCoverage.analyzedCount, 4, phrase);
    assert.equal(final.response.data.corpusCoverage.complete, true, phrase);
    assert.equal(f.workerInputs.length, 0, 'Routine corpus orientation need not spawn reasoning workers');
  }
  const requirement = contract.resolveRequirement(K, { query: 'anything', requirement: { scope: { type: 'corpus' } } }, ['A', 'B']);
  assert.equal(requirement.coverage, 'exhaustive');
  assert.ok(contract.bundle(requirement).escalationHints.includes(C));
});

test('progressive explanation reads only matching chunks from the selected papers, never every source', async () => {
  const f = await fixture('How does bio-milking relate to osmotic stress?');
  const final = await scripted(f, [action(K, 'Milking Methane', [0, 1], { granularity: 'concept', task: 'explanation' }),
    action(E, 'osmotic stress bio-milking', [0, 1], { granularity: 'claim_support' })]);
  const evidence = f.results[1].result;
  assert.equal(evidence.files.length, 2);
  assert.ok(evidence.files.every(file => !/distractor|chromatography/.test(file.content)));
  assert.ok(evidence.evidenceBundle.items.every(item => item.references.length === 1));
  assert.equal(f.workerInputs.length, 0); assert.equal(final.response.data.corpusCoverage, undefined);
});

test('local corpus collection respects cancellation and deduplication without spawning workers', async () => {
  const f = await fixture('Explain the relationships in the collection.');
  for (const tool of [K, E]) await f.execute(tool, { query: 'methane', paper_ids: [f.ids[0]], requirement: { granularity: tool === K ? 'concept' : 'claim_support' } });
  assert.equal(f.workerInputs.length, 0);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(f.service.executeAgentTool({ id: 'cancelled', name: C, args: { requirement: { granularity: 'concept', claimSupport: 'required' } } },
    { turnId: f.options.turnId, signal: controller.signal }), { code: 'OPERATION_ABORTED' });
  assert.equal(f.workerInputs.length, 0);
  const args = { requirement: { task: 'explanation', granularity: 'concept', claimSupport: 'required' } };
  const call = { id: 'dedup', name: C, args };
  const results = await Promise.all([1, 2].map(() => f.service.executeAgentTool(call, { turnId: f.options.turnId })));
  assert.equal(results[0].result.ok, true); assert.deepEqual(results[0], results[1]);
  assert.equal(f.workerInputs.length, 0);
  await f.execute(C, args); assert.equal(f.workerInputs.length, 0, 'Local evidence collections are reused');
});


test('stress: exact lexical ranking retains unit-only scientific evidence without substring collisions', () => {
  assert.equal(contract.evidenceScore('chromatography and phosphatases', contract.evidenceTerms('pH')), 0);
  assert.equal(contract.evidenceScore('pH = 7.2', contract.evidenceTerms('pH')), 1);
  for (const unit of ['30 C', '50 °C', '37℃', '98.6 F', '20 degrees Celsius']) {
    assert.ok(contract.evidenceScore(`Assay at ${unit}.`, contract.evidenceTerms('temperature')) > 0);
    assert.ok(contract.evidenceScore(`Assay at ${unit}.`, contract.evidenceTerms('测定温度是多少？')) > 0);
  }
  assert.equal(contract.evidenceScore('phosphatase', contract.evidenceTerms('pH值')), 0);
});

test('stress: verified corpus excerpts reach the bundle and citation registry without an unnecessary second model-selected read', async () => {
  const f = await fixture('Explain the interactions across the collection.');
  const result = (await f.execute(C, { requirement: { task: 'explanation', granularity: 'concept', claimSupport: 'required' } })).result;
  assert.ok(result.evidenceBundle.items.some(item => item.evidenceKind === 'original_passage' && item.current && item.references.length));
  assert.equal(result.evidenceBundle.sufficiency, 'agent_must_assess');
  assert.ok(f.context.citationEvidence.length);
  assert.equal(f.service.agentTurns.get(f.options.turnId).calls, 1);
});

test('stress: saved corpus verification cannot promote fabricated or out-of-scope references to current evidence', async () => {
  const f = await fixture('Explain these selected papers.', { selected: [0, 1] });
  const run = f.system.corpusWorkflows.run.bind(f.system.corpusWorkflows);
  f.system.corpusWorkflows.run = async (...args) => {
    const output = await run(...args);
    const value = output.resultHandle ? await f.system.results.read(output.resultHandle) : output;
    for (const id of f.ids.slice(0, 2)) value.maps[id].findings = [{ claim: 'Untrusted cached value', evidenceRefs: [
      `${f.ids[0]}:p99:invented`, `${f.ids[3]}:p2:${f.ids[3]}-P2-C1`,
    ] }];
    return { ...value, verification: [{ locatedEvidence: [
      { evidenceRef: `${f.ids[0]}:p99:invented`, excerpt: 'A fabricated value' },
      { evidenceRef: `${f.ids[3]}:p2:${f.ids[3]}-P2-C1`, excerpt: 'Outside the selection' },
    ] }] };
  };
  const { result } = await f.execute(C, { requirement: { granularity: 'concept', claimSupport: 'required' } });
  assert.ok(result.findings.papers.every(paper => !paper.originalEvidence.length));
  assert.equal(result.evidenceBundle.sufficiency, 'needs_original_evidence');
  assert.ok(!f.context.citationEvidence?.length);
});
