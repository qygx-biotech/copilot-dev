import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, readFile, writeFile, readdir, access, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import contextApi from "../../docs/project-context-service.js";

const { WorkspaceChatStore, ProjectContextService } = contextApi;
const directory = ".biodesign/chat/conversations";
const indexPath = ".biodesign/chat/index.json";
const png = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAFgwJ/lzY4WQAAAABJRU5ErkJggg==";

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
  const reopened = await new WorkspaceChatStore({ workspace }).loadActiveConversation();
  assert.equal(reopened.id, chats[0].id);
  assert.equal((await store.loadImageAttachments(reopened.messages[0].images))[0].dataUrl, png);
  const context = new ProjectContextService({ workspace }).buildConversationContext(reopened);
  assert.deepEqual(context.recentlyDiscussedPaperIds, ["paper-1"]);
  assert.match(context.recentMessages[0].content, /Activity is 25 U\/mL/);
  await turn(store, selected, "Follow-up on Question 0");
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
