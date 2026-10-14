"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const { mkdtemp, rm } = require("node:fs/promises");
const path = require("node:path"), os = require("node:os");
const sourceDownload = require("../../shared/source-download.js");
const jwt = require("jsonwebtoken"), agentChat = require("./helpers/agent-chat.js");

// Agent Work without the literature contract offers download_sources; the host
// runs the desktop download workflow at the boundary and the same turn resumes.
test("a download handoff executes the desktop workflow and resumes the same agent turn", async t => {
  const { ProjectFilesystem } = await import("../../desktop/services/project-filesystem.mjs");
  const { downloadSources } = await import("../../desktop/services/source-downloader.mjs");
  const root = await mkdtemp(path.join(os.tmpdir(), "biodesign-download-flow-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const filesystem = await ProjectFilesystem.open(root);
  const model = "google/gemini-3.1-flash-lite:flex";
  const env = { JWT_SECRET: "flow-test-secret", ADMIN_ACCOUNT: "flow-test", REQUESTY_API_KEY: "flow-provider-fixture", REQUESTY_MODEL: "flow/model", REQUESTY_TOOL_MODE: "sequential",
    REQUESTY_MODEL_CAPABILITIES_JSON: JSON.stringify({ [model]: { supportsWebSearch: true, supportsTools: true } }) };
  const previous = Object.fromEntries(Object.keys(env).map(key => [key, process.env[key]]));
  Object.assign(process.env, env);
  t.after(() => { for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } });
  const token = jwt.sign({ account: env.ADMIN_ACCOUNT, role: "admin" }, env.JWT_SECRET);
  const sourceUrl = "https://papers.example.org/ectd.pdf", pdf = Buffer.from("%PDF-1.7\nfixture");
  const providerRequests = [], hostRequests = []; let downloads = 0;
  t.mock.method(globalThis, "fetch", async (_url, options) => {
    const request = JSON.parse(options.body); providerRequests.push(request);
    assert.equal(request.toolConfig, undefined);
    if (providerRequests.length === 1) assert.deepEqual(request.tools, [{ type: "web_search" }]);
    else assert.ok(request.tools.every(tool => tool.type === "function"));
    const message = providerRequests.length === 1
      ? { content: "Found relevant paper", web_search: { content: [{ url: sourceUrl, title: "EctD" }] } }
      : providerRequests.length === 2
      ? { content: null, tool_calls: [{ id: "save-paper", type: "function", function: { name: "download_sources", arguments: JSON.stringify({ sources: [{ url: sourceUrl }] }) } }] }
      : providerRequests.length === 3
      ? { content: null, tool_calls: [{ id: "list-local", type: "function", function: { name: "list_papers", arguments: "{}" } }] }
      : { content: JSON.stringify({ reply: "The paper is saved in literature/ectd.pdf.", project: { summary: "Saved source", organism: "Unknown", missingInformation: [], safetyLevel: "Review", safetyNotes: "Review", draftMemo: "Saved source" } }) };
    return new Response(JSON.stringify({ choices: [{ message, finish_reason: "stop" }] }));
  });
  const body = { mode: "agent_instruction", model, messages: [{ role: "user", content: "Search EctD and download the relevant PDF" }],
    localWorkspaceContext: { project: { workspaceId: "project-1" }, semantic: { ir: { ...require("../../shared/semantic-intent.js").interpretLocal({ query: "Search EctD and download the relevant PDF" }), retrievalScope: "web" } } },
    desktopTools: { version: 1, permission: "workspace_write", projectId: "project-1" }, callContext: { turnId: "flow-turn", callRole: "answer", profile: "medium" } };
  const send = async input => { hostRequests.push(input); return JSON.parse((await agentChat.post(input, token)).body); };
  const handoff = await send(body);
  assert.deepEqual(handoff.desktopToolCalls.map(call => call.name), ["download_sources"]);
  // As the renderer runs it: validated input, the session token, and the turn's search sources.
  const results = await Promise.all(handoff.desktopToolCalls.map(async call => ({ id: call.id, results: await downloadSources({
    args: sourceDownload.validateInput(call.args), surface: "agent_command", permission: "workspace_write", authToken: token,
    webSearchSources: handoff.webSearchSources || [], webSearchMetadata: handoff.webSearchMetadata || [] }, { filesystem },
  { localFetch: async () => { downloads++; return { bytes: pdf, contentType: "application/pdf", resolvedUrl: sourceUrl }; } }) })));
  const result = await send({ boundary: handoff.boundary, desktopToolResults: results });
  assert.equal(downloads, 1); assert.equal(hostRequests.length, 2); assert.equal(providerRequests.length, 4);
  assert.ok(providerRequests.every(request => request.model === model));
  assert.ok(result.reply.includes("literature/ectd.pdf")); assert.equal(result.webSearchSources[0].url, sourceUrl);
  assert.deepEqual(Buffer.from(await filesystem.readBinary("literature/ectd.pdf")), pdf);
  assert.ok(providerRequests[2].messages.some(message => message.role === "tool" && message.content.includes("downloaded")));
  assert.ok(providerRequests[3].messages.some(message => message.role === "tool" && message.name === "list_papers"));
  assert.equal(hostRequests[1].desktopToolResults[0].results[0].status, "downloaded");
  assert.ok(!JSON.stringify(providerRequests).includes(token));
  assert.ok(!JSON.stringify(hostRequests).includes(pdf.toString("base64")));
});
