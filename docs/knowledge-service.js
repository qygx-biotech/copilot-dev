(function exposeKnowledgeService(root, factory) {
  const api = factory(root);
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) Object.assign(root, api);
})(typeof globalThis !== "undefined" ? globalThis : this, function knowledgeServiceFactory(root) {
  "use strict";

  const retrievalContract = root?.BioDesignRetrievalContract ||
    (typeof require === "function" ? require("../shared/retrieval-contract.js") : {});
  const {
    CLOUD_RETRIEVAL = {},
    RETRIEVAL_LIMITS = {},
    resolveRetrievalLimits = (options = {}) => ({
      limit: Number(options.limit) || 10,
      candidateLimit: Number(options.candidateLimit) || 40,
    }),
  } = retrievalContract;

  const COLLECTIONS = Object.freeze({
    literatureEvidence: "literature-evidence",
    paperCards: "paper-cards",
    topics: "topics",
    syntheses: "syntheses",
    experimentNotes: "experiment-notes",
    projectMemory: "project-memory",
  });

  const CORPUS_SHARED_PLAN_VERSION = 1;
  const CORPUS_SCIENTIFIC_DIMENSIONS = Object.freeze([
    "research question objective",
    "organism biological system",
    "engineering strategy",
    "genes proteins pathways",
    "experimental methods conditions",
    "measurements quantitative results",
    "major findings",
    "limitations",
    "connections themes",
  ]);
  const CORPUS_TASK_ONLY_QUERY_PATTERN = /^(?:literature review|systematic review|scientific synthesis|meta-analysis|review writing|write (?:a )?review|文献综述|综述写作|系统综述|荟萃分析)$/iu;
  const CORPUS_TASK_WORD_PATTERN = /\b(?:help|me|please|summari[sz]e|review|survey|synthesis|write|all|every|papers?|literature|corpus|project|a|an|the)\b|帮我|请|一下|一个|一篇|总结|综述|撰写|写|所有|全部|文献|论文|语料库|项目/giu;

  function stableJson(value) {
    if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
    if (value && typeof value === "object") {
      return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
    }
    return JSON.stringify(value);
  }

  function normalizePlannerIdentityText(value) {
    return String(value || "").normalize("NFKC").replace(/\s+/g, " ").trim();
  }

  function normalizePlannerIntent(value) {
    return normalizePlannerIdentityText(value).toLocaleLowerCase("en-US");
  }

  function isGenericCorpusReviewQuestion(value) {
    const remainder = normalizePlannerIdentityText(value)
      .replace(CORPUS_TASK_WORD_PATTERN, " ")
      .replace(/[^\p{L}\p{N}]+/gu, " ")
      .trim();
    return !remainder;
  }

  function boundedUniqueStrings(values, maximum, characterLimit) {
    const seen = new Set();
    const result = [];
    for (const value of Array.isArray(values) ? values : []) {
      const text = normalizePlannerIdentityText(value).slice(0, characterLimit);
      const key = text.toLocaleLowerCase("en-US");
      if (!text || seen.has(key)) continue;
      seen.add(key);
      result.push(text);
      if (result.length >= maximum) break;
    }
    return result;
  }

  function normalizeCallContext(value = {}, expectedRole = "") {
    const allowedRoles = new Set([
      "search_planner",
      "reranker",
      "corpus_mapper",
      "corpus_reduce",
      "claim_verification",
      "answer",
      "native_pdf",
    ]);
    const boundedId = (input) => {
      const text = String(input || "").trim();
      return /^[A-Za-z0-9._:-]{1,200}$/.test(text) ? text : "";
    };
    const callRole = allowedRoles.has(expectedRole)
      ? expectedRole
      : allowedRoles.has(value?.callRole)
        ? value.callRole
        : "";
    const profile = ["light", "medium", "high"].includes(value?.profile)
      ? value.profile
      : "light";
    return Object.freeze({
      turnId: boundedId(value?.turnId),
      workflowId: boundedId(value?.workflowId),
      callRole,
      paperId: boundedId(value?.paperId),
      profile,
    });
  }

  function createSearchPlanCacheIdentity(query, intent, configurationSignature, versions = {}) {
    return {
      normalizedQuery: normalizePlannerIdentityText(query),
      retrievalIntent: normalizePlannerIntent(intent),
      configurationSignature: String(configurationSignature || ""),
      schemaVersion: Number(
        versions.schemaVersion ?? CLOUD_RETRIEVAL.schemaVersion
      ),
      promptVersion: String(
        versions.promptVersion ?? CLOUD_RETRIEVAL.searchPlanPromptVersion
      ),
      validation: {
        queryItems: Number(RETRIEVAL_LIMITS.resultMaximum),
        identifierItems: Number(RETRIEVAL_LIMITS.resultMaximum),
        combinedItems: Number(RETRIEVAL_LIMITS.candidateMaximum),
        queryCharacters: Number(RETRIEVAL_LIMITS.outputTextCharacters),
        identifierCharacters: Number(RETRIEVAL_LIMITS.paperIdCharacters),
        sourceLanguageCharacters: Number(RETRIEVAL_LIMITS.paperIdCharacters),
        reasoningCharacters: Number(RETRIEVAL_LIMITS.outputTextCharacters),
      },
    };
  }

  function corpusQueriesFromPlan(query, plan) {
    const generic = isGenericCorpusReviewQuestion(query);
    const planned = boundedUniqueStrings(
      plan?.queries,
      RETRIEVAL_LIMITS.resultMaximum,
      RETRIEVAL_LIMITS.outputTextCharacters
    ).filter((value) => !CORPUS_TASK_ONLY_QUERY_PATTERN.test(value));
    return {
      generic,
      queries: boundedUniqueStrings(
        generic ? [...CORPUS_SCIENTIFIC_DIMENSIONS] : planned,
        RETRIEVAL_LIMITS.resultMaximum,
        RETRIEVAL_LIMITS.outputTextCharacters
      ),
    };
  }

  function freezeSharedCorpusPlan(record) {
    return Object.freeze({
      ...record,
      queries: Object.freeze([...(record.queries || [])]),
      identifiers: Object.freeze([...(record.identifiers || [])]),
      scientificDimensions: Object.freeze([...(record.scientificDimensions || [])]),
    });
  }

  function operationAbortedError() {
    return new KnowledgeServiceError(
      "OPERATION_ABORTED",
      "The retrieval operation was stopped."
    );
  }

  function awaitSharedRequest(promise, signal) {
    if (!signal?.addEventListener) return promise;
    if (signal.aborted) return Promise.reject(operationAbortedError());
    return new Promise((resolve, reject) => {
      const onAbort = () => reject(operationAbortedError());
      signal.addEventListener("abort", onAbort, { once: true });
      promise.then(resolve, reject).finally(() => {
        signal.removeEventListener("abort", onAbort);
      });
    });
  }

  async function hashText(value, cryptoProvider = root?.crypto) {
    const text = String(value || "");
    if (cryptoProvider?.subtle?.digest) {
      const digest = await cryptoProvider.subtle.digest("SHA-256", new TextEncoder().encode(text));
      return [...new Uint8Array(digest)]
        .map((byte) => byte.toString(16).padStart(2, "0"))
        .join("");
    }
    let hash = 0x811c9dc5;
    for (const character of text) {
      hash ^= character.codePointAt(0);
      hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    return `${hash.toString(16).padStart(8, "0")}${text.length.toString(16).padStart(8, "0")}`;
  }

  function sanitizeDiagnostic(error, fallback) {
    return {
      code: String(error?.code || error?.name || fallback || "CLOUD_RETRIEVAL_FAILED").slice(0, 120),
      message: String(error?.message || fallback || "Cloud retrieval failed.").slice(0, 300),
    };
  }

  function outboundEvidenceText(value) {
    return String(value || "")
      .split("\n")
      .filter((line) => !/^\s*(?:absolute_?path|source_?path|relative_?path|sqlite_?path|directory_?handle|file_?path)\s*:/i.test(line))
      .join("\n")
      .replace(/(^|[\s("'`])(?:\/(?:Users|home|private|var|tmp|Volumes)\/[^\s)\]}>"']+|[A-Za-z]:[\\/][^\s)\]}>"']+|\\\\[^\s)\]}>"']+)/g, "$1[local-path-omitted]")
      .replace(/\bAuthorization\s*:\s*Bearer\s+[^\s,;]+/gi, "Authorization: [credential-omitted]")
      .replace(/\beyJ[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{8,}\b/g, "[credential-omitted]")
      .replace(/data:application\/pdf;base64,[A-Za-z0-9+/=]+/gi, "[pdf-omitted]")
      .trim();
  }

  function localCandidateKey(result) {
    if (result?.paperId) return `paper:${result.paperId}`;
    return [
      "source",
      result?.collection || "",
      result?.sourceId || result?.docid || "",
      result?.title || "",
    ].join(":");
  }

  function evidenceSections(result) {
    const sections = Array.isArray(result?.matchedSections) && result.matchedSections.length
      ? result.matchedSections
      : [{ snippet: result?.snippet || "", score: result?.score || 0 }];
    const seen = new Set();
    const selected = [];
    for (const section of sections) {
      const snippet = outboundEvidenceText(section?.snippet).slice(
        0,
        RETRIEVAL_LIMITS.snippetCharacters
      );
      if (!snippet || seen.has(snippet)) continue;
      seen.add(snippet);
      selected.push({ snippet, score: Number(section?.score) || 0 });
      if (selected.length >= RETRIEVAL_LIMITS.matchedSectionsPerPaper) break;
    }
    return selected;
  }

  class KnowledgeServiceError extends Error {
    constructor(code, message, cause = null) {
      super(message, cause ? { cause } : undefined);
      this.name = "KnowledgeServiceError";
      this.code = code;
      if (cause && !this.cause) this.cause = cause;
    }
  }

  class KnowledgeService {
    async initialize() {}
    async indexDocuments() {}
    async searchLex() { return []; }
    async searchVector() { return []; }
    async searchHybrid() { return []; }
    async getDocument() { return null; }
    async getDocumentRange() { return null; }
    async refreshSource() {}
    async removeSource() {}
    async status() { return { available: false }; }
    async close() {}
  }

  class LocalQmdKnowledgeService extends KnowledgeService {
    constructor(options = {}) {
      super();
      this.baseUrl = String(options.baseUrl || "/api/knowledge").replace(/\/$/, "");
      this.fetch = options.fetch || root?.fetch?.bind(root);
      this.workspaceId = "";
      this.available = false;
      this.lastStatus = null;
      this.lastError = null;
      this.listeners = new Set();
      this.progressWatchers = new Set();
    }

    subscribe(listener) {
      if (typeof listener !== "function") return () => {};
      this.listeners.add(listener);
      return () => this.listeners.delete(listener);
    }

    emit(event) {
      for (const listener of this.listeners) {
        try { listener(event); } catch { /* Observers cannot break retrieval. */ }
      }
    }

    watchEmbeddingProgress(signal) {
      let stopped = false;
      let timer = null;
      const schedule = () => {
        if (stopped) return;
        timer = root?.setTimeout?.(poll, 350) || setTimeout(poll, 350);
      };
      const poll = async () => {
        if (stopped || signal?.aborted) return;
        try {
          const query = `?workspaceId=${encodeURIComponent(this.workspaceId)}`;
          const payload = await this.request(`/status${query}`, { signal });
          const progress = payload.status?.embeddingProgress;
          if (progress) {
            this.emit({
              stage: "embedding",
              message: "Generating embeddings",
              completed: progress.chunksEmbedded,
              total: progress.totalChunks,
              progress,
            });
          }
        } catch {
          // The main request owns failure handling; progress polling is advisory.
        }
        schedule();
      };
      const stop = () => {
        stopped = true;
        if (timer) (root?.clearTimeout || clearTimeout)(timer);
        this.progressWatchers.delete(stop);
      };
      this.progressWatchers.add(stop);
      schedule();
      return stop;
    }

    async request(path, options = {}) {
      if (typeof this.fetch !== "function") {
        throw new KnowledgeServiceError(
          "QMD_BACKEND_UNAVAILABLE",
          "The local QMD backend is unavailable in this runtime."
        );
      }
      const body = options.body ? { ...options.body, workspaceId: this.workspaceId } : null;
      let response;
      try {
        response = await this.fetch(`${this.baseUrl}${path}`, {
          method: options.method || (body ? "POST" : "GET"),
          headers: {
            ...(body ? { "Content-Type": "application/json" } : {}),
            ...(this.workspaceId
              ? { "X-BioDesign-Workspace-Id": this.workspaceId }
              : {}),
          },
          ...(body ? { body: JSON.stringify(body) } : {}),
          signal: options.signal,
        });
      } catch (error) {
        throw new KnowledgeServiceError(
          "QMD_BACKEND_UNAVAILABLE",
          "The local QMD backend could not be reached; legacy retrieval remains available.",
          error
        );
      }
      const payload = await response.json().catch(() => ({}));
      if (!response.ok || payload.ok !== true) {
        throw new KnowledgeServiceError(
          payload.error || "QMD_REQUEST_FAILED",
          payload.message || `The local QMD backend returned HTTP ${response.status}.`
        );
      }
      return payload;
    }

    async initialize(project = {}) {
      this.workspaceId = String(project.workspaceId || project.workspace?.workspaceId || "");
      if (!this.workspaceId) {
        this.available = false;
        return { available: false, reason: "workspace-id-missing" };
      }
      this.emit({ stage: "initializing", message: "Initializing local search" });
      try {
        const payload = await this.request("/initialize", { method: "POST", body: {} });
        this.available = payload.status?.available === true;
        this.lastStatus = payload.status || { available: this.available };
        this.lastError = null;
        this.emit({ stage: "ready", status: this.lastStatus });
        return this.lastStatus;
      } catch (error) {
        this.available = false;
        this.lastError = error;
        this.emit({ stage: "fallback", error });
        console.info("qmd_backend_fallback", {
          code: error.code || error.name || "QMD_BACKEND_UNAVAILABLE",
          message: String(error.message || error).slice(0, 300),
          fallback: "legacy-local-retrieval",
        });
        return {
          available: false,
          error: { code: error.code, message: error.message },
        };
      }
    }

    async indexDocuments(collection, options = {}) {
      if (!this.available) return { available: false, deferred: true };
      this.emit({
        stage: options.embed ? "embedding" : "indexing",
        collection,
        message: options.embed ? "Generating embeddings" : "Updating local search",
      });
      const stopProgress = options.embed ? this.watchEmbeddingProgress(options.signal) : null;
      try {
        const payload = await this.request("/update", {
          method: "POST",
          body: {
            collections: [collection],
            embed: options.embed === true,
            force: options.force === true,
          },
          signal: options.signal,
        });
        this.emit({ stage: "ready", collection, result: payload });
        return payload;
      } catch (error) {
        this.emit({ stage: "fallback", collection, error });
        throw error;
      } finally {
        stopProgress?.();
      }
    }

    async embed(collections, options = {}) {
      if (!this.available) return { available: false, deferred: true };
      this.emit({ stage: "embedding", collections });
      const stopProgress = this.watchEmbeddingProgress(options.signal);
      try {
        const payload = await this.request("/embed", {
          method: "POST",
          body: {
            collections: Array.isArray(collections) ? collections : [collections],
            force: options.force === true,
          },
          signal: options.signal,
        });
        this.emit({ stage: "ready", collections, result: payload });
        return payload;
      } catch (error) {
        this.emit({ stage: "fallback", collections, error });
        throw error;
      } finally {
        stopProgress();
      }
    }

    async search(query, options = {}) {
      if (!this.available) return { results: [], fallbackRequired: true };
      const mode = options.mode || "fast";
      this.emit({
        stage: mode === "semantic" ? "initializing-search-model" : "searching",
        mode,
        message: mode === "deep"
          ? "Searching local lexical candidates"
          : mode === "semantic"
            ? "Initializing semantic search model"
            : "Searching local knowledge",
      });
      try {
        const payload = await this.request("/search", {
          method: "POST",
          body: {
            query,
            collections: options.collections,
            mode,
            limit: options.limit,
            candidateLimit: options.candidateLimit,
            paperIds: options.paperIds,
            intent: options.intent,
          },
          signal: options.signal,
        });
        this.lastStatus = {
          ...(this.lastStatus || {}),
          lastSearch: payload.diagnostics,
        };
        this.emit({ stage: "ready", mode, diagnostics: payload.diagnostics });
        return payload;
      } catch (error) {
        this.emit({ stage: "search-fallback", mode, error });
        throw error;
      }
    }

    async searchLex(query, options = {}) {
      return this.search(query, { ...options, mode: "fast" });
    }

    async searchVector(query, options = {}) {
      return this.search(query, { ...options, mode: "semantic" });
    }

    async searchHybrid(query, options = {}) {
      return this.search(query, { ...options, mode: "deep" });
    }

    async searchLiterature(input = {}) {
      const mode = ["fast", "semantic", "deep"].includes(input.mode)
        ? input.mode
        : "fast";
      return this.search(input.query, {
        mode,
        collections: input.collections || [COLLECTIONS.literatureEvidence],
        paperIds: input.paperIds,
        limit: input.limit,
        candidateLimit: input.candidateLimit,
        intent: input.intent || "scientific paper evidence",
        signal: input.signal,
      });
    }

    async searchProjectMemory(input = {}) {
      return this.search(input.query, {
        mode: input.mode || "fast",
        collections: [COLLECTIONS.projectMemory],
        limit: input.limit,
        signal: input.signal,
      });
    }

    async searchPreviousSyntheses(input = {}) {
      return this.search(input.query, {
        mode: input.mode || "fast",
        collections: [COLLECTIONS.syntheses],
        limit: input.limit,
        signal: input.signal,
      });
    }

    async searchExperimentSources(input = {}) {
      return this.search(input.query, {
        mode: input.mode || "fast",
        collections: [COLLECTIONS.experimentNotes],
        limit: input.limit,
        signal: input.signal,
      });
    }

    async searchTopics(input = {}) {
      return this.search(input.query, {
        mode: input.mode || "fast",
        collections: [COLLECTIONS.topics],
        limit: input.limit,
        signal: input.signal,
      });
    }

    async getDocument(pathOrDocid, options = {}) {
      if (!this.available) return null;
      const payload = await this.request("/document", {
        method: "POST",
        body: { pathOrDocid, includeBody: options.includeBody === true },
        signal: options.signal,
      });
      return payload.document;
    }

    async getDocumentRange(pathOrDocid, options = {}) {
      if (!this.available) return null;
      const payload = await this.request("/document", {
        method: "POST",
        body: {
          pathOrDocid,
          fromLine: options.fromLine,
          maxLines: options.maxLines,
        },
        signal: options.signal,
      });
      return payload.document;
    }

    async refreshSource(collection, options = {}) {
      return this.indexDocuments(collection, options);
    }

    async removeSource(collection, options = {}) {
      return this.indexDocuments(collection, options);
    }

    async status(options = {}) {
      if (!this.workspaceId) return { available: false };
      try {
        const query = `?workspaceId=${encodeURIComponent(this.workspaceId)}`;
        const payload = await this.request(`/status${query}`, { signal: options.signal });
        this.available = payload.status?.available === true;
        this.lastStatus = payload.status;
        return payload.status;
      } catch (error) {
        this.available = false;
        this.lastError = error;
        return { available: false, error: { code: error.code, message: error.message } };
      }
    }

    async close() {
      this.available = false;
      for (const stop of [...this.progressWatchers]) stop();
      this.listeners.clear();
    }
  }

  class ElectronQmdKnowledgeService extends KnowledgeService {
    constructor(options = {}) {
      super();
      this.desktop = options.desktop || root?.biodesignDesktop;
      this.workspace = options.workspace || null;
      this.cloudApi = options.cloudApi || null;
      this.cryptoProvider = options.cryptoProvider || root?.crypto;
      this.allowLocalSemantic = options.allowLocalSemantic === true;
      this.workspaceId = "";
      this.available = false;
      this.lastStatus = null;
      this.lastError = null;
      this.listeners = new Set();
      this.searchPlanInFlight = new Map();
      this.resolvedSearchPlans = new Map();
      this.stopProgress = this.desktop?.knowledge?.onProgress?.((event) => this.emit(event)) || null;
    }

    subscribe(listener) {
      if (typeof listener !== "function") return () => {};
      this.listeners.add(listener);
      return () => this.listeners.delete(listener);
    }

    emit(event) {
      for (const listener of this.listeners) {
        try { listener(event); } catch { /* Observers cannot break retrieval. */ }
      }
    }

    async initialize(project = {}) {
      this.workspaceId = String(project.workspaceId || project.workspace?.workspaceId || "");
      if (!this.workspaceId || !this.desktop?.knowledge) return { available: false };
      this.emit({ stage: "initializing", message: "Initializing local search" });
      try {
        this.lastStatus = await this.desktop.knowledge.initialize({ workspaceId: this.workspaceId });
        this.available = this.lastStatus?.available === true;
        this.lastError = null;
        this.emit({ stage: "ready", status: this.lastStatus });
        return this.lastStatus;
      } catch (error) {
        this.available = false;
        this.lastError = error;
        this.emit({ stage: "fallback", error });
        console.info("qmd_desktop_fallback", {
          code: error.code || error.name || "QMD_BACKEND_UNAVAILABLE",
          message: String(error.message || error).slice(0, 300),
          fallback: "legacy-local-retrieval",
        });
        return { available: false, error: { code: error.code, message: error.message } };
      }
    }

    async indexDocuments(collection, options = {}) {
      if (!this.available) return { available: false, deferred: true };
      const embed = options.embed === true && this.allowLocalSemantic;
      this.emit({ stage: embed ? "embedding" : "indexing", collection });
      const update = await this.desktop.knowledge.update({ collections: [collection] });
      const embeddings = embed
        ? await this.desktop.knowledge.embed({ collections: [collection], force: options.force === true })
        : null;
      const result = {
        update,
        embeddings,
        ...(options.embed === true && !embed ? { localSemanticDisabled: true } : {}),
      };
      this.emit({ stage: "ready", collection, result });
      return result;
    }

    async embed(collections, options = {}) {
      if (!this.available) return { available: false, deferred: true };
      if (!this.allowLocalSemantic) {
        return { available: true, localSemanticDisabled: true, result: [] };
      }
      const selected = Array.isArray(collections) ? collections : [collections];
      this.emit({ stage: "embedding", collections: selected });
      const result = await this.desktop.knowledge.embed({ collections: selected, force: options.force === true });
      this.emit({ stage: "ready", collections: selected, result });
      return { result };
    }

    async searchLocal(query, options = {}) {
      return this.desktop.knowledge.search({
        query,
        collections: options.collections,
        mode: options.mode || "fast",
        limit: options.limit,
        candidateLimit: options.candidateLimit,
        paperIds: options.paperIds,
        intent: options.intent,
      });
    }

    async readCache(kind, cacheKey, configurationSignature) {
      if (!this.workspace?.fileExists || !this.workspace?.readJson) return null;
      const path = `${CLOUD_RETRIEVAL.cacheDirectory}/${kind}-${cacheKey}.json`;
      try {
        if (!(await this.workspace.fileExists(path))) return null;
        const record = await this.workspace.readJson(path);
        if (
          record?.schemaVersion !== CLOUD_RETRIEVAL.schemaVersion ||
          record?.kind !== kind ||
          record?.cacheKey !== cacheKey ||
          record?.configurationSignature !== configurationSignature
        ) return null;
        return record.value;
      } catch {
        return null;
      }
    }

    async writeCache(kind, cacheKey, configurationSignature, value) {
      if (!this.workspace?.writeJson) return false;
      const path = `${CLOUD_RETRIEVAL.cacheDirectory}/${kind}-${cacheKey}.json`;
      try {
        await this.workspace.writeJson(path, {
          schemaVersion: CLOUD_RETRIEVAL.schemaVersion,
          kind,
          cacheKey,
          configurationSignature,
          value,
        });
        return true;
      } catch (error) {
        console.info("knowledge_cache_write_failed", {
          kind,
          cacheKey,
          code: String(error?.code || error?.name || "CACHE_WRITE_FAILED").slice(0, 120),
        });
        return false;
      }
    }

    validateCloudConfig(config) {
      if (
        config?.ok !== true ||
        config.schemaVersion !== CLOUD_RETRIEVAL.schemaVersion ||
        config.searchPlanPromptVersion !== CLOUD_RETRIEVAL.searchPlanPromptVersion ||
        config.rerankPromptVersion !== CLOUD_RETRIEVAL.rerankPromptVersion ||
        !/^[a-f0-9]{64}$/.test(config.plannerSignature || "") ||
        !/^[a-f0-9]{64}$/.test(config.rerankerSignature || "")
      ) {
        throw new KnowledgeServiceError(
          "INVALID_CLOUD_RETRIEVAL_CONFIG",
          "Function Compute returned an invalid retrieval configuration."
        );
      }
      return config;
    }

    validateSearchPlan(response, expectedSignature) {
      const plan = response?.plan;
      const keys = plan && typeof plan === "object" && !Array.isArray(plan)
        ? Object.keys(plan)
        : [];
      if (
        response?.ok !== true ||
        response.configurationSignature !== expectedSignature ||
        keys.length !== 4 ||
        !["queries", "identifiers", "sourceLanguage", "reasoningSummary"].every((key) => keys.includes(key)) ||
        !Array.isArray(plan.queries) ||
        plan.queries.length > RETRIEVAL_LIMITS.resultMaximum ||
        !Array.isArray(plan.identifiers) ||
        plan.identifiers.length > RETRIEVAL_LIMITS.resultMaximum ||
        plan.queries.length + plan.identifiers.length + 1 > RETRIEVAL_LIMITS.candidateMaximum ||
        plan.queries.some((value) => typeof value !== "string" || !value.trim() || value.length > RETRIEVAL_LIMITS.outputTextCharacters) ||
        plan.identifiers.some((value) => typeof value !== "string" || !value.trim() || value.length > RETRIEVAL_LIMITS.paperIdCharacters) ||
        new Set(plan.queries).size !== plan.queries.length ||
        new Set(plan.identifiers).size !== plan.identifiers.length ||
        typeof plan.sourceLanguage !== "string" ||
        !plan.sourceLanguage.trim() ||
        plan.sourceLanguage.length > RETRIEVAL_LIMITS.paperIdCharacters ||
        typeof plan.reasoningSummary !== "string" ||
        !plan.reasoningSummary.trim() ||
        plan.reasoningSummary.length > RETRIEVAL_LIMITS.outputTextCharacters
      ) {
        throw new KnowledgeServiceError(
          "INVALID_CLOUD_SEARCH_PLAN",
          "Function Compute returned a malformed cloud search plan."
        );
      }
      return {
        queries: [...plan.queries],
        identifiers: [...plan.identifiers],
        sourceLanguage: plan.sourceLanguage,
        reasoningSummary: plan.reasoningSummary,
      };
    }

    async getSearchPlan(query, intent, options = {}, config) {
      const identity = createSearchPlanCacheIdentity(
        query,
        intent,
        config.plannerSignature
      );
      const cacheKey = await hashText(stableJson(identity), this.cryptoProvider);
      const inFlightKey = `${config.plannerSignature}:${cacheKey}`;
      const callContext = normalizeCallContext(options.callContext, "search_planner");
      if (options.forceRefresh === true) {
        this.resolvedSearchPlans.delete(inFlightKey);
      }
      const resolved = this.resolvedSearchPlans.get(inFlightKey);
      if (resolved) {
        console.info("knowledge_plan_cache", {
          workflowId: callContext.workflowId,
          callRole: callContext.callRole,
          cacheKey,
          cache: "memory-hit",
        });
        return { ...resolved, cached: true, cacheSource: "memory" };
      }
      const alreadyInFlight = this.searchPlanInFlight.get(inFlightKey);
      if (alreadyInFlight) {
        console.info("knowledge_plan_cache", {
          workflowId: callContext.workflowId,
          callRole: callContext.callRole,
          cacheKey,
          cache: "in-flight-hit",
        });
        return {
          ...(await awaitSharedRequest(alreadyInFlight, options.signal)),
          shared: true,
        };
      }
      const cached = options.forceRefresh === true
        ? null
        : await this.readCache("search-plan", cacheKey, config.plannerSignature);
      const startedWhileReadingCache = this.searchPlanInFlight.get(inFlightKey);
      if (startedWhileReadingCache) {
        return {
          ...(await awaitSharedRequest(startedWhileReadingCache, options.signal)),
          shared: true,
        };
      }
      if (cached) {
        const result = {
          plan: this.validateSearchPlan({ ok: true, plan: cached, configurationSignature: config.plannerSignature }, config.plannerSignature),
          cached: true,
          cacheSource: "workspace",
        };
        this.resolvedSearchPlans.set(inFlightKey, result);
        console.info("knowledge_plan_cache", {
          workflowId: callContext.workflowId,
          callRole: callContext.callRole,
          cacheKey,
          cache: "workspace-hit",
        });
        return result;
      }
      console.info("knowledge_plan_cache", {
        workflowId: callContext.workflowId,
        callRole: callContext.callRole,
        cacheKey,
        cache: "miss",
      });
      const sharedRequest = (async () => {
        const response = await this.cloudApi.planKnowledgeSearch({
          query,
          intent,
          callContext,
        });
        const plan = this.validateSearchPlan(response, config.plannerSignature);
        const result = {
          plan,
          cached: false,
          usage: response.usage || null,
          attempts: response.attempts || null,
          cacheKey,
        };
        this.resolvedSearchPlans.set(inFlightKey, result);
        result.persisted = await this.writeCache(
          "search-plan",
          cacheKey,
          config.plannerSignature,
          plan
        );
        return result;
      })();
      this.searchPlanInFlight.set(inFlightKey, sharedRequest);
      void sharedRequest.finally(() => {
        if (this.searchPlanInFlight.get(inFlightKey) === sharedRequest) {
          this.searchPlanInFlight.delete(inFlightKey);
        }
      }).catch(() => {});
      return awaitSharedRequest(sharedRequest, options.signal);
    }

    validateSharedCorpusPlan(record, query, intent, config = null) {
      if (!record || typeof record !== "object" || Array.isArray(record)) return null;
      const normalizedQuery = normalizePlannerIdentityText(query);
      const normalizedIntent = normalizePlannerIntent(intent);
      const validStatus = ["ready", "local-fallback"].includes(record.status);
      const safeKeys = [
        "recordVersion",
        "status",
        "cacheKey",
        "normalizedQuery",
        "normalizedIntent",
        "configurationSignature",
        "rerankerConfigurationSignature",
        "schemaVersion",
        "promptVersion",
        "rerankPromptVersion",
        "queries",
        "identifiers",
        "sourceLanguage",
        "crossLanguage",
        "scientificDimensions",
        "useOriginalQuery",
        "fallbackReason",
        "createdAt",
      ];
      if (
        Object.keys(record).some((key) => !safeKeys.includes(key)) ||
        Number(record.recordVersion) !== CORPUS_SHARED_PLAN_VERSION ||
        record.normalizedQuery !== normalizedQuery ||
        record.normalizedIntent !== normalizedIntent ||
        Number(record.schemaVersion) !== CLOUD_RETRIEVAL.schemaVersion ||
        record.promptVersion !== CLOUD_RETRIEVAL.searchPlanPromptVersion ||
        !validStatus ||
        !Array.isArray(record.queries) ||
        !Array.isArray(record.identifiers) ||
        !Array.isArray(record.scientificDimensions) ||
        record.queries.length > RETRIEVAL_LIMITS.resultMaximum ||
        record.identifiers.length > RETRIEVAL_LIMITS.resultMaximum ||
        record.scientificDimensions.length > RETRIEVAL_LIMITS.resultMaximum ||
        record.queries.some((value) => typeof value !== "string" || !value.trim() || value.length > RETRIEVAL_LIMITS.outputTextCharacters) ||
        record.identifiers.some((value) => typeof value !== "string" || !value.trim() || value.length > RETRIEVAL_LIMITS.paperIdCharacters) ||
        record.scientificDimensions.some((value) => typeof value !== "string" || !value.trim() || value.length > RETRIEVAL_LIMITS.outputTextCharacters) ||
        typeof record.sourceLanguage !== "string" ||
        !record.sourceLanguage.trim() ||
        record.sourceLanguage.length > RETRIEVAL_LIMITS.paperIdCharacters ||
        typeof record.crossLanguage !== "boolean" ||
        typeof record.useOriginalQuery !== "boolean" ||
        typeof record.configurationSignature !== "string" ||
        typeof record.rerankerConfigurationSignature !== "string" ||
        (record.status === "ready" &&
          (!/^[a-f0-9]{64}$/.test(record.configurationSignature) ||
            !/^[a-f0-9]{64}$/.test(record.rerankerConfigurationSignature))) ||
        typeof record.rerankPromptVersion !== "string" ||
        record.rerankPromptVersion !== CLOUD_RETRIEVAL.rerankPromptVersion ||
        typeof record.fallbackReason !== "string" ||
        record.fallbackReason.length > 120 ||
        typeof record.createdAt !== "string" ||
        !record.createdAt ||
        record.createdAt.length > 100 ||
        typeof record.cacheKey !== "string" ||
        !/^[a-f0-9]{16,64}$/.test(record.cacheKey)
      ) return null;
      if (config && (
        record.configurationSignature !== config.plannerSignature ||
        record.rerankerConfigurationSignature !== config.rerankerSignature ||
        record.rerankPromptVersion !== config.rerankPromptVersion
      )) return null;
      return freezeSharedCorpusPlan(Object.fromEntries(
        safeKeys.map((key) => [key, record[key]])
      ));
    }

    async createLocalCorpusFallbackPlan(query, intent, config = null, reason = "planner-unavailable") {
      const identity = createSearchPlanCacheIdentity(
        query,
        intent,
        config?.plannerSignature || "local-fallback"
      );
      const cacheKey = await hashText(stableJson(identity), this.cryptoProvider);
      const normalized = corpusQueriesFromPlan(query, { queries: [] });
      return freezeSharedCorpusPlan({
        recordVersion: CORPUS_SHARED_PLAN_VERSION,
        status: "local-fallback",
        cacheKey,
        normalizedQuery: identity.normalizedQuery,
        normalizedIntent: identity.retrievalIntent,
        configurationSignature: config?.plannerSignature || "",
        rerankerConfigurationSignature: config?.rerankerSignature || "",
        schemaVersion: CLOUD_RETRIEVAL.schemaVersion,
        promptVersion: CLOUD_RETRIEVAL.searchPlanPromptVersion,
        rerankPromptVersion: CLOUD_RETRIEVAL.rerankPromptVersion,
        queries: normalized.queries.length ? normalized.queries : [identity.normalizedQuery],
        identifiers: [],
        sourceLanguage: /[\u3400-\u9fff]/u.test(query) ? "zh" : "en",
        crossLanguage: /[^\x00-\x7f]/u.test(query),
        scientificDimensions: normalized.generic ? [...CORPUS_SCIENTIFIC_DIMENSIONS] : [],
        useOriginalQuery: !normalized.generic,
        fallbackReason: String(reason || "planner-unavailable").slice(0, 120),
        createdAt: new Date().toISOString(),
      });
    }

    async prepareCorpusSearchPlan(query, intent, options = {}) {
      const normalizedQuery = normalizePlannerIdentityText(query);
      const normalizedIntent = normalizePlannerIntent(intent);
      if (!normalizedQuery || !normalizedIntent) {
        throw new KnowledgeServiceError(
          "INVALID_RETRIEVAL_INPUT",
          "Corpus planning requires a normalized question and intent."
        );
      }
      const callContext = normalizeCallContext(options.callContext, "search_planner");
      const persisted = options.forceRefresh === true
        ? null
        : this.validateSharedCorpusPlan(options.persistedPlan, query, intent);
      if (persisted?.status === "local-fallback") {
        console.info("corpus_shared_plan", {
          workflowId: callContext.workflowId,
          callRole: callContext.callRole,
          cacheKey: persisted.cacheKey,
          state: "workflow-fallback-reuse",
        });
        return persisted;
      }

      let config;
      try {
        config = this.validateCloudConfig(
          await this.cloudApi.getKnowledgeRetrievalConfig(options.signal)
        );
      } catch (error) {
        if (error?.code === "OPERATION_ABORTED" || error?.name === "AbortError") {
          throw error?.code === "OPERATION_ABORTED" ? error : operationAbortedError();
        }
        return this.createLocalCorpusFallbackPlan(
          query,
          intent,
          null,
          error?.code || error?.name || "configuration-unavailable"
        );
      }

      const compatiblePersisted = persisted
        ? this.validateSharedCorpusPlan(persisted, query, intent, config)
        : null;
      if (compatiblePersisted) {
        console.info("corpus_shared_plan", {
          workflowId: callContext.workflowId,
          callRole: callContext.callRole,
          cacheKey: compatiblePersisted.cacheKey,
          state: "workflow-plan-reuse",
        });
        return compatiblePersisted;
      }

      try {
        const planned = await this.getSearchPlan(query, intent, {
          signal: options.signal,
          callContext,
          forceRefresh: options.forceRefresh === true,
        }, config);
        const normalized = corpusQueriesFromPlan(query, planned.plan);
        const identity = createSearchPlanCacheIdentity(
          query,
          intent,
          config.plannerSignature
        );
        const cacheKey = planned.cacheKey || await hashText(
          stableJson(identity),
          this.cryptoProvider
        );
        const record = freezeSharedCorpusPlan({
          recordVersion: CORPUS_SHARED_PLAN_VERSION,
          status: "ready",
          cacheKey,
          normalizedQuery: identity.normalizedQuery,
          normalizedIntent: identity.retrievalIntent,
          configurationSignature: config.plannerSignature,
          rerankerConfigurationSignature: config.rerankerSignature,
          schemaVersion: config.schemaVersion,
          promptVersion: config.searchPlanPromptVersion,
          rerankPromptVersion: config.rerankPromptVersion,
          queries: normalized.queries,
          identifiers: normalized.generic
            ? []
            : boundedUniqueStrings(
                planned.plan.identifiers,
                RETRIEVAL_LIMITS.resultMaximum,
                RETRIEVAL_LIMITS.paperIdCharacters
              ),
          sourceLanguage: planned.plan.sourceLanguage,
          crossLanguage: /[^\x00-\x7f]/u.test(query),
          scientificDimensions: normalized.generic ? [...CORPUS_SCIENTIFIC_DIMENSIONS] : [],
          useOriginalQuery: !normalized.generic,
          fallbackReason: "",
          createdAt: new Date().toISOString(),
        });
        console.info("corpus_shared_plan", {
          workflowId: callContext.workflowId,
          callRole: callContext.callRole,
          cacheKey,
          state: planned.cached ? "planner-cache-hit" : "planner-created",
        });
        return record;
      } catch (error) {
        if (error?.code === "OPERATION_ABORTED") throw error;
        console.info("corpus_shared_plan", {
          workflowId: callContext.workflowId,
          callRole: callContext.callRole,
          state: "local-fallback",
          code: String(error?.code || error?.name || "PLANNER_FAILED").slice(0, 120),
        });
        return this.createLocalCorpusFallbackPlan(
          query,
          intent,
          config,
          error?.code || error?.name || "planner-failed"
        );
      }
    }

    async fuseLexicalQueries(queries, options) {
      const { candidateLimit } = resolveRetrievalLimits(options);
      const fused = new Map();
      let firstSeen = 0;
      for (let queryIndex = 0; queryIndex < queries.length; queryIndex += 1) {
        const local = await this.searchLocal(queries[queryIndex], {
          ...options,
          mode: "fast",
          limit: candidateLimit,
          candidateLimit,
        });
        for (let rank = 0; rank < (local.results || []).length; rank += 1) {
          const result = local.results[rank];
          const key = localCandidateKey(result);
          let entry = fused.get(key);
          if (!entry) {
            entry = {
              key,
              result,
              firstSeen: firstSeen++,
              fusionScore: 0,
              bestLocalScore: Number(result.score) || 0,
            };
            fused.set(key, entry);
          }
          entry.fusionScore += 1 / (rank + 1);
          entry.bestLocalScore = Math.max(entry.bestLocalScore, Number(result.score) || 0);
        }
      }
      return [...fused.values()]
        .sort((left, right) =>
          right.fusionScore - left.fusionScore ||
          right.bestLocalScore - left.bestLocalScore ||
          left.firstSeen - right.firstSeen ||
          left.key.localeCompare(right.key)
        )
        .slice(0, candidateLimit);
    }

    async buildCloudCandidates(fused, query, intent) {
      const candidates = [];
      const submitted = [];
      const seenEvidence = new Set();
      let evidenceCharacters = 0;
      for (const entry of fused) {
        const identityHash = await hashText(entry.key, this.cryptoProvider);
        const candidateId = `candidate-${identityHash}`;
        const sections = evidenceSections(entry.result);
        const evidence = [];
        for (let index = 0; index < sections.length; index += 1) {
          const snippet = sections[index].snippet;
          if (seenEvidence.has(snippet)) continue;
          seenEvidence.add(snippet);
          evidence.push({
            evidenceHandle: `evidence-${identityHash}-${index + 1}`,
            snippet,
          });
        }
        const title = outboundEvidenceText(entry.result?.title || entry.result?.paperId || entry.result?.sourceId || "")
          .slice(0, RETRIEVAL_LIMITS.titleCharacters);
        const cloud = { candidateId, title, evidence };
        const contentHash = await hashText(stableJson(cloud), this.cryptoProvider);
        const candidate = { ...entry, candidateId, contentHash, cloud };
        candidates.push(candidate);
        const nextEvidenceCharacters = evidenceCharacters + evidence.reduce((total, item) => total + item.snippet.length, 0);
        const prospective = {
          query,
          intent,
          candidates: [...submitted.map((item) => item.cloud), cloud],
        };
        if (
          nextEvidenceCharacters <= RETRIEVAL_LIMITS.totalEvidenceCharacters &&
          JSON.stringify(prospective).length <= RETRIEVAL_LIMITS.requestCharacters
        ) {
          submitted.push(candidate);
          evidenceCharacters = nextEvidenceCharacters;
        }
      }
      return { candidates, submitted, evidenceCharacters };
    }

    validateRanking(response, expectedSignature, submitted) {
      if (
        response?.ok !== true ||
        response.configurationSignature !== expectedSignature ||
        !Array.isArray(response.ranked) ||
        response.ranked.length > RETRIEVAL_LIMITS.candidateMaximum
      ) {
        throw new KnowledgeServiceError("INVALID_CLOUD_RERANK", "Function Compute returned an invalid reranking response.");
      }
      const allowed = new Set(submitted.map((candidate) => candidate.candidateId));
      const seen = new Set();
      for (const item of response.ranked) {
        if (
          !item || typeof item !== "object" || Array.isArray(item) ||
          Object.keys(item).length !== 3 ||
          !["candidateId", "score", "reason"].every((key) => Object.hasOwn(item, key)) ||
          !allowed.has(item.candidateId) ||
          seen.has(item.candidateId) ||
          !Number.isFinite(item.score) || item.score < 0 || item.score > 1 ||
          typeof item.reason !== "string" || item.reason.length > RETRIEVAL_LIMITS.outputTextCharacters ||
          outboundEvidenceText(item.reason) !== item.reason.trim()
        ) {
          throw new KnowledgeServiceError("INVALID_CLOUD_RERANK", "Function Compute returned a hallucinated, duplicate, or malformed ranking entry.");
        }
        seen.add(item.candidateId);
      }
      return response.ranked.map((item) => ({ ...item }));
    }

    async getRanking(query, intent, options, config, submitted) {
      const identity = {
        normalizedQuery: query.normalize("NFKC").replace(/\s+/g, " ").trim(),
        retrievalIntent: intent,
        paperScope: [...new Set(options.paperIds || [])].sort(),
        collectionScope: [...new Set(options.collections || [])].sort(),
        candidateIds: submitted.map((candidate) => candidate.candidateId),
        candidateContentHashes: submitted.map((candidate) => candidate.contentHash),
        sourceVersions: submitted.map((candidate) => candidate.result?.sourceVersion || candidate.result?.contentHash || candidate.contentHash),
        retrieval: resolveRetrievalLimits(options),
        modelSignature: config.rerankerSignature,
        schemaVersion: CLOUD_RETRIEVAL.schemaVersion,
        promptVersion: CLOUD_RETRIEVAL.rerankPromptVersion,
      };
      const cacheKey = await hashText(stableJson(identity), this.cryptoProvider);
      const cached = await this.readCache("rerank", cacheKey, config.rerankerSignature);
      if (cached) return { ranked: this.validateRanking({ ok: true, ranked: cached, configurationSignature: config.rerankerSignature }, config.rerankerSignature, submitted), cached: true };
      const response = await this.cloudApi.rerankKnowledgeCandidates({
        query,
        intent,
        candidates: submitted.map((candidate) => candidate.cloud),
        callContext: normalizeCallContext(options.callContext, "reranker"),
      }, options.signal);
      const ranked = this.validateRanking(response, config.rerankerSignature, submitted);
      await this.writeCache("rerank", cacheKey, config.rerankerSignature, ranked);
      return { ranked, cached: false, usage: response.usage || null, attempts: response.attempts || null };
    }

    async searchCloudDeep(query, options = {}) {
      const { limit } = resolveRetrievalLimits(options);
      const intent = String(options.intent || "scientific evidence retrieval").trim();
      if (
        typeof query !== "string" || !query.trim() || query.length > RETRIEVAL_LIMITS.queryCharacters ||
        !intent || intent.length > RETRIEVAL_LIMITS.intentCharacters
      ) {
        throw new KnowledgeServiceError(
          "INVALID_RETRIEVAL_INPUT",
          "The query or retrieval intent exceeds the existing retrieval budget."
        );
      }
      const diagnostics = { mode: "deep", planner: null, reranker: null };
      const sharedPlanQuery = String(options.sharedPlanQuery || query);
      const sharedCorpusPlan = options.sharedRetrievalPlan
        ? this.validateSharedCorpusPlan(
            options.sharedRetrievalPlan,
            sharedPlanQuery,
            intent
          )
        : null;
      if (options.sharedRetrievalPlan && !sharedCorpusPlan) {
        throw new KnowledgeServiceError(
          "INVALID_SHARED_CORPUS_PLAN",
          "The shared corpus retrieval plan is invalid or belongs to another question."
        );
      }
      let config;
      try {
        if (
          !sharedCorpusPlan &&
          (!this.cloudApi?.getKnowledgeRetrievalConfig ||
            !this.cloudApi?.planKnowledgeSearch ||
            !this.cloudApi?.rerankKnowledgeCandidates)
        ) {
          throw new KnowledgeServiceError("CLOUD_RETRIEVAL_UNAVAILABLE", "The authenticated Function Compute retrieval client is unavailable.");
        }
        config = sharedCorpusPlan?.status === "ready"
          ? this.validateCloudConfig({
              ok: true,
              schemaVersion: sharedCorpusPlan.schemaVersion,
              searchPlanPromptVersion: sharedCorpusPlan.promptVersion,
              rerankPromptVersion: sharedCorpusPlan.rerankPromptVersion,
              plannerSignature: sharedCorpusPlan.configurationSignature,
              rerankerSignature: sharedCorpusPlan.rerankerConfigurationSignature,
            })
          : sharedCorpusPlan
            ? null
            : this.validateCloudConfig(await this.cloudApi.getKnowledgeRetrievalConfig(options.signal));
      } catch (error) {
        if (error?.code === "OPERATION_ABORTED" || error?.name === "AbortError") {
          throw error?.code === "OPERATION_ABORTED" ? error : operationAbortedError();
        }
        this.emit({ stage: "retrieval-local-fallback" });
        const local = await this.searchLocal(query, { ...options, mode: "fast" });
        return {
          ...local,
          mode: "deep",
          diagnostics: {
            ...local.diagnostics,
            mode: "deep",
            fallback: "local-lexical-fusion",
            planner: sanitizeDiagnostic(error, "Cloud search planning was unavailable."),
            reranker: { status: "not-attempted" },
          },
        };
      }

      let plan = null;
      try {
        if (sharedCorpusPlan) {
          plan = {
            queries: [...sharedCorpusPlan.queries],
            identifiers: [...sharedCorpusPlan.identifiers],
            sourceLanguage: sharedCorpusPlan.sourceLanguage,
            reasoningSummary: "Validated workflow-shared corpus retrieval plan.",
          };
          diagnostics.planner = {
            status: sharedCorpusPlan.status,
            cached: true,
            shared: true,
            cacheKey: sharedCorpusPlan.cacheKey,
            sourceLanguage: sharedCorpusPlan.sourceLanguage,
          };
        } else {
          this.emit({ stage: "planning-expanded-queries" });
          const planned = await this.getSearchPlan(query, intent, options, config);
          plan = planned.plan;
          if (planned.cached) this.emit({ stage: "retrieval-cache-hit" });
          diagnostics.planner = {
            status: "succeeded",
            cached: planned.cached,
            sourceLanguage: plan.sourceLanguage,
            reasoningSummary: plan.reasoningSummary,
            usage: planned.usage || null,
            attempts: planned.attempts || null,
          };
        }
      } catch (error) {
        if (error?.code === "OPERATION_ABORTED") throw error;
        this.emit({ stage: "retrieval-local-fallback" });
        diagnostics.planner = {
          status: "failed",
          ...sanitizeDiagnostic(error, "Cloud search planning failed."),
        };
      }

      const searchQueries = [];
      const seenQueries = new Set();
      for (const value of [
        ...(sharedCorpusPlan?.useOriginalQuery === false ? [] : [query]),
        ...(plan?.queries || []),
        ...(plan?.identifiers || []),
      ]) {
        const candidate = String(value || "").trim();
        if (!candidate || seenQueries.has(candidate)) continue;
        seenQueries.add(candidate);
        searchQueries.push(candidate);
      }
      const fused = await this.fuseLexicalQueries(searchQueries, options);
      if (sharedCorpusPlan?.status === "local-fallback") {
        return {
          mode: "deep",
          collections: options.collections || [],
          results: fused.slice(0, limit).map((entry) => entry.result),
          diagnostics: {
            ...diagnostics,
            fallback: "local-lexical-fusion",
            reranker: { status: "not-attempted", reason: "workflow-planner-fallback" },
          },
        };
      }
      const built = await this.buildCloudCandidates(fused, query, intent);
      if (!built.submitted.length) {
        return {
          mode: "deep",
          collections: options.collections || [],
          results: fused.slice(0, limit).map((entry) => entry.result),
          diagnostics: {
            ...diagnostics,
            fallback: "local-lexical-fusion",
            reranker: { status: "not-attempted", reason: "no-budgeted-candidates" },
          },
        };
      }

      try {
        this.emit({ stage: "reranking-evidence" });
        const reranked = await this.getRanking(query, intent, options, config, built.submitted);
        if (reranked.cached) this.emit({ stage: "retrieval-cache-hit" });
        const byId = new Map(built.candidates.map((candidate) => [candidate.candidateId, candidate]));
        const rankedIds = new Set(reranked.ranked.map((item) => item.candidateId));
        const ordered = [
          ...reranked.ranked.map((item) => {
            const candidate = byId.get(item.candidateId);
            return {
              ...candidate.result,
              score: item.score,
              cloudRerank: { score: item.score, reason: item.reason },
            };
          }),
          ...built.candidates
            .filter((candidate) => !rankedIds.has(candidate.candidateId))
            .map((candidate) => candidate.result),
        ];
        diagnostics.reranker = {
          status: "succeeded",
          cached: reranked.cached,
          submittedCandidates: built.submitted.length,
          omittedCandidates: built.candidates.length - built.submitted.length,
          evidenceCharacters: built.evidenceCharacters,
          usage: reranked.usage || null,
          attempts: reranked.attempts || null,
        };
        return {
          mode: "deep",
          collections: options.collections || [],
          results: ordered.slice(0, limit),
          diagnostics,
        };
      } catch (error) {
        if (error?.code === "OPERATION_ABORTED" || error?.name === "AbortError") {
          throw error?.code === "OPERATION_ABORTED" ? error : operationAbortedError();
        }
        this.emit({ stage: "retrieval-local-fallback" });
        return {
          mode: "deep",
          collections: options.collections || [],
          results: fused.slice(0, limit).map((entry) => entry.result),
          diagnostics: {
            ...diagnostics,
            fallback: "local-lexical-fusion",
            reranker: {
              status: "failed",
              ...sanitizeDiagnostic(error, "Cloud reranking failed."),
            },
          },
        };
      }
    }

    async search(query, options = {}) {
      if (!this.available) return { results: [], fallbackRequired: true };
      const mode = ["fast", "semantic", "deep"].includes(options.mode) ? options.mode : "fast";
      this.emit({
        stage: mode === "deep" ? "cloud-retrieval" : "searching-local-evidence",
        mode,
      });
      try {
        let result;
        if (mode === "deep") {
          result = await this.searchCloudDeep(query, options);
        } else if (mode === "semantic" && !this.allowLocalSemantic) {
          const local = await this.searchLocal(query, { ...options, mode: "fast" });
          result = {
            ...local,
            mode: "semantic",
            diagnostics: {
              ...local.diagnostics,
              mode: "semantic",
              fallback: "local-lexical",
              localSemanticDisabled: true,
            },
          };
        } else {
          result = await this.searchLocal(query, { ...options, mode });
        }
        this.lastStatus = { ...(this.lastStatus || {}), lastSearch: result.diagnostics };
        this.emit({ stage: "ready", mode, diagnostics: result.diagnostics });
        return result;
      } catch (error) {
        this.emit({ stage: "search-fallback", mode, error });
        throw error;
      }
    }

    async searchLex(query, options = {}) { return this.search(query, { ...options, mode: "fast" }); }
    async searchVector(query, options = {}) { return this.search(query, { ...options, mode: "semantic" }); }
    async searchHybrid(query, options = {}) { return this.search(query, { ...options, mode: "deep" }); }
    async searchLiterature(input = {}) {
      return this.search(input.query, {
        ...input,
        mode: ["fast", "semantic", "deep"].includes(input.mode) ? input.mode : "fast",
        collections: input.collections || [COLLECTIONS.literatureEvidence],
        intent: input.intent || "scientific paper evidence",
      });
    }
    async searchProjectMemory(input = {}) { return this.search(input.query, { ...input, collections: [COLLECTIONS.projectMemory] }); }
    async searchPreviousSyntheses(input = {}) { return this.search(input.query, { ...input, collections: [COLLECTIONS.syntheses] }); }
    async searchExperimentSources(input = {}) { return this.search(input.query, { ...input, collections: [COLLECTIONS.experimentNotes] }); }
    async searchTopics(input = {}) { return this.search(input.query, { ...input, collections: [COLLECTIONS.topics] }); }

    async getDocument(pathOrDocid, options = {}) {
      if (!this.available) return null;
      return this.desktop.knowledge.document({ pathOrDocid, includeBody: options.includeBody === true });
    }

    async getDocumentRange(pathOrDocid, options = {}) {
      if (!this.available) return null;
      return this.desktop.knowledge.document({ pathOrDocid, fromLine: options.fromLine, maxLines: options.maxLines });
    }

    async refreshSource(collection, options = {}) { return this.indexDocuments(collection, options); }
    async removeSource(collection, options = {}) { return this.indexDocuments(collection, options); }

    async status() {
      if (!this.workspaceId || !this.available) return { available: false };
      try {
        this.lastStatus = await this.desktop.knowledge.status();
        this.available = this.lastStatus?.available === true;
        return this.lastStatus;
      } catch (error) {
        this.available = false;
        this.lastError = error;
        return { available: false, error: { code: error.code, message: error.message } };
      }
    }

    async close() {
      this.available = false;
      this.stopProgress?.();
      this.stopProgress = null;
      this.searchPlanInFlight.clear();
      this.resolvedSearchPlans.clear();
      this.listeners.clear();
    }
  }

  function createKnowledgeService(options = {}) {
    return options.desktop || root?.biodesignDesktop
      ? new ElectronQmdKnowledgeService(options)
      : new LocalQmdKnowledgeService(options);
  }

  return {
    KNOWLEDGE_COLLECTIONS: COLLECTIONS,
    KnowledgeService,
    KnowledgeServiceError,
    ElectronQmdKnowledgeService,
    LocalQmdKnowledgeService,
    CORPUS_SHARED_PLAN_VERSION,
    CORPUS_SCIENTIFIC_DIMENSIONS,
    createSearchPlanCacheIdentity,
    isGenericCorpusReviewQuestion,
    normalizeCallContext,
    createKnowledgeService,
  };
});
