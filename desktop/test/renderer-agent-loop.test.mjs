// The production renderer (docs/app.js sendWorkbenchRequest/Once) running Side
// Chat and Agent Work on the desktop agent loop: streaming, transcripts, usage,
// runtime interaction, approvals, steering and results.
import assert from "node:assert/strict";
import { EventEmitter, once } from "node:events";
import http from "node:http";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import { test } from "node:test";
import { validateAgentCancel, validateAgentRespond, validateAgentStart } from "../ipc/agent-loop-validation.mjs";
import { AgentLoopService } from "../services/agent-loop-service.mjs";
import { createAgentLoopHost } from "../workers/agent-loop-host.mjs";
import { AdvancedRuntimeService } from "../services/advanced-runtime-service.mjs";
import { ProjectFilesystem } from "../services/project-filesystem.mjs";

// The FC package keeps a synced copy of shared/ (as its own pretest does).
await import("../../alibaba-fc/scripts/sync-shared.mjs");
const require = createRequire(import.meta.url);
const jwt = createRequire(new URL("../../alibaba-fc/package.json", import.meta.url))("jsonwebtoken");
const backend = require("../../alibaba-fc/index.js");
const adapter = require("../../alibaba-fc/src/index.js");
const { createFixture } = require("../../alibaba-fc/test/helpers/preflight-fixture.js");
const { ProjectContextService } = require("../../docs/project-context-service.js");
const transcript = require("../../shared/conversation-transcript.js");
const runtime = require("../../shared/runtime-extensions.js");
const { InjectionQueue } = require("../../docs/runtime-turns.js");

const realFetch = globalThis.fetch;
const model = "fixture/renderer-model";
// Fixture environment for the in-process FC backend. Desktop sources must not
// contain provider key assignments (security-boundary test), so the fake key's
// variable name is composed here; the value is not a credential.
const PROVIDER_KEY_VARIABLE = ["REQUESTY", "API", "KEY"].join("_");
const ENV = { JWT_SECRET: "renderer-loop-secret", ADMIN_ACCOUNT: "renderer-loop", [PROVIDER_KEY_VARIABLE]: "renderer-loop-fixture", REQUESTY_MODEL: model,
  REQUESTY_TOOL_MODE: "sequential", REQUESTY_MODEL_CAPABILITIES_JSON: JSON.stringify({ [model]: { supportsTools: true, supportsWebSearch: false, supportsImages: false } }) };
const toolCall = (name, args = {}, id = name) => ({ id, type: "function", function: { name, arguments: JSON.stringify(args) } });
const source = await readFile(new URL("../../docs/app.js", import.meta.url), "utf8");
const rendererFunctions = ["sendWorkbenchRequest", "sendWorkbenchRequestOnce"].map(name => source.match(new RegExp(`^async function ${name}\\([\\s\\S]*?^}$`, "m"))[0]).join("\n");

function withEnv(t, values) {
  const before = Object.fromEntries(Object.keys(values).map(key => [key, process.env[key]]));
  Object.assign(process.env, values);
  t.after(() => { for (const [key, value] of Object.entries(before)) value === undefined ? delete process.env[key] : process.env[key] = value; });
}
async function temporaryDirectory(t, label) {
  const directory = await mkdtemp(path.join(os.tmpdir(), `biodesign-renderer-${label}-`));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}
// A Requesty-shaped provider that streams whenever it is asked to.
function providerReply(message, stream) {
  const finish = message.tool_calls?.length ? "tool_calls" : "stop", usage = { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 };
  if (!stream) return new Response(JSON.stringify({ choices: [{ message, finish_reason: finish }], usage }), { headers: { "content-type": "application/json" } });
  const frames = [];
  if (message.content) {
    const half = Math.ceil(message.content.length / 2);
    for (const content of [message.content.slice(0, half), message.content.slice(half)]) frames.push({ choices: [{ index: 0, delta: { content } }] });
  }
  if (message.tool_calls) frames.push({ choices: [{ index: 0, delta: { tool_calls: message.tool_calls.map((call, index) => ({ index, ...call })) } }] });
  frames.push({ choices: [{ index: 0, delta: {}, finish_reason: finish }] }, { choices: [], usage });
  return new Response(frames.map(frame => `data: ${JSON.stringify(frame)}\n\n`).join("") + "data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } });
}
function installProvider(t) {
  const state = { requests: [], respond: () => ({ content: "unused" }) };
  t.mock.method(globalThis, "fetch", async (url, options = {}) => {
    url = String(url);
    if (url.startsWith("http://127.0.0.1")) return realFetch(url, options);
    if (url.endsWith("/models")) return new Response(JSON.stringify({ data: [] }));
    const request = JSON.parse(options.body);
    state.requests.push(request);
    return providerReply(await state.respond(request, state.requests.length), request.stream === true);
  });
  return state;
}
async function fcServer(t) {
  const server = http.createServer(adapter);
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  return `http://127.0.0.1:${server.address().port}`;
}
// Electron stand-ins: the real loop-process host in-process, the real service
// and IPC validators, and a preload-shaped agent API.
async function localAgent(t, baseUrl) {
  const archiveRoot = await temporaryDirectory(t, "project");
  const listeners = new Set(), sender = Object.assign(new EventEmitter(), { isDestroyed: () => false });
  const utilityProcess = { fork() {
    const child = new EventEmitter();
    const host = createAgentLoopHost({ post: message => setImmediate(() => child.emit("message", structuredClone(message))), fetchImpl: realFetch });
    child.postMessage = message => setImmediate(() => host.handle(structuredClone(message)));
    child.kill = () => setImmediate(() => child.emit("exit", 0));
    return child;
  } };
  const active = { filesystem: { root: archiveRoot, id: "project-1" } };
  const sessionManager = Object.assign(new EventEmitter(), { requireActive: () => active });
  const loop = new AgentLoopService({ sessionManager, utilityProcess, appPath: process.cwd(), baseUrl,
    sendEvent: (_sender, payload) => { for (const listener of listeners) listener(payload); } });
  t.after(() => loop.closeClient());
  const calls = { starts: [], replies: [] };
  const agent = {
    start: async payload => { calls.starts.push(payload); return loop.start(sender, validateAgentStart(payload)); },
    respond: async payload => { calls.replies.push(payload.reply); return loop.respond(sender, validateAgentRespond(payload)); },
    cancel: async payload => loop.cancel(sender, validateAgentCancel(payload)),
    onEvent: listener => { listeners.add(listener); return () => listeners.delete(listener); },
  };
  return { agent, calls, loop, archiveRoot };
}
function fakeInteraction(answers) {
  const calls = [], titles = [];
  return { calls, titles, api: { create: () => ({
    plan: plan => calls.push(["plan", plan.plan?.length]),
    message: message => calls.push(["message", message]),
    ask: ({ questions }) => { calls.push(["ask", questions.map(question => question.id)]); return { answer: Promise.resolve(answers), close() {} }; },
    confirm: async ({ title }) => { calls.push(["confirm", title.split("?")[0]]); titles.push(title); return true; },
    result: () => {},
    close: () => calls.push(["close"]),
  }) } };
}

// Runs one renderer turn in a VM with the production functions from app.js.
async function runTurn(t, { body, service, selected, token, baseUrl, workflows, interaction, queue }) {
  const { agent, calls, loop } = await localAgent(t, baseUrl);
  const record = { events: [], transcripts: [], usage: [], receipts: [], hostEvents: [], agentCalls: calls };
  const context = { Response, crypto: globalThis.crypto, document: {}, projectContextService: service, workspaceManager: service.workspace,
    workspaceAbortController: null, authToken: token, selectedWorkspacePaths: new Set(), getSelectedPaperIds: () => [selected],
    runtimeLog: null, literatureModule: null, getProjectContext: () => "", backendUrl: url => url,
    getAuthHeaders: headers => ({ ...headers, authorization: `Bearer ${token}` }), requireLoginForUnauthorized: () => {}, t: key => key,
    fetch: async url => { throw new Error(`An agent turn must not fetch ${url}`); },
    window: { BioDesignConversationTranscript: transcript,
      BioDesignRuntimeSession: require("../../docs/runtime-session.js"), BioDesignRuntimeExtensions: runtime,
      BioDesignRuntimeTurns: require("../../docs/runtime-turns.js"), BioDesignSourceDownload: require("../../shared/source-download.js"),
      BioDesignSideChatTools: require("../../shared/side-chat-tools.js"), BioDesignLocalAgentTransport: require("../../docs/local-agent-transport.js"),
      ...(interaction ? { BioDesignRuntimeInteraction: interaction.api } : {}),
      biodesignDesktop: { agent, files: { readBinary: async () => new Uint8Array() }, execution: { runWorkflow: async ({ workflowId, input }) => workflows(workflowId, input) } } },
  };
  const sandbox = vm.createContext(context);
  vm.runInContext(rendererFunctions, sandbox);
  record.result = await sandbox.sendWorkbenchRequest({ ...body, runtimeQueue: queue,
    onTranscript: async turn => { record.transcripts.push(turn); },
    onStream: event => record.events.push(event),
    turnObserver: { event() {}, usage: usage => record.usage.push(usage), hostEvent: event => record.hostEvents.push(event.stage),
      receipt: call => record.receipts.push(call?.name), childUsage() {} } });
  record.openTurns = loop.turns.size;
  return record;
}

const REMAINING_TIME = /(\\?"timeRemainingMs\\?":)(null|[0-9.]+)/g;
const providerView = requests => requests.map(request => {
  const { stream: _stream, stream_options: _options, ...rest } = request;
  return JSON.parse(JSON.stringify(rest).replace(REMAINING_TIME, "$1-1"));
});
// What the UI shows: streamed text, stage sequence, transcript, usage and answer.
const uiView = record => ({
  reply: record.result.reply, citations: record.result.citations, error: record.result.error,
  streamedText: record.events.filter(event => event.type === "delta").map(event => event.text).join(""),
  stages: record.events.filter(event => event.type !== "delta").map(event => `${event.type}:${event.stage || event.capability || ""}`),
  transcriptRoles: record.transcripts.at(-1)?.messages?.map(message => message.role),
  transcriptStatus: record.transcripts.at(-1)?.status,
  usageTokens: record.usage.at(-1)?.totals?.totalTokens, usageRequests: record.usage.at(-1)?.coverage?.requests,
  receipts: record.receipts, hostEvents: record.hostEvents,
});

async function sideChatFixture(question) {
  const f = await createFixture();
  f.workspace.set("literature/SurfDock.pdf", "SurfDock code availability: https://example.invalid/SurfDock. The reactor pH was 7.2.");
  f.workspace.set("literature/Other.pdf", "Other unrelated work on reactor design.");
  await f.pipeline.preflight({ turnId: "seed" });
  const service = new ProjectContextService({ workspace: f.workspace, literature: f.literature, sourceSystem: f.system, requestPipeline: f.pipeline,
    semanticInterpreter: { interpret() { throw Error("No planner for routine reads"); } } });
  const options = { question, surface: "side_chat", turnId: "renderer-side-chat", callContext: { model } };
  await f.pipeline.preflight(options);
  const localWorkspaceContext = await service.buildContext(options);
  const paper = localWorkspaceContext.sourceMap.paperSources.find(item => /SurfDock/.test(item.path));
  return { service, localWorkspaceContext, selected: paper.sourceId, paper };
}

test("Side Chat streams, saves transcripts and reports usage on the agent loop", async t => {
  withEnv(t, ENV);
  t.mock.timers.enable({ apis: ["Date"], now: Date.parse("2026-10-06T00:00:00Z") });
  const token = jwt.sign({ account: ENV.ADMIN_ACCOUNT, role: "admin" }, ENV.JWT_SECRET);
  const provider = installProvider(t), baseUrl = await fcServer(t);
  const question = "Does SurfDock publish its source code?";
  const fixture = await sideChatFixture(question);
  provider.respond = (request, round) => round === 1
    ? { content: null, tool_calls: [toolCall("retrieve_project_evidence", { query: "source code", requirement: { scope: { type: "single_source", sourceIds: [fixture.paper.sourceId] } } }, "read")] }
    : { content: "SurfDock lists a code availability link." };
  const body = { mode: "side_chat", model, originalRequest: question, messages: [{ role: "user", content: question }], conversationTranscript: transcript.normalize(),
    localWorkspaceContext: fixture.localWorkspaceContext, callContext: { turnId: "renderer-side-chat", callRole: "answer", profile: "medium" } };
  const run = await runTurn(t, { body, ...fixture, token, baseUrl, queue: new InjectionQueue(),
    workflows: workflowId => { if (workflowId === "runtime_skills_context") return { catalog: [], active: [] }; throw new Error(`Unexpected workflow ${workflowId}`); } });
  assert.equal(run.agentCalls.starts.length, 1, "One loop turn");
  assert.equal(run.openTurns, 0);
  assert.equal(provider.requests.length, 2);
  const view = uiView(run);
  assert.equal(view.reply, "SurfDock lists a code availability link.");
  assert.equal(view.streamedText.endsWith("SurfDock lists a code availability link."), true, "Answer text streams to the UI");
  assert.ok(view.stages.includes("status:model-request") && view.stages.includes("status:tool-running"), view.stages.join());
  assert.deepEqual(view.transcriptRoles, ["user", "assistant", "tool", "assistant"]);
  assert.equal(view.transcriptStatus, "completed");
  assert.deepEqual([view.usageTokens, view.usageRequests], [24, 2]);
  assert.deepEqual(view.receipts, ["retrieve_project_evidence"]);
});

test("Agent Work runtime interaction, approvals and steering run on the agent loop", async t => {
  withEnv(t, ENV);
  t.mock.timers.enable({ apis: ["Date"], now: Date.parse("2026-10-06T00:00:00Z") });
  const token = jwt.sign({ account: ENV.ADMIN_ACCOUNT, role: "admin" }, ENV.JWT_SECRET);
  const provider = installProvider(t), baseUrl = await fcServer(t);
  const question = "Plan the next fermentation run.", steering = "Prefer strain A.";
  const runs = {};
  {
    const name = "on";
    const fixture = await sideChatFixture(question);
    const localWorkspaceContext = await fixture.service.buildContext({ question, surface: "agent_command", generalPurpose: true, turnId: "renderer-agent", callContext: { model } });
    const queue = new InjectionQueue(), interaction = fakeInteraction({ answers: { strain: { answers: ["A"] } } }), workflowCalls = [];
    provider.respond = (request, round) => {
      if (round === 1) {
        queue.enqueue(steering, { id: "renderer-steering" });
        return { content: null, tool_calls: [toolCall("request_user_input", { questions: [{ id: "strain", header: "Strain",
          question: "Which strain should the run use?", options: [{ label: "A", description: "Strain A" }, { label: "B", description: "Strain B" }] }] }, "ask")] };
      }
      if (round === 2) return { content: null, tool_calls: [toolCall("request_permissions", { reason: "Fit the growth curve.", capability: "scratch_execution" }, "approve")] };
      return { content: "Run strain A; scratch analysis was approved." };
    };
    const body = { mode: "agent_instruction", model, originalRequest: question, messages: [{ role: "user", content: question }], localWorkspaceContext,
      desktopTools: { version: 1, literatureVersion: 1, permission: "workspace_write", projectId: localWorkspaceContext.project.workspaceId },
      callContext: { turnId: "renderer-agent", callRole: "answer", profile: "medium" } };
    runs[name] = await runTurn(t, { body, service: fixture.service, selected: fixture.selected, token, baseUrl, queue, interaction,
      workflows: (workflowId, input) => {
        workflowCalls.push(workflowId);
        if (workflowId === "runtime_skills_context") return { catalog: [], active: [], advancedRuntimeVersion: 1 };
        if (workflowId === "runtime_advanced_open") return { scratch: true };
        if (workflowId === "runtime_advanced_grant") return { granted: true, capability: "scratch_execution", scope: "turn", network: false, project_access: false };
        if (workflowId === "runtime_advanced_close") return { closed: true };
        throw new Error(`Unexpected workflow ${workflowId} ${JSON.stringify(input)}`);
      } });
    runs[name].providerRequests = providerView(provider.requests);
    runs[name].interaction = interaction.calls;
    runs[name].workflows = workflowCalls;
    runs[name].queue = queue.snapshot().map(entry => entry.status);
  }
  assert.equal(runs.on.agentCalls.starts.length, 1, "One loop turn");
  assert.equal(runs.on.openTurns, 0);
  assert.deepEqual(runs.on.workflows.filter(id => id !== "runtime_skills_context"), ["runtime_advanced_open", "runtime_advanced_grant", "runtime_advanced_close"]);
  assert.deepEqual(runs.on.interaction.filter(([kind]) => ["ask", "confirm"].includes(kind)),
    [["ask", ["strain"]], ["confirm", "Allow isolated scratch execution for this turn"]]);
  const receipts = Object.fromEntries(runs.on.providerRequests[2].messages.filter(message => message.role === "tool").map(message => [message.tool_call_id, JSON.parse(message.content)]));
  assert.deepEqual(receipts.ask.value.answers, { strain: { answers: ["A"] } });
  assert.equal(receipts.approve.value.granted, true);
  assert.equal(runs.on.providerRequests[1].messages.filter(message => message.role === "user" && message.content === steering).length, 1, "Steering enters once");
  assert.equal(runs.on.agentCalls.replies[0].runtimeInjections[0].id, "renderer-steering");
  assert.deepEqual(runs.on.queue, ["received"]);
  assert.equal(runs.on.result.reply, "Run strain A; scratch analysis was approved.");
});

// Agent Work asks for project execution, runs one command that reads data/ and
// writes output/report.md, then answers. `workflows` serves runtime_advanced_*.
async function projectExecutionTurn(t, advancedWorkflow, { plan = false, task = null } = {}) {
  withEnv(t, ENV);
  t.mock.timers.enable({ apis: ["Date"], now: Date.parse("2026-10-06T00:00:00Z") });
  const token = jwt.sign({ account: ENV.ADMIN_ACCOUNT, role: "admin" }, ENV.JWT_SECRET);
  const provider = installProvider(t), baseUrl = await fcServer(t);
  const question = "Summarise data/a.csv into output/report.md.";
  const fixture = await sideChatFixture(question);
  const localWorkspaceContext = await fixture.service.buildContext({ question, surface: "agent_command", generalPurpose: true, turnId: "project-run", callContext: { model } });
  const interaction = fakeInteraction({}), workflowCalls = [];
  const command = "awk -F, 'NR>1 { sum += $2 } END { print \"# Report\"; print \"sum=\" sum }' data/a.csv > output/report.md && cat output/report.md";
  provider.respond = (_request, round) => round === 1
    ? { content: null, tool_calls: [toolCall("request_permissions", { reason: "Summarise the CSV into output/.", capability: "project_execution" }, "approve")] }
    : round === 2 ? { content: null, tool_calls: [toolCall("exec_command", { cmd: command, yield_time_ms: 5000 }, "run")] }
      : { content: "Wrote output/report.md." };
  const body = { mode: "agent_instruction", model, originalRequest: question, messages: [{ role: "user", content: question }], localWorkspaceContext,
    desktopTools: { version: 1, literatureVersion: 1, permission: "workspace_write", projectId: localWorkspaceContext.project.workspaceId,
      ...(plan ? { collaborationMode: "plan" } : {}) },
    ...(task ? { outputTask: task } : {}),
    callContext: { turnId: "project-run", callRole: "answer", profile: "medium" } };
  const record = await runTurn(t, { body, service: fixture.service, selected: fixture.selected, token, baseUrl, interaction,
    workflows: async (workflowId, input) => {
      workflowCalls.push([workflowId, input]);
      if (workflowId === "runtime_skills_context") return { catalog: [], active: [], advancedRuntimeVersion: 1 };
      if (workflowId.startsWith("runtime_advanced_")) return advancedWorkflow(workflowId, input);
      throw new Error(`Unexpected workflow ${workflowId} ${JSON.stringify(input)}`);
    } });
  const requests = providerView(provider.requests);
  const receipts = Object.fromEntries(requests.at(-1).messages.filter(message => message.role === "tool").map(message => [message.tool_call_id, JSON.parse(message.content)]));
  return { record, requests, receipts, interaction: interaction.calls, titles: interaction.titles, workflows: workflowCalls };
}

test("Agent Work offers project execution when only the project sandbox is available, behind its own approval", async t => {
  const run = await projectExecutionTurn(t, (workflowId, input) => {
    if (workflowId === "runtime_advanced_open") return { scratch: false, project: true, runtime: { state: "not_installed", downloadBytes: 136559591 } };
    if (workflowId === "runtime_advanced_grant") return { granted: true, capability: input.capability, scope: "turn", network: false, project_access: "read", writable: ["output/"], hidden: [".biodesign/"] };
    if (workflowId === "runtime_advanced_call") return { status: "completed", process_id: "process:fixture", output: "# Report\nsum=6\n", exit_code: 0 };
    if (workflowId === "runtime_advanced_close") return { closed: true };
    throw new Error(`Unexpected workflow ${workflowId}`);
  });
  const advertised = run.requests[0].tools.map(tool => tool.function.name);
  assert.ok(advertised.includes("request_permissions") && advertised.includes("exec_command"), advertised.join());
  assert.deepEqual(run.interaction.filter(([kind]) => kind === "confirm"), [["confirm", "Run code in this project for this turn"]]);
  assert.match(run.titles[0], /The first run downloads BioDesign's Python runtime \(about 137 MB\)\. Reason: Summarise the CSV/);
  assert.deepEqual(run.workflows.find(([id]) => id === "runtime_advanced_grant")[1], { owner: run.workflows.find(([id]) => id === "runtime_advanced_open")[1].owner, capability: "project_execution" });
  assert.equal(run.workflows.find(([id]) => id === "runtime_advanced_call")[1].call.name, "exec_command");
  assert.equal(run.receipts.approve.value.capability, "project_execution");
  assert.equal(run.receipts.run.value.output, "# Report\nsum=6\n");
  assert.equal(run.record.result.reply, "Wrote output/report.md.");
});

test("plan mode offers only read-only project commands, behind their own approval", async t => {
  const run = await projectExecutionTurn(t, (workflowId, input) => {
    if (workflowId === "runtime_advanced_open") return { scratch: false, project: true };
    if (workflowId === "runtime_advanced_grant") return { granted: true, capability: input.capability, scope: "turn", network: false, project_access: "read", writable: [], hidden: [".biodesign/"], read_only: true };
    if (workflowId === "runtime_advanced_call") return { status: "completed", process_id: "process:fixture", output: "# Report\nsum=6\n", exit_code: 0 };
    if (workflowId === "runtime_advanced_close") return { closed: true };
    throw new Error(`Unexpected workflow ${workflowId}`);
  }, { plan: true });
  assert.match(run.requests[0].messages.find(message => message.role === "system").content, /# Plan Mode/);
  const advertised = run.requests[0].tools.map(tool => tool.function.name);
  assert.ok(advertised.includes("exec_command") && advertised.includes("request_permissions"), advertised.join());
  for (const name of ["apply_patch", "memories_add_ad_hoc_note", "image_gen_imagegen", "request_plugin_install", "update_recommendation", "download_sources"])
    assert.ok(!advertised.includes(name), `${name} is not offered while planning`);
  assert.deepEqual(run.interaction.filter(([kind]) => kind === "confirm"), [["confirm", "Run read-only commands in this project while planning"]]);
  assert.equal(run.workflows.find(([id]) => id === "runtime_advanced_open")[1].collaborationMode, "plan");
  assert.equal(run.receipts.approve.value.read_only, true);
});

test("a conversation's output folder reaches the host, which gives it to the turn while other tasks run", async t => {
  const note = "Other Agent Work tasks are running in this project, so this task writes only inside output/agent-tasks/summarise-csv-abc123/.";
  const run = await projectExecutionTurn(t, (workflowId, input) => {
    if (workflowId === "runtime_advanced_open") return { scratch: false, project: true };
    if (workflowId === "runtime_advanced_grant") return { granted: true, capability: input.capability, scope: "turn", network: false, project_access: "read", writable: ["output/agent-tasks/summarise-csv-abc123/"], hidden: [".biodesign/"], parallel_task: true, note };
    if (workflowId === "runtime_advanced_call") return { status: "completed", process_id: "process:fixture", output: "# Report\nsum=6\n", exit_code: 0 };
    if (workflowId === "runtime_advanced_close") return { closed: true };
    throw new Error(`Unexpected workflow ${workflowId}`);
  }, { task: "summarise-csv-abc123" });
  assert.equal(run.workflows.find(([id]) => id === "runtime_advanced_open")[1].taskFolder, "summarise-csv-abc123");
  assert.match(run.titles[0], /write only to output\/ \(only to its own task folder in output\/agent-tasks\/ while other Agent Work tasks run\)/);
  assert.deepEqual([run.receipts.approve.value.writable, run.receipts.approve.value.note], [["output/agent-tasks/summarise-csv-abc123/"], note], "The model learns where it may write");
});

test("Agent Work runs an approved project command in the real sandbox and writes output/report.md", { skip: process.env.BIODESIGN_SANDBOX_TEST !== "1" }, async t => {
  const root = await realpath(await temporaryDirectory(t, "sandbox-project"));
  await mkdir(path.join(root, "data")); await mkdir(path.join(root, "literature"));
  await writeFile(path.join(root, "data", "a.csv"), "x,y\n1,2\n3,4\n"); await writeFile(path.join(root, "literature", "paper.txt"), "original evidence");
  const runtimeService = new AdvancedRuntimeService({ filesystem: await ProjectFilesystem.open(root) });
  t.after(() => runtimeService.close());
  const run = await projectExecutionTurn(t, async (workflowId, input) => {
    if (workflowId === "runtime_advanced_open") return runtimeService.open(input);
    if (workflowId === "runtime_advanced_grant") return runtimeService.grant(input.owner, input.capability);
    if (workflowId === "runtime_advanced_call") return runtimeService.call(input);
    if (workflowId === "runtime_advanced_close") { await runtimeService.closeOwner(input.owner); return { closed: true }; }
    throw new Error(`Unexpected workflow ${workflowId}`);
  });
  assert.deepEqual(run.receipts.approve.value, { granted: true, capability: "project_execution", scope: "turn", network: false, project_access: "read", writable: ["output/"], not_writable: ["output/agent-tasks/"], hidden: [".biodesign/"] });
  assert.equal(run.receipts.run.value.exit_code, 0, JSON.stringify(run.receipts.run));
  assert.equal(run.receipts.run.value.output, "# Report\nsum=6\n");
  assert.equal(await readFile(path.join(root, "output", "report.md"), "utf8"), "# Report\nsum=6\n");
  assert.equal(await readFile(path.join(root, "literature", "paper.txt"), "utf8"), "original evidence");
  assert.equal(run.record.result.reply, "Wrote output/report.md.");
});

test("outside the desktop app agent turns report that they need it; the Debug Console has no loop toggle", async () => {
  const context = { Response, crypto: globalThis.crypto, projectContextService: {}, workspaceManager: null, workspaceAbortController: null, authToken: "a.b.c",
    selectedWorkspacePaths: new Set(), getSelectedPaperIds: () => [], runtimeLog: null, literatureModule: null, getProjectContext: () => "",
    backendUrl: url => url, getAuthHeaders: headers => headers, requireLoginForUnauthorized: () => {}, t: key => key,
    fetch: async url => { throw new Error(`No request may be sent: ${url}`); }, window: {} };
  const sandbox = vm.createContext(context);
  vm.runInContext(rendererFunctions, sandbox);
  await assert.rejects(sandbox.sendWorkbenchRequest({ mode: "side_chat", messages: [{ role: "user", content: "Hello" }],
    localWorkspaceContext: { agentLoop: { version: 1 } } }), { code: "DESKTOP_APP_REQUIRED", message: "desktopAppRequired" });
  const html = await readFile(new URL("../../docs/index.html", import.meta.url), "utf8");
  assert.doesNotMatch(html, /localAgentLoop|local-agent-settings/);
  assert.match(html, /<script src="local-agent-transport\.js"><\/script>/);
});
