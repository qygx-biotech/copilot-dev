"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const { runSideChatAgent } = require("../side-chat-agent.js");
const { requestRequestyMessage } = require("../index.js")._test;
const continuation = require("../agent-continuation.js");
const academic = require("../../shared/academic-tools.js");
const { ProjectContextService } = require("../../docs/project-context-service.js");
const { createFixture } = require("./helpers/preflight-fixture.js");
const refs = [1, 2, 3].map(n => "paper_" + String(n).padStart(24, "0"));
const papers = refs.map((paper_ref, n) => ({ paper_ref, title: `Synthetic biology AI design ${n}`, abstract: "Design and experimental validation.", authors: ["A"], doi: `10.1000/test${n}`, providers: [], locations: [] }));
const tool = (name, args) => ({ id: name, type: "function", function: { name, arguments: JSON.stringify(args) } });
const calls = (...tool_calls) => ({ tool_calls });
const answer = reply => ({ content: JSON.stringify({ reply }) });
const plan = (count = 1, kind = "topic") => ({ request_kind: kind, requested_count: count, subtopics: ["design"], synonyms: ["AI"], queries: kind === "topic" ? ["AI synthetic biology", "AI biological design"] : ["10.1000/test0"] });
const selection = ids => ({ shortlist: ids.map(paper_ref => ({ paper_ref, relevance: 5, reason: "Direct design evidence", evidence: "title_abstract", covers: ["subtopic_1"] })), remaining_gaps: [], stop_reason: "sufficient_candidates" });
const search = () => tool("search_academic_papers", { query: "AI synthetic biology", queries: ["AI biological design"] });
async function fixture(t, query, candidates = papers) {
  const f = await createFixture({ cardFailure: () => true });
  f.workspace.set("literature/existing.pdf", "Original AI design experimental evidence.");
  f.literature.api.interpretSemantics = async () => { assert.fail("Acquisition must not make a semantic LLM call"); };
  const service = new ProjectContextService({ workspace: f.workspace, literature: f.literature, sourceSystem: f.system, requestPipeline: f.pipeline });
  const local = await service.buildContext({ surface: "agent_command", turnId: "main-academic", question: query });
  assert.equal(local.agentLoop.academicAcquisition, true); assert.equal(local.semantic, undefined);
  assert.equal(f.calls.cards, 0); assert.equal(f.calls.parses, 0); assert.equal(f.workspace.rawReads, 0);
  const requests = [], executed = [];
  const drive = async (program, { permission = "workspace_write", downloaded = ids => ids.map(paper_ref => ({ paper_ref, status: "downloaded", path: `literature/${paper_ref}.pdf`, contentType: "application/pdf" })) } = {}) => {
    t.mock.method(globalThis, "fetch", async (_url, options) => {
      const body = JSON.parse(options.body); requests.push(body);
      assert.equal(body.response_format, undefined);
      const message = program(requests.length, body);
      return new Response(JSON.stringify({ choices: [{ message, finish_reason: "stop" }], usage: { prompt_tokens: 100, completion_tokens: 0 } }));
    });
    let resume;
    for (let handoff = 0; handoff < 8; handoff++) {
      const result = await runSideChatAgent({ surface: "agent_command", originalRequest: query, conversationMessages: [{ role: "user", content: query }], systemPrompt: "Fulfill the original request.",
        workspaceContext: { localWorkspaceContext: local }, desktopAcademic: true, desktopDownloads: true, projectToolsEnabled: true, downloadPermission: permission, resume,
        parseFinalAnswer: JSON.parse, requestTurn: request => requestRequestyMessage({ model: "fixture", ...request }, "test-key") });
      if (!result.data?.desktopToolCalls) return result;
      const results = [];
      for (const call of result.data.desktopToolCalls) {
        executed.push(call);
        if (call.name === "download_papers") results.push({ id: call.id, result: { version: 1, status: "partial", results: downloaded(call.args.paper_refs) } });
        else if (call.name === "search_academic_papers" || call.name === "get_academic_paper") results.push({ id: call.id, result: { version: 1, status: "completed", papers: candidates, next_cursor: "cached:20" } });
        else results.push(await service.executeAgentTool(call, { turnId: "main-academic" }));
      }
      const binding = { originalRequest: query, permission };
      resume = continuation.withResults(continuation.open(continuation.seal(result.continuationState, binding, "secret"), binding, "secret"), results);
    }
    assert.fail("Workflow did not finish within the existing handoff bound");
  };
  return { f, local, drive, requests, executed };
}

test("topic: main model plans/searches immediately; selection and download share a turn", async t => {
  const h = await fixture(t, "Find and download 1 paper about AI synthetic biology.");
  const result = await h.drive((step, body) => {
    if (step === 1) {
      assert.ok(body.messages.some(m => m.role === "user" && m.content.includes("Find and download")));
      for (const name of ["plan_literature_search", "search_academic_papers", "download_papers", "retrieve_project_evidence"]) assert.ok(body.tools.some(x => x.function.name === name), name);
      assert.ok(!body.messages.some(m => m.content?.startsWith("Literature workflow progress")), "No workflow is inferred before invocation");
      return calls(tool("plan_literature_search", plan()), search());
    }
    if (step === 2) return calls(tool("select_literature_papers", selection([refs[0]])), tool("download_papers", { paper_refs: [refs[0]], destination: "literature/AI" }));
    return answer("Saved the requested paper.");
  });
  assert.equal(h.requests.length, 3); assert.equal(result.data.taskOutcome.downloadSuccessCount, 1);
  assert.equal(result.data.academicSearchStatus.model.calls, 3);
  assert.equal(h.executed[1].args.destination, "literature/AI"); assert.equal(h.f.calls.cards, 0); assert.equal(h.f.calls.parses, 0);
});

test("explicitly named paper uses one lookup query without a semantic pre-call", async t => {
  const h = await fixture(t, "Download DOI 10.1000/test0.");
  const result = await h.drive(step => step === 1 ? calls(tool("plan_literature_search", plan(1, "named_papers")), tool("get_academic_paper", { query: "10.1000/test0" }))
    : step === 2 ? calls(tool("select_literature_papers", selection([refs[0]])), tool("download_papers", { paper_refs: [refs[0]] })) : answer("Saved the named paper."));
  assert.equal(result.data.taskOutcome.status, "completed"); assert.deepEqual(h.executed.map(x => x.name), ["get_academic_paper", "download_papers"]);
});

for (const [query, permission] of [["Search for 1 paper about AI synthetic biology.", "workspace_write"], ["Download 1 paper about AI synthetic biology.", "read_only"], ["Find 1 paper about AI; do not download any papers.", "workspace_write"]]) test(`saving stays host-authorized: ${query} / ${permission}`, async t => {
  const h = await fixture(t, query);
  const result = await h.drive((step, body) => {
    assert.ok(!body.tools.some(x => x.function.name === "download_papers"));
    if (step === 1) return calls(tool("plan_literature_search", plan()), search());
    if (step === 2) return calls(tool("select_literature_papers", selection([refs[0]])), tool("download_papers", { paper_refs: [refs[0]] }));
    assert.match(JSON.stringify(body.messages), /PERMISSION_DENIED/);
    return answer("Selected a relevant paper; no PDF was saved.");
  }, { permission });
  assert.equal(result.data.taskOutcome.downloadSuccessCount, 0);
  assert.ok(!h.executed.some(call => call.name === "download_papers"));
  assert.equal(h.f.calls.cards, 0);
});

test("original numeric count cannot be expanded by a plan", async t => {
  const h = await fixture(t, "Download 1 paper about AI biology.");
  const result = await h.drive((step, body) => {
    if (step === 1) return calls(tool("plan_literature_search", plan(2)));
    if (step === 2) {
      assert.match(JSON.stringify(body.messages), /REQUESTED_COUNT_MISMATCH/);
      return calls(tool("plan_literature_search", plan(1)), search());
    }
    if (step === 3) return calls(tool("select_literature_papers", selection([refs[0]])), tool("download_papers", { paper_refs: [refs[0]] }));
    return answer("Saved one paper.");
  });
  assert.equal(result.data.taskOutcome.requestedPaperCount, 1);
  assert.equal(result.data.taskOutcome.downloadSuccessCount, 1);
});

test("mixed request reads original local evidence only when selected by the main model", async t => {
  const h = await fixture(t, "Compare my existing paper with new online papers about AI and download 1 relevant paper.");
  const source = h.local.sourceMap.paperSources[0]; assert.ok(source);
  const result = await h.drive((step, body) => {
    if (step === 1) return calls(tool("retrieve_project_evidence", { query: "AI design experimental evidence", paper_ids: [source.sourceId] }));
    if (step === 2) {
      assert.ok(h.f.calls.parses > 0); assert.equal(h.f.calls.cards, 0);
      assert.match(JSON.stringify(body.messages), /Original AI design experimental evidence/);
      return calls(tool("plan_literature_search", plan()), search());
    }
    if (step === 3) return calls(tool("select_literature_papers", selection([refs[0]])), tool("download_papers", { paper_refs: [refs[0]] }));
    return answer("Compared original evidence and saved one new paper.");
  });
  assert.equal(result.data.taskOutcome.downloadSuccessCount, 1); assert.equal(h.f.calls.cards, 0);
});

test("failed downloads and an empty recovery response reuse collected candidates and signed state", async t => {
  const h = await fixture(t, "Download 2 relevant papers about AI synthetic biology.");
  const result = await h.drive(step => step === 1 ? calls(tool("plan_literature_search", plan(2)), search())
    : step === 2 ? calls(tool("select_literature_papers", selection(refs.slice(0, 2))), tool("download_papers", { paper_refs: refs.slice(0, 2) }))
    : step === 3 ? answer("Saved one of two requested PDFs; one failed.")
    : step === 4 ? { content: null }
    : step === 5 ? calls(tool("select_literature_papers", selection([refs[2]])), tool("download_papers", { paper_refs: [refs[2]] }))
    : answer("Saved two relevant papers."), { downloaded: ids => ids.map(paper_ref => paper_ref === refs[1]
      ? { paper_ref, status: "failed", error: { code: "NO_ACCESSIBLE_PDF" } }
      : { paper_ref, status: "downloaded", path: `literature/${paper_ref}.pdf`, contentType: "application/pdf" }) });
  assert.equal(result.data.taskOutcome.downloadSuccessCount, 2); assert.equal(result.data.taskOutcome.emptyResponseRecovery.retryUsed, true);
  assert.equal(h.executed.filter(x => x.name === "search_academic_papers").length, 1);
});

test("unrelated Agent Work keeps its existing preparation entry", async () => {
  const f = await createFixture();
  const service = new ProjectContextService({ workspace: f.workspace, literature: f.literature, sourceSystem: f.system, requestPipeline: f.pipeline });
  service.buildPlannedContextInternal = async options => ({ legacy: options.question });
  assert.deepEqual(await service.buildContext({ surface: "agent_command", question: "Analyze the experiment table." }), { legacy: "Analyze the experiment table." });
});

test("saving authorization excludes quoted instructions, informational and negated requests", () => {
  for (const query of ['Search papers. "download papers" is an example.', 'How can I download papers?', 'Can the tool download papers?', 'Explain what happens when we download papers.', 'Find papers without downloading them.', 'Do not download papers.', '搜索文献，不要下载论文。']) assert.equal(academic.savingRequested(query), false, query);
  for (const query of ['Find papers and save them.', 'Download 2 papers.', '检索AI文献并下载5篇。']) assert.equal(academic.savingRequested(query), true, query);
});

test("academic capabilities are available without semantic IR or an acquisition marker", async () => {
  const result = await runSideChatAgent({ surface: "agent_command", desktopAcademic: true, desktopDownloads: true, downloadPermission: "workspace_write",
    originalRequest: "Find papers about AI biology.", conversationMessages: [], workspaceContext: {}, systemPrompt: "Use available tools.", parseFinalAnswer: JSON.parse,
    requestTurn: async ({ tools }) => {
      assert.ok(tools.some(tool => tool.function.name === "plan_literature_search"));
      assert.ok(tools.some(tool => tool.function.name === "search_academic_papers"));
      assert.ok(!tools.some(tool => tool.function.name === "download_papers"));
      return { ok: true, message: calls(tool("plan_literature_search", plan()), search()) };
    } });
  assert.equal(result.data.desktopToolCalls[0].name, "search_academic_papers");
  assert.ok(result.continuationState.academicState.plan);
});

test("a final claim without tool execution does not attest saved papers", async t => {
  const h = await fixture(t, "Download 1 paper about AI biology.");
  const result = await h.drive(() => answer("Done."));
  assert.equal(result.data.reply, "Done.");
  assert.equal(result.data.taskOutcome.status, "incomplete");
  assert.equal(result.data.taskOutcome.downloadSuccessCount, 0);
  assert.equal(h.executed.length, 0);
});


test("a search-only answer without acquisition does not claim completed discovery", async t => {
  const h = await fixture(t, "Find 1 paper about AI biology.");
  const result = await h.drive(() => answer("No search performed."));
  assert.equal(result.data.taskOutcome.status, "incomplete");
  assert.equal(result.data.taskOutcome.candidateCount, 0);
  assert.equal(result.data.taskOutcome.downloadRequested, false);
});

test("legacy semantic routing cannot hide academic tools or veto explicit saving", async () => {
  const query = "Download 1 paper about AI biology.";
  const semantic = require("../../shared/semantic-intent.js");
  const ir = { ...semantic.interpretLocal({ query }), matchedPattern: null, retrievalScope: "workspace", objects: ["literature"], operations: ["read"], capabilityHints: ["search_papers"] };
  let resume;
  const run = requestTurn => runSideChatAgent({ surface: "agent_command", desktopAcademic: true, desktopDownloads: true, downloadPermission: "workspace_write",
    originalRequest: query, conversationMessages: [], workspaceContext: { localWorkspaceContext: { semantic: { ir } } }, systemPrompt: "Use the original request.", parseFinalAnswer: JSON.parse, resume, requestTurn });
  const found = await run(async ({ tools }) => {
    assert.ok(tools.some(x => x.function.name === "download_papers"));
    return { ok: true, message: calls(tool("plan_literature_search", plan()), search()) };
  });
  resume = continuation.withResults(found.continuationState, [{ id: found.data.desktopToolCalls[0].id, result: { version: 1, status: "completed", papers } }]);
  const pending = await run(async () => ({ ok: true, message: calls(tool("select_literature_papers", selection([refs[0]])), tool("download_papers", { paper_refs: [refs[0]] })) }));
  assert.equal(pending.data.desktopToolCalls[0].name, "download_papers");
});

for (const count of [10, 3, 12]) test(`topic target ${count}: default or explicit requested_count downloads in one invocation`, async t => {
  const candidates = Array.from({ length: 15 }, (_, n) => ({ ...papers[0], paper_ref: "paper_" + String(n + 1).padStart(24, "0"), title: `Distinct design study ${n}`, doi: `10.1000/batch${n}` }));
  const query = count === 10 ? "Find and download papers about AI biology." : `Find and download ${count} papers about AI biology.`;
  const h = await fixture(t, query, candidates);
  const ids = candidates.slice(0, count).map(p => p.paper_ref);
  const proposed = plan(count);
  if (count === 10) delete proposed.requested_count;
  const result = await h.drive((step, body) => {
    if (step === 1) {
      assert.match(body.tools.find(x => x.function.name === "plan_literature_search").function.parameters.properties.requested_count.description, /default of 10/);
      return calls(tool("plan_literature_search", proposed), search());
    }
    if (step === 2) return calls(tool("select_literature_papers", selection(ids)), tool("download_papers", { paper_refs: ids }));
    return answer(`Saved ${count} papers.`);
  });
  assert.equal(result.data.taskOutcome.requestedPaperCount, count);
  assert.equal(result.data.taskOutcome.downloadSuccessCount, count);
  assert.equal(result.data.taskOutcome.status, "completed");
  assert.deepEqual(h.executed.filter(c => c.name === "download_papers").map(c => c.args.paper_refs.length), [count]);
});
