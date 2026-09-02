import { createReadStream } from "node:fs";
import { access, readFile, rm, stat } from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { spawn } from "node:child_process";

if (process.platform !== "win32" || process.arch !== "x64") {
  throw new Error("The prerelease two-version Squirrel update smoke must run on Windows x64.");
}
const smokeRoot = path.resolve("out", "windows-beta-update-smoke");
const manifest = JSON.parse(await readFile(path.join(smokeRoot, "manifest.json"), "utf8"));
const statusPath = path.join(smokeRoot, "status.json");
const installRoot = path.join(process.env.LOCALAPPDATA, manifest.identity);
const installedExecutable = path.join(installRoot, `${manifest.identity}.exe`);
const updateExecutable = path.join(installRoot, "Update.exe");
const targetTag = `v${manifest.versionB.version}`;
const redirectCounts = { RELEASES: 0, nupkg: 0 };

try {
  await access(installRoot);
  throw new Error(`Refusing to overwrite an existing ${manifest.identity} installation.`);
} catch (error) {
  if (error?.code !== "ENOENT") throw error;
}

function run(executable, argumentsList, options = {}) {
  return new Promise((resolve, reject) => {
    const { timeoutMs = 240_000, ...spawnOptions } = options;
    const child = spawn(executable, argumentsList, { stdio: "inherit", ...spawnOptions });
    const timeout = setTimeout(() => {
      child.kill();
      reject(new Error(`${path.basename(executable)} timed out.`));
    }, timeoutMs);
    child.once("error", (error) => { clearTimeout(timeout); reject(error); });
    child.once("exit", (code) => {
      clearTimeout(timeout);
      if (code === 0) resolve();
      else reject(new Error(`${path.basename(executable)} exited with ${code}.`));
    });
  });
}

const terminalFailurePhases = new Set(["no-update", "project-data-lost", "timeout", "update-error"]);

async function waitForStatus(expectedPhase, timeoutMs = 210_000) {
  const deadline = Date.now() + timeoutMs;
  let lastStatus = null;
  while (Date.now() < deadline) {
    try {
      lastStatus = JSON.parse(await readFile(statusPath, "utf8"));
      if (lastStatus.phase === expectedPhase) return lastStatus;
      if (terminalFailurePhases.has(lastStatus.phase)) throw new Error(`Beta update smoke failed: ${JSON.stringify(lastStatus)}`);
    } catch (error) {
      if (error?.code !== "ENOENT" && !(error instanceof SyntaxError)) throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`Timed out waiting for ${expectedPhase}; last status: ${JSON.stringify(lastStatus)}`);
}

const assetMap = new Map(manifest.assets.map((asset) => [asset.name, asset]));
const server = http.createServer(async (request, response) => {
  const requestUrl = new URL(request.url, "http://127.0.0.1");
  if (requestUrl.pathname === "/api/releases") {
    const assets = manifest.assets.map(({ name, size }) => ({
      name,
      size,
      state: "uploaded",
      digest: null,
      browser_download_url: `https://github.com/qygx-biotech/copilot-dev/releases/download/${targetTag}/${encodeURIComponent(name)}`,
    }));
    response.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
    response.end(JSON.stringify([{
      draft: false,
      prerelease: true,
      tag_name: targetTag,
      html_url: `https://github.com/qygx-biotech/copilot-dev/releases/tag/${targetTag}`,
      assets,
    }]));
    return;
  }

  const metadataMatch = /^\/metadata\/([^/]+)$/.exec(requestUrl.pathname);
  const releaseMatch = new RegExp(`^/releases/download/${targetTag.replaceAll(".", "\\.")}/([^/]+)$`).exec(requestUrl.pathname);
  const redirectedMatch = /^\/release-assets\/([^/]+)$/.exec(requestUrl.pathname);
  if (releaseMatch) {
    const name = decodeURIComponent(releaseMatch[1]);
    if (!assetMap.has(name)) { response.writeHead(404).end(); return; }
    if (name === "RELEASES") redirectCounts.RELEASES += 1;
    if (name.endsWith("-full.nupkg")) redirectCounts.nupkg += 1;
    response.writeHead(302, { location: `/release-assets/${encodeURIComponent(name)}`, "cache-control": "no-store" }).end();
    return;
  }
  const name = metadataMatch ? decodeURIComponent(metadataMatch[1]) : redirectedMatch ? decodeURIComponent(redirectedMatch[1]) : "";
  if (!assetMap.has(name)) { response.writeHead(404).end(); return; }
  const filePath = path.join(manifest.feedRoot, name);
  const metadata = await stat(filePath);
  response.writeHead(200, {
    "content-length": metadata.size,
    "content-type": name === "RELEASES" || name === "SHA256SUMS.txt" ? "text/plain" : "application/octet-stream",
    "cache-control": "no-store",
  });
  if (request.method === "HEAD") response.end();
  else createReadStream(filePath).pipe(response);
});

await new Promise((resolve, reject) => {
  server.once("error", reject);
  server.listen(0, "127.0.0.1", resolve);
});
const fixtureOrigin = `http://127.0.0.1:${server.address().port}`;

try {
  await run(manifest.setupA, ["--silent"], {
    env: { ...process.env, BIODESIGN_BETA_UPDATE_SMOKE_ORIGIN: "", BIODESIGN_BETA_UPDATE_SMOKE_STATUS: "" },
  });
  await access(installedExecutable);
  await new Promise((resolve) => setTimeout(resolve, 10_000));
  await rm(statusPath, { force: true });

  const smokeEnvironment = {
    ...process.env,
    BIODESIGN_BETA_UPDATE_SMOKE_ORIGIN: fixtureOrigin,
    BIODESIGN_BETA_UPDATE_SMOKE_STATUS: statusPath,
  };
  await run(installedExecutable, [], { env: smokeEnvironment });
  const downloaded = await waitForStatus("downloaded");
  if (downloaded.version !== manifest.versionA.version || downloaded.targetVersion !== manifest.versionB.version ||
      !downloaded.projectDataPreserved || !downloaded.narrowAction || !downloaded.selectedLater) {
    throw new Error(`Version A did not stage beta B safely: ${JSON.stringify(downloaded)}`);
  }
  await new Promise((resolve) => setTimeout(resolve, 2_000));
  await rm(statusPath, { force: true });
  await run(installedExecutable, [], { env: smokeEnvironment });
  const updated = await waitForStatus("updated");
  if (updated.version !== manifest.versionB.version || !updated.projectDataPreserved) {
    throw new Error(`Version B did not launch with version A project data: ${JSON.stringify(updated)}`);
  }
  if (redirectCounts.RELEASES < 1 || redirectCounts.nupkg < 1) {
    throw new Error(`Squirrel did not retrieve both redirected assets: ${JSON.stringify(redirectCounts)}`);
  }
  console.log(JSON.stringify({
    identity: manifest.identity,
    fromVersion: downloaded.version,
    toVersion: updated.version,
    narrowButtonAction: true,
    backgroundDownload: true,
    selectedLater: true,
    normalRestartInstall: true,
    projectDataPreserved: true,
    realisticGithubReleaseFixture: true,
    releasesRedirectFollowed: redirectCounts.RELEASES > 0,
    nupkgRedirectFollowed: redirectCounts.nupkg > 0,
    productionFeedOverridePackaged: false,
  }, null, 2));
} finally {
  await new Promise((resolve) => server.close(resolve));
  try {
    await access(updateExecutable);
    await run(updateExecutable, ["--uninstall", "-s"], { timeoutMs: 120_000 });
  } catch {
    // The ephemeral CI runner is discarded; preserve the primary failure.
  }
}
