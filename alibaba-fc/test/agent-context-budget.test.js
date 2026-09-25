"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), jwt = require("jsonwebtoken");
const backend = require("../index.js"), agent = require("../side-chat-agent.js"), continuation = require("../agent-continuation.js");
const transcript = require("../../shared/conversation-transcript.js");
const model = "google/gemma-4-31b-it", question = "SurfDock有代码么？";
const call = i => ({ id: `read-${i}`, type: "function", function: { name: "retrieve_project_evidence", arguments: JSON.stringify({ query: `facet ${i}`, paper_ids: ["P1"] }) } });
const result = i => ({ ok: true, evidenceBundle: { scope: { type: "single_source", sourceIds: ["P1"] },
  resolvedRequirement: { freshness: "current", coverage: "targeted", granularity: "claim_support" },
  coverage: { requested: 1, included: 1, analyzed: 1, failed: 0, missing: 0, complete: false },
  gaps: ["Search is not proof of absence or exhaustive corpus coverage."], items: [{ sourceId: "P1", contentHash: "hash-v1", current: true, derived: false,
    evidenceKind: "original_passage", references: [{ sourceId: "P1", reference: "P1:p17:code", contentHash: "hash-v1", page: 17 }],
    content: `FACET-${i} Code availability. ` + "Evidence text. ".repeat(4200) + " TAIL-MARKER [[cite:P1:p17:code]]" }] } });
const reply = content => new Response(JSON.stringify({ choices: [{ message: typeof content === "string" ? { content } : content }] }));
function local() { return { version: 1, project: { workspaceId: "context-fixture" }, scope: { paperIds: ["P1"] }, files: [],
  agentLoop: { version: 1, answerLanguage: "zh", hardSelection: true },
  sourceMap: { sourceCounts: { papers: 1 }, paperSources: [{ sourceKind: "paper", sourceId: "P1", contentHash: "hash-v1", path: "literature/SurfDock.pdf", catalogStatus: "ready" }] } }; }
async function setup(t, respond) {
  const fs = require("node:fs/promises");
  const root = await fs.mkdtemp(require("node:path").join(require("node:os").tmpdir(), "agent-context-fixture-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const env = { JWT_SECRET: "context-fixture", ADMIN_ACCOUNT: "context-fixture", REQUESTY_API_KEY: "private-fixture-key", REQUESTY_MODEL: model,
    CONTEXT_ARCHIVE_DIR: root, CONTEXT_DEBUG: "1" };
  const before = Object.fromEntries(Object.keys(env).map(key => [key, process.env[key]])); Object.assign(process.env, env);
  t.after(() => { for (const key of Object.keys(env)) before[key] === undefined ? delete process.env[key] : process.env[key] = before[key]; });
  const requests = [], logs = [];
  t.mock.method(console, "info", (...args) => logs.push(args));
  t.mock.method(globalThis, "fetch", async (url, options) => {
    if (url.endsWith("/models")) return new Response(JSON.stringify({ data: [] }));
    const body = JSON.parse(options.body); requests.push(body); assert.equal(body.model, model);
    return respond(body, requests.length);
  });
  const payload = { mode: "side_chat", originalRequest: question, model, messages: [{ role: "user", content: question }],
    localWorkspaceContext: local(), conversationTranscript: transcript.normalize(), callContext: { turnId: "context-turn", callRole: "answer", profile: "medium" } };
  const token = jwt.sign({ account: env.ADMIN_ACCOUNT, role: "admin" }, env.JWT_SECRET);
  const send = async (extra = {}, transport) => {
    const response = await backend.handler({ httpMethod: "POST", path: "/chat", headers: { authorization: `Bearer ${token}` }, body: JSON.stringify({ ...payload, ...extra }) }, {}, transport);
    assert.equal(response.statusCode, 200, response.body); return JSON.parse(response.body);
  };
  return { send, requests, logs, root };
}
for (const reject of [false, true]) test(`signed desktop dispatch: complete results above old limit, provider compaction=${reject}`, async t => {
  let rejected = false;
  const f = await setup(t, body => {
    const tools = body.messages.filter(message => message.role === "tool");
    for (const tool of tools) {
      assert.ok(body.messages.some(message => message.tool_calls?.some(call => call.id === tool.tool_call_id)));
      const parsed = JSON.parse(tool.content);
      if (parsed.contextArchive) { assert.equal(parsed.omitted, true); assert.match(parsed.contextArchive, /^[a-f0-9]{64}$/); continue; }
      assert.equal(parsed.evidenceBundle.items[0].contentHash, "hash-v1");
      assert.deepEqual(parsed.evidenceBundle.scope.sourceIds, ["P1"]);
      if (!rejected) assert.equal(tool.content, JSON.stringify(result(Number(tool.tool_call_id.split("-")[1]))));
    }
    if (tools.length < 4) return reply({ tool_calls: [call(tools.length)] });
    if (!rejected) assert.ok(JSON.stringify(body.messages).length > 220000);
    if (reject && !rejected) {
      rejected = true;
      return new Response(JSON.stringify({ error: { code: "context_length_exceeded" } }), { status: 400 });
    }
    assert.ok(body.messages.some(message => message.content === question));
    return reply("当前证据中找到了源码说明。");
  });
  let data = await f.send();
  for (let i = 0; i < 4; i++) {
    assert.ok(data.desktopContinuation, JSON.stringify(data)); assert.equal(data.desktopToolCalls[0].id, call(i).id);
    data = await f.send({ desktopContinuation: data.desktopContinuation, desktopToolResults: [{ id: call(i).id, result: result(i) }] });
  }
  assert.equal(data.fallback, false); assert.equal(f.requests.length, reject ? 6 : 5);
  const saved = data.conversationTurn.messages.filter(message => message.role === "tool");
  // Persistence retains its established bounds; compaction never writes back its view.
  assert.deepEqual(saved.map(message => message.content), [0, 1, 2, 3].map(i => JSON.stringify(result(i))));
  const compactions = f.logs.filter(entry => entry[0] === "agent_context_compacted");
  assert.equal(compactions.length, reject ? 1 : 0);
  if (reject) {
    const final = f.requests.at(-1), previous = f.requests.at(-2);
    assert.ok(JSON.stringify(final).length < JSON.stringify(previous).length);
    for (const tool of final.messages.filter(message => message.role === "tool")) {
      const value = JSON.parse(tool.content);
      if (value.contextArchive) { assert.ok(value.omitted); assert.match(value.preview, /Code availability/); continue; }
      assert.match(value.evidenceBundle.items[0].content, /Code availability/);
      assert.equal(value.evidenceBundle.items[0].references[0].reference, "P1:p17:code");
      assert.equal(value.evidenceBundle.coverage.complete, false); assert.ok(value.evidenceBundle.gaps.length);
      assert.doesNotMatch(tool.content, /call the same|call the tool again/i);
    }
  }
  assert.doesNotMatch(JSON.stringify(f.logs), /FACET-|TAIL-MARKER|private-fixture-key/);
});

test("context classifier excludes output tokens, TPM, hard quotas and unrelated 400s", () => {
  for (const [status, code, message] of [[400, "max_tokens_exceeded", "output tokens exceed max_tokens"], [429, "context_length_exceeded", "tokens per minute"],
    [429, "insufficient_quota", "billing limit"], [400, "invalid_request", "too many tokens"], [400, "invalid_request", "bad tool parameters"]])
    assert.equal(backend._test.isVerifiedContextLengthError(status, JSON.stringify({ error: { code, message } })), false);
  for (const code of ["context_length_exceeded", "context_window_exceeded", "input_too_large"])
    assert.equal(backend._test.isVerifiedContextLengthError(400, JSON.stringify({ error: { code } })), true);
});

test("TPM backoff preserves request bytes and respects cancellation", async t => {
  let calls = 0;
  t.mock.method(globalThis, "fetch", async () => { calls++; return new Response(JSON.stringify({ error: { message: "Quota exceeded for metric: input_tokens_per_minute, limit: 500. Retry in 60s." } }), { status: 429 }); });
  const controller = new AbortController();
  const pending = backend._test.requestRequestyMessage({ model, messages: [{ role: "user", content: question }] }, "fixture", false, null,
    { stage: "local-tools", signal: controller.signal });
  setTimeout(() => controller.abort(), 10);
  await assert.rejects(pending, { code: "OPERATION_ABORTED" }); assert.equal(calls, 1);
});

test("repeated context rejection is specific and bounded; direct-answer path needs no retrieval", async t => {
  const f = await setup(t, () => new Response(JSON.stringify({ error: { code: "context_window_exceeded" } }), { status: 400 }));
  const data = await f.send();
  assert.equal(f.requests.length, 1); assert.equal(data.error, "ContextRecoveryIncomplete");
  assert.match(data.reply, /一个具体问题|一段文档|输出预留/);
  assert.ok(f.requests.every(request => !request.messages.some(message => message.role === "tool")));
});

test("local continuation transport limit is specific, not a provider rejection", () => {
  assert.throws(() => continuation.seal({ text: "x".repeat(700000) }, {}, "fixture"), error => error.code === "LOCAL_CONTEXT_TRANSPORT_LIMIT" && error.byteLimit === 700000);
});

test("structural retry prioritizes fresh evidence and preserves corpus accounting and exact citations", () => {
  const messages = [{ role: "system", content: "Hard scope P1; answer in Chinese; untrusted historical context." }, { role: "user", content: question },
    ...[0, 1, 2, 3].flatMap(i => [{ role: "assistant", tool_calls: [call(i)] }, { role: "tool", tool_call_id: call(i).id, content: JSON.stringify(result(i)) }])];
  const before = JSON.stringify(messages), compacted = agent.compactSideChatAgentMessages(messages, question, 30000);
  assert.equal(JSON.stringify(messages), before);
  const tools = compacted.filter(message => message.role === "tool").map(message => JSON.parse(message.content));
  assert.ok(tools.at(-1).evidenceBundle.items[0].content.length > tools[0].evidenceBundle.items[0].content.length);
  for (const item of tools) {
    assert.match(item.evidenceBundle.items[0].content, /\[\[cite:P1:p17:code\]\]/);
    assert.deepEqual(item.evidenceBundle.coverage, result(0).evidenceBundle.coverage);
  }
});

test("learned budget survives signed handoffs, preserves saved evidence, and proactively fits fresh results", async t => {
  let round = 0;
  const f = await setup(t, body => {
    round++;
    if (round === 1) return reply({ tool_calls: [call(0)] });
    if (round === 2) return new Response(JSON.stringify({ error: { code: "input_too_large" } }), { status: 413 });
    if (round === 3) return reply({ tool_calls: [call(1)] });
    if (round === 4) {
      const tools = body.messages.filter(message => message.role === "tool");
      assert.notEqual(tools[0].content, JSON.stringify(result(0)));
      assert.ok(JSON.parse(tools[1].content).contextArchive, "learned budget proactively offloads fresh evidence");
      return reply({ tool_calls: [call(2)] });
    }
    return reply("A general answer requires no project retrieval.");
  });
  let data = await f.send();
  for (let i = 0; i < 3; i++) data = await f.send({ desktopContinuation: data.desktopContinuation, desktopToolResults: [{ id: call(i).id, result: result(i) }] });
  assert.equal(data.fallback, false); assert.equal(f.requests.length, 5);
  assert.deepEqual(data.conversationTurn.messages.filter(message => message.role === "tool").map(message => message.content), [0, 1, 2].map(i => JSON.stringify(result(i))));
  assert.ok(f.logs.filter(entry => entry[0] === "agent_context_compacted").length >= 2);
  const next = await f.send({ originalRequest: "What is Bayesian optimization?", messages: [{ role: "user", content: "What is Bayesian optimization?" }], callContext: { turnId: "new-turn", callRole: "answer", profile: "medium" } });
  assert.equal(next.fallback, false); assert.ok(!f.requests.at(-1).messages.some(message => message.role === "tool"));
  assert.equal(f.logs.filter(entry => entry[0] === "agent_context_send").at(-1)[1].retryCount, 0);
});

test("retry delay is honored, large waits and billing quotas stop without compaction", async t => {
  const requests = [], times = [];
  t.mock.method(globalThis, "fetch", async (_url, options) => {
    requests.push(options.body); times.push(performance.now());
    return requests.length === 1 ? new Response(JSON.stringify({ error: { message: "Quota exceeded for metric: input_tokens_per_minute, limit: 500. Retry in 0.02s." } }), { status: 429 }) : reply("done");
  });
  const response = await backend._test.requestRequestyMessage({ model, messages: [{ role: "user", content: "math" }] }, "fixture", false, null, { stage: "local-tools" });
  assert.equal(response.ok, true); assert.equal(requests.length, 2); assert.equal(requests[0], requests[1]);
  assert.ok(times[1] - times[0] >= 18);
  for (const error of [{ code: "rate_limit_exceeded", message: "Retry in 121s." }, { code: "insufficient_quota", message: "Daily billing quota" }]) {
    let calls = 0;
    t.mock.method(globalThis, "fetch", async () => { calls++; return new Response(JSON.stringify({ error }), { status: 429 }); });
    const result = await backend._test.requestRequestyMessage({ model, messages: [] }, "fixture", false, null, { stage: "local-tools" });
    assert.equal(result.ok, false); assert.equal(calls, 1); assert.equal(result.verifiedContextLengthError, false);
  }
});

test("final-answer overflow without reducible history stops without resending identical input", async () => {
  let calls = 0;
  const result = await agent.runSideChatAgent({ conversationMessages: [{ role: "user", content: question }], originalRequest: question,
    workspaceContext: { localWorkspaceContext: local() }, systemPrompt: "Answer in Chinese.", model, parseFinalAnswer: reply => ({ reply }),
    resume: { step: 8, originalRequest: question, agentMessages: [{ role: "user", content: question }] },
    requestTurn: async request => {
      calls++; assert.deepEqual(request.tools, []); assert.ok(request.messages.some(message => message.content === question));
      return calls === 1 ? { ok: false, verifiedContextLengthError: true, status: 400, error: "LlmHttpError", attempts: 1 }
        : { ok: true, message: { content: "说明已有证据和限制。" }, attempts: 1 };
    } });
  assert.equal(calls, 1); assert.equal(result.ok, false); assert.equal(result.error, "ContextRecoveryIncomplete");
});

test("entering final-answer phase without new tool results does not renew consumed allowance", async () => {
  let calls = 0;
  const outcome = await agent.runSideChatAgent({ conversationMessages: [{ role: "user", content: question }], originalRequest: question,
    workspaceContext: { localWorkspaceContext: local() }, systemPrompt: "Answer in Chinese.", model, parseFinalAnswer: reply => ({ reply }),
    resume: { step: 8, originalRequest: question, agentMessages: [{ role: "user", content: question }],
      reactiveCompactionRetries: 1, contextCompaction: { toolResultCount: 0, trigger: "repeated-input-token-quota" } },
    requestTurn: async () => { calls++; return { ok: false, verifiedContextLengthError: true, status: 400, error: "LlmHttpError", attempts: 1 }; } });
  assert.equal(calls, 1);
  assert.equal(outcome.ok, false);
  assert.equal(outcome.semanticTelemetry.contextRecovery.compactions.length, 0);
  assert.equal(outcome.semanticTelemetry.contextRecovery.recoveryStopReason, "fixed_context_exceeds_budget");
});

test("repeated quota does not compact or make a third attempt", async t => {
  const f = await setup(t, (_body, count) => count === 1 ? reply({ tool_calls: [call(0)] }) : count <= 3 ? quotaResponse()
    : new Response(JSON.stringify({ error: { code: "context_length_exceeded" } }), { status: 400 }));
  const data = await handoff(f, await f.send());
  assert.equal(f.requests.length, 3);
  assert.equal(data.fallback, true);
  assert.equal(data.semanticTelemetry.contextRecovery.compactionCount, 0);
  assert.equal(data.semanticTelemetry.contextRecovery.attempts, 2);
  assert.deepEqual(f.requests[1], f.requests[2]);
});

const quotaResponse = (metric = "generate_content_input_token_count", limit = 12000, delay = 0, code) =>
  new Response(JSON.stringify({ error: { ...(code ? { code } : {}), message: `Quota exceeded for metric: ${metric}, limit: ${limit}. Please retry in ${delay}s.` } }),
    { status: 429, headers: { "retry-after": String(delay) } });
const signedState = data => JSON.parse(require("node:zlib").inflateSync(Buffer.from(data.desktopContinuation.split(".")[0], "base64url"))).state;
async function handoff(f, data, i = 0, transport) {
  assert.ok(data.desktopContinuation);
  return f.send({ desktopContinuation: data.desktopContinuation, desktopToolResults: [{ id: call(i).id, result: result(i) }] }, transport);
}
for (const ending of ["success", "quota", "network", "generic", "billing", "server"]) test(`repeated verified quota stops unchanged before hypothetical ${ending}`, async t => {
  const times = [];
  const f = await setup(t, (body, count) => {
    times.push(performance.now());
    if (count === 1) return reply({ tool_calls: [call(0)] });
    if (count <= 3) return quotaResponse(undefined, undefined, 0.02);
    if (ending === "quota") return quotaResponse();
    if (ending === "server") return new Response("Provider unavailable", { status: 503 });
    if (ending === "network") throw new Error("PRIVATE_PROVIDER_CONTENT");
    if (ending === "generic") return quotaResponse("requests_per_minute");
    if (ending === "billing") return quotaResponse("billing_credit", 0, 0, "insufficient_quota");
    return reply("找到当前证据，保留限制。");
  });
  const data = await handoff(f, await f.send());
  assert.equal(f.requests.length, 3, "one tool-selection call and two unchanged quota attempts");
  assert.deepEqual(f.requests[1], f.requests[2]);
  assert.ok(times[2] - times[1] >= 18, "provider cooldown honored");
  assert.equal(data.fallback, true);
  assert.equal(data.error, "LlmHttpError");
  assert.equal(data.semanticTelemetry.contextRecovery.compactionCount, 0);
  assert.equal(data.conversationTurn.messages.find(message => message.role === "tool").content, JSON.stringify(result(0)));
  assert.doesNotMatch(JSON.stringify(f.logs), /PRIVATE_PROVIDER_CONTENT|TAIL-MARKER|FACET-|private-fixture-key/);
});

for (const metric of ["generic", "requests_per_minute", "output_token_count", "input_token_per_day", "billing_credit", "input_tokens_requests", "invalid input_token_count"])
  test(`quota ${metric} never compacts`, async t => {
    const f = await setup(t, (_body, count) => count === 1 ? reply({ tool_calls: [call(0)] })
      : metric === "generic" ? new Response(JSON.stringify({ error: { message: "Rate limited. Retry in 0s." } }), { status: 429 }) : quotaResponse(metric));
    const data = await handoff(f, await f.send());
    assert.equal(f.requests.length, /per_day|billing/.test(metric) ? 2 : 3);
    assert.equal(data.fallback, true);
    assert.equal(f.logs.filter(entry => entry[0] === "agent_context_compacted").length, 0);
  });

for (const change of ["metric", "limit", "first-generic"]) test(`a changed/unverified quota (${change}) is not repeated-quota evidence`, async t => {
  const f = await setup(t, (_body, count) => count === 1 ? reply({ tool_calls: [call(0)] })
    : quotaResponse(change === "first-generic" && count === 2 ? "request_count" : change === "metric" && count === 3 ? "other_input_token_count" : undefined,
      change === "limit" && count === 3 ? 14000 : 12000));
  const data = await handoff(f, await f.send());
  assert.equal(f.requests.length, 3); assert.equal(data.error, "LlmHttpError");
  assert.equal(f.logs.filter(entry => entry[0] === "agent_context_compacted").length, 0);
});

for (const first of ["quota", "context"]) test(`${first} recovery renews allowance only after new signed tool results, preserves evidence and resets next turn`, async t => {
  const f = await setup(t, (body, count) => {
    const contextError = () => new Response(JSON.stringify({ error: { code: "context_length_exceeded" } }), { status: 400 });
    if (count === 1) return reply({ tool_calls: [call(0)] });
    if (first === "quota") {
      if ([2, 3].includes(count)) return quotaResponse();
      if (count === 4) return reply({ tool_calls: [call(1)] });
      if (count === 5) return contextError();
    } else {
      if (count === 2) return contextError();
      if (count === 3) return reply({ tool_calls: [call(1)] });
      if ([4, 5].includes(count)) return quotaResponse();
    }
    return reply("General answer without local retrieval.");
  });
  const middle = await handoff(f, await f.send());
  if (first === "quota") {
    assert.equal(middle.fallback, true); assert.equal(f.requests.length, 3);
    assert.equal(middle.semanticTelemetry.contextRecovery.compactionCount, 0);
    return;
  }
  const state = signedState(middle);
  assert.equal(state.reactiveCompactionRetries, 1);
  assert.ok(state.contextRecovery.accepted > 0);
  assert.equal(state.contextCompaction.trigger, "context-recovery");
  const data = await handoff(f, middle, 1);
  assert.equal(f.requests.length, 5, JSON.stringify(f.logs.filter(entry => entry[0] === "agent_context_recovery"))); assert.equal(data.fallback, true);
  assert.deepEqual(f.requests[3], f.requests[4], "quota retry preserves pending evidence");
  assert.deepEqual(data.conversationTurn.messages.filter(message => message.role === "tool").map(message => message.content), [JSON.stringify(result(0)), JSON.stringify(result(1))]);
});

test("no meaningful safe reduction stops after unchanged quota retry without spending allowance", async t => {
  const f = await setup(t, () => quotaResponse());
  const data = await f.send();
  assert.equal(f.requests.length, 2); assert.equal(data.error, "LlmHttpError");
  assert.equal(data.failure.recoveryStopReason, "adapter_attempts_exhausted");
  assert.ok(!f.requests[0].messages.some(message => message.role === "tool"));
  assert.equal(f.logs.filter(entry => entry[0] === "agent_context_compacted").length, 0);
});

test("remaining transport deadline prevents the third quota attempt without resetting the clock", async t => {
  const f = await setup(t, (_body, count) => count === 1 ? reply({ tool_calls: [call(0)] }) : quotaResponse(undefined, undefined, count === 2 ? 0 : 3));
  const data = await handoff(f, await f.send(), 0, { deadlineAt: Date.now() + 2000 });
  assert.equal(f.requests.length, 3); assert.equal(data.error, "LlmHttpError");
  assert.equal(data.failure.recoveryStopReason, "adapter_attempts_exhausted");
  assert.equal(data.failure.providerAttempts, 2);
});

test("an expired time budget makes zero provider calls; a cooldown that cannot fit makes no unchanged retry", async t => {
  let calls = 0;
  t.mock.method(globalThis, "fetch", async () => { calls++; return quotaResponse(undefined, undefined, 60); });
  const request = { model, messages: [] };
  const expired = await backend._test.requestRequestyMessage(request, "fixture", false, null, { deadlineAt: Date.now() - 1 });
  assert.equal(calls, 0); assert.equal(expired.error, "ProviderRetryBudgetExceeded");
  const result = await backend._test.requestRequestyMessage(request, "fixture", false, null, { deadlineAt: Date.now() + 1000 });
  assert.equal(calls, 1); assert.equal(result.attempts, 1); assert.equal(result.recoveryStopReason, "time_budget_exhausted");
});

test("cancellation during compacted retry cooldown never starts a third provider attempt", async t => {
  let calls = 0;
  const controller = new AbortController();
  t.mock.method(globalThis, "fetch", async () => { calls++; return reply("not expected"); });
  const pending = backend._test.requestRequestyMessage({ model, messages: [] }, "fixture", false, null,
    { maxAttempts: 1, attemptOffset: 2, retryAfterMs: 60000, signal: controller.signal });
  controller.abort(); await assert.rejects(pending, { code: "OPERATION_ABORTED" }); assert.equal(calls, 0);
});

for (const rejections of [0, 1, 2]) test(`added-paper follow-up with saved evidence: billing boilerplate, ${rejections} input-quota rejections`, async t => {
  const followup = "我新加了文献，更新一下综述。";
  const saved = transcript.upsert(null, { turnId: "prior-review", workspaceId: "context-fixture", model, status: "completed",
    bindings: [{ handle: "P1", identity: "source:P1", sourceId: "P1", version: "hash-v1", current: true }],
    messages: [{ role: "user", content: "帮我总结所有文献，写个综述。" }, { role: "assistant", tool_calls: [call(0)] },
      { role: "tool", tool_call_id: call(0).id, name: call(0).function.name, content: JSON.stringify(result(0)) },
      { role: "assistant", content: "早期综述；这不是新增文献的证据。" }] });
  const originalSaved = JSON.stringify(saved);
  const f = await setup(t, (body, count) => {
    assert.ok(body.messages.some(message => message.content === followup));
    assert.ok(body.messages.some(message => message.content === "帮我总结所有文献，写个综述。"));
    const tool = body.messages.find(message => message.role === "tool");
    assert.ok(tool); const view = JSON.parse(tool.content);
    assert.equal(view.evidenceBundle.items[0].contentHash, "hash-v1");
    assert.deepEqual(view.evidenceBundle.scope.sourceIds, ["P1"]);
    assert.equal(view.evidenceBundle.items[0].references[0].reference, "P1:p17:code");
    if (count <= rejections) return new Response(JSON.stringify({ error: { code: 429, status: "RESOURCE_EXHAUSTED",
      message: "You exceeded your current quota, please check your plan and billing details. For more information on this error, head to: https://ai.google.dev/gemini-api/docs/rate-limits.\n" +
        "Quota exceeded for metric: generativelanguage.googleapis.com/generate_content_paid_tier_3_input_token_count, limit: 16000. Please retry in 0.002s.",
      details: [{ "@type": "type.googleapis.com/google.rpc.RetryInfo", retryDelay: "0.002s" }] } }), { status: 429 });
    return reply("保留先前综述；当前证据尚不能证明已完成新增文献的检查。");
  });
  const data = await f.send({ originalRequest: followup, messages: [{ role: "user", content: followup }], conversationTranscript: saved });
  assert.equal(data.fallback, rejections === 2); assert.equal(f.requests.length, Math.min(2, rejections + 1));
  assert.equal(data.semanticTelemetry.historicalReplay.toolResults, 1);
  assert.deepEqual(data.semanticTelemetry.modelToolCapabilities, [], "historical replay never reruns retrieval");
  assert.equal(JSON.stringify(saved), originalSaved);
  assert.equal(f.requests[0].messages.find(message => message.role === "tool").content, JSON.stringify(result(0)));
  assert.equal(f.logs.filter(entry => entry[0] === "agent_context_compacted").length, 0);
  if (rejections >= 1) assert.deepEqual(f.requests[0].messages, f.requests[1].messages);
  if (rejections === 2) assert.equal(data.error, "LlmHttpError");
  assert.ok(f.logs.filter(entry => entry[0] === "requesty_provider_failure").every(entry => entry[1].quotaClassificationReason === "verified_input_token_quota"));
});

test("production summaries omit agent tools and current images; the final retry retains the image and user request", async t => {
  const image = { name: "pixel.png", dataUrl: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jC1kAAAAASUVORK5CYII=" };
  const saved = transcript.upsert(null, { turnId: "prior-image-context", workspaceId: "context-fixture", model, status: "completed",
    bindings: [{ handle: "P1", identity: "source:P1", sourceId: "P1", version: "hash-v1", current: true }],
    messages: [{ role: "user", content: "Goal: inspect P1 without writing." }, { role: "assistant", content: "PRIVATE_HISTORY " + "Verified source finding. ".repeat(2300) }] });
  let main = 0, summaries = 0;
  const f = await setup(t, body => {
    if (body.messages[0].content.startsWith("Create a factual working-state checkpoint")) {
      summaries++;
      return reply("Goal inspect P1. Constraint never write. Verified source finding. Next: answer the latest question.");
    }
    main++;
    assert.ok(JSON.stringify(body.messages).includes(image.dataUrl));
    assert.ok(JSON.stringify(body.messages).includes(question));
    if (main === 1) return new Response(JSON.stringify({ error: { code: "context_length_exceeded", max_input_tokens: 16000 } }), { status: 400 });
    return reply("已保留约束并检查当前图像。");
  });
  const data = await f.send({ conversationTranscript: saved, images: [image] });
  assert.equal(data.fallback, false, JSON.stringify(data)); assert.equal(main, 2); assert.ok(summaries >= 1);
  for (const body of f.requests.filter(request => request.messages[0].content.startsWith("Create a factual working-state checkpoint"))) {
    assert.equal(body.tools, undefined); assert.equal(body.messages.length, 2);
    assert.doesNotMatch(JSON.stringify(body), /data:image|Original user request:/);
    assert.ok(body.max_tokens <= 2048);
  }
  assert.ok(data.conversationTurn.contextCheckpoints.length);
  assert.doesNotMatch(JSON.stringify(f.logs), /PRIVATE_HISTORY|data:image|Verified source finding/);
});

test("a current user message beyond the UI transcript limit reaches the provider intact and is archived exactly", async t => {
  const request = "Essential constraints: " + "Do not modify sources. ".repeat(3300) + " FINAL_REQUIRED_IDENTIFIER";
  const f = await setup(t, body => {
    assert.ok(body.messages.some(message => message.role === "user" && message.content === request));
    return reply("Constraints retained.");
  });
  const data = await f.send({ originalRequest: request, messages: [{ role: "user", content: request }] });
  assert.equal(data.fallback, false);
  const archive = data.conversationTurn.transcriptArchive; assert.ok(archive);
  const fs = require("node:fs/promises"), path = require("node:path");
  const [account] = await fs.readdir(path.join(f.root, "accounts"));
  const original = JSON.parse(await fs.readFile(path.join(f.root, "accounts", account, "sessions", archive.session, archive.reference + ".txt"), "utf8"));
  assert.equal(original[0].content, request);
  assert.equal(original.at(-1).content, "Constraints retained.");
});
