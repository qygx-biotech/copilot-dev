(function exposeRetrievalContract(root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.BioDesignRetrievalContract = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function retrievalContractFactory() {
  "use strict";

  // These values centralize limits that already existed in the Electron IPC,
  // QMD normalization, project-context, and FC context-router boundaries. The
  // cloud retrieval migration must not change their effective values.
  const RETRIEVAL_LIMITS = Object.freeze({
    queryCharacters: 20_000,
    intentCharacters: 1_000,
    paperScopeItems: 500,
    paperIdCharacters: 256,
    resultDefault: 10,
    resultMaximum: 100,
    candidateDefault: 40,
    candidateMaximum: 200,
    snippetCharacters: 1_200,
    titleCharacters: 500,
    evidenceHandleCharacters: 500,
    matchedSectionsPerPaper: 3,
    sourceCharactersPerEvidence: 5_000,
    totalEvidenceCharacters: 360_000,
    requestCharacters: 600_000,
    outputTextCharacters: 5_000,
  });

  const RETRIEVAL_COLLECTIONS = Object.freeze([
    "literature-evidence",
    "paper-cards",
    "topics",
    "syntheses",
    "experiment-notes",
    "project-memory",
  ]);

  const CLOUD_RETRIEVAL = Object.freeze({
    schemaVersion: 1,
    searchPlanPromptVersion: "cloud-search-plan-v2",
    rerankPromptVersion: "cloud-rerank-v1",
    cacheDirectory: ".biodesign/cache/cloud-retrieval",
  });

  function boundedRetrievalInteger(value, fallback, maximum) {
    const number = Number(value);
    return Math.min(maximum, Math.max(1, Number.isInteger(number) ? number : fallback));
  }

  function resolveRetrievalLimits(options = {}) {
    const limit = boundedRetrievalInteger(
      options.limit,
      RETRIEVAL_LIMITS.resultDefault,
      RETRIEVAL_LIMITS.resultMaximum
    );
    const candidateLimit = Math.max(
      limit,
      boundedRetrievalInteger(
        options.candidateLimit,
        RETRIEVAL_LIMITS.candidateDefault,
        RETRIEVAL_LIMITS.candidateMaximum
      )
    );
    return { limit, candidateLimit };
  }

  // Saved artifacts travel as bounded derived context, never as paper sources.
  const SAVED_ARTIFACT_LIMITS = Object.freeze({ items: 4, contentCharacters: 12000, sources: 500, serializedCharacters: 60000 });
  function sanitizeSavedArtifact(value, options = {}) {
    const object = (v) => v && typeof v === "object" && !Array.isArray(v);
    const text = (v, limit = 200) => typeof v === "string" ? v.slice(0, limit) : "";
    const id = (v) => typeof v === "string" && /^[A-Za-z0-9_-][A-Za-z0-9_.:-]{0,199}$/.test(v) ? v : "";
    if (!object(value) || !["synthesis", "topic"].includes(value.kind) || !id(value.artifactId)) return null;
    const snapshot = value.sourceSnapshot;
    // Refuse incomplete provenance instead of truncating the paper scope.
    if (!Array.isArray(snapshot) || !snapshot.length || snapshot.length > SAVED_ARTIFACT_LIMITS.sources ||
        snapshot.some(source => !object(source) || !id(source.sourceId))) return null;
    const sourceSnapshot = snapshot.map(source => {
      const saved = { sourceId: source.sourceId };
      for (const key of ["contentHash", "statSignature", "observedContentHash", "observedStatSignature", "preparedContentHash", "preparedStatSignature"]) {
        if (typeof source[key] === "string" || source[key] === null) saved[key] = source[key] === null ? null : text(source[key]);
      }
      if (typeof source.path === "string" && !/^(?:\/|[A-Za-z]:)/.test(source.path) &&
          !source.path.replaceAll("\\", "/").split("/").includes("..")) saved.path = text(source.path, 500);
      if (typeof source.changedDuringPreparation === "boolean") saved.changedDuringPreparation = source.changedDuringPreparation;
      return saved;
    });
    const ids = new Set(sourceSnapshot.map(source => source.sourceId));
    const scopes = options.paperScopes || [];
    if (scopes.some(scope => scope?.length && [...ids].some(sourceId => !scope.includes(sourceId)))) return null;
    if (options.filesOnly && !scopes.some(scope => scope?.length)) return null;
    const versions = object(value.sourceVersions) ? Object.entries(value.sourceVersions) : [];
    if (versions.length > SAVED_ARTIFACT_LIMITS.sources || versions.some(([key]) => !ids.has(key))) return null;
    const sourceVersions = Object.fromEntries(versions.map(([key, hash]) => [key, text(hash)]));
    const currentSources = new Map((options.paperSources || []).map(source => [source.sourceId, source]));
    const changedSourceIds = sourceSnapshot.filter(snapshotSource => {
      const source = currentSources.get(snapshotSource.sourceId);
      const hash = sourceVersions[snapshotSource.sourceId] || snapshotSource.preparedContentHash || snapshotSource.contentHash || snapshotSource.observedContentHash;
      return !source || ["missing", "deleted", "removed", "dirty", "stale"].includes(source.catalogStatus) ||
        !hash || !source.contentHash || hash !== source.contentHash;
    }).map(source => source.sourceId);
    const status = text(value.status, 80) || "unknown";
    const stale = value.stale === true || changedSourceIds.length > 0 || !["ready", "completed"].includes(status);
    const coverage = {};
    if (object(value.coverage)) for (const [key, v] of Object.entries(value.coverage)) {
      if (/^papers(?:Discovered|IncludedInSnapshot|SuccessfullyPrepared|PreparationCacheHits|SuccessfullyAnalyzed|Failed|Missing|Excluded)$/.test(key) && Number.isFinite(v)) coverage[key] = Math.max(0, v);
      if (["includedPaperIds", "preparedPaperIds", "analyzedPaperIds", "failedPaperIds", "missingPaperIds", "changedPaperIds"].includes(key) && Array.isArray(v)) {
        if (v.length > SAVED_ARTIFACT_LIMITS.sources || v.some(sourceId => !ids.has(sourceId))) return null;
        coverage[key] = [...v];
      }
    }
    const artifact = {
      artifactId: value.artifactId, kind: value.kind, authoritative: false,
      sourceSnapshot, sourceVersions, coverage, status, stale,
      changedSourceIds, staleReason: text(value.staleReason, 500),
      staleSourceIds: (Array.isArray(value.staleSourceIds) ? value.staleSourceIds : []).filter(sourceId => ids.has(sourceId)).slice(0, SAVED_ARTIFACT_LIMITS.sources),
      verificationStatus: ["partially_verified", "unverified"].includes(value.verificationStatus) ? value.verificationStatus : "unverified",
      createdAt: text(value.createdAt, 100), updatedAt: text(value.updatedAt, 100),
      corpusVersion: text(value.corpusVersion), parentSynthesisId: id(value.parentSynthesisId),
      summaryVersion: text(value.summaryVersion),
      ...(object(value.wikiGeneration) ? { wikiGeneration: {
        schemaVersion: Number(value.wikiGeneration.schemaVersion) || 0,
        promptVersion: text(value.wikiGeneration.promptVersion), evidenceVersion: text(value.wikiGeneration.evidenceVersion), modelSignature: text(value.wikiGeneration.modelSignature),
      } } : {}),
      content: text(value.content, SAVED_ARTIFACT_LIMITS.contentCharacters),
      truncated: value.truncated === true || String(value.content || "").length > SAVED_ARTIFACT_LIMITS.contentCharacters,
    };
    return JSON.stringify(artifact).length <= SAVED_ARTIFACT_LIMITS.serializedCharacters ? artifact : null;
  }

  return {
    CLOUD_RETRIEVAL,
    RETRIEVAL_COLLECTIONS,
    RETRIEVAL_LIMITS,
    resolveRetrievalLimits,
    SAVED_ARTIFACT_LIMITS,
    sanitizeSavedArtifact,
  };
});
