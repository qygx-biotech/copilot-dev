import { mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { parseStableSemver } from "./validate-stable-release.mjs";

const require = createRequire(import.meta.url);
const extract = require("extract-zip");

if (process.platform !== "win32" || process.arch !== "x64") {
  throw new Error("Windows release verification must run on a Windows x64 host.");
}

const packageMetadata = JSON.parse(await readFile("package.json", "utf8"));
const allowPrerelease = process.env.BIODESIGN_ALLOW_PRERELEASE === "1";
const validPrerelease = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*$/.test(packageMetadata.version);
if (!parseStableSemver(packageMetadata.version) && !(allowPrerelease && validPrerelease)) {
  throw new Error(`Windows ${allowPrerelease ? "release" : "stable release"} version is invalid: ${packageMetadata.version}.`);
}
const squirrelRoot = path.resolve("out", "make", "squirrel.windows", "x64");
const zipRoot = path.resolve("out", "make", "zip", "win32", "x64");

async function requireNonemptyFile(filePath) {
  const metadata = await stat(filePath);
  if (!metadata.isFile() || metadata.size === 0) {
    throw new Error(`Release artifact is missing or empty: ${filePath}`);
  }
  return { path: filePath, bytes: metadata.size };
}

async function oneMatchingFile(directory, predicate, label) {
  const names = (await readdir(directory)).filter(predicate);
  if (names.length !== 1) {
    throw new Error(`Expected one ${label} in ${directory}; found ${names.length}: ${names.join(", ")}`);
  }
  return path.join(directory, names[0]);
}

const setupPath = path.join(squirrelRoot, "BioDesign-Setup.exe");
const releasesPath = path.join(squirrelRoot, "RELEASES");
const expectedFullPackageName = `BioDesign-${packageMetadata.version}-full.nupkg`;
const expectedZipName = `BioDesign-win32-x64-${packageMetadata.version}.zip`;
const packagePath = path.join(squirrelRoot, expectedFullPackageName);
const zipPath = path.join(zipRoot, expectedZipName);

const artifacts = {
  setup: await requireNonemptyFile(setupPath),
  fullPackage: await requireNonemptyFile(packagePath),
  releases: await requireNonemptyFile(releasesPath),
  zip: await requireNonemptyFile(zipPath),
};

const releases = await readFile(releasesPath, "utf8");
const fullPackageName = path.basename(packagePath);
const releaseLines = releases.trim().split(/\r?\n/).filter(Boolean);
const fullReleaseLines = releaseLines.filter((line) => /-full\.nupkg(?:\s|$)/i.test(line));
if (fullReleaseLines.length !== 1 || !fullReleaseLines[0].includes(fullPackageName)) {
  throw new Error(`RELEASES does not reference ${fullPackageName}.`);
}
if (!/^[a-f\d]{40}\s+\S+\s+\d+$/i.test(fullReleaseLines[0])) {
  throw new Error("RELEASES full-package entry is malformed.");
}

const extractionRoot = await mkdtemp(path.join(os.tmpdir(), "biodesign-nupkg-audit-"));
try {
  await extract(packagePath, { dir: extractionRoot });
  const names = await readdir(extractionRoot);
  const nuspecNames = names.filter((name) => name.toLowerCase().endsWith(".nuspec"));
  if (nuspecNames.length !== 1) throw new Error("Full NUPKG must contain exactly one NuSpec file.");
  const nuspec = await readFile(path.join(extractionRoot, nuspecNames[0]), "utf8");
  for (const [label, pattern] of [
    ["package identity", /<id>BioDesign<\/id>/],
    ["package version", new RegExp(`<version>${packageMetadata.version.replaceAll(".", "\\.")}<\\/version>`)],
    ["package title", /<title>BioDesign<\/title>/],
  ]) {
    if (!pattern.test(nuspec)) throw new Error(`Full NUPKG ${label} is incorrect.`);
  }
  await requireNonemptyFile(path.join(extractionRoot, "lib", "net45", "BioDesign.exe"));
  await requireNonemptyFile(path.join(extractionRoot, "lib", "net45", "resources", "app.asar"));
} finally {
  await rm(extractionRoot, { recursive: true, force: true });
}

console.log(JSON.stringify({
  version: packageMetadata.version,
  squirrelIdentity: "BioDesign",
  executableName: "BioDesign.exe",
  appUserModelId: "com.squirrel.BioDesign.BioDesign",
  platform: process.platform,
  architecture: process.arch,
  prereleaseValidation: allowPrerelease,
  artifacts,
}, null, 2));
