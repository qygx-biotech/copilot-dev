"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs/promises"), os = require("node:os"), path = require("node:path");
const { ContextRecovery, overflow, estimateRequest, Archive } = require("../context-recovery.js");
const ok = content => ({ ok: true, message: { role: "assistant", content }, attempts: 1 });
const tooLong = metadata => ({ ok: false, status: 400, error: { code: "context_length_exceeded", metadata }, attempts: 1 });
const call = id => ({ role: "assistant", content: null, tool_calls: [{ id, type: "function", function: { name: "read", arguments: "{}" }, extra_content: { signature: "pending-signature" } }] });
const tool = (id, content) => ({ role: "tool", tool_call_id: id, content });
async function fixture(t, config = {}, rest = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "context-test-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const logs = [];
  const options = { model: "model-a", endpoint: "fixture", account: "account-a", config: { root, outputTokens: 256, safety: 32, summaryTokens: 256, maxSummaryCalls: 24, debug: true, ...config }, logger: { info: (...args) => logs.push(args) }, ...rest };
  return { manager: new ContextRecovery(options), options, logs, root };
}
function history() { return [{ role: "system", content: "Protect source files." }, { role: "user", content: "Goal: inspect P1. Correction: never write files." }, { role: "assistant", content: "Verified result P1:v2. " + "historical detail\n".repeat(1800) }]; }

test("normal requests retain available context and raw transcript unchanged", async t => {
  const { manager } = await fixture(t, { window: 100000 });
  const messages = [...history(), call("pending"), tool("pending", "large result ".repeat(3000))];
  const original = structuredClone(messages);
  let calls = 0;
  const result = await manager.run({ messages, tools: [] }, async options => { calls++; assert.deepEqual(options.messages, messages); return ok("done"); });
  assert.equal(result.ok, true); assert.equal(calls, 1); assert.deepEqual(messages, original); assert.equal(manager.state.checkpoints.length, 0);
});

test("full request counting includes schemas, signatures and bounded multimodal cost", () => {
  const base = { messages: [{ role: "system", content: "a" }, { role: "user", content: "b" }] };
  const withSchema = { ...base, tools: [{ name: "a", description: "tool ".repeat(1000) }] };
  assert.ok(estimateRequest(withSchema) > estimateRequest(base) + 1000);
  assert.ok(estimateRequest({ ...base, continuationState: "opaque".repeat(1000) }) > estimateRequest(base));
  const picture = n => ({ messages: [{ role: "user", content: [{ type: "image_url", image_url: { url: "data:image/png;base64," + "a".repeat(n) } }] }] });
  assert.equal(estimateRequest(picture(100)), estimateRequest(picture(100000)));
  assert.ok(estimateRequest(picture(1)) >= 4096);
});

test("structured overflow normalizes input-only versus total limits and ignores other failures", () => {
  assert.deepEqual(overflow(tooLong({ max_input_tokens: 4000, input_tokens: 4500 })), { limit: 4000, scope: "input", inputTokens: 4500, totalTokens: null });
  assert.equal(overflow(tooLong({ context_window: 8000, total_tokens: 9000 })).scope, "total");
  assert.equal(overflow({ status: 400, error: { message: "This model's maximum context length is 8,192 tokens. You requested 9,000 tokens (8,000 tokens in the messages)." } }).inputTokens, 8000);
  assert.equal(overflow({ status: 400, error: { message: "prompt is too long: 25000 tokens > 20000 maximum" } }).scope, "input");
  assert.equal(overflow({ status: 400, error: { code: "invalid_request", metadata: { raw: JSON.stringify({ error: { code: "context_length_exceeded", max_input_tokens: 2048 } }) } } }).limit, 2048);
  assert.deepEqual(overflow({ status: 400, error: { message: "The input token count (25,000) exceeds the maximum number of tokens allowed (20,000)." } }),
    { limit: 20000, scope: "input", inputTokens: 25000, totalTokens: null });
  for (const error of [{ status: 429, error: "context_length_exceeded" }, { status: 401, error: "prompt_too_long" }, { status: 500, message: "maximum context length" },
    { status: 400, error: "max_tokens_exceeded", message: "output tokens exceed limit" }, { status: 400, message: "too many tokens" }, { finishReason: "length", error: "context_length_exceeded" }]) assert.equal(overflow(error), null);
});

for (const scope of ["input", "total", "unknown"]) test(`overflow ${scope}: preserve pending input, pairings and explicit checkpoint boundary`, async t => {
  const { manager, logs } = await fixture(t);
  const h = history(); manager.seed(h, 2);
  const delta = [{ role: "user", content: "Current correction: answer only; do not modify P1." }, call("pending"), tool("pending", "fresh P1:v2 evidence")];
  const messages = [...h, ...delta], original = structuredClone(messages);
  let main = 0;
  const result = await manager.run({ messages, tools: [] }, async options => {
    if (options.stage === "context-summary") { assert.equal(options.tools.length, 0); assert.equal(options.messages.length, 2); return ok("Goal: inspect P1. Never write files. Verified P1:v2. Next: answer current correction."); }
    main++;
    if (main === 1) return tooLong(scope === "unknown" ? {} : { [scope === "input" ? "max_input_tokens" : "context_window"]: 5000, input_tokens: 10000 });
    assert.deepEqual(options.messages.slice(-delta.length), delta);
    assert.ok(estimateRequest(options) < estimateRequest({ messages }));
    return ok("answer");
  });
  assert.equal(result.ok, true); assert.equal(main, 2); assert.deepEqual(messages, original);
  assert.equal(manager.state.checkpoints[0].boundary, 2);
  assert.equal(manager.state.checkpoints[0].archiveRef.length, 64);
  assert.ok(logs.some(([, entry]) => entry.continuationStateReset));
  assert.doesNotMatch(JSON.stringify(logs), /historical detail|pending-signature|Current correction/);
});

test("reported counts correct a local underestimate and persist limits isolated by endpoint/model/account", async t => {
  const { manager, options } = await fixture(t);
  const input = { messages: history(), tools: [] };
  const estimate = manager.tokens(input);
  await manager.learn({ limit: 15000, scope: "total", inputTokens: estimate * 2 }, input);
  assert.ok(manager.tokens(input) >= estimate * 2);
  const next = new ContextRecovery(options); await next.load(); assert.equal(next.budget(), 15000 - 256 - 32);
  for (const change of [{ model: "other" }, { endpoint: "other" }, { account: "other" }]) {
    const other = new ContextRecovery({ ...options, ...change }); await other.load(); assert.equal(other.budget(), Infinity);
  }
});

test("learned budget cannot compact an accepted next request", async t => {
  const { manager, options } = await fixture(t);
  await manager.learn({ limit: 3000, scope: "input", inputTokens: 10000 }, { messages: history() });
  const next = new ContextRecovery(options); next.seed(history(), 2);
  let main = 0, summaries = 0;
  const result = await next.run({ messages: [...history(), { role: "user", content: "Continue" }], tools: [] }, async request => {
    if (request.stage === "context-summary") { summaries++; assert.ok(next.tokens(request) <= next.budget(request.maxTokens)); return ok("Goal inspect P1. Never write. Next answer."); }
    main++; return ok("done");
  });
  assert.equal(result.ok, true); assert.equal(main, 1); assert.equal(summaries, 0);
  assert.deepEqual(result.contextMessages, [...history(), { role: "user", content: "Continue" }]);
});

test("oversized summarizer input shrinks/splits and every later call fits learned budget", async t => {
  const { manager } = await fixture(t, { window: 6000 }); manager.seed(history(), 2);
  let rejectedSize = null, summaries = 0, main = 0;
  const result = await manager.run({ messages: [...history(), { role: "user", content: "Continue" }], tools: [] }, async options => {
    if (options.stage !== "context-summary") return ++main === 1 ? tooLong({ max_input_tokens: 6000 }) : ok("done");
    const size = manager.tokens(options); summaries++;
    assert.ok(size <= manager.budget(options.maxTokens));
    if (!rejectedSize) { rejectedSize = size; return tooLong({ max_input_tokens: Math.floor(size * 0.7), input_tokens: size }); }
    assert.ok(size < rejectedSize); return ok("Goal inspect P1; constraint never write; result P1:v2; next answer.");
  });
  assert.equal(result.ok, true); assert.ok(summaries >= 3); assert.ok(summaries <= 24);
});

test("oversized pending tool output is saved exactly and read in bounded sections", async t => {
  const { manager } = await fixture(t, { window: 3500 });
  const text = "Document page\n".repeat(5000);
  const messages = [{ role: "system", content: "System" }, { role: "user", content: "Find X" }, call("large"), tool("large", text)];
  let main = 0;
  const result = await manager.run({ messages, tools: [] }, async options => {
    if (++main === 1) { assert.deepEqual(options.messages, messages); return tooLong({ max_input_tokens: 3500 }); }
    assert.equal(options.messages.at(-2).tool_calls[0].id, "large");
    const receipt = JSON.parse(options.messages.at(-1).content);
    assert.equal(receipt.omitted, true); assert.equal(receipt.preview, text.slice(0, 1000));
    let recovered = "", offset = 0;
    do { const section = await manager.archive.read(receipt.contextArchive, offset, 4000); recovered += section.content; offset = section.nextOffset; } while (offset !== null);
    assert.equal(recovered, text); return ok("done");
  });
  assert.equal(result.ok, true); assert.equal(messages.at(-1).content, text); assert.equal(manager.summaryCalls, 0);
});

test("oversized user instructions remain exact; essential content produces an actionable failure", async t => {
  const { manager } = await fixture(t, { window: 1000 });
  const messages = [{ role: "system", content: "system" }, { role: "user", content: "Never drop this instruction. ".repeat(2000) }];
  const original = structuredClone(messages);
  const result = await manager.run({ messages, tools: [] }, async request => { assert.deepEqual(request.messages, original); return tooLong({ max_input_tokens: 1000 }); });
  assert.equal(result.error, "ContextRecoveryIncomplete"); assert.match(result.partialReply, /one bounded document section/);
  assert.deepEqual(messages, original); assert.deepEqual(result.contextMessages, original);
});

test("excessive schemas are preserved and fail precisely rather than dropping capabilities", async t => {
  const { manager } = await fixture(t, { window: 1000 });
  const tools = [{ type: "function", function: { name: "protected", description: "schema ".repeat(2000) } }];
  const result = await manager.run({ messages: [{ role: "user", content: "Hi" }], tools }, async request => { assert.deepEqual(request.tools, tools); return tooLong({ max_input_tokens: 1000 }); });
  assert.equal(result.error, "ContextRecoveryIncomplete"); assert.equal(tools[0].function.name, "protected");
});

test("all summary calls failing yields a grounded degraded checkpoint and a minimal normal attempt", async t => {
  const { manager } = await fixture(t, { window: 4000 }); manager.seed(history(), 2);
  let main = 0;
  const result = await manager.run({ messages: [...history(), { role: "user", content: "Continue" }], tools: [] }, async request => {
    if (request.stage === "context-summary") return { ok: false, status: 503, error: "unavailable" };
    if (++main === 1) return tooLong({ max_input_tokens: 4000 });
    assert.match(JSON.stringify(request.messages), /Incomplete extractive checkpoint/); return ok("partial findings");
  });
  assert.equal(result.ok, true); assert.equal(result.contextDegraded, true); assert.equal(manager.state.checkpoints[0].degraded, true);
});

test("repeated overflow and rejected summaries terminate without resubmitting identical payload", async t => {
  const { manager } = await fixture(t, { maxSummaryCalls: 5, maxAttempts: 3 }); manager.seed(history(), 2);
  const seen = new Set(); let calls = 0;
  const result = await manager.run({ messages: [...history(), { role: "user", content: "Continue" }], tools: [] }, async request => {
    calls++; const payload = JSON.stringify(request.messages); assert.ok(!seen.has(payload)); seen.add(payload); return tooLong({});
  });
  assert.equal(result.error, "ContextRecoveryIncomplete"); assert.ok(calls <= 9); assert.match(result.partialReply, /task is incomplete/);
});

test("provider unavailable after degraded compaction returns honest failure", async t => {
  const { manager } = await fixture(t, { window: 4000 }); manager.seed(history(), 2);
  let main = 0;
  const result = await manager.run({ messages: [...history(), { role: "user", content: "Continue" }], tools: [] }, async () => ++main === 1 ? tooLong({ max_input_tokens: 4000 }) : ({ ok: false, status: 503, error: "unavailable" }));
  assert.equal(result.error, "ContextRecoveryIncomplete"); assert.equal(result.recoveryStopReason, "provider_unavailable_during_recovery");
});

test("non-overflow errors bypass recovery, including output truncation", async t => {
  for (const failure of [{ ok: false, status: 429, error: "rate_limit" }, { ok: false, status: 401, error: "auth" }, { ok: false, error: "NETWORK_ERROR" }, { ...ok("partial"), finishReason: "length" }]) {
    const { manager } = await fixture(t); let calls = 0;
    const result = await manager.run({ messages: history() }, async () => { calls++; return failure; });
    assert.equal(calls, 1); assert.equal(result.error, failure.error); assert.equal(manager.state.checkpoints.length, 0);
  }
});

test("per-call timeout bounds a stalled summarizer", async t => {
  const { manager } = await fixture(t, { window: 4000, providerCallMs: 30 }); manager.seed(history(), 2);
  let aborted = false, main = 0;
  const result = await manager.run({ messages: history() }, async request => ++main === 1 ? tooLong({ max_input_tokens: 4000 }) : new Promise(resolve => request.signal.addEventListener("abort", () => { aborted = true; resolve({ ok: false }); })));
  assert.equal(result.error, "ContextRecoveryIncomplete"); assert.equal(aborted, true);
});

test("archive denies path traversal and reports missing host data without fabricating results", async t => {
  const { root } = await fixture(t); const archive = new Archive(root);
  assert.equal((await archive.read("../../secret")).error, "INVALID_ARCHIVE_REFERENCE");
  assert.equal((await archive.read("a".repeat(64))).error, "ARCHIVE_UNAVAILABLE");
});

test("signed recovery state preserves pending parallel tool exchanges across a handoff", async t => {
  const { manager, options } = await fixture(t);
  await manager.run({ messages: history() }, async () => ok("tool request"));
  const signed = require("../agent-continuation.js");
  const state = signed.open(signed.seal({ contextRecovery: manager.snapshot() }, { project: "P1" }, "fixture"), { project: "P1" }, "fixture");
  const resumed = new ContextRecovery({ ...options, state: state.contextRecovery });
  const assistant = call("a"); assistant.tool_calls.push(call("b").tool_calls[0]);
  const delta = [assistant, tool("a", "fresh A"), tool("b", "fresh B"), { role: "user", content: "Latest correction: do not write." }];
  let normal = 0;
  const result = await resumed.run({ messages: [...history(), ...delta], tools: [] }, async request => {
    if (request.stage === "context-summary") return ok("Goal inspect P1; never write; verified P1:v2; next answer.");
    if (++normal === 1) return tooLong({ max_input_tokens: 4000 });
    assert.deepEqual(request.messages.slice(-delta.length), delta); return ok("done");
  });
  assert.equal(result.ok, true); assert.equal(resumed.state.checkpoints[0].boundary, 2);
  assert.equal(resumed.state.checkpoints[0].archiveBoundary, 2);
});

test("registered historical archive reads remain isolated by account and reject unregistered references", async t => {
  const { manager, options } = await fixture(t);
  const reference = await manager.store("exact original transcript");
  const archive = { reference, session: manager.archive.id };
  const next = new ContextRecovery(options);
  assert.equal((await next.readArchive(reference)).error, "ARCHIVE_NOT_IN_SESSION");
  next.importArchives([archive]); assert.equal((await next.readArchive(reference)).content, "exact original transcript");
  const other = new ContextRecovery({ ...options, account: "different-account" }); other.importArchives([archive]);
  assert.equal((await other.readArchive(reference)).error, "ARCHIVE_UNAVAILABLE");
});

test("large pending document preview is tried before any summary, without altering tool arguments", async t => {
  const { manager } = await fixture(t, { window: 4000 });
  const documentCall = call("doc"); documentCall.tool_calls[0].function.name = "read_document";
  const messages = [{ role: "system", content: "Protect files" }, { role: "user", content: "Review the document" }, documentCall,
    tool("doc", Array.from({ length: 2000 }, (_, i) => `Section ${i}: verified source identifier P1:${i}.\n`).join(""))];
  let summaries = 0, main = 0;
  const result = await manager.run({ messages, tools: [] }, async request => {
    if (request.stage === "context-summary") { summaries++; assert.ok(manager.tokens(request) <= manager.budget(request.maxTokens)); return ok("Verified source P1; findings derived from bounded sections; detail in archive."); }
    if (++main === 1) return tooLong({ max_input_tokens: 4000 });
    assert.deepEqual(request.messages.at(-2), documentCall);
    assert.ok(JSON.parse(request.messages.at(-1).content).contextArchive); return ok("done");
  });
  assert.equal(result.ok, true); assert.equal(summaries, 0); assert.equal(main, 2);
});

test("archive write failure stops honestly before discarding original content", async t => {
  const { manager } = await fixture(t, { window: 2000 });
  manager.archive.put = async () => { throw Object.assign(new Error("disk full"), { code: "ENOSPC" }); };
  const original = history(); manager.seed(original, 2);
  let calls = 0;
  const result = await manager.run({ messages: original }, async () => { calls++; return tooLong({ max_input_tokens: 2000 }); });
  assert.equal(calls, 1);
  assert.equal(result.recoveryStopReason, "archive_unavailable"); assert.match(result.partialReply, /could not be saved/);
  assert.deepEqual(result.contextMessages, original);
});

test("a thrown structured input-overflow error follows the same recovery path", async t => {
  const { manager } = await fixture(t); manager.seed(history(), 2);
  let main = 0;
  const result = await manager.run({ messages: history(), tools: [] }, async request => {
    if (request.stage === "context-summary") return ok("Goal inspect P1; never write; verified P1:v2; next answer.");
    if (++main === 1) throw Object.assign(new Error("maximum context length exceeded"), { code: "context_length_exceeded", status: 400 });
    return ok("done");
  });
  assert.equal(result.ok, true); assert.equal(main, 2);
});

test("history summaries can use archived originals beyond their previews", async t => {
  const { manager } = await fixture(t, { window: 4000 });
  const messages = [{ role: "system", content: "Protect files" }, { role: "user", content: "Inspect P1" }, call("old"),
    tool("old", "Earlier evidence. ".repeat(2000) + " EXACT_TAIL_IDENTIFIER"), { role: "user", content: "Current instruction: answer only" }];
  manager.seed(messages, 3); manager.recoveryStarted = manager.monotonic();
  const view = await manager.offload(messages, 2000);
  const sources = [];
  await manager.compact({ messages: view, tools: [], maxTokens: 256 }, async request => {
    sources.push(request.messages.at(-1).content); return ok("Goal inspect P1; exact identifier EXACT_TAIL_IDENTIFIER; next answer.");
  }, true);
  assert.ok(sources.length > 0); assert.match(sources.join("\n"), /EXACT_TAIL_IDENTIFIER/);
  assert.equal(messages[3].content.endsWith("EXACT_TAIL_IDENTIFIER"), true);
});
