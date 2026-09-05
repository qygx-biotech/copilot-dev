import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";
import { test } from "node:test";

import knowledgeApi from "../../docs/knowledge-service.js";
import retrievalContract from "../../shared/retrieval-contract.js";

const { RETRIEVAL_LIMITS, CLOUD_RETRIEVAL } = retrievalContract;
const plannerSignature = "a".repeat(64);
const rerankerSignature = "b".repeat(64);

function makeWorkspace() {
  const files = new Map();
  return {
    files,
    async fileExists(path) { return files.has(path); },
    async readJson(path) { return structuredClone(files.get(path)); },
    async writeJson(path, value) { files.set(path, structuredClone(value)); },
  };
}

function makeDesktop(searcher) {
  const calls = { searches: [], embeds: 0 };
  return {
    calls,
    bridge: {
      knowledge: {
        onProgress: () => () => {},
        initialize: async () => ({ available: true }),
        search: async (payload) => {
          calls.searches.push(structuredClone(payload));
          return searcher(payload);
        },
        update: async () => ({}),
        embed: async () => { calls.embeds += 1; return []; },
        status: async () => ({ available: true }),
        document: async () => null,
      },
    },
  };
}

function configuration() {
  return {
    ok: true,
    schemaVersion: CLOUD_RETRIEVAL.schemaVersion,
    searchPlanPromptVersion: CLOUD_RETRIEVAL.searchPlanPromptVersion,
    rerankPromptVersion: CLOUD_RETRIEVAL.rerankPromptVersion,
    plannerSignature,
    rerankerSignature,
  };
}

function validPlan(signature = plannerSignature, query = "expanded evidence query") {
  return {
    ok: true,
    configurationSignature: signature,
    plan: {
      queries: [query],
      identifiers: [],
      sourceLanguage: "en",
      reasoningSummary: "Use one bounded lexical expansion.",
    },
  };
}

test("Fast retrieval is offline lexical-only and default semantic mode does not initialize a model", async () => {
  const desktop = makeDesktop(() => ({
    mode: "fast",
    results: [{ paperId: "paper-fast", title: "Fast", matchedSections: [] }],
    diagnostics: { mode: "fast" },
  }));
  const service = new knowledgeApi.ElectronQmdKnowledgeService({
    desktop: desktop.bridge,
    cloudApi: new Proxy({}, { get() { throw new Error("Fast mode touched cloud."); } }),
  });
  await service.initialize({ workspaceId: "workspace-fast" });
  const fast = await service.searchLiterature({ query: "EctD", mode: "fast" });
  const semantic = await service.searchLiterature({ query: "热稳定性", mode: "semantic" });

  assert.equal(fast.results[0].paperId, "paper-fast");
  assert.equal(semantic.diagnostics.localSemanticDisabled, true);
  assert.deepEqual(desktop.calls.searches.map((call) => call.mode), ["fast", "fast"]);
  assert.equal(desktop.calls.embeds, 0);
});

test("Deep retrieval uses authenticated FC planning/reranking, budgeted snippets, local reconstruction, and deterministic omission order", async () => {
  const desktop = makeDesktop((payload) => {
    assert.equal(payload.mode, "fast");
    const expanded = payload.query.includes("thermostability");
    return {
      mode: "fast",
      diagnostics: { mode: "fast" },
      results: expanded
        ? [
            {
              paperId: "paper-b",
              title: "EctD stability study",
              score: 0.9,
              matchedSections: [{
                snippet: "A163V improves thermostability at /Users/research/private/paper.pdf",
                qmdDoc: "/Users/research/private/paper.md",
                score: 0.9,
              }],
            },
            {
              paperId: "paper-a",
              title: "EctD variants",
              score: 0.8,
              matchedSections: [{ snippet: "EctD A163V thermal evidence", score: 0.8 }],
            },
          ]
        : [
            {
              paperId: "paper-a",
              title: "EctD variants",
              score: 0.9,
              matchedSections: [{ snippet: "EctD A163V thermal evidence", score: 0.9 }],
            },
            {
              paperId: "paper-b",
              title: "EctD stability study",
              score: 0.7,
              matchedSections: [{ snippet: "Authorization: Bearer private-token A163V", score: 0.7 }],
            },
          ],
    };
  });
  const calls = { config: 0, plan: 0, rerank: 0, rerankPayload: null };
  const cloudApi = {
    async getKnowledgeRetrievalConfig() { calls.config += 1; return configuration(); },
    async planKnowledgeSearch(payload) {
      calls.plan += 1;
      assert.deepEqual(Object.keys(payload).sort(), ["callContext", "intent", "query"]);
      assert.equal(payload.callContext.callRole, "search_planner");
      return {
        ok: true,
        configurationSignature: plannerSignature,
        plan: {
          queries: ["EctD A163V thermostability"],
          identifiers: ["A163V", "EctD"],
          sourceLanguage: "zh",
          reasoningSummary: "Map the Chinese stability question to English EctD mutation terminology.",
        },
      };
    },
    async rerankKnowledgeCandidates(payload) {
      calls.rerank += 1;
      calls.rerankPayload = structuredClone(payload);
      const paperA = payload.candidates.find((candidate) => candidate.title === "EctD variants");
      return {
        ok: true,
        configurationSignature: rerankerSignature,
        ranked: [{ candidateId: paperA.candidateId, score: 0.98, reason: "Direct A163V evidence." }],
      };
    },
  };
  const workspace = makeWorkspace();
  const service = new knowledgeApi.ElectronQmdKnowledgeService({
    desktop: desktop.bridge,
    cloudApi,
    workspace,
    cryptoProvider: webcrypto,
  });
  await service.initialize({ workspaceId: "workspace-deep" });

  const input = {
    query: "哪个 EctD 突变提高热稳定性？",
    intent: "identify exact mutation evidence",
    mode: "deep",
    collections: ["literature-evidence"],
    limit: RETRIEVAL_LIMITS.resultDefault,
    candidateLimit: RETRIEVAL_LIMITS.candidateDefault,
  };
  const first = await service.searchLiterature(input);
  assert.deepEqual(first.results.map((result) => result.paperId), ["paper-a", "paper-b"]);
  assert.equal(first.results[0].matchedSections[0].snippet, "EctD A163V thermal evidence");
  assert.equal(first.diagnostics.reranker.status, "succeeded");
  assert.ok(desktop.calls.searches.some((call) => call.query.includes("thermostability")));
  assert.ok(calls.rerankPayload.candidates.length <= RETRIEVAL_LIMITS.candidateMaximum);
  assert.ok(
    calls.rerankPayload.candidates.flatMap((candidate) => candidate.evidence)
      .reduce((total, evidence) => total + evidence.snippet.length, 0) <=
      RETRIEVAL_LIMITS.totalEvidenceCharacters
  );
  const transmitted = JSON.stringify(calls.rerankPayload);
  assert.doesNotMatch(transmitted, /\/Users\//);
  assert.doesNotMatch(transmitted, /Bearer private-token/);
  assert.doesNotMatch(transmitted, /qmdDoc|directoryHandle|fileData|accessToken/);

  const second = await service.searchLiterature(input);
  assert.equal(calls.config, 2, "FC signatures are checked before every cache lookup");
  assert.equal(calls.plan, 1);
  assert.equal(calls.rerank, 1);
  assert.equal(second.diagnostics.planner.cached, true);
  assert.equal(second.diagnostics.reranker.cached, true);
  assert.ok([...workspace.files.keys()].every((path) => path.startsWith(CLOUD_RETRIEVAL.cacheDirectory)));
  assert.doesNotMatch(JSON.stringify([...workspace.files.values()]), /Bearer|accessToken|apiKey/i);
});

test("invalid cloud IDs and FC failures preserve deterministic local lexical fusion", async () => {
  const desktop = makeDesktop(() => ({
    mode: "fast",
    diagnostics: { mode: "fast" },
    results: [
      { paperId: "paper-a", title: "A", score: 0.9, matchedSections: [{ snippet: "A163V", score: 0.9 }] },
      { paperId: "paper-b", title: "B", score: 0.8, matchedSections: [{ snippet: "EctD", score: 0.8 }] },
    ],
  }));
  let mode = "hallucinated";
  const cloudApi = {
    async getKnowledgeRetrievalConfig() { return configuration(); },
    async planKnowledgeSearch() {
      if (mode === "planning-failure") throw new Error("planner offline");
      return {
        ok: true,
        configurationSignature: plannerSignature,
        plan: { queries: [], identifiers: [], sourceLanguage: "en", reasoningSummary: "Exact lexical lookup." },
      };
    },
    async rerankKnowledgeCandidates(payload) {
      if (mode === "rerank-failure") throw new Error("reranker offline");
      if (mode === "duplicate") {
        return {
          ok: true,
          configurationSignature: rerankerSignature,
          ranked: [
            { candidateId: payload.candidates[0].candidateId, score: 0.9, reason: "first" },
            { candidateId: payload.candidates[0].candidateId, score: 0.8, reason: "duplicate" },
          ],
        };
      }
      return {
        ok: true,
        configurationSignature: rerankerSignature,
        ranked: [{ candidateId: `candidate-${"f".repeat(64)}`, score: 0.9, reason: "hallucinated" }],
      };
    },
  };

  for (const failureMode of ["hallucinated", "duplicate", "rerank-failure", "planning-failure"]) {
    mode = failureMode;
    const service = new knowledgeApi.ElectronQmdKnowledgeService({
      desktop: desktop.bridge,
      cloudApi,
      cryptoProvider: webcrypto,
    });
    await service.initialize({ workspaceId: `workspace-${failureMode}` });
    const result = await service.searchLiterature({
      query: "A163V EctD",
      intent: "exact identifier retrieval",
      mode: "deep",
    });
    assert.deepEqual(result.results.map((item) => item.paperId), ["paper-a", "paper-b"]);
    if (failureMode !== "planning-failure") {
      assert.equal(result.diagnostics.fallback, "local-lexical-fusion");
      assert.equal(result.diagnostics.reranker.status, "failed");
    } else {
      assert.equal(result.diagnostics.planner.status, "failed");
    }
  }
});

test("equivalent planner inputs share one concurrent request across paper and collection scopes", async () => {
  const workspace = makeWorkspace();
  let releasePlan;
  let plannerCalls = 0;
  let markPlanStarted;
  const planStarted = new Promise((resolve) => { markPlanStarted = resolve; });
  const cloudApi = {
    planKnowledgeSearch() {
      plannerCalls += 1;
      markPlanStarted();
      return new Promise((resolve) => { releasePlan = resolve; });
    },
  };
  const service = new knowledgeApi.ElectronQmdKnowledgeService({
    desktop: makeDesktop(() => ({ results: [] })).bridge,
    cloudApi,
    workspace,
    cryptoProvider: webcrypto,
  });
  const config = configuration();
  const first = service.getSearchPlan(
    "  EctD\tstability  ",
    " corpus   evidence ",
    { paperIds: ["paper-a"], collections: ["literature-evidence"], limit: 5 },
    config
  );
  const second = service.getSearchPlan(
    "EctD stability",
    "corpus evidence",
    { paperIds: ["paper-b"], collections: ["paper-cards"], limit: 25 },
    config
  );
  await planStarted;
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(plannerCalls, 1);
  assert.equal(service.searchPlanInFlight.size, 1);
  releasePlan(validPlan());
  const [firstResult, secondResult] = await Promise.all([first, second]);
  assert.deepEqual(firstResult.plan, secondResult.plan);
  assert.equal(firstResult.shared === true || secondResult.shared === true, true);
  assert.equal(
    [...workspace.files.keys()].filter((path) => path.includes("search-plan-")).length,
    1
  );
});

test("planner identity changes only for material query, intent, signature, prompt, schema, or validation inputs", () => {
  const base = knowledgeApi.createSearchPlanCacheIdentity(
    " EctD  stability ",
    " corpus evidence ",
    plannerSignature
  );
  assert.deepEqual(
    base,
    knowledgeApi.createSearchPlanCacheIdentity(
      "EctD stability",
      "corpus evidence",
      plannerSignature
    )
  );
  assert.notDeepEqual(
    base,
    knowledgeApi.createSearchPlanCacheIdentity("different query", "corpus evidence", plannerSignature)
  );
  assert.notDeepEqual(
    base,
    knowledgeApi.createSearchPlanCacheIdentity("EctD stability", "different intent", plannerSignature)
  );
  assert.notDeepEqual(
    base,
    knowledgeApi.createSearchPlanCacheIdentity("EctD stability", "corpus evidence", "c".repeat(64))
  );
  assert.notDeepEqual(
    base,
    knowledgeApi.createSearchPlanCacheIdentity(
      "EctD stability",
      "corpus evidence",
      plannerSignature,
      { promptVersion: "cloud-search-plan-v999-test" }
    )
  );
  assert.notDeepEqual(
    base,
    knowledgeApi.createSearchPlanCacheIdentity(
      "EctD stability",
      "corpus evidence",
      plannerSignature,
      { schemaVersion: CLOUD_RETRIEVAL.schemaVersion + 1 }
    )
  );
  assert.deepEqual(Object.keys(base).sort(), [
    "configurationSignature",
    "normalizedQuery",
    "promptVersion",
    "retrievalIntent",
    "schemaVersion",
    "validation",
  ]);
  assert.equal(JSON.stringify(base).includes("paper-a"), false);
  assert.equal(JSON.stringify(base).includes("literature-evidence"), false);
});

test("different normalized queries or intents produce separate cloud plans", async () => {
  let plannerCalls = 0;
  const service = new knowledgeApi.ElectronQmdKnowledgeService({
    desktop: makeDesktop(() => ({ results: [] })).bridge,
    cloudApi: {
      async planKnowledgeSearch(payload) {
        plannerCalls += 1;
        return validPlan(plannerSignature, `${payload.query} expanded`);
      },
    },
    workspace: makeWorkspace(),
    cryptoProvider: webcrypto,
  });
  const config = configuration();
  await service.getSearchPlan("query A", "intent A", {}, config);
  await service.getSearchPlan("query B", "intent A", {}, config);
  await service.getSearchPlan("query A", "intent B", {}, config);
  assert.equal(plannerCalls, 3);
});

test("planner signature and cached schema changes cannot reuse an older plan", async () => {
  const workspace = makeWorkspace();
  let activeSignature = plannerSignature;
  let plannerCalls = 0;
  const service = new knowledgeApi.ElectronQmdKnowledgeService({
    desktop: makeDesktop(() => ({ results: [] })).bridge,
    cloudApi: {
      async planKnowledgeSearch() {
        plannerCalls += 1;
        return validPlan(activeSignature, `plan-${plannerCalls}`);
      },
    },
    workspace,
    cryptoProvider: webcrypto,
  });
  const configA = configuration();
  await service.getSearchPlan("EctD", "corpus evidence", {}, configA);
  const firstCachePath = [...workspace.files.keys()].find((path) =>
    path.includes("search-plan-")
  );
  workspace.files.get(firstCachePath).schemaVersion = CLOUD_RETRIEVAL.schemaVersion + 1;
  const restarted = new knowledgeApi.ElectronQmdKnowledgeService({
    desktop: makeDesktop(() => ({ results: [] })).bridge,
    cloudApi: service.cloudApi,
    workspace,
    cryptoProvider: webcrypto,
  });
  await restarted.getSearchPlan("EctD", "corpus evidence", {}, configA);

  activeSignature = "c".repeat(64);
  await restarted.getSearchPlan(
    "EctD",
    "corpus evidence",
    {},
    { ...configA, plannerSignature: activeSignature }
  );
  assert.equal(plannerCalls, 3);
  assert.equal(
    [...workspace.files.keys()].filter((path) => path.includes("search-plan-")).length,
    2
  );
});

test("failed shared planner requests leave the in-flight registry and retry normally", async () => {
  let plannerCalls = 0;
  const service = new knowledgeApi.ElectronQmdKnowledgeService({
    desktop: makeDesktop(() => ({ results: [] })).bridge,
    cloudApi: {
      async planKnowledgeSearch() {
        plannerCalls += 1;
        if (plannerCalls === 1) throw new Error("temporary planner outage");
        return validPlan();
      },
    },
    workspace: makeWorkspace(),
    cryptoProvider: webcrypto,
  });
  const config = configuration();
  await assert.rejects(
    service.getSearchPlan("EctD", "corpus evidence", {}, config),
    /temporary planner outage/
  );
  assert.equal(service.searchPlanInFlight.size, 0);
  const retried = await service.getSearchPlan("EctD", "corpus evidence", {}, config);
  assert.equal(retried.plan.queries[0], "expanded evidence query");
  assert.equal(plannerCalls, 2);
});

test("one cancelled planner consumer does not cancel or evict another consumer", async () => {
  let releasePlan;
  let plannerCalls = 0;
  let markPlanStarted;
  const planStarted = new Promise((resolve) => { markPlanStarted = resolve; });
  const service = new knowledgeApi.ElectronQmdKnowledgeService({
    desktop: makeDesktop(() => ({ results: [] })).bridge,
    cloudApi: {
      planKnowledgeSearch() {
        plannerCalls += 1;
        markPlanStarted();
        return new Promise((resolve) => { releasePlan = resolve; });
      },
    },
    workspace: makeWorkspace(),
    cryptoProvider: webcrypto,
  });
  const config = configuration();
  const abortController = new AbortController();
  const cancelled = service.getSearchPlan(
    "EctD",
    "corpus evidence",
    { signal: abortController.signal, paperIds: ["paper-a"] },
    config
  );
  const retained = service.getSearchPlan(
    "EctD",
    "corpus evidence",
    { paperIds: ["paper-b"] },
    config
  );
  await planStarted;
  abortController.abort();
  await assert.rejects(cancelled, (error) => error.code === "OPERATION_ABORTED");
  assert.equal(service.searchPlanInFlight.size, 1);
  releasePlan(validPlan());
  const retainedResult = await retained;
  assert.equal(retainedResult.plan.queries[0], "expanded evidence query");
  assert.equal(plannerCalls, 1);
  assert.equal(service.searchPlanInFlight.size, 0);
});

test("shared planning does not weaken paper scope in local search or cloud reranking", async () => {
  const desktop = makeDesktop((payload) => ({
    mode: "fast",
    diagnostics: { mode: "fast" },
    results: payload.paperIds.map((paperId) => ({
      paperId,
      title: paperId,
      score: 1,
      matchedSections: [{ snippet: `${paperId} evidence`, score: 1 }],
    })),
  }));
  const rerankScopes = [];
  let plannerCalls = 0;
  const cloudApi = {
    async getKnowledgeRetrievalConfig() { return configuration(); },
    async planKnowledgeSearch() {
      plannerCalls += 1;
      await new Promise((resolve) => setTimeout(resolve, 5));
      return validPlan(plannerSignature, "shared expansion");
    },
    async rerankKnowledgeCandidates(payload) {
      rerankScopes.push(payload.candidates.map((candidate) => candidate.title));
      return {
        ok: true,
        configurationSignature: rerankerSignature,
        ranked: payload.candidates.map((candidate) => ({
          candidateId: candidate.candidateId,
          score: 1,
          reason: "Scoped evidence.",
        })),
      };
    },
  };
  const service = new knowledgeApi.ElectronQmdKnowledgeService({
    desktop: desktop.bridge,
    cloudApi,
    workspace: makeWorkspace(),
    cryptoProvider: webcrypto,
  });
  await service.initialize({ workspaceId: "scoped-planning" });
  await Promise.all([
    service.searchLiterature({
      query: "common corpus question",
      intent: "scientific paper evidence",
      mode: "deep",
      paperIds: ["paper-a"],
    }),
    service.searchLiterature({
      query: "common corpus question",
      intent: "scientific paper evidence",
      mode: "deep",
      paperIds: ["paper-b"],
    }),
  ]);
  assert.equal(plannerCalls, 1);
  assert.deepEqual(
    new Set(desktop.calls.searches.flatMap((call) => call.paperIds)),
    new Set(["paper-a", "paper-b"])
  );
  assert.deepEqual(rerankScopes.map((scope) => scope.sort()).sort(), [["paper-a"], ["paper-b"]]);
});

test("generic corpus reviews use the bounded scientific rubric and persist no provider reasoning", async () => {
  let plannerCalls = 0;
  const service = new knowledgeApi.ElectronQmdKnowledgeService({
    desktop: makeDesktop(() => ({ results: [] })).bridge,
    cloudApi: {
      async getKnowledgeRetrievalConfig() { return configuration(); },
      async planKnowledgeSearch() {
        plannerCalls += 1;
        return {
          ok: true,
          configurationSignature: plannerSignature,
          plan: {
            queries: ["literature review", "systematic review", "meta-analysis"],
            identifiers: ["hallucinated-identifier"],
            sourceLanguage: "zh",
            reasoningSummary: "Private provider interpretation must not enter the journal.",
          },
        };
      },
      async rerankKnowledgeCandidates() { throw new Error("not reached"); },
    },
    workspace: makeWorkspace(),
    cryptoProvider: webcrypto,
  });
  await service.initialize({ workspaceId: "generic-corpus-plan" });
  const question = "帮我总结所有文献，写一个综述。";
  const intent = "corpus scientific evidence extraction";
  const plan = await service.prepareCorpusSearchPlan(question, intent, {
    callContext: {
      turnId: "turn-generic-plan",
      workflowId: "workflow-generic-plan",
      callRole: "search_planner",
      profile: "high",
    },
  });

  assert.equal(plannerCalls, 1);
  assert.equal(plan.useOriginalQuery, false);
  assert.equal(plan.crossLanguage, true);
  assert.deepEqual(plan.queries, [...knowledgeApi.CORPUS_SCIENTIFIC_DIMENSIONS]);
  assert.deepEqual(plan.identifiers, []);
  assert.equal(Object.hasOwn(plan, "reasoningSummary"), false);
  assert.equal(
    service.validateSharedCorpusPlan(
      { ...plan, providerReasoning: "must not persist" },
      question,
      intent,
      configuration()
    ),
    null
  );
});

test("an explicit planner refresh bypasses compatible resolved and workspace cache entries", async () => {
  let plannerCalls = 0;
  const service = new knowledgeApi.ElectronQmdKnowledgeService({
    desktop: makeDesktop(() => ({ results: [] })).bridge,
    cloudApi: {
      async planKnowledgeSearch() {
        plannerCalls += 1;
        return validPlan(plannerSignature, `expanded plan ${plannerCalls}`);
      },
    },
    workspace: makeWorkspace(),
    cryptoProvider: webcrypto,
  });
  const config = configuration();
  await service.getSearchPlan("EctD", "corpus evidence", {}, config);
  await service.getSearchPlan("EctD", "corpus evidence", {}, config);
  const refreshed = await service.getSearchPlan(
    "EctD",
    "corpus evidence",
    { forceRefresh: true },
    config
  );
  assert.equal(plannerCalls, 2);
  assert.equal(refreshed.plan.queries[0], "expanded plan 2");
});
