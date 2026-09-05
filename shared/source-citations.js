(function exposeSourceCitations(root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.BioDesignSourceCitations = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";
  const plain = (value) => Boolean(value && typeof value === "object" && !Array.isArray(value));
  const text = (value, limit = 500) => typeof value === "string" ? value.slice(0, limit) : "";
  function relativePath(value) {
    if (typeof value !== "string" || !value || value.length > 1000 || /[\x00-\x1f\x7f\\:]/.test(value) || value.startsWith("/")) return null;
    return value.split("/").some((part) => !part || part === "." || part === "..") ? null : value;
  }
  function normalizeCitation(value) {
    if (!plain(value) || !/^citation-\d{1,4}$/.test(value.id || "")) return null;
    return {
      id: value.id, reference: text(value.reference), sourceId: text(value.sourceId, 256),
      workspaceId: text(value.workspaceId, 256), workspaceName: text(value.workspaceName, 200),
      relativePath: relativePath(value.relativePath), contentHash: text(value.contentHash, 200),
      page: Number.isInteger(value.page) && value.page > 0 ? value.page : null,
      sheet: text(value.sheet, 200), row: Number.isInteger(value.row) && value.row > 0 ? value.row : null,
      range: /^[A-Z]+\d+(?::[A-Z]+\d+)?$/.test(value.range || "") ? value.range : "",
      status: ["resolved", "missing", "stale", "ambiguous", "unverified-location"].includes(value.status) ? value.status : "missing",
    };
  }
  function normalizeCitations(values) {
    const seen = new Set();
    return (Array.isArray(values) ? values : []).slice(0, 200).map(normalizeCitation).filter((entry) => {
      if (!entry || seen.has(entry.id)) return false;
      seen.add(entry.id); return true;
    });
  }
  function label(citation) {
    const path = relativePath(citation.relativePath);
    if (!path) return "Source unavailable (reference not found)";
    const location = [citation.page ? `p. ${citation.page}` : "", citation.sheet ? `Sheet ${citation.sheet}` : "", citation.range || (citation.row ? `row ${citation.row}` : "")].filter(Boolean).join(" — ");
    const source = [citation.workspaceName, ...path.split("/")].filter(Boolean).join(" / ");
    const state = citation.status === "resolved" ? "" : citation.status === "unverified-location" ? " — location unavailable" : " — source unavailable or changed";
    return `${source}${location ? ` — ${location}` : ""}${state}`;
  }
  // Navigation is identity-based. Neither a model URL nor a citation's old path
  // is sufficient: the current workspace registry and tree must agree.
  function navigationTarget(citation, context = {}) {
    if (!citation || citation.status !== "resolved" || !citation.workspaceId || citation.workspaceId !== context.workspaceId) return null;
    const source = context.getSource?.(citation.sourceId);
    if (!source || ["deleted", "missing", "removed", "stale", "dirty"].includes(source.catalogStatus)) return null;
    const path = relativePath(source.path);
    if (!path || path !== citation.relativePath || (citation.contentHash && citation.contentHash !== source.contentHash)) return null;
    if (!(context.files || []).some((file) => file.type === "file" && file.relativePath === path)) return null;
    const parts = path.split("/");
    return { relativePath: path, ancestors: ["", ...parts.slice(0, -1).map((_, index) => parts.slice(0, index + 1).join("/"))] };
  }
  function bindToWorkspace(citations, context = {}) {
    return normalizeCitations(citations).map((citation) => {
      const source = context.getSource?.(citation.sourceId);
      const valid = source && relativePath(source.path) === citation.relativePath &&
        (!citation.contentHash || citation.contentHash === source.contentHash) &&
        !["deleted", "missing", "removed", "stale", "dirty"].includes(source.catalogStatus);
      return { ...citation, workspaceId: context.workspaceId || "", workspaceName: context.workspaceName || citation.workspaceName,
        contentHash: citation.contentHash || source?.contentHash || "",
        status: valid ? citation.status : "missing" };
    });
  }
  function createRegistry(entries, workspaceName = "") {
    const aliases = new Map();
    const add = (id, value) => {
      if (!id || id.length > 500) return;
      if (aliases.has(id) && JSON.stringify(aliases.get(id)) !== JSON.stringify(value)) aliases.set(id, null);
      else if (!aliases.has(id)) aliases.set(id, value);
    };
    for (const entry of entries || []) {
      if (!entry.sourceId || !relativePath(entry.relativePath)) continue;
      const base = { sourceId: entry.sourceId, relativePath: entry.relativePath, workspaceName: text(workspaceName, 200), contentHash: entry.contentHash || "", page: null, sheet: "", row: null, range: "", status: entry.status || "resolved" };
      for (const alias of new Set([entry.sourceId, ...(entry.aliases || [])])) add(alias, base);
      for (const evidence of entry.evidence || []) {
        if (typeof evidence.reference !== "string") continue;
        add(evidence.reference, { ...base, contentHash: evidence.contentHash || base.contentHash, page: evidence.page || null, sheet: evidence.sheet || "", row: evidence.row || null, range: evidence.range || "" });
      }
    }
    return {
      has: (reference) => aliases.has(reference),
      resolve(reference) {
        return aliases.get(reference) || { status: aliases.has(reference) ? "ambiguous" : "missing", workspaceName: text(workspaceName, 200) };
      },
    };
  }
  const markdownLabel = (value) => value.replace(/[\\`*_[\]<>|]/g, "\\$&").replace(/[\r\n]/g, " ");
  // Only explicit citation syntax is transformed. Ordinary prose, URLs, inline
  // code, indented code, and fenced code retain their exact text.
  function resolveAnswer(answer, registry = createRegistry([])) {
    const citations = [], byReference = new Map();
    const citation = (reference) => {
      if (byReference.has(reference)) return byReference.get(reference);
      if (citations.length >= 200) return "[Source unavailable (citation limit)]";
      const resolved = registry.resolve(reference);
      const entry = normalizeCitation({ ...resolved, id: `citation-${citations.length + 1}`, reference });
      citations.push(entry);
      const marker = `[${markdownLabel(label(entry))}](biodesign-citation:${entry.id})`;
      byReference.set(reference, marker); return marker;
    };
    let fence = null;
    const reply = String(answer || "").split("\n").map((line) => {
      const fenced = line.match(/^\s{0,3}(`{3,}|~{3,})/);
      if (fenced) {
        if (!fence) fence = fenced[1];
        else if (fenced[1][0] === fence[0] && fenced[1].length >= fence.length && /^\s{0,3}(?:`+|~+)\s*$/.test(line)) fence = null;
        return line;
      }
      if (fence || /^(?: {4}|\t)/.test(line)) return line;
      const tokens = /(`+)[\s\S]*?\1|\[[^\]\n]*\]\([^\n]*?\)|\[\[cite:([^\]\n]+)\]\]|\[([^\]\n]+)\]/g;
      return line.replace(tokens, (whole, code, explicit, bracket) => {
        if (code || (!explicit && bracket === undefined)) return whole;
        if (explicit) return citation(explicit);
        if (registry.has(bracket) || /^local:\d+$/.test(bracket) || /^[\w.-]+:p\d+:[\w.:-]+$/.test(bracket)) return citation(bracket);
        return whole;
      });
    }).join("\n");
    return { reply, citations };
  }
  return Object.freeze({ relativePath, normalizeCitation, normalizeCitations, label, navigationTarget, bindToWorkspace, createRegistry, resolveAnswer });
});
