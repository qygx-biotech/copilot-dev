import path from "node:path";
import crypto from "node:crypto";
import sourceFetch from "../../shared/source-fetch.js";
import downloads from "../../shared/source-download.js";
import backendConfig from "../../shared/backend-config.js";
import webSearch from "../../shared/web-search.js";
import { assertOnlyKeys, ValidationError } from "../ipc/validation.mjs";

const { LIMITS, fetchSource, validateSourceUrl, detectContentType, canFallback, failure } = sourceFetch;
const extensions = { "application/pdf": ".pdf", "text/plain": ".txt", "text/markdown": ".md", "text/html": ".html",
  "application/xhtml+xml": ".html", "text/csv": ".csv", "text/xml": ".xml", "application/xml": ".xml", "application/json": ".json" };

export function sourceFilename(source, result) {
  let name = source.preferred_filename || "";
  if (!name) {
    const disposition = result.contentDisposition || "";
    const encoded = disposition.match(/filename\*\s*=\s*UTF-8''([^;]+)/i)?.[1];
    if (encoded) { try { name = decodeURIComponent(encoded.trim()); } catch { /* Use the plain filename or URL. */ } }
    name ||= disposition.match(/filename\s*=\s*(?:"([^"]+)"|([^;]+))/i)?.slice(1).find(Boolean)?.trim() || "";
  }
  if (!name) { try { name = decodeURIComponent(new URL(result.resolvedUrl).pathname.split("/").at(-1)); } catch { /* Use a safe default. */ } }
  name = String(name || source.title || "source").normalize("NFC").split(/[\\/]/).at(-1)
    .replace(/[\x00-\x1f\x7f<>:"|?*]/g, "_").replace(/^[. ]+|[. ]+$/g, "");
  // MIME determines the suffix: landing pages must never masquerade as PDFs.
  name = name.replace(/\.[a-z0-9]{1,12}$/i, "").slice(0, 120).replace(/[. ]+$/g, "") || "source";
  if (/^(?:con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(name)) name = `source-${name}`;
  return name + extensions[result.contentType];
}

export async function fetchFromCurrentFc(url, token, signal, fetchImpl = fetch) {
  if (typeof token !== "string" || !token || token.length > 8192 || /[\r\n]/.test(token)) throw failure("FC_AUTH_REQUIRED", "Sign in to use the FC fallback fetcher.");
  const timeout = AbortSignal.timeout(LIMITS.totalMs + 5000);
  const response = await fetchImpl(`${backendConfig.FC_BASE_URL}/api/sources/fetch`, {
    method: "POST", redirect: "error", signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` }, body: JSON.stringify({ url }),
  });
  // Bound the JSON/base64 envelope too; do not accept an unbounded proxy body.
  const chunks = []; let size = 0;
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > 6 * 1024 * 1024) throw failure("FILE_TOO_LARGE", "The FC response exceeds the fallback limit.");
    chunks.push(Buffer.from(chunk));
  }
  let data; try { data = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { throw failure("FC_INVALID_RESPONSE", "FC returned an invalid source response."); }
  if (!response.ok) throw Object.assign(failure(typeof data.error === "string" && /^[A-Z_]{1,80}$/.test(data.error) ? data.error : "FC_FETCH_FAILED", `FC fallback failed (HTTP ${response.status}).`),
    Number.isInteger(data.httpStatus) && data.httpStatus >= 100 && data.httpStatus <= 599 ? { httpStatus: data.httpStatus } : {});
  if (typeof data.contentBase64 !== "string" || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(data.contentBase64)) throw failure("FC_INVALID_RESPONSE", "FC returned invalid source bytes.");
  const bytes = Buffer.from(data.contentBase64, "base64");
  if (bytes.length > LIMITS.fcBytes) throw failure("FILE_TOO_LARGE", "The source exceeds the FC fallback limit.");
  return { bytes, resolvedUrl: validateSourceUrl(data.resolvedUrl).href, contentType: detectContentType(bytes, data.contentType), contentDisposition: String(data.contentDisposition || "").slice(0, 2000) };
}

function safeError(error) {
  const code = typeof error?.code === "string" && /^[A-Z_]{1,80}$/.test(error.code) ? error.code : "DOWNLOAD_FAILED";
  // Network/library exception messages can contain signed URLs or headers.
  return { code, message: code === "HTTP_ERROR" && /^Source returned HTTP \d{3}\.$/.test(error.message) ? error.message : `Source download failed (${code}).`,
    ...(Number.isInteger(error?.httpStatus) && error.httpStatus >= 100 && error.httpStatus <= 599 ? { httpStatus: error.httpStatus } : {}) };
}

export async function downloadSources(input, context, dependencies = {}) {
  assertOnlyKeys(input, ["args", "surface", "permission", "authToken", "webSearchSources", "webSearchMetadata"]);
  if (!downloads.allowed(input.surface, input.permission)) throw new ValidationError("PERMISSION_DENIED", "Source downloads require Agent Command with workspace write permission.");
  const args = downloads.validateInput(input.args);
  const { filesystem, signal } = context;
  const ensureCurrent = () => {
    if (signal?.aborted || context.isCurrent?.() === false) throw failure("OPERATION_ABORTED", "The project changed or the download was cancelled.");
  };
  const results = [];
  for (const source of args.sources) {
    ensureCurrent();
    const started = Date.now(); let method = "local", fallbackReason, result;
    try {
      validateSourceUrl(source.url);
      try { result = await (dependencies.localFetch || fetchSource)(source.url, { signal }); }
      catch (error) {
        if (!canFallback(error)) throw error;
        ensureCurrent(); method = "fc-fallback"; fallbackReason = safeError(error);
        result = await (dependencies.fcFetch || fetchFromCurrentFc)(source.url, input.authToken, signal);
      }
      ensureCurrent();
      if (!Buffer.isBuffer(result.bytes) || result.bytes.length > LIMITS.bytes) throw failure("FILE_TOO_LARGE", "The source exceeds the download size limit.");
      result.contentType = detectContentType(result.bytes, result.contentType);
      validateSourceUrl(result.resolvedUrl);
      const filename = sourceFilename(source, result), extension = path.posix.extname(filename), stem = filename.slice(0, -extension.length);
      let localPath;
      for (let duplicate = 0; duplicate < 1000; duplicate++) {
        ensureCurrent();
        localPath = `${args.destination}/${stem}${duplicate ? ` (${duplicate + 1})` : ""}${extension}`;
        try { await filesystem.writeBinary(localPath, result.bytes, { exclusive: true }); break; }
        catch (error) { if (error.code !== "EEXIST") throw error; if (duplicate === 999) throw failure("DUPLICATE_LIMIT", "No unused source filename was available."); }
      }
      const metadataPath = `.biodesign/sources/${crypto.createHash("sha256").update(localPath).digest("hex")}.json`;
      const matchingSources = webSearch.mergeSources(input.webSearchSources || []).filter(item => [webSearch.safeUrl(source.url), webSearch.safeUrl(result.resolvedUrl)].includes(item.url));
      const metadata = { source_url: source.url, resolved_url: result.resolvedUrl, title: source.title || matchingSources[0]?.title || "", local_path: localPath,
        content_type: result.contentType, downloaded_at: new Date().toISOString(), download_method: method,
        response_bytes: result.bytes.length, web_search_sources: matchingSources,
        web_search_metadata: webSearch.mergeMetadata(input.webSearchMetadata || []) };
      try { ensureCurrent(); await filesystem.writeText(metadataPath, JSON.stringify(metadata, null, 2) + "\n"); }
      catch (error) { await filesystem.remove(localPath).catch(() => {}); throw error; }
      results.push({ url: source.url, status: "downloaded", path: localPath, metadataPath, resolvedUrl: result.resolvedUrl, contentType: result.contentType,
        responseBytes: result.bytes.length, downloadMethod: method, ...(fallbackReason ? { fallbackReason } : {}) });
    } catch (error) {
      if (error.code === "OPERATION_ABORTED") throw error;
      results.push({ url: source.url, status: "failed", error: safeError(error), ...(fallbackReason ? { localError: fallbackReason, fallbackError: safeError(error) } : {}) });
    }
    console.info("source_download", { downloadMethod: method, downloadStatus: results.at(-1).status, contentType: results.at(-1).contentType,
      responseBytes: results.at(-1).responseBytes, duration: Date.now() - started, fallbackReason: fallbackReason?.code, error: results.at(-1).error?.code });
  }
  return results;
}
