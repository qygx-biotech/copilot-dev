"use strict";
// Files Agent Work wrote into output/ in a project sandbox stay labelled as
// derived analysis wherever they reach a model: selected-file evidence, the
// searchable document copy, and retrieval hits.
const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { createFixture } = require("./helpers/preflight-fixture.js");
const { ProjectContextService } = require("../../docs/project-context-service.js");
const contract = require("../../shared/retrieval-contract.js");

const hashOf = text => `sha256:${crypto.createHash("sha256").update(text).digest("hex")}`;
const GENERATED = "Titre reached 12 g/L in run 4.";

async function fixture() {
  const f = await createFixture();
  f.workspace.set("output/report.md", GENERATED);
  f.workspace.set("output/edited.md", "The user rewrote this summary.");
  f.workspace.set("notes/report.md", GENERATED);
  // The host index (desktop/services/output-provenance.mjs) lists what Agent Work wrote.
  f.workspace.set(contract.GENERATED_OUTPUT_INDEX, JSON.stringify({ version: 1, paths: {
    "output/report.md": [{ sha256: hashOf(GENERATED), turnId: "turn-1", at: "2026-10-07T00:00:00.000Z" }],
    "output/edited.md": [{ sha256: hashOf("The original generated summary."), turnId: "turn-1", at: "2026-10-07T00:00:00.000Z" }],
    "notes/report.md": [{ sha256: hashOf(GENERATED), turnId: "turn-1", at: "2026-10-07T00:00:00.000Z" }],
  } }));
  await f.pipeline.preflight({ turnId: "seed" });
  const service = new ProjectContextService({ workspace: f.workspace, literature: f.literature, sourceSystem: f.system, requestPipeline: f.pipeline,
    semanticInterpreter: { interpret() { throw new Error("No planner is needed"); } } });
  return { f, service, source: path => f.system.registry.getByPath(path) };
}

test("generated output keeps its label in the searchable copy, file evidence and retrieval hits", async () => {
  const { f, service, source } = await fixture();
  const report = source("output/report.md");
  assert.equal(report.contentHash, hashOf(GENERATED), "Registry and host hashes use the same format");
  const copy = await (await f.workspace.readFile(report.artifacts.documentMarkdown.path)).text();
  assert.match(copy, /\norigin: "generated"\n/);
  assert.ok(copy.includes(`> ${contract.GENERATED_OUTPUT_NOTICE}`));

  const evidence = await service.buildFileEvidence({ name: "report.md", relativePath: "output/report.md" }, { question: "What was the titre?" });
  assert.equal(evidence.evidenceType, "generated-document");
  assert.equal(evidence.origin, "generated");
  assert.ok(evidence.content.startsWith(contract.GENERATED_OUTPUT_NOTICE), evidence.content);
  assert.ok(evidence.content.includes(GENERATED));

  const hit = await service.labelGeneratedHit({ kind: "project-memory", sourceId: report.sourceId, snippet: "Titre reached 12 g/L" });
  assert.equal(hit.origin, "generated");
  assert.ok(hit.snippet.startsWith(`[${contract.GENERATED_OUTPUT_NOTICE}]`));
});

test("content that no longer matches, or lies outside output/, is not labelled", async () => {
  const { f, service, source } = await fixture();
  const edited = await service.buildFileEvidence({ name: "edited.md", relativePath: "output/edited.md" }, { question: "Summary?" });
  assert.equal(edited.evidenceType, "project-document-evidence");
  assert.ok(!("origin" in edited));
  const notes = source("notes/report.md");
  assert.doesNotMatch(await (await f.workspace.readFile(notes.artifacts.documentMarkdown.path)).text(), /origin: "generated"/);
  assert.equal((await service.buildFileEvidence({ name: "report.md", relativePath: "notes/report.md" }, { question: "Titre?" })).evidenceType, "project-document-evidence");
  const hit = { kind: "project-memory", sourceId: notes.sourceId, snippet: "Titre" };
  assert.deepEqual(await service.labelGeneratedHit(hit), hit);
  assert.equal(contract.generatedOutputOrigin(null, "output/report.md", hashOf(GENERATED)), null, "Without an index nothing is labelled");
});
