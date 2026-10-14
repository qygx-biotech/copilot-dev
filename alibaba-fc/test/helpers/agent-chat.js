'use strict';
// Tests of agent behaviour that were written against the former FC /chat
// exchange run on the desktop agent loop through this adapter. A /chat request
// starts a turn in the real loop host (desktop/workers/agent-loop-host.mjs),
// which reaches the in-process FC model proxy over a loopback HTTP server with
// the real desktop proxy client. A step boundary is returned as a 200 response
// carrying an opaque `boundary` handle; posting that handle with the host's
// `desktopToolResults` (and runtime input or a refreshed localWorkspaceContext)
// resumes the same turn. Every other route goes to the FC handler unchanged.
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const backend = require('../../index.js');
const { loopbackFetch, proxyUrl } = require('./model-proxy.js');

const STREAM_EVENTS = new Set(['delta', 'reset', 'status', 'sources', 'transcript']);
let host = null, archiveRoot = null, sequence = 0;
const turns = new Map(), handles = new Map();

function deliver(message) {
  const turn = turns.get(message.turnId);
  if (!turn) return;
  if (message.type === 'event') {
    const { type, ...data } = message.event || {};
    if (STREAM_EVENTS.has(type)) turn.events.push(begin(turn).then(() => turn.transport?.emit?.(type, data)));
  } else if (message.type === 'boundary') {
    const handle = `boundary-${++sequence}`;
    handles.set(handle, { turn, boundaryId: message.boundaryId });
    turn.settle({ statusCode: 200, data: { ...message.data, boundary: handle } });
  } else if (message.type === 'done') {
    turns.delete(message.turnId);
    if (message.ok) turn.settle({ statusCode: 200, data: message.result });
    else {
      const { code, message: text, status } = message.error;
      turn.settle(code === 'OPERATION_ABORTED' ? { statusCode: 500, data: { error: 'Internal server error' } }
        : { statusCode: Number.isInteger(status) && status >= 400 ? status : 500, data: { error: code, message: text } });
    }
  }
}

function loopHost() {
  host ||= import('../../../desktop/workers/agent-loop-host.mjs').then(({ createAgentLoopHost }) =>
    // Messages cross the loop-process boundary as structured clones.
    createAgentLoopHost({ fetchImpl: loopbackFetch, post: message => setImmediate(() => deliver(structuredClone(message))) }));
  return host;
}

function defaultArchiveRoot() {
  if (process.env.CONTEXT_ARCHIVE_DIR) return process.env.CONTEXT_ARCHIVE_DIR;
  if (!archiveRoot) {
    archiveRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'biodesign-agent-chat-'));
    process.once('exit', () => fs.rmSync(archiveRoot, { recursive: true, force: true }));
  }
  return archiveRoot;
}

const respond = ({ statusCode, data }) => ({ statusCode, headers: { 'content-type': 'application/json' }, body: JSON.stringify(data) });

// A streaming exchange starts its transport once the request is admitted: at
// its first stream event, or with a successful outcome.
const begin = turn => turn.started ||= Promise.resolve(turn.stream && typeof turn.transport?.start === 'function' ? turn.transport.start({}) : undefined);

// Runs until the turn's next boundary or its end, delivering stream events to
// `transport` (an object with emit(event, data) and optionally start()).
async function exchange(turn, transport, act) {
  turn.transport = transport; turn.started = null;
  const outcome = new Promise(resolve => { turn.settle = resolve; });
  const cancel = () => loopHost().then(h => h.handle({ type: 'cancel', turnId: turn.id }));
  transport?.signal?.addEventListener('abort', cancel, { once: true });
  try {
    await act();
    const result = await outcome;
    if (result.statusCode === 200) await begin(turn);
    await Promise.all(turn.events.splice(0));
    return respond(result);
  } finally { transport?.signal?.removeEventListener('abort', cancel); }
}

async function post(body, token, transport = null) {
  if (body?.boundary !== undefined) {
    const pending = handles.get(body.boundary);
    if (!pending) return respond({ statusCode: 400, data: { error: 'INVALID_TOOL_CONTINUATION', message: 'No step boundary matches this handle.' } });
    handles.delete(body.boundary);
    const reply = { desktopToolResults: body.desktopToolResults || [], runtimeInjections: body.runtimeInjections || [],
      runtimeRevokedTools: body.runtimeRevokedTools || [], ...(body.localWorkspaceContext !== undefined ? { localWorkspaceContext: body.localWorkspaceContext } : {}) };
    const h = await loopHost();
    return exchange(pending.turn, transport, () => h.handle({ type: 'boundary-reply', turnId: pending.turn.id, boundaryId: pending.boundaryId, reply }));
  }
  const { stream: _stream, timingRequestId: _timing, ...loopBody } = body || {};
  const turn = { id: `chat-${++sequence}`, events: [], stream: body?.stream === true };
  turns.set(turn.id, turn);
  const [h, baseUrl] = await Promise.all([loopHost(), proxyUrl()]);
  return exchange(turn, transport, () => h.handle({ type: 'start', turnId: turn.id, token, baseUrl, body: loopBody, archiveRoot: defaultArchiveRoot() }));
}

// A drop-in for the FC handler in tests: /chat runs on the agent loop.
async function handler(event, context = {}, transport = null) {
  const route = event?.path || event?.rawPath || event?.requestContext?.http?.path;
  if (route !== '/chat') return backend.handler(event, context, transport);
  const headers = Object.fromEntries(Object.entries(event.headers || {}).map(([key, value]) => [key.toLowerCase(), value]));
  const token = String(headers.authorization || '').replace(/^Bearer\s+/i, '');
  let body;
  try { body = typeof event.body === 'string' ? JSON.parse(event.body || '{}') : event.body || {}; }
  catch { return respond({ statusCode: 400, data: { error: 'INVALID_JSON' } }); }
  return post(body, token, transport);
}

module.exports = { handler, post };
