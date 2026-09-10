"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const jwt = require("jsonwebtoken");
const bcrypt = require("bcryptjs");
const { handler } = require("../index.js");
const { LiteratureApiClient } = require("../../docs/literature-module.js");
const wiki = require("../../shared/literature-wiki.js");
const model = "nvidia/nemotron-3-nano-omni-30b-a3b-reasoning";
const signature = require("node:crypto").createHash("sha256").update(model).digest("hex");
const users = [1, 2].map(n => ({ id: `wiki-beta-${n}`, account: `wiki-account-${n}`, active: true, requestyKeyEnv: `REQUESTY_KEY_WIKI_TEST_${n}`, passwordHash: bcrypt.hashSync("synthetic-password", 4) }));
const env = { JWT_SECRET: "synthetic-wiki-secret", ADMIN_ACCOUNT: "wiki-admin", ADMIN_PASSWORD_HASH: bcrypt.hashSync("synthetic-admin-password", 4),
  BETA_USERS_JSON: JSON.stringify(users), REQUESTY_API_KEY: "synthetic-admin-key", REQUESTY_MODEL: "google/gemma-4-31b-it",
  REQUESTY_KEY_WIKI_TEST_1: "synthetic-key-one", REQUESTY_KEY_WIKI_TEST_2: "synthetic-key-two" };
const original = Object.fromEntries(Object.keys(env).map(key => [key, process.env[key]]));
const fetch = global.fetch;
test.before(() => Object.assign(process.env, env));
test.after(() => { for (const [key, value] of Object.entries(original)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } global.fetch = fetch; });
function input() {
  return { pageId: "stability", label: "Stability", kind: "concept", configuration: wiki.configuration(signature), existingPage: null, analysisRequest: "", relatedPages: [],
    papers: ["alpha", "beta"].map(paperId => ({ paperId, contentHash: `hash-${paperId}`, card: { title: "Synthetic fixture" },
      evidence: [{ reference: `${paperId}:p1:chunk`, text: `${paperId} reported different stability at the stated temperature.` }] })) };
}
function page(input) {
  const findings = input.papers.map(paper => ({ kind: "reported", text: paper.evidence[0].text, conditions: "", evidence: [{ reference: paper.evidence[0].reference, quote: paper.evidence[0].text }] }));
  return { schemaVersion: 1, pageId: input.pageId, explanation: findings[0], findings, disagreements: [], openQuestions: [], relatedPageIds: [] };
}
const token = user => jwt.sign(user < 0 ? { account: env.ADMIN_ACCOUNT, role: "admin" } : { ...users[user], sub: users[user].id, role: "beta" }, env.JWT_SECRET, { algorithm: "HS256", expiresIn: "1h" });
async function invoke(body, user = 0, selectedModel = model, transport) {
  const result = await handler({ httpMethod: "POST", path: "/api/knowledge/update-wiki", headers: {
    ...(user === null ? {} : { Authorization: `Bearer ${token(user)}` }), "X-BioDesign-Chat-Model": selectedModel,
  }, body: JSON.stringify(body) }, {}, transport);
  return { status: result.statusCode, body: JSON.parse(result.body) };
}
test("wiki endpoint authenticates before calls, isolates beta keys, and uses only server-authorized models", async () => {
  const calls = [];
  global.fetch = async (_url, options) => { calls.push(options); return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(page(input())) } }] })); };
  assert.equal((await invoke({ input: input() }, null)).status, 401);
  assert.equal((await invoke({ input: input() }, 0, "forged/model")).status, 400);
  assert.equal(calls.length, 0);
  for (const user of [0, 1, -1]) {
    const result = await invoke({ input: input(), role: "admin", accountId: users[1].id, model: "forged/model", requestyKeyEnv: "REQUESTY_API_KEY" }, user);
    assert.equal(result.status, 200);
    const request = calls.at(-1);
    assert.equal(request.headers.Authorization, `Bearer ${user < 0 ? env.REQUESTY_API_KEY : env[users[user].requestyKeyEnv]}`);
    assert.equal(JSON.parse(request.body).model, model);
    assert.equal(result.body.configuration.modelSignature, signature);
    assert.equal(JSON.stringify(result).includes("synthetic-key"), false);
  }
});
test("invalid configuration and unsupported references are rejected without returning model text", async () => {
  let count = 0;
  global.fetch = async () => { count++; const invalid = page(input()); invalid.findings[0].evidence[0].quote = "SYNTHETIC_SENSITIVE_PROVIDER_TEXT";
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(invalid) } }] })); };
  const forged = input(); forged.configuration.modelSignature = "another/model";
  assert.equal((await invoke({ input: forged })).status, 409); assert.equal(count, 0);
  const result = await invoke({ input: input() });
  assert.equal(result.status, 502); assert.equal(result.body.error, "INVALID_WIKI_PAGE");
  assert.doesNotMatch(JSON.stringify(result), /SYNTHETIC_SENSITIVE_PROVIDER_TEXT/);
});
test("client uses authenticated scoped transport and tracks wiki calls", async () => {
  let request;
  const api = new LiteratureApiClient({ baseUrl: "https://synthetic.invalid", getHeaders: () => ({ Authorization: "Bearer synthetic-session" }),
    fetch: async (_url, options) => { request = options; return new Response(JSON.stringify({ ok: true, page: page(input()), configuration: input().configuration })); } });
  await api.updateWikiPage(input(), { callContext: { turnId: "wiki-test-turn", model } });
  assert.equal(request.headers["X-BioDesign-Chat-Model"], model);
  assert.equal(request.headers.Authorization, "Bearer synthetic-session");
  assert.equal(JSON.parse(request.body).callContext.model, undefined);
  assert.equal(api.getTurnCallCounts("wiki-test-turn").wiki_update, 1);
});
