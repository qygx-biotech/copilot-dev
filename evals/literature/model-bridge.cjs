'use strict';
// Model-in-the-loop end-to-end check. Everything is production code except the
// model: the renderer turn functions, the desktop agent loop, the FC model proxy,
// the literature host, the bundled paper MCP, real open-access services and a
// real Chrome (headless unless HEADED=1). Each model request is queued on a
// loopback HTTP bridge where an external agent (a person, a script, or a coding
// agent standing in for the model) reads it with GET /pending and answers with
// POST /respond: {"content": "..."} or {"tool_calls": [{"name": "...", "arguments": {...}}]}.
//
//   QUERY="Find 3 recent papers on … and download them." node evals/literature/model-bridge.cjs
//   Options: BRIDGE_PORT, BRIDGE_LOG, LIBRARY='{"url":"…","proxy":"…login?url="}', WAIT_MODE=skip|continue, HEADED=1
const ROOT = require('node:path').resolve(__dirname, '../..');
const path = require('node:path'), os = require('node:os'), fs = require('node:fs'), http = require('node:http');
const { mkdtemp, rm } = require('node:fs/promises');
process.chdir(path.join(ROOT, 'alibaba-fc'));
const jwt = require(path.join(ROOT, 'alibaba-fc/node_modules/jsonwebtoken'));
const literature = require(path.join(ROOT, 'shared/literature-agent.js'));
const { demandFixture } = require(path.join(ROOT, 'alibaba-fc/test/helpers/demand-context-fixture.js'));

const PORT = Number(process.env.BRIDGE_PORT || 47831);
const QUERY = process.env.QUERY || 'Find 3 recent papers on machine-learning-guided enzyme engineering (thermostability or activity) and download them into the project.';
const LOG = process.env.BRIDGE_LOG || path.join(os.tmpdir(), 'literature-model-bridge.jsonl');
const model = 'bridge/haiku-stand-in';
const log = entry => fs.appendFileSync(LOG, JSON.stringify({ at: new Date().toISOString(), ...entry }) + '\n');

// ---------------- model bridge ----------------
let pending = null, waiters = [], sequence = 0, finished = null;
const notify = () => { for (const waiter of waiters.splice(0)) waiter(); };
const clip = (text, max) => (text = String(text ?? '')).length > max ? `${text.slice(0, max)}\n…[${text.length - max} more characters]` : text;
function view(request) {
  const specialist = !request.tools.some(tool => tool.function?.name === 'discover_papers' || tool.function?.name === 'retrieve_papers');
  const system = request.messages.filter(m => m.role === 'system').map(m => typeof m.content === 'string' ? m.content : JSON.stringify(m.content));
  // The literature instructions matter most; long generic prompts are clipped.
  const key = system.filter(text => /discover_papers|retrieve_papers|literature|retrieval|library|Papers still without/i.test(text)).map(text => clip(text, 2500));
  const conversation = request.messages.filter(m => m.role !== 'system').map(m => ({ role: m.role,
    ...(m.tool_call_id ? { tool_call_id: m.tool_call_id } : {}),
    ...(m.tool_calls ? { tool_calls: m.tool_calls.map(c => ({ id: c.id, name: c.function.name, arguments: clip(c.function.arguments, 1500) })) } : {}),
    content: clip(typeof m.content === 'string' ? m.content : JSON.stringify(m.content), m.role === 'tool' ? 9000 : 3000) }));
  const tools = request.tools.filter(t => t.function).map(t => ({ name: t.function.name, description: clip(t.function.description, 600),
    parameters: ['discover_papers', 'retrieve_papers', 'search_academic_papers', 'get_academic_paper', 'finish_discovery', 'finish_retrieval', 'capture_article', 'record_access', 'retrieve_next'].includes(t.function.name) ? t.function.parameters : '(see name)' }));
  return { id: sequence, role: specialist ? 'literature specialist sub-agent' : 'main agent', instructions: key, conversation, tools };
}
async function modelCall(request) {
  sequence++;
  const shown = view(request);
  const answer = await new Promise(resolve => { pending = { request, resolve, view: shown }; notify(); });
  log({ type: 'model', sequence, role: shown.role, tools: shown.tools.length, chars: JSON.stringify(request.messages).length, answer });
  const message = answer.tool_calls?.length
    ? { content: answer.content || '', tool_calls: answer.tool_calls.map((call, index) => ({ id: call.id || `call_${sequence}_${index}`, type: 'function', function: { name: call.name, arguments: typeof call.arguments === 'string' ? call.arguments : JSON.stringify(call.arguments || {}) } })) }
    : { content: answer.content || '' };
  return new Response(JSON.stringify({ choices: [{ message, finish_reason: message.tool_calls ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }));
}
const server = http.createServer(async (req, res) => {
  const send = (status, value) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(value, null, 1)); };
  if (req.method === 'GET' && req.url.startsWith('/pending')) {
    const deadline = Date.now() + 240000;
    while (!pending && !finished && Date.now() < deadline) await new Promise(resolve => { waiters.push(resolve); setTimeout(resolve, 5000); });
    if (finished) return send(200, { done: true, ...finished });
    if (!pending) return send(200, { waiting: true, note: 'The pipeline is still working (downloads or browser steps). Ask again.' });
    return send(200, pending.view);
  }
  if (req.method === 'POST' && req.url === '/respond') {
    let body = ''; for await (const chunk of req) body += chunk;
    if (!pending) return send(409, { error: 'No model request is pending.' });
    let answer; try { answer = JSON.parse(body); } catch { return send(400, { error: 'Body must be JSON: {"content": "..."} or {"tool_calls": [{"name": "...", "arguments": {...}}]}' }); }
    const names = new Set(pending.request.tools.filter(t => t.function).map(t => t.function.name));
    const unknown = (answer.tool_calls || []).map(c => c.name).filter(name => !names.has(name));
    if (unknown.length) return send(400, { error: `Unknown tool(s): ${unknown.join(', ')}. Available: ${[...names].join(', ')}` });
    const current = pending; pending = null; current.resolve(answer);
    return send(200, { accepted: true, id: current.view.id });
  }
  send(404, { error: 'Use GET /pending or POST /respond.' });
});

// ---------------- pipeline ----------------
(async () => {
  await new Promise(resolve => server.listen(PORT, '127.0.0.1', resolve));
  fs.writeFileSync(LOG, '');
  log({ type: 'start', query: QUERY, port: PORT });
  const env = { JWT_SECRET: 'bridge-secret', ADMIN_ACCOUNT: 'bridge-user', REQUESTY_API_KEY: 'bridge-key', REQUESTY_MODEL: model, REQUESTY_TOOL_MODE: 'sequential',
    REQUESTY_MODEL_CAPABILITIES_JSON: JSON.stringify({ [model]: { supportsTools: true, supportsWebSearch: false, supportsImages: false } }) };
  Object.assign(process.env, env);
  const token = jwt.sign({ account: env.ADMIN_ACCOUNT, role: 'admin' }, env.JWT_SECRET);
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    const target = String(url);
    if (target.endsWith('/v1/models')) return new Response(JSON.stringify({ data: [] }));
    if (target.includes('router.requesty.ai')) return modelCall(JSON.parse(options.body));
    return realFetch(url, options);
  };
  const cleanups = [];
  const t = { after: fn => cleanups.push(fn), mock: { method: () => { throw new Error('mock unsupported'); } } };
  const { ProjectFilesystem } = await import(path.join(ROOT, 'desktop/services/project-filesystem.mjs'));
  const { LiteratureWorkflows } = await import(path.join(ROOT, 'desktop/services/literature-workflows.mjs'));
  const { PlaywrightMcpClient } = await import(path.join(ROOT, 'desktop/services/playwright-mcp-client.mjs'));
  const { PaperMcpClient } = await import(path.join(ROOT, 'desktop/services/paper-mcp-client.mjs'));
  const project = process.env.PROJECT_DIR || await mkdtemp(path.join(os.tmpdir(), 'bridge-project-'));
  const profiles = await mkdtemp(path.join(os.tmpdir(), 'bridge-profiles-'));
  const filesystem = await ProjectFilesystem.open(project);
  const browser = new PlaywrightMcpClient({ profileRoot: profiles, headless: process.env.HEADED !== '1' });
  const paperMcp = new PaperMcpClient({ appPath: ROOT });
  const host = new LiteratureWorkflows({ filesystem, sourceDownloads: new AbortController(), paperMcp }, browser, () => true);
  const hostLog = [];
  const f = await demandFixture();
  const context = await f.service.buildContext({ ...f.options, question: QUERY, turnId: 'bridge-turn', callContext: { model } });
  const started = Date.now();
  const { sandbox } = await require(path.join(ROOT, 'alibaba-fc/test/helpers/desktop-renderer.js')).desktopRenderer(t, { token, service: f.service,
    workflow: async (workflowId, input) => {
      if (workflowId !== 'literature_worker') return undefined;
      const t0 = Date.now();
      const result = await host.run(input);
      const summary = { action: input.action, name: input.name, index: input.args?.index, ms: Date.now() - t0,
        status: result?.result?.status || result?.final?.status || (result?.needs_login ? 'needs_login' : result?.tools ? 'tools' : undefined),
        reason: result?.result?.reason?.slice?.(0, 160), source: result?.result?.source_url };
      hostLog.push(summary); log({ type: 'host', ...summary });
      return result;
    },
    globals: { currentAccount: 'bridge', currentLanguage: 'en', workspaceAbortController: new AbortController() },
    window: { BioDesignLiteratureAgent: literature,
      BioDesignLibrarySettings: { saved: () => (process.env.LIBRARY ? JSON.parse(process.env.LIBRARY) : { url: '' }), edit: async () => ({ url: '' }) },
      BioDesignLiteratureLogin: {
        confirmDownload: async options => { log({ type: 'card', papers: options.papers.map(p => p.title), permission: options.permission }); return { approved: true, permission: 'workspace_write' }; },
        // Headless checks cannot be completed by a person here: skip them.
        wait: async options => { log({ type: 'access-dialog', attention: options.attention, mode: process.env.WAIT_MODE || 'skip' }); return process.env.WAIT_MODE === 'continue'; } } } });
  let result, error;
  try {
    result = await sandbox.sendWorkbenchRequest({ mode: 'agent_instruction', model, messages: [{ role: 'user', content: QUERY }], originalRequest: QUERY, localWorkspaceContext: context,
      grantPermission: value => log({ type: 'permission-granted', value }),
      desktopTools: { version: 1, literatureVersion: 1, permission: 'read_only', projectId: context.project.workspaceId }, callContext: { turnId: 'bridge-turn', callRole: 'answer', profile: 'medium' } });
  } catch (cause) { error = { code: cause.code, message: String(cause.message).slice(0, 500) }; }
  const files = await filesystem.list('literature').catch(() => []);
  finished = { error, reply: result?.reply, taskOutcome: result?.taskOutcome, downloads: (result?.downloadResults || []).map(item => ({ title: item.requested?.title, status: item.status, route: item.route, version: item.document_version, file: item.file })),
    files: files.map(file => file.name), hostSteps: hostLog.length, elapsedMs: Date.now() - started, project };
  log({ type: 'done', ...finished }); notify();
  await browser.close(); await paperMcp.close(); for (const cleanup of cleanups.reverse()) await Promise.resolve(cleanup()).catch(() => {});
  await rm(profiles, { recursive: true, force: true });
  setTimeout(() => { server.close(); process.exit(0); }, 20000);
})().catch(cause => { log({ type: 'fatal', message: String(cause?.stack || cause).slice(0, 2000) }); finished = { error: { message: String(cause?.message || cause) } }; notify(); setTimeout(() => process.exit(1), 20000); });
