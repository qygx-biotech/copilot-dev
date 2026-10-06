'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs/promises'), os = require('node:os'), path = require('node:path');
const lifecycle = require('../provider-lifecycle.js');
const transcript = require('../../shared/conversation-transcript.js');
const protocol = require('../requesty-tool-context.js');
const specialist = require('../literature-specialist.js');
const history = require('../conversation-history.js');
const { SubagentManager } = require('../../docs/generic-subagents.js');
const backend = require('../index.js');
const alias = 'fixture/native';
const entry = { api: 'responses', endpoint: 'https://native.invalid/v1/responses', model: 'native-model', apiKeyEnv: 'NATIVE_KEY', supportsTools: true, supportsImages: true, reasoning: { effort: 'high' }, webSearch: { adapter: 'responses_web_search' } };
const environment = extra => ({ REQUESTY_MODEL: alias, NATIVE_KEY: 'native-secret', AGENT_PROVIDER_ADAPTERS_JSON: JSON.stringify({ [alias]: { ...entry, ...extra } }), REQUESTY_MODEL_CAPABILITIES_JSON: JSON.stringify({ [alias]: { supportsImages: false, supportsTools: false, supportsWebSearch: false } }) });
const config = lifecycle.configuration(environment(), alias);
const message = (id, text, phase = 'commentary') => ({ type: 'message', id, role: 'assistant', status: 'completed', phase, content: [{ type: 'output_text', text, annotations: [{ type: 'url_citation', url: 'https://evidence.invalid/paper', title: 'Paper', start_index: 0, end_index: text.length }] }] });
const reasoning = { type: 'reasoning', id: 'r1', encrypted_content: 'opaque-continuation', summary: [{ type: 'summary_text', text: 'Provider summary' }], content: [{ type: 'reasoning_text', text: 'PRIVATE_PROTOCOL_ANALYSIS' }] };
const call = (id, name = 'browser_snapshot') => ({ type: 'function_call', id: `item_${id}`, call_id: id, name, arguments: '{}', status: 'completed' });
const output = [message('m1', 'Before'), reasoning, call('c1'), message('m2', 'Between'), call('c2'), message('m3', 'After')];
const normalized = items => lifecycle.normalize({ id: 'response_1', status: 'completed', output: items }, config);
const request = messages => ({ messages, max_tokens: 100, tools: [] });
const frame = value => `data: ${JSON.stringify(value)}\n\n`;
const savedTurn = messages => transcript.upsert(null, { turnId: 'turn1', model: alias, workspaceId: 'p1', status: 'completed', bindings: [{ handle: 'P1', identity: 'source:P1', sourceId: 'P1', version: 'hash', current: true }], messages });
const kb = { sourceMap: { paperSources: [{ sourceId: 'P1', contentHash: 'hash', catalogStatus: 'ready' }] }, items: [], projectContext: new Map() };
const context = { localWorkspaceContext: { project: { workspaceId: 'p1' } } };

test('ordered native items, boundaries, phase, reasoning and annotations survive storage and actual HTTP replay', async () => {
  const turn = normalized(output);
  assert.equal(turn.message.content, 'BeforeBetweenAfter');
  assert(!turn.message.content.includes('PRIVATE_PROTOCOL_ANALYSIS'));
  const messages = [{ role: 'user', content: 'Inspect' }, protocol.assistantMessage(turn, turn.message.tool_calls), ...['c1', 'c2'].map(id => ({ role: 'tool', tool_call_id: id, content: JSON.stringify({ evidence: id }) }))];
  const stored = JSON.parse(JSON.stringify(savedTurn(messages)));
  const replay = history.replay(stored, kb, context, alias).messages;
  let body;
  const result = await lifecycle.responses(config, request(replay), { fetchImpl: async (_url, options) => {
    body = JSON.parse(options.body);
    return new Response(JSON.stringify({ id: 'response_2', status: 'completed', output: [message('final', 'Done', 'final_answer')] }));
  } });
  assert(result.ok);
  const start = body.input.findIndex(item => item.id === 'm1');
  assert.deepEqual(body.input.slice(start, start + output.length), output);
  assert.deepEqual(body.input.slice(start + output.length).map(item => item.call_id), ['c1', 'c2']);
  assert.equal(result.message.phase, 'final_answer');
  assert(!JSON.stringify(transcript.summarize(stored.turns[0]).messages).includes('PRIVATE_PROTOCOL_ANALYSIS'));
});

test('local call-ID normalization updates native associations without regrouping output', () => {
  const turn = normalized(output);
  const local = turn.message.tool_calls.map((value, i) => ({ ...value, id: `local_${i}` }));
  const assistant = protocol.assistantMessage(turn, local);
  const replay = lifecycle.requestBody(request([assistant]), config).input;
  assert.deepEqual(replay.map(item => item.type), output.map(item => item.type));
  assert.deepEqual(replay.filter(item => item.type === 'function_call').map(item => item.call_id), ['local_0', 'local_1']);
  assert.throws(() => transcript.messages([{ ...assistant, tool_calls: [] }]), { code: 'PROVIDER_CONTEXT_LIMIT' });
});

test('specialist queued handoffs and continuation keep the provider transcript intact', async () => {
  let state = specialist.create('discover_papers', { objective: 'enzyme', queries: ['enzyme'] }, 'parent_call');
  specialist.accept(state, { job_id: 'lit_' + 'a'.repeat(24), tools: [{ type: 'function', function: { name: 'browser_snapshot', parameters: { type: 'object' } } }], observation: 'Initial' });
  await specialist.advance(state, { requestTurn: async () => normalized(output) });
  assert.equal(state.pendingModelCall.id, 'c1');
  state = JSON.parse(JSON.stringify(state)); // The same payload carried in signed handoffs.
  specialist.accept(state, { result: { evidence: 'one' } });
  await specialist.advance(state, { requestTurn: () => assert.fail('Queued call must drain first') });
  assert.equal(state.pendingModelCall.id, 'c2');
  specialist.accept(state, { result: { evidence: 'two' } });
  let body;
  await specialist.advance(state, { requestTurn: async options => lifecycle.responses(config, request(options.messages), { fetchImpl: async (_url, options) => {
    body = JSON.parse(options.body);
    return new Response(JSON.stringify({ id: 'next', status: 'completed', output: [call('c3')] }));
  } }) });
  const start = body.input.findIndex(item => item.id === 'm1');
  assert.deepEqual(body.input.slice(start, start + output.length), output);
  assert.deepEqual(body.input.slice(start + output.length).map(item => item.call_id), ['c1', 'c2']);
});

test('existing child manager preserves native history through parent-turn follow-ups', async () => {
  const assistant = normalized(output).message;
  const stored = savedTurn([{ role: 'user', content: 'Read' }, assistant, ...['c1', 'c2'].map(id => ({ role: 'tool', tool_call_id: id, content: 'evidence' }))]);
  const parent = { sessionId: 'session', requestId: 'parent', projectId: 'p1', model: alias, permissions: { surface: 'side_chat', permission: 'read_only' }, allowedTools: ['read_paper_evidence'], sourceScope: { type: 'selected_sources', sourceIds: ['P1'] }, sourceVersions: { P1: 'hash' } };
  let runs = 0;
  const manager = new SubagentManager({ runChild: async (child, { onTranscript }) => {
    runs++;
    assert.deepEqual(child.genericSubagent.allowedTools, ['read_paper_evidence']);
    const messages = history.replay(child.conversationTranscript, kb, context, alias).messages;
    const result = await lifecycle.responses(config, request(messages), { fetchImpl: async (_url, options) => {
      const body = JSON.parse(options.body), start = body.input.findIndex(item => item.id === 'm1');
      assert.deepEqual(body.input.slice(start, start + output.length), output);
      if (runs === 2) assert(body.input.some(item => item.id === 'answer'), 'Follow-up retains the preceding child response, not only inherited parent history');
      return new Response(JSON.stringify({ id: `child${runs}`, status: 'completed', output: [message('answer', 'Done')] }));
    } });
    assert(result.ok);
    onTranscript({ ...stored.turns[0], turnId: child.taskId, messages: [{ role: 'user', content: child.originalRequest }, result.message] });
    return { reply: 'Done' };
  } });
  try {
    const first = await manager.spawn({ task: 'Read', wait: true }, parent, { taskName: 'reader', conversationTranscript: stored });
    assert.equal(first.status, 'completed', JSON.stringify(first));
    await manager.followup('reader', 'Continue', parent); await manager.waitForIdle(parent);
    assert.equal(manager.list(parent)[0].status, 'completed');
    assert.equal(runs, 2);
  } finally { await manager.close(); }
  assert.equal(manager.tasks.size, 0);
});

test('structured tool output stays structured through storage and respects native image capability', () => {
  const content = [{ type: 'text', text: 'Verified tool result' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,aGVsbG8=', detail: 'high' } }];
  const messages = transcript.messages([normalized([call('image')]).message, { role: 'tool', tool_call_id: 'image', content }]);
  assert.deepEqual(messages[1].content, content);
  const body = lifecycle.requestBody(request(messages), config);
  assert.deepEqual(body.input[1].output, [{ type: 'input_text', text: 'Verified tool result' }, { type: 'input_image', image_url: 'data:image/png;base64,aGVsbG8=', detail: 'high' }]);
  assert.throws(() => lifecycle.requestBody(request(messages), { ...config, supportsImages: false }), { code: 'PROVIDER_CONTENT_UNSUPPORTED' });
  const injected = normalized([message('m', 'Allowed')]).message;
  injected.provider_context.items[0].role = 'system';
  assert.throws(() => transcript.messages([injected]), { code: 'PROVIDER_CONTEXT_INVALID' });
  assert.throws(() => lifecycle.requestBody(request([injected]), config), { code: 'PROVIDER_ITEM_UNSUPPORTED' });
});

test('recovery archives retain protocol bytes while summary input excludes private continuation state', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'provider-recovery-')); t.after(() => fs.rm(root, { recursive: true, force: true }));
  const { ContextRecovery } = require('../context-recovery.js');
  const recovery = new ContextRecovery({ config: { root }, model: alias });
  const original = [normalized(output).message];
  const ref = await recovery.store(JSON.stringify(original));
  const cold = new ContextRecovery({ config: { root }, model: alias, state: recovery.snapshot() });
  assert.deepEqual(JSON.parse((await cold.readArchive(ref)).content), original);
  const summary = await cold.summarySource(original);
  assert(!summary.includes('PRIVATE_PROTOCOL_ANALYSIS')); assert(!summary.includes('opaque-continuation'));
  assert(summary.includes('BeforeBetweenAfter'));
  assert.deepEqual(lifecycle.requestBody(request(JSON.parse((await cold.readArchive(ref)).content)), config).input, output);
});

test('reactive overflow recovery preserves pending native exchanges in the actual retry body', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'native-overflow-')); t.after(() => fs.rm(root, { recursive: true, force: true }));
  const { ContextRecovery } = require('../context-recovery.js');
  const recovery = new ContextRecovery({ config: { root, window: 6000, outputTokens: 256, safety: 32, summaryTokens: 256 }, model: alias });
  const pending = [normalized(output).message, ...['c1', 'c2'].map(id => ({ role: 'tool', tool_call_id: id, content: 'Current exact evidence' }))];
  const messages = [{ role: 'system', content: 'Original authority: read only.' }, { role: 'user', content: 'Use selected evidence.' }, normalized([reasoning, message('old', 'Historical detail. '.repeat(3000))]).message, ...pending];
  recovery.seed(messages, 2);
  let normal = 0, summaries = 0;
  const result = await recovery.run({ messages, tools: [] }, async options => lifecycle.responses(config, request(options.messages), { fetchImpl: async (_url, transport) => {
    const body = JSON.parse(transport.body);
    if (options.stage === 'context-summary') {
      summaries++; assert(!transport.body.includes('PRIVATE_PROTOCOL_ANALYSIS'));
      return new Response(JSON.stringify({ status: 'completed', output: [message('summary', 'Derived summary; no actions verified.')] }));
    }
    normal++;
    if (normal === 1) return new Response(JSON.stringify({ error: { code: 'context_length_exceeded' } }), { status: 400 });
    assert.deepEqual(body.input.slice(-output.length - 2, -2), output);
    assert.deepEqual(body.input.slice(-2).map(item => item.call_id), ['c1', 'c2']);
    assert(body.input.some(item => item.role === 'system' && item.content === 'Original authority: read only.'));
    return new Response(JSON.stringify({ status: 'completed', output: [message('recovered', 'Recovered')] }));
  } }));
  assert(result.ok); assert.equal(normal, 2); assert(summaries > 0);
  assert.deepEqual(result.contextMessages.slice(-pending.length), pending);
});

test('authenticated native HTTP route does not require a beta Requesty credential', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'native-http-')); t.after(() => fs.rm(root, { recursive: true, force: true }));
  const user = { id: 'beta1', account: 'native-user', passwordHash: require('bcryptjs').hashSync('fixture-password', 4), requestyKeyEnv: 'REQUESTY_KEY_NATIVE_USER', active: true };
  const env = { ...environment(), REQUESTY_API_KEY: '', REQUESTY_KEY_NATIVE_USER: '', JWT_SECRET: 'native-fixture-secret', ADMIN_ACCOUNT: 'admin-fixture', BETA_USERS_JSON: JSON.stringify([user]), CONTEXT_ARCHIVE_DIR: root };
  const before = Object.fromEntries(Object.keys(env).map(key => [key, process.env[key]]));
  Object.assign(process.env, env);
  t.after(() => { for (const [key, value] of Object.entries(before)) value === undefined ? delete process.env[key] : process.env[key] = value; });
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    calls++; assert.equal(url, entry.endpoint); assert.equal(JSON.parse(options.body).model, entry.model);
    return new Response(JSON.stringify({ id: 'http', status: 'completed', output: [message('done', '{"reply":"Native answer"}', 'final_answer')] }));
  });
  const token = require('jsonwebtoken').sign({ id: user.id, account: user.account, role: 'beta' }, env.JWT_SECRET, { subject: user.id });
  const result = await backend.handler({ httpMethod: 'POST', path: '/chat', headers: { authorization: `Bearer ${token}` }, body: JSON.stringify({ mode: 'side_chat', messages: [{ role: 'user', content: 'Rewrite a sentence.' }] }) }, {});
  assert.equal(result.statusCode, 200, result.body); assert.equal(calls, 1);
  assert(!result.body.includes('native-secret'));
});

test('provider changes reject opaque state, while invalidated evidence is withheld before replay', () => {
  const assistant = normalized([reasoning, message('m', 'Known evidence')]).message;
  assert.throws(() => lifecycle.requestBody(request([assistant]), { ...config, endpoint: 'https://other.invalid/responses' }), { code: 'PROVIDER_CONTEXT_MISMATCH' });
  const stored = savedTurn([{ role: 'user', content: 'Read' }, assistant]);
  const replay = history.replay(stored, { ...kb, sourceMap: { paperSources: [] } }, context, alias);
  assert(!JSON.stringify(replay.messages).includes('opaque-continuation'));
  assert(!JSON.stringify(replay.messages).includes('Known evidence'));
});

test('interrupted streams expose only public text and never store partial protocol completion', async () => {
  const visible = [], admitted = [];
  const events = [{ type: 'response.created', response: { id: 'r' } }, { type: 'response.reasoning_text.delta', delta: 'PRIVATE_PROTOCOL_ANALYSIS' }, { type: 'response.output_text.delta', delta: 'Visible' }, { type: 'response.output_item.done', output_index: 0, item: call('c1') }];
  const result = await lifecycle.responses(config, request([]), { onText: text => visible.push(text), onCompletedCall: call => admitted.push(call), fetchImpl: async () => new Response(events.map(frame).join(''), { headers: { 'content-type': 'text/event-stream' } }) });
  assert.deepEqual(visible, ['Visible']); assert.equal(admitted.length, 1);
  assert.equal(result.ok, false); assert.equal(result.terminalProviderFailure, true); assert.equal(result.providerMessage, undefined);
});

test('native main-loop transport uses native credentials and image admission, never Requesty catalog', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'provider-fidelity-')); t.after(() => fs.rm(root, { recursive: true, force: true }));
  const bodies = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    assert.equal(url, entry.endpoint); assert.equal(options.headers.Authorization, 'Bearer native-secret');
    const body = JSON.parse(options.body); bodies.push(body);
    return new Response(JSON.stringify({ id: `r${bodies.length}`, status: 'completed', end_turn: bodies.length !== 1, output: bodies.length === 1 ? [reasoning, message('first', 'Continuing')] : [message('final', '{"reply":"Done"}', 'final_answer')] }));
  });
  const events = [];
  const result = await backend._test.callRequesty([{ role: 'user', content: 'Inspect this image' }], { ...environment(), CONTEXT_ARCHIVE_DIR: root }, {}, 'side_chat', { turnId: 'native-turn' }, { emit: async (kind, data) => events.push({ kind, data }) }, { images: [{ dataUrl: 'data:image/png;base64,aGVsbG8=' }] });
  assert(result.ok, JSON.stringify(result)); assert.equal(bodies.length, 2);
  assert(bodies[0].input.some(item => Array.isArray(item.content) && item.content.some(part => part.type === 'input_image')));
  assert.deepEqual(bodies[1].input.filter(item => ['r1', 'first'].includes(item.id)), [reasoning, message('first', 'Continuing')]);
  assert(!JSON.stringify(events.filter(event => event.kind === 'delta')).includes('PRIVATE_PROTOCOL_ANALYSIS'));
  const rejected = await backend._test.callRequesty([{ role: 'user', content: 'Image' }], { ...environment({ supportsImages: false }), CONTEXT_ARCHIVE_DIR: root }, {}, 'side_chat', null, null, { images: [{ dataUrl: 'data:image/png;base64,aGVsbG8=' }] });
  assert.equal(rejected.error, 'MODEL_IMAGE_CAPABILITY_UNAVAILABLE'); assert.equal(bodies.length, 2);
});

test('explicit native search adapter preserves BioDesign search and citation metadata', async () => {
  const stage = require('../requesty-search-stage.js');
  const result = await stage.run({ activeRequest: 'Find enzyme research', supported: config.supportsWebSearch, onProgress: async () => {}, requestTurn: options => lifecycle.responses(config, { ...request(options.messages), tools: options.tools }, { fetchImpl: async (_url, options) => {
    const body = JSON.parse(options.body); assert.deepEqual(body.tools, [{ type: 'web_search' }]);
    return new Response(JSON.stringify({ id: 'search', status: 'completed', output: [{ type: 'web_search_call', id: 'web1', status: 'completed', action: { type: 'search', query: 'enzyme' } }, message('research', 'Found a paper')] }));
  } }) });
  assert.equal(result.state.status, 'completed'); assert.equal(result.sources[0].url, 'https://evidence.invalid/paper');
  const unavailable = lifecycle.configuration(environment({ webSearch: undefined }), alias);
  assert.equal(unavailable.supportsWebSearch, false);
  assert.throws(() => lifecycle.requestBody({ ...request([]), tools: [{ type: 'web_search' }] }, unavailable), { code: 'PROVIDER_TOOL_UNSUPPORTED' });
});

test('main-loop local execution returns results paired with the original ordered native calls', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'native-tools-')); t.after(() => fs.rm(root, { recursive: true, force: true }));
  let requests = 0;
  const items = [message('intro', 'Inspecting'), reasoning, call('list1', 'list_papers'), message('tail', 'Checking')];
  t.mock.method(globalThis, 'fetch', async (_url, options) => {
    const body = JSON.parse(options.body); requests++;
    if (requests === 1) {
      assert(body.tools.some(tool => tool.name === 'list_papers'));
      return new Response(JSON.stringify({ id: 'tools', status: 'completed', output: items }));
    }
    const start = body.input.findIndex(item => item.id === 'intro');
    assert.deepEqual(body.input.slice(start, start + items.length), items);
    const result = body.input[start + items.length];
    assert.equal(result.type, 'function_call_output'); assert.equal(result.call_id, 'list1'); assert.equal(typeof result.output, 'string');
    return new Response(JSON.stringify({ id: 'final', status: 'completed', output: [message('done', '{"reply":"Done"}', 'final_answer')] }));
  });
  const result = await backend._test.callRequesty([{ role: 'user', content: 'List local papers.' }], { ...environment(), CONTEXT_ARCHIVE_DIR: root }, {}, 'side_chat', { turnId: 'native-tools' });
  assert(result.ok, JSON.stringify(result)); assert.equal(requests, 2);
});

for (const native of [true, false]) test(`${native ? 'native' : 'chat'} actual request preserves mixed attachments and limits tool image delivery explicitly`, async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'image-projection-')); t.after(() => fs.rm(root, { recursive: true, force: true }));
  const images = Array.from({ length: 6 }, (_, i) => Buffer.from(`image${i}`).toString('base64'));
  const messages = [{ role: 'user', content: [{ type: 'text', text: 'Describe the figures' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,cHJpb3I=' } }] },
    ...images.flatMap((data, i) => [{ role: 'assistant', tool_calls: [{ id: `img${i}`, type: 'function', function: { name: 'view_image', arguments: '{}' } }] }, { role: 'tool', tool_call_id: `img${i}`, content: JSON.stringify({ ok: true, runtimeCall: { name: 'view_image' }, value: { content: [{ type: 'image', mimeType: 'image/png', data }] } }) }])];
  let body;
  t.mock.method(globalThis, 'fetch', async (_url, options) => {
    body = JSON.parse(options.body);
    return new Response(JSON.stringify(native ? { id: 'image-response', status: 'completed', output: [message('final', '{"reply":"Done"}', 'final_answer')] } : { choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: '{"reply":"Done"}' } }] }));
  });
  const env = native ? environment() : { REQUESTY_API_KEY: 'fixture-key', REQUESTY_MODEL: 'fixture/chat', REQUESTY_MODEL_CAPABILITIES_JSON: JSON.stringify({ 'fixture/chat': { supportsImages: true, supportsTools: true, supportsWebSearch: false } }) };
  const result = await backend._test.callRequesty(messages, { ...env, CONTEXT_ARCHIVE_DIR: root }, {}, 'side_chat', { turnId: 'mixed-images' }, null, { images: [{ dataUrl: 'data:image/png;base64,dXNlcg==' }] });
  assert(result.ok, JSON.stringify(result));
  const requestMessages = native ? body.input : body.messages;
  const parts = requestMessages.flatMap(m => Array.isArray(m.content) ? m.content : []);
  const pixels = parts.filter(p => ['input_image', 'image_url'].includes(p.type)).map(p => native ? p.image_url : p.image_url.url);
  assert.deepEqual(pixels, ['data:image/png;base64,cHJpb3I=', 'data:image/png;base64,dXNlcg==', ...images.slice(2).map(data => `data:image/png;base64,${data}`)]);
  const receipts = requestMessages.filter(m => native ? m.type === 'function_call_output' : m.role === 'tool').map(m => JSON.parse(native ? m.output : m.content).value.content[0]);
  assert.deepEqual(receipts.map(r => r.delivered_as_pixels), [false, false, true, true, true, true]);
  assert.deepEqual(receipts.map(r => r.originating_call_id), images.map((_, i) => `img${i}`));
  assert.equal(receipts[0].omission_reason, 'TOOL_IMAGE_COUNT_LIMIT');
  const stored = transcript.messages(messages);
  assert.deepEqual(stored[0].content, messages[0].content);
  assert.equal(JSON.parse(stored[2].content).value.content[0].data, images[0]);
});
