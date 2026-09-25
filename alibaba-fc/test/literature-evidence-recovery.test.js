"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const agent = require("../side-chat-agent.js");
const { sanitizeLocalWorkspaceContext } = require("../index.js")._test;
const { followUpFixture } = require("./helpers/follow-up-fixture.js");
function fixture() {
  const f = followUpFixture();
  f.verifications = [];
  f.literature.preparation.readSourceBytesForUse = async (id, options) => { f.verifications.push({ id, options }); };
  const local = { project: { workspaceName: "Synthetic workspace" }, files: [], knowledge: { hits: [] },
    literature: { selectedPaperIds: [], explicitPaperIds: ["P2"], relevantPaperIds: ["P2"], referenceResolution: { status: "resolved" } },
    sourceMap: { selectedPaperIds: [], paperSources: f.sources.map(s => ({ ...s })) },
    evidenceRecovery: { version: 1, cycle: 0 }, notices: [] };
  return { ...f, local };
}
const call = (paperId = "P2", query = "license", id = "read-1") => ({ id, type: "function", function: { name: "read_paper_evidence", arguments: JSON.stringify({ paper_id: paperId, query }) } });
const run = (local, requestTurn, extra = {}) => agent.runSideChatAgent({
  workspaceContext: { localWorkspaceContext: sanitizeLocalWorkspaceContext(local) },
  conversationMessages: [{ role: "user", content: "Does BetaDock provide source code?" }],
  systemPrompt: "Use original evidence", parseFinalAnswer: reply => ({ reply }), requestTurn, ...extra });

test("registered inventory-only paper emits a structural host request before a refusal answer", async t => {
  const f = fixture(); let calls = 0;
  const kb = agent.createSideChatKnowledgeBase({ localWorkspaceContext: sanitizeLocalWorkspaceContext(f.local) });
  const missing = JSON.parse(agent.executeSideChatTool(call(), kb));
  assert.equal(missing.paper_id, "P2"); assert.equal(missing.error, "PAPER_EVIDENCE_NOT_AVAILABLE");
  const result = await run(f.local, async () => ++calls === 1
    ? { ok: true, message: { tool_calls: [call()] } }
    : { ok: true, message: { content: "The requested evidence was unavailable." } });
  t.diagnostic(`model calls=${calls}; host recovery=${Boolean(result.data?.evidenceRecovery)}; local reads=${f.reads.length}`);
  assert.equal(calls, 1);
  assert.deepEqual(result.data.evidenceRecovery.requests, [{ paperId: "P2", query: "license", reason: "PAPER_EVIDENCE_NOT_AVAILABLE" }]);
  assert.equal(result.data.reply, undefined);
  assert.equal(f.reads.length, 0); // The backend cannot read the local workspace itself.
});

test("a missing passage in otherwise readable evidence requests targeted recovery", async () => {
  const f = fixture();
  f.local.files = [{ sourceId: "P2", paperId: "P2", relativePath: f.sources[1].path, name: "BetaDock.pdf", extension: "pdf", analysisStatus: "processed", evidenceType: "original-paper-evidence", content: "[P2:p1:introduction]\nThis study discusses docking." }];
  f.local.citationEvidence = [{ sourceId: "P2", reference: "P2:p1:introduction", page: 1, contentHash: "hash-P2" }];
  const kb = agent.createSideChatKnowledgeBase({ localWorkspaceContext: sanitizeLocalWorkspaceContext(f.local) });
  assert.equal(JSON.parse(agent.executeSideChatTool(call(), kb)).error, "EVIDENCE_NOT_LOCATED");
  let calls = 0;
  const result = await run(f.local, async () => ++calls === 1 ? { ok: true, message: { tool_calls: [call()] } } : { ok: true, message: { content: "No matching excerpt." } });
  assert.equal(calls, 1);
  assert.equal(result.data.evidenceRecovery.requests[0].reason, "EVIDENCE_NOT_LOCATED");
});

test("project-bound local recovery retains the original model-round budget", async () => {
  const f = fixture(); f.local.project.workspaceId = "bounded-side-chat";
  let calls = 0; const steps = [];
  const first = await run(f.local, async () => {
    calls++;
    return { ok: true, message: { tool_calls: calls === 7 ? [call()] : [{ id: `list-${calls}`, type: "function",
      function: { name: "list_papers", arguments: "{}" } }] } };
  }, { onProgress: async event => { if (event.stage === "model-request") steps.push(event.step); } });
  assert.equal(calls, 7); assert.equal(first.continuationState.step, 7);
  assert.equal(first.continuationState.totalToolCalls, 7);
  f.local.evidenceRecovery = { version: 1, cycle: 1, outcomes: [] };
  const resumed = await run(f.local, async request => {
    calls++;
    if (request.tools.length) return { ok: true, message: { tool_calls: [call("P2", "license", "last-read")] } };
    return { ok: true, message: { content: "The evidence budget is exhausted; the license could not be verified." } };
  }, { resume: first.continuationState, onProgress: async event => { if (event.stage === "model-request") steps.push(event.step); } });
  assert.equal(resumed.ok, true);
  assert.equal(calls, 9, "Eight model rounds plus one no-tools finalization across both HTTP exchanges");
  assert.deepEqual(steps, [1, 2, 3, 4, 5, 6, 7, 8, 9]);
  assert.equal(resumed.semanticTelemetry.cloudCalls.answer, 9);
  assert.equal(resumed.semanticTelemetry.cloudCallsCumulative, true);
  assert.equal(resumed.data.evidenceRecovery, undefined);
});
module.exports = { fixture, call, run };

test("inventory-only paper recovers targeted original L1 and produces a cited answer with one host cycle", async t => {
  const f = fixture(), sent = []; let modelCalls = 0, artifactReads = 0, forbidden = 0;
  const read = f.literature.preparation.readPaperArtifact;
  f.literature.preparation.readPaperArtifact = async id => { artifactReads++; return read(id); };
  f.service.buildContext = f.literature.createPaperCard = async () => { forbidden++; throw new Error("No regeneration"); };
  const saved = JSON.stringify(f.conversation), original = JSON.stringify(f.local);
  const result = await f.service.answerWithEvidenceRecovery({ localWorkspaceContext: f.local,
    callContext: { turnId: "original-turn", model: "google/gemma-4-31b-it" },
    request: async local => {
      sent.push(local);
      let step = 0;
      const result = await run(local, async ({ messages }) => {
        modelCalls++;
        if (++step === 1) return { ok: true, message: { tool_calls: [call()] } };
        const evidence = JSON.parse(messages.find(m => m.role === "tool").content);
        assert.equal(evidence.content_available, true); assert.match(evidence.content, /license is restrictive/);
        return { ok: true, message: { content: "The paper reports a restrictive license [[cite:P2:p4:original]]." } };
      });
      return { ...result.data, semanticTelemetry: result.semanticTelemetry };
    } });
  assert.equal(sent.length, 2); assert.equal(modelCalls, 3); assert.equal(f.reads.length, 1); assert.equal(artifactReads, 1);
  assert.equal(f.verifications.length, 1); assert.equal(forbidden, 0);
  assert.equal(sent[1].evidenceRecovery.cycle, 1);
  assert.equal(result.semanticTelemetry.cloudCalls.answer, 3);
  assert.deepEqual(result.evidenceRecoveryStatus.outcomes.map(x => x.status), ["recovered"]);
  assert.equal(f.reads[0].context.callContext.model, "google/gemma-4-31b-it");
  assert.equal(f.reads[0].context.turnId, "original-turn");
  assert.equal(result.citations[0].sourceId, "P2"); assert.equal(result.citations[0].page, 4);
  assert.equal(result.citations[0].contentHash, "hash-P2");
  assert.equal(JSON.stringify(f.conversation), saved); assert.equal(JSON.stringify(f.local), original);
  assert.ok(sent[1].files.every(file => file.evidenceType === "original-paper-evidence"));
  t.diagnostic(`HTTP exchanges=${sent.length}, recovery=1, model calls=${modelCalls}, L1 prepare/read=${f.reads.length}/${artifactReads}, generations=${forbidden}`);
});

test("normal successful answer stays on one request with no recovery or local preparation", async () => {
  const f = fixture(); let requests = 0;
  const expected = { reply: "An answer that needs no further evidence.", citations: [] };
  assert.equal(await f.service.answerWithEvidenceRecovery({ localWorkspaceContext: f.local,
    request: async () => { requests++; return expected; } }), expected);
  assert.equal(requests, 1); assert.equal(f.reads.length, 0); assert.equal(f.verifications.length, 0);
});

const recoveryReply = (requests = [{ paperId: "P2", query: "license", reason: "EVIDENCE_NOT_LOCATED" }]) => ({ evidenceRecovery: { version: 1, cycle: 0, requests } });

test("equivalent requests are deduplicated; distinct queries and papers respect content and call bounds", async () => {
  for (const requests of [[{ paperId: "P2", query: " license " }, { paperId: "P2", query: "LICENSE" }],
    [{ paperId: "P1", query: "license" }, { paperId: "P2", query: "temperature" }]]) {
    const f = fixture(); f.local.literature.explicitPaperIds = [];
    let calls = 0, resumed;
    await f.service.answerWithEvidenceRecovery({ localWorkspaceContext: f.local, request: async ctx => {
      if (++calls === 1) return recoveryReply(requests.map(q => ({ ...q, reason: "EVIDENCE_NOT_LOCATED" })));
      resumed = ctx; return { reply: "Answer." };
    } });
    const paperCount = new Set(requests.map(q => q.paperId)).size;
    assert.equal(calls, 2); assert.equal(f.reads.length, paperCount);
    assert.equal(resumed.evidenceRecovery.outcomes.length, paperCount);
    assert.ok(resumed.files.every(file => file.content.length <= 4000));
    assert.ok(resumed.files.reduce((n, file) => n + file.content.length, 0) <= 8000);
    assert.ok(resumed.citationEvidence.length <= paperCount * 3);
  }
});

test("failed retrieval and no matching passage yield precise limitations without claiming absence", async () => {
  for (const [query, fail, status] of [["xyzNoMatchingPassage", false, "no-matching-passage"], ["license", true, "retrieval-failed"]]) {
    const f = fixture(); if (fail) f.literature.preparation.readPaperArtifact = async () => { throw new Error("Synthetic read failure"); };
    let calls = 0;
    const response = await f.service.answerWithEvidenceRecovery({ localWorkspaceContext: f.local, request: async ctx => {
      if (++calls === 1) return recoveryReply([{ paperId: "P2", query, reason: "EVIDENCE_NOT_LOCATED" }]);
      assert.equal(ctx.files.length, 0); assert.match(ctx.notices.join("\n"), /never proves absence/);
      return { reply: "I could not verify that from the retrieved evidence." };
    } });
    assert.equal(calls, 2); assert.equal(f.reads.length, 1);
    assert.equal(response.evidenceRecoveryStatus.outcomes[0].status, status);
    assert.match(response.reply, /does not prove/); assert.match(response.reply, /BetaDock/);
  }
});

test("unknown identities, selected-paper violations and changed/deleted sources never trigger local reads", async () => {
  for (const [prepare, requestId, status] of [
    [() => {}, "UNKNOWN", "unknown-source"],
    [f => { f.local.literature.selectedPaperIds = ["P1"]; }, "P2", "outside-scope"],
    [f => { f.sources[1].catalogStatus = "missing"; }, "P2", "source-unavailable"],
    [f => { f.sources[1].contentHash = "changed"; }, "P2", "source-changed"],
  ]) {
    const f = fixture(); prepare(f); let calls = 0;
    const response = await f.service.answerWithEvidenceRecovery({ localWorkspaceContext: f.local, request: async () =>
      ++calls === 1 ? recoveryReply([{ paperId: requestId, query: "license", reason: "EVIDENCE_NOT_LOCATED" }]) : { reply: "The requested source could not be read." } });
    assert.equal(response.evidenceRecoveryStatus.outcomes[0].status, status);
    assert.equal(f.reads.length, 0); assert.equal(f.verifications.length, 0);
  }
});

test("source verification detects changes before extraction and invalidates recovered evidence during resumption", async () => {
  const f = fixture(); f.literature.preparation.readSourceBytesForUse = async () => { f.sources[1].contentHash = "changed"; };
  let calls = 0;
  const result = await f.service.answerWithEvidenceRecovery({ localWorkspaceContext: f.local, request: async () => ++calls === 1 ? recoveryReply() : { reply: "Unable to verify." } });
  assert.equal(result.evidenceRecoveryStatus.outcomes[0].status, "source-changed"); assert.equal(f.reads.length, 0);
  const g = fixture(); calls = 0;
  await assert.rejects(g.service.answerWithEvidenceRecovery({ localWorkspaceContext: g.local, request: async () => {
    if (++calls === 1) return recoveryReply();
    g.sources[1].contentHash = "changed-during-answer"; return { reply: "Must not save this stale answer." };
  } }), { code: "OPERATION_ABORTED" });
});

test("local aliases and malformed or oversized recovery requests are never treated as stable IDs", async () => {
  for (const requests of [
    [{ paperId: "local:3", query: "license", reason: "EVIDENCE_NOT_LOCATED" }],
    [{ paperId: "P2", query: "x".repeat(301), reason: "EVIDENCE_NOT_LOCATED" }],
    Array(3).fill({ paperId: "P2", query: "license", reason: "EVIDENCE_NOT_LOCATED" }),
    [{ paperId: "P2", query: "license", reason: "EVIDENCE_NOT_LOCATED", path: "private/paper.pdf" }],
  ]) {
    const f = fixture(); let calls = 0;
    await assert.rejects(f.service.answerWithEvidenceRecovery({ localWorkspaceContext: f.local, request: async () => { calls++; return recoveryReply(requests); } }), { code: "EVIDENCE_RECOVERY_INVALID" });
    assert.equal(calls, 1); assert.equal(f.reads.length, 0);
  }
  const f = fixture(); let turns = 0;
  const result = await run(f.local, async () => ++turns === 1 ? { ok: true, message: { tool_calls: [call("local:3")] } } : { ok: true, message: { content: "Unknown paper identity; please clarify." } });
  assert.equal(result.data.evidenceRecovery, undefined); assert.equal(turns, 2);
});

test("one initiating turn cannot repeat recovery even when the resumed backend requests it again", async () => {
  const f = fixture(); let calls = 0;
  await assert.rejects(f.service.answerWithEvidenceRecovery({ localWorkspaceContext: f.local,
    request: async () => { calls++; return recoveryReply(); } }), { code: "EVIDENCE_RECOVERY_EXHAUSTED" });
  assert.equal(calls, 2); assert.equal(f.reads.length, 1);
  f.local.evidenceRecovery.cycle = 1;
  let modelCalls = 0;
  const result = await run(f.local, async () => ++modelCalls < 3 ? { ok: true, message: { tool_calls: [call("P2", "license", `read-${modelCalls}`)] } } : { ok: true, message: { content: "Evidence remains unavailable; this is not proof of absence." } });
  assert.equal(result.data.evidenceRecovery, undefined); assert.equal(modelCalls, 3);
});

test("cancellation and workspace/scope changes invalidate recovery before reads, during reads, and after resumption", async () => {
  for (const phase of ["before", "initial", "verify", "read", "resume", "workspace", "scope", "identity"]) {
    const f = fixture(), controller = new AbortController(); let calls = 0, current = true;
    if (phase === "before") controller.abort();
    if (phase === "verify") f.literature.preparation.readSourceBytesForUse = async () => { controller.abort(); };
    if (phase === "read") f.literature.preparation.readPaperArtifact = async () => { controller.abort(); return { chunks: [] }; };
    await assert.rejects(f.service.answerWithEvidenceRecovery({ localWorkspaceContext: f.local, signal: controller.signal, isCurrent: () => current, request: async () => {
      calls++;
      if (phase === "initial" || (phase === "resume" && calls === 2)) controller.abort();
      if (phase === "workspace") f.workspace.workspace = { id: "W1" };
      if (phase === "scope") f.local.literature.selectedPaperIds = ["P1"];
      if (phase === "identity") current = false;
      return calls === 1 ? recoveryReply() : { reply: "Must not save." };
    } }), { code: "OPERATION_ABORTED" }, phase);
    assert.equal(calls, phase === "before" ? 0 : phase === "resume" ? 2 : 1, phase);
  }
});

test("readable normal evidence needs no recovery; one failed tool batch emits at most two distinct requests", async () => {
  const f = fixture(); let modelCalls = 0, httpRequests = 0;
  f.local.files = [{ sourceId: "P2", paperId: "P2", relativePath: f.sources[1].path, name: "BetaDock.pdf", extension: "pdf", analysisStatus: "processed", evidenceType: "original-paper-evidence", content: "[P2:p4:original]\nA restrictive license is provided." }];
  f.local.citationEvidence = [{ sourceId: "P2", reference: "P2:p4:original", page: 4, contentHash: "hash-P2" }];
  await f.service.answerWithEvidenceRecovery({ localWorkspaceContext: f.local, request: async context => {
    httpRequests++;
    const result = await run(context, async () => ++modelCalls === 1 ? { ok: true, message: { tool_calls: [call()] } } : { ok: true, message: { content: "A license is provided [[cite:P2:p4:original]]." } });
    return result.data;
  } });
  assert.equal(httpRequests, 1); assert.equal(modelCalls, 2); assert.equal(f.reads.length, 0);
  f.local.files = []; f.local.literature.explicitPaperIds = []; modelCalls = 0;
  const missing = await run(f.local, async () => { modelCalls++; return { ok: true, message: { tool_calls: [call("P2", "license", "a"), call("P2", " LICENSE ", "b"), call("P1", "license", "c"), call("P3", "license", "d")] } }; });
  assert.equal(modelCalls, 1);
  assert.deepEqual(missing.data.evidenceRecovery.requests.map(item => item.paperId), ["P2", "P1"]);
});
