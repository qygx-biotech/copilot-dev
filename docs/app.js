const loginPanel = document.querySelector("#loginPanel");
const loginForm = document.querySelector("#loginForm");
const loginAccountInput = document.querySelector("#loginAccount");
const loginPasswordInput = document.querySelector("#loginPassword");
const loginButton = document.querySelector("#loginButton");
const loginError = document.querySelector("#loginError");
const appShell = document.querySelector("#appShell");
const currentAccountName = document.querySelector("#currentAccountName");
const logoutButton = document.querySelector("#logoutButton");
const backendStatusLabel = document.querySelector("#backendStatusLabel");
const languageSelects = document.querySelectorAll("[data-language-select]");

const projectContextInput = document.querySelector("#projectContext");
const referenceFileInput = document.querySelector("#referenceFileInput");
const referenceFileList = document.querySelector("#referenceFileList");
const clearReferencesButton = document.querySelector("#clearReferencesButton");
const experimentSummaryList = document.querySelector("#experimentSummaryList");
const experimentModuleCards = document.querySelectorAll("[data-experiment-module]");

const agentInstructionInput = document.querySelector("#agentInstruction");
const analyzeRecommendButton = document.querySelector("#analyzeRecommendButton");
const clearInstructionButton = document.querySelector("#clearInstructionButton");
const agentStatus = document.querySelector("#agentStatus");

const currentInterpretation = document.querySelector("#currentInterpretation");
const keyEvidenceUsed = document.querySelector("#keyEvidenceUsed");
const possibleExplanation = document.querySelector("#possibleExplanation");
const recommendedNextStep = document.querySelector("#recommendedNextStep");
const additionalAnalysisSuggested = document.querySelector("#additionalAnalysisSuggested");
const missingInformation = document.querySelector("#missingInformation");
const humanReviewNotes = document.querySelector("#humanReviewNotes");
const draftSummary = document.querySelector("#draftSummary");
const reviewStatus = document.querySelector("#reviewStatus");
const exportButton = document.querySelector("#exportButton");
const copyRecommendationButton = document.querySelector("#copyRecommendationButton");
const markReviewedButton = document.querySelector("#markReviewedButton");

const sideChatForm = document.querySelector("#sideChatForm");
const sideChatInput = document.querySelector("#sideChatInput");
const sideChatHistory = document.querySelector("#sideChatHistory");
const sideExampleButtons = document.querySelectorAll(".side-example-button");

const MAX_REFERENCE_FILES = 8;
const MAX_EXPERIMENT_FILES_PER_MODULE = 12;
const MAX_EXPERIMENT_FILES = 36;
const MAX_FILE_SIZE = 5 * 1024 * 1024;
const PER_FILE_TEXT_LIMIT = 12000;
const TOTAL_REFERENCE_TEXT_LIMIT = 26000;
const TOTAL_EXPERIMENT_TEXT_LIMIT = 26000;
const SPREADSHEET_SHEET_LIMIT = 6;
const PDF_PAGE_LIMIT = 12;
const SUPPORTED_DOCUMENT_EXTENSIONS = new Set([
  "pdf",
  "txt",
  "csv",
  "xlsx",
  "xls",
]);

const BACKEND_PROVIDER = "alibaba"; // "cloudflare" or "alibaba"
const CLOUDFLARE_WORKER_URL = "https://biodesign-copilot-worker.zhangjatsh666.workers.dev";
const ALIBABA_FC_URL = "https://biodesi-api-dev-jvvowibabk.cn-beijing.fcapp.run";
const WORKER_URL = BACKEND_PROVIDER === "alibaba" ? ALIBABA_FC_URL : CLOUDFLARE_WORKER_URL;
const USE_BACKEND = true;
const ACCESS_TOKEN_STORAGE_KEY = "access_token";
const ACCOUNT_STORAGE_KEY = "account";
const PROJECT_CONTEXT_STORAGE_KEY = "biodesign_workbench_project_context";
const EXPERIMENT_MODULES_STORAGE_KEY = "biodesign_workbench_experiment_modules";
const LEGACY_EXPERIMENT_NOTES_STORAGE_KEY = "biodesign_workbench_experiment_notes";
const RECOMMENDATION_STORAGE_KEY = "biodesign_workbench_recommendation";
const LANGUAGE_STORAGE_KEY = "biodesign_workbench_language";
const EXPERIMENT_MODULE_DEFINITIONS = [
  {
    key: "strainEngineering",
    titleKey: "strainEngineeringTitle",
  },
  {
    key: "fermentation",
    titleKey: "fermentationTitle",
  },
  {
    key: "downstreamProcessing",
    titleKey: "downstreamProcessingTitle",
  },
];
const EXPERIMENT_MODULE_KEYS = EXPERIMENT_MODULE_DEFINITIONS.map(
  (moduleDefinition) => moduleDefinition.key
);
const experimentModuleElements = Array.from(experimentModuleCards).reduce(
  (elements, card) => {
    const moduleKey = card.dataset.experimentModule;
    elements[moduleKey] = {
      card,
      count: card.querySelector("[data-module-count]"),
      fileInput: card.querySelector("[data-module-file-input]"),
      clearFilesButton: card.querySelector("[data-module-clear-files]"),
      fileList: card.querySelector("[data-module-file-list]"),
      noteField: card.querySelector("[data-module-note-field]"),
      addNoteButton: card.querySelector("[data-module-add-note]"),
      noteList: card.querySelector("[data-module-note-list]"),
    };
    return elements;
  },
  {}
);
const I18N = {
  en: {
    documentTitle: "BioDesign Workbench",
    languageLabel: "Language",
    loginTitle: "BioDesign Copilot",
    loginEyebrow: "Account Login",
    loginSubtitle: "Sign in to continue to the synthetic biology design workbench.",
    accountLabel: "Account",
    passwordLabel: "Password",
    loginButton: "Log In",
    loginBusy: "Logging in...",
    loginMissing: "Please enter account and password.",
    loginInvalid: "Incorrect account or password.",
    loginFailed: "Login failed. Please try again.",
    loginTokenMissing: "Login response is missing token.",
    loginAccountMissing: "Login response is missing account info.",
    sessionChecking: "Checking...",
    pleaseLogin: "Please sign in.",
    signedIn: "Signed in",
    notSignedIn: "Not signed in",
    loggedOut: "Signed out.",
    sessionExpired: "Session expired. Please sign in again.",
    waitLabel: "Please wait...",
    workspaceEyebrow: "Workspace",
    workbenchSubtitle:
      "Human-in-the-loop AI workspace for synthetic biology design, literature review, and experiment interpretation.",
    workbenchTitle: "BioDesign Workbench",
    logoutButton: "Logout",
    projectContextEyebrow: "Project Context",
    projectContextTitle: "Project context / goal",
    projectContextPlaceholder:
      "Describe the project goal in plain language, e.g. We are trying to improve a pathway, understand failed experiments, compare enzyme variants, or summarize recent literature.",
    referencesEyebrow: "Literature & References",
    referencesTitle: "Literature & References",
    uploadReferences: "Upload references",
    clearReferences: "Clear references",
    referencesHelper:
      "Files are processed locally for this MVP. Extracted text is sent to the backend only when you run the agent or ask a question.",
    experimentEyebrow: "Experiment Evidence",
    experimentTitle: "Experimental Results",
    uploadResults: "Upload results",
    clearExperimentFiles: "Clear experiment files",
    experimentHelper:
      "Upload evidence from different parts of the synthetic biology workflow.",
    strainEngineeringTitle: "Strain Engineering",
    strainEngineeringDescription:
      "Genetic design, construct screening, strain comparison, pathway engineering, enzyme variants, expression data.",
    fermentationTitle: "Fermentation",
    fermentationDescription:
      "Cultivation runs, media conditions, growth curves, titer/yield/productivity data, time-course measurements.",
    downstreamProcessingTitle: "Downstream Processing",
    downstreamProcessingDescription:
      "Separation, purification, extraction, recovery, product quality, process loss, analytics.",
    uploadModuleFiles: "Upload files",
    clearModuleFiles: "Clear files",
    moduleNotesLabel: "Optional notes",
    moduleNotesPlaceholder:
      "Add context for this module: what was tested, what changed, what looked surprising, or what the agent should focus on.",
    moduleSummary: "{module}: {files} files, {notes} notes",
    moduleCount: "{files} files · {notes} notes",
    noModuleFiles: "No files uploaded for this module yet.",
    noModuleNotes: "No notes added for this module yet.",
    moduleFilesCleared: "{module} files cleared.",
    addModuleNoteFirst: "Add a note for {module} first.",
    experimentNotesLabel: "Experiment notes",
    experimentNotesPlaceholder:
      "Add any context about these results: what was tested, what changed, what looked surprising, what you want the agent to focus on.",
    addNote: "Add note",
    agentEyebrow: "Agent Instruction",
    agentTitle: "Agent Instruction",
    agentPlaceholder:
      "Tell the agent what to do with the current references, experiment files, and notes. Example: Review all uploaded results and literature, identify what may explain the performance change, and recommend the next useful analysis or experiment direction.",
    analyzeRecommend: "Analyze & Recommend",
    clearInstruction: "Clear Instruction",
    recommendationEyebrow: "Current Output",
    recommendationTitle: "Current recommendation",
    exportMarkdown: "Export Markdown",
    copyRecommendation: "Copy Recommendation",
    markReviewed: "Mark as Reviewed",
    humanReviewRequired: "Human review required",
    reviewedByHuman: "Reviewed by human",
    currentInterpretationHeading: "Current Interpretation",
    keyEvidenceHeading: "Key Evidence Used",
    possibleExplanationHeading: "Cross-Module Assessment",
    recommendedNextStepHeading: "Recommended Next Step",
    additionalAnalysisHeading: "Module Most Relevant to Next Step",
    missingInformationHeading: "Missing Information",
    humanReviewHeading: "Human Review Notes",
    draftSummaryHeading: "Draft Summary",
    sideChatEyebrow: "Side Chat",
    sideChatTitle: "Side Chat",
    sideChatHelper: "Ask questions without changing the current recommendation.",
    sideExampleFiles: "Summarize the uploaded files.",
    sideExamplePatterns: "What patterns do you see in the experiment sheets?",
    sideExamplePaper: "What does this paper suggest?",
    sideExampleClarify: "What should I clarify before running the main analysis?",
    sideQuestionLabel: "Side question",
    sideChatPlaceholder: "Ask a question without updating the project plan...",
    askButton: "Ask",
    backendProviderAlibaba: "Alibaba FC backend",
    backendProviderCloudflare: "Cloudflare Worker backend",
    backendReady: "Ready",
    backendConnected: "Connected",
    backendWorking: "Working",
    backendFallback: "Fallback",
    backendFallbackMessage:
      "I could not reach the BioDesign Copilot backend, so I generated a local demo response instead.",
    noReferenceFiles: "No reference files uploaded yet.",
    noExperimentFiles: "No experiment files uploaded yet.",
    noExperimentNotes: "No experiment notes added yet.",
    referencesCleared: "References cleared.",
    experimentFilesCleared: "Experiment files cleared.",
    addExperimentNoteFirst: "Add an experiment note first.",
    tellAgentFirst: "Tell the agent what to analyze first.",
    recommendationExported: "Recommendation exported as Markdown.",
    recommendationCopied: "Recommendation copied.",
    agentReviewing: "Agent is reviewing inputs...",
    recommendationUpdated: "Recommendation updated. Scientist review required.",
    sideChatIntro: "Ask questions here without changing the current recommendation.",
    sideChatNoAnswer: "No side-chat answer returned.",
    fileLimit: "Only {count} files can be attached in this MVP.",
    fileAdded: "Added {name}.",
    fileUnsupported: "Unsupported file type: {name}",
    fileTooLarge: "File exceeds the 5 MB limit: {name}",
    fileNoText: "No text could be extracted from {name}.",
    fileReadFailed: "Unable to read {name}.",
    fileParseFailed: "Could not parse {name}.",
    excelParserMissing: "Excel parser is not loaded.",
    pdfParserMissing: "PDF parser is not loaded.",
    chars: "chars",
    truncated: "truncated",
    remove: "Remove",
    experimentNoteTitle: "Experiment note",
    removeNote: "Remove note",
    unknownTime: "Unknown time",
    responseLanguageInstruction: "Respond in English.",
    defaultTitle: "BioDesign Workbench Recommendation",
    notProvided: "Not provided.",
    notAvailable: "Not available.",
    sideChatUserLabel: "You",
    sideChatAssistantLabel: "Workbench side chat",
    backendDisabled: "Backend disabled.",
    backendReturned: "Backend returned {status}",
    backendMissingPayload: "Backend response is missing reply and project data.",
    backendLimitedResponse: "Backend returned a limited response.",
    defaultCurrentInterpretation:
      "No main analysis has been run yet. Add optional project context, upload evidence, then use Analyze & Recommend.",
    defaultKeyEvidence: "No evidence selected yet.",
    defaultPossibleExplanation:
      "A cross-module assessment will appear after the agent reviews strain engineering, fermentation, downstream processing, and reference evidence.",
    defaultRecommendedNextStep:
      "Add references, experiment files, or notes, then give the agent a clear instruction.",
    defaultAdditionalAnalysis:
      "The module most relevant to the next step will appear after the main agent action.",
    defaultHumanReview:
      "AI-generated recommendations require scientist review before experimental use.",
    defaultDraftSummary:
      "A draft summary will appear after Analyze & Recommend. This MVP keeps workspace state in the browser session only.",
    fallbackCurrentInterpretation:
      "The workspace contains browser-session evidence that may include literature, spreadsheets, result files, and informal notes. Because the backend was unavailable, this is a local demo interpretation.",
    fallbackPossibleExplanation:
      "Treat any cross-module explanation as a hypothesis until the scientist reviews whether strain engineering, fermentation, and downstream processing files are comparable.",
    fallbackRecommendedNextStep:
      "Run a focused evidence review: align uploaded result sheets with the project context, identify the strongest pattern or discrepancy, then decide which analysis or experiment direction deserves human review.",
    fallbackAdditionalAnalysis:
      "Most relevant module cannot be determined confidently in local fallback mode. Compare module evidence and missing metadata before choosing the next focus.",
    normalizedCurrentInterpretation:
      "The available evidence needs scientist review before a confident interpretation can be made.",
    normalizedPossibleExplanation:
      "Several explanations may be plausible across strain engineering, fermentation, and downstream processing. Compare uploaded literature, result patterns, and notes before selecting one working hypothesis.",
    normalizedRecommendedNextStep:
      "Choose one clear follow-up analysis or planning-level experiment direction for human review.",
    normalizedAdditionalAnalysis:
      "Identify whether the next useful step belongs in strain engineering, fermentation, downstream processing, or additional analysis after reviewing the source files.",
    normalizedHumanReview:
      "Human scientists remain responsible for interpreting evidence and approving any experimental decisions.",
    evidenceReference: "Reference: {name}",
    evidenceExperimentFile: "Experiment file ({module}): {name}",
    evidenceExperimentNote: "Experiment note ({module}): {note}",
    noEvidenceIncluded: "No uploaded evidence was included.",
    missingProjectContext: "Project context or goal",
    missingReferenceEvidence: "Literature or reference evidence",
    missingExperimentEvidence: "Experiment result files or notes",
    noMajorGaps: "No major gaps identified from current browser-session context.",
    projectContextPromptHeading: "Project context / goal:",
    evidenceSummaryHeading: "Available evidence summary:",
    evidenceReferenceFilesLine: "- reference files: {value}",
    evidenceExperimentFilesLine: "- experiment files: {value}",
    evidenceExperimentNotesLine: "- experiment notes: {value}",
    evidenceExperimentModuleLine: "- {module}: {files}; notes: {notes}",
    noneValue: "none",
    localSideChatReply:
      "Planning-level answer: {question} should be interpreted against the project context and uploaded evidence. Treat this as a discussion aid, not an update to the current recommendation.",
    markdownProjectContextHeading: "Project Context / Goal",
    markdownCurrentInterpretationHeading: "Current Interpretation",
    markdownKeyEvidenceHeading: "Key Evidence Used",
    markdownPossibleExplanationHeading: "Cross-Module Assessment",
    markdownRecommendedNextStepHeading: "Recommended Next Step",
    markdownAdditionalAnalysisHeading: "Module Most Relevant to Next Step",
    markdownMissingInformationHeading: "Missing Information",
    markdownHumanReviewHeading: "Human Review Notes",
    markdownDraftSummaryHeading: "Draft Summary",
    localSummaryTitle: "Draft Summary",
    localSummaryProjectContext: "Project context:",
    localSummaryInstruction: "Instruction:",
    localSummaryInterpretationNote: "Interpretation note:",
    localSummaryRecommendedNextStep: "Recommended next step:",
    localSummaryRecommendedNextStepText:
      "Review the uploaded evidence, identify the most plausible explanation or uncertainty, and select one next analysis or experiment direction for scientist review.",
    localSummaryHumanReview: "Human review:",
  },
  zh: {
    documentTitle: "BioDesign Workbench | 生物设计工作台",
    languageLabel: "语言",
    loginTitle: "BioDesign Copilot",
    loginEyebrow: "账户登录",
    loginSubtitle: "登录后继续使用合成生物学设计工作台。",
    accountLabel: "账号",
    passwordLabel: "密码",
    loginButton: "登录",
    loginBusy: "登录中...",
    loginMissing: "请输入账号和密码。",
    loginInvalid: "账号或密码不正确。",
    loginFailed: "登录失败，请稍后重试。",
    loginTokenMissing: "登录响应缺少 token。",
    loginAccountMissing: "登录响应缺少账户信息。",
    sessionChecking: "检查中...",
    pleaseLogin: "请先登录。",
    signedIn: "已登录",
    notSignedIn: "未登录",
    loggedOut: "已退出登录。",
    sessionExpired: "登录状态已失效，请重新登录。",
    waitLabel: "请稍候...",
    workspaceEyebrow: "工作区",
    workbenchSubtitle:
      "面向合成生物学设计、文献评审和实验结果解读的人机协同 AI 工作台。",
    workbenchTitle: "BioDesign 工作台",
    logoutButton: "退出登录",
    projectContextEyebrow: "项目背景",
    projectContextTitle: "项目背景 / 目标",
    projectContextPlaceholder:
      "用自然语言描述项目目标，例如：我们想改进某条通路、理解失败实验、比较酶变体，或总结近期文献。",
    referencesEyebrow: "文献与参考资料",
    referencesTitle: "文献与参考资料",
    uploadReferences: "上传参考资料",
    clearReferences: "清空参考资料",
    referencesHelper:
      "本 MVP 会在浏览器本地处理文件。只有在运行智能体或提问时，提取出的文本才会发送到后端。",
    experimentEyebrow: "实验证据",
    experimentTitle: "实验结果",
    uploadResults: "上传结果文件",
    clearExperimentFiles: "清空实验文件",
    experimentHelper:
      "上传合成生物学工作流不同环节产生的证据。",
    strainEngineeringTitle: "菌株工程",
    strainEngineeringDescription:
      "遗传设计、构建筛选、菌株比较、通路工程、酶变体、表达数据。",
    fermentationTitle: "发酵",
    fermentationDescription:
      "培养运行、培养基条件、生长曲线、滴度/得率/生产强度数据、时间序列测量。",
    downstreamProcessingTitle: "下游处理",
    downstreamProcessingDescription:
      "分离、纯化、提取、回收、产品质量、工艺损失、分析检测。",
    uploadModuleFiles: "上传文件",
    clearModuleFiles: "清空文件",
    moduleNotesLabel: "可选备注",
    moduleNotesPlaceholder:
      "补充该模块的背景：测试了什么、改变了什么、哪些现象令人意外、希望智能体重点关注什么。",
    moduleSummary: "{module}：{files} 个文件，{notes} 条备注",
    moduleCount: "{files} 个文件 · {notes} 条备注",
    noModuleFiles: "该模块尚未上传文件。",
    noModuleNotes: "该模块尚未添加备注。",
    moduleFilesCleared: "已清空{module}文件。",
    addModuleNoteFirst: "请先为{module}添加备注。",
    experimentNotesLabel: "实验备注",
    experimentNotesPlaceholder:
      "补充这些结果的背景：测试了什么、改变了什么、哪些现象令人意外、希望智能体重点关注什么。",
    addNote: "添加备注",
    agentEyebrow: "智能体指令",
    agentTitle: "智能体指令",
    agentPlaceholder:
      "告诉智能体如何处理当前参考资料、实验文件和备注。例如：评审所有上传结果和文献，判断性能变化的可能原因，并推荐下一步有用的分析或实验方向。",
    analyzeRecommend: "分析并推荐",
    clearInstruction: "清空指令",
    recommendationEyebrow: "当前输出",
    recommendationTitle: "当前推荐",
    exportMarkdown: "导出 Markdown",
    copyRecommendation: "复制推荐",
    markReviewed: "标记已审阅",
    humanReviewRequired: "需要人工审阅",
    reviewedByHuman: "已人工审阅",
    currentInterpretationHeading: "当前解读",
    keyEvidenceHeading: "使用的关键证据",
    possibleExplanationHeading: "跨模块评估",
    recommendedNextStepHeading: "推荐下一步",
    additionalAnalysisHeading: "下一步最相关模块",
    missingInformationHeading: "缺失信息",
    humanReviewHeading: "人工审阅说明",
    draftSummaryHeading: "摘要草稿",
    sideChatEyebrow: "侧边问答",
    sideChatTitle: "侧边问答",
    sideChatHelper: "在不改变当前推荐的情况下提问。",
    sideExampleFiles: "总结已上传的文件。",
    sideExamplePatterns: "你在实验表格里看到了什么模式？",
    sideExamplePaper: "这篇论文提示了什么？",
    sideExampleClarify: "运行主分析前我应该澄清什么？",
    sideQuestionLabel: "侧边问题",
    sideChatPlaceholder: "提出一个不会更新项目计划的问题...",
    askButton: "提问",
    backendProviderAlibaba: "阿里云 FC 后端",
    backendProviderCloudflare: "Cloudflare Worker 后端",
    backendReady: "就绪",
    backendConnected: "已连接",
    backendWorking: "处理中",
    backendFallback: "本地回退",
    backendFallbackMessage:
      "我无法连接 BioDesign Copilot 后端，因此先生成了一份本地演示回复。",
    noReferenceFiles: "尚未上传参考资料。",
    noExperimentFiles: "尚未上传实验文件。",
    noExperimentNotes: "尚未添加实验备注。",
    referencesCleared: "已清空参考资料。",
    experimentFilesCleared: "已清空实验文件。",
    addExperimentNoteFirst: "请先添加实验备注。",
    tellAgentFirst: "请先告诉智能体要分析什么。",
    recommendationExported: "推荐内容已导出为 Markdown。",
    recommendationCopied: "推荐内容已复制。",
    agentReviewing: "智能体正在审阅输入...",
    recommendationUpdated: "推荐已更新，仍需科学家审阅。",
    sideChatIntro: "在这里提问不会改变当前推荐。",
    sideChatNoAnswer: "侧边问答没有返回内容。",
    fileLimit: "本 MVP 最多可附加 {count} 个文件。",
    fileAdded: "已添加 {name}。",
    fileUnsupported: "不支持的文件类型：{name}",
    fileTooLarge: "文件超过 5 MB 限制：{name}",
    fileNoText: "无法从文件中提取文本：{name}。",
    fileReadFailed: "无法读取文件：{name}。",
    fileParseFailed: "无法解析文件：{name}。",
    excelParserMissing: "Excel 解析库未加载。",
    pdfParserMissing: "PDF 解析库未加载。",
    chars: "字符",
    truncated: "已截断",
    remove: "移除",
    experimentNoteTitle: "实验备注",
    removeNote: "删除备注",
    unknownTime: "未知时间",
    responseLanguageInstruction: "请用简体中文回答。",
    defaultTitle: "BioDesign Workbench 推荐",
    notProvided: "未提供。",
    notAvailable: "暂无。",
    sideChatUserLabel: "你",
    sideChatAssistantLabel: "工作台侧边问答",
    backendDisabled: "后端已禁用。",
    backendReturned: "后端返回 {status}",
    backendMissingPayload: "后端响应缺少回复或项目数据。",
    backendLimitedResponse: "后端只返回了有限内容。",
    defaultCurrentInterpretation:
      "尚未运行主分析。可以先补充项目背景、上传证据，然后点击“分析并推荐”。",
    defaultKeyEvidence: "尚未选择证据。",
    defaultPossibleExplanation:
      "智能体审阅菌株工程、发酵、下游处理和参考资料后，会在这里给出跨模块评估。",
    defaultRecommendedNextStep:
      "添加参考资料、实验文件或备注，然后给智能体一个清晰指令。",
    defaultAdditionalAnalysis:
      "运行主智能体动作后，这里会显示下一步最相关模块。",
    defaultHumanReview:
      "AI 生成的建议在用于实验前必须经过科学家审阅。",
    defaultDraftSummary:
      "点击“分析并推荐”后会生成摘要草稿。本 MVP 仅在浏览器会话中保存工作区状态。",
    fallbackCurrentInterpretation:
      "工作区中包含浏览器会话内的证据，可能包括文献、表格、结果文件和非正式备注。由于后端不可用，这是一份本地演示解读。",
    fallbackPossibleExplanation:
      "任何跨模块解释都应先视为假设，直到科学家确认菌株工程、发酵和下游处理文件之间是否可比。",
    fallbackRecommendedNextStep:
      "先进行一次聚焦的证据评审：将上传结果表与项目背景对齐，找出最强模式或差异，再决定哪一项分析或实验方向值得人工审阅。",
    fallbackAdditionalAnalysis:
      "本地回退模式下无法可靠判断最相关模块。请先比较各模块证据和缺失元数据，再选择下一步重点。",
    normalizedCurrentInterpretation:
      "在形成可靠解读前，当前证据仍需要科学家审阅。",
    normalizedPossibleExplanation:
      "可能存在跨菌株工程、发酵和下游处理的多种解释。请先对比上传文献、结果模式和备注，再选择一个工作假设。",
    normalizedRecommendedNextStep:
      "选择一个清晰的后续分析或规划层面的实验方向，交由人工审阅。",
    normalizedAdditionalAnalysis:
      "审阅源文件后，判断下一步应聚焦菌株工程、发酵、下游处理，还是先做补充分析。",
    normalizedHumanReview:
      "科学家仍需负责解释证据，并批准任何实验决策。",
    evidenceReference: "参考资料：{name}",
    evidenceExperimentFile: "实验文件（{module}）：{name}",
    evidenceExperimentNote: "实验备注（{module}）：{note}",
    noEvidenceIncluded: "未包含上传证据。",
    missingProjectContext: "项目背景或目标",
    missingReferenceEvidence: "文献或参考证据",
    missingExperimentEvidence: "实验结果文件或备注",
    noMajorGaps: "基于当前浏览器会话内容，暂未发现主要缺口。",
    projectContextPromptHeading: "项目背景 / 目标：",
    evidenceSummaryHeading: "可用证据摘要：",
    evidenceReferenceFilesLine: "- 参考资料：{value}",
    evidenceExperimentFilesLine: "- 实验文件：{value}",
    evidenceExperimentNotesLine: "- 实验备注：{value}",
    evidenceExperimentModuleLine: "- {module}：{files}；备注：{notes}",
    noneValue: "无",
    localSideChatReply:
      "规划层面的回答：{question} 应结合项目背景和上传证据来理解。请把它作为讨论辅助，而不是对当前推荐的更新。",
    markdownProjectContextHeading: "项目背景 / 目标",
    markdownCurrentInterpretationHeading: "当前解读",
    markdownKeyEvidenceHeading: "使用的关键证据",
    markdownPossibleExplanationHeading: "跨模块评估",
    markdownRecommendedNextStepHeading: "推荐下一步",
    markdownAdditionalAnalysisHeading: "下一步最相关模块",
    markdownMissingInformationHeading: "缺失信息",
    markdownHumanReviewHeading: "人工审阅说明",
    markdownDraftSummaryHeading: "摘要草稿",
    localSummaryTitle: "摘要草稿",
    localSummaryProjectContext: "项目背景：",
    localSummaryInstruction: "指令：",
    localSummaryInterpretationNote: "解读说明：",
    localSummaryRecommendedNextStep: "推荐下一步：",
    localSummaryRecommendedNextStepText:
      "审阅上传证据，识别最可能的解释或不确定性，并选择一个下一步分析或实验方向交由科学家审阅。",
    localSummaryHumanReview: "人工审阅：",
  },
};

let currentLanguage = normalizeLanguage(readStoredLanguage() || navigator.language);
let lastBackendStatus = "backendReady";

let authToken = sessionStorage.getItem(ACCESS_TOKEN_STORAGE_KEY) || "";
let currentAccount = sessionStorage.getItem(ACCOUNT_STORAGE_KEY) || "";
let projectContext = sessionStorage.getItem(PROJECT_CONTEXT_STORAGE_KEY) || "";
let referenceDocuments = [];
let experimentModules = loadExperimentModules();
let currentRecommendation = loadSessionJson(
  RECOMMENDATION_STORAGE_KEY,
  createDefaultRecommendation()
);
let sideChatMessages = [];
let activeAgentRequest = false;

class AuthRequiredError extends Error {
  constructor(message) {
    super(message);
    this.name = "AuthRequiredError";
  }
}

languageSelects.forEach((select) => {
  select.addEventListener("change", () => setLanguage(select.value));
});

initializeWorkbench();
checkCurrentUser();

loginForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  loginError.textContent = "";

  const account = loginAccountInput.value.trim();

  if (!account || !loginPasswordInput.value) {
    loginError.textContent = t("loginMissing");
    return;
  }

  setLoginBusy(true, t("loginBusy"));

  try {
    const loginRequest = fetch(backendUrl("/api/login"), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        account,
        password: loginPasswordInput.value,
      }),
    });

    loginPasswordInput.value = "";

    const response = await loginRequest;
    const data = await readOptionalJson(response);

    if (response.status === 401) {
      showLoggedOut(t("loginInvalid"));
      return;
    }

    if (!response.ok) {
      throw new Error(getAuthErrorMessage(data) || t("loginFailed"));
    }

    const loggedInAccount =
      typeof data.user?.account === "string" ? data.user.account.trim() : "";

    if (typeof data.token !== "string" || !data.token) {
      throw new Error(t("loginTokenMissing"));
    }

    if (!loggedInAccount) {
      throw new Error(t("loginAccountMissing"));
    }

    setAuthSession(data.token, loggedInAccount);
    showAuthenticated(loggedInAccount);
  } catch (error) {
    console.warn("Login failed.", error);
    showLoggedOut(error.message || t("loginFailed"));
  } finally {
    loginPasswordInput.value = "";
    setLoginBusy(false);
  }
});

logoutButton.addEventListener("click", () => {
  clearAuthSession();
  showLoggedOut(t("loggedOut"));
});

projectContextInput.addEventListener("input", () => {
  projectContext = projectContextInput.value.trim();
  sessionStorage.setItem(PROJECT_CONTEXT_STORAGE_KEY, projectContext);
});

referenceFileInput.addEventListener("change", async (event) => {
  await handleDocumentFiles({
    files: Array.from(event.target.files || []),
    collection: referenceDocuments,
    maxFiles: MAX_REFERENCE_FILES,
    onUpdate(nextDocuments) {
      referenceDocuments = nextDocuments;
      renderDocumentList(
        referenceFileList,
        referenceDocuments,
        t("noReferenceFiles"),
        removeReferenceDocument
      );
    },
  });
  referenceFileInput.value = "";
});

clearReferencesButton.addEventListener("click", () => {
  referenceDocuments = [];
  renderDocumentList(
    referenceFileList,
    referenceDocuments,
    t("noReferenceFiles"),
    removeReferenceDocument
  );
  showToast(t("referencesCleared"));
});

EXPERIMENT_MODULE_KEYS.forEach((moduleKey) => {
  const elements = experimentModuleElements[moduleKey];
  if (!elements) return;

  elements.fileInput.addEventListener("change", async (event) => {
    await handleDocumentFiles({
      files: Array.from(event.target.files || []),
      collection: experimentModules[moduleKey].files,
      maxFiles: MAX_EXPERIMENT_FILES_PER_MODULE,
      moduleKey,
      onUpdate(nextDocuments) {
        experimentModules[moduleKey].files = nextDocuments;
        renderExperimentModule(moduleKey);
      },
    });
    elements.fileInput.value = "";
  });

  elements.clearFilesButton.addEventListener("click", () => {
    experimentModules[moduleKey].files = [];
    renderExperimentModule(moduleKey);
    showToast(t("moduleFilesCleared", { module: getExperimentModuleLabel(moduleKey) }));
  });

  elements.addNoteButton.addEventListener("click", () => {
    const noteText = elements.noteField.value.trim();

    if (!noteText) {
      showToast(t("addModuleNoteFirst", { module: getExperimentModuleLabel(moduleKey) }));
      elements.noteField.focus();
      return;
    }

    experimentModules[moduleKey].notes.unshift({
      id: makeId(),
      createdAt: new Date().toISOString(),
      text: noteText,
      module: moduleKey,
    });
    saveExperimentModules();
    renderExperimentModule(moduleKey);
    elements.noteField.value = "";
  });
});

analyzeRecommendButton.addEventListener("click", () => {
  const instruction = agentInstructionInput.value.trim();

  if (!instruction) {
    showToast(t("tellAgentFirst"));
    agentInstructionInput.focus();
    return;
  }

  runAgentInstruction(instruction);
});

clearInstructionButton.addEventListener("click", () => {
  agentInstructionInput.value = "";
  agentInstructionInput.focus();
});

sideExampleButtons.forEach((button) => {
  button.addEventListener("click", () => {
    sideChatInput.value = button.textContent.trim();
    sideChatInput.focus();
  });
});

sideChatForm.addEventListener("submit", async (event) => {
  event.preventDefault();

  const question = sideChatInput.value.trim();
  if (!question) return;

  const messagesForBackend = buildSideChatMessages(question);
  sideChatInput.value = "";
  addSideChatMessage("user", question);
  sideChatMessages.push({ role: "user", content: question });

  try {
    const response = await sendWorkbenchRequest({
      mode: "side_chat",
      messages: messagesForBackend,
    });
    const reply = response.reply || t("sideChatNoAnswer");
    addSideChatMessage("assistant", reply);
    sideChatMessages.push({ role: "assistant", content: reply });
  } catch (error) {
    if (error instanceof AuthRequiredError) {
      console.warn("Backend auth required.", error);
      return;
    }

    console.warn("Side chat backend failed; using local fallback.", error);
    const reply = `${t("backendFallbackMessage")}\n\n${buildLocalSideChatReply(question)}`;
    addSideChatMessage("assistant", reply);
    sideChatMessages.push({ role: "assistant", content: reply });
  }
});

exportButton.addEventListener("click", () => {
  const markdown = buildMarkdownExport(currentRecommendation);
  const blob = new Blob([markdown], { type: "text/markdown;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");

  link.href = url;
  link.download = "biodesign-workbench-recommendation.md";
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
  showToast(t("recommendationExported"));
});

copyRecommendationButton.addEventListener("click", async () => {
  await copyText(buildMarkdownExport(currentRecommendation));
  showToast(t("recommendationCopied"));
});

markReviewedButton.addEventListener("click", () => {
  currentRecommendation = {
    ...currentRecommendation,
    reviewed: true,
    reviewedAt: new Date().toISOString(),
  };
  saveCurrentRecommendation();
  renderRecommendation();
});

function initializeWorkbench() {
  projectContextInput.value = projectContext;
  applyLanguage();
  renderBackendStatus("backendReady");
  renderDocumentList(
    referenceFileList,
    referenceDocuments,
    t("noReferenceFiles"),
    removeReferenceDocument
  );
  renderExperimentModules();
  renderRecommendation();
  sideChatHistory.innerHTML = "";
  addSideChatMessage(
    "assistant",
    t("sideChatIntro")
  );
}

async function checkCurrentUser() {
  if (!authToken) {
    showLoggedOut("");
    return;
  }

  setLoginBusy(true, t("sessionChecking"));

  try {
    const response = await fetch(backendUrl("/api/me"), {
      method: "GET",
      headers: getAuthHeaders(),
    });
    const data = await readOptionalJson(response);

    if (response.status === 401) {
      showLoggedOut(t("pleaseLogin"));
      return;
    }

    if (!response.ok) {
      showLoggedOut("");
      return;
    }

    const accountName = getAccountName(data) || currentAccount || t("signedIn");
    if (accountName !== t("signedIn")) {
      setAuthSession(authToken, accountName);
    }
    showAuthenticated(accountName);
    renderBackendStatus("backendConnected");
  } catch (error) {
    console.warn("Session check failed.", error);
    showLoggedOut("");
  } finally {
    setLoginBusy(false);
  }
}

function showAuthenticated(accountName) {
  currentAccountName.textContent = accountName || t("signedIn");
  loginError.textContent = "";
  loginPasswordInput.value = "";
  loginPanel.hidden = true;
  loginPanel.classList.add("is-hidden");
  appShell.hidden = false;
  appShell.classList.remove("is-hidden");
  projectContextInput.focus();
}

function showLoggedOut(message) {
  clearAuthSession();
  currentAccountName.textContent = t("notSignedIn");
  appShell.hidden = true;
  appShell.classList.add("is-hidden");
  loginPanel.hidden = false;
  loginPanel.classList.remove("is-hidden");
  loginPasswordInput.value = "";
  loginError.textContent = message || "";
  loginAccountInput.focus();
}

function setLoginBusy(isBusy, label = t("waitLabel")) {
  loginAccountInput.disabled = isBusy;
  loginPasswordInput.disabled = isBusy;
  loginButton.disabled = isBusy;
  loginButton.textContent = isBusy ? label : t("loginButton");
}

function t(key, variables = {}) {
  const dictionary = I18N[currentLanguage] || I18N.en;
  const template = dictionary[key] || I18N.en[key] || key;

  return Object.entries(variables).reduce(
    (text, [name, value]) => text.replaceAll(`{${name}}`, String(value)),
    template
  );
}

function normalizeLanguage(value) {
  return String(value || "").toLowerCase().startsWith("zh") ? "zh" : "en";
}

function readStoredLanguage() {
  let sessionLanguage = "";
  let localLanguage = "";

  try {
    sessionLanguage = sessionStorage.getItem(LANGUAGE_STORAGE_KEY) || "";
  } catch {
    sessionLanguage = "";
  }

  try {
    localLanguage = window.localStorage?.getItem(LANGUAGE_STORAGE_KEY) || "";
  } catch {
    localLanguage = "";
  }

  return sessionLanguage || localLanguage;
}

function writeStoredLanguage(language) {
  try {
    sessionStorage.setItem(LANGUAGE_STORAGE_KEY, language);
  } catch {
    // Language switching still works for the current page if storage is unavailable.
  }

  try {
    window.localStorage?.setItem(LANGUAGE_STORAGE_KEY, language);
  } catch {
    // Language switching still works for the current page if storage is unavailable.
  }
}

function setLanguage(language) {
  const nextLanguage = normalizeLanguage(language);
  if (nextLanguage === currentLanguage) return;

  currentLanguage = nextLanguage;
  writeStoredLanguage(currentLanguage);
  applyLanguage();
}

function applyLanguage() {
  document.documentElement.lang = currentLanguage === "zh" ? "zh-CN" : "en";
  document.title = t("documentTitle");

  languageSelects.forEach((select) => {
    select.value = currentLanguage;
  });

  document.querySelectorAll("[data-i18n]").forEach((element) => {
    element.textContent = t(element.dataset.i18n);
  });

  document.querySelectorAll("[data-i18n-placeholder]").forEach((element) => {
    element.setAttribute("placeholder", t(element.dataset.i18nPlaceholder));
  });

  if (currentRecommendation && !currentRecommendation.updatedAt) {
    currentRecommendation = createDefaultRecommendation();
    saveCurrentRecommendation();
  }

  renderBackendStatus();
  renderDocumentList(
    referenceFileList,
    referenceDocuments,
    t("noReferenceFiles"),
    removeReferenceDocument
  );
  renderExperimentModules();
  renderRecommendation();

  if (!sideChatMessages.length && sideChatHistory.childElementCount <= 1) {
    sideChatHistory.innerHTML = "";
    addSideChatMessage("assistant", t("sideChatIntro"));
  }
}

function requireLoginForUnauthorized(response) {
  if (response.status !== 401) return;

  const message = t("sessionExpired");
  clearAuthSession();
  showLoggedOut(message);
  throw new AuthRequiredError(message);
}

function backendUrl(path) {
  return `${WORKER_URL}${path}`;
}

function setAuthSession(token, account) {
  authToken = typeof token === "string" ? token : "";
  currentAccount = typeof account === "string" ? account : "";

  if (authToken) {
    sessionStorage.setItem(ACCESS_TOKEN_STORAGE_KEY, authToken);
  } else {
    sessionStorage.removeItem(ACCESS_TOKEN_STORAGE_KEY);
  }

  if (currentAccount) {
    sessionStorage.setItem(ACCOUNT_STORAGE_KEY, currentAccount);
  } else {
    sessionStorage.removeItem(ACCOUNT_STORAGE_KEY);
  }
}

function clearAuthSession() {
  setAuthSession("", "");
}

function getAuthHeaders(extraHeaders = {}) {
  const headers = { ...extraHeaders };

  if (authToken) {
    headers.Authorization = `Bearer ${authToken}`;
  }

  return headers;
}

async function handleDocumentFiles({
  files,
  collection,
  maxFiles,
  onUpdate,
  moduleKey = "",
}) {
  let nextDocuments = [...collection];

  for (const file of files) {
    if (nextDocuments.length >= maxFiles) {
      showToast(t("fileLimit", { count: maxFiles }));
      break;
    }

    try {
      const parsedDocument = await parseWorkbenchFile(file);
      nextDocuments.push(
        moduleKey ? { ...parsedDocument, module: moduleKey } : parsedDocument
      );
      showToast(t("fileAdded", { name: file.name }));
    } catch (error) {
      console.warn("File parsing failed.", error);
      showToast(error.message || t("fileParseFailed", { name: file.name }));
    }
  }

  onUpdate(nextDocuments);
}

async function parseWorkbenchFile(file) {
  const extension = getFileExtension(file.name);

  if (!SUPPORTED_DOCUMENT_EXTENSIONS.has(extension)) {
    throw new Error(t("fileUnsupported", { name: file.name }));
  }

  if (file.size > MAX_FILE_SIZE) {
    throw new Error(t("fileTooLarge", { name: file.name }));
  }

  let extractedText = "";

  if (extension === "txt" || extension === "csv") {
    extractedText = await readFileAsText(file);
  } else if (extension === "xlsx" || extension === "xls") {
    extractedText = await extractSpreadsheetText(file);
  } else if (extension === "pdf") {
    extractedText = await extractPdfText(file);
  }

  const normalizedText = normalizeExtractedText(extractedText);

  if (!normalizedText) {
    throw new Error(t("fileNoText", { name: file.name }));
  }

  const truncatedText = normalizedText.slice(0, PER_FILE_TEXT_LIMIT);

  return {
    id: makeId(),
    filename: file.name,
    type: file.type || getMimeTypeFromExtension(extension),
    extension,
    text: truncatedText,
    originalCharacterCount: normalizedText.length,
    extractedCharacterCount: truncatedText.length,
    extractedCharCount: truncatedText.length,
    truncated: normalizedText.length > PER_FILE_TEXT_LIMIT,
  };
}

function renderDocumentList(container, documents, emptyText, onRemove) {
  container.innerHTML = "";

  if (!documents.length) {
    const empty = document.createElement("p");
    empty.className = "empty-state";
    empty.textContent = emptyText;
    container.appendChild(empty);
    return;
  }

  documents.forEach((documentItem) => {
    const card = document.createElement("div");
    card.className = "file-card";

    const details = document.createElement("div");
    const name = document.createElement("div");
    name.className = "file-name";
    name.textContent = documentItem.filename;

    const meta = document.createElement("div");
    meta.className = "file-meta";
    meta.textContent = `${documentItem.extension.toUpperCase()} · ${documentItem.type} · ${documentItem.extractedCharacterCount.toLocaleString()} ${t("chars")}${
      documentItem.truncated ? ` · ${t("truncated")}` : ""
    }`;

    const removeButton = document.createElement("button");
    removeButton.className = "file-remove-button";
    removeButton.type = "button";
    removeButton.textContent = t("remove");
    removeButton.addEventListener("click", () => onRemove(documentItem.id));

    details.append(name, meta);
    card.append(details, removeButton);
    container.appendChild(card);
  });
}

function removeReferenceDocument(id) {
  referenceDocuments = referenceDocuments.filter((item) => item.id !== id);
  renderDocumentList(
    referenceFileList,
    referenceDocuments,
    t("noReferenceFiles"),
    removeReferenceDocument
  );
}

function buildDocumentsForRequest(documents, maxFiles, totalLimit) {
  let remainingCharacters = totalLimit;

  return documents
    .slice(0, maxFiles)
    .map((documentItem) => {
      const textForRequest = documentItem.text.slice(0, remainingCharacters);
      remainingCharacters = Math.max(0, remainingCharacters - textForRequest.length);

      return {
        filename: documentItem.filename,
        type: documentItem.type,
        module: documentItem.module || "",
        text: textForRequest,
        truncated:
          documentItem.truncated || textForRequest.length < documentItem.text.length,
        originalCharacterCount: documentItem.originalCharacterCount,
        extractedCharCount:
          documentItem.extractedCharCount || documentItem.extractedCharacterCount,
        sentCharacterCount: textForRequest.length,
      };
    })
    .filter((documentItem) => documentItem.text);
}

function removeExperimentModuleDocument(moduleKey, id) {
  experimentModules[moduleKey].files = experimentModules[moduleKey].files.filter(
    (item) => item.id !== id
  );
  renderExperimentModule(moduleKey);
}

function removeExperimentModuleNote(moduleKey, id) {
  experimentModules[moduleKey].notes = experimentModules[moduleKey].notes.filter(
    (note) => note.id !== id
  );
  saveExperimentModules();
  renderExperimentModule(moduleKey);
}

function renderExperimentModules() {
  EXPERIMENT_MODULE_KEYS.forEach(renderExperimentModule);
  renderExperimentModuleSummary();
}

function renderExperimentModule(moduleKey) {
  const moduleState = experimentModules[moduleKey];
  const elements = experimentModuleElements[moduleKey];
  if (!moduleState || !elements) return;

  renderDocumentList(
    elements.fileList,
    moduleState.files,
    t("noModuleFiles"),
    (id) => removeExperimentModuleDocument(moduleKey, id)
  );
  renderExperimentModuleNotes(moduleKey);
  updateExperimentModuleCount(moduleKey);
  renderExperimentModuleSummary();
}

function renderExperimentModuleNotes(moduleKey) {
  const moduleState = experimentModules[moduleKey];
  const elements = experimentModuleElements[moduleKey];
  if (!moduleState || !elements) return;

  elements.noteList.innerHTML = "";

  if (!moduleState.notes.length) {
    const empty = document.createElement("p");
    empty.className = "empty-state";
    empty.textContent = t("noModuleNotes");
    elements.noteList.appendChild(empty);
    return;
  }

  moduleState.notes.forEach((note) => {
    const item = document.createElement("div");
    item.className = "note-item";

    const title = document.createElement("strong");
    title.textContent = `${getExperimentModuleLabel(moduleKey)} ${t("experimentNoteTitle")}`;

    const meta = document.createElement("div");
    meta.className = "note-meta";
    meta.textContent = formatTimestamp(note.createdAt);

    const body = document.createElement("p");
    body.textContent = note.text;

    const removeButton = document.createElement("button");
    removeButton.className = "text-button";
    removeButton.type = "button";
    removeButton.textContent = t("removeNote");
    removeButton.addEventListener("click", () =>
      removeExperimentModuleNote(moduleKey, note.id)
    );

    item.append(title, meta, body, removeButton);
    elements.noteList.appendChild(item);
  });
}

function updateExperimentModuleCount(moduleKey) {
  const moduleState = experimentModules[moduleKey];
  const elements = experimentModuleElements[moduleKey];
  if (!moduleState || !elements?.count) return;

  elements.count.textContent = t("moduleCount", {
    files: moduleState.files.length,
    notes: moduleState.notes.length,
  });
}

function renderExperimentModuleSummary() {
  if (!experimentSummaryList) return;

  experimentSummaryList.innerHTML = "";

  EXPERIMENT_MODULE_KEYS.forEach((moduleKey) => {
    const moduleState = experimentModules[moduleKey];
    const summaryItem = document.createElement("div");
    summaryItem.className = "module-summary-item";
    summaryItem.textContent = t("moduleSummary", {
      module: getExperimentModuleLabel(moduleKey),
      files: moduleState.files.length,
      notes: moduleState.notes.length,
    });
    summaryItem.classList.toggle(
      "has-evidence",
      Boolean(moduleState.files.length || moduleState.notes.length)
    );
    experimentSummaryList.appendChild(summaryItem);
  });
}

async function runAgentInstruction(instruction) {
  if (activeAgentRequest) return;

  setAgentBusy(true);
  agentStatus.textContent = t("agentReviewing");
  renderBackendStatus("backendWorking");

  try {
    let response;

    if (!USE_BACKEND) {
      throw new Error(t("backendDisabled"));
    }

    response = await sendWorkbenchRequest({
      mode: "agent_instruction",
      messages: buildAgentMessages(instruction),
    });

    currentRecommendation = normalizeAgentResponse(response, instruction);
    saveCurrentRecommendation();
    renderRecommendation();
    agentStatus.textContent = t("recommendationUpdated");
    renderBackendStatus("backendConnected");
  } catch (error) {
    if (error instanceof AuthRequiredError) {
      console.warn("Backend auth required.", error);
      return;
    }

    console.warn("Agent backend failed; using local fallback.", error);
    currentRecommendation = createLocalRecommendation(instruction);
    saveCurrentRecommendation();
    renderRecommendation();
    agentStatus.textContent = t("backendFallbackMessage");
    renderBackendStatus("backendFallback");
  } finally {
    setAgentBusy(false);
  }
}

function setAgentBusy(isBusy) {
  activeAgentRequest = isBusy;
  analyzeRecommendButton.disabled = isBusy;
}

// agent_instruction mode is the single official analysis action. It can update
// the Current Recommendation panel.
// side_chat mode is for questions only and must not mutate the recommendation.
async function sendWorkbenchRequest({ mode, messages }) {
  const experimentModulesPayload = buildExperimentModulesForRequest();
  const experimentDocumentsPayload = buildFlattenedExperimentDocumentsForRequest();
  const experimentNotesPayload = collectExperimentNotesForRequest();
  const requestBody = {
    mode,
    messages,
    projectContext: getProjectContext(),
    referenceDocuments: buildDocumentsForRequest(
      referenceDocuments,
      MAX_REFERENCE_FILES,
      TOTAL_REFERENCE_TEXT_LIMIT
    ),
    experimentModules: experimentModulesPayload,
    experimentDocuments: experimentDocumentsPayload,
    experimentNotes: experimentNotesPayload,
  };

  const response = await fetch(backendUrl("/chat"), {
    method: "POST",
    headers: getAuthHeaders({
      "Content-Type": "application/json",
    }),
    body: JSON.stringify(requestBody),
  });

  requireLoginForUnauthorized(response);

  if (!response.ok) {
    throw new Error(t("backendReturned", { status: response.status }));
  }

  const data = await response.json();

  if (!data.reply && !data.project) {
    throw new Error(t("backendMissingPayload"));
  }

  return data;
}

function buildAgentMessages(instruction) {
  return [
    {
      role: "user",
      content: [
        "Mode: agent_instruction",
        t("responseLanguageInstruction"),
        "Interpret the current synthetic-biology project context, uploaded literature, and experiment evidence grouped into Strain Engineering, Fermentation, and Downstream Processing.",
        "Compare evidence across modules, identify possible explanations, useful next analyses, and human-reviewed next steps.",
        "Do not assume the project is only about production volume or that problems are only in strain engineering.",
        "Keep recommendations at design-review and planning level. Do not provide unsafe wet-lab protocols.",
        "",
        `Instruction: ${instruction}`,
        "",
        buildProjectContextPromptBlock(),
        buildEvidencePromptBlock(),
      ]
        .filter(Boolean)
        .join("\n"),
    },
  ];
}

function buildSideChatMessages(question) {
  const recentMessages = sideChatMessages.slice(-8);

  return [
    ...recentMessages,
    {
      role: "user",
      content: [
        "Mode: side_chat",
        t("responseLanguageInstruction"),
        "Answer this as a question only. Do not claim to update the current recommendation.",
        "Use the module grouping when experiment evidence is relevant: Strain Engineering, Fermentation, and Downstream Processing.",
        "Keep the response at design-review and planning level.",
        "",
        `Question: ${question}`,
        "",
        buildProjectContextPromptBlock(),
        buildEvidencePromptBlock(),
      ].join("\n"),
    },
  ];
}

function buildProjectContextPromptBlock() {
  return `${t("projectContextPromptHeading")}\n${getProjectContext() || t("notProvided")}`;
}

function buildEvidencePromptBlock() {
  const notes = collectExperimentNotesForRequest();
  const moduleLines = EXPERIMENT_MODULE_KEYS.map((moduleKey) => {
    const moduleState = experimentModules[moduleKey];
    return t("evidenceExperimentModuleLine", {
      module: getExperimentModuleLabel(moduleKey),
      files:
        moduleState.files.map((item) => item.filename).join(", ") ||
        t("noneValue"),
      notes:
        collectExperimentNotesForRequest(moduleKey)
          .map((note) => truncateText(note.text, 80))
          .join("; ") || t("noneValue"),
    });
  });

  return [
    t("evidenceSummaryHeading"),
    t("evidenceReferenceFilesLine", {
      value: referenceDocuments.map((item) => item.filename).join(", ") || t("noneValue"),
    }),
    t("evidenceExperimentFilesLine", {
      value:
        collectExperimentDocuments().map((item) => item.filename).join(", ") ||
        t("noneValue"),
    }),
    t("evidenceExperimentNotesLine", {
      value:
        notes.map((note) => truncateText(note.text, 80)).join("; ") ||
        t("noneValue"),
    }),
    ...moduleLines,
  ].join("\n");
}

function buildExperimentModulesForRequest() {
  return EXPERIMENT_MODULE_DEFINITIONS.reduce((modules, moduleDefinition) => {
    const moduleKey = moduleDefinition.key;
    const moduleState = experimentModules[moduleKey];

    modules[moduleKey] = {
      documents: buildDocumentsForRequest(
        moduleState.files,
        MAX_EXPERIMENT_FILES,
        Math.floor(TOTAL_EXPERIMENT_TEXT_LIMIT / EXPERIMENT_MODULE_KEYS.length)
      ),
      notes: collectExperimentNotesForRequest(moduleKey),
    };

    return modules;
  }, {});
}

function buildFlattenedExperimentDocumentsForRequest() {
  return buildDocumentsForRequest(
    collectExperimentDocuments(),
    MAX_EXPERIMENT_FILES,
    TOTAL_EXPERIMENT_TEXT_LIMIT
  );
}

function collectExperimentDocuments() {
  return EXPERIMENT_MODULE_KEYS.flatMap(
    (moduleKey) => experimentModules[moduleKey].files
  );
}

function collectExperimentNotesForRequest(moduleKey = "") {
  const modulesToCollect = moduleKey ? [moduleKey] : EXPERIMENT_MODULE_KEYS;

  return modulesToCollect.flatMap((currentModuleKey) => {
    const moduleState = experimentModules[currentModuleKey];
    const elements = experimentModuleElements[currentModuleKey];
    const draftNote = elements?.noteField?.value.trim() || "";
    const notes = [...moduleState.notes];

    if (draftNote) {
      notes.unshift({
        id: `draft-${currentModuleKey}`,
        createdAt: new Date().toISOString(),
        text: draftNote,
        module: currentModuleKey,
      });
    }

    return notes.map((note) => ({
      ...note,
      module: note.module || currentModuleKey,
    }));
  });
}

function normalizeAgentResponse(response, instruction) {
  const project = response.project || {};
  const reply = response.reply || "";
  const missing = Array.isArray(project.missingInformation)
    ? project.missingInformation
    : buildMissingInformationList();

  return {
    title: t("defaultTitle"),
    currentInterpretation:
      project.summary ||
      summarizeText(reply) ||
      t("normalizedCurrentInterpretation"),
    keyEvidenceUsed: buildEvidenceList(),
    possibleExplanation:
      extractPossibleExplanation(reply) ||
      t("normalizedPossibleExplanation"),
    recommendedNextStep:
      extractRecommendedNextStep(reply) ||
      t("normalizedRecommendedNextStep"),
    additionalAnalysisSuggested: t("normalizedAdditionalAnalysis"),
    missingInformation: missing,
    humanReviewNotes:
      project.safetyNotes ||
      t("normalizedHumanReview"),
    draftSummary:
      project.draftMemo ||
      buildLocalSummary(instruction, reply || t("backendLimitedResponse")),
    reviewed: false,
    updatedAt: new Date().toISOString(),
  };
}

function createLocalRecommendation(instruction) {
  return {
    title: t("defaultTitle"),
    currentInterpretation: t("fallbackCurrentInterpretation"),
    keyEvidenceUsed: buildEvidenceList(),
    possibleExplanation: t("fallbackPossibleExplanation"),
    recommendedNextStep: t("fallbackRecommendedNextStep"),
    additionalAnalysisSuggested: t("fallbackAdditionalAnalysis"),
    missingInformation: buildMissingInformationList(),
    humanReviewNotes: t("defaultHumanReview"),
    draftSummary: buildLocalSummary(instruction, t("backendFallbackMessage")),
    reviewed: false,
    updatedAt: new Date().toISOString(),
  };
}

function createDefaultRecommendation() {
  return {
    title: t("defaultTitle"),
    currentInterpretation: t("defaultCurrentInterpretation"),
    keyEvidenceUsed: [t("defaultKeyEvidence")],
    possibleExplanation: t("defaultPossibleExplanation"),
    recommendedNextStep: t("defaultRecommendedNextStep"),
    additionalAnalysisSuggested: t("defaultAdditionalAnalysis"),
    missingInformation: [
      t("missingProjectContext"),
      t("missingReferenceEvidence"),
      t("missingExperimentEvidence"),
    ],
    humanReviewNotes: t("defaultHumanReview"),
    draftSummary: t("defaultDraftSummary"),
    reviewed: false,
    updatedAt: "",
  };
}

function buildEvidenceList() {
  const evidence = [];

  referenceDocuments.forEach((documentItem) => {
    evidence.push(t("evidenceReference", { name: documentItem.filename }));
  });

  collectExperimentDocuments().forEach((documentItem) => {
    evidence.push(
      t("evidenceExperimentFile", {
        name: documentItem.filename,
        module: getExperimentModuleLabel(documentItem.module),
      })
    );
  });

  collectExperimentNotesForRequest().forEach((note) => {
    evidence.push(
      t("evidenceExperimentNote", {
        note: truncateText(note.text, 80),
        module: getExperimentModuleLabel(note.module),
      })
    );
  });

  return evidence.length ? evidence : [t("noEvidenceIncluded")];
}

function buildMissingInformationList() {
  const missing = [];

  if (!getProjectContext()) missing.push(t("missingProjectContext"));
  if (!referenceDocuments.length) missing.push(t("missingReferenceEvidence"));
  if (
    !collectExperimentDocuments().length &&
    !collectExperimentNotesForRequest().length
  ) {
    missing.push(t("missingExperimentEvidence"));
  }

  return missing.length ? missing : [t("noMajorGaps")];
}

function buildLocalSummary(instruction, sourceNote) {
  return `# ${t("localSummaryTitle")}

${t("localSummaryProjectContext")}
${getProjectContext() || t("notProvided")}

${t("localSummaryInstruction")}
${instruction}

${t("localSummaryInterpretationNote")}
${sourceNote}

${t("localSummaryRecommendedNextStep")}
${t("localSummaryRecommendedNextStepText")}

${t("localSummaryHumanReview")}
${t("defaultHumanReview")}`;
}

function renderRecommendation() {
  currentInterpretation.textContent = currentRecommendation.currentInterpretation;
  possibleExplanation.textContent = currentRecommendation.possibleExplanation;
  recommendedNextStep.textContent = currentRecommendation.recommendedNextStep;
  additionalAnalysisSuggested.textContent =
    currentRecommendation.additionalAnalysisSuggested;
  humanReviewNotes.textContent = currentRecommendation.humanReviewNotes;
  draftSummary.textContent = currentRecommendation.draftSummary;

  renderList(keyEvidenceUsed, currentRecommendation.keyEvidenceUsed);
  renderList(missingInformation, currentRecommendation.missingInformation);

  reviewStatus.textContent = currentRecommendation.reviewed
    ? t("reviewedByHuman")
    : t("humanReviewRequired");
  reviewStatus.classList.toggle("is-reviewed", Boolean(currentRecommendation.reviewed));
}

function addSideChatMessage(role, content) {
  const message = document.createElement("article");
  message.className = `side-message ${role}`;

  const label = document.createElement("strong");
  label.textContent =
    role === "user" ? t("sideChatUserLabel") : t("sideChatAssistantLabel");

  const body = document.createElement("div");
  body.textContent = content;

  message.append(label, body);
  sideChatHistory.appendChild(message);
  sideChatHistory.scrollTop = sideChatHistory.scrollHeight;
}

function buildLocalSideChatReply(question) {
  return t("localSideChatReply", { question });
}

function getProjectContext() {
  return projectContextInput.value.trim();
}

function renderBackendStatus(status = lastBackendStatus) {
  lastBackendStatus = status || lastBackendStatus;
  const providerLabel =
    BACKEND_PROVIDER === "alibaba"
      ? t("backendProviderAlibaba")
      : t("backendProviderCloudflare");
  backendStatusLabel.lastChild.textContent = ` ${providerLabel} · ${t(lastBackendStatus)}`;
}

function readFileAsText(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();

    reader.onload = () => resolve(String(reader.result || ""));
    reader.onerror = () => reject(new Error(t("fileReadFailed", { name: file.name })));
    reader.readAsText(file);
  });
}

function readFileAsArrayBuffer(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();

    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error(t("fileReadFailed", { name: file.name })));
    reader.readAsArrayBuffer(file);
  });
}

async function extractSpreadsheetText(file) {
  if (!window.XLSX) {
    throw new Error(t("excelParserMissing"));
  }

  const arrayBuffer = await readFileAsArrayBuffer(file);
  const workbook = window.XLSX.read(arrayBuffer, {
    type: "array",
    cellDates: true,
  });

  return workbook.SheetNames.slice(0, SPREADSHEET_SHEET_LIMIT)
    .map((sheetName) => {
      const worksheet = workbook.Sheets[sheetName];
      const csv = window.XLSX.utils.sheet_to_csv(worksheet, {
        blankrows: false,
      });

      return `# Sheet: ${sheetName}\n${csv}`;
    })
    .join("\n\n")
    .slice(0, PER_FILE_TEXT_LIMIT);
}

async function extractPdfText(file) {
  if (!window.pdfjsLib) {
    throw new Error(t("pdfParserMissing"));
  }

  if (window.pdfjsLib.GlobalWorkerOptions) {
    window.pdfjsLib.GlobalWorkerOptions.workerSrc =
      "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";
  }

  const arrayBuffer = await readFileAsArrayBuffer(file);
  const pdf = await window.pdfjsLib.getDocument({ data: arrayBuffer }).promise;
  const pageCount = Math.min(pdf.numPages, PDF_PAGE_LIMIT);
  const pageTexts = [];

  for (let pageNumber = 1; pageNumber <= pageCount; pageNumber += 1) {
    const page = await pdf.getPage(pageNumber);
    const textContent = await page.getTextContent();
    const pageText = textContent.items
      .map((item) => item.str)
      .filter(Boolean)
      .join(" ");

    pageTexts.push(`# Page ${pageNumber}\n${pageText}`);
  }

  return pageTexts.join("\n\n").slice(0, PER_FILE_TEXT_LIMIT);
}

function normalizeExtractedText(text) {
  return String(text || "")
    .replace(/\r/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function getFileExtension(filename) {
  return filename.split(".").pop().toLowerCase();
}

function getMimeTypeFromExtension(extension) {
  const mimeTypes = {
    pdf: "application/pdf",
    txt: "text/plain",
    csv: "text/csv",
    xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    xls: "application/vnd.ms-excel",
  };

  return mimeTypes[extension] || "application/octet-stream";
}

async function readOptionalJson(response) {
  const contentType = response.headers.get("content-type") || "";

  if (!contentType.includes("application/json")) {
    return {};
  }

  try {
    return await response.json();
  } catch {
    return {};
  }
}

function getAccountName(data) {
  if (!data || typeof data !== "object") return "";

  const candidates = [
    data.account,
    data.accountName,
    data.username,
    data.email,
    data.name,
    data.user?.account,
    data.user?.accountName,
    data.user?.username,
    data.user?.email,
    data.user?.name,
    data.data?.account,
    data.data?.accountName,
    data.data?.username,
    data.data?.email,
    data.data?.name,
    data.data?.user?.account,
    data.data?.user?.accountName,
    data.data?.user?.username,
    data.data?.user?.email,
    data.data?.user?.name,
  ];

  const accountName = candidates.find(
    (candidate) => typeof candidate === "string" && candidate.trim()
  );

  return accountName ? accountName.trim() : "";
}

function getAuthErrorMessage(data) {
  if (!data || typeof data !== "object") return "";

  const candidates = [data.error, data.message, data.reason, data.detail];
  const message = candidates.find(
    (candidate) => typeof candidate === "string" && candidate.trim()
  );

  return message ? message.trim() : "";
}

function summarizeText(text) {
  return truncateText(String(text || "").replace(/\s+/g, " ").trim(), 360);
}

function extractPossibleExplanation(reply) {
  const text = String(reply || "").trim();
  const lines = text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  const explanationLine = lines.find((line) =>
    /explanation|because|pattern|hypothesis|原因|解释|模式|假设/i.test(line)
  );

  return truncateText(explanationLine || "", 420);
}

function extractRecommendedNextStep(reply) {
  const text = String(reply || "").trim();
  const lines = text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  const nextStepLine = lines.find((line) =>
    /next step|recommended|recommendation|下一步|建议/i.test(line)
  );

  return truncateText(nextStepLine || lines[0] || "", 420);
}

function renderList(container, items) {
  container.innerHTML = "";
  const normalizedItems =
    Array.isArray(items) && items.length ? items : [t("notAvailable")];

  normalizedItems.forEach((item) => {
    const li = document.createElement("li");
    li.textContent = item;
    container.appendChild(li);
  });
}

function buildMarkdownExport(recommendation) {
  return `# ${recommendation.title}

## ${t("markdownProjectContextHeading")}
${getProjectContext() || t("notProvided")}

## ${t("markdownCurrentInterpretationHeading")}
${recommendation.currentInterpretation}

## ${t("markdownKeyEvidenceHeading")}
${recommendation.keyEvidenceUsed.map((item) => `- ${item}`).join("\n")}

## ${t("markdownPossibleExplanationHeading")}
${recommendation.possibleExplanation}

## ${t("markdownRecommendedNextStepHeading")}
${recommendation.recommendedNextStep}

## ${t("markdownAdditionalAnalysisHeading")}
${recommendation.additionalAnalysisSuggested}

## ${t("markdownMissingInformationHeading")}
${recommendation.missingInformation.map((item) => `- ${item}`).join("\n")}

## ${t("markdownHumanReviewHeading")}
${recommendation.humanReviewNotes}

## ${t("markdownDraftSummaryHeading")}
${recommendation.draftSummary}
`;
}

async function copyText(text) {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }

  const textArea = document.createElement("textarea");
  textArea.value = text;
  textArea.setAttribute("readonly", "");
  textArea.style.position = "fixed";
  textArea.style.top = "-1000px";
  document.body.appendChild(textArea);
  textArea.select();
  document.execCommand("copy");
  textArea.remove();
}

function saveCurrentRecommendation() {
  sessionStorage.setItem(
    RECOMMENDATION_STORAGE_KEY,
    JSON.stringify(currentRecommendation)
  );
}

function saveExperimentModules() {
  const storedModules = EXPERIMENT_MODULE_KEYS.reduce((modules, moduleKey) => {
    modules[moduleKey] = {
      notes: experimentModules[moduleKey].notes,
    };
    return modules;
  }, {});

  sessionStorage.setItem(
    EXPERIMENT_MODULES_STORAGE_KEY,
    JSON.stringify(storedModules)
  );
}

function loadExperimentModules() {
  const modules = createEmptyExperimentModules();
  const storedModules = loadSessionJson(EXPERIMENT_MODULES_STORAGE_KEY, {});

  EXPERIMENT_MODULE_KEYS.forEach((moduleKey) => {
    const storedNotes = storedModules?.[moduleKey]?.notes;
    modules[moduleKey].notes = normalizeStoredExperimentNotes(
      Array.isArray(storedNotes) ? storedNotes : [],
      moduleKey
    );
  });

  const hasModuleNotes = EXPERIMENT_MODULE_KEYS.some(
    (moduleKey) => modules[moduleKey].notes.length
  );
  const legacyNotes = loadSessionJson(LEGACY_EXPERIMENT_NOTES_STORAGE_KEY, []);

  if (!hasModuleNotes && Array.isArray(legacyNotes) && legacyNotes.length) {
    modules.strainEngineering.notes = normalizeStoredExperimentNotes(
      legacyNotes,
      "strainEngineering"
    );
  }

  return modules;
}

function createEmptyExperimentModules() {
  return EXPERIMENT_MODULE_KEYS.reduce((modules, moduleKey) => {
    modules[moduleKey] = {
      files: [],
      notes: [],
    };
    return modules;
  }, {});
}

function normalizeStoredExperimentNotes(notes, moduleKey) {
  return notes
    .filter((note) => note && typeof note.text === "string" && note.text.trim())
    .map((note) => ({
      id: typeof note.id === "string" && note.id ? note.id : makeId(),
      text: note.text.trim(),
      createdAt:
        typeof note.createdAt === "string" && note.createdAt
          ? note.createdAt
          : new Date().toISOString(),
      module: note.module || moduleKey,
    }));
}

function getExperimentModuleLabel(moduleKey) {
  const moduleDefinition = EXPERIMENT_MODULE_DEFINITIONS.find(
    (definition) => definition.key === moduleKey
  );

  return moduleDefinition ? t(moduleDefinition.titleKey) : moduleKey || t("notAvailable");
}

function loadSessionJson(key, fallback) {
  try {
    const rawValue = sessionStorage.getItem(key);
    return rawValue ? JSON.parse(rawValue) : cloneValue(fallback);
  } catch {
    return cloneValue(fallback);
  }
}

function cloneValue(value) {
  return JSON.parse(JSON.stringify(value));
}

function makeId() {
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function formatTimestamp(value) {
  const date = new Date(value);

  if (Number.isNaN(date.getTime())) {
    return t("unknownTime");
  }

  return date.toLocaleString(currentLanguage === "zh" ? "zh-CN" : undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function truncateText(text, maxLength) {
  const value = String(text || "");
  return value.length > maxLength ? `${value.slice(0, maxLength - 1)}...` : value;
}

function showToast(message) {
  const toast = document.createElement("div");
  toast.className = "toast";
  toast.textContent = message;
  document.body.appendChild(toast);

  window.setTimeout(() => {
    toast.remove();
  }, 2200);
}
