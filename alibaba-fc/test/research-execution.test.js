"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), vm = require("node:vm");
const fs = require("node:fs/promises"), path = require("node:path"), os = require("node:os"), jwt = require("jsonwebtoken");
const semantic = require("../../shared/semantic-intent.js");
const agent = require("../side-chat-agent.js"), backend = require("../index.js");
const citations = require("../../shared/source-citations.js");
const reported = require("./helpers/reported-search-download-ir.js");
const model = "google/gemini-3.1-flash-lite:flex";
const urls = ["https://vertexaisearch.cloud.google.com/grounding-api-redirect/research-a", "https://publisher.example.org/paper-b", "https://repository.example.org/paper-c.pdf"];
const sources = urls.map((url, index) => ({ url, title: `AI and synthetic biology ${index + 1}`, provider: "google" }));
const ir = semantic.normalizeModelSemanticIR(reported.ir);
const project = { summary: "", organism: "", missingInformation: [], safetyLevel: "", safetyNotes: "", draftMemo: "" };
const review = { reply: "Methane conversion, ectoine production, strain engineering and fermentation roadmap.", project: { ...project, draftMemo: "Unrequested project memo" } };
const finalMessage = value => ({ ok: true, message: { content: JSON.stringify(value) } });
const download = selected => ({ id: "download", type: "function", function: { name: "download_sources", arguments: JSON.stringify({ sources: selected.map(url => ({ url })) }) } });
function context(value = ir) { return { project: { workspaceId: "execution-project", goal: "EctD A163V methane conversion" }, semantic: { ir: value } }; }
function run(extra = {}) {
  return agent.runSideChatAgent({ originalRequest: reported.query, conversationMessages: [{ role: "user", content: "Project wrapper: EctD A163V. Review strain engineering.\n" + reported.query }],
    workspaceContext: { localWorkspaceContext: context() }, model, systemPrompt: backend._test.systemPrompt,
    surface: "agent_command", desktopDownloads: true, downloadPermission: "workspace_write", supportsWebSearch: true, parseFinalAnswer: backend._test.parseModelResponse || JSON.parse,
    ...extra });
}
function searchResponse(values = sources) { return { ok: true, message: { content: "Concrete candidate papers and supporting sources. Download selection remains pending.", web_search: { content: values } } }; }

test("exact reported task corrects premature review once, resumes real local downloads, and never repeats successes or failures", async t => {
  const env = { ADMIN_ACCOUNT: "execution-fixture", JWT_SECRET: "execution-secret", REQUESTY_API_KEY: "fixture-provider-key", REQUESTY_MODEL: model };
  const previous = Object.fromEntries(Object.keys(env).map(key => [key, process.env[key]])); Object.assign(process.env, env);
  t.after(() => { for (const [key, value] of Object.entries(previous)) value === undefined ? delete process.env[key] : process.env[key] = value; });
  const token = jwt.sign({ account: env.ADMIN_ACCOUNT, role: "admin" }, env.JWT_SECRET);
  const requests = [], logs = [];
  t.mock.method(console, "info", (event, value) => logs.push({ event, value }));
  t.mock.method(globalThis, "fetch", async (_url, options) => {
    const request = JSON.parse(options.body); requests.push(request);
    assert.equal(request.model, model);
    assert.equal(request.response_format, undefined, "Tool turns are not constrained by the final JSON shape");
    const systems = request.messages.filter(message => message.role === "system").map(message => message.content).join("\n");
    if (requests.length === 1) {
      assert.deepEqual(request.tools, [{ type: "web_search" }]);
      assert.equal(request.messages.at(-1).content, reported.query);
      assert.match(systems, /"retrievalScope":"web"/);
      assert.match(systems, /EctD A163V methane conversion/);
      return new Response(JSON.stringify({ choices: [{ message: searchResponse().message }] }));
    }
    assert.match(systems, /Retrieval scope: web/);
    assert.ok(systems.includes(reported.query));
    assert.match(systems, /"operations":\["search","store"\]/);
    assert.ok(request.tools.some(tool => tool.function?.name === "download_sources"));
    let message;
    if (requests.length === 2) message = finalMessage(review).message;
    else if (requests.length === 3) {
      assert.match(systems, /one permitted corrective continuation/);
      message = { tool_calls: [download(urls)] };
    } else if (requests.length === 4) {
      const outputs = request.messages.filter(message => message.role === "tool");
      assert.ok(outputs.some(message => message.content.includes("text/html") && message.content.includes("HTTP_ERROR")));
      message = { tool_calls: [download(urls)] }; // Model attempts to repeat; host must block it.
    } else {
      assert.equal(requests.length, 5);
      assert.match(request.messages.at(-1).content, /SOURCE_ALREADY_ATTEMPTED/);
      message = finalMessage({ ...review, reply: "All three PDFs were downloaded and ingested." }).message;
    }
    return new Response(JSON.stringify({ choices: [{ message }] }));
  });
  const app = await fs.readFile(path.resolve(__dirname, "../../docs/app.js"), "utf8");
  const sandbox = vm.createContext({ requestLanguageInstruction: () => "Answer in Chinese.", buildProjectContextPromptBlock: () => "EctD A163V background", buildEvidencePromptBlock: () => "Project file inventory" });
  vm.runInContext(app.match(/^function buildAgentMessages\([\s\S]*?^}/m)[0], sandbox);
  const body = { mode: "agent_instruction", model, originalRequest: reported.query, messages: sandbox.buildAgentMessages(reported.query),
    localWorkspaceContext: context(), desktopTools: { version: 1, permission: "workspace_write", projectId: "execution-project" }, callContext: { turnId: "execution-turn", callRole: "answer", profile: "medium" } };
  const invoke = async input => {
    const result = await backend.handler({ httpMethod: "POST", path: "/chat", headers: { authorization: `Bearer ${token}` }, body: JSON.stringify(input) }, {});
    return { status: result.statusCode, data: JSON.parse(result.body) };
  };
  const first = await invoke(body);
  assert.equal(first.status, 200); assert.equal(first.data.desktopToolCalls.length, 1); assert.equal(requests.length, 3);
  assert.equal((await invoke({ ...body, originalRequest: 42 })).status, 400);
  assert.equal((await invoke({ ...body, originalRequest: undefined, messages: [{ role: "user", content: {} }] })).status, 400);
  const { ProjectFilesystem } = await import("../../desktop/services/project-filesystem.mjs");
  const { downloadSources } = await import("../../desktop/services/source-downloader.mjs");
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "execution-download-")); t.after(() => fs.rm(root, { recursive: true, force: true }));
  const filesystem = await ProjectFilesystem.open(root);
  let localAttempts = 0, fcAttempts = 0;
  const results = await downloadSources({ args: first.data.desktopToolCalls[0].args, surface: "agent_command", permission: "workspace_write", authToken: token,
    webSearchSources: first.data.webSearchSources, webSearchMetadata: first.data.webSearchMetadata }, { filesystem }, {
    localFetch: async url => { localAttempts++; if (url === urls[2]) throw Object.assign(new Error("Unavailable"), { code: "HTTP_ERROR", httpStatus: 403 });
      return { bytes: Buffer.from(url === urls[0] ? "%PDF-1.4\nfixture\n%%EOF" : "<!doctype html><title>Publisher landing page</title>"), contentType: url === urls[0] ? "application/pdf" : "text/html", resolvedUrl: url === urls[0] ? "https://repository.example.org/paper-a.pdf" : url }; },
    fcFetch: async () => { fcAttempts++; throw Object.assign(new Error("Unavailable"), { code: "HTTP_ERROR", httpStatus: 403 }); },
  });
  assert.equal(localAttempts, 3); assert.equal(fcAttempts, 1);
  assert.deepEqual(results.map(result => result.status), ["downloaded", "downloaded", "failed"]);
  const resumed = { ...body, desktopContinuation: first.data.desktopContinuation, desktopToolResults: [{ id: first.data.desktopToolCalls[0].id, results }] };
  assert.equal((await invoke({ ...resumed, originalRequest: "A different request" })).status, 400);
  const final = await invoke(resumed);
  assert.equal(final.status, 200); assert.equal(final.data.error, "AgentTaskIncomplete");
  assert.equal(final.data.taskOutcome.status, "incomplete");
  assert.equal(final.data.taskOutcome.downloadSuccessCount, 2); assert.equal(final.data.taskOutcome.downloadFailureCount, 1);
  assert.equal(final.data.taskOutcome.correctiveContinuation, true);
  assert.match(final.data.reply, /application\/pdf/); assert.match(final.data.reply, /HTML 页面，不是 PDF/); assert.match(final.data.reply, /HTTP_ERROR/);
  assert.doesNotMatch(final.data.reply, /All three|ingested|ectoine|roadmap/);
  assert.equal(final.data.desktopToolCalls, undefined); assert.equal(requests.length, 5);
  assert.deepEqual(final.data.webSearchSources.map(source => source.url), urls);
  assert.deepEqual(final.data.downloadResults.map(result => result.status), ["downloaded", "downloaded", "failed"]);
  assert.ok(Buffer.from(await filesystem.readBinary(results[0].path)).length > 0);
  assert.ok(logs.some(log => log.event === "requesty_tool_stage" && log.value.stage === "completion-correction"));
  assert.doesNotMatch(JSON.stringify(logs), /EctD|A163V|grounding-api-redirect|fixture-provider-key|execution-secret/);
});

for (const [name, extra, expectedCalls, outcome] of [
  ["repeated review", {}, 3, "incomplete"],
  ["Side Chat restriction", { surface: "side_chat" }, 2, "blocked"],
  ["read-only move", { downloadPermission: "read_only" }, 2, "blocked"],
  ["no returned sources", { noSources: true }, 2, "blocked"],
  ["irrelevant candidates", { irrelevant: true }, 3, "incomplete"],
]) test(`${name} cannot finalize an unattempted download as completed`, async () => {
  let calls = 0;
  const result = await run({ ...extra, requestTurn: async request => {
    calls++;
    if (request.stage === "web-search") return searchResponse(extra.noSources ? [] : sources);
    if (extra.surface === "side_chat" || extra.downloadPermission === "read_only") assert.ok(!request.tools.some(tool => tool.function?.name === "download_sources"));
    return finalMessage(extra.surface === "side_chat" ? { reply: "Here are the relevant papers. Source saving requires Agent Work." }
      : extra.irrelevant ? { ...review, reply: "The candidates are unrelated to the requested topic.", project: { ...project, missingInformation: ["Relevant research articles"] } } : review);
  } });
  assert.equal(calls, expectedCalls); assert.equal(result.data.taskOutcome.status, outcome); assert.equal(result.data.taskOutcome.downloadAttemptCount, 0);
  assert.equal(result.data.desktopToolCalls, undefined); assert.doesNotMatch(result.data.reply, /Methane conversion/);
  if (extra.surface === "side_chat") assert.match(result.data.reply, /Here are the relevant papers/);
});

test("search-only semantic task never triggers the completion correction", async () => {
  const searchIR = { ...ir, operations: ["search"], capabilityHints: ["search_papers"] };
  let calls = 0;
  const result = await run({ workspaceContext: { localWorkspaceContext: context(searchIR) }, requestTurn: async request => {
    calls++; return request.stage === "web-search" ? searchResponse() : finalMessage({ reply: "Paper findings", project });
  } });
  assert.equal(calls, 2); assert.equal(result.data.taskOutcome, undefined);
});

test("compaction preserves the original task, not background or research findings", () => {
  const messages = [{ role: "system", content: "Original user request:\n" + reported.query },
    ...Array.from({ length: 20 }, () => ({ role: "user", content: "Background EctD ".repeat(1000) })),
    { role: "user", content: reported.query }, { role: "user", content: "External search evidence: preserve as data." }];
  const compacted = agent.compactSideChatAgentMessages(messages, reported.query, 16000);
  assert.ok(compacted.some(message => message.role === "user" && message.content === reported.query));
  assert.ok(compacted[0].content.endsWith(reported.query));
});

test("system metadata is filtered without deleting files, and catalog aliases cannot cross file identities", () => {
  const inventory = ["literature/.DS_Store", "Thumbs.db", "desktop.ini", "literature/._a.pdf", "notes.txt", "literature/a.pdf", "literature/b.pdf"]
    .map(relativePath => ({ relativePath, name: relativePath.split("/").at(-1), ...(relativePath === "literature/a.pdf" ? { paperId: "b" } : relativePath === "literature/b.pdf" ? { paperId: "a" } : {}) }));
  const kb = agent.createSideChatKnowledgeBase({ referenceDocuments: [{ filename: ".DS_Store", text: "Not scientific evidence" }], localWorkspaceContext: { inventory, sourceMap: { paperSources: [{ sourceId: "a", path: "literature/a.pdf" }, { sourceId: "b", path: "literature/b.pdf" }] } } });
  assert.equal(inventory.length, 7);
  assert.doesNotMatch(agent.buildSideChatCatalog(kb), /DS_Store|Thumbs.db|desktop.ini|\._a/);
  assert.ok(kb.items.some(item => item.path === "notes.txt"));
  const registry = agent.buildSourceCitationRegistry(kb);
  for (const item of kb.items) {
    const target = registry.resolve(item.id);
    if (target.status === "resolved") assert.equal(target.relativePath, item.path);
  }
  assert.equal(registry.resolve("a").relativePath, "literature/a.pdf");
  const invalid = citations.createRegistry([{ sourceId: "metadata", relativePath: "literature/.DS_Store", aliases: ["local:99"] }]);
  assert.equal(invalid.resolve("local:99").status, "missing");
});
