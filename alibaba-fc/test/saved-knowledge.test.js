"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { createFixture } = require("./helpers/preflight-fixture.js");
const { ProjectContextService } = require("../../docs/project-context-service.js");
const { renderSynthesisMarkdown, renderTopicMarkdown } = require("../../docs/source-system.js");
const { sanitizeLocalWorkspaceContext } = require("../index.js")._test;
const agent = require("../side-chat-agent.js");
const { SAVED_ARTIFACT_LIMITS, sanitizeSavedArtifact } = require("../../shared/retrieval-contract.js");
const toolCall = (name, args, id = "fixture-call") => ({ id, type: "function", function: { name, arguments: JSON.stringify(args) } });
const layeredOptions = { evidencePlan: { usePreviousSynthesis: true, useTopics: true, evidenceNeeds: [] } };
const prepareKnowledge = f => f.service.retrieveLayeredKnowledge(f.options.question, layeredOptions);
const knowledgeBase = (f, knowledge, extra = {}) => agent.createSideChatKnowledgeBase({ localWorkspaceContext: sanitizeLocalWorkspaceContext({
  knowledge, sourceMap: { paperSources: [f.source] }, ...extra,
}) });

async function fixture() {
  const f = await createFixture();
  f.workspace.set("literature/a.pdf", "Synthetic original paper evidence.");
  await f.pipeline.preflight({ turnId: "setup" });
  const source = f.system.registry.list({ sourceKind: "paper" })[0];
  const parsed = await f.system.preparation.readPaperArtifact(source.sourceId);
  const ref = `${source.sourceId}:p1:${parsed.chunks[0].chunkId}`;
  const journal = {
    workflowId: "review-fixture", question: "Review enzyme engineering", status: "completed",
    createdAt: "2026-09-01T00:00:00Z", updatedAt: "2026-09-01T00:00:00Z", corpusVersion: "corpus-v1",
    snapshot: [{ sourceId: source.sourceId, path: source.path,
      observedContentHash: source.contentHash, observedStatSignature: source.statSignature,
      preparedContentHash: source.contentHash, preparedStatSignature: source.statSignature, changedDuringPreparation: false }],
    maps: { [source.sourceId]: { paperId: source.sourceId, contentHash: source.contentHash } },
    coverage: { papersDiscovered: 1, papersIncludedInSnapshot: 1, papersSuccessfullyPrepared: 1, papersPreparationCacheHits: 1, papersSuccessfullyAnalyzed: 1, papersFailed: 0, papersMissing: 0, analyzedPaperIds: [source.sourceId], includedPaperIds: [source.sourceId], preparedPaperIds: [source.sourceId], failedPaperIds: [], missingPaperIds: [], changedPaperIds: [] },
    reduction: { themes: [], findings: [{ claim: "Saved review concluded that the stability tradeoff remains unresolved.", supportingPaperIds: [source.sourceId], evidenceRefs: [ref] }] },
    verification: [{ status: "original-evidence-located" }],
  };
  const topic = { topicId: "fixture-topic", label: "Enzyme engineering", paperIds: [source.sourceId], sourceVersions: { [source.sourceId]: source.contentHash }, summaryStatus: "ready", summaryVersion: "topic-v1", summary: `Saved topic describes the stability tradeoff. ${ref}` };
  const save = () => {
    f.workspace.set(".biodesign/workflows/review-fixture.json", JSON.stringify(journal));
    f.workspace.set(".biodesign/knowledge/syntheses/review-fixture.md", renderSynthesisMarkdown(journal));
    f.workspace.set(".biodesign/knowledge/topics/fixture-topic.md", renderTopicMarkdown(topic));
    f.system.topicService.topics = [topic]; f.system.topicService.loaded = true;
  };
  save();
  const counts = { synthesisSearches: 0, topicSearches: 0, generations: 0, updates: 0 };
  f.system.knowledgeService.workspaceId = f.workspace.workspace.workspaceId;
  f.system.knowledgeService.searchPreviousSyntheses = async () => {
    counts.synthesisSearches++; return { results: [{ sourceId: journal.workflowId, title: "Saved review", snippet: "Scope only", file: "qmd://syntheses/review-fixture.md" }] };
  };
  f.system.knowledgeService.searchTopics = async () => {
    counts.topicSearches++; return { results: [{ sourceId: topic.topicId, title: topic.label, snippet: "Topic header only", file: "qmd://topics/fixture-topic.md" }] };
  };
  f.system.corpusWorkflows.getWorkflowStatus = async () => ({ workflowId: journal.workflowId, coverage: journal.coverage, failures: [], retryablePaperIds: [] });
  f.system.corpusWorkflows.run = async () => { counts.generations++; return { preview: { marker: "Existing corpus result delivery" } }; };
  const service = new ProjectContextService({ workspace: f.workspace, literature: f.literature, sourceSystem: f.system, requestPipeline: f.pipeline });
  const options = { question: "What did the previous review conclude?", turnId: "read-saved", surface: "side_chat", callContext: { model: "nvidia/nemotron-3-nano-omni-30b-a3b-reasoning" } };
  return { ...f, source, ref, journal, topic, save, counts, service, options };
}

test("retrieved L3/L4 hits become readable active-agent items with useful saved content", async () => {
  const f = await fixture();
  const knowledge = await f.service.retrieveLayeredKnowledge(f.options.question, { evidencePlan: { usePreviousSynthesis: true, useTopics: true, evidenceNeeds: [] } });
  assert.equal(knowledge.hits.length, 2);
  const local = sanitizeLocalWorkspaceContext({ knowledge, sourceMap: { paperSources: [f.source] } });
  assert.equal(local.knowledge.hits.length, 2);
  const kb = agent.createSideChatKnowledgeBase({ localWorkspaceContext: local });
  const derived = kb.items.filter(item => item.evidenceType.startsWith("saved-"));
  assert.equal(derived.length, 2, "Two retrieved artifacts must reach the active catalog");
  assert.match(derived[0].content, /Saved review concluded/);
  assert.match(derived[1].content, /Saved topic describes/);
});

test("a previous-review question retrieves saved artifacts without invoking corpus generation", async () => {
  const f = await fixture();
  const cardsBefore = f.calls.cards;
  const context = await f.service.buildContext(f.options);
  assert.equal(f.counts.generations, 0, "Historical read must not start a corpus workflow");
  assert.equal(f.counts.synthesisSearches, 1);
  assert.ok(context.knowledge.hits.some(hit => hit.kind === "synthesis"));
  assert.equal(f.calls.cards - cardsBefore, 0, "Warm source preparation does not regenerate cards");
});

test("saved/prior review wording reads history, while explicit new writing still creates a synthesis", async () => {
  for (const question of ["What did the saved review conclude?", "What did the prior literature review conclude?", "Write a new review based on the previous review."]) {
    const f = await fixture();
    const createNew = question.startsWith("Write");
    const context = await f.service.buildContext({ ...f.options, question });
    assert.equal(f.counts.generations, createNew ? 1 : 0, question);
    assert.equal(f.counts.synthesisSearches, createNew ? 0 : 1, question);
    assert.equal(context.knowledge.hits.some(hit => hit.kind === "synthesis"), !createNew);
  }
});

test("active loop reads both layers and resolves only original-paper citations", async () => {
  const f = await fixture();
  const context = sanitizeLocalWorkspaceContext(await f.service.buildContext(f.options), f.options.question);
  const kb = agent.createSideChatKnowledgeBase({ localWorkspaceContext: context });
  const items = kb.items.filter(item => item.evidenceType.startsWith("saved-"));
  let calls = 0;
  const result = await agent.runSideChatAgent({
    workspaceContext: { localWorkspaceContext: context },
    conversationMessages: [{ role: "user", content: f.options.question }], systemPrompt: "Use saved evidence.",
    parseFinalAnswer: reply => ({ reply }),
    requestTurn: async ({ messages, tools }) => {
      calls++;
      if (calls === 1) {
        assert.match(messages.map(message => message.content).join("\n"), /saved-synthesis.*content=available/);
        assert.ok(tools.some(tool => tool.function.name === "read_workspace_item"));
        return { ok: true, message: { tool_calls: items.map((item, i) => toolCall("read_workspace_item", { item_id: item.id }, `read-${i}`)) } };
      }
      const outputs = messages.filter(message => message.role === "tool").map(message => JSON.parse(message.content));
      assert.equal(outputs.length, 2);
      assert.match(outputs[0].content, /Saved review concluded/);
      assert.match(outputs[1].content, /Saved topic describes/);
      for (const output of outputs) { assert.equal(output.citation, undefined); assert.match(output.citation_guidance, /never the saved artifact/); }
      return { ok: true, message: { content: `The saved review identified an unresolved tradeoff. [[cite:${f.ref}]]` } };
    },
  });
  assert.equal(result.ok, true);
  assert.equal(calls, 2);
  assert.equal(f.counts.generations, 0);
  assert.equal(result.data.citations[0].sourceId, f.source.sourceId);
  assert.equal(result.data.citations[0].page, 1);
  assert.equal(result.data.citations[0].status, "resolved");
  const registry = agent.buildSourceCitationRegistry(kb);
  for (const item of items) assert.equal(registry.has(item.id), false);
  assert.equal(registry.has(f.journal.workflowId), false);
});

test("historical artifacts preserve coverage, snapshot, versions and verification without becoming current evidence", async () => {
  const f = await fixture();
  f.journal.status = "stale"; f.journal.staleReason = "source_version_changed_or_removed";
  f.journal.staleSourceIds = [f.source.sourceId]; f.save();
  const context = sanitizeLocalWorkspaceContext(await f.service.buildContext(f.options), f.options.question);
  const artifact = context.knowledge.hits.find(hit => hit.kind === "synthesis").artifact;
  assert.equal(artifact.status, "stale"); assert.equal(artifact.stale, true);
  assert.equal(artifact.verificationStatus, "partially_verified");
  assert.deepEqual(artifact.sourceSnapshot, f.journal.snapshot);
  assert.deepEqual(artifact.coverage, f.journal.coverage);
  assert.deepEqual(artifact.sourceVersions, { [f.source.sourceId]: f.source.contentHash });
  assert.deepEqual(artifact.staleSourceIds, [f.source.sourceId]);
  const kb = agent.createSideChatKnowledgeBase({ localWorkspaceContext: context });
  assert.match(agent.buildSideChatCatalog(kb), /historical-stale/);
  assert.match(agent.buildSideChatCatalog(kb), /never use stale findings as current conclusions/);
  const item = kb.items.find(item => item.evidenceType === "saved-synthesis");
  const read = JSON.parse(agent.executeSideChatTool(toolCall("read_workspace_item", { item_id: item.id }), kb));
  assert.equal(read.provenance.stale, true);
  assert.match(read.content, /Saved review concluded/);
  assert.equal(f.counts.generations, 0);
});

test("source changes and deletion flag both layers and cannot validate historic page handles", async () => {
  for (const change of ["changed", "deleted"]) {
    const f = await fixture();
    const oldHash = f.source.contentHash;
    if (change === "changed") {
      f.source.contentHash = "new-source-hash";
    } else f.source.catalogStatus = "missing";
    const knowledge = await prepareKnowledge(f);
    assert.equal(knowledge.hits.length, 2, "A deleted original does not delete historical review conclusions");
    for (const hit of knowledge.hits) {
      assert.equal(hit.artifact.stale, true);
      assert.equal(hit.artifact.sourceVersions[f.source.sourceId], oldHash);
      assert.deepEqual(hit.artifact.changedSourceIds, [f.source.sourceId]);
    }
    const evidence = await f.service.buildCitationEvidence({ knowledge, files: [] });
    assert.equal(evidence.length, 0);
    const kb = knowledgeBase(f, knowledge);
    assert.equal(agent.buildSourceCitationRegistry(kb).has(f.ref), false);
  }
});

test("real source deletion through preflight preserves only historical synthesis evidence", async () => {
  const f = await fixture(); const originalVersions = { [f.source.sourceId]: f.source.contentHash };
  f.workspace.files.delete(f.source.path);
  const context = await f.service.buildContext(f.options);
  const local = sanitizeLocalWorkspaceContext(context, f.options.question);
  const synthesis = local.knowledge.hits.find(hit => hit.kind === "synthesis");
  assert.ok(synthesis); assert.equal(synthesis.artifact.stale, true);
  assert.deepEqual(synthesis.artifact.sourceVersions, originalVersions);
  assert.equal(local.citationEvidence.length, 0);
  assert.equal(f.counts.generations, 0);
  const kb = agent.createSideChatKnowledgeBase({ localWorkspaceContext: local });
  assert.match(kb.items.find(item => item.evidenceType === "saved-synthesis").content, /Saved review concluded/);
});

test("current topic answers receive stale labels and guidance to use current original evidence", async () => {
  const f = await fixture(); f.topic.sourceVersions[f.source.sourceId] = "old-hash"; f.save();
  const context = await f.service.buildContext({ ...f.options, question: "Compare enzyme engineering strategies across studies." });
  const kb = agent.createSideChatKnowledgeBase({ localWorkspaceContext: sanitizeLocalWorkspaceContext(context) });
  const topic = kb.items.find(item => item.evidenceType === "saved-topic");
  assert.ok(topic); assert.equal(topic.status, "historical-stale");
  assert.match(agent.buildSideChatCatalog(kb), /Use current original-paper evidence for current claims/);
  assert.equal(f.counts.generations, 0);
});

test("selected-paper scope excludes mixed artifacts at preparation, sanitization and direct agent entry", async () => {
  const f = await fixture();
  f.journal.snapshot.push({ sourceId: "other-paper", contentHash: "other-hash" });
  f.journal.maps.other = { paperId: "other-paper", contentHash: "other-hash" };
  f.topic.paperIds.push("other-paper"); f.topic.sourceVersions["other-paper"] = "other-hash"; f.save();
  const all = await prepareKnowledge(f);
  assert.equal(all.hits.length, 2);
  const scoped = await f.service.retrieveLayeredKnowledge(f.options.question, { ...layeredOptions, scopedPaperIds: [f.source.sourceId] });
  assert.equal(scoped.hits.length, 0);
  const local = { knowledge: all, scope: { type: "files", files: [f.source.path] }, literature: { selectedPaperIds: [f.source.sourceId] }, sourceMap: { paperSources: [f.source] } };
  assert.equal(sanitizeLocalWorkspaceContext(local).knowledge.hits.length, 0);
  assert.equal(agent.createSideChatKnowledgeBase({ localWorkspaceContext: local }).items.length, 0);
  assert.equal(knowledgeBase(f, all, { literature: { explicitPaperIds: [f.source.sourceId] } }).items.length, 0);
  assert.equal(knowledgeBase(f, all, { scope: { type: "files", files: ["notes/a.txt"] } }).items.length, 0);
});

test("matching selected-paper artifacts remain readable", async () => {
  const f = await fixture();
  const context = await f.service.buildContext({ ...f.options, selectedPaths: [f.source.path], selectedPaperIds: [f.source.sourceId] });
  assert.equal(context.knowledge.hits.length, 2);
  const kb = agent.createSideChatKnowledgeBase({ localWorkspaceContext: sanitizeLocalWorkspaceContext(context) });
  assert.equal(kb.items.filter(item => item.evidenceType.startsWith("saved-")).length, 2);
});

test("workspace mismatches, mid-request switches, missing local artifacts and traversal hints disclose no artifact", async () => {
  for (const scenario of ["different-index", "switch-during-search", "missing", "traversal"]) {
    const f = await fixture();
    if (scenario === "different-index") f.system.knowledgeService.workspaceId = "other-workspace";
    if (scenario === "switch-during-search") f.system.knowledgeService.searchPreviousSyntheses = async () => {
      f.workspace.workspace = { workspaceId: "other-workspace" };
      return { results: [{ sourceId: f.journal.workflowId, snippet: "Foreign contents must not be trusted" }] };
    };
    if (scenario === "missing") {
      f.workspace.files.delete(".biodesign/knowledge/syntheses/review-fixture.md");
      f.workspace.files.delete(".biodesign/knowledge/topics/fixture-topic.md");
    }
    if (scenario === "traversal") {
      const forged = async () => ({ results: [{ sourceId: "../other-workspace/private", file: "/private/document", snippet: "Foreign contents" }] });
      f.system.knowledgeService.searchPreviousSyntheses = forged; f.system.knowledgeService.searchTopics = forged;
    }
    assert.equal((await prepareKnowledge(f)).hits.length, 0, scenario);
  }
});

test("empty or offline retrieval never regenerates an earlier review", async () => {
  for (const offline of [true, false]) {
    const f = await fixture();
    f.system.knowledgeService.available = !offline;
    f.system.knowledgeService.searchPreviousSyntheses = async () => ({ results: [] });
    f.system.knowledgeService.searchTopics = async () => ({ results: [] });
    const context = await f.service.buildContext(f.options);
    assert.equal(context.knowledge.hits.length, 0);
    assert.equal(f.counts.generations, 0);
    assert.match(context.notices.join("\n"), /no in-scope saved review/);
  }
});

test("cancellation propagates and failed searches do not poison a later read", async () => {
  const f = await fixture(); const search = f.system.knowledgeService.searchPreviousSyntheses;
  const controller = new AbortController();
  f.system.knowledgeService.searchPreviousSyntheses = async () => { controller.abort(); return search(); };
  await assert.rejects(f.service.retrieveLayeredKnowledge(f.options.question, { ...layeredOptions, signal: controller.signal }), { code: "OPERATION_ABORTED" });
  f.system.knowledgeService.searchPreviousSyntheses = async () => { throw Object.assign(new Error("Synthetic unavailable index"), { code: "INDEX_UNAVAILABLE" }); };
  assert.equal((await prepareKnowledge(f)).hits.filter(hit => hit.kind === "synthesis").length, 0);
  f.system.knowledgeService.searchPreviousSyntheses = search;
  assert.equal((await prepareKnowledge(f)).hits.length, 2);
});

test("malformed saved journals fall back without logging document contents", async () => {
  const f = await fixture(); const logs = []; const log = console.info;
  f.workspace.set(".biodesign/workflows/review-fixture.json", "SYNTHETIC_PRIVATE_DOCUMENT_MARKER invalid json");
  console.info = (...values) => logs.push(values);
  try {
    const knowledge = await prepareKnowledge(f);
    assert.equal(knowledge.hits.filter(hit => hit.kind === "synthesis").length, 0);
  } finally { console.info = log; }
  assert.doesNotMatch(JSON.stringify(logs), /SYNTHETIC_PRIVATE_DOCUMENT_MARKER/);
  f.save(); assert.equal((await prepareKnowledge(f)).hits.length, 2);
});

test("content is bounded and useful late findings keep intact original evidence handles", async () => {
  const f = await fixture();
  f.journal.reduction.findings = Array.from({ length: 300 }, (_, i) => ({ claim: `Background finding ${i} ${"filler ".repeat(16)}`, supportingPaperIds: [f.source.sourceId], evidenceRefs: [f.ref] }));
  f.journal.reduction.findings.push({ claim: "Target late thermostability tradeoff conclusion.", supportingPaperIds: [f.source.sourceId], evidenceRefs: [f.ref] });
  f.save();
  const knowledge = await f.service.retrieveLayeredKnowledge("What did the previous review say about thermostability?", layeredOptions);
  const saved = knowledge.hits.find(hit => hit.kind === "synthesis").artifact;
  assert.ok(saved.content.length <= SAVED_ARTIFACT_LIMITS.contentCharacters);
  assert.equal(saved.truncated, true); assert.match(saved.content, /Target late thermostability/);
  assert.ok(saved.content.includes(f.ref));
  assert.ok(knowledge.hits.every(hit => hit.snippet.length <= 1200));
  const kb = knowledgeBase(f, knowledge); const item = kb.items[0];
  const read = JSON.parse(agent.executeSideChatTool(toolCall("read_workspace_item", { item_id: item.id, max_characters: 16000 }), kb));
  assert.ok(read.content.includes(f.ref));
  const oversized = { ...saved, sourceSnapshot: Array.from({ length: 501 }, (_, i) => ({ sourceId: `source-${i}` })) };
  assert.equal(sanitizeSavedArtifact(oversized), null, "Never truncate provenance to fit a paper scope");
});

test("artifact count is bounded and complete large provenance can be paged through the existing read tool", async () => {
  const f = await fixture(); const knowledge = await prepareKnowledge(f);
  const hit = knowledge.hits[0];
  const many = { available: true, hits: Array.from({ length: 12 }, (_, i) => ({ ...hit, artifact: { ...hit.artifact, artifactId: `saved-${i}` } })) };
  const kb = knowledgeBase(f, many);
  assert.equal(kb.items.length, SAVED_ARTIFACT_LIMITS.items);
  const artifact = hit.artifact;
  for (let i = 0; i < 130; i++) {
    artifact.sourceSnapshot.push({ sourceId: `source-${i}`, contentHash: "h".repeat(64), statSignature: "stat" });
    artifact.sourceVersions[`source-${i}`] = "h".repeat(64);
  }
  const large = knowledgeBase(f, { available: true, hits: [hit] });
  const item = large.items[0]; assert.ok(item);
  let content = "", offset = 0;
  do {
    const read = JSON.parse(agent.executeSideChatTool(toolCall("read_workspace_item", { item_id: item.id, offset, max_characters: 8000 }), large));
    content += read.content; offset = read.next_offset;
  } while (offset !== null);
  const provenance = JSON.parse(content.slice(item.metadata.provenanceOffset));
  assert.equal(provenance.sourceSnapshot.length, 131);
  assert.equal(provenance.sourceVersions["source-129"], "h".repeat(64));
});

test("explicit update and corpus synthesis retain existing workflow result delivery and scoped model", async () => {
  for (const update of [false, true]) {
    const f = await fixture(); let forwarded;
    const workflow = { preview: { marker: "Existing corpus result delivery", evidenceRefs: [f.ref] } };
    f.system.corpusWorkflows.run = async (_question, options) => { forwarded = options; f.counts.generations++; return workflow; };
    f.system.corpusWorkflows.updateCorpusSynthesis = async (_id, options) => { forwarded = options; f.counts.updates++; return { workflow, status: await f.system.corpusWorkflows.getWorkflowStatus(), reusedExistingSynthesis: false }; };
    const context = await f.service.buildContext({ ...f.options, question: update ? "Update the previous review with new papers." : "Summarize all papers." });
    assert.equal(f.counts.updates, update ? 1 : 0); assert.equal(f.counts.generations, update ? 0 : 1);
    assert.equal(f.counts.synthesisSearches, 0);
    assert.equal(forwarded.callContext.model, f.options.callContext.model);
    const kb = agent.createSideChatKnowledgeBase({ localWorkspaceContext: sanitizeLocalWorkspaceContext(context) });
    const item = kb.items.find(item => item.evidenceType === "corpus-workflow");
    assert.ok(item); const read = JSON.parse(agent.executeSideChatTool(toolCall("read_workspace_item", { item_id: item.id }), kb));
    assert.match(read.content, /Existing corpus result delivery/);
    assert.equal(read.citation, undefined); assert.match(read.citation_guidance, /original evidenceRefs/);
  }
});
