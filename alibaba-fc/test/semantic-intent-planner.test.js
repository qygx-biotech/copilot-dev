"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), os = require("node:os"), path = require("node:path"), jwt = require("jsonwebtoken");
const semantic = require("../../shared/semantic-intent.js");
const planner = require("../semantic-intent-planner.js");
const gemini = "google/gemini-3.1-flash-lite:flex";
process.env.ADMIN_ACCOUNT = "semantic-adapter-fixture";
process.env.JWT_SECRET = "semantic-adapter-jwt";
process.env.REQUESTY_API_KEY = "semantic-adapter-secret-key";
process.env.REQUESTY_MODEL = gemini;
process.env.REQUESTY_SEMANTIC_PARSER_MODEL = gemini;
const backend = require("../index.js");
const token = jwt.sign({ account: process.env.ADMIN_ACCOUNT, role: "admin" }, process.env.JWT_SECRET);
const requests = [], replies = [], logs = [];
global.fetch = async (url, options) => {
  assert.equal(url, "https://router.requesty.ai/v1/chat/completions");
  requests.push(JSON.parse(options.body));
  const reply = replies.shift();
  if (reply instanceof Error) throw reply;
  if (reply instanceof Response) return reply;
  return new Response(JSON.stringify({ choices: [{ message: { content: typeof reply === "string" ? reply : JSON.stringify(reply) }, finish_reason: "stop" }],
    usage: { prompt_tokens: 12, completion_tokens: 30, total_tokens: 42 } }), { status: 200 });
};
const chinese = "帮我检索AI和合成生物学的文献并下载。";
const english = "Search for papers about AI and synthetic biology and download them.";
const failure = (status, error) => new Response(JSON.stringify({ error }), { status });
const incompatible = () => failure(400, { code: 400, status: "INVALID_ARGUMENT", message: "Request contains an invalid argument.",
  details: [{ fieldViolations: [{ field: "generation_config.response_schema", description: "Unsupported schema" }] }] });
function input(query = chinese, overrides = {}) {
  return { query, profile: "medium", conversationContext: [], paperCandidates: [], projectSemanticRegistry: { metrics: [] },
    activeScope: { topic: "检索AI和合成生物结合的文献，帮我下载。", projectId: "fixture-project", paperIds: [], experimentSourceIds: [] },
    callContext: { turnId: "semantic-adapter-turn", profile: "medium", callRole: "semantic_parser" }, ...overrides };
}
function ir(query = chinese, overrides = {}) {
  return { ...semantic.interpretLocal(input(query)), retrievalScope: "web", matchedPattern: null, patternConfidence: 0.8,
    goal: "Search for papers about AI and synthetic biology and download the relevant sources.",
    operations: ["search", "store"], objects: ["literature"], scope: { papers: null, experiments: null },
    capabilityHints: ["search_papers", "download_sources"], unresolvedSlots: [], ...overrides };
}
async function invoke(body = input(), headers = {}) {
  const result = await backend.handler({ httpMethod: "POST", path: "/api/semantic/interpret", headers: { Authorization: `Bearer ${token}`, ...headers },
    body: JSON.stringify(body) }, { requestId: "semantic-adapter-operation" });
  return { status: result.statusCode, body: JSON.parse(result.body) };
}
test.beforeEach(t => {
  requests.length = replies.length = logs.length = 0;
  delete process.env.REQUESTY_SEMANTIC_PLANNER_PROFILE;
  delete process.env.REQUESTY_SEMANTIC_OPENAI_MODEL;
  delete process.env.REQUESTY_SEMANTIC_GEMINI_MODEL;
  process.env.REQUESTY_MODEL_CAPABILITIES_JSON = "{}";
  process.env.REQUESTY_API_KEY = "semantic-adapter-secret-key";
  t.mock.method(console, "info", (event, data) => { if (String(event).startsWith("semantic-intent.")) logs.push({ event, ...data }); });
});

test("Chinese and English paper search/download requests use the same strict planner and preserve semantic intent", async () => {
  const results = [];
  for (const query of [chinese, english]) {
    replies.push(ir(query));
    const result = await invoke(input(query));
    assert.equal(result.status, 200);
    assert.deepEqual(result.body.ir, semantic.validateSemanticIR(result.body.ir, input(query)));
    assert.equal(result.body.structuredOutputMode, "json_schema");
    assert.equal(result.body.structuredOutputFallback, false);
    assert.equal(result.body.ir.retrievalScope, "web");
    assert.equal(result.body.attempts, 1);
    results.push(result.body.ir);
  }
  assert.equal(requests.length, 2);
  assert.deepEqual(results[0].operations, ["search", "store"]);
  for (const key of ["operations", "objects", "goal", "scope", "capabilityHints"]) assert.deepEqual(results[0][key], results[1][key]);
  assert.equal(results[0].answerLanguage, "zh");
  assert.equal(results[1].answerLanguage, "en");
  assert.equal(requests[0].messages[0].content, requests[1].messages[0].content);
  assert.ok(requests.every(request => request.model === gemini && request.requesty.extra.profile === "medium"));
  const { callContext, ...payload } = input();
  assert.equal(requests[0].messages[1].content, JSON.stringify(payload));
  assert.deepEqual(JSON.parse(requests[0].messages[1].content), payload);
  assert.ok(!logs.some(log => log.event.endsWith("structured-output-fallback")));
  fs.writeFileSync(path.join(os.tmpdir(), "biodesign-semantic-requesty-gemini.json"), JSON.stringify(requests[0], null, 2));
});

test("reported Gemini composition keeps web scope through FC validation and desktop interpretation", async () => {
  const reported = require("./helpers/reported-search-download-ir.js");
  assert.throws(() => semantic.validateSemanticIR(reported.ir), /narrow pattern/);
  replies.push(reported.ir);
  const response = await invoke(input(reported.query));
  assert.equal(response.status, 200);
  assert.equal(response.body.ir.matchedPattern, null);
  assert.deepEqual(response.body.ir.objects, ["literature"]);
  for (const key of Object.keys(reported.ir).filter(key => !["matchedPattern", "objects"].includes(key))) {
    assert.deepEqual(response.body.ir[key], reported.ir[key], key);
  }
  // Both a normalized FC response and a raw result from an older FC deployment
  // must pass the same client boundary without another model request.
  for (const raw of [response.body.ir, reported.ir]) {
    const result = await new semantic.SemanticInterpreter({ remoteParser: async () => raw }).interpret(input(reported.query));
    assert.equal(result.telemetry.semantic.route, "remote");
    assert.equal(result.ir.retrievalScope, "web");
    assert.deepEqual(result.ir.operations, ["search", "store"]);
    assert.deepEqual(result.ir.capabilityHints, ["search_papers", "download_sources"]);
  }
  assert.equal(requests.length, 1);
});

test("model shortcut normalization never repairs unsafe or invalid semantic fields", () => {
  const reported = require("./helpers/reported-search-download-ir.js");
  for (const change of [
    { retrievalScope: "internet" }, { retrievalScope: undefined }, { operations: ["run_shell"] },
    { permissions: "full" }, { patternConfidence: 2 }, { matchedPattern: "invented.pattern" },
    { goal: "x".repeat(4001) }, { capabilityHints: ["web_search"] },
    { scope: { papers: ["outside-selection"], experiments: null } },
  ]) assert.throws(() => semantic.normalizeModelSemanticIR({ ...reported.ir, ...change }, { activeScope: { paperIds: ["selected"] } }));
  assert.throws(() => semantic.normalizeModelSemanticIR(reported.ir, { query: "Find EctD papers" }), /protected identifier/);
  const normalized = semantic.normalizeModelSemanticIR(reported.ir);
  assert.deepEqual(semantic.validateSemanticIR(normalized), normalized);
  assert.equal(reported.ir.matchedPattern, "literature.search", "Input is not mutated");
});

test("the exact transmitted schema uses a small closed-object subset while retaining all canonical IR fields", async () => {
  replies.push(ir()); await invoke();
  const format = requests[0].response_format;
  assert.equal(format.type, "json_schema"); assert.equal(format.json_schema.name, "semantic_intent_ir"); assert.equal(format.json_schema.strict, true);
  const schema = format.json_schema.schema;
  assert.deepEqual(schema, planner.SEMANTIC_INTENT_LLM_SCHEMA);
  assert.deepEqual(Object.keys(schema.properties), Object.keys(semantic.SEMANTIC_IR_SCHEMA.properties));
  const allowed = new Set(["type", "properties", "required", "additionalProperties", "items", "enum", "anyOf"]);
  function inspect(node) {
    for (const key of Object.keys(node)) assert.ok(allowed.has(key), key);
    if (node.type === "object") {
      assert.equal(node.additionalProperties, false);
      assert.deepEqual(node.required, Object.keys(node.properties));
      Object.values(node.properties).forEach(inspect);
    }
    if (node.items) inspect(node.items);
    if (node.anyOf) node.anyOf.forEach(inspect);
  }
  inspect(schema);
  assert.deepEqual(schema.properties.requestedOutput.properties.limit.type, ["integer", "null"]);
  assert.equal(semantic.SEMANTIC_IR_SCHEMA.properties.goal.maxLength, 4000, "Canonical internal validation remains unchanged");
});

test("planner instructions preserve the full multi-step goal while assigning only evidence retrieval scope", async () => {
  const query = "Research current EctD work, compare it with my project papers, and write a comparison report.";
  const operations = ["search", "compare", "summarize", "store"];
  replies.push(ir(query, { goal: query, retrievalScope: "both", operations, capabilityHints: [] }));
  const result = await invoke(input(query));
  assert.equal(result.status, 200);
  assert.equal(result.body.promptVersion, 7);
  assert.equal(result.body.ir.goal, query);
  assert.deepEqual(result.body.ir.operations, operations);
  const request = requests[0], system = request.messages[0].content;
  assert.match(system, /Preserve the complete user goal and every requested operation/);
  assert.match(system, /selecting research does not replace or complete the other requested work/);
  assert.match(system, /meaning of the current request, its evidence requirements, and the available context/);
  assert.match(system, /Language, isolated keywords, tool availability.*do not determine scope/);
  assert.match(system, /verification outside the supplied context/);
  assert.match(system, /existing project actions do not by themselves require web search/);
  assert.match(system, /already supplied URL.*does not necessarily require URL discovery/);
  assert.match(system, /Do not answer, execute research, or perform actions during planning/);
  assert.equal(JSON.parse(request.messages[1].content).query, query);
  assert.equal(request.tools, undefined);
  assert.deepEqual(request.response_format.json_schema.schema, planner.SEMANTIC_INTENT_LLM_SCHEMA);
});

test("a targeted Gemini schema rejection performs exactly one json_object fallback through the same validator", async () => {
  replies.push(incompatible(), ir());
  const result = await invoke();
  assert.equal(result.status, 200); assert.equal(requests.length, 2); assert.equal(result.body.attempts, 2);
  assert.equal(requests[0].response_format.type, "json_schema");
  assert.deepEqual(requests[1].response_format, { type: "json_object" });
  assert.equal(result.body.structuredOutputMode, "json_object"); assert.equal(result.body.structuredOutputFallback, true);
  assert.deepEqual(result.body.ir.operations, ["search", "store"]);
  assert.equal(requests[0].messages[1].content, requests[1].messages[1].content);
  const commonPrompt = requests[0].messages[0].content.split("\n").slice(0, -1).join("\n");
  assert.ok(requests[1].messages[0].content.startsWith(commonPrompt));
  assert.match(requests[1].messages[0].content, /Do not return Markdown, code fences, explanatory text/);
  assert.deepEqual(logs.map(log => log.event), ["semantic-intent.request", "semantic-intent.structured-output-fallback", "semantic-intent.request", "semantic-intent.success"]);
  const log = logs[1];
  assert.equal(log.provider, "google"); assert.equal(log.model, gemini); assert.equal(log.status, 400); assert.equal(log.code, "invalid_argument");
  assert.equal(log.turnId, "semantic-adapter-turn"); assert.equal(log.operationId, "semantic-adapter-operation");
  assert.equal(log.fallbackMode, "json_object"); assert.equal(log.fallbackOccurred, true); assert.ok(log.durationMs >= 0);
  assert.doesNotMatch(JSON.stringify(logs), /semantic-adapter-secret-key|帮我检索|conversationContext|system|Unsupported schema/);
});

test("authentication, permission, rate limits, generic invalid arguments, and application errors never select json_object", async () => {
  for (const [status, error] of [
    [401, { message: "Unauthorized" }], [403, { message: "Permission denied for response_format" }],
    [404, { message: "Model not found" }], [429, { message: "Rate limit exceeded", code: "rate_limit_exceeded" }],
    [400, { status: "INVALID_ARGUMENT", message: "Request contains an invalid argument." }],
    [400, { param: "messages", message: "Invalid messages for json_schema" }],
    [400, { code: "model_not_found", message: "Model does not support the configured response_format" }],
  ]) {
    requests.length = 0; replies.push(failure(status, error));
    const result = await invoke();
    assert.equal(result.status, 502); assert.equal(requests.length, 1, JSON.stringify(error));
    assert.equal(requests[0].response_format.type, "json_schema"); assert.equal(result.body.attempts, 1);
    assert.equal(result.body.ir, undefined);
  }
  assert.ok(!logs.some(log => log.event.endsWith("structured-output-fallback")));
  assert.ok(logs.some(log => log.event === "semantic-intent.request-failed" && log.status === 429));
});

test("network and unrelated server failures retain transport retries in the original format", async () => {
  for (const kind of ["network", "server"]) {
    requests.length = 0;
    for (let i = 0; i < 2; i++) replies.push(kind === "network" ? new Error("Private network diagnostics") : failure(500, { message: "Upstream server unavailable" }));
    const result = await invoke();
    assert.equal(result.status, 502); assert.equal(requests.length, 2); assert.equal(result.body.attempts, 2);
    assert.ok(requests.every(request => request.response_format.type === "json_schema"));
  }
  assert.ok(!logs.some(log => log.event.endsWith("structured-output-fallback")));
  assert.doesNotMatch(JSON.stringify(logs), /Private network diagnostics/);
});

test("invalid json_object output fails internal validation without fabricated IR or another retry", async () => {
  for (const output of ["```json\n{}\n```", "null", "[]", { ...ir(), permissions: ["all"] }, {}, ir(chinese, { patternConfidence: 1.5 }), ir(chinese, { goal: "x".repeat(4001) })]) {
    requests.length = 0;
    replies.push(incompatible(), output);
    const result = await invoke();
    assert.equal(result.status, 502); assert.equal(result.body.error, "InvalidStructuredOutput");
    assert.equal(result.body.ir, undefined); assert.equal(result.body.attempts, 2); assert.equal(requests.length, 2);
    assert.equal(logs.at(-1).event, "semantic-intent.validation-failed");
  }
});

test("both output modes retain internal scope, identifier, and scalar-value validation", async () => {
  const query = "Find EctD papers and download them.";
  const payload = input(query, { activeScope: { paperIds: ["paper-a"] } });
  for (const fallback of [false, true]) {
    requests.length = 0;
    if (fallback) replies.push(incompatible());
    replies.push(ir(query, { scope: { papers: ["paper-a"], experiments: null }, filters: [null, true, 1.25, "text", ["x", "y"]].map(value => ({ field: "fixture", operator: "=", value, unit: null })) }));
    assert.equal((await invoke(payload)).status, 200);
    assert.equal(requests.length, fallback ? 2 : 1);
    for (const output of [ir(query, { scope: { papers: ["paper-b"], experiments: null } }), ir(query, { entities: [] })]) {
      if (fallback) replies.push(incompatible());
      replies.push(output);
      const result = await invoke(payload);
      assert.equal(result.status, 502); assert.equal(result.body.error, "InvalidStructuredOutput");
    }
  }
});

test("a failed json_object retry stops, and models without advertised json_object never attempt it", async () => {
  replies.push(incompatible(), incompatible());
  assert.equal((await invoke()).status, 502); assert.equal(requests.length, 2);
  requests.length = 0;
  process.env.REQUESTY_MODEL_CAPABILITIES_JSON = JSON.stringify({ [gemini]: { jsonObject: false } });
  replies.push(incompatible());
  const result = await invoke();
  assert.equal(result.status, 502); assert.equal(requests.length, 1);
  assert.equal(result.body.fallbackReason, "provider_schema_incompatible");
});

test("an explicitly configured JSON-object-only profile still requires valid canonical IR", async () => {
  process.env.REQUESTY_MODEL_CAPABILITIES_JSON = JSON.stringify({ [gemini]: { jsonSchema: false, jsonObject: true } });
  replies.push(ir());
  const result = await invoke();
  assert.equal(result.status, 200); assert.equal(requests.length, 1);
  assert.equal(result.body.structuredOutputMode, "json_object"); assert.equal(result.body.structuredOutputFallback, false);
});

test("OpenAI and Gemini profiles use the same prompt, payload, schema, validator, and Chat Completions adapter", async () => {
  process.env.REQUESTY_SEMANTIC_PLANNER_PROFILE = "gemini";
  replies.push(ir()); const google = await invoke();
  process.env.REQUESTY_SEMANTIC_PLANNER_PROFILE = "openai";
  process.env.REQUESTY_SEMANTIC_OPENAI_MODEL = "openai/mock-semantic-model";
  replies.push(ir()); const openai = await invoke();
  assert.equal(google.status, 200); assert.equal(openai.status, 200);
  assert.deepEqual(google.body.ir, openai.body.ir);
  assert.equal(requests[0].model, gemini); assert.equal(requests[1].model, "openai/mock-semantic-model");
  assert.deepEqual(requests[0].messages, requests[1].messages);
  assert.deepEqual(requests[0].response_format, requests[1].response_format);
  assert.notEqual(google.body.configurationSignature, openai.body.configurationSignature);
  replies.push(ir()); const explicit = await invoke(input(), { "X-BioDesign-Chat-Model": gemini });
  assert.equal(explicit.status, 200); assert.equal(requests.at(-1).model, gemini);
  replies.push(ir()); const defaultSelection = await invoke(input(), { "X-BioDesign-Chat-Model": "default" });
  assert.equal(defaultSelection.status, 200); assert.equal(requests.at(-1).model, "openai/mock-semantic-model");
  assert.equal(process.env.REQUESTY_SEMANTIC_PARSER_MODEL, gemini);
});

test("invalid application input and missing/disabled profiles fail before provider execution", async () => {
  assert.equal((await invoke(input(chinese, { unexpected: "field" }))).status, 400);
  for (const profile of ["openai", "unknown-profile"]) {
    process.env.REQUESTY_SEMANTIC_PLANNER_PROFILE = profile;
    const result = await invoke();
    assert.equal(result.status, 502); assert.equal(result.body.fallbackReason, "missing_model_configuration");
  }
  delete process.env.REQUESTY_SEMANTIC_PLANNER_PROFILE;
  delete process.env.REQUESTY_API_KEY;
  assert.equal((await invoke()).body.fallbackReason, "missing_model_configuration");
  assert.equal(requests.length, 0);
});

test("compatibility classification accepts only schema-targeted client errors and discards raw metadata", () => {
  for (const error of [
    { code: "invalid_json_schema", message: "Invalid" },
    { message: "json_schema is not supported for this model" },
    { param: "response_format", status: "INVALID_ARGUMENT", message: "Request contains an invalid argument." },
  ]) assert.equal(planner.structuredOutputErrorDetails(400, JSON.stringify({ error })).structuredOutputCompatibility, true);
  for (const error of [
    { message: "Request contains an invalid argument.", status: "INVALID_ARGUMENT" },
    { code: "invalid_json_schema", param: "messages.0.content" },
    { code: "schema_validation_error", message: "Invalid request body" },
    { message: "Invalid json_schema: API key missing" },
    { code: "invalid_configuration", message: "Requesty router configuration: invalid response_format" },
    { details: [null, { fieldViolations: {} }] },
  ]) assert.equal(planner.structuredOutputErrorDetails(400, JSON.stringify({ error })).structuredOutputCompatibility, false);
  for (const status of [401, 403, 404, 429, 500, 503]) assert.deepEqual(planner.structuredOutputErrorDetails(status, "Invalid response_format schema"), {});
  const classified = { error: "LlmHttpError", status: 422, ...planner.structuredOutputErrorDetails(422, JSON.stringify({ error: { param: "response_format", message: "Invalid" } })) };
  assert.equal(planner.isStructuredOutputCompatibilityError(classified), true);
  for (const field of ["rateLimit", "verifiedContextLengthError", "terminalProviderFailure"]) {
    assert.equal(planner.isStructuredOutputCompatibilityError({ ...classified, [field]: true }), false);
  }
});

test("both semantic output modes reject absent or invalid retrieval scope without guessing external intent", async () => {
  const { retrievalScope, ...missingScope } = ir();
  for (const fallback of [false, true]) {
    for (const output of [missingScope, { ...ir(), retrievalScope: "internet" }, { ...ir(), retrievalScope: null }]) {
      requests.length = 0;
      if (fallback) replies.push(incompatible());
      replies.push(output);
      const result = await invoke();
      assert.equal(result.status, 502); assert.equal(result.body.error, "InvalidStructuredOutput");
      assert.equal(requests.length, fallback ? 2 : 1);
      assert.equal(result.body.ir, undefined);
    }
  }
});
