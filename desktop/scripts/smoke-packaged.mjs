import { access, mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";

const platform = process.platform;
const architecture = process.arch;
const appRoot = process.env.BIODESIGN_SMOKE_APP_ROOT
  ? path.resolve(process.env.BIODESIGN_SMOKE_APP_ROOT)
  : path.resolve("out", `BioDesign-${platform}-${architecture}`);
const executable = platform === "darwin"
  ? path.join(appRoot, "BioDesign.app", "Contents", "MacOS", "BioDesign")
  : platform === "win32"
    ? path.join(appRoot, "BioDesign.exe")
    : path.join(appRoot, "BioDesign");

await access(executable);
const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "biodesign-packaged-smoke-"));
const resultPath = path.join(temporaryRoot, "result.json");
const emptyModelCache = path.join(temporaryRoot, "empty-model-cache");
const workspaceId = "packaged-qmd-smoke-workspace";
await mkdir(path.join(temporaryRoot, ".biodesign", "knowledge", "literature"), { recursive: true });
await writeFile(path.join(temporaryRoot, ".biodesign", "workspace.json"), `${JSON.stringify({ schemaVersion: 1, workspaceId, name: "Packaged Smoke", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }, null, 2)}\n`);
await writeFile(path.join(temporaryRoot, ".biodesign", "knowledge", "literature", "smoke-marker.md"), "---\nsource_id: smoke-marker\n---\n# Packaged QMD\ndesktop qmd smoke marker\n");
const smokeArguments = [
  "--smoke-test",
  `--smoke-qmd-project=${temporaryRoot}`,
  `--smoke-qmd-cache=${emptyModelCache}`,
  `--smoke-result=${resultPath}`,
];
const child = spawn(executable, smokeArguments, {
  env: { ...process.env, BIODESIGN_SMOKE_PROJECT: temporaryRoot },
  stdio: "inherit",
});
const exit = await new Promise((resolve, reject) => {
  child.once("error", reject);
  child.once("exit", (code, signal) => resolve({ code, signal }));
});
const resultText = await readFile(resultPath, "utf8").catch(() => "");
if (exit.code !== 0) {
  throw new Error(`Packaged application smoke exited with code ${exit.code} and signal ${exit.signal || "none"}. Result: ${resultText || "unavailable"}`);
}
const result = JSON.parse(resultText);
if (!result.rendererLoaded || !result.security?.contextIsolation || result.security?.nodeIntegration) {
  throw new Error(`Packaged smoke failed: ${JSON.stringify(result)}`);
}
if (!result.qmd?.available || !result.qmd?.matchedSmokeMarker) throw new Error(`Packaged QMD smoke failed: ${JSON.stringify(result.qmd)}`);
if ((result.qmd.nativeDiagnostics || []).some((message) => /sqlite-vec|dlopen|vec0\./i.test(message))) {
  throw new Error(`Packaged sqlite-vec smoke failed: ${JSON.stringify(result.qmd.nativeDiagnostics)}`);
}

async function collectFiles(directory, collected = []) {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") return collected;
    throw error;
  }
  for (const entry of entries) {
    const absolutePath = path.join(directory, entry.name);
    if (entry.isDirectory()) await collectFiles(absolutePath, collected);
    else collected.push(path.relative(directory, absolutePath));
  }
  return collected;
}

const modelCacheFiles = await collectFiles(emptyModelCache);
const localModelWeights = modelCacheFiles.filter((file) =>
  /(?:\.gguf|\.safetensors|qwen|embeddinggemma|query-expansion|reranker)/i.test(file)
);
if (localModelWeights.length) {
  throw new Error(`Packaged Fast smoke downloaded local model weights: ${localModelWeights.join(", ")}`);
}
result.qmd.localModelWeights = localModelWeights;
console.log(JSON.stringify(result, null, 2));
await rm(temporaryRoot, { recursive: true, force: true });
