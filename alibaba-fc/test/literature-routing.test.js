"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { ProjectContextService } = require("../../docs/project-context-service.js");
const { LiteratureTools } = require("../../docs/source-system.js");
const semantic = require("../../shared/semantic-intent.js");

function fixture(options = {}) {
  const documents = [
    { id: "P31", filename: "corrected-material.pdf", discovery: { title: "Material mechanics: corrected results" } },
    { id: "P52", filename: "polymer-methods.pdf", discovery: { title: "Polymer processing and methods" } },
  ].map((document) => ({ ...document, isLiteraturePaper: true, relativePath: `literature/${document.filename}`, paperCardStatus: "ready", summaryAvailable: true }));
  const sources = documents.map((document) => ({ sourceId: document.id, sourceKind: "paper", path: document.relativePath,
    displayName: document.filename, catalogStatus: "current", hashStatus: "ready", contentHash: `hash-${document.id}`, parseStatus: "ready", indexStatus: "ready", artifacts: {} }));
  const registry = { get: (id) => sources.find((source) => source.sourceId === id) || null,
    getByPath: (path) => sources.find((source) => source.path === path),
    list: ({ sourceKind } = {}) => sources.filter((source) => !sourceKind || source.sourceKind === sourceKind), counts: () => ({}) };
  const reads = [], searches = [], experimentCalls = [];
  const artifacts = new Map(documents.map((document) => [document.id, { contentHash: `hash-${document.id}`, chunks: [
    { chunkId: "c1", page: 1, text: "Material methods background." },
    { chunkId: "c2", page: 2, text: "The corrected mean modulus is 48 kPa." },
  ] }]));
  const literature = { documents, api: {}, findDocumentByPath: (path) => documents.find((document) => document.relativePath === path),
    preparation: { ensureSourceReady: async (ids) => { reads.push(...ids); }, readPaperArtifact: async (id) => artifacts.get(id) } };
  const literatureTools = { async searchPapers(query, searchOptions) {
    searches.push({ query, options: searchOptions });
    return { results: options.results || [{ paperId: "P52", score: 100, searchable: true, page: 1, evidenceHandle: "c1", retrievalBackend: "legacy" }],
      diagnostics: { retrievalBackend: "legacy", fallbackReason: "qmd_not_ready" } };
  } };
  const sourceSystem = { registry, literatureTools,
    experimentTools: { async searchExperiments() { experimentCalls.push("search"); return []; },
      async executeSemanticQuery() { experimentCalls.push("query"); return { records: [] }; } } };
  const service = new ProjectContextService({ workspace: { state: { memory: {}, project: {} }, workspace: { id: "routing-fixture" } },
    literature, sourceSystem,
    ...(options.objects || options.goal ? { semanticInterpreter: { async interpret(input) {
      const ir = semantic.interpretLocal(input);
      if (options.objects) ir.objects = options.objects;
      if (options.goal) ir.goal = options.goal;
      return { ir, telemetry: { profile: input.profile, semantic: { route: "local" } } };
    } } } : {}),
  });
  const build = (question, extra = {}) => service.buildContext({ question, retrievalProfile: "light", ...extra });
  return { service, build, literature, sources, artifacts, reads, searches, experimentCalls, literatureTools };
}

test("explicit current paper ID reaches original evidence despite generic-definition routing and an unrelated ranked hit", async () => {
  const f = fixture();
  const context = await f.build("What is the current corrected mean modulus in P31? Cite the page.");
  assert.deepEqual(context.literature.relevantPaperIds, ["P31"]);
  assert.equal(context.routing.mode, "explicit-paper");
  assert.deepEqual(f.searches[0].options.paperIds, ["P31"]);
  assert.deepEqual(f.reads, ["P31"]);
  assert.match(context.files[0].content, /\[P31:p2:c2\][\s\S]*48 kPa/);
  assert.equal(context.files.some((file) => file.paperId === "P52"), false);
  assert.deepEqual(context.literature.diagnostics.selectedPaperIds, ["P31"]);
  assert.ok(context.literature.diagnostics.evidencePages.some((item) => item.paperId === "P31" && item.page === 2));
});

test("exact filenames and normalized recognized titles preserve paper scope", async () => {
  for (const query of [
    "What is the modulus in corrected-material.pdf?",
    "What was reported in “MATERIAL MECHANICS — Corrected Results”?",
    "Find the paper with the exact title \"Ｍａｔｅｒｉａｌ mechanics: corrected results\".",
  ]) {
    const f = fixture();
    const context = await f.build(query);
    assert.deepEqual(context.literature.relevantPaperIds, ["P31"], query);
    assert.deepEqual(f.reads, ["P31"], query);
  }
});

test("explicit paper references cannot widen an active selection and token substrings cannot resolve IDs", async () => {
  const f = fixture();
  const context = await f.build("What is the mean modulus in P31?", { selectedPaperIds: ["P52"] });
  assert.deepEqual(context.literature.relevantPaperIds, ["P52"]);
  assert.deepEqual(f.reads, ["P52"]);
  assert.deepEqual(f.service.resolveExplicitPaperIdentity("What is P310?").paperIds, []);
  f.sources.splice(f.sources.findIndex((source) => source.sourceId === "P31"), 1);
  assert.deepEqual(f.service.resolveExplicitPaperIdentity("What is the modulus in P31?").paperIds, []);
});

test("hard paper scope retains requested project memory for explicit and selected paper comparisons", async () => {
  for (const selected of [false, true]) {
    const f = fixture({ objects: ["literature", "memory"] });
    f.literature.api.interpretSemantics = async () => {};
    f.service.workspace.state.memory.records = [{ memoryId: "M1", status: "active", kind: "hypothesis", text: "Our current hypothesis is that the material is stiffer." }];
    const context = await f.build("Compare findings in P31 with our current hypothesis.", selected ? { selectedPaperIds: ["P31"] } : {});
    assert.deepEqual(context.literature.relevantPaperIds, ["P31"]);
    assert.equal(context.routing.useProjectMemory, true);
    assert.deepEqual(context.project.memoryRecords.map((record) => record.memoryId), ["M1"]);
  }
});

test("relational literature discovery retains a named comparator without narrowing away other papers", async () => {
  for (const query of ["Find papers citing P31.", "Which study is warmer than P31?"]) {
    const f = fixture();
    const context = await f.build(query);
    assert.equal(f.searches[0].options.paperIds, undefined, query);
    assert.ok(context.literature.relevantPaperIds.includes("P52"), query);
    assert.ok(context.literature.relevantPaperIds.includes("P31"), query);
    assert.deepEqual(context.literature.explicitPaperIds, [], query);
    assert.deepEqual(new Set(f.reads), new Set(["P31", "P52"]), query);
    const selected = await f.build(query, { selectedPaperIds: ["P31"] });
    assert.deepEqual(selected.literature.relevantPaperIds, ["P31"]);
  }
});

test("an exact nonexistent title returns no match with no semantic or previous-paper substitution", async () => {
  const f = fixture();
  const query = 'Find a paper with the exact title "Material Mechanics: Clinical Outcomes in Patients".';
  const context = await f.build(query, { conversation: { messages: [{ role: "assistant", content: "Previous paper", context: { relevantPaperIds: ["P52"] } }] } });
  assert.deepEqual(context.literature.relevantPaperIds, []);
  assert.equal(context.literature.identityResolution.noExactMatch, true);
  assert.equal(context.literature.discoveryMode, "exact-title-no-match");
  assert.equal(context.files.length, 0);
  assert.equal(f.searches.length, 0);
  assert.equal(f.reads.length, 0);
  assert.match(context.notices.join("\n"), /No exact title match/);
  assert.equal((await f.service.matchPapers(query, { readyOnly: false })).length, 0);
});

test("ordinary semantic discovery still retrieves candidates without exact title matching", async () => {
  const f = fixture();
  const context = await f.build("Which papers discuss polymer processing methods?");
  assert.ok(f.searches.length > 0);
  assert.ok(context.literature.relevantPaperIds.includes("P52"));
  assert.equal(context.literature.identityResolution.noExactMatch, false);
});

test("literature-only semantic objects prevent experiment lookup for overlapping scientific terms", async () => {
  const f = fixture({ objects: ["literature"] });
  const context = await f.build("Which papers report assay activity and strain conditions?", {
    conversation: { messages: [{ role: "assistant", content: "Our results", context: { relevantExperimentIds: ["X1"] } }] },
  });
  assert.equal(f.experimentCalls.length, 0);
  assert.deepEqual(context.experiments.relevantExperimentIds, []);
  assert.equal(context.semantic.telemetry.capabilitiesUsed.includes("query_experiment_results"), false);
});

test("a resolved ranked evidence page survives the handoff into the existing bounded original-paper read", async () => {
  const f = fixture({ results: [{ paperId: "P31", score: 100, searchable: true, page: 8, evidenceHandle: "c8", retrievalBackend: "qmd" }] });
  f.artifacts.get("P31").chunks = Array.from({ length: 8 }, (_, index) => ({
    chunkId: `c${index + 1}`, page: index + 1,
    text: index === 7 ? "The distinctive synthesis method used a delayed quench." : "Material preparation methods and polymer processing methods.",
  }));
  const context = await f.build("Which papers describe material preparation methods?");
  const evidence = context.files.find((file) => file.paperId === "P31");
  assert.ok(evidence);
  assert.match(evidence.content, /P31:p8:c8/);
  assert.ok(evidence.content.indexOf("delayed quench") < evidence.content.indexOf("polymer processing"));
  assert.ok(context.citationEvidence.some((item) => item.sourceId === "P31" && item.page === 8));
});

test("non-English original and canonical query metadata reach search and original-evidence scoring", async () => {
  const query = "哪些论文研究 EctD 热稳定性？";
  const f = fixture({ objects: ["literature"], goal: "Which papers study EctD thermostability?" });
  const context = await f.build(query);
  assert.equal(f.searches[0].options.qmdQuery, query);
  assert.equal(f.searches[0].options.requestUnderstanding.originalQuery, query);
  assert.equal(f.searches[0].options.requestUnderstanding.canonicalQueryEn, "Which papers study EctD thermostability?");
  assert.ok(f.service.scorePaperChunk({ text: "Thermostability improved." }, query, { requestUnderstanding: context.requestUnderstanding }) > 0);
});

test("context attaches targeted original evidence before a bounded read and collects its real citation page", async () => {
  const f = fixture();
  f.artifacts.get("P31").chunks.push({ chunkId: "c8", page: 8, text: "The sample count was n=5." });
  let completionCalls = 0;
  f.literatureTools.completeEvidence = async (question, paperIds) => {
    completionCalls++;
    assert.deepEqual(paperIds, ["P31"]);
    return { files: [{ paperId: "P31", sourceId: "P31", evidenceType: "original-paper-evidence", content: "[P31:p8:c8]\nThe sample count was n=5." }],
      calls: 1, requestedDimensions: ["sample_count"], missingByPaper: [], truncated: false };
  };
  const context = await f.build("What is the sample count in P31?");
  assert.equal(completionCalls, 1);
  assert.match(context.files[0].content, /^\[P31:p8:c8\]\nThe sample count was n=5/);
  assert.ok(context.files[0].content.length <= f.service.limits.maxSourceCharactersPerFile);
  assert.equal(context.literature.diagnostics.targetedEvidenceCompletionCalls, 1);
  assert.ok(context.citationEvidence.some((item) => item.page === 8));
});

test("seven requested facts survive bounded completion with and without an optional Paper Card prefix", async () => {
  const facts = ["The mean value was 48 kPa.", "The sample count was n=5.", "The temperature was 30 °C.",
    "Km = 2 mM.", "kcat = 3 per second.", "The A163V mutation was tested.", "The assay used a delayed quench."];
  for (const withCard of [false, true]) {
    const f = fixture();
    f.sources.forEach((source) => { source.catalogStatus = "ready"; });
    const tools = new LiteratureTools({ registry: f.service.sourceRegistry, preparation: f.literature.preparation });
    f.literatureTools.completeEvidence = tools.completeEvidence.bind(tools);
    f.literatureTools.evidenceCompletionStatus = tools.evidenceCompletionStatus.bind(tools);
    f.artifacts.get("P31").chunks = facts.map((fact, index) => ({ chunkId: `fact-${index}`, page: index + 2,
      text: `${fact} ${"Original discussion surrounding this result. ".repeat(40)}` }));
    const path = f.literature.documents[0].relativePath;
    const prefix = withCard ? `Cached Paper Card: ${"Routing context. ".repeat(180)}\nOriginal-paper evidence for ${path}:\n` : "";
    const original = `[P31:p1:background]\n${"General source discussion. ".repeat(50)}\n[P31:p8:fact-6]\n${facts[6]}`;
    const priorContent = prefix + original;
    f.service.retrievePaperEvidence = async () => [{ paperId: "P31", sourceId: "P31", name: "corrected-material.pdf", relativePath: path,
      analysisStatus: "processed", evidenceType: withCard ? "optional-paper-card+original-evidence" : "original-paper-evidence", content: priorContent }];
    const context = await f.build("What are the mean, sample count, temperature, Km, kcat, mutation, and method in P31?");
    for (const fact of facts) assert.ok(context.files[0].content.includes(fact), `${withCard ? "card prefix" : "original"}: ${fact}`);
    assert.ok(context.files[0].content.startsWith(prefix));
    assert.ok(context.files[0].content.length <= Math.max(priorContent.length, f.service.limits.maxSourceCharactersPerFile));
    assert.deepEqual(context.literature.evidenceCompletion.missingByPaper, []);
    assert.equal(context.literature.evidenceCompletion.truncated, false);
    assert.equal(context.literature.evidenceCompletion.calls, 1);
    assert.equal(f.reads.length, 1, "all dimensions use the same original-evidence lookup");
    assert.deepEqual(context.citationEvidence.map((entry) => entry.page), [2, 3, 4, 5, 6, 7, 8]);
  }
});

test("post-merge completeness reflects displaced original facts when the available budget is insufficient", async () => {
  const f = fixture();
  f.sources.forEach((source) => { source.catalogStatus = "ready"; });
  f.service.limits.maxSourceCharactersPerFile = 300;
  const tools = new LiteratureTools({ registry: f.service.sourceRegistry, preparation: f.literature.preparation });
  f.literatureTools.completeEvidence = tools.completeEvidence.bind(tools);
  f.literatureTools.evidenceCompletionStatus = tools.evidenceCompletionStatus.bind(tools);
  f.artifacts.get("P31").chunks = [
    { chunkId: "mean", page: 2, text: `The mean was 48 kPa. ${"Supporting original discussion. ".repeat(20)}` },
    { chunkId: "count", page: 8, text: `The sample count was n=5. ${"Supporting original discussion. ".repeat(20)}` },
  ];
  f.service.retrievePaperEvidence = async () => [{ paperId: "P31", sourceId: "P31", name: "corrected-material.pdf", relativePath: "literature/corrected-material.pdf",
    analysisStatus: "processed", evidenceType: "original-paper-evidence", content: `[P31:p1:background]\n${"Background. ".repeat(18)}\n[P31:p2:mean]\nThe mean was 48 kPa.` }];
  const context = await f.build("What are the mean and sample count in P31?");
  assert.ok(context.files[0].content.length <= 300);
  assert.equal(context.literature.evidenceCompletion.truncated, true);
  assert.deepEqual(context.literature.evidenceCompletion.missingByPaper, [{ paperId: "P31", dimensions: ["mean"] }]);
  assert.match(context.files[0].content, /n=5/);
});
