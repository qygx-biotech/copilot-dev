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
    searchPlanPromptVersion: "cloud-search-plan-v1",
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

  return {
    CLOUD_RETRIEVAL,
    RETRIEVAL_COLLECTIONS,
    RETRIEVAL_LIMITS,
    resolveRetrievalLimits,
  };
});
