"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const jwt = require("jsonwebtoken");
const { withCombinedToolConfig } = require("../requesty-models.js");
const { readRequestyStream } = require("../requesty-stream.js");
const { assistantMessage, mergeContext } = require("../requesty-tool-context.js");
const { compactSideChatAgentMessages, normalizeToolCalls } = require("../side-chat-agent.js");
const webSearch = require("../../shared/web-search.js");
const model = "google/gemini-3.1-flash-lite:flex";
const url = "https://papers.example.org/ectd.pdf";
const signature = "opaque-provider-signature-do-not-display";
const functions = [{ type: "function", function: { name: "list_papers", parameters: { type: "object" } } }];
const call = (name, args, id) => ({ id, type: "function", function: { name, arguments: JSON.stringify(args) }, extra_content: { google: { thought_signature: signature } } });
const hosted = { id: "hosted-search", type: "web_search_call", status: "completed" };
const providerMessage = () => ({ role: "assistant", content: "Found a source.",
  extra_content: { google: { thought_signature: signature } },
  web_search: { content: [{ url, title: "EctD source" }] },
  tool_calls: [hosted, call("download_sources", { sources: [{ url }] }, "download-1")],
});
const frame = value => `data: ${JSON.stringify(value)}\n\n`;
const sse = chunks => new Response(chunks.map(frame).join("") + "data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } });
const chunk = (delta, finish_reason = null) => ({ choices: [{ index: 0, delta, finish_reason }] });

test("Gemini mixed tools carry the native opt-in as a top-level Requesty extra field", () => {
  const request = { model, messages: [{ role: "user", content: "Find EctD papers" }], tools: webSearch.buildTools(functions, true) };
  assert.deepEqual(withCombinedToolConfig(request, "combined"), { ...request, toolConfig: { includeServerSideToolInvocations: true } });
  assert.equal(request.toolConfig, undefined, "Do not mutate the caller or force tool_choice");
  const configured = withCombinedToolConfig({ ...request, toolConfig: { functionCallingConfig: { mode: "VALIDATED" } } }, "combined");
  assert.equal(configured.toolConfig.functionCallingConfig.mode, "VALIDATED");
  assert.equal(configured.tool_choice, undefined);
});

test("plain, schema-only, search-only, function-only, unsupported and other-provider requests are unchanged", () => {
  for (const request of [
    { model }, { model, response_format: { type: "json_schema" } },
    { model, tools: webSearch.buildTools(functions, false) }, { model, tools: [{ type: "web_search" }] },
    ...["google/gemini-2.5-flash", "vertex/google/gemini-3.1-flash-lite", "openai/gpt-4.1", "fixture/model"].map(model => ({ model, tools: webSearch.buildTools(functions, true) })),
  ]) assert.strictEqual(withCombinedToolConfig(request, "combined"), request);
});

test("compaction preserves opaque assistant context, native parts, server calls and local signatures exactly", () => {
  const original = providerMessage();
  original.content = [{ type: "text", text: "Found a source." },
    { toolCall: { toolType: "GOOGLE_SEARCH_WEB", id: "search-1", args: { queries: ["EctD"] } }, thoughtSignature: signature },
    { toolResponse: { toolType: "GOOGLE_SEARCH_WEB", id: "search-1", response: { result: "source" } }, thoughtSignature: signature }];
  const localCalls = normalizeToolCalls(original);
  assert.equal(localCalls.length, 1);
  assert.equal(localCalls[0].extra_content.google.thought_signature, signature);
  const replay = assistantMessage({ providerMessage: original }, localCalls);
  assert.deepEqual(replay, original);
  const compacted = compactSideChatAgentMessages([{ role: "system", content: "Answer" },
    { role: "user", content: "Old context ".repeat(5000) }, { role: "user", content: "Download" }, replay,
    { role: "tool", tool_call_id: "download-1", content: "Saved" }], "Download", 4000);
  assert.deepEqual(compacted.find(message => message.role === "assistant"), original);
});

test("streaming preserves server invocations and late function signatures separately from executable calls", async () => {
  const text = [], sources = [];
  const result = await readRequestyStream(sse([
    chunk({ extra_content: { google: { thought_signature: signature } }, tool_calls: [{ ...hosted, index: 0 }], web_search: { content: [{ url }] } }),
    chunk({ content: "Found ", tool_calls: [{ index: 1, id: "local-1", type: "function", function: { name: "list_papers", arguments: "{" } }] }),
    chunk({ content: "a source.", tool_calls: [{ index: 1, function: { arguments: "}" }, extra_content: { google: { thought_signature: signature } } }] }, "tool_calls"),
  ]), { onText: value => text.push(value), onSources: value => sources.push(value) });
  assert.deepEqual(text, ["Found ", "a source."]);
  assert.equal(sources[0][0].url, url);
  assert.equal(result.choices[0].message.tool_calls.length, 1);
  assert.equal(result.choices[0].message.tool_calls[0].function.arguments, "{}");
  assert.deepEqual(result.providerMessage.tool_calls[0], hosted);
  assert.equal(result.providerMessage.tool_calls[1].extra_content.google.thought_signature, signature);
  const replay = assistantMessage({ providerMessage: result.providerMessage }, normalizeToolCalls(result.choices[0].message));
  assert.deepEqual(replay, result.providerMessage);
  assert.ok(!JSON.stringify(result.webSearchMetadata).includes(signature));
});

test("structured content parts and completion snapshots keep full context without displaying opaque parts", async () => {
  const parts = [{ type: "text", text: "Answer" }, { thoughtSignature: signature, toolResponse: { id: "hosted", toolType: "GOOGLE_SEARCH_WEB", response: {} } }];
  const tokens = [];
  const result = await readRequestyStream(sse([chunk({ content: parts }, "stop")]), { onText: text => tokens.push(text) });
  assert.deepEqual(result.providerMessage.content, parts);
  assert.deepEqual(tokens, ["Answer"]);
  const completed = providerMessage();
  const snapshot = await readRequestyStream(sse([chunk({ content: "Found a source." }),
    { choices: [{ index: 0, message: completed, finish_reason: "tool_calls" }] }]));
  assert.deepEqual(snapshot.providerMessage, completed);
});

test("oversized opaque context fails closed instead of truncating signatures", async () => {
  const extra_content = { google: { thought_signature: "x".repeat(512001) } };
  assert.throws(() => assistantMessage({ message: { extra_content } }, []), { code: "PROVIDER_TOOL_CONTEXT_LIMIT" });
  await assert.rejects(readRequestyStream(sse([chunk({ extra_content }, "stop")])), { code: "PROVIDER_TOOL_CONTEXT_LIMIT" });
  assert.throws(() => mergeContext({}, JSON.parse('{"x":'.repeat(18) + '1' + '}'.repeat(18))), /nesting/);
});

process.env.JWT_SECRET = "combined-tools-test-secret";
process.env.ADMIN_ACCOUNT = "combined-tools-test-admin";
process.env.REQUESTY_API_KEY = "combined-tools-fixture-key";
process.env.REQUESTY_MODEL = model;
// Combined mode is retained only as an explicit compatibility experiment.
process.env.REQUESTY_TOOL_MODE = "combined";
const backend = require("../index.js");
const auth = jwt.sign({ account: process.env.ADMIN_ACCOUNT, role: "admin" }, process.env.JWT_SECRET);

for (const streaming of [false, true]) test(`real FC ${streaming ? "streaming" : "JSON"} search/download/resume replays context and only executes local tools`, async () => {
  const originalFetch = global.fetch, requests = [], events = [];
  const firstMessage = providerMessage();
  const final = { reply: "Downloaded the selected source.", project: { summary: "Review", organism: "Unknown", missingInformation: [], safetyLevel: "Review", safetyNotes: "Review", draftMemo: "Draft" } };
  const responses = [firstMessage, { content: final.reply, role: "assistant" }];
  global.fetch = async (address, options) => {
    assert.equal(address, "https://router.requesty.ai/v1/chat/completions");
    const request = JSON.parse(options.body); requests.push(request);
    assert.equal(request.model, model);
    if (streaming) { assert.equal(request.stream, true); assert.equal(request.stream_options.include_usage, true); }
    assert.equal(request.toolConfig.includeServerSideToolInvocations, true);
    assert.ok(request.tools.some(tool => tool.type === "web_search"));
    assert.ok(request.tools.some(tool => tool.function?.name === "download_sources"));
    const message = responses.shift();
    return streaming ? sse([chunk({ ...message, tool_calls: message.tool_calls?.map((call, index) => ({ ...call, index })) }, message.tool_calls ? "tool_calls" : "stop")])
      : new Response(JSON.stringify({ choices: [{ message, finish_reason: message.tool_calls ? "tool_calls" : "stop" }] }));
  };
  const body = { mode: "agent_instruction", model, stream: streaming,
    messages: [{ role: "user", content: "Search EctD research and download the selected source" }],
    desktopTools: { version: 1, permission: "workspace_write", projectId: "combined-project" },
    callContext: { turnId: "combined-move", callRole: "answer", profile: "medium" } };
  const send = async extra => {
    const result = await backend.handler({ httpMethod: "POST", path: "/chat", headers: { authorization: `Bearer ${auth}` }, body: JSON.stringify({ ...body, ...extra }) }, {},
      streaming ? { start: async () => {}, emit: async (event, data) => events.push({ event, data }), end: async () => {} } : undefined);
    return JSON.parse(result.body);
  };
  try {
    const first = await send({});
    assert.equal(first.desktopToolCalls.length, 1);
    assert.equal(first.desktopToolCalls[0].id, "download-1");
    const resumed = await send({ desktopContinuation: first.desktopContinuation,
      desktopToolResults: [{ id: "download-1", results: [{ url, status: "downloaded", path: "literature/ectd.pdf", resolvedUrl: url, contentType: "application/pdf", downloadMethod: "local" }] }] });
    assert.equal(resumed.reply, final.reply);
    assert.equal(resumed.webSearchSources[0].url, url);
    assert.equal(requests.length, 2);
    assert.deepEqual(requests[1].messages.find(message => message.role === "assistant"), firstMessage);
    const results = requests[1].messages.filter(message => message.role === "tool");
    assert.equal(results.length, 1);
    assert.equal(results[0].tool_call_id, "download-1");
    assert.ok(!JSON.stringify(resumed).includes(signature));
    assert.ok(!JSON.stringify(events).includes(signature));
  } finally { global.fetch = originalFetch; }
});

test("gateway opt-in rejection is explicit, bounded and does not expose upstream detail", async () => {
  const originalFetch = global.fetch;
  let requests = 0;
  global.fetch = async () => {
    requests++;
    return new Response(JSON.stringify({ error: { message: "Unknown field toolConfig: private-upstream-detail" } }), { status: 400 });
  };
  try {
    const result = await backend.handler({ httpMethod: "POST", path: "/chat", headers: { authorization: `Bearer ${auth}` },
      body: JSON.stringify({ mode: "agent_instruction", model, messages: [{ role: "user", content: "Search EctD papers" }] }) }, {});
    const data = JSON.parse(result.body);
    assert.equal(data.error, "GEMINI_COMBINED_TOOLS_UNSUPPORTED");
    assert.equal(requests, 1);
    assert.ok(!result.body.includes("private-upstream-detail"));
    assert.equal(data.desktopToolCalls, undefined);
  } finally { global.fetch = originalFetch; }
});
