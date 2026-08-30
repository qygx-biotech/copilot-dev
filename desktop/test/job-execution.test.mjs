import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ProjectFilesystem } from "../services/project-filesystem.mjs";
import { JobManager } from "../services/job-manager.mjs";
import { LocalExecutionService } from "../services/local-execution-service.mjs";

const temporaryRoots = [];
afterEach(async () => Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

test("desktop jobs persist sanitized structured state inside the project", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "biodesign-job-"));
  temporaryRoots.push(root);
  const filesystem = await ProjectFilesystem.open(root);
  const manager = new JobManager(filesystem);
  const result = await manager.run("knowledge-update", { collections: ["topics"] }, async ({ report }) => {
    await report({ completed: 1, total: 1 });
    return { updated: 1 };
  });
  assert.deepEqual(result, { updated: 1 });
  const [job] = await manager.list();
  assert.equal(job.status, "completed");
  assert.deepEqual(job.progress, { completed: 1, total: 1 });

  const reopened = new JobManager(filesystem);
  const [persisted] = await reopened.list();
  assert.equal(persisted.id, job.id);
  assert.equal(persisted.status, "completed");
});

test("local execution rejects unregistered workflows and never accepts shell strings", async () => {
  const execution = new LocalExecutionService();
  assert.deepEqual(execution.list(), []);
  await assert.rejects(
    () => execution.run("shell", { command: "rm -rf anything" }, {}),
    { code: "WORKFLOW_NOT_ALLOWED" }
  );
});
