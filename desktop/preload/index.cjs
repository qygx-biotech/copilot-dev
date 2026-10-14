"use strict";

const { contextBridge, ipcRenderer } = require("electron");
// Sandboxed preloads cannot load neighboring CommonJS files. Keep this static
// capability allowlist self-contained and parity-test it against channels.cjs.
const channels = Object.freeze({
  runtimeInfo: "biodesign:runtime:info",
  clipboardWriteText: "biodesign:clipboard:write-text",
  sourceOpen: "biodesign:source:open",
  updateCheck: "biodesign:updates:check",
  updateStatus: "biodesign:updates:status",
  projectOpen: "biodesign:project:open",
  projectClose: "biodesign:project:close",
  projectStatus: "biodesign:project:status",
  projectList: "biodesign:project:list",
  projectChoose: "biodesign:project:choose",
  projectActivate: "biodesign:project:activate",
  filesList: "biodesign:files:list",
  filesStat: "biodesign:files:stat",
  filesExists: "biodesign:files:exists",
  filesReadText: "biodesign:files:read-text",
  filesReadBinary: "biodesign:files:read-binary",
  filesWriteText: "biodesign:files:write-text",
  filesWriteBinary: "biodesign:files:write-binary",
  filesMkdir: "biodesign:files:mkdir",
  filesRemove: "biodesign:files:remove",
  filesTree: "biodesign:files:tree",
  filesReveal: "biodesign:files:reveal",
  knowledgeInitialize: "biodesign:knowledge:initialize",
  knowledgeStatus: "biodesign:knowledge:status",
  knowledgeUpdate: "biodesign:knowledge:update",
  knowledgeEmbed: "biodesign:knowledge:embed",
  knowledgeSearch: "biodesign:knowledge:search",
  knowledgeDocument: "biodesign:knowledge:document",
  knowledgeProgress: "biodesign:knowledge:progress",
  jobsStart: "biodesign:jobs:start",
  jobsStatus: "biodesign:jobs:status",
  jobsList: "biodesign:jobs:list",
  jobsCancel: "biodesign:jobs:cancel",
  executionList: "biodesign:execution:list",
  executionRun: "biodesign:execution:run",
  agentStart: "biodesign:agent:start",
  agentCancel: "biodesign:agent:cancel",
  agentSteer: "biodesign:agent:steer",
  agentInject: "biodesign:agent:inject",
  agentRespond: "biodesign:agent:respond",
  agentEvent: "biodesign:agent:event",
  feedbackSave: "biodesign:feedback:save",
  feedbackReveal: "biodesign:feedback:reveal",
});

let activeProjectId = null;

// contextBridge copies only the message of an Error thrown across it; custom
// properties such as code and status are dropped. Plain objects are copied
// whole, so desktop failures cross as { name, code, message, status }.
function desktopError(code, message, status) {
  return { name: "DesktopError", code, message, ...(Number.isInteger(status) ? { status } : {}) };
}

async function invoke(channel, payload = {}) {
  let response;
  try { response = await ipcRenderer.invoke(channel, payload); }
  catch (error) { throw desktopError("DESKTOP_IPC_FAILED", String(error?.message || "Desktop request failed.").slice(0, 1000)); }
  if (!response?.ok) {
    throw desktopError(response?.error?.code || "DESKTOP_OPERATION_FAILED", response?.error?.message || "Desktop operation failed.", response?.error?.status);
  }
  return response.value;
}

function projectPayload(payload = {}) {
  if (!activeProjectId) throw desktopError("NO_ACTIVE_PROJECT", "Select a project folder first.");
  if (payload.projectId !== undefined && payload.projectId !== activeProjectId) {
    throw desktopError("PROJECT_MISMATCH", "The request belongs to a previous project.");
  }
  return { ...payload, projectId: activeProjectId };
}

// Async, so a project check fails as a rejection: a synchronous throw across
// contextBridge loses the error's code like an Error does.
async function invokeProject(channel, payload) {
  return invoke(channel, projectPayload(payload));
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

const api = {
  clipboard: {
    writeText: (text) => invoke(channels.clipboardWriteText, { text }),
  },
  runtime: {
    info: () => invoke(channels.runtimeInfo),
    openSource: (payload) => invoke(channels.sourceOpen, payload),
  },
  updates: {
    requestUpdateCheck: () => invoke(channels.updateCheck),
    onUpdateStatus(listener) {
      if (typeof listener !== "function") throw new TypeError("An update status listener is required.");
      const wrapped = (_event, status) => listener(status);
      ipcRenderer.on(channels.updateStatus, wrapped);
      return () => ipcRenderer.removeListener(channels.updateStatus, wrapped);
    },
  },
  project: {
    list: (payload) => invoke(channels.projectList, payload),
    choose: (payload) => invoke(channels.projectChoose, payload),
    async activate(payload) {
      const result = await invoke(channels.projectActivate, payload);
      activeProjectId = result.projectId;
      return result;
    },
    async open() {
      const result = await invoke(channels.projectOpen);
      activeProjectId = result.projectId;
      return result;
    },
    async close() {
      const projectId = activeProjectId;
      activeProjectId = null;
      return invoke(channels.projectClose, { projectId });
    },
    status: () => invoke(channels.projectStatus, { projectId: activeProjectId }),
  },
  files: {
    list: (payload) => invokeProject(channels.filesList, payload),
    stat: (payload) => invokeProject(channels.filesStat, payload),
    exists: (payload) => invokeProject(channels.filesExists, payload),
    readText: (payload) => invokeProject(channels.filesReadText, payload),
    readBinary: (payload) => invokeProject(channels.filesReadBinary, payload),
    writeText: (payload) => invokeProject(channels.filesWriteText, payload),
    writeBinary: (payload) => invokeProject(channels.filesWriteBinary, payload),
    mkdir: (payload) => invokeProject(channels.filesMkdir, payload),
    remove: (payload) => invokeProject(channels.filesRemove, payload),
    tree: (payload = {}) => invokeProject(channels.filesTree, payload),
    // Shows a project file in its folder in Finder or Explorer.
    reveal: (payload) => invokeProject(channels.filesReveal, payload),
  },
  knowledge: {
    initialize: (payload) => invokeProject(channels.knowledgeInitialize, payload),
    status: (payload = {}) => invokeProject(channels.knowledgeStatus, payload),
    update: (payload) => invokeProject(channels.knowledgeUpdate, payload),
    embed: (payload) => invokeProject(channels.knowledgeEmbed, payload),
    search: (payload) => invokeProject(channels.knowledgeSearch, payload),
    document: (payload) => invokeProject(channels.knowledgeDocument, payload),
    onProgress(listener) {
      if (typeof listener !== "function") throw new TypeError("A progress listener is required.");
      const wrapped = (_event, payload) => listener(payload);
      ipcRenderer.on(channels.knowledgeProgress, wrapped);
      return () => ipcRenderer.removeListener(channels.knowledgeProgress, wrapped);
    },
  },
  jobs: {
    start: (payload) => invokeProject(channels.jobsStart, payload),
    status: (payload) => invokeProject(channels.jobsStatus, payload),
    list: () => invokeProject(channels.jobsList),
    cancel: (payload) => invokeProject(channels.jobsCancel, payload),
  },
  // Bug reports: save writes a local file chosen by the user; reveal shows the
  // last saved one. Neither needs an open project.
  feedback: {
    save: (payload) => invoke(channels.feedbackSave, payload),
    reveal: () => invoke(channels.feedbackReveal),
  },
  execution: {
    listWorkflows: () => invokeProject(channels.executionList),
    runWorkflow: (payload) => invokeProject(channels.executionRun, payload),
  },
  // The desktop agent loop. start resolves when the turn ends; its progress
  // arrives through onEvent tagged with the turnId.
  agent: {
    start: (payload) => invokeProject(channels.agentStart, payload),
    cancel: (payload) => invokeProject(channels.agentCancel, payload),
    steer: (payload) => invokeProject(channels.agentSteer, payload),
    inject: (payload) => invokeProject(channels.agentInject, payload),
    // Answers a step boundary event ({ type: "boundary" }) of a running turn.
    respond: (payload) => invokeProject(channels.agentRespond, payload),
    onEvent(listener) {
      if (typeof listener !== "function") throw new TypeError("An agent event listener is required.");
      const wrapped = (_event, payload) => listener(payload);
      ipcRenderer.on(channels.agentEvent, wrapped);
      return () => ipcRenderer.removeListener(channels.agentEvent, wrapped);
    },
  },
};

contextBridge.exposeInMainWorld("biodesignDesktop", deepFreeze(api));
