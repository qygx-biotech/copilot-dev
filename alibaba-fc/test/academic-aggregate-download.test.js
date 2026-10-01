"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const { mkdtemp, rm } = require("node:fs/promises"), os = require("node:os"), path = require("node:path");
const { runSideChatAgent } = require("../side-chat-agent.js"), { requestRequestyMessage } = require("../index.js")._test;
const continuation = require("../agent-continuation.js"), academic = require("../../shared/academic-tools.js");
const planning = require("../academic-planning.js"), stateApi = require("../academic-agent.js"), compact = require("../academic-context.js");
const ref = n => "paper_" + String(n).padStart(24, "0");
const paper = n => ({ paper_ref: ref(n), title: `Distinct enzyme study ${n}`, authors: ["A"], doi: `10.1000/${n}`, abstract: "Enzyme design evidence.", providers: [], locations: [{ url: `https://papers.example.org/${n}.pdf`, kind: "pdf_candidate" }] });
const plan = count => ({ request_kind: "topic", subtopics: ["design"], queries: ["enzyme design", "enzyme validation"], synonyms: [], ...(count ? { requested_count: count } : {}) });
const select = refs => ({ shortlist: refs.map(paper_ref => ({ paper_ref, relevance: 5, covers: ["subtopic_1"], evidence: "title_abstract", reason: "Direct enzyme design evidence." })), stop_reason: "sufficient_candidates", remaining_gaps: [] });
let callSequence = 0;
const call = (name, args) => ({ id: `${name}-${++callSequence}`, type: "function", function: { name, arguments: JSON.stringify(args) } });
const pdf = Buffer.from("%PDF-1.7\nverified fixture\n%%EOF");

async function fixture(t, { fail = [], interrupt, total = 20, stallResolution = false } = {}) {
  const { ProjectFilesystem } = await import("../../desktop/services/project-filesystem.mjs");
  const { LocalExecutionService } = await import("../../desktop/services/local-execution-service.mjs");
  const { registerAcademicWorkflows } = await import("../../desktop/services/academic-workflows.mjs");
  const root = await mkdtemp(path.join(os.tmpdir(), "academic-aggregate-")); t.after(() => rm(root, { recursive: true, force: true }));
  const filesystem = await ProjectFilesystem.open(root), active = { execution: new LocalExecutionService(), sourceDownloads: new AbortController() };
  const candidates = Array.from({ length: total }, (_, n) => paper(n + 1));
  let time = Date.now(), inFlight = 0, peak = 0, requests = 0, fetches = 0;
  const events = [], outputs = [], handoffs = [];
  registerAcademicWorkflows(active, { call: async (name, args) => {
    events.push(name);
    if (stallResolution) return new Promise(() => {});
    return { version: 1, status: "completed", papers: name === "search_academic_papers" ? candidates.slice(0, 20) : [candidates.find(p => p.paper_ref === args.paper_ref)] };
  } }, () => true, { now: () => time, fetchSource: async url => {
    inFlight++; peak = Math.max(peak, inFlight); fetches++; const before = requests;
    try {
      await Promise.resolve(); assert.equal(requests, before, "Internal acquisition cannot call the model");
      if (fetches === 4 && interrupt === "cancel") active.sourceDownloads.abort();
      if (fetches === 4 && interrupt === "deadline") time += academic.DOWNLOAD_LIMITS.totalMs;
      if (fail.includes(Number(new URL(url).pathname.match(/\d+/)[0]))) throw Object.assign(new Error(), { code: "HTTP_ERROR" });
      return { bytes: pdf, contentType: "application/pdf", resolvedUrl: url };
    } finally { inFlight--; }
  } });
  const execute = async (args, deadlineAt) => active.execution.run("download_papers", { args, surface: "agent_command", permission: "workspace_write", ...(deadlineAt ? { deadlineAt } : {}) }, { filesystem });
  const drive = async (count, recovery = false) => {
    const query = `Download ${count || "relevant"} papers about enzyme design.`, desired = count || 10;
    let resume;
    t.mock.method(globalThis, "fetch", async (_url, options) => {
      requests++; events.push("model"); const body = JSON.parse(options.body);
      let tool_calls;
      if (requests === 1) tool_calls = [call("plan_literature_search", plan(count)), call("search_academic_papers", { query: "enzyme design", queries: ["enzyme validation"] })];
      if (requests === 2) tool_calls = [call("select_literature_papers", select(candidates.slice(0, desired).map(p => p.paper_ref))), call("download_papers", { paper_refs: candidates.slice(0, desired).map(p => p.paper_ref), destination: "literature/topic" })];
      if (requests === 4 && recovery) {
        const progress = body.messages.findLast(m => m.content?.startsWith("Literature workflow progress (host state):"));
        assert.match(progress.content, /"remaining":2/); assert.match(progress.content, /HTTP_ERROR|NO_ACCESSIBLE_PDF/);
        tool_calls = [call("select_literature_papers", select(candidates.slice(desired, desired + 2).map(p => p.paper_ref))), call("download_papers", { paper_refs: candidates.slice(desired, desired + 2).map(p => p.paper_ref) })];
      }
      return new Response(JSON.stringify({ choices: [{ finish_reason: "stop", message: tool_calls ? { tool_calls } : { content: JSON.stringify({ reply: "Actual saved results reported." }) } }] }));
    });
    for (let turn = 0; turn < 5; turn++) {
      const output = await runSideChatAgent({ originalRequest: query, conversationMessages: [{ role: "user", content: query }], systemPrompt: "Fulfill request", surface: "agent_command",
        desktopAcademic: true, desktopDownloads: true, downloadPermission: "workspace_write", workspaceContext: {}, resume, parseFinalAnswer: JSON.parse,
        requestTurn: request => requestRequestyMessage({ model: "fixture", ...request }, "fixture-key") });
      if (!output.data.desktopToolCalls) return output;
      const results = [];
      for (const tool of output.data.desktopToolCalls) {
        handoffs.push(tool);
        const result = tool.name === "download_papers" ? await execute(tool.args, tool.deadlineAt) : { version: 1, status: "completed", papers: candidates.slice(0, 20), next_cursor: "pool:20" };
        outputs.push(result); results.push({ id: tool.id, result });
      }
      resume = continuation.withResults(continuation.open(continuation.seal(output.continuationState, { query }, "secret"), { query }, "secret"), results);
    }
    assert.fail("Exhausted handoff bound");
  };
  return { filesystem, execute, drive, outputs, handoffs, events, stats: () => ({ requests, peak, fetches }) };
}

for (const count of [undefined, 3, 12]) test(`production agent and Electron save ${count || 10} papers with one download call`, async t => {
  const f = await fixture(t), result = await f.drive(count);
  const downloads = f.handoffs.filter(call => call.name === "download_papers");
  assert.equal(downloads.length, 1); assert.equal(downloads[0].args.paper_refs.length, count || 10);
  assert.equal(f.stats().requests, 3); assert.equal(f.stats().peak, 1);
  assert.equal(result.data.taskOutcome.downloadSuccessCount, count || 10); assert.equal(result.data.taskOutcome.status, "completed");
  for (const saved of f.outputs.at(-1).results) {
    assert.deepEqual(Buffer.from(await f.filesystem.readBinary(saved.path)), pdf);
    assert.ok(JSON.parse(await f.filesystem.readText(saved.metadataPath)).content_sha256);
  }
});

test("aggregate partial failures recover with relevant replacements once", async t => {
  const f = await fixture(t, { fail: [2, 4] }), result = await f.drive(undefined, true);
  const outputs = f.outputs.filter(x => x.results);
  assert.deepEqual(outputs[0].summary, { requested: 10, attempted: 10, saved: 8, failed: 2, not_attempted: 0 });
  assert.equal(outputs[1].summary.saved, 2); assert.equal(f.handoffs.filter(x => x.name === "download_papers").length, 2);
  assert.equal(result.data.taskOutcome.downloadSuccessCount, 10); assert.equal(result.data.taskOutcome.downloadAttemptCount, 12);
  assert.equal(result.data.taskOutcome.downloadRecovery, true);
});

for (const interrupt of ["cancel", "deadline"]) test(`${interrupt} retains committed files and aggregate unstarted outcomes`, async t => {
  const f = await fixture(t, { interrupt });
  const result = await f.execute({ paper_refs: Array.from({ length: 10 }, (_, n) => ref(n + 1)) });
  assert.deepEqual(result.summary, { requested: 10, attempted: 4, saved: 3, failed: 1, not_attempted: 6 });
  assert.equal(f.stats().fetches, 4);
  for (const saved of result.results.slice(0, 3)) assert.deepEqual(Buffer.from(await f.filesystem.readBinary(saved.path)), pdf);
  assert.equal(result.results[4].error.code, interrupt === "cancel" ? "OPERATION_ABORTED" : "DOWNLOAD_TIME_BUDGET_EXHAUSTED");
  assert.equal(JSON.parse(await f.filesystem.readText(result.receipt_path)).summary.saved, 3);
});

test("100-reference upper bound, compact receipts and old five-reference continuations", () => {
  const ids = Array.from({ length: 100 }, (_, n) => ref(n + 1));
  assert.equal(academic.validateInput("download_papers", { paper_refs: ids }).paper_refs.length, 100);
  for (const paper_refs of [[...ids, ref(101)], [ref(1), ref(1)], ["fabricated"]]) assert.throws(() => academic.validateInput("download_papers", { paper_refs }));
  const state = stateApi.initial(); planning.execute(state, "plan_literature_search", plan(100), 100);
  state.papers = ids.map((_, n) => paper(n + 1)); state.searchedQueries = state.plan.queries;
  assert.throws(() => planning.beforeTool(state, "download_papers", { paper_refs: ids }, "d", 100), { code: "SHORTLIST_REQUIRED_BEFORE_DOWNLOAD" });
  const selected = planning.execute(state, "select_literature_papers", select(ids), 100);
  assert.equal(selected.next_paper_refs.length, 100);
  assert.throws(() => planning.beforeTool(state, "download_papers", { paper_refs: ids.slice(0, 4) }, "d", 3), { code: "REQUESTED_DOWNLOAD_COUNT_EXCEEDED" });
  const raw = { version: 1, status: "completed", results: ids.map(paper_ref => ({ paper_ref, status: "downloaded", path: "literature/" + "x".repeat(900) + paper_ref + ".pdf", contentType: "application/pdf", attempts: Array(16).fill({ url: "https://example.org/" + "x".repeat(700), code: "HTML_REDIRECT" }) })) };
  const result = academic.validateResult("download_papers", compact.compactResult("download_papers", raw, state, "d", true));
  assert.equal(result.results.length, 100); assert.ok(JSON.stringify(result).length < academic.DOWNLOAD_LIMITS.resultCharacters);
  for (const size of [5, 100]) {
    const selectedIds = ids.slice(0, size), receipt = { ...result, results: result.results.slice(0, size) };
    const pendingState = { academicState: { ...state, attemptedRefs: selectedIds }, pending: [{ id: "d", name: "download_papers", args: { paper_refs: selectedIds } }], agentMessages: [{ role: "tool", tool_call_id: "d", content: "pending" }] };
    const resumed = continuation.withResults(continuation.open(continuation.seal(pendingState, {}, "secret"), {}, "secret"), [{ id: "d", result: receipt }]);
    assert.equal(resumed.academicState.downloads.length, size);
  }
  assert.throws(() => academic.validateResult("download_papers", { ...result, results: [result.results[0], result.results[0]] }));
});

test("deadline aggregate resumes to a truthful final report without another download or recovery loop", async t => {
  const f = await fixture(t, { interrupt: "deadline" });
  const result = await f.drive();
  assert.equal(f.stats().requests, 3);
  assert.equal(result.data.taskOutcome.status, "incomplete");
  assert.equal(result.data.taskOutcome.downloadSuccessCount, 3);
  assert.equal(result.data.taskOutcome.downloadAttemptCount, 4);
  assert.equal(result.data.taskOutcome.downloadNotAttemptedCount, 6);
  assert.equal(result.data.taskOutcome.remainingPaperCount, 7);
  assert.equal(result.data.taskOutcome.blocker.code, "DOWNLOAD_TIME_BUDGET_EXHAUSTED");
  assert.equal(f.handoffs.filter(c => c.name === "download_papers").length, 1);
});

test("an already-expired handoff returns every reference unstarted without fetching", async t => {
  const f = await fixture(t);
  const result = await f.execute({ paper_refs: [ref(1), ref(2)] }, Date.now() - 1);
  assert.deepEqual(result.summary, { requested: 2, attempted: 0, saved: 0, failed: 0, not_attempted: 2 });
  assert.equal(f.stats().fetches, 0);
});

test("deadline stops a stalled metadata transport without allowing late writes", async t => {
  const f = await fixture(t, { stallResolution: true });
  // Keep the test process alive while the production deadline's unref timer runs.
  const alive = setInterval(() => {}, 1000); t.after(() => clearInterval(alive));
  const result = await f.execute({ paper_refs: [ref(1), ref(2)] }, Date.now() + 30);
  assert.deepEqual(result.summary, { requested: 2, attempted: 1, saved: 0, failed: 1, not_attempted: 1 });
  assert.equal(result.results[0].error.code, "DOWNLOAD_TIME_BUDGET_EXHAUSTED");
  assert.equal(f.stats().fetches, 0);
});

test("cancellation after PDF/provenance commit keeps the completed file successful", async t => {
  const { ProjectFilesystem } = await import("../../desktop/services/project-filesystem.mjs");
  const { LocalExecutionService } = await import("../../desktop/services/local-execution-service.mjs");
  const { registerAcademicWorkflows } = await import("../../desktop/services/academic-workflows.mjs");
  const root = await mkdtemp(path.join(os.tmpdir(), "academic-committed-")); t.after(() => rm(root, { recursive: true, force: true }));
  const filesystem = await ProjectFilesystem.open(root), active = { execution: new LocalExecutionService(), sourceDownloads: new AbortController() };
  const write = filesystem.writeText.bind(filesystem);
  t.mock.method(filesystem, "writeText", async (name, value) => {
    await write(name, value);
    if (name.startsWith(".biodesign/sources/")) active.sourceDownloads.abort();
  });
  registerAcademicWorkflows(active, { call: async () => ({ version: 1, status: "completed", papers: [paper(1)] }) }, () => true,
    { fetchSource: async url => ({ bytes: pdf, contentType: "application/pdf", resolvedUrl: url }) });
  const result = await active.execution.run("download_papers", { args: { paper_refs: [ref(1), ref(2)] }, surface: "agent_command", permission: "workspace_write" }, { filesystem });
  assert.equal(result.results[0].status, "downloaded"); assert.equal(result.results[1].attempted, false);
  assert.deepEqual(Buffer.from(await filesystem.readBinary(result.results[0].path)), pdf);
  assert.equal(result.summary.saved, 1);
});
