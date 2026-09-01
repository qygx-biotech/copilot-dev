import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const packageRoot = path.resolve("node_modules", "sqlite-vec");
const packageMetadata = JSON.parse(await readFile(path.join(packageRoot, "package.json"), "utf8"));
if (packageMetadata.version !== "0.1.9") {
  throw new Error(`Review the Electron sqlite-vec path patch for version ${packageMetadata.version}.`);
}

const original = "  return loadablePath;";
const patched = `  // Electron keeps raw SQLite extensions outside app.asar so dlopen can read them.
  // Preserve ordinary Node behavior while translating only the packaged-app boundary.
  return loadablePath
    .replace(\"/app.asar/\", \"/app.asar.unpacked/\")
    .replace(\"\\\\app.asar\\\\\", \"\\\\app.asar.unpacked\\\\\");`;

for (const filename of ["index.mjs", "index.cjs"]) {
  const target = path.join(packageRoot, filename);
  const source = await readFile(target, "utf8");
  if (source.includes(patched)) continue;
  const occurrences = source.split(original).length - 1;
  if (occurrences !== 1) throw new Error(`Unexpected sqlite-vec ${filename}; refusing an unsafe patch.`);
  await writeFile(target, source.replace(original, patched), "utf8");
}
