'use strict';
const test = require('node:test'), assert = require('node:assert/strict'), jwt = require('jsonwebtoken');
const backend = require('../index.js'), continuation = require('../agent-continuation.js');
const contract = require('../../shared/side-chat-tools.js'), transcript = require('../../shared/conversation-transcript.js');
const { createFixture } = require('./helpers/preflight-fixture.js');
const { ProjectContextService } = require('../../docs/project-context-service.js');
const model = 'google/gemma-4-31b-it', question = '请读取这些论文的代码说明和相关证据。';
async function fixture(count = 1, escaped = false) {
  const f = await createFixture();
  for (let i = 0; i < count; i++) {
    const text = escaped ? 'code availability \\"math\\" \\psi\n'.repeat(1800) : Array.from({ length: 1800 }, (_, index) => `code availability evidence record ${index} with distinct measurements. `).join('');
    f.workspace.set(`literature/P${i}.pdf`, text.slice(0, 18000) + ` BEYOND_12000_P${i} ` + text.slice(18000));
  }
  const service = new ProjectContextService({ workspace: f.workspace, literature: f.literature, sourceSystem: f.system, requestPipeline: f.pipeline });
  const options = { question, surface: 'side_chat', turnId: 'budget-turn', callContext: { model }, language: 'zh' };
  const context = await service.buildContext(options);
  f.system.corpusWorkflows.run = () => { throw Error('No corpus workflow or mapper for reads'); };
  return { ...f, service, options, context, ids: context.sourceMap.paperSources.map(source => source.sourceId) };
}
async function dispatch(t, f, args, { name = 'retrieve_project_evidence', parallel = false } = {}) {
  const env = { JWT_SECRET: 'budget-fixture', ADMIN_ACCOUNT: 'budget-fixture', REQUESTY_API_KEY: 'private-budget-fixture', REQUESTY_MODEL: model };
  const previous = Object.fromEntries(Object.keys(env).map(key => [key, process.env[key]])); Object.assign(process.env, env);
  t.after(() => { for (const [key, value] of Object.entries(previous)) value === undefined ? delete process.env[key] : process.env[key] = value; });
  const requests = [], logs = []; t.mock.method(console, 'info', (...entry) => logs.push(entry));
  const calls = Array.from({ length: parallel ? 2 : 1 }, (_, i) => ({ id: `read-${i}`, type: 'function', function: { name, arguments: JSON.stringify(args) } }));
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    if (url.endsWith('/models')) return new Response(JSON.stringify({ data: [] }));
    const body = JSON.parse(options.body); requests.push(body); assert.equal(body.model, model);
    return new Response(JSON.stringify({ choices: [{ message: requests.length === 1 ? { tool_calls: calls } : { content: '已读取当前原始证据，保留检索范围限制。' } }] }));
  });
  const token = jwt.sign({ account: env.ADMIN_ACCOUNT, role: 'admin' }, env.JWT_SECRET);
  const payload = { mode: 'side_chat', model, originalRequest: question, messages: [{ role: 'user', content: question }],
    localWorkspaceContext: f.context, conversationTranscript: transcript.normalize(), callContext: { turnId: f.options.turnId, callRole: 'answer', profile: 'medium' } };
  const send = async extra => {
    const response = await backend.handler({ httpMethod: 'POST', path: '/chat', headers: { authorization: `Bearer ${token}` }, body: JSON.stringify({ ...payload, ...extra }) });
    assert.equal(response.statusCode, 200, response.body); return JSON.parse(response.body);
  };
  const cards = f.calls.cards, first = await send({}); assert.ok(first.desktopContinuation);
  const receipts = [];
  for (const call of first.desktopToolCalls) receipts.push(await f.service.executeAgentTool(call, { turnId: f.options.turnId }));
  assert.ok(JSON.stringify(receipts).length < 180000);
  for (const receipt of receipts) {
    assert.equal(receipt.result.ok, true, JSON.stringify(receipt));
    assert.ok(JSON.stringify(receipt.result).length <= 64000);
  }
  const final = await send({ desktopContinuation: first.desktopContinuation, desktopToolResults: receipts });
  assert.equal(final.fallback, false); assert.equal(requests.length, 2);
  assert.equal(final.semanticTelemetry.contextRecovery.compactionCount, 0);
  const visible = requests[1].messages.filter(message => message.role === 'tool');
  assert.equal(visible.length, receipts.length);
  for (const [i, message] of visible.entries()) {
    assert.equal(message.content, JSON.stringify(receipts[i].result), 'No backend/history prefix shrinking on the initial provider attempt');
    assert.ok(requests[1].messages.some(item => item.tool_calls?.some(call => call.id === message.tool_call_id)));
    assert.equal(final.conversationTurn.messages.find(item => item.tool_call_id === message.tool_call_id).content, message.content);
  }
  assert.equal(f.calls.cards, cards); assert.ok(f.workspace.writes.every(path => path.startsWith('.biodesign/')));
  assert.deepEqual(f.workspace.state.agent.currentRecommendation, { id: 'R1' });
  assert.doesNotMatch(JSON.stringify(logs), /BEYOND_12000|private-budget-fixture/);
  return receipts[0].result;
}

for (const count of [1, 2, 8]) test(`original evidence budget reaches selected model intact for ${count} papers`, async t => {
  const f = await fixture(count);
  const result = await dispatch(t, f, { query: 'code availability', paper_ids: f.ids }, { parallel: count === 8 });
  assert.equal(result.files.length, count);
  const limit = Math.min(30000, Math.floor(Math.min(48000, 64000 - 4000 - 3000 * count) / count));
  assert.equal(result.evidenceBudget.requestedCharactersPerPaper, 30000);
  assert.equal(result.evidenceBudget.effectiveCharactersPerPaper, limit);
  assert.ok(result.files.reduce((sum, file) => sum + JSON.stringify(file.content).length - 2, 0) <= 48000);
  for (const file of result.files) {
    assert.ok(file.content.length <= limit);
    assert.ok(file.content.length > limit - 1000, `used ${file.content.length} of ${limit}`);
    if (count <= 2) { assert.match(file.content, /BEYOND_12000/); assert.ok(file.content.indexOf('BEYOND_12000') > 12000); }
    const source = f.system.registry.get(file.sourceId), artifact = await f.system.preparation.readPaperArtifact(file.sourceId);
    assert.equal(file.contentHash, source.contentHash);
    const refs = [...file.content.matchAll(/\[\[cite:([^\]]+)\]\]/g)].map(match => match[1]);
    assert.ok(refs.length);
    assert.ok(refs.every(ref => artifact.chunks.some(chunk => ref === `${file.sourceId}:p${chunk.page}:${chunk.chunkId}`)));
    const preview = result.evidenceBundle.items.find(item => item.sourceIds.includes(file.sourceId));
    assert.ok(preview.content.length <= 1000); assert.equal(preview.contentRole, 'preview');
    assert.match(preview.fullEvidenceLocation, /files\[/);
    assert.ok(preview.references.every(ref => refs.includes(ref.reference)));
  }
  if (count > 1) assert.ok(result.evidenceBundle.gaps.some(gap => /Aggregate evidence budget/.test(gap)));
});

test('JSON escapes count toward aggregate allocation without cutting valid citation markers', async t => {
  const f = await fixture(2, true);
  const result = await dispatch(t, f, { query: 'code availability', paper_ids: f.ids });
  assert.ok(result.files.every(file => JSON.stringify(file.content).length - 2 <= 24000));
  assert.ok(result.files.some(file => file.content.length < 23000));
  assert.ok(result.evidenceBundle.gaps.some(gap => /serialization budget/.test(gap)));
});

for (const [name, bound] of [['retrieve_project_evidence', 16000], ['read_paper_evidence', undefined], ['read_paper_evidence', 500]]) {
  test(`${name} preserves explicit bound ${bound ?? 'legacy default'}`, async t => {
    const f = await fixture();
    const args = name === 'read_paper_evidence' ? { paper_id: f.ids[0] } : { query: 'code availability', paper_ids: f.ids };
    if (bound) args.max_characters = bound;
    const result = await dispatch(t, f, args, { name });
    assert.ok(result.files[0].content.length <= (bound || 12000));
    if (name === 'read_paper_evidence') {
      assert.equal(result.content, result.files[0].content);
      assert.equal(result.paper_id, f.ids[0]); assert.ok(result.next_offset > 0);
      assert.ok(result.evidence_citations.length);
    }
  });
}

test('retrieval bounds and signed transport limits remain enforced', () => {
  for (const max_characters of [199, 30001, -1, '30000']) assert.throws(() => contract.validate('retrieve_project_evidence', { query: 'x', max_characters }), { code: 'INVALID_PROJECT_TOOL_INPUT' });
  assert.throws(() => contract.validate('read_paper_evidence', { paper_id: 'P1', max_characters: 30000 }), { code: 'INVALID_PROJECT_TOOL_INPUT' });
  assert.throws(() => continuation.withResults({ projectToolState: true, pending: [{ id: 'read', name: 'retrieve_project_evidence' }], agentMessages: [] },
    [{ id: 'read', result: { ok: true, content: 'x'.repeat(180000) } }]), { code: 'INVALID_TOOL_CONTINUATION' });
});

test('exceptional metadata overflow returns an explicit local limit instead of slicing original evidence', async () => {
  const f = await fixture();
  const originalRead = f.system.preparation.readPaperArtifact.bind(f.system.preparation);
  f.system.preparation.readPaperArtifact = async id => {
    const artifact = await originalRead(id);
    f.system.registry.get(id).displayName = 'large-metadata-'.repeat(5000);
    return artifact;
  };
  const response = await f.service.executeAgentTool({ id: 'oversize', name: 'retrieve_project_evidence',
    args: { query: 'code availability', paper_ids: f.ids } }, { turnId: f.options.turnId });
  assert.equal(response.result.error, 'LOCAL_EVIDENCE_RESULT_LIMIT');
  assert.equal(response.result.category, 'local_limit');
  assert.equal(response.result.characterLimit, 64000);
  assert.equal(response.result.files, undefined);
  assert.doesNotMatch(JSON.stringify(response), /BEYOND_12000|large-metadata-/);
});
