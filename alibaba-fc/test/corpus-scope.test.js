'use strict';
const test = require('node:test'), assert = require('node:assert/strict'), jwt = require('jsonwebtoken');
const backend = require('../index.js'), contract = require('../../shared/side-chat-tools.js');
const { createFixture } = require('./helpers/preflight-fixture.js');
const { ProjectContextService } = require('../../docs/project-context-service.js');
const transcript = require('../../shared/conversation-transcript.js');
const { createRuntimeLogger } = require('../../docs/runtime-log.js');
const model = 'google/gemma-4-31b-it', question = '帮我总结所有文献，写个综述。';
async function fixture(options = {}) {
  const f = await createFixture(options);
  for (let i = 1; i <= 4; i++) f.workspace.set(`literature/P${i}.pdf`, `Methane supports ectoine production in paper ${i}. Reactor pH was ${i + 5}. `.repeat(30));
  const service = new ProjectContextService({ workspace: f.workspace, literature: f.literature, sourceSystem: f.system, requestPipeline: f.pipeline });
  const request = { question, surface: 'side_chat', turnId: 'corpus-scope', language: 'zh', callContext: { model } };
  const context = await service.buildContext(request);
  f.system.corpusWorkflows.mapWorker = () => { throw Error('Per-paper provider calls forbidden'); };
  return { ...f, service, request, context, ids: context.sourceMap.paperSources.map(source => source.sourceId) };
}
function installBackend(t, respond) {
  const env = { JWT_SECRET: 'scope-fixture', ADMIN_ACCOUNT: 'scope-fixture', REQUESTY_API_KEY: 'scope-private-fixture', REQUESTY_MODEL: model };
  const before = Object.fromEntries(Object.keys(env).map(key => [key, process.env[key]])); Object.assign(process.env, env);
  t.after(() => { for (const [key, value] of Object.entries(before)) value === undefined ? delete process.env[key] : process.env[key] = value; });
  const requests = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    if (url.endsWith('/models')) return new Response(JSON.stringify({ data: [] }));
    const request = JSON.parse(options.body); requests.push(request); assert.equal(request.model, model);
    assert.ok(request.messages.some(message => message.role === 'user' && message.content.includes(question)));
    const message = respond(request, requests.length);
    return new Response(JSON.stringify({ choices: [{ message, finish_reason: message.tool_calls ? 'tool_calls' : 'stop' }] }));
  });
  const token = jwt.sign({ account: env.ADMIN_ACCOUNT, role: 'admin' }, env.JWT_SECRET);
  return { requests, send: async payload => {
    const response = await backend.handler({ httpMethod: 'POST', path: '/chat', headers: { authorization: `Bearer ${token}` }, body: JSON.stringify(payload) });
    assert.equal(response.statusCode, 200, response.body); return JSON.parse(response.body);
  } };
}
function payload(f) { return { mode: 'side_chat', originalRequest: question, model, messages: [{ role: 'user', content: question }],
  conversationTranscript: transcript.normalize(), localWorkspaceContext: f.context, callContext: { turnId: f.request.turnId, callRole: 'answer', profile: 'medium' } }; }
const toolCall = args => ({ id: 'corpus-call', type: 'function', function: { name: 'run_corpus_workflow', arguments: JSON.stringify(args) } });

test('corpus schema exposes analysis only; targeting remains on search/retrieve and legacy validation remains explicit', () => {
  const schema = contract.definitions.find(tool => tool.function.name === 'run_corpus_workflow').function.parameters;
  assert.deepEqual(Object.keys(schema.properties), ['requirement']);
  assert.deepEqual(Object.keys(schema.properties.requirement.properties), ['task', 'domains', 'granularity', 'claimSupport']);
  assert.equal(schema.required, undefined);
  assert.doesNotMatch(JSON.stringify(schema), /sourceIds|paper_ids|coverage|freshness/);
  assert.ok(contract.definitions.slice(0, 2).every(tool => tool.function.parameters.properties.requirement.properties.scope.properties.sourceIds));
  assert.throws(() => contract.validate('run_corpus_workflow', { paper_ids: ['P1'] }), { code: 'INVALID_PROJECT_TOOL_INPUT' });
  const legacy = contract.validate('run_corpus_workflow', { requirement: { coverage: 'targeted', scope: { sourceIds: ['P1'] } } });
  assert.equal(legacy.requirement.coverage, 'exhaustive');
});

for (const [selected, legacyCount, useHandle] of [[false, 0], [false, 3], [true, 0], [true, 1], [false, 1, true]]) {
  test(`real signed corpus dispatch: selected=${selected}, legacy count=${legacyCount}, current handle=${!!useHandle}`, async t => {
    const f = await fixture({ cardFailure: source => source.path.endsWith('P4.pdf') });
    const permitted = selected ? f.ids.slice(0, 2) : f.ids;
    if (selected) { f.request.selectedPaperIds = permitted; f.context = await f.service.buildContext(f.request); }
    const cardCalls = f.calls.cards, log = createRuntimeLogger({ sink: null, heartbeatMs: 0 });
    const previousLog = globalThis.BioDesignRuntimeLog; globalThis.BioDesignRuntimeLog = log;
    t.after(() => { globalThis.BioDesignRuntimeLog = previousLog; });
    const args = { requirement: { task: 'literature_review', granularity: 'concept', claimSupport: 'required',
      ...(legacyCount ? { scope: { sourceIds: permitted.slice(0, legacyCount) } } : {}) } };
    const b = installBackend(t, (request, count) => {
      if (count !== 1) return { content: '逐篇总结与综述：基于已收集证据，保留其限制。' };
      if (useHandle) {
        const catalog = request.messages.find(message => /Workspace catalog of sources/.test(message.content)).content;
        args.requirement.scope.sourceIds = [catalog.split('\n').find(line => /item_id=/.test(line) && /sourceId=/.test(line)).match(/item_id=([^ ]+)/)[1]];
      }
      return { tool_calls: [toolCall(args)] };
    });
    const initial = await b.send(payload(f)); assert.ok(initial.desktopContinuation);
    const call = initial.desktopToolCalls[0]; assert.equal(call.name, 'run_corpus_workflow');
    const response = await f.service.executeAgentTool(call, { turnId: f.request.turnId });
    assert.equal(response.result.ok, true, JSON.stringify(response));
    const result = response.result;
    assert.deepEqual(result.evidenceBundle.scope.sourceIds, permitted);
    assert.equal(result.coverage.papersSuccessfullyAnalyzed, permitted.length);
    assert.equal(result.coverage.papersMissing, 0); assert.equal(result.coverage.papersFailed, 0);
    assert.equal(result.scopeResolution.scopeOrigin, selected ? 'user_selection' : 'project');
    assert.equal(result.scopeResolution.authoritativeSourceCount, permitted.length);
    assert.equal(result.scopeResolution.legacyRequestedCount, legacyCount);
    assert.equal(result.scopeResolution.legacyArgumentsNormalized, legacyCount > 0);
    assert.ok(result.findings.papers.every(paper => paper.originalEvidence.length));
    const final = await b.send({ ...payload(f), desktopContinuation: initial.desktopContinuation, desktopToolResults: [response] });
    assert.equal(final.fallback, false); assert.equal(b.requests.length, 2);
    const receipt = b.requests[1].messages.find(message => message.tool_call_id === call.id);
    assert.deepEqual(JSON.parse(receipt.content).scopeResolution, result.scopeResolution);
    assert.ok(b.requests[1].messages.some(message => message.tool_calls?.some(item => item.id === receipt.tool_call_id)));
    assert.equal(f.calls.cards, cardCalls, 'No compatible card regenerated, even when another card failed');
    assert.equal(f.service.agentTurns.get(f.request.turnId).calls, 1);
    const warm = await f.service.executeAgentTool({ ...call, id: 'warm' }, { turnId: f.request.turnId });
    assert.equal(warm.result.coverage.papersSuccessfullyAnalyzed, permitted.length); assert.equal(f.calls.cards, cardCalls);
    assert.ok(f.workspace.writes.every(path => path.startsWith('.biodesign/')));
    assert.deepEqual(f.workspace.state.agent.currentRecommendation, { id: 'R1' });
    const diagnostic = log.entries().find(entry => entry.event === 'knowledge.access').details;
    assert.equal(diagnostic.resolvedSourceCount, permitted.length); assert.equal(diagnostic.coverageComplete, true);
    assert.doesNotMatch(log.exportText(), /Methane|scope-private-fixture|Reactor pH/);
  });
}

for (const kind of ['outside', 'unknown', 'historical', 'artifact']) test(`legacy ${kind} identifier denied before host execution`, async t => {
  const f = await fixture();
  f.request.selectedPaperIds = f.ids.slice(0, 2); f.context = await f.service.buildContext(f.request);
  let expected;
  const b = installBackend(t, (request, count) => {
    if (count > 1) return { content: '无法解析范围，未完成综述。' };
    let id = f.ids[2]; expected = 'SOURCE_OUTSIDE_SCOPE';
    // Include known outside metadata only in the backend fixture to distinguish scope denial from unknown identity.
    if (kind === 'unknown') { id = 'fabricated'; expected = 'SOURCE_IDENTIFIER_UNKNOWN'; }
    if (kind === 'historical') { id = 'turn_old:local:abc'; expected = 'SOURCE_HANDLE_EXPIRED'; }
    if (kind === 'artifact') {
      const catalog = request.messages.find(message => /Workspace catalog of sources/.test(message.content)).content;
      id = catalog.split('\n').find(line => /prior-result/.test(line)).match(/item_id=([^ ]+)/)[1];
      expected = 'SOURCE_IDENTIFIER_NOT_PAPER';
    }
    return { tool_calls: [toolCall({ requirement: { scope: { sourceIds: [id] } } })] };
  });
  if (kind === 'outside') f.context.sourceMap.paperSources.push(f.system.registry.get(f.ids[2]));
  if (kind === 'artifact') f.context.files.push({ name: 'prior-result', relativePath: '.biodesign/workflows/prior-result.json', evidenceType: 'corpus-workflow', content: 'Historical artifact.' });
  const answer = await b.send(payload(f));
  assert.equal(answer.desktopContinuation, undefined);
  const errors = b.requests.flatMap(request => request.messages.filter(message => message.role === 'tool').map(message => JSON.parse(message.content).error));
  assert.ok(errors.includes(expected), JSON.stringify(errors));
  assert.equal(f.service.agentTurns.get(f.request.turnId).calls, 0);
});

test('host reconciliation adds papers and accounts for deletions; changed evidence needs a fresh request', async () => {
  const f = await fixture();
  f.workspace.set('literature/new.pdf', 'New methane experiment.');
  await f.workspace.removeFile(f.context.sourceMap.paperSources[0].path);
  const result = (await f.service.executeAgentTool({ id: 'changed-membership', name: 'run_corpus_workflow', args: {} }, { turnId: f.request.turnId })).result;
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.scopeResolution.authoritativeSourceCount, 5);
  assert.equal(result.coverage.papersIncludedInSnapshot, 5);
  assert.equal(result.coverage.papersSuccessfullyAnalyzed, 4);
  assert.equal(result.coverage.papersMissing, 1);
  assert.equal(result.evidenceBundle.coverage.complete, false);
  const source = f.context.sourceMap.paperSources.find(source => source.sourceId === f.ids[1]);
  f.workspace.set(source.path, 'Changed source with new pH 4.2.');
  const changed = await f.service.executeAgentTool({ id: 'changed-version', name: 'run_corpus_workflow', args: {} }, { turnId: f.request.turnId });
  assert.equal(changed.result.error, 'SOURCE_VERSION_CHANGED');
  f.request.turnId = 'fresh-corpus'; f.context = await f.service.buildContext(f.request);
  const fresh = await f.service.executeAgentTool({ id: 'fresh', name: 'run_corpus_workflow', args: {} }, { turnId: f.request.turnId });
  assert.equal(fresh.result.ok, true, JSON.stringify(fresh));
  assert.equal(fresh.result.coverage.papersMissing, 1);
  assert.match(JSON.stringify(fresh.result.findings.papers.find(paper => paper.sourceId === source.sourceId)), /4\.2/);
});

test('unresolved explicit selection stays closed instead of becoming project-wide', async () => {
  const f = await fixture();
  f.context = await f.service.buildContext({ ...f.request, selectedPaperIds: [f.ids[0], 'unknown-selected-paper'] });
  const response = await f.service.executeAgentTool({ id: 'unresolved', name: 'run_corpus_workflow', args: {} }, { turnId: f.request.turnId });
  assert.equal(response.result.error, 'SOURCE_SCOPE_UNRESOLVED');
});

for (const variant of ['ambiguous', 'stale']) test(`legacy ${variant} bindings fail in resumed agent dispatch`, async () => {
  const f = await fixture(), source = f.context.sourceMap.paperSources[0], handle = 'turn_fixture:local:paper';
  const binding = { itemId: handle, kind: 'paper', sourceId: source.sourceId, contentHash: variant === 'stale' ? 'old-hash' : source.contentHash };
  let calls = 0, error;
  const result = await require('../side-chat-agent.js').runSideChatAgent({
    workspaceContext: { localWorkspaceContext: backend._test.sanitizeLocalWorkspaceContext(f.context, question) }, originalRequest: question,
    conversationMessages: [{ role: 'user', content: question }], turnId: f.request.turnId, model, systemPrompt: 'Answer in Chinese.',
    supportsTools: true, projectToolsEnabled: true, parseFinalAnswer: reply => ({ reply }),
    resume: { step: 0, originalRequest: question, agentMessages: [{ role: 'user', content: question }],
      knowledgeIdentity: { namespace: 'turn_fixture', handles: variant === 'ambiguous' ? [binding, { ...binding }] : [binding] } },
    requestTurn: async request => {
      if (!calls++) return { ok: true, message: { tool_calls: [toolCall({ requirement: { scope: { sourceIds: [handle] } } })] } };
      error = JSON.parse(request.messages.findLast(message => message.role === 'tool').content).error;
      return { ok: true, message: { content: '标识失效，综述未完成。' } };
    } });
  assert.equal(result.data.desktopToolCalls, undefined);
  assert.equal(error, variant === 'ambiguous' ? 'SOURCE_IDENTIFIER_AMBIGUOUS' : 'SOURCE_VERSION_CHANGED');
  assert.equal(f.service.agentTurns.get(f.request.turnId).calls, 0);
});

test('missing explicitly selected sources remain counted and never widen to the project', async () => {
  const f = await fixture();
  const selected = f.ids.slice(0, 2);
  await f.workspace.removeFile(f.context.sourceMap.paperSources[0].path);
  f.context = await f.service.buildContext({ ...f.request, selectedPaperIds: selected });
  const response = await f.service.executeAgentTool({ id: 'selected-missing', name: 'run_corpus_workflow', args: {} }, { turnId: f.request.turnId });
  assert.equal(response.result.ok, true, JSON.stringify(response));
  assert.deepEqual(response.result.evidenceBundle.scope.sourceIds, selected);
  assert.equal(response.result.coverage.papersIncludedInSnapshot, 2);
  assert.equal(response.result.coverage.papersMissing, 1);
  assert.equal(response.result.coverage.papersSuccessfullyAnalyzed, 1);
});
