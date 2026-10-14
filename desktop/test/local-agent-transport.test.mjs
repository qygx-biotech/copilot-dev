import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { test } from "node:test";

const require = createRequire(import.meta.url);
const transport = require("../../docs/local-agent-transport.js");

// A scripted stand-in for window.biodesignDesktop.agent.
function fakeAgent() {
  const listeners = new Set(), calls = [];
  let finish;
  const agent = {
    calls,
    start: async payload => { calls.push(["start", payload]); return new Promise((resolve, reject) => { finish = { resolve, reject }; }); },
    respond: async payload => { calls.push(["respond", payload]); return { accepted: true }; },
    cancel: async payload => { calls.push(["cancel", payload]); return { cancelled: true }; },
    onEvent: listener => { listeners.add(listener); return () => listeners.delete(listener); },
    emit: payload => { for (const listener of listeners) listener(payload); },
    listeners,
    finish: value => finish.resolve(value),
    fail: error => finish.reject(error),
  };
  return agent;
}
const body = { mode: "side_chat", messages: [{ role: "user", content: "Hi" }], localWorkspaceContext: { agentLoop: { version: 1 } } };
const tick = () => new Promise(resolve => setImmediate(resolve));

test("stream events are handled in order before the boundary they precede is returned", async () => {
  const agent = fakeAgent(), handled = [];
  const session = transport.startSession({ agent, turnId: "turn-1", token: "a.b.c", body });
  assert.deepEqual(agent.calls[0][1].body, body);
  const first = session.first(async event => { await tick(); handled.push(event.type); });
  agent.emit({ turnId: "turn-1", event: { type: "status", stage: "model-request" } });
  agent.emit({ turnId: "other-turn", event: { type: "delta", text: "not mine" } });
  agent.emit({ turnId: "turn-1", event: { type: "delta", text: "Hel" } });
  agent.emit({ turnId: "turn-1", event: { type: "injection-queued", id: "s1" } });
  agent.emit({ turnId: "turn-1", event: { type: "boundary", boundaryId: "b1", data: { desktopToolCalls: [{ id: "c1" }] } } });
  assert.deepEqual((await first).desktopToolCalls, [{ id: "c1" }]);
  assert.equal(session.atBoundary(), true, "The exchange ended at a step boundary");
  assert.deepEqual(handled, ["status", "delta"], "Other turns and non-stream events are not handled");
  const second = session.next({ desktopToolResults: [{ id: "c1" }] }, async event => handled.push(event.type));
  assert.deepEqual(agent.calls.at(-1), ["respond", { turnId: "turn-1", boundaryId: "b1", reply: { desktopToolResults: [{ id: "c1" }] } }]);
  agent.emit({ turnId: "turn-1", event: { type: "delta", text: "lo" } });
  agent.finish({ reply: "Hello" });
  assert.deepEqual(await second, { reply: "Hello" });
  assert.equal(session.atBoundary(), false, "The turn ended");
  assert.deepEqual(handled.at(-1), "delta");
  await assert.rejects(session.next({}, () => {}), { code: "INVALID_TOOL_CONTINUATION" }, "No boundary is pending after the end");
  await session.close();
  assert.equal(agent.listeners.size, 0);
});

test("closing at a boundary ends the turn; a failed exchange cancels it; failures reach the waiting exchange", async () => {
  const stopped = fakeAgent();
  const session = transport.startSession({ agent: stopped, turnId: "turn-1", token: "a.b.c", body });
  const first = session.first(() => {});
  stopped.emit({ turnId: "turn-1", event: { type: "boundary", boundaryId: "b1", data: { agentCheckpoint: { final: true } } } });
  await first;
  const closing = session.close();
  await tick();
  assert.deepEqual(stopped.calls.at(-1), ["respond", { turnId: "turn-1", boundaryId: "b1", reply: null }]);
  stopped.finish({ reply: "Final" });
  await closing;

  const failed = fakeAgent();
  const aborted = new AbortController();
  const cancelled = transport.startSession({ agent: failed, turnId: "turn-2", token: "a.b.c", body, signal: aborted.signal });
  const waiting = cancelled.first(() => {});
  aborted.abort();
  await tick();
  assert.deepEqual(failed.calls.at(-1), ["cancel", { turnId: "turn-2" }]);
  failed.fail(Object.assign(new Error("Cancelled"), { code: "OPERATION_ABORTED" }));
  await assert.rejects(waiting, { code: "OPERATION_ABORTED" });
  await cancelled.close({ cancelTurn: true });

  const handlerError = fakeAgent();
  const broken = transport.startSession({ agent: handlerError, turnId: "turn-3", token: "a.b.c", body });
  const result = broken.first(() => { throw Object.assign(new Error("Project changed"), { code: "OPERATION_ABORTED" }); });
  handlerError.emit({ turnId: "turn-3", event: { type: "delta", text: "x" } });
  handlerError.emit({ turnId: "turn-3", event: { type: "boundary", boundaryId: "b3", data: {} } });
  await assert.rejects(result, { code: "OPERATION_ABORTED" }, "A failing event handler fails the exchange, as with an FC stream");
});

test("a turn ends with its result, failures included; recovery follows a reset; stops are cancellations", async () => {
  // The failure result's reply explains what is incomplete and what was kept.
  const failed = fakeAgent();
  const failing = transport.startSession({ agent: failed, turnId: "turn-1", token: "a.b.c", body });
  const first = failing.first(() => {});
  failed.finish({ fallback: true, error: "InputQuotaRecoveryIncomplete", reply: "Partial" });
  assert.deepEqual(await first, { fallback: true, error: "InputQuotaRecoveryIncomplete", reply: "Partial" });
  assert.equal(failing.atBoundary(), false);
  await failing.close();

  const recovering = fakeAgent(), seen = [];
  const recovery = transport.startSession({ agent: recovering, turnId: "turn-2", token: "a.b.c", body });
  const result = recovery.first(event => seen.push(event.type));
  recovering.emit({ turnId: "turn-2", event: { type: "delta", text: "draft" } });
  recovering.finish({ evidenceRecovery: { version: 1, cycle: 0, requests: [] } });
  assert.deepEqual((await result).evidenceRecovery.version, 1);
  assert.deepEqual(seen, ["delta", "reset"], "The draft is reset before evidence recovery, as FC streams it");
  await recovery.close();

  const stopped = fakeAgent(), controller = new AbortController();
  const stopping = transport.startSession({ agent: stopped, turnId: "turn-3", token: "a.b.c", body, signal: controller.signal });
  const waiting = stopping.first(() => {});
  controller.abort();
  stopped.fail(Object.assign(new Error("The agent turn was cancelled."), { code: "OPERATION_ABORTED" }));
  await assert.rejects(waiting, { code: "OPERATION_ABORTED", message: "The request was cancelled." });
  await assert.rejects(stopping.next({}, () => {}), { code: "INVALID_TOOL_CONTINUATION" });

  // A renderer handler failure interrupts the stream, as readWorkbenchResponse reports it.
  const broken = fakeAgent();
  const breaking = transport.startSession({ agent: broken, turnId: "turn-4", token: "a.b.c", body });
  const interrupted = breaking.first(() => { throw Object.assign(new Error("Bad transcript"), { code: "INVALID_CONVERSATION_TRANSCRIPT" }); });
  broken.emit({ turnId: "turn-4", event: { type: "transcript", sequence: 1 } });
  broken.finish({ reply: "Done" });
  await assert.rejects(interrupted, { code: "STREAM_INTERRUPTED" });

  // Request rejections keep their code and status for the renderer to report as /chat does.
  const rejected = fakeAgent();
  const rejecting = transport.startSession({ agent: rejected, turnId: "turn-5", token: "a.b.c", body });
  const rejection = rejecting.first(() => {});
  rejected.fail(Object.assign(new Error("Invalid transcript"), { code: "INVALID_CONVERSATION_TRANSCRIPT", status: 400 }));
  await assert.rejects(rejection, { code: "INVALID_CONVERSATION_TRANSCRIPT", status: 400 });
});

test("a boundary reply that never reaches the loop fails its exchange, and cancelling the turn leaves no stray rejection", async () => {
  const unhandled = [];
  const record = reason => unhandled.push(reason);
  process.on("unhandledRejection", record);
  try {
    const agent = fakeAgent();
    agent.respond = async payload => { agent.calls.push(["respond", payload]); throw Object.assign(new Error("IPC unavailable"), { code: "TEST_IPC_LOST" }); };
    const session = transport.startSession({ agent, turnId: "turn-1", token: "a.b.c", body });
    const first = session.first(() => {});
    agent.emit({ turnId: "turn-1", event: { type: "boundary", boundaryId: "b1", data: { desktopToolCalls: [{ id: "c1" }] } } });
    await first;
    await assert.rejects(session.next({ desktopToolResults: [{ id: "c1" }] }, () => {}), { code: "TEST_IPC_LOST" });
    const closing = session.close({ cancelTurn: true });
    await tick();
    assert.deepEqual(agent.calls.at(-1), ["cancel", { turnId: "turn-1" }]);
    agent.fail(Object.assign(new Error("Cancelled"), { code: "OPERATION_ABORTED" }));
    await closing;
    await tick();
    assert.deepEqual(unhandled, []);
  } finally { process.off("unhandledRejection", record); }
});
