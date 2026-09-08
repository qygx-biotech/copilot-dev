import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, rename, rm } from "node:fs/promises";
import path from "node:path";

export const BIO_DESIGN_APP_USER_MODEL_ID = "com.squirrel.BioDesign.BioDesign";
export const WINDOWS_UPDATE_REPOSITORY = "qygx-biotech/copilot-dev";
export const WINDOWS_RELEASES_API_URL = `https://api.github.com/repos/${WINDOWS_UPDATE_REPOSITORY}/releases?per_page=100`;
export const WINDOWS_RELEASES_DOWNLOAD_BASE = `https://github.com/${WINDOWS_UPDATE_REPOSITORY}/releases/download`;
export const WINDOWS_RELEASE_ASSET_REDIRECT_HOST = "release-assets.githubusercontent.com";
export const WINDOWS_INSTALLER_ASSET_NAME = "BioDesign-Setup.exe";
export const WINDOWS_CHECKSUMS_ASSET_NAME = "SHA256SUMS.txt";
export const WINDOWS_UPDATE_ARCHITECTURE = "x64";
export const WINDOWS_UPDATE_FIRST_RUN_DELAY_MS = 10 * 1000;
// Squirrel's normal Setup.exe flow installs the embedded full package and
// launches the new application. --silent suppresses that relaunch, so it is
// reserved for CI installation fixtures rather than the user-approved update.
export const WINDOWS_INSTALLER_ARGUMENTS = Object.freeze([]);

const API_RESPONSE_LIMIT = 2 * 1024 * 1024;
const CHECKSUM_RESPONSE_LIMIT = 64 * 1024;
const METADATA_REQUEST_TIMEOUT_MS = 15 * 1000;
const INSTALLER_REQUEST_TIMEOUT_MS = 15 * 60 * 1000;
const MAX_INSTALLER_BYTES = 1024 * 1024 * 1024;
const SQUIRREL_LIFECYCLE_ARGUMENTS = new Set([
  "--squirrel-install",
  "--squirrel-updated",
  "--squirrel-uninstall",
  "--squirrel-obsolete",
]);
const SEMVER_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;

class WindowsUpdateError extends Error {
  constructor(code, cause) {
    super(code, cause ? { cause } : undefined);
    this.name = "WindowsUpdateError";
    this.code = code;
  }
}

function updateError(code, cause) {
  return cause instanceof WindowsUpdateError ? cause : new WindowsUpdateError(code, cause);
}

function errorCode(error) {
  return typeof error?.code === "string" ? error.code : "unexpected_error";
}

export function hasSquirrelLifecycleEvent(processArguments = []) {
  return processArguments.some((argument) => SQUIRREL_LIFECYCLE_ARGUMENTS.has(argument));
}

export function isPackagedWindows({ platform, packaged, processArguments = [], squirrelLifecycleEvent = false }) {
  return platform === "win32" && packaged === true && squirrelLifecycleEvent !== true &&
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

// Squirrel removes dots from prerelease identifiers when naming a NUPKG.
// Release verification and the existing packaging smoke fixtures use this.
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

function updateChannel(version) {
  const parsed = parseSemanticVersion(version);
  if (!parsed) return null;
  return parsed.prerelease.length ? "prerelease" : "stable";
}

export function getWindowsUpdateEligibility({
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
  if (architecture !== WINDOWS_UPDATE_ARCHITECTURE) {
    return Object.freeze({ eligible: false, canCheck: false, reason: "unsupported_architecture" });
  }
  const channel = updateChannel(version);
  if (!channel) return Object.freeze({ eligible: false, canCheck: false, reason: "invalid_version" });
  return Object.freeze({ eligible: true, canCheck: true, reason: "ready", version, channel });
}

function expectedAssetUrl(tag, name) {
  return `${WINDOWS_RELEASES_DOWNLOAD_BASE}/${tag}/${encodeURIComponent(name)}`;
}

function normalizedReleaseNotes(value) {
  if (typeof value !== "string") return "";
  return value.replaceAll("\r", "")
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "")
    .trim()
    .slice(0, 4000);
}

function isNewerReleaseOnInstalledChannel(release, currentVersion) {
  if (!release || release.draft !== false) return false;
  const installed = parseSemanticVersion(currentVersion);
  const tag = typeof release.tag_name === "string" ? release.tag_name : "";
  const candidate = parseSemanticVersion(tag, { allowLeadingV: true });
  if (!installed || !candidate || tag !== `v${candidate.text}`) return false;
  const installedPrerelease = installed.prerelease.length > 0;
  if (release.prerelease !== installedPrerelease || (candidate.prerelease.length > 0) !== installedPrerelease) return false;
  return compareSemanticVersions(candidate, installed) > 0;
}

export function validateWindowsRelease(release, {
  currentVersion,
  architecture = WINDOWS_UPDATE_ARCHITECTURE,
} = {}) {
  if (architecture !== WINDOWS_UPDATE_ARCHITECTURE || !isNewerReleaseOnInstalledChannel(release, currentVersion)) return null;
  const tag = release.tag_name;
  const version = parseSemanticVersion(tag, { allowLeadingV: true });
  if (release.html_url !== `https://github.com/${WINDOWS_UPDATE_REPOSITORY}/releases/tag/${tag}`) return null;
  if (!Array.isArray(release.assets) || release.assets.length < 2 || release.assets.length > 20) return null;

  const assets = new Map();
  for (const asset of release.assets) {
    if (!asset || typeof asset.name !== "string" || !/^[A-Za-z0-9._-]+$/.test(asset.name) || assets.has(asset.name)) return null;
    if (asset.state !== "uploaded" || !Number.isSafeInteger(asset.size) || asset.size <= 0) return null;
    if (asset.browser_download_url !== expectedAssetUrl(tag, asset.name)) return null;
    if (asset.digest != null && !/^sha256:[a-f\d]{64}$/i.test(asset.digest)) return null;
    assets.set(asset.name, Object.freeze({
      name: asset.name,
      size: asset.size,
      digest: asset.digest?.toLowerCase() || null,
      downloadUrl: asset.browser_download_url,
    }));
  }
  const setup = assets.get(WINDOWS_INSTALLER_ASSET_NAME);
  const checksums = assets.get(WINDOWS_CHECKSUMS_ASSET_NAME);
  if (!setup || !checksums || setup.size > MAX_INSTALLER_BYTES || checksums.size > CHECKSUM_RESPONSE_LIMIT) return null;

  return Object.freeze({
    version: version.text,
    tag,
    channel: version.prerelease.length ? "prerelease" : "stable",
    releaseUrl: release.html_url,
    releaseNotes: normalizedReleaseNotes(release.body),
    assetNames: Object.freeze([...assets.keys()]),
    assets: Object.freeze({ setup, checksums }),
  });
}

export function selectEligibleWindowsReleases(releases, options = {}) {
  if (!Array.isArray(releases)) return [];
  return releases.map((release) => validateWindowsRelease(release, options)).filter(Boolean)
    .sort((left, right) => compareSemanticVersions(right.version, left.version));
}

async function readBoundedText(response, maximumBytes) {
  const contentLengthHeader = response.headers?.get?.("content-length");
  const contentLength = contentLengthHeader == null || contentLengthHeader === "" ? null : Number(contentLengthHeader);
  if (Number.isFinite(contentLength) && contentLength > maximumBytes) throw updateError("metadata_too_large");
  if (!response.body?.getReader) {
    const text = await response.text();
    if (Buffer.byteLength(text, "utf8") > maximumBytes) throw updateError("metadata_too_large");
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
      throw updateError("metadata_too_large");
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString("utf8");
}

function requestSignal(timeoutMs) {
  return typeof AbortSignal?.timeout === "function" ? AbortSignal.timeout(timeoutMs) : undefined;
}

async function fetchPublicReleaseList(fetchImplementation) {
  let response;
  try {
    response = await fetchImplementation(WINDOWS_RELEASES_API_URL, {
      method: "GET",
      redirect: "error",
      headers: { Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" },
      signal: requestSignal(METADATA_REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    throw updateError("github_releases_unavailable", error);
  }
  if (!response?.ok || response.status !== 200) throw updateError("github_releases_unavailable");
  const contentType = response.headers?.get?.("content-type") || "";
  if (!contentType.toLowerCase().includes("json")) throw updateError("github_releases_invalid");
  try {
    const parsed = JSON.parse(await readBoundedText(response, API_RESPONSE_LIMIT));
    if (!Array.isArray(parsed) || parsed.length > 100) throw updateError("github_releases_invalid");
    return parsed;
  } catch (error) {
    throw updateError("github_releases_invalid", error);
  }
}

function isRedirectStatus(status) {
  return [301, 302, 303, 307, 308].includes(status);
}

function isSecureHost(url, hostname) {
  return url.protocol === "https:" && url.hostname === hostname && url.port === "" &&
    url.username === "" && url.password === "";
}

async function fetchValidatedGithubAsset(fetchImplementation, expectedUrl, timeoutMs) {
  let currentUrl = new URL(expectedUrl);
  let redirected = false;
  for (let redirectCount = 0; redirectCount <= 3; redirectCount += 1) {
    let response;
    try {
      response = await fetchImplementation(currentUrl.href, {
        method: "GET",
        redirect: "manual",
        headers: { Accept: "application/octet-stream" },
        signal: requestSignal(timeoutMs),
      });
    } catch (error) {
      throw updateError("github_asset_unavailable", error);
    }
    if (isRedirectStatus(response?.status)) {
      const location = response.headers?.get?.("location");
      if (!location) throw updateError("github_asset_redirect_invalid");
      const nextUrl = new URL(location, currentUrl);
      if (!isSecureHost(nextUrl, WINDOWS_RELEASE_ASSET_REDIRECT_HOST)) {
        throw updateError("github_asset_redirect_invalid");
      }
      currentUrl = nextUrl;
      redirected = true;
      continue;
    }
    const allowedHost = isSecureHost(currentUrl, "github.com") ||
      (redirected && isSecureHost(currentUrl, WINDOWS_RELEASE_ASSET_REDIRECT_HOST));
    if (!allowedHost || !response?.ok || response.status !== 200) {
      throw updateError("github_asset_unavailable");
    }
    return response;
  }
  throw updateError("github_asset_redirect_invalid");
}

function installerChecksum(candidate, checksumsText) {
  const lines = String(checksumsText || "").trim().split(/\r?\n/).filter(Boolean);
  if (!lines.length || lines.length > candidate.assetNames.length) return null;
  const releaseAssets = new Set(candidate.assetNames);
  const hashes = new Map();
  for (const line of lines) {
    const match = /^([a-f\d]{64})\s{2}([A-Za-z0-9._-]+)$/i.exec(line);
    if (!match || !releaseAssets.has(match[2]) || hashes.has(match[2])) return null;
    hashes.set(match[2], match[1].toLowerCase());
  }
  const checksum = hashes.get(WINDOWS_INSTALLER_ASSET_NAME);
  if (!checksum) return null;
  if (candidate.assets.setup.digest && candidate.assets.setup.digest !== `sha256:${checksum}`) return null;
  return checksum;
}

export async function discoverEligibleWindowsRelease({
  currentVersion,
  architecture = WINDOWS_UPDATE_ARCHITECTURE,
  fetchImplementation = globalThis.fetch,
} = {}) {
  if (typeof fetchImplementation !== "function" || !parseSemanticVersion(currentVersion)) {
    throw updateError("invalid_update_configuration");
  }
  const releases = await fetchPublicReleaseList(fetchImplementation);
  const candidates = selectEligibleWindowsReleases(releases, { currentVersion, architecture });
  const newerOnChannel = releases.some((release) => isNewerReleaseOnInstalledChannel(release, currentVersion));
  if (!candidates.length && newerOnChannel) throw updateError("release_metadata_invalid");
  for (const candidate of candidates) {
    const response = await fetchValidatedGithubAsset(fetchImplementation, candidate.assets.checksums.downloadUrl,
      METADATA_REQUEST_TIMEOUT_MS);
    const checksum = installerChecksum(candidate, await readBoundedText(response, CHECKSUM_RESPONSE_LIMIT));
    if (checksum) return Object.freeze({ ...candidate, sha256: checksum });
  }
  if (candidates.length) throw updateError("release_checksum_invalid");
  return null;
}

async function writeAll(handle, buffer, position) {
  let offset = 0;
  while (offset < buffer.byteLength) {
    const { bytesWritten } = await handle.write(buffer, offset, buffer.byteLength - offset, position + offset);
    if (!bytesWritten) throw updateError("installer_write_failed");
    offset += bytesWritten;
  }
}

export async function downloadVerifiedWindowsInstaller({
  candidate,
  updateDirectory,
  fetchImplementation = globalThis.fetch,
  onProgress = () => {},
  randomUUIDImplementation = randomUUID,
} = {}) {
  if (!candidate || !/^[a-f\d]{64}$/.test(candidate.sha256) ||
      candidate.assets?.setup?.name !== WINDOWS_INSTALLER_ASSET_NAME ||
      candidate.assets.setup.downloadUrl !== expectedAssetUrl(candidate.tag, WINDOWS_INSTALLER_ASSET_NAME) ||
      !path.isAbsolute(updateDirectory || "")) {
    throw updateError("invalid_update_configuration");
  }
  await mkdir(updateDirectory, { recursive: true });
  const identifier = randomUUIDImplementation();
  const finalPath = path.join(updateDirectory, `BioDesign-Setup-${candidate.version}-${identifier}.exe`);
  const partialPath = `${finalPath}.partial`;
  let handle;
  try {
    handle = await open(partialPath, "wx", 0o600);
    const response = await fetchValidatedGithubAsset(fetchImplementation, candidate.assets.setup.downloadUrl,
      INSTALLER_REQUEST_TIMEOUT_MS);
    const declaredLengthHeader = response.headers?.get?.("content-length");
    const declaredLength = declaredLengthHeader == null || declaredLengthHeader === "" ? null : Number(declaredLengthHeader);
    if (Number.isFinite(declaredLength) && declaredLength !== candidate.assets.setup.size) {
      throw updateError("installer_size_mismatch");
    }
    if (!response.body?.getReader) throw updateError("installer_download_invalid");
    const reader = response.body.getReader();
    const hash = createHash("sha256");
    let total = 0;
    let lastProgress = -1;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = Buffer.from(value);
      total += chunk.byteLength;
      if (total > candidate.assets.setup.size || total > MAX_INSTALLER_BYTES) {
        await reader.cancel().catch(() => {});
        throw updateError("installer_size_mismatch");
      }
      hash.update(chunk);
      await writeAll(handle, chunk, total - chunk.byteLength);
      const progress = Math.min(100, Math.floor((total / candidate.assets.setup.size) * 100));
      if (progress !== lastProgress) {
        lastProgress = progress;
        onProgress(progress);
      }
    }
    if (total !== candidate.assets.setup.size) throw updateError("installer_download_interrupted");
    onProgress(100);
    if (hash.digest("hex") !== candidate.sha256) throw updateError("installer_sha256_mismatch");
    await handle.close();
    handle = null;
    await rename(partialPath, finalPath);
    return finalPath;
  } catch (error) {
    await handle?.close().catch(() => {});
    await rm(partialPath, { force: true }).catch(() => {});
    throw updateError(errorCode(error), error);
  }
}

export function launchSquirrelInstaller(installerPath, {
  spawnImplementation = spawn,
  argumentsList = WINDOWS_INSTALLER_ARGUMENTS,
} = {}) {
  if (!path.isAbsolute(installerPath || "") || path.extname(installerPath).toLowerCase() !== ".exe" ||
      !Array.isArray(argumentsList) || argumentsList.some((argument) => typeof argument !== "string")) {
    return Promise.reject(updateError("installer_launch_invalid"));
  }
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawnImplementation(installerPath, argumentsList, {
        detached: true,
        stdio: "ignore",
        shell: false,
        windowsHide: true,
      });
    } catch (error) {
      reject(updateError("installer_launch_failed", error));
      return;
    }
    child.once("error", (error) => reject(updateError("installer_launch_failed", error)));
    child.once("spawn", () => {
      child.unref();
      resolve();
    });
  });
}

function sanitizedUpdateStatus(state, { reason = null, version = null, progress = null } = {}) {
  return Object.freeze({ state, ...(reason ? { reason } : {}), ...(version ? { version } : {}),
    ...(Number.isInteger(progress) && progress >= 0 && progress <= 100 ? { progress } : {}) });
}

function userFacingFailureReason(error) {
  const code = errorCode(error);
  if (code === "installer_sha256_mismatch") return "checksum_mismatch";
  if (code === "installer_launch_failed" || code === "installer_launch_invalid") return "launch_failed";
  if (code === "EACCES" || code === "EPERM" || code === "installer_write_failed") return "permission_problem";
  if (code.startsWith("installer_")) return "download_failed";
  if (code.includes("invalid") || code.includes("metadata") || code.includes("checksum")) return "invalid_metadata";
  return "network_unavailable";
}

export class WindowsUpdaterController {
  constructor(options) {
    this.app = options.app;
    this.dialog = options.dialog;
    this.platform = options.platform || process.platform;
    this.architecture = options.architecture || process.arch;
    this.processArguments = options.processArguments || [];
    this.squirrelLifecycleEvent = options.squirrelLifecycleEvent === true;
    this.updateDirectory = options.updateDirectory;
    this.getWorkState = options.getWorkState || (() => ({ projectOpen: false, runningJobs: false }));
    this.prepareForUpdate = options.prepareForUpdate || (async () => {});
    this.logEvent = options.logEvent || (() => {});
    this.onUpdateStatus = options.onUpdateStatus || (() => {});
    this.fetchImplementation = options.fetchImplementation || globalThis.fetch;
    this.downloadInstaller = options.downloadInstaller || downloadVerifiedWindowsInstaller;
    this.launchInstaller = options.launchInstaller || launchSquirrelInstaller;
    this.removeFile = options.removeFile || ((filePath) => rm(filePath, { force: true }));
    this.setTimeout = options.setTimeout || globalThis.setTimeout;
    this.clearTimeout = options.clearTimeout || globalThis.clearTimeout;
    this.phase = "idle";
    this.started = false;
    this.stopped = false;
    this.firstRunBlocked = false;
    this.lastStatus = sanitizedUpdateStatus("unsupported", { reason: "not_started" });
    this.firstRunTimer = null;
  }

  updateEligibility() {
    return getWindowsUpdateEligibility({
      platform: this.platform,
      packaged: this.app.isPackaged,
      version: this.app.getVersion(),
      architecture: this.architecture,
      processArguments: this.processArguments,
      squirrelLifecycleEvent: this.squirrelLifecycleEvent,
    });
  }

  getUpdateCapability() {
    const eligibility = this.updateEligibility();
    if (!eligibility.eligible) return eligibility;
    if (this.firstRunBlocked) return Object.freeze({ ...eligibility, canCheck: false, reason: "squirrel_first_run" });
    return Object.freeze({ ...eligibility, canCheck: !this.stopped });
  }

  emitStatus(status) {
    this.lastStatus = status;
    try {
      this.onUpdateStatus(status);
    } catch {
      this.logEvent("windows_updater_status_delivery_failed", "status_delivery_failed");
    }
    return status;
  }

  start() {
    if (this.started || this.stopped) return;
    this.started = true;
    const eligibility = this.updateEligibility();
    if (!eligibility.eligible) {
      this.emitStatus(sanitizedUpdateStatus("unsupported", { reason: eligibility.reason }));
      this.logEvent("windows_updater_unavailable", eligibility.reason);
      return;
    }
    if (this.processArguments.includes("--squirrel-firstrun")) {
      this.firstRunBlocked = true;
      this.emitStatus(sanitizedUpdateStatus("temporarily-unavailable", { reason: "squirrel_first_run" }));
      this.firstRunTimer = this.setTimeout(() => {
        this.firstRunTimer = null;
        this.firstRunBlocked = false;
        this.emitStatus(sanitizedUpdateStatus("idle", { reason: "ready" }));
      }, WINDOWS_UPDATE_FIRST_RUN_DELAY_MS);
      this.logEvent("windows_updater_first_run_delayed", "squirrel_first_run");
      return;
    }
    this.emitStatus(sanitizedUpdateStatus("idle", { reason: "ready" }));
    this.logEvent("windows_updater_ready", eligibility.channel);
  }

  async blockForActiveWork(candidate) {
    const workState = this.getWorkState();
    if (!workState.runningJobs && !workState.projectOpen) return null;
    const reason = workState.runningJobs ? "running_job" : "open_project";
    this.phase = "idle";
    this.logEvent("windows_updater_install_blocked", reason);
    await this.dialog.showMessageBox({
      type: "info", title: "Finish your work before updating",
      message: workState.runningJobs ? "BioDesign did not interrupt the running job." : "BioDesign did not close the open project.",
      detail: workState.runningJobs
        ? "Finish the job, save your work, and close the project before trying the update again."
        : "Save your work and close the project before trying the update again.",
      buttons: ["OK"], defaultId: 0, cancelId: 0, noLink: true,
    }).catch(() => {});
    return this.emitStatus(sanitizedUpdateStatus("blocked", { reason, version: candidate.version }));
  }

  async requestUpdateCheck() {
    const capability = this.getUpdateCapability();
    if (!capability.eligible) return this.emitStatus(sanitizedUpdateStatus("unsupported", { reason: capability.reason }));
    if (!capability.canCheck) return this.emitStatus(sanitizedUpdateStatus("temporarily-unavailable", { reason: capability.reason }));
    if (this.phase !== "idle") {
      this.logEvent("windows_updater_duplicate_check_skipped", this.phase);
      return this.lastStatus;
    }

    this.phase = "checking";
    this.emitStatus(sanitizedUpdateStatus("checking"));
    let candidate;
    try {
      candidate = await discoverEligibleWindowsRelease({
        currentVersion: this.app.getVersion(), architecture: this.architecture,
        fetchImplementation: this.fetchImplementation,
      });
      if (this.stopped) return sanitizedUpdateStatus("temporarily-unavailable");
      if (!candidate) {
        this.phase = "idle";
        this.logEvent("windows_updater_current", capability.channel);
        return this.emitStatus(sanitizedUpdateStatus("current"));
      }
    } catch (error) {
      return this.fail("windows_updater_check_failed", error);
    }

    this.phase = "prompting";
    this.emitStatus(sanitizedUpdateStatus("update-available", { version: candidate.version }));
    const releaseNotes = candidate.releaseNotes ? `\n\nRelease notes:\n${candidate.releaseNotes}` : "";
    let response;
    try {
      ({ response } = await this.dialog.showMessageBox({
        type: "info", title: "BioDesign update available",
        message: "A new version of BioDesign Copilot is available.",
        detail: `Current: ${this.app.getVersion()}\nLatest: ${candidate.version}${releaseNotes}`,
        buttons: ["Download and Install", "Later"], defaultId: 1, cancelId: 1, noLink: true,
      }));
    } catch (error) {
      return this.fail("windows_updater_prompt_failed", error);
    }
    if (response !== 0) {
      this.phase = "idle";
      this.logEvent("windows_updater_user_cancelled", candidate.version);
      return this.emitStatus(sanitizedUpdateStatus("cancelled", { version: candidate.version }));
    }

    const initialWorkBlock = await this.blockForActiveWork(candidate);
    if (initialWorkBlock) return initialWorkBlock;

    let installerPath;
    try {
      this.phase = "downloading";
      this.emitStatus(sanitizedUpdateStatus("downloading", { version: candidate.version, progress: 0 }));
      installerPath = await this.downloadInstaller({
        candidate, updateDirectory: this.updateDirectory, fetchImplementation: this.fetchImplementation,
        onProgress: (progress) => this.emitStatus(sanitizedUpdateStatus("downloading", { version: candidate.version, progress })),
      });
      this.phase = "verifying";
      this.emitStatus(sanitizedUpdateStatus("verifying", { version: candidate.version }));
      const finalWorkBlock = await this.blockForActiveWork(candidate);
      if (finalWorkBlock) {
        await this.removeFile(installerPath).catch(() => {});
        installerPath = null;
        return finalWorkBlock;
      }
      await this.prepareForUpdate();
      this.phase = "launching";
      await this.launchInstaller(installerPath);
      this.emitStatus(sanitizedUpdateStatus("launching", { version: candidate.version }));
      this.logEvent("windows_updater_installer_launched", candidate.version);
      this.app.quit();
      return this.lastStatus;
    } catch (error) {
      if (installerPath) await this.removeFile(installerPath).catch(() => {});
      return this.fail("windows_updater_install_failed", error);
    }
  }

  fail(event, error) {
    const code = errorCode(error);
    this.phase = "idle";
    this.logEvent(event, code);
    return this.emitStatus(sanitizedUpdateStatus("temporarily-unavailable", {
      reason: userFacingFailureReason(error),
    }));
  }

  stop() {
    if (this.stopped) return;
    this.stopped = true;
    if (this.firstRunTimer !== null) this.clearTimeout(this.firstRunTimer);
  }
}

export function startWindowsBinaryUpdates(options) {
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
  releasesApi: WINDOWS_RELEASES_API_URL,
  releaseDownloadBase: WINDOWS_RELEASES_DOWNLOAD_BASE,
  installerAsset: WINDOWS_INSTALLER_ASSET_NAME,
  checksumsAsset: WINDOWS_CHECKSUMS_ASSET_NAME,
  installerArguments: WINDOWS_INSTALLER_ARGUMENTS,
  architecture: WINDOWS_UPDATE_ARCHITECTURE,
  firstRunDelayMs: WINDOWS_UPDATE_FIRST_RUN_DELAY_MS,
});
