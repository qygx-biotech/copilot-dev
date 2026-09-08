/** Eval-only validation of independent judgments. Never produces judgments or verifies arithmetic. */
import { readFileSync } from 'node:fs';
import { bootstrapMean, quantile } from './scoring.mjs';

const contract = JSON.parse(readFileSync(new URL('../judge-contract.json', import.meta.url), 'utf8'));
export const JUDGE_CRITERIA = Object.freeze(Object.keys(contract.criteria));
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const finite = value => typeof value === 'number' && Number.isFinite(value);
const mean = values => values.length ? values.reduce((a, b) => a + b, 0) / values.length : null;
const fail = (path, message) => { throw new Error(`${path}: ${message}`); };

function exactKeys(value, keys, path) {
  if (!object(value)) fail(path, 'must be a JSON object');
  for (const key of keys) if (!Object.hasOwn(value, key)) fail(path, `missing required property ${key}`);
  for (const key of Object.keys(value)) if (!keys.includes(key)) fail(path, `unexpected property ${key}`);
}

function string(value, path, { empty = false } = {}) {
  if (typeof value !== 'string' || (!value.trim() && !(empty && value === ''))) fail(path, 'must be a nonempty string');
  return value;
}

function list(value, path) {
  if (!Array.isArray(value)) fail(path, 'must be an array');
  return value;
}

function ids(value, allowed, path, { required = false } = {}) {
  list(value, path);
  if (required && !value.length) fail(path, 'must identify at least one supplied evidence item');
  const seen = new Set();
  for (const [i, id] of value.entries()) {
    string(id, `${path}[${i}]`);
    if (seen.has(id)) fail(path, `duplicate ID ${id}`);
    if (!allowed.has(id)) fail(path, `ID ${id} is outside the supplied allowed scope`);
    seen.add(id);
  }
}

/** JSON.parse rejects prose; this parser also rejects duplicate object keys and nonfinite numbers. */
export function parseStrictJson(text, label = 'JSON') {
  if (typeof text !== 'string') fail(label, 'input must be text');
  let pos = 0;
  const space = () => { while (/[\t\n\r ]/.test(text[pos] ?? '\0')) pos++; };
  const error = message => fail(label, `${message} at character ${pos}`);
  function tokenString() {
    const start = pos++;
    while (pos < text.length) {
      const char = text[pos++];
      if (char === '\\') pos++;
      else if (char === '"') {
        try { return JSON.parse(text.slice(start, pos)); } catch { error('invalid string'); }
      }
    }
    error('unterminated string');
  }
  function value(depth = 0) {
    if (depth > 100) error('nesting exceeds 100 levels');
    space();
    const char = text[pos];
    if (char === '"') return tokenString();
    if (char === '{') {
      pos++; space();
      const result = {}; const seen = new Set();
      if (text[pos] === '}') { pos++; return result; }
      while (true) {
        space();
        if (text[pos] !== '"') error('expected an object property');
        const key = tokenString();
        if (seen.has(key)) error(`duplicate property ${key}`);
        seen.add(key); space();
        if (text[pos++] !== ':') error('expected a colon');
        Object.defineProperty(result, key, { value: value(depth + 1), enumerable: true, writable: true, configurable: true });
        space();
        const next = text[pos++];
        if (next === '}') return result;
        if (next !== ',') error('expected a comma or closing brace');
      }
    }
    if (char === '[') {
      pos++; space(); const result = [];
      if (text[pos] === ']') { pos++; return result; }
      while (true) {
        result.push(value(depth + 1)); space();
        const next = text[pos++];
        if (next === ']') return result;
        if (next !== ',') error('expected a comma or closing bracket');
      }
    }
    for (const [literal, parsed] of [['true', true], ['false', false], ['null', null]]) {
      if (text.startsWith(literal, pos)) { pos += literal.length; return parsed; }
    }
    const match = text.slice(pos).match(/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/);
    if (match) {
      pos += match[0].length;
      const number = Number(match[0]);
      if (!Number.isFinite(number)) error('nonfinite number');
      return number;
    }
    error('expected a JSON value');
  }
  const result = value(); space();
  if (pos !== text.length) error('unexpected trailing text');
  return result;
}

/** A file contains one canonical score object, or the exact transport wrapper {scores:[...]}. */
export function scoresFromDocument(document, label = 'scores') {
  if (object(document) && Object.hasOwn(document, 'scores')) {
    exactKeys(document, ['scores'], label);
    return list(document.scores, `${label}.scores`);
  }
  if (!object(document)) fail(label, 'must contain a score object or {scores:[...]}');
  return [document];
}

export function packetsFromDocument(document) {
  const packets = Array.isArray(document) ? document : document?.packets;
  list(packets, 'packets');
  if (!packets.length) fail('packets', 'must not be empty');
  return packets;
}

function referenceSet(gold) {
  const references = new Set();
  for (const requirement of gold.answerRequirements ?? []) {
    if (typeof requirement === 'string') references.add(requirement);
    else if (object(requirement)) {
      references.add(JSON.stringify(requirement));
      for (const key of ['id', 'text', 'requirement', 'claimId']) if (typeof requirement[key] === 'string') references.add(requirement[key]);
    }
  }
  return references;
}

function citedReferenceSet(packet, allowed, suppliedSourceIds, path) {
  const references = new Set(allowed);
  if (packet.candidateCitations === undefined) return references;
  for (const [i, citation] of list(packet.candidateCitations, `${path}.candidateCitations`).entries()) {
    const at = `${path}.candidateCitations[${i}]`;
    if (!object(citation)) fail(at, 'must be a citation metadata object');
    for (const key of ['id', 'reference', 'sourceId']) {
      if (citation[key] !== undefined && citation[key] !== null) string(citation[key], `${at}.${key}`);
    }
    // These are observed citation labels, not proof of support. A known source must
    // actually be supplied; gold paperIds alone cannot authorize an unresolved alias.
    if (!suppliedSourceIds.has(citation.sourceId)) continue;
    for (const key of ['id', 'reference', 'sourceId']) {
      if (typeof citation[key] === 'string') references.add(citation[key]);
    }
    // In particular, page:null never authorizes or synthesizes a passage/page locator.
  }
  return references;
}

function packetContext(packet, { pairwise = false } = {}) {
  if (!object(packet)) fail('packet', 'must be an object');
  const path = `packet ${string(packet.packetId, 'packet.packetId')}`;
  string(packet.question, `${path}.question`);
  if (!object(packet.gold)) fail(`${path}.gold`, 'frozen gold evidence metadata is required');
  const gold = packet.gold;
  for (const key of ['allowedEvidenceIds', 'claims', 'answerRequirements', 'paperIds', 'sourceRowIds']) list(gold[key], `${path}.gold.${key}`);
  const allowed = new Set(gold.allowedEvidenceIds);
  ids(gold.allowedEvidenceIds, allowed, `${path}.gold.allowedEvidenceIds`);
  const sourceIds = new Set(gold.paperIds);
  ids(gold.paperIds, sourceIds, `${path}.gold.paperIds`);
  const rowIds = new Set(gold.sourceRowIds);
  ids(gold.sourceRowIds, rowIds, `${path}.gold.sourceRowIds`);
  const claimIds = new Set();
  for (const [i, claim] of gold.claims.entries()) {
    const id = string(claim?.id, `${path}.gold.claims[${i}].id`);
    if (claimIds.has(id)) fail(path, `duplicate gold claim ${id}`);
    claimIds.add(id);
  }
  list(packet.sources, `${path}.sources`);
  const suppliedSourceIds = new Set();
  for (const [i, source] of packet.sources.entries()) {
    string(source?.sourceId, `${path}.sources[${i}].sourceId`);
    string(source?.text, `${path}.sources[${i}].text`);
    sourceIds.add(source.sourceId);
    suppliedSourceIds.add(source.sourceId);
  }
  if (allowed.size && !packet.sources.length) fail(path, 'allowed evidence requires supplied source text');
  if (pairwise) {
    exactKeys(packet.answers, ['A', 'B'], `${path}.answers`);
    for (const label of ['A', 'B']) string(packet.answers[label], `${path}.answers.${label}`, { empty: true });
  } else {
    string(packet.caseId, `${path}.caseId`);
    if (!contract.outputContract.artifactType.includes(packet.artifactType)) fail(path, 'invalid artifactType');
    string(packet.candidateAnswer, `${path}.candidateAnswer`, { empty: true });
  }
  if (packet.repeat !== undefined && (!Number.isInteger(packet.repeat) || packet.repeat < 0)) fail(path, 'repeat must be a nonnegative integer');
  return { allowed, cited: citedReferenceSet(packet, allowed, suppliedSourceIds, path), sourceIds, rowIds, claimIds, requirements: referenceSet(gold) };
}

function span(value, answer, path, { empty = false } = {}) {
  string(value, path, { empty });
  if (value && !answer.includes(value)) fail(path, 'must be an exact span in the supplied candidate answer/artifact');
}

function requirement(value, allowed, path, { empty = false } = {}) {
  string(value, path, { empty });
  if (value && !allowed.has(value)) fail(path, 'must identify an exact supplied gold requirement');
}

/** Throws on any violation; returning a score does not assert that its scientific judgment is true. */
export function validateJudgeScore(score, packet) {
  const context = packetContext(packet);
  const path = `score ${packet.packetId}`;
  exactKeys(score, contract.requiredOutput, path);
  if (score.packetId !== packet.packetId) fail(path, 'packetId mismatch');
  if (score.artifactType !== packet.artifactType) fail(path, 'artifactType mismatch');
  for (const criterion of JUDGE_CRITERIA) {
    const value = score[criterion];
    if (criterion === 'synthesis' && value === null) continue;
    if (!Number.isInteger(value) || value < 1 || value > 5) fail(`${path}.${criterion}`, 'must be an integer from 1 through 5');
  }
  if (!contract.outputContract.confidence.includes(score.confidence)) fail(path, 'invalid confidence');
  for (const [i, error] of list(score.criticalErrors, `${path}.criticalErrors`).entries()) {
    const at = `${path}.criticalErrors[${i}]`;
    exactKeys(error, ['candidateSpan', 'goldEvidenceIds', 'issue'], at);
    span(error.candidateSpan, packet.candidateAnswer, `${at}.candidateSpan`);
    ids(error.goldEvidenceIds, context.allowed, `${at}.goldEvidenceIds`, { required: true });
    string(error.issue, `${at}.issue`);
  }
  for (const [i, missing] of list(score.missingPoints, `${path}.missingPoints`).entries()) {
    const at = `${path}.missingPoints[${i}]`;
    exactKeys(missing, ['goldRequirement', 'goldEvidenceIds', 'omission'], at);
    requirement(missing.goldRequirement, context.requirements, `${at}.goldRequirement`);
    ids(missing.goldEvidenceIds, context.allowed, `${at}.goldEvidenceIds`, { required: true });
    string(missing.omission, `${at}.omission`);
  }
  const justified = new Set();
  for (const [i, evidence] of list(score.lowScoreEvidence, `${path}.lowScoreEvidence`).entries()) {
    const at = `${path}.lowScoreEvidence[${i}]`;
    exactKeys(evidence, ['criterion', 'candidateSpan', 'goldRequirement', 'goldEvidenceIds', 'issue'], at);
    if (!JUDGE_CRITERIA.includes(evidence.criterion)) fail(at, 'unknown criterion');
    if (score[evidence.criterion] === null || score[evidence.criterion] > 3) fail(at, 'criterion is not scored 1 through 3');
    span(evidence.candidateSpan, packet.candidateAnswer, `${at}.candidateSpan`, { empty: true });
    requirement(evidence.goldRequirement, context.requirements, `${at}.goldRequirement`, { empty: Boolean(evidence.candidateSpan) });
    ids(evidence.goldEvidenceIds, context.allowed, `${at}.goldEvidenceIds`, { required: true });
    string(evidence.issue, `${at}.issue`);
    justified.add(evidence.criterion);
  }
  for (const criterion of JUDGE_CRITERIA) {
    if (score[criterion] !== null && score[criterion] <= 3 && !justified.has(criterion)) fail(path, `missing actionable lowScoreEvidence for ${criterion}`);
  }
  for (const [i, audit] of list(score.claimAudits, `${path}.claimAudits`).entries()) {
    const at = `${path}.claimAudits[${i}]`;
    exactKeys(audit, ['candidateSpan', 'citedEvidenceIds', 'supportingEvidenceIds', 'verdict', 'requiredGoldClaimIds'], at);
    span(audit.candidateSpan, packet.candidateAnswer, `${at}.candidateSpan`);
    ids(audit.citedEvidenceIds, context.cited, `${at}.citedEvidenceIds`);
    ids(audit.supportingEvidenceIds, context.allowed, `${at}.supportingEvidenceIds`, { required: audit.verdict === 'supported' || audit.verdict === 'contradicted' });
    ids(audit.requiredGoldClaimIds, context.claimIds, `${at}.requiredGoldClaimIds`);
    if (!['supported', 'contradicted', 'unsupported', 'uncertain'].includes(audit.verdict)) fail(at, 'invalid verdict');
  }
  for (const [i, claim] of list(score.numericClaims, `${path}.numericClaims`).entries()) {
    const at = `${path}.numericClaims[${i}]`;
    exactKeys(claim, ['candidateSpan', 'subject', 'metric', 'value', 'unit', 'sourceIds', 'sourceRows'], at);
    span(claim.candidateSpan, packet.candidateAnswer, `${at}.candidateSpan`);
    string(claim.subject, `${at}.subject`); string(claim.metric, `${at}.metric`);
    if (!finite(claim.value) && !(typeof claim.value === 'string' && claim.value.trim())) fail(at, 'value must be a finite number or nonempty literal extraction');
    string(claim.unit, `${at}.unit`, { empty: true });
    ids(claim.sourceIds, context.sourceIds, `${at}.sourceIds`);
    ids(claim.sourceRows, context.rowIds, `${at}.sourceRows`);
  }
  return score;
}

function validateBatch(packets, scores, validator, options) {
  list(packets, 'packets'); list(scores, 'scores');
  if (!packets.length) fail('packets', 'must not be empty');
  const index = new Map();
  for (const packet of packets) {
    packetContext(packet, options);
    if (index.has(packet.packetId)) fail('packets', `duplicate packetId ${packet.packetId}`);
    index.set(packet.packetId, packet);
  }
  const seen = new Set();
  for (const score of scores) {
    const id = score?.packetId;
    if (!index.has(id)) fail('scores', `unknown packetId ${id}`);
    if (seen.has(id)) fail('scores', `duplicate score for packetId ${id}`);
    validator(score, index.get(id)); seen.add(id);
  }
  const missing = [...index.keys()].filter(id => !seen.has(id));
  if (missing.length) fail('scores', `missing scores for packetIds: ${missing.join(', ')}`);
  return scores;
}

export function validateJudgeScores(packets, scores) {
  return validateBatch(packets, scores, validateJudgeScore);
}

function statistics(samples, options) {
  const groups = new Map();
  for (const sample of samples) {
    if (!groups.has(sample.cluster)) groups.set(sample.cluster, []);
    groups.get(sample.cluster).push(sample.value);
  }
  const caseMeans = [...groups.values()].map(mean);
  const estimate = mean(caseMeans);
  const variance = caseMeans.length < 2 ? null : caseMeans.reduce((sum, value) => sum + (value - estimate) ** 2, 0) / (caseMeans.length - 1);
  const bootstrap = bootstrapMean(samples, options);
  return {
    mean: estimate, median: quantile(caseMeans, 0.5), variance, ci95: bootstrap.ci95,
    nIndependentCases: caseMeans.length, nSamples: samples.length,
    estimand: 'Equal-weight case means; median and sample variance are across case means.',
    bootstrap: { method: bootstrap.method, seed: bootstrap.seed, samples: bootstrap.bootstrapSamples },
    ...(bootstrap.uncertainty ? { uncertainty: bootstrap.uncertainty } : {}),
  };
}

function validateOptions(options) {
  if (options.seed !== undefined && !Number.isInteger(options.seed)) fail('seed', 'must be an integer');
  if (options.bootstrapSamples !== undefined && (!Number.isInteger(options.bootstrapSamples) || options.bootstrapSamples < 1)) fail('bootstrapSamples', 'must be a positive integer');
}

/** Final answers and corpus artifacts deliberately never share a pooled score. */
export function aggregateJudgeScores(packets, scores, options = {}) {
  validateOptions(options); validateJudgeScores(packets, scores);
  const index = new Map(packets.map(packet => [packet.packetId, packet]));
  const byArtifactType = {};
  for (const artifactType of contract.outputContract.artifactType) {
    const rows = scores.filter(score => score.artifactType === artifactType);
    if (!rows.length) continue;
    byArtifactType[artifactType] = {
      nSamples: rows.length,
      nIndependentCases: new Set(rows.map(row => index.get(row.packetId).caseId)).size,
      dimensions: Object.fromEntries(JUDGE_CRITERIA.map(criterion => [criterion, {
        ...statistics(rows.filter(row => row[criterion] !== null).map(row => ({ value: row[criterion], cluster: index.get(row.packetId).caseId })), options),
        nInapplicable: rows.filter(row => row[criterion] === null).length,
      }])),
      criticalErrorCount: rows.reduce((sum, row) => sum + row.criticalErrors.length, 0),
      missingPointCount: rows.reduce((sum, row) => sum + row.missingPoints.length, 0),
      confidenceCounts: Object.fromEntries(contract.outputContract.confidence.map(level => [level, rows.filter(row => row.confidence === level).length])),
    };
  }
  return {
    schemaVersion: 'independent-judge-results-v1', contractVersion: contract.version,
    mode: 'absolute', nSamples: scores.length, nIndependentCases: new Set(packets.map(packet => packet.caseId)).size,
    byArtifactType, scores,
    limitations: [
      'Validation checks structure, exact spans and allowed references; it does not certify semantic entailment or exhaustiveness of claim audits.',
      'Numeric claims are extraction only and require a separate deterministic arithmetic and provenance check.',
      'Judge scores never override deterministic permission, security or other hard gates.',
    ],
  };
}

export function validatePairwiseScore(score, packet) {
  const context = packetContext(packet, { pairwise: true });
  const path = `pairwise score ${packet.packetId}`;
  exactKeys(score, contract.pairwise.requiredOutput, path);
  if (score.packetId !== packet.packetId) fail(path, 'packetId mismatch');
  if (!contract.pairwise.winner.includes(score.winner)) fail(path, 'invalid winner');
  if (!contract.outputContract.confidence.includes(score.confidence)) fail(path, 'invalid confidence');
  const reasons = list(score.reasons, `${path}.reasons`);
  if (!reasons.length) fail(path, 'at least one evidence-grounded reason is required');
  for (const [i, reason] of reasons.entries()) {
    const at = `${path}.reasons[${i}]`;
    exactKeys(reason, ['criterion', 'answerASpan', 'answerBSpan', 'goldEvidenceIds', 'explanation'], at);
    if (!JUDGE_CRITERIA.includes(reason.criterion)) fail(at, 'unknown criterion');
    span(reason.answerASpan, packet.answers.A, `${at}.answerASpan`, { empty: true });
    span(reason.answerBSpan, packet.answers.B, `${at}.answerBSpan`, { empty: true });
    if (!reason.answerASpan && !reason.answerBSpan && (packet.answers.A || packet.answers.B)) fail(at, 'at least one exact answer span is required');
    ids(reason.goldEvidenceIds, context.allowed, `${at}.goldEvidenceIds`, { required: true });
    string(reason.explanation, `${at}.explanation`);
  }
  return score;
}

export function validatePairwiseScores(packets, scores) {
  return validateBatch(packets, scores, validatePairwiseScore, { pairwise: true });
}

/** Identity mapping is optional, separate, explicit, and consulted only after judgments validate. */
export function aggregatePairwiseScores(packets, scores, mapping, options = {}) {
  validateOptions(options); validatePairwiseScores(packets, scores);
  const result = { schemaVersion: 'independent-judge-results-v1', contractVersion: contract.version, mode: 'pairwise', nSamples: scores.length, scores };
  if (mapping === undefined || mapping === null) return { ...result, identityRates: null, status: 'Validated blinded judgments; identity rates require a separate explicit order mapping.' };
  const rows = Array.isArray(mapping) ? mapping : mapping?.orderMapping;
  list(rows, 'orderMapping');
  const index = new Map(); const packetIndex = new Map(packets.map(packet => [packet.packetId, packet]));
  for (const [i, entry] of rows.entries()) {
    const path = `orderMapping[${i}]`;
    exactKeys(entry, ['packetId', 'caseId', 'repeat', 'A', 'B'], path);
    string(entry.caseId, `${path}.caseId`);
    if (!Number.isInteger(entry.repeat) || entry.repeat < 0) fail(path, 'repeat must be a nonnegative integer');
    if (index.has(entry.packetId) || !packetIndex.has(entry.packetId)) fail(path, 'duplicate or unknown packetId');
    if (!['candidate', 'baseline'].includes(entry.A) || !['candidate', 'baseline'].includes(entry.B) || entry.A === entry.B) fail(path, 'A/B must explicitly map to different candidate/baseline identities');
    const packet = packetIndex.get(entry.packetId);
    if (packet.caseId !== undefined && packet.caseId !== entry.caseId) fail(path, 'caseId mismatch');
    if (packet.repeat !== undefined && packet.repeat !== entry.repeat) fail(path, 'repeat mismatch');
    index.set(entry.packetId, entry);
  }
  if (index.size !== scores.length) fail('orderMapping', 'must cover every validated score exactly once');
  const outcomes = scores.map(score => {
    const entry = index.get(score.packetId);
    return { cluster: entry.caseId, winner: ['A', 'B'].includes(score.winner) ? entry[score.winner] : score.winner };
  });
  const judgeable = outcomes.filter(row => row.winner !== 'unjudgeable');
  return {
    ...result, nIndependentCases: new Set(outcomes.map(row => row.cluster)).size,
    nJudgeableSamples: judgeable.length, nUnjudgeableSamples: outcomes.length - judgeable.length,
    identityRates: Object.fromEntries(['candidate', 'baseline', 'tie'].map(winner => [winner, {
      ...statistics(judgeable.map(row => ({ cluster: row.cluster, value: Number(row.winner === winner) })), options),
      count: judgeable.filter(row => row.winner === winner).length,
    }])),
    denominator: 'Judgeable samples, averaged within each case and then equally across independent cases. Unjudgeable judgments are excluded and counted separately.',
  };
}
