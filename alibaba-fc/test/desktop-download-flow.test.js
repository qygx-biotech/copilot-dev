"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), vm = require("node:vm");
const { readFile, mkdtemp, rm } = require("node:fs/promises");
const path = require("node:path"), os = require("node:os");
const webSearch = require("../../shared/web-search.js"), sourceDownload = require("../../shared/source-download.js"), eventStream = require("../../shared/event-stream.js");
const jwt = require("jsonwebtoken"), backend = require("../index.js");

test("production renderer handoff executes the desktop workflow and resumes the same FC agent", async t => {
  const { ProjectFilesystem } = await import("../../desktop/services/project-filesystem.mjs");
  const { downloadSources } = await import("../../desktop/services/source-downloader.mjs");
  const root = await mkdtemp(path.join(os.tmpdir(), "biodesign-download-flow-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const filesystem = await ProjectFilesystem.open(root);
  const model = "google/gemini-3.1-flash-lite:flex";
  const env = { JWT_SECRET: "flow-test-secret", ADMIN_ACCOUNT: "flow-test", REQUESTY_API_KEY: "flow-provider-fixture", REQUESTY_MODEL: "flow/model", REQUESTY_TOOL_MODE: "sequential",
    REQUESTY_MODEL_CAPABILITIES_JSON: JSON.stringify({ [model]: { supportsWebSearch: true } }) };
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
  const app = await readFile(path.resolve(__dirname, "../../docs/app.js"), "utf8");
  const functions = ["sendWorkbenchRequest", "sendWorkbenchRequestOnce"].map(name => app.match(new RegExp(`^async function ${name}\\([\\s\\S]*?^}$`, "m"))[0]).join("\n");
  const workspace = { workspace: { workspaceId: "project-1" } };
  const sandbox = vm.createContext({
    Response, projectContextService: null, workspaceManager: workspace, workspaceAbortController: null, authToken: token,
    experimentModuleCards: [], referenceDocuments: [], activeSideChatDocumentKeys: [], MAX_BROWSER_REFERENCE_FILES: 1, TOTAL_REFERENCE_TEXT_LIMIT: 100,
    runtimeLog: null, literatureModule: null, buildExperimentModulesForRequest: () => ({}), buildFlattenedExperimentDocumentsForRequest: () => [],
    collectExperimentNotesForRequest: () => [], collectSelectedStoredDocumentKeys: () => [], collectStoredDocumentsForRequest: () => [],
    buildDocumentsForRequest: () => [], getProjectContext: () => "", backendUrl: path => path, getAuthHeaders: headers => ({ ...headers, authorization: `Bearer ${token}` }),
    requireLoginForUnauthorized: () => {}, t: key => key,
    fetch: async (route, options) => {
      hostRequests.push(JSON.parse(options.body));
      const response = await backend.handler({ httpMethod: "POST", path: route, headers: options.headers, body: options.body }, {});
      return new Response(response.body, { status: response.statusCode, headers: response.headers });
    },
    window: { BioDesignSourceDownload: sourceDownload, BioDesignWebSearch: webSearch, BioDesignEventStream: eventStream,
      biodesignDesktop: { execution: { runWorkflow: async ({ workflowId, input }) => {
        assert.equal(workflowId, "download_sources");
        return downloadSources(input, { filesystem }, { localFetch: async () => { downloads++; return { bytes: pdf, contentType: "application/pdf", resolvedUrl: sourceUrl }; } });
      } } } },
  });
  vm.runInContext(functions, sandbox);
  const result = await sandbox.sendWorkbenchRequest({ mode: "agent_instruction", model, messages: [{ role: "user", content: "Search EctD and download the relevant PDF" }],
    localWorkspaceContext: { project: { workspaceId: "project-1" }, semantic: { ir: { ...require("../../shared/semantic-intent.js").interpretLocal({ query: "Search EctD and download the relevant PDF" }), retrievalScope: "web" } } },
    desktopTools: { version: 1, permission: "workspace_write", projectId: "project-1" }, callContext: { turnId: "flow-turn", callRole: "answer", profile: "medium" } });
  assert.equal(downloads, 1); assert.equal(hostRequests.length, 2); assert.equal(providerRequests.length, 4);
  assert.ok(hostRequests.every(request => request.model === model));
  assert.ok(providerRequests.every(request => request.model === model));
  assert.ok(result.reply.includes("literature/ectd.pdf")); assert.equal(result.webSearchSources[0].url, sourceUrl);
  assert.deepEqual(Buffer.from(await filesystem.readBinary("literature/ectd.pdf")), pdf);
  assert.ok(providerRequests[2].messages.some(message => message.role === "tool" && message.content.includes("downloaded")));
  assert.ok(providerRequests[3].messages.some(message => message.role === "tool" && message.name === "list_papers"));
  assert.ok(hostRequests[1].desktopContinuation); assert.equal(hostRequests[1].desktopToolResults[0].results[0].status, "downloaded");
  assert.ok(!JSON.stringify(providerRequests).includes(token));
  assert.ok(!JSON.stringify(hostRequests).includes(pdf.toString("base64")));
});
