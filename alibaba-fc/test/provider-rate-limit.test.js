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
