"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { webcrypto } = require("node:crypto");
const semantic = require("../../shared/semantic-intent.js");
const profiles = require("../../shared/retrieval-profiles.js");
const { ElectronQmdKnowledgeService, LocalQmdKnowledgeService } = require("../../docs/knowledge-service.js");
const { CLOUD_RETRIEVAL } = require("../../shared/retrieval-contract.js");

const original = "哪些论文讨论钙离子相关的 EctD 行为？";
const canonical = "Which papers discuss calcium-dependent EctD behavior?";
const understanding = { originalQuery: original, canonicalQueryEn: canonical, inputLanguage: "zh", answerLanguage: "zh" };

function makeService(search, cloudApi = null) {
  const calls = [];
  const service = new ElectronQmdKnowledgeService({
    cryptoProvider: webcrypto,
    cloudApi,
    desktop: { knowledge: {
      initialize: async () => ({ available: true }),
      search: async (input) => { calls.push(input); return search(input); },
    } },
  });
  return { service, calls };
}

test("literature query forms keep original language and protected identifiers independently of depth", () => {
  const identifiers = "EctD ectD A163V T212S Km kcat BL21(DE3) 10.1000/example NP_123456.1";
  const query = `查找论文 ${identifiers}`;
  const ir = semantic.interpretLocal({ query });
  ir.goal = `Find papers about ${identifiers}`;
  const parsed = semantic.requestUnderstanding(ir, query);
  assert.equal(parsed.originalQuery, query);
  assert.equal(parsed.canonicalQueryEn, ir.goal);
  assert.deepEqual(semantic.literatureQueryForms(query, parsed), [query, ir.goal]);
  ir.goal = ir.goal.replace("EctD", "ectd");
  assert.notEqual(semantic.requestUnderstanding(ir, query).canonicalQueryEn, ir.goal);
  assert.deepEqual(semantic.literatureQueryForms(query, { ...parsed, canonicalQueryEn: ir.goal }), [query]);
  assert.equal(semantic.interpretLocal({ query: `${query}，用英文回答。` }).answerLanguage, "en");
  assert.equal(profiles.selectRetrievalProfile("light", { query }).mode, "fast");
  assert.equal(profiles.selectRetrievalProfile("medium", { query }).mode, "fast");
});

test("equivalent Chinese and English literature queries retrieve the same papers using existing Fast QMD", async () => {
  const { service, calls } = makeService(({ query, paperIds }) => {
    assert.deepEqual(paperIds, ["P17", "P31"]);
    return { results: [{ paperId: "P17", score: 1, matchedSections: [{
      snippet: query === canonical ? "Calcium-dependent EctD behavior was measured." : "EctD 钙离子行为。",
      page: query === canonical ? 2 : 1, score: 1,
    }] }] };
  }, new Proxy({}, { get() { throw new Error("Fast retrieval must not call any provider."); } }));
  await service.initialize({ workspaceId: "test-workspace" });
  const zh = await service.searchLiterature({ query: original, requestUnderstanding: understanding, paperIds: ["P17", "P31"], mode: "fast" });
  const en = await service.searchLiterature({ query: canonical, paperIds: ["P17", "P31"], mode: "fast" });
  assert.deepEqual(zh.results.map((r) => r.paperId), en.results.map((r) => r.paperId));
  assert.deepEqual(calls.map((call) => call.query), [original, canonical, canonical]);
  assert.deepEqual(zh.results[0].matchedSections.map((s) => s.page), [1, 2]);
  assert.equal(zh.diagnostics.queryFormCount, 2);
  assert.equal(zh.diagnostics.retrievalBackend, "qmd");
  assert.equal(zh.diagnostics.fallbackReason, null);
});

test("canonical matches survive an empty original-language result and retain deterministic deduplication", async () => {
  const { service } = makeService(({ query }) => ({ results: query === canonical
    ? [{ paperId: "P17", score: 4, matchedSections: [{ snippet: "Calcium response", page: 2 }] }]
    : [] }));
  await service.initialize({ workspaceId: "test-workspace" });
  const input = { query: original, requestUnderstanding: understanding, mode: "fast" };
  const first = await service.searchLiterature(input);
  assert.deepEqual(first, await service.searchLiterature(input));
  assert.deepEqual(first.results.map((r) => r.paperId), ["P17"]);
  assert.equal(first.diagnostics.fallbackReason, null);
});

test("browser compatibility QMD also receives two independent query forms", async () => {
  const service = new LocalQmdKnowledgeService();
  service.available = true;
  const calls = [];
  service.request = async (_route, { body }) => {
    calls.push(body);
    return { results: [{ paperId: "P17", matchedSections: [{ snippet: body.query, page: 2 }] }] };
  };
  const result = await service.searchLiterature({ query: original, requestUnderstanding: understanding });
  assert.deepEqual(calls.map((call) => call.query), [original, canonical]);
  assert.equal(result.results.length, 1);
});

test("multilingual shared corpus planning stays one plan followed by paper-scoped retrieval", async () => {
  let planners = 0, rerankers = 0;
  const plannerSignature = "a".repeat(64), rerankerSignature = "b".repeat(64);
  const { service, calls } = makeService(({ paperIds, query }) => ({ results: paperIds.map((paperId) => ({
    paperId, title: paperId, score: 1,
    matchedSections: [{ snippet: query === canonical ? "EctD calcium response." : "EctD 钙离子行为。", page: query === canonical ? 2 : 1 }],
  })) }), {
    getKnowledgeRetrievalConfig: async () => ({ ok: true, ...CLOUD_RETRIEVAL, searchPlanPromptVersion: CLOUD_RETRIEVAL.searchPlanPromptVersion, plannerSignature, rerankerSignature }),
    planKnowledgeSearch: async () => { planners++; return {
      ok: true, configurationSignature: plannerSignature,
      plan: { queries: [canonical], identifiers: ["EctD"], sourceLanguage: "zh", reasoningSummary: "Preserve scientific identifiers." },
    }; },
    rerankKnowledgeCandidates: async () => { rerankers++; throw new Error("Single paper does not require reranking."); },
  });
  await service.initialize({ workspaceId: "test-workspace" });
  const intent = "corpus scientific evidence extraction";
  const plan = await service.prepareCorpusSearchPlan(original, intent);
  const results = await Promise.all(["P17", "P31"].map((paperId) => service.searchLiterature({
    query: original, requestUnderstanding: understanding, paperIds: [paperId], mode: "deep", intent,
    sharedRetrievalPlan: plan, sharedPlanQuery: original,
  })));
  assert.equal(planners, 1);
  assert.equal(rerankers, 0);
  for (const [index, paperId] of ["P17", "P31"].entries()) {
    assert.deepEqual(results[index].results.map((r) => r.paperId), [paperId]);
    assert.ok(calls.some((call) => call.paperIds[0] === paperId && call.query === original));
    assert.ok(calls.some((call) => call.paperIds[0] === paperId && call.query === canonical));
    assert.deepEqual(results[index].results[0].matchedSections.map((s) => s.page), [1, 2]);
  }
});

test("retrieval fallback diagnostics distinguish unavailable QMD, empty results, and search errors", async () => {
  const { service } = makeService(() => ({ results: [] }));
  assert.equal((await service.searchLiterature({ query: "EctD" })).diagnostics.fallbackReason, "qmd_not_ready");
  await service.initialize({ workspaceId: "test-workspace" });
  assert.equal((await service.searchLiterature({ query: "EctD" })).diagnostics.fallbackReason, "no_qmd_results");
  const events = [];
  service.subscribe((event) => events.push(event));
  service.searchLocal = async () => { throw new Error("search failed"); };
  await assert.rejects(service.searchLiterature({ query: "EctD" }), /search failed/);
  assert.equal(events.at(-1).diagnostics.fallbackReason, "qmd_error");
});

test("capability-unavailable semantic skip does not count as an attempted provider request", async () => {
  const interpreter = new semantic.SemanticInterpreter({ remoteParser: async () => {
    throw Object.assign(new Error("capability unavailable"), { capabilityUnavailable: true, semanticParserAttempted: false });
  } });
  const parsed = await interpreter.interpret({ query: original, profile: "high" });
  assert.equal(parsed.telemetry.semanticParserCalls, 0);
  assert.equal(parsed.telemetry.semantic.fallback, "semantic-parser-capability-unavailable");
  assert.equal(parsed.ir.answerLanguage, "zh");
});

test("one existing semantic call supplies canonical English while current input owns language", async () => {
  let calls = 0;
  const interpreter = new semantic.SemanticInterpreter({ remoteParser: async (input) => {
    calls++;
    return { ...semantic.interpretLocal(input), goal: canonical, inputLanguage: "en", answerLanguage: "en" };
  } });
  const parsed = await interpreter.interpret({ query: original, profile: "high" });
  assert.equal(calls, 1);
  assert.deepEqual(semantic.requestUnderstanding(parsed.ir, original), understanding);
});

test("experiment descriptor search retains its existing single-query behavior", async () => {
  const { service, calls } = makeService(() => ({ results: [] }));
  await service.initialize({ workspaceId: "test-workspace" });
  await service.searchExperimentSources({ query: original, requestUnderstanding: understanding, mode: "fast" });
  assert.deepEqual(calls.map((call) => call.query), [original]);
});
