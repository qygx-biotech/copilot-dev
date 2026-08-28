(function exposeSourceSystem(root, factory) {
  const api = factory(root);
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) Object.assign(root, api);
})(typeof globalThis !== "undefined" ? globalThis : this, function sourceSystemFactory(root) {
  "use strict";

  const SOURCE_REGISTRY_SCHEMA_VERSION = 2;
  const SOURCE_ARTIFACT_SCHEMA_VERSION = 1;
  const SOURCE_EXTRACTOR_VERSION = "local-source-v1";
  const EXPERIMENT_NORMALIZER_VERSION = "generic-tabular-v1";
  const CORPUS_WORKFLOW_VERSION = 1;
  const CORPUS_MAP_SCHEMA_VERSION = 1;
  const CORPUS_MAP_PROMPT_VERSION = "query-specific-map-v1";
  const LARGE_RESULT_CHARACTERS = 24000;
  const SOURCE_PATH = ".biodesign/sources/registry.json";
  const JOB_PATH = ".biodesign/jobs/index.json";
  const RESULT_DIRECTORY = ".biodesign/results";
  const WORKFLOW_DIRECTORY = ".biodesign/workflows";
  const ARTIFACT_DIRECTORY = ".biodesign/sources/artifacts";
  const PAPER_EXTENSIONS = new Set(["pdf"]);
  const EXPERIMENT_EXTENSIONS = new Set(["csv", "tsv", "xlsx", "xls", "txt"]);
  const READINESS_CAPABILITIES = Object.freeze({
    catalog: 0,
    stable_snapshot: 1,
    full_text: 2,
    search: 3,
    experiment_data: 3,
    paper_card: 4,
  });
  const DEFAULT_ENTITY_ALIASES = Object.freeze({
    ectd: ["EctD", "ectD"],
    hydroxyectoine: ["hydroxyectoine", "hydroxy-ectoine"],
    bl21: ["BL21", "BL21(DE3)"],
    kcat: ["kcat", "turnover number"],
    km: ["Km", "Michaelis constant"],
    titer: ["titer", "titre"],
    yield: ["yield"],
    productivity: ["productivity"],
  });

  class SourceSystemError extends Error {
    constructor(code, message, cause = null) {
      super(message, cause ? { cause } : undefined);
      this.name = "SourceSystemError";
      this.code = code;
      if (cause && !this.cause) this.cause = cause;
    }
  }

  function nowIso(now) {
    return (now ? now() : new Date()).toISOString();
  }

  function normalizePath(value) {
    return String(value || "")
      .replaceAll("\\", "/")
      .replace(/^\/+/, "")
      .replace(/\/{2,}/g, "/")
      .trim();
  }

  function extensionFor(value) {
    const name = String(value || "");
    const index = name.lastIndexOf(".");
    return index > 0 ? name.slice(index).toLowerCase() : "";
  }

  function extensionName(value) {
    return extensionFor(value).replace(/^\./, "");
  }

  function flattenTree(tree) {
    const entries = [];
    const visit = (node) => {
      if (!node || typeof node !== "object") return;
      if (node.type === "file") entries.push(node);
      (Array.isArray(node.children) ? node.children : []).forEach(visit);
    };
    visit(tree);
    return entries;
  }

  function sourceKindFor(path) {
    const normalized = normalizePath(path);
    const extension = extensionName(normalized);
    if (normalized.startsWith("experiments/") && EXPERIMENT_EXTENSIONS.has(extension)) {
      return "experiment";
    }
    if (normalized.startsWith("protocols/")) return "protocol";
    if (normalized.startsWith("literature/") && PAPER_EXTENSIONS.has(extension)) return "paper";
    if (PAPER_EXTENSIONS.has(extension)) return "other";
    return null;
  }

  function statSignatureFor(entry) {
    return [
      normalizePath(entry.relativePath || entry.path),
      Number(entry.size ?? entry.sizeBytes ?? entry.size_bytes) || 0,
      Number(entry.lastModified ?? entry.mtimeNs ?? entry.mtime_ns) || 0,
      entry.filesystemFileId || entry.filesystem_file_id || "",
    ].join("|");
  }

  function hashKey(value) {
    return String(value || "unhashed").replace(/[^a-zA-Z0-9._-]+/g, "-").slice(0, 160);
  }

  function stableStringHash(value) {
    let hash = 0x811c9dc5;
    for (const character of String(value || "")) {
      hash ^= character.codePointAt(0);
      hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    return hash.toString(16).padStart(8, "0");
  }

  function uniqueStrings(values, limit = 100) {
    return [...new Set(
      (Array.isArray(values) ? values : [])
        .filter((value) => typeof value === "string" && value.trim())
        .map((value) => value.trim())
    )].slice(0, limit);
  }

  function asList(value) {
    if (Array.isArray(value)) return value;
    return value === undefined || value === null || value === "" ? [] : [value];
  }

  function tokenize(value) {
    return uniqueStrings(
      String(value || "")
        .toLowerCase()
        .match(/[a-z0-9]+(?:[._+-][a-z0-9]+)*/g) || [],
      200
    );
  }

  function scoreText(text, query) {
    const haystack = String(text || "");
    const lowered = haystack.toLowerCase();
    const rawQuery = String(query || "").trim();
    const tokens = tokenize(rawQuery);
    if (!rawQuery) return 0;
    let score = lowered.includes(rawQuery.toLowerCase()) ? 8 : 0;
    for (const token of tokens) {
      const exact = new RegExp(`(^|[^a-z0-9])${token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^a-z0-9]|$)`, "i");
      if (exact.test(haystack)) score += 3;
      else if (lowered.includes(token)) score += 1;
    }
    return score;
  }

  function expandAliases(query, aliases = DEFAULT_ENTITY_ALIASES) {
    const value = String(query || "");
    const lowered = value.toLowerCase();
    const additions = [];
    for (const [key, values] of Object.entries(aliases || {})) {
      if (
        lowered.includes(key.toLowerCase()) ||
        values.some((alias) => lowered.includes(String(alias).toLowerCase()))
      ) additions.push(...values);
    }
    return uniqueStrings([value, ...additions]).join(" ");
  }

  function compactError(error) {
    return {
      code: String(error?.code || error?.name || "SOURCE_PREPARATION_FAILED").slice(0, 120),
      message: String(error?.message || "Source preparation failed.").slice(0, 1000),
    };
  }

  function normalizeCorpusMapResult(mapped, workerInput) {
    const allowedEvidenceRefs = new Set(
      workerInput.evidence.map((item) => item.evidenceRef)
    );
    const findings = (Array.isArray(mapped?.findings) ? mapped.findings : [])
      .slice(0, 20)
      .map((finding) => ({
        claim: String(finding?.claim || "").trim().slice(0, 1200),
        evidenceRefs: uniqueStrings(
          asList(finding?.evidenceRefs || finding?.evidence_refs).filter((reference) =>
            allowedEvidenceRefs.has(reference)
          ),
          12
        ),
      }))
      .filter((finding) => finding.claim);
    return {
      schemaVersion: CORPUS_MAP_SCHEMA_VERSION,
      promptVersion: CORPUS_MAP_PROMPT_VERSION,
      modelVersion: String(mapped?.modelVersion || "host-default-v1").slice(0, 200),
      paperId: workerInput.paperId,
      contentHash: workerInput.contentHash,
      relevance: ["high", "medium", "low", "none"].includes(mapped?.relevance)
        ? mapped.relevance
        : findings.length
          ? "medium"
          : "none",
      themes: uniqueStrings(asList(mapped?.themes), 20),
      findings,
      methods: uniqueStrings(asList(mapped?.methods), 30),
      limitations: uniqueStrings(asList(mapped?.limitations), 30),
    };
  }

  function sourceArtifactBase(sourceId, contentHash) {
    return `${ARTIFACT_DIRECTORY}/${sourceId}/${hashKey(contentHash)}`;
  }

  function normalizeLegacySource(document, now) {
    const relativePath = normalizePath(document.relativePath);
    const contentHash = typeof document.sourceHash === "string" ? document.sourceHash : null;
    const cardReady = document.paperCardStatus === "ready" || document.summaryAvailable === true;
    const timestamp = nowIso(now);
    return {
      sourceId: document.id,
      sourceKind: document.isLiteraturePaper === true ? "paper" : "other",
      path: relativePath,
      displayName: String(document.filename || relativePath.split("/").pop() || "source"),
      extension: extensionFor(relativePath),
      sizeBytes: Number(document.size) || 0,
      mtimeNs: Number(document.lastModified) || 0,
      filesystemFileId: document.filesystemFileId || null,
      statSignature: statSignatureFor({
        relativePath,
        size: document.size,
        lastModified: document.lastModified,
        filesystemFileId: document.filesystemFileId,
      }),
      contentHash,
      hashAlgorithm: contentHash ? String(contentHash).split(":")[0] : null,
      hashStatus: contentHash ? "ready" : "absent",
      catalogStatus: "discovered",
      parseStatus: "not_started",
      indexStatus: "not_started",
      paperCardStatus: cardReady
        ? "ready"
        : ["failed", "stale"].includes(document.paperCardStatus)
          ? document.paperCardStatus
          : "absent",
      structuredDataStatus: "not_applicable",
      contentVersion: contentHash,
      firstSeenAt: timestamp,
      lastSeenAt: timestamp,
      lastUsedAt: null,
      error: document.paperCardError ? { code: "LEGACY_CARD_FAILURE", message: document.paperCardError } : null,
      artifacts: cardReady
        ? {
            paperCard: {
              path: document.paperCardPath || document.summaryPath,
              contentHash,
              validationStatus: contentHash ? "validated" : "unknown",
              schemaVersion: Number(document.paperCardVersion) || 1,
            },
          }
        : {},
      legacy: {
        summaryPath: document.summaryPath,
        paperCardPath: document.paperCardPath || document.summaryPath,
        discovery: document.discovery || null,
      },
    };
  }

  class SourceRegistry {
    constructor(options) {
      this.workspace = options.workspace;
      this.now = options.now || (() => new Date());
      this.records = [];
      this.loaded = false;
      this.metrics = {
        reconciliationCount: 0,
        lastReconciliationMs: 0,
        lastStatCalls: 0,
        fullHashCallsDuringReconciliation: 0,
        llmCallsDuringReconciliation: 0,
      };
    }

    async load(options = {}) {
      if (this.loaded && options.force !== true) return this.records;
      let registry = null;
      if (await this.workspace.fileExists(SOURCE_PATH)) {
        registry = await this.workspace.readJson(SOURCE_PATH);
      }
      if (!registry || Number(registry.schemaVersion) !== SOURCE_REGISTRY_SCHEMA_VERSION) {
        const legacy = Array.isArray(options.legacyDocuments) ? options.legacyDocuments : [];
        registry = {
          schemaVersion: SOURCE_REGISTRY_SCHEMA_VERSION,
          sources: legacy.map((document) => normalizeLegacySource(document, this.now)),
          aliases: { ...DEFAULT_ENTITY_ALIASES },
          settings: { idleWarmingEnabled: false, idleWarmingConcurrency: 1 },
          metrics: this.metrics,
          updatedAt: nowIso(this.now),
        };
        await this.workspace.writeJson(SOURCE_PATH, registry);
      }
      this.records = Array.isArray(registry.sources) ? registry.sources : [];
      this.metrics = { ...this.metrics, ...(registry.metrics || {}) };
      this.settings = {
        idleWarmingEnabled: false,
        idleWarmingConcurrency: 1,
        ...(registry.settings || {}),
      };
      this.aliases = registry.aliases && typeof registry.aliases === "object"
        ? { ...DEFAULT_ENTITY_ALIASES, ...registry.aliases }
        : { ...DEFAULT_ENTITY_ALIASES };
      this.loaded = true;
      return this.records;
    }

    async persist() {
      await this.workspace.writeJson(SOURCE_PATH, {
        schemaVersion: SOURCE_REGISTRY_SCHEMA_VERSION,
        sources: this.records,
        aliases: this.aliases || {},
        settings: this.settings || { idleWarmingEnabled: false, idleWarmingConcurrency: 1 },
        metrics: this.metrics,
        updatedAt: nowIso(this.now),
      });
      return this.records;
    }

    get(sourceId, options = {}) {
      const source = this.records.find((item) => item.sourceId === sourceId) || null;
      if (!source || (options.includeMissing !== true && source.catalogStatus === "missing")) {
        return null;
      }
      return source;
    }

    getByPath(path, options = {}) {
      const normalized = normalizePath(path);
      const source = this.records.find((item) => item.path === normalized) || null;
      if (!source || (options.includeMissing !== true && source.catalogStatus === "missing")) {
        return null;
      }
      return source;
    }

    list(options = {}) {
      return this.records.filter(
        (source) =>
          (options.includeMissing === true || source.catalogStatus !== "missing") &&
          (!options.sourceKind || source.sourceKind === options.sourceKind)
      );
    }

    counts() {
      const active = this.list();
      const papers = active.filter((source) => source.sourceKind === "paper");
      const experiments = active.filter((source) => source.sourceKind === "experiment");
      return {
        papersDiscovered: papers.length,
        papersSearchable: papers.filter((source) => source.indexStatus === "ready").length,
        papersWithCards: papers.filter((source) => source.paperCardStatus === "ready").length,
        experimentsDiscovered: experiments.length,
        experimentsReady: experiments.filter(
          (source) => source.structuredDataStatus === "ready"
        ).length,
      };
    }

    async reconcile(tree, options = {}) {
      const started = Date.now();
      await this.load({ legacyDocuments: options.legacyDocuments });
      const relevantFiles = flattenTree(tree).filter((entry) => sourceKindFor(entry.relativePath));
      const byPath = new Map(this.records.map((source) => [source.path, source]));
      const byFileId = new Map(
        this.records
          .filter((source) => source.filesystemFileId)
          .map((source) => [source.filesystemFileId, source])
      );
      const seen = new Set();
      const changes = { unchanged: [], discovered: [], dirty: [], missing: [], renamed: [] };
      const seenAt = nowIso(this.now);

      for (const file of relevantFiles) {
        const path = normalizePath(file.relativePath);
        const fileId = file.filesystemFileId || null;
        let source = byPath.get(path) || (fileId ? byFileId.get(fileId) : null);
        const wasMissing = source?.catalogStatus === "missing";
        const signature = statSignatureFor(file);
        if (source && source.path !== path && fileId) {
          changes.renamed.push({ sourceId: source.sourceId, from: source.path, to: path });
          byPath.delete(source.path);
          source.path = path;
          byPath.set(path, source);
        }
        if (!source) {
          const sourceId = this.workspace.createId();
          source = {
            sourceId,
            sourceKind: sourceKindFor(path),
            path,
            displayName: file.name || path.split("/").pop(),
            extension: extensionFor(path),
            sizeBytes: Number(file.size) || 0,
            mtimeNs: Number(file.lastModified) || 0,
            filesystemFileId: fileId,
            statSignature: signature,
            contentHash: null,
            hashAlgorithm: null,
            hashStatus: "absent",
            catalogStatus: "discovered",
            parseStatus: "not_started",
            indexStatus: "not_started",
            paperCardStatus: sourceKindFor(path) === "paper" ? "absent" : "not_applicable",
            structuredDataStatus:
              sourceKindFor(path) === "experiment" ? "not_started" : "not_applicable",
            contentVersion: null,
            firstSeenAt: seenAt,
            lastSeenAt: seenAt,
            lastUsedAt: null,
            error: null,
            artifacts: {},
            legacy: {},
          };
          this.records.push(source);
          byPath.set(path, source);
          changes.discovered.push(sourceId);
        } else if (source.statSignature !== signature) {
          source.catalogStatus = "dirty";
          source.hashStatus = source.contentHash ? "dirty" : "absent";
          if (source.parseStatus === "ready") source.parseStatus = "stale";
          if (source.indexStatus === "ready") source.indexStatus = "stale";
          if (source.paperCardStatus === "ready") source.paperCardStatus = "stale";
          if (source.structuredDataStatus === "ready") source.structuredDataStatus = "stale";
          changes.dirty.push(source.sourceId);
        } else {
          if (source.catalogStatus !== "discovered") source.catalogStatus = "discovered";
          changes.unchanged.push(source.sourceId);
        }
        source.sourceKind = sourceKindFor(path);
        source.path = path;
        source.displayName = file.name || path.split("/").pop();
        source.extension = extensionFor(path);
        source.sizeBytes = Number(file.size) || 0;
        source.mtimeNs = Number(file.lastModified) || 0;
        source.filesystemFileId = fileId;
        source.statSignature = signature;
        source.lastSeenAt = seenAt;
        if (wasMissing && source.error?.code === "SOURCE_MISSING") source.error = null;
        seen.add(source.sourceId);
      }

      for (const source of this.records) {
        if (seen.has(source.sourceId) || source.catalogStatus === "missing") continue;
        source.catalogStatus = "missing";
        source.hashStatus = source.contentHash ? "stale" : "absent";
        if (source.parseStatus !== "not_started") source.parseStatus = "stale";
        if (source.indexStatus !== "not_started") source.indexStatus = "stale";
        if (source.paperCardStatus !== "not_applicable") source.paperCardStatus = "stale";
        if (source.structuredDataStatus !== "not_applicable") {
          source.structuredDataStatus = "stale";
        }
        source.error = { code: "SOURCE_MISSING", message: "The source file is no longer present." };
        changes.missing.push(source.sourceId);
      }

      this.metrics.reconciliationCount += 1;
      this.metrics.lastReconciliationMs = Date.now() - started;
      this.metrics.lastStatCalls = relevantFiles.length;
      this.metrics.fullHashCallsDuringReconciliation = 0;
      this.metrics.llmCallsDuringReconciliation = 0;
      await this.persist();
      console.info("source_registry_reconciled", {
        durationMs: this.metrics.lastReconciliationMs,
        statCalls: relevantFiles.length,
        fullHashCalls: 0,
        llmCalls: 0,
        discovered: changes.discovered.length,
        dirty: changes.dirty.length,
        missing: changes.missing.length,
      });
      return { sources: this.list(), changes, metrics: { ...this.metrics } };
    }

    async update(sourceId, changes) {
      const source = this.get(sourceId, { includeMissing: true });
      if (!source) throw new SourceSystemError("SOURCE_NOT_FOUND", "The source is not registered.");
      Object.assign(source, changes);
      await this.persist();
      return source;
    }

    async reconnectByHash(sourceId) {
      const source = this.get(sourceId, { includeMissing: true });
      if (!source?.contentHash) return source;
      const candidates = this.records.filter(
        (candidate) =>
          candidate.sourceId !== source.sourceId &&
          candidate.catalogStatus === "missing" &&
          candidate.sourceKind === source.sourceKind &&
          candidate.contentHash === source.contentHash
      );
      if (candidates.length !== 1) return source;
      const previous = candidates[0];
      const currentMetadata = {
        path: source.path,
        displayName: source.displayName,
        extension: source.extension,
        sizeBytes: source.sizeBytes,
        mtimeNs: source.mtimeNs,
        filesystemFileId: source.filesystemFileId,
        statSignature: source.statSignature,
        catalogStatus: "discovered",
        hashStatus: "ready",
        lastSeenAt: source.lastSeenAt,
        lastUsedAt: source.lastUsedAt,
        error: null,
      };
      Object.assign(previous, currentMetadata);
      this.records = this.records.filter((item) => item.sourceId !== source.sourceId);
      await this.persist();
      return previous;
    }
  }

  class SourceJobManager {
    constructor(options) {
      this.workspace = options.workspace;
      this.now = options.now || (() => new Date());
      this.jobs = [];
      this.inFlight = new Map();
      this.loaded = false;
    }

    async load() {
      if (this.loaded) return this.jobs;
      if (await this.workspace.fileExists(JOB_PATH)) {
        const state = await this.workspace.readJson(JOB_PATH);
        this.jobs = Array.isArray(state.jobs) ? state.jobs : [];
      }
      let changed = false;
      for (const job of this.jobs) {
        if (job.status === "running" || job.status === "queued") {
          job.status = "stale";
          job.error = { code: "APPLICATION_RESTARTED", message: "The application restarted before this job completed." };
          job.completedAt = nowIso(this.now);
          changed = true;
        }
      }
      this.loaded = true;
      if (changed) await this.persist();
      return this.jobs;
    }

    async persist() {
      await this.workspace.writeJson(JOB_PATH, {
        schemaVersion: 1,
        jobs: this.jobs.slice(-500),
        updatedAt: nowIso(this.now),
      });
    }

    async runDeduplicated(key, type, sourceIds, work, options = {}) {
      await this.load();
      if (this.inFlight.has(key)) return this.inFlight.get(key);
      const createdAt = nowIso(this.now);
      const job = {
        jobId: this.workspace.createId(),
        dedupeKey: key,
        jobType: type,
        sourceIds: uniqueStrings(sourceIds),
        status: "queued",
        progress: { completed: 0, total: Math.max(1, sourceIds.length), stage: "queued" },
        createdAt,
        startedAt: null,
        completedAt: null,
        error: null,
        resultHandle: null,
      };
      this.jobs.push(job);
      await this.persist();
      console.info("source_job_queued", {
        jobId: job.jobId,
        jobType: type,
        sourceCount: job.sourceIds.length,
        queueDepth: this.inFlight.size + 1,
      });
      const promise = (async () => {
        job.status = "running";
        job.startedAt = nowIso(this.now);
        job.progress.stage = "running";
        await this.persist();
        const report = async (progress) => {
          job.progress = { ...job.progress, ...(progress || {}) };
          options.onProgress?.({ jobId: job.jobId, ...job.progress });
          await this.persist();
        };
        try {
          const result = await work({ job, report });
          job.status = "completed";
          job.progress = { ...job.progress, stage: "completed", completed: job.progress.total };
          job.completedAt = nowIso(this.now);
          if (result?.resultHandle) job.resultHandle = result.resultHandle;
          await this.persist();
          console.info("source_job_completed", {
            jobId: job.jobId,
            jobType: type,
            sourceCount: job.sourceIds.length,
          });
          return result;
        } catch (error) {
          job.status = error?.code === "OPERATION_ABORTED" ? "cancelled" : "failed";
          job.error = compactError(error);
          job.completedAt = nowIso(this.now);
          await this.persist();
          console.info("source_job_failed", {
            jobId: job.jobId,
            jobType: type,
            sourceCount: job.sourceIds.length,
            code: job.error.code,
          });
          throw error;
        } finally {
          this.inFlight.delete(key);
        }
      })();
      this.inFlight.set(key, promise);
      return promise;
    }

    list(options = {}) {
      return this.jobs.filter((job) => !options.status || job.status === options.status);
    }
  }

  class SourceResultStore {
    constructor(options) {
      this.workspace = options.workspace;
      this.now = options.now || (() => new Date());
      this.maxInlineCharacters = Number(options.maxInlineCharacters) || LARGE_RESULT_CHARACTERS;
    }

    async compact(value, metadata = {}) {
      const serialized = JSON.stringify(value);
      if (serialized.length <= this.maxInlineCharacters) return value;
      const resultId = this.workspace.createId();
      const path = `${RESULT_DIRECTORY}/${resultId}.json`;
      await this.workspace.writeJson(path, {
        schemaVersion: 1,
        resultId,
        createdAt: nowIso(this.now),
        metadata,
        value,
      });
      return {
        resultHandle: resultId,
        resultPath: path,
        persistedCharacters: serialized.length,
        preview: Array.isArray(value)
          ? value.slice(0, 5)
          : value && typeof value === "object"
            ? {
                workflowId: value.workflowId,
                status: value.status,
                phase: value.phase,
                question: value.question,
                snapshotCount: Array.isArray(value.snapshot) ? value.snapshot.length : undefined,
                failureCount: value.failures ? Object.keys(value.failures).length : undefined,
                failures: value.failures
                  ? Object.fromEntries(
                      Object.entries(value.failures)
                        .slice(0, 500)
                        .map(([sourceId, error]) => [
                          sourceId,
                          {
                            code: String(error?.code || "FAILED").slice(0, 120),
                            message: String(error?.message || "Source failed.").slice(0, 300),
                          },
                        ])
                    )
                  : undefined,
                reduction: value.reduction
                  ? {
                      papersIncluded: value.reduction.papersIncluded,
                      papersFailed: value.reduction.papersFailed,
                      themes: (value.reduction.themes || []).slice(0, 20),
                      findings: (value.reduction.findings || []).slice(0, 40),
                    }
                  : undefined,
                verification: (value.verification || []).slice(0, 20),
              }
            : value,
        notice: "The complete result is stored outside active context. Read it by result handle when needed.",
      };
    }

    async read(resultHandle) {
      const path = `${RESULT_DIRECTORY}/${String(resultHandle || "")}.json`;
      if (!(await this.workspace.fileExists(path))) {
        throw new SourceSystemError("RESULT_NOT_FOUND", "The stored result handle was not found.");
      }
      return (await this.workspace.readJson(path)).value;
    }
  }

  async function hashBytes(bytes, cryptoProvider = root.crypto) {
    const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    if (cryptoProvider?.subtle?.digest) {
      const digest = await cryptoProvider.subtle.digest(
        "SHA-256",
        view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength)
      );
      return `sha256:${[...new Uint8Array(digest)]
        .map((byte) => byte.toString(16).padStart(2, "0"))
        .join("")}`;
    }
    let hash = 0x811c9dc5;
    for (const byte of view) {
      hash ^= byte;
      hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    return `fnv1a32:${hash.toString(16).padStart(8, "0")}:${view.length}`;
  }

  function paperArtifactFromExtraction(source, extracted, options = {}) {
    const text = String(extracted.text || "");
    const pageMatches = [...text.matchAll(/^# Page (\d+)\n/gm)];
    const pages = [];
    if (pageMatches.length) {
      for (let index = 0; index < pageMatches.length; index += 1) {
        const start = pageMatches[index].index + pageMatches[index][0].length;
        const end = pageMatches[index + 1]?.index ?? text.length;
        pages.push({ page: Number(pageMatches[index][1]), text: text.slice(start, end).trim() });
      }
    } else if (text) {
      pages.push({ page: 1, text });
    }
    const chunkCharacters = Number(options.chunkCharacters) || 4000;
    const overlap = Math.min(Number(options.chunkOverlap) || 300, Math.floor(chunkCharacters / 3));
    const chunks = [];
    for (const page of pages) {
      let offset = 0;
      let pageChunk = 0;
      while (offset < page.text.length) {
        let end = Math.min(page.text.length, offset + chunkCharacters);
        if (end < page.text.length) {
          const boundary = Math.max(
            page.text.lastIndexOf("\n\n", end),
            page.text.lastIndexOf(". ", end)
          );
          if (boundary > offset + chunkCharacters * 0.55) end = boundary + 1;
        }
        const chunkText = page.text.slice(offset, end).trim();
        if (chunkText) {
          pageChunk += 1;
          chunks.push({
            chunkId: `${source.sourceId}-P${page.page}-C${pageChunk}`,
            page: page.page,
            section: null,
            text: chunkText,
          });
        }
        if (end >= page.text.length) break;
        offset = Math.max(offset + 1, end - overlap);
      }
    }
    return {
      schemaVersion: SOURCE_ARTIFACT_SCHEMA_VERSION,
      extractorVersion: SOURCE_EXTRACTOR_VERSION,
      sourceId: source.sourceId,
      contentHash: source.contentHash,
      pageCount: Number(extracted.pageCount) || pages.length || null,
      metadataTitle: extracted.metadataTitle || null,
      truncated: extracted.truncated === true,
      pages,
      chunks,
      extractedCharacters: text.length,
      createdAt: new Date().toISOString(),
    };
  }

  function decodeText(bytes) {
    try {
      return new TextDecoder("utf-8", { fatal: false }).decode(bytes);
    } catch {
      return "";
    }
  }

  function parseDelimited(text, delimiter) {
    const rows = [];
    let row = [];
    let cell = "";
    let quoted = false;
    const value = String(text || "").replace(/\r\n?/g, "\n");
    for (let index = 0; index < value.length; index += 1) {
      const character = value[index];
      if (character === '"') {
        if (quoted && value[index + 1] === '"') {
          cell += '"';
          index += 1;
        } else quoted = !quoted;
      } else if (character === delimiter && !quoted) {
        row.push(cell);
        cell = "";
      } else if (character === "\n" && !quoted) {
        row.push(cell);
        rows.push(row);
        row = [];
        cell = "";
      } else cell += character;
    }
    if (cell || row.length) {
      row.push(cell);
      rows.push(row);
    }
    return rows.filter((candidate) => candidate.some((entry) => String(entry).trim()));
  }

  function normalizeHeader(value, index) {
    return String(value || `column_${index + 1}`)
      .trim()
      .replace(/\s+/g, "_")
      .replace(/[^a-zA-Z0-9_.()-]+/g, "_")
      .replace(/^_+|_+$/g, "") || `column_${index + 1}`;
  }

  function spreadsheetColumnLabel(index) {
    let value = Number(index) + 1;
    let label = "";
    while (value > 0) {
      value -= 1;
      label = String.fromCharCode(65 + (value % 26)) + label;
      value = Math.floor(value / 26);
    }
    return label || "A";
  }

  function parseSpreadsheetRange(value) {
    const match = String(value || "").trim().match(
      /^([A-Z]+)(\d+)(?::([A-Z]+)(\d+))?$/i
    );
    if (!match) return null;
    const columnIndex = (letters) =>
      [...letters.toUpperCase()].reduce(
        (total, character) => total * 26 + character.charCodeAt(0) - 64,
        0
      ) - 1;
    const startColumn = columnIndex(match[1]);
    const startRow = Number(match[2]) - 1;
    const endColumn = columnIndex(match[3] || match[1]);
    const endRow = Number(match[4] || match[2]) - 1;
    if (
      startColumn < 0 ||
      startRow < 0 ||
      endColumn < startColumn ||
      endRow < startRow
    ) return null;
    return { startColumn, startRow, endColumn, endRow };
  }

  function rowsToExperimentRecords(source, sheets) {
    const records = [];
    for (const sheet of sheets) {
      const rows = Array.isArray(sheet.rows) ? sheet.rows : [];
      if (!rows.length) continue;
      const headers = rows[0].map(normalizeHeader);
      for (let rowIndex = 1; rowIndex < rows.length; rowIndex += 1) {
        const raw = {};
        headers.forEach((header, columnIndex) => {
          raw[header] = rows[rowIndex][columnIndex] ?? "";
        });
        const rawText = Object.values(raw).join(" ");
        if (!rawText.trim()) continue;
        records.push({
          experimentId: `${source.sourceId}-R${records.length + 1}`,
          sourceId: source.sourceId,
          sourceContentHash: source.contentHash,
          raw,
          entities: {
            proteins: uniqueStrings(Object.entries(raw).filter(([key]) => /protein|enzyme/i.test(key)).map(([, value]) => String(value))),
            genes: uniqueStrings(Object.entries(raw).filter(([key]) => /gene/i.test(key)).map(([, value]) => String(value))),
            mutations: uniqueStrings((rawText.match(/\b[A-Z]\d{1,5}[A-Z]\b/g) || [])),
            strains: uniqueStrings(Object.entries(raw).filter(([key]) => /strain|host/i.test(key)).map(([, value]) => String(value))),
          },
          provenance: {
            sourceFile: source.path,
            sourceSheet: sheet.name,
            sourceRange: `A${rowIndex + 1}:${spreadsheetColumnLabel(
              Math.max(0, headers.length - 1)
            )}${rowIndex + 1}`,
            row: rowIndex + 1,
          },
        });
      }
    }
    return records;
  }

  function parseExperimentBytes(source, bytes, spreadsheetProvider = root.XLSX) {
    const extension = extensionName(source.path);
    let sheets = [];
    if (extension === "xlsx" || extension === "xls") {
      if (!spreadsheetProvider?.read || !spreadsheetProvider?.utils?.sheet_to_json) {
        throw new SourceSystemError(
          "SPREADSHEET_PARSER_MISSING",
          "The spreadsheet parser is unavailable for this workbook."
        );
      }
      const workbook = spreadsheetProvider.read(bytes, { type: "array", cellDates: true });
      sheets = workbook.SheetNames.map((name) => ({
        name,
        rows: spreadsheetProvider.utils.sheet_to_json(workbook.Sheets[name], {
          header: 1,
          raw: true,
          defval: "",
          blankrows: false,
        }),
      }));
    } else {
      const text = decodeText(bytes);
      const firstLine = text.split(/\r?\n/, 1)[0] || "";
      const delimiter =
        extension === "tsv" ||
        (extension === "txt" && firstLine.includes("\t") && !firstLine.includes(","))
          ? "\t"
          : ",";
      sheets = [{ name: "data", rows: parseDelimited(text, delimiter) }];
    }
    return {
      schemaVersion: SOURCE_ARTIFACT_SCHEMA_VERSION,
      normalizerVersion: EXPERIMENT_NORMALIZER_VERSION,
      sourceId: source.sourceId,
      contentHash: source.contentHash,
      sheets,
      records: rowsToExperimentRecords(source, sheets),
      createdAt: new Date().toISOString(),
    };
  }

  async function runBounded(items, concurrency, mapper) {
    const results = new Array(items.length);
    let cursor = 0;
    const worker = async () => {
      while (cursor < items.length) {
        const index = cursor;
        cursor += 1;
        results[index] = await mapper(items[index], index);
      }
    };
    await Promise.all(
      Array.from({ length: Math.min(Math.max(1, concurrency), items.length) }, worker)
    );
    return results;
  }

  class SourcePreparationService {
    constructor(options) {
      this.workspace = options.workspace;
      this.registry = options.registry;
      this.jobs = options.jobs || new SourceJobManager(options);
      this.results = options.results || new SourceResultStore(options);
      this.cryptoProvider = options.cryptoProvider || root.crypto;
      this.parsePaper = options.parsePaper;
      this.spreadsheetProvider = options.spreadsheetProvider || root.XLSX;
      this.generatePaperCard = options.generatePaperCard || null;
      this.now = options.now || (() => new Date());
      this.debounceMilliseconds = Number(options.debounceMilliseconds) || 750;
      this.metrics = {
        fullHashCalls: 0,
        fullHashBytes: 0,
        hashDurationMs: 0,
        paperParseCalls: 0,
        paperParseDurationMs: 0,
        experimentParseCalls: 0,
        experimentParseDurationMs: 0,
        indexDurationMs: 0,
        paperCardCalls: 0,
        paperCardDurationMs: 0,
        cacheHits: 0,
        cacheMisses: 0,
      };
      this.inFlight = new Map();
    }

    setPaperCardGenerator(generator) {
      this.generatePaperCard = generator;
    }

    capabilitySatisfied(source, capability) {
      if (source.catalogStatus === "missing" || source.catalogStatus === "dirty") return false;
      if (capability === "catalog") return true;
      if (capability === "stable_snapshot") return source.hashStatus === "ready";
      if (capability === "full_text") {
        return source.hashStatus === "ready" && source.parseStatus === "ready";
      }
      if (capability === "search") {
        return source.hashStatus === "ready" && source.indexStatus === "ready";
      }
      if (capability === "paper_card") {
        return (
          source.hashStatus === "ready" &&
          source.paperCardStatus === "ready" &&
          source.artifacts?.paperCard?.contentHash === source.contentHash
        );
      }
      if (capability === "experiment_data") {
        return source.hashStatus === "ready" && source.structuredDataStatus === "ready";
      }
      return false;
    }

    async cachedCapabilityAvailable(source, capability) {
      const artifact =
        ["full_text", "search"].includes(capability)
          ? source.artifacts?.paperText
          : capability === "paper_card"
            ? source.artifacts?.paperCard
            : capability === "experiment_data"
              ? source.artifacts?.experimentData
              : null;
      if (!artifact) return ["catalog", "stable_snapshot"].includes(capability);
      return Boolean(
        artifact.path &&
        artifact.contentHash === source.contentHash &&
        (await this.workspace.fileExists(artifact.path))
      );
    }

    invalidateMissingCapabilityArtifact(source, capability) {
      if (["full_text", "search"].includes(capability)) {
        delete source.artifacts.paperText;
        source.parseStatus = "not_started";
        source.indexStatus = "not_started";
      } else if (capability === "paper_card") {
        delete source.artifacts.paperCard;
        source.paperCardStatus = "absent";
      } else if (capability === "experiment_data") {
        delete source.artifacts.experimentData;
        source.structuredDataStatus = "not_started";
      }
    }

    async ensureSourceReady(sourceIds, capability, requestContext = {}) {
      if (!(capability in READINESS_CAPABILITIES)) {
        throw new SourceSystemError("UNKNOWN_CAPABILITY", `Unknown source capability: ${capability}`);
      }
      const ids = uniqueStrings(Array.isArray(sourceIds) ? sourceIds : [sourceIds]);
      const results = await runBounded(
        ids,
        Math.min(2, Number(requestContext.concurrency) || 2),
        async (sourceId) => {
          try {
            return await this.ensureOne(sourceId, capability, requestContext);
          } catch (error) {
            if (ids.length === 1 || requestContext.failFast === true) throw error;
            return {
              sourceId,
              capability,
              failed: true,
              error: compactError(error),
            };
          }
        }
      );
      return {
        capability,
        sources: results,
        failures: results.filter((result) => result?.failed === true),
        metrics: { ...this.metrics },
      };
    }

    async ensureOne(sourceId, capability, requestContext = {}) {
      let source = this.registry.get(sourceId);
      if (!source) throw new SourceSystemError("SOURCE_NOT_FOUND", "The source is missing or no longer active.");
      if (
        ["full_text", "search", "paper_card"].includes(capability) &&
        source.sourceKind !== "paper"
      ) {
        throw new SourceSystemError(
          "CAPABILITY_NOT_SUPPORTED",
          `${capability} is only available for paper sources.`
        );
      }
      if (capability === "experiment_data" && source.sourceKind !== "experiment") {
        throw new SourceSystemError(
          "CAPABILITY_NOT_SUPPORTED",
          "experiment_data is only available for experiment sources."
        );
      }
      if (this.capabilitySatisfied(source, capability)) {
        if (await this.cachedCapabilityAvailable(source, capability)) {
          this.metrics.cacheHits += 1;
          source.lastUsedAt = nowIso(this.now);
          await this.registry.persist();
          console.info("source_readiness_cache_hit", {
            sourceId: source.sourceId,
            sourceKind: source.sourceKind,
            capability,
          });
          return this.compactReadiness(source, capability, true);
        }
        this.invalidateMissingCapabilityArtifact(source, capability);
        await this.registry.persist();
      }
      this.metrics.cacheMisses += 1;
      const lockKey = [source.sourceId, source.statSignature].join(":");
      if (this.inFlight.has(lockKey)) {
        await this.inFlight.get(lockKey);
        return this.ensureOne(sourceId, capability, requestContext);
      }
      const jobPromise = this.jobs.runDeduplicated(
        lockKey,
        `prepare:${capability}`,
        [source.sourceId],
        async ({ report }) => {
          await report({ stage: "verifying", completed: 0, total: 1 });
          source = await this.prepareOne(source.sourceId, capability, requestContext, report);
          await report({ stage: "ready", completed: 1, total: 1 });
          return this.compactReadiness(source, capability, false);
        },
        requestContext
      );
      const promise = jobPromise.finally(() => {
        if (this.inFlight.get(lockKey) === promise) this.inFlight.delete(lockKey);
      });
      this.inFlight.set(lockKey, promise);
      try {
        return await promise;
      } catch (error) {
        const failed = this.registry.get(sourceId, { includeMissing: true });
        if (failed) {
          failed.error = compactError(error);
          if (error?.code === "SOURCE_MISSING") {
            failed.catalogStatus = "missing";
          } else if (error?.code === "SOURCE_CHANGED_DURING_PREPARATION") {
            failed.catalogStatus = "dirty";
            failed.hashStatus = failed.contentHash ? "dirty" : "absent";
          } else if (error?.code === "SOURCE_STILL_CHANGING") {
            failed.catalogStatus = "dirty";
            failed.hashStatus = failed.contentHash ? "dirty" : "absent";
          } else if (error?.code !== "OPERATION_ABORTED") {
            if (capability === "stable_snapshot" && !failed.contentHash) {
              failed.hashStatus = "failed";
            }
            if (["full_text", "search"].includes(capability)) {
              failed.parseStatus = "failed";
              failed.indexStatus = "failed";
            }
            if (capability === "paper_card") failed.paperCardStatus = "failed";
            if (capability === "experiment_data") {
              failed.structuredDataStatus = "failed";
            }
          }
          await this.registry.persist();
        }
        throw error;
      }
    }

    compactReadiness(source, capability, cached) {
      return {
        sourceId: source.sourceId,
        sourceKind: source.sourceKind,
        path: source.path,
        capability,
        cached,
        contentHash: source.contentHash,
        hashStatus: source.hashStatus,
        parseStatus: source.parseStatus,
        indexStatus: source.indexStatus,
        paperCardStatus: source.paperCardStatus,
        structuredDataStatus: source.structuredDataStatus,
        artifacts: source.artifacts || {},
      };
    }

    async readCurrentFile(source) {
      let file;
      try {
        file = await this.workspace.readFile(source.path);
      } catch (error) {
        await this.registry.update(source.sourceId, {
          catalogStatus: "missing",
          error: compactError(error),
        });
        throw new SourceSystemError("SOURCE_MISSING", `Source file is unavailable: ${source.path}`, error);
      }
      return file;
    }

    async prepareOne(sourceId, capability, requestContext, report) {
      let source = this.registry.get(sourceId);
      if (!source) throw new SourceSystemError("SOURCE_NOT_FOUND", "The source is no longer active.");
      const preparationStarted = Date.now();
      const metricsBefore = { ...this.metrics };
      if (requestContext.signal?.aborted) {
        throw new SourceSystemError("OPERATION_ABORTED", "Source preparation was cancelled.");
      }
      const previousDerivedState = {
        contentHash: source.contentHash,
        contentVersion: source.contentVersion,
        hashAlgorithm: source.hashAlgorithm,
        hashStatus: source.hashStatus,
        parseStatus: source.parseStatus,
        indexStatus: source.indexStatus,
        paperCardStatus: source.paperCardStatus,
        structuredDataStatus: source.structuredDataStatus,
        artifacts: JSON.parse(JSON.stringify(source.artifacts || {})),
        legacy: JSON.parse(JSON.stringify(source.legacy || {})),
      };
      const firstFile = await this.readCurrentFile(source);
      const currentSignature = statSignatureFor({
        relativePath: source.path,
        size: firstFile.size,
        lastModified: firstFile.lastModified,
        filesystemFileId: source.filesystemFileId,
      });
      if (currentSignature !== source.statSignature) {
        source.statSignature = currentSignature;
        source.sizeBytes = Number(firstFile.size) || 0;
        source.mtimeNs = Number(firstFile.lastModified) || 0;
        source.catalogStatus = "dirty";
        source.hashStatus = source.contentHash ? "dirty" : "absent";
        await this.registry.persist();
      }
      if (capability === "catalog") {
        source.catalogStatus = "discovered";
        source.lastUsedAt = nowIso(this.now);
        await this.registry.persist();
        return source;
      }

      const needsHash = source.hashStatus !== "ready" || !source.contentHash;
      const needsPaper = source.sourceKind === "paper" && ["full_text", "search", "paper_card"].includes(capability);
      const needsExperiment = source.sourceKind === "experiment" && capability === "experiment_data";
      const artifactMatches = (artifact) =>
        artifact?.contentHash && artifact.contentHash === source.contentHash;

      if (!needsHash) {
        if (needsPaper && artifactMatches(source.artifacts?.paperText)) {
          source.parseStatus = "ready";
          source.indexStatus = "ready";
        }
        if (needsExperiment && artifactMatches(source.artifacts?.experimentData)) {
          source.structuredDataStatus = "ready";
        }
        if (capability === "paper_card" && artifactMatches(source.artifacts?.paperCard)) {
          source.paperCardStatus = "ready";
        }
        if (this.capabilitySatisfied(source, capability)) {
          source.lastUsedAt = nowIso(this.now);
          await this.registry.persist();
          return source;
        }
      }

      if (
        Number(firstFile.lastModified) > 0 &&
        Date.now() - Number(firstFile.lastModified) < this.debounceMilliseconds
      ) {
        throw new SourceSystemError(
          "SOURCE_STILL_CHANGING",
          "The source was modified very recently and may still be copying. Retry shortly."
        );
      }

      const needsPaperBytes = needsPaper && !artifactMatches(source.artifacts?.paperText);
      const needsExperimentBytes =
        needsExperiment && !artifactMatches(source.artifacts?.experimentData);
      const needsBytes = needsHash || needsPaperBytes || needsExperimentBytes;
      const bytes = needsBytes
        ? new Uint8Array(await firstFile.arrayBuffer())
        : null;
      let contentHash = source.contentHash;
      let hashBytesRead = 0;
      if (needsHash) {
        await report({ stage: "hashing", completed: 0, total: 1 });
        const hashStarted = Date.now();
        contentHash = await hashBytes(bytes, this.cryptoProvider);
        hashBytesRead = bytes.byteLength;
        this.metrics.fullHashCalls += 1;
        this.metrics.fullHashBytes += bytes.byteLength;
        this.metrics.hashDurationMs += Date.now() - hashStarted;
      }
      const previousHash = source.contentHash;
      const contentChanged = Boolean(previousHash && previousHash !== contentHash);

      if (contentChanged) {
        source.artifacts = {};
        source.parseStatus = "not_started";
        source.indexStatus = "not_started";
        source.paperCardStatus = source.sourceKind === "paper" ? "absent" : "not_applicable";
        source.structuredDataStatus = source.sourceKind === "experiment" ? "not_started" : "not_applicable";
      }
      source.contentHash = contentHash;
      source.contentVersion = contentHash;
      source.hashAlgorithm = contentHash.split(":")[0];
      source.hashStatus = "ready";
      source.catalogStatus = "discovered";
      source.error = null;

      // Timestamp-only changes retain exact derived artifacts after the hash proves
      // content identity. Legacy cards with unknown validation become validated here.
      if (!contentChanged) {
        for (const artifact of Object.values(source.artifacts || {})) {
          if (artifact && !artifact.contentHash) artifact.contentHash = contentHash;
          if (artifact) artifact.validationStatus = "validated";
        }
      }

      const artifactBase = sourceArtifactBase(source.sourceId, contentHash);
      let paperArtifact = null;
      if (needsPaper) {
        if (artifactMatches(source.artifacts?.paperText)) {
          paperArtifact = await this.workspace.readJson(source.artifacts.paperText.path);
        } else {
          if (typeof this.parsePaper !== "function") {
            throw new SourceSystemError("PDF_PARSER_MISSING", "No PDF parser is configured.");
          }
          await report({ stage: "parsing", completed: 0, total: 1 });
          this.metrics.paperParseCalls += 1;
          const parseStarted = Date.now();
          const extracted = await this.parsePaper({ source, file: firstFile, bytes, signal: requestContext.signal });
          paperArtifact = paperArtifactFromExtraction(source, extracted, requestContext);
          this.metrics.paperParseDurationMs += Date.now() - parseStarted;
          const indexStarted = Date.now();
          const path = `${artifactBase}/paper-text.json`;
          await this.workspace.writeJson(path, paperArtifact);
          this.metrics.indexDurationMs += Date.now() - indexStarted;
          source.artifacts.paperText = {
            path,
            contentHash,
            extractorVersion: SOURCE_EXTRACTOR_VERSION,
            schemaVersion: SOURCE_ARTIFACT_SCHEMA_VERSION,
            validationStatus: "validated",
          };
        }
        source.parseStatus = "ready";
        source.indexStatus = "ready";
      }

      if (needsExperiment) {
        if (!artifactMatches(source.artifacts?.experimentData)) {
          await report({ stage: "normalizing", completed: 0, total: 1 });
          this.metrics.experimentParseCalls += 1;
          const parseStarted = Date.now();
          const normalized = parseExperimentBytes(source, bytes, this.spreadsheetProvider);
          this.metrics.experimentParseDurationMs += Date.now() - parseStarted;
          const path = `${artifactBase}/experiment-data.json`;
          await this.workspace.writeJson(path, normalized);
          source.artifacts.experimentData = {
            path,
            contentHash,
            normalizerVersion: EXPERIMENT_NORMALIZER_VERSION,
            schemaVersion: SOURCE_ARTIFACT_SCHEMA_VERSION,
            validationStatus: "validated",
          };
        }
        source.structuredDataStatus = "ready";
      }

      if (capability === "paper_card") {
        if (!artifactMatches(source.artifacts?.paperCard)) {
          if (typeof this.generatePaperCard !== "function") {
            throw new SourceSystemError("PAPER_CARD_GENERATOR_MISSING", "No Paper Card generator is configured.");
          }
          await report({ stage: "paper-card", completed: 0, total: 1 });
          this.metrics.paperCardCalls += 1;
          const cardStarted = Date.now();
          const generated = await this.generatePaperCard({
            source,
            paperArtifact,
            contentHash,
            signal: requestContext.signal,
            onProgress: requestContext.onProgress,
          });
          this.metrics.paperCardDurationMs += Date.now() - cardStarted;
          source.artifacts.paperCard = {
            path: generated.path,
            contentHash,
            schemaVersion: generated.schemaVersion || 1,
            model: generated.model || null,
            promptVersion: generated.promptVersion || 1,
            validationStatus: "validated",
          };
        }
        source.paperCardStatus = "ready";
      }

      const finalFile = await this.readCurrentFile(source);
      if (
        Number(finalFile.size) !== Number(firstFile.size) ||
        Number(finalFile.lastModified) !== Number(firstFile.lastModified)
      ) {
        Object.assign(source, previousDerivedState);
        source.catalogStatus = "dirty";
        source.hashStatus = source.contentHash ? "dirty" : "absent";
        source.error = {
          code: "SOURCE_CHANGED_DURING_PREPARATION",
          message: "The source changed while it was being prepared; the result was rejected.",
        };
        if (needsPaper && source.parseStatus === "ready") source.parseStatus = "stale";
        if (needsPaper && source.indexStatus === "ready") source.indexStatus = "stale";
        if (needsExperiment && source.structuredDataStatus === "ready") {
          source.structuredDataStatus = "stale";
        }
        await this.registry.persist();
        throw new SourceSystemError(
          "SOURCE_CHANGED_DURING_PREPARATION",
          "The source changed while it was being prepared. Retry after the copy or edit finishes."
        );
      }

      source.sizeBytes = Number(finalFile.size) || 0;
      source.mtimeNs = Number(finalFile.lastModified) || 0;
      source.statSignature = statSignatureFor({
        relativePath: source.path,
        size: finalFile.size,
        lastModified: finalFile.lastModified,
        filesystemFileId: source.filesystemFileId,
      });
      source.lastUsedAt = nowIso(this.now);
      await this.registry.persist();
      console.info("source_readiness_transition", {
        sourceId: source.sourceId,
        sourceKind: source.sourceKind,
        capability,
        durationMs: Date.now() - preparationStarted,
        hashBytes: hashBytesRead,
        hashPerformed: needsHash,
        hashDurationMs: this.metrics.hashDurationMs - metricsBefore.hashDurationMs,
        parseDurationMs:
          this.metrics.paperParseDurationMs - metricsBefore.paperParseDurationMs +
          this.metrics.experimentParseDurationMs - metricsBefore.experimentParseDurationMs,
        indexDurationMs: this.metrics.indexDurationMs - metricsBefore.indexDurationMs,
        paperCardDurationMs:
          this.metrics.paperCardDurationMs - metricsBefore.paperCardDurationMs,
        contentChanged,
        cacheHit: false,
      });
      return source;
    }

    async readPaperArtifact(sourceId) {
      const source = this.registry.get(sourceId);
      const artifact = source?.artifacts?.paperText;
      if (!artifact?.path || artifact.contentHash !== source.contentHash) {
        throw new SourceSystemError("PAPER_TEXT_NOT_READY", "Parsed paper text is not ready.");
      }
      return this.workspace.readJson(artifact.path);
    }

    async readExperimentArtifact(sourceId) {
      const source = this.registry.get(sourceId);
      const artifact = source?.artifacts?.experimentData;
      if (!artifact?.path || artifact.contentHash !== source.contentHash) {
        throw new SourceSystemError("EXPERIMENT_DATA_NOT_READY", "Normalized experiment data is not ready.");
      }
      return this.workspace.readJson(artifact.path);
    }
  }

  class LiteratureTools {
    constructor(options) {
      this.registry = options.registry;
      this.preparation = options.preparation;
      this.results = options.results || this.preparation.results;
    }

    paperMetadata(source) {
      const discovery = source.legacy?.discovery || {};
      return {
        paperId: source.sourceId,
        sourceId: source.sourceId,
        fileName: source.displayName,
        relativePath: source.path,
        title: discovery.title || null,
        authors: Array.isArray(discovery.authors) ? discovery.authors : [],
        year: Number.isInteger(discovery.year) ? discovery.year : null,
        topics: Array.isArray(discovery.topics) ? discovery.topics : [],
        keywords: Array.isArray(discovery.keywords) ? discovery.keywords : [],
        identifiers: Array.isArray(discovery.identifiers) ? discovery.identifiers : [],
        readiness: {
          catalog: source.catalogStatus,
          hash: source.hashStatus,
          text: source.parseStatus,
          search: source.indexStatus,
          paperCard: source.paperCardStatus,
        },
      };
    }

    async listPapers(options = {}) {
      let papers = this.registry.list({ sourceKind: "paper" });
      if (Array.isArray(options.paperIds)) {
        const ids = new Set(options.paperIds);
        papers = papers.filter((source) => ids.has(source.sourceId));
      }
      if (options.readiness) {
        papers = papers.filter((source) =>
          options.readiness === "search" ? source.indexStatus === "ready" :
            options.readiness === "paper_card" ? source.paperCardStatus === "ready" : true
        );
      }
      return this.results.compact(papers.map((source) => this.paperMetadata(source)), {
        tool: "list_papers",
      });
    }

    async resolvePapers(input = {}) {
      const terms = uniqueStrings([
        ...asList(input.names),
        ...asList(input.titles),
        ...asList(input.authors),
        ...asList(input.filenames),
        ...asList(input.years).map(String),
      ]);
      const query = terms.join(" ");
      const ranked = this.registry
        .list({ sourceKind: "paper" })
        .map((source) => {
          const metadata = this.paperMetadata(source);
          const searchable = [
            metadata.fileName,
            metadata.title,
            metadata.authors.join(" "),
            metadata.year,
            metadata.topics.join(" "),
            metadata.keywords.join(" "),
            metadata.identifiers.join(" "),
          ].join(" ");
          return { ...metadata, score: scoreText(searchable, query) };
        })
        .filter((item) => item.score > 0)
        .sort((left, right) => right.score - left.score || left.fileName.localeCompare(right.fileName));
      return ranked.slice(0, Number(input.topK) || 10);
    }

    async searchPapers(query, options = {}) {
      query = expandAliases(query, this.registry.aliases);
      const allowed = Array.isArray(options.paperIds) ? new Set(options.paperIds) : null;
      const metadata = this.registry
        .list({ sourceKind: "paper" })
        .filter((source) => !allowed || allowed.has(source.sourceId))
        .map((source) => {
          const item = this.paperMetadata(source);
          const text = [
            item.fileName,
            item.title,
            item.authors.join(" "),
            item.year,
            item.topics.join(" "),
            item.keywords.join(" "),
            item.identifiers.join(" "),
          ].join(" ");
          return { source, item, score: scoreText(text, query) };
        });
      const readyResults = [];
      for (const candidate of metadata.filter(({ source }) => source.indexStatus === "ready")) {
        try {
          const artifact = await this.preparation.readPaperArtifact(candidate.source.sourceId);
          const best = artifact.chunks
            .map((chunk) => ({ chunk, score: scoreText(chunk.text, query) }))
            .sort((left, right) => right.score - left.score)[0];
          const score = candidate.score + (best?.score || 0);
          if (score > 0) {
            readyResults.push({
              ...candidate.item,
              score,
              evidenceHandle: best?.chunk?.chunkId || null,
              page: best?.chunk?.page || null,
              snippet: String(best?.chunk?.text || "").slice(0, 500),
              searchable: true,
            });
          }
        } catch (error) {
          delete candidate.source.artifacts.paperText;
          candidate.source.parseStatus = "failed";
          candidate.source.indexStatus = "failed";
          candidate.source.error = compactError(error);
          await this.registry.persist();
        }
      }
      const metadataOnly = metadata
        .filter(({ source, score }) => source.indexStatus !== "ready" && score > 0)
        .map(({ item, score }) => ({ ...item, score, searchable: false, snippet: "" }));
      const combined = [...readyResults, ...(options.includeUnpreparedMetadata === false ? [] : metadataOnly)]
        .sort((left, right) => right.score - left.score)
        .slice(0, Math.min(50, Number(options.topK) || 10));
      return {
        results: combined,
        coverage: {
          papersDiscovered: metadata.length,
          papersSearchable: metadata.filter(({ source }) => source.indexStatus === "ready").length,
          papersMetadataOnly: metadata.filter(({ source }) => source.indexStatus !== "ready").length,
          papersActuallyConsidered: combined.map((item) => item.paperId),
        },
      };
    }

    async searchPaperContent(paperId, query, options = {}) {
      query = expandAliases(query, this.registry.aliases);
      await this.preparation.ensureSourceReady([paperId], "search", options);
      const source = this.registry.get(paperId);
      const artifact = await this.preparation.readPaperArtifact(source.sourceId);
      const results = artifact.chunks
        .filter((chunk) =>
          !Array.isArray(options.sectionFilters) ||
          !options.sectionFilters.length ||
          options.sectionFilters.includes(chunk.section)
        )
        .map((chunk) => ({
          paperId: source.sourceId,
          title: source.legacy?.discovery?.title || source.displayName,
          page: chunk.page,
          section: chunk.section,
          chunkId: chunk.chunkId,
          snippet: chunk.text.slice(0, 900),
          score: scoreText(chunk.text, query),
        }))
        .filter((item) => item.score > 0)
        .sort((left, right) => right.score - left.score)
        .slice(0, Math.min(30, Number(options.topK) || 8));
      return this.results.compact(results, { tool: "search_paper_content", paperId });
    }

    async readPaperEvidence(paperId, options = {}) {
      await this.preparation.ensureSourceReady([paperId], "full_text", options);
      const artifact = await this.preparation.readPaperArtifact(paperId);
      const chunkIds = new Set(options.chunkIds || []);
      const pages = new Set((options.pages || []).map(Number));
      const sections = new Set(options.sections || []);
      let evidence = artifact.chunks.filter((chunk) =>
        (!chunkIds.size && !pages.size && !sections.size) ||
        chunkIds.has(chunk.chunkId) ||
        pages.has(chunk.page) ||
        sections.has(chunk.section)
      );
      evidence = evidence.slice(0, Math.min(40, Number(options.limit) || 12)).map((chunk) => ({
        paperId,
        evidenceHandle: `${paperId}:p${chunk.page}:${chunk.chunkId}`,
        page: chunk.page,
        section: chunk.section,
        text: chunk.text,
      }));
      return this.results.compact(evidence, { tool: "read_paper_evidence", paperId });
    }

    async searchPaperTablesFigures(paperId, query, options = {}) {
      return this.searchPaperContent(
        paperId,
        `${query || ""} table figure supplementary`.trim(),
        { ...options, topK: options.topK || 12 }
      );
    }

    async ensurePaperCard(paperId, options = {}) {
      return this.preparation.ensureSourceReady([paperId], "paper_card", options);
    }
  }

  function recordMatchesFilters(record, options = {}) {
    const rawText = JSON.stringify(record.raw || {}).toLowerCase();
    const check = (values, candidates) => {
      const required = uniqueStrings(Array.isArray(values) ? values : values ? [values] : []);
      if (!required.length) return true;
      const haystack = `${rawText} ${(candidates || []).join(" ")}`.toLowerCase();
      return required.some((value) => haystack.includes(value.toLowerCase()));
    };
    const rawEntries = Object.entries(record.raw || {});
    const metricMatches = !options.metric || rawEntries.some(([key]) =>
      key.toLowerCase().includes(String(options.metric).toLowerCase())
    );
    const conditionMatches = !options.conditionFilters || Object.entries(
      options.conditionFilters
    ).every(([requestedKey, requestedValue]) => {
      const match = rawEntries.find(
        ([key]) => key.toLowerCase() === String(requestedKey).toLowerCase()
      );
      if (!match) return false;
      const allowed = Array.isArray(requestedValue) ? requestedValue : [requestedValue];
      return allowed.some(
        (value) => String(match[1]).toLowerCase() === String(value).toLowerCase()
      );
    });
    return (
      check(options.proteins, record.entities?.proteins) &&
      check(options.genes, record.entities?.genes) &&
      check(options.mutations, record.entities?.mutations) &&
      check(options.strains, record.entities?.strains) &&
      metricMatches &&
      conditionMatches &&
      (!options.query || scoreText(rawText, options.query) > 0)
    );
  }

  class ExperimentTools {
    constructor(options) {
      this.registry = options.registry;
      this.preparation = options.preparation;
      this.results = options.results || this.preparation.results;
    }

    async listExperimentSources(options = {}) {
      let sources = this.registry.list({ sourceKind: "experiment" });
      if (Array.isArray(options.sourceIds)) {
        const ids = new Set(options.sourceIds);
        sources = sources.filter((source) => ids.has(source.sourceId));
      }
      return sources.map((source) => ({
        sourceId: source.sourceId,
        displayName: source.displayName,
        relativePath: source.path,
        extension: source.extension,
        readiness: source.structuredDataStatus,
        hashStatus: source.hashStatus,
      }));
    }

    async queryExperimentResults(options = {}) {
      const ids = Array.isArray(options.experimentSourceIds) && options.experimentSourceIds.length
        ? uniqueStrings(options.experimentSourceIds)
        : this.registry
            .list({ sourceKind: "experiment" })
            .filter(
              (source) =>
                options.readyOnly !== true || source.structuredDataStatus === "ready"
            )
            .map((source) => source.sourceId);
      if (!ids.length) return [];
      const readiness = await this.preparation.ensureSourceReady(
        ids,
        "experiment_data",
        options
      );
      const readyIds = readiness.sources
        .filter((result) => result?.failed !== true)
        .map((result) => result.sourceId);
      const records = [];
      for (const sourceId of readyIds) {
        const artifact = await this.preparation.readExperimentArtifact(sourceId);
        for (const record of artifact.records || []) {
          if (recordMatchesFilters(record, options)) records.push(record);
        }
      }
      return this.results.compact(records.slice(0, Number(options.limit) || 500), {
        tool: "query_experiment_results",
        sourceIds: readyIds,
        failures: readiness.failures,
      });
    }

    async searchExperiments(query, options = {}) {
      const matched = await this.queryExperimentResults({
        ...options,
        query: expandAliases(query, this.registry.aliases),
      });
      const matchedRecords = matched?.resultHandle
        ? await this.results.read(matched.resultHandle)
        : matched;
      if (Array.isArray(matchedRecords) && matchedRecords.length) return matched;
      if (options.fallbackToAll === false) return matched;
      return this.queryExperimentResults({ ...options, query: "" });
    }

    async compareExperimentGroups(groupA, groupB, metric, aggregation = "mean") {
      const resolve = async (group) => {
        const result = await this.queryExperimentResults(group || {});
        const records = result?.resultHandle ? await this.results.read(result.resultHandle) : result;
        const values = records
          .map((record) => {
            const entry = Object.entries(record.raw || {}).find(
              ([key]) => key.toLowerCase() === String(metric || "").toLowerCase()
            );
            return Number(entry?.[1]);
          })
          .filter(Number.isFinite);
        const units = uniqueStrings(
          records.flatMap((record) =>
            Object.entries(record.raw || {})
              .filter(([key]) => /unit/i.test(key))
              .map(([, value]) => String(value))
          )
        );
        const sum = values.reduce((total, value) => total + value, 0);
        return {
          count: values.length,
          aggregation,
          value: aggregation === "sum" ? sum : values.length ? sum / values.length : null,
          min: values.length ? Math.min(...values) : null,
          max: values.length ? Math.max(...values) : null,
          metric,
          units,
        };
      };
      const resolvedA = await resolve(groupA);
      const resolvedB = await resolve(groupB);
      const allUnits = uniqueStrings([...resolvedA.units, ...resolvedB.units]);
      return {
        groupA: resolvedA,
        groupB: resolvedB,
        comparable: allUnits.length <= 1,
        unitWarning:
          allUnits.length > 1
            ? `Groups contain multiple units (${allUnits.join(", ")}); no conversion was applied.`
            : null,
      };
    }

    async readExperimentSource(sourceId, options = {}) {
      await this.preparation.ensureSourceReady([sourceId], "experiment_data", options);
      const artifact = await this.preparation.readExperimentArtifact(sourceId);
      let selected = options.sheet
        ? artifact.sheets.filter((sheet) => sheet.name === options.sheet)
        : artifact.sheets;
      if (options.range) {
        const range = parseSpreadsheetRange(options.range);
        if (!range) {
          throw new SourceSystemError(
            "INVALID_EXPERIMENT_RANGE",
            "Experiment ranges must use A1 or A1:C20 notation."
          );
        }
        selected = selected.map((sheet) => ({
          name: sheet.name,
          range: options.range,
          rows: (sheet.rows || [])
            .slice(range.startRow, range.endRow + 1)
            .map((row) => row.slice(range.startColumn, range.endColumn + 1)),
        }));
      }
      return this.results.compact(selected, { tool: "read_experiment_source", sourceId });
    }
  }

  class CorpusWorkflowService {
    constructor(options) {
      this.workspace = options.workspace;
      this.registry = options.registry;
      this.preparation = options.preparation;
      this.literatureTools = options.literatureTools;
      this.results = options.results || this.preparation.results;
      this.now = options.now || (() => new Date());
      this.mapWorker = options.mapWorker || null;
    }

    workflowId(question, sourceIds) {
      return `summarize-paper-corpus-${stableStringHash([
        CORPUS_WORKFLOW_VERSION,
        question,
        [...sourceIds].sort().join(","),
      ].join("|"))}`;
    }

    async run(question, options = {}) {
      const sources = this.registry.list({ sourceKind: "paper" });
      const sourceIds = sources.map((source) => source.sourceId);
      const workflowId = this.workflowId(question, sourceIds);
      const path = `${WORKFLOW_DIRECTORY}/${workflowId}.json`;
      const workflowIndexPath = `${WORKFLOW_DIRECTORY}/corpus-index.json`;
      const questionKey = stableStringHash(String(question || ""));
      const workflowIndex = await this.workspace.fileExists(workflowIndexPath)
        ? await this.workspace.readJson(workflowIndexPath)
        : { schemaVersion: 1, byQuestion: {} };
      const previousWorkflowId = workflowIndex.byQuestion?.[questionKey];
      if (previousWorkflowId && previousWorkflowId !== workflowId) {
        const previousPath = `${WORKFLOW_DIRECTORY}/${previousWorkflowId}.json`;
        if (await this.workspace.fileExists(previousPath)) {
          const previousJournal = await this.workspace.readJson(previousPath);
          previousJournal.status = "stale";
          previousJournal.staleReason = "corpus_membership_changed";
          previousJournal.updatedAt = nowIso(this.now);
          await this.workspace.writeJson(previousPath, previousJournal);
        }
      }
      workflowIndex.byQuestion = {
        ...(workflowIndex.byQuestion || {}),
        [questionKey]: workflowId,
      };
      workflowIndex.updatedAt = nowIso(this.now);
      await this.workspace.writeJson(workflowIndexPath, workflowIndex);
      let journal = null;
      if (await this.workspace.fileExists(path)) journal = await this.workspace.readJson(path);
      if (!journal) {
        journal = {
          schemaVersion: 1,
          workflowVersion: CORPUS_WORKFLOW_VERSION,
          workflowId,
          workflowType: "summarize-paper-corpus",
          question: String(question || "Summarize the paper corpus."),
          status: "running",
          phase: "snapshot",
          snapshot: sources.map((source) => ({
            sourceId: source.sourceId,
            statSignature: source.statSignature,
            contentHash: source.contentHash,
          })),
          maps: {},
          failures: {},
          groups: [],
          reduction: null,
          verification: [],
          createdAt: nowIso(this.now),
          updatedAt: nowIso(this.now),
        };
      }
      journal.status = "running";
      journal.completedAt = null;
      journal.snapshot = sources.map((source) => ({
        sourceId: source.sourceId,
        statSignature: source.statSignature,
        contentHash: source.contentHash,
      }));
      const persist = async () => {
        journal.updatedAt = nowIso(this.now);
        await this.workspace.writeJson(path, journal);
        options.onProgress?.({
          workflowId,
          phase: journal.phase,
          completed: Object.keys(journal.maps).length + Object.keys(journal.failures).length,
          total: sourceIds.length,
        });
      };
      await persist();

      journal.phase = "prepare";
      await persist();
      await runBounded(sourceIds, Math.min(2, Number(options.concurrency) || 2), async (sourceId) => {
        const source = this.registry.get(sourceId);
        const completed = journal.maps[sourceId];
        const mapCachePath = `${WORKFLOW_DIRECTORY}/maps/${sourceId}/${stableStringHash(journal.question)}.json`;
        if (
          completed &&
          completed.contentHash &&
          source.contentHash === completed.contentHash &&
          source.statSignature === completed.statSignature
        ) return;
        try {
          await this.preparation.ensureSourceReady([sourceId], "search", options);
          const readySource = this.registry.get(sourceId) || this.registry.records.find((item) => item.sourceId === sourceId);
          const snapshotEntry = journal.snapshot.find(
            (entry) => entry.sourceId === sourceId
          );
          if (snapshotEntry) {
            snapshotEntry.contentHash = readySource.contentHash;
            snapshotEntry.statSignature = readySource.statSignature;
          }
          if (await this.workspace.fileExists(mapCachePath)) {
            const cachedMap = await this.workspace.readJson(mapCachePath);
            if (
              cachedMap.contentHash === readySource.contentHash &&
              cachedMap.question === journal.question &&
              Number(cachedMap.workflowVersion) === CORPUS_WORKFLOW_VERSION &&
              Number(cachedMap.mapSchemaVersion) === CORPUS_MAP_SCHEMA_VERSION &&
              cachedMap.mapPromptVersion === CORPUS_MAP_PROMPT_VERSION &&
              (!options.mapModelVersion ||
                cachedMap.mapModelVersion === options.mapModelVersion)
            ) {
              journal.maps[sourceId] = cachedMap.result;
              delete journal.failures[sourceId];
              await persist();
              return;
            }
          }
          journal.phase = "map";
          const search = await this.literatureTools.searchPaperContent(
            readySource.sourceId,
            journal.question,
            { topK: 8, signal: options.signal }
          );
          let evidence = search?.resultHandle ? await this.results.read(search.resultHandle) : search;
          if (!Array.isArray(evidence) || !evidence.length) {
            const fallbackEvidence = await this.literatureTools.readPaperEvidence(
              readySource.sourceId,
              { limit: 8, signal: options.signal }
            );
            const rows = fallbackEvidence?.resultHandle
              ? await this.results.read(fallbackEvidence.resultHandle)
              : fallbackEvidence;
            evidence = (rows || []).map((item) => ({
              snippet: item.text,
              page: item.page,
              chunkId: String(item.evidenceHandle || "").split(":").at(-1),
            }));
          }
          const workerInput = {
            paperId: readySource.sourceId,
            contentHash: readySource.contentHash,
            question: journal.question,
            evidence: (evidence || []).map((item) => ({
              claimCandidate: item.snippet,
              evidenceRef: `${readySource.sourceId}:p${item.page}:${item.chunkId}`,
            })),
          };
          // Each mapper receives only this bounded object: no parent conversation or
          // accumulated tool history enters the worker context.
          const mapped = this.mapWorker
            ? await this.mapWorker(workerInput, { signal: options.signal })
            : {
                paperId: readySource.sourceId,
                contentHash: readySource.contentHash,
                relevance: workerInput.evidence.length ? "high" : "low",
                themes: tokenize(journal.question).slice(0, 8),
                findings: workerInput.evidence.slice(0, 6).map((item) => ({
                  claim: item.claimCandidate.slice(0, 900),
                  evidenceRefs: [item.evidenceRef],
                })),
                methods: [],
                limitations: [],
              };
          const normalizedMap = normalizeCorpusMapResult(mapped, workerInput);
          journal.maps[sourceId] = {
            ...normalizedMap,
            statSignature: readySource.statSignature,
          };
          await this.workspace.writeJson(mapCachePath, {
            schemaVersion: 1,
            workflowVersion: CORPUS_WORKFLOW_VERSION,
            mapSchemaVersion: CORPUS_MAP_SCHEMA_VERSION,
            mapPromptVersion: CORPUS_MAP_PROMPT_VERSION,
            mapModelVersion: normalizedMap.modelVersion,
            question: journal.question,
            sourceId,
            contentHash: readySource.contentHash,
            result: journal.maps[sourceId],
            updatedAt: nowIso(this.now),
          });
          delete journal.failures[sourceId];
        } catch (error) {
          if (error?.code === "OPERATION_ABORTED") {
            journal.status = "paused";
            await persist();
            throw error;
          }
          journal.failures[sourceId] = compactError(error);
        }
        await persist();
      });

      journal.phase = "group";
      const themeGroups = new Map();
      for (const mapped of Object.values(journal.maps)) {
        for (const theme of mapped.themes || ["other"]) {
          const group = themeGroups.get(theme) || [];
          group.push(mapped.paperId);
          themeGroups.set(theme, group);
        }
      }
      journal.groups = [...themeGroups].map(([theme, paperIds]) => ({ theme, paperIds }));
      await persist();

      journal.phase = "reduce";
      const topicFindings = journal.groups.map((group) => ({
        theme: group.theme,
        paperIds: group.paperIds,
        findings: group.paperIds.flatMap(
          (paperId) => journal.maps[paperId]?.findings || []
        ),
      }));
      journal.reduction = {
        papersIncluded: Object.keys(journal.maps).length,
        papersFailed: Object.keys(journal.failures).length,
        themes: journal.groups,
        topicFindings,
        findings: Object.values(journal.maps).flatMap((mapped) => mapped.findings || []),
      };
      await persist();

      journal.phase = "verify";
      journal.verification = await runBounded(
        journal.reduction.findings.slice(0, 20),
        Math.min(2, Number(options.concurrency) || 2),
        async (finding) => {
          const located = [];
          for (const reference of finding.evidenceRefs || []) {
            const separator = String(reference).indexOf(":p");
            const paperId = separator > 0 ? String(reference).slice(0, separator) : "";
            const chunkId = String(reference).split(":").at(-1);
            if (!paperId || !chunkId) continue;
            try {
              const read = await this.literatureTools.readPaperEvidence(paperId, {
                chunkIds: [chunkId],
                limit: 1,
                signal: options.signal,
              });
              const evidence = read?.resultHandle
                ? await this.results.read(read.resultHandle)
                : read;
              if (Array.isArray(evidence) && evidence.length) {
                located.push({
                  evidenceRef: reference,
                  page: evidence[0].page,
                  excerpt: String(evidence[0].text || "").slice(0, 600),
                });
              }
            } catch {
              // The failed reference is retained below as unlocated evidence.
            }
          }
          return {
            claim: finding.claim,
            evidenceRefs: finding.evidenceRefs,
            locatedEvidence: located,
            status: located.length ? "original-evidence-located" : "unverified",
          };
        }
      );
      journal.phase = "persist";
      journal.status = "completed";
      journal.completedAt = nowIso(this.now);
      journal.cacheKey = stableStringHash([
        CORPUS_WORKFLOW_VERSION,
        journal.question,
        Object.values(journal.maps)
          .map((mapped) => `${mapped.paperId}:${mapped.contentHash}`)
          .sort()
          .join("|"),
        SOURCE_ARTIFACT_SCHEMA_VERSION,
        CORPUS_MAP_SCHEMA_VERSION,
        CORPUS_MAP_PROMPT_VERSION,
        uniqueStrings(
          Object.values(journal.maps).map((mapped) => mapped.modelVersion)
        ).sort().join("|"),
      ].join("|"));
      await persist();
      console.info("corpus_workflow_completed", {
        workflowId,
        papersIncluded: journal.reduction.papersIncluded,
        papersFailed: journal.reduction.papersFailed,
        verifiedClaims: journal.verification.filter(
          (item) => item.status === "original-evidence-located"
        ).length,
      });
      return this.results.compact(journal, {
        tool: "summarize_paper_corpus",
        workflowId,
        journalPath: path,
      });
    }
  }

  function createSourceSystem(options) {
    const registry = options.registry || new SourceRegistry(options);
    const jobs = options.jobs || new SourceJobManager(options);
    const results = options.results || new SourceResultStore(options);
    const preparation = options.preparation || new SourcePreparationService({
      ...options,
      registry,
      jobs,
      results,
    });
    const literatureTools = new LiteratureTools({ registry, preparation, results });
    const experimentTools = new ExperimentTools({ registry, preparation, results });
    const corpusWorkflows = new CorpusWorkflowService({
      ...options,
      registry,
      preparation,
      results,
      literatureTools,
    });
    return { registry, jobs, results, preparation, literatureTools, experimentTools, corpusWorkflows };
  }

  return {
    ARTIFACT_DIRECTORY,
    CORPUS_WORKFLOW_VERSION,
    CorpusWorkflowService,
    DEFAULT_ENTITY_ALIASES,
    EXPERIMENT_NORMALIZER_VERSION,
    ExperimentTools,
    JOB_PATH,
    LARGE_RESULT_CHARACTERS,
    LiteratureTools,
    READINESS_CAPABILITIES,
    RESULT_DIRECTORY,
    SOURCE_ARTIFACT_SCHEMA_VERSION,
    SOURCE_EXTRACTOR_VERSION,
    SOURCE_PATH,
    SOURCE_REGISTRY_SCHEMA_VERSION,
    SourceJobManager,
    SourcePreparationService,
    SourceRegistry,
    SourceResultStore,
    SourceSystemError,
    createSourceSystem,
    extensionFor,
    expandAliases,
    flattenTree,
    hashBytes,
    normalizePath,
    paperArtifactFromExtraction,
    parseDelimited,
    parseExperimentBytes,
    runBounded,
    scoreText,
    sourceKindFor,
    statSignatureFor,
  };
});
