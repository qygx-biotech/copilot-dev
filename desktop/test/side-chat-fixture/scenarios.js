const oldMessages = [
  { id: "user-1", role: "user", content: "Earlier question" },
  { id: "assistant-1", role: "assistant", content: "Earlier answer" },
  { id: "user-2", role: "user", content: "Latest question with readable text 中文" },
  { id: "assistant-2", role: "assistant", content: "Obsolete answer" },
];
function resetConversation() {
  requests = []; saves = []; toasts = []; saveFailAt = 0; requestFailure = false; pendingRequest = null;
  exists = true; existenceGate = null; fileChecks = [];
  streamEvents = []; streamFailure = false; lastStreamCallback = null;
  sideChatBusy = false; sideChatModel = "default"; defaultSideChatModel = ""; renderSideChatModelControl();
  sideChatImageComposer?.clear(); imageCalls = []; contextCalls = []; contextModels = []; imageModels = []; imageResponseStatus = 200; imageGate = null;
  sideChatMessages = structuredClone(oldMessages);
  sideChatConversation = { id: "chat", title: "Chat", messages: sideChatMessages };
  sideChatNavigationBusy = false; historyGate = null;
  savedConversations.clear(); savedConversations.set("chat", structuredClone(sideChatConversation));
  sideChatConversations = [{ id: "chat", title: "Chat", messageCount: sideChatMessages.length }];
  renderSideChatConversationSelect();
  workspaceManager.workspace.workspaceId = "w-1";
  sources[0].catalogStatus = "ready"; sources[0].contentHash = "hash-a";
  renderSideChatConversation();
}
const equal = (actual, expected, message = "Unexpected result") => { if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error(message + ": " + JSON.stringify({ actual, expected })); };
const ok = (condition, message) => { if (!condition) throw new Error(message); };
const tick = () => new Promise(resolve => setTimeout(resolve, 0));
async function chartImageFile(name = "activity.png", type = "image/png") {
  const canvas = document.createElement("canvas"); canvas.width = 800; canvas.height = 520;
  const context = canvas.getContext("2d"); context.fillStyle = "#ffffff"; context.fillRect(0, 0, 800, 520);
  context.fillStyle = "#263e43"; context.font = "30px sans-serif"; context.fillText("Enzyme activity (U/mL)", 70, 55);
  context.strokeStyle = "#a0adb0"; context.lineWidth = 3; context.beginPath(); context.moveTo(75, 90); context.lineTo(75, 435); context.lineTo(730, 435); context.stroke();
  context.strokeStyle = "#008678"; context.lineWidth = 8; context.beginPath(); context.moveTo(110, 390); context.lineTo(300, 240); context.lineTo(495, 130); context.lineTo(700, 265); context.stroke();
  context.fillText("5       6        7        8   pH", 110, 490);
  return new File([await new Promise(resolve => canvas.toBlob(resolve, type))], name, { type });
}
async function idle() { for (let i = 0; i < 100; i++) { await tick(); if (!sideChatBusy) return; } throw new Error("Side Chat remained busy"); }
async function imagesReady(composer) {
  for (let i = 0; i < 200; i++) { await tick(); if (!composer.preparing) return; }
  throw new Error("Image preparation remained busy");
}
function pasteImages(target, files = [], text = "") {
  const clipboardData = new DataTransfer();
  for (const file of files) clipboardData.items.add(file);
  if (text) clipboardData.setData("text/plain", text);
  const event = new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData });
  target.dispatchEvent(event);
  return event;
}
async function seedMessageImage() {
  const image = await window.BioDesignChatImageComposer.prepareImage(await chartImageFile("original.png"));
  sideChatMessages[2].images = await workspaceChatStore.saveImageAttachments([image]);
  sideChatMessages[2].imageUnderstanding = { text: "Stale image observations", model: "previous" };
  renderSideChatConversation();
  return sideChatMessages[2].images[0];
}
const edit = () => sideChatHistory.querySelector('[data-side-chat-action="edit"]').click();
const input = () => sideChatHistory.querySelector('[data-side-chat-edit-input]');
const save = () => sideChatHistory.querySelector('[data-side-chat-action="save-edit"]');
function checkReplacement(question) {
  equal(requests.length, 1, "Exactly one regeneration");
  equal(sideChatMessages.map(m => m.content), ["Earlier question", "Earlier answer", question, "Regenerated answer"]);
  equal(saves[0].messages.map(m => m.content), ["Earlier question", "Earlier answer", question], "Checkpoint includes replacement");
  equal(requests[0].messages.map(m => m.content), ["Earlier question", "Earlier answer", question], "Obsolete answer excluded from model context");
}
function luminance(color) {
  const [r, g, b] = color.match(/[\d.]+/g).slice(0, 3).map(Number).map(v => { v /= 255; return v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4; });
  return .2126 * r + .7152 * g + .0722 * b;
}
function contrast(foreground, background) { const a = luminance(foreground), b = luminance(background); return (Math.max(a, b) + .05) / (Math.min(a, b) + .05); }
async function runScenarios() {
  const passed = [], failed = [];
  async function scenario(name, callback) { resetConversation(); try { await callback(); passed.push(name); } catch (error) { failed.push({ name, error: error.message }); } }
  await scenario("New Chat preserves the previous conversation and history selection resumes its context", async () => {
    const recommendation = structuredClone(currentRecommendation);
    sideChatInput.value = "Unsent draft";
    clearSideChatButton.click(); await idle();
    const newId = sideChatConversation.id;
    ok(newId !== "chat", "New Chat reused a nonempty conversation");
    equal(sideChatMessages, []);
    equal(savedConversations.get("chat").messages, oldMessages);
    equal(sideChatInput.value, "");
    equal(sideChatConversationSelect.options.length, 2);
    equal(sideChatConversationSelect.value, newId);
    clearSideChatButton.click(); await idle();
    equal(sideChatConversation.id, newId, "Empty New Chat should be reused");
    sideChatConversationSelect.value = "chat";
    sideChatConversationSelect.dispatchEvent(new Event("change")); await idle();
    equal(sideChatMessages, oldMessages);
    equal(sideChatConversation.id, "chat");
    equal(sideChatConversationSelect.value, "chat");
    await askSideChat("Continue the earlier discussion");
    equal(requests[0].messages.slice(0, oldMessages.length).map(message => message.content), oldMessages.map(message => message.content));
    equal(currentRecommendation, recommendation);
  });
  await scenario("History controls lock during an answer or switch, and failed saves keep the current chat", async () => {
    setSideChatBusy(true);
    ok(clearSideChatButton.disabled && sideChatConversationSelect.disabled, "History controls must lock during answers");
    await changeSideChatConversation();
    equal(savedConversations.size, 1);
    setSideChatBusy(false);
    saveFailAt = 1;
    await changeSideChatConversation();
    equal(sideChatConversation.id, "chat");
    equal(sideChatMessages, oldMessages);
    equal(savedConversations.size, 1);
    ok(toasts.length === 1, "Failed saves must be visible");
    saveFailAt = 0;
    let release; historyGate = new Promise(resolve => { release = resolve; });
    const pending = changeSideChatConversation(); await tick();
    ok(clearSideChatButton.disabled && sideChatConversationSelect.disabled, "History controls must lock during switches");
    await changeSideChatConversation();
    release(); await pending;
    equal(savedConversations.size, 2, "A double click created duplicate chats");
    ok(!sideChatConversationSelect.disabled, "History did not unlock");
  });
  for (const width of [1500, 1200, 900]) await scenario(`Chat history fits the full Side Chat panel at ${width}px`, async () => {
    const frame = document.createElement("iframe");
    frame.style.cssText = `width:${width}px;height:720px;max-width:none;border:0`;
    const loaded = new Promise(resolve => { frame.onload = resolve; });
    frame.srcdoc = `<style>${document.querySelector("style").textContent}</style><div style="max-width:${width > 1280 ? "480px" : "none"}">${sideChatPanelMarkup}</div>`;
    document.body.append(frame);
    try {
      await loaded;
      const doc = frame.contentDocument;
      const panel = doc.querySelector(".side-chat-panel");
      const select = doc.getElementById("sideChatConversationSelect");
      for (let i = 0; i < 5; i++) {
        const option = doc.createElement("option");
        option.textContent = "A long saved literature discussion with 中文标题 ".repeat(3);
        select.append(option);
      }
      const panelBox = panel.getBoundingClientRect(), selectBox = select.getBoundingClientRect();
      ok(selectBox.left >= panelBox.left && selectBox.right <= panelBox.right, "History selector overflowed the panel");
      const sendBox = doc.getElementById("sendSideChatButton").getBoundingClientRect();
      if (sendBox.bottom > panelBox.bottom) {
        const control = doc.querySelector(".side-chat-history-control");
        control.style.display = "none";
        const withoutHistory = doc.getElementById("sendSideChatButton").getBoundingClientRect().bottom;
        throw new Error("History hid the Send button: " + JSON.stringify({ panelBottom: panelBox.bottom, sendBottom: sendBox.bottom, withoutHistory }));
      }
      ok(doc.getElementById("sideChatForm").getBoundingClientRect().bottom <= panelBox.bottom, "History clipped the composer");
      if (width === 1200) {
        equal(frame.contentWindow.getComputedStyle(doc.querySelector(".side-chat-history-control")).gridColumn, "1 / -1");
      }
    } finally { frame.remove(); }
  });
  await scenario("Model selection replaces levels, persists independently, and is sent with Side Chat", async () => {
    equal(sideChatModelSelect.options.length, 2);
    updateSideChatModelConfiguration({ chatModel: "google/gemini-fixture" });
    equal(sideChatModelSelect.options[0].textContent, "google/gemini-fixture");
    equal(sideChatModelSelect.options[1].textContent, "nvidia/nemotron-3-nano-omni");
    equal(sideChatModelSelect.value, "default");
    equal(sideChatModelSelect.title, "google/gemini-fixture");
    updateSideChatModelConfiguration({});
    equal(defaultSideChatModel, "");
    equal(sideChatModelSelect.options[0].textContent, "google/gemma-4-31b-it");
    equal(sideChatModelSelect.title, "google/gemma-4-31b-it");
    equal(normalizeSideChatModel("high"), "default");
    const model = "nvidia/nemotron-3-nano-omni-30b-a3b-reasoning";
    sideChatModelSelect.value = model;
    sideChatModelSelect.dispatchEvent(new Event("change"));
    equal(sideChatModel, model); equal(retrievalProfile, "light");
    equal(workspaceManager.state.ui.sideChatModel, model);
    equal(workspaceManager.state.ui.retrievalProfile, "light");
    equal(sideChatModelSelect.title, model);
    await askSideChat("Summarize this paper");
    equal(requests[0].model, model);
  });
  await scenario("An in-flight Side Chat keeps its chosen model while the next choice changes", async () => {
    const model = "nvidia/nemotron-3-nano-omni-30b-a3b-reasoning";
    sideChatModel = model;
    const pending = askSideChat("Summarize this paper");
    sideChatModel = "default";
    await pending;
    equal(requests[0].model, model);
    equal(contextModels, [model]);
  });
  await scenario("The configured display name survives older FC responses and localization without overriding routing", async () => {
    const option = sideChatModelSelect.querySelector('option[value="default"]');
    const originalName = option.dataset.modelName;
    const originalTranslation = translations.sideChatModelDefault;
    try {
      option.dataset.modelName = "google/default-fixture";
      translations.sideChatModelDefault = "默认模型";
      for (const data of [{}, { chatModel: null }, { chatModel: "   " }]) {
        updateSideChatModelConfiguration(data);
        equal(option.textContent, "google/default-fixture");
        equal(sideChatModelSelect.title, "google/default-fixture");
        equal(sideChatModelDescription.textContent, "google/default-fixture");
      }
      updateSideChatModelConfiguration({ chatModel: "google/updated-fixture" });
      equal(option.textContent, "google/updated-fixture");
      equal(sideChatModelSelect.title, "google/updated-fixture");
      // The language pass may replace text; rendering must restore the model name.
      option.textContent = t("sideChatModelDefault");
      renderSideChatModelControl();
      equal(option.textContent, "google/updated-fixture");
      await askSideChat("Summarize this paper");
      equal(requests[0].model, "default");
      equal(retrievalProfile, "light");
    } finally {
      if (originalName === undefined) delete option.dataset.modelName;
      else option.dataset.modelName = originalName;
      if (originalTranslation === undefined) delete translations.sideChatModelDefault;
      else translations.sideChatModelDefault = originalTranslation;
    }
  });
  await scenario("Debug Console shows live stages, copies metadata, clears, localizes, and closes without blocking chat", async () => {
    const log = window.BioDesignRuntimeLog;
    const panel = document.getElementById("debugConsole"), output = document.getElementById("debugConsoleOutput");
    const opener = document.querySelector("[data-debug-open]");
    log.clear();
    log.record("sync-agent.started", { agent: "KnowledgeSyncAgent", sourceCount: 3 });
    opener.click();
    ok(!panel.hidden && output.textContent.includes("KnowledgeSyncAgent"), "Saved log did not render on open");
    log.record("preflight.stage", { stage: "sync-paper-cards", sourceId: "paper-1", layer: "L2", body: "secret document" });
    await new Promise(resolve => requestAnimationFrame(resolve));
    ok(output.textContent.includes("sync-paper-cards") && !output.textContent.includes("secret document"), "Live update missing or unsafe");
    ok(output.clientHeight > 0 && panel.getBoundingClientRect().bottom <= innerHeight, "Log panel is outside viewport");
    const style = getComputedStyle(output);
    ok(contrast(style.color, getComputedStyle(panel).backgroundColor) >= 4.5, "Unreadable console text");
    let copied = "";
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: async value => { copied = value; } } });
    document.getElementById("debugConsoleCopy").click(); await tick();
    equal(copied, log.exportText());
    log.setLanguage("zh"); equal(opener.textContent, "调试控制台");
    document.getElementById("debugConsoleClear").click();
    await new Promise(resolve => requestAnimationFrame(resolve));
    equal(log.entries().length, 0);
    ok(!output.textContent.includes("KnowledgeSyncAgent"), "Clear left old entries visible");
    document.getElementById("debugConsoleClose").click();
    ok(panel.hidden && document.activeElement === opener, "Close did not restore focus");
    log.setLanguage("en");
  });
  for (const width of [1500, 1200, 900]) await scenario(`Packaged smoke accepts bounded Side Chat at ${width}px and rejects unbounded history`, async () => {
    const frame = document.createElement("iframe");
    frame.style.cssText = `width:${width}px;height:800px;max-width:none;border:0`;
    const loaded = new Promise(resolve => { frame.onload = resolve; });
    frame.srcdoc = `<style>${document.querySelector("style").textContent}</style><section class="side-chat-panel"><div id="sideChatHistory" class="side-chat-history">History</div></section>`;
    document.body.append(frame);
    try {
      await loaded;
      const result = inspectSideChatScrollLayout(frame.contentDocument);
      equal(result.viewportWidth, width);
      ok(result.bounded, "Existing responsive scroll containment rejected: " + JSON.stringify(result));
      const doc = frame.contentDocument;
      doc.getElementById("sideChatHistory").style.maxHeight = "none";
      doc.querySelector(".side-chat-panel").style.maxHeight = "none";
      ok(!inspectSideChatScrollLayout(doc).bounded, "Unbounded history must fail smoke validation");
    } finally {
      frame.remove();
    }
  });
  await scenario("Only the latest user turn is editable; Cancel preserves history", async () => {
    equal(sideChatHistory.querySelectorAll('[data-side-chat-action="edit"]').length, 1);
    beginSideChatMessageEdit("user-1"); equal(input(), null);
    edit(); input().value = "Discard this draft";
    sideChatHistory.querySelector('[data-side-chat-action="cancel-edit"]').click();
    equal(input(), null); equal(sideChatMessages, oldMessages); equal(saves.length, 0);
  });
  await scenario("Editor text, caret, selection, and both action buttons have readable computed colors", async () => {
    edit();
    const style = getComputedStyle(input()), selection = getComputedStyle(input(), "::selection");
    ok(contrast(style.color, style.backgroundColor) >= 4.5, "Textarea contrast below 4.5");
    equal(style.caretColor, style.color);
    ok(contrast(selection.color, selection.backgroundColor) >= 4.5, "Selection contrast below 4.5");
    for (const label of sideChatHistory.querySelectorAll(".editing .chat-image-hint, .editing .chat-image-status")) {
      ok(contrast(getComputedStyle(label).color, getComputedStyle(label.closest(".side-message")).backgroundColor) >= 4.5, "Image hint or error is unreadable on the message background");
    }
    for (const button of sideChatHistory.querySelectorAll(".side-message-edit-actions button")) {
      const style = getComputedStyle(button);
      ok(contrast(style.color, style.backgroundColor) >= 4.5, "Action contrast below 4.5: " + button.textContent);
      ok(button.getBoundingClientRect().width > 0 && !button.disabled, "Action unavailable");
    }
  });
  await scenario("Corpus activity keeps 41-paper progress separate from fallback chunks", async () => {
    equal(
      sideChatProgressText({
        stage: "canonical-paper-artifact-create",
        papersCompleted: 3,
        papersTotal: 41,
        completed: 0,
        total: 5,
      }),
      "Creating paper analysis · 3/41"
    );
    equal(
      sideChatProgressText({
        stage: "canonical-paper-artifact-create",
        papersCompleted: 3,
        papersTotal: 41,
        chunksCompleted: 2,
        chunksTotal: 5,
      }),
      "Creating paper analysis · 3/41 · fallback chunk 2/5"
    );
    equal(
      sideChatProgressText({
        stage: "canonical-paper-artifact-create",
        route: "combined-text",
        papersCompleted: 3,
        papersTotal: 41,
        chunkCount: 5,
      }),
      "Creating paper analysis from extracted text · 3/41"
    );
    currentLanguage = "zh";
    const chineseCombined = sideChatProgressText({
      stage: "canonical-paper-artifact-create",
      route: "combined-text",
      papersCompleted: 3,
      papersTotal: 41,
      chunkCount: 5,
    });
    equal(chineseCombined, "正在从提取文本创建论文分析 · 3/41");
    ok(!chineseCombined.includes("回退分块"), "Combined text must not be labeled as fallback chunks");
    currentLanguage = "en";
  });
  await scenario("Click Save reads changed textarea value and replaces exactly one turn", async () => { edit(); input().value = "  Edited question  "; save().click(); await idle(); checkReplacement("Edited question"); });
  await scenario("Unchanged text intentionally regenerates", async () => { edit(); save().click(); await idle(); checkReplacement(oldMessages[2].content); });
  for (const modifier of ["ctrlKey", "metaKey"]) await scenario(modifier + "+Enter uses the Save path", async () => {
    edit(); input().value = "Keyboard edit " + modifier;
    input().dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: "Enter", [modifier]: true }));
    await idle(); checkReplacement("Keyboard edit " + modifier);
  });
  await scenario("Empty input is visibly rejected without changing or persisting history", async () => {
    edit(); input().value = " \n "; save().click(); await tick();
    equal(input().getAttribute("aria-invalid"), "true");
    ok(sideChatHistory.querySelector('[role="alert"]').textContent.includes("Enter a message"), "Missing visible error");
    equal(sideChatMessages, oldMessages); equal(requests.length, 0); equal(saves.length, 0);
  });
  await scenario("Rapid duplicate Save and keyboard submissions issue one request", async () => {
    let release; pendingRequest = new Promise(resolve => release = resolve);
    edit(); input().value = "One submission"; const button = save(); button.click(); button.click();
    await reviseLatestSideChatMessage("user-2", "Duplicate");
    for (let i = 0; i < 20 && !requests.length; i++) await tick();
    equal(requests.length, 1); ok(sideChatBusy && sendSideChatButton.disabled, "Busy controls not protected");
    release(); await idle(); checkReplacement("One submission");
  });
  await scenario("Checkpoint failure restores original history and retains editable draft for retry", async () => {
    saveFailAt = 1; edit(); input().value = "Recover my draft"; save().click(); await idle();
    equal(sideChatMessages, oldMessages); equal(input().value, "Recover my draft"); equal(requests.length, 0);
    ok(sideChatHistory.querySelector('[role="alert"]'), "No persistence error");
    saveFailAt = 0; saves = []; save().click(); await idle(); checkReplacement("Recover my draft");
  });
  await scenario("Request failure retains replacement turn, removes obsolete answer, and permits retry", async () => {
    requestFailure = true; edit(); input().value = "Retry this question"; save().click(); await idle();
    equal(sideChatMessages.length, 4); equal(sideChatMessages[2].content, "Retry this question");
    ok(sideChatMessages[3].content.includes("fallback"), "No recoverable failure response");
    ok(!sideChatMessages.some(m => m.content === "Obsolete answer"), "Obsolete answer survived");
    requestFailure = false; requests = []; saves = []; edit(); save().click(); await idle(); checkReplacement("Retry this question");
  });
  await scenario("Final persistence failure retains answer in memory without appending another fallback", async () => {
    saveFailAt = 2; edit(); input().value = "Final save recovery"; save().click(); await idle();
    equal(sideChatMessages.length, 4); equal(sideChatMessages[3].content, "Regenerated answer");
    ok(toasts.includes(translations.chatPersistenceFailed), "No visible final-save failure");
    saveFailAt = 0; await persistSideChatConversation(); equal(saves.at(-1).messages.length, 4);
  });
  const citation = () => sourceCitationApi.bindToWorkspace(sourceCitationApi.resolveAnswer("[local:1]", sourceCitationApi.createRegistry([{ sourceId: "paper-a", relativePath: sources[0].path, aliases: ["local:1"], contentHash: "hash-a" }], "Project Folder")).citations, getSideChatCitationContext(true))[0];
  await scenario("Citation labels use verified metadata and navigation focuses the exact workspace file", async () => {
    const entry = citation();
    addSideChatMessage("assistant", "[Model supplied false name](biodesign-citation:citation-1)", { citations: [entry] });
    const button = sideChatHistory.querySelector("[data-side-chat-citation]");
    equal(button.textContent, "酶活性.pdf");
    equal(button.title, "Project Folder / literature / 中文 / 酶活性.pdf");
    equal(button.getAttribute("aria-label"), button.title);
    button.click(); await tick(); await tick();
    equal(fileChecks, [sources[0].path]); equal(document.activeElement.dataset.workspaceFile, sources[0].path);
    equal(selectedWorkspacePaths.size, 0, "Citation navigation must not change evidence selection");
    ok(expandedWorkspacePaths.has("literature/中文"), "Nested folder was not expanded");
  });
  await scenario("Saved grouped citations render as compact clickable links alongside existing registered links", async () => {
    const entry = citation();
    addSideChatMessage("assistant", "*   合成途径 [[cite:paper-a], [cite:unknown-id]]，已有来源 [Old label](biodesign-citation:citation-1)。\n    *   嵌套引用 [[cite:paper-a]]。", { citations: [entry] });
    const body = sideChatHistory.lastElementChild.querySelector(".side-message-body");
    ok(!/cite:|paper-a|unknown-id|\[\[/.test(body.textContent), "Raw citation IDs leaked into prose");
    const buttons = [...body.querySelectorAll("[data-side-chat-citation]")];
    equal(buttons.length, 4);
    equal(buttons.map(button => button.disabled), [false, true, false, false]);
    equal(buttons[2].dataset.sideChatCitation, "citation-1");
    buttons[0].click(); await tick(); await tick();
    equal(document.activeElement.dataset.workspaceFile, sources[0].path);
  });
  await scenario("Long citation filenames fit one line in a narrow chat and expose the full path on hover", async () => {
    const originalPath = sources[0].path;
    const originalWidth = sideChatHistory.style.width;
    try {
      sources[0].path = "literature/deep/2017--Continuous abatement of methane coupled with ectoine production by Methylomicrobium alcaliphilum 20Z in stirred tank reactors - A step further towards greenhouse gas biorefineries.pdf";
      workspaceTree.children[0].relativePath = sources[0].path;
      sideChatHistory.style.width = "280px";
      const entry = citation();
      addSideChatMessage("assistant", "生物学功能：相容性溶质 [Source](biodesign-citation:citation-1)。", { citations: [entry] });
      const body = sideChatHistory.lastElementChild.querySelector(".side-message-body");
      const button = body.querySelector("[data-side-chat-citation]");
      equal(button.title, "Project Folder / " + sources[0].path.split("/").join(" / "));
      ok(button.textContent.length <= 56 && button.textContent.includes("…"), "Filename was not shortened");
      ok(button.getBoundingClientRect().width <= body.clientWidth, "Link overflowed the chat");
      ok(button.getBoundingClientRect().height <= parseFloat(getComputedStyle(button).lineHeight) + 1, "Link wrapped to multiple lines");
      equal(getComputedStyle(button).textOverflow, "ellipsis");
      button.focus(); equal(document.activeElement, button);
      button.click(); await tick(); await tick(); equal(fileChecks, [sources[0].path]);
    } finally {
      sources[0].path = originalPath; workspaceTree.children[0].relativePath = originalPath;
      sideChatHistory.style.width = originalWidth;
    }
  });
  await scenario("Missing metadata and missing sources disable citation navigation", async () => {
    addSideChatMessage("assistant", "[Fake](biodesign-citation:citation-99) and [local:999]");
    for (const button of sideChatHistory.querySelectorAll("[data-side-chat-citation]")) ok(button.disabled && /unavailable/.test(button.textContent), "Unverified link enabled");
    const entry = citation(); exists = false; await navigateSideChatCitation(entry); equal(toasts.at(-1), translations.citationUnavailable);
  });
  await scenario("Saved inline local:7 references render as compact links to the original real file", async () => {
    const entry = { ...citation(), reference: "local:7" };
    addSideChatMessage("assistant", "根据工作区提供的文献证据（特别是 `local:7`），模型如下。另见 local:7。", { citations: [entry] });
    const body = sideChatHistory.lastElementChild.querySelector(".side-message-body");
    ok(!body.textContent.includes("local:7") && !body.querySelector("code"), "Internal handle still rendered as code");
    const buttons = [...body.querySelectorAll("[data-side-chat-citation]")];
    equal(buttons.length, 2); equal(buttons.map(button => button.textContent), ["酶活性.pdf", "酶活性.pdf"]);
    equal(buttons[0].title, "Project Folder / literature / 中文 / 酶活性.pdf");
    buttons[0].click(); await tick(); await tick();
    equal(fileChecks, [sources[0].path]); equal(document.activeElement.dataset.workspaceFile, sources[0].path);
    // Without the original mapping the same spelling must never choose another file.
    addSideChatMessage("assistant", "Unknown `local:7` and local:999.");
    const unknown = sideChatHistory.lastElementChild.querySelector(".side-message-body");
    ok(!unknown.textContent.includes("local:"), "Unmapped handle leaked");
    for (const button of unknown.querySelectorAll("[data-side-chat-citation]")) ok(button.disabled, "Guessed a target for an unmapped historical alias");
  });
  await scenario("Streaming bare and backtick catalog handles never expose partial internal references", async () => {
    const preview = createStreamingAnswer(sideChatHistory, sideChatHistory);
    try {
      for (const text of ["根据证据（特别是 `local:", "7", "`），参考 local:", "9", "99。"] ) {
        preview.update({ type: "delta", text });
        await new Promise(resolve => setTimeout(resolve, 60));
        ok(!sideChatHistory.querySelector(".streaming-answer").textContent.includes("local:"), "Stream exposed an internal reference");
      }
    } finally { preview.remove(); }
  });
  await scenario("Workspace switches during citation validation cannot navigate the next workspace", async () => {
    let release; existenceGate = new Promise(resolve => release = resolve);
    const navigation = navigateSideChatCitation(citation());
    workspaceManager.workspace.workspaceId = "w-2"; release(); await navigation;
    equal(toasts.at(-1), translations.citationUnavailable);
    equal(expandedWorkspacePaths.has("outside"), false);
  });
  await scenario("Streaming text is visible before completion, hides partial citations, and persists exactly one final answer", async () => {
    let release; pendingRequest = new Promise(resolve => { release = resolve; });
    streamEvents = [{ type: "delta", text: "中文 draft [[cite:paper-" }];
    const pending = askSideChat("Stream my answer");
    for (let i = 0; i < 50 && !lastStreamCallback; i++) await tick();
    await new Promise(resolve => setTimeout(resolve, 60));
    const preview = sideChatHistory.querySelector(".streaming-answer");
    ok(preview && !preview.hidden, "No visible draft while request is pending");
    ok(preview.textContent.includes("中文 draft") && !preview.textContent.includes("paper-"), "Partial citation ID leaked");
    equal(sideChatMessages.at(-1).role, "user", "A partial answer was committed");
    ok(!saves.some(save => JSON.stringify(save).includes("中文 draft")), "A partial answer was persisted");
    lastStreamCallback({ type: "reset" });
    ok(preview.hidden, "Tool iteration did not clear its provisional text");
    lastStreamCallback({ type: "delta", text: "Replacement draft" });
    release(); await pending;
    equal(sideChatMessages.at(-1).content, "Regenerated answer");
    equal(sideChatMessages.filter(message => message.content === "Regenerated answer").length, 1);
    ok(!sideChatHistory.querySelector(".streaming-answer"), "Provisional duplicate remained after completion");
  });
  await scenario("Interrupted streams keep a clearly incomplete draft without persisting a fake assistant answer", async () => {
    streamEvents = [{ type: "delta", text: "Partial result" }]; streamFailure = true;
    await askSideChat("Interrupted answer");
    const preview = sideChatHistory.querySelector(".streaming-answer");
    ok(preview && !preview.hidden && preview.textContent.includes("Partial result"), "Lost the partial preview");
    equal(preview.getAttribute("aria-busy"), "false");
    ok(preview.textContent.includes("streamInterrupted"), "Missing interruption label");
    equal(sideChatMessages.at(-1).role, "user");
    ok(!saves.some(save => JSON.stringify(save).includes("Partial result")), "Incomplete result was persisted");
  });
  await scenario("Agent Command previews a stream but replaces the recommendation only after a complete response", async () => {
    const tree = workspaceTree; workspaceTree = null;
    let release; pendingRequest = new Promise(resolve => { release = resolve; });
    streamEvents = [{ type: "delta", text: "Provisional analysis" }];
    currentRecommendation = agentPanel.recommendation = { title: "Existing recommendation" }; panelSaves = [];
    try {
      const pending = runAgentInstruction("agent-panel");
      for (let i = 0; i < 50 && !lastStreamCallback; i++) await tick();
      await new Promise(resolve => setTimeout(resolve, 60));
      ok(analysisPanelStack.textContent.includes("Provisional analysis"), "No streamed Agent Command preview");
      equal(currentRecommendation.title, "Existing recommendation");
      ok(!JSON.stringify(panelSaves).includes("Provisional analysis"), "A draft recommendation was saved");
      release(); await pending;
      equal(currentRecommendation.title, "Regenerated answer");
      ok(!analysisPanelStack.querySelector(".streaming-answer"), "Preview remained after commit");
      streamFailure = true; pendingRequest = null;
      agentPanel.instruction = "Review the next result";
      await runAgentInstruction("agent-panel");
      equal(currentRecommendation.title, "Regenerated answer", "Interrupted stream replaced the official recommendation");
      equal(agentPanel.status, "streamInterrupted");
    } finally { workspaceTree = tree; }
  });
  await scenario("Switching workspace during a stream cannot append the old answer to the new conversation", async () => {
    let release; pendingRequest = new Promise(resolve => { release = resolve; });
    streamEvents = [{ type: "delta", text: "Old workspace draft" }];
    const pending = askSideChat("Old workspace question");
    for (let i = 0; i < 50 && !lastStreamCallback; i++) await tick();
    workspaceManager.workspace.workspaceId = "w-2";
    sideChatConversation = { id: "new-chat", messages: [] }; sideChatMessages = [];
    release(); await pending;
    equal(sideChatMessages.length, 0);
    ok(!sideChatHistory.querySelector(".streaming-answer"), "Old draft survived the workspace switch");
  });
  await scenario("Native image decoding produces bounded image bytes and a small preview", async () => {
    const prepared = await window.BioDesignChatImageComposer.prepareImage(await chartImageFile());
    ok(chatImageApi.dataUrlInfo(prepared.dataUrl), "Prepared payload is invalid");
    ok(chatImageApi.dataUrlInfo(prepared.thumbnail, chatImageApi.limits.thumbnailBytes), "Thumbnail exceeded its limit");
  });
  await scenario("Upload button selects images, shows removable previews and rejects unsupported or excessive attachments", async () => {
    const picker = document.querySelector("#sideChatImageInput"), button = document.querySelector("#attachSideChatImageButton");
    let opened = false; const originalClick = picker.click; picker.click = () => { opened = true; };
    button.click(); picker.click = originalClick; ok(opened, "Upload button did not open picker");
    const transfer = new DataTransfer(); transfer.items.add(await chartImageFile()); picker.files = transfer.files;
    picker.dispatchEvent(new Event("change"));
    for (let i = 0; i < 100 && sideChatImageComposer.preparing; i++) await tick();
    equal(sideChatImageComposer.images.length, 1);
    ok(!sendSideChatButton.disabled, "Send did not re-enable after the image was prepared");
    const preview = document.querySelector("#sideChatImagePreviews img"); ok(preview?.naturalWidth > 0, "Image preview did not decode");
    ok(preview.getBoundingClientRect().width <= 64, "Preview is not compact");
    await sideChatImageComposer.addFiles([new File(["text"], "note.txt", { type: "text/plain" })]);
    equal(sideChatImageComposer.images.length, 1); ok(document.querySelector("#sideChatImageStatus").textContent, "No unsupported-file error");
    const file = await chartImageFile(); await sideChatImageComposer.addFiles([file, file, file, file]);
    equal(sideChatImageComposer.images.length, 1);
    document.querySelector("#sideChatImagePreviews button").click(); equal(sideChatImageComposer.images.length, 0);
  });
  await scenario("Dragging an image onto the composer attaches it without navigating or sending a request", async () => {
    const dataTransfer = new DataTransfer(); dataTransfer.items.add(await chartImageFile("dropped.png", "image/webp"));
    const event = new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer });
    sideChatInput.dispatchEvent(event);
    for (let i = 0; i < 100 && sideChatImageComposer.preparing; i++) await tick();
    ok(event.defaultPrevented, "Image drop could navigate away");
    equal(sideChatImageComposer.images.length, 1); equal(imageCalls.length, 0); equal(requests.length, 0);
    setSideChatBusy(true); sideChatInput.dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer }));
    equal(sideChatImageComposer.images.length, 1); setSideChatBusy(false);
  });
  await scenario("Pasting a screenshot shows a removable preview and sends it through vision", async () => {
    const event = pasteImages(sideChatInput, [await chartImageFile("Screenshot.png")]);
    ok(event.defaultPrevented, "Screenshot paste was not handled");
    await imagesReady(sideChatImageComposer);
    equal(sideChatImageComposer.images.map(image => image.name), ["Screenshot.png"]);
    ok(document.querySelector("#sideChatImagePreviews img"), "Screenshot preview missing");
    equal(imageCalls.length, 0); equal(requests.length, 0);
    sideChatInput.value = "Explain the screenshot";
    await submitSideChat();
    equal(imageCalls[0].images.map(image => image.name), ["Screenshot.png"]);
    ok(contextCalls[0].includes("25 U/mL"), "Pasted image observations did not reach the normal pipeline");
  });
  await scenario("Plain text and mixed clipboard text retain native paste behavior; busy and image limits apply", async () => {
    ok(!pasteImages(sideChatInput, [], "Keep this text").defaultPrevented, "Plain text paste was swallowed");
    const file = await chartImageFile();
    ok(!pasteImages(sideChatInput, [file], "Keep both").defaultPrevented, "Mixed clipboard text was swallowed");
    await imagesReady(sideChatImageComposer); equal(sideChatImageComposer.images.length, 1);
    setSideChatBusy(true); pasteImages(sideChatInput, [file]); equal(sideChatImageComposer.images.length, 1);
    setSideChatBusy(false);
    pasteImages(sideChatInput, [file, file, file, file]);
    equal(sideChatImageComposer.images.length, 1);
    equal(document.querySelector("#sideChatImageStatus").textContent, "imageCountLimit");
  });
  await scenario("Removing all images from an edited message regenerates without stale image observations", async () => {
    await seedMessageImage(); edit();
    const composer = sideChatMessageEdit.composer;
    equal(composer.images.length, 1);
    sideChatHistory.querySelector(".editing .chat-image-preview button").click();
    equal(composer.images.length, 0);
    input().value = "Use only my text now"; save().click(); await idle();
    equal(imageCalls.length, 0);
    ok(!sideChatMessages.at(-2).images?.length && !sideChatMessages.at(-2).imageUnderstanding, "Removed image or understanding persisted");
    ok(!JSON.stringify(requests).includes("Stale image observations"), "Removed evidence reached the answer");
    equal(contextCalls, ["Use only my text now"]);
  });
  await scenario("Editing combines retained and newly uploaded images once and preserves the main composer's draft", async () => {
    const original = await seedMessageImage();
    await sideChatImageComposer.addFiles([await chartImageFile("next-question.png")]);
    edit();
    const editor = sideChatHistory.querySelector(".side-message-edit-composer"), picker = editor.querySelector('input[type="file"]');
    let opened = false; picker.click = () => { opened = true; };
    editor.querySelector(".chat-image-upload").click(); ok(opened, "Editor upload did not open picker");
    const transfer = new DataTransfer(); transfer.items.add(await chartImageFile("added.png"));
    picker.files = transfer.files; picker.dispatchEvent(new Event("change"));
    ok(save().disabled, "Save enabled during image preparation");
    await imagesReady(sideChatMessageEdit.composer);
    input().value = "Compare both images"; save().click(); await idle();
    equal(imageCalls.length, 1); equal(imageCalls[0].images.map(image => image.name), ["original.png", "added.png"]);
    equal(sideChatMessages.at(-2).images.length, 2); equal(sideChatMessages.at(-2).images[0].attachmentId, original.attachmentId);
    equal(sideChatImageComposer.images.map(image => image.name), ["next-question.png"]);
    ok(!JSON.stringify(saves).includes('"dataUrl"'), "Full image bytes leaked into saved history");
  });
  await scenario("Replacing an edited message's image by pasting sends only the replacement, including an image-only edit", async () => {
    const original = await seedMessageImage(); edit();
    sideChatHistory.querySelector(".editing .chat-image-preview button").click();
    pasteImages(input(), [await chartImageFile("replacement.png")]);
    await imagesReady(sideChatMessageEdit.composer);
    input().value = ""; save().click(); await idle();
    equal(imageCalls.length, 1); equal(imageCalls[0].question, "imageOnlyQuestion");
    equal(imageCalls[0].images.map(image => image.name), ["replacement.png"]);
    ok(sideChatMessages.at(-2).images[0].attachmentId !== original.attachmentId, "Old attachment survived replacement");
  });
  await scenario("An edited text-only message accepts an image drop; Cancel leaves the saved message intact", async () => {
    edit(); const transfer = new DataTransfer(); transfer.items.add(await chartImageFile("dropped-edit.png"));
    const event = new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: transfer });
    input().dispatchEvent(event); await imagesReady(sideChatMessageEdit.composer);
    ok(event.defaultPrevented, "Editor drop was not handled"); equal(sideChatMessageEdit.composer.images.length, 1);
    sideChatHistory.querySelector('[data-side-chat-action="cancel-edit"]').click();
    equal(sideChatMessages, oldMessages); equal(saves.length, 0); equal(sideChatMessageEdit, null);
  });
  await scenario("Cancel preserves original attachments and discards an image still being decoded", async () => {
    await seedMessageImage(); const before = structuredClone(sideChatMessages); edit();
    const composer = sideChatMessageEdit.composer, detachedInput = input();
    sideChatHistory.querySelector(".editing .chat-image-preview button").click();
    const file = await chartImageFile("discarded.png");
    const pending = composer.addFiles([file]);
    sideChatHistory.querySelector('[data-side-chat-action="cancel-edit"]').click(); await pending;
    equal(sideChatMessages, before); equal(composer.images.length, 0); equal(sideChatMessageEdit, null);
    pasteImages(detachedInput, [file]); await tick();
    equal(composer.images.length, 0); equal(saves.length, 0);
    edit(); equal(sideChatMessageEdit.composer.images.map(image => image.name), ["original.png"]);
  });
  await scenario("A failed edit checkpoint restores text and image changes for retry", async () => {
    await seedMessageImage(); const before = structuredClone(sideChatMessages); edit();
    sideChatHistory.querySelector(".editing .chat-image-preview button").click();
    await sideChatMessageEdit.composer.addFiles([await chartImageFile("retry.png")]);
    input().value = "Retry my new image"; saveFailAt = 1; save().click(); await idle();
    equal(sideChatMessages, before); equal(input().value, "Retry my new image");
    equal(sideChatMessageEdit.composer.images.map(image => image.name), ["retry.png"]);
    equal(imageCalls.length, 0); equal(requests.length, 0);
    saveFailAt = 0; save().click(); await idle();
    equal(imageCalls.length, 1); equal(imageCalls[0].images.map(image => image.name), ["retry.png"]);
  });
  await scenario("Clearing or switching workspace during image preparation discards the late preview", async () => {
    const pending = sideChatImageComposer.addFiles([await chartImageFile()]);
    sideChatImageComposer.clear(); await pending;
    equal(sideChatImageComposer.images.length, 0); equal(sideChatImageComposer.preparing, false);
  });
  await scenario("Vision finishes before context preparation and the final answer receives image observations plus the typed question", async () => {
    await sideChatImageComposer.addFiles([await chartImageFile()]); sideChatInput.value = "Compare this activity with the papers";
    let release; imageGate = new Promise(resolve => { release = resolve; });
    const model = "nvidia/nemotron-3-nano-omni-30b-a3b-reasoning";
    sideChatModel = model;
    const pending = submitSideChat();
    for (let i = 0; i < 100 && !imageCalls.length; i++) await tick();
    equal(imageCalls.length, 1); equal(contextCalls.length, 0); equal(requests.length, 0);
    ok(sideChatHistory.querySelector(".chat-image-previews img"), "Sent message lost its image preview");
    equal(imageModels, [model]);
    sideChatModel = "default";
    release(); await pending;
    equal(contextModels, [model]);
    equal(requests[0].model, model);
    equal(contextCalls.length, 1); ok(contextCalls[0].includes("Compare this activity") && contextCalls[0].includes("25 U/mL"), "Context omitted text or image evidence");
    ok(requests[0].messages.at(-1).content.includes("25 U/mL"), "Main answer did not receive image understanding");
    ok(!JSON.stringify(requests).includes("data:image"), "Raw image bytes leaked into the normal answer pipeline");
    equal(sideChatMessages.at(-2).content, "Compare this activity with the papers");
    equal(sideChatImageComposer.images.length, 0);
  });
  await scenario("Image-only submissions work and editing the latest question reuses the stored image for fresh vision analysis", async () => {
    await sideChatImageComposer.addFiles([await chartImageFile()]); sideChatInput.value = "";
    await submitSideChat(); equal(imageCalls[0].question, "imageOnlyQuestion");
    const user = sideChatMessages.at(-2), id = user.images[0].attachmentId;
    await reviseLatestSideChatMessage(user.id, "Read the axis units instead");
    equal(imageCalls.length, 2); equal(imageCalls[1].question, "Read the axis units instead");
    equal(sideChatMessages.at(-2).images[0].attachmentId, id);
    renderSideChatConversation(); ok(sideChatHistory.querySelector(".chat-image-previews img"), "Reloaded conversation lost previews");
  });
  await scenario("A vision failure keeps the image available for retry and never starts knowledge or answer calls", async () => {
    imageResponseStatus = 502;
    await sideChatImageComposer.addFiles([await chartImageFile()]); sideChatInput.value = "Explain this figure";
    await submitSideChat();
    equal(contextCalls.length, 0); equal(requests.length, 0); equal(sideChatMessages.at(-1).role, "user");
    ok(toasts.includes("chatImageFailed"), "Image failure was not visible");
    imageResponseStatus = 200; await reviseLatestSideChatMessage(sideChatMessages.at(-1).id, "Explain this figure");
    equal(imageCalls.length, 2); equal(requests.length, 1);
  });
  await scenario("Changing workspace while vision is pending does not start the old answer pipeline", async () => {
    await sideChatImageComposer.addFiles([await chartImageFile()]); sideChatInput.value = "Explain";
    let release; imageGate = new Promise(resolve => { release = resolve; }); const pending = submitSideChat();
    for (let i = 0; i < 100 && !imageCalls.length; i++) await tick();
    workspaceManager.workspace.workspaceId = "w-2"; sideChatMessages = []; sideChatConversation = { id: "new", messages: [] };
    release(); await pending;
    equal(contextCalls.length, 0); equal(requests.length, 0); equal(sideChatMessages.length, 0);
  });
  return { passed, failed };
}
