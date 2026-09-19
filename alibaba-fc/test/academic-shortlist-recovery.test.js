"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const semantic = require("../../shared/semantic-intent.js");
const { runSideChatAgent } = require("../side-chat-agent.js");
const academic = require("../academic-agent.js"), planning = require("../academic-planning.js"), continuation = require("../agent-continuation.js");
const query = "Find AI and synthetic biology papers and download two relevant papers.";
const invalidLabel = "AI-driven synthetic biology applications";
const plan = { request_kind: "topic", subtopics: ["AI-assisted biological design", "Experimental validation"], synonyms: ["machine learning"],
  queries: [invalidLabel, "experimental validation of AI biological design"], requested_count: 2, year_from: 2023, year_to: 2026 };
const ir = { ...semantic.interpretLocal({ query }), matchedPattern: null, retrievalScope: "web", objects: ["literature"], operations: ["search", "store"],
  capabilityHints: ["search_papers", "download_sources"], requestedOutput: { type: "papers", limit: 2 } };
const ref = n => "paper_" + String(n).padStart(24, "0");
const paper = n => ({ paper_ref: ref(n), title: `AI biological design study ${n}`, authors: [`Author ${n}`], doi: `10.1000/${n}`, abstract: "AI-assisted design and experimental validation.",
  published_date: "2024-01-01", providers: [], locations: [] });
const selection = (bad = false) => ({ shortlist: [1, 2].map(n => ({ paper_ref: ref(n), relevance: 5, covers: [bad && n === 1 ? invalidLabel : `subtopic_${n}`],
  reason: n === 1 ? "Studies AI-assisted biological design." : "Reports experimental validation.", evidence: "title_abstract" })), stop_reason: "sufficient_candidates", remaining_gaps: [] });
const call = (name, args, id = name) => ({ id, type: "function", function: { name, arguments: JSON.stringify(args) } });
const answer = content => ({ ok: true, message: { content } });
const actions = (...tool_calls) => ({ ok: true, message: { tool_calls } });
const run = options => runSideChatAgent({ surface: "agent_command", desktopAcademic: true, desktopDownloads: true, downloadPermission: "workspace_write",
  systemPrompt: "Complete the authorized literature request.", originalRequest: query, conversationMessages: [{ role: "user", content: query }],
  workspaceContext: { localWorkspaceContext: { semantic: { ir } } }, parseFinalAnswer: reply => ({ reply }), ...options });
const lastError = request => request.messages.filter(message => message.role === "tool").map(message => JSON.parse(message.content)).findLast(output => output.error)?.error;
function resumeWith(result, outputs) {
  const binding = { account: "test", project: "local-project" };
  // Exercise the same signed continuation transport as production resumes.
  return continuation.withResults(continuation.open(continuation.seal(result.continuationState, binding, "secret"), binding, "secret"), outputs);
}
async function searched(nextCursor = null, complementary = true) {
  const first = await run({ requestTurn: async () => actions(call("plan_literature_search", plan), call("search_academic_papers", {
    query: plan.queries[0], ...(complementary ? { queries: plan.queries.slice(1) } : {}), providers: ["europepmc", "arxiv"], limit: 3, per_source_limit: 20,
    year_from: 2023, year_to: 2026, prefer_open_access: false,
  })) });
  return resumeWith(first, [{ id: "search_academic_papers", result: { version: 1, status: "completed", papers: [paper(1), paper(2), paper(3)],
    next_cursor: nextCursor, total_candidates: nextCursor ? 6 : 3 } }]);
}
function downloaded(result) {
  const call = result.data.desktopToolCalls[0];
  assert.equal(call.name, "download_papers");
  return resumeWith(result, [{ id: call.id, result: { version: 1, status: "completed", results: call.args.paper_refs.map(paper_ref => ({
    paper_ref, status: "downloaded", path: `literature/${paper_ref}.pdf`, contentType: "application/pdf",
  })) } }]);
}

test("accepted plans advertise coverage ID enums and legacy labels normalize without fuzzy reassignment", async () => {
  const resume = await searched();
  const state = resume.academicState;
  assert.deepEqual(state.plan.coverage_topics, [{ id: "subtopic_1", label: plan.subtopics[0] }, { id: "subtopic_2", label: plan.subtopics[1] }]);
  const schema = planning.toolDefinitions(state).find(tool => tool.function.name === "select_literature_papers").function.parameters;
  assert.deepEqual(schema.properties.shortlist.items.properties.covers.items.enum, ["subtopic_1", "subtopic_2"]);
  assert.match(schema.properties.shortlist.items.properties.covers.description, /AI-assisted biological design/);
  delete state.plan.coverage_topics; // Previously issued v2 continuation.
  const legacy = selection(); legacy.shortlist[0].covers = [plan.subtopics[0]]; legacy.shortlist[1].covers = [plan.subtopics[1]];
  const selected = planning.execute(state, "select_literature_papers", legacy, 2);
  assert.deepEqual(selected.shortlist[0].covers, ["subtopic_1"]);
  assert.deepEqual(selected.shortlist[0].coverage_labels, [plan.subtopics[0]]);
  const acceptedBefore = JSON.stringify(state.shortlist);
  assert.throws(() => planning.execute(state, "select_literature_papers", selection(true), 2), error => {
    assert.equal(error.code, "UNKNOWN_SELECTION_SUBTOPIC"); assert.equal(error.details.paper_ref, ref(1));
    assert.equal(error.details.invalid_value, invalidLabel); assert.deepEqual(error.details.allowed_values, ["subtopic_1", "subtopic_2"]);
    assert.match(error.details.required_correction, /unrelated category/); return true;
  });
  assert.equal(JSON.stringify(state.shortlist), acceptedBefore, "An invalid selection must not mutate the accepted shortlist");
  const noCoverage = selection(); noCoverage.shortlist[0].covers = [];
  assert.deepEqual(planning.execute(state, "select_literature_papers", noCoverage, 2).shortlist.find(item => item.paper_ref === ref(1)).covers, []);
  const old = { ...academic.initial(), workflowVersion: 1, papers: [paper(1)] };
  assert.doesNotThrow(() => planning.beforeTool(old, "download_papers", { paper_refs: [ref(1)] }, "legacy", 1));
  const collision = { ...state, plan: { ...state.plan, subtopics: ["subtopic_2", "Experimental validation"] } };
  const literalLabel = selection(); literalLabel.shortlist[0].covers = ["subtopic_2"]; literalLabel.shortlist[1].covers = ["Experimental validation"];
  const migrated = planning.execute(collision, "select_literature_papers", literalLabel, 2);
  assert.deepEqual(migrated.shortlist.find(item => item.paper_ref === ref(1)).coverage_labels, ["subtopic_2"], "An old literal label must not become another topic's ID");
  assert.notEqual(collision.plan.coverage_topics[1].id, "subtopic_2");
});

test("production harness corrects the actual invalid label, suppresses an identical retry, and continues authorized saving", async () => {
  const resume = await searched();
  let turns = 0;
  const result = await run({ resume, requestTurn: async request => {
    turns++;
    if (turns === 1) return actions(call("select_literature_papers", selection(true)));
    if (turns === 2) {
      const error = lastError(request);
      assert.equal(error.code, "UNKNOWN_SELECTION_SUBTOPIC"); assert.equal(error.invalid_value, invalidLabel);
      assert.equal(error.paper_ref, ref(1)); assert.equal(error.requires_user_confirmation, false);
      assert.deepEqual(error.allowed_values, ["subtopic_1", "subtopic_2"]);
      return actions(call("select_literature_papers", selection(true)));
    }
    if (turns === 3) {
      assert.equal(lastError(request).identical_failed_retry, true);
      assert.ok(request.messages.some(message => message.content?.includes("Literature validation correction (host state):")));
      const schema = request.tools.find(tool => tool.function.name === "select_literature_papers").function.parameters;
      assert.deepEqual(schema.properties.shortlist.items.properties.covers.items.enum, ["subtopic_1", "subtopic_2"]);
      const corrected = selection(true); corrected.shortlist[0].covers = [lastError(request).allowed_values[0]];
      return actions(call("select_literature_papers", corrected));
    }
    if (turns === 4) return answer("The user must confirm before downloading.");
    assert.equal(turns, 5);
    assert.ok(request.messages.some(message => message.content?.includes("The host accepted the literature shortlist.")));
    return actions(call("download_papers", { paper_refs: [ref(1), ref(2)], destination: "literature/AI" }));
  } });
  assert.equal(result.continuationState.totalToolCalls, 5, "The identical failed selection does not consume another tool-call slot");
  assert.equal(result.continuationState.academicState.validationRecovery.duplicate_retries, 1);
  assert.equal(result.data.desktopToolCalls[0].args.destination, "literature/AI");
  const final = await run({ resume: downloaded(result), requestTurn: async () => answer("Saved the papers.") });
  assert.equal(final.ok, true); assert.equal(final.data.taskOutcome.downloadSuccessCount, 2);
  assert.equal(final.data.taskOutcome.selectedPaperCount, 2); assert.equal(final.data.taskOutcome.candidateCount, 3);
  assert.equal(final.data.taskOutcome.blocker, undefined);
  assert.doesNotMatch(final.data.reply, /must confirm/);
});

test("identical invalid retries stop early and preserve the concrete validation blocker instead of asking for confirmation", async () => {
  const resume = await searched(); let turns = 0;
  const result = await run({ resume, requestTurn: async () => {
    turns++;
    assert.ok(turns <= 3, "Do not burn the remaining model-turn budget or request a final narrative to explain a host validation error");
    return actions(call("select_literature_papers", selection(true)), ...(turns === 3 ? [call("download_papers", { paper_refs: [ref(1)] })] : []));
  } });
  assert.equal(turns, 3); assert.equal(result.ok, false); assert.equal(result.reason, "UNKNOWN_SELECTION_SUBTOPIC");
  assert.equal(result.data.taskOutcome.stopReason, "validation_recovery_exhausted");
  assert.equal(result.data.taskOutcome.blocker.paper_ref, ref(1));
  assert.equal(result.data.taskOutcome.blocker.invalid_value, invalidLabel);
  assert.equal(result.data.taskOutcome.downloadAttemptCount, 0);
  assert.equal(result.data.academicSelection.validation.duplicate_retries, 2);
  assert.equal(result.data.academicSelection.validation.failures, 1);
  assert.equal(result.data.academicSelection.selected, 0); assert.equal(result.data.academicSources.length, 3);
  assert.deepEqual(result.data.downloadResults, []);
  assert.match(result.data.reply, /Search candidates: 3; accepted selected papers: 0; successfully saved PDF files: 0/);
  assert.match(result.data.reply, /UNKNOWN_SELECTION_SUBTOPIC/); assert.match(result.data.reply, /AI-driven synthetic biology applications/);
  assert.match(result.data.reply, /subtopic_1/); assert.match(result.data.reply, /not a user-confirmation requirement/);
});

test("optional pagination preserves original parameters; repeating the query is rejected before dispatch", async () => {
  const resume = await searched("pool:3"); let turns = 0;
  const original = resume.academicState.searches[0].args;
  const inspected = await run({ resume, requestTurn: async request => {
    turns++;
    if (turns === 1) return actions(call("search_academic_papers", original));
    assert.equal(turns, 2);
    assert.equal(lastError(request).code, "PAGINATION_CURSOR_REQUIRED");
    assert.equal(resume.academicState.discoveryCalls, 1, "Rejected initial-query repeats consume no search budget");
    assert.equal(resume.academicState.pagesInspected || 0, 0);
    const required = lastError(request).required_tool_call;
    return actions(call(required.name, required.arguments, "actual-page"));
  } });
  assert.equal(inspected.data.desktopToolCalls.length, 1);
  assert.deepEqual(inspected.data.desktopToolCalls[0].args, { ...original, cursor: "pool:3" });
  const afterPage = resumeWith(inspected, [{ id: "actual-page", result: { version: 1, status: "completed", papers: [paper(4), paper(5), paper(6)], total_candidates: 6 } }]);
  assert.equal(afterPage.academicState.pagesInspected, 1);
  const save = await run({ resume: afterPage, requestTurn: async () => actions(call("select_literature_papers", selection()), call("download_papers", { paper_refs: [ref(1), ref(2)] })) });
  const final = await run({ resume: downloaded(save), requestTurn: async () => answer("Saved two relevant papers.") });
  assert.equal(final.ok, true); assert.equal(final.data.taskOutcome.downloadSuccessCount, 2);
  assert.equal(final.data.academicSearchStatus.searchCalls, 2);
  assert.deepEqual(final.data.academicSearchStatus.history.map(entry => entry.page), [false, true]);
});

test("failed or non-advancing cursor responses never satisfy page inspection, and changed cursor parameters are rejected", async () => {
  for (const response of [{ version: 1, status: "failed", error: { code: "PROVIDER_NETWORK_ERROR" } },
    { version: 1, status: "completed", papers: [paper(1)], next_cursor: "pool:3" }]) {
    const resume = await searched("pool:3");
    const original = resume.academicState.searches[0].args;
    assert.throws(() => planning.beforeTool(resume.academicState, "search_academic_papers", { ...original, cursor: "pool:3", queries: ["different query"] }, "bad-page", 2), error => {
      assert.equal(error.code, "INVALID_SEARCH_PAGINATION"); assert.deepEqual(error.details.required_tool_call.arguments, { ...original, cursor: "pool:3" }); return true;
    });
    const page = await run({ resume, requestTurn: async () => actions(call("search_academic_papers", { ...original, cursor: "pool:3" })) });
    const after = resumeWith(page, [{ id: page.data.desktopToolCalls[0].id, result: response }]);
    assert.equal(after.academicState.pagesInspected || 0, 0);
    assert.equal(after.academicState.searchHistory.at(-1).page, false);
    assert.equal(after.academicState.lowYieldStreak, 0, "An unsuccessful cursor response is not evidence of diminishing returns");
    assert.equal(planning.execute(after.academicState, "select_literature_papers", selection(), 2).status, "completed");
  }
});

test("a model repeatedly asking for confirmation cannot erase validation errors at recovery exhaustion", async () => {
  const resume = await searched(); let turns = 0;
  const result = await run({ resume, requestTurn: async () => ++turns === 1 ? actions(call("select_literature_papers", selection(true))) : answer("Internal error; user confirmation is required.") });
  assert.equal(result.ok, false); assert.equal(result.reason, "UNKNOWN_SELECTION_SUBTOPIC");
  assert.equal(result.data.academicSelection.validation.model_turns, 3);
  assert.equal(turns, 4);
  assert.match(result.data.reply, /internal literature selection validation remains unresolved/);
  assert.doesNotMatch(result.data.reply, /user confirmation is required/);
});

test("a provider failure during correction preserves the original validation blocker and actual counts", async () => {
  const resume = await searched(); let turns = 0;
  const result = await run({ resume, requestTurn: async () => ++turns === 1 ? actions(call("select_literature_papers", selection(true))) : { ok: false, error: "MODEL_RATE_LIMITED" } });
  assert.equal(result.ok, false); assert.equal(result.reason, "UNKNOWN_SELECTION_SUBTOPIC");
  assert.equal(result.data.taskOutcome.validationRecoveryExhausted, true);
  assert.match(result.data.reply, /AI-driven synthetic biology applications/);
  assert.match(result.data.reply, /Recovery failure: MODEL_RATE_LIMITED/);
  assert.match(result.data.reply, /Search candidates: 3; accepted selected papers: 0; successfully saved PDF files: 0/);
});

test("a new concrete pagination blocker replaces a corrected coverage error", async () => {
  const resume = await searched("pool:3"); resume.academicState.pagesInspected = 1;
  let turns = 0;
  const page = await run({ resume, requestTurn: async request => {
    if (++turns === 1) return actions(call("select_literature_papers", selection(true)));
    if (turns === 2) return actions(call("search_academic_papers", { ...resume.academicState.searches[0].args, cursor: "pool:3", queries: ["changed query"] }));
    const error = lastError(request);
    assert.equal(error.code, "INVALID_SEARCH_PAGINATION");
    const correction = request.messages.findLast(message => message.content?.startsWith("Literature validation correction (host state):"));
    assert.match(correction.content, /INVALID_SEARCH_PAGINATION/);
    assert.doesNotMatch(correction.content, /UNKNOWN_SELECTION_SUBTOPIC/);
    return actions(call(error.required_tool_call.name, error.required_tool_call.arguments));
  } });
  const after = resumeWith(page, [{ id: page.data.desktopToolCalls[0].id, result: { version: 1, status: "completed", papers: [paper(4)] } }]);
  const save = await run({ resume: after, requestTurn: async () => actions(call("select_literature_papers", selection()), call("download_papers", { paper_refs: [ref(1), ref(2)] })) });
  assert.equal(save.data.desktopToolCalls[0].name, "download_papers");
  assert.equal(save.continuationState.academicState.validationRecovery.pending, false);
});

test("complementary search recovery returns to selection after the required search succeeds", async () => {
  const resume = await searched(null, false); let turns = 0;
  const search = await run({ resume, requestTurn: async request => {
    if (++turns === 1) return actions(call("select_literature_papers", selection()));
    const error = lastError(request);
    assert.equal(error.code, "COMPLEMENTARY_SEARCH_REQUIRED");
    return actions(call(error.required_tool_call.name, error.required_tool_call.arguments));
  } });
  const after = resumeWith(search, [{ id: search.data.desktopToolCalls[0].id, result: { version: 1, status: "completed", papers: [paper(4), paper(5)] } }]);
  assert.equal(after.academicState.validationRecovery.pending, false);
  const save = await run({ resume: after, requestTurn: async request => {
    assert.ok(request.tools.some(tool => tool.function.name === "select_literature_papers"));
    return actions(call("select_literature_papers", selection()), call("download_papers", { paper_refs: [ref(1), ref(2)] }));
  } });
  assert.equal(save.data.desktopToolCalls[0].name, "download_papers");
});
