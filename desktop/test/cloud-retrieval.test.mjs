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
      assert.deepEqual(Object.keys(payload).sort(), ["intent", "query"]);
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
