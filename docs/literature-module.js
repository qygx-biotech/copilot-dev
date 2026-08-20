(function exposeLiteratureModule(root, factory) {
  const api = factory(root);
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) Object.assign(root, api);
})(typeof globalThis !== "undefined" ? globalThis : this, function literatureFactory(root) {
  "use strict";

  const LITERATURE_CONFIG = Object.freeze({
    chunkCharacters: 10000,
    chunkOverlap: 400,
    chunkConcurrency: 2,
    maxExtractedCharacters: 180000,
    minimumReadableCharacters: 200,
    maxChunks: 48,
  });

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
      const buffer = await file.arrayBuffer();
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

  class LiteratureApiClient {
    constructor(options) {
      this.baseUrl = String(options.baseUrl || "").replace(/\/$/, "");
      this.getHeaders = options.getHeaders || (() => ({}));
      this.onUnauthorized = options.onUnauthorized || (() => {});
      this.fetch = options.fetch || root.fetch.bind(root);
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
      return { ...data.summary, model: data.model || null };
    }

    async request(path, body, signal) {
      let lastError;
      for (let attempt = 0; attempt < 2; attempt += 1) {
        assertNotAborted(signal);
        try {
          const response = await this.fetch(`${this.baseUrl}${path}`, {
            method: "POST",
            headers: { ...this.getHeaders(), "Content-Type": "application/json" },
            body: JSON.stringify(body),
            signal,
          });
          if (response.status === 401) {
            this.onUnauthorized();
            throw new LiteratureError("AUTH_REQUIRED", "Your login session has expired.");
          }
          const data = await response.json().catch(() => ({}));
          if (response.ok && data.ok) return data;
          const error = new LiteratureError(
            data.error || "LLM_REQUEST_FAILED",
            data.message || `Function Compute returned HTTP ${response.status}.`
          );
          // Function Compute already performs its own short provider retry. The
          // browser retries only throttling/timeouts (plus network exceptions)
          // to avoid multiplying model calls.
          const retryable = [408, 425, 429, 504].includes(response.status);
          if (!retryable || attempt > 0) throw error;
          lastError = error;
        } catch (error) {
          if (error?.name === "AbortError") {
            throw new LiteratureError("OPERATION_ABORTED", "The literature operation was stopped.", error);
          }
          if (error instanceof LiteratureError) throw error;
          lastError = error;
          if (attempt > 0) break;
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
      this.config = { ...LITERATURE_CONFIG, ...(options.config || {}) };
      this.index = null;
      this.documents = [];
    }

    async scan() {
      const index = await this.workspace.readJson(".biodesign/literature/index.json");
      const tree = await this.workspace.scanDirectoryTree();
      const scanned = [];
      const collectPdfs = (node) => {
        if (node.type === "file" && node.name.toLowerCase().endsWith(".pdf")) {
          scanned.push(node);
          return;
        }
        (node.children || []).forEach(collectPdfs);
      };
      collectPdfs(tree);
      const previous = Array.isArray(index.documents) ? index.documents : [];
      const previousByPath = new Map(previous.map((document) => [document.relativePath, document]));
      const unmatched = new Set(previous);
      const metadataGroups = new Map();
      previous.forEach((document) => {
        const key = `${Number(document.size)}:${Number(document.lastModified)}`;
        const values = metadataGroups.get(key) || [];
        values.push(document);
        metadataGroups.set(key, values);
      });

      const documents = [];
      for (const file of scanned) {
        let old = previousByPath.get(file.relativePath) || null;
        if (!old) {
          const key = `${Number(file.size)}:${Number(file.lastModified)}`;
          const candidates = (metadataGroups.get(key) || []).filter((candidate) => unmatched.has(candidate));
          if (candidates.length === 1) old = candidates[0];
        }
        if (old) unmatched.delete(old);

        const changed = Boolean(
          old &&
            (Number(old.size) !== Number(file.size) ||
              Number(old.lastModified) !== Number(file.lastModified))
        );
        const id = old?.id || this.workspace.createId();
        const summaryPath =
          old?.summaryPath || `.biodesign/literature/summaries/${id}.json`;
        const summaryAvailable = await this.workspace.fileExists(summaryPath);
        documents.push({
          id,
          relativePath: file.relativePath,
          filename: file.name,
          size: Number(file.size),
          lastModified: Number(file.lastModified),
          status: changed && summaryAvailable ? "stale" : "ready",
          summaryPath,
          summaryAvailable,
          summaryStale: changed && summaryAvailable,
        });
      }

      this.index = {
        schemaVersion: 1,
        documents: documents.map(({ summaryAvailable, summaryStale, ...document }) => document),
        updatedAt: this.now().toISOString(),
      };
      this.documents = documents;
      await this.workspace.writeJson(".biodesign/literature/index.json", this.index);
      return documents;
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
      return { addedNames, documents: await this.scan() };
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

    async loadSummary(documentId) {
      const document = this.findDocument(documentId);
      if (!(await this.workspace.fileExists(document.summaryPath))) return null;
      const summary = await this.workspace.readJson(document.summaryPath);
      if (summary.documentId !== document.id) {
        throw new LiteratureError("SUMMARY_MISMATCH", "The cached summary belongs to a different paper record.");
      }
      return summary;
    }

    async removeDocument(documentId) {
      const document = this.findDocument(documentId);
      await this.workspace.removeFile(document.relativePath);
      return this.scan();
    }

    async extractText(documentId, options = {}) {
      const document = this.findDocument(documentId);
      const signal = options.signal;
      assertNotAborted(signal);
      const file = await this.workspace.readFile(document.relativePath);
      return extractLocalPdf(file, this.pdfjsLib, {
        ...this.config,
        workerSrc: this.pdfWorkerSrc,
        signal,
      });
    }

    async summarize(documentId, options = {}) {
      const document = this.findDocument(documentId);
      const cached = await this.loadSummary(documentId);
      if (!options.force && document.status !== "stale" && cached) {
        return { summary: cached, cached: true };
      }

      const signal = options.signal;
      assertNotAborted(signal);
      options.onProgress?.({ stage: "extracting", completed: 0, total: 1 });
      const file = await this.workspace.readFile(document.relativePath);
      const originalMetadata = { size: file.size, lastModified: file.lastModified };
      const extracted = await extractLocalPdf(file, this.pdfjsLib, {
        ...this.config,
        workerSrc: this.pdfWorkerSrc,
        signal,
      });
      const chunkResult = chunkLiteratureText(extracted.text, this.config);
      if (!chunkResult.chunks.length) {
        throw new LiteratureError("NO_TEXT_CHUNKS", "No usable text chunks were produced from this PDF.");
      }

      const language = this.getLanguage() === "zh" ? "zh" : "en";
      options.onProgress?.({
        stage: "summarizing",
        completed: 0,
        total: chunkResult.chunks.length,
      });
      let completed = 0;
      const chunkSummaries = await runWithConcurrency(
        chunkResult.chunks,
        this.config.chunkConcurrency,
        async (text, index) => {
          const result = await this.api.summarizeChunk(
            {
              filename: document.filename,
              chunkIndex: index,
              totalChunks: chunkResult.chunks.length,
              text,
              language,
            },
            signal
          );
          completed += 1;
          options.onProgress?.({
            stage: "summarizing",
            completed,
            total: chunkResult.chunks.length,
          });
          return result;
        }
      );

      assertNotAborted(signal);
      options.onProgress?.({ stage: "synthesizing", completed: 0, total: 1 });
      const synthesized = await this.api.synthesize(
        {
          filename: document.filename,
          size: document.size,
          lastModified: document.lastModified,
          pageCount: extracted.pageCount,
          extractionTruncated: extracted.truncated || chunkResult.truncated,
          chunkSummaries,
          language,
        },
        signal
      );

      const latestFile = await this.workspace.readFile(document.relativePath);
      if (
        latestFile.size !== originalMetadata.size ||
        latestFile.lastModified !== originalMetadata.lastModified
      ) {
        throw new LiteratureError(
          "SOURCE_CHANGED",
          "The PDF changed while it was being summarized. Refresh Literature and try again."
        );
      }

      const generatedAt = this.now().toISOString();
      const summary = {
        schemaVersion: 1,
        documentId: document.id,
        generatedAt,
        source: {
          filename: document.filename,
          size: document.size,
          lastModified: document.lastModified,
          pageCount: extracted.pageCount,
          processedCharacters: chunkResult.processedCharacters,
          truncated: extracted.truncated || chunkResult.truncated,
        },
        model: synthesized.model || null,
        title: extracted.metadataTitle || synthesized.title || document.filename || null,
        summary: String(synthesized.summary || ""),
        researchQuestion: synthesized.researchQuestion || null,
        methods: synthesized.methods || null,
        keyResults: Array.isArray(synthesized.keyResults) ? synthesized.keyResults : [],
        limitations: Array.isArray(synthesized.limitations) ? synthesized.limitations : [],
        mainConclusion: synthesized.mainConclusion || null,
        keywords: Array.isArray(synthesized.keywords) ? synthesized.keywords : [],
      };

      assertNotAborted(signal);
      await this.workspace.writeJson(document.summaryPath, summary);
      document.status = "ready";
      document.summaryAvailable = true;
      document.summaryStale = false;
      document.summaryUpdatedAt = generatedAt;
      await this.workspace.writeJson(".biodesign/literature/index.json", {
        ...this.index,
        updatedAt: generatedAt,
      });
      options.onProgress?.({ stage: "complete", completed: 1, total: 1 });
      return {
        summary,
        cached: false,
        sourceText: options.includeSourceText ? extracted.text : "",
      };
    }
  }

  return {
    LITERATURE_CONFIG,
    LiteratureApiClient,
    LiteratureError,
    LiteratureModule,
    chunkLiteratureText,
    extractLocalPdf,
    runWithConcurrency,
  };
});
