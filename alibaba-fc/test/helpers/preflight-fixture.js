"use strict";
const { webcrypto } = require("node:crypto");
const sourceApi = require("../../../docs/source-system.js");
const { LiteratureModule } = require("../../../docs/literature-module.js");
const { AgentRequestPipeline } = require("../../../docs/request-pipeline.js");
const clone = (x) => JSON.parse(JSON.stringify(x));
class SyncWorkspace {
  constructor() {
    this.files = new Map(); this.counter = 0; this.rawReads = 0; this.scans = 0; this.writes = [];
    this.workspace = { workspaceId: "sync-test", name: "Sync fixture" };
    this.state = { schemaVersion: 1, project: {}, ui: {}, agent: { currentRecommendation: { id: "R1" }, sideChat: {} }, memory: {} };
    this.set(".biodesign/literature/index.json", JSON.stringify({ schemaVersion: 1, documents: [] }));
  }
  createId() { return `sync-${++this.counter}`; }
  set(path, text, mtime = Date.now() - 5000) {
    const file = new Blob([text]);
    Object.defineProperties(file, { name: { value: path.split("/").at(-1) }, lastModified: { value: mtime } });
    this.files.set(path, file); return file;
  }
  async fileExists(path) { return this.files.has(path); }
  async readFile(path) { if (!path.startsWith(".biodesign/")) this.rawReads++; const file = this.files.get(path); if (!file) throw new Error(`Missing ${path}`); return file; }
  async readJson(path) { return JSON.parse(await (await this.readFile(path)).text()); }
  async writeJson(path, value) { this.writes.push(path); this.set(path, JSON.stringify(value)); }
  async writeFile(path, value) { this.writes.push(path); this.set(path, value); }
  async removeFile(path) { this.files.delete(path); }
  async ensureDirectory() {}
  async saveState(state) { this.state = clone(state); }
  async scanDirectoryTree() {
    this.scans++;
    return { type: "directory", relativePath: "", children: [...this.files].filter(([path]) => !path.startsWith(".biodesign/")).map(([relativePath, file]) => ({ type: "file", name: file.name, relativePath, size: file.size, lastModified: file.lastModified })) };
  }
}
async function createFixture(options = {}) {
  const workspace = options.workspace || new SyncWorkspace();
  const indexed = new Map(), events = [], calls = { cards: 0, parses: 0, indexing: 0, activeCards: 0, peakCards: 0 };
  const directories = { "literature-evidence": "literature", "paper-cards": "paper_cards", topics: "topics", syntheses: "syntheses", "experiment-notes": "experiment_notes", "project-memory": "memory" };
  const knowledgeService = {
    available: true,
    async status() { return { available: true }; },
    async indexDocuments(collection) {
      calls.indexing++;
      if (options.indexFailure?.(collection)) throw Object.assign(new Error("Index failure"), { code: "QMD_TEST_FAILURE" });
      indexed.set(collection, [...workspace.files.keys()].filter((path) => path.startsWith(`.biodesign/knowledge/${directories[collection]}/`) && path.endsWith(".md")));
      return {};
    },
    async searchLiterature() { return { results: [] }; },
    async searchTopics() { return { results: [] }; },
    async searchProjectMemory() { return { results: [] }; },
    async searchExperimentSources() { return { results: [] }; },
    async searchPreviousSyntheses() { return { results: [] }; },
  };
  const system = sourceApi.createSourceSystem({ workspace, knowledgeService, cryptoProvider: webcrypto,
    spreadsheetProvider: require("xlsx"), debounceMilliseconds: 1,
    async parsePaper({ source, bytes }) {
      calls.parses++; events.push(`${source.sourceId}:L1`);
      if (options.parseFailure?.(source)) throw Object.assign(new Error("Malformed fixture"), { code: "MALFORMED_PDF" });
      return { text: `# Page 1\n${new TextDecoder().decode(bytes)}`, pageCount: 1 };
    },
    async generatePaperCard({ source, contentHash }) {
      calls.cards++; calls.activeCards++; calls.peakCards = Math.max(calls.activeCards, calls.peakCards);
      try {
        if (options.cardBarrier) await options.cardBarrier(source);
        if (options.cardFailure?.(source)) throw Object.assign(new Error("Card failure"), { code: "CARD_TEST_FAILURE" });
        events.push(`${source.sourceId}:L2`);
        const descriptor = { sourceId: source.sourceId, contentHash, schemaVersion: 2, modelSignature: "fixture-model", promptVersion: "fixture-v1", sourceArtifactSchemaVersion: 1, extractorVersion: "local-source-v1" };
        const card = { schemaVersion: 2, paperCardVersion: 2, paperId: source.sourceId, documentId: source.sourceId,
          fileName: source.displayName, generatedAt: new Date().toISOString(), source: { filename: source.displayName, relativePath: source.path, hash: contentHash, artifactSchemaVersion: 1, extractorVersion: "local-source-v1" },
          model: "fixture-model", modelSignature: descriptor.modelSignature, promptVersion: descriptor.promptVersion, cacheKey: sourceApi.paperCardCacheKey(descriptor),
          title: source.displayName, authors: [], year: null, abstractSummary: "", researchQuestion: "How does EctD work?",
          mainFindings: ["A163V improved stability."], methods: ["enzyme engineering"], methodsSummary: "", organisms: [], proteins: ["EctD"], genes: [], pathways: [], metabolites: [], experimentalConditions: [], measurements: [], importantResults: [], limitations: [], keywords: [], topics: ["enzyme engineering", "thermostability"], shortSummary: "A163V improved stability.", summary: "A163V improved stability.", keyResults: [], mainConclusion: "A163V improved stability.", evidenceFindings: [] };
        const path = `.biodesign/literature/summaries/${source.sourceId}.json`;
        await workspace.writeJson(path, card);
        return { ...descriptor, path, card };
      } finally { calls.activeCards--; }
    },
  });
  const literature = new LiteratureModule({ workspace, sourceSystem: system, api: {}, knowledgeService });
  // The real module normally creates its source system internally; inject this
  // fixture's extraction/provider adapters while keeping its actual catalog logic.
  literature.sourceSystem = system; literature.sourceRegistry = system.registry; literature.preparation = system.preparation;
  const pipeline = new AgentRequestPipeline({ workspace, literature, sourceSystem: system });
  return { workspace, system, literature, pipeline, calls, indexed, events };
}
module.exports = { SyncWorkspace, createFixture };
