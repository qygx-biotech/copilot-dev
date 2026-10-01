"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const jwt = require("jsonwebtoken");
const timing = require("../chat-timing.js");
const { createRuntimeLogger } = require("../../docs/runtime-log.js");
const { readWorkbenchResponse } = require("../../shared/event-stream.js");
const id = "11111111-2222-4333-8444-555555555555";

test("client timing separates a 250s transport gap from a 40s handler and a slow transcript save", () => {
  let mono = 0;
  const log = createRuntimeLogger({ sink: null, heartbeatMs: 0, monotonic: () => mono, resourceEntries: () => [{
    initiatorType: "fetch", startTime: 10, responseEnd: 290010, duration: 290000, transferSize: 2000,
    domainLookupStart: 10, domainLookupEnd: 110, connectStart: 110, connectEnd: 510,
    secureConnectionStart: 210, requestStart: 510, responseStart: 289010,
  }] });
  const trace = log.chatTiming({ turnId: "fixture-turn", prompt: "SECRET_PROMPT" });
  const serialization = trace.start("request_serialization"); mono += 10; serialization({ requestBytes: 1200 });
  trace.dispatch("https://fixture/chat", 1200); mono += 289000;
  trace.headers(new Response("", { status: 200 }));
  const read = trace.start("response_read"); mono += 1000; read();
  trace.server({ version: 1, requestId: id, handlerMs: 40000, events: [{ stage: "provider_fetch_end", durationMs: 39000, prompt: "SECRET_DOCUMENT" }] });
  const save = trace.start("transcript_save"); mono += 17000; save(); trace.finish("final_answer");
  const details = stage => log.entries().find(e => e.details.stage === stage).details;
  assert.equal(details("round_trip").clientOutsideHandlerMs, 250000);
  assert.equal(details("round_trip").clientRoundTripMs, 290000);
  assert.equal(details("transcript_save_end").durationMs, 17000);
  assert.equal(details("browser_network").dnsMs, 100); assert.equal(details("browser_network").tlsMs, 300);
  assert.equal(details("provider_fetch_end").serverRequestId, id);
  assert.equal(new Set(log.entries().map(e => e.details.requestId)).size, 1);
  assert.doesNotMatch(log.exportText(), /SECRET_|https:/);
});

test("missing or ambiguous Resource Timing and old backends are explicit, not zero latency", () => {
  for (const entries of [[], [{ initiatorType: "fetch", startTime: 0, responseEnd: 1 }, { initiatorType: "fetch", startTime: 0, responseEnd: 1 }]]) {
    const log = createRuntimeLogger({ sink: null, heartbeatMs: 0, monotonic: () => 0, resourceEntries: () => entries });
    const trace = log.chatTiming({}); trace.dispatch("fixture", 1); trace.server(null);
    const roundTrip = log.entries().find(e => e.details.stage === "round_trip").details;
    assert.equal(roundTrip.serverTimingAvailable, false); assert.ok(!("clientOutsideHandlerMs" in roundTrip));
    const network = log.entries().at(-1).details;
    assert.equal(network.resourceTimingAvailable, false); assert.equal(network.networkTimingAmbiguous, entries.length > 1);
    assert.ok(!("dnsMs" in network));
  }
});

test("server traces stay request-local, bounded, monotonic and content-free", async () => {
  let clock = 0; const logs = [];
  const a = timing.create({ now: () => clock, logger: { info: (_, e) => logs.push(e) } });
  const b = timing.create({ now: () => clock, logger: { info: (_, e) => logs.push(e) } });
  a.activate(); b.activate();
  await Promise.all([timing.run(a, async () => { const end = timing.start("provider_fetch", { prompt: "SECRET", requestBytes: 10 }); await Promise.resolve(); clock += 40; end(); }),
    timing.run(b, async () => { await Promise.resolve(); timing.mark("validation_done"); })]);
  assert.equal(a.snapshot().events[1].durationMs, 40);
  assert.deepEqual(b.snapshot().events.map(e => e.stage), ["validation_done"]);
  for (let i = 0; i < 300; i++) a.mark("step");
  assert.equal(a.snapshot().events.length, 256); assert.ok(a.snapshot().droppedEvents > 0);
  assert.doesNotMatch(JSON.stringify(logs), /SECRET/);
  const broken = timing.create({ logger: { info() { throw new Error("bad sink"); } } }); broken.activate();
  assert.doesNotThrow(() => broken.mark("handler_entry"));
});

test("buffered and streamed readers report byte/parse boundaries without changing answers", async () => {
  const stages = [];
  const result = await readWorkbenchResponse(new Response(JSON.stringify({ reply: "PRIVATE_ANSWER" })), { onTiming: stage => stages.push(stage) });
  assert.equal(result.reply, "PRIVATE_ANSWER");
  assert.deepEqual(stages, ["buffered_body_start", "buffered_body_end", "json_parse_start", "json_parse_end"]);
  stages.length = 0;
  const response = new Response('event: complete\ndata: {"reply":"PRIVATE_ANSWER"}\n\n', { headers: { "content-type": "text/event-stream" } });
  assert.equal((await readWorkbenchResponse(response, { onTiming: stage => stages.push(stage) })).reply, "PRIVATE_ANSWER");
  assert.deepEqual(stages, ["first_response_bytes"]);
});

test("production buffered handler returns correlated preparation/provider timing only under debug", async t => {
  const env = { JWT_SECRET: "timing-fixture", ADMIN_ACCOUNT: "timing-fixture", REQUESTY_API_KEY: "SECRET_KEY", REQUESTY_MODEL: "google/gemma-4-31b-it", CHAT_TIMING_DEBUG: "1", CONTEXT_DEBUG: "0" };
  const previous = Object.fromEntries(Object.keys(env).map(k => [k, process.env[k]])); Object.assign(process.env, env);
  t.after(() => { for (const k of Object.keys(env)) previous[k] === undefined ? delete process.env[k] : process.env[k] = previous[k]; });
  const logs = []; t.mock.method(console, "info", (...args) => logs.push(args));
  t.mock.method(console, "log", () => {});
  let calls = 0;
  t.mock.method(globalThis, "fetch", async () => { calls++; return new Response(JSON.stringify({ choices: [{ message: { content: "PRIVATE_ANSWER" } }] })); });
  const backend = require("../index.js");
  const token = jwt.sign({ account: env.ADMIN_ACCOUNT, role: "admin" }, env.JWT_SECRET);
  const event = { httpMethod: "POST", path: "/chat", headers: { authorization: `Bearer ${token}` }, body: JSON.stringify({
    mode: "side_chat", timingRequestId: id, messages: [{ role: "user", content: "PRIVATE_QUESTION" }], callContext: { turnId: "timing-turn", callRole: "answer", profile: "medium" },
  }) };
  const response = await backend.handler(event, {}), data = JSON.parse(response.body);
  assert.equal(response.statusCode, 200); assert.equal(data.reply, "PRIVATE_ANSWER"); assert.equal(calls, 1);
  assert.equal(data.chatTiming.clientRequestId, id); assert.ok(data.chatTiming.handlerMs >= 0);
  const stages = data.chatTiming.events.map(e => e.stage);
  for (const stage of ["handler_entry", "authentication_done", "body_parsed", "validation_done", "stored_context_end", "model_capabilities_end", "recovery_deadline_started", "provider_fetch_end", "provider_body_end", "agent_loop_end", "response_serialization_end", "handler_result"]) assert.ok(stages.includes(stage), stage);
  assert.match(response.headers["server-timing"], /^app;dur=/);
  assert.doesNotMatch(JSON.stringify(data.chatTiming), /PRIVATE_|SECRET_KEY|Bearer/);
  assert.doesNotMatch(JSON.stringify(logs.filter(([name]) => name === "chat_timing")), /PRIVATE_|SECRET_KEY|Bearer/);
  process.env.CHAT_TIMING_DEBUG = "0";
  const plain = await backend.handler(event, {});
  assert.equal(JSON.parse(plain.body).chatTiming, undefined); assert.equal(plain.headers["server-timing"], undefined);
});
