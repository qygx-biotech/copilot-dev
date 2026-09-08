import fs from 'node:fs/promises';
import { createAdapter } from '../../lib/application-adapter.mjs';
import { verifyFrozenSuite, sha256, writeJson } from '../../lib/reproducibility.mjs';
import { scoreCase } from '../../lib/scoring.mjs';

const root = 'evals/results/adapter-audit-2026-09-07';
const suite = await verifyFrozenSuite('evals/biodesign-eval-v1');
const cases = (await fs.readFile('evals/biodesign-eval-v1/cases.jsonl', 'utf8')).trim().split('\n').map(JSON.parse);
const baseline = (await fs.readFile('evals/results/baseline-2026-09-07/cases.jsonl', 'utf8')).trim().split('\n').map(JSON.parse);
const statusCases = [...new Set(baseline.filter(r => r.limitations?.some(x => x.includes('Principal-scoped'))).map(r => r.caseId))];
const replayCases = ['CW-ECTD_WORKFLOWS-06', ...statusCases];
const audit = JSON.parse(await fs.readFile(`${root}/adapter-audit.json`, 'utf8'));
audit.priorCorrectedAdapterSha256 = audit.correctedAdapterSha256;
audit.correctedAdapterSha256 = sha256(await fs.readFile('evals/lib/application-adapter.mjs'));
audit.affectedCases = [...new Set([...audit.affectedCases, ...replayCases])];
audit.issues.push(
  { id: 'non_document_original_file', caseId: 'CW-ECTD_WORKFLOWS-06', problem: 'Declared add_file .DS_Store was unsupported in cold setup and skipped on warm. Corrected adapter writes exactly the declared original bytes through ProjectFilesystem; production decides whether to ingest.' },
  { id: 'incorrect_principal_status_guard', caseIds: statusCases, problem: 'Obsolete adapter status guard interpreted any local_user principal as unavailable enterprise ACL. Removed false blocked classification. Full access/side-effect audits remain unmeasured; this change is not a permission pass.' },
  { id: 'setup_completion_tracking', problem: 'Source setup now runs once for a newly created session regardless of requested cold/warm label, and cannot silently skip a previously failed setup.' }
);
audit.frozenManifestSha256 = suite.hash;
await writeJson(`${root}/adapter-audit.json`, audit);
const adapter = await createAdapter({ fixtureRoot: 'evals/biodesign-eval-v1/fixtures' });
const output = `${root}/cases-setup-status-correction.jsonl`;
await fs.appendFile(output, '');
const recorded = new Set((await fs.readFile(output, 'utf8')).split('\n').filter(Boolean).map(line => {
  const row = JSON.parse(line); return `${row.caseId}:${row.repeat || 0}:${row.timing.cacheState}`;
}));
try {
  for (const id of replayCases) {
    const testCase = cases.find(c => c.id === id);
    const { gold, expected, scoring, ...input } = testCase;
    for (const cacheState of ['cold', 'warm']) {
      if (recorded.has(`${id}:0:${cacheState}`)) continue;
      const observation = await adapter.runCase(input, { cacheState, repeat: 0 });
      observation.auditAdapterSha256 = audit.correctedAdapterSha256;
      await fs.appendFile(output, JSON.stringify(observation) + '\n');
      console.log('AUDIT_CASE', JSON.stringify({ id, cacheState, status: observation.status, errors: observation.errors,
        syncSources: observation.actual.sync?.sources?.map(s => s.sourceId), faults: observation.trace.filter(t => t.stage === 'controlled-fault') }));
    }
  }
} finally { await adapter.close(); }
const initialReplay = (await fs.readFile(`${root}/cases.jsonl`, 'utf8')).trim().split('\n').map(JSON.parse);
const laterReplay = (await fs.readFile(output, 'utf8')).trim().split('\n').map(JSON.parse);
const rows = [...initialReplay, ...laterReplay];
await fs.writeFile(`${root}/scores.jsonl`, rows.map(row => JSON.stringify(scoreCase(cases.find(c => c.id === row.caseId), row))).join('\n') + '\n');
audit.completedAt = new Date().toISOString();
audit.observationCount = rows.length;
audit.observationFiles = ['cases.jsonl', 'cases-setup-status-correction.jsonl'];
delete audit.pendingAdapterSha256;
delete audit.pendingCorrections;
delete audit.pendingReplay;
await writeJson(`${root}/adapter-audit.json`, audit);
const diagnostics = JSON.parse(await fs.readFile(`${root}/diagnostics.json`, 'utf8'));
diagnostics.adapterDefects.replayed = audit.affectedCases;
diagnostics.adapterDefects.pendingReplay = [];
diagnostics.adapterDefects.note = 'All affected setup/status cases replayed separately after the original baseline; no production or frozen suite changes.';
await writeJson(`${root}/diagnostics.json`, diagnostics);
await verifyFrozenSuite('evals/biodesign-eval-v1');
