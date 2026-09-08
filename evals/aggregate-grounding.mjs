#!/usr/bin/env node
/** Eval-only aggregation of external claim audits. Never generates semantic judgments. */
import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { bootstrapMean } from './lib/scoring.mjs';
import { packetsFromDocument, parseStrictJson, scoresFromDocument, validateJudgeScores } from './lib/judge-results.mjs';

export const GROUNDING_AGGREGATION_VERSION = '1.0.1';
const mean = values => values.length ? values.reduce((a, b) => a + b, 0) / values.length : null;
const ratio = (numerator, denominator) => denominator ? numerator / denominator : null;
const pageNumber = value => Number.isInteger(value) && value > 0 ? value : null;
const distinct = values => [...new Set(values)];
const METRICS = [
  'strictClaimSupportPrecision', 'unsupportedClaimRate', 'contradictedClaimRate',
  'unsupportedOrContradictedClaimRate', 'uncertaintyRate', 'goldClaimCoverageRecall',
  'citationCoverage', 'sourceCitationSupportPrecision', 'pageCitationSupportPrecision',
  'citationPageLocalizationCoverage', 'sourceSupportedCitationCoverage', 'pageSupportedCitationCoverage',
];

function sourceIndex(packet) {
  const evidence = new Map();
  for (const source of packet.sources) {
    if (typeof source.evidenceId !== 'string') continue;
    const identity = { sourceId: source.sourceId, page: pageNumber(source.page) };
    const previous = evidence.get(source.evidenceId);
    if (previous && (previous.sourceId !== identity.sourceId || previous.page !== identity.page)) {
      throw new Error(`${packet.packetId}: conflicting source/page metadata for ${source.evidenceId}`);
    }
    evidence.set(source.evidenceId, identity);
  }
  return evidence;
}

/** Resolve only supplied observed citation metadata. A judge's gold passage ID cannot invent a page locator. */
function resolveCitation(id, packet, evidence) {
  if (!Array.isArray(packet.candidateCitations)) {
    return { citedId: id, status: 'unknown', reason: 'Observed candidate citation metadata is unavailable.' };
  }
  let matches = packet.candidateCitations.filter(citation => citation.id === id || citation.reference === id);
  if (!matches.length) matches = packet.candidateCitations.filter(citation => citation.sourceId === id);
  // The judge contract permits an evidence ID as shorthand. Resolve its source to
  // actual metadata, but keep the actual citation page (including null), never the gold page.
  if (!matches.length && evidence.has(id)) matches = packet.candidateCitations.filter(citation => citation.sourceId === evidence.get(id).sourceId);
  const suppliedSources = new Set(packet.sources.map(source => source.sourceId));
  matches = matches.filter(citation => suppliedSources.has(citation.sourceId));
  const sources = distinct(matches.map(citation => citation.sourceId));
  if (sources.length !== 1) return { citedId: id, status: 'unknown', reason: sources.length ? 'Citation alias resolves to multiple sources.' : 'No matching observed citation metadata.' };
  const pages = distinct(matches.map(citation => pageNumber(citation.page)));
  const page = pages.length === 1 ? pages[0] : null;
  return {
    citedId: id, status: 'observed', sourceId: sources[0], page,
    pageStatus: pages.length > 1 ? 'ambiguous' : page === null ? 'not_localized' : 'localized',
    actualCitationIndexes: matches.map(citation => packet.candidateCitations.indexOf(citation)),
    actualCitationIds: distinct(matches.flatMap(citation => [citation.id, citation.reference].filter(value => typeof value === 'string'))),
  };
}

function citationSupport(citation, audit, evidence) {
  const mapped = audit.supportingEvidenceIds.map(id => ({ evidenceId: id, ...evidence.get(id) }));
  const unmapped = audit.supportingEvidenceIds.filter(id => !evidence.has(id));
  // A known citation or located passage is never enough: the independent judge
  // must have judged this material claim supported, and identified supporting evidence.
  if (audit.verdict !== 'supported') return { sourceSupported: 0, pageSupported: citation.page === null ? null : 0, unmappedSupportingEvidenceIds: unmapped };
  const sameSource = mapped.filter(item => item.sourceId === citation.sourceId);
  const sourceSupported = sameSource.length ? 1 : unmapped.length ? null : 0;
  let pageSupported = null;
  if (citation.page !== null) {
    if (sameSource.some(item => item.page === citation.page)) pageSupported = 1;
    else if (unmapped.length || sameSource.some(item => item.page === null)) pageSupported = null;
    else pageSupported = 0;
  }
  return { sourceSupported, pageSupported, unmappedSupportingEvidenceIds: unmapped };
}

function sampleGrounding(packet, score) {
  const evidence = sourceIndex(packet);
  const citationMetadataAvailable = Array.isArray(packet.candidateCitations);
  const claims = score.claimAudits.map((audit, auditIndex) => {
    const resolutions = audit.citedEvidenceIds.map(id => resolveCitation(id, packet, evidence));
    const observed = new Map();
    const assignedCitationIndexes = new Set();
    const redundantCitedReferences = [];
    // Resolve narrower actual references first. For c1->s1:p1, c2->s1:p2,
    // a further s1 alias must not add a third, unlocalized citation link.
    const ordered = resolutions.filter(item => item.status === 'observed')
      .sort((a, b) => a.actualCitationIndexes.length - b.actualCitationIndexes.length);
    for (const citation of ordered) {
      const freshIndexes = citation.actualCitationIndexes.filter(index => !assignedCitationIndexes.has(index));
      if (!freshIndexes.length) {
        redundantCitedReferences.push(citation);
        continue;
      }
      for (const index of freshIndexes) assignedCitationIndexes.add(index);
      // Keep the original locator uncertainty when a broad alias partly overlaps
      // an explicit reference: deduplication cannot invent a more precise page.
      const key = JSON.stringify(freshIndexes);
      observed.set(key, {
        ...citation, actualCitationIndexes: freshIndexes,
        actualCitationIds: distinct(freshIndexes.flatMap(index => [packet.candidateCitations[index].id, packet.candidateCitations[index].reference].filter(value => typeof value === 'string'))),
        citedIds: [citation.citedId],
      });
    }
    const citations = [...observed.values()].map(citation => ({ ...citation, ...citationSupport(citation, audit, evidence) }));
    return {
      auditIndex, ...audit, citations,
      redundantCitedReferences,
      unresolvedCitedReferences: resolutions.filter(item => item.status !== 'observed'),
      goldClaimLinks: audit.requiredGoldClaimIds.map(id => ({
        goldClaim: packet.gold.claims.find(claim => claim.id === id),
        answerRequirements: packet.gold.answerRequirements.filter(requirement => requirement?.claimId === id),
        countedAsCovered: audit.verdict === 'supported',
      })),
    };
  });
  const counts = Object.fromEntries(['supported', 'unsupported', 'contradicted', 'uncertain'].map(verdict => [verdict, claims.filter(claim => claim.verdict === verdict).length]));
  const covered = new Set(claims.filter(claim => claim.verdict === 'supported').flatMap(claim => claim.requiredGoldClaimIds));
  const citations = claims.flatMap(claim => claim.citations);
  const sourceJudgments = citations.filter(citation => citation.sourceSupported !== null);
  const localized = citations.filter(citation => citation.page !== null);
  const pageJudgments = localized.filter(citation => citation.pageSupported !== null);
  const claimsWithCitation = claims.filter(claim => claim.citations.length).length;
  const claimsWithSourceSupport = claims.filter(claim => claim.citations.some(citation => citation.sourceSupported === 1)).length;
  const claimsWithPageSupport = claims.filter(claim => claim.citations.some(citation => citation.pageSupported === 1)).length;
  return {
    packetId: packet.packetId, caseId: packet.caseId, repeat: packet.repeat ?? 0, artifactType: packet.artifactType,
    judgeConfidence: score.confidence, auditExhaustiveness: 'unverified',
    counts: {
      materialClaimAudits: claims.length, ...counts, requiredGoldClaims: packet.gold.claims.length,
      missingCitationMetadata: citationMetadataAvailable ? 0 : 1,
      coveredGoldClaims: covered.size, claimsWithCitation, claimsWithSourceSupport, claimsWithPageSupport,
      auditedCitationReferences: claims.reduce((n, claim) => n + claim.citedEvidenceIds.length, 0),
      unresolvedCitedReferences: claims.reduce((n, claim) => n + claim.unresolvedCitedReferences.length, 0),
      redundantCitedReferences: claims.reduce((n, claim) => n + claim.redundantCitedReferences.length, 0),
      observedClaimCitationLinks: citations.length,
      sourceSupportKnown: sourceJudgments.length, sourceSupportUnknown: citations.length - sourceJudgments.length,
      pageLocalizedCitationLinks: localized.length, pageSupportKnown: pageJudgments.length,
      pageSupportUnknown: localized.length - pageJudgments.length,
      ambiguousPageCitationLinks: citations.filter(citation => citation.pageStatus === 'ambiguous').length,
    },
    metrics: {
      strictClaimSupportPrecision: ratio(counts.supported, claims.length),
      unsupportedClaimRate: ratio(counts.unsupported, claims.length),
      contradictedClaimRate: ratio(counts.contradicted, claims.length),
      unsupportedOrContradictedClaimRate: ratio(counts.unsupported + counts.contradicted, claims.length),
      uncertaintyRate: ratio(counts.uncertain, claims.length),
      goldClaimCoverageRecall: ratio(covered.size, packet.gold.claims.length),
      citationCoverage: citationMetadataAvailable ? ratio(claimsWithCitation, claims.length) : null,
      sourceCitationSupportPrecision: ratio(sourceJudgments.filter(citation => citation.sourceSupported === 1).length, sourceJudgments.length),
      pageCitationSupportPrecision: ratio(pageJudgments.filter(citation => citation.pageSupported === 1).length, pageJudgments.length),
      citationPageLocalizationCoverage: ratio(localized.length, citations.length),
      sourceSupportedCitationCoverage: citationMetadataAvailable ? ratio(claimsWithSourceSupport, claims.length) : null,
      pageSupportedCitationCoverage: citationMetadataAvailable ? ratio(claimsWithPageSupport, claims.length) : null,
    },
    coveredGoldClaimIds: [...covered], uncoveredGoldClaims: packet.gold.claims.filter(claim => !covered.has(claim.id)),
    claimAudits: claims,
    unsupportedClaims: claims.filter(claim => claim.verdict === 'unsupported' || claim.verdict === 'contradicted'),
    uncertainClaims: claims.filter(claim => claim.verdict === 'uncertain'),
    criticalErrors: score.criticalErrors, missingPoints: score.missingPoints,
    numericClaims: score.numericClaims,
  };
}

function metricSummary(rows, metric, options) {
  const valid = rows.filter(row => row.metrics[metric] !== null);
  const bootstrap = bootstrapMean(valid.map(row => ({ value: row.metrics[metric], cluster: row.caseId })), options);
  return {
    mean: bootstrap.mean, ci95: bootstrap.ci95,
    nSamples: valid.length, nMissingOrZeroDenominator: rows.length - valid.length,
    nIndependentCases: new Set(valid.map(row => row.caseId)).size,
    totalSamples: rows.length, totalIndependentCases: new Set(rows.map(row => row.caseId)).size,
    ...(bootstrap.uncertainty ? { uncertainty: bootstrap.uncertainty } : {}),
  };
}

/** Equal-weight case estimates, with repeat samples retained inside their case cluster. */
export function aggregateGrounding(packets, scores, { seed = 20260907, bootstrapSamples = 2000 } = {}) {
  if (!Number.isSafeInteger(seed) || !Number.isSafeInteger(bootstrapSamples) || bootstrapSamples < 1) throw new Error('seed and positive bootstrapSamples must be safe integers');
  validateJudgeScores(packets, scores);
  const scoreIndex = new Map(scores.map(score => [score.packetId, score]));
  const rows = packets.map(packet => sampleGrounding(packet, scoreIndex.get(packet.packetId)));
  const byArtifactType = {};
  for (const artifactType of distinct(rows.map(row => row.artifactType))) {
    const samples = rows.filter(row => row.artifactType === artifactType);
    byArtifactType[artifactType] = {
      nSamples: samples.length, nIndependentCases: new Set(samples.map(row => row.caseId)).size,
      metrics: Object.fromEntries(METRICS.map(metric => [metric, metricSummary(samples, metric, { seed, bootstrapSamples })])),
      diagnosticCounts: Object.fromEntries(Object.keys(samples[0].counts).map(key => [key, samples.reduce((sum, sample) => sum + sample.counts[key], 0)])),
    };
  }
  const perCase = [];
  for (const artifactType of Object.keys(byArtifactType)) {
    for (const caseId of distinct(rows.filter(row => row.artifactType === artifactType).map(row => row.caseId))) {
      const samples = rows.filter(row => row.artifactType === artifactType && row.caseId === caseId);
      perCase.push({
        caseId, artifactType, packetIds: samples.map(row => row.packetId), nSamples: samples.length,
        metrics: Object.fromEntries(METRICS.map(metric => {
          const values = samples.map(row => row.metrics[metric]).filter(value => value !== null);
          return [metric, { mean: mean(values), nSamples: values.length, nMissingOrZeroDenominator: samples.length - values.length }];
        })),
      });
    }
  }
  return {
    schemaVersion: 'judge-assisted-grounding-v1', aggregationVersion: GROUNDING_AGGREGATION_VERSION, nSamples: rows.length,
    nIndependentCases: new Set(rows.map(row => row.caseId)).size,
    classification: 'LLM-assisted diagnostics against supplied evidence; not independently certified scientific truth or hard-gate clearance.',
    methods: {
      weighting: 'Compute each sample ratio, average available repeats within case, then weight cases equally; artifact types stay separate. Diagnostic counts are not pooled headline rates.',
      bootstrap: { method: 'Case-cluster percentile bootstrap', seed, samples: bootstrapSamples },
      claimPrecision: 'Supported / all audited material claims. Uncertain remains in the denominator and has its own rate; contradicted and unsupported are also separate.',
      goldRecall: 'Distinct gold claim IDs explicitly linked from supported audits / all packet.gold.claims. Zero gold claims gives null. Claim links are judge-supplied, not inferred from substring presence.',
      citationPrecision: 'Per audited claim–observed-citation link. Credit requires supported verdict and cited source/page matching judge-identified supporting evidence. Narrow references resolve first; underlying actual citation indexes cannot contribute twice within a claim. Broad aliases already represented by specific references are redundant. A partly overlapping broad alias retains its original page uncertainty. Unknown mappings are excluded with counts, never credited.',
      sourceVsPage: 'Source support does not establish page localization. A null/ambiguous actual citation page stays unlocalized even if the judge cites a known gold passage ID. Page precision uses localized, mappable links only; localization coverage is reported separately.',
      omittedCitations: 'No observed citation gives zero claim citation coverage (when claims exist), but zero-denominator citation precision is null. Missing citation metadata remains unresolved, not proof of no citations.',
    },
    byArtifactType, perCase, perSample: rows,
    limitations: [
      'Schema validation verifies spans and allowed references, not semantic entailment, exhaustive claim extraction, correct gold-claim linkage, or citation-to-claim attachment.',
      'Scientific units, source attribution, and compound-claim granularity may be judged incorrectly. Numeric extraction remains unverified; this module never certifies arithmetic or row provenance.',
      'Unsupported and uncertain spans and original gold links are retained for review. A second judge belongs in a separate reliability analysis, never a duplicate primary sample.',
      'Citation existence alone never earns support. Unknown metadata and zero denominators are explicit; this is not a complete fabricated-citation audit.',
      'Small curated samples and correlated repeats do not establish broad model reliability. No hard safety or permission gate is overridden.',
    ],
  };
}

const usage = `Usage: node evals/aggregate-grounding.mjs --packets FILE --scores FILE_OR_DIRECTORY --output NEW_FILE
  [--seed INTEGER] [--bootstrap-samples INTEGER]
Read only immediate JSON score files; revalidate one canonical judgment per packet.
Accepts canonical score objects, {"scores":[...]}, or validated absolute judge-results reports.
All packet scores are required. Separate second-judge reliability files must stay outside the directory.
Output must be new. This aggregates external audits and does not generate judgments.`;

function argumentsFrom(argv) {
  const options = {};
  const known = ['packets', 'scores', 'output', 'seed', 'bootstrap-samples'];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--help') return { help: true };
    const key = argv[i].startsWith('--') ? argv[i].slice(2) : '';
    if (!known.includes(key) || Object.hasOwn(options, key)) throw new Error(`Unknown or duplicate argument: ${argv[i]}`);
    if (argv[i + 1] === undefined || argv[i + 1].startsWith('--')) throw new Error(`Missing value for ${argv[i]}`);
    options[key] = argv[++i];
  }
  for (const key of ['packets', 'scores', 'output']) if (!options[key]) throw new Error(`--${key} is required`);
  for (const key of ['seed', 'bootstrap-samples']) if (options[key] !== undefined) {
    if (!/^-?\d+$/.test(options[key]) || !Number.isSafeInteger(Number(options[key]))) throw new Error(`--${key} must be a safe integer`);
    options[key] = Number(options[key]);
  }
  return options;
}

async function inputFile(path) {
  const text = await readFile(path, 'utf8');
  return { document: parseStrictJson(text, path), provenance: { path: resolve(path), sha256: createHash('sha256').update(text).digest('hex') } };
}

export async function main(argv = process.argv.slice(2)) {
  const args = argumentsFrom(argv);
  if (args.help) { process.stdout.write(`${usage}\n`); return; }
  const scoreInfo = await stat(args.scores);
  const scorePaths = scoreInfo.isDirectory()
    ? (await readdir(args.scores, { withFileTypes: true })).filter(entry => entry.isFile() && entry.name.endsWith('.json')).map(entry => join(args.scores, entry.name)).sort()
    : [args.scores];
  if (!scorePaths.length) throw new Error('No score JSON files found');
  const [packetInput, ...scoreInputs] = await Promise.all([inputFile(args.packets), ...scorePaths.map(inputFile)]);
  const scores = scoreInputs.flatMap(({ document }, i) => {
    if (document?.schemaVersion === 'independent-judge-results-v1' && document.mode === 'absolute' && Array.isArray(document.scores)) return document.scores;
    return scoresFromDocument(document, scorePaths[i]);
  });
  const report = aggregateGrounding(packetsFromDocument(packetInput.document), scores, {
    ...(args.seed === undefined ? {} : { seed: args.seed }),
    ...(args['bootstrap-samples'] === undefined ? {} : { bootstrapSamples: args['bootstrap-samples'] }),
  });
  report.inputArtifacts = { packets: packetInput.provenance, scoreFiles: scoreInputs.map(input => input.provenance) };
  const output = resolve(args.output);
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, `${JSON.stringify(report, null, 2)}\n`, { flag: 'wx' });
  process.stdout.write(`Aggregated ${report.nSamples} validated external judgments; wrote ${output}\n`);
  return report;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => { process.stderr.write(`Grounding aggregation rejected: ${error.message}\n`); process.exitCode = 1; });
}
