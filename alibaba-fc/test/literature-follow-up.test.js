"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const { followUpFixture } = require("./helpers/follow-up-fixture.js");
const semantic = require("../../shared/semantic-intent.js");
const { sanitizeLocalWorkspaceContext } = require("../index.js")._test;
const agent = require("../side-chat-agent.js");

test("recent cited papers and exchanges survive host preparation and repeated compaction without changing saved chat", async () => {
  const f = followUpFixture(), saved = JSON.stringify(f.conversation);
  await f.build("What license does it use?");
  const input = f.interpretations[0];
  assert.equal(input.conversationContext.length, 4);
  assert.deepEqual(input.conversationContext.at(-1).paperIds, ["P2"]);
  assert.ok(input.conversationContext.at(-1).content.includes("BetaDock"));
  assert.ok(input.paperCandidates.some(p => p.sourceId === "P2" && p.title === "BetaDock docking study"));
  const { callContext, ...compacted } = input;
  assert.deepEqual(semantic.compactSemanticInput(input), compacted);
  assert.equal(JSON.stringify(f.conversation), saved);
});

test("pronouns and novel follow-ups use the latest cited paper despite parser failure", async t => {
  for (const question of ["Does it provide source code?", "What license does that method use?", "它用什么许可协议？", "这篇的方法是什么？"]) {
    const f = followUpFixture({ parser: "fail" });
    const c = await f.build(question);
    t.diagnostic(`${question}: IDs=${JSON.stringify(c.literature.relevantPaperIds)}, evidence=${c.files.length}, parserCalls=${f.interpretations.length}`);
    assert.deepEqual(c.literature.relevantPaperIds, ["P2"]);
    assert.equal(c.files.length, 1); assert.equal(f.interpretations.length, 1);
    assert.equal(c.literature.referenceResolution.status, "resolved");
  }
});

test("ordinal and comparative references use citation order, while new named papers replace old focus", async () => {
  for (const [query, expected] of [["What method did the second paper use?", ["P2"]], ["前者的数值是多少？", ["P1"]],
    ["Compare their methods.", ["P1", "P2"]], ["Does AlphaDock provide source code?", ["P1"]]]) {
    const f = followUpFixture({ parser: "offline" });
    f.conversation.messages = f.conversation.messages.slice(0, 2);
    const c = await f.build(query);
    assert.deepEqual(c.literature.relevantPaperIds, expected, query);
    assert.equal(c.files.length, expected.length); assert.equal(f.interpretations.length, 0);
  }
});

test("ambiguous paper references request clarification and unrelated UI questions do not inherit literature", async () => {
  const f = followUpFixture({ parser: "malformed" }); f.conversation.messages = f.conversation.messages.slice(0, 2);
  const c = await f.build("What license does it use?");
  assert.deepEqual(c.literature.relevantPaperIds, []); assert.equal(c.files.length, 0);
  assert.equal(c.literature.referenceResolution.status, "reference-unresolved");
  assert.match(c.notices.join("\n"), /clarif/i);
  const ui = await f.build("Change its interface language to Chinese.");
  assert.deepEqual(ui.literature.relevantPaperIds, []); assert.equal(ui.files.length, 0);
  assert.equal(ui.literature.referenceResolution.status, "no-literature-needed");
});

test("a newly named paper wins over an old pronoun focus; explicit comparison retains both sides", async () => {
  for (const [query, expected] of [["For AlphaDock, does it provide source code?", ["P1"]],
    ["AlphaDock这篇用什么方法？", ["P1"]], ["Compare AlphaDock with that method.", ["P1", "P2"]],
    ["把AlphaDock与它比较。", ["P1", "P2"]]]) {
    const f = followUpFixture({ parser: "fail" }), c = await f.build(query);
    assert.deepEqual(c.literature.relevantPaperIds, expected, query);
    assert.deepEqual(c.semantic.ir.scope.papers, expected);
    const kb = agent.createSideChatKnowledgeBase({ localWorkspaceContext: sanitizeLocalWorkspaceContext(c) });
    for (const id of expected) {
      const read = JSON.parse(agent.executeSideChatTool({ function: { name: "read_paper_evidence", arguments: JSON.stringify({ paper_id: id, query: "method" }) } }, kb));
      assert.equal(read.content_available, true, `${query}: ${id}`);
    }
  }
});

test("selected scope never authorizes a historical or newly named paper outside it", async () => {
  for (const query of ["Does it provide source code?", "Does AlphaDock provide it?"]) {
    const f = followUpFixture();
    const c = await f.build(query, { selectedPaperIds: ["P3"] });
    assert.deepEqual(c.literature.relevantPaperIds, [], query);
    assert.equal(c.files.length, 0);
    assert.equal(c.literature.referenceResolution.status, "reference-unresolved");
    const prepared = f.service.buildInterpretationContext(f.conversation, ["P3"]);
    assert.deepEqual(prepared.paperCandidates.map(p => p.sourceId), ["P3"]);
    assert.deepEqual(prepared.conversationContext.at(-1).paperIds, [null]);
  }
  const oldSelected = followUpFixture();
  assert.deepEqual((await oldSelected.build("Does AlphaDock provide it?", { selectedPaperIds: ["P2"] })).literature.relevantPaperIds, []);
  const deletedSelected = followUpFixture(); deletedSelected.literature.documents.splice(2, 1);
  assert.deepEqual((await deletedSelected.build("Does it provide source code?", { selectedPaperIds: ["P3"] })).literature.relevantPaperIds, []);
  const f = followUpFixture();
  const c = await f.build("Compare these papers.", { selectedPaperIds: ["P1", "P3"] });
  assert.deepEqual(c.literature.relevantPaperIds, ["P1", "P3"]);
  assert.equal(c.files.length, 2);
});

test("deleted, foreign-workspace, and unresolved citations cannot be used or shift ordinal positions", async () => {
  for (const invalidate of [f => { f.sources[1].catalogStatus = "missing"; },
    f => { f.conversation.messages[1].citations[1].workspaceId = "OTHER"; },
    f => { f.conversation.messages[1].citations[1].status = "unresolved"; }]) {
    const f = followUpFixture({ parser: "offline" });
    f.conversation.messages = f.conversation.messages.slice(0, 2); invalidate(f);
    const prepared = f.service.buildInterpretationContext(f.conversation);
    assert.deepEqual(prepared.conversationContext.at(-1).paperIds, ["P1", null]);
    const c = await f.build("What did the second paper report?");
    assert.equal(c.files.length, 0); assert.deepEqual(c.literature.relevantPaperIds, []);
    assert.equal(c.literature.referenceResolution.status, "reference-unresolved");
  }
});

test("changed citations remain identity hints and retrieve current original evidence", async () => {
  const f = followUpFixture(); f.sources[1].contentHash = "changed-current-hash";
  const saved = JSON.stringify(f.conversation);
  const c = await f.build("What numerical temperature does it report?");
  assert.equal(f.interpretations[0].paperCandidates.find(p => p.sourceId === "P2").currentness, "changed");
  assert.equal(c.files.length, 1); assert.match(c.files[0].content, /30 degrees Celsius/);
  assert.equal(c.sourceMap.paperSources.find(p => p.sourceId === "P2").contentHash, "changed-current-hash");
  assert.match(c.files[0].content, /changed-current-hash/);
  assert.equal(JSON.stringify(f.conversation), saved);
  assert.ok(f.reads.every(read => read.context.callContext.model === "google/gemma-4-31b-it"));
});

test("source removal and workspace changes during interpretation stop use of old identities", async () => {
  const f = followUpFixture({ parser: input => { f.sources[1].catalogStatus = "missing"; return semantic.interpretLocal(input); } });
  const c = await f.build("What license does it use?");
  assert.equal(c.files.length, 0); assert.equal(c.literature.referenceResolution.status, "reference-unresolved");
  for (const mutate of [g => { g.workspace.workspace = { id: "W2" }; }, g => { g.workspace.workspace.id = "W2"; }]) {
    const g = followUpFixture({ parser: input => { mutate(g); return semantic.interpretLocal(input); } });
    await assert.rejects(g.build("What license does it use?"), { code: "OPERATION_ABORTED" });
    assert.equal(g.reads.length, 0);
  }
});

test("failed interpretation distinguishes unknown reference from no literature needed and permits later recovery", async () => {
  const f = followUpFixture({ parser: "malformed" });
  const unavailable = await f.build("And redistribution?");
  assert.equal(unavailable.literature.referenceResolution.status, "interpretation-unavailable");
  assert.equal(unavailable.files.length, 0);
  f.literature.api.interpretSemantics = async input => {
    f.interpretations.push(input);
    const ir = semantic.interpretLocal(input);
    return { ...ir, objects: ["literature"], operations: ["read"], scope: { ...ir.scope, papers: ["P2"] }, unresolvedSlots: [] };
  };
  const recovered = await f.build("And redistribution?");
  assert.deepEqual(recovered.literature.relevantPaperIds, ["P2"]);
  assert.equal(recovered.files.length, 1); assert.equal(f.interpretations.length, 2);
});

test("invented interpreter IDs are rejected and do not replace a clear current reference", async () => {
  const f = followUpFixture({ parser: input => {
    const ir = semantic.interpretLocal(input); return { ...ir, scope: { ...ir.scope, papers: ["FOREIGN"] } };
  } });
  const c = await f.build("What license does it use?");
  assert.deepEqual(c.literature.relevantPaperIds, ["P2"]);
  assert.equal(c.literature.referenceResolution.interpretation, "unavailable");
  assert.equal(f.interpretations.length, 1); assert.equal(c.files.length, 1);
});

test("cancellation during interpretation propagates without evidence reads", async () => {
  for (const abort of [() => { throw Object.assign(new Error("cancelled"), { name: "AbortError" }); },
    (input, controller) => { controller.abort(); return semantic.interpretLocal(input); }]) {
    const controller = new AbortController(), f = followUpFixture({ parser: input => abort(input, controller) });
    await assert.rejects(f.build("What license does it use?", { signal: controller.signal }), error => error.name === "AbortError" || error.code === "OPERATION_ABORTED");
    assert.equal(f.reads.length, 0);
  }
});

test("clarification status survives sanitation and prevents active-agent paper guessing", async () => {
  const f = followUpFixture({ parser: "malformed" }); f.conversation.messages = f.conversation.messages.slice(0, 2);
  const c = await f.build("What license does it use?");
  const local = sanitizeLocalWorkspaceContext(c);
  assert.equal(local.literature.referenceResolution.status, "reference-unresolved");
  const kb = agent.createSideChatKnowledgeBase({ localWorkspaceContext: local });
  assert.equal(JSON.parse(agent.executeSideChatTool({ function: { name: "read_paper_evidence", arguments: '{"paper_id":"P1"}' } }, kb)).allowed, false);
  let calls = 0;
  const result = await agent.runSideChatAgent({ workspaceContext: { localWorkspaceContext: local },
    conversationMessages: f.conversation.messages.map(({ role, content }) => ({ role, content })),
    originalRequest: "What license does it use?", systemPrompt: "Answer the question", parseFinalAnswer: reply => ({ reply }),
    requestTurn: async ({ messages, tools }) => {
      calls++; assert.ok(!tools.some(tool => tool.function.name === "read_paper_evidence"));
      assert.match(messages.map(m => m.content).join("\n"), /clarify which paper/i);
      return { ok: true, message: { content: "Which paper do you mean, AlphaDock or BetaDock?" } };
    } });
  assert.equal(result.ok, true); assert.equal(calls, 1);
});

test("context stays bounded, preserves citation order beyond truncated text, and keeps known-pattern call counts", async () => {
  const f = followUpFixture();
  f.conversation.messages[3] = f.answer(["P2"], " details".repeat(1000) + " Latest conclusion.");
  const c = await f.build("Explain this paper");
  const input = f.service.buildInterpretationContext(f.conversation);
  assert.equal(input.conversationContext.length, 4);
  assert.equal(input.conversationContext.at(-1).content.length, 500);
  assert.match(input.conversationContext.at(-1).content, /Latest conclusion\.$/);
  assert.deepEqual(input.conversationContext.at(-1).paperIds, ["P2"]);
  assert.deepEqual(semantic.compactSemanticInput(input), input);
  assert.equal(f.interpretations.length, 0); // Existing recognized local recipe stays local.
  assert.equal(c.files.length, 1);
});

test("ordinals refer to the recent comparison, and explicit pairs retain both papers", async () => {
  for (const [query, expected] of [["What method did the first paper use?", ["P1"]], ["第一篇的许可是什么？", ["P1"]],
    ["Compare the first paper with the second paper.", ["P1", "P2"]], ["比较前者和后者的方法。", ["P1", "P2"]],
    ["Do they provide source code?", ["P1", "P2"]]]) {
    const f = followUpFixture({ parser: "offline" }); const c = await f.build(query);
    assert.deepEqual(c.literature.relevantPaperIds, expected, query);
    assert.equal(c.files.length, expected.length);
  }
});

test("valid interpretation can identify an unrelated request or unresolved reference without a keyword route", async () => {
  for (const [override, expected] of [[{ objects: ["project"], unresolvedSlots: [] }, "no-literature-needed"],
    [{ objects: ["literature"], unresolvedSlots: ["paper_reference"] }, "reference-unresolved"]]) {
    const f = followUpFixture({ parser: input => {
      const ir = semantic.interpretLocal(input);
      return { ...ir, ...override, matchedPattern: null, scope: { papers: null, experiments: null } };
    } });
    const c = await f.build("Can I change its color?");
    assert.equal(c.literature.referenceResolution.status, expected);
    assert.equal(c.files.length, 0); assert.equal(f.interpretations.length, 1);
  }
});
