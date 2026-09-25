import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, readFile, writeFile, readdir, access, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import contextApi from "../../docs/project-context-service.js";
import transcriptApi from "../../shared/conversation-transcript.js";

const { WorkspaceChatStore, ProjectContextService } = contextApi;
const directory = ".biodesign/chat/conversations";
const indexPath = ".biodesign/chat/index.json";
const png = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAFgwJ/lzY4WQAAAABJRU5ErkJggg==";

test("tool transcript checkpoints survive restart and stale visible saves, without changing visible messages or another active chat", async t => {
  const { workspace, store } = await fixture(t);
  const chat = await turn(store, await store.startNewConversation(), "SurfDock有代码么？");
  const user = chat.messages[0];
  const checkpoint = { turnId: user.id, workspaceId: workspace.workspace.workspaceId, model: "google/gemma-4-31b-it", sequence: 2, status: "running",
    bindings: [{ handle: "turn_one:local:paper", identity: "source:paper", sourceId: "paper", version: "sha256-v1", current: true }],
    messages: [{ role: "user", content: user.content }, { role: "assistant", content: null,
      tool_calls: [{ id: "read-1", type: "function", function: { name: "read_paper_evidence", arguments: '{"paper_id":"paper"}' } }] },
      { role: "tool", tool_call_id: "read-1", content: "[paper:p17:chunk-1] English source code evidence" }] };
  await store.saveTranscriptTurn(chat.id, checkpoint);
  await store.saveConversation(chat); // An autosave captured before the stream checkpoint.
  let reopened = await new WorkspaceChatStore({ workspace }).loadActiveConversation();
  assert.deepEqual(reopened.messages, chat.messages);
  assert.equal(reopened.transcript.turns[0].messages[1].tool_calls[0].id, "read-1");
  assert.equal(reopened.transcript.turns[0].messages[2].tool_call_id, "read-1");
  const other = await store.startNewConversation();
  await store.saveTranscriptTurn(chat.id, { ...checkpoint, sequence: 3, status: "interrupted" });
  assert.equal((await store.loadActiveConversation()).id, other.id, "background checkpoint does not navigate back");
  await store.saveTranscriptTurn(chat.id, { ...checkpoint, sequence: 1 });
  reopened = await store.activateConversation(chat.id);
  assert.equal(reopened.transcript.turns[0].status, "interrupted", "older duplicate checkpoints cannot replace newer state");
  const forked = await store.forkConversation(chat.id);
  assert.deepEqual(forked.transcript, reopened.transcript);
});

test("editing a user turn removes its transcript permanently, including late checkpoints and old autosaves", async t => {
  const { store } = await fixture(t);
  const chat = await turn(store, await store.startNewConversation(), "Old question");
  chat.transcript = transcriptApi.forConversation(chat);
  await store.saveConversation(chat);
  const oldId = chat.messages[0].id;
  const revised = await store.saveConversation({ ...chat,
    transcript: transcriptApi.beforeRevision(chat.transcript, [oldId]),
    messages: [{ ...chat.messages[0], id: "new-user", content: "Corrected question" }] });
  await store.saveTranscriptTurn(chat.id, { ...chat.transcript.turns[0], sequence: 100 });
  assert.ok(!(await store.loadActiveConversation()).transcript.turns.some(turn => turn.turnId === oldId));
  const merged = transcriptApi.merge(revised.transcript, chat.transcript);
  assert.ok(!merged.turns.some(turn => turn.turnId === oldId));
  assert.ok(merged.discardedTurnIds.includes(oldId));
});

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "biodesign-chat-history-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  let sequence = 0;
  const workspace = {
    workspace: { workspaceId: randomUUID() }, state: {}, createId: randomUUID,
    ensureDirectory: relative => mkdir(path.join(root, relative), { recursive: true }),
    fileExists: relative => access(path.join(root, relative)).then(() => true, () => false),
    readJson: async relative => JSON.parse(await readFile(path.join(root, relative), "utf8")),
    writeJson: async (relative, value) => {
      await mkdir(path.dirname(path.join(root, relative)), { recursive: true });
      await writeFile(path.join(root, relative), JSON.stringify(value));
    },
    removeFile: relative => rm(path.join(root, relative)),
    listFiles: async relative => (await readdir(path.join(root, relative))).map(name => ({ name, relativePath: `${relative}/${name}` })),
  };
  const store = new WorkspaceChatStore({ workspace, now: () => new Date(Date.UTC(2026, 8, 8) + sequence++ * 1000) });
  const files = () => readdir(path.join(root, directory));
  return { workspace, store, files };
}

async function turn(store, conversation, content, extra = {}) {
  return store.saveConversation({ ...conversation, messages: [...conversation.messages,
    { id: randomUUID(), role: "user", content, createdAt: "2026-09-08T00:00:00.000Z", ...extra },
    { id: randomUUID(), role: "assistant", content: `Answer: ${content}`, createdAt: "2026-09-08T00:00:01.000Z" },
  ] });
}

test("New Chat retains five actual conversation files and removes only evicted, unshared chat attachments", async t => {
  const { workspace, store, files } = await fixture(t);
  await workspace.writeJson("literature/keep.json", { evidence: "untouched" });
  await workspace.writeJson(".biodesign/literature/summaries/keep.json", { card: "untouched" });
  const images = await store.saveImageAttachments([0, 1].map(i => ({ name: `image-${i}.png`, dataUrl: png, thumbnail: png })));
  const chats = [];
  for (let i = 0; i < 6; i++) {
    const chat = await store.startNewConversation();
    const extra = i === 0 ? { images } : i === 1 ? { images: [images[1]] } : {};
    chats.push(await turn(store, chat, `Question ${i}`, extra));
    assert.ok((await files()).length <= 5);
    assert.ok((await store.listConversations()).length <= 5);
  }
  assert.deepEqual((await store.listConversations()).map(record => record.id), chats.slice(1).reverse().map(chat => chat.id));
  assert.deepEqual((await files()).sort(), chats.slice(1).map(chat => `${chat.id}.json`).sort());
  assert.equal(await workspace.fileExists(`.biodesign/chat/attachments/${images[0].attachmentId}.json`), false);
  assert.equal(await workspace.fileExists(`.biodesign/chat/attachments/${images[1].attachmentId}.json`), true);
  assert.deepEqual(await workspace.readJson("literature/keep.json"), { evidence: "untouched" });
  assert.deepEqual(await workspace.readJson(".biodesign/literature/summaries/keep.json"), { card: "untouched" });
});

test("history resumes messages and image understanding after reopening, and continuing an old chat makes it recent", async t => {
  const { workspace, store, files } = await fixture(t);
  const images = await store.saveImageAttachments([{ name: "activity.png", dataUrl: png, thumbnail: png }]);
  const chats = [];
  for (let i = 0; i < 5; i++) chats.push(await turn(store, await store.startNewConversation(), `Question ${i}`, i === 0 ? {
    images, imageUnderstanding: { text: "Activity is 25 U/mL", model: "vision" },
    context: { type: "files", files: ["literature/paper.pdf"], selectedPaperIds: ["paper-1"] },
  } : {}));
  const selected = await store.activateConversation(chats[0].id);
  assert.deepEqual(selected.messages, chats[0].messages);
  const orderBeforeNavigation = await store.listConversations();
  const unchanged = await store.saveConversation(selected);
  assert.equal(unchanged.updatedAt, selected.updatedAt);
  await store.activateConversation(chats[2].id);
  await store.saveConversation(chats[2]);
  await store.activateConversation(selected.id);
  assert.deepEqual(await store.listConversations(), orderBeforeNavigation);
  const reopened = await new WorkspaceChatStore({ workspace }).loadActiveConversation();
  assert.equal(reopened.id, chats[0].id);
  assert.equal((await store.loadImageAttachments(reopened.messages[0].images))[0].dataUrl, png);
  // Restored history is unchanged; only a current catalog paper may become an
  // interpretation candidate. Saved selection metadata alone is not authority.
  const literature = { documents: [{ id: "paper-1", isLiteraturePaper: true, title: "Current paper" }] };
  const context = new ProjectContextService({ workspace, literature }).buildConversationContext(reopened);
  assert.deepEqual(context.recentlyDiscussedPaperIds, ["paper-1"]);
  assert.deepEqual(new ProjectContextService({ workspace }).buildConversationContext(reopened).recentlyDiscussedPaperIds, []);
  assert.match(context.recentMessages[0].content, /Activity is 25 U\/mL/);
  await turn(store, selected, "Follow-up on Question 0");
  assert.equal((await store.listConversations())[0].id, selected.id);
  const fresh = await store.startNewConversation();
  assert.equal((await files()).length, 5);
  assert.equal(await workspace.fileExists(`${directory}/${chats[1].id}.json`), false);
  assert.equal(await workspace.fileExists(`${directory}/${chats[0].id}.json`), true);
  assert.deepEqual(fresh.messages, []);
  assert.deepEqual(new ProjectContextService({ workspace }).buildConversationContext(fresh).recentMessages, []);
  assert.equal((await new WorkspaceChatStore({ workspace }).loadActiveConversation()).id, fresh.id);
});

test("opening an older workspace prunes oversized indexes and orphaned conversation files", async t => {
  const { workspace, store, files } = await fixture(t);
  const conversations = [];
  for (let i = 0; i < 8; i++) {
    const conversation = { ...store.createConversation(), title: `Legacy ${i}`, updatedAt: new Date(Date.UTC(2026, 8, 7, i)).toISOString() };
    await workspace.writeJson(`${directory}/${conversation.id}.json`, conversation);
    if (i < 7) conversations.unshift({ ...conversation, messages: undefined, messageCount: 0 });
  }
  await workspace.writeJson(indexPath, { schemaVersion: 1, activeConversationId: conversations.at(-1).id, conversations, updatedAt: store.timestamp() });
  const restored = await store.loadActiveConversation();
  assert.equal(restored.id, conversations[0].id);
  assert.equal((await files()).length, 5);
  assert.deepEqual((await store.listConversations()).map(record => record.id), conversations.slice(0, 5).map(record => record.id));
});

test("empty chats are reused and overlapping creation/saves cannot exceed five files", async t => {
  const { store, files } = await fixture(t);
  const first = await store.loadActiveConversation();
  await turn(store, first, "Existing conversation");
  const created = await Promise.all(Array.from({ length: 8 }, () => store.startNewConversation()));
  assert.equal(new Set(created.map(chat => chat.id)).size, 1);
  assert.equal((await files()).length, 2);
  await Promise.all(Array.from({ length: 8 }, (_, i) => turn(store, store.createConversation(), `Concurrent ${i}`)));
  assert.equal((await files()).length, 5);
  assert.equal((await store.listConversations()).length, 5);
});

test("an index write failure preserves current history and rolls back the new conversation file", async t => {
  const { workspace, store, files } = await fixture(t);
  const first = await turn(store, await store.loadActiveConversation(), "Keep this chat");
  const before = await workspace.readJson(indexPath);
  const write = workspace.writeJson;
  workspace.writeJson = async (relative, data) => {
    if (relative === indexPath && data.activeConversationId !== first.id) throw new Error("disk full");
    return write(relative, data);
  };
  await assert.rejects(store.startNewConversation(), /disk full/);
  assert.deepEqual(await workspace.readJson(indexPath), before);
  assert.deepEqual(await files(), [`${first.id}.json`]);
  workspace.writeJson = write;
  assert.equal((await store.loadActiveConversation()).id, first.id);
  assert.notEqual((await store.startNewConversation()).id, first.id);
});

test("unknown history IDs and workspace changes cannot select or write chats in another project", async t => {
  const { workspace, store } = await fixture(t);
  const chat = await turn(store, await store.loadActiveConversation(), "Keep this chat");
  await assert.rejects(store.activateConversation("../../notes"), /no longer available/);
  const before = await workspace.readJson(indexPath);
  const read = workspace.readJson;
  workspace.readJson = async relative => {
    const result = await read(relative);
    workspace.workspace.workspaceId = "different-project";
    return result;
  };
  await assert.rejects(store.activateConversation(chat.id), { code: "OPERATION_ABORTED" });
  assert.deepEqual(await read(indexPath), before);
});

test("a copied workspace with the same saved ID still invalidates operations from the previous workspace", async t => {
  const { workspace, store } = await fixture(t);
  const chat = await store.loadActiveConversation();
  workspace.workspace = { ...workspace.workspace };
  await assert.rejects(store.saveConversation(chat), { code: "OPERATION_ABORTED" });
});


test("Side Chat preserves provider web sources and raw citation locations across disk reload", async t => {
  const { store } = await fixture(t);
  const conversation = await store.createConversation();
  const sources = [{ url: "https://papers.example.org/ectd.pdf", title: "EctD" }, { url: "javascript:alert(1)" }];
  const metadata = [{ annotations: [{ type: "url_citation", url: sources[0].url, start_index: 1, end_index: 6 }] }];
  const saved = await store.saveConversation({ ...conversation, messages: [{ id: randomUUID(), role: "assistant", content: "Found a paper", webSearchSources: sources,
    webSearchMetadata: metadata, createdAt: "2026-09-11T00:00:00.000Z" }] });
  const loaded = await store.activateConversation(saved.id);
  assert.deepEqual(loaded.messages[0].webSearchSources, sources.slice(0, 1));
  assert.deepEqual(loaded.messages[0].webSearchMetadata, metadata);
});

test('each Agent Work panel retains five Side Chats and evicts only its own files and attachments', async t => {
  const { workspace } = await fixture(t);
  const a = new WorkspaceChatStore({ workspace, agentPanelId: 'agent-a' });
  const b = new WorkspaceChatStore({ workspace, agentPanelId: 'agent-b' });
  const imageA = await a.saveImageAttachments([{ name: 'a.png', dataUrl: png, thumbnail: png }]);
  const imageB = await b.saveImageAttachments([{ name: 'b.png', dataUrl: png, thumbnail: png }]);
  const aFirst = await turn(a, await a.loadActiveConversation(), 'A first', { images: imageA });
  const bFirst = await turn(b, await b.loadActiveConversation(), 'B first', { images: imageB });
  await Promise.all([a, b].map(async store => {
    for (let i = 0; i < 4; i++) await turn(store, await store.startNewConversation(), `${store.agentPanelId} ${i}`);
  }));
  await a.startNewConversation();
  assert.equal((await a.listConversations()).length, 5);
  assert.equal((await b.listConversations()).length, 5);
  assert.equal((await workspace.listFiles(a.conversationsDirectory)).length, 5);
  assert.equal((await workspace.listFiles(b.conversationsDirectory)).length, 5);
  assert.equal(await workspace.fileExists(a.conversationPath(aFirst.id)), false);
  assert.equal(await workspace.fileExists(`${a.attachmentsDirectory}/${imageA[0].attachmentId}.json`), false);
  await assert.rejects(a.activateConversation(bFirst.id), /no longer available/);
  await assert.rejects(b.loadImageAttachments(imageA), { code: 'IMAGE_MISSING' });
  const selected = await b.activateConversation(bFirst.id);
  assert.equal((await b.loadImageAttachments(selected.messages[0].images))[0].dataUrl, png);
  assert.equal((await new WorkspaceChatStore({ workspace, agentPanelId: 'agent-b' }).loadActiveConversation()).id, bFirst.id);
  assert.throws(() => new WorkspaceChatStore({ workspace, agentPanelId: '../other' }), /Invalid/);
});

test('scoped Side Chats leave legacy project history in place and readable', async t => {
  const { workspace, store } = await fixture(t);
  const legacy = await turn(store, await store.loadActiveConversation(), 'Existing project discussion');
  const before = await workspace.readJson(indexPath);
  const scoped = new WorkspaceChatStore({ workspace, agentPanelId: 'new-agent' });
  await turn(scoped, await scoped.loadActiveConversation(), 'New panel discussion');
  assert.deepEqual(await workspace.readJson(indexPath), before);
  assert.equal((await new WorkspaceChatStore({ workspace }).loadActiveConversation()).id, legacy.id);
  await assert.rejects(scoped.activateConversation(legacy.id), /no longer available/);
});

test('forking Side Chat retains images through eviction and preserves independent histories', async t => {
  const { workspace } = await fixture(t);
  const store = new WorkspaceChatStore({ workspace, agentPanelId: 'owner' });
  const images = await store.saveImageAttachments([{ name: 'chart.png', dataUrl: png, thumbnail: png }]);
  const original = await turn(store, await store.loadActiveConversation(), 'Original discussion', { images, imageUnderstanding: { text: 'An enzyme chart', model: 'vision' } });
  const firstFork = await store.forkConversation(original.id);
  assert.notEqual(firstFork.id, original.id);
  assert.deepEqual(firstFork.messages, original.messages);
  firstFork.messages[0].content = 'Fork-only edit';
  await store.saveConversation(firstFork);
  assert.equal((await store.activateConversation(original.id)).messages[0].content, 'Original discussion');
  for (let i = 0; i < 3; i++) await turn(store, await store.startNewConversation(), `Other ${i}`);
  const secondFork = await store.forkConversation(original.id);
  assert.equal((await store.listConversations()).length, 5);
  assert.equal(await workspace.fileExists(store.conversationPath(original.id)), false);
  assert.equal((await store.loadImageAttachments(secondFork.messages[0].images))[0].dataUrl, png);
  assert.equal(secondFork.messages[0].imageUnderstanding.text, 'An enzyme chart');
  const other = new WorkspaceChatStore({ workspace, agentPanelId: 'other' });
  await assert.rejects(other.forkConversation(secondFork.id), /no longer available/);
});

test('failed fork index writes preserve the source chat and remove the unfinished fork', async t => {
  const { workspace, store, files } = await fixture(t);
  const source = await turn(store, await store.loadActiveConversation(), 'Keep original');
  const before = await workspace.readJson(store.indexPath), write = workspace.writeJson;
  workspace.writeJson = async (relative, value) => { if (relative === store.indexPath) throw new Error('disk full'); return write(relative, value); };
  await assert.rejects(store.forkConversation(source.id), /disk full/);
  assert.deepEqual(await workspace.readJson(store.indexPath), before);
  assert.deepEqual(await files(), [`${source.id}.json`]);
});

test('deleting chats preserves shared attachments, selection and order; deleting the last creates an empty chat', async t => {
  const { workspace } = await fixture(t);
  const store = new WorkspaceChatStore({ workspace, agentPanelId: 'delete-owner' });
  const other = new WorkspaceChatStore({ workspace, agentPanelId: 'other-owner' });
  const foreign = await turn(other, await other.startNewConversation(), 'Unrelated history');
  const image = (await store.saveImageAttachments([{ name: 'image.png', dataUrl: png, thumbnail: png }]))[0];
  const original = await turn(store, await store.startNewConversation(), 'Original', { images: [image] });
  const fork = await store.forkConversation(original.id);
  const active = await turn(store, await store.startNewConversation(), 'Keep selected');
  const order = (await store.listConversations()).map(chat => chat.id).filter(id => id !== original.id);
  assert.equal((await store.deleteConversation(original.id)).id, active.id);
  assert.deepEqual((await store.listConversations()).map(chat => chat.id), order);
  assert.ok(await store.loadImageAttachments([image]));
  await assert.rejects(store.deleteConversation(foreign.id), /no longer available/);
  assert.equal((await other.loadActiveConversation()).id, foreign.id);
  await store.deleteConversation(fork.id);
  assert.equal(await workspace.fileExists(`${store.attachmentsDirectory}/${image.attachmentId}.json`), false);
  const replacement = await store.deleteConversation(active.id);
  assert.notEqual(replacement.id, active.id);
  assert.equal(replacement.messages.length, 0);
  assert.equal((await store.listConversations()).length, 1);
});

test('a failed deletion index write leaves history intact', async t => {
  const { workspace, store } = await fixture(t);
  const original = await turn(store, await store.startNewConversation(), 'Keep on disk');
  const write = workspace.writeJson;
  workspace.writeJson = async (relative, value) => { if (relative === store.indexPath) throw new Error('disk full'); return write(relative, value); };
  await assert.rejects(store.deleteConversation(original.id), /disk full/);
  workspace.writeJson = write;
  assert.equal((await store.loadActiveConversation()).id, original.id);
  assert.ok(await workspace.fileExists(store.conversationPath(original.id)));
});
