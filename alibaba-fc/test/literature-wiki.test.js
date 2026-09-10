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
async function setup(options = {}) {
  const f = await createFixture();
  const wiki = f.system.literatureWiki, requests = [];
  wiki.getPaperCardConfiguration = async (_signal, context) => ({ schemaVersion: 2, promptVersion: "fixture-v1", modelSignature: "fixture-model",
    wikiConfiguration: contract.configuration(context?.model || selectedModel) });
  wiki.generateWikiPage = async (input, context) => {
    requests.push({ input: clone(input), context });
    if (options.generate) return options.generate(input, context);
    return { page: pageFor(input), configuration: input.configuration };
  };
  f.workspace.set("literature/a.pdf", "EctD enzyme engineering at 30 C improved thermostability in study Alpha.");
  f.workspace.set("literature/b.pdf", "EctD enzyme engineering at 50 C reduced thermostability in study Beta.");
  const turn = n => ({ turnId: `wiki-turn-${n}`, question: "Explain enzyme engineering concepts.", callContext: { model: selectedModel }, surface: "side_chat" });
  const service = new ProjectContextService({ workspace: f.workspace, literature: f.literature, sourceSystem: f.system, requestPipeline: f.pipeline });
  return { ...f, wiki, requests, turn, service };
}

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
  const context = await f.service.buildContext({ ...f.turn(2), question: "Explain the thermostability concept." });
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
  await f.service.buildContext({ ...f.turn(4), question: "How do I update the literature wiki?" });
  assert.equal(corpusCalls, 0); assert.equal(f.requests.length, before);
});

test("source changes/removal invalidate old claims and failed updates preserve the last valid revision", async () => {
  const f = await setup(); await f.pipeline.preflight(f.turn(1));
  const topic = f.system.topicService.topics.find(topic => topic.topicId === "thermostability");
  const before = clone(topic.wiki), original = await f.workspace.readJson(before.path);
  f.workspace.set("literature/b.pdf", "EctD enzyme engineering new conditions invalidate the previous stability observation.", Date.now());
  f.wiki.generateWikiPage = async () => { throw Object.assign(new Error("Synthetic outage"), { code: "PROVIDER_UNAVAILABLE" }); };
  await f.pipeline.preflight(f.turn(2));
  assert.equal(topic.summaryStatus, "stale"); assert.equal(topic.wiki.path, before.path);
  assert.deepEqual(await f.workspace.readJson(before.path), original);
  f.wiki.generateWikiPage = async input => ({ page: pageFor(input), configuration: input.configuration });
  await f.wiki.maintain({ action: "update", callContext: { model: selectedModel } });
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
  assert.equal(topic.wiki.path, previous); assert.equal(topic.summaryStatus, "stale");
});

test("card content and wiki generation compatibility invalidate without ordinary-query generation", async () => {
  const f = await setup(); await f.pipeline.preflight(f.turn(1));
  const before = f.requests.length, topic = f.system.topicService.topics.find(topic => topic.topicId === "thermostability");
  const source = f.system.registry.list({ sourceKind: "paper" })[0];
  const card = await f.workspace.readJson(source.artifacts.paperCard.path);
  card.summary += " A corrected orientation summary."; await f.workspace.writeJson(source.artifacts.paperCard.path, card);
  await f.pipeline.preflight(f.turn(2));
  assert.equal(f.requests.length, before); assert.equal(topic.summaryStatus, "stale");
  await f.wiki.maintain({ action: "update", callContext: { model: selectedModel } });
  const record = await f.wiki.read(topic); record.configuration.promptVersion = "obsolete-prompt";
  await f.workspace.writeJson(topic.wiki.path, record);
  const after = f.requests.length;
  await f.pipeline.preflight(f.turn(3));
  assert.equal(f.requests.length, after); assert.equal(topic.summaryStatus, "stale");
});

test("concept questions read the maintained L3 through the active connection; precise questions retain L1", async () => {
  const f = await setup(); await f.pipeline.preflight(f.turn(1));
  const before = f.requests.length;
  const context = await f.service.buildContext({ ...f.turn(2), question: "Explain enzyme engineering concepts across studies." });
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
  const precise = await f.service.buildContext({ ...f.turn(3), question: "What exact temperature was reported in the EctD paper?" });
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
    if (options.signal === first.signal) first.abort();
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
  const context = await f.service.buildContext({ ...f.turn(2), question: "Incorporate a thermostability comparison into the literature wiki." });
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
  const context = await f.service.buildContext({ ...f.turn(2), question: "Explain enzyme engineering concepts.", selectedPaperIds: [source.sourceId], selectedPaths: [source.path] });
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
