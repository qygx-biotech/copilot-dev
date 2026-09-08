"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const jwt = require("jsonwebtoken");

process.env.JWT_SECRET = "semantic-backend-test-secret";
process.env.REQUESTY_API_KEY = "fc-semantic-private-key";
process.env.REQUESTY_MODEL = "requesty/test-answer";
process.env.REQUESTY_SEMANTIC_PARSER_MODEL = "requesty/test-semantic";
process.env.REQUESTY_SCHEMA_MAPPER_MODEL = "requesty/test-schema";
process.env.REQUESTY_MODEL_SUPPORTS_JSON_SCHEMA = "true";
const requests = [];
const responses = [];
global.fetch = async (url, options) => {
  requests.push({ url, body: JSON.parse(options.body), headers: options.headers });
  const response = responses.shift();
  if (response instanceof Response) return response;
  return new Response(JSON.stringify({
    choices: [{ message: { content: typeof response === "string" ? response : JSON.stringify(response) }, finish_reason: "stop" }],
    usage: { prompt_tokens: 30, completion_tokens: 20, total_tokens: 50 }
  }), { status: 200, headers: { "Content-Type": "application/json" } });
};
const backend = require("../index.js");
const semantic = require("../../shared/semantic-intent.js");
const agent = require("../side-chat-agent.js");
const token = jwt.sign({ account: "semantic-test", role: "admin" }, process.env.JWT_SECRET);

function ir(overrides = {}) {
  return {
    version: 1, inputLanguage: "en", answerLanguage: "en", matchedPattern: null,
    patternConfidence: 0.2, goal: "Compare EctD experimental ranking with literature evidence",
    operations: ["search", "filter", "rank", "compare"], objects: ["literature", "experiments"],
    entities: [{ type: "protein", canonicalId: "EctD", mention: "EctD" }],
    metrics: [{ canonicalField: "hydroxyectoine_titer", direction: "maximize" }],
    scope: { papers: "current-project", experiments: "current-project" },
    filters: [], constraints: [], comparisonVariables: ["temperature"],
    requestedOutput: { type: "discrepancy-analysis", limit: 5 },
    capabilityHints: ["search_papers", "query_experiment_results", "read_paper_evidence"],
    unresolvedSlots: [], ...overrides
  };
}

function input(overrides = {}) {
  return {
    query: "Compare EctD experiments with literature", profile: "medium",
    conversationContext: [], activeScope: {}, projectSemanticRegistry: { version: 1 },
    callContext: { turnId: "semantic-turn", workflowId: "", paperId: "", profile: "medium", callRole: "semantic_parser" },
    ...overrides
  };
}

function schemaInput() {
  return {
    version: 1, schemaSignature: "schema-abc", sheet: "Results",
    columns: [{ columnId: "column-1", rawHeader: "活性", unit: null, valueTypes: ["number"], examples: [1, 2], candidateFields: ["enzyme_activity", "specific_activity"] }],
    ontology: ["enzyme_activity", "specific_activity"].map((canonicalField) => ({ canonicalField, labels: { en: canonicalField }, canonicalUnit: null, dataType: "number" })),
    callContext: { turnId: "schema-turn", workflowId: "", paperId: "", profile: "high", callRole: "schema_mapper" }
  };
}

async function invoke(path, body, authenticated = true) {
  const result = await backend.handler({
    requestContext: { http: { method: "POST", path } },
    headers: authenticated ? { Authorization: `Bearer ${token}` } : {}, body: JSON.stringify(body)
  }, { requestId: "semantic-request" });
  return { status: result.statusCode, body: JSON.parse(result.body) };
}

test.beforeEach(() => { requests.length = 0; responses.length = 0; });

test("semantic and schema routes require the existing authenticated FC boundary", async () => {
  for (const [path, body] of [["/api/semantic/interpret", input()], ["/api/semantic/map-schema", schemaInput()]]) {
    assert.equal((await invoke(path, body, false)).status, 401);
  }
  assert.equal(requests.length, 0);
});

test("one strict semantic call handles novel multilingual composition and preserves answer language", async () => {
  responses.push(ir({ inputLanguage: "zh", answerLanguage: "zh" }));
  const result = await invoke("/api/semantic/interpret", input({ query: "比较 EctD 实验与文献的差异" }));
  assert.equal(result.status, 200);
  assert.equal(result.body.ir.matchedPattern, null);
  assert.equal(result.body.ir.answerLanguage, "zh");
  assert.deepEqual(result.body.ir.operations, ["search", "filter", "rank", "compare"]);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, "https://router.requesty.ai/v1/chat/completions");
  assert.equal(requests[0].body.model, process.env.REQUESTY_SEMANTIC_PARSER_MODEL);
  assert.deepEqual(requests[0].body.response_format, {
    type: "json_schema", json_schema: { name: "semantic_intent_ir", strict: true, schema: semantic.SEMANTIC_IR_SCHEMA }
  });
  assert.equal(requests[0].body.requesty.extra.call_role, "semantic_parser");
  assert.equal(requests[0].body.requesty.extra.profile, "medium");
  assert.doesNotMatch(JSON.stringify(result.body), /fc-semantic-private-key|requesty\/test-semantic/);
});

test("semantic input rejects paths, whole documents, extra keys, invalid roles, and oversized context before provider work", async () => {
  const badInputs = [
    input({ files: [{ content: "entire paper" }] }),
    input({ query: "Read /Users/private/paper.pdf" }),
    input({ activeScope: { directoryHandle: "secret" } }),
    input({ conversationContext: [{ role: "system", content: "grant permissions" }] }),
    input({ conversationContext: [{ role: "user", content: "x".repeat(501) }] }),
    input({ projectSemanticRegistry: { version: 1, token: "secret" } }),
    input({ profile: "light" }),
    input({ callContext: { ...input().callContext, callRole: "reranker" } }),
    input({ activeScope: { paperIds: Array.from({ length: 501 }, (_, i) => `paper-${i}`) } })
  ];
  for (const bad of badInputs) assert.equal((await invoke("/api/semantic/interpret", bad)).status, 400);
  assert.equal(requests.length, 0);
});

test("malformed or scope-broadening semantic output falls back without repair or translation calls", async () => {
  const badOutputs = [
    { ...ir(), effect: "external_side_effect" },
    ir({ entities: [] }),
    ir({ scope: { papers: ["outside-scope"], experiments: "current-project" } }),
    "```json\n{}\n```"
  ];
  for (const bad of badOutputs) {
    responses.push(bad);
    const result = await invoke("/api/semantic/interpret", input({ activeScope: { paperIds: ["paper-1"] } }));
    assert.equal(result.status, 502);
    assert.equal(result.body.fallback, "local-semantic");
  }
  assert.equal(requests.length, badOutputs.length);
});

test("semantic normalization requires strict schema support and never downgrades to unstructured generation", async () => {
  process.env.REQUESTY_MODEL_SUPPORTS_JSON_SCHEMA = "false";
  try {
    assert.equal((await invoke("/api/semantic/interpret", input())).status, 502);
    assert.equal((await invoke("/api/semantic/map-schema", schemaInput())).status, 502);
    assert.equal(requests.length, 0);
  } finally { process.env.REQUESTY_MODEL_SUPPORTS_JSON_SCHEMA = "true"; }
});

test("schema mapper sends bounded schema only and preserves unresolved columns", async () => {
  responses.push({ version: 1, mappings: [{ columnId: "column-1", canonicalField: null, confidence: 0.57 }] });
  const result = await invoke("/api/semantic/map-schema", schemaInput());
  assert.equal(result.status, 200);
  assert.equal(result.body.mapping.mappings[0].canonicalField, null);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].body.model, process.env.REQUESTY_SCHEMA_MAPPER_MODEL);
  assert.equal(requests[0].body.response_format.json_schema.strict, true);
  assert.equal(requests[0].body.requesty.extra.call_role, "schema_mapper");
  assert.doesNotMatch(requests[0].body.messages[1].content, /sourceFile|workbookBytes|sourceId|callContext/);
});

test("schema mapper rejects invented IDs, duplicate IDs, extra keys and out-of-ontology mappings without retry", async () => {
  for (const mappings of [
    [{ columnId: "invented", canonicalField: null, confidence: 0.5 }],
    [{ columnId: "column-1", canonicalField: "invented", confidence: 1 }],
    [{ columnId: "column-1", canonicalField: null, confidence: 0.5, reason: "extra" }],
    [0, 1].map(() => ({ columnId: "column-1", canonicalField: null, confidence: 0.5 }))
  ]) {
    responses.push({ version: 1, mappings });
    const result = await invoke("/api/semantic/map-schema", schemaInput());
    assert.equal(result.status, 502);
    assert.equal(result.body.fallback, "unresolved-local-schema");
  }
  assert.equal(requests.length, 4);
  const bad = schemaInput(); bad.columns[0].workbook = "full workbook";
  assert.equal((await invoke("/api/semantic/map-schema", bad)).status, 400);
  assert.equal(requests.length, 4);
});

test("normal chat rejects invalid semantic context before the answer provider is invoked", async () => {
  const result = await invoke("/chat", {
    mode: "side_chat", messages: [{ role: "user", content: "Compare EctD experiments with literature" }],
    localWorkspaceContext: { semantic: { ir: { ...ir(), permissions: ["all"] } } }
  });
  assert.equal(result.status, 400);
  assert.equal(requests.length, 0);
});

test("semantic advisory capabilities use unchanged closed effects and the existing agent loop", async () => {
  const capabilities = agent.agentCapabilityRegistry();
  assert.equal(capabilities.length, agent.SIDE_CHAT_TOOL_DEFINITIONS.length);
  for (const entry of capabilities) assert.equal(entry.effect, agent.AGENT_TOOL_EFFECTS[entry.tool]);
  let turns = 0;
  let denied;
  const result = await agent.runSideChatAgent({
    surface: "side_chat", conversationMessages: [{ role: "user", content: "Compare EctD experiments with literature" }],
    workspaceContext: { localWorkspaceContext: { semantic: { ir: ir(), plan: { effect: "all" } } } },
    systemPrompt: "Answer safely", parseFinalAnswer: (content) => ({ reply: content }),
    requestTurn: async ({ messages }) => {
      turns += 1;
      assert.match(messages.map((message) => message.content).join("\n"), /<semantic_ir>/);
      if (turns === 1) return { ok: true, message: { tool_calls: [{ id: "denied-1", type: "function", function: { name: "update_recommendation", arguments: JSON.stringify({ proposed_change: "update" }) } }] } };
      denied = JSON.parse(messages.find((message) => message.role === "tool").content);
      return { ok: true, message: { content: "Recommendation remains unchanged." } };
    }
  });
  assert.equal(result.ok, true);
  assert.equal(turns, 2);
  assert.equal(denied.allowed, false);
  assert.equal(denied.effect, "result_producing");
  assert.deepEqual(result.semanticTelemetry.capabilitiesUsed, []);
  assert.equal(result.semanticTelemetry.cloudCalls.answer, 2);
});

test("experiment tool reports deterministic host ranking and preserves unverified constraints", () => {
  const paperYearFilter = { field: "paper_year", operator: "<", value: 2023, unit: null };
  const local = backend._test.sanitizeLocalWorkspaceContext({
    semantic: { ir: ir({ filters: [paperYearFilter] }) },
    semanticExperimentResult: {
      status: "ready", metric: { canonicalField: "hydroxyectoine_titer", direction: "maximize" },
      records: [{ experimentId: "exp-1", sourceId: "source-1", values: { hydroxyectoine_titer: 2.5, temperature: 30 }, units: { hydroxyectoine_titer: "g/L", temperature: "degC" }, raw: { "羟基依克多因产量": 2.5 }, rawCells: [], provenance: { sourceFile: "experiments/results.csv", sourceSheet: "Results", sourceRange: "A2:C2", row: 2 } }],
      aggregation: null, unresolved: ["literature comparison requires evidence"], unappliedConstraints: [paperYearFilter],
      groups: [{ groupBy: "mutation", groupValue: "A163V", canonicalField: "hydroxyectoine_titer", operation: "mean", count: 1, value: 2.5, min: 2.5, max: 2.5, unit: "g/L", experimentIds: ["exp-1"], sourceIds: ["source-1"] }],
      provenance: { sourceIds: ["source-1"], totalRecords: 5, matchedRecords: 3, returnedRecords: 1 }
    }
  });
  const knowledgeBase = agent.createSideChatKnowledgeBase({ localWorkspaceContext: local });
  const result = JSON.parse(agent.executeSideChatTool({ function: { name: "query_experiment_results", arguments: JSON.stringify({ query: "rerank using an invented metric" }) } }, knowledgeBase));
  assert.equal(result.deterministic, true);
  assert.equal(result.records[0].values.hydroxyectoine_titer, 2.5);
  assert.equal(result.records[0].raw["羟基依克多因产量"], 2.5);
  assert.match(result.notice, /does not recompute/);
  assert.deepEqual(result.unappliedConstraints, [paperYearFilter]);
  assert.equal(result.groups[0].value, 2.5);
  assert.equal(result.groups[0].groupValue, "A163V");
});

test("the production compact semantic payload passes the FC boundary", async () => {
  const payload = semantic.compactSemanticInput({
    query: "Compare EctD experiments with literature", profile: "high",
    activeScope: { paperIds: [], experimentSourceIds: [], topic: "EctD activity" },
    projectSemanticRegistry: { version: 1, entities: [{ canonicalId: "hydroxyectoine", aliases: ["羟基依克多因"] }] }
  });
  assert.equal(payload.projectSemanticRegistry.version, "1");
  assert.equal(backend._test.validateSemanticInput(payload), true);
  responses.push(ir());
  const result = await invoke("/api/semantic/interpret", payload);
  assert.equal(result.status, 200);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].body.requesty.extra.profile, "high");
});

test("the real renderer FC client serializes a compact semantic request accepted by the real FC handler", async () => {
  const { LiteratureApiClient } = require("../../docs/literature-module.js");
  let serialized;
  const api = new LiteratureApiClient({
    baseUrl: "https://fc.example.test", getHeaders: () => ({ Authorization: `Bearer ${token}` }),
    fetch: async (url, options) => {
      serialized = JSON.parse(options.body);
      assert.equal(backend._test.validateSemanticInput(serialized), true);
      const path = new URL(url).pathname;
      const result = await invoke(path, serialized);
      return new Response(JSON.stringify(result.body), { status: result.status, headers: { "Content-Type": "application/json" } });
    }
  });
  responses.push(ir());
  const payload = semantic.compactSemanticInput({ query: "Compare EctD experiments with literature", profile: "high", activeScope: { currentTopic: "EctD", projectObjective: "Compare experiments", paperIds: [], experimentSourceIds: [] }, conversationContext: { summary: "Compare the current project" }, projectSemanticRegistry: { version: 1 } });
  const result = await api.interpretSemantics({ ...payload, callContext: { turnId: "real-client-turn", profile: "high" } });
  assert.equal(result.goal, ir().goal);
  assert.equal(serialized.callContext.callRole, "semantic_parser");
  assert.equal(serialized.projectSemanticRegistry.version, "1");
  assert.equal(requests.length, 1);
  assert.equal(api.getTurnCallCounts("real-client-turn").semantic_parser, 1);
});

function comparisonKnowledgeBase({ operator = "<=", selectedPapers = [], evidenceType = "original-paper-evidence", content, temperature = 30, temperatureUnit = "degC" } = {}) {
  const quote = "The EctD activity assay was performed at 35°C.";
  const local = backend._test.sanitizeLocalWorkspaceContext({
    semantic: { ir: ir({ constraints: [{ type: "maximum-difference", field: "temperature_difference", operator, value: 5, unit: "degC", description: "Only temperatures within 5°C" }] }) },
    sourceMap: { selectedPaperIds: selectedPapers, paperSources: [{ sourceId: "paper-1", sourceKind: "paper", path: "literature/paper.pdf" }] },
    files: [{ sourceId: "paper-1", paperId: "paper-1", name: "paper.pdf", relativePath: "literature/paper.pdf", extension: "pdf", analysisStatus: "processed", evidenceType, content: content || `[paper-1:p2:chunk-2]\n${quote}` }],
    semanticExperimentResult: { status: "ready", metric: null, records: [{ experimentId: "exp-1", sourceId: "source-1", values: { temperature }, units: { temperature: temperatureUnit }, provenance: { sourceFile: "experiments/results.csv", sourceSheet: "Results", sourceRange: "A2", row: 2 } }], aggregation: null, unresolved: [], unappliedConstraints: [], provenance: { sourceIds: ["source-1"], totalRecords: 1, matchedRecords: 1, returnedRecords: 1 } }
  });
  return agent.createSideChatKnowledgeBase({ localWorkspaceContext: local });
}

function comparisonCall(knowledgeBase, overrides = {}) {
  return JSON.parse(agent.executeSideChatTool({ function: { name: "query_experiment_results", arguments: JSON.stringify({ literature_comparisons: [{ experiment_id: "exp-1", paper_id: "paper-1", evidence_quote: "The EctD activity assay was performed at 35°C.", reported_temperature: 35, unit: "degC", ...overrides }] }) } }, knowledgeBase));
}

test("grounded literature temperature comparisons compute exact differences and distinguish < from <=", () => {
  const included = comparisonCall(comparisonKnowledgeBase());
  assert.equal(included.deterministic, true);
  assert.equal(included.results[0].status, "validated");
  assert.equal(included.results[0].temperature_difference, 5);
  assert.equal(included.results[0].eligible, true);
  assert.equal(included.results[0].provenance.evidence_handle, "paper-1:p2:chunk-2");
  assert.equal(included.results[0].provenance.experiment.sourceRange, "A2");
  assert.equal(comparisonCall(comparisonKnowledgeBase({ operator: "<" })).results[0].eligible, false);
  assert.equal(comparisonCall(comparisonKnowledgeBase({ temperature: 20 })).results[0].eligible, false);
});

test("temperature comparisons reject fabricated quotes, wrong identities, unprepared records, and unit mismatch", () => {
  for (const overrides of [
    { evidence_quote: "The EctD assay was performed at 34°C.", reported_temperature: 34 },
    { experiment_id: "missing-experiment" }, { paper_id: "missing-paper" },
    { reported_temperature: 34 }, { unit: "kelvin" }, { shell: "arbitrary" }
  ]) assert.equal(comparisonCall(comparisonKnowledgeBase(), overrides).results[0].status, "unresolved");
  assert.equal(comparisonCall(comparisonKnowledgeBase({ selectedPapers: ["another-paper"] })).results[0].error, "ORIGINAL_PAPER_EVIDENCE_REQUIRED");
  assert.equal(comparisonCall(comparisonKnowledgeBase({ temperatureUnit: "K" })).results[0].error, "EXPERIMENT_TEMPERATURE_UNRESOLVED");
  assert.equal(comparisonCall(comparisonKnowledgeBase({ temperature: null })).results[0].error, "EXPERIMENT_TEMPERATURE_UNRESOLVED");
});

test("temperature quotes must come from original evidence, never cards, native summaries, or metadata", () => {
  for (const evidenceType of ["cached-summary", "requesty-native-pdf-analysis", "paper-card-available", "inventory-only"]) {
    assert.equal(comparisonCall(comparisonKnowledgeBase({ evidenceType })).results[0].error, "ORIGINAL_PAPER_EVIDENCE_REQUIRED");
  }
  const cardOnly = "Paper card: The EctD activity assay was performed at 35°C.\n\nOriginal-paper evidence for literature/paper.pdf:\n[paper-1:p2:chunk-2]\nThe paper discusses enzyme performance.";
  assert.equal(comparisonCall(comparisonKnowledgeBase({ evidenceType: "optional-paper-card+original-evidence", content: cardOnly })).results[0].error, "QUOTE_NOT_IN_ORIGINAL_EVIDENCE");
});

test("ambiguous or negated assay-temperature statements remain unresolved", () => {
  for (const quote of ["The assay was performed at 35°C after storage at 20°C.", "Samples were stored at 35°C.", "The assay was not performed at 35°C."]) {
    const result = comparisonCall(comparisonKnowledgeBase({ content: `[paper-1:p2:chunk-2]\n${quote}` }), { evidence_quote: quote });
    assert.equal(result.results[0].error, "QUOTED_ASSAY_TEMPERATURE_UNRESOLVED");
  }
});

test("the existing answer loop can read evidence then execute a grounded temperature comparison", async () => {
  const knowledgeBase = comparisonKnowledgeBase();
  const record = knowledgeBase.semanticExperimentResult.records[0];
  const paper = knowledgeBase.paperLookup.papers[0];
  const context = {
    semantic: { ir: knowledgeBase.semanticIR },
    semanticExperimentResult: knowledgeBase.semanticExperimentResult,
    files: [{ sourceId: paper.paperId, paperId: paper.paperId, name: "paper.pdf", relativePath: "literature/paper.pdf", extension: "pdf", analysisStatus: "processed", evidenceType: "original-paper-evidence", content: paper.item.content }]
  };
  let turns = 0;
  let eligibility;
  const result = await agent.runSideChatAgent({
    surface: "side_chat", conversationMessages: [{ role: "user", content: "Compare EctD experiments with literature" }],
    workspaceContext: { localWorkspaceContext: context }, systemPrompt: "Answer from cited evidence", parseFinalAnswer: (content) => ({ reply: content }),
    requestTurn: async ({ messages }) => {
      turns += 1;
      if (turns === 1) return { ok: true, message: { tool_calls: [{ id: "read-paper", type: "function", function: { name: "read_paper_evidence", arguments: JSON.stringify({ paper_id: paper.paperId }) } }] } };
      if (turns === 2) {
        assert.match(messages.at(-1).content, /assay was performed at 35°C/);
        return { ok: true, message: { tool_calls: [{ id: "compare-assay", type: "function", function: { name: "query_experiment_results", arguments: JSON.stringify({ literature_comparisons: [{ experiment_id: record.experimentId, paper_id: paper.paperId, evidence_quote: "The EctD activity assay was performed at 35°C.", reported_temperature: 35, unit: "degC" }] }) } }] } };
      }
      eligibility = JSON.parse(messages.at(-1).content).results[0];
      return { ok: true, message: { content: "This cited comparison satisfies the requested temperature condition." } };
    }
  });
  assert.equal(result.ok, true);
  assert.equal(eligibility.eligible, true);
  assert.equal(eligibility.temperature_difference, 5);
  assert.deepEqual(result.semanticTelemetry.capabilitiesUsed, ["read_paper_evidence", "query_experiment_results"]);
  assert.equal(result.semanticTelemetry.cloudCalls.answer, 3);
});

test("unavailable strict semantic capability degrades once per configuration without disabling working routes", async () => {
  const { LiteratureApiClient } = require("../../docs/literature-module.js");
  let endpointCalls = 0;
  const api = new LiteratureApiClient({ baseUrl: "https://fc.example.test", fetch: async (url, options) => {
    endpointCalls += 1;
    const result = await invoke(new URL(url).pathname, JSON.parse(options.body));
    return new Response(JSON.stringify(result.body), { status: result.status });
  } });
  process.env.REQUESTY_MODEL_SUPPORTS_JSON_SCHEMA = "false";
  try {
    const failure = await invoke("/api/semantic/interpret", input());
    assert.equal(failure.status, 502);
    assert.equal(failure.body.capabilityUnavailable, true);
    assert.equal(failure.body.fallbackReason, "structured_output_unsupported");
    assert.match(failure.body.configurationSignature, /^[a-f0-9]{64}$/);
    assert.doesNotMatch(JSON.stringify(failure.body), /fc-semantic-private-key|requesty\/test-semantic/);
    for (let turn = 0; turn < 11; turn += 1) {
      await assert.rejects(api.interpretSemantics(input({ callContext: { turnId: `unavailable-${turn}`, profile: "medium" } })), error => {
        assert.equal(error.capabilityUnavailable, true);
        assert.equal(error.semanticParserAttempted, turn === 0);
        return true;
      });
    }
    assert.equal(endpointCalls, 1);
    assert.equal(requests.length, 0);
    assert.equal(api.getTurnCallCounts("unavailable-0").semantic_parser, 1);
    assert.equal(api.getTurnCallCounts("unavailable-1").semantic_parser, undefined);
    // Only semantic interpretation has capability state; schema mapping keeps
    // its existing independent failure contract.
    const mapping = await invoke("/api/semantic/map-schema", schemaInput());
    assert.equal(mapping.body.error, "SchemaMapperUnavailable");
    assert.equal(mapping.body.capabilityUnavailable, undefined);
  } finally { process.env.REQUESTY_MODEL_SUPPORTS_JSON_SCHEMA = "true"; }
});

test("a literature-only semantic query succeeds through the existing FC to Requesty path", async () => {
  const payload = input({ query: "Find papers on EctD thermostability" });
  responses.push(semantic.interpretLocal(payload));
  const result = await invoke("/api/semantic/interpret", payload);
  assert.equal(result.status, 200);
  assert.deepEqual(result.body.ir.objects, ["literature"]);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, "https://router.requesty.ai/v1/chat/completions");
  assert.equal(result.body.attempts, 1);
});

test("provider schema incompatibility has an explicit sanitized semantic fallback reason", async () => {
  responses.push(new Response(JSON.stringify({ error: { message: "Invalid response_format: json_schema is unsupported by private-model." } }), { status: 400 }));
  const result = await invoke("/api/semantic/interpret", input());
  assert.equal(result.status, 502);
  assert.equal(result.body.capabilityUnavailable, true);
  assert.equal(result.body.fallbackReason, "provider_schema_incompatible");
  assert.equal(result.body.attempts, 1);
  assert.doesNotMatch(JSON.stringify(result.body), /private-model|fc-semantic-private-key/);
});

test("simultaneous semantic requests share only the unavailable capability probe", async () => {
  const { LiteratureApiClient } = require("../../docs/literature-module.js");
  let calls = 0;
  const api = new LiteratureApiClient({ baseUrl: "https://fc.example.test", fetch: async () => {
    calls += 1;
    return new Response(JSON.stringify({ ok: false, error: "SemanticParserUnavailable", capabilityUnavailable: true,
      fallbackReason: "structured_output_unsupported" }), { status: 502 });
  } });
  const results = await Promise.allSettled(Array.from({ length: 4 }, (_, turn) => api.interpretSemantics(input({ query: `Question ${turn}` }))));
  assert.equal(calls, 1);
  assert.equal(results.filter(result => result.status === "rejected").length, 4);
  assert.equal(results.filter(result => result.reason.semanticParserAttempted === true).length, 1);
});

test("semantic capability retries after cooldown, configuration changes, explicit refresh, and restart", async () => {
  const { LiteratureApiClient } = require("../../docs/literature-module.js");
  let now = 1000, calls = 0;
  const options = { baseUrl: "https://fc.example.test", now: () => now, fetch: async () => {
    calls += 1;
    return new Response(JSON.stringify({ ok: false, error: "SemanticParserUnavailable", capabilityUnavailable: true,
      fallbackReason: "structured_output_unsupported", configurationSignature: "a".repeat(64), retryAfterMs: 300000 }), { status: 502 });
  } };
  const api = new LiteratureApiClient(options);
  const attempt = () => assert.rejects(api.interpretSemantics(input()));
  await attempt(); await attempt(); assert.equal(calls, 1);
  now += 300001;
  await attempt(); assert.equal(calls, 2);
  api.configurationSignature = "new-fc-configuration";
  await attempt(); assert.equal(calls, 3);
  api.baseUrl = "https://other-fc.example.test";
  await attempt(); assert.equal(calls, 4);
  api.refreshSemanticCapability();
  await attempt(); assert.equal(calls, 5);
  await assert.rejects(new LiteratureApiClient(options).interpretSemantics(input()));
  assert.equal(calls, 6);
});

test("transient and malformed semantic failures do not mark the capability unavailable", async () => {
  const { LiteratureApiClient } = require("../../docs/literature-module.js");
  for (const first of [new Error("connection reset"), { status: 504, error: "SemanticParserUnavailable" }, { status: 502, error: "InvalidStructuredOutput" }]) {
    let calls = 0;
    const api = new LiteratureApiClient({ baseUrl: "https://fc.example.test", fetch: async () => {
      calls += 1;
      if (calls > 1) return new Response(JSON.stringify({ ok: true, ir: ir() }), { status: 200 });
      if (first instanceof Error) throw first;
      return new Response(JSON.stringify({ ok: false, error: first.error }), { status: first.status });
    } });
    await assert.rejects(api.interpretSemantics(input()), error => { assert.notEqual(error.capabilityUnavailable, true); return true; });
    assert.equal((await api.interpretSemantics(input())).goal, ir().goal);
    assert.equal(calls, 2);
  }
});

test("legacy opaque semantic 502 gets only a brief cooldown and remains retryable", async () => {
  const { LiteratureApiClient } = require("../../docs/literature-module.js");
  let calls = 0, now = 100;
  const api = new LiteratureApiClient({ baseUrl: "https://fc.example.test", now: () => now, fetch: async () => {
    calls += 1;
    return new Response(JSON.stringify(calls === 1 ? { ok: false, error: "SemanticParserUnavailable" } : { ok: true, ir: ir() }), { status: calls === 1 ? 502 : 200 });
  } });
  await assert.rejects(api.interpretSemantics(input()));
  await assert.rejects(api.interpretSemantics(input()), error => { assert.equal(error.semanticParserAttempted, false); assert.notEqual(error.capabilityUnavailable, true); return true; });
  assert.equal(calls, 1);
  now += 30001;
  assert.equal((await api.interpretSemantics(input())).goal, ir().goal);
  assert.equal(calls, 2);
});

test("FC preserves bounded literature identity and completion diagnostics and derives incomplete corpus coverage", () => {
  const context = backend._test.sanitizeLocalWorkspaceContext({ literature: {
    explicitPaperIds: ["P31", "P31"], identityResolution: { kind: "exact-title", paperIds: [], noExactMatch: true, query: "private title" },
    discoveryMode: "exact-title-no-match", corpusWideRequest: true,
    coverage: { papersIncludedInSnapshot: 8, papersSuccessfullyAnalyzed: 7, coverageComplete: true },
    diagnostics: { parser: { attempted: false, succeeded: false, fallback: true }, inputLanguage: "zh", canonicalEnglishAvailable: true,
      retrievalBackend: "legacy", fallbackReason: "qmd_not_ready", rankedPaperIds: ["P31"], selectedPaperIds: ["P31"],
      evidencePages: [{ paperId: "P31", page: 8, quote: "private source" }, { paperId: "P31", page: -1 }],
      targetedEvidenceCompletionCalls: 1, sourceContent: "private source", corpusCoverage: { snapshotCount: 8, analyzedCount: 8, coverageComplete: true } },
    evidenceCompletion: { calls: 1, requestedDimensions: ["sample_count", "private source"], missingByPaper: [{ paperId: "P31", dimensions: ["sample_count"] }], truncated: false },
  } });
  assert.equal(context.literature.identityResolution.noExactMatch, true);
  assert.equal(context.literature.discoveryMode, "exact-title-no-match");
  assert.deepEqual(context.literature.explicitPaperIds, ["P31"]);
  assert.deepEqual(context.literature.diagnostics.evidencePages, [{ paperId: "P31", page: 8 }]);
  assert.deepEqual(context.literature.diagnostics.corpusCoverage, { snapshotCount: 8, analyzedCount: 7, coverageComplete: false });
  assert.equal(context.literature.coverage.coverageComplete, false);
  assert.deepEqual(context.literature.evidenceCompletion.requestedDimensions, ["sample_count"]);
  assert.doesNotMatch(JSON.stringify(context), /private source|private title/);
});
