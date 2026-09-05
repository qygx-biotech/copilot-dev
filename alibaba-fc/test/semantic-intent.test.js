"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const semantic = require("../../shared/semantic-intent.js");
const fixture = require("../../scripts/fixtures/semantic-intent.json");
const { interpretLocal, validateSemanticIR, SemanticInterpreter, planCapabilities } = semantic;

function input(query, overrides = {}) { return { ...fixture.context, query, ...overrides }; }
function slotAssertions(ir, slots = {}, query = "") {
  for (const entity of slots.entities || []) assert.ok(ir.entities.some((item) => item.canonicalId === entity && item.mention === entity), `${query}: entity ${entity}`);
  for (const operation of slots.operations || []) assert.ok(ir.operations.includes(operation), `${query}: operation ${operation}`);
  for (const slot of slots.unresolved || []) assert.ok(ir.unresolvedSlots.includes(slot), `${query}: unresolved ${slot}`);
  if (slots.metric) assert.equal(ir.metrics[0]?.canonicalField, slots.metric, query);
  if (slots.limit) assert.equal(ir.requestedOutput.limit, slots.limit, query);
  if (slots.temperatureDifference) assert.ok(ir.constraints.some((item) => item.field === "temperature_difference" && item.value === slots.temperatureDifference && item.unit === "degC"), query);
  if (slots.paperYear) assert.ok(ir.filters.some((item) => item.field === "paper_year" && item.operator === "<" && item.value === slots.paperYear), query);
}

test("versioned multilingual known paraphrases share their known patterns", () => {
  assert.equal(fixture.known.length, 30);
  for (const row of fixture.known) {
    const ir = interpretLocal(input(row.query));
    assert.equal(ir.matchedPattern, row.pattern, row.query);
    assert.ok(ir.patternConfidence >= semantic.DEFAULT_THRESHOLDS.known, row.query);
    slotAssertions(ir, row.slots, row.query);
  }
});

test("novel requests preserve composition without forcing a narrow recipe", () => {
  assert.ok(fixture.novel.length >= 10);
  for (const row of fixture.novel) {
    const ir = interpretLocal(input(row.query));
    assert.equal(ir.matchedPattern, null, row.query);
    slotAssertions(ir, row.slots, row.query);
  }
});

test("ambiguous goals preserve missing criteria without inventing a metric", () => {
  for (const row of fixture.ambiguous) {
    const ir = interpretLocal({ query: row.query });
    assert.equal(ir.matchedPattern, null, row.query);
    slotAssertions(ir, row.slots, row.query);
  }
  assert.equal(interpretLocal({ query: "Which one is best?" }).metrics[0].canonicalField, null);
  assert.equal(interpretLocal(input("Which one is best?")).metrics[0].canonicalField, "hydroxyectoine_titer");
});

test("novel ranking plans combine literature and deterministic experiment capabilities", () => {
  const ir = interpretLocal(input(fixture.novel[0].query));
  assert.deepEqual(ir.objects.sort(), ["experiments", "literature"]);
  const plan = planCapabilities(ir, { surface: "side_chat" });
  assert.equal(plan.mode, "compositional");
  for (const tool of ["query_experiment_results", "search_papers", "read_paper_evidence"]) assert.ok(plan.steps.some((step) => step.tool === tool));
  assert.equal(plan.advisory, true);
  assert.deepEqual(plan.blocked, []);
  assert.deepEqual(ir.constraints[0], { type: "maximum-difference", field: "temperature_difference", operator: "<=", value: 5, unit: "degC", description: "above 5°C" });
  assert.ok(ir.entities.some((item) => item.canonicalId === "EctD"));
});

test("compositional search covers each source domain independently", () => {
  const ir = interpretLocal(input("Search papers and experimental measurements, then export the evidence."));
  const plan = planCapabilities(ir);
  assert.ok(plan.steps.some((step) => step.tool === "search_papers"));
  assert.ok(plan.steps.some((step) => step.tool === "query_experiment_results"));
  assert.ok(plan.unresolved.includes("capability:export"));
});

test("explanation and result-producing recommendation updates retain existing effect boundary", () => {
  const ir = interpretLocal(input("Update our current recommendation based on these experiments."));
  assert.equal(ir.matchedPattern, "recommendation.update");
  assert.ok(planCapabilities(ir, { surface: "side_chat" }).blocked.includes("update_recommendation"));
  assert.deepEqual(planCapabilities(ir, { surface: "agent_command" }).blocked, []);
  const explanation = interpretLocal(input("Why is the current recommendation A163V?"));
  assert.equal(explanation.matchedPattern, "recommendation.explain");
  assert.ok(planCapabilities(explanation).steps.every((step) => step.effect === "informational"));
});

test("machine-readable capability metadata exactly covers current agent tools and effects", () => {
  const agent = require("../side-chat-agent.js");
  for (const [name, effect] of Object.entries(agent.AGENT_TOOL_EFFECTS)) {
    const item = semantic.CAPABILITY_REGISTRY.find((candidate) => candidate.tool === name);
    assert.ok(item, name);
    assert.equal(item.effect, effect, name);
    assert.ok(item.operations.length);
    assert.ok(item.supportsObjects.length);
  }
  assert.equal(semantic.authorizeCapability("side_chat", "unregistered").allowed, false);
});

test("protected scientific identifiers preserve original case, punctuation and value", () => {
  const query = "Compare EctD ectD A163V T212S BL21(DE3) kcat Km OD600 DOI 10.1000/example NP_123456.1 results";
  const ir = interpretLocal(input(query));
  for (const marker of ["EctD", "ectD", "A163V", "T212S", "BL21(DE3)", "kcat", "Km", "OD600", "DOI", "10.1000/example", "NP_123456.1"]) assert.ok(ir.entities.some((item) => item.canonicalId === marker && item.mention === marker), marker);
  const changed = structuredClone(ir);
  changed.entities.find((item) => item.mention === "EctD").canonicalId = "ectd";
  assert.throws(() => validateSemanticIR(changed, { query }), /protected/);
  assert.throws(() => validateSemanticIR({ ...ir, entities: [] }, { query }), /protected/);
});

test("cross-language canonical entities do not rewrite source text", () => {
  const en = interpretLocal(input("Find papers on hydroxyectoine and wild-type EctD."));
  const zh = interpretLocal(input("查找羟基依克多因与野生型 EctD 的论文。"));
  for (const ir of [en, zh]) {
    assert.ok(ir.entities.some((item) => item.canonicalId === "hydroxyectoine"));
    assert.ok(ir.entities.some((item) => item.canonicalId === "WT"));
    assert.equal(ir.entities.some((item) => item.canonicalId === "ectoine"), false);
  }
  assert.equal(en.answerLanguage, "en");
  assert.equal(zh.answerLanguage, "zh");
  assert.ok(zh.entities.some((item) => item.mention === "野生型"));
});

test("current request and explicit preferences own answer language", () => {
  assert.equal(interpretLocal(input("请总结全部文献。")).answerLanguage, "zh");
  assert.equal(interpretLocal(input("总结全部文献，用英文回答。")).answerLanguage, "en");
  assert.equal(interpretLocal(input("Summarize all papers.", { conversationContext: [{ role: "user", content: "From now on always answer in Chinese." }] })).answerLanguage, "zh");
  assert.equal(interpretLocal(input("Summarize all papers. Reply in English.", { projectSemanticRegistry: { answerLanguage: "zh" } })).answerLanguage, "en");
});

test("strict schema rejects unknown effects, commands, malformed entities and capabilities", () => {
  const base = interpretLocal(input("Summarize all papers."));
  for (const invalid of [
    { ...base, effect: "unlimited" }, { ...base, command: "rm -rf /" },
    { ...base, operations: ["execute_shell"] }, { ...base, capabilityHints: ["shell"] },
    { ...base, entities: [{ type: "protein", mention: "EctD" }] },
    { ...base, requestedOutput: { ...base.requestedOutput, profile: "high" } },
    { ...base, patternConfidence: 0.51 }, { ...base, operations: [...base.operations, "send"] }
  ]) assert.throws(() => validateSemanticIR(invalid));
  assert.equal(validateSemanticIR({ ...base, matchedPattern: null, goal: "A new project-specific question", requestedOutput: { type: "novel-report-form", limit: null } }).matchedPattern, null);
});

test("remote known patterns must cover all requested domains", () => {
  const ranked = interpretLocal(input("Rank the variants."));
  assert.throws(() => validateSemanticIR({ ...ranked, objects: ["experiments", "literature"] }), /narrow pattern/);
  assert.throws(() => validateSemanticIR({ ...ranked, objects: [] }), /narrow pattern/);
});

test("semantic scope cannot widen selected sources and empty selection means project scope", () => {
  const activeScope = { paperIds: ["paper-one"], experimentSourceIds: ["experiment-one"] };
  const ir = interpretLocal(input("Compare literature and experiments.", { activeScope }));
  assert.deepEqual(ir.scope.papers, ["paper-one"]);
  assert.deepEqual(ir.scope.experiments, ["experiment-one"]);
  assert.throws(() => validateSemanticIR({ ...ir, scope: { ...ir.scope, papers: "current-project" } }, { activeScope }), /scope/);
  assert.throws(() => validateSemanticIR({ ...ir, scope: { ...ir.scope, experiments: ["experiment-two"] } }, { activeScope }), /scope/);
  assert.equal(interpretLocal(input("Summarize all papers", { activeScope: { paperIds: [] } })).scope.papers, "current-project");
});

test("Light is local even for open goals; Medium/High use one fused callback", async () => {
  for (const profile of ["light", "medium", "high"]) {
    let calls = 0;
    const interpreter = new SemanticInterpreter({ remoteParser: async (payload) => { calls += 1; return { ir: interpretLocal(payload) }; } });
    const result = await interpreter.interpret(input(fixture.novel[0].query, { profile }));
    assert.equal(calls, profile === "light" ? 0 : 1);
    assert.equal(result.telemetry.semanticParserCalls, calls);
    assert.equal(result.ir.matchedPattern, null);
    assert.equal(result.telemetry.profile, profile);
  }
  let calls = 0;
  const interpreter = new SemanticInterpreter({ remoteParser: () => { calls += 1; } });
  await interpreter.interpret(input("把所有论文综合成一个综述。", { profile: "light" }));
  await interpreter.interpret(input("把所有论文综合成一个综述。", { profile: "medium" }));
  assert.equal(calls, 0);
});

test("parser failure or malformed output falls back locally without hidden retries", async () => {
  for (const bad of [() => { throw new Error("provider unavailable"); }, (payload) => ({ ...interpretLocal(payload), profile: "high" })]) {
    let calls = 0;
    const interpreter = new SemanticInterpreter({ remoteParser: async (payload) => { calls += 1; return bad(payload); } });
    const result = await interpreter.interpret(input(fixture.novel[0].query, { profile: "medium" }));
    assert.equal(calls, 1);
    assert.equal(result.telemetry.semantic.route, "local-fallback");
    assert.equal(result.ir.matchedPattern, null);
    assert.equal(JSON.stringify(result.telemetry).includes("provider unavailable"), false);
  }
});

test("remote parser cannot change the host-owned profile or answer language", async () => {
  const interpreter = new SemanticInterpreter({ remoteParser: async (payload) => ({ ...interpretLocal(payload), answerLanguage: "en" }) });
  const result = await interpreter.interpret(input(fixture.novel[3].query, { profile: "high" }));
  assert.equal(result.ir.answerLanguage, "zh");
  assert.equal(result.telemetry.profile, "high");
});

test("compact parser input excludes full documents, paths, tables, credentials and unknown state", () => {
  const compact = semantic.compactSemanticInput({ ...input("EctD"), rawDocuments: ["PRIVATE_DOC"], activeScope: { paperIds: ["p1"], path: "/private/project", currentTopic: "enzyme engineering", knownMetrics: ["hydroxyectoine_titer"] }, conversationContext: { summary: "Short relevant context" }, projectSemanticRegistry: { version: 1, primaryMetric: "hydroxyectoine_titer", tables: ["PRIVATE_TABLE"], token: "PRIVATE_TOKEN", entities: [{ canonicalId: "EctD", aliases: ["ectoine hydroxylase"], content: "PRIVATE_CONTENT" }] } });
  assert.equal(JSON.stringify(compact).includes("PRIVATE_"), false);
  assert.equal(JSON.stringify(compact).includes("/private/project"), false);
  assert.equal(compact.activeScope.topic, "enzyme engineering");
  assert.equal(compact.conversationContext[0].content, "Short relevant context");
  assert.ok(compact.projectSemanticRegistry.metrics.length);
});

test("cache includes metric, hard scope, language preference, registry version and identifier case", async () => {
  const interpreter = new SemanticInterpreter();
  const first = await interpreter.interpret(input("Rank the variants."));
  const repeat = await interpreter.interpret(input("Rank the variants."));
  assert.equal(repeat.telemetry.semantic.route, "cache");
  const changed = await interpreter.interpret(input("Rank the variants.", { activeScope: { primaryMetric: "enzyme_activity" } }));
  assert.equal(changed.ir.metrics[0].canonicalField, "enzyme_activity");
  assert.equal(changed.telemetry.semantic.route, "local");
  assert.equal(first.ir.metrics[0].canonicalField, "hydroxyectoine_titer");
  for (const context of [{ activeScope: { paperIds: ["p1"] } }, { projectSemanticRegistry: { version: "new" } }, { conversationContext: [{ role: "user", content: "Always answer in Chinese." }] }]) {
    const result = await interpreter.interpret(input("Rank the variants.", context));
    assert.notEqual(result.telemetry.semantic.route, "cache");
  }
  await interpreter.interpret(input("Find EctD papers"));
  const distinct = await interpreter.interpret(input("Find ectD papers"));
  assert.notEqual(distinct.telemetry.semantic.route, "cache");
  assert.ok(distinct.ir.entities.some((item) => item.canonicalId === "ectD"));
});

test("open-set confidence and margin are configurable; matching remains example-based", () => {
  const ir = interpretLocal(input("Compare papers"), { thresholds: { margin: 1.01 } });
  assert.equal(ir.matchedPattern, null);
  assert.ok(semantic.SEMANTIC_PATTERNS.every((item) => item.examples.en.length && item.examples.zh.length));
  assert.equal(semantic.SEMANTIC_IR_SCHEMA.additionalProperties, false);
});

test("novel corpus compositions retain the existing coverage recipe without a forced pattern", () => {
  const ir = interpretLocal(input("Review all papers and rank experiment variants."));
  assert.equal(ir.matchedPattern, null);
  for (const operation of ["snapshot", "prepare", "map", "group", "reduce", "verify", "rank"]) assert.ok(ir.operations.includes(operation));
  const plan = planCapabilities(ir);
  assert.ok(plan.steps.some((step) => step.capability === "corpus_workflow" && step.hostOnly));
  assert.ok(plan.steps.some((step) => step.capability === "query_experiment_results"));
});

test("remote input language resolves a local Latin-script fallback while explicit preference wins", async () => {
  for (const preference of [null, "en"]) {
    const interpreter = new SemanticInterpreter({ remoteParser: async (payload) => ({ ...interpretLocal(payload), inputLanguage: "es", answerLanguage: "es" }) });
    const result = await interpreter.interpret({ query: "¿Qué conclusiones podemos extraer de nuestras publicaciones?", profile: "medium", projectSemanticRegistry: preference ? { answerLanguage: preference } : {} });
    assert.equal(result.ir.answerLanguage, preference || "es");
  }
});

test("uncertain threshold separates close-but-rejected matches from novel goals", async () => {
  const uncertain = await new SemanticInterpreter().interpret(input(fixture.novel[0].query));
  assert.equal(uncertain.ir.matchedPattern, null);
  assert.ok(uncertain.ir.patternConfidence >= semantic.DEFAULT_THRESHOLDS.uncertain);
  assert.equal(uncertain.telemetry.semantic.matchState, "uncertain");
  const novel = await new SemanticInterpreter().interpret({ query: "Do it again." });
  assert.equal(novel.telemetry.semantic.matchState, "novel");
  const known = await new SemanticInterpreter().interpret(input("Summarize all papers."));
  assert.equal(known.telemetry.semantic.matchState, "known");
  const stricter = await new SemanticInterpreter({ thresholds: { uncertain: 0.9 } }).interpret(input(fixture.novel[0].query));
  assert.equal(stricter.telemetry.semantic.matchState, "novel");
});

test("shared UMD executes in the sandboxed renderer without Node dependencies", () => {
  const context = vm.createContext({});
  vm.runInContext(fs.readFileSync(require.resolve("../../shared/semantic-intent.js"), "utf8"), context);
  assert.equal(vm.runInContext('BioDesignSemanticIntent.interpretLocal({query:"总结全部论文。"}).matchedPattern', context), "literature.corpus_synthesis");
});
