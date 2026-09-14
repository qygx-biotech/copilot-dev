'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const planning = require('../academic-planning.js'), academic = require('../academic-agent.js');
const continuation = require('../agent-continuation.js');
const ref = n => 'paper_' + String(n).padStart(24, '0');
const paper = (n, extra = {}) => ({ paper_ref: ref(n), title: `Engineering paper ${n}`, authors: ['A'], doi: `10.1000/${n}`, abstract: 'Evidence about the requested method.', published_date: '2024-01-01', locations: [], providers: [], ...extra });
const plan = { request_kind: 'topic', subtopics: ['design', 'validation'], synonyms: ['engineering'], queries: ['enzyme design', 'enzyme validation'], requested_count: 2, year_from: 2023, year_to: 2025 };
const selection = (n, relevance, covers, extra = {}) => ({ paper_ref: ref(n), relevance, covers, reason: 'Direct methodological evidence for the requested subtopic.', evidence: 'title_abstract', ...extra });
function prepared() {
  const state = academic.initial();
  planning.execute(state, 'plan_literature_search', plan, 2);
  const args = planning.beforeTool(state, 'search_academic_papers', { query: plan.queries[0], queries: [plan.queries[1]] }, 's', 2);
  academic.recordResult(state, { id: 's', name: 'search_academic_papers', args }, { version: 1, status: 'completed', papers: [paper(1), paper(2), paper(3, { access: [{ is_open_access: true }] })] });
  return state;
}
test('planning enforces shape, complementary queries and the actual requested count', () => {
  assert.throws(() => planning.beforeTool(academic.initial(), 'search_academic_papers', { query: 'x' }, 's', 2), { code: 'LITERATURE_PLAN_REQUIRED' });
  assert.throws(() => planning.execute(academic.initial(), 'plan_literature_search', { ...plan, queries: ['x'] }, 2), { code: 'COMPLEMENTARY_QUERIES_REQUIRED' });
  assert.throws(() => planning.execute(academic.initial(), 'plan_literature_search', { ...plan, requested_count: 99 }, 2), { code: 'REQUESTED_COUNT_MISMATCH' });
  assert.throws(() => planning.execute(academic.initial(), 'plan_literature_search', { ...plan, surprise: 'instruction' }, 2), { code: 'INVALID_LITERATURE_PLAN' });
});
test('selection compares relevance first, then coverage, then availability', () => {
  const state = prepared();
  const result = planning.execute(state, 'select_literature_papers', { shortlist: [selection(3, 3, ['validation']), selection(2, 5, ['design']), selection(1, 5, ['design', 'validation'])], stop_reason: 'sufficient_candidates', remaining_gaps: [] }, 2);
  assert.deepEqual(result.shortlist.map(x => x.paper_ref), [ref(1), ref(2), ref(3)]);
  assert.deepEqual(result.next_paper_refs, [ref(1), ref(2)]);
  assert.deepEqual(planning.beforeTool(state, 'download_papers', { paper_refs: [ref(2), ref(1)] }, 'ordered', 2).paper_refs, [ref(1), ref(2)]);
  state.shortlist = [selection(3, 3, ['validation'])];
  assert.equal(state.downloadSelections[ref(1)].reason, 'Direct methodological evidence for the requested subtopic.');
  state.shortlist = result.shortlist;
  assert.throws(() => planning.beforeTool(state, 'download_papers', { paper_refs: [ref(1), ref(2), ref(3)] }, 'd', 2), { code: 'REQUESTED_DOWNLOAD_COUNT_EXCEEDED' });
});
test('a cached next page must be inspected before selecting topic papers', () => {
  const state = prepared(); state.searches[0].next_cursor = 'pool:20';
  const args = { shortlist: [selection(1, 5, ['design'])], stop_reason: 'sufficient_candidates', remaining_gaps: [] };
  assert.throws(() => planning.execute(state, 'select_literature_papers', args, 2), { code: 'INSPECT_NEXT_PAGE_BEFORE_SELECTION' });
  state.pagesInspected = 1;
  assert.equal(planning.execute(state, 'select_literature_papers', args, 2).status, 'completed');
});
test('shortlisting rejects invented handles, duplicate DOIs, invented abstracts and dates outside the request', () => {
  const state = prepared();
  const select = shortlist => planning.execute(state, 'select_literature_papers', { shortlist, stop_reason: 'sufficient_candidates', remaining_gaps: [] }, 2);
  assert.throws(() => select([selection(9, 5, ['design'])]), { code: 'UNKNOWN_PAPER_HANDLE' });
  state.papers[1].doi = state.papers[0].doi;
  assert.throws(() => select([selection(1, 5, []), selection(2, 5, [])]), { code: 'DUPLICATE_PAPER_SELECTION' });
  state.papers[0].abstract = '';
  assert.throws(() => select([selection(1, 5, [])]), { code: 'ABSTRACT_NOT_AVAILABLE' });
  state.papers[0].published_date = null;
  assert.throws(() => select([selection(1, 5, [], { evidence: 'title_only' })]), { code: 'PAPER_OUTSIDE_DATE_CONSTRAINT' });
});
test('selection rejects same-title same-author versions with different DOIs', () => {
  const state = prepared(); state.papers[0].title = state.papers[1].title = 'An identical study title in a preprint and journal version';
  assert.throws(() => planning.execute(state, 'select_literature_papers', { shortlist: [selection(1, 5, []), selection(2, 5, [])], stop_reason: 'sufficient_candidates', remaining_gaps: [] }, 2), { code: 'DUPLICATE_PAPER_SELECTION' });
});
test('search budgets persist, dates propagate, and completed counts stop acquisition', () => {
  const state = prepared();
  const args = planning.beforeTool(state, 'search_academic_papers', { query: 'enzyme design', cursor: 'pool:20' }, 's2', 2);
  assert.equal(args.year_from, 2023); assert.equal(args.year_to, 2025); assert.equal(args.prefer_open_access, false);
  assert.throws(() => planning.beforeTool(state, 'search_academic_papers', { query: 'enzyme design', year_from: 2020 }, 'bad', 2), { code: 'SEARCH_DATE_CONSTRAINT_MISMATCH' });
  state.discoveryCalls = planning.LIMITS.searchCalls;
  assert.throws(() => planning.beforeTool(state, 'search_academic_papers', { query: 'more' }, 's3', 2), { code: 'LITERATURE_SEARCH_BUDGET_EXHAUSTED' });
  state.downloads = [1, 2].map(n => ({ paper_ref: ref(n), status: 'downloaded' }));
  assert.throws(() => planning.beforeTool(state, 'download_papers', { paper_refs: [ref(3)] }, 'd', 2), { code: 'REQUESTED_COUNT_SAVED' });
  assert.equal(planning.progress(state, 2).stop_reason, 'requested_count_saved');
});
test('two low-yield pages stop new searches but preserve relevant shortlist reserves', () => {
  const state = prepared();
  planning.execute(state, 'select_literature_papers', { shortlist: [selection(1, 5, ['design'])], stop_reason: 'continue', remaining_gaps: ['validation'] }, 2);
  for (let i = 0; i < 2; i++) academic.recordResult(state, { name: 'search_academic_papers', args: { query: 'enzyme design', cursor: `pool:${i}` } }, { version: 1, status: 'completed', papers: [paper(1)], next_cursor: 'pool:later' });
  assert.equal(state.lowYieldStreak, 2);
  assert.throws(() => planning.beforeTool(state, 'search_academic_papers', { query: 'again' }, 's', 2), { code: 'LITERATURE_SEARCH_DIMINISHING_RETURNS' });
  assert.doesNotThrow(() => planning.beforeTool(state, 'download_papers', { paper_refs: [ref(1)] }, 'd', 2));
});
test('signed continuation retains plan, shortlist, and measured usage; missing usage stays unknown', () => {
  const state = prepared();
  planning.execute(state, 'select_literature_papers', { shortlist: [selection(1, 5, ['design'])], stop_reason: 'sufficient_candidates', remaining_gaps: ['validation'] }, 2);
  planning.recordModel(state, { usage: { prompt_tokens: 40, completion_tokens: 10 } }, 20);
  const signed = continuation.seal({ academicState: state }, { project: 'p' }, 'test');
  const opened = continuation.open(signed, { project: 'p' }, 'test').academicState;
  assert.deepEqual(opened.plan, state.plan); assert.deepEqual(opened.shortlist, state.shortlist);
  assert.equal(planning.modelMetrics(opened).input_tokens, 40);
  planning.recordModel(opened, {}, 10);
  assert.equal(planning.modelMetrics(opened).input_tokens, null); assert.equal(planning.modelMetrics(opened).cost_usd, null);
});
test('named papers can use exact lookup and selection without substituting topical queries', () => {
  const state = academic.initial();
  planning.execute(state, 'plan_literature_search', { request_kind: 'named_papers', subtopics: ['specific paper'], synonyms: [], queries: ['10.1000/1'] }, 1);
  const args = planning.beforeTool(state, 'get_academic_paper', { query: '10.1000/1' }, 'exact', 1);
  academic.recordResult(state, { id: 'exact', name: 'get_academic_paper', args }, { version: 1, status: 'completed', papers: [paper(1)] });
  const result = planning.execute(state, 'select_literature_papers', { shortlist: [selection(1, 5, ['specific paper'])], stop_reason: 'sufficient_candidates', remaining_gaps: [] }, 1);
  assert.deepEqual(result.next_paper_refs, [ref(1)]);
});
