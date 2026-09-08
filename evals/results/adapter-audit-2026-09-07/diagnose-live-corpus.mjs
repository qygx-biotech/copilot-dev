import fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import { sha256, writeJson } from '../../lib/reproducibility.mjs';
const require = createRequire(import.meta.url);
const { SourceResultStore } = require('../../../docs/source-system.js');
const output = 'evals/results/adapter-audit-2026-09-07';
const live = 'evals/results/live-ui-2026-09-07';
const workspace = 'evals/workspaces/live-eval-v1/.biodesign';
const read = async p => JSON.parse(await fs.readFile(p, 'utf8'));
// A post-judgment diagnostic gate; this script never produces judge scores.
const firstJudge = await read(live + '/validated-corpus-first.json');
const repeatJudge = await read(live + '/validated-corpus-repeat.json');
if (!firstJudge.scores?.length || !repeatJudge.scores?.length) throw new Error('Independent scores must be saved before source diagnosis.');
const journal = await read(live + '/corpus-workflow-final.json');
const registry = await read(live + '/source-registry-final.json');
const observations = await Promise.all(['11-corpus-cold.json', '12-corpus-warm.json'].map(n => read(live + '/' + n)));
const cards = Object.fromEntries(await Promise.all(['P17', 'P31', 'P52'].map(async id => [id, await read(workspace + '/literature/summaries/' + id + '.json')])));
const savedResult = await read(workspace + '/results/cb552341-42d0-4079-8f37-0b7def072c22.json');
// Recompute only deterministic formatting of the already-observed journal. The
// in-memory write sink prevents creating/replacing any application artifact.
const store = new SourceResultStore({ workspace: { createId: () => 'diagnostic-only', writeJson: async () => {} } });
const compacted = await store.compact(savedResult.value, { diagnostic: true });
const preview = JSON.stringify(compacted.preview);
const sampleVerification = journal.verification.filter(v => v.supportingPaperIds.some(id => ['P17', 'P31', 'P52'].includes(id)))
  .map(v => ({ claim: v.claim, supportingPaperIds: v.supportingPaperIds, evidenceRefs: v.evidenceRefs, locatedEvidence: v.locatedEvidence, status: v.status }));
const citationArtifacts = [];
for (const observation of observations) for (const citation of observation.actual.answer.citations) {
  const localPath = 'evals/workspaces/live-eval-v1/' + citation.relativePath;
  const bytes = await fs.readFile(localPath);
  citationArtifacts.push({ cacheState: observation.cacheState, citation, fileExists: true, byteLength: bytes.length, sha256: sha256(bytes),
    registeredSource: registry.sources.find(s => s.sourceId === citation.sourceId) || null });
}
const report = {
  createdAt: new Date().toISOString(), role: 'post-independent-judge-source-diagnostic',
  priorIndependentScores: { first: firstJudge.scores[0].overall, repeat: repeatJudge.scores[0].overall,
    firstSha256: sha256(await fs.readFile(live + '/validated-corpus-first.json')), repeatSha256: sha256(await fs.readFile(live + '/validated-corpus-repeat.json')) },
  boundary: 'No new application query, provider call, score change, or production edit. Deterministic preview reconstruction is labeled and is not a captured deployed request or model tool-read history.',
  query: journal.question, corpusScope: journal.corpusScope, coverage: journal.coverage,
  stageEvidence: {
    cards: Object.fromEntries(Object.entries(cards).map(([id, card]) => [id, { model: card.model, generationMode: card.generationMode,
      evidenceFindings: card.evidenceFindings, importantResults: card.importantResults, limitations: card.limitations }])),
    maps: Object.fromEntries(['P17', 'P31', 'P52'].map(id => [id, { generationMode: journal.maps[id].generationMode,
      findings: journal.maps[id].findings, limitations: journal.maps[id].limitations }])),
    originalVerification: sampleVerification,
    previewReconstruction: { entrypoint: 'SourceResultStore.compact', serializedJournalCharacters: JSON.stringify(savedResult.value).length,
      previewCharacters: preview.length, firstP17MeanOffset: preview.indexOf('42.0'), firstP52MeanOffset: preview.indexOf('51.0'),
      firstP31N6Offset: preview.indexOf('n=6'), firstP17N5Offset: preview.indexOf('n=5'),
      firstP52N6IndependentSheetsOffset: preview.indexOf('n=6 independent sheets'), verificationOffset: preview.indexOf('"verification"'),
      readWorkspaceItemDefaultCharacters: 12000, readWorkspaceItemMaximumCharacters: 16000,
      actualDeployedReadOffsets: null },
    citations: citationArtifacts,
  },
  findings: [
    { id: 'coverage_not_question_completeness', conclusion: 'The workflow prepared/analyzed8/8 project papers, including all three requested originals. Successful coverage does not establish that each requested metric/sample count survives the answer path. The natural query names three papers while corpusScope remains entire-project.' },
    { id: 'canonical_card_omission_then_reuse', conclusion: 'P17 and P52 canonical evidence findings omit explicit sample counts; P31 retains n=6. P52 limitations mention one of six sheets cracked, but this is not represented as the requested sample-count finding. All maps reuse Paper Cards and preserve the same omissions. Verification still locates original text explicitly containing P17 n=5 and P52 n=6.' },
    { id: 'pagination_position_risk', conclusion: 'The deterministic preview puts requested means and P31 n=6 within its first12k characters, while P17 n=5 and P52 n=6 occur beyond42k/47k. A first bounded read can expose the same asymmetry as the final answer. The logs report read_workspace_item/read_paper_evidence capabilities but omit offsets, pagination and returned tool content, so the exact model read history remains unproven.' },
    { id: 'derived_result_citation_identity_mismatch', conclusion: 'Both result JSON files exist physically. The sole saved citation uses catalog:local:1, which is absent from the source registry. The FC catalog permits a derived item identity while host bindToWorkspace/navigation require a registered source identity. The saved citation is therefore missing/unresolvable. This diagnosis does not change the independent judge result or make the citation valid.' },
  ],
  sourceReferences: [
    { path: 'docs/source-system.js', line: 1957, relevance: 'Result compaction/preview ordering and first20 verification entries' },
    { path: 'docs/source-system.js', line: 5945, relevance: 'Canonical Paper Card map reuse' },
    { path: 'docs/project-context-service.js', line: 1641, relevance: 'Corpus result passed as derived local evidence item' },
    { path: 'alibaba-fc/side-chat-agent.js', line: 1172, relevance: 'Offset read default12000/max16000' },
    { path: 'alibaba-fc/side-chat-agent.js', line: 939, relevance: 'Fallback catalog:item source identity' },
    { path: 'shared/source-citations.js', line: 54, relevance: 'Host registry-bound citation validation' },
  ],
  artifactHashes: { journal: sha256(await fs.readFile(live + '/corpus-workflow-final.json')), registry: sha256(await fs.readFile(live + '/source-registry-final.json')) },
};
await writeJson(output + '/live-corpus-diagnostics.json', report);
console.log(JSON.stringify({ path: output + '/live-corpus-diagnostics.json', coverage: report.coverage.papersSuccessfullyAnalyzed,
  preview: report.stageEvidence.previewReconstruction, citations: citationArtifacts.map(c => ({ status: c.citation.status, fileExists: c.fileExists, registered: Boolean(c.registeredSource) })) }));
