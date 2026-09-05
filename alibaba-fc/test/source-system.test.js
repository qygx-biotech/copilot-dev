"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { webcrypto } = require("node:crypto");

const {
  SourceRegistry,
  SourcePreparationService,
  SourceJobManager,
  SourceResultStore,
  LiteratureTools,
  ExperimentTools,
  CorpusWorkflowService,
  ManagedLocalWorker,
  ProjectStateService,
  RequestyPdfAnalyzer,
  TOOL_EFFECTS,
  ToolEffect,
  authorizeTool,
  paperCardCacheKey,
} = require("../../docs/source-system.js");
const {
  ElectronQmdKnowledgeService,
} = require("../../docs/knowledge-service.js");
const {
  CLOUD_RETRIEVAL,
} = require("../../shared/retrieval-contract.js");
const {
  ProjectContextService,
  detectCorpusWideLiteratureIntent,
  detectCorpusUpdateIntent,
} = require("../../docs/project-context-service.js");

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

function validMapFor(input, theme = "recovered theme") {
  return {
    relevance: "high",
    themes: [theme],
    findings: input.evidence.slice(0, 1).map((item) => ({
      claim: item.claimCandidate,
      evidenceRefs: [item.evidenceRef],
    })),
    methods: [],
    organisms: [],
    genes: [],
    proteins: [],
    pathways: [],
    experimentalStrategies: [],
    limitations: [],
    connectionsToOtherTopics: [],
  };
}

const FC_ROUTES = Object.freeze({
  config: "/api/knowledge/config",
  plan: "/api/knowledge/plan-search",
  rerank: "/api/knowledge/rerank",
  map: "/api/corpus/map-paper",
  summarize: "/api/literature/summarize-chunk",
  paperCardSynthesize: "/api/literature/synthesize",
  nativePdf: "/api/literature/analyze-pdf-native",
  global: "final/global synthesis or answer",
});

function makeRouteCounters() {
  const counts = Object.fromEntries(Object.values(FC_ROUTES).map((route) => [route, 0]));
  return {
    counts,
    hit(route) {
      assert.ok(Object.hasOwn(counts, route), `Unknown FC test route: ${route}`);
      counts[route] += 1;
    },
    reset() {
      for (const route of Object.keys(counts)) counts[route] = 0;
    },
  };
}

function assertRouteCounts(counters, expected) {
  assert.deepEqual(counters.counts, {
    [FC_ROUTES.config]: expected.config || 0,
    [FC_ROUTES.plan]: expected.plan || 0,
    [FC_ROUTES.rerank]: expected.rerank || 0,
    [FC_ROUTES.map]: expected.map || 0,
    [FC_ROUTES.summarize]: expected.summarize || 0,
    [FC_ROUTES.paperCardSynthesize]: expected.paperCardSynthesize || 0,
    [FC_ROUTES.nativePdf]: expected.nativePdf || 0,
    [FC_ROUTES.global]: expected.global || 0,
  });
}

function validCanonicalPaperCard(source, contentHash) {
  const descriptor = {
    contentHash,
    schemaVersion: 1,
    model: "paper-card-test-model",
    promptVersion: 1,
  };
  const finding = `EctD finding from ${source.displayName}.`;
  return {
    schemaVersion: 1,
    paperCardVersion: 1,
    paperId: source.sourceId,
    documentId: source.sourceId,
    fileName: source.displayName,
    generatedAt: "2026-09-04T00:00:00.000Z",
    source: {
      filename: source.displayName,
      relativePath: source.path,
      hash: contentHash,
    },
    model: descriptor.model,
    promptVersion: descriptor.promptVersion,
    cacheKey: paperCardCacheKey(descriptor),
    title: `Card for ${source.displayName}`,
    authors: ["Test Author"],
    year: 2026,
    abstractSummary: "",
    researchQuestion: "What did this paper report?",
    mainFindings: [finding],
    methods: ["bounded local analysis"],
    methodsSummary: "",
    organisms: [],
    genes: ["ectD"],
    proteins: ["EctD"],
    pathways: [],
    metabolites: [],
    experimentalConditions: [],
    measurements: [],
    importantResults: [finding],
    limitations: [],
    keywords: ["EctD"],
    topics: ["enzyme analysis"],
    shortSummary: finding,
    summary: finding,
    keyResults: [finding],
    mainConclusion: finding,
  };
}

function paperCardGenerator(workspace, counters) {
  return async ({ source, contentHash }) => {
    counters?.hit(FC_ROUTES.summarize);
    counters?.hit(FC_ROUTES.paperCardSynthesize);
    const card = validCanonicalPaperCard(source, contentHash);
    const path = `.biodesign/literature/summaries/${source.sourceId}.json`;
    await workspace.writeJson(path, card);
    return {
      path,
      card,
      schemaVersion: 1,
      model: card.model,
      promptVersion: card.promptVersion,
      contentHash,
    };
  };
}

async function makeRouteCountedDeepKnowledgeService(workspace, counters, trace) {
  const plannerSignature = "a".repeat(64);
  const rerankerSignature = "b".repeat(64);
  const desktop = {
    knowledge: {
      onProgress: () => () => {},
      initialize: async () => ({ available: true }),
      search: async (payload) => {
        trace.localSearches.push(clone(payload));
        return {
          mode: "fast",
          diagnostics: { mode: "fast" },
          results: (payload.paperIds || []).map((paperId) => ({
            paperId,
            title: paperId,
            score: 1,
            matchedSections: [{
              snippet: `Page 1 EctD finding from ${paperId}.`,
              qmdDoc: `${paperId}-P1-C1`,
              score: 1,
            }],
          })),
        };
      },
      update: async () => ({}),
      embed: async () => [],
      status: async () => ({ available: true }),
      document: async () => null,
    },
  };
  const service = new ElectronQmdKnowledgeService({
    desktop,
    workspace,
    cryptoProvider: webcrypto,
    cloudApi: {
      async getKnowledgeRetrievalConfig() {
        counters.hit(FC_ROUTES.config);
        return {
          ok: true,
          schemaVersion: CLOUD_RETRIEVAL.schemaVersion,
          searchPlanPromptVersion: CLOUD_RETRIEVAL.searchPlanPromptVersion,
          rerankPromptVersion: CLOUD_RETRIEVAL.rerankPromptVersion,
          plannerSignature,
          rerankerSignature,
        };
      },
      async planKnowledgeSearch(payload) {
        counters.hit(FC_ROUTES.plan);
        trace.plannerPayloads.push(clone(payload));
        await new Promise((resolve) => setTimeout(resolve, trace.plannerDelayMs));
        if (trace.failPlanner) throw new Error("controlled planner outage");
        return {
          ok: true,
          configurationSignature: plannerSignature,
          plan: {
            queries: [],
            identifiers: [],
            sourceLanguage: /[\u3400-\u9fff]/u.test(payload.query) ? "zh" : "en",
            reasoningSummary: "The common corpus question needs no expansion.",
          },
        };
      },
      async rerankKnowledgeCandidates(payload) {
        counters.hit(FC_ROUTES.rerank);
        trace.rerankPayloads.push(clone(payload));
        return {
          ok: true,
          configurationSignature: rerankerSignature,
          ranked: payload.candidates.map((candidate) => ({
            candidateId: candidate.candidateId,
            score: 1,
            reason: "Paper-scoped evidence.",
          })),
        };
      },
    },
  });
  await service.initialize({ workspaceId: "corpus-route-counter-test" });
  return service;
}

async function createCorpusScenario(paperCount, cardIndexes = [], options = {}) {
  const workspace = new MemoryWorkspace();
  for (let index = 0; index < paperCount; index += 1) {
    workspace.setFile(
      `literature/paper-${index + 1}.pdf`,
      `EctD finding from paper-${index + 1}.pdf.`,
      1000
    );
  }
  const counters = makeRouteCounters();
  const trace = {
    failPlanner: options.failPlanner === true,
    plannerDelayMs: Math.max(0, Number(options.plannerDelayMs) || 5),
    plannerPayloads: [],
    rerankPayloads: [],
    localSearches: [],
    retrievalOperations: [],
    mapperInputs: [],
    mapperOptions: [],
  };
  const knowledgeService = await makeRouteCountedDeepKnowledgeService(
    workspace,
    counters,
    trace
  );
  const system = await makeSystem(workspace, {
    knowledgeService,
    generatePaperCard: paperCardGenerator(workspace, counters),
    async mapWorker(input, workerOptions) {
      counters.hit(FC_ROUTES.map);
      trace.mapperInputs.push(clone(input));
      trace.mapperOptions.push(clone({
        attempt: workerOptions?.attempt,
        turnId: workerOptions?.turnId,
        workflowId: workerOptions?.workflowId,
        paperId: workerOptions?.paperId,
        profile: workerOptions?.profile,
      }));
      return validMapFor(input, "provider-mapped");
    },
    nativePdfAnalyzer: {
      async analyze() {
        counters.hit(FC_ROUTES.nativePdf);
        throw new Error("Native PDF must not be called by this fixture.");
      },
    },
  });
  await system.registry.reconcile(treeFor(workspace));
  const paperIds = system.registry.list({ sourceKind: "paper" }).map((source) => source.sourceId);
  for (const index of cardIndexes) {
    await system.preparation.ensureSourceReady([paperIds[index]], "paper_card");
  }
  const searchPaperContent = system.literatureTools.searchPaperContent.bind(
    system.literatureTools
  );
  system.literatureTools.searchPaperContent = async (paperId, query, searchOptions) => {
    trace.retrievalOperations.push({
      paperId,
      query,
      paperIds: [paperId],
      sharedPlanCacheKey: searchOptions?.sharedRetrievalPlan?.cacheKey || "",
      sharedPlan: searchOptions?.sharedRetrievalPlan || null,
      callContext: clone(searchOptions?.callContext || {}),
    });
    return searchPaperContent(paperId, query, searchOptions);
  };
  counters.reset();
  return { workspace, counters, knowledgeService, system, paperIds, trace };
}

function invalidMapperError() {
  const error = new Error("The corpus mapper did not return valid structured JSON.");
  error.code = "InvalidLlmResponse";
  return error;
}

async function resolveWorkflowResult(system, result) {
  return result?.resultHandle
    ? system.results.read(result.resultHandle)
    : result;
}

test("folder reconciliation catalogs 150 papers without full hashes, parses, or LLM calls", async () => {
  const workspace = new MemoryWorkspace();
  for (let index = 0; index < 150; index += 1) {
    workspace.setFile(`literature/paper-${index + 1}.pdf`, `paper ${index + 1}`);
  }
  const system = await makeSystem(workspace);
  const result = await system.registry.reconcile(treeFor(workspace));

  assert.equal(result.sources.length, 150);
  assert.equal(result.metrics.lastStatCalls, 150);
  assert.equal(result.metrics.fullHashCallsDuringReconciliation, 0);
  assert.equal(result.metrics.llmCallsDuringReconciliation, 0);
  assert.equal(system.preparation.metrics.fullHashCalls, 0);
  assert.equal(system.parseCalls, 0);
  assert.equal(workspace.readFileCalls, 0);
});

test("TEST A: 32 discovered papers produce exactly 32 successful mapper calls", async () => {
  const workspace = new MemoryWorkspace();
  for (let index = 1; index <= 32; index += 1) {
    workspace.setFile(
      `literature/paper-${String(index).padStart(2, "0")}.pdf`,
      `Paper ${index} reports evidence for corpus theme ${index % 4}.`,
      1000
    );
  }
  let mapCalls = 0;
  const system = await makeSystem(workspace, {
    async mapWorker(input) {
      mapCalls += 1;
      return validMapFor(input, `corpus theme ${mapCalls % 4}`);
    },
  });
  await system.registry.reconcile(treeFor(workspace));
  const literature = makeLiteratureHarness(system);
  const service = new ProjectContextService({ workspace, literature });
  const progress = [];

  assert.equal(system.registry.counts().papersSearchable, 0);
  const context = await service.buildContext({
    question: "Summarize all papers",
    selectedPaths: [],
    selectedPaperIds: [],
    workspaceTree: treeFor(workspace),
    onProgress(update) {
      if (update.workflowId) progress.push(update);
    },
  });
  assert.equal(context.literature.corpusWideRequest, true);
  assert.equal(context.literature.discoveryMode, "corpus");
  assert.equal(context.literature.relevantPaperIds.length, 32);
  assert.equal(context.literature.coverage.papersIncludedInSnapshot, 32);
  assert.equal(context.literature.coverage.papersSuccessfullyPrepared, 32);
  assert.equal(context.literature.coverage.papersSuccessfullyAnalyzed, 32);
  assert.equal(system.registry.counts().papersSearchable, 32);
  assert.equal(system.preparation.metrics.fullHashCalls, 32);
  assert.equal(system.parseCalls, 32);
  assert.equal(mapCalls, 32);
  assert.equal(context.files[0].evidenceType, "corpus-workflow");
  assert.ok(progress.some((update) => update.stage === "corpus-prepare"));
  assert.ok(progress.some((update) => update.stage === "corpus-map"));
  const completedMapUpdates = progress.filter(
    (update) => update.stage === "corpus-map" && update.paperId
  );
  assert.deepEqual(
    completedMapUpdates.map((update) => update.completed),
    Array.from({ length: 32 }, (_, index) => index + 1)
  );
  assert.ok(completedMapUpdates.every((update) => update.total === 32));
  assert.ok(completedMapUpdates.every((update) => update.outcome === "analyzed"));
  assert.equal(new Set(completedMapUpdates.map((update) => update.paperId)).size, 32);
  assert.doesNotMatch(context.files[0].content, /cannot summarize|cannot analyze/i);

  for (const retrievalProfile of ["medium", "high"]) {
    const repeated = await service.buildContext({
      question: "Summarize all papers",
      selectedPaths: [],
      selectedPaperIds: [],
      workspaceTree: treeFor(workspace),
      retrievalProfile,
    });
    assert.equal(repeated.literature.corpusWideRequest, true);
    assert.equal(repeated.literature.discoveryMode, "corpus");
  }
  assert.equal(mapCalls, 32, "profile changes must reuse the valid corpus synthesis/maps");
});

test("restart follow-ups retain all nested literature metadata despite stale chat claims", async () => {
  const workspace = new MemoryWorkspace();
  workspace.setFile("literature/.DS_Store", "metadata", 1000);
  for (let index = 1; index <= 32; index += 1) {
    workspace.setFile(
      `literature/imported-library/paper-${String(index).padStart(2, "0")}.pdf`,
      `Nested paper ${index}.`,
      1000
    );
  }
  const nestedTree = {
    name: "workspace",
    relativePath: "",
    type: "directory",
    children: [
      {
        name: "literature",
        relativePath: "literature",
        type: "directory",
        children: [
          {
            name: ".DS_Store",
            relativePath: "literature/.DS_Store",
            type: "file",
            size: workspace.files.get("literature/.DS_Store").size,
            lastModified: 1000,
            children: [],
          },
          {
            name: "imported-library",
            relativePath: "literature/imported-library",
            type: "directory",
            children: Array.from({ length: 32 }, (_, index) => {
              const relativePath = `literature/imported-library/paper-${String(index + 1).padStart(2, "0")}.pdf`;
              const file = workspace.files.get(relativePath);
              return {
                name: relativePath.split("/").at(-1),
                relativePath,
                type: "file",
                size: file.size,
                lastModified: file.lastModified,
                children: [],
              };
            }),
          },
        ],
      },
    ],
  };
  const system = await makeSystem(workspace);
  await system.registry.reconcile(nestedTree);
  const literature = makeLiteratureHarness(system);
  const service = new ProjectContextService({ workspace, literature });

  const context = await service.buildContext({
    question: "Restart the analysis processing workflow.",
    selectedPaths: [],
    selectedPaperIds: [],
    workspaceTree: nestedTree,
    conversation: {
      messages: [
        {
          id: "old-assistant-claim",
          role: "assistant",
          content: "There are no readable literature files; only .DS_Store is present.",
          createdAt: "2026-08-28T10:00:00.000Z",
        },
      ],
    },
  });

  const paperInventory = context.inventory.filter(
    (item) => item.sourceKind === "paper"
  );
  assert.equal(system.registry.counts().papersDiscovered, 32);
  assert.equal(paperInventory.length, 32);
  assert.ok(
    paperInventory.every((item) =>
      item.relativePath.startsWith("literature/imported-library/")
    )
  );
});

test("corpus intent detector covers English and Chinese whole-library requests", () => {
  for (const question of [
    "summarize my literature",
    "review all papers in this project",
    "write a literature review based on my papers",
    "what are the major themes across all my papers?",
    "compare the overall findings of the literature",
    "How many papers in the folder? Help me write a literature reviews.",
    "我总共有多少篇文献，帮我总结一下内容",
    "帮我对所有文献写一个综述",
    "总结整个文献库",
  ]) assert.equal(detectCorpusWideLiteratureIntent(question), true, question);
  for (const question of [
    "What is kcat?",
    "Summarize this paper.",
    "Compare these papers and their experimental designs.",
  ]) assert.equal(detectCorpusWideLiteratureIntent(question), false, question);
});

test("TEST C: a generic concept question does not prepare the 32-paper corpus", async () => {
  const workspace = new MemoryWorkspace();
  for (let index = 1; index <= 32; index += 1) {
    workspace.setFile(`literature/paper-${index}.pdf`, `Paper ${index}.`, 1000);
  }
  const system = await makeSystem(workspace);
  await system.registry.reconcile(treeFor(workspace));
  const literature = makeLiteratureHarness(system);
  const service = new ProjectContextService({ workspace, literature });

  for (const retrievalProfile of ["light", "medium", "high"]) {
    const context = await service.buildContext({
      question: "What is kcat?",
      selectedPaths: [],
      selectedPaperIds: [],
      workspaceTree: treeFor(workspace),
      retrievalProfile,
    });
    assert.equal(context.literature.corpusWideRequest, false);
    assert.equal(context.literature.discoveryMode, "not-needed");
  }
  assert.equal(system.preparation.metrics.fullHashCalls, 0);
  assert.equal(system.parseCalls, 0);
});

test("TEST D: summarizing one selected paper prepares only that paper", async () => {
  const workspace = new MemoryWorkspace();
  for (let index = 1; index <= 32; index += 1) {
    workspace.setFile(`literature/paper-${index}.pdf`, `Paper ${index} evidence.`, 1000);
  }
  const system = await makeSystem(workspace);
  await system.registry.reconcile(treeFor(workspace));
  const literature = makeLiteratureHarness(system);
  const selected = literature.documents[0];
  const service = new ProjectContextService({ workspace, literature });

  const context = await service.buildContext({
    question: "Summarize this paper.",
    selectedPaths: [selected.relativePath],
    selectedPaperIds: [selected.id],
    workspaceTree: treeFor(workspace),
  });

  assert.equal(context.literature.discoveryMode, "selected");
  assert.deepEqual(context.literature.relevantPaperIds, [selected.id]);
  assert.equal(system.preparation.metrics.fullHashCalls, 1);
  assert.equal(system.parseCalls, 1);
  assert.equal(system.registry.counts().papersSearchable, 1);
});

test("TEST E: reviewing selected papers snapshots only the three selected sources", async () => {
  const workspace = new MemoryWorkspace();
  for (let index = 1; index <= 32; index += 1) {
    workspace.setFile(`literature/paper-${index}.pdf`, `Paper ${index} evidence.`, 1000);
  }
  const system = await makeSystem(workspace);
  await system.registry.reconcile(treeFor(workspace));
  const literature = makeLiteratureHarness(system);
  const selected = literature.documents.slice(0, 3);
  const service = new ProjectContextService({ workspace, literature });

  const context = await service.buildContext({
    question: "Write a review of these papers.",
    selectedPaths: selected.map((document) => document.relativePath),
    selectedPaperIds: selected.map((document) => document.id),
    workspaceTree: treeFor(workspace),
  });

  assert.equal(context.literature.corpusWideRequest, true);
  assert.equal(context.literature.corpusScope, "selected");
  assert.deepEqual(context.literature.relevantPaperIds, selected.map((item) => item.id));
  assert.equal(context.literature.coverage.papersIncludedInSnapshot, 3);
  assert.equal(context.literature.coverage.papersSuccessfullyAnalyzed, 3);
  assert.equal(system.preparation.metrics.fullHashCalls, 3);
  assert.equal(system.parseCalls, 3);
  assert.equal(system.registry.counts().papersSearchable, 3);
});

test("a paper is prepared lazily once and unchanged follow-ups reuse hash and text", async () => {
  const workspace = new MemoryWorkspace();
  workspace.setFile("literature/EctD-A163V.pdf", "EctD A163V increased activity and kcat.", 1000);
  const system = await makeSystem(workspace);
  await system.registry.reconcile(treeFor(workspace));
  const source = system.registry.list({ sourceKind: "paper" })[0];

  assert.equal(source.hashStatus, "absent");
  assert.equal(system.preparation.metrics.fullHashCalls, 0);
  await system.preparation.ensureSourceReady([source.sourceId], "search");
  await system.preparation.ensureSourceReady([source.sourceId], "search");

  assert.equal(system.preparation.metrics.fullHashCalls, 1);
  assert.equal(system.parseCalls, 1);
  assert.equal(system.registry.get(source.sourceId).indexStatus, "ready");
  assert.equal(system.registry.get(source.sourceId).paperCardStatus, "absent");
});

test("timestamp-only changes rehash but reuse artifacts; content changes rebuild only the source", async () => {
  const workspace = new MemoryWorkspace();
  workspace.setFile("literature/a.pdf", "stable scientific evidence", 1000);
  workspace.setFile("literature/b.pdf", "unrelated paper", 1000);
  const system = await makeSystem(workspace);
  await system.registry.reconcile(treeFor(workspace));
  const sourceA = system.registry.getByPath("literature/a.pdf");
  await system.preparation.ensureSourceReady([sourceA.sourceId], "search");

  workspace.setFile("literature/a.pdf", "stable scientific evidence", 2000);
  await system.registry.reconcile(treeFor(workspace));
  assert.equal(system.registry.get(sourceA.sourceId).catalogStatus, "dirty");
  await system.preparation.ensureSourceReady([sourceA.sourceId], "search");
  assert.equal(system.preparation.metrics.fullHashCalls, 2);
  assert.equal(system.parseCalls, 1);

  workspace.setFile("literature/a.pdf", "changed A163V evidence", 3000);
  await system.registry.reconcile(treeFor(workspace));
  await system.preparation.ensureSourceReady([sourceA.sourceId], "search");
  assert.equal(system.preparation.metrics.fullHashCalls, 3);
  assert.equal(system.parseCalls, 2);
  assert.equal(system.registry.getByPath("literature/b.pdf").hashStatus, "absent");
});

test("deletion removes a source from active selection without hashing", async () => {
  const workspace = new MemoryWorkspace();
  workspace.setFile("literature/a.pdf", "paper A", 1000);
  const system = await makeSystem(workspace);
  await system.registry.reconcile(treeFor(workspace));
  const sourceId = system.registry.getByPath("literature/a.pdf").sourceId;
  workspace.deleteFile("literature/a.pdf");
  const result = await system.registry.reconcile(treeFor(workspace));

  assert.equal(system.registry.get(sourceId), null);
  assert.equal(system.registry.get(sourceId, { includeMissing: true }).catalogStatus, "missing");
  assert.deepEqual(result.changes.missing, [sourceId]);
  assert.equal(system.preparation.metrics.fullHashCalls, 0);
});

test("concurrent requests share one source preparation job", async () => {
  const workspace = new MemoryWorkspace();
  workspace.setFile("literature/a.pdf", "paper evidence", 1000);
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const system = await makeSystem(workspace, {
    async parsePaper(input) {
      await gate;
      return {
        text: `# Page 1\n${new TextDecoder().decode(input.bytes)}`,
        pageCount: 1,
        truncated: false,
      };
    },
  });
  await system.registry.reconcile(treeFor(workspace));
  const sourceId = system.registry.list({ sourceKind: "paper" })[0].sourceId;
  const first = system.preparation.ensureSourceReady([sourceId], "search");
  const second = system.preparation.ensureSourceReady([sourceId], "search");
  release();
  await Promise.all([first, second]);

  assert.equal(system.preparation.metrics.fullHashCalls, 1);
  assert.equal(system.parseCalls, 1);
});

test("different concurrent readiness requests serialize on the same source", async () => {
  const workspace = new MemoryWorkspace();
  workspace.setFile("literature/a.pdf", "paper evidence", 1000);
  let cardCalls = 0;
  const system = await makeSystem(workspace, {
    async generatePaperCard({ source, contentHash }) {
      cardCalls += 1;
      const path = `.biodesign/literature/summaries/${source.sourceId}.json`;
      await workspace.writeJson(path, {
        paperId: source.sourceId,
        contentHash,
      });
      return { path, schemaVersion: 1, model: "test-model", promptVersion: 1 };
    },
  });
  await system.registry.reconcile(treeFor(workspace));
  const sourceId = system.registry.list({ sourceKind: "paper" })[0].sourceId;

  await Promise.all([
    system.preparation.ensureSourceReady([sourceId], "search"),
    system.preparation.ensureSourceReady([sourceId], "paper_card"),
  ]);

  assert.equal(system.preparation.metrics.fullHashCalls, 1);
  assert.equal(system.parseCalls, 1);
  assert.equal(cardCalls, 1);
  assert.equal(system.registry.get(sourceId).paperCardStatus, "ready");
});

test("a file changed during parsing rejects the artifact", async () => {
  const workspace = new MemoryWorkspace();
  workspace.setFile("literature/a.pdf", "initial", 1000);
  const system = await makeSystem(workspace, {
    async parsePaper(input) {
      workspace.setFile("literature/a.pdf", "changed while parsing", 2000);
      return {
        text: `# Page 1\n${new TextDecoder().decode(input.bytes)}`,
        pageCount: 1,
        truncated: false,
      };
    },
  });
  await system.registry.reconcile(treeFor(workspace));
  const sourceId = system.registry.list({ sourceKind: "paper" })[0].sourceId;

  await assert.rejects(
    system.preparation.ensureSourceReady([sourceId], "search"),
    (error) => error.code === "SOURCE_CHANGED_DURING_PREPARATION"
  );
  const rejected = system.registry.get(sourceId);
  assert.equal(rejected.catalogStatus, "dirty");
  assert.equal(rejected.hashStatus, "absent");
  assert.equal(rejected.indexStatus, "not_started");
  assert.equal(rejected.artifacts.paperText, undefined);
});

test("parser failures persist on the source and retry without an unnecessary rehash", async () => {
  const workspace = new MemoryWorkspace();
  workspace.setFile("literature/a.pdf", "retryable paper", 1000);
  let shouldFail = true;
  const system = await makeSystem(workspace, {
    async parsePaper(input) {
      if (shouldFail) throw new Error("parser exploded");
      return {
        text: `# Page 1\n${new TextDecoder().decode(input.bytes)}`,
        pageCount: 1,
        truncated: false,
      };
    },
  });
  await system.registry.reconcile(treeFor(workspace));
  const sourceId = system.registry.list({ sourceKind: "paper" })[0].sourceId;

  await assert.rejects(
    system.preparation.ensureSourceReady([sourceId], "search"),
    /parser exploded/
  );
  const failed = system.registry.get(sourceId);
  assert.equal(failed.hashStatus, "ready");
  assert.equal(failed.parseStatus, "failed");
  assert.equal(failed.indexStatus, "failed");
  assert.match(failed.error.message, /parser exploded/);

  shouldFail = false;
  await system.preparation.ensureSourceReady([sourceId], "search");
  assert.equal(system.preparation.metrics.fullHashCalls, 1);
  assert.equal(system.parseCalls, 2);
  assert.equal(system.registry.get(sourceId).indexStatus, "ready");
});

test("experiment CSV values are normalized lazily with provenance and replaced on change", async () => {
  const workspace = new MemoryWorkspace();
  workspace.state = {
    schemaVersion: 1,
    project: { goal: "Compare EctD assay results." },
    ui: {},
    agent: { currentRecommendation: { id: "R1" } },
    memory: {},
  };
  workspace.setFile(
    "experiments/strain-engineering/run.csv",
    "protein,mutation,activity,unit\nEctD,A163V,4.8,U/mg\nEctD,WT,3.1,U/mg",
    1000
  );
  const system = await makeSystem(workspace);
  await system.registry.reconcile(treeFor(workspace));
  const source = system.registry.list({ sourceKind: "experiment" })[0];
  assert.equal(source.structuredDataStatus, "not_started");

  const first = await system.experimentTools.queryExperimentResults({
    experimentSourceIds: [source.sourceId],
    mutations: ["A163V"],
  });
  assert.equal(first.length, 1);
  assert.equal(first[0].raw.activity, "4.8");
  assert.equal(first[0].provenance.sourceFile, source.path);
  assert.equal(first[0].provenance.sourceRange, "A2:D2");
  const comparison = await system.experimentTools.compareExperimentGroups(
    { experimentSourceIds: [source.sourceId], mutations: ["A163V"] },
    { experimentSourceIds: [source.sourceId], mutations: ["WT"] },
    "activity"
  );
  assert.equal(comparison.groupA.value, 4.8);
  assert.equal(comparison.groupB.value, 3.1);
  const range = await system.experimentTools.readExperimentSource(source.sourceId, {
    range: "A1:C2",
  });
  assert.deepEqual(range[0].rows, [
    ["protein", "mutation", "activity"],
    ["EctD", "A163V", "4.8"],
  ]);

  workspace.setFile(
    source.path,
    "protein,mutation,activity,unit\nEctD,A163V,5.2,U/mg",
    2000
  );
  await system.registry.reconcile(treeFor(workspace));
  const second = await system.experimentTools.queryExperimentResults({
    experimentSourceIds: [source.sourceId],
    mutations: ["A163V"],
  });
  assert.equal(second.length, 1);
  assert.equal(second[0].raw.activity, "5.2");
  assert.equal(system.preparation.metrics.experimentParseCalls, 2);
  const projectState = new ProjectStateService({
    workspace,
    registry: system.registry,
    jobs: system.jobs,
    corpusWorkflows: system.corpusWorkflows,
  });
  const memory = await projectState.updateMemory(
    {
      kind: "experiment_note",
      text: "A163V exceeded WT in the recorded activity assay.",
      experimentIds: [source.sourceId],
    },
    { surface: "side_chat" }
  );
  const metadata = await projectState.refreshMetadata({ surface: "side_chat" });
  const rawFile = await workspace.readFile(source.path);
  const rawText = new TextDecoder().decode(await rawFile.arrayBuffer());
  assert.equal(memory.experimentIds[0], source.sourceId);
  assert.equal(metadata.experimentsReady, 1);
  assert.equal(rawText, "protein,mutation,activity,unit\nEctD,A163V,5.2,U/mg");
  assert.deepEqual(workspace.state.agent.currentRecommendation, { id: "R1" });
});

test("paper tools preserve explicit scope and exact biological identifiers", async () => {
  const workspace = new MemoryWorkspace();
  workspace.setFile("literature/a.pdf", "EctD A163V kcat improved.", 1000);
  workspace.setFile("literature/b.pdf", "Unrelated enzyme result.", 1000);
  const system = await makeSystem(workspace);
  await system.registry.reconcile(treeFor(workspace));
  const a = system.registry.getByPath("literature/a.pdf");
  const b = system.registry.getByPath("literature/b.pdf");
  await system.preparation.ensureSourceReady([a.sourceId, b.sourceId], "search");
  const result = await system.literatureTools.searchPapers("EctD A163V kcat", {
    paperIds: [a.sourceId],
  });

  assert.deepEqual(result.results.map((item) => item.paperId), [a.sourceId]);
  assert.deepEqual(result.coverage.papersActuallyConsidered, [a.sourceId]);
});

test("automatic paper search inspects ready content and cheap candidate metadata only", async () => {
  const workspace = new MemoryWorkspace();
  workspace.setFile("literature/ready.pdf", "EctD activity evidence.", 1000);
  workspace.setFile("literature/EctD-candidate.pdf", "candidate evidence", 1000);
  workspace.setFile("literature/unrelated.pdf", "unrelated evidence", 1000);
  const system = await makeSystem(workspace);
  await system.registry.reconcile(treeFor(workspace));
  const ready = system.registry.getByPath("literature/ready.pdf");
  const candidate = system.registry.getByPath("literature/EctD-candidate.pdf");
  const unrelated = system.registry.getByPath("literature/unrelated.pdf");
  await system.preparation.ensureSourceReady([ready.sourceId], "search");

  const search = await system.literatureTools.searchPapers("EctD", { topK: 10 });
  assert.equal(
    search.results.find((item) => item.paperId === ready.sourceId).searchable,
    true
  );
  assert.equal(
    search.results.find((item) => item.paperId === candidate.sourceId).searchable,
    false
  );
  assert.equal(system.registry.get(candidate.sourceId).hashStatus, "absent");
  assert.equal(system.registry.get(unrelated.sourceId).hashStatus, "absent");

  await system.literatureTools.searchPaperContent(candidate.sourceId, "EctD");
  assert.equal(system.registry.get(candidate.sourceId).indexStatus, "ready");
  assert.equal(system.registry.get(unrelated.sourceId).hashStatus, "absent");
});

test("large tool results persist outside active context and reopen exactly", async () => {
  const workspace = new MemoryWorkspace();
  const store = new SourceResultStore({ workspace, maxInlineCharacters: 120 });
  const value = Array.from({ length: 20 }, (_, index) => ({
    index,
    evidence: `evidence-${index}-${"x".repeat(40)}`,
  }));

  const compact = await store.compact(value, { tool: "test-large-result" });
  assert.equal(typeof compact.resultHandle, "string");
  assert.equal(compact.preview.length, 5);
  assert.match(compact.notice, /stored outside active context/);
  assert.deepEqual(await store.read(compact.resultHandle), value);
});

test("corpus workflow journals progress and resumes unchanged per-paper maps", async () => {
  const workspace = new MemoryWorkspace();
  workspace.setFile("literature/a.pdf", "EctD activity finding A.", 1000);
  workspace.setFile("literature/b.pdf", "EctD activity finding B.", 1000);
  const system = await makeSystem(workspace);
  await system.registry.reconcile(treeFor(workspace));
  const first = await system.corpusWorkflows.run("Summarize all papers about EctD activity.");
  const firstJournal = first.resultHandle
    ? await system.preparation.results.read(first.resultHandle)
    : first;
  const parseCalls = system.parseCalls;
  const second = await system.corpusWorkflows.run("Summarize all papers about EctD activity.");
  const secondJournal = second.resultHandle
    ? await system.preparation.results.read(second.resultHandle)
    : second;

  assert.equal(firstJournal.status, "completed");
  assert.equal(Object.keys(firstJournal.maps).length, 2);
  assert.equal(secondJournal.status, "completed");
  assert.equal(system.parseCalls, parseCalls);
  assert.equal(firstJournal.cacheKey, secondJournal.cacheKey);
});

test("TEST B: corpus workflow reuses 20 searchable papers and prepares the remaining 12", async () => {
  const workspace = new MemoryWorkspace();
  for (let index = 1; index <= 32; index += 1) {
    workspace.setFile(`literature/paper-${index}.pdf`, `Finding from paper ${index}.`, 1000);
  }
  const system = await makeSystem(workspace);
  await system.registry.reconcile(treeFor(workspace));
  const paperIds = system.registry.list({ sourceKind: "paper" }).map((source) => source.sourceId);
  await system.preparation.ensureSourceReady(paperIds.slice(0, 20), "search");
  assert.equal(system.registry.counts().papersSearchable, 20);

  const result = await system.corpusWorkflows.run(
    "Write a literature review of all papers",
    { paperIds }
  );
  const journal = result.resultHandle ? await system.results.read(result.resultHandle) : result;

  assert.equal(journal.coverage.papersIncludedInSnapshot, 32);
  assert.equal(journal.coverage.papersSuccessfullyPrepared, 32);
  assert.equal(journal.coverage.papersPreparationCacheHits, 20);
  assert.equal(journal.coverage.papersSuccessfullyAnalyzed, 32);
  assert.equal(system.preparation.metrics.fullHashCalls, 32);
  assert.equal(system.parseCalls, 32);
  assert.equal(system.registry.counts().papersSearchable, 32);
});

test("TEST F: parse failures produce truthful 30/32 corpus coverage", async () => {
  const workspace = new MemoryWorkspace();
  for (let index = 1; index <= 32; index += 1) {
    workspace.setFile(
      `literature/paper-${String(index).padStart(2, "0")}.pdf`,
      `Finding from paper ${index}.`,
      1000
    );
  }
  const system = await makeSystem(workspace, {
    async parsePaper(input) {
      if (/paper-(07|18)\.pdf$/.test(input.source.path)) {
        throw new Error("corrupted PDF fixture");
      }
      return {
        text: `# Page 1\n${new TextDecoder().decode(input.bytes)}`,
        pageCount: 1,
        truncated: false,
      };
    },
  });
  await system.registry.reconcile(treeFor(workspace));

  const result = await system.corpusWorkflows.run("Summarize all papers");
  const journal = result.resultHandle ? await system.results.read(result.resultHandle) : result;

  assert.equal(journal.coverage.papersIncludedInSnapshot, 32);
  assert.equal(journal.coverage.papersSuccessfullyPrepared, 30);
  assert.equal(journal.coverage.papersSuccessfullyAnalyzed, 30);
  assert.equal(journal.coverage.papersFailed, 2);
  assert.equal(journal.coverage.papersMissing, 0);
  assert.equal(journal.coverage.failedPaperIds.length, 2);
  assert.equal(journal.reduction.papersIncluded, 30);
  assert.equal(journal.reduction.papersFailed, 2);
});

test("TEST H: a valid Paper Card may assist mapping while original evidence remains verifiable", async () => {
  const workspace = new MemoryWorkspace();
  workspace.setFile("literature/card-ready.pdf", "Exact finding 12.4 with original evidence.", 1000);
  let workerInput = null;
  const system = await makeSystem(workspace, {
    async generatePaperCard({ source, contentHash }) {
      const path = `.biodesign/cards/${source.sourceId}.json`;
      await workspace.writeJson(path, {
        title: "Cached card title",
        researchQuestion: "What is the exact finding?",
        topics: ["enzyme kinetics"],
        methods: ["kinetic assay"],
      });
      return { path, schemaVersion: 1, model: "card-model", promptVersion: 1, contentHash };
    },
    async mapWorker(input) {
      workerInput = input;
      return {
        title: input.paperCard?.title,
        relevance: "high",
        themes: input.paperCard?.themes || [],
        majorFindings: input.evidence.slice(0, 1).map((item) => ({
          claim: item.claimCandidate,
          evidenceRefs: [item.evidenceRef],
        })),
        methods: input.paperCard?.methods || [],
        limitations: [],
      };
    },
  });
  await system.registry.reconcile(treeFor(workspace));
  const sourceId = system.registry.list({ sourceKind: "paper" })[0].sourceId;
  await system.preparation.ensureSourceReady([sourceId], "paper_card");

  const result = await system.corpusWorkflows.run("Summarize all papers");
  const journal = result.resultHandle ? await system.results.read(result.resultHandle) : result;

  assert.equal(workerInput.paperCard.title, "Cached card title");
  assert.equal(journal.maps[sourceId].usedPaperCard, true);
  assert.equal(journal.verification[0].status, "original-evidence-located");
  assert.deepEqual(journal.verification[0].supportingPaperIds, [sourceId]);
});

test("TEST I: a paper without a Paper Card still participates in corpus analysis", async () => {
  const workspace = new MemoryWorkspace();
  workspace.setFile("literature/no-card.pdf", "Direct source finding without a card.", 1000);
  let receivedCard = "unset";
  const system = await makeSystem(workspace, {
    async mapWorker(input) {
      receivedCard = input.paperCard;
      return {
        relevance: "high",
        themes: ["direct evidence"],
        findings: input.evidence.slice(0, 1).map((item) => ({
          claim: item.claimCandidate,
          evidenceRefs: [item.evidenceRef],
        })),
        methods: [],
        limitations: [],
      };
    },
  });
  await system.registry.reconcile(treeFor(workspace));
  const sourceId = system.registry.list({ sourceKind: "paper" })[0].sourceId;

  const result = await system.corpusWorkflows.run("Summarize all papers");
  const journal = result.resultHandle ? await system.results.read(result.resultHandle) : result;

  assert.equal(receivedCard, null);
  assert.equal(journal.coverage.papersSuccessfullyAnalyzed, 1);
  assert.equal(journal.maps[sourceId].usedPaperCard, false);
  assert.equal(system.registry.get(sourceId).paperCardStatus, "absent");
});

test("all-uncached corpus shares one planner while retaining scoped rerank and mapper calls", async () => {
  const { counters, system, paperIds, trace } = await createCorpusScenario(4);
  const result = await system.corpusWorkflows.run(
    "Compare all papers in the corpus",
    { retrievalProfile: "high", mapConcurrency: 2, turnId: "turn-corpus-4" }
  );
  const journal = result.resultHandle ? await system.results.read(result.resultHandle) : result;

  assert.equal(journal.coverage.papersSuccessfullyAnalyzed, 4);
  assert.ok(Object.values(journal.maps).every((mapped) =>
    mapped.generationMode === "structured-map"
  ));
  assertRouteCounts(counters, { config: 1, plan: 1, rerank: 4, map: 4 });
  assert.deepEqual(
    trace.retrievalOperations.map((operation) => operation.paperId).sort(),
    [...paperIds].sort()
  );
  assert.equal(
    new Set(trace.retrievalOperations.map((operation) => operation.sharedPlanCacheKey)).size,
    1
  );
  assert.ok(trace.retrievalOperations.every((operation) =>
    operation.paperIds.length === 1 && operation.paperIds[0] === operation.paperId
  ));
  assert.ok(trace.plannerPayloads.every((payload) =>
    payload.callContext.callRole === "search_planner" &&
    payload.callContext.turnId === "turn-corpus-4"
  ));
  assert.ok(trace.rerankPayloads.every((payload) =>
    payload.callContext.callRole === "reranker" &&
    paperIds.includes(payload.callContext.paperId)
  ));
  assert.ok(trace.mapperOptions.every((worker) =>
    worker.workflowId === journal.workflowId &&
    worker.paperId &&
    worker.profile === "high"
  ));
});

test("32-paper multilingual corpus plans once before concurrency-2 paper retrieval and mapping", async () => {
  const { counters, system, paperIds, trace } = await createCorpusScenario(32);
  const progress = [];
  const question = "帮我总结所有文献，写一个综述。";
  const result = await system.corpusWorkflows.run(question, {
    retrievalProfile: "high",
    mapConcurrency: 2,
    language: "zh",
    turnId: "turn-corpus-32-zh",
    onProgress: (event) => progress.push(clone(event)),
  });
  const journal = await resolveWorkflowResult(system, result);

  assert.equal(journal.coverage.papersSuccessfullyAnalyzed, 32);
  assertRouteCounts(counters, { config: 1, plan: 1, rerank: 32, map: 32 });
  assert.equal(trace.retrievalOperations.length, 32);
  assert.deepEqual(
    new Set(trace.retrievalOperations.map((operation) => operation.paperId)),
    new Set(paperIds)
  );
  assert.equal(new Set(trace.retrievalOperations.map(
    (operation) => operation.sharedPlanCacheKey
  )).size, 1);
  assert.ok(trace.retrievalOperations.every((operation) =>
    operation.sharedPlan === trace.retrievalOperations[0].sharedPlan
  ));
  assert.ok(trace.localSearches.every((search) =>
    search.paperIds.length === 1 && paperIds.includes(search.paperIds[0])
  ));
  assert.equal(journal.sharedRetrievalPlan.crossLanguage, true);
  assert.equal(journal.sharedRetrievalPlan.sourceLanguage, "zh");
  assert.deepEqual(
    journal.sharedRetrievalPlan.scientificDimensions,
    journal.sharedRetrievalPlan.queries
  );
  assert.doesNotMatch(
    journal.sharedRetrievalPlan.queries.join(" "),
    /literature review|systematic review|meta-analysis|文献综述|综述写作/iu
  );
  assert.equal(progress.filter((event) => event.stage === "corpus-plan").length, 1);
  assert.equal(progress.filter((event) => event.stage === "corpus-plan-ready").length, 1);
  assert.ok(
    progress.findIndex((event) => event.stage === "corpus-plan-ready") <
    progress.findIndex((event) => event.stage === "corpus-map")
  );
});

test("planner cache persists across a compatible new corpus workflow", async () => {
  const scenario = await createCorpusScenario(2);
  const { workspace, counters, system, trace } = scenario;
  const question = "Across all papers, compare EctD stability.";
  await system.corpusWorkflows.run(question, {
    retrievalProfile: "high",
    mapConcurrency: 2,
  });
  assertRouteCounts(counters, { config: 1, plan: 1, rerank: 2, map: 2 });

  counters.reset();
  trace.plannerPayloads.length = 0;
  trace.rerankPayloads.length = 0;
  trace.localSearches.length = 0;
  trace.retrievalOperations.length = 0;
  trace.mapperInputs.length = 0;
  const restartedKnowledgeService = await makeRouteCountedDeepKnowledgeService(
    workspace,
    counters,
    trace
  );
  system.literatureTools.knowledgeService = restartedKnowledgeService;
  system.corpusWorkflows.knowledgeService = restartedKnowledgeService;
  workspace.setFile("literature/paper-3.pdf", "EctD finding from paper-3.pdf.", 1000);
  await system.registry.reconcile(treeFor(workspace));

  const second = await system.corpusWorkflows.run(question, {
    retrievalProfile: "high",
    mapConcurrency: 2,
  });
  const secondJournal = await resolveWorkflowResult(system, second);
  assert.equal(secondJournal.coverage.papersSuccessfullyAnalyzed, 3);
  assertRouteCounts(counters, { config: 1, plan: 0, rerank: 1, map: 1 });
  assert.equal(trace.plannerPayloads.length, 0);
  assert.equal(trace.retrievalOperations.length, 1);
});

test("a resumed workflow validates and reuses its journaled shared plan", async () => {
  const { workspace, counters, system, paperIds, trace } = await createCorpusScenario(2);
  const question = "Summarize all papers about EctD.";
  const first = await system.corpusWorkflows.run(question, {
    retrievalProfile: "high",
    mapConcurrency: 2,
  });
  const firstJournal = await resolveWorkflowResult(system, first);
  const remapPaperId = paperIds[1];
  const journalPath = `.biodesign/workflows/${firstJournal.workflowId}.json`;
  const paused = await workspace.readJson(journalPath);
  paused.status = "paused";
  paused.phase = "map";
  delete paused.maps[remapPaperId];
  await workspace.writeJson(journalPath, paused);
  for (const path of [...workspace.json.keys()]) {
    if (path.includes(`/maps/${remapPaperId}/`)) workspace.json.delete(path);
  }

  counters.reset();
  trace.plannerPayloads.length = 0;
  trace.rerankPayloads.length = 0;
  trace.retrievalOperations.length = 0;
  trace.mapperInputs.length = 0;
  const restartedKnowledgeService = await makeRouteCountedDeepKnowledgeService(
    workspace,
    counters,
    trace
  );
  system.literatureTools.knowledgeService = restartedKnowledgeService;
  const resumedCorpusWorkflows = new CorpusWorkflowService({
    workspace,
    registry: system.registry,
    preparation: system.preparation,
    literatureTools: system.literatureTools,
    results: system.results,
    mapWorker: async (input) => {
      counters.hit(FC_ROUTES.map);
      trace.mapperInputs.push(clone(input));
      return validMapFor(input, "resumed-map");
    },
    knowledgeService: restartedKnowledgeService,
  });
  const resumed = await resumedCorpusWorkflows.run(question, {
    workflowId: firstJournal.workflowId,
    paperIds,
    retrievalProfile: "high",
    mapConcurrency: 2,
  });
  const resumedJournal = resumed.resultHandle
    ? await system.results.read(resumed.resultHandle)
    : resumed;

  assert.equal(resumedJournal.coverage.papersSuccessfullyAnalyzed, 2);
  assert.equal(resumedJournal.sharedRetrievalPlan.cacheKey, firstJournal.sharedRetrievalPlan.cacheKey);
  assertRouteCounts(counters, { config: 1, plan: 0, rerank: 0, map: 1 });
});

test("materially different corpus questions receive different shared plans", async () => {
  const { counters, system, trace } = await createCorpusScenario(2);
  await system.corpusWorkflows.run("Summarize all papers.", {
    retrievalProfile: "high",
  });
  const first = await system.corpusWorkflows.getWorkflowStatus("");
  await system.corpusWorkflows.run(
    "Across all papers, focus specifically on fermentation conditions.",
    { retrievalProfile: "high" }
  );
  const second = await system.corpusWorkflows.getWorkflowStatus("");

  assert.equal(counters.counts[FC_ROUTES.plan], 2);
  assert.equal(trace.plannerPayloads.length, 2);
  assert.notEqual(first.workflowId, second.workflowId);
  assert.notEqual(
    trace.plannerPayloads[0].query,
    trace.plannerPayloads[1].query
  );
});

test("planner failure occurs once at workflow scope and all papers use local fallback", async () => {
  const { counters, system, trace } = await createCorpusScenario(4, [], {
    failPlanner: true,
  });
  const result = await system.corpusWorkflows.run(
    "帮我总结所有文献，写一个综述。",
    { retrievalProfile: "high", mapConcurrency: 2 }
  );
  const journal = await resolveWorkflowResult(system, result);

  assert.equal(journal.coverage.papersSuccessfullyAnalyzed, 4);
  assert.equal(journal.sharedRetrievalPlan.status, "local-fallback");
  assert.equal(trace.retrievalOperations.length, 4);
  assertRouteCounts(counters, { config: 1, plan: 1, rerank: 0, map: 4 });
});

test("shared planning never leaks one paper's evidence into another mapper", async () => {
  const { system, paperIds, trace } = await createCorpusScenario(2);
  await system.corpusWorkflows.run("Review all papers about EctD A163V.", {
    retrievalProfile: "high",
    mapConcurrency: 2,
  });

  for (const input of trace.mapperInputs) {
    const otherPaperIds = paperIds.filter((paperId) => paperId !== input.paperId);
    assert.ok(input.evidence.length > 0);
    assert.ok(input.evidence.every((item) =>
      item.evidenceRef.startsWith(`${input.paperId}:`) &&
      !otherPaperIds.some((paperId) => item.claimCandidate.includes(paperId))
    ));
  }
});

test("cancelling one shared-plan consumer does not cancel the workflow plan", async () => {
  let plannerCalls = 0;
  let releasePlan;
  const plan = {
    recordVersion: 1,
    status: "ready",
    cacheKey: "a".repeat(64),
    normalizedQuery: "Summarize all papers.",
    normalizedIntent: "corpus scientific evidence extraction",
    configurationSignature: "b".repeat(64),
    rerankerConfigurationSignature: "c".repeat(64),
    schemaVersion: CLOUD_RETRIEVAL.schemaVersion,
    promptVersion: CLOUD_RETRIEVAL.searchPlanPromptVersion,
    rerankPromptVersion: CLOUD_RETRIEVAL.rerankPromptVersion,
    queries: ["major findings"],
    identifiers: [],
    sourceLanguage: "en",
    crossLanguage: false,
    scientificDimensions: ["major findings"],
    useOriginalQuery: false,
    fallbackReason: "",
    createdAt: "2026-09-04T00:00:00.000Z",
  };
  const workflow = new CorpusWorkflowService({
    workspace: new MemoryWorkspace(),
    registry: {},
    preparation: { results: {} },
    literatureTools: {},
    knowledgeService: {
      available: true,
      prepareCorpusSearchPlan() {
        plannerCalls += 1;
        return new Promise((resolve) => { releasePlan = () => resolve(plan); });
      },
    },
  });
  const journal = {
    workflowId: "workflow-cancel-test",
    question: "Summarize all papers.",
    sharedRetrievalPlan: null,
  };
  const aborted = new AbortController();
  const cancelled = workflow.getWorkflowSharedRetrievalPlan(journal, {
    retrievalProfile: "high",
    signal: aborted.signal,
  });
  const retained = workflow.getWorkflowSharedRetrievalPlan(journal, {
    retrievalProfile: "high",
  });
  aborted.abort();
  await assert.rejects(cancelled, (error) => error.code === "OPERATION_ABORTED");
  assert.equal(workflow.workflowSharedPlanPromises.size, 1);
  releasePlan();
  assert.equal(await retained, plan);
  assert.equal(plannerCalls, 1);
  assert.equal(workflow.workflowSharedPlanPromises.size, 0);
});

test("all-Paper-Card corpus performs zero per-paper provider calls", async () => {
  const { counters, system } = await createCorpusScenario(4, [0, 1, 2, 3]);
  const progress = [];
  const result = await system.corpusWorkflows.run(
    "Compare all papers in the corpus",
    {
      retrievalProfile: "high",
      mapConcurrency: 4,
      onProgress: (event) => progress.push(event),
    }
  );
  const journal = result.resultHandle ? await system.results.read(result.resultHandle) : result;

  assert.equal(journal.coverage.papersSuccessfullyAnalyzed, 4);
  assert.ok(Object.values(journal.maps).every((mapped) =>
    mapped.generationMode === "paper-card-cache" &&
    typeof mapped.paperCardContentIdentity === "string" &&
    mapped.paperCardContentIdentity.length > 0
  ));
  assert.equal(
    progress.filter((event) => event.stage === "paper-card-cache-hit").length,
    4
  );
  assertRouteCounts(counters, {});
});

test("a changed valid Paper Card invalidates only its local card-derived map", async () => {
  const { workspace, counters, system, paperIds } = await createCorpusScenario(1, [0]);
  const question = "Compare all papers in the corpus";
  const first = await system.corpusWorkflows.run(question, { retrievalProfile: "high" });
  const firstJournal = first.resultHandle ? await system.results.read(first.resultHandle) : first;
  const firstIdentity = firstJournal.maps[paperIds[0]].paperCardContentIdentity;

  const source = system.registry.get(paperIds[0]);
  const card = await workspace.readJson(source.artifacts.paperCard.path);
  const changedFinding = "A corrected bounded finding already present in the Paper Card.";
  card.mainFindings = [changedFinding];
  card.importantResults = [changedFinding];
  card.keyResults = [changedFinding];
  card.shortSummary = changedFinding;
  card.summary = changedFinding;
  await workspace.writeJson(source.artifacts.paperCard.path, card);
  counters.reset();

  const second = await system.corpusWorkflows.run(question, { retrievalProfile: "high" });
  const secondJournal = second.resultHandle ? await system.results.read(second.resultHandle) : second;
  const remapped = secondJournal.maps[paperIds[0]];
  assert.equal(remapped.generationMode, "paper-card-cache");
  assert.notEqual(remapped.paperCardContentIdentity, firstIdentity);
  assert.equal(remapped.findings[0].claim, changedFinding);
  assertRouteCounts(counters, {});
});

test("mixed corpus uses Paper Cards locally and calls per-paper providers only for uncovered papers", async () => {
  const { counters, system, paperIds } = await createCorpusScenario(4, [0, 2]);
  const result = await system.corpusWorkflows.run(
    "Compare all papers in the corpus",
    { retrievalProfile: "high", mapConcurrency: 4 }
  );
  const journal = result.resultHandle ? await system.results.read(result.resultHandle) : result;

  assert.equal(journal.maps[paperIds[0]].generationMode, "paper-card-cache");
  assert.equal(journal.maps[paperIds[2]].generationMode, "paper-card-cache");
  assert.equal(journal.maps[paperIds[1]].generationMode, "structured-map");
  assert.equal(journal.maps[paperIds[3]].generationMode, "structured-map");
  assertRouteCounts(counters, { config: 1, plan: 1, rerank: 2, map: 2 });
});

test("stale, missing, malformed, and content-mismatched Paper Cards use the existing provider path", async () => {
  const { workspace, counters, system, paperIds } = await createCorpusScenario(
    4,
    [0, 1, 2, 3]
  );
  const stale = system.registry.get(paperIds[0]);
  stale.paperCardStatus = "stale";

  const missing = system.registry.get(paperIds[1]);
  workspace.json.delete(missing.artifacts.paperCard.path);

  const malformed = system.registry.get(paperIds[2]);
  workspace.json.set(malformed.artifacts.paperCard.path, { schemaVersion: 1 });

  const mismatched = system.registry.get(paperIds[3]);
  const mismatchedCard = await workspace.readJson(mismatched.artifacts.paperCard.path);
  mismatchedCard.source.hash = "sha256:older-source-revision";
  await workspace.writeJson(mismatched.artifacts.paperCard.path, mismatchedCard);

  const result = await system.corpusWorkflows.run(
    "Compare all papers in the corpus",
    { retrievalProfile: "high", mapConcurrency: 4 }
  );
  const journal = result.resultHandle ? await system.results.read(result.resultHandle) : result;

  assert.ok(Object.values(journal.maps).every((mapped) =>
    mapped.generationMode === "structured-map"
  ));
  assertRouteCounts(counters, { config: 1, plan: 1, rerank: 4, map: 4 });
});

test("an existing valid corpus map takes precedence over a newly available Paper Card", async () => {
  const { counters, system, paperIds } = await createCorpusScenario(1);
  const question = "Compare all papers in the corpus";
  const first = await system.corpusWorkflows.run(question, {
    retrievalProfile: "high",
  });
  const firstJournal = first.resultHandle ? await system.results.read(first.resultHandle) : first;
  assert.equal(firstJournal.maps[paperIds[0]].generationMode, "structured-map");

  await system.preparation.ensureSourceReady([paperIds[0]], "paper_card");
  counters.reset();
  const second = await system.corpusWorkflows.run(question, {
    retrievalProfile: "high",
  });
  const secondJournal = second.resultHandle ? await system.results.read(second.resultHandle) : second;

  assert.equal(secondJournal.maps[paperIds[0]].generationMode, "structured-map");
  assertRouteCounts(counters, {});
});

test("corpus membership changes stale the old synthesis and reuse unchanged maps", async () => {
  const workspace = new MemoryWorkspace();
  workspace.setFile("literature/a.pdf", "EctD finding A.", 1000);
  workspace.setFile("literature/b.pdf", "EctD finding B.", 1000);
  const system = await makeSystem(workspace);
  await system.registry.reconcile(treeFor(workspace));
  const question = "Summarize all papers about EctD.";
  const first = await system.corpusWorkflows.run(question);
  const firstJournal = first.resultHandle
    ? await system.preparation.results.read(first.resultHandle)
    : first;
  const parseCalls = system.parseCalls;

  workspace.setFile("literature/c.pdf", "EctD finding C.", 1000);
  await system.registry.reconcile(treeFor(workspace));
  const second = await system.corpusWorkflows.run(question);
  const secondJournal = second.resultHandle
    ? await system.preparation.results.read(second.resultHandle)
    : second;
  const staleJournal = await workspace.readJson(
    `.biodesign/workflows/${firstJournal.workflowId}.json`
  );

  assert.equal(staleJournal.status, "stale");
  assert.equal(staleJournal.staleReason, "corpus_membership_changed");
  assert.equal(Object.keys(secondJournal.maps).length, 3);
  assert.equal(system.parseCalls, parseCalls + 1);
});

test("incremental Side Chat update deterministically reuses 32 maps and maps only four new papers", async () => {
  const workspace = new MemoryWorkspace();
  workspace.state = {
    schemaVersion: 1,
    project: { goal: "Maintain the literature review." },
    ui: {},
    agent: { currentRecommendation: { id: "R1", text: "Keep the existing plan." } },
    memory: {},
  };
  for (let index = 1; index <= 32; index += 1) {
    workspace.setFile(
      `literature/paper-${String(index).padStart(2, "0")}.pdf`,
      `Initial paper ${index} finding.`,
      1000
    );
  }
  let mapCalls = 0;
  const system = await makeSystem(workspace, {
    async mapWorker(input) {
      mapCalls += 1;
      return validMapFor(input, `theme-${Number(input.title.match(/\d+/)?.[0] || 0) % 4}`);
    },
  });
  await system.registry.reconcile(treeFor(workspace));
  const firstResult = await system.corpusWorkflows.run(
    "Summarize all papers and write a review.",
    { corpusScope: "entire-project", surface: "side_chat" }
  );
  const firstJournal = await resolveWorkflowResult(system, firstResult);
  assert.equal(firstJournal.snapshot.length, 32);
  assert.equal(Object.keys(firstJournal.maps).length, 32);
  assert.equal(mapCalls, 32);

  // Simulate a completed pre-update journal. The update path adopts its stable
  // snapshot/maps without requiring a destructive migration or 32 remaps.
  const legacyFirstJournal = await workspace.readJson(
    `.biodesign/workflows/${firstJournal.workflowId}.json`
  );
  delete legacyFirstJournal.corpusScope;
  delete legacyFirstJournal.normalizedSynthesisSignature;
  delete legacyFirstJournal.originalQuestion;
  await workspace.writeJson(
    `.biodesign/workflows/${firstJournal.workflowId}.json`,
    legacyFirstJournal
  );

  for (let index = 33; index <= 36; index += 1) {
    workspace.setFile(
      `literature/imported/paper-${index}.pdf`,
      `New paper ${index} finding.`,
      2000
    );
  }
  workspace.setFile("literature/.DS_Store", "Finder metadata", 2000);
  await system.registry.reconcile(treeFor(workspace));
  assert.equal(system.registry.counts().papersDiscovered, 36);
  assert.equal(system.registry.counts().papersSearchable, 32);
  assert.equal(system.registry.getByPath("literature/.DS_Store"), null);

  system.projectState = new ProjectStateService({
    workspace,
    registry: system.registry,
    jobs: system.jobs,
    corpusWorkflows: system.corpusWorkflows,
  });
  const literature = makeLiteratureHarness(system);
  let semanticPaperSearchCalls = 0;
  const originalSearchPapers = system.literatureTools.searchPapers.bind(
    system.literatureTools
  );
  system.literatureTools.searchPapers = async (...args) => {
    semanticPaperSearchCalls += 1;
    return originalSearchPapers(...args);
  };
  const service = new ProjectContextService({ workspace, literature });
  const progress = [];
  const context = await service.buildContext({
    question: "我先加了几篇文献，帮我纳入考量，更新一下综述。",
    selectedPaths: [],
    selectedPaperIds: [],
    workspaceTree: treeFor(workspace),
    surface: "side_chat",
    onProgress(update) {
      progress.push(update);
    },
  });

  assert.equal(detectCorpusUpdateIntent("Include the newly added papers and update the review."), true);
  assert.equal(context.routing.mode, "corpus-update");
  assert.equal(context.literature.discoveryMode, "corpus-update");
  assert.equal(semanticPaperSearchCalls, 0);
  assert.equal(mapCalls, 36);
  assert.equal(system.parseCalls, 36);
  assert.equal(system.preparation.metrics.fullHashCalls, 36);
  assert.equal(system.registry.counts().papersSearchable, 36);
  assert.equal(context.literature.coverage.papersSuccessfullyAnalyzed, 36);
  assert.equal(context.corpusWorkflowStatus.parentWorkflowId, firstJournal.workflowId);
  assert.equal(context.corpusWorkflowStatus.incrementalUpdate.addedPaperIds.length, 4);
  assert.equal(context.corpusWorkflowStatus.incrementalUpdate.removedPaperIds.length, 0);
  assert.equal(context.corpusWorkflowStatus.incrementalUpdate.modifiedPaperIds.length, 0);
  assert.equal(context.corpusWorkflowStatus.incrementalUpdate.reusedMapPaperIds.length, 32);
  assert.equal(context.corpusWorkflowStatus.incrementalUpdate.newlyMappedPaperIds.length, 4);
  assert.deepEqual(workspace.state.agent.currentRecommendation, {
    id: "R1",
    text: "Keep the existing plan.",
  });

  const mapProgress = progress.filter(
    (update) => update.stage === "corpus-map" && update.paperId
  );
  assert.deepEqual(mapProgress.map((update) => update.completed), [1, 2, 3, 4]);
  assert.ok(mapProgress.every((update) => update.total === 4));
  assert.ok(mapProgress.every((update) => update.incremental === true));
  const prepareProgress = progress.filter(
    (update) => update.stage === "corpus-prepare" && update.completed > 0
  );
  assert.equal(prepareProgress.at(-1).completed, 4);
  assert.equal(prepareProgress.at(-1).total, 4);

  const secondJournal = await system.corpusWorkflows.readWorkflow(
    context.corpusWorkflowStatus.workflowId
  );
  const preservedFirstJournal = await system.corpusWorkflows.readWorkflow(
    firstJournal.workflowId
  );
  assert.equal(secondJournal.parentWorkflowId, firstJournal.workflowId);
  assert.equal(secondJournal.snapshot.length, 36);
  assert.equal(Object.keys(secondJournal.maps).length, 36);
  assert.equal(preservedFirstJournal.snapshot.length, 32);
  assert.equal(Object.keys(preservedFirstJournal.maps).length, 32);
});

test("incremental corpus diff remaps modified sources, removes deleted sources, and does no work when unchanged", async () => {
  const workspace = new MemoryWorkspace();
  workspace.setFile("literature/a.pdf", "Finding A.", 1000);
  workspace.setFile("literature/b.pdf", "Finding B.", 1000);
  workspace.setFile("literature/c.pdf", "Finding C.", 1000);
  let mapCalls = 0;
  const system = await makeSystem(workspace, {
    async mapWorker(input) {
      mapCalls += 1;
      return validMapFor(input, input.title);
    },
  });
  await system.registry.reconcile(treeFor(workspace));
  const first = await resolveWorkflowResult(
    system,
    await system.corpusWorkflows.run("Review all papers.", {
      corpusScope: "entire-project",
    })
  );
  assert.equal(mapCalls, 3);

  workspace.setFile("literature/b.pdf", "Materially revised finding B.", 2000);
  await system.registry.reconcile(treeFor(workspace));
  const modified = await system.corpusWorkflows.updateCorpusSynthesis(
    first.workflowId,
    { surface: "side_chat" }
  );
  assert.deepEqual(modified.diff.addedPaperIds, []);
  assert.equal(modified.diff.modifiedPaperIds.length, 1);
  assert.equal(modified.diff.unchangedPaperIds.length, 2);
  assert.equal(modified.status.incrementalUpdate.newlyMappedPaperIds.length, 1);
  assert.equal(modified.status.incrementalUpdate.reusedMapPaperIds.length, 2);
  assert.equal(mapCalls, 4);

  workspace.deleteFile("literature/c.pdf");
  await system.registry.reconcile(treeFor(workspace));
  const removed = await system.corpusWorkflows.updateCorpusSynthesis(
    modified.status.workflowId,
    { surface: "side_chat" }
  );
  assert.equal(removed.diff.removedPaperIds.length, 1);
  assert.equal(removed.diff.addedPaperIds.length, 0);
  assert.equal(removed.diff.modifiedPaperIds.length, 0);
  assert.equal(removed.status.coverage.papersIncludedInSnapshot, 2);
  assert.equal(removed.status.incrementalUpdate.reusedMapPaperIds.length, 2);
  assert.equal(mapCalls, 4);

  const unchanged = await system.corpusWorkflows.updateCorpusSynthesis(
    removed.status.workflowId,
    { surface: "side_chat" }
  );
  assert.equal(unchanged.reusedExistingSynthesis, true);
  assert.deepEqual(unchanged.diff, {
    addedPaperIds: [],
    removedPaperIds: [],
    modifiedPaperIds: [],
    unchangedPaperIds: removed.status.coverage.includedPaperIds,
  });
  assert.equal(mapCalls, 4);
});

test("a failed new map preserves all previous maps and reports 35 of 36 analyzed", async () => {
  const workspace = new MemoryWorkspace();
  for (let index = 1; index <= 32; index += 1) {
    workspace.setFile(`literature/paper-${index}.pdf`, `Initial ${index}.`, 1000);
  }
  const system = await makeSystem(workspace, {
    async mapWorker(input) {
      if (input.title === "paper-36.pdf") throw invalidMapperError();
      return validMapFor(input, "shared theme");
    },
    async fallbackMapWorker(input) {
      if (input.title === "paper-36.pdf") throw invalidMapperError();
      return validMapFor(input, "fallback theme");
    },
  });
  await system.registry.reconcile(treeFor(workspace));
  const first = await resolveWorkflowResult(
    system,
    await system.corpusWorkflows.run("Summarize all papers.", {
      corpusScope: "entire-project",
    })
  );
  for (let index = 33; index <= 36; index += 1) {
    workspace.setFile(`literature/paper-${index}.pdf`, `New ${index}.`, 2000);
  }
  await system.registry.reconcile(treeFor(workspace));
  const updated = await system.corpusWorkflows.updateCorpusSynthesis(
    first.workflowId,
    { surface: "side_chat" }
  );

  assert.equal(updated.status.coverage.papersIncludedInSnapshot, 36);
  assert.equal(updated.status.coverage.papersSuccessfullyPrepared, 36);
  assert.equal(updated.status.coverage.papersSuccessfullyAnalyzed, 35);
  assert.equal(updated.status.coverage.papersFailed, 1);
  assert.equal(updated.status.incrementalUpdate.reusedMapPaperIds.length, 32);
  assert.equal(updated.status.incrementalUpdate.newlyMappedPaperIds.length, 3);
  assert.equal(updated.status.incrementalUpdate.failedChangedPaperIds.length, 1);
  assert.equal(updated.status.failures[0].stage, "map");
  assert.equal(updated.status.failures[0].sourceReady, true);
});

test("TEST G: interrupting after 21 of 32 map jobs resumes only the remaining work", async () => {
  const workspace = new MemoryWorkspace();
  for (let index = 1; index <= 32; index += 1) {
    workspace.setFile(`literature/paper-${index}.pdf`, `EctD finding ${index}.`, 1000);
  }
  let interrupt = true;
  let totalMapAttempts = 0;
  const mapCalls = new Map();
  const system = await makeSystem(workspace, {
    async mapWorker(input) {
      mapCalls.set(input.paperId, (mapCalls.get(input.paperId) || 0) + 1);
      totalMapAttempts += 1;
      if (interrupt && totalMapAttempts === 22) {
        const error = new Error("interrupted");
        error.code = "OPERATION_ABORTED";
        throw error;
      }
      return {
        relevance: "high",
        themes: ["EctD"],
        findings: input.evidence.slice(0, 1).map((item) => ({
          claim: item.claimCandidate,
          evidenceRefs: [item.evidenceRef],
        })),
        methods: [],
        limitations: [],
      };
    },
  });
  await system.registry.reconcile(treeFor(workspace));
  const paperIds = system.registry.list({ sourceKind: "paper" }).map((item) => item.sourceId);
  const question = "Summarize all EctD papers.";

  await assert.rejects(
    system.corpusWorkflows.run(question, { concurrency: 1 }),
    (error) => error.code === "OPERATION_ABORTED"
  );
  const pausedPath = `.biodesign/workflows/${system.corpusWorkflows.workflowId(question, paperIds)}.json`;
  const paused = await workspace.readJson(pausedPath);
  assert.equal(paused.status, "paused");
  assert.equal(Object.keys(paused.maps).length, 21);

  interrupt = false;
  const resumed = await system.corpusWorkflows.run(question, { concurrency: 1 });
  const journal = resumed.resultHandle
    ? await system.preparation.results.read(resumed.resultHandle)
    : resumed;

  assert.equal(journal.status, "completed");
  assert.equal(journal.coverage.papersSuccessfullyAnalyzed, 32);
  for (const paperId of paperIds.slice(0, 21)) assert.equal(mapCalls.get(paperId), 1);
  assert.equal(mapCalls.get(paperIds[21]), 2);
  for (const paperId of paperIds.slice(22)) assert.equal(mapCalls.get(paperId), 1);
});

test("CASE 1: map failures remain prepared and expose their actual structured-output diagnostics", async () => {
  const workspace = new MemoryWorkspace();
  for (let index = 1; index <= 32; index += 1) {
    workspace.setFile(
      `literature/paper-${String(index).padStart(2, "0")}.pdf`,
      `Finding from paper ${index}.`,
      1000
    );
  }
  let failedIds = new Set();
  const system = await makeSystem(workspace, {
    mapAttempts: 3,
    async mapWorker(input) {
      if (failedIds.has(input.paperId)) throw invalidMapperError();
      return validMapFor(input);
    },
    async fallbackMapWorker(input) {
      if (failedIds.has(input.paperId)) throw invalidMapperError();
      return validMapFor(input, "fallback theme");
    },
  });
  await system.registry.reconcile(treeFor(workspace));
  const paperIds = system.registry.list({ sourceKind: "paper" }).map((item) => item.sourceId);
  failedIds = new Set(paperIds.slice(-2));

  const result = await system.corpusWorkflows.run("Summarize all papers");
  const journal = result.resultHandle ? await system.results.read(result.resultHandle) : result;
  const status = await system.corpusWorkflows.getWorkflowStatus(journal.workflowId);
  const statusContext = await new ProjectContextService({
    workspace,
    literature: makeLiteratureHarness(system),
  }).buildContext({
    question: "Why did two papers fail?",
    selectedPaths: [],
    selectedPaperIds: [],
    workspaceTree: treeFor(workspace),
    conversation: {
      messages: [{
        role: "user",
        content: "Summarize all papers",
        context: { corpusWorkflowId: journal.workflowId },
      }],
    },
  });

  assert.equal(status.papersTotal, 32);
  assert.equal(status.papersPrepared, 32);
  assert.equal(status.papersAnalyzed, 30);
  assert.equal(status.failures.length, 2);
  assert.ok(status.failures.every((failure) => failure.stage === "map"));
  assert.ok(status.failures.every((failure) => failure.code === "InvalidLlmResponse"));
  assert.ok(status.failures.every((failure) => failure.sourceReady === true));
  assert.ok(status.failures.every((failure) => failure.retryable === true));
  assert.ok(status.failures.every((failure) => failure.attempts === 3));
  assert.ok(status.failures.every((failure) => failure.fallbackAttempted === true));
  assert.ok(status.failures.every((failure) => !/ocr|scan|pars/i.test(failure.message)));
  assert.equal(statusContext.literature.discoveryMode, "corpus-status");
  assert.equal(statusContext.corpusWorkflowStatus.failures[0].stage, "map");
  assert.equal(statusContext.files.length, 0);
  for (const paperId of failedIds) {
    assert.equal(system.registry.get(paperId).indexStatus, "ready");
    const evidence = await system.literatureTools.readPaperEvidence(paperId, { limit: 1 });
    assert.equal(Array.isArray(evidence), true);
    assert.equal(evidence.length, 1);
  }
});

test("CASES 2-3: include failed papers retries only two maps and incrementally updates 30/32 to 32/32", async () => {
  const workspace = new MemoryWorkspace();
  for (let index = 1; index <= 32; index += 1) {
    workspace.setFile(
      `literature/paper-${String(index).padStart(2, "0")}.pdf`,
      `Finding from paper ${index}.`,
      1000
    );
  }
  let recoveryEnabled = false;
  let failedIds = new Set();
  const mapCalls = new Map();
  const system = await makeSystem(workspace, {
    mapAttempts: 3,
    async mapWorker(input) {
      mapCalls.set(input.paperId, (mapCalls.get(input.paperId) || 0) + 1);
      if (!recoveryEnabled && failedIds.has(input.paperId)) throw invalidMapperError();
      return validMapFor(input, failedIds.has(input.paperId) ? "recovered" : "baseline");
    },
    async fallbackMapWorker(input) {
      if (!recoveryEnabled && failedIds.has(input.paperId)) throw invalidMapperError();
      return validMapFor(input, "fallback");
    },
  });
  await system.registry.reconcile(treeFor(workspace));
  const paperIds = system.registry.list({ sourceKind: "paper" }).map((item) => item.sourceId);
  failedIds = new Set(paperIds.slice(-2));
  const first = await system.corpusWorkflows.run("Summarize all papers");
  const firstJournal = first.resultHandle ? await system.results.read(first.resultHandle) : first;
  assert.equal(firstJournal.coverage.papersSuccessfullyPrepared, 32);
  assert.equal(firstJournal.coverage.papersSuccessfullyAnalyzed, 30);
  const callsBeforeRecovery = new Map(mapCalls);

  recoveryEnabled = true;
  workspace.state = {
    schemaVersion: 1,
    project: { goal: "Review the EctD corpus." },
    ui: {},
    agent: { currentRecommendation: { id: "R1", text: "Keep the baseline." } },
    memory: { project: [], literature: [], experimental: [] },
  };
  const literature = makeLiteratureHarness(system);
  literature.sourceSystem.projectState = new ProjectStateService({
    workspace,
    registry: system.registry,
    jobs: system.jobs,
    corpusWorkflows: system.corpusWorkflows,
  });
  const service = new ProjectContextService({ workspace, literature });
  const context = await service.buildContext({
    question:
      "There are two papers that needed to reprocess. Can you help me include them in summary?",
    selectedPaths: [],
    selectedPaperIds: [],
    workspaceTree: treeFor(workspace),
    conversation: {
      messages: [
        {
          role: "user",
          content: "Summarize all papers",
          context: {
            relevantPaperIds: paperIds,
            corpusWorkflowId: firstJournal.workflowId,
          },
        },
      ],
    },
  });

  assert.equal(context.literature.discoveryMode, "corpus-recovery");
  assert.equal(context.literature.coverage.papersSuccessfullyPrepared, 32);
  assert.equal(context.literature.coverage.papersSuccessfullyAnalyzed, 32);
  assert.equal(context.literature.coverage.papersFailed, 0);
  assert.equal(context.corpusWorkflowStatus.failures.length, 0);
  assert.equal(context.corpusWorkflowStatus.incrementalUpdate.recoveredPaperIds.length, 2);
  assert.equal(context.corpusWorkflowStatus.incrementalUpdate.reusedMapPaperIds.length, 30);
  assert.ok(context.corpusWorkflowStatus.incrementalUpdate.affectedGroupKeys.length > 0);
  assert.ok(context.corpusWorkflowStatus.incrementalUpdate.verificationClaimsRechecked > 0);
  assert.equal(context.files[0].evidenceType, "corpus-workflow");
  assert.equal(workspace.state.projectMetadata.corpusMapFailures, 0);
  assert.equal(
    workspace.state.projectMetadata.corpusCoverage.papersSuccessfullyAnalyzed,
    32
  );
  assert.deepEqual(workspace.state.agent.currentRecommendation, {
    id: "R1",
    text: "Keep the baseline.",
  });
  for (const paperId of paperIds.slice(0, 30)) {
    assert.equal(mapCalls.get(paperId), callsBeforeRecovery.get(paperId));
  }
  for (const paperId of paperIds.slice(-2)) {
    assert.equal(mapCalls.get(paperId), callsBeforeRecovery.get(paperId) + 1);
  }
});

test("CASE 4: InvalidLlmResponse skips repeated full maps and uses source-evidence fallback", async () => {
  const workspace = new MemoryWorkspace();
  workspace.setFile("literature/fallback.pdf", "Prepared source evidence remains readable.", 1000);
  let mapperCalls = 0;
  let fallbackCalls = 0;
  const system = await makeSystem(workspace, {
    mapAttempts: 3,
    async mapWorker() {
      mapperCalls += 1;
      throw invalidMapperError();
    },
    async fallbackMapWorker(input) {
      fallbackCalls += 1;
      return validMapFor(input, "fallback recovery");
    },
  });
  await system.registry.reconcile(treeFor(workspace));
  const sourceId = system.registry.list({ sourceKind: "paper" })[0].sourceId;

  const result = await system.corpusWorkflows.run("Summarize all papers");
  const journal = result.resultHandle ? await system.results.read(result.resultHandle) : result;

  assert.equal(mapperCalls, 1);
  assert.equal(fallbackCalls, 1);
  assert.equal(journal.maps[sourceId].generationMode, "source-evidence-fallback");
  assert.equal(journal.coverage.papersSuccessfullyAnalyzed, 1);
  assert.equal(system.registry.get(sourceId).indexStatus, "ready");
  assert.equal(journal.mapFailures[sourceId], undefined);
});

test("CASE 5: an encrypted PDF is accurately retained as a preparation failure", async () => {
  const workspace = new MemoryWorkspace();
  workspace.setFile("literature/encrypted.pdf", "encrypted fixture", 1000);
  const system = await makeSystem(workspace, {
    async parsePaper() {
      const error = new Error("The PDF is encrypted and cannot be opened.");
      error.code = "ENCRYPTED_PDF";
      throw error;
    },
  });
  await system.registry.reconcile(treeFor(workspace));

  const result = await system.corpusWorkflows.run("Summarize all papers");
  const journal = result.resultHandle ? await system.results.read(result.resultHandle) : result;
  const status = await system.corpusWorkflows.getWorkflowStatus(journal.workflowId);

  assert.equal(status.papersPrepared, 0);
  assert.equal(status.papersAnalyzed, 0);
  assert.equal(status.failures[0].stage, "prepare");
  assert.equal(status.failures[0].code, "ENCRYPTED_PDF");
  assert.equal(status.failures[0].sourceReady, false);
  assert.equal(status.failures[0].retryable, false);
  assert.match(status.failures[0].message, /encrypted/i);
});

test("Side Chat authorization allows internal state but denies official, destructive, and external effects", () => {
  assert.equal(TOOL_EFFECTS.ensure_source_ready, ToolEffect.INTERNAL_STATE);
  assert.equal(TOOL_EFFECTS.reconcile_sources, ToolEffect.INTERNAL_STATE);
  assert.equal(TOOL_EFFECTS.update_corpus_synthesis, ToolEffect.INTERNAL_STATE);
  assert.equal(TOOL_EFFECTS.update_project_memory, ToolEffect.INTERNAL_STATE);
  assert.equal(TOOL_EFFECTS.restart_local_worker, ToolEffect.INTERNAL_STATE);
  assert.equal(TOOL_EFFECTS.update_recommendation, ToolEffect.RESULT_PRODUCING);

  assert.equal(authorizeTool("side_chat", "ensure_source_ready").allowed, true);
  assert.equal(authorizeTool("side_chat", "reconcile_sources").allowed, true);
  assert.equal(authorizeTool("side_chat", "update_corpus_synthesis").allowed, true);
  assert.equal(authorizeTool("side_chat", "update_project_memory").allowed, true);
  assert.equal(authorizeTool("side_chat", "restart_local_worker").allowed, true);
  assert.equal(authorizeTool("side_chat", "update_recommendation").allowed, false);
  assert.equal(authorizeTool("side_chat", ToolEffect.DESTRUCTIVE_SOURCE).allowed, false);
  assert.equal(authorizeTool("side_chat", ToolEffect.EXTERNAL_SIDE_EFFECT).allowed, false);
  assert.equal(authorizeTool("agent_command", "update_recommendation").allowed, true);
  assert.equal(Object.hasOwn(TOOL_EFFECTS, "kill_process"), false);
  assert.equal(Object.hasOwn(TOOL_EFFECTS, "terminate_pid"), false);
});

test("native PDF analysis hashes private bytes at source use, skips Paper Cards, and caches the derived artifact", async () => {
  const workspace = new MemoryWorkspace();
  workspace.setFile(
    "literature/private-paper.pdf",
    "%PDF-1.4\nA private whole-paper scientific report.",
    1000
  );
  const system = await makeSystem(workspace);
  await system.registry.reconcile(treeFor(workspace));
  const paper = system.registry.list({ sourceKind: "paper" })[0];
  const workerInputs = [];
  const analyzer = new RequestyPdfAnalyzer({
    workspace,
    registry: system.registry,
    preparation: system.preparation,
    results: system.results,
    async nativePdfWorker(input) {
      workerInputs.push(input);
      return {
        model: "openai-responses/gpt-4.1",
        analysis: {
          summary: "The whole paper was analyzed directly.",
          researchQuestion: null,
          themes: ["whole-paper review"],
          methods: [],
          keyFindings: [],
          limitations: [],
          evidenceRefs: [paper.sourceId + ":p1"],
          notes: null,
        },
        diagnostics: { structuredOutputMode: "native-pdf+json_schema" },
      };
    },
  });

  const first = await analyzer.analyze(paper.sourceId, "Summarize the whole paper.", {
    surface: "side_chat",
  });
  const second = await analyzer.analyze(paper.sourceId, "Summarize the whole paper.", {
    surface: "side_chat",
  });
  workspace.setFile(
    "literature/private-paper.pdf",
    "%PDF-1.4\nThe private paper was materially revised.",
    2000
  );
  const third = await analyzer.analyze(paper.sourceId, "Summarize the whole paper.", {
    surface: "side_chat",
  });

  assert.equal(workerInputs.length, 2);
  assert.ok(workerInputs[0].bytes instanceof Uint8Array);
  assert.equal(Object.hasOwn(workerInputs[0], "fileUrl"), false);
  assert.equal(system.preparation.metrics.fullHashCalls, 2);
  assert.equal(system.parseCalls, 0);
  assert.equal(system.registry.get(paper.sourceId).hashStatus, "ready");
  assert.equal(system.registry.get(paper.sourceId).parseStatus, "not_started");
  assert.equal(system.registry.get(paper.sourceId).paperCardStatus, "absent");
  assert.equal(first.cached, false);
  assert.equal(second.cached, true);
  assert.equal(third.cached, false);
});

test("whole-paper Side Chat can select native PDF while an exact-text question stays on local retrieval", async () => {
  const workspace = new MemoryWorkspace();
  workspace.setFile(
    "literature/selected.pdf",
    "%PDF-1.4\nThe reported concentration was 25 mM.",
    1000
  );
  const system = await makeSystem(workspace);
  await system.registry.reconcile(treeFor(workspace));
  const paper = system.registry.list({ sourceKind: "paper" })[0];
  let nativeCalls = 0;
  const nativePdfAnalyzer = {
    async analyze(paperId) {
      nativeCalls += 1;
      return {
        paperId,
        contentHash: "sha256:native",
        analysis: { summary: "Native whole-paper summary." },
        evidenceRefs: [`${paperId}:p1`],
        artifactPath: ".biodesign/native.json",
      };
    },
  };
  system.nativePdfAnalyzer = nativePdfAnalyzer;
  const literature = makeLiteratureHarness(system);
  literature.sourceSystem.nativePdfAnalyzer = nativePdfAnalyzer;
  const service = new ProjectContextService({ workspace, literature });
  const selectedPaths = [paper.path];

  const wholePaper = await service.buildContext({
    question: "Give me an overview of this selected study.",
    selectedPaths,
    selectedPaperIds: [paper.sourceId],
    workspaceTree: treeFor(workspace),
    surface: "side_chat",
  });
  const exactText = await service.buildContext({
    question: "What exact concentration does this paper report?",
    selectedPaths,
    selectedPaperIds: [paper.sourceId],
    workspaceTree: treeFor(workspace),
    surface: "side_chat",
  });

  assert.equal(wholePaper.files[0].evidenceType, "requesty-native-pdf-analysis");
  assert.equal(nativeCalls, 1);
  assert.equal(exactText.files[0].evidenceType, "original-paper-evidence");
  assert.match(exactText.files[0].content, /25 mM/);
  assert.equal(system.parseCalls, 1);
});

test("exhausted local mapper retries can recover through native PDF without downgrading source readiness", async () => {
  const workspace = new MemoryWorkspace();
  workspace.setFile(
    "literature/native-fallback.pdf",
    "%PDF-1.4\nThe source contains usable paper evidence.",
    1000
  );
  let nativeCalls = 0;
  let localFallbackCalls = 0;
  const system = await makeSystem(workspace, {
    mapAttempts: 2,
    async mapWorker() {
      throw invalidMapperError();
    },
    async fallbackMapWorker(input) {
      localFallbackCalls += 1;
      return validMapFor(input, "local fallback");
    },
  });
  await system.registry.reconcile(treeFor(workspace));
  const analyzer = new RequestyPdfAnalyzer({
    workspace,
    registry: system.registry,
    preparation: system.preparation,
    results: system.results,
    async nativePdfWorker(input) {
      nativeCalls += 1;
      return {
        model: "requesty/pdf-model",
        analysis: {
          title: input.filename,
          relevance: "high",
          researchQuestion: null,
          themes: ["native recovery"],
          methods: [],
          organisms: [],
          genes: [],
          proteins: [],
          pathways: [],
          experimentalStrategies: [],
          majorFindings: [
            {
              claim: "The native PDF fallback recovered the paper analysis.",
              evidenceRefs: input.evidenceRefs.slice(0, 1),
            },
          ],
          limitations: [],
          connectionsToOtherTopics: [],
          notes: null,
        },
      };
    },
  });
  system.corpusWorkflows.nativePdfAnalyzer = analyzer;

  const result = await system.corpusWorkflows.run("Summarize all papers", {
    surface: "side_chat",
    qualityMode: "balanced",
  });
  const journal = result.resultHandle
    ? await system.results.read(result.resultHandle)
    : result;
  const paperId = journal.snapshot[0].sourceId;

  assert.equal(nativeCalls, 1);
  assert.equal(localFallbackCalls, 0);
  assert.equal(journal.maps[paperId].generationMode, "native-pdf-fallback");
  assert.equal(journal.coverage.papersSuccessfullyAnalyzed, 1);
  assert.equal(system.registry.get(paperId).parseStatus, "ready");
  assert.equal(system.registry.get(paperId).indexStatus, "ready");
});

test("explicit Side Chat memory and automatic metadata updates preserve the current recommendation", async () => {
  const workspace = new MemoryWorkspace();
  workspace.state = {
    schemaVersion: 1,
    project: { goal: "Improve hydroxyectoine production." },
    ui: {},
    agent: { currentRecommendation: { id: "R1", text: "Retain the control strain." } },
    memory: { project: [], literature: [], experimental: [] },
  };
  const system = await makeSystem(workspace);
  await system.registry.reconcile(treeFor(workspace));
  const literature = makeLiteratureHarness(system);
  literature.sourceSystem.projectState = new ProjectStateService({
    workspace,
    registry: system.registry,
    jobs: system.jobs,
    corpusWorkflows: system.corpusWorkflows,
  });
  const service = new ProjectContextService({ workspace, literature });

  const context = await service.buildContext({
    question: "Remember that our primary assay metric is hydroxyectoine titer.",
    selectedPaths: [],
    selectedPaperIds: [],
    workspaceTree: treeFor(workspace),
    surface: "side_chat",
  });

  assert.equal(workspace.state.memory.records.length, 1);
  assert.equal(workspace.state.memory.records[0].kind, "metric");
  assert.match(workspace.state.memory.records[0].text, /hydroxyectoine titer/i);
  assert.ok(context.internalStateUpdates.some((item) => item.startsWith("memory:")));
  assert.ok(workspace.state.projectMetadata);
  assert.deepEqual(workspace.state.agent.currentRecommendation, {
    id: "R1",
    text: "Retain the control strain.",
  });
});

test("managed worker recovery is allowlisted, preserves journals, and resumes incomplete workflows", async () => {
  let resumeCalls = 0;
  let preparationResumeCalls = 0;
  const staleJob = {
    jobId: "job-1",
    jobType: "prepare:search",
    sourceIds: ["paper-1"],
    status: "stale",
  };
  const jobs = {
    inFlight: new Map(),
    async load() {},
    async persist() {},
    list({ status }) {
      return staleJob.status === status ? [staleJob] : [];
    },
  };
  const worker = new ManagedLocalWorker({
    workspace: {},
    jobs,
    preparation: {
      async ensureSourceReady(sourceIds, capability, options) {
        preparationResumeCalls += 1;
        assert.deepEqual(sourceIds, ["paper-1"]);
        assert.equal(capability, "search");
        assert.equal(options.surface, "side_chat");
        return { failures: [] };
      },
    },
    corpusWorkflows: {
      async resumeIncompleteWorkflows(options) {
        resumeCalls += 1;
        assert.equal(options.surface, "side_chat");
        return [
          {
            workflowId: "workflow-1",
            status: "completed",
            coverage: { papersSuccessfullyAnalyzed: 32 },
          },
        ];
      },
    },
  });
  worker.markUnhealthyForRecovery();
  const contextWorkspace = new MemoryWorkspace();
  contextWorkspace.state = {
    schemaVersion: 1,
    project: { goal: "Resume internal analysis." },
    ui: {},
    agent: {},
    memory: {},
  };
  const contextSystem = await makeSystem(contextWorkspace);
  await contextSystem.registry.reconcile(treeFor(contextWorkspace));
  const literature = makeLiteratureHarness(contextSystem);
  literature.sourceSystem.managedWorker = worker;
  const before = await worker.getStatus({ surface: "side_chat" });
  const contextResult = await new ProjectContextService({
    workspace: contextWorkspace,
    literature,
  }).buildContext({
    question: "Please recover the stuck analysis worker and resume the workflow.",
    selectedPaths: [],
    selectedPaperIds: [],
    workspaceTree: treeFor(contextWorkspace),
    surface: "side_chat",
  });
  const after = await worker.getStatus({ surface: "side_chat" });

  assert.equal(before.health, "unhealthy");
  assert.equal(after.health, "healthy");
  assert.equal(after.arbitraryProcessControl, false);
  assert.equal(contextResult.managedWorker.restarted, true);
  assert.equal(contextResult.managedWorker.resumedJobCount, 1);
  assert.deepEqual(contextResult.managedWorker.resumedWorkflowIds, ["workflow-1"]);
  assert.equal(preparationResumeCalls, 1);
  assert.equal(resumeCalls, 1);
});
