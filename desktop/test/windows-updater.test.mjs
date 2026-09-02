import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { test } from "node:test";
import {
  compareSemanticVersions,
  discoverEligibleBetaRelease,
  getBetaUpdateEligibility,
  isPackagedWindows,
  isStrictlyNewerPrereleaseVersion,
  isStrictlyNewerStableVersion,
  parsePrereleaseVersion,
  parseStableVersion,
  selectEligibleBetaReleases,
  startWindowsAutoUpdates,
  validateBetaRelease,
  WINDOWS_BETA_ASSET_REDIRECT_HOST,
  WINDOWS_BETA_RELEASES_API_URL,
  WINDOWS_BETA_RELEASES_DOWNLOAD_BASE,
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
  autoUpdater.feedCalls = [];
  autoUpdater.checkForUpdates = () => { autoUpdater.checkCount += 1; };
  autoUpdater.quitAndInstall = () => { autoUpdater.quitCount += 1; };
  autoUpdater.setFeedURL = (configuration) => { autoUpdater.feedCalls.push(configuration); };
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
  const betaStatuses = [];
  const app = {
    isPackaged: options.packaged ?? true,
    getVersion: () => options.version || "0.1.5",
  };
  const controller = startWindowsAutoUpdates({
    app,
    autoUpdater,
    dialog,
    platform: options.platform || "win32",
    architecture: options.architecture || "x64",
    processArguments: options.processArguments || [],
    squirrelLifecycleEvent: options.squirrelLifecycleEvent,
    fetchImplementation: options.fetchImplementation,
    getWorkState: options.getWorkState,
    prepareForUpdate: options.prepareForUpdate,
    onBetaStatus: (status) => betaStatuses.push(status),
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
    betaStatuses,
    controller,
    dialog,
    events,
    intervals,
    timeouts,
    updateCalls,
    libraryStopped: () => libraryStopped,
  };
}

function releaseAsset(tag, name, size) {
  return {
    name,
    size,
    state: "uploaded",
    digest: null,
    browser_download_url: `${WINDOWS_BETA_RELEASES_DOWNLOAD_BASE}/${tag}/${encodeURIComponent(name)}`,
  };
}

function betaRelease(version, overrides = {}) {
  const tag = `v${version}`;
  const sizes = {
    "BioDesign-Setup.exe": 120,
    RELEASES: 140,
    [`BioDesign-${version}-full.nupkg`]: 1234,
    "SHA256SUMS.txt": 400,
    [`BioDesign-win32-x64-${version}.zip`]: 1500,
  };
  return {
    draft: false,
    prerelease: true,
    tag_name: tag,
    html_url: `https://github.com/${WINDOWS_UPDATE_REPOSITORY}/releases/tag/${tag}`,
    assets: Object.entries(sizes).map(([name, size]) => releaseAsset(tag, name, size)),
    ...overrides,
  };
}

function metadataForRelease(release) {
  const candidate = validateBetaRelease(release, { currentVersion: "0.1.6-beta.1" });
  assert.ok(candidate);
  const hashes = {
    [candidate.assets.setup.name]: "1".repeat(64),
    [candidate.assets.releases.name]: "2".repeat(64),
    [candidate.assets.fullPackage.name]: "3".repeat(64),
    [candidate.assets.architectureMarker.name]: "4".repeat(64),
  };
  return {
    releases: `${"a".repeat(40)} ${candidate.assets.fullPackage.name} ${candidate.assets.fullPackage.size}\n`,
    checksums: Object.entries(hashes).map(([name, hash]) => `${hash}  ${name}`).join("\n") + "\n",
  };
}

function betaFetch(releases, options = {}) {
  const metadata = options.metadata || metadataForRelease(releases[0]);
  const calls = [];
  const fetchImplementation = async (url, request) => {
    calls.push({ url, request });
    if (options.failure) throw new Error("offline");
    if (url === WINDOWS_BETA_RELEASES_API_URL) {
      return new Response(JSON.stringify(releases), {
        status: options.apiStatus || 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (url.startsWith(WINDOWS_BETA_RELEASES_DOWNLOAD_BASE)) {
      const name = decodeURIComponent(new URL(url).pathname.split("/").pop());
      const redirectHost = options.redirectHost || WINDOWS_BETA_ASSET_REDIRECT_HOST;
      return new Response(null, {
        status: 302,
        headers: { location: `https://${redirectHost}/fixture/${encodeURIComponent(name)}?signed=test-only` },
      });
    }
    if (new URL(url).hostname === WINDOWS_BETA_ASSET_REDIRECT_HOST) {
      const name = decodeURIComponent(new URL(url).pathname.split("/").pop());
      const body = name === "RELEASES" ? metadata.releases : metadata.checksums;
      return new Response(body, { status: 200, headers: { "content-type": "application/octet-stream" } });
    }
    throw new Error("unexpected_url");
  };
  return { calls, fetchImplementation };
}

test("update logic runs only in packaged Windows builds and never during Squirrel lifecycle events", () => {
  assert.equal(isPackagedWindows({ platform: "win32", packaged: true }), true);
  assert.equal(isPackagedWindows({ platform: "darwin", packaged: true }), false);
  assert.equal(isPackagedWindows({ platform: "win32", packaged: false }), false);
  assert.equal(isPackagedWindows({ platform: "win32", packaged: true, processArguments: ["--squirrel-install"] }), false);
  assert.equal(fixture({ platform: "darwin" }).controller, null);
  assert.equal(fixture({ packaged: false }).controller, null);
  assert.equal(fixture({ processArguments: ["--squirrel-updated"] }).controller, null);
});

test("the public stable source remains fixed, HTTPS-only, and scheduled after safe startup", () => {
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

test("Squirrel first-run lock delays stable and beta activity", async () => {
  const stable = fixture({ processArguments: ["BioDesign.exe", "--squirrel-firstrun"] });
  assert.equal(stable.timeouts[0].delay, WINDOWS_UPDATE_FIRST_RUN_DELAY_MS);

  const beta = fixture({ version: "0.1.6-beta.1", processArguments: ["BioDesign.exe", "--squirrel-firstrun"] });
  assert.equal(beta.controller.getBetaUpdateCapability().canCheck, false);
  assert.equal((await beta.controller.requestBetaUpdateCheck()).reason, "squirrel_first_run");
  assert.equal(beta.autoUpdater.checkCount, 0);
  beta.timeouts[0].callback();
  assert.equal(beta.controller.getBetaUpdateCapability().canCheck, true);
});

test("beta eligibility is limited to packaged Windows x64 semantic prereleases", () => {
  const eligible = getBetaUpdateEligibility({
    platform: "win32", packaged: true, version: "0.1.6-beta.1", architecture: "x64",
  });
  assert.equal(eligible.eligible, true);
  for (const input of [
    { platform: "darwin", packaged: true, version: "0.1.6-beta.1", architecture: "x64" },
    { platform: "win32", packaged: false, version: "0.1.6-beta.1", architecture: "x64" },
    { platform: "win32", packaged: true, version: "0.1.6", architecture: "x64" },
    { platform: "win32", packaged: true, version: "0.1.6-beta.01", architecture: "x64" },
    { platform: "win32", packaged: true, version: "0.1.6-beta.1", architecture: "arm64" },
  ]) assert.equal(getBetaUpdateEligibility(input).eligible, false, JSON.stringify(input));
});

test("strict semantic ordering handles prerelease progression without stable opt-in", () => {
  assert.ok(parsePrereleaseVersion("0.1.6-beta.1"));
  assert.equal(parsePrereleaseVersion("0.1.6-beta.01"), null);
  assert.equal(parsePrereleaseVersion("v0.1.6-beta.1"), null);
  assert.equal(compareSemanticVersions("0.1.6-beta.2", "0.1.6-beta.1"), 1);
  assert.equal(compareSemanticVersions("0.1.7-beta.1", "0.1.6-beta.2"), 1);
  assert.equal(compareSemanticVersions("0.1.6", "0.1.6-beta.1"), 1);
  assert.equal(isStrictlyNewerPrereleaseVersion("0.1.6-beta.2", "0.1.6-beta.1"), true);
  assert.equal(isStrictlyNewerPrereleaseVersion("0.1.6-beta.1", "0.1.6-beta.1"), false);
  assert.equal(isStrictlyNewerPrereleaseVersion("0.1.6-beta.1", "0.1.6-beta.2"), false);
  assert.equal(isStrictlyNewerPrereleaseVersion("0.1.6-beta.1", "0.1.6"), false);
});

test("only exact public prereleases with matching Squirrel assets and repository URLs are eligible", () => {
  const valid = betaRelease("0.1.6-beta.2");
  assert.equal(validateBetaRelease(valid, { currentVersion: "0.1.6-beta.1" })?.version, "0.1.6-beta.2");
  const invalid = [
    { ...valid, draft: true },
    { ...valid, prerelease: false },
    { ...valid, tag_name: "v0.1.6" },
    { ...valid, tag_name: "v0.1.6-beta.02" },
    { ...valid, tag_name: "v0.1.6-beta.2/unsafe" },
    { ...valid, html_url: "https://github.com/other/repository/releases/tag/v0.1.6-beta.2" },
    { ...valid, assets: valid.assets.slice(1) },
    { ...valid, assets: [...valid.assets, releaseAsset(valid.tag_name, "unexpected.exe", 10)] },
    { ...valid, assets: valid.assets.map((asset) => asset.name.endsWith("-full.nupkg") ? { ...asset, name: "Other-0.1.6-beta.2-full.nupkg" } : asset) },
    { ...valid, assets: valid.assets.map((asset) => asset.name === "RELEASES" ? { ...asset, browser_download_url: "https://example.com/RELEASES" } : asset) },
  ];
  for (const release of invalid) assert.equal(validateBetaRelease(release, { currentVersion: "0.1.6-beta.1" }), null);
  assert.equal(validateBetaRelease(valid, { currentVersion: "0.1.6-beta.2" }), null);
  assert.equal(validateBetaRelease(valid, { currentVersion: "0.1.7-beta.1" }), null);
  assert.equal(validateBetaRelease(valid, { currentVersion: "0.1.6-beta.1", architecture: "arm64" }), null);
});

test("the highest fully eligible prerelease is selected deterministically", () => {
  const releases = [
    betaRelease("0.1.6-beta.3"),
    betaRelease("0.1.7-beta.1"),
    betaRelease("0.1.6-beta.2"),
  ];
  assert.deepEqual(
    selectEligibleBetaReleases(releases, { currentVersion: "0.1.6-beta.1" }).map(({ version }) => version),
    ["0.1.7-beta.1", "0.1.6-beta.3", "0.1.6-beta.2"]
  );
});

test("GitHub discovery preflights RELEASES and checksums through allowlisted HTTPS redirects", async () => {
  const release = betaRelease("0.1.6-beta.2");
  const source = betaFetch([release]);
  const candidate = await discoverEligibleBetaRelease({
    currentVersion: "0.1.6-beta.1",
    fetchImplementation: source.fetchImplementation,
  });
  assert.equal(candidate.version, "0.1.6-beta.2");
  assert.equal(candidate.feedUrl, `${WINDOWS_BETA_RELEASES_DOWNLOAD_BASE}/v0.1.6-beta.2`);
  assert.equal(source.calls[0].url, WINDOWS_BETA_RELEASES_API_URL);
  assert.equal(source.calls[0].request.headers.Authorization, undefined);
  assert.ok(source.calls.every(({ url }) => new URL(url).protocol === "https:"));

  const unsafe = betaFetch([release], { redirectHost: "example.com" });
  await assert.rejects(() => discoverEligibleBetaRelease({
    currentVersion: "0.1.6-beta.1",
    fetchImplementation: unsafe.fetchImplementation,
  }));

  const malformed = betaFetch([release], { metadata: { releases: "malformed\n", checksums: "malformed\n" } });
  assert.equal(await discoverEligibleBetaRelease({
    currentVersion: "0.1.6-beta.1",
    fetchImplementation: malformed.fetchImplementation,
  }), null);
});

test("a beta button request configures only the validated fixed feed and starts one background download", async () => {
  const release = betaRelease("0.1.6-beta.2");
  const source = betaFetch([release]);
  const state = fixture({ version: "0.1.6-beta.1", fetchImplementation: source.fetchImplementation });
  assert.equal(state.timeouts.length, 0);
  assert.equal(state.updateCalls.length, 0, "prerelease builds must not start the stable updater");
  const result = await state.controller.requestBetaUpdateCheck();
  assert.equal(result.state, "checking");
  assert.deepEqual(state.autoUpdater.feedCalls, [{ url: `${WINDOWS_BETA_RELEASES_DOWNLOAD_BASE}/v0.1.6-beta.2` }]);
  assert.equal(state.autoUpdater.checkCount, 1);
  state.autoUpdater.emit("update-available");
  assert.equal(state.betaStatuses.at(-1).state, "downloading");
});

test("stable builds cannot select a beta feed or overlap the stable updater", async () => {
  const state = fixture({ version: "0.1.6" });
  state.timeouts[0].callback();
  const result = await state.controller.requestBetaUpdateCheck();
  assert.deepEqual(result, { state: "unsupported", reason: "stable_build" });
  assert.equal(state.autoUpdater.feedCalls.length, 0);
  assert.equal(state.activeChannel, undefined);
});

test("offline GitHub failures are nonfatal and repeated button presses cannot duplicate discovery or downloads", async () => {
  const offline = fixture({
    version: "0.1.6-beta.1",
    fetchImplementation: async () => { throw new Error("offline"); },
  });
  assert.deepEqual(await offline.controller.requestBetaUpdateCheck(), { state: "temporarily-unavailable" });
  assert.equal(offline.autoUpdater.checkCount, 0);

  let resolveFetch;
  let apiCalls = 0;
  const pending = new Promise((resolve) => { resolveFetch = resolve; });
  const concurrent = fixture({
    version: "0.1.6-beta.1",
    fetchImplementation: async () => {
      apiCalls += 1;
      return pending;
    },
  });
  const first = concurrent.controller.requestBetaUpdateCheck();
  const second = concurrent.controller.requestBetaUpdateCheck();
  assert.equal((await second).state, "checking");
  assert.equal(apiCalls, 1);
  resolveFetch(new Response("[]", { status: 200, headers: { "content-type": "application/json" } }));
  assert.equal((await first).state, "no-eligible-beta");
  assert.equal(concurrent.autoUpdater.checkCount, 0);
});

test("offline stable initialization and updater failures remain nonfatal", () => {
  const state = fixture({ updateElectronApp: () => { throw new Error("offline"); } });
  assert.doesNotThrow(() => state.timeouts[0].callback());
  assert.ok(state.events.includes("windows_updater_initialization_failed"));
  assert.doesNotThrow(() => state.autoUpdater.emit("error", new Error("offline")));
  assert.ok(state.events.includes("windows_updater_error"));
});

test("concurrent stable checks and duplicate stable downloads are prevented", async () => {
  const state = fixture();
  state.timeouts[0].callback();
  state.autoUpdater.emit("update-not-available");
  state.intervals[0].callback();
  assert.equal(state.autoUpdater.checkCount, 1);
  state.intervals[0].callback();
  assert.equal(state.autoUpdater.checkCount, 1);
  state.autoUpdater.emit("update-available");
  state.autoUpdater.emit("update-downloaded", {}, "", "0.1.6");
  state.autoUpdater.emit("update-downloaded", {}, "", "0.1.6");
  await nextTurn();
  assert.equal(state.dialog.calls.length, 1);
});

test("Later never closes the app and leaves stable and beta updates staged", async () => {
  const stable = fixture({ dialogs: [{ response: 1 }] });
  stable.timeouts[0].callback();
  stable.autoUpdater.emit("update-available");
  stable.autoUpdater.emit("update-downloaded", {}, "", "0.1.6");
  await nextTurn();
  assert.equal(stable.autoUpdater.quitCount, 0);
  assert.ok(stable.events.includes("windows_updater_restart_deferred"));

  const release = betaRelease("0.1.6-beta.2");
  const source = betaFetch([release]);
  const beta = fixture({ version: "0.1.6-beta.1", dialogs: [{ response: 1 }], fetchImplementation: source.fetchImplementation });
  await beta.controller.requestBetaUpdateCheck();
  beta.autoUpdater.emit("update-available");
  beta.autoUpdater.emit("update-downloaded", {}, "", "0.1.6-beta.2");
  await nextTurn();
  assert.equal(beta.autoUpdater.quitCount, 0);
  assert.equal(beta.betaStatuses.at(-1).state, "ready-to-restart");
  assert.ok(beta.events.includes("windows_updater_restart_deferred"));
});

test("a downloaded beta never interrupts a running job or open project", async () => {
  const release = betaRelease("0.1.6-beta.2");
  const source = betaFetch([release]);
  const state = fixture({
    version: "0.1.6-beta.1",
    dialogs: [{ response: 0 }, { response: 0 }],
    fetchImplementation: source.fetchImplementation,
    getWorkState: () => ({ projectOpen: true, runningJobs: true }),
  });
  await state.controller.requestBetaUpdateCheck();
  state.autoUpdater.emit("update-available");
  state.autoUpdater.emit("update-downloaded", {}, "", "0.1.6-beta.2");
  await nextTurn();
  await nextTurn();
  assert.equal(state.autoUpdater.quitCount, 0);
  assert.equal(state.dialog.calls.length, 2);
  assert.ok(state.events.includes("windows_updater_restart_blocked_by_job"));
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

test("stable downgrades, duplicate versions, invalid versions, and prereleases remain rejected", async () => {
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
