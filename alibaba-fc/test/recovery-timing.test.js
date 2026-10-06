"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs/promises"), os = require("node:os"), path = require("node:path");
const { ContextRecovery, configFromEnv } = require("../context-recovery.js");
const { inputQuota } = require("../input-quota.js");
const ok = content => ({ ok: true, message: { role: "assistant", content }, attempts: 1 });
const quota = ms => ({ ok: false, status: 429, error: { code: "input_token_quota_exceeded", retry_after_ms: ms }, attempts: 1 });
const overflow = () => ({ ok: false, status: 400, error: { code: "context_length_exceeded" }, attempts: 1 });
const history = () => [{ role: "system", content: "Never change source files." }, { role: "user", content: "Goal inspect P1:v2" },
  { role: "assistant", content: "Verified evidence. ".repeat(400) }];
const pending = large => [{ role: "user", content: "Correction: report only. Keep P1:v2 exact." },
  { role: "assistant", tool_calls: [{ id: "read-1", type: "function", function: { name: "retrieve", arguments: '{"id":"P1:v2"}' }, extra_content: { signature: "pending" } }] },
  { role: "tool", tool_call_id: "read-1", content: large ? "PRIVATE_EVIDENCE ".repeat(3000) : "Fresh original evidence." }];
async function fixture(t, config = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "recovery-timing-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  let wall = 1800000000000, mono = 0;
  const timers = new Map(); let timerId = 0;
  const waits = [], logs = [];
  const clock = { wall: () => wall, mono: () => mono, advance: (ms, wallMs = ms) => { mono += ms; wall += wallMs; for (const [id, timer] of [...timers]) if (timer.at <= mono) { timers.delete(id); timer.fn(); } }, jumpWall: ms => wall += ms };
  const manager = new ContextRecovery({ model: "fixture", endpoint: "fixture", account: "fixture", now: clock.wall, monotonic: clock.mono,
    setTimer: (fn, ms) => { timers.set(++timerId, { fn, at: mono + ms }); return timerId; }, clearTimer: id => timers.delete(id),
    sleep: async ms => { waits.push(ms); clock.advance(ms); }, logger: { info: (_, event) => logs.push(event) },
    config: { root, window: 100000, outputTokens: 256, summaryTokens: 256, safety: 32, debug: true, ...config } });
  return { manager, clock, waits, logs };
}

test("configuration retires aggregate recovery time and independently configures provider calls and quota waiting", () => {
  const defaults = configFromEnv({}, "fixture");
  assert.equal(defaults.providerCallMs, 90000); assert.equal(defaults.recoveryMs, undefined);
  assert.equal(configFromEnv({ CONTEXT_RECOVERY_MS: "100" }, "fixture").providerCallMs, 90000);
  assert.equal(configFromEnv({ CONTEXT_PROVIDER_CALL_TIMEOUT_MS: "120000" }, "fixture").providerCallMs, 120000); assert.equal(defaults.quotaWaitMs, 180000);
  assert.equal(configFromEnv({ CONTEXT_QUOTA_WAIT_MS: "0" }, "fixture").quotaWaitMs, 0);
  assert.equal(configFromEnv({ CONTEXT_QUOTA_WAIT_MS: "240000" }, "fixture").quotaWaitMs, 240000);
});

test("58s cooldown remains separate after 80s of active work; provider and summary latency remain active", async t => {
  const { manager, clock, logs } = await fixture(t);
  const messages = [...history(), ...pending(true)], original = structuredClone(messages); manager.seed(messages, 2);
  let main = 0, summaries = 0;
  const result = await manager.run({ messages, deadlineAt: clock.wall() + 300000 }, async r => {
    if (r.stage === "context-summary") { summaries++; clock.advance(1000); return ok("Goal P1:v2, never write, verified evidence, next answer correction."); }
    main++;
    if (main === 1) { assert.deepEqual(r.messages, original); return overflow(); }
    if (main === 2) { clock.advance(80000); return quota(58000); }
    clock.advance(1000); return ok("Useful partial answer");
  });
  assert.equal(result.ok, true); assert.equal(main, 3); assert.ok(summaries > 0);
  const timing = manager.timingFields();
  assert.equal(timing.quotaWaitMs, 58000); assert.equal(timing.activeRecoveryMs, 81000 + summaries * 1000);
  assert.equal(timing.elapsedMs, timing.activeRecoveryMs + 58000);
  assert.ok(logs.some(l => l.stage === "quota-wait" && l.retryAfterMs === 58000 && l.activeRecoveryMs === 80000));
  assert.deepEqual(messages, original); assert.deepEqual(result.contextMessages.slice(-3, -1), pending(true).slice(0, 2));
  const receipt = JSON.parse(result.contextMessages.at(-1).content);
  assert.equal(await manager.archive.original(receipt.contextArchive), original.at(-1).content);
  assert.doesNotMatch(JSON.stringify(logs), /PRIVATE_EVIDENCE|Never change/);
});

test("three ordinary cooldowns accumulate to 180s, including summary quota rejections, without resetting counters", async t => {
  const { manager, clock } = await fixture(t, { maxAttempts: 6 });
  const messages = [...history(), ...pending(false)]; manager.seed(messages, 2);
  let main = 0, summaries = 0, requiredUntil = 0;
  const result = await manager.run({ messages, deadlineAt: clock.wall() + 300000 }, async r => {
    assert.ok(clock.mono() >= requiredUntil, "no summary or normal call precedes confirmed cooldown");
    if (r.stage === "context-summary") {
      summaries++; clock.advance(1000);
      if (summaries <= 2) { requiredUntil = clock.mono() + 60000; return quota(60000); }
      return ok("Goal inspect P1:v2; never modify files; next report.");
    }
    if (++main === 1) { requiredUntil = clock.mono() + 60000; return quota(60000); }
    clock.advance(2000); return ok("done");
  });
  assert.equal(result.ok, true); assert.equal(manager.timingFields().quotaWaitMs, 180000);
  assert.equal(manager.timingFields().activeRecoveryMs, summaries * 1000 + 2000);
  assert.equal(manager.summaryCalls, summaries); assert.equal(manager.recoverySteps, 3); assert.equal(main, 2);
});

for (const large of [false, true]) test(`cancellation charges only actual waiting before ${large ? "normal" : "summary"} dispatch`, async t => {
  const { manager, clock, logs } = await fixture(t);
  const controller = new AbortController(), messages = [...history(), ...pending(large)]; manager.seed(messages, 2);
  manager.sleep = async () => { clock.advance(123); controller.abort(); throw new Error("cancelled sleep"); };
  let calls = 0;
  await assert.rejects(manager.run({ messages, signal: controller.signal }, async () => { calls++; return quota(58000); }), { code: "OPERATION_ABORTED" });
  assert.equal(calls, 1); assert.equal(manager.timingFields().quotaWaitMs, 123); assert.equal(manager.timingFields().activeRecoveryMs, 0);
  assert.equal(manager.summaryCalls, 0); assert.ok(manager.state.references.length);
  assert.ok(logs.some(l => l.stage === "quota-wait-finished" && l.quotaWaitMs === 123));
});

test("shortened waits charge actual durations and recheck before dispatch", async t => {
  const { manager, clock } = await fixture(t);
  manager.sleep = async ms => clock.advance(Math.min(ms, 100));
  let calls = 0;
  const result = await manager.run({ messages: pending(true), deadlineAt: clock.wall() + 300000 }, async () => ++calls === 1 ? quota(1000) : ok("done"));
  assert.equal(result.ok, true); assert.equal(calls, 2); assert.equal(manager.timingFields().quotaWaitMs, 1000);
  assert.equal(manager.timingFields().activeRecoveryMs, 0);
});

for (const kind of ["quota_wait", "hard_request_deadline"]) test(`${kind} exhaustion is precise and schedules no automatic continuation`, async t => {
  const { manager, clock } = await fixture(t, { quotaWaitMs: kind === "quota_wait" ? 57000 : 180000 });
  let calls = 0;
  const result = await manager.run({ messages: pending(true), deadlineAt: clock.wall() + (kind === "hard_request_deadline" ? 57000 : 300000) }, async () => { calls++; return quota(58000); });
  assert.equal(calls, 1); assert.equal(result.ok, false); assert.equal(result.automaticRetryScheduled, false);
  assert.equal(result.retryAfterMs, 58000); assert.equal(result.timing.quotaWaitMs, 0);
  assert.equal(result.recoveryStopReason, kind === "quota_wait" ? "quota_wait_budget_exhausted" : "hard_request_deadline_exhausted");
  assert.match(result.partialReply, /58 seconds/); assert.match(result.partialReply, /No automatic retry or background continuation is scheduled/);
});

test("summary exceeding its per-call timeout retains a degraded checkpoint and reports exact cause", async t => {
  const { manager, clock } = await fixture(t, { providerCallMs: 1000 }); manager.seed(history(), 2);
  let main = 0, summary = 0;
  const result = await manager.run({ messages: [...history(), ...pending(false)], deadlineAt: clock.wall() + 300000 }, async r => {
    if (r.stage === "context-summary") { summary++; clock.advance(180001); return ok("Checkpoint"); }
    main++; return quota(58000);
  });
  assert.equal(main, 1); assert.equal(summary, 1); assert.equal(result.recoveryStopReason, "provider_call_timeout");
  assert.equal(result.timing.quotaWaitMs, 58000); assert.equal(result.timing.activeRecoveryMs, 180001);
  assert.ok(manager.state.checkpoints.length); assert.equal(result.contextDegraded, true); assert.equal(result.checkpointCount, manager.state.checkpoints.length); assert.deepEqual(result.contextMessages.slice(-3), pending(false));
});

test("provider latency and generic backoff consume the per-call timeout across alternating recovery modes", async t => {
  const { manager, clock } = await fixture(t, { providerCallMs: 1000 }); manager.seed(history(), 2);
  let main = 0;
  const result = await manager.run({ messages: [...history(), ...pending(true)], deadlineAt: clock.wall() + 300000 }, async r => {
    if (r.stage === "context-summary") return ok("Checkpoint");
    if (++main === 1) return quota(58000);
    clock.advance(180001); // Represents provider latency plus its generic backoff, not a quota sleep.
    return overflow();
  });
  assert.equal(main, 2); assert.equal(result.recoveryStopReason, "provider_call_timeout");
  assert.equal(result.timing.activeRecoveryMs, 180001); assert.equal(result.timing.quotaWaitMs, 58000);
  assert.equal(manager.recoverySteps, 1); assert.equal(manager.dispatches, 2);
});

test("scheduler overshoot beyond a confirmed wait remains active and hard deadline is rechecked", async t => {
  const { manager, clock } = await fixture(t);
  manager.sleep = async ms => clock.advance(ms + 2000);
  let calls = 0;
  const result = await manager.run({ messages: pending(true), deadlineAt: clock.wall() + 2000 }, async () => { calls++; return quota(1000); });
  assert.equal(calls, 1); assert.equal(result.recoveryStopReason, "hard_request_deadline_exhausted");
  assert.equal(result.timing.quotaWaitMs, 1000); assert.equal(result.timing.activeRecoveryMs, 2000);
});

test("wall-clock jumps cannot lengthen provider waits or extend the hard request lifetime", async t => {
  const { manager, clock } = await fixture(t);
  manager.quota.record(inputQuota({ ...quota(0), error: { code: "input_token_quota_exceeded", reset_at: clock.wall() + 58000 } }, clock.wall()));
  clock.jumpWall(-3600000); assert.equal(manager.quota.delay(), 58000);
  clock.advance(58000, 0); assert.equal(manager.quota.delay(), 0);
  const deadlineAt = clock.wall() + 1000;
  let calls = 0;
  const result = await manager.run({ messages: pending(true), deadlineAt }, async () => {
    calls++; clock.jumpWall(-3600000); clock.advance(1100, 0); return overflow();
  });
  assert.equal(calls, 1); assert.equal(result.recoveryStopReason, "hard_request_deadline_exhausted");
});

for (const [hardMs, merge] of [[180000, false], [88000, false], [240000, true]]) test(`productive 45s summaries, merge=${merge}, respect the ${hardMs}ms hard deadline`, async t => {
  const { manager, clock, logs } = await fixture(t);
  const messages = [...history(), ...pending(false)], original = structuredClone(messages);
  manager.seed(messages, 2);
  const deadlineAt = clock.wall() + hardMs;
  let main = 0, summaries = 0;
  const result = await manager.run({ messages, deadlineAt }, async request => {
    assert.ok(request.deadlineAt <= deadlineAt);
    if (request.stage === "context-summary") {
      summaries++; assert.equal(manager.recoverySteps, 1);
      assert.equal(manager.summaryCalls, summaries);
      clock.advance(45000);
      return ok(merge && summaries <= 2 ? "Goal P1:v2 verified findings. ".repeat(30) : `Verified checkpoint ${summaries}: inspect P1:v2, never change files.`);
    }
    if (++main === 1) {
      assert.deepEqual(request.messages, original);
      return { ok: false, status: 400, error: { code: "input_too_large", max_input_tokens: 1600 }, attempts: 1 };
    }
    clock.advance(1000); return ok("Final answer using both checkpoints.");
  });
  assert.equal(summaries, merge ? 3 : 2); assert.equal(manager.summaryCalls, summaries); assert.equal(manager.recoverySteps, 1);
  assert.deepEqual(messages, original); assert.deepEqual(result.contextMessages.slice(-3), pending(false));
  assert.ok(manager.state.checkpoints.length);
  if (hardMs !== 88000) {
    assert.equal(result.ok, true); assert.equal(main, 2); assert.equal(manager.timingFields().activeRecoveryMs, summaries * 45000 + 1000);
    assert.deepEqual(manager.callCounts(), { callsDispatched: summaries + 2, callsCompleted: summaries + 2, callsTimedOut: 0, callsCancelled: 0 });
  } else {
    assert.equal(result.recoveryStopReason, "hard_request_deadline_exhausted"); assert.equal(main, 1);
    assert.equal(result.contextDegraded, true); assert.equal(result.callsTimedOut, 1);
  }
  const completed = logs.filter(e => e.stage === "provider-call" && e.callStatus !== "dispatched");
  assert.equal(new Set(completed.map(e => e.callId)).size, completed.length);
  assert.ok(completed.every(e => e.estimatedTokens > 0 && e.outputReserve > 0 && e.timeoutMs > 0));
});

test("a stalled call expires under the injected timer and reports one dispatch and one timeout", async t => {
  const { manager, clock, logs } = await fixture(t, { providerCallMs: 2000 });
  let aborted = false;
  const result = await manager.run({ messages: pending(false), deadlineAt: clock.wall() + 300000 }, async r => {
    r.signal.addEventListener("abort", () => { aborted = true; });
    queueMicrotask(() => clock.advance(2000));
    return new Promise(() => {});
  });
  assert.equal(aborted, true); assert.equal(result.recoveryStopReason, "provider_call_timeout");
  assert.equal(result.automaticRetryScheduled, false);
  assert.deepEqual(manager.callCounts(), { callsDispatched: 1, callsCompleted: 0, callsTimedOut: 1, callsCancelled: 0 });
  assert.equal(logs.find(e => e.callStatus === "timed_out").durationMs, 2000);
});

test("cancellation terminates a stalled provider call even if the provider ignores its signal", async t => {
  const { manager, clock } = await fixture(t);
  const controller = new AbortController();
  await assert.rejects(manager.run({ messages: pending(false), signal: controller.signal }, async () => {
    queueMicrotask(() => { clock.advance(123); controller.abort(); });
    return new Promise(() => {});
  }), { code: "OPERATION_ABORTED" });
  assert.deepEqual(manager.callCounts(), { callsDispatched: 1, callsCompleted: 0, callsTimedOut: 0, callsCancelled: 1 });
  assert.equal(manager.timingFields().quotaWaitMs, 0);
});

test("exhausted summary allowance is reported precisely when fallback cannot reduce further", async t => {
  const { manager, clock } = await fixture(t, { maxSummaryCalls: 1, maxAttempts: 8 });
  const messages = [...history(), ...pending(false)]; manager.seed(messages, 2);
  let summaries = 0, normal = 0;
  const rejected = new Set();
  const result = await manager.run({ messages, deadlineAt: clock.wall() + 300000 }, async request => {
    if (request.stage === "context-summary") { summaries++; return ok("Verified P1:v2. Never change files."); }
    const payload = JSON.stringify(request.messages); assert.ok(!rejected.has(payload)); rejected.add(payload); normal++;
    return { ok: false, status: 400, error: { code: "input_too_large", max_input_tokens: 1600 }, attempts: 1 };
  });
  assert.equal(summaries, 1); assert.ok(normal <= 9);
  assert.equal(result.recoveryStopReason, "summary_call_limit_exhausted");
  assert.equal(result.contextDegraded, true); assert.equal(result.automaticRetryScheduled, false);
  assert.match(result.partialReply, /summary-call limit/);
});

test('sequential generic summaries each receive 180s after preparation and quota waiting',async t=>{
 const {manager,clock,logs}=await fixture(t);
 manager.recoveryStarted=clock.mono();manager.signal=new AbortController().signal;
 manager.hardDeadlineAt=clock.wall()+1000000;
 manager.quota.record(inputQuota(quota(58000),clock.wall()));
 for(let i=0;i<2;i++){
  const result=await manager.dispatch(async request=>{
   assert.equal(request.providerCallTimeoutMs,180000);
   assert.equal(request.deadlineAt-clock.wall(),180000);
   clock.advance(170000);return ok('Useful summary');
  },{stage:'context-summary',messages:history()},async options=>{clock.advance(40000);return options;});
  assert(result.ok);
 }
 assert.equal(manager.timingFields().quotaWaitMs,58000);
 assert.equal(manager.callCounts().callsCompleted,2);
 assert.deepEqual(logs.filter(e=>e.stage==='provider-call'&&e.callStatus==='dispatched').map(e=>e.timeoutMs),[180000,180000]);
});

for(const transport of ['responses-json','responses-sse','requesty-json','requesty-sse'])test(`${transport} full response body remains inside the recovery timer`,async t=>{
 const {manager,clock}=await fixture(t);
 manager.recoveryStarted=clock.mono();manager.signal=new AbortController().signal;
 manager.hardDeadlineAt=clock.wall()+1000000;
 let aborted=false,bodyStarted=false;
 const sse=transport.endsWith('sse');
 const fetchImpl=async (_url,options)=>{
  options.signal.addEventListener('abort',()=>{aborted=true;});
  // Headers arrive immediately, but reading the response stalls.
  if(!sse)return {ok:true,status:200,headers:new Headers({'content-type':'application/json'}),json:async()=>{bodyStarted=true;queueMicrotask(()=>clock.advance(180000));return new Promise(()=>{});},text:async()=>{bodyStarted=true;queueMicrotask(()=>clock.advance(180000));return new Promise(()=>{});}};
  return new Response(new ReadableStream({pull(){bodyStarted=true;queueMicrotask(()=>clock.advance(180000));return new Promise(()=>{});}}),{headers:{'content-type':'text/event-stream'}});
 };
 if(transport.startsWith('requesty'))t.mock.method(globalThis,'fetch',fetchImpl);
 const result=await manager.dispatch(request=>transport.startsWith('responses')
  ?require('../provider-lifecycle.js').responses({api:'responses',endpoint:'https://offline.invalid/v1/responses',apiKey:'fixture',model:'fixture'},request,{signal:request.signal,fetchImpl})
  :require('../index.js')._test.requestRequestyMessage({model:'fixture',messages:request.messages},'fixture',false,sse?{signal:request.signal}:null,{signal:request.signal,deadlineAt:request.deadlineAt,maxAttempts:1}),
 {stage:'context-summary',messages:history()});
 assert(bodyStarted);assert(aborted);assert.equal(result.recoveryStopReason,'provider_call_timeout');
 assert.equal(manager.callCounts().callsTimedOut,1);
 const event=manager.corpusDiagnostics().events.find(e=>e.event==='recovery-provider-call');
 assert.equal(event.timeoutMs,180000);assert.equal(event.reason,'provider_call_timeout');
});

test('a shorter call-specific outer deadline is never classified as provider timeout',async t=>{
 const {manager,clock}=await fixture(t);manager.recoveryStarted=clock.mono();
 const result=await manager.dispatch(async r=>{assert.equal(r.providerCallTimeoutMs,180000);queueMicrotask(()=>clock.advance(60000));return new Promise(()=>{});},
 {stage:'context-summary',messages:history(),deadlineAt:clock.wall()+60000});
 assert.equal(result.recoveryStopReason,'hard_request_deadline_exhausted');
 assert.equal(manager.corpusDiagnostics().events.at(-1).outerDeadlineLimited,true);
});

test('outer transport abort at its deadline reports hard deadline rather than cancellation or call timeout',async t=>{
 const {manager,clock}=await fixture(t);const controller=new AbortController();
 manager.recoveryStarted=clock.mono();manager.hardDeadlineAt=clock.wall()+60000;manager.signal=controller.signal;
 const result=await manager.dispatch(async()=>{clock.advance(60000);controller.abort();return new Promise(()=>{});},{stage:'context-summary',messages:history()});
 assert.equal(result.recoveryStopReason,'hard_request_deadline_exhausted');assert.equal(manager.callCounts().callsTimedOut,1);
});

test('delayed scheduling past both deadlines retains the earlier individual timeout cause',async t=>{
 const {manager,clock}=await fixture(t);manager.recoveryStarted=clock.mono();manager.hardDeadlineAt=clock.wall()+200000;
 const result=await manager.dispatch(async()=>{clock.advance(210000);return ok('Too late');},{stage:'context-summary',messages:history()});
 assert.equal(result.recoveryStopReason,'provider_call_timeout');
});
