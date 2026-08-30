import { EventEmitter } from "node:events";
import crypto from "node:crypto";
import path from "node:path";

export class QmdWorkerClient extends EventEmitter {
  constructor(options) {
    super();
    this.utilityProcess = options.utilityProcess;
    this.modulePath = options.modulePath;
    this.projectRoot = options.projectRoot;
    this.workspaceId = options.workspaceId;
    this.cacheRoot = options.cacheRoot;
    this.child = null;
    this.pending = new Map();
    this.closed = false;
  }

  start() {
    if (this.child) return;
    const safeEnvironment = {};
    for (const name of ["HOME", "USERPROFILE", "LOCALAPPDATA", "APPDATA", "TMPDIR", "TEMP", "TMP", "PATH", "SystemRoot"]) {
      if (process.env[name]) safeEnvironment[name] = process.env[name];
    }
    if (this.cacheRoot) safeEnvironment.XDG_CACHE_HOME = this.cacheRoot;
    this.child = this.utilityProcess.fork(this.modulePath, [], {
      serviceName: "BioDesign QMD",
      stdio: "pipe",
      env: {
        ...safeEnvironment,
        BIODESIGN_QMD_PROJECT_ROOT: this.projectRoot,
        BIODESIGN_QMD_WORKSPACE_ID: this.workspaceId,
      },
    });
    this.child.on("message", (message) => this.handleMessage(message));
    this.child.on("exit", (code) => {
      const error = new Error(`The isolated QMD process exited with code ${code}.`);
      error.code = "QMD_WORKER_EXITED";
      for (const { reject } of this.pending.values()) reject(error);
      this.pending.clear();
      this.child = null;
      if (!this.closed) this.emit("crash", { code });
    });
    this.child.stderr?.on("data", (bytes) => {
      this.emit("diagnostic", String(bytes).slice(0, 1000));
    });
  }

  handleMessage(message) {
    if (!message || typeof message !== "object") return;
    if (message.type === "progress") {
      this.emit("progress", message.event);
      return;
    }
    const pending = this.pending.get(message.id);
    if (!pending) return;
    this.pending.delete(message.id);
    if (message.ok) pending.resolve(message.result);
    else {
      const error = new Error(message.error?.message || "QMD worker request failed.");
      error.code = message.error?.code || "QMD_WORKER_ERROR";
      pending.reject(error);
    }
  }

  request(method, payload = {}) {
    if (this.closed) {
      const error = new Error("The QMD worker is closed.");
      error.code = "QMD_WORKER_CLOSED";
      return Promise.reject(error);
    }
    this.start();
    const id = crypto.randomUUID();
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.child.postMessage({ id, method, payload });
    });
  }

  async close() {
    if (this.closed) return;
    this.closed = true;
    if (!this.child) return;
    await Promise.race([
      this.requestForClose(),
      new Promise((resolve) => setTimeout(resolve, 5000)),
    ]).catch(() => {});
    this.child?.kill();
    this.child = null;
    const error = new Error("The active project was closed.");
    error.code = "PROJECT_CLOSED";
    for (const { reject } of this.pending.values()) reject(error);
    this.pending.clear();
  }

  requestForClose() {
    const id = crypto.randomUUID();
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.child.postMessage({ id, method: "close", payload: {} });
    });
  }

  static modulePath(appPath) {
    return path.join(appPath, "desktop", "workers", "qmd-worker.mjs");
  }
}
