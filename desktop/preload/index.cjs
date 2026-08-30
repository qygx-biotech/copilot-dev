"use strict";

const { contextBridge, ipcRenderer } = require("electron");
// Sandboxed preloads cannot load neighboring CommonJS files. Keep this static
// capability allowlist self-contained and parity-test it against channels.cjs.
const channels = Object.freeze({
  runtimeInfo: "biodesign:runtime:info",
  projectOpen: "biodesign:project:open",
  projectClose: "biodesign:project:close",
  projectStatus: "biodesign:project:status",
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
});

let activeProjectId = null;

async function invoke(channel, payload = {}) {
  const response = await ipcRenderer.invoke(channel, payload);
  if (!response?.ok) {
    const error = new Error(response?.error?.message || "Desktop operation failed.");
    error.code = response?.error?.code || "DESKTOP_OPERATION_FAILED";
    throw error;
  }
  return response.value;
}

function projectPayload(payload = {}) {
  if (!activeProjectId) {
    const error = new Error("Select a project folder first.");
    error.code = "NO_ACTIVE_PROJECT";
    throw error;
  }
  return { ...payload, projectId: activeProjectId };
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

const api = {
  runtime: {
    info: () => invoke(channels.runtimeInfo),
  },
  project: {
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
    list: (payload) => invoke(channels.filesList, projectPayload(payload)),
    stat: (payload) => invoke(channels.filesStat, projectPayload(payload)),
    exists: (payload) => invoke(channels.filesExists, projectPayload(payload)),
    readText: (payload) => invoke(channels.filesReadText, projectPayload(payload)),
    readBinary: (payload) => invoke(channels.filesReadBinary, projectPayload(payload)),
    writeText: (payload) => invoke(channels.filesWriteText, projectPayload(payload)),
    writeBinary: (payload) => invoke(channels.filesWriteBinary, projectPayload(payload)),
    mkdir: (payload) => invoke(channels.filesMkdir, projectPayload(payload)),
    remove: (payload) => invoke(channels.filesRemove, projectPayload(payload)),
    tree: (payload = {}) => invoke(channels.filesTree, projectPayload(payload)),
  },
  knowledge: {
    initialize: (payload) => invoke(channels.knowledgeInitialize, projectPayload(payload)),
    status: () => invoke(channels.knowledgeStatus, projectPayload()),
    update: (payload) => invoke(channels.knowledgeUpdate, projectPayload(payload)),
    embed: (payload) => invoke(channels.knowledgeEmbed, projectPayload(payload)),
    search: (payload) => invoke(channels.knowledgeSearch, projectPayload(payload)),
    document: (payload) => invoke(channels.knowledgeDocument, projectPayload(payload)),
    onProgress(listener) {
      if (typeof listener !== "function") throw new TypeError("A progress listener is required.");
      const wrapped = (_event, payload) => listener(payload);
      ipcRenderer.on(channels.knowledgeProgress, wrapped);
      return () => ipcRenderer.removeListener(channels.knowledgeProgress, wrapped);
    },
  },
  jobs: {
    start: (payload) => invoke(channels.jobsStart, projectPayload(payload)),
    status: (payload) => invoke(channels.jobsStatus, projectPayload(payload)),
    list: () => invoke(channels.jobsList, projectPayload()),
    cancel: (payload) => invoke(channels.jobsCancel, projectPayload(payload)),
  },
  execution: {
    listWorkflows: () => invoke(channels.executionList, projectPayload()),
    runWorkflow: (payload) => invoke(channels.executionRun, projectPayload(payload)),
  },
};

contextBridge.exposeInMainWorld("biodesignDesktop", deepFreeze(api));
