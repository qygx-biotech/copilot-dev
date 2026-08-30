import { EventEmitter } from "node:events";
import { ProjectFilesystem } from "./project-filesystem.mjs";
import { JobManager } from "./job-manager.mjs";
import { LocalExecutionService } from "./local-execution-service.mjs";
import { QmdWorkerClient } from "../workers/qmd-worker-client.mjs";

export class ProjectSessionManager extends EventEmitter {
  constructor(options) {
    super();
    this.utilityProcess = options.utilityProcess;
    this.appPath = options.appPath;
    this.qmdCacheRoot = options.qmdCacheRoot;
    this.active = null;
  }

  async open(rootPath) {
    await this.close();
    const filesystem = await ProjectFilesystem.open(rootPath);
    const jobs = new JobManager(filesystem);
    await jobs.load();
    this.active = {
      filesystem,
      jobs,
      execution: new LocalExecutionService(),
      qmd: null,
      workspaceId: null,
    };
    return {
      ...this.status(),
      initialized: await filesystem.exists(".biodesign/workspace.json"),
    };
  }

  requireActive() {
    if (!this.active) {
      const error = new Error("Select a project folder first.");
      error.code = "NO_ACTIVE_PROJECT";
      throw error;
    }
    return this.active;
  }

  status() {
    if (!this.active) return { open: false };
    return { open: true, ...this.active.filesystem.descriptor(), workspaceId: this.active.workspaceId };
  }

  async initializeKnowledge(workspaceId) {
    const active = this.requireActive();
    const metadata = JSON.parse(await active.filesystem.readText(".biodesign/workspace.json"));
    if (metadata.workspaceId !== workspaceId) {
      const error = new Error("The active project does not match the requested workspace.");
      error.code = "WORKSPACE_MISMATCH";
      throw error;
    }
    if (active.qmd && active.workspaceId !== workspaceId) await active.qmd.close();
    active.workspaceId = workspaceId;
    if (!active.qmd) {
      active.qmd = new QmdWorkerClient({
        utilityProcess: this.utilityProcess,
        modulePath: QmdWorkerClient.modulePath(this.appPath),
        projectRoot: active.filesystem.root,
        workspaceId,
        cacheRoot: this.qmdCacheRoot,
      });
      active.qmd.on("progress", (event) => this.emit("knowledge-progress", event));
      active.qmd.on("crash", (event) => this.emit("knowledge-progress", { stage: "crashed", ...event }));
      active.qmd.on("diagnostic", (message) => this.emit("knowledge-diagnostic", message));
    }
    return active.qmd.request("initialize", {});
  }

  requireKnowledge() {
    const active = this.requireActive();
    if (!active.qmd || !active.workspaceId) {
      const error = new Error("Local knowledge has not been initialized for the active project.");
      error.code = "QMD_NOT_INITIALIZED";
      throw error;
    }
    return active;
  }

  async knowledge(method, payload, options = {}) {
    const active = this.requireKnowledge();
    if (options.jobType) {
      return active.jobs.run(options.jobType, payload, () => active.qmd.request(method, payload));
    }
    return active.qmd.request(method, payload);
  }

  async close() {
    if (!this.active) return { closed: true };
    const active = this.active;
    this.active = null;
    await active.jobs.close().catch(() => {});
    await active.qmd?.close().catch(() => {});
    this.emit("closed");
    return { closed: true };
  }
}
