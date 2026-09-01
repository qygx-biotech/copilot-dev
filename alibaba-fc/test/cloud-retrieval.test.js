"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const jwt = require("jsonwebtoken");
const retrievalContract = require("../../shared/retrieval-contract.js");

process.env.JWT_SECRET = "cloud-retrieval-test-secret";
process.env.REQUESTY_API_KEY = "fc-only-requesty-key";
process.env.REQUESTY_MODEL = "requesty/general-model";
process.env.REQUESTY_SEARCH_PLANNER_MODEL = "requesty/search-planner";
process.env.REQUESTY_RERANK_MODEL = "requesty/reranker";
process.env.REQUESTY_MODEL_SUPPORTS_JSON_SCHEMA = "true";

const providerRequests = [];
const providerResponses = [];
global.fetch = async (_url, options = {}) => {
  providerRequests.push({
    headers: { ...options.headers },
    body: JSON.parse(options.body || "{}"),
  });
  const response = providerResponses.shift();
  if (response instanceof Error) throw response;
  return new Response(JSON.stringify({
    choices: [{ message: { content: JSON.stringify(response) }, finish_reason: "stop" }],
    usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 },
  }), { status: 200, headers: { "Content-Type": "application/json" } });
};

const backend = require("../index.js");
const { RETRIEVAL_LIMITS, CLOUD_RETRIEVAL } = retrievalContract;
const token = jwt.sign({ account: "scientist@example.com", role: "admin" }, process.env.JWT_SECRET);

function event(method, path, body, authenticated = true) {
  return {
    requestContext: { http: { method, path } },
    headers: authenticated ? { Authorization: `Bearer ${token}` } : {},
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  };
}

async function invoke(method, path, body, authenticated = true) {
  const response = await backend.handler(event(method, path, body, authenticated), { requestId: "cloud-retrieval-test" });
  return { status: response.statusCode, body: JSON.parse(response.body || "{}") };
}

test.beforeEach(() => {
  providerRequests.length = 0;
  providerResponses.length = 0;
});

test("knowledge retrieval configuration and model calls require existing bearer authentication", async () => {
  const unauthenticated = await invoke("POST", "/api/knowledge/plan-search", {
    query: "EctD",
    intent: "identifier retrieval",
  }, false);
  assert.equal(unauthenticated.status, 401);
  assert.equal(providerRequests.length, 0);

  const config = await invoke("GET", "/api/knowledge/config");
  assert.equal(config.status, 200);
  assert.equal(config.body.schemaVersion, CLOUD_RETRIEVAL.schemaVersion);
  assert.match(config.body.plannerSignature, /^[a-f0-9]{64}$/);
  assert.match(config.body.rerankerSignature, /^[a-f0-9]{64}$/);
  assert.doesNotMatch(JSON.stringify(config.body), /requesty\/(?:search-planner|reranker)|fc-only-requesty-key/i);
});

test("Chinese search planning uses the dedicated Requesty model and returns strictly validated English expansions", async () => {
  providerResponses.push({
    queries: ["EctD A163V thermostability"],
    identifiers: ["A163V", "EctD"],
    sourceLanguage: "zh",
    reasoningSummary: "Translate the stability concept while preserving exact identifiers.",
  });
  const result = await invoke("POST", "/api/knowledge/plan-search", {
    query: "哪个 EctD 突变提高热稳定性？",
    intent: "retrieve exact mutation evidence",
  });
  assert.equal(result.status, 200);
  assert.deepEqual(result.body.plan.identifiers, ["A163V", "EctD"]);
  assert.match(result.body.plan.queries[0], /thermostability/);
  assert.equal(providerRequests.length, 1);
  assert.equal(providerRequests[0].body.model, process.env.REQUESTY_SEARCH_PLANNER_MODEL);
  assert.deepEqual(
    JSON.parse(providerRequests[0].body.messages[1].content),
    { query: "哪个 EctD 突变提高热稳定性？", intent: "retrieve exact mutation evidence" }
  );
  assert.equal(providerRequests[0].headers.Authorization, `Bearer ${process.env.REQUESTY_API_KEY}`);
  assert.doesNotMatch(JSON.stringify(result.body), /fc-only-requesty-key/);
});

test("planner rejects unknown keys, malformed output, and output beyond shared project limits", async () => {
  const unknownInput = await invoke("POST", "/api/knowledge/plan-search", {
    query: "EctD",
    intent: "retrieve evidence",
    directoryHandle: "/Users/private/project",
  });
  assert.equal(unknownInput.status, 400);
  assert.equal(providerRequests.length, 0);

  providerResponses.push({
    queries: Array.from({ length: RETRIEVAL_LIMITS.resultMaximum + 1 }, (_, index) => `query-${index}`),
    identifiers: [],
    sourceLanguage: "en",
    reasoningSummary: "Too many queries.",
  });
  const oversized = await invoke("POST", "/api/knowledge/plan-search", {
    query: "EctD",
    intent: "retrieve evidence",
  });
  assert.equal(oversized.status, 502);
  assert.equal(oversized.body.error, "InvalidStructuredOutput");

  providerResponses.push({
    queries: ["EctD"],
    identifiers: ["EctD"],
    sourceLanguage: "en",
    reasoningSummary: "Valid fields plus an unknown field.",
    chainOfThought: "must be rejected",
  });
  const unknownOutput = await invoke("POST", "/api/knowledge/plan-search", {
    query: "EctD",
    intent: "retrieve evidence",
  });
  assert.equal(unknownOutput.status, 502);
});

function candidate(id, title, snippet) {
  return {
    candidateId: `candidate-${id.repeat(64).slice(0, 64)}`,
    title,
    evidence: [{
      evidenceHandle: `evidence-${id.repeat(64).slice(0, 64)}-1`,
      snippet,
    }],
  };
}

test("reranking accepts only bounded opaque candidates and preserves cloud omissions for local ordering", async () => {
  const candidates = [
    candidate("a", "EctD variants", "A163V improves thermal stability."),
    candidate("b", "Fermentation study", "Fermentation evidence."),
  ];
  providerResponses.push({
    ranked: [{ candidateId: candidates[0].candidateId, score: 0.97, reason: "Direct mutation evidence." }],
  });
  const result = await invoke("POST", "/api/knowledge/rerank", {
    query: "A163V thermal stability",
    intent: "retrieve mutation evidence",
    candidates,
  });
  assert.equal(result.status, 200);
  assert.deepEqual(result.body.ranked.map((item) => item.candidateId), [candidates[0].candidateId]);
  assert.equal(providerRequests[0].body.model, process.env.REQUESTY_RERANK_MODEL);
  const sent = JSON.parse(providerRequests[0].body.messages[1].content);
  assert.deepEqual(sent.candidates, candidates);
  assert.doesNotMatch(JSON.stringify(sent), /\/Users\/|directoryHandle|fileData|Authorization|Bearer/);
  assert.ok(sent.candidates.length <= RETRIEVAL_LIMITS.candidateMaximum);
  assert.ok(JSON.stringify(sent).length <= RETRIEVAL_LIMITS.requestCharacters);
});

test("reranking rejects hallucinated and duplicate candidate IDs instead of trusting model output", async () => {
  const candidates = [candidate("a", "EctD", "A163V evidence")];
  providerResponses.push({
    ranked: [{ candidateId: `candidate-${"f".repeat(64)}`, score: 0.8, reason: "invented" }],
  });
  const hallucinated = await invoke("POST", "/api/knowledge/rerank", {
    query: "A163V",
    intent: "exact identifier",
    candidates,
  });
  assert.equal(hallucinated.status, 502);

  providerResponses.push({
    ranked: [
      { candidateId: candidates[0].candidateId, score: 0.9, reason: "one" },
      { candidateId: candidates[0].candidateId, score: 0.8, reason: "duplicate" },
    ],
  });
  const duplicate = await invoke("POST", "/api/knowledge/rerank", {
    query: "A163V",
    intent: "exact identifier",
    candidates,
  });
  assert.equal(duplicate.status, 502);
});

test("FC privacy validation rejects absolute paths, whole PDFs, and duplicate submitted IDs before Requesty", async () => {
  const first = candidate("a", "Private", "/Users/research/secret.txt");
  const privatePath = await invoke("POST", "/api/knowledge/rerank", {
    query: "EctD",
    intent: "retrieve evidence",
    candidates: [first],
  });
  assert.equal(privatePath.status, 400);

  const pdf = candidate("b", "PDF", "data:application/pdf;base64,AAAA");
  const wholePdf = await invoke("POST", "/api/knowledge/rerank", {
    query: "EctD",
    intent: "retrieve evidence",
    candidates: [pdf],
  });
  assert.equal(wholePdf.status, 400);

  const duplicate = candidate("c", "Duplicate", "Evidence");
  const duplicateInput = await invoke("POST", "/api/knowledge/rerank", {
    query: "EctD",
    intent: "retrieve evidence",
    candidates: [duplicate, duplicate],
  });
  assert.equal(duplicateInput.status, 400);
  assert.equal(providerRequests.length, 0);
});
