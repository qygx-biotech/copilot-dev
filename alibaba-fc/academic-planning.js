"use strict";
const contract = require("./shared/academic-tools.js");
const LIMITS = Object.freeze({ searchCalls: 4, focusedQueries: 6, candidates: 120, discoveryMs: 140000, moveMs: 10 * 60000 });
const text = maxLength => ({ type: "string", minLength: 1, maxLength });
const strings = (maxItems, maxLength, minItems = 0) => ({ type: "array", minItems, maxItems, uniqueItems: true, items: text(maxLength) });
const object = (properties, required) => ({ type: "object", additionalProperties: false, properties, required });
const tool = (name, description, parameters) => ({ type: "function", function: { name, description, parameters } });
const tools = [
  tool("plan_literature_search", "Before searching, record a concise plan grounded in the user's request: complementary subtopics, synonyms, focused queries, dates and paper count. This is in-memory planning, not a search or permission to write. Topic requests need 2–4 queries; exact named-paper requests may use one. It does not require user confirmation.", object({
    request_kind: { type: "string", enum: ["topic", "named_papers"] },
    subtopics: strings(6, 160, 1), synonyms: strings(12, 100), queries: strings(4, 1000, 1),
    requested_count: { type: "integer", minimum: 1, maximum: 100 },
    year_from: { type: "integer", minimum: 1600, maximum: 2200 }, year_to: { type: "integer", minimum: 1600, maximum: 2200 },
  }, ["request_kind", "subtopics", "synonyms", "queries"])),
  tool("select_literature_papers", "Compare returned titles and abstracts against the original request and record a ranked shortlist with brief reasons. Relevance (3=relevant, 4=strong, 5=direct) and subtopic coverage come before download availability. Include relevant reserves for recovery. Missing abstracts require title_only evidence and explicit uncertainty. Only shortlisted handles may be downloaded. Selection does not download or ask the user for approval.", object({
    shortlist: { type: "array", minItems: 0, maxItems: 30, items: object({
      paper_ref: { type: "string", pattern: "^paper_[a-f0-9]{24}$" }, relevance: { type: "integer", minimum: 3, maximum: 5 },
      covers: strings(6, 160), reason: text(400), evidence: { type: "string", enum: ["title_abstract", "title_only"] },
    }, ["paper_ref", "relevance", "covers", "reason", "evidence"]) },
    stop_reason: { type: "string", enum: ["sufficient_candidates", "continue", "diminishing_returns", "sources_exhausted", "budget_exhausted"] },
    remaining_gaps: strings(6, 300),
  }, ["shortlist", "stop_reason", "remaining_gaps"])),
];
const isTool = name => tools.some(tool => tool.function.name === name);
const fail = code => { throw Object.assign(new Error(code), { code }); };
function validate(value, schema) {
  if (schema.type === "object") {
    if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some(key => !schema.properties[key]) || schema.required.some(key => value[key] === undefined)) fail("INVALID_LITERATURE_PLAN");
    for (const [key, item] of Object.entries(value)) validate(item, schema.properties[key]);
  } else if (schema.type === "array") {
    if (!Array.isArray(value) || value.length < schema.minItems || value.length > schema.maxItems || (schema.uniqueItems && new Set(value).size !== value.length)) fail("INVALID_LITERATURE_PLAN");
    value.forEach(item => validate(item, schema.items));
  } else if (schema.type === "string") {
    if (typeof value !== "string" || !value.trim() || value.length > (schema.maxLength || 100) || (schema.pattern && !contract.validRef(value)) || (schema.enum && !schema.enum.includes(value))) fail("INVALID_LITERATURE_PLAN");
  } else if (!Number.isInteger(value) || value < schema.minimum || value > schema.maximum) fail("INVALID_LITERATURE_PLAN");
}
const target = (state, limit) => Number.isInteger(limit) && limit > 0 ? limit : state.plan?.requested_count || null;
const saved = state => state.downloads.filter(item => item.status === "downloaded").length;
function budgetReason(state, now = Date.now()) {
  if (now - state.startedAt >= LIMITS.moveMs) return "time_budget_exhausted";
  if ((state.discoveryCalls || 0) >= LIMITS.searchCalls || (state.discoveryMs || 0) >= LIMITS.discoveryMs || state.papers.length >= LIMITS.candidates) return "search_budget_exhausted";
  return "";
}
function execute(state, name, args, limit) {
  validate(args, tools.find(tool => tool.function.name === name).function.parameters);
  if (name === "plan_literature_search") {
    if (state.plan || state.searchCalls) fail("LITERATURE_PLAN_ALREADY_SET");
    if (args.request_kind === "topic" && args.queries.length < 2) fail("COMPLEMENTARY_QUERIES_REQUIRED");
    if (args.year_from && args.year_to && args.year_from > args.year_to) fail("INVALID_LITERATURE_PLAN");
    if (limit && args.requested_count && args.requested_count !== limit) fail("REQUESTED_COUNT_MISMATCH");
    state.plan = { ...args, ...(limit ? { requested_count: limit } : {}), count_source: limit ? "user_request" : args.requested_count ? "model_interpretation" : "unspecified" };
    return { version: 1, status: "completed", plan: state.plan, budgets: LIMITS,
      next: "Search the planned complementary queries in one search_academic_papers call using query plus queries, limit=20, prefer_open_access=false. Inspect a cached next page before selecting when available. Preserve planned date constraints." };
  }
  if (!state.plan) fail("LITERATURE_PLAN_REQUIRED");
  const exhausted = budgetReason(state);
  const hasMore = state.searches.some(search => search.next_cursor);
  if (state.plan.request_kind === "topic" && !exhausted && !(state.lowYieldStreak >= 2)) {
    if ((state.searchedQueries || []).length < 2) fail("COMPLEMENTARY_SEARCH_REQUIRED");
    if (hasMore && !state.pagesInspected) fail("INSPECT_NEXT_PAGE_BEFORE_SELECTION");
  }
  const selected = [], identities = new Set(), titles = new Map();
  for (const item of args.shortlist) {
    const paper = state.papers.find(paper => paper.paper_ref === item.paper_ref);
    if (!paper) fail("UNKNOWN_PAPER_HANDLE");
    const identity = paper.doi || paper.paper_ref;
    if (identities.has(identity)) fail("DUPLICATE_PAPER_SELECTION");
    identities.add(identity);
    const title = paper.title.toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
    const authors = (paper.authors || []).map(author => author.toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim());
    if (title.length >= 25 && titles.get(title)?.some(author => authors.includes(author))) fail("DUPLICATE_PAPER_SELECTION");
    titles.set(title, authors);
    if (item.covers.some(topic => !state.plan.subtopics.includes(topic))) fail("UNKNOWN_SELECTION_SUBTOPIC");
    if (item.evidence === "title_abstract" && !paper.abstract) fail("ABSTRACT_NOT_AVAILABLE");
    const year = Number(String(paper.published_date || "").slice(0, 4));
    if ((state.plan.year_from || state.plan.year_to) && (!year || year < (state.plan.year_from || 1600) || year > (state.plan.year_to || 2200))) fail("PAPER_OUTSIDE_DATE_CONSTRAINT");
    selected.push({ ...item });
  }
  // The LLM supplies semantic scores and reasons. Availability is only the last
  // tie-breaker after relevance and marginal coverage of requested subtopics.
  const ranked = [], covered = new Set();
  const available = item => state.papers.find(p => p.paper_ref === item.paper_ref)?.access?.some(x => x.is_open_access === true) ? 1 : 0;
  while (selected.length) {
    selected.sort((a, b) => b.relevance - a.relevance || b.covers.filter(x => !covered.has(x)).length - a.covers.filter(x => !covered.has(x)).length || available(b) - available(a));
    const item = selected.shift(); ranked.push(item); item.covers.forEach(topic => covered.add(topic));
  }
  if (args.stop_reason === "diminishing_returns" && !exhausted && !(state.lowYieldStreak >= 2) && !(state.discoveryCalls >= 2 && args.remaining_gaps.length)) fail("STOP_REASON_NOT_SUPPORTED");
  if (args.stop_reason === "sources_exhausted" && hasMore && !exhausted) fail("UNINSPECTED_CANDIDATES_REMAIN");
  if (args.stop_reason === "budget_exhausted" && !exhausted) fail("SEARCH_BUDGET_REMAINS");
  state.shortlist = ranked;
  state.selectionStop = exhausted || args.stop_reason;
  state.remainingGaps = args.remaining_gaps;
  return { version: 1, status: "completed", shortlist: ranked, remaining_gaps: state.remainingGaps,
    next_paper_refs: ranked.filter(item => !state.attemptedRefs.includes(item.paper_ref)).slice(0, Math.min(5, Math.max(0, (target(state, limit) || 5) - saved(state)))).map(item => item.paper_ref),
    next: "Download only selected relevant handles when saving was requested and permitted. Stop when the requested suitable count is saved; use relevant reserves after failures. Selection reasons are model assessments, not independently verified relevance." };
}
function beforeTool(state, name, args, id, limit) {
  if (state.workflowVersion !== 2) return args; // Finish already-issued v1 continuations.
  if (!state.plan) fail("LITERATURE_PLAN_REQUIRED");
  const wanted = target(state, limit);
  if (wanted && saved(state) >= wanted) fail("REQUESTED_COUNT_SAVED");
  if (Date.now() - state.startedAt >= LIMITS.moveMs) fail("LITERATURE_TIME_BUDGET_EXHAUSTED");
  if (name === "search_academic_papers" || (name === "get_academic_paper" && args.query)) {
    if (budgetReason(state)) fail("LITERATURE_SEARCH_BUDGET_EXHAUSTED");
    if (state.lowYieldStreak >= 2) fail("LITERATURE_SEARCH_DIMINISHING_RETURNS");
    if (["diminishing_returns", "sources_exhausted"].includes(state.selectionStop)) fail("LITERATURE_SEARCH_STOPPED");
    const queries = [args.query, ...(args.queries || [])];
    const distinct = new Set([...(state.searchedQueries || []), ...queries]);
    if (distinct.size > LIMITS.focusedQueries) fail("LITERATURE_QUERY_BUDGET_EXHAUSTED");
    if (name === "search_academic_papers") {
      for (const key of ["year_from", "year_to"]) {
        if (args[key] !== undefined && args[key] !== state.plan[key]) fail("SEARCH_DATE_CONSTRAINT_MISMATCH");
        if (state.plan[key] !== undefined) args[key] = state.plan[key];
      }
      args.prefer_open_access ??= false;
      args.limit ??= 20;
    }
    state.discoveryCalls = (state.discoveryCalls || 0) + 1;
    state.searchPending ||= {}; state.searchPending[id] = Date.now();
    state.searchedQueries = [...distinct];
  }
  if (name === "download_papers") {
    if (!state.shortlist?.length || args.paper_refs.some(ref => !state.shortlist.some(item => item.paper_ref === ref))) fail("SHORTLIST_REQUIRED_BEFORE_DOWNLOAD");
    args.paper_refs.sort((a, b) => state.shortlist.findIndex(item => item.paper_ref === a) - state.shortlist.findIndex(item => item.paper_ref === b));
    const pending = state.attemptedRefs.filter(ref => !state.downloads.some(item => item.paper_ref === ref)).length;
    if (wanted && args.paper_refs.length > wanted - saved(state) - pending) fail("REQUESTED_DOWNLOAD_COUNT_EXCEEDED");
    state.downloadSelections ||= {};
    for (const ref of args.paper_refs) state.downloadSelections[ref] = { ...state.shortlist.find(item => item.paper_ref === ref) };
  }
  return args;
}
function recordSearch(state, call, result, priorCount) {
  if (call.name !== "search_academic_papers" && !(call.name === "get_academic_paper" && call.args.query)) return;
  const pending = state.searchPending?.[call.id];
  if (pending) { state.discoveryMs = (state.discoveryMs || 0) + Math.max(0, Date.now() - pending); delete state.searchPending[call.id]; }
  const added = state.papers.length - priorCount;
  state.returnedCandidates = (state.returnedCandidates || 0) + (result.papers?.length || 0);
  state.lowYieldStreak = result.status !== "failed" && added <= 1 ? (state.lowYieldStreak || 0) + 1 : 0;
  if (call.args.cursor) state.pagesInspected = (state.pagesInspected || 0) + 1;
  state.searchHistory ||= [];
  state.searchHistory.push({ query: call.args.query, queries: call.args.queries || [], page: Boolean(call.args.cursor), added, returned: result.papers?.length || 0, metrics: result.metrics || null });
  state.searchHistory = state.searchHistory.slice(-LIMITS.searchCalls);
}
function progress(state, limit) {
  return { plan: state.plan || null, shortlist: state.shortlist || [], remaining_gaps: state.remainingGaps || [],
    saved: saved(state), requested: target(state, limit), candidates: state.papers.length,
    pages_inspected: state.pagesInspected || 0, search_calls: state.discoveryCalls || 0,
    search_ms: state.discoveryMs || 0, stop_reason: target(state, limit) && saved(state) >= target(state, limit) ? "requested_count_saved" : budgetReason(state) || state.selectionStop || (state.lowYieldStreak >= 2 ? "diminishing_returns" : null),
    low_yield_streak: state.lowYieldStreak || 0, budgets: LIMITS };
}
function recordModel(state, turn, elapsedMs) {
  state.modelMetrics ||= { calls: 0, latency_ms: 0, usage_reported_calls: 0, input_tokens: 0, output_tokens: 0 };
  const metrics = state.modelMetrics; metrics.calls++; metrics.latency_ms += Math.max(0, elapsedMs);
  const input = turn.usage?.prompt_tokens ?? turn.usage?.input_tokens;
  const output = turn.usage?.completion_tokens ?? turn.usage?.output_tokens;
  if (Number.isInteger(input) && input >= 0 && Number.isInteger(output) && output >= 0) {
    metrics.usage_reported_calls++; metrics.input_tokens += input; metrics.output_tokens += output;
  }
}
function modelMetrics(state) {
  const value = state.modelMetrics || { calls: 0, latency_ms: 0, usage_reported_calls: 0 };
  const complete = value.calls > 0 && value.calls === value.usage_reported_calls;
  return { ...value, input_tokens: complete ? value.input_tokens : null, output_tokens: complete ? value.output_tokens : null,
    cost_usd: null, cost_note: "Billing is unavailable; benchmark estimates require explicit model prices and complete observed token usage." };
}
module.exports = { tools, isTool, execute, beforeTool, recordSearch, progress, target, budgetReason, recordModel, modelMetrics, LIMITS };
