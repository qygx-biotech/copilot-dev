import crypto from "node:crypto";
import { sanitizeError, ValidationError } from "../ipc/validation.mjs";

const INDEX_PATH = ".biodesign/jobs/desktop-index.json";
const TERMINAL = new Set(["completed", "failed", "cancelled", "stale"]);

export class JobManager {
  constructor(filesystem, options = {}) {
    this.filesystem = filesystem;
    this.now = options.now || (() => new Date());
    this.jobs = new Map();
    this.controllers = new Map();
    this.loaded = false;
  }

  async load() {
    if (this.loaded) return;
    this.loaded = true;
    if (!(await this.filesystem.exists(INDEX_PATH))) return;
    try {
      const payload = JSON.parse(await this.filesystem.readText(INDEX_PATH));
      for (const raw of Array.isArray(payload.jobs) ? payload.jobs : []) {
        const job = { ...raw };
        if (job.status === "running" || job.status === "queued") {
          job.status = "stale";
          job.updatedAt = this.now().toISOString();
          job.error = { code: "DESKTOP_RESTARTED", message: "The desktop application closed before this job finished." };
        }
        this.jobs.set(job.id, job);
      }
      await this.persist();
    } catch {
      const error = new Error("The desktop job index is malformed and was preserved.");
      error.code = "INVALID_JOB_INDEX";
      throw error;
    }
  }

  async persist() {
    const jobs = [...this.jobs.values()].sort((left, right) => right.createdAt.localeCompare(left.createdAt)).slice(0, 500);
    await this.filesystem.writeText(INDEX_PATH, `${JSON.stringify({ schemaVersion: 1, jobs, updatedAt: this.now().toISOString() }, null, 2)}\n`);
  }

  publicJob(job) {
    if (!job) return null;
    return JSON.parse(JSON.stringify(job));
  }

  async run(type, input, runner) {
    await this.load();
    const timestamp = this.now().toISOString();
    const job = {
      id: crypto.randomUUID(),
      type,
      status: "queued",
      input,
      progress: null,
      createdAt: timestamp,
      updatedAt: timestamp,
      startedAt: null,
      completedAt: null,
      output: null,
      error: null,
    };
    const controller = new AbortController();
    this.jobs.set(job.id, job);
    this.controllers.set(job.id, controller);
    await this.persist();
    job.status = "running";
    job.startedAt = this.now().toISOString();
    job.updatedAt = job.startedAt;
    await this.persist();
    const report = async (progress) => {
      job.progress = progress;
      job.updatedAt = this.now().toISOString();
      await this.persist();
    };
    try {
      const result = await runner({ signal: controller.signal, report, jobId: job.id });
      if (controller.signal.aborted) {
        job.status = "cancelled";
      } else {
        job.status = "completed";
        job.output = compactOutput(result);
      }
      job.completedAt = this.now().toISOString();
      job.updatedAt = job.completedAt;
      await this.persist();
      return result;
    } catch (error) {
      job.status = controller.signal.aborted ? "cancelled" : "failed";
      job.error = sanitizeError(error);
      job.completedAt = this.now().toISOString();
      job.updatedAt = job.completedAt;
      await this.persist();
      throw error;
    } finally {
      this.controllers.delete(job.id);
    }
  }

  async list() {
    await this.load();
    return [...this.jobs.values()].sort((left, right) => right.createdAt.localeCompare(left.createdAt)).map((job) => this.publicJob(job));
  }

  async status(id) {
    await this.load();
    return this.publicJob(this.jobs.get(id));
  }

  async cancel(id) {
    await this.load();
    const job = this.jobs.get(id);
    if (!job) throw new ValidationError("JOB_NOT_FOUND", "The requested desktop job does not exist.");
    if (TERMINAL.has(job.status)) return this.publicJob(job);
    this.controllers.get(id)?.abort();
    job.status = "cancelled";
    job.updatedAt = this.now().toISOString();
    job.completedAt = job.updatedAt;
    await this.persist();
    return this.publicJob(job);
  }

  async close() {
    for (const controller of this.controllers.values()) controller.abort();
    for (const job of this.jobs.values()) {
      if (job.status === "running" || job.status === "queued") {
        job.status = "stale";
        job.updatedAt = this.now().toISOString();
      }
    }
    if (this.loaded) await this.persist();
    this.controllers.clear();
  }
}

function compactOutput(result) {
  if (result === undefined) return null;
  const json = JSON.stringify(result);
  if (json.length <= 16_000) return JSON.parse(json);
  return { truncated: true, byteLength: Buffer.byteLength(json) };
}
