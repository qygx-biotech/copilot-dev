"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), http = require("node:http");
const { once } = require("node:events");
const jwt = require("jsonwebtoken");
const { readEvents, previewReply, readWorkbenchResponse } = require("../../shared/event-stream.js");
const { readRequestyStream } = require("../requesty-stream.js");
process.env.JWT_SECRET = "streaming-fixture-secret";
process.env.ADMIN_ACCOUNT = "streaming-fixture";
process.env.REQUESTY_API_KEY = "streaming-fixture-key";
process.env.REQUESTY_MODEL = "streaming-fixture-model";
process.env.REQUESTY_MODEL_CAPABILITIES_JSON = JSON.stringify({ "streaming-fixture-model": { supportsTools: true, supportsImages: false, supportsWebSearch: false } });
const adapter = require("../src/index.js");
const token = jwt.sign({ account: process.env.ADMIN_ACCOUNT, role: "admin" }, process.env.JWT_SECRET, { expiresIn: "1h" });
const frame = (delta, finish_reason = null) => `data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason }] })}\n\n`;
const done = 'data: {"choices":[],"usage":{"total_tokens":24,"cost":0.01}}\n\ndata: [DONE]\n\n';
const response = (text, split = 7) => {
  const bytes = new TextEncoder().encode(text);
  return new Response(new ReadableStream({ start(controller) { for (let i = 0; i < bytes.length; i += split) controller.enqueue(bytes.slice(i, i + split)); controller.close(); } }), { headers: { "content-type": "text/event-stream" } });
};

test("SSE decoding preserves fragmented UTF-8, CRLF, comments, multiline data and final usage", async () => {
  const events = [];
  await readEvents(response(': heartbeat\r\nevent: delta\r\ndata: 第一行\r\ndata: 第二行\r\n\r\n', 1), event => events.push(event));
  assert.deepEqual(events, [{ event: "delta", data: "第一行\n第二行" }]);
  const result = await readRequestyStream(response(frame({ content: "中文 " }) + frame({ content: "response" }, "stop") + done, 1));
  assert.equal(result.choices[0].message.content, "中文 response");
  assert.equal(result.usage.total_tokens, 24);
});

test("provider tool-call fragments reassemble by index without exposing arguments or reasoning as text", async () => {
  const text = [];
  const result = await readRequestyStream(response(frame({ reasoning_content: "private reasoning", tool_calls: [{ index: 0, id: "call-1", function: { name: "list_", arguments: '{"scope":' } }] }) +
    frame({ tool_calls: [{ index: 0, function: { name: "papers", arguments: '"all"}' } }] }, "tool_calls") + done), { onText: delta => text.push(delta) });
  assert.deepEqual(text, []);
  assert.deepEqual(result.choices[0].message.tool_calls, [{ id: "call-1", type: "function", function: { name: "list_papers", arguments: '{"scope":"all"}' } }]);
});

test("truncated provider and app streams cannot become completed answers", async () => {
  for (const text of [frame({ content: "partial" }), frame({ content: "truncated" }, "length") + done, 'data: {"error":{"message":"private failure"}}\n\n', 'data: {"choices":']) {
    await assert.rejects(readRequestyStream(response(text)));
  }
  const events = [];
  await assert.rejects(readWorkbenchResponse(response('event: delta\ndata: {"text":"partial"}\n\n'), { onEvent: event => events.push(event) }), { code: "STREAM_INTERRUPTED" });
  assert.equal(events[0].text, "partial");
  await assert.rejects(readWorkbenchResponse(response('event: error\ndata: {"code":"InvalidLlmResponse","message":"private details"}\n\n')), error => error.code === "STREAM_INTERRUPTED" && !error.message.includes("private"));
});

test("structured previews decode only the reply field, including incomplete escapes", () => {
  assert.equal(previewReply('**Plain** 中文'), '**Plain** 中文');
  assert.equal(previewReply('{"project":{"reply":"hidden"},"reasoning":"hidden"', true), "");
  assert.equal(previewReply('{"reply":"Line\\n\\u4e2d\\u6587\\', true), "Line\n中文");
  assert.equal(previewReply('{"reply":"\\uD83D', true), "");
  assert.equal(previewReply('{"reply":"\\uD83D\\uDE00","project":{"summary":"internal"}', true), "😀");
  assert.equal(previewReply('```json\n{"reply":"Hello', true), "Hello");
});

test("the app supports the deployed JSON response and commits only a final SSE result", async () => {
  const final = { reply: "Final answer", citations: [] };
  assert.deepEqual(await readWorkbenchResponse(new Response(JSON.stringify(final), { headers: { "content-type": "application/json" } })), final);
  const events = [];
  assert.deepEqual(await readWorkbenchResponse(response('event: delta\ndata: {"text":"draft"}\n\nevent: reset\ndata: {}\n\nevent: complete\ndata: ' + JSON.stringify(final) + '\n\n'), { onEvent: event => events.push(event) }), final);
  assert.deepEqual(events.map(event => event.type), ["delta", "reset"]);
});

async function serverFixture(run) {
  const server = http.createServer(adapter);
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const url = `http://127.0.0.1:${server.address().port}`;
  try { await run(url); } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
}
const chatBody = mode => ({ stream: true, mode, messages: [{ role: "user", content: "Summarize evidence" }] });

test("the HTTP streaming adapter preserves authentication and validation before opening SSE", async () => {
  await serverFixture(async url => {
    const denied = await fetch(url + "/chat", { method: "POST", body: JSON.stringify(chatBody("side_chat")) });
    assert.equal(denied.status, 401);
    assert.doesNotMatch(denied.headers.get("content-type"), /event-stream/);
    const health = await (await fetch(url + "/health")).json();
    assert.equal(health.streamingSupported, true);
    const invalid = await fetch(url + "/chat", { method: "POST", headers: { Authorization: `Bearer ${token}` }, body: JSON.stringify({ ...chatBody("side_chat"), localWorkspaceContext: [] }) });
    assert.equal(invalid.status, 400);
  });
});

test("real HTTP delivery streams before completion, runs tool calls, and finalizes verified citations", async () => {
  const originalFetch = global.fetch;
  const requests = [], events = [];
  let finishProvider;
  global.fetch = async (url, options) => {
    if (!String(url).includes("router.requesty.ai")) return originalFetch(url, options);
    const request = JSON.parse(options.body); requests.push(request);
    assert.equal(request.stream, true); assert.equal(request.stream_options.include_usage, true);
    if (requests.length === 1) return response(frame({ reasoning_content: "private reasoning", tool_calls: [{ index: 0, id: "call-1", function: { name: "list_", arguments: "{" } }] }) + frame({ tool_calls: [{ index: 0, function: { name: "papers", arguments: "}" } }] }, "tool_calls") + done);
    return new Response(new ReadableStream({ start(controller) {
      controller.enqueue(new TextEncoder().encode(frame({ content: "第一部分 " })));
      finishProvider = () => { controller.enqueue(new TextEncoder().encode(frame({ content: "[[cite:paper-a]]" }, "stop") + done)); controller.close(); };
    } }), { headers: { "content-type": "text/event-stream" } });
  };
  try { await serverFixture(async url => {
    const res = await fetch(url + "/chat", { method: "POST", headers: { Authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify({ ...chatBody("side_chat"), localWorkspaceContext: { project: { workspaceName: "Project" }, inventory: [{ paperId: "paper-a", relativePath: "literature/paper.pdf", extension: "pdf" }] } }) });
    assert.match(res.headers.get("content-type"), /event-stream/);
    assert.equal(res.headers.get("transfer-encoding"), "chunked");
    let observedBeforeComplete = false;
    const result = await readWorkbenchResponse(res, { onEvent(event) {
      events.push(event);
      if (event.type === "delta") { observedBeforeComplete = true; finishProvider?.(); finishProvider = null; }
    } });
    assert.equal(observedBeforeComplete, true);
    assert.equal(requests.length, 2);
    assert.ok(requests[1].messages.some(message => message.role === "tool" && message.name === "list_papers"));
    assert.ok(events.some(event => event.type === "status" && event.capability === "list_papers"));
    assert.doesNotMatch(JSON.stringify(events), /private reasoning|arguments/);
    assert.match(result.reply, /biodesign-citation:citation-1/);
    assert.equal(result.citations[0].sourceId, "paper-a");
    assert.equal(result.fallback, false);
  }); } finally { global.fetch = originalFetch; }
});

test("Agent Work streams plain text on its selected model without structured-answer validation", async () => {
  const originalFetch = global.fetch;
  const model = "google/gemini-3.1-flash-lite:flex", requests = [];
  const resultBody = { reply: "Readable analysis 中文", project: { summary: "Analysis", organism: "Unknown", missingInformation: [], safetyLevel: "Review", safetyNotes: "Review", draftMemo: "Draft" } };
  global.fetch = async (url, options) => {
    if (!String(url).includes("router.requesty.ai")) return originalFetch(url, options);
    if (!options?.body) return new Response(JSON.stringify({ data: [] }));
    requests.push(JSON.parse(options.body));
    return response(frame({ content: 'Readable analysis ' }) + frame({ content: '中文' }, "stop") + done);
  };
  try { await serverFixture(async url => {
    const res = await fetch(url + "/chat", { method: "POST", headers: { Authorization: `Bearer ${token}` }, body: JSON.stringify({ ...chatBody("agent_instruction"), model }) });
    const deltas = [];
    const result = await readWorkbenchResponse(res, { onEvent: event => { if (event.type === "delta") deltas.push(event.text); } });
    assert.equal(deltas.join(""), resultBody.reply);
    assert.equal(result.reply, resultBody.reply);
    assert.equal(result.project, undefined);
    assert.equal(requests.length, 1);
    assert.equal(requests[0].model, model);
    assert.equal(requests[0].stream, true);
  }); } finally { global.fetch = originalFetch; }
});

test("disconnecting the app aborts the in-flight provider request", async () => {
  const originalFetch = global.fetch;
  let providerAborted;
  const cancelled = new Promise(resolve => { providerAborted = resolve; });
  global.fetch = async (url, options) => {
    if (!String(url).includes("router.requesty.ai")) return originalFetch(url, options);
    return new Response(new ReadableStream({ start(controller) {
      controller.enqueue(new TextEncoder().encode(frame({ content: "partial" })));
      options.signal.addEventListener("abort", () => { providerAborted(); controller.error(new Error("cancelled")); }, { once: true });
    } }), { headers: { "content-type": "text/event-stream" } });
  };
  try { await serverFixture(async url => {
    const controller = new AbortController();
    const res = await fetch(url + "/chat", { method: "POST", headers: { Authorization: `Bearer ${token}` }, body: JSON.stringify(chatBody("side_chat")), signal: controller.signal });
    await assert.rejects(readWorkbenchResponse(res, { signal: controller.signal, onEvent: event => { if (event.type === "delta") controller.abort(); } }), { code: "OPERATION_ABORTED" });
    await cancelled;
  }); } finally { global.fetch = originalFetch; }
});

test("a truncated provider reply produces an HTTP stream error, never a completed fallback", async () => {
  const originalFetch = global.fetch;
  global.fetch = async (url, options) => String(url).includes("router.requesty.ai")
    ? response(frame({ content: "Incomplete answer" })) : originalFetch(url, options);
  try { await serverFixture(async url => {
    const res = await fetch(url + "/chat", { method: "POST", headers: { Authorization: `Bearer ${token}` }, body: JSON.stringify(chatBody("side_chat")) });
    const events = [];
    await readEvents(res, event => events.push(event));
    assert.ok(events.some(event => event.event === "delta"));
    assert.equal(events.at(-1).event, "error");
    assert.ok(!events.some(event => event.event === "complete"));
  }); } finally { global.fetch = originalFetch; }
});

test("the built-in FC handler stays JSON compatible when a new app asks for streaming", async () => {
  const originalFetch = global.fetch;
  global.fetch = async (_url, options) => {
    const request = JSON.parse(options.body);
    assert.notEqual(request.stream, true);
    return new Response(JSON.stringify({ choices: [{ message: { content: "Buffered answer" }, finish_reason: "stop" }] }));
  };
  try {
    const { handler } = require("../index.js");
    const res = await handler({ requestContext: { http: { method: "POST", path: "/chat" } }, headers: { authorization: `Bearer ${token}` }, body: JSON.stringify(chatBody("side_chat")) });
    assert.equal(res.statusCode, 200);
    assert.equal(JSON.parse(res.body).reply, "Buffered answer");
  } finally { global.fetch = originalFetch; }
});

test("cancellation stops a provider quota retry wait promptly without issuing another request", { timeout: 3000 }, async () => {
  const originalFetch = global.fetch;
  const controller = new AbortController();
  let attempts = 0;
  global.fetch = async () => {
    attempts++;
    setTimeout(() => controller.abort(), 20);
    return new Response(JSON.stringify({ error: { message: "Rate limit exceeded. Please retry in 60s." } }), { status: 429, headers: { "Retry-After": "60" } });
  };
  try {
    const { handler } = require("../index.js");
    const started = Date.now();
    await handler({ requestContext: { http: { method: "POST", path: "/chat" } }, headers: { authorization: `Bearer ${token}` }, body: JSON.stringify(chatBody("side_chat")) }, {}, { signal: controller.signal, start: async () => {}, emit: async () => {} });
    assert.equal(controller.signal.aborted, true);
    assert.equal(attempts, 1);
    assert.ok(Date.now() - started < 1000, "Cancellation waited for the quota retry delay");
  } finally { global.fetch = originalFetch; }
});

test("HTTP streaming yields one recovery event, resumes with the same question/model, and completes one cited answer", async () => {
  const { followUpFixture } = require("./helpers/follow-up-fixture.js");
  const f = followUpFixture();
  f.literature.preparation.readSourceBytesForUse = async () => {};
  const local = { files: [], notices: [], literature: { explicitPaperIds: ["P2"] }, sourceMap: { paperSources: f.sources.map(s => ({ ...s })) } };
  const originalFetch = global.fetch, providerRequests = [], terminalEvents = [], httpBodies = [];
  const model = process.env.REQUESTY_MODEL;
  global.fetch = async (url, options) => {
    if (!String(url).includes("router.requesty.ai")) return originalFetch(url, options);
    const body = JSON.parse(options.body); providerRequests.push(body);
    if (providerRequests.length <= 2) return response(frame({ tool_calls: [{ index: 0, id: `read-${providerRequests.length}`, function: { name: "read_paper_evidence", arguments: '{"paper_id":"P2","query":"license"}' } }] }, "tool_calls") + done);
    const output = JSON.parse(body.messages.findLast(m => m.role === "tool").content);
    assert.equal(output.content_available, true); assert.match(output.content, /license is restrictive/);
    return response(frame({ content: "The paper reports a restrictive license [[cite:P2:p4:original]]." }, "stop") + done);
  };
  try { await serverFixture(async url => {
    const result = await f.service.answerWithEvidenceRecovery({ localWorkspaceContext: local,
      callContext: { turnId: "stream-recovery", model },
      request: async context => {
        const body = { ...chatBody("side_chat"), model, messages: [{ role: "user", content: "Does it provide source code?" }],
          localWorkspaceContext: context, callContext: { turnId: "stream-recovery", callRole: "answer", profile: "medium" } };
        httpBodies.push(body);
        const res = await fetch(url + "/chat", { method: "POST", headers: { Authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(body) });
        // Read the actual adapter frames, then feed those same frames through the production reader.
        const frames = await res.text();
        terminalEvents.push(...[...frames.matchAll(/^event: (complete|evidence-recovery)$/gm)].map(m => m[1]));
        return readWorkbenchResponse(response(frames));
      } });
    assert.deepEqual(terminalEvents, ["evidence-recovery", "complete"]);
    assert.equal(httpBodies.length, 2); assert.equal(providerRequests.length, 3);
    assert.deepEqual(httpBodies[0].messages, httpBodies[1].messages);
    assert.deepEqual(httpBodies[0].callContext, httpBodies[1].callContext);
    assert.ok(providerRequests.every(request => request.model === model && request.stream === true));
    assert.equal(result.citations[0].sourceId, "P2"); assert.equal(result.citations[0].page, 4);
    assert.equal(result.citations[0].contentHash, "hash-P2");
    assert.equal(result.evidenceRecoveryStatus.cycle, 1);
  }); } finally { global.fetch = originalFetch; }
});
