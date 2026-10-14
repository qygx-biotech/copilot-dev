import crypto from "node:crypto";
import { createRequire } from "node:module";
import { callModelTurn, fetchModelCapabilities } from "./model-proxy-client.mjs";

const require = createRequire(import.meta.url);
const { runLocalAgentTurn } = require("../../shared/agent/local-driver.js");

// Message handling for the agent loop process, independent of the Electron
// transport so it can be tested directly. It runs the shared agent loop
// (shared/agent/local-driver.js); models are reached only through the FC proxy.
//
// Inbound (from main):  start, cancel, steer, inject, boundary-reply, close
// Outbound (to main):   event, boundary, done, closed
//
// At each step boundary (host tools, runtime checkpoints) the loop posts the
// step's data and waits; the renderer acts exactly as it does for an FC
// response and replies. The process never touches project sources; it writes
// only context archives under the archive root main supplies.

const MAX_QUEUED_INJECTIONS = 16;

function failure(error) {
  const code = /^[A-Za-z0-9_]{1,100}$/.test(String(error?.code || "")) ? error.code : "AGENT_TURN_FAILED";
  const details = {};
  for (const key of ["status", "origin", "capability", "retryAfterMs", "cap", "used"]) if (error?.[key] !== undefined) details[key] = error[key];
  return { code, message: String(error?.message || "The agent turn failed.").slice(0, 500), ...details };
}

const aborted = () => Object.assign(new Error("The agent turn was cancelled."), { code: "OPERATION_ABORTED" });

export function createAgentLoopHost({ post, fetchImpl = globalThis.fetch, runTurn = runLocalAgentTurn }) {
  const turns = new Map();

  const emit = (turn, event) => post({ type: "event", turnId: turn.id, event });

  function awaitBoundary(turn, data) {
    if (turn.controller.signal.aborted) return Promise.reject(aborted());
    const boundaryId = crypto.randomUUID();
    return new Promise((resolve, reject) => {
      turn.boundary = { id: boundaryId, resolve, reject };
      post({ type: "boundary", turnId: turn.id, boundaryId, data });
    });
  }

  // Steering sent while the model works enters at the next boundary, through
  // the same runtime-injection admission FC applies to re-posted requests.
  function withQueued(turn, reply) {
    if (!reply || !turn.injections.length) return reply;
    const known = new Set((reply.runtimeInjections || []).map(item => item.id));
    const queued = turn.injections.filter(item => !known.has(item.id));
    turn.injections = [];
    return { ...reply, runtimeInjections: [...(reply.runtimeInjections || []), ...queued] };
  }

  async function start(message) {
    if (turns.has(message.turnId)) {
      post({ type: "done", turnId: message.turnId, ok: false, error: { code: "TURN_ALREADY_RUNNING", message: "This turn is already running." } });
      return;
    }
    const turn = { id: message.turnId, controller: new AbortController(), boundary: null, injections: [],
      steerable: Boolean(message.body?.runtimeExtensions) };
    turns.set(turn.id, turn);
    const signal = turn.controller.signal;
    const { body, token, baseUrl } = message;
    try {
      const capabilities = await fetchModelCapabilities({ baseUrl, token, signal, fetchImpl, request: {
        ...(typeof body?.model === "string" ? { model: body.model } : {}),
        surface: body?.mode === "side_chat" ? "side_chat" : "agent_command" } });
      const result = await runTurn({ body, capabilities, signal, archiveRoot: message.archiveRoot,
        callModel: options => callModelTurn({ baseUrl, token, fetchImpl, ...options }),
        emit: async event => emit(turn, event),
        boundary: async data => withQueued(turn, await awaitBoundary(turn, data)) });
      if (signal.aborted) throw aborted();
      post({ type: "done", turnId: turn.id, ok: true, result });
    } catch (error) {
      post({ type: "done", turnId: turn.id, ok: false, error: failure(signal.aborted ? aborted() : error) });
    } finally {
      turns.delete(turn.id);
    }
  }

  function cancel(turnId) {
    const turn = turns.get(turnId);
    if (!turn || turn.controller.signal.aborted) return;
    turn.controller.abort();
    turn.boundary?.reject(aborted());
    turn.boundary = null;
  }

  function queue(message) {
    const turn = turns.get(message.turnId);
    if (!turn || turn.controller.signal.aborted) return;
    if (!turn.steerable) {
      emit(turn, { type: "injection-rejected", id: message.item.id, code: "STEERING_UNAVAILABLE" });
      return;
    }
    if (turn.injections.some(item => item.id === message.item.id) || turn.injections.length >= MAX_QUEUED_INJECTIONS) return;
    turn.injections.push(message.item);
    emit(turn, { type: "injection-queued", id: message.item.id, kind: message.item.kind });
  }

  function boundaryReply(message) {
    const turn = turns.get(message.turnId);
    if (!turn?.boundary || turn.boundary.id !== message.boundaryId) return;
    const { resolve } = turn.boundary;
    turn.boundary = null;
    resolve(message.reply ?? null);
  }

  function handle(message) {
    if (!message || typeof message.type !== "string") return;
    if (message.type === "start") void start(message);
    else if (message.type === "cancel") cancel(message.turnId);
    else if (message.type === "steer" || message.type === "inject") queue(message);
    else if (message.type === "boundary-reply") boundaryReply(message);
    else if (message.type === "close") {
      for (const turnId of [...turns.keys()]) cancel(turnId);
      post({ type: "closed" });
    }
  }

  return { handle, activeTurns: () => [...turns.keys()] };
}
