'use strict';
const contract = require('./shared/literature-agent.js');
const prompts = require('./shared/agent-prompts.js');
const crypto = require('node:crypto');

// Specialist messages are held separately inside the signed continuation. They
// are never appended to main-agent messages or the user-visible transcript.
function create(name, task, mainCallId) {
  contract.validate(contract.tasks[name], task);
  return { kind: name, task, mainCallId, turns: 0, calls: 0, startedAt: Date.now(),
    messages: [{ role: 'system', content: `${name === 'discover_papers' ? prompts.discover : prompts.retrieve}\n${prompts.browser}` }, { role: 'user', content: JSON.stringify(task) }],
    pending: { action: 'begin', kind: name, task }, schemas: [], results: [] };
}
function handoff(state) {
  const fingerprint = crypto.createHash('sha256').update(JSON.stringify(state.pending)).digest('hex');
  const id = state.pendingFingerprint === fingerprint ? state.pendingId : `literature_${crypto.randomBytes(8).toString('hex')}`;
  state.pendingFingerprint = fingerprint;
  state.pendingId = id;
  return { id, name: 'literature_worker', args: state.pending };
}
function accept(state, response) {
  if (!response || typeof response !== 'object' || JSON.stringify(response).length > 150000) throw new Error('Invalid literature host result');
  if (response.final) {
    state.final = contract.validate(contract.results[state.kind], response.final); state.pending = null; return;
  }
  if (response.tools) {
    if (!Array.isArray(response.tools) || response.tools.length > 40 || !/^lit_[a-f0-9]{24}$/.test(response.job_id)) throw new Error('Invalid specialist tools');
    state.jobId = response.job_id; state.schemas = response.tools;
    state.openAccessOnly = response.access?.open_access_only === true;
    if (state.openAccessOnly) state.messages.push({ role: 'system', content: 'The user explicitly continued without a library URL. For this task search only open-access papers through public sources. Institutional browsing is disabled. Omit candidates without open-access evidence and disclose coverage limits. This restriction overrides the default broad-discovery scope.' });
    else if (response.access?.library_url) state.messages.push({ role: 'system', content: `The user selected this library URL in the application: ${JSON.stringify(response.access.library_url)}. Use it as the institutional entry point; it supersedes any library URL in the original delegated task.` });
  }
  if (state.pendingModelCall) {
    state.messages.push({ role: 'tool', tool_call_id: state.pendingModelCall.id, content: JSON.stringify(response.result || response.error && { error: response.error } || response) });
    state.pendingModelCall = null;
  } else state.messages.push({ role: 'user', content: JSON.stringify(response) });
  state.pending = null;
}
async function advance(state, { requestTurn, supportsWebSearch, search, onProgress }) {
  if (state.final || state.pending) return;
  const finish = state.kind === 'discover_papers' ? 'finish_discovery' : 'finish_retrieval';
  if (JSON.stringify(state.messages).length > 250000) state.turns = 24;
  while (state.turns < 24 && state.calls < 36 && Date.now() - state.startedAt < 12 * 60000) {
    state.turns++;
    await onProgress({ stage: 'literature-specialist', capability: state.kind, step: state.turns });
    const webTool = contract.tool('search_web', 'Search external scholarly metadata with the selected model; no downloading.', contract.object({ query: contract.text(2000) }));
    const tools = [...state.schemas, ...(supportsWebSearch && state.kind === 'discover_papers' && (state.webCalls || 0) < 3 ? [webTool] : [])];
    const turn = await requestTurn({ messages: state.messages, tools, temperature: 0.2, stage: 'literature-specialist' });
    if (!turn.ok) break;
    const calls = (turn.message?.tool_calls || []).filter(call => call.type === 'function');
    if (calls.length !== 1) { state.messages.push({ role: 'user', content: `Choose exactly one exposed function per turn. Finish through ${finish}; prose cannot establish retrieval.` }); continue; }
    const call = calls[0]; let args;
    try { args = JSON.parse(call.function.arguments || '{}'); } catch { args = null; }
    if (!tools.some(tool => tool.function?.name === call.function.name) || !args) { state.messages.push({ role: 'user', content: 'Invalid tool name or arguments. Use the current schemas.' }); continue; }
    state.messages.push({ role: 'assistant', content: turn.message.content || '', tool_calls: [call] }); state.calls++;
    if (call.function.name === 'search_web') {
      contract.validate(webTool.function.parameters, args); state.webCalls = (state.webCalls || 0) + 1;
      const query = state.openAccessOnly ? `${args.query} open access full text` : args.query;
      const evidence = await search(query); state.messages.push({ role: 'tool', tool_call_id: call.id, content: evidence }); state.pending = { action: 'web_receipt', job_id: state.jobId, args: { query, evidence: String(evidence).slice(0, 40000) } }; return;
    }
    state.pendingModelCall = call;
    state.pending = { action: 'step', job_id: state.jobId, name: call.function.name, args };
    return;
  }
  // Host makes the final receipt even after model failure/budget exhaustion.
  state.pending = { action: 'step', job_id: state.jobId, name: finish, args: state.kind === 'discover_papers' ? { candidates: [], limitations: ['Specialist model or reasoning budget exhausted; discovery coverage is incomplete.'] } : {} };
}
module.exports = { create, handoff, accept, advance };
