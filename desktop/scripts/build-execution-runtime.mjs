#!/usr/bin/env node
// Builds BioDesign's execution runtime: CPython 3.12 with a fixed scientific
// package set plus a Node binary, packed per target as one tar.gz. The app
// downloads a published archive on first use and verifies the SHA-256 recorded
// in desktop/runtime/execution-runtime.json; nothing here runs in the app.
//
//   node desktop/scripts/build-execution-runtime.mjs lock
//     Resolves lock.json's packages for every target with pip and writes
//     python-requirements.txt, pinned to the wheel hashes of all targets.
//   node desktop/scripts/build-execution-runtime.mjs build [--target <target>] [--manifest]
//     Downloads and verifies the pinned interpreter and Node, installs the
//     locked wheels, removes tests and tools, precompiles bytecode, and packs
//     out/execution-runtime/biodesign-runtime-<version>-<target>.tar.gz.
//     --manifest records the archive in the app's manifest.
// Requires a macOS build host (bsdtar). Inputs: desktop/scripts/execution-runtime/.
import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { chmod, copyFile, mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const inputs = path.join(repository, "desktop/scripts/execution-runtime");
const lock = JSON.parse(await readFile(path.join(inputs, "lock.json"), "utf8"));
const requirementsFile = path.join(inputs, "python-requirements.txt");
const manifestFile = path.join(repository, "desktop/runtime/execution-runtime.json");
const outputDirectory = path.join(repository, "out/execution-runtime");
const cache = path.join(outputDirectory, "cache");
const RELEASES = "https://github.com/qygx-biotech/copilot-dev/releases/download";

const fail = message => { throw new Error(message); };
const host = `${process.platform}-${process.arch}`;
const windows = target => target.startsWith("win32");
const layout = target => windows(target)
  ? { python: "python/python.exe", stdlib: "python/Lib", site: "python/Lib/site-packages", node: "node/node.exe" }
  : { python: "python/bin/python3", stdlib: "python/lib/python3.12", site: "python/lib/python3.12/site-packages", node: "node/bin/node" };

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "inherit", "inherit"], ...options });
    child.on("error", reject);
    child.on("close", code => code === 0 ? resolve() : reject(new Error(`${path.basename(command)} exited with ${code}`)));
  });
}

async function sha256File(file) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
}

// Downloads once into the cache and refuses any file whose hash differs from the lock.
async function download(url, file, sha256) {
  const target = path.join(cache, file);
  if (await stat(target).catch(() => null) && await sha256File(target) === sha256) return target;
  await mkdir(cache, { recursive: true });
  const response = await fetch(url, { redirect: "follow" });
  if (!response.ok || !response.body) fail(`Download failed (${response.status}): ${url}`);
  const partial = `${target}.partial`;
  await pipeline(Readable.fromWeb(response.body), createWriteStream(partial));
  const actual = await sha256File(partial);
  if (actual !== sha256) { await rm(partial, { force: true }); fail(`SHA-256 mismatch for ${file}: ${actual}`); }
  await rename(partial, target);
  return target;
}

async function fresh(directory) { await rm(directory, { recursive: true, force: true }); await mkdir(directory, { recursive: true }); return directory; }

async function interpreter(target, directory) {
  const asset = lock.python.assets[target] || fail(`No interpreter is locked for ${target}.`);
  const archive = await download(`${lock.python.baseUrl}/${encodeURIComponent(asset.file)}`, asset.file, asset.sha256);
  await run("tar", ["-xf", archive, "-C", directory]);
  return path.join(directory, layout(target).python);
}

// The build host's own locked interpreter runs pip and compileall for every target.
let toolPython;
async function tool() {
  return toolPython ||= interpreter(host, await fresh(path.join(cache, `tool-${host}`)));
}

const pipTarget = target => ["--only-binary=:all:", "--python-version", "3.12", "--implementation", "cp",
  ...lock.pipPlatforms[target].flatMap(platform => ["--platform", platform])];

async function lockRequirements() {
  const python = await tool(), resolved = new Map();
  for (const target of lock.targets) {
    const work = await fresh(path.join(outputDirectory, `resolve-${target}`)), report = path.join(work, "report.json");
    await run(python, ["-m", "pip", "install", "--quiet", "--dry-run", "--ignore-installed", "--report", report, ...pipTarget(target),
      "--target", path.join(work, "site"), ...lock.packages]);
    for (const item of JSON.parse(await readFile(report, "utf8")).install) {
      const name = item.metadata.name.toLowerCase().replaceAll("_", "-"), version = item.metadata.version;
      const entry = resolved.get(name) || { version, hashes: new Set() };
      if (entry.version !== version) fail(`${name} resolves to ${entry.version} and ${version} on different targets.`);
      entry.hashes.add(item.download_info.archive_info.hashes.sha256);
      resolved.set(name, entry);
    }
  }
  const lines = ["# Generated by desktop/scripts/build-execution-runtime.mjs lock. Do not edit.",
    `# Targets: ${lock.targets.join(", ")}. Wheels only; hashes cover every target.`];
  for (const [name, entry] of [...resolved].sort(([a], [b]) => a.localeCompare(b)))
    lines.push(`${name}==${entry.version} \\`, ...[...entry.hashes].sort().map((hash, index, all) => `    --hash=sha256:${hash}${index < all.length - 1 ? " \\" : ""}`));
  await writeFile(requirementsFile, `${lines.join("\n")}\n`);
  console.log(`Locked ${resolved.size} packages for ${lock.targets.join(", ")}.`);
}

// Tests, package tools, GUI toolkits and caches are never used in the sandbox.
async function prune(staging, target) {
  const paths = layout(target), remove = relative => rm(path.join(staging, relative), { recursive: true, force: true });
  for (const name of ["ensurepip", "idlelib", "tkinter", "turtledemo", "test", "lib2to3"]) await remove(`${paths.stdlib}/${name}`);
  for (const name of await readdir(path.join(staging, paths.site))) if (/^(pip|setuptools|wheel)([-_.]|$)/i.test(name) || name === "bin") await remove(`${paths.site}/${name}`);
  if (windows(target)) {
    for (const name of ["Scripts", "tcl"]) await remove(`python/${name}`);
    for (const name of await readdir(path.join(staging, "python/DLLs"))) if (/^(_tkinter|tcl|tk)/i.test(name)) await remove(`python/DLLs/${name}`);
  } else {
    for (const name of await readdir(path.join(staging, "python/bin"))) if (/^(pip|idle|2to3|pydoc)/.test(name)) await remove(`python/bin/${name}`);
    for (const name of await readdir(path.join(staging, "python/lib"))) if (/^(tcl|tk|itcl|thread|tdbc)/i.test(name)) await remove(`python/lib/${name}`);
    for (const name of await readdir(path.join(staging, paths.stdlib, "lib-dynload"))) if (/^_tkinter/.test(name)) await remove(`${paths.stdlib}/lib-dynload/${name}`);
  }
  const visit = async relative => {
    for (const entry of await readdir(path.join(staging, relative), { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const child = `${relative}/${entry.name}`;
      if (["tests", "__pycache__"].includes(entry.name) || (entry.name === "test" && relative !== paths.stdlib)) await remove(child);
      else await visit(child);
    }
  };
  await visit(paths.site);
}

async function build(target) {
  if (!lock.targets.includes(target)) fail(`Unknown target ${target}. Targets: ${lock.targets.join(", ")}.`);
  const paths = layout(target), staging = await fresh(path.join(outputDirectory, `staging-${target}`));
  const python = await tool();
  await interpreter(target, staging);
  await run(python, ["-m", "pip", "install", "--quiet", "--no-deps", "--require-hashes", "--no-compile", ...pipTarget(target),
    "--target", path.join(staging, paths.site), "-r", requirementsFile]);
  await prune(staging, target);
  // Bytecode is checked by hash, not file time, and the sandbox cannot write caches.
  await run(python, ["-m", "compileall", "-q", "-j", "0", "--invalidation-mode", "unchecked-hash", path.join(staging, paths.stdlib)]);

  const nodeAsset = lock.node.assets[target];
  const nodeArchive = await download(`${lock.node.baseUrl}/${nodeAsset.file}`, nodeAsset.file, nodeAsset.sha256);
  const nodeWork = await fresh(path.join(cache, `node-${target}`));
  await run("tar", ["-xf", nodeArchive, "-C", nodeWork]);
  const nodeRoot = path.join(nodeWork, nodeAsset.file.replace(/\.(tar\.gz|zip)$/, ""));
  await mkdir(path.dirname(path.join(staging, paths.node)), { recursive: true });
  await copyFile(path.join(nodeRoot, windows(target) ? "node.exe" : "bin/node"), path.join(staging, paths.node));
  await chmod(path.join(staging, paths.node), 0o755);
  await copyFile(path.join(nodeRoot, "LICENSE"), path.join(staging, "node/LICENSE"));

  const packages = Object.fromEntries((await readFile(requirementsFile, "utf8")).split("\n").map(line => /^([a-z0-9-]+)==(\S+)/.exec(line)).filter(Boolean).map(match => [match[1], match[2]]));
  await writeFile(path.join(staging, "BIODESIGN_RUNTIME.json"), `${JSON.stringify({ version: 1, runtimeVersion: lock.runtimeVersion, target,
    python: { version: lock.python.version, executable: paths.python }, node: { version: lock.node.version, executable: paths.node }, packages }, null, 2)}\n`);
  if (target === host) {
    await run(path.join(staging, paths.python), ["-I", "-c", `import ${lock.packages.join(", ")}; print("python packages ok")`]);
    await run(path.join(staging, paths.node), ["-e", "console.log('node', process.version)"]);
  }

  const file = `biodesign-runtime-${lock.runtimeVersion}-${target}.tar.gz`, archive = path.join(outputDirectory, file);
  await run("tar", ["--no-mac-metadata", "--uid", "0", "--gid", "0", "--uname", "root", "--gname", "root", "--options", "gzip:compression-level=9",
    "-C", staging, "-czf", archive, "BIODESIGN_RUNTIME.json", "node", "python"], { env: { ...process.env, COPYFILE_DISABLE: "1" } });
  const record = { file, sha256: await sha256File(archive), size: (await stat(archive)).size };
  await writeFile(`${archive}.json`, `${JSON.stringify({ target, ...record }, null, 2)}\n`);
  console.log(`${file}\n  sha256 ${record.sha256}\n  size   ${record.size}`);
  if (process.argv.includes("--manifest")) {
    const previous = await readFile(manifestFile, "utf8").then(JSON.parse).catch(() => null);
    const assets = previous?.runtimeVersion === lock.runtimeVersion ? previous.assets : {};
    const manifest = { version: 1, runtimeVersion: lock.runtimeVersion, baseUrl: `${RELEASES}/execution-runtime-${lock.runtimeVersion}`,
      assets: { ...assets, [target]: record } };
    await mkdir(path.dirname(manifestFile), { recursive: true });
    await writeFile(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`);
    console.log(`Recorded in ${path.relative(repository, manifestFile)}.`);
  }
}

const [command] = process.argv.slice(2);
const targetFlag = process.argv.indexOf("--target");
if (process.platform !== "darwin") fail("The runtime build uses macOS bsdtar; run it on a macOS build host.");
if (command === "lock") await lockRequirements();
else if (command === "build") await build(targetFlag > 0 ? process.argv[targetFlag + 1] : host);
else fail("Usage: build-execution-runtime.mjs lock | build [--target <target>] [--manifest]");
