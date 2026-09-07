"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { createRuntimeLogger } = require("../../docs/runtime-log.js");
const { createFixture } = require("./helpers/preflight-fixture.js");
const { LiteratureApiClient } = require("../../docs/literature-module.js");

test("debug logs retain bounded operational metadata and cannot expose request contents or interrupt work", () => {
  const log = createRuntimeLogger({ limit: 2, sink: { info() { throw new Error("broken console"); } }, heartbeatMs: 0 });
  log.subscribe(() => { throw new Error("broken viewer"); });
  log.record("old");
  const entry = log.record("backend-request.started", { endpoint: "/api/literature/create-paper-card-from-text", paperId: "paper-1",
    prompt: "private paper", body: { text: "private paper" }, headers: { Authorization: "Bearer secret" },
    token: "secret", message: "private error content", path: "/Users/private-project", code: "HTTP_ERROR", durationMs: Infinity });
  assert.ok(Object.isFrozen(entry.details));
  log.record("backend-request.failed", { code: "INVALID_CARD" }, "error");
  assert.equal(log.entries().length, 2);
  assert.doesNotMatch(log.exportText(), /private|Bearer|secret|Infinity/);
  assert.match(log.exportText(), /INVALID_CARD/);
  const snapshot = log.entries(); snapshot.length = 0;
  assert.equal(log.entries().length, 2);
  log.clear(); assert.equal(log.entries().length, 0);
});

test("waiting events have elapsed time and stop after success or failure", async () => {
  const log = createRuntimeLogger({ sink: null, heartbeatMs: 5 });
  const finish = log.begin("backend-request", { endpoint: "/chat", turnId: "turn-a" });
  await new Promise((resolve) => setTimeout(resolve, 25));
  finish("failed", { code: "NETWORK_ERROR" });
  const count = log.entries().length;
  finish("completed");
  await new Promise((resolve) => setTimeout(resolve, 15));
  assert.equal(log.entries().length, count);
  assert.ok(log.entries().some((entry) => entry.event === "backend-request.waiting" && entry.details.durationMs >= 0));
  assert.equal(log.entries().at(-1).event, "backend-request.failed");
  assert.equal(new Set(log.entries().map((entry) => entry.details.operationId)).size, 1);
});

test("real preflight logs one shared sync worker, L1/L2 failure, cache reuse on retry, and no spawn for unchanged sources", async () => {
  const log = createRuntimeLogger({ sink: null, heartbeatMs: 0 });
  let release, fail = true;
  const barrier = new Promise((resolve) => { release = resolve; });
  const fixture = await createFixture({ cardBarrier: () => barrier, cardFailure: () => fail });
  fixture.pipeline.log = log;
  fixture.workspace.set("literature/P1.pdf", "Private paper evidence that must not be logged.");
  const first = fixture.pipeline.preflight({ turnId: "first", surface: "side_chat" });
  const second = fixture.pipeline.preflight({ turnId: "second", surface: "agent_command" });
  release();
  assert.equal((await first).report.status, "partial"); await second;
  assert.equal(log.entries().filter((entry) => entry.event === "sync-agent.started").length, 1);
  assert.ok(log.entries().some((entry) => entry.event === "preflight.joined"));
  const failure = log.entries().find((entry) => entry.details.stage === "sync-source-failed");
  assert.equal(failure.details.layer, "L2"); assert.equal(failure.details.code, "CARD_TEST_FAILURE");
  assert.ok(failure.details.sourceId);
  assert.equal(log.entries().at(-1).event, "preflight.partial");
  fail = false; log.clear();
  assert.equal((await fixture.pipeline.preflight({ turnId: "retry" })).report.status, "completed");
  const stages = log.entries().filter((entry) => entry.event === "preflight.stage");
  assert.equal(stages.find((entry) => entry.details.stage === "sync-evidence-ready").details.cached, true);
  assert.ok(stages.findIndex((entry) => entry.details.stage === "sync-paper-card-ready") < stages.findIndex((entry) => entry.details.stage === "sync-topics-ready"));
  log.clear(); await fixture.pipeline.preflight({ turnId: "unchanged" });
  assert.ok(log.entries().some((entry) => entry.event === "sync-agent.skipped"));
  assert.equal(log.entries().filter((entry) => entry.event === "sync-agent.started").length, 0);
  assert.doesNotMatch(log.exportText(), /Private paper/);
});

test("FC transport logs HTTP failures, retry and completion without request or response bodies", async () => {
  const log = createRuntimeLogger({ sink: null, heartbeatMs: 0 });
  let calls = 0;
  let now = 0;
  const api = new LiteratureApiClient({ baseUrl: "https://fixture.invalid", runtimeLog: log, now: () => now, wait: async ms => { now += ms; }, fetch: async () => {
    calls++;
    return { status: calls === 1 ? 429 : 200, ok: calls > 1, json: async () => calls === 1
      ? { error: "RATE_LIMITED", message: "private provider error" }
      : { ok: true, attempts: 2, analysis: { text: "private response" } } };
  } });
  await api.request("/api/literature/create-paper-card-from-text", { paperId: "paper-1", text: "private request", callContext: { turnId: "turn-1" } });
  assert.equal(calls, 2);
  const transport = log.entries().filter(entry => entry.event.startsWith("backend-request."));
  assert.deepEqual(transport.map((entry) => entry.event), ["backend-request.started", "backend-request.failed", "backend-request.retry", "backend-request.cooldown", "backend-request.started", "backend-request.completed"]);
  assert.equal(transport[1].details.status, 429);
  assert.equal(log.entries().at(-1).details.providerAttempts, 2);
  assert.equal(transport[0].details.role, "combined_text_paper_card");
  assert.equal(transport[0].details.concurrency, 2);
  assert.equal(transport.at(-1).details.concurrency, 1);
  assert.ok(log.entries().some(entry => entry.event === "paper-card.concurrency-reduced"));
  assert.doesNotMatch(log.exportText(), /private/);
});

test("the console identifies two overlapping PaperCardAgent workers and their completion", { timeout: 5000 }, async () => {
  const log = createRuntimeLogger({ sink: null, heartbeatMs: 0 });
  let started = 0, release;
  const barrier = new Promise(resolve => { release = resolve; });
  const fixture = await createFixture({ cardBarrier: async () => { if (++started === 2) release(); await barrier; } });
  fixture.pipeline.log = log;
  fixture.workspace.set("literature/P1.pdf", "First private paper");
  fixture.workspace.set("literature/P2.pdf", "Second private paper");
  const result = await fixture.pipeline.preflight({ turnId: "two-paper-workers" });
  assert.equal(result.report.updated.paperCards, 2);
  assert.equal(fixture.calls.peakCards, 2);
  const workers = log.entries().filter(entry => entry.details.agent === "PaperCardAgent");
  assert.deepEqual(new Set(workers.map(entry => entry.details.workerId)), new Set(["paper-card-1", "paper-card-2"]));
  assert.ok(workers.some(entry => entry.details.status === "running" && entry.details.activeWorkers === 2));
  assert.equal(workers.filter(entry => entry.details.status === "completed").length, 2);
  assert.equal(workers.at(-1).details.activeWorkers, 0);
  assert.doesNotMatch(log.exportText(), /private paper/);
});
