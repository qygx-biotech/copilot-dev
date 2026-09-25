"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const { createFixture } = require("./helpers/preflight-fixture.js");
const { ProjectContextService } = require("../../docs/project-context-service.js");
const backend = require("../index.js"), agent = require("../side-chat-agent.js"), continuation = require("../agent-continuation.js");
const transcript = require("../../shared/conversation-transcript.js"), tools = require("../../shared/side-chat-tools.js");
const model = "google/gemma-4-31b-it", query = "帮我总结所有文献，写个综述。";
const call = (name, args = {}, id = "tool-1") => ({ id, type: "function", function: { name, arguments: JSON.stringify(args) } });
async function host() {
  const f = await createFixture();
  f.workspace.set("literature/SurfDock.pdf", "SurfDock code availability: https://example.invalid/surfdock. Reliable protein ligand docking.");
  f.workspace.set("literature/Other.pdf", "Other model uses a diffusion method.");
  const service = new ProjectContextService({ workspace: f.workspace, literature: f.literature, sourceSystem: f.system, requestPipeline: f.pipeline,
    semanticInterpreter: { interpret() { throw new Error("Planner must never run"); } } });
  f.literature.api.interpretSemantics = () => { throw new Error("Planner must never run"); };
  const options = { question: query, surface: "side_chat", turnId: "direct-turn", callContext: { model }, language: "en" };
  const context = await service.buildContext(options);
  return { ...f, service, context, options };
}
const run = (local, requestTurn, extra = {}) => agent.runSideChatAgent({ workspaceContext: { localWorkspaceContext: backend._test.sanitizeLocalWorkspaceContext(local, query) },
  originalRequest: query, conversationMessages: [{ role: "user", content: query }], conversationTranscript: transcript.normalize(), turnId: "direct-turn", model,
  systemPrompt: "Answer from current evidence.", parseFinalAnswer: reply => reply ? { reply } : null, projectToolsEnabled: true, requestTurn, ...extra });

test("actual Requesty catalog tool/vision fields enable only the advertised selected-model capabilities", async t => {
  let requests = 0;
  t.mock.method(globalThis, "fetch", async () => {
    requests++;
    return new Response(JSON.stringify({ data: [{ id: "fixture/catalog-model", supports_tool_calling: true, supports_vision: true, supports_web_search: false }] }));
  });
  const api = require("../requesty-models.js"), env = { REQUESTY_API_KEY: "direct-catalog-fixture" };
  assert.deepEqual(await api.agentCapabilities(env, "fixture/catalog-model"), { supportsTools: true, supportsImages: true, supportsWebSearch: false });
  assert.deepEqual(await api.agentCapabilities(env, "fixture/catalog-model", { supportsTools: false }), { supportsTools: false, supportsImages: true, supportsWebSearch: false });
  assert.deepEqual(await api.agentCapabilities(env, "fixture/missing"), { supportsTools: false, supportsImages: false, supportsWebSearch: false });
  assert.equal(requests, 1, "Configuration cache is distinct from inference calls");
});

test("ordinary requests reconcile/invalidate before context, reuse cards, preserve scope, and never invoke a semantic gate", async () => {
  const f = await host();
  assert.equal(f.context.semantic, undefined); assert.equal(f.context.agentLoop.answerLanguage, "zh");
  assert.equal(f.context.files.length, 0); assert.equal(f.calls.cards, 2);
  const next = await f.service.buildContext({ ...f.options, turnId: "next", question: "你好" });
  assert.equal(f.calls.cards, 2); assert.equal(next.agentLoop.version, 1);
  const id = next.sourceMap.paperSources[0].sourceId;
  const selected = await f.service.buildContext({ ...f.options, turnId: "selected", selectedPaperIds: [id] });
  assert.deepEqual(selected.sourceMap.paperSources.map(source => source.sourceId), [id]);
  assert.equal(selected.agentLoop.hardSelection, true);
  const denied = await f.service.executeAgentTool({ id: "denied", name: "retrieve_project_evidence", args: { query: "source code", paper_ids: [next.sourceMap.paperSources[1].sourceId] } }, { turnId: "selected" });
  assert.equal(denied.result.error, "SOURCE_OUTSIDE_SCOPE");
  f.workspace.files.delete(next.sourceMap.paperSources[0].path);
  const removed = await f.service.buildContext({ ...f.options, turnId: "removed", selectedPaperIds: [id] });
  assert.equal(removed.sourceMap.paperSources.length, 0); assert.equal(removed.agentLoop.hardSelection, true);
  f.service.retrieveLayeredKnowledge = () => { throw new Error("An empty hard scope must not open project-wide knowledge"); };
  for (const name of ["search_project_knowledge", "retrieve_project_evidence", "run_corpus_workflow"]) {
    const empty = await f.service.executeAgentTool({ id: name, name, args: name === "run_corpus_workflow" ? {} : { query: "docking" } }, { turnId: "removed" });
    if (name === "run_corpus_workflow") {
      assert.equal(empty.result.ok, true);
      assert.deepEqual(empty.result.evidenceBundle.scope.sourceIds, [id]);
      assert.equal(empty.result.coverage.papersMissing, 1);
      assert.equal(empty.result.coverage.papersSuccessfullyAnalyzed, 0);
      assert.equal(empty.result.evidenceBundle.coverage.complete, false);
    } else assert.equal(empty.result.error, "SOURCE_SCOPE_EMPTY");
  }
  assert.ok(f.workspace.writes.every(path => path.startsWith(".biodesign/")));
  assert.deepEqual(f.workspace.state.agent.currentRecommendation, { id: "R1" });
});

test("model-selected original evidence survives signed continuation, keeps citations and pairing, and replays without reexecution", async () => {
  const f = await host(), paper = f.context.sourceMap.paperSources.find(source => /SurfDock/.test(source.path));
  let count = 0;
  const first = await run(f.context, async request => {
    count++; assert.ok(request.tools.some(tool => tool.function?.name === "run_corpus_workflow"));
    assert.ok(!request.tools.some(tool => tool.function?.name === "update_recommendation"));
    return { ok: true, message: { tool_calls: [call("retrieve_project_evidence", { query: "code availability", paper_ids: [paper.sourceId] })] } };
  }, { originalRequest: "SurfDock有代码吗？", conversationMessages: [{ role: "user", content: "SurfDock有代码吗？" }] });
  assert.equal(first.data.desktopToolCalls.length, 1); assert.equal(count, 1);
  const tool = first.data.desktopToolCalls[0];
  const [result, duplicate] = await Promise.all([f.service.executeAgentTool(tool, { turnId: "direct-turn" }), f.service.executeAgentTool(tool, { turnId: "direct-turn" })]);
  assert.deepEqual(result, duplicate); assert.equal(f.service.agentTurns.get("direct-turn").calls, 1);
  assert.equal(result.result.ok, true, JSON.stringify(result));
  assert.match(result.result.files[0].content, /code availability/);
  assert.equal(f.calls.cards, 2);
  const token = continuation.seal(first.continuationState, { project: "P" }, "fixture");
  const resumed = continuation.withResults(continuation.open(token, { project: "P" }, "fixture"), [result]);
  const reference = f.context.citationEvidence[0].reference;
  const second = await run(f.context, async request => {
    const response = request.messages.find(message => message.role === "tool" && message.tool_call_id === tool.id);
    assert.match(response.content, /example.invalid/);
    return { ok: true, message: { content: `有，见源码说明。[[cite:${reference}]]` } };
  }, { resume: resumed, originalRequest: "SurfDock有代码吗？", conversationMessages: [{ role: "user", content: "SurfDock有代码吗？" }] });
  assert.equal(second.data.citations[0].sourceId, paper.sourceId); assert.equal(second.data.citations[0].page, 1);
  assert.deepEqual(second.data.conversationTurn.messages.map(message => message.role), ["user", "assistant", "tool", "assistant"]);
  await run(f.context, async request => {
    assert.ok(request.messages.some(message => message.role === "tool" && /code availability/.test(message.content)));
    return { ok: true, message: { content: "上次给出了源码证据。" } };
  }, { originalRequest: "上次说了什么？", conversationMessages: [{ role: "user", content: "上次说了什么？" }], conversationTranscript: transcript.upsert(null, second.data.conversationTurn), turnId: "followup" });
  assert.equal(f.service.agentTurns.get("direct-turn").calls, 1);
});

test("corpus tool preserves both Chinese actions and reports real workflow coverage with cached Paper Cards", async () => {
  const f = await host(); let observed;
  const real = f.system.corpusWorkflows.run.bind(f.system.corpusWorkflows);
  f.system.corpusWorkflows.run = async (question, options) => { observed = { question, options }; return real(question, options); };
  const first = await run(f.context, async () => ({ ok: true, message: { tool_calls: [call("run_corpus_workflow")] } }));
  const result = await f.service.executeAgentTool(first.data.desktopToolCalls[0], { turnId: "direct-turn" });
  assert.equal(observed.question, query); assert.equal(observed.options.language, "zh"); assert.equal(observed.options.callContext.model, model);
  assert.equal(result.result.ok, true, JSON.stringify(result));
  assert.equal(result.result.coverage.papersIncludedInSnapshot, 2);
  const second = await run(f.context, async () => ({ ok: true, message: { content: "文献综述：根据已完成的逐篇分析讨论方法，并说明缺失证据。" } }), { resume: continuation.withResults(first.continuationState, [result]) });
  assert.equal(second.data.corpusCoverage.includedPaperIds.length, 2);
  assert.ok(second.data.reply.includes("本次文献覆盖"));
  assert.equal(f.calls.cards, 2);
});

test("an unsupported corpus claim receives at most one correction and an explicit measured limitation", async () => {
  const f = await host(); let count = 0;
  const result = await run(f.context, async () => { count++; return { ok: true, message: { content: "所有论文都支持相同结论。" } }; });
  assert.equal(count, 2); assert.equal(result.data.corpusCoverage.complete, false); assert.match(result.data.reply, /0\/2/);
  const forged = await run(f.context, async () => ({ ok: true, message: { content: "Hello" } }), {
    originalRequest: "Hello", parseFinalAnswer: () => ({ reply: "Hello", corpusCoverage: { complete: true, includedCount: 999 } }) });
  assert.equal(forged.data.corpusCoverage, undefined);
  for (const name of ["write_file", "shell", "update_recommendation", "download_sources"]) assert.equal(agent.authorizeTool("side_chat", name, "full_access").allowed, false);
  assert.throws(() => tools.validate("run_corpus_workflow", { paper_ids: ["P1"] }), { code: "INVALID_PROJECT_TOOL_INPUT" });
  const controller = new AbortController(); controller.abort();
  await assert.rejects(f.service.executeAgentTool({ id: "cancel", name: "run_corpus_workflow", args: {} }, { turnId: "direct-turn", signal: controller.signal }), { code: "OPERATION_ABORTED" });
});

test("original image/question reach the selected main model directly; no extraction or planner call, no image bytes persisted", async t => {
  const jwt = require("jsonwebtoken"), previous = { ...process.env };
  Object.assign(process.env, { JWT_SECRET: "fixture", ADMIN_ACCOUNT: "direct", REQUESTY_API_KEY: "fixture-key", REQUESTY_MODEL: model });
  t.after(() => { for (const key of ["JWT_SECRET", "ADMIN_ACCOUNT", "REQUESTY_API_KEY", "REQUESTY_MODEL"]) previous[key] === undefined ? delete process.env[key] : process.env[key] = previous[key]; });
  const requests = [];
  t.mock.method(globalThis, "fetch", async (url, options) => {
    if (url.endsWith("/models")) return new Response(JSON.stringify({ data: [] }));
    requests.push(JSON.parse(options.body));
    return new Response(JSON.stringify({ choices: [{ message: { content: "这个公式描述邻居信息如何更新节点特征。" }, finish_reason: "stop" }] }));
  });
  const png = "data:image/png;base64," + Buffer.from([137,80,78,71,13,10,26,10,...Array(20).fill(0)]).toString("base64");
  const question = "这张图片里的公式是什么意思？";
  const token = jwt.sign({ account: "direct", role: "admin" }, "fixture");
  const result = await backend.handler({ httpMethod: "POST", path: "/chat", headers: { authorization: `Bearer ${token}` }, body: JSON.stringify({
    mode: "side_chat", model, originalRequest: question, messages: [{ role: "user", content: question }],
    images: [{ name: "formula.png", dataUrl: png }], conversationTranscript: transcript.normalize(),
    localWorkspaceContext: { project: { workspaceId: "P" }, agentLoop: { version: 1 }, semantic: { ir: { INVALID: true } } },
    callContext: { turnId: "image-turn", callRole: "answer", profile: "medium" },
  }) }, {});
  assert.equal(result.statusCode, 200); const data = JSON.parse(result.body);
  assert.equal(data.fallback, false, JSON.stringify(data)); assert.equal(requests.length, 1);
  assert.equal(requests[0].model, model); assert.equal(requests[0].response_format, undefined);
  const parts = requests[0].messages.findLast(message => message.role === "user").content;
  assert.ok(parts.some(part => part.text?.includes(question))); assert.ok(parts.some(part => part.image_url?.url === png));
  assert.ok(!JSON.stringify(data.conversationTurn).includes(png));
  assert.match(data.reply, /公式/);
});

test("successful corpus maps measure every selected source and reuse compatible cards and maps", async () => {
  const f = await host(); let maps = 0;
  f.system.corpusWorkflows.mapWorker = async input => {
    maps++;
    return { relevance: "high", themes: ["docking"], findings: input.evidence.slice(0, 1).map(item => ({ claim: item.claimCandidate, evidenceRefs: [item.evidenceRef] })),
      methods: [], organisms: [], genes: [], proteins: [], pathways: [], experimentalStrategies: [], limitations: [], connectionsToOtherTopics: [] };
  };
  const first = await f.service.executeAgentTool({ id: "complete-corpus", name: "run_corpus_workflow", args: {} }, { turnId: "direct-turn" });
  assert.equal(first.result.ok, true, JSON.stringify(first));
  assert.equal(first.result.coverage.papersSuccessfullyAnalyzed, 2, JSON.stringify(first.result.failures));
  assert.equal(maps, 0, "Compatible Paper Cards avoid extra provider maps");
  const second = await f.service.executeAgentTool({ id: "repeat-corpus", name: "run_corpus_workflow", args: {} }, { turnId: "direct-turn" });
  assert.equal(second.result.coverage.papersSuccessfullyAnalyzed, 2); assert.equal(maps, 0, "Compatible Paper Cards avoid extra provider maps"); assert.equal(f.calls.cards, 2);
});

test("source changes during a selected tool prevent publishing stale findings", async () => {
  const f = await host();
  const original = f.system.preparation.readPaperArtifact.bind(f.system.preparation);
  f.system.preparation.readPaperArtifact = async id => {
    const artifact = await original(id);
    const source = f.system.registry.get(id);
    f.workspace.set(source.path, "Changed evidence after the read with a different length.", Date.now() + 10000);
    return artifact;
  };
  const result = await f.service.executeAgentTool({ id: "changed", name: "retrieve_project_evidence", args: { query: "code", paper_ids: [f.context.sourceMap.paperSources[0].sourceId] } }, { turnId: "direct-turn" });
  assert.equal(result.result.error, "SOURCE_VERSION_CHANGED");
  assert.equal(f.context.files.length, 0); assert.equal(f.context.sourceMap.paperSources.length, 0);
});

test("capability resolution fails closed for unknown models; unsupported tools cannot execute or change models", async t => {
  const capability = require("../requesty-models.js");
  t.mock.method(globalThis, "fetch", async () => new Response(JSON.stringify({ data: [] })));
  const resolved = await capability.agentCapabilities({ REQUESTY_API_KEY: "unknown-fixture" }, "unknown/model");
  assert.deepEqual(resolved, { supportsImages: false, supportsTools: false, supportsWebSearch: false });
  const f = await host(); let round = 0;
  const result = await run(f.context, async request => {
    assert.deepEqual(request.tools, []);
    if (!round++) return { ok: true, message: { tool_calls: [call("read_paper_evidence", { paper_id: f.context.sourceMap.paperSources[0].sourceId })] } };
    assert.match(request.messages.at(-1).content, /MODEL_TOOL_CAPABILITY_UNAVAILABLE/);
    return { ok: true, message: { content: "所选模型不支持工具调用，无法获取所需项目证据。" } };
  }, { supportsTools: false });
  assert.equal(result.semanticTelemetry.modelToolCapabilities.length, 0);
  assert.equal(result.data.conversationTurn.model, model);
});

test("production renderer and authenticated FC resume the same signed project-tool loop without a planner or write permission", async t => {
  const fs = require("node:fs"), vm = require("node:vm"), jwt = require("jsonwebtoken"), previous = { ...process.env };
  Object.assign(process.env, { JWT_SECRET: "direct-renderer", ADMIN_ACCOUNT: "direct-renderer", REQUESTY_API_KEY: "renderer-fixture-key", REQUESTY_MODEL: model });
  t.after(() => { for (const key of ["JWT_SECRET", "ADMIN_ACCOUNT", "REQUESTY_API_KEY", "REQUESTY_MODEL"]) previous[key] === undefined ? delete process.env[key] : process.env[key] = previous[key]; });
  const token = jwt.sign({ account: "direct-renderer", role: "admin" }, "direct-renderer");
  const f = await host(), paper = f.context.sourceMap.paperSources.find(source => /SurfDock/.test(source.path));
  const requests = [], exchanges = [], checkpoints = [];
  t.mock.method(globalThis, "fetch", async (url, options) => {
    if (url.endsWith("/models")) return new Response(JSON.stringify({ data: [] }));
    const request = JSON.parse(options.body); requests.push(request);
    assert.equal(request.model, model); assert.equal(request.response_format, undefined);
    if (requests.length === 1) return new Response(JSON.stringify({ choices: [{ message: { tool_calls: [call("retrieve_project_evidence", { query: "code availability", paper_ids: [paper.sourceId] })] }, finish_reason: "tool_calls" }] }));
    const result = JSON.parse(request.messages.findLast(message => message.role === "tool").content);
    assert.equal(result.ok, true); assert.match(result.files[0].content, /example.invalid/);
    const ref = result.files[0].content.match(/\[\[cite:([^\]]+)\]\]/)[1];
    return new Response(JSON.stringify({ choices: [{ message: { content: `论文提供源码。[[cite:${ref}]]` }, finish_reason: "stop" }] }));
  });
  const source = fs.readFileSync(require.resolve("../../docs/app.js"), "utf8");
  const functions = ["sendWorkbenchRequest", "sendWorkbenchRequestOnce"].map(name => source.match(new RegExp(`^async function ${name}\\([\\s\\S]*?^}$`, "m"))[0]).join("\n");
  const sandbox = vm.createContext({ Response, projectContextService: f.service, workspaceManager: f.workspace, workspaceAbortController: null, authToken: token,
    selectedWorkspacePaths: new Set(), getSelectedPaperIds: () => [], experimentModuleCards: [], referenceDocuments: [], activeSideChatDocumentKeys: [],
    MAX_BROWSER_REFERENCE_FILES: 1, TOTAL_REFERENCE_TEXT_LIMIT: 100, runtimeLog: null, literatureModule: null,
    buildExperimentModulesForRequest: () => ({}), buildFlattenedExperimentDocumentsForRequest: () => [], collectExperimentNotesForRequest: () => [],
    collectSelectedStoredDocumentKeys: () => [], collectStoredDocumentsForRequest: () => [], buildDocumentsForRequest: () => [], getProjectContext: () => "",
    backendUrl: path => path, getAuthHeaders: headers => ({ ...headers, authorization: `Bearer ${token}` }), requireLoginForUnauthorized: () => {}, t: key => key,
    fetch: async (route, options) => {
      assert.equal(route, "/chat"); exchanges.push(JSON.parse(options.body));
      const result = await backend.handler({ httpMethod: "POST", path: "/chat", headers: options.headers, body: options.body }, {});
      assert.equal(result.statusCode, 200, result.body);
      return new Response(result.body, { status: result.statusCode });
    },
    window: { BioDesignEventStream: require("../../shared/event-stream.js"), BioDesignConversationTranscript: transcript },
  });
  vm.runInContext(functions, sandbox);
  const result = await sandbox.sendWorkbenchRequest({ mode: "side_chat", model, originalRequest: "SurfDock有代码吗？", messages: [{ role: "user", content: "SurfDock有代码吗？" }],
    conversationTranscript: transcript.normalize(), onTranscript: turn => checkpoints.push(turn), localWorkspaceContext: f.context, callContext: { turnId: "direct-turn", callRole: "answer", profile: "medium" } });
  assert.equal(requests.length, 2); assert.equal(exchanges.length, 2); assert.ok(exchanges[1].desktopContinuation);
  assert.equal(exchanges[0].desktopTools, undefined); assert.equal(result.citations[0].sourceId, paper.sourceId); assert.equal(result.citations[0].page, 1);
  assert.equal(result.semanticTelemetry.cloudCalls.answer, 2); assert.equal(checkpoints.at(-1).status, "completed");
  assert.deepEqual(checkpoints.at(-1).messages.map(message => message.role), ["user", "assistant", "tool", "assistant"]);
  for (const change of [body => { body.model = "google/gemini-3.1-flash-lite:flex"; }, body => { body.localWorkspaceContext.literature.selectedPaperIds = ["different"]; }, body => { body.mode = "agent_instruction"; }]) {
    const body = structuredClone(exchanges[1]); change(body);
    const denied = await backend.handler({ httpMethod: "POST", path: "/chat", headers: { authorization: `Bearer ${token}` }, body: JSON.stringify(body) }, {});
    assert.equal(denied.statusCode, 400); assert.equal(requests.length, 2);
  }
});
