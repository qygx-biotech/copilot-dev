// Real renderer components/events in Chromium; no network or workspace mutations.
const { app, BrowserWindow } = require("electron");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const root = path.resolve(__dirname, "../../..");
const profile = fs.mkdtempSync(path.join(os.tmpdir(), "biodesign-agent-work-ui-"));
app.setPath("userData", profile);
app.commandLine.appendSwitch("disable-background-networking");
const source = fs.readFileSync(path.join(root, "docs/app.js"), "utf8");
function actualFunction(name) {
  const match = source.match(new RegExp(`^(?:async )?function ${name}\\([\\s\\S]*?^}$`, "m"));
  if (!match) throw new Error(`Missing production function ${name}`);
  return match[0];
}
const functions = [
  "t", "runAgentInstruction", "setAgentBusy", "getAgentModelOptions", "renderAnalysisPanels", "renderAgentMarkdown",
  "buildAgentResultContent", "createAgentResultActions", "createAnalysisActionButton", "addAnalysisPanel", "deleteAnalysisPanel", "createAnalysisPanel",
  "findAnalysisPanel", "getCurrentRecommendation", "getAnalysisPanelStatus", "focusAnalysisPanelInstruction",
  "normalizeStoredAnalysisPanel", "normalizeRecommendation", "createDefaultRecommendation", "saveAnalysisPanels", "saveCurrentRecommendation", "loadAnalysisPanels", "loadSessionJson", "cloneValue",
  "normalizeSideChatModel", "shortSideChatModelName", "createStreamingAnswer",
  "isMarkdownBlockStart", "isMarkdownTableDivider", "splitMarkdownTableRow", "appendSideChatInlineMarkdown", "appendSideChatMarkdownLines", "renderSideChatMath", "renderSideChatMarkdown",
].map(actualFunction).join("\n");
const translations = source.slice(source.indexOf("const I18N ="), source.indexOf("let currentLanguage ="));
const events = source.slice(source.indexOf('addAnalysisPanelButton.addEventListener("click"'), source.indexOf("sideExampleButtons.forEach"));
const setup = `
const agentWorkApi = window.BioDesignAgentWork, sourceCitationApi = window.BioDesignSourceCitations;
const analysisPanelStack = document.getElementById("analysisPanelStack"), addAnalysisPanelButton = document.getElementById("addAnalysisPanelButton");
const sideChatModelSelect = document.getElementById("sideChatModelSelect");
const ANALYSIS_PANELS_STORAGE_KEY = "fixture-panels", RECOMMENDATION_STORAGE_KEY = "fixture-recommendation";
let currentLanguage = "en", defaultSideChatModel = "google/default-fixture", agentWorkArea = null;
let analysisPanels = [], currentRecommendation, activeAgentRequest = false, activeAgentPanelId = "";
const USE_BACKEND = true, authToken = "fixture", runtimeLog = null, projectContextService = null, workspaceTree = null, literatureModule = null;
let workspaceAbortController = null, requestGate = null, requestFailure = null, requests = [], exports = [], copies = [];
const makeId = () => crypto.randomUUID();
const formatTimestamp = value => new Date(value).toLocaleTimeString("en", { hour: "2-digit", minute: "2-digit" });
const normalizeSemanticTelemetry = value => value, normalizeRetrievalMetadata = value => value;
const getSideChatCitationContext = () => ({ sources: [] });
const navigateSideChatCitation = () => {};
const renderBackendStatus = () => {}, showToast = () => {};
const buildAgentMessages = instruction => [{ role: "user", content: instruction }];
const exportRecommendation = recommendation => exports.push(recommendation);
const buildMarkdownExport = recommendation => JSON.stringify(recommendation);
const copyText = async text => copies.push(text);
class AuthRequiredError extends Error {}
const normalizeAgentResponse = response => ({ ...createDefaultRecommendation(), currentInterpretation: response.reply, recommendedNextStep: "Compare the evidence and update the summary.", updatedAt: new Date().toISOString() });
const createLocalRecommendation = () => ({ ...createDefaultRecommendation(), currentInterpretation: "Local fallback", updatedAt: new Date().toISOString() });
const sendWorkbenchRequest = async request => {
  requests.push(request);
  request.onStream({ type: "delta", text: "Streaming task response" });
  if (requestGate) await requestGate;
  if (requestFailure) throw requestFailure;
  return { reply: "### Evidence review\\n\\nReviewed the task evidence.\\n\\n- Compare candidates\\n- Inspect the missing results\\n\\n1. Check the data\\n2. Review the summary\\n\\n\u0060\u0060\u0060js\\nconst result = 'ready';\\n\u0060\u0060\u0060\\n\\nFile: \u0060output/summary.md\u0060" };
};
const ok = (condition, message) => { if (!condition) throw new Error(message); };
const tick = () => new Promise(resolve => setTimeout(resolve, 70));
const card = chat => [...analysisPanelStack.children].find(node => node.dataset.panelId === chat.id);
const click = (chat, action) => card(chat).querySelector('[data-analysis-action="' + action + '"]').click();
const draft = (chat, value) => { const input = card(chat).querySelector("textarea"); input.value = value; input.dispatchEvent(new Event("input", { bubbles: true })); return input; };
const setting = (chat, key, value) => { const input = card(chat).querySelector('[data-agent-setting="' + key + '"]'); input.value = value; input.dispatchEvent(new Event("change", { bubbles: true })); };
const passed = [];
const check = (condition, name) => { ok(condition, name); passed.push(name); };
`;
(async () => {
  try {
    await app.whenReady();
    const win = new BrowserWindow({ width: 1600, height: 1000, show: false, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } });
    win.webContents.on("console-message", event => { if (event.level === "error") console.error(event.message); });
    const html = fs.readFileSync(path.join(root, "docs/index.html"), "utf8")
      .replace(/<script\b[^>]*>[\s\S]*?<\/script>/g, "")
      .replace(/<link\b[^>]*>/g, "");
    const fixture = path.join(profile, "fixture.html");
    fs.writeFileSync(fixture, html.replace("</head>", `<style>${fs.readFileSync(path.join(root, "docs/styles.css"), "utf8")}</style></head>`));
    await win.loadFile(fixture);
    for (const file of ["shared/source-citations.js", "docs/agent-work-area.js"]) await win.webContents.executeJavaScript(fs.readFileSync(path.join(root, file), "utf8"));
    await win.webContents.executeJavaScript(`${translations}\n${setup}\n${functions}\n${events}\n${fs.readFileSync(path.join(__dirname, "scenarios.js"), "utf8")}`);
    await win.webContents.executeJavaScript("runAgentScenarios()");
    const screenshot = path.join(profile, "agent-work-desktop.png");
    await win.webContents.executeJavaScript("window.scrollTo(0, 0); tick()");
    fs.writeFileSync(screenshot, (await win.webContents.capturePage()).toPNG());
    const screenshots = [screenshot];
    for (const width of [1380, 1281, 1024, 768, 390]) {
      win.setSize(width, 900);
      await win.webContents.executeJavaScript(`checkResponsive(${width})`);
      await win.webContents.executeJavaScript("card(analysisPanels[1]).scrollIntoView({ block: 'start' }); tick()");
      const filename = path.join(profile, `agent-work-${width}.png`);
      fs.writeFileSync(filename, (await win.webContents.capturePage()).toPNG());
      screenshots.push(filename);
    }
    console.log("AGENT_WORK_RESULT " + JSON.stringify({ passed: await win.webContents.executeJavaScript("passed"), screenshots }));
    win.destroy(); app.exit(0);
  } catch (error) { console.error(error.stack); app.exit(1); }
})();
