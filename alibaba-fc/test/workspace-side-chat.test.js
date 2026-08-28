const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const {
  buildLocalWorkspaceContext,
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
  assert.match(chatFunction, /enableContextRouter:\s*false/);
  assert.match(htmlSource, /id="analysisPanelStack"/);
  assert.match(htmlSource, /id="addAnalysisPanelButton"/);
  assert.match(htmlSource, /id="sideChatHistory"/);
  assert.doesNotMatch(htmlSource, /Literature & References/);
  assert.doesNotMatch(htmlSource, /Experimental Results/);
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
  assert.match(refreshWorkspace, /literatureModule\.scan\(\{ tree: nextTree \}\)/);
  assert.doesNotMatch(refreshWorkspace, eagerPattern);
  assert.match(moduleSource, /async addFiles\([\s\S]*?const documents = await this\.scan\(\)/);
  assert.match(moduleSource, /async ensurePaperCards\(/);
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
  assert.match(htmlSource, /katex@0\.18\.1\/dist\/katex\.min\.css/);
  assert.match(htmlSource, /katex@0\.18\.1\/dist\/katex\.min\.js/);
  assert.match(htmlSource, /katex@0\.18\.1\/dist\/contrib\/auto-render\.min\.js/);
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
