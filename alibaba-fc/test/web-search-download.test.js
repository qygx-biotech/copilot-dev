"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const jwt = require("jsonwebtoken");
const web = require("../../shared/web-search.js");
const downloads = require("../../shared/source-download.js");
const { webSearchCapability } = require("../requesty-models.js");
const { readRequestyStream } = require("../requesty-stream.js");
const continuation = require("../agent-continuation.js");
const { runSideChatAgent, executeSideChatTool, createSideChatKnowledgeBase } = require("../side-chat-agent.js");
process.env.JWT_SECRET = "source-download-test-secret";
process.env.ADMIN_ACCOUNT = "source-download-test";
process.env.REQUESTY_API_KEY = "source-download-fixture-key";
process.env.REQUESTY_MODEL = "fixture/search-model";
// Retain these mixed-tool regression fixtures under the explicit opt-in mode.
process.env.REQUESTY_TOOL_MODE = "combined";
process.env.REQUESTY_MODEL_CAPABILITIES_JSON = JSON.stringify({ "fixture/search-model": { supportsWebSearch: true } });
const backend = require("../index.js");
const auth = jwt.sign({ account: process.env.ADMIN_ACCOUNT, role: "admin" }, process.env.JWT_SECRET);
const url = "https://papers.example.org/ectd.pdf";
const local = [{ type: "function", function: { name: "list_papers", parameters: { type: "object" } } }];
const call = (name, args = {}, id = "local-call") => ({ id, type: "function", function: { name, arguments: JSON.stringify(args) } });
const frame = value => `data: ${JSON.stringify(value)}\n\n`;
const stream = chunks => new Response(chunks.map(frame).join("") + "data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } });

test("hosted construction is capability-gated and leaves local functions present", () => {
  assert.deepEqual(web.buildTools(local, true), [...local, { type: "web_search" }]);
  assert.deepEqual(web.buildTools(local, false), local);
  assert.deepEqual(web.buildTools(local, undefined), local);
  assert.deepEqual(web.buildTools(local, true, false), local);
  assert.deepEqual(web.buildTools([...local, { type: "function", function: { name: "web_search" } }], true), [...local, { type: "web_search" }]);
});

test("capability metadata comes from Requesty's model field, caches per key, and fails closed", async () => {
  let calls = 0;
  const env = { REQUESTY_API_KEY: "metadata-only-fixture" };
  const fetch = async (address, options) => {
    calls++; assert.match(address, /\/v1\/models$/); assert.equal(options.headers.Authorization, `Bearer ${env.REQUESTY_API_KEY}`);
    return new Response(JSON.stringify({ data: [{ id: "available", supports_web_search: true }, { id: "no-search", supports_web_search: false }] }));
  };
  assert.equal(await webSearchCapability(env, "available", undefined, fetch), true);
  assert.equal(await webSearchCapability(env, "no-search", undefined, fetch), false);
  assert.equal(await webSearchCapability(env, "unknown", undefined, fetch), false);
  assert.equal(calls, 1);
  assert.equal(await webSearchCapability(env, "available", false, () => assert.fail()), false);
  assert.equal(await webSearchCapability({ REQUESTY_API_KEY: "unavailable-fixture" }, "available", undefined, async () => { throw new Error("offline"); }), false);
});

test("sources come from structured metadata only; provider citations and location metadata survive", () => {
  const annotation = { type: "url_citation", url_citation: { url, title: "EctD", start_index: 4, end_index: 18 } };
  const result = web.normalizeResponse({ choices: [{ message: { content: "Invented https://fake.example.com is not a citation.", annotations: [annotation] } }],
    groundingMetadata: { groundingChunks: [{ web: { uri: "https://another.example.org/", title: "Another" } }], groundingSupports: [{ segment: { startIndex: 1, endIndex: 5 }, groundingChunkIndices: [0] }] },
    citations: ["https://third.example.org/", "javascript:alert(1)"] }, "provider");
  assert.equal(result.webSearchSources.length, 3);
  assert.ok(result.webSearchSources.every(source => source.provider === "provider"));
  assert.ok(!result.webSearchSources.some(source => source.url.includes("fake")));
  assert.deepEqual(result.webSearchMetadata.find(entry => entry.annotations).annotations[0], annotation);
  assert.ok(result.webSearchMetadata.some(entry => entry.groundingMetadata?.groundingSupports));
});

test("streamed sources before/during/after text and top-level completion metadata preserve token streaming", async () => {
  const tokens = [], sourceEvents = [];
  const result = await readRequestyStream(stream([
    { choices: [{ index: 0, delta: { web_search: { content: [{ url, title: "First" }] } } }] },
    { choices: [{ index: 0, delta: { content: "中文 ", annotations: [{ type: "url_citation", url: "https://second.example.org/" }] } }] },
    { choices: [{ index: 0, delta: { content: "answer", tool_calls: [{ type: "web_search_call", id: "hosted" }] }, finish_reason: "stop" }] },
    { citations: ["https://third.example.org/"], choices: [], usage: { total_tokens: 20 } },
  ]), { onText: text => tokens.push(text), onSources: sources => sourceEvents.push(sources) });
  assert.deepEqual(tokens, ["中文 ", "answer"]);
  assert.equal(result.webSearchSources.length, 3); assert.equal(sourceEvents.length, 3);
  assert.equal(result.choices[0].message.tool_calls, undefined);
});

test("Google grounding in native candidates and provider extensions retains sources and support spans", () => {
  const redirect = "https://vertexaisearch.cloud.google.com/grounding-api-redirect/fixture";
  const groundingMetadata = { groundingChunks: [{ web: { uri: redirect, title: "AI and synthetic biology" } }],
    groundingSupports: [{ segment: { startIndex: 0, endIndex: 8, text: "Findings" }, groundingChunkIndices: [0] }] };
  for (const value of [
    { candidates: [{ groundingMetadata }] },
    { choices: [{ message: { extra_content: { google: { groundingMetadata, thought_signature: "private-signature" } } } }] },
    { choices: [{ delta: { extra_content: { google: { grounding_metadata: groundingMetadata } } } }] },
    { extra_content: { google: { candidates: [{ groundingMetadata }] } } },
  ]) {
    const result = web.normalizeResponse(value, "google");
    assert.deepEqual(result.webSearchSources, [{ url: redirect, title: "AI and synthetic biology", provider: "google" }]);
    assert.deepEqual(Object.values(result.webSearchMetadata[0])[0], groundingMetadata);
    assert.equal(result.webSearchDiagnostics.metadataEnvelopeCount, 1);
    assert.match(result.webSearchDiagnostics.metadataPaths[0], /grounding(Metadata|_metadata):object$/);
    assert.doesNotMatch(JSON.stringify(result.webSearchDiagnostics), /private-signature|Findings|vertexaisearch|synthetic biology/);
  }
});

test("metadata normalization does not promote prose links, tool arguments or arbitrary nested payloads", () => {
  const content = `资源链接：[研究](https://vertexaisearch.cloud.google.com/grounding-api-redirect/fixture)。`;
  const value = { choices: [{ message: { content, tool_calls: [{ function: { name: "download_sources",
    arguments: JSON.stringify({ sources: [{ url }] }) } }], extra_content: { google: { thought_signature: "private-signature" } } } }],
    unrelated: { groundingMetadata: { groundingChunks: [{ web: { uri: url } }] } } };
  const result = web.normalizeResponse(value);
  assert.deepEqual(result.webSearchSources, []);
  assert.deepEqual(result.webSearchMetadata, []);
  assert.deepEqual(result.webSearchDiagnostics.metadataPaths, []);
  assert.deepEqual(result.webSearchDiagnostics.containerPaths, ["$.choices[].message.extra_content", "$.choices[].message.extra_content.google"]);
});

test("stream diagnostics accumulate nested metadata even on a metadata-only final chunk", async () => {
  const tokens = [], sources = [];
  const grounding_metadata = { grounding_chunks: [{ web: { uri: url, title: "EctD study" } }],
    grounding_supports: [{ segment: { text: "Evidence" }, grounding_chunk_indices: [0] }] };
  const result = await readRequestyStream(stream([
    { choices: [{ index: 0, delta: { content: "Evidence" }, finish_reason: "stop" }] },
    { choices: [], extra_content: { google: { grounding_metadata } } },
  ]), { onText: text => tokens.push(text), onSources: value => sources.push(value) });
  assert.deepEqual(tokens, ["Evidence"]);
  assert.equal(result.webSearchSources[0].url, url);
  assert.deepEqual(result.webSearchMetadata[0].grounding_metadata, grounding_metadata);
  assert.equal(sources.length, 1);
  assert.equal(result.webSearchDiagnostics.chunkCount, 2);
  assert.deepEqual(result.webSearchDiagnostics.metadataPaths, ["$.extra_content.google.grounding_metadata:object"]);
});

test("the local dispatcher never executes a provider-native or fake web_search call", () => {
  for (const tool of [{ type: "web_search", name: "web_search" }, { type: "web_search_call" }, call("web_search")]) {
    assert.deepEqual(JSON.parse(executeSideChatTool(tool, createSideChatKnowledgeBase({}), "agent_command")), { error: "HOSTED_TOOL_NOT_LOCAL", allowed: false });
  }
});

test("model-authored JSON cannot invent provider citations or desktop control fields", async () => {
  const result = await runSideChatAgent({ toolMode: "combined", conversationMessages: [{ role: "user", content: "Answer" }], workspaceContext: {}, systemPrompt: "Answer",
    parseFinalAnswer: JSON.parse, requestTurn: async () => ({ ok: true, message: { content: JSON.stringify({ reply: "Answer", webSearchSources: [{ url }],
      webSearchMetadata: [{ citations: [url] }], desktopToolCalls: [{ name: "download_sources" }], desktopContinuation: "fake" }) } }),
  });
  assert.deepEqual(result.data, { reply: "Answer" });
});

test("search-only English and Chinese requests do not dispatch or download sources", async () => {
  for (const query of ["Search recent EctD papers", "搜索最近的EctD论文", "总结所有本地论文", "What did the selected local paper say?"]) {
    let requests = 0;
    const result = await runSideChatAgent({ toolMode: "combined", conversationMessages: [{ role: "user", content: query }], workspaceContext: {}, systemPrompt: "Answer", supportsWebSearch: true,
      surface: "agent_command", desktopDownloads: true, downloadPermission: "workspace_write", parseFinalAnswer: reply => ({ reply }),
      requestTurn: async ({ tools }) => { requests++; assert.ok(tools.some(tool => tool.type === "web_search")); return { ok: true, message: { content: "Answer", web_search: { content: [{ url }] } } }; },
    });
    assert.equal(requests, 1); assert.equal(result.data.desktopToolCalls, undefined); assert.equal(result.data.webSearchSources[0].url, url);
  }
});

test("side chat and read-only moves exclude the local download tool and reject hallucinated calls", async () => {
  for (const [surface, permission] of [["side_chat", "full_access"], ["agent_command", "read_only"]]) {
    let count = 0;
    const result = await runSideChatAgent({ toolMode: "combined", conversationMessages: [{ role: "user", content: "Download this paper" }], workspaceContext: {}, systemPrompt: "Answer",
      surface, desktopDownloads: true, downloadPermission: permission, parseFinalAnswer: reply => ({ reply }),
      requestTurn: async ({ tools, messages }) => {
        assert.ok(!tools.some(tool => tool.function?.name === "download_sources"));
        if (++count === 1) return { ok: true, message: { tool_calls: [call("download_sources", { sources: [{ url }] })] } };
        assert.match(messages.at(-1).content, /PERMISSION_DENIED/);
        return { ok: true, message: { content: "Permission denied" } };
      },
    });
    assert.equal(result.data.desktopToolCalls, undefined); assert.equal(count, 2);
  }
});

test("agent loop resumes hosted search → desktop download → existing local tool → final synthesis with retained citations", async () => {
  const requests = [], original = global.fetch;
  const final = { reply: "Downloaded one source and compared existing evidence.", project: { summary: "Review", organism: "Unknown", missingInformation: [], safetyLevel: "Review", safetyNotes: "Review", draftMemo: "Draft" } };
  const messages = [
    { content: "Found EctD research", web_search: { content: [{ url, title: "EctD paper" }] }, tool_calls: [
      { id: "hosted-1", type: "web_search_call", status: "completed" }, call("download_sources", { sources: [{ url, title: "EctD paper" }] }),
    ] },
    { content: null, tool_calls: [call("list_papers", {}, "list-local")] },
    { content: final.reply },
  ];
  global.fetch = async (_address, options) => { requests.push(JSON.parse(options.body)); return new Response(JSON.stringify({ choices: [{ message: messages.shift(), finish_reason: "stop" }] })); };
  const body = { mode: "agent_instruction", messages: [{ role: "user", content: "Find EctD papers and download the most relevant PDF, then compare existing papers" }],
    desktopTools: { version: 1, permission: "workspace_write", projectId: "project-1" }, callContext: { turnId: "download-turn", callRole: "answer", profile: "medium" } };
  const send = async extra => JSON.parse((await backend.handler({ httpMethod: "POST", path: "/chat", headers: { authorization: `Bearer ${auth}` }, body: JSON.stringify({ ...body, ...extra }) }, {})).body);
  try {
    const first = await send({});
    assert.equal(first.desktopToolCalls[0].name, "download_sources"); assert.ok(first.desktopContinuation);
    assert.equal(requests[0].tools.find(tool => tool.type === "web_search").function, undefined);
    const resumed = await send({ desktopContinuation: first.desktopContinuation, desktopToolResults: [{ id: first.desktopToolCalls[0].id,
      results: [{ url, status: "downloaded", path: "literature/ectd.pdf", resolvedUrl: url, contentType: "application/pdf", downloadMethod: "local" }] }] });
    assert.equal(resumed.reply, final.reply); assert.equal(resumed.webSearchSources[0].url, url);
    assert.equal(requests.length, 3);
    assert.ok(requests[1].messages.some(message => message.role === "tool" && message.name === "download_sources" && message.content.includes("literature/ectd.pdf")));
    assert.ok(requests[2].messages.some(message => message.role === "tool" && message.name === "list_papers"));
    assert.ok(requests.every(request => !request.messages.some(message => message.role === "tool" && message.name === "web_search")));
    const tampered = await send({ desktopContinuation: first.desktopContinuation + "x", desktopToolResults: [] });
    assert.equal(tampered.error, "INVALID_TOOL_CONTINUATION");
  } finally { global.fetch = original; }
});

test("signed continuation binds user/move/permission and keeps tool budgets", () => {
  const binding = { user: "one", turn: "move", permission: "workspace_write" };
  const state = { totalToolCalls: 23, step: 7 };
  const token = continuation.seal(state, binding, "fixture-secret");
  assert.deepEqual(continuation.open(token, binding, "fixture-secret"), state);
  for (const modified of [{ ...binding, user: "two" }, { ...binding, permission: "read_only" }, { ...binding, turn: "other" }]) {
    assert.throws(() => continuation.open(token, modified, "fixture-secret"), { code: "INVALID_TOOL_CONTINUATION" });
  }
});

test("a download and missing local evidence share one bounded loop without repeating the write", async () => {
  const fixture = require("./helpers/follow-up-fixture.js").followUpFixture();
  const local = { project: { workspaceName: "Fixture" }, files: [], knowledge: { hits: [] },
    literature: { selectedPaperIds: [], explicitPaperIds: ["P2"], relevantPaperIds: ["P2"], referenceResolution: { status: "resolved" } },
    sourceMap: { selectedPaperIds: [], paperSources: fixture.sources }, evidenceRecovery: { version: 1, cycle: 0 } };
  const options = { conversationMessages: [{ role: "user", content: "Download this PDF and compare it with BetaDock" }], systemPrompt: "Answer",
    surface: "agent_command", desktopDownloads: true, downloadPermission: "workspace_write", parseFinalAnswer: reply => ({ reply }),
    workspaceContext: { localWorkspaceContext: backend._test.sanitizeLocalWorkspaceContext(local) } };
  let calls = 0;
  const first = await runSideChatAgent({ toolMode: "combined", ...options, requestTurn: async () => {
    calls++; return { ok: true, message: { tool_calls: [call("download_sources", { sources: [{ url }] }, "download"), call("read_paper_evidence", { paper_id: "P2", query: "license" }, "read")] } };
  } });
  const resume = continuation.withResults(first.continuationState, [{ id: "download", results: [{ url, status: "downloaded", path: "literature/new.pdf" }] }]);
  const recovery = await runSideChatAgent({ toolMode: "combined", ...options, resume, requestTurn: () => assert.fail("Recover before another model request") });
  assert.equal(recovery.data.evidenceRecovery.requests[0].paperId, "P2");
  assert.deepEqual(recovery.continuationState.pending, []);
  local.evidenceRecovery = { version: 1, cycle: 1 };
  const final = await runSideChatAgent({ toolMode: "combined", ...options, resume: continuation.withResults(recovery.continuationState, []),
    workspaceContext: { localWorkspaceContext: backend._test.sanitizeLocalWorkspaceContext(local) },
    requestTurn: async ({ messages }) => {
      calls++; assert.equal(messages.filter(message => message.role === "tool" && message.name === "download_sources").length, 1);
      assert.ok(messages.some(message => message.role === "system" && message.content.includes("recovery has been consumed")));
      return { ok: true, message: { content: "File saved; comparison limited by the available evidence." } };
    } });
  assert.equal(calls, 2); assert.ok(final.data.reply);
});

test("direct download works without web search and a resumed exhausted loop gets no tools", async () => {
  let seen;
  const first = await runSideChatAgent({ toolMode: "combined", conversationMessages: [{ role: "user", content: `Download ${url}` }], workspaceContext: {}, systemPrompt: "Answer",
    surface: "agent_command", desktopDownloads: true, downloadPermission: "full_access", supportsWebSearch: false, parseFinalAnswer: reply => ({ reply }),
    requestTurn: async request => { seen = request.tools; return { ok: true, message: { tool_calls: [call("download_sources", { sources: [{ url }] })] } }; } });
  assert.ok(!seen.some(tool => tool.type === "web_search")); assert.equal(first.data.desktopToolCalls.length, 1);
  const resume = continuation.withResults(first.continuationState, [{ id: "local-call", results: [{ url, status: "failed", error: { code: "HTTP_ERROR" } }] }]);
  resume.step = 8; resume.totalToolCalls = 24;
  const result = await runSideChatAgent({ toolMode: "combined", conversationMessages: [{ role: "user", content: "Download" }], workspaceContext: {}, systemPrompt: "Answer", resume,
    surface: "agent_command", desktopDownloads: true, downloadPermission: "full_access", supportsWebSearch: true, parseFinalAnswer: reply => ({ reply }),
    requestTurn: async ({ tools }) => { assert.deepEqual(tools, []); return { ok: true, message: { content: "Download failed." } }; } });
  assert.equal(result.data.reply, "Download failed.");
});

test("provider search errors are classified without dispatching or leaking upstream detail", async () => {
  const original = global.fetch;
  global.fetch = async () => new Response(JSON.stringify({ error: { message: "web_search unsupported secret-fixture" } }), { status: 400 });
  try {
    const result = await backend.handler({ httpMethod: "POST", path: "/chat", headers: { authorization: `Bearer ${auth}` },
      body: JSON.stringify({ mode: "side_chat", messages: [{ role: "user", content: "Search online" }] }) }, {});
    assert.equal(JSON.parse(result.body).error, "LlmHttpError"); assert.ok(!result.body.includes("secret-fixture"));
  } finally { global.fetch = original; }
});

test("the current FC fetch route requires authentication and rejects unsafe targets before network fetch", async () => {
  const send = (url, headers = { authorization: `Bearer ${auth}` }) => backend.handler({ httpMethod: "POST", path: "/api/sources/fetch", headers, body: JSON.stringify({ url }) }, {});
  assert.equal((await send(url, {})).statusCode, 401);
  for (const url of ["http://127.0.0.1/", "http://100.100.100.200/", "file:///etc/passwd", "ftp://example.org/"]) {
    const result = await send(url); assert.equal(result.statusCode, 400); assert.equal(JSON.parse(result.body).error, "UNSAFE_URL");
  }
});
