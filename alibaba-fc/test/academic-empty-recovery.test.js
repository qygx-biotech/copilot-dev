"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const { runSideChatAgent } = require("../side-chat-agent.js");
const { requestRequestyMessage } = require("../index.js")._test;
const continuation = require("../agent-continuation.js"), semantic = require("../../shared/semantic-intent.js");
const planning = require("../academic-planning.js");
const query = "Find and save five relevant AI synthetic biology papers.";
const ir = { ...semantic.interpretLocal({ query }), matchedPattern: null, objects: ["literature"], operations: ["search", "store"],
  capabilityHints: ["search_papers", "download_sources"], retrievalScope: "web", requestedOutput: { type: "papers", limit: 5 } };
const refs = Array.from({ length: 7 }, (_, i) => "paper_" + String(i + 1).padStart(24, "0"));
const papers = refs.map((paper_ref, i) => ({ paper_ref, title: `AI synthetic biology design ${i}`, abstract: "Direct design and experimental evidence.",
  authors: ["Author"], doi: `10.1000/${i}`, providers: [], locations: [] }));
const summary = "Saved 3 of the requested 5 papers. Two downloads failed with NO_ACCESSIBLE_PDF; saving remains incomplete.";
const plan = { request_kind: "topic", requested_count: 5, subtopics: ["AI design"], synonyms: [], queries: ["AI synthetic biology", "AI biological design"] };
const select = ids => ({ shortlist: ids.map(paper_ref => ({ paper_ref, relevance: 5, evidence: "title_abstract", covers: ["subtopic_1"], reason: "Direct design evidence." })), stop_reason: "sufficient_candidates", remaining_gaps: [] });
const tool = (name, args) => ({ id: name, type: "function", function: { name, arguments: JSON.stringify(args) } });
const actions = (...tool_calls) => ({ tool_calls });
const answer = reply => ({ content: JSON.stringify({ reply, project: { summary: "Literature search" } }) });
const run = options => runSideChatAgent({ surface: "agent_command", desktopAcademic: true, desktopDownloads: true, downloadPermission: "workspace_write",
  originalRequest: query, systemPrompt: "Complete the literature request.", conversationMessages: [{ role: "user", content: query }],
  workspaceContext: { localWorkspaceContext: { semantic: { ir } } }, parseFinalAnswer: JSON.parse, ...options });
function withResult(pending, result) {
  const binding = { project: "empty-recovery", account: "test" };
  const state = continuation.open(continuation.seal(pending.continuationState, binding, "secret"), binding, "secret");
  return continuation.withResults(state, [{ id: pending.data.desktopToolCalls[0].id, result }]);
}
// Production harness + Requesty adapter; only provider responses and desktop
// search/download outcomes are controlled. No replacement agent state machine.
function provider(t, generate, streaming = false) {
  const requests = [];
  t.mock.method(global, "fetch", async (_url, options) => {
    const body = JSON.parse(options.body); requests.push(body);
    const message = generate(requests.length, body);
    const payload = { id: `response-${requests.length}`, choices: [{ index: 0, message, finish_reason: "stop" }],
      usage: { prompt_tokens: 120, completion_tokens: 0, total_tokens: 120, private_extension: "NEVER_EXPOSE" },
      promptFeedback: { blockReason: "NO_OUTPUT" } };
    // A provider can report zero tokens even for a usable message/tool call.
    return streaming ? new Response(`data: ${JSON.stringify(payload)}\n\ndata: [DONE]\n\n`, { headers: { "content-type": "text/event-stream", "x-request-id": "request-fixture" } })
      : new Response(JSON.stringify(payload), { headers: { "x-request-id": "request-fixture" } });
  });
  return { requests, requestTurn: request => requestRequestyMessage({ model: "fixture/model", ...request }, "fixture-api-key", false, streaming ? {} : null) };
}
async function downloaded(t) {
  const p = provider(t, count => count === 1 ? actions(tool("plan_literature_search", plan), tool("search_academic_papers", { query: plan.queries[0], queries: [plan.queries[1]] }))
    : actions(tool("select_literature_papers", select(refs.slice(0, 5))), tool("download_papers", { paper_refs: refs.slice(0, 5) })));
  const found = await run(p);
  const pending = await run({ ...p, resume: withResult(found, { version: 1, status: "completed", papers }) });
  assert.deepEqual(p.requests.map(body => body.messages.at(-1).role), ["system", "system"]);
  return withResult(pending, { version: 1, status: "partial", results: refs.slice(0, 5).map((paper_ref, i) => i < 3
    ? { paper_ref, status: "downloaded", path: `literature/${i}.pdf`, contentType: "application/pdf" }
    : { paper_ref, status: "failed", error: { code: "NO_ACCESSIBLE_PDF" } }) });
}
for (const streaming of [false, true]) test(`empty stop diagnostics and valid zero-token tool-only response (${streaming ? "SSE" : "JSON"})`, async t => {
  const p = provider(t, count => count === 1 ? { content: " \n" } : actions(tool("select_literature_papers", select(refs.slice(5)))), streaming);
  const empty = await p.requestTurn({ messages: [] });
  assert.equal(empty.error, "EmptyLlmResponse"); assert.equal(empty.finishReason, "stop");
  assert.equal(empty.requestId, "request-fixture"); assert.equal(empty.usage.completion_tokens, 0);
  assert.deepEqual(empty.providerCodes, ["NO_OUTPUT"]);
  assert.doesNotMatch(JSON.stringify(empty), /NEVER_EXPOSE|fixture-api-key/);
  const valid = await p.requestTurn({ messages: [] });
  assert.equal(valid.ok, true); assert.equal(valid.message.tool_calls.length, 1);
});

test("empty recovery retries once, validates collected candidates and reaches authorized download", async t => {
  const resume = await downloaded(t);
  const p = provider(t, (count, body) => {
    if (count === 1) return answer(summary);
    if (count === 2) return { content: null };
    assert.equal(count, 3);
    const context = JSON.stringify(body.messages);
    assert.match(context, /single corrective retry/); assert.match(context, /already in the host catalog/);
    assert.match(context, /subtopic_1/); assert.match(context, new RegExp(refs[5]));
    return actions(tool("select_literature_papers", select(refs.slice(5))), tool("download_papers", { paper_refs: refs.slice(5) }));
  });
  const pending = await run({ ...p, resume });
  assert.deepEqual(pending.data.desktopToolCalls.map(call => call.name), ["download_papers"]);
  assert.deepEqual(pending.data.desktopToolCalls[0].args.paper_refs, refs.slice(5));
  assert.equal(pending.continuationState.academicState.searchCalls, 1);
  assert.equal(pending.continuationState.totalToolCalls, 6);
  assert.equal(pending.continuationState.academicState.emptyResponseRecovery.retryUsed, true);
  const finalProvider = provider(t, () => answer("Saved five suitable papers."));
  const final = await run({ ...finalProvider, resume: withResult(pending, { version: 1, status: "completed", results: refs.slice(5).map((paper_ref, i) =>
    ({ paper_ref, status: "downloaded", path: `literature/recovered-${i}.pdf`, contentType: "application/pdf" })) }) });
  assert.equal(final.ok, true); assert.equal(final.data.taskOutcome.downloadSuccessCount, 5);
  assert.equal(final.data.taskOutcome.emptyResponseRecovery.status, "responded");
  assert.equal(final.data.reply, "Saved five suitable papers.");
  assert.equal(final.data.downloadResults.length, 7);
});

test("repeated empty responses preserve prior usable summary, actual files and safe diagnostics", async t => {
  const resume = await downloaded(t);
  const p = provider(t, count => count === 1 ? answer(summary) : { content: null });
  const final = await run({ ...p, resume });
  assert.equal(p.requests.length, 3); assert.equal(final.error, "AgentTaskIncomplete");
  assert.equal(final.data.reply, summary); assert.equal(final.data.taskOutcome.status, "incomplete");
  assert.equal(final.data.taskOutcome.downloadSuccessCount, 3); assert.equal(final.data.downloadResults.length, 5);
  assert.equal(final.data.taskOutcome.emptyResponseRecovery.stoppingLimit, "empty_response_retry_exhausted");
  assert.equal(final.data.taskOutcome.emptyResponseRecovery.diagnostics.requestId, "request-fixture");
  assert.match(final.reason, /no usable assistant content.*3 of 5/s);
  assert.doesNotMatch(JSON.stringify(final), /NEVER_EXPOSE|fixture-api-key/);
});

for (const budget of ["llm", "tool", "time"]) test(`${budget} budget prevents an empty-response corrective retry`, async t => {
  const resume = await downloaded(t);
  resume.academicState.downloadRecoveryUsed = true;
  resume.academicState.lastUsableReply = { reply: summary };
  if (budget === "llm") resume.step = 7;
  if (budget === "tool") resume.totalToolCalls = 24;
  const p = provider(t, () => {
    if (budget === "time") resume.academicState.startedAt = Date.now() - planning.LIMITS.moveMs;
    return { content: null };
  });
  const final = await run({ ...p, resume });
  assert.equal(p.requests.length, 1);
  assert.equal(final.data.reply, summary); assert.equal(final.data.taskOutcome.downloadSuccessCount, 3);
  assert.equal(final.data.taskOutcome.emptyResponseRecovery.stoppingLimit, `${budget}_budget_exhausted`);
  assert.notEqual(final.data.taskOutcome.emptyResponseRecovery.retryUsed, true);
});

test("legacy continuation recovers prior assistant summary from trace", async t => {
  const resume = await downloaded(t);
  resume.academicState.downloadRecoveryUsed = true;
  resume.step = 7;
  resume.agentMessages.push({ role: "assistant", content: JSON.stringify({ reply: summary }) });
  const p = provider(t, () => ({ content: "" }));
  const final = await run({ ...p, resume });
  assert.equal(final.data.reply, summary); assert.equal(p.requests.length, 1);
});

test("without a usable prior reply the fallback describes verified files and the recovery blocker", async t => {
  const resume = await downloaded(t);
  resume.academicState.downloadRecoveryUsed = true;
  const p = provider(t, () => ({ content: null }));
  const final = await run({ ...p, resume });
  assert.equal(p.requests.length, 2);
  assert.match(final.data.reply, /3 \/ 5 PDFs saved/);
  assert.match(final.data.reply, /no usable assistant content/);
  assert.equal(final.data.taskOutcome.status, "incomplete");
});

test("ordinary chat empty responses do not acquire literature recovery", async t => {
  const p = provider(t, () => ({ content: null }));
  const final = await run({ ...p, surface: "side_chat" });
  assert.equal(p.requests.length, 1); assert.equal(final.error, "EmptyLlmResponse");
});

test("empty detection ignores reported usage and preserves only safe provider diagnostics", async t => {
  t.mock.method(global, "fetch", async () => new Response(JSON.stringify({
    id: "provider-response-id", choices: [{ message: { content: "", tool_calls: [{}] }, finish_reason: "content_filter" }],
    usage: { completion_tokens: 27, completion_tokens_details: { reasoning_tokens: 27, private_prompt: "DO_NOT_LOG" }, other: "DO_NOT_LOG" },
    error: { code: "FILTERED", type: "fixture-api-key", message: "DO_NOT_LOG" }, promptFeedback: { blockReason: "SAFETY" },
  })));
  const result = await requestRequestyMessage({ messages: [] }, "fixture-api-key");
  assert.equal(result.error, "EmptyLlmResponse"); assert.equal(result.finishReason, "content_filter");
  assert.equal(result.requestId, "provider-response-id"); assert.equal(result.usage.completion_tokens, 27);
  assert.deepEqual(result.usage.completion_tokens_details, { reasoning_tokens: 27 });
  assert.deepEqual(result.providerCodes, ["FILTERED", "SAFETY"]);
  assert.doesNotMatch(JSON.stringify(result), /DO_NOT_LOG|fixture-api-key/);
});

test("one retry allowance survives selection/download continuations and refreshes stale outcome counts", async t => {
  const resume = await downloaded(t);
  const p = provider(t, count => count === 1 ? answer(summary) : count === 2 ? { content: "" }
    : actions(tool("select_literature_papers", select(refs.slice(5))), tool("download_papers", { paper_refs: refs.slice(5) })));
  const pending = await run({ ...p, resume });
  const resumed = withResult(pending, { version: 1, status: "partial", results: refs.slice(5).map(paper_ref =>
    ({ paper_ref, status: "failed", error: { code: "NO_ACCESSIBLE_PDF" } })) });
  const empty = provider(t, () => ({ content: "" }));
  const final = await run({ ...empty, resume: resumed });
  assert.equal(empty.requests.length, 1);
  assert.notEqual(final.data.reply, summary, "The old summary said two failures; four attempts have now failed");
  assert.match(final.data.reply, /3 \/ 5 PDFs saved/); assert.match(final.data.reply, /Source 7/);
  assert.equal(final.data.downloadResults.length, 7);
  assert.equal(final.data.taskOutcome.downloadSuccessCount, 3);
  assert.equal(final.data.taskOutcome.emptyResponseRecovery.stoppingLimit, "empty_response_retry_exhausted");
});

test("empty finalization at the existing loop limit preserves verified results without retrying", async t => {
  const resume = await downloaded(t);
  resume.academicState.downloadRecoveryUsed = true;
  resume.academicState.lastUsableReply = { reply: summary };
  resume.step = 8;
  const p = provider(t, () => ({ content: null }));
  const final = await run({ ...p, resume });
  assert.equal(p.requests.length, 1);
  assert.equal(p.requests[0].tools.length, 0);
  assert.equal(final.data.reply, summary); assert.equal(final.data.taskOutcome.downloadSuccessCount, 3);
  assert.equal(final.data.taskOutcome.emptyResponseRecovery.stoppingLimit, "llm_budget_exhausted");
});

test("expired recovery continuations make no extra model request, including finalization", async t => {
  for (const step of [5, 8]) {
    const resume = await downloaded(t);
    resume.step = step;
    Object.assign(resume.academicState, { downloadRecoveryUsed: true, lastUsableReply: { reply: summary },
      startedAt: Date.now() - planning.LIMITS.moveMs, emptyResponseRecovery: { retryUsed: true, status: "retrying",
        diagnostics: { finishReason: "stop", requestId: "original-empty", usage: { completion_tokens: 0 } } } });
    const final = await run({ resume, requestTurn: async () => { assert.fail("Time budget already exhausted"); } });
    assert.equal(final.data.reply, summary);
    assert.equal(final.data.taskOutcome.emptyResponseRecovery.diagnostics.requestId, "original-empty");
    assert.equal(final.data.taskOutcome.emptyResponseRecovery.stoppingLimit, "time_budget_exhausted");
  }
});

test("a usable budget-final explanation closes the empty-response recovery status", async t => {
  const resume = await downloaded(t);
  resume.step = 8;
  Object.assign(resume.academicState, { downloadRecoveryUsed: true, emptyResponseRecovery: { retryUsed: true, status: "retrying" } });
  const p = provider(t, () => answer(summary));
  const final = await run({ ...p, resume });
  assert.equal(final.data.reply, summary);
  assert.equal(final.data.taskOutcome.emptyResponseRecovery.status, "responded");
  assert.equal(final.data.taskOutcome.status, "incomplete");
});
