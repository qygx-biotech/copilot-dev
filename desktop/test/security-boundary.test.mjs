import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  archiveEntryForExtraction,
  normalizeArchiveEntry,
} from "../scripts/archive-paths.mjs";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

test("package audit normalizes ASAR entry separators before policy checks", () => {
  assert.equal(
    normalizeArchiveEntry("\\local-backend\\package.json"),
    "/local-backend/package.json"
  );
  assert.equal(
    normalizeArchiveEntry("/local-backend/package.json"),
    "/local-backend/package.json"
  );
  assert.equal(
    archiveEntryForExtraction("\\node_modules\\sqlite-vec\\index.mjs"),
    "node_modules\\sqlite-vec\\index.mjs"
  );
});

async function source(relativePath) {
  return readFile(path.join(repositoryRoot, relativePath), "utf8");
}

async function filesUnder(relativeRoot) {
  const result = [];
  async function visit(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const entryPath = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(entryPath);
      else result.push(entryPath);
    }
  }
  await visit(path.join(repositoryRoot, relativeRoot));
  return result;
}

test("BrowserWindow and preload enforce the Electron privilege boundary", async () => {
  const entry = await source("desktop/main/main.mjs");
  const main = await source("desktop/main/application.mjs");
  const preload = await source("desktop/preload/index.cjs");
  assert.match(entry, /require\("electron-squirrel-startup"\)/);
  assert.match(entry, /if \(!squirrelStartup\)[\s\S]+import\("\.\/application\.mjs"\)/);
  assert.doesNotMatch(entry, /BrowserWindow|ProjectSessionManager/);
  assert.match(main, /nodeIntegration:\s*false/);
  assert.match(main, /contextIsolation:\s*true/);
  assert.match(main, /sandbox:\s*true/);
  assert.match(main, /setWindowOpenHandler\(\(\) => \(\{ action: "deny" \}\)\)/);
  assert.match(preload, /contextBridge\.exposeInMainWorld\("biodesignDesktop"/);
  assert.doesNotMatch(preload, /exposeInMainWorld\([^\n]+ipcRenderer/);
  assert.doesNotMatch(preload, /child_process|require\(["']node:fs/);
  assert.doesNotMatch(preload, /autoUpdater|setFeedURL|checkForUpdates|quitAndInstall|update\.electronjs\.org/);
  assert.match(preload, /requestBetaUpdateCheck:\s*\(\)\s*=>\s*invoke\(channels\.betaUpdateCheck\)/);
  assert.match(preload, /onBetaUpdateStatus\(listener\)/);
  assert.doesNotMatch(preload, /github\.com|api\.github\.com|releases\/download|feedUrl|filesystem|installer/i);
  const channelValues = [...(await source("desktop/ipc/channels.cjs")).matchAll(/"(biodesign:[^"]+)"/g)].map((match) => match[1]).sort();
  const preloadValues = [...preload.matchAll(/"(biodesign:[^"]+)"/g)].map((match) => match[1]).sort();
  assert.deepEqual(preloadValues, channelValues);
});

test("beta updates keep URLs, discovery, and feed configuration in the main process", async () => {
  const updater = await source("desktop/main/windows-updater.mjs");
  const handlers = await source("desktop/ipc/register-handlers.mjs");
  const renderer = await source("docs/app.js");
  const index = await source("docs/index.html");
  assert.match(updater, /https:\/\/api\.github\.com\/repos\/qygx-biotech\/copilot-dev\/releases\?per_page=100/);
  assert.match(updater, /https:\/\/github\.com\/qygx-biotech\/copilot-dev\/releases\/download/);
  assert.match(updater, /release-assets\.githubusercontent\.com/);
  assert.doesNotMatch(updater, /process\.env|GITHUB_TOKEN|Authorization\s*:/);
  assert.match(handlers, /assertTrustedIpcSender\(event, getWindow\)/);
  assert.match(handlers, /assertOnlyKeys\(payload, \[\]\)/);
  assert.doesNotMatch(renderer, /setFeedURL|getFeedURL|autoUpdater|quitAndInstall|api\.github\.com|releases\/download/);
  assert.match(index, /id="betaUpdateButton"/);
  assert.match(index, />\s*Check for Beta Updates\s*</);
});

test("desktop and renderer sources contain no direct Requesty host or credential", async () => {
  const checked = [
    ...(await filesUnder("desktop")),
    ...(await filesUnder("docs")),
    ...(await filesUnder("shared")),
    ...(await filesUnder("local-backend/src")),
    ...(await filesUnder("worker")),
    ...(await filesUnder("alibaba-fc/src")),
    path.join(repositoryRoot, "forge.config.cjs"),
    path.join(repositoryRoot, "package.json"),
  ].filter((file) => !file.includes(`${path.sep}vendor${path.sep}`));
  for (const file of checked) {
    const text = await readFile(file, "utf8");
    assert.doesNotMatch(text, /https?:\/\/[^\s"']*requesty\.ai/i, path.relative(repositoryRoot, file));
    assert.doesNotMatch(text, /REQUESTY_API_KEY\s*[:=]/, path.relative(repositoryRoot, file));
  }
  assert.match(await source("forge.config.cjs"), /"alibaba-fc"/);
  assert.match(await source("forge.config.cjs"), /"worker"/);
  assert.doesNotMatch(await source("docs/app.js"), /CLOUDFLARE_WORKER_URL|BACKEND_PROVIDER/);
});

test("renderer runtime libraries are local and production QMD has no localhost dependency", async () => {
  const index = await source("docs/index.html");
  assert.doesNotMatch(index, /cdn\.jsdelivr|cdnjs\.cloudflare/);
  assert.match(index, /pdfjs-loader\.js/);
  const knowledge = await source("docs/knowledge-service.js");
  assert.match(knowledge, /ElectronQmdKnowledgeService/);
  assert.match(knowledge, /root\?\.biodesignDesktop/);
  assert.doesNotMatch(await source("desktop/main/application.mjs"), /localhost|127\.0\.0\.1/);
  assert.doesNotMatch(await source("desktop/preload/index.cjs"), /localhost|127\.0\.0\.1/);
});

test("Forge excludes deployable server trees and unpacks native dependencies", async () => {
  const forge = await source("forge.config.cjs");
  assert.match(forge, /AutoUnpackNativesPlugin/);
  assert.match(forge, /asar:\s*\{[^}]*node,dylib,so,dll/s);
  assert.match(forge, /local-backend\[\/\\\\\]node_modules/);
  assert.match(forge, /maker-dmg/);
  assert.match(forge, /maker-squirrel/);
  assert.match(forge, /EnableEmbeddedAsarIntegrityValidation[^\n]+true/);
  assert.match(forge, /OnlyLoadAppFromAsar[^\n]+true/);
  assert.match(forge, /RunAsNode[^\n]+false/);
  assert.match(forge, /EnableNodeOptionsEnvironmentVariable[^\n]+false/);
  assert.match(forge, /EnableNodeCliInspectArguments[^\n]+false/);
});

test("desktop preparation patches sqlite-vec raw library paths for packaged Electron", async () => {
  const patcher = await source("desktop/scripts/patch-electron-native-assets.mjs");
  assert.match(patcher, /packageMetadata\.version !== "0\.1\.9"/);
  assert.match(patcher, /app\.asar\.unpacked/);
  assert.match(await source("package.json"), /"postinstall"[^\n]+patch-electron-native-assets\.mjs/);
});
