(function exposeProjectMemory(root, factory) {
  const api = factory(root);
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.BioDesignProjectMemory = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function projectMemoryFactory(root) {
  "use strict";

  // Memory across a project's conversations, after Codex (codex-rs/memories,
  // memories/write/templates/memories/). Off until enabled for the project.
  // Phase 1 turns each finished, idle conversation into a summary and raw
  // memory; phase 2 consolidates them into MEMORY.md and memory_summary.md
  // under .biodesign/memory/. New turns receive the summary and can search
  // MEMORY.md (conversation_memory_search / conversation_memory_read). Memories
  // are earlier conversation context, never evidence. Model calls go through
  // the authenticated FC model proxy; secrets are removed before storing.
  const redaction = root?.BioDesignRedactSecrets || (typeof require === "function" ? require("../shared/redact-secrets.js") : null);
  const DIRECTORY = ".biodesign/memory";
  const LIMITS = Object.freeze({ idleMs: 30 * 60 * 1000, maxAgeMs: 30 * 24 * 60 * 60 * 1000, perRun: 8, concurrency: 2, inputCharacters: 60000,
    rawMemoryCharacters: 8000, conversationSummaryCharacters: 6000, summaryCharacters: 6000, memoryCharacters: 40000, selected: 40,
    searchResults: 8, snippetCharacters: 1500, readCharacters: 20000, retryBaseMs: 60 * 60 * 1000, retryMaxMs: 24 * 60 * 60 * 1000 });

  const STAGE_ONE_PROMPT = `## Memory writing, phase 1: one conversation

You read one finished BioDesign conversation (a Side Chat or an Agent Work task in a scientific project) and decide whether it holds anything worth remembering for future conversations in the same project.

Rules:
- The conversation is immutable evidence of what happened; do not invent anything that is not in it.
- No-op is allowed and preferred when nothing reusable was learned. Return empty strings then.
- Never store secrets: keys, tokens, passwords. Write [REDACTED_SECRET] instead.
- Memories are earlier conversation context, not scientific evidence. When you record a scientific fact, say where it came from (paper title or file path as named in the conversation) so a future assistant can re-check the source.
- Remember what changes future behaviour: the user's stated preferences and corrections (keep their wording when it is short), project conventions (units, naming, strains, conditions, file layout), decisions and why they were made, what worked, what failed and what to do instead, and pointers to where things are (files under output/, papers, experiments).
- Do not remember one-off chit-chat, or content that only restates a paper.

Return JSON only:
{"conversation_summary": "...", "slug": "...", "raw_memory": "..."}

conversation_summary: Markdown starting with "# <one-sentence summary>", then "## Task <n>: <task>" sections with the outcome, key steps, sources consulted, and files produced. At most 6000 characters.
slug: 2–6 lowercase words joined by hyphens.
raw_memory: Markdown with "### Task <n>: <short task name>" sections, each with bullets for user preferences (quoted when short), reusable knowledge, and failures with what to do differently. At most 8000 characters. Empty when there is nothing reusable.`;

  const CONSOLIDATION_PROMPT = `## Memory writing, phase 2: consolidation

You maintain a scientific project's memory from the raw memories of its recent conversations. You receive the previous MEMORY.md and memory_summary.md (possibly empty), the current raw memories, and the conversation summary files they come from. Produce the new versions of both files.

Rules:
- Use only what the inputs support. Remove memories whose conversations are no longer among the inputs unless they also appear in a current raw memory.
- Never store secrets: write [REDACTED_SECRET] instead.
- Memories are earlier conversation context, not scientific evidence; keep the source of each scientific fact.
- Prefer concrete, reusable, future-facing guidance over narrative.

MEMORY.md is the searchable handbook. Group memories by project topic or workflow:

# Task Group: <topic or workflow>
scope: <what this covers and when to use it>

## Task 1: <task, outcome>
### conversation_summaries
- conversation_summaries/<file>.md (updated <date>)
### keywords
- <comma-separated retrieval terms: methods, organisms, compounds, file names, error messages>

(more tasks)

## User preferences
- when <situation>, the user asked: "<short quote>" -> <guidance> [Task 1]
## Reusable knowledge
- <conventions, procedures, decisions with reasons, with sources> [Task 1]
## Failures and how to do differently
- <symptom -> cause -> what to do instead> [Task 1]

Put the most useful and freshest groups first. No bold text. At most 40000 characters.

memory_summary.md is loaded into every new conversation, so keep it dense: at most 6000 characters. It must start with the exact line "v1", then:

## User Profile
(who the user is and what they work on; only what is known)
## User preferences
(the sharpest recurring preferences, as bullets)
## General Tips
(project-wide conventions and gotchas, as bullets)
## What's in Memory
(one bullet per Task Group in MEMORY.md with its main keywords)

Return JSON only: {"memory_md": "...", "memory_summary": "..."}`;

  const fail = (code, message = code) => Object.assign(new Error(message), { code });
  const safeKey = key => key.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 120);
  const hash = text => { let value = 2166136261; for (let i = 0; i < text.length; i++) value = Math.imul(value ^ text.charCodeAt(i), 16777619) >>> 0; return value.toString(16).padStart(8, "0"); };
  const redact = text => redaction ? redaction.redactSecrets(text) : text;
  function parseJson(content) {
    const text = String(content || "").trim().replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "");
    const start = text.indexOf("{"), end = text.lastIndexOf("}");
    if (start < 0 || end < start) throw fail("MEMORY_OUTPUT_INVALID");
    try { return JSON.parse(text.slice(start, end + 1)); } catch { throw fail("MEMORY_OUTPUT_INVALID"); }
  }
  const bounded = (value, limit) => typeof value === "string" ? redact(value.trim()).slice(0, limit) : "";

  class ProjectMemory {
    // workspace: the workspace manager. modelTurn({ stage, messages, ... }) returns the reply text.
    constructor({ workspace, modelTurn, now = () => new Date(), limits = {} }) {
      this.workspace = workspace; this.modelTurn = modelTurn; this.now = now; this.limits = { ...LIMITS, ...limits };
      this.running = null;
    }
    path(name) { return `${DIRECTORY}/${name}`; }
    async readJson(name, fallback = null) { try { return await this.workspace.readJson(this.path(name)); } catch { return fallback; } }
    async readText(name) { try { return await (await this.workspace.readFile(this.path(name))).text(); } catch { return ""; } }
    async write(name, data) { await this.workspace.ensureDirectory(DIRECTORY); return typeof data === "string" ? this.workspace.writeFile(this.path(name), data) : this.workspace.writeJson(this.path(name), data); }
    async list(name) { try { return await this.workspace.listFiles(this.path(name)); } catch { return []; } }
    // Every memory operation belongs to the project that was open when it started.
    guard() {
      const reference = this.workspace.workspace;
      return () => { if (this.workspace.workspace !== reference) throw fail("OPERATION_ABORTED", "The project changed."); };
    }

    async enabled() { return (await this.readJson("settings.json", {}))?.enabled === true; }
    async setEnabled(enabled) { await this.write("settings.json", { version: 1, enabled: enabled === true, updatedAt: this.now().toISOString() }); return { enabled: enabled === true }; }

    async status() {
      const [enabled, state, stage1] = await Promise.all([this.enabled(), this.readJson("state.json", {}), this.list("stage1")]);
      const memory = await this.readText("MEMORY.md");
      return { enabled, running: Boolean(this.running), lastRunAt: state?.lastRunAt || null, lastError: state?.lastError || null,
        conversationsProcessed: stage1.length, hasMemory: Boolean(memory.trim()), memoryUpdatedAt: state?.memoryUpdatedAt || null };
    }

    // Finished conversations of this project: Side Chats and Agent Work tasks.
    async conversations() {
      const conversations = [];
      for (const file of await this.workspace.listFiles(".biodesign/chat", { recursive: true }).catch(() => [])) {
        if (!/(^|\/)conversations\/[A-Za-z0-9_-]+\.json$/.test(file.relativePath)) continue;
        const value = await this.workspace.readJson(file.relativePath).catch(() => null);
        if (value?.id && Array.isArray(value.messages)) conversations.push({ key: `side:${file.relativePath.replace(/^\.biodesign\/chat\//, "").replace(/\.json$/, "")}`,
          surface: "side_chat", title: value.title || "", updatedAt: value.updatedAt || "", messages: value.messages });
      }
      for (const panel of this.workspace.state?.agent?.workbench?.panels || []) {
        if (panel?.id && Array.isArray(panel.messages) && panel.taskStatus !== "running") conversations.push({ key: `agent:${panel.id}`, surface: "agent_command",
          title: panel.title || "", updatedAt: panel.updatedAt || "", messages: panel.messages });
      }
      return conversations;
    }

    eligible(conversation, record) {
      const updated = Date.parse(conversation.updatedAt), now = this.now().getTime();
      const roles = new Set(conversation.messages.map(message => message.role));
      if (!Number.isFinite(updated) || now - updated < this.limits.idleMs || now - updated > this.limits.maxAgeMs || !roles.has("user") || !roles.has("assistant")) return false;
      if (record?.sourceUpdatedAt === conversation.updatedAt && record.status !== "failed") return false;
      return !(record?.status === "failed" && Date.parse(record.nextRetryAt) > now);
    }

    // The conversation as the extraction model reads it: user and assistant
    // text only, newest kept when it is too long.
    input(conversation) {
      const lines = conversation.messages.filter(message => ["user", "assistant"].includes(message.role) && typeof message.content === "string" && message.content.trim())
        .map(message => `### ${message.role === "user" ? "User" : "Assistant"}${message.createdAt ? ` (${message.createdAt})` : ""}\n${message.content.trim()}`);
      let text = lines.join("\n\n");
      if (text.length > this.limits.inputCharacters) text = `(earlier messages omitted)\n\n${text.slice(-this.limits.inputCharacters)}`;
      return `Conversation: ${conversation.surface === "agent_command" ? "Agent Work task" : "Side Chat"} "${conversation.title}", last updated ${conversation.updatedAt}.\n\n${redact(text)}`;
    }

    async extract(conversation, previous, check) {
      const recordName = `stage1/${safeKey(conversation.key)}.json`;
      try {
        const reply = await this.modelTurn({ stage: "memory-extraction", temperature: 0, max_tokens: 4000, response_format: { type: "json_object" },
          messages: [{ role: "system", content: STAGE_ONE_PROMPT }, { role: "user", content: this.input(conversation) }] });
        check();
        const output = parseJson(reply);
        const rawMemory = bounded(output.raw_memory, this.limits.rawMemoryCharacters);
        const record = { version: 1, key: conversation.key, surface: conversation.surface, title: conversation.title, sourceUpdatedAt: conversation.updatedAt,
          generatedAt: this.now().toISOString(), status: rawMemory ? "succeeded" : "succeeded_no_output",
          conversationSummary: bounded(output.conversation_summary, this.limits.conversationSummaryCharacters),
          slug: (typeof output.slug === "string" ? output.slug : "").toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "conversation", rawMemory };
        await this.write(recordName, record);
        return record;
      } catch (error) {
        if (error.code === "OPERATION_ABORTED" || error.code === "AUTH_REQUIRED") throw error;
        const attempts = (previous?.status === "failed" ? previous.attempts || 1 : 0) + 1;
        const delay = Math.min(this.limits.retryMaxMs, this.limits.retryBaseMs * 2 ** (attempts - 1));
        await this.write(recordName, { version: 1, key: conversation.key, sourceUpdatedAt: conversation.updatedAt, status: "failed", error: error.code || "MEMORY_EXTRACTION_FAILED",
          attempts, nextRetryAt: new Date(this.now().getTime() + delay).toISOString() });
        return null;
      }
    }

    async phaseOne(check) {
      const records = new Map();
      for (const file of await this.list("stage1")) {
        const record = await this.workspace.readJson(file.relativePath).catch(() => null);
        if (record?.key) records.set(record.key, record);
      }
      const pending = (await this.conversations()).filter(conversation => this.eligible(conversation, records.get(conversation.key)))
        .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt))).slice(0, this.limits.perRun);
      check();
      let processed = 0;
      const workers = Array.from({ length: Math.min(this.limits.concurrency, pending.length) }, async () => {
        while (pending.length) {
          const conversation = pending.shift();
          if (await this.extract(conversation, records.get(conversation.key), check)) processed++;
        }
      });
      await Promise.all(workers);
      return processed;
    }

    async phaseTwo(check) {
      const records = [];
      for (const file of await this.list("stage1")) {
        const record = await this.workspace.readJson(file.relativePath).catch(() => null);
        if (record?.status === "succeeded" && record.rawMemory) records.push(record);
      }
      const selected = records.sort((a, b) => String(b.generatedAt).localeCompare(String(a.generatedAt))).slice(0, this.limits.selected)
        .sort((a, b) => a.key.localeCompare(b.key));
      const fingerprint = hash(JSON.stringify(selected.map(record => [record.key, record.sourceUpdatedAt, record.generatedAt])));
      const previousState = await this.readJson("state.json", {});
      if (!selected.length || (previousState?.fingerprint === fingerprint && (await this.readText("MEMORY.md")).trim())) return false;
      // Summary files mirror the selection; stale ones are removed.
      const names = new Map(selected.map(record => [record.key, `${record.slug}-${hash(record.key)}.md`]));
      for (const file of await this.list("conversation_summaries")) if (![...names.values()].includes(file.name)) await this.workspace.removeFile(file.relativePath).catch(() => {});
      for (const record of selected) await this.write(`conversation_summaries/${names.get(record.key)}`, `${record.conversationSummary || `# ${record.title}`}\n`);
      const raw = selected.map(record => `## conversation_summaries/${names.get(record.key)} (${record.surface}, updated ${record.sourceUpdatedAt})\n\n${record.rawMemory}`).join("\n\n");
      await this.write("raw_memories.md", `# Raw memories\n\n${raw}\n`);
      check();
      const reply = await this.modelTurn({ stage: "memory-consolidation", temperature: 0, max_tokens: 16000, response_format: { type: "json_object" },
        messages: [{ role: "system", content: CONSOLIDATION_PROMPT }, { role: "user", content: [
          `# Previous MEMORY.md\n\n${(await this.readText("MEMORY.md")).slice(0, this.limits.memoryCharacters) || "(empty)"}`,
          `# Previous memory_summary.md\n\n${(await this.readText("memory_summary.md")).slice(0, this.limits.summaryCharacters) || "(empty)"}`,
          `# Current raw memories\n\n${raw}`].join("\n\n") }] });
      check();
      const output = parseJson(reply);
      const memory = bounded(output.memory_md, this.limits.memoryCharacters), summary = bounded(output.memory_summary, this.limits.summaryCharacters);
      if (!memory || !/^v1\s*\n/.test(summary)) throw fail("MEMORY_OUTPUT_INVALID");
      await this.write("MEMORY.md", `${memory}\n`);
      await this.write("memory_summary.md", `${summary}\n`);
      await this.write("state.json", { ...previousState, fingerprint, memoryUpdatedAt: this.now().toISOString() });
      return true;
    }

    // One run at a time, in the background; a no-op unless enabled.
    run() {
      return this.running ||= (async () => {
        const check = this.guard();
        if (!(await this.enabled())) return { skipped: "disabled" };
        let result = { processed: 0, consolidated: false }, lastError = null;
        try {
          result.processed = await this.phaseOne(check);
          result.consolidated = await this.phaseTwo(check);
        } catch (error) { lastError = error.code || "MEMORY_RUN_FAILED"; if (error.code === "OPERATION_ABORTED") throw error; }
        check();
        const state = await this.readJson("state.json", {});
        await this.write("state.json", { ...state, lastRunAt: this.now().toISOString(), lastError });
        return { ...result, ...(lastError ? { error: lastError } : {}) };
      })().finally(() => { this.running = null; });
    }

    // The read path: the summary for new turns, search and read for tools.
    async summary() {
      if (!(await this.enabled())) return "";
      return (await this.readText("memory_summary.md")).trim().slice(0, this.limits.summaryCharacters);
    }
    async search(query) {
      if (!(await this.enabled())) throw fail("MEMORY_DISABLED", "Memory is off for this project.");
      const terms = String(query || "").toLowerCase().split(/[^\p{L}\p{N}_.-]+/u).filter(term => term.length > 1).slice(0, 12);
      if (!terms.length) throw fail("INVALID_MEMORY_QUERY", "Give search terms.");
      const blocks = [];
      const memory = await this.readText("MEMORY.md");
      for (const block of memory.split(/\n(?=# Task Group:)/)) if (block.trim()) blocks.push({ path: "MEMORY.md", text: block.trim() });
      for (const file of await this.list("conversation_summaries")) blocks.push({ path: `conversation_summaries/${file.name}`, text: await this.readText(`conversation_summaries/${file.name}`) });
      const scored = blocks.map(block => ({ ...block, score: terms.reduce((sum, term) => sum + (block.text.toLowerCase().split(term).length - 1), 0) }))
        .filter(block => block.score > 0).sort((a, b) => b.score - a.score).slice(0, this.limits.searchResults);
      return { results: scored.map(block => ({ path: block.path, heading: block.text.split("\n")[0].slice(0, 200), snippet: block.text.slice(0, this.limits.snippetCharacters), score: block.score })),
        note: "Memories are earlier conversation context, not evidence. Re-check facts against their sources." };
    }
    async read(name) {
      if (!(await this.enabled())) throw fail("MEMORY_DISABLED", "Memory is off for this project.");
      if (!["MEMORY.md", "memory_summary.md"].includes(name) && !/^conversation_summaries\/[a-z0-9-]+\.md$/.test(name)) throw fail("INVALID_MEMORY_PATH", "Read MEMORY.md, memory_summary.md or a conversation_summaries/ file.");
      const text = await this.readText(name);
      if (!text) throw fail("MEMORY_NOT_FOUND", "No such memory file.");
      return { path: name, content: text.slice(0, this.limits.readCharacters), truncated: text.length > this.limits.readCharacters };
    }
    async view() {
      return { status: await this.status(), summary: await this.readText("memory_summary.md"), memory: await this.readText("MEMORY.md") };
    }
    // Removes everything remembered; the on/off setting stays.
    async forget() {
      for (const file of await this.workspace.listFiles(DIRECTORY, { recursive: true }).catch(() => [])) {
        if (file.relativePath !== this.path("settings.json")) await this.workspace.removeFile(file.relativePath);
      }
      return { forgotten: true };
    }
  }

  return Object.freeze({ ProjectMemory, LIMITS, DIRECTORY, STAGE_ONE_PROMPT, CONSOLIDATION_PROMPT });
});
