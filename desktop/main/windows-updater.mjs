import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { updateElectronApp, UpdateSourceType } = require("update-electron-app");

export const BIO_DESIGN_APP_USER_MODEL_ID = "com.squirrel.BioDesign.BioDesign";
export const WINDOWS_UPDATE_REPOSITORY = "qygx-biotech/copilot-dev";
export const WINDOWS_UPDATE_HOST = "https://update.electronjs.org";
export const WINDOWS_UPDATE_INTERVAL = "6 hours";
export const WINDOWS_UPDATE_INTERVAL_MS = 6 * 60 * 60 * 1000;
export const WINDOWS_UPDATE_STARTUP_DELAY_MS = 30 * 1000;
export const WINDOWS_UPDATE_FIRST_RUN_DELAY_MS = 10 * 1000;

const FIXED_UPDATE_SOURCE = Object.freeze({
  type: UpdateSourceType.ElectronPublicUpdateService,
  repo: WINDOWS_UPDATE_REPOSITORY,
  host: WINDOWS_UPDATE_HOST,
});

const UPDATER_LIBRARY_LOG_EVENTS = new Map([
  ["feedURL", "windows_updater_configured"],
  ["requestHeaders", "windows_updater_request_configured"],
  ["updater error", "windows_updater_error"],
  ["checking-for-update", "windows_updater_checking"],
  ["update-available; downloading...", "windows_updater_downloading"],
  ["update-not-available", "windows_updater_current"],
]);

export function isPackagedWindows({ platform, packaged }) {
  return platform === "win32" && packaged === true;
}

export function parseStableVersion(value) {
  const match = /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(String(value || "").trim());
  if (!match) return null;
  return {
    text: `${match[1]}.${match[2]}.${match[3]}`,
    parts: match.slice(1).map(Number),
  };
}

export function isStrictlyNewerStableVersion(candidate, current) {
  const next = parseStableVersion(candidate);
  const installed = parseStableVersion(current);
  if (!next || !installed) return false;
  for (let index = 0; index < 3; index += 1) {
    if (next.parts[index] > installed.parts[index]) return true;
    if (next.parts[index] < installed.parts[index]) return false;
  }
  return false;
}

class WindowsUpdaterController {
  constructor(options) {
    this.app = options.app;
    this.autoUpdater = options.autoUpdater;
    this.dialog = options.dialog;
    this.processArguments = options.processArguments || [];
    this.getWorkState = options.getWorkState || (() => ({ projectOpen: false, runningJobs: false }));
    this.prepareForUpdate = options.prepareForUpdate || (async () => {});
    this.logEvent = options.logEvent || (() => {});
    this.updateElectronApp = options.updateElectronApp || updateElectronApp;
    this.setTimeout = options.setTimeout || globalThis.setTimeout;
    this.clearTimeout = options.clearTimeout || globalThis.clearTimeout;
    this.setInterval = options.setInterval || globalThis.setInterval;
    this.clearInterval = options.clearInterval || globalThis.clearInterval;
    this.phase = "idle";
    this.started = false;
    this.stopped = false;
    this.prompting = false;
    this.startupTimer = null;
    this.periodicTimer = null;
    this.listeners = new Map();
  }

  start() {
    if (this.started || this.stopped) return;
    this.started = true;
    this.attachListeners();
    const firstRun = this.processArguments.includes("--squirrel-firstrun");
    const delay = firstRun ? WINDOWS_UPDATE_FIRST_RUN_DELAY_MS : WINDOWS_UPDATE_STARTUP_DELAY_MS;
    this.startupTimer = this.setTimeout(() => {
      this.startupTimer = null;
      this.initializeUpdater();
    }, delay);
    this.logEvent(firstRun ? "windows_updater_first_run_delayed" : "windows_updater_scheduled");
  }

  attachListeners() {
    const handlers = {
      "checking-for-update": () => {
        this.phase = "checking";
      },
      "update-available": () => {
        this.phase = "downloading";
      },
      "update-not-available": () => {
        this.phase = "idle";
      },
      error: () => {
        this.phase = "idle";
        this.logEvent("windows_updater_error");
      },
      "update-downloaded": (_event, _releaseNotes, releaseName) => {
        void this.handleDownloaded(releaseName);
      },
    };
    for (const [event, handler] of Object.entries(handlers)) {
      this.listeners.set(event, handler);
      this.autoUpdater.on(event, handler);
    }
  }

  initializeUpdater() {
    if (this.stopped) return;
    this.phase = "checking";
    try {
      const librarySchedule = this.updateElectronApp({
        updateSource: FIXED_UPDATE_SOURCE,
        updateInterval: WINDOWS_UPDATE_INTERVAL,
        notifyUser: false,
        logger: {
          log: (message) => {
            const event = UPDATER_LIBRARY_LOG_EVENTS.get(String(message));
            if (event) this.logEvent(event);
          },
        },
      });
      // The helper configures the fixed feed and performs the supported initial
      // check. BioDesign owns later scheduling so checks cannot overlap.
      librarySchedule.stopUpdates();
      this.periodicTimer = this.setInterval(() => {
        this.checkForUpdates();
      }, WINDOWS_UPDATE_INTERVAL_MS);
    } catch {
      this.phase = "idle";
      this.logEvent("windows_updater_initialization_failed");
    }
  }

  checkForUpdates() {
    if (this.stopped || this.phase !== "idle") {
      this.logEvent("windows_updater_overlapping_check_skipped");
      return false;
    }
    this.phase = "checking";
    try {
      const request = this.autoUpdater.checkForUpdates();
      if (request && typeof request.catch === "function") {
        request.catch(() => {
          this.phase = "idle";
          this.logEvent("windows_updater_check_failed");
        });
      }
      return true;
    } catch {
      this.phase = "idle";
      this.logEvent("windows_updater_check_failed");
      return false;
    }
  }

  async handleDownloaded(releaseName) {
    if (this.stopped || this.prompting || this.phase === "downloaded") return;
    const parsed = parseStableVersion(releaseName);
    if (!parsed || !isStrictlyNewerStableVersion(parsed.text, this.app.getVersion())) {
      this.phase = "idle";
      this.logEvent("windows_updater_rejected_version");
      return;
    }

    this.phase = "downloaded";
    this.prompting = true;
    this.logEvent("windows_updater_downloaded");
    try {
      const { response } = await this.dialog.showMessageBox({
        type: "info",
        title: "BioDesign update ready",
        message: `BioDesign ${parsed.text} has been downloaded.`,
        detail: "Restart now to install it, or choose Later to keep working. If you choose Later, the update will install on a subsequent normal restart.",
        buttons: ["Restart Now", "Later"],
        defaultId: 1,
        cancelId: 1,
        noLink: true,
      });
      if (response !== 0) {
        this.logEvent("windows_updater_restart_deferred");
        return;
      }

      const workState = this.getWorkState();
      if (workState.runningJobs || workState.projectOpen) {
        this.logEvent(workState.runningJobs
          ? "windows_updater_restart_blocked_by_job"
          : "windows_updater_restart_blocked_by_project");
        await this.dialog.showMessageBox({
          type: "info",
          title: "Update will install later",
          message: workState.runningJobs
            ? "BioDesign did not interrupt the running job."
            : "BioDesign did not close the open project.",
          detail: workState.runningJobs
            ? "Finish the job, save your work, and close BioDesign normally. The downloaded update will install on a subsequent normal restart."
            : "Save your work and close the project normally. The downloaded update will install on a subsequent normal restart.",
          buttons: ["OK"],
          defaultId: 0,
          cancelId: 0,
          noLink: true,
        });
        return;
      }

      await this.prepareForUpdate();
      this.logEvent("windows_updater_user_requested_restart");
      this.autoUpdater.quitAndInstall();
    } catch {
      this.logEvent("windows_updater_restart_failed");
    } finally {
      this.prompting = false;
    }
  }

  stop() {
    if (this.stopped) return;
    this.stopped = true;
    if (this.startupTimer !== null) this.clearTimeout(this.startupTimer);
    if (this.periodicTimer !== null) this.clearInterval(this.periodicTimer);
    for (const [event, handler] of this.listeners) {
      this.autoUpdater.removeListener(event, handler);
    }
    this.listeners.clear();
  }
}

export function startWindowsAutoUpdates(options) {
  if (!isPackagedWindows({
    platform: options.platform || process.platform,
    packaged: options.app.isPackaged,
  })) {
    return null;
  }
  const controller = new WindowsUpdaterController(options);
  controller.start();
  return controller;
}

export const windowsUpdatePolicy = Object.freeze({
  repository: WINDOWS_UPDATE_REPOSITORY,
  host: WINDOWS_UPDATE_HOST,
  updateInterval: WINDOWS_UPDATE_INTERVAL,
  startupDelayMs: WINDOWS_UPDATE_STARTUP_DELAY_MS,
  firstRunDelayMs: WINDOWS_UPDATE_FIRST_RUN_DELAY_MS,
});
