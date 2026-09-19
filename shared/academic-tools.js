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
    definition("search_academic_papers", "Collect a bounded comparison pool of up to 20 deduplicated academic papers through the desktop's local MCP server. Returns metadata, not full-text evidence; does not download. Normal flow: plan, collect candidate pool, select, download. A next_cursor is optional: search further only if relevance, evidence, count or coverage is insufficient, preserving original search arguments for a cursor. Inspect provider failures/coverage. Optional-key providers run anonymously; no credentials are used. bioRxiv/medRxiv topic discovery uses Europe PMC preprints.", {
      query: { type: "string", minLength: 1, maxLength: 1000 }, providers: { type: "array", minItems: 1, maxItems: PROVIDERS.length, items: { type: "string", enum: PROVIDERS } },
      queries: { type: "array", minItems: 1, maxItems: 3, uniqueItems: true, items: { type: "string", minLength: 1, maxLength: 1000 }, description: "Up to three distinct complementary queries in addition to query. Exact duplicates are removed; omit this field when none remain. All queries share one 35-second provider budget and one deduplicated, interleaved result pool. Preserve these arguments when paging." },
      limit: { type: "integer", minimum: 1, maximum: 20, description: "Slice size for explicit cursor requests. Initial discovery fills a comparison pool of up to 20 cached candidates, subject to the response-size budget, even when a smaller slice is requested." }, per_source_limit: { type: "integer", minimum: 1, maximum: 100 },
      year_from: { type: "integer", minimum: 1600, maximum: 2200 }, year_to: { type: "integer", minimum: 1600, maximum: 2200 },
      prefer_open_access: { type: "boolean", description: "Optional availability-first browsing. Defaults to false: compare titles/abstracts for relevance and coverage before using availability as a selection tie-breaker." },
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
  const bad = (details = {}) => { throw Object.assign(new Error("Invalid academic tool data."), { code: "INVALID_ACADEMIC_INPUT", details }); };
  const plain = value => value && typeof value === "object" && !Array.isArray(value);
  const validRef = value => typeof value === "string" && /^paper_[a-f0-9]{24}$/.test(value);
  function normalizeSearchInput(input) {
    if (!plain(input)) return input;
    const normalized = { ...input };
    if (Array.isArray(input.queries)) {
      const seen = new Set(typeof input.query === "string" ? [input.query] : []);
      normalized.queries = input.queries.filter(query => {
        // Only exact string equality is safe. Keep case, whitespace, Boolean
        // syntax and invalid non-string values for the validator to inspect.
        if (typeof query !== "string") return true;
        if (seen.has(query)) return false;
        seen.add(query); return true;
      });
      if (!normalized.queries.length) delete normalized.queries;
    }
    return normalized;
  }
  function validateInput(name, input) {
    const schema = tools.find(tool => tool.function.name === name)?.function.parameters;
    const invalid = (field, value, correction, extra = {}) => bad({ field, invalid_value: value ?? null, required_correction: correction, required_tool: name, ...extra });
    if (!schema) invalid("tool", name, "Use an exposed academic tool.", { allowed_values: [...names] });
    if (!plain(input)) invalid("arguments", input, "Supply a JSON object using the exposed tool schema.");
    if (name === "search_academic_papers") input = normalizeSearchInput(input);
    for (const key of Object.keys(input)) if (!Object.hasOwn(schema.properties, key)) invalid(key, input[key], `Remove the unsupported field ${key}; use only fields in the tool schema.`, { allowed_fields: Object.keys(schema.properties) });
    for (const key of schema.required) if (input[key] === undefined) invalid(key, null, `Supply the required ${key} field from the accepted plan or returned paper metadata.`);
    for (const [key, value] of Object.entries(input)) {
      const rule = schema.properties[key];
      if (rule.type === "string" && (typeof value !== "string" || !value.trim() || value.length < (rule.minLength || 1) || value.length > (rule.maxLength || 100) || (rule.pattern && !validRef(value)))) invalid(key, value,
        rule.pattern ? "Use a paper_ref returned by an academic tool." : `Supply a nonempty string of at most ${rule.maxLength || 100} characters for ${key}; preserve the intended query and filters.`);
      if (rule.type === "integer" && (!Number.isInteger(value) || value < rule.minimum || value > rule.maximum)) invalid(key, value, `Use an integer from ${rule.minimum} to ${rule.maximum} for ${key}.`, { minimum: rule.minimum, maximum: rule.maximum });
      if (rule.type === "boolean" && typeof value !== "boolean") invalid(key, value, `Use the JSON boolean true or false for ${key}, not a quoted string.`, { allowed_values: [true, false] });
      if (rule.type === "array") {
        if (!Array.isArray(value) || value.length < rule.minItems || value.length > rule.maxItems) invalid(key, value, `Supply ${rule.minItems}–${rule.maxItems} entries for ${key}; query limits apply after exact duplicate removal.`, { min_items: rule.minItems, max_items: rule.maxItems });
        if (new Set(value).size !== value.length) invalid(key, value, `Remove exact duplicate entries from ${key}.`);
        for (const [index, item] of value.entries()) {
          if (key === "providers" && !PROVIDERS.includes(item)) invalid(`${key}[${index}]`, item, "Choose a provider from allowed_values or omit providers to use the defaults.", { allowed_values: PROVIDERS });
          if (key === "queries" && (typeof item !== "string" || !item.trim() || item.length > 1000)) invalid(`${key}[${index}]`, item, "Supply a nonempty query string of at most 1000 characters; preserve the intended search meaning.");
          if (key === "paper_refs" && !validRef(item)) invalid(`${key}[${index}]`, item, "Use a paper_ref returned by an academic tool.");
        }
      }
    }
    if (input.year_from && input.year_to && input.year_from > input.year_to) invalid("year_to", input.year_to, "Use the accepted plan's date range with year_to at least year_from; do not change the user's date constraints.", { minimum: input.year_from });
    if (input.queries && (input.queries.length + 1) * (input.providers?.length || 5) > 20) invalid("queries", input.queries, "Reduce the number of complementary queries or providers so (1 + queries.length) × provider count is at most 20. Keep the intended topics and filters; do not truncate query text.", { maximum_provider_query_jobs: 20, provider_count: input.providers?.length || 5 });
    if (name === "get_academic_paper" && Boolean(input.paper_ref) === Boolean(input.query)) invalid("paper_ref/query", input, "Supply exactly one of paper_ref or query.");
    if (input.destination && (/[\\:\x00-\x1f\x7f]/.test(input.destination) || input.destination.split("/").some(part => !part || part.startsWith(".") || /[. ]$/.test(part)))) invalid("destination", input.destination, "Use a relative folder inside the project without hidden segments, traversal, backslashes or control characters.");
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
  return Object.freeze({ PROVIDERS, tools, isTool, isWrite, allowed, validRef, normalizeSearchInput, validateInput, validateResult, failure });
});
