import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  DEFAULT_EMBED_MODEL,
  KNOWLEDGE_COLLECTIONS,
  MULTILINGUAL_EMBED_MODEL,
  ProjectQmdManager,
  QMD_PACKAGE_VERSION,
} from "../src/project-qmd-manager.js";

async function makeProject() {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), "biodesign-qmd-test-"));
  await mkdir(path.join(projectRoot, ".biodesign"), { recursive: true });
  await writeFile(
    path.join(projectRoot, ".biodesign", "workspace.json"),
    `${JSON.stringify({ schemaVersion: 1, workspaceId: "workspace-test-001" })}\n`
  );
  return projectRoot;
}

function makeFakeStore(overrides = {}) {
  return {
    async update() { return { indexed: 0, updated: 0, removed: 0 }; },
    async embed() { return { docsProcessed: 0, chunksEmbedded: 0, errors: 0 }; },
    async searchLex() { return []; },
    async searchVector() { return []; },
    async search() { return []; },
    async getStatus() {
      return { totalDocuments: 0, needsEmbedding: 0, hasVectorIndex: false, collections: [] };
    },
    async getIndexHealth() { return { needsEmbedding: 0, totalDocs: 0, daysStale: null }; },
    async listCollections() { return []; },
    async get() { return { title: "doc" }; },
    async getDocumentBody() { return "body"; },
    async close() {},
    ...overrides,
  };
}

test("manager pins QMD and keeps its database and collections inside the project", async (t) => {
  const projectRoot = await makeProject();
  t.after(() => rm(projectRoot, { recursive: true, force: true }));
  let storeOptions = null;
  const manager = new ProjectQmdManager({
    projectRoot,
    createStore: async (options) => {
      storeOptions = options;
      return makeFakeStore();
    },
  });
  t.after(() => manager.close());

  const status = await manager.initialize({ workspaceId: "workspace-test-001" });
  assert.equal(status.available, true);
  assert.equal(status.qmdPackageVersion, QMD_PACKAGE_VERSION);
  assert.equal(status.embeddingModelId, DEFAULT_EMBED_MODEL);
  const canonicalRoot = await realpath(projectRoot);
  assert.equal(storeOptions.dbPath, path.join(canonicalRoot, ".biodesign/knowledge/qmd/index.sqlite"));
  assert.deepEqual(
    Object.keys(storeOptions.config.collections).sort(),
    Object.keys(KNOWLEDGE_COLLECTIONS).sort()
  );
  for (const config of Object.values(storeOptions.config.collections)) {
    assert.equal(path.relative(canonicalRoot, config.path).startsWith(".."), false);
    assert.equal(config.pattern, "**/*.md");
  }
  const metadata = JSON.parse(await readFile(
    path.join(projectRoot, ".biodesign/knowledge/qmd/metadata.json"),
    "utf8"
  ));
  assert.equal(metadata.qmdPackageVersion, "2.8.3");
  assert.equal(metadata.dbPath, ".biodesign/knowledge/qmd/index.sqlite");
});

test("maintenance is serialized and embedding stays incremental by default", async (t) => {
  const projectRoot = await makeProject();
  t.after(() => rm(projectRoot, { recursive: true, force: true }));
  const events = [];
  const embedCalls = [];
  const store = makeFakeStore({
    async update({ collections }) {
      events.push(`start:${collections.join(",")}`);
      await new Promise((resolve) => setTimeout(resolve, 5));
      events.push(`end:${collections.join(",")}`);
      return { indexed: 1 };
    },
    async embed(options) {
      embedCalls.push(options);
      options.onProgress?.({
        chunksEmbedded: 1,
        totalChunks: 2,
        bytesProcessed: 128,
        totalBytes: 256,
        errors: 0,
      });
      return { docsProcessed: 1, chunksEmbedded: 1, errors: 0 };
    },
  });
  const manager = new ProjectQmdManager({ projectRoot, createStore: async () => store });
  t.after(() => manager.close());

  await Promise.all([
    manager.update({ collections: ["literature-evidence"] }),
    manager.update({ collections: ["paper-cards"] }),
  ]);
  assert.deepEqual(events, [
    "start:literature-evidence",
    "end:literature-evidence",
    "start:paper-cards",
    "end:paper-cards",
  ]);

  let observedProgress = null;
  await manager.embed({
    collections: ["literature-evidence"],
    onProgress(progress) { observedProgress = progress; },
  });
  assert.equal(embedCalls.length, 1);
  assert.equal(embedCalls[0].collection, "literature-evidence");
  assert.equal(embedCalls[0].force, false);
  assert.equal(embedCalls[0].model, DEFAULT_EMBED_MODEL);
  assert.equal(observedProgress.chunksEmbedded, 1);
  assert.equal(observedProgress.totalChunks, 2);
  assert.equal((await manager.status()).embeddingProgress, null);
});

test("search groups QMD sections by paper and enforces an explicit paper scope", async (t) => {
  const projectRoot = await makeProject();
  t.after(() => rm(projectRoot, { recursive: true, force: true }));
  let receivedOptions = null;
  const store = makeFakeStore({
    async searchLex(query, options) {
      receivedOptions = { query, options };
      return [
        {
          filepath: "qmd://literature-evidence/paper-017.md",
          displayPath: "literature-evidence/paper-017.md",
          title: "EctD stability",
          body: "---\nsource_id: paper-017\n---\n## Page 2\nA163V improves thermal stability.",
          score: 0.93,
        },
        {
          filepath: "qmd://literature-evidence/paper-099.md",
          displayPath: "literature-evidence/paper-099.md",
          title: "Out of scope",
          body: "---\nsource_id: paper-099\n---\n## Page 1\nA163V decoy.",
          score: 0.99,
        },
      ];
    },
  });
  const manager = new ProjectQmdManager({ projectRoot, createStore: async () => store });
  t.after(() => manager.close());

  const result = await manager.search({
    query: "A163V stability",
    mode: "fast",
    collections: ["literature-evidence", "paper-cards"],
    paperIds: ["paper-017"],
    limit: 5,
  });
  assert.deepEqual(receivedOptions.options.collection, ["literature-evidence", "paper-cards"]);
  assert.equal(result.results.length, 1);
  assert.equal(result.results[0].paperId, "paper-017");
  assert.match(result.results[0].matchedSections[0].snippet, /A163V/);
});

test("deep candidate search remains lexical and never invokes local query expansion or reranking", async (t) => {
  const projectRoot = await makeProject();
  t.after(() => rm(projectRoot, { recursive: true, force: true }));
  let receivedLexical = null;
  let localDeepCalls = 0;
  const store = makeFakeStore({
    async searchLex(query, options) {
      receivedLexical = { query, options };
      return [{
        filepath: "qmd://literature-evidence/paper-017.md",
        displayPath: "literature-evidence/paper-017.md",
        title: "EctD stability",
        body: "---\nsource_id: paper-017\n---\nA163V improves thermal stability.",
        score: 0.99,
      }];
    },
    async search() {
      localDeepCalls += 1;
      throw new Error("Local deep models must not be called.");
    },
  });
  const manager = new ProjectQmdManager({ projectRoot, createStore: async () => store });
  t.after(() => manager.close());

  const result = await manager.search({
    query: "Which mutation improves thermal stability?",
    mode: "deep",
    collections: ["literature-evidence"],
    paperIds: ["paper-017"],
    limit: 5,
    candidateLimit: 12,
    intent: "compare mutation evidence",
  });
  assert.deepEqual(receivedLexical, {
    query: "Which mutation improves thermal stability?",
    options: {
      collection: ["literature-evidence"],
      limit: 12,
    },
  });
  assert.equal(localDeepCalls, 0);
  assert.equal(result.mode, "deep");
  assert.equal(result.diagnostics.cloudAssistanceRequired, true);
  assert.equal(result.results[0].paperId, "paper-017");
});

test("an embedding-model change blocks semantic search until a controlled rebuild", async (t) => {
  const projectRoot = await makeProject();
  t.after(() => rm(projectRoot, { recursive: true, force: true }));
  const qmdDirectory = path.join(projectRoot, ".biodesign/knowledge/qmd");
  await mkdir(qmdDirectory, { recursive: true });
  await writeFile(
    path.join(qmdDirectory, "metadata.json"),
    `${JSON.stringify({ embeddingModelId: DEFAULT_EMBED_MODEL })}\n`
  );
  const manager = new ProjectQmdManager({
    projectRoot,
    embedModel: MULTILINGUAL_EMBED_MODEL,
    createStore: async () => makeFakeStore(),
  });
  t.after(() => manager.close());

  const status = await manager.initialize();
  assert.equal(status.requiresVectorRebuild, true);
  await assert.rejects(
    manager.search({ query: "提高酶热稳定性", mode: "semantic" }),
    (error) => error.code === "QMD_VECTOR_REBUILD_REQUIRED"
  );
});

test("partial embedding failures remain blocked across restarts", async (t) => {
  const projectRoot = await makeProject();
  t.after(() => rm(projectRoot, { recursive: true, force: true }));
  const manager = new ProjectQmdManager({
    projectRoot,
    createStore: async () => makeFakeStore({
      async embed() { return { docsProcessed: 2, chunksEmbedded: 1, errors: 1 }; },
    }),
  });
  await manager.embed({ collections: ["literature-evidence"] });
  assert.equal((await manager.status()).requiresVectorRebuild, true);
  await assert.rejects(
    manager.search({ query: "enzyme activity", mode: "semantic" }),
    (error) => error.code === "QMD_VECTOR_REBUILD_REQUIRED"
  );
  await manager.close();

  const restarted = new ProjectQmdManager({
    projectRoot,
    createStore: async () => makeFakeStore(),
  });
  t.after(() => restarted.close());
  const restartedStatus = await restarted.initialize();
  assert.equal(restartedStatus.requiresVectorRebuild, true);
  const metadata = JSON.parse(await readFile(
    path.join(projectRoot, ".biodesign/knowledge/qmd/metadata.json"),
    "utf8"
  ));
  assert.equal(metadata.vectorState, "partial_failure");
});
