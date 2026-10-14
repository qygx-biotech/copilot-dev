"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { once } = require("node:events");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");

const nemotron = "nvidia/nemotron-3-nano-omni-30b-a3b-reasoning";
Object.assign(process.env, {
  JWT_SECRET: "model-turn-fixture-secret", ADMIN_ACCOUNT: "model-turn-admin",
  REQUESTY_API_KEY: "admin-private-requesty-key", REQUESTY_MODEL: "fixture/proxy-model",
  REQUESTY_MODEL_CAPABILITIES_JSON: JSON.stringify({
    "fixture/proxy-model": { supportsTools: true, supportsImages: false, supportsWebSearch: false },
    [nemotron]: { supportsTools: false, supportsImages: true, supportsWebSearch: false },
  }),
  BETA_USERS_JSON: JSON.stringify([{ id: "beta01", account: "scientist-1", passwordHash: bcrypt.hashSync("unused", 4), requestyKeyEnv: "REQUESTY_KEY_BETA01", active: true }]),
  REQUESTY_KEY_BETA01: "beta-one-private-key",
});
const backend = require("../index.js");
const adapter = require("../src/index.js");
const modelTurn = require("../model-turn.js");
const { overflow } = require("../context-recovery.js");
const { inputQuota } = require("../input-quota.js");
const { readEvents } = require("../../shared/event-stream.js");

const adminToken = jwt.sign({ account: process.env.ADMIN_ACCOUNT, role: "admin" }, process.env.JWT_SECRET);
const betaToken = jwt.sign({ id: "beta01", account: "scientist-1", role: "beta" }, process.env.JWT_SECRET, { subject: "beta01" });
// The local HTTP adapter is reached with the real fetch; provider calls are mocked.
const clientFetch = globalThis.fetch;
const providerRequests = [], providerReplies = [];
const json = (value, status = 200, headers = {}) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json", ...headers } });
const completion = (message, usage = { prompt_tokens: 20, completion_tokens: 5, total_tokens: 25 }) =>
  json({ choices: [{ message, finish_reason: message.tool_calls ? "tool_calls" : "stop" }], usage });
global.fetch = async (url, options = {}) => {
  if (String(url).endsWith("/v1/models")) return json({ data: [] });
  providerRequests.push({ url: String(url), key: options.headers?.Authorization, body: JSON.parse(options.body) });
  const reply = providerReplies.shift() || completion({ content: "Proxied answer." });
  return typeof reply === "function" ? reply() : reply;
};
const reset = () => { providerRequests.length = 0; providerReplies.length = 0; };
const turnBody = (extra = {}) => ({ version: 1, messages: [{ role: "user", content: "Summarize the evidence." }], ...extra });
const call = (body, { token = adminToken, transport } = {}) => backend.handler({ httpMethod: "POST", path: "/api/model/turn",
  headers: token ? { authorization: `Bearer ${token}` } : {}, body: typeof body === "string" ? body : JSON.stringify(body) }, {}, transport);
const parsed = response => JSON.parse(response.body);
const withEnv = async (values, run) => {
  const previous = Object.fromEntries(Object.keys(values).map(key => [key, process.env[key]]));
  Object.assign(process.env, values);
  try { return await run(); }
  finally { for (const [key, value] of Object.entries(previous)) value === undefined ? delete process.env[key] : process.env[key] = value; }
};

test("requests without a valid FC session are rejected before any provider call", async () => {
  reset();
  for (const token of [null, "not-a-token", jwt.sign({ account: "intruder", role: "admin" }, "other-secret")]) {
    const response = await call(turnBody(), { token });
    assert.equal(response.statusCode, 401);
    assert.equal(parsed(response).error, "Unauthorized");
  }
  assert.equal(providerRequests.length, 0);
});

test("beta users are served with their own server-held Requesty key, which never reaches the client", async () => {
  reset();
  providerReplies.push(json({ error: { message: "Invalid key beta-one-private-key" } }, 401));
  const response = await call(turnBody({ retry: { maxAttempts: 1 } }), { token: betaToken });
  assert.equal(providerRequests[0].key, "Bearer beta-one-private-key");
  assert.doesNotMatch(response.body, /beta-one-private-key|admin-private-requesty-key/);
  await withEnv({ REQUESTY_KEY_BETA01: "" }, async () => {
    const missing = await call(turnBody(), { token: betaToken });
    assert.equal(missing.statusCode, 503);
    assert.equal(parsed(missing).error, "BETA_REQUESTY_KEY_MISSING");
  });
  assert.equal(providerRequests.length, 1);
});

test("only selectable models are accepted and the default resolves to the configured model", async () => {
  reset();
  for (const model of ["unapproved/expensive-model", 123, ""]) {
    const response = await call(turnBody({ model }));
    assert.equal(response.statusCode, 400);
    assert.equal(parsed(response).error, "INVALID_CHAT_MODEL");
  }
  assert.equal(providerRequests.length, 0);
  for (const [model, expected] of [[undefined, "fixture/proxy-model"], ["default", "fixture/proxy-model"], [nemotron, nemotron]]) {
    reset();
    const response = await call(turnBody(model === undefined ? {} : { model }));
    assert.equal(response.statusCode, 200);
    assert.equal(parsed(response).model, expected);
    assert.equal(providerRequests[0].body.model, expected);
  }
});

test("requests needing a capability the model lacks are rejected before any provider call", async () => {
  reset();
  const image = { role: "user", content: [{ type: "text", text: "Describe." }, { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } }] };
  const tool = { type: "function", function: { name: "list_papers", parameters: { type: "object", properties: {} } } };
  for (const [body, capability] of [[turnBody({ messages: [image] }), "images"], [turnBody({ model: nemotron, tools: [tool] }), "tools"],
    [turnBody({ tools: [{ type: "web_search" }] }), "web_search"]]) {
    const response = await call(body);
    assert.equal(response.statusCode, 400);
    assert.deepEqual([parsed(response).error, parsed(response).capability, parsed(response).origin], ["MODEL_CAPABILITY_UNAVAILABLE", capability, "proxy"]);
  }
  assert.equal(providerRequests.length, 0);
  const accepted = await call(turnBody({ model: nemotron, messages: [image] }));
  assert.equal(accepted.statusCode, 200);
});

test("the provider receives the caller's messages and tools unchanged: no prompts, loop or tool execution", async () => {
  reset();
  const messages = [
    { role: "system", content: "Caller-owned instructions." },
    { role: "user", content: "List papers." },
    { role: "assistant", content: null, reasoning_content: "opaque reasoning", extra_content: { google: { thought_signature: "sig" } },
      tool_calls: [{ id: "call-1", type: "function", function: { name: "list_papers", arguments: "{}" }, extra_content: { google: { thought_signature: "call-sig" } } }] },
    { role: "tool", tool_call_id: "call-1", name: "list_papers", content: "[]" },
  ];
  const tools = [{ type: "function", function: { name: "list_papers", description: "List.", parameters: { type: "object", properties: {} } } }];
  providerReplies.push(completion({ content: null, tool_calls: [{ id: "call-2", type: "function", function: { name: "list_papers", arguments: "{}" } }] }));
  const response = await call(turnBody({ messages, tools, temperature: 0.2, max_tokens: 512, stage: "local-tools",
    callContext: { turnId: "turn-1", workflowId: "", callRole: "answer", paperId: "", profile: "light" } }));
  const data = parsed(response);
  assert.equal(providerRequests.length, 1, "A tool call is returned to the caller, never executed or continued");
  assert.deepEqual(providerRequests[0].body.messages, messages);
  assert.deepEqual(providerRequests[0].body.tools, tools);
  assert.equal(providerRequests[0].body.max_tokens, 512);
  assert.deepEqual(providerRequests[0].body.requesty.tags, ["biodesign:answer", "profile:light"]);
  for (const key of ["version", "stage", "surface", "retry", "callContext", "stream"]) assert.ok(!(key in providerRequests[0].body), key);
  assert.equal(data.ok, true);
  assert.equal(data.result.message.tool_calls[0].id, "call-2");
  assert.equal(data.result.usage.total_tokens, 25);
  assert.equal(data.capabilities.supportsTools, true);
});

test("request shape and size limits are enforced before any provider call", async () => {
  reset();
  const cases = [
    [turnBody({ unexpected: true }), 400, "INVALID_MODEL_TURN"],
    [{ messages: [{ role: "user", content: "x" }] }, 400, "INVALID_MODEL_TURN"],
    ["{not json", 400, "INVALID_MODEL_TURN"],
    [turnBody({ messages: [] }), 400, "INVALID_MODEL_TURN"],
    [turnBody({ messages: [{ role: "developer", content: "x" }] }), 400, "INVALID_MODEL_TURN"],
    [turnBody({ messages: [{ role: "tool", content: "x" }] }), 400, "INVALID_MODEL_TURN"],
    [turnBody({ max_tokens: modelTurn.LIMITS.maxTokens + 1 }), 400, "INVALID_MODEL_TURN"],
    [turnBody({ temperature: 3 }), 400, "INVALID_MODEL_TURN"],
    [turnBody({ retry: { maxAttempts: 9 } }), 400, "INVALID_MODEL_TURN"],
    [turnBody({ callContext: { turnId: "t", workflowId: "", callRole: "answer", paperId: "", profile: "light", extra: 1 } }), 400, "INVALID_CALL_CONTEXT"],
    [turnBody({ tools: Array.from({ length: modelTurn.LIMITS.tools + 1 }, (_, i) => ({ type: "function", function: { name: `tool_${i}` } })) }), 400, "INVALID_MODEL_TURN"],
    [turnBody({ messages: Array.from({ length: modelTurn.LIMITS.messages + 1 }, () => ({ role: "user", content: "x" })) }), 413, "MODEL_TURN_TOO_LARGE"],
    [turnBody({ messages: [{ role: "user", content: "x".repeat(modelTurn.LIMITS.messageBytes) }] }), 413, "MODEL_TURN_TOO_LARGE"],
    [turnBody({ messages: [{ role: "user", content: "x".repeat(modelTurn.LIMITS.requestBytes) }] }), 413, "MODEL_TURN_TOO_LARGE"],
    [turnBody({ model: nemotron, messages: [{ role: "user", content: Array.from({ length: modelTurn.LIMITS.images + 1 }, () => ({ type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } })) }] }), 413, "MODEL_TURN_TOO_LARGE"],
  ];
  for (const [body, status, error] of cases) {
    const response = await call(body);
    assert.equal(response.statusCode, status, error);
    assert.equal(parsed(response).error, error);
    assert.equal(parsed(response).origin, "proxy");
  }
  assert.equal(providerRequests.length, 0);
});

// Each provider failure must classify on the client exactly as the result the
// in-FC loop receives from requestRequestyMessage today.
const failures = {
  context_overflow: () => json({ error: { code: "context_length_exceeded", message: "This model's maximum context length is 128000 tokens. However, your messages resulted in 130500 tokens." } }, 400),
  input_quota: () => json({ error: { code: 429, status: "RESOURCE_EXHAUSTED",
    message: "Quota exceeded for metric: generativelanguage.googleapis.com/generate_content_paid_tier_input_token_count, limit: 16000. Please retry in 58s.",
    details: [{ "@type": "type.googleapis.com/google.rpc.QuotaFailure", violations: [{ quotaMetric: "generativelanguage.googleapis.com/generate_content_paid_tier_input_token_count", quotaValue: "16000" }] },
      { "@type": "type.googleapis.com/google.rpc.RetryInfo", retryDelay: "58s" }] } }, 429, { "retry-after": "58" }),
  rate_limit: () => json({ error: { message: "Too many requests for this model." } }, 429, { "retry-after": "7" }),
  auth: () => json({ error: { message: "Invalid API key admin-private-requesty-key" } }, 401),
  transport: () => { throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNRESET" } }); },
};
for (const [expected, reply] of Object.entries(failures)) {
  test(`${expected} failures keep the existing classification on the client`, async () => {
    reset();
    providerReplies.push(reply);
    const response = await call(turnBody({ retry: { maxAttempts: 1 } }));
    assert.equal(response.statusCode, 200);
    const data = parsed(response);
    assert.deepEqual([data.ok, data.origin, data.category], [false, "provider", expected]);
    assert.doesNotMatch(response.body, /admin-private-requesty-key/);
    providerReplies.push(reply);
    const direct = await backend._test.requestRequestyMessage({ model: "fixture/proxy-model", messages: turnBody().messages, max_tokens: 8192 },
      process.env.REQUESTY_API_KEY, false, null, { toolMode: "sequential", stage: "model", deferInputTokenRateLimit: true, maxAttempts: 1, deadlineAt: Date.now() + 60000 });
    const proxied = data.result;
    assert.deepEqual(overflow(proxied), overflow(direct));
    assert.deepEqual(inputQuota(proxied), inputQuota(direct));
    for (const key of ["error", "status", "errorCategory", "rateLimit", "verifiedContextLengthError", "terminalProviderFailure", "recoveryStopReason"]) {
      assert.deepEqual(proxied[key], JSON.parse(JSON.stringify({ value: direct[key] })).value, key);
    }
    if (expected === "input_quota") assert.equal(proxied.inputQuota.retryAfterMs, 58000);
    if (expected === "rate_limit") assert.equal(proxied.rateLimit.retryAfterMs, 7000);
    if (expected === "context_overflow") assert.equal(overflow(proxied).limit, 128000);
  });
}


const sse = text => new Response(text, { headers: { "content-type": "text/event-stream" } });
const frame = value => `data: ${JSON.stringify(value)}\n\n`;
async function serverFixture(run) {
  const server = http.createServer(adapter);
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  try { await run(`http://127.0.0.1:${server.address().port}`); }
  finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
}
async function streamTurn(url, body) {
  const response = await clientFetch(url + "/api/model/turn", { method: "POST", body: JSON.stringify(body),
    headers: { Authorization: `Bearer ${adminToken}`, "content-type": "application/json" } });
  assert.match(response.headers.get("content-type"), /text\/event-stream/);
  const events = [];
  await readEvents(response, event => { events.push({ type: event.event, data: JSON.parse(event.data) }); });
  return events;
}

test("Chat Completions streams deltas, completed tool calls, usage and a final result over SSE", async () => {
  reset();
  providerReplies.push(sse(frame({ choices: [{ index: 0, delta: { content: "Checking " } }] }) +
    frame({ choices: [{ index: 0, delta: { content: "papers.", tool_calls: [{ index: 0, id: "call-9", type: "function", function: { name: "list_papers", arguments: "{}" } }] } }] }) +
    frame({ choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] }) +
    frame({ choices: [], usage: { prompt_tokens: 40, completion_tokens: 6, total_tokens: 46 } }) + "data: [DONE]\n\n"));
  await serverFixture(async url => {
    const events = await streamTurn(url, turnBody({ tools: [{ type: "function", function: { name: "list_papers", parameters: { type: "object", properties: {} } } }] }));
    assert.deepEqual(events.map(event => event.type), ["status", "delta", "delta", "tool-call", "usage", "final"]);
    assert.equal(events.filter(event => event.type === "delta").map(event => event.data.text).join(""), "Checking papers.");
    assert.deepEqual(events[3].data, { id: "call-9", name: "list_papers", arguments: "{}" });
    assert.equal(events[4].data.usage.total_tokens, 46);
    const final = events.at(-1).data;
    assert.equal(final.ok, true);
    assert.equal(final.result.message.tool_calls[0].id, "call-9");
  });
  assert.equal(providerRequests[0].body.stream, true);
  assert.deepEqual(providerRequests[0].body.stream_options, { include_usage: true });
});

test("a provider stream that ends early is reported as a classified transport failure, not an answer", async () => {
  reset();
  providerReplies.push(sse(frame({ choices: [{ index: 0, delta: { content: "partial" } }] })));
  await serverFixture(async url => {
    const events = await streamTurn(url, turnBody());
    const final = events.at(-1);
    assert.equal(final.type, "final");
    assert.deepEqual([final.data.ok, final.data.category, final.data.result.error], [false, "transport", "STREAM_INTERRUPTED"]);
  });
});

test("stream:false and buffered deployments return the same result as JSON", async () => {
  reset();
  let started = false;
  const response = await call(turnBody({ stream: false }), { transport: { start: async () => { started = true; }, emit: async () => {} } });
  assert.equal(started, false);
  assert.equal(response.statusCode, 200);
  assert.equal(parsed(response).result.message.content, "Proxied answer.");
  assert.equal(providerRequests[0].body.stream, undefined);
});

test("a configured Responses adapter streams completed function calls and uses its own server-held key", async () => {
  reset();
  const item = { type: "function_call", id: "fc_1", call_id: "call_native", name: "list_papers", arguments: "{}", status: "completed" };
  providerReplies.push(sse([{ type: "response.created", response: { id: "resp_1" } }, { type: "response.output_text.delta", delta: "Looking." },
    { type: "response.output_item.done", output_index: 0, item },
    { type: "response.completed", response: { id: "resp_1", status: "completed", output: [item], usage: { input_tokens: 12, output_tokens: 4, total_tokens: 16 } } }].map(frame).join("")));
  await withEnv({ NATIVE_FIXTURE_KEY: "native-private-key", AGENT_PROVIDER_ADAPTERS_JSON: JSON.stringify({ "fixture/proxy-model": {
    api: "responses", endpoint: "https://native.example/v1/responses", model: "native-model", apiKeyEnv: "NATIVE_FIXTURE_KEY", supportsTools: true } }) }, async () => {
    await serverFixture(async url => {
      const events = await streamTurn(url, turnBody({ tools: [{ type: "function", function: { name: "list_papers", parameters: { type: "object", properties: {} } } }] }));
      assert.deepEqual(events.map(event => event.type), ["delta", "tool-call", "usage", "final"]);
      assert.equal(events[1].data.id, "call_native");
      assert.equal(events[1].data.responseId, "resp_1");
      const final = events.at(-1).data;
      assert.deepEqual([final.ok, final.api], [true, "responses"]);
      assert.doesNotMatch(JSON.stringify(events), /native-private-key/);
    });
  });
  assert.equal(providerRequests[0].url, "https://native.example/v1/responses");
  assert.equal(providerRequests[0].key, "Bearer native-private-key");
  assert.equal(providerRequests[0].body.model, "native-model");
});

test("usage is logged per user without the account name or credentials", async t => {
  reset();
  const logs = [];
  t.mock.method(console, "info", (name, data) => { if (name === "model_turn_usage") logs.push(data); });
  await call(turnBody({ stage: "context-summary" }));
  await call(turnBody(), { token: betaToken });
  assert.equal(logs.length, 2);
  assert.match(logs[0].user, /^[a-f0-9]{32}$/);
  assert.notEqual(logs[0].user, logs[1].user);
  assert.deepEqual([logs[0].stage, logs[0].ok, logs[0].usageReported], ["context-summary", true, true]);
  assert.deepEqual(logs[0].usage, { prompt_tokens: 20, completion_tokens: 5, total_tokens: 25 });
  assert.doesNotMatch(JSON.stringify(logs), /model-turn-admin|scientist-1|private-key|private-requesty-key/);
});

test("the optional daily token cap is off by default and, when set, blocks only the capped user", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "model-turn-cap-"));
  try {
    assert.equal(modelTurn.capFromEnv({}), null);
    reset();
    await call(turnBody());
    assert.deepEqual(await fs.readdir(dir), [], "No ledger is written while the cap is unset");
    await withEnv({ MODEL_PROXY_DAILY_TOKEN_CAP: "40", MODEL_PROXY_USAGE_DIR: dir }, async () => {
      reset();
      assert.equal((await call(turnBody())).statusCode, 200);
      assert.equal((await call(turnBody())).statusCode, 200, "Usage below the cap admits one more call");
      const blocked = await call(turnBody());
      assert.equal(blocked.statusCode, 429);
      const body = parsed(blocked);
      assert.deepEqual([body.error, body.origin, body.cap, body.used], ["USER_TOKEN_CAP_EXCEEDED", "proxy", 40, 50]);
      assert.ok(body.retryAfterMs > 0 && body.retryAfterMs <= 86400000);
      assert.equal(providerRequests.length, 2);
      assert.equal((await call(turnBody(), { token: betaToken })).statusCode, 200, "Other users keep their own allowance");
    });
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});
