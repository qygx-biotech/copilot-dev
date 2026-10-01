'use strict';
const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), vm = require('node:vm');
const { demandFixture } = require('./helpers/demand-context-fixture.js');
const noPreparation = f => { assert.equal(f.calls.cards, 0); assert.equal(f.calls.parses, 0); assert.equal(f.calls.indexing, 0); assert.equal(f.workspace.rawReads, 0); };

for (const { question, cancel } of [
  { question: '帮我检索AI和合成生物学结合的文献，并下载。' }, { question: '你好' },
  { question: 'Rewrite this sentence: AI can help scientists.' }, { question: 'Cancelled request', cancel: true },
]) {
  test(`production Agent Work reaches its main request without preparing existing PDFs: ${question}`, async () => {
    const f = await demandFixture();
    const source = fs.readFileSync(require.resolve('../../docs/app.js'), 'utf8');
    const run = source.match(/^async function runAgentInstruction\([\s\S]*?^}/m)[0];
    const panel = { id: 'panel', instruction: question, selectedModel: 'fixture/selected', messages: [] };
    const noop = () => {}; let requests = 0;
    const controller = new AbortController();
    const sandbox = vm.createContext({ console, Boolean, String, Set, AbortController, activeAgentRequest: false, panel,
      findAnalysisPanel: () => panel, agentWorkApi: { beginTurn: () => ({ requestedModel: panel.selectedModel, permission: 'workspace_write' }), finishTurn: () => { panel.taskStatus = 'completed'; } },
      makeId: () => 'demand-turn', getAgentModelOptions: () => [], setAgentBusy: noop, getSelectedPaperIds: () => [], getProjectContext: () => '',
      projectContextService: f.service, workspaceManager: f.workspace, selectedWorkspacePaths: new Set(), workspaceTree: await f.workspace.scanDirectoryTree(), workspaceAbortController: new AbortController(),
      activeLiteratureOperations: 0, retrievalProfile: 'medium', currentLanguage: 'zh', USE_BACKEND: true, authToken: 'fixture',
      knowledgeService: null, literatureModule: f.literature, agentWorkArea: { getStreamHost: () => null }, analysisPanelStack: { querySelectorAll: () => [] },
      normalizeSemanticTelemetry: noop, normalizeRetrievalMetadata: noop, applyLiteratureScan: noop, applyPreparedContextToDocuments: noop, applyRequestCatalog: noop,
      renderWorkspaceExplorer: noop, renderAllDocumentLists: noop, saveAnalysisPanels: noop, renderAnalysisPanels: noop, renderBackendStatus: noop,
      sideChatProgressText: noop, t: value => value, buildAgentMessages: text => [{ role: 'user', content: text }], normalizeAgentResponse: () => ({}), currentRecommendation: null,
      sourceCitationApi: { bindToWorkspace: () => [] }, getSideChatCitationContext: noop,
      sendWorkbenchRequest: async request => { requests++; noPreparation(f); assert.equal(request.originalRequest, question); assert.equal(request.model, panel.selectedModel); assert.equal(request.localWorkspaceContext.agentLoop.version, 1); return { reply: 'Done' }; },
      window: { biodesignDesktop: { execution: { runWorkflow: noop } }, BioDesignFrontend: { beginTurn: () => ({ signal: controller.signal, event: event => f.progress.push(event), finish: noop }) } },
    });
    if (cancel) {
      const scan = f.workspace.scanDirectoryTree.bind(f.workspace);
      f.workspace.scanDirectoryTree = async () => { const tree = await scan(); controller.abort(); return tree; };
    }
    vm.runInContext(run, sandbox); await sandbox.runAgentInstruction(panel.id);
    assert.equal(requests, cancel ? 0 : 1); noPreparation(f);
    await new Promise(resolve => setImmediate(resolve)); noPreparation(f);
    if (!cancel) {
      assert.equal(f.service.agentTurns.get('demand-turn').options.surface, 'agent_command');
      const preparationEvents = f.progress.filter(event => event.stage.startsWith('preflight-'));
      assert.equal(preparationEvents.length, 2);
      assert(preparationEvents.every(event => event.surface === 'agent_command'));
    }
    assert.equal(f.system.registry.get(f.ids[3]).paperCardStatus, 'absent');
  });
}

test('a selected passage tool parses only its requested missing text and does not create a card or index', async () => {
  const f = await demandFixture();
  await f.service.buildContext({ ...f.options, question: 'Analyze paper 3' }); noPreparation(f);
  const result = await f.service.executeAgentTool({ id: 'passage', name: 'retrieve_project_evidence', args: { paper_ids: [f.ids[3]], query: 'Measured activity' } }, { turnId: f.options.turnId });
  assert.equal(result.result.ok, true, JSON.stringify(result)); assert.match(result.result.files[0].content, /28 U\/mL/);
  assert.equal(f.calls.parses, 1); assert.equal(f.calls.cards, 0); assert.equal(f.calls.indexing, 0);
  assert(f.events.every(event => event.startsWith(f.ids[3] + ':')));
  assert.equal(f.service.agentTurns.get(f.options.turnId).options.callContext.model, 'fixture/selected');
});

test('metadata reconciliation invalidates stale evidence without parsing, hashing or regenerating it', async () => {
  const f = await demandFixture(); const source = f.system.registry.get(f.ids[0]);
  await f.workspace.writeJson('.biodesign/workflows/corpus-index.json', { latestWorkflowId: 'old', recentWorkflowIds: ['old'] });
  await f.workspace.writeJson('.biodesign/workflows/old.json', { workflowId: 'old', status: 'completed', snapshot: [{ sourceId: source.sourceId }], maps: {}, coverage: {}, question: 'review' });
  f.workspace.set(source.path, 'Changed PDF contents', Date.now() - 1000);
  f.workspace.files.delete(f.system.registry.get(f.ids[1]).path);
  const context = await f.service.buildContext({ ...f.options, question: 'hello' }); noPreparation(f);
  assert.equal(source.hashStatus, 'dirty');
  assert.equal(f.system.preparation.capabilitySatisfied(source, 'paper_card'), false);
  assert(!context.sourceMap.paperSources.some(p => p.sourceId === f.ids[1]));
  assert.equal(context.preflightTelemetry.syncAgentSpawned, false);
  assert.equal((await f.workspace.readJson('.biodesign/workflows/old.json')).status, 'stale');
  const result = await f.service.executeAgentTool({ id: 'unrelated', name: 'retrieve_project_evidence', args: { paper_ids: [f.ids[3]], query: 'activity' } }, { turnId: f.options.turnId });
  assert.equal(result.result.ok, true, JSON.stringify(result));
  assert.equal(f.calls.cards, 0); assert.equal(f.calls.parses, 1);
  assert.equal(source.hashStatus, 'dirty', 'An unrelated dirty source is left unprepared');
});

test('explicit empty scope remains closed and turn cancellation prevents later tool preparation', async () => {
  const f = await demandFixture(); const controller = new AbortController();
  const context = await f.service.buildContext({ ...f.options, question: 'hello', forceHardSelection: true, selectedPaths: [], signal: controller.signal });
  assert.deepEqual(context.sourceMap.paperSources, []);
  const denied = await f.service.executeAgentTool({ id: 'denied', name: 'retrieve_project_evidence', args: { query: 'activity' } }, { turnId: f.options.turnId });
  assert.equal(denied.result.error, 'SOURCE_SCOPE_UNRESOLVED'); noPreparation(f);
  controller.abort();
  await assert.rejects(f.service.executeAgentTool({ id: 'cancelled', name: 'retrieve_project_evidence', args: { paper_ids: [f.ids[3]], query: 'activity' } }, { turnId: f.options.turnId }), { code: 'OPERATION_ABORTED' }); noPreparation(f);
});

test('cancelling after the metadata scan prevents subsequent reconciliation and model preparation', async () => {
  const f = await demandFixture(); const controller = new AbortController();
  const scan = f.workspace.scanDirectoryTree.bind(f.workspace);
  f.workspace.scanDirectoryTree = async () => { const tree = await scan(); controller.abort(); return tree; };
  await assert.rejects(f.service.buildContext({ ...f.options, question: 'hello', signal: controller.signal }), { code: 'OPERATION_ABORTED' }); noPreparation(f);
});

test('cancellation during parsing prevents a subsequent paper-card model call', async () => {
  const f = await demandFixture(); const controller = new AbortController();
  const parse = f.system.preparation.parsePaper;
  f.system.preparation.parsePaper = async input => { const value = await parse(input); controller.abort(); return value; };
  await assert.rejects(f.system.preparation.ensureSourceReady([f.ids[3]], 'paper_card', { surface: 'agent_command', signal: controller.signal }), { code: 'OPERATION_ABORTED' });
  assert.equal(f.calls.parses, 1); assert.equal(f.calls.cards, 0); assert.equal(f.calls.indexing, 0);
});


test('cold source handles survive signed continuation; changed metadata still fails closed', async () => {
  const backend = require('../index.js'), agent = require('../side-chat-agent.js'), continuation = require('../agent-continuation.js');
  const transcript = require('../../shared/conversation-transcript.js');
  const f = await demandFixture();
  const context = await f.service.buildContext({ ...f.options, question: 'Read paper 3' });
  let itemId;
  const run = (resume, name) => agent.runSideChatAgent({ surface: 'side_chat',
    workspaceContext: { localWorkspaceContext: backend._test.sanitizeLocalWorkspaceContext(context, 'Read paper 3') },
    originalRequest: 'Read paper 3', conversationMessages: [{ role: 'user', content: 'Read paper 3' }],
    conversationTranscript: transcript.normalize(), turnId: f.options.turnId, model: 'fixture/selected',
    systemPrompt: 'Read the requested paper.', supportsTools: true, projectToolsEnabled: true, resume,
    requestTurn: async request => {
      if (!itemId) {
        const catalog = request.messages.find(m => /Workspace catalog of sources/.test(m.content)).content;
        itemId = catalog.split('\n').find(line => /item_id=/.test(line) && /paper-3.pdf/.test(line)).match(/item_id=([^ ]+)/)[1];
      }
      return { ok: true, message: { tool_calls: [{ id: name, type: 'function', function: { name: 'read_paper_evidence', arguments: JSON.stringify({ item_id: itemId }) } }] } };
    }, parseFinalAnswer: reply => ({ reply }) });
  const first = await run(null, 'cold'); noPreparation(f);
  assert.equal(first.data.desktopToolCalls.length, 1);
  const result = await f.service.executeAgentTool(first.data.desktopToolCalls[0], { turnId: f.options.turnId });
  assert.equal(result.result.ok, true, JSON.stringify(result));
  const signed = continuation.seal(first.continuationState, { project: 'fixture' }, 'fixture-secret');
  const resumed = continuation.withResults(continuation.open(signed, { project: 'fixture' }, 'fixture-secret'), [result]);
  const second = await run(resumed, 'cold-again');
  assert.equal(second.data.desktopToolCalls.length, 1, 'A metadata-bound handle remains valid after on-demand hashing');
  f.workspace.set(f.system.registry.get(f.ids[3]).path, 'Changed after signing', Date.now() - 1000);
  const rejected = await f.service.executeAgentTool(second.data.desktopToolCalls[0], { turnId: f.options.turnId });
  assert.equal(rejected.result.error, 'SOURCE_VERSION_CHANGED');
  assert.equal(f.calls.parses, 1); assert.equal(f.calls.cards, 0); assert.equal(f.calls.indexing, 0);
});

test('explicit maintenance distinguishes cache checks from generation and preserves Agent Work labels', async () => {
  const f = await demandFixture(), events = [];
  await f.pipeline.preflight({ surface: 'agent_command', turnId: 'explicit-maintenance', onProgress: event => events.push(event) });
  assert.equal(f.calls.cards, 1, 'Only the missing card is generated by explicitly requested maintenance');
  assert.equal(events.filter(event => event.stage === 'sync-paper-card-ready' && event.cached).length, 3);
  assert.equal(events.filter(event => event.stage === 'sync-paper-card-checking').length, 4);
  assert(!events.some(event => event.stage === 'sync-paper-cards'));
  const app = fs.readFileSync(require.resolve('../../docs/app.js'), 'utf8');
  const label = app.match(/^function sideChatProgressText\([\s\S]*?^}/m)[0];
  const sandbox = vm.createContext({ currentLanguage: 'en' }); vm.runInContext(label, sandbox);
  assert.equal(sandbox.sideChatProgressText({ stage: 'sync-paper-card-checking' }), 'Checking Paper Card cache');
  assert.equal(sandbox.sideChatProgressText({ stage: 'sync-paper-card-ready', cached: true }), 'Using cached Paper Card');
});


test('a PDF already dirty at request time can be prepared on demand without regenerating its card', async () => {
  const f = await demandFixture(), source = f.system.registry.get(f.ids[0]);
  f.workspace.set(source.path, 'New measured activity is 99 U/mL.', Date.now() - 1000);
  await f.service.buildContext({ ...f.options, question: 'Read the new activity' }); noPreparation(f);
  const result = await f.service.executeAgentTool({ id: 'dirty-read', name: 'read_paper_evidence', args: { paper_id: source.sourceId } }, { turnId: f.options.turnId });
  assert.equal(result.result.ok, true, JSON.stringify(result));
  assert.match(result.result.content, /99 U\/mL/);
  assert.equal(f.calls.parses, 1); assert.equal(f.calls.cards, 0); assert.equal(f.calls.indexing, 0);
});

test('cancellation while reading PDF bytes prevents parsing and all model calls', async () => {
  const f = await demandFixture(), controller = new AbortController();
  const file = f.workspace.files.get(f.system.registry.get(f.ids[3]).path);
  const read = file.arrayBuffer.bind(file);
  file.arrayBuffer = async () => { const bytes = await read(); controller.abort(); return bytes; };
  await assert.rejects(f.system.preparation.ensureSourceReady([f.ids[3]], 'paper_card', { surface: 'agent_command', signal: controller.signal }), { code: 'OPERATION_ABORTED' });
  assert.equal(f.calls.parses, 0); assert.equal(f.calls.cards, 0); assert.equal(f.calls.indexing, 0);
});
