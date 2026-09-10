"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const jwt = require("jsonwebtoken");
const fs = require("node:fs");
const vm = require("node:vm");
process.env.JWT_SECRET = "chat-model-selection-fixture";
process.env.ADMIN_ACCOUNT = "chat-model-fixture";
process.env.REQUESTY_API_KEY = "fixture-private-key";
process.env.REQUESTY_MODEL = "configured/default-answer";
const backend = require("../index.js");
const token = jwt.sign({ account: process.env.ADMIN_ACCOUNT, role: "admin" }, process.env.JWT_SECRET);
const nemotron = "nvidia/nemotron-3-nano-omni-30b-a3b-reasoning";
const requests = [], replies = [];
const finalMessage = { content: "A grounded answer." };
global.fetch = async (url, options) => {
  assert.match(String(url), /router\.requesty\.ai/);
  requests.push(JSON.parse(options.body));
  return new Response(JSON.stringify({ choices: [{ message: replies.shift() || finalMessage, finish_reason: "stop" }] }), { headers: { "Content-Type": "application/json" } });
};
function chat(extra = {}, transport) {
  return backend.handler({ httpMethod: "POST", path: "/chat", headers: { authorization: `Bearer ${token}` },
    body: JSON.stringify({ mode: "side_chat", messages: [{ role: "user", content: "Summarize the papers" }], ...extra }) }, {}, transport);
}
test("old clients and Default model retain the configured FC model", async () => {
  for (const extra of [{}, { model: "default" }, { model: process.env.REQUESTY_MODEL }]) {
    requests.length = 0;
    const result = await chat(extra);
    assert.equal(result.statusCode, 200);
    assert.equal(JSON.parse(result.body).fallback, false);
    assert.equal(requests.length, 1);
    assert.equal(requests[0].model, process.env.REQUESTY_MODEL);
  }
});
test("Nemotron is used for every answer/tool-loop turn without changing environment configuration", async () => {
  requests.length = 0;
  replies.push({ content: null, tool_calls: [{ id: "papers", type: "function", function: { name: "list_papers", arguments: "{}" } }] }, finalMessage);
  const result = await chat({ model: nemotron });
  assert.equal(JSON.parse(result.body).fallback, false);
  assert.equal(requests.length, 2);
  assert.ok(requests.every(request => request.model === nemotron));
  assert.equal(process.env.REQUESTY_MODEL, "configured/default-answer");
});
test("unsupported model requests fail before provider execution or streaming starts", async () => {
  for (const model of ["unapproved/expensive-model", {}, null, 123]) {
    requests.length = 0;
    let started = false;
    const result = await chat({ model, stream: true }, { start: async () => { started = true; } });
    assert.equal(result.statusCode, 400);
    assert.equal(JSON.parse(result.body).error, "INVALID_CHAT_MODEL");
    assert.equal(started, false);
    assert.equal(requests.length, 0);
  }
});
test("Side Chat model selection does not override Agent Command", async () => {
  requests.length = 0;
  replies.push({ content: JSON.stringify({ reply: "Readable analysis", project: { summary: "Analysis", organism: "Unknown", missingInformation: [], safetyLevel: "Review", safetyNotes: "Review", draftMemo: "Draft" } }) });
  const result = await chat({ mode: "agent_instruction", model: nemotron });
  assert.equal(JSON.parse(result.body).fallback, false);
  assert.ok(requests.length > 0);
  assert.ok(requests.every(request => request.model === process.env.REQUESTY_MODEL));
});
test("the production browser request forwards model selection only for Side Chat", async () => {
  const app = fs.readFileSync(require.resolve("../../docs/app.js"), "utf8");
  const source = app.match(/^async function sendWorkbenchRequest\([\s\S]*?^}$/m)[0];
  const bodies = [];
  const sandbox = vm.createContext({
    workspaceAbortController: null, experimentModuleCards: [], referenceDocuments: [], activeSideChatDocumentKeys: [],
    MAX_BROWSER_REFERENCE_FILES: 1, TOTAL_REFERENCE_TEXT_LIMIT: 100, runtimeLog: null, literatureModule: null,
    buildExperimentModulesForRequest: () => ({}), buildFlattenedExperimentDocumentsForRequest: () => [],
    collectExperimentNotesForRequest: () => [], collectSelectedStoredDocumentKeys: () => [], collectStoredDocumentsForRequest: () => [],
    buildDocumentsForRequest: () => [], getProjectContext: () => "", backendUrl: path => path, getAuthHeaders: headers => headers,
    requireLoginForUnauthorized: () => {}, t: key => key,
    fetch: async (_url, options) => { bodies.push(JSON.parse(options.body)); return { ok: true, status: 200 }; },
    window: { BioDesignEventStream: { readWorkbenchResponse: async () => ({ reply: "Answer" }) } },
  });
  vm.runInContext(source, sandbox);
  await sandbox.sendWorkbenchRequest({ mode: "side_chat", model: nemotron, messages: [] });
  await sandbox.sendWorkbenchRequest({ mode: "agent_instruction", model: nemotron, messages: [] });
  assert.equal(bodies[0].model, nemotron);
  assert.equal(Object.hasOwn(bodies[1], "model"), false);
});

test("authenticated session responses expose the configured answer model for its UI label", async () => {
  process.env.ADMIN_PASSWORD_HASH = require("bcryptjs").hashSync("fixture-password", 4);
  const login = await backend.handler({ httpMethod: "POST", path: "/api/login", body: JSON.stringify({ account: process.env.ADMIN_ACCOUNT, password: "fixture-password" }) }, {});
  assert.equal(login.statusCode, 200);
  assert.equal(JSON.parse(login.body).chatModel, process.env.REQUESTY_MODEL);
  const session = await backend.handler({ httpMethod: "GET", path: "/api/me", headers: { authorization: `Bearer ${token}` } }, {});
  assert.equal(session.statusCode, 200);
  assert.equal(JSON.parse(session.body).chatModel, process.env.REQUESTY_MODEL);
  const denied = await backend.handler({ httpMethod: "GET", path: "/api/me" }, {});
  assert.equal(denied.statusCode, 401);
  assert.equal(JSON.parse(denied.body).chatModel, undefined);
});
