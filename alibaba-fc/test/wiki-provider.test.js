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
  return wiki.markdownPage(`# Stability\n\n${input.papers.map(paper => `${paper.evidence[0].text} [[cite:${paper.evidence[0].reference}]]`).join("\n\n")}\n\n### Open question\n\nCould temperature account for the difference?`);
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
  global.fetch = async (_url, options) => { calls.push(options); return new Response(JSON.stringify({ choices: [{ message: { content: page(input()).markdown } }] })); };
  assert.equal((await invoke({ input: input() }, null)).status, 401);
  assert.equal((await invoke({ input: input() }, 0, "forged/model")).status, 400);
  assert.equal(calls.length, 0);
  for (const user of [0, 1, -1]) {
    const result = await invoke({ input: input(), role: "admin", accountId: users[1].id, model: "forged/model", requestyKeyEnv: "REQUESTY_API_KEY" }, user);
    assert.equal(result.status, 200);
    const request = calls.at(-1);
    assert.equal(request.headers.Authorization, `Bearer ${user < 0 ? env.REQUESTY_API_KEY : env[users[user].requestyKeyEnv]}`);
    assert.equal(JSON.parse(request.body).model, model);
    assert.equal(JSON.parse(request.body).response_format, undefined);
    assert.equal(result.body.page.schemaVersion, 2);
    assert.equal(result.body.configuration.modelSignature, signature);
    assert.equal(JSON.stringify(result).includes("synthetic-key"), false);
  }
});
test("invalid configuration is rejected; usable Markdown with unresolved citations is returned as an unverified draft", async () => {
  let count = 0;
  global.fetch = async () => { count++;
    return new Response(JSON.stringify({ choices: [{ message: { content: "SYNTHETIC_SENSITIVE_PROVIDER_TEXT [[cite:invented:p1:chunk]]" } }] })); };
  const forged = input(); forged.configuration.modelSignature = "another/model";
  assert.equal((await invoke({ input: forged })).status, 409); assert.equal(count, 0);
  const result = await invoke({ input: input() });
  assert.equal(result.status, 200); assert.equal(result.body.acceptance, "unverified_draft");
  assert.match(result.body.validationProblems[0], /not supplied/);
  assert.equal(result.body.attempts, 2);
  assert.equal(result.body.generationAudit.modelRepairCalls, 1);
  assert.match(result.body.page.markdown, /SYNTHETIC_SENSITIVE_PROVIDER_TEXT/);
  assert.equal(result.body.integrity.verifiedClaimCount, 0);
  assert.equal(result.body.integrity.references.length, 0);
  assert.doesNotMatch(wiki.renderPage(result.body.page, result.body.integrity), /\[\[cite:|biodesign-citation:/);
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

test("diagnostics distinguish configuration, known provider attempts and missing legacy attempt counts", async () => {
  const replies = [{ ok: true }, { error: "INVALID_WIKI_PAGE", validationProblems: ["Unknown evidence reference."], attempts: 1 }, { error: "INVALID_WIKI_PAGE" }];
  const events = [];
  const api = new LiteratureApiClient({ baseUrl: "https://fixture.invalid", getHeaders: () => ({}),
    runtimeLog: { begin: () => (status, details) => events.push({ status, ...details }) },
    fetch: async () => { const body = replies.shift(); return new Response(JSON.stringify(body), { status: body.ok ? 200 : 502 }); } });
  await api.request("/api/literature/config", undefined, undefined, "GET", { turnId: "counts" });
  for (const expected of [1, null]) await assert.rejects(api.updateWikiPage(input(), { callContext: { turnId: "counts" } }), error => error.attempts === expected);
  const counts = api.getTurnAccounting("counts");
  assert.equal(counts.configurationRequests, 1);
  assert.equal(counts.logicalEndpointCalls["/api/knowledge/update-wiki"], 2);
  assert.equal(counts.providerAttempts["/api/knowledge/update-wiki"], 1);
  assert.equal(counts.unknownProviderResponses, 1);
  assert.ok(events.some(event => event.processingKind === "configuration" && event.providerAttempts === 0));
  assert.ok(events.some(event => event.code === "INVALID_WIKI_PAGE" && event.providerAttempts === null));
});
