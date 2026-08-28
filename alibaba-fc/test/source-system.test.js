"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  SourceRegistry,
  SourcePreparationService,
  SourceJobManager,
  SourceResultStore,
  LiteratureTools,
  ExperimentTools,
  CorpusWorkflowService,
} = require("../../docs/source-system.js");

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function makeFile(name, content, lastModified) {
  const file = new Blob([content]);
  Object.defineProperties(file, {
    name: { value: name },
    lastModified: { value: lastModified },
  });
  return file;
}

class MemoryWorkspace {
  constructor() {
    this.files = new Map();
    this.json = new Map();
    this.readFileCalls = 0;
    this.counter = 0;
  }

  createId() {
    this.counter += 1;
    return `source-${String(this.counter).padStart(4, "0")}`;
  }

  setFile(path, content, lastModified = Date.now() - 5000) {
    this.files.set(path, makeFile(path.split("/").pop(), content, lastModified));
  }

  deleteFile(path) {
    this.files.delete(path);
  }

  async fileExists(path) {
    return this.files.has(path) || this.json.has(path);
  }

  async readFile(path) {
    this.readFileCalls += 1;
    const file = this.files.get(path);
    if (!file) throw new Error(`missing: ${path}`);
    return file;
  }

  async readJson(path) {
    if (!this.json.has(path)) throw new Error(`missing json: ${path}`);
    return clone(this.json.get(path));
  }

  async writeJson(path, value) {
    this.json.set(path, clone(value));
    return value;
  }
}

function treeFor(workspace) {
  return {
    name: "workspace",
    relativePath: "",
    type: "directory",
    children: [...workspace.files.entries()].map(([path, file]) => ({
      name: path.split("/").pop(),
      relativePath: path,
      type: "file",
      size: file.size,
      lastModified: file.lastModified,
      children: [],
    })),
  };
}

async function makeSystem(workspace, options = {}) {
  const registry = new SourceRegistry({ workspace });
  const jobs = new SourceJobManager({ workspace });
  const results = new SourceResultStore({ workspace, maxInlineCharacters: 2000 });
  let parseCalls = 0;
  const preparation = new SourcePreparationService({
    workspace,
    registry,
    jobs,
    results,
    cryptoProvider: {},
    debounceMilliseconds: 1,
    spreadsheetProvider: options.spreadsheetProvider,
    async parsePaper(input) {
      parseCalls += 1;
      if (options.parsePaper) return options.parsePaper(input);
      const text = new TextDecoder().decode(input.bytes);
      return { text: `# Page 1\n${text}`, pageCount: 1, metadataTitle: null, truncated: false };
    },
    generatePaperCard: options.generatePaperCard,
  });
  const literatureTools = new LiteratureTools({ registry, preparation, results });
  const experimentTools = new ExperimentTools({ registry, preparation, results });
  const corpusWorkflows = new CorpusWorkflowService({
    workspace,
    registry,
    preparation,
    literatureTools,
    results,
    mapWorker: options.mapWorker,
  });
  return {
    registry,
    preparation,
    literatureTools,
    experimentTools,
    corpusWorkflows,
    get parseCalls() {
      return parseCalls;
    },
  };
}

test("folder reconciliation catalogs 150 papers without full hashes, parses, or LLM calls", async () => {
  const workspace = new MemoryWorkspace();
  for (let index = 0; index < 150; index += 1) {
    workspace.setFile(`literature/paper-${index + 1}.pdf`, `paper ${index + 1}`);
  }
  const system = await makeSystem(workspace);
  const result = await system.registry.reconcile(treeFor(workspace));

  assert.equal(result.sources.length, 150);
  assert.equal(result.metrics.lastStatCalls, 150);
  assert.equal(result.metrics.fullHashCallsDuringReconciliation, 0);
  assert.equal(result.metrics.llmCallsDuringReconciliation, 0);
  assert.equal(system.preparation.metrics.fullHashCalls, 0);
  assert.equal(system.parseCalls, 0);
  assert.equal(workspace.readFileCalls, 0);
});

test("a paper is prepared lazily once and unchanged follow-ups reuse hash and text", async () => {
  const workspace = new MemoryWorkspace();
  workspace.setFile("literature/EctD-A163V.pdf", "EctD A163V increased activity and kcat.", 1000);
  const system = await makeSystem(workspace);
  await system.registry.reconcile(treeFor(workspace));
  const source = system.registry.list({ sourceKind: "paper" })[0];

  assert.equal(source.hashStatus, "absent");
  assert.equal(system.preparation.metrics.fullHashCalls, 0);
  await system.preparation.ensureSourceReady([source.sourceId], "search");
  await system.preparation.ensureSourceReady([source.sourceId], "search");

  assert.equal(system.preparation.metrics.fullHashCalls, 1);
  assert.equal(system.parseCalls, 1);
  assert.equal(system.registry.get(source.sourceId).indexStatus, "ready");
  assert.equal(system.registry.get(source.sourceId).paperCardStatus, "absent");
});

test("timestamp-only changes rehash but reuse artifacts; content changes rebuild only the source", async () => {
  const workspace = new MemoryWorkspace();
  workspace.setFile("literature/a.pdf", "stable scientific evidence", 1000);
  workspace.setFile("literature/b.pdf", "unrelated paper", 1000);
  const system = await makeSystem(workspace);
  await system.registry.reconcile(treeFor(workspace));
  const sourceA = system.registry.getByPath("literature/a.pdf");
  await system.preparation.ensureSourceReady([sourceA.sourceId], "search");

  workspace.setFile("literature/a.pdf", "stable scientific evidence", 2000);
  await system.registry.reconcile(treeFor(workspace));
  assert.equal(system.registry.get(sourceA.sourceId).catalogStatus, "dirty");
  await system.preparation.ensureSourceReady([sourceA.sourceId], "search");
  assert.equal(system.preparation.metrics.fullHashCalls, 2);
  assert.equal(system.parseCalls, 1);

  workspace.setFile("literature/a.pdf", "changed A163V evidence", 3000);
  await system.registry.reconcile(treeFor(workspace));
  await system.preparation.ensureSourceReady([sourceA.sourceId], "search");
  assert.equal(system.preparation.metrics.fullHashCalls, 3);
  assert.equal(system.parseCalls, 2);
  assert.equal(system.registry.getByPath("literature/b.pdf").hashStatus, "absent");
});

test("deletion removes a source from active selection without hashing", async () => {
  const workspace = new MemoryWorkspace();
  workspace.setFile("literature/a.pdf", "paper A", 1000);
  const system = await makeSystem(workspace);
  await system.registry.reconcile(treeFor(workspace));
  const sourceId = system.registry.getByPath("literature/a.pdf").sourceId;
  workspace.deleteFile("literature/a.pdf");
  const result = await system.registry.reconcile(treeFor(workspace));

  assert.equal(system.registry.get(sourceId), null);
  assert.equal(system.registry.get(sourceId, { includeMissing: true }).catalogStatus, "missing");
  assert.deepEqual(result.changes.missing, [sourceId]);
  assert.equal(system.preparation.metrics.fullHashCalls, 0);
});

test("concurrent requests share one source preparation job", async () => {
  const workspace = new MemoryWorkspace();
  workspace.setFile("literature/a.pdf", "paper evidence", 1000);
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const system = await makeSystem(workspace, {
    async parsePaper(input) {
      await gate;
      return {
        text: `# Page 1\n${new TextDecoder().decode(input.bytes)}`,
        pageCount: 1,
        truncated: false,
      };
    },
  });
  await system.registry.reconcile(treeFor(workspace));
  const sourceId = system.registry.list({ sourceKind: "paper" })[0].sourceId;
  const first = system.preparation.ensureSourceReady([sourceId], "search");
  const second = system.preparation.ensureSourceReady([sourceId], "search");
  release();
  await Promise.all([first, second]);

  assert.equal(system.preparation.metrics.fullHashCalls, 1);
  assert.equal(system.parseCalls, 1);
});

test("different concurrent readiness requests serialize on the same source", async () => {
  const workspace = new MemoryWorkspace();
  workspace.setFile("literature/a.pdf", "paper evidence", 1000);
  let cardCalls = 0;
  const system = await makeSystem(workspace, {
    async generatePaperCard({ source, contentHash }) {
      cardCalls += 1;
      const path = `.biodesign/literature/summaries/${source.sourceId}.json`;
      await workspace.writeJson(path, {
        paperId: source.sourceId,
        contentHash,
      });
      return { path, schemaVersion: 1, model: "test-model", promptVersion: 1 };
    },
  });
  await system.registry.reconcile(treeFor(workspace));
  const sourceId = system.registry.list({ sourceKind: "paper" })[0].sourceId;

  await Promise.all([
    system.preparation.ensureSourceReady([sourceId], "search"),
    system.preparation.ensureSourceReady([sourceId], "paper_card"),
  ]);

  assert.equal(system.preparation.metrics.fullHashCalls, 1);
  assert.equal(system.parseCalls, 1);
  assert.equal(cardCalls, 1);
  assert.equal(system.registry.get(sourceId).paperCardStatus, "ready");
});

test("a file changed during parsing rejects the artifact", async () => {
  const workspace = new MemoryWorkspace();
  workspace.setFile("literature/a.pdf", "initial", 1000);
  const system = await makeSystem(workspace, {
    async parsePaper(input) {
      workspace.setFile("literature/a.pdf", "changed while parsing", 2000);
      return {
        text: `# Page 1\n${new TextDecoder().decode(input.bytes)}`,
        pageCount: 1,
        truncated: false,
      };
    },
  });
  await system.registry.reconcile(treeFor(workspace));
  const sourceId = system.registry.list({ sourceKind: "paper" })[0].sourceId;

  await assert.rejects(
    system.preparation.ensureSourceReady([sourceId], "search"),
    (error) => error.code === "SOURCE_CHANGED_DURING_PREPARATION"
  );
  const rejected = system.registry.get(sourceId);
  assert.equal(rejected.catalogStatus, "dirty");
  assert.equal(rejected.hashStatus, "absent");
  assert.equal(rejected.indexStatus, "not_started");
  assert.equal(rejected.artifacts.paperText, undefined);
});

test("parser failures persist on the source and retry without an unnecessary rehash", async () => {
  const workspace = new MemoryWorkspace();
  workspace.setFile("literature/a.pdf", "retryable paper", 1000);
  let shouldFail = true;
  const system = await makeSystem(workspace, {
    async parsePaper(input) {
      if (shouldFail) throw new Error("parser exploded");
      return {
        text: `# Page 1\n${new TextDecoder().decode(input.bytes)}`,
        pageCount: 1,
        truncated: false,
      };
    },
  });
  await system.registry.reconcile(treeFor(workspace));
  const sourceId = system.registry.list({ sourceKind: "paper" })[0].sourceId;

  await assert.rejects(
    system.preparation.ensureSourceReady([sourceId], "search"),
    /parser exploded/
  );
  const failed = system.registry.get(sourceId);
  assert.equal(failed.hashStatus, "ready");
  assert.equal(failed.parseStatus, "failed");
  assert.equal(failed.indexStatus, "failed");
  assert.match(failed.error.message, /parser exploded/);

  shouldFail = false;
  await system.preparation.ensureSourceReady([sourceId], "search");
  assert.equal(system.preparation.metrics.fullHashCalls, 1);
  assert.equal(system.parseCalls, 2);
  assert.equal(system.registry.get(sourceId).indexStatus, "ready");
});

test("experiment CSV values are normalized lazily with provenance and replaced on change", async () => {
  const workspace = new MemoryWorkspace();
  workspace.setFile(
    "experiments/strain-engineering/run.csv",
    "protein,mutation,activity,unit\nEctD,A163V,4.8,U/mg\nEctD,WT,3.1,U/mg",
    1000
  );
  const system = await makeSystem(workspace);
  await system.registry.reconcile(treeFor(workspace));
  const source = system.registry.list({ sourceKind: "experiment" })[0];
  assert.equal(source.structuredDataStatus, "not_started");

  const first = await system.experimentTools.queryExperimentResults({
    experimentSourceIds: [source.sourceId],
    mutations: ["A163V"],
  });
  assert.equal(first.length, 1);
  assert.equal(first[0].raw.activity, "4.8");
  assert.equal(first[0].provenance.sourceFile, source.path);
  assert.equal(first[0].provenance.sourceRange, "A2:D2");
  const comparison = await system.experimentTools.compareExperimentGroups(
    { experimentSourceIds: [source.sourceId], mutations: ["A163V"] },
    { experimentSourceIds: [source.sourceId], mutations: ["WT"] },
    "activity"
  );
  assert.equal(comparison.groupA.value, 4.8);
  assert.equal(comparison.groupB.value, 3.1);
  const range = await system.experimentTools.readExperimentSource(source.sourceId, {
    range: "A1:C2",
  });
  assert.deepEqual(range[0].rows, [
    ["protein", "mutation", "activity"],
    ["EctD", "A163V", "4.8"],
  ]);

  workspace.setFile(
    source.path,
    "protein,mutation,activity,unit\nEctD,A163V,5.2,U/mg",
    2000
  );
  await system.registry.reconcile(treeFor(workspace));
  const second = await system.experimentTools.queryExperimentResults({
    experimentSourceIds: [source.sourceId],
    mutations: ["A163V"],
  });
  assert.equal(second.length, 1);
  assert.equal(second[0].raw.activity, "5.2");
  assert.equal(system.preparation.metrics.experimentParseCalls, 2);
});

test("paper tools preserve explicit scope and exact biological identifiers", async () => {
  const workspace = new MemoryWorkspace();
  workspace.setFile("literature/a.pdf", "EctD A163V kcat improved.", 1000);
  workspace.setFile("literature/b.pdf", "Unrelated enzyme result.", 1000);
  const system = await makeSystem(workspace);
  await system.registry.reconcile(treeFor(workspace));
  const a = system.registry.getByPath("literature/a.pdf");
  const b = system.registry.getByPath("literature/b.pdf");
  await system.preparation.ensureSourceReady([a.sourceId, b.sourceId], "search");
  const result = await system.literatureTools.searchPapers("EctD A163V kcat", {
    paperIds: [a.sourceId],
  });

  assert.deepEqual(result.results.map((item) => item.paperId), [a.sourceId]);
  assert.deepEqual(result.coverage.papersActuallyConsidered, [a.sourceId]);
});

test("automatic paper search inspects ready content and cheap candidate metadata only", async () => {
  const workspace = new MemoryWorkspace();
  workspace.setFile("literature/ready.pdf", "EctD activity evidence.", 1000);
  workspace.setFile("literature/EctD-candidate.pdf", "candidate evidence", 1000);
  workspace.setFile("literature/unrelated.pdf", "unrelated evidence", 1000);
  const system = await makeSystem(workspace);
  await system.registry.reconcile(treeFor(workspace));
  const ready = system.registry.getByPath("literature/ready.pdf");
  const candidate = system.registry.getByPath("literature/EctD-candidate.pdf");
  const unrelated = system.registry.getByPath("literature/unrelated.pdf");
  await system.preparation.ensureSourceReady([ready.sourceId], "search");

  const search = await system.literatureTools.searchPapers("EctD", { topK: 10 });
  assert.equal(
    search.results.find((item) => item.paperId === ready.sourceId).searchable,
    true
  );
  assert.equal(
    search.results.find((item) => item.paperId === candidate.sourceId).searchable,
    false
  );
  assert.equal(system.registry.get(candidate.sourceId).hashStatus, "absent");
  assert.equal(system.registry.get(unrelated.sourceId).hashStatus, "absent");

  await system.literatureTools.searchPaperContent(candidate.sourceId, "EctD");
  assert.equal(system.registry.get(candidate.sourceId).indexStatus, "ready");
  assert.equal(system.registry.get(unrelated.sourceId).hashStatus, "absent");
});

test("large tool results persist outside active context and reopen exactly", async () => {
  const workspace = new MemoryWorkspace();
  const store = new SourceResultStore({ workspace, maxInlineCharacters: 120 });
  const value = Array.from({ length: 20 }, (_, index) => ({
    index,
    evidence: `evidence-${index}-${"x".repeat(40)}`,
  }));

  const compact = await store.compact(value, { tool: "test-large-result" });
  assert.equal(typeof compact.resultHandle, "string");
  assert.equal(compact.preview.length, 5);
  assert.match(compact.notice, /stored outside active context/);
  assert.deepEqual(await store.read(compact.resultHandle), value);
});

test("corpus workflow journals progress and resumes unchanged per-paper maps", async () => {
  const workspace = new MemoryWorkspace();
  workspace.setFile("literature/a.pdf", "EctD activity finding A.", 1000);
  workspace.setFile("literature/b.pdf", "EctD activity finding B.", 1000);
  const system = await makeSystem(workspace);
  await system.registry.reconcile(treeFor(workspace));
  const first = await system.corpusWorkflows.run("Summarize all papers about EctD activity.");
  const firstJournal = first.resultHandle
    ? await system.preparation.results.read(first.resultHandle)
    : first;
  const parseCalls = system.parseCalls;
  const second = await system.corpusWorkflows.run("Summarize all papers about EctD activity.");
  const secondJournal = second.resultHandle
    ? await system.preparation.results.read(second.resultHandle)
    : second;

  assert.equal(firstJournal.status, "completed");
  assert.equal(Object.keys(firstJournal.maps).length, 2);
  assert.equal(secondJournal.status, "completed");
  assert.equal(system.parseCalls, parseCalls);
  assert.equal(firstJournal.cacheKey, secondJournal.cacheKey);
});

test("corpus membership changes stale the old synthesis and reuse unchanged maps", async () => {
  const workspace = new MemoryWorkspace();
  workspace.setFile("literature/a.pdf", "EctD finding A.", 1000);
  workspace.setFile("literature/b.pdf", "EctD finding B.", 1000);
  const system = await makeSystem(workspace);
  await system.registry.reconcile(treeFor(workspace));
  const question = "Summarize all papers about EctD.";
  const first = await system.corpusWorkflows.run(question);
  const firstJournal = first.resultHandle
    ? await system.preparation.results.read(first.resultHandle)
    : first;
  const parseCalls = system.parseCalls;

  workspace.setFile("literature/c.pdf", "EctD finding C.", 1000);
  await system.registry.reconcile(treeFor(workspace));
  const second = await system.corpusWorkflows.run(question);
  const secondJournal = second.resultHandle
    ? await system.preparation.results.read(second.resultHandle)
    : second;
  const staleJournal = await workspace.readJson(
    `.biodesign/workflows/${firstJournal.workflowId}.json`
  );

  assert.equal(staleJournal.status, "stale");
  assert.equal(staleJournal.staleReason, "corpus_membership_changed");
  assert.equal(Object.keys(secondJournal.maps).length, 3);
  assert.equal(system.parseCalls, parseCalls + 1);
});

test("an interrupted corpus map resumes without rerunning completed paper maps", async () => {
  const workspace = new MemoryWorkspace();
  workspace.setFile("literature/a.pdf", "EctD finding A.", 1000);
  workspace.setFile("literature/b.pdf", "EctD finding B.", 1000);
  let interruptPaperId = null;
  const mapCalls = new Map();
  const system = await makeSystem(workspace, {
    async mapWorker(input) {
      mapCalls.set(input.paperId, (mapCalls.get(input.paperId) || 0) + 1);
      if (input.paperId === interruptPaperId) {
        const error = new Error("interrupted");
        error.code = "OPERATION_ABORTED";
        throw error;
      }
      return {
        relevance: "high",
        themes: ["EctD"],
        findings: input.evidence.slice(0, 1).map((item) => ({
          claim: item.claimCandidate,
          evidenceRefs: [item.evidenceRef],
        })),
        methods: [],
        limitations: [],
      };
    },
  });
  await system.registry.reconcile(treeFor(workspace));
  const paperIds = system.registry.list({ sourceKind: "paper" }).map((item) => item.sourceId);
  interruptPaperId = paperIds[1];
  const question = "Summarize all EctD papers.";

  await assert.rejects(
    system.corpusWorkflows.run(question, { concurrency: 1 }),
    (error) => error.code === "OPERATION_ABORTED"
  );
  interruptPaperId = null;
  const resumed = await system.corpusWorkflows.run(question, { concurrency: 1 });
  const journal = resumed.resultHandle
    ? await system.preparation.results.read(resumed.resultHandle)
    : resumed;

  assert.equal(journal.status, "completed");
  assert.equal(mapCalls.get(paperIds[0]), 1);
  assert.equal(mapCalls.get(paperIds[1]), 2);
});
