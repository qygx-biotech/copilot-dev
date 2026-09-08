import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  aggregateJudgeScores, aggregatePairwiseScores, JUDGE_CRITERIA,
  parseStrictJson, scoresFromDocument, validateJudgeScore, validateJudgeScores, validatePairwiseScore,
} from '../lib/judge-results.mjs';

// Synthetic fixtures only: no baseline, candidate run, production source, or real judge output.
const packet = (overrides = {}) => ({
  packetId: 'packet-1', caseId: 'case-1', repeat: 0, artifactType: 'final_answer',
  question: 'Report the measured activity and distinguish it from yield.',
  candidateAnswer: 'Measured activity was 12 U/mL [e1]. Yield was not measured.',
  gold: {
    allowedEvidenceIds: ['e1'], paperIds: ['source-1'], sourceRowIds: ['row-1'],
    claims: [{ id: 'claim-1', subject: 'activity', value: 12, evidenceIds: ['e1'] }],
    answerRequirements: [{ id: 'req-1', text: 'Distinguish activity from yield.', claimId: 'claim-1' }],
  },
  sources: [{ sourceId: 'source-1', evidenceId: 'e1', text: 'Measured activity: 12 U/mL. Yield was not measured.' }],
  ...overrides,
});
const score = (overrides = {}) => ({
  packetId: 'packet-1', artifactType: 'final_answer',
  ...Object.fromEntries(JUDGE_CRITERIA.map(criterion => [criterion, 5])),
  criticalErrors: [], missingPoints: [], lowScoreEvidence: [],
  claimAudits: [{ candidateSpan: 'Measured activity was 12 U/mL', citedEvidenceIds: ['e1'], supportingEvidenceIds: ['e1'], verdict: 'supported', requiredGoldClaimIds: ['claim-1'] }],
  numericClaims: [{ candidateSpan: '12 U/mL', subject: 'measurement', metric: 'activity', value: 12, unit: 'U/mL', sourceIds: ['source-1'], sourceRows: ['row-1'] }],
  confidence: 'high', ...overrides,
});
const lowEvidence = (overrides = {}) => ({
  criterion: 'correctness', candidateSpan: 'Measured activity was 12 U/mL', goldRequirement: '', goldEvidenceIds: ['e1'],
  issue: 'Explain that the cited measurement is activity and cannot establish yield.', ...overrides,
});

test('strict JSON rejects prose, Markdown, duplicate keys and nonfinite literals; transport has no extra properties', () => {
  assert.deepEqual(parseStrictJson(' {"x":[1,true,null,"quote\\\"" ]} '), { x: [1, true, null, 'quote"'] });
  for (const input of ['```json\n{}\n```', '{} trailing', '{"a":1,"a":2}', '{"a":{"x":1,"x":2}}', '{"n":1e999}', '{"n":01}', '{"n":NaN}', '{"x":1,}']) {
    assert.throws(() => parseStrictJson(input));
  }
  assert.throws(() => scoresFromDocument({ scores: [], explanation: 'best response' }), /unexpected property/);
  assert.throws(() => scoresFromDocument([score()]), /score object/);
  assert.deepEqual(scoresFromDocument(score()), [score()]);
});

test('requires every dimension, integer 1–5, exact keys at every score level and synthesis-only null', () => {
  assert.equal(validateJudgeScore(score({ synthesis: null }), packet()).synthesis, null);
  for (const criterion of JUDGE_CRITERIA) {
    const missing = score(); delete missing[criterion];
    assert.throws(() => validateJudgeScore(missing, packet()), /missing required/);
    for (const value of [0, 6, 4.5, '5', true, NaN]) assert.throws(() => validateJudgeScore(score({ [criterion]: value }), packet()), /integer/);
    if (criterion !== 'synthesis') assert.throws(() => validateJudgeScore(score({ [criterion]: null }), packet()), /integer/);
  }
  assert.throws(() => validateJudgeScore(score({ freeProse: 'This answer is strong.' }), packet()), /unexpected/);
  const nested = score(); nested.claimAudits[0].rationale = 'hidden thoughts';
  assert.throws(() => validateJudgeScore(nested, packet()), /unexpected property rationale/);
  assert.throws(() => validateJudgeScore(score({ confidence: 'certain' }), packet()), /confidence/);
});

test('every low criterion needs a literal candidate span and allowed gold evidence, with an exact-requirement omission escape', () => {
  assert.throws(() => validateJudgeScore(score({ correctness: 3 }), packet()), /missing actionable.*correctness/);
  const valid = score({ correctness: 3, lowScoreEvidence: [lowEvidence()] });
  assert.equal(validateJudgeScore(valid, packet()), valid);
  for (const evidence of [lowEvidence({ candidateSpan: 'invented span' }), lowEvidence({ candidateSpan: ' ' }), lowEvidence({ goldEvidenceIds: [] }), lowEvidence({ goldEvidenceIds: ['foreign'] }), lowEvidence({ issue: '' }), lowEvidence({ candidateSpan: '', goldRequirement: 'vague omission' })]) {
    assert.throws(() => validateJudgeScore(score({ correctness: 3, lowScoreEvidence: [evidence] }), packet()));
  }
  assert.throws(() => validateJudgeScore(score({ correctness: 3, completeness: 2, lowScoreEvidence: [lowEvidence()] }), packet()), /missing actionable.*completeness/);
  const omission = score({ completeness: 2, lowScoreEvidence: [lowEvidence({ criterion: 'completeness', candidateSpan: '', goldRequirement: 'req-1' })] });
  assert.equal(validateJudgeScore(omission, packet()), omission);
  assert.throws(() => validateJudgeScore(score({ lowScoreEvidence: [lowEvidence()] }), packet()), /not scored/);
});

test('all critiques, audits, and numeric extractions enforce supplied spans and allowed evidence/source/row/claim IDs', () => {
  const variants = [
    { criticalErrors: [{ candidateSpan: 'absent', goldEvidenceIds: ['e1'], issue: 'Wrong measurement.' }] },
    { missingPoints: [{ goldRequirement: 'not-a-requirement', goldEvidenceIds: ['e1'], omission: 'Missing requested distinction.' }] },
    { claimAudits: [{ ...score().claimAudits[0], supportingEvidenceIds: [] }] },
    { claimAudits: [{ ...score().claimAudits[0], requiredGoldClaimIds: ['foreign'] }] },
    { claimAudits: [{ ...score().claimAudits[0], citedEvidenceIds: ['foreign'] }] },
    { numericClaims: [{ ...score().numericClaims[0], sourceIds: ['foreign'] }] },
    { numericClaims: [{ ...score().numericClaims[0], sourceRows: ['foreign'] }] },
    { numericClaims: [{ ...score().numericClaims[0], candidateSpan: 'not present' }] },
  ];
  for (const variant of variants) assert.throws(() => validateJudgeScore(score(variant), packet()));
  // Wrong extracted arithmetic is intentionally not accepted as verified merely by schema validation.
  const extraction = score({ numericClaims: [{ ...score().numericClaims[0], value: 999 }] });
  const report = aggregateJudgeScores([packet()], [extraction]);
  assert.equal(report.scores[0].numericClaims[0].value, 999);
  assert.ok(report.limitations.some(text => text.includes('separate deterministic arithmetic')));
  assert.equal(Object.hasOwn(report, 'arithmeticAccuracy'), false);
});

test('source-level citation metadata with page:null authorizes observed labels only, without inventing supporting passage IDs', () => {
  const supplied = packet({
    candidateAnswer: 'Measured activity was 12 U/mL [citation-1]. Yield was not measured.',
    candidateCitations: [{ id: 'citation-1', reference: 'ref-source-1', sourceId: 'source-1', page: null }],
  });
  const original = JSON.stringify(supplied);
  const audit = score().claimAudits[0];
  for (const citedId of ['e1', 'source-1', 'citation-1', 'ref-source-1']) {
    const judged = score({ claimAudits: [{ ...audit, citedEvidenceIds: [citedId] }] });
    assert.equal(validateJudgeScore(judged, supplied), judged);
    assert.deepEqual(judged.claimAudits[0].supportingEvidenceIds, ['e1']);
  }
  assert.equal(JSON.stringify(supplied), original);
  assert.equal(supplied.candidateCitations[0].page, null);
  assert.throws(() => validateJudgeScore(score({ claimAudits: [{ ...audit, citedEvidenceIds: ['source-1:p1'] }] }), supplied), /outside.*scope/);
  assert.throws(() => validateJudgeScore(score({ claimAudits: [{ ...audit, supportingEvidenceIds: ['source-1'] }] }), supplied), /supportingEvidenceIds/);
  assert.throws(() => validateJudgeScore(score({ correctness: 3, lowScoreEvidence: [lowEvidence({ goldEvidenceIds: ['citation-1'] })] }), supplied), /goldEvidenceIds/);
  assert.throws(() => validateJudgeScore(score({ claimAudits: [{ ...audit, citedEvidenceIds: ['source-1'] }] }), packet()), /citedEvidenceIds/);

  // Citation validity does not convert an unsupported scientific claim into support.
  const unsupported = score({ claimAudits: [{ ...audit, citedEvidenceIds: ['source-1'], supportingEvidenceIds: [], verdict: 'unsupported' }] });
  assert.equal(validateJudgeScore(unsupported, supplied).claimAudits[0].verdict, 'unsupported');
  const fabricated = packet({
    candidateAnswer: 'Measured activity was 12 U/mL [fake-citation].',
    gold: { ...packet().gold, paperIds: ['source-1', 'unsupplied-source'] },
    candidateCitations: [{ id: 'fake-citation', sourceId: 'unsupplied-source', page: null }],
  });
  for (const citedId of ['fake-citation', 'unsupplied-source']) {
    assert.throws(() => validateJudgeScore(score({ claimAudits: [{ ...audit, citedEvidenceIds: [citedId], supportingEvidenceIds: [], verdict: 'unsupported' }] }), fabricated), /citedEvidenceIds/);
  }
  const unresolvedAudit = score({ claimAudits: [{ ...audit, candidateSpan: '[fake-citation]', citedEvidenceIds: [], supportingEvidenceIds: [], verdict: 'unsupported', requiredGoldClaimIds: [] }] });
  assert.equal(validateJudgeScore(unresolvedAudit, fabricated).claimAudits[0].verdict, 'unsupported');
});

test('batch validation rejects missing, duplicate, unknown or mismatched packet/artifact identities and missing frozen evidence', () => {
  assert.throws(() => validateJudgeScores([packet()], []), /missing scores/);
  assert.throws(() => validateJudgeScores([packet()], [score(), score()]), /duplicate score/);
  assert.throws(() => validateJudgeScores([packet(), packet()], [score()]), /duplicate packetId/);
  assert.throws(() => validateJudgeScores([packet()], [score({ packetId: 'unknown' })]), /unknown packetId/);
  assert.throws(() => validateJudgeScore(score({ artifactType: 'corpus_artifact' }), packet()), /artifactType/);
  assert.throws(() => validateJudgeScores([packet({ sources: [] })], [score()]), /source text/);
  assert.throws(() => validateJudgeScores([packet({ caseId: '' })], [score()]), /nonempty/);
});

test('artifact-separated statistics weight independent cases equally despite unequal repeats and use reproducible cluster CIs', () => {
  const packets = [packet(), packet({ packetId: 'p2', repeat: 1 }), packet({ packetId: 'p3', caseId: 'case-2' }), packet({ packetId: 'p4', artifactType: 'corpus_artifact' })];
  const scores = [score(), score({ packetId: 'p2' }), score({ packetId: 'p3', correctness: 1, lowScoreEvidence: [lowEvidence()] }), score({ packetId: 'p4', artifactType: 'corpus_artifact', synthesis: null })];
  const options = { seed: 17, bootstrapSamples: 100 };
  const result = aggregateJudgeScores(packets, scores, options);
  const dimension = result.byArtifactType.final_answer.dimensions.correctness;
  assert.equal(dimension.mean, 3); assert.equal(dimension.median, 3); assert.equal(dimension.variance, 8);
  assert.equal(dimension.nSamples, 3); assert.equal(dimension.nIndependentCases, 2);
  assert.deepEqual(dimension.ci95, [1, 5]);
  assert.deepEqual(result, aggregateJudgeScores(packets, scores, options));
  assert.equal(result.byArtifactType.corpus_artifact.dimensions.correctness.ci95, null);
  assert.equal(result.byArtifactType.corpus_artifact.dimensions.synthesis.mean, null);
  assert.equal(result.byArtifactType.corpus_artifact.dimensions.synthesis.nInapplicable, 1);
  assert.equal(result.nIndependentCases, 2); assert.equal(result.nSamples, 4);
  assert.throws(() => aggregateJudgeScores(packets, scores, { bootstrapSamples: 0 }), /positive integer/);
});

const pairPacket = (overrides = {}) => packet({ answers: { A: 'Activity was 12 U/mL.', B: 'Yield was 12 U/mL.' }, ...overrides });
const pairScore = (overrides = {}) => ({
  packetId: 'packet-1', winner: 'A', confidence: 'high',
  reasons: [{ criterion: 'correctness', answerASpan: 'Activity was 12 U/mL.', answerBSpan: 'Yield was 12 U/mL.', goldEvidenceIds: ['e1'], explanation: 'The supplied source reports activity; B labels that measurement as yield.' }], ...overrides,
});

test('pairwise validates blinded judgments without identity rates; explicit mapping controls cluster-weighted outcomes', () => {
  const packets = [pairPacket(), pairPacket({ packetId: 'p2', repeat: 1 }), pairPacket({ packetId: 'p3', caseId: 'case-2' }), pairPacket({ packetId: 'p4', caseId: 'case-3' })];
  const scores = [pairScore(), pairScore({ packetId: 'p2' }), pairScore({ packetId: 'p3', winner: 'tie' }), pairScore({ packetId: 'p4', winner: 'unjudgeable' })];
  assert.equal(aggregatePairwiseScores(packets, scores).identityRates, null);
  const mapping = packets.map(p => ({ packetId: p.packetId, caseId: p.caseId, repeat: p.repeat, A: 'baseline', B: 'candidate' }));
  const result = aggregatePairwiseScores(packets, scores, { orderMapping: mapping }, { seed: 3, bootstrapSamples: 100 });
  assert.equal(result.identityRates.baseline.mean, .5); assert.equal(result.identityRates.candidate.mean, 0); assert.equal(result.identityRates.tie.mean, .5);
  assert.equal(result.nUnjudgeableSamples, 1); assert.equal(result.nJudgeableSamples, 3);
  assert.equal(result.identityRates.baseline.nIndependentCases, 2);
  assert.throws(() => aggregatePairwiseScores(packets, scores, mapping.slice(1)), /cover every/);
  assert.throws(() => aggregatePairwiseScores(packets, scores, mapping.map(row => ({ ...row, A: 'candidate', B: 'candidate' }))), /different/);
  assert.throws(() => validatePairwiseScore(pairScore({ winner: 'candidate' }), pairPacket()), /winner/);
  assert.throws(() => validatePairwiseScore(pairScore({ reasons: [] }), pairPacket()), /reason/);
  assert.throws(() => validatePairwiseScore(pairScore({ reasons: [{ ...pairScore().reasons[0], answerASpan: 'invented' }] }), pairPacket()), /exact span/);
});

test('CLI ingests a score directory, refuses existing output, rejects malformed scores without creating a report', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'judge-validator-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const cli = fileURLToPath(new URL('../judge-results.mjs', import.meta.url));
  const packetPath = join(dir, 'packets.json'); const scoreDir = join(dir, 'scores'); const output = join(dir, 'summary.json');
  await mkdir(scoreDir);
  await writeFile(packetPath, JSON.stringify({ packets: [packet()] }));
  await writeFile(join(scoreDir, 'judge-1.json'), JSON.stringify(score()));
  const args = [cli, '--packets', packetPath, '--scores', scoreDir, '--output', output];
  const first = spawnSync(process.execPath, args, { encoding: 'utf8' });
  assert.equal(first.status, 0, first.stderr);
  const original = await readFile(output, 'utf8');
  assert.equal(JSON.parse(original).nSamples, 1);
  const second = spawnSync(process.execPath, args, { encoding: 'utf8' });
  assert.equal(second.status, 1); assert.match(second.stderr, /EEXIST/);
  assert.equal(await readFile(output, 'utf8'), original);
  await writeFile(join(scoreDir, 'judge-1.json'), JSON.stringify(score({ overall: 3 })));
  const badOutput = join(dir, 'rejected.json');
  const bad = spawnSync(process.execPath, [...args.slice(0, -1), badOutput], { encoding: 'utf8' });
  assert.equal(bad.status, 1); assert.match(bad.stderr, /missing actionable/);
  await assert.rejects(readFile(badOutput), { code: 'ENOENT' });
});

test('pairwise CLI validates scores before opening a missing identity mapping', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'judge-blind-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const cli = fileURLToPath(new URL('../judge-results.mjs', import.meta.url));
  await writeFile(join(dir, 'packets.json'), JSON.stringify({ packets: [pairPacket()] }));
  await writeFile(join(dir, 'scores.json'), JSON.stringify(pairScore({ winner: 'candidate' })));
  const result = spawnSync(process.execPath, [cli, '--packets', join(dir, 'packets.json'), '--scores', join(dir, 'scores.json'), '--output', join(dir, 'out.json'), '--mode', 'pairwise', '--mapping', join(dir, 'absent.json')], { encoding: 'utf8' });
  assert.equal(result.status, 1); assert.match(result.stderr, /invalid winner/); assert.doesNotMatch(result.stderr, /ENOENT/);
});
