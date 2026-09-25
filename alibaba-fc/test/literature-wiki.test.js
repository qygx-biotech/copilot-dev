// Planned-context cases below exercise the retained optional helper, not the direct Side Chat entry point.
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { createFixture } = require("./helpers/preflight-fixture.js");
const { ProjectContextService } = require("../../docs/project-context-service.js");
const contract = require("../../shared/literature-wiki.js");
const { sanitizeLocalWorkspaceContext } = require("../index.js")._test;
const agent = require("../side-chat-agent.js");
const clone = value => JSON.parse(JSON.stringify(value));
const selectedModel = "nvidia/nemotron-3-nano-omni-30b-a3b-reasoning";
function pageFor(input) {
  const support = paper => ({ reference: paper.evidence[0].reference, quote: paper.evidence[0].text.slice(0, 160) });
  const findings = input.papers.map(paper => ({ kind: "reported", text: paper.evidence[0].text.slice(0, 160), conditions: "Assay conditions remain study-specific.", evidence: [support(paper)] }));
  return { schemaVersion: 1, pageId: input.pageId,
    explanation: { kind: "interpretation", text: "Studies address this subject under different conditions.", conditions: "", evidence: input.papers.slice(0, 2).map(support) },
    findings, disagreements: [{ kind: "interpretation", text: "The studies report different stability outcomes; assay differences require examination.", conditions: "Different assay temperatures.", evidence: input.papers.slice(0, 2).map(support) }],
    openQuestions: [{ kind: "hypothesis", text: "Assay temperature could explain the difference; this needs testing.", conditions: "", evidence: input.papers.slice(0, 2).map(support) }],
    relatedPageIds: input.relatedPages.slice(0, 2).map(page => page.pageId),
  };
}
function markdownFor(input) {
  return contract.markdownPage(`# ${input.label}\n\n${input.papers.map(paper => `${paper.evidence[0].text} [[cite:${paper.evidence[0].reference}]]`).join("\n\n")}\n\n### Comparison\n\n| Question | Observation |\n| --- | --- |\n| Conditions | ${input.papers[0].evidence[0].text} [[cite:${input.papers[0].evidence[0].reference}]] |\n| Proposal | A temperature-matched assay may help. |\n\nCould matched conditions explain the difference?`);
}
async function setup(options = {}) {
  const f = await createFixture({ workspace: options.workspace });
  const wiki = f.system.literatureWiki, requests = [];
  wiki.getPaperCardConfiguration = async (_signal, context) => ({ schemaVersion: 2, promptVersion: "fixture-v1", modelSignature: "fixture-model",
    wikiConfiguration: contract.configuration(context?.model || selectedModel) });
  wiki.generateWikiPage = async (input, context) => {
    requests.push({ input: clone(input), context });
    if (options.generate) return options.generate(input, context);
    return { page: pageFor(input), configuration: input.configuration };
  };
  if (!options.workspace) {
    f.workspace.set("literature/a.pdf", "EctD enzyme engineering at 30 C improved thermostability in study Alpha.");
    f.workspace.set("literature/b.pdf", "EctD enzyme engineering at 50 C reduced thermostability in study Beta.");
  }
  let now = options.now || Date.now();
  wiki.now = () => now;
  f.advance = milliseconds => { now += milliseconds; };
  const turn = n => ({ turnId: `wiki-turn-${n}`, question: "Explain enzyme engineering concepts.", callContext: { model: selectedModel }, surface: "side_chat" });
  const service = new ProjectContextService({ workspace: f.workspace, literature: f.literature, sourceSystem: f.system, requestPipeline: f.pipeline });
  return { ...f, wiki, requests, turn, service };
}

test("free-form Markdown retains tables, separates metadata and flags uncited passages without requiring fixed sections", async () => {
  const f = await setup({ generate: async input => ({ page: markdownFor(input), configuration: input.configuration, attempts: 1 }) });
  const run = await f.pipeline.preflight(f.turn("markdown"));
  assert.equal(run.report.status, "completed", JSON.stringify(run.report.failures));
  assert.equal(run.wikiMaintenance.providerAttempts, f.requests.length);
  const topic = f.system.topicService.topics.find(topic => topic.wiki);
  const record = await f.wiki.readForUse(topic);
  assert.deepEqual(Object.keys(record.page).sort(), ["markdown", "schemaVersion"]);
  assert.equal(record.dependencies.length, 2);
  assert.equal(record.contentHash, await f.wiki.hashValue(record.page));
  assert.equal(record.integrity.verifiedClaimCount, 0, "Valid citation handles are not a semantic truth verdict");
  assert.equal(record.integrity.unsupportedPassages.length, 1);
  const rendered = contract.renderPage(record.page);
  assert.match(rendered, /\| Question \| Observation \|\n\| --- \| --- \|/);
  assert.match(rendered, /\| \*\*Unverified/);
  assert.match(rendered, /\n\nCould matched conditions explain the difference\?$/);
  const before = f.calls.cards;
  await f.pipeline.preflight(f.turn("cached-markdown"));
  assert.equal(f.calls.cards, before);
  assert.equal((await f.wiki.readForUse(topic)).key, record.key);
  const citations = require("../../shared/source-citations.js");
  const reference = record.integrity.references[0];
  const source = f.system.registry.get(reference.sourceId);
  const registry = citations.createRegistry([{ sourceId: source.sourceId, relativePath: source.path, contentHash: source.contentHash,
    evidence: [reference] }], f.workspace.workspace.name);
  const resolved = citations.resolveAnswer(`Evidence [[cite:${reference.reference}]]`, registry);
  assert.equal(resolved.citations[0].status, "resolved");
  assert.equal(resolved.citations[0].sourceId, source.sourceId);
  assert.equal(resolved.citations[0].page, reference.page);
  assert.equal(resolved.citations[0].relativePath, source.path);
  const navigation = { workspaceId: f.workspace.workspace.workspaceId, getSource: id => f.system.registry.get(id), files: [{ type: "file", relativePath: source.path }] };
  const bound = citations.bindToWorkspace(resolved.citations, navigation)[0];
  assert.equal(bound.page, reference.page);
  assert.equal(citations.navigationTarget(bound, navigation).relativePath, source.path);
});

test("Markdown rejects fabricated and out-of-scope handles/links; stale/deleted bytes cannot be reused or published", async () => {
  const f = await setup({ generate: async input => ({ page: markdownFor(input), configuration: input.configuration, attempts: 1 }) });
  await f.pipeline.preflight(f.turn("seed-markdown"));
  const topic = f.system.topicService.topics.find(topic => topic.wiki), record = await f.wiki.read(topic);
  const input = f.requests.find(item => item.input.pageId === topic.topicId).input;
  for (const markdown of ["Fake [[cite:invented:p3:chunk]]", "Bad [[cite:SOURCE_ID:pPAGE:CHUNK_ID]]", "[paper](../../secret.pdf)", "[paper][invented]", "Only `[[cite:" + input.papers[0].evidence[0].reference + "]]`", "Malformed [[cite:broken]"]) {
    assert.ok(contract.validatePage(contract.markdownPage(markdown), input).length, markdown);
  }
  const excluded = clone(input); excluded.papers = [input.papers[0]];
  assert.ok(contract.validatePage(record.page, excluded).length);
  assert.equal(await f.wiki.readForUse(topic, { paperIds: [topic.paperIds[0]] }), null);
  const source = f.system.registry.get(topic.paperIds[0]);
  const originalFile = f.workspace.files.get(source.path);
  f.workspace.set(source.path, "Physical file changed before reconciliation", Date.now());
  assert.equal(await f.wiki.readForUse(topic), null, "Registry hash alone cannot establish currentness");
  f.workspace.files.set(source.path, originalFile);
  let inFlightUpdates = 0;
  f.wiki.generateWikiPage = async input => {
    inFlightUpdates++;
    f.workspace.set(source.path, "Source changed while the model was generating this page", Date.now());
    return { page: markdownFor(input), configuration: input.configuration, attempts: 1 };
  };
  const update = await f.wiki.maintain({ action: "update", analysisRequest: "Compare the current assay conditions.", callContext: { model: selectedModel } });
  assert.ok(inFlightUpdates > 0);
  assert.equal(update.status, "partial");
  assert.deepEqual(await f.wiki.read(topic), record);
  f.workspace.files.delete(source.path);
  assert.equal(await f.wiki.readForUse(topic), null);
  const citations = require("../../shared/source-citations.js");
  const unresolved = citations.resolveAnswer("Bad [[cite:invented:p3:chunk]]", citations.createRegistry([]), [], { suppressUnresolved: true });
  assert.doesNotMatch(unresolved.reply, /biodesign-citation:/);
});

test("saved version-one pages remain readable and citation-checked without regenerating compatible Paper Cards", async () => {
  const f = await setup(); await f.pipeline.preflight(f.turn("old-seed"));
  const topic = f.system.topicService.topics.find(topic => topic.wiki), record = await f.wiki.read(topic);
  record.schemaVersion = 1;
  record.configuration = { ...record.configuration, schemaVersion: 1, promptVersion: "literature-wiki-v1" };
  delete record.contentHash; delete record.integrity; delete record.generation;
  await f.workspace.writeJson(topic.wiki.path, record);
  const before = f.calls.cards;
  assert.ok(await f.wiki.readForUse(topic));
  assert.match(contract.renderPage((await f.wiki.readForUse(topic)).page), /Supported findings/);
  await f.pipeline.preflight(f.turn("legacy-read"));
  assert.equal(f.calls.cards, before);
  assert.ok(await f.wiki.readForUse(topic));
});

test("two papers create linked, quote-backed pages; unchanged compatible synchronization makes no wiki calls", async t => {
  const f = await setup();
  const first = await f.pipeline.preflight(f.turn(1));
  assert.ok(f.requests.length >= 2, JSON.stringify(first.wikiMaintenance));
  const initial = f.requests.length;
  const pages = f.system.topicService.topics.filter(topic => topic.wiki);
  assert.ok(pages.some(topic => topic.pageKind === "entity"));
  assert.ok(pages.some(topic => topic.pageKind === "method"));
  const page = await f.wiki.read(pages.find(topic => topic.topicId === "thermostability"));
  assert.equal(page.dependencies.length, 2);
  assert.equal(page.page.findings.length, 2);
  assert.equal(page.page.relatedPageIds.length, 2);
  assert.match(contract.renderPage(page.page), /improved thermostability/);
  assert.match(contract.renderPage(page.page), /reduced thermostability/);
  assert.match(contract.renderPage(page.page), /model-assisted interpretations, not factual verdicts/);
  assert.ok(await f.workspace.fileExists(".biodesign/knowledge/topics/index.md"));
  const next = await f.pipeline.preflight(f.turn(2));
  assert.equal(next.wikiMaintenance.generationCalls, 0);
  assert.equal(f.requests.length, initial);
  const writes = f.workspace.writes.length;
  await f.wiki.maintain({ callContext: { model: selectedModel } });
  assert.equal(f.workspace.writes.length, writes, "An unchanged wiki check does not rewrite the index or pages");
  for (const request of f.requests) assert.equal(request.context.callContext.model, selectedModel);
  t.diagnostic(`Initial wiki generation requests: ${initial}; unchanged repeat: ${f.requests.length - initial}.`);
});

test("new paper updates only affected pages and reuses unchanged compatible cards", async t => {
  const f = await setup(); await f.pipeline.preflight(f.turn(1));
  // A distinct valid subject populated from the same registry fixtures, with no
  // dependency on the new paper, must keep its revision.
  const topic = f.system.topicService.topics.find(topic => topic.topicId === "thermostability");
  const unrelated = { ...clone(topic), topicId: "other-subject", label: "Other subject", pageKind: "concept", wiki: undefined };
  f.system.topicService.topics.push(unrelated);
  await f.wiki.maintain({ action: "update", callContext: { model: selectedModel } });
  const previous = unrelated.wiki.key, before = f.requests.length, cards = f.calls.cards;
  f.workspace.set("literature/c.pdf", "EctD enzyme engineering retains thermostability in study Gamma.");
  await f.pipeline.preflight(f.turn(2));
  const updated = f.requests.slice(before);
  assert.ok(updated.some(request => request.input.pageId === "thermostability"));
  assert.ok(updated.every(request => request.input.pageId !== "other-subject"));
  assert.equal(unrelated.wiki.key, previous);
  assert.equal(f.calls.cards - cards, 1);
  assert.ok(updated.every(request => request.input.existingPage));
  t.diagnostic(`One new paper: ${updated.length} affected wiki requests, 0 unrelated requests, ${f.calls.cards - cards} new Paper Card request.`);
});

test("offline search reads the committed page even when its Markdown projection is missing", async () => {
  const f = await setup(); await f.pipeline.preflight(f.turn(1));
  const topic = f.system.topicService.topics.find(topic => topic.topicId === "thermostability");
  await f.workspace.removeFile(`.biodesign/knowledge/topics/${topic.topicId}.md`);
  f.system.knowledgeService.available = false;
  f.wiki.generateWikiPage = null;
  const before = f.requests.length;
  const context = await f.service.buildPlannedContext({ ...f.turn(2), question: "Explain the thermostability concept." });
  const kb = agent.createSideChatKnowledgeBase({ localWorkspaceContext: sanitizeLocalWorkspaceContext(context) });
  assert.ok(kb.items.some(item => item.evidenceType === "saved-topic" && item.content.includes("improved thermostability")));
  assert.equal(f.requests.length, before);
});

test("maintenance flags broken links, unknown references, source and generation changes without writes", async () => {
  const f = await setup(); await f.pipeline.preflight(f.turn(1));
  const topic = f.system.topicService.topics.find(topic => topic.topicId === "thermostability");
  const record = await f.wiki.read(topic);
  record.page.relatedPageIds.push("missing-link");
  record.page.findings[0].evidence[0].reference = "unknown-paper:p1:unknown";
  record.configuration.evidenceVersion = "old-extraction";
  await f.workspace.writeJson(topic.wiki.path, record);
  const source = f.system.registry.get(record.dependencies[0].sourceId);
  source.contentHash = "changed-source-hash";
  f.system.registry.get(record.dependencies[1].sourceId).catalogStatus = "missing";
  const before = f.requests.length, writes = f.workspace.writes.length;
  const result = await f.wiki.maintain({ action: "check" });
  const issues = result.pages.find(page => page.pageId === topic.topicId).issues;
  for (const expected of ["broken-link", "unsupported-reference", "stale-source", "missing-source", "stale-card", "incompatible-generation"]) assert.ok(issues.includes(expected), expected);
  assert.equal(f.workspace.writes.length, writes); assert.equal(f.requests.length, before);
});

test("updates preserve omitted supported findings and retain at most two revisions", async () => {
  const f = await setup(); await f.pipeline.preflight(f.turn(1));
  const topic = f.system.topicService.topics.find(topic => topic.topicId === "thermostability");
  const original = await f.wiki.read(topic);
  f.wiki.generateWikiPage = async input => {
    const page = pageFor(input);
    page.findings = [page.findings[0]]; // Both sources are still covered by the explanation.
    return { page, configuration: input.configuration };
  };
  for (const number of [1, 2, 3]) await f.wiki.maintain({ action: "incorporate", analysisRequest: `Incorporate thermostability analysis ${number} into the wiki`, callContext: { model: selectedModel } });
  const current = await f.wiki.read(topic);
  assert.deepEqual(current.page.findings, original.page.findings);
  assert.equal(topic.wiki.history.length, 1);
  assert.equal([...f.workspace.files.keys()].filter(path => path.startsWith(`.biodesign/knowledge/wiki_pages/${topic.topicId}/`)).length, 2);
});

test("an index publication failure cannot replace the saved artifact or leave an unpublished revision", async () => {
  const f = await setup(); await f.pipeline.preflight(f.turn(1));
  const topic = f.system.topicService.topics.find(topic => topic.topicId === "thermostability"), previous = clone(topic.wiki);
  const persist = f.system.topicService.persist.bind(f.system.topicService);
  let fail = true;
  f.system.topicService.persist = async () => {
    if (fail) { fail = false; throw new Error("Synthetic storage failure"); }
    return persist();
  };
  const result = await f.wiki.maintain({ action: "incorporate", analysisRequest: "Incorporate thermostability analysis into the wiki", callContext: { model: selectedModel } });
  assert.equal(result.status, "partial"); assert.equal(topic.wiki.path, previous.path);
  assert.equal([...f.workspace.files.keys()].filter(path => path.startsWith(`.biodesign/knowledge/wiki_pages/${topic.topicId}/`)).length, 1);
  assert.ok(await f.wiki.read(topic));
});

test("wiki generation attempts and lint scans are bounded, including failed requests", async () => {
  const f = await setup(); await f.pipeline.preflight(f.turn(1));
  const base = f.system.topicService.topics.find(topic => topic.wiki);
  for (let n = 0; n < 35; n++) f.system.topicService.topics.push({ ...clone(base), topicId: `extra-${n}`, label: `Extra subject ${n}` });
  f.wiki.generateWikiPage = async () => { throw new Error("Synthetic failure"); };
  const update = await f.wiki.maintain({ action: "update", callContext: { model: selectedModel } });
  assert.equal(update.generationCalls, contract.LIMITS.pagesPerRun);
  const lint = await f.wiki.maintain({ action: "check" });
  assert.equal(lint.pages.length, contract.LIMITS.lintPages); assert.equal(lint.truncated, true);
  const input = clone(f.requests[0].input), page = pageFor(input);
  page.explanation = null; assert.ok(contract.validatePage(page, input).length);
  input.papers = Array(21).fill(input.papers[0]); assert.ok(contract.validateInput(input).length);
});

test("concurrent ordinary questions and explicit commands keep their wiki intent and scope", async () => {
  const f = await setup(); await f.pipeline.preflight(f.turn(1));
  await Promise.all([
    f.pipeline.preflight(f.turn(2)),
    f.pipeline.preflight({ ...f.turn(3), question: "Incorporate a thermostability comparison into the wiki." }),
  ]);
  assert.ok(f.system.topicService.topics.some(topic => topic.pageKind === "comparison" && topic.wiki));
  for (const question of ["How do I update the literature wiki?", "Should I update the literature wiki?", "What would an update to the wiki change?"]) assert.equal(contract.command(question), null);
  const before = f.requests.length;
  let corpusCalls = 0;
  f.system.corpusWorkflows.run = f.system.corpusWorkflows.updateCorpusSynthesis = async () => { corpusCalls++; throw new Error("Unexpected synthesis request"); };
  await f.service.buildPlannedContext({ ...f.turn(4), question: "How do I update the literature wiki?" });
  assert.equal(corpusCalls, 0);
  assert.ok(f.requests.slice(before).every(request => request.input.kind !== "comparison" && !request.input.analysisRequest),
    "New related-page IDs may refresh existing pages without borrowing the comparison command");
});

test("source changes/removal invalidate old claims and failed updates preserve the last valid revision", async () => {
  const f = await setup(); await f.pipeline.preflight(f.turn(1));
  const topic = f.system.topicService.topics.find(topic => topic.topicId === "thermostability");
  const before = clone(topic.wiki), original = await f.workspace.readJson(before.path);
  f.workspace.set("literature/b.pdf", "EctD enzyme engineering new conditions invalidate the previous stability observation.", Date.now() - 1000);
  f.wiki.generateWikiPage = async () => { throw Object.assign(new Error("Synthetic outage"), { code: "PROVIDER_UNAVAILABLE" }); };
  await f.pipeline.preflight(f.turn(2));
  assert.equal(topic.summaryStatus, "stale"); assert.equal(topic.wiki.path, before.path);
  assert.deepEqual(await f.workspace.readJson(before.path), original);
  f.wiki.generateWikiPage = async input => ({ page: pageFor(input), configuration: input.configuration });
  f.advance(60000);
  await f.wiki.maintain({ action: "update", callContext: { model: selectedModel } });
  const recovery = await f.wiki.maintain({ action: "update", callContext: { model: selectedModel } });
  assert.equal(recovery.status, "ready", JSON.stringify(recovery));
  const updated = await f.wiki.read(topic);
  assert.ok(!updated.page.findings.some(item => item.text.includes("reduced thermostability")));
  f.workspace.files.delete("literature/a.pdf");
  await f.pipeline.preflight(f.turn(3));
  assert.equal(topic.summaryStatus, "stale");
  assert.equal(topic.paperIds.length, 1);
  assert.ok(await f.wiki.read(topic), "Last valid revision remains available for historical inspection");
});

test("cancelled and invalid generation cannot replace a valid page", async () => {
  const f = await setup(); await f.pipeline.preflight(f.turn(1));
  const topic = f.system.topicService.topics.find(topic => topic.topicId === "thermostability");
  const previous = topic.wiki.path;
  const controller = new AbortController();
  f.wiki.generateWikiPage = async input => { controller.abort(); return { page: pageFor(input), configuration: input.configuration }; };
  await assert.rejects(f.wiki.maintain({ action: "incorporate", analysisRequest: "Incorporate a new thermostability analysis into the wiki", signal: controller.signal, callContext: { model: selectedModel } }), { code: "OPERATION_ABORTED" });
  assert.equal(topic.wiki.path, previous);
  f.wiki.generateWikiPage = async input => {
    const page = pageFor(input); page.findings[0].evidence[0].reference = "foreign-paper:p1:invented";
    return { page, configuration: input.configuration };
  };
  await f.wiki.maintain({ action: "incorporate", analysisRequest: "Incorporate a new thermostability analysis into the wiki", callContext: { model: selectedModel } });
  assert.equal(topic.wiki.path, previous); assert.equal(topic.summaryStatus, "ready", "A failed attempt does not invalidate the unchanged successful revision");
});

test("changed card content and incompatible wiki configuration do not authorize automatic generation", async () => {
  const f = await setup(); await f.pipeline.preflight(f.turn(1));
  const before = f.requests.length, topic = f.system.topicService.topics.find(topic => topic.topicId === "thermostability");
  const source = f.system.registry.list({ sourceKind: "paper" })[0];
  const card = await f.workspace.readJson(source.artifacts.paperCard.path);
  card.summary += " A corrected orientation summary."; await f.workspace.writeJson(source.artifacts.paperCard.path, card);
  const cards = f.calls.cards;
  await f.pipeline.preflight(f.turn(2));
  assert.equal(f.requests.length, before); assert.equal(topic.summaryStatus, "stale");
  await f.wiki.maintain({ action: "update", callContext: { model: selectedModel } });
  const record = await f.wiki.read(topic); record.configuration.promptVersion = "obsolete-prompt";
  await f.workspace.writeJson(topic.wiki.path, record);
  const after = f.requests.length;
  await f.pipeline.preflight(f.turn(3));
  assert.equal(f.requests.length, after); assert.equal(topic.summaryStatus, "stale");
  assert.equal(f.calls.cards, cards);
});

test("concept questions read the maintained L3 through the active connection; precise questions retain L1", async () => {
  const f = await setup(); await f.pipeline.preflight(f.turn(1));
  const before = f.requests.length;
  const context = await f.service.buildPlannedContext({ ...f.turn(2), question: "Explain enzyme engineering concepts across studies." });
  const kb = agent.createSideChatKnowledgeBase({ localWorkspaceContext: sanitizeLocalWorkspaceContext(context) });
  const item = kb.items.find(item => item.evidenceType === "saved-topic");
  assert.ok(item); assert.match(item.content, /Supported findings/);
  const reference = item.content.match(/\[\[cite:([^\]]+)\]\]/)[1];
  let turns = 0;
  const answer = await agent.runSideChatAgent({
    workspaceContext: { localWorkspaceContext: sanitizeLocalWorkspaceContext(context) },
    conversationMessages: [{ role: "user", content: "Explain enzyme engineering concepts across studies." }],
    systemPrompt: "Read the relevant wiki and preserve original evidence provenance.", parseFinalAnswer: reply => ({ reply }),
    requestTurn: async ({ messages }) => {
      if (++turns === 1) return { ok: true, message: { tool_calls: [{ id: "read-wiki", type: "function", function: {
        name: "read_workspace_item", arguments: JSON.stringify({ item_id: item.id }),
      } }] } };
      const read = JSON.parse(messages.find(message => message.role === "tool").content);
      assert.match(read.content, /improved thermostability/); assert.match(read.content, /reduced thermostability/);
      assert.match(read.content, /"wikiGeneration"/);
      assert.equal(item.metadata.provenance.wikiGeneration.modelSignature, selectedModel);
      assert.equal(read.citation, undefined);
      return { ok: true, message: { content: `The reported outcomes differ across conditions. [[cite:${reference}]]` } };
    },
  });
  assert.equal(answer.ok, true); assert.equal(turns, 2);
  assert.equal(answer.data.citations[0].status, "resolved");
  assert.equal(answer.data.citations[0].sourceId, reference.split(":p")[0]);
  assert.equal(agent.buildSourceCitationRegistry(kb).has(item.id), false);
  assert.equal(f.requests.length, before);
  const precise = await f.service.buildPlannedContext({ ...f.turn(3), question: "What exact temperature was reported in the EctD paper?" });
  assert.ok(precise.evidencePlan.evidenceNeeds.some(need => need.type === "literature_evidence"));
  const exactKb = agent.createSideChatKnowledgeBase({ localWorkspaceContext: sanitizeLocalWorkspaceContext(precise) });
  assert.ok(exactKb.paperLookup.papers.length > 0);
  assert.equal(f.requests.length, before);
});

test("cancelling one concurrent wiki command does not cancel another consumer or poison its retry", async () => {
  const f = await setup(); await f.pipeline.preflight(f.turn(1));
  const first = new AbortController(), second = new AbortController();
  let calls = 0;
  f.wiki.generateWikiPage = async (input, options) => {
    calls++;
    if (calls === 1) first.abort();
    return { page: pageFor(input), configuration: input.configuration };
  };
  const question = "Incorporate a new thermostability analysis into the literature wiki.";
  const results = await Promise.allSettled([
    f.pipeline.preflight({ ...f.turn(2), question, signal: first.signal }),
    f.pipeline.preflight({ ...f.turn(3), question, signal: second.signal }),
  ]);
  assert.equal(results[0].status, "rejected"); assert.equal(results[0].reason.code, "OPERATION_ABORTED");
  assert.equal(results[1].status, "fulfilled"); assert.equal(results[1].value.wikiMaintenance.status, "ready");
  assert.equal(calls, 2);
});

test("optional answer-time Paper Card reads preserve the selected model and cannot rewrite the wiki", async () => {
  const f = await setup(); await f.pipeline.preflight(f.turn(1));
  const source = f.system.registry.list({ sourceKind: "paper" })[0];
  const create = f.literature.createPaperCard.bind(f.literature);
  let received;
  f.literature.createPaperCard = async (id, options) => { received = options; return create(id, options); };
  const before = f.requests.length, model = "google/gemma-4-31b-it";
  await f.service.buildFileEvidence({ name: source.displayName, relativePath: source.path }, {
    question: "Summarize the entire EctD paper.", qualityMode: "fast", evidencePlan: { needsNativePdf: false },
    callContext: { turnId: "optional-card", model },
  });
  assert.equal(received?.callContext?.model, model);
  assert.equal(received.deferWikiUpdate, true);
  assert.equal(f.requests.length, before);
});

test("explicit wiki incorporation uses validated comparison updates, while checks are bounded and read-only", async () => {
  const f = await setup(); await f.pipeline.preflight(f.turn(1));
  const context = await f.service.buildPlannedContext({ ...f.turn(2), question: "Incorporate a thermostability comparison into the literature wiki." });
  assert.ok(f.system.topicService.topics.some(topic => topic.pageKind === "comparison" && topic.wiki));
  assert.equal(context.literature.corpusWideRequest, false);
  assert.match(context.notices.join("\n"), /wiki maintenance/);
  const before = f.requests.length, writes = f.workspace.writes.length;
  const check = await f.wiki.maintain({ action: "check" });
  assert.equal(check.generationCalls, 0); assert.equal(f.requests.length, before);
  assert.equal(f.workspace.writes.length, writes);
  assert.equal(check.semanticContradictionsAreVerified, false);
  assert.ok(check.pages.some(page => page.issues.includes("model-assisted-disagreement-review")));
});

test("selected scope, workspace changes and model changes cannot silently reuse or broaden wiki context", async () => {
  const f = await setup(); await f.pipeline.preflight(f.turn(1));
  const source = f.system.registry.list({ sourceKind: "paper" })[0];
  const context = await f.service.buildPlannedContext({ ...f.turn(2), question: "Explain enzyme engineering concepts.", selectedPaperIds: [source.sourceId], selectedPaths: [source.path] });
  assert.equal(context.knowledge.hits.filter(hit => hit.artifact?.wikiGeneration).length, 0);
  const before = f.requests.length;
  const model = "google/gemma-4-31b-it";
  await f.wiki.maintain({ callContext: { model } });
  assert.equal(f.requests.length, before);
  assert.ok(f.system.topicService.topics.filter(topic => topic.wiki).every(topic => topic.summaryStatus === "stale"));
  await f.wiki.maintain({ action: "update", callContext: { model } });
  assert.ok(f.requests.slice(before).every(request => request.context.callContext.model === model && request.input.configuration.modelSignature === model));
  f.workspace.workspace = { workspaceId: "another-workspace" };
  await assert.rejects(f.wiki.maintain({ action: "update" }), { code: "OPERATION_ABORTED" });
});

test("failed wiki attempts survive restart and unchanged Chinese requests without spending or rebuilding evidence/cards", async () => {
  const generate = async () => { throw Object.assign(new Error("Invalid response"), { code: "INVALID_WIKI_PAGE", attempts: 1, validationProblems: ["Citation reference was not supplied: invented:p1:x"] }); };
  const f = await setup({ generate });
  const first = await f.pipeline.preflight({ ...f.turn("failed"), question: "帮我总结所有文献，写个综述。" });
  assert.equal(first.report.status, "partial");
  const pending = f.system.topicService.topics.filter(topic => topic.wikiAdmission);
  assert.equal(f.calls.cards, 2);
  const saved = await f.workspace.readJson(".biodesign/knowledge/topics/index.json");
  for (const topic of saved.topics.filter(topic => topic.wikiAdmission)) {
    const state = topic.wikiMaintenance;
    assert.equal(state.status, "pending"); assert.equal(state.failureCount, 1);
    assert.equal(state.attempts[0].providerAttempts, 1);
    assert.equal(state.attempts[0].configuration.modelSignature, selectedModel);
    assert.ok(state.attempts[0].dependencies.every(dep => dep.cardIdentity && dep.contentHash));
    assert.match(state.lastFailure.validationProblems[0], /not supplied/);
  }
  const restarted = await setup({ workspace: f.workspace, now: f.wiki.time(), generate: async input => ({ page: markdownFor(input), configuration: input.configuration, attempts: 1 }) });
  const retry = { ...restarted.turn("restart"), question: "帮我总结所有文献，写个综述。" };
  const cooling = await restarted.pipeline.preflight(retry);
  assert.equal(cooling.wikiMaintenance.generationCalls, 0);
  assert.ok(cooling.wikiMaintenance.pages.filter(page => page.pending).every(page => page.reason === "evidence_already_attempted" && page.attempts === 0 && page.lastFailure.providerAttempts === 1));
  assert.equal(restarted.calls.cards, 0); assert.equal(restarted.calls.parses, 0);
  restarted.advance(60000);
  const runs = await Promise.all(["a", "b"].map(id => restarted.pipeline.preflight({ ...retry, turnId: `recovery-${id}` })));
  assert.ok(runs.every(run => run.wikiMaintenance.status === "partial"));
  assert.equal(restarted.requests.length, 0, "Elapsed cooldown and concurrent unchanged requests cannot spend");
  await restarted.wiki.maintain({ action: "update", callContext: { model: selectedModel } });
  const explicit = await restarted.wiki.maintain({ action: "update", callContext: { model: selectedModel } });
  assert.equal(explicit.status, "ready");
  assert.equal(restarted.requests.length, pending.length + 1, "Explicit update can retry reserved pages and create the ceiling-deferred topic");
  assert.equal(restarted.calls.cards, 0); assert.equal(restarted.calls.parses, 0);
  for (const topic of restarted.system.topicService.topics.filter(topic => topic.wiki)) {
    assert.equal(topic.wikiMaintenance.status, "current");
    assert.deepEqual(topic.wikiMaintenance.attempts.map(attempt => attempt.status), pending.some(item => item.topicId === topic.topicId) ? ["failed", "published"] : ["published"]);
    assert.ok(await restarted.wiki.readForUse(topic));
  }
  assert.ok(f.workspace.writes.every(path => path.startsWith(".biodesign/")));
  assert.deepEqual(f.workspace.state.agent.currentRecommendation, { id: "R1" });
});

test("only explicit retries can repeat a failed evidence version, with bounded audit history and cooldown", async () => {
  const f = await setup({ generate: async () => { throw Object.assign(new Error("Provider outage"), { code: "PROVIDER_UNAVAILABLE", attempts: 2, providerStatus: 503 }); } });
  await f.pipeline.preflight({ ...f.turn(1), question: "Update the literature wiki." });
  await f.wiki.maintain(); // Drain the fourth ingestion-authorized page in a new bounded run.
  const count = f.requests.length;
  const topic = f.system.topicService.topics.find(topic => topic.wikiMaintenance);
  const key = topic.wikiMaintenance.inputKey;
  await f.pipeline.preflight(f.turn(1));
  await Promise.all([f.wiki.maintain({ action: "update" }), f.wiki.maintain({ action: "update" })]);
  assert.equal(f.requests.length, count);
  for (let attempt = 2; attempt <= 6; attempt++) {
    f.advance(topic.wikiMaintenance.nextRetryAt - f.wiki.time());
    const skipped = await f.pipeline.preflight(f.turn(attempt));
    assert.equal(skipped.wikiMaintenance.providerAttempts, 0);
    const result = await f.wiki.maintain({ action: "update", callContext: { model: selectedModel } });
    const remainder = await f.wiki.maintain({ action: "update", callContext: { model: selectedModel } });
    assert.equal(result.providerAttempts + remainder.providerAttempts, count * 2);
    assert.equal(topic.wikiMaintenance.failureCount, attempt);
    assert.equal(topic.wikiMaintenance.nextRetryAt - f.wiki.time(), 60000 * 2 ** (attempt - 1));
    assert.equal(topic.wikiMaintenance.inputKey, key);
  }
  assert.equal(topic.wikiMaintenance.attempts.length, 4);
  assert.equal(f.calls.cards, 2);
});

test("page budget leaves already-admitted versioned pending work and gives unattempted subjects priority on subsequent requests", async () => {
  const f = await setup(); await f.pipeline.preflight(f.turn(1));
  const base = f.system.topicService.topics.find(topic => topic.wiki);
  for (let n = 0; n < 19; n++) f.system.topicService.topics.push({ ...clone(base), topicId: `pending-${n}`, label: `Pending ${n}`, wiki: undefined, wikiMaintenance: undefined, wikiEvidence: undefined });
  const before = f.requests.length;
  const first = { wikiMaintenance: await f.wiki.maintain({ changedPaperIds: base.paperIds, callContext: { model: selectedModel } }) };
  assert.equal(first.wikiMaintenance.generationCalls, contract.LIMITS.pagesPerRun);
  assert.equal(first.wikiMaintenance.status, "partial");
  const deferred = f.system.topicService.topics.filter(topic => topic.wikiMaintenance?.status === "pending");
  assert.ok(deferred.length >= 11);
  assert.ok(deferred.every(topic => topic.wikiMaintenance.inputKey && topic.wikiEvidence.eligibleFingerprint && topic.wikiMaintenance.dependencies.every(dep => dep.contentHash)));
  const neverAttempted = deferred.filter(topic => !topic.wikiMaintenance.attempts.length).map(topic => topic.topicId);
  const secondStart = f.requests.length;
  await f.pipeline.preflight(f.turn(3));
  assert.ok(f.requests.slice(secondStart).every(request => neverAttempted.includes(request.input.pageId)));
  for (const turn of [4, 5, 6, 7, 8, 9, 10]) await f.pipeline.preflight(f.turn(turn));
  assert.ok(f.system.topicService.topics.filter(topic => topic.wikiAdmission).every(topic => topic.wikiMaintenance.status === "current"));
  assert.equal(new Set(f.requests.slice(before).map(request => request.input.pageId)).size, f.requests.length - before);
  assert.equal(f.calls.cards, 2);
});

test("five-minute maintenance budget continues past two minutes, then defers new jobs until the next request", async () => {
  let f;
  f = await setup({ generate: async input => {
    f.advance(150000);
    return { page: markdownFor(input), configuration: input.configuration, attempts: 1 };
  } });
  const first = await f.pipeline.preflight(f.turn(1));
  assert.equal(first.wikiMaintenance.generationCalls, 1);
  assert.ok(first.wikiMaintenance.pages.some(page => page.reason === "insufficient_remaining_time"));
  f.wiki.generateWikiPage = async input => ({ page: markdownFor(input), configuration: input.configuration, attempts: 1 });
  const next = await f.pipeline.preflight(f.turn(2));
  assert.equal(next.wikiMaintenance.status, "ready");
  assert.equal(f.calls.cards, 2);
});

test("rate limits defer unattempted ingestion pages, but model changes do not reauthorize attempted evidence", async () => {
  const generate = async () => { throw Object.assign(new Error("Limited"), { code: "ProviderRateLimited", providerStatus: 429, retryAfterMs: 180000, attempts: 1 }); };
  const f = await setup({ generate });
  const result = await f.pipeline.preflight(f.turn(1));
  assert.equal(f.requests.length, 1);
  assert.ok(result.wikiMaintenance.pages.some(page => page.reason === "provider_cooldown"));
  const restarted = await setup({ workspace: f.workspace, now: f.wiki.time(), generate });
  await restarted.pipeline.preflight(restarted.turn(2));
  assert.equal(restarted.requests.length, 0);
  restarted.advance(179999);
  await restarted.pipeline.preflight(restarted.turn(3));
  assert.equal(restarted.requests.length, 0);
  restarted.advance(1);
  await restarted.pipeline.preflight(restarted.turn(4));
  assert.equal(restarted.requests.length, 1);
  restarted.wiki.generateWikiPage = async input => ({ page: markdownFor(input), configuration: input.configuration, attempts: 1 });
  const changed = await restarted.pipeline.preflight({ ...restarted.turn(5), callContext: { model: "google/gemma-4-31b-it" } });
  assert.equal(changed.wikiMaintenance.status, "partial");
  assert.equal(restarted.requests.length, 1, "The replacement generator was not invoked for attempted pages");
  assert.equal(restarted.calls.cards, 0);
});

test("failed incorporation and interrupted attempts survive restart with their intent and previous successful revision", async () => {
  const f = await setup(); await f.pipeline.preflight(f.turn(1));
  const topic = f.system.topicService.topics.find(topic => topic.topicId === "thermostability");
  const previous = await f.wiki.read(topic);
  const controller = new AbortController(), analysisRequest = "Incorporate a thermostability analysis into the wiki";
  f.wiki.generateWikiPage = async () => { controller.abort(); throw Object.assign(new Error("Cancelled"), { code: "OPERATION_ABORTED", attempts: 1 }); };
  await assert.rejects(f.wiki.maintain({ action: "incorporate", analysisRequest, signal: controller.signal }), { code: "OPERATION_ABORTED" });
  assert.equal(topic.wikiMaintenance.status, "pending");
  assert.equal(topic.wikiMaintenance.attempts.at(-1).status, "cancelled");
  assert.deepEqual(await f.wiki.read(topic), previous);
  // Simulate the persisted boundary of a process exiting during its provider call.
  topic.wikiMaintenance.status = "running";
  topic.wikiMaintenance.attempts.at(-1).status = "running";
  await f.system.topicService.persist();
  const restarted = await setup({ workspace: f.workspace, now: f.wiki.time() });
  await restarted.pipeline.preflight(restarted.turn("restart-interrupted"));
  assert.equal(restarted.requests.length, 0, "Restart never re-sends an interrupted provider attempt");
  const pending = restarted.system.topicService.topics.find(topic => topic.topicId === "thermostability");
  assert.equal(pending.wikiMaintenance.attempts.at(-1).status, "interrupted");
  await restarted.wiki.maintain({ action: "incorporate", analysisRequest });
  assert.equal(restarted.requests[0].input.analysisRequest, analysisRequest);
  const repaired = restarted.system.topicService.topics.find(topic => topic.topicId === "thermostability");
  assert.equal(repaired.wikiMaintenance.status, "current");
  assert.equal(repaired.wikiMaintenance.attempts.at(-2).status, "interrupted");
  assert.equal(repaired.wiki.history[0].path, topic.wiki.path);
  assert.deepEqual(await f.workspace.readJson(topic.wiki.path), previous);
  assert.equal(restarted.calls.cards, 0);
});

test("committed-page projection failure stays pending and is repaired after restart without an LLM request", async () => {
  const f = await setup();
  const render = f.system.topicService.renderAndIndex.bind(f.system.topicService);
  f.system.topicService.renderAndIndex = async ids => {
    if (f.system.topicService.topics.some(topic => ids.includes(topic.topicId) && topic.wiki)) throw Object.assign(new Error("Index offline"), { code: "QMD_TEST_FAILURE" });
    return render(ids);
  };
  const first = await f.pipeline.preflight(f.turn(1));
  assert.equal(first.wikiMaintenance.status, "partial");
  const topic = f.system.topicService.topics.find(topic => topic.wiki);
  assert.equal(topic.wikiMaintenance.projectionPending, true);
  assert.equal(topic.wikiMaintenance.attempts.at(-1).stage, "projection");
  const key = topic.wiki.key;
  const restarted = await setup({ workspace: f.workspace, now: f.wiki.time() + 60000 });
  const result = await restarted.pipeline.preflight(restarted.turn(2));
  assert.equal(result.wikiMaintenance.status, "ready");
  assert.equal(restarted.requests.length, 0); assert.equal(restarted.calls.cards, 0);
  const repaired = restarted.system.topicService.topics.find(item => item.topicId === topic.topicId);
  assert.equal(repaired.wiki.key, key); assert.equal(repaired.wikiMaintenance.projectionPending, false);
  assert.equal(repaired.wikiMaintenance.status, "current");
  assert.ok(await restarted.workspace.fileExists(`.biodesign/knowledge/topics/${topic.topicId}.md`));
});

test("publication failures persist pending work without replacing the successful revision or exposing stale wiki answers", async () => {
  const f = await setup(); await f.pipeline.preflight(f.turn(1));
  const topic = f.system.topicService.topics.find(topic => topic.topicId === "thermostability");
  const original = await f.wiki.read(topic), path = topic.wiki.path;
  const persist = f.system.topicService.persist.bind(f.system.topicService);
  f.system.topicService.persist = async () => {
    if (topic.wiki.path !== path) throw Object.assign(new Error("Disk error"), { code: "DISK_TEST_FAILURE" });
    return persist();
  };
  const result = await f.wiki.maintain({ action: "incorporate", analysisRequest: "Incorporate another thermostability analysis into the wiki" });
  assert.equal(result.status, "partial");
  assert.equal(topic.wiki.path, path);
  assert.equal(topic.wikiMaintenance.attempts.at(-1).stage, "publication");
  assert.equal(topic.wikiMaintenance.attempts.at(-1).status, "failed");
  assert.deepEqual(await f.wiki.read(topic), original);
  assert.equal([...f.workspace.files.keys()].filter(path => path.startsWith(`.biodesign/knowledge/wiki_pages/${topic.topicId}/`)).length, 1);
  const hit = await f.service.readRetrievedArtifact({ kind: "topic", sourceId: topic.topicId }, "Explain thermostability", {});
  assert.equal(hit.status, "ready", "The unchanged successful revision remains usable when replacement publication fails");
});

test("missing pages alone do not authorize spending, and invalid source scopes fail closed", async () => {
  const f = await setup(); await f.pipeline.preflight(f.turn(1));
  const topic = f.system.topicService.topics.find(topic => topic.topicId === "thermostability");
  await f.workspace.removeFile(topic.wiki.path);
  const before = f.requests.length;
  await f.pipeline.preflight(f.turn(2));
  assert.equal(f.requests.length, before);
  const source = f.system.registry.get(topic.paperIds[0]);
  f.workspace.set(source.path, "Not reconciled yet", Date.now());
  const changed = await f.wiki.maintain({ action: "update" });
  assert.equal(changed.generationCalls, 0);
  assert.ok(changed.pages.every(page => page.validationProblems.includes("stale-source")));
  f.workspace.files.delete(source.path);
  const deleted = await f.wiki.maintain({ action: "update" });
  assert.equal(deleted.generationCalls, 0);
  assert.ok(deleted.pages.every(page => page.validationProblems.includes("missing-source")));
  const writes = f.workspace.writes.length;
  const scoped = await f.wiki.maintain({ repairPending: true, paperIds: [topic.paperIds[1]] });
  assert.equal(scoped.pages.length, 0); assert.equal(scoped.generationCalls, 0);
  assert.equal(f.workspace.writes.length, writes);
  assert.equal(f.calls.cards, 2);
});

test("configuration failures are pending local maintenance, and a recovered configuration reuses valid pages", async () => {
  const f = await setup(); await f.pipeline.preflight(f.turn(1));
  const configure = f.wiki.getPaperCardConfiguration;
  f.wiki.getPaperCardConfiguration = async () => { throw Object.assign(new Error("Config offline"), { code: "CONFIG_TEST_FAILURE" }); };
  const first = await f.pipeline.preflight(f.turn(2));
  assert.equal(first.wikiMaintenance.status, "unavailable");
  assert.equal(first.wikiMaintenance.providerAttempts, 0);
  const state = f.system.topicService.topics.find(topic => topic.wiki).wikiMaintenance;
  assert.equal(state.status, "pending"); assert.equal(state.configuration, null);
  assert.equal(state.requestedModel, selectedModel);
  assert.equal(state.attempts.at(-1).stage, "configuration");
  const before = f.requests.length;
  f.wiki.getPaperCardConfiguration = configure;
  const recovered = await f.pipeline.preflight(f.turn(3));
  assert.equal(recovered.wikiMaintenance.status, "ready");
  assert.equal(f.requests.length, before); assert.equal(f.calls.cards, 2);
});

test("temporary configuration failure preserves an input's provider cooldown; changed evidence has a new attempt version", async () => {
  const f = await setup({ generate: async () => { throw Object.assign(new Error("Unavailable"), { code: "PROVIDER_UNAVAILABLE", providerStatus: 503, attempts: 1 }); } });
  await f.pipeline.preflight(f.turn(1));
  const count = f.requests.length;
  const topic = f.system.topicService.topics.find(topic => topic.topicId === "thermostability");
  const old = clone(topic.wikiMaintenance), configure = f.wiki.getPaperCardConfiguration;
  f.wiki.getPaperCardConfiguration = async () => { throw Object.assign(new Error("Config offline"), { code: "CONFIG_TEST_FAILURE" }); };
  await f.pipeline.preflight(f.turn(2));
  f.wiki.getPaperCardConfiguration = configure;
  const cooling = await f.pipeline.preflight(f.turn(3));
  assert.equal(cooling.wikiMaintenance.generationCalls, 0);
  assert.equal(f.requests.length, count);
  assert.equal(topic.wikiMaintenance.nextRetryAt, old.nextRetryAt);
  assert.equal(topic.wikiMaintenance.lastFailure.code, "PROVIDER_UNAVAILABLE");
  f.wiki.generateWikiPage = async input => ({ page: markdownFor(input), configuration: input.configuration, attempts: 1 });
  f.workspace.set("literature/b.pdf", "EctD enzyme engineering at 42 C: a changed thermostability observation.", Date.now() - 1000);
  const updated = await f.pipeline.preflight(f.turn(4));
  assert.equal(updated.wikiMaintenance.status, "ready");
  assert.notEqual(topic.wikiMaintenance.inputKey, old.inputKey);
  assert.notDeepEqual(topic.wikiMaintenance.dependencies, old.dependencies);
  assert.equal(topic.wikiMaintenance.attempts.at(-1).status, "published");
  assert.equal(f.calls.cards, 3, "Only the changed paper's card was regenerated");
});

test("partially invalid Markdown is saved intact as a draft, while only exact current references can navigate", async () => {
  const f = await setup({ generate: async input => ({ page: contract.markdownPage(`# Flexible prose\n\nA supported observation [[cite:${input.papers[0].evidence[0].reference}]] mixed with an invented target [[cite:invented:p99:missing]].\n\nMalformed [[cite:broken] but this useful prose survives.\n\n[Untrusted paper](../../private.pdf)\n\nAn open question?`), configuration: input.configuration, attempts: 1 }) });
  const first = await f.pipeline.preflight(f.turn("draft"));
  assert.equal(first.report.status, "partial");
  const topic = f.system.topicService.topics.find(topic => topic.wikiDraft);
  assert.equal(topic.wiki, undefined);
  const draft = await f.wiki.readDraftForUse(topic);
  assert.equal(draft.publicationStatus, "unverified_draft");
  assert.match(draft.page.markdown, /invented:p99:missing/);
  assert.equal(draft.integrity.verifiedClaimCount, 0);
  assert.equal(draft.integrity.references.length, 1);
  assert.ok(draft.integrity.unsupportedPassages.some(item => item.code === "UNRESOLVED_CITATION"));
  assert.ok(draft.integrity.unsupportedPassages.some(item => item.code === "MALFORMED_CITATION"));
  const rendered = contract.renderPage(draft.page, draft.integrity);
  assert.match(rendered, /but this useful prose survives/);
  assert.match(rendered, /Unverified/);
  assert.doesNotMatch(rendered, /\[\[cite:invented|\[\[cite:broken|\]\(\.\.\/|biodesign-citation:/);
  assert.equal(await f.wiki.readForUse(topic), null);
  const scope = [draft.dependencies[1].sourceId];
  assert.equal(await f.wiki.readDraftForUse(topic, { paperIds: scope }), null);
  const record = await f.wiki.read(topic, topic.wikiDraft), source = f.system.registry.get(record.dependencies[0].sourceId);
  const bytes = f.workspace.files.get(source.path);
  f.workspace.set(source.path, "Substantively changed bytes", Date.now() - 1000);
  assert.equal(await f.wiki.readDraftForUse(topic), null);
  f.workspace.files.set(source.path, bytes);
  f.workspace.files.delete(source.path);
  assert.equal(await f.wiki.readDraftForUse(topic), null);
});

test("agent tools expose cached cards, unverified drafts and original evidence without regeneration or a planner gate", async () => {
  const f = await setup({ generate: async input => ({ page: contract.markdownPage(`Thermostability observation [[cite:${input.papers[0].evidence[0].reference}]].\n\nUnverified [[cite:made-up:p9:fake]].`), configuration: input.configuration, attempts: 1 }) });
  const first = await f.pipeline.preflight(f.turn("tool-seed"));
  assert.equal(first.report.status, "partial");
  const count = f.requests.length, cards = f.calls.cards;
  f.advance(86400000);
  f.service.semanticInterpreter = { interpret() { throw new Error("No planner gate"); } };
  const options = { ...f.turn("tool-use"), question: "这些文献对热稳定性有什么结论？" };
  const context = await f.service.buildContext(options);
  const result = await f.service.executeAgentTool({ id: "knowledge", name: "search_project_knowledge", args: { query: "thermostability" } }, { turnId: options.turnId });
  assert.equal(result.result.ok, true, JSON.stringify(result));
  assert.equal(result.result.paperCards.length, 2);
  assert.ok(result.result.paperCards.every(card => card.cardIdentity && card.contentHash && card.evidenceType === "paper-card"));
  assert.ok(result.result.knowledge.hits.some(hit => hit.artifact?.status === "draft" && /Unverified saved wiki draft/.test(hit.artifact.content)));
  const draftItem = result.result.evidenceBundle.items.find(item => item.evidenceKind === "wiki");
  assert.equal(draftItem.current, false);
  assert.equal(draftItem.derived, true);
  assert.equal(draftItem.verificationStatus, "unverified");
  assert.ok(draftItem.references.every(ref => !/invented|missing/.test(ref.reference)));
  assert.ok(result.result.evidenceBundle.gaps.some(gap => /unverified/.test(gap)));
  assert.ok(context.citationEvidence.length);
  assert.ok(context.citationEvidence.every(item => !item.reference.includes("made-up")));
  const evidence = await f.service.executeAgentTool({ id: "original", name: "retrieve_project_evidence", args: { query: "temperature", paper_ids: [context.sourceMap.paperSources[0].sourceId] } }, { turnId: options.turnId });
  assert.equal(evidence.result.ok, true);
  assert.match(evidence.result.files[0].content, /(?:30|50) C/);
  const reference = context.citationEvidence[0].reference;
  const answer = await agent.runSideChatAgent({ workspaceContext: { localWorkspaceContext: sanitizeLocalWorkspaceContext(context) },
    originalRequest: options.question, conversationMessages: [{ role: "user", content: options.question }], systemPrompt: "Answer from current evidence.",
    model: selectedModel, projectToolsEnabled: true, parseFinalAnswer: reply => ({ reply }),
    requestTurn: async () => ({ ok: true, message: { content: `研究条件不同，应查阅原文。[[cite:${reference}]]` } }) });
  assert.equal(answer.data.citations[0].status, "resolved");
  assert.equal(answer.data.citations[0].page, 1);
  assert.equal(answer.data.citations[0].sourceId, reference.split(":p")[0]);
  assert.equal(f.requests.length, count); assert.equal(f.calls.cards, cards);
  assert.ok(f.workspace.writes.every(path => path.startsWith(".biodesign/")));
  assert.deepEqual(f.workspace.state.agent.currentRecommendation, { id: "R1" });
});

test("draft validation failure preserves a previous successful revision and does not gain automatic retry on restart", async () => {
  const f = await setup({ generate: async input => ({ page: markdownFor(input), configuration: input.configuration, attempts: 1 }) });
  await f.pipeline.preflight(f.turn("published"));
  const topic = f.system.topicService.topics.find(topic => topic.topicId === "thermostability"), prior = await f.wiki.read(topic);
  f.wiki.generateWikiPage = async input => ({ page: contract.markdownPage("Useful unfinished interpretation [[cite:invented:p1:c]]."), configuration: input.configuration, attempts: 1 });
  const failed = await f.wiki.maintain({ action: "incorporate", analysisRequest: "Incorporate thermostability analysis into the wiki", callContext: { model: selectedModel } });
  assert.equal(failed.status, "partial");
  assert.ok(topic.wikiDraft);
  assert.deepEqual(await f.wiki.read(topic), prior);
  assert.equal((await f.wiki.readForUse(topic)).key, prior.key);
  const restarted = await setup({ workspace: f.workspace, now: f.wiki.time() + 86400000 });
  await restarted.pipeline.preflight(restarted.turn("no-auto-draft"));
  assert.equal(restarted.requests.length, 0); assert.equal(restarted.calls.cards, 0);
  const saved = restarted.system.topicService.topics.find(item => item.topicId === topic.topicId);
  assert.equal((await restarted.wiki.readForUse(saved)).key, prior.key);
  assert.ok(saved.wikiMaintenance.lastFailure);
});

test("missing pages, new prompts, selected models and timestamp-only touches never independently grant automatic wiki calls", async () => {
  const f = await setup(); await f.pipeline.preflight(f.turn("seed-policy"));
  const topic = f.system.topicService.topics.find(topic => topic.wiki), fingerprint = topic.wikiEvidence.fingerprint;
  const originalConfiguration = f.wiki.getPaperCardConfiguration;
  const source = f.system.registry.get(topic.paperIds[0]), bytes = f.workspace.files.get(source.path);
  f.workspace.set(source.path, await bytes.text(), Date.now() - 1000);
  const before = f.requests.length, cards = f.calls.cards;
  const touch = await f.pipeline.preflight(f.turn("touch"));
  assert.equal(touch.report.status, "completed");
  assert.equal(touch.telemetry.changedSourceCount, 0);
  await f.workspace.removeFile(topic.wiki.path);
  await f.pipeline.preflight(f.turn("missing"));
  f.wiki.getPaperCardConfiguration = async (...args) => { const config = await originalConfiguration(...args); return { ...config, wikiConfiguration: { ...config.wikiConfiguration, promptVersion: "new-prompt" } }; };
  await f.pipeline.preflight(f.turn("prompt"));
  f.wiki.getPaperCardConfiguration = originalConfiguration;
  await f.pipeline.preflight({ ...f.turn("model"), callContext: { model: "google/gemma-4-31b-it" } });
  assert.equal(f.requests.length, before); assert.equal(f.calls.cards, cards);
  assert.equal(topic.wikiEvidence.fingerprint, fingerprint);
  assert.ok(topic.wikiEvidence.attemptedFingerprints.includes(fingerprint));
});

test("maintenance deadline aborts an in-flight provider operation without waiting for an uncooperative response", async () => {
  const f = await setup(); let signal;
  f.wiki.generateWikiPage = async (_input, options) => { signal = options.signal; return new Promise(() => {}); };
  await assert.rejects(f.wiki.generateWithinBudget({}, { deadline: f.wiki.time() + 10 }), { code: "WIKI_MAINTENANCE_TIMEOUT", localWikiDeadline: true });
  assert.equal(signal.aborted, true);
});

test("legacy failed-attempt journals migrate without another call for the same evidence", async () => {
  const f = await setup({ generate: async () => { throw Object.assign(new Error("Provider unavailable"), { code: "PROVIDER_UNAVAILABLE", attempts: 1 }); } });
  await f.pipeline.preflight(f.turn("legacy-failure"));
  for (const topic of f.system.topicService.topics) {
    delete topic.wikiEvidence;
    for (const attempt of topic.wikiMaintenance?.attempts || []) delete attempt.evidenceFingerprint;
  }
  await f.system.topicService.persist();
  const restarted = await setup({ workspace: f.workspace, now: f.wiki.time() + 86400000 });
  await restarted.pipeline.preflight(restarted.turn("migrated-failure"));
  assert.equal(restarted.requests.length, 0);
  assert.equal(restarted.calls.cards, 0);
  for (const topic of restarted.system.topicService.topics.filter(topic => topic.wikiMaintenance)) {
    assert.ok(topic.wikiEvidence.attemptedFingerprints.includes(topic.wikiEvidence.fingerprint));
    assert.equal(topic.wikiMaintenance.lastFailure.code, "PROVIDER_UNAVAILABLE");
  }
});
