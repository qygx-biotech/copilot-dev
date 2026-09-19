"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const { access, mkdtemp, rm } = require("node:fs/promises"), path = require("node:path"), os = require("node:os");
const { runSideChatAgent } = require("../side-chat-agent.js");
const semantic = require("../../shared/semantic-intent.js"), contract = require("../../shared/academic-tools.js");
const planning = require("../academic-planning.js"), recovery = require("../academic-recovery.js"), continuation = require("../agent-continuation.js");
const query = "Find design and validation literature and download two relevant papers.";
const plan = { request_kind: "topic", subtopics: ["design", "validation"], synonyms: [], queries: ["design", "validation"], requested_count: 2, year_from: 2023, year_to: 2025 };
const search = { query: "design", queries: ["validation"], providers: ["arxiv", "crossref"], limit: 5, per_source_limit: 20,
  year_from: 2023, year_to: 2025, prefer_open_access: false };
const ir = { ...semantic.interpretLocal({ query }), matchedPattern: null, retrievalScope: "web", objects: ["literature"], operations: ["search", "store"],
  capabilityHints: ["search_papers", "download_sources"], requestedOutput: { type: "papers", limit: 2 } };
const call = (name, args) => ({ id: name, type: "function", function: { name, arguments: JSON.stringify(args) } });
const actions = (...tool_calls) => ({ ok: true, message: { tool_calls } });
const answer = () => ({ ok: true, message: { content: "Saved the two selected papers." } });
const select = papers => ({ shortlist: papers.map((paper, i) => ({ paper_ref: paper.paper_ref, relevance: 5, covers: [`subtopic_${i + 1}`],
  reason: "Direct evidence for the requested design and validation topics.", evidence: "title_abstract" })), stop_reason: "sufficient_candidates", remaining_gaps: [] });
const run = options => runSideChatAgent({ surface: "agent_command", desktopAcademic: true, desktopDownloads: true, downloadPermission: "workspace_write",
  systemPrompt: "Complete the authorized literature request.", originalRequest: query, conversationMessages: [{ role: "user", content: query }],
  workspaceContext: { localWorkspaceContext: { semantic: { ir } } }, parseFinalAnswer: reply => ({ reply }), ...options });
const stateMessage = request => JSON.parse(request.messages.findLast(message => message.content?.startsWith("Literature workflow progress (host state): ")).content.split("\n")[0].slice("Literature workflow progress (host state): ".length));
function resumeWith(pending, results) {
  const binding = { project: "candidate-pool", account: "test" };
  return continuation.withResults(continuation.open(continuation.seal(pending.continuationState, binding, "secret"), binding, "secret"),
    pending.data.desktopToolCalls.map((tool, i) => ({ id: tool.id, result: results[i] })));
}
async function local(t, large = false) {
  const python = path.resolve(__dirname, "../../desktop/paper-search/.venv", process.platform === "win32" ? "Scripts/python.exe" : "bin/python");
  try { await access(python); } catch { t.skip("paper:build installs Python dependencies for production stdio integration tests."); return; }
  const { PaperMcpClient } = await import("../../desktop/services/paper-mcp-client.mjs");
  const { ProjectFilesystem } = await import("../../desktop/services/project-filesystem.mjs");
  const { LocalExecutionService } = await import("../../desktop/services/local-execution-service.mjs");
  const { registerAcademicWorkflows } = await import("../../desktop/services/academic-workflows.mjs");
  const root = await mkdtemp(path.join(os.tmpdir(), "literature-pool-")); t.after(() => rm(root, { recursive: true, force: true }));
  const filesystem = await ProjectFilesystem.open(root), pdf = Buffer.from("%PDF-1.7\ncontrolled pool fixture");
  const mcp = new PaperMcpClient({ command: python, args: [path.resolve(__dirname, "../../desktop/test/fixtures/paper-pool-mcp-fixture.py"), ...(large ? ["--large"] : [])] });
  t.after(() => mcp.close());
  const calls = [], active = { execution: new LocalExecutionService(), sourceDownloads: new AbortController() };
  registerAcademicWorkflows(active, { call: async (name, args, signal) => { calls.push({ name, args }); return mcp.call(name, args, signal); } }, () => true,
    { fetchSource: async url => ({ bytes: pdf, contentType: "application/pdf", resolvedUrl: url }) });
  return { calls, filesystem, pdf, execute: tool => active.execution.run(tool.name, { args: tool.args, surface: "agent_command", permission: "workspace_write" }, { filesystem }) };
}
async function searched(executor) {
  const pending = await run({ requestTurn: async () => actions(call("plan_literature_search", plan), call("search_academic_papers", search)) });
  const result = await executor(pending.data.desktopToolCalls[0]);
  return { result, resume: resumeWith(pending, [result]) };
}

for (const [optional, large] of [[false, false], [true, false], [false, true]]) test(`production harness / real local MCP pool → selection → saved files; optional further search=${optional}, size-limited=${large}`, async t => {
  const f = await local(t, large); if (!f) return;
  const initial = await searched(f.execute); let resume = initial.resume;
  const pool = initial.result;
  if (large) assert.ok(pool.papers.length >= 2 && pool.papers.length < 20, "Stop at the existing response-size budget");
  else assert.equal(pool.papers.length, 20, "One search returns four former five-record slices for comparison");
  assert.equal(new Set(pool.papers.map(paper => paper.paper_ref)).size, pool.papers.length);
  assert.ok(JSON.stringify(pool.papers).length <= 65000); assert.ok(JSON.stringify(pool).length < 90000);
  assert.equal(pool.total_candidates, 30); assert.ok(pool.next_cursor.endsWith(":" + pool.papers.length));
  assert.equal(pool.metrics.provider_jobs, 4); assert.equal(pool.metrics.raw_candidates, 80);
  assert.ok(pool.papers.every(paper => paper.providers.length === 2), "Cross-provider duplicates merge before slicing");
  assert.equal(resume.answerModelCalls, 1, "No LLM calls between internally consumed cached slices");
  assert.equal(resume.totalToolCalls, 2); assert.equal(resume.academicState.discoveryCalls, 1);
  assert.deepEqual(f.calls.map(call => call.name), ["search_academic_papers"]);

  if (optional) {
    // The LLM can choose more candidates; exact original cursor arguments persist.
    const page = await run({ resume, requestTurn: async request => {
      assert.equal(stateMessage(request).required_tool, "select_literature_papers");
      assert.ok(request.tools.some(tool => tool.function.name === "search_academic_papers"));
      return actions(call("search_academic_papers", { ...search, cursor: pool.next_cursor }));
    } });
    assert.deepEqual(page.data.desktopToolCalls[0].args, { ...search, cursor: pool.next_cursor });
    const more = await f.execute(page.data.desktopToolCalls[0]);
    assert.equal(more.papers.length, 5); assert.equal(more.metrics.provider_jobs, 0);
    assert.equal(more.next_cursor.split(":")[1], "25");
    assert.equal(new Set([...pool.papers, ...more.papers].map(paper => paper.paper_ref)).size, 25);
    resume = resumeWith(page, [more]);
    const focused = await run({ resume, requestTurn: async () => actions(call("search_academic_papers", { ...search, query: "coverage gap", queries: ["additional evidence"] })) });
    const further = await f.execute(focused.data.desktopToolCalls[0]);
    resume = resumeWith(focused, [further]);
    assert.equal(resume.academicState.discoveryCalls, 3);
  }

  const chosen = resume.academicState.papers.slice(0, 2);
  const saving = await run({ resume, requestTurn: async request => {
    assert.equal(stateMessage(request).required_tool, "select_literature_papers");
    assert.match(stateMessage(request).next, /next_cursor alone never/);
    return actions(call("select_literature_papers", select(chosen)), call("download_papers", { paper_refs: chosen.map(paper => paper.paper_ref) }));
  } });
  assert.equal(saving.data.desktopToolCalls[0].name, "download_papers");
  assert.equal(saving.continuationState.academicState.validationRecovery?.failures || 0, 0);
  assert.equal(saving.continuationState.totalToolCalls, optional ? 6 : 4);
  const saved = await f.execute(saving.data.desktopToolCalls[0]);
  const final = await run({ resume: resumeWith(saving, [saved]), requestTurn: answer });
  assert.equal(final.ok, true); assert.equal(final.data.taskOutcome.downloadSuccessCount, 2);
  for (const item of final.data.downloadResults) assert.deepEqual(Buffer.from(await f.filesystem.readBinary(item.path)), f.pdf);
  assert.equal(final.data.academicSearchStatus.model.calls, optional ? 5 : 3);
  assert.equal(final.data.academicSearchStatus.searchCalls, optional ? 3 : 1);
  assert.equal(final.data.academicSelection.validation?.failures || 0, 0);
});

// Host-only cases remain runnable without the optional Python build environment.
const fixturePaper = i => ({ paper_ref: "paper_" + String(i).padStart(24, "0"), title: `Design and validation study ${i}`, authors: [`Author ${i}`],
  doi: `10.1000/${i}`, abstract: "Design and validation evidence.", published_date: "2024-01-01", providers: [], locations: [] });
const controlled = () => searched(async () => ({ version: 1, status: "completed", papers: [fixturePaper(1), fixturePaper(2)], next_cursor: "old:2", total_candidates: 30 }));

for (const code of ["INSPECT_NEXT_PAGE_BEFORE_SELECTION", "UNINSPECTED_CANDIDATES_REMAIN"]) test(`legacy continuation retires only obsolete ${code} gate and revalidates before download`, async () => {
  const { resume } = await controlled(), state = resume.academicState;
  const selection = select(state.papers);
  recovery.failure(state, "select_literature_papers", selection, { code, details: { required_tool_call: { name: "search_academic_papers", arguments: { ...search, cursor: "old:2" } } } });
  recovery.exhaust(state, "identical_failed_arguments");
  const saving = await run({ resume, requestTurn: async request => {
    assert.equal(stateMessage(request).required_tool, "select_literature_papers");
    assert.ok(request.tools.some(tool => tool.function.name === "download_papers"));
    return actions(call("select_literature_papers", selection), call("download_papers", { paper_refs: state.papers.map(paper => paper.paper_ref) }));
  } });
  assert.equal(saving.data.desktopToolCalls[0].name, "download_papers");
  assert.equal(saving.continuationState.academicState.validationRecovery.pending, false);
  assert.equal(saving.continuationState.academicState.discoveryCalls, 1);
});

test("optional searches retain candidate, query, call and time budgets before desktop dispatch", async () => {
  assert.deepEqual(planning.LIMITS, { searchCalls: 4, focusedQueries: 6, candidates: 120, discoveryMs: 140000, moveMs: 600000 });
  const cases = [
    [state => { state.discoveryCalls = 4; }, "LITERATURE_SEARCH_BUDGET_EXHAUSTED"],
    [state => { state.discoveryMs = 140000; }, "LITERATURE_SEARCH_BUDGET_EXHAUSTED"],
    [state => { state.startedAt = Date.now() - 600001; }, "LITERATURE_TIME_BUDGET_EXHAUSTED"],
    [state => { state.papers = Array.from({ length: 120 }, (_, i) => fixturePaper(i)); }, "LITERATURE_SEARCH_BUDGET_EXHAUSTED"],
    [state => { state.searchedQueries = ["design", "validation", "q3", "q4", "q5", "q6"]; }, "LITERATURE_QUERY_BUDGET_EXHAUSTED"],
  ];
  for (const [exhaust, code] of cases) {
    const { resume } = await controlled(); exhaust(resume.academicState); let calls = 0;
    const final = await run({ resume, requestTurn: async request => {
      if (++calls === 1) return actions(call("search_academic_papers", { query: "another query" }));
      const error = JSON.parse(request.messages.findLast(message => message.role === "tool").content).error;
      assert.equal(error.code, code);
      // Report the concrete limit instead of attempting more provider calls.
      return { ok: false, error: "CONTROLLED_STOP_AFTER_BUDGET_CHECK" };
    } });
    assert.equal(final.data.desktopToolCalls, undefined);
    assert.equal(calls, 2);
  }
  assert.equal(contract.tools[0].function.parameters.properties.limit.maximum, 20);
  assert.throws(() => contract.validateResult("search_academic_papers", { version: 1, status: "completed", papers: Array.from({ length: 21 }, (_, i) => fixturePaper(i)) }));
});

test("candidate-pool workflow retains the global eight-step and 24-tool ceilings", async () => {
  const exhausted = await controlled(); exhausted.resume.step = 8;
  let turns = 0;
  const ended = await run({ resume: exhausted.resume, requestTurn: async request => {
    turns++; assert.deepEqual(request.tools, [], "Only the existing final answer call remains after eight steps"); return answer();
  } });
  assert.equal(turns, 1); assert.equal(ended.data.desktopToolCalls, undefined);
  const last = await controlled(); last.resume.step = 7; last.resume.totalToolCalls = 24; turns = 0;
  const final = await run({ resume: last.resume, requestTurn: async request => {
    if (++turns === 1) return actions(call("search_academic_papers", { ...search, cursor: "old:2" }));
    assert.deepEqual(request.tools, []);
    assert.equal(JSON.parse(request.messages.findLast(message => message.role === "tool").content).error.code, "TOOL_BUDGET_EXCEEDED");
    return answer();
  } });
  assert.equal(turns, 2); assert.equal(final.data.desktopToolCalls, undefined);
  assert.equal(final.data.academicSearchStatus.searchCalls, 1, "No extra search was dispatched");
});
