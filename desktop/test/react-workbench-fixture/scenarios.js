window.passed = []; window.failed = [];
const check = (condition, label) => { if (!condition) throw new Error(label); passed.push(label); };
const tick = () => new Promise(resolve => setTimeout(resolve, 70));
const waitFor = async (condition, label) => { for (let i = 0; i < 150; i++) { if (condition()) return; await tick(); } throw new Error(`Timed out: ${label}`); };
const adapter = window.BioDesignFrontend;
const snapshot = () => adapter.getSnapshot();
const requests = [], prepared = [];
window.copiedChats = [];
// Reproduce the production browser permission denial. Copy must use native IPC.
Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async () => { throw new DOMException('Write permission denied.', 'NotAllowedError'); } } });
let gates = {}, delayedPreparation = null, delayedHttp = null, nextFailure = false, responseText = '', nextSideTools = false, imageRequests = [];
let nextLoginStatus = 0;
// When set, Agent Work turns checkpoint a transcript turn with a command and its result, as the loop does.
let agentCheckpoints = false;
// When set, the next turn of that mode answers with this reply and its citations.
let nextCitationReply = null;
const checkpointFor = request => ({ turnId: request.callContext.turnId, model: 'fixture', workspaceId: request.localWorkspaceContext?.project?.workspaceId || '', status: 'completed',
  startedAt: new Date().toISOString(), sequence: 1, bindings: [], messages: [{ role: 'user', content: request.originalRequest },
    { role: 'assistant', content: null, tool_calls: [{ id: `run-${request.callContext.turnId}`, type: 'function', function: { name: 'exec_command', arguments: '{"cmd":"python3 summarise.py"}' } }] },
    { role: 'tool', tool_call_id: `run-${request.callContext.turnId}`, name: 'exec_command', content: `{"output":"${request.originalRequest} -> run A 4.2 g/L; run B 5.1 g/L"}` },
    { role: 'assistant', content: 'Summarised the runs.' }] });
const nativeFetch = window.fetch.bind(window);
window.fetch = async (url, options = {}) => {
  if (String(url).startsWith('file:')) return nativeFetch(url, options);
  const route = new URL(url).pathname;
  if (route === '/api/login' && nextLoginStatus) { const status = nextLoginStatus; nextLoginStatus = 0; return new Response('Internal Server Error', { status }); }
  if (route === '/api/login' || route === '/api/me') return new Response(JSON.stringify({ token: 'fixture-session', user: { account: 'researcher' } }), { headers: { 'content-type': 'application/json' } });
  if (route === '/api/chat/understand-images') {
    const body = JSON.parse(options.body); imageRequests.push(body);
    check(options.headers.Authorization === 'Bearer fixture-session', 'image understanding retains authenticated FC identity');
    return new Response(JSON.stringify({ understanding: { text: 'The chart reports measured activity.', model: 'fixture-image-model' }, imageCount: body.images.length }), { headers: { 'content-type': 'application/json' } });
  }
  throw new Error(`Unexpected fixture route ${route}`);
};
// Agent turns reach the desktop agent loop through docs/local-agent-transport.js.
// The fixture answers turns at that boundary so streaming, host-tool
// boundaries, failures and cancellation are deterministic; the loop itself
// has dedicated suites.
function fixtureResult(body) {
  const download = body.mode === 'agent_instruction' && /download/i.test(body.originalRequest);
  let result;
  // Plan mode: the agent answers with a proposed plan.
  if (nextCitationReply?.mode === body.mode && !body.resumed) { const { reply, citations } = nextCitationReply; nextCitationReply = null; return { reply, citations }; }
  if (body.desktopTools?.collaborationMode === 'plan') return { reply: 'Grounded in the fermentation data.\n\n<proposed_plan>\n1. Compare titres at matched pH.\n2. Repeat the best condition in triplicate.\n</proposed_plan>' };
  if (nextSideTools && body.mode === 'side_chat') { nextSideTools = false; result = { desktopToolCalls: [{ id: 'side-download', name: 'download_sources', args: { sources: [{ url: 'https://papers.example.org/side-only.pdf' }] } }] }; }
  else if (download && !body.resumed) result = { desktopToolCalls: [{ id: 'download-1', name: 'download_sources', args: { sources: [{ url: 'https://papers.example.org/enzyme-paper.pdf' }] } }] };
  else if (download) {
    const files = body.desktopToolResults[0].results.filter(file => file.status === 'downloaded');
    check(files.length === 1 && files[0].path === 'literature/enzyme-paper.pdf', 'the resumed turn receives the actual validated saved-file result');
    result = { reply: `Saved ${files.length} PDF: literature/enzyme-paper.pdf. Not yet ingested or analyzed.`, taskOutcome: { status: 'completed', downloadSuccessCount: files.length } };
  } else result = { reply: responseText || (body.mode === 'side_chat' ? 'The selected evidence reports 25 U/mL at pH 7.\n\nThis is a measured result, not proof of an optimum.' : '### Evidence review\n\nCompare enzyme variants at matched conditions.\n\nRecommended next step: repeat the activity assay.'), ...(body.mode === 'agent_instruction' ? { project: { summary: 'Evidence supports a controlled comparison.', draftMemo: 'Repeat at matched pH.', safetyNotes: 'Scientist review required.' } } : {}) };
  return result;
}
window.BioDesignLocalAgentTransport = { startSession({ agent, token, body, signal }) {
  check(token === 'fixture-session', 'model request retains authenticated identity');
  check(typeof agent?.start === 'function', 'agent turns use the desktop agent loop API');
  let boundary = false;
  const exchange = (request, onEvent) => new Promise((resolve, reject) => {
    requests.push(request);
    const stop = () => reject(Object.assign(new Error('The request was cancelled.'), { code: 'OPERATION_ABORTED' }));
    if (signal?.aborted) return stop();
    signal?.addEventListener('abort', stop, { once: true });
    const settle = result => { boundary = Boolean(result.desktopToolCalls); resolve(result); };
    if (delayedHttp) {
      const pending = delayedHttp; delayedHttp = null;
      pending.then(value => value?.status === 401 ? reject(Object.assign(new Error('Sign in again.'), { code: 'AUTH_REQUIRED', status: 401 })) : settle(fixtureResult(request)));
      return;
    }
    if (nextFailure) { nextFailure = false; return reject(Object.assign(new Error('The agent turn failed.'), { code: 'AGENT_TURN_FAILED' })); }
    const result = fixtureResult(request);
    (async () => {
      await onEvent({ type: 'status', stage: request.mode === 'side_chat' ? 'side-fixture-retrieval' : 'agent-fixture-analysis' });
      await onEvent({ type: 'delta', text: request.mode === 'side_chat' ? 'Selected evidence is streaming…' : 'Agent analysis is streaming…' });
      if (agentCheckpoints && request.mode === 'agent_instruction') await onEvent({ type: 'transcript', conversationTurn: checkpointFor(request) });
      const finish = () => settle(result);
      if (gates[request.mode]) gates[request.mode].push(finish); else setTimeout(finish, 90);
    })().catch(reject);
  });
  return {
    first: onEvent => exchange(body, onEvent),
    next: (reply, onEvent) => { boundary = false; return exchange({ ...body, desktopToolResults: reply.desktopToolResults, resumed: true }, onEvent); },
    atBoundary: () => boundary,
    close: async () => {},
  };
} };
// Keep the existing orchestration. Preparation is deterministic here; its real
// retrieval/corpus behavior has dedicated suites.
ProjectContextService.prototype.buildContext = async function (options) {
  prepared.push(options);
  if (delayedPreparation) { const gate = delayedPreparation; delayedPreparation = null; await gate; }
  options.onProgress?.({ stage: `${options.surface}-preparing`, message: `Preparing ${options.surface} evidence` });
  // As the real service does: the turn runs on the agent loop, with its scope
  // registered against the open project object.
  const project = this.workspace.workspace;
  const context = { project: { workspaceId: project?.workspaceId }, agentLoop: { version: 1 },
    files: options.selectedPaths.map(relativePath => ({ relativePath, analysisStatus: 'processed', content: 'Measured activity: 25 U/mL at pH 7.' })),
    literature: { relevantPaperIds: [], coverage: { papersDiscovered: 0, papersSearchable: 0 } }, experiments: {},
    ...(options.surface === 'agent_command' && /download/i.test(options.question) ? { semantic: { ir: { operations: ['search', 'store'] } } } : {}) };
  (this.agentTurns ||= new Map()).set(options.turnId, { options, context, project, hardSelection: false, selected: [], paths: [], sourceStats: {}, sourceVersions: {}, calls: 0, receipts: new Map() });
  return context;
};

async function selectProject(initialize = true) {
  const previousId = snapshot().project?.id;
  document.querySelector('[aria-label="Add project"]').click();
  if (initialize) {
    await waitFor(() => snapshot().pendingProject && !snapshot().projectBusy, 'optional initialization confirmation');
    check(snapshot().project?.id === previousId, 'choosing an uninitialized project preserves the active chat until confirmation');
    document.querySelector('[aria-label="Initialize project"] .primary-button').click();
  }
  await waitFor(() => snapshot().project && snapshot().project.id !== previousId && !snapshot().projectBusy, 'project open');
  await tick();
}
async function openGoalMenu(name) {
  const heading = [...document.querySelectorAll('.project-group-heading')].find(node => node.textContent.includes(name));
  heading.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 100, clientY: 200 }));
  await tick();
}
async function saveGoal(text) {
  const input = document.querySelector('[aria-label="Project goal text"]');
  Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(input, text);
  input.dispatchEvent(new Event('input', { bubbles: true })); await tick();
  input.closest('form').requestSubmit();
  await waitFor(() => !snapshot().goalEditor && !snapshot().projectBusy, 'goal saved'); await tick();
}
async function selectSideHistory(id) {
  const picker = document.querySelector('[aria-label="Side Chat history"]');
  if (picker.getAttribute('aria-expanded') !== 'true') { picker.click(); await tick(); }
  document.querySelector(`[role="option"][data-conversation-id="${id}"]`).click();
  await waitFor(() => snapshot().activeConversationId === id && !snapshot().projectBusy, 'select history'); await tick();
}
async function requestChatDeletion(node) {
  node.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 180, clientY: 230 })); await tick();
  [...document.querySelectorAll('[role="menuitem"]')].find(item => item.textContent === 'Delete chat').click(); await tick();
  check(Boolean(document.querySelector('[aria-label="Delete chat"]')), 'right-click deletion opens confirmation');
}
async function requestChatRename(node) {
  node.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 180, clientY: 230 })); await tick();
  [...document.querySelectorAll('[role="menuitem"]')].find(item => item.textContent === 'Rename').click(); await tick();
  check(Boolean(document.querySelector('[aria-label="Rename chat"]')), 'right-click rename opens a name editor');
}
async function sendSide(text) {
  document.getElementById('sideChatInput').value = text;
  document.getElementById('sideChatForm').requestSubmit();
  await waitFor(() => snapshot().sideBusy, 'side turn starts');
}
async function sendAgent(text) {
  const requestCount = requests.length;
  const input = document.querySelector(`[data-analysis-instruction][data-panel-id="${snapshot().activeAgentId}"]`);
  input.value = text; input.dispatchEvent(new Event('input', { bubbles: true }));
  input.closest('form').requestSubmit();
  await waitFor(() => snapshot().agentBusy || requests.length > requestCount, 'agent turn starts');
  await tick();
}
async function runWorkbenchHome() {
  await waitFor(() => document.querySelector('.copilot-panes'), 'React mount');
  check(document.documentElement.dataset.renderer === 'biodesign-react', 'production React renderer loads from file URL');
  check(typeof window.require === 'undefined' && typeof window.process === 'undefined', 'renderer stays sandboxed with no Node globals');
  check(document.querySelectorAll('#sideChatForm').length === 1, 'React mounts one composer without cloning event listeners');
  check(![...document.querySelectorAll('body > button')].some(node => node.textContent.includes('Library jobs')), 'signed-out page has no floating library controls');
  for (const status of [502, 401]) {
    nextLoginStatus = status;
    document.getElementById('loginAccount').value = 'researcher'; document.getElementById('loginPassword').value = 'fixture';
    document.getElementById('loginForm').requestSubmit();
    await waitFor(() => document.getElementById('loginError').textContent, 'login error response');
    const message = document.getElementById('loginError').textContent;
    check(status === 502 ? message.includes('HTTP 502') && message.includes('service') : message.includes('Incorrect account'), 'login distinguishes service outage from invalid credentials: ' + status);
    check(!document.getElementById('loginPanel').hidden && !document.getElementById('loginPassword').value, 'failed login preserves signed-out state and clears the password: ' + status);
  }
  document.getElementById('loginAccount').value = 'researcher'; document.getElementById('loginPassword').value = 'fixture';
  document.getElementById('loginForm').requestSubmit();
  await waitFor(() => snapshot().project && !snapshot().projectBusy, 'default workspace bootstrap after login');
  check(window.BioDesignAgentWork.createTurnClock().element.querySelector('time').textContent === '00:00:00', 'missing task timing displays zero');
  check(snapshot().catalogId === 'default' && !document.getElementById('appShell').hidden, 'login opens a chat with an automatic default workspace');
  check(document.getElementById('workspaceSelectionPanel').hidden, 'startup has no folder selection gate');
  check(!document.querySelector('.project-context-panel') && !document.querySelector('.workspace-explorer-panel'), 'project goal and workspace panels are removed from the renderer');
  check(document.querySelector('.is-single .agent-pane.is-empty .hero-heading'), 'initial view is the nanobot-style single new-chat composer');
  check(getComputedStyle(document.body).getPropertyValue('--accent').trim() === '#126b5f', 'original BioDesign teal palette is retained');
  await tick();
}
async function runWorkbenchScenarios() {
  document.querySelector('.account-menu summary').click();
  [...document.querySelectorAll('.account-options button')].find(button => button.textContent === 'Library jobs').click();
  await waitFor(() => [...document.querySelectorAll('dialog')].some(node => node.textContent.includes('No unfinished library jobs.')), 'account library jobs dialog');
  const jobsDialog = [...document.querySelectorAll('dialog[open]')].find(node => node.textContent.includes('No unfinished library jobs.'));
  [...jobsDialog.querySelectorAll('button')].find(button => button.textContent === 'Close').click();
  await waitFor(() => !jobsDialog.isConnected || !jobsDialog.open, 'library jobs dialog closes before continuing');
  check(![...document.querySelectorAll('body > button')].some(node => node.textContent.includes('Library jobs')), 'library jobs remains inside the signed-in account menu');
  const account = document.querySelector('.account-menu summary');
  check(account.getBoundingClientRect().bottom > innerHeight - 90, 'account control is anchored at the lower left');
  account.click(); document.querySelector('.account-options button').click();
  await waitFor(() => document.querySelector('.library-url-dialog'), 'Library URL dialog');
  const dialog = () => document.querySelector('.library-url-dialog');
  const press = label => [...dialog().querySelectorAll('button')].find(button => button.textContent === label).click();
  check(dialog().textContent.includes('only open-access papers'), 'library dialog explains the no-URL limitation');
  document.querySelector('#library-url-input').value = 'javascript:alert(1)'; press('Save');
  check(Boolean(dialog()) && dialog().querySelector('[role=alert]').textContent, 'invalid library URL cannot be saved');
  document.querySelector('#library-url-input').value = 'https://library.example.edu'; press('Save'); await tick();
  account.click(); document.querySelector('.account-options button').click();
  await waitFor(() => dialog(), 'saved Library URL dialog');
  check(document.querySelector('#library-url-input').value === 'https://library.example.edu/', 'account setting restores the saved library URL');
  press('Cancel'); await tick();
  let choice = null;
  const pending = window.BioDesignLibrarySettings.edit({ account: snapshot().account, requiredChoice: true }).then(value => { choice = value; });
  await tick(); check(choice === null && dialog().open, 'literature setup waits for an explicit user choice');
  press('Continue without library'); await pending;
  check(choice.url === '' && window.BioDesignLibrarySettings.get(snapshot().account) === 'https://library.example.edu/', 'skipping library applies to this request without erasing the saved URL');
  const controller = new AbortController();
  const cancelled = window.BioDesignLibrarySettings.edit({ account: snapshot().account, requiredChoice: true, signal: controller.signal }).catch(error => error.code);
  controller.abort(); check(await cancelled === 'OPERATION_ABORTED' && !dialog(), 'cancelling the request dismisses library setup');
  await sendAgent('Explore directions for a literature review.'); await waitFor(() => !snapshot().agentBusy, 'default workspace response');
  const defaultChatId = snapshot().activeAgentId;
  check(document.querySelector('nav[aria-label="Chats"]').textContent.includes('Explore directions'), 'a chat without a chosen folder appears under Chats');
  document.querySelector('.new-conversation').click(); await waitFor(() => !snapshot().projectBusy && snapshot().activeAgentId !== defaultChatId, 'new default chat');
  check(!snapshot().agents.find(chat => chat.id === snapshot().activeAgentId).messageCount, 'New chat resets to an empty composer and preserves the previous chat');
  requests.length = 0; prepared.length = 0;
  const draftInput = document.querySelector(`[data-analysis-instruction][data-panel-id="${snapshot().activeAgentId}"]`);
  draftInput.value = 'Draft an enzyme literature review'; draftInput.dispatchEvent(new Event('input', { bubbles: true }));
  const draftModel = document.querySelector('.analysis-panel:not([hidden]) [data-agent-setting="selectedModel"]');
  draftModel.value = 'nvidia/nemotron-3-nano-omni-30b-a3b-reasoning'; draftModel.dispatchEvent(new Event('change', { bubbles: true }));
  const draftPermission = document.querySelector('.analysis-panel:not([hidden]) [data-agent-setting="selectedPermission"]');
  draftPermission.value = 'workspace_write'; draftPermission.dispatchEvent(new Event('change', { bubbles: true }));
  const defaultProjectId = snapshot().project.id;
  document.querySelector('.agent-pane .project-scope-control').click(); await tick();
  document.querySelector('.shell-modal .secondary-button').click();
  await waitFor(() => snapshot().pendingProject && !snapshot().projectBusy, 'draft project initialization confirmation');
  check(snapshot().project.id === defaultProjectId, 'choosing an uninitialized draft project leaves the active project intact until confirmation');
  document.querySelector('[aria-label="Initialize project"] .primary-button').click();
  await waitFor(() => snapshot().project && snapshot().project.id !== defaultProjectId && !snapshot().projectBusy, 'draft project open'); await tick();
  let firstProjectId = snapshot().project.id;
  const firstCatalogId = snapshot().catalogId;
  check(snapshot().project.name === 'Enzyme Engineering', 'native folder picker opens the selected project');
  check(snapshot().goalEditor?.optional && snapshot().goalEditor.goal === '', 'new external folder without a goal offers an optional goal prompt');
  document.querySelector('[aria-label="Project goal"] .secondary-button').click(); await tick();
  check(!snapshot().goalEditor && !workspaceManager.state.project.goal, 'skipping the prompt preserves the empty project goal');
  await openGoalMenu('Enzyme Engineering');
  check(document.querySelector('[role="menuitem"]').textContent === 'Add project goal', 'right-click offers Add project goal');
  document.querySelector('[role="menuitem"]').click(); await waitFor(() => snapshot().goalEditor && !snapshot().projectBusy, 'add goal editor'); await tick();
  await saveGoal('Compare enzyme variants.');
  await openGoalMenu('Enzyme Engineering');
  check(document.querySelector('[role="menuitem"]').textContent === 'Edit project goal', 'saved goal changes the context menu to Edit');
  document.querySelector('[role="menuitem"]').click(); await waitFor(() => snapshot().goalEditor && !snapshot().projectBusy, 'edit goal editor'); await tick();
  check(document.querySelector('[aria-label="Project goal text"]').value === 'Compare enzyme variants.', 'goal editor restores the saved goal');
  await saveGoal('Compare enzyme variants at matched pH.');
  const movedDraft = findAnalysisPanel(snapshot().activeAgentId);
  check(movedDraft.instruction === 'Draft an enzyme literature review' && movedDraft.selectedModel === draftModel.value, 'composer project selection preserves the Agent draft and model through initialization');
  check(movedDraft.selectedPermission === 'read_only', 'moving an Agent draft does not transfer write authorization to a different project');
  const newDraftModel = document.querySelector('.analysis-panel:not([hidden]) [data-agent-setting="selectedModel"]'); newDraftModel.value = 'default'; newDraftModel.dispatchEvent(new Event('change', { bubbles: true }));
  document.querySelector('[aria-label="Open literature"]').click(); await tick();
  const evidence = document.querySelector('.library-files input');
  check(Boolean(evidence), 'on-demand literature view lists actual project PDFs'); evidence.click(); await tick();
  document.querySelector('[aria-label="Close dialog"]').click();
  check(document.getElementById('sideChatContextChips').textContent.includes('evidence.pdf'), 'literature selection retains hard source chips');
  const sideChatToggle = document.querySelector('[aria-label="Toggle Side Chat"]');
  if (sideChatToggle.getAttribute('aria-pressed') === 'true') { sideChatToggle.click(); await tick(); }
  sideChatToggle.click(); await tick();
  const model = document.getElementById('sideChatModelSelect'); model.value = 'nvidia/nemotron-3-nano-omni-30b-a3b-reasoning'; model.dispatchEvent(new Event('change', { bubbles: true }));
  gates.side_chat = []; gates.agent_instruction = [];
  const originalRecommendation = JSON.stringify(currentRecommendation);
  await sendSide('What does the selected evidence report?');
  document.getElementById('sideChatForm').requestSubmit();
  await waitFor(() => gates.side_chat.length === 1, 'streaming Side Chat');
  const permission = document.querySelector('.analysis-panel:not([hidden]) [data-agent-setting="selectedPermission"]'); permission.value = 'workspace_write'; permission.dispatchEvent(new Event('change', { bubbles: true }));
  await sendAgent('Analyze and recommend the next experiment.');
  await waitFor(() => gates.agent_instruction.length === 1, 'streaming Agent Work');
  check(snapshot().sideBusy && snapshot().agentBusy, 'Side Chat and Agent Work can run concurrently');
  check(requests.filter(r => r.mode === 'side_chat').length === 1, 'duplicate form submissions do not duplicate sends');
  check(requests[0].model === 'nvidia/nemotron-3-nano-omni-30b-a3b-reasoning', 'Side Chat captures its selected model');
  check(requests[1].model === 'default' && requests[1].desktopTools.permission === 'workspace_write', 'Agent Work retains independent model and explicit permission');
  check(!requests[0].desktopTools, 'Side Chat never exposes desktop download capability');
  check(prepared[0].selectedPaths.length === 1 && prepared[0].selectedPaths[0] === 'literature/evidence.pdf', 'hard selected-source scope reaches existing preparation service');
  check(prepared[0].projectGoal === 'Compare enzyme variants at matched pH.', 'saved project goal reaches research preparation');
  document.querySelector('.agent-pane').dispatchEvent(new Event('pointerdown', { bubbles: true }));
  await tick();
  check(snapshot().activeConversationId === sideChatConversation.id, 'focusing Agent Work does not retarget Side Chat');
  check(document.querySelector('.side-pane .streaming-answer').textContent.includes('Selected evidence'), 'Side Chat deltas render in the Side Chat timeline');
  check(document.querySelector('.agent-pane .streaming-answer').textContent.includes('Agent analysis'), 'Agent Work deltas render in its own timeline');
  const sideRun = snapshot().runs[`side_chat:${snapshot().activeConversationId}`];
  check(!sideRun.steps.some(step => step.stage.includes('agent-fixture')), 'Agent activity does not leak into Side Chat');
  check(!document.querySelector('.turn-activity .turn-message-clock'), 'task clocks are in the response timeline, not the pane header');
  await waitFor(() => document.querySelector('.side-pane .turn-message-clock[data-working="true"] time').textContent !== '00:00:00', 'live task clock advances');
  await waitFor(() => document.querySelector('.agent-pane .turn-message-clock[data-working="true"] time').textContent !== '00:00:00', 'Agent Work live clock advances independently');
  check(document.querySelectorAll('.turn-message-clock[data-working="true"]').length === 2, 'concurrent responses each display their own live clock');
  const runningAgentId = snapshot().activeAgentId;
  const firstSideId = snapshot().activeConversationId;
  await adapter.command('agent.new', { projectId: firstProjectId, role: 'agent_command' }); await tick();
  check(snapshot().activeAgentId === runningAgentId && snapshot().sideChatAgentId === runningAgentId, 'an active Side Chat cannot be silently reassigned by Agent Work navigation');
  gates.side_chat.splice(0).forEach(finish => finish()); delete gates.side_chat;
  await waitFor(() => !snapshot().sideBusy, 'Side Chat completion');
  check(snapshot().runs[`side_chat:${snapshot().activeConversationId}`].elapsedMs >= 1000 && snapshot().runs[`side_chat:${snapshot().activeConversationId}`].finishedAt !== null, 'completed task timing freezes with a recorded total');
  const firstReplyClock = document.querySelector('#sideChatHistory .side-message.assistant > .turn-message-clock');
  const firstReplyDuration = firstReplyClock.querySelector('time').textContent;
  check(firstReplyDuration !== '00:00:00' && firstReplyClock.dataset.working === 'false', 'response keeps its completed turn duration');
  check(sideChatMessages.at(-1).elapsedMs >= 1000, 'completed duration is stored with the returned message');
  check(JSON.stringify(currentRecommendation) === originalRecommendation, 'completed Side Chat cannot commit the official recommendation');
  check(!document.querySelector('.sidebar-scroll').textContent.includes('What does the selected evidence'), 'Side Chat history never appears in the left sidebar');
  document.getElementById('sideChatInput').value = 'Draft for the first Agent Work panel';
  await adapter.command('agent.new', { projectId: firstProjectId, role: 'agent_command' }); await tick();
  const secondAgentId = snapshot().activeAgentId;
  check(secondAgentId !== runningAgentId && !document.querySelector('.agent-pane .analysis-panel:not([hidden]) .streaming-answer'), 'new Agent Work target does not inherit another conversation stream');
  check(snapshot().sideChatAgentId === secondAgentId && sideChatMessages.length === 0 && document.getElementById('sideChatInput').value === '', 'each Agent Work panel opens an independent Side Chat and composer');
  check(!snapshot().conversations.some(chat => chat.id === firstSideId), 'Side Chat dropdown contains only the current Agent Work history');
  await adapter.command('side.open', { projectId: firstProjectId, role: 'side_chat', agentPanelId: secondAgentId, conversationId: firstSideId }).then(() => { throw new Error('Cross-panel chat unexpectedly opened'); }, error => check(/another Agent Work/.test(error.message), 'foreign-panel Side Chat IDs are rejected'));
  await sendSide('Independent notes for the second Agent Work panel'); await waitFor(() => !snapshot().sideBusy, 'second panel discussion');
  const secondSideId = snapshot().activeConversationId;
  check(!document.querySelector('.sidebar-scroll').textContent.includes('Independent notes'), 'only the owning Agent Work row is listed for a Side Chat-only panel');
  await adapter.command('agent.open', { projectId: firstProjectId, role: 'agent_command', conversationId: runningAgentId }); await tick();
  check(!document.querySelector(`[data-panel-id="${runningAgentId}"].analysis-panel`).hidden && snapshot().runs[`agent_command:${runningAgentId}`].status === 'running', 'reopening active Agent Work restores its own turn and visible panel');
  check(snapshot().activeConversationId === firstSideId && document.getElementById('sideChatInput').value === 'Draft for the first Agent Work panel', 'returning to an Agent Work panel restores its selected Side Chat and draft');
  document.getElementById('sideChatInput').value = '';
  gates.agent_instruction.splice(0).forEach(finish => finish()); delete gates.agent_instruction;
  await waitFor(() => !snapshot().agentBusy, 'Agent completion');
  check(JSON.stringify(currentRecommendation) === originalRecommendation, 'Agent Work displays its answer without inventing a recommendation');
  check(analysisPanels.find(panel => panel.id === runningAgentId).messages.some(message => message.content.includes('### Evidence review')), 'plain Markdown Agent Work answer is preserved');
  const savedChatId = snapshot().activeConversationId;
  await adapter.command('side.new', { projectId: firstProjectId, role: 'side_chat' }); await tick();
  check(snapshot().activeConversationId !== savedChatId && sideChatMessages.length === 0, 'New Side Chat creates an independent persisted conversation');
  const historyPicker = document.querySelector('[aria-label="Side Chat history"]');
  const historyOrder = snapshot().conversations.map(chat => chat.id).join(',');
  const emptyChatId = snapshot().activeConversationId;
  await selectSideHistory(savedChatId);
  await waitFor(() => snapshot().activeConversationId === savedChatId && !snapshot().projectBusy, 'Side Chat dropdown history selection'); await tick();
  for (const id of [emptyChatId, savedChatId]) {
    await selectSideHistory(id);
    await waitFor(() => snapshot().activeConversationId === id && !snapshot().projectBusy, 'stable history navigation'); await tick();
    check(snapshot().conversations.map(chat => chat.id).join(',') === historyOrder, 'selecting Side Chat history leaves its newest-first order unchanged');
  }
  sideChatToggle.click(); await tick();
  check(historyPicker.getClientRects().length === 0, 'Side Chat history selector is unavailable when its pane is closed');
  sideChatToggle.click(); await tick();
  check(document.querySelector('#sideChatHistory .side-message.assistant > .turn-message-clock time').textContent === firstReplyDuration, 'reopening a history retains its original turn duration');
  check(sideChatMessages.length === 2 && document.getElementById('sideChatHistory').textContent.includes('25 U/mL'), 'saved chat selection restores its actual history');
  await sendAgent('Download one enzyme paper to the project.');
  await waitFor(() => !snapshot().agentBusy, 'download continuation');
  document.querySelector('[aria-label="Open literature"]').click(); await tick();
  check(document.querySelector('.library-files').textContent.includes('enzyme-paper.pdf'), 'actual saved PDF appears in Literature without an ingestion run');
  document.querySelector('[aria-label="Close dialog"]').click();
  check(document.querySelector('.agent-conversation').textContent.includes('Not yet ingested'), 'download result does not claim premature analysis');
  check(requests.at(-1).resumed === true && requests.at(-1).desktopToolResults?.length === 1, 'download resumes the same agent turn with the saved-file receipt');
  check(document.querySelectorAll('.analysis-panel:not([hidden]) .agent-message.assistant > .turn-message-clock').length === findAnalysisPanel(runningAgentId).messages.filter(message => message.role === 'assistant').length, 'each Agent reply has its own duration');
  const beforeError = JSON.stringify(currentRecommendation); nextFailure = true;
  await sendAgent('Analyze backend failure.'); await waitFor(() => !snapshot().agentBusy, 'agent turn error');
  check(JSON.stringify(currentRecommendation) === beforeError, 'agent turn errors do not commit a demo recommendation');
  check(snapshot().runs[`agent_command:${snapshot().activeAgentId}`].status === 'failed', 'actual backend failure renders a failed state');
  nextSideTools = true;
  const beforeDenied = requests.length;
  await sendSide('Discuss a paper.'); await waitFor(() => !snapshot().sideBusy, 'forbidden side tool');
  check(requests.length === beforeDenied + 1 && snapshot().runs[`side_chat:${snapshot().activeConversationId}`].status === 'failed', 'Side Chat rejects a returned desktop download call');
  check(JSON.stringify(currentRecommendation) === beforeError, 'forbidden Side Chat tool call does not change the recommendation');
  gates.side_chat = [];
  await sendSide('Cancel this discussion.'); await waitFor(() => gates.side_chat.length === 1, 'cancellable stream');
  document.querySelector('.stop-turn').click();
  await waitFor(() => !snapshot().sideBusy, 'cancelled Side Chat');
  check(snapshot().runs[`side_chat:${snapshot().activeConversationId}`].status === 'cancelled', 'Stop cancels the active Side Chat stream');
  gates.side_chat.splice(0).forEach(finish => finish()); delete gates.side_chat;
  check(!sideChatMessages.at(-1).content.includes('25 U/mL'), 'cancelled stream does not append a completed answer');
  const canvas = document.createElement('canvas'); canvas.width = 100; canvas.height = 100;
  const context = canvas.getContext('2d'); context.fillStyle = 'green'; context.fillRect(10, 10, 50, 50);
  const file = new File([await new Promise(resolve => canvas.toBlob(resolve, 'image/png'))], 'activity.png', { type: 'image/png' });
  const transfer = new DataTransfer(); transfer.items.add(file);
  document.getElementById('sideChatInput').dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: transfer }));
  await waitFor(() => !sideChatImageComposer.preparing && sideChatImageComposer.images.length === 1, 'image attachment');
  await sendSide('Explain the attached chart.'); await waitFor(() => !snapshot().sideBusy, 'image response');
  const attachmentId = sideChatMessages.at(-2).images[0].attachmentId;
  check(requests.at(-1).images?.length === 1 && Boolean(attachmentId), 'pasted image is persisted and sent to the selected main model');
  const historyLength = sideChatMessages.length;
  document.querySelector('[data-side-chat-action="edit"]').click();
  document.querySelector('[data-side-chat-edit-input]').value = 'Explain the chart uncertainty.';
  document.querySelector('[data-side-chat-action="save-edit"]').click();
  await waitFor(() => snapshot().sideBusy, 'image edit regeneration'); await waitFor(() => !snapshot().sideBusy, 'regeneration complete');
  check(sideChatMessages.length === historyLength && sideChatMessages.at(-2).content === 'Explain the chart uncertainty.', 'edit/regenerate replaces the latest turn without duplicate transcript entries');
  check(requests.at(-1).images?.length === 1 && sideChatMessages.at(-2).images[0].attachmentId === attachmentId, 'regeneration preserves the saved image attachment');
  const beforeForkRequests = requests.length, beforeForkRecommendation = JSON.stringify(currentRecommendation);
  document.querySelector('[aria-label="Copy Side Chat chat"]').click();
  await waitFor(() => copiedChats.length === 1, 'copy Side Chat');
  document.querySelector('[aria-label="Copy Agent Work chat"]').click();
  await waitFor(() => copiedChats.length === 2, 'copy Agent Work');
  check(copiedChats[0].includes('Explain the chart uncertainty.') && copiedChats[0].includes('activity.png') && copiedChats[1].includes('Not yet ingested'), 'Copy uses the correct pane transcript and attachment names');
  const originalSideMessages = JSON.stringify(sideChatMessages);
  document.querySelector('[aria-label="Fork Side Chat chat"]').click();
  await waitFor(() => snapshot().activeConversationId !== savedChatId && !snapshot().projectBusy, 'fork Side Chat'); await tick();
  const forkedSideId = snapshot().activeConversationId;
  check(JSON.stringify(sideChatMessages) === originalSideMessages && snapshot().sideChatAgentId === runningAgentId, 'Side Chat fork copies complete history under the same Agent panel');
  await sendSide('Continue only the fork.'); await waitFor(() => !snapshot().sideBusy, 'continue forked Side Chat');
  await adapter.command('side.open', { projectId: firstProjectId, role: 'side_chat', agentPanelId: runningAgentId, conversationId: savedChatId }); await tick();
  check(JSON.stringify(sideChatMessages) === originalSideMessages, 'continuing a Side Chat fork does not modify the original');
  const originalAgentMessages = JSON.stringify(findAnalysisPanel(runningAgentId).messages);
  document.querySelector('[aria-label="Fork Agent Work chat"]').click();
  await waitFor(() => snapshot().activeAgentId !== runningAgentId && !snapshot().projectBusy, 'fork Agent Work'); await tick();
  const forkedAgentId = snapshot().activeAgentId, forkedAgent = findAnalysisPanel(forkedAgentId);
  check(JSON.stringify(forkedAgent.messages) === originalAgentMessages && forkedAgent.selectedPermission === 'read_only' && forkedAgent.selectedModel === findAnalysisPanel(runningAgentId).selectedModel, 'Agent fork copies history and model without transferring write permission');
  check(!sideChatMessages.length && snapshot().sideChatAgentId === forkedAgentId, 'Agent fork owns a fresh independent Side Chat store');
  const originalTitle = findAnalysisPanel(runningAgentId).title, originalRecency = findAnalysisPanel(runningAgentId).updatedAt;
  const originalRow = () => [...document.querySelectorAll('.chat-row')].find(node => node.title.split('\n')[0] === originalTitle);
  await requestChatRename(originalRow());
  check(document.querySelector('[aria-label="Chat name"]').value === originalTitle, 'rename editor starts with the existing name');
  document.querySelector('[aria-label="Rename chat"] .secondary-button').click(); await tick();
  check(findAnalysisPanel(runningAgentId).title === originalTitle, 'cancelling rename preserves the name');
  await requestChatRename(originalRow());
  const nameInput = document.querySelector('[aria-label="Chat name"]');
  const enterName = async value => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(nameInput, value); nameInput.dispatchEvent(new Event('input', { bubbles: true })); await tick(); };
  await enterName('   ');
  check(document.querySelector('[aria-label="Rename chat"] .primary-button').disabled, 'empty chat names cannot be saved');
  await enterName('  Enzyme evidence review  '); nameInput.closest('form').requestSubmit();
  await waitFor(() => !document.querySelector('[aria-label="Rename chat"]') && !snapshot().projectBusy, 'renamed chat saved'); await tick();
  check(findAnalysisPanel(runningAgentId).title === 'Enzyme evidence review' && [...document.querySelectorAll('.chat-row')].some(node => node.title.split('\n')[0] === 'Enzyme evidence review'), 'saved name updates the sidebar while preserving its searchable preview');
  check(snapshot().activeAgentId === forkedAgentId && findAnalysisPanel(runningAgentId).updatedAt === originalRecency && JSON.stringify(findAnalysisPanel(runningAgentId).messages) === originalAgentMessages, 'renaming an inactive chat preserves selection, recency and messages');
  const revised = structuredClone(findAnalysisPanel(runningAgentId));
  window.BioDesignAgentWork.beginTurn(revised, { id: 'rename-revision-test', revision: { message: revised.messages[0], content: 'Revised first instruction' } });
  check(revised.title === 'Enzyme evidence review', 'editing the first turn preserves a custom chat name');
  check(requests.length === beforeForkRequests + 1 && JSON.stringify(currentRecommendation) === beforeForkRecommendation, 'copy and fork trigger no model request or recommendation commit');
  await sendAgent('Continue only the forked analysis.'); await waitFor(() => !snapshot().agentBusy, 'continue forked Agent Work');
  check(JSON.stringify(findAnalysisPanel(runningAgentId).messages) === originalAgentMessages, 'continuing an Agent fork does not modify the original');
  await adapter.command('agent.open', { projectId: firstProjectId, role: 'agent_command', conversationId: runningAgentId }); await tick();
  // A deliberately late preparation callback ignores abort: renderer still must isolate it.
  let release; delayedPreparation = new Promise(resolve => { release = resolve; });
  await sendSide('Late response from the old project');
  let releaseHttp; delayedHttp = new Promise(resolve => { releaseHttp = resolve; });
  await sendAgent('Analyze a response that will arrive after switching projects.');
  await waitFor(() => delayedHttp === null, 'old project agent turn');
  await selectProject(false);
  const secondProjectId = snapshot().project.id;
  check(snapshot().goalEditor?.optional, 'existing folder with no saved goal also offers the prompt');
  document.querySelector('[aria-label="Project goal"] .secondary-button').click(); await tick();
  release(); await tick(); await tick();
  releaseHttp(new Response('{}', { status: 401 })); await tick(); await tick();
  check(secondProjectId !== firstProjectId && sideChatMessages.length === 0, 'late prior-project activity cannot enter the new conversation');
  check(!snapshot().sideBusy && !snapshot().agentBusy, 'old turn cleanup cannot change a new project active state');
  check(authToken === 'fixture-session' && !document.getElementById('appShell').hidden, 'late unauthorized response from the old project cannot log out the new project');
  check(!analysisPanels.some(panel => panel.title.includes('Analyze')), 'Agent Work histories are scoped to their project');
  const newProjectAgentId = snapshot().activeAgentId;
  const legacyOwner = analysisPanels.find(panel => panel.sideChatScope === 'legacy');
  check(Boolean(legacyOwner), 'legacy project history is associated with a single saved Agent Work panel');
  await adapter.command('agent.open', { projectId: secondProjectId, role: 'agent_command', conversationId: legacyOwner.id }); await tick();
  check(snapshot().activeConversationId === 'legacy-side' && sideChatMessages[0].content === 'Existing legacy evidence discussion', 'legacy project history remains readable through its owning panel dropdown');
  await adapter.command('agent.open', { projectId: secondProjectId, role: 'agent_command', conversationId: newProjectAgentId }); await tick();
  check(!snapshot().conversations.some(chat => chat.id === 'legacy-side'), 'new Agent Work panels cannot inherit the legacy owner history');
  check(snapshot().projects.find(project => project.id === firstCatalogId).conversations.some(chat => chat.id === runningAgentId) && snapshot().projects.find(project => project.id === firstCatalogId).conversations.every(chat => chat.role === 'agent_command'), 'project groups list only saved Agent Work conversations');
  await adapter.command('chat.open', { projectId: secondProjectId, catalogId: firstCatalogId, role: 'agent_command', conversationId: runningAgentId }); await tick();
  check(snapshot().project.id === firstProjectId && document.getElementById('workspaceSelectionPanel').hidden, 'a saved project chat reopens without another folder picker');
  check(!snapshot().goalEditor && workspaceManager.state.project.goal === 'Compare enzyme variants at matched pH.', 'reopening restores the local goal without prompting again');
  check(findAnalysisPanel(runningAgentId).title === 'Enzyme evidence review' && findAnalysisPanel(runningAgentId).customTitle, 'custom chat name survives project close and reopen');
  check(analysisPanels.some(panel => panel.id === forkedAgentId && panel.messages.some(message => message.content === 'Continue only the forked analysis.')) && snapshot().conversations.some(chat => chat.id === forkedSideId), 'both independent forks survive project close and reopen');
  check(sideChatMessages.some(message => message.content.includes('25 U/mL')), 'Side Chat history survives project close/reopen');
  check(sideChatMessages.some(message => message.role === 'assistant' && message.elapsedMs >= 1000), 'per-turn duration survives project close/reopen');
  check(sideChatMessages.some(message => message.images?.[0]?.attachmentId === attachmentId), 'image attachment reference survives project close/reopen');
  check(JSON.stringify(currentRecommendation) === originalRecommendation, 'existing recommendation remains unchanged after reopening');
  check(analysisPanels[0].messages.some(message => message.content.includes('Not yet ingested')), 'Agent Work transcript and download result survive reopen');
  await adapter.command('agent.open', { projectId: firstProjectId, role: 'agent_command', conversationId: secondAgentId }); await tick();
  check(snapshot().activeConversationId === secondSideId && sideChatMessages[0].content.includes('Independent notes'), 'a second Agent Work panel restores its own Side Chat after a project reopen');
  for (let i = 0; i < 5; i++) {
    document.querySelector('[aria-label="New Side Chat"]').click();
    await waitFor(() => !snapshot().projectBusy && sideChatMessages.length === 0, 'new panel-owned discussion');
    await sendSide(`Second panel discussion ${i}`); await waitFor(() => !snapshot().sideBusy, 'panel-owned discussion complete');
  }
  check(snapshot().conversations.length === 5 && document.querySelector('.side-history-picker').textContent.includes('5/5'), 'each Agent Work dropdown retains at most five Side Chat histories');
  check(!snapshot().conversations.some(chat => chat.id === secondSideId), 'sixth Side Chat evicts only the oldest history in its own panel');
  await adapter.command('agent.open', { projectId: firstProjectId, role: 'agent_command', conversationId: runningAgentId }); await tick();
  check(snapshot().activeConversationId === savedChatId && sideChatMessages.some(message => message.images?.[0]?.attachmentId === attachmentId), 'another panel reaching its history limit preserves this panel history and image attachments');
  await openGoalMenu('Separate Project');
  document.querySelector('[role="menuitem"]').click();
  await waitFor(() => snapshot().project?.id === secondProjectId && snapshot().goalEditor && !snapshot().projectBusy, 'inactive project goal editor'); await tick();
  check(snapshot().goalEditor.goal === '', 'editing an inactive project opens that project goal');
  await saveGoal('Review the separate project evidence.');
  await adapter.command('chat.open', { projectId: secondProjectId, catalogId: firstCatalogId, role: 'agent_command', conversationId: runningAgentId }); await tick();
  check(workspaceManager.state.project.goal === 'Compare enzyme variants at matched pH.', 'editing a different project leaves the original goal intact');
  // Per-message copy uses the same native clipboard bridge as transcript copy.
  const copyStart = copiedChats.length;
  const sideMessage = sideChatMessages[0], agentMessage = findAnalysisPanel(runningAgentId).messages[0];
  document.querySelector(`#sideChatHistory [data-message-id="${sideMessage.id}"] [data-side-chat-action="copy-message"]`).click();
  await waitFor(() => copiedChats.length === copyStart + 1, 'copy Side Chat message');
  document.querySelector(`.analysis-panel[data-panel-id="${runningAgentId}"] [data-analysis-action="copy-message"][data-message-id="${agentMessage.id}"]`).click();
  await waitFor(() => copiedChats.length === copyStart + 2, 'copy Agent message');
  check(copiedChats[copyStart] === sideMessage.content && copiedChats[copyStart + 1] === agentMessage.content, 'message copy contains only the targeted message');
  check(document.querySelectorAll('#sideChatHistory .message-copy-button').length === sideChatMessages.length, 'every saved Side Chat message has a copy button');
  check(document.querySelectorAll(`.analysis-panel[data-panel-id="${runningAgentId}"] .message-copy-button`).length === findAnalysisPanel(runningAgentId).messages.length, 'every Agent message has a copy button');
  // Delete an inactive Side Chat without selecting or reordering the active chat.
  document.querySelector('[aria-label="Side Chat history"]').click(); await tick();
  await requestChatDeletion(document.querySelector(`[role="option"][data-conversation-id="${forkedSideId}"]`));
  document.querySelector('[aria-label="Delete chat"] .secondary-button').click(); await tick();
  check(snapshot().conversations.some(chat => chat.id === forkedSideId), 'cancelling deletion keeps Side Chat history');
  if (document.querySelector('[aria-label="Side Chat history"]').getAttribute('aria-expanded') !== 'true') { document.querySelector('[aria-label="Side Chat history"]').click(); await tick(); }
  await requestChatDeletion(document.querySelector(`[role="option"][data-conversation-id="${forkedSideId}"]`));
  document.querySelector('[aria-label="Delete chat"] .delete-confirm').click();
  await waitFor(() => !snapshot().projectBusy && !snapshot().conversations.some(chat => chat.id === forkedSideId), 'delete saved Side Chat'); await tick();
  check(snapshot().activeConversationId === savedChatId, 'deleting inactive Side Chat preserves current history selection');
  const removedSidePath = workspaceChatStore.conversationPath(forkedSideId);
  check(!await workspaceManager.fileExists(removedSidePath), 'deleted Side Chat file is removed from its scoped store');
  document.querySelector('[aria-label="New Side Chat"]').click();
  await waitFor(() => !snapshot().projectBusy && snapshot().activeConversationId !== savedChatId, 'new chat for active deletion'); await tick();
  const emptyDeleteId = snapshot().activeConversationId;
  document.querySelector('[aria-label="Side Chat history"]').click(); await tick();
  await requestChatDeletion(document.querySelector(`[role="option"][data-conversation-id="${emptyDeleteId}"]`));
  document.querySelector('[aria-label="Delete chat"] .delete-confirm').click();
  await waitFor(() => !snapshot().projectBusy && snapshot().activeConversationId !== emptyDeleteId, 'delete active Side Chat'); await tick();
  check(!snapshot().conversations.some(chat => chat.id === emptyDeleteId), 'deleting active Side Chat selects a remaining history');
  await selectSideHistory(savedChatId);
  await adapter.command('agent.open', { projectId: firstProjectId, role: 'agent_command', conversationId: forkedAgentId }); await tick();
  const forkSidePath = workspaceChatStore.conversationPath(snapshot().activeConversationId);
  await requestChatDeletion(document.querySelector('.chat-row[aria-current="page"]'));
  document.querySelector('[aria-label="Delete chat"] .secondary-button').click(); await tick();
  check(snapshot().agents.some(chat => chat.id === forkedAgentId), 'cancelling deletion keeps Agent history');
  await requestChatDeletion(document.querySelector('.chat-row[aria-current="page"]'));
  document.querySelector('[aria-label="Delete chat"] .delete-confirm').click();
  await waitFor(() => !snapshot().projectBusy && !snapshot().agents.some(chat => chat.id === forkedAgentId), 'delete active Agent'); await tick();
  check(snapshot().activeAgentId !== forkedAgentId && !await workspaceManager.fileExists(forkSidePath), 'deleting selected Agent selects a valid replacement and removes its Side Chats');
  await adapter.command('agent.open', { projectId: firstProjectId, role: 'agent_command', conversationId: runningAgentId }); await tick();
  check(snapshot().activeConversationId === savedChatId && await workspaceManager.fileExists('literature/enzyme-paper.pdf'), 'deleting chats preserves other histories and downloaded papers');
  // Plan mode: the Mode selector sends a planning turn, the proposed plan renders
  // as a card, and "Implement this plan" continues in Default mode.
  const mode = () => document.querySelector('.analysis-panel:not([hidden]) [data-agent-setting="collaborationMode"]');
  check(mode()?.value === 'default', 'Agent Work starts in Default mode');
  mode().value = 'plan'; mode().dispatchEvent(new Event('change', { bubbles: true })); await tick();
  await sendAgent('Plan the next fermentation run.'); await waitFor(() => !snapshot().agentBusy, 'plan turn');
  check(requests.at(-1).desktopTools?.collaborationMode === 'plan', 'the planning turn carries plan mode');
  const card = () => document.querySelector('.analysis-panel:not([hidden]) .proposed-plan');
  check(card()?.querySelector('.proposed-plan-body')?.textContent.includes('Repeat the best condition in triplicate'), 'the proposed plan renders as a card');
  check(!card().querySelector('.proposed-plan-body').textContent.includes('proposed_plan'), 'the plan tags are not shown');
  check([...card().querySelectorAll('.proposed-plan-actions button')].map(button => button.textContent).join('|') === 'Implement this plan|Implement in a new conversation|Keep planning', 'the plan offers the three choices');
  card().querySelector('[data-analysis-action="plan-implement"]').click();
  await waitFor(() => requests.at(-1).originalRequest === 'Implement the plan.', 'implementation turn'); await waitFor(() => !snapshot().agentBusy, 'implementation turn finishes');
  check(!requests.at(-1).desktopTools?.collaborationMode && mode().value === 'default', 'implementing switches the conversation back to Default');
  check(!document.querySelector('.analysis-panel:not([hidden]) .proposed-plan-actions') && document.querySelector('.analysis-panel:not([hidden]) .proposed-plan-choice')?.textContent === 'Implementing this plan in this conversation.', 'a plan is acted on once');
  // Bug reports: the header opens the dialog, which lists what the report will
  // contain; the host saves it (the fixture main process checks the file).
  document.querySelector('[data-feedback-open]').click(); await tick();
  const report = () => document.querySelector('dialog.feedback-dialog');
  check(report()?.open && report().querySelectorAll('input[name="category"]').length === 5 && report().querySelector('input[value="bug"]').checked, 'the bug report dialog offers five categories');
  check(report().querySelector('input[name="includeLogs"]').checked && report().querySelectorAll('.feedback-contents li').length === 4, 'the report lists what it will contain');
  report().querySelector('textarea[name="note"]').value = ['Agent Work stopped. Authorization: Bearer', 'abcdefghijklmnopqrstuvwxyz012345'].join(' ');
  report().querySelector('form').requestSubmit();
  await waitFor(() => /^Saved biodesign-report-[0-9a-f]{8}\.json/.test(report()?.querySelector('.feedback-status')?.textContent || ''), 'report saved');
  check(report().querySelector('.feedback-actions button').textContent === 'Show in folder', 'a saved report can be shown in its folder');
  report().querySelector('form').requestSubmit(); await tick();
  check(!report(), 'the report dialog closes');
  // Memory: off until enabled in the Memory tab; the setting lives in the project
  // (the fixture main process checks .biodesign/memory/settings.json).
  document.querySelector('[aria-label="Open skills and MCP plugins"]').click(); await tick();
  [...document.querySelectorAll('.runtime-tabs button')].find(button => button.textContent === 'Memory').click();
  const memoryToggle = () => document.querySelector('.memory-toggle input');
  await waitFor(() => memoryToggle() && !memoryToggle().disabled, 'memory settings load');
  check(!memoryToggle().checked && document.querySelector('.memory-settings').textContent.includes('not evidence'), 'memory is off until enabled and says memories are not evidence');
  memoryToggle().click();
  await waitFor(() => memoryToggle()?.checked && !memoryToggle().disabled, 'memory enabled');
  check(/0 conversations processed · last run: never/.test(document.querySelector('.memory-status').textContent), 'memory status shows nothing processed yet');
  check(document.querySelector('.memory-settings button[aria-expanded]').disabled, 'there is no memory to view yet');
  document.querySelector('.runtime-extensions [aria-label="Close dialog"]').click(); await tick();
  check(!document.querySelector('.runtime-extensions'), 'the settings dialog closes');
  // Parallel tasks: up to three Agent Work conversations run at once, each with
  // its own folder name for output/; a fourth waits; Side Chat is not counted.
  gates.agent_instruction = [];
  const parallel = [];
  for (const text of ['Plot titre against pH.', 'Summarise the assay results.', 'Draft the methods section.']) {
    await adapter.command('agent.new', { projectId: snapshot().project.id, role: 'agent_command' }); await tick();
    await sendAgent(text); parallel.push(snapshot().activeAgentId);
  }
  await waitFor(() => gates.agent_instruction.length === 3, 'three Agent Work turns run at once');
  check(snapshot().agentTurnsRunning === 3 && parallel.every(id => snapshot().runs[`agent_command:${id}`]?.status === 'running'), 'three Agent Work conversations run at once');
  const folders = parallel.map(id => findAnalysisPanel(id).outputFolder);
  check(folders.every(folder => /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/.test(folder)) && new Set(folders).size === 3 && folders[0].startsWith('plot-titre-against-ph-'), `each conversation has its own output/ folder name (${folders.join(', ')})`);
  const projectGroup = name => [...document.querySelectorAll('.project-group')].find(group => group.querySelector('.project-group-heading strong')?.textContent === name);
  const runningRows = [...projectGroup('Enzyme Engineering').querySelectorAll('[data-topic-select]')].filter(row => row.querySelector('.activity-dot'));
  check(runningRows.length === 3 && runningRows.every(row => !row.disabled), 'conversations in the project stay open to switch while tasks run, each marked as running');
  check(document.querySelector('[aria-label="New chat in Separate Project"]').disabled && !projectGroup('Separate Project').querySelector('[data-topic-select]:not(:disabled)'), 'nothing switches to another project while tasks run');
  await adapter.command('agent.new', { projectId: snapshot().project.id, role: 'agent_command' }); await tick();
  const waiting = snapshot().activeAgentId, beforeWaiting = requests.length;
  const waitingInput = () => document.querySelector(`[data-analysis-instruction][data-panel-id="${waiting}"]`);
  check(waitingInput().closest('form').querySelector('button[type="submit"]').disabled && waitingInput().closest('form').querySelector('.agent-turn-limit')?.textContent.startsWith('3 Agent Work tasks are running'), 'a fourth task waits, and its composer says why');
  waitingInput().value = 'Check the plate reader export.'; waitingInput().dispatchEvent(new Event('input', { bubbles: true }));
  waitingInput().closest('form').requestSubmit(); await tick();
  check(requests.length === beforeWaiting && !snapshot().agentBusy && [...document.querySelectorAll('.toast')].some(toast => toast.textContent.startsWith('3 Agent Work tasks are running')), 'a fourth turn does not start while three run');
  await sendSide('Notes while the tasks run.'); await waitFor(() => !snapshot().sideBusy, 'Side Chat alongside three tasks');
  check(sideChatMessages.at(-1).role === 'assistant', 'Side Chat is not counted against the limit');
  gates.agent_instruction.shift()();
  await waitFor(() => snapshot().agentTurnsRunning === 2, 'one task finishes');
  check(!waitingInput().closest('form').querySelector('.agent-turn-limit') && waitingInput().value === 'Check the plate reader export.', 'the waiting task can start, with its instruction kept');
  waitingInput().closest('form').requestSubmit();
  await waitFor(() => snapshot().agentBusy && gates.agent_instruction.length === 3, 'the fourth task starts');
  gates.agent_instruction.splice(0).forEach(finish => finish()); delete gates.agent_instruction;
  await waitFor(() => snapshot().agentTurnsRunning === 0, 'all tasks finish');
  check([...parallel, waiting].every(id => findAnalysisPanel(id).messages.at(-1).role === 'assistant' && findAnalysisPanel(id).taskStatus !== 'running'), 'every parallel task keeps its own reply');
  // The folder name crosses the validated IPC boundary to the host runtime.
  const runtimeOpen = taskFolder => window.biodesignDesktop.execution.runWorkflow({ workflowId: 'runtime_advanced_open', input: { owner: crypto.randomUUID(), surface: 'agent_command', permission: 'workspace_write', taskFolder } });
  let folderError = null;
  try { await runtimeOpen('Titre/Plot'); } catch (error) { folderError = error.code; }
  check(folderError === 'INVALID_TASK_FOLDER', `the host rejects an invalid task folder (${folderError})`);
  check(typeof (await runtimeOpen(folders[0])).project === 'boolean', 'the host accepts the conversation\'s folder name');
  // Agent Work history: each conversation keeps a canonical transcript that the
  // next turn replays, with earlier tool calls and results, instead of excerpts.
  const agentRequests = () => requests.filter(request => request.mode === 'agent_instruction');
  const transcriptFile = id => `.biodesign/chat/agents/${id}/agent-transcript.json`;
  await adapter.command('agent.open', { projectId: snapshot().project.id, role: 'agent_command', conversationId: parallel[0] }); await tick();
  await sendAgent('Follow up on the titre plot.'); await waitFor(() => !snapshot().agentBusy, 'follow-up turn');
  const seeded = agentRequests().at(-1);
  check(seeded.conversationTranscript?.turns.length === 1 && seeded.conversationTranscript.turns[0].legacy && seeded.conversationTranscript.turns[0].messages[0].content === 'Plot titre against pH.',
    'an existing conversation starts its transcript from its earlier messages');
  check(!seeded.messages.some(message => /Previous conversation excerpts/.test(message.content)), 'no excerpts are sent once the transcript exists');
  agentCheckpoints = true;
  await adapter.command('agent.new', { projectId: snapshot().project.id, role: 'agent_command' }); await tick();
  const historyId = snapshot().activeAgentId;
  await sendAgent('Summarise runs.csv.'); await waitFor(() => !snapshot().agentBusy, 'first history turn');
  const firstTurnId = agentRequests().at(-1).callContext.turnId;
  check(agentRequests().at(-1).conversationTranscript.turns.length === 0, 'a new conversation starts with an empty transcript');
  check(findAnalysisPanel(historyId).messages[0].id === firstTurnId, 'the turn ID is the user message ID');
  await sendAgent('Now plot the same runs.'); await waitFor(() => !snapshot().agentBusy, 'second history turn');
  const secondTurnId = agentRequests().at(-1).callContext.turnId;
  const replayed = agentRequests().at(-1).conversationTranscript.turns.find(turn => turn.turnId === firstTurnId);
  check(replayed && !replayed.legacy && replayed.messages.some(message => message.role === 'tool' && /Summarise runs\.csv\. -> run A 4\.2 g\/L/.test(message.content)),
    'the follow-up turn carries the earlier turn\'s tool calls and results');
  const saved = await workspaceManager.readJson(transcriptFile(historyId));
  check(saved.version === 1 && saved.transcript.turns.map(turn => turn.turnId).join() === [firstTurnId, secondTurnId].join(), 'the transcript is saved with the conversation');
  // A fork keeps the turns it keeps.
  await adapter.command('agent.fork', { projectId: snapshot().project.id, role: 'agent_command', conversationId: historyId, messageId: `${firstTurnId}-reply` });
  await waitFor(() => snapshot().activeAgentId !== historyId && !snapshot().projectBusy, 'fork with history'); await tick();
  const forkId = snapshot().activeAgentId;
  check((await workspaceManager.readJson(transcriptFile(forkId))).transcript.turns.map(turn => turn.turnId).join() === firstTurnId, 'a fork keeps only the transcript of the turns it keeps');
  // Editing the latest message replaces its turn in the transcript.
  await adapter.command('agent.open', { projectId: snapshot().project.id, role: 'agent_command', conversationId: historyId }); await tick();
  const historyPanel = () => document.querySelector(`.analysis-panel[data-panel-id="${historyId}"]`);
  historyPanel().querySelector('[data-analysis-action="edit"]').click(); await tick();
  const editor = historyPanel().querySelector('[data-agent-edit-input]');
  editor.value = 'Now tabulate the same runs.'; editor.dispatchEvent(new Event('input', { bubbles: true }));
  historyPanel().querySelector('[data-analysis-action="save-edit"]').click();
  await waitFor(() => agentRequests().at(-1).originalRequest === 'Now tabulate the same runs.', 'edited turn'); await waitFor(() => !snapshot().agentBusy, 'edited turn finishes');
  const editedTranscript = agentRequests().at(-1).conversationTranscript;
  check(editedTranscript.turns.map(turn => turn.turnId).join() === firstTurnId && editedTranscript.discardedTurnIds.includes(secondTurnId), 'an edit replaces its turn in the transcript');
  agentCheckpoints = false;
  // Deleting a conversation deletes its transcript.
  await adapter.command('chat.delete', { projectId: snapshot().project.id, catalogId: snapshot().catalogId, role: 'agent_command', conversationId: forkId });
  await waitFor(() => !snapshot().agents.some(chat => chat.id === forkId) && !snapshot().projectBusy, 'delete fork');
  check(!await workspaceManager.fileExists(transcriptFile(forkId)) && await workspaceManager.fileExists(transcriptFile(historyId)), 'deleting a conversation deletes only its transcript');
  // Citations open the folder that holds the cited file, in Side Chat and Agent Work.
  const cited = literatureModule.sourceRegistry.getByPath('literature/evidence.pdf'), originalHash = cited.contentHash;
  const preparedHash = 'sha256:' + 'b'.repeat(64);
  const citationReply = (hash, relativePath = 'literature/evidence.pdf') => ({ reply: 'The assay reached 25 U/mL [evidence](biodesign-citation:citation-1).',
    citations: [{ id: 'citation-1', reference: cited.sourceId, sourceId: cited.sourceId, relativePath, contentHash: hash, status: 'resolved' }] });
  const lastCitation = scope => [...document.querySelectorAll(`${scope} .side-source-citation`)].at(-1);
  // The turn's own evidence reads prepare the source while it runs; the citation
  // is bound to the source as it is once the answer arrives.
  gates.side_chat = [];
  nextCitationReply = { mode: 'side_chat', ...citationReply(preparedHash) };
  await sendSide('Which source reports the activity?');
  await waitFor(() => gates.side_chat.length === 1, 'cited Side Chat answer pending');
  cited.contentHash = preparedHash;
  gates.side_chat.splice(0).forEach(finish => finish()); delete gates.side_chat;
  await waitFor(() => !snapshot().sideBusy, 'cited Side Chat answer'); await tick();
  check(sideChatMessages.at(-1).citations[0].status === 'resolved' && !lastCitation('#sideChatHistory').disabled && /Show in folder$/.test(lastCitation('#sideChatHistory').title),
    'a Side Chat citation is bound to its source as prepared during the turn, and offers its folder');
  lastCitation('#sideChatHistory').click(); await tick();
  nextCitationReply = { mode: 'agent_instruction', ...citationReply(preparedHash) };
  await sendAgent('Which source reports the activity?'); await waitFor(() => !snapshot().agentBusy, 'cited Agent Work answer'); await tick();
  check(lastCitation('.analysis-panel:not([hidden])') && !lastCitation('.analysis-panel:not([hidden])').disabled, 'an Agent Work citation offers its folder');
  lastCitation('.analysis-panel:not([hidden])').click(); await tick();
  // A citation saved as missing before its source was prepared is current, and clickable, now.
  const savedReply = document.createElement('div'); document.body.append(savedReply);
  renderSideChatMarkdown(savedReply, citationReply(preparedHash).reply, [{ ...citationReply(preparedHash).citations[0], status: 'missing', workspaceId: snapshot().project.id }]);
  check(!savedReply.querySelector('.side-source-citation').disabled && !/unavailable/.test(savedReply.querySelector('.side-source-citation').title), 'a citation saved as missing whose source is current is clickable again');
  // A file that moved opens the folder that held it.
  renderSideChatMarkdown(savedReply, citationReply(preparedHash).reply, [{ ...citationReply(preparedHash, 'literature/moved.pdf').citations[0], workspaceId: snapshot().project.id }]);
  check(!savedReply.querySelector('.side-source-citation').disabled, 'a citation of a moved file still offers its folder');
  savedReply.querySelector('.side-source-citation').click();
  await waitFor(() => [...document.querySelectorAll('.toast')].some(toast => /no longer there/.test(toast.textContent)), 'moved file opens its folder');
  savedReply.remove(); cited.contentHash = originalHash;
  // A project-mode turn's output/ changes: the turn card shows the host's totals,
  // undoes them once, and the undo command reaches the host workflow over IPC.
  const outputHost = document.createElement('div'); document.body.appendChild(outputHost);
  let undoneTurn = null;
  window.BioDesignTurnDetails.mount(outputHost, { details: { version: 1, turnId: 'output-turn', model: 'fixture', startedAt: 1, finishedAt: 2,
    activities: [{ id: 'tool:run', kind: 'tool', stage: 'tool-completed', status: 'completed', name: 'exec_command', summary: { filesCreated: 1, filesChanged: 1 } }],
    artifacts: [], turnUsage: null, childUsage: [], outputChanges: { created: 1, changed: 1, deleted: 0, complete: true, undoAvailable: true } },
    onUndoOutput: async turnId => { undoneTurn = turnId; return { turnId, restored: ['output/summary.md'], removed: ['output/report.md'], conflicts: [] }; } });
  await tick();
  check(outputHost.querySelector('.turn-output-changes')?.textContent.includes('Files in output/: 1 created · 1 changed'), 'the turn card shows its output/ changes');
  outputHost.querySelector('.turn-output-changes button').click(); await tick();
  check(undoneTurn === 'output-turn' && outputHost.querySelector('.turn-output-changes [role="status"]')?.textContent === 'Restored 1 and removed 1 files.', 'undo reports what it restored');
  check(!outputHost.querySelector('.turn-output-changes button'), 'undo is offered once');
  let undoError = null;
  try { await adapter.command('output.undo', { projectId: snapshot().project.id, turnId: 'turn-without-changes' }); } catch (error) { undoError = error.code; }
  check(undoError === 'NO_OUTPUT_CHANGES', `output.undo reaches the host workflow through validated IPC (${undoError})`);
  outputHost.remove();
  // Long real-path response to inspect wrapping and bounded scrolling.
  responseText = '### Enzyme evidence\n\n' + ('Measured activity should be interpreted alongside pH, substrate and replicate controls.\n\n').repeat(28) + '\n```text\n' + 'long-sequence-'.repeat(60) + '\n```';
  await sendSide('Explain evidence limitations.'); await waitFor(() => !snapshot().sideBusy, 'long reply');
  responseText = '';
  await sendAgent('Summarize the next experiment for review.'); await waitFor(() => !snapshot().agentBusy, 'recommendation for visual review');
  await flushWorkspaceState();
  document.querySelector('.agent-result-actions details').open = true;
  await tick();
}
async function checkWorkbenchLayout(width) {
  if (width < 1000 && !document.querySelector('.sidebar-closed')) document.querySelector('[aria-label="Toggle sidebar"]').click();
  await tick();
  const pane = document.querySelector('.side-pane'), history = document.getElementById('sideChatHistory'), composer = document.getElementById('sideChatForm');
  if (width < 1000) { document.querySelectorAll('.narrow-pane-tabs button')[1].click(); await tick(); }
  check(document.documentElement.scrollWidth <= innerWidth + 2, `no horizontal viewport overflow at ${width}px`);
  check(composer.getBoundingClientRect().bottom <= innerHeight && composer.getBoundingClientRect().height > 60, `composer remains visible at ${width}px`);
  check(history.scrollHeight > history.clientHeight && getComputedStyle(history).overflowY === 'auto', `long timeline scrolls independently at ${width}px`);
  for (const container of [history, ...(width >= 1000 ? [document.querySelector('.analysis-panel:not([hidden]) .agent-conversation')] : [])]) {
    const user = container.querySelector('.side-message.user'), bubble = user.querySelector('.message-bubble'), footer = user.querySelector('.message-actions');
    const rect = user.getBoundingClientRect(), parent = container.getBoundingClientRect();
    check(rect.width <= parent.width * .68 && rect.left > parent.left + parent.width * .25, `user bubble occupies right two-thirds at ${width}px`);
    check(getComputedStyle(bubble).backgroundColor === 'rgb(231, 243, 255)', 'user bubble uses the requested pale blue');
    check(footer.getBoundingClientRect().top >= bubble.getBoundingClientRect().bottom && !bubble.contains(user.querySelector('.message-copy-button')), 'copy actions are below and outside the bubble');
    const edit = container.querySelector('[data-side-chat-action="edit"], [data-analysis-action="edit"]');
    check(!edit || (edit.parentElement.classList.contains('message-actions') && edit.querySelector('svg') && edit.getAttribute('aria-label')), 'edit remains accessible as a pencil outside the bubble');
  }
  const modelRect = document.getElementById('sideChatModelSelect').getBoundingClientRect(), attachRect = document.getElementById('attachSideChatImageButton').getBoundingClientRect();
  check(modelRect.width > 50 && modelRect.right <= attachRect.left + 1, `model selector remains usable without overlapping actions at ${width}px`);
  if (width >= 1000) {
    const agentComposer = document.querySelector('.analysis-panel:not([hidden]) .agent-composer').getBoundingClientRect(), sideComposer = composer.getBoundingClientRect();
    check(Math.abs(agentComposer.top - sideComposer.top) < 2 && Math.abs(agentComposer.height - sideComposer.height) < 2, `composers align and have equal height at ${width}px`);
    check(composer.contains(document.getElementById('sideChatModelSelect')), 'Side Chat model selector is inside its composer');
    check(document.querySelector('.agent-pane').getBoundingClientRect().width > 200 && pane.getBoundingClientRect().width > 200, `both role panes visible at ${width}px`);
    const resize = document.querySelector('[aria-label="Resize Side Chat and Agent Work"]');
    const before = resize.getAttribute('aria-valuenow'); resize.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true })); await tick();
    check(resize.getAttribute('aria-valuenow') !== before, `keyboard resizing works at ${width}px`);
  } else {
    check(getComputedStyle(document.querySelector('.agent-pane')).display === 'none', `narrow layout shows the selected pane at ${width}px`);
    document.querySelector('.narrow-pane-tabs button').click(); await tick();
    check(getComputedStyle(document.querySelector('.side-pane')).display === 'none', `narrow pane switch keeps explicit target at ${width}px`);
    document.querySelectorAll('.narrow-pane-tabs button')[1].click(); await tick();
  }
}
