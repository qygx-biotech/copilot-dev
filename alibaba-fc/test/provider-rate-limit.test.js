"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { parseRateLimit } = require("../../shared/provider-rate-limit.js");
const { LiteratureApiClient } = require("../../docs/literature-module.js");
const quotaMessage = "Quota exceeded for metric: generativelanguage.googleapis.com/generate_content_paid_tier_3_input_token_count, limit: 16000, model: gemma-4-31b\nPlease retry in 22.454788929s.";

test("provider input-token quota preserves reset time and recognizes the deployed FC 502 wrapper", () => {
  const direct = parseRateLimit(429, { error: { message: quotaMessage } });
  assert.equal(direct.retryAfterMs, 22455);
  assert.equal(direct.inputTokenLimit, 16000);
  assert.equal(direct.verifiedInputTokenRateLimit, true);
  assert.deepEqual(parseRateLimit(502, { error: "LlmHttpError", message: `Requesty returned HTTP 429: ${quotaMessage}` }), direct);
  assert.equal(parseRateLimit(429, { error: { message: quotaMessage } }, "31").retryAfterMs, 31000);
  assert.equal(parseRateLimit(429, { error: { message: quotaMessage } }, "0").retryAfterMs, 22455);
  assert.equal(parseRateLimit(429, {}, "Sun, 06 Sep 2026 23:18:00 GMT", Date.parse("2026-09-06T23:17:30Z")).retryAfterMs, 30000);
  assert.equal(parseRateLimit(429, {}).retryAfterMs, 60000);
  assert.equal(parseRateLimit(502, { error: "LlmHttpError", message: "Unrelated failure" }), null);
  assert.equal(parseRateLimit(401, { error: { message: quotaMessage } }), null);
  assert.equal(parseRateLimit(429, { error: { type: "insufficient_quota" } }).rateLimitRetryable, false);
  assert.equal(parseRateLimit(429, { error: { message: quotaMessage.replace("limit: 16000", "limit: 0") } }).verifiedInputTokenRateLimit, false);
});

test("two long papers start together; a queued third skips the rejected full payload and fallbacks share a serial cooldown", async () => {
  let now = 0, active = 0, peak = 0;
  const waits = [], requests = [], events = [];
  const api = new LiteratureApiClient({ baseUrl: "https://fc.test", now: () => now,
    wait: async (ms) => { waits.push(ms); now += ms; }, runtimeLog: { record: (...entry) => events.push(entry), begin: () => () => {} },
    fetch: async (url, options) => {
      requests.push({ url, body: JSON.parse(options.body), at: now });
      active++; peak = Math.max(peak, active); await new Promise(resolve => setImmediate(resolve)); active--;
      return new Response(JSON.stringify(url.endsWith("create-paper-card-from-text")
        ? { ok: false, error: "LlmHttpError", message: `Requesty returned HTTP 429: ${quotaMessage}`, attempts: 2 }
        : { ok: true, chunkSummary: { summary: "excerpt" } }), { status: url.endsWith("create-paper-card-from-text") ? 502 : 200 });
    },
  });
  const full = id => api.request("/api/literature/create-paper-card-from-text", { paperId: id, text: "x".repeat(75014) });
  const results = await Promise.allSettled([full("p1"), full("p2"), full("p3")]);
  assert.ok(results.every(item => item.status === "rejected" && item.reason.verifiedInputTokenRateLimit));
  assert.equal(requests.length, 2, "Two initial full payloads may overlap; the queued third uses the learned quota locally");
  assert.equal(peak, 2);
  assert.equal(api.paperCardConcurrency, 1);
  peak = 0;
  await Promise.all([api.summarizeChunk({ filename: "p1.pdf", text: "excerpt", callContext: { turnId: "turn", paperId: "p1" } }),
    api.summarizeChunk({ filename: "p2.pdf", text: "excerpt", callContext: { turnId: "turn", paperId: "p2" } })]);
  assert.deepEqual(waits, [23455]);
  assert.equal(peak, 1);
  assert.equal(requests[2].at, 23455);
  assert.equal(requests[2].body.callContext.paperId, "p1");
  assert.ok(events.some(entry => entry[0] === "backend-request.cooldown"));
  assert.ok(events.some(entry => entry[0] === "paper-card.concurrency-reduced" && entry[1].concurrency === 1));
});

test("the two-slot pool bounds native, combined, excerpt and synthesis requests and releases failed or cancelled work", async () => {
  const started = [], release = [];
  const api = new LiteratureApiClient({ baseUrl: "https://fc.test", fetch: async url => {
    started.push(url);
    const status = await new Promise(resolve => release.push(resolve));
    return new Response(JSON.stringify({ ok: status === 200, error: "FixtureFailure" }), { status });
  } });
  const tick = () => new Promise(resolve => setImmediate(resolve));
  const controller = new AbortController();
  const paths = ["analyze-pdf-native", "create-paper-card-from-text", "summarize-chunk", "synthesize"];
  const pending = paths.map((path, index) => api.request(`/api/literature/${path}`, {}, index === 2 ? controller.signal : undefined));
  const done = Promise.allSettled(pending);
  await tick();
  assert.equal(started.length, 2);
  controller.abort();
  await assert.rejects(pending[2], { code: "OPERATION_ABORTED" });
  assert.equal(started.length, 2, "Cancellation must not consume a slot or start the queued request");
  release[0](500); await tick();
  assert.equal(started.length, 3);
  assert.ok(started[2].endsWith("synthesize"));
  release[1](200); release[2](200);
  assert.deepEqual((await done).map(item => item.status), ["rejected", "fulfilled", "rejected", "fulfilled"]);
  assert.equal(api.activePaperCardRequests, 0);
  assert.equal(api.paperCardQueue.length, 0);
});

test("simultaneous throttled calls reacquire one slot for retries and honor the longest reset", async () => {
  let now = 0, active = 0, peakAfterThrottle = 0;
  const requests = [], release = [], waits = [];
  const api = new LiteratureApiClient({ baseUrl: "https://fc.test", now: () => now, wait: async ms => { waits.push(ms); now += ms; },
    fetch: async (url, options) => {
      const index = requests.length;
      requests.push({ paperId: JSON.parse(options.body).paperId, at: now });
      if (index < 2) {
        await new Promise(resolve => release.push(resolve));
        return new Response(JSON.stringify({ ok: false, message: "Throttled" }), { status: 429, headers: { "retry-after": index === 0 ? "22" : "30" } });
      }
      active++; peakAfterThrottle = Math.max(peakAfterThrottle, active);
      await new Promise(resolve => setImmediate(resolve)); active--;
      return new Response(JSON.stringify({ ok: true }));
    },
  });
  const done = Promise.all([api.request("/api/literature/summarize-chunk", { paperId: "p1" }), api.request("/api/literature/summarize-chunk", { paperId: "p2" })]);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(requests.length, 2);
  release.forEach(resolve => resolve()); await done;
  assert.equal(requests.length, 4);
  assert.ok(requests.slice(2).every(request => request.at >= 31000));
  assert.deepEqual(waits, [31000]);
  assert.equal(peakAfterThrottle, 1);
  assert.equal(api.activePaperCardRequests, 0);
});

test("ordinary rate limits retry only after reset; hard quotas do not retry or create input-size fallbacks", async () => {
  let now = 0, attempts = 0;
  const times = [];
  const api = new LiteratureApiClient({ baseUrl: "https://fc.test", now: () => now, wait: async ms => { now += ms; },
    fetch: async () => { times.push(now); return new Response(JSON.stringify(++attempts === 1 ? { ok: false, message: "Throttled" } : { ok: true }),
      { status: attempts === 1 ? 429 : 200, headers: { "retry-after": "22" } }); },
  });
  await api.request("/api/literature/summarize-chunk", {});
  assert.deepEqual(times, [0, 23000]);
  attempts = 0;
  api.fetch = async () => { attempts++; return new Response(JSON.stringify({ ok: false, error: { type: "insufficient_quota" } }), { status: 429 }); };
  await assert.rejects(api.request("/api/literature/create-paper-card-from-text", {}), error => error.code === "ProviderRateLimited" && !error.verifiedInputTokenRateLimit);
  assert.equal(attempts, 1);
});

test("provider cooldown is cancellable and releases the paper-card queue", async () => {
  let requests = 0;
  const api = new LiteratureApiClient({ baseUrl: "https://fc.test", fetch: async () => { requests++; return new Response(JSON.stringify({ ok: true })); } });
  api.providerCooldownUntil = Date.now() + 60000;
  const controller = new AbortController();
  const pending = api.request("/api/literature/synthesize", {}, controller.signal);
  setTimeout(() => controller.abort(), 5);
  await assert.rejects(pending, { code: "OPERATION_ABORTED" });
  assert.equal(requests, 0);
  api.providerCooldownUntil = 0;
  await api.request("/api/literature/synthesize", {});
  assert.equal(requests, 1);
});

// Explicit response gates and a fake clock keep recovery/queue tests deterministic.
const tick = () => new Promise(resolve => setImmediate(resolve));
function recoveryFixture() {
  let now = 0, active = 0, peak = 0;
  const requests = [], waits = [];
  const api = new LiteratureApiClient({ baseUrl: "https://fc.test", now: () => now,
    wait: async ms => { waits.push(ms); now += ms; },
    fetch: async (url, options) => {
      active++; peak = Math.max(peak, active);
      return new Promise(resolve => requests.push({ url, body: options.body && JSON.parse(options.body),
        model: options.headers["X-BioDesign-Chat-Model"], at: now,
        finish(status = 200, data = { ok: true }, headers = {}) {
          active--; resolve(new Response(JSON.stringify(data), { status, headers }));
        },
      }));
    },
  });
  const card = (id, { signal, model, path = "summarize-chunk" } = {}) => api.request(`/api/literature/${path}`,
    { paperId: id, text: "evidence", ...(model ? { callContext: { model } } : {}) }, signal);
  async function throttle(id, model) {
    const pending = card(id, { model, path: "create-paper-card-from-text" });
    const rejected = assert.rejects(pending, error => error.verifiedInputTokenRateLimit);
    await tick();
    requests.at(-1).finish(429, { ok: false, message: quotaMessage }, { "Retry-After": "23" });
    await rejected;
    assert.equal(api.paperCardConcurrency, 1);
  }
  async function success(id, options) {
    const pending = card(id, options); await tick(); requests.at(-1).finish(); await pending;
  }
  return { api, requests, waits, card, throttle, success, advance: time => { now = time; },
    get peak() { return peak; }, get active() { return active; } };
}

test("three post-cooldown successes restore two slots without forgetting quotas or changing request models", async () => {
  const f = recoveryFixture();
  await f.throttle("unscoped-quota");
  await f.throttle("selected-quota", "default");
  const deadline = f.api.providerCooldownUntil;
  const learnedBudget = f.api.inputQuotaCharacterBudget({ model: "default" });
  const models = ["default", "nvidia/nemotron-3-nano-omni-30b-a3b-reasoning", undefined];
  for (const [index, model] of models.entries()) {
    await f.success(`success-${index}`, { model });
    assert.equal(f.api.paperCardConcurrency, index < 2 ? 1 : 2);
    assert.ok(f.requests.at(-1).at >= deadline);
    assert.equal(f.requests.at(-1).model, model);
    assert.equal(f.requests.at(-1).body.callContext?.model, undefined);
  }
  assert.deepEqual(f.waits, [24000, 24000]);
  assert.equal(f.api.providerCooldownUntil, deadline);
  assert.equal(f.api.inputTokenLimit, 16000);
  assert.equal(f.api.modelInputTokenLimits.get("default"), 16000);
  assert.equal(f.api.inputQuotaCharacterBudget({ model: "default" }), learnedBudget);
  const count = f.requests.length;
  await assert.rejects(f.api.request("/api/literature/create-paper-card-from-text", {
    text: "x".repeat(learnedBudget + 1), callContext: { model: "default" },
  }), error => error.verifiedInputTokenRateLimit);
  assert.equal(f.requests.length, count, "Recovery must not resend a known oversized payload");
});

test("recovery drains queued papers in order and never starts more than two provider requests", async () => {
  const f = recoveryFixture();
  await f.throttle("quota");
  const pending = Array.from({ length: 7 }, (_, index) => f.card(`queued-${index}`));
  const done = Promise.all(pending);
  await tick();
  for (let index = 0; index < 3; index++) {
    assert.equal(f.active, 1);
    assert.equal(f.requests.length, index + 2);
    f.requests[index + 1].finish(); await tick();
  }
  assert.equal(f.api.paperCardConcurrency, 2);
  assert.equal(f.active, 2);
  assert.equal(f.requests.length, 6);
  for (let index = 4; index < 8; index++) { f.requests[index].finish(); await tick(); }
  await done;
  assert.deepEqual(f.requests.slice(1).map(request => request.body.paperId), Array.from({ length: 7 }, (_, i) => `queued-${i}`));
  assert.equal(f.peak, 2);
  assert.equal(f.api.activePaperCardRequests, 0);
  assert.equal(f.api.paperCardQueue.length, 0);
});

test("late pre-throttle completions do not count, and repeated throttling requires three new successes", async () => {
  const f = recoveryFixture();
  const late = f.card("old-in-flight");
  await f.throttle("quota");
  f.advance(f.api.providerCooldownUntil);
  f.requests[0].finish(); await late;
  await f.success("new-1"); await f.success("new-2");
  assert.equal(f.api.paperCardConcurrency, 1, "The old in-flight response cannot be the third success");
  const previousDeadline = f.api.providerCooldownUntil;
  await f.throttle("quota-again");
  assert.ok(f.api.providerCooldownUntil > previousDeadline);
  await f.success("retry-1"); await f.success("retry-2");
  assert.equal(f.api.paperCardConcurrency, 1);
  await f.success("retry-3");
  assert.equal(f.api.paperCardConcurrency, 2);
  await f.throttle("throttled-after-recovery");
  await f.success("fresh-1"); await f.success("fresh-2");
  assert.equal(f.api.paperCardConcurrency, 1);
  await f.success("fresh-3");
  assert.equal(f.api.paperCardConcurrency, 2);
  assert.ok(f.peak <= 2);
});

test("cached, configuration, and non-Paper-Card responses cannot restore concurrency", async () => {
  const f = recoveryFixture();
  f.api.configurationSignature = "old-configuration";
  await f.throttle("quota", "default");
  const deadline = f.api.providerCooldownUntil;
  const config = f.api.getPaperCardConfiguration(); await tick();
  f.requests.at(-1).finish(200, { ok: true, modelSignature: "new-configuration" }); await config;
  assert.equal(f.api.paperCardConcurrency, 1, "A configuration change must not bypass recovery");
  assert.equal(f.api.providerCooldownUntil, deadline);
  assert.equal(f.api.modelInputTokenLimits.get("default"), 16000);
  const cached = f.card("cached"); await tick();
  f.requests.at(-1).finish(200, { ok: true, cached: true }); await cached;
  const planner = f.api.request("/api/knowledge/plan-search", {}); await tick();
  f.requests.at(-1).finish(); await planner;
  await f.success("real-1"); await f.success("real-2");
  assert.equal(f.api.paperCardConcurrency, 1);
  await f.success("real-3");
  assert.equal(f.api.paperCardConcurrency, 2);
});

test("failed Paper Card responses break the recovery streak", async () => {
  const f = recoveryFixture();
  await f.throttle("quota");
  await f.success("first"); await f.success("second");
  const failed = f.card("failure");
  const rejected = assert.rejects(failed, { code: "InvalidLlmResponse" });
  await tick(); f.requests.at(-1).finish(502, { ok: false, error: "InvalidLlmResponse" }); await rejected;
  await f.success("after-failure-1"); await f.success("after-failure-2");
  assert.equal(f.api.paperCardConcurrency, 1);
  await f.success("after-failure-3");
  assert.equal(f.api.paperCardConcurrency, 2);
});

test("queued cancellation never starts a request; an aborted in-flight success cannot complete recovery", async () => {
  const f = recoveryFixture();
  await f.throttle("quota");
  await f.success("first"); await f.success("second");
  const inFlightController = new AbortController(), queuedController = new AbortController();
  const inFlight = f.card("cancel-in-flight", { signal: inFlightController.signal });
  const inFlightRejected = assert.rejects(inFlight, { code: "OPERATION_ABORTED" });
  const queued = f.card("cancel-queued", { signal: queuedController.signal });
  const queuedRejected = assert.rejects(queued, { code: "OPERATION_ABORTED" });
  const remaining = [f.card("remaining-1"), f.card("remaining-2"), f.card("remaining-3")];
  const done = Promise.all(remaining);
  await tick();
  const inFlightIndex = f.requests.length - 1;
  queuedController.abort(); await queuedRejected;
  inFlightController.abort();
  // Simulate a response racing with cancellation: this success must not count.
  f.requests[inFlightIndex].finish(); await inFlightRejected; await tick();
  assert.equal(f.api.paperCardConcurrency, 1);
  for (let index = 0; index < 3; index++) {
    f.requests.at(-1).finish(); await remaining[index]; await tick();
    assert.equal(f.api.paperCardConcurrency, index < 2 ? 1 : 2);
  }
  await done;
  assert.ok(f.requests.every(request => request.body.paperId !== "cancel-queued"));
  assert.equal(f.api.activePaperCardRequests, 0);
  assert.equal(f.api.paperCardQueue.length, 0);
});
