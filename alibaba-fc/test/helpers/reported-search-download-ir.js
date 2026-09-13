"use strict";

// Exact model result supplied in the routing regression report (2026-09-12).
const query = "检索AI和合成生物学结合的文章，并下载到本地。";
const ir = {
  answerLanguage: "zh", capabilityHints: ["search_papers", "download_sources"], comparisonVariables: [], constraints: [],
  entities: [{ canonicalId: "AI", mention: "AI", type: "technology" }, { canonicalId: "synthetic_biology", mention: "合成生物学", type: "field" }],
  filters: [], goal: "Search for papers combining AI and synthetic biology and download them to the local workspace.",
  inputLanguage: "zh", matchedPattern: "literature.search", metrics: [], objects: ["papers"], operations: ["search", "store"],
  patternConfidence: 0.95, requestedOutput: { limit: null, type: "papers" }, retrievalScope: "web",
  scope: { experiments: null, papers: null }, unresolvedSlots: [], version: 1,
};
module.exports = { query, ir };
