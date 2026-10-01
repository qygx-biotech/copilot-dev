"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const { requestRequestyMessage } = require("../index.js")._test;
const body = { model: "fixture/model", messages: [{ role: "user", content: "Find papers." }] };
const unavailable = () => new Response(JSON.stringify({ error: { message: "This model is currently experiencing high demand. Spikes in demand are usually temporary. Please try again later." } }), { status: 503, headers: { "retry-after": "0", "x-request-id": "fixture-request" } });

for (const recover of [true, false]) test(`503 makes at most five total attempts: ${recover ? "fifth succeeds" : "exhausted"}`, async t => {
  const requests = [];
  t.mock.method(globalThis, "fetch", async (_url, options) => {
    requests.push(JSON.parse(options.body));
    return recover && requests.length === 5 ? new Response(JSON.stringify({ choices: [{ message: { content: "Ready." } }] })) : unavailable();
  });
  const result = await requestRequestyMessage(body, "fixture-key");
  assert.equal(requests.length, 5); assert.equal(result.attempts, 5); assert.equal(result.ok, recover);
  assert.ok(requests.every(request => JSON.stringify(request) === JSON.stringify(requests[0])));
  if (!recover) { assert.equal(result.status, 503); assert.equal(result.error, "LlmHttpError"); }
});

test("503 respects explicit attempt limits and the existing deadline", async t => {
  let calls = 0;
  t.mock.method(globalThis, "fetch", async () => { calls++; return unavailable(); });
  const bounded = await requestRequestyMessage(body, "fixture-key", false, null, { maxAttempts: 1 });
  assert.equal(bounded.attempts, 1); assert.equal(calls, 1);
  const expired = await requestRequestyMessage(body, "fixture-key", false, null, { deadlineAt: Date.now() - 1 });
  assert.equal(expired.error, "ProviderRetryBudgetExceeded"); assert.equal(calls, 1);
});

test("cancellation stops 503 retry and other transient errors retain two attempts", async t => {
  const controller = new AbortController(); let calls = 0;
  t.mock.method(globalThis, "fetch", async () => { calls++; controller.abort(); return unavailable(); });
  await assert.rejects(requestRequestyMessage(body, "fixture-key", false, null, { signal: controller.signal }), { code: "OPERATION_ABORTED" });
  assert.equal(calls, 1);
  t.mock.method(globalThis, "fetch", async () => { calls++; return new Response("Temporary error", { status: 500, headers: { "retry-after": "0" } }); });
  const result = await requestRequestyMessage(body, "fixture-key");
  assert.equal(result.attempts, 2); assert.equal(calls, 3);
});
