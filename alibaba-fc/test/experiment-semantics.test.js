"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const semantics = require("../../shared/experiment-semantics.js");
const { parseExperimentBytes, ExperimentTools } = require("../../docs/source-system.js");

const source = { sourceId: "source-1", contentHash: "sha256:fixture", sourceKind: "experiment", path: "experiments/assay.csv" };
const parse = (text, input = source) => parseExperimentBytes(input, new TextEncoder().encode(text));
const sheet = (headers, row = []) => ({ name: "Results", rows: [headers, row] });
const clone = (value) => JSON.parse(JSON.stringify(value));
function workspace() {
  const json = new Map();
  return { json, async fileExists(path) { return json.has(path); }, async readJson(path) { return clone(json.get(path)); },
    async writeJson(path, data) { json.set(path, clone(data)); } };
}
function queryTools(artifacts) {
  const sources = Object.keys(artifacts).map((sourceId) => ({ ...source, sourceId }));
  return new ExperimentTools({
    registry: { list() { return sources; }, get(id) { return sources.find((item) => item.sourceId === id); } },
    preparation: { async ensureSourceReady(ids) { return { sources: ids.map((sourceId) => ({ sourceId })), failures: [] }; },
      async readExperimentArtifact(id) { return artifacts[id]; } },
    results: { async compact(value) { return value; } },
  });
}
const rankIR = (overrides = {}) => ({ version: 1, operations: ["filter", "aggregate", "rank"], entities: [],
  metrics: [{ canonicalField: "hydroxyectoine_titer", direction: "maximize" }],
  filters: [], constraints: [], scope: { experiments: "current-project" }, requestedOutput: { type: "ranked-comparison", limit: 5 }, ...overrides });

test("Chinese and English schemas have the same canonical fields and lossless raw provenance", () => {
  const zh = "突变体,温度（℃）,羟基依克多因产量（g/L）,培养时间（h）\n野生型,30,2.5,24";
  const en = "Variant,Temperature,Hydroxyectoine Titer (g/L),Culture Time (h)\nWT,30,2.5,24";
  const chinese = parse(zh);
  const english = parse(en);
  const expected = ["mutation", "temperature", "hydroxyectoine_titer", "culture_time"];
  assert.deepEqual(chinese.schemas[0].columns.map((column) => column.canonicalField), expected);
  assert.deepEqual(english.schemas[0].columns.map((column) => column.canonicalField), expected);
  assert.deepEqual(chinese.records[0].canonical, english.records[0].canonical);
  assert.equal(chinese.records[0].rawCells[0].rawValue, "野生型");
  assert.equal(chinese.records[0].rawCells[0].normalizedValue, "WT");
  assert.equal(chinese.records[0].rawCells[2].rawHeader, "羟基依克多因产量（g/L）");
  assert.equal(chinese.records[0].rawCells[2].sheet, "data");
  assert.equal(chinese.records[0].rawCells[2].sourceId, source.sourceId);
  assert.equal(chinese.records[0].sourceContentHash, source.contentHash);
  assert.equal(chinese.records[0].provenance.sourceFile, source.path);
  assert.deepEqual(chinese.sheets[0].rows[0], zh.split("\n")[0].split(","));
});

test("unit inference distinguishes concentrations, yields, productivity and uncertain activity", () => {
  assert.equal(semantics.resolveColumn("产量").canonicalField, null);
  assert.equal(semantics.resolveColumn("产量").status, "unresolved");
  assert.equal(semantics.resolveColumn("产量 (g/L)").canonicalField, "titer");
  assert.equal(semantics.resolveColumn("产量 (g/g glucose)").canonicalField, "yield");
  assert.equal(semantics.resolveColumn("产量 (g/L/h)").canonicalField, "productivity");
  assert.equal(semantics.resolveColumn("活性").canonicalField, null);
  assert.deepEqual(semantics.resolveColumn("活性").candidateFields, ["enzyme_activity", "specific_activity", "relative_activity"]);
  assert.equal(semantics.resolveColumn("活性 (U/mg)").canonicalField, "specific_activity");
  assert.equal(semantics.resolveColumn("Hydroxyectoine yield (g/L)").canonicalField, null);
  assert.equal(semantics.resolveColumn("Hydroxyectoine titer (g/g)").canonicalField, null);
});

test("units and entity aliases normalize deterministically without changing exact identifiers", () => {
  for (const value of ["克/升", "g/L", "g L-1"]) assert.equal(semantics.normalizeUnit(value).normalizedUnit, "g/L");
  assert.equal(semantics.normalizeUnit("毫克/升").factor, 0.001);
  assert.equal(semantics.normalizeUnit("g L-1 h-1").normalizedUnit, "g/L/h");
  assert.equal(semantics.normalizeUnit("g/g glucose").normalizedUnit, "g/g glucose");
  for (const value of ["野生型", "WT", "wild type", "wild-type"]) assert.equal(semantics.normalizeEntity(value), "WT");
  for (const value of ["EctD", "ectD", "A163V", "BL21(DE3)", "Km", "kcat", "OD600"]) assert.equal(semantics.normalizeEntity(value), value);
  const data = parse("temperature (K),hydroxyectoine titer (mg/L),culture time (min)\n303.15,2500,120");
  assert.deepEqual(data.records[0].canonical, { temperature: 30, hydroxyectoine_titer: 2.5, culture_time: 2 });
  assert.equal(data.records[0].rawCells[1].rawValue, "2500");
});

test("duplicate raw headers and duplicate canonical measurements stay recoverable and ambiguous", () => {
  const data = parse("温度（℃）,温度（℃）,产量\n30,40,2");
  assert.equal(data.records[0].rawCells.length, 3);
  assert.equal(Object.keys(data.records[0].raw).length, 3);
  assert.deepEqual(data.records[0].rawCells.slice(0, 2).map((cell) => cell.rawValue), ["30", "40"]);
  assert.equal(data.records[0].canonical.temperature, undefined);
  assert.deepEqual(data.records[0].ambiguousCanonicalFields, ["temperature"]);
});

test("sheet/neighbor product context refines generic concentration without inferring from no evidence", () => {
  const resolved = semantics.buildSheetSchema(source, sheet(["羟基依克多因", "产量 (g/L)"], ["product", 3]));
  assert.equal(resolved.columns[1].canonicalField, "hydroxyectoine_titer");
  const unresolved = semantics.buildSheetSchema(source, sheet(["产量"], [3]));
  assert.equal(unresolved.columns[0].canonicalField, null);
});

test("obvious Light/Medium/High mappings do not call FC, and Light keeps ambiguous values", async () => {
  let calls = 0;
  const service = new semantics.SchemaMappingService({ workspace: workspace(), schemaMapper: async () => { calls += 1; throw new Error("unexpected"); } });
  for (const profile of ["light", "medium", "high"]) {
    await service.normalize(source, [sheet(["pH", "OD600", "Temperature", "Variant"], [7, 2, 30, "WT"])], { profile });
  }
  const ambiguous = await service.normalize(source, [sheet(["产量"], [2])], { profile: "light" });
  assert.equal(ambiguous[0].columns[0].status, "unresolved");
  assert.equal(calls, 0);
});

test("bounded FC schema mappings cache and survive a service reload", async () => {
  const store = workspace();
  let calls = 0;
  const mapper = async (payload) => {
    calls += 1;
    assert.equal(payload.columns.length, 1);
    assert.deepEqual(Object.keys(payload).sort(), ["columns", "ontology", "schemaSignature", "sheet", "version"]);
    assert.equal(JSON.stringify(payload).includes(source.path), false);
    assert.ok(payload.columns[0].examples.every((example) => example.length <= 80));
    return { version: 1, mappings: [{ columnId: "c1", canonicalField: "specific_activity", confidence: 0.97 }] };
  };
  const service = new semantics.SchemaMappingService({ workspace: store, schemaMapper: mapper });
  const sheets = [sheet(["活性"], [4.5])];
  const first = await service.normalize(source, sheets, { profile: "medium" });
  assert.equal(first[0].columns[0].canonicalField, "specific_activity");
  await service.normalize(source, sheets, { profile: "high" });
  const reopened = new semantics.SchemaMappingService({ workspace: store, schemaMapper: mapper });
  await reopened.normalize(source, sheets, { profile: "high" });
  assert.equal(calls, 1);
  assert.equal(store.json.get(semantics.SCHEMA_MAPPING_PATH).registryVersion, semantics.FIELD_REGISTRY_VERSION);
});

test("confirmed local corrections reuse unchanged schemas but changed unit/sheet/context cannot inherit", async () => {
  const service = new semantics.SchemaMappingService({ workspace: workspace() });
  const original = sheet(["产量", "variant"], [2, "WT"]);
  await service.confirmMapping(source, original, "c1", "hydroxyectoine_titer");
  const same = await service.normalize({ ...source, contentHash: "new-values-same-schema" }, [sheet(original.rows[0], [4, "A163V"])], { profile: "light" });
  assert.equal(same[0].columns[0].canonicalField, "hydroxyectoine_titer");
  for (const changed of [
    { ...original, name: "Different" },
    sheet(["产量", "gene"], [2, "ectD"]),
    sheet(["产量 (g/g glucose)", "variant"], [2, "WT"]),
  ]) {
    const result = await service.normalize(source, [changed], { profile: "light" });
    assert.notEqual(result[0].columns[0].canonicalField, "hydroxyectoine_titer");
  }
  const otherSource = await service.normalize({ ...source, sourceId: "source-2" }, [original]);
  assert.equal(otherSource[0].columns[0].canonicalField, null);
  const contextChanged = await service.normalize(source, [original], { ontologyLabels: ["ectoine"] });
  assert.equal(contextChanged[0].columns[0].canonicalField, null);
});

test("unrelated far-away schema edits reuse affected-column confirmation only where context stays equal", async () => {
  const service = new semantics.SchemaMappingService({ workspace: workspace() });
  const original = sheet(["产量", "variant", "temperature", "pH", "culture time"], [2, "WT", 30, 7, 24]);
  await service.confirmMapping(source, original, "c1", "hydroxyectoine_titer");
  const changed = sheet(["产量", "variant", "temperature", "pH", "od600"], [2, "WT", 30, 7, 2]);
  const resolved = await service.normalize(source, [changed]);
  assert.equal(resolved[0].columns[0].canonicalField, "hydroxyectoine_titer");
  assert.equal(resolved[0].columns[4].canonicalField, "od600");
});

test("low confidence and invalid FC mappings never silently assign a metric", async () => {
  for (const response of [
    { version: 1, mappings: [{ columnId: "c1", canonicalField: "specific_activity", confidence: 0.57 }] },
    { version: 1, mappings: [{ columnId: "invented", canonicalField: "specific_activity", confidence: 1 }] },
    { version: 1, mappings: [{ columnId: "c1", canonicalField: "arbitrary-field", confidence: 1 }] },
    { version: 1, mappings: [{ columnId: "c1", canonicalField: "temperature", confidence: 1 }] },
  ]) {
    const service = new semantics.SchemaMappingService({ workspace: workspace(), schemaMapper: async () => response });
    const result = await service.normalize(source, [sheet(["活性"], [2])], { profile: "high" });
    assert.equal(result[0].columns[0].canonicalField, null);
  }
});

test("concurrent schema consumers join one FC call; an outage remains retryable", async () => {
  let calls = 0;
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const service = new semantics.SchemaMappingService({ workspace: workspace(), schemaMapper: async () => {
    calls += 1; await gate; return { version: 1, mappings: [{ columnId: "c1", canonicalField: null, confidence: 0.2 }] };
  } });
  const sheets = [sheet(["活性"], [2])];
  const a = service.normalize(source, sheets, { profile: "medium" });
  const b = service.normalize(source, sheets, { profile: "high" });
  release(); await Promise.all([a, b]);
  assert.equal(calls, 1);
  await service.normalize(source, sheets, { profile: "high" });
  assert.equal(calls, 1);
  let attempts = 0;
  const failed = new semantics.SchemaMappingService({ workspace: workspace(), schemaMapper: async () => { attempts += 1; throw new Error("FC unavailable"); } });
  await failed.normalize(source, sheets, { profile: "medium" });
  await failed.normalize(source, sheets, { profile: "medium" });
  assert.equal(attempts, 2);
});

test("canonical queries deterministically filter and rank the full scope across languages and units", async () => {
  const low = Array.from({ length: 150 }, (_, index) => `EctD,A${index + 1}V,30,1`).join("\n");
  const english = parse(`protein,Variant,Temperature (degC),Hydroxyectoine titer (g/L)\n${low}\nEctD,A999V,30,9`);
  const chinese = parse("蛋白,突变体,温度（℃）,羟基依克多因产量（mg/L）\nEctD,A999V,30,5000\nEctD,A555V,40,12000", { ...source, sourceId: "source-2" });
  const tools = queryTools({ "source-1": english, "source-2": chinese });
  const result = await tools.executeSemanticQuery(rankIR({
    entities: [{ type: "protein", canonicalId: "EctD", mention: "EctD" }],
    requestedOutput: { type: "ranked-comparison", limit: 1 },
    filters: [{ field: "temperature", operator: "<", value: 35, unit: "degC" }],
    constraints: [{ type: "maximum-difference", field: "temperature_difference", operator: "<=", value: 5, unit: "degC" }],
  }));
  assert.equal(result.status, "ready");
  assert.equal(result.provenance.totalRecords, 153);
  assert.equal(result.provenance.matchedRecords, 152);
  assert.equal(result.groups[0].groupValue, "A999V");
  assert.equal(result.groups[0].value, 7);
  assert.equal(result.groups[0].count, 2);
  assert.equal(result.records.length, 2);
  assert.deepEqual(result.records.map((record) => record.values.hydroxyectoine_titer).sort(), [5, 9]);
  assert.equal(result.unappliedConstraints[0].field, "temperature_difference");
});

test("numeric rank refuses unresolved metric/units and never treats blank values as zero", async () => {
  const data = parse("Variant,Hydroxyectoine titer (g/L)\nWT,\nA163V,3\nA100V,not measured");
  const tools = queryTools({ "source-1": data });
  const rank = await tools.executeSemanticQuery(rankIR());
  assert.equal(rank.aggregation.count, 1);
  assert.equal(rank.aggregation.value, 3);
  const missing = await tools.executeSemanticQuery(rankIR({ metrics: [{ canonicalField: null, direction: "maximize" }] }));
  assert.equal(missing.status, "unresolved");
  assert.equal(missing.aggregation, null);
  const unknownUnits = parse("Variant,Hydroxyectoine titer\nA200V,300", { ...source, sourceId: "source-2" });
  const incompatible = await queryTools({ "source-1": data, "source-2": unknownUnits }).executeSemanticQuery(rankIR());
  assert.equal(incompatible.status, "unresolved");
  assert.equal(incompatible.aggregation, null);
  assert.equal(incompatible.groups.length, 0);
});

test("deterministic execution intersects requested source scopes and keeps existing raw API", async () => {
  const a = parse("Variant,Hydroxyectoine titer (g/L)\nWT,1");
  const b = parse("Variant,Hydroxyectoine titer (g/L)\nA163V,9", { ...source, sourceId: "source-2" });
  const tools = queryTools({ "source-1": a, "source-2": b });
  const result = await tools.executeSemanticQuery(rankIR({ scope: { experiments: ["source-1"] } }), { experimentSourceIds: ["source-1", "source-2"] });
  assert.deepEqual(result.provenance.sourceIds, ["source-1"]);
  assert.equal(result.groups[0].value, 1);
  const legacy = await tools.queryExperimentResults({ metric: "hydroxyectoine_titer", conditionFilters: { mutation: "WT" } });
  assert.equal(legacy.length, 1);
  assert.equal(legacy[0].raw.Variant, "WT");
  assert.equal(legacy[0].canonical.hydroxyectoine_titer, 1);
});

test("one failed schema request is not retried within a turn and retries on a new turn", async () => {
  let calls = 0;
  const service = new semantics.SchemaMappingService({ workspace: workspace(), schemaMapper: async () => { calls += 1; throw new Error("offline"); } });
  const sheets = [sheet(["活性"], [2])];
  await service.normalize(source, sheets, { profile: "high", callContext: { turnId: "turn-1" } });
  await service.normalize(source, sheets, { profile: "high", callContext: { turnId: "turn-1" } });
  assert.equal(calls, 1);
  await service.normalize(source, sheets, { profile: "high", callContext: { turnId: "turn-2" } });
  assert.equal(calls, 2);
});

test("statistics identify sample and population variance and unknown units remain unresolved", async () => {
  const data = parse("Variant,Hydroxyectoine titer (g/L)\nWT,1\nA163V,3");
  const tools = queryTools({ "source-1": data });
  const stats = await tools.executeSemanticQuery(rankIR({ operations: ["aggregate", "statistics"] }));
  assert.equal(stats.aggregation.value, 2);
  assert.equal(stats.aggregation.populationVariance, 1);
  assert.equal(stats.aggregation.sampleVariance, 2);
  const unknown = parse("Temperature (bananas)\n30");
  assert.equal(unknown.schemas[0].columns[0].canonicalField, null);
  assert.equal(unknown.schemas[0].columns[0].unit, "bananas");
});

test("mixed source units convert per cell and duplicate canonical metrics cannot silently disappear", async () => {
  const converted = parse("mutation,activity,unit\nWT,3000,U/g\nA163V,4,U/mg");
  assert.equal(converted.records[0].canonical.specific_activity, 3);
  assert.equal(converted.records[1].canonical.specific_activity, 4);
  const duplicates = parse("Variant,Hydroxyectoine titer (g/L),Hydroxyectoine concentration (g/L)\nA100V,10,20");
  const known = parse("Variant,Hydroxyectoine titer (g/L)\nWT,1", { ...source, sourceId: "source-2" });
  const ranked = await queryTools({ "source-1": duplicates, "source-2": known }).executeSemanticQuery(rankIR());
  assert.equal(ranked.status, "unresolved");
  assert.ok(ranked.unresolved.includes("ambiguous_metric_columns"));
  assert.equal(ranked.aggregation, null);
});
