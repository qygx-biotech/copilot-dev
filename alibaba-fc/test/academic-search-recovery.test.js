"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const contract = require("../../shared/academic-tools.js"), semantic = require("../../shared/semantic-intent.js");
const { runSideChatAgent, compactSideChatAgentMessages } = require("../side-chat-agent.js");
const continuation = require("../agent-continuation.js"), planning = require("../academic-planning.js");
const query = "Find and download two papers about AI-assisted biological design and experimental validation.";
const plan = { request_kind: "topic", subtopics: ["AI-assisted biological design", "Experimental validation"], synonyms: ["machine learning"],
  queries: ['"AI" AND "biological design"', '"AI" AND "experimental validation"'], requested_count: 2, year_from: 2023, year_to: 2026 };
const ir = { ...semantic.interpretLocal({ query }), matchedPattern: null, retrievalScope: "web", objects: ["literature"], operations: ["search", "store"],
  capabilityHints: ["search_papers", "download_sources"], requestedOutput: { type: "papers", limit: 2 } };
const ref = n => "paper_" + String(n).padStart(24, "0");
const paper = n => ({ paper_ref: ref(n), title: `AI biological design study ${n}`, authors: [`Author ${n}`], doi: `10.1000/${n}`,
  abstract: "AI-assisted biological design with experimental validation.", published_date: "2024-01-01", locations: [], providers: [] });
const call = (name, args, id = name) => ({ id, type: "function", function: { name, arguments: JSON.stringify(args) } });
const actions = (...tool_calls) => ({ ok: true, message: { tool_calls } });
const answer = content => ({ ok: true, message: { content } });
const searchArgs = { query: plan.queries[0], queries: [plan.queries[1]], limit: 3, providers: ["arxiv", "europepmc"] };
const selection = { shortlist: [1, 2].map(n => ({ paper_ref: ref(n), relevance: 5, covers: [`subtopic_${n}`],
  reason: "Direct design and experimental evidence.", evidence: "title_abstract" })), stop_reason: "sufficient_candidates", remaining_gaps: [] };
const run = options => runSideChatAgent({ surface: "agent_command", desktopAcademic: true, desktopDownloads: true, downloadPermission: "workspace_write",
  systemPrompt: "Complete the authorized request.", originalRequest: query, conversationMessages: [{ role: "user", content: query }],
  workspaceContext: { localWorkspaceContext: { semantic: { ir } } }, parseFinalAnswer: reply => ({ reply }), ...options });
const lastError = request => request.messages.filter(message => message.role === "tool").map(message => {
  try { return JSON.parse(message.content); } catch { return {}; }
}).findLast(result => result.error)?.error;
function resumeWith(result, resultFor) {
  const binding = { project: "search-regression", account: "test" };
  return continuation.withResults(continuation.open(continuation.seal(result.continuationState, binding, "secret"), binding, "secret"),
    result.data.desktopToolCalls.map(call => ({ id: call.id, result: resultFor(call) })));
}
const found = papers => ({ version: 1, status: "completed", papers });
async function saveAndFinish(resume, inspect = () => {}) {
  const save = await run({ resume, requestTurn: async request => {
    inspect(request);
    return actions(call("select_literature_papers", selection), call("download_papers", { paper_refs: [ref(1), ref(2)], destination: "literature/AI" }));
  } });
  assert.equal(save.data.desktopToolCalls[0].name, "download_papers");
  const downloaded = resumeWith(save, call => ({ version: 1, status: "completed", results: call.args.paper_refs.map(paper_ref => ({
    paper_ref, status: "downloaded", path: `literature/AI/${paper_ref}.pdf`, contentType: "application/pdf" })) }));
  const final = await run({ resume: downloaded, requestTurn: async () => answer("Saved the selected papers.") });
  assert.equal(final.data.taskOutcome.downloadSuccessCount, 2);
  assert.equal(final.ok, true);
  return final;
}

test("query normalization removes exact duplicates without changing meaning and validates limits afterwards", () => {
  const input = { query: '"AI" AND biology', queries: ['"AI" AND biology', '"AI" AND biology', 'ai AND biology', ' ai AND biology ', 'ai AND biology'], limit: 20 };
  const original = structuredClone(input);
  assert.deepEqual(contract.validateInput("search_academic_papers", input).queries, ['ai AND biology', ' ai AND biology ']);
  assert.deepEqual(input, original);
  for (const queries of [[], [input.query], [input.query, input.query]]) {
    assert.deepEqual(contract.validateInput("search_academic_papers", { query: input.query, queries }), { query: input.query });
  }
  const providers = contract.PROVIDERS.slice(0, 10);
  assert.deepEqual(contract.validateInput("search_academic_papers", { query: "a", queries: ["a", "b", "b", "a"], providers }).queries, ["b"]);
  const invalid = [
    [{ queries: ["a"] }, "query", null],
    [{ query: "a", queries: ["a", 42] }, "queries[0]", 42],
    [{ query: "a", queries: ["b", "c", "d", "e"] }, "queries", ["b", "c", "d", "e"]],
    [{ query: "a", queries: ["b", "c"], providers }, "queries", ["b", "c"]],
    [{ query: "a", limit: 21 }, "limit", 21],
    [{ query: "a", providers: ["invented"] }, "providers[0]", "invented"],
    [{ query: "a", prefer_open_access: "false" }, "prefer_open_access", "false"],
  ];
  for (const [args, field, invalidValue] of invalid) assert.throws(() => contract.validateInput("search_academic_papers", args), error => {
    assert.equal(error.code, "INVALID_ACADEMIC_INPUT"); assert.equal(error.details.field, field);
    assert.deepEqual(error.details.invalid_value, invalidValue); assert.ok(error.details.required_correction);
    assert.equal(error.details.required_tool, "search_academic_papers"); return true;
  });
});

for (const mode of ["history", "reactive", "legacy"]) test(`production plan compaction retains JSON, accepted coverage and next steps: ${mode}`, async () => {
  const longPlan = { ...plan, synonyms: Array.from({ length: 12 }, (_, i) => `design synonym ${i} ` + "context ".repeat(10)),
    queries: plan.queries.map(q => q + ' AND ("synthetic biology" OR "biological engineering")'.repeat(5)) };
  const args = { ...searchArgs, query: longPlan.queries[0], queries: [longPlan.queries[1]] };
  const first = await run({ requestTurn: async () => actions(call("plan_literature_search", longPlan), call("search_academic_papers", args)) });
  let resume = resumeWith(first, () => ({ ...found([paper(1), paper(2), paper(3)]), next_cursor: "pool:3" }));
  const page = await run({ resume, requestTurn: async () => actions(call("search_academic_papers", { ...resume.academicState.searches[0].args, cursor: "pool:3" })) });
  resume = resumeWith(page, () => found([paper(4), paper(5)]));
  const metadata = await run({ resume, requestTurn: async () => actions(call("get_academic_paper", { paper_ref: ref(1) })) });
  resume = resumeWith(metadata, () => found([paper(1)]));
  const recorded = resume.agentMessages.find(message => message.name === "plan_literature_search");
  assert.ok(recorded.content.length > 1200, "Fixture reaches the old raw-string compaction threshold");
  if (mode === "legacy") {
    recorded.content = recorded.content.slice(0, 700) + "\n[Earlier tool result compacted. Call the same bounded tool again to recover detail.]";
    delete recorded.name; // Older trace: identify the result by tool-call pairing.
  }
  const accepted = structuredClone(resume.academicState.plan);
  let modelCalls = 0, originalReceipt, previewRef;
  const pending = await run({ resume, systemPrompt: mode === "reactive" ? "Context ".repeat(22000) : "Complete the request.", requestTurn: async request => {
    modelCalls++;
    let result = JSON.parse(request.messages.find(message => message.tool_call_id === recorded.tool_call_id).content);
    if (result.contextArchive) {
      assert.equal(mode, "reactive"); assert.equal(result.omitted, true);
      previewRef = result.contextArchive;
      // Verify the actual retained receipt after the production request returns.
      result = originalReceipt;
    } else originalReceipt = structuredClone(result);
    assert.deepEqual(result.plan, accepted);
    assert.equal(result.recovered_from, "host_state");
    assert.equal(result.record_type, "accepted_plan");
    assert.equal(result.required_tool, undefined, "Historical plan receipts must not contain a later tool's next step");
    const progress = JSON.parse(request.messages.findLast(message => message.content?.startsWith("Literature workflow progress (host state): ")).content.split("\n")[0].slice("Literature workflow progress (host state): ".length));
    assert.equal(progress.required_tool, "select_literature_papers");
    assert.match(result.next, /already recorded/);
    assert.doesNotMatch(result.next, /call the same|record the plan again/i);
    assert.ok(!request.tools.some(tool => tool.function.name === "plan_literature_search"));
    if (mode === "reactive" && modelCalls === 1) return { ok: false, error: "CONTEXT_LENGTH_EXCEEDED", reason: "maximum context length exceeded" };
    return actions(call("select_literature_papers", selection), call("download_papers", { paper_refs: [ref(1), ref(2)] }));
  } });
  if (mode === "reactive") {
    assert.equal(modelCalls, 2, "preview reduction gets a provider retry before any history summary");
    const manager = new (require("../context-recovery.js").ContextRecovery)({ state: pending.continuationState.contextRecovery });
    assert.deepEqual(JSON.parse(await manager.archive.original(previewRef)), originalReceipt);
    assert.deepEqual(resume.academicState.plan, accepted);
  }
  assert.equal(modelCalls, mode === "reactive" ? 2 : 1);
  assert.equal(pending.data.desktopToolCalls[0].name, "download_papers");
  // Also check a very small compaction target and accepted legacy ID spellings.
  const state = structuredClone(resume.academicState);
  state.plan.coverage_topics[0].id = "accepted_legacy_topic";
  const compacted = compactSideChatAgentMessages(resume.agentMessages, query, 500, state);
  const compactPlan = JSON.parse(compacted.find(message => message.tool_call_id === recorded.tool_call_id).content);
  assert.equal(compactPlan.plan.coverage_topics[0].id, "accepted_legacy_topic");
  assert.deepEqual(compactPlan.plan.subtopics, longPlan.subtopics);
  const complete = resumeWith(pending, call => ({ version: 1, status: "completed", results: call.args.paper_refs.map(paper_ref => ({
    paper_ref, status: "downloaded", path: `literature/${paper_ref}.pdf`, contentType: "application/pdf" })) }));
  assert.equal((await run({ resume: complete, requestTurn: async () => answer("Saved two papers.") })).ok, true);
});

test("production search recovery corrects the actual field, normalizes duplicates, and continues selection/download", async () => {
  let turns = 0;
  const original = { ...searchArgs, queries: [searchArgs.query, ...searchArgs.queries, ...searchArgs.queries], limit: 21 };
  const result = await run({ requestTurn: async request => {
    if (++turns === 1) return actions(call("plan_literature_search", plan), call("search_academic_papers", original));
    const error = lastError(request);
    assert.equal(error.code, "INVALID_ACADEMIC_INPUT"); assert.equal(error.field, "limit"); assert.equal(error.invalid_value, 21);
    assert.equal(error.maximum, 20); assert.equal(error.requires_user_confirmation, false);
    assert.ok(request.messages.some(message => message.content?.includes('"field":"limit"')));
    if (turns === 2) return actions(call("search_academic_papers", original));
    assert.equal(error.identical_failed_retry, true);
    return actions(call("search_academic_papers", { ...original, limit: error.maximum }));
  } });
  assert.equal(turns, 3); assert.equal(result.data.desktopToolCalls.length, 1);
  assert.equal(result.continuationState.totalToolCalls, 3, "Only the plan, first invalid search and corrected search are charged");
  assert.deepEqual(result.data.desktopToolCalls[0].args.queries, searchArgs.queries);
  assert.equal(result.continuationState.academicState.discoveryCalls, 1);
  assert.equal(result.continuationState.academicState.validationRecovery.pending, false);
  await saveAndFinish(resumeWith(result, () => found([paper(1), paper(2), paper(3)])));
});

test("identical invalid search retries stop before redispatch or extra tool-budget charges and retain an informative final error", async () => {
  let turns = 0;
  const bad = { ...searchArgs, limit: 21 };
  const final = await run({ requestTurn: async request => {
    turns++; assert.ok(turns <= 3);
    if (turns === 3) assert.equal(lastError(request).identical_failed_retry, true);
    return actions(...(turns === 1 ? [call("plan_literature_search", plan)] : []), call("search_academic_papers", bad),
      ...(turns === 3 ? [call("download_papers", { paper_refs: [ref(1)] })] : []));
  } });
  assert.equal(final.ok, false); assert.equal(final.reason, "INVALID_ACADEMIC_INPUT");
  assert.equal(final.data.academicSearchStatus.searchCalls, 0);
  assert.equal(final.data.academicSelection.search_calls, 0);
  assert.equal(final.data.academicSelection.validation.failures, 1);
  assert.equal(final.data.academicSelection.validation.duplicate_retries, 2);
  assert.equal(final.data.taskOutcome.downloadAttemptCount, 0);
  assert.match(final.data.reply, /internal academic search validation remains unresolved/);
  assert.match(final.data.reply, /field=limit; invalid_value=21/);
  assert.match(final.data.reply, /integer from 1 to 20/);
  assert.match(final.data.reply, /Search candidates: 0; accepted selected papers: 0; successfully saved PDF files: 0/);
  assert.match(final.data.reply, /not a user-confirmation requirement/);
});

test("a desktop INVALID_ACADEMIC_INPUT response enters recovery and an identical retry is suppressed before another handoff", async () => {
  const first = await run({ requestTurn: async () => actions(call("plan_literature_search", plan), call("search_academic_papers", searchArgs)) });
  const dispatched = first.data.desktopToolCalls[0].args;
  const resume = resumeWith(first, () => ({ version: 1, status: "failed", error: { code: "INVALID_ACADEMIC_INPUT" } }));
  let turns = 0;
  const corrected = await run({ resume, requestTurn: async request => {
    if (++turns === 1) return actions(call("search_academic_papers", dispatched));
    assert.equal(lastError(request).identical_failed_retry, true);
    return actions(call("search_academic_papers", { ...dispatched, providers: ["arxiv"] }));
  } });
  assert.equal(turns, 2);
  assert.equal(corrected.continuationState.totalToolCalls, 3, "Only plan, original search and corrected search are charged");
  assert.equal(corrected.continuationState.academicState.discoveryCalls, 2);
  await saveAndFinish(resumeWith(corrected, () => found([paper(1), paper(2), paper(3)])));
});
