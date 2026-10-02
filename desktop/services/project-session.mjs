import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { PlaywrightMcpClient } from "./playwright-mcp-client.mjs";
import { LiteratureWorkflows } from "./literature-workflows.mjs";
import { EventEmitter } from "node:events";
import { ProjectFilesystem } from "./project-filesystem.mjs";
import { JobManager } from "./job-manager.mjs";
import { LocalExecutionService } from "./local-execution-service.mjs";
import { downloadSources } from "./source-downloader.mjs";
import { QmdWorkerClient } from "../workers/qmd-worker-client.mjs";
import { PaperMcpClient } from "./paper-mcp-client.mjs";
import { registerAcademicWorkflows } from "./academic-workflows.mjs";
import { SkillsService } from "./skills-service.mjs";
import { GenericMcpService } from "./generic-mcp-service.mjs";
import { assertOnlyKeys, assertRecord, boundedString, ValidationError } from "../ipc/validation.mjs";

export class ProjectSessionManager extends EventEmitter {
  constructor(options) {
    super();
    this.utilityProcess = options.utilityProcess;
    this.appPath = options.appPath;
    this.qmdCacheRoot = options.qmdCacheRoot;
    this.bundledSkillsPath = options.bundledSkillsPath || null;
    this.paperOptions = { appPath: options.appPath, resourcesPath: options.resourcesPath, packaged: options.packaged };
    this.browserOptions = { profileRoot: options.browserProfileRoot || (options.qmdCacheRoot ? path.join(options.qmdCacheRoot, "library-browser") : path.join(os.tmpdir(), "biodesign-browser", crypto.randomUUID())), headless: options.browserHeadless === true };
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
      sourceDownloads: new AbortController(),
    };
    const active = this.active;
    active.skills = new SkillsService(filesystem, { bundledSkillsPath: this.bundledSkillsPath });
    active.genericMcp = new GenericMcpService({ filesystem });
    active.genericMcpCalls = new Map();
    const runtimeWorkflow = (id, keys, effect, runner) => active.execution.register({ id, effect }, async input => {
      assertOnlyKeys(input, keys, "input");
      if (this.active !== active || active.sourceDownloads.signal.aborted) throw new ValidationError("PROJECT_MISMATCH", "The runtime request belongs to a closed project.");
      const result = await runner(input);
      if (this.active !== active || active.sourceDownloads.signal.aborted) throw new ValidationError("PROJECT_MISMATCH", "The active project changed during the runtime request.");
      return result;
    });
    runtimeWorkflow("runtime_skills_list", [], "informational", () => active.skills.list());
    runtimeWorkflow("runtime_skills_context", ["text"], "informational", input => active.skills.context(input.text ?? ""));
    runtimeWorkflow("runtime_skills_read", ["name", "forAgent"], "informational", input => {
      if (input.forAgent !== undefined && typeof input.forAgent !== "boolean") throw new ValidationError("INVALID_INPUT", "forAgent must be a boolean.");
      return active.skills.read(input.name, { forAgent: input.forAgent === true });
    });
    runtimeWorkflow("runtime_skills_save", ["name", "content"], "runtime_configuration", input => active.skills.save(input));
    runtimeWorkflow("runtime_skills_enable", ["name", "enabled"], "runtime_configuration", input => active.skills.setEnabled(input.name, input.enabled));
    runtimeWorkflow("runtime_mcp_list", [], "informational", () => active.genericMcp.list());
    runtimeWorkflow("runtime_mcp_save", ["name", "config"], "runtime_configuration", input => active.genericMcp.save(input));
    for (const action of ["remove", "connect", "disconnect"]) {
      runtimeWorkflow(`runtime_mcp_${action}`, ["name"], "runtime_configuration", async input => {
        await active.genericMcp[action](boundedString(input.name, "name", 32));
        return active.genericMcp.list();
      });
    }
    runtimeWorkflow("runtime_mcp_definitions", [], "informational", async () => ({ tools: await active.genericMcp.definitions() }));
    runtimeWorkflow("runtime_mcp_cancel", ["callId"], "runtime_control", input => {
      const callId = boundedString(input.callId, "callId", 256);
      const pending = active.genericMcpCalls.get(callId);
      pending?.controller.abort();
      return { callId, cancelled: Boolean(pending) };
    });
    runtimeWorkflow("runtime_mcp_call", ["call", "surface", "permission"], "external_mcp", async input => {
      const call = assertOnlyKeys(assertRecord(input.call, "call"), ["id", "name", "args"], "call");
      const callId = boundedString(call.id, "call.id", 256);
      // Duplicate delivery shares both the receipt and cancellation lifetime.
      // An early duplicate failure must not remove the original call's handle.
      let pending = active.genericMcpCalls.get(callId);
      if (!pending) {
        pending = { controller: new AbortController(), count: 0 };
        active.genericMcpCalls.set(callId, pending);
      }
      pending.count += 1;
      try {
        return await active.genericMcp.call(call, {
          surface: input.surface, permission: input.permission, projectId: active.filesystem.id,
          signal: AbortSignal.any([active.sourceDownloads.signal, pending.controller.signal]), isCurrent: () => this.active === active,
        });
      } finally {
        pending.count -= 1;
        if (!pending.count && active.genericMcpCalls.get(callId) === pending) active.genericMcpCalls.delete(callId);
      }
    });
    active.paperMcp = new PaperMcpClient(this.paperOptions);
    registerAcademicWorkflows(active, active.paperMcp, () => this.active === active);
    active.browserMcp = new PlaywrightMcpClient({ ...this.browserOptions, profileRoot: path.join(this.browserOptions.profileRoot, crypto.createHash('sha256').update(filesystem.root).digest('hex').slice(0, 24)) });
    active.literature = new LiteratureWorkflows(active, active.browserMcp, () => this.active === active);
    active.execution.register({ id: 'literature_worker', effect: 'bounded_specialist' }, input => active.literature.run(input));
    active.execution.register({ id: 'literature_jobs', effect: 'informational' }, input => {
      if (Object.keys(input).length) throw Object.assign(new Error('Invalid job listing'), { code: 'INVALID_INPUT' });
      return active.literature.list();
    });
    active.execution.register({ id: "download_sources", effect: "source_write" }, (input, context) => downloadSources(input, {
      ...context, signal: active.sourceDownloads.signal, isCurrent: () => this.active === active,
    }));
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

  hasRunningJobs() {
    return this.active?.jobs.hasRunningJobs() || false;
  }

  async close() {
    if (!this.active) return { closed: true };
    const active = this.active;
    this.active = null;
    active.sourceDownloads.abort();
    await active.genericMcp?.close().catch(() => {});
    await active.browserMcp?.close().catch(() => {});
    await active.paperMcp?.close().catch(() => {});
    await active.jobs.close().catch(() => {});
    await active.qmd?.close().catch(() => {});
    this.emit("closed");
    return { closed: true };
  }
}
