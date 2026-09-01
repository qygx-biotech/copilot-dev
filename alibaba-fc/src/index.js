"use strict";

// Local HTTP adapter for the deployable FC handler. Keeping development traffic
// on the same handler prevents an unauthenticated second Requesty client from
// drifting away from the production authentication, validation, and retry path.
const http = require("node:http");
const { handler: functionComputeHandler } = require("../index.js");

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

async function handler(req, res) {
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
    { requestId: "local-http-adapter" }
  );

  for (const [key, value] of Object.entries(response.headers || {})) {
    res.setHeader(key, value);
  }
  res.statusCode = Number(response.statusCode) || 500;
  res.end(response.body || "");
}

module.exports = handler;
module.exports.handler = handler;

if (require.main === module) {
  const port = Number(process.env.PORT || 9000);
  const server = http.createServer((req, res) => {
    handler(req, res).catch((error) => {
      console.error("Alibaba FC local adapter error:", String(error?.message || error).slice(0, 500));
      res.statusCode = 500;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ error: "Internal server error" }));
    });
  });
  server.listen(port, () => {
    console.log(`BioDesign Copilot Alibaba FC local adapter on port ${port}`);
  });
}
