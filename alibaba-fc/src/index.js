"use strict";

// HTTP adapter for local development and FC custom runtimes. The same handler
// owns authentication, validation, tool authorization, and provider requests.
const http = require("node:http");
const { once } = require("node:events");
const { handler: functionComputeHandler } = require("../index.js");

async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 32 * 1024 * 1024) throw Object.assign(new Error("Request body is too large."), { statusCode: 413 });
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function handler(req, res) {
  const controller = new AbortController();
  const disconnected = () => { if (!res.writableEnded) controller.abort(); };
  res.once("close", disconnected);
  let heartbeat = null, started = false;
  const timer = setTimeout(() => controller.abort(), 300000);
  timer.unref();
  const transport = {
    signal: controller.signal,
    async start(headers) {
      if (controller.signal.aborted) throw new Error("Connection closed.");
      res.writeHead(200, { ...headers, "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache, no-transform", "X-Accel-Buffering": "no", "Transfer-Encoding": "chunked" });
      res.flushHeaders(); started = true;
      res.write(": connected\n\n");
      heartbeat = setInterval(() => { if (!res.destroyed && !res.writableNeedDrain) res.write(": heartbeat\n\n"); }, 15000);
      heartbeat.unref();
    },
    async emit(event, data) {
      if (controller.signal.aborted || res.destroyed) throw Object.assign(new Error("Connection closed."), { code: "OPERATION_ABORTED" });
      if (!res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)) await once(res, "drain", { signal: controller.signal });
    },
  };
  try {
    const body = await readBody(req);
    const response = await functionComputeHandler(
      {
        requestContext: {
          http: {
            method: String(req.method || "GET").toUpperCase(),
            path: new URL(req.url || "/", `http://${req.headers.host || "localhost"}`).pathname,
          },
        },
        headers: { ...req.headers },
        ...(body ? { body } : {}),
      },
      { requestId: String(req.headers["x-fc-request-id"] || "local-http-adapter").slice(0, 160) },
      transport
    );
    if (res.destroyed) return;
    if (started) {
      const data = JSON.parse(response.body || "{}");
      if (response.statusCode >= 400 || data.fallback) await transport.emit("error", { code: data.error || "STREAM_INTERRUPTED" });
      else await transport.emit("complete", data);
      res.end();
      return;
    }
    for (const [key, value] of Object.entries(response.headers || {})) res.setHeader(key, value);
    res.statusCode = Number(response.statusCode) || 500;
    res.end(response.body || "");
  } catch (error) {
    if (res.destroyed) return;
    if (started) res.end('event: error\ndata: {"code":"STREAM_INTERRUPTED"}\n\n');
    else {
      res.writeHead(error.statusCode || 500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: error.statusCode === 413 ? "Request body is too large." : "Internal server error" }));
    }
  } finally {
    clearInterval(heartbeat); clearTimeout(timer);
    res.removeListener("close", disconnected);
  }
}

module.exports = handler;
module.exports.handler = handler;

if (require.main === module) {
  const port = Number(process.env.PORT || 9000);
  const server = http.createServer((req, res) => {
    handler(req, res).catch((error) => {
      console.error("Alibaba FC HTTP adapter error:", error?.code || "HTTP_ADAPTER_ERROR");
      res.statusCode = 500;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ error: "Internal server error" }));
    });
  });
  server.listen(port, "0.0.0.0", () => {
    console.log(`BioDesign Copilot Alibaba FC local adapter on port ${port}`);
  });
}
