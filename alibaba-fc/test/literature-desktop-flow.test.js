'use strict';
const test = require('node:test'), assert = require('node:assert/strict'), vm = require('node:vm');
const { readFile, mkdtemp, rm } = require('node:fs/promises'), path = require('node:path'), os = require('node:os');
const jwt = require('jsonwebtoken'), backend = require('../index.js');
const { demandFixture } = require('./helpers/demand-context-fixture.js');
const academic = require('../../shared/academic-tools.js'), literature = require('../../shared/literature-agent.js');
const sourceDownload = require('../../shared/source-download.js'), webSearch = require('../../shared/web-search.js'), eventStream = require('../../shared/event-stream.js');
const call = (name, args) => ({ id: name, type: 'function', function: { name, arguments: JSON.stringify(args) } });

for (const scenario of ['single', 'batch', 'failure', 'transport', 'cancel', 'busy']) test(`production renderer → authenticated backend → specialist → local host → signed resume: ${scenario}`, async t => {
  const providerFailure = scenario === 'failure', batch = scenario === 'batch';
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
  let models = 0; const stages = [];
  t.mock.method(globalThis, 'fetch', async (_url, options) => {
    const request = JSON.parse(options.body); noPreparation(); assert.equal(request.model, model); models++;
    let message;
    if (request.tools.some(tool => tool.function?.name === 'discover_papers')) {
      assert(!JSON.stringify(request.messages).includes('RAW_BROWSER_SNAPSHOT')); stages.push('main');
      if (models === 1) message = { tool_calls: [call('discover_papers', { objective: 'Find enzyme evidence', queries: ['enzyme'] })] };
      else message = { content: 'Completed report with explicit coverage limits.' };
    } else {
      stages.push('specialist'); assert(JSON.stringify(request.messages).includes('RAW_BROWSER_SNAPSHOT'));
      if (providerFailure) return new Response(JSON.stringify({ error: { code: 'invalid_request_error', message: 'Unsupported provider parameter' } }), { status: 400, headers: { 'x-request-id': 'specialist-failure-fixture' } });
      message = { tool_calls: [...(batch ? [
        { ...call('browser_snapshot', {}), id: 'snapshot_1' }, { ...call('browser_snapshot', {}), id: 'snapshot_2' },
      ] : []), call('finish_discovery', { candidates: [], limitations: ['No corroborated records in this fixture.'] })] };
    }
    return new Response(JSON.stringify({ choices: [{ message }] }));
  });
  const app = await readFile(path.resolve(__dirname, '../../docs/app.js'), 'utf8');
  const functions = ['sendWorkbenchRequest', 'sendWorkbenchRequestOnce'].map(name => app.match(new RegExp(`^async function ${name}\\([\\s\\S]*?^}$`, 'm'))[0]).join('\n');
  const requests = []; let allowLibrary, requestedLibrary, prompts = 0;
  const libraryGate = new Promise(resolve => { allowLibrary = resolve; });
  const libraryPrompted = new Promise(resolve => { requestedLibrary = resolve; });
  const sandbox = vm.createContext({ console, JSON, Math, Date, Error, AbortController, Response, TextDecoder, setTimeout, clearTimeout, currentAccount: 'fixture', currentLanguage: 'en',
    projectContextService: null, MAX_BROWSER_REFERENCE_FILES: 1, TOTAL_REFERENCE_TEXT_LIMIT: 100, workspaceAbortController: new AbortController(), workspaceManager: { workspace: { workspaceId: 'project-1' } }, authToken: token,
    experimentModuleCards: [], referenceDocuments: [], activeSideChatDocumentKeys: [], runtimeLog: null, literatureModule: null,
    buildExperimentModulesForRequest: () => ({}), buildFlattenedExperimentDocumentsForRequest: () => [], collectExperimentNotesForRequest: () => [], collectSelectedStoredDocumentKeys: () => [], collectStoredDocumentsForRequest: () => [],
    buildDocumentsForRequest: () => [], getProjectContext: () => '', backendUrl: route => route, getAuthHeaders: headers => ({ ...headers, authorization: `Bearer ${token}` }), requireLoginForUnauthorized: () => {}, t: key => key,
    fetch: async (route, options) => { requests.push(JSON.parse(options.body));
      if (requests.length === 2 && ['transport', 'cancel'].includes(scenario)) {
        if (scenario === 'cancel') requestController.abort();
        throw Object.assign(new Error('Connection interrupted between handoffs'), { code: scenario === 'cancel' ? 'OPERATION_ABORTED' : 'TEST_CONNECTION_LOST' });
      }
      const result = await backend.handler({ httpMethod: 'POST', path: route, headers: options.headers, body: options.body }, {}); return new Response(result.body, { status: result.statusCode, headers: result.headers }); },
    window: { BioDesignLibrarySettings: { edit() { prompts++; requestedLibrary(); return libraryGate; } }, BioDesignAcademicTools: academic, BioDesignLiteratureAgent: literature, BioDesignSourceDownload: sourceDownload, BioDesignWebSearch: webSearch, BioDesignEventStream: eventStream,
      biodesignDesktop: { execution: { runWorkflow: ({ workflowId, input }) => { assert.equal(workflowId, 'literature_worker'); return host.run(input); } } } },
  });
  vm.runInContext(functions, sandbox);
  const pending = sandbox.sendWorkbenchRequest({ signal: requestController.signal, desktopRound: 150, mode: 'agent_instruction', model, messages: [{ role: 'user', content: query }], originalRequest: query,
    localWorkspaceContext: context,
    desktopTools: { version: 1, academicVersion: 1, literatureVersion: 1, permission: 'workspace_write', projectId: 'project-1' }, callContext: { turnId: 'literature-e2e', callRole: 'answer', profile: 'medium' } });
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
    assert.deepEqual(stages, ['main', 'specialist']); assert.equal(requests.length, 2);
    assert(requests[1].desktopContinuation); assert.equal(result.desktopToolCalls, undefined);
    const job = host.jobs.get(result.failure.jobId); assert.equal(job.status, 'failed'); assert.equal(browser.owner, null);
    assert(job.observations.includes('RAW_BROWSER_SNAPSHOT'));
    const next = await host.run({ ...policy, action: 'begin', kind: 'discover_papers', task: { objective: 'Subsequent job', queries: ['enzyme'] }, libraryAccess: { url: 'https://example.org/library' } });
    assert(next.tools); assert.equal(browser.owner, next.job_id);
    await host.run({ ...policy, action: 'suspend', job_id: next.job_id });
    const resumed = await host.run({ ...policy, action: 'resume', job_id: job.id });
    assert(resumed.tools); assert.equal(browser.owner, job.id);
    return;
  }
  assert.equal(result.reply, 'Completed report with explicit coverage limits.'); assert.deepEqual(stages, ['main', 'specialist', 'main']);
  assert.equal(requests.length, batch ? 5 : 3); assert(requests[1].desktopContinuation);
  assert.deepEqual(browserCalls, batch ? ['browser_navigate', 'browser_snapshot', 'browser_snapshot', 'browser_snapshot'] : ['browser_navigate', 'browser_snapshot']);
  if (batch) {
    const handoffIds = requests.slice(1).flatMap(request => request.desktopToolResults.map(result => result.id));
    assert.equal(new Set(handoffIds).size, 4);
  }
  assert.equal(result.literatureResults[0].status, 'partial');
});
