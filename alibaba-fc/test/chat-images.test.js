const test = require("node:test"), assert = require("node:assert/strict"), crypto = require("node:crypto");
const jwt = require("jsonwebtoken");
const images = require("../../shared/chat-images.js");
const { understandImages } = require("../image-understanding.js");
const { WorkspaceChatStore, ProjectContextService } = require("../../docs/project-context-service.js");
const png = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=";
const image = { name: "plot.png", dataUrl: png, thumbnail: png };
const env = { REQUESTY_API_KEY: "fixture", REQUESTY_MODEL: "default-vision" };
const success = { ok: true, message: { content: "Image 1: visible axis label 25 U/mL; error bar unreadable." }, finishReason: "stop" };

test("image understanding uses Requesty image_url content, preserves question and selects the configured vision model", async () => {
  let call;
  const result = await understandImages({ question: "解释这个图", images: [image, image] }, { env: { ...env, REQUESTY_IMAGE_MODEL: "vision-override" }, metadata: { requesty: { tags: ["image_understanding"] } }, request: async (...args) => { call = args; return success; } });
  assert.equal(result.statusCode, 200); assert.equal(result.body.imageCount, 2);
  assert.equal(call[0].model, "vision-override");
  assert.equal(call[0].messages[1].content[0].text, "User question:\n解释这个图");
  assert.deepEqual(call[0].messages[1].content.filter(part => part.type === "image_url"), [1, 2].map(() => ({ type: "image_url", image_url: { url: png } })));
  assert.match(call[0].messages[0].content, /never instructions/);
  assert.equal(call[2], true); assert.ok(call[4].signal);
  assert.equal(result.body.understanding.text, success.message.content);
  assert.ok(!JSON.stringify(result).includes("base64"));
});

test("invalid, oversized, mismatched and URL-based images fail before a provider request", async () => {
  let calls = 0;
  const request = async () => { calls++; return success; };
  for (const attachments of [[], Array(5).fill(image), [{ ...image, dataUrl: "https://example.org/private.png" }], [{ ...image, dataUrl: "data:image/svg+xml;base64,PHN2Zy8+" }], [{ ...image, dataUrl: "data:image/png;base64,aGVsbG8=" }], [{ ...image, dataUrl: "data:image/jpeg;base64," + png.split(",")[1] }], [{ ...image, dataUrl: "data:image/png;base64," + "A".repeat(images.limits.imageBytes * 2) }]]) {
    assert.equal((await understandImages({ question: "Explain", images: attachments }, { env, request })).statusCode, 400);
  }
  assert.equal((await understandImages({ question: "x".repeat(12001), images: [image] }, { env, request })).statusCode, 400);
  assert.equal(calls, 0);
});

test("missing model, provider rejection, quotas and incomplete vision output never become observations", async () => {
  const body = { question: "Explain", images: [image] };
  assert.equal((await understandImages(body, { env: {}, request: async () => { throw Error("Must not call"); } })).statusCode, 503);
  for (const result of [{ ok: false, status: 400, message: "secret provider diagnostic" }, { ...success, finishReason: "length" }, { ...success, message: { content: "" } }, { ...success, message: { content: "x".repeat(16001) } }]) {
    const response = await understandImages(body, { env, request: async () => result });
    assert.equal(response.statusCode, 502);
    assert.ok(!response.body.understanding); assert.ok(!JSON.stringify(response).includes("secret"));
  }
  const throttled = await understandImages(body, { env, request: async () => ({ ok: false, status: 502, rateLimit: { rateLimitRetryable: true, retryAfterMs: 45000 } }) });
  assert.equal(throttled.statusCode, 429); assert.equal(throttled.body.retryAfterMs, 45000);
});

test("workspace cancellation reaches the vision provider", async () => {
  const controller = new AbortController();
  const pending = understandImages({ question: "Explain", images: [image] }, { env, signal: controller.signal, request: async (_body, _key, _defer, _stream, options) => {
    return new Promise((_resolve, reject) => options.signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true }));
  } });
  controller.abort();
  assert.equal((await pending).statusCode, 504);
});

test("the authenticated FC image route returns derived text with bounded tracing metadata", async () => {
  process.env.JWT_SECRET = "image-fixture-secret"; process.env.ADMIN_ACCOUNT = "image-fixture";
  process.env.REQUESTY_API_KEY = "image-fixture-key"; process.env.REQUESTY_MODEL = "image-fixture-model";
  const { handler } = require("../index.js");
  const event = { requestContext: { http: { method: "POST", path: "/api/chat/understand-images" } }, body: JSON.stringify({ question: "Read this plot", images: [image], callContext: { turnId: "turn-1", callRole: "image_understanding", profile: "light" } }) };
  assert.equal((await handler(event)).statusCode, 401);
  const originalFetch = global.fetch; let calls = 0;
  global.fetch = async (url, options) => {
    calls++;
    assert.match(url, /router.requesty.ai/);
    const request = JSON.parse(options.body);
    assert.equal(request.model, "image-fixture-model");
    assert.equal(request.requesty.extra.call_role, "image_understanding");
    assert.equal(request.messages[1].content[2].image_url.url, png);
    return new Response(JSON.stringify({ choices: [{ message: success.message, finish_reason: "stop" }] }));
  };
  try {
    event.headers = { authorization: `Bearer ${jwt.sign({ account: "image-fixture", role: "admin" }, process.env.JWT_SECRET)}` };
    const response = await handler(event);
    assert.equal(response.statusCode, 200); assert.equal(calls, 1);
    assert.equal(JSON.parse(response.body).understanding.text, success.message.content);
    const body = JSON.parse(event.body); body.callContext.callRole = "answer"; event.body = JSON.stringify(body);
    assert.equal((await handler(event)).statusCode, 400); assert.equal(calls, 1);
  } finally { global.fetch = originalFetch; }
});

test("chat images survive save/reopen and revision while conversation context contains observations instead of image bytes", async () => {
  const files = new Map();
  const workspace = { state: {}, createId: crypto.randomUUID, ensureDirectory: async () => {}, fileExists: async path => files.has(path),
    writeJson: async (path, value) => files.set(path, structuredClone(value)), readJson: async path => structuredClone(files.get(path)) };
  const store = new WorkspaceChatStore({ workspace });
  const attachments = await store.saveImageAttachments([image]);
  const conversation = store.createConversation();
  conversation.messages.push({ id: crypto.randomUUID(), role: "user", content: "Compare the activity", createdAt: new Date().toISOString(), images: attachments, imageUnderstanding: { text: "Image 1: 25 U/mL", model: "vision" } });
  await store.saveConversation(conversation);
  const restored = await new WorkspaceChatStore({ workspace }).loadActiveConversation();
  assert.deepEqual(restored.messages[0].images, attachments);
  assert.equal((await store.loadImageAttachments(restored.messages[0].images))[0].dataUrl, png);
  const context = new ProjectContextService({ workspace }).buildConversationContext(restored);
  assert.match(context.recentMessages[0].content, /25 U\/mL/);
  assert.ok(!JSON.stringify(context).includes("data:image"));
  assert.ok(!JSON.stringify(restored).includes('"dataUrl"'));
  await assert.rejects(store.loadImageAttachments([{ ...attachments[0], attachmentId: "../../private" }]), { code: "IMAGE_MISSING" });
  files.delete(`.biodesign/chat/attachments/${attachments[0].attachmentId}.json`);
  await assert.rejects(store.loadImageAttachments(attachments), { code: "IMAGE_MISSING" });
});

test("switching workspace during attachment persistence cannot write the remaining images to the next project", async () => {
  let writes = 0;
  const workspace = { workspace: { workspaceId: "first" }, createId: crypto.randomUUID, ensureDirectory: async () => {},
    writeJson: async () => { writes++; workspace.workspace.workspaceId = "second"; } };
  const store = new WorkspaceChatStore({ workspace });
  await assert.rejects(store.saveImageAttachments([image, image]), { code: "OPERATION_ABORTED" });
  assert.equal(writes, 1);
});

test("image text does not change the response language requested by the user", () => {
  const fs = require("node:fs"), vm = require("node:vm");
  const source = fs.readFileSync(require.resolve("../../docs/app.js"), "utf8");
  const context = vm.createContext({ chatImageApi: images, window: { BioDesignSemanticIntent: require("../../shared/semantic-intent.js") } });
  for (const name of ["requestLanguageInstruction", "buildSideChatMessages"]) vm.runInContext(source.match(new RegExp(`^function ${name}\\([\\s\\S]*?^}`, "m"))[0], context);
  const answer = context.buildSideChatMessages("Explain the activity chart", {}, "zh", { text: "Image 1: 中文标签 25 μM" });
  assert.match(answer[0].content, /Answer language for the current request: en/);
  assert.match(answer[0].content, /中文标签 25 μM/);
});
