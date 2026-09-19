async function runAgentScenarios() {
  document.getElementById("loginPanel").hidden = true;
  document.getElementById("loginPanel").classList.add("is-hidden");
  const shell = document.getElementById("appShell"); shell.hidden = false; shell.classList.remove("is-hidden");
  document.getElementById("sideChatExamples").hidden = true;
  document.getElementById("sideChatContextChips").textContent = "Entire Project";
  document.getElementById("projectContext").value = "Compare evidence and plan the next analysis.";
  const legacy = normalizeStoredAnalysisPanel({ id: "legacy", instruction: "Previously reviewed evidence", frozen: true, collapsed: true, recommendation: { ...createDefaultRecommendation(), currentInterpretation: "Previous result", updatedAt: "2026-09-01T12:00:00.000Z" } });
  analysisPanels = [legacy]; renderAnalysisPanels();
  check(legacy.messages.length === 2 && !legacy.frozen && legacy.collapsed, "Legacy result becomes editable chat history without losing its collapse state");
  const savedResult = currentRecommendation;
  addAnalysisPanelButton.click(); const first = analysisPanels[1];
  draft(first, "Review candidate evidence");
  const geminiFlex = "google/gemini-3.1-flash-lite:flex";
  setting(first, "selectedModel", geminiFlex);
  check(first.selectedModel === geminiFlex && ![...sideChatModelSelect.options].some(option => option.value === geminiFlex), "Gemini Flex is selectable in Agent Work without changing the Side Chat catalog");
  setting(first, "selectedPermission", "workspace_write");
  const files = new DataTransfer(); files.items.add(new File(["a,b"], "results.csv", { type: "text/csv" })); files.items.add(new File(["image"], "figure.png", { type: "image/png" }));
  const picker = card(first).querySelector('[data-agent-attachments="file"]'); picker.files = files.files; picker.dispatchEvent(new Event("change", { bubbles: true }));
  check(first.pendingAttachments.length === 2 && card(first).textContent.includes("figure.png"), "File and image selections produce removable chips");
  click(first, "remove-attachment");
  check(first.pendingAttachments.length === 1 && first.pendingAttachments[0].name === "figure.png", "Remove affects only the selected attachment");
  click(first, "new-chat"); const second = analysisPanels[2]; draft(second, "An independent second task");
  check(analysisPanels.every(chat => card(chat).querySelector('[data-analysis-action="new-chat"]') && card(chat).querySelector('[data-analysis-action="delete"]')), "Every expanded or collapsed task has new-chat and delete controls");
  const panelGap = card(second).getBoundingClientRect().top - card(first).getBoundingClientRect().bottom;
  check(panelGap >= 24 && !document.querySelector(".analysis-workspace-panel").classList.contains("workbench-panel") && card(first).classList.contains("workbench-panel"), "Tasks are separate panels with a visible page-background gap");
  check(first.instruction === "Review candidate evidence" && !first.collapsed && first.pendingAttachments.length === 1 && second.selectedPermission === "read_only", "Adding a chat preserves drafts, attachments, selections and expanded cards");
  check(currentRecommendation === savedResult && sideChatModelSelect.value === "default", "New tasks and Agent model changes leave the current result and Side Chat selection alone");
  click(first, "toggle");
  check(first.collapsed && !second.collapsed && card(first).querySelector(".agent-chat-summary").textContent.includes("Review candidate"), "Independent collapse keeps a meaningful clickable summary");
  card(first).querySelector(".agent-chat-summary").click();
  const focused = draft(second, "Continue drafting while the first task runs"); focused.focus(); focused.setSelectionRange(4, 9); renderAnalysisPanels();
  check(document.activeElement.value === second.instruction && document.activeElement.selectionStart === 4, "Progress renders preserve composer focus and selection");
  let release; requestGate = new Promise(resolve => { release = resolve; });
  card(first).querySelector("form").requestSubmit(); await tick();
  check(first.taskStatus === "running" && first.messages.length === 1 && card(second).querySelector('[type="submit"]').disabled, "Submit creates a user turn and preserves the existing single-run guard");
  deleteAnalysisPanel(first.id);
  check(findAnalysisPanel(first.id) === first && card(first).querySelector('[data-analysis-action="delete"]').disabled, "Running tasks cannot be deleted or detached from their execution");
  click(legacy, "new-chat"); const temporary = analysisPanels[1];
  check(temporary !== first && analysisPanels[2] === first, "A card's new-chat action inserts immediately below that card");
  click(temporary, "delete");
  check(!findAnalysisPanel(temporary.id) && activeAgentPanelId === first.id && first.taskStatus === "running", "Deleting a different task leaves the current run intact");
  check(requests[0].model === geminiFlex && !requests[0].permission && !requests[0].attachments && requests[0].messages[0].content === "Review candidate evidence", "The captured Agent model reaches the request while attachments stay local");
  check(contextRequests[0].callContext.model === geminiFlex && contextRequests[0].turnId === requests[0].callContext.turnId, "The captured Agent model reaches preparation before the answer under the same turn ID");
  check(first.messages[0].requestedModel === geminiFlex && first.messages[0].permission === "workspace_write" && first.messages[0].attachments[0].name === "figure.png", "Submitted turn captures requested model, permission and attachment metadata");
  setting(first, "selectedModel", "default");
  check(requests[0].model === geminiFlex && first.messages[0].requestedModel === geminiFlex, "Changing model during a run preserves the submitted model");
  setting(first, "selectedModel", geminiFlex);
  draft(first, "A follow-up draft"); setting(first, "selectedPermission", "full_access");
  click(first, "toggle"); await tick(); card(first).querySelector(".agent-chat-summary").click(); await tick();
  check(card(first).textContent.includes("Streaming task response"), "Streaming preview survives independent collapse and expand");
  click(first, "toggle"); release(); await tick(); requestGate = null;
  check(first.taskStatus === "completed" && first.collapsed && first.instruction === "A follow-up draft" && first.messages[0].permission === "workspace_write", "Completion respects collapse and preserves the next draft without changing submitted metadata");
  card(first).querySelector(".agent-chat-summary").click();
  check(card(first).querySelector("pre code") && card(first).querySelector("ol") && card(first).querySelector("ul"), "Agent turns reuse formatted Markdown for lists, code, headings and file references");
  click(first, "review"); click(first, "export"); click(first, "copy"); await tick();
  check(first.recommendation.reviewed && exports[0] === first.recommendation && copies[0].includes("Evidence review"), "Review, export and copy remain connected to the real recommendation state");
  const committed = first.recommendation;
  setting(first, "selectedModel", "default");
  requestFailure = Object.assign(new Error("Interrupted"), { code: "STREAM_INTERRUPTED" });
  await runAgentInstruction(first.id); requestFailure = null;
  check(contextRequests.at(-1).callContext?.model === undefined && requests.at(-1).model === "default", "Agent Default retains configured preparation roles and the configured answer model");
  setting(first, "selectedModel", geminiFlex);
  check(first.taskStatus === "failed" && first.messages.length === 4 && first.recommendation === committed, "An interrupted follow-up stays in history and does not replace the committed result");
  draft(first, "Retry the task"); await runAgentInstruction(first.id);
  check(first.messages.length === 6 && first.taskStatus === "completed" && second.messages.length === 0, "A follow-up appends to its own conversation and recovers after failure");
  const stored = JSON.parse(sessionStorage.getItem(ANALYSIS_PANELS_STORAGE_KEY));
  const restored = stored.map(normalizeStoredAnalysisPanel);
  check(restored[1].selectedModel === geminiFlex && normalizeStoredAnalysisPanel({ selectedModel: "unknown/model" }).selectedModel === "default", "Agent model selection survives reload and unknown models normalize to Default");
  const previousGemini = "google/gemini-2.5-flash-lite:flex";
  const migrated = normalizeStoredAnalysisPanel({ ...stored[1], selectedModel: previousGemini, messages: [{ id: "previous-gemini-turn", role: "user", content: "Previous request", requestedModel: previousGemini }] });
  check(migrated.selectedModel === geminiFlex && migrated.messages[0].requestedModel === previousGemini, "Saved Gemini 2.5 selection moves to Gemini 3.1 while historical turn metadata stays accurate");
  check(restored[1].messages.length === 6 && !restored[0].frozen && !restored[1].frozen && restored[2].instruction === second.instruction && restored.every(chat => chat.pendingAttachments.length === 0), "Session reload preserves independent chats and omits pending file objects");
  check(!JSON.stringify(stored).includes('"file":') && !JSON.stringify(stored).includes('"pendingAttachments":'), "No attachment bytes or File objects enter session storage");
  const interrupted = normalizeStoredAnalysisPanel({ ...stored[1], taskStatus: "running", status: "Busy", statusKey: "agentReviewing" });
  check(interrupted.taskStatus === "waiting" && !interrupted.status && !interrupted.statusKey, "Reloading an interrupted task does not leave it stuck running");
  for (let i = 0; i < 30; i++) first.messages.push({ role: i % 2 ? "assistant" : "user", content: `History item ${i}\n\nA sufficiently long paragraph to exercise internal conversation scrolling.` });
  renderAnalysisPanels();
  const history = card(first).querySelector(".agent-conversation"); history.scrollTop = 30; renderAnalysisPanels();
  check(history.scrollHeight > history.clientHeight && history.scrollTop === 30 && card(first).getBoundingClientRect().height === 660, "Long history stays within a bounded card and preserves the reader scroll position");
  for (let i = 0; i < 3; i++) addAnalysisPanelButton.click();
  await tick();
  const sideColumn = document.querySelector(".side-column");
  const centerColumn = document.querySelector(".center-column");
  const sideStyle = getComputedStyle(sideColumn);
  const stickyTop = Number.parseFloat(sideStyle.top);
  const wideLayout = innerWidth > 1280;
  check(
    (wideLayout
      ? sideStyle.position === "sticky"
        && sideStyle.alignSelf === "start"
        && Math.abs(stickyTop - 16) <= 0.1
        && sideColumn.offsetHeight + stickyTop <= innerHeight + 1
      : sideStyle.position === "static")
      && centerColumn.offsetHeight >= sideColumn.offsetHeight + 240,
    `Side Chat retains its sticky desktop and stacked responsive layout beside lower Agent tasks (position=${sideStyle.position}, width=${innerWidth}, top=${stickyTop}, sideHeight=${sideColumn.offsetHeight}, centerHeight=${centerColumn.offsetHeight}, viewport=${innerHeight})`,
  );
  const preservedChats = [...analysisPanels];
  const preservedResult = JSON.stringify(currentRecommendation);
  const preservedSecond = JSON.stringify(second);
  click(first, "delete");
  check(!findAnalysisPanel(first.id) && !card(first) && JSON.stringify(second) === preservedSecond, "Deleting a chosen task preserves every other task's local state");
  check(JSON.stringify(currentRecommendation) === preservedResult && !loadAnalysisPanels().some(chat => chat.id === first.id), "Deletion survives reload without changing the last committed recommendation");
  for (const chat of [...analysisPanels]) click(chat, "delete");
  check(!analysisPanels.length && !loadAnalysisPanels().length && analysisPanelStack.textContent.includes(t("agentNoTasks")), "Deleting all tasks leaves a persistent empty state instead of resurrecting history");
  addAnalysisPanelButton.click();
  check(analysisPanels.length === 1 && !analysisPanels[0].messages.length, "A fresh chat can be created after deleting the last task");
  analysisPanels = preservedChats; saveAnalysisPanels();
  // Leave a useful desktop preview with real rendered results and a collapsed task.
  analysisPanels.slice(3).forEach(chat => { chat.collapsed = true; });
  first.messages = first.messages.slice(0, 6);
  first.messages[1].webSearchSources = [{ url: "https://papers.example.org/ectd.pdf", title: "EctD <b>source</b>" }, { url: "javascript:alert(1)", title: "Unsafe" }];
  renderAnalysisPanels();
  const sourceLinks = card(first).querySelectorAll(".web-search-sources a");
  check(sourceLinks.length === 1 && sourceLinks[0].textContent === "EctD <b>source</b>" && !sourceLinks[0].querySelector("b") && sourceLinks[0].rel === "noopener noreferrer", "Provider sources render as safe, literal external links beside the answer");
  saveAnalysisPanels();
  check(loadAnalysisPanels()[1].messages[1].webSearchSources[0].url === "https://papers.example.org/ectd.pdf", "Web sources persist across Agent Work history reload");
  card(first).querySelector(".agent-conversation").scrollTop = 0;
  window.scrollTo(0, 0);
}

async function runAgentScopeIsolationChecks() {
  const originalBuild = projectContextService.buildContext;
  const documents = [
    { id: "side-paper", filename: "Side Chat paper.pdf", relativePath: "literature/side.pdf" },
    { id: "agent-paper", filename: "Agent paper.pdf", relativePath: "literature/agent.pdf" },
  ];
  const tree = { children: documents.map(document => ({ type: "file", relativePath: document.relativePath })) };
  projectContextService.buildContext = async options => {
    contextRequests.push(options);
    options.onCatalogUpdated(tree, documents);
    options.onProgress({ workflowId: "agent-workflow", stage: "corpus-map", phase: "map", completed: 1, total: 2 });
    return { literature: { relevantPaperIds: ["agent-paper"], discoveryMode: "automatic", corpusWideRequest: true,
      coverage: { papersIncludedInSnapshot: 2, papersSuccessfullyAnalyzed: 2 } }, experiments: { relevantExperimentIds: ["agent-experiment"] } };
  };
  try {
    for (const selected of [false, true]) {
      for (const failure of [false, true]) {
        applyRequestCatalog(tree, documents);
        selectedWorkspacePaths = new Set(selected ? ["literature/side.pdf"] : []);
        syncWorkspaceSelectionToDocuments();
        lastSourceUsage = selected ? { literature: { relevantPaperIds: ["side-paper"], discoveryMode: "automatic",
          coverage: { papersDiscovered: 2, papersSearchable: 1 } }, experiments: {} } : null;
        activeCorpusProgress = selected ? { workflowId: "side-workflow", phase: "prepare", completed: 0, total: 1 } : null;
        renderSideChatContext();
        const before = { markup: sideChatContextChips.innerHTML, usage: lastSourceUsage, progress: activeCorpusProgress,
          selection: JSON.stringify([...selectedWorkspacePaths]), model: sideChatModelSelect.value };
        addAnalysisPanelButton.click(); const chat = analysisPanels.at(-1);
        draft(chat, "Review the Agent paper");
        let release; requestGate = new Promise(resolve => { release = resolve; });
        const pending = runAgentInstruction(chat.id); await tick();
        check(lastSourceUsage === before.usage && activeCorpusProgress === before.progress && sideChatContextChips.innerHTML === before.markup,
          `Agent preparation keeps Side Chat scope chips and source usage unchanged (${selected ? "selected files" : "whole project"}, ${failure ? "failure" : "success"})`);
        check(chat.taskStatus === "running" && chat.status.includes("Selecting relevant paper evidence"), "Agent retrieval progress remains in its own panel");
        requestFailure = failure ? new Error("Fixture provider failure") : null;
        release(); await pending; requestGate = null; requestFailure = null;
        renderSideChatContext();
        check(lastSourceUsage === before.usage && activeCorpusProgress === before.progress && sideChatContextChips.innerHTML === before.markup &&
          JSON.stringify([...selectedWorkspacePaths]) === before.selection && sideChatModelSelect.value === before.model,
          `Side Chat scope stays intact after Agent ${failure ? "failure" : "completion"} and a later redraw (${selected ? "selected files" : "whole project"})`);
        check(literatureModule.documents.some(document => document.id === "agent-paper"), "Agent catalog reconciliation still refreshes the shared literature catalog");
        deleteAnalysisPanel(chat.id);
      }
    }
    sideChatContextChips.querySelector(".context-chip-remove").click();
    check(!selectedWorkspacePaths.size && sideChatContextChips.textContent.includes(t("entireProjectContext")), "Explicit Side Chat scope changes still work after Agent activity");
  } finally {
    projectContextService.buildContext = originalBuild;
    requestGate = null; requestFailure = null; lastSourceUsage = null; activeCorpusProgress = null;
    selectedWorkspacePaths.clear(); renderSideChatContext();
  }
}

let composerTestChat, composerRequestCount;
async function prepareNativeComposerChecks() {
  composerRequestCount = requests.length;
  addAnalysisPanelButton.click();
  composerTestChat = analysisPanels.at(-1);
  const input = card(composerTestChat).querySelector("[data-analysis-instruction]");
  input.scrollIntoView({ block: "center" }); input.focus();
  await tick();
}

async function checkNativeComposerClick() {
  await tick();
  check(requests.length === composerRequestCount + 1 && composerTestChat.messages[0].content === "Send with one click", "Run Agent sends on the first native click after typing and textarea blur");
  const input = card(composerTestChat).querySelector("[data-analysis-instruction]");
  input.focus();
  await tick();
}

async function checkNativeComposerNewline() {
  await tick();
  check(composerTestChat.instruction === "第一行\n第二行" && requests.length === composerRequestCount + 1, "Native Shift+Enter inserts a newline without sending");
}

async function checkNativeComposerEnterAndEditing() {
  await tick();
  const chat = composerTestChat;
  check(requests.length === composerRequestCount + 2 && chat.messages.at(-2).content === "第一行\n第二行", "Native Enter sends Chinese multiline text once through the existing Agent request");
  const key = (input, options = {}) => {
    const event = new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true, ...options });
    input.dispatchEvent(event); return event;
  };
  const input = draft(chat, "A draft for the next move");
  check(!key(input, { isComposing: true }).defaultPrevented && !key(input, { keyCode: 229 }).defaultPrevented, "IME confirmation Enter is left to the input method");
  key(input, { repeat: true });
  check(requests.length === composerRequestCount + 2, "Holding Enter does not submit repeated moves");
  const history = JSON.stringify(chat.messages), recommendation = chat.recommendation;
  check(card(chat).querySelectorAll('[data-analysis-action="edit"]').length === 1, "Only the latest user message has an edit control");
  click(chat, "edit");
  let editor = card(chat).querySelector("[data-agent-edit-input]");
  check(editor.value === "第一行\n第二行" && document.activeElement === editor, "Edit opens and focuses the latest message without changing history");
  editor.value = "Cancelled revision"; editor.dispatchEvent(new Event("input", { bubbles: true }));
  editor.setSelectionRange(2, 5); renderAnalysisPanels();
  editor = card(chat).querySelector("[data-agent-edit-input]");
  check(editor.value === "Cancelled revision" && document.activeElement === editor && editor.selectionStart === 2, "Editor draft and cursor survive panel redraws");
  click(chat, "cancel-edit");
  check(JSON.stringify(chat.messages) === history && chat.recommendation === recommendation && chat.instruction === "A draft for the next move", "Cancel preserves the original exchange, recommendation, and composer draft");
  click(chat, "edit");
  editor = card(chat).querySelector("[data-agent-edit-input]");
  editor.value = "  "; editor.dispatchEvent(new Event("input", { bubbles: true }));
  click(chat, "save-edit"); await tick();
  check(JSON.stringify(chat.messages) === history && chat.messageEdit && requests.length === composerRequestCount + 2, "Empty edits do not erase or submit the last exchange");
  editor.value = "修改后的检索请求"; editor.dispatchEvent(new Event("input", { bubbles: true }));
  check(!key(editor, { shiftKey: true }).defaultPrevented && !key(editor, { isComposing: true }).defaultPrevented, "The message editor also preserves Shift+Enter and IME Enter");
  const pendingAttachment = { id: "future-file", name: "future.txt", size: 4, type: "text/plain" };
  chat.pendingAttachments.push(pendingAttachment);
  setting(chat, "selectedModel", "google/gemini-3.1-flash-lite:flex");
  setting(chat, "selectedPermission", "read_only");
  editor = card(chat).querySelector("[data-agent-edit-input]");
  let release; requestGate = new Promise(resolve => { release = resolve; });
  key(editor); await tick();
  check(chat.taskStatus === "running" && card(chat).querySelector('[data-analysis-action="edit"]').disabled, "Saving an edit follows the existing busy guard and disables further editing");
  const runningRequests = requests.length;
  key(card(chat).querySelector("[data-analysis-instruction]"));
  await runAgentInstruction(chat.id, { messageId: chat.messages.at(-1).id, content: "Duplicate edit" });
  check(requests.length === runningRequests, "Enter and duplicate edits cannot start another request during a run");
  release(); await tick(); requestGate = null;
  check(chat.messages.length === 4 && JSON.stringify(chat.messages.slice(0, 2)) === JSON.stringify(JSON.parse(history).slice(0, 2)) && chat.messages[2].content === "修改后的检索请求", "Save and regenerate replaces only the latest exchange and preserves earlier turns");
  check(requests.at(-1).model === "google/gemini-3.1-flash-lite:flex" && chat.messages[2].permission === "read_only" && requests.at(-1).messages[0].content === "修改后的检索请求", "Edited text uses the selected model and permission through the existing request path");
  check(chat.instruction === "A draft for the next move" && chat.pendingAttachments[0] === pendingAttachment && !chat.messages[2].attachments.length, "Regeneration preserves the separate next-move draft and pending attachments");
  const saved = JSON.parse(sessionStorage.getItem(ANALYSIS_PANELS_STORAGE_KEY)).find(panel => panel.id === chat.id);
  check(saved.messages[2].content === "修改后的检索请求" && !Object.hasOwn(saved, "messageEdit"), "Only the saved revision enters persisted history");
  const count = requests.length;
  await runAgentInstruction(chat.id, { messageId: chat.messages[0].id, content: "Stale edit" });
  check(requests.length === count && chat.messages.length === 4, "Stale edits cannot change earlier user messages");
  deleteAnalysisPanel(chat.id);
  window.scrollTo(0, 0);
}

async function checkAcademicFinalReply() {
  for (const status of ["completed", "incomplete"]) {
    addAnalysisPanelButton.click();
    const chat = analysisPanels.at(-1);
    const reply = `已筛选出5篇相关文献，成功下载${status === "completed" ? 5 : 3}篇。\n\n**已下载文献**\n1. [1](https://papers.example.org/study-1) (AI与合成生物学研究)\n\n${status === "completed" ? "已完成下载。" : "其余2篇未成功下载：NO_ACCESSIBLE_PDF。"}`;
    try {
      draft(chat, "检索并下载AI与合成生物学文献");
      requestResult = { reply, taskOutcome: { status, downloadSuccessCount: status === "completed" ? 5 : 3, requestedPaperCount: 5 } };
      await runAgentInstruction(chat.id);
      const message = chat.messages.at(-1);
      check(message.content === reply, `Academic ${status} response keeps the assistant reply in conversation history`);
      const body = card(chat).querySelectorAll(".agent-message.assistant .side-message-body");
      const shown = body[body.length - 1];
      check(shown.textContent.includes("已筛选出5篇相关文献") && !shown.textContent.includes("PDFs saved"), `Academic ${status} display preserves the assistant language and wording`);
      check(shown.querySelector("a")?.href === "https://papers.example.org/study-1", `Academic ${status} citation is rendered as an online source link`);
      check(chat.taskStatus === (status === "completed" ? "completed" : "failed"), `Academic ${status} execution status remains separate from reply text`);
      const saved = JSON.parse(sessionStorage.getItem(ANALYSIS_PANELS_STORAGE_KEY)).find(panel => panel.id === chat.id);
      check(saved.messages.at(-1).content === reply, `Academic ${status} saved history retains the same final reply`);
    } finally { requestResult = null; deleteAnalysisPanel(chat.id); }
  }
}

async function checkResponsive(width) {
  await tick(); window.scrollTo(0, 0);
  const first = analysisPanels[1];
  const composer = card(first).querySelector("form");
  check(composer.scrollWidth <= composer.clientWidth + 1, `Composer controls fit at ${width}px`);
  const actions = card(first).querySelector(".agent-task-actions");
  check(actions.scrollWidth <= actions.clientWidth + 1, `Task actions fit at ${width}px`);
  check(card(first).querySelector(".analysis-panel-header").getBoundingClientRect().height < 150 && card(first).querySelector(".agent-conversation").clientHeight >= 150, `Task header stays compact and leaves room for conversation at ${width}px`);
  check(document.documentElement.scrollWidth <= innerWidth + 1, `Page has no horizontal overflow at ${width}px`);
  const viewportWidth = innerWidth;
  if (viewportWidth <= 1280) check(getComputedStyle(document.querySelector(".side-column")).position === "static", `Existing responsive Side Chat stacking retained at ${viewportWidth}px`);
  else check(getComputedStyle(document.querySelector(".workbench-grid")).gridTemplateColumns.split(" ").length === 3, `Three desktop columns retained at ${viewportWidth}px`);
}
