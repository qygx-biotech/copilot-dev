'use strict';
const contract = require('./shared/literature-agent.js');
const prompts = require('./shared/agent-prompts.js');
const crypto = require('node:crypto');
const { inputQuota } = require('./input-quota.js');

const KEEP_RECENT_TOOL_RESULTS = 1;
const COMPACTED_TOOL_RESULT = '[Earlier tool result compacted. Re-run if needed.]';
function microCompact(messages) {
  const results = messages.filter(message => message.role === 'tool');
  let replaced = 0;
  for (const result of results.slice(0, Math.max(0, results.length - KEEP_RECENT_TOOL_RESULTS))) {
    if (typeof result.content === 'string' && result.content.length > 120) {
      result.content = COMPACTED_TOOL_RESULT;
      replaced++;
    }
  }
  return replaced;
}

const safeText = value => String(value || '').replace(/(?:authorization|cookie|api[_-]?key|token|password|secret)\s*[:=]\s*[^\r\n]*/gi, '[redacted credentials]').replace(/\bBearer\s+[^\s,;]+/gi, 'Bearer [redacted]').replace(/https?:\/\/[^\s<>"']+/gi, '[redacted URL]').slice(0, 1000);
function failure(state, error, stage = 'provider') {
  const code = /^[A-Za-z][A-Za-z0-9_]{0,99}$/.test(error?.error || error?.code || '') ? error.error || error.code : 'LITERATURE_SPECIALIST_FAILED';
  const diagnostics = { code, message: safeText(error?.reason || error?.message || code), failureStage: `literature-specialist.${stage}`,
    jobId: state.jobId, capability: state.kind, step: state.turns, toolCalls: state.calls,
    ...(error?.diagnostics?.ownerId ? { ownerId: error.diagnostics.ownerId } : {}),
    inputCharacters: JSON.stringify(state.messages).length,
    ...(Number.isInteger(error?.status) ? { providerStatus: error.status } : {}),
    ...(Number.isInteger(error?.attempts) ? { providerAttempts: error.attempts } : {}),
    ...require('./requesty-response.js').diagnostics(error || {}),
    ...(error?.transportError ? { transportError: Object.fromEntries(['name', 'message', 'code', 'causeCode', 'causeMessage'].filter(key => error.transportError[key]).map(key => [key, safeText(error.transportError[key])])) } : {}),
    ...(error?.cause?.code ? { causeCode: safeText(error.cause.code), causeMessage: safeText(error.cause.message) } : {}) };
  console.error('literature.specialist.failure', diagnostics);
  state.failure = diagnostics;
  return { ok: false, error: code, reason: diagnostics.message, failureStage: diagnostics.failureStage, failure: diagnostics };
}

// Specialist messages are held separately inside the signed continuation. They
// are never appended to main-agent messages or the user-visible transcript.
function create(name, task, mainCallId) {
  contract.validate(contract.tasks[name], task);
  return { kind: name, task, mainCallId, turns: 0, calls: 0, startedAt: Date.now(),
    messages: [{ role: 'system', content: `${name === 'discover_papers' ? prompts.discover : prompts.retrieve}\n${prompts.browser}` }, { role: 'user', content: JSON.stringify(task) }],
    pending: { action: 'begin', kind: name, task }, queuedCalls: [], schemas: [], results: [] };
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
  if (response.blocked) {
    state.jobId = response.job_id || state.jobId;
    state.blocked = response; state.pending = null;
    return;
  }
  if (response.final) {
    try {
      if (state.kind === 'discover_papers' && state.pending?.name === 'finish_discovery' && Object.hasOwn(response.final, 'discoveryArguments')) {
        state.discoveryHandoff = response.final;
        state.final = response.final.discoveryArguments;
      } else state.final = contract.validate(contract.results[state.kind], response.final);
    }
    catch (error) { failure(state, error, 'finalization'); throw error; }
    state.pending = null; state.pendingModelCall = null; state.queuedCalls = [];
    delete state.pendingWebEvidence; delete state.pendingFingerprint; delete state.pendingId;
    return;
  }
  if (response.tools) {
    if (!Array.isArray(response.tools) || response.tools.length > 40 || !/^lit_[a-f0-9]{24}$/.test(response.job_id)) throw new Error('Invalid specialist tools');
    state.jobId = response.job_id; state.schemas = response.tools;
    state.openAccessOnly = response.access?.open_access_only === true;
    if (state.openAccessOnly) state.messages.push({ role: 'system', content: 'The user explicitly continued without a library URL. For this task search only open-access papers through public sources. Institutional browsing is disabled. Omit candidates without open-access evidence and disclose coverage limits. This restriction overrides the default broad-discovery scope.' });
    else if (response.access?.library_url) state.messages.push({ role: 'system', content: `The user selected this library URL in the application: ${JSON.stringify(response.access.library_url)}. Use it as the institutional entry point; it supersedes any library URL in the original delegated task.` });
  }
  if (state.pendingModelCall) {
    const receipt = response.result || response.error && { error: response.error, message: response.message, diagnostics: response.diagnostics } || response;
    state.messages.push({ role: 'tool', tool_call_id: state.pendingModelCall.id, content: JSON.stringify(state.pendingWebEvidence !== undefined ? { evidence: state.pendingWebEvidence, receipt } : receipt) });
    state.pendingModelCall = null;
    delete state.pendingWebEvidence;
  } else state.messages.push({ role: 'user', content: JSON.stringify(response) });
  state.pending = null;
  // Retries of one pending handoff reuse its ID, but consecutive identical
  // model calls are distinct executions and must not reuse a cached receipt.
  delete state.pendingFingerprint; delete state.pendingId;
}
async function advance(state, { requestTurn, supportsWebSearch, search, onProgress = async () => {}, signal }) {
  if (state.blocked) return failure(state, state.blocked, 'browser');
  if (state.final || state.pending) return;
  const finish = state.kind === 'discover_papers' ? 'finish_discovery' : 'finish_retrieval';
  let retryAfterMs;
  delete state.failure;
  while (true) {
    if (signal?.aborted) throw Object.assign(new Error('The request was cancelled.'), { code: 'OPERATION_ABORTED' });
    const webTool = contract.tool('search_web', 'Search external scholarly metadata with the selected model; no downloading.', contract.object({ query: contract.text(2000) }));
    const tools = [...state.schemas, ...(supportsWebSearch && state.kind === 'discover_papers' ? [webTool] : [])];
    // The queue travels inside the signed continuation. Drain it through one
    // host handoff at a time before asking the model for another decision.
    if (!state.queuedCalls?.length) {
      state.turns++;
      await onProgress({ stage: 'literature-specialist', capability: state.kind, step: state.turns });
      if (signal?.aborted) throw Object.assign(new Error('The request was cancelled.'), { code: 'OPERATION_ABORTED' });
      let turn;
      try { turn = await requestTurn({ messages: state.messages, tools, temperature: 0.2, stage: 'literature-specialist', signal, ...(retryAfterMs !== undefined ? { retryAfterMs } : {}) }); }
      catch (error) {
        if (signal?.aborted || error?.code === 'OPERATION_ABORTED') throw error;
        turn = error;
      }
      retryAfterMs = undefined;
      if (signal?.aborted) throw Object.assign(new Error('The request was cancelled.'), { code: 'OPERATION_ABORTED' });
      if (!turn?.ok) {
        if (turn?.error === 'OPERATION_ABORTED') throw Object.assign(new Error('The request was cancelled.'), { code: 'OPERATION_ABORTED' });
        // Temporary, reactive recovery for discovery only. Never compact on
        // preflight, a generic 429, or a failure of the separate web-search call.
        const quota = state.kind === 'discover_papers' && inputQuota(turn);
        if (quota) {
          const beforeCharacters = JSON.stringify(state.messages).length;
          const replaced = microCompact(state.messages);
          if (replaced) {
            retryAfterMs = Math.max(quota.retryAfterMs || 0, (quota.resetAt || 0) - Date.now());
            const event = { stage: 'literature-specialist-compacted', trigger: 'input-token-limit', jobId: state.jobId,
              replacedToolResults: replaced, keptRecentToolResults: KEEP_RECENT_TOOL_RESULTS,
              beforeCharacters, afterCharacters: JSON.stringify(state.messages).length, retryAfterMs };
            console.info('literature.specialist.compacted', event);
            await onProgress(event);
            continue;
          }
        }
        return failure(state, turn);
      }
      const calls = (Array.isArray(turn.message?.tool_calls) ? turn.message.tool_calls : []).filter(call => call?.type === 'function');
      if (!calls.length) { failure(state, { code: 'INVALID_SPECIALIST_TOOL_CALL_COUNT', message: `Expected tool calls; received none. Finish with ${finish}.` }, 'tool-selection'); state.messages.push({ role: 'user', content: `Choose exposed functions; they execute in the supplied order. Finish through ${finish}; prose cannot establish retrieval.` }); continue; }
      const queued = calls.map(call => {
        let args;
        try { args = JSON.parse(call.function?.arguments || '{}'); } catch { args = null; }
        return { call, args };
      });
      const ids = new Set();
      const invalid = queued.some(({ call, args }) => {
        if (typeof call.id !== 'string' || !call.id || ids.has(call.id) || !tools.some(tool => tool.function?.name === call.function?.name) || !args || typeof args !== 'object' || Array.isArray(args)) return true;
        ids.add(call.id); return false;
      });
      if (invalid) { failure(state, { code: 'INVALID_SPECIALIST_TOOL_CALL', message: 'Tool names must be exposed, arguments must be JSON objects, and call IDs must be unique.' }, 'tool-validation'); state.messages.push({ role: 'user', content: 'Invalid tool name, arguments, or call ID. Use the current schemas and unique call IDs.' }); continue; }
      state.messages.push({ role: 'assistant', content: turn.message.content || '', tool_calls: calls });
      state.queuedCalls = queued;
    }
    const { call, args } = state.queuedCalls.shift();
    state.calls++;
    if (call.function.name === 'search_web') {
      try { contract.validate(webTool.function.parameters, args); } catch (error) { return failure(state, error, 'tool-validation'); }
      state.webCalls = (state.webCalls || 0) + 1;
      const query = state.openAccessOnly ? `${args.query} open access full text` : args.query;
      let evidence;
      try { evidence = await search(query); } catch (error) {
        if (signal?.aborted || error?.code === 'OPERATION_ABORTED') throw error;
        return failure(state, error, 'web-search');
      }
      if (signal?.aborted) throw Object.assign(new Error('The request was cancelled.'), { code: 'OPERATION_ABORTED' });
      state.pendingModelCall = call;
      state.pendingWebEvidence = evidence;
      state.pending = { action: 'web_receipt', job_id: state.jobId, args: { query, evidence: String(evidence).slice(0, 40000) } }; return;
    }
    state.pendingModelCall = call;
    state.pending = { action: 'step', job_id: state.jobId, name: call.function.name, args };
    return;
  }
}
module.exports = { create, handoff, accept, advance };
