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
  const CORPUS_WORKFLOW_VERSION = 2;
  const CORPUS_MAP_SCHEMA_VERSION = 2;
  const CORPUS_MAP_PROMPT_VERSION = "query-specific-map-v2";
  const NATIVE_PDF_PROMPT_VERSION = "requesty-native-pdf-v1";
  const DEFAULT_CORPUS_PREPARE_CONCURRENCY = 2;
  const DEFAULT_CORPUS_MAP_CONCURRENCY = 2;
  const DEFAULT_CORPUS_MAP_ATTEMPTS = 3;
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
  const ToolEffect = Object.freeze({
    INFORMATIONAL: "informational",
    INTERNAL_STATE: "internal_state",
    RESULT_PRODUCING: "result_producing",
    DESTRUCTIVE_SOURCE: "destructive_source",
    EXTERNAL_SIDE_EFFECT: "external_side_effect",
  });
  const TOOL_EFFECTS = Object.freeze({
    list_papers: ToolEffect.INFORMATIONAL,
    search_papers: ToolEffect.INFORMATIONAL,
    search_paper_content: ToolEffect.INTERNAL_STATE,
    read_paper_evidence: ToolEffect.INTERNAL_STATE,
    read_paper_pages: ToolEffect.INTERNAL_STATE,
    ensure_source_ready: ToolEffect.INTERNAL_STATE,
    ensure_paper_card: ToolEffect.INTERNAL_STATE,
    analyze_pdf_native: ToolEffect.INTERNAL_STATE,
    list_experiment_sources: ToolEffect.INFORMATIONAL,
    query_experiment_results: ToolEffect.INTERNAL_STATE,
    read_experiment_source: ToolEffect.INTERNAL_STATE,
    refresh_project_metadata: ToolEffect.INTERNAL_STATE,
    update_project_memory: ToolEffect.INTERNAL_STATE,
    update_active_state: ToolEffect.INTERNAL_STATE,
    get_corpus_workflow_status: ToolEffect.INFORMATIONAL,
    retry_corpus_map_failures: ToolEffect.INTERNAL_STATE,
    resume_corpus_workflow: ToolEffect.INTERNAL_STATE,
    get_local_worker_status: ToolEffect.INTERNAL_STATE,
    restart_local_worker: ToolEffect.INTERNAL_STATE,
    create_corpus_synthesis_artifact: ToolEffect.INTERNAL_STATE,
    update_recommendation: ToolEffect.RESULT_PRODUCING,
  });

  class SourceSystemError extends Error {
    constructor(code, message, cause = null) {
      super(message, cause ? { cause } : undefined);
      this.name = "SourceSystemError";
      this.code = code;
      if (cause && !this.cause) this.cause = cause;
    }
  }

  function authorizeTool(surface, toolNameOrEffect) {
    const normalizedSurface = surface === "agent_command" ? "agent_command" : "side_chat";
    const effect = Object.values(ToolEffect).includes(toolNameOrEffect)
      ? toolNameOrEffect
      : TOOL_EFFECTS[toolNameOrEffect];
    if (!effect) {
      return {
        allowed: false,
        effect: null,
        reason: "The requested tool is not registered.",
        requiredSurface: null,
      };
    }
    const allowed = normalizedSurface === "side_chat"
      ? [ToolEffect.INFORMATIONAL, ToolEffect.INTERNAL_STATE].includes(effect)
      : [
          ToolEffect.INFORMATIONAL,
          ToolEffect.INTERNAL_STATE,
          ToolEffect.RESULT_PRODUCING,
        ].includes(effect);
    return {
      allowed,
      effect,
      reason: allowed
        ? "The tool effect is allowed on this surface."
        : effect === ToolEffect.RESULT_PRODUCING
          ? "Side Chat may update internal project state but may not change the current recommendation."
          : effect === ToolEffect.DESTRUCTIVE_SOURCE
            ? "Destructive source operations require an explicit protected workflow."
            : "External side effects require an explicit protected workflow.",
      requiredSurface:
        !allowed && effect === ToolEffect.RESULT_PRODUCING ? "agent_command" : null,
    };
  }

  function requireAuthorizedTool(surface, toolName) {
    const authorization = authorizeTool(surface, toolName);
    if (!authorization.allowed) {
      const error = new SourceSystemError("TOOL_NOT_AUTHORIZED", authorization.reason);
      error.authorization = authorization;
      throw error;
    }
    return authorization;
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

  function normalizeSynthesisQuestion(value) {
    return String(value || "")
      .normalize("NFKC")
      .toLowerCase()
      .replace(/[\s\u00a0]+/g, " ")
      .replace(/[.!?。！？]+$/g, "")
      .trim();
  }

  function normalizeCorpusMapResult(mapped, workerInput) {
    const allowedEvidenceRefs = new Set(
      workerInput.evidence.map((item) => item.evidenceRef)
    );
    const findingsInput = Array.isArray(mapped?.majorFindings)
      ? mapped.majorFindings
      : Array.isArray(mapped?.major_findings)
        ? mapped.major_findings
        : Array.isArray(mapped?.findings)
          ? mapped.findings
          : [];
    const findings = findingsInput
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
      title: String(mapped?.title || workerInput.title || "").trim().slice(0, 500),
      relevance: ["high", "medium", "low", "none"].includes(mapped?.relevance)
        ? mapped.relevance
        : findings.length
          ? "medium"
          : "none",
      themes: uniqueStrings(asList(mapped?.themes), 20),
      researchQuestion: String(
        mapped?.researchQuestion || mapped?.research_question || ""
      ).trim().slice(0, 1200),
      findings,
      majorFindings: findings,
      methods: uniqueStrings(asList(mapped?.methods), 30),
      organisms: uniqueStrings(asList(mapped?.organisms), 30),
      genes: uniqueStrings(asList(mapped?.genes), 30),
      proteins: uniqueStrings(asList(mapped?.proteins), 30),
      pathways: uniqueStrings(asList(mapped?.pathways), 30),
      experimentalStrategies: uniqueStrings(
        asList(mapped?.experimentalStrategies || mapped?.experimental_strategies),
        30
      ),
      limitations: uniqueStrings(asList(mapped?.limitations), 30),
      connectionsToOtherTopics: uniqueStrings(
        asList(mapped?.connectionsToOtherTopics || mapped?.connections_to_other_topics),
        30
      ),
      notes:
        mapped?.notes === null
          ? null
          : String(mapped?.notes || "").trim().slice(0, 2000) || null,
      usedPaperCard: workerInput.paperCard ? true : false,
    };
  }

  function corpusMapValidationErrors(mapped) {
    const errors = [];
    if (!mapped || typeof mapped !== "object" || Array.isArray(mapped)) {
      return ["Mapper output must be one JSON object."];
    }
    if (!["high", "medium", "low", "none"].includes(mapped.relevance)) {
      errors.push("relevance must be high, medium, low, or none.");
    }
    const findings = Array.isArray(mapped.majorFindings)
      ? mapped.majorFindings
      : Array.isArray(mapped.major_findings)
        ? mapped.major_findings
        : Array.isArray(mapped.findings)
          ? mapped.findings
          : null;
    if (!findings) {
      errors.push("majorFindings/findings must be an array.");
    } else {
      findings.slice(0, 20).forEach((finding, index) => {
        if (!finding || typeof finding !== "object" || Array.isArray(finding)) {
          errors.push(`finding ${index + 1} must be an object.`);
          return;
        }
        if (!String(finding.claim || "").trim()) {
          errors.push(`finding ${index + 1} must contain a non-empty claim.`);
        }
        const refs = finding.evidenceRefs ?? finding.evidence_refs;
        if (!Array.isArray(refs)) {
          errors.push(`finding ${index + 1} evidenceRefs must be an array.`);
        }
      });
    }
    for (const key of [
      "themes",
      "methods",
      "organisms",
      "genes",
      "proteins",
      "pathways",
      "limitations",
    ]) {
      if (mapped[key] !== undefined && !Array.isArray(mapped[key])) {
        errors.push(`${key} must be an array when supplied.`);
      }
    }
    return errors.slice(0, 30);
  }

  function isRetryableCorpusMapError(error) {
    return ["InvalidLlmResponse", "EmptyLlmResponse"].includes(error?.code);
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
                coverage: value.coverage,
                failureCount: value.failures ? Object.keys(value.failures).length : undefined,
                failures: value.failures
                  ? Object.fromEntries(
                      Object.entries(value.failures)
                        .slice(0, 500)
                        .map(([sourceId, error]) => [
                          sourceId,
                          {
                            stage: error?.stage === "map" ? "map" : "prepare",
                            code: String(error?.code || "FAILED").slice(0, 120),
                            message: String(error?.message || "Source failed.").slice(0, 300),
                            sourceReady: error?.sourceReady === true,
                            retryable: error?.retryable === true,
                          },
                        ])
                    )
                  : undefined,
                reduction: value.reduction
                  ? {
                      papersIncluded: value.reduction.papersIncluded,
                      papersFailed: value.reduction.papersFailed,
                      themes: (value.reduction.themes || []).slice(0, 20),
                      groupSyntheses: (value.reduction.groupSyntheses || []).slice(0, 30),
                      findings: (value.reduction.findings || []).slice(0, 40),
                    }
                  : undefined,
                incrementalUpdate: value.incrementalUpdate,
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
      requireAuthorizedTool(requestContext.surface || "side_chat", "ensure_source_ready");
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

    async readSourceBytesForUse(sourceId, requestContext = {}) {
      const source = this.registry.get(sourceId);
      if (!source) {
        throw new SourceSystemError(
          "SOURCE_NOT_FOUND",
          "The source is missing or no longer active."
        );
      }
      if (requestContext.signal?.aborted) {
        throw new SourceSystemError("OPERATION_ABORTED", "Source preparation was cancelled.");
      }
      const file = await this.readCurrentFile(source);
      const observedSignature = statSignatureFor({
        relativePath: source.path,
        size: file.size,
        lastModified: file.lastModified,
        filesystemFileId: source.filesystemFileId,
      });
      if (
        Number(file.lastModified) > 0 &&
        Date.now() - Number(file.lastModified) < this.debounceMilliseconds
      ) {
        throw new SourceSystemError(
          "SOURCE_STILL_CHANGING",
          "The source was modified very recently and may still be copying. Retry shortly."
        );
      }
      const bytes = new Uint8Array(await file.arrayBuffer());
      const needsHash =
        source.hashStatus !== "ready" ||
        !source.contentHash ||
        source.statSignature !== observedSignature;
      let contentHash = source.contentHash;
      if (needsHash) {
        const hashStarted = Date.now();
        contentHash = await hashBytes(bytes, this.cryptoProvider);
        this.metrics.fullHashCalls += 1;
        this.metrics.fullHashBytes += bytes.byteLength;
        this.metrics.hashDurationMs += Date.now() - hashStarted;
      }
      const contentChanged = Boolean(
        source.contentHash && source.contentHash !== contentHash
      );
      if (contentChanged) {
        source.artifacts = {};
        source.parseStatus = "not_started";
        source.indexStatus = "not_started";
        source.paperCardStatus = source.sourceKind === "paper" ? "absent" : "not_applicable";
        source.structuredDataStatus =
          source.sourceKind === "experiment" ? "not_started" : "not_applicable";
      }
      source.contentHash = contentHash;
      source.contentVersion = contentHash;
      source.hashAlgorithm = String(contentHash || "").split(":")[0] || null;
      source.hashStatus = "ready";
      source.catalogStatus = "discovered";
      source.sizeBytes = Number(file.size) || 0;
      source.mtimeNs = Number(file.lastModified) || 0;
      source.statSignature = observedSignature;
      source.lastUsedAt = nowIso(this.now);
      source.error = null;
      if (!contentChanged) {
        for (const artifact of Object.values(source.artifacts || {})) {
          if (artifact && !artifact.contentHash) artifact.contentHash = contentHash;
          if (artifact) artifact.validationStatus = "validated";
        }
      }
      const finalFile = await this.readCurrentFile(source);
      if (
        Number(finalFile.size) !== Number(file.size) ||
        Number(finalFile.lastModified) !== Number(file.lastModified)
      ) {
        source.catalogStatus = "dirty";
        source.hashStatus = source.contentHash ? "dirty" : "absent";
        source.error = {
          code: "SOURCE_CHANGED_DURING_PREPARATION",
          message: "The source changed while it was being read; the result was rejected.",
        };
        await this.registry.persist();
        throw new SourceSystemError(
          "SOURCE_CHANGED_DURING_PREPARATION",
          "The source changed while it was being read. Retry after the copy or edit finishes."
        );
      }
      await this.registry.persist();
      return {
        source,
        file,
        bytes,
        contentHash,
        statSignature: observedSignature,
        hashPerformed: needsHash,
        contentChanged,
      };
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

  class RequestyPdfAnalyzer {
    constructor(options) {
      this.workspace = options.workspace;
      this.registry = options.registry;
      this.preparation = options.preparation;
      this.results = options.results || this.preparation.results;
      this.nativePdfWorker = options.nativePdfWorker || null;
      this.now = options.now || (() => new Date());
    }

    validateAnalysis(analysis, responseSchema) {
      if (responseSchema === "corpus_map") {
        return corpusMapValidationErrors(analysis);
      }
      if (!analysis || typeof analysis !== "object" || Array.isArray(analysis)) {
        return ["Native PDF analysis must be one structured object."];
      }
      const errors = [];
      if (!String(analysis.summary || "").trim()) {
        errors.push("summary must be a non-empty string.");
      }
      for (const key of ["themes", "methods", "keyFindings", "limitations", "evidenceRefs"]) {
        if (analysis[key] !== undefined && !Array.isArray(analysis[key])) {
          errors.push(`${key} must be an array when supplied.`);
        }
      }
      return errors;
    }

    async analyze(paperId, task, options = {}) {
      requireAuthorizedTool(options.surface || "side_chat", "analyze_pdf_native");
      if (typeof this.nativePdfWorker !== "function") {
        throw new SourceSystemError(
          "NATIVE_PDF_UNAVAILABLE",
          "Requesty native PDF analysis is not configured."
        );
      }
      const source = this.registry.get(paperId);
      if (!source || source.sourceKind !== "paper" || extensionName(source.path) !== "pdf") {
        throw new SourceSystemError(
          "NATIVE_PDF_SOURCE_INVALID",
          "Native PDF analysis requires one registered local PDF paper."
        );
      }
      const normalizedTask = normalizeSynthesisQuestion(task);
      if (!normalizedTask) {
        throw new SourceSystemError(
          "NATIVE_PDF_TASK_REQUIRED",
          "Native PDF analysis requires a bounded analysis task."
        );
      }
      const responseSchema = options.responseSchema === "corpus_map"
        ? "corpus_map"
        : "paper_analysis";
      const modelVersion = String(options.modelVersion || "requesty-configured-model").slice(0, 200);
      const taskSignature = stableStringHash([
        normalizedTask,
        responseSchema,
        NATIVE_PDF_PROMPT_VERSION,
        modelVersion,
      ].join("|"));
      const current = this.registry.get(paperId);
      const currentFile = await this.preparation.readCurrentFile(current);
      const observedSignature = statSignatureFor({
        relativePath: current.path,
        size: currentFile.size,
        lastModified: currentFile.lastModified,
        filesystemFileId: current.filesystemFileId,
      });
      const existingPath = current?.contentHash
        ? `${sourceArtifactBase(paperId, current.contentHash)}/native-pdf/${taskSignature}.json`
        : "";
      if (
        existingPath &&
        current.statSignature === observedSignature &&
        await this.workspace.fileExists(existingPath)
      ) {
        const cached = await this.workspace.readJson(existingPath);
        if (
          cached.contentHash === current.contentHash &&
          cached.taskSignature === taskSignature &&
          cached.promptVersion === NATIVE_PDF_PROMPT_VERSION
        ) {
          current.lastUsedAt = nowIso(this.now);
          await this.registry.persist();
          return this.results.compact({ ...cached.result, cached: true }, {
            tool: "analyze_pdf_native",
            paperId,
            artifactPath: existingPath,
          });
        }
      }

      const started = Date.now();
      const sourceBytes = await this.preparation.readSourceBytesForUse(paperId, options);
      const artifactPath = `${sourceArtifactBase(
        paperId,
        sourceBytes.contentHash
      )}/native-pdf/${taskSignature}.json`;
      const workerResult = await this.nativePdfWorker({
        paperId,
        filename: source.displayName,
        contentHash: sourceBytes.contentHash,
        bytes: sourceBytes.bytes,
        task: String(task).slice(0, 8000),
        purpose: String(options.purpose || "paper_analysis").slice(0, 120),
        responseSchema,
        evidenceRefs: uniqueStrings(options.evidenceRefs, 100),
        language: options.language === "zh" ? "zh" : "en",
      }, options);
      const analysis = workerResult?.analysis || workerResult;
      const validationErrors = this.validateAnalysis(analysis, responseSchema);
      if (validationErrors.length) {
        const error = new SourceSystemError(
          "InvalidLlmResponse",
          "Native PDF analysis did not return the validated structured schema."
        );
        error.schemaValidationDetails = validationErrors;
        throw error;
      }
      const result = {
        paperId,
        contentHash: sourceBytes.contentHash,
        taskSignature,
        responseSchema,
        promptVersion: NATIVE_PDF_PROMPT_VERSION,
        modelVersion: String(workerResult?.model || modelVersion).slice(0, 200),
        analysis,
        evidenceRefs: uniqueStrings(
          options.evidenceRefs || analysis.evidenceRefs || analysis.evidence_refs,
          100
        ),
        artifactPath,
        cached: false,
        diagnostics: {
          ...(workerResult?.diagnostics || {}),
          nativePdfPathUsed: true,
          pdfBytes: sourceBytes.bytes.byteLength,
          durationMs: Date.now() - started,
          hashPerformed: sourceBytes.hashPerformed,
        },
      };
      await this.workspace.writeJson(artifactPath, {
        schemaVersion: 1,
        sourceId: paperId,
        contentHash: sourceBytes.contentHash,
        taskSignature,
        responseSchema,
        promptVersion: NATIVE_PDF_PROMPT_VERSION,
        modelVersion: result.modelVersion,
        createdAt: nowIso(this.now),
        result,
      });
      source.artifacts ||= {};
      source.artifacts.nativePdf = {
        path: artifactPath,
        contentHash: sourceBytes.contentHash,
        taskSignature,
        promptVersion: NATIVE_PDF_PROMPT_VERSION,
        modelVersion: result.modelVersion,
        validationStatus: "validated",
      };
      await this.registry.persist();
      console.info("native_pdf_analysis_completed", {
        paperId,
        model: result.modelVersion,
        pdfBytes: sourceBytes.bytes.byteLength,
        durationMs: result.diagnostics.durationMs,
        structuredOutputMode: result.diagnostics.structuredOutputMode || "unknown",
        fallbackPath: result.diagnostics.fallbackPath || "none",
      });
      return this.results.compact(result, {
        tool: "analyze_pdf_native",
        paperId,
        artifactPath,
      });
    }
  }

  class LiteratureTools {
    constructor(options) {
      this.registry = options.registry;
      this.preparation = options.preparation;
      this.results = options.results || this.preparation.results;
      this.nativePdfAnalyzer = options.nativePdfAnalyzer || null;
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
      requireAuthorizedTool(options.surface || "side_chat", "search_paper_content");
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
      requireAuthorizedTool(options.surface || "side_chat", "read_paper_evidence");
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
      requireAuthorizedTool(options.surface || "side_chat", "ensure_paper_card");
      return this.preparation.ensureSourceReady([paperId], "paper_card", options);
    }

    async analyzePdfNative(paperId, task, options = {}) {
      if (!this.nativePdfAnalyzer) {
        throw new SourceSystemError(
          "NATIVE_PDF_UNAVAILABLE",
          "Requesty native PDF analysis is not configured."
        );
      }
      return this.nativePdfAnalyzer.analyze(paperId, task, options);
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
      requireAuthorizedTool(options.surface || "side_chat", "query_experiment_results");
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
      requireAuthorizedTool(options.surface || "side_chat", "read_experiment_source");
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
      this.fallbackMapWorker = options.fallbackMapWorker || null;
      this.nativePdfAnalyzer = options.nativePdfAnalyzer || null;
      this.mapAttempts = Math.min(
        5,
        Math.max(1, Number(options.mapAttempts) || DEFAULT_CORPUS_MAP_ATTEMPTS)
      );
    }

    workflowPath(workflowId) {
      return `${WORKFLOW_DIRECTORY}/${String(workflowId || "").trim()}.json`;
    }

    async readWorkflowIndex() {
      const path = `${WORKFLOW_DIRECTORY}/corpus-index.json`;
      return (await this.workspace.fileExists(path))
        ? await this.workspace.readJson(path)
        : { schemaVersion: 2, byQuestion: {}, recentWorkflowIds: [] };
    }

    async resolveWorkflowId(workflowId = "") {
      const requested = String(workflowId || "").trim();
      if (requested) return requested;
      const index = await this.readWorkflowIndex();
      if (index.latestWorkflowId) return index.latestWorkflowId;
      return [...new Set([
        ...(Array.isArray(index.recentWorkflowIds) ? index.recentWorkflowIds : []),
        ...Object.values(index.byQuestion || {}),
      ])].filter(Boolean).at(-1) || "";
    }

    async readWorkflow(workflowId = "") {
      const resolvedId = await this.resolveWorkflowId(workflowId);
      if (!resolvedId || !(await this.workspace.fileExists(this.workflowPath(resolvedId)))) {
        throw new SourceSystemError(
          "CORPUS_WORKFLOW_NOT_FOUND",
          "No matching corpus literature workflow was found."
        );
      }
      return this.workspace.readJson(this.workflowPath(resolvedId));
    }

    sourceIsReady(sourceId, preparedRecord = null) {
      const source = this.registry.get(sourceId, { includeMissing: true });
      return Boolean(
        source &&
        source.catalogStatus !== "missing" &&
        source.hashStatus === "ready" &&
        source.parseStatus === "ready" &&
        source.indexStatus === "ready" &&
        (!preparedRecord?.contentHash || preparedRecord.contentHash === source.contentHash)
      );
    }

    workflowStatusFromJournal(journal) {
      this.updateCoverage(
        journal,
        this.registry.list({ sourceKind: "paper" }).length
      );
      const failures = Object.entries(journal.failures || {}).map(
        ([paperId, failure]) => {
          const source = this.registry.get(paperId, { includeMissing: true });
          const stage = failure?.stage === "map" ? "map" : "prepare";
          const sourceReady = this.sourceIsReady(
            paperId,
            journal.prepareCompleted?.[paperId]
          );
          return {
            paperId,
            filename: String(
              source?.displayName ||
              source?.path ||
              journal.snapshot?.find((item) => item.sourceId === paperId)?.path ||
              paperId
            ).split("/").at(-1).slice(0, 500),
            title: String(journal.maps?.[paperId]?.title || "").slice(0, 500),
            stage,
            code: String(failure?.code || "FAILED").slice(0, 120),
            message: String(failure?.message || "Corpus analysis failed.").slice(0, 1000),
            sourceReady,
            retryable: stage === "map" && isRetryableCorpusMapError(failure),
            attempts: Math.max(0, Number(failure?.attempts) || 0),
            fallbackAttempted: failure?.fallbackAttempted === true,
          };
        }
      );
      return {
        workflowId: journal.workflowId,
        workflowType: journal.workflowType,
        question: journal.question,
        status: journal.status,
        phase: journal.phase,
        papersTotal: journal.coverage.papersIncludedInSnapshot,
        papersPrepared: journal.coverage.papersSuccessfullyPrepared,
        papersAnalyzed: journal.coverage.papersSuccessfullyAnalyzed,
        corpusScope:
          journal.coverage.papersIncludedInSnapshot < journal.coverage.papersDiscovered
            ? "selected"
            : "entire-project",
        coverage: { ...journal.coverage },
        failures,
        retryablePaperIds: failures
          .filter((failure) => failure.retryable)
          .map((failure) => failure.paperId),
        incrementalUpdate: journal.incrementalUpdate || null,
        updatedAt: journal.updatedAt,
      };
    }

    async getWorkflowStatus(workflowId = "") {
      return this.workflowStatusFromJournal(
        await this.readWorkflow(workflowId)
      );
    }

    async getCorpusFailures(workflowId = "") {
      const status = await this.getWorkflowStatus(workflowId);
      return {
        workflowId: status.workflowId,
        papersTotal: status.papersTotal,
        papersPrepared: status.papersPrepared,
        papersAnalyzed: status.papersAnalyzed,
        failures: status.failures,
      };
    }

    async retryFailedMaps(workflowId = "", options = {}) {
      requireAuthorizedTool(options.surface || "side_chat", "retry_corpus_map_failures");
      const journal = await this.readWorkflow(workflowId);
      const retryPaperIds = Object.entries(journal.mapFailures || {})
        .filter(([, failure]) => isRetryableCorpusMapError(failure))
        .map(([paperId]) => paperId);
      if (!retryPaperIds.length) {
        return {
          workflow: await this.results.compact(journal, {
            tool: "retry_corpus_map_failures",
            workflowId: journal.workflowId,
            journalPath: this.workflowPath(journal.workflowId),
          }),
          status: await this.getWorkflowStatus(journal.workflowId),
          retriedPaperIds: [],
        };
      }
      const paperIds = (journal.snapshot || []).map((item) => item.sourceId);
      const workflow = await this.run(journal.question, {
        ...options,
        workflowId: journal.workflowId,
        paperIds,
        retryPaperIds,
      });
      const workflowValue = workflow?.resultHandle
        ? await this.results.read(workflow.resultHandle)
        : workflow;
      const status = this.workflowStatusFromJournal(workflowValue);
      console.info("corpus_map_recovery_completed", {
        workflowId: journal.workflowId,
        retriedPaperIds: retryPaperIds,
        papersAnalyzed: status.papersAnalyzed,
        failuresRemaining: status.failures.length,
      });
      return {
        workflow,
        status,
        retriedPaperIds: retryPaperIds,
      };
    }

    async resumeIncompleteWorkflows(options = {}) {
      requireAuthorizedTool(options.surface || "side_chat", "resume_corpus_workflow");
      const index = await this.readWorkflowIndex();
      const workflowIds = [...new Set([
        index.latestWorkflowId,
        ...(Array.isArray(index.recentWorkflowIds) ? index.recentWorkflowIds : []),
        ...Object.values(index.byQuestion || {}),
      ])].filter(Boolean).reverse();
      const resumed = [];
      const limit = Math.min(5, Math.max(1, Number(options.limit) || 3));
      for (const workflowId of workflowIds) {
        if (resumed.length >= limit) break;
        const path = this.workflowPath(workflowId);
        if (!(await this.workspace.fileExists(path))) continue;
        const journal = await this.workspace.readJson(path);
        if (!["running", "paused"].includes(journal.status)) continue;
        const paperIds = (journal.snapshot || []).map((entry) => entry.sourceId);
        const workflow = await this.run(journal.question, {
          ...options,
          workflowId,
          paperIds,
        });
        const value = workflow?.resultHandle
          ? await this.results.read(workflow.resultHandle)
          : workflow;
        resumed.push({
          workflowId,
          status: value.status,
          coverage: value.coverage,
        });
      }
      return resumed;
    }

    async executeMapWorker(workerInput, options = {}) {
      if (!this.mapWorker) return null;
      const diagnostics = [];
      let lastError = null;
      for (let attempt = 1; attempt <= this.mapAttempts; attempt += 1) {
        try {
          const mapped = await this.mapWorker(workerInput, {
            signal: options.signal,
            attempt,
            fallback: false,
          });
          const schemaErrors = corpusMapValidationErrors(mapped);
          if (schemaErrors.length) {
            const validationError = new SourceSystemError(
              "InvalidLlmResponse",
              "The corpus mapper did not return valid structured JSON."
            );
            validationError.schemaValidationDetails = schemaErrors;
            throw validationError;
          }
          const record = {
            attempt,
            mode: "structured-map",
            status: "valid",
            finishReason: String(mapped?.mapperDiagnostics?.finishReason || "").slice(0, 120),
            outputLength: Math.max(0, Number(mapped?.mapperDiagnostics?.outputLength) || 0),
            schemaValidationDetails: [],
          };
          diagnostics.push(record);
          console.info("corpus_map_attempt", { paperId: workerInput.paperId, ...record });
          return { mapped, diagnostics, generationMode: "structured-map" };
        } catch (error) {
          if (error?.code === "OPERATION_ABORTED") throw error;
          lastError = error;
          const record = {
            attempt,
            mode: "structured-map",
            status: "invalid",
            code: String(error?.code || error?.name || "MAP_FAILED").slice(0, 120),
            finishReason: String(error?.finishReason || "").slice(0, 120),
            outputLength: Math.max(0, Number(error?.outputLength) || 0),
            validationFailure: String(error?.message || "Mapper validation failed.").slice(0, 500),
            schemaValidationDetails: uniqueStrings(
              asList(error?.schemaValidationDetails),
              30
            ),
          };
          diagnostics.push(record);
          console.info("corpus_map_attempt", { paperId: workerInput.paperId, ...record });
          if (!isRetryableCorpusMapError(error) || attempt >= this.mapAttempts) break;
        }
      }

      if (this.nativePdfAnalyzer && options.qualityMode !== "fast") {
        try {
          const nativeResult = await this.nativePdfAnalyzer.analyze(
            workerInput.paperId,
            `Create a query-specific corpus map for this paper. Synthesis question: ${workerInput.question}`,
            {
              signal: options.signal,
              surface: options.surface || "side_chat",
              purpose: "corpus_map_fallback",
              responseSchema: "corpus_map",
              evidenceRefs: workerInput.evidence.map((item) => item.evidenceRef),
              language: options.language,
            }
          );
          const resolved = nativeResult?.resultHandle
            ? await this.results.read(nativeResult.resultHandle)
            : nativeResult;
          const mapped = resolved?.analysis || resolved;
          const schemaErrors = corpusMapValidationErrors(mapped);
          if (schemaErrors.length) {
            const validationError = new SourceSystemError(
              "InvalidLlmResponse",
              "The native PDF corpus fallback did not return valid structured JSON."
            );
            validationError.schemaValidationDetails = schemaErrors;
            throw validationError;
          }
          const record = {
            attempt: this.mapAttempts + 1,
            mode: "native-pdf-fallback",
            status: "valid",
            finishReason: String(resolved?.diagnostics?.finishReason || "").slice(0, 120),
            outputLength: Math.max(0, Number(resolved?.diagnostics?.outputLength) || 0),
            schemaValidationDetails: [],
          };
          diagnostics.push(record);
          console.info("corpus_map_attempt", { paperId: workerInput.paperId, ...record });
          return { mapped, diagnostics, generationMode: "native-pdf-fallback" };
        } catch (nativeError) {
          if (nativeError?.code === "OPERATION_ABORTED") throw nativeError;
          const record = {
            attempt: this.mapAttempts + 1,
            mode: "native-pdf-fallback",
            status: "invalid",
            code: String(nativeError?.code || nativeError?.name || "NATIVE_PDF_FAILED").slice(0, 120),
            finishReason: String(nativeError?.finishReason || "").slice(0, 120),
            outputLength: Math.max(0, Number(nativeError?.outputLength) || 0),
            validationFailure: String(nativeError?.message || "Native PDF fallback failed.").slice(0, 500),
            schemaValidationDetails: uniqueStrings(
              asList(nativeError?.schemaValidationDetails),
              30
            ),
          };
          diagnostics.push(record);
          console.info("corpus_map_attempt", { paperId: workerInput.paperId, ...record });
        }
      }

      try {
        const mapped = this.fallbackMapWorker
          ? await this.fallbackMapWorker(workerInput, {
              signal: options.signal,
              attempt: this.mapAttempts + 1,
              fallback: true,
            })
          : {
              paperId: workerInput.paperId,
              contentHash: workerInput.contentHash,
              title: workerInput.title,
              relevance: workerInput.evidence.length ? "medium" : "none",
              researchQuestion: "",
              themes: tokenize(workerInput.question).slice(0, 8),
              findings: workerInput.evidence.slice(0, 6).map((item) => ({
                claim: item.claimCandidate.slice(0, 900),
                evidenceRefs: [item.evidenceRef],
              })),
              methods: [],
              organisms: [],
              genes: [],
              proteins: [],
              pathways: [],
              experimentalStrategies: [],
              limitations: [
                "Fallback evidence analysis was used after structured mapper validation failures.",
              ],
              connectionsToOtherTopics: [],
              modelVersion: "host-evidence-fallback-v1",
            };
        const schemaErrors = corpusMapValidationErrors(mapped);
        if (schemaErrors.length) {
          const validationError = new SourceSystemError(
            "InvalidLlmResponse",
            "The fallback corpus analysis did not return valid structured JSON."
          );
          validationError.schemaValidationDetails = schemaErrors;
          throw validationError;
        }
        const record = {
          attempt: this.mapAttempts + 1,
          mode: "source-evidence-fallback",
          status: "valid",
          finishReason: String(mapped?.mapperDiagnostics?.finishReason || "").slice(0, 120),
          outputLength: Math.max(0, Number(mapped?.mapperDiagnostics?.outputLength) || 0),
          schemaValidationDetails: [],
        };
        diagnostics.push(record);
        console.info("corpus_map_attempt", { paperId: workerInput.paperId, ...record });
        return { mapped, diagnostics, generationMode: "source-evidence-fallback" };
      } catch (fallbackError) {
        if (fallbackError?.code === "OPERATION_ABORTED") throw fallbackError;
        const record = {
          attempt: this.mapAttempts + 1,
          mode: "source-evidence-fallback",
          status: "invalid",
          code: String(fallbackError?.code || fallbackError?.name || "MAP_FAILED").slice(0, 120),
          finishReason: String(fallbackError?.finishReason || "").slice(0, 120),
          outputLength: Math.max(0, Number(fallbackError?.outputLength) || 0),
          validationFailure: String(fallbackError?.message || "Fallback validation failed.").slice(0, 500),
          schemaValidationDetails: uniqueStrings(
            asList(fallbackError?.schemaValidationDetails),
            30
          ),
        };
        diagnostics.push(record);
        console.info("corpus_map_attempt", { paperId: workerInput.paperId, ...record });
        const exhausted = new SourceSystemError(
          String(lastError?.code || fallbackError?.code || "MAP_FAILED").slice(0, 120),
          String(lastError?.message || fallbackError?.message || "Corpus mapping failed.").slice(0, 1000)
        );
        exhausted.attempts = this.mapAttempts;
        exhausted.fallbackAttempted = true;
        exhausted.retryable = isRetryableCorpusMapError(lastError || fallbackError);
        exhausted.mapAttemptDiagnostics = diagnostics;
        throw exhausted;
      }
    }

    workflowId(question, sourceIds) {
      return `summarize-paper-corpus-${stableStringHash([
        CORPUS_WORKFLOW_VERSION,
        normalizeSynthesisQuestion(question),
        [...sourceIds].sort().join(","),
      ].join("|"))}`;
    }

    async readOptionalPaperCard(source) {
      const artifact = source?.artifacts?.paperCard;
      if (
        source?.paperCardStatus !== "ready" ||
        !artifact?.path ||
        artifact.contentHash !== source.contentHash ||
        !(await this.workspace.fileExists(artifact.path))
      ) return null;
      try {
        const card = await this.workspace.readJson(artifact.path);
        return {
          title: String(card?.title || "").slice(0, 500),
          researchQuestion: String(card?.researchQuestion || "").slice(0, 1200),
          summary: String(card?.shortSummary || card?.summary || "").slice(0, 2400),
          themes: uniqueStrings([
            ...asList(card?.topics),
            ...asList(card?.keywords),
          ], 30),
          methods: uniqueStrings(asList(card?.methods), 30),
          organisms: uniqueStrings(asList(card?.organisms), 30),
          genes: uniqueStrings(asList(card?.genes), 30),
          proteins: uniqueStrings(asList(card?.proteins), 30),
          pathways: uniqueStrings(asList(card?.pathways), 30),
          limitations: uniqueStrings(asList(card?.limitations), 30),
        };
      } catch {
        return null;
      }
    }

    updateCoverage(journal, papersDiscovered) {
      const prepareFailures = journal.prepareFailures || {};
      const mapFailures = journal.mapFailures || {};
      const missingPaperIds = uniqueStrings(
        Object.entries(prepareFailures)
          .filter(([, failure]) =>
            ["SOURCE_MISSING", "SOURCE_NOT_FOUND"].includes(failure?.code)
          )
          .map(([sourceId]) => sourceId),
        10000
      );
      const missingSet = new Set(missingPaperIds);
      const failedPaperIds = uniqueStrings([
        ...Object.keys(prepareFailures).filter((sourceId) => !missingSet.has(sourceId)),
        ...Object.keys(mapFailures),
      ], 10000);
      const changedPaperIds = uniqueStrings(
        (journal.snapshot || [])
          .filter((entry) => entry.changedDuringPreparation === true)
          .map((entry) => entry.sourceId),
        10000
      );
      journal.failures = {
        ...prepareFailures,
        ...mapFailures,
      };
      journal.coverage = {
        papersDiscovered,
        papersIncludedInSnapshot: (journal.snapshot || []).length,
        papersSuccessfullyPrepared: Object.keys(journal.prepareCompleted || {}).length,
        papersPreparationCacheHits: Object.values(journal.prepareCompleted || {})
          .filter((entry) => entry.cached === true).length,
        papersSuccessfullyAnalyzed: Object.keys(journal.maps || {}).length,
        papersFailed: failedPaperIds.length,
        papersMissing: missingPaperIds.length,
        includedPaperIds: (journal.snapshot || []).map((entry) => entry.sourceId),
        preparedPaperIds: Object.keys(journal.prepareCompleted || {}),
        analyzedPaperIds: Object.keys(journal.maps || {}),
        failedPaperIds,
        missingPaperIds,
        changedPaperIds,
      };
      return journal.coverage;
    }

    async run(question, options = {}) {
      requireAuthorizedTool(
        options.surface || "side_chat",
        "create_corpus_synthesis_artifact"
      );
      const discoveredSources = this.registry.list({ sourceKind: "paper" });
      const requestedIds = uniqueStrings(asList(options.paperIds), 10000);
      const requestedSet = requestedIds.length ? new Set(requestedIds) : null;
      const sources = requestedSet
        ? requestedIds
            .map((sourceId) => this.registry.get(sourceId))
            .filter((source) => source?.sourceKind === "paper")
        : discoveredSources;
      const sourceIds = sources.map((source) => source.sourceId);
      const workflowId = String(options.workflowId || "").trim() ||
        this.workflowId(question, sourceIds);
      const path = this.workflowPath(workflowId);
      const workflowIndexPath = `${WORKFLOW_DIRECTORY}/corpus-index.json`;
      const normalizedQuestion = normalizeSynthesisQuestion(question);
      const questionKey = stableStringHash(normalizedQuestion);
      const prepareConcurrency = Math.min(
        8,
        Math.max(1, Number(options.prepareConcurrency || options.concurrency) || DEFAULT_CORPUS_PREPARE_CONCURRENCY)
      );
      const mapConcurrency = Math.min(
        8,
        Math.max(1, Number(options.mapConcurrency || options.concurrency) || DEFAULT_CORPUS_MAP_CONCURRENCY)
      );
      const workflowIndex = await this.readWorkflowIndex();
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
      workflowIndex.schemaVersion = 2;
      workflowIndex.latestWorkflowId = workflowId;
      workflowIndex.recentWorkflowIds = uniqueStrings([
        ...(workflowIndex.recentWorkflowIds || []),
        workflowId,
      ], 100).slice(-100);
      workflowIndex.updatedAt = nowIso(this.now);
      await this.workspace.writeJson(workflowIndexPath, workflowIndex);
      let journal = null;
      if (await this.workspace.fileExists(path)) journal = await this.workspace.readJson(path);
      if (!journal) {
        journal = {
          schemaVersion: 2,
          workflowVersion: CORPUS_WORKFLOW_VERSION,
          workflowId,
          workflowType: "corpus_literature_synthesis",
          question: String(question || "Summarize the paper corpus."),
          normalizedQuestion,
          status: "running",
          phase: "snapshot",
          snapshot: sources.map((source) => ({
            sourceId: source.sourceId,
            path: source.path,
            observedStatSignature: source.statSignature,
            observedContentHash: source.contentHash,
          })),
          corpusVersion: stableStringHash(
            sources.map((source) => `${source.sourceId}:${source.statSignature}`).sort().join("|")
          ),
          prepareCompleted: {},
          prepareFailures: {},
          maps: {},
          mapFailures: {},
          mapAttemptDiagnostics: {},
          failures: {},
          groups: [],
          reduction: null,
          verification: [],
          verificationByClaim: {},
          concurrency: {
            prepare: prepareConcurrency,
            map: mapConcurrency,
            verify: mapConcurrency,
          },
          createdAt: nowIso(this.now),
          updatedAt: nowIso(this.now),
        };
      }
      journal.status = "running";
      journal.completedAt = null;
      journal.normalizedQuestion = normalizedQuestion;
      journal.prepareCompleted ||= {};
      journal.prepareFailures ||= {};
      journal.maps ||= {};
      journal.mapFailures ||= {};
      journal.mapAttemptDiagnostics ||= {};
      journal.verificationByClaim ||= {};
      journal.concurrency = {
        prepare: prepareConcurrency,
        map: mapConcurrency,
        verify: mapConcurrency,
      };
      journal.corpusVersion = stableStringHash(
        sources.map((source) => `${source.sourceId}:${source.statSignature}`).sort().join("|")
      );
      journal.snapshot = sources.map((source) => {
        const previous = (journal.snapshot || []).find(
          (entry) => entry.sourceId === source.sourceId
        );
        return {
          sourceId: source.sourceId,
          path: source.path,
          observedStatSignature: source.statSignature,
          observedContentHash: source.contentHash,
          ...(previous?.preparedStatSignature
            ? {
                preparedStatSignature: previous.preparedStatSignature,
                preparedContentHash: previous.preparedContentHash,
                changedDuringPreparation: previous.changedDuringPreparation === true,
              }
            : {}),
        };
      });
      for (const state of [
        journal.prepareCompleted,
        journal.prepareFailures,
        journal.maps,
        journal.mapFailures,
        journal.mapAttemptDiagnostics,
      ]) {
        for (const sourceId of Object.keys(state)) {
          if (!sourceIds.includes(sourceId)) delete state[sourceId];
        }
      }
      let persistQueue = Promise.resolve();
      const persist = async (progress = {}) => {
        this.updateCoverage(journal, discoveredSources.length);
        journal.updatedAt = nowIso(this.now);
        const savedJournal = JSON.parse(JSON.stringify(journal));
        persistQueue = persistQueue.then(() => this.workspace.writeJson(path, savedJournal));
        await persistQueue;
        options.onProgress?.({
          workflowId,
          phase: journal.phase,
          completed: Number.isFinite(Number(progress.completed))
            ? Number(progress.completed)
            : 0,
          total: Number.isFinite(Number(progress.total))
            ? Number(progress.total)
            : sourceIds.length,
          coverage: { ...journal.coverage },
          ...progress,
        });
      };
      await persist({ stage: "corpus-snapshot", completed: sourceIds.length, total: sourceIds.length });

      const retryPaperIds = uniqueStrings(asList(options.retryPaperIds), 10000)
        .filter((sourceId) => sourceIds.includes(sourceId));
      const retryPaperIdSet = new Set(retryPaperIds);
      const recoveryBaselineMapIds = retryPaperIds.length
        ? Object.keys(journal.maps)
        : [];
      const previousGroupSyntheses = retryPaperIds.length
        ? [...(journal.reduction?.groupSyntheses || [])]
        : [];
      const prepareSourceIds = retryPaperIds.length
        ? sourceIds.filter((sourceId) => {
            const source = this.registry.get(sourceId);
            const mapped = journal.maps[sourceId];
            return retryPaperIdSet.has(sourceId) ||
              !this.sourceIsReady(sourceId, journal.prepareCompleted[sourceId]) ||
              (mapped && (
                mapped.contentHash !== source?.contentHash ||
                mapped.statSignature !== source?.statSignature
              ));
          })
        : sourceIds;
      journal.phase = "prepare";
      await persist({
        stage: "corpus-prepare",
        completed: Object.keys(journal.prepareCompleted).length,
        total: sourceIds.length,
      });
      await runBounded(prepareSourceIds, prepareConcurrency, async (sourceId) => {
        try {
          const readiness = await this.preparation.ensureSourceReady(
            [sourceId],
            "search",
            options
          );
          const readySource = this.registry.get(sourceId);
          if (!readySource) {
            throw new SourceSystemError("SOURCE_MISSING", "The source disappeared during corpus preparation.");
          }
          const snapshotEntry = journal.snapshot.find(
            (entry) => entry.sourceId === sourceId
          );
          if (snapshotEntry) {
            snapshotEntry.preparedContentHash = readySource.contentHash;
            snapshotEntry.preparedStatSignature = readySource.statSignature;
            snapshotEntry.changedDuringPreparation =
              snapshotEntry.observedStatSignature !== readySource.statSignature;
          }
          journal.prepareCompleted[sourceId] = {
            sourceId,
            contentHash: readySource.contentHash,
            statSignature: readySource.statSignature,
            cached: readiness.sources?.[0]?.cached === true,
          };
          delete journal.prepareFailures[sourceId];
        } catch (error) {
          if (error?.code === "OPERATION_ABORTED") {
            journal.status = "paused";
            await persist({
              stage: "corpus-prepare",
              completed: Object.keys(journal.prepareCompleted).length +
                Object.keys(journal.prepareFailures).length,
              total: sourceIds.length,
            });
            throw error;
          }
          journal.prepareFailures[sourceId] = {
            ...compactError(error),
            stage: "prepare",
          };
          delete journal.prepareCompleted[sourceId];
          delete journal.maps[sourceId];
          delete journal.mapFailures[sourceId];
        }
        await persist({
          stage: "corpus-prepare",
          completed: Object.keys(journal.prepareCompleted).length +
            Object.keys(journal.prepareFailures).length,
          total: sourceIds.length,
        });
      });

      journal.phase = "map";
      const readySourceIds = sourceIds.filter(
        (sourceId) => journal.prepareCompleted[sourceId]
      );
      const mapSourceIds = readySourceIds.filter((sourceId) => {
        const source = this.registry.get(sourceId);
        const mapped = journal.maps[sourceId];
        return retryPaperIdSet.has(sourceId) ||
          !mapped ||
          mapped.contentHash !== source?.contentHash ||
          mapped.statSignature !== source?.statSignature;
      });
      const mapSourceIdSet = new Set(mapSourceIds);
      const mapProgressPaperIds = new Set(
        sourceIds.filter((sourceId) => {
          if (mapSourceIdSet.has(sourceId)) return false;
          const source = this.registry.get(sourceId);
          const mapped = journal.maps[sourceId];
          return Boolean(
            mapped &&
            mapped.contentHash === source?.contentHash &&
            mapped.statSignature === source?.statSignature
          );
        })
      );
      await persist({
        stage: "corpus-map",
        completed: mapProgressPaperIds.size,
        total: sourceIds.length,
      });
      await runBounded(mapSourceIds, mapConcurrency, async (sourceId) => {
        const readySource = this.registry.get(sourceId);
        const completed = journal.maps[sourceId];
        const mapCacheSignature = stableStringHash([
          normalizedQuestion,
          CORPUS_MAP_SCHEMA_VERSION,
          CORPUS_MAP_PROMPT_VERSION,
          options.mapModelVersion || "default-model",
        ].join("|"));
        const mapCachePath = `${WORKFLOW_DIRECTORY}/maps/${sourceId}/${mapCacheSignature}.json`;
        try {
          if (
            completed?.contentHash &&
            readySource?.contentHash === completed.contentHash &&
            readySource?.statSignature === completed.statSignature
          ) {
            delete journal.mapFailures[sourceId];
          } else if (await this.workspace.fileExists(mapCachePath)) {
            const cachedMap = await this.workspace.readJson(mapCachePath);
            if (
              cachedMap.contentHash === readySource?.contentHash &&
              cachedMap.normalizedQuestion === normalizedQuestion &&
              Number(cachedMap.workflowVersion) === CORPUS_WORKFLOW_VERSION &&
              Number(cachedMap.mapSchemaVersion) === CORPUS_MAP_SCHEMA_VERSION &&
              cachedMap.mapPromptVersion === CORPUS_MAP_PROMPT_VERSION &&
              (!options.mapModelVersion || cachedMap.mapModelVersion === options.mapModelVersion)
            ) {
              journal.maps[sourceId] = cachedMap.result;
              delete journal.mapFailures[sourceId];
            }
          }
          if (!readySource) {
            throw new SourceSystemError("SOURCE_MISSING", "The prepared source is no longer available.");
          }
          if (!journal.maps[sourceId] || journal.maps[sourceId].contentHash !== readySource.contentHash) {
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
            const paperArtifact = await this.preparation.readPaperArtifact(sourceId);
            const paperCard = await this.readOptionalPaperCard(readySource);
            const workerInput = {
              paperId: readySource.sourceId,
              contentHash: readySource.contentHash,
              title: paperArtifact.metadataTitle || readySource.displayName,
              question: journal.question,
              paperCard,
              evidence: (evidence || []).map((item) => ({
                claimCandidate: item.snippet,
                evidenceRef: `${readySource.sourceId}:p${item.page}:${item.chunkId}`,
              })),
            };
            // Each mapper receives only this bounded object: no parent conversation or
            // accumulated tool history enters the worker context.
            const mappedExecution = this.mapWorker
              ? await this.executeMapWorker(workerInput, {
                  signal: options.signal,
                  surface: options.surface,
                  language: options.language,
                  qualityMode: ["fast", "balanced", "high_fidelity"].includes(
                    options.qualityMode
                  )
                    ? options.qualityMode
                    : "balanced",
                })
              : null;
            const mapped = mappedExecution?.mapped || {
                  paperId: readySource.sourceId,
                  contentHash: readySource.contentHash,
                  title: workerInput.title,
                  relevance: workerInput.evidence.length ? "high" : "low",
                  researchQuestion: paperCard?.researchQuestion || "",
                  themes: paperCard?.themes?.length
                    ? paperCard.themes
                    : tokenize(journal.question).slice(0, 8),
                  findings: workerInput.evidence.slice(0, 6).map((item) => ({
                    claim: item.claimCandidate.slice(0, 900),
                    evidenceRefs: [item.evidenceRef],
                  })),
                  methods: paperCard?.methods || [],
                  organisms: paperCard?.organisms || [],
                  genes: paperCard?.genes || [],
                  proteins: paperCard?.proteins || [],
                  pathways: paperCard?.pathways || [],
                  limitations: paperCard?.limitations || [],
                };
            const normalizedMap = normalizeCorpusMapResult(mapped, workerInput);
            journal.maps[sourceId] = {
              ...normalizedMap,
              statSignature: readySource.statSignature,
              generationMode: mappedExecution?.generationMode || "host-default",
            };
            journal.mapAttemptDiagnostics[sourceId] =
              mappedExecution?.diagnostics || [];
            await this.workspace.writeJson(mapCachePath, {
              schemaVersion: 1,
              workflowVersion: CORPUS_WORKFLOW_VERSION,
              mapSchemaVersion: CORPUS_MAP_SCHEMA_VERSION,
              mapPromptVersion: CORPUS_MAP_PROMPT_VERSION,
              mapModelVersion: normalizedMap.modelVersion,
              normalizedQuestion,
              sourceId,
              contentHash: readySource.contentHash,
              result: journal.maps[sourceId],
              updatedAt: nowIso(this.now),
            });
            delete journal.mapFailures[sourceId];
          }
        } catch (error) {
          if (error?.code === "OPERATION_ABORTED") {
            journal.status = "paused";
            await persist({
              stage: "corpus-map",
              completed: mapProgressPaperIds.size,
              total: sourceIds.length,
            });
            throw error;
          }
          journal.mapFailures[sourceId] = {
            ...compactError(error),
            stage: "map",
            sourceReady: this.sourceIsReady(
              sourceId,
              journal.prepareCompleted[sourceId]
            ),
            retryable: error?.retryable === true || isRetryableCorpusMapError(error),
            attempts: Math.max(0, Number(error?.attempts) || 0),
            fallbackAttempted: error?.fallbackAttempted === true,
          };
          if (Array.isArray(error?.mapAttemptDiagnostics)) {
            journal.mapAttemptDiagnostics[sourceId] = error.mapAttemptDiagnostics;
          }
          delete journal.maps[sourceId];
        }
        mapProgressPaperIds.add(sourceId);
        await persist({
          stage: "corpus-map",
          completed: mapProgressPaperIds.size,
          total: sourceIds.length,
          paperId: sourceId,
          outcome: journal.maps[sourceId] ? "analyzed" : "failed",
        });
      });

      journal.phase = "group";
      const groupIndex = new Map();
      const addGroup = (category, label, paperId) => {
        const normalizedLabel = String(label || "").trim();
        if (!normalizedLabel) return;
        const key = `${category}:${normalizedLabel.toLowerCase()}`;
        const group = groupIndex.get(key) || {
          category,
          label: normalizedLabel,
          paperIds: [],
        };
        group.paperIds = uniqueStrings([...group.paperIds, paperId], 10000);
        groupIndex.set(key, group);
      };
      for (const mapped of Object.values(journal.maps)) {
        const themes = mapped.themes?.length ? mapped.themes : ["other"];
        for (const value of themes) addGroup("theme", value, mapped.paperId);
        for (const value of mapped.methods || []) addGroup("methodology", value, mapped.paperId);
        for (const value of mapped.organisms || []) addGroup("organism", value, mapped.paperId);
        for (const value of [
          ...(mapped.genes || []),
          ...(mapped.proteins || []),
          ...(mapped.pathways || []),
        ]) addGroup("biological-entity", value, mapped.paperId);
        for (const value of mapped.experimentalStrategies || []) {
          addGroup("experimental-strategy", value, mapped.paperId);
        }
      }
      journal.groups = [...groupIndex.values()].sort(
        (left, right) => left.category.localeCompare(right.category) ||
          left.label.localeCompare(right.label)
      );
      const recoveredPaperIds = retryPaperIds.filter(
        (paperId) => Boolean(journal.maps[paperId])
      );
      await persist({
        stage: "corpus-group",
        completed: journal.groups.length,
        total: journal.groups.length,
      });

      journal.phase = "reduce";
      const findingIndex = new Map();
      for (const mapped of Object.values(journal.maps)) {
        for (const finding of mapped.findings || []) {
          const key = String(finding.claim || "").toLowerCase().replace(/\s+/g, " ").trim();
          if (!key) continue;
          const existing = findingIndex.get(key) || {
            claim: finding.claim,
            supportingPaperIds: [],
            evidenceRefs: [],
          };
          existing.supportingPaperIds = uniqueStrings(
            [...existing.supportingPaperIds, mapped.paperId],
            10000
          );
          existing.evidenceRefs = uniqueStrings(
            [...existing.evidenceRefs, ...(finding.evidenceRefs || [])],
            10000
          );
          findingIndex.set(key, existing);
        }
      }
      const findings = [...findingIndex.values()].sort(
        (left, right) =>
          right.supportingPaperIds.length - left.supportingPaperIds.length ||
          left.claim.localeCompare(right.claim)
      );
      let reusedGroupSynthesisCount = 0;
      const affectedGroupKeys = [];
      const groupSyntheses = journal.groups.map((group) => {
        const paperIdSet = new Set(group.paperIds);
        const groupFindings = findings.filter((finding) =>
          finding.supportingPaperIds.some((paperId) => paperIdSet.has(paperId))
        );
        const candidate = {
          category: group.category,
          label: group.label,
          paperIds: group.paperIds,
          paperCount: group.paperIds.length,
          claimCount: groupFindings.length,
          claims: groupFindings,
        };
        const previous = previousGroupSyntheses.find(
          (item) => item.category === group.category &&
            String(item.label).toLowerCase() === String(group.label).toLowerCase()
        );
        if (previous && JSON.stringify(previous) === JSON.stringify(candidate)) {
          reusedGroupSynthesisCount += 1;
          return previous;
        }
        if (retryPaperIds.length) {
          affectedGroupKeys.push(
            `${group.category}:${String(group.label).toLowerCase()}`
          );
        }
        return candidate;
      });
      const themeSyntheses = groupSyntheses.filter(
        (group) => group.category === "theme"
      );
      journal.reduction = {
        papersIncluded: Object.keys(journal.maps).length,
        papersFailed: journal.coverage.papersFailed + journal.coverage.papersMissing,
        themes: journal.groups
          .filter((group) => group.category === "theme")
          .map((group) => ({ theme: group.label, paperIds: group.paperIds })),
        topicFindings: themeSyntheses.map((group) => ({
          theme: group.label,
          paperIds: group.paperIds,
          findings: group.claims,
        })),
        groupSyntheses,
        findings,
        globalSynthesis: {
          coverage: { ...journal.coverage },
          groupCounts: groupSyntheses.map((group) => ({
            category: group.category,
            label: group.label,
            paperCount: group.paperCount,
            paperIds: group.paperIds,
          })),
          totalStructuredClaims: findings.length,
        },
      };
      if (retryPaperIds.length) {
        journal.incrementalUpdate = {
          requestedRetryPaperIds: retryPaperIds,
          recoveredPaperIds,
          remainingFailedPaperIds: retryPaperIds.filter(
            (paperId) => Boolean(journal.mapFailures[paperId])
          ),
          reusedMapPaperIds: recoveryBaselineMapIds.filter(
            (paperId) => Boolean(journal.maps[paperId]) &&
              !retryPaperIdSet.has(paperId)
          ),
          affectedGroupKeys: uniqueStrings(affectedGroupKeys, 10000),
          reusedGroupSynthesisCount,
          updatedAt: nowIso(this.now),
        };
      }
      await persist({
        stage: "corpus-reduce",
        completed: groupSyntheses.length,
        total: groupSyntheses.length,
      });

      journal.phase = "verify";
      const verificationKeysBeforeUpdate = new Set(
        Object.keys(journal.verificationByClaim)
      );
      const verificationTargets = [...journal.reduction.findings]
        .sort((left, right) =>
          Number(/\d/.test(right.claim)) - Number(/\d/.test(left.claim)) ||
          right.supportingPaperIds.length - left.supportingPaperIds.length
        )
        .slice(0, 40);
      const verificationTargetKeys = new Set(
        verificationTargets.map((finding) => stableStringHash([
          finding.claim,
          ...(finding.evidenceRefs || []),
        ].join("|")))
      );
      for (const claimKey of Object.keys(journal.verificationByClaim)) {
        if (!verificationTargetKeys.has(claimKey)) {
          delete journal.verificationByClaim[claimKey];
        }
      }
      await persist({
        stage: "corpus-verify",
        completed: Object.keys(journal.verificationByClaim).length,
        total: verificationTargets.length,
      });
      await runBounded(
        verificationTargets,
        mapConcurrency,
        async (finding) => {
          const claimKey = stableStringHash([
            finding.claim,
            ...(finding.evidenceRefs || []),
          ].join("|"));
          if (journal.verificationByClaim[claimKey]) return;
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
            } catch (error) {
              if (error?.code === "OPERATION_ABORTED") throw error;
              // The failed reference is retained below as unlocated evidence.
            }
          }
          journal.verificationByClaim[claimKey] = {
            claimKey,
            claim: finding.claim,
            supportingPaperIds: finding.supportingPaperIds,
            evidenceRefs: finding.evidenceRefs,
            locatedEvidence: located,
            status: located.length ? "original-evidence-located" : "unverified",
          };
          await persist({
            stage: "corpus-verify",
            completed: Object.keys(journal.verificationByClaim).length,
            total: verificationTargets.length,
          });
        }
      );
      journal.verification = verificationTargets
        .map((finding) => journal.verificationByClaim[stableStringHash([
          finding.claim,
          ...(finding.evidenceRefs || []),
        ].join("|"))])
        .filter(Boolean);
      if (journal.incrementalUpdate) {
        const currentVerificationKeys = Object.keys(journal.verificationByClaim);
        journal.incrementalUpdate.verificationClaimsReused = currentVerificationKeys
          .filter((claimKey) => verificationKeysBeforeUpdate.has(claimKey)).length;
        journal.incrementalUpdate.verificationClaimsRechecked = currentVerificationKeys
          .filter((claimKey) => !verificationKeysBeforeUpdate.has(claimKey)).length;
      }
      journal.phase = "answer";
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
      await persist({
        stage: "corpus-answer",
        completed: journal.coverage.papersSuccessfullyAnalyzed,
        total: journal.coverage.papersIncludedInSnapshot,
      });
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

  class ProjectStateService {
    constructor(options) {
      this.workspace = options.workspace;
      this.registry = options.registry;
      this.jobs = options.jobs;
      this.corpusWorkflows = options.corpusWorkflows;
      this.now = options.now || (() => new Date());
    }

    async saveState(nextState) {
      if (typeof this.workspace.saveState === "function") {
        return this.workspace.saveState(nextState);
      }
      const state = {
        ...nextState,
        schemaVersion: Number(nextState?.schemaVersion) || 1,
        updatedAt: nowIso(this.now),
      };
      await this.workspace.writeJson(".biodesign/state.json", state);
      this.workspace.state = state;
      return state;
    }

    async refreshMetadata(options = {}) {
      requireAuthorizedTool(options.surface || "side_chat", "refresh_project_metadata");
      const state = this.workspace.state || {
        schemaVersion: 1,
        project: { goal: "" },
        ui: {},
        agent: {},
        memory: {},
      };
      const sources = this.registry.list();
      const papers = sources.filter((source) => source.sourceKind === "paper");
      const experiments = sources.filter((source) => source.sourceKind === "experiment");
      let workflowStatus = null;
      try {
        workflowStatus = this.corpusWorkflows
          ? await this.corpusWorkflows.getWorkflowStatus(options.workflowId || "")
          : null;
      } catch (error) {
        if (error?.code !== "CORPUS_WORKFLOW_NOT_FOUND") throw error;
      }
      const metadata = {
        schemaVersion: 1,
        sourceCounts: this.registry.counts(),
        preparationFailures: sources.filter((source) =>
          source.hashStatus === "failed" ||
          source.parseStatus === "failed" ||
          source.indexStatus === "failed" ||
          source.structuredDataStatus === "failed"
        ).length,
        paperCardFailures: papers.filter(
          (source) => source.paperCardStatus === "failed"
        ).length,
        corpusMapFailures: (workflowStatus?.failures || []).filter(
          (failure) => failure.stage === "map"
        ).length,
        experimentsReady: experiments.filter(
          (source) => source.structuredDataStatus === "ready"
        ).length,
        corpusVersion:
          workflowStatus?.workflowId &&
          Array.isArray(workflowStatus.coverage?.includedPaperIds) &&
          workflowStatus.coverage.includedPaperIds.length
            ? stableStringHash(workflowStatus.coverage.includedPaperIds.join("|"))
            : null,
        activeWorkflowId: workflowStatus?.workflowId || null,
        corpusCoverage: workflowStatus?.coverage || null,
        lastProcessingAt: nowIso(this.now),
      };
      const previous = state.projectMetadata || null;
      if (JSON.stringify(previous) !== JSON.stringify(metadata)) {
        await this.saveState({ ...state, projectMetadata: metadata });
      }
      return metadata;
    }

    async updateMemory(input = {}, options = {}) {
      requireAuthorizedTool(options.surface || "side_chat", "update_project_memory");
      const text = String(input.text || "").replace(/\s+/g, " ").trim().slice(0, 4000);
      if (!text) {
        throw new SourceSystemError(
          "MEMORY_TEXT_REQUIRED",
          "A compact memory statement is required."
        );
      }
      const allowedKinds = new Set([
        "goal",
        "focus",
        "term",
        "decision",
        "hypothesis",
        "constraint",
        "metric",
        "observation",
        "experiment_note",
        "question",
        "relationship",
      ]);
      const kind = allowedKinds.has(input.kind) ? input.kind : "observation";
      const allowedStatuses = new Set(["active", "superseded", "retracted"]);
      const status = allowedStatuses.has(input.status) ? input.status : "active";
      const state = this.workspace.state || {
        schemaVersion: 1,
        project: { goal: "" },
        ui: {},
        agent: {},
        memory: {},
      };
      const records = Array.isArray(state.memory?.records)
        ? [...state.memory.records]
        : [];
      const normalizedRefs = {
        sourceIds: uniqueStrings(input.sourceIds, 100),
        experimentIds: uniqueStrings(input.experimentIds, 100),
      };
      const duplicate = records.find(
        (record) =>
          record.status === "active" &&
          record.kind === kind &&
          normalizeSynthesisQuestion(record.text) === normalizeSynthesisQuestion(text)
      );
      if (duplicate) return duplicate;
      const timestamp = nowIso(this.now);
      const record = {
        memoryId: this.workspace.createId(),
        kind,
        text,
        sourceIds: normalizedRefs.sourceIds,
        experimentIds: normalizedRefs.experimentIds,
        status,
        createdAt: timestamp,
        updatedAt: timestamp,
      };
      records.push(record);
      await this.saveState({
        ...state,
        memory: {
          ...(state.memory || {}),
          records: records.slice(-500),
        },
      });
      return record;
    }

    async updateActiveState(input = {}, options = {}) {
      requireAuthorizedTool(options.surface || "side_chat", "update_active_state");
      const state = this.workspace.state || {
        schemaVersion: 1,
        project: { goal: "" },
        ui: {},
        agent: {},
        memory: {},
      };
      const activeState = {
        activePaperIds: uniqueStrings(input.activePaperIds, 150),
        activeExperimentIds: uniqueStrings(input.activeExperimentIds, 150),
        activeWorkflowId: String(input.activeWorkflowId || "").slice(0, 200) || null,
        currentTopic: String(input.currentTopic || "").replace(/\s+/g, " ").trim().slice(0, 500),
        currentHypotheses: uniqueStrings(input.currentHypotheses, 30),
        recentInternalUpdates: uniqueStrings(input.recentInternalUpdates, 30),
        updatedAt: nowIso(this.now),
      };
      await this.saveState({
        ...state,
        agent: {
          ...(state.agent || {}),
          sideChat: activeState,
        },
      });
      return activeState;
    }
  }

  class ManagedLocalWorker {
    constructor(options) {
      this.workspace = options.workspace;
      this.jobs = options.jobs;
      this.preparation = options.preparation;
      this.corpusWorkflows = options.corpusWorkflows;
      this.now = options.now || (() => new Date());
      this.health = "healthy";
      this.generation = 1;
    }

    async getStatus(options = {}) {
      requireAuthorizedTool(options.surface || "side_chat", "get_local_worker_status");
      await this.jobs.load();
      const running = this.jobs.list({ status: "running" });
      const queued = this.jobs.list({ status: "queued" });
      const stale = this.jobs.list({ status: "stale" });
      return {
        workerType: "browser-analysis-job-coordinator",
        health:
          this.health === "unhealthy" || stale.length
            ? "unhealthy"
            : this.health,
        generation: this.generation,
        runningJobs: running.length,
        queuedJobs: queued.length,
        resumableStaleJobs: stale.length,
        arbitraryProcessControl: false,
      };
    }

    markUnhealthyForRecovery() {
      this.health = "unhealthy";
    }

    async resumeStaleJobs(options = {}) {
      await this.jobs.load();
      const limit = Math.min(50, Math.max(1, Number(options.jobLimit) || 20));
      const staleJobs = this.jobs.list({ status: "stale" }).slice(-limit);
      const resumed = [];
      const seen = new Set();
      for (const job of staleJobs) {
        const capability = String(job.jobType || "").startsWith("prepare:")
          ? String(job.jobType).slice("prepare:".length)
          : "";
        const sourceIds = uniqueStrings(job.sourceIds);
        const recoveryKey = `${capability}:${sourceIds.slice().sort().join("|")}`;
        if (
          !(capability in READINESS_CAPABILITIES) ||
          !sourceIds.length ||
          seen.has(recoveryKey)
        ) continue;
        seen.add(recoveryKey);
        try {
          const result = await this.preparation.ensureSourceReady(
            sourceIds,
            capability,
            {
              ...options,
              surface: options.surface || "side_chat",
            }
          );
          resumed.push({
            staleJobId: job.jobId,
            capability,
            sourceIds,
            status: result.failures?.length ? "partially_failed" : "completed",
            failureCount: result.failures?.length || 0,
          });
          job.status = result.failures?.length ? "failed" : "recovered";
          job.completedAt = nowIso(this.now);
          job.error = result.failures?.length
            ? {
                code: "RECOVERY_PARTIALLY_FAILED",
                message: `${result.failures.length} source preparation task(s) still failed.`,
              }
            : null;
        } catch (error) {
          if (error?.code === "OPERATION_ABORTED") throw error;
          resumed.push({
            staleJobId: job.jobId,
            capability,
            sourceIds,
            status: "failed",
            error: compactError(error),
          });
          job.status = "failed";
          job.completedAt = nowIso(this.now);
          job.error = compactError(error);
        }
      }
      if (resumed.length) await this.jobs.persist();
      return resumed;
    }

    async restart(options = {}) {
      requireAuthorizedTool(options.surface || "side_chat", "restart_local_worker");
      const before = await this.getStatus(options);
      if (this.jobs.inFlight.size) {
        return {
          restarted: false,
          reason: "The managed coordinator still has active in-process work; no duplicate jobs were started.",
          before,
          after: before,
          resumedWorkflows: [],
        };
      }
      this.generation += 1;
      this.health = "healthy";
      const resumedJobs = await this.resumeStaleJobs(options);
      const resumedWorkflows = this.corpusWorkflows
        ? await this.corpusWorkflows.resumeIncompleteWorkflows({
            ...options,
            surface: options.surface || "side_chat",
            limit: options.limit || 3,
          })
        : [];
      const after = await this.getStatus(options);
      console.info("managed_local_worker_restarted", {
        workerType: after.workerType,
        generation: after.generation,
        resumedJobCount: resumedJobs.length,
        resumedWorkflowCount: resumedWorkflows.length,
      });
      return {
        restarted: true,
        before,
        after,
        resumedJobs,
        resumedWorkflows,
      };
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
    const nativePdfAnalyzer = options.nativePdfAnalyzer ||
      (typeof options.nativePdfWorker === "function"
        ? new RequestyPdfAnalyzer({
            ...options,
            registry,
            preparation,
            results,
          })
        : null);
    const literatureTools = new LiteratureTools({
      registry,
      preparation,
      results,
      nativePdfAnalyzer,
    });
    const experimentTools = new ExperimentTools({ registry, preparation, results });
    const corpusWorkflows = new CorpusWorkflowService({
      ...options,
      registry,
      preparation,
      results,
      literatureTools,
      nativePdfAnalyzer,
    });
    const projectState = options.projectState || new ProjectStateService({
      ...options,
      registry,
      jobs,
      corpusWorkflows,
    });
    const managedWorker = options.managedWorker || new ManagedLocalWorker({
      ...options,
      jobs,
      preparation,
      corpusWorkflows,
    });
    return {
      registry,
      jobs,
      results,
      preparation,
      nativePdfAnalyzer,
      literatureTools,
      experimentTools,
      corpusWorkflows,
      projectState,
      managedWorker,
    };
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
    ManagedLocalWorker,
    NATIVE_PDF_PROMPT_VERSION,
    ProjectStateService,
    READINESS_CAPABILITIES,
    RequestyPdfAnalyzer,
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
    TOOL_EFFECTS,
    ToolEffect,
    authorizeTool,
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
    requireAuthorizedTool,
    scoreText,
    sourceKindFor,
    statSignatureFor,
  };
});
