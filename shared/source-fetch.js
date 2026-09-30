"use strict";
// Node-only bounded HTTP transport shared by the desktop and the existing FC.
const http = require("node:http");
const https = require("node:https");
const dns = require("node:dns/promises");
const { isIP, BlockList } = require("node:net");

const LIMITS = Object.freeze({ bytes: 20 * 1024 * 1024, fcBytes: 4 * 1024 * 1024,
  redirects: 4, connectMs: 10000, readMs: 15000, totalMs: 60000 });
const failure = (code, message) => Object.assign(new Error(message), { code });
const blocked = new BlockList();
for (const [address, prefix] of [["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10],
  ["127.0.0.0", 8], ["169.254.0.0", 16], ["172.16.0.0", 12], ["192.0.0.0", 24],
  ["192.0.2.0", 24], ["192.88.99.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15], ["198.51.100.0", 24],
  ["203.0.113.0", 24], ["224.0.0.0", 4], ["240.0.0.0", 4]]) blocked.addSubnet(address, prefix, "ipv4");
for (const [address, prefix] of [["2001::", 23], ["2001:db8::", 32], ["2002::", 16], ["3fff::", 20]]) blocked.addSubnet(address, prefix, "ipv6");
const globalV6 = new BlockList();
globalV6.addSubnet("2000::", 3, "ipv6");

function publicAddress(address) {
  const family = isIP(address);
  return family === 4 ? !blocked.check(address, "ipv4") : family === 6 &&
    globalV6.check(address, "ipv6") && !blocked.check(address, "ipv6");
}

function validateSourceUrl(value) {
  if (typeof value !== "string" || value.length > 4096 || /[\x00-\x20\x7f\\]/.test(value)) throw failure("INVALID_URL", "A valid HTTP(S) source URL is required.");
  let url; try { url = new URL(value); } catch { throw failure("INVALID_URL", "A valid HTTP(S) source URL is required."); }
  if (!["https:", "http:"].includes(url.protocol) || url.username || url.password ||
      (url.port && !["80", "443"].includes(url.port))) throw failure("UNSAFE_URL", "Only public HTTP(S) URLs on standard ports without credentials are allowed.");
  const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase().replace(/\.$/, "");
  if (!host || (!isIP(host) && (!host.includes(".") || /(?:^|\.)(?:localhost|local|internal|lan|home|test|invalid)$/.test(host))) ||
      (isIP(host) && !publicAddress(host))) throw failure("UNSAFE_URL", "Local, private, reserved and metadata targets are blocked.");
  url.hash = "";
  return url;
}

async function resolvePublicTarget(url, lookup = dns.lookup) {
  const host = url.hostname.replace(/^\[|\]$/g, "").replace(/\.$/, "");
  let addresses;
  try { addresses = isIP(host) ? [{ address: host, family: isIP(host) }] : await lookup(host, { all: true, verbatim: true }); }
  catch { throw failure("DNS_FAILED", "The source hostname could not be resolved."); }
  if (!addresses.length || addresses.some(item => !publicAddress(item.address))) throw failure("UNSAFE_URL", "The source resolves to a private, reserved or metadata address.");
  return addresses[0];
}

function requestOnce(url, address, { signal, maxBytes, connectMs, readMs, hostHeaders = {} }) {
  return new Promise((resolve, reject) => {
    // Pin the validated address while retaining the original Host and TLS SNI.
    // A second DNS lookup cannot turn a public validation into a private fetch.
    const request = (url.protocol === "https:" ? https : http).get(url, {
      agent: false, signal,
      headers: { Accept: "application/pdf,text/*,application/json,application/xml;q=0.8,*/*;q=0.5", "Accept-Encoding": "identity", "User-Agent": "BioDesign-Source-Downloader/1.0", ...hostHeaders },
      lookup: (_hostname, options, callback) => options.all
        ? callback(null, [address]) : callback(null, address.address, address.family),
    });
    const timer = setTimeout(() => request.destroy(failure("CONNECT_TIMEOUT", "The source connection timed out.")), connectMs);
    request.once("socket", socket => socket.once(url.protocol === "https:" ? "secureConnect" : "connect", () => clearTimeout(timer)));
    request.setTimeout(readMs, () => request.destroy(failure("READ_TIMEOUT", "The source stopped responding.")));
    request.once("error", reject);
    request.once("close", () => clearTimeout(timer));
    request.once("response", response => {
      clearTimeout(timer);
      const status = response.statusCode;
      const headers = response.headers;
      if ([301, 302, 303, 307, 308].includes(status)) {
        response.destroy(); resolve({ redirect: headers.location }); return;
      }
      if (status < 200 || status >= 300) { response.destroy(); reject(Object.assign(failure("HTTP_ERROR", `Source returned HTTP ${status}.`), { httpStatus: status })); return; }
      if (Number(headers["content-length"]) > maxBytes) { response.destroy(); reject(failure("FILE_TOO_LARGE", "The source exceeds the download size limit.")); return; }
      if (headers["content-encoding"] && headers["content-encoding"] !== "identity") { response.destroy(); reject(failure("UNSUPPORTED_ENCODING", "Compressed HTTP responses are not supported.")); return; }
      let size = 0; const chunks = [];
      response.on("data", chunk => {
        size += chunk.length;
        if (size > maxBytes) response.destroy(failure("FILE_TOO_LARGE", "The source exceeds the download size limit."));
        else chunks.push(chunk);
      });
      response.once("error", reject);
      response.once("end", () => resolve({ bytes: Buffer.concat(chunks), contentType: String(headers["content-type"] || "application/octet-stream").split(";", 1)[0].trim().toLowerCase(),
        contentDisposition: String(headers["content-disposition"] || "").slice(0, 2000) }));
    });
  });
}

function detectContentType(bytes, declared) {
  if (!bytes.length) throw failure("EMPTY_SOURCE", "The source response was empty.");
  if (bytes.subarray(0, 1024).includes(Buffer.from("%PDF-"))) return "application/pdf";
  if (declared === "application/pdf") throw failure("INVALID_PDF", "The response was labeled PDF but contains no PDF signature.");
  if (["text/plain", "text/markdown", "text/html", "text/csv", "text/xml", "application/xml", "application/json", "application/xhtml+xml"].includes(declared)) return declared;
  throw failure("UNSUPPORTED_CONTENT_TYPE", "This response content type is not supported as a source.");
}

async function fetchSource(value, options = {}) {
  const settings = { maxBytes: LIMITS.bytes, maxRedirects: LIMITS.redirects, connectMs: LIMITS.connectMs,
    readMs: LIMITS.readMs, totalMs: LIMITS.totalMs, ...options };
  const controller = new AbortController();
  const abort = () => controller.abort();
  options.signal?.addEventListener("abort", abort, { once: true });
  if (options.signal?.aborted) controller.abort();
  const timeout = setTimeout(abort, settings.totalMs);
  const aborted = new Promise((_, reject) => controller.signal.addEventListener("abort", () => reject(failure(
    options.signal?.aborted ? "OPERATION_ABORTED" : "DOWNLOAD_TIMEOUT", "The source download was cancelled or timed out.")), { once: true }));
  try {
    if (controller.signal.aborted) throw failure("OPERATION_ABORTED", "The source download was cancelled.");
    const task = async () => {
      let url = validateSourceUrl(value);
      for (let redirects = 0; ; redirects++) {
        let dnsTimer;
        const address = await Promise.race([resolvePublicTarget(url, options.lookup), aborted, new Promise((_, reject) => {
          dnsTimer = setTimeout(() => reject(failure("CONNECT_TIMEOUT", "Source DNS resolution timed out.")), settings.connectMs);
        })]).finally(() => clearTimeout(dnsTimer));
        if (controller.signal.aborted) throw failure("OPERATION_ABORTED", "The source download was cancelled.");
        const result = await (options.request || requestOnce)(url, address, { ...settings, signal: controller.signal });
        if (Object.hasOwn(result, "redirect")) {
          if (!result.redirect || redirects >= settings.maxRedirects) throw failure("REDIRECT_LIMIT", "The source exceeded the redirect limit or returned an invalid redirect.");
          let next; try { next = new URL(result.redirect, url); } catch { throw failure("INVALID_URL", "Invalid source redirect."); }
          url = validateSourceUrl(next.href);
          continue;
        }
        if (result.bytes.length > settings.maxBytes) throw failure("FILE_TOO_LARGE", "The source exceeds the download size limit.");
        return { ...result, contentType: detectContentType(result.bytes, result.contentType), resolvedUrl: url.href };
      }
    };
    return await Promise.race([task(), aborted]);
  } catch (error) {
    if (controller.signal.aborted) throw failure(options.signal?.aborted ? "OPERATION_ABORTED" : "DOWNLOAD_TIMEOUT", "The source download was cancelled or timed out.");
    if (["INVALID_URL", "UNSAFE_URL", "DNS_FAILED", "CONNECT_TIMEOUT", "READ_TIMEOUT", "HTTP_ERROR", "FILE_TOO_LARGE",
      "UNSUPPORTED_ENCODING", "EMPTY_SOURCE", "INVALID_PDF", "UNSUPPORTED_CONTENT_TYPE", "REDIRECT_LIMIT"].includes(error.code)) throw error;
    throw failure("NETWORK_ERROR", "The source could not be fetched.");
  } finally { clearTimeout(timeout); options.signal?.removeEventListener("abort", abort); }
}

const canFallback = error => ["HTTP_ERROR", "DNS_FAILED", "CONNECT_TIMEOUT", "READ_TIMEOUT", "DOWNLOAD_TIMEOUT", "NETWORK_ERROR",
  "ECONNRESET", "ECONNREFUSED", "ENETUNREACH", "EHOSTUNREACH", "ETIMEDOUT", "CERT_HAS_EXPIRED", "UNABLE_TO_VERIFY_LEAF_SIGNATURE", "DEPTH_ZERO_SELF_SIGNED_CERT"].includes(error?.code);
module.exports = { LIMITS, failure, publicAddress, validateSourceUrl, resolvePublicTarget, detectContentType, fetchSource, canFallback, requestOnce };
