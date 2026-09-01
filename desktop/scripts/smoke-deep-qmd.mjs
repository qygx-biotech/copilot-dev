import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ProjectQmdManager } from "../../local-backend/src/project-qmd-manager.js";

const projectRoot = await mkdtemp(path.join(os.tmpdir(), "biodesign-deep-qmd-"));
const workspaceId = "deep-qmd-smoke-workspace";
const marker = "A163V improves EctD thermal stability";
const manager = new ProjectQmdManager({ projectRoot });

try {
  await mkdir(path.join(projectRoot, ".biodesign", "knowledge", "literature"), { recursive: true });
  await writeFile(path.join(projectRoot, ".biodesign", "workspace.json"), `${JSON.stringify({
    schemaVersion: 1,
    workspaceId,
    name: "Deep QMD Smoke",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  }, null, 2)}\n`);
  await writeFile(path.join(projectRoot, ".biodesign", "knowledge", "literature", "paper-017.md"), [
    "---",
    "source_id: paper-017",
    "---",
    "# EctD mutation evidence",
    marker,
    "The mutation improves thermostability without changing the enzyme identity.",
    "",
  ].join("\n"));

  const update = await manager.update({ workspaceId, collections: ["literature-evidence"] });
  const started = Date.now();
  const search = await manager.search({
    workspaceId,
    query: "A163V EctD thermal stability",
    mode: "deep",
    collections: ["literature-evidence"],
    paperIds: ["paper-017"],
    limit: 5,
    candidateLimit: 20,
    intent: "identify mutation evidence",
  });
  const matched = JSON.stringify(search.results).includes("paper-017") && JSON.stringify(search.results).includes("A163V");
  if (!matched) throw new Error(`Deep QMD smoke did not retrieve the marker: ${JSON.stringify(search.results)}`);
  console.log(JSON.stringify({
    qmdPackageVersion: "2.8.3",
    nodeVersion: process.version,
    update,
    mode: search.mode,
    localStage: search.diagnostics.localStage,
    cloudAssistanceRequired: search.diagnostics.cloudAssistanceRequired,
    resultCount: search.results.length,
    matched,
    durationMs: Date.now() - started,
  }, null, 2));
} finally {
  await manager.close().catch(() => {});
  await rm(projectRoot, { recursive: true, force: true });
}
