"use strict";

const { app, autoUpdater: electronAutoUpdater } = require("electron");
const { EventEmitter } = require("node:events");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const identity = "BioDesign";
const versionA = "0.0.1-beta.1";
const versionB = "0.0.1-beta.2";
const lifecycleEvent = process.argv[1];

function runUpdateExecutable(argumentsList) {
  const updateExecutable = path.resolve(path.dirname(process.execPath), "..", "Update.exe");
  spawn(updateExecutable, argumentsList, { detached: true }).on("close", () => app.quit());
}

if (process.platform === "win32" && [
  "--squirrel-install",
  "--squirrel-updated",
  "--squirrel-uninstall",
  "--squirrel-obsolete",
].includes(lifecycleEvent)) {
  if (lifecycleEvent === "--squirrel-install" || lifecycleEvent === "--squirrel-updated") {
    runUpdateExecutable([`--createShortcut=${identity}.exe`]);
  } else if (lifecycleEvent === "--squirrel-uninstall") {
    runUpdateExecutable([`--removeShortcut=${identity}.exe`]);
  } else {
    app.quit();
  }
} else {
  app.setName(identity);
  app.setAppUserModelId("com.squirrel.BioDesign.BioDesign");

  function writeStatus(status) {
    const statusPath = process.env.BIODESIGN_BETA_UPDATE_SMOKE_STATUS;
    if (!statusPath) return;
    fs.writeFileSync(statusPath, `${JSON.stringify(status, null, 2)}\n`, "utf8");
  }

  app.whenReady().then(async () => {
    const version = app.getVersion();
    const projectDataPath = path.join(app.getPath("userData"), "beta-update-smoke-project.json");
    if (!fs.existsSync(projectDataPath)) {
      fs.writeFileSync(projectDataPath, `${JSON.stringify({ createdBy: versionA, value: "preserve-across-beta-update" })}\n`, "utf8");
    }
    const projectData = JSON.parse(fs.readFileSync(projectDataPath, "utf8"));
    const preserved = projectData.createdBy === versionA && projectData.value === "preserve-across-beta-update";

    if (version === versionB) {
      writeStatus({ phase: preserved ? "updated" : "project-data-lost", version, projectDataPreserved: preserved });
      app.exit(preserved ? 0 : 4);
      return;
    }

    const fixtureOrigin = process.env.BIODESIGN_BETA_UPDATE_SMOKE_ORIGIN;
    if (!fixtureOrigin) {
      app.quit();
      return;
    }

    const productionModule = await import("./windows-updater.mjs");
    const expectedTag = `v${versionB}`;
    const expectedFeed = `${productionModule.WINDOWS_BETA_RELEASES_DOWNLOAD_BASE}/${expectedTag}`;
    const updater = new EventEmitter();
    for (const event of ["checking-for-update", "update-available", "update-not-available", "update-downloaded", "error"]) {
      electronAutoUpdater.on(event, (...argumentsList) => updater.emit(event, ...argumentsList));
    }
    updater.setFeedURL = ({ url }) => {
      if (url !== expectedFeed) throw new Error("Production beta updater selected an unexpected feed.");
      electronAutoUpdater.setFeedURL({ url: `${fixtureOrigin}/releases/download/${expectedTag}` });
    };
    updater.checkForUpdates = () => electronAutoUpdater.checkForUpdates();
    updater.quitAndInstall = () => electronAutoUpdater.quitAndInstall();

    const fixtureFetch = async (url, options = {}) => {
      if (url === productionModule.WINDOWS_BETA_RELEASES_API_URL) {
        return fetch(`${fixtureOrigin}/api/releases`, { ...options, redirect: "error" });
      }
      if (url.startsWith(`${productionModule.WINDOWS_BETA_RELEASES_DOWNLOAD_BASE}/${expectedTag}/`)) {
        const name = new URL(url).pathname.split("/").pop();
        return new Response(null, {
          status: 302,
          headers: { location: `https://${productionModule.WINDOWS_BETA_ASSET_REDIRECT_HOST}/fixture/${name}?signed=test-only` },
        });
      }
      if (new URL(url).hostname === productionModule.WINDOWS_BETA_ASSET_REDIRECT_HOST) {
        const name = new URL(url).pathname.split("/").pop();
        return fetch(`${fixtureOrigin}/metadata/${name}`, { ...options, redirect: "error" });
      }
      throw new Error("The beta discovery fixture received an unexpected URL.");
    };

    let normalQuitScheduled = false;
    const controller = new productionModule.WindowsUpdaterController({
      app,
      autoUpdater: updater,
      dialog: { showMessageBox: async () => ({ response: 1 }) },
      platform: "win32",
      architecture: "x64",
      processArguments: [],
      fetchImplementation: fixtureFetch,
      getWorkState: () => ({ projectOpen: true, runningJobs: false }),
      onBetaStatus: (status) => {
        if (status.state === "downloading") {
          writeStatus({ phase: "downloading", version, projectDataPreserved: preserved, narrowAction: true });
        }
        if (status.state === "ready-to-restart" && !normalQuitScheduled) {
          normalQuitScheduled = true;
          writeStatus({ phase: "downloaded", version, targetVersion: status.version, projectDataPreserved: preserved, narrowAction: true, selectedLater: true });
          setTimeout(() => app.quit(), 1000);
        }
        if (status.state === "temporarily-unavailable" || status.state === "no-eligible-beta") {
          writeStatus({ phase: "update-error", version, state: status.state, projectDataPreserved: preserved });
          app.exit(2);
        }
      },
    });
    controller.start();
    setTimeout(() => { void controller.requestBetaUpdateCheck(); }, 2000);
    setTimeout(() => {
      writeStatus({ phase: "timeout", version, projectDataPreserved: preserved });
      app.exit(5);
    }, 180_000);
  });
}
