import { createReadStream } from "node:fs";
import { access, readFile, rm, stat } from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { spawn } from "node:child_process";

if (process.platform !== "win32" || process.arch !== "x64") {
  throw new Error("The two-version Squirrel update smoke must run on Windows x64.");
}

const smokeRoot = path.resolve("out", "windows-update-smoke");
const manifest = JSON.parse(await readFile(path.join(smokeRoot, "manifest.json"), "utf8"));
const statusPath = path.join(smokeRoot, "status.json");
const installRoot = path.join(process.env.LOCALAPPDATA, manifest.identity);
const installedExecutable = path.join(installRoot, `${manifest.identity}.exe`);
const updateExecutable = path.join(installRoot, "Update.exe");

try {
  await access(installRoot);
  throw new Error(`Refusing to overwrite an existing ${manifest.identity} fixture installation.`);
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
    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once("exit", (code) => {
      clearTimeout(timeout);
      if (code === 0) resolve();
      else reject(new Error(`${path.basename(executable)} exited with ${code}.`));
    });
  });
}

const terminalFailurePhases = new Set([
  "no-update",
  "project-data-lost",
  "timeout",
  "update-error",
]);

async function waitForStatus(expectedPhase, timeoutMs = 210_000) {
  const deadline = Date.now() + timeoutMs;
  let lastStatus = null;
  while (Date.now() < deadline) {
    try {
      lastStatus = JSON.parse(await readFile(statusPath, "utf8"));
      if (lastStatus.phase === expectedPhase) return lastStatus;
      if (terminalFailurePhases.has(lastStatus.phase)) {
        throw new Error(`Update smoke reached failure phase ${lastStatus.phase}: ${JSON.stringify(lastStatus)}`);
      }
    } catch (error) {
      if (error?.code !== "ENOENT" && !(error instanceof SyntaxError)) throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`Timed out waiting for update smoke phase ${expectedPhase}; last status: ${JSON.stringify(lastStatus)}`);
}

const allowedAssets = new Set(["RELEASES", `${manifest.identity}-0.0.2-full.nupkg`]);
const server = http.createServer(async (request, response) => {
  const name = decodeURIComponent(new URL(request.url, "http://127.0.0.1").pathname).replace(/^\/+/, "");
  if (!allowedAssets.has(name)) {
    response.writeHead(404).end();
    return;
  }
  const filePath = path.join(manifest.feedRoot, name);
  const metadata = await stat(filePath);
  response.writeHead(200, {
    "content-length": metadata.size,
    "content-type": name === "RELEASES" ? "text/plain" : "application/octet-stream",
    "cache-control": "no-store",
  });
  if (request.method === "HEAD") response.end();
  else createReadStream(filePath).pipe(response);
});

await new Promise((resolve, reject) => {
  server.once("error", reject);
  server.listen(0, "127.0.0.1", resolve);
});
const feedUrl = `http://127.0.0.1:${server.address().port}`;

try {
  await run(manifest.setupA, ["--silent"], {
    env: { ...process.env, BIODESIGN_UPDATE_SMOKE_FEED: "", BIODESIGN_UPDATE_SMOKE_STATUS: "" },
  });
  await access(installedExecutable);
  await new Promise((resolve) => setTimeout(resolve, 10_000));
  await rm(statusPath, { force: true });

  const smokeEnvironment = {
    ...process.env,
    BIODESIGN_UPDATE_SMOKE_FEED: feedUrl,
    BIODESIGN_UPDATE_SMOKE_STATUS: statusPath,
  };
  await run(installedExecutable, [], { env: smokeEnvironment });
  const downloaded = await waitForStatus("downloaded");
  if (downloaded.phase !== "downloaded" || downloaded.version !== "0.0.1" || !downloaded.projectDataPreserved) {
    throw new Error(`Version A did not download version B safely: ${JSON.stringify(downloaded)}`);
  }

  // The installed root launcher can return before the versioned Electron child.
  // Version A writes "downloaded" just before its deliberate normal quit.
  await new Promise((resolve) => setTimeout(resolve, 2_000));
  await rm(statusPath, { force: true });
  await run(installedExecutable, [], { env: smokeEnvironment });
  const updated = await waitForStatus("updated");
  if (updated.phase !== "updated" || updated.version !== "0.0.2" || !updated.projectDataPreserved) {
    throw new Error(`Version B did not launch with version A project data: ${JSON.stringify(updated)}`);
  }
  console.log(JSON.stringify({
    identity: manifest.identity,
    fromVersion: downloaded.version,
    toVersion: updated.version,
    backgroundDownload: true,
    normalRestartInstall: true,
    projectDataPreserved: true,
    isolatedLoopbackFeed: true,
  }, null, 2));
} finally {
  await new Promise((resolve) => server.close(resolve));
  try {
    await access(updateExecutable);
    await run(updateExecutable, ["--uninstall", "-s"], { timeoutMs: 120_000 });
  } catch {
    // The ephemeral CI runner will be discarded; preserve the primary failure.
  }
}
