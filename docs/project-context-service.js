(function exposeProjectContextService(root, factory) {
  const api = factory(root);
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) Object.assign(root, api);
})(typeof globalThis !== "undefined" ? globalThis : this, function contextFactory(root) {
  "use strict";

  const retrievalLimits = (root?.BioDesignRetrievalContract ||
    (typeof require === "function" ? require("../shared/retrieval-contract.js") : {}))
    .RETRIEVAL_LIMITS || {};
  const retrievalProfiles = root?.BioDesignRetrievalProfiles ||
    (typeof require === "function" ? require("../shared/retrieval-profiles.js") : {});
  const normalizeRetrievalProfile = retrievalProfiles.normalizeRetrievalProfile ||
    ((value) => (["light", "medium", "high"].includes(value) ? value : "light"));
  const qualityModeForProfile = retrievalProfiles.qualityModeForProfile ||
    ((value) => value === "high" ? "high_fidelity" : "balanced");

  const CHAT_SCHEMA_VERSION = 1;
  const CONTEXT_LIMITS = {
    maxInventoryFiles: 500,
    maxProjectSummaries: 20,
    maxEvidenceFiles: 150,
    maxSummaryCharactersPerFile: retrievalLimits.outputTextCharacters || 5000,
    maxSourceCharactersPerFile: retrievalLimits.sourceCharactersPerEvidence || 5000,
    maxTotalEvidenceCharacters: retrievalLimits.totalEvidenceCharacters || 360000,
    maxRetrievalResults: retrievalLimits.resultMaximum || 100,
    maxRetrievalTitleCharacters: retrievalLimits.titleCharacters || 500,
    maxRetrievalSnippetCharacters: retrievalLimits.snippetCharacters || 1200,
    maxEvidenceHandleCharacters: retrievalLimits.evidenceHandleCharacters || 500,
    maxConversationMessages: 40,
    maxConversationMessageCharacters: 120000,
    maxConversationCharacters: 120000,
    maxStoredMessages: 100,
    maxConversationSummaryCharacters: 48000,
    maxActivitySteps: 12,
    maxActivityStepCharacters: 240,
  };

  const DETAIL_QUESTION_PATTERN =
    /\b(exact|concentration|dose|dosage|amount|value|third|second|first|figure|table|supplement|time|duration|temperature|ph|rpm|od\d*|measur(?:e|ed|ement)|assay|protocol|condition|replicate|statistical|significance|mutation|variant|methods?|experimental designs?|designs?|kcat|km|hplc|quote|quotation|equation|formula|detailed conclusion|how many|how much)\b|\b[A-Z]\d{1,5}[A-Z]\b|浓度|剂量|数值|图\s*\d|表\s*\d|时间|温度|转速|测量|实验条件|实验设计|方法|重复|显著性|突变|引用|原文|方程|公式/i;
  const PROJECT_METADATA_QUESTION_PATTERN =
    /\b(what files|which files|files are selected|current selection|workspace contain|project goal|project context|project summary|saved (?:project|literature|experimental) summary|summarize (?:the )?project|what are we trying to achieve)\b|选择了哪些文件|当前选择|工作区.*文件|项目目标|项目背景|项目摘要|已保存的(?:项目|文献|实验)摘要/i;
  const LITERATURE_QUESTION_PATTERN =
    /\b(paper|papers|article|articles|study|studies|literature|publication|authors?|findings?|methods?|limitations?|conclusions?|compare|evidence|reported|according to|summarize|summary)\b|论文|文献|研究|作者|发现|方法|局限|结论|比较|证据|报道|总结|摘要/i;
  const LITERATURE_FOLLOW_UP_PATTERN =
    /\b(it|its|they|their|those|these|former|latter|same paper|that study)\b|它|该论文|这篇|这些论文|它们|前者|后者/i;
  const COLLECTION_LITERATURE_PATTERN =
    /\b(compare|all papers|these papers|those papers|uploaded papers|paper library|literature library|across papers)\b|比较.*论文|所有论文|这些论文|文献库|跨论文/i;
  const SCIENTIFIC_LITERATURE_PATTERN =
    /\b(enzyme|enzymatic|gene|protein|mutation|variant|organism|strain|metabolite|metabolic|pathway|biosynthesis|biocatalyst|catalytic|kinetic|activity|assay|fermentation|bioreactor|yield|titer|productivity|hplc|kcat|km|ectd|ectoine|hydroxyectoine)\b|酶|基因|蛋白|突变|菌株|代谢物|代谢通路|生物合成|催化|动力学|活性|发酵|产率|滴度/i;
  const BIOLOGICAL_IDENTIFIER_PATTERN =
    /\b[A-Z]\d{1,5}[A-Z]\b|\b[a-z]{2,5}[A-Z]\d*\b|\b[A-Z][a-z]{1,4}[A-Z]\d*\b/;
  const GENERIC_DEFINITION_PATTERN =
    /^\s*(?:what (?:does|is|are)|define|explain)\b[\s\S]{0,160}\b(?:mean|in general)?\s*[?.!]*\s*$|^\s*(?:什么是|解释一下|定义)\b/i;
  const BROAD_PAPER_QUESTION_PATTERN =
    /\b(summarize|summary|overview|overall argument|whole paper|entire paper|walk me through|experimental design)\b|总结|摘要|概述|整篇|整体论点|完整实验设计/i;
  const CORPUS_SYNTHESIS_ACTION_PATTERN =
    /\b(?:summari[sz]e|synthesi[sz]e|review|survey|analy[sz]e|compare|write|draft|prepare)\b|\bliterature reviews?\b|\bmajor themes?\b|\boverall (?:findings?|conclusions?|evidence)\b|总结|综述|评述|综合|归纳|主题|主要发现|整体发现|比较|分析内容/i;
  const CORPUS_SCOPE_PATTERN =
    /\b(?:all|every|entire|whole|full)\s+(?:uploaded\s+)?(?:papers?|articles?|studies|literature|library|corpus|collection)\b|\b(?:my|our)\s+(?:uploaded\s+)?(?:papers|articles|studies|literature|library|corpus|collection)\b|\b(?:selected|these|those)\s+(?:papers|articles|studies)\b|\b(?:papers?|articles?|studies|literature)\s+(?:in|from|across|within|of|for|based on)\s+(?:this|the|my|our)?\s*(?:project|folder|workspace|library|corpus|collection)\b|\bacross\s+(?:all|the|my|our)\s+(?:papers?|literature)\b|\boverall (?:findings?|conclusions?|evidence)\s+of\s+(?:the|my|our)\s+literature\b|所有(?:论文|文献)|全部(?:论文|文献)|整个(?:文献库|论文库|文献集合)|全(?:部)?文献库|选中(?:的)?(?:论文|文献)|这些(?:论文|文献)|我.*(?:总共|共有|有多少).*文献/i;
  const CORPUS_REVIEW_PATTERN =
    /\b(?:write|draft|prepare|create|help(?:\s+me)?\s+write)\b[\s\S]{0,80}\bliterature reviews?\b|\bliterature reviews?\b[\s\S]{0,80}\b(?:my|our|all|every|entire|whole|selected|these|those|project|folder|workspace|library|corpus|collection|papers?)\b|(?:写|撰写|做|生成|完成).*综述|综述.*(?:所有|全部|整个|选中|这些|文献库)/i;
  const CORPUS_FAILURE_FOLLOW_UP_PATTERN =
    /\b(?:fail(?:ed|ure)?|incomplete|remaining|missing|left(?:over)?|not analyzed|needed? to (?:reprocess|retry)|reprocess(?:ed|ing)?)\b[\s\S]{0,100}\b(?:papers?|articles?|sources?|maps?|analysis|review|summary)?\b|\b(?:papers?|articles?|sources?|maps?)\b[\s\S]{0,100}\b(?:fail(?:ed|ure)?|incomplete|remaining|missing|not analyzed|reprocess|retry)\b|失败(?:的)?(?:论文|文献|文章)|剩下.{0,12}(?:论文|文献|文章|篇)|未分析(?:的)?(?:论文|文献|文章)|重新处理(?:的)?(?:论文|文献|文章)/i;
  const CORPUS_RECOVERY_ACTION_PATTERN =
    /\b(?:retry|reprocess|reanaly[sz]e|analy[sz]e the remaining|include|add)\b[\s\S]{0,140}\b(?:failed|remaining|missing|left(?:over)?|those|them|two|papers?|articles?|review|summary)\b|\b(?:failed|remaining|missing|left(?:over)?|those|them|two|papers?|articles?)\b[\s\S]{0,140}\b(?:retry|reprocess|reanaly[sz]e|include|add)\b|把.*(?:剩下|失败|未分析).*(?:分析|处理|加入|纳入)|把失败的文章重新处理|重新(?:分析|处理).*(?:论文|文献|文章)/i;
  const CORPUS_UPDATE_PATTERN =
    /\b(?:update|refresh|revise|regenerate)\b[\s\S]{0,120}\b(?:literature|corpus|review|summary|synthesis)\b|\b(?:include|incorporate|consider|take into account|add)\b[\s\S]{0,120}\b(?:new|newly added|recently added|additional|uploaded)\b[\s\S]{0,80}\b(?:papers?|articles?|literature)\b|\b(?:added|uploaded)\b[\s\S]{0,80}\b(?:new|additional|more|several|some)?\s*(?:papers?|articles?)\b[\s\S]{0,120}\b(?:update|include|incorporate|consider|review|summary)\b|(?:新加|新增|又加|刚加|上传).{0,30}(?:论文|文献|文章).{0,50}(?:纳入|加入|考虑|更新|综述|总结)|(?:更新|刷新|修订).{0,20}(?:文献综述|综述|文献总结)|把新(?:加|增|上传).{0,20}(?:论文|文献|文章).{0,30}(?:纳入|加入|考虑)/i;
  const EXPERIMENT_QUESTION_PATTERN =
    /\b(experiment|experimental results?|workbook|spreadsheet|csv|xlsx|measurement|replicate|condition|metric|titer|yield|productivity|activity|assay|strain|internal data|our results?)\b|实验|结果|工作簿|表格|测量|重复|条件|滴度|产率|活性|菌株|内部数据/i;
  const EXPERIMENT_FOLLOW_UP_PATTERN =
    /\b(our data|our results|same experiment|those results|these results|agree|disagree|compare with ours?)\b|我们的数据|我们的结果|这些结果|同一实验|一致|不一致/i;
  const SOURCE_CATALOG_QUESTION_PATTERN =
    /\b(?:list|show|which|what)\b[\s\S]{0,80}\b(?:papers?|experiment (?:files|sources)|workbooks?|source files)\b|列出.*(?:论文|实验文件|来源)|有哪些.*(?:论文|实验文件|来源)/i;
  const EXPLICIT_MEMORY_PATTERN =
    /\b(?:remember|save|record|note)\s+(?:that\s+)?(.{3,2000})$/i;
  const EXPLICIT_MEMORY_ZH_PATTERN =
    /(?:请)?(?:记住|记录|记一下)[：:\s]*(.{2,2000})$/i;
  const MANAGED_WORKER_RECOVERY_PATTERN =
    /\b(?:restart|recover|resume|unstick|stuck|unhealthy)\b[\s\S]{0,100}\b(?:analysis|processing|worker|job|workflow)\b|(?:重启|恢复|继续).{0,30}(?:分析|处理|任务|工作流)/i;
  const NATIVE_PDF_QUESTION_PATTERN =
    /\b(?:whole paper|entire paper|full paper|figure\s*\d+|table\s*\d+|layout|lost the table|parser.*(?:lost|missed)|high[- ]fidelity)\b|整篇|全文总结|图\s*\d+|表\s*\d+|版式|解析.*(?:丢失|遗漏)/i;
  const HIGH_NATIVE_PDF_QUESTION_PATTERN =
    /\b(?:poor extraction|critical verification|verify (?:the )?(?:exact|original))\b|提取质量差|关键核验|核对原文/i;
  const PREVIOUS_SYNTHESIS_PATTERN =
    /\b(?:previous|prior|earlier|last|saved|existing)\b[\s\S]{0,80}\b(?:review|synthesis|summary|analysis)\b|\bwhat did (?:the|our|my)?\s*(?:review|synthesis) conclude\b|之前|以前|上次|已有.{0,12}(?:综述|总结|综合分析)/i;
  const PROJECT_DECISION_PATTERN =
    /\b(?:what did we decide|project decision|current hypothesis|current metric|remembered|saved decision)\b|我们.*决定|项目决定|当前假设|当前指标|记住了什么/i;
  const TOPIC_NAVIGATION_PATTERN =
    /\b(?:topic|theme|strategy|strategies|approach|approaches|area|areas|about)\b|主题|方向|策略|方法类别|哪些领域/i;

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
    "for",
    "is",
    "it",
    "of",
    "paper",
    "papers",
    "pdf",
    "project",
    "study",
    "summarize",
    "summary",
    "the",
    "to",
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

  function detectCorpusWideLiteratureIntent(value) {
    const question = String(value || "").trim();
    if (!question) return false;
    const hasSynthesisAction = CORPUS_SYNTHESIS_ACTION_PATTERN.test(question);
    const hasCorpusScope = CORPUS_SCOPE_PATTERN.test(question);
    const selectedPluralScope = /\b(?:selected|these|those)\s+(?:papers|articles|studies)\b/i.test(question);
    const selectedSynthesis = /\b(?:summari[sz]e|synthesi[sz]e|review|survey|write|draft|prepare)\b|总结|综述|综合|归纳/i.test(question);
    if (selectedPluralScope && !selectedSynthesis && !CORPUS_REVIEW_PATTERN.test(question)) {
      return false;
    }
    return Boolean(
      CORPUS_REVIEW_PATTERN.test(question) ||
      (hasSynthesisAction && hasCorpusScope)
    );
  }

  function detectCorpusFailureFollowUpIntent(value) {
    return CORPUS_FAILURE_FOLLOW_UP_PATTERN.test(String(value || ""));
  }

  function detectCorpusRecoveryIntent(value) {
    const question = String(value || "");
    return CORPUS_RECOVERY_ACTION_PATTERN.test(question) &&
      (CORPUS_FAILURE_FOLLOW_UP_PATTERN.test(question) ||
        /\b(?:those|them|the two)\b|把.*(?:两篇|它们)/i.test(question));
  }

  function detectCorpusUpdateIntent(value) {
    const question = String(value || "");
    return CORPUS_UPDATE_PATTERN.test(question) &&
      !detectCorpusFailureFollowUpIntent(question);
  }

  function extractExplicitMemory(value) {
    const question = String(value || "").trim();
    const match = question.match(EXPLICIT_MEMORY_PATTERN) ||
      question.match(EXPLICIT_MEMORY_ZH_PATTERN);
    if (!match?.[1]) return null;
    const text = match[1].replace(/\s+/g, " ").trim().slice(0, 2000);
    if (!text) return null;
    return {
      kind: /metric|assay|titer|yield|productivity|指标|滴度|产率/i.test(text)
        ? "metric"
        : /hypothesis|we think|可能|假设/i.test(text)
          ? "hypothesis"
          : /constraint|must|cannot|限制|必须|不能/i.test(text)
            ? "constraint"
            : "observation",
      text,
    };
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
    const list = (value) =>
      Array.isArray(value) && value.length
        ? value.map((item) => `- ${item}`).join("\n")
        : "";
    const methods = Array.isArray(summary.methods)
      ? summary.methods.join("; ")
      : summary.methods;
    const lines = [
      `Cached Paper Card for ${relativePath} (routing summary; source paper remains authoritative):`,
      summary.title ? `Title: ${summary.title}` : "",
      Array.isArray(summary.authors) && summary.authors.length
        ? `Authors: ${summary.authors.join(", ")}`
        : "",
      summary.year ? `Year: ${summary.year}` : "",
      summary.shortSummary || summary.summary
        ? `Short summary: ${summary.shortSummary || summary.summary}`
        : "",
      summary.abstractSummary ? `Abstract summary: ${summary.abstractSummary}` : "",
      summary.researchQuestion ? `Research question: ${summary.researchQuestion}` : "",
      methods || summary.methodsSummary
        ? `Methods: ${methods || summary.methodsSummary}`
        : "",
      list(summary.mainFindings || summary.keyResults)
        ? `Main findings:\n${list(summary.mainFindings || summary.keyResults)}`
        : "",
      list(summary.importantResults)
        ? `Important results:\n${list(summary.importantResults)}`
        : "",
      list(summary.limitations)
        ? `Limitations:\n${list(summary.limitations)}`
        : "",
      summary.mainConclusion ? `Main conclusion: ${summary.mainConclusion}` : "",
    ];
    return lines.filter(Boolean).join("\n");
  }

  function questionNeedsSourceEvidence(question) {
    return DETAIL_QUESTION_PATTERN.test(String(question || ""));
  }

  function questionMayNeedLiterature(question) {
    const value = String(question || "");
    if (PROJECT_METADATA_QUESTION_PATTERN.test(value)) return false;
    if (
      GENERIC_DEFINITION_PATTERN.test(value) &&
      !LITERATURE_QUESTION_PATTERN.test(value)
    ) {
      return false;
    }
    return Boolean(
      LITERATURE_QUESTION_PATTERN.test(value) ||
        SCIENTIFIC_LITERATURE_PATTERN.test(value) ||
        BIOLOGICAL_IDENTIFIER_PATTERN.test(value)
    );
  }

  function questionRequiresFileEvidence(question) {
    const value = String(question || "").trim();
    return Boolean(value && !PROJECT_METADATA_QUESTION_PATTERN.test(value));
  }

  function tokenizeQuestion(question) {
    return [...new Set(
      String(question || "")
        .toLowerCase()
        .match(/[a-z0-9][a-z0-9-]{1,}|[\u3400-\u9fff]{2,}/g) || []
    )].filter((token) => !STOP_WORDS.has(token));
  }

  function cardSearchSections(card) {
    const join = (value) =>
      Array.isArray(value) ? value.join(" ") : String(value || "");
    return [
      { weight: 10, text: join([card.title, card.fileName]) },
      {
        weight: 9,
        text: [
          card.organisms,
          card.genes,
          card.proteins,
          card.pathways,
          card.metabolites,
        ].map(join).join(" "),
      },
      { weight: 8, text: [card.keywords, card.topics].map(join).join(" ") },
      {
        weight: 5,
        text: [
          card.researchQuestion,
          card.mainFindings,
          card.methods,
          card.methodsSummary,
          card.experimentalConditions,
          card.measurements,
          card.importantResults,
          card.mainConclusion,
        ].map(join).join(" "),
      },
      {
        weight: 3,
        text: [card.shortSummary, card.abstractSummary, card.summary, card.limitations]
          .map(join)
          .join(" "),
      },
    ];
  }

  function rankPaperCards(cards, query, options = {}) {
    const terms = tokenizeQuestion(query);
    const topK = Math.max(1, Number(options.topK) || 5);
    const collectionLiteratureQuestion = COLLECTION_LITERATURE_PATTERN.test(
      String(query || "")
    );
    const ranked = (Array.isArray(cards) ? cards : []).map(({ document, card }) => {
      let score = 0;
      let matchedTerms = 0;
      const sections = cardSearchSections(card).map((section) => ({
        ...section,
        text: section.text.toLowerCase(),
      }));
      for (const term of terms) {
        let termScore = 0;
        for (const section of sections) {
          if (section.text.includes(term)) termScore = Math.max(termScore, section.weight);
        }
        if (termScore > 0) {
          matchedTerms += 1;
          score += termScore;
        }
      }
      if (terms.length && matchedTerms === terms.length) score += 5;
      return { paperId: document.id, document, card, score, matchedTerms };
    });
    ranked.sort(
      (left, right) =>
        right.score - left.score ||
        String(left.document.filename).localeCompare(String(right.document.filename))
    );
    if (collectionLiteratureQuestion && ranked.length && ranked[0].score === 0) {
      return ranked.slice(0, topK);
    }
    const minimumScore = Number(options.minimumScore) || 5;
    return ranked.filter((item) => item.score >= minimumScore).slice(0, topK);
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

  function selectBroadPaperCoverage(text, options = {}) {
    const maxCharacters = Number(options.maxCharacters) || 6500;
    const maxExcerpts = Math.max(1, Number(options.maxExcerpts) || 4);
    const windows = makeTextWindows(text);
    if (!windows.length) return "";
    const selectedIndexes = [...new Set(
      Array.from({ length: Math.min(maxExcerpts, windows.length) }, (_, index) =>
        Math.round((index * (windows.length - 1)) / Math.max(1, maxExcerpts - 1))
      )
    )];
    let remaining = maxCharacters;
    return selectedIndexes
      .map((windowIndex, index) => {
        const value = windows[windowIndex].text.slice(0, remaining);
        remaining -= value.length;
        return value ? `[Broad source excerpt ${index + 1}]\n${value}` : "";
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

  function prepareLatestSideChatRevision(messages, messageId, nextContent) {
    const history = Array.isArray(messages) ? messages : [];
    const question = typeof nextContent === "string" ? nextContent.trim() : "";
    if (!question || typeof messageId !== "string" || !messageId) return null;
    let latestUserIndex = -1;
    for (let index = history.length - 1; index >= 0; index -= 1) {
      if (history[index]?.role === "user") {
        latestUserIndex = index;
        break;
      }
    }
    if (latestUserIndex < 0 || history[latestUserIndex]?.id !== messageId) return null;
    return {
      question,
      replacedMessageId: messageId,
      previousMessages: history.slice(0, latestUserIndex),
    };
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
        content: message.content.trim(),
        ...(message.role === "assistant" && Array.isArray(message.activity)
          ? {
              activity: message.activity
                .filter((step) => typeof step === "string" && step.trim())
                .map((step) => step.trim().slice(0, limits.maxActivityStepCharacters))
                .slice(-limits.maxActivitySteps),
            }
          : {}),
        ...(message.role === "user" && isPlainObject(message.context)
          ? {
              context: {
                type: message.context.type === "files" ? "files" : "project",
                files: [...new Set(
                  (Array.isArray(message.context.files) ? message.context.files : [])
                    .map(normalizePath)
                    .filter(Boolean)
                )].slice(0, limits.maxInventoryFiles),
                selectedPaperIds: [...new Set(
                  (Array.isArray(message.context.selectedPaperIds)
                    ? message.context.selectedPaperIds
                    : [])
                    .filter((paperId) => typeof paperId === "string" && paperId)
                )].slice(0, limits.maxEvidenceFiles),
                relevantPaperIds: [...new Set(
                  (Array.isArray(message.context.relevantPaperIds)
                    ? message.context.relevantPaperIds
                    : [])
                    .filter((paperId) => typeof paperId === "string" && paperId)
                )].slice(0, limits.maxEvidenceFiles),
                selectedExperimentIds: [...new Set(
                  (Array.isArray(message.context.selectedExperimentIds)
                    ? message.context.selectedExperimentIds
                    : [])
                    .filter((sourceId) => typeof sourceId === "string" && sourceId)
                )].slice(0, limits.maxEvidenceFiles),
                relevantExperimentIds: [...new Set(
                  (Array.isArray(message.context.relevantExperimentIds)
                    ? message.context.relevantExperimentIds
                    : [])
                    .filter((sourceId) => typeof sourceId === "string" && sourceId)
                )].slice(0, limits.maxEvidenceFiles),
                corpusWorkflowId:
                  typeof message.context.corpusWorkflowId === "string"
                    ? message.context.corpusWorkflowId.trim().slice(0, 200)
                    : "",
                ...(isPlainObject(message.context.retrieval)
                  ? {
                      retrieval: {
                        profile: normalizeRetrievalProfile(
                          message.context.retrieval.profile
                        ),
                        mode: ["fast", "deep", "not-needed"].includes(
                          message.context.retrieval.mode
                        )
                          ? message.context.retrieval.mode
                          : "not-needed",
                        ...(["fast", "deep"].includes(
                          message.context.retrieval.attemptedMode
                        )
                          ? { attemptedMode: message.context.retrieval.attemptedMode }
                          : {}),
                        escalated: message.context.retrieval.escalated === true,
                        reason: String(
                          message.context.retrieval.reason ||
                            "retrieval-path-unavailable"
                        ).slice(0, 80),
                      },
                    }
                  : {}),
              },
            }
          : {}),
        createdAt: message.createdAt,
      }));
    const messages = candidates.slice(-limits.maxStoredMessages);
    return {
      schemaVersion: CHAT_SCHEMA_VERSION,
      id: String(conversation.id || ""),
      title: String(conversation.title || "Side Chat").slice(0, 120),
      createdAt: String(conversation.createdAt || ""),
      updatedAt: String(conversation.updatedAt || ""),
      summary: String(conversation.summary || "").slice(
        0,
        limits.maxConversationSummaryCharacters
      ),
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
      this.sourceSystem = options.sourceSystem || options.literature?.sourceSystem || null;
      this.sourceRegistry = this.sourceSystem?.registry || null;
      this.literatureTools = this.sourceSystem?.literatureTools || null;
      this.experimentTools = this.sourceSystem?.experimentTools || null;
      this.corpusWorkflows = this.sourceSystem?.corpusWorkflows || null;
      this.projectState = this.sourceSystem?.projectState || null;
      this.managedWorker = this.sourceSystem?.managedWorker || null;
      this.nativePdfAnalyzer = this.sourceSystem?.nativePdfAnalyzer || null;
      this.knowledgeService = this.sourceSystem?.knowledgeService || null;
      this.limits = { ...CONTEXT_LIMITS, ...(options.limits || {}) };
    }

    compactKnowledgeHits(payload, kind) {
      return (payload?.results || []).slice(0, 8).map((result) => ({
        kind,
        sourceId: String(result.sourceId || result.paperId || "").slice(0, 200),
        paperId: String(result.paperId || "").slice(0, 200) || null,
        title: String(result.title || "").slice(0, this.limits.maxRetrievalTitleCharacters),
        score: Number(result.score) || 0,
        snippet: String(
          result.snippet || result.matchedSections?.[0]?.snippet || ""
        ).slice(0, this.limits.maxRetrievalSnippetCharacters),
        qmdDoc: String(
          result.file || result.matchedSections?.[0]?.qmdDoc || ""
        ).slice(0, this.limits.maxEvidenceHandleCharacters),
      }));
    }

    async retrieveLayeredKnowledge(question, options = {}) {
      if (!this.knowledgeService?.available) return { available: false, hits: [] };
      const hits = [];
      const run = async (kind, callback) => {
        try {
          hits.push(...this.compactKnowledgeHits(await callback(), kind));
        } catch (error) {
          console.info("layered_knowledge_search_fallback", {
            kind,
            code: error?.code || error?.name || "QMD_SEARCH_FAILED",
            message: String(error?.message || error).slice(0, 300),
          });
        }
      };
      if (PREVIOUS_SYNTHESIS_PATTERN.test(question)) {
        await run("synthesis", () => this.knowledgeService.searchPreviousSyntheses({
          query: question,
          mode: "fast",
          limit: 5,
          signal: options.signal,
        }));
      }
      if (PROJECT_METADATA_QUESTION_PATTERN.test(question) || PROJECT_DECISION_PATTERN.test(question)) {
        await run("project-memory", () => this.knowledgeService.searchProjectMemory({
          query: question,
          mode: "fast",
          limit: 8,
          signal: options.signal,
        }));
      }
      if (TOPIC_NAVIGATION_PATTERN.test(question) && questionMayNeedLiterature(question)) {
        await run("topic", () => this.knowledgeService.searchTopics({
          query: question,
          mode: "fast",
          limit: 8,
          signal: options.signal,
        }));
      }
      if (EXPERIMENT_QUESTION_PATTERN.test(question)) {
        await run("experiment-note", () => this.knowledgeService.searchExperimentSources({
          query: question,
          mode: "fast",
          limit: 8,
          signal: options.signal,
        }));
      }
      return {
        available: true,
        hits: hits.slice(0, 20),
      };
    }

    buildConversationContext(conversation) {
      const recentlyDiscussedPaperIds = [];
      const recentlyDiscussedExperimentIds = [];
      const recentCorpusWorkflowIds = [];
      for (const message of [...(conversation?.messages || [])].reverse()) {
        const workflowId = String(message?.context?.corpusWorkflowId || "").trim();
        if (workflowId && !recentCorpusWorkflowIds.includes(workflowId)) {
          recentCorpusWorkflowIds.push(workflowId);
        }
        const ids = [
          ...(message?.context?.relevantPaperIds || []),
          ...(message?.context?.selectedPaperIds || []),
        ];
        for (const paperId of ids) {
          if (
            typeof paperId === "string" &&
            paperId &&
            !recentlyDiscussedPaperIds.includes(paperId)
          ) {
            recentlyDiscussedPaperIds.push(paperId);
          }
          if (recentlyDiscussedPaperIds.length >= this.limits.maxEvidenceFiles) break;
        }
        for (const sourceId of [
          ...(message?.context?.relevantExperimentIds || []),
          ...(message?.context?.selectedExperimentIds || []),
        ]) {
          if (
            typeof sourceId === "string" &&
            sourceId &&
            !recentlyDiscussedExperimentIds.includes(sourceId)
          ) recentlyDiscussedExperimentIds.push(sourceId);
          if (recentlyDiscussedExperimentIds.length >= this.limits.maxEvidenceFiles) break;
        }
        if (recentlyDiscussedPaperIds.length >= this.limits.maxEvidenceFiles) break;
      }
      return {
        summary: String(
          conversation?.summary || this.workspace.state?.memory?.conversationSummary || ""
        ).slice(0, this.limits.maxConversationSummaryCharacters),
        recentMessages: boundedMessages(conversation?.messages, this.limits),
        recentlyDiscussedPaperIds,
        recentlyDiscussedExperimentIds,
        recentCorpusWorkflowIds,
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
          const source = this.sourceRegistry?.getByPath(entry.relativePath);
          const extension = fileExtension(entry.name);
          return {
            paperId: document?.id || null,
            sourceId: source?.sourceId || document?.id || null,
            sourceKind: source?.sourceKind || null,
            name: entry.name,
            relativePath: entry.relativePath,
            extension,
            size: Number(entry.size) || 0,
            lastModified: Number(entry.lastModified) || 0,
            processor:
              extension === "pdf"
                ? "pdf"
                : source?.sourceKind === "experiment"
                  ? "experiment"
                  : null,
            summaryAvailable: Boolean(document?.summaryAvailable),
            summaryStatus: document?.status || "unprocessed",
            paperCardStatus: document?.paperCardStatus || "unprocessed",
            parseStatus: source?.parseStatus || "not_started",
            indexStatus: source?.indexStatus || "not_started",
            qmdLexStatus: source?.qmdLexStatus || "not_started",
            qmdVectorStatus: source?.qmdVectorStatus || "not_started",
            structuredDataStatus: source?.structuredDataStatus || "not_applicable",
          };
        });
    }

    buildLiteratureIndex(priorityPaperIds = []) {
      const priority = new Map(
        [...new Set(priorityPaperIds)].map((paperId, index) => [paperId, index])
      );
      return (this.literature?.documents || [])
        .filter((document) => document.isLiteraturePaper)
        .sort((left, right) => {
          const leftPriority = priority.has(left.id)
            ? priority.get(left.id)
            : Number.MAX_SAFE_INTEGER;
          const rightPriority = priority.has(right.id)
            ? priority.get(right.id)
            : Number.MAX_SAFE_INTEGER;
          return (
            leftPriority - rightPriority ||
            String(left.filename).localeCompare(String(right.filename))
          );
        })
        .slice(0, 100)
        .map((document) => {
          const discovery = document.discovery || {};
          return {
            paperId: document.id,
            fileName: discovery.fileName || document.filename,
            title: discovery.title || null,
            authors: Array.isArray(discovery.authors) ? discovery.authors : [],
            year: Number.isInteger(discovery.year) ? discovery.year : null,
            topics: Array.isArray(discovery.topics) ? discovery.topics : [],
            keywords: Array.isArray(discovery.keywords) ? discovery.keywords : [],
            identifiers: Array.isArray(discovery.identifiers)
              ? discovery.identifiers
              : [],
            shortDescription: String(discovery.shortDescription || "").slice(
              0,
              1600
            ),
            status: document.paperCardStatus || "pending",
            paperCardAvailable: document.paperCardStatus === "ready",
          };
        });
    }

    buildMemoryDescriptions() {
      const memory = this.workspace.state?.memory || {};
      const entries = [
        ["project_summary", "Saved project summary", memory.projectSummary],
        ["literature_summary", "Saved literature summary", memory.literatureSummary],
        ["experimental_summary", "Saved experimental summary", memory.experimentalSummary],
      ];
      const legacy = entries
        .filter(([, , value]) => typeof value === "string" && value.trim())
        .map(([id, label, value]) => ({
          id,
          description: `${label}: ${value.trim().slice(0, 320)}`,
        }));
      const records = (Array.isArray(memory.records) ? memory.records : [])
        .filter((record) => record?.status === "active" && record.text)
        .slice(-100)
        .map((record) => ({
          id: String(record.memoryId || ""),
          description: `${String(record.kind || "observation")}: ${String(
            record.text
          ).slice(0, 320)}`,
        }));
      return [...legacy, ...records].slice(-112);
    }

    localRoutingDecision({
      question,
      selectedPaperIds,
      recentPaperIds,
      matches,
      memoryDescriptions,
    }) {
      const followUp = Boolean(
        recentPaperIds.length && LITERATURE_FOLLOW_UP_PATTERN.test(question)
      );
      const genericDefinition = Boolean(
        GENERIC_DEFINITION_PATTERN.test(question) &&
          !LITERATURE_QUESTION_PATTERN.test(question)
      );
      const useLiterature = genericDefinition
        ? false
        : Boolean(
            questionMayNeedLiterature(question) ||
              followUp ||
              questionNeedsSourceEvidence(question) ||
              matches.length
          );
      const memoryIds = PROJECT_METADATA_QUESTION_PATTERN.test(question)
        ? memoryDescriptions.map((item) => item.id)
        : [];
      return {
        useLiterature,
        paperIds: useLiterature
          ? selectedPaperIds.length
            ? selectedPaperIds
            : followUp
              ? recentPaperIds
              : matches.map((match) => match.paperId)
          : [],
        useProjectMemory: memoryIds.length > 0,
        memoryIds,
        reason: "Local bounded routing fallback was used.",
        mode: "local",
      };
    }

    async decideContextRouting(input, options = {}) {
      const fallback = this.localRoutingDecision(input);
      if (
        options.enableContextRouter !== true ||
        typeof this.literature?.api?.routeContext !== "function"
      ) {
        return fallback;
      }
      try {
        const routed = await this.literature.api.routeContext(
          {
            userQuery: input.question,
            selectedPaperIds: input.selectedPaperIds,
            recentlyReferencedPaperIds: input.recentPaperIds,
            literatureIndex: input.literatureIndex,
            availableMemoryDescriptions: input.memoryDescriptions,
          },
          options.signal
        );
        const availablePaperIds = new Set(
          input.literatureIndex.map((item) => item.paperId)
        );
        const availableMemoryIds = new Set(
          input.memoryDescriptions.map((item) => item.id)
        );
        const useLiterature = routed?.useLiterature === true;
        const paperIds = useLiterature
          ? input.selectedPaperIds.length
            ? input.selectedPaperIds
            : [...new Set(
                (Array.isArray(routed?.paperIds) ? routed.paperIds : []).filter(
                  (paperId) => availablePaperIds.has(paperId)
                )
              )].slice(0, this.limits.maxEvidenceFiles)
          : [];
        const memoryIds = routed?.useProjectMemory === true
          ? [...new Set(
              (Array.isArray(routed?.memoryIds) ? routed.memoryIds : []).filter(
                (memoryId) => availableMemoryIds.has(memoryId)
              )
            )]
          : [];
        return {
          useLiterature,
          paperIds,
          useProjectMemory: memoryIds.length > 0,
          memoryIds,
          reason: String(routed?.reason || "Context router decision.").slice(0, 500),
          mode: "llm",
        };
      } catch {
        return { ...fallback, mode: "local-fallback" };
      }
    }

    async buildContext(options) {
      const retrievalProfile = normalizeRetrievalProfile(options?.retrievalProfile);
      options = {
        ...options,
        retrievalProfile,
        qualityMode: qualityModeForProfile(retrievalProfile),
        // This authenticated router is a High-only policy. Callers and remote
        // tool output cannot enable it independently of the persisted setting.
        enableContextRouter: retrievalProfile === "high",
      };
      const selectedPaths = [...new Set(
        (Array.isArray(options.selectedPaths) ? options.selectedPaths : [])
          .map(normalizePath)
          .filter(Boolean)
      )];
      const entriesByPath = new Map(
        flattenWorkspaceTree(options.workspaceTree).map((entry) => [
          entry.relativePath,
          entry,
        ])
      );
      const selectedFiles = selectedPaths
        .map((path) => entriesByPath.get(path))
        .filter((entry) => entry?.type === "file");
      const selectedPaperIds = this.getSelectedPaperIds(
        selectedPaths,
        options.selectedPaperIds
      );
      const selectedPaperIdSet = new Set(selectedPaperIds);
      const selectedPaperPaths = new Set(
        (this.literature?.documents || [])
          .filter((document) => selectedPaperIdSet.has(document.id))
          .map((document) => document.relativePath)
      );
      const selectedNonPaperFiles = selectedFiles.filter(
        (file) => !selectedPaperPaths.has(file.relativePath)
      );
      const question = String(options.question || "");
      const surface = options.surface === "agent_command" ? "agent_command" : "side_chat";
      options = { ...options, surface };
      const internalStateUpdates = [];
      let managedWorkerRecovery = null;
      if (this.managedWorker && MANAGED_WORKER_RECOVERY_PATTERN.test(question)) {
        const workerStatus = await this.managedWorker.getStatus({ surface });
        if (workerStatus.health === "unhealthy") {
          options.onProgress?.({ stage: "recovering-worker", completed: 0, total: 1 });
          managedWorkerRecovery = await this.managedWorker.restart({
            ...options,
            surface,
          });
          internalStateUpdates.push("managed-worker-restarted");
          options.onProgress?.({ stage: "recovering-worker", completed: 1, total: 1 });
        }
      }
      const corpusWideLiteratureRequest = detectCorpusWideLiteratureIntent(question);
      const corpusFailureFollowUpRequest = detectCorpusFailureFollowUpIntent(question);
      const corpusRecoveryRequest = detectCorpusRecoveryIntent(question);
      const corpusUpdateRequest = detectCorpusUpdateIntent(question);
      const paperQuestion = corpusWideLiteratureRequest ||
        corpusFailureFollowUpRequest ||
        corpusUpdateRequest ||
        questionMayNeedLiterature(question);
      const eligiblePaperIds = (this.literature?.documents || [])
        .filter((document) => document.isLiteraturePaper)
        .map((document) => document.id);
      const selectedExperimentIds = selectedPaths
        .map((path) => this.sourceRegistry?.getByPath(path))
        .filter((source) => source?.sourceKind === "experiment")
        .map((source) => source.sourceId);

      const conversationContext = this.buildConversationContext(options.conversation);
      let corpusWorkflowStatus = null;
      let corpusRecoveryResult = null;
      let corpusUpdateResult = null;
      let latestCorpusWorkflowStatus = null;
      let corpusWorkflowLookupError = null;
      if ((corpusFailureFollowUpRequest || corpusUpdateRequest) && this.corpusWorkflows) {
        try {
          const referencedWorkflowId = conversationContext.recentCorpusWorkflowIds[0] || "";
          corpusWorkflowStatus = await this.corpusWorkflows.getWorkflowStatus(
            referencedWorkflowId
          );
          if (corpusUpdateRequest) {
            corpusUpdateResult = await this.corpusWorkflows.updateCorpusSynthesis(
              corpusWorkflowStatus.workflowId,
              {
                ...options,
                corpusScope: selectedPaperIds.length ? "selected" : "entire-project",
                ...(selectedPaperIds.length ? { paperIds: selectedPaperIds } : {}),
                updateRequest: question,
              }
            );
            corpusWorkflowStatus = corpusUpdateResult.status;
            internalStateUpdates.push(
              corpusUpdateResult.reusedExistingSynthesis
                ? "corpus-synthesis-reused"
                : `corpus-synthesis-updated:${corpusWorkflowStatus.workflowId}`
            );
          } else if (corpusRecoveryRequest && corpusWorkflowStatus.retryablePaperIds.length) {
            corpusRecoveryResult = await this.corpusWorkflows.retryFailedMaps(
              corpusWorkflowStatus.workflowId,
              options
            );
            corpusWorkflowStatus = corpusRecoveryResult.status;
          }
        } catch (error) {
          if (error?.code === "OPERATION_ABORTED") throw error;
          corpusWorkflowLookupError = error;
          if (error?.code !== "CORPUS_WORKFLOW_NOT_FOUND") {
            console.warn("corpus_workflow_status_lookup_failed", {
              code: error?.code || error?.name || "WORKFLOW_STATUS_FAILED",
              message: String(error?.message || error).slice(0, 500),
            });
          }
        }
      }
      if (!corpusWorkflowStatus && this.corpusWorkflows) {
        try {
          latestCorpusWorkflowStatus = await this.corpusWorkflows.getWorkflowStatus("");
        } catch (error) {
          if (error?.code !== "CORPUS_WORKFLOW_NOT_FOUND") throw error;
        }
      } else {
        latestCorpusWorkflowStatus = corpusWorkflowStatus;
      }
      const corpusWorkflowFollowUp = Boolean(
        corpusWorkflowStatus &&
        (corpusFailureFollowUpRequest || corpusUpdateRequest)
      );
      const recentIds = conversationContext.recentlyDiscussedPaperIds.filter(
        (paperId) =>
          this.literature?.documents?.some(
            (document) => document.id === paperId
          )
      );
      const followUpNeedsLiterature = Boolean(
        recentIds.length && LITERATURE_FOLLOW_UP_PATTERN.test(question)
      );
      const recentExperimentIds = conversationContext.recentlyDiscussedExperimentIds.filter(
        (sourceId) => Boolean(this.sourceRegistry?.get(sourceId))
      );
      const experimentQuestion = EXPERIMENT_QUESTION_PATTERN.test(question);
      const followUpNeedsExperiments = Boolean(
        recentExperimentIds.length && EXPERIMENT_FOLLOW_UP_PATTERN.test(question)
      );
      const memoryDescriptions = this.buildMemoryDescriptions();
      const shouldSearchLiterature = paperQuestion || followUpNeedsLiterature;
      let matches = shouldSearchLiterature &&
        !corpusWideLiteratureRequest &&
        !corpusUpdateRequest &&
        !corpusWorkflowFollowUp
          ? await this.matchPapers(question, {
            topK: Math.min(5, this.limits.maxEvidenceFiles),
            readyOnly: false,
            retrievalProfile,
            signal: options.signal,
            ...(selectedPaperIds.length
              ? { candidatePaperIds: selectedPaperIds }
              : {}),
          })
        : [];
      const literatureIndex = this.buildLiteratureIndex([
        ...selectedPaperIds,
        ...recentIds,
        ...matches.map((match) => match.paperId),
      ]);
      const routing = corpusWorkflowFollowUp
        ? {
            useLiterature: true,
            paperIds: [...(corpusWorkflowStatus.coverage?.includedPaperIds || [])],
            useProjectMemory: false,
            memoryIds: [],
            reason: corpusUpdateRequest
              ? "Deterministically diff the previous corpus snapshot against the current source registry and update the synthesis."
              : corpusRecoveryRequest
                ? "Retry failed maps in the referenced corpus workflow and revise its synthesis."
                : "Inspect exact failure diagnostics for the referenced corpus workflow.",
            mode: corpusUpdateRequest
              ? "corpus-update"
              : corpusRecoveryRequest
                ? "corpus-recovery"
                : "corpus-status",
          }
        : corpusWideLiteratureRequest || corpusUpdateRequest
        ? {
            useLiterature: true,
            paperIds: selectedPaperIds.length
              ? [...selectedPaperIds]
              : [...eligiblePaperIds],
            useProjectMemory: false,
            memoryIds: [],
            reason: corpusUpdateRequest
              ? "No compatible prior workflow was available; use the current registry as corpus scope without semantic source discovery."
              : "Explicit corpus-wide literature synthesis request.",
            mode: "corpus-intent",
          }
        : await this.decideContextRouting(
            {
              question,
              selectedPaperIds,
              recentPaperIds: recentIds,
              matches,
              literatureIndex,
              memoryDescriptions,
            },
            options
          );

      let relevantPaperIds = [];
      let discoveryMode = "not-needed";
      if (corpusWorkflowFollowUp) {
        relevantPaperIds = [...(corpusWorkflowStatus.coverage?.includedPaperIds || [])];
        discoveryMode = corpusUpdateRequest
          ? "corpus-update"
          : corpusRecoveryRequest
            ? "corpus-recovery"
            : "corpus-status";
      } else if (corpusWideLiteratureRequest || corpusUpdateRequest) {
        relevantPaperIds = selectedPaperIds.length
          ? [...selectedPaperIds]
          : [...eligiblePaperIds];
        discoveryMode = "corpus";
      } else if (routing.useLiterature) {
        if (selectedPaperIds.length) {
          relevantPaperIds = [...selectedPaperIds];
          discoveryMode = "selected";
        } else {
          let routedPaperIds = routing.paperIds;
          if (!routedPaperIds.length && followUpNeedsLiterature) {
            routedPaperIds = recentIds;
          }
          if (!routedPaperIds.length) {
            routedPaperIds = matches.map((match) => match.paperId);
          }
          const activeIds = new Set(
            this.literature.documents.map((document) => document.id)
          );
          relevantPaperIds = routedPaperIds.filter((paperId) => activeIds.has(paperId));
          if (!relevantPaperIds.length && !routedPaperIds.length) {
            matches = await this.matchPapers(question, {
              topK: Math.min(5, this.limits.maxEvidenceFiles),
              retrievalProfile,
              signal: options.signal,
            });
            relevantPaperIds = matches.map((match) => match.paperId);
          }
          if (!relevantPaperIds.length && followUpNeedsLiterature) {
            relevantPaperIds = recentIds.filter((paperId) => activeIds.has(paperId));
          }
          discoveryMode = relevantPaperIds.length
            ? followUpNeedsLiterature &&
              relevantPaperIds.every((paperId) => recentIds.includes(paperId))
              ? "conversation-follow-up"
              : "automatic"
            : "not-ready";
        }
      }

      const context = this.baseContext(
        options,
        selectedPaths.length ? "files" : "project",
        selectedFiles,
        routing
      );
      context.routing = routing;
      context.knowledge = corpusWideLiteratureRequest || corpusUpdateRequest
        ? { available: this.knowledgeService?.available === true, hits: [] }
        : await this.retrieveLayeredKnowledge(question, options);
      const sourceCounts = this.sourceRegistry?.counts?.() || {};
      const paperSources = this.sourceRegistry?.list({ sourceKind: "paper" }) || [];
      context.literature = {
        retrievalProfile,
        retrievalDecision: matches.retrievalDecision || {
          profile: retrievalProfile,
          mode: "not-needed",
          escalated: false,
          reason: "literature-retrieval-not-needed",
        },
        selectedPaperIds,
        relevantPaperIds,
        discoveryMode,
        corpusWideRequest:
          corpusWideLiteratureRequest || corpusUpdateRequest || corpusWorkflowFollowUp,
        corpusScope: corpusWorkflowFollowUp
          ? corpusWorkflowStatus.corpusScope || "entire-project"
          : corpusWideLiteratureRequest || corpusUpdateRequest
          ? selectedPaperIds.length
            ? "selected"
            : "entire-project"
          : null,
        corpusWorkflowId: corpusWorkflowStatus?.workflowId || null,
        corpusFollowUp: corpusWorkflowFollowUp,
        corpusUpdateRequested: corpusUpdateRequest && corpusWorkflowFollowUp,
        corpusRecoveryRequested: corpusRecoveryRequest && corpusWorkflowFollowUp,
        workflowFailures: (corpusWorkflowStatus?.failures || []).map((failure) => ({
          paperId: failure.paperId,
          filename: failure.filename,
          stage: failure.stage,
          code: failure.code,
          sourceReady: failure.sourceReady,
          retryable: failure.retryable,
        })),
        retrievalRequired: relevantPaperIds.length > 0,
        coverage: corpusWorkflowFollowUp
          ? { ...corpusWorkflowStatus.coverage }
          : {
          papersDiscovered: paperSources.length,
          papersSearchable: paperSources.filter((source) => source.indexStatus === "ready").length,
          papersExcludedOrFailed: paperSources.filter(
            (source) => source.parseStatus === "failed" || source.indexStatus === "failed"
          ).map((source) => source.sourceId),
          papersActuallyConsidered: [...relevantPaperIds],
        },
      };
      if (latestCorpusWorkflowStatus) {
        context.corpusWorkflowStatus = latestCorpusWorkflowStatus;
      }
      context.experiments = {
        selectedExperimentIds,
        relevantExperimentIds: [],
      };
      context.sourceMap = {
        projectGoalAvailable: Boolean(context.project.goal),
        selectedPaperIds,
        selectedExperimentIds,
        activePaperIds: relevantPaperIds,
        activeExperimentIds: [],
        sourceCounts,
        paperSources: paperSources.map((source) => ({
          sourceId: source.sourceId,
          sourceKind: "paper",
          path: source.path,
          displayName: source.displayName,
          extension: source.extension,
          sizeBytes: Number(source.sizeBytes) || 0,
          mtimeNs: Number(source.mtimeNs) || 0,
          contentHash: source.contentHash || null,
          catalogStatus: source.catalogStatus,
          parseStatus: source.parseStatus,
          indexStatus: source.indexStatus,
          qmdLexStatus: source.qmdLexStatus || "not_started",
          qmdVectorStatus: source.qmdVectorStatus || "not_started",
          paperCardStatus: source.paperCardStatus,
        })),
        availableSourceTools: Boolean(this.sourceSystem),
      };

      let paperEvidence = [];
      if (corpusUpdateResult?.workflow || corpusRecoveryResult?.workflow) {
        const workflow = corpusUpdateResult?.workflow || corpusRecoveryResult.workflow;
        const workflowValue = workflow.resultHandle
          ? await this.sourceSystem.results.read(workflow.resultHandle)
          : workflow;
        if (workflowValue?.coverage) {
          context.literature.coverage = {
            ...context.literature.coverage,
            ...workflowValue.coverage,
            papersActuallyConsidered: [...relevantPaperIds],
          };
        }
        paperEvidence = [
          {
            name: "summarize-paper-corpus",
            relativePath: workflow.resultPath || "",
            extension: "json",
            analysisStatus: "processed",
            evidenceType: "corpus-workflow",
            resultHandle: workflow.resultHandle || null,
            content: JSON.stringify(workflow.preview || workflow).slice(
              0,
              this.limits.maxTotalEvidenceCharacters
            ),
          },
        ];
      } else if ((corpusWideLiteratureRequest || corpusUpdateRequest) && relevantPaperIds.length && this.corpusWorkflows) {
        const workflow = await this.corpusWorkflows.run(
          corpusUpdateRequest && !corpusWorkflowStatus
            ? "Summarize all papers and update the literature review."
            : question,
          {
          ...options,
          paperIds: relevantPaperIds,
          corpusScope: selectedPaperIds.length ? "selected" : "entire-project",
          }
        );
        const workflowValue = workflow.resultHandle
          ? await this.sourceSystem.results.read(workflow.resultHandle)
          : workflow;
        context.literature.corpusWorkflowId = workflowValue?.workflowId || null;
        context.corpusWorkflowStatus = await this.corpusWorkflows.getWorkflowStatus(
          workflowValue?.workflowId
        );
        context.literature.workflowFailures = context.corpusWorkflowStatus.failures.map(
          (failure) => ({
            paperId: failure.paperId,
            filename: failure.filename,
            stage: failure.stage,
            code: failure.code,
            sourceReady: failure.sourceReady,
            retryable: failure.retryable,
          })
        );
        if (workflowValue?.coverage) {
          context.literature.coverage = {
            ...context.literature.coverage,
            ...workflowValue.coverage,
            papersActuallyConsidered: [...relevantPaperIds],
          };
        }
        paperEvidence = [
          {
            name: "summarize-paper-corpus",
            relativePath: workflow.resultPath || "",
            extension: "json",
            analysisStatus: "processed",
            evidenceType: "corpus-workflow",
            resultHandle: workflow.resultHandle || null,
            content: JSON.stringify(workflow.preview || workflow).slice(
              0,
              this.limits.maxTotalEvidenceCharacters
            ),
          },
        ];
      } else if (corpusWorkflowFollowUp) {
        // Exact workflow failures are deliberately available through the compact
        // status tool instead of being copied into every active chat prompt.
        paperEvidence = [];
      } else {
        paperEvidence = await this.retrievePaperEvidence(
          options.question,
          relevantPaperIds,
          options
        );
      }
      const experimentEvidence = [];
      const relevantExperimentIds = await this.resolveExperimentSourceIds(question, {
        selectedExperimentIds,
        recentExperimentIds,
        shouldUseExperiments: experimentQuestion || followUpNeedsExperiments,
      });
      if (experimentQuestion || followUpNeedsExperiments) {
        for (const sourceId of relevantExperimentIds.slice(0, this.limits.maxEvidenceFiles)) {
          experimentEvidence.push(await this.buildExperimentEvidence(sourceId, options));
        }
      }
      context.experiments.relevantExperimentIds = experimentEvidence
        .filter((item) => item.analysisStatus === "processed")
        .map((item) => item.sourceId);
      context.sourceMap.activeExperimentIds = [...context.experiments.relevantExperimentIds];
      const otherEvidence = [];
      for (const file of selectedNonPaperFiles.slice(0, this.limits.maxEvidenceFiles)) {
        const source = this.sourceRegistry?.getByPath(file.relativePath);
        if (source?.sourceKind === "experiment") continue;
        otherEvidence.push(await this.buildFileEvidence(file, options));
      }
      context.files = [...paperEvidence, ...experimentEvidence, ...otherEvidence].slice(
        0,
        this.limits.maxEvidenceFiles
      );
      const finalPaperSources = this.sourceRegistry?.list({ sourceKind: "paper" }) || [];
      context.literature.coverage.papersDiscovered = finalPaperSources.length;
      context.literature.coverage.papersSearchable = finalPaperSources.filter(
        (source) => source.indexStatus === "ready"
      ).length;
      context.literature.coverage.papersExcludedOrFailed = finalPaperSources
        .filter(
          (source) => source.parseStatus === "failed" || source.indexStatus === "failed"
        )
        .map((source) => source.sourceId);
      if (context.literature.corpusWideRequest) {
        context.literature.coverage.papersExcludedOrFailed = [...new Set([
          ...context.literature.coverage.papersExcludedOrFailed,
          ...(context.literature.coverage.failedPaperIds || []),
          ...(context.literature.coverage.missingPaperIds || []),
        ])];
      }
      context.sourceMap.sourceCounts = this.sourceRegistry?.counts?.() || sourceCounts;
      context.inventory = this.buildInventory(options.workspaceTree);

      if (context.literature.corpusWideRequest) {
        const coverage = context.literature.coverage;
        context.notices.push(
          `Corpus literature workflow coverage: ${coverage.papersSuccessfullyAnalyzed || 0}/${coverage.papersIncludedInSnapshot || 0} included paper(s) were successfully analyzed; ${coverage.papersFailed || 0} failed and ${coverage.papersMissing || 0} were missing.`
        );
      }
      if (corpusFailureFollowUpRequest && corpusWorkflowFollowUp) {
        context.notices.push(
          "Exact corpus failure causes are available through get_corpus_workflow_status; do not infer a cause from aggregate coverage."
        );
      }
      if (corpusRecoveryResult) {
        const update = corpusWorkflowStatus?.incrementalUpdate || {};
        context.notices.push(
          `Corpus recovery retried ${corpusRecoveryResult.retriedPaperIds.length} failed map task(s), recovered ${(update.recoveredPaperIds || []).length}, reused ${(update.reusedMapPaperIds || []).length} unchanged map(s), and incrementally updated grouping, global reduction, and verification.`
        );
      }
      if (corpusUpdateResult) {
        const diff = corpusUpdateResult.diff || {};
        const update = corpusWorkflowStatus?.incrementalUpdate || {};
        context.notices.push(
          corpusUpdateResult.reusedExistingSynthesis
            ? `The current registry matches workflow ${corpusUpdateResult.parentWorkflowId}; reused the existing synthesis and ${(corpusWorkflowStatus?.coverage?.analyzedPaperIds || []).length} unchanged map(s).`
            : `Updated corpus workflow ${corpusWorkflowStatus?.workflowId} from parent ${corpusUpdateResult.parentWorkflowId}: added ${(diff.addedPaperIds || []).length}, removed ${(diff.removedPaperIds || []).length}, modified ${(diff.modifiedPaperIds || []).length}, reused ${(update.reusedMapPaperIds || []).length} existing map(s), and mapped ${(update.newlyMappedPaperIds || []).length} added/modified paper(s).`
        );
      }
      if (corpusFailureFollowUpRequest && corpusWorkflowLookupError) {
        context.notices.push(
          "No inspectable prior corpus workflow was found for this follow-up; do not guess why any paper failed."
        );
      }

      if (
        !selectedPaperIds.length &&
        !relevantPaperIds.length &&
        !corpusUpdateRequest &&
        LITERATURE_QUESTION_PATTERN.test(String(options.question || ""))
      ) {
        context.notices.push(
          "No sufficiently relevant paper was resolved from the source catalog, so no uploaded literature evidence was added."
        );
      }
      const explicitMemory = extractExplicitMemory(question);
      if (explicitMemory && this.projectState && this.workspace.state) {
        const record = await this.projectState.updateMemory(
          {
            ...explicitMemory,
            sourceIds: relevantPaperIds,
            experimentIds: context.experiments.relevantExperimentIds,
          },
          { surface }
        );
        internalStateUpdates.push(`memory:${record.memoryId}`);
        context.notices.push(
          `Saved one compact project-memory record (${record.kind}); source evidence remains in its source store.`
        );
      }
      if (managedWorkerRecovery) {
        context.managedWorker = {
          restarted: managedWorkerRecovery.restarted,
          resumedJobCount: (managedWorkerRecovery.resumedJobs || []).length,
          resumedWorkflowIds: (managedWorkerRecovery.resumedWorkflows || []).map(
            (item) => item.workflowId
          ),
          workerType: managedWorkerRecovery.after?.workerType ||
            managedWorkerRecovery.before?.workerType ||
            "browser-analysis-job-coordinator",
        };
      }
      const shouldPersistActiveState = Boolean(
        internalStateUpdates.length ||
        paperEvidence.some((item) => item.analysisStatus === "processed") ||
        experimentEvidence.some((item) => item.analysisStatus === "processed") ||
        corpusWorkflowStatus
      );
      if (this.projectState && this.workspace.state && shouldPersistActiveState) {
        context.projectMetadata = await this.projectState.refreshMetadata({
          surface,
          workflowId: context.literature.corpusWorkflowId || "",
        });
        internalStateUpdates.push("project-metadata-refreshed");
        await this.projectState.updateActiveState(
          {
            activePaperIds: relevantPaperIds,
            activeExperimentIds: context.experiments.relevantExperimentIds,
            activeWorkflowId: context.literature.corpusWorkflowId,
            currentTopic: question,
            recentInternalUpdates: internalStateUpdates,
          },
          { surface }
        );
      }
      context.internalStateUpdates = internalStateUpdates.slice(-30);
      this.addLibraryNotices(context);
      this.addFileNotices(context);
      this.applyProgressiveInventory(context, question);
      return context;
    }

    async resolveExperimentSourceIds(question, options = {}) {
      if (!options.shouldUseExperiments) return [];
      if (options.selectedExperimentIds?.length) {
        return [...new Set(options.selectedExperimentIds)];
      }
      if (options.recentExperimentIds?.length) {
        return [...new Set(options.recentExperimentIds)];
      }
      const matchedIds = [];
      if (this.experimentTools) {
        const result = await this.experimentTools.searchExperiments(question, {
          readyOnly: true,
          fallbackToAll: false,
          limit: this.limits.maxRetrievalResults,
        });
        const records = result?.resultHandle
          ? await this.sourceSystem.results.read(result.resultHandle)
          : result;
        for (const record of Array.isArray(records) ? records : []) {
          if (record?.sourceId && !matchedIds.includes(record.sourceId)) {
            matchedIds.push(record.sourceId);
          }
        }
      }
      const terms = tokenizeQuestion(question);
      const metadataMatches = (this.sourceRegistry?.list({ sourceKind: "experiment" }) || [])
        .map((source) => ({
          sourceId: source.sourceId,
          score: terms.reduce(
            (score, term) =>
              score +
              (`${source.displayName} ${source.path}`.toLowerCase().includes(term) ? 1 : 0),
            0
          ),
        }))
        .filter((item) => item.score > 0)
        .sort((left, right) => right.score - left.score)
        .map((item) => item.sourceId);
      return [...new Set([...matchedIds, ...metadataMatches])].slice(
        0,
        Math.min(5, this.limits.maxEvidenceFiles)
      );
    }

    applyProgressiveInventory(context, question) {
      if (
        PROJECT_METADATA_QUESTION_PATTERN.test(String(question || "")) ||
        SOURCE_CATALOG_QUESTION_PATTERN.test(String(question || "")) ||
        CORPUS_FAILURE_FOLLOW_UP_PATTERN.test(String(question || "")) ||
        MANAGED_WORKER_RECOVERY_PATTERN.test(String(question || ""))
      ) return;
      const activeSourceIds = new Set([
        ...(context.sourceMap?.selectedPaperIds || []),
        ...(context.sourceMap?.selectedExperimentIds || []),
        ...(context.files || []).flatMap((file) => [file.paperId, file.sourceId]),
      ]);
      const selectedPaths = new Set(context.scope?.files || []);
      context.inventory = context.inventory.filter(
        (item) =>
          !item.sourceKind ||
          activeSourceIds.has(item.sourceId) ||
          selectedPaths.has(item.relativePath)
      );
    }

    async ensurePaperCards(paperIds, options = {}) {
      const targets = (this.literature?.documents || []).filter(
        (document) =>
          document.isLiteraturePaper &&
          (!Array.isArray(paperIds) || paperIds.includes(document.id)) &&
          document.paperCardStatus !== "ready"
      );
      if (!targets.length) return null;
      return this.literature.ensurePaperCards({
        ...(Array.isArray(paperIds) ? { paperIds } : {}),
        signal: options.signal,
        onProgress: options.onProgress,
      });
    }

    getSelectedPaperIds(selectedPaths, suppliedPaperIds = []) {
      const availableIds = new Set(
        (this.literature?.documents || [])
          .filter((document) => document.isLiteraturePaper)
          .map((document) => document.id)
      );
      const supplied = [...new Set(
        (Array.isArray(suppliedPaperIds) ? suppliedPaperIds : []).filter(
          (paperId) => typeof paperId === "string" && availableIds.has(paperId)
        )
      )];
      if (supplied.length) return supplied.slice(0, this.limits.maxEvidenceFiles);
      const selectedPathSet = new Set(selectedPaths);
      return (this.literature?.documents || [])
        .filter(
          (document) =>
            document.isLiteraturePaper && selectedPathSet.has(document.relativePath)
        )
        .map((document) => document.id)
        .slice(0, this.limits.maxEvidenceFiles);
    }

    async matchPapers(query, options = {}) {
      const cards = [];
      const candidateIds = Array.isArray(options.candidatePaperIds)
        ? new Set(options.candidatePaperIds)
        : null;
      const candidateStatuses = Array.isArray(options.candidateStatuses)
        ? new Set(options.candidateStatuses)
        : null;
      for (const document of this.literature?.documents || []) {
        if (
          !document.isLiteraturePaper ||
          (candidateIds && !candidateIds.has(document.id)) ||
          (candidateStatuses && !candidateStatuses.has(document.paperCardStatus)) ||
          (options.readyOnly !== false &&
            (document.paperCardStatus !== "ready" || !document.summaryAvailable))
        ) continue;
        const discovery = document.discovery || {};
        cards.push({
          document,
          card: {
            fileName: discovery.fileName || document.filename,
            title: discovery.title,
            authors: discovery.authors,
            year: discovery.year,
            topics: discovery.topics,
            keywords: discovery.keywords,
            genes: discovery.identifiers,
            proteins: discovery.identifiers,
            shortSummary: discovery.shortDescription,
          },
        });
      }
      const rankedCards = rankPaperCards(cards, query, options);
      if (!this.literatureTools) {
        rankedCards.retrievalDecision = {
          profile: normalizeRetrievalProfile(options.retrievalProfile),
          mode: "fast",
          escalated: false,
          reason: "local-paper-card-ranking",
        };
        return rankedCards;
      }
      const broadTopicQuery = TOPIC_NAVIGATION_PATTERN.test(query);
      const lexicalQuery = tokenizeQuestion(query).join(" ") || query;
      const searched = await this.literatureTools.searchPapers(lexicalQuery, {
        qmdQuery: query,
        topK: Math.min(20, Math.max(1, Number(options.topK) || 5)),
        includeUnpreparedMetadata: options.readyOnly !== true,
        retrievalProfile: normalizeRetrievalProfile(options.retrievalProfile),
        signal: options.signal,
        collections: broadTopicQuery
          ? ["literature-evidence", "paper-cards"]
          : ["literature-evidence"],
        ...(candidateIds ? { paperIds: [...candidateIds] } : {}),
      });
      const byPaperId = new Map(rankedCards.map((item) => [item.paperId, item]));
      for (const result of searched.results || []) {
        const document = this.literature.documents.find(
          (candidate) => candidate.id === result.paperId
        );
        if (!document || (options.readyOnly === true && result.searchable !== true)) {
          continue;
        }
        const existing = byPaperId.get(result.paperId);
        if (existing) {
          existing.score = Math.max(existing.score, Number(result.score) || 0);
          continue;
        }
        byPaperId.set(result.paperId, {
          paperId: result.paperId,
          document,
          card: {
            fileName: result.fileName,
            title: result.title,
            authors: result.authors,
            year: result.year,
            topics: result.topics,
            keywords: result.keywords,
            genes: result.identifiers,
            proteins: result.identifiers,
            shortSummary: result.snippet,
          },
          score: Number(result.score) || 0,
          matchedTerms: 0,
        });
      }
      const ranked = [...byPaperId.values()]
        .filter((item) => item.score > 0)
        .sort(
          (left, right) =>
            right.score - left.score ||
            String(left.document.filename).localeCompare(String(right.document.filename))
        )
        .slice(0, Math.max(1, Number(options.topK) || 5));
      ranked.retrievalDecision = searched.retrievalDecision || {
        profile: normalizeRetrievalProfile(options.retrievalProfile),
        mode: "fast",
        escalated: false,
        reason: "local-paper-card-ranking",
      };
      return ranked;
    }

    async retrievePaperEvidence(query, paperIds, options = {}) {
      const boundedIds = [...new Set(Array.isArray(paperIds) ? paperIds : [])]
        .slice(0, this.limits.maxEvidenceFiles);
      const entriesByPath = new Map(
        flattenWorkspaceTree(options.workspaceTree).map((entry) => [
          entry.relativePath,
          entry,
        ])
      );
      const evidence = [];
      const perPaperBudget = Math.max(
        this.limits.maxRetrievalSnippetCharacters,
        Math.floor(this.limits.maxTotalEvidenceCharacters / Math.max(1, boundedIds.length))
      );
      const summaryBudget = Math.min(
        this.limits.maxSummaryCharactersPerFile,
        Math.max(700, Math.floor(perPaperBudget * 0.45))
      );
      const sourceBudget = Math.min(
        this.limits.maxSourceCharactersPerFile,
        Math.max(500, perPaperBudget - summaryBudget)
      );
      // Retrieval is deliberately per paper so one selected paper cannot consume
      // the entire evidence budget for a comparison question.
      for (const paperId of boundedIds) {
        const document = this.literature?.documents?.find(
          (candidate) => candidate.id === paperId
        );
        if (!document) continue;
        const file = entriesByPath.get(document.relativePath) || {
          name: document.filename,
          relativePath: document.relativePath,
          type: "file",
          size: document.size,
          lastModified: document.lastModified,
        };
        const item = await this.buildFileEvidence(file, {
          ...options,
          question: query,
          includeSourceEvidence: true,
          maxSummaryCharacters: summaryBudget,
          maxSourceCharacters: sourceBudget,
        });
        item.paperId = document.id;
        evidence.push(item);
      }
      return evidence;
    }

    baseContext(options, type, files = [], routing = null) {
      const memory = this.workspace.state?.memory || {};
      const selectedMemoryIds =
        options.enableContextRouter === true && routing
          ? new Set(routing.memoryIds || [])
          : null;
      const memoryValue = (memoryId, value) =>
        !selectedMemoryIds || selectedMemoryIds.has(memoryId)
          ? String(value || "").slice(0, 8000)
          : "";
      const memoryRecords = (Array.isArray(memory.records) ? memory.records : [])
        .filter(
          (record) =>
            record?.status === "active" &&
            (!selectedMemoryIds || selectedMemoryIds.has(record.memoryId))
        )
        .slice(-50)
        .map((record) => ({
          memoryId: String(record.memoryId || "").slice(0, 200),
          kind: String(record.kind || "observation").slice(0, 80),
          text: String(record.text || "").slice(0, 2000),
          sourceIds: (record.sourceIds || []).slice(0, 100),
          experimentIds: (record.experimentIds || []).slice(0, 100),
          updatedAt: record.updatedAt || record.createdAt || "",
        }));
      return {
        schemaVersion: 1,
        scope: {
          type,
          files: files.map((file) => file.relativePath),
        },
        project: {
          workspaceName: this.workspace.workspace?.name || "",
          goal: String(options.projectGoal || this.workspace.state?.project?.goal || ""),
          projectSummary: memoryValue("project_summary", memory.projectSummary),
          literatureSummary: memoryValue(
            "literature_summary",
            memory.literatureSummary
          ),
          experimentalSummary: memoryValue(
            "experimental_summary",
            memory.experimentalSummary
          ),
          memoryRecords,
        },
        inventory: this.buildInventory(options.workspaceTree),
        files: [],
        notices: [],
        literature: {
          selectedPaperIds: [],
          relevantPaperIds: [],
          discoveryMode: "not-needed",
          retrievalRequired: false,
        },
      };
    }

    async buildProjectContext(options) {
      const context = this.baseContext(options, "project");
      this.addLibraryNotices(context);
      return context;
    }

    addLibraryNotices(context) {
      const unprocessed = context.inventory.filter(
        (item) =>
          item.processor === "pdf" &&
          item.indexStatus !== "ready" &&
          item.parseStatus !== "ready" &&
          item.indexStatus !== "failed" &&
          item.parseStatus !== "failed"
      );
      if (unprocessed.length) {
        context.notices.push(
          `${unprocessed.length} paper source(s) are discovered but not content-searchable yet. Their filenames are inventory only until a source tool prepares them.`
        );
      }
      const unsupported = context.inventory.filter((item) => !item.processor);
      if (unsupported.length) {
        context.notices.push(
          `${unsupported.length} non-PDF file(s) are visible in the workspace but do not yet have an AI content processor.`
        );
      }
      const experimentPending = context.inventory.filter(
        (item) =>
          item.processor === "experiment" && item.structuredDataStatus !== "ready"
      );
      if (experimentPending.length) {
        context.notices.push(
          `${experimentPending.length} experiment source(s) are discovered and will be normalized only when an experiment tool needs them.`
        );
      }
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
        const source = this.sourceRegistry?.getByPath(file.relativePath);
        if (source?.sourceKind === "experiment") {
          return EXPERIMENT_QUESTION_PATTERN.test(String(options.question || ""))
            ? this.buildExperimentEvidence(source.sourceId, options)
            : {
                name: file.name,
                relativePath: file.relativePath,
                extension,
                sourceId: source.sourceId,
                analysisStatus: "unprocessed",
                evidenceType: "inventory-only",
                content: "",
              };
        }
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
        if (!requiresFileEvidence) {
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
        const broad = BROAD_PAPER_QUESTION_PATTERN.test(String(options.question || ""));
        const source = this.sourceRegistry?.get(document.id);
        const highNeedsNative =
          options.retrievalProfile === "high" &&
          (broad ||
            NATIVE_PDF_QUESTION_PATTERN.test(String(options.question || "")) ||
            HIGH_NATIVE_PDF_QUESTION_PATTERN.test(String(options.question || "")) ||
            source?.parseStatus === "failed");
        const useNativePdf = Boolean(
          this.nativePdfAnalyzer &&
          (highNeedsNative ||
            NATIVE_PDF_QUESTION_PATTERN.test(String(options.question || "")) ||
            (broad && (options.qualityMode || "balanced") !== "fast"))
        );
        if (useNativePdf) {
          try {
            options.onProgress?.({
              stage: "analyzing-native-pdf",
              relativePath: file.relativePath,
            });
            const nativeResult = await this.nativePdfAnalyzer.analyze(
              document.id,
              options.question,
              {
                ...options,
                purpose: broad ? "whole_paper_summary" : "layout_dependent_evidence",
                responseSchema: "paper_analysis",
                language: options.language,
              }
            );
            const resolved = nativeResult?.resultHandle
              ? await this.sourceSystem.results.read(nativeResult.resultHandle)
              : nativeResult;
            return {
              name: file.name,
              relativePath: file.relativePath,
              extension,
              sourceId: document.id,
              paperId: document.id,
              analysisStatus: "processed",
              evidenceType: "requesty-native-pdf-analysis",
              resultHandle: nativeResult?.resultHandle || null,
              content: JSON.stringify({
                paperId: document.id,
                contentHash: resolved.contentHash,
                analysis: resolved.analysis,
                evidenceRefs: resolved.evidenceRefs,
                artifactPath: resolved.artifactPath,
              }).slice(0, this.limits.maxSourceCharactersPerFile * 2),
            };
          } catch (error) {
            if (error?.code === "OPERATION_ABORTED") throw error;
            console.info("native_pdf_analysis_fallback", {
              paperId: document.id,
              code: error?.code || error?.name || "NATIVE_PDF_FAILED",
              message: String(error?.message || error).slice(0, 300),
              fallback: "local-parsed-evidence",
            });
            options.onProgress?.({
              stage: "native-pdf-fallback",
              relativePath: file.relativePath,
            });
          }
        }
        let card = null;
        if (broad) {
          try {
            const cardResult = await this.literature.createPaperCard(document.id, {
              signal: options.signal,
              onProgress: (progress) =>
                options.onProgress?.({ ...progress, relativePath: file.relativePath }),
            });
            card = cardResult.summary;
          } catch (error) {
            // A Paper Card is optional. Original-paper evidence remains usable if
            // the model summary fails.
            console.info("optional_paper_card_failed", {
              paperId: document.id,
              code: error.code || error.name || "PAPER_CARD_FAILED",
              message: String(error.message || "Paper Card generation failed.").slice(0, 300),
            });
            options.onProgress?.({
              stage: "paper-card-failed",
              relativePath: file.relativePath,
              error: error.message,
            });
          }
        }
        options.onProgress?.({
          stage: "extracting-detail",
          relativePath: file.relativePath,
        });
        await this.literature.preparation.ensureSourceReady(
          [document.id],
          "search",
          options
        );
        const artifact = await this.literature.preparation.readPaperArtifact(document.id);
        const maxSourceCharacters =
          Number(options.maxSourceCharacters) || this.limits.maxSourceCharactersPerFile;
        let evidenceChunks;
        if (broad) {
          const count = Math.min(6, artifact.chunks.length);
          const indexes = [...new Set(
            Array.from({ length: count }, (_, index) =>
              Math.round((index * (artifact.chunks.length - 1)) / Math.max(1, count - 1))
            )
          )];
          evidenceChunks = indexes.map((index) => artifact.chunks[index]).filter(Boolean);
        } else {
          evidenceChunks = artifact.chunks
            .map((chunk) => ({ ...chunk, score: this.scorePaperChunk(chunk, options.question) }))
            .sort((left, right) => right.score - left.score)
            .slice(0, 5);
        }
        let remaining = maxSourceCharacters;
        const evidenceText = evidenceChunks
          .map((chunk) => {
            const text = String(chunk.text || "").slice(0, remaining);
            remaining -= text.length;
            return text
              ? `[${document.id}:p${chunk.page}:${chunk.chunkId}]\n${text}`
              : "";
          })
          .filter(Boolean)
          .join("\n\n");
        const cardText = card
          ? formatPaperSummary(card, file.relativePath).slice(
              0,
              Number(options.maxSummaryCharacters) ||
                this.limits.maxSummaryCharactersPerFile
            )
          : "";
        const content = [
          cardText,
          `Original-paper evidence for ${file.relativePath}:\n${evidenceText}`,
        ].filter(Boolean).join("\n\n");
        return {
          name: file.name,
          relativePath: file.relativePath,
          extension,
          sourceId: document.id,
          paperId: document.id,
          analysisStatus: "processed",
          evidenceType: card
            ? "optional-paper-card+original-evidence"
            : "original-paper-evidence",
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

    scorePaperChunk(chunk, question) {
      const tokens = tokenizeQuestion(question);
      const text = String(chunk?.text || "").toLowerCase();
      return tokens.reduce(
        (score, token) => score + (text.includes(token) ? 1 : 0),
        0
      );
    }

    async buildExperimentEvidence(sourceId, options = {}) {
      const source = this.sourceRegistry?.get(sourceId);
      if (!source || source.sourceKind !== "experiment" || !this.experimentTools) {
        return {
          sourceId,
          name: source?.displayName || "experiment",
          relativePath: source?.path || "",
          extension: fileExtension(source?.displayName || ""),
          analysisStatus: "processing-failed",
          evidenceType: "inventory-only",
          content: "",
          error: "The selected experiment source is unavailable.",
        };
      }
      try {
        options.onProgress?.({ stage: "preparing-experiment", relativePath: source.path });
        const result = await this.experimentTools.searchExperiments(options.question, {
          ...options,
          experimentSourceIds: [sourceId],
          limit: 120,
        });
        const records = result?.resultHandle
          ? await this.sourceSystem.results.read(result.resultHandle)
          : result;
        const compactRecords = (Array.isArray(records) ? records : []).slice(0, 40).map((record) => ({
          experimentId: record.experimentId,
          values: record.raw,
          entities: record.entities,
          provenance: record.provenance,
        }));
        return {
          sourceId,
          name: source.displayName,
          relativePath: source.path,
          extension: fileExtension(source.displayName),
          analysisStatus: "processed",
          evidenceType: "structured-experiment-records",
          resultHandle: result?.resultHandle || null,
          content: [
            `Internal experimental evidence from ${source.path}. Values are raw/normalized deterministically; provenance is retained.`,
            JSON.stringify(compactRecords),
          ].join("\n"),
        };
      } catch (error) {
        return {
          sourceId,
          name: source.displayName,
          relativePath: source.path,
          extension: fileExtension(source.displayName),
          analysisStatus: "processing-failed",
          evidenceType: "inventory-only",
          content: "",
          error: `Could not process ${source.path}: ${error.message || "Unknown experiment error"}`,
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
    detectCorpusWideLiteratureIntent,
    detectCorpusFailureFollowUpIntent,
    detectCorpusRecoveryIntent,
    detectCorpusUpdateIntent,
    fileExtension,
    flattenWorkspaceTree,
    formatPaperSummary,
    normalizeStoredConversation,
    prepareLatestSideChatRevision,
    questionNeedsSourceEvidence,
    questionMayNeedLiterature,
    questionRequiresFileEvidence,
    rankPaperCards,
    selectBroadPaperCoverage,
    selectRelevantExcerpts,
  };
});
