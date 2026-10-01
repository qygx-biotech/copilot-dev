"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs/promises"), os = require("node:os"), path = require("node:path");
const { inputQuota, QuotaLedger } = require("../input-quota.js");
const { ContextRecovery } = require("../context-recovery.js");
const ok = content => ({ ok: true, message: { role: "assistant", content }, attempts: 1 });
const rejection = (details = {}, headers = {}) => ({ ok: false, status: 429, attempts: 1, headers,
  error: { code: "input_token_quota_exceeded", details: { retry_after_ms: 0, ...details } } });
const history = () => [{ role: "system", content: "Never modify source files." }, { role: "user", content: "Goal: inspect P1" },
  { role: "assistant", content: "Verified P1:v2.\n".repeat(2200) }];
const pending = () => [{ role: "user", content: "Correction: only report; preserve exact ID P1:v2." },
  { role: "assistant", tool_calls: [{ id: "pending-1", type: "function", function: { name: "retrieve", arguments: '{"id":"P1:v2"}' } }] },
  { role: "tool", tool_call_id: "pending-1", content: "Fresh verified evidence." }];
async function fixture(t, config = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "quota-recovery-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  let time = 1800000000000;
  const waits = [], logs = [];
  const options = { model: "a", provider: "requesty", endpoint: "fixture", account: "account", now: () => time, monotonic: () => time,
    sleep: async ms => { waits.push(ms); time += ms; }, logger: { info: (_, entry) => logs.push(entry) },
    config: { root, outputTokens: 256, summaryTokens: 256, safety: 32, providerCallMs: 10000, debug: true, ...config } };
  const manager = new ContextRecovery(options);
  return { manager, options, logs, waits, advance: ms => time += ms, now: () => time };
}

test("quota classification prefers structured input measurements and never calls aggregate usage request input", () => {
  const q = inputQuota(rejection({ quotaMetric: "generate_content_input_tokens_per_minute", quotaValue: "16000", used: 15700,
    remaining_tokens: 300, request_input_tokens: 1200, scope: "project", quotaDimensions: { project: "p", model: "a" } }));
  assert.equal(q.capacity, 16000); assert.equal(q.remaining, 300); assert.equal(q.requestTokens, 1200);
  assert.equal(q.period, "minute"); assert.equal(q.scope, "project"); assert.equal(q.modelScoped, true);
  assert.equal(q.evidence, "structured_input_metric"); assert.equal(q.includesOutput, false);
  const noNumbers = inputQuota(rejection({ used: 999999, retry_after_ms: 58000 }));
  assert.equal(noNumbers.capacity, null); assert.equal(noNumbers.remaining, null); assert.equal(noNumbers.requestTokens, null);
  assert.equal(noNumbers.period, null); assert.equal(noNumbers.retryAfterMs, 58000);
  assert.equal(inputQuota({ status: 429, error: { message: "Input token quota exhausted" } }).evidence, "explicit_input_quota_message");
  assert.equal(inputQuota({ status: 429, error: { message: "Quota exceeded for metric: input_token_per_day, limit: 0" } }).capacity, 0);
});

test("headers and nested Google errors preserve reported reset, scope and delays", () => {
  const now = 1800000000000;
  const q = inputQuota({ status: 429, headers: new Headers({ "anthropic-ratelimit-input-tokens-remaining": "0",
    "anthropic-ratelimit-input-tokens-limit": "12000", "anthropic-ratelimit-input-tokens-reset": new Date(now + 5000).toISOString(), "retry-after": "2" }) }, now);
  assert.equal(q.resetAt, now + 5000); assert.equal(q.retryAfterMs, 2000); assert.equal(q.period, null);
  const nested = inputQuota({ status: 429, error: { metadata: { raw: JSON.stringify({ error: { details: [
    { violations: [{ quotaMetric: "service/input_token_count", quotaValue: "9000", quotaDimensions: { project: "p" } }] },
    { retryDelay: "3s" }] } }) } } }, now);
  assert.equal(nested.capacity, 9000); assert.equal(nested.retryAfterMs, 3000); assert.equal(nested.scope, "project");
});

test("unrelated 429, output/request quotas, billing, auth, context overflow and network errors bypass input quota", () => {
  for (const r of [{ status: 429 }, { status: 429, error: { code: "request_count_exceeded" } },
    { status: 429, error: { message: "Quota exceeded for metric: output_token_count, limit: 300" } },
    { status: 429, error: { code: "insufficient_quota", message: "Input token quota exhausted" } },
    { status: 401, error: { code: "input_token_quota_exceeded" } },
    { status: 400, error: { code: "context_length_exceeded" } }, { status: 503, error: { message: "Input token quota exhausted" } }]) assert.equal(inputQuota(r), null);
});

for (const numeric of [true, false]) test(`quota recovery reduces history, preserves pending protocol and transcript; numeric=${numeric}`, async t => {
  const { manager, logs } = await fixture(t);
  const messages = [...history(), ...pending()], original = structuredClone(messages);
  manager.seed(messages, 2);
  const requests = [];
  const result = await manager.run({ messages, tools: [], previous_response_id: "stale" }, async request => {
    requests.push(request);
    if (requests.length === 1) return rejection(numeric ? { capacity: 5000 } : {});
    if (request.stage === "context-summary") return ok("Goal inspect P1:v2. Never modify files. Next: answer correction.");
    return ok("Answer P1:v2");
  });
  const normal = requests.filter(r => r.stage !== "context-summary");
  assert.equal(result.ok, true); assert.equal(normal.length, 2); assert.ok(manager.tokens(normal[1]) < manager.tokens(normal[0]));
  assert.deepEqual(normal[1].messages.slice(-3), pending()); assert.deepEqual(messages, original);
  assert.equal(normal[1].previous_response_id, undefined); assert.equal(normal[1].continuationState, null);
  assert.equal(manager.state.learned, undefined); assert.ok(manager.state.checkpoints.length);
  const saved = await manager.archive.original(manager.state.checkpoints[0].archiveRef);
  assert.deepEqual(JSON.parse(saved), original);
  assert.equal(manager.state.checkpoints[0].boundary, 2);
  assert.ok(logs.some(l => l.recoveryMode === "input_quota" && l.stage === "quota-recorded"));
  assert.doesNotMatch(JSON.stringify(logs), /Never modify|Fresh verified/);
});

test("normal requests retain all available context and do not reserve a guessed quota", async t => {
  const { manager } = await fixture(t, { window: 100000 });
  const messages = [...history(), ...pending()]; let calls = 0;
  const result = await manager.run({ messages }, async r => { calls++; assert.deepEqual(r.messages, messages); return ok("done"); });
  assert.equal(result.ok, true); assert.equal(calls, 1); assert.equal(manager.quota.active().length, 0);
});

test("whole-capacity excess reduces before retry instead of merely waiting", async t => {
  const { manager, waits } = await fixture(t);
  const messages = [...history(), ...pending()]; manager.seed(messages, 2);
  let calls = 0;
  const result = await manager.run({ messages }, async r => {
    if (++calls === 1) return rejection({ capacity: 1800, retry_after_ms: 1000 });
    assert.ok(manager.tokens(r) <= 1800); return ok("checkpoint or answer");
  });
  assert.equal(result.ok, true); assert.equal(waits.reduce((a, b) => a + b, 0), 1000);
});

test("shared exhausted allowance and long reset yield useful incomplete result without any summary dispatch", async t => {
  const { manager, now } = await fixture(t, { quotaWaitMs: 10000 });
  const messages = [...history(), ...pending()]; manager.seed(messages, 2); let calls = 0;
  const result = await manager.run({ messages }, async () => { calls++; return rejection({ capacity: 100000, remaining: 0, reset_at: now() + 20000 }); });
  assert.equal(calls, 1); assert.match(result.partialReply, /provider.*quota|provider-confirmed retry delay/);
  assert.equal(result.recoveryStopReason, "quota_wait_budget_exhausted"); assert.ok(manager.state.checkpoints.at(-1).degraded);
  assert.deepEqual(result.contextMessages.slice(-3), pending());
});

test("retry delays gate summaries and normal retries; summary quota failures share the deadline", async t => {
  const { manager, now, waits } = await fixture(t);
  const messages = [...history(), ...pending()]; manager.seed(messages, 2);
  const seen = []; let rejectedSummary = false;
  const result = await manager.run({ messages }, async r => {
    seen.push({ at: now(), stage: r.stage, tokens: manager.tokens(r) });
    if (seen.length === 1) return rejection({ capacity: 6000, retry_after_ms: 1500 });
    if (r.stage === "context-summary" && !rejectedSummary) { rejectedSummary = true; return rejection({ capacity: 4500, retry_after_ms: 2000 }); }
    return ok("Goal P1:v2; preserve files; next answer.");
  });
  assert.equal(result.ok, true); assert.equal(rejectedSummary, true);
  assert.ok(seen[1].at - seen[0].at >= 1500); assert.ok(seen[2].at - seen[1].at >= 2000);
  assert.ok(seen[2].tokens < seen[1].tokens); assert.equal(waits.reduce((a, b) => a + b, 0), 3500);
  assert.ok(manager.summaryCalls <= manager.config.maxSummaryCalls);
});

test("summary quota larger than deadline falls back without another provider call", async t => {
  const { manager } = await fixture(t, { quotaWaitMs: 10000 }); manager.seed(history(), 2); let calls = 0;
  const result = await manager.run({ messages: [...history(), ...pending()] }, async r => {
    calls++;
    return r.stage === "context-summary" ? rejection({ retry_after_ms: 30000 }) : rejection({ capacity: 5000 });
  });
  assert.equal(calls, 2); assert.equal(result.ok, false); assert.equal(result.recoveryStopReason, "quota_wait_budget_exhausted");
});

test("oversized pending tool result is archived exactly without changing tool pairing or instructions", async t => {
  const { manager } = await fixture(t);
  const messages = pending(); messages[2].content = "EXACT_TOOL_DETAIL ".repeat(3000);
  const original = structuredClone(messages); let calls = 0;
  const result = await manager.run({ messages }, async () => ++calls === 1 ? rejection({ capacity: 3000 }) : ok("done"));
  assert.equal(result.ok, true); assert.equal(calls, 2); assert.deepEqual(messages, original);
  assert.deepEqual(result.contextMessages.slice(0, 2), original.slice(0, 2));
  const receipt = JSON.parse(result.contextMessages[2].content);
  assert.equal(await manager.archive.original(receipt.contextArchive), original[2].content);
});

test("essential oversized user instructions are preserved and capacity failure is actionable", async t => {
  const { manager } = await fixture(t); const messages = [{ role: "user", content: "Essential instruction ".repeat(2000) }]; let calls = 0;
  const result = await manager.run({ messages }, async () => { calls++; return rejection({ capacity: 1000 }); });
  assert.equal(calls, 1); assert.deepEqual(result.contextMessages, messages);
  assert.equal(result.recoveryStopReason, "quota_no_safe_reduction"); assert.match(result.partialReply, /change quota configuration/);
});

test("alternating context and quota failures terminate under shared reduction and summary limits", async t => {
  const { manager } = await fixture(t, { maxAttempts: 3, maxSummaryCalls: 3 }); manager.seed(history(), 2);
  const sent = [];
  const result = await manager.run({ messages: [...history(), ...pending()] }, async r => {
    sent.push(r);
    return sent.length % 2 ? rejection() : { ok: false, status: 400, error: { code: "context_length_exceeded" }, attempts: 1 };
  });
  assert.equal(result.ok, false); assert.ok(sent.length <= 7); assert.ok(manager.recoverySteps <= 3); assert.ok(manager.summaryCalls <= 3);
  assert.ok(manager.state.learned); assert.ok(manager.quota.active().length);
  const normal = sent.filter(r => r.stage !== "context-summary");
  for (let i = 1; i < normal.length; i++) assert.ok(JSON.stringify(normal[i].messages).length < JSON.stringify(normal[i - 1].messages).length);
});

test("unrelated errors return unchanged and never compact", async t => {
  for (const error of [{ status: 429, error: { code: "request_count_exceeded" } }, { status: 401 }, { status: 503 }]) {
    const { manager } = await fixture(t, { quotaWaitMs: 10000 }); manager.seed(history(), 2); let calls = 0;
    const result = await manager.run({ messages: history() }, async () => { calls++; return { ok: false, ...error }; });
    assert.equal(calls, 1); assert.equal(result.status, error.status); assert.equal(manager.state.checkpoints.length, 0);
  }
});

test("quota observations retain provider remaining separately from capacity, scope and expiry", async t => {
  const f = await fixture(t);
  const make = changes => new QuotaLedger({ root: f.options.config.root, provider: "requesty", endpoint: "fixture", account: "account", model: "a",
    now: f.now, monotonic: f.now, state: {}, ttlMs: 5000, ...changes });
  const a = make(), b = make();
  a.record(inputQuota(rejection({ capacity: 10000, remaining: 2000, scope: "account", used: 8000 }), f.now()));
  assert.equal(b.active()[0].remaining, 2000); assert.equal(make({ model: "b" }).active()[0].remaining, 2000);
  assert.equal(make({ account: "other" }).active().length, 0); assert.equal(make({ endpoint: "other" }).active().length, 0);
  assert.equal(a.reserve, undefined); assert.equal(a.budget, undefined, "no synthetic availability API");
  f.advance(5001); assert.equal(a.active().length, 0);
  a.record(inputQuota(rejection({ capacity: 2000, token_scope: "input_and_output", scope: "model" }), f.now()));
  assert.equal(a.active()[0].capacity, 2000); assert.equal(a.active()[0].remaining, null);
  assert.equal(a.active()[0].includesOutput, true); assert.equal(make({ model: "b" }).active().length, 0);
});

test("cached quota respects confirmed delay but never shrinks or blocks an accepted full request", async t => {
  const f = await fixture(t, { window: 1000 }); const messages = [...history(), ...pending()]; f.manager.seed(messages, 2);
  f.manager.quota.record(inputQuota(rejection({ capacity: 2000, remaining: 0, reset_at: f.now() + 1000, retry_after_ms: 1000 }), f.now()));
  const record = f.manager.quota.active()[0];
  record.spent = 999999; record.reserved = 999999; // Old signed-state accounting must not gate dispatch.
  const next = new ContextRecovery({ ...f.options, state: f.manager.snapshot() });
  let calls = 0;
  const result = await next.run({ messages }, async r => { calls++; assert.deepEqual(r.messages, messages); return ok("done"); });
  assert.equal(result.ok, true); assert.equal(calls, 1); assert.equal(next.state.checkpoints.length, 0);
  assert.equal(f.waits.reduce((a, b) => a + b, 0), 1000);
  assert.ok(!("spent" in next.snapshot().quotaRecords[0]));
  assert.ok(!f.logs.some(l => l.stage === "recover" || l.reason === "quota_allowance_exhausted"));
});

test("outer transport deadline also bounds quota waits", async t => {
  const f = await fixture(t); f.manager.seed(history(), 2); let calls = 0;
  const result = await f.manager.run({ messages: [...history(), ...pending()], deadlineAt: f.now() + 1000 }, async () => { calls++; return rejection({ retry_after_ms: 2000 }); });
  assert.equal(calls, 1); assert.equal(result.recoveryStopReason, "hard_request_deadline_exhausted");
});

test("explicit non-input quota metric wins over incidental exhausted input headers", () => {
  for (const metric of ["requests_per_minute", "output_tokens_per_minute"]) {
    assert.equal(inputQuota({ status: 429, headers: { "x-ratelimit-remaining-input-tokens": "0" }, error: { details: { quotaMetric: metric } } }), null);
  }
  assert.equal(inputQuota({ status: 429, headers: { "x-ratelimit-remaining-input-tokens": "0" }, error: { code: "input_tokens_exceeded" } }), null);
});

test("quota cooldown honors the later of reported reset and retry, never the observation TTL", async t => {
  const f = await fixture(t), q = f.manager.quota;
  q.record(inputQuota(rejection({ capacity: 1000, scope: "account", reset_at: f.now() + 1000, retry_after_ms: 2000 }), f.now()));
  assert.equal(q.active()[0].remaining, null); assert.equal(q.delay(), 2000);
  f.advance(1000); assert.equal(q.delay(), 1000);
  f.advance(1000); assert.equal(q.delay(), 0); assert.equal(q.active()[0].remaining, null);
  const duration = inputQuota(rejection({}, { "x-ratelimit-reset-input-tokens": "2s" }), f.now());
  assert.equal(duration.resetAt, f.now() + 2000);
  q.record(inputQuota({ status: 429, error: { code: "input_token_quota_exceeded" } }, f.now()));
  assert.equal(q.delay(), 0); assert.equal(q.active().at(-1).period, null);
});

test("small rejected request can still face exhausted shared quota, without claiming a context overflow", async t => {
  const f = await fixture(t); let calls = 0;
  const messages = [{ role: "user", content: "Answer yes or no." }];
  const result = await f.manager.run({ messages }, async () => { calls++; return rejection({ capacity: 100000, remaining: 0, retry_after_ms: 58000 }); });
  assert.equal(calls, 1); assert.match(result.partialReply, /provider.*quota|provider-confirmed retry delay/);
  assert.deepEqual(result.contextMessages, messages); assert.equal(f.manager.state.learned, undefined);
});

test("all quota-recovery summaries failing use a labeled deterministic checkpoint and disclose degradation", async t => {
  const f = await fixture(t); f.manager.seed(history(), 2);
  let normal = 0, summaries = 0;
  const result = await f.manager.run({ messages: [...history(), ...pending()] }, async r => {
    if (r.stage === "context-summary") { summaries++; return { ok: false, status: 503, attempts: 1 }; }
    return ++normal === 1 ? rejection({ capacity: 5000 }) : ok("Partial findings only");
  });
  assert.equal(result.ok, true); assert.equal(result.contextDegraded, true); assert.ok(summaries > 0);
  assert.match(result.contextMessages[1].content, /Incomplete extractive checkpoint/);
  assert.deepEqual(result.contextMessages.slice(-3), pending());
});

test("matching checkpoint is reused without spending another summary allowance", async t => {
  const f = await fixture(t); f.manager.seed(history(), 2);
  const messages = [...history(), ...pending()];
  f.manager.recoveryStarted = f.now();
  let summaries = 0;
  const send = async () => { summaries++; return ok("Goal P1:v2. Do not write files. Next answer the correction."); };
  await f.manager.compact({ messages, maxTokens: 256 }, send, true);
  assert.equal(summaries, 1);
  f.manager.state.accepted = 2;
  await f.manager.compact({ messages, maxTokens: 256 }, send, true);
  assert.equal(summaries, 1); assert.ok(f.logs.some(l => l.stage === "checkpoint-reused"));
});

test("quota ledger distinguishes provider and reported project dimensions", async t => {
  const f = await fixture(t);
  f.manager.quota.record(inputQuota(rejection({ scope: "project", quotaDimensions: { project: "p1" }, capacity: 1000 }), f.now()));
  f.manager.quota.record(inputQuota(rejection({ scope: "project", quotaDimensions: { project: "p2" }, capacity: 2000 }), f.now()));
  assert.equal(f.manager.quota.active().length, 2); assert.deepEqual(f.manager.quota.active().map(r => r.capacity), [1000, 2000]);
  const anotherProvider = new ContextRecovery({ ...f.options, provider: "other" });
  assert.equal(anotherProvider.quota.active().length, 0);
});

for (const kind of ["context", "quota"]) test(`${kind}: try tool previews before history summaries, even above a heuristic target`, async t => {
  const f = await fixture(t, { window: 1000 });
  const messages = [...history(), ...pending()]; messages.at(-1).content = "PRIVATE_TOOL_DETAIL ".repeat(4000);
  const original = structuredClone(messages); f.manager.seed(messages, 2);
  const sent = [];
  const result = await f.manager.run({ messages, previous_response_id: "stale", tools: [] }, async r => {
    sent.push(r);
    if (sent.length === 1) return kind === "quota" ? rejection({ capacity: 1000 }) : { ok: false, status: 400, error: { code: "context_length_exceeded", max_input_tokens: 1000 } };
    return ok("Accepted preview with history intact");
  });
  assert.equal(result.ok, true); assert.equal(sent.length, 2); assert.equal(f.manager.summaryCalls, 0);
  assert.deepEqual(sent[0].messages, original); assert.deepEqual(sent[1].messages.slice(0, 3), history());
  assert.deepEqual(sent[1].messages.slice(-3, -1), pending().slice(0, 2));
  assert.ok(f.manager.tokens(sent[1]) > 1000, "provider, not local estimate, decides whether reduction fits");
  assert.equal(sent[1].previous_response_id, undefined); assert.equal(f.manager.state.checkpoints.length, 0);
  const receipt = JSON.parse(sent[1].messages.at(-1).content);
  assert.equal(await f.manager.archive.original(receipt.contextArchive), original.at(-1).content);
  assert.deepEqual(messages, original);
  assert.ok(f.logs.some(l => l.stage === "tool-previews" && l.eventKind === "local_recovery_planning"));
  assert.ok(f.logs.some(l => l.eventKind === "provider_rejection"));
  assert.doesNotMatch(JSON.stringify(f.logs), /quota_allowance_exhausted|PRIVATE_TOOL_DETAIL|Never modify/);
});

test("preview rejection escalates to history summary only after the provider sees previews", async t => {
  const f = await fixture(t);
  const messages = [...history(), ...pending()]; messages.at(-1).content = "Tool original detail ".repeat(4000);
  f.manager.seed(messages, 2); const sent = []; let main = 0;
  const result = await f.manager.run({ messages, tools: [] }, async r => {
    sent.push(r);
    if (r.stage === "context-summary") return ok("Goal inspect P1:v2; constraint never write; next answer correction.");
    return ++main <= 2 ? rejection({ capacity: 5000 }) : ok("qualified answer");
  });
  assert.equal(result.ok, true); assert.equal(main, 3);
  assert.equal(sent[0].stage, undefined); assert.equal(sent[1].stage, undefined);
  assert.equal(sent[2].stage, "context-summary"); assert.notEqual(sent.at(-1).stage, "context-summary");
  assert.deepEqual(result.contextMessages.slice(-3, -1), pending().slice(0, 2));
  const normal = sent.filter(r => r.stage !== "context-summary");
  assert.ok(f.manager.tokens(normal[1]) < f.manager.tokens(normal[0]));
  assert.ok(f.manager.tokens(normal[2]) < f.manager.tokens(normal[1]));
});

test("unknown remaining stays unknown across accepted requests and an arbitrary observation TTL", async t => {
  const f = await fixture(t);
  const observation = inputQuota({ status: 429, error: { code: "input_token_quota_exceeded", capacity: 100 } }, f.now());
  f.manager.quota.record(observation);
  for (let i = 0; i < 3; i++) {
    const manager = new ContextRecovery({ ...f.options, state: f.manager.snapshot() });
    const messages = history(); let calls = 0;
    const result = await manager.run({ messages }, async r => { calls++; assert.deepEqual(r.messages, messages); return ok("accepted"); });
    assert.equal(result.ok, true); assert.equal(calls, 1); assert.equal(manager.quota.active()[0].remaining, null);
    assert.equal(manager.quota.active()[0].period, null); assert.equal(manager.quota.delay(), 0);
  }
  assert.equal(f.waits.length, 0); assert.ok(!f.logs.some(l => l.stage === "recover"));
});

test("legacy inferred retry fallback is not promoted to a confirmed cooldown", () => {
  const q = inputQuota({ status: 429, rateLimit: { verifiedInputTokenRateLimit: true, rateLimitRetryable: true,
    quotaMetric: "input_token_count", inputTokenLimit: 16000, retryAfterMs: 60000 } });
  assert.equal(q.retryDelayReported, false); assert.equal(q.retryAfterMs, 0); assert.equal(q.remaining, null); assert.equal(q.period, null);
});

test("a later unknown quota delay cannot cancel an earlier confirmed shared cooldown", async t => {
  const f = await fixture(t), q = f.manager.quota;
  q.record(inputQuota(rejection({ retry_after_ms: 5000 }), f.now()));
  f.advance(1000);
  q.record(inputQuota({ status: 429, error: { code: "input_token_quota_exceeded" } }, f.now()));
  assert.equal(q.delay(), 4000); assert.equal(q.active()[0].remaining, null);
});

test("reported request count calibrates recovery sizing without changing context capacity or remaining quota", async t => {
  const f = await fixture(t); const request = { messages: history(), maxTokens: 256 };
  const local = f.manager.tokens(request);
  f.manager.learnQuota(inputQuota(rejection({ request_input_tokens: local * 2, capacity: 100000, used: 999999 }), f.now()), request);
  assert.equal(f.manager.tokens(request), local * 2); assert.equal(f.manager.state.learned, undefined);
  assert.equal(f.manager.quota.active()[0].remaining, null); assert.equal(f.manager.quota.active()[0].capacity, 100000);
});
