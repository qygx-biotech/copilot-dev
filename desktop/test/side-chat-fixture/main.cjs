// Runs the repository's real editor, submission functions, delegated events,
// citation renderer, and CSS in Chromium. Workspace persistence/network are mocks.
const { app, BrowserWindow } = require("electron");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const root = path.resolve(__dirname, "../../..");
const profile = fs.mkdtempSync(path.join(os.tmpdir(), "biodesign-side-chat-ui-"));
app.setPath("userData", profile);
app.commandLine.appendSwitch("disable-background-networking");
const source = fs.readFileSync(path.join(root, "docs/app.js"), "utf8");
const applicationSource = fs.readFileSync(path.join(root, "desktop/main/application.mjs"), "utf8");
const scrollInspection = applicationSource.match(/^function inspectSideChatScrollLayout\([\s\S]*?^}/m)?.[0];
if (!scrollInspection) throw new Error("Missing production Side Chat smoke inspection");
function actualFunction(name) {
  const match = source.match(new RegExp(`^(?:async )?function ${name}\\([\\s\\S]*?^}`, "m"));
  if (!match) throw new Error(`Missing production function ${name}`);
  return match[0];
}
const functions = [
  "persistSideChatConversation", "renderSideChatConversation", "beginSideChatMessageEdit", "showSideChatEditError", "reviseLatestSideChatMessage",
  "setSideChatBusy", "askSideChat", "addSideChatThinking", "updateSideChatThinking", "getSideChatActivitySteps", "sideChatProgressText",
  "setSideChatEmptyState", "isMarkdownBlockStart", "isMarkdownTableDivider", "splitMarkdownTableRow", "appendSideChatInlineMarkdown", "appendSideChatMarkdownLines", "renderSideChatMath", "renderSideChatMarkdown",
  "getSideChatCitationContext", "navigateSideChatCitation", "createSideChatActivitySummary", "addSideChatMessage",
].map(actualFunction).join("\n");
const events = source.slice(source.indexOf('sideChatHistory.addEventListener("click"'), source.indexOf("function normalizeBetaUpdateStatus"));
const contextApi = require(path.join(root, "docs/project-context-service.js"));
const setup = `
const sourceCitationApi = window.BioDesignSourceCitations;
const prepareLatestSideChatRevision = ${contextApi.prepareLatestSideChatRevision.toString()};
const sideChatHistory = document.querySelector("#history"), sideChatInput = document.querySelector("#input"), sendSideChatButton = document.querySelector("#send"), clearSideChatButton = document.querySelector("#clear"), sideChatExamples = document.querySelector("#examples"), workspaceTreeContainer = document.querySelector("#tree");
const translations = { editLastMessage: "Edit latest message", cancelEdit: "Cancel", saveAndRegenerate: "Save and regenerate", editMessageRequired: "Enter a message before saving.", chatPersistenceFailed: "Could not save. Please try again.", sideChatUserLabel: "You", sideChatAssistantLabel: "Copilot", citationUnavailable: "Source unavailable", backendFallbackMessage: "Request failed; local fallback", thinking: "Thinking..." };
const t = key => translations[key] || key;
let sideChatBusy = false, sideChatMessages = [], sideChatConversation, activeCorpusProgress = null, activeLiteratureOperations = 0, lastSourceUsage;
let currentLanguage = "en", retrievalProfile = "light", workspaceAbortController = null, knowledgeService = null;
let requests = [], saves = [], toasts = [], saveFailAt = 0, requestFailure = false, pendingRequest = null, sequence = 0, exists = true, existenceGate = null, fileChecks = [];
const sources = [{ sourceId: "paper-a", path: "literature/中文/酶活性.pdf", contentHash: "hash-a", catalogStatus: "ready" }];
const workspaceManager = { workspace: { workspaceId: "w-1", name: "Project Folder" }, fileExists: async path => { fileChecks.push(path); if (existenceGate) await existenceGate; return exists; } };
let workspaceTree = { type: "directory", relativePath: "", children: [{ type: "file", relativePath: sources[0].path }] };
const flattenWorkspaceTree = tree => tree.children;
const expandedWorkspacePaths = new Set([""]), selectedWorkspacePaths = new Set();
const literatureModule = { documents: [], sourceRegistry: { list: () => sources, get: id => sources.find(s => s.sourceId === id) } };
const projectContextService = { buildConversationContext: conversation => structuredClone(conversation.messages), buildContext: async () => ({ literature: {}, files: [] }) };
const workspaceChatStore = { saveConversation: async conversation => { saves.push(structuredClone(conversation)); if (saves.length === saveFailAt) throw new Error("disk unavailable"); return structuredClone(conversation); } };
const getCurrentChatContextSnapshot = () => ({ type: "project", files: [], selectedPaperIds: [], selectedExperimentIds: [] });
const makeId = () => 'generated-' + (++sequence);
const reconcileCurrentWorkspaceCatalog = async () => {};
const getProjectContext = () => "Test goal";
const renderSideChatContext = () => {};
const applyLiteratureScan = () => {};
const applyPreparedContextToDocuments = () => {};
const normalizeSemanticTelemetry = value => value;
const normalizeRetrievalMetadata = value => value || {};
const appendCorpusCoverage = value => value;
const buildSideChatMessages = (question, context) => [...context, { role: "user", content: question }];
const buildLocalSideChatReply = () => "Recoverable fallback";
const showToast = text => toasts.push(text);
class AuthRequiredError extends Error {}
const sendWorkbenchRequest = async request => { requests.push(structuredClone(request)); if (pendingRequest) await pendingRequest; if (requestFailure) throw new Error("request unavailable"); return { reply: "Regenerated answer" }; };
const renderWorkspaceExplorer = () => { workspaceTreeContainer.replaceChildren(); for (const file of workspaceTree.children) { const row = document.createElement("label"); row.className = "workspace-file-row"; const input = document.createElement("input"); input.type = "checkbox"; input.dataset.workspaceFile = file.relativePath; row.append(input, file.relativePath); workspaceTreeContainer.append(row); } };
`;
(async () => {
  try {
    await app.whenReady();
    const win = new BrowserWindow({ width: 850, height: 800, show: false, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } });
    const css = fs.readFileSync(path.join(root, "docs/styles.css"), "utf8");
    await win.loadURL("data:text/html;charset=utf-8," + encodeURIComponent(`<html><head><meta charset="utf-8"><style>${css}</style></head><body style="padding:24px"><main style="max-width:700px"><div id="tree"></div><div id="history" class="side-chat-history"></div><div id="examples"></div><textarea id="input"></textarea><button id="send">Ask</button><button id="clear">Clear</button></main></body></html>`));
    await win.webContents.executeJavaScript(fs.readFileSync(path.join(root, "shared/source-citations.js"), "utf8"));
    await win.webContents.executeJavaScript(`${setup}\n${functions}\n${scrollInspection}\n${events}\n${fs.readFileSync(path.join(__dirname, "scenarios.js"), "utf8")}`);
    const result = await win.webContents.executeJavaScript("runScenarios()");
    const screenshot = path.join(profile, "editor.png");
    await win.webContents.executeJavaScript("resetConversation(); edit(); document.querySelector('[data-side-chat-edit-input]').setSelectionRange(0, 14)");
    const image = await win.webContents.capturePage();
    fs.writeFileSync(screenshot, image.toPNG());
    console.log("SIDE_CHAT_RESULT " + JSON.stringify({ ...result, screenshot }));
    win.destroy();
    app.exit(0);
  } catch (error) {
    console.error(error.stack);
    app.exit(1);
  }
})();
