"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), jwt = require("jsonwebtoken");
const backend = require("../index.js"), response = require("../requesty-response.js"), timing = require("../chat-timing.js");
const { createRuntimeLogger } = require("../../docs/runtime-log.js");
const body = { model: "fixture/model", messages: [{ role: "user", content: "PRIVATE_PROMPT" }] };
const socketError = () => new TypeError("fetch failed PRIVATE_KEY", { cause: Object.assign(new Error("PRIVATE_ADDRESS"), { code: "ECONNRESET" }) });

test("fetch failure retains nested safe codes in result and timing without assuming HTTP 503", async t => {
  const logs = [], trace = timing.create({ logger: { info: (...args) => logs.push(args) } }); trace.activate();
  t.mock.method(console, "warn", (...args) => logs.push(args));
  let calls = 0; t.mock.method(globalThis, "fetch", async () => { calls++; throw socketError(); });
  const result = await timing.run(trace, () => backend._test.requestRequestyMessage(body, "PRIVATE_KEY"));
  assert.equal(result.error, "LlmRequestFailed"); assert.equal(result.status, undefined); assert.equal(calls, 2);
  assert.deepEqual(result.responseDiagnostics, { transportPhase: "fetch", exceptionName: "TypeError", transportCode: "ECONNRESET" });
  const ends = trace.snapshot().events.filter(e => e.stage === "provider_fetch_end");
  assert.equal(ends.length, 2); assert.ok(ends.every(e => e.transportCode === "ECONNRESET" && e.outcome === "failed"));
  assert.doesNotMatch(JSON.stringify({ result, logs }), /PRIVATE_|Bearer|stack/);
});

test("local request setup errors fail before fetch and are not retried as network failures", async t => {
  t.mock.method(globalThis, "fetch", () => assert.fail("Invalid request must not reach fetch"));
  for (const [input, key] of [[body, "PRIVATE\nKEY"], [{ ...body, invalid: 1n }, "PRIVATE_KEY"]]) {
    const result = await backend._test.requestRequestyMessage(input, key);
    assert.equal(result.error, "RequestyRequestInvalid"); assert.equal(result.attempts, 0);
    assert.equal(result.responseDiagnostics.transportPhase, "request_setup");
    assert.doesNotMatch(JSON.stringify(result), /PRIVATE|invalid.*1/);
  }
});

test("aggregate and unknown exceptions preserve only allowlisted diagnostic fields", () => {
  const nested = new AggregateError([Object.assign(new Error("secret IP"), { code: "ETIMEDOUT" }), Object.assign(new Error(), { code: "ENETUNREACH" })]);
  const diagnostic = response.fetchException(new TypeError("fetch failed", { cause: nested }));
  assert.equal(diagnostic.transportCode, "ETIMEDOUT"); assert.equal(diagnostic.transportCauseCode, "ENETUNREACH");
  assert.deepEqual(response.fetchException({ name: "PRIVATE_KEY", code: "PRIVATE_KEY", cause: { code: "secret" } }), { transportPhase: "fetch" });
  assert.equal(response.fetchException(new TypeError("unknown")).transportCode, undefined);
  nested.cause = nested; assert.doesNotThrow(() => response.fetchException(nested));
});

test("Agent Work returns fetch diagnostics to desktop logs even without cloud log access", async t => {
  const env = { JWT_SECRET: "diag-fixture", ADMIN_ACCOUNT: "diag-fixture", REQUESTY_API_KEY: "PRIVATE_KEY", REQUESTY_MODEL: "google/gemini-3.1-flash-lite:flex", CHAT_TIMING_DEBUG: "1" };
  const prior = Object.fromEntries(Object.keys(env).map(k => [k, process.env[k]])); Object.assign(process.env, env);
  t.after(() => { for (const k of Object.keys(env)) prior[k] === undefined ? delete process.env[k] : process.env[k] = prior[k]; });
  t.mock.method(globalThis, "fetch", async () => { throw socketError(); });
  const token = jwt.sign({ account: env.ADMIN_ACCOUNT, role: "admin" }, env.JWT_SECRET);
  const query = "Find and download papers about AI biology.";
  const result = await backend.handler({ httpMethod: "POST", path: "/chat", headers: { authorization: `Bearer ${token}` }, body: JSON.stringify({
    mode: "agent_instruction", messages: [{ role: "user", content: query }], originalRequest: query,
    localWorkspaceContext: { version: 1, agentLoop: { version: 1, academicAcquisition: true } },
    desktopTools: { version: 1, academicVersion: 1, permission: "workspace_write", projectId: "fixture" },
  }) }, {});
  const data = JSON.parse(result.body);
  assert.equal(data.error, "LlmRequestFailed"); assert.equal(data.failure.transportCode, "ECONNRESET");
  assert.equal(data.failure.category, "provider_fetch_exception"); assert.equal(data.failure.providerAttempts, 2);
  assert.equal(data.desktopToolCalls, undefined);
  const log = createRuntimeLogger({ sink: null });
  log.record("main-agent.failure", data.failure);
  log.chatTiming({}).server(data.chatTiming);
  assert.match(log.exportText(), /ECONNRESET/); assert.match(log.exportText(), /provider_fetch_end/);
  assert.doesNotMatch(log.exportText(), /PRIVATE_|Bearer|PRIVATE_ADDRESS/);
});
