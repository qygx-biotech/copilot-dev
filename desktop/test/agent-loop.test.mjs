import assert from "node:assert/strict";
import { EventEmitter, once } from "node:events";
import http from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import channels from "../ipc/channels.cjs";
import { registerIpcHandlers } from "../ipc/register-handlers.mjs";
import { AGENT_LOOP_LIMITS, validateAgentCancel, validateAgentInject, validateAgentRespond, validateAgentStart, validateAgentSteer } from "../ipc/agent-loop-validation.mjs";
import { callModelTurn, fetchModelCapabilities, MODEL_PROXY_PATH, proxyEndpoint } from "../workers/model-proxy-client.mjs";
import { createAgentLoopHost } from "../workers/agent-loop-host.mjs";
import { AgentLoopClient } from "../workers/agent-loop-client.mjs";
import { AgentLoopService, CONTEXT_ARCHIVE_PATH } from "../services/agent-loop-service.mjs";

const token = "eyJhbGciOiJIUzI1NiJ9.eyJhY2NvdW50IjoiZml4dHVyZSJ9.c2lnbmF0dXJl";
const question = "Echo this.";
const sideChat = (extra = {}) => ({ mode: "side_chat", originalRequest: question, messages: [{ role: "user", content: question }],
  callContext: { turnId: "turn-1", callRole: "answer", profile: "light" }, ...extra });
const agentWork = (extra = {}) => ({ mode: "agent_instruction", originalRequest: question, messages: [{ role: "user", content: question }],
  desktopTools: { version: 1, permission: "full_access", projectId: "project-1" }, callContext: { turnId: "turn-1", callRole: "answer", profile: "light" }, ...extra });
const startPayload = (extra = {}) => ({ projectId: "project-1", turnId: "turn-1", token, body: sideChat(), ...extra });
const sseEvent = (name, data) => `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`;
const toolCall = (name, args = {}, id = `call-${name}`) => ({ id, type: "function", function: { name, arguments: JSON.stringify(args) } });
const answer = message => ({ ok: true, model: "fixture/model", api: "chat_completions", capabilities: { supportsTools: true },
  result: { ok: true, message: { role: "assistant", ...message }, usage: { total_tokens: 12 }, finishReason: message.tool_calls ? "tool_calls" : "stop" } });
// What FC /api/model/capabilities returns for a plain Chat Completions model.
const capabilities = { version: 1, model: "fixture/model", api: "chat_completions", provider: "fixture", toolMode: "sequential", supportsWebSearch: false,
  agentCapabilities: { supportsTools: true, supportsImages: false, supportsWebSearch: false },
  providerCapabilities: { api: "chat_completions", completedToolBoundary: false, dispatch: "complete_response" }, providerProfile: "a".repeat(64),
  contextConfig: { outputTokens: 8192, safety: 1024, summaryTokens: 2048, maxAttempts: 4, maxSummaryCalls: 16, providerCallMs: 90000, quotaWaitMs: 180000, quotaTtlMs: 60000, imageTokens: 4096 },
  loopBudget: { maxSteps: 64, maxToolCalls: 192, turnMs: 1800000, turnTokens: null }, accountScope: "b".repeat(64),
  scope: { endpoint: "c".repeat(64), account: "d".repeat(64), quotaEndpoint: "e".repeat(64), quotaAccount: "f".repeat(64) } };
const waitFor = async (check, label) => {
  for (let i = 0; i < 400; i++) { if (check()) return; await new Promise(resolve => setTimeout(resolve, 5)); }
  throw new Error(`Timed out waiting for ${label}`);
};

// A local stand-in for the FC model proxy: /api/model/capabilities and the
// scripted /api/model/turn responses.
async function mockProxy(respond) {
  const requests = [];
  const server = http.createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    const record = { method: req.method, url: req.url, headers: req.headers, body: body ? JSON.parse(body) : null, aborted: false };
    res.on("close", () => { if (!res.writableEnded) record.aborted = true; });
    if (req.url === "/api/model/capabilities") {
      res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(capabilities)); return;
    }
    requests.push(record);
    await respond(req, res, record, requests.length);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return { url: `http://127.0.0.1:${server.address().port}`, requests,
    close: async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); } };
}
const sse = (res, frames) => {
  res.writeHead(200, { "content-type": "text/event-stream" });
  for (const frame of frames) res.write(frame);
  res.end();
};
const finalStream = final => (_req, res) => sse(res, [sseEvent("status", { stage: "provider-request", attempt: 1 }), sseEvent("delta", { text: final.result.message.content || "" }), sseEvent("final", final)]);
const hanging = (_req, res) => { res.writeHead(200, { "content-type": "text/event-stream" }); res.write(sseEvent("delta", { text: "Thinking" })); };

// Runs the real loop-process host in-process in place of Electron.
function fakeUtilityProcess() {
  const forks = [];
  return { forks, fork(modulePath, args, options) {
    const child = new EventEmitter();
    const host = createAgentLoopHost({ post: message => setImmediate(() => child.emit("message", structuredClone(message))) });
    child.postMessage = message => setImmediate(() => host.handle(structuredClone(message)));
    child.kill = () => setImmediate(() => child.emit("exit", 0));
    forks.push({ modulePath, args, options, child, host });
    return child;
  } };
}
function fakeSender() {
  const sender = new EventEmitter();
  sender.events = [];
  sender.destroyed = false;
  sender.isDestroyed = () => sender.destroyed;
  return sender;
}
async function serviceFixture(run, baseUrl) {
  const root = await mkdtemp(path.join(os.tmpdir(), "biodesign-agent-loop-"));
  const sessionManager = Object.assign(new EventEmitter(), { active: { filesystem: { root, id: "project-1" } } });
  sessionManager.requireActive = () => {
    if (!sessionManager.active) throw Object.assign(new Error("Select a project folder first."), { code: "NO_ACTIVE_PROJECT" });
    return sessionManager.active;
  };
  sessionManager.close = async () => { sessionManager.active = null; sessionManager.emit("closed"); };
  const utilityProcess = fakeUtilityProcess();
  const service = new AgentLoopService({ sessionManager, utilityProcess, appPath: process.cwd(), baseUrl,
    sendEvent: (sender, payload) => sender.events.push(payload) });
  try { await run({ service, sessionManager, utilityProcess, root }); }
  finally { await service.closeClient(); await rm(root, { recursive: true, force: true }); }
}
const boundaries = sender => sender.events.filter(item => item.event.type === "boundary");

test("agent IPC payloads are validated before they reach the loop process", () => {
  const valid = validateAgentStart(startPayload({ body: agentWork({ model: "default" }) }));
  assert.equal(valid.body.mode, "agent_instruction");
  const invalid = [
    [startPayload({ extra: true }), "UNKNOWN_FIELD"],
    [startPayload({ turnId: "../turn" }), "INVALID_TURN_ID"],
    [startPayload({ token: "Bearer abc" }), "INVALID_SESSION_TOKEN"],
    [startPayload({ token: `${"a".repeat(AGENT_LOOP_LIMITS.tokenCharacters)}.b.c` }), "INVALID_SESSION_TOKEN"],
    [startPayload({ body: sideChat({ messages: [] }) }), "INVALID_MESSAGES"],
    [startPayload({ body: sideChat({ mode: "admin" }) }), "INVALID_MODE"],
    [startPayload({ body: sideChat({ desktopContinuation: "signed" }) }), "UNKNOWN_FIELD"],
    [startPayload({ body: sideChat({ desktopToolResults: [] }) }), "UNKNOWN_FIELD"],
    [startPayload({ body: sideChat({ messages: Array.from({ length: AGENT_LOOP_LIMITS.messages + 1 }, () => ({ role: "user", content: "x" })) }) }), "INVALID_MESSAGES"],
    [startPayload({ body: sideChat({ messages: [{ role: "user", content: "x".repeat(AGENT_LOOP_LIMITS.requestBytes) }] }) }), "AGENT_REQUEST_TOO_LARGE"],
  ];
  for (const [payload, code] of invalid) assert.throws(() => validateAgentStart(payload), { code }, code);
  const boundaryId = "123e4567-e89b-42d3-a456-426614174000";
  assert.deepEqual(validateAgentRespond({ projectId: "p", turnId: "turn-1", boundaryId, reply: null }), { turnId: "turn-1", boundaryId, reply: null });
  assert.deepEqual(validateAgentRespond({ projectId: "p", turnId: "turn-1", boundaryId, reply: { desktopToolResults: [], runtimeInjections: [] } }).reply,
    { desktopToolResults: [], runtimeInjections: [] });
  for (const [reply, code] of [[{ desktopToolResults: [], extra: 1 }, "UNKNOWN_FIELD"], [{ desktopToolResults: Array(AGENT_LOOP_LIMITS.boundaryResults + 1).fill({}) }, "INVALID_ARRAY"],
    [{ runtimeRevokedTools: "all" }, "INVALID_ARRAY"], [{ localWorkspaceContext: [] }, "INVALID_PAYLOAD"]]) {
    assert.throws(() => validateAgentRespond({ projectId: "p", turnId: "turn-1", boundaryId, reply }), { code }, code);
  }
  assert.throws(() => validateAgentRespond({ projectId: "p", turnId: "turn-1", boundaryId: "x", reply: null }), { code: "INVALID_BOUNDARY_ID" });
  assert.deepEqual(validateAgentCancel({ projectId: "project-1", turnId: "turn-1" }), { turnId: "turn-1" });
  assert.deepEqual(validateAgentSteer({ projectId: "p", turnId: "turn-1", id: "steer-1", content: "Focus on yield." }).item,
    { id: "steer-1", kind: "user", content: "Focus on yield." });
  assert.equal(validateAgentInject({ projectId: "p", turnId: "turn-1", id: "child-1", content: "Done.", taskId: "task" }).item.kind, "subagent");
  assert.throws(() => validateAgentSteer({ projectId: "p", turnId: "turn-1", id: "bad id", content: "x" }), { code: "INVALID_INJECTION_ID" });
  assert.throws(() => validateAgentSteer({ projectId: "p", turnId: "turn-1", id: "s", content: "x".repeat(AGENT_LOOP_LIMITS.injectionCharacters + 1) }), { code: "INVALID_STRING" });
});

test("the proxy client sends the session token to the FC endpoints and parses the SSE stream", async () => {
  const final = answer({ content: "Echoed." });
  const proxy = await mockProxy((_req, res) => sse(res, [sseEvent("status", { stage: "provider-request", attempt: 1 }), sseEvent("delta", { text: "Echo" }),
    sseEvent("reset", {}), sseEvent("tool-call", { id: "call-1", name: "list_papers", arguments: "{}" }), sseEvent("usage", { usage: { total_tokens: 12 } }), sseEvent("final", final)]));
  try {
    assert.deepEqual(await fetchModelCapabilities({ baseUrl: proxy.url, token, request: { surface: "side_chat" } }), capabilities);
    const events = [];
    const result = await callModelTurn({ baseUrl: proxy.url, token, request: { messages: [{ role: "user", content: question }], stage: "local-tools" }, onEvent: event => events.push(event) });
    assert.deepEqual(result, final);
    assert.deepEqual(events.map(event => event.type), ["status", "delta", "tool-call", "usage"], "Unknown event types are ignored");
    const [request] = proxy.requests;
    assert.equal(request.url, MODEL_PROXY_PATH);
    assert.equal(request.headers.authorization, `Bearer ${token}`);
    assert.deepEqual(request.body, { version: 1, stream: true, messages: [{ role: "user", content: question }], stage: "local-tools" });
  } finally { await proxy.close(); }
});

test("the proxy client returns buffered results and provider failures, and maps proxy failures", async () => {
  const providerFailure = { ok: false, origin: "provider", category: "input_quota", model: "fixture/model", api: "chat_completions",
    result: { ok: false, error: "LlmHttpError", status: 429, inputQuota: { retryAfterMs: 58000 } } };
  const replies = [
    res => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(answer({ content: "Echoed." }))); },
    res => sse(res, [sseEvent("final", providerFailure)]),
    res => { res.writeHead(401, { "content-type": "application/json" }); res.end(JSON.stringify({ error: "Unauthorized" })); },
    res => { res.writeHead(400, { "content-type": "application/json" }); res.end(JSON.stringify({ origin: "proxy", error: "MODEL_CAPABILITY_UNAVAILABLE", capability: "images", message: "No images." })); },
    res => { res.writeHead(429, { "content-type": "application/json" }); res.end(JSON.stringify({ origin: "proxy", error: "USER_TOKEN_CAP_EXCEEDED", retryAfterMs: 3600000, cap: 100, used: 120 })); },
    res => { res.writeHead(502, { "content-type": "text/html" }); res.end("<html>Bad gateway</html>"); },
  ];
  const proxy = await mockProxy((_req, res, _record, index) => replies[index - 1](res));
  try {
    const turn = () => callModelTurn({ baseUrl: proxy.url, token, request: { messages: [{ role: "user", content: question }] } });
    assert.equal((await turn()).result.message.content, "Echoed.");
    assert.deepEqual(await turn(), providerFailure, "Provider failures resolve so the caller can classify result");
    await assert.rejects(turn(), { code: "AUTH_REQUIRED", status: 401 });
    await assert.rejects(turn(), { code: "MODEL_CAPABILITY_UNAVAILABLE", origin: "proxy", capability: "images", status: 400 });
    await assert.rejects(turn(), { code: "USER_TOKEN_CAP_EXCEEDED", origin: "proxy", retryAfterMs: 3600000 });
    await assert.rejects(turn(), { code: "MODEL_PROXY_HTTP_ERROR", origin: "gateway", status: 502 });
  } finally { await proxy.close(); }
});

test("the proxy client rejects interrupted streams and unsafe proxy URLs", async () => {
  const replies = [
    res => sse(res, [sseEvent("delta", { text: "partial" })]),
    res => sse(res, [sseEvent("delta", { text: "partial" }), sseEvent("error", { code: "STREAM_INTERRUPTED" })]),
    res => sse(res, [sseEvent("final", answer({ content: "Done." })), sseEvent("delta", { text: "late" })]),
  ];
  const proxy = await mockProxy((_req, res, _record, index) => replies[index - 1](res));
  try {
    const turn = () => callModelTurn({ baseUrl: proxy.url, token, request: { messages: [{ role: "user", content: question }] } });
    await assert.rejects(turn(), { code: "STREAM_INTERRUPTED" });
    await assert.rejects(turn(), { code: "STREAM_INTERRUPTED" });
    assert.equal((await turn()).ok, true, "Reading stops at the final event");
  } finally { await proxy.close(); }
  for (const url of ["http://fc.example.com", "https://user:secret@fc.example.com", "ftp://fc.example.com", "https://fc.example.com/?redirect=x", "not a url"]) {
    assert.throws(() => proxyEndpoint(url), { code: "INVALID_PROXY_URL" }, url);
  }
  assert.equal(proxyEndpoint("https://fc.example.com/base"), "https://fc.example.com/base/api/model/turn");
  await assert.rejects(callModelTurn({ baseUrl: proxy.url, token: "", request: {} }), { code: "AUTH_REQUIRED" });
  await assert.rejects(callModelTurn({ baseUrl: proxy.url, token, request: {} }), { code: "MODEL_PROXY_UNREACHABLE" });
});

test("the loop process runs the shared agent loop through the proxy and returns the /chat-shaped result", async () => {
  const proxy = await mockProxy(finalStream(answer({ content: "Echoed answer." })));
  try {
    const posted = [];
    const host = createAgentLoopHost({ post: message => posted.push(message) });
    host.handle({ type: "start", turnId: "turn-1", token, baseUrl: proxy.url, body: sideChat(), archiveRoot: path.join(os.tmpdir(), "unused-archive") });
    await waitFor(() => posted.some(message => message.type === "done"), "turn completion");
    const done = posted.find(message => message.type === "done");
    assert.equal(done.ok, true, JSON.stringify(done.error));
    assert.equal(done.result.reply, "Echoed answer.");
    assert.equal(done.result.fallback, false);
    assert.equal(proxy.requests.length, 1);
    assert.equal(proxy.requests[0].body.surface, "side_chat");
    assert.deepEqual(proxy.requests[0].body.callContext, { turnId: "turn-1", workflowId: "", callRole: "answer", paperId: "", profile: "light" });
    const events = posted.filter(message => message.type === "event").map(message => message.event.type);
    assert.ok(events.includes("delta") && events.includes("status"), events.join());
  } finally { await proxy.close(); }
});

test("host tools pause the loop at a boundary and resume in place with the host's receipts", async () => {
  const url = "https://papers.example.org/enzyme.pdf";
  const proxy = await mockProxy((req, res, record, index) => finalStream(index === 1
    ? answer({ content: null, tool_calls: [toolCall("download_sources", { sources: [{ url }] }, "download")] })
    : answer({ content: "Saved." }))(req, res));
  try {
    const posted = [];
    const host = createAgentLoopHost({ post: message => posted.push(message) });
    host.handle({ type: "start", turnId: "turn-1", token, baseUrl: proxy.url, body: agentWork(), archiveRoot: path.join(os.tmpdir(), "unused-archive") });
    await waitFor(() => posted.some(message => message.type === "boundary"), "boundary");
    const boundary = posted.find(message => message.type === "boundary");
    assert.deepEqual(boundary.data.desktopToolCalls.map(call => [call.name, call.args.sources[0].url]), [["download_sources", url]]);
    host.handle({ type: "boundary-reply", turnId: "turn-1", boundaryId: "not-this-one", reply: null });
    assert.ok(!posted.some(message => message.type === "done"), "A reply to another boundary is ignored");
    host.handle({ type: "boundary-reply", turnId: "turn-1", boundaryId: boundary.boundaryId, reply: { desktopToolResults: [{ id: "download",
      results: [{ url, status: "downloaded", path: "literature/enzyme.pdf", contentType: "application/pdf" }] }] } });
    await waitFor(() => posted.some(message => message.type === "done"), "turn completion");
    const done = posted.find(message => message.type === "done");
    assert.equal(done.ok, true, JSON.stringify(done.error));
    assert.equal(done.result.reply, "Saved.");
    assert.equal(proxy.requests.length, 2);
    const receipt = JSON.parse(proxy.requests[1].body.messages.find(message => message.tool_call_id === "download").content);
    assert.equal(receipt[0].status, "downloaded");
  } finally { await proxy.close(); }
});

test("cancelling a turn aborts the in-flight proxy call", async () => {
  const proxy = await mockProxy(hanging);
  try {
    const posted = [];
    const host = createAgentLoopHost({ post: message => posted.push(message) });
    host.handle({ type: "start", turnId: "turn-1", token, baseUrl: proxy.url, body: sideChat(), archiveRoot: path.join(os.tmpdir(), "unused-archive") });
    await waitFor(() => posted.some(message => message.event?.type === "delta"), "first delta");
    host.handle({ type: "cancel", turnId: "turn-1" });
    await waitFor(() => posted.some(message => message.type === "done"), "cancelled turn");
    assert.equal(posted.find(message => message.type === "done").error.code, "OPERATION_ABORTED");
    await waitFor(() => proxy.requests[0].aborted, "server-side disconnect");
    assert.deepEqual(host.activeTurns(), []);
  } finally { await proxy.close(); }
});

test("cancelling while the host runs tools ends the turn and abandons the boundary", async () => {
  const proxy = await mockProxy(finalStream(answer({ content: null, tool_calls: [toolCall("download_sources", { sources: [{ url: "https://x.example/a.pdf" }] }, "download")] })));
  try {
    await serviceFixture(async ({ service }) => {
      const sender = fakeSender();
      const turn = service.start(sender, validateAgentStart(startPayload({ body: agentWork() }))).then(() => null, error => error);
      await waitFor(() => boundaries(sender).length === 1, "boundary");
      const { boundaryId } = boundaries(sender)[0].event;
      assert.deepEqual(service.cancel(sender, { turnId: "turn-1" }), { cancelled: true });
      assert.equal((await turn).code, "OPERATION_ABORTED");
      assert.throws(() => service.respond(sender, { turnId: "turn-1", boundaryId, reply: null }), { code: "TURN_NOT_FOUND" }, "A late reply finds no turn");
      assert.equal(service.turns.size, 0);
      assert.equal(proxy.requests.length, 1, "No further model call after cancellation");
    }, proxy.url);
  } finally { await proxy.close(); }
});

test("events and boundaries reach only the originating window, which alone may answer, steer or cancel", async () => {
  const proxy = await mockProxy((req, res, record, index) => finalStream(index === 1
    ? answer({ content: null, tool_calls: [toolCall("download_sources", { sources: [{ url: "https://x.example/a.pdf" }] }, "download")] })
    : answer({ content: "Done." }))(req, res));
  try {
    await serviceFixture(async ({ service }) => {
      const owner = fakeSender(), other = fakeSender();
      const turn = service.start(owner, validateAgentStart(startPayload({ body: agentWork() })));
      await waitFor(() => boundaries(owner).length === 1, "boundary");
      assert.equal(other.events.length, 0);
      const { boundaryId } = boundaries(owner)[0].event;
      assert.throws(() => service.respond(other, { turnId: "turn-1", boundaryId, reply: null }), { code: "TURN_NOT_FOUND" });
      assert.throws(() => service.cancel(other, { turnId: "turn-1" }), { code: "TURN_NOT_FOUND" });
      assert.throws(() => service.respond(owner, { turnId: "turn-1", boundaryId: "123e4567-e89b-42d3-a456-426614174000", reply: null }), { code: "BOUNDARY_NOT_FOUND" });
      await assert.rejects(service.start(owner, validateAgentStart(startPayload({ body: agentWork() }))), { code: "TURN_ALREADY_RUNNING" });
      service.steer(owner, validateAgentSteer({ projectId: "p", turnId: "turn-1", id: "s1", content: "Focus." }));
      await waitFor(() => owner.events.some(item => item.event.type === "injection-rejected"), "steering outcome");
      assert.equal(owner.events.find(item => item.event.type === "injection-rejected").event.code, "STEERING_UNAVAILABLE", "Turns without runtime extensions take no steering");
      assert.deepEqual(service.respond(owner, { turnId: "turn-1", boundaryId, reply: { desktopToolResults: [{ id: "download",
        results: [{ url: "https://x.example/a.pdf", status: "downloaded", path: "literature/a.pdf", contentType: "application/pdf" }] }] } }), { accepted: true });
      assert.equal((await turn).reply, "Done.");
      assert.equal(CONTEXT_ARCHIVE_PATH, ".biodesign/runtime/context-archives");
    }, proxy.url);
  } finally { await proxy.close(); }
});

test("closing the window or the project cancels its turns", async () => {
  const proxy = await mockProxy(hanging);
  try {
    await serviceFixture(async ({ service, sessionManager }) => {
      const first = fakeSender();
      const turn = service.start(first, validateAgentStart(startPayload())).then(() => null, error => error);
      await waitFor(() => first.events.some(item => item.event.type === "delta"), "first delta");
      first.destroyed = true;
      first.emit("destroyed");
      assert.equal((await turn).code, "OPERATION_ABORTED");
      const second = fakeSender();
      const next = service.start(second, validateAgentStart(startPayload({ turnId: "turn-2" }))).then(() => null, error => error);
      await waitFor(() => second.events.some(item => item.event.type === "delta"), "second delta");
      await sessionManager.close();
      assert.ok(["OPERATION_ABORTED", "PROJECT_CLOSED"].includes((await next).code));
      await waitFor(() => proxy.requests.every(request => request.aborted), "proxy disconnects");
    }, proxy.url);
  } finally { await proxy.close(); }
});

test("a loop process crash fails its running turns, and its environment carries no credentials or project root", async () => {
  const proxy = await mockProxy(hanging);
  // Main-process secrets must not leak through the inherited environment.
  const previous = process.env.FIXTURE_PROVIDER_SECRET;
  process.env.FIXTURE_PROVIDER_SECRET = "must-not-reach-the-loop-process";
  try {
    await serviceFixture(async ({ service, utilityProcess, root }) => {
      const sender = fakeSender();
      const turn = service.start(sender, validateAgentStart(startPayload())).then(() => null, error => error);
      await waitFor(() => sender.events.some(item => item.event.type === "delta"), "delta");
      const [{ modulePath, options, child }] = utilityProcess.forks;
      assert.equal(modulePath, AgentLoopClient.modulePath(process.cwd()));
      assert.equal(options.serviceName, "BioDesign Agent Loop");
      assert.ok(!Object.keys(options.env).some(key => /REQUESTY|JWT|TOKEN|KEY|SECRET|BIODESIGN/i.test(key)));
      assert.ok(!Object.values(options.env).includes("must-not-reach-the-loop-process"));
      assert.ok(!Object.values(options.env).some(value => String(value).includes(root)));
      child.emit("exit", 1);
      assert.equal((await turn).code, "AGENT_WORKER_EXITED");
    }, proxy.url);
  } finally {
    if (previous === undefined) delete process.env.FIXTURE_PROVIDER_SECRET; else process.env.FIXTURE_PROVIDER_SECRET = previous;
    await proxy.close();
  }
});

test("agent loop IPC requires the trusted frame and active project", async () => {
  const handlers = new Map();
  const webContents = { getURL: () => "file:///app/docs/desktop.html" };
  const trusted = { sender: webContents, senderFrame: { url: webContents.getURL() } };
  const sessionManager = new EventEmitter();
  sessionManager.requireActive = () => ({ filesystem: { id: "project-1", root: os.tmpdir() } });
  const started = [];
  const agentLoop = new AgentLoopService({ sessionManager, createClient: () => ({ runTurn: async request => { started.push(request); return { reply: "ok" }; } }) });
  const dispose = registerIpcHandlers({ ipcMain: { handle: (name, handler) => handlers.set(name, handler), removeHandler: name => handlers.delete(name) },
    sessionManager, getWindow: () => ({ isDestroyed: () => false, webContents }), agentLoop });
  try {
    const start = handlers.get(channels.agentStart);
    assert.equal((await start({ sender: webContents, senderFrame: { url: "https://remote.example/" } }, startPayload())).error.code, "UNTRUSTED_IPC_SENDER");
    assert.equal((await start(trusted, startPayload({ projectId: "other-project" }))).error.code, "PROJECT_MISMATCH");
    assert.equal((await start(trusted, startPayload({ token: "x" }))).error.code, "INVALID_SESSION_TOKEN");
    assert.equal(started.length, 0);
    assert.deepEqual(await start(trusted, startPayload()), { ok: true, value: { reply: "ok" } });
    assert.equal(started[0].archiveRoot, path.join(os.tmpdir(), CONTEXT_ARCHIVE_PATH));
    assert.equal((await handlers.get(channels.agentCancel)(trusted, { projectId: "project-1", turnId: "turn-unknown" })).error.code, "TURN_NOT_FOUND");
    for (const channel of [channels.agentStart, channels.agentCancel, channels.agentSteer, channels.agentInject, channels.agentRespond]) assert.ok(handlers.has(channel));
  } finally { dispose(); }
});

test("a loop admission rejection crosses IPC with its HTTP-equivalent status, redacted like any desktop error", async () => {
  const { sanitizeError } = await import("../ipc/validation.mjs");
  const handlers = new Map();
  const webContents = { getURL: () => "file:///app/docs/desktop.html" };
  const trusted = { sender: webContents, senderFrame: { url: webContents.getURL() } };
  const sessionManager = new EventEmitter();
  sessionManager.requireActive = () => ({ filesystem: { id: "project-1", root: os.tmpdir() } });
  const agentLoop = new AgentLoopService({ sessionManager, createClient: () => ({ runTurn: async () => {
    throw Object.assign(new Error("Invalid transcript token=abc"), { code: "INVALID_CONVERSATION_TRANSCRIPT", status: 400 });
  } }) });
  const dispose = registerIpcHandlers({ ipcMain: { handle: (name, handler) => handlers.set(name, handler), removeHandler: name => handlers.delete(name) },
    sessionManager, getWindow: () => ({ isDestroyed: () => false, webContents }), agentLoop });
  try {
    assert.deepEqual(await handlers.get(channels.agentStart)(trusted, startPayload()),
      { ok: false, error: { code: "INVALID_CONVERSATION_TRANSCRIPT", message: "Invalid transcript token=[redacted]", status: 400 } });
  } finally { dispose(); }
  for (const status of [200, 600, "400", 400.5, undefined]) assert.equal(sanitizeError(Object.assign(new Error("x"), { code: "X", status })).status, undefined, String(status));
});
