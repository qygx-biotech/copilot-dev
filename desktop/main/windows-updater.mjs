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
export const WINDOWS_BETA_ARCHITECTURE = "x64";
export const WINDOWS_BETA_RELEASES_API_URL = "https://api.github.com/repos/qygx-biotech/copilot-dev/releases?per_page=100";
export const WINDOWS_BETA_RELEASES_DOWNLOAD_BASE = "https://github.com/qygx-biotech/copilot-dev/releases/download";
export const WINDOWS_BETA_ASSET_REDIRECT_HOST = "release-assets.githubusercontent.com";

const BETA_API_RESPONSE_LIMIT = 2 * 1024 * 1024;
const BETA_METADATA_RESPONSE_LIMIT = 64 * 1024;
const BETA_REQUEST_TIMEOUT_MS = 15 * 1000;
const SQUIRREL_LIFECYCLE_ARGUMENTS = new Set([
  "--squirrel-install",
  "--squirrel-updated",
  "--squirrel-uninstall",
  "--squirrel-obsolete",
]);

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

const SEMVER_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;

export function hasSquirrelLifecycleEvent(processArguments = []) {
  return processArguments.some((argument) => SQUIRREL_LIFECYCLE_ARGUMENTS.has(argument));
}

export function isPackagedWindows({ platform, packaged, processArguments = [], squirrelLifecycleEvent = false }) {
  return platform === "win32" &&
    packaged === true &&
    squirrelLifecycleEvent !== true &&
    !hasSquirrelLifecycleEvent(processArguments);
}

export function parseSemanticVersion(value, { allowLeadingV = false } = {}) {
  const input = String(value || "").trim();
  const text = allowLeadingV && input.startsWith("v") ? input.slice(1) : input;
  if ((!allowLeadingV && input.startsWith("v")) || !SEMVER_PATTERN.test(text)) return null;
  const match = SEMVER_PATTERN.exec(text);
  const prerelease = match[4] ? match[4].split(".") : [];
  if (prerelease.some((identifier) => /^\d+$/.test(identifier) && identifier.length > 1 && identifier.startsWith("0"))) return null;
  return { text, core: match.slice(1, 4), prerelease };
}

export function toSquirrelPackageVersion(value) {
  const parsed = parseSemanticVersion(value);
  if (!parsed) return null;
  const core = parsed.core.join(".");
  return parsed.prerelease.length ? `${core}-${parsed.prerelease.join("")}` : core;
}

export function parseStableVersion(value) {
  const parsed = parseSemanticVersion(value, { allowLeadingV: true });
  if (!parsed || parsed.prerelease.length) return null;
  return { text: parsed.text, parts: parsed.core.map(Number) };
}

export function parsePrereleaseVersion(value) {
  const parsed = parseSemanticVersion(value);
  return parsed?.prerelease.length ? parsed : null;
}

function compareNumericIdentifiers(left, right) {
  const normalizedLeft = left.replace(/^0+(?=\d)/, "");
  const normalizedRight = right.replace(/^0+(?=\d)/, "");
  if (normalizedLeft.length !== normalizedRight.length) return normalizedLeft.length > normalizedRight.length ? 1 : -1;
  return normalizedLeft === normalizedRight ? 0 : normalizedLeft > normalizedRight ? 1 : -1;
}

export function compareSemanticVersions(leftValue, rightValue) {
  const left = typeof leftValue === "string" ? parseSemanticVersion(leftValue) : leftValue;
  const right = typeof rightValue === "string" ? parseSemanticVersion(rightValue) : rightValue;
  if (!left || !right) throw new TypeError("Valid semantic versions are required.");
  for (let index = 0; index < 3; index += 1) {
    const comparison = compareNumericIdentifiers(left.core[index], right.core[index]);
    if (comparison) return comparison;
  }
  if (!left.prerelease.length && !right.prerelease.length) return 0;
  if (!left.prerelease.length) return 1;
  if (!right.prerelease.length) return -1;
  const length = Math.max(left.prerelease.length, right.prerelease.length);
  for (let index = 0; index < length; index += 1) {
    const leftIdentifier = left.prerelease[index];
    const rightIdentifier = right.prerelease[index];
    if (leftIdentifier === undefined) return -1;
    if (rightIdentifier === undefined) return 1;
    if (leftIdentifier === rightIdentifier) continue;
    const leftNumeric = /^\d+$/.test(leftIdentifier);
    const rightNumeric = /^\d+$/.test(rightIdentifier);
    if (leftNumeric && rightNumeric) return compareNumericIdentifiers(leftIdentifier, rightIdentifier);
    if (leftNumeric !== rightNumeric) return leftNumeric ? -1 : 1;
    return leftIdentifier > rightIdentifier ? 1 : -1;
  }
  return 0;
}

export function isStrictlyNewerStableVersion(candidate, current) {
  const next = parseStableVersion(candidate);
  const installed = parseStableVersion(current);
  return Boolean(next && installed && compareSemanticVersions(next.text, installed.text) > 0);
}

export function isStrictlyNewerPrereleaseVersion(candidate, current) {
  const next = parsePrereleaseVersion(candidate);
  const installed = parsePrereleaseVersion(current);
  return Boolean(next && installed && compareSemanticVersions(next, installed) > 0);
}

export function getBetaUpdateEligibility({
  platform,
  packaged,
  version,
  architecture,
  processArguments = [],
  squirrelLifecycleEvent = false,
}) {
  if (squirrelLifecycleEvent || hasSquirrelLifecycleEvent(processArguments)) {
    return Object.freeze({ eligible: false, canCheck: false, reason: "squirrel_lifecycle" });
  }
  if (platform !== "win32" || packaged !== true) {
    return Object.freeze({ eligible: false, canCheck: false, reason: "packaged_windows_only" });
  }
  if (architecture !== WINDOWS_BETA_ARCHITECTURE) {
    return Object.freeze({ eligible: false, canCheck: false, reason: "unsupported_architecture" });
  }
  if (parseStableVersion(version)) {
    return Object.freeze({ eligible: false, canCheck: false, reason: "stable_build" });
  }
  const parsed = parsePrereleaseVersion(version);
  if (!parsed) {
    return Object.freeze({ eligible: false, canCheck: false, reason: "invalid_version" });
  }
  return Object.freeze({ eligible: true, canCheck: true, reason: "ready", version: parsed.text });
}

function expectedBetaAssetNames(version) {
  const squirrelVersion = toSquirrelPackageVersion(version);
  return Object.freeze({
    setup: "BioDesign-Setup.exe",
    releases: "RELEASES",
    fullPackage: `BioDesign-${squirrelVersion}-full.nupkg`,
    checksums: "SHA256SUMS.txt",
    architectureMarker: `BioDesign-win32-x64-${version}.zip`,
  });
}

function expectedBetaAssetUrl(tag, name) {
  return `${WINDOWS_BETA_RELEASES_DOWNLOAD_BASE}/${tag}/${encodeURIComponent(name)}`;
}

export function validateBetaRelease(release, { currentVersion, architecture = WINDOWS_BETA_ARCHITECTURE } = {}) {
  if (!release || release.draft !== false || release.prerelease !== true) return null;
  if (architecture !== WINDOWS_BETA_ARCHITECTURE) return null;
  const tag = typeof release.tag_name === "string" ? release.tag_name : "";
  if (!tag.startsWith("v")) return null;
  const version = parsePrereleaseVersion(tag.slice(1));
  if (!version || tag !== `v${version.text}`) return null;
  if (!isStrictlyNewerPrereleaseVersion(version.text, currentVersion)) return null;
  if (release.html_url !== `https://github.com/${WINDOWS_UPDATE_REPOSITORY}/releases/tag/${tag}`) return null;

  const names = expectedBetaAssetNames(version.text);
  const expectedNames = new Set(Object.values(names));
  if (!Array.isArray(release.assets) || release.assets.length !== expectedNames.size) return null;
  const assets = new Map();
  for (const asset of release.assets) {
    if (!asset || typeof asset.name !== "string" || !expectedNames.has(asset.name) || assets.has(asset.name)) return null;
    if (asset.state !== "uploaded" || !Number.isSafeInteger(asset.size) || asset.size <= 0) return null;
    if (asset.browser_download_url !== expectedBetaAssetUrl(tag, asset.name)) return null;
    if (asset.digest != null && !/^sha256:[a-f\d]{64}$/i.test(asset.digest)) return null;
    assets.set(asset.name, Object.freeze({
      name: asset.name,
      size: asset.size,
      digest: asset.digest || null,
      downloadUrl: asset.browser_download_url,
    }));
  }
  if (Array.from(assets.keys()).filter((name) => name.endsWith("-full.nupkg")).length !== 1) return null;

  return Object.freeze({
    version: version.text,
    tag,
    feedUrl: `${WINDOWS_BETA_RELEASES_DOWNLOAD_BASE}/${tag}`,
    assets: Object.freeze({
      setup: assets.get(names.setup),
      releases: assets.get(names.releases),
      fullPackage: assets.get(names.fullPackage),
      checksums: assets.get(names.checksums),
      architectureMarker: assets.get(names.architectureMarker),
    }),
  });
}

export function selectEligibleBetaReleases(releases, options = {}) {
  if (!Array.isArray(releases)) return [];
  return releases
    .map((release) => validateBetaRelease(release, options))
    .filter(Boolean)
    .sort((left, right) => compareSemanticVersions(right.version, left.version));
}

async function readBoundedText(response, maximumBytes) {
  const contentLength = Number(response.headers?.get?.("content-length"));
  if (Number.isFinite(contentLength) && contentLength > maximumBytes) throw new Error("response_too_large");
  if (!response.body?.getReader) {
    const text = await response.text();
    if (Buffer.byteLength(text, "utf8") > maximumBytes) throw new Error("response_too_large");
    return text;
  }
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maximumBytes) {
      await reader.cancel().catch(() => {});
      throw new Error("response_too_large");
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString("utf8");
}

function requestSignal() {
  return typeof AbortSignal?.timeout === "function" ? AbortSignal.timeout(BETA_REQUEST_TIMEOUT_MS) : undefined;
}

async function fetchPublicReleaseList(fetchImplementation) {
  const response = await fetchImplementation(WINDOWS_BETA_RELEASES_API_URL, {
    method: "GET",
    redirect: "error",
    headers: {
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
    },
    signal: requestSignal(),
  });
  if (!response?.ok || response.status !== 200) throw new Error("github_releases_unavailable");
  const contentType = response.headers?.get?.("content-type") || "";
  if (!contentType.toLowerCase().includes("json")) throw new Error("github_releases_invalid");
  const parsed = JSON.parse(await readBoundedText(response, BETA_API_RESPONSE_LIMIT));
  if (!Array.isArray(parsed) || parsed.length > 100) throw new Error("github_releases_invalid");
  return parsed;
}

function isRedirectStatus(status) {
  return [301, 302, 303, 307, 308].includes(status);
}

async function fetchValidatedGithubAssetText(fetchImplementation, expectedUrl, maximumBytes) {
  let currentUrl = new URL(expectedUrl);
  let redirected = false;
  for (let redirectCount = 0; redirectCount <= 3; redirectCount += 1) {
    const response = await fetchImplementation(currentUrl.href, {
      method: "GET",
      redirect: "manual",
      headers: { Accept: "application/octet-stream" },
      signal: requestSignal(),
    });
    if (isRedirectStatus(response?.status)) {
      const location = response.headers?.get?.("location");
      if (!location) throw new Error("github_asset_redirect_invalid");
      const nextUrl = new URL(location, currentUrl);
      if (nextUrl.protocol !== "https:" || nextUrl.hostname !== WINDOWS_BETA_ASSET_REDIRECT_HOST) {
        throw new Error("github_asset_redirect_invalid");
      }
      currentUrl = nextUrl;
      redirected = true;
      continue;
    }
    const allowedCurrentHost = currentUrl.hostname === "github.com" ||
      (redirected && currentUrl.hostname === WINDOWS_BETA_ASSET_REDIRECT_HOST);
    if (!allowedCurrentHost || currentUrl.protocol !== "https:" || !response?.ok || response.status !== 200) {
      throw new Error("github_asset_unavailable");
    }
    return readBoundedText(response, maximumBytes);
  }
  throw new Error("github_asset_redirect_invalid");
}

function validateReleaseManifest(candidate, releasesText) {
  const lines = String(releasesText || "").trim().split(/\r?\n/).filter(Boolean);
  if (lines.length !== 1) return false;
  const match = /^([a-f\d]{40})\s+([A-Za-z0-9._-]+)\s+(\d+)$/i.exec(lines[0]);
  return Boolean(match && match[2] === candidate.assets.fullPackage.name && Number(match[3]) === candidate.assets.fullPackage.size);
}

function validateChecksums(candidate, checksumsText) {
  const required = new Map([
    [candidate.assets.setup.name, candidate.assets.setup],
    [candidate.assets.releases.name, candidate.assets.releases],
    [candidate.assets.fullPackage.name, candidate.assets.fullPackage],
    [candidate.assets.architectureMarker.name, candidate.assets.architectureMarker],
  ]);
  const lines = String(checksumsText || "").trim().split(/\r?\n/).filter(Boolean);
  if (lines.length !== required.size) return false;
  const found = new Map();
  for (const line of lines) {
    const match = /^([a-f\d]{64})\s{2}([A-Za-z0-9._-]+)$/i.exec(line);
    if (!match || !required.has(match[2]) || found.has(match[2])) return false;
    const asset = required.get(match[2]);
    if (asset.digest && asset.digest.toLowerCase() !== `sha256:${match[1].toLowerCase()}`) return false;
    found.set(match[2], match[1].toLowerCase());
  }
  return found.size === required.size;
}

async function preflightBetaRelease(fetchImplementation, candidate) {
  const releasesText = await fetchValidatedGithubAssetText(
    fetchImplementation,
    candidate.assets.releases.downloadUrl,
    BETA_METADATA_RESPONSE_LIMIT
  );
  if (!validateReleaseManifest(candidate, releasesText)) return false;
  const checksumsText = await fetchValidatedGithubAssetText(
    fetchImplementation,
    candidate.assets.checksums.downloadUrl,
    BETA_METADATA_RESPONSE_LIMIT
  );
  return validateChecksums(candidate, checksumsText);
}

export async function discoverEligibleBetaRelease({
  currentVersion,
  architecture = WINDOWS_BETA_ARCHITECTURE,
  fetchImplementation = globalThis.fetch,
} = {}) {
  if (typeof fetchImplementation !== "function" || !parsePrereleaseVersion(currentVersion)) return null;
  const releases = await fetchPublicReleaseList(fetchImplementation);
  const candidates = selectEligibleBetaReleases(releases, { currentVersion, architecture });
  for (const candidate of candidates) {
    if (await preflightBetaRelease(fetchImplementation, candidate)) return candidate;
  }
  return null;
}

function sanitizedBetaStatus(state, { reason = null, version = null } = {}) {
  return Object.freeze({ state, ...(reason ? { reason } : {}), ...(version ? { version } : {}) });
}

export class WindowsUpdaterController {
  constructor(options) {
    this.app = options.app;
    this.autoUpdater = options.autoUpdater;
    this.dialog = options.dialog;
    this.platform = options.platform || process.platform;
    this.architecture = options.architecture || process.arch;
    this.processArguments = options.processArguments || [];
    this.squirrelLifecycleEvent = options.squirrelLifecycleEvent === true;
    this.getWorkState = options.getWorkState || (() => ({ projectOpen: false, runningJobs: false }));
    this.prepareForUpdate = options.prepareForUpdate || (async () => {});
    this.logEvent = options.logEvent || (() => {});
    this.onBetaStatus = options.onBetaStatus || (() => {});
    this.updateElectronApp = options.updateElectronApp || updateElectronApp;
    this.fetchImplementation = options.fetchImplementation || globalThis.fetch;
    this.setTimeout = options.setTimeout || globalThis.setTimeout;
    this.clearTimeout = options.clearTimeout || globalThis.clearTimeout;
    this.setInterval = options.setInterval || globalThis.setInterval;
    this.clearInterval = options.clearInterval || globalThis.clearInterval;
    this.phase = "idle";
    this.activeChannel = null;
    this.expectedBetaVersion = null;
    this.started = false;
    this.stopped = false;
    this.prompting = false;
    this.betaFirstRunBlocked = false;
    this.lastBetaStatus = sanitizedBetaStatus("unsupported", { reason: "not_started" });
    this.startupTimer = null;
    this.periodicTimer = null;
    this.listeners = new Map();
  }

  betaEligibility() {
    return getBetaUpdateEligibility({
      platform: this.platform,
      packaged: this.app.isPackaged,
      version: this.app.getVersion(),
      architecture: this.architecture,
      processArguments: this.processArguments,
      squirrelLifecycleEvent: this.squirrelLifecycleEvent,
    });
  }

  getBetaUpdateCapability() {
    const eligibility = this.betaEligibility();
    if (!eligibility.eligible) return eligibility;
    if (this.betaFirstRunBlocked) {
      return Object.freeze({ eligible: true, canCheck: false, reason: "squirrel_first_run", version: eligibility.version });
    }
    return Object.freeze({ ...eligibility, canCheck: !this.stopped });
  }

  emitBetaStatus(status) {
    this.lastBetaStatus = status;
    try {
      this.onBetaStatus(status);
    } catch {
      this.logEvent("windows_beta_updater_status_delivery_failed");
    }
    return status;
  }

  start() {
    if (this.started || this.stopped) return;
    this.started = true;
    this.attachListeners();
    const betaEligibility = this.betaEligibility();
    const firstRun = this.processArguments.includes("--squirrel-firstrun");
    if (betaEligibility.eligible) {
      if (firstRun) {
        this.betaFirstRunBlocked = true;
        this.emitBetaStatus(sanitizedBetaStatus("temporarily-unavailable", { reason: "squirrel_first_run" }));
        this.startupTimer = this.setTimeout(() => {
          this.startupTimer = null;
          this.betaFirstRunBlocked = false;
          this.emitBetaStatus(sanitizedBetaStatus("idle", { reason: "ready" }));
        }, WINDOWS_UPDATE_FIRST_RUN_DELAY_MS);
        this.logEvent("windows_beta_updater_first_run_delayed");
      } else {
        this.emitBetaStatus(sanitizedBetaStatus("idle", { reason: "ready" }));
        this.logEvent("windows_beta_updater_ready");
      }
      return;
    }
    if (!parseStableVersion(this.app.getVersion())) {
      this.logEvent("windows_updater_unsupported_version");
      return;
    }
    const delay = firstRun ? WINDOWS_UPDATE_FIRST_RUN_DELAY_MS : WINDOWS_UPDATE_STARTUP_DELAY_MS;
    this.startupTimer = this.setTimeout(() => {
      this.startupTimer = null;
      this.initializeStableUpdater();
    }, delay);
    this.logEvent(firstRun ? "windows_updater_first_run_delayed" : "windows_updater_scheduled");
  }

  attachListeners() {
    const handlers = {
      "checking-for-update": () => { this.phase = "checking"; },
      "update-available": () => {
        this.phase = "downloading";
        if (this.activeChannel === "beta") {
          this.emitBetaStatus(sanitizedBetaStatus("downloading", { version: this.expectedBetaVersion }));
        }
      },
      "update-not-available": () => {
        if (this.activeChannel === "beta") this.emitBetaStatus(sanitizedBetaStatus("no-eligible-beta"));
        this.resetOperation();
      },
      error: () => {
        if (this.activeChannel === "beta") this.emitBetaStatus(sanitizedBetaStatus("temporarily-unavailable"));
        this.resetOperation();
        this.logEvent("windows_updater_error");
      },
      "update-downloaded": (_event, _releaseNotes, releaseName) => { void this.handleDownloaded(releaseName); },
    };
    for (const [event, handler] of Object.entries(handlers)) {
      this.listeners.set(event, handler);
      this.autoUpdater.on(event, handler);
    }
  }

  initializeStableUpdater() {
    if (this.stopped || this.phase !== "idle") return;
    this.phase = "checking";
    this.activeChannel = "stable";
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
      librarySchedule.stopUpdates();
      this.periodicTimer = this.setInterval(() => { this.checkForUpdates(); }, WINDOWS_UPDATE_INTERVAL_MS);
    } catch {
      this.resetOperation();
      this.logEvent("windows_updater_initialization_failed");
    }
  }

  checkForUpdates() {
    if (this.stopped || !parseStableVersion(this.app.getVersion()) || this.phase !== "idle") {
      this.logEvent("windows_updater_overlapping_check_skipped");
      return false;
    }
    this.phase = "checking";
    this.activeChannel = "stable";
    try {
      const request = this.autoUpdater.checkForUpdates();
      if (request && typeof request.catch === "function") {
        request.catch(() => {
          this.resetOperation();
          this.logEvent("windows_updater_check_failed");
        });
      }
      return true;
    } catch {
      this.resetOperation();
      this.logEvent("windows_updater_check_failed");
      return false;
    }
  }

  async requestBetaUpdateCheck() {
    const capability = this.getBetaUpdateCapability();
    if (!capability.eligible) {
      return this.emitBetaStatus(sanitizedBetaStatus("unsupported", { reason: capability.reason }));
    }
    if (!capability.canCheck) {
      return this.emitBetaStatus(sanitizedBetaStatus("temporarily-unavailable", { reason: capability.reason }));
    }
    if (this.phase !== "idle") {
      this.logEvent("windows_beta_updater_duplicate_check_skipped");
      return this.lastBetaStatus;
    }

    this.phase = "discovering";
    this.activeChannel = "beta";
    this.expectedBetaVersion = null;
    this.emitBetaStatus(sanitizedBetaStatus("checking"));
    try {
      const candidate = await discoverEligibleBetaRelease({
        currentVersion: this.app.getVersion(),
        architecture: this.architecture,
        fetchImplementation: this.fetchImplementation,
      });
      if (this.stopped) return sanitizedBetaStatus("temporarily-unavailable");
      if (!candidate) {
        this.resetOperation();
        return this.emitBetaStatus(sanitizedBetaStatus("no-eligible-beta"));
      }
      this.expectedBetaVersion = candidate.version;
      this.autoUpdater.setFeedURL({ url: candidate.feedUrl });
      this.phase = "checking";
      this.autoUpdater.checkForUpdates();
      return this.lastBetaStatus;
    } catch {
      this.resetOperation();
      this.logEvent("windows_beta_updater_check_failed");
      return this.emitBetaStatus(sanitizedBetaStatus("temporarily-unavailable"));
    }
  }

  resetOperation() {
    this.phase = "idle";
    this.activeChannel = null;
    this.expectedBetaVersion = null;
  }

  async handleDownloaded(releaseName) {
    if (this.stopped || this.prompting || this.phase === "downloaded") return;
    const channel = this.activeChannel;
    const installedVersion = this.app.getVersion();
    const stable = channel === "stable" ? parseStableVersion(releaseName) : null;
    const beta = channel === "beta" ? parsePrereleaseVersion(this.expectedBetaVersion) : null;
    const acceptedStable = stable && isStrictlyNewerStableVersion(stable.text, installedVersion);
    const acceptedBeta = beta &&
      releaseName === toSquirrelPackageVersion(beta.text) &&
      isStrictlyNewerPrereleaseVersion(beta.text, installedVersion);
    if (!acceptedStable && !acceptedBeta) {
      if (channel === "beta") this.emitBetaStatus(sanitizedBetaStatus("temporarily-unavailable"));
      this.resetOperation();
      this.logEvent("windows_updater_rejected_version");
      return;
    }

    const parsed = acceptedBeta ? beta : stable;
    this.phase = "downloaded";
    this.prompting = true;
    this.logEvent(acceptedBeta ? "windows_beta_updater_downloaded" : "windows_updater_downloaded");
    if (acceptedBeta) this.emitBetaStatus(sanitizedBetaStatus("ready-to-restart", { version: parsed.text }));
    try {
      const { response } = await this.dialog.showMessageBox({
        type: "info",
        title: acceptedBeta ? "BioDesign beta update ready" : "BioDesign update ready",
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
        this.logEvent(workState.runningJobs ? "windows_updater_restart_blocked_by_job" : "windows_updater_restart_blocked_by_project");
        await this.dialog.showMessageBox({
          type: "info",
          title: "Update will install later",
          message: workState.runningJobs ? "BioDesign did not interrupt the running job." : "BioDesign did not close the open project.",
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
    for (const [event, handler] of this.listeners) this.autoUpdater.removeListener(event, handler);
    this.listeners.clear();
  }
}

export function startWindowsAutoUpdates(options) {
  if (!isPackagedWindows({
    platform: options.platform || process.platform,
    packaged: options.app.isPackaged,
    processArguments: options.processArguments,
    squirrelLifecycleEvent: options.squirrelLifecycleEvent,
  })) return null;
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
  betaArchitecture: WINDOWS_BETA_ARCHITECTURE,
  betaReleasesApi: WINDOWS_BETA_RELEASES_API_URL,
  betaReleaseDownloadBase: WINDOWS_BETA_RELEASES_DOWNLOAD_BASE,
});
