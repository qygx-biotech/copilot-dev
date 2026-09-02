import channels from "./channels.cjs";
import retrievalContract from "../../shared/retrieval-contract.js";
import {
  assertCollections,
  assertOnlyKeys,
  assertRecord,
  assertRelativePath,
  assertWorkspaceId,
  boundedInteger,
  boundedString,
  sanitizeError,
  ValidationError,
} from "./validation.mjs";

const { RETRIEVAL_LIMITS } = retrievalContract;

function success(value) {
  return { ok: true, value };
}

function safeHandler(handler) {
  return async (event, rawPayload = {}) => {
    try {
      return success(await handler(event, rawPayload));
    } catch (error) {
      return { ok: false, error: sanitizeError(error) };
    }
  };
}

function assertTrustedIpcSender(event, getWindow) {
  const window = getWindow();
  const contents = window && !window.isDestroyed() ? window.webContents : null;
  const senderUrl = event.senderFrame?.url || event.sender?.getURL?.() || "";
  const trustedUrl = contents?.getURL?.() || "";
  if (!contents || event.sender !== contents || !senderUrl.startsWith("file:") || senderUrl !== trustedUrl) {
    throw new ValidationError("UNTRUSTED_IPC_SENDER", "The desktop request source is not allowed.");
  }
}

function boolean(value, label, fallback = false) {
  if (value === undefined) return fallback;
  if (typeof value !== "boolean") throw new ValidationError("INVALID_BOOLEAN", `${label} must be a boolean.`);
  return value;
}

function projectPayload(sessionManager, rawPayload, allowedKeys = []) {
  const payload = assertOnlyKeys(rawPayload, ["projectId", ...allowedKeys]);
  const active = sessionManager.requireActive();
  if (typeof payload.projectId !== "string" || payload.projectId !== active.filesystem.id) {
    throw new ValidationError("PROJECT_MISMATCH", "The request does not belong to the active project.");
  }
  return { active, payload };
}

function binary(value) {
  if (value instanceof ArrayBuffer) return Buffer.from(value);
  if (ArrayBuffer.isView(value)) return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  throw new ValidationError("INVALID_BINARY", "Binary project writes require an ArrayBuffer.");
}

function searchPayload(payload) {
  assertOnlyKeys(payload, ["projectId", "query", "collections", "mode", "limit", "candidateLimit", "paperIds", "intent"]);
  const mode = payload.mode === undefined ? "fast" : boundedString(payload.mode, "mode", 20);
  if (!["fast", "semantic", "deep"].includes(mode)) throw new ValidationError("INVALID_SEARCH_MODE", "Knowledge search mode is not allowed.");
  let paperIds;
  if (payload.paperIds !== undefined) {
    if (!Array.isArray(payload.paperIds) || payload.paperIds.length > RETRIEVAL_LIMITS.paperScopeItems) throw new ValidationError("INVALID_PAPER_SCOPE", "paperIds must be a bounded array.");
    paperIds = payload.paperIds.map((id) => boundedString(id, "paperId", RETRIEVAL_LIMITS.paperIdCharacters));
  }
  return {
    query: boundedString(payload.query, "query", RETRIEVAL_LIMITS.queryCharacters),
    collections: assertCollections(payload.collections, { optional: true }),
    mode,
    limit: boundedInteger(payload.limit, "limit", 1, RETRIEVAL_LIMITS.resultMaximum, RETRIEVAL_LIMITS.resultDefault),
    candidateLimit: boundedInteger(payload.candidateLimit, "candidateLimit", 1, RETRIEVAL_LIMITS.candidateMaximum, RETRIEVAL_LIMITS.candidateDefault),
    ...(paperIds ? { paperIds } : {}),
    ...(payload.intent === undefined ? {} : { intent: boundedString(payload.intent, "intent", RETRIEVAL_LIMITS.intentCharacters) }),
  };
}

export function registerIpcHandlers(options) {
  const { ipcMain, dialog, sessionManager, runtimeInfo, getWindow, getUpdaterController } = options;
  const registered = [];
  const handle = (channel, handler) => {
    ipcMain.handle(channel, safeHandler(handler));
    registered.push(channel);
  };

  handle(channels.runtimeInfo, async (_event, payload) => {
    assertOnlyKeys(payload, []);
    return runtimeInfo();
  });

  handle(channels.betaUpdateCheck, async (event, payload) => {
    assertOnlyKeys(payload, []);
    assertTrustedIpcSender(event, getWindow);
    const controller = getUpdaterController?.();
    if (!controller) return { state: "unsupported", reason: "packaged_windows_only" };
    return controller.requestBetaUpdateCheck();
  });

  handle(channels.projectOpen, async (_event, payload) => {
    assertOnlyKeys(payload, []);
    const result = await dialog.showOpenDialog(getWindow(), {
      title: "Select a BioDesign project folder",
      buttonLabel: "Open Project",
      properties: ["openDirectory", "createDirectory"],
    });
    if (result.canceled || result.filePaths.length !== 1) {
      const error = new Error("Project selection was cancelled.");
      error.code = "PICKER_CANCELLED";
      throw error;
    }
    return sessionManager.open(result.filePaths[0]);
  });

  handle(channels.projectClose, async (_event, rawPayload) => {
    const payload = assertOnlyKeys(rawPayload, ["projectId"]);
    if (sessionManager.active && payload.projectId !== sessionManager.active.filesystem.id) {
      throw new ValidationError("PROJECT_MISMATCH", "The close request does not belong to the active project.");
    }
    return sessionManager.close();
  });

  handle(channels.projectStatus, async (_event, rawPayload) => {
    assertOnlyKeys(rawPayload, ["projectId"]);
    if (sessionManager.active && rawPayload.projectId !== sessionManager.active.filesystem.id) {
      throw new ValidationError("PROJECT_MISMATCH", "The status request does not belong to the active project.");
    }
    return sessionManager.status();
  });

  handle(channels.filesExists, async (_event, rawPayload) => {
    const { active, payload } = projectPayload(sessionManager, rawPayload, ["relativePath"]);
    return active.filesystem.exists(assertRelativePath(payload.relativePath));
  });
  handle(channels.filesStat, async (_event, rawPayload) => {
    const { active, payload } = projectPayload(sessionManager, rawPayload, ["relativePath"]);
    return active.filesystem.stat(assertRelativePath(payload.relativePath));
  });
  handle(channels.filesReadText, async (_event, rawPayload) => {
    const { active, payload } = projectPayload(sessionManager, rawPayload, ["relativePath"]);
    return active.filesystem.readText(assertRelativePath(payload.relativePath));
  });
  handle(channels.filesReadBinary, async (_event, rawPayload) => {
    const { active, payload } = projectPayload(sessionManager, rawPayload, ["relativePath"]);
    return active.filesystem.readBinary(assertRelativePath(payload.relativePath));
  });
  handle(channels.filesWriteText, async (_event, rawPayload) => {
    const { active, payload } = projectPayload(sessionManager, rawPayload, ["relativePath", "value", "atomic"]);
    if (typeof payload.value !== "string" || payload.value.length > 128 * 1024 * 1024) throw new ValidationError("INVALID_TEXT", "The project text write is invalid or too large.");
    return active.filesystem.writeText(assertRelativePath(payload.relativePath), payload.value, { atomic: boolean(payload.atomic, "atomic", true) });
  });
  handle(channels.filesWriteBinary, async (_event, rawPayload) => {
    const { active, payload } = projectPayload(sessionManager, rawPayload, ["relativePath", "value", "atomic"]);
    return active.filesystem.writeBinary(assertRelativePath(payload.relativePath), binary(payload.value), { atomic: boolean(payload.atomic, "atomic", true) });
  });
  handle(channels.filesMkdir, async (_event, rawPayload) => {
    const { active, payload } = projectPayload(sessionManager, rawPayload, ["relativePath"]);
    await active.filesystem.ensureDirectory(assertRelativePath(payload.relativePath));
    return { created: true };
  });
  handle(channels.filesRemove, async (_event, rawPayload) => {
    const { active, payload } = projectPayload(sessionManager, rawPayload, ["relativePath", "recursive"]);
    return active.filesystem.remove(assertRelativePath(payload.relativePath), { recursive: boolean(payload.recursive, "recursive") });
  });
  handle(channels.filesList, async (_event, rawPayload) => {
    const { active, payload } = projectPayload(sessionManager, rawPayload, ["relativePath", "recursive"]);
    return active.filesystem.list(assertRelativePath(payload.relativePath), { recursive: boolean(payload.recursive, "recursive") });
  });
  handle(channels.filesTree, async (_event, rawPayload) => {
    const { active, payload } = projectPayload(sessionManager, rawPayload, ["excludeNames"]);
    if (payload.excludeNames !== undefined && (!Array.isArray(payload.excludeNames) || payload.excludeNames.length > 20)) throw new ValidationError("INVALID_EXCLUSIONS", "excludeNames must be a bounded array.");
    const excludeNames = payload.excludeNames?.map((name) => boundedString(name, "excludeName", 100));
    return active.filesystem.tree({ excludeNames });
  });

  handle(channels.knowledgeInitialize, async (_event, rawPayload) => {
    const { payload } = projectPayload(sessionManager, rawPayload, ["workspaceId"]);
    return sessionManager.initializeKnowledge(assertWorkspaceId(payload.workspaceId));
  });
  handle(channels.knowledgeStatus, async (_event, rawPayload) => {
    projectPayload(sessionManager, rawPayload, []);
    return sessionManager.knowledge("status", {});
  });
  handle(channels.knowledgeUpdate, async (_event, rawPayload) => {
    const { payload } = projectPayload(sessionManager, rawPayload, ["collections"]);
    const input = { collections: assertCollections(payload.collections, { optional: true }) };
    return sessionManager.knowledge("update", input, { jobType: "knowledge-update" });
  });
  handle(channels.knowledgeEmbed, async (_event, rawPayload) => {
    const { payload } = projectPayload(sessionManager, rawPayload, ["collections", "force"]);
    const input = { collections: assertCollections(payload.collections, { optional: true }), force: boolean(payload.force, "force") };
    return sessionManager.knowledge("embed", input, { jobType: "knowledge-embed" });
  });
  handle(channels.knowledgeSearch, async (_event, rawPayload) => {
    projectPayload(sessionManager, rawPayload, ["query", "collections", "mode", "limit", "candidateLimit", "paperIds", "intent"]);
    return sessionManager.knowledge("search", searchPayload(rawPayload));
  });
  handle(channels.knowledgeDocument, async (_event, rawPayload) => {
    const { payload } = projectPayload(sessionManager, rawPayload, ["pathOrDocid", "includeBody", "fromLine", "maxLines"]);
    return sessionManager.knowledge("document", {
      pathOrDocid: boundedString(payload.pathOrDocid, "pathOrDocid", 4096),
      includeBody: boolean(payload.includeBody, "includeBody"),
      ...(payload.fromLine === undefined ? {} : { fromLine: boundedInteger(payload.fromLine, "fromLine", 1, 10_000_000) }),
      ...(payload.maxLines === undefined ? {} : { maxLines: boundedInteger(payload.maxLines, "maxLines", 1, 500) }),
    });
  });

  handle(channels.jobsList, async (_event, rawPayload) => {
    const { active } = projectPayload(sessionManager, rawPayload, []);
    return active.jobs.list();
  });
  handle(channels.jobsStatus, async (_event, rawPayload) => {
    const { active, payload } = projectPayload(sessionManager, rawPayload, ["id"]);
    return active.jobs.status(boundedString(payload.id, "id", 128));
  });
  handle(channels.jobsCancel, async (_event, rawPayload) => {
    const { active, payload } = projectPayload(sessionManager, rawPayload, ["id"]);
    return active.jobs.cancel(boundedString(payload.id, "id", 128));
  });
  handle(channels.jobsStart, async (_event, rawPayload) => {
    const { payload } = projectPayload(sessionManager, rawPayload, ["type", "input"]);
    const type = boundedString(payload.type, "type", 100);
    const input = assertRecord(payload.input || {}, "input");
    if (type === "knowledge-update") {
      return sessionManager.knowledge("update", { collections: assertCollections(input.collections, { optional: true }) }, { jobType: type });
    }
    if (type === "knowledge-embed") {
      return sessionManager.knowledge("embed", { collections: assertCollections(input.collections, { optional: true }), force: boolean(input.force, "force") }, { jobType: type });
    }
    throw new ValidationError("JOB_TYPE_NOT_ALLOWED", "The requested desktop job type is not allowed.");
  });

  handle(channels.executionList, async (_event, rawPayload) => {
    const { active } = projectPayload(sessionManager, rawPayload, []);
    return active.execution.list();
  });
  handle(channels.executionRun, async (_event, rawPayload) => {
    const { active, payload } = projectPayload(sessionManager, rawPayload, ["workflowId", "input"]);
    return active.execution.run(boundedString(payload.workflowId, "workflowId", 100), assertRecord(payload.input || {}, "input"), { jobs: active.jobs, filesystem: active.filesystem });
  });

  const progressListener = (event) => {
    const window = getWindow();
    if (window && !window.isDestroyed()) window.webContents.send(channels.knowledgeProgress, event);
  };
  sessionManager.on("knowledge-progress", progressListener);

  return () => {
    sessionManager.off("knowledge-progress", progressListener);
    for (const channel of registered) ipcMain.removeHandler(channel);
  };
}
