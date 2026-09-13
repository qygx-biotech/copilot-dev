(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.BioDesignWebSearch = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";
  const MAX_SOURCES = 100, MAX_METADATA_BYTES = 96000;
  function safeUrl(value) {
    if (typeof value !== "string" || value.length > 4096 || /[\x00-\x20\x7f\\]/.test(value)) return null;
    try { const url = new URL(value); return ["http:", "https:"].includes(url.protocol) && !url.username && !url.password ? url.href : null; } catch { return null; }
  }
  function mergeSources(...lists) {
    const result = new Map();
    for (const item of lists.flat()) {
      const url = safeUrl(typeof item === "string" ? item : item?.url);
      if (!url || result.size >= MAX_SOURCES && !result.has(url)) continue;
      const previous = result.get(url) || { url };
      result.set(url, { ...previous, ...(typeof item?.title === "string" && item.title ? { title: item.title.slice(0, 500) } : {}),
        ...(typeof item?.provider === "string" && item.provider ? { provider: item.provider.slice(0, 100) } : {}) });
    }
    return [...result.values()];
  }
  const isHostedTool = tool => ["web_search", "web_search_preview", "web_search_call", "web_search_20250305", "web_search_tool_result"].includes(tool?.type) ||
    ["web_search", "web_search_preview"].includes(tool?.function?.name || tool?.name);
  function buildTools(localTools, supportsWebSearch, enabled = true) {
    const local = (localTools || []).filter(tool => tool?.type === "function" && !isHostedTool(tool));
    return [...local, ...(supportsWebSearch === true && enabled ? [{ type: "web_search" }] : [])];
  }
  function mergeMetadata(...lists) {
    const result = [], seen = new Set(); let size = 0;
    for (const item of lists.flat()) {
      if (!item || typeof item !== "object") continue;
      let serialized; try { serialized = JSON.stringify(item); } catch { continue; }
      if (seen.has(serialized) || size + serialized.length > MAX_METADATA_BYTES) continue;
      seen.add(serialized); size += serialized.length; result.push(JSON.parse(serialized));
    }
    return result;
  }
  // Only structured provider metadata is a source. Never mine URLs from prose.
  function normalizeResponse(response, provider = "") {
    const envelopes = [], metadataPaths = new Set(), containerPaths = new Set(), seen = new Set();
    let envelopeNodes = 0;
    const addEnvelope = (value, path = "$", depth = 0) => {
      if (!value || typeof value !== "object" || seen.has(value) || depth > 8 || ++envelopeNodes > 2000) return;
      seen.add(value);
      for (const key of ["web_search", "annotations", "citations", "search_results", "groundingMetadata", "grounding_metadata"]) {
        if (!Object.prototype.hasOwnProperty.call(value, key)) continue;
        if (metadataPaths.size < 48) metadataPaths.add(`${path}.${key}:${Array.isArray(value[key]) ? "array" : value[key] === null ? "null" : typeof value[key]}`);
        if (value[key] && typeof value[key] === "object") envelopes.push({ [key]: value[key] });
      }
      if (Array.isArray(value.content)) for (const block of value.content) {
        if (["web_search_tool_result", "web_search_result", "server_tool_use"].includes(block?.type)) {
          envelopes.push(block);
          if (metadataPaths.size < 48) metadataPaths.add(`${path}.content[]:${block.type}`);
        } else addEnvelope(block, `${path}.content[]`, depth + 1);
      }
      // Provider extensions may retain native Google candidate grounding rather
      // than Requesty's normalized delta.web_search. Visit protocol containers
      // only: never parse assistant text, tool arguments, or arbitrary objects.
      for (const key of ["choices", "candidates", "output"]) {
        if (Array.isArray(value[key])) for (const item of value[key]) addEnvelope(item, `${path}.${key}[]`, depth + 1);
      }
      for (const key of ["message", "delta", "extra_content", "google"]) {
        if (value[key] && typeof value[key] === "object") {
          if (["extra_content", "google"].includes(key) && containerPaths.size < 48) containerPaths.add(`${path}.${key}`);
          addEnvelope(value[key], `${path}.${key}`, depth + 1);
        }
      }
    };
    addEnvelope(response);
    const metadata = mergeMetadata(response?.webSearchMetadata || [], envelopes);
    const sources = []; let nodes = 0;
    const visit = (value, depth = 0) => {
      if (++nodes > 5000 || depth > 12 || !value) return;
      if (Array.isArray(value)) { value.forEach(item => visit(item, depth + 1)); return; }
      if (typeof value === "string") { if (safeUrl(value)) sources.push({ url: value, provider }); return; }
      if (typeof value !== "object") return;
      if (safeUrl(value.url || value.uri)) sources.push({ url: value.url || value.uri, title: value.title, provider });
      for (const key of ["web_search", "url_citation", "annotations", "citations", "search_results", "groundingMetadata", "grounding_metadata", "groundingChunks", "grounding_chunks", "web", "sources", "content", "results"]) {
        if (typeof value[key] !== "string") visit(value[key], depth + 1);
      }
    };
    metadata.forEach(item => visit(item));
    return { webSearchSources: mergeSources(response?.webSearchSources || [], sources), webSearchMetadata: metadata,
      webSearchDiagnostics: { metadataPaths: [...metadataPaths], containerPaths: [...containerPaths], metadataEnvelopeCount: envelopes.length } };
  }
  function textContent(content) {
    if (typeof content === "string") return content;
    return Array.isArray(content) ? content.filter(block => ["text", "output_text"].includes(block?.type)).map(block => block.text || "").join("") : "";
  }
  function renderSources(container, sources) {
    const normalized = mergeSources(sources || []);
    if (!normalized.length) return;
    const list = container.ownerDocument.createElement("ul");
    list.className = "web-search-sources";
    list.setAttribute("aria-label", "Web sources");
    for (const source of normalized) {
      const item = container.ownerDocument.createElement("li"), link = container.ownerDocument.createElement("a");
      link.textContent = source.title || source.url;
      link.href = source.url; link.title = source.url; link.target = "_blank"; link.rel = "noopener noreferrer";
      link.addEventListener("click", event => {
        const open = container.ownerDocument.defaultView?.biodesignDesktop?.runtime?.openSource;
        if (open) { event.preventDefault(); open({ url: source.url }).catch(() => {}); }
      });
      item.append(link); list.append(item);
    }
    container.append(list);
  }
  return Object.freeze({ safeUrl, mergeSources, mergeMetadata, isHostedTool, buildTools, normalizeResponse, textContent, renderSources });
});
