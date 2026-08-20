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
});

test("literature scan preserves IDs across refresh and marks changed PDFs stale", async () => {
  const { manager } = await makeInitializedWorkspace();
  await manager.writeFile("literature/paper-a.pdf", new Blob(["first pdf"]));
  const module = new LiteratureModule({
    workspace: manager,
    api: {},
    pdfjsLib: {},
  });
  const firstScan = await module.scan();
  assert.equal(firstScan.length, 1);
  const documentId = firstScan[0].id;

  const summary = {
    schemaVersion: 1,
    documentId,
    generatedAt: "2026-08-20T05:00:00.000Z",
    source: {
      filename: "paper-a.pdf",
      size: firstScan[0].size,
      lastModified: firstScan[0].lastModified,
    },
    model: "test-model",
    title: "Paper A",
    summary: "Summary A",
    researchQuestion: null,
    methods: null,
    keyResults: [],
    limitations: [],
    mainConclusion: null,
    keywords: [],
  };
  await manager.writeJson(firstScan[0].summaryPath, summary);
  const unchanged = await module.scan();
  assert.equal(unchanged[0].id, documentId);
  assert.equal(unchanged[0].summaryAvailable, true);
  assert.equal(unchanged[0].status, "ready");

  const literatureDirectory = await manager.getDirectory("literature");
  const renamedHandle = await literatureDirectory.getFileHandle("paper-a.pdf");
  literatureDirectory.children.delete("paper-a.pdf");
  renamedHandle.name = "renamed-paper.pdf";
  literatureDirectory.children.set("renamed-paper.pdf", renamedHandle);
  const renamed = await module.scan();
  assert.equal(renamed[0].id, documentId);
  assert.equal(renamed[0].filename, "renamed-paper.pdf");
  assert.equal(renamed[0].status, "ready");

  await manager.writeFile("literature/renamed-paper.pdf", new Blob(["changed pdf content"]));
  const changed = await module.scan();
  assert.equal(changed[0].id, documentId);
  assert.equal(changed[0].status, "stale");
  assert.equal(changed[0].summaryStale, true);

  await manager.removeFile("literature/renamed-paper.pdf");
  const removed = await module.scan();
  assert.deepEqual(removed, []);
  assert.equal(await manager.fileExists(firstScan[0].summaryPath), true);
});

test("adding a duplicate PDF creates a clear unique filename", async () => {
  const { manager } = await makeInitializedWorkspace();
  const module = new LiteratureModule({ workspace: manager, api: {}, pdfjsLib: {} });
  const file = new Blob(["pdf bytes"], { type: "application/pdf" });
  Object.defineProperty(file, "name", { value: "paper.pdf" });
  await module.addFiles([file]);
  const result = await module.addFiles([file]);
  assert.deepEqual(result.addedNames, ["paper (2).pdf"]);
  assert.deepEqual(
    result.documents.map((document) => document.filename),
    ["paper (2).pdf", "paper.pdf"]
  );
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

test("an LLM failure leaves the literature index valid and writes no summary", async () => {
  const { manager } = await makeInitializedWorkspace();
  await manager.writeFile("literature/failure.pdf", new Blob(["%PDF-fake"]));
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
  const module = new LiteratureModule({
    workspace: manager,
    pdfjsLib,
    api: {
      summarizeChunk: async () => {
        throw new Error("simulated network failure");
      },
    },
  });
  const [document] = await module.scan();
  await assert.rejects(module.summarize(document.id), /simulated network failure/);
  assert.equal(await manager.fileExists(document.summaryPath), false);
  const index = await manager.readJson(".biodesign/literature/index.json");
  assert.equal(index.documents.length, 1);
  assert.equal(index.documents[0].id, document.id);
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
