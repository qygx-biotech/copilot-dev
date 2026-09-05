"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const {
  SourceRegistry, SourcePreparationService, SourceJobManager, SourceResultStore,
  LiteratureTools, ExperimentTools, CorpusWorkflowService,
} = require("../../docs/source-system.js");
const { ProjectContextService, normalizeStoredConversation } = require("../../docs/project-context-service.js");
const semantic = require("../../shared/semantic-intent.js");
const { LiteratureApiClient } = require("../../docs/literature-module.js");
function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function makeFile(name, content, lastModified) {
  const file = new Blob([content]);
  Object.defineProperties(file, {
    name: { value: name },
    lastModified: { value: lastModified },
  });
  return file;
}

class MemoryWorkspace {
  constructor() {
    this.files = new Map();
    this.json = new Map();
    this.readFileCalls = 0;
    this.counter = 0;
  }

  createId() {
    this.counter += 1;
    return `source-${String(this.counter).padStart(4, "0")}`;
  }

  setFile(path, content, lastModified = Date.now() - 5000) {
    this.files.set(path, makeFile(path.split("/").pop(), content, lastModified));
  }

  deleteFile(path) {
    this.files.delete(path);
  }

  async fileExists(path) {
    return this.files.has(path) || this.json.has(path);
  }

  async readFile(path) {
    this.readFileCalls += 1;
    const file = this.files.get(path);
    if (!file) throw new Error(`missing: ${path}`);
    return file;
  }

  async readJson(path) {
    if (!this.json.has(path)) throw new Error(`missing json: ${path}`);
    return clone(this.json.get(path));
  }

  async writeJson(path, value) {
    this.json.set(path, clone(value));
    return value;
  }
}

function treeFor(workspace) {
  return {
    name: "workspace",
    relativePath: "",
    type: "directory",
    children: [...workspace.files.entries()].map(([path, file]) => ({
      name: path.split("/").pop(),
      relativePath: path,
      type: "file",
      size: file.size,
      lastModified: file.lastModified,
      children: [],
    })),
  };
}

async function makeSystem(workspace, options = {}) {
  const registry = new SourceRegistry({ workspace });
  const jobs = new SourceJobManager({ workspace });
  const results = new SourceResultStore({ workspace, maxInlineCharacters: 2000 });
  let parseCalls = 0;
  const preparation = new SourcePreparationService({
    workspace,
    registry,
    jobs,
    results,
    cryptoProvider: {},
    debounceMilliseconds: 1,
    spreadsheetProvider: options.spreadsheetProvider,
    async parsePaper(input) {
      parseCalls += 1;
      if (options.parsePaper) return options.parsePaper(input);
      const text = new TextDecoder().decode(input.bytes);
      return { text: `# Page 1\n${text}`, pageCount: 1, metadataTitle: null, truncated: false };
    },
    generatePaperCard: options.generatePaperCard,
  });
  const literatureTools = new LiteratureTools({
    registry,
    preparation,
    results,
    nativePdfAnalyzer: options.nativePdfAnalyzer,
    knowledgeService: options.knowledgeService,
  });
  const experimentTools = new ExperimentTools({ registry, preparation, results });
  const corpusWorkflows = new CorpusWorkflowService({
    workspace,
    registry,
    preparation,
    literatureTools,
    results,
    mapWorker: options.mapWorker,
    fallbackMapWorker: options.fallbackMapWorker,
    nativePdfAnalyzer: options.nativePdfAnalyzer,
    knowledgeService: options.knowledgeService,
    mapAttempts: options.mapAttempts,
  });
  return {
    registry,
    jobs,
    results,
    preparation,
    literatureTools,
    experimentTools,
    corpusWorkflows,
    nativePdfAnalyzer: options.nativePdfAnalyzer || null,
    get parseCalls() {
      return parseCalls;
    },
  };
}

function makeLiteratureHarness(system) {
  const documents = system.registry.list({ sourceKind: "paper" }).map((source) => ({
    id: source.sourceId,
    relativePath: source.path,
    filename: source.displayName,
    size: source.sizeBytes,
    lastModified: source.mtimeNs,
    isLiteraturePaper: true,
    paperCardStatus: "pending",
    summaryAvailable: false,
    discovery: { fileName: source.displayName },
  }));
  const sourceSystem = {
    registry: system.registry,
    preparation: system.preparation,
    literatureTools: system.literatureTools,
    experimentTools: system.experimentTools,
    corpusWorkflows: system.corpusWorkflows,
    nativePdfAnalyzer: system.nativePdfAnalyzer,
    projectState: system.projectState,
    managedWorker: system.managedWorker,
    results: system.results,
  };
  return {
    documents,
    sourceSystem,
    preparation: system.preparation,
    findDocumentByPath(path) {
      return documents.find((document) => document.relativePath === path) || null;
    },
    async scan() {
      return documents;
    },
    async createPaperCard() {
      return { summary: null };
    },
  };
}


async function mixedProject() {
  const workspace = new MemoryWorkspace();
  workspace.state = { project: { goal: "EctD optimization", primaryMetric: "hydroxyectoine_titer" }, memory: {} };
  workspace.setFile("literature/english.pdf", "The EctD A163V activity assay was performed at 35°C. Conflicting hydroxyectoine results.");
  workspace.setFile("literature/chinese.pdf", "EctD A163V 羟基依克多因 温度 活性 实验条件。");
  workspace.setFile("experiments/english.csv", "Protein,Variant,Temperature (°C),Hydroxyectoine Titer (g/L)\nEctD,A163V,30,5\nEctD,T212S,31,3");
  workspace.setFile("experiments/chinese.csv", "蛋白,突变体,温度（℃）,羟基依克多因产量（g/L）\nEctD,A163V,30,5\nEctD,T212S,31,3");
  const system = await makeSystem(workspace);
  await system.registry.reconcile(treeFor(workspace));
  const literature = makeLiteratureHarness(system);
  literature.api = {};
  const service = new ProjectContextService({ workspace, literature });
  return { workspace, system, literature, service, workspaceTree: treeFor(workspace) };
}

test("end-to-end EN/ZH corpus paraphrases use the same existing workflow and preserve evidence", async () => {
  const h = await mixedProject();
  const original = await Promise.all([...h.workspace.files.values()].map((file) => file.text()));
  const runs = [];
  const run = h.system.corpusWorkflows.run.bind(h.system.corpusWorkflows);
  h.system.corpusWorkflows.run = (question, options) => { runs.push({ question, options }); return run(question, options); };
  for (const [question, language] of [["Write a review using all papers.", "en"], ["把所有论文综合成一个综述。", "zh"]]) {
    const context = await h.service.buildContext({ question, workspaceTree: h.workspaceTree, retrievalProfile: "light" });
    assert.equal(context.semantic.ir.matchedPattern, "literature.corpus_synthesis");
    assert.equal(context.semantic.ir.answerLanguage, language);
    assert.equal(context.literature.discoveryMode, "corpus");
    assert.equal(context.literature.coverage.papersIncludedInSnapshot, 2);
    assert.equal(context.semantic.telemetry.semantic.remoteSemanticParserUsed, false);
  }
  assert.equal(runs.length, 2);
  assert.deepEqual(runs[0].options.paperIds, runs[1].options.paperIds);
  assert.deepEqual(await Promise.all([...h.workspace.files.values()].map((file) => file.text())), original);
});

test("novel cross-source composition prepares both domains and computes rank deterministically", async () => {
  const h = await mixedProject();
  // Model an already searchable mixed-language library; generic new filenames
  // remain inventory until the existing readiness workflow prepares evidence.
  await h.system.preparation.ensureSourceReady(h.system.registry.list({ sourceKind: "paper" }).map((source) => source.sourceId), "search");
  const context = await h.service.buildContext({
    question: "Find the top five experimental EctD variants, look for contradictory literature, ignore comparisons where temperature differs by more than 5°C, and explain what remains.",
    retrievalProfile: "light", workspaceTree: h.workspaceTree,
  });
  assert.equal(context.semantic.ir.matchedPattern, null);
  assert.ok(context.semantic.ir.operations.includes("rank"));
  assert.ok(context.semantic.ir.objects.includes("experiments"));
  assert.ok(context.semantic.ir.objects.includes("literature"));
  assert.equal(context.semantic.ir.requestedOutput.limit, 5);
  assert.equal(context.semanticExperimentResult.status, "ready");
  assert.equal(context.semanticExperimentResult.records[0].values.mutation, "A163V");
  assert.equal(context.semanticExperimentResult.records[0].values.hydroxyectoine_titer, 5);
  assert.ok(context.semanticExperimentResult.unappliedConstraints.some((item) => item.field === "temperature_difference"));
  assert.ok(context.experiments.relevantExperimentIds.length);
  assert.ok(context.semantic.plan.steps.length > 1);
  const backend = require("../index.js")._test;
  const agent = require("../side-chat-agent.js");
  const local = backend.sanitizeLocalWorkspaceContext(context, context.semantic.ir.goal);
  const knowledge = agent.createSideChatKnowledgeBase({ localWorkspaceContext: local });
  const paper = knowledge.paperLookup.papers.find((item) => item.item.content.includes("assay was performed at 35°C"));
  assert.ok(paper, "ranked entity search must prepare original supporting paper evidence");
  const output = JSON.parse(agent.executeSideChatTool({ function: {
    name: "query_experiment_results", arguments: JSON.stringify({ literature_comparisons: [{
      experiment_id: context.semanticExperimentResult.records[0].experimentId,
      paper_id: paper.paperId,
      evidence_quote: "The EctD A163V activity assay was performed at 35°C.",
      reported_temperature: 35, unit: "degC",
    }] }),
  } }, knowledge));
  assert.equal(output.results[0].temperature_difference, 5, JSON.stringify(output));
  assert.equal(output.results[0].eligible, true);
  assert.ok(output.results[0].provenance.experiment.sourceSheet);
});

test("both surfaces share semantics and Side Chat cannot authorize recommendation mutation", async () => {
  const h = await mixedProject();
  const input = { question: "Update our current recommendation based on these experiments.", workspaceTree: h.workspaceTree };
  const chat = await h.service.buildContext({ ...input, surface: "side_chat" });
  const command = await h.service.buildContext({ ...input, surface: "agent_command" });
  assert.deepEqual(chat.semantic.ir, command.semantic.ir);
  assert.ok(chat.semantic.plan.blocked.includes("update_recommendation"));
  assert.ok(!command.semantic.plan.blocked.includes("update_recommendation"));
});

test("Medium and High integrate one bounded parser call without the old context-router call", async () => {
  for (const profile of ["medium", "high"]) {
    const h = await mixedProject();
    let calls = 0;
    h.literature.api.interpretSemantics = async (payload) => {
      calls += 1;
      assert.ok(JSON.stringify(payload).length < 20000);
      assert.equal(JSON.stringify(payload).includes("english.pdf"), false);
      return semantic.interpretLocal(payload);
    };
    h.literature.api.routeContext = () => { throw new Error("redundant context router must not be called"); };
    const context = await h.service.buildContext({ question: "Rank EctD variants and compare with contradictory literature at similar temperature.", workspaceTree: h.workspaceTree, retrievalProfile: profile });
    assert.equal(calls, 1);
    assert.equal(context.semantic.telemetry.semantic.remoteSemanticParserUsed, true);
    assert.equal(context.routing.mode, "semantic");
  }
});

test("semantic FC client uses authenticated bounded transport without request retries", async () => {
  let calls = 0;
  const api = new LiteratureApiClient({ baseUrl: "https://example.invalid", getHeaders: () => ({ Authorization: "Bearer fixture" }), fetch: async (url, options) => {
    calls += 1;
    assert.ok(url.endsWith("/api/semantic/interpret"));
    assert.equal(options.headers.Authorization, "Bearer fixture");
    return { ok: false, status: 504, json: async () => ({ ok: false }) };
  } });
  await assert.rejects(api.interpretSemantics({ query: "hello", callContext: { turnId: "test-turn", profile: "medium" } }));
  assert.equal(calls, 1);
  assert.equal(api.getTurnCallCounts("test-turn").semantic_parser, 1);
});


test("open corpus-plus-experiment compositions retain full corpus coverage", async () => {
  const h = await mixedProject();
  const context = await h.service.buildContext({ question: "Summarize all papers and rank the experiment variants.", workspaceTree: h.workspaceTree, retrievalProfile: "light" });
  assert.equal(context.semantic.ir.matchedPattern, null);
  assert.ok(context.semantic.ir.capabilityHints.includes("corpus_workflow"));
  assert.equal(context.literature.discoveryMode, "corpus");
  assert.equal(context.literature.coverage.papersIncludedInSnapshot, 2);
  assert.equal(context.semanticExperimentResult.status, "ready");
});

test("persisted semantic telemetry strips project content and private reasoning", () => {
  const { normalizeSemanticTelemetry } = require("../../docs/project-context-service.js");
  const compact = normalizeSemanticTelemetry({ profile: "medium", semantic: { localPattern: "experiment.rank", finalPattern: "experiment.rank", localConfidence: 0.95, matchState: "known", privateReasoning: "secret" }, operations: ["rank", "exec"], capabilitiesUsed: ["query_experiment_results", "shell"], cloudCalls: { semantic_parser: 1, answer: 2, secret: 9 }, query: "private experiment data" });
  assert.equal(JSON.stringify(compact).includes("secret"), false);
  assert.equal(JSON.stringify(compact).includes("private"), false);
  assert.deepEqual(compact.operations, ["rank"]);
  assert.deepEqual(compact.capabilitiesUsed, ["query_experiment_results"]);
  assert.equal(compact.cloudCalls.semantic_parser, 1);
});
