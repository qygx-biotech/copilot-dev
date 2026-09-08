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
  function label(citation, { compact = false } = {}) {
    const path = relativePath(citation.relativePath);
    if (!path) return "Source unavailable (reference not found)";
    const location = [citation.page ? `p. ${citation.page}` : "", citation.sheet ? `Sheet ${citation.sheet}` : "", citation.range || (citation.row ? `row ${citation.row}` : "")].filter(Boolean).join(" — ");
    const filename = path.split("/").at(-1);
    const characters = Array.from(filename);
    const shortName = characters.length > 56 ? `${characters.slice(0, 39).join("")}…${characters.slice(-16).join("")}` : filename;
    const source = compact ? shortName : [citation.workspaceName, ...path.split("/")].filter(Boolean).join(" / ");
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
  // Internal local:N handles in prose, including a code span containing only
  // that handle, are citations too. Preserve URLs, code expressions and blocks.
  function resolveAnswer(answer, registry = createRegistry([]), existingCitations = []) {
    const citations = normalizeCitations(existingCitations), byReference = new Map();
    // Keep saved identities and reserve dangling links too, so a newly repaired
    // marker can never make an unrelated old link point to a different source.
    const usedIds = new Set([...citations.map(entry => entry.id), ...String(answer || "").matchAll(/biodesign-citation:(citation-\d{1,4})/g)].map(value => typeof value === "string" ? value : value[1]));
    const marker = entry => `[${markdownLabel(label(entry))}](biodesign-citation:${entry.id})`;
    for (const entry of citations) if (entry.reference && !byReference.has(entry.reference)) byReference.set(entry.reference, marker(entry));
    let nextId = 1;
    const citation = (reference) => {
      if (byReference.has(reference)) return byReference.get(reference);
      if (citations.length >= 200) return "[Source unavailable (citation limit)]";
      const resolved = registry.resolve(reference);
      while (usedIds.has(`citation-${nextId}`) && nextId <= 9999) nextId++;
      if (nextId > 9999) return "[Source unavailable (citation limit)]";
      const entry = normalizeCitation({ ...resolved, id: `citation-${nextId++}`, reference });
      citations.push(entry);
      const link = marker(entry);
      byReference.set(reference, link); return link;
    };
    let fence = null, fenceIndent = 0;
    const listStack = [];
    const reply = String(answer || "").split("\n").map((line) => {
      const structure = line.replace(/\t/g, "    ");
      const indent = structure.match(/^ */)[0].length;
      if (fence) {
        const closing = structure.slice(fenceIndent).match(/^ {0,3}(`{3,}|~{3,})\s*$/);
        if (indent >= fenceIndent && closing && closing[1][0] === fence[0] && closing[1].length >= fence.length) fence = null;
        return line;
      }
      if (!line.trim()) return line;
      const item = structure.match(/^( *)([-+*]|\d+[.)])( +)(?=\S)/);
      const parent = [...listStack].reverse().find(entry => indent >= entry.contentIndent);
      let contentIndent = parent?.contentIndent || 0;
      // Four spaces inside a list can be an ordinary nested item. Only an
      // additional four spaces beyond the containing item introduce code.
      if (item && (indent < 4 || (parent && indent < parent.contentIndent + 4))) {
        while (listStack.length && listStack.at(-1).indent >= indent) listStack.pop();
        contentIndent = indent + item[2].length + (item[3].length > 4 ? 1 : item[3].length);
        listStack.push({ indent, contentIndent });
      } else {
        while (listStack.length && listStack.at(-1).contentIndent > indent) listStack.pop();
        contentIndent = listStack.at(-1)?.contentIndent || 0;
        if (indent >= contentIndent + 4) return line;
      }
      const fenced = structure.slice(contentIndent).match(/^ {0,3}(`{3,}|~{3,})/);
      if (fenced) {
        fence = fenced[1]; fenceIndent = contentIndent;
        return line;
      }
      const tokens = /(`+)[\s\S]*?\1|\[(?:\\.|[^\[\]\n]|\[[^\]\n]*\])*\]\([^\n]*?\)|(?:[a-z][a-z\d+.-]*:\/\/|www\.)[^\s<>]+|<[^>]*>|(\[(?:\s*\[cite:[^\]\n]+\]\s*[,;]?\s*)+\])|\[cite:([^\]\n]+)\]|\[([^\]\n]+)\]|(?<![\w:/\\.@-])(local:\d+)(?![\w:/\\@-]|\.\w)/g;
      return line.replace(tokens, (whole, code, group, explicit, bracket, local) => {
        if (code) {
          const reference = whole.slice(code.length, -code.length).trim();
          return /^local:\d+$/.test(reference) || registry.has(reference) || byReference.has(reference) ? citation(reference) : whole;
        }
        if (local) return citation(local);
        if (!group && !explicit && bracket === undefined) return whole;
        if (group || explicit) {
          const references = group ? [...group.matchAll(/\[cite:([^\]\n]+)\]/g)].map(match => match[1]) : [explicit];
          return [...new Set(references.flatMap(value => value.split(/\s*[,;]\s*/)).map(value => value.trim().replace(/^cite:/, "")))].map(citation).join(", ");
        }
        if (registry.has(bracket) || /^local:\d+$/.test(bracket) || /^[\w.-]+:p\d+:[\w.:-]+$/.test(bracket)) return citation(bracket);
        return whole;
      });
    }).join("\n");
    return { reply, citations };
  }
  function resolveForDisplay(answer, savedCitations, context = {}) {
    const saved = normalizeCitations(savedCitations), sources = new Map();
    for (const entry of saved) {
      if (!entry.sourceId) continue;
      const base = { ...entry, page: null, sheet: "", row: null, range: "" };
      const previous = sources.get(entry.sourceId);
      if (sources.has(entry.sourceId) && (!previous || ["workspaceId", "relativePath", "contentHash", "status"].some(key => previous[key] !== base[key]))) sources.set(entry.sourceId, null);
      else sources.set(entry.sourceId, base);
    }
    const registry = {
      has: reference => sources.has(reference) || Boolean(context.getSource?.(reference)),
      resolve(reference) {
        if (sources.has(reference)) return sources.get(reference) || { status: "ambiguous" };
        // A saved response may contain raw stable source IDs from the old parser.
        // Resolve only exact registry identities, never a later local:N catalog
        // or an invented page/chunk handle. Existing hashes stay authoritative.
        const source = context.getSource?.(reference);
        if (!source || source.sourceId !== reference || !context.workspaceId) return { status: "missing" };
        return { sourceId: source.sourceId, relativePath: source.path, contentHash: source.contentHash,
          workspaceId: context.workspaceId, workspaceName: context.workspaceName,
          status: ["deleted", "missing", "removed", "stale", "dirty"].includes(source.catalogStatus) ? "missing" : "resolved" };
      },
    };
    return resolveAnswer(answer, registry, saved);
  }
  return Object.freeze({ relativePath, normalizeCitation, normalizeCitations, label, navigationTarget, bindToWorkspace, createRegistry, resolveAnswer, resolveForDisplay });
});
