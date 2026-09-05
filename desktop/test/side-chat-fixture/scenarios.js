const oldMessages = [
  { id: "user-1", role: "user", content: "Earlier question" },
  { id: "assistant-1", role: "assistant", content: "Earlier answer" },
  { id: "user-2", role: "user", content: "Latest question with readable text 中文" },
  { id: "assistant-2", role: "assistant", content: "Obsolete answer" },
];
function resetConversation() {
  requests = []; saves = []; toasts = []; saveFailAt = 0; requestFailure = false; pendingRequest = null;
  exists = true; existenceGate = null; fileChecks = [];
  sideChatBusy = false;
  sideChatMessages = structuredClone(oldMessages);
  sideChatConversation = { id: "chat", title: "Chat", messages: sideChatMessages };
  workspaceManager.workspace.workspaceId = "w-1";
  sources[0].catalogStatus = "ready"; sources[0].contentHash = "hash-a";
  renderSideChatConversation();
}
const equal = (actual, expected, message = "Unexpected result") => { if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error(message + ": " + JSON.stringify({ actual, expected })); };
const ok = (condition, message) => { if (!condition) throw new Error(message); };
const tick = () => new Promise(resolve => setTimeout(resolve, 0));
async function idle() { for (let i = 0; i < 100; i++) { await tick(); if (!sideChatBusy) return; } throw new Error("Side Chat remained busy"); }
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
    for (const button of sideChatHistory.querySelectorAll(".side-message-edit-actions button")) {
      const style = getComputedStyle(button);
      ok(contrast(style.color, style.backgroundColor) >= 4.5, "Action contrast below 4.5: " + button.textContent);
      ok(button.getBoundingClientRect().width > 0 && !button.disabled, "Action unavailable");
    }
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
    equal(button.textContent, "Project Folder / literature / 中文 / 酶活性.pdf");
    button.click(); await tick(); await tick();
    equal(fileChecks, [sources[0].path]); equal(document.activeElement.dataset.workspaceFile, sources[0].path);
    equal(selectedWorkspacePaths.size, 0, "Citation navigation must not change evidence selection");
    ok(expandedWorkspacePaths.has("literature/中文"), "Nested folder was not expanded");
  });
  await scenario("Missing metadata and missing sources disable citation navigation", async () => {
    addSideChatMessage("assistant", "[Fake](biodesign-citation:citation-99) and [local:999]");
    for (const button of sideChatHistory.querySelectorAll("[data-side-chat-citation]")) ok(button.disabled && /unavailable/.test(button.textContent), "Unverified link enabled");
    const entry = citation(); exists = false; await navigateSideChatCitation(entry); equal(toasts.at(-1), translations.citationUnavailable);
  });
  await scenario("Workspace switches during citation validation cannot navigate the next workspace", async () => {
    let release; existenceGate = new Promise(resolve => release = resolve);
    const navigation = navigateSideChatCitation(citation());
    workspaceManager.workspace.workspaceId = "w-2"; release(); await navigation;
    equal(toasts.at(-1), translations.citationUnavailable);
    equal(expandedWorkspacePaths.has("outside"), false);
  });
  return { passed, failed };
}
