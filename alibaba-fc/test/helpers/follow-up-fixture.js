// Legacy semantic-reference fixture; direct transcript replay is tested separately.
"use strict";
const { ProjectContextService } = require("../../../docs/project-context-service.js");
const semantic = require("../../../shared/semantic-intent.js");
function followUpFixture(options = {}) {
  const documents = ["AlphaDock", "BetaDock", "GammaDock"].map((name, i) => ({ id: `P${i + 1}`, filename: `${name}-study.pdf`,
    relativePath: `literature/${name}-study.pdf`, isLiteraturePaper: true, paperCardStatus: "ready", summaryAvailable: true,
    discovery: { title: `${name} docking study` } }));
  const sources = documents.map(d => ({ sourceId: d.id, sourceKind: "paper", path: d.relativePath, displayName: d.filename,
    catalogStatus: "ready", hashStatus: "ready", contentHash: `hash-${d.id}`, indexStatus: "ready", parseStatus: "ready", artifacts: {} }));
  const registry = { get: id => sources.find(s => s.sourceId === id && s.catalogStatus !== "missing"),
    getByPath: p => sources.find(s => s.path === p), list: ({ sourceKind } = {}) => sources.filter(s => s.catalogStatus !== "missing" && (!sourceKind || s.sourceKind === sourceKind)), counts: () => ({}) };
  const reads = [], searches = [], interpretations = [];
  const literature = { documents, api: {}, findDocumentByPath: p => documents.find(d => d.relativePath === p),
    preparation: { ensureSourceReady: async (ids, _capability, context) => { reads.push({ ids, context }); },
      readPaperArtifact: async id => ({ contentHash: registry.get(id).contentHash, chunks: [{ page: 4, chunkId: "original",
        text: `Original ${id} evidence (${registry.get(id).contentHash}): Code availability: source code is provided. The license is restrictive. Methods used a numerical solver at 30 degrees Celsius.` }] }) } };
  if (options.parser !== "offline") literature.api.interpretSemantics = async input => {
    interpretations.push(input);
    if (options.parser === "fail") throw new Error("Synthetic parser outage");
    if (options.parser === "malformed") return { invalid: true };
    if (typeof options.parser === "function") return options.parser(input);
    return semantic.interpretLocal(input);
  };
  const sourceSystem = { registry, literatureTools: { searchPapers: async (query, context) => { searches.push({ query, context }); return { results: [] }; } } };
  const workspace = { workspace: { id: "W1" }, state: { memory: {}, project: {} } };
  const service = new ProjectContextService({ workspace, literature, sourceSystem });
  const citation = (id, n = 1, changes = {}) => ({ id: `citation-${n}`, sourceId: id, reference: `${id}:p4:original`,
    workspaceId: "W1", relativePath: sources.find(s => s.sourceId === id)?.path, contentHash: `hash-${id}`, status: "resolved", ...changes });
  const answer = (ids, extra = "") => ({ role: "assistant", content: ids.map((id, n) => `${n + 1}. ${documents.find(d => d.id === id)?.discovery.title} [paper](biodesign-citation:citation-${n + 1})`).join("\n") + extra,
    citations: ids.map((id, n) => citation(id, n + 1)) });
  const conversation = { summary: "An old summary about GammaDock. " + "Earlier background. ".repeat(60), messages: [
    { role: "user", content: "Compare the first two docking papers.", context: { relevantPaperIds: ["P3", "P1", "P2"] } }, answer(["P1", "P2"]),
    { role: "user", content: "Explain BetaDock.", context: { relevantPaperIds: ["P3", "P1", "P2"] } }, answer(["P2"]),
  ] };
  const build = (question, extra = {}) => service.buildPlannedContext({ question, retrievalProfile: "medium", conversation, callContext: { turnId: "follow-up-turn", model: "google/gemma-4-31b-it" }, ...extra });
  return { service, sources, registry, literature, workspace, reads, searches, interpretations, citation, answer, conversation, build };
}
module.exports = { followUpFixture };
