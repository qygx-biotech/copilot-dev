import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";

if (process.platform !== "win32" || process.arch !== "x64") {
  throw new Error("The two-version Squirrel update fixture must be built on Windows x64.");
}

const require = createRequire(import.meta.url);
const { packager } = require("@electron/packager");
const { createWindowsInstaller } = require("electron-winstaller");
const rootPackage = JSON.parse(await readFile("package.json", "utf8"));
const identity = "BioDesignUpdateSmoke";
const smokeRoot = path.resolve("out", "windows-update-smoke");
const fixtureMain = path.resolve("desktop", "test", "windows-update-fixture", "main.cjs");
await rm(smokeRoot, { recursive: true, force: true });
await mkdir(smokeRoot, { recursive: true });

async function buildVersion(label, version) {
  const sourceRoot = path.join(smokeRoot, `source-${label}`);
  const packageOutput = path.join(smokeRoot, `package-${label}`);
  const installerOutput = path.join(smokeRoot, `installer-${label}`);
  await mkdir(sourceRoot, { recursive: true });
  await cp(fixtureMain, path.join(sourceRoot, "main.cjs"));
  await writeFile(path.join(sourceRoot, "package.json"), `${JSON.stringify({
    name: identity,
    productName: identity,
    version,
    description: "Isolated BioDesign Squirrel update smoke fixture.",
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
    description: "Isolated BioDesign Squirrel update smoke fixture.",
    exe: `${identity}.exe`,
    setupExe: `${identity}-Setup.exe`,
    noMsi: true,
    noDelta: true,
  });
  return { version, appDirectory, installerOutput };
}

const versionA = await buildVersion("a", "0.0.1");
const versionB = await buildVersion("b", "0.0.2");
const feedRoot = path.join(smokeRoot, "feed");
await mkdir(feedRoot, { recursive: true });
for (const fileName of ["RELEASES", `${identity}-0.0.2-full.nupkg`]) {
  await cp(path.join(versionB.installerOutput, fileName), path.join(feedRoot, fileName));
}

await writeFile(path.join(smokeRoot, "manifest.json"), `${JSON.stringify({
  identity,
  versionA,
  versionB,
  setupA: path.join(versionA.installerOutput, `${identity}-Setup.exe`),
  feedRoot,
}, null, 2)}\n`, "utf8");
console.log(`Built isolated Squirrel update fixtures under ${path.relative(process.cwd(), smokeRoot)}.`);
