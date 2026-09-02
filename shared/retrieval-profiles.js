(function exposeRetrievalProfiles(root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.BioDesignRetrievalProfiles = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function retrievalProfilesFactory() {
  "use strict";

  const RETRIEVAL_PROFILES = Object.freeze(["light", "medium", "high"]);
  const RETRIEVAL_PROFILE_SET = new Set(RETRIEVAL_PROFILES);
  const PROFILE_DESCRIPTIONS = Object.freeze({
    light: Object.freeze({
      en: "Lower cost, mostly local",
      zh: "成本较低，主要使用本地检索",
    }),
    medium: Object.freeze({
      en: "Fast first, Deep when useful",
      zh: "先快速检索，必要时使用深度检索",
    }),
    high: Object.freeze({
      en: "Maximum relevant retrieval quality",
      zh: "在相关范围内提供最高检索质量",
    }),
  });

  const HAN_PATTERN = /[\u3400-\u9fff]/u;
  const CROSS_LANGUAGE_PATTERN =
    /[\u3040-\u30ff\u3400-\u9fff\uac00-\ud7af\u0400-\u04ff\u0600-\u06ff]/u;
  const CONCEPTUAL_PATTERN =
    /\b(?:concept|conceptual|semantic|topic|theme|strategy|strategies|approach|approaches|compare|comparison|contrast|landscape|survey|review|discover|discovery|find literature|related work|state of the art|broad|mechanism|trend|trends|what is known|how does|why does|explain)\b|概念|语义|主题|策略|方法|比较|对比|综述|发现文献|相关研究|研究现状|机制|趋势|为什么|如何/u;
  const DOI_PATTERN = /\b10\.\d{4,9}\/[\w.()/:+-]+\b/giu;
  const MUTATION_PATTERN = /\b(?:p\.)?[A-Z][a-z]{0,2}\d{1,6}[A-Z*][a-z]{0,2}\b/gu;
  const KINETIC_PATTERN = /\b(?:kcat|k_cat|km|k_m)\b/giu;
  const EC_PATTERN = /\bEC\s*\d{1,3}(?:\.\d{1,3}){1,3}\b/giu;
  const STRAIN_PATTERN =
    /\b(?:ATCC|DSM|JCM|NCIMB|NCTC|BL21|K-?12|MG1655)[\w().-]*\b/giu;
  const IDENTIFIER_PATTERN =
    /\b(?:[A-Za-z]{1,8}\d{1,6}|[a-z]{2,8}[A-Z][A-Za-z0-9-]{0,8}|[A-Z][a-z]{1,7}[A-Z][A-Za-z0-9-]{0,8})\b/gu;
  const AUTHOR_YEAR_PATTERN =
    /\b([A-Z][A-Za-z'\-]{2,})(?:\s+et\s+al\.?)?[^\d]{0,20}((?:19|20)\d{2})\b/gu;
  const QUOTED_PATTERN = /["“]([^"”]{8,180})["”]/gu;
  const STOP_WORDS = new Set([
    "a", "about", "all", "an", "and", "are", "as", "at", "be", "by", "can",
    "does", "for", "from", "how", "in", "into", "is", "it", "literature", "of",
    "on", "or", "paper", "papers", "please", "show", "study", "that", "the", "their",
    "these", "this", "to", "using", "was", "what", "when", "where", "which", "with",
  ]);

  function isValidRetrievalProfile(value) {
    return typeof value === "string" && RETRIEVAL_PROFILE_SET.has(value);
  }

  function normalizeRetrievalProfile(value) {
    return isValidRetrievalProfile(value) ? value : "light";
  }

  function containsHan(query) {
    return HAN_PATTERN.test(String(query || ""));
  }

  function isCrossLanguageQuery(query) {
    return CROSS_LANGUAGE_PATTERN.test(String(query || ""));
  }

  function normalizeText(value) {
    return String(value || "")
      .normalize("NFKC")
      .toLocaleLowerCase("en-US")
      .replace(/[^\p{L}\p{N}.()/_+*-]+/gu, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  function resultText(result) {
    return normalizeText([
      result?.title,
      result?.fileName,
      Array.isArray(result?.authors) ? result.authors.join(" ") : result?.authors,
      result?.year,
      Array.isArray(result?.identifiers) ? result.identifiers.join(" ") : result?.identifiers,
      result?.snippet,
      result?.abstract,
      result?.summary,
      ...(Array.isArray(result?.matchedSections)
        ? result.matchedSections.map((section) => section?.snippet || section?.text || "")
        : []),
    ].join(" "));
  }

  function usableFastResults(results) {
    return (Array.isArray(results) ? results : []).filter(resultText);
  }

  function collectMatches(pattern, value, map = (match) => match[0]) {
    pattern.lastIndex = 0;
    return [...String(value || "").matchAll(pattern)].map(map);
  }

  function exactMarkers(query) {
    const value = String(query || "");
    return [...new Set([
      ...collectMatches(DOI_PATTERN, value),
      ...collectMatches(MUTATION_PATTERN, value),
      ...collectMatches(KINETIC_PATTERN, value),
      ...collectMatches(EC_PATTERN, value),
      ...collectMatches(STRAIN_PATTERN, value),
      ...collectMatches(IDENTIFIER_PATTERN, value),
    ].map(normalizeText).filter(Boolean))];
  }

  function hasStrongExactMatch(query, results) {
    const usable = usableFastResults(results);
    if (!usable.length) return false;
    const texts = usable.map(resultText);
    const markers = exactMarkers(query);
    if (markers.length && texts.some((text) => markers.every((marker) => text.includes(marker)))) {
      return true;
    }

    const authorYears = collectMatches(
      AUTHOR_YEAR_PATTERN,
      query,
      (match) => [normalizeText(match[1]), normalizeText(match[2])]
    );
    if (
      authorYears.some(([author, year]) =>
        texts.some((text) => text.includes(author) && text.includes(year))
      )
    ) {
      return true;
    }

    const quotedTitles = collectMatches(QUOTED_PATTERN, query, (match) => normalizeText(match[1]));
    if (quotedTitles.some((title) => texts.some((text) => text.includes(title)))) return true;

    const normalizedQuery = normalizeText(query);
    const queryWordCount = normalizedQuery.split(" ").filter(Boolean).length;
    return queryWordCount >= 3 && queryWordCount <= 18 && usable.some((result) =>
      normalizeText(result?.title).includes(normalizedQuery)
    );
  }

  function meaningfulTerms(query) {
    return [...new Set(
      normalizeText(query)
        .split(" ")
        .map((term) => term.replace(/^\.+|\.+$/g, ""))
        .filter((term) => term.length >= 2 && !STOP_WORDS.has(term))
    )];
  }

  function hasCompleteLexicalCoverage(query, results) {
    const terms = meaningfulTerms(query);
    if (!terms.length) return false;
    return usableFastResults(results)
      .slice(0, 5)
      .map(resultText)
      .some((text) => terms.every((term) => text.includes(term)));
  }

  function isConceptualLiteratureQuery(query) {
    return CONCEPTUAL_PATTERN.test(String(query || ""));
  }

  function shouldEscalateFastResults(input = {}) {
    const query = String(input.query || "");
    const results = usableFastResults(input.results);
    if (isCrossLanguageQuery(query)) {
      return Object.freeze({ escalate: true, reason: "medium-cross-language" });
    }
    if (hasStrongExactMatch(query, results)) {
      return Object.freeze({ escalate: false, reason: "medium-strong-exact-match" });
    }
    if (isConceptualLiteratureQuery(query)) {
      return Object.freeze({ escalate: true, reason: "medium-conceptual-discovery" });
    }
    if (!results.length) {
      return Object.freeze({ escalate: true, reason: "medium-no-usable-fast-results" });
    }
    if (hasCompleteLexicalCoverage(query, results)) {
      return Object.freeze({ escalate: false, reason: "medium-complete-lexical-coverage" });
    }
    return Object.freeze({ escalate: true, reason: "medium-insufficient-lexical-coverage" });
  }

  function selectRetrievalProfile(profile, input = {}) {
    const normalized = normalizeRetrievalProfile(profile);
    const query = String(input.query || "");
    if (normalized === "light") {
      const deep = containsHan(query);
      return Object.freeze({
        profile: normalized,
        mode: deep ? "deep" : "fast",
        escalated: deep,
        reason: deep ? "light-han-deep" : "light-non-han-fast",
      });
    }
    if (normalized === "high") {
      return Object.freeze({
        profile: normalized,
        mode: "deep",
        escalated: true,
        reason: "high-relevant-deep",
      });
    }
    if (!Object.prototype.hasOwnProperty.call(input, "fastResults")) {
      return Object.freeze({
        profile: normalized,
        mode: "fast",
        escalated: false,
        needsFastResults: true,
        reason: "medium-fast-first",
      });
    }
    const decision = shouldEscalateFastResults({ query, results: input.fastResults });
    return Object.freeze({
      profile: normalized,
      mode: decision.escalate ? "deep" : "fast",
      escalated: decision.escalate,
      reason: decision.reason,
    });
  }

  function qualityModeForProfile(profile) {
    return normalizeRetrievalProfile(profile) === "high" ? "high_fidelity" : "balanced";
  }

  return Object.freeze({
    PROFILE_DESCRIPTIONS,
    RETRIEVAL_PROFILES,
    containsHan,
    hasCompleteLexicalCoverage,
    hasStrongExactMatch,
    isConceptualLiteratureQuery,
    isCrossLanguageQuery,
    isValidRetrievalProfile,
    normalizeRetrievalProfile,
    qualityModeForProfile,
    selectRetrievalProfile,
    shouldEscalateFastResults,
  });
});
