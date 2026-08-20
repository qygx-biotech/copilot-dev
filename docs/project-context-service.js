(function exposeProjectContextService(root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) Object.assign(root, api);
})(typeof globalThis !== "undefined" ? globalThis : this, function contextFactory() {
  "use strict";

  const CHAT_SCHEMA_VERSION = 1;
  const CONTEXT_LIMITS = {
    maxInventoryFiles: 500,
    maxProjectSummaries: 20,
    maxEvidenceFiles: 20,
    maxSummaryCharactersPerFile: 7000,
    maxSourceCharactersPerFile: 6500,
    maxConversationMessages: 20,
    maxConversationMessageCharacters: 4000,
    maxConversationCharacters: 24000,
    maxStoredMessages: 60,
    maxStoredMessageCharacters: 12000,
    maxStoredConversationCharacters: 96000,
  };

  const DETAIL_QUESTION_PATTERN =
    /\b(exact|concentration|dose|dosage|amount|value|third|second|first|figure|table|supplement|time|duration|temperature|ph|rpm|od\d*|measur(?:e|ed|ement)|assay|protocol|condition|replicate|statistical|significance|how many|how much)\b|浓度|剂量|数值|图\s*\d|表\s*\d|时间|温度|转速|测量|实验条件|重复|显著性/i;
  const PROJECT_METADATA_QUESTION_PATTERN =
    /\b(what files|which files|files are selected|current selection|workspace contain|project goal|project context|what are we trying to achieve)\b|选择了哪些文件|当前选择|工作区.*文件|项目目标|项目背景/i;

  const STOP_WORDS = new Set([
    "about",
    "after",
    "also",
    "and",
    "are",
    "does",
    "from",
    "have",
    "how",
    "into",
    "paper",
    "that",
    "their",
    "then",
    "these",
    "they",
    "this",
    "used",
    "using",
    "what",
    "when",
    "where",
    "which",
    "with",
    "would",
  ]);

  function isPlainObject(value) {
    return Boolean(value && typeof value === "object" && !Array.isArray(value));
  }

  function normalizePath(value) {
    return String(value || "")
      .replaceAll("\\", "/")
      .replace(/^\/+/, "")
      .replace(/\/{2,}/g, "/")
      .trim();
  }

  function fileExtension(value) {
    const name = String(value || "");
    const index = name.lastIndexOf(".");
    return index > 0 ? name.slice(index + 1).toLowerCase() : "";
  }

  function flattenWorkspaceTree(tree) {
    const entries = [];
    const visit = (node) => {
      if (!node || typeof node !== "object") return;
      if (node.relativePath) entries.push(node);
      (Array.isArray(node.children) ? node.children : []).forEach(visit);
    };
    visit(tree);
    return entries;
  }

  function formatPaperSummary(summary, relativePath) {
    const lines = [
      `Cached scientific understanding for ${relativePath}:`,
      summary.title ? `Title: ${summary.title}` : "",
      summary.summary ? `Summary: ${summary.summary}` : "",
      summary.researchQuestion ? `Research question: ${summary.researchQuestion}` : "",
      summary.methods ? `Methods: ${summary.methods}` : "",
      Array.isArray(summary.keyResults) && summary.keyResults.length
        ? `Key results:\n${summary.keyResults.map((item) => `- ${item}`).join("\n")}`
        : "",
      Array.isArray(summary.limitations) && summary.limitations.length
        ? `Limitations:\n${summary.limitations.map((item) => `- ${item}`).join("\n")}`
        : "",
      summary.mainConclusion ? `Main conclusion: ${summary.mainConclusion}` : "",
    ];
    return lines.filter(Boolean).join("\n");
  }

  function questionNeedsSourceEvidence(question) {
    return DETAIL_QUESTION_PATTERN.test(String(question || ""));
  }

  function questionRequiresFileEvidence(question) {
    const value = String(question || "").trim();
    return Boolean(value && !PROJECT_METADATA_QUESTION_PATTERN.test(value));
  }

  function tokenizeQuestion(question) {
    return [...new Set(
      String(question || "")
        .toLowerCase()
        .match(/[a-z0-9][a-z0-9-]{2,}|[\u3400-\u9fff]{2,}/g) || []
    )].filter((token) => !STOP_WORDS.has(token));
  }

  function makeTextWindows(text, size = 1800, overlap = 220) {
    const normalized = String(text || "").replace(/\s+/g, " ").trim();
    const windows = [];
    for (let start = 0; start < normalized.length; start += size - overlap) {
      const end = Math.min(normalized.length, start + size);
      windows.push({ start, text: normalized.slice(start, end) });
      if (end >= normalized.length) break;
    }
    return windows;
  }

  function selectRelevantExcerpts(text, question, options = {}) {
    const maxCharacters = Number(options.maxCharacters) || 6500;
    const maxExcerpts = Number(options.maxExcerpts) || 3;
    const tokens = tokenizeQuestion(question);
    const ranked = makeTextWindows(text).map((window, index) => {
      const lower = window.text.toLowerCase();
      const score = tokens.reduce((total, token) => {
        let count = 0;
        let position = lower.indexOf(token);
        while (position >= 0 && count < 8) {
          count += 1;
          position = lower.indexOf(token, position + token.length);
        }
        return total + count;
      }, 0);
      return { ...window, index, score };
    });
    ranked.sort((left, right) => right.score - left.score || left.index - right.index);
    const chosen = ranked
      .slice(0, maxExcerpts)
      .sort((left, right) => left.index - right.index);
    let remaining = maxCharacters;
    return chosen
      .map((excerpt, index) => {
        const value = excerpt.text.slice(0, remaining);
        remaining -= value.length;
        return value ? `[Source excerpt ${index + 1}]\n${value}` : "";
      })
      .filter(Boolean)
      .join("\n\n");
  }

  function boundedMessages(messages, limits = CONTEXT_LIMITS) {
    const candidates = (Array.isArray(messages) ? messages : [])
      .filter(
        (message) =>
          message &&
          (message.role === "user" || message.role === "assistant") &&
          typeof message.content === "string" &&
          message.content.trim()
      )
      .slice(-limits.maxConversationMessages * 2)
      .map((message) => ({
        role: message.role,
        content: message.content.trim().slice(0, limits.maxConversationMessageCharacters),
      }));
    const selected = [];
    let remaining = limits.maxConversationCharacters;
    for (let index = candidates.length - 1; index >= 0; index -= 1) {
      if (selected.length >= limits.maxConversationMessages || remaining <= 0) break;
      const content = candidates[index].content.slice(0, remaining);
      if (!content) continue;
      selected.unshift({ role: candidates[index].role, content });
      remaining -= content.length;
    }
    return selected;
  }

  function normalizeStoredConversation(conversation, limits = CONTEXT_LIMITS) {
    const candidates = (Array.isArray(conversation?.messages) ? conversation.messages : [])
      .filter(
        (message) =>
          message &&
          (message.role === "user" || message.role === "assistant") &&
          typeof message.id === "string" &&
          message.id &&
          typeof message.content === "string" &&
          message.content.trim() &&
          typeof message.createdAt === "string"
      )
      .slice(-limits.maxStoredMessages * 2)
      .map((message) => ({
        id: message.id,
        role: message.role,
        content: message.content.trim().slice(0, limits.maxStoredMessageCharacters),
        ...(message.role === "user" && isPlainObject(message.context)
          ? {
              context: {
                type: message.context.type === "files" ? "files" : "project",
                files: [...new Set(
                  (Array.isArray(message.context.files) ? message.context.files : [])
                    .map(normalizePath)
                    .filter(Boolean)
                )].slice(0, limits.maxInventoryFiles),
              },
            }
          : {}),
        createdAt: message.createdAt,
      }));
    const messages = [];
    let remaining = limits.maxStoredConversationCharacters;
    for (let index = candidates.length - 1; index >= 0; index -= 1) {
      if (messages.length >= limits.maxStoredMessages || remaining <= 0) break;
      const content = candidates[index].content.slice(0, remaining);
      if (!content) continue;
      messages.unshift({ ...candidates[index], content });
      remaining -= content.length;
    }
    return {
      schemaVersion: CHAT_SCHEMA_VERSION,
      id: String(conversation.id || ""),
      title: String(conversation.title || "Side Chat").slice(0, 120),
      createdAt: String(conversation.createdAt || ""),
      updatedAt: String(conversation.updatedAt || ""),
      summary: String(conversation.summary || "").slice(0, 12000),
      messages,
    };
  }

  class WorkspaceChatStore {
    constructor(options) {
      this.workspace = options.workspace;
      this.now = options.now || (() => new Date());
      this.limits = { ...CONTEXT_LIMITS, ...(options.limits || {}) };
      this.indexPath = ".biodesign/chat/index.json";
      this.conversationsDirectory = ".biodesign/chat/conversations";
    }

    timestamp() {
      return this.now().toISOString();
    }

    conversationPath(id) {
      return `${this.conversationsDirectory}/${id}.json`;
    }

    async readIndex() {
      await this.workspace.ensureDirectory(this.conversationsDirectory);
      if (!(await this.workspace.fileExists(this.indexPath))) {
        const index = {
          schemaVersion: CHAT_SCHEMA_VERSION,
          activeConversationId: "",
          conversations: [],
          updatedAt: this.timestamp(),
        };
        await this.workspace.writeJson(this.indexPath, index);
        return index;
      }
      return this.workspace.readJson(this.indexPath);
    }

    createConversation() {
      const timestamp = this.timestamp();
      return {
        schemaVersion: CHAT_SCHEMA_VERSION,
        id: this.workspace.createId(),
        title: "Side Chat",
        createdAt: timestamp,
        updatedAt: timestamp,
        summary: "",
        messages: [],
      };
    }

    async loadActiveConversation() {
      const index = await this.readIndex();
      if (index.activeConversationId) {
        const path = this.conversationPath(index.activeConversationId);
        if (await this.workspace.fileExists(path)) {
          return this.workspace.readJson(path);
        }
      }
      const conversation = this.createConversation();
      await this.saveConversation(conversation, index);
      return conversation;
    }

    async saveConversation(conversation, suppliedIndex = null) {
      const timestamp = this.timestamp();
      const normalized = normalizeStoredConversation(
        {
          ...conversation,
          updatedAt: timestamp,
          title:
            conversation.title === "Side Chat" && conversation.messages?.length
              ? conversation.messages.find((message) => message.role === "user")?.content ||
                conversation.title
              : conversation.title,
        },
        this.limits
      );
      await this.workspace.writeJson(this.conversationPath(normalized.id), normalized);
      const index = suppliedIndex || (await this.readIndex());
      const record = {
        id: normalized.id,
        title: normalized.title.slice(0, 120),
        createdAt: normalized.createdAt,
        updatedAt: normalized.updatedAt,
        messageCount: normalized.messages.length,
      };
      const conversations = [
        record,
        ...index.conversations.filter((item) => item.id !== normalized.id),
      ].slice(0, 50);
      await this.workspace.writeJson(this.indexPath, {
        schemaVersion: CHAT_SCHEMA_VERSION,
        activeConversationId: normalized.id,
        conversations,
        updatedAt: timestamp,
      });
      return normalized;
    }

    async clearActiveConversation() {
      const index = await this.readIndex();
      const activeId = index.activeConversationId;
      if (activeId && (await this.workspace.fileExists(this.conversationPath(activeId)))) {
        await this.workspace.removeFile(this.conversationPath(activeId));
      }
      const clearedIndex = {
        schemaVersion: CHAT_SCHEMA_VERSION,
        activeConversationId: "",
        conversations: index.conversations.filter((item) => item.id !== activeId),
        updatedAt: this.timestamp(),
      };
      await this.workspace.writeJson(this.indexPath, clearedIndex);
      const conversation = this.createConversation();
      await this.saveConversation(conversation, clearedIndex);
      return conversation;
    }
  }

  class ProjectContextService {
    constructor(options) {
      this.workspace = options.workspace;
      this.literature = options.literature;
      this.limits = { ...CONTEXT_LIMITS, ...(options.limits || {}) };
    }

    buildConversationContext(conversation) {
      return {
        summary: String(
          conversation?.summary || this.workspace.state?.memory?.conversationSummary || ""
        ).slice(0, 12000),
        recentMessages: boundedMessages(conversation?.messages, this.limits),
      };
    }

    buildInventory(workspaceTree) {
      const literatureByPath = new Map(
        (this.literature?.documents || []).map((document) => [
          document.relativePath,
          document,
        ])
      );
      return flattenWorkspaceTree(workspaceTree)
        .filter((entry) => entry.type === "file")
        .slice(0, this.limits.maxInventoryFiles)
        .map((entry) => {
          const document = literatureByPath.get(entry.relativePath);
          const extension = fileExtension(entry.name);
          return {
            name: entry.name,
            relativePath: entry.relativePath,
            extension,
            size: Number(entry.size) || 0,
            lastModified: Number(entry.lastModified) || 0,
            processor: extension === "pdf" ? "pdf" : null,
            summaryAvailable: Boolean(document?.summaryAvailable),
            summaryStatus: document?.status || "unprocessed",
          };
        });
    }

    async buildContext(options) {
      const selectedPaths = [...new Set(
        (Array.isArray(options.selectedPaths) ? options.selectedPaths : [])
          .map(normalizePath)
          .filter(Boolean)
      )];
      if (!selectedPaths.length) return this.buildProjectContext(options);
      const entriesByPath = new Map(
        flattenWorkspaceTree(options.workspaceTree).map((entry) => [
          entry.relativePath,
          entry,
        ])
      );
      const selectedFiles = selectedPaths
        .map((path) => entriesByPath.get(path))
        .filter((entry) => entry?.type === "file");
      if (selectedFiles.length === 1) {
        return this.buildSingleFileContext(selectedFiles[0], options);
      }
      return this.buildMultiFileContext(selectedFiles, options);
    }

    baseContext(options, type, files = []) {
      const memory = this.workspace.state?.memory || {};
      return {
        schemaVersion: 1,
        scope: {
          type,
          files: files.map((file) => file.relativePath),
        },
        project: {
          workspaceName: this.workspace.workspace?.name || "",
          goal: String(options.projectGoal || this.workspace.state?.project?.goal || ""),
          projectSummary: String(memory.projectSummary || "").slice(0, 8000),
          literatureSummary: String(memory.literatureSummary || "").slice(0, 8000),
          experimentalSummary: String(memory.experimentalSummary || "").slice(0, 8000),
        },
        inventory: this.buildInventory(options.workspaceTree),
        files: [],
        notices: [],
      };
    }

    async buildProjectContext(options) {
      const context = this.baseContext(options, "project");
      const documents = (this.literature?.documents || [])
        .filter((document) => document.summaryAvailable)
        .slice(0, this.limits.maxProjectSummaries);
      for (const document of documents) {
        try {
          const summary = await this.literature.loadSummary(document.id);
          if (!summary) continue;
          context.files.push({
            name: document.filename,
            relativePath: document.relativePath,
            extension: "pdf",
            analysisStatus: document.status === "stale" ? "cached-stale" : "processed",
            evidenceType: "cached-summary",
            content: formatPaperSummary(summary, document.relativePath).slice(
              0,
              this.limits.maxSummaryCharactersPerFile
            ),
          });
        } catch (error) {
          context.notices.push(
            `Cached understanding for ${document.relativePath} could not be loaded: ${error.message}`
          );
        }
      }
      const unprocessed = context.inventory.filter(
        (item) => item.processor === "pdf" && !item.summaryAvailable
      );
      if (unprocessed.length) {
        context.notices.push(
          `${unprocessed.length} PDF file(s) are visible but have not been processed. Their filenames are inventory only, not evidence.`
        );
      }
      const unsupported = context.inventory.filter((item) => !item.processor);
      if (unsupported.length) {
        context.notices.push(
          `${unsupported.length} non-PDF file(s) are visible in the workspace but do not yet have an AI content processor.`
        );
      }
      return context;
    }

    async buildSingleFileContext(file, options) {
      const context = this.baseContext(options, "files", [file]);
      context.files = [await this.buildFileEvidence(file, options)];
      this.addFileNotices(context);
      return context;
    }

    async buildMultiFileContext(files, options) {
      const boundedFiles = files.slice(0, this.limits.maxEvidenceFiles);
      const context = this.baseContext(options, "files", boundedFiles);
      const evidence = new Array(boundedFiles.length);
      let cursor = 0;
      const worker = async () => {
        while (cursor < boundedFiles.length) {
          const index = cursor;
          cursor += 1;
          evidence[index] = await this.buildFileEvidence(boundedFiles[index], options);
        }
      };
      await Promise.all(
        Array.from({ length: Math.min(2, boundedFiles.length) }, () => worker())
      );
      context.files = evidence;
      if (files.length > boundedFiles.length) {
        context.notices.push(
          `${files.length - boundedFiles.length} additional selected file(s) were not included in this bounded AI request.`
        );
      }
      this.addFileNotices(context);
      return context;
    }

    addFileNotices(context) {
      const unsupported = context.files.filter(
        (file) => file.analysisStatus === "unsupported"
      );
      unsupported.forEach((file) => {
        context.notices.push(
          `${file.relativePath} is selected, but .${file.extension || "unknown"} files do not yet have an AI content processor.`
        );
      });
      context.files
        .filter((file) => file.analysisStatus === "unprocessed")
        .forEach((file) =>
          context.notices.push(
            `${file.relativePath} is selected but was not processed because this question only requires workspace metadata.`
          )
        );
      context.files
        .filter((file) => file.analysisStatus === "processing-failed")
        .forEach((file) => context.notices.push(file.error));
    }

    async buildFileEvidence(file, options) {
      const extension = fileExtension(file.name);
      if (extension !== "pdf") {
        return {
          name: file.name,
          relativePath: file.relativePath,
          extension,
          analysisStatus: "unsupported",
          evidenceType: "inventory-only",
          content: "",
        };
      }

      try {
        let document = this.literature.findDocumentByPath(file.relativePath);
        if (!document) {
          await this.literature.scan();
          document = this.literature.findDocumentByPath(file.relativePath);
        }
        if (!document) throw new Error("The selected PDF is no longer indexed.");
        const requiresFileEvidence = questionRequiresFileEvidence(options.question);
        if (!document.summaryAvailable && !requiresFileEvidence) {
          return {
            name: file.name,
            relativePath: file.relativePath,
            extension,
            analysisStatus: "unprocessed",
            evidenceType: "inventory-only",
            content: "",
          };
        }
        options.onProgress?.({
          stage: "preparing-file",
          relativePath: file.relativePath,
        });
        const cachedWithoutRefresh =
          !requiresFileEvidence && document.summaryAvailable
            ? await this.literature.loadSummary(document.id)
            : null;
        const result = cachedWithoutRefresh
          ? { summary: cachedWithoutRefresh, cached: true }
          : await this.literature.summarize(document.id, {
              force: document.status === "stale",
              includeSourceText: questionNeedsSourceEvidence(options.question),
              signal: options.signal,
              onProgress: (progress) =>
                options.onProgress?.({ ...progress, relativePath: file.relativePath }),
            });
        let content = formatPaperSummary(result.summary, file.relativePath).slice(
          0,
          this.limits.maxSummaryCharactersPerFile
        );
        let evidenceType = result.cached ? "cached-summary" : "generated-summary";
        if (questionNeedsSourceEvidence(options.question)) {
          options.onProgress?.({
            stage: "extracting-detail",
            relativePath: file.relativePath,
          });
          const sourceText =
            result.sourceText ||
            (
              await this.literature.extractText(document.id, {
                signal: options.signal,
              })
            ).text;
          const excerpts = selectRelevantExcerpts(sourceText, options.question, {
            maxCharacters: this.limits.maxSourceCharactersPerFile,
          });
          if (excerpts) {
            content = `${content}\n\nQuestion-specific source evidence:\n${excerpts}`;
            evidenceType = `${evidenceType}+source-excerpts`;
          }
        }
        return {
          name: file.name,
          relativePath: file.relativePath,
          extension,
          analysisStatus: "processed",
          evidenceType,
          content,
        };
      } catch (error) {
        return {
          name: file.name,
          relativePath: file.relativePath,
          extension,
          analysisStatus: "processing-failed",
          evidenceType: "inventory-only",
          content: "",
          error: `Could not process ${file.relativePath}: ${error.message || "Unknown PDF error"}`,
        };
      }
    }
  }

  return {
    CHAT_SCHEMA_VERSION,
    CONTEXT_LIMITS,
    ProjectContextService,
    WorkspaceChatStore,
    boundedMessages,
    fileExtension,
    flattenWorkspaceTree,
    formatPaperSummary,
    normalizeStoredConversation,
    questionNeedsSourceEvidence,
    questionRequiresFileEvidence,
    selectRelevantExcerpts,
  };
});
