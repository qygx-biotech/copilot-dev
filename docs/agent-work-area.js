// Presentation and local turn state only. Execution remains in app.js.
(function (root) {
  const permissions = ["read_only", "workspace_write", "full_access"];
  const statuses = ["idle", "running", "waiting", "completed", "failed"];
  const attachmentMetadata = ({ id, name, type, size }) => ({ id, name, type, size });

  function hydrate(chat, { resultContent }) {
    const hasHistory = Array.isArray(chat.messages);
    const messages = hasHistory ? chat.messages : [];
    // Migrate real legacy results, without turning the default placeholder into a reply.
    if (!hasHistory && chat.recommendation?.updatedAt) {
      if (chat.instruction) messages.push({ id: `${chat.id}-user`, role: "user", content: chat.instruction, createdAt: chat.createdAt });
      messages.push({ id: `${chat.id}-result`, role: "assistant", content: resultContent(chat.recommendation), createdAt: chat.recommendation.updatedAt, isResult: true });
    }
    return {
      ...chat,
      title: typeof chat.title === "string" ? chat.title : (messages[0]?.role === "user" ? messages[0].content.slice(0, 64) : ""),
      summary: typeof chat.summary === "string" ? chat.summary : messages.length ? chat.recommendation?.currentInterpretation || "" : "",
      updatedAt: chat.updatedAt || chat.recommendation?.updatedAt || chat.createdAt,
      messages,
      instruction: !hasHistory && messages.length ? "" : chat.instruction || "",
      pendingAttachments: [], // File objects never enter session/workspace storage.
      messageEdit: null,
      selectedModel: typeof chat.selectedModel === "string" ? chat.selectedModel : "default",
      selectedPermission: permissions.includes(chat.selectedPermission) ? chat.selectedPermission : "read_only",
      taskStatus: chat.taskStatus === "running" ? "waiting" : statuses.includes(chat.taskStatus) ? chat.taskStatus : messages.length ? "completed" : "idle",
      status: chat.taskStatus === "running" ? "" : chat.status,
      statusKey: chat.taskStatus === "running" ? "" : chat.statusKey,
      frozen: false,
    };
  }

  function beginTurn(chat, { id, modelLabel, revision = null, now = new Date().toISOString() }) {
    // Capture the move's model and download permission before later UI changes.
    const turn = {
      id, content: revision ? revision.content : chat.instruction.trim(),
      requestedModel: chat.selectedModel || "default", modelLabel,
      permission: chat.selectedPermission || "read_only",
      attachments: [...(revision ? revision.message.attachments || [] : chat.pendingAttachments || [])],
      createdAt: now,
    };
    chat.messages ||= [];
    if (revision) {
      const index = chat.messages.indexOf(revision.message);
      chat.messages.splice(index);
      if (index === 0 && !chat.customTitle) chat.title = "";
    }
    chat.messages.push({ ...turn, role: "user", attachments: turn.attachments.map(attachmentMetadata) });
    if (!chat.title) chat.title = turn.content.replace(/\s+/g, " ").slice(0, 64);
    if (!revision) {
      chat.instruction = "";
      chat.pendingAttachments = [];
    }
    chat.messageEdit = null;
    chat.updatedAt = now;
    chat.taskStatus = "running";
    return turn;
  }

  function finishTurn(chat, turn, { content, summary = content, citations = [], webSearchSources = [], webSearchMetadata = [], academicSources = [], isResult = false, status = "completed" }) {
    const now = new Date().toISOString();
    const elapsedMs = Number.isFinite(Date.parse(turn.createdAt)) ? Math.max(0, Date.parse(now) - Date.parse(turn.createdAt)) : 0;
    chat.messages.push({ id: `${turn.id}-reply`, turnId: turn.id, role: "assistant", content, citations, webSearchSources, webSearchMetadata, academicSources, isResult, createdAt: now, elapsedMs });
    chat.summary = String(summary || "").replace(/[#*`>]/g, "").replace(/\s+/g, " ").trim().slice(0, 360);
    chat.updatedAt = now;
    chat.taskStatus = status;
  }

  function serialize(chats) {
    return chats.map(({ pendingAttachments, messageEdit, ...chat }) => chat);
  }

  function element(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function createTurnClock({ startedAt, elapsedMs = 0, working = false, label = '' } = {}) {
    const node = element('div', 'turn-message-clock');
    node.dataset.working = String(working);
    const icon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    icon.setAttribute('viewBox', '0 0 24 24'); icon.setAttribute('aria-hidden', 'true');
    const path = document.createElementNS(icon.namespaceURI, 'path');
    path.setAttribute('d', 'M12 6v6l4 2 M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0'); icon.append(path);
    const time = element('time');
    const caption = element('span', '', label);
    node.append(icon, caption, time);
    const start = Date.parse(startedAt);
    let timer;
    const paint = () => {
      const ms = working && Number.isFinite(start) ? Math.max(0, Date.now() - start) : Number.isFinite(elapsedMs) ? Math.max(0, elapsedMs) : 0;
      const seconds = Math.floor(ms / 1000);
      time.textContent = `${String(Math.floor(seconds / 3600)).padStart(2, '0')}:${String(Math.floor(seconds / 60) % 60).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
      time.dateTime = `PT${seconds}S`;
    };
    paint();
    if (working) timer = setInterval(() => { if (!node.isConnected) clearInterval(timer); else paint(); }, 1000);
    return { element: node, stop(finalLabel = label) { paint(); working = false; caption.textContent = finalLabel; node.dataset.working = 'false'; clearInterval(timer); }, remove() { clearInterval(timer); node.remove(); } };
  }

  // Presentation only: retain the original buttons and delegated action targets.
  function decorateMessage(article, { createdAt, copyLabel, editLabel }) {
    const bubble = element('div', 'message-bubble');
    const footer = element('div', 'message-actions');
    const copy = article.querySelector(':scope > .message-copy-button');
    const edit = article.querySelector(':scope > .side-message-edit-button');
    const date = new Date(createdAt || '');
    if (Number.isFinite(date.getTime())) {
      const time = element('time', 'message-time', date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }));
      time.dateTime = date.toISOString(); footer.append(time);
    }
    for (const [button, label, path] of [
      [copy, copyLabel, 'M9 7V5a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2h-2 M5 7h8a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V9a2 2 0 0 1 2-2Z'],
      [edit, editLabel, 'm16 3 5 5 M3 21l5-1L21 7a2 2 0 0 0-5-5L3 15v6Z'],
    ]) {
      if (!button) continue;
      const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      svg.setAttribute('viewBox', '0 0 24 24'); svg.setAttribute('aria-hidden', 'true');
      const stroke = document.createElementNS(svg.namespaceURI, 'path');
      stroke.setAttribute('d', path); svg.append(stroke);
      button.replaceChildren(svg); button.title = label; button.setAttribute('aria-label', label);
      footer.append(button);
    }
    bubble.append(...article.childNodes);
    article.append(bubble);
    if (footer.childNodes.length) article.append(footer);
  }

  function createAgentWorkArea({ container, t, formatTime, getModels, renderMarkdown, resultActions, getProgress, isBusy }) {
    // Keep stream hosts alive across collapse/expand and progress renders.
    const streamHosts = new Map();
    const conversations = new Map();
    const scrollPositions = new Map();

    function action(chat, name, label, className = "text-button") {
      const button = element("button", className, label);
      button.type = "button";
      button.dataset.analysisAction = name;
      button.dataset.panelId = chat.id;
      return button;
    }

    function createAgentChatHeader(chat) {
      const header = element("div", "analysis-panel-header");
      const toggle = action(chat, "toggle", "", "agent-chat-heading");
      toggle.setAttribute("aria-expanded", String(!chat.collapsed));
      toggle.setAttribute("aria-controls", `agent-body-${chat.id}`);
      toggle.append(element("h3", "", chat.title || t("agentNewTask")));
      const meta = element("span", "analysis-panel-meta");
      const status = element("span", `agent-task-status is-${chat.taskStatus}`, t(`agentStatus_${chat.taskStatus}`));
      meta.append(status, document.createTextNode(` · ${t("agentUpdated", { time: formatTime(chat.updatedAt || chat.createdAt) })} · ${t("agentTurns", { count: chat.messages.filter(message => message.role === "user").length })}`));
      toggle.append(meta);
      const control = action(chat, "toggle", chat.collapsed ? t("expandPanel") : t("collapsePanel"));
      control.setAttribute("aria-expanded", String(!chat.collapsed));
      control.setAttribute("aria-controls", `agent-body-${chat.id}`);
      const actions = element("div", "agent-task-actions");
      const newChat = action(chat, "new-chat", t("addAnalysisPanel"), "secondary-button");
      const remove = action(chat, "delete", t("agentDeleteTask"), "text-button agent-delete-task");
      remove.setAttribute("aria-label", t("agentDeleteTaskLabel", { title: chat.title || t("agentNewTask") }));
      remove.disabled = chat.taskStatus === "running";
      remove.title = remove.disabled ? t("agentDeleteRunningHint") : t("agentDeleteTaskHint");
      actions.append(newChat, remove, control);
      header.append(toggle, actions);
      return header;
    }

    function createAgentChatSummary(chat) {
      const summary = action(chat, "toggle", "", "agent-chat-summary");
      const text = chat.summary || [...chat.messages].reverse().find(message => message.role === "assistant")?.content || chat.messages[0]?.content || chat.instruction || t("agentEmptySummary");
      summary.append(element("span", "", text.replace(/[#*`>]/g, "").replace(/\s+/g, " ").trim()));
      summary.setAttribute("aria-label", `${t("expandPanel")}: ${chat.title || t("agentNewTask")}`);
      return summary;
    }

    function createAttachmentChips(chat, attachments, removable) {
      const chips = element("div", "agent-attachment-chips");
      for (const attachment of attachments) {
        const chip = element("span", "agent-attachment-chip");
        const name = element("span", "", attachment.name);
        name.title = attachment.name;
        chip.append(name);
        if (removable) {
          const remove = action(chat, "remove-attachment", "×", "context-chip-remove");
          remove.dataset.attachmentId = attachment.id;
          remove.setAttribute("aria-label", t("agentRemoveAttachment", { name: attachment.name }));
          chip.append(remove);
        }
        chips.append(chip);
      }
      return chips;
    }

    function createAgentMessage(chat, message, latestResult, latestUser) {
      const article = element("article", `side-message agent-message ${message.role === "user" ? "user" : "assistant"}`);
      article.append(element("strong", "", message.role === "user" ? t("sideChatUserLabel") : t("agentLabel")));
      const body = element("div", "side-message-body");
      if (message === latestUser && chat.messageEdit && chat.messageEdit.messageId === message.id) {
        const input = element("textarea", "side-message-edit-input");
        input.dataset.agentEditInput = "true";
        input.dataset.panelId = chat.id;
        input.value = chat.messageEdit.content;
        input.rows = 4;
        input.setAttribute("aria-label", t("editLastMessage"));
        input.disabled = isBusy();
        const actions = element("div", "side-message-edit-actions");
        const cancel = action(chat, "cancel-edit", t("cancelEdit"), "secondary-button");
        const save = action(chat, "save-edit", t("saveAndRegenerate"), "primary-button");
        cancel.disabled = save.disabled = isBusy();
        actions.append(cancel, save);
        body.append(input, actions);
      } else {
        renderMarkdown(body, message.content, message.citations);
        root.BioDesignWebSearch?.renderSources(body, message.webSearchSources);
        root.BioDesignWebSearch?.renderSources(body, (message.academicSources || []).flatMap(paper => {
          const location = paper.locations?.find(item => item.kind === "landing_page") || paper.locations?.[0];
          return location ? [{ title: paper.title, url: location.url }] : [];
        }));
      }
      article.append(body);
      if (message.attachments?.length) article.append(createAttachmentChips(chat, message.attachments, false));
      if (message.requestedModel) {
        article.append(element("p", "agent-turn-meta", t("agentMoveMetadata", { model: message.modelLabel || message.requestedModel, permission: t(`agentPermission_${message.permission}`) })));
      }
      if (message === latestUser && message.id && !chat.messageEdit) {
        const edit = action(chat, "edit", t("editLastMessage"), "side-message-edit-button");
        edit.dataset.messageId = message.id;
        edit.disabled = isBusy();
        article.append(edit);
      }
      if (message === latestResult) article.append(resultActions(chat));
      const copy = action(chat, "copy-message", t("copyMessage"), "message-copy-button");
      copy.dataset.messageId = message.id;
      article.append(copy);
      decorateMessage(article, { createdAt: message.createdAt, copyLabel: t('copyMessage'), editLabel: t('editLastMessage') });
      if (message.role === 'assistant') article.prepend(createTurnClock({ elapsedMs: message.elapsedMs, label: t('turnElapsed') }).element);
      return article;
    }

    function createAgentConversation(chat) {
      if (!conversations.has(chat.id)) conversations.set(chat.id, element("div", "agent-conversation"));
      const conversation = conversations.get(chat.id);
      conversation.replaceChildren();
      conversation.dataset.agentConversation = chat.id;
      conversation.tabIndex = 0;
      conversation.setAttribute("role", "region");
      conversation.setAttribute("aria-label", t("agentConversationLabel", { title: chat.title || t("agentNewTask") }));
      if (!chat.messages.length) {
        const empty = element("div", "agent-chat-empty");
        empty.append(element("h3", "", t("agentEmptyTitle")), element("p", "", t("agentEmptySummary")));
        conversation.append(empty);
      }
      const latestResult = [...chat.messages].reverse().find(message => message.isResult);
      const latestUser = chat.messages.findLast(message => message.role === "user");
      chat.messages.forEach(message => conversation.append(createAgentMessage(chat, message, latestResult, latestUser)));
      if (!streamHosts.has(chat.id)) streamHosts.set(chat.id, element("div", "agent-stream-slot"));
      if (chat.taskStatus === 'running') conversation.append(createTurnClock({ startedAt: latestUser?.createdAt, working: true, label: t('turnWorking') }).element);
      conversation.append(streamHosts.get(chat.id));
      return conversation;
    }

    function createSelector(chat, key, label, options) {
      const field = element("label", "agent-move-control", label);
      const select = element("select");
      select.dataset.agentSetting = key;
      select.dataset.panelId = chat.id;
      for (const option of options) {
        const node = element("option", "", option.label);
        node.value = option.value;
        node.title = option.title || option.label;
        select.append(node);
      }
      select.value = chat[key];
      if (!select.value) select.selectedIndex = 0;
      select.title = select.selectedOptions[0]?.title || "";
      field.append(select);
      return field;
    }

    function createAttachmentPicker(chat) {
      const picker = element("div", "agent-attachment-picker");
      for (const [kind, key] of [["file", "agentAttachFile"], ["image", "agentAttachImage"]]) {
        const input = element("input");
        input.type = "file";
        input.multiple = true;
        input.hidden = true;
        if (kind === "image") input.accept = "image/*";
        input.dataset.agentAttachments = kind;
        input.dataset.panelId = chat.id;
        const button = action(chat, `attach-${kind}`, t(key), "text-button");
        picker.append(input, button);
      }
      return picker;
    }

    function createAgentComposer(chat) {
      const composer = element("form", "agent-composer");
      composer.dataset.agentComposer = chat.id;
      if (chat.pendingAttachments.length) composer.append(createAttachmentChips(chat, chat.pendingAttachments, true));
      const label = element("label", "sr-only", t("agentComposerPlaceholder"));
      label.htmlFor = `agentInstruction-${chat.id}`;
      const input = element("textarea");
      input.id = label.htmlFor;
      input.rows = 3;
      input.placeholder = t("agentComposerPlaceholder");
      input.setAttribute("aria-describedby", `agentKeyboardHint-${chat.id}`);
      input.value = chat.instruction;
      input.dataset.analysisInstruction = "true";
      input.dataset.panelId = chat.id;
      composer.append(label, input);
      const controls = element("fieldset", "agent-next-move");
      controls.append(element("legend", "", t("agentNextMove")));
      const selectors = element("div", "agent-move-selectors");
      selectors.append(
        createSelector(chat, "selectedModel", t("agentModel"), getModels()),
        createSelector(chat, "selectedPermission", t("agentPermission"), permissions.map(value => ({ value, label: t(`agentPermission_${value}`) }))),
      );
      const actions = element("div", "agent-composer-actions");
      const run = element("button", "primary-button", chat.taskStatus === "running" ? t("agentStatus_running") : t("agentRun"));
      run.type = "submit";
      run.disabled = isBusy();
      actions.append(createAttachmentPicker(chat), run);
      controls.append(selectors, actions);
      const hint = element("p", "agent-composer-hint", t("agentKeyboardHint"));
      hint.id = `agentKeyboardHint-${chat.id}`;
      composer.append(controls, hint, element("p", "agent-composer-hint", t("agentUiOnlyHint")));
      return composer;
    }

    function createAgentChatCard(chat) {
      const article = element("article", `workbench-panel analysis-panel agent-chat-card${chat.collapsed ? " is-collapsed" : ""}`);
      article.dataset.panelId = chat.id;
      article.append(createAgentChatHeader(chat));
      const body = element("div", "agent-chat-body");
      body.id = `agent-body-${chat.id}`;
      body.hidden = chat.collapsed;
      if (chat.collapsed) article.append(createAgentChatSummary(chat));
      else {
        const status = element("p", "agent-chat-progress", getProgress(chat));
        status.setAttribute("role", "status");
        body.append(createAgentConversation(chat), status, createAgentComposer(chat));
      }
      article.append(body);
      return article;
    }

    function render(chats) {
      const focused = container.contains(document.activeElement) ? document.activeElement : null;
      const focusKey = focused && { panelId: focused.dataset.panelId, instruction: focused.hasAttribute("data-analysis-instruction"), editing: focused.hasAttribute("data-agent-edit-input"), setting: focused.dataset.agentSetting, action: focused.dataset.analysisAction, start: focused.selectionStart, end: focused.selectionEnd };
      container.querySelectorAll("[data-agent-conversation]").forEach(node => {
        scrollPositions.set(node.dataset.agentConversation, { top: node.scrollTop, atEnd: node.scrollHeight - node.clientHeight - node.scrollTop < 32 });
      });
      container.replaceChildren(...chats.map(createAgentChatCard));
      if (!chats.length) container.append(element("p", "agent-work-empty", t("agentNoTasks")));
      for (const id of streamHosts.keys()) if (!chats.some(chat => chat.id === id)) { streamHosts.delete(id); conversations.delete(id); scrollPositions.delete(id); }
      container.querySelectorAll("[data-agent-conversation]").forEach(node => {
        const position = scrollPositions.get(node.dataset.agentConversation);
        node.scrollTop = !position || position.atEnd ? node.scrollHeight : position.top;
      });
      if (focusKey) {
        const node = [...container.querySelectorAll("[data-panel-id]")].find(node => node.dataset.panelId === focusKey.panelId && (focusKey.instruction ? node.hasAttribute("data-analysis-instruction") : focusKey.editing ? node.hasAttribute("data-agent-edit-input") : focusKey.setting ? node.dataset.agentSetting === focusKey.setting : focusKey.action && node.dataset.analysisAction === focusKey.action));
        node?.focus({ preventScroll: true });
        if (focusKey.instruction || focusKey.editing) node?.setSelectionRange(focusKey.start, focusKey.end);
      }
    }
    return { render, getStreamHost: id => streamHosts.get(id), getConversation: id => conversations.get(id) };
  }

  root.BioDesignAgentWork = { hydrate, beginTurn, finishTurn, serialize, createAgentWorkArea, decorateMessage, createTurnClock };
})(window);
