"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { createRuntimeLogger } = require("../../docs/runtime-log.js");
const { createFixture } = require("./helpers/preflight-fixture.js");
const { LiteratureApiClient } = require("../../docs/literature-module.js");

test("buffered response diagnostics distinguish handoff, final answer and incomplete result", () => {
  const { responseOutcome } = require("../../docs/runtime-log.js");
  assert.deepEqual(responseOutcome({}), { stage: "response_received", status: "partial" });
  for (const data of [{ desktopToolCalls: [{ id: "read" }], reply: "Preparing evidence" }, { evidenceRecovery: {} }, { desktopContinuation: "signed" }])
    assert.deepEqual(responseOutcome(data), { stage: "tool_handoff", status: "partial" });
  assert.deepEqual(responseOutcome({ reply: "Verified answer" }), { stage: "final_answer", status: "completed" });
  assert.deepEqual(responseOutcome({ reply: "Preserved checkpoint", failure: { degraded: true } }), { stage: "incomplete_result", status: "failed" });
  assert.deepEqual(responseOutcome({ reply: "Partial findings", taskOutcome: { status: "incomplete" } }), { stage: "incomplete_result", status: "partial" });
});

test("recovery timing diagnostics retain independent budgets without private content", () => {
  const log = createRuntimeLogger({ sink: null, heartbeatMs: 0 });
  const details = { stage: "quota-wait", recoveryMode: "input_quota", activeRecoveryMs: 80000,
    quotaWaitMs: 58000, providerCallTimeoutMs: 90000, quotaWaitRemainingMs: 122000,
    hardDeadlineRemainingMs: 152000, retryAfterMs: 0, summaryCalls: 2, automaticRetryScheduled: false };
  assert.deepEqual(log.record("context.recovery", { ...details, prompt: "PRIVATE_PROMPT", credentials: "SECRET_KEY", toolOutput: "PRIVATE_DOCUMENT" }).details, details);
  assert.doesNotMatch(log.exportText(), /PRIVATE_|SECRET_KEY/);
});

test("semantic validation diagnostics preserve schema indices and exclude input and filesystem paths", () => {
  const log = createRuntimeLogger({ sink: null, heartbeatMs: 0 });
  const details = { failureStage: "backend_input_validation", validationField: "conversationContext[0].content", validationReason: "filesystem_path", providerAttempts: 0 };
  assert.deepEqual(log.record("semantic.validation", { ...details, input: "SECRET_SENTINEL" }).details, details);
  assert.deepEqual(log.record("semantic.validation", { validationField: "/Users/private/project" }).details, {});
  assert.doesNotMatch(log.exportText(), /SECRET_SENTINEL|Users|private/);
});

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

test("semantic fallback and the submitted retrieval scope remain observable without logging IR or prompts", () => {
  const log = createRuntimeLogger({ sink: null, heartbeatMs: 0 });
  const fields = { retrievalScope: "workspace", webSearchExpected: false, downloadRequested: false,
    workspaceRetrievalTriggered: true, route: "local-fallback", fallbackReason: "invalid_structured_output", semanticParserCalls: 1 };
  assert.deepEqual(log.record("retrieval.decision", { ...fields, ir: { goal: "private task" }, prompt: "private task" }).details, fields);
  log.begin("main-agent", { semanticContextPresent: true, retrievalScope: "web" })("completed");
  assert.equal(log.entries().at(-1).details.retrievalScope, "web");
  assert.equal(log.entries().at(-1).details.semanticContextPresent, true);
  assert.doesNotMatch(log.exportText(), /private task|goal|prompt/);
});

test("task execution diagnostics retain primitive outcomes without private task or source data", () => {
  const log = createRuntimeLogger({ sink: null, heartbeatMs: 0 });
  const fields = { originalRequestPreserved: true, semanticContextPresent: true, retrievalScope: "web", stage: "answer-received",
    downloadRequested: true, downloadExposed: true, downloadPermitted: true, sourceCount: 3,
    downloadAttemptCount: 3, downloadResultCount: 3, downloadSuccessCount: 2, downloadFailureCount: 1,
    correctiveContinuation: true, taskStatus: "incomplete" };
  assert.deepEqual(log.record("main-agent.partial", { ...fields, originalRequest: "private task", sources: [{ url: "https://private.example.org/paper" }],
    providerError: "private error", headers: { Authorization: "secret" } }).details, fields);
  assert.doesNotMatch(log.exportText(), /private|secret|https:/);
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

test("FC transport logs Card failures and subsequent cooldown/completion without automatic resend or private bodies", async () => {
  const log = createRuntimeLogger({ sink: null, heartbeatMs: 0 });
  let calls = 0;
  let now = 0;
  const api = new LiteratureApiClient({ baseUrl: "https://fixture.invalid", runtimeLog: log, now: () => now, wait: async ms => { now += ms; }, fetch: async () => {
    calls++;
    return { status: calls === 1 ? 429 : 200, ok: calls > 1, json: async () => calls === 1
      ? { error: "RATE_LIMITED", message: "private provider error" }
      : { ok: true, attempts: 2, analysis: { text: "private response" } } };
  } });
  await assert.rejects(api.request("/api/literature/create-paper-card-from-text", { paperId: "paper-1", text: "private request", callContext: { turnId: "turn-1" } }), { code: "ProviderRateLimited" });
  assert.equal(calls, 1);
  await api.request("/api/literature/create-paper-card-from-text", { paperId: "paper-1", text: "private request", callContext: { turnId: "turn-1" } });
  assert.equal(calls, 2);
  const transport = log.entries().filter(entry => entry.event.startsWith("backend-request."));
  assert.deepEqual(transport.map((entry) => entry.event), ["backend-request.started", "backend-request.failed", "backend-request.cooldown", "backend-request.started", "backend-request.completed"]);
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

test("Paper Card normalization diagnostics allow only descriptive field names and distinguish provider failures", async () => {
  const log = createRuntimeLogger({ sink: null, heartbeatMs: 0 });
  log.record("paper-card.normalized", { normalizedFields: ["title", "abstract_summary", "PRIVATE_CONTENT", "source_identity", "/private/paper.pdf"],
    validationField: "paperCard.source_identity", validationReason: "schema_mismatch", failureStage: "provider_content_validation" });
  assert.deepEqual(log.entries()[0].details.normalizedFields, ["title", "abstract_summary"]);
  assert.equal(log.entries()[0].details.validationField, "paperCard.source_identity");
  assert.doesNotMatch(log.exportText(), /PRIVATE_CONTENT|private\/paper/);
  for (const [failureStage, validationReason] of [["provider_content_validation", "insufficient_substantive_content"], ["provider_rejection", undefined], ["provider_transport", undefined]]) {
    const api = new LiteratureApiClient({ log, baseUrl: "https://fixture.test", fetch: async () => new Response(JSON.stringify({ ok: false,
      error: failureStage === "provider_content_validation" ? "InvalidLlmResponse" : "LlmHttpError", message: "Fixture failure", attempts: 1,
      failureStage, validationReason, validationField: validationReason ? "paperCard" : undefined }), { status: 502 }) });
    await assert.rejects(api.synthesize({ chunkSummaries: [{}] }), error => error.failureStage === failureStage && error.validationReason === validationReason);
  }
});
