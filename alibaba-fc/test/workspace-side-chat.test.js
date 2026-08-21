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
    project: {
      workspaceName: "EctD Project",
      goal: "Improve EctD activity",
      projectSummary: "Early-stage comparison",
      apiKey: "must-not-survive",
    },
    inventory: [
      {
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
});

test("invalid local workspace context is ignored rather than trusted", () => {
  assert.equal(sanitizeLocalWorkspaceContext(null), null);
  assert.equal(sanitizeLocalWorkspaceContext([]), null);
  assert.equal(buildLocalWorkspaceContext(null), null);
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
  assert.match(htmlSource, /id="analysisPanelStack"/);
  assert.match(htmlSource, /id="addAnalysisPanelButton"/);
  assert.match(htmlSource, /id="sideChatHistory"/);
  assert.doesNotMatch(htmlSource, /Literature & References/);
  assert.doesNotMatch(htmlSource, /Experimental Results/);
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

test("Side Chat hides empty-state prompts after history and renders safe Markdown", () => {
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
  assert.match(appSource, /sideChatExamples\.hidden = !isEmpty/);
  assert.match(appSource, /data-side-chat-intro/);
  assert.match(appSource, /renderSideChatMarkdown\(body, content\)/);
  assert.doesNotMatch(appSource, /body\.textContent = content/);
  assert.match(appSource, /\^\(\?:https\?:\|mailto:\)/);
  assert.match(stylesSource, /\.side-examples\[hidden\]\s*\{[^}]*display:\s*none/s);
  assert.match(stylesSource, /\.side-message-body pre\s*\{[^}]*overflow-x:\s*auto/s);
  assert.match(stylesSource, /\.side-message-body table\s*\{[^}]*overflow-x:\s*auto/s);
  assert.match(stylesSource, /\.side-message > strong\s*\{/);
  assert.doesNotMatch(stylesSource, /\.side-message strong\s*\{/);
});
