(function expose(root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.BioDesignSideChatTools = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";
  const fail = code => Object.assign(new Error(code), { code });
  /**
   * @typedef {Object} EvidenceRequirement
   * @property {'lookup'|'overview'|'explanation'|'comparison'|'synthesis'|'literature_review'|'source_verification'} task
   * @property {string[]} domains Domain registry is extensible; only literature is enabled.
   * @property {{type:'project'|'single_source'|'selected_sources'|'corpus', sourceIds:string[]}} scope
   * @property {'targeted'|'relevant'|'broad'|'exhaustive'} coverage
   * @property {'metadata'|'overview'|'concept'|'section'|'page'|'passage'|'claim_support'} granularity
   * @property {'current'} freshness
   * @property {'not_required'|'as_needed'|'required'} claimSupport
   *
   * @typedef {Object} EvidenceBundle
   * @property {1} version
   * @property {EvidenceRequirement} resolvedRequirement
   * @property {EvidenceRequirement['scope']} scope Authoritative resolved source IDs.
   * @property {Object} coverage requested/included/analyzed/failed/missing; complete only for measured corpus work.
   * @property {EvidenceItem[]} items
   * @property {string[]} gaps
   * @property {string[]} escalationHints
   * @property {'needs_original_evidence'|'agent_must_assess'} sufficiency No automatic scientific truth verdict.
   *
   * @typedef {Object} EvidenceItem
   * @property {string[]} sourceIds Stable registry identities (multiple for cross-source artifacts).
   * @property {string} [artifactId] Stable saved artifact identity, never a citation target.
   * @property {'metadata'|'paper_card'|'wiki'|'historical_synthesis'|'original_passage'|'original_section'|'original_page'|'other'} evidenceKind
   * @property {boolean} derived
   * @property {boolean} current Dependency/configuration currentness, not claim verification.
   * @property {string} content Bounded excerpt; legacy tool fields retain fuller content.
   * @property {boolean} [truncated]
   * @property {{sourceVersions:Object<string,string>,cardIdentity?:string,generation?:Object}} provenance
   * @property {Array<{sourceId:string,reference:string,page:number,contentHash:string}>} references Existing citationEvidence records only.
   */
  const enums = {
    task: ['lookup', 'overview', 'explanation', 'comparison', 'synthesis', 'literature_review', 'source_verification'],
    coverage: ['targeted', 'relevant', 'broad', 'exhaustive'],
    granularity: ['metadata', 'overview', 'concept', 'section', 'page', 'passage', 'claim_support'],
    freshness: ['current'], claimSupport: ['not_required', 'as_needed', 'required'],
  };
  const idList = { description: 'Stable registry sourceId/paper_id values from the current catalog; not item_id handles or citation targets.', type: 'array', maxItems: 8, uniqueItems: true, items: { type: 'string', pattern: '^[\\w.:-]{1,200}$' } };
  const requirementSchema = { type: 'object', additionalProperties: false, properties: {
    ...Object.fromEntries(Object.entries(enums).map(([key, values]) => [key, { type: 'string', enum: values }])),
    domains: { type: 'array', minItems: 1, maxItems: 1, uniqueItems: true, items: { enum: ['literature'] } },
    scope: { type: 'object', additionalProperties: false, properties: {
      type: { enum: ['project', 'single_source', 'selected_sources', 'corpus'] }, sourceIds: idList,
    } },
  } };
  // Corpus membership, exhaustive coverage and currentness belong to the host.
  // The broader internal schema remains accepted for saved legacy tool calls.
  const corpusRequirementSchema = { type: 'object', additionalProperties: false, properties:
    Object.fromEntries(['task', 'domains', 'granularity', 'claimSupport'].map(key => [key, requirementSchema.properties[key]])) };
  const validIds = ids => Array.isArray(ids) && ids.length <= 8 && ids.every(id => typeof id === 'string' && /^[\w.:-]{1,200}$/.test(id)) && new Set(ids).size === ids.length;
  function normalizeRequirement(name, value = {}, ids = []) {
    if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !Object.hasOwn(requirementSchema.properties, key))) throw fail('INVALID_EVIDENCE_REQUIREMENT');
    for (const [key, values] of Object.entries(enums)) if (value[key] !== undefined && !values.includes(value[key])) throw fail('INVALID_EVIDENCE_REQUIREMENT');
    if (value.domains !== undefined && (!Array.isArray(value.domains) || value.domains.length !== 1 || value.domains[0] !== 'literature')) throw fail('UNSUPPORTED_EVIDENCE_DOMAIN');
    const scope = value.scope || {};
    if (typeof scope !== 'object' || Array.isArray(scope) || Object.keys(scope).some(key => !['type', 'sourceIds'].includes(key)) ||
        (scope.type !== undefined && !requirementSchema.properties.scope.properties.type.enum.includes(scope.type)) ||
        (scope.sourceIds !== undefined && !validIds(scope.sourceIds))) throw fail('INVALID_EVIDENCE_SCOPE');
    if (scope.sourceIds && ids.length && (scope.sourceIds.length !== ids.length || ids.some(id => !scope.sourceIds.includes(id)))) throw fail('CONFLICTING_EVIDENCE_SCOPE');
    const sourceIds = scope.sourceIds || ids;
    if ((scope.type === 'single_source' && sourceIds.length !== 1) || (scope.type === 'selected_sources' && !sourceIds.length)) throw fail('INVALID_EVIDENCE_SCOPE');
    const corpus = name === 'run_corpus_workflow', original = name === 'retrieve_project_evidence';
    const granularity = value.granularity || (original ? 'passage' : 'overview');
    return { task: value.task || (corpus ? 'literature_review' : original ? 'lookup' : 'overview'), domains: value.domains || ['literature'],
      scope: { type: scope.type || (corpus ? 'corpus' : sourceIds.length === 1 ? 'single_source' : sourceIds.length ? 'selected_sources' : 'project'), sourceIds: [...sourceIds] },
      coverage: corpus ? 'exhaustive' : value.coverage || (scope.type === 'corpus' ? 'exhaustive' : original ? 'targeted' : 'relevant'), granularity, freshness: 'current',
      claimSupport: ['section', 'page', 'passage', 'claim_support'].includes(granularity) || value.task === 'source_verification' ? 'required' : value.claimSupport || 'as_needed' };
  }
  function resolveRequirement(name, args, allowedIds, hardSelection = false) {
    const requirement = normalizeRequirement(name, args.requirement, args.paper_ids || []);
    const requested = requirement.scope.sourceIds;
    if (requested.some(id => !allowedIds.includes(id))) throw fail('SOURCE_OUTSIDE_SCOPE');
    // Legacy IDs are validated above (and by resolveArguments before this call),
    // but never define membership of an exhaustive host-owned snapshot.
    requirement.scope.sourceIds = name === 'run_corpus_workflow' ? [...allowedIds] : requested.length ? requested : [...allowedIds];
    if (name === 'run_corpus_workflow') requirement.scope.type = 'corpus';
    else if (hardSelection && !requested.length) requirement.scope.type = 'selected_sources';
    return requirement;
  }
  function corpusScopeResolution(args, requirement, hardSelection) {
    const requested = args.requirement?.scope?.sourceIds || [];
    return { scopeOrigin: hardSelection ? 'user_selection' : 'project',
      authoritativeSourceCount: requirement.scope.sourceIds.length,
      legacyArgumentsNormalized: requested.length > 0, legacyRequestedCount: requested.length,
      resolvedSourceCount: requirement.scope.sourceIds.length,
      ...(requested.length ? { normalization: 'Legacy enumeration validated and replaced by the complete host-authorized scope.' } : {}) };
  }
  // Only host-owned bindings from this request may resolve catalog handles.
  // Never infer a paper from a path/title, suffix, artifact or old namespace.
  const identityMessages = {
    SOURCE_IDENTIFIER_UNKNOWN: 'Unknown paper identifier. Copy a stable sourceId/paper_id from the current catalog.',
    SOURCE_HANDLE_EXPIRED: 'This item handle is historical or expired. Use a stable sourceId from the current catalog.',
    SOURCE_IDENTIFIER_AMBIGUOUS: 'This identifier has multiple bindings. Use the stable sourceId.',
    SOURCE_IDENTIFIER_NOT_PAPER: 'This handle identifies an artifact, not a paper. Use its contributing stable source IDs.',
    SOURCE_IDENTIFIER_MISMATCH: 'The supplied identifiers refer to different papers.',
    SOURCE_OUTSIDE_SCOPE: 'The requested paper is outside the permitted source scope.',
    SOURCE_VERSION_CHANGED: 'The source changed since this request was prepared. Start a new request to reconcile it.',
    SOURCE_DELETED: 'The requested source is no longer available. Refresh the source scope.',
    SOURCE_SCOPE_UNRESOLVED: 'The user selection could not be resolved completely. Refresh or reselect the intended papers.',
  };
  function identityError(code) { return Object.assign(new Error(identityMessages[code] || code), { code }); }
  function resolveSourceId(identifier, { sources = [], allowedIds = [], handles = [], namespace = '' } = {}) {
    let sourceId = identifier, binding;
    const stable = sources.filter(source => source.sourceId === identifier);
    if (stable.length > 1) throw identityError('SOURCE_IDENTIFIER_AMBIGUOUS');
    if (!stable.length) {
      if (/^turn_[^:]+:/.test(identifier) && (!namespace || !identifier.startsWith(namespace + ':'))) throw identityError('SOURCE_HANDLE_EXPIRED');
      const matches = handles.filter(item => item.itemId === identifier);
      if (matches.length > 1) throw identityError('SOURCE_IDENTIFIER_AMBIGUOUS');
      if (!matches.length) throw identityError(/^local:/.test(identifier) || (/^turn_[^:]+:/.test(identifier) && !namespace) ? 'SOURCE_HANDLE_EXPIRED' : 'SOURCE_IDENTIFIER_UNKNOWN');
      binding = matches[0];
      if (binding.kind !== 'paper' || !binding.sourceId) throw identityError('SOURCE_IDENTIFIER_NOT_PAPER');
      sourceId = binding.sourceId;
    }
    // Scope denial does not disclose the target's metadata/version/readiness.
    if (!allowedIds.includes(sourceId)) throw identityError('SOURCE_OUTSIDE_SCOPE');
    const source = sources.find(item => item.sourceId === sourceId);
    if (!source || ['missing', 'deleted', 'removed'].includes(source.catalogStatus)) throw identityError('SOURCE_DELETED');
    if (['dirty', 'stale'].includes(source.catalogStatus) || source.hashStatus === 'dirty' ||
        (binding && (!binding.contentHash || binding.contentHash !== source.contentHash))) throw identityError('SOURCE_VERSION_CHANGED');
    return sourceId;
  }
  function resolveArguments(name, args, identity) {
    if (name === 'read_paper_evidence') {
      const ids = [args.paper_id, args.item_id].filter(Boolean).map(id => resolveSourceId(id, identity));
      if (new Set(ids).size !== 1) throw identityError('SOURCE_IDENTIFIER_MISMATCH');
      return { ...args, paper_id: ids[0], ...(args.item_id ? { item_id: ids[0] } : {}) };
    }
    const resolved = { ...args };
    if (args.paper_ids) resolved.paper_ids = [...new Set(args.paper_ids.map(id => resolveSourceId(id, identity)))];
    if (args.requirement) resolved.requirement = { ...args.requirement, scope: { ...args.requirement.scope,
      sourceIds: [...new Set((args.requirement.scope?.sourceIds || []).map(id => resolveSourceId(id, identity)))] } };
    return resolved;
  }
  function evidenceArguments(name, args) {
    return name === 'read_paper_evidence' ? { ...args, query: args.query || '', paper_ids: [args.paper_id],
      requirement: normalizeRequirement('retrieve_project_evidence', { scope: { type: 'single_source', sourceIds: [args.paper_id] }, claimSupport: 'required' }) } : args;
  }
  // Lexical hints only: no classification/provider request and no absence inference.
  function evidenceTerms(query) {
    const stop = new Set(['the', 'this', 'that', 'these', 'those', 'paper', 'papers', 'does', 'did', 'what', 'which', 'where', 'was', 'were', 'are', 'has', 'have', 'provide', 'use', 'used', 'according', 'all', 'and', 'for', 'from', 'with', 'about']);
    const terms = (String(query).toLowerCase().match(/[\p{L}\p{N}]{2,}/gu) || []).filter(term => !stop.has(term));
    if (/source code|code availability|software|github|repository|源码|源代码|代码/i.test(query)) terms.push('code availability', 'software availability', 'implementation', 'github', 'repository', 'data availability', 'supplementary', 'source code');
    if (/temperature|温度/i.test(query)) terms.push('temperature');
    if (/酸碱度|ph值/i.test(query)) terms.push('ph');
    return [...new Set(terms)];
  }
  // Whole lexical terms keep short scientific tokens (e.g. pH) from matching
  // unrelated words (e.g. chromatography). CJK retains substring matching.
  function evidenceScore(text, terms) {
    let lower = String(text || '').toLowerCase();
    // Unit-only reports remain discoverable without returning arbitrary fallback
    // chunks. This is a locator hint, not a claim about the reported condition.
    if (/-?\d+(?:\.\d+)?\s*(?:°\s*[cf]\b|[cf]\b|℃|℉|degrees?\s*(?:celsius|fahrenheit))/i.test(lower)) lower += ' temperature';
    const words = ' ' + (lower.match(/[\p{L}\p{N}]+/gu) || []).join(' ') + ' ';
    return terms.reduce((score, term) => score + (/\p{Script=Han}/u.test(term)
      ? lower.includes(term) : words.includes(' ' + term + ' ') ? 1 : 0), 0);
  }
  // Local locator signals, not a classifier call or scientific verification.
  function evidenceQuery(query, source = {}) {
    const name = String(source.displayName || '').replace(/\.pdf$/i, '');
    const identity = name.split(/[\s_-]+/)[0]?.toLowerCase() || '';
    const availability = /source code|code availability|software|repository|github|源码|源代码|代码|仓库|开源|data availability|数据可用|数据.{0,8}(公开|获取)/i.test(query);
    const terms = evidenceTerms(query).filter(term => term !== identity && term !== name.toLowerCase());
    if (availability) terms.push('code availability', 'software availability', 'data availability', 'repository', 'github');
    return { terms: [...new Set(terms)], identity, availability, requiresUrl: /repository|github|\burl\b|链接|地址|仓库/i.test(query) };
  }
  function evidenceMatch(text, query) {
    const lower = text.toLowerCase(), signals = [];
    for (const term of query.terms) {
      let offset = 0, index;
      while ((index = lower.indexOf(term, offset)) >= 0) {
        if (/\p{Script=Han}/u.test(term) || !/[\p{L}\p{N}]/u.test(lower[index - 1] || '') && !/[\p{L}\p{N}]/u.test(lower[index + term.length] || ''))
          signals.push({ start: index, end: index + term.length, weight: 1, kind: 'term' });
        offset = index + term.length;
        if (signals.length >= 100) break;
      }
    }
    const statements = [...text.matchAll(/(?:code|software|data)\s+availability|(?:source\s+code|software|dataset|code|data)[^\n.]{0,100}\b(?:available|released|provided|accessible)\b/gi)];
    if (query.availability) {
      for (const match of statements) signals.push({ start: match.index, end: match.index + match[0].length, weight: 20, kind: 'availability_statement' });
      for (const match of text.matchAll(/https?:\/\/[^\s<>"'\\]+/gi)) {
        const url = match[0], around = text.slice(Math.max(0, match.index - 250), match.index);
        const named = query.identity && url.toLowerCase().includes(query.identity);
        const repository = /github\.com|gitlab\.com|bitbucket\.org|zenodo\.org/i.test(url);
        const other = !named && repository && /baseline|compar(?:e|ed|ison)|other\s+method|codes?\s+and\s+weights/i.test(around);
        const explicit = !other && statements.some(item => Math.abs(match.index - item.index) < 500);
        if (repository || explicit) signals.push({ start: match.index, end: match.index + url.length,
          weight: named ? 50 : explicit ? 35 : other ? 2 : 8,
          kind: named ? 'target_named_repository' : explicit ? 'availability_repository_candidate' : other ? 'other_method_repository' : 'unattributed_repository' });
      }
    }
    const repositories = signals.filter(signal => /repository/.test(signal.kind));
    if (repositories.length && repositories.every(signal => signal.kind === 'other_method_repository')) {
      for (const signal of signals) if (signal.kind === 'availability_statement') { signal.kind = 'other_method_repository'; signal.weight = 2; }
    }
    signals.sort((a, b) => b.weight - a.weight || a.start - b.start);
    const best = signals[0];
    return { score: evidenceScore(text, query.terms) + (best?.weight || 0),
      match: best || null, availabilityKind: query.availability ? best?.kind || 'not_located' : null };
  }
  // Derived-evidence sufficiency follows the evidence contract, not question
  // keywords. It does not require a classifier or a reasoning worker.
  function cardProjectionIsSufficient(requirement) {
    return requirement.claimSupport !== 'required' && ['overview', 'metadata'].includes(requirement.granularity) &&
      !['explanation', 'source_verification'].includes(requirement.task);
  }
  const definitions = [
    { type: "function", function: { name: "search_project_knowledge", description: "Search cached Paper Cards, eligible Wiki content, metadata and compatible saved syntheses within the resolved hard scope. Returns stable source IDs, currentness, provenance and gaps. Unverified drafts are labeled; stale synthesis prose is excluded. Missing cards do not disable original evidence. No card/wiki generation, automatic raw-paper reads or exhaustive-coverage claim.", parameters: { type: "object", properties: { query: { type: "string", minLength: 1, maxLength: 2000 }, paper_ids: { type: "array", maxItems: 8, items: { type: "string" } } }, required: ["query"], additionalProperties: false } } },
    { type: "function", function: { name: "retrieve_project_evidence", description: "Retrieve current original evidence from the local project host, even when the initial context contains only metadata. Use stable registry sourceId/paper_id values; omit paper_ids to search within the hard selection. Supports page, section, passage and claim support; reuses or prepares local extraction without generating Paper Cards. Returns exact citation references, versions and gaps. No matches does not establish absence; bounded retrieval is not full-corpus coverage.", parameters: { type: "object", properties: { query: { type: "string", minLength: 1, maxLength: 2000 }, paper_ids: { type: "array", maxItems: 8, items: { type: "string" } } }, required: ["query"], additionalProperties: false } } },
    { type: "function", function: { name: "run_corpus_workflow", description: "The host resolves every paper in the current user-authorized scope: the explicit user selection, otherwise the project. Request the analysis; do not enumerate corpus membership. Required for complete-corpus reviews. Collects current evidence locally, reuses cached work and returns measured coverage, failures, gaps and evidence for your final synthesis. No per-paper LLM mapping calls. Preserves the original request, including summarization AND review writing; only derived project knowledge is updated.", parameters: { type: "object", properties: {}, additionalProperties: false } } },
  ];
  for (const tool of definitions) {
    const corpus = tool.function.name === 'run_corpus_workflow';
    tool.function.parameters.properties.requirement = corpus ? corpusRequirementSchema : requirementSchema;
    if (tool.function.parameters.properties.paper_ids) tool.function.parameters.properties.paper_ids = idList;
    tool.function.description += corpus ? " Optionally describe task, granularity and claim support in requirement. Coverage is exhaustive and freshness is current, enforced by the host."
      : " Optionally describe the needed scope, coverage, granularity and claim support in requirement. Results include an evidenceBundle with provenance, gaps and refinement hints.";
  }
  definitions[0].function.description = "Search cached project knowledge for orientation or concepts, only when the answer depends on the project. Precise claims need current original evidence; missing derived knowledge never makes a source unusable. Never regenerates knowledge. " + definitions[0].function.description;
  definitions[2].function.description += " Use overview granularity for general orientation; use concept for query-conditioned relationships and claim_support for precise support. Collection is deterministic and bounded. Use the returned original evidence and current derived context to synthesize all requested actions in your next answer.";
  definitions[1].function.description += ' Original passages default to 30,000 characters per paper; aggregate and serialization limits may allocate smaller equal shares, reported explicitly. EvidenceBundle text is a preview; files[].content contains the full returned evidence.';
  definitions[1].function.parameters.properties.max_characters = { type: 'integer', minimum: 200, maximum: 30000, description: 'Optional lower per-paper bound including citation markers; default 30000, subject to reported aggregate allocation.' };
  definitions[1].function.parameters.properties.page = { type: 'integer', minimum: 1, maximum: 100000 };
  definitions[1].function.parameters.properties.section = { type: 'string', minLength: 1, maxLength: 200 };
  const isTool = name => name === "read_paper_evidence" || definitions.some(tool => tool.function.name === name);
  function validate(name, args) {
    if (!isTool(name) || !args || typeof args !== "object" || Array.isArray(args)) throw fail("INVALID_PROJECT_TOOL");
    if (name === "read_paper_evidence") {
      if (Object.keys(args).some(key => !['paper_id', 'item_id', 'evidence_ref', 'query', 'offset', 'max_characters'].includes(key)) ||
          ![args.paper_id, args.item_id].some(id => typeof id === 'string' && id.length) ||
          ['paper_id', 'item_id'].some(key => args[key] !== undefined && (typeof args[key] !== 'string' || !/^[\w.:-]{1,200}$/.test(args[key]))) ||
          ['query', 'evidence_ref'].some(key => args[key] !== undefined && (typeof args[key] !== 'string' || args[key].length > 500)) ||
          (args.offset !== undefined && (!Number.isSafeInteger(args.offset) || args.offset < 0 || args.offset > 10000000)) ||
          (args.max_characters !== undefined && (!Number.isInteger(args.max_characters) || args.max_characters < 200 || args.max_characters > 16000))) throw fail('INVALID_PROJECT_TOOL_INPUT');
      return { ...args };
    }
    if (name === "run_corpus_workflow") {
      if (Object.keys(args).some(key => key !== "requirement")) throw fail("INVALID_PROJECT_TOOL_INPUT");
      return args.requirement === undefined ? {} : { requirement: normalizeRequirement(name, args.requirement) };
    }
    if (Object.keys(args).some(key => !["query", "paper_ids", "requirement", ...(name === "retrieve_project_evidence" ? ["page", "section", "max_characters"] : [])].includes(key)) || typeof args.query !== "string" || !args.query.trim() || args.query.length > 2000 ||
        (args.paper_ids !== undefined && (!Array.isArray(args.paper_ids) || args.paper_ids.length > 8 || args.paper_ids.some(id => typeof id !== "string" || !/^[\w.:-]{1,200}$/.test(id)) || new Set(args.paper_ids).size !== args.paper_ids.length))) throw fail("INVALID_PROJECT_TOOL_INPUT");
    if ((args.max_characters !== undefined && (!Number.isInteger(args.max_characters) || args.max_characters < 200 || args.max_characters > 30000)) || (args.page !== undefined && (!Number.isInteger(args.page) || args.page < 1 || args.page > 100000)) || (args.section !== undefined && (typeof args.section !== 'string' || !args.section.trim() || args.section.length > 200))) throw fail('INVALID_PROJECT_TOOL_INPUT');
    const requirement = normalizeRequirement(name, args.requirement, args.paper_ids || []);
    return { query: args.query, paper_ids: requirement.scope.sourceIds,
      ...(args.requirement === undefined ? {} : { requirement }),
      ...(args.max_characters === undefined ? {} : { max_characters: args.max_characters }),
      ...(args.page === undefined ? {} : { page: args.page }), ...(args.section === undefined ? {} : { section: args.section }) };

  }
  function bundle(requirement, { items = [], coverage = {}, gaps = [], escalationHints = [] } = {}) {
    const original = items.some(item => item.current && !item.derived && item.evidenceKind !== 'metadata' && item.content && item.references?.length);
    const needsOriginal = requirement.claimSupport === 'required';
    return { version: 1, resolvedRequirement: requirement, scope: requirement.scope,
      coverage: { requested: requirement.scope.sourceIds.length, included: new Set(items.flatMap(item => item.sourceIds || [])).size, complete: false, ...coverage },
      items, gaps: [...new Set([...gaps, ...(needsOriginal && !original ? ['Current original evidence is still needed for precise claims.'] : [])])],
      escalationHints: [...new Set([...escalationHints,
        ...(needsOriginal && !original ? ['retrieve_project_evidence'] : []),
        ...(requirement.coverage === 'exhaustive' && coverage.analyzed === undefined ? ['run_corpus_workflow'] : [])])],
      sufficiency: needsOriginal && !original ? 'needs_original_evidence' : 'agent_must_assess',
      limitation: 'Currentness and citation resolution do not establish scientific claim entailment. Retrieval alone does not measure exhaustive analysis.',
    };
  }
  return Object.freeze({ identityError, resolveSourceId, resolveArguments, evidenceArguments, identityMessages, definitions, isTool, validate, normalizeRequirement, resolveRequirement, corpusScopeResolution, evidenceTerms, evidenceScore, evidenceQuery, evidenceMatch, bundle, cardProjectionIsSufficient });
});
