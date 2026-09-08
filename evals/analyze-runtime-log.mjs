#!/usr/bin/env node
// Read-only analysis of copied, sanitized runtime logs. No application imports.
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const countBy = (values) => values.reduce((result, key) => {
  result[key] = (result[key] || 0) + 1; return result;
}, {});
const sum = (values) => values.reduce((total, value) => total + value, 0);
const millis = (value) => value ? Date.parse(value) : NaN;
const delta = (later, earlier) => Number.isFinite(millis(later) - millis(earlier)) ? millis(later) - millis(earlier) : null;
const ref = (event) => event ? { timestamp: event.timestamp, event: event.name, sources: event.sources } : null;
const knownRoles = ['semantic_parser', 'schema_mapper', 'search_planner', 'reranker', 'corpus_mapper', 'native_pdf', 'combined_text_paper_card', 'image_understanding'];

function stats(input) {
  const values = input.filter(Number.isFinite).sort((a, b) => a - b), n = values.length;
  return n ? { n, min: values[0], median: n % 2 ? values[(n - 1) / 2] : (values[n / 2 - 1] + values[n / 2]) / 2,
    mean: sum(values) / n, p95NearestRank: values[Math.ceil(n * 0.95) - 1], max: values[n - 1] } : { n: 0 };
}

export async function parseRuntimeLogs(files) {
  const exactEvents = new Map(), inputs = [], malformedEventLines = [];
  let rawEventOccurrences = 0;
  for (const file of files) {
    const text = await fs.readFile(file, 'utf8'), lines = text.split(/\r?\n/);
    let eventLines = 0;
    for (let i = 0; i < lines.length; i++) {
      const raw = lines[i].trim();
      const match = raw.match(/^(\d{4}-\d\d-\d\dT\S+)\s+(INFO|WARN|ERROR|DEBUG)\s+(\S+)(?:\s+(\{.*\}))?$/);
      if (!match) continue;
      try {
        const data = match[4] ? JSON.parse(match[4]) : {};
        if (!Number.isFinite(millis(match[1])) || !data || Array.isArray(data) || typeof data !== 'object') throw new Error('Invalid timestamp or details object');
        const source = { file: path.resolve(file), line: i + 1 };
        eventLines++; rawEventOccurrences++;
        if (exactEvents.has(raw)) exactEvents.get(raw).sources.push(source);
        else exactEvents.set(raw, { timestamp: match[1], level: match[2], name: match[3], data, sources: [source] });
      } catch (error) { malformedEventLines.push({ file: path.resolve(file), line: i + 1, error: error.message }); }
    }
    inputs.push({ file: path.resolve(file), sha256: createHash('sha256').update(text).digest('hex'), lines: lines.length,
      eventOccurrences: eventLines, ignoredNonEventLines: lines.length - eventLines });
  }
  const events = [...exactEvents.values()].sort((a, b) => millis(a.timestamp) - millis(b.timestamp));
  return { inputs, rawEventOccurrences, deduplicatedExactEvents: rawEventOccurrences - events.length,
    uniqueEventCount: events.length, malformedEventLines, events };
}

function operations(events, prefix) {
  const selected = events.filter((event) => event.name.startsWith(`${prefix}.`));
  const groups = new Map();
  for (const event of selected) {
    if (!/\.(started|completed|failed|cancelled|partial)$/.test(event.name)) continue;
    const key = event.data.operationId || `unidentified:${event.timestamp}:${event.name}:${event.sources[0].line}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(event);
  }
  return [...groups.entries()].map(([operationId, entries]) => {
    const starts = entries.filter((event) => event.name.endsWith('.started'));
    const ends = entries.filter((event) => !event.name.endsWith('.started'));
    const start = starts[0], end = ends.at(-1), data = { ...start?.data, ...end?.data };
    return { operationId, start, end, data, startEventCount: starts.length, terminalEventCount: ends.length,
      outcome: end?.name.split('.').at(-1) || 'incomplete',
      startTimestamp: start?.timestamp || null, endTimestamp: end?.timestamp || null };
  });
}

function summarizeOperations(ops) {
  const started = ops.filter((op) => op.start), terminal = ops.filter((op) => op.end);
  const reported = terminal.filter((op) => Number.isFinite(op.data.providerAttempts));
  return { started: started.length, completed: ops.filter((op) => op.outcome === 'completed').length,
    failed: ops.filter((op) => op.outcome === 'failed').length, cancelled: ops.filter((op) => op.outcome === 'cancelled').length,
    incomplete: ops.filter((op) => !op.end).length, terminalWithoutStart: ops.filter((op) => !op.start).length,
    duplicateStartOrTerminalOperations: ops.filter((op) => op.startEventCount > 1 || op.terminalEventCount > 1).map((op) => op.operationId),
    httpStatusCounts: countBy(terminal.map((op) => String(op.data.status ?? 'not_logged'))),
    attemptsGreaterThanOne: started.filter((op) => Number(op.data.attempt) > 1).length,
    attemptFieldCounts: countBy(started.map((op) => String(op.data.attempt ?? 'not_logged'))),
    reportedProviderAttempts: { sum: sum(reported.map((op) => op.data.providerAttempts)), operationsReporting: reported.length,
      operationsWithoutField: terminal.length - reported.length, verifiedUpstreamAttempts: null,
      caveat: 'These are client-log fields, not independently verified provider requests. Missing response.attempts can be defaulted to zero by the client.' },
    durationMs: stats(terminal.map((op) => op.data.durationMs)) };
}

function groupedOperations(ops) {
  const groups = new Map();
  for (const op of ops) {
    const key = `${op.data.role || 'unlabeled'} ${op.data.endpoint || 'not_logged'}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(op);
  }
  return [...groups.entries()].map(([key, members]) => ({ key, role: members[0].data.role || null,
    endpoint: members[0].data.endpoint || null, ...summarizeOperations(members) }));
}

async function observationsFrom(directory) {
  if (!directory) return [];
  const files = (await fs.readdir(directory)).filter((name) => /^\d{2,}-.*\.json$/.test(name)).sort();
  const result = [];
  for (const file of files) {
    const value = JSON.parse(await fs.readFile(path.join(directory, file), 'utf8'));
    const messages = value.actual?.storedConversation?.messages || [];
    const user = messages.filter((message) => message.role === 'user').at(-1);
    const assistant = user && messages.slice(messages.indexOf(user) + 1).find((message) => message.role === 'assistant');
    if (user) result.push({ file: path.resolve(directory, file), caseId: value.caseId, repeat: value.repeat,
      cacheState: value.cacheState || value.timing?.cacheState || 'unknown', turnId: user.id, userTimestamp: user.createdAt,
      assistantTimestamp: assistant?.createdAt || null, savedTiming: value.timing || null,
      savedCloudCalls: value.telemetry?.cloudCalls || user.context?.semanticTelemetry?.cloudCalls || null });
  }
  return result;
}

export async function analyzeRuntimeLogs(files, observationDirectory) {
  const parsed = await parseRuntimeLogs(files), { events } = parsed;
  const observations = await observationsFrom(observationDirectory);
  const backend = operations(events, 'backend-request'), mainAll = operations(events, 'main-agent');
  const main = mainAll.filter((op) => op.data.endpoint === '/chat');
  const context = operations(events, 'request-context'), preflights = operations(events, 'preflight');
  const syncRuns = operations(events, 'sync-agent');
  const enclosed = (at, op) => op.start && op.end && millis(at) >= millis(op.start.timestamp) && millis(at) <= millis(op.end.timestamp);
  const syncRunLinks = syncRuns.map((run) => {
    const parents = preflights.filter((op) => enclosed(run.startTimestamp, op));
    return { runId: run.data.runId, turnId: parents.length === 1 ? parents[0].data.turnId : null,
      attribution: parents.length === 1 ? 'inferred_unique_enclosing_preflight_interval' : 'unresolved',
      start: ref(run.start), end: ref(run.end) };
  });
  const knownTurns = new Set(context.map((op) => op.data.turnId).filter(Boolean));
  for (const op of backend) {
    if (knownTurns.has(op.data.turnId)) op.attribution = { turnId: op.data.turnId, method: 'explicit_turn_id' };
    else {
      const run = syncRunLinks.find((link) => link.runId === op.data.turnId && link.turnId);
      const enclosingContexts = context.filter((item) => enclosed(op.startTimestamp, item));
      op.attribution = run ? { turnId: run.turnId, method: 'explicit_sync_run_id_with_inferred_parent', syncRunId: run.runId }
        : enclosingContexts.length === 1 ? { turnId: enclosingContexts[0].data.turnId, method: 'inferred_unique_enclosing_request_context_interval' }
          : { turnId: null, method: 'unresolved' };
    }
  }
  const turns = context.map((ctx) => {
    const turnId = ctx.data.turnId, observation = observations.find((item) => item.turnId === turnId) || null;
    const preflight = preflights.find((op) => op.data.turnId === turnId), chat = main.filter((op) => op.data.turnId === turnId);
    const requests = backend.filter((op) => op.attribution.turnId === turnId);
    const streamEvent = events.find((event) => event.data.turnId === turnId && ['main-agent.first-token', 'main-agent.buffered-response'].includes(event.name));
    const observedRoles = countBy(requests.filter((op) => op.start).map((op) => op.data.role || 'unlabeled'));
    const comparison = knownRoles.map((role) => ({ role, observedClientTransportAttempts: observedRoles[role] || 0,
      savedLogicalCalls: observation?.savedCloudCalls?.[role] ?? null,
      differenceObservedMinusSaved: Number.isFinite(observation?.savedCloudCalls?.[role]) ? (observedRoles[role] || 0) - observation.savedCloudCalls[role] : null }));
    return { turnId, observation, backend: { ...summarizeOperations(requests), roleCounts: observedRoles,
        attributionCounts: countBy(requests.map((op) => op.attribution.method)) },
      mainChat: summarizeOperations(chat), preflight: preflight ? { ...preflight.data, start: ref(preflight.start), end: ref(preflight.end) } : null,
      timing: { userToContextStartMs: delta(ctx.startTimestamp, observation?.userTimestamp),
        requestContextDurationMs: ctx.data.durationMs ?? null, preflightDurationMs: preflight?.data.durationMs ?? null,
        preflightRecordedMainAgentStartMs: preflight?.data.mainAgentStartMs ?? null,
        userToActualMainAgentStartMs: delta(chat[0]?.startTimestamp, observation?.userTimestamp),
        contextStartToActualMainAgentStartMs: delta(chat[0]?.startTimestamp, ctx.startTimestamp),
        mainAgentDurationMs: chat.length === 1 ? chat[0].data.durationMs ?? null : null,
        responseMode: streamEvent?.name === 'main-agent.first-token' ? 'streaming_delta_observed' : streamEvent ? 'buffered_response' : 'not_observed',
        userToFirstResponseEventMs: delta(streamEvent?.timestamp, observation?.userTimestamp),
        mainAgentStartToFirstResponseEventMs: delta(streamEvent?.timestamp, chat[0]?.startTimestamp),
        timeToFirstVisibleMs: null,
        firstResponseCaveat: 'Response-event timing is a client logging timestamp, not measured screen rendering or network first-byte latency. Buffered response is not streaming TTFT.',
        persistedUserToAssistantMs: delta(observation?.assistantTimestamp, observation?.userTimestamp),
        persistedLatencyMatchesSaved: observation?.savedTiming?.latencyMs === delta(observation?.assistantTimestamp, observation?.userTimestamp),
        firstResponseEvent: ref(streamEvent), contextStart: ref(ctx.start), contextEnd: ref(ctx.end), mainStart: ref(chat[0]?.start), mainEnd: ref(chat[0]?.end) },
      counterComparison: { roles: comparison, mismatches: comparison.filter((item) => item.differenceObservedMinusSaved !== null && item.differenceObservedMinusSaved !== 0),
        answer: { observedClientChatRequests: chat.filter((op) => op.start).length, savedAnswerLogicalSteps: observation?.savedCloudCalls?.answer ?? null,
          comparable: false, explanation: 'Saved answer counter can count backend agent model-loop steps; one /chat request can contain several. Do not add this number to client HTTP attempts.' } } };
  });
  const matched = turns.filter((turn) => turn.observation), savedTotals = {};
  for (const turn of matched) for (const [role, n] of Object.entries(turn.observation.savedCloudCalls || {})) if (Number.isFinite(n)) savedTotals[role] = (savedTotals[role] || 0) + n;
  const backendChat = backend.filter((op) => op.data.endpoint === '/chat');
  const auxiliary = backend.filter((op) => op.data.endpoint !== '/chat');
  const failureGroups = new Map();
  for (const op of backend.filter((item) => item.outcome === 'failed')) {
    const key = `${op.data.status ?? 'unknown'} ${op.data.code || 'unknown'} ${op.data.role || 'unlabeled'}`;
    if (!failureGroups.has(key)) failureGroups.set(key, []);
    failureGroups.get(key).push(op);
  }
  const { events: _events, ...inputSummary } = parsed;
  return { schemaVersion: 1, generatedAt: new Date().toISOString(), ...inputSummary,
    logWindow: { first: events[0]?.timestamp || null, last: events.at(-1)?.timestamp || null, appReadyPresent: events.some((event) => event.name === 'app.ready') },
    eventHistogram: countBy(events.map((event) => event.name)),
    accountingDefinitions: { backendRequest: 'One distinct backend-request.started operation is one observed client transport attempt. Waiting events are not calls.',
      mainAgent: 'main-agent.started /chat operations are tracked separately from auxiliary backend requests.',
      logicalCounts: 'Saved telemetry records logical endpoint roles and backend answer-model steps, not uniformly client attempts.',
      deduplication: 'Identical trimmed timestamp + level + event + JSON lines are deduplicated across supplied files; references to every occurrence remain.',
      attribution: 'User message ID joins saved turns exactly. Missing IDs are assigned only to a unique enclosing context/preflight interval and explicitly marked inferred.' },
    backendRequests: { ...summarizeOperations(backend), byRoleEndpoint: groupedOperations(backend),
      failures: [...failureGroups.entries()].map(([key, ops]) => ({ key, count: ops.length, operationIds: ops.map((op) => op.operationId),
        reportedProviderAttempts: sum(ops.map((op) => Number(op.data.providerAttempts) || 0)), verifiedUpstreamAttempts: null })),
      operations: backend.map((op) => ({ operationId: op.operationId, ...op.data, outcome: op.outcome, attribution: op.attribution, start: ref(op.start), end: ref(op.end) })) },
    mainChatRequests: { ...summarizeOperations(main), bufferedResponses: events.filter((event) => event.name === 'main-agent.buffered-response').length,
      firstTokenEvents: events.filter((event) => event.name === 'main-agent.first-token').length,
      operations: main.map((op) => ({ operationId: op.operationId, ...op.data, outcome: op.outcome, start: ref(op.start), end: ref(op.end) })) },
    combinedClientRequests: { observedAuxiliaryStarts: auxiliary.filter((op) => op.start).length, observedMainChatStarts: main.filter((op) => op.start).length,
      totalStarts: backendChat.length === 0 ? auxiliary.filter((op) => op.start).length + main.filter((op) => op.start).length : null,
      ambiguousBackendChatOperations: backendChat.map((op) => op.operationId),
      rule: 'Sum only auxiliary and separately instrumented main /chat requests. If backend-request also logs /chat, leave combined total unknown rather than double-count.' },
    savedTelemetryTotals: { roles: savedTotals, answerCountUnit: 'backend model-loop steps, not HTTP requests',
      mismatches: turns.flatMap((turn) => turn.counterComparison.mismatches.map((item) => ({ turnId: turn.turnId, caseId: turn.observation?.caseId, ...item }))) },
    syncRunLinks, turns, unmatchedObservationFiles: observations.filter((item) => !knownTurns.has(item.turnId)).map((item) => item.file),
    timingByCacheState: [...new Set(matched.map((turn) => turn.observation.cacheState))].map((cacheState) => {
      const group = matched.filter((turn) => turn.observation.cacheState === cacheState);
      return { cacheState, n: group.length, preflightMs: stats(group.map((turn) => turn.timing.preflightDurationMs)),
        userToMainStartMs: stats(group.map((turn) => turn.timing.userToActualMainAgentStartMs)),
        firstResponseEventMs: stats(group.map((turn) => turn.timing.userToFirstResponseEventMs)),
        persistedLatencyMs: stats(group.map((turn) => turn.timing.persistedUserToAssistantMs)),
        caveat: 'Different sequential queries share warming state; cache-group summaries are descriptive, not paired causal speedup estimates.' };
    }),
    tokensAndCost: { actualInputTokens: null, actualOutputTokens: null, usdCost: null, verifiedRequestyUpstreamAttempts: null,
      reason: 'Sanitized client runtime telemetry does not establish token usage, upstream retries, deployed provider configuration or price. No inference from characters, durations or logical counts.' },
    implementationInterpretationAfterLogScoring: [
      { finding: 'Backend request operation is started per transport attempt; per-turn logical count is incremented before the retry loop. Semantic endpoints allow one client attempt.', sources: ['docs/literature-module.js:1007-1028'] },
      { finding: 'Missing response.attempts is converted to zero. Semantic failure responses omit attempts, so logged zero cannot prove no provider request. Unsupported strict-schema configuration is one possible local-code cause, but unavailable codes also hide other failures; deployed reason is unverified.', sources: ['docs/literature-module.js:1043-1060', 'alibaba-fc/index.js:3720-3750', 'alibaba-fc/index.js:3775', 'alibaba-fc/index.js:3805'] },
      { finding: 'Sync uses its own run ID for call accounting. Persisted user telemetry reads only the user message ID; cold card and sync-schema calls can be absent there.', sources: ['docs/request-pipeline.js:224', 'docs/request-pipeline.js:353-357', 'docs/app.js:4802-4805'] },
      { finding: 'Per-turn recorder drops calls without a valid turn ID. Planner/reranker events with missing turnId must remain explicitly inferred by timing when attributed to observations.', sources: ['docs/literature-module.js:855-866', 'docs/literature-module.js:1015'] },
      { finding: 'Backend answer telemetry overwrites the client answer counter with model-loop steps. The saved answer count and /chat count have different units.', sources: ['docs/app.js:3580-3588', 'docs/app.js:4805', 'alibaba-fc/side-chat-agent.js:1924-1926', 'alibaba-fc/side-chat-agent.js:1946-1948'] },
      { finding: 'outputLength counts streaming deltas only, so zero with buffered-response does not mean an empty answer. First response event does not measure actual DOM visibility.', sources: ['docs/app.js:3593-3612'] },
      { finding: 'Preflight mainAgentStartMs is stamped at preflight completion, before remaining context work and main-agent.started. It is not actual time to the /chat request.', sources: ['docs/request-pipeline.js:362-367', 'docs/app.js:3581-3588'] },
      { finding: 'Logger defaults to a 1000-event ring; subsequent parts can overlap or omit earlier events. Read all available parts and deduplicate exact entries; app.ready absence is a completeness warning.', sources: ['docs/runtime-log.js:39-49', 'docs/runtime-log.js:63-68'] }
    ],
    limitations: ['Local source inspection explains possible instrumentation behavior; the deployed FC revision is not attested by these logs.',
      'A preflight failureCount of zero measures its sync report; it does not cancel or invalidate separately logged optional mapper/semantic HTTP failures.',
      'Buffered-response is response availability in client code, not streaming TTFT or observed time-to-first-visible.',
      'No application, Electron, network request or production mutation is performed by this analyzer.'] };
}

async function main() {
  const args = process.argv.slice(2), files = []; let output, observations;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--help') { console.log('Usage: node evals/analyze-runtime-log.mjs --output FILE [--observations DIR] PART1.txt [PART2.txt ...]'); return; }
    if (args[i] === '--output') output = args[++i];
    else if (args[i] === '--observations') observations = args[++i];
    else if (args[i].startsWith('--')) throw new Error(`Unknown option: ${args[i]}`);
    else files.push(args[i]);
  }
  if (!files.length || !output) throw new Error('Provide log parts and --output FILE.');
  const result = await analyzeRuntimeLogs(files, observations || path.dirname(files[0]));
  await fs.mkdir(path.dirname(path.resolve(output)), { recursive: true });
  await fs.writeFile(output, `${JSON.stringify(result, null, 2)}\n`, { flag: 'wx' });
  console.log(JSON.stringify({ output, uniqueEvents: result.uniqueEventCount, deduplicated: result.deduplicatedExactEvents,
    backendStarted: result.backendRequests.started, backendFailed: result.backendRequests.failed,
    mainChatStarted: result.mainChatRequests.started, combinedClientStarts: result.combinedClientRequests.totalStarts,
    matchedTurns: result.turns.filter((turn) => turn.observation).length }));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
