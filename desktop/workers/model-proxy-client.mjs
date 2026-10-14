import { createRequire } from "node:module";

// Client for the FC model proxy (POST /api/model/turn). It knows only the FC
// base URL and the user's session token; provider URLs and keys stay in FC.
const require = createRequire(import.meta.url);
const { readEvents } = require("../../shared/event-stream.js");

export const MODEL_PROXY_PATH = "/api/model/turn";
export const MODEL_CAPABILITIES_PATH = "/api/model/capabilities";
const STREAM_EVENTS = new Set(["status", "delta", "sources", "tool-call", "usage"]);
const STREAM_LIMIT_BYTES = 16 * 1024 * 1024;

export class ModelProxyError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "ModelProxyError";
    this.code = code;
    Object.assign(this, details);
  }
}

// HTTPS only, except plain HTTP on the loopback interface for local FC adapters
// and tests. Credentials, queries and fragments are never accepted.
export function proxyEndpoint(baseUrl, path = MODEL_PROXY_PATH) {
  let url;
  try { url = new URL(baseUrl); } catch { throw new ModelProxyError("INVALID_PROXY_URL", "The model proxy URL is invalid."); }
  const loopback = url.protocol === "http:" && ["127.0.0.1", "[::1]", "localhost"].includes(url.hostname);
  if ((url.protocol !== "https:" && !loopback) || url.username || url.password || url.search || url.hash) {
    throw new ModelProxyError("INVALID_PROXY_URL", "The model proxy must use HTTPS.");
  }
  // Resolve relative to the base so a path prefix on the FC URL is kept.
  return new URL(path.slice(1), url.href.endsWith("/") ? url.href : url.href + "/").href;
}

async function proxyFailure(response) {
  let body = {};
  try { body = await response.json(); } catch { /* A gateway error page is not a proxy contract. */ }
  if (response.status === 401) return new ModelProxyError("AUTH_REQUIRED", "The desktop session is not authorized.", { status: 401, origin: "proxy" });
  const code = typeof body.error === "string" && /^[A-Za-z0-9_]{1,80}$/.test(body.error) ? body.error : "MODEL_PROXY_HTTP_ERROR";
  const details = { status: response.status, origin: body.origin === "proxy" ? "proxy" : "gateway" };
  for (const key of ["capability", "retryAfterMs", "cap", "used"]) if (body[key] !== undefined) details[key] = body[key];
  return new ModelProxyError(code, typeof body.message === "string" ? body.message.slice(0, 500) : `The model proxy returned HTTP ${response.status}.`, details);
}

// Model resolution, capabilities and server loop policy for one turn
// (POST /api/model/capabilities). Contains no keys or provider endpoints.
export async function fetchModelCapabilities({ baseUrl, token, request, signal, fetchImpl = globalThis.fetch }) {
  if (typeof token !== "string" || !token) throw new ModelProxyError("AUTH_REQUIRED", "A desktop session token is required.");
  const endpoint = proxyEndpoint(baseUrl, MODEL_CAPABILITIES_PATH);
  let response;
  try {
    response = await fetchImpl(endpoint, { method: "POST", signal, redirect: "error",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ version: 1, ...request }) });
  } catch (error) {
    if (signal?.aborted) throw new ModelProxyError("OPERATION_ABORTED", "The capabilities request was cancelled.");
    throw new ModelProxyError("MODEL_PROXY_UNREACHABLE", "The model proxy could not be reached.", { causeCode: String(error?.cause?.code || error?.code || "").slice(0, 80) || undefined });
  }
  if (!response.ok) throw await proxyFailure(response);
  try { return await response.json(); }
  catch { throw new ModelProxyError("MODEL_PROXY_INVALID_RESPONSE", "The model proxy returned an invalid response."); }
}

// Resolves with the proxy's final object: { ok, model, api, capabilities,
// result, origin?, category? }. Provider failures resolve (ok:false) so the
// caller can classify `result`; proxy, session and transport failures throw.
export async function callModelTurn({ baseUrl, token, request, signal, fetchImpl = globalThis.fetch, onEvent = () => {} }) {
  if (typeof token !== "string" || !token) throw new ModelProxyError("AUTH_REQUIRED", "A desktop session token is required.");
  const endpoint = proxyEndpoint(baseUrl);
  let response;
  try {
    response = await fetchImpl(endpoint, { method: "POST", signal, redirect: "error",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", Accept: "text/event-stream, application/json" },
      body: JSON.stringify({ version: 1, stream: true, ...request }) });
  } catch (error) {
    if (signal?.aborted) throw new ModelProxyError("OPERATION_ABORTED", "The model call was cancelled.");
    throw new ModelProxyError("MODEL_PROXY_UNREACHABLE", "The model proxy could not be reached.", { causeCode: String(error?.cause?.code || error?.code || "").slice(0, 80) || undefined });
  }
  if (!response.ok) throw await proxyFailure(response);
  if (!/text\/event-stream/i.test(response.headers.get("content-type") || "")) {
    try { return await response.json(); }
    catch { throw new ModelProxyError("MODEL_PROXY_INVALID_RESPONSE", "The model proxy returned an invalid response."); }
  }
  let final = null;
  try {
    await readEvents(response, async event => {
      if (final) throw new ModelProxyError("STREAM_INVALID", "The model proxy sent data after its final event.");
      let data;
      try { data = JSON.parse(event.data); } catch { throw new ModelProxyError("STREAM_INVALID", "The model proxy sent an invalid event."); }
      if (event.event === "final") { final = data; return false; }
      if (event.event === "error") throw new ModelProxyError("STREAM_INTERRUPTED", "The model proxy interrupted the response.");
      if (STREAM_EVENTS.has(event.event)) await onEvent({ type: event.event, ...data });
    }, { signal, maxBytes: STREAM_LIMIT_BYTES });
  } catch (error) {
    if (signal?.aborted || error?.code === "OPERATION_ABORTED") throw new ModelProxyError("OPERATION_ABORTED", "The model call was cancelled.");
    if (error instanceof ModelProxyError) throw error;
    throw new ModelProxyError(String(error?.code || "").startsWith("STREAM_") ? error.code : "STREAM_INTERRUPTED", "The model proxy stream was interrupted.");
  }
  if (!final) throw new ModelProxyError("STREAM_INTERRUPTED", "The model proxy stream ended before its final event.");
  return final;
}
