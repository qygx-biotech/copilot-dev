"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  CorpusWorkflowService,
  KnowledgeLifecycleService,
  LiteratureTools,
  SourceJobManager,
  SourcePreparationService,
  SourceRegistry,
  SourceResultStore,
  TopicKnowledgeService,
  renderExperimentNoteMarkdown,
  renderPaperCardMarkdown,
  renderPaperEvidenceMarkdown,
  renderSynthesisMarkdown,
} = require("../../docs/source-system.js");
const { LocalQmdKnowledgeService } = require("../../docs/knowledge-service.js");

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

test("KnowledgeService exposes indexing and model-loading status events", async () => {
  const events = [];
  const service = new LocalQmdKnowledgeService({
    fetch: async (url) => {
      if (String(url).includes("/initialize")) {
        return new Response(JSON.stringify({ ok: true, status: { available: true } }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (String(url).includes("/update")) {
        await new Promise((resolve) => setTimeout(resolve, 420));
        return new Response(JSON.stringify({ ok: true, update: {}, embeddings: [] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (String(url).includes("/status")) {
        return new Response(JSON.stringify({
          ok: true,
          status: {
            available: true,
            embeddingProgress: { chunksEmbedded: 8, totalChunks: 32 },
          },
        }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response(JSON.stringify({ ok: true, results: [], diagnostics: {} }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    },
  });
  service.subscribe((event) => events.push(event));
  await service.initialize({ workspaceId: "workspace-test" });
  await service.indexDocuments("literature-evidence", { embed: true });
  await service.searchVector("提高 EctD 热稳定性", {
    collections: ["literature-evidence"],
  });
  assert.equal(events[0].stage, "initializing");
  assert.ok(events.some((event) =>
    event.stage === "embedding" && event.completed === 8 && event.total === 32
  ));
  assert.ok(events.some((event) => event.stage === "initializing-search-model"));
  assert.equal(events.at(-1).stage, "ready");
});

function makeFile(name, content, lastModified = Date.now() - 5000) {
  const file = new Blob([content]);
  Object.defineProperties(file, {
    name: { value: name },
    lastModified: { value: lastModified },
  });
  return file;
}

class LayerWorkspace {
  constructor() {
    this.files = new Map();
    this.json = new Map();
    this.writes = [];
    this.readFileCalls = 0;
    this.counter = 0;
    this.state = { schemaVersion: 1, project: {}, agent: {}, memory: {}, ui: {} };
  }

  createId() {
    this.counter += 1;
    return `layer-${String(this.counter).padStart(4, "0")}`;
  }

  setFile(path, content, lastModified = Date.now() - 5000) {
    this.files.set(path, makeFile(path.split("/").at(-1), content, lastModified));
  }

  async fileExists(path) {
    return this.files.has(path) || this.json.has(path);
  }

  async readFile(path) {
    this.readFileCalls += 1;
    const file = this.files.get(path);
    if (!file) throw new Error(`Missing file: ${path}`);
    return file;
  }

  async writeFile(path, data) {
    this.writes.push(path);
    const file = makeFile(path.split("/").at(-1), String(data));
    this.files.set(path, file);
    return file;
  }

  async removeFile(path) {
    this.files.delete(path);
    this.json.delete(path);
  }

  async readJson(path) {
    if (!this.json.has(path)) throw new Error(`Missing JSON: ${path}`);
    return clone(this.json.get(path));
  }

  async writeJson(path, value) {
    this.json.set(path, clone(value));
    return value;
  }

  async saveState(value) {
    this.state = clone(value);
    return this.state;
  }
}

function rawTree(workspace, paths = [...workspace.files.keys()].filter((path) =>
  path.startsWith("literature/") || path.startsWith("experiments/")
)) {
  return {
    name: "workspace",
    relativePath: "",
    type: "directory",
    children: paths.map((path) => {
      const file = workspace.files.get(path);
      return {
        name: path.split("/").at(-1),
        relativePath: path,
        type: "file",
        size: file.size,
        lastModified: file.lastModified,
        children: [],
      };
    }),
  };
}

function validMap(input) {
  return {
    relevance: "high",
    themes: ["enzyme engineering"],
    findings: input.evidence.slice(0, 1).map((item) => ({
      claim: item.claimCandidate,
      evidenceRefs: [item.evidenceRef],
    })),
    methods: ["enzyme assay"],
    organisms: ["Halomonas elongata"],
    genes: ["ectD"],
    proteins: ["EctD"],
    pathways: ["hydroxyectoine biosynthesis"],
    experimentalStrategies: ["protein engineering"],
    limitations: [],
    connectionsToOtherTopics: [],
  };
}

test("Layer 1-4 Markdown renderers preserve provenance and authority boundaries", () => {
  const source = {
    sourceId: "paper-017",
    sourceKind: "paper",
    path: "literature/ectd.pdf",
    displayName: "ectd.pdf",
    contentHash: "sha256:abc123",
    legacy: {
      discovery: {
        title: "EctD thermostability",
        authors: ["A. Researcher"],
        year: 2025,
        identifiers: ["10.1000/ectd"],
      },
    },
  };
  const evidence = renderPaperEvidenceMarkdown(source, {
    metadataTitle: "EctD thermostability",
    pageCount: 2,
    extractorVersion: "local-source-v1",
    pages: [
      { page: 1, text: "Introduction and assay design." },
      { page: 2, text: "A163V increased thermal stability." },
    ],
  });
  assert.match(evidence, /source_id: "paper-017"/);
  assert.match(evidence, /content_hash: "sha256:abc123"/);
  assert.match(evidence, /## Page 2\n\nA163V increased thermal stability/);
  assert.match(evidence, /original source file remains authoritative/i);

  const card = renderPaperCardMarkdown(source, {
    title: "EctD thermostability",
    topics: ["enzyme engineering"],
    proteins: ["EctD"],
    researchQuestion: "Which variants are more stable?",
    mainFindings: ["A163V was prioritized."],
    evidenceRefs: ["paper-017:p2:paper-017-P2-C1"],
  });
  assert.match(card, /# Research Question/);
  assert.match(card, /# Evidence Links/);
  assert.doesNotMatch(card, /Introduction and assay design/);

  const experiment = renderExperimentNoteMarkdown(
    { ...source, sourceId: "experiment-004", path: "experiments/run.csv", displayName: "run.csv" },
    {
      sheets: [{ name: "data", rows: [["strain", "titer_g_l"], ["A163V", 42.5]] }],
      records: [{ experimentId: "experiment-004:1", entities: { mutations: ["A163V"] } }],
    }
  );
  assert.match(experiment, /titer_g_l/);
  assert.match(experiment, /structured experiment records/);
  assert.doesNotMatch(experiment, /42\.5/);

  const synthesis = renderSynthesisMarkdown({
    workflowId: "synthesis-001",
    question: "What improves EctD stability?",
    corpusVersion: "corpus-v1",
    parentWorkflowId: null,
    coverage: {
      papersIncludedInSnapshot: 2,
      papersSuccessfullyPrepared: 2,
      papersSuccessfullyAnalyzed: 2,
      papersFailed: 0,
      papersMissing: 0,
      analyzedPaperIds: ["paper-017", "paper-018"],
    },
    reduction: {
      themes: [{ theme: "enzyme engineering", paperIds: ["paper-017"] }],
      findings: [{
        claim: "A163V improves stability.",
        supportingPaperIds: ["paper-017"],
        evidenceRefs: ["paper-017:p2:paper-017-P2-C1"],
      }],
    },
    verification: [{ status: "original-evidence-located" }],
  });
  assert.match(synthesis, /parent_synthesis_id: null/);
  assert.match(synthesis, /paper-017:p2:paper-017-P2-C1/);
  assert.match(synthesis, /# Source Coverage/);
});

test("first evidence use lazily writes Layer 1 Markdown and updates QMD", async () => {
  const workspace = new LayerWorkspace();
  workspace.setFile("literature/ectd.pdf", "%PDF EctD A163V thermal stability");
  const registry = new SourceRegistry({ workspace });
  await registry.reconcile(rawTree(workspace));
  assert.equal(
    [...workspace.files.keys()].some((path) => path.startsWith(".biodesign/knowledge/")),
    false
  );

  const indexed = [];
  const knowledgeService = {
    available: true,
    async indexDocuments(collection, options) {
      indexed.push({ collection, options });
      return { indexed: 1 };
    },
  };
  const jobs = new SourceJobManager({ workspace });
  const preparation = new SourcePreparationService({
    workspace,
    registry,
    jobs,
    results: new SourceResultStore({ workspace }),
    knowledgeService,
    cryptoProvider: {},
    debounceMilliseconds: 1,
    async parsePaper() {
      return {
        text: "# Page 1\nEctD catalyzes hydroxyectoine formation.\n# Page 2\nA163V improves thermal stability.",
        pageCount: 2,
        metadataTitle: "EctD stability",
      };
    },
  });
  const source = registry.list({ sourceKind: "paper" })[0];
  await preparation.ensureSourceReady([source.sourceId], "search", { surface: "side_chat" });
  const mirrorPath = `.biodesign/knowledge/literature/${source.sourceId}.md`;
  assert.equal(await workspace.fileExists(mirrorPath), true);
  assert.match(await (await workspace.readFile(mirrorPath)).text(), /## Page 2/);
  assert.deepEqual(indexed.map((entry) => entry.collection), ["literature-evidence"]);
  assert.equal(registry.get(source.sourceId).qmdLexStatus, "ready");
});

test("a lazy Paper Card keeps canonical JSON and indexes a separate Layer 2 mirror", async () => {
  const workspace = new LayerWorkspace();
  workspace.setFile("literature/card.pdf", "%PDF EctD enzyme engineering");
  const registry = new SourceRegistry({ workspace });
  await registry.reconcile(rawTree(workspace));
  const indexed = [];
  const knowledgeService = {
    available: true,
    async indexDocuments(collection) { indexed.push(collection); },
  };
  const topics = new TopicKnowledgeService({ workspace, knowledgeService });
  const preparation = new SourcePreparationService({
    workspace,
    registry,
    jobs: new SourceJobManager({ workspace }),
    results: new SourceResultStore({ workspace }),
    knowledgeService,
    topicService: topics,
    cryptoProvider: {},
    debounceMilliseconds: 1,
    async parsePaper() {
      return { text: "# Page 1\nEctD A163V enzyme engineering evidence.", pageCount: 1 };
    },
    async generatePaperCard({ source, contentHash }) {
      const path = `.biodesign/literature/summaries/${source.sourceId}.json`;
      const card = {
        paperCardVersion: 2,
        title: "EctD engineering",
        researchQuestion: "Which variant is more stable?",
        mainFindings: ["A163V improved stability."],
        proteins: ["EctD"],
        genes: ["ectD"],
        topics: ["enzyme engineering", "thermostability"],
        evidenceRefs: [`${source.sourceId}:p1:${source.sourceId}-P1-C1`],
        contentHash,
        model: "test-model",
      };
      await workspace.writeJson(path, card);
      return { card, path, schemaVersion: 2, model: "test-model", promptVersion: 3 };
    },
  });
  const source = registry.list({ sourceKind: "paper" })[0];
  assert.equal(source.paperCardStatus, "absent");
  await preparation.ensureSourceReady([source.sourceId], "paper_card", { surface: "side_chat" });
  assert.equal(await workspace.fileExists(source.artifacts.paperCard.path), true);
  assert.match(source.artifacts.paperCard.cacheKey, /test-model/);
  assert.ok(source.artifacts.paperCard.cacheKey.includes(source.contentHash));
  assert.equal(
    await workspace.fileExists(`.biodesign/knowledge/paper_cards/${source.sourceId}.md`),
    true
  );
  assert.ok(indexed.includes("paper-cards"));
  assert.ok(indexed.includes("topics"));
});

test("experiment normalization keeps numbers structured and indexes only a descriptor", async () => {
  const workspace = new LayerWorkspace();
  workspace.setFile(
    "experiments/strain-engineering/run.csv",
    "experiment_id,protein,mutation,titer_g_l\nEXP-1,EctD,A163V,42.5\n"
  );
  const registry = new SourceRegistry({ workspace });
  await registry.reconcile(rawTree(workspace));
  const indexed = [];
  const preparation = new SourcePreparationService({
    workspace,
    registry,
    jobs: new SourceJobManager({ workspace }),
    results: new SourceResultStore({ workspace }),
    knowledgeService: {
      available: true,
      async indexDocuments(collection) { indexed.push(collection); },
    },
    cryptoProvider: {},
    debounceMilliseconds: 1,
  });
  const source = registry.list({ sourceKind: "experiment" })[0];
  assert.equal(source.structuredDataStatus, "not_started");
  await preparation.ensureSourceReady([source.sourceId], "experiment_data", { surface: "side_chat" });
  const artifact = await preparation.readExperimentArtifact(source.sourceId);
  assert.equal(Number(artifact.records[0].raw.titer_g_l), 42.5);
  const notePath = `.biodesign/knowledge/experiment_notes/${source.sourceId}.md`;
  const note = await (await workspace.readFile(notePath)).text();
  assert.match(note, /titer_g_l/);
  assert.doesNotMatch(note, /42\.5/);
  assert.deepEqual(indexed, ["experiment-notes"]);
});

test("a completed corpus review writes and indexes a provenance-bearing Layer 4 artifact", async () => {
  const workspace = new LayerWorkspace();
  workspace.setFile("literature/review.pdf", "%PDF EctD A163V improved thermal stability");
  const registry = new SourceRegistry({ workspace });
  await registry.reconcile(rawTree(workspace));
  const indexed = [];
  const knowledgeService = {
    available: true,
    async indexDocuments(collection) { indexed.push(collection); },
  };
  const results = new SourceResultStore({ workspace, maxInlineCharacters: 100000 });
  const preparation = new SourcePreparationService({
    workspace,
    registry,
    jobs: new SourceJobManager({ workspace }),
    results,
    knowledgeService,
    cryptoProvider: {},
    debounceMilliseconds: 1,
    async parsePaper() {
      return { text: "# Page 1\nEctD A163V improved thermal stability.", pageCount: 1 };
    },
  });
  const literatureTools = new LiteratureTools({ registry, preparation, results, knowledgeService });
  const workflows = new CorpusWorkflowService({
    workspace,
    registry,
    preparation,
    literatureTools,
    results,
    knowledgeService,
    mapWorker: async (input) => validMap(input),
  });
  const result = await workflows.run("What improves EctD stability?", { surface: "side_chat" });
  const synthesisPath = result.synthesisArtifact.path;
  assert.equal(await workspace.fileExists(synthesisPath), true);
  const synthesis = await (await workspace.readFile(synthesisPath)).text();
  assert.match(synthesis, /# Source Coverage/);
  assert.match(synthesis, new RegExp(registry.list({ sourceKind: "paper" })[0].sourceId));
  assert.ok(indexed.includes("syntheses"));

  const paperId = registry.list({ sourceKind: "paper" })[0].sourceId;
  await workflows.invalidateForSources([paperId], "source_registry_changed");
  const journal = await workspace.readJson(`.biodesign/workflows/${result.workflowId}.json`);
  assert.equal(journal.status, "stale");
  assert.deepEqual(journal.staleSourceIds, [paperId]);
  assert.equal(await workspace.fileExists(synthesisPath), true);
  assert.match(await (await workspace.readFile(synthesisPath)).text(), /synthesis_status: "stale"/);
});

test("topic memberships are multi-label and empty leaf files are removed", async () => {
  const workspace = new LayerWorkspace();
  const indexed = [];
  const topics = new TopicKnowledgeService({
    workspace,
    knowledgeService: {
      available: true,
      async indexDocuments(collection) { indexed.push(collection); },
    },
  });
  const source = { sourceId: "paper-017" };
  await topics.updatePaper(source, {
    topics: ["enzyme engineering", "fermentation temperature"],
    proteins: ["EctD"],
    organisms: ["Halomonas elongata"],
  });
  const index = await workspace.readJson(".biodesign/knowledge/topics/index.json");
  const memberships = index.topics.filter((topic) => topic.paperIds.includes("paper-017"));
  assert.ok(memberships.length >= 4);
  assert.ok(memberships.some((topic) => topic.topicId === "strain-engineering"));
  assert.ok(memberships.some((topic) => topic.topicId === "fermentation"));
  assert.equal(await workspace.fileExists(".biodesign/knowledge/topics/ectd.md"), true);

  await topics.removePaper("paper-017");
  assert.equal(await workspace.fileExists(".biodesign/knowledge/topics/ectd.md"), false);
  assert.equal(await workspace.fileExists(".biodesign/knowledge/topics/strain-engineering.md"), true);
  assert.ok(indexed.every((collection) => collection === "topics"));
});

test("QMD routes a 150-paper top-k query without opening every legacy artifact", async () => {
  const workspace = new LayerWorkspace();
  for (let index = 1; index <= 150; index += 1) {
    workspace.setFile(
      `literature/paper-${String(index).padStart(3, "0")}.pdf`,
      `paper ${index}`
    );
  }
  const registry = new SourceRegistry({ workspace });
  await registry.reconcile(rawTree(workspace));
  const target = registry.list({ sourceKind: "paper" })[149];
  for (const source of registry.list({ sourceKind: "paper" })) {
    source.indexStatus = "ready";
    source.parseStatus = "ready";
    source.hashStatus = "ready";
    source.contentHash = `sha256:${source.sourceId}`;
    source.legacy ||= {};
    source.legacy.discovery ||= {};
    source.legacy.discovery.title = source.sourceId === target.sourceId
      ? "EctD A163V stability"
      : `Unrelated paper ${source.sourceId}`;
  }
  await registry.persist();

  let legacyReads = 0;
  const tools = new LiteratureTools({
    registry,
    results: new SourceResultStore({ workspace }),
    preparation: {
      async readPaperArtifact() {
        legacyReads += 1;
        throw new Error("full legacy scan should not run after QMD routes the query");
      },
    },
    knowledgeService: {
      available: true,
      async searchLiterature(input) {
        assert.equal(input.limit, 5);
        return {
          results: [{
            paperId: target.sourceId,
            title: "EctD A163V stability",
            score: 0.97,
            matchedSections: [{
              qmdDoc: `qmd://literature-evidence/${target.sourceId}.md`,
              snippet: "Page 2 A163V improves thermal stability",
              score: 0.97,
            }],
          }],
        };
      },
    },
  });
  const result = await tools.searchPapers("EctD A163V stability", {
    surface: "side_chat",
    topK: 5,
  });
  assert.equal(result.results[0].paperId, target.sourceId);
  assert.equal(result.results[0].retrievalBackend, "qmd");
  assert.equal(legacyReads, 0);
  assert.equal(result.coverage.papersDiscovered, 150);
});

test("deleting a paper removes derived mirrors and refreshes affected collections", async () => {
  const workspace = new LayerWorkspace();
  const sourceId = "paper-017";
  await workspace.writeFile(`.biodesign/knowledge/literature/${sourceId}.md`, "evidence");
  await workspace.writeFile(`.biodesign/knowledge/paper_cards/${sourceId}.md`, "card");
  const topics = new TopicKnowledgeService({ workspace });
  await topics.updatePaper({ sourceId }, { topics: ["enzyme engineering"] });
  const updated = [];
  const lifecycle = new KnowledgeLifecycleService({
    workspace,
    topics,
    knowledgeService: {
      available: true,
      async indexDocuments(collection) { updated.push(collection); },
    },
  });
  await lifecycle.removePaperEvidenceArtifact(sourceId);
  await lifecycle.removePaperCardArtifact(sourceId);
  assert.equal(await workspace.fileExists(`.biodesign/knowledge/literature/${sourceId}.md`), false);
  assert.equal(await workspace.fileExists(`.biodesign/knowledge/paper_cards/${sourceId}.md`), false);
  assert.equal(await workspace.fileExists(".biodesign/knowledge/topics/enzyme-engineering.md"), false);
  assert.deepEqual(updated, ["literature-evidence", "paper-cards"]);
});
