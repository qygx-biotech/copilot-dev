"use strict";
// Agent Work's canonical transcript per conversation (docs/agent-transcripts.js).
const test = require("node:test");
const assert = require("node:assert/strict");
const { AgentTranscripts } = require("../../docs/agent-transcripts.js");

function workspace(files = {}) {
  const store = new Map(Object.entries(files).map(([path, value]) => [path, typeof value === "string" ? value : JSON.stringify(value)]));
  const missing = () => Object.assign(new Error("missing"), { code: "FILE_NOT_FOUND" });
  return { store,
    async ensureDirectory() {},
    async readJson(path) { if (!store.has(path)) throw missing(); return JSON.parse(store.get(path)); },
    async writeJson(path, value) { store.set(path, JSON.stringify(value)); },
    async fileExists(path) { return store.has(path); },
    async removeFile(path) { if (!store.delete(path)) throw Object.assign(new Error("Could not remove"), { code: "DELETE_FAILED" }); } };
}
const PATH = ".biodesign/chat/agents/panel-1/agent-transcript.json";
const user = (id, content, extra = {}) => ({ id, role: "user", content, createdAt: `2026-10-08T0${id.length}:00:00Z`, ...extra });
const reply = (id, content) => ({ id: `${id}-reply`, turnId: id, role: "assistant", content });
const call = (id, name, args) => ({ id, type: "function", function: { name, arguments: JSON.stringify(args) } });
// A completed turn as the agent loop checkpoints it: the request, a tool step and the answer.
const loopTurn = (turnId, sequence = 3) => ({ turnId, model: "fixture", workspaceId: "project-1", status: "completed", startedAt: "2026-10-08T03:00:00Z", sequence, bindings: [],
  messages: [{ role: "user", content: "Compare titres across runs." }, { role: "assistant", content: null, tool_calls: [call("read-1", "read_workspace_item", { item_id: "runs.csv" })] },
    { role: "tool", tool_call_id: "read-1", name: "read_workspace_item", content: '{"text":"run A 4.2 g/L; run B 5.1 g/L"}' }, { role: "assistant", content: "Run B is higher (5.1 g/L)." }] });

test("a conversation without a transcript starts from its visible messages, as text only", async () => {
  const ws = workspace(), transcripts = new AgentTranscripts({ workspace: ws });
  const transcript = await transcripts.prepare("panel-1", { messages: [user("u1", "Summarise the assay."), reply("u1", "The assay uses triplicates.")] });
  assert.deepEqual(transcript.turns.map(turn => [turn.turnId, turn.legacy, turn.messages.map(message => message.role)]), [["u1", true, ["user", "assistant"]]]);
  assert.equal(transcript.turns[0].messages[1].content, "The assay uses triplicates.", "Full text, not an excerpt");
  assert.ok(!transcript.turns[0].messages.some(message => message.tool_calls), "Tool history is never invented");
  assert.deepEqual(JSON.parse(ws.store.get(PATH)), { version: 1, transcript });
});

test("loop checkpoints are saved in order, and the next turn replays them with their tool calls and results", async () => {
  const ws = workspace(), transcripts = new AgentTranscripts({ workspace: ws });
  await transcripts.prepare("panel-1", { messages: [user("u1", "Summarise the assay."), reply("u1", "Triplicates.")] });
  // Checkpoints stream during a turn; they are written one at a time.
  await Promise.all([transcripts.saveTurn("panel-1", { ...loopTurn("u2", 1), status: "running", messages: loopTurn("u2").messages.slice(0, 1) }), transcripts.saveTurn("panel-1", loopTurn("u2", 3))]);
  const next = await transcripts.prepare("panel-1", { messages: [user("u1", "Summarise the assay."), reply("u1", "Triplicates."), user("u2", "Compare titres across runs."), reply("u2", "Run B is higher (5.1 g/L).")] });
  assert.deepEqual(next.turns.map(turn => turn.turnId), ["u1", "u2"], "The stored turn is not duplicated from its visible messages");
  const [, compared] = next.turns;
  assert.equal(compared.legacy, false); assert.equal(compared.sequence, 3);
  assert.deepEqual(compared.messages.map(message => message.role), ["user", "assistant", "tool", "assistant"]);
  assert.match(compared.messages[2].content, /5\.1 g\/L/);
});

test("a revision discards the replaced turns; a fork keeps only the turns it keeps", async () => {
  const ws = workspace(), transcripts = new AgentTranscripts({ workspace: ws });
  await transcripts.saveTurn("panel-1", loopTurn("u1"));
  await transcripts.saveTurn("panel-1", { ...loopTurn("u2"), startedAt: "2026-10-08T04:00:00Z" });
  const kept = [user("u1", "Compare titres across runs."), reply("u1", "Run B is higher (5.1 g/L).")];
  const revised = await transcripts.prepare("panel-1", { messages: kept, discardedTurnIds: ["u2"] });
  assert.deepEqual(revised.turns.map(turn => turn.turnId), ["u1"]); assert.ok(revised.discardedTurnIds.includes("u2"));
  await transcripts.saveTurn("panel-1", { ...loopTurn("u2", 9), startedAt: "2026-10-08T04:00:00Z" });
  assert.deepEqual((await transcripts.read("panel-1")).turns.map(turn => turn.turnId), ["u1"], "A late checkpoint of a discarded turn stays discarded");

  await transcripts.saveTurn("panel-1", { ...loopTurn("u3"), startedAt: "2026-10-08T05:00:00Z" });
  const fork = await transcripts.copy("panel-1", "panel-2", kept);
  assert.deepEqual(fork.turns.map(turn => turn.turnId), ["u1"]);
  assert.deepEqual((await transcripts.read("panel-2")).turns.map(turn => turn.turnId), ["u1"]);
  assert.equal(await transcripts.copy("panel-none", "panel-3", kept), null, "Nothing to copy from a conversation without a transcript");
});

test("a damaged transcript file is reported and kept; deleting a conversation removes its transcript", async () => {
  const ws = workspace({ [PATH]: { version: 1, transcript: { version: 7 } } }), transcripts = new AgentTranscripts({ workspace: ws });
  await assert.rejects(transcripts.prepare("panel-1", { messages: [] }), { code: "INVALID_AGENT_TRANSCRIPT" });
  await assert.rejects(transcripts.saveTurn("panel-1", loopTurn("u1")), { code: "INVALID_AGENT_TRANSCRIPT" });
  assert.deepEqual(JSON.parse(ws.store.get(PATH)), { version: 1, transcript: { version: 7 } }, "The file is not replaced");
  await transcripts.remove("panel-1");
  assert.ok(!ws.store.has(PATH));
  await transcripts.remove("panel-1");
  for (const id of ["../panel", "panel/1", ""]) assert.throws(() => transcripts.path(id), { code: "INVALID_AGENT_CONVERSATION" }, id);
});
