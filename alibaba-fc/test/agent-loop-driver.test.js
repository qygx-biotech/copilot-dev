'use strict';
// The desktop agent loop end to end below the renderer: shared/agent/local-driver.js
// with the real desktop proxy client against the FC model proxy (HTTP adapter
// on a loopback port), a scripted provider, and real project hosts.
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs/promises'), path = require('node:path');
const jwt = require('jsonwebtoken');
const backend = require('../index.js');
const { runLocalAgentTurn } = require('../../shared/agent/local-driver.js');
const transcript = require('../../shared/conversation-transcript.js');
const { createFixture } = require('./helpers/preflight-fixture.js');
const { ProjectContextService } = require('../../docs/project-context-service.js');
const { loopbackFetch, proxyUrl } = require('./helpers/model-proxy.js');
const { withEnv, temporaryDirectory, localAgentBridge, rendererSandbox } = require('./helpers/desktop-renderer.js');

const model = 'google/gemma-4-31b-it';
const BASE_ENV = { JWT_SECRET: 'loop-fixture-secret', ADMIN_ACCOUNT: 'loop-fixture', REQUESTY_API_KEY: 'loop-fixture-key',
  REQUESTY_MODEL: model, REQUESTY_TOOL_MODE: 'sequential' };
const toolCall = (name, args = {}, id = name) => ({ id, type: 'function', function: { name, arguments: JSON.stringify(args) } });
const agentFinal = reply => JSON.stringify({ reply, project: { summary: 'Summary', organism: 'Unknown', missingInformation: [], safetyLevel: 'Review', safetyNotes: 'Review', draftMemo: 'Draft' } });
const catalogHandle = (messages, pattern) => {
  const catalog = messages.find(message => /Workspace catalog of sources/.test(message.content))?.content || '';
  return catalog.split('\n').find(line => /item_id=/.test(line) && pattern.test(line))?.match(/item_id=([^ ]+)/)?.[1];
};
const runtimeReceipt = (call, value) => ({ id: call.id, result: { ok: true, runtimeCall: { name: call.name, args: call.args }, value } });
const clientPromise = import('../../desktop/workers/model-proxy-client.mjs');
// Progress packets report the remaining request time; the loop has no request deadline.
const REMAINING_TIME = /(\\*"(?:timeRemainingMs|hardDeadlineRemainingMs)\\*":)(null|[0-9.]+)/g;
const remainingTimes = requests => requests.flatMap(request => [...JSON.stringify(request).matchAll(REMAINING_TIME)].map(match => match[2]));

// A scripted provider: respond(request, index) returns an assistant message or a Response.
function installProvider(t, respond) {
  const requests = [];
  t.mock.method(globalThis, 'fetch', async (url, options = {}) => {
    if (String(url).endsWith('/models')) return new Response(JSON.stringify({ data: [] }));
    const request = JSON.parse(options.body);
    requests.push(request);
    const reply = await respond(request, requests.length);
    if (reply instanceof Response) return reply;
    return new Response(JSON.stringify({ choices: [{ message: reply, finish_reason: reply.tool_calls?.length ? 'tool_calls' : 'stop' }],
      usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 } }), { headers: { 'content-type': 'application/json' } });
  });
  return { requests };
}

// One turn: capabilities, then the loop; `host` answers each step boundary as the renderer would.
async function viaLocal(payload, token, host, { archiveRoot }) {
  const { callModelTurn, fetchModelCapabilities } = await clientPromise;
  const baseUrl = await proxyUrl(), boundaries = [], events = [];
  try {
    const capabilities = await fetchModelCapabilities({ baseUrl, token, fetchImpl: loopbackFetch, request: { ...(payload.model ? { model: payload.model } : {}),
      surface: payload.mode === 'side_chat' ? 'side_chat' : 'agent_command' } });
    const data = await runLocalAgentTurn({ body: payload, capabilities, archiveRoot, emit: async event => { events.push(event); },
      callModel: options => callModelTurn({ baseUrl, token, fetchImpl: loopbackFetch, ...options }),
      // The renderer answers with the receipts and its current (tool-refreshed) workspace context.
      boundary: async boundaryData => {
        boundaries.push(boundaryView(boundaryData));
        const next = await host(boundaryData);
        return next && { ...next, ...(payload.localWorkspaceContext !== undefined ? { localWorkspaceContext: payload.localWorkspaceContext } : {}) };
      } });
    return { status: 200, data, boundaries, events };
  } catch (error) {
    return { status: error.status || 500, data: { error: error.code }, boundaries, events };
  }
}
const boundaryView = data => ({ desktopToolCalls: (data.desktopToolCalls || []).map(call => ({ name: call.name, args: call.args })),
  agentCheckpoint: data.agentCheckpoint || null });

// Runs prepare() + host once against the provider script.
async function runTurn(t, { env = {}, prepare, respond }) {
  // Fixture paper cards are stamped with the current time.
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-10-06T00:00:00Z') });
  withEnv(t, { ...BASE_ENV, ...env });
  const token = jwt.sign({ account: BASE_ENV.ADMIN_ACCOUNT, role: 'admin' }, BASE_ENV.JWT_SECRET);
  const provider = installProvider(t, respond);
  const { payload, host } = await prepare();
  const archiveRoot = await temporaryDirectory(t, 'loop-archive');
  const run = await viaLocal(payload, token, host, { archiveRoot });
  return { ...run, requests: provider.requests, remainingTimes: remainingTimes(provider.requests), archiveRoot };
}

async function projectFixture({ question, selectSurfDock = false, extraPaper = false }) {
  const f = await createFixture();
  f.workspace.set('literature/SurfDock.pdf', 'SurfDock code availability: https://example.invalid/SurfDock. The reactor pH was 7.2.');
  f.workspace.set('literature/Other.pdf', 'Other unrelated work on reactor design.');
  if (extraPaper) f.workspace.set('literature/Third.pdf', 'Third paper on enzyme kinetics and reactor temperature 37 C.');
  await f.pipeline.preflight({ turnId: 'seed-fixture' });
  const service = new ProjectContextService({ workspace: f.workspace, literature: f.literature, sourceSystem: f.system, requestPipeline: f.pipeline,
    semanticInterpreter: { interpret() { throw Error('No planner for routine reads'); } } });
  const options = { question, surface: 'side_chat', turnId: 'loop-turn', callContext: { model } };
  await f.pipeline.preflight(options);
  let context = await service.buildContext(options);
  const surfDock = context.sourceMap.paperSources.find(source => /SurfDock/.test(source.path));
  if (selectSurfDock) context = await service.buildContext({ ...options, selectedPaperIds: [surfDock.sourceId] });
  const host = async data => ({ desktopToolResults: await Promise.all((data.desktopToolCalls || []).map(call => service.executeAgentTool(call, { turnId: options.turnId }))) });
  const payload = { mode: 'side_chat', originalRequest: question, messages: [{ role: 'user', content: question }],
    conversationTranscript: transcript.normalize(), localWorkspaceContext: context,
    callContext: { turnId: options.turnId, callRole: 'answer', profile: 'medium' } };
  return { f, service, context, surfDock, host, payload };
}

test('project evidence tools: host work, citations and transcript', async t => {
  const question = 'SurfDock有源代码吗？';
  let reference;
  const run = await runTurn(t, {
    prepare: async () => { const { payload, host } = await projectFixture({ question }); return { payload, host }; },
    respond: (request, index) => {
      const itemId = catalogHandle(request.messages, /SurfDock/);
      if (index === 1) return { tool_calls: ['search_project_knowledge', 'retrieve_project_evidence'].map((name, i) => toolCall(name,
        { query: 'source code', requirement: { scope: { type: 'single_source', sourceIds: [itemId] } } }, `call-${i}`)) };
      if (index === 2) {
        const results = request.messages.filter(message => message.role === 'tool').map(message => JSON.parse(message.content));
        reference = results[1].evidenceBundle.items[0].references[0].reference;
        return { tool_calls: [toolCall('read_paper_evidence', { item_id: itemId, evidence_ref: reference, max_characters: 500 }, 'legacy')] };
      }
      return { content: `找到了源码说明。[[cite:${reference}]]` };
    },
  });
  assert.equal(run.requests.length, 3);
  assert.equal(run.data.citations[0].page, 1);
  assert.deepEqual(run.data.conversationTurn.messages.map(message => message.role), ['user', 'assistant', 'tool', 'tool', 'assistant', 'tool', 'assistant']);
  assert.ok(run.events.some(event => event.type === 'transcript'), 'Transcript checkpoints stream to the renderer');
});

test('runtime checkpoints: tool receipts and queued steering resume the loop', async t => {
  const question = 'What time is it in the project log?';
  const runtimeExtensions = { version: 1, skills: { catalog: '', active: [] }, genericSubagents: false, mcpTools: [], runtimeTools: ['clock_curr_time'] };
  const run = await runTurn(t, {
    prepare: async () => {
      const { payload } = await projectFixture({ question });
      let steered = false;
      const host = async data => {
        if (data.desktopToolCalls?.length) return { desktopToolResults: data.desktopToolCalls.map(call => runtimeReceipt(call, { current_time: '2026-10-06 00:00:00 UTC' })) };
        if (data.agentCheckpoint?.final && !steered) {
          steered = true;
          return { desktopToolResults: [], runtimeInjections: [{ id: 'steer-1', kind: 'user', content: 'Also say which tool you used.' }] };
        }
        return data.agentCheckpoint?.final ? null : { desktopToolResults: [] };
      };
      return { payload: { ...payload, runtimeExtensions }, host };
    },
    respond: (request, index) => index === 1 ? { tool_calls: [toolCall('clock_curr_time', {}, 'time')] }
      : { content: index === 2 ? 'It is midnight UTC.' : 'It is midnight UTC, from clock_curr_time.' },
  });
  assert.ok(run.requests[2].messages.some(message => message.role === 'user' && message.content === 'Also say which tool you used.'));
  assert.equal(run.data.reply, 'It is midnight UTC, from clock_curr_time.');
});

test('reactive context recovery after a provider overflow archives under the project with private permissions', async t => {
  const long = label => `${label}: ${'Fermentation observation with titre, pH and temperature. '.repeat(120)}`;
  const messages = [{ role: 'user', content: long('Q1') }, { role: 'assistant', content: long('A1') }, { role: 'user', content: long('Q2') },
    { role: 'assistant', content: long('A2') }, { role: 'user', content: 'Summarize the current fermentation status.' }];
  const run = await runTurn(t, {
    env: { CONTEXT_MODEL_WINDOWS: JSON.stringify({ [model]: 32000 }) },
    prepare: async () => ({ payload: { mode: 'side_chat', originalRequest: 'Summarize the current fermentation status.', messages,
      callContext: { turnId: 'overflow-turn', callRole: 'answer', profile: 'medium' } }, host: async () => null }),
    respond: (request, index) => {
      if (index === 1) return new Response(JSON.stringify({ error: { code: 'context_length_exceeded',
        message: "This model's maximum context length is 6000 tokens. However, your messages resulted in 9000 tokens." } }), { status: 400, headers: { 'content-type': 'application/json' } });
      // Summary calls carry the recovery summarizer prompt and no tools.
      if (!request.tools && request.messages.some(message => /^Create a factual working-state checkpoint/.test(String(message.content)))) return { content: 'Checkpoint: titre stable, pH 7.2.' };
      return { content: 'Fermentation is stable at pH 7.2.' };
    },
  });
  assert.ok(run.requests.length >= 2, 'The rejected request is retried after recovery');
  assert.ok(JSON.stringify(run.requests.at(-1)).length < JSON.stringify(run.requests[0]).length, 'The retried request is smaller');
  assert.equal(run.data.reply, 'Fermentation is stable at pH 7.2.');
  const entries = [];
  const walk = async directory => { for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name); entries.push({ file, stat: await fs.stat(file), directory: entry.isDirectory() });
    if (entry.isDirectory()) await walk(file);
  } };
  await walk(run.archiveRoot);
  const archives = entries.filter(entry => !entry.directory && /sessions/.test(entry.file) && entry.file.endsWith('.txt'));
  assert.ok(archives.length > 0, 'Originals are archived under the local archive root before offloading');
  if (process.platform !== 'win32') {
    for (const entry of archives) assert.equal(entry.stat.mode & 0o777, 0o600, entry.file);
    for (const entry of entries.filter(item => item.directory && /sessions/.test(item.file))) assert.equal(entry.stat.mode & 0o777, 0o700, entry.file);
  }
});

test('the loop budget ends with the forced final synthesis and no request deadline', async t => {
  const run = await runTurn(t, {
    env: { AGENT_MAX_STEPS: '3' },
    prepare: async () => { const { payload } = await projectFixture({ question: 'List the workspace items repeatedly.' }); return { payload, host: async () => null }; },
    respond: (request, index) => request.tools?.length ? { tool_calls: [toolCall('list_workspace_items', { limit: index }, `list-${index}`)] }
      : { content: 'Synthesis from the listed items.' },
  });
  assert.equal(run.requests.length, 3);
  assert.equal(run.requests.at(-1).tools, undefined, 'The final synthesis exposes no tools');
  assert.deepEqual([...new Set(run.remainingTimes)], ['null'], 'The loop has no request deadline');
  assert.equal(run.data.reply, 'Synthesis from the listed items.');
});

test('Side Chat permission denials and source-scope checks are enforced on the loop', async t => {
  const question = 'Update the recommendation and read the other paper.';
  let otherId;
  const run = await runTurn(t, {
    prepare: async () => {
      const fixture = await projectFixture({ question, selectSurfDock: true });
      otherId = fixture.context.sourceMap.paperSources.length === 1
        ? (await fixture.service.buildContext({ question, surface: 'side_chat', turnId: 'probe', callContext: { model } })).sourceMap.paperSources.find(source => !/SurfDock/.test(source.path)).sourceId
        : null;
      return { payload: fixture.payload, host: fixture.host };
    },
    respond: (request, index) => index === 1 ? { tool_calls: [
      toolCall('update_recommendation', { recommendation: 'Switch strains.' }, 'recommend'),
      toolCall('retrieve_project_evidence', { query: 'reactor', requirement: { scope: { type: 'single_source', sourceIds: [otherId] } } }, 'outside')] }
      : { content: 'I cannot change the recommendation here, and the other paper is outside the selection.' },
  });
  const receipts = Object.fromEntries(run.requests[1].messages.filter(message => message.role === 'tool').map(message => [message.tool_call_id, JSON.parse(message.content)]));
  assert.equal(receipts.recommend.allowed, false);
  assert.equal(receipts.recommend.required_surface, 'agent_command');
  // Under a hard selection the unselected paper is not resolvable in this turn.
  assert.equal(receipts.outside.error, 'SOURCE_IDENTIFIER_UNKNOWN');
  assert.deepEqual(run.boundaries, [], 'Neither call reached the host');
});

test('Agent Work source downloads run through the host with authorization and receipts', async t => {
  const url = 'https://papers.example.org/enzyme.pdf';
  const host = async data => ({ desktopToolResults: (data.desktopToolCalls || []).map(call => ({ id: call.id,
    results: call.args.sources.map(source => ({ url: source.url, status: 'downloaded', path: 'literature/enzyme.pdf', contentType: 'application/pdf' })) })) });
  const run = await runTurn(t, {
    prepare: async () => ({ payload: { mode: 'agent_instruction', originalRequest: `Download ${url} into the project.`,
      messages: [{ role: 'user', content: `Download ${url} into the project.` }],
      desktopTools: { version: 1, permission: 'full_access', projectId: 'loop-project' },
      callContext: { turnId: 'download-turn', callRole: 'answer', profile: 'medium' } }, host }),
    respond: (request, index) => index === 1 ? { tool_calls: [toolCall('download_sources', { sources: [{ url }] }, 'download')] } : { content: agentFinal('Saved the PDF.') },
  });
  assert.deepEqual(run.boundaries[0].desktopToolCalls, [{ name: 'download_sources', args: { sources: [{ url }], destination: 'literature' } }]);
  const receipt = JSON.parse(run.requests[1].messages.find(message => message.tool_call_id === 'download').content);
  assert.deepEqual(receipt.map(item => [item.url, item.status, item.path]), [[url, 'downloaded', 'literature/enzyme.pdf']]);
});

test('academic discovery: inline planning and host search receipts through the academic recorder', async t => {
  const ref = 'paper_' + 'a'.repeat(24);
  const paper = { paper_ref: ref, title: 'EctD engineering', authors: ['A'], doi: '10.1000/ectd', abstract: 'Relevant abstract',
    providers: [{ source: 'arxiv', paper_id: 'fixture' }], locations: [{ url: 'https://papers.example.org/ectd.pdf', kind: 'pdf_candidate' }] };
  const host = async data => ({ desktopToolResults: (data.desktopToolCalls || []).map(call => ({ id: call.id, result: { version: 1, status: 'completed', papers: [paper] } })) });
  const question = 'Find recent papers on EctD engineering.';
  const run = await runTurn(t, {
    prepare: async () => ({ payload: { mode: 'agent_instruction', originalRequest: question, messages: [{ role: 'user', content: question }],
      desktopTools: { version: 1, academicVersion: 1, permission: 'read_only', projectId: 'loop-project' },
      callContext: { turnId: 'academic-turn', callRole: 'answer', profile: 'medium' } }, host }),
    respond: (request, index) => index === 1 ? { tool_calls: [
      toolCall('plan_literature_search', { request_kind: 'topic', subtopics: ['EctD engineering'], synonyms: ['ectoine hydroxylase'], queries: ['EctD engineering', 'ectoine hydroxylase'] }, 'plan'),
      toolCall('search_academic_papers', { query: 'EctD engineering', queries: ['ectoine hydroxylase'] }, 'search')] }
      : { content: agentFinal('Found one relevant EctD engineering paper.') },
  });
  assert.deepEqual(run.boundaries[0].desktopToolCalls.map(call => call.name), ['search_academic_papers']);
  const receipt = JSON.parse(run.requests[1].messages.find(message => message.tool_call_id === 'search').content);
  assert.equal(receipt.papers[0].paper_ref, ref);
  assert.equal(run.data.academicSources[0].paper_ref, ref);
});

test('the loop runs a whole step of host tools at once', async t => {
  const question = 'Check SurfDock, the other paper and the third paper.';
  const run = await runTurn(t, {
    prepare: async () => { const { payload, host } = await projectFixture({ question, extraPaper: true }); return { payload, host }; },
    respond: (request, index) => {
      if (index > 1) return { content: 'Checked.' };
      const ids = [/SurfDock/, /Other/, /Third/].map(pattern => catalogHandle(request.messages, pattern));
      return { tool_calls: ids.map((id, i) => toolCall('retrieve_project_evidence', { query: 'reactor', requirement: { scope: { type: 'single_source', sourceIds: [id] } } }, `read-${i}`)) };
    },
  });
  assert.equal(run.boundaries[0].desktopToolCalls.length, 3);
  const localThird = JSON.parse(run.requests[1].messages.find(message => message.tool_call_id === 'read-2').content);
  assert.equal(localThird.ok, true);
});

test('invalid requests are rejected with their codes before any model call', async t => {
  withEnv(t, BASE_ENV);
  const token = jwt.sign({ account: BASE_ENV.ADMIN_ACCOUNT, role: 'admin' }, BASE_ENV.JWT_SECRET);
  const provider = installProvider(t, () => ({ content: 'unused' }));
  const base = { mode: 'side_chat', originalRequest: 'Hello', messages: [{ role: 'user', content: 'Hello' }], callContext: { turnId: 'invalid', callRole: 'answer', profile: 'light' } };
  const cases = [
    [{ ...base, originalRequest: '', messages: [] }, 'INVALID_ORIGINAL_REQUEST'],
    [{ ...base, conversationTranscript: { version: 2 } }, 'INVALID_CONVERSATION_TRANSCRIPT'],
    [{ ...base, images: [{ dataUrl: 'data:image/png;base64,AAAA', name: 'x.png' }] }, 'IMAGE_INVALID'],
    [{ ...base, runtimeInjections: [{ id: 'x', kind: 'user', content: 'steer' }] }, 'INVALID_RUNTIME_EXTENSIONS'],
    [{ ...base, callContext: { turnId: 'x', callRole: 'answer', profile: 'light', extra: true } }, 'INVALID_CALL_CONTEXT'],
  ];
  for (const [payload, code] of cases) {
    const run = await viaLocal(payload, token, async () => null, { archiveRoot: await temporaryDirectory(t, 'invalid') });
    assert.deepEqual([run.status, run.data.error], [400, code]);
  }
  assert.equal(provider.requests.length, 0);
});

test('proxy failures end a turn without being mistaken for provider quotas', async t => {
  withEnv(t, { ...BASE_ENV, 
    MODEL_PROXY_DAILY_TOKEN_CAP: '20', MODEL_PROXY_USAGE_DIR: await temporaryDirectory(t, 'usage') });
  const token = jwt.sign({ account: BASE_ENV.ADMIN_ACCOUNT, role: 'admin' }, BASE_ENV.JWT_SECRET);
    const provider = installProvider(t, () => ({ tool_calls: [toolCall('list_workspace_items', { limit: provider.requests.length }, `list-${provider.requests.length}`)] }));
  const { payload } = await projectFixture({ question: 'List items.' });
  const capped = await viaLocal(payload, token, async () => null, { archiveRoot: await temporaryDirectory(t, 'capped') });
  assert.equal(provider.requests.length, 2, 'The cap stops the third call without retries');
  assert.equal(capped.status, 200);
  assert.equal(capped.data.error, 'USER_TOKEN_CAP_EXCEEDED');
  assert.equal(capped.data.failure?.category === 'input_quota', false);

  const expired = jwt.sign({ account: BASE_ENV.ADMIN_ACCOUNT, role: 'admin' }, 'another-secret');
  const unauthorized = await viaLocal(payload, expired, async () => null, { archiveRoot: await temporaryDirectory(t, 'auth') });
  assert.deepEqual([unauthorized.status, unauthorized.data.error], [401, 'AUTH_REQUIRED']);
  const capabilities = JSON.parse((await backend.handler({ httpMethod: 'POST', path: '/api/model/capabilities', headers: { authorization: `Bearer ${token}` },
    body: JSON.stringify({ version: 1, surface: 'side_chat' }) }, {})).body);
  await assert.rejects(runLocalAgentTurn({ body: payload, capabilities, archiveRoot: await temporaryDirectory(t, 'mid-auth'),
    callModel: async () => { throw Object.assign(new Error('Expired'), { code: 'AUTH_REQUIRED', status: 401 }); }, boundary: async () => null }),
  { code: 'AUTH_REQUIRED', status: 401 });
});

test('the capabilities endpoint returns policy and scope digests, never keys, endpoints or accounts', async t => {
  withEnv(t, { ...BASE_ENV, AGENT_MAX_STEPS: '12', NATIVE_LOOP_KEY: 'native-loop-secret',
    AGENT_PROVIDER_ADAPTERS_JSON: JSON.stringify({ 'loop/native': { api: 'responses', endpoint: 'https://native.example/v1/responses', model: 'native-model',
      apiKeyEnv: 'NATIVE_LOOP_KEY', supportsTools: true, supportsImages: false } }) });
  const token = jwt.sign({ account: BASE_ENV.ADMIN_ACCOUNT, role: 'admin' }, BASE_ENV.JWT_SECRET);
  const post = async body => backend.handler({ httpMethod: 'POST', path: '/api/model/capabilities', headers: { authorization: `Bearer ${token}` }, body: JSON.stringify(body) }, {});
  installProvider(t, () => ({ content: 'unused' }));
  const response = await post({ version: 1, surface: 'side_chat' });
  assert.equal(response.statusCode, 200);
  const data = JSON.parse(response.body);
  assert.equal(data.model, model);
  assert.equal(data.loopBudget.maxSteps, 12);
  assert.equal(data.contextConfig.root, undefined);
  for (const value of Object.values(data.scope)) assert.match(value, /^[a-f0-9]{64}$/);
  assert.doesNotMatch(response.body, /loop-fixture-key|requesty\.ai|loop-fixture"/);
  withEnv(t, { REQUESTY_MODEL: 'loop/native' });
  const native = await post({ version: 1, surface: 'side_chat' });
  assert.equal(JSON.parse(native.body).api, 'responses');
  assert.doesNotMatch(native.body, /native-loop-secret|native\.example/);
  assert.equal((await post({ version: 1, model: 'unapproved/model' })).statusCode, 400);
  assert.equal((await post({ version: 2 })).statusCode, 400);
  assert.equal((await backend.handler({ httpMethod: 'POST', path: '/api/model/capabilities', headers: {}, body: '{"version":1}' }, {})).statusCode, 401);
});

test('the production renderer runs a runtime turn on the loop: skills, MCP receipts and steering', async t => {
  const { InjectionQueue } = require('../../docs/runtime-turns.js');
  const runtimeModel = 'fixture/runtime-selected', question = 'Inspect the selected project metadata.';
  const fn = name => ({ type: 'function', function: { name, description: 'Fixture extension', parameters: { type: 'object', properties: {}, additionalProperties: false } } });
  withEnv(t, { ...BASE_ENV, REQUESTY_MODEL: runtimeModel, 
    REQUESTY_MODEL_CAPABILITIES_JSON: JSON.stringify({ [runtimeModel]: { supportsTools: true, supportsWebSearch: false, supportsImages: false } }) });
  const token = jwt.sign({ account: BASE_ENV.ADMIN_ACCOUNT, role: 'admin' }, BASE_ENV.JWT_SECRET);
  const fixture = await createFixture();
  fixture.workspace.set('literature/Selected.pdf', 'Selected enzyme experiment activity 42.');
  await fixture.system.registry.reconcile(await fixture.workspace.scanDirectoryTree());
  const selected = fixture.system.registry.list({ sourceKind: 'paper' })[0].sourceId;
  const service = new ProjectContextService({ workspace: fixture.workspace, literature: fixture.literature, sourceSystem: fixture.system, requestPipeline: fixture.pipeline });
  const localWorkspaceContext = await service.buildContext({ question, surface: 'agent_command', generalPurpose: true,
    forceHardSelection: true, selectedPaperIds: [selected], turnId: 'renderer-local-turn', callContext: { model: runtimeModel } });
  const queue = new InjectionQueue(), workflowCalls = [], steering = 'Keep the reply concise.';
  const provider = installProvider(t, (request, round) => {
    if (round === 1) {
      queue.enqueue(steering, { id: 'renderer-steering' });
      return { tool_calls: [toolCall('read_skill', { name: 'review' }, 'renderer-skill')] };
    }
    assert.equal(request.messages.filter(message => message.role === 'user' && message.content === steering).length, 1);
    const result = JSON.parse(request.messages.findLast(message => message.role === 'tool').content);
    assert.equal(result.ok, true);
    if (round === 2) return { tool_calls: [toolCall('mcp_fixture_echo', {}, 'renderer-mcp')] };
    assert.equal(result.value.evidence.verified, false);
    return { content: 'Concise response with external evidence limits.' };
  });
    const archiveRoot = await temporaryDirectory(t, 'renderer-project');
  const { agent, loop, starts, replies } = await localAgentBridge(t, { archiveRoot });
  const sandbox = rendererSandbox({ token, service, selected: [selected], agent,
    workflow: async (workflowId, input) => {
      workflowCalls.push({ workflowId, input });
      if (workflowId === 'runtime_skills_context') return { catalog: [{ name: 'review', enabled: true, available: true }], active: [] };
      if (workflowId === 'runtime_skills_read') return { name: 'review', body: 'Preserve provenance.', content: 'Preserve provenance.' };
      if (workflowId === 'runtime_mcp_definitions') return { tools: [fn('mcp_fixture_echo')] };
      if (workflowId === 'runtime_mcp_call') return { server: 'fixture', result: { content: [{ type: 'text', text: 'External result' }] },
        receipt: { id: input.call.id, name: input.call.name }, evidence: { kind: 'external_mcp', verified: false } };
      throw new Error(`Unexpected workflow ${workflowId}`);
    } });
  const body = { mode: 'agent_instruction', model: runtimeModel, originalRequest: question, messages: [{ role: 'user', content: question }], localWorkspaceContext,
    runtimeExtensions: { version: 1, skills: { catalog: 'review: Use selected evidence only.', active: [] }, genericSubagents: true, mcpTools: [fn('mcp_fixture_echo')] },
    desktopTools: { version: 1, academicVersion: 1, literatureVersion: 1, permission: 'full_access', projectId: localWorkspaceContext.project.workspaceId },
    callContext: { turnId: 'renderer-local-turn', callRole: 'answer', profile: 'medium' } };
  const result = await sandbox.sendWorkbenchRequest({ ...body, runtimeQueue: queue });
  assert.match(result.reply, /Concise response/);
  assert.equal(provider.requests.length, 3);
  assert.equal(starts.length, 1, 'One local turn, no /chat exchanges');
  assert.equal(starts[0].body.desktopContinuation, undefined);
  assert.equal(replies[0].runtimeInjections[0].id, 'renderer-steering', 'Renderer steering enters at the next boundary');
  assert.ok(replies.every(reply => reply === null || reply.localWorkspaceContext), 'Each boundary reply carries the current workspace context');
  assert.equal(queue.snapshot()[0].status, 'received'); assert.equal(queue.closed, true);
  const mcpCall = workflowCalls.find(call => call.workflowId === 'runtime_mcp_call');
  assert.deepEqual([mcpCall.input.surface, mcpCall.input.permission], ['agent_command', 'full_access']);
  assert.match(mcpCall.input.call.id, /:renderer-mcp$/);
  assert.equal(loop.turns.size, 0);
});

for (const inherited of [false, true]) test(`the production renderer runs a ${inherited ? 'V2 history-forked' : 'legacy independent'} child as a concurrent loop turn and injects its result once`, { timeout: 15000 }, async t => {
  const sessionApi = require('../../docs/runtime-session.js');
  const { InjectionQueue } = require('../../docs/runtime-turns.js');
  const runtimeModel = 'fixture/runtime-selected', question = 'Inspect the selected project metadata.';
  const task = 'Inspect limitations of the selected experiment using $review.', privateHistory = 'PARENT_PRIVATE_HISTORY_872cab';
  const fn = name => ({ type: 'function', function: { name, description: 'Fixture extension', parameters: { type: 'object', properties: {}, additionalProperties: false } } });
  withEnv(t, { ...BASE_ENV, REQUESTY_MODEL: runtimeModel, 
    REQUESTY_MODEL_CAPABILITIES_JSON: JSON.stringify({ [runtimeModel]: { supportsTools: true, supportsWebSearch: false, supportsImages: false } }) });
  const token = jwt.sign({ account: BASE_ENV.ADMIN_ACCOUNT, role: 'admin' }, BASE_ENV.JWT_SECRET);
  const fixture = await createFixture();
  fixture.workspace.set('literature/Selected.pdf', 'Selected enzyme experiment activity 42.');
  await fixture.system.registry.reconcile(await fixture.workspace.scanDirectoryTree());
  const selected = fixture.system.registry.list({ sourceKind: 'paper' })[0].sourceId;
  await fixture.system.preparation.ensureSourceReady([selected], 'stable_snapshot', { surface: 'agent_command' });
  const service = new ProjectContextService({ workspace: fixture.workspace, literature: fixture.literature, sourceSystem: fixture.system, requestPipeline: fixture.pipeline });
  const localWorkspaceContext = await service.buildContext({ question, surface: 'agent_command', generalPurpose: true,
    forceHardSelection: true, selectedPaperIds: [selected], turnId: 'runtime-turn', callContext: { model: runtimeModel } });
  const queue = new InjectionQueue(), sessions = [], events = [], workflowCalls = [];
  let releaseSkill, reachedSkill, reachedParentFinal;
  const skillGate = new Promise(resolve => { releaseSkill = resolve; });
  const skillStarted = new Promise(resolve => { reachedSkill = resolve; });
  const parentFinal = new Promise(resolve => { reachedParentFinal = resolve; });
  t.after(() => releaseSkill());
  let parentRounds = 0, childRounds = 0;
  installProvider(t, request => {
    const isChild = request.messages.some(message => message.role === 'system' && message.content.includes('You are a delegated BioDesign subagent.'));
    if (isChild) {
      childRounds++;
      assert.equal(JSON.stringify(request.messages).includes(privateHistory), inherited);
      assert(request.tools.some(tool => tool.function.name === 'read_skill'));
      assert(!request.tools.some(tool => tool.function.name === 'spawn' || tool.function.name.startsWith('mcp_')));
      if (childRounds === 1) return { tool_calls: [toolCall('read_skill', { name: 'review' }, 'child-skill')] };
      const result = JSON.parse(request.messages.findLast(message => message.role === 'tool').content);
      assert.equal(result.ok, true); assert.match(result.value.body, /unverified/);
      return { content: 'Delegated finding: the available metadata does not establish experimental reproducibility.' };
    }
    parentRounds++;
    if (parentRounds === 1) return { tool_calls: [inherited ? toolCall('spawn_agent', { task_name: 'check_limitations', message: task }, 'background-spawn')
      : toolCall('spawn', { task, label: 'Check limitations', wait: false }, 'background-spawn')] };
    if (parentRounds === 2) return { content: 'Tentative parent summary while independent checking continues.' };
    const injected = request.messages.filter(message => message.role === 'assistant' && message.content?.startsWith('Background subagent result'));
    assert.equal(injected.length, 1);
    return { content: 'The delegated check found a limitation: metadata does not establish experimental reproducibility.' };
  });
    const { agent, loop, starts, replies } = await localAgentBridge(t, { archiveRoot: await temporaryDirectory(t, 'child-project'),
    onBoundary: payload => { if (payload.turnId === 'runtime-turn' && payload.event.data.agentCheckpoint?.final && parentRounds === 2) reachedParentFinal(); },
    onStart: payload => {
      if (!payload.body.runtimeExtensions?.child) return;
      assert.equal(payload.body.originalRequest, task); assert.equal(Boolean(payload.body.conversationTranscript), inherited);
      assert.equal(payload.body.runtimeExtensions.genericSubagents, false); assert.deepEqual(payload.body.runtimeExtensions.mcpTools, []);
      assert.deepEqual(payload.body.localWorkspaceContext.sourceMap.selectedPaperIds, [selected]);
      assert.equal(service.agentTurns.get(payload.body.callContext.turnId).options.permission, 'read_only');
    } });
  const sandbox = rendererSandbox({ token, service, selected: [selected], agent,
    window: { BioDesignRuntimeSession: { create: async options => { const session = await sessionApi.create(options); sessions.push(session); return session; } } },
    workflow: async (workflowId, input) => {
      workflowCalls.push({ workflowId, input });
      if (workflowId === 'runtime_skills_context') return { catalog: [{ name: 'review', enabled: true, available: true }], active: [] };
      if (workflowId === 'runtime_mcp_definitions') return { tools: [fn('mcp_fixture_echo')] };
      if (workflowId === 'runtime_skills_read') { reachedSkill(); await skillGate; return { name: 'review', body: 'Treat delegated findings as unverified and preserve limitations.' }; }
      throw new Error(`Unexpected workflow ${workflowId}`);
    } });
  const body = { mode: 'agent_instruction', model: runtimeModel, originalRequest: question, messages: [{ role: 'assistant', content: privateHistory }, { role: 'user', content: question }],
    localWorkspaceContext, runtimeExtensions: { version: 1, skills: { catalog: 'review: Use selected evidence only.', active: [] }, genericSubagents: true, mcpTools: [fn('mcp_fixture_echo')] },
    desktopTools: { version: 1, academicVersion: 1, literatureVersion: 1, permission: 'full_access', projectId: localWorkspaceContext.project.workspaceId },
    callContext: { turnId: 'runtime-turn', callRole: 'answer', profile: 'medium' } };
  let completed = false;
  const pending = sandbox.sendWorkbenchRequest({ ...body, runtimeQueue: queue, onStream: event => events.push(event) }).then(result => { completed = true; return result; });
  const thrown = pending.then(() => { throw new Error('The parent finished before its child.'); });
  await Promise.race([Promise.all([skillStarted, parentFinal]), thrown]);
  assert.equal(completed, false); assert.equal(childRounds, 1); assert.equal(parentRounds, 2);
  assert.equal(loop.turns.size, 2, 'Parent and child run as concurrent turns in one loop process');
  releaseSkill();
  const result = await pending;
  assert.match(result.reply, /limitation/); assert.equal(childRounds, 2); assert.equal(parentRounds, 3);
  assert.equal(starts.length, 2, 'One local turn for the parent and one for the child');
  assert.equal(sessions.length, 2);
  assert.equal(queue.snapshot().filter(entry => entry.kind === 'subagent').length, 1);
  assert.equal(queue.closed, true);
  assert.equal(replies.filter(reply => reply?.runtimeInjections?.some(item => item.kind === 'subagent')).length, 1, 'The child result enters the parent once');
  for (const session of sessions) { assert.equal(session.manager.tasks.size, 0); assert.equal(session.manager.parents.size, 0); }
  assert(events.some(event => event.stage === 'subagent-completed'));
  assert.equal(loop.turns.size, 0);
});

test('plan mode explores and proposes: write tools are neither offered nor run, and the plan comes back', async t => {
  const url = 'https://papers.example.org/enzyme.pdf', question = `Download ${url} and compare its activity data.`;
  const plan = '<proposed_plan>\n1. Download the paper into literature/.\n2. Compare its activity data at matched pH.\n</proposed_plan>';
  const run = await runTurn(t, {
    prepare: async () => ({ payload: { mode: 'agent_instruction', originalRequest: question, messages: [{ role: 'user', content: question }],
      desktopTools: { version: 1, permission: 'full_access', collaborationMode: 'plan', projectId: 'loop-project' },
      callContext: { turnId: 'plan-turn', callRole: 'answer', profile: 'medium' } }, host: async () => { throw new Error('No host tool may run in plan mode'); } }),
    respond: (request, index) => index === 1
      ? { tool_calls: [toolCall('download_sources', { sources: [{ url }] }, 'download'), toolCall('update_recommendation', {}, 'recommend')] }
      : { content: `Here is the plan.\n\n${plan}` },
  });
  assert.match(run.requests[0].messages.find(message => message.role === 'system').content, /# Plan Mode/);
  const offered = (run.requests[0].tools || []).map(tool => tool.function?.name);
  for (const name of ['download_sources', 'update_recommendation', 'update_project_memory']) assert.ok(!offered.includes(name), `${name} is not offered`);
  assert.deepEqual(run.boundaries, [], 'Nothing reached the host');
  for (const id of ['download', 'recommend']) {
    const receipt = JSON.parse(run.requests[1].messages.find(message => message.tool_call_id === id).content);
    assert.deepEqual([receipt.allowed, receipt.code], [false, 'PLAN_MODE_READ_ONLY'], id);
  }
  assert.ok(run.data.reply.includes(plan), run.data.reply);
});

test('plan mode is an Agent Work mode: Side Chat ignores the flag', async t => {
  const question = 'What pH was used in the reactor?';
  const run = await runTurn(t, {
    prepare: async () => { const { payload, host } = await projectFixture({ question }); return { payload: { ...payload, desktopTools: { version: 1, collaborationMode: 'plan' } }, host }; },
    respond: () => ({ content: 'The reactor pH was 7.2.' }),
  });
  assert.doesNotMatch(run.requests[0].messages.find(message => message.role === 'system').content, /# Plan Mode/);
});

test('project memory: the summary reaches the model as earlier conversation context, only when there is one', async t => {
  const question = 'What pH was used in the reactor?';
  const summary = 'v1\n\n## User preferences\n- Report titres in g/L.';
  const run = await runTurn(t, {
    prepare: async () => {
      const { service, payload, host } = await projectFixture({ question });
      service.projectMemory = { summary: async () => summary };
      const localWorkspaceContext = await service.buildContext({ question, surface: 'side_chat', turnId: 'loop-turn', callContext: { model } });
      assert.deepEqual(localWorkspaceContext.memory, { version: 1, summary });
      return { payload: { ...payload, localWorkspaceContext }, host };
    },
    respond: () => ({ content: 'The reactor pH was 7.2.' }),
  });
  const memory = run.requests[0].messages.find(message => message.role === 'system' && message.content.startsWith('## Project memory'));
  assert.ok(memory, 'The memory message is sent');
  assert.match(memory.content, /not scientific evidence/);
  assert.ok(memory.content.includes(`<memory_summary>\n\n${summary}\n\n</memory_summary>`));
});

test('project memory: without a summary no memory message is sent', async t => {
  const question = 'What pH was used in the reactor?';
  const run = await runTurn(t, { prepare: async () => projectFixture({ question }), respond: () => ({ content: 'The reactor pH was 7.2.' }) });
  assert.ok(!run.requests[0].messages.some(message => message.content.startsWith('## Project memory')));
});

// Agent Work replays its conversation's canonical transcript (docs/agent-transcripts.js).
const ranCommand = transcript.normalize({ version: 1, turns: [
  { turnId: 'turn-stale', model, workspaceId: '', status: 'completed', startedAt: '2026-10-05T00:00:00Z', sequence: 2,
    bindings: [{ handle: 'source-old', identity: 'source:source-old', version: 'sha-old', sourceId: 'source-old', current: true }],
    messages: [{ role: 'user', content: 'What does the old protocol say?' }, { role: 'assistant', content: null, tool_calls: [toolCall('read_paper_evidence', { item_id: 'source-old' }, 'read-old')] },
      { role: 'tool', tool_call_id: 'read-old', name: 'read_paper_evidence', content: '{"text":"STALE_PROTOCOL_TEXT"}' }, { role: 'assistant', content: 'STALE_PROTOCOL_ANSWER' }] },
  { turnId: 'turn-1', model, workspaceId: '', status: 'completed', startedAt: '2026-10-06T00:00:00Z', sequence: 3, bindings: [],
    messages: [{ role: 'user', content: 'Summarise runs.csv into output/summary.md.' }, { role: 'assistant', content: null, tool_calls: [toolCall('exec_command', { cmd: 'python3 summarise.py' }, 'run-1')] },
      { role: 'tool', tool_call_id: 'run-1', name: 'exec_command', content: '{"output":"run A 4.2 g/L; run B 5.1 g/L","exit_code":0}' },
      { role: 'assistant', content: 'Wrote output/summary.md: run B is higher (5.1 g/L).' }] }] });
const followUp = (extra = {}) => async () => ({ host: async () => null, payload: { mode: 'agent_instruction', originalRequest: 'Now plot the same runs.',
  messages: [{ role: 'user', content: 'Now plot the same runs.' }], desktopTools: { version: 1, permission: 'read_only', projectId: 'loop-project' },
  callContext: { turnId: 'turn-2', callRole: 'answer', profile: 'medium' }, ...extra } });

test('Agent Work replays its transcript: earlier commands, results and answers reach the follow-up; changed sources stay withheld', async t => {
  const run = await runTurn(t, { prepare: followUp({ conversationTranscript: ranCommand }), respond: () => ({ content: agentFinal('Plotted runs A and B.') }) });
  assert.equal(run.status, 200, JSON.stringify(run.data));
  const sent = JSON.stringify(run.requests[0].messages);
  const call = run.requests[0].messages.find(message => message.tool_calls?.some(item => item.function.name === 'exec_command'));
  assert.ok(call, 'The earlier tool call is replayed');
  assert.match(run.requests[0].messages.find(message => message.tool_call_id === call.tool_calls[0].id).content, /run B 5\.1 g\/L/, 'with its result');
  assert.match(sent, /Wrote output\/summary\.md: run B is higher/, 'and its answer');
  assert.match(sent, /no_versioned_sources_reread_files_when_needed/, 'A turn that used no versioned source is labelled, not withheld');
  assert.ok(!sent.includes('STALE_PROTOCOL_TEXT') && !sent.includes('STALE_PROTOCOL_ANSWER'), 'A turn bound to a changed source is withheld');
  assert.ok(run.requests[0].messages.some(message => message.role === 'system' && /untrusted historical data/.test(message.content)));
  assert.equal(run.data.conversationTurn.turnId, 'turn-2', 'This turn is checkpointed for the transcript');
  assert.ok(run.events.some(event => event.type === 'transcript'), 'Checkpoints stream to the renderer');
});

test('Agent Work without a transcript replays nothing', async t => {
  const run = await runTurn(t, { prepare: followUp(), respond: () => ({ content: agentFinal('Plotted.') }) });
  assert.equal(run.status, 200, JSON.stringify(run.data));
  assert.ok(!JSON.stringify(run.requests[0].messages).includes('Historical exchange metadata'));
  assert.equal(run.data.conversationTurn, undefined);
});
