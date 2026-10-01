'use strict';
const test = require('node:test'), assert = require('node:assert/strict'), jwt = require('jsonwebtoken');
const backend = require('../index.js'), transcript = require('../../shared/conversation-transcript.js');
const { createFixture } = require('./helpers/preflight-fixture.js');
const { ProjectContextService } = require('../../docs/project-context-service.js');
const model = 'google/gemma-4-31b-it', question = 'SurfDock的源代码仓库在哪里？';
const url = 'https://github.com/example-science/SurfDock/tree/main?tab=readme';
async function fixture() {
  const f = await createFixture();
  f.workspace.set('literature/SurfDock.pdf', 'SurfDock fixture with code availability, results and references.');
  f.workspace.set('literature/Other.pdf', 'Other paper, not selected.');
  // Seed existing derived artifacts explicitly; request context preparation is metadata-only.
  await f.pipeline.preflight({ turnId: "seed-fixture" });
  f.service = new ProjectContextService({ workspace: f.workspace, literature: f.literature, sourceSystem: f.system, requestPipeline: f.pipeline });
  const options = { question, turnId: 'targeted-turn', surface: 'side_chat', callContext: { model }, language: 'zh' };
  const initial = await f.service.buildContext(options);
  f.source = initial.sourceMap.paperSources.find(source => /SurfDock/.test(source.path));
  f.options = { ...options, selectedPaperIds: [f.source.sourceId] }; f.context = await f.service.buildContext(f.options);
  f.artifact = await f.system.preparation.readPaperArtifact(f.source.sourceId);
  f.artifact.chunks = [
    ...Array.from({ length: 6 }, (_, index) => ({ chunkId: `early-${index}`, page: index + 1, section: 'Performance', text: (`SurfDock source code performance scores in table ${index}. `).repeat(250) })),
    { chunkId: 'competitor', page: 17, section: 'Comparison', text: 'For comparison, DiffDock code availability: we reran the baseline from its source codes and weights at https://github.com/gcorso/DiffDock . This is a competing method.' },
    { chunkId: 'late', page: 22, section: 'Code availability', text: 'Background methods and uninformative table values. '.repeat(1000) + `\nCode availability\nThe SurfDock source code is freely available at ${url} . See the repository README for installation.` },
    { chunkId: 'late-overlap', page: 22, section: 'Code availability', text: `Code availability\nThe SurfDock source code is freely available at ${url} . See the repository README for installation.` },
  ];
  await f.workspace.writeJson(f.system.registry.get(f.source.sourceId).artifacts.paperText.path, f.artifact);
  f.system.corpusWorkflows.run = () => { throw Error('No corpus substitute'); };
  f.read = args => f.service.executeAgentTool({ id: JSON.stringify(args), name: 'retrieve_project_evidence', args: { paper_ids: [f.source.sourceId], ...args } }, { turnId: f.options.turnId });
  return f;
}
async function dispatch(t, f, respond) {
  const env = { JWT_SECRET: 'targeted-fixture', ADMIN_ACCOUNT: 'targeted-fixture', REQUESTY_API_KEY: 'private-fixture', REQUESTY_MODEL: model };
  const before = Object.fromEntries(Object.keys(env).map(key => [key, process.env[key]])); Object.assign(process.env, env);
  t.after(() => { for (const [key, value] of Object.entries(before)) value === undefined ? delete process.env[key] : process.env[key] = value; });
  const requests = [], receipts = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    if (url.endsWith('/models')) return new Response(JSON.stringify({ data: [] }));
    const body = JSON.parse(options.body); requests.push(body); assert.equal(body.model, model);
    const message = respond(body, requests.length);
    return new Response(JSON.stringify({ choices: [{ message }] }));
  });
  const token = jwt.sign({ account: env.ADMIN_ACCOUNT, role: 'admin' }, env.JWT_SECRET);
  let extra = {}, result;
  for (let round = 0; round < 5; round++) {
    const response = await backend.handler({ httpMethod: 'POST', path: '/chat', headers: { authorization: `Bearer ${token}` }, body: JSON.stringify({
      mode: 'side_chat', model, originalRequest: question, messages: [{ role: 'user', content: question }], localWorkspaceContext: f.context,
      conversationTranscript: transcript.normalize(), callContext: { turnId: f.options.turnId, callRole: 'answer', profile: 'medium' }, ...extra }) });
    assert.equal(response.statusCode, 200, response.body); result = JSON.parse(response.body);
    if (!result.desktopToolCalls) break;
    const batch = [];
    for (const call of result.desktopToolCalls) batch.push(await f.service.executeAgentTool(call, { turnId: f.options.turnId }));
    receipts.push(...batch); extra = { desktopContinuation: result.desktopContinuation, desktopToolResults: batch };
  }
  return { result, requests, receipts };
}
const call = (f, query, id, extra = {}) => ({ id, type: 'function', function: { name: 'retrieve_project_evidence', arguments: JSON.stringify({ query, paper_ids: [f.source.sourceId], ...extra }) } });

test('late target repository survives relevance allocation, long-chunk centering and signed model dispatch', async t => {
  const f = await fixture(), cards = f.calls.cards, saved = JSON.stringify(f.artifact);
  const outcome = await dispatch(t, f, (body, count) => count === 1
    ? { tool_calls: [call(f, question, 'target', { max_characters: 1600 })] }
    : { content: `找到了代码可用性声明。[[cite:${f.source.sourceId}:p22:late]]` });
  assert.equal(outcome.result.fallback, false); assert.equal(outcome.requests.length, 2);
  const result = outcome.receipts[0].result;
  assert.equal(result.ok, true); assert.ok(result.files[0].content.length <= 1600);
  assert.ok(result.files[0].content.includes(url));
  assert.match(result.files[0].content, /source code is freely available/);
  assert.equal(result.retrievalDetails.needsRefinement, false);
  assert.ok(result.retrievalDetails.sources[0].omittedMatchingChunks > 0);
  assert.ok(result.retrievalDetails.sources[0].deliveredPages.includes(22));
  assert.equal(result.files[0].contentHash, f.source.contentHash);
  const received = outcome.requests[1].messages.find(message => message.tool_call_id === 'target');
  assert.equal(received.content, JSON.stringify(result));
  assert.equal(outcome.result.conversationTurn.messages.find(message => message.tool_call_id === 'target').content, received.content);
  assert.ok(outcome.result.citations.some(citation => citation.sourceId === f.source.sourceId && citation.page === 22));
  assert.equal(JSON.stringify(await f.system.preparation.readPaperArtifact(f.source.sourceId)), saved);
  assert.equal(f.calls.cards, cards);
  assert.ok(f.workspace.writes.every(path => path.startsWith('.biodesign/')));
  assert.deepEqual(f.workspace.state.agent.currentRecommendation, { id: 'R1' });
});

test('targeted results deduplicate overlapping availability excerpts and distinguish competing-method URLs', async () => {
  const f = await fixture();
  const result = (await f.read({ query: question })).result;
  assert.equal(result.files[0].content.split(url).length - 1, 1);
  assert.ok(result.retrievalDetails.sources[0].overlappingExcerptsReduced > 0);
  const competitor = (await f.read({ query: question, page: 17 })).result;
  assert.match(competitor.files[0].content, /gcorso\/DiffDock/);
  assert.equal(competitor.retrievalDetails.needsRefinement, true);
  assert.deepEqual(competitor.retrievalDetails.sources[0].availabilitySignals, ['other_method_repository']);
  const noMatch = (await f.read({ query: 'SurfDock nonexistentkeyword' })).result;
  assert.equal(noMatch.retrievalStatus, 'no_matching_evidence');
  assert.equal(noMatch.retrievalDetails.needsRefinement, true);
  assert.equal(noMatch.retrievalDetails.sources[0].matchingChunks, 0);
  assert.match(noMatch.limitation, /do not establish absence/);
});

test('one completion check permits useful targeted refinement and blocks identical unsuccessful reads', async t => {
  const f = await fixture(), cards = f.calls.cards;
  const outcome = await dispatch(t, f, (body, count) => {
    if (count === 1) return { tool_calls: [call(f, 'SurfDock performance repository', 'weak', { page: 1 })] };
    if (count === 2) return { content: '尚未找到仓库。' };
    if (count === 3) {
      assert.ok(body.messages.some(message => /One bounded evidence completion check/.test(message.content)));
      return { tool_calls: [call(f, 'SurfDock performance repository', 'duplicate', { page: 1 })] };
    }
    if (count === 4) {
      assert.equal(JSON.parse(body.messages.findLast(message => message.role === 'tool').content).error, 'EVIDENCE_REFINEMENT_REQUIRED');
      return { tool_calls: [call(f, 'SurfDock code availability repository', 'refined', { max_characters: 1600 })] };
    }
    return { content: '已检查指定来源；请依据返回的完整原文判断仓库归属。' };
  });
  assert.equal(outcome.receipts.length, 2, 'duplicate read was not handed to the host');
  assert.equal(outcome.requests.length, 5);
  assert.ok(outcome.receipts[1].result.files[0].content.includes(url));
  assert.equal(outcome.receipts[1].result.retrievalDetails.needsRefinement, false);
  assert.equal(f.service.agentTurns.get(f.options.turnId).calls, 2);
  assert.equal(outcome.result.fallback, false);
  assert.equal(f.calls.cards, cards);
});

test('tiny bounds omit an unfit complete URL rather than returning a guessed or partial link', async () => {
  const f = await fixture();
  f.artifact.chunks = [{ chunkId: 'long-url', page: 22, text: `Code availability: https://github.com/example/SurfDock/${'a'.repeat(400)} ` }];
  await f.workspace.writeJson(f.system.registry.get(f.source.sourceId).artifacts.paperText.path, f.artifact);
  const result = (await f.read({ query: question, max_characters: 200 })).result;
  assert.equal(result.ok, true); assert.equal(result.files.length, 0);
  assert.equal(result.retrievalDetails.needsRefinement, true);
});


test('unresolved evidence stops after one completion check and persists the explicit limitation', async t => {
  const f = await fixture();
  const outcome = await dispatch(t, f, (body, count) => count === 1
    ? { tool_calls: [call(f, 'SurfDock nonexistentkeyword', 'no-match')] }
    : { content: '在所检索证据中未找到该信息。' });
  assert.equal(outcome.requests.length, 3);
  assert.equal(outcome.receipts.length, 1);
  assert.equal(outcome.result.fallback, false);
  const answer = outcome.result.conversationTurn.messages.at(-1).content;
  assert.match(answer, /检索限制/);
  assert.match(answer, /不能证明/);
  assert.match(answer, /9 个候选片段/);
});
