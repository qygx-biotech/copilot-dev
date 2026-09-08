# Literature grounding and routing: implementation report

## 1. Branch and scope

Branch: `fix/literature-grounding-and-routing`, based on `1fb5f536b647` (`eval`). Changes are local and uncommitted; no FC deployment, configuration update, or push was performed. The working tree was clean before this branch was created.

The work addresses literature request interpretation, retrieval/context handoff, bounded original-evidence completion, and citation mechanics. Experiment mapping, canonical fields, structured queries, ranking, units, rows, and spreadsheet aggregation were not edited. Existing mixed literature/experiment behavior remains covered by the retained tests. Shared capability filtering excludes experiment-only capabilities only when semantic objects include literature and exclude experiments.

## 2. Demonstrated defects addressed

- Known semantic-parser capability failures were retried on subsequent requests without remembering unavailability.
- Non-English original and canonical queries were concatenated, weakening retrieval and losing independent rankings.
- Explicit paper identities could be discarded by generic routing; nonexistent exact titles could receive unrelated candidates.
- Ranked page evidence could be lost between paper selection and bounded context construction.
- Missing Paper Card/map facts lacked a bounded original-paper completion step.
- Large prepared results lacked direct access by evidence reference or query.
- Unresolved literature citation markers could become broken citation objects.
- Literature-only requests could select experiment tools through overlapping terminology or capability hints.

Review also checked the new interactions: explicit paper scoping preserves requested project memory, and completion must fit the actual per-paper context budget without silently dropping facts.

## 3. Files changed

| Production file | Responsibility |
|---|---|
| `alibaba-fc/index.js` | Narrow semantic failure classification; bounded literature context/diagnostic sanitization |
| `docs/literature-module.js` | Session capability cooldown, probe coordination, refresh and reset |
| `shared/semantic-intent.js` | Language/query metadata, protected identifier validation, capability filtering and attempt telemetry |
| `docs/knowledge-service.js` | Original/canonical query fusion through existing Fast/Deep retrieval |
| `docs/source-system.js` | Legacy fusion, backend diagnostics, bounded L1 completion and explicit corpus coverage |
| `docs/project-context-service.js` | Paper identity scope, exact-title negative lookup, ranked page handoff and completion integration |
| `alibaba-fc/side-chat-agent.js` | Targeted original-evidence access, request capability restriction, literature citation resolution |
| `shared/source-citations.js` | Opt-in suppression of unresolved references; default callers remain compatible |

Regression files: new `alibaba-fc/test/literature-multilingual.test.js` and `alibaba-fc/test/literature-routing.test.js`; additions to `semantic-backend.test.js`, `source-system.test.js`, and `source-citations.test.js`. This report and the new timestamped evaluation result directories document implementation and reproducibility. Frozen cases, expected answers, the existing scorer, and existing evaluation reports were not edited. Generated ignored renderer/shared copies were synchronized using the existing scripts.

## 4. Semantic-parser 502 diagnosis

The recorded live run had 11 starts, zero completions, and 11 HTTP 502 failures at `/api/semantic/interpret`. Route registration, FC forwarding, shared schema imports, and the inspected deployment archive contain the handler and required modules. The parser already uses the existing FC Requesty transport; no second provider implementation was needed.

The reproducible narrow cause is strict structured-output capability configuration. `getRequestyCapabilityConfig` defaults `jsonSchema` to false unless `REQUESTY_MODEL_SUPPORTS_JSON_SCHEMA` or the per-model `REQUESTY_MODEL_CAPABILITIES_JSON` entry advertises support. `callSemanticStructured` rejects unsupported strict output, and the old handler masked this as generic `SemanticParserUnavailable`/502. Planner/reranker and successful combined-text Paper Cards can use their existing `json_object` path, so their success is consistent with this parser-specific failure.

The handler now returns an allowlisted reason, unavailable flag, opaque configuration signature, retry interval, and known attempt counts. Strict schema requirements, parser prompt, auth, model selection, Requesty transport, planner, reranker, and `/api/semantic/map-schema` behavior remain intact.

## 5. Source versus deployed configuration

Missing strict-capability advertisement is the strongest source-supported explanation, reproduced locally. The exact live cause is **not proven**: no deployed FC revision, semantic model override, or server capability environment was attested. Provider rejection of strict output is also classified narrowly. Source packaging evidence does not establish what is deployed.

Known unavailability opens an in-memory five-minute circuit keyed to the current FC URL/configuration signature. Concurrent requests share a capability probe, not another query's interpretation. FC configuration-signature changes, URL changes, a new client/application session, explicit `refreshSemanticCapability()`, and cooldown expiry permit retry. Semantic-only server configuration changes become visible on refresh/cooldown if the existing client configuration signature does not change. Old opaque 502 responses receive a short 30-second backoff; transport errors, 504s, and invalid structured responses do not permanently disable the capability.

Controlled regression: 11 sequential requests with strict capability disabled make one endpoint attempt, then ten local fallbacks; zero Requesty calls are made in that configuration. A supported strict configuration succeeds through the real FC handler and mocked existing Requesty boundary. These are local tests, not a new live measurement of the historical 11 failures.

## 6. Original and canonical language retrieval

Request metadata retains `originalQuery`, `inputLanguage`, `answerLanguage`, and `canonicalQueryEn`. Existing semantic interpretation supplies canonical English in the same call. There is no added translation request and no document/evidence rewriting. Explicit answer-language instructions and existing explicit persistent language preferences retain priority; otherwise the current input controls answer language.

Non-English literature requests search original and validated canonical forms independently. Existing scientific identifier extraction rejects canonical forms that drop or change protected identifiers, including case-sensitive names and mutation/kinetic/accession forms. Results are deduplicated deterministically with reciprocal-rank fusion. Legacy fusion uses full metadata/L1 scores rather than rescoring shortened display snippets. English and experiment descriptor search retain their existing single-query behavior.

## 7. Retrieval profiles and planner invariants

No retrieval-profile decision rule was changed. Inspection found no remaining rule in the current implementation that forces Deep solely for Han input. Fast stays within the existing Fast path; Deep reuses the existing shared plan and validated expansions. A corpus question still uses one shared planner followed by paper-scoped retrieval and only uncovered maps. Planner/reranker FC routes, schemas, prompts, model configuration, and provider routing were not changed.

## 8. Evidence selection and paper identity

Current paper IDs, exact filenames, and recognized titles resolve before generic routing. Title matching normalizes Unicode, case, whitespace and punctuation. A selected scope remains authoritative. Explicit identity is carried to the backend paper lookup so later tools cannot widen it. Relational discovery such as papers citing a named source retains that source as a comparator while still finding related papers.

A clearly exact-title request with no normalized match returns an explicit no-match notice, empty paper results, and no history/semantic substitution. Existing semantic discovery remains available for ordinary topic requests. Strengthening paper scope leaves existing project-memory routing in place for literature/hypothesis comparisons.

Selected paper matches retain their ranked page/section/evidence reference. The bounded L1 read prioritizes the verified ranked chunk, so a strong page-eight match is not replaced by early generic text.

## 9. Missing Paper Card fields

For requested factual dimensions (mean, sample count, temperature, Km, kcat, mutation and method), completion checks original evidence already in context. Optional Card prefixes and corpus maps do not satisfy that check. Missing dimensions trigger local paper-scoped L1 retrieval using current artifact/source hashes and real page/chunk identities. The `n=5` regression recovers original page-eight evidence without regenerating the Card, and a misleading Card-only `n=999` cannot satisfy it.

This is bounded evidence retrieval, not a sentence-by-sentence claim verifier. A pattern match locates candidate support; it does not prove the scientific interpretation is correct. Missing results mean "not located in the bounded evidence," never proof that the paper did not report the fact.

## 10. Corpus completion and long-result access

Completion operates around valid Card/map caches, reading at most eight papers and at most 8,000 additional characters in total, further limited by the actual per-paper context capacity. Source hash changes still invalidate artifacts through the existing mechanism. No global 12k/16k/48k context limit was raised.

The existing `read_paper_evidence` tool accepts optional `query` or `evidence_ref`, resolves the current paper identity and evidence handle, and jumps directly to the matching original-evidence block in the prepared request. Large results need not be consumed from the beginning. If the requested original block is absent from the bounded prepared context, the tool returns `EVIDENCE_NOT_LOCATED` with explicit uncertainty. It does not fabricate access to an unprepared source.

Cached corpus maps are reused when a new question needs a missing original fact. Completion does not call the mapper, Card generator, search planner, reranker, or a new LLM verifier. Existing corpus status/failure follow-ups keep their established workflow handling.

## 11. Citation identity and pages

Targeted reads expose citations with source ID, evidence reference and actual page only for visible original evidence whose handle resolves in the current ledger. Pure Card text cannot masquerade as original evidence. Existing stable source/evidence resolution is reused; no pages are invented.

Literature Side Chat final-answer resolution suppresses unresolved, stale or ambiguous references as plain `[Source unavailable]` instead of emitting broken citation objects/links, and records compact resolved/page-localized/suppressed counts. The shared resolver's default behavior remains unchanged for other callers. Host evidence preparation and targeted tools apply to both Side Chat and Agent Command; the strict final-reply citation pass remains within the existing Side Chat citation contract. Agent Command's typed output/UI contract was not redesigned.

## 12. Corpus directory race and coverage

The base commit already contains the cold-directory fix in `ProjectFilesystem.ensureDirectory`: concurrent workers can both observe a missing parent; a losing `mkdir` accepts only `EEXIST`, then rechecks that the resulting path is a real directory and not a symlink. That code and its eight-concurrent-map-writes regression were retained. This branch does not claim a new 7-to-8 coverage improvement over a baseline that already has the fix.

Workflow status now exposes `snapshotCount`, `analyzedCount` and `coverageComplete` alongside the existing compatible status/coverage fields. The FC sanitizer derives completeness from counts and failures, rather than trusting a supplied flag. Existing final-answer corpus guidance uses analyzed coverage and missing/failed IDs, rather than treating generic `completed` as proof of full coverage. Cache/concurrency architecture remains unchanged.

## 13. QMD versus legacy findings

In the fresh baseline, all 78 observations with legacy hits had QMD available and empty QMD search traces. This is evidence for fallback after empty results, not a missing QMD installation. The earlier archived audit likewise found empty QMD results predominated. Concatenating the original question and fallback concept string made the lexical query unnecessarily restrictive; independent forms recover some QMD matches.

The candidate records allowlisted fallback reasons such as `no_qmd_results`, `qmd_not_ready` and `qmd_error`. QMD is unchanged and legacy remains a safety net. Context diagnostics contain parser status, language/canonical availability, backend/reason, ranked/selected IDs, evidence pages, completion attempts and corpus coverage; they do not add full source text or hidden reasoning logs. Context evidence-handle counts must not be mistaken for emitted answer citation rates.

In the final replay, 72 observations recorded `no_qmd_results`; saved ranked hits comprised 194 legacy, 16 QMD and six metadata hits. Controlled QMD searches increased from 164 to 178; index updates stayed at 1,493, Card adapter operations at 360, and map/native-PDF adapter operations at zero. There were 60 local completion attempts. All seven recorded cloud-role counters (semantic parser, search planner, reranker, corpus mapper, native PDF, combined-text Card and answer) were zero in both controlled runs; paid provider execution is unavailable, not inferred from those adapter counts.

## 14. Added tests

Focused regressions cover the requested A–J scenarios: semantic handler/circuit and recovery; EN/ZH equivalent calcium queries using an existing canonical interpretation without adding a calcium dictionary entry; protected scientific IDs and unchanged depth; one shared corpus plan; explicit/current/selected/title scope; exact-title negatives; ranked late-page retention; missing Card fact and cached-map completion; real page-eight citations and stale-reference suppression; retained concurrent corpus writes; and literature-only capability filtering with mixed-request compatibility.

Additional boundary checks cover misleading Card evidence, failed/stale completion attempts, original full-text ranking rather than display-snippet scoring, explicit-paper/project-memory comparisons, and actual completion context capacity. Existing successful regression tests were retained.

## 15. Existing validation retained

The final full regression run passed **421/421 tests, zero failures and zero skipped tests**. Validation uses the bundled Electron Node runtime to match the installed native dependencies. The complete FC, desktop and local-backend test suite includes existing experiment semantics, permissions, Card generation/reuse, shared corpus planner, reranker/provider rate limits, preflight synchronization, Electron UI behavior, native PDF behavior, filesystem security, and a real QMD SDK smoke test. The command and log identity are recorded in [regression-validation.json](../evals/results/literature-grounding-routing-2026-09-08-final/regression-validation.json).

## 16. Frozen baseline versus candidate

See [the final paired evaluation](../evals/results/literature-grounding-routing-2026-09-08-final/REPORT.md) and its linked machine-readable audits. The selection was fixed before the candidate replay: 45 literature cases, 35 dev and 10 held-out, each cold and warm, under unchanged scorer 1.0.1 and frozen expected answers. The fresh baseline comes from detached base commit `1fb5f536b647`.

Raw ranked paper/page metrics and emitted context coverage are reported separately. Paired means use the same finite metric pairs; unavailable raw page identities remain unknown, with losses of evaluability explicitly listed. Confidence intervals cluster cold/warm observations by independent case. Three bilingual pairs are too few for a broad language-quality claim.

| Matched metric | Baseline | Candidate | 95% interval for paired change |
|---|---:|---:|---|
| Ranked paper Recall@5 | 76.47% | 82.35% | 0 to +17.65 percentage points |
| Ranked page-evidence Recall@5 | 45.37% | 50.93% | 0 to +16.67 percentage points |
| Ranked paper MRR | 0.7255 | 0.7843 | 0 to +0.1569 |
| Context page-evidence Recall@5 | 64.04% | 69.30% | 0 to +15.79 percentage points |
| Matched English paper Recall@5 | 100% | 100% | No observed change |
| Matched Chinese paper Recall@5 | 66.67% | 66.67% | No observed change |
| EN/ZH top-five paper Jaccard | 0.5143 | 0.6032 | See the paired audit; three independent pairs |

Paper metrics use 34 observations/17 cases; ranked page metrics use 36/18; context page metrics use 38/19. The original 48.25% raw page baseline marginal includes a case whose candidate page metric is unknown; the table uses 45.37% on the same measurable pairs in both runs. Every retrieval improvement interval includes zero.

Both runs have 90 observations, 88 completed/valid and two blocked fault-injection observations. All eight stored workflow records cover eight of eight papers in both runs; two belong to blocked observations, leaving six completed observations with measured full workflow coverage. Declared corpus requests remain 18 completed and two blocked; a request without a workflow record is not counted as corpus success.

The local lane does not produce live answers or paid provider execution. Live citation resolution, PDF citation page coverage, unsupported/contradicted claim rates and live judge scores are therefore unmeasured, not zero. The historical live report remains unchanged; local citation regressions cannot establish historical broken citations fell from two to zero in production. Role counters distinguish controlled adapter work from real provider calls.

For reference only, the supplied [historical summary](../evals/results/final-evaluation-2026-09-07/summary.json) reports unsupported claims 3.72%, contradicted claims 4.50%, combined 8.22%, and overall judge score 3.67/5 across seven samples/six cases. That audited cohort includes experiment answers and is not a paired literature-only candidate comparison. No candidate live value is available for those measures.

## 17. Regressions and acceptance limits

There are no observed numeric regressions in the paired paper/context retrieval metrics, but the unchanged overall comparator still reports **`passed=false`**:

- Cold latency increased: p50 **2,164.58 to 2,416.09 ms**, p95 **2,650.52 to 3,145.15 ms**. It flags 56 individual latency increases and two aggregate cold-latency regressions. Warm p50 fell from 54.08 to 47.82 ms and warm p95 from 252.26 to 243.45 ms. These measured cold regressions are retained; a single local replay does not isolate runtime variation from implementation overhead.
- One bilingual pair's context evidence Jaccard@10 fell **0.900 to 0.818** in both cold/warm observations. All nine previous Chinese pages remained; an added tenth page differed from the English tenth page. Supporting-evidence recall did not fall, but the overlap regression is real under that metric.
- `CW-ECTD_PAPERS-02` now includes metadata-only ranked hits without page handles. Eight raw-page metric entries across its cold/warm observations become unknown. Context support remains measurable; this is an explicit loss of raw page-metric evaluability.
- There are zero observed candidate hard failures, **380 unknown hard checks**, and the two unchanged blocked fault-injection observations. The Chinese recall gap remains.

The final evaluation report retains these findings and the exact candidate production hash `b3bdb0e35a46131590e9f0e95450b046d1551763662d6e678e8ff581d0f456a9`; its before/after integrity check is unchanged. A higher aggregate retrieval score does not erase regressions. No statistical improvement or broad release eligibility is claimed.

## 18. Unresolved literature limitations

- Deployed strict-schema support and the precise historical FC environment still require live attestation; this branch supplies explicit once-per-capability fallback rather than forcing a provider/schema downgrade.
- Local canonical fallback cannot translate every unseen scientific concept when the parser is unavailable. The frozen Chinese recall gap may remain even when result overlap improves.
- Completion is request-driven and bounded. It covers the listed factual dimensions and current L1 text, not arbitrary claims, OCR recovery or facts beyond the active prepared scope.
- Targeted backend reads operate on original evidence prepared for the request; absent late evidence remains an honest bounded miss.
- Metadata-only search results without page handles cannot provide a raw page metric or a page citation. High-level Card evidence does not justify invented localization.
- Live final-answer quality, citation outcomes, provider billing and deployed behavior remain unverified by the controlled local lane.

These limits were kept explicit instead of expanding the architecture, changing experiment behavior, or tuning frozen expected answers.
