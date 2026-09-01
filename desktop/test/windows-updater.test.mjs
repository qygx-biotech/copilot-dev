import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { test } from "node:test";
import {
  isPackagedWindows,
  isStrictlyNewerStableVersion,
  parseStableVersion,
  startWindowsAutoUpdates,
  WINDOWS_UPDATE_FIRST_RUN_DELAY_MS,
  WINDOWS_UPDATE_HOST,
  WINDOWS_UPDATE_INTERVAL,
  WINDOWS_UPDATE_INTERVAL_MS,
  WINDOWS_UPDATE_REPOSITORY,
  WINDOWS_UPDATE_STARTUP_DELAY_MS,
} from "../main/windows-updater.mjs";

function nextTurn() {
  return new Promise((resolve) => setImmediate(resolve));
}

function fixture(options = {}) {
  const autoUpdater = new EventEmitter();
  autoUpdater.checkCount = 0;
  autoUpdater.quitCount = 0;
  autoUpdater.checkForUpdates = () => { autoUpdater.checkCount += 1; };
  autoUpdater.quitAndInstall = () => { autoUpdater.quitCount += 1; };
  const timeouts = [];
  const intervals = [];
  const updateCalls = [];
  let libraryStopped = 0;
  const dialogs = options.dialogs || [{ response: 1 }];
  const dialog = {
    calls: [],
    async showMessageBox(configuration) {
      this.calls.push(configuration);
      return dialogs.shift() || { response: 1 };
    },
  };
  const events = [];
  const app = { isPackaged: true, getVersion: () => options.version || "0.1.5" };
  const controller = startWindowsAutoUpdates({
    app,
    autoUpdater,
    dialog,
    platform: options.platform || "win32",
    processArguments: options.processArguments || [],
    getWorkState: options.getWorkState,
    prepareForUpdate: options.prepareForUpdate,
    logEvent: (event) => events.push(event),
    updateElectronApp: options.updateElectronApp || ((configuration) => {
      updateCalls.push(configuration);
      return { stopUpdates: () => { libraryStopped += 1; } };
    }),
    setTimeout: (callback, delay) => {
      timeouts.push({ callback, delay });
      return timeouts.length;
    },
    clearTimeout: () => {},
    setInterval: (callback, delay) => {
      intervals.push({ callback, delay });
      return intervals.length;
    },
    clearInterval: () => {},
  });
  return {
    app,
    autoUpdater,
    controller,
    dialog,
    events,
    intervals,
    timeouts,
    updateCalls,
    libraryStopped: () => libraryStopped,
  };
}

test("update logic runs only in packaged Windows builds", () => {
  assert.equal(isPackagedWindows({ platform: "win32", packaged: true }), true);
  assert.equal(isPackagedWindows({ platform: "darwin", packaged: true }), false);
  assert.equal(isPackagedWindows({ platform: "win32", packaged: false }), false);
  const nonWindows = fixture({ platform: "darwin" });
  assert.equal(nonWindows.controller, null);
  assert.equal(nonWindows.timeouts.length, 0);
});

test("the public update source is fixed, HTTPS-only, and scheduled after safe startup", () => {
  const state = fixture();
  assert.equal(state.timeouts[0].delay, WINDOWS_UPDATE_STARTUP_DELAY_MS);
  state.timeouts[0].callback();
  assert.equal(state.updateCalls.length, 1);
  assert.equal(state.updateCalls[0].updateSource.host, WINDOWS_UPDATE_HOST);
  assert.equal(state.updateCalls[0].updateSource.repo, WINDOWS_UPDATE_REPOSITORY);
  assert.equal(new URL(state.updateCalls[0].updateSource.host).protocol, "https:");
  assert.equal(state.updateCalls[0].updateInterval, WINDOWS_UPDATE_INTERVAL);
  assert.equal(state.updateCalls[0].notifyUser, false);
  assert.equal(state.libraryStopped(), 1);
  assert.equal(state.intervals[0].delay, WINDOWS_UPDATE_INTERVAL_MS);
  assert.deepEqual(Object.keys(state.updateCalls[0].updateSource).sort(), ["host", "repo", "type"]);
});

test("Squirrel first-run lock delays the first update check", () => {
  const state = fixture({ processArguments: ["BioDesign.exe", "--squirrel-firstrun"] });
  assert.equal(state.timeouts[0].delay, WINDOWS_UPDATE_FIRST_RUN_DELAY_MS);
});

test("offline initialization and update failures remain nonfatal", () => {
  const state = fixture({ updateElectronApp: () => { throw new Error("offline"); } });
  assert.doesNotThrow(() => state.timeouts[0].callback());
  assert.ok(state.events.includes("windows_updater_initialization_failed"));
  assert.doesNotThrow(() => state.autoUpdater.emit("error", new Error("offline")));
  assert.ok(state.events.includes("windows_updater_error"));
});

test("concurrent checks and duplicate downloads are prevented", async () => {
  const state = fixture();
  state.timeouts[0].callback();
  state.autoUpdater.emit("update-not-available");
  assert.equal(state.intervals[0].callback(), undefined);
  assert.equal(state.autoUpdater.checkCount, 1);
  state.intervals[0].callback();
  assert.equal(state.autoUpdater.checkCount, 1);
  state.autoUpdater.emit("update-available");
  state.autoUpdater.emit("update-downloaded", {}, "", "0.1.6");
  state.autoUpdater.emit("update-downloaded", {}, "", "0.1.6");
  await nextTurn();
  assert.equal(state.dialog.calls.length, 1);
});

test("Later never closes the app and leaves the downloaded update staged", async () => {
  const state = fixture({ dialogs: [{ response: 1 }] });
  state.timeouts[0].callback();
  state.autoUpdater.emit("update-available");
  state.autoUpdater.emit("update-downloaded", {}, "", "0.1.6");
  await nextTurn();
  assert.equal(state.autoUpdater.quitCount, 0);
  assert.ok(state.events.includes("windows_updater_restart_deferred"));
});

test("a downloaded update never interrupts a running job or open project", async () => {
  const state = fixture({
    dialogs: [{ response: 0 }, { response: 0 }],
    getWorkState: () => ({ projectOpen: true, runningJobs: true }),
  });
  state.timeouts[0].callback();
  state.autoUpdater.emit("update-available");
  state.autoUpdater.emit("update-downloaded", {}, "", "0.1.6");
  await nextTurn();
  await nextTurn();
  assert.equal(state.autoUpdater.quitCount, 0);
  assert.equal(state.dialog.calls.length, 2);
  assert.ok(state.events.includes("windows_updater_restart_blocked_by_job"));

  const projectState = fixture({
    dialogs: [{ response: 0 }, { response: 0 }],
    getWorkState: () => ({ projectOpen: true, runningJobs: false }),
  });
  projectState.timeouts[0].callback();
  projectState.autoUpdater.emit("update-available");
  projectState.autoUpdater.emit("update-downloaded", {}, "", "0.1.6");
  await nextTurn();
  await nextTurn();
  assert.equal(projectState.autoUpdater.quitCount, 0);
  assert.ok(projectState.events.includes("windows_updater_restart_blocked_by_project"));
});

test("Restart Now installs only when no project or job is active", async () => {
  let prepared = 0;
  const state = fixture({
    dialogs: [{ response: 0 }],
    getWorkState: () => ({ projectOpen: false, runningJobs: false }),
    prepareForUpdate: async () => { prepared += 1; },
  });
  state.timeouts[0].callback();
  state.autoUpdater.emit("update-available");
  state.autoUpdater.emit("update-downloaded", {}, "", "0.1.6");
  await nextTurn();
  assert.equal(prepared, 1);
  assert.equal(state.autoUpdater.quitCount, 1);
});

test("downgrades, duplicate versions, invalid versions, and prereleases are rejected", async () => {
  assert.equal(parseStableVersion("0.1.6")?.text, "0.1.6");
  assert.equal(parseStableVersion("0.1.6-beta.1"), null);
  assert.equal(isStrictlyNewerStableVersion("0.1.6", "0.1.5"), true);
  assert.equal(isStrictlyNewerStableVersion("0.1.5", "0.1.5"), false);
  assert.equal(isStrictlyNewerStableVersion("0.1.4", "0.1.5"), false);

  for (const release of ["0.1.5", "0.1.4", "0.1.6-beta.1", "invalid"]) {
    const state = fixture();
    state.timeouts[0].callback();
    state.autoUpdater.emit("update-available");
    state.autoUpdater.emit("update-downloaded", {}, "", release);
    await nextTurn();
    assert.equal(state.dialog.calls.length, 0, release);
    assert.equal(state.autoUpdater.quitCount, 0, release);
  }
});
