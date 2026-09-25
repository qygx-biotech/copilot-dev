// Planned-context cases below exercise the retained optional helper, not the direct Side Chat entry point.
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const semantic = require("../../shared/semantic-intent.js");
const { ProjectContextService } = require("../../docs/project-context-service.js");
const { createFixture } = require("./helpers/preflight-fixture.js");

function interpreted(input, retrievalScope, download = false) {
  return {
    ...semantic.interpretLocal(input), matchedPattern: null, patternConfidence: 0.95,
    retrievalScope, objects: ["literature"],
    operations: retrievalScope === "none" ? ["store"] : ["search", ...(download ? ["store"] : [])],
    capabilityHints: [...(retrievalScope === "none" ? [] : ["search_papers"]), ...(download ? ["download_sources"] : [])],
    scope: { papers: input.activeScope?.paperIds?.length ? input.activeScope.paperIds : "current-project", experiments: null },
    unresolvedSlots: [],
  };
}
function serviceFor(f, options = {}) {
  return new ProjectContextService({ workspace: f.workspace, literature: f.literature, sourceSystem: f.system, requestPipeline: f.pipeline, ...options });
}

for (const surface of ["agent_command", "side_chat"]) for (const [question, scope, download] of [
  ["Search online for recent EctD papers.", "web", false],
  ["检索AI和合成生物学结合的文献并下载5篇。", "web", true],
  ["Download this paper: https://papers.example.org/ectd.pdf", "none", true],
]) test(`${surface} external acquisition respects its knowledge-maintenance policy: ${question}`, async () => {
  const f = await createFixture({ parseFailure: () => true, cardFailure: () => true });
  f.workspace.set("literature/existing.pdf", "An unprepared, possibly malformed PDF");
  const events = [];
  f.literature.api.interpretSemantics = async input => { events.push("semantic"); return interpreted(input, scope, download); };
  const context = await serviceFor(f).buildPlannedContext({ surface, turnId: "external", question, onProgress: event => events.push(event.stage) });
  const syncFirst = surface === "side_chat";
  assert.equal(events[0], syncFirst ? "preflight-checking" : "interpreting-request");
  assert.equal(events.filter(event => event === "semantic").length, 1);
  assert.equal(events.some(event => /^(preflight-|sync-)/.test(event)), syncFirst);
  assert.equal(context.semantic.ir.retrievalScope, scope);
  assert.equal(context.routing.downloadRequested, download);
  assert.equal(context.semantic.telemetry.semanticParserCalls, 1);
  if (syncFirst) {
    assert.equal(context.knowledgeSync.status, "partial", "A malformed paper is reported without blocking external questions");
    assert.equal(context.knowledgeSync.failures[0].stage, "L1");
    assert.ok(events.indexOf("sync-partial") < events.indexOf("semantic"));
  } else assert.equal(context.knowledgeSync, undefined, "Do not report deferred sources as synchronized");
  assert.deepEqual(context.files, []);
  assert.equal(f.workspace.scans, syncFirst ? 1 : 0);
  assert.equal(f.workspace.rawReads > 0, syncFirst);
  assert.equal(f.calls.parses, syncFirst ? 1 : 0);
  assert.equal(f.calls.cards, 0);
  assert.equal(f.calls.indexing, 0);
  assert.equal(f.pipeline.turns.has("external"), syncFirst);
});

test("failed cards and changed or added PDFs stay pending until a request needs local evidence", async () => {
  let fail = true;
  const f = await createFixture({ cardFailure: () => fail });
  f.workspace.set("literature/existing.pdf", "Original EctD evidence", 1000);
  const seed = await f.pipeline.preflight({ turnId: "seed" });
  assert.equal(seed.report.status, "partial");
  const source = f.system.registry.getByPath("literature/existing.pdf");
  const beforeSource = JSON.stringify(source), beforeCalls = { ...f.calls };
  const beforeScans = f.workspace.scans, beforeReads = f.workspace.rawReads;
  f.workspace.set(source.path, "Changed EctD evidence", 2000);
  f.workspace.set("literature/new.pdf", "New EctD evidence", 2000);
  let scope = "web", semanticCalls = 0;
  f.literature.api.interpretSemantics = async input => { semanticCalls++; return interpreted(input, scope, true); };
  const service = serviceFor(f);
  await service.buildPlannedContext({ surface: "agent_command", turnId: "external", question: "Search online for EctD papers and download them." });
  assert.deepEqual(f.calls, beforeCalls);
  assert.equal(f.workspace.scans, beforeScans);
  assert.equal(f.workspace.rawReads, beforeReads);
  assert.equal(JSON.stringify(source), beforeSource);
  assert.equal(f.pipeline.turns.has("external"), false);

  fail = false; scope = "workspace";
  const local = await service.buildPlannedContext({ surface: "agent_command", turnId: "local", question: "Find papers in my project about EctD." });
  assert.equal(semanticCalls, 2, "One interpretation per request, including local requests");
  assert.equal(local.knowledgeSync.status, "completed");
  assert.equal(local.knowledgeSync.updated.paperCards, 2);
  assert.equal(f.workspace.scans, beforeScans + 1);
  assert.ok(f.system.registry.list({ sourceKind: "paper" }).every(paper => paper.knowledgeSync.status === "SYNC_READY"));
});

for (const surface of ["agent_command", "side_chat"]) for (const scope of ["workspace", "both"]) test(`${surface} ${scope} retrieval still prepares newly selected local papers`, async () => {
  const f = await createFixture();
  f.workspace.set("literature/new.pdf", "EctD evidence");
  let semanticCalls = 0;
  f.literature.api.interpretSemantics = async input => { semanticCalls++; return interpreted(input, scope); };
  const context = await serviceFor(f).buildPlannedContext({ surface, turnId: scope,
    question: "Find EctD papers and compare with my selected local paper.", selectedPaths: ["literature/new.pdf"] });
  const paper = f.system.registry.getByPath("literature/new.pdf");
  assert.equal(semanticCalls, 1);
  assert.equal(f.calls.cards, 1);
  assert.equal(context.knowledgeSync.status, "completed");
  assert.equal(paper.knowledgeSync.status, "SYNC_READY");
  assert.deepEqual(context.literature.selectedPaperIds, [paper.sourceId]);
  assert.deepEqual(context.semantic.ir.scope.papers, [paper.sourceId], "Resolve selection against the refreshed catalog");
});

for (const surface of ["agent_command", "side_chat"]) for (const failure of ["unavailable", "malformed", "cooldown", "missing"]) test(`${surface} ${failure} semantic interpretation blocks the answer and respects maintenance ordering`, async () => {
  const f = await createFixture();
  f.workspace.set("literature/existing.pdf", "EctD evidence");
  f.literature.api.interpretSemantics = async () => {
    if (failure === "malformed") return { goal: "Unvalidated response" };
    throw Object.assign(new Error("Parser unavailable"), { semanticParserAttempted: failure !== "cooldown" });
  };
  if (failure === "missing") delete f.literature.api.interpretSemantics;
  await assert.rejects(serviceFor(f).buildPlannedContext({ surface, turnId: "fallback", question: "Search online for EctD papers." }), { code: "SEMANTIC_INTERPRETATION_FAILED" });
  const syncFirst = surface === "side_chat";
  assert.equal(f.workspace.scans, syncFirst ? 1 : 0);
  assert.equal(f.workspace.rawReads > 0, syncFirst);
  assert.equal(f.calls.cards, syncFirst ? 1 : 0);
  assert.equal(f.calls.parses, syncFirst ? 1 : 0);
  assert.equal(f.calls.indexing > 0, syncFirst);
  if (syncFirst) assert.equal(f.system.registry.getByPath("literature/existing.pdf").knowledgeSync.status, "SYNC_READY");
});

for (const surface of ["agent_command", "side_chat"]) test(`${surface} preserves maintenance ordering and one semantic call even for a locally recognized request`, async () => {
  const f = await createFixture();
  const question = "Summarize all papers.";
  const interpreter = new semantic.SemanticInterpreter();
  const initial = await interpreter.interpret({ query: question, profile: "medium", activeScope: { projectId: f.workspace.workspace.workspaceId } });
  assert.equal(initial.telemetry.semantic.route, "local", "Reproduce the shortcut that previously made Paper Cards the first LLM call");
  const events = [];
  f.literature.api.interpretSemantics = async input => {
    events.push("semantic");
    assert.equal(input.requireRemote, undefined, "Host policy must not be sent as model input");
    return interpreted(input, "workspace");
  };
  const generate = f.system.preparation.generatePaperCard;
  f.system.preparation.generatePaperCard = payload => { events.push("card"); return generate(payload); };
  const service = serviceFor(f, { semanticInterpreter: interpreter });
  // Prime the exact production input cache with the old local shortcut.
  await interpreter.interpret({ ...service.buildSemanticRequest({ question, retrievalProfile: "medium" }).semanticInput, requireRemote: false });
  for (let turn = 1; turn <= 2; turn++) {
    f.workspace.set(`literature/new-${turn}.pdf`, "EctD evidence");
    const context = await service.buildPlannedContext({ surface, turnId: `turn-${turn}`, question });
    assert.equal(context.semantic.telemetry.semantic.route, "remote");
    assert.equal(context.semantic.telemetry.semanticParserCalls, 1);
    assert.equal(context.knowledgeSync.updated.paperCards, 1);
  }
  assert.deepEqual(events, surface === "side_chat" ? ["card", "semantic", "card", "semantic"] : ["semantic", "card", "semantic", "card"]);
});

test("the context gate rejects an interpreter adapter that ignores the mandatory model policy", async () => {
  const f = await createFixture();
  f.workspace.set("literature/existing.pdf", "EctD evidence");
  const service = serviceFor(f, { semanticInterpreter: { async interpret(input) {
    return { ir: interpreted(input, "workspace"), telemetry: { semantic: { route: "cache" } } };
  } } });
  await assert.rejects(service.buildPlannedContext({ surface: "agent_command", turnId: "old-adapter", question: "Summarize all papers." }), { code: "SEMANTIC_INTERPRETATION_FAILED" });
  assert.equal(f.calls.cards, 0);
  assert.equal(f.workspace.scans, 0);
});

for (const scope of ["web", "none"]) test(`${scope} model decision skips preparation even when the local pattern asks for a corpus summary`, async () => {
  const f = await createFixture();
  f.workspace.set("literature/existing.pdf", "EctD evidence");
  let calls = 0;
  f.literature.api.interpretSemantics = async input => {
    calls++; return { ...interpreted(input, scope), operations: ["explain"], capabilityHints: [] };
  };
  const context = await serviceFor(f).buildPlannedContext({ surface: "agent_command", turnId: scope, question: "Summarize all papers." });
  assert.equal(calls, 1);
  assert.equal(context.semantic.ir.retrievalScope, scope);
  assert.equal(context.knowledgeSync, undefined);
  assert.equal(f.calls.cards, 0);
  assert.equal(f.workspace.scans, 0);
});

test("web acquisition does not wait for Side Chat's in-flight card generation", async () => {
  let release, started;
  const barrier = new Promise(resolve => { release = resolve; });
  const entered = new Promise(resolve => { started = resolve; });
  const f = await createFixture({ cardBarrier: () => { started(); return barrier; } });
  f.workspace.set("literature/existing.pdf", "EctD evidence");
  const interpretedSurfaces = [];
  f.literature.api.interpretSemantics = async input => {
    interpretedSurfaces.push(input.callContext.turnId);
    if (input.callContext.turnId === "side-chat") assert.equal(f.calls.activeCards, 0);
    return interpreted(input, input.callContext.turnId === "side-chat" ? "workspace" : "web", true);
  };
  const service = serviceFor(f);
  const chat = service.buildPlannedContext({ surface: "side_chat", turnId: "side-chat", question: "Find EctD papers in my project." });
  let timer;
  try {
    await entered;
    assert.deepEqual(interpretedSurfaces, [], "Side Chat waits for knowledge maintenance before interpretation");
    const context = await Promise.race([
      service.buildPlannedContext({ surface: "agent_command", turnId: "external", question: "Search online for EctD papers and download them." }),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("Web acquisition waited for unrelated cards")), 2000); }),
    ]);
    assert.equal(context.knowledgeSync, undefined);
    assert.equal(f.calls.activeCards, 1, "The unrelated card is still running");
    assert.deepEqual(interpretedSurfaces, ["external"]);
    assert.equal(f.pipeline.turns.has("external"), false);
  } finally {
    clearTimeout(timer); release();
    const context = await chat;
    assert.equal(context.knowledgeSync.status, "completed");
  }
  assert.deepEqual(interpretedSurfaces, ["external", "side-chat"]);
});

for (const interruption of ["cancel", "workspace-switch"]) test(`${interruption} during early interpretation prevents preparation`, async () => {
  const f = await createFixture();
  f.workspace.set("literature/existing.pdf", "EctD evidence");
  const controller = new AbortController();
  f.literature.api.interpretSemantics = async input => {
    if (interruption === "cancel") controller.abort();
    else f.workspace.workspace = { workspaceId: "another-project" };
    return interpreted(input, "workspace");
  };
  await assert.rejects(serviceFor(f).buildPlannedContext({ surface: "agent_command", turnId: interruption,
    question: "Find EctD papers in my project.", signal: controller.signal }), { code: "OPERATION_ABORTED" });
  assert.equal(f.workspace.scans, 0);
  assert.equal(f.calls.cards, 0);
});
