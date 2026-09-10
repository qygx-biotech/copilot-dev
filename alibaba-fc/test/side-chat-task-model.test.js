"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const jwt = require("jsonwebtoken");
const { LiteratureApiClient, LiteratureModule } = require("../../docs/literature-module.js");
const { ProjectContextService } = require("../../docs/project-context-service.js");
const { normalizeCallContext } = require("../../docs/knowledge-service.js");
const { createFixture } = require("./helpers/preflight-fixture.js");
const semantic = require("../../shared/semantic-intent.js");
const nemotron = "nvidia/nemotron-3-nano-omni-30b-a3b-reasoning";
process.env.JWT_SECRET = "side-chat-task-model-fixture";
process.env.ADMIN_ACCOUNT = "model-test";
process.env.REQUESTY_API_KEY = "fixture-key";
process.env.REQUESTY_MODEL = "google/gemma-4-31b-it";
const roleNames = ["REQUESTY_SEARCH_PLANNER_MODEL", "REQUESTY_RERANK_MODEL", "REQUESTY_SEMANTIC_PARSER_MODEL",
  "REQUESTY_SCHEMA_MAPPER_MODEL", "REQUESTY_IMAGE_MODEL", "REQUESTY_PDF_MODEL"];
for (const name of roleNames) process.env[name] = `configured/${name.toLowerCase()}`;
process.env.REQUESTY_MODEL_SUPPORTS_JSON_SCHEMA = "true";
// These are declared fixture capabilities, not claims about the live provider.
process.env.REQUESTY_MODEL_CAPABILITIES_JSON = JSON.stringify({ [nemotron]: { pdf: true, jsonSchema: true, pdfJsonSchema: true } });
const backend = require("../index.js");
const token = jwt.sign({ account: process.env.ADMIN_ACCOUNT, role: "admin" }, process.env.JWT_SECRET);
const providerRequests = [];
global.fetch = async (_url, options) => {
  providerRequests.push(JSON.parse(options.body));
  return new Response(JSON.stringify({ choices: [{ message: { content: "{}" }, finish_reason: "stop" }] }));
};
const requests = [];
async function fcFetch(url, options = {}) {
  requests.push({ path: url, ...options });
  const result = await backend.handler({ httpMethod: options.method || "POST", path: url, headers: options.headers, body: options.body }, {});
  return new Response(result.body, { status: result.statusCode, headers: result.headers });
}
const api = new LiteratureApiClient({ baseUrl: "", fetch: fcFetch, getHeaders: () => ({ Authorization: `Bearer ${token}` }), wait: async () => {} });
const png = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=";

test("all preparatory API methods route to the selected model, including strict tasks and repair attempts", async () => {
  const callContext = { model: nemotron, turnId: "scoped-turn", profile: "medium" };
  const paper = { paperId: "paper-a", filename: "a.pdf", contentHash: "sha256:abc123", callContext };
  const calls = [
    ["semantic parser", () => api.interpretSemantics({ query: "Find EctD evidence", profile: "medium", activeScope: {}, conversationContext: [], projectSemanticRegistry: {}, callContext })],
    ["schema mapper", () => api.mapExperimentSchema({ version: 1, schemaSignature: "fixture", sheet: "Results", columns: [{ columnId: "c1", rawHeader: "Activity", unit: null, valueTypes: ["number"], examples: [1], candidateFields: ["enzyme_activity"] }], ontology: [{ canonicalField: "enzyme_activity", labels: { en: "Activity" }, canonicalUnit: null, dataType: "number" }], callContext })],
    ["planner", () => api.planKnowledgeSearch({ query: "EctD stability", intent: "scientific evidence", callContext })],
    ["reranker", () => api.rerankKnowledgeCandidates({ query: "EctD stability", intent: "scientific evidence", candidates: [{ candidateId: `candidate-${"a".repeat(64)}`, title: "EctD", evidence: [{ evidenceHandle: `evidence-${"a".repeat(64)}-1`, snippet: "EctD activity" }] }], callContext })],
    ["paper excerpt", () => api.summarizeChunk({ filename: "a.pdf", chunkIndex: 0, totalChunks: 1, text: "Scientific evidence from EctD.", callContext })],
    ["paper synthesis", () => api.synthesize({ filename: "a.pdf", chunkSummaries: [{ summary: "EctD evidence" }], callContext })],
    ["combined paper card", () => api.createPaperCardFromText({ ...paper, text: "# Page 1\nEctD evidence", pageCount: 1, chunkCount: 1 })],
    ["corpus mapper", () => api.mapCorpusPaper({ ...paper, question: "Which EctD variants improved activity?", evidence: [{ evidenceRef: "paper-a:p1:c1", claimCandidate: "The variant improved activity." }] })],
    ["native PDF", () => api.analyzePdfNative({ ...paper, task: "Summarize the paper", bytes: new TextEncoder().encode("%PDF-1.4\nfixture"), responseSchema: "paper_analysis" })],
    ["context router", () => api.routeContext({ userQuery: "Which EctD papers?", literatureIndex: [], callContext })],
    ["images", () => fcFetch("/api/chat/understand-images", { headers: { ...api.getHeaders(), "X-BioDesign-Chat-Model": nemotron }, body: JSON.stringify({ question: "Read this image", images: [{ name: "plot.png", dataUrl: png, thumbnail: png }] }) })],
  ];
  for (const [name, call] of calls) {
    providerRequests.length = 0;
    let failure;
    try { await call(); } catch (error) { failure = error; }
    assert.ok(providerRequests.length, `${name} did not reach the provider: ${failure?.code || failure?.message}`);
    assert.ok(providerRequests.every(request => request.model === nemotron), name);
    for (const request of providerRequests) assert.equal(request.requesty?.extra?.model, undefined);
  }
  assert.equal(process.env.REQUESTY_MODEL, "google/gemma-4-31b-it");
  for (const name of roleNames) assert.equal(process.env[name], `configured/${name.toLowerCase()}`);
});

test("configurations and retrieval cache signatures follow the request model; unscoped calls keep dedicated role models", async () => {
  const configs = await Promise.all([undefined, { model: "default" }, { model: nemotron }].map(async context => ({
    knowledge: await api.getKnowledgeRetrievalConfig(undefined, context),
    paper: await api.getPaperCardConfiguration(undefined, context),
  })));
  assert.equal(new Set(configs.map(config => config.knowledge.plannerSignature)).size, 3);
  assert.notEqual(configs[1].paper.modelSignature, configs[2].paper.modelSignature);
  for (const [model, expected] of [[undefined, process.env.REQUESTY_SEARCH_PLANNER_MODEL], ["default", process.env.REQUESTY_MODEL], [nemotron, nemotron]]) {
    providerRequests.length = 0;
    try { await api.planKnowledgeSearch({ query: "EctD", intent: "evidence", callContext: normalizeCallContext({ model }, "search_planner") }); } catch {}
    assert.ok(providerRequests.length);
    assert.ok(providerRequests.every(request => request.model === expected));
  }
});

test("unapproved task models are rejected after authentication and before any provider call", async () => {
  providerRequests.length = 0;
  for (const path of ["/api/literature/config", "/api/knowledge/config", "/api/semantic/interpret", "/api/chat/understand-images"]) {
    const method = path.endsWith("/config") ? "GET" : "POST";
    const headers = { "X-BioDesign-Chat-Model": "unapproved/model" };
    assert.equal((await fcFetch(path, { method, headers })).status, 401);
    assert.equal((await fcFetch(path, { method, headers: { ...headers, ...api.getHeaders() } })).status, 400);
  }
  assert.equal(providerRequests.length, 0);
});

test("selected models never borrow another model's PDF, structured output, or context-window declaration", () => {
  const env = { REQUESTY_MODEL: "google/gemma-4-31b-it", REQUESTY_PDF_MODEL: "other/pdf", REQUESTY_PDF_ENABLED: "true", REQUESTY_PDF_SUPPORTS_JSON_SCHEMA: "true", REQUESTY_MODEL_SUPPORTS_JSON_SCHEMA: "true", REQUESTY_MODEL_CONTEXT_TOKENS: "256000" };
  const scoped = backend._test.sideChatModelEnvironment(env, nemotron);
  const selection = backend._test.selectRequestyModel(scoped, "pdf");
  assert.equal(selection.model, nemotron);
  assert.equal(selection.supported, false);
  assert.equal(selection.capabilities.jsonSchema, false);
  assert.equal(selection.capabilities.contextTokens, 0);
  assert.equal(backend._test.selectRequestyModel(backend._test.sideChatModelEnvironment({ REQUESTY_MODEL: nemotron }, "default"), "pdf").supported, false);
});

test("preflight and semantic interpretation retain the initiating model; the next Agent Command stays independent", async () => {
  const f = await createFixture();
  f.workspace.set("literature/a.pdf", "EctD evidence");
  const observed = [];
  const generate = f.system.preparation.generatePaperCard;
  f.system.preparation.generatePaperCard = payload => { observed.push(["paper", payload.callContext.model]); return generate(payload); };
  f.literature.api.interpretSemantics = async payload => { observed.push(["semantic", payload.callContext.model]); return semantic.interpretLocal(payload); };
  const service = new ProjectContextService({ workspace: f.workspace, literature: f.literature, sourceSystem: f.system, requestPipeline: f.pipeline });
  await service.buildContext({ surface: "side_chat", turnId: "chat", question: "Hello", selectedPaths: [], selectedPaperIds: [], callContext: { model: nemotron } });
  await service.buildContext({ surface: "agent_command", turnId: "agent", question: "Hello", selectedPaths: [], selectedPaperIds: [] });
  assert.deepEqual(observed, [["paper", nemotron], ["semantic", nemotron], ["semantic", undefined]]);
});

test("concurrent maintenance with different selections is serialized and retries use the waiting request's model", async () => {
  let release, started;
  const barrier = new Promise(resolve => { release = resolve; });
  const entered = new Promise(resolve => { started = resolve; });
  const f = await createFixture();
  f.workspace.set("literature/a.pdf", "EctD evidence");
  const observed = [];
  const generate = f.system.preparation.generatePaperCard;
  f.system.preparation.generatePaperCard = async payload => {
    observed.push(payload.callContext.model);
    if (observed.length === 1) { started(); await barrier; throw new Error("First provider failed"); }
    return generate(payload);
  };
  const first = f.pipeline.preflight({ turnId: "first", callContext: { model: nemotron } });
  await entered;
  const second = f.pipeline.preflight({ turnId: "second", surface: "agent_command" });
  assert.equal(observed.length, 1);
  release();
  const results = await Promise.all([first, second]);
  assert.deepEqual(observed, [nemotron, undefined]);
  assert.equal(results[0].report.status, "partial");
  assert.equal(results[1].report.status, "completed");
  assert.equal(f.workspace.scans, 2);
});

test("corpus worker retries and fallback adapters inherit the caller model", async () => {
  const calls = [];
  const literature = new LiteratureModule({ workspace: {}, api: { mapCorpusPaper: async payload => { calls.push(payload.callContext.model); throw Object.assign(new Error("Unavailable"), { code: "LlmHttpError" }); } } });
  const workflows = literature.corpusWorkflows;
  await assert.rejects(workflows.executeMapWorker({ paperId: "p1", question: "Evidence?", evidence: [] }, { callContext: { model: nemotron }, qualityMode: "fast", profile: "medium" }));
  assert.ok(calls.length >= 2);
  assert.ok(calls.every(model => model === nemotron));
});

test("a selected model's learned input quota cannot reject another model's paper request", async () => {
  let now = 0;
  const seen = [];
  const client = new LiteratureApiClient({ baseUrl: "", now: () => now, wait: async ms => { now += ms; }, fetch: async (_url, options) => {
    const model = options.headers["X-BioDesign-Chat-Model"];
    seen.push(model);
    if (model === "default") return new Response(JSON.stringify({ ok: false, error: "LlmHttpError", message: "Requesty returned HTTP 429: Quota exceeded for metric: generativelanguage.googleapis.com/generate_content_paid_tier_3_input_token_count, limit: 16000, model: gemma-4-31b. Please retry in 1s." }), { status: 502 });
    return new Response(JSON.stringify({ ok: true }));
  } });
  const body = { text: "x".repeat(75000), callContext: { model: "default" } };
  await assert.rejects(client.request("/api/literature/create-paper-card-from-text", body), error => error.verifiedInputTokenRateLimit);
  assert.ok(client.inputQuotaCharacterBudget({ model: "default" }) > 0);
  assert.equal(client.inputQuotaCharacterBudget({ model: nemotron }), 0);
  assert.equal(client.inputQuotaCharacterBudget(), 0);
  await client.request("/api/literature/create-paper-card-from-text", { ...body, callContext: { model: nemotron } });
  assert.deepEqual(seen, ["default", nemotron]);
});

test("one model's semantic capability cooldown does not suppress another model's interpretation", async () => {
  const seen = [];
  const client = new LiteratureApiClient({ baseUrl: "", fetch: async (_url, options) => {
    const model = options.headers["X-BioDesign-Chat-Model"];
    seen.push(model);
    return model === nemotron
      ? new Response(JSON.stringify({ ok: false, error: "SemanticParserUnavailable", capabilityUnavailable: true, fallbackReason: "structured_output_unsupported" }), { status: 502 })
      : new Response(JSON.stringify({ ok: true, ir: { goal: "EctD evidence" } }));
  } });
  const payload = { query: "Find EctD evidence", callContext: { model: nemotron } };
  await assert.rejects(client.interpretSemantics(payload));
  await assert.rejects(client.interpretSemantics(payload), error => error.semanticParserAttempted === false);
  await client.interpretSemantics({ ...payload, callContext: { model: "default" } });
  assert.deepEqual(seen, [nemotron, "default"]);
});

test("concurrent FC calls keep the requested models even while another surface uses dedicated roles", async () => {
  providerRequests.length = 0;
  await Promise.allSettled([nemotron, undefined, "default", nemotron].map(model =>
    api.planKnowledgeSearch({ query: "EctD", intent: "evidence", callContext: { model } })));
  assert.deepEqual(providerRequests.map(request => request.model).sort(), [nemotron, nemotron, process.env.REQUESTY_MODEL, process.env.REQUESTY_SEARCH_PLANNER_MODEL].sort());
});
