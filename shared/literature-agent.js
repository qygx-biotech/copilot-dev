(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.BioDesignLiteratureAgent = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  const text = (maxLength = 1000) => ({ type: 'string', minLength: 1, maxLength });
  const array = (items, maxItems, minItems = 0) => ({ type: 'array', items, minItems, maxItems });
  const object = (properties, required = Object.keys(properties)) => ({ type: 'object', properties, required, additionalProperties: false });
  const enumeration = values => ({ type: 'string', enum: values });
  const versions = ['published', 'accepted_manuscript', 'preprint', 'unknown'];
  const statuses = ['already_present', 'downloaded', 'needs_login', 'access_unavailable', 'unresolved', 'downloaded_unverified', 'failed', 'cancelled'];
  const identity = object({ title: text(1000), authors: array(text(200), 50), year: { type: 'integer', minimum: 1600, maximum: 2200 }, doi: text(300), paper_ref: { ...text(30), pattern: '^paper_[a-f0-9]{24}$' }, language: text(100), source_urls: array(text(4096), 12), identifiers: object({ pmid: text(100), pmcid: text(100), arxiv: text(100) }, []) }, ['title', 'authors', 'source_urls']);
  const tasks = {
    discover_papers: object({ objective: text(4000), queries: array(text(1000), 6, 1), limit: { type: 'integer', minimum: 1, maximum: 40 }, library_url: text(4096) }, ['objective', 'queries']),
    retrieve_papers: object({ papers: array(identity, 5, 1), accepted_versions: array(enumeration(versions), 4, 1), destination: text(800), library_url: text(4096) }, ['papers', 'accepted_versions']),
  };
  for (const task of Object.values(tasks)) task.properties.job_id = { ...text(28), pattern: '^lit_[a-f0-9]{24}$' };
  const candidate = object({ identity, rationale: text(2000), availability: enumeration(['unknown', 'open_access', 'institutional', 'restricted']), evidence: enumeration(['metadata', 'abstract', 'full_text']), translated_title: text(1000), provenance: array(text(4096), 12, 1) }, ['identity', 'rationale', 'availability', 'evidence', 'provenance']);
  const attempt = object({ route: enumeration(['local', 'open_access', 'institutional']), reason: text(1000), source_url: text(4096) }, ['route', 'reason']);
  const receipt = object({ sha256: { ...text(64), pattern: '^[a-f0-9]{64}$' }, bytes: { type: 'integer', minimum: 1 }, pages: { type: 'integer', minimum: 1 }, identity: enumeration(['doi', 'title_authors_year', 'unverified']), version: enumeration(versions), version_accepted: { type: 'boolean' }, verified_at: text(100), transfer_complete: { type: 'boolean' }, parsed: { type: 'boolean' } });
  const retrieval = object({ requested: identity, status: enumeration(statuses), route: enumeration(['local', 'open_access', 'institutional']), file: text(1000), source_url: text(4096), document_version: enumeration(versions), verification: receipt, attempts: array(attempt, 24), reason: text(1000), ingestion: enumeration(['pending', 'not_ingested', 'existing']), job_id: text(100) }, ['requested', 'status', 'document_version', 'attempts', 'reason']);
  const results = {
    discover_papers: object({ version: { const: 1 }, candidates: array(candidate, 40), searches: array(object({ query: text(1000), source: text(4096) }), 30), limitations: array(text(2000), 30), job_id: text(100), status: enumeration(['completed', 'partial', 'needs_login', 'cancelled', 'failed']) }),
    retrieve_papers: object({ version: { const: 1 }, results: array(retrieval, 5), limitations: array(text(2000), 30), job_id: text(100), status: enumeration(['completed', 'partial', 'needs_login', 'cancelled', 'failed']) }),
  };
  function validate(schema, value, location = 'input') {
    const fail = () => { throw Object.assign(new Error(`Invalid literature contract at ${location}`), { code: 'INVALID_LITERATURE_CONTRACT' }); };
    if (schema.const !== undefined && value !== schema.const) fail();
    if (schema.enum && !schema.enum.includes(value)) fail();
    if (schema.type === 'object') {
      if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !Object.hasOwn(schema.properties, key))) fail();
      if ((schema.required || []).some(key => !Object.hasOwn(value, key))) fail();
      for (const [key, item] of Object.entries(value)) validate(schema.properties[key], item, `${location}.${key}`);
    }
    if (schema.type === 'array') {
      if (!Array.isArray(value) || value.length < (schema.minItems || 0) || value.length > schema.maxItems) fail();
      value.forEach((item, index) => validate(schema.items, item, `${location}[${index}]`));
    }
    if (schema.type === 'string' && (typeof value !== 'string' || value.length < (schema.minLength || 0) || value.length > (schema.maxLength || Infinity) || (schema.pattern && !new RegExp(schema.pattern).test(value)))) fail();
    if (schema.type === 'integer' && (!Number.isInteger(value) || value < (schema.minimum ?? -Infinity) || value > (schema.maximum ?? Infinity))) fail();
    if (schema.type === 'boolean' && typeof value !== 'boolean') fail();
    return value;
  }
  const tool = (name, description, parameters) => ({ type: 'function', function: { name, description, parameters } });
  const tools = [tool('discover_papers', 'Delegate bounded literature discovery in a separate context. Searches metadata broadly, including institutional catalogues; never downloads. Returns candidates, provenance and coverage gaps. Use only when useful for the user objective.', tasks.discover_papers), tool('retrieve_papers', 'Delegate retrieval of exact selected paper identities. Requires existing explicit download authorization and workspace write permission. Returns host-verified per-paper outcomes, not scientific analysis. Never substitutes a different paper.', tasks.retrieve_papers)];
  const safeUrl = value => { try { const u = new URL(value); if (!['http:', 'https:'].includes(u.protocol) || u.username || u.password) return ''; u.search = ''; u.hash = ''; return u.href; } catch { return ''; } };
  const doi = value => String(value || '').trim().replace(/^(?:https?:\/\/(?:dx\.)?doi\.org\/|doi:\s*)/i, '').toLowerCase();
  const key = paper => doi(paper.doi) || (paper.identifiers?.pmid ? `pmid:${paper.identifiers.pmid}` : paper.identifiers?.arxiv ? `arxiv:${paper.identifiers.arxiv}` : JSON.stringify([paper.title.normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim(), paper.authors, paper.year]));
  const deduplicate = candidates => { const found = new Map(); for (const c of candidates) { const id = key(c.identity); if (!found.has(id)) found.set(id, c); else { const old = found.get(id); old.provenance = [...new Set([...old.provenance, ...c.provenance])].slice(0, 12); } } return [...found.values()]; };
  function downloadAuthorized(request) {
    const value = String(request || '');
    if (/\b(?:do not|don't|never|without|no need to)\s+(?:\w+\s+){0,2}(?:download|save)|\bno downloads\b|(?:不要|无需|不必|禁止|别).{0,12}(?:下载|保存)/i.test(value)) return false;
    return /(?:^|[.!?;\n]|\b(?:and|then|please|can you|could you|want you to|need you to))\s*(?:please\s+)?(?:download|save)\b[^.!?\n]{0,120}\b(?:papers?|pdfs?|sources?|files?)\b|(?:^|[，。；\n]|并|请)(?:帮我|把|将)?[^。\n]{0,30}(?:(?:下载|保存)[^。\n]{0,60}(?:论文|文献|文章|PDF|文件)|(?:论文|文献|文章|PDF|文件)[^。\n]{0,30}(?:下载|保存))/i.test(value);
  }
  return { tasks, results, identity, candidate, receipt, retrieval, tools, validate, tool, object, array, text, enumeration, safeUrl, doi, key, deduplicate, downloadAuthorized, statuses, versions, isTool: name => Object.hasOwn(tasks, name) };
});
