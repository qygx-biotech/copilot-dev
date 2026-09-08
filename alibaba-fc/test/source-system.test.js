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
  LiteratureApiClient,
  LiteratureModule,
  combineExtractedPaperText,
  chunkLiteratureText,
} = require("../../docs/literature-module.js");
const {
  CLOUD_RETRIEVAL,
} = require("../../shared/retrieval-contract.js");
const {
  ProjectContextService,
  WorkspaceChatStore,
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

  async ensureDirectory() {}

  async removeFile(path) {
    this.files.delete(path);
    this.json.delete(path);
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
    getPaperCardConfiguration: options.getPaperCardConfiguration,
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
  paperCardConfig: "/api/literature/config",
  plan: "/api/knowledge/plan-search",
  rerank: "/api/knowledge/rerank",
  map: "/api/corpus/map-paper",
  summarize: "/api/literature/summarize-chunk",
  paperCardSynthesize: "/api/literature/synthesize",
  nativePdf: "/api/literature/analyze-pdf-native",
  combinedText: "/api/literature/create-paper-card-from-text",
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
    [FC_ROUTES.paperCardConfig]: expected.paperCardConfig || 0,
    [FC_ROUTES.plan]: expected.plan || 0,
    [FC_ROUTES.rerank]: expected.rerank || 0,
    [FC_ROUTES.map]: expected.map || 0,
    [FC_ROUTES.summarize]: expected.summarize || 0,
    [FC_ROUTES.paperCardSynthesize]: expected.paperCardSynthesize || 0,
    [FC_ROUTES.nativePdf]: expected.nativePdf || 0,
    [FC_ROUTES.combinedText]: expected.combinedText || 0,
    [FC_ROUTES.global]: expected.global || 0,
  });
}

const TEST_PAPER_CARD_CONTRACT = Object.freeze({
  schemaVersion: 2,
  promptVersion: "canonical-paper-card-v2",
  modelSignature: "d".repeat(64),
});

const TEST_NATIVE_PAPER_CARD_CONTRACT = Object.freeze({
  ...TEST_PAPER_CARD_CONTRACT,
  generationStrategy: "native-pdf-combined-text-v2",
  generationContractVersion: 2,
  nativePdfSupported: true,
  nativePdfMaxBytes: 20 * 1024 * 1024,
  nativePdfSchemaVersion: 1,
  nativePdfPromptVersion: "canonical-paper-card-native-v1",
  nativePdfModelSignature: "e".repeat(64),
  combinedTextSupported: true,
  combinedTextMaxCharacters: 200000,
  combinedTextSchemaVersion: 1,
  combinedTextPromptVersion: "canonical-paper-card-combined-text-v1",
  combinedTextModelSignature: "f".repeat(64),
});

function validCanonicalPaperCard(
  source,
  contentHash,
  contract = TEST_PAPER_CARD_CONTRACT
) {
  const descriptor = {
    sourceId: source.sourceId,
    contentHash,
    schemaVersion: contract.schemaVersion,
    model: "paper-card-test-model",
    modelSignature: contract.modelSignature,
    promptVersion: contract.promptVersion,
    generationStrategy: contract.generationStrategy || "text-map-reduce-v1",
    generationContractVersion: Number(contract.generationContractVersion) || 0,
    nativePdfSchemaVersion: Number(contract.nativePdfSchemaVersion) || 0,
    nativePdfPromptVersion:
      contract.nativePdfPromptVersion || "not-applicable",
    nativePdfModelSignature:
      contract.nativePdfModelSignature || "not-applicable",
    combinedTextSupported: contract.combinedTextSupported === true,
    combinedTextMaxCharacters:
      Math.max(0, Number(contract.combinedTextMaxCharacters) || 0),
    combinedTextSchemaVersion:
      Number(contract.combinedTextSchemaVersion) || 0,
    combinedTextPromptVersion:
      contract.combinedTextPromptVersion || "not-applicable",
    combinedTextModelSignature:
      contract.combinedTextModelSignature || "not-applicable",
    sourceArtifactSchemaVersion: 1,
    extractorVersion: "local-source-v1",
  };
  const finding = `EctD finding from ${source.displayName}.`;
  return {
    schemaVersion: contract.schemaVersion,
    paperCardVersion: contract.schemaVersion,
    paperId: source.sourceId,
    documentId: source.sourceId,
    fileName: source.displayName,
    generatedAt: "2026-09-04T00:00:00.000Z",
    source: {
      filename: source.displayName,
      relativePath: source.path,
      hash: contentHash,
      artifactSchemaVersion: 1,
      extractorVersion: "local-source-v1",
    },
    model: descriptor.model,
    modelSignature: descriptor.modelSignature,
    promptVersion: descriptor.promptVersion,
    generationStrategy: descriptor.generationStrategy,
    generationContractVersion: descriptor.generationContractVersion,
    generationMode: "map-reduce",
    fallbackReason: null,
    nativePdfSchemaVersion: descriptor.nativePdfSchemaVersion,
    nativePdfPromptVersion: descriptor.nativePdfPromptVersion,
    nativePdfModelSignature: descriptor.nativePdfModelSignature,
    combinedTextSupported: descriptor.combinedTextSupported,
    combinedTextMaxCharacters: descriptor.combinedTextMaxCharacters,
    combinedTextSchemaVersion: descriptor.combinedTextSchemaVersion,
    combinedTextPromptVersion: descriptor.combinedTextPromptVersion,
    combinedTextModelSignature: descriptor.combinedTextModelSignature,
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
    evidenceFindings: [{
      claim: finding,
      evidenceRefs: [`${source.sourceId}:p1:${source.sourceId}-P1-C1`],
    }],
  };
}

function paperCardGenerator(workspace, counters, options = {}) {
  return async ({ source, contentHash, paperCardContract, onProgress }) => {
    if (options.failPaperCards === true) {
      throw new Error("controlled canonical Paper Card failure");
    }
    counters?.hit(FC_ROUTES.summarize);
    counters?.hit(FC_ROUTES.paperCardSynthesize);
    if (options.emitFallbackProgress === true) {
      onProgress?.({
        stage: "map-reduce-start",
        completed: 0,
        total: 5,
        fallbackReason: "native-provider-failure",
        mapReduceReason: "native-provider-failure",
        route: "map-reduce",
      });
      onProgress?.({
        stage: "summarizing",
        completed: 2,
        total: 5,
        fallbackReason: "native-provider-failure",
        mapReduceReason: "native-provider-failure",
        route: "map-reduce",
      });
    }
    const contract = paperCardContract || TEST_PAPER_CARD_CONTRACT;
    const card = validCanonicalPaperCard(source, contentHash, contract);
    const path = `.biodesign/literature/summaries/${source.sourceId}.json`;
    await workspace.writeJson(path, card);
    return {
      path,
      card,
      schemaVersion: contract.schemaVersion,
      model: card.model,
      modelSignature: contract.modelSignature,
      promptVersion: card.promptVersion,
      contentHash,
    };
  };
}

function nativePaperCardAnalysis(sourceId, contentHash) {
  return {
    sourceIdentity: { paperId: sourceId, contentHash },
    title: "Native analysis",
    authors: ["Test Author"],
    year: 2025,
    abstractSummary: "The study evaluates EctD activity.",
    researchQuestion: "How does the variant affect EctD activity?",
    majorFindings: [{
      claim: "The tested variant improved EctD activity.",
      citations: [{ page: 1, quote: "variant improved EctD activity" }],
    }, {
      claim: "A claim with an invalid citation remains uncited.",
      citations: [{ page: 99, quote: "not in the local PDF" }],
    }, {
      claim: "A claim with a fabricated quotation remains uncited.",
      citations: [{ page: 1, quote: "fabricated quotation absent from the PDF" }],
    }],
    methods: ["activity assay"],
    methodsSummary: "A controlled activity assay was used.",
    organisms: ["Escherichia coli"],
    genes: ["ectD"],
    proteins: ["EctD"],
    pathways: ["hydroxyectoine biosynthesis"],
    metabolites: ["hydroxyectoine"],
    experimentalConditions: ["30 degrees C"],
    measurements: ["specific activity"],
    importantResults: [],
    limitations: ["One condition was tested."],
    keywords: ["EctD"],
    topics: ["enzyme engineering"],
    shortSummary: "The paper characterizes an EctD variant.",
    mainConclusion: "The variant improved activity under the tested condition.",
  };
}

function makeNativePaperCardGenerator(workspace, calls, options = {}) {
  const api = {
    async analyzePdfNative(payload) {
      calls.nativePdf += 1;
      calls.nativePayloads.push(clone({
        paperId: payload.paperId,
        filename: payload.filename,
        contentHash: payload.contentHash,
        byteLength: payload.bytes?.byteLength,
        task: payload.task,
        purpose: payload.purpose,
        responseSchema: payload.responseSchema,
      }));
      if (options.failNative === true) {
        const error = new Error("controlled native failure");
        if (options.nativeErrorCode) error.code = options.nativeErrorCode;
        if (options.terminalNativeFailure === true) {
          error.terminalProviderFailure = true;
        }
        error.attempts = 1;
        error.fallbackReason = "native-provider-failure";
        throw error;
      }
      const analysis = nativePaperCardAnalysis(payload.paperId, payload.contentHash);
      if (options.invalidNative === true) {
        analysis.sourceIdentity.paperId = "stale-paper-id";
      }
      return {
        analysis,
        paperId: payload.paperId,
        contentHash: payload.contentHash,
        model: "native-test-model",
        modelSignature: TEST_NATIVE_PAPER_CARD_CONTRACT.nativePdfModelSignature,
        schemaVersion: TEST_NATIVE_PAPER_CARD_CONTRACT.nativePdfSchemaVersion,
        promptVersion: TEST_NATIVE_PAPER_CARD_CONTRACT.nativePdfPromptVersion,
        attempts: 1,
      };
    },
    async createPaperCardFromText(payload) {
      calls.combinedText = (calls.combinedText || 0) + 1;
      calls.combinedPayloads ||= [];
      calls.combinedPayloads.push(clone({
        paperId: payload.paperId,
        filename: payload.filename,
        contentHash: payload.contentHash,
        text: payload.text,
        pageCount: payload.pageCount,
        chunkCount: payload.chunkCount,
        language: payload.language,
      }));
      if (options.failCombined === true || options.contextFailCombined === true) {
        const error = new Error("controlled combined-text failure");
        error.attempts = 1;
        error.fallbackReason = options.contextFailCombined
          ? "combined-text-context-length"
          : "combined-text-provider-failure";
        error.verifiedContextLengthError = options.contextFailCombined === true;
        throw error;
      }
      const analysis = nativePaperCardAnalysis(payload.paperId, payload.contentHash);
      if (options.invalidCombined === true) {
        analysis.sourceIdentity.contentHash = "sha256:stale";
      }
      return {
        analysis,
        paperId: payload.paperId,
        contentHash: payload.contentHash,
        model: "combined-text-test-model",
        modelSignature:
          TEST_NATIVE_PAPER_CARD_CONTRACT.combinedTextModelSignature,
        schemaVersion:
          TEST_NATIVE_PAPER_CARD_CONTRACT.combinedTextSchemaVersion,
        promptVersion:
          TEST_NATIVE_PAPER_CARD_CONTRACT.combinedTextPromptVersion,
        attempts: 1,
      };
    },
    async summarizeChunk() {
      calls.summarize += 1;
      return {
        summary: "Parsed-text evidence.",
        mainFindings: ["The tested variant improved EctD activity."],
      };
    },
    async synthesize() {
      calls.synthesize += 1;
      return {
        title: "Text fallback",
        authors: [],
        year: null,
        abstractSummary: null,
        researchQuestion: "How does the variant affect activity?",
        mainFindings: ["The tested variant improved EctD activity."],
        methods: ["activity assay"],
        methodsSummary: null,
        organisms: [],
        genes: ["ectD"],
        proteins: ["EctD"],
        pathways: [],
        metabolites: [],
        experimentalConditions: [],
        measurements: ["specific activity"],
        importantResults: [],
        limitations: [],
        keywords: ["EctD"],
        topics: ["enzyme engineering"],
        shortSummary: "Parsed-text Paper Card.",
        summary: "Parsed-text Paper Card.",
        keyResults: [],
        mainConclusion: "The variant improved activity.",
        model: "text-test-model",
        modelSignature: TEST_NATIVE_PAPER_CARD_CONTRACT.modelSignature,
        schemaVersion: TEST_NATIVE_PAPER_CARD_CONTRACT.schemaVersion,
        promptVersion: TEST_NATIVE_PAPER_CARD_CONTRACT.promptVersion,
      };
    },
  };
  const generatorContext = {
    api,
    workspace,
    now: () => new Date("2026-09-06T00:00:00.000Z"),
    config: {
      chunkCharacters: options.chunkCharacters || 30,
      chunkOverlap: options.chunkOverlap ?? 0,
      chunkConcurrency: 2,
      maxExtractedCharacters: 180000,
      maxChunks: 48,
    },
  };
  return LiteratureModule.prototype.generatePaperCardFromPrepared.bind(
    generatorContext
  );
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
        if (trace.failReranker) throw new Error("controlled reranker outage");
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
    failReranker: options.failReranker === true,
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
    getPaperCardConfiguration: async () => {
      counters.hit(FC_ROUTES.paperCardConfig);
      return options.paperCardContract || TEST_PAPER_CARD_CONTRACT;
    },
    generatePaperCard: paperCardGenerator(workspace, counters, options),
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

test("one paper-level candidate bypasses rerank cache and provider without changing local evidence", async () => {
  const { counters, knowledgeService, paperIds, trace } = await createCorpusScenario(1);
  const events = [];
  knowledgeService.subscribe((event) => events.push(clone(event)));
  const originalReadCache = knowledgeService.readCache.bind(knowledgeService);
  let rerankCacheReads = 0;
  knowledgeService.readCache = async (kind, ...args) => {
    if (kind === "rerank") rerankCacheReads += 1;
    return originalReadCache(kind, ...args);
  };

  const result = await knowledgeService.search("EctD evidence", {
    mode: "deep",
    paperIds,
    collections: ["literature-evidence"],
    intent: "scientific paper evidence",
  });

  assert.equal(result.results.length, 1);
  assert.equal(result.results[0].paperId, paperIds[0]);
  assert.equal(result.results[0].score, 1);
  assert.match(result.results[0].matchedSections[0].snippet, /EctD finding/);
  assert.equal(result.results[0].cloudRerank, undefined);
  assert.deepEqual(result.diagnostics.reranker, {
    status: "not-attempted",
    reason: "single-candidate",
    submittedCandidates: 1,
    omittedCandidates: 0,
    evidenceCharacters: result.diagnostics.reranker.evidenceCharacters,
  });
  assert.ok(result.diagnostics.reranker.evidenceCharacters > 0);
  assert.equal(rerankCacheReads, 0);
  assert.equal(counters.counts[FC_ROUTES.rerank], 0);
  assert.equal(trace.rerankPayloads.length, 0);
  assert.equal(events.some((event) => event.stage === "reranking-evidence"), false);
});

test("native Paper Cards use one PDF call per cold paper and survive warm reuse, restart, and one modification", async () => {
  const workspace = new MemoryWorkspace();
  const paths = [
    "literature/team-a/paper.pdf",
    "literature/team-b/paper.pdf",
    "literature/中文/论文.pdf",
  ];
  for (const path of paths) {
    workspace.setFile(
      path,
      `%PDF-1.4\n${
        "The tested variant improved EctD activity. ".repeat(10).slice(0, 105)
      }`,
      1000
    );
  }
  const calls = { nativePdf: 0, summarize: 0, synthesize: 0, nativePayloads: [] };
  const generator = makeNativePaperCardGenerator(workspace, calls);
  const options = {
    getPaperCardConfiguration: async () => TEST_NATIVE_PAPER_CARD_CONTRACT,
    generatePaperCard: generator,
  };
  let system = await makeSystem(workspace, options);
  await system.registry.reconcile(treeFor(workspace));
  let paperIds = system.registry.list({ sourceKind: "paper" })
    .map((source) => source.sourceId);

  const cold = await system.preparation.ensureSourceReady(
    paperIds,
    "paper_card"
  );
  assert.equal(cold.failures.length, 0);
  assert.equal(calls.nativePdf, 3);
  assert.equal(calls.combinedText || 0, 0);
  assert.equal(calls.summarize, 0);
  assert.equal(calls.synthesize, 0);
  assert.ok(calls.nativePayloads.every((payload) =>
    payload.responseSchema === "canonical_paper_card" &&
    payload.purpose === "canonical-paper-card" &&
    !payload.filename.includes("/") &&
    payload.byteLength > 0
  ));
  const firstSource = system.registry.get(paperIds[0]);
  const firstPaperArtifact = await workspace.readJson(
    firstSource.artifacts.paperText.path
  );
  assert.equal(
    chunkLiteratureText(
      firstPaperArtifact.pages
        .map((page) => `# Page ${page.page}\n${page.text}`)
        .join("\n\n"),
      {
        chunkCharacters: 30,
        chunkOverlap: 0,
        maxExtractedCharacters: 180000,
        maxChunks: 48,
      }
    ).chunks.length,
    5
  );
  const firstCard = await workspace.readJson(firstSource.artifacts.paperCard.path);
  assert.equal(firstCard.generationMode, "native-pdf");
  assert.equal(firstCard.generationDiagnostics.nativePdfEndpointCalls, 1);
  assert.equal(firstCard.generationDiagnostics.textFallbackOperations, 0);
  assert.equal(firstCard.generationDiagnostics.nativeEvidenceCitationsSubmitted, 3);
  assert.equal(firstCard.generationDiagnostics.nativeEvidenceCitationsVerified, 1);
  assert.equal(firstCard.generationDiagnostics.nativeEvidenceCitationsDropped, 2);
  assert.deepEqual(firstCard.evidenceFindings[0].evidenceRefs, [
    `${paperIds[0]}:p1:${paperIds[0]}-P1-C1`,
  ]);
  assert.equal(firstCard.evidenceFindings.length, 1);
  assert.equal(firstCard.generationDiagnostics.evidenceFindingsDropped, 2);
  assert.match(firstCard.cacheKey, /canonical-paper-card-combined-text-v1/);

  const warm = await system.preparation.ensureSourceReady(paperIds, "paper_card");
  assert.ok(warm.sources.every((source) => source.cached === true));
  assert.equal(calls.nativePdf, 3);

  system = await makeSystem(workspace, options);
  await system.registry.reconcile(treeFor(workspace));
  paperIds = system.registry.list({ sourceKind: "paper" })
    .map((source) => source.sourceId);
  const restarted = await system.preparation.ensureSourceReady(paperIds, "paper_card");
  assert.ok(restarted.sources.every((source) => source.cached === true));
  assert.equal(calls.nativePdf, 3);

  workspace.setFile(
    paths[2],
    "%PDF-1.4\nThe tested variant improved EctD activity after modification.",
    2000
  );
  await system.registry.reconcile(treeFor(workspace));
  await system.preparation.ensureSourceReady(paperIds, "paper_card");
  assert.equal(calls.nativePdf, 4);
  assert.equal(calls.summarize, 0);
  assert.equal(calls.synthesize, 0);
});

test("mixed 41-paper corpus uses one native call per cold paper and keeps x/41 progress", async () => {
  const workspace = new MemoryWorkspace();
  for (let index = 0; index < 41; index += 1) {
    workspace.setFile(
      `literature/set-${index % 3}/论文-${index + 1}.pdf`,
      `%PDF-1.4\nThe tested variant improved EctD activity in paper ${index + 1}.`,
      1000
    );
  }
  const calls = { nativePdf: 0, summarize: 0, synthesize: 0, nativePayloads: [] };
  const system = await makeSystem(workspace, {
    getPaperCardConfiguration: async () => TEST_NATIVE_PAPER_CARD_CONTRACT,
    generatePaperCard: makeNativePaperCardGenerator(workspace, calls),
  });
  await system.registry.reconcile(treeFor(workspace));
  const paperIds = system.registry.list({ sourceKind: "paper" })
    .map((source) => source.sourceId);
  await system.preparation.ensureSourceReady(
    paperIds.slice(0, 17),
    "paper_card"
  );
  calls.nativePdf = 0;
  calls.nativePayloads.length = 0;
  const progress = [];

  const coldResult = await system.corpusWorkflows.run(
    "Compare every paper in this corpus.",
    { onProgress: (event) => progress.push(clone(event)) }
  );
  const cold = await resolveWorkflowResult(system, coldResult);
  assert.equal(calls.nativePdf, 24);
  assert.equal(calls.summarize, 0);
  assert.equal(calls.synthesize, 0);
  assert.equal(cold.processingAccounting.logicalPaperCardGenerations, 24);
  assert.equal(cold.processingAccounting.paperCardCacheHits, 17);
  assert.equal(cold.processingAccounting.nativePdfEndpointCalls, 24);
  assert.equal(cold.processingAccounting.nativePdfProviderAttempts, 24);
  assert.equal(cold.processingAccounting.nativePaperCardSuccesses, 24);
  assert.equal(cold.processingAccounting.textFallbackOperations, 0);
  const paperProgress = progress.filter((event) =>
    event.stage === "canonical-paper-artifact-create" ||
    event.stage === "canonical-paper-artifact-created" ||
    event.stage === "canonical-paper-artifact-cache-hit"
  );
  assert.ok(paperProgress.length > 0);
  assert.ok(paperProgress.every((event) =>
    event.papersTotal === 41 &&
    event.total === 41 &&
    event.papersCompleted >= 0 &&
    event.papersCompleted <= 41 &&
    event.chunksTotal === undefined
  ));
  assert.ok(paperProgress.every((event, index) =>
    index === 0 ||
    event.papersCompleted >= paperProgress[index - 1].papersCompleted
  ));

  const warmResult = await system.corpusWorkflows.run(
    "这些论文中反复出现了哪些方法和生物？",
    { language: "zh" }
  );
  const warm = await resolveWorkflowResult(system, warmResult);
  assert.equal(calls.nativePdf, 24);
  assert.equal(warm.processingAccounting.paperCardCacheHits, 41);
  assert.equal(warm.processingAccounting.logicalPaperCardGenerations, 0);
  assert.equal(warm.processingAccounting.nativePdfEndpointCalls, 0);

  workspace.setFile(
    "literature/set-0/论文-1.pdf",
    "%PDF-1.4\nThe tested variant improved EctD activity after one modification.",
    2000
  );
  await system.registry.reconcile(treeFor(workspace));
  const modifiedResult = await system.corpusWorkflows.run(
    "What limitations and measurements are reported?"
  );
  const modified = await resolveWorkflowResult(system, modifiedResult);
  assert.equal(calls.nativePdf, 25);
  assert.equal(modified.processingAccounting.canonicalArtifactsCreated, 1);
  assert.equal(modified.processingAccounting.canonicalArtifactsReused, 40);
  assert.equal(modified.processingAccounting.nativePdfEndpointCalls, 1);
  assert.equal(modified.processingAccounting.nativePaperCardSuccesses, 1);
});

test("native Paper Card failure sends five fitting chunks in one combined-text request", async () => {
  const workspace = new MemoryWorkspace();
  const fallbackPdfText = `%PDF-1.4\n${
    "The tested variant improved EctD activity. ".repeat(1400).slice(0, 49000)
  }`;
  workspace.setFile(
    "literature/fallback.pdf",
    fallbackPdfText,
    1000
  );
  const calls = { nativePdf: 0, summarize: 0, synthesize: 0, nativePayloads: [] };
  const progress = [];
  const system = await makeSystem(workspace, {
    getPaperCardConfiguration: async () => TEST_NATIVE_PAPER_CARD_CONTRACT,
    generatePaperCard: makeNativePaperCardGenerator(workspace, calls, {
      failNative: true,
      chunkCharacters: 10000,
    }),
  });
  await system.registry.reconcile(treeFor(workspace));
  const paperId = system.registry.list({ sourceKind: "paper" })[0].sourceId;

  await system.preparation.ensureSourceReady([paperId], "paper_card", {
    onProgress: (event) => progress.push(clone(event)),
  });
  const card = await workspace.readJson(
    system.registry.get(paperId).artifacts.paperCard.path
  );
  assert.equal(calls.nativePdf, 1);
  assert.equal(calls.combinedText, 1);
  assert.equal(calls.summarize, 0);
  assert.equal(calls.synthesize, 0);
  assert.equal(card.generationMode, "combined-text");
  assert.equal(card.fallbackReason, "native-provider-failure");
  assert.equal(card.generationDiagnostics.nativePdfProviderAttempts, 1);
  assert.equal(card.generationDiagnostics.combinedTextEndpointCalls, 1);
  assert.equal(card.generationDiagnostics.combinedTextProviderAttempts, 1);
  assert.equal(card.generationDiagnostics.textFallbackOperations, 0);
  assert.equal(calls.combinedPayloads[0].chunkCount, 5);
  assert.equal(calls.combinedPayloads[0].language, "en");
  assert.ok(progress.some((event) =>
    event.stage === "combined-paper-card-request" &&
    event.route === "combined-text" &&
    event.fallbackReason === "native-provider-failure" &&
    event.message === "Creating paper analysis from extracted text"
  ));
  assert.equal(progress.some((event) => event.stage === "summarizing"), false);
});

test("native Paper Card failure sends nineteen fitting chunks in one combined-text request", async () => {
  const workspace = new MemoryWorkspace();
  const fallbackPdfText = `%PDF-1.4\n${
    "The tested variant improved EctD activity. ".repeat(5000).slice(0, 179000)
  }`;
  workspace.setFile("literature/nineteen-chunks.pdf", fallbackPdfText, 1000);
  const calls = { nativePdf: 0, summarize: 0, synthesize: 0, nativePayloads: [] };
  const progress = [];
  const system = await makeSystem(workspace, {
    getPaperCardConfiguration: async () => TEST_NATIVE_PAPER_CARD_CONTRACT,
    generatePaperCard: makeNativePaperCardGenerator(workspace, calls, {
      failNative: true,
      chunkCharacters: 10000,
      chunkOverlap: 400,
    }),
  });
  await system.registry.reconcile(treeFor(workspace));
  const paperId = system.registry.list({ sourceKind: "paper" })[0].sourceId;

  await system.preparation.ensureSourceReady([paperId], "paper_card", {
    onProgress: (event) => progress.push(clone(event)),
  });
  const card = await workspace.readJson(
    system.registry.get(paperId).artifacts.paperCard.path
  );

  assert.equal(calls.nativePdf, 1);
  assert.equal(calls.combinedText, 1);
  assert.equal(calls.combinedPayloads[0].chunkCount, 19);
  assert.ok(calls.combinedPayloads[0].text.length > 120000);
  assert.ok(calls.combinedPayloads[0].text.length <= 200000);
  assert.equal(calls.summarize, 0);
  assert.equal(calls.synthesize, 0);
  assert.equal(card.generationMode, "combined-text");
  assert.equal(progress.some((event) => event.stage === "map-reduce-start"), false);
  assert.equal(progress.some((event) => event.stage === "summarizing"), false);
});

test("English and Chinese questions reuse one combined-text card across chat deletion and restart", async () => {
  const workspace = new MemoryWorkspace();
  workspace.setFile(
    "literature/嵌套/酶工程论文.pdf",
    "%PDF-1.4\nThe tested variant improved EctD activity.",
    1000
  );
  const calls = { nativePdf: 0, summarize: 0, synthesize: 0, nativePayloads: [] };
  const contract = {
    ...TEST_NATIVE_PAPER_CARD_CONTRACT,
    nativePdfSupported: false,
    nativePdfModelSignature: "not-applicable",
  };
  const options = {
    getPaperCardConfiguration: async () => contract,
    generatePaperCard: makeNativePaperCardGenerator(workspace, calls),
  };
  let system = await makeSystem(workspace, options);
  await system.registry.reconcile(treeFor(workspace));
  const english = await resolveWorkflowResult(
    system,
    await system.corpusWorkflows.run("What did this paper find?", { language: "en" })
  );
  assert.equal(calls.combinedText, 1);
  assert.equal(calls.combinedPayloads[0].language, "en");
  assert.equal(english.processingAccounting.canonicalArtifactsCreated, 1);
  assert.equal(english.processingAccounting.combinedTextEndpointCalls, 1);
  assert.equal(english.processingAccounting.combinedTextProviderAttempts, 1);
  assert.equal(english.processingAccounting.combinedTextPaperCardSuccesses, 1);
  assert.equal(english.processingAccounting.mapReduceOperations, 0);

  const chatStore = new WorkspaceChatStore({ workspace });
  const firstChat = await chatStore.loadActiveConversation();
  await chatStore.clearActiveConversation();
  assert.equal(
    await workspace.fileExists(`.biodesign/chat/conversations/${firstChat.id}.json`),
    false
  );

  system = await makeSystem(workspace, options);
  await system.registry.reconcile(treeFor(workspace));
  const chinese = await resolveWorkflowResult(
    system,
    await system.corpusWorkflows.run("这篇论文发现了什么？", { language: "zh" })
  );
  assert.equal(calls.combinedText, 1);
  assert.equal(calls.nativePdf, 0);
  assert.equal(calls.summarize, 0);
  assert.equal(calls.synthesize, 0);
  assert.equal(chinese.processingAccounting.canonicalArtifactsReused, 1);
  assert.equal(chinese.processingAccounting.canonicalArtifactsCreated, 0);
  assert.equal(chinese.processingAccounting.combinedTextEndpointCalls, 0);
  assert.equal(chinese.processingAccounting.combinedTextProviderAttempts, 0);
});

test("native-PDF and combined-text routes create one compatible canonical cache contract", async () => {
  const createCard = async (failNative) => {
    const workspace = new MemoryWorkspace();
    workspace.setFile(
      "literature/contract.pdf",
      "%PDF-1.4\nThe tested variant improved EctD activity.",
      1000
    );
    const calls = { nativePdf: 0, summarize: 0, synthesize: 0, nativePayloads: [] };
    const contract = TEST_NATIVE_PAPER_CARD_CONTRACT;
    const system = await makeSystem(workspace, {
      getPaperCardConfiguration: async () => contract,
      generatePaperCard: makeNativePaperCardGenerator(workspace, calls, {
        failNative,
      }),
    });
    await system.registry.reconcile(treeFor(workspace));
    const source = system.registry.list({ sourceKind: "paper" })[0];
    await system.preparation.ensureSourceReady([source.sourceId], "paper_card");
    return {
      card: await workspace.readJson(
        system.registry.get(source.sourceId).artifacts.paperCard.path
      ),
      calls,
    };
  };

  const native = await createCard(false);
  const combined = await createCard(true);
  assert.equal(native.card.generationMode, "native-pdf");
  assert.equal(combined.card.generationMode, "combined-text");
  assert.equal(native.card.cacheKey, combined.card.cacheKey);
  for (const key of [
    "schemaVersion",
    "paperCardVersion",
    "generationStrategy",
    "generationContractVersion",
    "promptVersion",
    "modelSignature",
    "combinedTextSchemaVersion",
    "combinedTextPromptVersion",
    "combinedTextModelSignature",
  ]) assert.equal(native.card[key], combined.card[key], key);
  assert.equal(native.calls.nativePdf, 1);
  assert.equal(native.calls.combinedText || 0, 0);
  assert.equal(combined.calls.nativePdf, 1);
  assert.equal(combined.calls.combinedText, 1);
});

test("oversized native PDF bytes still use one fitting combined-text request", async () => {
  const workspace = new MemoryWorkspace();
  workspace.setFile(
    "literature/too-large.pdf",
    "%PDF-1.4\nThe tested variant improved EctD activity in an oversized fixture.",
    1000
  );
  const calls = { nativePdf: 0, summarize: 0, synthesize: 0, nativePayloads: [] };
  const system = await makeSystem(workspace, {
    getPaperCardConfiguration: async () => ({
      ...TEST_NATIVE_PAPER_CARD_CONTRACT,
      nativePdfMaxBytes: 10,
    }),
    generatePaperCard: makeNativePaperCardGenerator(workspace, calls),
  });
  await system.registry.reconcile(treeFor(workspace));
  const paperId = system.registry.list({ sourceKind: "paper" })[0].sourceId;
  await system.preparation.ensureSourceReady([paperId], "paper_card");
  const card = await workspace.readJson(
    system.registry.get(paperId).artifacts.paperCard.path
  );

  assert.equal(calls.nativePdf, 0);
  assert.equal(calls.combinedText, 1);
  assert.equal(calls.summarize, 0);
  assert.equal(calls.synthesize, 0);
  assert.equal(card.generationMode, "combined-text");
  assert.equal(card.fallbackReason, "native-pdf-too-large");
  assert.equal(card.generationDiagnostics.nativePdfEndpointCalls, 0);
});

test("unsupported and malformed native Paper Cards each use one combined-text call", async () => {
  const cases = [
    {
      name: "unsupported",
      contract: {
        ...TEST_NATIVE_PAPER_CARD_CONTRACT,
        nativePdfSupported: false,
        nativePdfModelSignature: "not-applicable",
      },
      generatorOptions: {},
      expectedNativeCalls: 0,
      expectedReason: "native-structured-output-unsupported",
    },
    {
      name: "malformed",
      contract: TEST_NATIVE_PAPER_CARD_CONTRACT,
      generatorOptions: { invalidNative: true },
      expectedNativeCalls: 1,
      expectedReason: "native-schema-or-provenance-invalid",
    },
  ];
  for (const fixture of cases) {
    const workspace = new MemoryWorkspace();
    workspace.setFile(
      `literature/${fixture.name}.pdf`,
      "%PDF-1.4\nThe tested variant improved EctD activity.",
      1000
    );
    const calls = {
      nativePdf: 0,
      summarize: 0,
      synthesize: 0,
      nativePayloads: [],
    };
    const system = await makeSystem(workspace, {
      getPaperCardConfiguration: async () => fixture.contract,
      generatePaperCard: makeNativePaperCardGenerator(
        workspace,
        calls,
        fixture.generatorOptions
      ),
    });
    await system.registry.reconcile(treeFor(workspace));
    const paperId = system.registry.list({ sourceKind: "paper" })[0].sourceId;
    await system.preparation.ensureSourceReady([paperId], "paper_card");
    const card = await workspace.readJson(
      system.registry.get(paperId).artifacts.paperCard.path
    );

    assert.equal(calls.nativePdf, fixture.expectedNativeCalls, fixture.name);
    assert.equal(calls.combinedText, 1, fixture.name);
    assert.equal(calls.summarize, 0, fixture.name);
    assert.equal(calls.synthesize, 0, fixture.name);
    assert.equal(card.generationMode, "combined-text", fixture.name);
    assert.equal(card.fallbackReason, fixture.expectedReason, fixture.name);
    assert.equal(card.generationDiagnostics.textFallbackOperations, 0, fixture.name);
  }
});

test("combined text removes adjacent overlap and preserves page boundaries", () => {
  const combined = combineExtractedPaperText({
    chunks: [
      { page: 1, text: "alpha beta gamma shared overlap" },
      { page: 1, text: "shared overlap delta epsilon" },
      { page: 2, text: "中文证据 remains on page two" },
    ],
  });
  assert.equal((combined.text.match(/shared overlap/g) || []).length, 1);
  assert.match(combined.text, /^# Page 1\n/);
  assert.match(combined.text, /\n\n# Page 2\n中文证据/);
  assert.equal(combined.chunkCount, 3);
  assert.equal(combined.pageCount, 2);
});

test("only local oversize or verified context length activates map-reduce", async () => {
  for (const fixture of [
    { name: "local-size", combinedTextMaxCharacters: 20 },
    { name: "provider-context", contextFailCombined: true },
  ]) {
    const workspace = new MemoryWorkspace();
    workspace.setFile(
      `literature/${fixture.name}.pdf`,
      "%PDF-1.4\nThe tested variant improved EctD activity across a bounded paper.",
      1000
    );
    const calls = { nativePdf: 0, summarize: 0, synthesize: 0, nativePayloads: [] };
    const contract = {
      ...TEST_NATIVE_PAPER_CARD_CONTRACT,
      nativePdfSupported: false,
      nativePdfModelSignature: "not-applicable",
      combinedTextMaxCharacters:
        fixture.combinedTextMaxCharacters ||
        TEST_NATIVE_PAPER_CARD_CONTRACT.combinedTextMaxCharacters,
    };
    const progress = [];
    const system = await makeSystem(workspace, {
      getPaperCardConfiguration: async () => contract,
      generatePaperCard: makeNativePaperCardGenerator(workspace, calls, fixture),
    });
    await system.registry.reconcile(treeFor(workspace));
    const paperId = system.registry.list({ sourceKind: "paper" })[0].sourceId;
    await system.preparation.ensureSourceReady([paperId], "paper_card", {
      onProgress: (event) => progress.push(clone(event)),
    });
    const card = await workspace.readJson(
      system.registry.get(paperId).artifacts.paperCard.path
    );
    assert.equal(card.generationMode, "map-reduce", fixture.name);
    assert.equal(calls.summarize, 3, fixture.name);
    assert.equal(calls.synthesize, 1, fixture.name);
    assert.equal(
      calls.combinedText || 0,
      fixture.contextFailCombined ? 1 : 0,
      fixture.name
    );
    assert.ok(progress.some((event) =>
      event.stage === "map-reduce-start" && event.route === "map-reduce"
    ), fixture.name);
  }
});

test("an absent or legacy generation contract fails before every provider route", async () => {
  for (const paperCardContract of [
    null,
    {
      ...TEST_NATIVE_PAPER_CARD_CONTRACT,
      generationStrategy: "text-map-reduce-v1",
      generationContractVersion: 1,
    },
  ]) {
    const workspace = new MemoryWorkspace();
    const calls = { nativePdf: 0, summarize: 0, synthesize: 0, nativePayloads: [] };
    const generate = makeNativePaperCardGenerator(workspace, calls);
    await assert.rejects(
      generate({
        source: {
          sourceId: "paper-contract",
          displayName: "contract.pdf",
          path: "literature/contract.pdf",
          sizeBytes: 100,
          mtimeNs: 1000,
        },
        paperArtifact: {
          pageCount: 1,
          pages: [{ page: 1, text: "The tested variant improved EctD activity." }],
          chunks: [{
            page: 1,
            chunkId: "paper-contract-P1-C1",
            text: "The tested variant improved EctD activity.",
          }],
        },
        bytes: new TextEncoder().encode("%PDF-1.4"),
        contentHash: "sha256:contract",
        paperCardContract,
      }),
      (error) => error.code === "PAPER_CARD_CONFIGURATION_CHANGED"
    );
    assert.equal(calls.nativePdf, 0);
    assert.equal(calls.combinedText || 0, 0);
    assert.equal(calls.summarize, 0);
    assert.equal(calls.synthesize, 0);
  }
});

test("combined provider and schema failures do not multiply into chunk calls", async () => {
  for (const fixture of [
    { name: "provider", options: { failCombined: true } },
    { name: "invalid-output", options: { invalidCombined: true } },
  ]) {
    const workspace = new MemoryWorkspace();
    workspace.setFile(
      `literature/${fixture.name}-failure.pdf`,
      "%PDF-1.4\nThe tested variant improved EctD activity.",
      1000
    );
    const calls = { nativePdf: 0, summarize: 0, synthesize: 0, nativePayloads: [] };
    const system = await makeSystem(workspace, {
      getPaperCardConfiguration: async () => ({
        ...TEST_NATIVE_PAPER_CARD_CONTRACT,
        nativePdfSupported: false,
        nativePdfModelSignature: "not-applicable",
      }),
      generatePaperCard: makeNativePaperCardGenerator(
        workspace,
        calls,
        fixture.options
      ),
    });
    await system.registry.reconcile(treeFor(workspace));
    const paperId = system.registry.list({ sourceKind: "paper" })[0].sourceId;
    await assert.rejects(
      system.preparation.ensureSourceReady([paperId], "paper_card")
    );
    assert.equal(calls.combinedText, 1, fixture.name);
    assert.equal(calls.summarize, 0, fixture.name);
    assert.equal(calls.synthesize, 0, fixture.name);
    assert.equal(system.registry.get(paperId).paperCardStatus, "failed", fixture.name);
  }
});

test("native authentication and transport failures stop without a second provider route", async () => {
  for (const fixture of [
    { nativeErrorCode: "AUTH_REQUIRED" },
    { nativeErrorCode: "NETWORK_ERROR" },
    { nativeErrorCode: "LLM_HTTP_ERROR", terminalNativeFailure: true },
  ]) {
    const { nativeErrorCode } = fixture;
    const workspace = new MemoryWorkspace();
    workspace.setFile(
      `literature/${nativeErrorCode}.pdf`,
      "%PDF-1.4\nThe tested variant improved EctD activity.",
      1000
    );
    const calls = { nativePdf: 0, summarize: 0, synthesize: 0, nativePayloads: [] };
    const system = await makeSystem(workspace, {
      getPaperCardConfiguration: async () => TEST_NATIVE_PAPER_CARD_CONTRACT,
      generatePaperCard: makeNativePaperCardGenerator(workspace, calls, {
        failNative: true,
        nativeErrorCode,
        terminalNativeFailure: fixture.terminalNativeFailure,
      }),
    });
    await system.registry.reconcile(treeFor(workspace));
    const paperId = system.registry.list({ sourceKind: "paper" })[0].sourceId;
    await assert.rejects(
      system.preparation.ensureSourceReady([paperId], "paper_card"),
      (error) => error.code === nativeErrorCode
    );
    assert.equal(calls.nativePdf, 1, nativeErrorCode);
    assert.equal(calls.combinedText || 0, 0, nativeErrorCode);
    assert.equal(calls.summarize, 0, nativeErrorCode);
    assert.equal(calls.synthesize, 0, nativeErrorCode);
  }
});

test("two paper-level candidates still use validated cloud reranking", async () => {
  const { counters, knowledgeService, paperIds, trace } = await createCorpusScenario(2);
  const result = await knowledgeService.search("Compare EctD evidence", {
    mode: "deep",
    paperIds,
    collections: ["literature-evidence"],
    intent: "scientific paper evidence",
  });

  assert.equal(result.results.length, 2);
  assert.equal(result.diagnostics.reranker.status, "succeeded");
  assert.equal(result.diagnostics.reranker.submittedCandidates, 2);
  assert.equal(counters.counts[FC_ROUTES.rerank], 1);
  assert.equal(trace.rerankPayloads.length, 1);
});

test("multi-candidate reranker failure preserves the existing local fallback", async () => {
  const { counters, knowledgeService, paperIds } = await createCorpusScenario(2, [], {
    failReranker: true,
  });
  const result = await knowledgeService.search("Compare EctD evidence", {
    mode: "deep",
    paperIds,
    collections: ["literature-evidence"],
    intent: "scientific paper evidence",
  });

  assert.equal(counters.counts[FC_ROUTES.rerank], 1);
  assert.equal(result.diagnostics.reranker.status, "failed");
  assert.equal(result.diagnostics.fallback, "local-lexical-fusion");
  assert.deepEqual(result.results.map((entry) => entry.score), [1, 1]);
  assert.ok(result.results.every((entry) => entry.cloudRerank === undefined));
});

test("client accounting separates logical endpoints, transport attempts, provider attempts, and cache hits", async () => {
  const api = new LiteratureApiClient({
    baseUrl: "https://example.invalid",
    getHeaders: () => ({ Authorization: "Bearer fixture" }),
    fetch: async (url) => {
      const path = new URL(url).pathname;
      if (path === FC_ROUTES.paperCardConfig) {
        return new Response(JSON.stringify({
          ok: true,
          ...TEST_PAPER_CARD_CONTRACT,
        }), { status: 200 });
      }
      if (path === FC_ROUTES.plan) {
        return new Response(JSON.stringify({
          ok: false,
          error: "ProviderFailure",
          message: "Controlled provider failure.",
          attempts: 1,
        }), { status: 502 });
      }
      if (path === FC_ROUTES.combinedText) {
        return new Response(JSON.stringify({
          ok: true,
          paperId: "paper-a",
          contentHash: "sha256:a",
          analysis: nativePaperCardAnalysis("paper-a", "sha256:a"),
          model: "combined-model",
          modelSignature: "f".repeat(64),
          schemaVersion: 1,
          promptVersion: "canonical-paper-card-combined-text-v1",
          attempts: 1,
        }), { status: 200 });
      }
      return new Response(JSON.stringify({
        ok: true,
        configurationSignature: "b".repeat(64),
        ranked: [],
        attempts: 2,
        cached: true,
      }), { status: 200 });
    },
  });

  await api.getPaperCardConfiguration();
  await api.rerankKnowledgeCandidates({
    query: "EctD",
    intent: "evidence",
    candidates: [],
    callContext: {},
  });
  await api.createPaperCardFromText({
    paperId: "paper-a",
    filename: "paper.pdf",
    contentHash: "sha256:a",
    text: "# Page 1\nEvidence",
    pageCount: 1,
    chunkCount: 1,
    callContext: { turnId: "turn-accounting" },
  });
  await assert.rejects(
    api.planKnowledgeSearch({ query: "EctD", intent: "evidence", callContext: {} }),
    (error) => error.code === "ProviderFailure"
  );
  const accounting = api.getEndpointAccounting();
  assert.deepEqual(accounting.logicalEndpointCalls, {
    [FC_ROUTES.paperCardConfig]: 1,
    [FC_ROUTES.rerank]: 1,
    [FC_ROUTES.combinedText]: 1,
    [FC_ROUTES.plan]: 1,
  });
  assert.deepEqual(accounting.transportAttempts, {
    [FC_ROUTES.paperCardConfig]: 1,
    [FC_ROUTES.rerank]: 1,
    [FC_ROUTES.combinedText]: 1,
    [FC_ROUTES.plan]: 1,
  });
  assert.deepEqual(accounting.providerAttempts, {
    [FC_ROUTES.paperCardConfig]: 0,
    [FC_ROUTES.rerank]: 2,
    [FC_ROUTES.combinedText]: 1,
    [FC_ROUTES.plan]: 1,
  });
  assert.deepEqual(accounting.cacheHits, { [FC_ROUTES.rerank]: 1 });
  assert.equal(
    api.getTurnCallCounts("turn-accounting").combined_text_paper_card,
    1
  );
});

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
      const card = validCanonicalPaperCard(source, contentHash);
      await workspace.writeJson(path, card);
      return {
        path,
        card,
        schemaVersion: card.schemaVersion,
        model: card.model,
        modelSignature: card.modelSignature,
        promptVersion: card.promptVersion,
      };
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

test("multilingual legacy fusion preserves relevant full-chunk scores beyond display-snippet truncation", async () => {
  const sources = ["P1", "P2"].map(sourceId => ({ sourceId, sourceKind: "paper", displayName: `${sourceId}.pdf`,
    path: `literature/${sourceId}.pdf`, catalogStatus: "ready", indexStatus: "ready" }));
  const chunks = {
    P1: `${"Background discussion. ".repeat(50)} EctD cobalt-dependent stabilization mechanism.`,
    P2: "EctD is only mentioned in passing.",
  };
  const tools = new LiteratureTools({ registry: { list: () => sources, aliases: {} },
    preparation: { readPaperArtifact: async paperId => ({ chunks: [{ text: chunks[paperId], page: 8, chunkId: "late" }] }) } });
  const canonical = "EctD cobalt-dependent stabilization mechanism";
  const english = await tools.searchPapers(canonical, { topK: 1 });
  const chinese = await tools.searchPapers("EctD 钴相关稳定化机制", { topK: 1,
    requestUnderstanding: { originalQuery: "EctD 钴相关稳定化机制", inputLanguage: "zh", canonicalQueryEn: canonical } });
  assert.equal(english.results[0].paperId, "P1");
  assert.equal(chinese.results[0].paperId, "P1");
  assert.ok(chinese.results[0].score > 0);
  assert.ok(chinese.results[0].snippet.length <= 500);
  assert.doesNotMatch(chinese.results[0].snippet, /stabilization/);
  assert.equal(chinese.results[0].queryScores, undefined);
});

test("missing Paper Card sample counts are completed from current L1 without regenerating the card", async () => {
  const workspace = new MemoryWorkspace();
  workspace.setFile("literature/specimens.pdf", "original", 1000);
  let cardCalls = 0;
  const system = await makeSystem(workspace, {
    parsePaper: async () => ({ text: `# Page 1\n${"Background discussion. ".repeat(400)}\n# Page 8\nThe mean strength was 18 MPa, n=5 independent specimens.`, pageCount: 8 }),
    generatePaperCard: async () => { cardCalls += 1; throw new Error("A precise lookup must not generate a card"); },
  });
  await system.registry.reconcile(treeFor(workspace));
  const source = system.registry.getByPath("literature/specimens.pdf");
  const completed = await system.literatureTools.completeEvidence("What mean and sample count did the paper report?", [source.sourceId], {
    files: [{ paperId: source.sourceId, evidenceType: "paper-card", content: "Mean strength 18 MPa; sample count missing from this summary." }],
  });
  assert.equal(completed.calls, 1);
  assert.equal(cardCalls, 0);
  assert.match(completed.files[0].content, /n=5/);
  assert.match(completed.files[0].content, new RegExp(`${source.sourceId}:p8:`));
  assert.deepEqual(completed.missingByPaper, []);
  assert.ok(completed.files[0].content.length < 8000);
  const alreadyComplete = await system.literatureTools.completeEvidence("What mean and sample count did the paper report?", [source.sourceId], { files: completed.files });
  assert.equal(alreadyComplete.calls, 0);
  const cardPrefix = await system.literatureTools.completeEvidence("What sample count did the paper report?", [source.sourceId], {
    files: [{ paperId: source.sourceId, relativePath: source.path, evidenceType: "optional-paper-card+original-evidence",
      content: `Paper Card [${source.sourceId}:p8:chunk-1] n=999\n\nOriginal-paper evidence for ${source.path}:\n[${source.sourceId}:p1:chunk-1]\nBackground only.` }],
  });
  assert.equal(cardPrefix.calls, 1);
  assert.match(cardPrefix.files[0].content, /n=5/);
  assert.doesNotMatch(cardPrefix.files[0].content, /n=999/);
  const absent = await system.literatureTools.completeEvidence("What is the Km?", [source.sourceId]);
  assert.deepEqual(absent.files, []);
  assert.deepEqual(absent.missingByPaper, [{ paperId: source.sourceId, dimensions: ["km"] }]);
});

test("failed or stale L1 completion attempts are counted without exposing stale evidence", async () => {
  const source = { sourceId: "P1", sourceKind: "paper", catalogStatus: "ready", contentHash: "current" };
  for (const fail of [true, false]) {
    const tools = new LiteratureTools({ registry: { get: () => source }, preparation: {
      ensureSourceReady: async () => { if (fail) throw new Error("Source read failed"); },
      readPaperArtifact: async () => ({ contentHash: "old", chunks: [{ page: 8, chunkId: "c1", text: "n=5" }] }),
    } });
    const result = await tools.completeEvidence("What sample count was reported?", ["P1"]);
    assert.equal(result.calls, 1);
    assert.deepEqual(result.files, []);
    assert.deepEqual(result.missingByPaper, [{ paperId: "P1", dimensions: ["sample_count"] }]);
  }
});

test("cached corpus maps remain reused when a missing requested fact is completed from L1", async () => {
  const workspace = new MemoryWorkspace();
  workspace.setFile("literature/a.pdf", "The mean strength was 18 MPa, n=5 independent specimens.", 1000);
  let mapCalls = 0;
  const system = await makeSystem(workspace, { mapWorker: async (input) => {
    mapCalls += 1;
    return { paperId: input.paperId, title: "Specimen study", relevance: "high", themes: ["strength"],
      findings: [{ claim: "Mean strength was 18 MPa.", evidenceRefs: input.evidence.map((entry) => entry.evidenceHandle) }], limitations: [] };
  } });
  await system.registry.reconcile(treeFor(workspace));
  const question = "Summarize all papers and report each mean and sample count.";
  const first = await system.corpusWorkflows.run(question);
  const count = mapCalls;
  const repeated = await system.corpusWorkflows.run(question);
  assert.equal(mapCalls, count);
  const source = system.registry.getByPath("literature/a.pdf");
  const completed = await system.literatureTools.completeEvidence(question, [source.sourceId], {
    files: [{ evidenceType: "corpus-workflow", content: JSON.stringify(repeated.preview || repeated) }],
  });
  assert.equal(mapCalls, count);
  assert.equal(completed.calls, 1);
  assert.match(completed.files[0].content, /n=5/);
  assert.ok(first.resultHandle || first.workflowId);
});

test("corpus result previews expose distinct original evidence before long reductions", async () => {
  const workspace = new MemoryWorkspace();
  const store = new SourceResultStore({ workspace, maxInlineCharacters: 120 });
  const originalA = {
    evidenceRef: "paper-a:p2:table-1",
    page: 2,
    excerpt: "The mean strength was 18 MPa, n=7 independent specimens.",
  };
  const originalB = {
    evidenceRef: "paper-b:p4:table-2",
    page: 4,
    excerpt: "The mean strength was 21 MPa, n=9 independent specimens.",
  };
  const value = {
    workflowId: "corpus-example",
    question: "Compare the reported means and sample counts in the two studies.",
    reduction: {
      papersIncluded: 2,
      papersFailed: 0,
      themes: [],
      groupSyntheses: [{ claims: [{ claim: "The studies report different means. ".repeat(500) }] }],
      findings: [{ claim: "Mean strength was 18 MPa and 21 MPa." }],
    },
    verification: [
      ...Array.from({ length: 24 }, (_, index) => ({
        claim: `Finding ${index} from the first study.`,
        status: "original-evidence-located",
        locatedEvidence: [originalA],
      })),
      { claim: "A finding from the second study.", status: "original-evidence-located", locatedEvidence: [originalB] },
    ],
  };

  const compact = await store.compact(value);
  const firstRead = JSON.stringify(compact.preview).slice(0, 12000);
  assert.match(firstRead, /n=7 independent specimens/);
  assert.match(firstRead, /n=9 independent specimens/);
  assert.match(firstRead, /paper-a:p2:table-1/);
  assert.match(firstRead, /paper-b:p4:table-2/);
  assert.deepEqual(compact.preview.originalEvidence, [originalA, originalB]);
  assert.deepEqual(compact.preview.reduction, value.reduction);
  assert.deepEqual(await store.read(compact.resultHandle), value);
});

test("corpus original evidence previews stay bounded and preserve source handles", async () => {
  const workspace = new MemoryWorkspace();
  const store = new SourceResultStore({ workspace, maxInlineCharacters: 120 });
  const value = {
    workflowId: "large-corpus-example",
    verification: Array.from({ length: 100 }, (_, index) => ({
      status: "original-evidence-located",
      locatedEvidence: [{ evidenceRef: `paper-${index}:p3:chunk-1`, page: 3, excerpt: "x".repeat(600) }],
    })),
  };

  const compact = await store.compact(value);
  assert.ok(compact.preview.originalEvidence.length > 1);
  assert.ok(compact.preview.originalEvidence.length < value.verification.length);
  assert.ok(JSON.stringify(compact.preview.originalEvidence).length <= 8000);
  assert.deepEqual(compact.preview.originalEvidence[0], value.verification[0].locatedEvidence[0]);
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
  const system = await makeSystem(workspace, {
    async generatePaperCard({ source, contentHash }) {
      const path = `.biodesign/cards/${source.sourceId}.json`;
      const card = validCanonicalPaperCard(source, contentHash);
      const finding = "Exact finding 12.4 with original evidence.";
      card.title = "Cached card title";
      card.researchQuestion = "What is the exact finding?";
      card.topics = ["enzyme kinetics"];
      card.methods = ["kinetic assay"];
      card.mainFindings = [finding];
      card.importantResults = [finding];
      card.keyResults = [finding];
      card.evidenceFindings = [{
        claim: finding,
        evidenceRefs: [`${source.sourceId}:p1:${source.sourceId}-P1-C1`],
      }];
      await workspace.writeJson(path, card);
      return {
        path,
        card,
        schemaVersion: card.schemaVersion,
        model: card.model,
        modelSignature: card.modelSignature,
        promptVersion: card.promptVersion,
      };
    },
  });
  await system.registry.reconcile(treeFor(workspace));
  const sourceId = system.registry.list({ sourceKind: "paper" })[0].sourceId;
  await system.preparation.ensureSourceReady([sourceId], "paper_card");

  const result = await system.corpusWorkflows.run("Summarize all papers");
  const journal = result.resultHandle ? await system.results.read(result.resultHandle) : result;

  assert.equal(journal.maps[sourceId].title, "Cached card title");
  assert.equal(journal.maps[sourceId].usedPaperCard, true);
  assert.equal(journal.maps[sourceId].generationMode, "paper-card-cache");
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

test("cold corpus creates canonical artifacts without per-paper retrieval, rerank, or mapping", async () => {
  const { counters, system, paperIds, trace } = await createCorpusScenario(4);
  const result = await system.corpusWorkflows.run(
    "Compare all papers in the corpus",
    { retrievalProfile: "high", mapConcurrency: 2, turnId: "turn-corpus-4" }
  );
  const journal = result.resultHandle ? await system.results.read(result.resultHandle) : result;

  assert.equal(journal.coverage.papersSuccessfullyAnalyzed, 4);
  assert.ok(Object.values(journal.maps).every((mapped) =>
    mapped.generationMode === "paper-card-cache" &&
    mapped.projectionMode === "local-deterministic"
  ));
  assertRouteCounts(counters, {
    paperCardConfig: 1,
    summarize: 4,
    paperCardSynthesize: 4,
  });
  assert.equal(trace.retrievalOperations.length, 0);
  assert.equal(trace.plannerPayloads.length, 0);
  assert.equal(trace.rerankPayloads.length, 0);
  assert.equal(trace.mapperInputs.length, 0);
  assert.equal(journal.processingAccounting.canonicalArtifactsCreated, paperIds.length);
  assert.equal(journal.processingAccounting.localQuestionProjections, paperIds.length);

  counters.reset();
  const warmResult = await system.corpusWorkflows.run(
    "Compare all papers in the corpus",
    { retrievalProfile: "high", mapConcurrency: 2, turnId: "turn-corpus-4-warm" }
  );
  const warmJournal = warmResult.resultHandle
    ? await system.results.read(warmResult.resultHandle)
    : warmResult;
  assertRouteCounts(counters, { paperCardConfig: 1 });
  assert.equal(warmJournal.processingAccounting.canonicalArtifactsCreated, 0);
  assert.equal(warmJournal.processingAccounting.canonicalArtifactsReused, paperIds.length);
  assert.equal(warmJournal.processingAccounting.localQuestionProjections, 0);
  assert.equal(warmJournal.processingAccounting.providerMapRequests, 0);
  assert.equal(trace.plannerPayloads.length, 0);
  assert.equal(trace.rerankPayloads.length, 0);
  assert.equal(trace.mapperInputs.length, 0);
});

test("canonical artifacts survive chats, paraphrases, renames, restart, and rebuild only modified papers", async () => {
  const workspace = new MemoryWorkspace();
  const paths = [
    "literature/team-a/paper.pdf",
    "literature/team-b/paper.pdf",
    "literature/中文/酶工程研究.pdf",
  ];
  for (const path of paths) {
    workspace.setFile(
      path,
      `EctD stability and fermentation conditions from ${path}.`,
      1000
    );
  }
  const fileIds = new Map(paths.map((path, index) => [path, `file-${index + 1}`]));
  const treeWithFileIds = () => {
    const tree = treeFor(workspace);
    for (const entry of tree.children) {
      entry.filesystemFileId = fileIds.get(entry.relativePath) || null;
    }
    return tree;
  };
  const counters = makeRouteCounters();
  const trace = {
    failPlanner: false,
    failReranker: false,
    plannerDelayMs: 0,
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
  const systemOptions = {
    knowledgeService,
    getPaperCardConfiguration: async () => {
      counters.hit(FC_ROUTES.paperCardConfig);
      return TEST_PAPER_CARD_CONTRACT;
    },
    generatePaperCard: paperCardGenerator(workspace, counters),
    async mapWorker(input) {
      counters.hit(FC_ROUTES.map);
      trace.mapperInputs.push(clone(input));
      return validMapFor(input, "unexpected-provider-map");
    },
  };
  let system = await makeSystem(workspace, systemOptions);
  await system.registry.reconcile(treeWithFileIds());
  const ask = async (activeSystem, question, language = "en") => {
    const result = await activeSystem.corpusWorkflows.run(question, {
      retrievalProfile: "high",
      language,
    });
    counters.hit(FC_ROUTES.global);
    return resolveWorkflowResult(activeSystem, result);
  };

  const cold = await ask(system, "Compare stability across every paper.");
  assertRouteCounts(counters, {
    paperCardConfig: 1,
    summarize: 3,
    paperCardSynthesize: 3,
    global: 1,
  });
  assert.equal(cold.processingAccounting.canonicalArtifactsCreated, 3);
  const sourceIdsByPath = new Map(
    system.registry.list({ sourceKind: "paper" }).map((source) => [source.path, source.sourceId])
  );
  assert.equal(new Set(sourceIdsByPath.values()).size, 3);

  const chatStore = new WorkspaceChatStore({ workspace });
  const firstChat = await chatStore.loadActiveConversation();
  firstChat.messages.push({
    id: workspace.createId(),
    role: "user",
    content: "Compare stability across every paper.",
    createdAt: "2026-09-05T00:00:00.000Z",
  });
  await chatStore.saveConversation(firstChat);
  const durableArtifacts = [
    ".biodesign/knowledge/qmd-index.json",
    ".biodesign/retrieval/cache.json",
    ".biodesign/workflows/maps/provider-map.json",
    ".biodesign/corpus/journal.json",
  ];
  for (const path of durableArtifacts) {
    await workspace.writeJson(path, { retained: true });
  }
  const clearedChat = await chatStore.clearActiveConversation();
  assert.notEqual(clearedChat.id, firstChat.id);
  assert.equal(
    await workspace.fileExists(`.biodesign/chat/conversations/${firstChat.id}.json`),
    false
  );
  for (const path of durableArtifacts) {
    assert.equal(await workspace.fileExists(path), true);
  }
  for (const source of system.registry.list({ sourceKind: "paper" })) {
    assert.equal(await workspace.fileExists(source.artifacts.paperCard.path), true);
  }

  counters.reset();
  const chinese = await ask(system, "请用中文比较这些论文中的发酵条件。", "zh");
  assertRouteCounts(counters, { paperCardConfig: 1, global: 1 });
  assert.equal(chinese.processingAccounting.canonicalArtifactsReused, 3);
  assert.equal(chinese.processingAccounting.canonicalArtifactsCreated, 0);
  assert.equal(chinese.processingAccounting.localQuestionProjections, 3);
  assert.ok(Object.values(chinese.maps).every((map) =>
    map.generationMode === "paper-card-cache" &&
    map.findings.every((finding) => !finding.claim.includes("请用中文"))
  ));

  const oldPath = "literature/team-a/paper.pdf";
  const renamedPath = "literature/team-a/renamed-paper.pdf";
  const oldFile = workspace.files.get(oldPath);
  workspace.files.delete(oldPath);
  workspace.files.set(renamedPath, makeFile("renamed-paper.pdf", await oldFile.text(), 1000));
  const stableFileId = fileIds.get(oldPath);
  fileIds.delete(oldPath);
  fileIds.set(renamedPath, stableFileId);
  counters.reset();
  const renameResult = await system.registry.reconcile(treeWithFileIds());
  const renamedSourceId = sourceIdsByPath.get(oldPath);
  assert.deepEqual(renameResult.changes.renamed, [{
    sourceId: renamedSourceId,
    from: oldPath,
    to: renamedPath,
  }]);
  const renamed = await ask(system, "Summarize methods in all papers.");
  assert.equal(system.registry.get(renamedSourceId).path, renamedPath);
  assertRouteCounts(counters, { paperCardConfig: 1, global: 1 });
  const renamedCard = await workspace.readJson(
    system.registry.get(renamedSourceId).artifacts.paperCard.path
  );
  assert.equal(renamedCard.source.relativePath, renamedPath);
  assert.equal(renamed.maps[renamedSourceId].paperId, renamedSourceId);

  counters.reset();
  const restartedKnowledgeService = await makeRouteCountedDeepKnowledgeService(
    workspace,
    counters,
    trace
  );
  system = await makeSystem(workspace, {
    ...systemOptions,
    knowledgeService: restartedKnowledgeService,
  });
  await system.registry.reconcile(treeWithFileIds());
  const restarted = await ask(system, "Which organisms and pathways are reported?");
  assertRouteCounts(counters, { paperCardConfig: 1, global: 1 });
  assert.equal(restarted.processingAccounting.canonicalArtifactsReused, 3);
  assert.equal(restarted.processingAccounting.canonicalArtifactsCreated, 0);

  const modifiedPath = "literature/中文/酶工程研究.pdf";
  workspace.setFile(modifiedPath, "Modified EctD measurements and limitations.", 2000);
  counters.reset();
  await system.registry.reconcile(treeWithFileIds());
  const modified = await ask(system, "Compare measurements and limitations.");
  assertRouteCounts(counters, {
    paperCardConfig: 1,
    summarize: 1,
    paperCardSynthesize: 1,
    global: 1,
  });
  assert.equal(modified.processingAccounting.canonicalArtifactsReused, 2);
  assert.equal(modified.processingAccounting.canonicalArtifactsCreated, 1);
  assert.equal(modified.processingAccounting.providerMapRequests, 0);
});

test("41-paper corpus progress keeps paper totals separate from fallback chunks", async () => {
  const { counters, system, paperIds, trace } = await createCorpusScenario(
    41,
    [],
    { emitFallbackProgress: true }
  );
  const progress = [];
  const question = "帮我总结所有文献，写一个综述。";
  const result = await system.corpusWorkflows.run(question, {
    retrievalProfile: "high",
    mapConcurrency: 2,
    language: "zh",
    turnId: "turn-corpus-41-zh",
    onProgress: (event) => progress.push(clone(event)),
  });
  const journal = await resolveWorkflowResult(system, result);

  assert.equal(journal.coverage.papersSuccessfullyAnalyzed, 41);
  assertRouteCounts(counters, {
    paperCardConfig: 1,
    summarize: 41,
    paperCardSynthesize: 41,
  });
  assert.equal(trace.retrievalOperations.length, 0);
  assert.equal(trace.plannerPayloads.length, 0);
  assert.equal(trace.rerankPayloads.length, 0);
  assert.equal(trace.mapperInputs.length, 0);
  assert.equal(journal.sharedRetrievalPlan, null);
  assert.equal(
    progress.filter((event) => event.stage === "canonical-paper-artifact-created").length,
    paperIds.length
  );
  assert.equal(
    progress.filter((event) => event.stage === "canonical-paper-projection").length,
    paperIds.length
  );
  assert.equal(progress.some((event) => event.stage === "reranking-evidence"), false);
  const fallbackChunkEvents = progress.filter((event) =>
    event.stage === "canonical-paper-artifact-create" &&
    event.sourceStage === "summarizing"
  );
  assert.equal(fallbackChunkEvents.length, paperIds.length);
  assert.ok(fallbackChunkEvents.every((event) =>
    event.total === 41 &&
    event.papersTotal === 41 &&
    event.completed <= 41 &&
    event.chunksCompleted === 2 &&
    event.chunksTotal === 5
  ));
  assert.equal(journal.processingAccounting.logicalPaperCardGenerations, 41);
  assert.equal(journal.processingAccounting.textFallbackOperations, 41);
  assert.equal(
    journal.processingAccounting.textFallbackReasons["native-provider-failure"],
    41
  );
});

test("restart and one newly added paper reuse canonical artifacts and process only the new source", async () => {
  const scenario = await createCorpusScenario(2);
  const { workspace, counters, system, trace } = scenario;
  const question = "Across all papers, compare EctD stability.";
  await system.corpusWorkflows.run(question, {
    retrievalProfile: "high",
    mapConcurrency: 2,
  });
  assertRouteCounts(counters, {
    paperCardConfig: 1,
    summarize: 2,
    paperCardSynthesize: 2,
  });

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
  assertRouteCounts(counters, {
    paperCardConfig: 1,
    summarize: 1,
    paperCardSynthesize: 1,
  });
  assert.equal(trace.plannerPayloads.length, 0);
  assert.equal(trace.retrievalOperations.length, 0);
  assert.equal(secondJournal.processingAccounting.canonicalArtifactsReused, 2);
  assert.equal(secondJournal.processingAccounting.canonicalArtifactsCreated, 1);
});

test("a resumed workflow reuses canonical artifacts and locally rebuilds a missing projection", async () => {
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
  assert.equal(resumedJournal.sharedRetrievalPlan, null);
  assertRouteCounts(counters, { paperCardConfig: 1 });
  assert.equal(resumedJournal.processingAccounting.canonicalArtifactsReused, 2);
  assert.equal(resumedJournal.processingAccounting.localQuestionProjections, 1);
});

test("materially different corpus questions reuse cards and create distinct local projections", async () => {
  const { counters, system, trace } = await createCorpusScenario(2);
  const firstResult = await system.corpusWorkflows.run("Summarize all papers.", {
    retrievalProfile: "high",
  });
  const first = await resolveWorkflowResult(system, firstResult);
  const secondResult = await system.corpusWorkflows.run(
    "Across all papers, focus specifically on fermentation conditions.",
    { retrievalProfile: "high" }
  );
  const second = await resolveWorkflowResult(system, secondResult);

  assert.equal(counters.counts[FC_ROUTES.plan], 0);
  assert.equal(trace.plannerPayloads.length, 0);
  assert.notEqual(first.workflowId, second.workflowId);
  assert.equal(second.processingAccounting.canonicalArtifactsReused, 2);
  assert.equal(second.processingAccounting.canonicalArtifactsCreated, 0);
  assert.equal(second.processingAccounting.localQuestionProjections, 2);
  assertRouteCounts(counters, {
    paperCardConfig: 2,
    summarize: 2,
    paperCardSynthesize: 2,
  });
});

test("planner failure occurs once at workflow scope and all papers use local fallback", async () => {
  const { counters, system, trace } = await createCorpusScenario(4, [], {
    failPlanner: true,
    failPaperCards: true,
  });
  const result = await system.corpusWorkflows.run(
    "帮我总结所有文献，写一个综述。",
    { retrievalProfile: "high", mapConcurrency: 2 }
  );
  const journal = await resolveWorkflowResult(system, result);

  assert.equal(journal.coverage.papersSuccessfullyAnalyzed, 4);
  assert.equal(journal.sharedRetrievalPlan.status, "local-fallback");
  assert.equal(trace.retrievalOperations.length, 4);
  assertRouteCounts(counters, {
    config: 1,
    paperCardConfig: 1,
    plan: 1,
    rerank: 0,
    map: 4,
  });
});

test("shared planning never leaks one paper's evidence into another mapper", async () => {
  const { system, paperIds, trace } = await createCorpusScenario(2, [], {
    failPaperCards: true,
  });
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
    progress.filter((event) => event.stage === "canonical-paper-artifact-cache-hit").length,
    4
  );
  assertRouteCounts(counters, { paperCardConfig: 1 });
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
  assertRouteCounts(counters, { paperCardConfig: 1 });
});

test("mixed warm and cold corpus creates only missing canonical artifacts", async () => {
  const { counters, system, paperIds } = await createCorpusScenario(4, [0, 2]);
  const result = await system.corpusWorkflows.run(
    "Compare all papers in the corpus",
    { retrievalProfile: "high", mapConcurrency: 4 }
  );
  const journal = result.resultHandle ? await system.results.read(result.resultHandle) : result;

  assert.equal(journal.maps[paperIds[0]].generationMode, "paper-card-cache");
  assert.equal(journal.maps[paperIds[2]].generationMode, "paper-card-cache");
  assert.equal(journal.maps[paperIds[1]].generationMode, "paper-card-cache");
  assert.equal(journal.maps[paperIds[3]].generationMode, "paper-card-cache");
  assert.equal(journal.processingAccounting.canonicalArtifactsReused, 2);
  assert.equal(journal.processingAccounting.canonicalArtifactsCreated, 2);
  assertRouteCounts(counters, {
    paperCardConfig: 1,
    summarize: 2,
    paperCardSynthesize: 2,
  });
});

test("stale, missing, malformed, and content-mismatched Paper Cards are rebuilt", async () => {
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
    mapped.generationMode === "paper-card-cache"
  ));
  assert.equal(journal.processingAccounting.canonicalArtifactsCreated, 4);
  assertRouteCounts(counters, {
    paperCardConfig: 1,
    summarize: 4,
    paperCardSynthesize: 4,
  });
});

test("canonical cache invalidates on generation, native, combined-text, and parsing contract changes", async () => {
  const contract = {
    ...TEST_NATIVE_PAPER_CARD_CONTRACT,
  };
  const { counters, system, paperIds } = await createCorpusScenario(1, [], {
    paperCardContract: contract,
  });
  await system.corpusWorkflows.run("First corpus question.", { retrievalProfile: "high" });
  assertRouteCounts(counters, {
    paperCardConfig: 1,
    summarize: 1,
    paperCardSynthesize: 1,
  });

  const assertRebuilt = async (question) => {
    counters.reset();
    const result = await system.corpusWorkflows.run(question, { retrievalProfile: "high" });
    const journal = await resolveWorkflowResult(system, result);
    assert.equal(journal.processingAccounting.canonicalArtifactsCreated, 1);
    assert.equal(journal.processingAccounting.canonicalArtifactsReused, 0);
    assertRouteCounts(counters, {
      paperCardConfig: 1,
      summarize: 1,
      paperCardSynthesize: 1,
    });
  };

  contract.modelSignature = "e".repeat(64);
  await assertRebuilt("Question after model change.");
  contract.promptVersion = "canonical-paper-card-v3";
  await assertRebuilt("Question after prompt change.");
  contract.schemaVersion = 3;
  await assertRebuilt("Question after schema change.");
  contract.generationStrategy = "native-pdf-preferred-v2";
  await assertRebuilt("Question after generation strategy change.");
  contract.nativePdfPromptVersion = "canonical-paper-card-native-v2";
  await assertRebuilt("Question after native prompt change.");
  contract.nativePdfModelSignature = "f".repeat(64);
  await assertRebuilt("Question after native model change.");
  contract.nativePdfSchemaVersion = 2;
  await assertRebuilt("Question after native schema change.");
  contract.generationContractVersion = 3;
  await assertRebuilt("Question after generation contract change.");
  contract.combinedTextPromptVersion = "canonical-paper-card-combined-text-v2";
  await assertRebuilt("Question after combined-text prompt change.");
  contract.combinedTextModelSignature = "1".repeat(64);
  await assertRebuilt("Question after combined-text model change.");
  contract.combinedTextSchemaVersion = 2;
  await assertRebuilt("Question after combined-text schema change.");
  contract.combinedTextMaxCharacters = 100000;
  await assertRebuilt("Question after combined-text budget change.");

  const source = system.registry.get(paperIds[0]);
  source.artifacts.paperCard.sourceArtifactSchemaVersion = 0;
  await assertRebuilt("Question after parsing contract change.");
  source.artifacts.paperCard.extractorVersion = "older-local-parser";
  await assertRebuilt("Question after parser version change.");
});

test("an existing valid corpus map takes precedence over a newly available Paper Card", async () => {
  const { workspace, counters, system, paperIds } = await createCorpusScenario(1, [], {
    failPaperCards: true,
  });
  const question = "Compare all papers in the corpus";
  const first = await system.corpusWorkflows.run(question, {
    retrievalProfile: "high",
  });
  const firstJournal = first.resultHandle ? await system.results.read(first.resultHandle) : first;
  assert.equal(firstJournal.maps[paperIds[0]].generationMode, "structured-map");

  system.preparation.setPaperCardGenerator(paperCardGenerator(workspace, counters));
  await system.preparation.ensureSourceReady([paperIds[0]], "paper_card");
  counters.reset();
  const second = await system.corpusWorkflows.run(question, {
    retrievalProfile: "high",
  });
  const secondJournal = second.resultHandle ? await system.results.read(second.resultHandle) : second;

  assert.equal(secondJournal.maps[paperIds[0]].generationMode, "structured-map");
  assertRouteCounts(counters, { paperCardConfig: 1 });
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
    question: "Give me an overview of the figures and layout of this selected study.",
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
