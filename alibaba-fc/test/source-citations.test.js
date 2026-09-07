const assert = require("node:assert/strict");
const test = require("node:test");
const citations = require("../../shared/source-citations.js");
const agent = require("../side-chat-agent.js");
const { sanitizeLocalWorkspaceContext } = require("../index.js")._test;
const { ProjectContextService, normalizeStoredConversation } = require("../../docs/project-context-service.js");

function fixture() {
  const sources = [
    { sourceId: "paper-a", path: "literature/subfolder/paper.pdf" },
    { sourceId: "paper-b", path: "literature/另一文件夹/paper.pdf" },
    { sourceId: "paper-c", path: "literature/中文/酶活性研究.pdf" },
  ].map(source => ({ ...source, sourceKind: "paper", contentHash: `hash-${source.sourceId}`, catalogStatus: "ready" }));
  return {
    project: { workspaceName: "Project Folder", absoluteRoot: "/private/root/must-not-leave" },
    inventory: sources.map(source => ({ ...source, paperId: source.sourceId, relativePath: source.path, name: source.path.split("/").at(-1), extension: "pdf" })),
    sourceMap: { paperSources: sources },
    citationEvidence: [{ sourceId: "paper-a", reference: "paper-a:p5:chunk-9", page: 5, contentHash: "hash-paper-a" }],
    files: [{ paperId: "paper-a", relativePath: sources[0].path, evidenceType: "paper-card", content: "Evidence paper-a:p5:chunk-9; alleged paper-a:p99:invented" }],
  };
}
function registry(context = fixture()) {
  return agent.buildSourceCitationRegistry(agent.createSideChatKnowledgeBase({ localWorkspaceContext: sanitizeLocalWorkspaceContext(context) }));
}

test("registered local aliases resolve duplicate, nested, and Chinese filenames without losing identity", () => {
  const result = citations.resolveAnswer("One [local:1]; two [[cite:local:2]]; 三 [paper-c].", registry());
  assert.equal(result.citations.length, 3);
  assert.deepEqual(result.citations.map(c => c.relativePath), fixture().sourceMap.paperSources.map(s => s.path));
  assert.match(result.reply, /Project Folder \/ literature \/ subfolder \/ paper.pdf/);
  assert.match(result.reply, /Project Folder \/ literature \/ 中文 \/ 酶活性研究.pdf/);
  assert.doesNotMatch(result.reply, /local:\d|private\/root/);
  assert.equal(result.citations[1].reference, "local:2");
});

test("only a registered current parsed-artifact handle establishes a page", () => {
  const result = citations.resolveAnswer("[local:1] [[cite:paper-a:p5:chunk-9]] [[cite:paper-a:p99:invented]]", registry());
  assert.equal(result.citations[0].page, null);
  assert.equal(result.citations[1].page, 5);
  assert.equal(result.citations[1].reference, "paper-a:p5:chunk-9");
  assert.equal(result.citations[2].status, "missing");
  assert.equal(result.citations[2].page, null);
  assert.match(result.reply, /p\. 5/);
  assert.doesNotMatch(result.reply, /p\. 99/);
  const context = fixture(); context.citationEvidence[0].contentHash = "stale";
  assert.equal(citations.resolveAnswer("[[cite:paper-a:p5:chunk-9]]", registry(context)).citations[0].status, "missing");
});

test("missing, stale, and ambiguous references are explicit and cannot be navigated", () => {
  const context = fixture(); context.sourceMap.paperSources[0].catalogStatus = "missing";
  const result = citations.resolveAnswer("[local:1] [local:999]", registry(context));
  assert.equal(result.citations[0].status, "stale");
  assert.equal(result.citations[1].status, "missing");
  assert.match(result.reply, /source unavailable or changed/);
  const ambiguous = citations.createRegistry([
    { sourceId: "a", relativePath: "literature/a.pdf", aliases: ["local:1"] },
    { sourceId: "b", relativePath: "literature/b.pdf", aliases: ["local:1"] },
  ]);
  assert.equal(citations.resolveAnswer("[local:1]", ambiguous).citations[0].status, "ambiguous");
});

test("citation resolution preserves ordinary IDs, code, links, and exact tool handles", () => {
  const protectedText = [
    "A variable named local:1.", "`[local:1]` and ``[[cite:paper-a]]``",
    "[local:1](https://example.com)", "    [local:1]", "\t[[cite:paper-a]]",
    "```js", "[local:1]", "``` not a closing fence", "[[cite:paper-a]]", "```",
    "~~~", "[local:1]", "~~~",
  ].join("\n");
  assert.equal(citations.resolveAnswer(protectedText, registry()).reply, protectedText);
  assert.equal(citations.resolveAnswer(protectedText, registry()).citations.length, 0);
});

test("experimental record IDs resolve verified workbook, sheet, and cell range", () => {
  const context = fixture();
  const file = "experiments/发酵/结果.xlsx";
  context.inventory.push({ sourceId: "exp-a", sourceKind: "experiment", relativePath: file, name: "结果.xlsx", extension: "xlsx" });
  context.files.push({ sourceId: "exp-a", relativePath: file, evidenceType: "structured-experiment-records", content: "Rows:\n" + JSON.stringify([
    { experimentId: "exp-a-R1", sourceId: "exp-a", provenance: { sourceFile: file, sourceSheet: "实验结果", row: 7, sourceRange: "A7:F7" } },
    { experimentId: "exp-a-R2", sourceId: "exp-a", provenance: { sourceFile: "experiments/different.xlsx", row: 99 } },
  ]) });
  const result = citations.resolveAnswer("[[cite:exp-a-R1]] [[cite:exp-a-R2]]", registry(context));
  assert.equal(result.citations[0].relativePath, file);
  assert.equal(result.citations[0].row, 7);
  assert.match(result.reply, /实验结果 — A7:F7/);
  assert.equal(result.citations[1].status, "missing");
});

test("navigation requires the same workspace, registered ID, current path/hash, and actual tree file", () => {
  const source = fixture().sourceMap.paperSources[0];
  const context = { workspaceId: "workspace-1", workspaceName: "Project Folder", getSource: id => id === source.sourceId ? source : null, files: [{ type: "file", relativePath: source.path }] };
  const [citation] = citations.bindToWorkspace(citations.resolveAnswer("[local:1]", registry()).citations, context);
  assert.deepEqual(citations.navigationTarget(citation, context), { relativePath: source.path, ancestors: ["", "literature", "literature/subfolder"] });
  for (const invalid of [{ workspaceId: "workspace-2" }, { getSource: () => null }, { files: [] }, { getSource: () => ({ ...source, contentHash: "changed" }) }, { getSource: () => ({ ...source, catalogStatus: "missing" }) }]) {
    assert.equal(citations.navigationTarget(citation, { ...context, ...invalid }), null);
  }
  for (const path of ["/etc/passwd", "../outside", "literature/../../outside", "C:\\outside", "file:///outside", "literature//a.pdf", "literature/./a.pdf", "literature/a\u0000.pdf"]) {
    assert.equal(citations.relativePath(path), null);
    assert.equal(citations.navigationTarget({ ...citation, relativePath: path }, { ...context, getSource: () => ({ ...source, path }), files: [{ type: "file", relativePath: path }] }), null);
  }
});

test("saved citations retain the original identity when local aliases change next turn", () => {
  const context = { workspaceId: "w", workspaceName: "Project Folder", getSource: id => fixture().sourceMap.paperSources.find(s => s.sourceId === id) };
  const resolved = citations.resolveAnswer("[local:1]", registry());
  const stored = normalizeStoredConversation({ id: "chat-a", messages: [{ id: "answer", role: "assistant", content: resolved.reply, citations: citations.bindToWorkspace(resolved.citations, context), createdAt: new Date().toISOString() }] });
  const next = fixture(); next.inventory.reverse();
  assert.equal(citations.resolveAnswer("[local:1]", registry(next)).citations[0].sourceId, "paper-c");
  assert.equal(stored.messages[0].citations[0].sourceId, "paper-a");
  assert.equal(stored.messages[0].citations[0].workspaceId, "w");
});

test("host page ledger checks parsed chunks and hashes, never trusting Paper Card prose", async () => {
  const source = fixture().sourceMap.paperSources[0];
  const artifact = { contentHash: source.contentHash, chunks: [{ chunkId: "chunk-9", page: 5 }] };
  const service = new ProjectContextService({ workspace: {}, sourceSystem: { registry: { get: () => source } }, literature: { preparation: { readPaperArtifact: async () => artifact } } });
  assert.deepEqual(await service.buildCitationEvidence(fixture()), fixture().citationEvidence);
  artifact.contentHash = "stale";
  assert.deepEqual(await service.buildCitationEvidence(fixture()), []);
});

test("agent final response resolves citations deterministically while tool catalog IDs stay internal", async () => {
  let catalog;
  const result = await agent.runSideChatAgent({
    surface: "side_chat", conversationMessages: [{ role: "user", content: "Read evidence" }],
    workspaceContext: { localWorkspaceContext: sanitizeLocalWorkspaceContext(fixture()) },
    systemPrompt: "Answer with evidence", parseFinalAnswer: content => ({ reply: content }),
    requestTurn: async ({ messages }) => { catalog = JSON.stringify(messages); return { ok: true, message: { content: "Result [local:1] [[cite:paper-a:p5:chunk-9]]" } }; },
  });
  assert.equal(result.ok, true);
  assert.match(catalog, /local:1/);
  assert.equal(result.data.citations[1].reference, "paper-a:p5:chunk-9");
  assert.match(result.data.reply, /Project Folder \/ literature \/ subfolder \/ paper.pdf — p\. 5/);
  assert.doesNotMatch(catalog, /private\/root/);
});

test("absolute metadata paths and out-of-scope source IDs cannot acquire a source identity", () => {
  const context = fixture();
  context.sourceMap.paperSources[0].path = "/outside/paper.pdf";
  assert.equal(citations.resolveAnswer("[local:1]", registry(context)).citations[0].status, "missing");
  const scoped = fixture(); scoped.sourceMap.selectedPaperIds = ["paper-b"];
  const result = citations.resolveAnswer("[local:1] [local:2]", registry(scoped));
  assert.equal(result.citations[0].status, "missing");
  assert.equal(result.citations[1].sourceId, "paper-b");
});

test("experimental evidence hashes survive citation binding and identify changed workbooks", () => {
  const reference = "experiment-a-R1";
  const registry = citations.createRegistry([{ sourceId: "experiment-a", relativePath: "experiments/run.xlsx", evidence: [{ reference, sheet: "Results", row: 7, contentHash: "original-hash" }] }]);
  const result = citations.resolveAnswer(`[[cite:${reference}]]`, registry);
  assert.equal(result.citations[0].contentHash, "original-hash");
  const bound = citations.bindToWorkspace(result.citations, { workspaceId: "w", getSource: () => ({ path: "experiments/run.xlsx", contentHash: "changed-hash" }) });
  assert.equal(bound[0].status, "missing");
});

test("model-supplied citation metadata is discarded even when no citation token resolves", () => {
  const kb = agent.createSideChatKnowledgeBase({ localWorkspaceContext: sanitizeLocalWorkspaceContext(fixture()) });
  const result = agent.resolveSideChatAnswerCitations({ reply: "Answer", citations: [{ id: "citation-1", relativePath: "/outside", page: 999, status: "resolved" }] }, kb, "side_chat");
  assert.deepEqual(result, { reply: "Answer" });
});

test("grouped and single cite markers resolve without leaking IDs or extra brackets", () => {
  const ids = ["e7b79259-c640-49f4-ba04-a9e77ba78f08", "e9355bd2-a1b4-4d7d-af44-4dbe08f74550"];
  const sources = citations.createRegistry(ids.map((sourceId, i) => ({ sourceId, relativePath: `literature/paper-${i}.pdf` })));
  for (const input of [`[[cite:${ids[0]}], [cite:${ids[1]}]]`, `[cite:${ids[0]}], [cite:${ids[1]}]`, `[[cite:${ids.join(", ")}]]`]) {
    const result = citations.resolveAnswer(`合成途径 ${input}。`, sources);
    assert.deepEqual(result.citations.map(entry => entry.sourceId), ids);
    assert.doesNotMatch(result.reply, /\[\[|cite:|e7b79259|e9355bd2|\)\]/);
    assert.equal((result.reply.match(/biodesign-citation:/g) || []).length, 2);
  }
  const missing = citations.resolveAnswer("[[cite:unknown-a], [cite:unknown-b]]", sources);
  assert.ok(missing.citations.every(entry => entry.status === "missing"));
  assert.doesNotMatch(missing.reply, /unknown-|cite:/);
  const protectedText = "`[[cite:paper-a], [cite:paper-b]]` [Label [cite:paper-a]](https://example.com)";
  assert.equal(citations.resolveAnswer(protectedText, registry()).reply, protectedText);
});

test("saved mixed replies repair stable IDs without changing saved identities or colliding with existing links", () => {
  const sources = fixture().sourceMap.paperSources;
  const context = { workspaceId: "w", workspaceName: "Project Folder", getSource: id => sources.find(source => source.sourceId === id), files: sources.map(source => ({ type: "file", relativePath: source.path })) };
  const saved = citations.bindToWorkspace(citations.resolveAnswer("[local:1]", registry()).citations, context);
  const reply = "[Existing](biodesign-citation:citation-1) [Unregistered](biodesign-citation:citation-2) [[cite:paper-b], [cite:paper-a]] [local:999] [[cite:paper-b:p99:invented]]";
  const result = citations.resolveForDisplay(reply, saved, context);
  assert.deepEqual(result.citations[0], saved[0]);
  assert.equal(result.citations[1].id, "citation-3");
  assert.equal(result.citations[1].sourceId, "paper-b");
  assert.ok(citations.navigationTarget(result.citations[1], context));
  assert.ok(!result.citations.some(entry => entry.id === "citation-2"));
  assert.ok(result.citations.slice(-2).every(entry => entry.status === "missing"));
  assert.doesNotMatch(result.reply, /\[\[|cite:|local:999|invented/);
  const repeated = citations.resolveForDisplay(result.reply, result.citations, context);
  assert.deepEqual(repeated, result);

  sources[0].contentHash = "changed";
  const stale = citations.resolveForDisplay("[[cite:paper-a]]", saved, context).citations.at(-1);
  assert.equal(stale.contentHash, saved[0].contentHash);
  assert.equal(citations.navigationTarget(stale, context), null);
  const otherWorkspace = { ...context, workspaceId: "other" };
  assert.equal(citations.navigationTarget(citations.resolveForDisplay("[[cite:paper-a]]", saved, otherWorkspace).citations.at(-1), otherWorkspace), null);
  assert.equal(citations.resolveForDisplay("[local:1]", [], context).citations[0].status, "missing");
});

test("compact citation labels retain the filename, extension and verified location; full labels retain the path", () => {
  const entry = { relativePath: "literature/deep/2017--Continuous abatement of methane coupled with ectoine production by Methylomicrobium alcaliphilum 20Z in stirred tank reactors - A step further towards greenhouse gas biorefineries.pdf", workspaceName: "LocalWork_Test_APP copy", page: 5, status: "resolved" };
  const compact = citations.label(entry, { compact: true });
  assert.ok(compact.length < 70);
  assert.match(compact, /^2017--Continuous.*….*\.pdf — p\. 5$/);
  assert.doesNotMatch(compact, /literature|LocalWork/);
  assert.equal(citations.label(entry), `LocalWork_Test_APP copy / ${entry.relativePath.split("/").join(" / ")} — p. 5`);
});

test("nested list citations resolve while actual indented and fenced code remains untouched", () => {
  const input = [
    "*   **主流模型对比**：", "    *   AF3 [[cite:paper-a]]。", "    *   Chai-1 [[cite:paper-b]]。",
    "", "*   **技术突破**：", "    1. 优势 [[cite:paper-c]]。", "       续行 [paper-a]。",
    "", "           [[cite:code-in-list]]", "", "    ```text", "    [[cite:fenced-in-list]]", "    ```",
    "", "Outside list", "", "    * [[cite:indented-code]]", "    [local:1]",
  ].join("\n");
  const result = citations.resolveAnswer(input, registry());
  assert.deepEqual(result.citations.map(entry => entry.sourceId), ["paper-a", "paper-b", "paper-c"]);
  assert.doesNotMatch(result.reply, /cite:paper-|\[paper-a\]/);
  for (const code of ["           [[cite:code-in-list]]", "    [[cite:fenced-in-list]]", "    * [[cite:indented-code]]", "    [local:1]"]) assert.ok(result.reply.includes(code), code);
});
