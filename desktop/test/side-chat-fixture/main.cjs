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
const sideChatPanelMarkup = fs.readFileSync(path.join(root, "docs/index.html"), "utf8").match(/<section class="workbench-panel side-chat-panel"[\s\S]*?<\/section>/)[0];
const applicationSource = fs.readFileSync(path.join(root, "desktop/main/application.mjs"), "utf8");
const scrollInspection = applicationSource.match(/^function inspectSideChatScrollLayout\([\s\S]*?^}/m)?.[0];
if (!scrollInspection) throw new Error("Missing production Side Chat smoke inspection");
function actualFunction(name) {
  const match = source.match(new RegExp(`^(?:async )?function ${name}\\([\\s\\S]*?^}`, "m"));
  if (!match) throw new Error(`Missing production function ${name}`);
  return match[0];
}
const functions = [
  "persistSideChatConversation", "renderSideChatConversation", "renderSideChatConversationSelect", "changeSideChatConversation", "beginSideChatMessageEdit", "showSideChatEditError", "reviseLatestSideChatMessage",
  "setSideChatBusy", "askSideChat", "addSideChatThinking", "updateSideChatThinking", "getSideChatActivitySteps", "sideChatProgressText", "formatCorpusPaperProgress",
  "setSideChatEmptyState", "isMarkdownBlockStart", "isMarkdownTableDivider", "splitMarkdownTableRow", "appendSideChatInlineMarkdown", "appendSideChatMarkdownLines", "renderSideChatMath", "renderSideChatMarkdown",
  "getSideChatCitationContext", "navigateSideChatCitation", "createSideChatActivitySummary", "addSideChatMessage",
  "createStreamingAnswer", "normalizeSideChatModel", "shortSideChatModelName", "updateSideChatModelConfiguration", "renderSideChatModelControl", "saveWorkspaceStateNow",
  "runAgentInstruction", "setAgentBusy", "getAgentModelOptions",
  "initializeSideChatImages", "submitSideChat", "understandSideChatImages",
].map(actualFunction).join("\n");
const modelEvents = source.match(/^sideChatModelSelect.addEventListener[\s\S]*?^\}\);/m)[0];
const historyEvents = source.slice(source.indexOf('clearSideChatButton.addEventListener("click"'), source.indexOf("async function changeSideChatConversation"));
const events = source.slice(source.indexOf('sideChatHistory.addEventListener("click"'), source.indexOf("function normalizeBetaUpdateStatus"));
const contextApi = require(path.join(root, "docs/project-context-service.js"));
const setup = `
const sourceCitationApi = window.BioDesignSourceCitations;
const sideChatPanelMarkup = ${JSON.stringify(sideChatPanelMarkup)};
const chatImageApi = window.BioDesignChatImages, runtimeLog = window.BioDesignRuntimeLog;
let sideChatImageComposer = null;
let sideChatMessageEdit = null;
const sideChatForm = document.querySelector("#composer");
const prepareLatestSideChatRevision = ${contextApi.prepareLatestSideChatRevision.toString()};
const sideChatHistory = document.querySelector("#history"), sideChatInput = document.querySelector("#input"), sendSideChatButton = document.querySelector("#send"), clearSideChatButton = document.querySelector("#clear"), sideChatExamples = document.querySelector("#examples"), workspaceTreeContainer = document.querySelector("#tree");
const translations = { editLastMessage: "Edit latest message", cancelEdit: "Cancel", saveAndRegenerate: "Save and regenerate", editMessageRequired: "Enter a message before saving.", chatPersistenceFailed: "Could not save. Please try again.", sideChatUserLabel: "You", sideChatAssistantLabel: "Copilot", citationUnavailable: "Source unavailable", backendFallbackMessage: "Request failed; local fallback", thinking: "Thinking..." };
const t = key => translations[key] || key;
let sideChatBusy = false, sideChatMessages = [], sideChatConversation, activeCorpusProgress = null, activeLiteratureOperations = 0, lastSourceUsage;
const sideChatModelSelect = document.getElementById("sideChatModelSelect"), sideChatModelDescription = document.getElementById("sideChatModelDescription");
const projectContextInput = { value: "Test goal" };
let sideChatModel = "default", defaultSideChatModel = "";
const sideChatConversationSelect = document.querySelector("#sideChatConversationSelect");
let sideChatConversations = [], sideChatNavigationBusy = false, historyGate = null;
const savedConversations = new Map();
const scheduleWorkspaceStateSave = () => saveWorkspaceStateNow();
let currentLanguage = "en", retrievalProfile = "light", workspaceAbortController = null, knowledgeService = null;
let requests = [], saves = [], toasts = [], saveFailAt = 0, requestFailure = false, pendingRequest = null, sequence = 0, exists = true, existenceGate = null, fileChecks = [];
let streamEvents = [], streamFailure = false, lastStreamCallback = null;
let imageCalls = [], contextCalls = [], contextModels = [], imageModels = [], imageResponseStatus = 200, imageGate = null;
const imageStore = new Map();
const backendUrl = path => path;
const getAuthHeaders = extra => ({ ...extra, Authorization: "Bearer fixture" });
const requireLoginForUnauthorized = response => { if (response.status === 401) throw new AuthRequiredError(); };
window.fetch = async (url, options) => {
  if (url !== "/api/chat/understand-images") throw new Error("Unexpected fixture endpoint");
  const body = JSON.parse(options.body); imageCalls.push(body); imageModels.push(options.headers["X-BioDesign-Chat-Model"]);
  if (imageGate) await imageGate;
  return new Response(JSON.stringify(imageResponseStatus === 200 ? { understanding: { text: "Image 1: enzyme activity 25 U/mL at pH 7.0; error bars unclear.", model: "vision-fixture" }, imageCount: body.images.length } : { error: "IMAGE_PROVIDER_FAILED" }), { status: imageResponseStatus });
};
const USE_BACKEND = true, authToken = "fixture";
const agentWorkApi = window.BioDesignAgentWork;
let agentWorkArea = null;
let activeAgentRequest = false, activeAgentPanelId = "", currentRecommendation = { title: "Existing recommendation" };
const agentPanel = { id: "agent-panel", instruction: "Review evidence", recommendation: currentRecommendation, frozen: false };
const analysisPanelStack = document.createElement("div"); document.body.append(analysisPanelStack);
const findAnalysisPanel = id => id === agentPanel.id ? agentPanel : null;
let panelSaves = [];
const saveAnalysisPanels = () => panelSaves.push(structuredClone(agentPanel));
const renderAnalysisPanels = () => { analysisPanelStack.innerHTML = '<article data-panel-id="agent-panel"><div class="agent-stream-slot"></div></article>'; };
const renderBackendStatus = () => {};
const buildAgentMessages = instruction => [{ role: "user", content: instruction }];
const normalizeAgentResponse = response => ({ title: response.reply });
const createLocalRecommendation = () => ({ title: "Local fallback" });
const sources = [{ sourceId: "paper-a", path: "literature/中文/酶活性.pdf", contentHash: "hash-a", catalogStatus: "ready" }];
const workspaceManager = { state: { project: {}, ui: {} }, saveState: async state => { workspaceManager.state = state; }, workspace: { workspaceId: "w-1", name: "Project Folder" }, fileExists: async path => { fileChecks.push(path); if (existenceGate) await existenceGate; return exists; } };
let workspaceTree = { type: "directory", relativePath: "", children: [{ type: "file", relativePath: sources[0].path }] };
const flattenWorkspaceTree = tree => tree.children;
const expandedWorkspacePaths = new Set([""]), selectedWorkspacePaths = new Set();
const literatureModule = { documents: [], sourceRegistry: { list: () => sources, get: id => sources.find(s => s.sourceId === id) } };
const projectContextService = { buildConversationContext: conversation => structuredClone(conversation.messages), buildContext: async options => { contextCalls.push(options.question); contextModels.push(options.callContext?.model); return { literature: {}, files: [] }; } };
const workspaceChatStore = { saveConversation: async conversation => { saves.push(structuredClone(conversation)); if (saves.length === saveFailAt) throw new Error("disk unavailable"); savedConversations.set(conversation.id, structuredClone(conversation)); return structuredClone(conversation); },
  listConversations: async () => [...savedConversations.values()].map(({ messages, ...record }) => ({ ...record, messageCount: messages.length })),
  activateConversation: async id => { if (historyGate) await historyGate; if (!savedConversations.has(id)) throw new Error("Missing chat"); return structuredClone(savedConversations.get(id)); },
  startNewConversation: async () => { if (historyGate) await historyGate; const conversation = { id: crypto.randomUUID(), title: "Side Chat", messages: [] }; savedConversations.set(conversation.id, conversation); return conversation; },
  saveImageAttachments: async images => images.map(image => { const attachmentId = crypto.randomUUID(); imageStore.set(attachmentId, image); return { attachmentId, name: image.name, thumbnail: image.thumbnail }; }),
  loadImageAttachments: async records => records.map(record => imageStore.get(record.attachmentId)),
};
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
const buildSideChatMessages = (question, context, _language, understanding) => [...context, { role: "user", content: chatImageApi.combineQuestion(question, understanding) }];
const buildLocalSideChatReply = () => "Recoverable fallback";
const showToast = text => toasts.push(text);
class AuthRequiredError extends Error {}
const sendWorkbenchRequest = async request => {
  const { onStream, signal, ...payload } = request;
  requests.push(structuredClone(payload)); lastStreamCallback = onStream;
  for (const event of streamEvents) onStream?.(event);
  if (pendingRequest) await pendingRequest;
  if (streamFailure) throw Object.assign(new Error("Stream interrupted"), { code: "STREAM_INTERRUPTED" });
  if (requestFailure) throw new Error("request unavailable"); return { reply: "Regenerated answer" };
};
const renderWorkspaceExplorer = () => { workspaceTreeContainer.replaceChildren(); for (const file of workspaceTree.children) { const row = document.createElement("label"); row.className = "workspace-file-row"; const input = document.createElement("input"); input.type = "checkbox"; input.dataset.workspaceFile = file.relativePath; row.append(input, file.relativePath); workspaceTreeContainer.append(row); } };
`;
(async () => {
  try {
    await app.whenReady();
    const win = new BrowserWindow({ width: 850, height: 800, show: false, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } });
    const css = fs.readFileSync(path.join(root, "docs/styles.css"), "utf8");
    const debugMarkup = fs.readFileSync(path.join(root, "docs/index.html"), "utf8").match(/<section id="debugConsole"[\s\S]*?<\/section>/)[0];
    const modelMarkup = fs.readFileSync(path.join(root, "docs/index.html"), "utf8").match(/<label class="side-chat-model-control"[\s\S]*?<\/label>/)[0];
    const historyMarkup = fs.readFileSync(path.join(root, "docs/index.html"), "utf8").match(/<label class="side-chat-history-control"[\s\S]*?<\/label>/)[0];
    const fixtureHtml = `<html><head><meta charset="utf-8"><style>${css}</style></head><body style="padding:24px"><main style="max-width:700px"><div class="panel-actions">${modelMarkup}<button id="clear">New Chat</button></div>${historyMarkup}<div id="tree"></div><div id="history" class="side-chat-history"></div><div id="examples"></div><form id="composer" class="side-chat-form"><div id="sideChatImagePreviews" class="chat-image-previews" hidden></div><textarea id="input"></textarea><input id="sideChatImageInput" type="file" accept="image/png,image/jpeg,image/webp" multiple hidden><div class="side-chat-compose-actions"><button id="attachSideChatImageButton" type="button">Add images</button><button id="send" type="button">Ask</button></div><p id="sideChatImageStatus" role="status"></p></form></main></body></html>`;
    const fixturePath = path.join(profile, "fixture.html");
    fs.writeFileSync(fixturePath, fixtureHtml);
    await win.loadFile(fixturePath);
    await win.webContents.executeJavaScript(fs.readFileSync(path.join(root, "shared/source-citations.js"), "utf8"));
    await win.webContents.executeJavaScript(fs.readFileSync(path.join(root, "shared/chat-images.js"), "utf8"));
    await win.webContents.executeJavaScript(fs.readFileSync(path.join(root, "docs/chat-image-composer.js"), "utf8"));
    await win.webContents.executeJavaScript(`document.body.insertAdjacentHTML("beforeend", ${JSON.stringify('<button data-debug-open data-debug-label="open">Debug Console</button>' + debugMarkup)})`);
    await win.webContents.executeJavaScript(fs.readFileSync(path.join(root, "docs/runtime-log.js"), "utf8"));
    await win.webContents.executeJavaScript("window.BioDesignRuntimeLog.installPanel()");
    await win.webContents.executeJavaScript(fs.readFileSync(path.join(root, "docs/agent-work-area.js"), "utf8"));
    await win.webContents.executeJavaScript(`${setup}\n${functions}\n${scrollInspection}\n${modelEvents}\n${historyEvents}\n${events}\n${fs.readFileSync(path.join(__dirname, "scenarios.js"), "utf8")}`);
    await win.webContents.executeJavaScript("initializeSideChatImages()");
    const result = await win.webContents.executeJavaScript("runScenarios()");
    const screenshot = path.join(profile, "editor.png");
    await win.webContents.executeJavaScript("resetConversation(); edit(); document.querySelector('[data-side-chat-edit-input]').setSelectionRange(0, 14)");
    const image = await win.webContents.capturePage();
    fs.writeFileSync(screenshot, image.toPNG());
    const citationScreenshot = path.join(profile, "citations.png");
    await win.webContents.executeJavaScript(`
      resetConversation(); sideChatHistory.replaceChildren(); workspaceTreeContainer.replaceChildren();
      sideChatHistory.style.width = "360px";
      sources[0].path = "literature/2016-2025/2017--Continuous abatement of methane coupled with ectoine production by Methylomicrobium alcaliphilum 20Z in stirred tank reactors - A step further towards greenhouse gas biorefineries.pdf";
      workspaceTree.children[0].relativePath = sources[0].path;
      addSideChatMessage("assistant", "- **合成途径**：依克多因的生物合成由 ectabc 操纵子控制 [[cite:paper-a]]。\\n- **生物学功能**：依克多因作为一种**相容性溶质 (Compatible solute)** 和渗透保护剂，帮助细菌在高盐或极端环境下生存 [cite:paper-a]。");
    `);
    await win.webContents.executeJavaScript("new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))");
    fs.writeFileSync(citationScreenshot, (await win.webContents.capturePage()).toPNG());
    const streamingScreenshot = path.join(profile, "streaming.png");
    await win.webContents.executeJavaScript(`
      resetConversation(); sideChatHistory.replaceChildren(); workspaceTreeContainer.replaceChildren(); analysisPanelStack.replaceChildren();
      translations.streamingAnswer = "正在生成回答…";
      addSideChatMessage("user", "请总结论文中关于依克多因的证据。");
      const preview = createStreamingAnswer(sideChatHistory, sideChatHistory);
      preview.update({ type: "delta", text: "**依克多因的作用**\\n\\n现有论文描述了依克多因作为相容性溶质的作用。它帮助细菌适应高盐环境。\\n\\n- 甲烷氧化过程可以与依克多因生产结合 [[cite:paper-a]]。\\n- 接下来需要比较各项实验的产率和培养条件。" });
      new Promise(resolve => setTimeout(resolve, 80));
    `);
    fs.writeFileSync(streamingScreenshot, (await win.webContents.capturePage()).toPNG());
    const imageComposerScreenshot = path.join(profile, "image-composer.png");
    await win.webContents.executeJavaScript(`
      (async () => {
      resetConversation(); sideChatHistory.replaceChildren(); workspaceTreeContainer.replaceChildren(); analysisPanelStack.replaceChildren();
      document.querySelector("main").style.maxWidth = "400px";
      sideChatHistory.style.width = "100%";
      translations.removeChatImage = "Remove image";
      translations.askButton = "提问"; setSideChatBusy(false);
      document.querySelector("#attachSideChatImageButton").textContent = "添加图片";
      document.querySelector("#attachSideChatImageButton").className = "secondary-button chat-image-upload";
      sendSideChatButton.className = "primary-button";
      await sideChatImageComposer.addFiles([await chartImageFile("activity-chart.png"), await chartImageFile("comparison.webp", "image/webp")]);
      if (sendSideChatButton.disabled) throw new Error("The image composer did not re-enable Send");
      sideChatInput.value = "请结合所选论文，解释这两张图中的酶活性变化。";
      const hint = document.createElement("p"); hint.className = "chat-image-hint"; hint.textContent = "添加、粘贴或拖入最多 4 张图片 · PNG、JPG、WebP"; sideChatForm.append(hint);
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      })()
    `);
    fs.writeFileSync(imageComposerScreenshot, (await win.webContents.capturePage()).toPNG());
    const imageEditorScreenshot = path.join(profile, "image-editor.png");
    await win.webContents.executeJavaScript(`
      (async () => {
        resetConversation();
        translations.attachChatImages = "Add images";
        translations.chatImageHint = "Add, paste, or drop up to 4 images · PNG, JPG, WebP";
        await seedMessageImage(); edit();
        pasteImages(input(), [await chartImageFile("pasted-comparison.png")]);
        await imagesReady(sideChatMessageEdit.composer);
        input().value = "Compare the activity in these two images.";
        sideChatHistory.scrollTop = sideChatHistory.scrollHeight;
        await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      })()
    `);
    fs.writeFileSync(imageEditorScreenshot, (await win.webContents.capturePage()).toPNG());
    console.log("SIDE_CHAT_RESULT " + JSON.stringify({ ...result, screenshot, citationScreenshot, streamingScreenshot, imageComposerScreenshot, imageEditorScreenshot }));
    win.destroy();
    app.exit(0);
  } catch (error) {
    console.error(error.stack);
    app.exit(1);
  }
})();
