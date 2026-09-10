(function exposeLiteratureModule(root, factory) {
  const api = factory(root);
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) Object.assign(root, api);
})(typeof globalThis !== "undefined" ? globalThis : this, function literatureFactory(root) {
  "use strict";
  const rateLimitApi = root.BioDesignProviderRateLimit ||
    (typeof require === "function" ? require("../shared/provider-rate-limit.js") : {});
  const PAPER_CARD_ENDPOINTS = new Set(["/api/literature/create-paper-card-from-text", "/api/literature/analyze-pdf-native", "/api/literature/summarize-chunk", "/api/literature/synthesize"]);
  function abortableDelay(milliseconds, signal) {
    assertNotAborted(signal);
    return new Promise((resolve, reject) => {
      const abort = () => { clearTimeout(timer); signal?.removeEventListener("abort", abort); reject(new LiteratureError("OPERATION_ABORTED", "The literature operation was stopped.")); };
      const timer = setTimeout(() => { signal?.removeEventListener("abort", abort); resolve(); }, milliseconds);
      signal?.addEventListener("abort", abort, { once: true });
    });
  }

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
  const PAPER_CARD_GENERATION_STRATEGY = "native-pdf-combined-text-v2";
  const PAPER_CARD_GENERATION_CONTRACT_VERSION = 2;
  const NATIVE_PAPER_CARD_SCHEMA_VERSION = 1;
  const NATIVE_PAPER_CARD_PROMPT_VERSION = "canonical-paper-card-native-v1";
  const COMBINED_TEXT_PAPER_CARD_SCHEMA_VERSION = 1;
  const COMBINED_TEXT_PAPER_CARD_PROMPT_VERSION =
    "canonical-paper-card-combined-text-v1";
  const DEFAULT_NATIVE_PDF_MAX_BYTES = 20 * 1024 * 1024;
  const DEFAULT_COMBINED_TEXT_MAX_CHARACTERS = 120000;
  const SOURCE_ARTIFACT_SCHEMA_VERSION = 1;
  const SOURCE_EXTRACTOR_VERSION = "local-source-v1";
  const makePaperCardCacheKey = sourceSystemApi.paperCardCacheKey || ((input = {}) =>
    JSON.stringify({
      version: 4,
      sourceId: String(input.sourceId || ""),
      contentHash: String(input.contentHash || ""),
      schemaVersion: Number(input.schemaVersion) || 0,
      modelSignature: String(input.modelSignature || input.configurationSignature || input.model || "unspecified"),
      promptVersion: String(input.promptVersion || "unspecified"),
      generationStrategy: String(
        input.generationStrategy || "text-map-reduce-v1"
      ),
      generationContractVersion: Number(input.generationContractVersion) || 0,
      nativePdfSchemaVersion: Number(input.nativePdfSchemaVersion) || 0,
      nativePdfPromptVersion: String(
        input.nativePdfPromptVersion || "not-applicable"
      ),
      nativePdfModelSignature: String(
        input.nativePdfModelSignature || "not-applicable"
      ),
      combinedTextSchemaVersion: Number(input.combinedTextSchemaVersion) || 0,
      combinedTextMaxCharacters:
        Math.max(0, Number(input.combinedTextMaxCharacters) || 0),
      combinedTextPromptVersion: String(
        input.combinedTextPromptVersion || "not-applicable"
      ),
      combinedTextModelSignature: String(
        input.combinedTextModelSignature || "not-applicable"
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

  function adjacentChunkOverlap(left, right) {
    const previous = String(left || "");
    const current = String(right || "");
    const maximum = Math.min(previous.length, current.length);
    if (!maximum) return 0;
    const probeLength = Math.min(32, maximum);
    const probe = current.slice(0, probeLength);
    let position = previous.lastIndexOf(probe);
    while (position >= 0) {
      const overlap = previous.length - position;
      if (overlap <= maximum && current.startsWith(previous.slice(position))) {
        return overlap;
      }
      position = previous.lastIndexOf(probe, position - 1);
    }
    for (let length = probeLength - 1; length >= 1; length -= 1) {
      if (previous.endsWith(current.slice(0, length))) return length;
    }
    return 0;
  }

  function combineExtractedPaperText(paperArtifact) {
    const pages = (Array.isArray(paperArtifact?.pages) ? paperArtifact.pages : [])
      .filter((page) => Number.isInteger(Number(page?.page)) && Number(page.page) > 0)
      .map((page) => ({
        page: Number(page.page),
        text: String(page.text || "").trim(),
      }))
      .filter((page) => page.text);
    if (pages.length) {
      return {
        text: pages.map((page) => `# Page ${page.page}\n${page.text}`).join("\n\n"),
        pageCount: pages.length,
        chunkCount: Array.isArray(paperArtifact?.chunks)
          ? paperArtifact.chunks.length
          : pages.length,
      };
    }

    const combinedPages = [];
    for (const chunk of (Array.isArray(paperArtifact?.chunks) ? paperArtifact.chunks : [])) {
      const page = Number(chunk?.page);
      const text = String(chunk?.text || "").trim();
      if (!Number.isInteger(page) || page < 1 || !text) continue;
      const current = combinedPages.at(-1);
      if (!current || current.page !== page) {
        combinedPages.push({ page, text });
        continue;
      }
      const overlap = adjacentChunkOverlap(current.text, text);
      current.text += `${overlap ? "" : "\n"}${text.slice(overlap)}`;
    }
    return {
      text: combinedPages
        .map((page) => `# Page ${page.page}\n${page.text}`)
        .join("\n\n"),
      pageCount: combinedPages.length,
      chunkCount: Array.isArray(paperArtifact?.chunks)
        ? paperArtifact.chunks.length
        : 0,
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
      ...(typeof value?.model === "string" ? { model: value.model } : {}),
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
    let submittedFindings = 0;
    const validatedFindings = (Array.isArray(findings) ? findings : [])
      .slice(0, 30)
      .map((finding) => {
        const claim = String(finding?.claim || "").trim().slice(0, 1600);
        if (!claim) return null;
        submittedFindings += 1;
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
        if (!evidenceRefs.length) {
          const normalizedClaim = normalizeEvidenceQuote(claim);
          const matchingChunk = chunks.find((chunk) =>
            Number.isInteger(Number(chunk?.page)) &&
            Number(chunk.page) > 0 &&
            String(chunk?.chunkId || "") &&
            normalizeEvidenceQuote(chunk.text).includes(normalizedClaim)
          );
          if (normalizedClaim.length >= 4 && matchingChunk) {
            evidenceRefs.push(
              `${sourceId}:p${Number(matchingChunk.page)}:${String(matchingChunk.chunkId).slice(0, 256)}`
            );
          }
        }
        if (!evidenceRefs.length) return null;
        return { claim, evidenceRefs };
      })
      .filter(Boolean);
    return {
      findings: validatedFindings,
      submittedCitations,
      verifiedCitations,
      droppedCitations: submittedCitations - verifiedCitations,
      submittedFindings,
      verifiedFindings: validatedFindings.length,
      droppedFindings: submittedFindings - validatedFindings.length,
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
      this.log = options.runtimeLog || root.BioDesignRuntimeLog;
      this.now = options.now || (() => Date.now());
      this.wait = options.wait || abortableDelay;
      this.paperCardQueue = [];
      this.paperCardConcurrency = 2;
      this.paperCardRecoverySuccesses = 0;
      this.paperCardThrottleGeneration = 0;
      this.activePaperCardRequests = 0;
      this.providerCooldownUntil = 0;
      this.inputTokenLimit = null;
      this.modelInputTokenLimits = new Map();
      this.modelConfigurationSignatures = new Map();
      this.paperCardConfigurations = new WeakMap();
      this.turnCallCounts = new Map();
      this.semanticCapability = null;
      this.semanticCapabilityProbe = null;
      this.endpointAccounting = {
        logicalEndpointCalls: {},
        transportAttempts: {},
        providerAttempts: {},
        cacheHits: {},
      };
    }

    async getPaperCardConfiguration(signal, callContext, workspace) {
      assertNotAborted(signal);
      const headers = { ...this.getHeaders() };
      const turnId = callContext?.configurationTurnId || callContext?.turnId;
      // Unknown turn/workspace scopes stay uncached. A workspace object also
      // isolates reopenings and separate projects that happen to share an ID.
      if (!turnId || !workspace || typeof workspace !== "object") {
        return this.fetchPaperCardConfiguration(signal, callContext, headers);
      }
      const headersKey = JSON.stringify(Object.entries(headers).sort(([a], [b]) => a.localeCompare(b)));
      let scope = this.paperCardConfigurations.get(workspace);
      if (!scope || scope.headersKey !== headersKey || scope.baseUrl !== this.baseUrl) {
        scope = { headersKey, baseUrl: this.baseUrl, turns: new Map() };
        this.paperCardConfigurations.set(workspace, scope);
      }
      const key = JSON.stringify([turnId, callContext?.model || ""]);
      const forget = (entry) => { if (scope.turns.get(key) === entry) scope.turns.delete(key); };
      let entry = scope.turns.get(key);
      if (!entry) {
        entry = { controller: new AbortController(), consumers: 0, settled: false };
        scope.turns.set(key, entry);
        entry.promise = this.fetchPaperCardConfiguration(entry.controller.signal, callContext, headers).then(data => {
          entry.settled = true;
          // Keep the existing contract validator authoritative; invalid setup
          // must be fetched again if a later caller retries in this turn.
          if (!sourceSystemApi.normalizePaperCardContract(data)) forget(entry);
          for (const [oldKey, oldEntry] of scope.turns) {
            if (scope.turns.size <= 50) break;
            if (oldEntry.settled) scope.turns.delete(oldKey);
          }
          return data;
        }, error => { entry.settled = true; forget(entry); throw error; });
      }
      // One cancelled consumer must not abort setup still needed by another.
      // Once all consumers leave, abort and evict the unfinished request.
      entry.consumers++;
      return new Promise((resolve, reject) => {
        let done = false;
        const finish = (callback, value) => {
          if (done) return;
          done = true;
          signal?.removeEventListener("abort", abort);
          entry.consumers--;
          callback(value);
          if (!entry.settled && !entry.consumers) { forget(entry); entry.controller.abort(); }
        };
        const abort = () => finish(reject, new LiteratureError("OPERATION_ABORTED", "The literature operation was stopped."));
        signal?.addEventListener("abort", abort, { once: true });
        entry.promise.then(data => finish(resolve, { ...data }), error => finish(reject, error));
        if (signal?.aborted) abort();
      });
    }

    async fetchPaperCardConfiguration(signal, callContext, headers) {
      const data = await this.request(
        "/api/literature/config",
        undefined,
        signal,
        "GET",
        callContext,
        headers
      );
      const model = callContext?.model;
      const previousSignature = model ? this.modelConfigurationSignatures.get(model) : this.configurationSignature;
      if (previousSignature && previousSignature !== data.modelSignature) {
        if (model) this.modelInputTokenLimits.delete(model);
        else this.inputTokenLimit = null;
      }
      if (model) this.modelConfigurationSignatures.set(model, data.modelSignature);
      else this.configurationSignature = data.modelSignature;
      this.log?.record("paper-card.configuration", { combinedTextSupported: data.combinedTextSupported === true,
        nativePdfSupported: data.nativePdfSupported === true, structuredOutputMode: data.combinedTextOutputMode || "not-advertised",
        promptVersion: data.combinedTextPromptVersion });
      return {
        wikiConfiguration: data.wikiConfiguration || null,
        schemaVersion: data.schemaVersion,
        promptVersion: data.promptVersion,
        modelSignature: data.modelSignature,
        generationStrategy:
          data.generationStrategy || PAPER_CARD_GENERATION_STRATEGY,
        generationContractVersion:
          Math.max(0, Number(data.generationContractVersion) || 0),
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
        combinedTextSupported: data.combinedTextSupported === true,
        combinedTextMaxCharacters:
          Math.max(0, Number(data.combinedTextMaxCharacters) || 0) ||
          DEFAULT_COMBINED_TEXT_MAX_CHARACTERS,
        combinedTextSchemaVersion:
          Math.max(0, Number(data.combinedTextSchemaVersion) || 0),
        combinedTextPromptVersion:
          String(data.combinedTextPromptVersion || "not-applicable"),
        combinedTextModelSignature:
          String(data.combinedTextModelSignature || "not-applicable"),
      };
    }

    async summarizeChunk(payload, signal) {
      this.recordTurnCall(payload.callContext?.turnId, "paper_card_chunk");
      const data = await this.request(
        "/api/literature/summarize-chunk",
        {
          filename: safeFilename(payload.filename),
          chunkIndex: payload.chunkIndex,
          totalChunks: payload.totalChunks,
          text: payload.text,
          language: payload.language === "zh" ? "zh" : "en",
          callContext: boundedCallContext(payload.callContext, "paper_card_chunk", payload.callContext?.paperId),
        },
        signal
      );
      return data.chunkSummary;
    }

    async synthesize(payload, signal) {
      this.recordTurnCall(payload.callContext?.turnId, "paper_card_synthesis");
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
          callContext: boundedCallContext(payload.callContext, "paper_card_synthesis", payload.callContext?.paperId),
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

    async updateWikiPage(input, options = {}) {
      this.recordTurnCall(options.callContext?.turnId || options.turnId, "wiki_update");
      return this.request("/api/knowledge/update-wiki", {
        input, callContext: boundedCallContext(options.callContext, "wiki_update"),
      }, options.signal);
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

    async createPaperCardFromText(payload, signal) {
      const data = await this.request(
        "/api/literature/create-paper-card-from-text",
        {
          paperId: String(payload.paperId || "").slice(0, 160),
          filename: safeFilename(payload.filename),
          contentHash: String(payload.contentHash || "").slice(0, 160),
          text: String(payload.text || ""),
          pageCount: Math.max(0, Number(payload.pageCount) || 0),
          chunkCount: Math.max(0, Number(payload.chunkCount) || 0),
          extractionTruncated: payload.extractionTruncated === true,
          callContext: boundedCallContext(
            payload.callContext,
            "combined_text_paper_card",
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

    refreshSemanticCapability() {
      this.semanticCapability = null;
    }

    async interpretSemantics(payload, signal) {
      assertNotAborted(signal);
      const model = payload.callContext?.model;
      const configuration = model ? this.modelConfigurationSignatures.get(model) : this.configurationSignature;
      const signature = `${this.baseUrl}\n${model || ""}\n${configuration || ""}`;
      // Concurrent requests wait only for the capability probe; they must never
      // reuse another question's interpretation.
      if (this.semanticCapabilityProbe?.signature === signature) {
        await this.semanticCapabilityProbe.promise;
        assertNotAborted(signal);
      }
      const state = this.semanticCapability;
      if (state?.signature === signature && state.retryAt > this.now()) {
        throw Object.assign(new LiteratureError("SemanticParserUnavailable", "Using the local semantic interpretation during the capability cooldown."), {
          semanticParserAttempted: false, capabilityUnavailable: state.unavailable,
          fallbackReason: state.reason, retryAfterMs: state.retryAt - this.now(),
        });
      }
      let finishProbe;
      const probe = { signature, promise: new Promise(resolve => { finishProbe = resolve; }) };
      this.semanticCapabilityProbe = probe;
      try {
        const data = await this.request("/api/semantic/interpret", {
          ...payload,
          callContext: boundedCallContext(payload.callContext, "semantic_parser"),
        }, signal);
        this.semanticCapability = null;
        return data.ir;
      } catch (error) {
        error.semanticParserAttempted = true;
        const endpointMissing = [404, 405, 501].includes(error.status);
        const unavailable = error.capabilityUnavailable === true || endpointMissing;
        // Older deployments return opaque 502s, including transient errors.
        // Back off briefly without recording permanent capability unavailability.
        const opaqueFailure = error.status === 502 && error.code === "SemanticParserUnavailable" && !error.fallbackReason;
        if (unavailable || opaqueFailure) {
          const reason = endpointMissing ? "semantic_endpoint_missing" : error.fallbackReason || "semantic_parser_unavailable";
          const cooldown = unavailable ? 300000 : 30000;
          this.semanticCapability = { signature, unavailable, reason, retryAt: this.now() + cooldown };
          Object.assign(error, { capabilityUnavailable: unavailable, fallbackReason: reason, retryAfterMs: cooldown });
          this.log?.record("semantic-parser.capability", { status: unavailable ? "unavailable" : "cooldown",
            fallbackReason: reason, retryAfterMs: cooldown, turnId: payload.callContext?.turnId }, "warn");
        }
        throw error;
      } finally {
        finishProbe();
        if (this.semanticCapabilityProbe === probe) this.semanticCapabilityProbe = null;
      }
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
      const allowed = ["semantic_parser", "schema_mapper", "search_planner", "reranker", "corpus_mapper", "native_pdf", "combined_text_paper_card", "paper_card_chunk", "paper_card_synthesis", "image_understanding", "answer", "wiki_update"];
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
        signal,
        "POST",
        payload.callContext
      );
      return data.routing;
    }

    async getKnowledgeRetrievalConfig(signal, callContext) {
      return this.request("/api/knowledge/config", undefined, signal, "GET", callContext);
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

    async request(path, body, signal, method = "POST", callContext, headers) {
      return this.requestInternal(path, body, signal, method, callContext, headers);
    }

    acquirePaperCardSlot(signal, details) {
      assertNotAborted(signal);
      return new Promise((resolve, reject) => {
        const entry = { signal, details, resolve };
        entry.onAbort = () => {
          const index = this.paperCardQueue.indexOf(entry);
          if (index < 0) return;
          this.paperCardQueue.splice(index, 1);
          signal?.removeEventListener("abort", entry.onAbort);
          reject(new LiteratureError("OPERATION_ABORTED", "The literature operation was stopped."));
        };
        signal?.addEventListener("abort", entry.onAbort, { once: true });
        this.paperCardQueue.push(entry);
        this.log?.record("paper-card.request-queued", { ...details, queueDepth: this.paperCardQueue.length,
          activeRequests: this.activePaperCardRequests, concurrency: this.paperCardConcurrency });
        this.drainPaperCardQueue();
      });
    }

    drainPaperCardQueue() {
      while (this.activePaperCardRequests < this.paperCardConcurrency && this.paperCardQueue.length) {
        const entry = this.paperCardQueue.shift();
        entry.signal?.removeEventListener("abort", entry.onAbort);
        this.activePaperCardRequests++;
        this.log?.record("paper-card.slot-acquired", { ...entry.details, activeRequests: this.activePaperCardRequests,
          concurrency: this.paperCardConcurrency, queueDepth: this.paperCardQueue.length });
        let released = false;
        entry.resolve(() => {
          if (released) return;
          released = true;
          this.activePaperCardRequests--;
          this.drainPaperCardQueue();
        });
      }
    }

    inputQuotaCharacterBudget(callContext) {
      return rateLimitApi.inputQuotaCharacterBudget(callContext?.model ? this.modelInputTokenLimits.get(callContext.model) : this.inputTokenLimit);
    }

    async waitForProviderCooldown(signal, details) {
      while (this.providerCooldownUntil > this.now()) {
        const retryAfterMs = this.providerCooldownUntil - this.now();
        if (retryAfterMs > 121000) throw Object.assign(new LiteratureError("ProviderRateLimited", "The provider cooldown is too long for an automatic retry. Retry after the quota resets."),
          { providerStatus: 429, retryAfterMs, rateLimitRetryable: true });
        this.log?.record("backend-request.cooldown", { ...details, code: "ProviderRateLimited", retryAfterMs, inputTokenLimit: this.inputTokenLimit }, "warn");
        await this.wait(retryAfterMs, signal);
      }
      assertNotAborted(signal);
    }

    assertPaperCardQuotaBudget(path, body, callContext) {
      const inputTokenLimit = callContext?.model ? this.modelInputTokenLimits.get(callContext.model) : this.inputTokenLimit;
      const learnedBudget = this.inputQuotaCharacterBudget(callContext);
      if (path === "/api/literature/create-paper-card-from-text" && learnedBudget && String(body?.text || "").length > learnedBudget) {
        this.log?.record("paper-card.quota-route", { paperId: body?.paperId, route: "map-reduce", inputTokenLimit }, "warn");
        throw Object.assign(new LiteratureError("ProviderRateLimited", "The full paper exceeds the conservative budget learned from the provider's input-token quota."),
          { providerStatus: 429, verifiedInputTokenRateLimit: true, inputTokenLimit, attempts: 0 });
      }
    }

    async requestInternal(path, body, signal, method = "POST", callContext = body?.callContext, headers) {
      assertNotAborted(signal);
      // Keep routing outside strict task schemas and provider trace metadata.
      const model = callContext?.model;
      if (body?.callContext && Object.hasOwn(body.callContext, "model")) {
        const { model: _model, ...providerContext } = body.callContext;
        body = { ...body, callContext: providerContext };
      }
      this.assertPaperCardQuotaBudget(path, body, callContext);
      const roles = { "/api/semantic/interpret": "semantic_parser", "/api/semantic/map-schema": "schema_mapper", "/api/knowledge/plan-search": "search_planner", "/api/knowledge/rerank": "reranker", "/api/corpus/map-paper": "corpus_mapper", "/api/literature/analyze-pdf-native": "native_pdf", "/api/literature/create-paper-card-from-text": "combined_text_paper_card" };
      this.recordTurnCall(body?.callContext?.turnId, roles[path]);
      this.endpointAccounting.logicalEndpointCalls[path] =
        (this.endpointAccounting.logicalEndpointCalls[path] || 0) + 1;
      // Semantic parsing is one logical FC call. A failure returns to the local IR.
      const maximumAttempts = path.startsWith("/api/semantic/") ? 1 : 2;
      let lastError;
      for (let attempt = 0; attempt < maximumAttempts; attempt += 1) {
        assertNotAborted(signal);
        const details = { endpoint: path, paperId: body?.paperId || body?.callContext?.paperId, turnId: body?.callContext?.turnId };
        // Acquire per transport attempt, so retries also obey a concurrency
        // reduction learned while another paper's request was in flight.
        const release = PAPER_CARD_ENDPOINTS.has(path) ? await this.acquirePaperCardSlot(signal, details) : null;
        let finish, throttleGeneration;
        try {
          assertNotAborted(signal);
          this.assertPaperCardQuotaBudget(path, body, callContext);
          if (method !== "GET") await this.waitForProviderCooldown(signal, details);
          this.endpointAccounting.transportAttempts[path] =
            (this.endpointAccounting.transportAttempts[path] || 0) + 1;
          finish = this.log?.begin("backend-request", { ...details, method,
            workflowId: body?.callContext?.workflowId, role: roles[path] || body?.callContext?.callRole,
            attempt: attempt + 1, ...(release ? { activeRequests: this.activePaperCardRequests, concurrency: this.paperCardConcurrency } : {}) });
          throttleGeneration = this.providerCooldownUntil <= this.now() ? this.paperCardThrottleGeneration : null;
          const response = await this.fetch(`${this.baseUrl}${path}`, {
            method,
            headers: {
              ...(headers || this.getHeaders()),
              ...(model ? { "X-BioDesign-Chat-Model": model } : {}),
              ...(body === undefined ? {} : { "Content-Type": "application/json" }),
            },
            ...(body === undefined ? {} : { body: JSON.stringify(body) }),
            signal,
          });
          assertNotAborted(signal);
          if (response.status === 401) {
            this.onUnauthorized();
            throw new LiteratureError("AUTH_REQUIRED", "Your login session has expired.");
          }
          const data = await response.json().catch(() => ({}));
          assertNotAborted(signal);
          this.endpointAccounting.providerAttempts[path] =
            (this.endpointAccounting.providerAttempts[path] || 0) +
            Math.max(0, Number(data.attempts) || 0);
          if (data.cached === true) {
            this.endpointAccounting.cacheHits[path] =
              (this.endpointAccounting.cacheHits[path] || 0) + 1;
          }
          if (response.ok && data.ok) {
            // Require three consecutive uncached successes after the latest
            // cooldown. A pre-throttle request finishing late is not recovery.
            if (release && data.cached !== true && this.paperCardConcurrency === 1 &&
                throttleGeneration === this.paperCardThrottleGeneration && this.providerCooldownUntil <= this.now()) {
              if (++this.paperCardRecoverySuccesses >= 3) {
                this.paperCardRecoverySuccesses = 0;
                this.paperCardConcurrency = 2;
                this.log?.record("paper-card.concurrency-restored", { ...details, concurrency: 2 });
                this.drainPaperCardQueue();
              }
            }
            finish?.("completed", { status: response.status, providerAttempts: Math.max(0, Number(data.attempts) || 0), cached: data.cached === true,
              structuredOutputMode: data.diagnostics?.structuredOutputMode });
            return data;
          }
          if (release) this.paperCardRecoverySuccesses = 0;
          const error = new LiteratureError(
            data.error || "LLM_REQUEST_FAILED",
            data.message || `Function Compute returned HTTP ${response.status}.`
          );
          error.status = response.status;
          error.attempts = Math.max(0, Number(data.attempts) || 0);
          error.fallbackReason = String(data.fallbackReason || "").slice(0, 120);
          if (path === "/api/semantic/interpret") {
            const reasons = ["structured_output_unsupported", "missing_model_configuration", "provider_schema_incompatible",
              "provider_configuration_rejected", "invalid_structured_output", "semantic_parser_unavailable"];
            error.fallbackReason = reasons.includes(data.fallbackReason) ? data.fallbackReason : "";
            error.capabilityUnavailable = data.capabilityUnavailable === true &&
              reasons.slice(0, 4).includes(error.fallbackReason);
          }
          error.verifiedContextLengthError =
            data.verifiedContextLengthError === true;
          error.terminalProviderFailure =
            data.terminalProviderFailure === true;
          const rateLimit = rateLimitApi.parseRateLimit(response.status, data, response.headers?.get?.("retry-after"), this.now());
          if (rateLimit) {
            this.paperCardThrottleGeneration++;
            this.paperCardRecoverySuccesses = 0;
            Object.assign(error, rateLimit, { code: "ProviderRateLimited" });
            if (rateLimit.verifiedInputTokenRateLimit) {
              if (model) this.modelInputTokenLimits.set(model, rateLimit.inputTokenLimit);
              else this.inputTokenLimit = rateLimit.inputTokenLimit;
            }
            if (this.paperCardConcurrency !== 1) {
              this.paperCardConcurrency = 1;
              this.log?.record("paper-card.concurrency-reduced", { ...details, concurrency: 1,
                activeRequests: this.activePaperCardRequests, ...rateLimit }, "warn");
            }
            if (rateLimit.rateLimitRetryable) {
              // Add a small margin to the provider's reset time; never shorten it.
              this.providerCooldownUntil = Math.max(this.providerCooldownUntil, this.now() + rateLimit.retryAfterMs + 1000);
            }
          }
          // Function Compute already performs its own short provider retry. The
          // browser retries only throttling/timeouts (plus network exceptions)
          // to avoid multiplying model calls.
          const retryable = rateLimit
            ? rateLimit.rateLimitRetryable && rateLimit.retryAfterMs <= 120000 &&
              !(path === "/api/literature/create-paper-card-from-text" && rateLimit.verifiedInputTokenRateLimit)
            : [408, 425, 504].includes(response.status);
          finish?.("failed", { status: response.status, code: error.code, retryable: retryable && attempt + 1 < maximumAttempts, providerAttempts: error.attempts, ...rateLimit });
          if (!retryable || attempt + 1 >= maximumAttempts) throw error;
          lastError = error;
        } catch (error) {
          if (release) this.paperCardRecoverySuccesses = 0;
          finish?.(error?.name === "AbortError" || error?.code === "OPERATION_ABORTED" ? "cancelled" : "failed",
            { code: error?.code || (error?.name === "AbortError" ? "OPERATION_ABORTED" : "NETWORK_ERROR") });
          if (error?.name === "AbortError") {
            throw new LiteratureError("OPERATION_ABORTED", "The literature operation was stopped.", error);
          }
          if (error instanceof LiteratureError) throw error;
          lastError = error;
          if (attempt + 1 >= maximumAttempts) break;
        } finally {
          release?.();
        }
        this.log?.record("backend-request.retry", { endpoint: path, attempt: attempt + 2, code: lastError?.code || "NETWORK_ERROR" }, "warn");
        if (this.providerCooldownUntil <= this.now()) await this.wait(400, signal);
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
        generateWikiPage: typeof this.api?.updateWikiPage === "function" ? (input, options) => this.api.updateWikiPage(input, options) : null,
        getPaperCardConfiguration:
          typeof this.api?.getPaperCardConfiguration === "function"
            ? (signal, callContext, workspace) => this.api.getPaperCardConfiguration(signal, callContext, workspace)
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
                      ...workerOptions?.callContext,
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
                      ...workerOptions?.callContext,
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
      const tree = options.tree || (options.reconciliation ? null : await this.workspace.scanDirectoryTree());
      const previous = Array.isArray(index.documents) ? index.documents : [];
      if (!this.sourceRegistry) {
        throw new LiteratureError(
          "SOURCE_REGISTRY_MISSING",
          "The local source registry could not be initialized."
        );
      }
      const reconciliation = options.reconciliation || await this.sourceRegistry.reconcile(tree, {
        legacyDocuments: previous,
      });
      try {
        if (!options.deferKnowledgeMaintenance) await this.sourceSystem?.knowledgeLifecycle?.reconcile(
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
          lastModified: Number(source.mtimeMs ?? source.mtimeNs),
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
            source.legacy?.discovery || (old.sourceHash === source.contentHash ? old.discovery : null),
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
      await this.scan(options.turnReconciliation ? { reconciliation: options.turnReconciliation, deferKnowledgeMaintenance: true } : {});
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
            ...options,
            deferWikiUpdate: true,
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
      await this.updateWikiAfterProcessing({
        ...options, action: "update", changedPaperIds: generatedPaperIds, paperIds: options.paperIds || [],
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
      if (
        !paperCardContract ||
        paperCardContract.generationStrategy !== PAPER_CARD_GENERATION_STRATEGY ||
        Number(paperCardContract.generationContractVersion) !==
          PAPER_CARD_GENERATION_CONTRACT_VERSION
      ) {
        throw new LiteratureError(
          "PAPER_CARD_CONFIGURATION_CHANGED",
          "The canonical Paper Card generation contract is unavailable or incompatible."
        );
      }
      const combinedText = combineExtractedPaperText(paperArtifact);
      const sourceText = combinedText.text;
      let chunkResult = chunkLiteratureText(sourceText, this.config);
      if (!chunkResult.chunks.length) {
        throw new LiteratureError("NO_TEXT_CHUNKS", "No usable text chunks were produced from this PDF.");
      }
      // Canonical cards must not vary with the language of the chat that first
      // causes processing. Question-level synthesis can localize the answer.
      const language = "en";
      let synthesized = null;
      let generationMode = null;
      let fallbackReason =
        paperCardContract.nativePdfSupported !== true
          ? "native-structured-output-unsupported"
          : typeof this.api?.analyzePdfNative !== "function"
            ? "native-api-unavailable"
            : "native-provider-failure";
      let nativeEvidenceValidation = null;
      let nativeProviderAttempts = 0;
      let nativeEndpointCalls = 0;
      let combinedTextProviderAttempts = 0;
      let combinedTextEndpointCalls = 0;
      let mapReduceReason = null;
      let mapReduceChunkCalls = 0;
      let mapReduceSynthesisCalls = 0;
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
        nativeEndpointCalls = 1;
        onProgress?.({
          stage: "native-paper-card-request",
          completed: 0,
          total: 1,
          providerRequest: true,
          route: "native-pdf",
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
            const supportedClaims = new Set(
              nativeEvidenceValidation.findings.map((item) => item.claim)
            );
            synthesized = {
              ...analysis,
              mainFindings: (analysis.majorFindings || [])
                .map((item) => item.claim)
                .filter((claim) => supportedClaims.has(claim)),
              importantResults: (analysis.importantResults || [])
                .map((item) => item.claim)
                .filter((claim) => supportedClaims.has(claim)),
              keyResults: allNativeFindings
                .map((item) => item.claim)
                .filter((claim) => supportedClaims.has(claim)),
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
              nativePdfProviderAttempts: nativeProviderAttempts,
              route: "native-pdf",
            });
          }
        } catch (error) {
          if (
            ["AUTH_REQUIRED", "NETWORK_ERROR", "OPERATION_ABORTED"].includes(error?.code) ||
            error?.terminalProviderFailure === true
          ) {
            onProgress?.({
              stage: "native-paper-card-failure",
              completed: 0,
              total: 1,
              providerRequest: false,
              providerAttempts: Math.max(0, Number(error?.attempts) || 0),
              nativePdfProviderAttempts:
                Math.max(0, Number(error?.attempts) || 0),
              fallbackReason: error?.fallbackReason || "native-provider-failure",
              route: "native-pdf",
            });
            throw error;
          }
          nativeProviderAttempts = Math.max(0, Number(error?.attempts) || 0);
          fallbackReason = error?.fallbackReason ||
            (error?.code === "NativePaperCardUnsupported"
              ? "native-structured-output-unsupported"
              : "native-provider-failure");
        }
      }

      const combinedTextLimit = Math.max(
        1,
        Number(paperCardContract?.combinedTextMaxCharacters) ||
          DEFAULT_COMBINED_TEXT_MAX_CHARACTERS
      );
      const combinedTextConfigured = Boolean(
        paperCardContract?.generationStrategy === PAPER_CARD_GENERATION_STRATEGY &&
        paperCardContract?.combinedTextSupported === true &&
        typeof this.api?.createPaperCardFromText === "function"
      );
      let useMapReduce = false;
      let quotaCharacterBudget = this.api.inputQuotaCharacterBudget?.(callContext) || 0;
      if (!synthesized && quotaCharacterBudget && sourceText.length > quotaCharacterBudget) {
        useMapReduce = true;
        mapReduceReason = "combined-text-input-token-rate-limit";
      }
      if (!synthesized && !useMapReduce && sourceText.length > combinedTextLimit) {
        useMapReduce = true;
        mapReduceReason = "combined-text-local-size-limit";
      }
      if (!synthesized && !useMapReduce && !combinedTextConfigured) {
        const error = new LiteratureError(
          "COMBINED_TEXT_PAPER_CARD_UNAVAILABLE",
          "The FC backend does not advertise a usable Paper Card text route. Deploy the current backend to enable validated JSON output."
        );
        error.fallbackReason = "combined-text-structured-output-unsupported";
        error.nativeFallbackReason = fallbackReason;
        throw error;
      }
      if (!synthesized && !useMapReduce) {
        onProgress?.({
          stage: "combined-paper-card-request",
          completed: 0,
          total: 1,
          fallbackReason,
          providerAttempts: nativeProviderAttempts,
          nativePdfProviderAttempts: nativeProviderAttempts,
          providerRequest: true,
          route: "combined-text",
          message: "Creating paper analysis from extracted text",
        });
        combinedTextEndpointCalls = 1;
        try {
          const combinedResult = await this.api.createPaperCardFromText(
            {
              paperId: source.sourceId,
              filename: source.displayName,
              contentHash,
              text: sourceText,
              pageCount: paperArtifact.pageCount || combinedText.pageCount,
              chunkCount: chunkResult.chunks.length,
              extractionTruncated:
                paperArtifact.truncated === true || chunkResult.truncated,
              language,
              callContext,
            },
            signal
          );
          combinedTextProviderAttempts = Math.max(
            0,
            Number(combinedResult.attempts) || 0
          );
          const validationErrors = nativePaperCardValidationErrors(combinedResult, {
            paperId: source.sourceId,
            contentHash,
            schemaVersion:
              paperCardContract.combinedTextSchemaVersion ||
              COMBINED_TEXT_PAPER_CARD_SCHEMA_VERSION,
            promptVersion:
              paperCardContract.combinedTextPromptVersion ||
              COMBINED_TEXT_PAPER_CARD_PROMPT_VERSION,
            modelSignature: paperCardContract.combinedTextModelSignature,
          });
          if (validationErrors.length) {
            const error = new LiteratureError(
              "COMBINED_TEXT_PAPER_CARD_INVALID",
              "The combined-text Paper Card failed local schema or provenance validation."
            );
            error.fallbackReason = "combined-text-schema-or-provenance-invalid";
            error.nativeFallbackReason = fallbackReason;
            throw error;
          }
          const analysis = combinedResult.analysis;
          const allFindings = [
            ...(analysis.majorFindings || []),
            ...(analysis.importantResults || []),
          ];
          nativeEvidenceValidation = validatedNativeEvidenceFindings(
            allFindings,
            paperArtifact,
            source.sourceId
          );
          const supportedClaims = new Set(
            nativeEvidenceValidation.findings.map((item) => item.claim)
          );
          synthesized = {
            ...analysis,
            mainFindings: (analysis.majorFindings || [])
              .map((item) => item.claim)
              .filter((claim) => supportedClaims.has(claim)),
            importantResults: (analysis.importantResults || [])
              .map((item) => item.claim)
              .filter((claim) => supportedClaims.has(claim)),
            keyResults: allFindings
              .map((item) => item.claim)
              .filter((claim) => supportedClaims.has(claim)),
            summary: analysis.shortSummary,
            model: combinedResult.model || null,
          };
          generationMode = "combined-text";
          onProgress?.({
            stage: "combined-paper-card-success",
            completed: 1,
            total: 1,
            fallbackReason,
            providerRequest: false,
            providerAttempts: combinedTextProviderAttempts,
            combinedTextProviderAttempts,
            route: "combined-text",
          });
        } catch (error) {
          combinedTextProviderAttempts = Math.max(
            combinedTextProviderAttempts,
            Number(error?.attempts) || 0
          );
          onProgress?.({
            stage: "combined-paper-card-failure",
            completed: 0,
            total: 1,
            fallbackReason,
            combinedTextFailureReason:
              error?.fallbackReason || "combined-text-provider-failure",
            code: error?.code,
            providerStatus: error?.providerStatus,
            retryAfterMs: error?.retryAfterMs,
            inputTokenLimit: error?.inputTokenLimit,
            verifiedContextLengthError:
              error?.verifiedContextLengthError === true,
            providerRequest: false,
            providerAttempts: combinedTextProviderAttempts,
            nativePdfProviderAttempts: nativeProviderAttempts,
            combinedTextProviderAttempts,
            route: "combined-text",
          });
          if (error?.verifiedInputTokenRateLimit === true && Number(error?.inputTokenLimit) > 2000 &&
            error?.rateLimitRetryable !== false && (Number(error?.retryAfterMs) || 0) <= 120000) {
            useMapReduce = true;
            mapReduceReason = "combined-text-input-token-rate-limit";
            quotaCharacterBudget = rateLimitApi.inputQuotaCharacterBudget(error.inputTokenLimit);
          } else if (error?.verifiedContextLengthError === true) {
            useMapReduce = true;
            mapReduceReason = error.fallbackReason || "combined-text-context-length";
          } else {
            error.nativeFallbackReason ||= fallbackReason;
            throw error;
          }
        }
      }

      if (!synthesized && useMapReduce) {
        if (quotaCharacterBudget && quotaCharacterBudget < this.config.chunkCharacters) {
          chunkResult = chunkLiteratureText(sourceText, { ...this.config, chunkCharacters: quotaCharacterBudget,
            chunkOverlap: Math.min(this.config.chunkOverlap, Math.floor(quotaCharacterBudget / 10)) });
          if (chunkResult.truncated) throw new LiteratureError("PAPER_CARD_QUOTA_TOO_SMALL", "The provider input-token quota is too small to process the full paper within the bounded excerpt limit.");
        }
        generationMode = "map-reduce";
        onProgress?.({
          stage: "map-reduce-start",
          completed: 0,
          total: chunkResult.chunks.length,
          fallbackReason,
          mapReduceReason,
          providerRequest: false,
          route: "map-reduce",
          nativePdfProviderAttempts: nativeProviderAttempts,
          combinedTextProviderAttempts,
        });
        onProgress?.({
          stage: "summarizing",
          completed: 0,
          total: chunkResult.chunks.length,
          fallbackReason,
          mapReduceReason,
          route: "map-reduce",
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
                callContext,
              },
              signal
            );
            mapReduceChunkCalls += 1;
            completed += 1;
            onProgress?.({
              stage: "summarizing",
              completed,
              total: chunkResult.chunks.length,
              fallbackReason,
              mapReduceReason,
              route: "map-reduce",
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
          mapReduceReason,
          route: "map-reduce",
        });
        // All excerpts are retained. If their summaries exceed a learned token
        // quota, reduce bounded groups before the final synthesis instead of
        // truncating evidence or resubmitting an oversized summary payload.
        let synthesisInputs = chunkSummaries;
        const synthesisBudget = this.api.inputQuotaCharacterBudget?.(callContext) || quotaCharacterBudget;
        for (let round = 0; synthesisBudget && JSON.stringify(synthesisInputs).length > synthesisBudget; round++) {
          if (round >= 3 || synthesisInputs.length < 2) throw new LiteratureError("PAPER_CARD_QUOTA_TOO_SMALL", "The provider input-token quota is too small for the bounded synthesis.");
          const groups = [];
          let group = [];
          for (const summary of synthesisInputs) {
            if (JSON.stringify([summary]).length > synthesisBudget) throw new LiteratureError("PAPER_CARD_QUOTA_TOO_SMALL", "One excerpt summary exceeds the provider input-token budget.");
            if (group.length && JSON.stringify([...group, summary]).length > synthesisBudget) { groups.push(group); group = []; }
            group.push(summary);
          }
          if (group.length) groups.push(group);
          const reduced = [];
          for (const [index, summaries] of groups.entries()) {
            onProgress?.({ stage: "synthesizing", route: "map-reduce", mapReduceReason, completed: index, total: groups.length });
            if (summaries.length === 1) { reduced.push(summaries[0]); continue; }
            mapReduceSynthesisCalls++;
            reduced.push(await this.api.synthesize({ filename: source.displayName, pageCount: paperArtifact.pageCount,
              chunkSummaries: summaries, language, callContext }, signal));
          }
          if (JSON.stringify(reduced).length >= JSON.stringify(synthesisInputs).length) throw new LiteratureError("PAPER_CARD_QUOTA_TOO_SMALL", "Grouped summaries could not fit the provider input-token budget.");
          synthesisInputs = reduced;
        }
        mapReduceSynthesisCalls++;
        synthesized = await this.api.synthesize(
          {
            filename: source.displayName,
            size: source.sizeBytes,
            lastModified: source.mtimeNs,
            pageCount: paperArtifact.pageCount,
            extractionTruncated: paperArtifact.truncated || chunkResult.truncated,
            chunkSummaries: synthesisInputs,
            language,
            callContext,
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
          (generationMode === "map-reduce" && synthesized.modelSignature &&
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
          (["native-pdf", "combined-text"].includes(generationMode)
            ? PAPER_CARD_GENERATION_STRATEGY
            : "text-map-reduce-v1"),
        generationContractVersion:
          Number(paperCardContract?.generationContractVersion) || 0,
        generationMode,
        fallbackReason,
        nativePdfSchemaVersion:
          Number(paperCardContract?.nativePdfSchemaVersion) || 0,
        nativePdfPromptVersion:
          paperCardContract?.nativePdfPromptVersion || "not-applicable",
        nativePdfModelSignature:
          paperCardContract?.nativePdfModelSignature || "not-applicable",
        combinedTextSchemaVersion:
          Number(paperCardContract?.combinedTextSchemaVersion) || 0,
        combinedTextSupported:
          paperCardContract?.combinedTextSupported === true,
        combinedTextMaxCharacters:
          Math.max(0, Number(paperCardContract?.combinedTextMaxCharacters) || 0),
        combinedTextPromptVersion:
          paperCardContract?.combinedTextPromptVersion || "not-applicable",
        combinedTextModelSignature:
          paperCardContract?.combinedTextModelSignature || "not-applicable",
        generationDiagnostics: {
          mode: generationMode,
          route: generationMode,
          fallbackReason,
          mapReduceReason,
          nativePdfEndpointCalls: nativeEndpointCalls,
          nativePdfProviderAttempts: nativeProviderAttempts,
          combinedTextEndpointCalls,
          combinedTextProviderAttempts,
          mapReduceChunkCalls,
          mapReduceSynthesisCalls,
          nativeEvidenceCitationsSubmitted:
            nativeEvidenceValidation?.submittedCitations || 0,
          nativeEvidenceCitationsVerified:
            nativeEvidenceValidation?.verifiedCitations || 0,
          nativeEvidenceCitationsDropped:
            nativeEvidenceValidation?.droppedCitations || 0,
          evidenceFindingsSubmitted:
            nativeEvidenceValidation?.submittedFindings || 0,
          evidenceFindingsVerified:
            nativeEvidenceValidation?.verifiedFindings || 0,
          evidenceFindingsDropped:
            nativeEvidenceValidation?.droppedFindings || 0,
          textFallbackOperations: generationMode === "map-reduce" ? 1 : 0,
        },
        cacheKey: makePaperCardCacheKey({
          sourceId: source.sourceId,
          contentHash,
          schemaVersion: PAPER_CARD_VERSION,
          modelSignature: effectiveModelSignature,
          promptVersion: PAPER_CARD_PROMPT_VERSION,
          generationStrategy:
            paperCardContract?.generationStrategy ||
            (["native-pdf", "combined-text"].includes(generationMode)
              ? PAPER_CARD_GENERATION_STRATEGY
              : "text-map-reduce-v1"),
          generationContractVersion:
            Number(paperCardContract?.generationContractVersion) || 0,
          nativePdfSchemaVersion:
            Number(paperCardContract?.nativePdfSchemaVersion) || 0,
          nativePdfPromptVersion:
            paperCardContract?.nativePdfPromptVersion || "not-applicable",
          nativePdfModelSignature:
            paperCardContract?.nativePdfModelSignature || "not-applicable",
          combinedTextSchemaVersion:
            Number(paperCardContract?.combinedTextSchemaVersion) || 0,
          combinedTextMaxCharacters:
            Math.max(0, Number(paperCardContract?.combinedTextMaxCharacters) || 0),
          combinedTextPromptVersion:
            paperCardContract?.combinedTextPromptVersion || "not-applicable",
          combinedTextModelSignature:
            paperCardContract?.combinedTextModelSignature || "not-applicable",
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
      onProgress?.({
        stage: "complete",
        completed: 1,
        total: 1,
        route: generationMode,
        fallbackReason,
        mapReduceReason,
        accounting: {
          nativePdfEndpointCalls: nativeEndpointCalls,
          nativePdfProviderAttempts: nativeProviderAttempts,
          combinedTextEndpointCalls,
          combinedTextProviderAttempts,
          mapReduceChunkCalls,
          mapReduceSynthesisCalls,
        },
      });
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
        generationContractVersion: card.generationContractVersion,
        combinedTextSchemaVersion: card.combinedTextSchemaVersion,
        combinedTextSupported: card.combinedTextSupported,
        combinedTextMaxCharacters: card.combinedTextMaxCharacters,
        combinedTextPromptVersion: card.combinedTextPromptVersion,
        combinedTextModelSignature: card.combinedTextModelSignature,
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
      await this.scan(options.turnReconciliation ? { reconciliation: options.turnReconciliation, deferKnowledgeMaintenance: true } : {});
      const current = this.findDocument(documentId);
      const card = await this.workspace.readJson(current.paperCardPath);
      const sourceText = options.includeSourceText
        ? (await this.extractText(documentId, options)).text
        : "";
      if (!options.deferWikiUpdate) await this.updateWikiAfterProcessing({
        ...options, changedPaperIds: [documentId],
      });
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

    async updateWikiAfterProcessing(options) {
      if (!this.sourceSystem?.literatureWiki?.generateWikiPage) return;
      try { return await this.sourceSystem.literatureWiki.maintain(options); }
      catch (error) {
        if (error.code === "OPERATION_ABORTED" || options.signal?.aborted) throw error;
        options.onProgress?.({ stage: "wiki-unavailable", code: "WIKI_UPDATE_FAILED" });
        return { status: "unavailable", generationCalls: 0 };
      }
    }
  }

  return {
    LITERATURE_CONFIG,
    LiteratureApiClient,
    LiteratureError,
    LiteratureModule,
    PAPER_CARD_VERSION,
    combineExtractedPaperText,
    chunkLiteratureText,
    createPaperDiscoveryRecord,
    extractLocalPdf,
    hashLiteratureFile,
    runWithConcurrency,
  };
});
