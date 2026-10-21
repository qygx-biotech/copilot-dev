import test from 'node:test';
import assert from 'node:assert/strict';
import { scoreRetrieval } from '../literature/score.mjs';
test('retrieval scoring counts host-verified outcomes by status, route and version', () => {
  const rows = [
    { status: 'downloaded', route: 'open_access', version: 'published', ms: 1000 },
    { status: 'already_present', route: 'local', version: 'published', ms: 100 },
    { status: 'downloaded', route: 'institutional', version: 'published', ms: 9000 },
    { status: 'needs_login', route: 'institutional', version: 'unknown', ms: 12000 },
    { status: 'downloaded_unverified', route: 'open_access', version: 'unknown', ms: 3000 },
  ];
  const score = scoreRetrieval(rows);
  assert.equal(score.saved, 3); assert.equal(score.saved_rate, 0.6);
  assert.deepEqual(score.by_route, { open_access: 1, local: 1, institutional: 1 });
  assert.deepEqual(score.by_status, { downloaded: 2, already_present: 1, needs_login: 1, downloaded_unverified: 1 });
  assert.equal(score.quarantined, 1); assert.equal(score.waiting_for_user, 1);
  assert.equal(score.median_ms, 3000); assert.equal(score.total_ms, 25100);
  assert.equal(scoreRetrieval([]).saved_rate, null);
});
