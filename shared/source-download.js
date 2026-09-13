(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.BioDesignSourceDownload = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";
  const MAX_URLS = 5;
  const allowed = (surface, permission) => surface === "agent_command" && ["workspace_write", "full_access"].includes(permission);
  const tool = Object.freeze({ type: "function", function: {
    name: "download_sources",
    description: "Download up to five selected source URLs into this local project. Use ONLY when the user explicitly asks to download/save sources, never just because search returned results. Search, download and ingestion are separate. Defaults to literature/. This writes files and requires Agent Command workspace_write or full_access. A PDF URL is best for a paper; an HTML landing page stays HTML. Tool results confirm actual saved paths or per-source failures. Existing ingestion handles new files on the next request.",
    parameters: { type: "object", additionalProperties: false, required: ["sources"], properties: {
      sources: { type: "array", minItems: 1, maxItems: MAX_URLS, items: { type: "object", additionalProperties: false, required: ["url"], properties: {
        url: { type: "string", maxLength: 4096 }, title: { type: "string", maxLength: 500 }, preferred_filename: { type: "string", maxLength: 180 },
      } } }, destination: { type: "string", description: "Project-relative directory; default literature. No hidden/application folders.", maxLength: 800 },
    } },
  } });
  function validateInput(input) {
    const bad = () => { throw Object.assign(new Error("Invalid source download arguments."), { code: "INVALID_DOWNLOAD_INPUT" }); };
    if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).some(key => !["sources", "destination"].includes(key)) ||
      !Array.isArray(input.sources) || !input.sources.length || input.sources.length > MAX_URLS) bad();
    const destination = input.destination === undefined ? "literature" : input.destination;
    if (typeof destination !== "string" || !destination || destination.length > 800 || /[\\:\x00-\x1f\x7f]/.test(destination) ||
      destination.split("/").some(part => !part || part.startsWith(".") || /[. ]$/.test(part))) bad();
    const sources = input.sources.map(source => {
      if (!source || typeof source !== "object" || Array.isArray(source) || Object.keys(source).some(key => !["url", "title", "preferred_filename"].includes(key)) ||
        typeof source.url !== "string" || !source.url || source.url.length > 4096) bad();
      for (const [key, max] of [["title", 500], ["preferred_filename", 180]]) if (source[key] !== undefined && (typeof source[key] !== "string" || source[key].length > max)) bad();
      return { ...source };
    });
    return { sources, destination };
  }
  function resultSummary(results, language = "en") {
    const zh = language === "zh";
    const safe = value => String(value || "").replace(/[`<>\r\n]/g, " ");
    return [zh ? "实际下载结果：" : "Actual download results:", "", ...results.map((result, index) => result.status === "downloaded"
      ? `- ${zh ? "已保存" : "Saved"}: \`${safe(result.path)}\` (${safe(result.contentType) || "unknown content type"})${result.contentType?.includes("html") ? zh ? " — HTML 页面，不是 PDF。" : " — HTML page, not a PDF." : ""}`
      : `- ${zh ? "来源" : "Source"} ${index + 1} (\`${safe(result.url)}\`): ${zh ? "失败" : "failed"} — ${safe(result.error?.code || "DOWNLOAD_FAILED")}${result.error?.httpStatus ? ` (HTTP ${result.error.httpStatus})` : ""}`)].join("\n");
  }
  return Object.freeze({ MAX_URLS, allowed, tool, validateInput, resultSummary });
});
