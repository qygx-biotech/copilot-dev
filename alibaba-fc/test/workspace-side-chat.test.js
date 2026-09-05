const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const {
  buildLocalWorkspaceContext,
  createSideChatKnowledgeBase,
  executeSideChatTool,
  sanitizeLocalWorkspaceContext,
} = require("../index.js")._test;

test("local workspace chat context is whitelisted, bounded, and explicit about inventory", () => {
  const sanitized = sanitizeLocalWorkspaceContext({
    schemaVersion: 1,
    scope: {
      type: "files",
      files: ["literature/paper1.pdf", "experiments/run.xlsx"],
    },
    literature: {
      selectedPaperIds: ["paper-a"],
      relevantPaperIds: ["paper-a"],
      discoveryMode: "selected",
      retrievalRequired: true,
    },
    project: {
      workspaceName: "EctD Project",
      goal: "Improve EctD activity",
      projectSummary: "Early-stage comparison",
      apiKey: "must-not-survive",
    },
    inventory: [
      {
        paperId: "paper-a",
        name: "paper1.pdf",
        relativePath: "literature/paper1.pdf",
        extension: "pdf",
        size: 1200,
        processor: "pdf",
        summaryAvailable: true,
        summaryStatus: "ready",
      },
      {
        name: "run.xlsx",
        relativePath: "experiments/run.xlsx",
        extension: "xlsx",
        size: 800,
        processor: null,
        summaryAvailable: false,
      },
    ],
    files: [
      {
        paperId: "paper-a",
        name: "paper1.pdf",
        relativePath: "literature/paper1.pdf",
        extension: "pdf",
        analysisStatus: "processed",
        evidenceType: "cached-summary",
        content: "The cached paper understanding.",
      },
      {
        name: "run.xlsx",
        relativePath: "experiments/run.xlsx",
        extension: "xlsx",
        analysisStatus: "unsupported",
        evidenceType: "inventory-only",
        content: "",
      },
    ],
    notices: [
      "experiments/run.xlsx is selected, but .xlsx files do not yet have an AI content processor.",
    ],
    authToken: "must-not-survive",
  });

  assert.equal(sanitized.scope.type, "files");
  assert.deepEqual(sanitized.literature.selectedPaperIds, ["paper-a"]);
  assert.deepEqual(sanitized.literature.relevantPaperIds, ["paper-a"]);
  assert.equal(sanitized.literature.discoveryMode, "selected");
  assert.deepEqual(sanitized.scope.files, [
    "literature/paper1.pdf",
    "experiments/run.xlsx",
  ]);
  assert.equal(sanitized.files[0].content, "The cached paper understanding.");
  assert.equal(sanitized.files[1].analysisStatus, "unsupported");
  assert.equal(Object.hasOwn(sanitized.project, "apiKey"), false);
  assert.equal(Object.hasOwn(sanitized, "authToken"), false);

  const prompt = buildLocalWorkspaceContext(sanitized);
  assert.match(prompt, /Original files remain local/i);
  assert.match(prompt, /inventory \(metadata only/i);
  assert.match(prompt, /status: unsupported/i);
  assert.match(prompt, /do not yet have an AI content processor/i);
  assert.match(prompt, /The cached paper understanding/);
  assert.match(prompt, /Explicitly selected paper IDs: paper-a/);
  assert.match(prompt, /Paper IDs used for this turn: paper-a/);
  assert.match(prompt, /Pre-answer context router:/);
});

test("invalid local workspace context is ignored rather than trusted", () => {
  assert.equal(sanitizeLocalWorkspaceContext(null), null);
  assert.equal(sanitizeLocalWorkspaceContext([]), null);
  assert.equal(buildLocalWorkspaceContext(null), null);
});

test("host paper source IDs and bounded evidence survive FC sanitization as one readable catalog paper", () => {
  const sourceId = "source-uuid-5";
  const sanitized = sanitizeLocalWorkspaceContext({
    scope: { type: "project", files: [] },
    sourceMap: {
      selectedPaperIds: [],
      paperSources: [{
        sourceId,
        sourceKind: "paper",
        path: "literature/paper-five.pdf",
        displayName: "paper-five.pdf",
        catalogStatus: "present",
        parseStatus: "ready",
        indexStatus: "ready",
      }],
    },
    inventory: [{
      paperId: sourceId,
      sourceId,
      sourceKind: "paper",
      name: "paper-five.pdf",
      relativePath: "literature/paper-five.pdf",
      extension: "pdf",
      processor: "pdf",
    }],
    files: [{
      paperId: sourceId,
      sourceId,
      name: "paper-five.pdf",
      relativePath: "literature/paper-five.pdf",
      extension: "pdf",
      analysisStatus: "processed",
      evidenceType: "parsed-paper-evidence",
      content: "Bounded evidence marker five.",
    }],
  });
  assert.equal(sanitized.sourceMap.paperSources[0].sourceId, sourceId);
  assert.equal(sanitized.inventory[0].sourceId, sourceId);
  assert.equal(sanitized.files[0].sourceId, sourceId);

  const knowledgeBase = createSideChatKnowledgeBase({
    localWorkspaceContext: sanitized,
  });
  const search = JSON.parse(executeSideChatTool(
    {
      id: "search-five",
      type: "function",
      function: {
        name: "search_papers",
        arguments: JSON.stringify({ query: "marker five" }),
      },
    },
    knowledgeBase
  ));
  assert.equal(search.results[0].paper_id, sourceId);
  assert.equal(search.results[0].item_id, "local:1");
  assert.equal(search.results[0].content_available, true);
  const read = JSON.parse(executeSideChatTool(
    {
      id: "read-five",
      type: "function",
      function: {
        name: "read_paper_evidence",
        arguments: JSON.stringify({ item_id: search.results[0].item_id }),
      },
    },
    knowledgeBase
  ));
  assert.equal(read.paper_id, sourceId);
  assert.match(read.content, /Bounded evidence marker five/);
});

test("local workspace chat accepts 100 papers plus experiment evidence", () => {
  const paperIds = Array.from({ length: 100 }, (_, index) => `paper-${index + 1}`);
  const files = [
    ...paperIds.map((paperId, index) => ({
      paperId,
      name: `paper-${index + 1}.pdf`,
      relativePath: `literature/paper-${index + 1}.pdf`,
      extension: "pdf",
      analysisStatus: "processed",
      evidenceType: "cached-summary",
      content: `Paper ${index + 1} evidence. ${"x".repeat(1800)}`,
    })),
    ...Array.from({ length: 40 }, (_, index) => ({
      name: `experiment-${index + 1}.csv`,
      relativePath: `experiments/experiment-${index + 1}.csv`,
      extension: "csv",
      analysisStatus: "processed",
      evidenceType: "experiment-summary",
      content: `Experiment ${index + 1} evidence. ${"y".repeat(1800)}`,
    })),
  ];

  const sanitized = sanitizeLocalWorkspaceContext({
    literature: {
      selectedPaperIds: paperIds,
      relevantPaperIds: paperIds,
      discoveryMode: "selected",
      retrievalRequired: true,
    },
    files,
  });

  assert.equal(sanitized.literature.selectedPaperIds.length, 100);
  assert.equal(sanitized.literature.relevantPaperIds.length, 100);
  assert.equal(sanitized.files.length, 140);
  assert.ok(sanitized.files.every((file) => file.content.length > 0));
  assert.ok(
    sanitized.files.reduce((total, file) => total + file.content.length, 0) <=
      360000
  );
});

test("corpus coverage survives sanitization and is rendered explicitly", () => {
  const sanitized = sanitizeLocalWorkspaceContext({
    literature: {
      selectedPaperIds: [],
      relevantPaperIds: Array.from({ length: 32 }, (_, index) => `P${index + 1}`),
      discoveryMode: "corpus",
      corpusWideRequest: true,
      corpusScope: "entire-project",
      retrievalRequired: true,
      coverage: {
        papersDiscovered: 32,
        papersSearchable: 30,
        papersIncludedInSnapshot: 32,
        papersSuccessfullyPrepared: 30,
        papersSuccessfullyAnalyzed: 30,
        papersFailed: 2,
        papersMissing: 0,
        failedPaperIds: ["P7", "P18"],
      },
    },
    routing: {
      useLiterature: true,
      paperIds: Array.from({ length: 32 }, (_, index) => `P${index + 1}`),
      mode: "corpus-intent",
    },
  });

  assert.equal(sanitized.literature.corpusWideRequest, true);
  assert.equal(sanitized.literature.coverage.papersSuccessfullyAnalyzed, 30);
  assert.deepEqual(sanitized.literature.coverage.failedPaperIds, ["P7", "P18"]);
  assert.equal(sanitized.routing.mode, "corpus-intent");
  assert.match(buildLocalWorkspaceContext(sanitized), /analyzed 30; failed 2/i);

  const appSource = fs.readFileSync(
    path.join(__dirname, "../../docs/app.js"),
    "utf8"
  );
  assert.match(appSource, /Preparing papers/);
  assert.match(appSource, /Analyzing papers/);
  assert.match(appSource, /Synthesizing themes/);
  assert.match(appSource, /Verifying claims/);
  assert.match(appSource, /appendCorpusCoverage/);
});

test("Side Chat prompt permits internal maintenance without granting recommendation updates", () => {
  const backendSource = fs.readFileSync(
    path.join(__dirname, "../index.js"),
    "utf8"
  );
  const agentSource = fs.readFileSync(
    path.join(__dirname, "../side-chat-agent.js"),
    "utf8"
  );

  assert.doesNotMatch(backendSource, /Read-only workspace/i);
  assert.doesNotMatch(agentSource, /Read-only workspace/i);
  assert.match(backendSource, /authorized to update internal knowledge state/i);
  assert.match(backendSource, /must not commit, replace, publish, or export the Current Recommendation/i);
  assert.match(backendSource, /deterministically diffs its stable source snapshot/i);
});

test("compact corpus workflow failures survive sanitization without exposing the journal", () => {
  const sanitized = sanitizeLocalWorkspaceContext({
    literature: {
      relevantPaperIds: ["P1", "P2"],
      discoveryMode: "corpus-status",
      corpusWideRequest: true,
      corpusWorkflowId: "workflow-32",
      coverage: {
        papersDiscovered: 32,
        papersIncludedInSnapshot: 32,
        papersSuccessfullyPrepared: 32,
        papersSuccessfullyAnalyzed: 30,
        papersFailed: 2,
        failedPaperIds: ["P1", "P2"],
      },
    },
    routing: { mode: "corpus-status", useLiterature: true },
    corpusWorkflowStatus: {
      workflowId: "workflow-32",
      papersTotal: 32,
      papersPrepared: 32,
      papersAnalyzed: 30,
      failures: [
        {
          paperId: "P1",
          filename: "one.pdf",
          stage: "map",
          code: "InvalidLlmResponse",
          message: "The corpus mapper did not return valid structured JSON.",
          sourceReady: true,
          retryable: true,
        },
      ],
      maps: { P3: { private: "must-not-survive" } },
      journal: "must-not-survive",
    },
  });
  assert.equal(sanitized.corpusWorkflowStatus.failures[0].stage, "map");
  assert.equal(sanitized.corpusWorkflowStatus.failures[0].sourceReady, true);
  assert.equal(Object.hasOwn(sanitized.corpusWorkflowStatus, "maps"), false);
  assert.equal(Object.hasOwn(sanitized.corpusWorkflowStatus, "journal"), false);
  assert.doesNotMatch(buildLocalWorkspaceContext(sanitized), /InvalidLlmResponse/);

  const knowledgeBase = createSideChatKnowledgeBase({
    localWorkspaceContext: sanitized,
  });
  const output = JSON.parse(executeSideChatTool(
    {
      id: "status-1",
      type: "function",
      function: {
        name: "get_corpus_workflow_status",
        arguments: JSON.stringify({ workflow_id: "workflow-32" }),
      },
    },
    knowledgeBase
  ));
  assert.equal(output.failures[0].code, "InvalidLlmResponse");
});

test("Side Chat remains isolated from Agent Work recommendation state", () => {
  const appSource = fs.readFileSync(
    path.join(__dirname, "../../docs/app.js"),
    "utf8"
  );
  const htmlSource = fs.readFileSync(
    path.join(__dirname, "../../docs/index.html"),
    "utf8"
  );
  const chatStart = appSource.indexOf("async function askSideChat");
  const chatEnd = appSource.indexOf("function updateSideChatThinking", chatStart);
  const chatFunction = appSource.slice(chatStart, chatEnd);

  assert.ok(chatStart >= 0 && chatEnd > chatStart);
  assert.doesNotMatch(chatFunction, /currentRecommendation\s*=/);
  assert.doesNotMatch(chatFunction, /runAgentInstruction/);
  assert.match(chatFunction, /enableContextRouter:\s*retrievalProfile\s*===\s*"high"/);
  const agentStart = appSource.indexOf("async function runAgentInstruction");
  const agentEnd = appSource.indexOf("function setAgentBusy", agentStart);
  const agentFunction = appSource.slice(agentStart, agentEnd);
  assert.match(agentFunction, /surface:\s*"agent_command"/);
  assert.match(agentFunction, /currentRecommendation\s*=\s*panel\.recommendation/);
  assert.match(htmlSource, /id="analysisPanelStack"/);
  assert.match(htmlSource, /id="addAnalysisPanelButton"/);
  assert.match(htmlSource, /id="sideChatHistory"/);
  assert.doesNotMatch(htmlSource, /Literature & References/);
  assert.doesNotMatch(htmlSource, /Experimental Results/);
});

test("retrieval quality is a compact validated workspace setting, not a preload control", () => {
  const appSource = fs.readFileSync(path.join(__dirname, "../../docs/app.js"), "utf8");
  const htmlSource = fs.readFileSync(path.join(__dirname, "../../docs/index.html"), "utf8");
  const stylesSource = fs.readFileSync(path.join(__dirname, "../../docs/styles.css"), "utf8");
  const preloadSource = fs.readFileSync(
    path.join(__dirname, "../../desktop/preload/index.cjs"),
    "utf8"
  );

  assert.match(htmlSource, /id="retrievalProfileSelect"/);
  for (const profile of ["light", "medium", "high"]) {
    assert.match(htmlSource, new RegExp(`value="${profile}"`));
  }
  assert.match(stylesSource, /\.retrieval-profile-control select\s*\{[^}]*width:\s*106px/s);
  assert.match(appSource, /retrievalProfile\s*=\s*normalizeRetrievalProfile\(result\.state\.ui\?\.retrievalProfile\)/);
  assert.match(appSource, /ui:\s*\{[\s\S]*retrievalProfile,[\s\S]*\}/);
  assert.match(appSource, /surface:\s*"side_chat"[\s\S]*retrievalProfile,/);
  assert.match(appSource, /surface:\s*"agent_command"[\s\S]*retrievalProfile,/);
  assert.doesNotMatch(
    preloadSource,
    /retrievalProfile|setRetrieval|providerConfig|setFeedURL|searchPlan|planner|rerank|cacheKey|promptVersion|providerEndpoint/i
  );
  assert.doesNotMatch(appSource, /retrievalProfile\s*=\s*(?:response|reply|tool|model)/);
});

test("workspace open, login, and Refresh never generate Paper Cards", () => {
  const appSource = fs.readFileSync(
    path.join(__dirname, "../../docs/app.js"),
    "utf8"
  );
  const moduleSource = fs.readFileSync(
    path.join(__dirname, "../../docs/literature-module.js"),
    "utf8"
  );
  const sliceFunction = (startLabel, endLabel) => {
    const start = appSource.indexOf(startLabel);
    const end = appSource.indexOf(endLabel, start + startLabel.length);
    assert.ok(start >= 0 && end > start, `${startLabel} should be present`);
    return appSource.slice(start, end);
  };

  const loginHandler = sliceFunction(
    'loginForm.addEventListener("submit"',
    'logoutButton.addEventListener("click"'
  );
  const openWorkspace = sliceFunction(
    "async function openSelectedWorkspace",
    "function applyLiteratureScan"
  );
  const refreshLiterature = sliceFunction(
    "async function refreshLiterature",
    "async function reconcileCurrentWorkspaceCatalog"
  );
  const reconcileWorkspace = sliceFunction(
    "async function reconcileCurrentWorkspaceCatalog",
    "async function refreshWorkspaceExplorer"
  );
  const refreshWorkspace = sliceFunction(
    "async function refreshWorkspaceExplorer",
    "function scheduleWorkspaceStateSave"
  );
  const eagerPattern = /ensurePaperCards|syncPaperLibrary|\.summarize\(/;

  assert.doesNotMatch(loginHandler, eagerPattern);
  assert.match(openWorkspace, /literatureModule\.scan\(\{ tree: workspaceTree \}\)/);
  assert.doesNotMatch(openWorkspace, eagerPattern);
  assert.match(refreshLiterature, /literatureModule\.scan\(\)/);
  assert.doesNotMatch(refreshLiterature, eagerPattern);
  assert.match(refreshWorkspace, /reconcileCurrentWorkspaceCatalog\(\)/);
  assert.doesNotMatch(refreshWorkspace, eagerPattern);
  assert.match(reconcileWorkspace, /literatureModule\.scan\(\{ tree: nextTree \}\)/);
  assert.doesNotMatch(reconcileWorkspace, eagerPattern);
  assert.match(moduleSource, /async addFiles\([\s\S]*?const documents = await this\.scan\(\)/);
  assert.match(moduleSource, /async ensurePaperCards\(/);
});

test("Side Chat reconciles current nested-file metadata before routing without eager processing", () => {
  const appSource = fs.readFileSync(
    path.join(__dirname, "../../docs/app.js"),
    "utf8"
  );
  const chatStart = appSource.indexOf("async function askSideChat");
  const chatEnd = appSource.indexOf("function updateSideChatThinking", chatStart);
  const chatFunction = appSource.slice(chatStart, chatEnd);
  const reconcileCall = chatFunction.indexOf("await reconcileCurrentWorkspaceCatalog()");
  const contextBuild = chatFunction.indexOf("projectContextService.buildContext");

  assert.ok(reconcileCall >= 0);
  assert.ok(contextBuild > reconcileCall);
  assert.doesNotMatch(
    chatFunction.slice(0, contextBuild),
    /ensurePaperCards|\.summarize\(|ensureSourceReady/
  );
  assert.match(appSource, /scanDirectoryTree\(\)[\s\S]*literatureModule\.scan\(\{ tree: nextTree \}\)/);
});

test("Workspace rows preserve full names while clamping long files to two lines", () => {
  const appSource = fs.readFileSync(
    path.join(__dirname, "../../docs/app.js"),
    "utf8"
  );
  const stylesSource = fs.readFileSync(
    path.join(__dirname, "../../docs/styles.css"),
    "utf8"
  );
  const longNames = [
    "2024--High efficiency production of 5-hydroxyectoine through metabolic engineering of Escherichia coli.pdf",
    "2023--Efficient stereoselective hydroxylation using engineered cytochrome P450 whole-cell biocatalysts.pdf",
    "2024--工程化大肠杆菌高效生产五羟基四氢嘧啶的代谢工程研究.pdf",
  ];

  assert.match(stylesSource, /\.workspace-file-row \.workspace-tree-name\s*\{[^}]*-webkit-line-clamp:\s*2/s);
  assert.match(stylesSource, /\.workspace-file-row \.workspace-tree-name\s*\{[^}]*overflow-wrap:\s*anywhere/s);
  assert.match(stylesSource, /\.workspace-file-row \.workspace-tree-name\s*\{[^}]*white-space:\s*normal/s);
  assert.match(stylesSource, /\.workspace-folder-toggle \.workspace-tree-name\s*\{[^}]*white-space:\s*nowrap/s);
  assert.match(stylesSource, /\.workspace-tree-children\s*\{[^}]*margin-left:\s*5px[^}]*padding-left:\s*7px/s);
  assert.equal((appSource.match(/name\.title = node\.name;/g) || []).length, 2);
  assert.ok(longNames[0].length > 100);
  assert.ok(longNames[1].length > 90);
  assert.match(longNames[2], /[\u3400-\u9fff]/);
  assert.ok(longNames.every((filename) => filename.endsWith(".pdf")));
});

test("desktop workbench contains the Workspace and gives Side Chat more width", () => {
  const stylesSource = fs.readFileSync(
    path.join(__dirname, "../../docs/styles.css"),
    "utf8"
  );

  assert.match(
    stylesSource,
    /\.workbench-grid\s*\{[^}]*grid-template-columns:\s*minmax\(300px, 0\.75fr\) minmax\(560px, 1\.25fr\) minmax\(380px, 0\.85fr\)/s
  );
  assert.match(
    stylesSource,
    /\.analysis-panel-body\s*\{[^}]*grid-template-columns:\s*minmax\(0, 1fr\)/s
  );
  assert.match(
    stylesSource,
    /\.analysis-pane\s*\{[^}]*min-width:\s*0[^}]*min-height:\s*0/s
  );
  assert.match(
    stylesSource,
    /\.inputs-column \.workbench-panel\s*\{[^}]*overflow:\s*hidden/s
  );
});

test("workbench header groups account and workspace controls into two compact rows", () => {
  const html = fs.readFileSync(path.join(__dirname, "../../docs/index.html"), "utf8");
  const styles = fs.readFileSync(path.join(__dirname, "../../docs/styles.css"), "utf8");

  assert.match(html, /class="header-utility-row"[\s\S]*workbenchLanguageSelect[\s\S]*about-trigger[\s\S]*account-chip/);
  assert.match(html, /class="header-status-row"[\s\S]*backendStatusLabel[\s\S]*workspace-status-group/);
  assert.match(styles, /\.workbench-header\s*\{[^}]*padding:\s*16px 18px/s);
  assert.match(styles, /\.header-actions\s*\{[^}]*display:\s*grid[^}]*gap:\s*7px/s);
  assert.match(styles, /\.header-actions \.workspace-chip\s*\{[^}]*display:\s*flex[^}]*min-height:\s*34px/s);
});

test("Side Chat context wraps long paper names without widening its column", () => {
  const appSource = fs.readFileSync(
    path.join(__dirname, "../../docs/app.js"),
    "utf8"
  );
  const stylesSource = fs.readFileSync(
    path.join(__dirname, "../../docs/styles.css"),
    "utf8"
  );

  assert.match(stylesSource, /\.side-chat-panel\s*\{[^}]*min-width:\s*0[^}]*max-width:\s*100%/s);
  assert.match(stylesSource, /\.side-chat-context-chips\s*\{[^}]*min-width:\s*0[^}]*max-width:\s*100%/s);
  assert.match(stylesSource, /\.context-chip\s*\{[^}]*min-width:\s*0[^}]*max-width:\s*100%/s);
  assert.match(stylesSource, /\.context-chip span\s*\{[^}]*overflow-wrap:\s*anywhere[^}]*white-space:\s*normal/s);
  assert.match(stylesSource, /\.context-chip-remove\s*\{[^}]*flex:\s*0 0 auto/s);
  assert.match(appSource, /chip\.title = path/);
});

test("Side Chat stays bounded, edits only the latest user turn, and retains safe activity summaries", () => {
  const appSource = fs.readFileSync(
    path.join(__dirname, "../../docs/app.js"),
    "utf8"
  );
  const stylesSource = fs.readFileSync(
    path.join(__dirname, "../../docs/styles.css"),
    "utf8"
  );

  assert.match(stylesSource, /\.side-chat-panel\s*\{[^}]*height:\s*calc\(100vh - 32px\)[^}]*max-height:\s*calc\(100vh - 32px\)[^}]*overflow:\s*hidden/s);
  assert.match(stylesSource, /\.side-chat-history\s*\{[^}]*overflow-y:\s*auto[^}]*overscroll-behavior:\s*contain[^}]*scrollbar-gutter:\s*stable/s);
  assert.match(appSource, /prepareLatestSideChatRevision\(\s*sideChatMessages/);
  assert.match(appSource, /sideChatMessages = revision\.previousMessages/);
  assert.match(appSource, /await persistSideChatConversation\(\)[\s\S]*await askSideChat\(revision\.question\)/);
  assert.match(appSource, /dataset\.sideChatAction = "edit"/);
  assert.match(appSource, /activity: getSideChatActivitySteps\(thinkingMessage\)/);
  assert.match(appSource, /processingSummaryNote: "High-level activity only; private model reasoning is not shown\."/);
});

test("Side Chat hides empty-state prompts and renders safe Markdown with math", () => {
  const appSource = fs.readFileSync(
    path.join(__dirname, "../../docs/app.js"),
    "utf8"
  );
  const htmlSource = fs.readFileSync(
    path.join(__dirname, "../../docs/index.html"),
    "utf8"
  );
  const stylesSource = fs.readFileSync(
    path.join(__dirname, "../../docs/styles.css"),
    "utf8"
  );

  assert.match(htmlSource, /id="sideChatExamples"/);
  assert.match(htmlSource, /vendor\/katex\/katex\.min\.css/);
  assert.match(htmlSource, /vendor\/katex\/katex\.min\.js/);
  assert.match(htmlSource, /vendor\/katex\/auto-render\.min\.js/);
  assert.match(appSource, /sideChatExamples\.hidden = !isEmpty/);
  assert.match(appSource, /data-side-chat-intro/);
  assert.match(appSource, /renderSideChatMarkdown\(body, content\)/);
  assert.doesNotMatch(appSource, /body\.textContent = content/);
  assert.match(appSource, /\^\(\?:https\?:\|mailto:\)/);
  assert.match(appSource, /window\.renderMathInElement\(container/);
  assert.match(appSource, /\{ left: "\$\$", right: "\$\$", display: true \}/);
  assert.match(appSource, /\{ left: "\$", right: "\$", display: false \}/);
  assert.match(appSource, /ignoredTags: \["script", "noscript", "style", "textarea", "pre", "code", "option"\]/);
  assert.match(appSource, /throwOnError: false/);
  assert.match(appSource, /trust: false/);
  assert.match(stylesSource, /\.side-examples\[hidden\]\s*\{[^}]*display:\s*none/s);
  assert.match(stylesSource, /\.side-message-body pre\s*\{[^}]*overflow-x:\s*auto/s);
  assert.match(stylesSource, /\.side-message-body table\s*\{[^}]*overflow-x:\s*auto/s);
  assert.match(stylesSource, /\.side-message-body \.katex-display\s*\{[^}]*overflow-x:\s*auto/s);
  assert.match(stylesSource, /\.side-message > strong\s*\{/);
  assert.doesNotMatch(stylesSource, /\.side-message strong\s*\{/);
});
