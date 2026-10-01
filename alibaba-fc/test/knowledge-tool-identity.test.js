'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { createFixture } = require('./helpers/preflight-fixture.js');
const { ProjectContextService } = require('../../docs/project-context-service.js');
const contract = require('../../shared/side-chat-tools.js');
const agent = require('../side-chat-agent.js'), backend = require('../index.js');
const continuation = require('../agent-continuation.js'), transcript = require('../../shared/conversation-transcript.js');
const model = 'google/gemma-4-31b-it', question = 'SurfDock有源代码吗？';
const toolCall = (name, args, id = name) => ({ id, type: 'function', function: { name, arguments: JSON.stringify(args) } });
async function fixture(options = {}) {
  const f = await createFixture(options);
  f.workspace.set('literature/SurfDock.pdf', 'SurfDock code availability: https://example.invalid/SurfDock. The reactor pH was 7.2.');
  f.workspace.set('literature/Other.pdf', 'Other unrelated work on reactor design.');
  f.service = new ProjectContextService({ workspace: f.workspace, literature: f.literature, sourceSystem: f.system, requestPipeline: f.pipeline,
    semanticInterpreter: { interpret() { throw Error('No planner for routine reads'); } } });
  f.options = { question, surface: 'side_chat', turnId: 'identity-turn', callContext: { model } };
  // Seed a previously prepared workspace; ordinary chat no longer warms artifacts.
  await f.pipeline.preflight(f.options);
  f.context = await f.service.buildContext(f.options);
  f.paper = f.context.sourceMap.paperSources.find(source => /SurfDock/.test(source.path));
  return f;
}
const run = (f, requestTurn, extra = {}) => agent.runSideChatAgent({
  workspaceContext: { localWorkspaceContext: backend._test.sanitizeLocalWorkspaceContext(f.context, question) },
  originalRequest: question, conversationMessages: [{ role: 'user', content: question }], conversationTranscript: transcript.normalize(),
  turnId: f.options.turnId, model, systemPrompt: 'Answer only from sufficient evidence.', parseFinalAnswer: reply => ({ reply }),
  supportsTools: true, projectToolsEnabled: true, requestTurn, ...extra,
});
const catalogHandle = messages => {
  const catalog = messages.find(message => /Workspace catalog of sources/.test(message.content))?.content;
  const line = catalog.split('\n').find(line => /item_id=/.test(line) && /SurfDock/.test(line));
  assert.match(line, /sourceId=.*paper_id=/);
  return line.match(/item_id=([^ ]+)/)[1];
};

test('shared identity resolver distinguishes exact bindings, ambiguity, stale versions, historical handles, artifacts and hard scope', () => {
  const scope = { namespace: 'turn_current', allowedIds: ['P1'], sources: [
    { sourceId: 'P1', contentHash: 'v1' }, { sourceId: 'P2', contentHash: 'private-version' }],
    handles: [{ itemId: 'turn_current:local:abc', kind: 'paper', sourceId: 'P1', contentHash: 'v1' },
      { itemId: 'turn_current:local:artifact', kind: 'artifact' }] };
  assert.equal(contract.resolveSourceId('P1', scope), 'P1');
  assert.equal(contract.resolveSourceId('turn_current:local:abc', scope), 'P1');
  for (const [id, code] of [['fabricated', 'SOURCE_IDENTIFIER_UNKNOWN'], ['turn_old:local:abc', 'SOURCE_HANDLE_EXPIRED'],
    ['turn_current:local:artifact', 'SOURCE_IDENTIFIER_NOT_PAPER'], ['P2', 'SOURCE_OUTSIDE_SCOPE']]) {
    assert.throws(() => contract.resolveSourceId(id, scope), error => error.code === code && !/private-version|P2/.test(error.message));
  }
  assert.throws(() => contract.resolveSourceId('turn_current:local:abc', { ...scope, handles: [...scope.handles, { ...scope.handles[0], sourceId: 'P2' }] }), { code: 'SOURCE_IDENTIFIER_AMBIGUOUS' });
  assert.throws(() => contract.resolveSourceId('turn_current:local:abc', { ...scope, sources: [{ sourceId: 'P1', contentHash: 'v2' }] }), { code: 'SOURCE_VERSION_CHANGED' });
  assert.throws(() => contract.resolveSourceId('P1', { ...scope, sources: [{ sourceId: 'P1', catalogStatus: 'missing' }] }), { code: 'SOURCE_DELETED' });
});

test('authenticated FC and host dispatch resolve catalog handles, read metadata-only L1 through legacy adapter, resume and replay without reexecution', async t => {
  const f = await fixture({ cardFailure: () => true });
  assert.deepEqual(f.context.files, []); assert.equal(f.paper.paperCardStatus, 'failed');
  const cards = f.calls.cards;
  f.system.corpusWorkflows.run = () => { throw Error('No corpus workaround for a single paper'); };
  const jwt = require('jsonwebtoken'), env = { JWT_SECRET: 'identity-fixture', ADMIN_ACCOUNT: 'identity-fixture', REQUESTY_API_KEY: 'identity-fixture-key', REQUESTY_MODEL: model };
  const previous = Object.fromEntries(Object.keys(env).map(key => [key, process.env[key]])); Object.assign(process.env, env);
  t.after(() => { for (const [key, value] of Object.entries(previous)) value === undefined ? delete process.env[key] : process.env[key] = value; });
  const requests = []; let itemId, reference;
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    if (url.endsWith('/models')) return new Response(JSON.stringify({ data: [] }));
    const request = JSON.parse(options.body); requests.push(request);
    assert.equal(request.model, model); assert.equal(request.response_format, undefined);
    let message;
    if (requests.length === 1) {
      itemId = catalogHandle(request.messages);
      message = { tool_calls: ['search_project_knowledge', 'retrieve_project_evidence'].map((name, index) => toolCall(name,
        { query: 'source code', requirement: { scope: { type: 'single_source', sourceIds: [itemId] } } }, `call-${index}`)) };
    } else if (requests.length === 2) {
      const results = request.messages.filter(message => message.role === 'tool').map(message => JSON.parse(message.content));
      assert.equal(results.length, 2); assert.ok(results.every(result => result.ok));
      assert.deepEqual(results[0].evidenceBundle.scope.sourceIds, [f.paper.sourceId]);
      assert.deepEqual(results[1].evidenceBundle.scope.sourceIds, [f.paper.sourceId]);
      reference = results[1].evidenceBundle.items[0].references[0].reference;
      message = { tool_calls: [toolCall('read_paper_evidence', { item_id: itemId, evidence_ref: reference, max_characters: 500 }, 'legacy')] };
    } else {
      const legacy = JSON.parse(request.messages.findLast(message => message.role === 'tool').content);
      assert.equal(legacy.paper_id, f.paper.sourceId); assert.match(legacy.content, /code availability/);
      assert.equal(legacy.evidence_citations[0].page, 1);
      assert.equal(legacy.evidenceBundle.items[0].derived, false);
      message = { content: `找到了源码说明。[[cite:${reference}]]` };
    }
    return new Response(JSON.stringify({ choices: [{ message, finish_reason: message.tool_calls ? 'tool_calls' : 'stop' }] }));
  });
  const token = jwt.sign({ account: env.ADMIN_ACCOUNT, role: 'admin' }, env.JWT_SECRET);
  const payload = { mode: 'side_chat', originalRequest: question, messages: [{ role: 'user', content: question }],
    conversationTranscript: transcript.normalize(), localWorkspaceContext: f.context,
    callContext: { turnId: f.options.turnId, callRole: 'answer', profile: 'medium' } };
  const invoke = async body => {
    const response = await backend.handler({ httpMethod: 'POST', path: '/chat', headers: { authorization: `Bearer ${token}` }, body: JSON.stringify(body) });
    assert.equal(response.statusCode, 200); return JSON.parse(response.body);
  };
  let data = await invoke(payload);
  for (let round = 0; round < 2; round++) {
    assert.ok(data.desktopContinuation); assert.equal(data.fallback, false);
    const results = [];
    for (const call of data.desktopToolCalls) {
      assert.equal(call.args.paper_id || call.args.requirement.scope.sourceIds[0], f.paper.sourceId);
      const result = await f.service.executeAgentTool(call, { turnId: f.options.turnId });
      assert.equal(result.result.ok, true, JSON.stringify(result)); results.push(result);
    }
    data = await invoke({ ...payload, desktopContinuation: data.desktopContinuation, desktopToolResults: results });
  }
  assert.equal(requests.length, 3); assert.equal(data.citations[0].sourceId, f.paper.sourceId); assert.equal(data.citations[0].page, 1);
  assert.deepEqual(data.conversationTurn.messages.map(message => message.role), ['user', 'assistant', 'tool', 'tool', 'assistant', 'tool', 'assistant']);
  assert.equal(data.conversationTurn.model, model); assert.equal(f.calls.cards, cards);
  const executed = f.service.agentTurns.get(f.options.turnId).calls;
  await invoke({ ...payload, originalRequest: '上次找到了什么？', messages: [{ role: 'user', content: '上次找到了什么？' }],
    conversationTranscript: transcript.upsert(null, data.conversationTurn), callContext: { ...payload.callContext, turnId: 'follow-up' } });
  assert.equal(f.service.agentTurns.get(f.options.turnId).calls, executed);
  assert.ok(f.workspace.writes.every(path => path.startsWith('.biodesign/')));
  assert.deepEqual(f.workspace.state.agent.currentRecommendation, { id: 'R1' });
});

for (const name of ['search_project_knowledge', 'retrieve_project_evidence']) test(`${name} resolves stable IDs and rejects historical/fabricated/artifact handles through the actual loop`, async () => {
  const f = await fixture();
  f.context.files.push({ name: 'Corpus artifact', relativePath: '.biodesign/workflows/test.json', evidenceType: 'corpus-workflow', content: '{}' });
  for (const variant of ['historical', 'fabricated', 'unknown-current', 'artifact', 'stable']) {
    let round = 0, requested, observed;
    const result = await run(f, async request => {
      if (!round++) {
        const handle = catalogHandle(request.messages);
        const catalog = request.messages.find(message => /Workspace catalog of sources/.test(message.content)).content;
        requested = variant === 'stable' ? f.paper.sourceId : variant === 'historical' ? handle.replace(/^turn_[^:]+/, 'turn_expired')
          : variant === 'unknown-current' ? handle.replace(/:[^:]+$/, ':fabricated') : variant === 'artifact' ? catalog.split('\n').find(line => /test.json/.test(line)).match(/item_id=([^ ]+)/)[1] : 'turn_fabricated:local:abc';
        return { ok: true, message: { tool_calls: [toolCall(name, { query: 'code', requirement: { scope: { sourceIds: [requested] } } })] } };
      }
      observed = JSON.parse(request.messages.findLast(message => message.role === 'tool').content);
      return { ok: true, message: { content: '无法使用该标识，请使用当前论文编号。' } };
    });
    if (variant === 'stable') assert.equal(result.data.desktopToolCalls[0].args.requirement.scope.sourceIds[0], f.paper.sourceId);
    else {
      assert.equal(result.data.desktopToolCalls, undefined);
      assert.equal(observed.error, variant === 'artifact' ? 'SOURCE_IDENTIFIER_NOT_PAPER' : variant === 'unknown-current' ? 'SOURCE_IDENTIFIER_UNKNOWN' : 'SOURCE_HANDLE_EXPIRED');
      assert.ok(observed.message); assert.doesNotMatch(JSON.stringify(observed), /literature\//);
    }
  }
});

for (const deleted of [false, true]) test(`host ${deleted ? 'deletion' : 'source modification'} invalidates stable and handle-resolved evidence before publication`, async () => {
  const f = await fixture();
  const first = await run(f, async request => ({ ok: true, message: { tool_calls: [toolCall('retrieve_project_evidence', { query: 'code', paper_ids: [catalogHandle(request.messages)] })] } }));
  if (deleted) f.workspace.files.delete(f.paper.path);
  else f.workspace.set(f.paper.path, 'Changed source with new contents', Date.now());
  const result = await f.service.executeAgentTool(first.data.desktopToolCalls[0], { turnId: f.options.turnId });
  assert.equal(result.result.ok, false); assert.equal(result.result.error, deleted ? 'SOURCE_DELETED' : 'SOURCE_VERSION_CHANGED');
  assert.equal(result.result.files, undefined); assert.deepEqual(f.context.citationEvidence, []);
});

test('legacy exact references, bounded offsets, argument conflicts, no matches and hard selections remain enforced', async () => {
  const f = await fixture();
  const source = f.system.registry.get(f.paper.sourceId), artifact = await f.system.preparation.readPaperArtifact(source.sourceId);
  artifact.chunks = [{ chunkId: 'methods', page: 4, text: 'The measured pH was 7.2. ' + 'Evidence text. '.repeat(150), section: 'Methods' }];
  await f.workspace.writeJson(source.artifacts.paperText.path, artifact);
  const invoke = async (args, id) => (await f.service.executeAgentTool({ id, name: 'read_paper_evidence', args }, { turnId: f.options.turnId })).result;
  const first = await invoke({ paper_id: source.sourceId, evidence_ref: `${source.sourceId}:p4:methods`, max_characters: 200 }, 'first');
  assert.equal(first.ok, true); assert.ok(first.content.length <= 200); assert.ok(first.next_offset > 0);
  assert.equal(first.evidence_citations[0].page, 4); assert.match(first.content, /7.2/);
  const next = await invoke({ paper_id: source.sourceId, evidence_ref: `${source.sourceId}:p4:methods`, max_characters: 200, offset: first.next_offset }, 'next');
  assert.equal(next.ok, true); assert.doesNotMatch(next.content, /7.2/); assert.match(next.content, /\[\[cite:/);
  assert.equal((await invoke({ paper_id: source.sourceId, evidence_ref: `${source.sourceId}:p99:fake` }, 'bad-ref')).error, 'EVIDENCE_REFERENCE_NOT_FOUND');
  const absent = await invoke({ paper_id: source.sourceId, query: 'nonexistentkeyword' }, 'absent');
  assert.equal(absent.retrievalStatus, 'no_matching_evidence'); assert.equal(absent.content, ''); assert.match(absent.limitation, /Missing matches do not establish absence/);
  await assert.rejects(invoke({ paper_id: source.sourceId, path: '/private/paper.pdf' }, 'bad-arg'), { code: 'INVALID_PROJECT_TOOL_INPUT' });
  const other = f.context.sourceMap.paperSources.find(item => item.sourceId !== source.sourceId).sourceId;
  assert.equal((await invoke({ paper_id: source.sourceId, item_id: other }, 'conflict')).error, 'SOURCE_IDENTIFIER_MISMATCH');
  await f.service.buildContext({ ...f.options, turnId: 'selected', selectedPaperIds: [source.sourceId] });
  for (const name of ['read_paper_evidence', 'retrieve_project_evidence', 'search_project_knowledge']) {
    const denied = await f.service.executeAgentTool({ id: name, name, args: name === 'read_paper_evidence' ? { paper_id: other } : { query: 'code', paper_ids: [other] } }, { turnId: 'selected' });
    assert.equal(denied.result.error, 'SOURCE_OUTSIDE_SCOPE'); assert.equal(denied.result.files, undefined);
  }
});

test('signed continuation retains immutable handle bindings and refuses ambiguous or changed bindings in the next model step', async () => {
  for (const changed of [false, true]) {
    const f = await fixture(); let handle;
    const first = await run(f, async request => {
      handle = catalogHandle(request.messages);
      return { ok: true, message: { tool_calls: [toolCall('search_project_knowledge', { query: 'SurfDock', paper_ids: [handle] }, 'orientation')] } };
    });
    const result = await f.service.executeAgentTool(first.data.desktopToolCalls[0], { turnId: f.options.turnId });
    assert.equal(result.result.ok, true);
    if (changed) f.context.sourceMap.paperSources.find(source => source.sourceId === f.paper.sourceId).contentHash = 'new-version';
    else first.continuationState.knowledgeIdentity.handles.push({ itemId: handle, kind: 'paper', sourceId: 'another-paper', contentHash: 'other-version' });
    const signed = continuation.seal(first.continuationState, { turn: f.options.turnId }, 'fixture-secret');
    const resumed = continuation.withResults(continuation.open(signed, { turn: f.options.turnId }, 'fixture-secret'), [result]);
    let round = 0;
    const final = await run(f, async request => {
      if (!round++) return { ok: true, message: { tool_calls: [toolCall('retrieve_project_evidence', { query: 'code', paper_ids: [handle] }, 'read')] } };
      assert.equal(JSON.parse(request.messages.findLast(message => message.role === 'tool').content).error, changed ? 'SOURCE_VERSION_CHANGED' : 'SOURCE_IDENTIFIER_AMBIGUOUS');
      return { ok: true, message: { content: '当前标识需要刷新。' } };
    }, { resume: resumed });
    assert.equal(final.data.desktopToolCalls, undefined);
    assert.equal(f.service.agentTurns.get(f.options.turnId).calls, 1);
  }
});

test('missing cached extraction uses permitted local preparation, never Paper Card regeneration', async () => {
  const f = await fixture();
  const source = f.system.registry.get(f.paper.sourceId), card = await f.workspace.readJson(source.artifacts.paperCard.path);
  const cards = f.calls.cards, parses = f.calls.parses;
  f.workspace.files.delete(source.artifacts.paperText.path);
  source.parseStatus = source.indexStatus = 'not_started';
  const result = await f.service.executeAgentTool({ id: 'recover-local', name: 'read_paper_evidence', args: { paper_id: source.sourceId, query: 'code' } }, { turnId: f.options.turnId });
  assert.equal(result.result.ok, true, JSON.stringify(result)); assert.equal(result.result.failures.length, 0, JSON.stringify(result)); assert.match(result.result.content, /code availability/);
  assert.equal(f.calls.parses, parses + 1); assert.equal(f.calls.cards, cards);
  assert.deepEqual(await f.workspace.readJson(source.artifacts.paperCard.path), card);
});

test('page and section queries with no match return a gap instead of arbitrary original evidence', async () => {
  const f = await fixture();
  for (const granularity of ['page', 'section']) {
    const result = await f.service.executeAgentTool({ id: granularity, name: 'retrieve_project_evidence', args: {
      query: 'nonexistentkeyword', paper_ids: [f.paper.sourceId], requirement: { granularity } } }, { turnId: f.options.turnId });
    assert.equal(result.result.ok, true); assert.equal(result.result.files.length, 0);
    assert.equal(result.result.retrievalStatus, 'no_matching_evidence');
    assert.equal(result.result.evidenceBundle.coverage.complete, false);
    assert.ok(result.result.evidenceBundle.gaps.some(gap => /not proof of absence/.test(gap)));
  }
});

test('section refinement without section boundaries returns only matched passages, not arbitrary chunks', async () => {
  const f = await fixture();
  const source = f.system.registry.get(f.paper.sourceId), artifact = await f.system.preparation.readPaperArtifact(source.sourceId);
  artifact.chunks = [{ chunkId: 'code', page: 4, text: 'Code availability: repository example.', section: '' },
    { chunkId: 'noise', page: 5, text: 'UNRELATED_DISTRACTOR acknowledgements.', section: '' }];
  await f.workspace.writeJson(source.artifacts.paperText.path, artifact);
  const result = await f.service.executeAgentTool({ id: 'section-refinement', name: 'retrieve_project_evidence', args: {
    query: 'code availability', paper_ids: [source.sourceId], requirement: { granularity: 'section' } } }, { turnId: f.options.turnId });
  assert.equal(result.result.ok, true); assert.doesNotMatch(JSON.stringify(result), /UNRELATED_DISTRACTOR/);
  assert.equal(result.result.evidenceBundle.items[0].evidenceKind, 'original_passage');
  assert.ok(result.result.evidenceBundle.gaps.some(gap => /Section boundaries unavailable/.test(gap)));
});
