const assert = require("node:assert/strict");
const test = require("node:test");

const {
  WorkspaceError,
  WorkspaceManager,
} = require("../../docs/workspace-manager.js");
const {
  LiteratureModule,
  chunkLiteratureText,
  extractLocalPdf,
} = require("../../docs/literature-module.js");
const {
  CONTEXT_LIMITS,
  ProjectContextService,
  WorkspaceChatStore,
  flattenWorkspaceTree,
} = require("../../docs/project-context-service.js");

function notFound(message) {
  const error = new Error(message);
  error.name = "NotFoundError";
  return error;
}

class FakeFileHandle {
  constructor(name, clock) {
    this.kind = "file";
    this.name = name;
    this.clock = clock;
    this.bytes = new Uint8Array();
    this.lastModified = clock.value;
    this.type = name.toLowerCase().endsWith(".pdf")
      ? "application/pdf"
      : "application/json";
  }

  async getFile() {
    const bytes = this.bytes.slice();
    return {
      name: this.name,
      size: bytes.byteLength,
      type: this.type,
      lastModified: this.lastModified,
      text: async () => new TextDecoder().decode(bytes),
      arrayBuffer: async () => bytes.buffer.slice(0),
    };
  }

  async createWritable() {
    let pending = null;
    return {
      write: async (data) => {
        if (typeof data === "string") {
          pending = new TextEncoder().encode(data);
        } else if (data instanceof Uint8Array) {
          pending = data.slice();
        } else if (data instanceof ArrayBuffer) {
          pending = new Uint8Array(data.slice(0));
        } else if (typeof data?.arrayBuffer === "function") {
          pending = new Uint8Array(await data.arrayBuffer());
          if (data.type) this.type = data.type;
        } else {
          throw new Error("Unsupported fake write payload");
        }
      },
      close: async () => {
        this.bytes = pending || new Uint8Array();
        this.clock.value += 1;
        this.lastModified = this.clock.value;
      },
      abort: async () => {},
    };
  }
}

class FakeDirectoryHandle {
  constructor(name, clock) {
    this.kind = "directory";
    this.name = name;
    this.clock = clock;
    this.children = new Map();
  }

  async queryPermission() {
    return "granted";
  }

  async requestPermission() {
    return "granted";
  }

  async getDirectoryHandle(name, options = {}) {
    const existing = this.children.get(name);
    if (existing?.kind === "directory") return existing;
    if (existing) throw new TypeError(`${name} is not a directory`);
    if (!options.create) throw notFound(name);
    const directory = new FakeDirectoryHandle(name, this.clock);
    this.children.set(name, directory);
    return directory;
  }

  async getFileHandle(name, options = {}) {
    const existing = this.children.get(name);
    if (existing?.kind === "file") return existing;
    if (existing) throw new TypeError(`${name} is not a file`);
    if (!options.create) throw notFound(name);
    const file = new FakeFileHandle(name, this.clock);
    this.children.set(name, file);
    return file;
  }

  async removeEntry(name) {
    if (!this.children.has(name)) throw notFound(name);
    this.children.delete(name);
  }

  async *entries() {
    for (const entry of this.children.entries()) yield entry;
  }
}

function createManager(root) {
  let uuidCounter = 0;
  return new WorkspaceManager({
    directoryPicker: async () => root,
    cryptoProvider: {
      randomUUID() {
        uuidCounter += 1;
        return `00000000-0000-4000-8000-${String(uuidCounter).padStart(12, "0")}`;
      },
    },
    now: () => new Date("2026-08-20T05:00:00.000Z"),
  });
}

async function makeInitializedWorkspace() {
  const root = new FakeDirectoryHandle("EctD Optimization", { value: 1000 });
  const unrelatedHandle = await root.getFileHandle("existing-notes.txt", { create: true });
  const unrelatedWritable = await unrelatedHandle.createWritable();
  await unrelatedWritable.write("keep this unrelated file");
  await unrelatedWritable.close();
  const manager = createManager(root);
  const selection = await manager.selectWorkspace();
  assert.equal(selection.initialized, false);
  await manager.initializeWorkspace();
  return { root, manager };
}

test("unsupported and cancelled directory selection fail without creating state", async () => {
  const unsupported = new WorkspaceManager({
    directoryPicker: async () => null,
    secureContext: false,
  });
  assert.equal(unsupported.isSupported(), false);
  await assert.rejects(
    unsupported.selectWorkspace(),
    (error) => error.code === "UNSUPPORTED_BROWSER"
  );

  const cancelled = new WorkspaceManager({
    directoryPicker: async () => {
      const error = new Error("cancelled");
      error.name = "AbortError";
      throw error;
    },
  });
  await assert.rejects(
    cancelled.selectWorkspace(),
    (error) => error.code === "PICKER_CANCELLED"
  );
  assert.equal(cancelled.rootHandle, null);
});

test("workspace initialization creates the generic structure and stable metadata", async () => {
  const { root, manager } = await makeInitializedWorkspace();
  const workspace = await manager.readJson(".biodesign/workspace.json");
  const state = await manager.readJson(".biodesign/state.json");

  assert.equal(workspace.name, "EctD Optimization");
  assert.equal(workspace.schemaVersion, 1);
  assert.equal(state.project.goal, "");
  assert.deepEqual(Object.keys(state.memory), [
    "projectSummary",
    "conversationSummary",
    "literatureSummary",
    "experimentalSummary",
  ]);
  assert.equal((await root.getDirectoryHandle("literature")).kind, "directory");
  assert.equal(
    (await manager.getDirectory("experiments/downstream-processing")).kind,
    "directory"
  );
  assert.equal(
    await (await (await root.getFileHandle("existing-notes.txt")).getFile()).text(),
    "keep this unrelated file"
  );

  const originalId = workspace.workspaceId;
  await manager.saveState({
    ...state,
    project: { goal: "Optimize EctD production" },
  });
  manager.closeWorkspace();
  await manager.selectWorkspace();
  const reloaded = await manager.loadWorkspace();
  assert.equal(reloaded.workspace.workspaceId, originalId);
  assert.equal(reloaded.state.project.goal, "Optimize EctD production");
});

test("malformed managed JSON is preserved and produces an actionable error", async () => {
  for (const path of [
    ".biodesign/workspace.json",
    ".biodesign/state.json",
    ".biodesign/literature/index.json",
  ]) {
    const { manager } = await makeInitializedWorkspace();
    const handle = await manager.getFileHandle(path);
    const malformed = `{malformed-${path}`;
    const writable = await handle.createWritable();
    await writable.write(malformed);
    await writable.close();

    await assert.rejects(
      manager.loadWorkspace(),
      (error) => error instanceof WorkspaceError && error.code === "MALFORMED_JSON"
    );
    assert.equal(await (await handle.getFile()).text(), malformed);
  }
});

test("different selected folders remain independent workspaces", async () => {
  const clock = { value: 2000 };
  const firstRoot = new FakeDirectoryHandle("First Project", clock);
  const secondRoot = new FakeDirectoryHandle("Second Project", clock);
  let selectedRoot = firstRoot;
  let counter = 100;
  const manager = new WorkspaceManager({
    directoryPicker: async () => selectedRoot,
    cryptoProvider: {
      randomUUID: () =>
        `00000000-0000-4000-8000-${String(counter++).padStart(12, "0")}`,
    },
  });

  await manager.selectWorkspace();
  const first = await manager.initializeWorkspace();
  await manager.saveState({ ...first.state, project: { goal: "First goal" } });
  manager.closeWorkspace();

  selectedRoot = secondRoot;
  await manager.selectWorkspace();
  const second = await manager.initializeWorkspace();
  assert.notEqual(second.workspace.workspaceId, first.workspace.workspaceId);
  assert.equal(second.state.project.goal, "");
  manager.closeWorkspace();

  selectedRoot = firstRoot;
  await manager.selectWorkspace();
  const restored = await manager.loadWorkspace();
  assert.equal(restored.state.project.goal, "First goal");
});

test("workspace tree recursively reflects local files and hides .biodesign", async () => {
  const { manager } = await makeInitializedWorkspace();
  await manager.ensureDirectory("experiments/fermentation");
  await manager.ensureDirectory("sequences/archive");
  await manager.writeFile("experiments/fermentation/run1.xlsx", new Blob(["sheet"]));
  await manager.writeFile("sequences/archive/ectd.fasta", new Blob([">ectd\nATGC"]));
  await manager.writeFile("notes.txt", new Blob(["project notes"]));

  const tree = await manager.scanDirectoryTree();
  const entries = flattenWorkspaceTree(tree);
  const paths = entries.map((entry) => entry.relativePath);

  assert.equal(tree.name, "EctD Optimization");
  assert.ok(paths.includes("experiments/fermentation/run1.xlsx"));
  assert.ok(paths.includes("sequences/archive/ectd.fasta"));
  assert.ok(paths.includes("notes.txt"));
  assert.ok(paths.every((path) => !path.startsWith(".biodesign")));
  const run = entries.find(
    (entry) => entry.relativePath === "experiments/fermentation/run1.xlsx"
  );
  assert.equal(run.type, "file");
  assert.equal(run.size, 5);
  assert.ok(Number.isFinite(run.lastModified));
});

test("Side Chat conversations persist locally and clear without touching project files", async () => {
  const { manager } = await makeInitializedWorkspace();
  await manager.writeFile("notes.txt", new Blob(["keep me"]));
  const store = new WorkspaceChatStore({
    workspace: manager,
    now: () => new Date("2026-08-20T06:00:00.000Z"),
  });
  let conversation = await store.loadActiveConversation();
  conversation.messages.push(
    {
      id: manager.createId(),
      role: "user",
      content: "Compare these papers.",
      context: {
        type: "files",
        files: ["literature/paper1.pdf", "literature/paper2.pdf"],
        selectedPaperIds: ["paper-1", "paper-2"],
        relevantPaperIds: ["paper-1", "paper-2"],
      },
      createdAt: "2026-08-20T06:01:00.000Z",
    },
    {
      id: manager.createId(),
      role: "assistant",
      content: "They use different activity assays.",
      createdAt: "2026-08-20T06:01:10.000Z",
    }
  );
  conversation = await store.saveConversation(conversation);
  const originalId = conversation.id;

  const restoredStore = new WorkspaceChatStore({ workspace: manager });
  const restored = await restoredStore.loadActiveConversation();
  assert.equal(restored.id, originalId);
  assert.equal(restored.messages.length, 2);
  assert.deepEqual(restored.messages[0].context.files, [
    "literature/paper1.pdf",
    "literature/paper2.pdf",
  ]);
  assert.deepEqual(restored.messages[0].context.selectedPaperIds, [
    "paper-1",
    "paper-2",
  ]);

  const cleared = await restoredStore.clearActiveConversation();
  assert.notEqual(cleared.id, originalId);
  assert.deepEqual(cleared.messages, []);
  assert.equal(
    await manager.fileExists(`.biodesign/chat/conversations/${originalId}.json`),
    false
  );
  assert.equal(await (await manager.readFile("notes.txt")).text(), "keep me");
});

test("Side Chat persistence keeps a complete long model reply", async () => {
  const { manager } = await makeInitializedWorkspace();
  const store = new WorkspaceChatStore({ workspace: manager });
  const conversation = await store.loadActiveConversation();
  const longReply = `# Complete answer\n\n${Array.from(
    { length: 1000 },
    () => "Full provider output."
  ).join(" ")}`;
  assert.ok(longReply.length > 12000);
  conversation.messages.push({
    id: manager.createId(),
    role: "assistant",
    content: longReply,
    createdAt: "2026-08-20T06:01:10.000Z",
  });

  await store.saveConversation(conversation);
  const restored = await new WorkspaceChatStore({ workspace: manager })
    .loadActiveConversation();
  assert.equal(restored.messages[0].content, longReply);
  assert.equal(CONTEXT_LIMITS.maxEvidenceFiles, 150);
  assert.equal(CONTEXT_LIMITS.maxTotalEvidenceCharacters, 360000);
});

test("workspace state rejects secret-bearing keys without overwriting the file", async () => {
  const { manager } = await makeInitializedWorkspace();
  const before = await (await manager.readFile(".biodesign/state.json")).text();
  await assert.rejects(
    manager.saveState({
      ...manager.state,
      agent: { authToken: "must-not-be-written" },
    }),
    (error) => error.code === "INVALID_STATE"
  );
  const after = await (await manager.readFile(".biodesign/state.json")).text();
  assert.equal(after, before);
  assert.doesNotMatch(after, /must-not-be-written/);

  await assert.rejects(
    manager.writeJson(".biodesign/chat/conversations/leak.json", {
      schemaVersion: 1,
      id: "leak",
      title: "Leak test",
      createdAt: "2026-08-20T05:00:00.000Z",
      updatedAt: "2026-08-20T05:00:00.000Z",
      summary: "",
      messages: [],
      authToken: "must-not-be-written",
    }),
    (error) => error.code === "INVALID_CHAT_CONVERSATION"
  );
  assert.equal(
    await manager.fileExists(".biodesign/chat/conversations/leak.json"),
    false
  );
});

test("Paper Cards are generated once, reused, regenerated on change, and removed with the source", async () => {
  const { manager } = await makeInitializedWorkspace();
  await manager.writeFile("literature/paper-a.pdf", new Blob(["first pdf content"]));
  let chunkCalls = 0;
  let synthesisCalls = 0;
  const api = {
    async summarizeChunk() {
      chunkCalls += 1;
      return {
        summary: "EctD activity evidence.",
        researchQuestion: "How can EctD activity be improved?",
        methods: "Enzyme activity assay",
        keyResults: ["A163V improved activity"],
        limitations: [],
        mainConclusion: "The variant was more active.",
      };
    },
    async synthesize() {
      synthesisCalls += 1;
      return {
        title: "Paper A",
        authors: ["A. Researcher"],
        year: 2024,
        shortSummary: "A163V improves EctD activity.",
        summary: "A Paper Card summary.",
        researchQuestion: "How can EctD activity be improved?",
        mainFindings: ["A163V improved activity"],
        methods: ["Enzyme activity assay"],
        methodsSummary: "The authors compared purified enzyme variants.",
        organisms: ["Escherichia coli"],
        genes: ["ectD"],
        proteins: ["EctD"],
        pathways: ["hydroxyectoine biosynthesis"],
        metabolites: ["hydroxyectoine"],
        experimentalConditions: [],
        measurements: ["kcat", "Km"],
        importantResults: ["A163V increased kcat"],
        keyResults: ["A163V improved activity"],
        limitations: [],
        mainConclusion: "The variant was more active.",
        keywords: ["EctD", "A163V"],
        topics: ["enzyme engineering"],
      };
    },
  };
  const pdfjsLib = {
    getDocument({ data }) {
      const raw = new TextDecoder().decode(data);
      const extractedText = raw.includes("paper-b.pdf")
        ? "The A163V EctD variant had an exact kcat of 12.4 s-1 and Km of 0.8 mM measured by HPLC. ".repeat(12)
        : "Machine-readable paper evidence. ".repeat(40);
      return {
        promise: Promise.resolve({
          numPages: 1,
          getPage: async () => ({
            getTextContent: async () => ({
              items: [
                {
                  str: "Machine-readable EctD paper evidence. ".repeat(40),
                  hasEOL: true,
                },
              ],
            }),
          }),
          getMetadata: async () => ({ info: { Title: "Paper A" } }),
          destroy: async () => {},
        }),
      };
    },
  };
  let module = new LiteratureModule({
    workspace: manager,
    api,
    pdfjsLib,
  });
  const firstSync = await module.syncPaperLibrary();
  const documentId = firstSync.documents[0].id;
  const cardPath = firstSync.documents[0].paperCardPath;
  const firstHash = firstSync.documents[0].sourceHash;
  const firstCard = await module.getPaperCard(documentId);
  assert.equal(firstCard.paperId, documentId);
  assert.equal(firstCard.source.hash, firstHash);
  assert.deepEqual(firstCard.genes, ["ectD"]);
  assert.equal(await manager.fileExists(cardPath), true);
  const firstIndex = await manager.readJson(".biodesign/literature/index.json");
  assert.deepEqual(firstIndex.documents[0].discovery, {
    fileName: "paper-a.pdf",
    title: "Paper A",
    authors: ["A. Researcher"],
    year: 2024,
    topics: ["enzyme engineering"],
    keywords: ["EctD", "A163V"],
    identifiers: [
      "Escherichia coli",
      "ectD",
      "EctD",
      "hydroxyectoine biosynthesis",
      "hydroxyectoine",
    ],
    shortDescription: "A163V improves EctD activity.",
  });
  assert.equal(synthesisCalls, 1);

  module = new LiteratureModule({ workspace: manager, api, pdfjsLib });
  const restarted = await module.syncPaperLibrary();
  assert.deepEqual(restarted.generatedPaperIds, []);
  assert.ok(restarted.reusedPaperIds.includes(documentId));
  assert.equal(synthesisCalls, 1);

  const literatureDirectory = await manager.getDirectory("literature");
  const renamedHandle = await literatureDirectory.getFileHandle("paper-a.pdf");
  literatureDirectory.children.delete("paper-a.pdf");
  renamedHandle.name = "renamed-paper.pdf";
  literatureDirectory.children.set("renamed-paper.pdf", renamedHandle);
  const renamed = await module.syncPaperLibrary();
  const renamedId = renamed.documents[0].id;
  const renamedCardPath = renamed.documents[0].paperCardPath;
  assert.notEqual(renamedId, documentId);
  assert.equal(renamed.documents[0].filename, "renamed-paper.pdf");
  assert.equal((await module.getPaperCard(renamedId)).fileName, "renamed-paper.pdf");
  assert.equal(synthesisCalls, 2);

  const preservedLastModified = renamedHandle.lastModified;
  renamedHandle.bytes = new TextEncoder().encode("other pdf content");
  const sameMetadataChange = await module.syncPaperLibrary();
  assert.equal(sameMetadataChange.documents[0].lastModified, preservedLastModified);
  // A stat-identical replacement cannot be distinguished by cheap folder
  // reconciliation; explicit verification or a later stat change triggers hashing.
  assert.equal(sameMetadataChange.documents[0].sourceHash, renamed.documents[0].sourceHash);
  assert.equal(synthesisCalls, 2);

  const retrievalCachePath = `.biodesign/literature/cache/${renamedId}.json`;
  await manager.writeJson(retrievalCachePath, { paperId: renamedId, chunks: [] });
  await manager.writeFile(
    "literature/renamed-paper.pdf",
    new Blob(["changed pdf content with a different source hash"])
  );
  const changed = await module.syncPaperLibrary();
  assert.equal(changed.documents[0].id, renamedId);
  assert.notEqual(changed.documents[0].sourceHash, firstHash);
  assert.equal(synthesisCalls, 3);
  assert.equal((await module.getPaperCard(renamedId)).source.hash, changed.documents[0].sourceHash);
  assert.equal(await manager.fileExists(retrievalCachePath), false);

  await manager.writeJson(retrievalCachePath, { paperId: renamedId, chunks: [] });
  await manager.removeFile("literature/renamed-paper.pdf");
  const removed = await module.syncPaperLibrary();
  assert.deepEqual(removed.documents, []);
  assert.equal(await manager.fileExists(cardPath), false);
  assert.equal(await manager.fileExists(renamedCardPath), false);
  assert.equal(await manager.fileExists(retrievalCachePath), false);
  assert.ok(chunkCalls >= 2);
});

test("adding a duplicate PDF creates a clear unique filename", async () => {
  const { manager } = await makeInitializedWorkspace();
  let llmCalls = 0;
  const module = new LiteratureModule({
    workspace: manager,
    api: {
      async summarizeChunk() {
        llmCalls += 1;
        throw new Error("Paper Cards must stay deferred during upload.");
      },
    },
    pdfjsLib: {},
  });
  const file = new Blob(["pdf bytes"], { type: "application/pdf" });
  Object.defineProperty(file, "name", { value: "paper.pdf" });
  await module.addFiles([file]);
  const result = await module.addFiles([file]);
  assert.deepEqual(result.addedNames, ["paper (2).pdf"]);
  assert.deepEqual(
    result.documents.map((document) => document.filename),
    ["paper.pdf", "paper (2).pdf"]
  );
  assert.ok(result.documents.every((document) => document.paperCardStatus === "pending"));
  assert.equal(llmCalls, 0);
});

test("local PDF map-reduce sends text only to FC and restores the local cache", async () => {
  const { manager } = await makeInitializedWorkspace();
  await manager.writeFile("literature/review.pdf", new Blob(["%PDF-fake"]));
  const capturedChunks = [];
  let syntheses = 0;
  const api = {
    async summarizeChunk(payload) {
      capturedChunks.push(payload);
      return {
        summary: "Chunk evidence",
        researchQuestion: null,
        methods: "Review method",
        keyResults: ["Result"],
        limitations: [],
        mainConclusion: null,
      };
    },
    async synthesize(payload) {
      syntheses += 1;
      assert.equal(payload.filename, "review.pdf");
      assert.equal(payload.relativePath, undefined);
      return {
        model: "test-model",
        title: "Local Review",
        summary: "Paper summary",
        researchQuestion: "Question",
        methods: "Methods",
        keyResults: ["Result"],
        limitations: ["Limitation"],
        mainConclusion: "Conclusion",
        keywords: ["keyword"],
      };
    },
  };
  const readableText = `${"Evidence from the machine-readable paper. ".repeat(800)}`;
  const pdfjsLib = {
    GlobalWorkerOptions: {},
    getDocument() {
      return {
        promise: Promise.resolve({
          numPages: 1,
          getPage: async () => ({
            getTextContent: async () => ({
              items: [{ str: readableText, hasEOL: true }],
            }),
          }),
          getMetadata: async () => ({ info: { Title: "Local Review" } }),
          destroy: async () => {},
        }),
      };
    },
  };
  const module = new LiteratureModule({
    workspace: manager,
    api,
    pdfjsLib,
    config: { chunkCharacters: 4000, chunkOverlap: 100, maxChunks: 12 },
  });
  const [document] = await module.scan();
  const first = await module.summarize(document.id);

  assert.equal(first.cached, false);
  assert.equal(first.summary.summary, "Paper summary");
  assert.ok(capturedChunks.length > 1);
  assert.ok(capturedChunks.every((payload) => typeof payload.text === "string"));
  assert.ok(capturedChunks.every((payload) => payload.relativePath === undefined));
  assert.equal(syntheses, 1);
  assert.equal(await manager.fileExists(document.summaryPath), true);

  const chunkCalls = capturedChunks.length;
  const second = await module.summarize(document.id);
  assert.equal(second.cached, true);
  assert.equal(capturedChunks.length, chunkCalls);
  assert.equal(syntheses, 1);
});

test("Side Chat context processes selected PDFs on demand and reuses their cache", async () => {
  const { manager } = await makeInitializedWorkspace();
  await manager.writeFile("literature/activity.pdf", new Blob(["%PDF-fake"]));
  await manager.ensureDirectory("experiments");
  await manager.writeFile("experiments/run.xlsx", new Blob(["spreadsheet bytes"]));
  let chunkCalls = 0;
  let synthesisCalls = 0;
  let extractionCalls = 0;
  const sourceText = `${"The third experiment used an exact concentration of 25 micromolar in the activity assay. ".repeat(120)}`;
  const pdfjsLib = {
    GlobalWorkerOptions: {},
    getDocument() {
      extractionCalls += 1;
      return {
        promise: Promise.resolve({
          numPages: 1,
          getPage: async () => ({
            getTextContent: async () => ({
              items: [{ str: sourceText, hasEOL: true }],
            }),
          }),
          getMetadata: async () => ({ info: { Title: "Activity paper" } }),
          destroy: async () => {},
        }),
      };
    },
  };
  const literature = new LiteratureModule({
    workspace: manager,
    pdfjsLib,
    api: {
      async summarizeChunk() {
        chunkCalls += 1;
        return {
          summary: "Activity evidence",
          researchQuestion: "Which condition improves activity?",
          methods: "Activity assay",
          keyResults: ["Condition A improved activity"],
          limitations: ["Single assay"],
          mainConclusion: "Condition A was preferred",
        };
      },
      async synthesize() {
        synthesisCalls += 1;
        return {
          title: "Activity paper",
          summary: "The paper compares activity conditions.",
          researchQuestion: "Which condition improves activity?",
          methods: "Activity assay",
          keyResults: ["Condition A improved activity"],
          limitations: ["Single assay"],
          mainConclusion: "Condition A was preferred",
          keywords: ["activity"],
        };
      },
    },
    config: { chunkCharacters: 4000, chunkOverlap: 100, maxChunks: 8 },
  });
  await literature.scan();
  const tree = await manager.scanDirectoryTree();
  const service = new ProjectContextService({ workspace: manager, literature });

  const metadataOnly = await service.buildContext({
    question: "What files are selected?",
    selectedPaths: ["literature/activity.pdf"],
    workspaceTree: tree,
    projectGoal: "Improve enzyme activity",
  });
  assert.deepEqual(metadataOnly.files, []);
  assert.equal(metadataOnly.literature.retrievalRequired, false);
  assert.equal(chunkCalls, 0);
  assert.equal(synthesisCalls, 0);
  assert.equal(extractionCalls, 0);

  const first = await service.buildContext({
    question: "Summarize this paper.",
    selectedPaths: ["literature/activity.pdf"],
    workspaceTree: tree,
    projectGoal: "Improve enzyme activity",
  });
  assert.equal(first.scope.type, "files");
  assert.equal(first.files[0].analysisStatus, "processed");
  assert.match(first.files[0].evidenceType, /original.*evidence/);
  assert.match(first.files[0].content, /Original-paper evidence/);
  assert.ok(chunkCalls > 0);
  assert.equal(synthesisCalls, 1);

  const callsAfterFirstTurn = chunkCalls;
  const second = await service.buildContext({
    question: "What are its limitations?",
    selectedPaths: ["literature/activity.pdf"],
    workspaceTree: tree,
    projectGoal: "Improve enzyme activity",
  });
  assert.match(second.files[0].evidenceType, /original.*evidence/);
  assert.equal(chunkCalls, callsAfterFirstTurn);
  assert.equal(synthesisCalls, 1);

  const detailed = await service.buildContext({
    question: "What exact concentration did the third experiment use?",
    selectedPaths: ["literature/activity.pdf"],
    workspaceTree: tree,
    projectGoal: "Improve enzyme activity",
  });
  assert.match(detailed.files[0].evidenceType, /original-paper-evidence/);
  assert.match(detailed.files[0].content, /25 micromolar/i);
  assert.equal(extractionCalls, 1);
  assert.equal(synthesisCalls, 1);

  const invalidWorkbook = await service.buildContext({
    question: "What does this spreadsheet show?",
    selectedPaths: ["experiments/run.xlsx"],
    workspaceTree: tree,
    projectGoal: "Improve enzyme activity",
  });
  assert.equal(invalidWorkbook.files[0].analysisStatus, "processing-failed");
  assert.equal(invalidWorkbook.files[0].content, "");
  assert.ok(
    invalidWorkbook.notices.some((notice) =>
      /Could not process experiments\/run\.xlsx/.test(notice)
    )
  );
});

test("unrelated Side Chat and Agent Work context builds do not prepare sources", async () => {
  const { manager } = await makeInitializedWorkspace();
  await manager.writeFile("literature/deferred.pdf", new Blob(["%PDF-deferred"]));
  let parserCalls = 0;
  let llmCalls = 0;
  const literature = new LiteratureModule({
    workspace: manager,
    pdfjsLib: {
      getDocument() {
        parserCalls += 1;
        throw new Error("PDF parsing must remain deferred.");
      },
    },
    api: {
      async summarizeChunk() {
        llmCalls += 1;
        throw new Error("Paper Cards must remain deferred.");
      },
      async synthesize() {
        llmCalls += 1;
        throw new Error("Paper Cards must remain deferred.");
      },
    },
  });
  await literature.scan();
  const workspaceTree = await manager.scanDirectoryTree();
  const service = new ProjectContextService({ workspace: manager, literature });

  await service.buildContext({
    question: "Change the interface language to Chinese.",
    selectedPaths: [],
    workspaceTree,
  });
  await service.buildContext({
    question: "What is the current project goal?",
    selectedPaths: [],
    workspaceTree,
  });

  assert.equal(literature.preparation.metrics.fullHashCalls, 0);
  assert.equal(parserCalls, 0);
  assert.equal(llmCalls, 0);
});

test("combined literature and experiment questions keep separate labeled evidence bundles", async () => {
  const { manager } = await makeInitializedWorkspace();
  await manager.writeFile("literature/ectd.pdf", new Blob(["%PDF-ectd"]));
  await manager.writeFile(
    "experiments/strain-engineering/ectd.csv",
    new Blob(["protein,mutation,activity,unit\nEctD,A163V,4.8,U/mg"])
  );
  const literature = new LiteratureModule({
    workspace: manager,
    pdfjsLib: {
      getDocument() {
        return {
          promise: Promise.resolve({
            numPages: 1,
            getPage: async () => ({
              getTextContent: async () => ({
                items: [
                  {
                    str: "Published evidence reports that EctD A163V improved activity. ".repeat(8),
                    hasEOL: true,
                  },
                ],
              }),
            }),
            getMetadata: async () => ({ info: { Title: "EctD activity" } }),
            destroy: async () => {},
          }),
        };
      },
    },
    api: {},
  });
  await literature.scan();
  const workspaceTree = await manager.scanDirectoryTree();
  const paper = literature.documents.find((item) => item.isLiteraturePaper);
  const service = new ProjectContextService({ workspace: manager, literature });
  const context = await service.buildContext({
    question: "Do published EctD A163V activity findings agree with our experiment results?",
    selectedPaths: [
      "literature/ectd.pdf",
      "experiments/strain-engineering/ectd.csv",
    ],
    selectedPaperIds: [paper.id],
    workspaceTree,
  });

  const published = context.files.find((item) => item.sourceId === paper.id);
  const internal = context.files.find(
    (item) => item.evidenceType === "structured-experiment-records"
  );
  assert.match(published.content, /Original-paper evidence/);
  assert.match(internal.content, /Internal experimental evidence/);
  assert.match(internal.content, /"activity":"4.8"/);
  assert.deepEqual(context.experiments.relevantExperimentIds, [internal.sourceId]);
});

test("Side Chat uses selected paper IDs, preserves comparison coverage, and auto-matches Paper Cards", async () => {
  const { manager } = await makeInitializedWorkspace();
  for (const filename of ["paper-a.pdf", "paper-b.pdf", "paper-c.pdf"]) {
    await manager.writeFile(`literature/${filename}`, new Blob([`%PDF-${filename}`]));
  }
  const cards = {
    "paper-a.pdf": {
      title: "Fermentation oxygen transfer study",
      shortSummary: "This paper studies oxygen transfer during fermentation.",
      summary: "Fermentation evidence.",
      methods: ["Bioreactor monitoring"],
      organisms: ["Escherichia coli"],
      keywords: ["fermentation", "oxygen transfer"],
      topics: ["bioprocessing"],
    },
    "paper-b.pdf": {
      title: "Engineering the EctD A163V variant",
      shortSummary: "The A163V mutation changes EctD catalytic activity.",
      summary: "EctD enzyme-engineering evidence.",
      researchQuestion: "How does A163V affect EctD activity?",
      mainFindings: ["A163V increased catalytic activity"],
      methods: ["HPLC", "enzyme kinetics"],
      organisms: ["Escherichia coli"],
      genes: ["ectD"],
      proteins: ["EctD"],
      metabolites: ["ectoine", "hydroxyectoine"],
      measurements: ["kcat", "Km"],
      importantResults: ["A163V increased kcat"],
      keywords: ["A163V", "EctD", "kcat"],
      topics: ["enzyme engineering"],
    },
    "paper-c.pdf": {
      title: "Hydroxyectoine transport analysis",
      shortSummary: "This paper examines hydroxyectoine transport.",
      summary: "Transport evidence.",
      methods: ["Transport assay"],
      metabolites: ["hydroxyectoine"],
      keywords: ["transport"],
      topics: ["membrane transport"],
    },
  };
  const pdfjsLib = {
    getDocument({ data }) {
      const raw = new TextDecoder().decode(data);
      const extractedText = raw.includes("paper-b.pdf")
        ? "The A163V EctD variant had an exact kcat of 12.4 s-1 and Km of 0.8 mM measured by HPLC. ".repeat(12)
        : "Machine-readable paper evidence. ".repeat(40);
      return {
        promise: Promise.resolve({
          numPages: 1,
          getPage: async () => ({
            getTextContent: async () => ({
              items: [{ str: extractedText, hasEOL: true }],
            }),
          }),
          getMetadata: async () => ({ info: {} }),
          destroy: async () => {},
        }),
      };
    },
  };
  const synthesisCalls = [];
  const operationOrder = [];
  const literature = new LiteratureModule({
    workspace: manager,
    pdfjsLib,
    api: {
      summarizeChunk: async () => ({
        summary: "Chunk evidence",
        researchQuestion: null,
        methods: null,
        keyResults: [],
        limitations: [],
        mainConclusion: null,
      }),
      synthesize: async ({ filename }) => {
        synthesisCalls.push(filename);
        operationOrder.push(`paper-card:${filename}`);
        return {
          ...cards[filename],
          keyResults: cards[filename].mainFindings || [],
          limitations: [],
          mainConclusion: null,
        };
      },
    },
  });
  await literature.scan();
  const ids = Object.fromEntries(
    literature.documents.map((document) => [document.filename, document.id])
  );
  const detailReads = [];
  literature.extractText = async (paperId) => {
    detailReads.push(paperId);
    return {
      text:
        paperId === ids["paper-b.pdf"]
          ? "The A163V EctD variant had an exact kcat of 12.4 s-1 and Km of 0.8 mM measured by HPLC."
          : "Other source detail.",
    };
  };
  const workspaceTree = await manager.scanDirectoryTree();
  const service = new ProjectContextService({ workspace: manager, literature });
  const originalMatchPapers = service.matchPapers.bind(service);
  service.matchPapers = async (...args) => {
    operationOrder.push("match-papers");
    return originalMatchPapers(...args);
  };
  manager.state.memory.projectSummary = "Saved EctD project memory.";

  const routerPayloads = [];
  literature.api.routeContext = async (payload) => {
    routerPayloads.push(payload);
    return {
      useLiterature: false,
      paperIds: [],
      useProjectMemory: false,
      memoryIds: [],
      reason: "This is a general concept question.",
    };
  };
  const genericConcept = await service.buildContext({
    question: "What does kcat mean?",
    selectedPaths: [],
    selectedPaperIds: [],
    workspaceTree,
    enableContextRouter: true,
  });
  assert.equal(genericConcept.routing.mode, "llm");
  assert.equal(genericConcept.routing.useLiterature, false);
  assert.deepEqual(genericConcept.files, []);
  assert.equal(genericConcept.project.projectSummary, "");
  assert.deepEqual(synthesisCalls, []);
  assert.ok(routerPayloads[0].literatureIndex.every((item) => item.status === "pending"));

  literature.api.routeContext = async () => ({
    useLiterature: false,
    paperIds: [],
    useProjectMemory: true,
    memoryIds: ["project_summary"],
    reason: "The user asks about saved project state.",
  });
  const memoryRouted = await service.buildContext({
    question: "What was our saved project summary?",
    selectedPaths: [],
    selectedPaperIds: [],
    workspaceTree,
    enableContextRouter: true,
  });
  assert.equal(memoryRouted.routing.useProjectMemory, true);
  assert.equal(memoryRouted.project.projectSummary, "Saved EctD project memory.");
  assert.deepEqual(memoryRouted.files, []);
  assert.deepEqual(synthesisCalls, []);
  delete literature.api.routeContext;

  const idle = await service.buildContext({
    question: "Change the interface language to Chinese.",
    selectedPaths: [],
    selectedPaperIds: [],
    workspaceTree,
  });
  assert.equal(idle.literature.discoveryMode, "not-needed");
  assert.deepEqual(idle.files, []);
  assert.deepEqual(synthesisCalls, []);
  assert.ok(
    literature.documents.every((document) => document.paperCardStatus === "pending")
  );
  const camelCaseUiQuestion = await service.buildContext({
    question: "How does sideChat work?",
    selectedPaths: [],
    selectedPaperIds: [],
    workspaceTree,
  });
  assert.equal(camelCaseUiQuestion.literature.discoveryMode, "not-needed");
  assert.deepEqual(synthesisCalls, []);

  operationOrder.length = 0;
  const selectedA = await service.buildContext({
    question: "Summarize the selected paper.",
    selectedPaths: ["literature/paper-a.pdf"],
    selectedPaperIds: [ids["paper-a.pdf"]],
    workspaceTree,
  });
  assert.equal(selectedA.literature.discoveryMode, "selected");
  assert.deepEqual(selectedA.literature.relevantPaperIds, [ids["paper-a.pdf"]]);
  assert.deepEqual(selectedA.files.map((file) => file.paperId), [ids["paper-a.pdf"]]);
  assert.deepEqual(synthesisCalls, ["paper-a.pdf"]);
  assert.deepEqual(operationOrder.slice(0, 2), [
    "match-papers",
    "paper-card:paper-a.pdf",
  ]);

  operationOrder.length = 0;
  const selectedAWithCard = await service.buildContext({
    question: "Summarize the selected paper again.",
    selectedPaths: ["literature/paper-a.pdf"],
    selectedPaperIds: [ids["paper-a.pdf"]],
    workspaceTree,
  });
  assert.deepEqual(selectedAWithCard.literature.relevantPaperIds, [
    ids["paper-a.pdf"],
  ]);
  assert.deepEqual(synthesisCalls, ["paper-a.pdf"]);
  assert.equal(operationOrder[0], "match-papers");
  assert.equal(
    operationOrder.some((operation) => operation.startsWith("paper-card:")),
    false
  );

  const selectedButUnrelated = await service.buildContext({
    question: "Change the interface language to Chinese.",
    selectedPaths: ["literature/paper-a.pdf"],
    selectedPaperIds: [ids["paper-a.pdf"]],
    workspaceTree,
  });
  assert.deepEqual(selectedButUnrelated.literature.selectedPaperIds, [
    ids["paper-a.pdf"],
  ]);
  assert.equal(selectedButUnrelated.literature.discoveryMode, "not-needed");
  assert.deepEqual(selectedButUnrelated.files, []);
  assert.deepEqual(synthesisCalls, ["paper-a.pdf"]);
  detailReads.length = 0;

  // Explicitly warm reusable semantic cards for automatic catalog matching.
  // Automatic routing itself must not generate cards for the whole library.
  await literature.createPaperCard(ids["paper-b.pdf"]);
  await literature.createPaperCard(ids["paper-c.pdf"]);

  const automatic = await service.buildContext({
    question: "What exact kcat was reported for the A163V EctD variant?",
    selectedPaths: [],
    selectedPaperIds: [],
    workspaceTree,
  });
  assert.equal(automatic.literature.discoveryMode, "automatic");
  assert.deepEqual(automatic.literature.relevantPaperIds, [ids["paper-b.pdf"]]);
  assert.deepEqual(automatic.files.map((file) => file.paperId), [ids["paper-b.pdf"]]);
  assert.match(automatic.files[0].content, /12\.4 s-1/);
  assert.deepEqual(detailReads, []);
  assert.deepEqual(new Set(synthesisCalls), new Set([
    "paper-a.pdf",
    "paper-b.pdf",
    "paper-c.pdf",
  ]));
  detailReads.length = 0;

  literature.api.routeContext = async (payload) => {
    routerPayloads.push(payload);
    return {
      useLiterature: true,
      paperIds: [ids["paper-b.pdf"]],
      useProjectMemory: false,
      memoryIds: [],
      reason: "The compact index semantically matches the catalyst study.",
    };
  };
  const semanticRoute = await service.buildContext({
    question: "Which study describes the catalyst optimization strategy?",
    selectedPaths: [],
    selectedPaperIds: [],
    workspaceTree,
    enableContextRouter: true,
  });
  assert.equal(semanticRoute.routing.mode, "llm");
  assert.deepEqual(semanticRoute.literature.relevantPaperIds, [ids["paper-b.pdf"]]);
  assert.match(semanticRoute.files[0].evidenceType, /original.*evidence/);
  assert.deepEqual(detailReads, []);
  const readyRouterIndex = routerPayloads.at(-1).literatureIndex;
  assert.equal(readyRouterIndex.length, 3);
  assert.ok(readyRouterIndex.every((item) => item.paperCardAvailable));
  assert.equal(Object.hasOwn(readyRouterIndex[0], "mainFindings"), false);
  delete literature.api.routeContext;
  detailReads.length = 0;

  const filenameReference = await service.buildContext({
    question: "Summarize paper-c.pdf.",
    selectedPaths: [],
    selectedPaperIds: [],
    workspaceTree,
  });
  assert.deepEqual(filenameReference.literature.relevantPaperIds, [
    ids["paper-c.pdf"],
  ]);
  assert.match(filenameReference.files[0].content, /Original-paper evidence/);
  assert.deepEqual(detailReads, []);
  detailReads.length = 0;

  const comparison = await service.buildContext({
    question: "Compare these papers and their experimental designs.",
    selectedPaths: [
      "literature/paper-a.pdf",
      "literature/paper-b.pdf",
      "literature/paper-c.pdf",
    ],
    selectedPaperIds: [
      ids["paper-a.pdf"],
      ids["paper-b.pdf"],
      ids["paper-c.pdf"],
    ],
    workspaceTree,
  });
  assert.deepEqual(
    new Set(comparison.files.map((file) => file.paperId)),
    new Set([ids["paper-a.pdf"], ids["paper-b.pdf"], ids["paper-c.pdf"]])
  );
  assert.deepEqual(detailReads, []);
  detailReads.length = 0;

  const followUp = await service.buildContext({
    question: "What about its limitations?",
    selectedPaths: [],
    selectedPaperIds: [],
    workspaceTree,
    conversation: {
      messages: [
        {
          role: "user",
          context: {
            relevantPaperIds: [ids["paper-b.pdf"]],
            selectedPaperIds: [],
          },
        },
      ],
    },
  });
  assert.equal(followUp.literature.discoveryMode, "conversation-follow-up");
  assert.deepEqual(followUp.literature.relevantPaperIds, [ids["paper-b.pdf"]]);
  assert.deepEqual(detailReads, []);
  detailReads.length = 0;

  const unrelated = await service.buildContext({
    question: "Change the interface language to Chinese.",
    selectedPaths: [],
    selectedPaperIds: [],
    workspaceTree,
  });
  assert.equal(unrelated.literature.discoveryMode, "not-needed");
  assert.deepEqual(unrelated.literature.relevantPaperIds, []);
  assert.deepEqual(unrelated.files, []);
  assert.deepEqual(detailReads, []);

  const noMatch = await service.buildContext({
    question: "Find a paper about CRISPR-Cas9 genome editing.",
    selectedPaths: [],
    selectedPaperIds: [],
    workspaceTree,
  });
  assert.equal(noMatch.literature.retrievalRequired, false);
  assert.deepEqual(noMatch.files, []);
  assert.match(noMatch.notices.join("\n"), /No sufficiently relevant paper/);
});

test("Paper Card failure preserves source state, isolates other papers, and supports retry", async () => {
  const { manager } = await makeInitializedWorkspace();
  await manager.writeFile("literature/failure.pdf", new Blob(["%PDF-fake"]));
  await manager.writeFile("literature/success.pdf", new Blob(["%PDF-success"]));
  const pdfjsLib = {
    getDocument() {
      return {
        promise: Promise.resolve({
          numPages: 1,
          getPage: async () => ({
            getTextContent: async () => ({
              items: [{ str: "Machine-readable evidence. ".repeat(40), hasEOL: true }],
            }),
          }),
          getMetadata: async () => ({ info: {} }),
          destroy: async () => {},
        }),
      };
    },
  };
  let shouldFail = true;
  const module = new LiteratureModule({
    workspace: manager,
    pdfjsLib,
    api: {
      summarizeChunk: async ({ filename }) => {
        if (shouldFail && filename === "failure.pdf") {
          throw new Error("simulated network failure");
        }
        return {
          summary: `${filename} evidence`,
          researchQuestion: null,
          methods: null,
          keyResults: [],
          limitations: [],
          mainConclusion: null,
        };
      },
      synthesize: async ({ filename }) => ({
        title: filename,
        summary: `${filename} Paper Card`,
        shortSummary: `${filename} is available.`,
        methods: [],
        keyResults: [],
        limitations: [],
        keywords: [],
        topics: [],
      }),
    },
  });
  const firstSync = await module.syncPaperLibrary();
  const failed = firstSync.documents.find((document) => document.filename === "failure.pdf");
  const succeeded = firstSync.documents.find((document) => document.filename === "success.pdf");
  assert.equal(firstSync.failures.length, 1);
  assert.equal(failed.paperCardStatus, "failed");
  assert.match(failed.paperCardError, /simulated network failure/);
  assert.equal(await manager.fileExists(failed.paperCardPath), false);
  assert.equal(await manager.fileExists(failed.relativePath), true);
  assert.equal(succeeded.paperCardStatus, "ready");
  assert.equal(await manager.fileExists(succeeded.paperCardPath), true);

  const index = await manager.readJson(".biodesign/literature/index.json");
  assert.equal(index.documents.length, 2);
  assert.equal(
    index.documents.find((document) => document.id === failed.id).paperCardStatus,
    "failed"
  );

  module.api.routeContext = async () => ({
    useLiterature: true,
    paperIds: [failed.id],
    useProjectMemory: false,
    memoryIds: [],
    reason: "The prompt names the failed paper.",
  });
  const failedContext = await new ProjectContextService({
    workspace: manager,
    literature: module,
  }).buildContext({
    question: "Compare the failed paper with the literature library.",
    selectedPaths: [],
    selectedPaperIds: [],
    workspaceTree: await manager.scanDirectoryTree(),
    enableContextRouter: true,
  });
  assert.equal(failedContext.literature.discoveryMode, "automatic");
  assert.deepEqual(failedContext.literature.relevantPaperIds, [failed.id]);
  assert.equal(failedContext.files[0].analysisStatus, "processed");
  assert.match(failedContext.files[0].evidenceType, /original-paper-evidence/);
  delete module.api.routeContext;

  shouldFail = false;
  const retry = await module.syncPaperLibrary();
  assert.ok(retry.generatedPaperIds.includes(failed.id));
  assert.equal(module.findDocument(failed.id).paperCardStatus, "ready");
  assert.equal(await manager.fileExists(failed.paperCardPath), true);
});

test("scanned and encrypted local PDFs produce controlled parser errors", async () => {
  const file = {
    size: 10,
    arrayBuffer: async () => new ArrayBuffer(10),
  };
  const scannedParser = {
    getDocument() {
      return {
        promise: Promise.resolve({
          numPages: 1,
          getPage: async () => ({ getTextContent: async () => ({ items: [] }) }),
          getMetadata: async () => ({ info: {} }),
          destroy: async () => {},
        }),
      };
    },
  };
  await assert.rejects(
    extractLocalPdf(file, scannedParser),
    (error) => error.code === "NO_MACHINE_READABLE_TEXT" && /OCR/.test(error.message)
  );

  const encryptedParser = {
    getDocument() {
      const error = new Error("Password required");
      error.name = "PasswordException";
      return { promise: Promise.reject(error) };
    },
  };
  await assert.rejects(
    extractLocalPdf(file, encryptedParser),
    (error) => error.code === "ENCRYPTED_PDF"
  );
});

test("chunking uses bounded semantic breaks instead of arbitrary word splits", () => {
  const text = `${"Paragraph sentence one. Sentence two follows.\n\n".repeat(200)}`;
  const result = chunkLiteratureText(text, {
    chunkCharacters: 500,
    chunkOverlap: 40,
    maxExtractedCharacters: 10000,
    maxChunks: 48,
  });
  assert.ok(result.chunks.length > 1);
  assert.ok(result.chunks.every((chunk) => chunk.length <= 500));
  assert.ok(result.chunks.every((chunk) => !/^\S+\s/.test(chunk) || !chunk.startsWith("entence")));
});
