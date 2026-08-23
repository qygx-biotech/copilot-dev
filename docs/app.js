const loginPanel = document.querySelector("#loginPanel");
const loginForm = document.querySelector("#loginForm");
const loginAccountInput = document.querySelector("#loginAccount");
const loginPasswordInput = document.querySelector("#loginPassword");
const loginButton = document.querySelector("#loginButton");
const loginError = document.querySelector("#loginError");
const workspaceSelectionPanel = document.querySelector("#workspaceSelectionPanel");
const selectWorkspaceButton = document.querySelector("#selectWorkspaceButton");
const workspaceSelectionError = document.querySelector("#workspaceSelectionError");
const workspaceCompatibilityMessage = document.querySelector(
  "#workspaceCompatibilityMessage"
);
const workspaceLogoutButton = document.querySelector("#workspaceLogoutButton");
const workspaceInitializationDialog = document.querySelector(
  "#workspaceInitializationDialog"
);
const workspaceInitializationName = document.querySelector(
  "#workspaceInitializationName"
);
const cancelWorkspaceInitializationButton = document.querySelector(
  "#cancelWorkspaceInitializationButton"
);
const initializeWorkspaceButton = document.querySelector(
  "#initializeWorkspaceButton"
);
const appShell = document.querySelector("#appShell");
const currentAccountName = document.querySelector("#currentAccountName");
const logoutButton = document.querySelector("#logoutButton");
const changeWorkspaceButton = document.querySelector("#changeWorkspaceButton");
const workspaceNameLabel = document.querySelector("#workspaceNameLabel");
const backendStatusLabel = document.querySelector("#backendStatusLabel");
const languageSelects = document.querySelectorAll("[data-language-select]");

const projectContextInput = document.querySelector("#projectContext");
const workspaceTreeContainer = document.querySelector("#workspaceTree");
const refreshWorkspaceButton = document.querySelector("#refreshWorkspaceButton");
const clearWorkspaceSelectionButton = document.querySelector(
  "#clearWorkspaceSelectionButton"
);
const workspaceSelectionCount = document.querySelector("#workspaceSelectionCount");
const experimentSummaryList = document.querySelector("#experimentSummaryList");
const experimentModuleCards = document.querySelectorAll("[data-experiment-module]");

const addAnalysisPanelButton = document.querySelector("#addAnalysisPanelButton");
const analysisPanelStack = document.querySelector("#analysisPanelStack");

const sideChatForm = document.querySelector("#sideChatForm");
const sideChatInput = document.querySelector("#sideChatInput");
const sideChatHistory = document.querySelector("#sideChatHistory");
const sendSideChatButton = document.querySelector("#sendSideChatButton");
const clearSideChatButton = document.querySelector("#clearSideChatButton");
const sideExampleButtons = document.querySelectorAll(".side-example-button");
const sideChatExamples = document.querySelector("#sideChatExamples");
const sideChatContextChips = document.querySelector("#sideChatContextChips");

const MAX_REFERENCE_FILES = 100;
const MAX_BROWSER_REFERENCE_FILES = 8;
const MAX_SELECTED_CHAT_PDFS = 3;
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
// Retained OSS code is intentionally inactive for local-workspace storage.
const USE_OSS_WORKSPACE_STORAGE = false;
const PDF_JS_WORKER_URL =
  "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";
const ACCESS_TOKEN_STORAGE_KEY = "access_token";
const ACCOUNT_STORAGE_KEY = "account";
const EXPERIMENT_MODULES_STORAGE_KEY = "biodesign_workbench_experiment_modules";
const LEGACY_EXPERIMENT_NOTES_STORAGE_KEY = "biodesign_workbench_experiment_notes";
const RECOMMENDATION_STORAGE_KEY = "biodesign_workbench_recommendation";
const ANALYSIS_PANELS_STORAGE_KEY = "biodesign_workbench_analysis_panels";
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
    workspaceSelectionEyebrow: "Local Workspace",
    workspaceSelectionTitle: "BioDesign Copilot",
    workspaceSelectionSubtitle:
      "Select a local project workspace to continue. Project files and generated summaries remain in that folder.",
    localStorageTitle: "Local source of truth",
    localStorageDescription:
      "Original PDFs and workspace state stay on this device. Only extracted text needed for an AI request is sent to Function Compute.",
    workspaceCompatibility:
      "Requires a compatible desktop browser such as Chrome or Edge.",
    workspaceUnsupported:
      "Writable local folder access is unavailable. Use a compatible desktop browser such as Chrome or Edge.",
    selectWorkspaceFolder: "Select Workspace Folder",
    selectingWorkspace: "Opening folder...",
    initializeWorkspaceEyebrow: "Initialize Workspace",
    initializeWorkspaceTitle: "Create a BioDesign workspace?",
    initializeWorkspaceDescription:
      "This folder is not yet a BioDesign Copilot workspace. Initialize it now? Existing unrelated files will not be changed.",
    initialize: "Initialize",
    initializingWorkspace: "Initializing...",
    cancel: "Cancel",
    workspaceLoadFailed: "Could not open this workspace: {message}",
    workspaceLabel: "Workspace",
    storageLabel: "Storage",
    storageLocal: "Local",
    changeWorkspace: "Change Workspace",
    workspaceBusy: "Please wait for the local file write to finish.",
    workspaceChanged: "Workspace changed.",
    workspaceEyebrow: "Workspace",
    workbenchSubtitle:
      "Human-in-the-loop AI workspace for synthetic biology design, literature review, and experiment interpretation.",
    workbenchTitle: "BioDesign Workbench",
    logoutButton: "Logout",
    projectContextEyebrow: "Project Context",
    projectContextTitle: "Project context / goal",
    projectContextPlaceholder:
      "Describe the project goal in plain language, e.g. We are trying to improve a pathway, understand failed experiments, compare enzyme variants, or summarize recent literature.",
    workspacePanelEyebrow: "Workspace",
    workspacePanelTitle: "Workspace",
    workspacePanelHelper:
      "This explorer reflects the selected local folder. Select files to set the context for Side Chat.",
    refreshWorkspace: "Refresh",
    clearSelection: "Clear selection",
    noFilesSelected: "No files selected",
    filesSelected: "{count} files selected",
    workspaceTreeUnavailable: "Open a workspace to browse its files.",
    workspaceRefreshed: "Workspace refreshed: {count} files found.",
    entireProjectContext: "Entire Project",
    removeContextFile: "Remove {name} from Side Chat context",
    referencesEyebrow: "Literature & References",
    referencesTitle: "Literature & References",
    uploadReferences: "Upload references",
    uploadPdfFolder: "Upload PDF folder",
    addLiterature: "Add Literature",
    refreshLiterature: "Refresh Literature",
    summarizeAllReferences: "Summarize all",
    clearReferences: "Clear references",
    referencesHelper:
      "PDFs stay in the selected workspace. Paper Cards are generated only when an agent request needs literature and are then cached locally.",
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
    analysisWorkspaceEyebrow: "Agent Work",
    analysisWorkspaceTitle: "Agent & Recommendation Panels",
    addAnalysisPanel: "Add Panel",
    analysisPanelTitle: "Analysis Panel {number}",
    activePanel: "Active",
    frozenPanel: "Frozen history",
    collapsePanel: "Collapse",
    expandPanel: "Expand",
    frozenPanelNotice:
      "This panel is frozen as history. Add a new panel to continue analysis.",
    panelCreatedAt: "Created {time}",
    noInstructionYet: "No instruction entered yet.",
    readyForAnalysis: "Ready for analysis.",
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
    sideChatContextLabel: "Context",
    sideExampleFiles: "Summarize the selected files.",
    sideExamplePatterns: "Compare the selected papers.",
    sideExamplePaper: "What does this paper suggest?",
    sideExampleClarify: "What should I clarify before running the main analysis?",
    sideQuestionLabel: "Side question",
    clearSideChat: "Clear chat",
    clearSideChatConfirm: "Clear this Side Chat conversation? Workspace files and paper summaries will not be changed.",
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
    noReferenceFiles: "No PDF files found in the workspace literature folder.",
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
    unsupportedSelectedFilesChat:
      "The selected file is visible in the workspace, but this file type does not yet have a processor for AI analysis. PDF analysis is supported in this version.",
    chatPersistenceFailed: "Side Chat could not be saved in the local workspace.",
    sideChatContextFailed: "I could not prepare the selected local context: {message}",
    sideChatPreparingPdf: "Preparing {name}...",
    sideChatProcessingPdf: "Processing {name}: chunk {done} of {total}",
    sideChatSynthesizingPdf: "Building cached understanding for {name}...",
    sideChatReadingDetail: "Reading source detail from {name}...",
    fileLimit: "Only {count} files can be attached in this MVP.",
    fileAdded: "Added {name}.",
    pdfUploading: "Uploading {name} to private OSS...",
    pdfReviewing: "Extracting and summarizing {name}...",
    pdfStored: "Stored {name} in private OSS. Summarization has not started.",
    pdfUploadFailed: "Could not upload {name}: {message}",
    pdfReviewFailed: "Review failed for {name}: {message}",
    pdfStoredMeta: "stored in private OSS",
    pdfReviewErrorMeta: "stored; review needs retry",
    pdfSummaryReadyMeta: "Paper Card ready",
    pdfSummaryPendingMeta: "Paper Card pending",
    paperCardRetryMeta: "Card retry",
    paperCardRetryTooltip: "Paper Card generation failed: {message}. It will retry when the paper is next needed, or you can generate it manually.",
    pdfLocalMeta: "stored locally",
    pdfSummaryStaleMeta: "changed — Paper Card must be regenerated",
    pdfProcessingProgress: "Summarizing chunk {done} of {total}",
    pdfSynthesizing: "Creating the final scientific review...",
    pdfExtractingLocal: "Extracting text locally...",
    regenerateSummary: "Regenerate Paper Card",
    literatureRefreshed: "Literature refreshed: {count} PDFs found.",
    literatureAdded: "Added {count} PDFs to the local workspace.",
    removeLocalFileConfirm:
      "Remove {name} from the local literature folder? Its Paper Card and derived cache will also be deleted.",
    localFileDeleted: "Removed {name} from the local literature folder.",
    localSummaryWriteFailed: "The summary could not be saved locally: {message}",
    summarizeFile: "Generate Paper Card",
    viewSummary: "View Paper Card",
    useInChat: "Use in chat",
    chatSelectionLimit: "Select at most {count} PDFs for focused Side Chat.",
    deletingFile: "Deleting {name} from private OSS...",
    deleteFileConfirm: "Permanently delete {name} from private OSS? This cannot be undone.",
    clearFilesConfirm: "Permanently delete the stored PDFs in this list from private OSS? This cannot be undone.",
    fileDeleted: "Deleted {name} from private OSS.",
    fileDeleteFailed: "Could not delete {name}: {message}",
    folderNoPdfs: "The selected folder did not contain supported PDF files.",
    summarizeAllBusy: "Summarizing papers...",
    summarizeAllProgress: "Summarizing {done}/{total} papers...",
    summarizeAllQuestion: "Summarize all literature in this workspace, compare the research questions, methods, main findings, and limitations, and clearly identify any papers whose summaries are unavailable.",
    summaryConversationQuestion: "Summarize {name}.",
    summariesReady: "The requested Paper Cards are ready.",
    thinking: "Thinking",
    pdfSyncing: "Syncing saved PDFs from private OSS...",
    pdfSynced: "Synced {count} saved PDF files from OSS.",
    pdfSyncFailed: "Could not sync saved PDFs from OSS: {message}",
    pdfUploadCloseWarning: "Please wait for the PDF upload to OSS to finish before signing out.",
    paperReviewTitle: "Paper review: {name}",
    paperSummaryLabel: "Summary",
    paperQuestionLabel: "Research question",
    paperMethodsLabel: "Methods",
    paperResultsLabel: "Key results",
    paperLimitationsLabel: "Limitations",
    paperConclusionLabel: "Main conclusion",
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
    workspaceSelectionEyebrow: "本地工作区",
    workspaceSelectionTitle: "BioDesign Copilot",
    workspaceSelectionSubtitle:
      "请选择本地项目工作区以继续。项目文件和生成的摘要都会保存在该文件夹中。",
    localStorageTitle: "本地数据源",
    localStorageDescription:
      "原始 PDF 和工作区状态保留在本机。只有 AI 请求所需的提取文本会发送到函数计算。",
    workspaceCompatibility: "需要 Chrome 或 Edge 等兼容的桌面浏览器。",
    workspaceUnsupported:
      "当前浏览器无法写入本地文件夹。请使用 Chrome 或 Edge 等兼容的桌面浏览器。",
    selectWorkspaceFolder: "选择工作区文件夹",
    selectingWorkspace: "正在打开文件夹...",
    initializeWorkspaceEyebrow: "初始化工作区",
    initializeWorkspaceTitle: "创建 BioDesign 工作区？",
    initializeWorkspaceDescription:
      "此文件夹尚不是 BioDesign Copilot 工作区。是否现在初始化？已有的无关文件不会被修改。",
    initialize: "初始化",
    initializingWorkspace: "正在初始化...",
    cancel: "取消",
    workspaceLoadFailed: "无法打开此工作区：{message}",
    workspaceLabel: "工作区",
    storageLabel: "存储",
    storageLocal: "本地",
    changeWorkspace: "切换工作区",
    workspaceBusy: "请等待本地文件写入完成。",
    workspaceChanged: "工作区已切换。",
    workspaceEyebrow: "工作区",
    workbenchSubtitle:
      "面向合成生物学设计、文献评审和实验结果解读的人机协同 AI 工作台。",
    workbenchTitle: "BioDesign 工作台",
    logoutButton: "退出登录",
    projectContextEyebrow: "项目背景",
    projectContextTitle: "项目背景 / 目标",
    projectContextPlaceholder:
      "用自然语言描述项目目标，例如：我们想改进某条通路、理解失败实验、比较酶变体，或总结近期文献。",
    workspacePanelEyebrow: "工作区",
    workspacePanelTitle: "工作区",
    workspacePanelHelper: "此资源管理器显示所选本地文件夹。选择文件可设置侧边问答的上下文。",
    refreshWorkspace: "刷新",
    clearSelection: "清除选择",
    noFilesSelected: "未选择文件",
    filesSelected: "已选择 {count} 个文件",
    workspaceTreeUnavailable: "打开工作区后可浏览文件。",
    workspaceRefreshed: "工作区已刷新：发现 {count} 个文件。",
    entireProjectContext: "整个项目",
    removeContextFile: "从侧边问答上下文移除 {name}",
    referencesEyebrow: "文献与参考资料",
    referencesTitle: "文献与参考资料",
    uploadReferences: "上传参考资料",
    uploadPdfFolder: "上传 PDF 文件夹",
    addLiterature: "添加文献",
    refreshLiterature: "刷新文献",
    summarizeAllReferences: "总结全部",
    clearReferences: "清空参考资料",
    referencesHelper:
      "PDF 保存在所选本地工作区中。仅在智能体请求需要文献时生成论文卡片，随后在本地缓存。",
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
    analysisWorkspaceEyebrow: "智能体工作",
    analysisWorkspaceTitle: "智能体与推荐面板",
    addAnalysisPanel: "添加面板",
    analysisPanelTitle: "分析面板 {number}",
    activePanel: "当前可编辑",
    frozenPanel: "已冻结历史",
    collapsePanel: "折叠",
    expandPanel: "展开",
    frozenPanelNotice:
      "该面板已作为历史冻结。如需继续分析，请添加新的面板。",
    panelCreatedAt: "创建于 {time}",
    noInstructionYet: "尚未输入指令。",
    readyForAnalysis: "可以开始分析。",
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
    sideChatContextLabel: "上下文",
    sideExampleFiles: "总结所选文件。",
    sideExamplePatterns: "比较所选论文。",
    sideExamplePaper: "这篇论文提示了什么？",
    sideExampleClarify: "运行主分析前我应该澄清什么？",
    sideQuestionLabel: "侧边问题",
    clearSideChat: "清空问答",
    clearSideChatConfirm: "清空当前侧边问答吗？工作区文件和论文摘要不会改变。",
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
    noReferenceFiles: "工作区的 literature 文件夹中尚未发现 PDF。",
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
    unsupportedSelectedFilesChat:
      "所选文件在工作区中可见，但此文件类型目前还没有可用于 AI 分析的处理器。本版本支持 PDF 分析。",
    chatPersistenceFailed: "无法将侧边问答保存到本地工作区。",
    sideChatContextFailed: "无法准备所选本地上下文：{message}",
    sideChatPreparingPdf: "正在准备 {name}...",
    sideChatProcessingPdf: "正在处理 {name}：第 {done}/{total} 个文本块",
    sideChatSynthesizingPdf: "正在为 {name} 建立缓存理解...",
    sideChatReadingDetail: "正在读取 {name} 的源文件细节...",
    fileLimit: "本 MVP 最多可附加 {count} 个文件。",
    fileAdded: "已添加 {name}。",
    pdfUploading: "正在将 {name} 上传到私有 OSS...",
    pdfReviewing: "正在提取并总结 {name}...",
    pdfStored: "{name} 已保存到私有 OSS，尚未开始总结。",
    pdfUploadFailed: "无法上传 {name}：{message}",
    pdfReviewFailed: "{name} 评审失败：{message}",
    pdfStoredMeta: "已保存到私有 OSS",
    pdfReviewErrorMeta: "已保存；需要重试评审",
    pdfSummaryReadyMeta: "论文卡片已就绪",
    pdfSummaryPendingMeta: "论文卡片待生成",
    paperCardRetryMeta: "卡片待重试",
    paperCardRetryTooltip: "论文卡片生成失败：{message}。下次请求需要该论文时会重试，也可以手动生成。",
    pdfLocalMeta: "存储于本地",
    pdfSummaryStaleMeta: "文件已更改，需要重新生成论文卡片",
    pdfProcessingProgress: "正在总结第 {done}/{total} 个文本块",
    pdfSynthesizing: "正在生成最终科学评审...",
    pdfExtractingLocal: "正在本地提取文本...",
    regenerateSummary: "重新生成论文卡片",
    literatureRefreshed: "文献已刷新：发现 {count} 个 PDF。",
    literatureAdded: "已向本地工作区添加 {count} 个 PDF。",
    removeLocalFileConfirm: "从本地文献文件夹中移除 {name}？对应论文卡片和派生缓存也会删除。",
    localFileDeleted: "已从本地文献文件夹移除 {name}。",
    localSummaryWriteFailed: "无法在本地保存摘要：{message}",
    summarizeFile: "生成论文卡片",
    viewSummary: "查看论文卡片",
    useInChat: "用于问答",
    chatSelectionLimit: "侧边问答最多选择 {count} 个 PDF。",
    deletingFile: "正在从私有 OSS 删除 {name}...",
    deleteFileConfirm: "确定要从私有 OSS 永久删除 {name} 吗？此操作无法撤销。",
    clearFilesConfirm: "确定要从私有 OSS 永久删除此列表中的 PDF 吗？此操作无法撤销。",
    fileDeleted: "已从私有 OSS 删除 {name}。",
    fileDeleteFailed: "无法删除 {name}：{message}",
    folderNoPdfs: "所选文件夹中没有受支持的 PDF 文件。",
    summarizeAllBusy: "正在总结论文...",
    summarizeAllProgress: "正在总结论文 {done}/{total}...",
    summarizeAllQuestion: "请总结此工作区中的全部文献，比较研究问题、方法、主要发现和局限性，并明确指出哪些论文尚无可用总结。",
    summaryConversationQuestion: "请总结 {name}。",
    summariesReady: "所请求的论文卡片已就绪。",
    thinking: "思考中",
    pdfSyncing: "正在从私有 OSS 同步已保存的 PDF...",
    pdfSynced: "已从 OSS 同步 {count} 个 PDF 文件。",
    pdfSyncFailed: "无法从 OSS 同步已保存的 PDF：{message}",
    pdfUploadCloseWarning: "请等待 PDF 完成上传到 OSS 后再退出登录。",
    paperReviewTitle: "论文评审：{name}",
    paperSummaryLabel: "摘要",
    paperQuestionLabel: "研究问题",
    paperMethodsLabel: "方法",
    paperResultsLabel: "主要结果",
    paperLimitationsLabel: "局限性",
    paperConclusionLabel: "主要结论",
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
let projectContext = "";
let referenceDocuments = [];
let experimentModules = loadExperimentModules();
let analysisPanels = loadAnalysisPanels();
let currentRecommendation = getCurrentRecommendation();
let sideChatMessages = [];
let sideChatConversation = null;
let activeAgentRequest = false;
let activeAgentPanelId = "";
let activePdfUploads = 0;
let activeSideChatDocumentKeys = [];
let sideChatBusy = false;
const workspaceManager = new WorkspaceManager();
const literatureApiClient = new LiteratureApiClient({
  baseUrl: WORKER_URL,
  getHeaders: () => getAuthHeaders(),
  onUnauthorized: () => handleWorkspaceAuthRequired(),
});
let literatureModule = null;
let workspaceAbortController = null;
let workspaceStateSaveTimer = null;
let workspaceStateWrite = Promise.resolve();
let activeLiteratureOperations = 0;
let workspaceTree = null;
let selectedWorkspacePaths = new Set();
let expandedWorkspacePaths = new Set([""]);
let projectContextService = null;
let workspaceChatStore = null;

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

logoutButton.addEventListener("click", logoutFromWorkbench);
workspaceLogoutButton.addEventListener("click", logoutFromWorkbench);

selectWorkspaceButton.addEventListener("click", async () => {
  workspaceSelectionError.textContent = "";
  setWorkspaceSelectionBusy(true, t("selectingWorkspace"));
  try {
    const selection = await workspaceManager.selectWorkspace();
    if (selection.initialized) {
      await openSelectedWorkspace(false);
      return;
    }
    workspaceInitializationName.textContent = selection.name;
    workspaceInitializationDialog.showModal();
  } catch (error) {
    if (error?.code !== "PICKER_CANCELLED") {
      workspaceManager.closeWorkspace();
      workspaceSelectionError.textContent = t("workspaceLoadFailed", {
        message: error.message || t("loginFailed"),
      });
    }
  } finally {
    setWorkspaceSelectionBusy(false);
  }
});

initializeWorkspaceButton.addEventListener("click", async () => {
  initializeWorkspaceButton.disabled = true;
  initializeWorkspaceButton.textContent = t("initializingWorkspace");
  try {
    await openSelectedWorkspace(true);
    workspaceInitializationDialog.close("initialized");
  } catch (error) {
    workspaceInitializationDialog.close("failed");
    workspaceManager.closeWorkspace();
    workspaceSelectionError.textContent = t("workspaceLoadFailed", {
      message: error.message || t("loginFailed"),
    });
  } finally {
    initializeWorkspaceButton.disabled = false;
    initializeWorkspaceButton.textContent = t("initialize");
  }
});

cancelWorkspaceInitializationButton.addEventListener("click", () => {
  workspaceManager.closeWorkspace();
});

workspaceInitializationDialog.addEventListener("cancel", () => {
  workspaceManager.closeWorkspace();
});

changeWorkspaceButton.addEventListener("click", async () => {
  if (activePdfUploads > 0) {
    showToast(t("workspaceBusy"));
    return;
  }
  try {
    await leaveCurrentWorkspace();
    showWorkspaceSelection();
    showToast(t("workspaceChanged"));
  } catch (error) {
    showToast(t("workspaceLoadFailed", { message: error.message || t("loginFailed") }));
  }
});

window.addEventListener("beforeunload", (event) => {
  if (activePdfUploads <= 0 && activeLiteratureOperations <= 0) return;

  event.preventDefault();
  event.returnValue = "";
});

projectContextInput.addEventListener("input", () => {
  projectContext = projectContextInput.value.trim();
  scheduleWorkspaceStateSave();
});

refreshWorkspaceButton.addEventListener("click", async () => {
  await refreshWorkspaceExplorer(true);
});

clearWorkspaceSelectionButton.addEventListener("click", () => {
  selectedWorkspacePaths.clear();
  syncWorkspaceSelectionToDocuments();
  renderWorkspaceExplorer();
  renderSideChatContext();
});

workspaceTreeContainer.addEventListener("click", (event) => {
  const folderButton = event.target.closest("[data-workspace-folder]");
  if (!folderButton) return;
  const path = folderButton.dataset.workspaceFolder || "";
  if (expandedWorkspacePaths.has(path)) expandedWorkspacePaths.delete(path);
  else expandedWorkspacePaths.add(path);
  renderWorkspaceExplorer();
});

workspaceTreeContainer.addEventListener("change", (event) => {
  const checkbox = event.target.closest("[data-workspace-file]");
  if (!checkbox) return;
  const path = checkbox.dataset.workspaceFile;
  if (checkbox.checked) selectedWorkspacePaths.add(path);
  else selectedWorkspacePaths.delete(path);
  syncWorkspaceSelectionToDocuments();
  renderWorkspaceExplorer();
  renderSideChatContext();
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

  elements.clearFilesButton.addEventListener("click", async () => {
    await clearDocumentCollection({
      documents: experimentModules[moduleKey].files,
      onUpdate(nextDocuments) {
        experimentModules[moduleKey].files = nextDocuments;
        renderAllDocumentLists();
      },
      clearedMessage: t("moduleFilesCleared", {
        module: getExperimentModuleLabel(moduleKey),
      }),
    });
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

addAnalysisPanelButton.addEventListener("click", addAnalysisPanel);

analysisPanelStack.addEventListener("input", (event) => {
  const input = event.target.closest("[data-analysis-instruction]");
  if (!input) return;

  const panel = findAnalysisPanel(input.dataset.panelId);
  if (!panel || panel.frozen) return;

  panel.instruction = input.value;
  panel.statusKey = "";
  panel.status = "";
  saveAnalysisPanels();
});

analysisPanelStack.addEventListener("click", async (event) => {
  const button = event.target.closest("[data-analysis-action]");
  if (!button) return;

  const panelId = button.dataset.panelId;
  const panel = findAnalysisPanel(panelId);
  if (!panel) return;

  const action = button.dataset.analysisAction;

  if (action === "toggle") {
    panel.collapsed = !panel.collapsed;
    saveAnalysisPanels();
    renderAnalysisPanels();
    return;
  }

  if (action === "run") {
    await runAgentInstruction(panelId);
    return;
  }

  if (action === "clear") {
    if (panel.frozen) return;
    panel.instruction = "";
    panel.statusKey = "";
    panel.status = "";
    saveAnalysisPanels();
    renderAnalysisPanels();
    focusAnalysisPanelInstruction(panelId);
    return;
  }

  if (action === "export") {
    exportRecommendation(panel.recommendation);
    return;
  }

  if (action === "copy") {
    await copyText(buildMarkdownExport(panel.recommendation));
    showToast(t("recommendationCopied"));
    return;
  }

  if (action === "review") {
    if (panel.frozen) return;
    panel.recommendation = {
      ...panel.recommendation,
      reviewed: true,
      reviewedAt: new Date().toISOString(),
    };
    saveAnalysisPanels();
    renderAnalysisPanels();
  }
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
  if (!question || sideChatBusy) return;

  sideChatInput.value = "";
  await askSideChat(question);
});

clearSideChatButton.addEventListener("click", async () => {
  if (!workspaceChatStore || sideChatBusy) return;
  if (sideChatMessages.length && !window.confirm(t("clearSideChatConfirm"))) return;
  try {
    sideChatConversation = await workspaceChatStore.clearActiveConversation();
    sideChatMessages = sideChatConversation.messages;
    renderSideChatConversation();
  } catch (error) {
    showToast(t("workspaceLoadFailed", { message: error.message || t("loginFailed") }));
  }
});

function initializeWorkbench() {
  projectContextInput.value = projectContext;
  applyLanguage();
  workspaceCompatibilityMessage.hidden = workspaceManager.isSupported();
  selectWorkspaceButton.disabled = !workspaceManager.isSupported();
  renderBackendStatus("backendReady");
  renderExperimentModules();
  renderAnalysisPanels();
  renderWorkspaceExplorer();
  renderSideChatContext();
  setSideChatBusy(sideChatBusy);
  renderSideChatConversation();
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
  showWorkspaceSelection();
}

function showLoggedOut(message) {
  closeWorkspaceInMemory();
  clearAuthSession();
  currentAccountName.textContent = t("notSignedIn");
  appShell.hidden = true;
  appShell.classList.add("is-hidden");
  workspaceSelectionPanel.hidden = true;
  workspaceSelectionPanel.classList.add("is-hidden");
  loginPanel.hidden = false;
  loginPanel.classList.remove("is-hidden");
  loginPasswordInput.value = "";
  loginError.textContent = message || "";
  loginAccountInput.focus();
}

function showWorkspaceSelection() {
  loginPanel.hidden = true;
  loginPanel.classList.add("is-hidden");
  appShell.hidden = true;
  appShell.classList.add("is-hidden");
  workspaceSelectionPanel.hidden = false;
  workspaceSelectionPanel.classList.remove("is-hidden");
  workspaceSelectionError.textContent = workspaceManager.isSupported()
    ? ""
    : t("workspaceUnsupported");
  workspaceCompatibilityMessage.hidden = workspaceManager.isSupported();
  selectWorkspaceButton.disabled = !workspaceManager.isSupported();
  if (!selectWorkspaceButton.disabled) selectWorkspaceButton.focus();
}

function showMainApplication() {
  workspaceSelectionPanel.hidden = true;
  workspaceSelectionPanel.classList.add("is-hidden");
  appShell.hidden = false;
  appShell.classList.remove("is-hidden");
  projectContextInput.focus();
}

function setWorkspaceSelectionBusy(isBusy, label = t("waitLabel")) {
  selectWorkspaceButton.disabled = isBusy || !workspaceManager.isSupported();
  selectWorkspaceButton.textContent = isBusy ? label : t("selectWorkspaceFolder");
}

async function openSelectedWorkspace(initialize) {
  const result = initialize
    ? await workspaceManager.initializeWorkspace()
    : await workspaceManager.loadWorkspace();
  workspaceAbortController?.abort();
  workspaceAbortController = new AbortController();
  literatureModule = new LiteratureModule({
    workspace: workspaceManager,
    api: literatureApiClient,
    pdfjsLib: window.pdfjsLib,
    pdfWorkerSrc: PDF_JS_WORKER_URL,
    getLanguage: () => currentLanguage,
  });
  const documents = await literatureModule.scan();
  workspaceTree = await workspaceManager.scanDirectoryTree();
  projectContextService = new ProjectContextService({
    workspace: workspaceManager,
    literature: literatureModule,
  });
  workspaceChatStore = new WorkspaceChatStore({ workspace: workspaceManager });
  sideChatConversation = await workspaceChatStore.loadActiveConversation();
  sideChatMessages = sideChatConversation.messages;
  selectedWorkspacePaths = new Set();
  expandedWorkspacePaths = new Set([""]);
  projectContext = result.state.project.goal || "";
  projectContextInput.value = projectContext;
  workspaceNameLabel.textContent = result.workspace.name;
  applyLiteratureScan(documents);
  renderWorkspaceExplorer();
  renderSideChatContext();
  renderSideChatConversation();
  showMainApplication();
}

function applyLiteratureScan(documents) {
  const previousById = new Map(referenceDocuments.map((document) => [document.id, document]));
  referenceDocuments = documents.map((document) => {
    const previous = previousById.get(document.id);
    const preserveCachedReview =
      previous?.review && document.summaryAvailable && document.status !== "stale";
    return {
      ...document,
      type: "application/pdf",
      extension: "pdf",
      localWorkspace: true,
      processingStatus: "",
      review: preserveCachedReview ? previous.review : null,
      text: preserveCachedReview ? previous.text : "",
      selectedForChat: preserveCachedReview ? previous.selectedForChat : false,
      reviewError: document.paperCardError || "",
    };
  });
  syncWorkspaceSelectionToDocuments();
}

function applyPreparedContextToDocuments(localWorkspaceContext) {
  const evidenceByPath = new Map(
    (localWorkspaceContext?.files || [])
      .filter((file) => file.analysisStatus === "processed" && file.content)
      .map((file) => [file.relativePath, file])
  );
  referenceDocuments = referenceDocuments.map((documentItem) => {
    const evidence = evidenceByPath.get(documentItem.relativePath);
    if (!evidence) return documentItem;
    return {
      ...documentItem,
      text: evidence.content,
      summaryAvailable: true,
      status: "ready",
      reviewError: "",
    };
  });
}

async function refreshLiterature(showMessage = false) {
  if (!literatureModule) return;
  try {
    const documents = await literatureModule.scan();
    applyLiteratureScan(documents);
    if (showMessage) showToast(t("literatureRefreshed", { count: documents.length }));
  } catch (error) {
    showToast(t("workspaceLoadFailed", { message: error.message || t("loginFailed") }));
  }
}

async function refreshWorkspaceExplorer(showMessage = false) {
  if (!literatureModule || !workspaceManager.workspace) return;
  refreshWorkspaceButton.disabled = true;
  try {
    const documents = await literatureModule.scan();
    const nextTree = await workspaceManager.scanDirectoryTree();
    workspaceTree = nextTree;
    applyLiteratureScan(documents);
    const availablePaths = new Set(
      flattenWorkspaceTree(workspaceTree)
        .filter((entry) => entry.type === "file")
        .map((entry) => entry.relativePath)
    );
    selectedWorkspacePaths = new Set(
      [...selectedWorkspacePaths].filter((path) => availablePaths.has(path))
    );
    syncWorkspaceSelectionToDocuments();
    renderWorkspaceExplorer();
    renderSideChatContext();
    if (showMessage) {
      showToast(t("workspaceRefreshed", { count: availablePaths.size }));
    }
  } catch (error) {
    showToast(t("workspaceLoadFailed", { message: error.message || t("loginFailed") }));
  } finally {
    refreshWorkspaceButton.disabled = false;
  }
}

function scheduleWorkspaceStateSave() {
  if (!workspaceManager.workspace) return;
  window.clearTimeout(workspaceStateSaveTimer);
  workspaceStateSaveTimer = window.setTimeout(() => {
    workspaceStateSaveTimer = null;
    workspaceStateWrite = workspaceStateWrite
      .then(() => saveWorkspaceStateNow())
      .catch((error) =>
        showToast(
          t("workspaceLoadFailed", {
            message: error.message || t("loginFailed"),
          })
        )
      );
  }, 450);
}

async function saveWorkspaceStateNow() {
  if (!workspaceManager.workspace || !workspaceManager.state) return;
  const nextState = {
    ...workspaceManager.state,
    project: {
      ...workspaceManager.state.project,
      goal: projectContextInput.value.trim(),
    },
  };
  await workspaceManager.saveState(nextState);
}

async function flushWorkspaceState() {
  if (workspaceStateSaveTimer) {
    window.clearTimeout(workspaceStateSaveTimer);
    workspaceStateSaveTimer = null;
    workspaceStateWrite = workspaceStateWrite.then(() => saveWorkspaceStateNow());
  }
  try {
    await workspaceStateWrite;
  } finally {
    workspaceStateWrite = Promise.resolve();
  }
}

async function leaveCurrentWorkspace() {
  workspaceAbortController?.abort();
  await flushWorkspaceState();
  closeWorkspaceInMemory();
}

function closeWorkspaceInMemory() {
  workspaceAbortController?.abort();
  workspaceAbortController = null;
  literatureModule = null;
  projectContextService = null;
  workspaceChatStore = null;
  sideChatConversation = null;
  workspaceManager.closeWorkspace();
  referenceDocuments = [];
  workspaceTree = null;
  selectedWorkspacePaths = new Set();
  expandedWorkspacePaths = new Set([""]);
  workspaceNameLabel.textContent = "";
  activeSideChatDocumentKeys = [];
  sideChatMessages = [];
  renderWorkspaceExplorer();
  renderSideChatContext();
  renderSideChatConversation();
}

async function logoutFromWorkbench() {
  if (activePdfUploads > 0) {
    showToast(t("workspaceBusy"));
    return;
  }
  workspaceAbortController?.abort();
  try {
    await flushWorkspaceState();
  } catch (error) {
    showToast(t("workspaceLoadFailed", { message: error.message || t("loginFailed") }));
  }
  closeWorkspaceInMemory();
  sideChatMessages = [];
  activeSideChatDocumentKeys = [];
  renderSideChatConversation();
  showLoggedOut(t("loggedOut"));
}

function handleWorkspaceAuthRequired() {
  showLoggedOut(t("sessionExpired"));
}

function setLoginBusy(isBusy, label = t("waitLabel")) {
  loginAccountInput.disabled = isBusy;
  loginPasswordInput.disabled = isBusy;
  loginButton.disabled = isBusy;
  loginButton.classList.toggle("is-loading", isBusy);
  loginButton.textContent = isBusy ? label : t("loginButton");

  if (isBusy) {
    loginButton.setAttribute("aria-busy", "true");
  } else {
    loginButton.removeAttribute("aria-busy");
  }
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

  refreshDefaultAnalysisPanels();

  renderBackendStatus();
  renderExperimentModules();
  renderAnalysisPanels();
  renderWorkspaceExplorer();
  renderSideChatContext();

  if (!sideChatMessages.length && sideChatHistory.childElementCount <= 1) {
    sideChatHistory.innerHTML = "";
    setSideChatEmptyState(true);
    addSideChatMessage("assistant", t("sideChatIntro"), { isIntro: true });
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

    const extension = getFileExtension(file.name);

    if (
      extension === "pdf" &&
      BACKEND_PROVIDER === "alibaba" &&
      USE_OSS_WORKSPACE_STORAGE
    ) {
      const pendingId = makeId();
      const pendingDocument = {
        id: pendingId,
        filename: file.name,
        type: "application/pdf",
        extension: "pdf",
        text: "",
        originalCharacterCount: 0,
        extractedCharacterCount: 0,
        extractedCharCount: 0,
        truncated: false,
        processingStatus: "uploading",
        module: moduleKey,
      };
      nextDocuments.push(pendingDocument);
      onUpdate(nextDocuments);
      showToast(t("pdfUploading", { name: file.name }));
      renderBackendStatus("backendWorking");

      try {
        const storedDocument = await uploadPdfToOss(file);
        const nextDocument = moduleKey
          ? { ...storedDocument, id: pendingId, module: moduleKey }
          : { ...storedDocument, id: pendingId };
        nextDocuments = nextDocuments.map((documentItem) =>
          documentItem.id === pendingId ? nextDocument : documentItem
        );
        onUpdate(nextDocuments);

        showToast(t("pdfStored", { name: file.name }));

        renderBackendStatus("backendConnected");
      } catch (error) {
        nextDocuments = nextDocuments.filter(
          (documentItem) => documentItem.id !== pendingId
        );
        onUpdate(nextDocuments);
        console.warn("PDF upload failed.", error);
        showToast(
          t("pdfUploadFailed", {
            name: file.name,
            message: error.message || t("fileParseFailed", { name: file.name }),
          })
        );
        renderBackendStatus("backendFallback");
      }

      continue;
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

async function uploadPdfToOss(file) {
  if (file.size <= 0 || file.size > MAX_FILE_SIZE) {
    throw new Error(t("fileTooLarge", { name: file.name }));
  }

  let uploadUrlData;
  activePdfUploads += 1;

  try {
    const uploadUrlResponse = await fetch(
      backendUrl("/api/documents/upload-url"),
      {
        method: "POST",
        headers: getAuthHeaders({
          "Content-Type": "application/json",
        }),
        body: JSON.stringify({
          filename: file.name,
          contentType: "application/pdf",
          size: file.size,
        }),
      }
    );

    requireLoginForUnauthorized(uploadUrlResponse);
    uploadUrlData = await readOptionalJson(uploadUrlResponse);
    if (!uploadUrlResponse.ok || !uploadUrlData.uploadUrl || !uploadUrlData.objectKey) {
      throw new Error(
        getAuthErrorMessage(uploadUrlData) ||
          t("backendReturned", { status: uploadUrlResponse.status })
      );
    }

    const ossUploadResponse = await fetch(uploadUrlData.uploadUrl, {
      method: "PUT",
      headers: {
        "Content-Type": "application/pdf",
      },
      body: file,
    });

    if (!ossUploadResponse.ok) {
      throw new Error(
        `OSS upload returned HTTP ${ossUploadResponse.status}.`
      );
    }
  } finally {
    activePdfUploads = Math.max(0, activePdfUploads - 1);
  }

  return {
    filename: uploadUrlData.filename || file.name,
    type: "application/pdf",
    extension: "pdf",
    text: "",
    objectKey: uploadUrlData.objectKey,
    size: file.size,
    lastModified: new Date().toISOString(),
    originalCharacterCount: 0,
    extractedCharacterCount: 0,
    extractedCharCount: 0,
    truncated: false,
    processingStatus: "",
    summaryAvailable: false,
    selectedForChat: false,
  };
}

async function syncStoredPdfDocuments() {
  if (!authToken) return;
  if (BACKEND_PROVIDER !== "alibaba") {
    renderBackendStatus("backendConnected");
    return;
  }

  renderBackendStatus("backendWorking");
  showToast(t("pdfSyncing"));

  try {
    const response = await fetch(backendUrl("/api/documents"), {
      method: "GET",
      headers: getAuthHeaders(),
    });
    requireLoginForUnauthorized(response);
    const data = await readOptionalJson(response);

    if (!response.ok || !data.ok || !Array.isArray(data.documents)) {
      throw new Error(
        data.message ||
          getAuthErrorMessage(data) ||
          t("backendReturned", { status: response.status })
      );
    }

    const serverDocuments = data.documents
      .filter(
        (documentItem) =>
          documentItem &&
          typeof documentItem.objectKey === "string" &&
          documentItem.objectKey &&
          typeof documentItem.filename === "string" &&
          documentItem.filename
      )
      .map((documentItem) => ({
        objectKey: documentItem.objectKey,
        filename: documentItem.filename,
        size: Number.isFinite(Number(documentItem.size))
          ? Number(documentItem.size)
          : 0,
        lastModified:
          typeof documentItem.lastModified === "string"
            ? documentItem.lastModified
            : "",
        summaryAvailable: documentItem.summaryAvailable === true,
        review:
          documentItem.review && typeof documentItem.review === "object"
            ? documentItem.review
            : null,
        summaryUpdatedAt:
          typeof documentItem.summaryUpdatedAt === "string"
            ? documentItem.summaryUpdatedAt
            : "",
        extractedCharacterCount: Number(
          documentItem.extractedCharacterCount || 0
        ),
      }));
    const serverByKey = new Map(
      serverDocuments.map((documentItem) => [
        documentItem.objectKey,
        documentItem,
      ])
    );
    activeSideChatDocumentKeys = activeSideChatDocumentKeys.filter((key) =>
      serverByKey.has(key)
    );
    saveSideChatMessages();

    const reconcileCollection = (documents) =>
      documents
        .filter(
          (documentItem) =>
            !documentItem.objectKey || serverByKey.has(documentItem.objectKey)
        )
        .map((documentItem) => {
          const serverDocument = serverByKey.get(documentItem.objectKey);
          return serverDocument
            ? {
                ...documentItem,
                filename: serverDocument.filename,
                size: serverDocument.size,
                lastModified: serverDocument.lastModified,
                summaryAvailable: serverDocument.summaryAvailable,
                review: serverDocument.review || documentItem.review || null,
                summaryUpdatedAt: serverDocument.summaryUpdatedAt,
                extractedCharacterCount:
                  serverDocument.extractedCharacterCount ||
                  documentItem.extractedCharacterCount ||
                  0,
                syncedFromOss: true,
              }
            : documentItem;
        });

    referenceDocuments = reconcileCollection(referenceDocuments);
    EXPERIMENT_MODULE_KEYS.forEach((moduleKey) => {
      experimentModules[moduleKey].files = reconcileCollection(
        experimentModules[moduleKey].files
      );
    });

    const placedObjectKeys = new Set(
      [...referenceDocuments, ...collectExperimentDocuments()]
        .map((documentItem) => documentItem.objectKey)
        .filter(Boolean)
    );
    const restoredDocuments = serverDocuments
      .filter((documentItem) => !placedObjectKeys.has(documentItem.objectKey))
      .map((documentItem) => ({
        id: `oss:${documentItem.objectKey}`,
        filename: documentItem.filename,
        type: "application/pdf",
        extension: "pdf",
        text: "",
        objectKey: documentItem.objectKey,
        size: documentItem.size,
        lastModified: documentItem.lastModified,
        originalCharacterCount: documentItem.extractedCharacterCount,
        extractedCharacterCount: documentItem.extractedCharacterCount,
        extractedCharCount: documentItem.extractedCharacterCount,
        truncated: false,
        processingStatus: "",
        syncedFromOss: true,
        summaryAvailable: documentItem.summaryAvailable,
        review: documentItem.review,
        summaryUpdatedAt: documentItem.summaryUpdatedAt,
        selectedForChat: false,
      }));

    referenceDocuments = [...referenceDocuments, ...restoredDocuments];
    renderAllDocumentLists();
    renderBackendStatus("backendConnected");
    showToast(t("pdfSynced", { count: serverDocuments.length }));
  } catch (error) {
    if (error instanceof AuthRequiredError) return;

    console.warn("Stored PDF synchronization failed.", error);
    renderBackendStatus("backendFallback");
    showToast(
      t("pdfSyncFailed", {
        message: error.message || t("loginFailed"),
      })
    );
  }
}

function formatPaperReview(review, filename) {
  const value = review && typeof review === "object" ? review : {};
  const lines = [t("paperReviewTitle", { name: value.title || filename })];
  const appendScalar = (labelKey, fieldValue) => {
    if (typeof fieldValue === "string" && fieldValue.trim()) {
      lines.push("", `${t(labelKey)}:`, fieldValue.trim());
    }
  };
  const appendList = (labelKey, items) => {
    const normalizedItems = Array.isArray(items)
      ? items.filter((item) => typeof item === "string" && item.trim())
      : [];
    if (normalizedItems.length) {
      lines.push(
        "",
        `${t(labelKey)}:`,
        ...normalizedItems.map((item) => `• ${item.trim()}`)
      );
    }
  };

  appendScalar("paperSummaryLabel", value.shortSummary || value.summary);
  appendScalar("paperQuestionLabel", value.researchQuestion || value.research_question);
  if (Array.isArray(value.methods)) appendList("paperMethodsLabel", value.methods);
  else appendScalar("paperMethodsLabel", value.methods || value.methodsSummary);
  appendList(
    "paperResultsLabel",
    Array.isArray(value.mainFindings) && value.mainFindings.length
      ? value.mainFindings
      : value.keyResults || value.key_results
  );
  appendList("paperLimitationsLabel", value.limitations);
  appendScalar("paperConclusionLabel", value.mainConclusion || value.main_conclusion);
  return lines.join("\n");
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
    card.classList.toggle("is-stale", documentItem.status === "stale");
    card.classList.toggle("has-error", Boolean(documentItem.reviewError));

    const details = document.createElement("div");
    const name = document.createElement("div");
    name.className = "file-name";
    name.textContent = documentItem.filename;

    const meta = document.createElement("div");
    meta.className = "file-meta";
    if (documentItem.processingStatus === "uploading") {
      meta.textContent = t("pdfUploading", { name: documentItem.filename });
    } else if (documentItem.processingStatus === "reviewing") {
      meta.textContent =
        documentItem.processingMessage ||
        t("pdfReviewing", { name: documentItem.filename });
    } else if (documentItem.processingStatus === "deleting") {
      meta.textContent = t("deletingFile", { name: documentItem.filename });
    } else {
      const characterCount = Number(
        documentItem.extractedCharacterCount || documentItem.extractedCharCount || 0
      );
      const storageNote = documentItem.localWorkspace
        ? [
            t("pdfLocalMeta"),
            documentItem.reviewError
              ? `${t("pdfReviewErrorMeta")}: ${documentItem.reviewError}`
              : documentItem.status === "stale"
                ? t("pdfSummaryStaleMeta")
                : documentItem.summaryAvailable
                  ? t("pdfSummaryReadyMeta")
                  : t("pdfSummaryPendingMeta"),
          ].join(" · ")
        : documentItem.objectKey
        ? [
            t("pdfStoredMeta"),
            documentItem.reviewError
              ? `${t("pdfReviewErrorMeta")}: ${documentItem.reviewError}`
              : documentItem.summaryAvailable
                ? t("pdfSummaryReadyMeta")
                : t("pdfSummaryPendingMeta"),
          ].join(" · ")
        : "";
      const evidenceDetails =
        (documentItem.objectKey || documentItem.localWorkspace) && !characterCount
          ? [
              formatFileSize(documentItem.size),
              documentItem.lastModified
                ? formatTimestamp(documentItem.lastModified)
                : "",
            ]
              .filter(Boolean)
              .join(" · ")
          : `${characterCount.toLocaleString()} ${t("chars")}${
              documentItem.truncated ? ` · ${t("truncated")}` : ""
            }`;
      meta.textContent = `${documentItem.extension.toUpperCase()} · ${documentItem.type}${
        evidenceDetails ? ` · ${evidenceDetails}` : ""
      }${storageNote ? ` · ${storageNote}` : ""}`;
    }

    const actions = document.createElement("div");
    actions.className = "file-actions";
    if (documentItem.objectKey || documentItem.localWorkspace) {
      const chatLabel = document.createElement("label");
      chatLabel.className = "file-chat-toggle";
      const chatCheckbox = document.createElement("input");
      chatCheckbox.type = "checkbox";
      chatCheckbox.checked = Boolean(documentItem.selectedForChat);
      chatCheckbox.disabled = Boolean(documentItem.processingStatus);
      chatCheckbox.addEventListener("change", async () => {
        await setDocumentChatSelection(documentItem.id, chatCheckbox.checked);
      });
      const chatText = document.createElement("span");
      chatText.textContent = t("useInChat");
      chatLabel.append(chatCheckbox, chatText);

      const summaryButton = document.createElement("button");
      summaryButton.className = "text-button file-summary-button";
      summaryButton.type = "button";
      summaryButton.textContent =
        documentItem.status === "stale"
          ? t("regenerateSummary")
          : documentItem.summaryAvailable
            ? t("viewSummary")
            : t("summarizeFile");
      summaryButton.disabled = Boolean(documentItem.processingStatus);
      summaryButton.addEventListener("click", async () => {
        await summarizeStoredPdfById(documentItem.id);
      });
      actions.append(chatLabel);
      if (
        documentItem.localWorkspace &&
        documentItem.status === "stale" &&
        documentItem.summaryAvailable
      ) {
        const staleSummaryButton = document.createElement("button");
        staleSummaryButton.className = "text-button file-summary-button";
        staleSummaryButton.type = "button";
        staleSummaryButton.textContent = t("viewSummary");
        staleSummaryButton.disabled = Boolean(documentItem.processingStatus);
        staleSummaryButton.addEventListener("click", async () => {
          await viewCachedLocalSummary(documentItem.id);
        });
        actions.append(staleSummaryButton);
      }
      actions.append(summaryButton);
    }

    const removeButton = document.createElement("button");
    removeButton.className = "file-remove-button";
    removeButton.type = "button";
    removeButton.textContent = t("remove");
    removeButton.disabled = Boolean(documentItem.processingStatus);
    removeButton.addEventListener("click", () => onRemove(documentItem.id));

    details.append(name, meta);
    actions.appendChild(removeButton);
    card.append(details, actions);
    container.appendChild(card);
  });
}

function renderAllDocumentLists() {
  renderWorkspaceExplorer();
  renderSideChatContext();
}

function syncWorkspaceSelectionToDocuments() {
  referenceDocuments = referenceDocuments.map((documentItem) => ({
    ...documentItem,
    selectedForChat: selectedWorkspacePaths.has(documentItem.relativePath),
  }));
}

function renderWorkspaceExplorer() {
  if (!workspaceTreeContainer) return;
  workspaceTreeContainer.innerHTML = "";
  const selectedCount = selectedWorkspacePaths.size;
  workspaceSelectionCount.textContent = selectedCount
    ? t("filesSelected", { count: selectedCount })
    : t("noFilesSelected");
  clearWorkspaceSelectionButton.disabled = selectedCount === 0;

  if (!workspaceTree) {
    const empty = document.createElement("p");
    empty.className = "empty-state";
    empty.textContent = t("workspaceTreeUnavailable");
    workspaceTreeContainer.appendChild(empty);
    return;
  }

  const list = document.createElement("ul");
  list.className = "workspace-tree-list";
  list.setAttribute("role", "group");
  list.appendChild(renderWorkspaceTreeNode(workspaceTree, true));
  workspaceTreeContainer.appendChild(list);
}

function renderWorkspaceTreeNode(node, isRoot = false) {
  const item = document.createElement("li");
  item.setAttribute("role", "treeitem");
  item.setAttribute("aria-label", node.relativePath || node.name);

  if (node.type === "directory") {
    const expanded = expandedWorkspacePaths.has(node.relativePath);
    item.setAttribute("aria-expanded", String(expanded));
    const button = document.createElement("button");
    button.type = "button";
    button.className = `workspace-tree-row workspace-folder-toggle${
      isRoot ? " is-root" : ""
    }`;
    button.dataset.workspaceFolder = node.relativePath;

    const disclosure = document.createElement("span");
    disclosure.className = "workspace-tree-disclosure";
    disclosure.textContent = expanded ? "▼" : "▶";
    disclosure.setAttribute("aria-hidden", "true");
    const icon = document.createElement("span");
    icon.className = "workspace-tree-icon";
    icon.textContent = "▰";
    icon.setAttribute("aria-hidden", "true");
    const name = document.createElement("span");
    name.className = "workspace-tree-name";
    name.textContent = node.name;
    name.title = node.name;
    button.append(disclosure, icon, name);
    item.appendChild(button);

    if (expanded && node.children?.length) {
      const children = document.createElement("ul");
      children.className = "workspace-tree-list workspace-tree-children";
      children.setAttribute("role", "group");
      node.children.forEach((child) =>
        children.appendChild(renderWorkspaceTreeNode(child))
      );
      item.appendChild(children);
    }
    return item;
  }

  const label = document.createElement("label");
  label.className = "workspace-tree-row workspace-file-row";
  label.classList.toggle("is-selected", selectedWorkspacePaths.has(node.relativePath));
  label.title = node.relativePath;
  const literatureDocument = (literatureModule?.documents || []).find(
    (document) => document.relativePath === node.relativePath
  );
  const paperCardFailed =
    literatureDocument?.isLiteraturePaper &&
    literatureDocument.paperCardStatus === "failed";
  label.classList.toggle("has-paper-card-error", Boolean(paperCardFailed));

  const checkbox = document.createElement("input");
  checkbox.type = "checkbox";
  checkbox.dataset.workspaceFile = node.relativePath;
  checkbox.checked = selectedWorkspacePaths.has(node.relativePath);
  const icon = document.createElement("span");
  icon.className = "workspace-tree-icon";
  icon.textContent = getWorkspaceFileIcon(node.name);
  icon.setAttribute("aria-hidden", "true");
  const name = document.createElement("span");
  name.className = "workspace-tree-name";
  name.textContent = node.name;
  name.title = node.name;
  const meta = document.createElement("span");
  meta.className = "workspace-tree-meta";
  meta.textContent = paperCardFailed
    ? t("paperCardRetryMeta")
    : formatFileSize(node.size);
  if (paperCardFailed) {
    meta.title = t("paperCardRetryTooltip", {
      message: literatureDocument.paperCardError || t("loginFailed"),
    });
  }
  label.append(checkbox, icon, name, meta);
  item.appendChild(label);
  return item;
}

function getWorkspaceFileIcon(filename) {
  const extension = getFileExtension(filename);
  if (extension === "pdf") return "P";
  if (extension === "xlsx" || extension === "xls" || extension === "csv") return "▦";
  if (extension === "fasta" || extension === "fa" || extension === "fastq") return "⌁";
  if (extension === "txt" || extension === "md") return "≡";
  return "•";
}

function renderSideChatContext() {
  if (!sideChatContextChips) return;
  sideChatContextChips.innerHTML = "";
  if (!selectedWorkspacePaths.size) {
    const chip = document.createElement("span");
    chip.className = "context-chip";
    chip.textContent = t("entireProjectContext");
    sideChatContextChips.appendChild(chip);
    return;
  }

  [...selectedWorkspacePaths].sort().forEach((path) => {
    const chip = document.createElement("span");
    chip.className = "context-chip";
    chip.title = path;
    const name = document.createElement("span");
    name.textContent = path.split("/").pop();
    const remove = document.createElement("button");
    remove.className = "context-chip-remove";
    remove.type = "button";
    remove.textContent = "×";
    remove.setAttribute("aria-label", t("removeContextFile", { name: path }));
    remove.addEventListener("click", () => {
      selectedWorkspacePaths.delete(path);
      syncWorkspaceSelectionToDocuments();
      renderWorkspaceExplorer();
      renderSideChatContext();
    });
    chip.append(name, remove);
    sideChatContextChips.appendChild(chip);
  });
}

function getStoredWorkspaceDocuments() {
  return [...referenceDocuments, ...collectExperimentDocuments()].filter(
    (documentItem) => documentItem.objectKey
  );
}

function findDocumentEntry(id) {
  const referenceIndex = referenceDocuments.findIndex((item) => item.id === id);
  if (referenceIndex >= 0) {
    return {
      document: referenceDocuments[referenceIndex],
      collection: "reference",
      index: referenceIndex,
    };
  }

  for (const moduleKey of EXPERIMENT_MODULE_KEYS) {
    const index = experimentModules[moduleKey].files.findIndex(
      (item) => item.id === id
    );
    if (index >= 0) {
      return {
        document: experimentModules[moduleKey].files[index],
        collection: "experiment",
        moduleKey,
        index,
      };
    }
  }

  return null;
}

function updateDocumentById(id, updates) {
  const entry = findDocumentEntry(id);
  if (!entry) return null;
  const nextDocument = {
    ...entry.document,
    ...(typeof updates === "function" ? updates(entry.document) : updates),
  };
  if (entry.collection === "reference") {
    referenceDocuments[entry.index] = nextDocument;
  } else {
    experimentModules[entry.moduleKey].files[entry.index] = nextDocument;
  }
  return nextDocument;
}

function removeDocumentLocally(id) {
  const entry = findDocumentEntry(id);
  if (!entry) return;
  if (entry.collection === "reference") {
    referenceDocuments.splice(entry.index, 1);
  } else {
    experimentModules[entry.moduleKey].files.splice(entry.index, 1);
  }
}

async function setDocumentChatSelection(id, selected) {
  const entry = findDocumentEntry(id);
  if (!entry?.document.objectKey && !entry?.document.localWorkspace) return;
  const selectedCount = [...referenceDocuments, ...collectExperimentDocuments()].filter(
    (documentItem) => documentItem.selectedForChat
  ).length;
  if (selected && !entry.document.selectedForChat && selectedCount >= MAX_SELECTED_CHAT_PDFS) {
    showToast(t("chatSelectionLimit", { count: MAX_SELECTED_CHAT_PDFS }));
    renderAllDocumentLists();
    return;
  }

  updateDocumentById(id, { selectedForChat: selected });
  if (selected && entry.document.localWorkspace && entry.document.summaryAvailable) {
    try {
      const summary = entry.document.review || (await literatureModule.loadSummary(id));
      if (summary) {
        updateDocumentById(id, {
          review: summary,
          text: buildLocalSummaryContext(summary, entry.document.filename),
        });
      }
    } catch (error) {
      updateDocumentById(id, { reviewError: error.message || t("loginFailed") });
    }
  } else if (selected && entry.document.objectKey) {
    activeSideChatDocumentKeys = [
      ...new Set([...activeSideChatDocumentKeys, entry.document.objectKey]),
    ].slice(0, MAX_SELECTED_CHAT_PDFS);
  } else if (entry.document.objectKey) {
    activeSideChatDocumentKeys = activeSideChatDocumentKeys.filter(
      (key) => key !== entry.document.objectKey
    );
  }
  saveSideChatMessages();
  renderAllDocumentLists();
}

function buildLocalSummaryContext(summary, filename) {
  return [
    `Cached local scientific summary for ${filename}:`,
    formatPaperReview(summary, filename),
  ].join("\n\n");
}

async function deleteStoredPdfFromOss(documentItem) {
  const response = await fetch(backendUrl("/api/documents/delete"), {
    method: "POST",
    headers: getAuthHeaders({ "Content-Type": "application/json" }),
    body: JSON.stringify({ objectKey: documentItem.objectKey }),
  });
  requireLoginForUnauthorized(response);
  const data = await readOptionalJson(response);
  if (!response.ok || !data.ok) {
    throw new Error(
      data.message ||
        getAuthErrorMessage(data) ||
        t("backendReturned", { status: response.status })
    );
  }
}

async function removeWorkspaceDocument(id) {
  const entry = findDocumentEntry(id);
  if (!entry) return;
  const documentItem = entry.document;
  if (documentItem.localWorkspace) {
    if (!window.confirm(t("removeLocalFileConfirm", { name: documentItem.filename }))) {
      return;
    }
    updateDocumentById(id, { processingStatus: "deleting" });
    renderAllDocumentLists();
    activePdfUploads += 1;
    try {
      const documents = await literatureModule.removeDocument(id);
      applyLiteratureScan(documents);
      showToast(t("localFileDeleted", { name: documentItem.filename }));
    } catch (error) {
      updateDocumentById(id, {
        processingStatus: "",
        reviewError: error.message || t("loginFailed"),
      });
      renderAllDocumentLists();
      showToast(
        t("fileDeleteFailed", {
          name: documentItem.filename,
          message: error.message || t("loginFailed"),
        })
      );
    } finally {
      activePdfUploads = Math.max(0, activePdfUploads - 1);
    }
    return;
  }
  if (
    documentItem.objectKey &&
    !window.confirm(t("deleteFileConfirm", { name: documentItem.filename }))
  ) {
    return;
  }

  if (!documentItem.objectKey) {
    removeDocumentLocally(id);
    renderAllDocumentLists();
    return;
  }

  updateDocumentById(id, { processingStatus: "deleting" });
  renderAllDocumentLists();
  try {
    await deleteStoredPdfFromOss(documentItem);
    removeDocumentLocally(id);
    activeSideChatDocumentKeys = activeSideChatDocumentKeys.filter(
      (key) => key !== documentItem.objectKey
    );
    saveSideChatMessages();
    showToast(t("fileDeleted", { name: documentItem.filename }));
  } catch (error) {
    updateDocumentById(id, { processingStatus: "" });
    showToast(
      t("fileDeleteFailed", {
        name: documentItem.filename,
        message: error.message || t("loginFailed"),
      })
    );
  }
  renderAllDocumentLists();
}

async function removeReferenceDocument(id) {
  await removeWorkspaceDocument(id);
}

async function requestStoredPdfSummary(documentItem, force = false) {
  const response = await fetch(backendUrl("/api/documents/review"), {
    method: "POST",
    headers: getAuthHeaders({ "Content-Type": "application/json" }),
    body: JSON.stringify({
      objectKey: documentItem.objectKey,
      language: currentLanguage,
      force,
    }),
  });
  requireLoginForUnauthorized(response);
  const data = await readOptionalJson(response);
  if (!response.ok || !data.ok) {
    throw new Error(
      data.message ||
        getAuthErrorMessage(data) ||
        t("backendReturned", { status: response.status })
    );
  }
  return data;
}

async function summarizeStoredPdfById(id, { showInChat = true } = {}) {
  const entry = findDocumentEntry(id);
  if (entry?.document.localWorkspace) {
    return summarizeLocalWorkspacePdf(id, { showInChat });
  }
  if (!entry?.document.objectKey) return null;
  const documentItem = entry.document;

  if (documentItem.summaryAvailable && documentItem.review) {
    if (showInChat) {
      const reviewMessage = formatPaperReview(
        documentItem.review,
        documentItem.filename
      );
      showReviewInSideChat(documentItem, reviewMessage);
    }
    return documentItem.review;
  }

  updateDocumentById(id, {
    processingStatus: "reviewing",
    reviewError: "",
  });
  renderAllDocumentLists();

  try {
    const reviewData = await requestStoredPdfSummary(documentItem);
    const extractedCharacterCount = Number(
      reviewData.extractedCharacterCount || 0
    );
    updateDocumentById(id, {
      processingStatus: "",
      review: reviewData,
      summaryAvailable: reviewData.summaryCached !== false,
      summaryUpdatedAt: reviewData.summaryUpdatedAt || new Date().toISOString(),
      extractedCharacterCount,
      extractedCharCount: extractedCharacterCount,
      originalCharacterCount: extractedCharacterCount,
      truncated: Boolean(reviewData.truncated),
      reviewError: reviewData.cacheWarning || "",
    });
    renderAllDocumentLists();

    if (reviewData.cacheWarning) {
      showToast(reviewData.cacheWarning);
    } else {
      showToast(t("summariesReady"));
    }
    if (showInChat) {
      const reviewMessage = formatPaperReview(reviewData, documentItem.filename);
      showReviewInSideChat(documentItem, reviewMessage);
    }
    return reviewData;
  } catch (error) {
    updateDocumentById(id, {
      processingStatus: "",
      reviewError: error.message || t("loginFailed"),
    });
    renderAllDocumentLists();
    showToast(
      t("pdfReviewFailed", {
        name: documentItem.filename,
        message: error.message || t("loginFailed"),
      })
    );
    return null;
  }
}

async function viewCachedLocalSummary(id) {
  const entry = findDocumentEntry(id);
  if (!entry?.document.localWorkspace || !literatureModule) return null;
  try {
    const summary = await literatureModule.loadSummary(id);
    if (!summary) return null;
    updateDocumentById(id, {
      review: summary,
      text: buildLocalSummaryContext(summary, entry.document.filename),
    });
    renderAllDocumentLists();
    showReviewInSideChat(
      entry.document,
      formatPaperReview(summary, entry.document.filename)
    );
    return summary;
  } catch (error) {
    updateDocumentById(id, { reviewError: error.message || t("loginFailed") });
    renderAllDocumentLists();
    showToast(error.message || t("loginFailed"));
    return null;
  }
}

async function summarizeLocalWorkspacePdf(id, { showInChat = true } = {}) {
  const entry = findDocumentEntry(id);
  if (!entry?.document.localWorkspace || !literatureModule) return null;
  const documentItem = entry.document;

  try {
    if (documentItem.summaryAvailable && documentItem.status !== "stale") {
      const cached = documentItem.review || (await literatureModule.loadSummary(id));
      if (cached) {
        updateDocumentById(id, {
          review: cached,
          text: buildLocalSummaryContext(cached, documentItem.filename),
          reviewError: "",
        });
        renderAllDocumentLists();
        if (showInChat) {
          showReviewInSideChat(
            { ...documentItem, localWorkspace: true },
            formatPaperReview(cached, documentItem.filename)
          );
        }
        return cached;
      }
    }

    updateDocumentById(id, {
      processingStatus: "reviewing",
      processingMessage: t("pdfExtractingLocal"),
      reviewError: "",
    });
    renderAllDocumentLists();
    activeLiteratureOperations += 1;
    const result = await literatureModule.summarize(id, {
      force: documentItem.status === "stale",
      signal: workspaceAbortController?.signal,
      onProgress(progress) {
        let processingMessage = t("pdfExtractingLocal");
        if (progress.stage === "summarizing") {
          processingMessage = t("pdfProcessingProgress", {
            done: progress.completed,
            total: progress.total,
          });
        } else if (progress.stage === "synthesizing") {
          processingMessage = t("pdfSynthesizing");
        }
        updateDocumentById(id, { processingMessage });
        renderAllDocumentLists();
      },
    });
    const summary = result.summary;
    updateDocumentById(id, {
      processingStatus: "",
      processingMessage: "",
      review: summary,
      text: buildLocalSummaryContext(summary, documentItem.filename),
      summaryAvailable: true,
      status: "ready",
      summaryUpdatedAt: summary.generatedAt,
      extractedCharacterCount: summary.source?.processedCharacters || 0,
      extractedCharCount: summary.source?.processedCharacters || 0,
      originalCharacterCount: summary.source?.processedCharacters || 0,
      truncated: Boolean(summary.source?.truncated),
      reviewError: "",
    });
    renderAllDocumentLists();
    showToast(t("summariesReady"));
    if (showInChat) {
      showReviewInSideChat(
        { ...documentItem, localWorkspace: true },
        formatPaperReview(summary, documentItem.filename)
      );
    }
    return summary;
  } catch (error) {
    if (error?.code !== "OPERATION_ABORTED") {
      updateDocumentById(id, {
        processingStatus: "",
        processingMessage: "",
        reviewError: error.message || t("loginFailed"),
      });
      renderAllDocumentLists();
      showToast(
        t("pdfReviewFailed", {
          name: documentItem.filename,
          message: error.message || t("loginFailed"),
        })
      );
    }
    return null;
  } finally {
    activeLiteratureOperations = Math.max(0, activeLiteratureOperations - 1);
  }
}

function showReviewInSideChat(documentItem, reviewMessage) {
  const question = t("summaryConversationQuestion", {
    name: documentItem.filename,
  });
  addSideChatMessage("user", question);
  addSideChatMessage("assistant", reviewMessage);
  activeSideChatDocumentKeys = documentItem.objectKey ? [documentItem.objectKey] : [];
  if (documentItem.localWorkspace) {
    updateDocumentById(documentItem.id, { selectedForChat: true });
    renderAllDocumentLists();
  }
  recordSideChatExchange(question, reviewMessage);
}

async function runWithConcurrency(items, concurrency, mapper) {
  const results = new Array(items.length);
  let nextIndex = 0;

  async function worker() {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await mapper(items[index], index);
    }
  }

  await Promise.all(
    Array.from(
      { length: Math.min(concurrency, items.length) },
      () => worker()
    )
  );
  return results;
}

async function clearDocumentCollection({
  documents,
  onUpdate,
  clearedMessage = t("referencesCleared"),
}) {
  const storedDocuments = documents.filter((documentItem) => documentItem.objectKey);
  if (
    storedDocuments.length &&
    !window.confirm(t("clearFilesConfirm"))
  ) {
    return;
  }

  const storedKeys = new Set(
    storedDocuments.map((documentItem) => documentItem.objectKey)
  );
  onUpdate(
    documents.map((documentItem) =>
      storedKeys.has(documentItem.objectKey)
        ? { ...documentItem, processingStatus: "deleting" }
        : documentItem
    )
  );

  const results = await runWithConcurrency(
    storedDocuments,
    3,
    async (documentItem) => {
      try {
        await deleteStoredPdfFromOss(documentItem);
        return { ok: true, documentItem };
      } catch (error) {
        return { ok: false, documentItem, error };
      }
    }
  );
  const failedKeys = new Set(
    results
      .filter((result) => !result.ok)
      .map((result) => result.documentItem.objectKey)
  );
  const nextDocuments = documents
    .filter(
      (documentItem) =>
        documentItem.objectKey && failedKeys.has(documentItem.objectKey)
    )
    .map((documentItem) => ({ ...documentItem, processingStatus: "" }));
  onUpdate(nextDocuments);

  activeSideChatDocumentKeys = activeSideChatDocumentKeys.filter(
    (key) => failedKeys.has(key) || !storedKeys.has(key)
  );
  saveSideChatMessages();
  results
    .filter((result) => !result.ok)
    .forEach((result) => {
      showToast(
        t("fileDeleteFailed", {
          name: result.documentItem.filename,
          message: result.error.message || t("loginFailed"),
        })
      );
    });
  if (!failedKeys.size) showToast(clearedMessage);
  renderAllDocumentLists();
}

function buildDocumentsForRequest(documents, maxFiles, totalLimit) {
  let remainingCharacters = totalLimit;

  return documents
    .slice(0, maxFiles)
    .map((documentItem) => {
      const sourceText = String(documentItem.text || "");
      const textForRequest = sourceText.slice(0, remainingCharacters);
      remainingCharacters = Math.max(0, remainingCharacters - textForRequest.length);

      return {
        filename: documentItem.filename,
        type: documentItem.type,
        module: documentItem.module || "",
        text: textForRequest,
        truncated:
          documentItem.truncated || textForRequest.length < sourceText.length,
        originalCharacterCount: documentItem.originalCharacterCount,
        extractedCharCount:
          documentItem.extractedCharCount || documentItem.extractedCharacterCount,
        sentCharacterCount: textForRequest.length,
      };
    })
    .filter((documentItem) => documentItem.text);
}

async function removeExperimentModuleDocument(_moduleKey, id) {
  await removeWorkspaceDocument(id);
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

async function runAgentInstruction(panelId) {
  if (activeAgentRequest) return;

  const panel = findAnalysisPanel(panelId);
  if (!panel || panel.frozen) return;

  const instruction = panel.instruction.trim();
  if (!instruction) {
    showToast(t("tellAgentFirst"));
    focusAnalysisPanelInstruction(panelId);
    return;
  }

  setAgentBusy(true, panelId);
  panel.statusKey = "agentReviewing";
  panel.status = "";
  saveAnalysisPanels();
  renderAnalysisPanels();
  renderBackendStatus("backendWorking");

  try {
    let response;

    if (!USE_BACKEND) {
      throw new Error(t("backendDisabled"));
    }

    let localWorkspaceContext = null;
    if (projectContextService && workspaceTree) {
      activeLiteratureOperations += 1;
      try {
        localWorkspaceContext = await projectContextService.buildContext({
          question: instruction,
          selectedPaths: [...selectedWorkspacePaths],
          selectedPaperIds: getSelectedPaperIds(),
          workspaceTree,
          projectGoal: getProjectContext(),
          signal: workspaceAbortController?.signal,
        });
        applyLiteratureScan(literatureModule.documents);
        applyPreparedContextToDocuments(localWorkspaceContext);
        renderWorkspaceExplorer();
        renderAllDocumentLists();
      } finally {
        activeLiteratureOperations = Math.max(0, activeLiteratureOperations - 1);
      }
    }

    response = await sendWorkbenchRequest({
      mode: "agent_instruction",
      messages: buildAgentMessages(instruction),
      localWorkspaceContext,
    });

    panel.recommendation = normalizeAgentResponse(response, instruction);
    panel.statusKey = "recommendationUpdated";
    panel.status = "";
    panel.collapsed = false;
    panel.updatedAt = new Date().toISOString();
    currentRecommendation = panel.recommendation;
    saveAnalysisPanels();
    renderAnalysisPanels();
    renderBackendStatus("backendConnected");
  } catch (error) {
    if (error instanceof AuthRequiredError) {
      console.warn("Backend auth required.", error);
      return;
    }

    console.warn("Agent backend failed; using local fallback.", error);
    panel.recommendation = createLocalRecommendation(instruction);
    panel.statusKey = "backendFallbackMessage";
    panel.status = "";
    panel.collapsed = false;
    panel.updatedAt = new Date().toISOString();
    currentRecommendation = panel.recommendation;
    saveAnalysisPanels();
    renderAnalysisPanels();
    renderBackendStatus("backendFallback");
  } finally {
    setAgentBusy(false);
    renderAnalysisPanels();
  }
}

function setAgentBusy(isBusy, panelId = "") {
  activeAgentRequest = isBusy;
  activeAgentPanelId = isBusy ? panelId : "";
}

// agent_instruction mode is the single official analysis action. It can update
// the Current Recommendation panel.
// side_chat mode is for questions only and must not mutate the recommendation.
async function sendWorkbenchRequest({ mode, messages, localWorkspaceContext = null }) {
  const isSideChat = mode === "side_chat";
  const includeLegacyExperimentEvidence = experimentModuleCards.length > 0;
  const experimentModulesPayload = buildExperimentModulesForRequest();
  const experimentDocumentsPayload = buildFlattenedExperimentDocumentsForRequest();
  const experimentNotesPayload = collectExperimentNotesForRequest();
  const manuallySelectedKeys = collectSelectedStoredDocumentKeys();
  const selectedDocumentKeys = manuallySelectedKeys.length
    ? manuallySelectedKeys
    : mode === "side_chat"
      ? activeSideChatDocumentKeys
      : [];
  const requestBody = {
    mode,
    messages,
    projectContext: getProjectContext(),
    referenceDocuments: isSideChat || localWorkspaceContext
      ? []
      : buildDocumentsForRequest(
          referenceDocuments,
          MAX_BROWSER_REFERENCE_FILES,
          TOTAL_REFERENCE_TEXT_LIMIT
        ),
    experimentModules:
      isSideChat || !includeLegacyExperimentEvidence ? {} : experimentModulesPayload,
    experimentDocuments:
      isSideChat || !includeLegacyExperimentEvidence ? [] : experimentDocumentsPayload,
    experimentNotes:
      isSideChat || !includeLegacyExperimentEvidence ? [] : experimentNotesPayload,
    storedDocuments: isSideChat ? [] : collectStoredDocumentsForRequest(),
    selectedDocumentKeys: isSideChat ? [] : selectedDocumentKeys,
    ...(localWorkspaceContext ? { localWorkspaceContext } : {}),
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

async function persistSideChatConversation() {
  if (!workspaceChatStore || !sideChatConversation) return;
  sideChatConversation = await workspaceChatStore.saveConversation({
    ...sideChatConversation,
    messages: sideChatMessages,
  });
  sideChatMessages = sideChatConversation.messages;
}

function saveSideChatMessages() {
  persistSideChatConversation().catch((error) => {
    console.warn("Could not persist Side Chat in the workspace.", error);
    showToast(t("chatPersistenceFailed"));
  });
}

function renderSideChatConversation() {
  sideChatHistory.innerHTML = "";
  const isEmpty = !sideChatMessages.length;
  setSideChatEmptyState(isEmpty);
  if (isEmpty) {
    addSideChatMessage("assistant", t("sideChatIntro"), { isIntro: true });
    return;
  }
  sideChatMessages.forEach((message) =>
    addSideChatMessage(message.role, message.content)
  );
}

function recordSideChatExchange(question, reply) {
  const timestamp = new Date().toISOString();
  sideChatMessages.push({
    id: makeId(),
    role: "user",
    content: question,
    context: getCurrentChatContextSnapshot(),
    createdAt: timestamp,
  });
  sideChatMessages.push({
    id: makeId(),
    role: "assistant",
    content: reply,
    createdAt: new Date().toISOString(),
  });
  saveSideChatMessages();
}

function getCurrentChatContextSnapshot() {
  const files = [...selectedWorkspacePaths].sort();
  const selectedPaperIds = getSelectedPaperIds();
  return {
    type: files.length ? "files" : "project",
    files,
    selectedPaperIds,
    relevantPaperIds: selectedPaperIds,
  };
}

function getSelectedPaperIds() {
  return (literatureModule?.documents || [])
    .filter(
      (document) =>
        document.isLiteraturePaper &&
        selectedWorkspacePaths.has(document.relativePath)
    )
    .map((document) => document.id);
}

function buildSideChatMessages(question, conversationContext) {
  const recentMessages = conversationContext?.recentMessages || [];
  const summary = conversationContext?.summary || "";

  return [
    ...recentMessages,
    {
      role: "user",
      content: [
        "Mode: side_chat",
        t("responseLanguageInstruction"),
        "Answer this as a question only. Do not claim to update the current recommendation.",
        "Use only the supplied local-workspace evidence. File inventory without processed evidence is not file content.",
        "Keep the response at design-review and planning level.",
        summary ? `Earlier conversation summary:\n${summary}` : "",
        "",
        `Question: ${question}`,
      ]
        .filter(Boolean)
        .join("\n"),
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

function collectStoredDocumentsForRequest() {
  return [...referenceDocuments, ...collectExperimentDocuments()]
    .filter(
      (documentItem) =>
        typeof documentItem.objectKey === "string" &&
        documentItem.objectKey &&
        !documentItem.processingStatus
    )
    .slice(0, MAX_REFERENCE_FILES)
    .map((documentItem) => ({
      objectKey: documentItem.objectKey,
      module: documentItem.module || "",
      summaryAvailable: documentItem.summaryAvailable === true,
    }));
}

function collectSelectedStoredDocumentKeys() {
  return getStoredWorkspaceDocuments()
    .filter((documentItem) => documentItem.selectedForChat)
    .map((documentItem) => documentItem.objectKey)
    .slice(0, MAX_SELECTED_CHAT_PDFS);
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

function renderAnalysisPanels() {
  currentRecommendation = getCurrentRecommendation();
  analysisPanelStack.innerHTML = "";

  analysisPanels.forEach((panel, index) => {
    analysisPanelStack.appendChild(createAnalysisPanelElement(panel, index));
  });
}

function createAnalysisPanelElement(panel, index) {
  const article = document.createElement("article");
  article.className = "analysis-panel";
  article.classList.toggle("is-frozen", Boolean(panel.frozen));
  article.classList.toggle("is-collapsed", Boolean(panel.collapsed));
  article.dataset.panelId = panel.id;

  const header = document.createElement("div");
  header.className = "analysis-panel-header";

  const titleGroup = document.createElement("div");
  const title = document.createElement("h3");
  title.textContent = t("analysisPanelTitle", { number: index + 1 });

  const meta = document.createElement("p");
  meta.className = "analysis-panel-meta";
  meta.textContent = [
    panel.frozen ? t("frozenPanel") : t("activePanel"),
    t("panelCreatedAt", { time: formatTimestamp(panel.createdAt) }),
  ].join(" · ");

  titleGroup.append(title, meta);

  const toggleButton = createAnalysisActionButton({
    panel,
    action: "toggle",
    label: panel.collapsed ? t("expandPanel") : t("collapsePanel"),
    className: "text-button",
  });

  header.append(titleGroup, toggleButton);
  article.appendChild(header);

  if (panel.collapsed) {
    const summary = document.createElement("p");
    summary.className = "analysis-panel-summary";
    summary.textContent = panel.instruction || t("noInstructionYet");
    article.appendChild(summary);
    return article;
  }

  const body = document.createElement("div");
  body.className = "analysis-panel-body";
  body.append(createInstructionPane(panel), createRecommendationPane(panel));
  article.appendChild(body);

  return article;
}

function createInstructionPane(panel) {
  const pane = document.createElement("section");
  pane.className = "analysis-pane analysis-command-pane";

  const header = document.createElement("div");
  header.className = "analysis-pane-header";

  const eyebrow = document.createElement("p");
  eyebrow.className = "eyebrow";
  eyebrow.textContent = t("agentEyebrow");

  const title = document.createElement("h3");
  title.textContent = t("agentTitle");
  header.append(eyebrow, title);
  pane.appendChild(header);

  if (panel.frozen) {
    const notice = document.createElement("p");
    notice.className = "frozen-panel-notice";
    notice.textContent = t("frozenPanelNotice");
    pane.appendChild(notice);

    const frozenInstruction = document.createElement("div");
    frozenInstruction.className = "frozen-instruction";
    frozenInstruction.textContent = panel.instruction || t("noInstructionYet");
    pane.appendChild(frozenInstruction);
  } else {
    const label = document.createElement("label");
    label.className = "sr-only";
    label.setAttribute("for", `agentInstruction-${panel.id}`);
    label.textContent = t("agentTitle");

    const textarea = document.createElement("textarea");
    textarea.id = `agentInstruction-${panel.id}`;
    textarea.rows = 8;
    textarea.placeholder = t("agentPlaceholder");
    textarea.value = panel.instruction || "";
    textarea.dataset.analysisInstruction = "true";
    textarea.dataset.panelId = panel.id;
    textarea.disabled = activeAgentRequest;

    const actions = document.createElement("div");
    actions.className = "agent-actions";
    actions.append(
      createAnalysisActionButton({
        panel,
        action: "run",
        label: t("analyzeRecommend"),
        className: "primary-button",
        disabled: activeAgentRequest,
      }),
      createAnalysisActionButton({
        panel,
        action: "clear",
        label: t("clearInstruction"),
        className: "text-button",
        disabled: activeAgentRequest,
      })
    );

    pane.append(label, textarea, actions);
  }

  const status = document.createElement("p");
  status.className = "agent-status";
  status.textContent = getAnalysisPanelStatus(panel);
  pane.appendChild(status);

  return pane;
}

function createRecommendationPane(panel) {
  const recommendation = panel.recommendation || createDefaultRecommendation();
  const pane = document.createElement("section");
  pane.className = "analysis-pane analysis-recommendation-pane";

  const header = document.createElement("div");
  header.className = "analysis-pane-header recommendation-pane-header";

  const titleGroup = document.createElement("div");
  const eyebrow = document.createElement("p");
  eyebrow.className = "eyebrow";
  eyebrow.textContent = t("recommendationEyebrow");
  const title = document.createElement("h3");
  title.textContent = t("recommendationTitle");
  titleGroup.append(eyebrow, title);

  const actions = document.createElement("div");
  actions.className = "panel-actions";
  actions.append(
    createAnalysisActionButton({
      panel,
      action: "export",
      label: t("exportMarkdown"),
      className: "secondary-button",
    }),
    createAnalysisActionButton({
      panel,
      action: "copy",
      label: t("copyRecommendation"),
      className: "secondary-button",
    }),
    createAnalysisActionButton({
      panel,
      action: "review",
      label: t("markReviewed"),
      className: "secondary-button",
      disabled: panel.frozen || recommendation.reviewed,
    })
  );

  header.append(titleGroup, actions);

  const review = document.createElement("div");
  review.className = "review-status";
  review.classList.toggle("is-reviewed", Boolean(recommendation.reviewed));
  review.textContent = recommendation.reviewed
    ? t("reviewedByHuman")
    : t("humanReviewRequired");

  const sections = document.createElement("div");
  sections.className = "recommendation-sections";
  sections.append(
    createRecommendationTextSection(
      t("currentInterpretationHeading"),
      recommendation.currentInterpretation
    ),
    createRecommendationListSection(
      t("keyEvidenceHeading"),
      recommendation.keyEvidenceUsed
    ),
    createRecommendationTextSection(
      t("possibleExplanationHeading"),
      recommendation.possibleExplanation
    ),
    createRecommendationTextSection(
      t("recommendedNextStepHeading"),
      recommendation.recommendedNextStep
    ),
    createRecommendationTextSection(
      t("additionalAnalysisHeading"),
      recommendation.additionalAnalysisSuggested
    ),
    createRecommendationListSection(
      t("missingInformationHeading"),
      recommendation.missingInformation
    ),
    createRecommendationTextSection(
      t("humanReviewHeading"),
      recommendation.humanReviewNotes
    ),
    createRecommendationTextSection(
      t("draftSummaryHeading"),
      recommendation.draftSummary,
      "memo-section"
    )
  );

  pane.append(header, review, sections);
  return pane;
}

function createRecommendationTextSection(heading, value, extraClass = "") {
  const section = document.createElement("section");
  if (extraClass) section.classList.add(extraClass);

  const title = document.createElement("h3");
  title.textContent = heading;

  const body = document.createElement(extraClass === "memo-section" ? "div" : "p");
  body.className = extraClass === "memo-section" ? "memo-preview" : "";
  body.textContent = value || t("notAvailable");

  section.append(title, body);
  return section;
}

function createRecommendationListSection(heading, items) {
  const section = document.createElement("section");
  const title = document.createElement("h3");
  title.textContent = heading;

  const list = document.createElement("ul");
  renderList(list, items);

  section.append(title, list);
  return section;
}

function createAnalysisActionButton({
  panel,
  action,
  label,
  className,
  disabled = false,
}) {
  const button = document.createElement("button");
  button.className = className;
  button.type = "button";
  button.textContent = label;
  button.dataset.analysisAction = action;
  button.dataset.panelId = panel.id;
  button.disabled = disabled;
  return button;
}

function addAnalysisPanel() {
  analysisPanels = analysisPanels.map((panel) => ({
    ...panel,
    frozen: true,
    collapsed: true,
  }));

  const nextPanel = createAnalysisPanel();
  analysisPanels.push(nextPanel);
  currentRecommendation = nextPanel.recommendation;
  saveAnalysisPanels();
  renderAnalysisPanels();
  focusAnalysisPanelInstruction(nextPanel.id);
}

function createAnalysisPanel(overrides = {}) {
  return {
    id: makeId(),
    createdAt: new Date().toISOString(),
    updatedAt: "",
    instruction: "",
    recommendation: createDefaultRecommendation(),
    frozen: false,
    collapsed: false,
    statusKey: "",
    status: "",
    ...overrides,
  };
}

function findAnalysisPanel(panelId) {
  return analysisPanels.find((panel) => panel.id === panelId);
}

function getActiveAnalysisPanel() {
  return (
    analysisPanels.find((panel) => !panel.frozen) ||
    analysisPanels[analysisPanels.length - 1]
  );
}

function getCurrentRecommendation() {
  return (
    getActiveAnalysisPanel()?.recommendation ||
    analysisPanels[analysisPanels.length - 1]?.recommendation ||
    createDefaultRecommendation()
  );
}

function getAnalysisPanelStatus(panel) {
  if (panel.statusKey) return t(panel.statusKey);
  if (panel.status) return panel.status;
  return panel.frozen ? t("frozenPanel") : t("readyForAnalysis");
}

function refreshDefaultAnalysisPanels() {
  let didChange = false;
  analysisPanels = analysisPanels.map((panel) => {
    if (panel.recommendation?.updatedAt) return panel;
    didChange = true;
    return {
      ...panel,
      recommendation: createDefaultRecommendation(),
    };
  });

  currentRecommendation = getCurrentRecommendation();
  if (didChange) saveAnalysisPanels();
}

function focusAnalysisPanelInstruction(panelId) {
  window.requestAnimationFrame(() => {
    const input = analysisPanelStack.querySelector(
      `[data-analysis-instruction][data-panel-id="${panelId}"]`
    );
    input?.focus();
  });
}

function exportRecommendation(recommendation) {
  const markdown = buildMarkdownExport(recommendation);
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
}

function setSideChatBusy(isBusy) {
  sideChatBusy = isBusy;
  sideChatInput.disabled = isBusy;
  sendSideChatButton.disabled = isBusy;
  clearSideChatButton.disabled = isBusy;
  sendSideChatButton.textContent = isBusy ? t("thinking") : t("askButton");
}

function addSideChatThinking() {
  const message = document.createElement("article");
  message.className = "side-message assistant thinking-message";
  message.setAttribute("role", "status");
  message.setAttribute("aria-label", t("thinking"));

  const label = document.createElement("strong");
  label.textContent = t("sideChatAssistantLabel");
  const body = document.createElement("div");
  body.className = "thinking-content";
  const text = document.createElement("span");
  text.textContent = t("thinking");
  const dots = document.createElement("span");
  dots.className = "thinking-dots";
  dots.setAttribute("aria-hidden", "true");
  dots.append(
    document.createElement("span"),
    document.createElement("span"),
    document.createElement("span")
  );
  body.append(text, dots);
  message.append(label, body);
  sideChatHistory.appendChild(message);
  sideChatHistory.scrollTop = sideChatHistory.scrollHeight;
  return message;
}

async function askSideChat(question) {
  if (
    !question ||
    sideChatBusy ||
    !projectContextService ||
    !sideChatConversation ||
    !workspaceTree
  ) {
    return;
  }

  const conversationContext = projectContextService.buildConversationContext(
    sideChatConversation
  );
  const contextSnapshot = getCurrentChatContextSnapshot();
  const userMessage = {
    id: makeId(),
    role: "user",
    content: question,
    context: contextSnapshot,
    createdAt: new Date().toISOString(),
  };
  sideChatMessages.push(userMessage);
  addSideChatMessage("user", question);
  const thinkingMessage = addSideChatThinking();
  setSideChatBusy(true);
  let contextPrepared = false;

  try {
    activeLiteratureOperations += 1;
    const localWorkspaceContext = await projectContextService.buildContext({
      question,
      selectedPaths: contextSnapshot.files,
      selectedPaperIds: contextSnapshot.selectedPaperIds,
      workspaceTree,
      projectGoal: getProjectContext(),
      conversation: sideChatConversation,
      signal: workspaceAbortController?.signal,
      onProgress(progress) {
        updateSideChatThinking(thinkingMessage, progress);
      },
    });
    userMessage.context.relevantPaperIds = [
      ...(localWorkspaceContext.literature?.relevantPaperIds || []),
    ];
    contextPrepared = true;
    applyLiteratureScan(literatureModule.documents);
    applyPreparedContextToDocuments(localWorkspaceContext);

    let reply;
    const selectedEvidence = localWorkspaceContext.files || [];
    if (
      contextSnapshot.type === "files" &&
      selectedEvidence.length &&
      selectedEvidence.every((file) => file.analysisStatus === "unsupported") &&
      questionRequiresFileEvidence(question)
    ) {
      reply = t("unsupportedSelectedFilesChat");
    } else {
      const messagesForBackend = buildSideChatMessages(question, conversationContext);
      const response = await sendWorkbenchRequest({
        mode: "side_chat",
        messages: messagesForBackend,
        localWorkspaceContext,
      });
      reply = response.reply || t("sideChatNoAnswer");
    }

    addSideChatMessage("assistant", reply);
    sideChatMessages.push({
      id: makeId(),
      role: "assistant",
      content: reply,
      createdAt: new Date().toISOString(),
    });
    await persistSideChatConversation();
  } catch (error) {
    if (error instanceof AuthRequiredError) {
      console.warn("Backend auth required.", error);
      await persistSideChatConversation().catch(() => {});
      return;
    }

    console.warn("Side chat backend failed; using local fallback.", error);
    const reply = contextPrepared
      ? `${t("backendFallbackMessage")}\n\n${buildLocalSideChatReply(question)}`
      : t("sideChatContextFailed", { message: error.message || t("loginFailed") });
    addSideChatMessage("assistant", reply);
    sideChatMessages.push({
      id: makeId(),
      role: "assistant",
      content: reply,
      createdAt: new Date().toISOString(),
    });
    await persistSideChatConversation().catch(() => {});
  } finally {
    activeLiteratureOperations = Math.max(0, activeLiteratureOperations - 1);
    thinkingMessage.remove();
    setSideChatBusy(false);
    sideChatInput.focus();
  }
}

function updateSideChatThinking(message, progress) {
  const text = message.querySelector(".thinking-content > span:first-child");
  if (!text) return;
  if (progress.stage === "summarizing") {
    text.textContent = t("sideChatProcessingPdf", {
      name: progress.relativePath?.split("/").pop() || "PDF",
      done: progress.completed,
      total: progress.total,
    });
  } else if (progress.stage === "synthesizing") {
    text.textContent = t("sideChatSynthesizingPdf", {
      name: progress.relativePath?.split("/").pop() || "PDF",
    });
  } else if (progress.stage === "extracting-detail") {
    text.textContent = t("sideChatReadingDetail", {
      name: progress.relativePath?.split("/").pop() || "PDF",
    });
  } else if (progress.stage === "preparing-file" || progress.stage === "extracting") {
    text.textContent = t("sideChatPreparingPdf", {
      name: progress.relativePath?.split("/").pop() || "PDF",
    });
  }
}

function setSideChatEmptyState(isEmpty) {
  sideChatExamples.hidden = !isEmpty;
}

function isMarkdownBlockStart(lines, index) {
  const line = lines[index] || "";
  const nextLine = lines[index + 1] || "";
  return (
    /^\s*```/.test(line) ||
    /^\s{0,3}#{1,6}\s+/.test(line) ||
    /^\s{0,3}>\s?/.test(line) ||
    /^\s*(?:[-+*]|\d+\.)\s+/.test(line) ||
    /^\s*\$\$/.test(line) ||
    /^\s{0,3}(?:-{3,}|\*{3,}|_{3,})\s*$/.test(line) ||
    (line.includes("|") && isMarkdownTableDivider(nextLine))
  );
}

function isMarkdownTableDivider(line) {
  const cells = splitMarkdownTableRow(line);
  return (
    cells.length > 1 &&
    cells.every((cell) => /^:?-{3,}:?$/.test(cell.trim()))
  );
}

function splitMarkdownTableRow(line) {
  let value = String(line || "").trim();
  if (value.startsWith("|")) value = value.slice(1);
  if (value.endsWith("|") && !value.endsWith("\\|")) value = value.slice(0, -1);

  const cells = [];
  let cell = "";
  let escaped = false;
  for (const character of value) {
    if (escaped) {
      cell += character;
      escaped = false;
    } else if (character === "\\") {
      escaped = true;
    } else if (character === "|") {
      cells.push(cell.trim());
      cell = "";
    } else {
      cell += character;
    }
  }
  if (escaped) cell += "\\";
  cells.push(cell.trim());
  return cells;
}

function appendSideChatInlineMarkdown(parent, value, depth = 0) {
  const text = String(value || "");
  if (!text || depth > 4) {
    parent.appendChild(document.createTextNode(text));
    return;
  }

  const tokenPattern = /(?<displayMath>(?<!\\)\$\$[^$\n]+?\$\$)|(?<inlineMath>(?<!\\)\$(?!\$)(?:\\.|[^$\\\n])+?(?<!\\)\$)|`(?<code>[^`\n]+)`|\[(?<linkText>[^\]\n]+)\]\((?<href>[^)\s]+)(?:\s+"[^"]*")?\)|\*\*(?<strongA>[^*\n]+)\*\*|__(?<strongB>[^_\n]+)__|~~(?<deleted>[^~\n]+)~~|\*(?<emphasisA>[^*\n]+)\*|_(?<emphasisB>[^_\n]+)_/g;
  let cursor = 0;
  let match;

  while ((match = tokenPattern.exec(text))) {
    if (match.index > cursor) {
      parent.appendChild(document.createTextNode(text.slice(cursor, match.index)));
    }

    const groups = match.groups || {};
    let element;
    if (groups.displayMath !== undefined || groups.inlineMath !== undefined) {
      element = document.createElement("span");
      element.className = "side-math-source";
      element.textContent = groups.displayMath || groups.inlineMath;
    } else if (groups.code !== undefined) {
      element = document.createElement("code");
      element.textContent = groups.code;
    } else if (groups.linkText !== undefined) {
      const href = groups.href;
      if (/^(?:https?:|mailto:)/i.test(href)) {
        element = document.createElement("a");
        element.href = href;
        if (/^https?:/i.test(href)) {
          element.target = "_blank";
          element.rel = "noopener noreferrer";
        }
        appendSideChatInlineMarkdown(element, groups.linkText, depth + 1);
      } else {
        element = document.createTextNode(match[0]);
      }
    } else {
      const tagName =
        groups.strongA !== undefined || groups.strongB !== undefined
          ? "strong"
          : groups.deleted !== undefined
            ? "del"
            : "em";
      const innerText =
        groups.strongA ??
        groups.strongB ??
        groups.deleted ??
        groups.emphasisA ??
        groups.emphasisB ??
        "";
      element = document.createElement(tagName);
      appendSideChatInlineMarkdown(element, innerText, depth + 1);
    }

    parent.appendChild(element);
    cursor = tokenPattern.lastIndex;
  }

  if (cursor < text.length) {
    parent.appendChild(document.createTextNode(text.slice(cursor)));
  }
}

function appendSideChatMarkdownLines(parent, lines) {
  lines.forEach((line, index) => {
    appendSideChatInlineMarkdown(parent, line);
    if (index < lines.length - 1) parent.appendChild(document.createElement("br"));
  });
}

function renderSideChatMath(container) {
  if (typeof window.renderMathInElement !== "function") return;
  try {
    window.renderMathInElement(container, {
      delimiters: [
        { left: "$$", right: "$$", display: true },
        { left: "$", right: "$", display: false },
        { left: "\\(", right: "\\)", display: false },
        { left: "\\[", right: "\\]", display: true },
      ],
      ignoredTags: ["script", "noscript", "style", "textarea", "pre", "code", "option"],
      throwOnError: false,
      strict: "ignore",
      trust: false,
    });
  } catch (error) {
    console.warn("Side Chat math rendering failed; preserving the TeX source.", error);
  }
}

function renderSideChatMarkdown(container, content) {
  const lines = String(content || "").replace(/\r\n?/g, "\n").split("\n");
  const fragment = document.createDocumentFragment();
  let index = 0;

  while (index < lines.length) {
    const line = lines[index];
    if (!line.trim()) {
      index += 1;
      continue;
    }

    if (/^\s*\$\$/.test(line)) {
      const mathLines = [];
      let closed = false;
      let firstLine = line.replace(/^\s*\$\$/, "");
      const sameLineClose = firstLine.match(/^(.*?)\$\$\s*$/);
      if (sameLineClose) {
        mathLines.push(sameLineClose[1]);
        closed = true;
        index += 1;
      } else {
        if (firstLine) mathLines.push(firstLine);
        index += 1;
        while (index < lines.length) {
          const closeIndex = lines[index].indexOf("$$");
          if (closeIndex >= 0) {
            mathLines.push(lines[index].slice(0, closeIndex));
            closed = true;
            index += 1;
            break;
          }
          mathLines.push(lines[index]);
          index += 1;
        }
      }
      const mathBlock = document.createElement("div");
      mathBlock.className = "side-math-source";
      mathBlock.textContent = `$$${mathLines.join("\n")}${closed ? "$$" : ""}`;
      fragment.appendChild(mathBlock);
      continue;
    }

    const fence = line.match(/^\s*```([^\s`]*)\s*$/);
    if (fence) {
      const codeLines = [];
      index += 1;
      while (index < lines.length && !/^\s*```\s*$/.test(lines[index])) {
        codeLines.push(lines[index]);
        index += 1;
      }
      if (index < lines.length) index += 1;
      const pre = document.createElement("pre");
      const code = document.createElement("code");
      code.textContent = codeLines.join("\n");
      if (fence[1]) code.dataset.language = fence[1].toLowerCase();
      pre.appendChild(code);
      fragment.appendChild(pre);
      continue;
    }

    const heading = line.match(/^\s{0,3}(#{1,6})\s+(.+)$/);
    if (heading) {
      const element = document.createElement(`h${heading[1].length}`);
      appendSideChatInlineMarkdown(element, heading[2]);
      fragment.appendChild(element);
      index += 1;
      continue;
    }

    if (/^\s{0,3}>\s?/.test(line)) {
      const quoteLines = [];
      while (index < lines.length && /^\s{0,3}>\s?/.test(lines[index])) {
        quoteLines.push(lines[index].replace(/^\s{0,3}>\s?/, ""));
        index += 1;
      }
      const blockquote = document.createElement("blockquote");
      appendSideChatMarkdownLines(blockquote, quoteLines);
      fragment.appendChild(blockquote);
      continue;
    }

    const listItem = line.match(/^\s*(?:([-+*])|(\d+)\.)\s+(.+)$/);
    if (listItem) {
      const ordered = listItem[2] !== undefined;
      const list = document.createElement(ordered ? "ol" : "ul");
      if (ordered && Number(listItem[2]) !== 1) list.start = Number(listItem[2]);
      while (index < lines.length) {
        const itemMatch = lines[index].match(/^\s*(?:([-+*])|(\d+)\.)\s+(.+)$/);
        if (!itemMatch || (itemMatch[2] !== undefined) !== ordered) break;
        const item = document.createElement("li");
        appendSideChatInlineMarkdown(item, itemMatch[3]);
        list.appendChild(item);
        index += 1;
      }
      fragment.appendChild(list);
      continue;
    }

    if (/^\s{0,3}(?:-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
      fragment.appendChild(document.createElement("hr"));
      index += 1;
      continue;
    }

    if (line.includes("|") && isMarkdownTableDivider(lines[index + 1] || "")) {
      const headings = splitMarkdownTableRow(line);
      const alignments = splitMarkdownTableRow(lines[index + 1]).map((cell) => ({
        left: cell.startsWith(":"),
        right: cell.endsWith(":"),
      }));
      const table = document.createElement("table");
      const head = document.createElement("thead");
      const headRow = document.createElement("tr");
      headings.forEach((cell, cellIndex) => {
        const headingCell = document.createElement("th");
        const alignment = alignments[cellIndex];
        if (alignment?.left && alignment.right) headingCell.style.textAlign = "center";
        else if (alignment?.right) headingCell.style.textAlign = "right";
        appendSideChatInlineMarkdown(headingCell, cell);
        headRow.appendChild(headingCell);
      });
      head.appendChild(headRow);
      table.appendChild(head);
      index += 2;

      const body = document.createElement("tbody");
      while (index < lines.length && lines[index].includes("|") && lines[index].trim()) {
        const row = document.createElement("tr");
        splitMarkdownTableRow(lines[index]).forEach((cell, cellIndex) => {
          const tableCell = document.createElement("td");
          const alignment = alignments[cellIndex];
          if (alignment?.left && alignment.right) tableCell.style.textAlign = "center";
          else if (alignment?.right) tableCell.style.textAlign = "right";
          appendSideChatInlineMarkdown(tableCell, cell);
          row.appendChild(tableCell);
        });
        body.appendChild(row);
        index += 1;
      }
      table.appendChild(body);
      fragment.appendChild(table);
      continue;
    }

    const paragraphLines = [line];
    index += 1;
    while (
      index < lines.length &&
      lines[index].trim() &&
      !isMarkdownBlockStart(lines, index)
    ) {
      paragraphLines.push(lines[index]);
      index += 1;
    }
    const paragraph = document.createElement("p");
    appendSideChatMarkdownLines(paragraph, paragraphLines);
    fragment.appendChild(paragraph);
  }

  container.replaceChildren(fragment);
  renderSideChatMath(container);
}

function addSideChatMessage(role, content, { isIntro = false } = {}) {
  if (!isIntro) {
    setSideChatEmptyState(false);
    sideChatHistory.querySelector("[data-side-chat-intro]")?.remove();
  }

  const message = document.createElement("article");
  message.className = `side-message ${role}`;
  if (isIntro) message.dataset.sideChatIntro = "true";

  const label = document.createElement("strong");
  label.textContent =
    role === "user" ? t("sideChatUserLabel") : t("sideChatAssistantLabel");

  const body = document.createElement("div");
  body.className = "side-message-body";
  renderSideChatMarkdown(body, content);

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

function saveAnalysisPanels() {
  currentRecommendation = getCurrentRecommendation();
  sessionStorage.setItem(
    ANALYSIS_PANELS_STORAGE_KEY,
    JSON.stringify(analysisPanels)
  );
  saveCurrentRecommendation();
}

function loadAnalysisPanels() {
  const storedPanels = loadSessionJson(ANALYSIS_PANELS_STORAGE_KEY, []);

  if (Array.isArray(storedPanels) && storedPanels.length) {
    const normalizedPanels = storedPanels
      .map(normalizeStoredAnalysisPanel)
      .filter(Boolean);

    if (normalizedPanels.length) {
      return ensureOneEditableAnalysisPanel(normalizedPanels);
    }
  }

  const legacyRecommendation = loadSessionJson(RECOMMENDATION_STORAGE_KEY, null);
  const recommendation =
    legacyRecommendation &&
    typeof legacyRecommendation === "object" &&
    !Array.isArray(legacyRecommendation)
      ? normalizeRecommendation(legacyRecommendation)
      : createDefaultRecommendation();

  return [
    createAnalysisPanel({
      recommendation,
    }),
  ];
}

function normalizeStoredAnalysisPanel(panel) {
  if (!panel || typeof panel !== "object") return null;

  return createAnalysisPanel({
    id: typeof panel.id === "string" && panel.id ? panel.id : makeId(),
    createdAt:
      typeof panel.createdAt === "string" && panel.createdAt
        ? panel.createdAt
        : new Date().toISOString(),
    updatedAt:
      typeof panel.updatedAt === "string" && panel.updatedAt ? panel.updatedAt : "",
    instruction:
      typeof panel.instruction === "string" ? panel.instruction : "",
    recommendation: normalizeRecommendation(panel.recommendation),
    frozen: Boolean(panel.frozen),
    collapsed: Boolean(panel.collapsed),
    statusKey:
      typeof panel.statusKey === "string" && panel.statusKey ? panel.statusKey : "",
    status: typeof panel.status === "string" && panel.status ? panel.status : "",
  });
}

function normalizeRecommendation(recommendation) {
  const fallback = createDefaultRecommendation();

  if (!recommendation || typeof recommendation !== "object") {
    return fallback;
  }

  return {
    ...fallback,
    ...recommendation,
    keyEvidenceUsed: Array.isArray(recommendation.keyEvidenceUsed)
      ? recommendation.keyEvidenceUsed
      : fallback.keyEvidenceUsed,
    missingInformation: Array.isArray(recommendation.missingInformation)
      ? recommendation.missingInformation
      : fallback.missingInformation,
    reviewed: Boolean(recommendation.reviewed),
    updatedAt:
      typeof recommendation.updatedAt === "string"
        ? recommendation.updatedAt
        : fallback.updatedAt,
  };
}

function ensureOneEditableAnalysisPanel(panels) {
  const editablePanels = panels.filter((panel) => !panel.frozen);

  if (editablePanels.length === 1) return panels;

  return panels.map((panel, index) => ({
    ...panel,
    frozen: index < panels.length - 1,
    collapsed: index < panels.length - 1 ? true : panel.collapsed,
  }));
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

function formatFileSize(value) {
  const bytes = Number(value);
  if (!Number.isFinite(bytes) || bytes <= 0) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
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
