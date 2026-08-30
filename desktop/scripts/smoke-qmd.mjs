import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";

const projectRoot = await mkdtemp(path.join(os.tmpdir(), "biodesign-electron-qmd-"));
const workspaceId = "desktop-qmd-smoke-workspace";
const resultPath = path.join(projectRoot, "result.json");
await mkdir(path.join(projectRoot, ".biodesign", "knowledge", "literature"), { recursive: true });
await writeFile(path.join(projectRoot, ".biodesign", "workspace.json"), `${JSON.stringify({
  schemaVersion: 1,
  workspaceId,
  name: "Desktop QMD Smoke",
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
}, null, 2)}\n`);
await writeFile(path.join(projectRoot, ".biodesign", "knowledge", "literature", "smoke-marker.md"), [
  "---",
  "source_id: smoke-marker",
  "---",
  "# Electron utility-process lexical smoke",
  "desktop qmd smoke marker",
  "",
].join("\n"));

const electronCli = path.resolve("node_modules", "electron", "cli.js");
const child = spawn(process.execPath, [
  electronCli,
  "desktop/main/main.mjs",
  "--smoke-test",
  `--smoke-qmd-project=${projectRoot}`,
  `--smoke-result=${resultPath}`,
], { stdio: "inherit" });
const exitCode = await new Promise((resolve, reject) => {
  child.once("error", reject);
  child.once("exit", resolve);
});
if (exitCode !== 0) throw new Error(`Electron QMD smoke exited with ${exitCode}.`);
const result = JSON.parse(await readFile(resultPath, "utf8"));
if (!result.qmd?.available || !result.qmd?.matchedSmokeMarker) {
  throw new Error(`Electron QMD smoke failed: ${JSON.stringify(result.qmd)}`);
}
if ((result.qmd.nativeDiagnostics || []).some((message) => /sqlite-vec|dlopen|vec0\./i.test(message))) {
  throw new Error(`Electron sqlite-vec smoke failed: ${JSON.stringify(result.qmd.nativeDiagnostics)}`);
}
console.log(JSON.stringify(result, null, 2));
await rm(projectRoot, { recursive: true, force: true });
