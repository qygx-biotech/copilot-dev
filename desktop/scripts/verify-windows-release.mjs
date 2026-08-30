import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";

if (process.platform !== "win32" || process.arch !== "x64") {
  throw new Error("Windows release verification must run on a Windows x64 host.");
}

const packageMetadata = JSON.parse(await readFile("package.json", "utf8"));
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
const packagePath = await oneMatchingFile(
  squirrelRoot,
  (name) => name.toLowerCase().endsWith("-full.nupkg"),
  "full Squirrel package",
);
const zipPath = await oneMatchingFile(
  zipRoot,
  (name) => name.toLowerCase().endsWith(".zip"),
  "Windows x64 ZIP",
);

const artifacts = {
  setup: await requireNonemptyFile(setupPath),
  fullPackage: await requireNonemptyFile(packagePath),
  releases: await requireNonemptyFile(releasesPath),
  zip: await requireNonemptyFile(zipPath),
};

const releases = await readFile(releasesPath, "utf8");
const fullPackageName = path.basename(packagePath);
if (!releases.includes(fullPackageName)) {
  throw new Error(`RELEASES does not reference ${fullPackageName}.`);
}
if (!fullPackageName.includes(`-${packageMetadata.version}-`)) {
  throw new Error(`Full package ${fullPackageName} does not contain package version ${packageMetadata.version}.`);
}

console.log(JSON.stringify({
  version: packageMetadata.version,
  platform: process.platform,
  architecture: process.arch,
  artifacts,
}, null, 2));
