'use strict';
// The production renderer turn code (docs/app.js sendWorkbenchRequest) running
// agent turns on the desktop agent loop, in-process: the real loop host in
// place of the utility process, the real AgentLoopService, IPC validators and
// IPC error envelope, and the FC model proxy over loopback HTTP.
const fs = require('node:fs'), fsp = require('node:fs/promises'), os = require('node:os'), path = require('node:path'), vm = require('node:vm');
const { EventEmitter } = require('node:events');
const { loopbackFetch, proxyUrl } = require('./model-proxy.js');

function withEnv(t, values) {
  const before = Object.fromEntries(Object.keys(values).map(key => [key, process.env[key]]));
  Object.assign(process.env, values);
  t.after(() => { for (const [key, value] of Object.entries(before)) value === undefined ? delete process.env[key] : process.env[key] = value; });
}
async function temporaryDirectory(t, label) {
  const directory = await fsp.mkdtemp(path.join(os.tmpdir(), `biodesign-${label}-`));
  t.after(() => fsp.rm(directory, { recursive: true, force: true }));
  return directory;
}

// The preload-shaped agent API (window.biodesignDesktop.agent) over the real
// AgentLoopService and loop host. starts/replies/cancels record what crossed IPC.
async function localAgentBridge(t, { archiveRoot, onBoundary = () => {}, onStart = () => {} } = {}) {
  const { AgentLoopService } = await import('../../../desktop/services/agent-loop-service.mjs');
  const { createAgentLoopHost } = await import('../../../desktop/workers/agent-loop-host.mjs');
  const { validateAgentStart, validateAgentRespond, validateAgentCancel } = await import('../../../desktop/ipc/agent-loop-validation.mjs');
  const { sanitizeError } = await import('../../../desktop/ipc/validation.mjs');
  // As register-handlers + preload: failures cross IPC as { code, message, status }.
  const invoke = async operation => {
    try { return await operation(); } catch (error) {
      const { code, message, status } = sanitizeError(error);
      throw Object.assign(new Error(message), { code, ...(status ? { status } : {}) });
    }
  };
  const listeners = new Set(), sender = Object.assign(new EventEmitter(), { isDestroyed: () => false });
  const utilityProcess = { fork() {
    const child = new EventEmitter();
    const host = createAgentLoopHost({ post: message => setImmediate(() => child.emit('message', structuredClone(message))), fetchImpl: loopbackFetch });
    child.postMessage = message => setImmediate(() => host.handle(structuredClone(message)));
    child.kill = () => setImmediate(() => child.emit('exit', 0));
    return child;
  } };
  // Like ProjectSessionManager, the open project is one stable object.
  const active = { filesystem: { root: archiveRoot || await temporaryDirectory(t, 'project'), id: 'project-1' } };
  const sessionManager = Object.assign(new EventEmitter(), { requireActive: () => active });
  const loop = new AgentLoopService({ sessionManager, utilityProcess, appPath: process.cwd(), baseUrl: await proxyUrl(),
    sendEvent: (_sender, payload) => {
      if (payload.event?.type === 'boundary') onBoundary(payload);
      for (const listener of listeners) listener(payload);
    } });
  t.after(() => loop.closeClient());
  const starts = [], replies = [], cancels = [];
  const agent = {
    start: async payload => { starts.push(payload); await onStart(payload); return invoke(() => loop.start(sender, validateAgentStart(payload))); },
    respond: async payload => { replies.push(payload.reply); return invoke(() => loop.respond(sender, validateAgentRespond(payload))); },
    cancel: async payload => { cancels.push(payload); return invoke(() => loop.cancel(sender, validateAgentCancel(payload))); },
    onEvent: listener => { listeners.add(listener); return () => listeners.delete(listener); },
  };
  return { agent, loop, starts, replies, cancels, archiveRoot: active.filesystem.root };
}

const APP = path.resolve(__dirname, '../../../docs/app.js');
const rendererFunctions = () => {
  const source = fs.readFileSync(APP, 'utf8');
  return ['sendWorkbenchRequest', 'sendWorkbenchRequestOnce'].map(name => source.match(new RegExp(`^async function ${name}\\([\\s\\S]*?^}$`, 'm'))[0]).join('\n');
};
// The renderer's turn functions with desktop stand-ins. `workflow(id, input)`
// runs host workflows; the runtime session's setup workflows default to no
// skills and no MCP tools. `globals` and `window` override sandbox values.
function rendererSandbox({ token, service, selected = [], agent, workflow = async () => undefined, window: extra = {}, globals = {} }) {
  const runWorkflow = async ({ workflowId, input }) => {
    const value = await workflow(workflowId, input);
    if (value !== undefined) return value;
    if (workflowId === 'runtime_skills_context') return { catalog: [], active: [] };
    if (workflowId === 'runtime_mcp_definitions') return { tools: [] };
    throw new Error(`Unexpected workflow ${workflowId}`);
  };
  const sandbox = vm.createContext({ Response, crypto: globalThis.crypto,
    projectContextService: service, workspaceManager: service?.workspace, workspaceAbortController: null, authToken: token,
    selectedWorkspacePaths: new Set(), getSelectedPaperIds: () => selected, runtimeLog: null, literatureModule: null, getProjectContext: () => '',
    backendUrl: route => route, getAuthHeaders: headers => ({ ...headers, authorization: `Bearer ${token}` }), requireLoginForUnauthorized: () => {}, t: key => key,
    fetch: async url => { throw new Error(`An agent turn must not fetch ${url}`); },
    window: { BioDesignConversationTranscript: require('../../../shared/conversation-transcript.js'),
      BioDesignRuntimeSession: require('../../../docs/runtime-session.js'), BioDesignRuntimeExtensions: require('../../../shared/runtime-extensions.js'),
      BioDesignRuntimeTurns: require('../../../docs/runtime-turns.js'), BioDesignSourceDownload: require('../../../shared/source-download.js'),
      BioDesignSideChatTools: require('../../../shared/side-chat-tools.js'), BioDesignAcademicTools: require('../../../shared/academic-tools.js'),
      BioDesignWebSearch: require('../../../shared/web-search.js'), BioDesignLocalAgentTransport: require('../../../docs/local-agent-transport.js'),
      biodesignDesktop: { agent, execution: { runWorkflow } },
      ...extra },
    ...globals,
  });
  vm.runInContext(rendererFunctions(), sandbox);
  return sandbox;
}

// A renderer sandbox wired to its own loop bridge.
async function desktopRenderer(t, { archiveRoot, onBoundary, onStart, ...options }) {
  const bridge = await localAgentBridge(t, { archiveRoot, onBoundary, onStart });
  return { ...bridge, sandbox: rendererSandbox({ ...options, agent: bridge.agent }) };
}

module.exports = { withEnv, temporaryDirectory, localAgentBridge, rendererSandbox, desktopRenderer };
