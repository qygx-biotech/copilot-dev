(function exposeSemanticIntent(root, factory) {
  const api = factory(root);
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.BioDesignSemanticIntent = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function semanticIntentFactory(root) {
  "use strict";

  const SEMANTIC_SCHEMA_VERSION = 1;
  const PATTERN_LIBRARY_VERSION = 1;
  // Calibrated against scripts/fixtures/semantic-intent.json; a runner-up near
  // the winner is uncertainty, not a reason to pick a forced intent.
  const DEFAULT_THRESHOLDS = Object.freeze({ known: 0.86, uncertain: 0.64, margin: 0.08 });
  const EFFECTS = Object.freeze(["informational", "internal_state", "result_producing", "destructive_source", "external_side_effect"]);
  const OPERATIONS = Object.freeze([
    "search", "read", "list", "filter", "aggregate", "rank", "compare", "find-conflicts",
    "analyze-conditions", "summarize", "snapshot", "prepare", "map", "group", "reduce", "verify",
    "explain", "update", "store", "recall", "status", "trend", "statistics", "visualize", "export",
    "predict", "design", "schedule", "send", "delete", "translate", "recover"
  ]);
  const entry = (tool, supportsObjects, operations, effect = "informational", hostOnly = false) =>
    Object.freeze({ capability: tool, tool, supportsObjects: Object.freeze(supportsObjects), operations: Object.freeze(operations), effect, hostOnly });
  // Actual tools stay authoritative. Host-only entries describe existing local
  // preparation, never invent an FC tool or grant execution permission.
  const CAPABILITY_REGISTRY = Object.freeze([
    entry("list_workspace_items", ["workspace", "project"], ["list"]),
    entry("search_workspace_items", ["workspace", "memory"], ["search", "recall"]),
    entry("read_workspace_item", ["workspace"], ["read"]),
    entry("read_project_context", ["memory", "project", "recommendation"], ["read", "recall", "explain", "status"]),
    entry("list_papers", ["literature"], ["list", "snapshot"]),
    entry("search_papers", ["literature"], ["search", "filter"], "internal_state"),
    entry("read_paper_evidence", ["literature"], ["read", "compare", "find-conflicts", "analyze-conditions", "verify", "explain"], "internal_state"),
    entry("list_experiment_sources", ["experiments"], ["list"]),
    entry("query_experiment_results", ["experiments"], ["search", "filter", "aggregate", "rank", "compare", "trend", "statistics", "analyze-conditions"], "internal_state"),
    entry("get_corpus_workflow_status", ["literature"], ["status"]),
    entry("source_coverage", ["project", "workspace", "literature", "experiments"], ["status", "verify"]),
    entry("update_project_memory", ["memory"], ["update", "store"], "internal_state"),
    entry("get_local_worker_status", ["workspace"], ["status"]),
    entry("restart_local_worker", ["workspace"], ["recover"], "internal_state"),
    entry("update_recommendation", ["recommendation"], ["update"], "result_producing"),
    entry("corpus_workflow", ["literature"], ["summarize", "snapshot", "prepare", "map", "group", "reduce", "verify", "update"], "internal_state", true),
    entry("ensure_paper_card", ["literature"], ["summarize"], "internal_state", true),
    entry("analyze_pdf_native", ["literature"], ["read", "verify"], "internal_state", true)
  ]);
  const capabilityMap = new Map(CAPABILITY_REGISTRY.map((item) => [item.capability, item]));
  const pattern = (patternId, examples, defaultOperations, requiredCapabilities, objects, output, allowedOperations = defaultOperations) =>
    Object.freeze({ patternId, examples, defaultOperations, requiredCapabilities, objects, output, allowedOperations });
  const SEMANTIC_PATTERNS = Object.freeze([
    pattern("literature.corpus_synthesis", { en: ["Summarize all papers", "Write a review based on my literature", "What does the entire literature collection say?", "Synthesize my references"], zh: ["总结所有文献", "帮我写一个综述", "把全部文章归纳一下"] }, ["snapshot", "prepare", "map", "group", "reduce", "verify"], ["corpus_workflow"], ["literature"], "literature-synthesis", ["summarize", "compare", "explain"]),
    pattern("literature.update_synthesis", { en: ["Update our literature review", "Incorporate new papers into the synthesis"], zh: ["更新文献综述", "把新增论文加入综述"] }, ["update", "snapshot", "map", "reduce", "verify"], ["corpus_workflow"], ["literature"], "literature-synthesis", ["update", "summarize"]),
    pattern("literature.search", { en: ["Find papers on enzyme engineering", "Locate publications about EctD"], zh: ["查找酶工程文献", "检索 EctD 论文"] }, ["search"], ["search_papers"], ["literature"], "evidence-list"),
    pattern("literature.paper_qa", { en: ["Explain this paper", "What did this study find?", "Read the paper evidence"], zh: ["解释这篇论文", "这篇文章发现了什么"] }, ["read", "explain"], ["read_paper_evidence"], ["literature"], "evidence-answer", ["read", "explain", "summarize"]),
    pattern("literature.compare", { en: ["Compare these papers", "Contrast the studies"], zh: ["比较这些论文", "对比文献结果"] }, ["search", "read", "compare"], ["search_papers", "read_paper_evidence"], ["literature"], "comparison", ["compare", "search", "read"]),
    pattern("experiment.search", { en: ["Find experiments about enzyme activity", "Search the experimental records"], zh: ["查找酶活性实验", "检索实验记录"] }, ["search", "filter"], ["query_experiment_results"], ["experiments"], "experiment-records", ["search", "filter"]),
    pattern("experiment.lookup", { en: ["Read the experiment values", "Show our assay measurements"], zh: ["查看实验数值", "读取实验结果"] }, ["read"], ["query_experiment_results"], ["experiments"], "experiment-records", ["read", "list"]),
    pattern("experiment.rank", { en: ["Which mutation performs best?", "Rank the variants", "Which sequence should we prioritize?", "Which variant has the highest titer?"], zh: ["哪个突变最好？", "哪个变体产量最高？", "对突变体排序"] }, ["filter", "aggregate", "rank"], ["query_experiment_results"], ["experiments"], "ranked-comparison", ["rank", "filter", "aggregate"]),
    pattern("experiment.compare", { en: ["Compare our experiments", "Contrast the assay results"], zh: ["比较我们的实验", "对比实验结果"] }, ["filter", "compare"], ["query_experiment_results"], ["experiments"], "comparison", ["compare", "filter"]),
    pattern("experiment.trend", { en: ["How does titer change over time?", "Show experiment trends"], zh: ["产量随时间如何变化", "实验数据有什么趋势"] }, ["filter", "aggregate", "trend"], ["query_experiment_results"], ["experiments"], "trend-analysis", ["trend", "filter", "aggregate"]),
    pattern("experiment.statistics", { en: ["Calculate experimental mean and variance", "Compute assay statistics"], zh: ["计算实验均值和方差", "统计实验结果"] }, ["aggregate", "statistics"], ["query_experiment_results"], ["experiments"], "statistical-analysis", ["aggregate", "statistics"]),
    pattern("cross_source.compare_literature_experiments", { en: ["Compare our experiments with literature", "Do papers agree with our results?"], zh: ["把实验和文献比较", "论文与我们的实验一致吗"] }, ["search", "compare"], ["query_experiment_results", "search_papers", "read_paper_evidence"], ["experiments", "literature"], "cross-source-comparison", ["search", "compare", "read", "find-conflicts"]),
    pattern("memory.lookup", { en: ["Recall our saved project decisions", "What did we decide?"], zh: ["我们之前决定了什么", "回忆已保存的项目决定"] }, ["recall"], ["search_workspace_items", "read_project_context"], ["memory"], "memory-answer", ["recall", "read", "explain"]),
    pattern("memory.update", { en: ["Remember that our objective is higher titer", "Save this project decision"], zh: ["记住我们的目标是提高滴度", "保存这个项目决定"] }, ["store"], ["update_project_memory"], ["memory"], "memory-update", ["store", "update"]),
    pattern("project.status", { en: ["What is our project status?", "Show the workspace coverage"], zh: ["项目进展如何", "查看工作区覆盖情况"] }, ["status"], ["source_coverage", "read_project_context"], ["project"], "project-status", ["status", "read", "list"]),
    pattern("recommendation.explain", { en: ["Why is the current recommendation A163V?", "Explain our recommendation"], zh: ["为什么目前推荐 A163V", "解释当前推荐"] }, ["read", "explain"], ["read_project_context"], ["recommendation"], "recommendation-explanation", ["read", "explain"]),
    pattern("recommendation.update", { en: ["Update our current recommendation", "Revise the recommendation based on experiments"], zh: ["更新当前推荐", "根据实验修改推荐"] }, ["update"], ["update_recommendation"], ["recommendation"], "recommendation-update", ["update", "read"])
  ]);
  const patternMap = new Map(SEMANTIC_PATTERNS.map((item) => [item.patternId, item]));

  // A versioned concept/alias vocabulary projects multilingual text into one
  // sparse semantic space. Aliases are linguistic features, never route branches.
  // Optional QMD vectors are not needed and no new model stack is initialized.
  const CONCEPT_ALIASES = Object.freeze({
    literature: ["paper", "papers", "article", "articles", "studies", "study", "literature", "publication", "publications", "references", "corpus", "论文", "文献", "文章"],
    experiments: ["experiment", "experiments", "experimental", "assay", "assays", "measurements", "our results", "our data", "实验", "测定", "测量", "我们的结果", "内部数据"],
    variant: ["mutation", "mutations", "mutant", "mutants", "variant", "variants", "sequence", "sequences", "突变", "突变体", "变体", "序列"],
    corpus: ["all", "every", "everything", "entire", "whole", "collection", "corpus", "library", "overall", "references", "review", "reviews", "synthesis", "my literature", "our literature", "my papers", "our papers", "selected papers", "these papers", "those papers", "总共", "共有", "所有", "全部", "整个", "这些", "当前这些", "现在这些", "文献库", "综合", "综述", "归纳"],
    summarize: ["summarize", "summarise", "summary", "synthesize", "synthesise", "synthesis", "review", "reviews", "survey", "overview", "overall", "main findings", "major themes", "takeaways", "tell us", "collection say", "corpus say", "put together", "总结", "综述", "归纳", "概述", "综合", "主要讲", "讲了什么", "总体", "主线"],
    search: ["search", "find", "locate", "look for", "look up", "retrieve", "查找", "检索", "寻找", "找出", "找一下"],
    read: ["read", "show", "values", "measurements", "查看", "读取", "数值"],
    rank: ["rank", "ranking", "best", "top", "highest", "lowest", "prioritize", "prioritise", "outperform", "排序", "排名", "最好", "最佳", "最高", "最低", "优先", "前五", "前5"],
    compare: ["compare", "comparison", "comparisons", "contrast", "agree", "agreement", "versus", "比较", "对比", "一致"],
    "find-conflicts": ["disagree", "disagreements", "contradictory", "contradictions", "contradiction", "discrepancy", "discrepancies", "conflict", "conflicts", "conflicting", "矛盾", "冲突", "不一致", "分歧"],
    "analyze-conditions": ["temperature", "temperatures", "condition", "conditions", "温度", "条件"],
    filter: ["filter", "exclude", "excluding", "only", "before", "after", "remove", "ignore", "less than", "more than", "筛选", "排除", "只保留", "早于", "之前", "小于", "大于", "忽略"],
    aggregate: ["aggregate", "group", "mean", "average", "均值", "平均", "聚合", "分组"],
    trend: ["trend", "trends", "over time", "change over", "随时间", "趋势", "如何变化"],
    statistics: ["statistics", "statistical", "variance", "standard deviation", "confidence interval", "统计", "方差", "标准差", "置信区间"],
    explain: ["explain", "why", "what did", "解释", "为什么", "为何", "发现了什么"],
    memory: ["memory", "remember", "recall", "saved", "decision", "decisions", "decide", "记忆", "记住", "回忆", "保存", "决定"],
    recall: ["recall", "saved", "what did we decide", "回忆", "之前决定", "已保存"],
    store: ["remember", "save", "record", "记住", "保存", "记录"],
    update: ["update", "revise", "refresh", "incorporate", "new papers", "更新", "修改", "刷新", "新增", "加入"],
    recommendation: ["recommendation", "recommended", "推荐"],
    project: ["project", "workspace", "项目", "工作区"],
    status: ["status", "progress", "coverage", "状态", "进展", "覆盖"],
    visualize: ["plot", "chart", "visualize", "graph", "画图", "绘图", "可视化"],
    export: ["export", "download", "导出", "下载"],
    predict: ["predict", "forecast", "预测"],
    design: ["design", "propose", "hypothesize", "设计", "提出", "假设"],
    schedule: ["schedule", "remind", "every week", "tomorrow", "定时", "提醒", "每周", "明天"],
    send: ["send", "email", "publish", "发送", "邮件", "发布"],
    delete: ["delete", "erase", "destroy", "删除", "擦除"],
    translate: ["translate", "translation", "翻译"],
    recover: ["recover", "restart", "retry", "重启", "恢复", "重试"]
  });
  const experimentSemantics = root?.BioDesignExperimentSemantics ||
    (typeof require === "function" ? require("./experiment-semantics.js") : {});
  // Intent slots and workbook mappings share the same canonical ontology.
  const SCIENTIFIC_ENTITIES = Object.freeze(Object.entries(experimentSemantics.ENTITY_REGISTRY || {}).map(([canonicalId, aliases]) => ({
    canonicalId, aliases: aliases.filter((alias) => !extractProtectedIdentifiers(alias).includes(alias))
  })));
  const FIELD_ALIASES = Object.freeze(Object.fromEntries(Object.values(experimentSemantics.FIELD_REGISTRY || {})
    .filter((field) => field.dataType === "number").map((field) => [field.canonicalField, field.aliases])));

  const str = (maxLength = 200, minLength = 1) => ({ type: "string", minLength, maxLength });
  const nullable = (schema) => ({ anyOf: [schema, { type: "null" }] });
  const list = (items, maxItems = 32) => ({ type: "array", items, maxItems });
  const obj = (properties) => ({ type: "object", properties, required: Object.keys(properties), additionalProperties: false });
  const OPERATORS = ["=", "!=", "<", "<=", ">", ">=", "in", "contains"];
  const scalar = { anyOf: [str(500, 0), { type: "number" }, { type: "boolean" }, { type: "null" }, list(str(256), 100)] };
  const scopedIds = { anyOf: [{ type: "null" }, { type: "string", enum: ["current-project"] }, list(str(256), 500)] };
  const SEMANTIC_IR_SCHEMA = Object.freeze(obj({
    version: { type: "integer", enum: [SEMANTIC_SCHEMA_VERSION] },
    inputLanguage: str(24), answerLanguage: str(24), matchedPattern: nullable({ type: "string", enum: SEMANTIC_PATTERNS.map((item) => item.patternId) }),
    patternConfidence: { type: "number", minimum: 0, maximum: 1 }, goal: str(4000),
    operations: list({ type: "string", enum: OPERATIONS }), objects: list(str(80), 12),
    entities: list(obj({ type: str(80), canonicalId: str(256), mention: str(256) }), 80),
    metrics: list(obj({ canonicalField: nullable(str(120)), direction: nullable({ type: "string", enum: ["maximize", "minimize", "target"] }) }), 16),
    scope: obj({ papers: scopedIds, experiments: scopedIds }),
    filters: list(obj({ field: str(120), operator: { type: "string", enum: OPERATORS }, value: scalar, unit: nullable(str(60)) })),
    constraints: list(obj({ type: str(120), field: nullable(str(120)), operator: nullable({ type: "string", enum: OPERATORS }), value: scalar, unit: nullable(str(60)), description: str(500) })),
    comparisonVariables: list(str(120)), requestedOutput: obj({ type: str(120), limit: nullable({ type: "integer", minimum: 1, maximum: 100000 }) }),
    capabilityHints: list({ type: "string", enum: CAPABILITY_REGISTRY.map((item) => item.capability) }), unresolvedSlots: list(str(160))
  }));

  function unique(values) { return [...new Set(values)]; }
  function plain(value) { return Boolean(value && typeof value === "object" && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value))); }
  function normalized(value) { return String(value || "").normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim(); }
  function escaped(value) { return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }
  function aliasPresent(text, alias) {
    const term = normalized(alias);
    if (!term) return false;
    return /[\u3400-\u9fff]/u.test(term) ? text.includes(term)
      : new RegExp(`(?<![a-z0-9])${escaped(term)}(?![a-z0-9])`, "u").test(text);
  }
  function features(value) {
    const text = normalized(value);
    const result = new Set(Object.entries(CONCEPT_ALIASES).filter(([, aliases]) => aliases.some((alias) => aliasPresent(text, alias))).map(([key]) => key));
    if (result.has("variant") && (!result.has("literature") || result.has("rank"))) result.add("experiments");
    if (result.has("summarize") && /review|references|综述/u.test(text)) result.add("literature");
    if (result.has("rank")) result.delete("search"); // "find the best" describes ranking, not a second search.
    if (result.has("recall") && /回忆|已保存|之前决定/u.test(text)) result.delete("store");
    else if (result.has("store")) result.delete("recall");
    if (!result.has("status") && ["literature", "experiments", "memory"].some((domain) => result.has(domain))) result.delete("project");
    if (result.has("recommendation")) result.delete("project");
    return result;
  }
  const featureWeight = (name) => ["literature", "experiments", "memory", "recommendation", "project", "corpus"].includes(name) ? 1.35 : name === "variant" ? 0.45 : 1;
  function similarity(a, b) {
    let dot = 0, aa = 0, bb = 0;
    for (const item of a) { const w = featureWeight(item); aa += w * w; if (b.has(item)) dot += w * w; }
    for (const item of b) { const w = featureWeight(item); bb += w * w; }
    return aa && bb ? dot / Math.sqrt(aa * bb) : 0;
  }
  const examples = SEMANTIC_PATTERNS.map((item) => ({ pattern: item, vectors: Object.values(item.examples).flat().map(features) }));
  function extractProtectedIdentifiers(value) {
    const text = String(value || "");
    const patterns = [
      /\b10\.\d{4,9}\/[\w.()/:+-]+/gu,
      /\b(?:[A-Z]\d{1,6}[A-Z*]|EctD|ectD|kcat|Km|OD600|DOI)\b/gu,
      /\b(?:BL21\(DE3\)|(?:ATCC|DSM|JCM|NCIMB|NCTC)[ -]?\d+|[A-Z]{1,4}_\d+(?:\.\d+)?|[A-Z]{1,3}\d{5,9}(?:\.\d+)?)\b/gu,
      /\b(?:[a-z]{2,8}[A-Z][A-Za-z0-9-]{0,8}|[A-Z][a-z]{1,7}[A-Z][A-Za-z0-9-]{0,8})\b/gu
    ];
    // The strain's closing parenthesis has no word boundary; capture separately.
    return unique([...patterns.flatMap((re) => [...text.matchAll(re)].map((match) => match[0].replace(/[.,;]+$/, ""))), ...[...text.matchAll(/\bBL21\(DE3\)/g)].map((match) => match[0])]);
  }
  function validateNode(value, schema, path = "ir") {
    if (schema.anyOf) {
      if (!schema.anyOf.some((candidate) => { try { validateNode(value, candidate, path); return true; } catch (_) { return false; } })) throw new Error(`${path}: invalid value`);
      return;
    }
    const valid = schema.type === "null" ? value === null : schema.type === "object" ? plain(value)
      : schema.type === "array" ? Array.isArray(value) : schema.type === "integer" ? Number.isInteger(value)
        : schema.type === "number" ? typeof value === "number" && Number.isFinite(value) : typeof value === schema.type;
    if (!valid) throw new Error(`${path}: expected ${schema.type}`);
    if (schema.enum && !schema.enum.includes(value)) throw new Error(`${path}: unrecognized value`);
    if (typeof value === "string" && (value.length < (schema.minLength || 0) || value.length > (schema.maxLength || Infinity))) throw new Error(`${path}: string length`);
    if (typeof value === "number" && (value < (schema.minimum ?? -Infinity) || value > (schema.maximum ?? Infinity))) throw new Error(`${path}: numeric bounds`);
    if (Array.isArray(value)) {
      if (value.length > schema.maxItems) throw new Error(`${path}: too many items`);
      value.forEach((item, index) => validateNode(item, schema.items, `${path}[${index}]`));
    }
    if (schema.type === "object") {
      for (const key of schema.required || []) if (!Object.hasOwn(value, key)) throw new Error(`${path}.${key}: required`);
      for (const key of Object.keys(value)) {
        if (!Object.hasOwn(schema.properties, key)) throw new Error(`${path}.${key}: unexpected field`);
        validateNode(value[key], schema.properties[key], `${path}.${key}`);
      }
    }
  }
  function validateSemanticIR(value, context = {}) {
    validateNode(value, SEMANTIC_IR_SCHEMA);
    const knownPattern = patternMap.get(value.matchedPattern);
    if (knownPattern && (value.patternConfidence < (context.thresholds?.known ?? DEFAULT_THRESHOLDS.known) || value.operations.some((operation) => ![...knownPattern.defaultOperations, ...knownPattern.allowedOperations].includes(operation)) || !patternCoversDomains(knownPattern, value.objects) || !knownPattern.objects.every((object) => value.objects.includes(object)))) throw new Error("Semantic IR forced an uncertain or compositional request into a narrow pattern");
    for (const marker of extractProtectedIdentifiers(context.query)) {
      if (!value.entities.some((item) => item.mention === marker && item.canonicalId === marker)) throw new Error("Semantic IR omitted or rewrote a protected identifier");
    }
    for (const item of value.entities) {
      if (extractProtectedIdentifiers(item.mention).includes(item.mention) && item.canonicalId !== item.mention) throw new Error("Semantic IR rewrote a protected identifier");
    }
    const active = context.activeScope || {};
    for (const [key, hardIds] of [["papers", active.paperIds], ["experiments", active.experimentSourceIds]]) {
      if (Array.isArray(hardIds) && hardIds.length && value.scope[key] !== null && (!Array.isArray(value.scope[key]) || value.scope[key].some((id) => !hardIds.includes(id)))) throw new Error("Semantic IR expanded the active source scope");
    }
    return JSON.parse(JSON.stringify(value));
  }
  function compactSemanticInput(input = {}) {
    const registry = plain(input.projectSemanticRegistry) ? input.projectSemanticRegistry : {};
    const active = plain(input.activeScope) ? input.activeScope : {};
    const scope = {};
    if (!active.topic && typeof active.currentTopic === "string") scope.topic = active.currentTopic.slice(0, 500);
    if (!scope.topic && typeof active.projectObjective === "string") scope.topic = active.projectObjective.slice(0, 500);
    for (const key of ["projectId", "primaryMetric", "topic"]) if (typeof active[key] === "string") scope[key] = active[key].slice(0, key === "topic" ? 500 : 120);
    for (const key of ["paperIds", "experimentSourceIds"]) if (Array.isArray(active[key])) scope[key] = unique(active[key].filter((id) => typeof id === "string").map((id) => id.slice(0, 256))).slice(0, 500);
    const semanticRegistry = {};
    if (typeof registry.version === "string" || typeof registry.version === "number") semanticRegistry.version = String(registry.version).slice(0, 80);
    for (const key of ["primaryMetric", "answerLanguage"]) if (typeof registry[key] === "string") semanticRegistry[key] = registry[key].slice(0, 120);
    for (const [key, id] of [["metrics", "canonicalField"], ["entities", "canonicalId"]]) {
      if (Array.isArray(registry[key])) semanticRegistry[key] = registry[key].slice(0, 40).filter((item) => plain(item) && typeof item[id] === "string").map((item) => ({ [id]: item[id].slice(0, 120), aliases: (Array.isArray(item.aliases) ? item.aliases : []).filter((alias) => typeof alias === "string").slice(0, 12).map((alias) => alias.slice(0, 120)) }));
    }
    if (!semanticRegistry.metrics && Array.isArray(active.knownMetrics)) semanticRegistry.metrics = active.knownMetrics.slice(0, 40).filter((field) => typeof field === "string").map((canonicalField) => ({ canonicalField: canonicalField.slice(0, 120), aliases: [] }));
    const conversation = typeof input.conversationContext === "string" ? [{ role: "user", content: input.conversationContext }] : Array.isArray(input.conversationContext) ? input.conversationContext : typeof input.conversationContext?.summary === "string" ? [{ role: "user", content: input.conversationContext.summary }] : [];
    return {
      query: String(input.query || "").slice(0, 20000),
      conversationContext: conversation.slice(-4).filter((item) => plain(item) && ["user", "assistant"].includes(item.role)).map((item) => ({ role: item.role, content: String(item.content || "").slice(0, 500) })),
      activeScope: scope, profile: ["light", "medium", "high"].includes(input.profile) ? input.profile : "light", projectSemanticRegistry: semanticRegistry
    };
  }
  function answerLanguagePreference(query, input) {
    const explicit = /(?:answer|reply|respond|write)\s+(?:me\s+)?in\s+(english|chinese|japanese|french|spanish)|用(中文|英文|英语|日文|法语|西班牙语)(?:回答|回复|写)/i.exec(query);
    const languageCodes = { english: "en", chinese: "zh", japanese: "ja", french: "fr", spanish: "es", 中文: "zh", 英文: "en", 英语: "en", 日文: "ja", 法语: "fr", 西班牙语: "es" };
    if (explicit) return languageCodes[normalized(explicit[1] || explicit[2])];
    if (input.projectSemanticRegistry.answerLanguage) return input.projectSemanticRegistry.answerLanguage;
    for (const item of [...input.conversationContext].reverse()) {
      if (item.role !== "user") continue;
      const preference = /(?:always|from now on).*?(?:answer|reply|respond)\s+in\s+(english|chinese)|(?:以后|一直).*?用(中文|英文|英语)/i.exec(item.content);
      if (preference) return languageCodes[normalized(preference[1] || preference[2])];
    }
    return null;
  }
  function answerLanguage(query, input) { return answerLanguagePreference(query, input) || detectLanguage(query); }
  function detectLanguage(query) {
    if (/[\u3040-\u30ff]/u.test(query)) return "ja";
    if (/[\u3400-\u9fff]/u.test(query)) return "zh";
    if (/[\uac00-\ud7af]/u.test(query)) return "ko";
    if (/[\u0400-\u04ff]/u.test(query)) return "ru";
    return "en";
  }
  function patternCoversDomains(pattern, domains) {
    return domains.every((domain) => pattern.objects.includes(domain) ||
      (["memory", "recommendation"].some((key) => pattern.objects.includes(key)) && ["experiments", "literature", "project"].includes(domain)));
  }
  function selectedPattern(queryFeatures, input, thresholds) {
    const domainFeatures = ["literature", "experiments", "memory", "recommendation", "project"].filter((key) => queryFeatures.has(key));
    const operations = OPERATIONS.filter((op) => queryFeatures.has(op));
    const scored = examples.map(({ pattern: p, vectors }) => {
      // Secondary mentions are evidence inputs for updating/explaining a decision,
      // but two independent requested domains/operations cannot fit a narrow recipe.
      const domainsCovered = patternCoversDomains(p, domainFeatures);
      const uncovered = operations.filter((op) => !p.allowedOperations.includes(op));
      const covered = domainsCovered && uncovered.length === 0 && (p.patternId !== "literature.corpus_synthesis" || queryFeatures.has("corpus")) && (p.patternId !== "literature.paper_qa" || !queryFeatures.has("corpus"));
      const score = Math.max(...vectors.map((vector) => similarity(queryFeatures, vector)));
      return { pattern: p, score, covered };
    }).sort((a, b) => b.score - a.score);
    const eligible = scored.filter((item) => item.covered);
    const best = eligible[0];
    const second = eligible[1]?.score || 0;
    const match = best && best.score >= thresholds.known && best.score - second >= thresholds.margin;
    return { pattern: match ? best.pattern : null, confidence: Number((match ? best.score : Math.min(scored[0]?.score || 0, thresholds.known - 0.01)).toFixed(4)), margin: best ? best.score - second : 0 };
  }
  function interpretLocal(rawInput = {}, options = {}) {
    if (typeof rawInput === "string") rawInput = { query: rawInput };
    const input = compactSemanticInput(rawInput);
    const query = input.query;
    const text = normalized(query);
    const f = features(query);
    const registry = input.projectSemanticRegistry;
    const primaryMetric = input.activeScope.primaryMetric || registry.primaryMetric || null;
    // Active experiment scope/objective can resolve the object, never invent the metric.
    if (f.has("rank") && (primaryMetric || input.activeScope.experimentSourceIds?.length)) f.add("experiments");
    const candidate = selectedPattern(f, input, { ...DEFAULT_THRESHOLDS, ...options.thresholds });
    const p = candidate.pattern;
    const corpusComposition = !p && f.has("corpus") && f.has("summarize") && f.has("literature");
    const entities = extractProtectedIdentifiers(query).map((id) => ({ type: /^[A-Z]\d+[A-Z*]$/.test(id) ? "mutation" : "identifier", canonicalId: id, mention: id }));
    const scientific = [...SCIENTIFIC_ENTITIES, ...(registry.entities || [])].sort((a, b) => Math.max(...b.aliases.map((alias) => alias.length)) - Math.max(...a.aliases.map((alias) => alias.length)));
    const coveredMentions = [];
    for (const entity of scientific) {
      const mention = entity.aliases.find((alias) => aliasPresent(text, alias) && !coveredMentions.some((known) => normalized(known).includes(normalized(alias))));
      if (mention && !entities.some((item) => item.canonicalId === entity.canonicalId)) { entities.push({ type: "scientific-entity", canonicalId: entity.canonicalId, mention: query.match(new RegExp(escaped(mention), "iu"))?.[0] || mention }); coveredMentions.push(mention); }
    }
    const metricAliases = { ...FIELD_ALIASES };
    for (const metric of registry.metrics || []) metricAliases[metric.canonicalField] = [metric.canonicalField, ...metric.aliases];
    const mentionedFields = Object.entries(metricAliases).filter(([, aliases]) => aliases.some((alias) => aliasPresent(text, alias))).map(([field]) => field);
    const explicitMetric = mentionedFields.find((field) => !["temperature", "culture_time", "ph", "od600"].includes(field));
    const rankMetric = explicitMetric && primaryMetric?.endsWith(`_${explicitMetric}`) ? primaryMetric : explicitMetric || primaryMetric;
    const direction = /\b(?:lowest|minimi[sz]e|smallest|least)\b|最低|最小/u.test(text) ? "minimize" : "maximize";
    const operations = unique([...OPERATIONS.filter((op) => f.has(op)), ...(p?.defaultOperations || []), ...(corpusComposition ? patternMap.get("literature.corpus_synthesis").defaultOperations : [])]);
    // A literature search in a ranking composition remains explicit.
    if (f.has("literature") && f.has("rank") && CONCEPT_ALIASES.search.some((alias) => aliasPresent(text, alias))) operations.push("search");
    const objects = unique([...["literature", "experiments", "memory", "recommendation", "project"].filter((key) => f.has(key)), ...(p?.objects || [])]);
    const filters = [], constraints = [];
    const year = /\b(before|prior to|after|since)\s+((?:19|20)\d{2})\b|((?:19|20)\d{2})\s*年?(之前|以前|以后|之后)/i.exec(query);
    if (year) filters.push({ field: "paper_year", operator: /after|since|以后|之后/.test(year[1] || year[4]) ? ">" : "<", value: Number(year[2] || year[3]), unit: null });
    const top = /\b(?:top|best|first)\s+(\d+|one|two|three|four|five|ten)\b|\b(\d+|five|ten)\s+(?:mutations|mutants|variants|sequences)\b|前([一二三四五六七八九十\d]+)(?:个|名)?/i.exec(query);
    const numbers = { one: 1, two: 2, three: 3, four: 4, five: 5, ten: 10, 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 };
    const limitText = top?.[1] || top?.[2] || top?.[3];
    const limit = limitText ? Math.min(100000, Math.max(1, Number(limitText) || numbers[normalized(limitText)] || 1)) : null;
    const temperature = /(?:less than|more than|above|below|within|under|over|<|>|小于|大于|超过|不超过|不到)\s*(\d+(?:\.\d+)?)\s*(?:°\s*C|℃|degrees?(?:\s+C)?|摄氏度)/i.exec(query);
    if (temperature && f.has("analyze-conditions")) {
      const delta = /differ|difference|差|相差/i.test(query);
      const excluded = /exclude|ignore|remove|排除|忽略/i.test(query);
      const isUpperExclusion = excluded && /more than|above|over|大于|超过/i.test(temperature[0]);
      constraints.push({ type: delta ? "maximum-difference" : "condition", field: delta ? "temperature_difference" : "temperature", operator: isUpperExclusion || /within|不超过/i.test(temperature[0]) ? "<=" : /less than|below|under|<|小于|不到/i.test(temperature[0]) ? "<" : ">", value: Number(temperature[1]), unit: "degC", description: temperature[0] });
    }
    const unresolvedSlots = [];
    if (operations.includes("rank") && !rankMetric) unresolvedSlots.push("ranking_metric");
    if (!objects.length) unresolvedSlots.push("target_object");
    if (!operations.length) unresolvedSlots.push("requested_operations");
    const ir = {
      version: SEMANTIC_SCHEMA_VERSION, inputLanguage: detectLanguage(query), answerLanguage: answerLanguage(query, input),
      matchedPattern: p?.patternId || null, patternConfidence: candidate.confidence,
      goal: query.trim().slice(0, 4000) || "Clarify the requested goal", operations: unique(operations), objects, entities,
      metrics: operations.includes("rank") ? [{ canonicalField: rankMetric, direction }] : mentionedFields.filter((field) => !["temperature", "culture_time"].includes(field)).map((field) => ({ canonicalField: field, direction: null })),
      scope: { papers: objects.includes("literature") ? (input.activeScope.paperIds?.length ? input.activeScope.paperIds : "current-project") : null, experiments: objects.includes("experiments") ? (input.activeScope.experimentSourceIds?.length ? input.activeScope.experimentSourceIds : "current-project") : null },
      filters, constraints, comparisonVariables: mentionedFields.filter((field) => ["temperature", "culture_time", "ph"].includes(field)),
      requestedOutput: { type: p?.output || (operations.includes("find-conflicts") ? "discrepancy-analysis" : operations.includes("rank") ? "ranked-comparison" : "open-response"), limit },
      capabilityHints: p ? [...p.requiredCapabilities] : corpusComposition ? ["corpus_workflow"] : [], unresolvedSlots
    };
    if (!p) ir.capabilityHints = planCapabilities(ir, { activeScope: input.activeScope }).steps.map((item) => item.capability);
    return validateSemanticIR(ir, { ...input, thresholds: options.thresholds });
  }
  function authorizeCapability(surface, capability) {
    const item = capabilityMap.get(capability);
    const allowedEffects = surface === "agent_command" ? EFFECTS.slice(0, 3) : EFFECTS.slice(0, 2);
    return { allowed: Boolean(item && allowedEffects.includes(item.effect)), effect: item?.effect || null };
  }
  function planCapabilities(ir, input = {}) {
    validateNode(ir, SEMANTIC_IR_SCHEMA);
    const p = patternMap.get(ir.matchedPattern);
    const requested = unique([...(p?.requiredCapabilities || []), ...ir.capabilityHints]);
    // Cover each requested (object, operation) with bounded existing capabilities.
    // Suggestions contain no arguments or code; the normal tool loop still selects
    // concrete calls and applies hard scope and authorization at execution time.
    if (!p) {
      for (const object of ir.objects) {
        const candidates = CAPABILITY_REGISTRY.filter((item) => item.supportsObjects.includes(object) && !item.hostOnly);
        const covered = new Set();
        for (const name of requested) { const cap = capabilityMap.get(name); if (cap?.supportsObjects.includes(object)) for (const op of cap.operations) covered.add(op); }
        for (const op of ir.operations) {
          if (covered.has(op)) continue;
          const candidate = candidates.filter((item) => item.operations.includes(op)).sort((a, b) => ir.operations.filter((operation) => b.operations.includes(operation)).length - ir.operations.filter((operation) => a.operations.includes(operation)).length)[0];
          if (candidate) { requested.push(candidate.capability); for (const operation of candidate.operations) covered.add(operation); }
        }
      }
    }
    const steps = unique(requested).map((capability) => {
      const item = capabilityMap.get(capability);
      const authorization = authorizeCapability(input.surface, capability);
      return { capability, tool: item.tool, hostOnly: item.hostOnly, operations: item.operations.filter((operation) => ir.operations.includes(operation)), effect: item.effect, allowed: authorization.allowed };
    });
    return { mode: p ? "known-pattern" : "compositional", pattern: p?.patternId || null, advisory: true, steps, blocked: steps.filter((step) => !step.allowed).map((step) => step.capability), unresolved: unique([...ir.unresolvedSlots, ...ir.operations.filter((op) => !steps.some((step) => capabilityMap.get(step.capability).operations.includes(op)) && !["explain", "summarize", "find-conflicts"].includes(op)).map((op) => `capability:${op}`)]) };
  }
  function stable(value) {
    if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
    if (plain(value)) return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stable(value[key])}`).join(",")}}`;
    return JSON.stringify(value);
  }
  class SemanticInterpreter {
    constructor(options = {}) { this.remoteParser = options.remoteParser; this.thresholds = { ...DEFAULT_THRESHOLDS, ...options.thresholds }; this.cache = new Map(); this.maxCacheEntries = 100; }
    interpretLocal(input) { return interpretLocal(input, { thresholds: this.thresholds }); }
    async interpret(rawInput = {}) {
      const input = compactSemanticInput(rawInput);
      // Exact case stays in the identity because EctD and ectD are distinct.
      const key = stable({ ...input, query: input.query.normalize("NFKC").replace(/\s+/g, " ").trim(), schema: SEMANTIC_SCHEMA_VERSION, patterns: PATTERN_LIBRARY_VERSION });
      const cached = this.cache.get(key);
      if (cached) return { ir: validateSemanticIR(cached, { ...input, thresholds: this.thresholds }), telemetry: this.telemetry(input, cached, cached, false, "cache", null) };
      const local = this.interpretLocal(input);
      const complex = local.objects.filter((object) => ["literature", "experiments", "memory", "recommendation"].includes(object)).length > 1 || local.constraints.length > 0 || local.operations.filter((op) => !["snapshot", "prepare", "map", "group", "reduce", "verify"].includes(op)).length >= 4;
      const needsRemote = input.profile !== "light" && (!local.matchedPattern || local.unresolvedSlots.length > 0 || complex || (input.profile === "high" && local.operations.length >= 3));
      const remoteParser = rawInput.remoteParser || this.remoteParser;
      let ir = local, used = false, route = "local", fallback = null;
      if (needsRemote && typeof remoteParser === "function") {
        used = true;
        try {
          const response = await remoteParser(input);
          ir = validateSemanticIR(response?.ir || response?.semanticIR || response, { ...input, thresholds: this.thresholds });
          // The current request/preference owns output language, not model whim.
          const explicitLanguage = answerLanguagePreference(input.query, input);
          const confidentlyEnglish = /\b(?:the|which|what|our|my|please|find|summari[sz]e|rank|why|compare|explain|review|update|search|show|read|write|do it)\b/i.test(input.query);
          ir.answerLanguage = explicitLanguage || (local.inputLanguage !== "en" || confidentlyEnglish ? local.answerLanguage : ir.inputLanguage);
          route = "remote";
        } catch (_) { route = "local-fallback"; fallback = "semantic-parser-unavailable-or-invalid"; }
      } else if (needsRemote) { route = "local-fallback"; fallback = "semantic-parser-unavailable"; }
      if (ir.matchedPattern && !ir.unresolvedSlots.length && route !== "local-fallback") {
        this.cache.set(key, ir);
        if (this.cache.size > this.maxCacheEntries) this.cache.delete(this.cache.keys().next().value);
      }
      return { ir, telemetry: this.telemetry(input, local, ir, used, route, fallback) };
    }
    telemetry(input, local, ir, used, route, fallback) {
      return { profile: input.profile, semantic: { localPattern: local.matchedPattern, localConfidence: local.patternConfidence, matchState: local.matchedPattern ? "known" : local.patternConfidence >= this.thresholds.uncertain ? "uncertain" : "novel", remoteSemanticParserUsed: used, finalPattern: ir.matchedPattern, route, fallback }, operations: [...ir.operations], capabilitiesUsed: [], capabilityHints: [...ir.capabilityHints], semanticParserCalls: used ? 1 : 0, cost: { semanticParserCalls: used ? 1 : 0 } };
    }
  }
  return Object.freeze({ SEMANTIC_SCHEMA_VERSION, PATTERN_LIBRARY_VERSION, DEFAULT_THRESHOLDS, EFFECTS, OPERATIONS, SEMANTIC_PATTERNS, PATTERN_LIBRARY: SEMANTIC_PATTERNS, CAPABILITY_REGISTRY, SCIENTIFIC_ENTITIES, FIELD_ALIASES, SEMANTIC_IR_SCHEMA, SemanticInterpreter, interpretLocal, validateSemanticIR, compactSemanticInput, extractProtectedIdentifiers, protectedIdentifiers: extractProtectedIdentifiers, authorizeCapability, planCapabilities });
});
