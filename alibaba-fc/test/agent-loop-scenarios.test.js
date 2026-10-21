'use strict';
// Agent-loop scenarios end to end through the production renderer turn code
// (docs/app.js sendWorkbenchRequest): the desktop agent loop (AgentLoopService
// -> loop host -> FC model proxy) against a scripted provider and real hosts.
// Each scenario records what the model, the host and the user saw and checks it.
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs/promises'), path = require('node:path');
const jwt = require('jsonwebtoken');
const transcript = require('../../shared/conversation-transcript.js');
const { InjectionQueue } = require('../../docs/runtime-turns.js');
const runtimeSessions = require('../../docs/runtime-session.js');
const { createFixture, SyncWorkspace } = require('./helpers/preflight-fixture.js');
const { ProjectContextService } = require('../../docs/project-context-service.js');
const { withEnv, temporaryDirectory, desktopRenderer } = require('./helpers/desktop-renderer.js');

const model = 'google/gemma-4-31b-it';
const BASE_ENV = { JWT_SECRET: 'scenario-fixture-secret', ADMIN_ACCOUNT: 'scenario-fixture', REQUESTY_API_KEY: 'scenario-fixture-key',
  REQUESTY_MODEL: model, REQUESTY_TOOL_MODE: 'sequential' };
const toolCall = (name, args = {}, id = name) => ({ id, type: 'function', function: { name, arguments: JSON.stringify(args) } });
const catalogHandle = (messages, pattern) => {
  const catalog = messages.find(message => /Workspace catalog of sources/.test(message.content))?.content || '';
  return catalog.split('\n').find(line => /item_id=/.test(line) && pattern.test(line))?.match(/item_id=([^ ]+)/)?.[1];
};
const SUBAGENT_PROMPT = 'You are a delegated BioDesign subagent.';
const SUMMARY_PROMPT = /^Create a factual working-state checkpoint/;
const CARD_PROMPT = 'You are compressing derived Paper Cards';
const isChild = request => request.messages.some(message => message.role === 'system' && String(message.content).includes(SUBAGENT_PROMPT));
const isSummary = request => !request.tools && request.messages.some(message => SUMMARY_PROMPT.test(String(message.content)));
const lastTool = request => request.messages.findLast(message => message.role === 'tool');
// Date is frozen in these tests; waits use the monotonic clock.
const until = async (predicate, ms = 2000) => { for (const end = performance.now() + ms; !predicate() && performance.now() < end;) await new Promise(resolve => setTimeout(resolve, 5)); };
const json = (status, body, headers = {}) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
// Progress packets report the remaining request time; the loop has none.
const REMAINING_TIME = /(\\*"(?:timeRemainingMs|hardDeadlineRemainingMs)\\*":)(null|[0-9.]+)/g;

// A scripted provider: respond(request, index, { signal, run }) returns an
// assistant message or a Response. Usage follows the request size.
function installProvider(t, respond) {
  const requests = [];
  t.mock.method(globalThis, 'fetch', async (url, options = {}) => {
    if (String(url).endsWith('/models')) return new Response(JSON.stringify({ data: [] }));
    const request = JSON.parse(options.body);
    requests.push(request);
    const reply = await respond(request, requests.length, { signal: options.signal });
    if (reply instanceof Response) return reply;
    const input = Math.ceil(options.body.length / 4);
    return new Response(JSON.stringify({ choices: [{ message: reply, finish_reason: reply.tool_calls?.length ? 'tool_calls' : 'stop' }],
      usage: { prompt_tokens: input, completion_tokens: 7, total_tokens: input + 7 } }), { headers: { 'content-type': 'application/json' } });
  });
  return { requests, reset() { requests.length = 0; } };
}

// ---- Fixtures ---------------------------------------------------------------

async function projectFixture({ question, turnId, extraPaper = false }) {
  const f = await createFixture();
  f.workspace.set('literature/SurfDock.pdf', 'SurfDock code availability: https://example.invalid/SurfDock. The reactor pH was 7.2.');
  f.workspace.set('literature/Other.pdf', 'Other unrelated work on reactor design.');
  if (extraPaper) f.workspace.set('literature/Third.pdf', 'Third paper on enzyme kinetics and reactor temperature 37 C.');
  await f.pipeline.preflight({ turnId: 'seed-fixture' });
  const service = new ProjectContextService({ workspace: f.workspace, literature: f.literature, sourceSystem: f.system, requestPipeline: f.pipeline,
    semanticInterpreter: { interpret() { throw Error('No planner for routine reads'); } } });
  const options = { question, surface: 'side_chat', turnId, callContext: { model } };
  await f.pipeline.preflight(options);
  return { f, service, context: await service.buildContext(options) };
}
const sideChat = (question, context, turnId, messages = [{ role: 'user', content: question }]) => ({ mode: 'side_chat', originalRequest: question, messages,
  conversationTranscript: transcript.normalize(), localWorkspaceContext: context, callContext: { turnId, callRole: 'answer', profile: 'medium' } });
const longHistory = question => {
  const long = label => `${label}: ${'Fermentation observation with titre, pH and temperature. '.repeat(120)}`;
  return [{ role: 'user', content: long('Q1') }, { role: 'assistant', content: long('A1') }, { role: 'user', content: long('Q2') },
    { role: 'assistant', content: long('A2') }, { role: 'user', content: question }];
};

// ---- Runner -----------------------------------------------------------------

// Runtime tools (skills, subagents, MCP) run inside the renderer's runtime
// session rather than through a project tool or workflow; record them as host work.
const recordingSessions = run => ({ create: async options => {
  const session = await runtimeSessions.create(options);
  const executeBatch = session.executeBatch;
  session.executeBatch = async group => {
    for (const call of group) run.hostCalls.push({ via: 'runtime', name: call.name, args: call.args });
    return executeBatch(group);
  };
  return session;
} });

// What a check reads besides the run: recovery telemetry and loop stop reasons.
function traceOf(run) {
  const recovery = run.result?.semanticTelemetry?.contextRecovery || run.result?.failure || null;
  return { compaction: recovery && { compactionCount: recovery.compactionCount, checkpointCount: recovery.checkpointCount },
    stopReasons: { loop: run.events.filter(event => event.stage === 'loop-budget-exhausted').map(event => event.reason) } };
}

async function runScenario(t, scenario) {
  // Fixture cards and receipts are stamped with the current time.
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-10-06T00:00:00Z') });
  withEnv(t, { ...BASE_ENV, ...(scenario.env || {}) });
  const token = jwt.sign({ account: BASE_ENV.ADMIN_ACCOUNT, role: 'admin' }, BASE_ENV.JWT_SECRET);
  const run = { mode: 'local', hostCalls: [], events: [], transcripts: [], error: null, result: null };
  const provider = installProvider(t, (request, index, extra) => scenario.respond(request, index, { ...extra, run }));
  const setup = await scenario.setup({ t, run });
  const original = setup.service.executeAgentTool.bind(setup.service);
  setup.service.executeAgentTool = async (call, options) => {
    run.hostCalls.push({ via: 'project', name: call.name, args: call.args });
    return original(call, options);
  };
  const workflow = async (id, input) => {
    if (id.startsWith('runtime_skills_context') || id === 'runtime_mcp_definitions') return undefined;
    run.hostCalls.push({ via: 'workflow', name: id, input });
    return setup.workflow ? setup.workflow(id, input) : undefined;
  };
  const { sandbox, ...bridge } = await desktopRenderer(t, { token, service: setup.service, selected: setup.selected || [], workflow,
    window: { BioDesignRuntimeSession: recordingSessions(run) } });
  run.bridge = bridge;
  try {
    run.result = await sandbox.sendWorkbenchRequest({ ...setup.body, ...(setup.queue ? { runtimeQueue: setup.queue } : {}), ...(setup.signal ? { signal: setup.signal } : {}),
      onStream: event => { run.events.push(structuredClone(event)); }, onTranscript: turn => { run.transcripts.push(structuredClone(turn)); } });
  } catch (error) { run.error = { code: error.code, message: error.message }; }
  await scenario.settle?.(run);
  run.requests = provider.requests;
  const remaining = provider.requests.flatMap(request => [...JSON.stringify(request).matchAll(REMAINING_TIME)].map(match => match[2]));
  assert.ok(remaining.every(value => value === 'null'), 'The loop has no request deadline');
  await scenario.check?.({ local: run }, { local: traceOf(run) });
}

// ---- Scenarios --------------------------------------------------------------

const scenario = definition => test(`agent loop: ${definition.name}`, { timeout: 30000 }, t => runScenario(t, definition));

scenario({
  name: 'plain answer',
  setup: async () => {
    const question = 'What reactor pH does the project report?';
    const { service, context } = await projectFixture({ question, turnId: 'plain-turn' });
    return { service, body: sideChat(question, context, 'plain-turn') };
  },
  respond: () => ({ content: 'The project reports a reactor pH of 7.2.' }),
  check: runs => {
    assert.equal(runs.local.result.reply, 'The project reports a reactor pH of 7.2.');
    assert.equal(runs.local.requests.length, 1);
  },
});

scenario({
  name: 'multi-step tools (inline and host)',
  setup: async () => {
    const question = 'Check what the workspace holds, then what the papers say about the reactor.';
    const { service, context } = await projectFixture({ question, turnId: 'multi-turn', extraPaper: true });
    return { service, body: sideChat(question, context, 'multi-turn') };
  },
  respond: (request, index) => {
    if (index === 1) return { tool_calls: [toolCall('list_workspace_items', { limit: 10 }, 'list')] };
    if (index === 2) return { tool_calls: [toolCall('search_project_knowledge', { query: 'reactor' }, 'search')] };
    if (index === 3) {
      const ids = [/SurfDock/, /Third/].map(pattern => catalogHandle(request.messages, pattern));
      return { tool_calls: ids.map((id, i) => toolCall('retrieve_project_evidence', { query: 'reactor', requirement: { scope: { type: 'single_source', sourceIds: [id] } } }, `read-${i}`)) };
    }
    return { content: 'The papers report pH 7.2 and 37 C for the reactor.' };
  },
  check: runs => {
    assert.equal(runs.local.requests.length, 4);
    assert.deepEqual(runs.local.hostCalls.map(call => call.name), ['search_project_knowledge', 'retrieve_project_evidence', 'retrieve_project_evidence']);
  },
});

scenario({
  name: 'evidence retrieval with citations',
  setup: async ({ run }) => {
    const question = 'SurfDock有源代码吗？';
    const { service, context } = await projectFixture({ question, turnId: 'evidence-turn' });
    run.reference = null;
    return { service, body: sideChat(question, context, 'evidence-turn') };
  },
  respond: (request, index, { run }) => {
    const itemId = catalogHandle(request.messages, /SurfDock/);
    if (index === 1) return { tool_calls: ['search_project_knowledge', 'retrieve_project_evidence'].map((name, i) => toolCall(name,
      { query: 'source code', requirement: { scope: { type: 'single_source', sourceIds: [itemId] } } }, `call-${i}`)) };
    if (index === 2) {
      const results = request.messages.filter(message => message.role === 'tool').map(message => JSON.parse(message.content));
      run.reference = results[1].evidenceBundle.items[0].references[0].reference;
      return { tool_calls: [toolCall('read_paper_evidence', { item_id: itemId, evidence_ref: run.reference, max_characters: 500 }, 'read')] };
    }
    return { content: `找到了源码说明。[[cite:${run.reference}]]` };
  },
  check: runs => {
    assert.equal(runs.local.result.citations.length, 1);
    assert.equal(runs.local.result.citations[0].page, 1);
  },
});

const corpusQuestion = '帮我总结所有文献，写个综述。';
scenario({
  name: 'corpus workflow',
  setup: async () => {
    const f = await createFixture();
    for (let i = 1; i <= 3; i++) f.workspace.set(`literature/P${i}.pdf`,
      (`Paper ${i} reports ectoine production using methane at pH ${6 + i}. Salinity affects osmotic stress. `).repeat(180));
    f.system.corpusWorkflows.mapWorker = () => { throw Error('No per-paper provider calls'); };
    const service = new ProjectContextService({ workspace: f.workspace, literature: f.literature, sourceSystem: f.system, requestPipeline: f.pipeline });
    await f.pipeline.preflight({ turnId: 'seed-cached-evidence', callContext: { model } });
    const context = await service.buildContext({ question: corpusQuestion, surface: 'side_chat', turnId: 'corpus-turn', callContext: { model }, language: 'zh' });
    return { service, body: sideChat(corpusQuestion, context, 'corpus-turn') };
  },
  respond: (request, index) => {
    if (request.messages[0].content.startsWith(CARD_PROMPT)) {
      const data = JSON.parse(request.messages[1].content);
      return { content: JSON.stringify({ papers: data.units.map(unit => ({ handle: unit.handle, part: unit.part, summary: 'Qualified methane and salinity finding.',
        omissions: ['Fine experimental detail omitted.'] })), synthesis: [], omissions: ['Exact values omitted.'], limitations: ['Derived cards; original evidence not read.'] }) };
    }
    if (isSummary(request)) return { content: 'Corpus review checkpoint.' };
    if (index === 1) return { tool_calls: [toolCall('run_corpus_workflow', { requirement: { task: 'literature_review', coverage: 'exhaustive', granularity: 'concept',
      claimSupport: 'required', scope: { type: 'project' }, domains: ['literature'], freshness: 'current' } }, 'corpus')] };
    const view = JSON.parse(lastTool(request).content);
    const papers = view.findings?.papers || [];
    return { content: `逐篇总结与综述：三篇论文讨论了甲烷与渗透压。${papers.map(paper => `[[cite:${paper.originalEvidence[0].reference}]]`).join(' ')}` };
  },
  check: runs => {
    assert.deepEqual(runs.local.hostCalls.map(call => call.name), ['run_corpus_workflow']);
    assert.match(runs.local.result.reply, /逐篇总结与综述/);
    assert.equal(runs.local.result.corpusCoverage.complete, true);
  },
});


scenario({
  name: 'input-quota recovery (wait, then compaction)',
  setup: async () => {
    const question = 'Summarize the current fermentation status.';
    const { service, context } = await projectFixture({ question, turnId: 'quota-turn' });
    return { service, body: sideChat(question, context, 'quota-turn', longHistory(question)) };
  },
  // The cooldown must outlast the retry dispatch under load; an elapsed
  // cooldown needs no wait.
  respond: (request, index) => index === 1
    ? json(429, { error: { code: 'input_token_quota_exceeded', message: 'Input token quota exhausted', details: { retry_after_ms: 600, capacity: 6000 } } })
    : isSummary(request) ? { content: 'Checkpoint: titre stable, pH 7.2.' } : { content: 'Fermentation is stable at pH 7.2.' },
  check: (runs, traces) => {
    assert.equal(runs.local.result.reply, 'Fermentation is stable at pH 7.2.');
    assert.ok(traces.local.compaction.checkpointCount >= 1, 'History was checkpointed to fit the quota');
    for (const run of [runs.local]) assert.ok(run.events.some(event => event.stage === 'context-recovery' && event.event === 'quota-wait'), `${run.mode}: the provider cooldown is waited out`);
  },
});

scenario({
  name: 'input-quota rejection that cannot be reduced',
  setup: async () => {
    const question = 'What reactor pH does the project report?';
    const { service, context } = await projectFixture({ question, turnId: 'quota-stop-turn' });
    return { service, body: sideChat(question, context, 'quota-stop-turn') };
  },
  respond: () => json(429, { error: { message: 'Quota exceeded for metric: input_tokens_per_minute, limit: 500000. Retry in 0.02s.' } }),
  // The turn ends with its failure result: the reply explains that the
  // provider rejected the input and what was preserved.
  check: runs => {
    for (const run of [runs.local]) {
      assert.equal(run.error, null, run.mode);
      assert.equal(run.result.fallback, true); assert.equal(run.result.taskOutcome.status, 'incomplete');
      assert.equal(run.result.error, 'InputQuotaRecoveryIncomplete');
      assert.equal(run.requests.length, 1, `${run.mode}: no reduction is possible, so the request is not resent`);
    }
  },
});

scenario({
  name: 'provider rate limit: wait and retry',
  setup: async () => {
    const question = 'What reactor pH does the project report?';
    const { service, context } = await projectFixture({ question, turnId: 'rate-turn' });
    return { service, body: sideChat(question, context, 'rate-turn') };
  },
  respond: (request, index) => index === 1 ? json(429, { error: { message: 'Rate limit exceeded. Please retry in 0.05s.' } }, { 'retry-after': '0.05' })
    : { content: 'The project reports a reactor pH of 7.2.' },
  check: runs => {
    for (const run of [runs.local]) {
      assert.equal(run.requests.length, 2, run.mode);
      assert.deepEqual(run.requests[1], run.requests[0], `${run.mode}: the same request is retried after the wait`);
      assert.equal(run.result?.reply, 'The project reports a reactor pH of 7.2.');
    }
  },
});

scenario({
  name: 'loop budget exhaustion → forced synthesis',
  env: { AGENT_MAX_STEPS: '3' },
  setup: async () => {
    const question = 'List the workspace items repeatedly.';
    const { service, context } = await projectFixture({ question, turnId: 'budget-turn' });
    return { service, body: sideChat(question, context, 'budget-turn') };
  },
  respond: (request, index) => request.tools?.length ? { tool_calls: [toolCall('list_workspace_items', { limit: index }, `list-${index}`)] }
    : { content: 'Synthesis from the listed items.' },
  check: (runs, traces) => {
    assert.deepEqual(traces.local.stopReasons.loop, ['step_budget_exhausted']);
    assert.equal(runs.local.requests.at(-1).tools, undefined, 'The final synthesis exposes no tools');
    assert.equal(runs.local.result.reply, 'Synthesis from the listed items.');
  },
});

scenario({
  name: 'cancellation mid-turn',
  setup: async ({ run }) => {
    const question = 'SurfDock有源代码吗？';
    const { service, context } = await projectFixture({ question, turnId: 'cancel-turn' });
    run.controller = new AbortController();
    run.providerAborted = false;
    run.providerSettled = null;
    return { service, signal: run.controller.signal, body: sideChat(question, context, 'cancel-turn') };
  },
  respond: (request, index, { signal, run }) => {
    if (index === 1) return { tool_calls: [toolCall('retrieve_project_evidence', { query: 'source code',
      requirement: { scope: { type: 'single_source', sourceIds: [catalogHandle(request.messages, /SurfDock/)] } } }, 'read')] };
    // The user stops the turn while the model is generating, once the
    // renderer has shown the second request (on FC the step's events can
    // otherwise still be unread in the socket when the stop lands).
    run.providerSettled = new Promise((resolve, reject) => {
      const timer = setTimeout(() => resolve({ content: 'Generated after the stop.' }), 3000);
      const stop = () => { clearTimeout(timer); run.providerAborted = true; reject(Object.assign(new Error('The operation was aborted.'), { name: 'AbortError' })); };
      if (signal?.aborted) stop(); else signal?.addEventListener('abort', stop, { once: true });
    });
    return until(() => run.events.filter(event => event.stage === 'provider-request').length >= 2)
      .then(() => { run.controller.abort(); return run.providerSettled; });
  },
  // Let the cancelled provider call and any loop shutdown finish before the
  // traces are taken, so a late request would be seen.
  settle: async run => {
    await run.providerSettled?.catch(() => {});
    await new Promise(resolve => setTimeout(resolve, 100));
    run.cancelled = { providerAborted: run.providerAborted, activeTurns: run.bridge?.loop.turns.size ?? 0 };
  },
  check: runs => {
    for (const run of [runs.local]) {
      assert.equal(run.error?.code, 'OPERATION_ABORTED', run.mode);
      assert.equal(run.requests.length, 2, `${run.mode}: no provider call after the stop`);
      assert.equal(run.cancelled.providerAborted, true, `${run.mode}: the in-flight provider call is aborted`);
    }
    assert.equal(runs.local.cancelled.activeTurns, 0);
    assert.equal(runs.local.bridge.cancels.length, 1);
  },
});

scenario({
  name: 'steering injection at a tool boundary',
  setup: async ({ run }) => {
    const question = 'SurfDock有源代码吗？';
    const { service, context } = await projectFixture({ question, turnId: 'steer-turn' });
    run.queue = new InjectionQueue();
    return { service, queue: run.queue, body: sideChat(question, context, 'steer-turn') };
  },
  respond: (request, index, { run }) => {
    if (index === 1) {
      run.queue.enqueue('Answer in one sentence.', { id: 'steer-1' });
      return { tool_calls: [toolCall('retrieve_project_evidence', { query: 'source code',
        requirement: { scope: { type: 'single_source', sourceIds: [catalogHandle(request.messages, /SurfDock/)] } } }, 'read')] };
    }
    return { content: 'SurfDock links its code at example.invalid.' };
  },
  check: runs => {
    const steered = runs.local.requests[1].messages.filter(message => message.role === 'user' && message.content === 'Answer in one sentence.');
    assert.equal(steered.length, 1);
    assert.equal(runs.local.bridge.replies[0].runtimeInjections[0].id, 'steer-1');
  },
});

scenario({
  name: 'steering injection after a final answer',
  setup: async ({ run }) => {
    const question = 'What reactor pH does the project report?';
    const { service, context } = await projectFixture({ question, turnId: 'steer-final-turn' });
    run.queue = new InjectionQueue();
    return { service, queue: run.queue, body: sideChat(question, context, 'steer-final-turn') };
  },
  respond: (request, index, { run }) => {
    if (index === 1) { run.queue.enqueue('Also name the paper.', { id: 'steer-2' }); return { content: 'The reactor pH was 7.2.' }; }
    return { content: 'The reactor pH was 7.2 (SurfDock paper).' };
  },
  check: runs => {
    assert.equal(runs.local.requests.length, 2);
    assert.equal(runs.local.result.reply, 'The reactor pH was 7.2 (SurfDock paper).');
  },
});

scenario({
  name: 'subagent (spawn and wait)',
  setup: async () => {
    const question = 'Have a subagent check the reactor conditions, then summarize.';
    const { service, context } = await projectFixture({ question, turnId: 'parent-turn' });
    return { service, body: { mode: 'agent_instruction', originalRequest: question, messages: [{ role: 'user', content: question }], localWorkspaceContext: context,
      desktopTools: { version: 1, literatureVersion: 1, permission: 'full_access', projectId: context.project.workspaceId },
      callContext: { turnId: 'parent-turn', callRole: 'answer', profile: 'medium' } } };
  },
  respond: request => {
    if (isChild(request)) return { content: 'Child finding: the reactor ran at pH 7.2.' };
    if (!request.messages.some(message => message.role === 'tool' && message.tool_call_id === 'spawn-1'))
      return { tool_calls: [toolCall('spawn', { task: 'Check the reactor conditions in the project papers.', label: 'Reactor check', wait: true }, 'spawn-1')] };
    return { content: 'Summary: the subagent confirmed pH 7.2.' };
  },
  check: runs => {
    for (const run of [runs.local]) {
      assert.equal(run.requests.filter(isChild).length, 1, run.mode);
      assert.match(run.result.reply, /pH 7.2/);
    }
    assert.equal(runs.local.bridge.starts.length, 2, 'Parent and child each run as a local turn');
  },
});

for (const [label, change] of [['an unlisted code (invalid transcript)', body => ({ ...body, conversationTranscript: { version: 2 } })],
  ['a reported code (invalid call context)', body => ({ ...body, callContext: { ...body.callContext, extra: true } })]]) scenario({
  name: `request rejected at admission: ${label}`,
  setup: async () => {
    const question = 'What reactor pH does the project report?';
    const { service, context } = await projectFixture({ question, turnId: 'rejected-turn' });
    return { service, body: change(sideChat(question, context, 'rejected-turn')) };
  },
  respond: () => { throw new Error('A rejected request reaches no model'); },
  check: runs => {
    for (const run of [runs.local]) assert.equal(run.requests.length, 0, run.mode);
    assert.equal(runs.local.error.code, label.includes('reported') ? 'INVALID_CALL_CONTEXT' : 'BACKEND_HTTP_ERROR');
  },
});
