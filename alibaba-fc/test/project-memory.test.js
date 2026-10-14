"use strict";
// Memory across a project's conversations (docs/project-memory.js), after
// Codex's two-phase pipeline: extraction per finished conversation, then
// consolidation into MEMORY.md and memory_summary.md.
const test = require("node:test");
const assert = require("node:assert/strict");
const { ProjectMemory } = require("../../docs/project-memory.js");

const HOUR = 60 * 60 * 1000;
const SECRET = ["sk", "abcdefghijklmnopqrstuvwx"].join("-");

// An in-memory workspace with the workspace manager's file API.
function workspace(files = {}, state = {}) {
  const store = new Map(Object.entries(files).map(([path, value]) => [path, typeof value === "string" ? value : JSON.stringify(value)]));
  const api = {
    workspace: { workspaceId: "project-1" }, state, store,
    async ensureDirectory() {},
    async readJson(path) { if (!store.has(path)) throw Object.assign(new Error("missing"), { code: "NOT_FOUND" }); return JSON.parse(store.get(path)); },
    async readFile(path) { if (!store.has(path)) throw Object.assign(new Error("missing"), { code: "NOT_FOUND" }); const text = store.get(path); return { text: async () => text }; },
    async writeJson(path, value) { store.set(path, JSON.stringify(value)); },
    async writeFile(path, value) { store.set(path, String(value)); },
    async removeFile(path) { store.delete(path); },
    async listFiles(directory, { recursive = false } = {}) {
      const prefix = `${directory}/`;
      return [...store.keys()].filter(path => path.startsWith(prefix) && (recursive || !path.slice(prefix.length).includes("/")))
        .map(relativePath => ({ relativePath, name: relativePath.split("/").at(-1) }));
    },
  };
  return api;
}
function clock(start = "2026-10-07T12:00:00Z") { let now = Date.parse(start); return { now: () => new Date(now), advance: ms => { now += ms; } }; }
const ago = (time, ms) => new Date(time.now().getTime() - ms).toISOString();
const conversation = (id, updatedAt, messages) => ({ id, title: `Chat ${id}`, updatedAt, messages });
const exchange = (question, answer) => [{ role: "user", content: question, createdAt: "2026-10-07T09:00:00Z" }, { role: "assistant", content: answer }];
const consolidated = { memory_md: "# Task Group: Fermentation analysis\nscope: titre comparisons\n\n## Task 1: Compare titres\n### keywords\n- titre, pH", memory_summary: "v1\n\n## User Profile\n- Works on fermentation.\n## User preferences\n- Report titres in g/L." };

// A scripted model: extraction replies by conversation title, then consolidation.
function model(replies) {
  const calls = [];
  const modelTurn = async request => {
    calls.push(request);
    if (request.stage === "memory-consolidation") return JSON.stringify(replies.consolidation || consolidated);
    const title = /"(Chat [^"]+)"/.exec(request.messages[1].content)[1];
    const reply = replies[title];
    if (reply instanceof Error) throw reply;
    return typeof reply === "string" ? reply : JSON.stringify(reply);
  };
  return { modelTurn, calls };
}

async function memoryFixture(t, { replies = {}, files = {} } = {}) {
  const time = clock();
  const ws = workspace({
    ".biodesign/memory/settings.json": { version: 1, enabled: true },
    ".biodesign/chat/conversations/side1.json": conversation("side1", ago(time, 2 * HOUR), exchange("Plot titre against pH, in g/L please.", "Saved output/titre.png (g/L).")),
    ".biodesign/chat/conversations/fresh.json": conversation("fresh", ago(time, 5 * 60 * 1000), exchange("Still talking", "Yes")),
    ".biodesign/chat/conversations/old.json": conversation("old", ago(time, 40 * 24 * HOUR), exchange("Long ago", "Yes")),
    ".biodesign/chat/conversations/unanswered.json": conversation("unanswered", ago(time, 2 * HOUR), [{ role: "user", content: "Hello?" }]),
    ".biodesign/chat/agents/panel1/conversations/inner.json": conversation("inner", ago(time, 3 * HOUR), exchange("Which strain?", "Strain A.")),
    ...files,
  }, { agent: { workbench: { panels: [{ id: "agent1", title: "Chat agent1", updatedAt: ago(time, 4 * HOUR), taskStatus: "completed", messages: exchange("Design the assay.", "Use triplicates.") },
    { id: "running", title: "Chat running", updatedAt: ago(time, 4 * HOUR), taskStatus: "running", messages: exchange("Busy", "Working") }] } } });
  const scripted = model({
    "Chat side1": { conversation_summary: "# Plotted titre against pH\n## Task 1: Plot\nSaved output/titre.png.", slug: "Titre Plot!", raw_memory: `### Task 1: Plot\n- the user asked: "in g/L please" -> report titres in g/L\n- api_key=${SECRET}` },
    "Chat inner": { conversation_summary: "", slug: "", raw_memory: "" },
    "Chat agent1": { conversation_summary: "# Assay design", slug: "assay-design", raw_memory: "### Task 1: Assay\n- Use triplicates (decided in Agent Work)." },
    ...replies,
  });
  return { time, ws, ...scripted, memory: new ProjectMemory({ workspace: ws, modelTurn: scripted.modelTurn, now: time.now }) };
}
const record = (ws, key) => JSON.parse(ws.store.get(`.biodesign/memory/stage1/${key}.json`));

test("memory is off until enabled: nothing runs, nothing is offered", async t => {
  const { memory, ws, calls } = await memoryFixture(t);
  await memory.setEnabled(false);
  assert.deepEqual(await memory.run(), { skipped: "disabled" });
  assert.equal(calls.length, 0);
  assert.equal(await memory.summary(), "");
  await assert.rejects(memory.search("titre"), { code: "MEMORY_DISABLED" });
  assert.deepEqual(JSON.parse(ws.store.get(".biodesign/memory/settings.json")).enabled, false);
});

test("finished, idle conversations are extracted once, redacted, then consolidated", async t => {
  const { memory, ws, calls, time } = await memoryFixture(t);
  assert.deepEqual(await memory.run(), { processed: 3, consolidated: true });
  assert.deepEqual(calls.filter(call => call.stage === "memory-extraction").map(call => /"(Chat [^"]+)"/.exec(call.messages[1].content)[1]).sort(),
    ["Chat agent1", "Chat inner", "Chat side1"], "Fresh, old, unanswered and running conversations wait");
  const side = record(ws, "side_conversations_side1");
  assert.equal(side.status, "succeeded"); assert.equal(side.slug, "titre-plot");
  assert.match(side.rawMemory, /api_key=\[REDACTED_SECRET\]/); assert.ok(!side.rawMemory.includes(SECRET));
  assert.equal(record(ws, "side_agents_panel1_conversations_inner").status, "succeeded_no_output", "No-op is allowed");
  const consolidation = calls.find(call => call.stage === "memory-consolidation");
  assert.match(consolidation.messages[1].content, /# Current raw memories[\s\S]*conversation_summaries\/titre-plot-[0-9a-f]{8}\.md/);
  assert.ok(!consolidation.messages[1].content.includes("Chat inner"), "Empty memories are not consolidated");
  assert.equal(ws.store.get(".biodesign/memory/memory_summary.md"), `${consolidated.memory_summary}\n`);
  assert.equal(ws.store.get(".biodesign/memory/MEMORY.md"), `${consolidated.memory_md}\n`);
  assert.equal([...ws.store.keys()].filter(path => path.startsWith(".biodesign/memory/conversation_summaries/")).length, 2);
  assert.equal(await memory.summary(), consolidated.memory_summary);

  // Nothing changed: no model call. A conversation updated later is read again.
  const before = calls.length;
  assert.deepEqual(await memory.run(), { processed: 0, consolidated: false });
  assert.equal(calls.length, before);
  const file = ".biodesign/chat/conversations/side1.json", updated = JSON.parse(ws.store.get(file));
  updated.updatedAt = ago(time, 2 * HOUR - 1000); updated.messages.push(...exchange("And the yield?", "38%"));
  ws.store.set(file, JSON.stringify(updated));
  assert.deepEqual(await memory.run(), { processed: 1, consolidated: true });
});

test("a failed extraction waits for its backoff; invalid consolidation leaves memory unchanged", async t => {
  const { memory, ws, calls, time } = await memoryFixture(t, { replies: { "Chat side1": "not json" }, files: {
    ".biodesign/memory/MEMORY.md": "previous memory\n", ".biodesign/memory/memory_summary.md": "v1\nprevious\n" } });
  const failing = model({ "Chat side1": "not json", "Chat inner": { raw_memory: "" }, "Chat agent1": { conversation_summary: "# Assay", slug: "assay", raw_memory: "- triplicates" },
    consolidation: { memory_md: "new", memory_summary: "no version line" } });
  memory.modelTurn = failing.modelTurn;
  const result = await memory.run();
  assert.equal(result.error, "MEMORY_OUTPUT_INVALID");
  assert.equal(ws.store.get(".biodesign/memory/MEMORY.md"), "previous memory\n", "Existing memory is kept");
  const failed = record(ws, "side_conversations_side1");
  assert.deepEqual([failed.status, failed.error, failed.attempts], ["failed", "MEMORY_OUTPUT_INVALID", 1]);
  assert.equal((await memory.status()).lastError, "MEMORY_OUTPUT_INVALID");
  // Only the failed conversation's retries (after an hour, the fresh one becomes idle too).
  const extractions = () => failing.calls.filter(call => call.stage === "memory-extraction" && call.messages[1].content.includes('"Chat side1"')).length;
  const count = extractions();
  await memory.run();
  assert.equal(extractions(), count, "Not retried before its backoff");
  time.advance(HOUR + 1000);
  await memory.run();
  assert.equal(extractions(), count + 1, "Retried after its backoff");
  assert.equal(record(ws, "side_conversations_side1").attempts, 2);
  void calls;
});

test("search and read stay inside the memory folder and say memories are not evidence", async t => {
  const { memory } = await memoryFixture(t);
  await memory.run();
  const found = await memory.search("titre pH");
  assert.equal(found.results[0].path, "MEMORY.md");
  assert.match(found.results[0].heading, /^# Task Group: Fermentation analysis/);
  assert.match(found.note, /not evidence/);
  const summaryFile = found.results.find(item => item.path.startsWith("conversation_summaries/"))?.path;
  assert.ok(summaryFile, JSON.stringify(found));
  assert.match((await memory.read(summaryFile)).content, /Plotted titre/);
  for (const path of ["../state.json", ".biodesign/memory/MEMORY.md", "conversation_summaries/../../x.md", "raw_memories.md"])
    await assert.rejects(memory.read(path), { code: "INVALID_MEMORY_PATH" }, path);
  await assert.rejects(memory.search(" "), { code: "INVALID_MEMORY_QUERY" });
});

test("forgetting removes everything remembered but keeps the setting", async t => {
  const { memory, ws } = await memoryFixture(t);
  await memory.run();
  await memory.forget();
  assert.deepEqual([...ws.store.keys()].filter(path => path.startsWith(".biodesign/memory/")), [".biodesign/memory/settings.json"]);
  assert.equal(await memory.summary(), "");
  assert.equal((await memory.status()).enabled, true);
});

test("a run stops when the project changes and writes nothing afterwards", async t => {
  const { memory, ws } = await memoryFixture(t);
  memory.modelTurn = async () => { ws.workspace = { workspaceId: "project-2" }; return JSON.stringify({ conversation_summary: "x", slug: "x", raw_memory: "y" }); };
  await assert.rejects(memory.run(), { code: "OPERATION_ABORTED" });
  assert.equal([...ws.store.keys()].filter(path => path.startsWith(".biodesign/memory/stage1/")).length, 0);
});
