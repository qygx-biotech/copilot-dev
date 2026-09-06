(function exposeLiteratureModule(root, factory) {
  const api = factory(root);
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) Object.assign(root, api);
})(typeof globalThis !== "undefined" ? globalThis : this, function literatureFactory(root) {
  "use strict";

  const sourceSystemApi = root?.createSourceSystem
    ? root
    : typeof require === "function"
      ? require("./source-system.js")
      : {};

  const LITERATURE_CONFIG = Object.freeze({
    chunkCharacters: 10000,
    chunkOverlap: 400,
    chunkConcurrency: 2,
    maxExtractedCharacters: 180000,
    minimumReadableCharacters: 200,
    maxChunks: 48,
    maxRouterPapers: 100,
    maxRouterQueryCharacters: 24000,
  });
  const PAPER_CARD_VERSION = 2;
  const PAPER_CARD_PROMPT_VERSION = "canonical-paper-card-v2";
  const PAPER_CARD_GENERATION_STRATEGY = "native-pdf-preferred-v1";
  const NATIVE_PAPER_CARD_SCHEMA_VERSION = 1;
  const NATIVE_PAPER_CARD_PROMPT_VERSION = "canonical-paper-card-native-v1";
  const DEFAULT_NATIVE_PDF_MAX_BYTES = 20 * 1024 * 1024;
  const SOURCE_ARTIFACT_SCHEMA_VERSION = 1;
  const SOURCE_EXTRACTOR_VERSION = "local-source-v1";
  const makePaperCardCacheKey = sourceSystemApi.paperCardCacheKey || ((input = {}) =>
    JSON.stringify({
      version: 3,
      sourceId: String(input.sourceId || ""),
      contentHash: String(input.contentHash || ""),
      schemaVersion: Number(input.schemaVersion) || 0,
      modelSignature: String(input.modelSignature || input.configurationSignature || input.model || "unspecified"),
      promptVersion: String(input.promptVersion || "unspecified"),
      generationStrategy: String(
        input.generationStrategy || "text-map-reduce-v1"
      ),
      nativePdfSchemaVersion: Number(input.nativePdfSchemaVersion) || 0,
      nativePdfPromptVersion: String(
        input.nativePdfPromptVersion || "not-applicable"
      ),
      nativePdfModelSignature: String(
        input.nativePdfModelSignature || "not-applicable"
      ),
      sourceArtifactSchemaVersion: Number(input.sourceArtifactSchemaVersion) || 0,
      extractorVersion: String(input.extractorVersion || "unspecified"),
    }));

  class LiteratureError extends Error {
    constructor(code, message, cause = null) {
      super(message, cause ? { cause } : undefined);
      this.name = "LiteratureError";
      this.code = code;
      if (cause && !this.cause) this.cause = cause;
    }
  }

  function normalizeText(text) {
    return String(text || "")
      .replace(/\u0000/g, "")
      .replace(/\r\n?/g, "\n")
      .replace(/[ \t]+\n/g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
  }

  function chunkLiteratureText(text, config = LITERATURE_CONFIG) {
    const normalized = normalizeText(text);
    const source = normalized.slice(0, config.maxExtractedCharacters);
    const chunks = [];
    let start = 0;

    while (start < source.length && chunks.length < config.maxChunks) {
      let end = Math.min(start + config.chunkCharacters, source.length);
      if (end < source.length) {
        const paragraphBreak = source.lastIndexOf("\n\n", end);
        const sentenceBreak = Math.max(
          source.lastIndexOf(". ", end),
          source.lastIndexOf("。", end),
          source.lastIndexOf("? ", end),
          source.lastIndexOf("! ", end)
        );
        const preferredBreak = Math.max(paragraphBreak, sentenceBreak);
        if (preferredBreak > start + config.chunkCharacters * 0.6) {
          end = preferredBreak + (preferredBreak === paragraphBreak ? 2 : 1);
        } else {
          const whitespace = source.lastIndexOf(" ", end);
          if (whitespace > start + config.chunkCharacters * 0.8) end = whitespace + 1;
        }
      }
      const chunk = source.slice(start, end).trim();
      if (chunk) chunks.push(chunk);
      if (end >= source.length) break;
      start = Math.max(start + 1, end - config.chunkOverlap);
    }

    const processedCharacters = chunks.length
      ? Math.min(source.length, start + chunks[chunks.length - 1].length)
      : 0;
    return {
      chunks,
      processedCharacters,
      truncated: normalized.length > source.length || processedCharacters < source.length,
    };
  }

  async function runWithConcurrency(items, concurrency, mapper) {
    const results = new Array(items.length);
    let nextIndex = 0;
    const worker = async () => {
      while (nextIndex < items.length) {
        const index = nextIndex;
        nextIndex += 1;
        results[index] = await mapper(items[index], index);
      }
    };
    await Promise.all(
      Array.from({ length: Math.min(Math.max(1, concurrency), items.length) }, worker)
    );
    return results;
  }

  function assertNotAborted(signal) {
    if (signal?.aborted) {
      throw new LiteratureError("OPERATION_ABORTED", "The literature operation was stopped.");
    }
  }

  function boundedCallContext(value = {}, callRole, paperId = "") {
    const boundedId = (input) => {
      const text = String(input || "").trim();
      return /^[A-Za-z0-9._:-]{1,200}$/.test(text) ? text : "";
    };
    return {
      turnId: boundedId(value?.turnId),
      workflowId: boundedId(value?.workflowId),
      callRole,
      paperId: boundedId(paperId || value?.paperId),
      profile: ["light", "medium", "high"].includes(value?.profile)
        ? value.profile
        : "light",
    };
  }

  function classifyPdfError(error) {
    if (error instanceof LiteratureError) return error;
    if (error?.name === "PasswordException" || /password|encrypted/i.test(error?.message || "")) {
      return new LiteratureError(
        "ENCRYPTED_PDF",
        "This PDF is encrypted or password-protected and cannot be processed.",
        error
      );
    }
    if (["InvalidPDFException", "FormatError"].includes(error?.name)) {
      return new LiteratureError("MALFORMED_PDF", "This PDF is malformed or could not be parsed.", error);
    }
    return new LiteratureError("PDF_PARSE_FAILED", "PDF text extraction failed.", error);
  }

  async function extractLocalPdf(file, pdfjsLib, options = {}) {
    const config = { ...LITERATURE_CONFIG, ...options };
    if (!pdfjsLib?.getDocument) {
      throw new LiteratureError("PDF_PARSER_MISSING", "The browser PDF parser is not available.");
    }
    if (!file || Number(file.size) <= 0) {
      throw new LiteratureError("EMPTY_PDF", "The selected PDF is empty.");
    }

    let pdf;
    try {
      if (pdfjsLib.GlobalWorkerOptions && options.workerSrc) {
        pdfjsLib.GlobalWorkerOptions.workerSrc = options.workerSrc;
      }
      const buffer = options.preloadedBytes
        ? options.preloadedBytes.buffer.slice(
            options.preloadedBytes.byteOffset,
            options.preloadedBytes.byteOffset + options.preloadedBytes.byteLength
          )
        : await file.arrayBuffer();
      pdf = await pdfjsLib.getDocument({ data: buffer }).promise;
      const pageTexts = [];
      let collectedCharacters = 0;
      let extractionTruncated = false;

      for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
        assertNotAborted(options.signal);
        const page = await pdf.getPage(pageNumber);
        const content = await page.getTextContent();
        const pageText = normalizeText(
          content.items
            .map((item) => `${item.str || ""}${item.hasEOL ? "\n" : " "}`)
            .join("")
        );
        if (pageText) {
          const available = Math.max(0, config.maxExtractedCharacters - collectedCharacters);
          if (available <= 0) {
            extractionTruncated = true;
            break;
          }
          pageTexts.push(`# Page ${pageNumber}\n${pageText.slice(0, available)}`);
          collectedCharacters += Math.min(pageText.length, available);
          if (pageText.length > available) {
            extractionTruncated = true;
            break;
          }
        }
      }

      const text = normalizeText(pageTexts.join("\n\n"));
      if (text.length < config.minimumReadableCharacters) {
        throw new LiteratureError(
          "NO_MACHINE_READABLE_TEXT",
          "No machine-readable text was found in this PDF. OCR support is not implemented yet."
        );
      }

      let metadataTitle = null;
      try {
        const metadata = await pdf.getMetadata();
        const title = String(metadata?.info?.Title || "").replace(/\s+/g, " ").trim();
        if (title && !/^untitled$/i.test(title) && title.length <= 300) metadataTitle = title;
      } catch {
        metadataTitle = null;
      }

      return {
        text,
        pageCount: Number(pdf.numPages) || null,
        metadataTitle,
        truncated: extractionTruncated,
      };
    } catch (error) {
      throw classifyPdfError(error);
    } finally {
      if (typeof pdf?.destroy === "function") await pdf.destroy().catch(() => {});
    }
  }

  function safeFilename(value) {
    return String(value || "paper.pdf").split(/[\\/]/).pop().slice(0, 240) || "paper.pdf";
  }

  function bytesToBase64(bytes) {
    const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes || []);
    if (typeof Buffer !== "undefined") return Buffer.from(view).toString("base64");
    let binary = "";
    const chunkSize = 0x8000;
    for (let offset = 0; offset < view.length; offset += chunkSize) {
      binary += String.fromCharCode(...view.subarray(offset, offset + chunkSize));
    }
    return root.btoa(binary);
  }

  function normalizeCardText(value) {
    const text = typeof value === "string" ? value.trim() : "";
    return text || null;
  }

  function normalizeCardList(value, limit = 30) {
    const values = Array.isArray(value)
      ? value
      : typeof value === "string" && value.trim()
        ? [value]
        : [];
    return [...new Set(
      values
        .filter((item) => typeof item === "string" && item.trim())
        .map((item) => item.trim().slice(0, 1200))
    )].slice(0, limit);
  }

  function canonicalEvidenceFindings(claims, paperArtifact, sourceId) {
    const chunks = Array.isArray(paperArtifact?.chunks) ? paperArtifact.chunks : [];
    const seen = new Set();
    return normalizeCardList(claims, 20).map((claim) => {
      const normalizedClaim = claim.toLowerCase().replace(/\s+/g, " ").trim();
      const matches = chunks
        .filter((chunk) => {
          const page = Number(chunk?.page);
          const chunkId = String(chunk?.chunkId || "");
          return normalizedClaim &&
            Number.isInteger(page) &&
            page > 0 &&
            chunkId &&
            String(chunk.text || "").toLowerCase().replace(/\s+/g, " ")
              .includes(normalizedClaim);
        })
        .sort((left, right) =>
          Number(left.page) - Number(right.page) ||
          String(left.chunkId).localeCompare(String(right.chunkId))
        )
        .map((chunk) =>
          `${sourceId}:p${Number(chunk.page)}:${String(chunk.chunkId).slice(0, 256)}`
        )
        .filter((reference) => {
          if (seen.has(`${claim}\n${reference}`)) return false;
          seen.add(`${claim}\n${reference}`);
          return true;
        })
        .slice(0, 3);
      return { claim, evidenceRefs: matches };
    });
  }

  function normalizeEvidenceQuote(value) {
    return String(value || "")
      .normalize("NFKC")
      .replace(/[\u2018\u2019]/g, "'")
      .replace(/[\u201c\u201d]/g, '"')
      .replace(/[\u2010-\u2015]/g, "-")
      .replace(/\s+/g, " ")
      .trim()
      .toLocaleLowerCase("en-US");
  }

  function validatedNativeEvidenceFindings(findings, paperArtifact, sourceId) {
    const pages = new Map(
      (Array.isArray(paperArtifact?.pages) ? paperArtifact.pages : [])
        .filter((page) => Number.isInteger(Number(page?.page)) && Number(page.page) > 0)
        .map((page) => [Number(page.page), normalizeEvidenceQuote(page.text)])
    );
    const chunks = Array.isArray(paperArtifact?.chunks) ? paperArtifact.chunks : [];
    let submittedCitations = 0;
    let verifiedCitations = 0;
    const validatedFindings = (Array.isArray(findings) ? findings : [])
      .slice(0, 30)
      .map((finding) => {
        const claim = String(finding?.claim || "").trim().slice(0, 1600);
        if (!claim) return null;
        const evidenceRefs = [];
        const seen = new Set();
        for (const citation of (Array.isArray(finding?.citations) ? finding.citations : [])) {
          submittedCitations += 1;
          const page = Number(citation?.page);
          const quote = normalizeEvidenceQuote(citation?.quote);
          if (!Number.isInteger(page) || page < 1 || quote.length < 4) continue;
          if (!pages.get(page)?.includes(quote)) continue;
          const matchingChunk = chunks
            .filter((chunk) => Number(chunk?.page) === page && String(chunk?.chunkId || ""))
            .sort((left, right) =>
              String(left.chunkId).localeCompare(String(right.chunkId))
            )
            .find((chunk) => normalizeEvidenceQuote(chunk.text).includes(quote));
          if (!matchingChunk) continue;
          const reference = `${sourceId}:p${page}:${String(matchingChunk.chunkId).slice(0, 256)}`;
          if (!seen.has(reference)) {
            seen.add(reference);
            evidenceRefs.push(reference);
            verifiedCitations += 1;
          }
          if (evidenceRefs.length >= 3) break;
        }
        return { claim, evidenceRefs };
      })
      .filter(Boolean);
    return {
      findings: validatedFindings,
      submittedCitations,
      verifiedCitations,
      droppedCitations: submittedCitations - verifiedCitations,
    };
  }

  function nativePaperCardValidationErrors(result, expected = {}) {
    const errors = [];
    const analysis = result?.analysis;
    if (!analysis || typeof analysis !== "object" || Array.isArray(analysis)) {
      return ["analysis is missing"];
    }
    if (result.paperId !== expected.paperId) errors.push("paperId mismatch");
    if (result.contentHash !== expected.contentHash) errors.push("contentHash mismatch");
    if (analysis.sourceIdentity?.paperId !== expected.paperId) {
      errors.push("source identity paperId mismatch");
    }
    if (analysis.sourceIdentity?.contentHash !== expected.contentHash) {
      errors.push("source identity contentHash mismatch");
    }
    if (Number(result.schemaVersion) !== Number(expected.schemaVersion)) {
      errors.push("native schema version mismatch");
    }
    if (result.promptVersion !== expected.promptVersion) {
      errors.push("native prompt version mismatch");
    }
    if (result.modelSignature !== expected.modelSignature) {
      errors.push("native model signature mismatch");
    }
    const requiredLists = [
      "authors",
      "majorFindings",
      "methods",
      "organisms",
      "genes",
      "proteins",
      "pathways",
      "metabolites",
      "experimentalConditions",
      "measurements",
      "importantResults",
      "limitations",
      "keywords",
      "topics",
    ];
    for (const key of requiredLists) {
      if (!Array.isArray(analysis[key])) {
        errors.push(`${key} is missing`);
      } else if (
        !["majorFindings", "importantResults"].includes(key) &&
        analysis[key].some((item) => typeof item !== "string")
      ) {
        errors.push(`${key} contains a non-string value`);
      }
    }
    for (const key of ["majorFindings", "importantResults"]) {
      for (const finding of (Array.isArray(analysis[key]) ? analysis[key] : [])) {
        if (
          !finding ||
          typeof finding !== "object" ||
          Array.isArray(finding) ||
          typeof finding.claim !== "string" ||
          !finding.claim.trim() ||
          !Array.isArray(finding.citations)
        ) {
          errors.push(`${key} contains an invalid finding`);
          continue;
        }
        if (finding.citations.some((citation) =>
          !citation ||
          typeof citation !== "object" ||
          Array.isArray(citation) ||
          !Number.isInteger(Number(citation.page)) ||
          Number(citation.page) < 1 ||
          typeof citation.quote !== "string" ||
          !citation.quote.trim()
        )) errors.push(`${key} contains an invalid citation`);
      }
    }
    if (
      analysis.year !== null &&
      (!Number.isInteger(Number(analysis.year)) ||
        Number(analysis.year) < 1800 ||
        Number(analysis.year) > 2100)
    ) errors.push("year is invalid");
    if (
      !String(
        analysis.shortSummary ||
        analysis.researchQuestion ||
        analysis.mainConclusion ||
        analysis.majorFindings?.[0]?.claim ||
        ""
      ).trim()
    ) errors.push("canonical content is empty");
    return errors;
  }

  function createPaperDiscoveryRecord(card, filename) {
    const source = card && typeof card === "object" ? card : {};
    const year = Number(source.year);
    const identifiers = normalizeCardList(
      source.identifiers || [
        ...normalizeCardList(source.organisms),
        ...normalizeCardList(source.genes),
        ...normalizeCardList(source.proteins),
        ...normalizeCardList(source.pathways),
        ...normalizeCardList(source.metabolites),
      ],
      60
    );
    return {
      fileName: safeFilename(filename || source.fileName),
      title: normalizeCardText(source.title),
      authors: normalizeCardList(source.authors, 30),
      year:
        Number.isInteger(year) && year >= 1800 && year <= 2100 ? year : null,
      topics: normalizeCardList(source.topics, 30),
      keywords: normalizeCardList(source.keywords, 40),
      identifiers,
      shortDescription: String(
        source.shortDescription || source.shortSummary || source.summary || ""
      )
        .trim()
        .slice(0, 1600),
    };
  }

  async function hashLiteratureFile(file, cryptoProvider = root.crypto) {
    const bytes = new Uint8Array(await file.arrayBuffer());
    if (cryptoProvider?.subtle?.digest) {
      const digest = await cryptoProvider.subtle.digest("SHA-256", bytes);
      const hex = [...new Uint8Array(digest)]
        .map((byte) => byte.toString(16).padStart(2, "0"))
        .join("");
      return `sha256:${hex}`;
    }

    // Deterministic fallback for older test/browser environments without
    // SubtleCrypto. It is used only for change detection, never for security.
    let hash = 0x811c9dc5;
    for (const byte of bytes) {
      hash ^= byte;
      hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    return `fnv1a32:${hash.toString(16).padStart(8, "0")}:${bytes.length}`;
  }

  class LiteratureApiClient {
    constructor(options) {
      this.baseUrl = String(options.baseUrl || "").replace(/\/$/, "");
      this.getHeaders = options.getHeaders || (() => ({}));
      this.onUnauthorized = options.onUnauthorized || (() => {});
      this.fetch = options.fetch || root.fetch.bind(root);
      this.turnCallCounts = new Map();
      this.endpointAccounting = {
        logicalEndpointCalls: {},
        transportAttempts: {},
        providerAttempts: {},
        cacheHits: {},
      };
    }

    async getPaperCardConfiguration(signal) {
      const data = await this.request(
        "/api/literature/config",
        undefined,
        signal,
        "GET"
      );
      return {
        schemaVersion: data.schemaVersion,
        promptVersion: data.promptVersion,
        modelSignature: data.modelSignature,
        generationStrategy:
          data.generationStrategy || PAPER_CARD_GENERATION_STRATEGY,
        nativePdfSupported: data.nativePdfSupported === true,
        nativePdfMaxBytes:
          Math.max(0, Number(data.nativePdfMaxBytes) || 0) ||
          DEFAULT_NATIVE_PDF_MAX_BYTES,
        nativePdfSchemaVersion:
          Math.max(0, Number(data.nativePdfSchemaVersion) || 0),
        nativePdfPromptVersion:
          String(data.nativePdfPromptVersion || "not-applicable"),
        nativePdfModelSignature:
          String(data.nativePdfModelSignature || "not-applicable"),
      };
    }

    async summarizeChunk(payload, signal) {
      const data = await this.request(
        "/api/literature/summarize-chunk",
        {
          filename: safeFilename(payload.filename),
          chunkIndex: payload.chunkIndex,
          totalChunks: payload.totalChunks,
          text: payload.text,
          language: payload.language === "zh" ? "zh" : "en",
        },
        signal
      );
      return data.chunkSummary;
    }

    async synthesize(payload, signal) {
      const data = await this.request(
        "/api/literature/synthesize",
        {
          filename: safeFilename(payload.filename),
          size: payload.size,
          lastModified: payload.lastModified,
          pageCount: payload.pageCount,
          extractionTruncated: payload.extractionTruncated === true,
          chunkSummaries: payload.chunkSummaries,
          language: payload.language === "zh" ? "zh" : "en",
        },
        signal
      );
      return {
        ...data.summary,
        model: data.model || null,
        modelSignature: data.modelSignature || "",
        promptVersion: data.promptVersion || "",
        schemaVersion: Number(data.schemaVersion) || 0,
      };
    }

    async mapCorpusPaper(payload, signal) {
      const data = await this.request(
        "/api/corpus/map-paper",
        {
          paperId: String(payload.paperId || "").slice(0, 160),
          contentHash: String(payload.contentHash || "").slice(0, 160),
          question: String(payload.question || "").slice(0, 4000),
          evidence: (Array.isArray(payload.evidence) ? payload.evidence : [])
            .slice(0, 8)
            .map((item) => ({
              evidenceRef: String(item.evidenceRef || "").slice(0, 300),
              text: String(item.claimCandidate || "").slice(0, 1600),
            })),
          paperCard: payload.paperCard && typeof payload.paperCard === "object"
            ? payload.paperCard
            : null,
          mapAttempt: Math.max(1, Number(payload.mapAttempt) || 1),
          fallback: payload.fallback === true,
          language: payload.language === "zh" ? "zh" : "en",
          callContext: boundedCallContext(
            payload.callContext,
            "corpus_mapper",
            payload.paperId
          ),
        },
        signal
      );
      return {
        ...data.mapResult,
        modelVersion: data.model || "unknown-model",
        mapperDiagnostics: data.mapperDiagnostics || null,
      };
    }

    async analyzePdfNative(payload, signal) {
      const fileData = `data:application/pdf;base64,${bytesToBase64(payload.bytes)}`;
      const data = await this.request(
        "/api/literature/analyze-pdf-native",
        {
          paperId: String(payload.paperId || "").slice(0, 160),
          filename: safeFilename(payload.filename),
          contentHash: String(payload.contentHash || "").slice(0, 160),
          task: String(payload.task || "").slice(0, 8000),
          purpose: String(payload.purpose || "paper_analysis").slice(0, 120),
          responseSchema:
            payload.responseSchema === "corpus_map"
              ? "corpus_map"
              : payload.responseSchema === "canonical_paper_card"
                ? "canonical_paper_card"
                : "paper_analysis",
          evidenceRefs: (Array.isArray(payload.evidenceRefs)
            ? payload.evidenceRefs
            : []).slice(0, 100),
          fileData,
          language: payload.language === "zh" ? "zh" : "en",
          callContext: boundedCallContext(
            payload.callContext,
            "native_pdf",
            payload.paperId
          ),
        },
        signal
      );
      return {
        analysis: data.analysis,
        paperId: data.paperId || null,
        contentHash: data.contentHash || null,
        model: data.model || null,
        modelSignature: data.modelSignature || "",
        schemaVersion: Number(data.schemaVersion) || 0,
        promptVersion: data.promptVersion || "",
        attempts: Math.max(0, Number(data.attempts) || 0),
        diagnostics: data.diagnostics || null,
      };
    }

    async interpretSemantics(payload, signal) {
      const data = await this.request("/api/semantic/interpret", {
        ...payload,
        callContext: boundedCallContext(payload.callContext, "semantic_parser"),
      }, signal);
      return data.ir;
    }

    async mapExperimentSchema(payload, signal) {
      const data = await this.request("/api/semantic/map-schema", {
        ...payload,
        callContext: boundedCallContext(payload.callContext, "schema_mapper"),
      }, signal);
      return data.mapping;
    }

    recordTurnCall(turnId, role) {
      if (!/^[A-Za-z0-9._:-]{1,200}$/.test(String(turnId || ""))) return;
      const allowed = ["semantic_parser", "schema_mapper", "search_planner", "reranker", "corpus_mapper", "native_pdf", "answer"];
      if (!allowed.includes(role)) return;
      const counts = this.turnCallCounts.get(turnId) || Object.fromEntries(allowed.map((name) => [name, 0]));
      counts[role] += 1;
      this.turnCallCounts.set(turnId, counts);
      if (this.turnCallCounts.size > 100) this.turnCallCounts.delete(this.turnCallCounts.keys().next().value);
    }

    getTurnCallCounts(turnId) {
      return { ...(this.turnCallCounts.get(turnId) || {}) };
    }

    getEndpointAccounting() {
      return structuredClone(this.endpointAccounting);
    }

    async routeContext(payload, signal) {
      const data = await this.request(
        "/api/context/route",
        {
          userQuery: String(payload.userQuery || "").slice(
            0,
            LITERATURE_CONFIG.maxRouterQueryCharacters
          ),
          selectedPaperIds: Array.isArray(payload.selectedPaperIds)
            ? payload.selectedPaperIds.slice(0, LITERATURE_CONFIG.maxRouterPapers)
            : [],
          recentlyReferencedPaperIds: Array.isArray(
            payload.recentlyReferencedPaperIds
          )
            ? payload.recentlyReferencedPaperIds.slice(
                0,
                LITERATURE_CONFIG.maxRouterPapers
              )
            : [],
          literatureIndex: Array.isArray(payload.literatureIndex)
            ? payload.literatureIndex.slice(0, LITERATURE_CONFIG.maxRouterPapers)
            : [],
          availableMemoryDescriptions: Array.isArray(
            payload.availableMemoryDescriptions
          )
            ? payload.availableMemoryDescriptions.slice(0, 12)
            : [],
        },
        signal
      );
      return data.routing;
    }

    async getKnowledgeRetrievalConfig(signal) {
      return this.request("/api/knowledge/config", undefined, signal, "GET");
    }

    async planKnowledgeSearch(payload, signal) {
      return this.request(
        "/api/knowledge/plan-search",
        {
          query: payload.query,
          intent: payload.intent,
          callContext: boundedCallContext(payload.callContext, "search_planner"),
        },
        signal
      );
    }

    async rerankKnowledgeCandidates(payload, signal) {
      return this.request(
        "/api/knowledge/rerank",
        {
          query: payload.query,
          intent: payload.intent,
          candidates: payload.candidates,
          callContext: boundedCallContext(
            payload.callContext,
            "reranker",
            payload.callContext?.paperId
          ),
        },
        signal
      );
    }

    async request(path, body, signal, method = "POST") {
      const roles = { "/api/semantic/interpret": "semantic_parser", "/api/semantic/map-schema": "schema_mapper", "/api/knowledge/plan-search": "search_planner", "/api/knowledge/rerank": "reranker", "/api/corpus/map-paper": "corpus_mapper", "/api/literature/analyze-pdf-native": "native_pdf" };
      this.recordTurnCall(body?.callContext?.turnId, roles[path]);
      this.endpointAccounting.logicalEndpointCalls[path] =
        (this.endpointAccounting.logicalEndpointCalls[path] || 0) + 1;
      // Semantic parsing is one logical FC call. A failure returns to the local IR.
      const maximumAttempts = path.startsWith("/api/semantic/") ? 1 : 2;
      let lastError;
      for (let attempt = 0; attempt < maximumAttempts; attempt += 1) {
        assertNotAborted(signal);
        this.endpointAccounting.transportAttempts[path] =
          (this.endpointAccounting.transportAttempts[path] || 0) + 1;
        try {
          const response = await this.fetch(`${this.baseUrl}${path}`, {
            method,
            headers: {
              ...this.getHeaders(),
              ...(body === undefined ? {} : { "Content-Type": "application/json" }),
            },
            ...(body === undefined ? {} : { body: JSON.stringify(body) }),
            signal,
          });
          if (response.status === 401) {
            this.onUnauthorized();
            throw new LiteratureError("AUTH_REQUIRED", "Your login session has expired.");
          }
          const data = await response.json().catch(() => ({}));
          this.endpointAccounting.providerAttempts[path] =
            (this.endpointAccounting.providerAttempts[path] || 0) +
            Math.max(0, Number(data.attempts) || 0);
          if (data.cached === true) {
            this.endpointAccounting.cacheHits[path] =
              (this.endpointAccounting.cacheHits[path] || 0) + 1;
          }
          if (response.ok && data.ok) {
            return data;
          }
          const error = new LiteratureError(
            data.error || "LLM_REQUEST_FAILED",
            data.message || `Function Compute returned HTTP ${response.status}.`
          );
          error.status = response.status;
          error.attempts = Math.max(0, Number(data.attempts) || 0);
          error.fallbackReason = String(data.fallbackReason || "").slice(0, 120);
          // Function Compute already performs its own short provider retry. The
          // browser retries only throttling/timeouts (plus network exceptions)
          // to avoid multiplying model calls.
          const retryable = [408, 425, 429, 504].includes(response.status);
          if (!retryable || attempt + 1 >= maximumAttempts) throw error;
          lastError = error;
        } catch (error) {
          if (error?.name === "AbortError") {
            throw new LiteratureError("OPERATION_ABORTED", "The literature operation was stopped.", error);
          }
          if (error instanceof LiteratureError) throw error;
          lastError = error;
          if (attempt + 1 >= maximumAttempts) break;
        }
        await new Promise((resolve) => setTimeout(resolve, 400));
      }
      if (lastError instanceof LiteratureError) throw lastError;
      throw new LiteratureError(
        "NETWORK_ERROR",
        "The AI request could not reach Function Compute. Check the network and try again.",
        lastError
      );
    }
  }

  class LiteratureModule {
    constructor(options) {
      this.workspace = options.workspace;
      this.api = options.api;
      this.pdfjsLib = options.pdfjsLib;
      this.pdfWorkerSrc = options.pdfWorkerSrc || "";
      this.getLanguage = options.getLanguage || (() => "en");
      this.now = options.now || (() => new Date());
      this.cryptoProvider = options.cryptoProvider || root.crypto;
      this.config = { ...LITERATURE_CONFIG, ...(options.config || {}) };
      this.index = null;
      this.documents = [];
      this.sourceSystem = options.sourceSystem || sourceSystemApi.createSourceSystem?.({
        workspace: this.workspace,
        knowledgeService: options.knowledgeService || null,
        cryptoProvider: this.cryptoProvider,
        spreadsheetProvider: options.spreadsheetProvider || root.XLSX,
        now: this.now,
        parsePaper: ({ file, bytes, signal }) =>
          extractLocalPdf(file, this.pdfjsLib, {
            ...this.config,
            workerSrc: this.pdfWorkerSrc,
            preloadedBytes: bytes,
            signal,
          }),
        generatePaperCard: (payload) => this.generatePaperCardFromPrepared(payload),
        getPaperCardConfiguration:
          typeof this.api?.getPaperCardConfiguration === "function"
            ? (signal) => this.api.getPaperCardConfiguration(signal)
            : null,
        schemaMapper: typeof this.api?.mapExperimentSchema === "function"
          ? (payload, mapperOptions) => this.api.mapExperimentSchema({
              ...payload,
              callContext: mapperOptions?.callContext || { turnId: mapperOptions?.turnId, profile: mapperOptions?.profile },
            }, mapperOptions?.signal)
          : null,
        mapWorker:
          typeof this.api?.mapCorpusPaper === "function"
            ? (payload, workerOptions) =>
                this.api.mapCorpusPaper(
                  {
                    ...payload,
                    mapAttempt: workerOptions?.attempt,
                    language: this.getLanguage(),
                    callContext: {
                      turnId: workerOptions?.turnId,
                      workflowId: workerOptions?.workflowId,
                      paperId: workerOptions?.paperId || payload.paperId,
                      profile: workerOptions?.profile,
                    },
                  },
                  workerOptions?.signal
                )
            : null,
        fallbackMapWorker:
          typeof this.api?.mapCorpusPaper === "function"
            ? (payload, workerOptions) =>
                this.api.mapCorpusPaper(
                  {
                    ...payload,
                    mapAttempt: workerOptions?.attempt,
                    fallback: true,
                    language: this.getLanguage(),
                    callContext: {
                      turnId: workerOptions?.turnId,
                      workflowId: workerOptions?.workflowId,
                      paperId: workerOptions?.paperId || payload.paperId,
                      profile: workerOptions?.profile,
                    },
                  },
                  workerOptions?.signal
                )
            : null,
        nativePdfWorker:
          typeof this.api?.analyzePdfNative === "function"
            ? (payload, workerOptions) =>
                this.api.analyzePdfNative(payload, workerOptions?.signal)
            : null,
      });
      this.sourceRegistry = this.sourceSystem?.registry || null;
      this.preparation = this.sourceSystem?.preparation || null;
      this.literatureTools = this.sourceSystem?.literatureTools || null;
      this.experimentTools = this.sourceSystem?.experimentTools || null;
      this.corpusWorkflows = this.sourceSystem?.corpusWorkflows || null;
      this.nativePdfAnalyzer = this.sourceSystem?.nativePdfAnalyzer || null;
    }

    serializeDocument(document) {
      return {
        id: document.id,
        relativePath: document.relativePath,
        filename: document.filename,
        size: Number(document.size),
        lastModified: Number(document.lastModified),
        ...(document.sourceHash ? { sourceHash: document.sourceHash } : {}),
        ...(document.statSignature
          ? { statSignature: document.statSignature }
          : {}),
        hashStatus: document.hashStatus || "absent",
        parseStatus: document.parseStatus || "not_started",
        indexStatus: document.indexStatus || "not_started",
        qmdLexStatus: document.qmdLexStatus || "not_started",
        qmdVectorStatus: document.qmdVectorStatus || "not_started",
        status: document.status,
        summaryPath: document.summaryPath,
        paperCardPath: document.paperCardPath || document.summaryPath,
        paperCardVersion: Number(document.paperCardVersion) || 0,
        paperCardStatus: document.paperCardStatus || "pending",
        paperCardError: String(document.paperCardError || "").slice(0, 1000),
        isLiteraturePaper: document.isLiteraturePaper === true,
        discovery: createPaperDiscoveryRecord(
          document.discovery,
          document.filename
        ),
        summaryUpdatedAt: document.summaryUpdatedAt || "",
      };
    }

    async persistIndex() {
      this.index = {
        schemaVersion: 1,
        documents: this.documents.map((document) => this.serializeDocument(document)),
        updatedAt: this.now().toISOString(),
      };
      await this.workspace.writeJson(".biodesign/literature/index.json", this.index);
      return this.index;
    }

    async removeDerivedRecord(document) {
      const paths = new Set([
        document?.paperCardPath,
        document?.summaryPath,
        document?.id ? `.biodesign/literature/cache/${document.id}.json` : "",
      ]);
      for (const path of paths) {
        if (path && (await this.workspace.fileExists(path))) {
          await this.workspace.removeFile(path);
        }
      }
    }

    async scan(options = {}) {
      const index = await this.workspace.readJson(".biodesign/literature/index.json");
      const tree = options.tree || (await this.workspace.scanDirectoryTree());
      const previous = Array.isArray(index.documents) ? index.documents : [];
      if (!this.sourceRegistry) {
        throw new LiteratureError(
          "SOURCE_REGISTRY_MISSING",
          "The local source registry could not be initialized."
        );
      }
      const reconciliation = await this.sourceRegistry.reconcile(tree, {
        legacyDocuments: previous,
      });
      try {
        await this.sourceSystem?.knowledgeLifecycle?.reconcile(
          reconciliation.changes
        );
      } catch (error) {
        console.warn("knowledge_reconciliation_failed", {
          code: error?.code || error?.name || "KNOWLEDGE_RECONCILIATION_FAILED",
          message: String(error?.message || error).slice(0, 300),
          fallback: "source-registry-and-legacy-retrieval",
        });
      }
      const previousById = new Map(previous.map((document) => [document.id, document]));
      const previousByPath = new Map(
        previous.map((document) => [document.relativePath, document])
      );
      const activePdfSources = reconciliation.sources.filter(
        (source) => source.extension === ".pdf"
      );
      const activeIds = new Set(activePdfSources.map((source) => source.sourceId));
      for (const removedDocument of previous) {
        if (!activeIds.has(removedDocument.id)) await this.removeDerivedRecord(removedDocument);
      }

      this.documents = activePdfSources.map((source) => {
        const old = previousById.get(source.sourceId) || previousByPath.get(source.path) || {};
        const summaryPath =
          source.artifacts?.paperCard?.path ||
          source.legacy?.paperCardPath ||
          old.paperCardPath ||
          old.summaryPath ||
          `.biodesign/literature/summaries/${source.sourceId}.json`;
        const cardReady =
          source.paperCardStatus === "ready" && Boolean(source.artifacts?.paperCard?.path);
        const stale = source.catalogStatus === "dirty" || source.paperCardStatus === "stale";
        const failed = source.paperCardStatus === "failed";
        return {
          id: source.sourceId,
          sourceId: source.sourceId,
          sourceKind: source.sourceKind,
          relativePath: source.path,
          filename: source.displayName,
          size: Number(source.sizeBytes),
          lastModified: Number(source.mtimeNs),
          statSignature: source.statSignature,
          sourceHash: source.contentHash,
          hashStatus: source.hashStatus,
          parseStatus: source.parseStatus,
          indexStatus: source.indexStatus,
          qmdLexStatus: source.qmdLexStatus || "not_started",
          qmdVectorStatus: source.qmdVectorStatus || "not_started",
          status: failed ? "failed" : stale ? "stale" : cardReady ? "ready" : "pending",
          summaryPath,
          paperCardPath: summaryPath,
          paperCardVersion: cardReady ? PAPER_CARD_VERSION : 0,
          paperCardStatus: failed ? "failed" : stale ? "stale" : cardReady ? "ready" : "pending",
          paperCardError: source.error?.message || String(old.paperCardError || ""),
          summaryAvailable: cardReady,
          summaryStale: stale,
          summaryUpdatedAt: old.summaryUpdatedAt || "",
          isLiteraturePaper: source.sourceKind === "paper",
          discovery: createPaperDiscoveryRecord(
            source.legacy?.discovery || old.discovery,
            source.displayName
          ),
        };
      });
      await this.persistIndex();
      return this.documents;
    }

    async addFiles(files) {
      const addedNames = [];
      for (const source of Array.from(files || [])) {
        if (!source?.name?.toLowerCase().endsWith(".pdf")) {
          throw new LiteratureError("UNSUPPORTED_FILE", `${source?.name || "File"} is not a PDF.`);
        }
        const filename = await this.uniqueFilename(safeFilename(source.name));
        await this.workspace.writeFile(`literature/${filename}`, source);
        addedNames.push(filename);
      }
      // Adding a paper only updates the local library inventory. Paper Card
      // generation is intentionally deferred until an agent request needs
      // literature evidence.
      const documents = await this.scan();
      return {
        addedNames,
        documents,
        paperCardSync: {
          documents,
          generatedPaperIds: [],
          reusedPaperIds: documents
            .filter(
              (document) =>
                document.isLiteraturePaper && document.paperCardStatus === "ready"
            )
            .map((document) => document.id),
          failures: [],
          deferred: true,
        },
      };
    }

    async uniqueFilename(filename) {
      if (!(await this.workspace.fileExists(`literature/${filename}`))) return filename;
      const dot = filename.lastIndexOf(".");
      const stem = dot > 0 ? filename.slice(0, dot) : filename;
      const extension = dot > 0 ? filename.slice(dot) : ".pdf";
      for (let counter = 2; counter < 10000; counter += 1) {
        const candidate = `${stem} (${counter})${extension}`;
        if (!(await this.workspace.fileExists(`literature/${candidate}`))) return candidate;
      }
      throw new LiteratureError("FILENAME_CONFLICT", `Could not create a unique name for ${filename}.`);
    }

    findDocument(documentId) {
      const document = this.documents.find((item) => item.id === documentId);
      if (!document) throw new LiteratureError("DOCUMENT_NOT_FOUND", "The selected paper is no longer indexed.");
      return document;
    }

    findDocumentByPath(relativePath) {
      return (
        this.documents.find(
          (item) => item.relativePath === String(relativePath || "")
        ) || null
      );
    }

    async getPaperCard(documentId) {
      const document = this.findDocument(documentId);
      if (document.paperCardStatus !== "ready") return null;
      const path = document.paperCardPath || document.summaryPath;
      if (!(await this.workspace.fileExists(path))) return null;
      const card = await this.workspace.readJson(path);
      if (
        card.documentId !== document.id ||
        card.paperId !== document.id ||
        Number(card.paperCardVersion) !== PAPER_CARD_VERSION ||
        card.source?.hash !== document.sourceHash
      ) {
        throw new LiteratureError(
          "PAPER_CARD_MISMATCH",
          "The cached Paper Card does not match the current source paper."
        );
      }
      return card;
    }

    async loadSummary(documentId) {
      return this.getPaperCard(documentId);
    }

    async deletePaperCard(documentId) {
      const document = this.findDocument(documentId);
      await this.removeDerivedRecord(document);
      const source = this.sourceRegistry?.get(documentId, { includeMissing: true });
      if (source) {
        delete source.artifacts.paperCard;
        source.paperCardStatus = "absent";
        source.error = null;
        source.legacy.discovery = null;
        await this.sourceRegistry.persist();
      }
      await this.sourceSystem?.knowledgeLifecycle?.removePaperCardArtifact(
        documentId
      ).catch((error) => {
        console.warn("paper_card_knowledge_removal_failed", {
          paperId: documentId,
          code: error?.code || error?.name || "QMD_UPDATE_FAILED",
          message: String(error?.message || error).slice(0, 300),
        });
      });
      document.status = "pending";
      document.paperCardStatus = "pending";
      document.paperCardVersion = 0;
      document.paperCardError = "";
      document.summaryAvailable = false;
      document.summaryStale = false;
      document.summaryUpdatedAt = "";
      document.discovery = createPaperDiscoveryRecord(null, document.filename);
      await this.persistIndex();
      return document;
    }

    async ensurePaperCards(options = {}) {
      await this.scan();
      const allowedIds = Array.isArray(options.paperIds)
        ? new Set(options.paperIds)
        : null;
      const targets = this.documents.filter(
        (document) =>
          document.isLiteraturePaper &&
          (!allowedIds || allowedIds.has(document.id)) &&
          document.paperCardStatus !== "ready"
      );
      const generatedPaperIds = [];
      const failures = [];

      for (let index = 0; index < targets.length; index += 1) {
        const document = targets[index];
        options.onProgress?.({
          stage: "paper-card",
          paperId: document.id,
          relativePath: document.relativePath,
          completed: index,
          total: targets.length,
        });
        try {
          await this.createPaperCard(document.id, {
            force: true,
            signal: options.signal,
            onProgress: (progress) =>
              options.onProgress?.({
                ...progress,
                paperId: document.id,
                relativePath: document.relativePath,
                paperCompleted: index,
                paperTotal: targets.length,
              }),
          });
          generatedPaperIds.push(document.id);
        } catch (error) {
          if (error?.code === "OPERATION_ABORTED" || options.signal?.aborted) {
            throw error;
          }
          document.status = "failed";
          document.paperCardStatus = "failed";
          document.paperCardVersion = 0;
          document.paperCardError = String(
            error.message || "Paper Card generation failed."
          ).slice(0, 1000);
          document.summaryAvailable = false;
          document.summaryStale = false;
          await this.removeDerivedRecord(document);
          const source = this.sourceRegistry?.get(document.id, {
            includeMissing: true,
          });
          if (source) {
            delete source.artifacts.paperCard;
            source.paperCardStatus = "failed";
            source.error = {
              code: String(error.code || "PAPER_CARD_FAILED"),
              message: document.paperCardError,
            };
            await this.sourceRegistry.persist();
          }
          await this.persistIndex();
          failures.push({
            paperId: document.id,
            relativePath: document.relativePath,
            error: document.paperCardError,
          });
        }
      }

      options.onProgress?.({
        stage: "paper-card-complete",
        completed: targets.length,
        total: targets.length,
      });
      return {
        documents: this.documents,
        generatedPaperIds,
        reusedPaperIds: this.documents
          .filter(
            (document) =>
              document.isLiteraturePaper && document.paperCardStatus === "ready"
          )
          .map((document) => document.id)
          .filter((paperId) => !generatedPaperIds.includes(paperId)),
        failures,
      };
    }

    // Compatibility alias for existing integrations that explicitly request
    // processing. Folder refresh paths call scan() directly and never call it.
    async syncPaperLibrary(options = {}) {
      return this.ensurePaperCards(options);
    }

    async removeDocument(documentId) {
      const document = this.findDocument(documentId);
      await this.removeDerivedRecord(document);
      await this.workspace.removeFile(document.relativePath);
      return this.scan();
    }

    async extractText(documentId, options = {}) {
      this.findDocument(documentId);
      assertNotAborted(options.signal);
      await this.preparation.ensureSourceReady([documentId], "full_text", options);
      const artifact = await this.preparation.readPaperArtifact(documentId);
      return {
        text: artifact.pages
          .map((page) => `# Page ${page.page}\n${page.text}`)
          .join("\n\n"),
        pageCount: artifact.pageCount,
        metadataTitle: artifact.metadataTitle,
        truncated: artifact.truncated,
      };
    }

    async generatePaperCardFromPrepared({
      source,
      paperArtifact,
      bytes,
      contentHash,
      paperCardContract,
      signal,
      onProgress,
      callContext,
    }) {
      assertNotAborted(signal);
      const sourceText = (paperArtifact.pages || [])
        .map((page) => `# Page ${page.page}\n${page.text}`)
        .join("\n\n");
      const chunkResult = chunkLiteratureText(sourceText, this.config);
      if (!chunkResult.chunks.length) {
        throw new LiteratureError("NO_TEXT_CHUNKS", "No usable text chunks were produced from this PDF.");
      }
      // Canonical cards must not vary with the language of the chat that first
      // causes processing. Question-level synthesis can localize the answer.
      const language = "en";
      let synthesized = null;
      let generationMode = "text-map-reduce";
      let fallbackReason =
        paperCardContract?.generationStrategy !== PAPER_CARD_GENERATION_STRATEGY
          ? "native-not-configured"
          : paperCardContract?.nativePdfSupported !== true
            ? "native-structured-output-unsupported"
            : typeof this.api?.analyzePdfNative !== "function"
              ? "native-api-unavailable"
              : "native-provider-failure";
      let nativeEvidenceValidation = null;
      let nativeProviderAttempts = 0;
      const nativeBytes = bytes instanceof Uint8Array ? bytes : null;
      const nativeConfigured = Boolean(
        paperCardContract?.generationStrategy === PAPER_CARD_GENERATION_STRATEGY &&
        paperCardContract?.nativePdfSupported === true &&
        typeof this.api?.analyzePdfNative === "function"
      );
      const nativeByteLimit = Math.max(
        1,
        Number(paperCardContract?.nativePdfMaxBytes) || DEFAULT_NATIVE_PDF_MAX_BYTES
      );
      if (nativeConfigured && !nativeBytes?.byteLength) {
        fallbackReason = "native-pdf-bytes-unavailable";
      } else if (nativeConfigured && nativeBytes.byteLength > nativeByteLimit) {
        fallbackReason = "native-pdf-too-large";
      } else if (nativeConfigured) {
        onProgress?.({
          stage: "native-paper-card-request",
          completed: 0,
          total: 1,
          providerRequest: true,
        });
        try {
          const nativeResult = await this.api.analyzePdfNative(
            {
              paperId: source.sourceId,
              filename: source.displayName,
              contentHash,
              bytes: nativeBytes,
              task:
                "Create one comprehensive, question-independent canonical Paper Card for later local evidence selection.",
              purpose: "canonical-paper-card",
              responseSchema: "canonical_paper_card",
              language,
              callContext,
            },
            signal
          );
          nativeProviderAttempts = Math.max(0, Number(nativeResult.attempts) || 0);
          const validationErrors = nativePaperCardValidationErrors(nativeResult, {
            paperId: source.sourceId,
            contentHash,
            schemaVersion:
              paperCardContract.nativePdfSchemaVersion ||
              NATIVE_PAPER_CARD_SCHEMA_VERSION,
            promptVersion:
              paperCardContract.nativePdfPromptVersion ||
              NATIVE_PAPER_CARD_PROMPT_VERSION,
            modelSignature: paperCardContract.nativePdfModelSignature,
          });
          if (validationErrors.length) {
            fallbackReason = "native-schema-or-provenance-invalid";
          } else {
            const analysis = nativeResult.analysis;
            const allNativeFindings = [
              ...(analysis.majorFindings || []),
              ...(analysis.importantResults || []),
            ];
            nativeEvidenceValidation = validatedNativeEvidenceFindings(
              allNativeFindings,
              paperArtifact,
              source.sourceId
            );
            synthesized = {
              ...analysis,
              mainFindings: (analysis.majorFindings || []).map((item) => item.claim),
              importantResults: (analysis.importantResults || []).map((item) => item.claim),
              keyResults: allNativeFindings.map((item) => item.claim),
              summary: analysis.shortSummary,
              model: nativeResult.model || null,
            };
            generationMode = "native-pdf";
            fallbackReason = null;
            onProgress?.({
              stage: "native-paper-card-success",
              completed: 1,
              total: 1,
              providerRequest: false,
              providerAttempts: nativeProviderAttempts,
            });
          }
        } catch (error) {
          nativeProviderAttempts = Math.max(0, Number(error?.attempts) || 0);
          fallbackReason = error?.fallbackReason ||
            (error?.code === "NativePaperCardUnsupported"
              ? "native-structured-output-unsupported"
              : "native-provider-failure");
        }
      }
      if (!synthesized) {
        onProgress?.({
          stage: "paper-card-fallback",
          completed: 0,
          total: 1,
          fallbackReason,
          providerAttempts: nativeProviderAttempts,
          providerRequest: false,
        });
        onProgress?.({
          stage: "summarizing",
          completed: 0,
          total: chunkResult.chunks.length,
          fallbackReason,
        });
        let completed = 0;
        const chunkSummaries = await runWithConcurrency(
          chunkResult.chunks,
          this.config.chunkConcurrency,
          async (text, index) => {
            const result = await this.api.summarizeChunk(
              {
                filename: source.displayName,
                chunkIndex: index,
                totalChunks: chunkResult.chunks.length,
                text,
                language,
              },
              signal
            );
            completed += 1;
            onProgress?.({
              stage: "summarizing",
              completed,
              total: chunkResult.chunks.length,
              fallbackReason,
            });
            return result;
          }
        );

        assertNotAborted(signal);
        onProgress?.({
          stage: "synthesizing",
          completed: 0,
          total: 1,
          fallbackReason,
        });
        synthesized = await this.api.synthesize(
          {
            filename: source.displayName,
            size: source.sizeBytes,
            lastModified: source.mtimeNs,
            pageCount: paperArtifact.pageCount,
            extractionTruncated: paperArtifact.truncated || chunkResult.truncated,
            chunkSummaries,
            language,
          },
          signal
        );
      }
      const effectiveModelSignature = String(
        paperCardContract?.modelSignature ||
        synthesized.modelSignature ||
        synthesized.model ||
        "unspecified"
      );
      if (
        paperCardContract &&
        (
          Number(paperCardContract.schemaVersion) !== PAPER_CARD_VERSION ||
          paperCardContract.promptVersion !== PAPER_CARD_PROMPT_VERSION ||
          (generationMode === "text-map-reduce" && synthesized.modelSignature &&
            synthesized.modelSignature !== paperCardContract.modelSignature) ||
          (synthesized.promptVersion &&
            synthesized.promptVersion !== paperCardContract.promptVersion) ||
          (synthesized.schemaVersion &&
            Number(synthesized.schemaVersion) !== Number(paperCardContract.schemaVersion))
        )
      ) {
        throw new LiteratureError(
          "PAPER_CARD_CONFIGURATION_CHANGED",
          "The Paper Card provider configuration changed during generation."
        );
      }
      const generatedAt = this.now().toISOString();
      const methods = normalizeCardList(synthesized.methods);
      const methodsSummary =
        normalizeCardText(synthesized.methodsSummary) ||
        (typeof synthesized.methods === "string"
          ? normalizeCardText(synthesized.methods)
          : methods.join("; ") || null);
      const mainFindings = normalizeCardList([
        ...normalizeCardList(synthesized.mainFindings),
        ...normalizeCardList(synthesized.keyResults),
      ]);
      const importantResults = normalizeCardList([
        ...normalizeCardList(synthesized.importantResults),
        ...normalizeCardList(synthesized.keyResults),
      ]);
      const shortSummary =
        normalizeCardText(synthesized.shortSummary) ||
        normalizeCardText(synthesized.summary) ||
        "";
      const card = {
        schemaVersion: PAPER_CARD_VERSION,
        paperCardVersion: PAPER_CARD_VERSION,
        paperId: source.sourceId,
        documentId: source.sourceId,
        fileName: source.displayName,
        generatedAt,
        source: {
          filename: source.displayName,
          relativePath: source.path,
          size: source.sizeBytes,
          lastModified: source.mtimeNs,
          hash: contentHash,
          pageCount: paperArtifact.pageCount,
          processedCharacters: chunkResult.processedCharacters,
          truncated: paperArtifact.truncated || chunkResult.truncated,
          artifactSchemaVersion: SOURCE_ARTIFACT_SCHEMA_VERSION,
          extractorVersion: SOURCE_EXTRACTOR_VERSION,
        },
        model: synthesized.model || null,
        modelSignature: effectiveModelSignature,
        promptVersion: PAPER_CARD_PROMPT_VERSION,
        generationStrategy:
          paperCardContract?.generationStrategy ||
          (generationMode === "native-pdf"
            ? PAPER_CARD_GENERATION_STRATEGY
            : "text-map-reduce-v1"),
        generationMode,
        fallbackReason,
        nativePdfSchemaVersion:
          Number(paperCardContract?.nativePdfSchemaVersion) || 0,
        nativePdfPromptVersion:
          paperCardContract?.nativePdfPromptVersion || "not-applicable",
        nativePdfModelSignature:
          paperCardContract?.nativePdfModelSignature || "not-applicable",
        generationDiagnostics: {
          mode: generationMode,
          fallbackReason,
          nativePdfEndpointCalls: nativeConfigured && nativeBytes?.byteLength &&
            nativeBytes.byteLength <= nativeByteLimit
            ? 1
            : 0,
          nativePdfProviderAttempts: nativeProviderAttempts,
          nativeEvidenceCitationsSubmitted:
            nativeEvidenceValidation?.submittedCitations || 0,
          nativeEvidenceCitationsVerified:
            nativeEvidenceValidation?.verifiedCitations || 0,
          nativeEvidenceCitationsDropped:
            nativeEvidenceValidation?.droppedCitations || 0,
          textFallbackOperations: generationMode === "text-map-reduce" ? 1 : 0,
        },
        cacheKey: makePaperCardCacheKey({
          sourceId: source.sourceId,
          contentHash,
          schemaVersion: PAPER_CARD_VERSION,
          modelSignature: effectiveModelSignature,
          promptVersion: PAPER_CARD_PROMPT_VERSION,
          generationStrategy:
            paperCardContract?.generationStrategy ||
            (generationMode === "native-pdf"
              ? PAPER_CARD_GENERATION_STRATEGY
              : "text-map-reduce-v1"),
          nativePdfSchemaVersion:
            Number(paperCardContract?.nativePdfSchemaVersion) || 0,
          nativePdfPromptVersion:
            paperCardContract?.nativePdfPromptVersion || "not-applicable",
          nativePdfModelSignature:
            paperCardContract?.nativePdfModelSignature || "not-applicable",
          sourceArtifactSchemaVersion: SOURCE_ARTIFACT_SCHEMA_VERSION,
          extractorVersion: SOURCE_EXTRACTOR_VERSION,
        }),
        title:
          paperArtifact.metadataTitle || normalizeCardText(synthesized.title) || null,
        authors: normalizeCardList(synthesized.authors),
        year:
          Number.isInteger(Number(synthesized.year)) &&
          Number(synthesized.year) >= 1800 &&
          Number(synthesized.year) <= 2100
            ? Number(synthesized.year)
            : null,
        abstractSummary: normalizeCardText(synthesized.abstractSummary),
        researchQuestion: normalizeCardText(synthesized.researchQuestion),
        mainFindings,
        methods,
        methodsSummary,
        organisms: normalizeCardList(synthesized.organisms),
        genes: normalizeCardList(synthesized.genes),
        proteins: normalizeCardList(synthesized.proteins),
        pathways: normalizeCardList(synthesized.pathways),
        metabolites: normalizeCardList(synthesized.metabolites),
        experimentalConditions: normalizeCardList(synthesized.experimentalConditions),
        measurements: normalizeCardList(synthesized.measurements),
        importantResults,
        limitations: normalizeCardList(synthesized.limitations),
        keywords: normalizeCardList(synthesized.keywords),
        topics: normalizeCardList(synthesized.topics),
        shortSummary,
        // Compatibility aliases keep the existing summary UI and request
        // formatting stable while the richer Paper Card becomes the source
        // for discovery.
        summary: String(synthesized.summary || shortSummary || ""),
        keyResults: normalizeCardList([
          ...normalizeCardList(synthesized.keyResults),
          ...mainFindings,
        ]),
        mainConclusion: normalizeCardText(synthesized.mainConclusion),
      };
      card.evidenceFindings = nativeEvidenceValidation?.findings ||
        canonicalEvidenceFindings(
          [
            ...card.mainFindings,
            ...card.importantResults,
            ...card.keyResults,
          ],
          paperArtifact,
          source.sourceId
        );
      assertNotAborted(signal);
      const path =
        source.legacy?.paperCardPath ||
        `.biodesign/literature/summaries/${source.sourceId}.json`;
      await this.workspace.writeJson(path, card);
      source.legacy = {
        ...(source.legacy || {}),
        summaryPath: path,
        paperCardPath: path,
        discovery: createPaperDiscoveryRecord(card, source.displayName),
      };
      source.error = null;
      onProgress?.({ stage: "complete", completed: 1, total: 1 });
      return {
        card,
        path,
        schemaVersion: PAPER_CARD_VERSION,
        model: synthesized.model || null,
        modelSignature: effectiveModelSignature,
        promptVersion: PAPER_CARD_PROMPT_VERSION,
        generationStrategy: card.generationStrategy,
        generationMode,
        fallbackReason,
        nativePdfSchemaVersion: card.nativePdfSchemaVersion,
        nativePdfPromptVersion: card.nativePdfPromptVersion,
        nativePdfModelSignature: card.nativePdfModelSignature,
        cacheKey: card.cacheKey,
      };
    }

    async createPaperCard(documentId, options = {}) {
      const document = this.findDocument(documentId);
      if (options.force) {
        const source = this.sourceRegistry.get(documentId, { includeMissing: true });
        if (source) {
          delete source.artifacts.paperCard;
          source.paperCardStatus = "absent";
          await this.sourceRegistry.persist();
        }
        await this.removeDerivedRecord(document);
      }
      assertNotAborted(options.signal);
      options.onProgress?.({ stage: "extracting", completed: 0, total: 1 });
      const readiness = await this.preparation.ensureSourceReady(
        [documentId],
        "paper_card",
        options
      );
      await this.scan();
      const current = this.findDocument(documentId);
      const card = await this.workspace.readJson(current.paperCardPath);
      const sourceText = options.includeSourceText
        ? (await this.extractText(documentId, options)).text
        : "";
      return {
        summary: card,
        card,
        cached: readiness.sources?.[0]?.cached === true,
        sourceText,
      };
    }

    async summarize(documentId, options = {}) {
      return this.createPaperCard(documentId, options);
    }
  }

  return {
    LITERATURE_CONFIG,
    LiteratureApiClient,
    LiteratureError,
    LiteratureModule,
    PAPER_CARD_VERSION,
    chunkLiteratureText,
    createPaperDiscoveryRecord,
    extractLocalPdf,
    hashLiteratureFile,
    runWithConcurrency,
  };
});
