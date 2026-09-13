"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), vm = require("node:vm");
const { readFileSync } = require("node:fs"), { webcrypto } = require("node:crypto");
const jwt = require("jsonwebtoken"), semantic = require("../../shared/semantic-intent.js");
const { ElectronQmdKnowledgeService } = require("../../docs/knowledge-service.js");
const { CLOUD_RETRIEVAL } = require("../../shared/retrieval-contract.js");
const { createFixture } = require("./helpers/preflight-fixture.js");
const model = "google/gemini-3.1-flash-lite:flex";

test("paper discovery carries the selected model and turn through real Deep planning and reranking", async () => {
  const f = await createFixture();
  f.workspace.set("literature/a.pdf", "EctD stability evidence");
  f.workspace.set("literature/b.pdf", "EctD engineering evidence");
  await f.pipeline.preflight({ surface: "agent_command", turnId: "setup" });
  const papers = f.system.registry.list({ sourceKind: "paper" });
  const observed = [], files = new Map(), plannerSignature = "a".repeat(64), rerankerSignature = "b".repeat(64);
  const service = new ElectronQmdKnowledgeService({
    cryptoProvider: webcrypto,
    workspace: { fileExists: async path => files.has(path), readJson: async path => files.get(path), writeJson: async (path, value) => files.set(path, value) },
    desktop: { knowledge: {
      onProgress: () => () => {}, initialize: async () => ({ available: true }),
      search: async () => ({ results: papers.map((paper, index) => ({ paperId: paper.sourceId, title: paper.displayName,
        score: 0.9 - index / 10, matchedSections: [{ snippet: "EctD evidence", score: 0.8, page: 1 }] })) }),
    } },
    cloudApi: {
      getKnowledgeRetrievalConfig: async (_signal, context) => {
        observed.push(["config", context]);
        return { ok: true, schemaVersion: CLOUD_RETRIEVAL.schemaVersion, searchPlanPromptVersion: CLOUD_RETRIEVAL.searchPlanPromptVersion,
          rerankPromptVersion: CLOUD_RETRIEVAL.rerankPromptVersion, plannerSignature, rerankerSignature };
      },
      planKnowledgeSearch: async payload => {
        observed.push(["planner", payload.callContext]);
        return { ok: true, configurationSignature: plannerSignature, plan: { queries: ["EctD engineering"], identifiers: ["EctD"], sourceLanguage: "zh", reasoningSummary: "Scientific evidence" } };
      },
      rerankKnowledgeCandidates: async payload => {
        observed.push(["reranker", payload.callContext]);
        return { ok: true, configurationSignature: rerankerSignature, ranked: payload.candidates.map(candidate => ({ candidateId: candidate.candidateId, score: 0.9, reason: "Relevant evidence" })) };
      },
    },
  });
  await service.initialize({ workspaceId: "agent-deep-fixture" });
  f.system.literatureTools.knowledgeService = service;
  const result = await f.system.literatureTools.searchPapers("EctD 工程研究", {
    retrievalProfile: "high", callContext: { model, turnId: "selected-agent-turn", profile: "high" },
  });
  assert.equal(result.results.length, 2);
  assert.deepEqual(observed.map(([role]) => role), ["config", "planner", "reranker"]);
  for (const [role, context] of observed) {
    assert.equal(context?.model, model, `${role} lost model`);
    assert.equal(context?.turnId, "selected-agent-turn", `${role} lost turn`);
  }
});

test("production Agent messages keep evidence identifiers separate from the instruction validated by FC", async t => {
  const env = { JWT_SECRET: "agent-boundary-fixture", ADMIN_ACCOUNT: "agent-boundary", REQUESTY_API_KEY: "fixture-only-provider-key", REQUESTY_MODEL: "configured/default" };
  const previous = Object.fromEntries(Object.keys(env).map(key => [key, process.env[key]]));
  Object.assign(process.env, env);
  t.after(() => { for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } });
  const backend = require("../index.js"), providerRequests = [];
  t.mock.method(globalThis, "fetch", async (_url, options) => {
    if (!options?.body) return new Response(JSON.stringify({ data: [] }));
    providerRequests.push(JSON.parse(options.body));
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ reply: "Grounded answer", project: {
      summary: "Evidence", organism: "Unknown", missingInformation: [], safetyLevel: "Review", safetyNotes: "Review", draftMemo: "Evidence" } }) }, finish_reason: "stop" }] }));
  });
  const token = jwt.sign({ account: env.ADMIN_ACCOUNT, role: "admin" }, env.JWT_SECRET);
  const app = readFileSync(require.resolve("../../docs/app.js"), "utf8");
  const sandbox = vm.createContext({ requestLanguageInstruction: () => "Answer in the user's language.",
    buildProjectContextPromptBlock: () => "Project background: EctD A163V",
    buildEvidencePromptBlock: () => "Reference files: SurfDock.pdf, FoldX-workflow.txt" });
  vm.runInContext(app.match(/^function buildAgentMessages\([\s\S]*?^}/m)[0], sandbox);
  for (const query of ["帮我检索一下AI和合成生物学结合的文章", "Find papers about AI and synthetic biology"]) {
    const ir = semantic.interpretLocal({ query });
    const result = await backend.handler({ httpMethod: "POST", path: "/chat", headers: { authorization: `Bearer ${token}` }, body: JSON.stringify({
      mode: "agent_instruction", model, messages: sandbox.buildAgentMessages(query),
      localWorkspaceContext: { semantic: { ir } }, callContext: { turnId: "agent-boundary", callRole: "answer", profile: "medium" },
    }) }, {});
    assert.equal(result.statusCode, 200, result.body);
    assert.equal(JSON.parse(result.body).fallback, false);
    assert.equal(providerRequests.at(-1).model, model);
    assert.equal(sandbox.buildAgentMessages(query).at(-1).content, query);
    assert.ok(providerRequests.at(-1).messages.filter(message => message.role === "user").at(-1).content.endsWith(query));
    assert.ok(providerRequests.at(-1).messages.some(message => message.content.includes("SurfDock.pdf")));
  }
  const callsBefore = providerRequests.length;
  const invalid = await backend.handler({ httpMethod: "POST", path: "/chat", headers: { authorization: `Bearer ${token}` }, body: JSON.stringify({
    mode: "agent_instruction", model, messages: sandbox.buildAgentMessages("Compare EctD engineering"),
    localWorkspaceContext: { semantic: { ir: semantic.interpretLocal({ query: "Summarize the project" }) } },
  }) }, {});
  assert.equal(invalid.statusCode, 400);
  assert.equal(JSON.parse(invalid.body).error, "INVALID_SEMANTIC_CONTEXT");
  assert.equal(providerRequests.length, callsBefore, "Actual instruction identifiers are still validated before provider calls");
});
