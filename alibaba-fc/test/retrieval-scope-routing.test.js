// Planned-context cases below exercise the retained optional helper, not the direct Side Chat entry point.
"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), { webcrypto } = require("node:crypto");
const semantic = require("../../shared/semantic-intent.js");
const { ProjectContextService } = require("../../docs/project-context-service.js");
const { ElectronQmdKnowledgeService } = require("../../docs/knowledge-service.js");
const { LiteratureApiClient } = require("../../docs/literature-module.js");
const { CLOUD_RETRIEVAL } = require("../../shared/retrieval-contract.js");
const { createFixture } = require("./helpers/preflight-fixture.js");
const { followUpFixture } = require("./helpers/follow-up-fixture.js");
const { runSideChatAgent } = require("../side-chat-agent.js");
const backend = require("../index.js"), jwt = require("jsonwebtoken");
const model = "google/gemini-3.1-flash-lite:flex";
const url = "https://papers.example.org/new-paper.pdf";

function modelIR(input, scope, download = false) {
  const local = semantic.interpretLocal(input);
  if (scope === "workspace" && local.matchedPattern === "literature.corpus_synthesis") return { ...local, retrievalScope: scope };
  return { ...local, retrievalScope: scope, matchedPattern: null, patternConfidence: 0.95,
    // Deliberately retain the old ambiguous literature hint: scope must win.
    objects: scope === "none" ? [] : ["literature"],
    operations: scope === "none" ? ["explain"] : ["search", ...(download ? ["store"] : [])],
    scope: { papers: input.activeScope?.paperIds?.length ? input.activeScope.paperIds : "current-project", experiments: null },
    capabilityHints: scope === "none" ? [] : ["search_papers", ...(download ? ["download_sources"] : [])], unresolvedSlots: [],
  };
}

test.beforeEach(t => {
  const runtimeLog = globalThis.BioDesignRuntimeLog;
  t.after(() => { if (runtimeLog === undefined) delete globalThis.BioDesignRuntimeLog; else globalThis.BioDesignRuntimeLog = runtimeLog; });
  const env = { ADMIN_ACCOUNT: "scope-routing", JWT_SECRET: "scope-routing-jwt", REQUESTY_API_KEY: "scope-routing-fixture-key", REQUESTY_MODEL: model };
  const previous = Object.fromEntries(Object.keys(env).map(key => [key, process.env[key]]));
  Object.assign(process.env, env);
  t.after(() => { for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } });
});

async function fixture(t, scope, download = false, rawIR) {
  const f = await createFixture();
  f.workspace.set("literature/a.pdf", "EctD engineering original evidence.");
  f.workspace.set("literature/b.pdf", "EctD engineering comparison evidence.");
  await f.pipeline.preflight({ surface: "agent_command", turnId: "setup" });
  const papers = f.system.registry.list({ sourceKind: "paper" });
  const events = [], routingLogs = [], semanticRequests = [];
  t.mock.method(globalThis, "fetch", async (endpoint, options) => {
    assert.equal(endpoint, "https://router.requesty.ai/v1/chat/completions");
    const request = JSON.parse(options.body); semanticRequests.push(request); events.push("semantic");
    assert.equal(request.response_format.type, "json_schema");
    assert.deepEqual(request.response_format.json_schema.schema.properties.retrievalScope.enum, ["workspace", "web", "both", "none"]);
    assert.ok(request.response_format.json_schema.schema.required.includes("retrievalScope"));
    assert.match(request.messages[0].content, /Infer retrievalScope from the meaning/);
    const ir = rawIR || modelIR(JSON.parse(request.messages[1].content), scope, download);
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(ir) }, finish_reason: "stop" }] }));
  });
  const token = jwt.sign({ account: process.env.ADMIN_ACCOUNT, role: "admin" }, process.env.JWT_SECRET);
  const client = new LiteratureApiClient({ baseUrl: "https://fc.example.org", getHeaders: () => ({ Authorization: `Bearer ${token}` }), fetch: async (endpoint, options) => {
    const result = await backend.handler({ httpMethod: "POST", path: new URL(endpoint).pathname, headers: options.headers, body: options.body }, {});
    assert.equal(result.statusCode, 200, result.body);
    return new Response(result.body, { status: result.statusCode, headers: result.headers });
  } });
  f.literature.api.interpretSemantics = client.interpretSemantics.bind(client);
  const engine = new ElectronQmdKnowledgeService({ cryptoProvider: webcrypto,
    desktop: { knowledge: { onProgress: () => () => {}, initialize: async () => ({ available: true }),
      search: async input => { events.push("qmd"); return { results: papers.map((paper, index) => ({ paperId: paper.sourceId, title: paper.displayName,
        score: 0.9 - index / 10, matchedSections: [{ snippet: "EctD engineering evidence", score: 0.8, page: 1 }] })) }; },
    } },
    cloudApi: {
      getKnowledgeRetrievalConfig: async () => ({ ok: true, schemaVersion: CLOUD_RETRIEVAL.schemaVersion, searchPlanPromptVersion: CLOUD_RETRIEVAL.searchPlanPromptVersion,
        rerankPromptVersion: CLOUD_RETRIEVAL.rerankPromptVersion, plannerSignature: "a".repeat(64), rerankerSignature: "b".repeat(64) }),
      planKnowledgeSearch: async () => { events.push("lexical-planner"); return { ok: true, configurationSignature: "a".repeat(64), plan: { queries: ["EctD engineering"], identifiers: ["EctD"], sourceLanguage: "en", reasoningSummary: "Scientific evidence" } }; },
      rerankKnowledgeCandidates: async payload => { events.push("candidate-reranker"); return { ok: true, configurationSignature: "b".repeat(64), ranked: payload.candidates.map(candidate => ({ candidateId: candidate.candidateId, score: 0.9, reason: "Relevant evidence" })) }; },
    },
  });
  await engine.initialize({ workspaceId: f.workspace.workspace.workspaceId });
  f.system.literatureTools.knowledgeService = engine;
  const service = new ProjectContextService({ workspace: f.workspace, literature: f.literature });
  for (const name of ["matchPapers", "retrieveLayeredKnowledge", "retrievePaperEvidence"]) {
    const original = service[name].bind(service);
    t.mock.method(service, name, (...args) => { events.push(name); return original(...args); });
  }
  globalThis.BioDesignRuntimeLog = { begin: () => () => {}, record: (name, data) => { if (name === "retrieval.routing") routingLogs.push(data); } };
  return { ...f, service, events, routingLogs, semanticRequests, papers };
}

const cases = [
  ["帮我检索一下AI和合成生物学结合的文献并下载。", "web", true],
  ["Search the web for recent EctD papers.", "web", false],
  ["Find papers in this project about EctD.", "workspace", false],
  ["Summarize all uploaded papers.", "workspace", false],
  ["Compare recent EctD research with my existing papers.", "both", false],
  ["Explain what ectoine is.", "none", false],
  ["在我的项目里找一下讨论EctD的论文。", "workspace", false],
  ["对比最新EctD研究和我项目里的论文。", "both", false],
];
for (const [question, scope, download] of cases) test(`scope routing: ${scope} — ${question}`, async t => {
  const f = await fixture(t, scope, download);
  const before = { ...f.calls };
  const context = await f.service.buildPlannedContext({ question, surface: "agent_command", retrievalProfile: "medium", turnId: "scope-turn", callContext: { model, turnId: "scope-turn", profile: "medium" } });
  assert.equal(context.semantic.ir.retrievalScope, scope);
  assert.equal(context.semantic.ir.answerLanguage, [cases[0][0], cases[6][0], cases[7][0]].includes(question) ? "zh" : "en");
  assert.equal(context.routing.webSearchExpected, ["web", "both"].includes(scope));
  if (["web", "none"].includes(scope)) {
    assert.deepEqual(f.events, ["semantic"], "No local matcher, lexical planner, QMD, reranker or evidence reader before the main agent");
    assert.deepEqual(context.literature.relevantPaperIds, []);
    assert.deepEqual(context.knowledge.hits, []);
    assert.deepEqual(context.files, []);
    assert.equal(f.calls.parses, before.parses); assert.equal(f.calls.cards, before.cards);
    assert.ok(!context.semantic.plan.steps.some(step => step.capability === "search_papers"));
  } else if (question.startsWith("Summarize")) {
    assert.equal(context.literature.discoveryMode, "corpus");
    assert.equal(context.literature.coverage.papersIncludedInSnapshot, 2);
  } else {
    assert.ok(f.events.includes("matchPapers")); assert.ok(f.events.includes("qmd"));
    assert.ok(context.files.length); assert.ok(context.literature.relevantPaperIds.length);
    assert.ok(context.semantic.plan.steps.some(step => step.capability === "search_papers"));
  }
  const routing = f.routingLogs.at(-1);
  assert.equal(routing.retrievalScope, scope);
  assert.equal(routing.workspaceRetrievalTriggered, ["workspace", "both"].includes(scope));
  assert.equal(routing.webSearchExpected, ["web", "both"].includes(scope));
  assert.equal(routing.downloadRequested, download);
  assert.ok(!JSON.stringify(routing).includes(question));
  // FC receives the production context; it must preserve scope and permissions.
  const local = backend._test.sanitizeLocalWorkspaceContext(context, question);
  const result = await runSideChatAgent({ workspaceContext: { localWorkspaceContext: local }, conversationMessages: [{ role: "user", content: question }],
    surface: "agent_command", systemPrompt: "Answer the current request.", supportsWebSearch: true, desktopDownloads: true, downloadPermission: "workspace_write", parseFinalAnswer: text => ({ reply: text }),
    requestTurn: async request => {
      if (request.stage === "web-search") {
        f.events.push("hosted-search");
        assert.deepEqual(request.tools, [{ type: "web_search" }]);
        return { ok: true, message: { content: "External findings", web_search: { content: [{ url, title: "External paper" }] } } };
      }
      f.events.push("main-agent");
      assert.ok(request.messages.some(message => message.content.includes(`Retrieval scope: ${scope}.`)));
      assert.ok(request.tools.every(tool => tool.type === "function"));
      assert.ok(request.tools.some(tool => tool.function?.name === "download_sources"));
      assert.ok(!request.tools.some(tool => tool.function?.name === "web_search"));
      return { ok: true, message: { content: "Answer", ...(scope === "web" || scope === "both" ? { web_search: { content: [{ url, title: "External paper" }] } } : {}),
        ...(download ? { tool_calls: [{ id: "selected-source", type: "function", function: { name: "download_sources", arguments: JSON.stringify({ sources: [{ url }] }) } }] } : {}) } };
    },
  });
  assert.equal(result.ok, true);
  assert.equal(Boolean(result.data.desktopToolCalls), download);
  if (scope === "web" || scope === "both") assert.equal(result.data.webSearchSources[0].url, url);
  if (scope === "web") assert.deepEqual(f.events, ["semantic", "hosted-search", "main-agent"]);
});

test("reported Gemini IR enters hosted search instead of lexical planning, QMD, and reranking", async t => {
  const reported = require("./helpers/reported-search-download-ir.js");
  const f = await fixture(t, "web", true, reported.ir);
  const { createRuntimeLogger } = require("../../docs/runtime-log.js");
  const log = createRuntimeLogger({ sink: null, heartbeatMs: 0 });
  globalThis.BioDesignRuntimeLog = log;
  const context = await f.service.buildPlannedContext({ question: reported.query, surface: "agent_command", retrievalProfile: "medium", turnId: "reported-turn", callContext: { model, profile: "medium" } });
  assert.deepEqual(f.events, ["semantic"]);
  assert.equal(context.semantic.ir.retrievalScope, "web");
  assert.equal(context.semantic.ir.matchedPattern, null);
  assert.deepEqual(context.semantic.ir.operations, ["search", "store"]);
  assert.deepEqual(context.files, []);
  const decision = log.entries().find(entry => entry.event === "retrieval.decision");
  assert.equal(decision.details.retrievalScope, "web");
  assert.equal(decision.details.route, "remote");
  assert.equal(decision.details.downloadRequested, true);
  assert.equal(log.entries().find(entry => entry.event === "retrieval.routing").details.workspaceRetrievalTriggered, false);
  assert.doesNotMatch(log.exportText(), /合成生物学|Bearer|scope-routing-fixture-key/);
  const local = backend._test.sanitizeLocalWorkspaceContext(context, reported.query);
  const result = await runSideChatAgent({ surface: "agent_command", systemPrompt: "Complete the user task.",
    workspaceContext: { localWorkspaceContext: local }, conversationMessages: [{ role: "user", content: reported.query }],
    supportsWebSearch: true, desktopDownloads: true, downloadPermission: "workspace_write", parseFinalAnswer: text => ({ reply: text }),
    requestTurn: async request => {
      if (request.stage === "web-search") {
        f.events.push("hosted-search");
        assert.deepEqual(request.tools, [{ type: "web_search" }]);
        return { ok: true, message: { content: "A relevant paper.", web_search: { content: [{ url, title: "AI and synthetic biology" }] } } };
      }
      f.events.push("execution");
      assert.ok(request.messages.some(message => message.content.includes(url)));
      assert.ok(request.tools.some(tool => tool.function?.name === "download_sources"));
      return { ok: true, message: { tool_calls: [{ id: "download-selected", type: "function", function: { name: "download_sources", arguments: JSON.stringify({ sources: [{ url }] }) } }] } };
    },
  });
  assert.equal(result.ok, true);
  assert.ok(result.data.desktopToolCalls.length);
  assert.deepEqual(f.events, ["semantic", "hosted-search", "execution"]);
});

test("scope is authoritative over literature.search for the real Deep lexical planner and reranker", async t => {
  for (const scope of ["web", "workspace", "both"]) {
    const f = await fixture(t, scope);
    // Sources were synchronized above. Exercise the existing configurable High
    // retrieval path without the newer preflight policy's fixed Medium profile.
    f.service.requestPipeline = null;
    const query = "Find papers on enzyme engineering";
    assert.equal(semantic.interpretLocal({ query }).matchedPattern, "literature.search");
    const original = f.literature.api.interpretSemantics;
    f.literature.api.interpretSemantics = async payload => {
      const result = await original(payload);
      result.matchedPattern = "literature.search";
      return result;
    };
    const context = await f.service.buildPlannedContext({ question: query, surface: "agent_command", retrievalProfile: "high" });
    assert.equal(context.semantic.ir.matchedPattern, "literature.search");
    assert.equal(f.semanticRequests.length, 1, "A confident literature category still needs semantic retrieval-scope interpretation");
    for (const event of ["matchPapers", "lexical-planner", "qmd", "candidate-reranker"]) {
      assert.equal(f.events.includes(event), scope !== "web", `${scope}: ${event}`);
    }
    assert.equal(context.semantic.ir.retrievalScope, scope);
  }
});

test("web scope ignores recent citations and selected files without changing the hard selection", async () => {
  for (const query of ["Search the web for new papers related to BetaDock.", "在网上找与 BetaDock 相关的新论文。"] ) {
    const f = followUpFixture({ parser: input => modelIR(input, "web") });
    const context = await f.build(query, { selectedPaperIds: ["P1"] });
    assert.equal(context.semantic.ir.retrievalScope, "web");
    assert.deepEqual(context.literature.selectedPaperIds, ["P1"]);
    assert.deepEqual(context.literature.relevantPaperIds, []);
    assert.deepEqual(f.reads, []); assert.deepEqual(f.searches, []);
    assert.equal(context.literature.referenceResolution.status, "no-literature-needed");
    assert.ok(!context.notices.some(notice => /reference is unresolved|exact title match/.test(notice)));
  }
});

test("same-language local and external discovery differ by model scope, with no query-keyword routing", async () => {
  const query = "Find papers on enzyme engineering";
  for (const retrievalScope of semantic.RETRIEVAL_SCOPES) {
    const f = followUpFixture({ parser: input => modelIR(input, retrievalScope) });
    const context = await f.build(query);
    assert.equal(context.semantic.ir.retrievalScope, retrievalScope);
    assert.equal(f.searches.length > 0, ["workspace", "both"].includes(retrievalScope));
  }
});

test("retrieval scope validates strictly for model output and migrates older stored IR conservatively", () => {
  const ir = semantic.interpretLocal({ query: "Find papers on EctD" });
  const { retrievalScope, ...legacy } = ir;
  assert.equal(semantic.validateSemanticIR(legacy).retrievalScope, "workspace");
  assert.throws(() => semantic.validateSemanticIR(legacy, { requireRetrievalScope: true }), /retrievalScope/);
  for (const scope of ["internet", null, true, ["web"]]) assert.throws(() => semantic.validateSemanticIR({ ...ir, retrievalScope: scope }), /retrievalScope/);
  for (const scope of semantic.RETRIEVAL_SCOPES) assert.equal(semantic.validateSemanticIR({ ...ir, retrievalScope: scope }).retrievalScope, scope);
});

test("scope none permits an explicitly requested download without forcing discovery", async () => {
  const query = `Download this paper: ${url}`;
  const f = followUpFixture({ parser: input => ({ ...modelIR(input, "none"), operations: ["store"], capabilityHints: ["download_sources"] }) });
  const context = await f.build(query, { surface: "agent_command" });
  assert.equal(context.semantic.ir.retrievalScope, "none"); assert.equal(context.routing.downloadRequested, true);
  assert.deepEqual(f.searches, []); assert.deepEqual(f.reads, []);
  assert.ok(context.semantic.plan.steps.some(step => step.capability === "download_sources"));
});

test("explicit combined mode keeps surface permissions and leaves provider combined-tool errors isolated", async () => {
  const query = "Find EctD papers online and download selected sources.";
  for (const [surface, permission, downloadAllowed] of [["side_chat", "workspace_write", false], ["agent_command", "read_only", false], ["agent_command", "workspace_write", true]]) {
    const f = followUpFixture({ parser: input => modelIR(input, "web", true) });
    const context = await f.build(query, { surface });
    let calls = 0;
    const result = await runSideChatAgent({ toolMode: "combined", conversationMessages: [{ role: "user", content: query }], workspaceContext: { localWorkspaceContext: context }, systemPrompt: "Answer", surface,
      supportsWebSearch: true, desktopDownloads: true, downloadPermission: permission, parseFinalAnswer: text => ({ reply: text }),
      requestTurn: async request => {
        calls++;
        assert.ok(request.tools.some(tool => surface === "side_chat" ? tool.function?.name === "search_web" : tool.type === "web_search"));
        assert.equal(request.tools.some(tool => tool.function?.name === "download_sources"), downloadAllowed);
        assert.equal(request.tool_config, undefined);
        return { ok: false, error: "WEB_SEARCH_PROVIDER_ERROR", status: 400, message: "include_server_side_tool_invocation / tool context circulation" };
      },
    });
    assert.equal(result.ok, false); assert.equal(result.error, "WEB_SEARCH_PROVIDER_ERROR");
    assert.equal(calls, 1); assert.deepEqual(f.searches, []); assert.deepEqual(f.reads, []);
  }
});
