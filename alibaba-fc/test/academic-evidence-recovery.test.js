"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const { mkdtemp, rm } = require("node:fs/promises"), path = require("node:path"), os = require("node:os");
const semantic = require("../../shared/semantic-intent.js");
const { runSideChatAgent, compactSideChatAgentMessages } = require("../side-chat-agent.js");
const continuation = require("../agent-continuation.js"), academic = require("../academic-agent.js");
const planning = require("../academic-planning.js"), recovery = require("../academic-recovery.js"), context = require("../academic-context.js");
const query = "Find AI and synthetic biology papers and download five suitable papers.";
const plan = { queries: ["artificial intelligence in synthetic biology", "AI-driven synthetic biology design", "machine learning for metabolic engineering"],
  request_kind: "topic", requested_count: 5, subtopics: ["AI in metabolic engineering", "AI-driven protein design for synthetic biology", "AI for synthetic biology automation"],
  synonyms: ["machine learning", "deep learning", "computational biology", "synthetic biology", "bioengineering"] };
// Stable handles from the reported trace; metadata below is a controlled fixture.
const refs = ["paper_7a224eb6b09237836dd34a5a", "paper_15c1180c932522c65a0ac682", "paper_2053062a5bc157ac31021065", "paper_ab87c0b982b7f9468e090bee", "paper_5b0a950744e1c49115725484"];
const paper = (index, abstract = index < 2 ? "Relevant design and validation evidence. ".repeat(80) : "") => ({ paper_ref: refs[index] || "paper_" + "6".repeat(24),
  title: ["Machine learning for metabolic engineering: A review.", "Algorithm-driven synthetic biology design", "AI-driven protein design", "Multiplexed metabolic pathway design", "AI laboratory automation", "Additional design study"][index],
  authors: [`Author ${index}`], doi: `10.1000/evidence-${index}`, abstract, published_date: "2024-01-01", providers: [], locations: [] });
const selection = (corrected = 0) => ({ remaining_gaps: [], shortlist: refs.map((paper_ref, index) => ({ paper_ref,
  covers: [`subtopic_${[1, 3, 2, 1, 3][index]}`], evidence: index >= 2 && index < 2 + corrected ? "title_only" : "title_abstract",
  reason: index >= 2 && index < 2 + corrected ? "Relevant title; abstract unavailable, so the assessment remains uncertain." : "Relevant design and validation evidence.", relevance: index < 2 ? 5 : 4 })), stop_reason: "sufficient_candidates" });
const ir = { ...semantic.interpretLocal({ query }), matchedPattern: null, retrievalScope: "web", objects: ["literature"], operations: ["search", "store"],
  capabilityHints: ["search_papers", "download_sources"], requestedOutput: { type: "papers", limit: 5 } };
const call = (name, args) => ({ id: name, type: "function", function: { name, arguments: JSON.stringify(args) } });
const actions = (...tool_calls) => ({ ok: true, message: { tool_calls } });
const answer = content => ({ ok: true, message: { content } });
const run = options => runSideChatAgent({ surface: "agent_command", desktopAcademic: true, desktopDownloads: true, downloadPermission: "workspace_write",
  systemPrompt: "Complete the authorized literature request.", originalRequest: query, conversationMessages: [{ role: "user", content: query }],
  workspaceContext: { localWorkspaceContext: { semantic: { ir } } }, parseFinalAnswer: reply => ({ reply }), ...options });
const lastError = request => request.messages.filter(message => message.role === "tool").map(message => JSON.parse(message.content)).findLast(value => value.error)?.error;
const progress = request => JSON.parse(request.messages.findLast(message => message.content?.startsWith("Literature workflow progress (host state): ")).content.split("\n")[0].slice("Literature workflow progress (host state): ".length));
function resumed(pending, results) {
  const binding = { project: "evidence-regression", account: "test" };
  return continuation.withResults(continuation.open(continuation.seal(pending.continuationState, binding, "secret"), binding, "secret"),
    pending.data.desktopToolCalls.map((call, index) => ({ id: call.id, result: results[index] })));
}
async function searched(cursor = "pool:5", papers = refs.map((_, index) => paper(index))) {
  const pending = await run({ requestTurn: async () => actions(call("plan_literature_search", plan), call("search_academic_papers", {
    query: plan.queries[0], queries: plan.queries.slice(1), limit: 20, prefer_open_access: false })) });
  return resumed(pending, [{ version: 1, status: "partial", papers, next_cursor: cursor, total_candidates: 6,
    provider_status: { pubmed: { status: "completed", returned: 5, errors: [] }, semantic: { status: "failed", returned: 0, errors: ["RATE_LIMITED"] } } }]);
}
async function inspected() {
  const resume = await searched(); let calls = 0;
  const page = await run({ resume, requestTurn: async request => {
    if (++calls === 1) return actions(call("search_academic_papers", resume.academicState.searches[0].args));
    const error = lastError(request); assert.equal(error.code, "PAGINATION_CURSOR_REQUIRED");
    return actions(call(error.required_tool_call.name, error.required_tool_call.arguments));
  } });
  const after = resumed(page, [{ version: 1, status: "completed", papers: [paper(5, "Additional evidence")], total_candidates: 6 }]);
  assert.equal(after.academicState.validationRecovery.failures, 1);
  assert.deepEqual(after.academicState.validationRecovery.episode, { model_turns: 0, failures: 0, duplicate_retries: 0 });
  return after;
}
async function finishWithLocalDownloads(t, pending) {
  const { ProjectFilesystem } = await import("../../desktop/services/project-filesystem.mjs");
  const { LocalExecutionService } = await import("../../desktop/services/local-execution-service.mjs");
  const { registerAcademicWorkflows } = await import("../../desktop/services/academic-workflows.mjs");
  const root = await mkdtemp(path.join(os.tmpdir(), "academic-evidence-")); t.after(() => rm(root, { recursive: true, force: true }));
  const filesystem = await ProjectFilesystem.open(root), bytes = Buffer.from("%PDF-1.7\ncontrolled evidence fixture");
  const active = { execution: new LocalExecutionService(), sourceDownloads: new AbortController() };
  registerAcademicWorkflows(active, { call: async (name, args) => {
    assert.equal(name, "resolve_paper_full_text"); const index = refs.indexOf(args.paper_ref); assert.ok(index >= 0);
    return { version: 1, status: "completed", papers: [{ ...paper(index), locations: [{ url: `https://papers.example.org/${index}.pdf`, kind: "pdf_candidate" }] }] };
  } }, () => true, { fetchSource: async url => ({ bytes, contentType: "application/pdf", resolvedUrl: url }) });
  const results = [];
  for (const call of pending.data.desktopToolCalls) {
    assert.equal(call.name, "download_papers");
    results.push(await active.execution.run(call.name, { args: call.args, surface: "agent_command", permission: "workspace_write" }, { filesystem }));
  }
  const final = await run({ resume: resumed(pending, results), requestTurn: async () => answer("Saved the selected papers.") });
  assert.equal(final.ok, true); assert.equal(final.data.taskOutcome.downloadSuccessCount, 5);
  assert.equal(final.data.taskOutcome.selectedPaperCount, 5);
  for (const item of final.data.downloadResults) assert.deepEqual(Buffer.from(await filesystem.readBinary(item.path)), bytes);
  return final;
}

for (const mode of ["batch_correction", "incremental_correction"]) test(`production optional cursor correction → multiple missing abstracts → five local saves: ${mode}`, async t => {
  const resume = await inspected();
  const oldSearch = resume.agentMessages.find(message => message.name === "search_academic_papers");
  oldSearch.content = oldSearch.content.slice(0, 700) + "\n[Earlier tool result compacted. Call the same bounded tool again to recover detail.]";
  let calls = 0;
  const pending = await run({ resume, requestTurn: async request => {
    calls++;
    const catalog = JSON.parse(request.messages.find(message => message.content?.startsWith(context.CATALOG_PREFIX)).content.slice(context.CATALOG_PREFIX.length));
    assert.equal(catalog.papers.length, 6);
    assert.deepEqual(catalog.papers.filter(item => !item.abstract_available).map(item => item.paper_ref), refs.slice(2));
    for (const item of catalog.papers.slice(2, 5)) assert.deepEqual(item.available_evidence, ["title_only"]);
    const search = JSON.parse(request.messages.find(message => message.tool_call_id === oldSearch.tool_call_id).content);
    assert.equal(search.status, "partial"); assert.equal(search.next_cursor, "pool:5");
    assert.deepEqual(search.papers.map(paper => paper.paper_ref), refs);
    assert.deepEqual(search.provider_status.semantic.errors, ["RATE_LIMITED"]);
    const receipt = JSON.parse(request.messages.find(message => message.name === "plan_literature_search").content);
    assert.equal(receipt.record_type, "accepted_plan"); assert.doesNotMatch(JSON.stringify(receipt), /ABSTRACT_NOT_AVAILABLE/);
    if (calls === 1) return actions(call("select_literature_papers", selection()));
    const error = lastError(request);
    assert.equal(error.code, "ABSTRACT_NOT_AVAILABLE");
    const previouslyCorrected = mode === "batch_correction" ? 0 : calls - 2;
    assert.deepEqual(error.violations.map(item => item.paper_ref), refs.slice(2 + previouslyCorrected));
    assert.match(error.required_correction, /every listed violation/);
    assert.equal(progress(request).shortlist.length, 0, "An invalid batch never mutates the accepted selection");
    const corrected = mode === "batch_correction" ? 3 : calls - 1;
    if (corrected === 3) return actions(call("select_literature_papers", selection(3)), call("download_papers", { paper_refs: refs, destination: "literature/AI" }));
    return actions(call("select_literature_papers", selection(corrected)));
  } });
  assert.equal(calls, mode === "batch_correction" ? 2 : 4);
  assert.equal(pending.data.desktopToolCalls[0].name, "download_papers");
  const final = await finishWithLocalDownloads(t, pending);
  assert.equal(final.data.taskOutcome.candidateCount, 6);
  assert.equal(final.data.academicSelection.validation.failures, mode === "batch_correction" ? 2 : 4);
  assert.equal(final.data.academicSelection.validation.pending, false);
  assert.ok(final.data.academicSearchStatus.model.calls <= 8, "The global agent-step budget was not increased");
});

test("fresh metadata permits the same previously rejected shortlist, without pretending a missing abstract exists", async t => {
  const resume = await searched(null, refs.map((_, index) => paper(index, index === 2 ? "" : "Observed abstract")));
  let calls = 0;
  const metadata = await run({ resume, requestTurn: async request => {
    if (++calls === 1) return actions(call("select_literature_papers", selection()));
    assert.deepEqual(lastError(request).violations.map(item => item.paper_ref), [refs[2]]);
    return actions(call("get_academic_paper", { paper_ref: refs[2] }));
  } });
  const refreshed = resumed(metadata, [{ version: 1, status: "completed", papers: [paper(2, "Newly retrieved abstract about AI protein design.")] }]);
  assert.equal(refreshed.academicState.validationRecovery.evidence_updated, true);
  const pending = await run({ resume: refreshed, requestTurn: async request => {
    assert.match(request.messages.find(message => message.content?.startsWith("Literature validation correction")).content, /New metadata repaired/);
    return actions(call("select_literature_papers", selection()), call("download_papers", { paper_refs: refs }));
  } });
  assert.equal(pending.continuationState.academicState.validationRecovery.duplicate_retries, 0);
  await finishWithLocalDownloads(t, pending);
});

test("sparse metadata refresh does not erase known evidence or make an unchanged invalid retry eligible", () => {
  const state = academic.initial(); planning.execute(state, "plan_literature_search", plan, 5);
  academic.recordResult(state, { id: "first", name: "search_academic_papers", args: { query: plan.queries[0] } }, { version: 1, status: "completed", papers: [paper(0), paper(2)] });
  const abstract = state.papers[0].abstract, revision = state.evidenceRevision;
  const error = { code: "ABSTRACT_NOT_AVAILABLE", details: { paper_ref: refs[2], field: "evidence", required_tool: "select_literature_papers" } };
  recovery.failure(state, "select_literature_papers", selection(), error);
  academic.recordResult(state, { id: "refresh", name: "get_academic_paper", args: { paper_ref: refs[0] } }, { version: 1, status: "completed", papers: [{ ...paper(0, ""), authors: [], published_date: null, doi: "" }] });
  assert.equal(state.papers[0].abstract, abstract); assert.equal(state.evidenceRevision, revision);
  assert.equal(recovery.duplicate(state, "select_literature_papers", selection()).error.identical_failed_retry, true);
});

test("unchanged invalid selections stop with all missing papers and the exact stopping limit", async () => {
  const resume = await inspected(); let calls = 0;
  const final = await run({ resume, requestTurn: async () => { assert.ok(++calls <= 3); return actions(call("select_literature_papers", selection())); } });
  assert.equal(final.ok, false); assert.equal(final.reason, "ABSTRACT_NOT_AVAILABLE");
  assert.equal(final.data.taskOutcome.validationStoppingLimit, "identical_failed_arguments");
  assert.equal(final.data.taskOutcome.downloadAttemptCount, 0);
  for (const ref of refs.slice(2)) assert.ok(final.data.reply.includes(ref));
  assert.match(final.data.reply, /Stopping limit: identical_failed_arguments/);
  assert.match(final.data.reply, /Search candidates: 6; accepted selected papers: 0; successfully saved PDF files: 0/);
});

test("aggressive compaction keeps every paper handle and explicit abstract availability in valid JSON", async () => {
  const resume = await searched();
  const messages = compactSideChatAgentMessages(resume.agentMessages, query, 500, resume.academicState);
  const search = JSON.parse(messages.find(message => message.name === "search_academic_papers").content);
  assert.deepEqual(search.papers.map(paper => paper.paper_ref), refs);
  assert.equal(search.papers[0].abstract_truncated, true); assert.equal(search.papers[2].abstract_available, false);
  assert.equal(search.next_cursor, "pool:5");
  const state = { ...resume.academicState, papers: Array.from({ length: 120 }, (_, index) => ({ ...paper(index % 5, "x".repeat(1000)), paper_ref: "paper_" + String(index).padStart(24, "0"), title: "t".repeat(500), doi: "d".repeat(300) })) };
  const catalog = context.catalogMessage(state);
  assert.ok(catalog.content.length < 82000);
  assert.equal(JSON.parse(catalog.content.slice(context.CATALOG_PREFIX.length)).papers.length, 120);
  delete resume.academicState.academicResultIndex;
  const old = resume.agentMessages.find(message => message.name === "search_academic_papers"); old.content = old.content.slice(0, 500);
  const recovered = compactSideChatAgentMessages(resume.agentMessages, query, 500, resume.academicState);
  assert.equal(JSON.parse(recovered.find(message => message.tool_call_id === old.tool_call_id).content).historical_membership_unknown, true);
});
