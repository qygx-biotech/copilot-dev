const { test } = require("node:test"), assert = require("node:assert/strict");
const jwt = require("jsonwebtoken");
const { transcribeAudio, LIMITS } = require("../audio-transcription.js");
const audioBytes = Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), Buffer.alloc(20)]);
const body = { audio: { dataUrl: `data:audio/webm;base64,${audioBytes.toString("base64")}`, durationMs: 1000 }, language: "en" };
const env = { REQUESTY_API_KEY: "account-key" };

test("transcription uses the existing account Requesty key and fixed multipart endpoint", async () => {
  let calls = 0;
  const result = await transcribeAudio(body, { env, fetchImpl: async (url, options) => {
    calls++; assert.equal(url, "https://router.requesty.ai/v1/audio/transcriptions"); assert.equal(options.redirect, "error");
    assert.equal(options.headers.Authorization, "Bearer account-key"); assert.equal(options.body.get("model"), "openai/gpt-4o-mini-transcribe");
    assert.equal(options.body.get("file").type, "audio/webm"); assert.equal(options.body.get("language"), "en");
    assert.deepEqual(Buffer.from(await options.body.get("file").arrayBuffer()), audioBytes);
    return new Response(JSON.stringify({ text: " Inspect the enzyme activity. ", usage: { input_tokens: 1 } }));
  } });
  assert.equal(calls, 1); assert.equal(result.statusCode, 200); assert.equal(result.body.text, "Inspect the enzyme activity.");
  assert.equal(JSON.stringify(result).includes("account-key"), false); assert.equal(JSON.stringify(result).includes("base64"), false);
});

test("invalid or oversized audio and untrusted endpoint/model fields never reach a provider", async () => {
  const request = () => { throw Error("must not request"); };
  const invalid = [null, {}, { ...body, model: "other/provider" }, { ...body, endpoint: "https://evil.test" }, { ...body, language: "en-US" },
    { audio: { ...body.audio, durationMs: 0 } }, { audio: { ...body.audio, durationMs: 70000 } },
    { audio: { ...body.audio, dataUrl: "https://example.test/audio.webm" } }, { audio: { ...body.audio, dataUrl: "data:audio/webm;base64," + "A".repeat(LIMITS.maxBytes * 2) } },
    { audio: { ...body.audio, dataUrl: "data:audio/wav;base64," + audioBytes.toString("base64") } }];
  for (const input of invalid) assert.equal((await transcribeAudio(input, { env, fetchImpl: request })).statusCode, 400);
  assert.equal((await transcribeAudio(body, { env: { ...env, REQUESTY_TRANSCRIPTION_ENABLED: "false" }, fetchImpl: request })).body.error, "AUDIO_DISABLED");
  assert.equal((await transcribeAudio(body, { env: { ...env, REQUESTY_TRANSCRIPTION_MODEL: "external/model" }, fetchImpl: request })).body.error, "AUDIO_MODEL_NOT_CONFIGURED");
});

test("transcription errors and oversized outputs are explicit and never include provider diagnostics", async () => {
  for (const [status, expected] of [[401, "AUDIO_MODEL_UNAVAILABLE"], [404, "AUDIO_MODEL_UNAVAILABLE"], [429, "AUDIO_RATE_LIMITED"], [500, "AUDIO_PROVIDER_FAILED"]]) {
    const result = await transcribeAudio(body, { env, fetchImpl: async () => new Response("secret diagnostics", { status }) });
    assert.equal(result.body.error, expected); assert.equal(JSON.stringify(result).includes("secret"), false);
  }
  for (const text of ["", "x".repeat(32001)]) {
    const result = await transcribeAudio(body, { env, fetchImpl: async () => new Response(JSON.stringify({ text })) });
    assert.equal(result.body.error, "AUDIO_EMPTY_OR_INCOMPLETE");
  }
  assert.equal((await transcribeAudio(body, { env, fetchImpl: async () => new Response("x".repeat(200000)) })).body.error, "AUDIO_PROVIDER_FAILED");
});

test("cancellation reaches the audio provider and prevents stale output", async () => {
  const controller = new AbortController();
  const work = transcribeAudio(body, { env, signal: controller.signal, fetchImpl: (_url, { signal }) => new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true })) });
  controller.abort(); assert.equal((await work).body.error, "AUDIO_ABORTED");
});

test("FC transcription route requires login and never accepts model/provider overrides", async () => {
  process.env.JWT_SECRET = "audio-fixture-secret"; process.env.ADMIN_ACCOUNT = "audio-fixture";
  process.env.REQUESTY_API_KEY = "audio-fixture-key"; process.env.REQUESTY_MODEL = "chat-fixture";
  const { handler } = require("../index.js");
  const event = { requestContext: { http: { method: "POST", path: "/api/chat/transcribe" } }, body: JSON.stringify(body) };
  assert.equal((await handler(event)).statusCode, 401);
  const originalFetch = global.fetch; let calls = 0;
  global.fetch = async (url, options) => { calls++; assert.match(url, /audio\/transcriptions$/); assert.equal(options.headers.Authorization, "Bearer audio-fixture-key"); return new Response(JSON.stringify({ text: "Editable draft" })); };
  try {
    event.headers = { authorization: `Bearer ${jwt.sign({ account: "audio-fixture", role: "admin" }, process.env.JWT_SECRET)}` };
    const response = await handler(event); assert.equal(response.statusCode, 200); assert.equal(JSON.parse(response.body).text, "Editable draft");
    event.body = JSON.stringify({ ...body, model: "evil" }); assert.equal((await handler(event)).statusCode, 400); assert.equal(calls, 1);
  } finally { global.fetch = originalFetch; }
});
