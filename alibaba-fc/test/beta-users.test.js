"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const OSS = require("ali-oss");
const { handler, _test } = require("../index.js");

const password = " Original beta password! ";
const hash = bcrypt.hashSync(password, 4);
const users = [1, 2].map(n => ({ id: `beta0${n}`, account: `scientist-${n}`,
  passwordHash: n === 1 ? hash : bcrypt.hashSync("second-password", 4),
  requestyKeyEnv: `REQUESTY_KEY_BETA0${n}`, active: true }));
const nemotron = "nvidia/nemotron-3-nano-omni-30b-a3b-reasoning";
const baseEnv = {
  ADMIN_ACCOUNT: "admin-account", ADMIN_PASSWORD_HASH: bcrypt.hashSync("admin-password", 4),
  JWT_SECRET: "beta-test-signing-secret", BETA_USERS_JSON: JSON.stringify(users),
  REQUESTY_API_KEY: "admin-private-key", REQUESTY_KEY_BETA01: "beta-one-private-key", REQUESTY_KEY_BETA02: "beta-two-private-key",
  REQUESTY_MODEL: "fixture/answer", REQUESTY_SEARCH_PLANNER_MODEL: "fixture/planner", REQUESTY_RERANK_MODEL: "fixture/reranker",
  REQUESTY_SEMANTIC_PARSER_MODEL: "fixture/semantic", REQUESTY_SCHEMA_MAPPER_MODEL: "fixture/schema", REQUESTY_IMAGE_MODEL: "fixture/vision",
  REQUESTY_PDF_MODEL: "fixture/pdf", REQUESTY_PDF_ENABLED: "true", REQUESTY_PDF_SUPPORTS_JSON_SCHEMA: "true",
  REQUESTY_MODEL_SUPPORTS_JSON_SCHEMA: "true", REQUESTY_MODEL_CAPABILITIES_JSON: JSON.stringify({
    [nemotron]: { jsonSchema: true, pdf: true, pdfJsonSchema: true },
    "fixture/answer": { jsonSchema: true, pdf: true, pdfJsonSchema: true }
  }),
  OSS_BUCKET: "beta-fixture", OSS_REGION: "oss-cn-beijing", OSS_INTERNAL_ENDPOINT: "https://oss-cn-beijing-internal.aliyuncs.com",
  OSS_PUBLIC_ENDPOINT: "https://oss-cn-beijing.aliyuncs.com"
};
const originalEnv = Object.fromEntries(Object.keys(baseEnv).map(key => [key, process.env[key]]));
const originalFetch = global.fetch;
const providerRequests = [];
const finalAnswer = { reply: "A grounded answer.", project: { summary: "Analysis", organism: "Unknown",
  missingInformation: [], safetyLevel: "Review", safetyNotes: "Review", draftMemo: "Draft" } };
const completion = content => new Response(JSON.stringify({ choices: [{ message: {
  content: typeof content === "string" ? content : JSON.stringify(content)
}, finish_reason: "stop" }] }), { headers: { "content-type": "application/json" } });
function capture(url, options) {
  assert.equal(url, "https://router.requesty.ai/v1/chat/completions");
  const request = { key: options.headers.Authorization, body: JSON.parse(options.body) };
  providerRequests.push(request);
  return request;
}
test.beforeEach(() => {
  Object.assign(process.env, baseEnv);
  providerRequests.length = 0;
  global.fetch = async (url, options) => { capture(url, options); return completion({}); };
});
test.after(() => {
  for (const [key, value] of Object.entries(originalEnv)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
  global.fetch = originalFetch;
});
const context = { requestId: "beta-fixture", credentials: {
  accessKeyId: "STS.beta-fixture", accessKeySecret: "fixture-secret", securityToken: "fixture-token"
} };
async function invoke(method, path, body, token, headers = {}, transport) {
  const result = await handler({ httpMethod: method, path,
    headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) }, context, transport);
  return { status: result.statusCode, body: JSON.parse(result.body || "{}") };
}
const login = (account = users[0].account, originalPassword = password, extra = {}) =>
  invoke("POST", "/api/login", { account, password: originalPassword, ...extra });
const signed = (payload, options = {}) => jwt.sign(payload, baseEnv.JWT_SECRET, { expiresIn: "1h", ...options });
const betaToken = (n = 0) => signed({ id: users[n].id, sub: users[n].id, account: users[n].account, role: "beta" });
const adminToken = () => signed({ account: baseEnv.ADMIN_ACCOUNT, role: "admin" });
const chat = { mode: "side_chat", messages: [{ role: "user", content: "Explain the evidence." }] };
const png = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=";
const paper = { paperId: "paper-a", filename: "a.pdf", contentHash: "sha256:abc123" };
const providerRoutes = [
  ["/api/semantic/interpret", { query: "Find EctD evidence", profile: "medium", activeScope: {}, conversationContext: [], projectSemanticRegistry: { version: 1 } }, "REQUESTY_SEMANTIC_PARSER_MODEL"],
  ["/api/semantic/map-schema", { version: 1, schemaSignature: "fixture", sheet: "Results",
    columns: [{ columnId: "c1", rawHeader: "Activity", unit: null, valueTypes: ["number"], examples: [1], candidateFields: ["enzyme_activity"] }],
    ontology: [{ canonicalField: "enzyme_activity", labels: { en: "Activity" }, canonicalUnit: null, dataType: "number" }] }, "REQUESTY_SCHEMA_MAPPER_MODEL"],
  ["/api/knowledge/plan-search", { query: "EctD stability", intent: "scientific evidence" }, "REQUESTY_SEARCH_PLANNER_MODEL"],
  ["/api/knowledge/rerank", { query: "EctD stability", intent: "scientific evidence", candidates: [{
    candidateId: `candidate-${"a".repeat(64)}`, title: "EctD", evidence: [{ evidenceHandle: `evidence-${"a".repeat(64)}-1`, snippet: "EctD activity" }]
  }] }, "REQUESTY_RERANK_MODEL"],
  ["/api/literature/summarize-chunk", { filename: "a.pdf", chunkIndex: 0, totalChunks: 1, text: "Scientific evidence from EctD." }],
  ["/api/literature/synthesize", { filename: "a.pdf", chunkSummaries: [{ summary: "EctD evidence" }] }],
  ["/api/literature/create-paper-card-from-text", { ...paper, text: "# Page 1\nEctD evidence", pageCount: 1, chunkCount: 1 }],
  ["/api/corpus/map-paper", { ...paper, question: "Which variants improved activity?", evidence: [{ evidenceRef: "paper-a:p1:c1", text: "The variant improved activity." }] }],
  ["/api/literature/analyze-pdf-native", { ...paper, task: "Summarize the paper", fileData: `data:application/pdf;base64,${Buffer.from("%PDF-1.4\nfixture").toString("base64")}` }, "REQUESTY_PDF_MODEL"],
  ["/api/context/route", { userQuery: "Which EctD papers?", literatureIndex: [] }],
  ["/api/chat/understand-images", { question: "Read this image", images: [{ name: "plot.png", dataUrl: png, thumbnail: png }] }, "REQUESTY_IMAGE_MODEL"]
];
const protectedRoutes = [
  ["GET", "/api/me"], ["GET", "/api/knowledge/config"], ["GET", "/api/literature/config"],
  ...providerRoutes.map(([path, body]) => ["POST", path, body]), ["POST", "/chat", chat],
  ["POST", "/api/test-oss"], ["GET", "/api/documents"], ["POST", "/api/documents/upload-url"],
  ["POST", "/api/documents/delete"], ["POST", "/api/documents/review"]
];
function assertNoSecrets(value) {
  const text = JSON.stringify(value);
  for (const secret of [hash, users[1].passwordHash, baseEnv.ADMIN_PASSWORD_HASH,
    baseEnv.REQUESTY_API_KEY, baseEnv.REQUESTY_KEY_BETA01, baseEnv.REQUESTY_KEY_BETA02, baseEnv.JWT_SECRET]) {
    assert.equal(text.includes(secret), false, "Server secret appeared in a public value");
  }
  assert.doesNotMatch(text, /passwordHash|requestyKeyEnv/);
}

test("existing login accepts original beta passwords and returns only signed public identity and model metadata", async () => {
  for (const [n, pwd] of [[0, password], [1, "second-password"]]) {
    const result = await login(` ${users[n].account} `, pwd, { id: "admin", role: "admin", requestyKeyEnv: "REQUESTY_API_KEY" });
    assert.equal(result.status, 200);
    const user = { id: users[n].id, account: users[n].account, role: "beta" };
    assert.deepEqual(result.body.user, user);
    const claims = jwt.verify(result.body.token, baseEnv.JWT_SECRET, { algorithms: ["HS256"] });
    assert.deepEqual(Object.keys(claims).sort(), ["account", "exp", "iat", "id", "role", "sub"]);
    assert.equal(claims.sub, user.id);
    assert.equal(claims.exp - claims.iat, 12 * 60 * 60);
    assert.equal(result.body.chatModel, baseEnv.REQUESTY_MODEL);
    assertNoSecrets(result.body); assertNoSecrets(claims);
    const me = await invoke("GET", "/api/me", undefined, result.body.token);
    assert.equal(me.status, 200); assert.deepEqual(me.body.user, user); assertNoSecrets(me.body);
  }
});

test("invalid, hashed, trimmed and other users' passwords are rejected without revealing account status", async () => {
  for (const [account, pwd] of [[users[0].account, "wrong"], [users[0].account, hash],
    [users[0].account, password.trim()], [users[0].account, "second-password"], ["unknown", password],
    [baseEnv.ADMIN_ACCOUNT, password], [users[0].account, "admin-password"]]) {
    const result = await login(account, pwd);
    assert.equal(result.status, 401); assert.deepEqual(result.body, { error: "Invalid account or password" });
  }
  assert.equal((await login("", password)).status, 400);
  assert.equal((await login(users[0].account, "")).status, 400);
  process.env.BETA_USERS_JSON = JSON.stringify([{ ...users[0], active: false }]);
  assert.equal((await login()).status, 401);
  assert.equal(providerRequests.length, 0);
});

test("bcrypt 2a, 2b and 2y configuration accepts canonical generated hashes", async () => {
  for (const minor of ["a", "b", "y"]) {
    process.env.BETA_USERS_JSON = JSON.stringify([{ ...users[0], passwordHash: hash.replace("$2a$", `$2${minor}$`) }]);
    assert.equal((await login()).status, 200);
  }
});

test("all authenticated routes reject disabled, removed or renamed beta users on their next request", async () => {
  const token = (await login()).body.token;
  for (const configuration of [[{ ...users[0], active: false }], [], [{ ...users[0], account: "renamed" }],
    [{ ...users[0], id: "new-id" }], undefined]) {
    if (configuration === undefined) delete process.env.BETA_USERS_JSON;
    else process.env.BETA_USERS_JSON = JSON.stringify(configuration);
    for (const [method, path, body] of protectedRoutes) {
      const result = await invoke(method, path, body, token);
      assert.equal(result.status, 401, path);
    }
  }
  assert.equal(providerRequests.length, 0);
});

test("all protected routes reject absent, expired, tampered and inconsistent identities", async () => {
  const identity = { id: "beta01", sub: "beta01", account: users[0].account, role: "beta" };
  const tokens = [undefined, betaToken() + "x", signed(identity, { expiresIn: -1 }),
    signed(identity, { algorithm: "HS384" }), jwt.sign(identity, "wrong-secret"),
    signed({ ...identity, role: "admin" }), signed({ ...identity, account: users[1].account }),
    signed({ ...identity, id: "beta02" }), signed({ ...identity, sub: "beta02" }),
    signed({ account: users[0].account, role: "beta" }), signed({ account: "former-admin", role: "admin" }),
    signed({ id: "beta01", sub: "beta01", account: baseEnv.ADMIN_ACCOUNT, role: "admin" })];
  for (const token of tokens) {
    for (const [method, path, body] of protectedRoutes) assert.equal((await invoke(method, path, body, token)).status, 401, path);
  }
  assert.equal(providerRequests.length, 0);
});

test("malformed configuration fails closed for login, sessions and every protected route", async t => {
  const badUsers = [null, [], {}, ...Object.keys(users[0]).map(key => {
    const user = { ...users[0] }; delete user[key]; return user;
  }), ...["", "../beta", "admin", "ADMIN", 2].map(id => ({ ...users[0], id })),
  ...["", " scientist-1", "scientist-1\n", "a\u0000b", 42, baseEnv.ADMIN_ACCOUNT, "ADMIN-ACCOUNT", "ａｄｍｉｎ-account"].map(account => ({ ...users[0], account })),
  ...["plaintext", hash.slice(0, -1), hash.replace("$04$", "$03$"), hash.replace("$04$", "$32$"), hash.replace("$2a$", "$2x$"), null].map(passwordHash => ({ ...users[0], passwordHash })),
  ...["REQUESTY_API_KEY", "JWT_SECRET", "REQUESTY_KEY_", "REQUESTY_KEY_beta01", "REQUESTY_KEY_BETA01\n", "__proto__", "REQUESTY_KEY_A-B", null].map(requestyKeyEnv => ({ ...users[0], requestyKeyEnv })),
  ...["true", 1, null].map(active => ({ ...users[0], active })), { ...users[0], role: "admin" }, { ...users[0], requestyKey: "inline-secret" }];
  const configurations = ["", "{", "null", "{}", "42", '"array"', ...badUsers.map(user => JSON.stringify([user])),
    JSON.stringify([users[0], { ...users[1], id: "BETA01" }]),
    JSON.stringify([users[0], { ...users[1], account: "SCIENTIST-1" }]),
    JSON.stringify([users[0], { ...users[1], account: "ｓcientist-1" }]),
    JSON.stringify([users[0], { ...users[1], requestyKeyEnv: users[0].requestyKeyEnv }])];
  for (const [index, configuration] of configurations.entries()) {
    await t.test(`invalid configuration ${index + 1}`, async () => {
      process.env.BETA_USERS_JSON = configuration;
      assert.equal((await login()).status, 500);
      assert.equal((await login(baseEnv.ADMIN_ACCOUNT, "admin-password")).status, 500);
      for (const [method, path, body] of protectedRoutes) {
        const result = await invoke(method, path, body, betaToken());
        assert.equal(result.status, 500, path);
        assert.deepEqual(result.body, { error: "Invalid BETA_USERS_JSON configuration." });
      }
      assert.equal((await invoke("GET", "/api/me", undefined, adminToken())).status, 500);
    });
  }
  assert.equal(providerRequests.length, 0);
});

test("missing beta keys fail before provider or streaming work and never fall back to the shared key", async () => {
  for (const value of [undefined, "", "  ", "invalid key", " padded-key ", "key\n"]) {
    if (value === undefined) delete process.env.REQUESTY_KEY_BETA01; else process.env.REQUESTY_KEY_BETA01 = value;
    assert.equal((await login()).status, 503);
    for (const [method, path, body] of protectedRoutes) {
      let started = false;
      const result = await invoke(method, path, { ...body, stream: true }, betaToken(), {}, { start: async () => { started = true; } });
      assert.equal(result.status, 503, path); assert.equal(started, false);
      assert.deepEqual(result.body, { error: "BETA_REQUESTY_KEY_MISSING", message: "Requesty is not configured for this user." });
    }
    assert.equal((await login(users[1].account, "second-password")).status, 200);
    assert.equal((await login(baseEnv.ADMIN_ACCOUNT, "admin-password")).status, 200);
  }
  assert.equal(providerRequests.length, 0);
});

test("every preparatory provider route keeps user credentials independent of selected or role-specific models", async t => {
  for (const [path, body, roleModel = "REQUESTY_MODEL"] of providerRoutes) {
    await t.test(path, async () => {
      for (const [token, key] of [[betaToken(), baseEnv.REQUESTY_KEY_BETA01], [betaToken(1), baseEnv.REQUESTY_KEY_BETA02], [adminToken(), baseEnv.REQUESTY_API_KEY]]) {
        for (const model of [undefined, "default", nemotron]) {
          providerRequests.length = 0;
          const result = await invoke("POST", path, body, token, model ? { "X-BioDesign-Chat-Model": model } : {});
          assert.ok(providerRequests.length > 0, `${path} never reached provider: ${JSON.stringify(result)}`);
          if (path === "/api/corpus/map-paper") assert.ok(providerRequests.length >= 2, "schema repair must use the same credential");
          if (path === "/api/literature/analyze-pdf-native") assert.ok(providerRequests.length >= 3, "PDF repair attempts must use the same credential");
          const expectedModel = model === nemotron ? nemotron : model === "default" ? baseEnv.REQUESTY_MODEL : baseEnv[roleModel];
          for (const request of providerRequests) {
            assert.equal(request.key, `Bearer ${key}`, path); assert.equal(request.body.model, expectedModel, path); assertNoSecrets(request.body);
          }
          assertNoSecrets(result.body);
        }
      }
    });
  }
  for (const [key, value] of Object.entries(baseEnv)) assert.equal(process.env[key], value, `${key} mutated`);
});

test("Side Chat and Agent Command answer/tool loops and streamed answers retain the caller's key", async () => {
  for (const mode of ["side_chat", "agent_instruction"]) {
    for (const stream of [false, true]) {
      for (const [token, key] of [[betaToken(), baseEnv.REQUESTY_KEY_BETA01], [betaToken(1), baseEnv.REQUESTY_KEY_BETA02], [adminToken(), baseEnv.REQUESTY_API_KEY]]) {
        providerRequests.length = 0;
        global.fetch = async (url, options) => {
          capture(url, options);
          if (providerRequests.length === 1) return new Response(JSON.stringify({ choices: [{ message: { content: null,
            tool_calls: [{ id: "papers", type: "function", function: { name: "list_papers", arguments: "{}" } }] } }] }));
          if (!stream) return completion(finalAnswer);
          return new Response(`data: ${JSON.stringify({ choices: [{ delta: { content: JSON.stringify(finalAnswer) }, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`, { headers: { "content-type": "text/event-stream" } });
        };
        const events = [];
        const result = await invoke("POST", "/chat", { ...chat, mode, model: nemotron, stream }, token, {}, {
          start: async () => events.push("start"), emit: async (type, data) => { assertNoSecrets(data); events.push(type); }
        });
        assert.equal(result.status, 200); assert.equal(result.body.fallback, false); assert.equal(result.body.reply, finalAnswer.reply);
        assert.equal(providerRequests.length, 2);
        for (const request of providerRequests) {
          assert.equal(request.key, `Bearer ${key}`); assert.equal(request.body.model, mode === "side_chat" ? nemotron : baseEnv.REQUESTY_MODEL);
        }
        if (stream) { assert.equal(events[0], "start"); assert.ok(events.includes("delta")); }
      }
    }
  }
});

test("simultaneous beta and admin calls, including HTTP retries, never exchange keys or models", async () => {
  let entered, release;
  const allEntered = new Promise(resolve => { entered = resolve; });
  const barrier = new Promise(resolve => { release = resolve; });
  const attempts = new Map();
  global.fetch = async (url, options) => {
    const request = capture(url, options);
    const count = (attempts.get(request.key) || 0) + 1; attempts.set(request.key, count);
    if (count === 1) {
      if (attempts.size === 3) entered();
      await barrier;
      return new Response("Temporary error", { status: 503 });
    }
    return completion(finalAnswer);
  };
  const pending = Promise.all([
    invoke("POST", "/chat", { ...chat, model: nemotron }, betaToken()),
    invoke("POST", "/chat", { ...chat, model: "default" }, betaToken(1)),
    invoke("POST", "/chat", { ...chat, mode: "agent_instruction" }, adminToken())
  ]);
  await allEntered;
  for (const [key, value] of Object.entries(baseEnv)) assert.equal(process.env[key], value);
  release();
  const results = await pending;
  assert.ok(results.every(result => result.status === 200 && result.body.fallback === false));
  assert.equal(providerRequests.length, 6);
  for (const [key, model] of [[baseEnv.REQUESTY_KEY_BETA01, nemotron], [baseEnv.REQUESTY_KEY_BETA02, baseEnv.REQUESTY_MODEL], [baseEnv.REQUESTY_API_KEY, baseEnv.REQUESTY_MODEL]]) {
    const requests = providerRequests.filter(request => request.key === `Bearer ${key}`);
    assert.equal(requests.length, 2); assert.ok(requests.every(request => request.body.model === model));
  }
});

test("configuration key changes take effect for an existing session on its next request", async () => {
  global.fetch = async (url, options) => { capture(url, options); return completion(finalAnswer); };
  const token = (await login()).body.token;
  await invoke("POST", "/chat", chat, token);
  process.env.REQUESTY_KEY_BETA01 = "rotated-beta-key";
  await invoke("POST", "/chat", chat, token);
  assert.deepEqual(providerRequests.map(request => request.key), [`Bearer ${baseEnv.REQUESTY_KEY_BETA01}`, "Bearer rotated-beta-key"]);
});

test("provider rejection cannot disclose the beta key or retry using admin credentials", async () => {
  global.fetch = async (url, options) => {
    capture(url, options);
    return new Response(JSON.stringify({ error: { message: `Invalid API key: ${baseEnv.REQUESTY_KEY_BETA01}` } }), { status: 401 });
  };
  for (const [path, body] of [["/chat", chat], ["/api/literature/summarize-chunk", providerRoutes[4][1]]]) {
    const result = await invoke("POST", path, body, betaToken());
    assertNoSecrets(result.body);
  }
  assert.equal(providerRequests.length, 2);
  assert.ok(providerRequests.every(request => request.key === `Bearer ${baseEnv.REQUESTY_KEY_BETA01}`));
});

test("client-supplied identity and key fields cannot override authentication, including model requests", async () => {
  global.fetch = async (url, options) => { capture(url, options); return completion(finalAnswer); };
  const forged = { account: baseEnv.ADMIN_ACCOUNT, id: "admin", role: "admin", user: { account: users[1].account },
    requestyKeyEnv: "REQUESTY_API_KEY", requestyKey: "client-forged-key", apiKey: "client-forged-key",
    REQUESTY_API_KEY: "client-forged-key", env: { REQUESTY_API_KEY: "client-forged-key" } };
  const headers = { "X-User-ID": "admin", "X-Requesty-Key": "client-forged-key", "X-BioDesign-Chat-Model": nemotron };
  for (const [path, body] of [["/chat", chat], ["/api/literature/summarize-chunk", providerRoutes[4][1]]]) {
    await invoke("POST", path, { ...body, ...forged }, betaToken(), headers);
  }
  assert.equal(providerRequests.length, 2);
  for (const request of providerRequests) {
    assert.equal(request.key, `Bearer ${baseEnv.REQUESTY_KEY_BETA01}`);
    assert.doesNotMatch(JSON.stringify(request.body), /client-forged-key|requestyKeyEnv|admin-account|scientist-2/);
  }
  const invalidContext = await invoke("POST", "/chat", { ...chat, callContext: { ...forged, turnId: "caller-turn" } }, betaToken());
  assert.equal(invalidContext.status, 400);
  assert.equal(providerRequests.length, 2);
});

function fixturePdf() {
  const line = "The paper compares enzyme variants and reports evidence, methods and limitations. ";
  const content = `BT /F1 11 Tf 72 730 Td ${Array.from({ length: 4 }, (_, i) => `${i ? "0 -24 Td" : ""} (${line}) Tj`).join("\n")} ET`;
  const objects = ["<< /Type /Catalog /Pages 2 0 R >>", "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>",
    `<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}\nendstream`, "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"];
  let pdf = "%PDF-1.4\n";
  const offsets = objects.map((object, i) => {
    const offset = Buffer.byteLength(pdf); pdf += `${i + 1} 0 obj\n${object}\nendobj\n`; return offset;
  });
  const xref = Buffer.byteLength(pdf);
  pdf += `xref\n0 6\n0000000000 65535 f \n${offsets.map(offset => `${String(offset).padStart(10, "0")} 00000 n \n`).join("")}`;
  return Buffer.from(pdf + `trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
}

test("legacy OSS PDF workers use the beta key and keep account ownership for reviews, chat, uploads, listing and deletion", async t => {
  const objects = new Map();
  const accesses = [];
  t.mock.method(OSS.prototype, "getObjectMeta", async key => {
    accesses.push(key);
    return { res: { headers: { "content-length": String(objects.get(key).length), "content-type": "application/pdf" } } };
  });
  t.mock.method(OSS.prototype, "get", async key => {
    accesses.push(key);
    if (!objects.has(key)) throw Object.assign(new Error("Missing fixture"), { code: "NoSuchKey", status: 404 });
    return { content: objects.get(key) };
  });
  t.mock.method(OSS.prototype, "put", async (key, content) => { accesses.push(key); objects.set(key, content); return {}; });
  t.mock.method(OSS.prototype, "delete", async key => { accesses.push(key); objects.delete(key); return {}; });
  t.mock.method(OSS.prototype, "listV2", async ({ prefix }) => ({ objects: [...objects.keys()].filter(key => key.startsWith(prefix)).map(name => ({ name, size: objects.get(name).length })), isTruncated: false }));
  const ownKey = _test.buildOwnedPdfObjectKey(users[0].account, "evidence.pdf");
  const otherKey = _test.buildOwnedPdfObjectKey(users[1].account, "private.pdf");
  objects.set(ownKey, fixturePdf()); objects.set(otherKey, fixturePdf());
  global.fetch = async (url, options) => { capture(url, options); return completion({ summary: "The paper reports evidence.", ...finalAnswer }); };
  const review = await invoke("POST", "/api/documents/review", { objectKey: ownKey, force: true }, betaToken());
  assert.equal(review.status, 200, JSON.stringify(review.body));
  assert.ok(providerRequests.length >= 2, "legacy chunk and synthesis must both call the provider");
  assert.ok(providerRequests.every(request => request.key === `Bearer ${baseEnv.REQUESTY_KEY_BETA01}`));
  providerRequests.length = 0;
  const ownChat = await invoke("POST", "/chat", { ...chat, storedDocuments: [{ objectKey: ownKey }], selectedDocumentKeys: [ownKey] }, betaToken());
  assert.equal(ownChat.status, 200); assert.equal(ownChat.body.fallback, false);
  assert.deepEqual(ownChat.body.documentScope.objectKeys, [ownKey]);
  assert.ok(providerRequests.length > 0); assert.ok(providerRequests.every(request => request.key === `Bearer ${baseEnv.REQUESTY_KEY_BETA01}`));
  const upload = await invoke("POST", "/api/documents/upload-url", { filename: "new.pdf", contentType: "application/pdf", size: 100,
    account: users[1].account, user: { account: users[1].account } }, betaToken());
  assert.equal(upload.status, 200); assert.equal(_test.isOwnedPdfObjectKey(upload.body.objectKey, users[0].account), true);
  const listing = await invoke("GET", "/api/documents", undefined, betaToken());
  assert.equal(listing.status, 200); assert.equal(JSON.stringify(listing.body).includes(otherKey), false);
  providerRequests.length = 0; accesses.length = 0;
  for (const path of ["/api/documents/review", "/api/documents/delete"]) {
    const result = await invoke("POST", path, { ...chat, objectKey: otherKey, account: users[1].account,
      user: { account: users[1].account }, storedDocuments: [{ objectKey: otherKey }], selectedDocumentKeys: [otherKey] }, betaToken());
    assert.equal(result.status, 403, `${path}: ${JSON.stringify(result.body)}`);
  }
  assert.equal(providerRequests.length, 0); assert.equal(accesses.length, 0);
  // Chat's existing ownership boundary discards foreign descriptors, allowing
  // the conversation to continue without retrieving or exposing those files.
  const foreignChat = await invoke("POST", "/chat", { ...chat, account: users[1].account,
    storedDocuments: [{ objectKey: otherKey }], selectedDocumentKeys: [otherKey] }, betaToken());
  assert.equal(foreignChat.status, 200); assert.deepEqual(foreignChat.body.documentScope.objectKeys, []);
  assert.equal(accesses.length, 0); assert.equal(providerRequests.length, 1);
  assert.equal(providerRequests[0].key, `Bearer ${baseEnv.REQUESTY_KEY_BETA01}`);
  assert.equal(JSON.stringify(providerRequests[0].body).includes(otherKey), false);
  assert.equal((await invoke("POST", "/api/documents/delete", { objectKey: ownKey }, betaToken())).status, 200);
  assert.equal(objects.has(ownKey), false); assert.equal(objects.has(otherKey), true);
});

test("admin-only installations and old admin sessions remain compatible without beta configuration or provider key at login", async () => {
  for (const config of [undefined, "[]"]) {
    if (config === undefined) delete process.env.BETA_USERS_JSON; else process.env.BETA_USERS_JSON = config;
    const result = await login(baseEnv.ADMIN_ACCOUNT, "admin-password");
    assert.equal(result.status, 200); assert.deepEqual(result.body.user, { id: "admin", account: baseEnv.ADMIN_ACCOUNT, role: "admin" });
    for (const token of [adminToken(), result.body.token]) assert.equal((await invoke("GET", "/api/me", undefined, token)).status, 200);
    global.fetch = async (url, options) => { capture(url, options); return completion(finalAnswer); };
    assert.equal((await invoke("POST", "/chat", chat, result.body.token)).body.fallback, false);
    assert.equal(providerRequests.at(-1).key, `Bearer ${baseEnv.REQUESTY_API_KEY}`);
  }
  delete process.env.REQUESTY_API_KEY;
  assert.equal((await login(baseEnv.ADMIN_ACCOUNT, "admin-password")).status, 200);
  assert.equal((await invoke("GET", "/api/me", undefined, adminToken())).status, 200);
  assert.equal((await invoke("OPTIONS", "/api/login")).status, 204);
  assert.equal((await invoke("GET", "/health")).status, 200);
  assert.equal((await invoke("POST", "/api/logout")).status, 200);
});
