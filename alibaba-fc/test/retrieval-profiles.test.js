"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const profiles = require("../../shared/retrieval-profiles.js");
const { LiteratureTools } = require("../../docs/source-system.js");

function result(overrides = {}) {
  return {
    title: "Thermostability of EctD A163V",
    authors: ["Researcher"],
    year: 2025,
    identifiers: ["EctD", "A163V", "10.1000/ectd.2025"],
    snippet: "The EctD A163V variant had kcat and Km values measured in BL21(DE3).",
    ...overrides,
  };
}

test("Light exactly preserves the existing Han Deep and non-Han Fast rules", () => {
  assert.deepEqual(profiles.selectRetrievalProfile("light", { query: "EctD A163V" }), {
    profile: "light",
    mode: "fast",
    escalated: false,
    reason: "light-non-han-fast",
  });
  assert.deepEqual(profiles.selectRetrievalProfile("light", { query: "比较 EctD 文献" }), {
    profile: "light",
    mode: "deep",
    escalated: true,
    reason: "light-han-deep",
  });
});

test("Medium accepts strong identifier, title, author/year, and kinetic matches locally", () => {
  const queries = [
    "EctD A163V",
    "10.1000/ectd.2025",
    "kcat Km EctD",
    "BL21(DE3)",
    "Researcher et al. 2025",
    '"Thermostability of EctD A163V"',
  ];
  for (const query of queries) {
    const decision = profiles.selectRetrievalProfile("medium", {
      query,
      fastResults: [result()],
    });
    assert.equal(decision.mode, "fast", query);
    assert.equal(decision.reason, "medium-strong-exact-match", query);
  }
});

test("Medium deterministically escalates cross-language and conceptual discovery", () => {
  const cases = [
    ["比较羟基四氢嘧啶合成策略", "medium-cross-language"],
    ["сравнить стратегии ферментации", "medium-cross-language"],
    ["compare fermentation strategies", "medium-conceptual-discovery"],
    ["survey the literature landscape", "medium-conceptual-discovery"],
    ["explain the mechanism", "medium-conceptual-discovery"],
  ];
  for (const [query, reason] of cases) {
    assert.deepEqual(
      profiles.shouldEscalateFastResults({ query, results: [result()] }),
      { escalate: true, reason }
    );
  }
});

test("Medium escalates empty and incomplete Fast evidence without a score threshold", () => {
  assert.deepEqual(
    profiles.shouldEscalateFastResults({ query: "ectoine hydroxylase", results: [] }),
    { escalate: true, reason: "medium-no-usable-fast-results" }
  );
  assert.deepEqual(
    profiles.shouldEscalateFastResults({
      query: "ectoine hydroxylase oxygen dependence",
      results: [result({ snippet: "Ectoine hydroxylase was measured." })],
    }),
    { escalate: true, reason: "medium-insufficient-lexical-coverage" }
  );
  assert.deepEqual(
    profiles.shouldEscalateFastResults({
      query: "ectoine hydroxylase oxygen dependence",
      results: [result({ snippet: "Ectoine hydroxylase showed oxygen dependence." })],
    }),
    { escalate: false, reason: "medium-complete-lexical-coverage" }
  );
});

test("High always selects Deep for relevant literature retrieval", () => {
  for (const query of ["EctD A163V", "one paper", "中文文献"] ) {
    assert.deepEqual(profiles.selectRetrievalProfile("high", { query }), {
      profile: "high",
      mode: "deep",
      escalated: true,
      reason: "high-relevant-deep",
    });
  }
});

test("profile validation accepts only the fixed public enum", () => {
  for (const value of ["light", "medium", "high"]) {
    assert.equal(profiles.isValidRetrievalProfile(value), true);
  }
  for (const value of ["deep", "HIGH", "https://example.test", { mode: "deep" }, null]) {
    assert.equal(profiles.isValidRetrievalProfile(value), false);
    assert.equal(profiles.normalizeRetrievalProfile(value), "light");
  }
});

function makeLiteratureTools(searchLiterature) {
  const source = {
    sourceId: "paper-1",
    sourceKind: "paper",
    displayName: "ectd.pdf",
    path: "literature/ectd.pdf",
    catalogStatus: "ready",
    hashStatus: "ready",
    parseStatus: "ready",
    indexStatus: "ready",
    paperCardStatus: "ready",
    artifacts: {},
    legacy: {
      discovery: {
        title: "Thermostability of EctD A163V",
        authors: ["Researcher"],
        year: 2025,
        identifiers: ["EctD", "A163V", "10.1000/ectd.2025"],
      },
    },
  };
  const calls = [];
  const events = [];
  const knowledgeService = {
    available: true,
    emit(event) { events.push(event.stage); },
    async searchLiterature(input) {
      calls.push(input.mode);
      return searchLiterature(input, source);
    },
  };
  const tools = new LiteratureTools({
    registry: {
      aliases: {},
      list() { return [source]; },
      get(id) { return id === source.sourceId ? source : null; },
      async persist() {},
    },
    preparation: {
      results: { compact(value) { return value; } },
      async ensureSourceReady() {},
      async readPaperArtifact() {
        return { chunks: [{ chunkId: "chunk-1", page: 1, text: result().snippet }] };
      },
    },
    results: { compact(value) { return value; } },
    knowledgeService,
  });
  return { tools, calls, events };
}

function qmdResult(source) {
  return {
    mode: "fast",
    results: [{
      paperId: source.sourceId,
      title: source.legacy.discovery.title,
      score: 2,
      matchedSections: [{ snippet: result().snippet, score: 2, qmdDoc: "doc-1" }],
    }],
    diagnostics: { mode: "fast" },
  };
}

test("Medium serializes Fast-first escalation and avoids duplicate Deep downloads", async () => {
  const exact = makeLiteratureTools((input, source) => qmdResult(source));
  const accepted = await exact.tools.searchPapers("EctD A163V", {
    qmdQuery: "EctD A163V",
    retrievalProfile: "medium",
  });
  assert.deepEqual(exact.calls, ["fast"]);
  assert.equal(accepted.retrievalDecision.mode, "fast");
  assert.deepEqual(exact.events, ["fast-result-accepted"]);

  const conceptual = makeLiteratureTools((input, source) => ({
    ...qmdResult(source),
    mode: input.mode,
  }));
  const escalated = await conceptual.tools.searchPapers("compare fermentation strategies", {
    qmdQuery: "compare fermentation strategies",
    retrievalProfile: "medium",
  });
  assert.deepEqual(conceptual.calls, ["fast", "deep"]);
  assert.equal(escalated.retrievalDecision.mode, "deep");
  assert.equal(escalated.retrievalDecision.reason, "medium-conceptual-discovery");
  assert.deepEqual(conceptual.events, ["escalating-deep-retrieval"]);
});

test("Light and High source integrations derive modes only from the profile", async () => {
  for (const [profile, query, expected] of [
    ["light", "EctD A163V", "fast"],
    ["light", "中文 EctD", "deep"],
    ["high", "EctD A163V", "deep"],
  ]) {
    const harness = makeLiteratureTools((input, source) => ({
      ...qmdResult(source),
      mode: input.mode,
    }));
    await harness.tools.searchPapers(query, {
      qmdQuery: query,
      retrievalProfile: profile,
      mode: expected === "fast" ? "deep" : "fast",
    });
    assert.deepEqual(harness.calls, [expected]);
  }
});

test("Medium paper-content retrieval accepts exact local evidence before Deep", async () => {
  const harness = makeLiteratureTools(() => ({
    mode: "fast",
    results: [],
    diagnostics: { mode: "fast" },
  }));
  const matches = await harness.tools.searchPaperContent(
    "paper-1",
    "EctD A163V kcat Km",
    { retrievalProfile: "medium", surface: "side_chat" }
  );
  assert.equal(matches[0].retrievalBackend, "legacy");
  assert.deepEqual(harness.calls, ["fast"]);
  assert.deepEqual(harness.events, ["fast-result-accepted"]);
});

test("Deep provider failure records a nonfatal local retrieval path", async () => {
  const harness = makeLiteratureTools((input, source) => ({
    ...qmdResult(source),
    mode: "deep",
    diagnostics: { mode: "deep", fallback: "local-lexical-fusion" },
  }));
  const searched = await harness.tools.searchPapers("compare fermentation strategies", {
    qmdQuery: "compare fermentation strategies",
    retrievalProfile: "high",
  });
  assert.equal(searched.results.length, 1);
  assert.deepEqual(searched.retrievalDecision, {
    profile: "high",
    mode: "fast",
    attemptedMode: "deep",
    escalated: true,
    reason: "local-compatible-fallback",
  });
});
