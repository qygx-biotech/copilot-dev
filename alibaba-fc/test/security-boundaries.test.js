"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { format } = require("node:util");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const OSS = require("ali-oss");
const { handler, _test } = require("../index.js");
const { createSideChatKnowledgeBase, executeSideChatTool } = require("../side-chat-agent.js");

// Every credential and document below is synthetic. Never load deployment env files.
const privateText = "SYNTHETIC_PRIVATE_DOCUMENT_SENTINEL";
const sessionSecret = "synthetic-session-secret";
const users = [1, 2].map(n => ({ id: `beta${n}`, account: `researcher${n}`,
  passwordHash: bcrypt.hashSync(`password${n}`, 4), requestyKeyEnv: `REQUESTY_KEY_BETA${n}`, active: true }));
const env = { ADMIN_ACCOUNT: "fixture-admin", ADMIN_PASSWORD_HASH: bcrypt.hashSync("admin-password", 4),
  JWT_SECRET: "synthetic-signing-secret", BETA_USERS_JSON: JSON.stringify(users),
  REQUESTY_API_KEY: "synthetic-admin-provider-key", REQUESTY_KEY_BETA1: "synthetic-beta-one-key", REQUESTY_KEY_BETA2: "synthetic-beta-two-key",
  REQUESTY_MODEL: "fixture/model", REQUESTY_MODEL_SUPPORTS_JSON_SCHEMA: "true",
  REQUESTY_SEMANTIC_PARSER_MODEL: "fixture/model", REQUESTY_SEARCH_PLANNER_MODEL: "fixture/model",
  REQUESTY_RERANK_MODEL: "fixture/model", REQUESTY_SCHEMA_MAPPER_MODEL: "fixture/model",
  OSS_BUCKET: "security-fixture", OSS_REGION: "oss-cn-beijing", OSS_INTERNAL_ENDPOINT: "https://oss-cn-beijing-internal.aliyuncs.com",
  OSS_PUBLIC_ENDPOINT: "https://oss-cn-beijing.aliyuncs.com" };
const savedEnv = Object.fromEntries(Object.keys(env).map(key => [key, process.env[key]]));
const context = { requestId: "security-fixture", credentials: {
  accessKeyId: "synthetic-sts-id", accessKeySecret: "synthetic-sts-secret", securityToken: "synthetic-sts-token" } };
const secrets = [privateText, sessionSecret, env.JWT_SECRET, env.ADMIN_PASSWORD_HASH,
  ...users.map(user => user.passwordHash), env.REQUESTY_API_KEY, env.REQUESTY_KEY_BETA1, env.REQUESTY_KEY_BETA2,
  ...Object.values(context.credentials)];
const originalFetch = global.fetch;
let logs, providerRequests;
const completion = content => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(content) }, finish_reason: "stop" }] }));
const finalAnswer = { reply: "Fixture answer.", project: { summary: "Fixture", organism: "Unknown", missingInformation: [], safetyLevel: "Review", safetyNotes: "Review", draftMemo: "Fixture" } };
test.beforeEach(t => {
  Object.assign(process.env, env); logs = []; providerRequests = [];
  for (const method of ["log", "info", "warn", "error"]) t.mock.method(console, method, (...args) => logs.push(format(...args)));
  // Legacy review checks its sidecar before reading PDF metadata; keep every
  // storage operation local to the test, including this cache miss.
  t.mock.method(OSS.prototype, "get", async () => { throw Object.assign(new Error("No fixture object"), { code: "NoSuchKey", status: 404 }); });
  global.fetch = async (_url, options) => { providerRequests.push(options); return completion(finalAnswer); };
});
test.after(() => {
  for (const [key, value] of Object.entries(savedEnv)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  global.fetch = originalFetch;
});
const token = (n = 0) => jwt.sign(n < 0 ? { account: env.ADMIN_ACCOUNT, role: "admin" }
  : { id: users[n].id, sub: users[n].id, account: users[n].account, role: "beta" }, env.JWT_SECRET, { algorithm: "HS256", expiresIn: "1h" });
async function invoke(path, body, authorization = token(), method = "POST", headers = {}, transport) {
  const response = await handler({ httpMethod: method, path, headers: { ...(authorization ? { Authorization: `Bearer ${authorization}` } : {}), ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) }, context, transport);
  return { status: response.statusCode, body: JSON.parse(response.body || "{}") };
}
function assertClean(value) {
  const serialized = typeof value === "string" ? value : JSON.stringify(value);
  assert.equal(secrets.some(secret => serialized.includes(secret)), false, "Sensitive fixture value was disclosed");
}
const chunk = { filename: "fixture.pdf", text: privateText, chunkIndex: 0, totalChunks: 1 };
const chat = { mode: "side_chat", messages: [{ role: "user", content: "Explain the supplied evidence." }] };
const protectedPaths = ["/api/me", "/api/knowledge/config", "/api/literature/config", "/api/knowledge/plan-search", "/api/knowledge/rerank",
  "/api/literature/summarize-chunk", "/api/corpus/map-paper", "/api/literature/analyze-pdf-native", "/api/literature/create-paper-card-from-text",
  "/api/context/route", "/api/semantic/interpret", "/api/semantic/map-schema", "/api/literature/synthesize", "/api/chat/understand-images",
  "/chat", "/api/test-oss", "/api/documents", "/api/documents/upload-url", "/api/documents/delete", "/api/documents/review"];

test("debug is unavailable and cannot echo credentials, headers or document previews", async t => {
  const results = [];
  for (const authorization of [null, "invalid-token", token(), token(-1)]) {
    for (const method of ["GET", "POST"]) results.push(await invoke("/debug", { text: privateText, password: sessionSecret }, authorization, method,
      { Cookie: `session=${sessionSecret}`, "X-Api-Key": env.REQUESTY_KEY_BETA1 }));
  }
  t.diagnostic(`Debug requests returning echoed sensitive fixtures: ${results.filter(result => secrets.some(secret => JSON.stringify(result.body).includes(secret))).length}/${results.length}`);
  assert.ok(results.every(result => result.status === 404));
  assertClean(results); assertClean(logs);
  assert.equal(providerRequests.length, 0);
  assert.equal((await invoke("/health", undefined, null, "GET")).status, 200);
  assert.equal((await invoke("/api/logout", undefined, null)).status, 200);
  assert.equal((await invoke("/api/login", undefined, null, "OPTIONS")).status, 204);
});

test("every protected path rejects absent or forged identity before provider, OSS or streaming access", async t => {
  let storageCalls = 0, streamStarts = 0;
  for (const name of ["get", "put", "delete", "getObjectMeta", "listV2", "signatureUrl"]) t.mock.method(OSS.prototype, name, () => { storageCalls++; throw new Error("Unexpected storage access"); });
  for (const path of protectedPaths) for (const authorization of [null, token() + "tampered"]) {
    const result = await invoke(path, { ...chat, stream: true, role: "admin", account: env.ADMIN_ACCOUNT, user: { role: "admin" } }, authorization,
      ["/api/me", "/api/knowledge/config", "/api/literature/config", "/api/documents"].includes(path) ? "GET" : "POST",
      { "X-User-Id": "admin", "X-BioDesign-Chat-Model": "forged/model" }, { start: async () => { streamStarts++; } });
    assert.equal(result.status, 401, path); assertClean(result);
  }
  assert.equal(storageCalls, 0); assert.equal(providerRequests.length, 0); assert.equal(streamStarts, 0);
});

test("cross-account and traversal object keys remain denied despite forged owner and role fields", async t => {
  let storageCalls = 0;
  for (const name of ["get", "put", "delete", "getObjectMeta", "listV2"]) t.mock.method(OSS.prototype, name, async () => { storageCalls++; throw new Error("Unexpected foreign object access"); });
  const foreign = _test.buildOwnedPdfObjectKey(users[1].account, "private.pdf");
  const own = _test.buildOwnedPdfObjectKey(users[0].account, "own.pdf");
  for (const objectKey of [foreign, `${own}/../private.pdf`, own.replace("own.pdf", "%2e%2e%2fprivate.pdf")]) {
    for (const path of ["/api/documents/review", "/api/documents/delete"]) {
      const result = await invoke(path, { objectKey, account: users[1].account, id: users[1].id, role: "admin", user: { account: users[1].account } });
      assert.equal(result.status, 403); assert.equal(result.body.error, "ObjectAccessDenied");
    }
  }
  const result = await invoke("/chat", { ...chat, storedDocuments: [{ objectKey: foreign }], selectedDocumentKeys: [foreign], account: users[1].account });
  assert.equal(result.body.fallback, false); assert.deepEqual(result.body.documentScope.objectKeys, []);
  assert.equal(storageCalls, 0);
  assert.equal(providerRequests.length, 1);
  assert.equal(providerRequests[0].body.includes(foreign), false);
});

test("forged models cannot select keys; valid beta and admin answer modes retain their server-authorized behavior", async () => {
  for (const model of ["REQUESTY_KEY_BETA2", "forged/model", { role: "admin" }]) {
    assert.equal((await invoke("/chat", { ...chat, model })).status, 400);
    assert.equal((await invoke("/api/literature/config", undefined, token(), "GET", { "X-BioDesign-Chat-Model": String(model) })).status, 400);
  }
  assert.equal(providerRequests.length, 0);
  for (const [identity, key] of [[token(), env.REQUESTY_KEY_BETA1], [token(1), env.REQUESTY_KEY_BETA2], [token(-1), env.REQUESTY_API_KEY]]) {
    for (const mode of ["side_chat", "agent_instruction"]) {
      const result = await invoke("/chat", { ...chat, mode, model: mode === "side_chat" ? "default" : "ignored/forged-model",
        role: "admin", account: users[1].account, requestyKeyEnv: "REQUESTY_KEY_BETA2", apiKey: "forged-key", env: { REQUESTY_API_KEY: "forged-key" } }, identity);
      assert.equal(result.body.fallback, false); assert.equal(result.body.reply, finalAnswer.reply);
      assert.ok(providerRequests.at(-1).headers.Authorization === `Bearer ${key}`, "Only the verified identity selects the key");
      assert.equal(JSON.parse(providerRequests.at(-1).body).model, env.REQUESTY_MODEL);
      assertClean(result);
    }
  }
});

test("provider HTTP errors cannot echo documents or credentials into responses and logs", async () => {
  global.fetch = async (_url, options) => { providerRequests.push(options); return new Response(JSON.stringify({ error: {
    message: `${privateText} Authorization: Bearer ${env.REQUESTY_KEY_BETA1}; session=${sessionSecret}` } }), { status: 400 }); };
  for (const [path, body] of [["/api/literature/summarize-chunk", chunk], ["/chat", chat]]) {
    const result = await invoke(path, body);
    assertClean(result); assertClean(logs);
  }
  assert.ok(providerRequests[0].body.includes(privateText), "Full requested evidence still goes to the provider");
});

test("provider transport exceptions cannot echo secrets in retry logs or final errors", async () => {
  let attempts = 0;
  global.fetch = async () => { attempts++; throw Object.assign(new Error(`${privateText} ${sessionSecret}`), { code: env.REQUESTY_KEY_BETA1 }); };
  const result = await invoke("/api/literature/summarize-chunk", chunk);
  assert.equal(attempts, 2); assert.equal(result.body.error, "LlmRequestFailed");
  assertClean(result); assertClean(logs);
});

test("redacted provider errors preserve Retry-After, learned quotas, hard quotas and verified context-size flags", async () => {
  let calls = 0;
  global.fetch = async () => { calls++; return new Response(JSON.stringify({ error: {
    message: `Quota exceeded for metric: generativelanguage.googleapis.com/input_token_count, limit: 16000. Please retry in 22s. ${privateText}`
  } }), { status: 429, headers: { "Retry-After": "31" } }); };
  const limited = await invoke("/api/literature/summarize-chunk", chunk);
  assert.equal(limited.status, 429); assert.equal(limited.body.retryAfterMs, 31000);
  assert.equal(limited.body.inputTokenLimit, 16000); assert.equal(limited.body.verifiedInputTokenRateLimit, true);
  assert.equal(limited.body.rateLimitRetryable, true); assert.equal(limited.body.attempts, 1);
  assert.equal(calls, 1); assertClean(limited); assertClean(logs);
  global.fetch = async () => new Response(JSON.stringify({ error: { type: "insufficient_quota", message: privateText } }), { status: 429 });
  const hard = await invoke("/api/literature/summarize-chunk", chunk);
  assert.equal(hard.body.rateLimitRetryable, false); assert.equal(hard.body.verifiedInputTokenRateLimit, false);
  assertClean(hard);
  global.fetch = async () => new Response(JSON.stringify({ error: { code: "context_length_exceeded", message: privateText } }), { status: 400 });
  const oversized = await invoke("/api/literature/create-paper-card-from-text", { paperId: "paper-a", contentHash: "sha256:fixture",
    text: `# Page 1\n${privateText}`, pageCount: 1, chunkCount: 1 });
  assert.equal(oversized.status, 413); assert.equal(oversized.body.verifiedContextLengthError, true);
  assert.equal(oversized.body.fallbackReason, "combined-text-context-length"); assertClean(oversized); assertClean(logs);
});

test("schema capability fallback keeps its classification without exposing provider error details", async () => {
  let calls = 0;
  global.fetch = async () => { calls++; return new Response(JSON.stringify({ error: {
    message: `Invalid response_format: json_schema is unsupported. ${privateText}`
  } }), { status: 400 }); };
  const result = await invoke("/api/semantic/interpret", { query: "Find EctD evidence", profile: "medium",
    activeScope: {}, conversationContext: [], projectSemanticRegistry: { version: 1 } });
  assert.equal(result.body.fallbackReason, "provider_schema_incompatible"); assert.equal(result.body.capabilityUnavailable, true);
  assert.equal(calls, 1); assertClean(result); assertClean(logs);
});

test("context compaction still retries once and successful answers retain the requested scientific text", async () => {
  let calls = 0;
  global.fetch = async () => ++calls === 1
    ? new Response(JSON.stringify({ error: { message: `context_length_exceeded ${privateText}` } }), { status: 400 })
    : completion({ reply: privateText });
  const result = await invoke("/chat", chat);
  assert.equal(calls, 2); assert.equal(result.body.fallback, false);
  assert.equal(result.body.reply, privateText, "Error redaction must not alter scientific answer content");
  assertClean(logs);
});

test("OSS errors redact credentials from code and request ID and do not expose document-bearing messages", async t => {
  t.mock.method(OSS.prototype, "getObjectMeta", async () => { throw Object.assign(new Error(privateText), {
    code: context.credentials.accessKeySecret, requestId: context.credentials.securityToken, status: 403 }); });
  const result = await invoke("/api/documents/review", { objectKey: _test.buildOwnedPdfObjectKey(users[0].account, "fixture.pdf") });
  assert.equal(result.status, 502); assertClean(result); assertClean(logs);
});

test("unexpected login exceptions do not dump credential-bearing exception objects", async t => {
  t.mock.method(bcrypt, "compare", async () => { throw Object.assign(new Error(privateText), { request: { headers: { Authorization: sessionSecret }, passwordHash: env.ADMIN_PASSWORD_HASH } }); });
  const result = await invoke("/api/login", { account: users[0].account, password: "password1" }, null);
  assert.equal(result.status, 500); assert.deepEqual(result.body, { error: "Internal server error" });
  assertClean(logs);
});

test("schema validation rejects provider-controlled keys without logging their contents", async () => {
  global.fetch = async () => completion({ [privateText]: "unexpected field" });
  const result = await invoke("/api/literature/create-paper-card-from-text", { paperId: "paper-a", filename: "fixture.pdf", contentHash: "sha256:fixture",
    text: `# Page 1\n${privateText}`, pageCount: 1, chunkCount: 1 });
  assert.equal(result.body.error, "InvalidLlmResponse"); assert.equal(result.body.fallbackReason, "combined-text-schema-or-provenance-invalid");
  assertClean(result); assertClean(logs);
});

test("Side Chat permission checks remain authoritative and resolution logs cannot echo model-supplied text as IDs", () => {
  const knowledge = createSideChatKnowledgeBase({});
  const call = (name, args) => ({ id: sessionSecret, type: "function", function: { name, arguments: JSON.stringify(args) } });
  const denied = JSON.parse(executeSideChatTool(call("update_recommendation", { role: "admin", surface: "agent_command" }), knowledge, "side_chat"));
  assert.equal(denied.allowed, false); assert.equal(denied.required_surface, "agent_command");
  const allowed = JSON.parse(executeSideChatTool(call("update_recommendation", {}), knowledge, "agent_command"));
  assert.equal(allowed.allowed, true); assert.equal(allowed.disposition, "host_managed");
  const resolution = JSON.parse(executeSideChatTool(call("read_paper_evidence", { paper_id: privateText }), knowledge));
  assert.ok(resolution.error);
  assertClean(logs);
});
