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
