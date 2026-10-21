'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { mkdtemp, rm } = require('node:fs/promises'), path = require('node:path'), os = require('node:os');
const jwt = require('jsonwebtoken');
const { demandFixture } = require('./helpers/demand-context-fixture.js');
const academic = require('../../shared/academic-tools.js'), literature = require('../../shared/literature-agent.js');
const call = (name, args) => ({ id: name, type: 'function', function: { name, arguments: JSON.stringify(args) } });

for (const scenario of ['single', 'batch', 'failure', 'transport', 'cancel', 'busy', 'input-quota', 'raw-finish']) test(`production renderer → agent loop → specialist → local host → resume: ${scenario}`, async t => {
  const providerFailure = scenario === 'failure', batch = scenario === 'batch';
  const finishArguments = scenario === 'raw-finish' ? { candidates: Array.from({ length: 65 }, (_, i) => ({ title: `论文 ${i}`, url: `https://example.org/paper?id=${i}` })), notes: 'Unvalidated specialist findings', results: [{ status: 'downloaded', file: 'model-claim.pdf' }] } : { candidates: [], limitations: ['No corroborated records in this fixture.'] };
  const { ProjectFilesystem } = await import('../../desktop/services/project-filesystem.mjs');
  const { LiteratureWorkflows } = await import('../../desktop/services/literature-workflows.mjs');
  const root = await mkdtemp(path.join(os.tmpdir(), 'literature-e2e-')); t.after(() => rm(root, { recursive: true, force: true }));
  const filesystem = await ProjectFilesystem.open(root);
  const model = 'fixture/literature-selected';
  const env = { JWT_SECRET: 'fixture-secret', ADMIN_ACCOUNT: 'literature-fixture', REQUESTY_API_KEY: 'fixture-key', REQUESTY_MODEL: model, REQUESTY_TOOL_MODE: 'sequential', REQUESTY_MODEL_CAPABILITIES_JSON: JSON.stringify({ [model]: { supportsTools: true, supportsWebSearch: false, supportsImages: false } }) };
  const previous = Object.fromEntries(Object.keys(env).map(key => [key, process.env[key]])); Object.assign(process.env, env);
  t.after(() => { for (const [key, value] of Object.entries(previous)) value === undefined ? delete process.env[key] : process.env[key] = value; });
  const token = jwt.sign({ account: env.ADMIN_ACCOUNT, role: 'admin' }, env.JWT_SECRET);
  const { browserFixture } = await import('../../desktop/test/helpers/literature-browser-fixture.mjs');
  const { browser, calls: browserCalls } = browserFixture(t, root);
  const active = { filesystem, sourceDownloads: new AbortController(), paperMcp: { async start() { throw new Error('Unavailable fixture provider'); } } };
  const host = new LiteratureWorkflows(active, browser, () => true);
  const policy = { permission: 'workspace_write', authorization: { download: true }, model, scopePaths: null };
  const competing = scenario === 'busy' ? await host.run({ ...policy, action: 'begin', kind: 'discover_papers', task: { objective: 'Existing active job', queries: ['enzyme'] }, libraryAccess: { url: 'https://example.org/library' } }) : null;
  const requestController = new AbortController();
  const f = await demandFixture();
  const query = '帮我检索AI和合成生物学结合的文献，并下载。';
  const context = await f.service.buildContext({ ...f.options, question: query, turnId: 'literature-e2e', callContext: { model } });
  const noPreparation = () => { assert.equal(f.calls.cards, 0); assert.equal(f.calls.parses, 0); assert.equal(f.calls.indexing, 0); assert.equal(f.workspace.rawReads, 0); };
  noPreparation();
  let models = 0, specialistRequests = 0, beforeQuota, lastMain; const stages = [];
  t.mock.method(globalThis, 'fetch', async (_url, options) => {
    const request = JSON.parse(options.body); noPreparation(); assert.equal(request.model, model); models++;
    let message;
    if (request.tools.some(tool => tool.function?.name === 'discover_papers')) {
      assert(!JSON.stringify(request.messages).includes('RAW_BROWSER_SNAPSHOT')); stages.push('main'); lastMain = request;
      if (models === 1) message = { tool_calls: [call('discover_papers', { objective: 'Find enzyme evidence', queries: ['enzyme'] })] };
      else {
        if (scenario === 'raw-finish') {
          const discovery = request.messages.find(message => message.role === 'tool' && message.tool_call_id === 'discover_papers');
          assert.deepEqual(JSON.parse(discovery.content), finishArguments);
        }
        message = { content: 'Completed report with explicit coverage limits.' };
      }
    } else {
      stages.push('specialist'); assert(JSON.stringify(request.messages).includes('RAW_BROWSER_SNAPSHOT'));
      if (scenario === 'input-quota') {
        specialistRequests++;
        if (specialistRequests === 1) return new Response(JSON.stringify({ choices: [{ message: { tool_calls: [
          { ...call('browser_snapshot', {}), id: 'quota_snapshot_1' }, { ...call('browser_snapshot', {}), id: 'quota_snapshot_2' },
        ] } }] }));
        if (specialistRequests === 2) {
          beforeQuota = structuredClone(request.messages);
          assert(beforeQuota.filter(message => message.role === 'tool').every(message => message.content.length > 120));
          return new Response(JSON.stringify({ error: { code: 'input_token_quota_exceeded', message: 'Input token quota exceeded' } }), { status: 429, headers: { 'retry-after': '0' } });
        }
        assert.equal(specialistRequests, 3);
        const results = request.messages.filter(message => message.role === 'tool');
        assert.equal(results[0].content, '[Earlier tool result compacted. Re-run if needed.]');
        assert.deepEqual(results[1], beforeQuota.filter(message => message.role === 'tool')[1]);
        assert.deepEqual(request.messages.filter(message => message.role !== 'tool'), beforeQuota.filter(message => message.role !== 'tool'));
        assert.equal(browser.owner, [...host.jobs.keys()][0]);
      }
      if (providerFailure) return new Response(JSON.stringify({ error: { code: 'invalid_request_error', message: 'Unsupported provider parameter' } }), { status: 400, headers: { 'x-request-id': 'specialist-failure-fixture' } });
      message = { tool_calls: [...(batch ? [
        { ...call('browser_snapshot', {}), id: 'snapshot_1' }, { ...call('browser_snapshot', {}), id: 'snapshot_2' },
      ] : []), call('finish_discovery', finishArguments)] };
    }
    return new Response(JSON.stringify({ choices: [{ message }] }));
  });
  let allowLibrary, requestedLibrary, prompts = 0;
  const libraryGate = new Promise(resolve => { allowLibrary = resolve; });
  const libraryPrompted = new Promise(resolve => { requestedLibrary = resolve; });
  const { sandbox, agent, starts, replies } = await require('./helpers/desktop-renderer.js').desktopRenderer(t, { token, service: f.service,
    workflow: (workflowId, input) => workflowId === 'literature_worker' ? host.run(input) : undefined,
    globals: { currentAccount: 'fixture', currentLanguage: 'en', workspaceAbortController: new AbortController() },
    window: { BioDesignLibrarySettings: { edit() { prompts++; requestedLibrary(); return libraryGate; } }, BioDesignLiteratureAgent: literature } });
  // What reached the loop: the turn's start and each boundary reply carrying host receipts.
  const requests = () => [...starts.map(start => start.body), ...replies.filter(reply => reply?.desktopToolResults?.length)];
  // The connection to the loop fails, or the user stops the turn, between handoffs.
  if (['transport', 'cancel'].includes(scenario)) {
    const respond = agent.respond;
    agent.respond = async payload => {
      if (payload.reply?.desktopToolResults?.length) {
        if (scenario === 'cancel') requestController.abort();
        throw Object.assign(new Error('Connection interrupted between handoffs'), { code: scenario === 'cancel' ? 'OPERATION_ABORTED' : 'TEST_CONNECTION_LOST' });
      }
      return respond(payload);
    };
  }
  const pending = sandbox.sendWorkbenchRequest({ signal: requestController.signal, mode: 'agent_instruction', model, messages: [{ role: 'user', content: query }], originalRequest: query,
    localWorkspaceContext: context,
    desktopTools: { version: 1, literatureVersion: 1, permission: 'workspace_write', projectId: context.project.workspaceId }, callContext: { turnId: 'literature-e2e', callRole: 'answer', profile: 'medium' } });
  await libraryPrompted; noPreparation(); assert.equal(host.jobs.size, competing ? 1 : 0); assert.deepEqual(stages, ['main']);
  allowLibrary({ url: 'https://example.org/library' });
  if (['transport', 'cancel'].includes(scenario)) {
    await assert.rejects(pending, { code: scenario === 'cancel' ? 'OPERATION_ABORTED' : 'TEST_CONNECTION_LOST' });
    assert.equal(browser.owner, null);
    const job = [...host.jobs.values()][0]; assert.equal(job.status, scenario === 'cancel' ? 'cancelled' : 'failed');
    assert(job.observations.includes('RAW_BROWSER_SNAPSHOT'));
    const resumed = await host.run({ ...policy, action: 'resume', job_id: job.id });
    assert(resumed.tools); assert.equal(browser.owner, job.id); return;
  }
  const result = await pending; noPreparation(); assert.equal(prompts, 1);
  if (scenario === 'busy') {
    assert.match(result.reply, /BROWSER_BUSY/); assert.doesNotMatch(result.reply, /provider could not complete|模型服务无法完成/);
    assert.equal(result.literatureBlocked.status, 'blocked');
    assert.equal(result.failure.code, 'BROWSER_BUSY'); assert.equal(result.failure.ownerId, competing.job_id);
    assert.deepEqual(stages, ['main']); assert.equal(browser.owner, competing.job_id);
    assert.equal(result.desktopToolCalls, undefined); return;
  }
  if (providerFailure) {
    assert.match(result.reply, /模型服务无法完成|provider could not complete/); assert.doesNotMatch(result.reply, /budget exhausted/);
    assert.equal(result.failure.providerStatus, 400);
    assert.equal(result.failure.failureStage, 'literature-specialist.provider');
    assert.equal(result.failure.requestId, 'specialist-failure-fixture');
    assert.deepEqual(result.failure.providerCodes, ['invalid_request_error']);
    assert.deepEqual(stages, ['main', 'specialist']); assert.equal(requests().length, 2);
    assert.equal(result.desktopToolCalls, undefined);
    const job = host.jobs.get(result.failure.jobId); assert.equal(job.status, 'failed'); assert.equal(browser.owner, null);
    assert(job.observations.includes('RAW_BROWSER_SNAPSHOT'));
    const next = await host.run({ ...policy, action: 'begin', kind: 'discover_papers', task: { objective: 'Subsequent job', queries: ['enzyme'] }, libraryAccess: { url: 'https://example.org/library' } });
    assert(next.tools); assert.equal(browser.owner, next.job_id);
    await host.run({ ...policy, action: 'suspend', job_id: next.job_id });
    const resumed = await host.run({ ...policy, action: 'resume', job_id: job.id });
    assert(resumed.tools); assert.equal(browser.owner, job.id);
    return;
  }
  // The request also asks to download; a report without a proposed retrieval gets one corrective main turn.
  assert.equal(result.reply, 'Completed report with explicit coverage limits.'); assert.deepEqual(stages, scenario === 'input-quota' ? ['main', 'specialist', 'specialist', 'specialist', 'main', 'main'] : ['main', 'specialist', 'main', 'main']);
  assert.match(JSON.stringify(lastMain.messages), /Completion check: the original request asks for papers to be downloaded/);
  assert.equal(requests().length, batch || scenario === 'input-quota' ? 5 : 3);
  assert.deepEqual(browserCalls, batch || scenario === 'input-quota' ? ['browser_navigate', 'browser_snapshot', 'browser_snapshot', 'browser_snapshot'] : ['browser_navigate', 'browser_snapshot']);
  if (batch) {
    const handoffIds = requests().slice(1).flatMap(request => request.desktopToolResults.map(result => result.id));
    assert.equal(new Set(handoffIds).size, 4);
  }
  assert.equal(result.literatureResults[0].status, 'completed');
  assert.deepEqual(result.literatureResults[0].discoveryArguments, finishArguments);
  assert.deepEqual(result.downloadResults, []); // Discovery prose is never a host download receipt.
});
