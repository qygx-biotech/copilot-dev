import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ProjectQmdManager } from "./project-qmd-manager.js";

const MODULE_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
const DOCS_ROOT = path.resolve(MODULE_DIRECTORY, "../../docs");
const MAX_BODY_BYTES = 1024 * 1024;

function parseArguments(argv) {
  const args = { projectRoot: process.env.BIODESIGN_PROJECT_ROOT || "", port: 43127 };
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === "--project") args.projectRoot = argv[index + 1] || "";
    if (argv[index] === "--port") args.port = Number(argv[index + 1]) || args.port;
  }
  return args;
}

function sendJson(response, statusCode, body) {
  response.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  response.end(`${JSON.stringify(body)}\n`);
}

async function readJsonBody(request) {
  const chunks = [];
  let total = 0;
  for await (const chunk of request) {
    total += chunk.length;
    if (total > MAX_BODY_BYTES) {
      const error = new Error("Request body is too large.");
      error.code = "REQUEST_TOO_LARGE";
      throw error;
    }
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function contentType(filePath) {
  return {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".svg": "image/svg+xml",
    ".png": "image/png",
  }[path.extname(filePath).toLowerCase()] || "application/octet-stream";
}

async function serveStatic(request, response) {
  const url = new URL(request.url, "http://127.0.0.1");
  const decoded = decodeURIComponent(url.pathname);
  const requested = decoded === "/" ? "/index.html" : decoded;
  const filePath = path.resolve(DOCS_ROOT, `.${requested}`);
  const relative = path.relative(DOCS_ROOT, filePath);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    sendJson(response, 403, { ok: false, error: "PATH_NOT_ALLOWED" });
    return;
  }
  try {
    const info = await stat(filePath);
    if (!info.isFile()) throw new Error("Not a file");
    response.writeHead(200, {
      "Content-Type": contentType(filePath),
      "Cache-Control": "no-cache",
    });
    createReadStream(filePath).pipe(response);
  } catch {
    sendJson(response, 404, { ok: false, error: "NOT_FOUND" });
  }
}

export function createBiodesignServer(options) {
  const manager = options.manager || new ProjectQmdManager({
    projectRoot: options.projectRoot,
    embedModel: options.embedModel || process.env.BIODESIGN_QMD_EMBED_MODEL,
  });
  const server = http.createServer(async (request, response) => {
    try {
      const url = new URL(request.url, "http://127.0.0.1");
      if (!url.pathname.startsWith("/api/knowledge/")) {
        await serveStatic(request, response);
        return;
      }
      const body = request.method === "POST" ? await readJsonBody(request) : {};
      const workspaceId =
        request.headers["x-biodesign-workspace-id"] ||
        body.workspaceId ||
        url.searchParams.get("workspaceId") ||
        "";
      if (url.pathname === "/api/knowledge/status" && request.method === "GET") {
        await manager.assertWorkspaceId(workspaceId);
        sendJson(response, 200, { ok: true, status: await manager.status({ workspaceId }) });
        return;
      }
      if (url.pathname === "/api/knowledge/initialize" && request.method === "POST") {
        sendJson(response, 200, { ok: true, status: await manager.initialize({ workspaceId }) });
        return;
      }
      if (url.pathname === "/api/knowledge/update" && request.method === "POST") {
        const update = await manager.update({ workspaceId, collections: body.collections });
        const embeddings = body.embed === true
          ? await manager.embed({
              workspaceId,
              collections: body.collections,
              force: body.force === true,
            })
          : null;
        sendJson(response, 200, { ok: true, update, embeddings });
        return;
      }
      if (url.pathname === "/api/knowledge/embed" && request.method === "POST") {
        const result = await manager.embed({
          workspaceId,
          collections: body.collections,
          force: body.force === true,
        });
        sendJson(response, 200, { ok: true, result });
        return;
      }
      if (url.pathname === "/api/knowledge/search" && request.method === "POST") {
        const result = await manager.search({ ...body, workspaceId });
        sendJson(response, 200, { ok: true, ...result });
        return;
      }
      if (url.pathname === "/api/knowledge/document" && request.method === "POST") {
        const document = await manager.getDocument({ ...body, workspaceId });
        sendJson(response, 200, { ok: true, document });
        return;
      }
      sendJson(response, 404, { ok: false, error: "NOT_FOUND" });
    } catch (error) {
      const code = String(error?.code || error?.name || "KNOWLEDGE_BACKEND_FAILED");
      const statusCode = code === "WORKSPACE_MISMATCH" ? 409 :
        code === "WORKSPACE_NOT_INITIALIZED" ? 412 :
          code === "REQUEST_TOO_LARGE" ? 413 : 500;
      sendJson(response, statusCode, {
        ok: false,
        error: code,
        message: String(error?.message || "Knowledge backend failed.").slice(0, 1000),
      });
    }
  });
  return { server, manager };
}

async function main() {
  const args = parseArguments(process.argv.slice(2));
  if (!args.projectRoot) {
    throw new Error(
      "Pass --project /absolute/path/to/project or set BIODESIGN_PROJECT_ROOT."
    );
  }
  const { server, manager } = createBiodesignServer(args);
  server.listen(args.port, "127.0.0.1", () => {
    console.log(`BioDesign local backend: http://127.0.0.1:${args.port}`);
    console.log(`Project sandbox: ${path.resolve(args.projectRoot)}`);
    console.log("QMD initializes after the browser opens the matching BioDesign workspace.");
  });
  const close = async () => {
    server.close();
    await manager.close();
  };
  process.once("SIGINT", close);
  process.once("SIGTERM", close);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error.message || error);
    process.exitCode = 1;
  });
}
