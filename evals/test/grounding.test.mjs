import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { aggregateGrounding, main } from '../aggregate-grounding.mjs';
import { aggregateJudgeScores, JUDGE_CRITERIA } from '../lib/judge-results.mjs';

// Evaluation-only synthetic arrays. No application execution, saved candidate, or real judge content.
const packet = (overrides = {}) => ({
  packetId: 'p1', caseId: 'c1', repeat: 0, artifactType: 'final_answer', question: 'Describe the measurements.',
  candidateAnswer: 'Claim A [cite-1]. Claim B [cite-2]. Claim C. Claim D.',
  gold: {
    allowedEvidenceIds: ['e1', 'e2'], paperIds: ['s1', 's2'], sourceRowIds: [],
    claims: [{ id: 'g1', evidenceIds: ['e1'] }, { id: 'g2', evidenceIds: ['e2'] }],
    answerRequirements: [{ type: 'claim', claimId: 'g1' }, { type: 'claim', claimId: 'g2' }],
  },
  sources: [{ sourceId: 's1', evidenceId: 'e1', page: 1, text: 'First supplied fact.' }, { sourceId: 's2', evidenceId: 'e2', page: 2, text: 'Second supplied fact.' }],
  candidateCitations: [{ id: 'cite-1', reference: 'ref-1', sourceId: 's1', page: 1 }, { id: 'cite-2', reference: 'ref-2', sourceId: 's2', page: 2 }],
  ...overrides,
});
const audit = (overrides = {}) => ({
  candidateSpan: 'Claim A', citedEvidenceIds: ['cite-1'], supportingEvidenceIds: ['e1'],
  verdict: 'supported', requiredGoldClaimIds: ['g1'], ...overrides,
});
const score = (overrides = {}) => ({
  packetId: 'p1', artifactType: 'final_answer', ...Object.fromEntries(JUDGE_CRITERIA.map(key => [key, 5])),
  criticalErrors: [], missingPoints: [], lowScoreEvidence: [], claimAudits: [audit()], numericClaims: [], confidence: 'medium', ...overrides,
});
const result = (p = packet(), s = score()) => aggregateGrounding([p], [s], { bootstrapSamples: 100 });

test('strict precision includes uncertain claims, separates verdicts, and preserves unsupported spans and gold links', () => {
  const s = score({ claimAudits: [
    audit(),
    audit({ candidateSpan: 'Claim B', verdict: 'unsupported', supportingEvidenceIds: [], requiredGoldClaimIds: ['g2'] }),
    audit({ candidateSpan: 'Claim C', verdict: 'contradicted', requiredGoldClaimIds: ['g2'] }),
    audit({ candidateSpan: 'Claim D', verdict: 'uncertain', supportingEvidenceIds: [], requiredGoldClaimIds: [] }),
  ] });
  const row = result(packet(), s).perSample[0];
  assert.equal(row.metrics.strictClaimSupportPrecision, 0.25);
  assert.equal(row.metrics.unsupportedClaimRate, 0.25);
  assert.equal(row.metrics.contradictedClaimRate, 0.25);
  assert.equal(row.metrics.unsupportedOrContradictedClaimRate, 0.5);
  assert.equal(row.metrics.uncertaintyRate, 0.25);
  assert.equal(row.metrics.goldClaimCoverageRecall, 0.5);
  assert.equal(row.metrics.sourceCitationSupportPrecision, 0.25); // Known citations do not establish entailment.
  assert.equal(row.metrics.pageCitationSupportPrecision, 0.25);
  assert.deepEqual(row.unsupportedClaims.map(claim => claim.candidateSpan), ['Claim B', 'Claim C']);
  assert.equal(row.unsupportedClaims[0].goldClaimLinks[0].goldClaim.id, 'g2');
  assert.equal(row.unsupportedClaims[0].goldClaimLinks[0].countedAsCovered, false);
  assert.deepEqual(row.uncertainClaims.map(claim => claim.candidateSpan), ['Claim D']);
});

test('source-only citations never gain page localization from judge-supplied evidence IDs', () => {
  const p = packet({ candidateCitations: [{ id: 'cite-1', sourceId: 's1', page: null }] });
  for (const citedEvidenceIds of [['cite-1'], ['s1'], ['e1']]) {
    const row = result(p, score({ claimAudits: [audit({ citedEvidenceIds })] })).perSample[0];
    assert.equal(row.metrics.sourceCitationSupportPrecision, 1);
    assert.equal(row.metrics.citationPageLocalizationCoverage, 0);
    assert.equal(row.metrics.pageCitationSupportPrecision, null);
    assert.equal(row.metrics.pageSupportedCitationCoverage, 0);
    assert.equal(row.claimAudits[0].citations[0].page, null);
  }
});

test('a supported claim cited to another source fails source correctness; wrong page fails page correctness only', () => {
  const p = packet({ candidateCitations: [{ id: 'cite-1', sourceId: 's1', page: 9 }, { id: 'cite-2', sourceId: 's2', page: 2 }] });
  const s = score({ claimAudits: [audit(), audit({ candidateSpan: 'Claim B', citedEvidenceIds: ['cite-2'] })] });
  const row = result(p, s).perSample[0];
  assert.equal(row.metrics.strictClaimSupportPrecision, 1);
  assert.equal(row.metrics.sourceCitationSupportPrecision, 0.5);
  assert.equal(row.metrics.pageCitationSupportPrecision, 0);
  assert.equal(row.metrics.citationPageLocalizationCoverage, 1);
  assert.equal(row.metrics.sourceSupportedCitationCoverage, 0.5);
  assert.equal(row.metrics.pageSupportedCitationCoverage, 0);
});

test('omitted citations have zero coverage but null correctness, and zero material/gold denominators stay null', () => {
  const p = packet({ candidateCitations: [] });
  const s = score({ claimAudits: [audit({ citedEvidenceIds: [] })] });
  const row = result(p, s).perSample[0];
  assert.equal(row.metrics.strictClaimSupportPrecision, 1);
  assert.equal(row.metrics.citationCoverage, 0);
  assert.equal(row.metrics.sourceSupportedCitationCoverage, 0);
  assert.equal(row.metrics.sourceCitationSupportPrecision, null);
  assert.equal(row.metrics.pageCitationSupportPrecision, null);
  const empty = result(packet({ gold: { ...p.gold, claims: [], answerRequirements: [] } }), score({ claimAudits: [] })).perSample[0];
  assert.equal(empty.metrics.strictClaimSupportPrecision, null);
  assert.equal(empty.metrics.goldClaimCoverageRecall, null);
  assert.equal(empty.metrics.citationCoverage, null);
  const omitted = result(packet(), score({ claimAudits: [] })).perSample[0];
  assert.equal(omitted.metrics.goldClaimCoverageRecall, 0);
});

test('missing observed citation metadata and unmappable support remain unknown, not credited or silently zero', () => {
  const p = packet(); delete p.candidateCitations;
  const missing = result(p, score({ claimAudits: [audit({ citedEvidenceIds: ['e1'] })] })).perSample[0];
  assert.equal(missing.metrics.citationCoverage, null);
  assert.equal(missing.metrics.sourceCitationSupportPrecision, null);
  assert.equal(missing.counts.unresolvedCitedReferences, 1);
  const noMap = packet({ sources: [{ sourceId: 's1', text: 'Unlocalized supplied evidence.' }, packet().sources[1]] });
  const report = result(noMap);
  const row = report.perSample[0];
  assert.equal(row.metrics.sourceCitationSupportPrecision, null);
  assert.equal(row.counts.sourceSupportUnknown, 1);
  assert.equal(row.counts.pageSupportUnknown, 1);
  assert.equal(report.byArtifactType.final_answer.metrics.sourceCitationSupportPrecision.nMissingOrZeroDenominator, 1);
});

test('citation aliases deduplicate per claim and ambiguous source/page resolution cannot gain precision', () => {
  const deduped = result(packet(), score({ claimAudits: [audit({ citedEvidenceIds: ['cite-1', 'ref-1', 's1', 'e1'] })] })).perSample[0];
  assert.equal(deduped.counts.auditedCitationReferences, 4);
  assert.equal(deduped.counts.observedClaimCitationLinks, 1);
  const p = packet({ candidateCitations: [{ id: 'one', sourceId: 's1', page: 1 }, { id: 'two', sourceId: 's1', page: 2 }] });
  const ambiguous = result(p, score({ claimAudits: [audit({ citedEvidenceIds: ['s1'] })] })).perSample[0];
  assert.equal(ambiguous.metrics.sourceCitationSupportPrecision, 1);
  assert.equal(ambiguous.metrics.pageCitationSupportPrecision, null);
  assert.equal(ambiguous.counts.ambiguousPageCitationLinks, 1);
  const conflict = packet({ candidateCitations: [{ id: 'alias', sourceId: 's1', page: 1 }, { id: 'alias', sourceId: 's2', page: 2 }] });
  const unresolved = result(conflict, score({ claimAudits: [audit({ citedEvidenceIds: ['alias'] })] })).perSample[0];
  assert.equal(unresolved.counts.unresolvedCitedReferences, 1);
  assert.equal(unresolved.metrics.sourceCitationSupportPrecision, null);
});

test('two actual page citations plus a redundant source alias remain exactly two localized links in any order', () => {
  const p = packet({ candidateCitations: [{ id: 'cite-1', sourceId: 's1', page: 1 }, { id: 'cite-2', sourceId: 's1', page: 2 }] });
  for (const citedEvidenceIds of [['cite-1', 'cite-2', 's1'], ['s1', 'cite-2', 'cite-1']]) {
    const row = result(p, score({ claimAudits: [audit({ citedEvidenceIds })] })).perSample[0];
    assert.equal(row.counts.observedClaimCitationLinks, 2);
    assert.equal(row.counts.redundantCitedReferences, 1);
    assert.equal(row.metrics.sourceCitationSupportPrecision, 1);
    assert.equal(row.metrics.citationPageLocalizationCoverage, 1);
    assert.equal(row.metrics.pageCitationSupportPrecision, 0.5);
    assert.deepEqual(row.claimAudits[0].citations.flatMap(citation => citation.actualCitationIndexes).sort(), [0, 1]);
  }
});

test('partly redundant aliases never duplicate underlying citations or gain a page by subtraction', () => {
  const p = packet({ candidateCitations: [{ id: 'cite-1', sourceId: 's1', page: 1 }, { id: 'cite-2', sourceId: 's1', page: 2 }] });
  const row = result(p, score({ claimAudits: [audit({ citedEvidenceIds: ['s1', 'cite-1'] })] })).perSample[0];
  assert.equal(row.counts.observedClaimCitationLinks, 2);
  assert.equal(row.metrics.citationPageLocalizationCoverage, 0.5);
  assert.equal(row.metrics.pageCitationSupportPrecision, 1);
  const broad = row.claimAudits[0].citations.find(citation => citation.citedId === 's1');
  assert.deepEqual(broad.actualCitationIndexes, [1]);
  assert.equal(broad.page, null);
  assert.equal(broad.pageStatus, 'ambiguous');
});

test('case means receive equal weight despite repeat counts; artifact types stay separate and CIs are reproducible', () => {
  const packets = [packet(), packet({ packetId: 'p2', repeat: 1 }), packet({ packetId: 'p3', repeat: 2 }), packet({ packetId: 'p4', caseId: 'c2' }), packet({ packetId: 'p5', artifactType: 'corpus_artifact' })];
  const scores = packets.map(p => score({ packetId: p.packetId, artifactType: p.artifactType }));
  scores[3].claimAudits = [audit({ verdict: 'unsupported', supportingEvidenceIds: [], requiredGoldClaimIds: [] })];
  const options = { seed: 11, bootstrapSamples: 200 };
  const r = aggregateGrounding(packets, scores, options);
  assert.equal(r.byArtifactType.final_answer.metrics.strictClaimSupportPrecision.mean, 0.5);
  assert.equal(r.byArtifactType.final_answer.metrics.strictClaimSupportPrecision.nSamples, 4);
  assert.equal(r.byArtifactType.final_answer.metrics.strictClaimSupportPrecision.nIndependentCases, 2);
  assert.deepEqual(r.byArtifactType.final_answer.metrics.strictClaimSupportPrecision.ci95, [0, 1]);
  assert.equal(r.byArtifactType.corpus_artifact.metrics.strictClaimSupportPrecision.mean, 1);
  assert.equal(r.byArtifactType.corpus_artifact.metrics.strictClaimSupportPrecision.ci95, null);
  assert.deepEqual(r, aggregateGrounding(packets, scores, options));
  assert.equal(r.perCase.find(row => row.caseId === 'c1' && row.artifactType === 'final_answer').nSamples, 3);
});

test('full canonical validation rejects missing/duplicate judgments, foreign IDs, and contradictory evidence metadata', () => {
  assert.throws(() => aggregateGrounding([packet()], []), /missing scores/);
  assert.throws(() => aggregateGrounding([packet()], [score(), score()]), /duplicate score/);
  assert.throws(() => result(packet(), score({ claimAudits: [audit({ requiredGoldClaimIds: ['foreign'] })] })), /outside.*scope/);
  assert.throws(() => result(packet({ sources: [...packet().sources, { sourceId: 's2', evidenceId: 'e1', page: 2, text: 'Conflicting identity.' }] })), /conflicting source/);
  assert.throws(() => aggregateGrounding([packet()], [score()], { bootstrapSamples: 0 }), /positive bootstrapSamples/);
});

test('aggregation preserves inputs and never validates extracted arithmetic', () => {
  const p = packet(), s = score({ numericClaims: [{ candidateSpan: 'Claim A', subject: 'measurement', metric: 'activity', value: 999, unit: 'wrong-units', sourceIds: ['s1'], sourceRows: [] }] });
  const before = JSON.stringify([p, s]);
  const r = result(p, s);
  assert.equal(JSON.stringify([p, s]), before);
  assert.equal(r.perSample[0].numericClaims[0].value, 999);
  assert.equal(Object.hasOwn(r, 'numericAccuracy'), false);
  assert.match(r.classification, /LLM-assisted diagnostics/);
});

test('CLI reads immediate score files, supports validated transport, hashes inputs, rejects duplicates, and never overwrites', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'eval-grounding-'));
  try {
    const packetsPath = join(dir, 'packets.json'), scoresDir = join(dir, 'judges'), output = join(dir, 'output.json');
    await mkdir(scoresDir); await mkdir(join(scoresDir, 'nested-reliability'));
    await writeFile(packetsPath, JSON.stringify({ packets: [packet()] }));
    await writeFile(join(scoresDir, 'primary.json'), JSON.stringify(aggregateJudgeScores([packet()], [score()])));
    await writeFile(join(scoresDir, 'nested-reliability', 'second.json'), JSON.stringify(score()));
    const args = ['--packets', packetsPath, '--scores', scoresDir, '--output', output, '--bootstrap-samples', '20'];
    await main(args);
    const r = JSON.parse(await readFile(output, 'utf8'));
    assert.equal(r.nSamples, 1); assert.equal(r.inputArtifacts.scoreFiles.length, 1);
    assert.match(r.inputArtifacts.packets.sha256, /^[0-9a-f]{64}$/);
    await assert.rejects(main(args), /EEXIST/);
    await writeFile(join(scoresDir, 'second.json'), JSON.stringify(score()));
    await assert.rejects(main([...args.slice(0, 5), join(dir, 'must-not-write.json')]), /duplicate score/);
    await assert.rejects(readFile(join(dir, 'must-not-write.json')), /ENOENT/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
