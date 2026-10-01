"use strict";
const { AsyncLocalStorage } = require("node:async_hooks");
const { performance } = require("node:perf_hooks");
const { randomUUID } = require("node:crypto");
const storage = new AsyncLocalStorage();
const uuid = value => typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value) ? value : null;
const enabled = () => process.env.CHAT_TIMING_DEBUG === "1" || process.env.CONTEXT_DEBUG === "1";
const numeric = new Set(["status", "attempt", "requestBytes", "responseBytes", "imageCount", "estimatedTokens", "outputReserve", "processUptimeMs"]);
function metadata(fields = {}) {
  return { ...Object.fromEntries(Object.entries(fields).filter(([key, value]) => numeric.has(key) && Number.isFinite(value) ||
    ["stage", "callStage", "outcome", "transport"].includes(key) && typeof value === "string" && /^[a-z0-9_-]{1,64}$/i.test(value))),
    // Same fixed exception allowlist as returned error diagnostics.
    ...require("./requesty-response.js").fetchExceptionFields(fields) };
}
function create({ requestId, now = () => performance.now(), logger = console } = {}) {
  const started = now(), events = []; let active = false, droppedEvents = 0;
  const trace = {
    requestId: uuid(requestId) || randomUUID(),
    activate() { active = true; },
    mark(stage, fields = {}, durationMs) {
      if (!active) return;
      const event = { stage, elapsedMs: Math.max(0, now() - started), ...metadata(fields),
        ...(Number.isFinite(durationMs) ? { durationMs: Math.max(0, durationMs) } : {}) };
      if (events.length < 256) events.push(event); else droppedEvents++;
      try { logger.info("chat_timing", { requestId: trace.requestId, ...(trace.clientRequestId ? { clientRequestId: trace.clientRequestId } : {}), ...event }); } catch { /* Diagnostics cannot interrupt requests. */ }
    },
    start(stage, fields) {
      const start = now(); trace.mark(stage + "_start", fields); let finished = false;
      return (result = {}) => { if (!finished) { finished = true; trace.mark(stage + "_end", { ...fields, ...result }, now() - start); } };
    },
    snapshot() { return { version: 1, requestId: trace.requestId, clientRequestId: trace.clientRequestId, handlerMs: Math.max(0, now() - started), droppedEvents, events: events.slice() }; },
    get active() { return active; },
  };
  return trace;
}
const current = () => storage.getStore();
const mark = (...args) => current()?.mark(...args);
const start = (...args) => current()?.start(...args) || (() => {});
async function measure(stage, work, fields) {
  const end = start(stage, fields);
  try { const value = await work(); end({ outcome: "completed" }); return value; }
  catch (error) { end({ outcome: error?.code === "OPERATION_ABORTED" || error?.name === "AbortError" ? "cancelled" : "failed" }); throw error; }
}
module.exports = { create, current, mark, start, measure, enabled, uuid, run: (trace, work) => storage.run(trace, work) };
