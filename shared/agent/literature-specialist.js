'use strict';
const contract = require('../literature-agent.js');
const prompts = require('../agent-prompts.js');
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

// Specialist messages are held separately inside the continuation state. They
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
// Retrieval runs deterministically in the host: every paper, one access round
// for sign-ins and human checks, then (only with a library page) model-directed
// catalogue browsing for the papers still missing, then finalization.
const RETRIEVAL_MODEL_TURNS = 20, ACCESS_ROUNDS = 3;
const OPEN_STATUSES = ['unresolved', 'access_unavailable', 'failed', 'needs_login', 'downloaded_unverified'];
function driverStep(state) {
  const d = state.driver, count = state.task.papers.length;
  const step = (name, args = {}) => { d.awaiting = { name, args }; return { action: 'step', job_id: state.jobId, name, args }; };
  if (d.phase === 'sequence') {
    if (d.next < count) return step('retrieve_next', { index: d.next++ });
    d.phase = 'access';
  }
  if (d.phase === 'retry') {
    if (d.retry.length) return step('retrieve_next', { index: d.retry.shift() });
    d.phase = 'access';
  }
  if (d.phase === 'access') {
    if (Object.values(d.outcomes).some(item => item.status === 'needs_login') && d.rounds < ACCESS_ROUNDS) { d.rounds++; return step('request_access'); }
    d.phase = 'browse';
  }
  if (d.phase === 'browse') {
    if (state.libraryBrowsing && !d.browsed && Object.values(d.outcomes).some(item => OPEN_STATUSES.includes(item.status))) { d.browsed = true; return step('start_browsing'); }
    d.phase = 'finish';
  }
  return d.phase === 'finish' ? step('finish_retrieval') : null;
}
function enterBrowsing(state, response) {
  const d = state.driver;
  d.phase = 'model'; d.modelTurns = 0;
  const open = state.task.papers.map((paper, index) => ({ index, title: paper.title.slice(0, 300), ...(paper.doi ? { doi: paper.doi } : {}), ...d.outcomes[index] }))
    .filter(item => OPEN_STATUSES.includes(item.status));
  state.messages.push({ role: 'system', content: `The host has already tried every requested paper automatically (local files, open-access repositories and publisher pages in the library browser). Papers still without a verified download: ${JSON.stringify(open)}. The library browser is open at the user's library page. For each listed paper, search the library catalogue or discovery service by title or DOI, follow the full-text link, and call capture_article on the article PDF link; the host verifies the file. Use record_access only for an observed restriction. Do not call retrieve_next again. Call finish_retrieval when done or when no further route is visible.` });
  state.messages.push({ role: 'user', content: JSON.stringify({ observation: response.observation ?? '' }) });
}
// Long page observations are shortened instead of failing the whole specialist.
function bounded(response) {
  if (!response || typeof response !== 'object') throw new Error('Invalid literature host result');
  if (JSON.stringify(response).length <= 150000) return response;
  const copy = structuredClone(response);
  const note = '\n[Observation shortened by the host; use browser_find to search the page.]';
  if (typeof copy.observation === 'string' && copy.observation.length > 60000) copy.observation = copy.observation.slice(0, 60000) + note;
  if (typeof copy.result?.snapshot === 'string' && copy.result.snapshot.length > 60000) copy.result.snapshot = copy.result.snapshot.slice(0, 60000) + note;
  if (JSON.stringify(copy).length <= 150000) return copy;
  if (copy.result && !copy.final) copy.result = { status: copy.result.status || 'observed', truncated: true, message: 'The host result was too large to forward. Request a narrower observation, for example with browser_find.' };
  if (typeof copy.observation === 'string') copy.observation = '';
  if (JSON.stringify(copy).length > 150000) throw new Error('Invalid literature host result');
  return copy;
}
// Element references are valid only for the latest page observation. While
// browsing the library for retrieval, superseded snapshots are replaced by a
// short note so the conversation does not grow with pages the model cannot act on.
const SUPERSEDED = 'Earlier page observation omitted: its element references are no longer valid. Use the latest observation.';
function dropSupersededObservations(messages) {
  const observed = messages.filter(message => message.role === 'tool' && typeof message.content === 'string' && message.content.includes('"snapshot"'));
  for (const message of observed.slice(0, -1)) {
    let value; try { value = JSON.parse(message.content); } catch { continue; }
    const holder = value?.receipt && typeof value.receipt === 'object' ? value.receipt : value;
    if (typeof holder?.snapshot !== 'string' || holder.snapshot.length <= 1500) continue;
    holder.snapshot = SUPERSEDED;
    message.content = JSON.stringify(value);
  }
}
// The main agent needs each paper's outcome, not every attempted URL; the
// complete receipts stay in the host job file.
function compactRetrieval(final) {
  return { ...final, results: final.results.map(item => ({ ...item, attempts: item.attempts.slice(-4) })) };
}
function accept(state, response) {
  response = bounded(response);
  const driven = state.driver?.awaiting && !state.pendingModelCall ? state.driver.awaiting : null;
  if (driven) state.driver.awaiting = null;
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
      } else {
        state.final = contract.validate(contract.results[state.kind], response.final);
        if (state.kind === 'retrieve_papers') state.final = compactRetrieval(state.final);
      }
    }
    catch (error) { failure(state, error, 'finalization'); throw error; }
    state.pending = null; state.pendingModelCall = null; state.queuedCalls = [];
    delete state.pendingWebEvidence; delete state.pendingFingerprint; delete state.pendingId;
    return;
  }
  if (driven) {
    // Host steps of the deterministic retrieval sequence. Their receipts are
    // recorded for the driver and never enter the model conversation.
    const d = state.driver;
    if (response.tools) {
      if (!Array.isArray(response.tools) || response.tools.length > 40 || response.job_id !== state.jobId) throw new Error('Invalid specialist tools');
      state.schemas = response.tools;
    }
    if (driven.name === 'retrieve_next' && response.result?.status) d.outcomes[driven.args.index] = { status: response.result.status, reason: String(response.result.reason || '').slice(0, 300) };
    if (driven.name === 'request_access') {
      // A resumed job after the user acted: retry the papers that waited for access.
      if (response.tools) { d.retry = Object.entries(d.outcomes).filter(([, item]) => item.status === 'needs_login').map(([index]) => Number(index)); d.phase = 'retry'; }
      else d.phase = 'browse';
    }
    if (driven.name === 'start_browsing') { if (response.tools) enterBrowsing(state, response); else d.phase = 'finish'; }
    state.pending = null;
    delete state.pendingFingerprint; delete state.pendingId;
    return;
  }
  if (response.tools) {
    if (!Array.isArray(response.tools) || response.tools.length > 40 || !/^lit_[a-f0-9]{24}$/.test(response.job_id)) throw new Error('Invalid specialist tools');
    state.jobId = response.job_id; state.schemas = response.tools;
    state.openAccessOnly = response.access?.open_access_only === true;
    if (state.kind === 'retrieve_papers' && response.access?.deterministic === true && !state.driver) {
      state.driver = { phase: 'sequence', next: 0, outcomes: {}, rounds: 0, retry: [], awaiting: null };
      state.libraryBrowsing = response.access.library_browsing === true;
    }
    if (state.openAccessOnly && state.kind === 'discover_papers') state.messages.push({ role: 'system', content: 'The user continued without library access, so institutional browsing is disabled. Search public metadata sources broadly and prefer papers with open-access evidence, but do not omit strong candidates without it: mark their availability (retrieval checks open copies again). Disclose coverage limits.' });
    else if (response.access?.library_url) state.messages.push({ role: 'system', content: `The user selected this library URL in the application: ${JSON.stringify(response.access.library_url)}. Use it as the institutional entry point; it supersedes any library URL in the original delegated task.` });
  }
  if (state.pendingModelCall) {
    const receipt = response.result || response.error && { error: response.error, message: response.message, diagnostics: response.diagnostics } || response;
    state.messages.push({ role: 'tool', tool_call_id: state.pendingModelCall.id, content: JSON.stringify(state.pendingWebEvidence !== undefined ? { evidence: state.pendingWebEvidence, receipt } : receipt) });
    state.pendingModelCall = null;
    delete state.pendingWebEvidence;
  } else {
    // Schemas are supplied through native tools; only observations belong in
    // the initial/resumed handoff message. Access rules are recorded above.
    const content = response.tools ? { observation: response.observation ?? '' } : response;
    state.messages.push({ role: 'user', content: JSON.stringify(content) });
  }
  state.pending = null;
  // Retries of one pending handoff reuse its ID, but consecutive identical
  // model calls are distinct executions and must not reuse a cached receipt.
  delete state.pendingFingerprint; delete state.pendingId;
}
async function advance(state, { requestTurn, supportsWebSearch, search, onProgress = async () => {}, signal }) {
  if (state.blocked) return failure(state, state.blocked, 'browser');
  if (state.final || state.pending) return;
  if (state.driver && state.driver.phase !== 'model') {
    const next = driverStep(state);
    if (next) { await onProgress({ stage: 'literature-retrieval', capability: state.kind, step: next.name, ...(Number.isInteger(next.args.index) ? { paper: next.args.index + 1, papers: state.task.papers.length } : {}) }); state.pending = next; return; }
  }
  const finish = state.kind === 'discover_papers' ? 'finish_discovery' : 'finish_retrieval';
  let retryAfterMs;
  delete state.failure;
  while (true) {
    if (signal?.aborted) throw Object.assign(new Error('The request was cancelled.'), { code: 'OPERATION_ABORTED' });
    // Model-directed library browsing is bounded; receipts are host-generated, so finishing loses nothing saved.
    if (state.driver?.phase === 'model' && !state.queuedCalls?.length && state.driver.modelTurns >= RETRIEVAL_MODEL_TURNS) {
      state.driver.phase = 'finish';
      state.pending = driverStep(state); return;
    }
    const webTool = contract.tool('search_web', 'Search external scholarly metadata with the selected model; no downloading.', contract.object({ query: contract.text(2000) }));
    const tools = [...state.schemas, ...(supportsWebSearch && state.kind === 'discover_papers' ? [webTool] : [])];
    // The queue travels inside the continuation state. Drain it through one
    // host handoff at a time before asking the model for another decision.
    if (!state.queuedCalls?.length) {
      state.turns++;
      if (state.driver?.phase === 'model') { state.driver.modelTurns++; dropSupersededObservations(state.messages); }
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
        const quota = (state.kind === 'discover_papers' || state.driver?.phase === 'model') && inputQuota(turn);
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
      if (!calls.length) { state.messages.push(require('./requesty-tool-context.js').assistantMessage(turn, [])); failure(state, { code: 'INVALID_SPECIALIST_TOOL_CALL_COUNT', message: `Expected tool calls; received none. Finish with ${finish}.` }, 'tool-selection'); state.messages.push({ role: 'user', content: `Choose exposed functions; they execute in the supplied order. Finish through ${finish}; prose cannot establish retrieval.` }); continue; }
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
      state.messages.push(require('./requesty-tool-context.js').assistantMessage(turn, calls));
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
