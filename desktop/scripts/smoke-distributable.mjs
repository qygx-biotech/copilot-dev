import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";

if (process.platform !== "darwin") {
  throw new Error("The current distributable smoke extracts the macOS ZIP; validate Windows on Windows.");
}

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: "inherit", ...options });
    child.once("error", reject);
    child.once("exit", (code) => code === 0 ? resolve() : reject(new Error(`${command} exited with ${code}.`)));
  });
}

const packageMetadata = JSON.parse(await readFile(path.resolve("package.json"), "utf8"));
const archive = path.resolve(
  "out",
  "make",
  "zip",
  "darwin",
  process.arch,
  `BioDesign-darwin-${process.arch}-${packageMetadata.version}.zip`,
);
await access(archive);
const extractionRoot = await mkdtemp(path.join(os.tmpdir(), "biodesign-distributable-smoke-"));
try {
  await run("/usr/bin/ditto", ["-x", "-k", archive, extractionRoot]);
  await run(process.execPath, ["desktop/scripts/smoke-packaged.mjs"], {
    env: { ...process.env, BIODESIGN_SMOKE_APP_ROOT: extractionRoot },
  });
} finally {
  await rm(extractionRoot, { recursive: true, force: true });
}
