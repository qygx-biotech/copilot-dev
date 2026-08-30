import { access, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";
import {
  archiveEntryForExtraction,
  normalizeArchiveEntry,
} from "./archive-paths.mjs";

const require = createRequire(import.meta.url);
const asar = require("@electron/asar");
const packageRoot = path.resolve("out", `BioDesign-${process.platform}-${process.arch}`);
const resourcesRoot = process.platform === "darwin"
  ? path.join(packageRoot, "BioDesign.app", "Contents", "Resources")
  : path.join(packageRoot, "resources");
const archivePath = path.join(resourcesRoot, "app.asar");
await access(archivePath);

const archiveEntries = asar.listPackage(archivePath).map((raw) => ({
  raw,
  normalized: normalizeArchiveEntry(raw),
}));
const entries = archiveEntries.map(({ normalized }) => normalized);
const localModelWeights = entries.filter((entry) => /\.(?:gguf|safetensors)$/i.test(entry));
if (localModelWeights.length) {
  throw new Error(`Local model weights were packaged: ${localModelWeights.join(", ")}`);
}
for (const forbidden of ["/alibaba-fc", "/worker", "/learn-claude-code"]) {
  if (entries.some((entry) => entry === forbidden || entry.startsWith(`${forbidden}/`))) {
    throw new Error(`Forbidden deployable server tree was packaged: ${forbidden}`);
  }
}
for (const obsolete of ["/local-backend/src/server.js", "/local-backend/src/knowledge-cli.js"]) {
  if (entries.includes(obsolete)) throw new Error(`Obsolete localhost production path was packaged: ${obsolete}`);
}
if (entries.some((entry) => entry.startsWith("/desktop/scripts/") || entry.startsWith("/desktop/test/"))) {
  throw new Error("Build/test-only desktop files were packaged.");
}
if (entries.some((entry) => entry.startsWith("/local-backend/node_modules/"))) {
  throw new Error("The compatibility backend dependency tree was duplicated into the desktop package.");
}
if (!entries.includes("/local-backend/package.json")) {
  throw new Error("The reusable ESM QMD manager package boundary is missing.");
}

const sqliteVecLoaderEntry = archiveEntries.find(
  ({ normalized }) => normalized === "/node_modules/sqlite-vec/index.mjs"
);
if (!sqliteVecLoaderEntry) throw new Error("The packaged sqlite-vec loader is missing.");
const sqliteVecLoader = asar.extractFile(
  archivePath,
  archiveEntryForExtraction(sqliteVecLoaderEntry.raw)
).toString("utf8");
if (!sqliteVecLoader.includes("app.asar.unpacked")) {
  throw new Error("The packaged sqlite-vec loader does not translate the ASAR native-library path.");
}
const sqliteVecLibraryNames = {
  darwin: `sqlite-vec-darwin-${process.arch}/vec0.dylib`,
  linux: `sqlite-vec-linux-${process.arch}/vec0.so`,
  win32: `sqlite-vec-windows-${process.arch}/vec0.dll`,
};
const sqliteVecLibrary = path.join(resourcesRoot, "app.asar.unpacked", "node_modules", sqliteVecLibraryNames[process.platform]);
await access(sqliteVecLibrary);

const textExtensions = new Set([".cjs", ".html", ".js", ".json", ".mjs"]);
const suspicious = [];
for (const { raw, normalized: entry } of archiveEntries) {
  if (!textExtensions.has(path.extname(entry))) continue;
  const bytes = asar.extractFile(archivePath, archiveEntryForExtraction(raw));
  if (bytes.byteLength > 10 * 1024 * 1024) continue;
  const text = bytes.toString("utf8");
  if (/https?:\/\/[^\s"']*requesty\.ai/i.test(text) || /REQUESTY_API_KEY\s*[:=]/.test(text)) {
    suspicious.push(entry);
  }
}
if (suspicious.length) throw new Error(`Direct Requesty path or credential marker found in package: ${suspicious.join(", ")}`);

async function nativeFiles(directory, result = []) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const absolutePath = path.join(directory, entry.name);
    if (entry.isDirectory()) await nativeFiles(absolutePath, result);
    else if (entry.name.endsWith(".node")) result.push(path.relative(resourcesRoot, absolutePath));
  }
  return result;
}

const natives = await nativeFiles(resourcesRoot);
const archiveSize = (await stat(archivePath)).size;
if (!natives.length) throw new Error("No unpacked native modules were found in the desktop package.");
console.log(JSON.stringify({
  packageRoot,
  archiveBytes: archiveSize,
  entryCount: entries.length,
  nativeModuleCount: natives.length,
  nativeModuleExamples: natives.slice(0, 8),
  sqliteVecLibrary: path.relative(packageRoot, sqliteVecLibrary),
  sqliteVecLibraryUnpacked: true,
  compatibilityDependenciesExcluded: true,
  serverTreesExcluded: true,
  directRequestyPaths: 0,
  localModelWeightFiles: 0,
}, null, 2));
