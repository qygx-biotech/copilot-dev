import { mkdir, readFile, realpath, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import retrievalContract from "../../shared/retrieval-contract.js";

const { RETRIEVAL_LIMITS } = retrievalContract;

export const QMD_PACKAGE_VERSION = "2.8.3";
export const DEFAULT_EMBED_MODEL =
  "hf:ggml-org/embeddinggemma-300M-GGUF/embeddinggemma-300M-Q8_0.gguf";
export const MULTILINGUAL_EMBED_MODEL =
  "hf:Qwen/Qwen3-Embedding-0.6B-GGUF/Qwen3-Embedding-0.6B-Q8_0.gguf";

export const KNOWLEDGE_COLLECTIONS = Object.freeze({
  "literature-evidence": "literature",
  "paper-cards": "paper_cards",
  topics: "topics",
  syntheses: "syntheses",
  "experiment-notes": "experiment_notes",
  "project-memory": "memory",
});

const METADATA_SCHEMA_VERSION = 1;

let qmdSdkPromise = null;

async function loadQmdSdk() {
  qmdSdkPromise ||= import("@tobilu/qmd");
  return qmdSdkPromise;
}

function normalizeCollectionNames(value) {
  const requested = Array.isArray(value) ? value : value ? [value] : [];
  const names = [...new Set(requested.map(String))];
  for (const name of names) {
    if (!Object.hasOwn(KNOWLEDGE_COLLECTIONS, name)) {
      const error = new Error(`Unknown QMD collection: ${name}`);
      error.code = "QMD_COLLECTION_NOT_ALLOWED";
      throw error;
    }
  }
  return names;
}

function pathInside(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function frontmatterValue(text, key) {
  const match = String(text || "").match(
    new RegExp(`^${key.replace(/[.*+?^${}()|[\\]\\]/g, "\\$&")}:\\s*[\"']?([^\\n\"']+)`, "m")
  );
  return match ? match[1].trim() : null;
}

function sourceIdFromResult(result) {
  const text = [result?.snippet, result?.bestChunk, result?.body, result?.text, result?.context]
    .filter(Boolean)
    .join("\n");
  const frontmatterId =
    frontmatterValue(text, "source_id") ||
    frontmatterValue(text, "paper_id") ||
    frontmatterValue(text, "experiment_source_id");
  if (frontmatterId) return frontmatterId;
  const file = String(
    result?.file || result?.filepath || result?.displayPath || result?.path || result?.uri || ""
  )
    .replace(/^qmd:\/\/[^/]+\//, "");
  const basename = path.posix.basename(file).replace(/\.md$/i, "");
  return basename && !["index", "."].includes(basename) ? basename : null;
}

function resultSnippet(result, query = "") {
  if (result?.snippet || result?.bestChunk || result?.text) {
    return String(result.snippet || result.bestChunk || result.text).slice(
      0,
      RETRIEVAL_LIMITS.snippetCharacters
    );
  }
  if (result?.body && query) {
    const body = String(result.body);
    const firstTerm = String(query).toLowerCase().match(/[\p{L}\p{N}_.+-]+/u)?.[0] || "";
    const matchAt = firstTerm ? body.toLowerCase().indexOf(firstTerm) : -1;
    const start = Math.max(0, matchAt < 0 ? Number(result.chunkPos) || 0 : matchAt - 240);
    return body.slice(start, start + 900);
  }
  return String(result?.body || result?.context || "").slice(
    0,
    RETRIEVAL_LIMITS.snippetCharacters
  );
}

function normalizeSearchResult(result, collectionHint = null, query = "") {
  const file = String(
    result?.file || result?.filepath || result?.displayPath || result?.path || result?.uri || ""
  );
  const collection =
    result?.collection ||
    (file.match(/^qmd:\/\/([^/]+)/)?.[1] ||
      result?.displayPath?.split("/")?.[0] ||
      collectionHint ||
      null);
  return {
    sourceId: sourceIdFromResult(result),
    collection,
    title: String(result?.title || ""),
    score: Number(result?.score ?? result?.similarity ?? result?.rank ?? 0) || 0,
    snippet: resultSnippet(result, query),
    file,
    docid: result?.docid || result?.id || null,
  };
}

export function groupPaperResults(results, options = {}) {
  const allowed = Array.isArray(options.paperIds) && options.paperIds.length
    ? new Set(options.paperIds.map(String))
    : null;
  const groups = new Map();
  for (const item of results.map((result) => normalizeSearchResult(result, null, options.query))) {
    if (!item.sourceId || (allowed && !allowed.has(item.sourceId))) continue;
    const group = groups.get(item.sourceId) || {
      paperId: item.sourceId,
      title: item.title || item.sourceId,
      score: 0,
      matchedSections: [],
      collections: [],
    };
    group.matchedSections.push({
      collection: item.collection,
      snippet: item.snippet,
      qmdDoc: item.file || item.docid,
      score: item.score,
    });
    group.collections.push(item.collection);
    groups.set(item.sourceId, group);
  }
  for (const group of groups.values()) {
    group.matchedSections.sort((left, right) => right.score - left.score);
    const scores = group.matchedSections.map((item) => item.score);
    group.score = (scores[0] || 0) + (scores[1] || 0) * 0.1;
    group.matchedSections = group.matchedSections.slice(
      0,
      RETRIEVAL_LIMITS.matchedSectionsPerPaper
    );
    group.collections = [...new Set(group.collections.filter(Boolean))];
  }
  return [...groups.values()]
    .sort((left, right) => right.score - left.score || left.paperId.localeCompare(right.paperId))
    .slice(0, Math.max(1, Number(options.limit) || RETRIEVAL_LIMITS.resultDefault));
}

export class ProjectQmdManager {
  constructor(options) {
    this.projectRootInput = path.resolve(String(options.projectRoot || ""));
    this.embedModel = String(options.embedModel || DEFAULT_EMBED_MODEL);
    this.createStore = options.createStore || null;
    this.now = options.now || (() => new Date());
    this.projectRoot = null;
    this.knowledgeRoot = null;
    this.dbPath = null;
    this.metadataPath = null;
    this.store = null;
    this.initializationPromise = null;
    this.workspaceId = null;
    this.maintenanceTail = Promise.resolve();
    this.pendingMaintenance = 0;
    this.lastUpdate = null;
    this.lastEmbed = null;
    this.embeddingProgress = null;
    this.lastSearch = null;
    this.requiresVectorRebuild = false;
    this.initializationError = null;
  }

  async resolveProjectRoot() {
    if (this.projectRoot) return this.projectRoot;
    const info = await stat(this.projectRootInput);
    if (!info.isDirectory()) throw new Error("The configured project root is not a directory.");
    this.projectRoot = await realpath(this.projectRootInput);
    return this.projectRoot;
  }

  async readWorkspaceMetadata() {
    const projectRoot = await this.resolveProjectRoot();
    const metadataPath = path.join(projectRoot, ".biodesign", "workspace.json");
    let metadata;
    try {
      metadata = JSON.parse(await readFile(metadataPath, "utf8"));
    } catch (error) {
      const wrapped = new Error(
        "The selected folder is not an initialized BioDesign workspace yet. Initialize it in the browser first."
      );
      wrapped.code = "WORKSPACE_NOT_INITIALIZED";
      wrapped.cause = error;
      throw wrapped;
    }
    if (!metadata?.workspaceId || typeof metadata.workspaceId !== "string") {
      const error = new Error("The BioDesign workspace metadata is invalid.");
      error.code = "INVALID_WORKSPACE";
      throw error;
    }
    return metadata;
  }

  async assertWorkspaceId(requestedWorkspaceId) {
    const metadata = await this.readWorkspaceMetadata();
    if (requestedWorkspaceId && requestedWorkspaceId !== metadata.workspaceId) {
      const error = new Error(
        "The browser workspace does not match the project configured for the local QMD backend."
      );
      error.code = "WORKSPACE_MISMATCH";
      throw error;
    }
    this.workspaceId = metadata.workspaceId;
    return metadata;
  }

  collectionConfig() {
    const collections = {};
    for (const [name, directory] of Object.entries(KNOWLEDGE_COLLECTIONS)) {
      const collectionPath = path.join(this.knowledgeRoot, directory);
      if (!pathInside(this.projectRoot, collectionPath)) {
        throw new Error(`Collection escaped the project sandbox: ${name}`);
      }
      collections[name] = {
        path: collectionPath,
        pattern: "**/*.md",
      };
    }
    return {
      models: { embed: this.embedModel },
      collections,
    };
  }

  async readMetadata() {
    try {
      return JSON.parse(await readFile(this.metadataPath, "utf8"));
    } catch {
      return null;
    }
  }

  async writeMetadata(patch = {}) {
    const current = (await this.readMetadata()) || {};
    const metadata = {
      ...current,
      schemaVersion: METADATA_SCHEMA_VERSION,
      qmdPackageVersion: QMD_PACKAGE_VERSION,
      embeddingModelId: this.embedModel,
      embeddingModelVersion: this.embedModel.split("/").at(-1),
      dbPath: path.relative(this.projectRoot, this.dbPath),
      collections: Object.keys(KNOWLEDGE_COLLECTIONS),
      ...patch,
      updatedAt: this.now().toISOString(),
    };
    await writeFile(this.metadataPath, `${JSON.stringify(metadata, null, 2)}\n`, "utf8");
    return metadata;
  }

  async initialize(options = {}) {
    await this.assertWorkspaceId(options.workspaceId);
    if (this.store) return this.status();
    if (this.initializationPromise) return this.initializationPromise;
    this.initializationPromise = (async () => {
      try {
      const projectRoot = await this.resolveProjectRoot();
      this.knowledgeRoot = path.join(projectRoot, ".biodesign", "knowledge");
      this.dbPath = path.join(this.knowledgeRoot, "qmd", "index.sqlite");
      this.metadataPath = path.join(this.knowledgeRoot, "qmd", "metadata.json");
      if (!pathInside(projectRoot, this.dbPath)) {
        throw new Error("QMD database path escaped the project sandbox.");
      }
      await Promise.all([
        mkdir(path.dirname(this.dbPath), { recursive: true }),
        ...Object.values(KNOWLEDGE_COLLECTIONS).map((directory) =>
          mkdir(path.join(this.knowledgeRoot, directory), { recursive: true })
        ),
      ]);
      const previousMetadata = await this.readMetadata();
      const embeddingModelChanged = Boolean(
        previousMetadata?.embeddingModelId &&
        previousMetadata.embeddingModelId !== this.embedModel
      );
      this.requiresVectorRebuild = Boolean(
        embeddingModelChanged ||
        ["model_changed", "partial_failure", "rebuild_required"].includes(
          previousMetadata?.vectorState
        )
      );
      const createStore = this.createStore || (await loadQmdSdk()).createStore;
      this.store = await createStore({
        dbPath: this.dbPath,
        config: this.collectionConfig(),
      });
      await this.writeMetadata({
        vectorState: embeddingModelChanged
          ? "model_changed"
          : this.requiresVectorRebuild
            ? previousMetadata?.vectorState || "rebuild_required"
            : "compatible",
      });
      this.initializationError = null;
      return this.status();
      } catch (error) {
        this.initializationError = error;
        throw error;
      }
    })();
    try {
      return await this.initializationPromise;
    } finally {
      this.initializationPromise = null;
    }
  }

  enqueueMaintenance(task) {
    this.pendingMaintenance += 1;
    const run = this.maintenanceTail.then(task, task);
    this.maintenanceTail = run
      .catch(() => {})
      .finally(() => {
        this.pendingMaintenance = Math.max(0, this.pendingMaintenance - 1);
      });
    return run;
  }

  async update(options = {}) {
    const collections = normalizeCollectionNames(options.collections);
    const selected = collections.length ? collections : Object.keys(KNOWLEDGE_COLLECTIONS);
    return this.enqueueMaintenance(async () => {
      await this.initialize(options);
      const started = Date.now();
      const result = await this.store.update({ collections: selected });
      this.lastUpdate = {
        at: this.now().toISOString(),
        durationMs: Date.now() - started,
        collections: selected,
        result,
      };
      await this.writeMetadata({ lastUpdate: this.lastUpdate });
      return result;
    });
  }

  async embed(options = {}) {
    const collections = normalizeCollectionNames(options.collections);
    const selected = collections.length ? collections : Object.keys(KNOWLEDGE_COLLECTIONS);
    return this.enqueueMaintenance(async () => {
      await this.initialize(options);
      try {
      const started = Date.now();
      const results = [];
      for (let collectionIndex = 0; collectionIndex < selected.length; collectionIndex += 1) {
        const collection = selected[collectionIndex];
        this.embeddingProgress = {
          collection,
          collectionIndex: collectionIndex + 1,
          collectionCount: selected.length,
          chunksEmbedded: 0,
          totalChunks: 0,
          errors: 0,
          updatedAt: this.now().toISOString(),
        };
        results.push({
          collection,
          result: await this.store.embed({
            collection,
            force: options.force === true || this.requiresVectorRebuild,
            model: this.embedModel,
            maxDocsPerBatch: Math.min(100, Math.max(1, Number(options.maxDocsPerBatch) || 32)),
            maxBatchBytes: Math.min(
              128 * 1024 * 1024,
              Math.max(1024 * 1024, Number(options.maxBatchBytes) || 32 * 1024 * 1024)
            ),
            onProgress: (progress) => {
              this.embeddingProgress = {
                collection,
                collectionIndex: collectionIndex + 1,
                collectionCount: selected.length,
                chunksEmbedded: Math.max(0, Number(progress?.chunksEmbedded) || 0),
                totalChunks: Math.max(0, Number(progress?.totalChunks) || 0),
                bytesProcessed: Math.max(0, Number(progress?.bytesProcessed) || 0),
                totalBytes: Math.max(0, Number(progress?.totalBytes) || 0),
                errors: Math.max(0, Number(progress?.errors) || 0),
                updatedAt: this.now().toISOString(),
              };
              options.onProgress?.(this.embeddingProgress);
            },
          }),
        });
      }
      const errorCount = results.reduce(
        (total, item) => total + Math.max(0, Number(item.result?.errors) || 0),
        0
      );
      const rebuildingAllCollections =
        selected.length === Object.keys(KNOWLEDGE_COLLECTIONS).length &&
        Object.keys(KNOWLEDGE_COLLECTIONS).every((collection) => selected.includes(collection));
      this.requiresVectorRebuild = Boolean(
        errorCount > 0 || (this.requiresVectorRebuild && !rebuildingAllCollections)
      );
      this.lastEmbed = {
        at: this.now().toISOString(),
        durationMs: Date.now() - started,
        collections: selected,
        errorCount,
        results,
      };
      await this.writeMetadata({
        lastEmbed: this.lastEmbed,
        vectorState: errorCount
          ? "partial_failure"
          : this.requiresVectorRebuild
            ? "rebuild_required"
            : "compatible",
      });
      return results;
      } finally {
        this.embeddingProgress = null;
      }
    });
  }

  async search(options = {}) {
    await this.initialize(options);
    const query = String(options.query || "").trim();
    if (!query) throw new Error("A non-empty knowledge search query is required.");
    const collections = normalizeCollectionNames(options.collections);
    const selected = collections.length ? collections : ["literature-evidence"];
    const limit = Math.min(
      RETRIEVAL_LIMITS.resultMaximum,
      Math.max(1, Number(options.limit) || RETRIEVAL_LIMITS.resultDefault)
    );
    const candidateLimit = Math.min(
      RETRIEVAL_LIMITS.candidateMaximum,
      Math.max(limit, Number(options.candidateLimit) || limit * 4)
    );
    const mode = ["fast", "semantic", "deep"].includes(options.mode)
      ? options.mode
      : "fast";
    if (this.requiresVectorRebuild && mode === "semantic") {
      const error = new Error(
        "The configured embedding model changed. Run a controlled vector rebuild before semantic search."
      );
      error.code = "QMD_VECTOR_REBUILD_REQUIRED";
      throw error;
    }
    const started = Date.now();
    let raw;
    if (mode === "fast" || mode === "deep") {
      raw = await this.store.searchLex(query, {
        limit: candidateLimit,
        collection: selected,
      });
    } else if (mode === "semantic") {
      raw = await this.store.searchVector(query, {
        limit: candidateLimit,
        collection: selected,
      });
    }
    const normalized = raw.map((result) => normalizeSearchResult(result, null, query));
    const paperCollections = selected.some((name) =>
      ["literature-evidence", "paper-cards"].includes(name)
    );
    const results = paperCollections
      ? groupPaperResults(raw, { paperIds: options.paperIds, limit, query })
      : normalized.slice(0, limit);
    this.lastSearch = {
      at: this.now().toISOString(),
      durationMs: Date.now() - started,
      mode,
      collections: selected,
      resultCount: results.length,
      ...(mode === "deep"
        ? {
            localStage: "lexical-candidates",
            cloudAssistanceRequired: true,
          }
        : {}),
    };
    return {
      mode,
      collections: selected,
      results,
      diagnostics: { ...this.lastSearch },
    };
  }

  async getDocument(options = {}) {
    await this.initialize(options);
    const identifier = String(options.pathOrDocid || "").trim();
    if (!identifier) throw new Error("A QMD document path or docid is required.");
    if (options.fromLine || options.maxLines) {
      return this.store.getDocumentBody(identifier, {
        fromLine: Math.max(1, Number(options.fromLine) || 1),
        maxLines: Math.min(500, Math.max(1, Number(options.maxLines) || 120)),
      });
    }
    return this.store.get(identifier, { includeBody: options.includeBody === true });
  }

  async status(options = {}) {
    if (!this.store && options.initialize !== false) await this.initialize(options);
    const maintenanceActive = this.pendingMaintenance > 0;
    const qmdStatus = this.store && !maintenanceActive ? await this.store.getStatus() : null;
    const indexHealth = this.store && !maintenanceActive
      ? await this.store.getIndexHealth()
      : null;
    const collections = this.store && !maintenanceActive
      ? await this.store.listCollections()
      : [];
    return {
      available: Boolean(this.store),
      qmdPackageVersion: QMD_PACKAGE_VERSION,
      nodeVersion: process.version,
      projectRoot: this.projectRoot,
      dbPath: this.dbPath,
      workspaceId: this.workspaceId,
      embeddingModelId: this.embedModel,
      embeddingModelVersion: this.embedModel.split("/").at(-1),
      rerankingModelId: null,
      queryExpansionModelId: null,
      cloudDeepRetrieval: true,
      requiresVectorRebuild: this.requiresVectorRebuild,
      collections,
      qmdStatus,
      indexHealth,
      pendingMaintenance: this.pendingMaintenance,
      embeddingProgress: this.embeddingProgress,
      lastUpdate: this.lastUpdate,
      lastEmbed: this.lastEmbed,
      lastSearch: this.lastSearch,
      error: this.initializationError
        ? {
            code: this.initializationError.code || this.initializationError.name,
            message: this.initializationError.message,
          }
        : null,
    };
  }

  async close() {
    await this.maintenanceTail.catch(() => {});
    if (this.store) await this.store.close();
    this.store = null;
  }
}
