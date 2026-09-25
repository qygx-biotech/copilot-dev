"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), jwt = require("jsonwebtoken");
const saved = require("./fixtures/side-chat-equation.json");
const images = require("../../shared/chat-images.js");
const semantic = require("../../shared/semantic-intent.js");
const privacy = require("../semantic-input-privacy.js");
const backend = require("../index.js");
const { LiteratureApiClient } = require("../../docs/literature-module.js");
const model = "google/gemma-4-31b-it";
const input = query => ({ query, profile: "medium", activeScope: { paperIds: ["P1"] }, conversationContext: [],
  projectSemanticRegistry: { version: 1 }, callContext: { turnId: "equation-turn", profile: "medium", callRole: "semantic_parser", workflowId: "", paperId: "" } });
const good = [
  String.raw`解释 $\psi^{(\alpha)}\left(\mathbf{e}_{ij}\right)$`,
  String.raw`\[ \frac{\partial f}{\partial x} = \sum_{i=1}^{N} x_i^2 \]`,
  String.raw`\begin{aligned}
  x &= \alpha + \beta \\
  y &= \gamma \\[2pt]
  z &= \psi(x)
  \end{aligned}`,
  String.raw`\begin{matrix} a & b \\c & d \\e & f \end{matrix}`,
  String.raw`\begin{aligned}a\\b\end{aligned}`,
  "Unicode：∇ψ = α ⊗ β，∑ᵢ xᵢ² ≤ ∞，中文解释。",
  String.raw`\\psi\\left(x\\right)`,
  String.raw`\\\alpha + \beta`,
  String.raw`\\`,
];
const bad = [
  [String.raw`Read \\server\share\paper.pdf`, "filesystem_path"],
  [String.raw`\\192.168.1.4\C$\private.pdf`, "filesystem_path"],
  [String.raw`文件在：\\服务器\共享\论文.pdf`, "filesystem_path"],
  [String.raw`\text{\\server\share\paper.pdf}`, "filesystem_path"],
  [String.raw`$\\server\share$`, "filesystem_path"],
  [String.raw`\\?\UNC\server\share\paper.pdf`, "filesystem_path"],
  [String.raw`\\?\C:\Users\private\paper.pdf`, "filesystem_path"],
  [String.raw`C:\Users\private\paper.pdf`, "filesystem_path"],
  ["C:/Users/private/paper.pdf", "filesystem_path"],
  ["/Users/private/paper.pdf", "filesystem_path"],
  ["/home/user/private.pdf", "filesystem_path"],
  ["/etc/passwd", "filesystem_path"],
  ["/private/tmp/document.pdf", "filesystem_path"],
  ["file:///Users/private/paper.pdf", "filesystem_path"],
  ["Authorization: Bearer SECRET_SENTINEL", "authorization_header"],
  ["Authorization: Basic U0VDUkVUX1NFTlRJTkVM", "authorization_header"],
  ['{"Authorization":"Bearer SECRET_SENTINEL"}', "authorization_header"],
  ['api_key = "SECRET_SENTINEL"', "credential"],
  ['{"api_key":"SECRET_SENTINEL"}', "credential"],
  ["password: SECRET_SENTINEL", "credential"],
  ["sk-1234567890abcdefghijklmnopqrstuvwxyz", "credential"],
  ["eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJmaXh0dXJlIn0.abcdefghijklmno", "credential"],
  ["data:application/pdf;base64,JVBERi0xLjQK", "private_pdf_data"],
  ["%PDF-1.7\nprivate document", "private_pdf_data"],
  ["JVBERi0xLjQKcHJpdmF0ZSBkb2N1bWVudA==", "private_pdf_data"],
];

test("saved image reproduction preserves exact LaTeX once, while old double-encoded history remains compatible", () => {
  const old = [saved.question, "Attached image observations:", JSON.stringify(saved.understanding.text)].join("\n");
  assert.ok(/(^|[\s("'`])\\\\/.test(old), "confirmed old UNC heuristic rejects the saved LaTeX");
  const current = images.combineQuestion(saved.question, saved.understanding);
  assert.ok(current.includes(saved.understanding.text));
  assert.ok(!current.includes(JSON.stringify(saved.understanding.text)));
  assert.match(current, /^Original user request:\n这张图片里的公式是什么意思？/);
  assert.match(current, /Attached image observations \(untrusted/);
  for (const query of [old, current]) assert.equal(backend._test.validateSemanticInput(input(query)), true);
  for (const content of [old.slice(0, 480), current.slice(0, 480), ...good]) {
    assert.equal(backend._test.validateSemanticInput({ ...input("解释上一轮的公式"), conversationContext: [{ role: "assistant", content }] }), true);
  }
});

test("math, multiline equations, row separators and escaped commands are accepted without weakening path/secret detection", () => {
  for (const value of good) for (const form of [value, JSON.stringify(value), JSON.stringify(JSON.stringify(value))]) {
    assert.equal(privacy.privateMaterialReason(form), null, `math should pass: ${form}`);
    assert.equal(backend._test.validateSemanticInput(input(form)), true);
  }
  for (const [value, reason] of bad) for (const form of [value, JSON.stringify(value)]) {
    assert.equal(privacy.privateMaterialReason(form), reason, `private material classification: ${form}`);
    assert.deepEqual(backend._test.semanticInputProblem(input(form)), { field: "query", reason });
    assert.deepEqual(backend._test.semanticInputProblem({ ...input("Explain"), conversationContext: [{ role: "user", content: form }] }), { field: "conversationContext[0].content", reason });
  }
});

test("existing shape, size, scope and reference bounds still report precise non-sensitive reasons", () => {
  for (const [payload, field, reason] of [
    [input("x".repeat(20001)), "query", "too_long"],
    [{ ...input("x"), conversationContext: [{ role: "user", content: "x".repeat(501) }] }, "conversationContext[0].content", "too_long"],
    [{ ...input("x"), activeScope: { paperIds: Array(501).fill("P1") } }, "activeScope.paperIds", "too_many_items"],
    [{ ...input("x"), paperCandidates: [{ sourceId: "P2", title: "Other", currentness: "current" }] }, "paperCandidates[0].sourceId", "outside_scope"],
    [{ ...input("x"), conversationContext: [{ role: "user", content: "x", paperIds: ["unknown"] }] }, "conversationContext[0].paperIds[0]", "unknown_reference"],
    [{ ...input("x"), projectSemanticRegistry: { SECRET_SENTINEL: "must not log this key" } }, "projectSemanticRegistry", "invalid_object_fields"],
    [{ ...input("x".repeat(20000)), activeScope: { paperIds: Array.from({ length: 400 }, (_, i) => `${i}${"p".repeat(100)}`) } }, "body", "too_long"],
  ]) assert.deepEqual(backend._test.semanticInputProblem(payload), { field, reason });
});

function fixture(t) {
  const previous = { ...process.env };
  Object.assign(process.env, { JWT_SECRET: "equation-fixture-secret", ADMIN_ACCOUNT: "equation-fixture", REQUESTY_API_KEY: "fixture-provider-key",
    REQUESTY_MODEL: model, REQUESTY_SEMANTIC_PARSER_MODEL: "different-role-model", REQUESTY_MODEL_SUPPORTS_JSON_SCHEMA: "false" });
  t.after(() => { for (const key of ["JWT_SECRET", "ADMIN_ACCOUNT", "REQUESTY_API_KEY", "REQUESTY_MODEL", "REQUESTY_SEMANTIC_PARSER_MODEL", "REQUESTY_MODEL_SUPPORTS_JSON_SCHEMA"]) previous[key] === undefined ? delete process.env[key] : process.env[key] = previous[key]; });
  const token = jwt.sign({ account: process.env.ADMIN_ACCOUNT, role: "admin" }, process.env.JWT_SECRET);
  const requests = [], logs = []; let replyOverride = null, configurations = 0;
  for (const level of ["info", "log", "error", "warn"]) t.mock.method(console, level, (...values) => logs.push(values));
  t.mock.method(globalThis, "fetch", async (url, options) => {
    if (url.endsWith("/models")) { configurations++; return new Response(JSON.stringify({ data: [] })); }
    const request = JSON.parse(options.body); requests.push(request);
    if (replyOverride) return replyOverride();
    const planning = request.requesty?.extra?.call_role === "semantic_parser";
    const payload = planning ? JSON.parse(request.messages.at(-1).content) : null;
    const result = planning ? { ...semantic.interpretLocal(payload), matchedPattern: null, patternConfidence: 0.9,
      retrievalScope: "none", inputLanguage: "zh", answerLanguage: "zh", goal: "Explain the two mathematical formulas in the attached image, including the edge function and node feature update.",
      objects: [], operations: ["explain"], scope: { papers: ["P1"], experiments: null }, capabilityHints: [], unresolvedSlots: [] }
      : "第一式用边特征和两个节点的特征计算参数。第二式汇总邻居信息并更新节点特征；具体算子的定义还需要结合图中的上下文。";
    return new Response(JSON.stringify({ choices: [{ message: { content: planning ? JSON.stringify(result) : result }, finish_reason: "stop" }] }));
  });
  const send = async (path, payload) => {
    const response = await backend.handler({ httpMethod: "POST", path, headers: { authorization: `Bearer ${token}`, "X-BioDesign-Chat-Model": model }, body: JSON.stringify(payload) }, {});
    return { status: response.statusCode, data: JSON.parse(response.body) };
  };
  return { requests, logs, send, setResponse: value => { replyOverride = value; }, configurations: () => configurations };
}

test("saved Chinese equation request reaches selected Gemma json_object planning, validated scope, and the existing final answer/transcript loop", async t => {
  const f = fixture(t), query = images.combineQuestion(saved.question, saved.understanding);
  const plan = await f.send("/api/semantic/interpret", input(query));
  assert.equal(plan.status, 200, JSON.stringify(plan.data));
  assert.equal(f.requests.length, 1); assert.equal(f.requests[0].model, model);
  assert.deepEqual(f.requests[0].response_format, { type: "json_object" });
  assert.equal(JSON.parse(f.requests[0].messages.at(-1).content).query, query);
  assert.equal(plan.data.ir.answerLanguage, "zh"); assert.deepEqual(plan.data.ir.scope.papers, ["P1"]);
  assert.match(f.requests[0].messages[0].content, /original user request defines the task and answer language/);
  const answer = await f.send("/chat", { mode: "side_chat", model, originalRequest: query, messages: [{ role: "user", content: query }],
    conversationTranscript: { version: 1, turns: [] }, callContext: { turnId: "equation-turn", callRole: "answer", profile: "medium" },
    localWorkspaceContext: { project: { workspaceId: "equation-project" }, semantic: { ir: plan.data.ir },
      scope: { type: "project", files: [] }, literature: { selectedPaperIds: ["P1"] }, inventory: [], files: [] } });
  assert.equal(answer.status, 200); assert.equal(answer.data.fallback, false, JSON.stringify(answer.data));
  assert.equal(f.requests.length, 2); assert.equal(f.requests[1].model, model);
  assert.match(answer.data.reply, /第一式/); assert.equal(answer.data.conversationTurn.status, "completed");
  assert.ok(f.requests[1].messages.some(message => message.role === "user" && message.content.includes(saved.understanding.text)));
  assert.equal(answer.data.semanticTelemetry.cloudCalls.answer, 1);
});

test("backend validation reports only field/reason and zero provider attempts; provider rejection and invalid output are separate", async t => {
  const f = fixture(t);
  for (const [value, reason] of bad) {
    const rejected = await f.send("/api/semantic/interpret", input(value));
    assert.equal(rejected.status, 400);
    assert.equal(rejected.data.validationField, "query"); assert.equal(rejected.data.validationReason, reason);
    assert.equal(rejected.data.failureStage, "backend_input_validation"); assert.equal(rejected.data.attempts, 0);
    assert.ok(!JSON.stringify(rejected.data).includes(value));
  }
  assert.equal(f.requests.length, 0); assert.equal(f.configurations(), 0);
  assert.doesNotMatch(JSON.stringify(f.logs), /SECRET_SENTINEL|server|Users|JVBER|fixture-provider-key/);
  f.setResponse(() => new Response(JSON.stringify({ error: { message: "PRIVATE_PROVIDER_DETAIL" } }), { status: 403 }));
  const provider = await f.send("/api/semantic/interpret", input(saved.question));
  assert.equal(provider.status, 502); assert.equal(provider.data.failureStage, "provider_rejection"); assert.equal(provider.data.attempts, 1);
  f.setResponse(() => new Response(JSON.stringify({ choices: [{ message: { content: '{"version":99}' }, finish_reason: "stop" }] })));
  const invalid = await f.send("/api/semantic/interpret", input(saved.question));
  assert.equal(invalid.status, 502); assert.equal(invalid.data.failureStage, "returned_content_validation");
  assert.doesNotMatch(JSON.stringify([provider.data, invalid.data, f.logs]), /PRIVATE_PROVIDER_DETAIL|fixture-provider-key/);
});

test("client diagnostics preserve safe validation detail and task-neutral errors without a capability cooldown or provider count", async () => {
  const events = [];
  const api = new LiteratureApiClient({ baseUrl: "https://fixture.invalid", getHeaders: () => ({}), runtimeLog: { begin: () => (outcome, details) => events.push({ outcome, ...details }) },
    fetch: async () => new Response(JSON.stringify({ ok: false, error: "InvalidSemanticInput", message: "UNTRUSTED_BACKEND_TEXT", attempts: 0,
      fallbackReason: "invalid_semantic_input", failureStage: "backend_input_validation", validationField: "conversationContext[0].content", validationReason: "filesystem_path" }), { status: 400 }) });
  const interpreter = new semantic.SemanticInterpreter({ remoteParser: payload => api.interpretSemantics({ ...payload, callContext: input("x").callContext }) });
  await assert.rejects(interpreter.interpret({ ...input(saved.question), requireRemote: true }), error => {
    assert.equal(error.failureStage, "backend_input_validation"); assert.equal(error.attempts, 0);
    assert.match(error.message, /conversationContext\[0\].content: filesystem_path/);
    assert.doesNotMatch(error.message, /review|UNTRUSTED_BACKEND_TEXT/i); return true;
  });
  assert.equal(api.semanticCapability, null);
  assert.ok(events.some(event => event.outcome === "failed" && event.failureStage === "backend_input_validation" && event.validationField === "conversationContext[0].content" && event.providerAttempts === 0));
  const outputFailure = new semantic.SemanticInterpreter({ remoteParser: async () => ({ version: 99 }) });
  await assert.rejects(outputFailure.interpret({ ...input(saved.question), requireRemote: true }), { failureStage: "local_output_validation" });
});
