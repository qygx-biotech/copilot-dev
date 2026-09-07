"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const XLSX = require("xlsx");
const { createFixture } = require("./helpers/preflight-fixture.js");
const { ProjectContextService } = require("../../docs/project-context-service.js");
const { KnowledgeSyncAgent, SYNC_CAPABILITIES } = require("../../docs/request-pipeline.js");
const semantic = require("../../shared/semantic-intent.js");
const profiles = require("../../shared/retrieval-profiles.js");
const fc = require("../index.js")._test;
const addPapers = (workspace, from, to) => { for (let n = from; n <= to; n++) workspace.set(`literature/P${n}.pdf`, `EctD A163V evidence for paper ${n}; Km = 2 mM.`); };

test("A/B/C: 150 ready papers take metadata-only fast path; three additions and deletion touch only affected layers", async (t) => {
  const f = await createFixture(); addPapers(f.workspace, 1, 150);
  const seeded = await f.pipeline.preflight({ turnId: "seed" });
  assert.equal(seeded.report.status, "completed", JSON.stringify(seeded.report.failures));
  assert.equal(f.calls.cards, 150);
  const before = { ...f.calls }, reads = f.workspace.rawReads, scans = f.workspace.scans;
  const a = await f.pipeline.preflight({ turnId: "A", surface: "side_chat", message: "哪些论文研究 EctD？" });
  assert.equal(a.diff.unchanged, 150); assert.equal(a.telemetry.syncAgentSpawned, false);
  assert.equal(f.workspace.rawReads, reads); assert.equal(f.calls.cards, before.cards); assert.equal(f.calls.indexing, before.indexing);
  assert.equal(f.workspace.scans, scans + 1); assert.equal(a.telemetry.hashCalls, 0);
  assert.equal(await f.pipeline.preflight({ turnId: "A" }), a); assert.equal(f.workspace.scans, scans + 1);
  t.diagnostic(`150-source in-memory orchestration: reconcile ${a.telemetry.reconciliationMs.toFixed(3)} ms; main-agent gate ${a.telemetry.mainAgentStartMs.toFixed(3)} ms; 0 raw reads/hashes/cards/index updates`);
  addPapers(f.workspace, 151, 153);
  const b = await f.pipeline.preflight({ turnId: "B", surface: "agent_command" });
  assert.equal(b.diff.added.length, 3); assert.equal(b.report.updated.l1Evidence, 3); assert.equal(b.report.updated.paperCards, 3);
  assert.equal(f.calls.parses - before.parses, 3); assert.equal(f.calls.cards - before.cards, 3); assert.ok(f.calls.peakCards <= 2);
  for (const id of b.diff.added) {
    const source = f.system.registry.get(id); assert.equal(source.knowledgeSync.status, "SYNC_READY");
    assert.equal(source.artifacts.topicMembership.contentHash, source.contentHash);
    assert.ok(f.events.indexOf(`${id}:L1`) < f.events.indexOf(`${id}:L2`));
  }
  const afterAddition = await new ProjectContextService({ workspace: f.workspace, literature: f.literature, sourceSystem: f.system, requestPipeline: f.pipeline }).buildContext({
    turnId: "B", surface: "agent_command", question: "Hello", selectedPaths: [], selectedPaperIds: [],
  });
  assert.equal(afterAddition.knowledgeSync.updated.paperCards, 3);
  assert.equal(afterAddition.requestUnderstanding.originalQuery, "Hello");
  const answered = await require("../side-chat-agent.js").runSideChatAgent({
    surface: "agent_command", systemPrompt: "Answer the current request", conversationMessages: [{ role: "user", content: "Hello" }],
    workspaceContext: { localWorkspaceContext: fc.sanitizeLocalWorkspaceContext(afterAddition, "Hello") },
    parseFinalAnswer: (content) => ({ reply: content }),
    requestTurn: async ({ messages }) => {
      assert.equal(f.calls.cards, 153);
      assert.ok(b.diff.added.every((id) => f.system.registry.get(id).knowledgeSync.status === "SYNC_READY"));
      assert.match(messages.map((message) => message.content || "").join("\n"), /"paperCards":3/);
      return { ok: true, message: { content: "Hello! How can I help with this project?" } };
    },
  });
  assert.match(answered.data.reply, /^Hello!/);
  const paper = f.system.registry.getByPath("literature/P17.pdf");
  const paths = [paper.artifacts.paperText.path, paper.artifacts.paperCard.path, paper.artifacts.knowledgeMarkdown.path, paper.artifacts.paperCardMarkdown.path];
  await f.workspace.writeJson(".biodesign/workflows/corpus-index.json", { latestWorkflowId: "old", recentWorkflowIds: ["old"], byQuestion: {} });
  await f.workspace.writeJson(".biodesign/workflows/old.json", { workflowId: "old", status: "completed", snapshot: [{ sourceId: paper.sourceId }], maps: {}, coverage: {}, question: "review" });
  f.workspace.files.delete(paper.path);
  const c = await f.pipeline.preflight({ turnId: "C" });
  assert.deepEqual(c.diff.removed, [paper.sourceId]); assert.equal(c.telemetry.hashCalls, 0);
  assert.equal(f.system.registry.get(paper.sourceId), null);
  await assert.rejects(f.system.preparation.readPaperArtifact(paper.sourceId), { code: "PAPER_TEXT_NOT_READY" });
  for (const path of paths) assert.equal(await f.workspace.fileExists(path), false, path);
  assert.ok(f.system.topicService.topics.every((topic) => !topic.paperIds.includes(paper.sourceId)));
  assert.ok((f.indexed.get("literature-evidence") || []).every((path) => !path.includes(paper.sourceId)));
  assert.equal((await f.workspace.readJson(".biodesign/workflows/old.json")).status, "stale");
  assert.deepEqual(f.workspace.state.agent.currentRecommendation, { id: "R1" });
  assert.doesNotMatch(JSON.stringify(b.report), /paperArtifact|chunks|prompt|mainFindings|toolHistory/);
});

test("timestamp-only change hashes once with no derived updates; content modification updates one source", async () => {
  const f = await createFixture(); addPapers(f.workspace, 1, 2); await f.pipeline.preflight({ turnId: "seed" });
  const source = f.system.registry.getByPath("literature/P1.pdf"), oldHash = source.contentHash;
  const before = { ...f.calls }; const old = f.workspace.files.get(source.path);
  f.workspace.set(source.path, await old.text(), old.lastModified + 10);
  const touched = await f.pipeline.preflight({ turnId: "touch" });
  assert.deepEqual(touched.diff.possiblyModified, [source.sourceId]); assert.equal(touched.telemetry.hashCalls, 1);
  assert.equal(touched.telemetry.syncAgentSpawned, false); assert.equal(f.calls.cards, before.cards); assert.equal(f.calls.indexing, before.indexing);
  f.workspace.set(source.path, "EctD A163V new evidence and Km 3 mM", old.lastModified + 20);
  const modified = await f.pipeline.preflight({ turnId: "modify" });
  assert.equal(modified.report.updated.paperCards, 1); assert.equal(modified.report.updated.l1Evidence, 1); assert.notEqual(source.contentHash, oldHash);
  assert.equal(source.artifacts.paperCard.contentHash, source.contentHash); assert.equal(f.calls.cards - before.cards, 1);
});

test("D: Chinese XLSX columns normalize to exact structured records, descriptor, and deterministic ranking; deletion removes active records", async () => {
  const f = await createFixture(); const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([["蛋白", "突变", "温度（℃）", "羟基依克多因产量（g/L）"], ["EctD", "A163V", 30, 12], ["EctD", "WT", 37, 5]]), "实验一");
  const bytes = XLSX.write(wb, { type: "buffer", bookType: "xlsx" });
  f.workspace.set("experiments/实验.xlsx", bytes);
  const result = await f.pipeline.preflight({ turnId: "D" });
  assert.equal(result.report.status, "completed", JSON.stringify(result.report.failures)); assert.equal(result.report.updated.experimentSources, 1); assert.equal(f.calls.cards, 0);
  const source = f.system.registry.list({ sourceKind: "experiment" })[0];
  const artifact = await f.system.preparation.readExperimentArtifact(source.sourceId);
  assert.equal(artifact.records[0].canonical.temperature, 30); assert.equal(artifact.records[0].canonical.hydroxyectoine_titer, 12);
  assert.equal(artifact.sheets[0].rows[0][2], "温度（℃）");
  assert.deepEqual(Buffer.from(await (await f.workspace.readFile(source.path)).arrayBuffer()), bytes);
  const ir = semantic.interpretLocal({ query: "Which EctD mutant has the highest hydroxyectoine titer in our experiments?" });
  const ranked = await f.system.experimentTools.executeSemanticQuery(ir);
  assert.equal(ranked.records[0].values.hydroxyectoine_titer, 12);
  const mainContext = await new ProjectContextService({ workspace: f.workspace, literature: f.literature, sourceSystem: f.system, requestPipeline: f.pipeline }).buildContext({
    turnId: "D", surface: "side_chat", question: "Which EctD mutant has the highest hydroxyectoine titer in our experiments?", selectedPaths: [], selectedPaperIds: [],
  });
  assert.equal(mainContext.semanticExperimentResult.records[0].values.hydroxyectoine_titer, 12);
  assert.ok(mainContext.evidencePlan.evidenceNeeds.some((need) => need.type === "experiment_records"));
  const derived = [source.artifacts.experimentData.path, source.artifacts.experimentNote.path];
  f.workspace.files.delete(source.path);
  const deleted = await f.pipeline.preflight({ turnId: "D-delete" });
  assert.equal(deleted.report.removed.experiments, 1);
  for (const path of derived) assert.equal(await f.workspace.fileExists(path), false);
  assert.equal((await f.system.experimentTools.executeSemanticQuery(ir)).records.length, 0);
});

test("concurrent surfaces join one sync, cancellation cannot cancel the other consumer, partial work resumes without regenerating ready cards", async () => {
  let release; const barrier = new Promise((resolve) => { release = resolve; });
  let fail = true;
  const f = await createFixture({ cardBarrier: () => barrier, cardFailure: (source) => fail && source.displayName === "P2.pdf" });
  addPapers(f.workspace, 1, 3);
  const controller = new AbortController();
  const first = f.pipeline.preflight({ turnId: "one", surface: "side_chat", signal: controller.signal });
  const second = f.pipeline.preflight({ turnId: "two", surface: "agent_command" });
  controller.abort(); release();
  await assert.rejects(first, { code: "OPERATION_ABORTED" });
  const result = await second;
  assert.equal(f.workspace.scans, 1); assert.equal(f.calls.cards, 3); assert.equal(result.report.status, "partial");
  assert.equal(result.report.failures.length, 1); assert.equal(result.report.failures[0].stage, "L2");
  const failed = f.system.registry.get(result.report.failures[0].sourceId); assert.equal(failed.indexStatus, "ready"); assert.equal(failed.knowledgeSync.stages.l1, "ready");
  fail = false; const retry = await f.pipeline.preflight({ turnId: "retry" });
  assert.equal(retry.report.status, "completed"); assert.equal(f.calls.cards, 4); assert.equal(f.calls.parses, 3);
});

test("malformed paper is isolated; protocol/text handlers preserve language without Paper Cards", async () => {
  const f = await createFixture({ parseFailure: (source) => source.displayName === "P2.pdf" });
  addPapers(f.workspace, 1, 2); f.workspace.set("protocols/培养.md", "温度保持在30℃，不要改写原文件。");
  f.workspace.set("notes.txt", "Project document");
  const result = await f.pipeline.preflight({ turnId: "bad" });
  assert.equal(result.report.status, "partial"); assert.equal(result.report.failures[0].stage, "L1"); assert.equal(f.calls.cards, 1);
  const protocol = f.system.registry.getByPath("protocols/培养.md");
  assert.match(await (await f.workspace.readFile(protocol.artifacts.documentMarkdown.path)).text(), /温度保持在30℃/);
  assert.equal(protocol.paperCardStatus, "not_applicable"); assert.equal(result.report.updated.documents, 2);
});

test("shared context gate precedes semantic interpretation on both surfaces, default policy ignores stored profile, compact status survives FC", async () => {
  const f = await createFixture(); addPapers(f.workspace, 1, 1);
  const interpreter = new semantic.SemanticInterpreter(); let called = 0;
  const service = new ProjectContextService({ workspace: f.workspace, literature: f.literature, sourceSystem: f.system, requestPipeline: f.pipeline,
    semanticInterpreter: { async interpret(input) { called++; assert.equal(f.system.registry.list()[0].knowledgeSync.status, "SYNC_READY"); assert.equal(input.profile, "medium"); return interpreter.interpret(input); } } });
  for (const [surface, retrievalProfile] of [["side_chat", "light"], ["agent_command", "high"]]) {
    const context = await service.buildContext({ surface, retrievalProfile, turnId: surface, question: "你好", selectedPaths: [], selectedPaperIds: [] });
    assert.equal(context.requestUnderstanding.inputLanguage, "zh"); assert.equal(context.requestUnderstanding.answerLanguage, "zh");
    assert.equal(context.literature.retrievalProfile, "medium"); assert.ok(context.knowledgeSync);
    const sanitized = fc.sanitizeLocalWorkspaceContext(context, "你好");
    assert.equal(sanitized.requestUnderstanding.answerLanguage, "zh"); assert.ok(sanitized.knowledgeSync);
  }
  assert.equal(called, 2); assert.equal(f.workspace.scans, 2); assert.equal(f.calls.cards, 1);
  assert.deepEqual(f.workspace.state.agent.currentRecommendation, { id: "R1" });
});

test("language overrides, exact fact planning, broad and cross-source composition; sync tools cannot mutate recommendations", () => {
  const zh = semantic.interpretLocal({ query: "哪些论文研究EctD热稳定性？Please answer in English." });
  assert.equal(zh.inputLanguage, "zh"); assert.equal(zh.answerLanguage, "en");
  const fact = semantic.planEvidenceNeeds(semantic.interpretLocal({ query: "What was the Km in P17?" }));
  assert.deepEqual(fact.evidenceNeeds.map((need) => need.type), ["literature_evidence"]);
  const broad = semantic.planEvidenceNeeds(semantic.interpretLocal({ query: "What strategies appear across my literature?" }));
  assert.equal(broad.useTopics, true); assert.equal(broad.usePaperCards, true);
  const cross = semantic.planEvidenceNeeds(semantic.interpretLocal({ query: "Which mutations look strong in our experiments and are also supported by the literature?" }));
  assert.ok(cross.evidenceNeeds.some((need) => need.type === "experiment_records")); assert.ok(cross.evidenceNeeds.some((need) => need.type === "literature_evidence"));
  assert.equal(profiles.selectRetrievalProfile("light", { query: "中文 EctD" }).mode, "fast");
  assert.ok(!SYNC_CAPABILITIES.some((name) => /shell|recommendation/.test(name)));
  assert.throws(() => new KnowledgeSyncAgent({ update_recommendation() {} }), /Unknown sync capability/);
});

test("one FC semantic interpretation supplies English working query and the existing main loop answers in Chinese with only compact sync status", async () => {
  const f = await createFixture(); addPapers(f.workspace, 1, 150); await f.pipeline.preflight({ turnId: "seed" });
  const query = "哪些论文研究了提高EctD热稳定性的方法？";
  let semanticCalls = 0;
  f.literature.api.interpretSemantics = async (payload) => {
    semanticCalls++; assert.equal(f.system.registry.list()[0].knowledgeSync.status, "SYNC_READY");
    const ir = semantic.interpretLocal(payload);
    return { ...ir, goal: "Which papers study methods to improve EctD thermostability?", operations: ["search"], unresolvedSlots: [] };
  };
  const context = await new ProjectContextService({ workspace: f.workspace, literature: f.literature, sourceSystem: f.system, requestPipeline: f.pipeline }).buildContext({ turnId: "chinese", question: query, surface: "side_chat", retrievalProfile: "light" });
  assert.equal(semanticCalls, 1); assert.equal(context.requestUnderstanding.originalQuery, query);
  assert.equal(context.preflightTelemetry.syncAgentSpawned, false); assert.equal(context.preflightTelemetry.hashCalls, 0);
  assert.equal(context.requestUnderstanding.canonicalQueryEn, "Which papers study methods to improve EctD thermostability?");
  context.knowledgeSync.toolHistory = "PRIVATE_MAINTENANCE_TRANSCRIPT";
  const sanitized = fc.sanitizeLocalWorkspaceContext(context, query);
  const answer = await require("../side-chat-agent.js").runSideChatAgent({
    surface: "side_chat", systemPrompt: "Answer the current request", conversationMessages: [{ role: "user", content: query }],
    workspaceContext: { localWorkspaceContext: sanitized }, parseFinalAnswer: (content) => ({ reply: content }),
    requestTurn: async ({ messages }) => {
      const prompt = messages.map((message) => message.content || "").join("\n");
      assert.match(prompt, /<knowledge_sync>/); assert.match(prompt, /"answerLanguage":"zh"/); assert.match(prompt, /<evidence_plan>/);
      assert.doesNotMatch(prompt, /PRIVATE_MAINTENANCE_TRANSCRIPT/);
      return { ok: true, message: { content: "根据当前证据，A163V 与 EctD 稳定性有关。" } };
    },
  });
  assert.match(answer.data.reply, /根据当前证据/); assert.equal(f.calls.cards, 150);
});

test("a QMD deletion failure suppresses stale collection search until the update succeeds", async () => {
  const { LocalQmdKnowledgeService } = require("../../docs/knowledge-service.js");
  let failed = true, searches = 0;
  const service = new LocalQmdKnowledgeService({ fetch: async (url) => {
    if (String(url).includes("/update") && failed) return new Response(JSON.stringify({ error: "failure" }), { status: 500 });
    if (String(url).includes("/search")) searches++;
    return new Response(JSON.stringify({ ok: true, results: [{ sourceId: "deleted-paper" }] }), { status: 200 });
  } });
  service.available = true; service.workspaceId = "test";
  service.blockCollections(["literature-evidence"]);
  await assert.rejects(service.indexDocuments("literature-evidence"));
  assert.deepEqual((await service.searchLex("deleted paper", { collections: ["literature-evidence"] })).results, []); assert.equal(searches, 0);
  failed = false; await service.indexDocuments("literature-evidence");
  await service.searchLex("new paper", { collections: ["literature-evidence"] }); assert.equal(searches, 1);
});

test("L3 failure resumes with a persisted valid L2 card after coordinator restart", async () => {
  const f = await createFixture(); addPapers(f.workspace, 1, 1);
  const updateTopics = f.system.topicService.updatePaper.bind(f.system.topicService);
  f.system.topicService.updatePaper = async () => { throw Object.assign(new Error("topic failure"), { code: "TOPIC_TEST_FAILURE" }); };
  const first = await f.pipeline.preflight({ turnId: "partial-topics" });
  assert.equal(first.report.failures[0].stage, "L3"); assert.equal(f.calls.cards, 1);
  f.system.topicService.updatePaper = updateTopics;
  const { AgentRequestPipeline } = require("../../docs/request-pipeline.js");
  const resumed = await new AgentRequestPipeline({ workspace: f.workspace, literature: f.literature, sourceSystem: f.system }).preflight({ turnId: "resumed" });
  assert.equal(resumed.report.status, "completed"); assert.equal(f.calls.cards, 1); assert.equal(f.calls.parses, 1);
});

test("source removed during card generation is cleaned before this request reaches the main agent", async () => {
  let fixture;
  fixture = await createFixture({ cardBarrier: async (source) => { fixture.workspace.files.delete(source.path); } });
  addPapers(fixture.workspace, 1, 1);
  const result = await fixture.pipeline.preflight({ turnId: "vanished" });
  assert.equal(result.report.status, "partial"); assert.equal(result.report.removed.papers, 1);
  assert.equal(fixture.system.registry.list().length, 0);
  assert.equal(fixture.literature.documents.length, 0);
  assert.equal((fixture.indexed.get("literature-evidence") || []).length, 0);
  assert.equal((await fixture.pipeline.preflight({ turnId: "after-removal" })).telemetry.syncAgentSpawned, false);
});

test("timestamp-only verification reuses a fully prepared legacy project without a new sync marker", async () => {
  const f = await createFixture(); addPapers(f.workspace, 1, 1); await f.pipeline.preflight({ turnId: "seed" });
  const source = f.system.registry.list()[0]; delete source.knowledgeSync;
  const file = f.workspace.files.get(source.path), before = { ...f.calls };
  f.workspace.set(source.path, await file.text(), file.lastModified + 10);
  const touched = await f.pipeline.preflight({ turnId: "legacy-timestamp" });
  assert.equal(touched.telemetry.hashCalls, 1); assert.equal(touched.telemetry.syncAgentSpawned, false);
  assert.equal(f.calls.cards, before.cards); assert.equal(f.calls.indexing, before.indexing);
});
