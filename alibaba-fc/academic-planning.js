"use strict";
const contract = require("./shared/academic-tools.js");
const recovery = require("./academic-recovery.js");
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
    stop_reason: { type: "string", enum: ["sufficient_candidates", "continue", "diminishing_returns", "sources_exhausted", "budget_exhausted"], description: "Why selection can stop. sources_exhausted means no further suitable papers found in the inspected pool, not that all provider records were inspected. A remaining cursor does not require another search." },
    remaining_gaps: strings(6, 300),
  }, ["shortlist", "stop_reason", "remaining_gaps"])),
];
const isTool = name => tools.some(tool => tool.function.name === name);
const fail = (code, details = {}) => { throw Object.assign(new Error(code), { code, details }); };
function coverageTopics(state) {
  if (!state.plan) return [];
  const accepted = state.plan.coverage_topics;
  if (Array.isArray(accepted) && accepted.length === state.plan.subtopics.length &&
      accepted.every((topic, index) => typeof topic.id === "string" && topic.id && topic.label === state.plan.subtopics[index]) &&
      new Set(accepted.map(topic => topic.id)).size === accepted.length) return accepted;
  // Deterministic host IDs also migrate plans from existing v2 continuations.
  state.plan.coverage_topics = state.plan.subtopics.map((label, index) => {
    let id = `subtopic_${index + 1}`;
    while (state.plan.subtopics.includes(id)) id = `_${id}`;
    return { id, label };
  });
  return state.plan.coverage_topics;
}
function toolDefinitions(state) {
  if (!state.plan) return [tools[0]];
  const selection = JSON.parse(JSON.stringify(tools[1]));
  const topics = coverageTopics(state);
  selection.function.parameters.properties.shortlist.items.properties.covers.items = { type: "string", enum: topics.map(topic => topic.id) };
  selection.function.parameters.properties.shortlist.items.properties.covers.description = "Use only these host-assigned subtopic IDs when supported by the paper; [] is allowed if none fits. ID labels: " + JSON.stringify(topics);
  return [selection]; // Planning is already recorded; recover it from host state.
}
const searchArgs = args => Object.fromEntries(Object.entries(contract.normalizeSearchInput(args)).filter(([key]) => key !== "cursor").sort(([a], [b]) => a.localeCompare(b)));
const sameSearch = (a, b) => JSON.stringify(searchArgs(a)) === JSON.stringify(searchArgs(b));
function nextPage(state) {
  const search = state.searches.find(search => search.next_cursor);
  return search ? { name: "search_academic_papers", arguments: { ...search.args, cursor: search.next_cursor } } : null;
}
function paginationDetails(state, invalidValue) {
  const origin = state.searches.find(search => search.next_cursor === invalidValue);
  return { field: "cursor", invalid_value: invalidValue ?? null,
    allowed_values: state.searches.map(search => search.next_cursor).filter(Boolean),
    required_tool_call: origin ? { name: "search_academic_papers", arguments: { ...origin.args, cursor: origin.next_cursor } } : nextPage(state),
    required_correction: "Inspect the returned cursor using its original query, queries, providers, limits and date/filter arguments, then reconsider the shortlist. Repeating the initial query is not pagination." };
}
function validate(value, schema, field = "arguments", paperRef = null) {
  const invalid = (correction, extra = {}) => fail("INVALID_LITERATURE_PLAN", { field, invalid_value: value ?? null,
    ...(paperRef ? { paper_ref: paperRef } : {}), required_correction: correction, ...extra });
  if (schema.type === "object") {
    if (!value || typeof value !== "object" || Array.isArray(value)) invalid("Supply a JSON object matching the exposed tool schema.");
    const child = key => field === "arguments" ? key : `${field}.${key}`;
    for (const key of Object.keys(value)) if (!Object.hasOwn(schema.properties, key)) invalid(`Remove the unsupported field ${key}.`, { field: child(key), invalid_value: value[key], allowed_fields: Object.keys(schema.properties) });
    for (const key of schema.required) if (value[key] === undefined) invalid(`Supply the required ${key} field using the original request or inspected paper evidence.`, { field: child(key), invalid_value: null });
    for (const [key, item] of Object.entries(value)) validate(item, schema.properties[key], child(key), value.paper_ref || paperRef);
  } else if (schema.type === "array") {
    if (!Array.isArray(value) || value.length < schema.minItems || value.length > schema.maxItems) invalid(`Supply an array with ${schema.minItems}–${schema.maxItems} entries.`, { min_items: schema.minItems, max_items: schema.maxItems });
    if (schema.uniqueItems && new Set(value).size !== value.length) invalid("Remove exact duplicate entries; preserve the intended meaning.");
    value.forEach((item, index) => validate(item, schema.items, `${field}[${index}]`, paperRef));
  } else if (schema.type === "string") {
    if (typeof value !== "string" || !value.trim() || value.length > (schema.maxLength || 100)) invalid(`Supply a nonempty string of at most ${schema.maxLength || 100} characters.`);
    if (schema.pattern && !contract.validRef(value)) invalid("Use a paper_ref returned by an academic tool.");
    if (schema.enum && !schema.enum.includes(value)) invalid("Choose a value from allowed_values supported by the request and evidence.", { allowed_values: schema.enum });
  } else if (!Number.isInteger(value) || value < schema.minimum || value > schema.maximum) invalid(`Use an integer from ${schema.minimum} to ${schema.maximum}.`, { minimum: schema.minimum, maximum: schema.maximum });
}
const target = (state, limit) => Number.isInteger(limit) && limit > 0 ? limit : state.plan?.requested_count || null;
const saved = state => state.downloads.filter(item => item.status === "downloaded").length;
function budgetReason(state, now = Date.now()) {
  if (now - state.startedAt >= LIMITS.moveMs) return "time_budget_exhausted";
  if ((state.discoveryCalls || 0) >= LIMITS.searchCalls || (state.discoveryMs || 0) >= LIMITS.discoveryMs || state.papers.length >= LIMITS.candidates) return "search_budget_exhausted";
  return "";
}
function nextSteps(state, limit) {
  if (!state.plan) return { required_tool: "plan_literature_search", next: "Record the literature plan from the original request." };
  const error = recovery.blocker(state);
  if (error) return { required_tool: error.required_tool_call?.name || error.required_tool || "select_literature_papers",
    ...(error.required_tool_call ? { required_tool_call: error.required_tool_call } : {}),
    next: `The plan is already recorded. Correct ${error.code}: ${error.required_correction || "Use the actual validation error in host state."} Then continue the authorized workflow; internal correction requires no user confirmation.` };
  const wanted = target(state, limit), budget = budgetReason(state);
  if ((wanted && saved(state) >= wanted) || budget === "time_budget_exhausted") return { next: "Report actual candidates, selected papers, saved files and remaining gaps. The plan is already recorded." };
  if (!budget && (!state.searchCalls || (state.plan.request_kind === "topic" && (state.searchedQueries || []).length < 2))) return {
    required_tool: "search_academic_papers", required_tool_call: { name: "search_academic_papers", arguments: contract.normalizeSearchInput({
      query: state.plan.queries[0], queries: state.plan.queries.slice(1), limit: 20, prefer_open_access: false,
      ...(state.plan.year_from ? { year_from: state.plan.year_from } : {}), ...(state.plan.year_to ? { year_to: state.plan.year_to } : {}),
    }) }, next: "The plan is already recorded. Collect its complementary queries as one bounded candidate pool, preserve date constraints, then select relevant papers and continue saving when requested and permitted." };
  if (!state.shortlist) return { required_tool: "select_literature_papers", next: "The plan is already recorded. Compare candidate titles and abstracts and select using its accepted coverage IDs; then download when requested and permitted. Additional search is optional when relevance, evidence, count or coverage is insufficient. A next_cursor alone never requires another search or invalidates a shortlist." };
  return { next: "The plan and shortlist are recorded. Continue authorized downloading from relevant unattempted selections when saving was requested and permitted, or report actual results and gaps. Do not repeat the plan." };
}
function planResult(state, limit) {
  coverageTopics(state);
  return { version: 1, status: "completed", plan: state.plan, budgets: LIMITS, ...nextSteps(state, limit) };
}
function planReceipt(state) {
  coverageTopics(state);
  return { version: 1, status: "completed", plan: state.plan, budgets: LIMITS, record_type: "accepted_plan",
    next: "The plan is already recorded. Read Literature workflow progress (host state) for current next steps and validation corrections; do not repeat the plan." };
}
function execute(state, name, args, limit) {
  if (name === "plan_literature_search" && Array.isArray(args?.queries)) args = { ...args, queries: [...new Set(args.queries)] };
  try { validate(args, tools.find(tool => tool.function.name === name).function.parameters); }
  catch (error) { error.details = { ...error.details, required_tool: name }; throw error; }
  if (name === "plan_literature_search") {
    if (state.plan || state.searchCalls) fail("LITERATURE_PLAN_ALREADY_SET", { field: "plan", invalid_value: args, accepted_plan: state.plan,
      ...nextSteps(state, limit), required_correction: "Use the accepted plan and next steps from host state. Do not record the plan again." });
    if (args.request_kind === "topic" && args.queries.length < 2) fail("COMPLEMENTARY_QUERIES_REQUIRED", { field: "queries", invalid_value: args.queries,
      required_tool: "plan_literature_search", required_correction: "Provide at least two distinct complementary queries for a topic request; exact duplicates do not broaden coverage." });
    if (args.year_from && args.year_to && args.year_from > args.year_to) fail("INVALID_LITERATURE_PLAN");
    if (limit && args.requested_count && args.requested_count !== limit) fail("REQUESTED_COUNT_MISMATCH");
    state.plan = { ...args, ...(limit ? { requested_count: limit } : {}), count_source: limit ? "user_request" : args.requested_count ? "model_interpretation" : "unspecified" };
    return planResult(state, limit);
  }
  if (!state.plan) fail("LITERATURE_PLAN_REQUIRED");
  const exhausted = budgetReason(state);
  if (state.plan.request_kind === "topic" && !exhausted && !(state.lowYieldStreak >= 2)) {
    if ((state.searchedQueries || []).length < 2) fail("COMPLEMENTARY_SEARCH_REQUIRED", {
      required_tool_call: { name: "search_academic_papers", arguments: { query: state.plan.queries[0], queries: state.plan.queries.slice(1), limit: 20, prefer_open_access: false,
        ...(state.plan.year_from ? { year_from: state.plan.year_from } : {}), ...(state.plan.year_to ? { year_to: state.plan.year_to } : {}) } },
      required_correction: "Search the complementary queries in the accepted plan before comparing and selecting papers.",
    });
  }
  const selected = [], identities = new Set(), titles = new Map(), violations = [];
  for (const item of args.shortlist) {
    try {
      const paper = state.papers.find(paper => paper.paper_ref === item.paper_ref);
      if (!paper) fail("UNKNOWN_PAPER_HANDLE", { paper_ref: item.paper_ref, invalid_value: item.paper_ref, allowed_values: state.papers.map(paper => paper.paper_ref),
        required_correction: "Select only a returned paper_ref after inspecting its title and abstract.", required_tool: "select_literature_papers" });
      const identity = paper.doi || paper.paper_ref;
      if (identities.has(identity)) fail("DUPLICATE_PAPER_SELECTION", { paper_ref: item.paper_ref, field: "paper_ref", invalid_value: item.paper_ref,
        required_correction: "Keep only one selection for the same paper/DOI.", required_tool: "select_literature_papers" });
      identities.add(identity);
      const title = paper.title.toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
      const authors = (paper.authors || []).map(author => author.toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim());
      if (title.length >= 25 && titles.get(title)?.some(author => authors.includes(author))) fail("DUPLICATE_PAPER_SELECTION", { paper_ref: item.paper_ref, field: "paper_ref", invalid_value: item.paper_ref,
        required_correction: "Keep one version of the same study with matching title and authors.", required_tool: "select_literature_papers" });
      titles.set(title, authors);
      const topics = coverageTopics(state);
      // Exact legacy labels are accepted, but never fuzzy-matched or replaced with
      // another category. New schemas advertise IDs only.
      const covers = item.covers.map(value => topics.find(topic => topic.id === value) || topics.find(topic => topic.label === value));
      const invalid = item.covers.filter((value, index) => !covers[index]);
      if (invalid.length) fail("UNKNOWN_SELECTION_SUBTOPIC", {
        paper_ref: item.paper_ref, field: "shortlist.covers", invalid_value: invalid[0], invalid_values: invalid,
        allowed_values: topics.map(topic => topic.id), allowed_coverage: topics,
        required_correction: "Reassess this paper's title and abstract. Replace each invalid coverage value with a supported declared subtopic ID. Query text is not a coverage ID. Use [] or remove the paper if no declared subtopic fits; do not assign an unrelated category.",
        required_tool: "select_literature_papers",
      });
      if (item.evidence === "title_abstract" && !paper.abstract?.trim()) fail("ABSTRACT_NOT_AVAILABLE", { paper_ref: item.paper_ref, field: "evidence", invalid_value: item.evidence, allowed_values: ["title_only"],
        required_correction: "Read fuller metadata if available, or use title_only with explicit uncertainty or remove the paper. Do not claim abstract evidence that was not returned.", required_tool: "select_literature_papers" });
      const year = Number(String(paper.published_date || "").slice(0, 4));
      if ((state.plan.year_from || state.plan.year_to) && (!year || year < (state.plan.year_from || 1600) || year > (state.plan.year_to || 2200))) fail("PAPER_OUTSIDE_DATE_CONSTRAINT", {
        paper_ref: item.paper_ref, invalid_value: paper.published_date || null, allowed_years: { from: state.plan.year_from || 1600, to: state.plan.year_to || 2200 },
        required_correction: "Remove this paper or retrieve verified date metadata within the requested date range. Do not alter the user's date constraints.", required_tool: "select_literature_papers" });
      selected.push({ ...item, covers: [...new Set(covers.map(topic => topic.id))], coverage_labels: [...new Set(covers.map(topic => topic.label))] });
    } catch (error) {
      if (!error.code) throw error;
      violations.push({ code: error.code, ...error.details, paper_ref: item.paper_ref });
    }
  }
  if (violations.length) {
    const first = violations[0];
    fail(first.code, { ...first, violations: violations.map(({ allowed_coverage, ...item }) => item),
      allowed_coverage: coverageTopics(state), valid_paper_refs: selected.map(item => item.paper_ref),
      required_tool: "select_literature_papers",
      required_correction: `Correct every listed violation in one revised shortlist; the accepted selection has not changed. ${first.required_correction}` });
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
  if (args.stop_reason === "budget_exhausted" && !exhausted) fail("SEARCH_BUDGET_REMAINS");
  state.shortlist = ranked;
  state.selectionStop = exhausted || args.stop_reason;
  state.remainingGaps = args.remaining_gaps;
  recovery.resolved(state);
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
        if (args[key] !== undefined && args[key] !== state.plan[key]) fail("SEARCH_DATE_CONSTRAINT_MISMATCH", { field: key, invalid_value: args[key], allowed_values: [state.plan[key] ?? null],
          required_correction: `Use the accepted plan's ${key} value (${state.plan[key] ?? "omitted"}); do not introduce or change date constraints.`, required_tool: name });
        if (state.plan[key] !== undefined) args[key] = state.plan[key];
      }
      args.prefer_open_access ??= false;
      args.limit ??= 20;
      const previous = state.searches.find(search => sameSearch(search.args, args));
      if (args.cursor) {
        const origin = state.searches.find(search => search.next_cursor === args.cursor);
        if (!origin || !sameSearch(origin.args, args)) fail("INVALID_SEARCH_PAGINATION", paginationDetails(state, args.cursor));
      } else if (previous?.next_cursor) {
        fail("PAGINATION_CURSOR_REQUIRED", { ...paginationDetails(state), required_tool_call: { name, arguments: { ...previous.args, cursor: previous.next_cursor } } });
      }
    }
    state.discoveryCalls = (state.discoveryCalls || 0) + 1;
    state.searchPending ||= {}; state.searchPending[id] = Date.now();
    state.searchedQueries = [...distinct];
  }
  if (name === "download_papers") {
    if (state.validationRecovery?.pending || !state.shortlist?.length || args.paper_refs.some(ref => !state.shortlist.some(item => item.paper_ref === ref))) fail("SHORTLIST_REQUIRED_BEFORE_DOWNLOAD", {
      required_tool: "select_literature_papers", required_correction: "Correct the internal shortlist validation error and record a valid selection, then continue the already-authorized download. This is not a user-confirmation requirement.",
      ...(state.validationRecovery?.last_error ? { blocked_by: state.validationRecovery.last_error } : {}),
    });
    args.paper_refs.sort((a, b) => state.shortlist.findIndex(item => item.paper_ref === a) - state.shortlist.findIndex(item => item.paper_ref === b));
    const pending = state.attemptedRefs.filter(ref => !state.downloads.some(item => item.paper_ref === ref)).length;
    if (wanted && args.paper_refs.length > wanted - saved(state) - pending) fail("REQUESTED_DOWNLOAD_COUNT_EXCEEDED");
    state.downloadSelections ||= {};
    for (const ref of args.paper_refs) state.downloadSelections[ref] = { ...state.shortlist.find(item => item.paper_ref === ref) };
  }
  return args;
}
function recordSearch(state, call, result, priorCount, inspectedPage = false) {
  if (call.name !== "search_academic_papers" && !(call.name === "get_academic_paper" && call.args.query)) return;
  const pending = state.searchPending?.[call.id];
  if (pending) { state.discoveryMs = (state.discoveryMs || 0) + Math.max(0, Date.now() - pending); delete state.searchPending[call.id]; }
  const added = state.papers.length - priorCount;
  state.returnedCandidates = (state.returnedCandidates || 0) + (result.papers?.length || 0);
  // A failed or non-advancing cursor response is not evidence of low yield.
  const inspected = result.status !== "failed" && (!call.args.cursor || inspectedPage);
  state.lowYieldStreak = inspected && added <= 1 ? (state.lowYieldStreak || 0) + 1 : 0;
  if (inspectedPage) {
    state.pagesInspected = (state.pagesInspected || 0) + 1;
  }
  const errorCode = state.validationRecovery?.last_error?.code;
  if ((inspectedPage && recovery.paginationCodes.has(errorCode)) ||
      (inspected && errorCode === "COMPLEMENTARY_SEARCH_REQUIRED" && state.searchedQueries?.length >= 2)) recovery.resolved(state);
  state.searchHistory ||= [];
  state.searchHistory.push({ query: call.args.query, queries: call.args.queries || [], page: inspectedPage, cursor: call.args.cursor || null, added, returned: result.papers?.length || 0, metrics: result.metrics || null });
  state.searchHistory = state.searchHistory.slice(-LIMITS.searchCalls);
}
function progress(state, limit) {
  coverageTopics(state);
  return { plan: state.plan || null, shortlist: state.shortlist || [], remaining_gaps: state.remainingGaps || [],
    ...nextSteps(state, limit),
    selected: state.shortlist?.length || 0, validation: state.validationRecovery || null,
    saved: saved(state), requested: target(state, limit), candidates: state.papers.length,
    pages_inspected: state.pagesInspected || 0, search_calls: state.discoveryCalls || 0,
    search_ms: state.discoveryMs || 0, stop_reason: state.validationRecovery?.exhausted ? "validation_recovery_exhausted" : target(state, limit) && saved(state) >= target(state, limit) ? "requested_count_saved" : budgetReason(state) || state.selectionStop || (state.lowYieldStreak >= 2 ? "diminishing_returns" : null),
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
module.exports = { tools, toolDefinitions, coverageTopics, planResult, planReceipt, nextSteps, nextPage, sameSearch, isTool, execute, beforeTool, recordSearch, progress, target, budgetReason, recordModel, modelMetrics, LIMITS };
