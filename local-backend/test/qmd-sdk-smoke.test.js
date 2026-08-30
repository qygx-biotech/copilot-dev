import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { ProjectQmdManager } from "../src/project-qmd-manager.js";

test("real QMD 2.8.3 SDK indexes and lexically retrieves a project-local paper mirror", async (t) => {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), "biodesign-real-qmd-"));
  t.after(() => rm(projectRoot, { recursive: true, force: true }));
  await mkdir(path.join(projectRoot, ".biodesign/knowledge/literature"), { recursive: true });
  await writeFile(
    path.join(projectRoot, ".biodesign/workspace.json"),
    `${JSON.stringify({ schemaVersion: 1, workspaceId: "real-qmd-smoke" })}\n`
  );
  await writeFile(
    path.join(projectRoot, ".biodesign/knowledge/literature/paper-017.md"),
    [
      "---",
      "source_id: paper-017",
      "title: EctD thermostability",
      "content_hash: sha256:test",
      "---",
      "",
      "# EctD thermostability",
      "",
      "## Page 7",
      "",
      "The A163V EctD variant retained activity after thermal challenge.",
      "",
    ].join("\n")
  );
  const manager = new ProjectQmdManager({ projectRoot });
  t.after(() => manager.close());

  const update = await manager.update({
    workspaceId: "real-qmd-smoke",
    collections: ["literature-evidence"],
  });
  assert.equal(update.indexed, 1);
  const search = await manager.search({
    workspaceId: "real-qmd-smoke",
    query: "A163V EctD",
    mode: "fast",
    collections: ["literature-evidence"],
    limit: 5,
  });
  assert.equal(search.results[0].paperId, "paper-017");
  assert.match(search.results[0].matchedSections[0].snippet, /A163V/);
  assert.match(search.results[0].matchedSections[0].qmdDoc, /qmd:\/\/literature-evidence/);
  const status = await manager.status();
  assert.equal(status.qmdStatus.totalDocuments, 1);
  assert.match(status.dbPath, /\.biodesign\/knowledge\/qmd\/index\.sqlite$/);
});
