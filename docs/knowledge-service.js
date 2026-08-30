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

  function stableJson(value) {
    if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
    if (value && typeof value === "object") {
      return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
    }
    return JSON.stringify(value);
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
      if (!this.workspace?.writeJson) return;
      const path = `${CLOUD_RETRIEVAL.cacheDirectory}/${kind}-${cacheKey}.json`;
      await this.workspace.writeJson(path, {
        schemaVersion: CLOUD_RETRIEVAL.schemaVersion,
        kind,
        cacheKey,
        configurationSignature,
        value,
      }).catch(() => {});
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

    async getSearchPlan(query, intent, options, config) {
      const identity = {
        normalizedQuery: query.normalize("NFKC").replace(/\s+/g, " ").trim(),
        retrievalIntent: intent,
        paperScope: [...new Set(options.paperIds || [])].sort(),
        collectionScope: [...new Set(options.collections || [])].sort(),
        retrieval: resolveRetrievalLimits(options),
        modelSignature: config.plannerSignature,
        schemaVersion: CLOUD_RETRIEVAL.schemaVersion,
        promptVersion: CLOUD_RETRIEVAL.searchPlanPromptVersion,
      };
      const cacheKey = await hashText(stableJson(identity), this.cryptoProvider);
      const cached = await this.readCache("search-plan", cacheKey, config.plannerSignature);
      if (cached) return { plan: this.validateSearchPlan({ ok: true, plan: cached, configurationSignature: config.plannerSignature }, config.plannerSignature), cached: true };
      const response = await this.cloudApi.planKnowledgeSearch({ query, intent }, options.signal);
      const plan = this.validateSearchPlan(response, config.plannerSignature);
      await this.writeCache("search-plan", cacheKey, config.plannerSignature, plan);
      return { plan, cached: false, usage: response.usage || null, attempts: response.attempts || null };
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
      let config;
      try {
        if (!this.cloudApi?.getKnowledgeRetrievalConfig || !this.cloudApi?.planKnowledgeSearch || !this.cloudApi?.rerankKnowledgeCandidates) {
          throw new KnowledgeServiceError("CLOUD_RETRIEVAL_UNAVAILABLE", "The authenticated Function Compute retrieval client is unavailable.");
        }
        config = this.validateCloudConfig(await this.cloudApi.getKnowledgeRetrievalConfig(options.signal));
      } catch (error) {
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
        const planned = await this.getSearchPlan(query, intent, options, config);
        plan = planned.plan;
        diagnostics.planner = {
          status: "succeeded",
          cached: planned.cached,
          sourceLanguage: plan.sourceLanguage,
          reasoningSummary: plan.reasoningSummary,
          usage: planned.usage || null,
          attempts: planned.attempts || null,
        };
      } catch (error) {
        diagnostics.planner = {
          status: "failed",
          ...sanitizeDiagnostic(error, "Cloud search planning failed."),
        };
      }

      const searchQueries = [];
      const seenQueries = new Set();
      for (const value of [query, ...(plan?.queries || []), ...(plan?.identifiers || [])]) {
        const candidate = String(value || "").trim();
        if (!candidate || seenQueries.has(candidate)) continue;
        seenQueries.add(candidate);
        searchQueries.push(candidate);
      }
      const fused = await this.fuseLexicalQueries(searchQueries, options);
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
        const reranked = await this.getRanking(query, intent, options, config, built.submitted);
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
      this.emit({ stage: mode === "deep" ? "cloud-retrieval" : "searching", mode });
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
    createKnowledgeService,
  };
});
