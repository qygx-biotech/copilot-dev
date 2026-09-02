import { createHash } from "node:crypto";
import { cp, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";
import { toSquirrelPackageVersion } from "../main/windows-updater.mjs";

if (process.platform !== "win32" || process.arch !== "x64") {
  throw new Error("The beta Squirrel update fixture must be built on Windows x64.");
}

const require = createRequire(import.meta.url);
const { packager } = require("@electron/packager");
const { createWindowsInstaller } = require("electron-winstaller");
const rootPackage = JSON.parse(await readFile("package.json", "utf8"));
const identity = "BioDesign";
const versionAValue = "0.0.1-beta.1";
const versionBValue = "0.0.1-beta.2";
const smokeRoot = path.resolve("out", "windows-beta-update-smoke");
const fixtureMain = path.resolve("desktop", "test", "windows-beta-update-fixture", "main.cjs");
const productionUpdater = path.resolve("desktop", "main", "windows-updater.mjs");
await rm(smokeRoot, { recursive: true, force: true });
await mkdir(smokeRoot, { recursive: true });

async function buildVersion(label, version) {
  const sourceRoot = path.join(smokeRoot, `source-${label}`);
  const packageOutput = path.join(smokeRoot, `package-${label}`);
  const installerOutput = path.join(smokeRoot, `installer-${label}`);
  await mkdir(path.join(sourceRoot, "node_modules", "update-electron-app"), { recursive: true });
  await cp(fixtureMain, path.join(sourceRoot, "main.cjs"));
  await cp(productionUpdater, path.join(sourceRoot, "windows-updater.mjs"));
  await writeFile(path.join(sourceRoot, "node_modules", "update-electron-app", "package.json"), `${JSON.stringify({
    name: "update-electron-app",
    version: "0.0.0-test",
    main: "index.js",
  }, null, 2)}\n`, "utf8");
  await writeFile(path.join(sourceRoot, "node_modules", "update-electron-app", "index.js"),
    "exports.UpdateSourceType = { ElectronPublicUpdateService: 'ElectronPublicUpdateService' }; exports.updateElectronApp = () => ({ stopUpdates() {} });\n",
    "utf8");
  await writeFile(path.join(sourceRoot, "package.json"), `${JSON.stringify({
    name: identity,
    productName: identity,
    version,
    description: "Isolated BioDesign prerelease Squirrel update smoke fixture.",
    author: "qygx-biotech",
    main: "main.cjs",
  }, null, 2)}\n`, "utf8");

  const [appDirectory] = await packager({
    dir: sourceRoot,
    out: packageOutput,
    overwrite: true,
    platform: "win32",
    arch: "x64",
    electronVersion: rootPackage.devDependencies.electron,
    name: identity,
    executableName: identity,
    asar: true,
    prune: false,
    download: { checksums: require("../../node_modules/electron/checksums.json") },
  });

  await createWindowsInstaller({
    appDirectory,
    outputDirectory: installerOutput,
    name: identity,
    title: identity,
    authors: "qygx-biotech",
    description: "Isolated BioDesign prerelease Squirrel update smoke fixture.",
    exe: `${identity}.exe`,
    setupExe: `${identity}-Setup.exe`,
    noMsi: true,
    noDelta: true,
  });
  return { version, appDirectory, installerOutput };
}

async function sha256(filePath) {
  return createHash("sha256").update(await readFile(filePath)).digest("hex");
}

const versionA = await buildVersion("a", versionAValue);
const versionB = await buildVersion("b", versionBValue);
const feedRoot = path.join(smokeRoot, "feed");
await mkdir(feedRoot, { recursive: true });
const expectedFullPackageName = `${identity}-${toSquirrelPackageVersion(versionBValue)}-full.nupkg`;
const fullPackageNames = (await readdir(versionB.installerOutput)).filter((name) => name.endsWith("-full.nupkg"));
if (fullPackageNames.length !== 1 || fullPackageNames[0] !== expectedFullPackageName) {
  throw new Error(`Expected one Squirrel-normalized full NUPKG named ${expectedFullPackageName}.`);
}
const [fullPackageName] = fullPackageNames;
for (const fileName of ["RELEASES", fullPackageName, `${identity}-Setup.exe`]) {
  await cp(path.join(versionB.installerOutput, fileName), path.join(feedRoot, fileName));
}
const architectureMarkerName = `${identity}-win32-x64-${versionBValue}.zip`;
await writeFile(path.join(feedRoot, architectureMarkerName), "Windows x64 beta update smoke architecture marker.\n", "utf8");

const checksumNames = [`${identity}-Setup.exe`, "RELEASES", fullPackageName, architectureMarkerName];
const checksums = [];
for (const name of checksumNames) checksums.push(`${await sha256(path.join(feedRoot, name))}  ${name}`);
await writeFile(path.join(feedRoot, "SHA256SUMS.txt"), `${checksums.join("\n")}\n`, "utf8");

const assetNames = [...checksumNames, "SHA256SUMS.txt"];
const assets = [];
for (const name of assetNames) assets.push({ name, size: (await stat(path.join(feedRoot, name))).size });
await writeFile(path.join(smokeRoot, "manifest.json"), `${JSON.stringify({
  identity,
  versionA,
  versionB,
  setupA: path.join(versionA.installerOutput, `${identity}-Setup.exe`),
  feedRoot,
  assets,
}, null, 2)}\n`, "utf8");
console.log(`Built prerelease Squirrel update fixtures under ${path.relative(process.cwd(), smokeRoot)}.`);
