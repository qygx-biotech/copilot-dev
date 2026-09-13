(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.BioDesignAcademicTools = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";
  const PROVIDERS = Object.freeze(["arxiv", "pubmed", "biorxiv", "medrxiv", "google_scholar", "iacr", "semantic", "crossref", "openalex", "pmc", "core", "europepmc", "dblp", "openaire", "citeseerx", "doaj", "zenodo", "hal", "ssrn"]);
  const handle = { type: "string", pattern: "^paper_[a-f0-9]{24}$" };
  const definition = (name, description, properties, required) => ({ type: "function", function: { name, description, parameters: { type: "object", additionalProperties: false, properties, required } } });
  const tools = Object.freeze([
    definition("search_academic_papers", "Search online academic literature through the desktop's local MCP server. Returns structured metadata and a cursor over a bounded candidate set, not original full-text evidence. Search does not download. Use focused queries, screen relevance, and inspect provider failures/coverage. Optional-key providers run anonymously; no credentials are used. bioRxiv/medRxiv topic discovery uses Europe PMC preprints.", {
      query: { type: "string", minLength: 1, maxLength: 1000 }, providers: { type: "array", minItems: 1, maxItems: PROVIDERS.length, items: { type: "string", enum: PROVIDERS } },
      limit: { type: "integer", minimum: 1, maximum: 20 }, per_source_limit: { type: "integer", minimum: 1, maximum: 100 },
      year_from: { type: "integer", minimum: 1600, maximum: 2200 }, year_to: { type: "integer", minimum: 1600, maximum: 2200 },
      prefer_open_access: { type: "boolean", description: "Prioritize repository PDF candidates and reported open access within the fetched results, without excluding other papers. Defaults to true for an Agent save/download request. Still screen relevance." },
      cursor: { type: "string", maxLength: 100 },
    }, ["query"]),
    definition("get_academic_paper", "Read complete cached metadata by paper_ref, or look up a supplied DOI/title. Lookup can return several candidates; select the matching paper. No files are written.", {
      paper_ref: handle, query: { type: "string", minLength: 1, maxLength: 1000 },
    }, []),
    definition("resolve_paper_full_text", "Resolve public full-text candidate locations for a previously returned paper_ref. Checks matching identifiers/title; locations remain unverified PDFs until downloaded. Does not write files.", { paper_ref: handle }, ["paper_ref"]),
    definition("download_papers", "Download up to five selected academic paper_refs as PDFs into the local project. Requires an explicit user save/download request and Agent Work workspace_write/full_access. Resolves alternative public locations and verifies PDF bytes; never counts HTML as a paper. Returns per-paper saved paths or failures. Existing ingestion runs on the next request.", {
      paper_refs: { type: "array", minItems: 1, maxItems: 5, uniqueItems: true, items: handle },
      destination: { type: "string", maxLength: 800 },
    }, ["paper_refs"]),
  ]);
  const names = new Set(tools.map(tool => tool.function.name));
  const isTool = name => names.has(name);
  const isWrite = name => name === "download_papers";
  const allowed = (name, surface, permission) => isTool(name) && surface === "agent_command" && (!isWrite(name) || ["workspace_write", "full_access"].includes(permission));
  const bad = () => { throw Object.assign(new Error("Invalid academic tool data."), { code: "INVALID_ACADEMIC_INPUT" }); };
  const plain = value => value && typeof value === "object" && !Array.isArray(value);
  const validRef = value => typeof value === "string" && /^paper_[a-f0-9]{24}$/.test(value);
  function validateInput(name, input) {
    const schema = tools.find(tool => tool.function.name === name)?.function.parameters;
    if (!schema || !plain(input) || Object.keys(input).some(key => !Object.hasOwn(schema.properties, key)) || schema.required.some(key => input[key] === undefined)) bad();
    for (const [key, value] of Object.entries(input)) {
      const rule = schema.properties[key];
      if (rule.type === "string" && (typeof value !== "string" || value.length < (rule.minLength || 1) || value.length > (rule.maxLength || 100) || (rule.pattern && !validRef(value)))) bad();
      if (rule.type === "integer" && (!Number.isInteger(value) || value < rule.minimum || value > rule.maximum)) bad();
      if (rule.type === "boolean" && typeof value !== "boolean") bad();
      if (rule.type === "array" && (!Array.isArray(value) || value.length < rule.minItems || value.length > rule.maxItems || new Set(value).size !== value.length || value.some(item => key === "providers" ? !PROVIDERS.includes(item) : !validRef(item)))) bad();
    }
    if (input.year_from && input.year_to && input.year_from > input.year_to) bad();
    if (name === "get_academic_paper" && Boolean(input.paper_ref) === Boolean(input.query)) bad();
    if (input.destination && (/[\\:\x00-\x1f\x7f]/.test(input.destination) || input.destination.split("/").some(part => !part || part.startsWith(".") || /[. ]$/.test(part)))) bad();
    return JSON.parse(JSON.stringify(input));
  }
  function validateResult(name, value) {
    if (!plain(value) || JSON.stringify(value).length > 90000 || value.version !== 1) bad();
    if (value.status === "failed") {
      if (!/^[A-Z_]{1,80}$/.test(value.error?.code || "")) bad();
      return { version: 1, status: "failed", error: { code: value.error.code } };
    }
    if (!["completed", "partial", "unavailable"].includes(value.status)) bad();
    if (name === "download_papers") {
      if (!Array.isArray(value.results) || value.results.length > 5) bad();
      for (const item of value.results) {
        if (!validRef(item.paper_ref) || !["downloaded", "failed"].includes(item.status)) bad();
        if (item.status === "downloaded" && (item.contentType !== "application/pdf" || typeof item.path !== "string" || item.path.length > 1000 || /[\\:\x00-\x1f]/.test(item.path) || item.path.split("/").some(part => !part || part.startsWith(".")))) bad();
      }
    } else {
      if (!Array.isArray(value.papers) || value.papers.length > 20) bad();
      for (const paper of value.papers) if (!plain(paper) || !validRef(paper.paper_ref) || typeof paper.title !== "string" || !Array.isArray(paper.authors) || !Array.isArray(paper.locations) || !Array.isArray(paper.providers)) bad();
    }
    return JSON.parse(JSON.stringify(value));
  }
  const failure = code => ({ version: 1, status: "failed", error: { code: /^[A-Z_]{1,80}$/.test(code || "") ? code : "ACADEMIC_TOOL_FAILED" } });
  return Object.freeze({ PROVIDERS, tools, isTool, isWrite, allowed, validRef, validateInput, validateResult, failure });
});
