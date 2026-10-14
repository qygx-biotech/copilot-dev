"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const jwt = require("jsonwebtoken");
process.env.JWT_SECRET = "chat-model-selection-fixture";
process.env.ADMIN_ACCOUNT = "chat-model-fixture";
process.env.REQUESTY_API_KEY = "fixture-private-key";
process.env.REQUESTY_MODEL = "configured/default-answer";
const backend = require("../index.js");
const token = jwt.sign({ account: process.env.ADMIN_ACCOUNT, role: "admin" }, process.env.JWT_SECRET);
const nemotron = "nvidia/nemotron-3-nano-omni-30b-a3b-reasoning";
const geminiFlex = "google/gemini-3.1-flash-lite:flex";
const requests = [], replies = [];
const finalMessage = { content: "A grounded answer." };
const agentFinalMessage = { content: JSON.stringify({ reply: "Readable analysis", project: { summary: "Analysis", organism: "Unknown", missingInformation: [], safetyLevel: "Review", safetyNotes: "Review", draftMemo: "Draft" } }) };
global.fetch = async (url, options) => {
  assert.match(String(url), /router\.requesty\.ai/);
  requests.push(JSON.parse(options.body));
  return new Response(JSON.stringify({ choices: [{ message: replies.shift() || finalMessage, finish_reason: "stop" }] }), { headers: { "Content-Type": "application/json" } });
};
function chat(extra = {}, transport) {
  return require("./helpers/agent-chat.js").handler({ httpMethod: "POST", path: "/chat", headers: { authorization: `Bearer ${token}` },
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
  for (const mode of ["side_chat", "agent_instruction"]) {
    for (const model of ["unapproved/expensive-model", {}, null, 123]) {
      requests.length = 0;
      let started = false;
      const result = await chat({ mode, model, stream: true }, { start: async () => { started = true; } });
      assert.equal(result.statusCode, 400);
      assert.equal(JSON.parse(result.body).error, "INVALID_CHAT_MODEL");
      assert.equal(started, false);
      assert.equal(requests.length, 0);
    }
  }
});
test("Agent Command uses its selected model for every answer/tool-loop turn", async () => {
  for (const model of [nemotron, geminiFlex]) {
    requests.length = 0;
    replies.push({ content: null, tool_calls: [{ id: "papers", type: "function", function: { name: "list_papers", arguments: "{}" } }] }, agentFinalMessage);
    const result = await chat({ mode: "agent_instruction", model });
    assert.equal(JSON.parse(result.body).fallback, false);
    assert.equal(requests.length, 2);
    assert.ok(requests.every(request => request.model === model));
    if (model === geminiFlex) {
      assert.ok(requests.every(request => !request.tools.some(tool => tool.type === "web_search")), "Legacy/missing scope keeps local tools under the sequential default");
      assert.ok(requests.every(request => !request.toolConfig));
      assert.ok(requests.every(request => request.tools.some(tool => tool.type === "function")));
      assert.ok(requests.every(request => !Object.hasOwn(request, "tool_choice")), "Hosted search stays available without forcing execution");
    }
    assert.equal(JSON.parse(result.body).model, model);
    assert.equal(process.env.REQUESTY_MODEL, "configured/default-answer");
  }
});
test("Agent Command Default and old clients retain the configured model independently of Side Chat", async () => {
  await chat({ model: nemotron });
  for (const extra of [{}, { model: "default" }]) {
    requests.length = 0;
    replies.push(agentFinalMessage);
    const result = await chat({ mode: "agent_instruction", ...extra });
    assert.equal(JSON.parse(result.body).fallback, false);
    assert.equal(requests.length, 1);
    assert.equal(requests[0].model, process.env.REQUESTY_MODEL);
  }
});
test("Side Chat supports the same Gemini option through every tool-loop turn", async () => {
  requests.length = 0;
  replies.push({ content: null, tool_calls: [{ id: "papers", type: "function", function: { name: "list_papers", arguments: "{}" } }] }, finalMessage);
  const response = await chat({ model: geminiFlex });
  assert.equal(response.statusCode, 200);
  assert.equal(JSON.parse(response.body).fallback, false);
  assert.equal(requests.length, 2);
  assert.ok(requests.every(request => request.model === geminiFlex));
});
test("the production renderer forwards each surface's own model selection and reports rejections by code", async () => {
  const { rendererSandbox } = require("./helpers/desktop-renderer.js");
  // A preload-shaped agent API that records each turn's start.
  const starts = []; let outcome = async () => ({ reply: "Answer" });
  const agent = { start: async payload => { starts.push(payload); return outcome(payload); }, respond: async () => ({}), cancel: async () => ({}), onEvent: () => () => {} };
  // The project service registers each turn's scope when it builds the turn's context.
  const service = { workspace: { workspace: { workspaceId: "model-project" } }, agentTurns: new Map([["model-turn", {}]]) };
  const sandbox = rendererSandbox({ token: "fixture.session.token", service, agent });
  const send = request => sandbox.sendWorkbenchRequest({ messages: [{ role: "user", content: "Summarize" }],
    localWorkspaceContext: { project: { workspaceId: "model-project" }, agentLoop: { version: 1 } }, callContext: { turnId: "model-turn", callRole: "answer", profile: "medium" }, ...request });
  await send({ mode: "side_chat", model: nemotron });
  await send({ mode: "agent_instruction", model: geminiFlex });
  await send({ mode: "agent_instruction" });
  assert.equal(starts[0].body.model, nemotron);
  assert.equal(starts[1].body.model, geminiFlex);
  assert.equal(Object.hasOwn(starts[2].body, "model"), false);
  const failures = [];
  sandbox.runtimeLog = { record: () => {}, begin: () => (status, details) => failures.push({ status, ...details }) };
  for (const error of ["INVALID_SEMANTIC_CONTEXT", "arbitrary-private-error"]) {
    outcome = async () => { throw Object.assign(new Error(error), { code: error, status: 400 }); };
    const code = error === "INVALID_SEMANTIC_CONTEXT" ? error : "BACKEND_HTTP_ERROR";
    await assert.rejects(send({ mode: "agent_instruction", model: geminiFlex }), { code, status: 400 });
    assert.equal(failures.at(-1).code, code);
    assert.equal(failures.at(-1).status, 400);
  }
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
