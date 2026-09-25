import assert from "node:assert/strict";
import { test } from "node:test";
import workspaceApi from "../../docs/workspace-manager.js";
import knowledgeApi from "../../docs/knowledge-service.js";

function workspaceBridge() {
  const files = new Map();
  const directories = new Set();
  const bridge = {
    project: {
      open: async () => ({ projectId: "project-1", name: "Desktop Project", initialized: false }),
      close: async () => ({ closed: true }),
    },
    files: {
      mkdir: async ({ relativePath }) => directories.add(relativePath),
      exists: async ({ relativePath }) => files.has(relativePath),
      writeText: async ({ relativePath, value }) => files.set(relativePath, new TextEncoder().encode(value)),
      writeBinary: async ({ relativePath, value }) => files.set(relativePath, new Uint8Array(value)),
      readText: async ({ relativePath }) => new TextDecoder().decode(files.get(relativePath)),
      readBinary: async ({ relativePath }) => files.get(relativePath).buffer,
      stat: async ({ relativePath }) => ({ relativePath, size: files.get(relativePath).byteLength, lastModified: 1, mimeType: "application/json" }),
      list: async () => [],
      remove: async ({ relativePath }) => files.delete(relativePath),
      tree: async () => ({ name: "Desktop Project", relativePath: "", type: "directory", children: [] }),
    },
  };
  return { bridge, files, directories };
}

test("Electron workspace adapter initializes the unchanged workspace schema through the bridge", async () => {
  const { bridge, files, directories } = workspaceBridge();
  const manager = new workspaceApi.ElectronWorkspaceManager({ desktop: bridge });
  const selection = await manager.selectWorkspace();
  assert.deepEqual(selection, { name: "Desktop Project", initialized: false });
  const opened = await manager.initializeWorkspace();
  assert.equal(opened.workspace.name, "Desktop Project");
  assert.equal(files.has(".biodesign/workspace.json"), true);
  assert.equal(files.has(".biodesign/state.json"), true);
  assert.equal(directories.has(".biodesign/knowledge/qmd"), true);
  assert.equal((await manager.scanDirectoryTree()).name, "Desktop Project");
});

test('panel-owned chat paths retain the original index and conversation schema validation', async () => {
  const { bridge, files } = workspaceBridge();
  const manager = new workspaceApi.ElectronWorkspaceManager({ desktop: bridge });
  await manager.selectWorkspace();
  for (const prefix of ['.biodesign/chat', '.biodesign/chat/agents/agent-a']) {
    await assert.rejects(manager.writeJson(`${prefix}/index.json`, { schemaVersion: 1 }), { code: 'INVALID_CHAT_INDEX' });
    await assert.rejects(manager.writeJson(`${prefix}/conversations/chat-a.json`, { schemaVersion: 1 }), { code: 'INVALID_CHAT_CONVERSATION' });
    assert.equal(files.has(`${prefix}/index.json`), false);
    files.set(`${prefix}/index.json`, new TextEncoder().encode('{"schemaVersion":1}'));
    await assert.rejects(manager.readJson(`${prefix}/index.json`), { code: 'INVALID_CHAT_INDEX' });
  }
});

test("Electron knowledge adapter uses IPC and preserves bounded search response semantics", async () => {
  const calls = [];
  const desktop = {
    knowledge: {
      onProgress: () => () => {},
      initialize: async (payload) => { calls.push(["initialize", payload]); return { available: true }; },
      search: async (payload) => { calls.push(["search", payload]); return { results: [{ paperId: "p1" }], diagnostics: { mode: payload.mode } }; },
      update: async () => ({}),
      embed: async () => ({}),
      status: async () => ({ available: true }),
      document: async () => null,
    },
  };
  const service = new knowledgeApi.ElectronQmdKnowledgeService({ desktop });
  assert.equal((await service.initialize({ workspaceId: "workspace-123" })).available, true);
  const result = await service.searchLiterature({ query: "enzyme", paperIds: ["p1"], limit: 5 });
  assert.equal(result.results[0].paperId, "p1");
  assert.deepEqual(calls[1][1].paperIds, ["p1"]);
  assert.equal(calls[1][1].mode, "fast");
});

test("workspace and knowledge I/O retain the original desktop project session ID", async () => {
  const calls = [];
  let current = "project-1";
  const bridge = {
    project: { open: async () => ({ projectId: current, name: current }), close: async () => ({ closed: true }) },
    files: { exists: async payload => { calls.push(payload); if (payload.projectId !== current) throw Object.assign(new Error("stale"), { code: "PROJECT_MISMATCH" }); return true; } },
    knowledge: { search: async payload => { calls.push(payload); return {}; } },
  };
  const old = new workspaceApi.ElectronWorkspaceManager({ desktop: bridge });
  await old.selectWorkspace();
  const boundKnowledge = old.desktop.knowledge;
  await old.fileExists("literature/a.pdf");
  current = "project-2";
  await assert.rejects(old.fileExists("literature/b.pdf"), { code: "PROJECT_MISMATCH" });
  await boundKnowledge.search({ query: "enzyme" });
  assert.ok(calls.every(call => call.projectId === "project-1"));
});
