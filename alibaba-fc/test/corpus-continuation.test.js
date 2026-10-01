"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), vm = require("node:vm"), jwt = require("jsonwebtoken");
const backend = require("../index.js"), agent = require("../side-chat-agent.js");
const { createFixture } = require("./helpers/preflight-fixture.js");
const { ProjectContextService } = require("../../docs/project-context-service.js");
const { createRuntimeLogger } = require("../../docs/runtime-log.js");
const transcript = require("../../shared/conversation-transcript.js");
const model = "google/gemma-4-31b-it", question = "帮我总结所有文献，写个综述。";
const requirement = { task: "literature_review", coverage: "exhaustive", granularity: "concept", claimSupport: "required",
  scope: { type: "project" }, domains: ["literature"], freshness: "current" };
const call = { id: "call_corpus_fixture", type: "function", function: { name: "run_corpus_workflow", arguments: JSON.stringify({ requirement }) } };
const reply = content => new Response(JSON.stringify({ choices: [{ message: { content }, finish_reason: "stop" }] }));

// Exercise production renderer -> authenticated FC -> signed desktop handoff ->
// actual local collection -> FC -> Requesty HTTP adapter (provider is a fixture).
async function run(t, respond, { quotaBeforeTool = false } = {}) {
  const root = fs.mkdtempSync(require("node:path").join(require("node:os").tmpdir(), "corpus-context-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const keys = ["JWT_SECRET", "ADMIN_ACCOUNT", "REQUESTY_API_KEY", "REQUESTY_MODEL", "CONTEXT_ARCHIVE_DIR"];
  const previous = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  Object.assign(process.env, { JWT_SECRET: "corpus-resume", ADMIN_ACCOUNT: "corpus-resume", REQUESTY_API_KEY: "corpus-fixture-key", REQUESTY_MODEL: model, CONTEXT_ARCHIVE_DIR: root });
  t.after(() => keys.forEach(key => previous[key] === undefined ? delete process.env[key] : process.env[key] = previous[key]));
  const token = jwt.sign({ account: "corpus-resume", role: "admin" }, "corpus-resume");
  const f = await createFixture();
  for (let i = 1; i <= 3; i++) f.workspace.set(`literature/P${i}.pdf`,
    (`Paper ${i} reports ectoine production using methane at pH ${6 + i}. Salinity affects osmotic stress. `).repeat(180));
  f.system.corpusWorkflows.mapWorker = () => { throw Error("No per-paper provider calls"); };
  const service = new ProjectContextService({ workspace: f.workspace, literature: f.literature, sourceSystem: f.system, requestPipeline: f.pipeline });
  const local = await service.buildContext({ question, surface: "side_chat", turnId: "corpus-resume", callContext: { model }, language: "zh" });
  const cards = f.calls.cards, requests = [], exchanges = [], checkpoints = [];
  const priorSource = local.sourceMap.paperSources[0];
  const priorCall = { id: "prior-read", type: "function", function: { name: "retrieve_project_evidence", arguments: JSON.stringify({ paper_ids: [priorSource.sourceId] }) } };
  const history = quotaBeforeTool ? transcript.upsert(null, { turnId: "prior-review", workspaceId: local.project.workspaceId, model, status: "completed",
    bindings: [{ handle: priorSource.sourceId, identity: `source:${priorSource.sourceId}`, sourceId: priorSource.sourceId, version: priorSource.contentHash, current: true }],
    messages: [{ role: "user", content: question }, { role: "assistant", tool_calls: [priorCall] },
      { role: "tool", tool_call_id: priorCall.id, name: priorCall.function.name, content: JSON.stringify({ sourceId: priorSource.sourceId,
        contentHash: priorSource.contentHash, text: "Historical derived evidence. ".repeat(1500) }) },
      { role: "assistant", content: "Earlier review; historical derived context." }] }) : transcript.normalize();
  let configurationRequests = 0, originalEvidence;
  t.mock.method(globalThis, "fetch", async (url, options) => {
    if (url.endsWith("/models")) { configurationRequests++; return new Response(JSON.stringify({ data: [] })); }
    const request = JSON.parse(options.body); requests.push(request);
    assert.equal(request.model, model); assert.equal(request.response_format, undefined);
    assert.ok(request.messages.some(message => message.role === "user" && message.content.includes(question)));
    if (quotaBeforeTool && requests.length === 1) return new Response(JSON.stringify({ error: { message:
      "Quota exceeded for metric: generativelanguage.googleapis.com/generate_content_paid_tier_3_input_token_count, limit: 16000. Retry in 0s." } }), { status: 429 });
    if (requests.length === (quotaBeforeTool ? 2 : 1)) return new Response(JSON.stringify({ choices: [{ message: { tool_calls: [call] }, finish_reason: "tool_calls" }] }));
    const tool = request.messages.findLast(message => message.role === "tool");
    assert.equal(tool.tool_call_id, call.id);
    assert.ok(request.messages.some(message => message.tool_calls?.some(item => item.id === tool.tool_call_id)));
    const view = JSON.parse(tool.content);
    if (!view.contextArchive) originalEvidence = view;
    else { assert.ok(view.omitted); assert.match(view.contextArchive, /^[a-f0-9]{64}$/); }
    const evidence = view.contextArchive ? originalEvidence : view;
    assert.equal(evidence.findings.papers.length, 3);
    assert.equal(evidence.coverage.papersSuccessfullyAnalyzed, 3);
    for (const paper of evidence.findings.papers) {
      assert.ok(paper.contentHash); assert.ok(paper.originalEvidence.length);
      assert.ok(paper.originalEvidence.every(item => item.reference.startsWith(`${paper.sourceId}:p`) && item.page === 1));
    }
    const final = () => reply(`逐篇总结与综述：三篇论文讨论了甲烷与渗透压。${evidence.findings.papers.map(paper => `[[cite:${paper.originalEvidence[0].reference}]]`).join(" ")}`);
    return respond ? respond(requests.length, request, final) : final();
  });
  const source = fs.readFileSync(require.resolve("../../docs/app.js"), "utf8");
  const functions = ["sendWorkbenchRequest", "sendWorkbenchRequestOnce"].map(name => source.match(new RegExp(`^async function ${name}\\([\\s\\S]*?^}$`, "m"))[0]).join("\n");
  const log = createRuntimeLogger({ sink: null, heartbeatMs: 0 });
  const sandbox = vm.createContext({ Response, projectContextService: service, workspaceManager: f.workspace, workspaceAbortController: null, authToken: token,
    selectedWorkspacePaths: new Set(), getSelectedPaperIds: () => [], experimentModuleCards: [], referenceDocuments: [], activeSideChatDocumentKeys: [],
    MAX_BROWSER_REFERENCE_FILES: 1, TOTAL_REFERENCE_TEXT_LIMIT: 100, runtimeLog: log, literatureModule: null,
    buildExperimentModulesForRequest: () => ({}), buildFlattenedExperimentDocumentsForRequest: () => [], collectExperimentNotesForRequest: () => [],
    collectSelectedStoredDocumentKeys: () => [], collectStoredDocumentsForRequest: () => [], buildDocumentsForRequest: () => [], getProjectContext: () => "",
    backendUrl: path => path, getAuthHeaders: headers => ({ ...headers, authorization: `Bearer ${token}` }), requireLoginForUnauthorized: () => {}, t: key => key,
    fetch: async (route, options) => {
      exchanges.push(JSON.parse(options.body));
      const response = await backend.handler({ httpMethod: "POST", path: route, headers: options.headers, body: options.body });
      return new Response(response.body, { status: response.statusCode });
    }, window: { BioDesignEventStream: require("../../shared/event-stream.js"), BioDesignConversationTranscript: transcript },
  });
  vm.runInContext(functions, sandbox);
  const result = await sandbox.sendWorkbenchRequest({ mode: "side_chat", model, originalRequest: question, messages: [{ role: "user", content: question }],
    conversationTranscript: history, onTranscript: turn => checkpoints.push(turn), localWorkspaceContext: local,
    callContext: { turnId: "corpus-resume", callRole: "answer", profile: "medium" } });
  assert.equal(exchanges.length, 2); assert.ok(exchanges[1].desktopContinuation);
  assert.equal(service.agentTurns.get("corpus-resume").calls, 1, "recovery must not reexecute collection");
  assert.equal(f.calls.cards, cards); assert.equal(cards, 0, "Corpus requests prepare no cards before or during the tool");
  assert.ok(f.workspace.writes.every(path => path.startsWith(".biodesign/")));
  assert.deepEqual(f.workspace.state.agent.currentRecommendation, { id: "R1" });
  assert.equal(result.semanticTelemetry.providerAttempts, requests.length);
  assert.doesNotMatch(log.exportText(), /Paper 1 reports|甲烷|Bearer|corpus-fixture-key/);
  return { result, requests, exchanges, checkpoints, log, configurationRequests };
}

test("three-paper Chinese review sends collected evidence to the same model and preserves the full receipt", async t => {
  const f = await run(t);
  assert.equal(f.requests.length, 2);
  assert.equal(f.result.fallback, false); assert.match(f.result.reply, /逐篇总结与综述/);
  assert.equal(f.result.citations.filter(citation => citation.sourceId).length, 3);
  const saved = f.checkpoints.at(-1).messages.find(message => message.role === "tool");
  const sent = f.requests[1].messages.find(message => message.role === "tool");
  assert.equal(sent.content, saved.content, "initial provider attempt receives the complete bounded receipt");
  assert.ok(JSON.parse(saved.content).knowledge, "full original receipt stays persisted");
  assert.equal(f.checkpoints.at(-1).status, "completed");
  assert.ok(f.log.entries().some(item => item.event === "backend.transcript-diagnostics" && item.details.providerAttempts === 2));
});

test("quota retry before corpus handoff preserves evidence; repeated quota after handoff stops unchanged", async t => {
  const f = await run(t, () => new Response(JSON.stringify({ error: { message:
    "Quota exceeded for metric: generate_content_input_token_count, limit: 16000. Retry in 0s." } }), { status: 429 }), { quotaBeforeTool: true });
  assert.equal(f.requests.length, 4);
  assert.equal(f.result.fallback, true);
  assert.deepEqual(f.requests[0], f.requests[1]);
  assert.deepEqual(f.requests[2], f.requests[3]);
  assert.equal(f.log.entries().filter(entry => entry.event === "backend.context-compacted").length, 0);
  assert.equal(f.checkpoints.at(-1).messages.find(message => message.tool_call_id === call.id).content,
    f.requests[2].messages.find(message => message.tool_call_id === call.id).content);
});

for (const kind of ["context"]) test(`${kind}: resumed persisted transcript actually shrinks on one bounded retry`, async t => {
  const f = await run(t, (count, request, final) => count === 2
    ? new Response(JSON.stringify({ error: { message: kind === "context" ? "context_length_exceeded" :
      "Quota exceeded for metric: generate_content_input_token_count, limit: 12000. Please retry in 0s." } }), { status: kind === "context" ? 400 : 429 }) : final());
  assert.equal(f.requests.length, 3); assert.equal(f.result.fallback, false);
  const before = JSON.stringify(f.requests[1].messages).length, after = JSON.stringify(f.requests[2].messages).length;
  assert.ok(after < before * 0.9, `${after} must be smaller than ${before}`);
  const compacted = JSON.parse(f.requests[2].messages.find(message => message.role === "tool").content);
  assert.ok(compacted.contextArchive); assert.equal(compacted.omitted, true);
  assert.match(compacted.preview, /coverage/);
  const saved = f.checkpoints.at(-1).messages.find(message => message.role === "tool");
  assert.ok(saved.content.length > f.requests[2].messages.find(message => message.role === "tool").content.length);
});

test("empty corpus answer gets one final-answer retry without rerunning local work", async t => {
  const f = await run(t, (count, request, final) => count === 2 ? reply(null) : final());
  assert.equal(f.requests.length, 3); assert.equal(f.result.fallback, false);
});

for (const kind of ["empty", "quota", "rejected", "context", "network"]) test(`${kind}: failure reports the actual stage in Chinese without claiming a completed review`, async t => {
  const f = await run(t, () => {
    if (kind === "network") throw new Error("PRIVATE_EVIDENCE_SENTINEL");
    return kind === "empty" ? reply(null) : new Response(JSON.stringify({ error: { message: `${kind === "context" ? "context_length_exceeded " : ""}PRIVATE_EVIDENCE_SENTINEL`, code: kind === "quota" ? "insufficient_quota" : "invalid_request" } }),
      { status: kind === "quota" ? 429 : 400, headers: { "x-request-id": "fixture-upstream-id" } });
  });
  assert.equal(f.requests.length, ["empty", "context", "network"].includes(kind) ? 3 : 2);
  assert.equal(f.result.fallback, true); assert.equal(f.result.taskOutcome.status, "incomplete");
  assert.match(f.result.reply, /未能完成本次回答/); assert.doesNotMatch(f.result.reply, /safe fallback|成功分析|PRIVATE_EVIDENCE_SENTINEL/);
  assert.equal(f.result.failure.category, kind === "empty" ? "provider_content" : kind === "network" ? "provider_transport" : "provider_rejection");
  assert.equal(f.result.failure.providerStatus, ["empty", "network"].includes(kind) ? undefined : kind === "quota" ? 429 : 400);
  if (!["empty", "network"].includes(kind)) assert.equal(f.result.failure.requestId, "fixture-upstream-id");
  assert.equal(f.checkpoints.at(-1).status, "failed");
  assert.ok(f.checkpoints.at(-1).messages.some(message => message.role === "tool"));
  assert.equal(f.log.entries().at(-1).event, "main-agent.failed");
  assert.ok(f.log.entries().some(item => item.event === "main-agent.failure" && item.details.code === f.result.error));
});

test("cancelling a provider cooldown prevents the synthesis retry from making a request", async t => {
  let calls = 0;
  t.mock.method(globalThis, "fetch", async () => { calls++; return reply("unexpected"); });
  const controller = new AbortController();
  const pending = backend._test.requestRequestyMessage({ model, messages: [{ role: "user", content: question }] }, "fixture", false, null,
    { signal: controller.signal, retryAfterMs: 60000, stage: "local-tools" });
  controller.abort();
  await assert.rejects(pending, { code: "OPERATION_ABORTED" });
  assert.equal(calls, 0);
});

test("corpus compaction preserves complete JSON, all sources/versions/references, and never mutates the saved receipt", () => {
  const value = { ok: true, collectionMode: "local-evidence", findings: { papers: Array.from({ length: 25 }, (_, i) => ({
    sourceId: `P${i}`, contentHash: `hash-${i}`, originalEvidence: [{ reference: `P${i}:p2:chunk`, page: 2, text: "Evidence ".repeat(500) }]
  })) }, coverage: { papersIncludedInSnapshot: 25, papersSuccessfullyAnalyzed: 25 }, evidenceBundle: { items: [] } };
  const content = JSON.stringify(value), messages = [{ role: "system", content: "Protected instructions" }, { role: "user", content: question },
    { role: "assistant", tool_calls: [call] }, { role: "tool", tool_call_id: call.id, content }];
  const result = agent.compactSideChatAgentMessages(messages, question, 18000);
  const compacted = JSON.parse(result.at(-1).content);
  assert.equal(messages.at(-1).content, content);
  assert.equal(compacted.findings.papers.length, 25); assert.deepEqual(compacted.coverage, value.coverage);
  assert.deepEqual(compacted.findings.papers.map(paper => [paper.sourceId, paper.contentHash, paper.originalEvidence[0].reference]), value.findings.papers.map(paper => [paper.sourceId, paper.contentHash, paper.originalEvidence[0].reference]));
  assert.ok(result.at(-1).content.length < content.length / 2);
});

 test("input-token quota retries unchanged evidence after provider backoff, without context compaction", async t => {
  const f = await run(t, (count, request, final) => count === 2
    ? new Response(JSON.stringify({ error: { message: "Quota exceeded for metric: generate_content_input_token_count, limit: 12000. Please retry in 0s." } }), { status: 429 }) : final());
  assert.equal(f.requests.length, 3); assert.equal(f.result.fallback, false);
  assert.deepEqual(f.requests[1].messages, f.requests[2].messages);
 });

test("repeated input-token quota stops unchanged and preserves actual measured corpus coverage", async t => {
  const f = await run(t, () => new Response(JSON.stringify({ error: { message: "Quota exceeded for metric: generate_content_input_token_count, limit: 12000. Please retry in 0s." } }), { status: 429 }));
  assert.equal(f.requests.length, 3); assert.equal(f.result.fallback, true);
  assert.deepEqual(f.requests[1].messages, f.requests[2].messages);
  const before = JSON.parse(f.requests[2].messages.find(message => message.role === "tool").content);
  assert.equal(before.coverage.papersSuccessfullyAnalyzed, 3);
  assert.equal(f.result.semanticTelemetry.providerAttempts, 3);
  assert.equal(f.checkpoints.at(-1).messages.find(message => message.role === "tool").content, JSON.stringify(before));
});
