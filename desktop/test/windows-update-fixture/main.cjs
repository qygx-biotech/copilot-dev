"use strict";

const { app, autoUpdater } = require("electron");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const identity = "BioDesignUpdateSmoke";
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
  app.setAppUserModelId(`com.squirrel.${identity}.${identity}`);

  function writeStatus(status) {
    const statusPath = process.env.BIODESIGN_UPDATE_SMOKE_STATUS;
    if (!statusPath) return;
    fs.writeFileSync(statusPath, `${JSON.stringify(status, null, 2)}\n`, "utf8");
  }

  app.whenReady().then(() => {
    const version = app.getVersion();
    const projectDataPath = path.join(app.getPath("userData"), "update-smoke-project.json");
    if (!fs.existsSync(projectDataPath)) {
      fs.writeFileSync(projectDataPath, `${JSON.stringify({ createdBy: "0.0.1", value: "preserve-across-update" })}\n`, "utf8");
    }
    const projectData = JSON.parse(fs.readFileSync(projectDataPath, "utf8"));

    if (version === "0.0.2") {
      const preserved = projectData.createdBy === "0.0.1" && projectData.value === "preserve-across-update";
      writeStatus({ phase: preserved ? "updated" : "project-data-lost", version, projectDataPreserved: preserved });
      app.exit(preserved ? 0 : 4);
      return;
    }

    const feed = process.env.BIODESIGN_UPDATE_SMOKE_FEED;
    if (!feed) {
      app.quit();
      return;
    }

    autoUpdater.setFeedURL({ url: feed });
    autoUpdater.on("update-available", () => {
      writeStatus({ phase: "downloading", version, projectDataPreserved: true });
    });
    autoUpdater.on("update-downloaded", () => {
      writeStatus({ phase: "downloaded", version, projectDataPreserved: true });
      // This is deliberately a normal quit after choosing the equivalent of
      // Later. The next ordinary launch must apply the staged update.
      setTimeout(() => app.quit(), 500);
    });
    autoUpdater.on("update-not-available", () => {
      writeStatus({ phase: "no-update", version, projectDataPreserved: true });
      app.exit(3);
    });
    autoUpdater.on("error", () => {
      writeStatus({ phase: "update-error", version, projectDataPreserved: true });
      app.exit(2);
    });

    const firstRunDelay = process.argv.includes("--squirrel-firstrun") ? 10_000 : 2_000;
    setTimeout(() => autoUpdater.checkForUpdates(), firstRunDelay);
    setTimeout(() => {
      writeStatus({ phase: "timeout", version, projectDataPreserved: true });
      app.exit(5);
    }, 180_000);
  });
}
