import { app, BrowserWindow, dialog, ipcMain, session, utilityProcess } from "electron";
import { appendFile, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { registerIpcHandlers } from "../ipc/register-handlers.mjs";
import { ProjectSessionManager } from "../services/project-session.mjs";

const moduleDirectory = path.dirname(fileURLToPath(import.meta.url));
const applicationRoot = path.resolve(moduleDirectory, "../..");
const smokeTest = process.argv.includes("--smoke-test");
const smokeResultArgument = process.argv.find((argument) => argument.startsWith("--smoke-result="));
const smokeQmdArgument = process.argv.find((argument) => argument.startsWith("--smoke-qmd-project="));
const smokeQmdCacheArgument = process.argv.find((argument) => argument.startsWith("--smoke-qmd-cache="));
let mainWindow = null;
let sessionManager = null;
let unregisterHandlers = null;
const smokeDiagnostics = [];

function redact(value) {
  return String(value)
    .replace(/(bearer|token|password|api[-_ ]?key)\s*[:=]\s*[^\s,;]+/gi, "$1=[redacted]")
    .slice(0, 2000);
}

async function log(event, details = "") {
  const logsDirectory = app.getPath("logs");
  await mkdir(logsDirectory, { recursive: true });
  await appendFile(path.join(logsDirectory, "desktop.log"), `${new Date().toISOString()} ${redact(event)} ${redact(details)}\n`, "utf8").catch(() => {});
}

function installSecurityPolicy() {
  session.defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
  session.defaultSession.setPermissionCheckHandler(() => false);
  session.defaultSession.webRequest.onBeforeRequest({ urls: ["<all_urls>"] }, (details, callback) => {
    let blocked = false;
    try {
      const hostname = new URL(details.url).hostname.toLowerCase();
      blocked = hostname === "requesty.ai" || hostname.endsWith(".requesty.ai");
    } catch {
      blocked = false;
    }
    if (blocked) void log("blocked_direct_requesty_request", details.url.replace(/[?#].*$/, ""));
    callback({ cancel: blocked });
  });
}

function createWindow() {
  const preloadPath = path.join(applicationRoot, "desktop", "preload", "index.cjs");
  mainWindow = new BrowserWindow({
    width: 1500,
    height: 980,
    minWidth: 1080,
    minHeight: 720,
    show: !smokeTest,
    backgroundColor: "#f5f7f5",
    title: "BioDesign Copilot",
    webPreferences: {
      preload: preloadPath,
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      devTools: !app.isPackaged,
    },
  });

  mainWindow.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  mainWindow.webContents.on("will-navigate", (event, targetUrl) => {
    if (targetUrl !== mainWindow.webContents.getURL()) event.preventDefault();
  });
  mainWindow.webContents.on("render-process-gone", (_event, details) => {
    void log("renderer_gone", JSON.stringify({ reason: details.reason, exitCode: details.exitCode }));
  });
  mainWindow.webContents.on("preload-error", (_event, preloadPath, error) => {
    console.error("preload_error", preloadPath, error?.message || error);
  });
  if (smokeTest) {
    mainWindow.webContents.on("console-message", (_event, details) => {
      console.error("renderer_console", details.level, details.message);
    });
  }
  void mainWindow.loadFile(path.join(applicationRoot, "docs", "index.html"));
  mainWindow.on("closed", () => { mainWindow = null; });
  return mainWindow;
}

async function runSmoke(window) {
  await new Promise((resolve, reject) => {
    window.webContents.once("did-finish-load", resolve);
    window.webContents.once("did-fail-load", (_event, code, description) => reject(new Error(`${code}: ${description}`)));
  });
  const renderer = await window.webContents.executeJavaScript(`({
    bridge: Boolean(window.biodesignDesktop),
    bridgeKeys: Object.keys(window.biodesignDesktop || {}),
    nodeRequireType: typeof window.require,
    processType: typeof window.process,
    title: document.title,
    loginVisible: !document.getElementById("loginPanel")?.hidden
  })`);
  const runtime = await window.webContents.executeJavaScript("window.biodesignDesktop.runtime.info()");
  const result = {
    rendererLoaded: renderer.bridge && renderer.title === "BioDesign Workbench",
    renderer,
    runtime,
    security: { nodeIntegration: false, contextIsolation: true, sandbox: true },
  };
  if (smokeQmdArgument) {
    const projectRoot = smokeQmdArgument.slice("--smoke-qmd-project=".length);
    const opened = await sessionManager.open(projectRoot);
    const workspace = JSON.parse(await sessionManager.active.filesystem.readText(".biodesign/workspace.json"));
    const status = await sessionManager.initializeKnowledge(workspace.workspaceId);
    await sessionManager.knowledge("update", { collections: ["literature-evidence"] });
    const qmdMode = "fast";
    const search = await sessionManager.knowledge("search", {
      query: "desktop qmd smoke marker",
      collections: ["literature-evidence"],
      mode: qmdMode,
      limit: 5,
      candidateLimit: 10,
      intent: "retrieve the desktop QMD smoke marker",
    });
    result.qmd = {
      projectId: opened.projectId,
      available: status.available === true,
      qmdPackageVersion: status.qmdPackageVersion,
      nodeVersion: status.nodeVersion,
      mode: qmdMode,
      resultCount: search.results?.length || 0,
      matchedSmokeMarker: JSON.stringify(search.results || []).includes("smoke-marker"),
      nativeDiagnostics: smokeDiagnostics,
    };
    await sessionManager.close();
  }
  if (smokeResultArgument) {
    const resultPath = smokeResultArgument.slice("--smoke-result=".length);
    await writeFile(resultPath, `${JSON.stringify(result, null, 2)}\n`, "utf8");
  } else {
    console.log(JSON.stringify(result, null, 2));
  }
  const qmdPassed = !smokeQmdArgument || (result.qmd?.available && result.qmd?.matchedSmokeMarker);
  app.exit(result.rendererLoaded && renderer.nodeRequireType === "undefined" && qmdPassed ? 0 : 1);
}

app.on("web-contents-created", (_event, contents) => {
  contents.on("will-attach-webview", (event) => event.preventDefault());
});

app.whenReady().then(async () => {
  app.setAppLogsPath();
  installSecurityPolicy();
  sessionManager = new ProjectSessionManager({
    utilityProcess,
    appPath: applicationRoot,
    qmdCacheRoot: smokeQmdCacheArgument
      ? smokeQmdCacheArgument.slice("--smoke-qmd-cache=".length)
      : path.join(app.getPath("userData"), "cache"),
  });
  sessionManager.on("knowledge-diagnostic", (message) => {
    void log("qmd_worker_diagnostic", message);
    if (smokeTest) {
      smokeDiagnostics.push(redact(message));
      console.error("qmd_worker_diagnostic", redact(message));
    }
  });
  unregisterHandlers = registerIpcHandlers({
    ipcMain,
    dialog,
    sessionManager,
    getWindow: () => mainWindow,
    runtimeInfo: () => ({
      appVersion: app.getVersion(),
      electronVersion: process.versions.electron,
      nodeVersion: process.versions.node,
      chromeVersion: process.versions.chrome,
      packaged: app.isPackaged,
      platform: process.platform,
      architecture: process.arch,
    }),
  });
  const window = createWindow();
  if (smokeTest) {
    try {
      await runSmoke(window);
    } catch (error) {
      console.error("desktop_smoke_failed", error?.stack || error);
      app.exit(1);
    }
  }
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0 && !smokeTest) createWindow();
});

app.on("before-quit", (event) => {
  if (!sessionManager?.active) return;
  event.preventDefault();
  const manager = sessionManager;
  sessionManager = null;
  manager.close().finally(() => app.quit());
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin" || smokeTest) app.quit();
});

app.on("quit", () => unregisterHandlers?.());
