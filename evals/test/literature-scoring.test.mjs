import test from 'node:test';
import assert from 'node:assert/strict';
import { scoreLiterature } from '../literature/score.mjs';
test('literature scoring separates reviewed quality, duplicates, acquisition and model cost', () => {
  const data = { academicSelection: { shortlist: [{ paper_ref: 'a' }, { paper_ref: 'b' }, { paper_ref: 'c' }] },
    academicSources: [{ paper_ref: 'a', doi: '10.1/a' }, { paper_ref: 'b', doi: '10.1/a' }, { paper_ref: 'c', doi: '10.1/c' }],
    downloadResults: [{ status: 'downloaded' }, { status: 'failed' }],
    academicSearchStatus: { model: { calls: 2, input_tokens: 1000, output_tokens: 100 } } };
  const base = { data, labels: { '10.1/a': { relevant: true, topics: ['design'] }, '10.1/c': { relevant: false, topics: ['validation'] } }, topics: ['design', 'validation'], elapsedMs: 100, mode: 'live' };
  const result = scoreLiterature({ ...base, inputUsdPerMillion: 2, outputUsdPerMillion: 5 });
  assert.equal(result.relevance_precision, 2 / 3); assert.equal(result.topic_coverage, 0.5);
  assert.equal(result.selection_duplicate_rate, 1 / 3); assert.equal(result.download_success_rate, 0.5);
  assert.equal(result.estimated_model_cost_usd, 0.0025);
  const unknown = scoreLiterature({ ...base, labels: {} });
  assert.equal(unknown.relevance_precision, null); assert.equal(unknown.topic_coverage, null); assert.equal(unknown.estimated_model_cost_usd, null);
});
