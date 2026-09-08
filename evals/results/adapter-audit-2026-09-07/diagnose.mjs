import fs from 'node:fs/promises';
import { sha256, verifyFrozenSuite, writeJson } from '../../lib/reproducibility.mjs';
const root='evals/results/adapter-audit-2026-09-07';
const suite=await verifyFrozenSuite('evals/biodesign-eval-v1');
const bytes=await fs.readFile('evals/results/baseline-2026-09-07/cases.jsonl');
const rows=bytes.toString().trim().split('\n').map(JSON.parse);
const cold=id=>rows.find(r=>r.caseId===id&&r.timing.cacheState==='cold');
const lookup=cold('CW-LOOKUP-03'),en=cold('CW-ECTD_EXPERIMENTS-01'),zh=cold('CW-ECTD_EXPERIMENTS-02'),malformed=cold('CW-ECTD_WORKFLOWS-04');
const artifactBytes=await fs.readFile(root+'/diagnostic-artifacts/X02-experiment-data.json'),artifact=JSON.parse(artifactBytes);
if(artifact.contentHash!==en.actual.sync.sources.find(s=>s.sourceId==='X02').contentHash)throw Error('Diagnostic source differs from baseline');
const diagnostics={
  createdAt:new Date().toISOString(),role:'post-score-diagnostic-agent',baseline:'evals/results/baseline-2026-09-07',
  baselineObservationsSha256:sha256(bytes),baselineScoreRowsSha256:sha256(await fs.readFile('evals/results/baseline-2026-09-07/deterministic-scores.json')),
  frozenManifestSha256:suite.hash,
  boundary:'Source inspection followed saved deterministic scores. No production or frozen suite edits. These controlled-provider observations do not establish authenticated FC answer quality. Findings never feed back to frozen cases or scoring.',
  findings:[
    {id:'local_generic_definition_discards_source_lookup',classification:'observed-production-local-routing-gap',cases:['CW-LOOKUP-03'],
      observation:{query:lookup.actual.semantic.ir.goal,routing:lookup.actual.context.routing,semanticIR:lookup.actual.semantic.ir,retrievedCandidates:lookup.actual.retrieval.candidatePaperIds,finalPaperIds:lookup.actual.retrieval.paperIds,evidenceIds:lookup.actual.retrieval.evidenceIds,sourceReady:lookup.actual.sync.sources.find(s=>s.sourceId==='P31')},
      cause:'The broad GENERIC_DEFINITION_PATTERN matches a what-is fact request without a literature keyword; localRoutingDecision returns useLiterature:false even with search matches. P31 is third in candidates but is not routed into final evidence.',
      sourceReferences:[{path:'docs/project-context-service.js',line:61},{path:'docs/project-context-service.js',line:1017},{path:'docs/project-context-service.js',line:1447}],
      limits:'Medium local fallback without remote semantic parser, planner, or reranker; open-domain CelluWeave case. A live semantic parser could choose literature and change this outcome.'},
    {id:'ectd_local_schema_scope_and_filters',classification:'observed-production-local-semantic-normalization-gap',cases:['CW-ECTD_EXPERIMENTS-01','CW-ECTD_EXPERIMENTS-02'],
      observation:{en:{ir:en.actual.semantic.ir,result:en.actual.structuredQuery},zh:{ir:zh.actual.semantic.ir,result:zh.actual.structuredQuery},sourceRow:artifact.records[0]},
      causes:[
        'Raw frozen headers titer_g_L, activity_U_mg, yield_g_g, productivity_g_L_h, temperature_C stay unresolved in local schema normalization. Only variant maps to mutation; original source rows remain intact.',
        'Local semantic IR omits prose source X02 and completed-status constraints: scope.experiments:null, filters:[], constraints:[]. Actual candidate datasets differ across EN/ZH.',
        'executeSemanticQuery requires EctD in each row canonical/entities, while this fixture carries EctD only in sheet/table context. Rows have mutation but no protein/gene. Entity matching also eliminates rows before numeric aggregation.'
      ],
      sourceReferences:[{path:'shared/experiment-semantics.js',line:12},{path:'shared/experiment-semantics.js',line:128},{path:'docs/source-system.js',line:4121},{path:'docs/source-system.js',line:4175}],
      artifact:{path:root+'/diagnostic-artifacts/X02-experiment-data.json',sha256:sha256(artifactBytes),sourceHash:artifact.contentHash,origin:'Retained post-freeze adapter observation; source content hash matches immutable baseline X02.'},
      limits:'Not arithmetic computation failure: production returns unresolved/no_numeric_values:titer and no aggregation. No authenticated semantic parser or schema mapper was available. Do not inject gold filters or count unresolved output as a false numeric claim.'},
    {id:'concurrent_map_directory_creation',classification:'observed-production-filesystem-concurrency-gap-in-adapter-path',
      observations:rows.filter(r=>r.actual.corpusWorkflow&&Object.values(r.actual.corpusWorkflow.failures||{}).some(f=>f.code==='EEXIST')).map(r=>({caseId:r.caseId,cacheState:r.timing.cacheState,failures:r.actual.corpusWorkflow.failures,coverage:r.actual.corpusWorkflow.coverage})),
      cause:'Concurrent corpus canonical-paper projections write maps into a missing common directory. ProjectFilesystem.ensureDirectory checks lstat, then mkdir without accepting concurrent EEXIST. Observed cold corpus workflows each lose one map; warm workflows have the directory and analyze all eight.',
      sourceReferences:[{path:'desktop/services/project-filesystem.mjs',line:134},{path:'desktop/services/project-filesystem.mjs',line:149},{path:'docs/source-system.js',line:6000}],
      limits:'Actual production ProjectFilesystem code is used by the adapter. Renderer/UI persistence may serialize differently, so UI impact remains unverified. No production patch applied.'},
    {id:'malformed_mapper_fault_not_reached',classification:'failure-injection-protocol-coverage-gap',cases:['CW-ECTD_WORKFLOWS-04'],
      observation:{status:malformed.status,counters:malformed.provenance.counters,coverage:malformed.actual.corpusWorkflow.coverage,mapGenerationModes:[...new Set(Object.values(malformed.actual.corpusWorkflow.maps).map(m=>m.generationMode))],limitations:malformed.limitations},
      cause:'Declared missing cards regenerate during preflight. Corpus reuses valid cards through canonical projection, so the malformed corpus.map provider hook is never called. Unrelated cold EEXIST is not the expected InvalidLlmResponse failure.',
      sourceReferences:[{path:'docs/source-system.js',line:5945},{path:'docs/source-system.js',line:5986}],
      limits:'Frozen setup and declared provider injection remain unchanged. Do not count this as validated invalid-output handling; a named existing regression can cover the protocol separately.'}
  ],
  adapterDefects:{replayed:['CW-SYNC_FAILURE-02','CW-SYNC_FAILURE-08'],pendingReplay:['CW-ECTD_WORKFLOWS-06',...new Set(rows.filter(r=>r.limitations?.some(x=>x.includes('Principal-scoped'))).map(r=>r.caseId))],note:'Remaining Electron replay paused for parent exclusive live UI. Baseline remains immutable; adapter setup defects are excluded from product claims.'},
  finalAnswerLimit:'Local observations lack final provider answer; grounding, prose citations, answer-level safety, and blind quality remain unmeasured.'
};
await writeJson(root+'/diagnostics.json',diagnostics);
console.log(JSON.stringify({path:root+'/diagnostics.json',findings:diagnostics.findings.map(f=>f.id),manifest:suite.hash}));
