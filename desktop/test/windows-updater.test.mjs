import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  compareSemanticVersions,
  discoverEligibleWindowsRelease,
  downloadVerifiedWindowsInstaller,
  getWindowsUpdateEligibility,
  isPackagedWindows,
  launchSquirrelInstaller,
  parseSemanticVersion,
  selectEligibleWindowsReleases,
  startWindowsBinaryUpdates,
  validateWindowsRelease,
  WINDOWS_CHECKSUMS_ASSET_NAME,
  WINDOWS_INSTALLER_ARGUMENTS,
  WINDOWS_INSTALLER_ASSET_NAME,
  WINDOWS_RELEASE_ASSET_REDIRECT_HOST,
  WINDOWS_RELEASES_API_URL,
  WINDOWS_RELEASES_DOWNLOAD_BASE,
  WINDOWS_UPDATE_FIRST_RUN_DELAY_MS,
  WINDOWS_UPDATE_REPOSITORY,
} from "../main/windows-updater.mjs";

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function releaseAsset(tag, name, bytes, digest = null) {
  return {
    name,
    size: bytes.length,
    state: "uploaded",
    digest,
    browser_download_url: `${WINDOWS_RELEASES_DOWNLOAD_BASE}/${tag}/${encodeURIComponent(name)}`,
  };
}

function windowsRelease(version, { prerelease = version.includes("-"), setupBytes = Buffer.from("setup-binary"), ...overrides } = {}) {
  const tag = `v${version}`;
  const checksum = `${sha256(setupBytes)}  ${WINDOWS_INSTALLER_ASSET_NAME}\n`;
  const assets = [
    releaseAsset(tag, WINDOWS_INSTALLER_ASSET_NAME, setupBytes, `sha256:${sha256(setupBytes)}`),
    releaseAsset(tag, WINDOWS_CHECKSUMS_ASSET_NAME, Buffer.from(checksum)),
  ];
  return {
    draft: false,
    prerelease,
    tag_name: tag,
    html_url: `https://github.com/${WINDOWS_UPDATE_REPOSITORY}/releases/tag/${tag}`,
    body: "Bug fixes and improvements.",
    assets,
    ...overrides,
  };
}

function githubFetch(releases, files = new Map(), options = {}) {
  const calls = [];
  const fetchImplementation = async (url, request) => {
    calls.push({ url, request });
    if (options.offline) throw new Error("offline");
    if (url === WINDOWS_RELEASES_API_URL) {
      return new Response(options.invalidJson ? "{" : JSON.stringify(releases), {
        status: options.apiStatus || 200,
        headers: { "content-type": "application/json" },
      });
    }
    const parsed = new URL(url);
    if (parsed.hostname === "github.com") {
      return new Response(null, {
        status: 302,
        headers: { location: `https://${options.redirectHost || WINDOWS_RELEASE_ASSET_REDIRECT_HOST}/fixture/${parsed.pathname.split("/").pop()}` },
      });
    }
    if (parsed.hostname === WINDOWS_RELEASE_ASSET_REDIRECT_HOST) {
      const name = decodeURIComponent(parsed.pathname.split("/").pop());
      const bytes = files.get(name);
      if (!bytes) return new Response("missing", { status: 404 });
      return new Response(bytes, {
        status: 200,
        headers: { "content-type": "application/octet-stream", "content-length": String(bytes.length) },
      });
    }
    throw new Error("unexpected_url");
  };
  return { calls, fetchImplementation };
}

function releaseFixture(version = "0.1.7-beta.5", options = {}) {
  const setupBytes = options.setupBytes || Buffer.from("trusted-windows-installer");
  const release = windowsRelease(version, { setupBytes, prerelease: options.prerelease });
  const checksums = Buffer.from(`${sha256(setupBytes)}  ${WINDOWS_INSTALLER_ASSET_NAME}\n`);
  const files = new Map([[WINDOWS_CHECKSUMS_ASSET_NAME, checksums], [WINDOWS_INSTALLER_ASSET_NAME, setupBytes]]);
  return { release, setupBytes, files, source: githubFetch([release], files, options) };
}

function controllerFixture(options = {}) {
  const statuses = [];
  const events = [];
  const dialogs = [...(options.dialogs || [{ response: 1 }])];
  const timeouts = [];
  const calls = { downloads: 0, launches: 0, prepares: 0, quits: 0 };
  const app = {
    isPackaged: options.packaged ?? true,
    getVersion: () => options.version || "0.1.7-beta.4",
    quit: () => { calls.quits += 1; },
  };
  const controller = startWindowsBinaryUpdates({
    app,
    dialog: {
      calls: [],
      async showMessageBox(configuration) {
        this.calls.push(configuration);
        return dialogs.shift() || { response: 1 };
      },
    },
    platform: options.platform || "win32",
    architecture: options.architecture || "x64",
    processArguments: options.processArguments || [],
    updateDirectory: path.resolve("out", "test-updates"),
    fetchImplementation: options.fetchImplementation,
    getWorkState: options.getWorkState,
    downloadInstaller: options.downloadInstaller || (async () => {
      calls.downloads += 1;
      return path.resolve("out", "test-updates", "verified.exe");
    }),
    launchInstaller: options.launchInstaller || (async () => { calls.launches += 1; }),
    prepareForUpdate: async () => { calls.prepares += 1; },
    removeFile: async () => {},
    onUpdateStatus: (status) => statuses.push(status),
    logEvent: (event, detail) => events.push({ event, detail }),
    setTimeout: (callback, delay) => {
      timeouts.push({ callback, delay });
      return timeouts.length;
    },
    clearTimeout: () => {},
  });
  return { app, calls, controller, dialog: controller?.dialog, events, statuses, timeouts };
}

test("updates run only in packaged Windows x64 builds outside Squirrel lifecycle events", () => {
  assert.equal(isPackagedWindows({ platform: "win32", packaged: true }), true);
  assert.equal(isPackagedWindows({ platform: "darwin", packaged: true }), false);
  assert.equal(isPackagedWindows({ platform: "win32", packaged: false }), false);
  assert.equal(isPackagedWindows({ platform: "win32", packaged: true, processArguments: ["--squirrel-updated"] }), false);
  assert.equal(controllerFixture({ platform: "darwin" }).controller, null);
  assert.equal(getWindowsUpdateEligibility({ platform: "win32", packaged: true, version: "0.1.7", architecture: "x64" }).channel, "stable");
  assert.equal(getWindowsUpdateEligibility({ platform: "win32", packaged: true, version: "0.1.7-beta.4", architecture: "x64" }).channel, "prerelease");
  assert.equal(getWindowsUpdateEligibility({ platform: "win32", packaged: true, version: "bad", architecture: "x64" }).eligible, false);
  assert.equal(getWindowsUpdateEligibility({ platform: "win32", packaged: true, version: "0.1.7", architecture: "arm64" }).eligible, false);
});

test("semantic versions are compared numerically and prereleases remain ordered", () => {
  assert.ok(parseSemanticVersion("0.10.0"));
  assert.equal(parseSemanticVersion("0.1.7-beta.01"), null);
  assert.equal(compareSemanticVersions("0.10.0", "0.9.0"), 1);
  assert.equal(compareSemanticVersions("0.1.7", "0.1.7-beta.9"), 1);
  assert.equal(compareSemanticVersions("0.1.7-beta.10", "0.1.7-beta.9"), 1);
});

test("release validation fixes the repository, channel, tag, URLs, installer, and checksum asset", () => {
  const beta = windowsRelease("0.1.7-beta.5");
  assert.equal(validateWindowsRelease(beta, { currentVersion: "0.1.7-beta.4" })?.version, "0.1.7-beta.5");
  assert.equal(validateWindowsRelease(windowsRelease("0.1.8", { prerelease: false }), { currentVersion: "0.1.7" })?.channel, "stable");
  assert.equal(validateWindowsRelease(beta, { currentVersion: "0.1.7" }), null);
  assert.equal(validateWindowsRelease({ ...beta, draft: true }, { currentVersion: "0.1.7-beta.4" }), null);
  assert.equal(validateWindowsRelease({ ...beta, html_url: "https://example.com/release" }, { currentVersion: "0.1.7-beta.4" }), null);
  assert.equal(validateWindowsRelease({ ...beta, assets: beta.assets.slice(1) }, { currentVersion: "0.1.7-beta.4" }), null);
  const unsafe = { ...beta, assets: beta.assets.map((asset) => asset.name === WINDOWS_INSTALLER_ASSET_NAME
    ? { ...asset, browser_download_url: "https://example.com/setup.exe" }
    : asset) };
  assert.equal(validateWindowsRelease(unsafe, { currentVersion: "0.1.7-beta.4" }), null);
  assert.deepEqual(selectEligibleWindowsReleases([
    windowsRelease("0.1.7-beta.5"), windowsRelease("0.1.8-beta.1"), windowsRelease("0.1.7-beta.6"),
  ], { currentVersion: "0.1.7-beta.4" }).map(({ version }) => version), ["0.1.8-beta.1", "0.1.7-beta.6", "0.1.7-beta.5"]);
});

test("release discovery reads only public metadata and validates the installer checksum", async () => {
  const fixture = releaseFixture();
  const candidate = await discoverEligibleWindowsRelease({
    currentVersion: "0.1.7-beta.4", fetchImplementation: fixture.source.fetchImplementation,
  });
  assert.equal(candidate.version, "0.1.7-beta.5");
  assert.equal(candidate.sha256, sha256(fixture.setupBytes));
  assert.equal(fixture.source.calls[0].url, WINDOWS_RELEASES_API_URL);
  assert.equal(fixture.source.calls[0].request.headers.Authorization, undefined);
  assert.deepEqual(fixture.source.calls.map(({ url }) => new URL(url).hostname), [
    "api.github.com", "github.com", WINDOWS_RELEASE_ASSET_REDIRECT_HOST,
  ]);

  const current = githubFetch([], new Map());
  assert.equal(await discoverEligibleWindowsRelease({
    currentVersion: "0.1.7-beta.4", fetchImplementation: current.fetchImplementation,
  }), null);
  await assert.rejects(() => discoverEligibleWindowsRelease({
    currentVersion: "0.1.7-beta.4", fetchImplementation: githubFetch([fixture.release], fixture.files, { redirectHost: "example.com" }).fetchImplementation,
  }), { code: "github_asset_redirect_invalid" });
  await assert.rejects(() => discoverEligibleWindowsRelease({
    currentVersion: "0.1.7-beta.4", fetchImplementation: githubFetch([fixture.release], fixture.files, {
      redirectHost: `${WINDOWS_RELEASE_ASSET_REDIRECT_HOST}:444`,
    }).fetchImplementation,
  }), { code: "github_asset_redirect_invalid" });
  await assert.rejects(() => discoverEligibleWindowsRelease({
    currentVersion: "0.1.7-beta.4", fetchImplementation: githubFetch([fixture.release], new Map([
      [WINDOWS_CHECKSUMS_ASSET_NAME, Buffer.from(`${"0".repeat(64)}  ${WINDOWS_INSTALLER_ASSET_NAME}\n`)],
    ])).fetchImplementation,
  }), { code: "release_checksum_invalid" });
  await assert.rejects(() => discoverEligibleWindowsRelease({
    currentVersion: "0.1.7-beta.4", fetchImplementation: githubFetch([], new Map(), { invalidJson: true }).fetchImplementation,
  }), { code: "github_releases_invalid" });
});

test("installer download writes one temporary executable and requires exact size and SHA-256", async () => {
  const fixture = releaseFixture();
  const candidate = await discoverEligibleWindowsRelease({
    currentVersion: "0.1.7-beta.4", fetchImplementation: fixture.source.fetchImplementation,
  });
  const directory = await mkdtemp(path.join(os.tmpdir(), "biodesign-installer-test-"));
  try {
    const progress = [];
    const installerPath = await downloadVerifiedWindowsInstaller({
      candidate, updateDirectory: directory, fetchImplementation: fixture.source.fetchImplementation,
      onProgress: (value) => progress.push(value), randomUUIDImplementation: () => "fixture-id",
    });
    assert.equal(path.basename(installerPath), "BioDesign-Setup-0.1.7-beta.5-fixture-id.exe");
    assert.deepEqual(await readFile(installerPath), fixture.setupBytes);
    assert.equal(progress.at(-1), 100);
    assert.deepEqual(await readdir(directory), [path.basename(installerPath)]);

    const mismatched = { ...candidate, sha256: "0".repeat(64) };
    await assert.rejects(() => downloadVerifiedWindowsInstaller({
      candidate: mismatched, updateDirectory: directory, fetchImplementation: fixture.source.fetchImplementation,
      randomUUIDImplementation: () => "bad-hash",
    }), { code: "installer_sha256_mismatch" });
    assert.ok(!(await readdir(directory)).some((name) => name.includes("bad-hash")));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("installer launch uses only the verified path and Squirrel's restart-capable default without a shell", async () => {
  let invocation;
  const child = new EventEmitter();
  child.unref = () => { child.unrefCalled = true; };
  const promise = launchSquirrelInstaller(path.resolve("verified.exe"), {
    spawnImplementation(executable, argumentsList, options) {
      invocation = { executable, argumentsList, options };
      queueMicrotask(() => child.emit("spawn"));
      return child;
    },
  });
  await promise;
  assert.deepEqual(invocation.argumentsList, WINDOWS_INSTALLER_ARGUMENTS);
  assert.equal(invocation.options.shell, false);
  assert.equal(invocation.options.detached, true);
  assert.equal(child.unrefCalled, true);
  await assert.rejects(() => launchSquirrelInstaller("relative.exe"), { code: "installer_launch_invalid" });
});

test("the button checks manually and Later never downloads or changes the installation", async () => {
  const fixture = releaseFixture();
  const state = controllerFixture({ fetchImplementation: fixture.source.fetchImplementation, dialogs: [{ response: 1 }] });
  const result = await state.controller.requestUpdateCheck();
  assert.deepEqual(result, { state: "cancelled", version: "0.1.7-beta.5" });
  assert.equal(state.calls.downloads, 0);
  assert.equal(state.calls.launches, 0);
  assert.equal(state.calls.quits, 0);
  assert.match(state.dialog.calls[0].detail, /Current: 0\.1\.7-beta\.4\nLatest: 0\.1\.7-beta\.5/);
  assert.deepEqual(state.dialog.calls[0].buttons, ["Download and Install", "Later"]);
});

test("approved updates download, prepare, launch separately, and then quit", async () => {
  const fixture = releaseFixture();
  const state = controllerFixture({ fetchImplementation: fixture.source.fetchImplementation, dialogs: [{ response: 0 }] });
  const result = await state.controller.requestUpdateCheck();
  assert.equal(result.state, "launching");
  assert.deepEqual(state.calls, { downloads: 1, launches: 1, prepares: 1, quits: 1 });
  assert.ok(state.statuses.some(({ state: phase }) => phase === "downloading"));
  assert.ok(state.statuses.some(({ state: phase }) => phase === "verifying"));
});

test("open projects, offline checks, duplicate clicks, and launch failures remain nonfatal", async () => {
  const fixture = releaseFixture();
  const blocked = controllerFixture({
    fetchImplementation: fixture.source.fetchImplementation,
    dialogs: [{ response: 0 }, { response: 0 }],
    getWorkState: () => ({ projectOpen: true, runningJobs: false }),
  });
  assert.equal((await blocked.controller.requestUpdateCheck()).state, "blocked");
  assert.equal(blocked.calls.downloads, 0);

  let workStateChecks = 0;
  const openedDuringDownload = controllerFixture({
    fetchImplementation: fixture.source.fetchImplementation,
    dialogs: [{ response: 0 }, { response: 0 }],
    getWorkState: () => ({ projectOpen: (workStateChecks += 1) > 1, runningJobs: false }),
  });
  assert.equal((await openedDuringDownload.controller.requestUpdateCheck()).state, "blocked");
  assert.equal(openedDuringDownload.calls.downloads, 1);
  assert.equal(openedDuringDownload.calls.prepares, 0);
  assert.equal(openedDuringDownload.calls.launches, 0);
  assert.equal(openedDuringDownload.calls.quits, 0);

  const offline = controllerFixture({ fetchImplementation: async () => { throw new Error("offline"); } });
  assert.equal((await offline.controller.requestUpdateCheck()).state, "temporarily-unavailable");
  assert.equal(offline.calls.quits, 0);

  let resolveApi;
  const pendingApi = new Promise((resolve) => { resolveApi = resolve; });
  const duplicate = controllerFixture({ fetchImplementation: () => pendingApi });
  const first = duplicate.controller.requestUpdateCheck();
  assert.equal((await duplicate.controller.requestUpdateCheck()).state, "checking");
  resolveApi(new Response("[]", { status: 200, headers: { "content-type": "application/json" } }));
  assert.equal((await first).state, "current");

  const failedLaunch = controllerFixture({
    fetchImplementation: fixture.source.fetchImplementation,
    dialogs: [{ response: 0 }],
    launchInstaller: async () => { const error = new Error("blocked"); error.code = "installer_launch_failed"; throw error; },
  });
  const failed = await failedLaunch.controller.requestUpdateCheck();
  assert.deepEqual(failed, { state: "temporarily-unavailable", reason: "launch_failed" });
  assert.equal(failedLaunch.calls.quits, 0);
});

test("Squirrel first run delays only manual checking and schedules no background update", async () => {
  const state = controllerFixture({ processArguments: ["BioDesign.exe", "--squirrel-firstrun"] });
  assert.equal(state.timeouts.length, 1);
  assert.equal(state.timeouts[0].delay, WINDOWS_UPDATE_FIRST_RUN_DELAY_MS);
  assert.equal(state.controller.getUpdateCapability().canCheck, false);
  assert.equal((await state.controller.requestUpdateCheck()).reason, "squirrel_first_run");
  state.timeouts[0].callback();
  assert.equal(state.controller.getUpdateCapability().canCheck, true);
});
