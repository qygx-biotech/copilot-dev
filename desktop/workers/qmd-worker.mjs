import process from "node:process";
import { ProjectQmdManager } from "../../local-backend/src/project-qmd-manager.js";

const parentPort = process.parentPort;
if (!parentPort) throw new Error("The QMD worker must run as an Electron utility process.");

const projectRoot = process.env.BIODESIGN_QMD_PROJECT_ROOT;
const workspaceId = process.env.BIODESIGN_QMD_WORKSPACE_ID;
if (!projectRoot || !workspaceId) throw new Error("The main process did not establish the QMD project boundary.");

const manager = new ProjectQmdManager({ projectRoot });

function reply(message) {
  parentPort.postMessage(message);
}

function errorPayload(error) {
  return {
    code: String(error?.code || error?.name || "QMD_WORKER_ERROR").slice(0, 100),
    message: String(error?.message || "QMD worker operation failed.")
      .split(projectRoot).join("<project>")
      .slice(0, 1000),
  };
}

function publicStatus(status) {
  const { projectRoot: _projectRoot, dbPath: _dbPath, ...safe } = status || {};
  return { ...safe, dbPath: ".biodesign/knowledge/qmd/index.sqlite" };
}

async function dispatch(method, payload) {
  const options = { ...payload, workspaceId };
  if (method === "initialize") return publicStatus(await manager.initialize(options));
  if (method === "status") return publicStatus(await manager.status(options));
  if (method === "update") return manager.update(options);
  if (method === "embed") {
    return manager.embed({
      ...options,
      onProgress(progress) {
        reply({ type: "progress", event: { stage: "embedding", ...progress } });
      },
    });
  }
  if (method === "search") return manager.search(options);
  if (method === "document") return manager.getDocument(options);
  if (method === "close") {
    await manager.close();
    return { closed: true };
  }
  const error = new Error(`Unknown QMD worker operation: ${method}`);
  error.code = "UNKNOWN_QMD_OPERATION";
  throw error;
}

parentPort.on("message", async (event) => {
  const message = event?.data || event;
  if (!message || typeof message.id !== "string" || typeof message.method !== "string") return;
  try {
    const result = await dispatch(message.method, message.payload || {});
    reply({ id: message.id, ok: true, result });
  } catch (error) {
    reply({ id: message.id, ok: false, error: errorPayload(error) });
  }
});
