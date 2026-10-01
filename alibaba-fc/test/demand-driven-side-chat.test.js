'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { createFixture } = require('./helpers/preflight-fixture.js');
const { ProjectContextService } = require('../../docs/project-context-service.js');
const agent = require('../side-chat-agent.js'), backend = require('../index.js'), continuation = require('../agent-continuation.js');
const wikiContract = require('../../shared/literature-wiki.js');
const model = 'fixture-model';
async function setup(question = 'Explain enzyme engineering.', options = {}) {
  const f = await createFixture(options), wikiCalls = [], logs = [];
  f.pipeline.log = { record: (event, detail) => logs.push({ event, detail }) };
  for (const [name, text] of [['a', 'EctD thermostability improved at 30 C. Reactor pH was 7.2.'], ['b', 'EctD thermostability decreased at 50 C.'], ['unrelated', 'A different unrelated research project.']]) f.workspace.set(`literature/${name}.pdf`, text);
  f.system.literatureWiki.getPaperCardConfiguration = async () => ({ schemaVersion: 2, promptVersion: 'fixture-v1', modelSignature: model, wikiConfiguration: wikiContract.configuration(model) });
  f.system.literatureWiki.generateWikiPage = async input => {
    wikiCalls.push(input);
    return { page: wikiContract.markdownPage(`# ${input.label}\n\n` + input.papers.map(p => `${p.evidence[0].text} [[cite:${p.evidence[0].reference}]]`).join('\n\n')), configuration: input.configuration, attempts: 1 };
  };
  f.service = new ProjectContextService({ workspace: f.workspace, literature: f.literature, sourceSystem: f.system, requestPipeline: f.pipeline,
    semanticInterpreter: { interpret() { throw Error('No semantic call allowed'); } } });
  f.options = { question, surface: 'side_chat', turnId: 'demand-turn', callContext: { model } };
  f.context = await f.service.buildContext(f.options);
  f.ids = f.context.sourceMap.paperSources.map(s => s.sourceId);
  f.execute = (call, signal) => f.service.executeAgentTool(call, { turnId: f.options.turnId, signal });
  f.loop = (requestTurn, resume) => agent.runSideChatAgent({ workspaceContext: { localWorkspaceContext: backend._test.sanitizeLocalWorkspaceContext(f.context, f.options.question) },
    originalRequest: f.options.question, conversationMessages: [...(f.options.conversation?.messages || []), { role: 'user', content: f.options.question }],
    turnId: f.options.turnId, model, systemPrompt: 'Answer from sufficient evidence.', parseFinalAnswer: reply => reply ? { reply } : null,
    projectToolsEnabled: true, supportsTools: true, requestTurn, resume });
  return Object.assign(f, { wikiCalls, logs });
}
const choose = (name, args, id = name) => ({ ok: true, message: { tool_calls: [{ id, type: 'function', function: { name, arguments: JSON.stringify(args) } }] } });
async function tool(f, name, args, id = name) {
  const first = await f.loop(async () => choose(name, args, id));
  const call = first.data.desktopToolCalls?.[0];
  assert.ok(call, JSON.stringify(first));
  const result = await f.execute(call);
  assert.equal(result.result.ok, true, JSON.stringify(result));
  const signed = continuation.seal(first.continuationState, { project: 'P' }, 'fixture');
  return { result: result.result, resume: continuation.withResults(continuation.open(signed, { project: 'P' }, 'fixture'), [result]), call };
}
test('main model first: general question and conversational follow-up require only metadata; no preparation or generation', async () => {
  const f = await setup('What is a neural network?'); let calls = 0;
  for (const question of ['What is a neural network?', 'Explain that more simply.']) {
    f.options = { ...f.options, question, turnId: question, conversation: { messages: [{ role: 'assistant', content: 'A neural network learns patterns.' }] } };
    f.context = await f.service.buildContext(f.options);
    const result = await f.loop(async request => {
      calls++;
      assert.equal(f.calls.parses, 0); assert.equal(f.calls.cards, 0); assert.equal(f.wikiCalls.length, 0); assert.equal(f.workspace.rawReads, 0);
      assert.ok(request.tools.some(t => t.function.name === 'retrieve_project_evidence'));
      assert.ok(request.messages.some(m => m.content.includes(question)));
      return { ok: true, message: { content: 'It learns patterns from examples.' } };
    });
    assert.match(result.data.reply, /patterns/);
  }
  assert.equal(calls, 2); assert.deepEqual(f.workspace.state.agent.currentRecommendation, { id: 'R1' });
});
test('specific paper fact uses original evidence, signed continuation and citations, without generating any cards/wiki', async () => {
  const f = await setup('What pH did the first paper use?');
  const { result, resume, call } = await tool(f, 'retrieve_project_evidence', { query: 'pH', paper_ids: [f.ids[0]] });
  assert.equal(f.calls.parses, 1); assert.equal(f.calls.cards, 0); assert.equal(f.wikiCalls.length, 0);
  const reference = result.evidenceBundle.items[0].references[0];
  const final = await f.loop(async () => ({ ok: true, message: { content: `pH 7.2. [[cite:${reference.reference}]]` } }), resume);
  assert.equal(final.data.citations[0].sourceId, f.ids[0]);
  await f.execute(call); assert.equal(f.calls.parses, 1);
  assert.equal(f.system.registry.get(f.ids[2]).parseStatus, 'not_started');
});
test('synthesis chooses scoped cards/wiki on demand; compatible caches reuse and unrelated missing wiki never generates', async () => {
  const f = await setup();
  const { result } = await tool(f, 'search_project_knowledge', { query: 'thermostability', paper_ids: f.ids.slice(0, 2), prepare: 'wiki' });
  assert.equal(result.preparation.status, 'completed', JSON.stringify(result.preparation));
  assert.equal(f.calls.cards, 2); assert.ok(f.wikiCalls.length > 0);
  assert.equal(f.system.registry.get(f.ids[2]).paperCardStatus, 'absent');
  assert.ok(f.wikiCalls.every(input => input.papers.every(p => f.ids.slice(0, 2).includes(p.paperId || p.sourceId))));
  const before = f.wikiCalls.length;
  f.options = { ...f.options, turnId: 'warm' }; f.context = await f.service.buildContext(f.options);
  await tool(f, 'search_project_knowledge', { query: 'thermostability', paper_ids: f.ids.slice(0, 2), prepare: 'wiki' });
  assert.equal(f.calls.cards, 2); assert.equal(f.wikiCalls.length, before);
  assert.ok(f.logs.some(l => l.event === 'knowledge.derived-preparation' && l.detail.paperCardGenerationCount === 2));
});
test('metadata invalidates changed evidence without generation; only requested stale source is refreshed', async () => {
  const f = await setup();
  await tool(f, 'search_project_knowledge', { query: 'themes', paper_ids: f.ids.slice(0, 2), prepare: 'paper_cards' });
  for (const id of f.ids.slice(0, 2)) f.workspace.set(f.system.registry.get(id).path, `Changed evidence for ${id}; pH 8.0.`, Date.now() - 1000);
  f.options = { ...f.options, turnId: 'changed' }; f.context = await f.service.buildContext(f.options);
  assert.equal(f.calls.cards, 2); assert.equal(f.calls.parses, 2);
  assert.equal(f.context.sourceMap.paperSources[0].paperCardStatus, 'stale');
  await tool(f, 'search_project_knowledge', { query: 'pH', paper_ids: [f.ids[0]], prepare: 'paper_cards' });
  assert.equal(f.calls.cards, 3); assert.equal(f.calls.parses, 3);
  assert.equal(f.system.registry.get(f.ids[1]).hashStatus, 'dirty');
  const result = await f.execute({ id: 'changed-midturn', name: 'retrieve_project_evidence', args: { query: 'pH', paper_ids: [f.ids[0]] } });
  assert.equal(result.result.ok, true);
  f.workspace.set(f.system.registry.get(f.ids[0]).path, 'Changed during the conversation.', Date.now() + 20000);
  const invalid = await f.execute({ id: 'changed-again', name: 'retrieve_project_evidence', args: { query: 'pH', paper_ids: [f.ids[0]] } });
  assert.equal(invalid.result.error, 'SOURCE_VERSION_CHANGED');
});
test('failed derived preparation discloses limitations and permits original evidence; duplicate preparation does not retry', async () => {
  const f = await setup('Explain the first paper.', { cardFailure: () => true });
  const { result } = await tool(f, 'search_project_knowledge', { query: 'pH', paper_ids: [f.ids[0]], prepare: 'paper_cards' });
  assert.equal(result.preparation.status, 'partial'); assert.equal(result.preparation.failures[0].code, 'CARD_TEST_FAILURE');
  assert.ok(result.evidenceBundle.gaps.some(g => g.includes('CARD_TEST_FAILURE')));
  await tool(f, 'search_project_knowledge', { query: 'pH', paper_ids: [f.ids[0]], prepare: 'paper_cards' }, 'retry');
  assert.equal(f.calls.cards, 1);
  const original = await tool(f, 'retrieve_project_evidence', { query: 'pH', paper_ids: [f.ids[0]] });
  assert.match(original.result.files[0].content, /7.2/); assert.equal(f.calls.cards, 1);
});
test('explicit wiki check/update remain available through the selected tool; model cannot invent explicit maintenance rights', async () => {
  const f = await setup('Check literature wiki.'); let observed;
  const real = f.system.literatureWiki.maintain.bind(f.system.literatureWiki);
  f.system.literatureWiki.maintain = async options => { observed = options; return real(options); };
  await tool(f, 'search_project_knowledge', { query: 'update wiki', prepare: 'wiki', paper_ids: f.ids.slice(0, 2) });
  assert.equal(observed.action, 'check'); assert.equal(f.calls.cards, 0);
  f.options = { ...f.options, question: 'Update literature wiki.', turnId: 'update', selectedPaperIds: f.ids.slice(0, 2) };
  f.context = await f.service.buildContext(f.options);
  await tool(f, 'search_project_knowledge', { query: 'wiki', prepare: 'wiki' });
  assert.equal(observed.action, 'update'); assert.deepEqual(observed.paperIds, f.ids.slice(0, 2));
  assert.ok(f.wikiCalls.length); assert.equal(f.calls.cards, 2);
  f.options = { ...f.options, question: 'Explain the concepts.', turnId: 'no-command' }; f.context = await f.service.buildContext(f.options);
  await tool(f, 'search_project_knowledge', { query: 'update wiki', prepare: 'wiki' });
  assert.equal(observed.action, undefined);
  const denied = await f.execute({ id: 'outside', name: 'search_project_knowledge', args: { query: 'themes', prepare: 'wiki', paper_ids: [f.ids[2]] } });
  assert.equal(denied.result.error, 'SOURCE_OUTSIDE_SCOPE');
});
test('corpus preparation remains optional; derived failure does not hide measured coverage or original citations', async () => {
  const f = await setup('Review all project papers.', { cardFailure: source => source.displayName === 'b.pdf' });
  const { result } = await tool(f, 'run_corpus_workflow', { prepare: 'paper_cards' });
  assert.equal(f.calls.cards, 3); assert.equal(result.preparation.status, 'partial');
  assert.equal(result.coverage.papersIncludedInSnapshot, 3); assert.equal(result.coverage.papersSuccessfullyAnalyzed, 3);
  assert.ok(result.evidenceBundle.items.some(i => i.references.length)); assert.equal(f.wikiCalls.length, 0);
});
test('cancellation during selected preparation stops work and cannot publish stale evidence', async () => {
  const controller = new AbortController();
  const f = await setup('Synthesize the papers.', { cardBarrier: () => controller.abort() });
  const result = f.execute({ id: 'cancel', name: 'search_project_knowledge', args: { query: 'themes', prepare: 'paper_cards', paper_ids: f.ids.slice(0, 2) } }, controller.signal);
  await assert.rejects(result, { code: 'OPERATION_ABORTED' });
  assert.equal(f.calls.cards, 1); assert.equal(f.wikiCalls.length, 0); assert.deepEqual(f.context.files, []);
});

test('cold catalog handles can request lazy preparation and retain signed identity through subsequent reads', async () => {
  const f = await setup('What pH did paper a use?'); let handle;
  const first = await f.loop(async request => {
    const catalog = request.messages.find(m => /Workspace catalog of sources/.test(m.content)).content;
    handle = catalog.split('\n').find(line => /item_id=/.test(line) && /literature\/a.pdf/.test(line)).match(/item_id=([^ ]+)/)[1];
    return choose('read_paper_evidence', { item_id: handle, query: 'pH' }, 'cold');
  });
  const result = await f.execute(first.data.desktopToolCalls[0]);
  assert.equal(result.result.ok, true, JSON.stringify(result));
  const token = continuation.seal(first.continuationState, { project: 'P' }, 'fixture');
  const resumed = continuation.withResults(continuation.open(token, { project: 'P' }, 'fixture'), [result]);
  const next = await f.loop(async () => choose('read_paper_evidence', { item_id: handle, query: 'thermostability' }, 'warm-handle'), resumed);
  const warm = await f.execute(next.data.desktopToolCalls[0]);
  assert.equal(warm.result.ok, true, JSON.stringify(warm)); assert.equal(f.calls.cards, 0);
});
test('wiki provider failure retains original evidence and does not grant a fresh retry on another chat', async () => {
  const f = await setup(); let attempts = 0;
  f.system.literatureWiki.generateWikiPage = async () => { attempts++; throw Object.assign(Error('fixture failure'), { code: 'WIKI_PROVIDER_FAILURE', attempts: 1 }); };
  const args = { query: 'thermostability', prepare: 'wiki', paper_ids: f.ids.slice(0, 2) };
  const first = await tool(f, 'search_project_knowledge', args);
  assert.equal(first.result.preparation.status, 'partial'); assert.ok(attempts);
  const attempted = attempts;
  f.options = { ...f.options, turnId: 'after-wiki-failure' }; f.context = await f.service.buildContext(f.options);
  assert.equal(attempts, attempted);
  await tool(f, 'search_project_knowledge', args);
  assert.equal(attempts, attempted, 'existing evidence-attempt and cooldown policy prevents passive retries');
  const original = await tool(f, 'retrieve_project_evidence', { query: 'pH', paper_ids: [f.ids[0]] });
  assert.match(original.result.files[0].content, /7.2/);
});
