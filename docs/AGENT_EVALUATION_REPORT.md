# BioDesign agent evaluation report

Evaluation date: 2026-09-07 (America/Toronto). Local baseline: `2026-09-07T23-24-41-852Z`. This report combines an immutable local architecture baseline with a separate live Side Chat baseline. Production algorithms were not changed. All scientific sources are explicitly synthetic; deployed FC revision and final-answer model identity remain unverified.

## Executive summary

**The current system can answer simple source questions and recover some experiment queries, but this baseline does not support release clearance.** In 13 real Side Chat responses across 11 preselected cases, two of three experiment requests were fulfilled exactly. One falsely denied existing rows. A three-paper question twice omitted reported sample counts and emitted a broken citation, even while reporting 8/8 papers analyzed. The current-objective recommendation ignored the saved titer priority. Seven fresh blinded judgments across six cases averaged **3.67/5**, with a wide case-bootstrap 95% interval **[2.83, 4.50]**.

The live deployment also returned **40 SchemaMapperUnavailable and 11 SemanticParserUnavailable errors**. All 13 final `/chat` calls succeeded, so this is a measured deployed fallback condition, not a clean test of all intended cloud capabilities. We observed **90 FC client requests**; actual Requesty attempts, tokens and dollars are unavailable. The first cold request took **340.9 seconds**; 12 subsequent requests had median **51.0 seconds**, with an interpolated p95 of **154.9 seconds**. Simple successful answers therefore do not establish efficient or reliable overall behavior.

The frozen suite contains **96 cases: 72 development and 24 heldout**. It combines 24 primary EctD cases with 72 CelluWeave cases that stress a novel domain. Running each case cold and warm produced 192 observations: 166 completed, 24 blocked, and 2 errors. The full baseline made **zero live FC/provider calls and generated zero final model answers**. It exercised application modules with controlled extractive callbacks in isolated workspaces; it is not evidence that 96 live agent conversations succeeded.

The local pipeline retrieves the expected primary EctD papers in its small eligible retrieval subset, but broader page evidence, multilingual discovery, exact experiment selection, and first-run corpus coverage have material gaps. Raw ranked paper Recall@5 is 0.765 and page-evidence Recall@5 is 0.482. All 158 ranked hits in that cohort report the `legacy` backend. The existence of a working QMD installation does not make these QMD-only performance results. Primary EctD experiment request fulfillment is 0/16 observations across eight cases; this includes unresolved and uninvoked queries as well as three cases with emitted incorrect aggregates.

There is **no composite overall score or release clearance**. Required hard checks contain 53 failures and 819 unknowns; the failures are source-row checks, not 53 demonstrated security incidents. No final-answer grounding, abstention, scientific judgment, or permission-safety pass can be established from the local baseline. Application failures, adapter setup defects, evaluator corrections, and missing measurements are separated below.

The saved [baseline][baseline], [ranked retrieval audit][ranked], [metric audit][metrics], [adversarial review][adversarial], and [adapter diagnostics][diagnostics] are the evidence for this report. The raw-ranked audit supersedes the interpretation of the original summary's retrieval fields as search rankings: those fields measured selected context and also included a corpus-routing departure.

### Architecture, provenance, and what was added

The local run used the existing `ProjectContextService.buildContext` entry shared by Side Chat and Agent Command. It exercised ProjectFilesystem, AgentRequestPipeline/KnowledgeSyncAgent/SourceRegistry preflight, PDF.js extraction, the structured experiment store and semantic query, QMD, LiteratureTools, and CorpusWorkflowService. Original synthetic fixture text was rendered into valid PDF and XLSX bytes for production parsing. Gold answers were withheld at the execution boundary. Controlled extractive Paper Card and map callbacks replaced cloud generation; no final-answer provider was supplied. The fixtures are evaluation materials, not real scientific findings.

Existing infrastructure included 47 semantic cases (30 known, 12 novel, five ambiguous), a ten-query/11-paper retrieval fixture, a 150-source no-change benchmark, and FC, desktop and QMD regression tests. The existing application modules and these benchmarks were reused. Added infrastructure is confined to evaluation: frozen cases/schema/rubric/splits, byte fixtures and adapter, orchestration and provenance, deterministic scoring and focused tests, immutable baseline capture, comparison and blinded judge packets, and measurement audits. No production algorithm or provider route was changed to improve this score. The normal authenticated FC/application route is the separate live lane; a direct Requesty route was not introduced.

| Provenance | Recorded value |
| --- | --- |
| Application / Electron / bundled Node | `0.1.7-beta.4` / `44.0.0` / `24.18.1` |
| QMD | `2.8.3` |
| Git commit / branch | `2fdf562940e587314c2783f69bd2d18923e0d530` / `feature/preflight-knowledge-sync-agent` |
| Working tree | Dirty; commit identity alone is insufficient to reproduce this run |
| Production content hash before and after | `5192a2d37c8e99cbbe772f0865475341ac64c7e2d8c3f42a4dfa987bd7a5ae85` |
| Frozen dataset hash | `b5327e04a75635e683a1aeb74da8ea4e367c3e13e2162feae60ab57a8649725e` |
| Immutable baseline SHA256 | `ebfccf2d9d5463181b5b05d50fdc67522301ab34c613d0a0d90683bfd6626650` |
| FC deployment revision / model configuration signatures | Unavailable in the local baseline |

The [suite specification][suite] and [runner documentation][runner] define the execution boundary. Existing saved test results were FC 319/324, desktop 29/30, and QMD 7/7. The five FC failures were loopback `listen EPERM` failures; a separately saved permitted-loopback rerun passed all five with the same code and mocked provider. The desktop failure was a native `NSApplication` startup abort before renderer execution. These environment failures do not establish six product defects, and the original totals remain unchanged. Historical benchmark exits were successful, but their injected plans, smaller fixtures, and mocked providers are not acceptance results for this 96-case suite. See [existing test diagnosis][existing-tests] and [existing benchmarks][existing-benchmarks].

## Scorecard

### Primary retrieval measurement: saved raw rankings

These scores use ordered `actual.retrieval.results`, without reranking or inserting candidates. A paper is identified by its saved paper/source ID; a page hit maps to the explicit evidence ID for that source and page in the frozen fixture. Repeated IDs consume rank positions but earn relevance credit once. Precision@5 divides by five even when fewer hits are returned. Empty relevant sets are excluded from that metric and retained as negative cases. Missing arrays would be unknown; a recorded empty array is a pipeline outcome with zero recall for nonempty gold.

The eligible cohort contains 20 cases/40 observations with declared lookup or discovery behavior, excluding every actual corpus workflow. Paper metrics have 17 cases/34 observations with relevant paper gold; evidence metrics have 19 cases/38 observations. The four empty arrays comprise two genuine empty searches for `CW-DISCOVERY-08` and two initialized empty arrays for `CW-MULTILINGUAL-03`, where no search call was observed. The primary table therefore measures the saved retrieval pipeline outcome, including that routing failure.

| Raw ranking metric | Paper | Page evidence |
| --- | ---: | ---: |
| Recall@5 | **0.765** | **0.482** |
| Recall@10 | 0.765 | 0.482 |
| Precision@5 | 0.188 | 0.137 |
| MRR | 0.725 | 0.526 |
| Recall@5 case-bootstrap 95% interval | [0.529, 0.941] | [0.272, 0.684] |
| Precision@5 95% interval | [0.118, 0.259] | [0.074, 0.200] |
| MRR 95% interval | [0.490, 0.902] | [0.316, 0.737] |

The maximum saved search depth is five, so Recall@10 equals Recall@5 structurally; this run does not establish performance at ten returned hits. All 158 cohort hits report `legacy` (36 nonempty observations); no cohort hit reports QMD. Across all baseline modes, saved raw hits are legacy 589, metadata 8, and QMD 8. Those broader counts are not the backend distribution of the ranked scorecard. All cohort pages map successfully, but the raw hits lack source-version/content-hash fields: fixture page identity and a current registry snapshot do not prove the version actually served in a hit. See [raw rank methods and per-observation records][ranked].

Conditional on an observed search invocation, the supplemental denominator is 16 paper cases/32 observations and 18 evidence cases/36 observations. Paper Recall@5 is 0.813, Precision@5 0.200, MRR 0.771; evidence Recall@5 is 0.509, Precision@5 0.144, MRR 0.556. These are conditional retrieval estimates, not replacements that erase an uninvoked pipeline request.

| Raw rank cohort | Paper cases / observations | Paper R@5 / P@5 / MRR | Evidence cases / observations | Evidence R@5 / P@5 / MRR |
| --- | ---: | --- | ---: | --- |
| Primary EctD | 4 / 8 | 1.000 / 0.250 / 1.000 | 4 / 8 | 1.000 / 0.250 / 1.000 |
| CelluWeave stress | 13 / 26 | 0.692 / 0.169 / 0.641 | 15 / 30 | 0.344 / 0.107 / 0.400 |
| Development | 14 / 28 | 0.857 / 0.214 / 0.810 | 15 / 30 | 0.611 / 0.173 / 0.667 |
| Heldout | 3 / 6 | 0.333 / 0.067 / 0.333 | 4 / 8 | 0.000 / 0.000 / 0.000 |

All four primary EctD retrieval cases are development cases; no primary-domain heldout ranked performance is established. The full suite's domain split is EctD 18 development/6 heldout and CelluWeave 54 development/18 heldout. These small eligible retrieval subsets cannot establish broad generalization.

### Selected context is a separate stage

The following scores use selected `paperIds` and emitted `evidenceIds` on the same eligible cohort. They measure what reaches context, not raw search ranks. Opening a retrieved paper can expose additional relevant pages; routing can also discard a relevant search hit.

| Context metric | Paper | Emitted evidence |
| --- | ---: | ---: |
| Recall@5 | 0.706 | 0.640 |
| Recall@10 | 0.706 | 0.654 |
| Precision@5 | 0.176 | 0.168 |
| MRR | 0.706 | 0.544 |

A difference between these two tables is a difference between stages of the same saved run, not an improvement between candidates. `CW-DISCOVERY-05` invoked a corpus workflow and is reported as a tool-selection departure; it is excluded from both tables rather than scored as ordinary top-K retrieval.

### Other independently interpretable outcomes

| Measure | Local result | Interpretation boundary |
| --- | --- | --- |
| Primary EctD exact experiment fulfillment | 0/16 observations, 8 cases | Includes unresolved/uninvoked requests; see experiment breakdown |
| All scored exact experiment fulfillment | 0/55 observations, 28 case clusters | Includes unsupported arbitrary stress fields; not a primary-domain capability estimate |
| Actual corpus analyzed/snapshot | Cold 28/32; warm 32/32 | Four workflows per condition, including one blocked intended-fault case |
| Required hard checks | 53 fail, 819 unknown, 6 pass | Individual gate results; no average or release approval |
| Final-answer citation/claim correctness | Unknown | No generated final answers |
| Live scientific answer quality and pairwise win rate | Separate live results below; pairwise n=0 | Independent judge artifacts; no candidate branch |

## LLM judge results (absolute/pairwise)

The full local baseline has no final-answer generation trials, so it has no valid LLM-judged final-answer quality average, final-answer hallucination rate, or pairwise preference win rate. The independent saved-output adversarial review identifies concrete tool/context failures and preserves its blind-review provenance; it is not a fabricated final-answer judge score. A located evidence ID or text substring establishes neither semantic entailment nor scientific correctness. Deterministic grounding credit requires the explicit source-linked structured fact to match; unmeasured prose remains unknown.

### Live Side Chat and fresh independent judgments

The live selection was saved before any live output: **11 unique cases (seven development, four heldout), 13 responses**, comprising ten primary EctD goals and one CelluWeave goal. Two goals were repeated. The signed-in Electron app used the normal Side Chat interface and authenticated FC route; no provider substitute was supplied. Each prior answer was archived before editing the single user turn, so the next case did not inherit prior conversation text. Artifacts remained in one isolated synthetic workspace and warmed sequentially. The renderer was reloaded, but the Electron main-process revision and deployed FC revision were not attested. The visible setting said Lite while persisted execution telemetry said Medium.

The original full local baseline was frozen before diagnosis. Each live answer was also preserved before scoring/diagnosis; the final live baseline collects those immutable observations. Local fallback and live answer results are separate estimands, not a before/after improvement claim.

Fresh evaluator agents received only one question, the frozen gold/allowed sources, candidate answer/citations and strict anchored rubric. They received no production implementation, execution narrative, producer reasoning or branch/model labels. Canonical scores passed structured validation. A separate adversarial reviewer examined failures. Different evaluator/producer model identity could not be attested; fresh-context separation was enforced.

| Live semantic case | Overall / 5 | Main result |
| --- | ---: | --- |
| EctD discovery, English | 5 | P117 and relevant A163V/Km evidence correctly identified |
| P152 activity versus titer | 4 | Values correct; unsupported inference about linear correlation |
| Heldout P152 metric leaders/yield | 5 | Correct leaders; correctly says measured yield absent |
| Heldout lower-Km sufficiency | 3 | Correct insufficiency conclusion, uncited mechanistic expansion |
| Current-objective recommendation | 3 | Does not resolve current titer objective; unsupported CelluWeave integration claim |
| Three-paper means/sample counts, first | 2 | Falsely says P17/P52 counts unreported; unresolved citation |
| Same three-paper question, repeat | 2 | Same material omissions and unresolved citation |

The primary aggregate weights six unique cases equally, averaging repetitions within a case. Correctness **3.67**, faithfulness **3.67**, completeness **3.83**, relevance **4.33**, uncertainty handling **3.50**, clarity **4.25**, overall **3.67**. Cross-source synthesis is **3/5 on only one applicable case**; the other tasks were scored inapplicable, so broad literature-review synthesis quality is not established. Overall median is 3.5 and variance across case means is 1.467. A second fresh judge on the same uncertainty answer also gave overall 3 and faithfulness 3, but correctness differed by one point (3 versus 4). One double-scored answer cannot establish evaluator reliability.

Judge-assisted grounding estimates, separately from deterministic scores:

| Measure | Equal-case estimate | Scope / limitation |
| --- | ---: | --- |
| Strict claim support precision | 64.5% | Six cases; 95% CI [36.7%, 86.7%] |
| Unsupported or contradicted claims | 8.2% | Unsupported 3.7%, contradicted 4.5% |
| Uncertain/unverified claims | 27.2% | Not silently counted as supported or proven false |
| Explicit gold-claim coverage recall | 93.3% | Five cases with gold claims; not all answer requirements or themes |
| Source-citation support precision | 87.9% | Four eligible cases with audited source-bound citation links; conditional, excludes zero-link cases |
| Audited-claim citation coverage | 64.3% | Includes uncited cases |
| Page-level citation correctness | Unmeasured | No localized page links in the judged sample |

These are LLM-assisted evidence judgments, not objective scientific truth. Claim segmentation differs across answers; raw micro totals (71 audits) must not replace the equal-case estimand. The deterministic citation audit across all 13 outputs separately found **15 citation objects: 13 resolved, two missing**; **0/7 PDF citations specified a page**, and **4/6 spreadsheet citations specified a row**. Broken corpus citations remain failures even though the conditional source-support precision looks higher.

**Pairwise comparison: zero cases; candidate win rate, baseline win rate and tie rate are null.** There is only one production baseline. The comparator supports seeded randomized A/B packets and a separate hidden order mapping; an unchanged-system or cache comparison is not represented as a candidate victory.

Evidence: [live baseline][live-baseline], [validated judges][live-judges], [grounding audit][live-grounding], [citation audit][live-citations], and [independent telemetry verification][live-telemetry-validation].


## Cost

The live UI lane made **90 observed FC client requests** (median six per turn):

| Observed transport role / endpoint | Requests | Successful | Failed |
| --- | ---: | ---: | ---: |
| Semantic parser | 11 | 0 | 11 |
| Experiment schema mapper | 40 | 0 | 40 |
| Paper Card from text | 8 | 8 | 0 |
| Search planner | 3 | 3 | 0 |
| Reranker | 2 | 2 | 0 |
| Configuration endpoints | 13 | 13 | 0 |
| Final Side Chat `/chat` | 13 | 13 | 0 |
| Corpus mapper / native PDF / separate remote reduce or verification | 0 observed | — | — |

The last row describes separately observed endpoints; reduce/verification also perform local work, and model work inside `/chat` is not separately transport-observable. Persisted answer counters total **38 backend loop steps**, not 38 HTTP requests. Persisted per-user counters miss eight cold card calls, four sync schema calls, three planners and two rerankers. Logged `providerAttempts: 0` can be a default for an omitted FC field and does not prove no upstream call. **Actual Requesty requests, input/output tokens, provider cache token savings, evaluator billing and USD cost remain unknown.** No credentials were placed in fixtures or logs.

There were 51 failed auxiliary requests out of 77. This is an observed failure rate, not a claim that every such call was avoidable. Repeated unavailable schema calls and paper retrieval for simple table questions are concrete efficiency candidates. Both X02 table requests invoked paper retrieval and read five papers; X04 also invoked literature tools. Legitimate spreadsheet/source fallback is not counted as inherently unnecessary. A universal unnecessary-tool/provider-call rate cannot be established without complete classified traces.

The cost evidence is [deduplicated runtime telemetry][live-telemetry], independently reconciled against all 13 saved turns. The two log exports overlap by 641 exact events, preserving 1,333 unique events from `app.ready` through the last response with matched starts/completions.

### Controlled local workload

Observed live FC and Requesty calls are zero in the full local baseline. This is a boundary of the executed lane, not a price estimate for live operation. USD retrieval, generation, and judge costs each have **0 known and 192 missing observations**; their totals are `null`, not `$0`. Input/output tokens, model pricing, and paid-provider cache accounting are unavailable. Judge costs belong to the separate judging lane.

| Recorded local work counter | Cold sum | Warm sum |
| --- | ---: | ---: |
| Observations with counters | 93/96 | 95/96 |
| QMD searches | 169 | 170 |
| QMD updates | 2,941 | 8 |
| Controlled Paper Card callbacks | 710 | 2 |
| Provider map requests | 0 | 0 |
| Native PDF provider requests | 0 | 0 |

Missing counter observations are not filled with zeros. Controlled Paper Card callbacks represent logical local work, not billed model calls. Cold/warm sums cover different observed denominators and should not be divided into a universal dollar saving. Details are in the [metric audit][metrics].

### Context discipline

These are serialized JSON UTF-16 character counts, not measured model prompt tokens. Large context envelopes warrant measurement at the actual prompt boundary before claiming token savings.

| Context measurement | Cold | Warm |
| --- | ---: | ---: |
| Observations | 93 | 95 |
| Main context characters, p50 / p95 / maximum | 21,756 / 179,147 / 252,303 | 19,628 / 179,825 / 250,140 |
| Sync-report characters, p50 / p95 | 2,362 / 2,386 | 252 / 375 |
| Structured handles, sum / p50 / p95 / maximum | 29 / 0 / 1 / 2 | 29 / 0 / 1 / 2 |
| Observations with no structured handles | 66/93 | 68/95 |

`rawMaintenanceTranscriptPresent` is unknown for all 188 observations with context-discipline records. The smaller warm sync report does not prove that raw maintenance transcripts are absent from the final prompt or that context is adequately compressed.

## Latency

| Live timing | Cold workspace (n=1) | Subsequent shared-workspace requests (n=12) |
| --- | ---: | ---: |
| User-to-answer median | 340.854 s | 51.032 s |
| User-to-answer interpolated p95 | One sample; no population estimate | 154.943 s |
| User-to-answer range | 340.854 s | 18.433–203.839 s |
| Preflight median | 314.748 s | 0.009 s |
| Preflight nearest-rank p95 | One sample | 0.020 s |
| User-to-actual-main-start median | 316.743 s | 2.799 s |

The whole 13-response set has median 58.7 s, interpolated p95 258.645 s, mean 85.922 s. The response table uses linear-interpolated percentiles; the runtime analyzer additionally reports nearest-rank p95 (203.839 s for the 12 warm responses). With these small samples percentile estimates are unstable. All 13 answers were buffered; logged response-available time is not measured screen visibility or streaming first-token time, which remain unknown.

The identical discovery request took **340.854→18.433 s**, with **26→6 FC requests** and **eight→zero new cards**. The corpus question, after the workspace was already warm, took **84.737→90.880 s**, with **three→three FC requests** and all eight maps reused on the repeat. Cache reuse therefore did not guarantee lower final-answer latency or improved quality. This is two paired requests, not a general speedup estimate.

### Controlled local timings

The table reports milliseconds for all observations with the corresponding timer, including incomplete executions where a timer exists. Counts differ because setup and failures can interrupt measurement. Fixture materialization is separated from application execution.

| Timer | Cold n | Cold p50 / p95 (ms) | Warm n | Warm p50 / p95 (ms) |
| --- | ---: | ---: | ---: | ---: |
| Preflight reconciliation + knowledge sync | 93 | 1,929.65 / 2,070.29 | 95 | 0.77 / 69.87 |
| Main-agent start gate | 93 | 1,936.09 / 2,089.39 | 95 | 0.78 / 75.99 |
| Execution after setup | 94 | 2,026.33 / 2,474.65 | 96 | 53.83 / 282.03 |
| Fixture setup | 94 | 154.43 / 1,065.81 | 96 | 0.03 / 0.06 |
| Total harness including setup | 96 | 2,191.69 / 3,026.75 | 96 | 53.86 / 282.07 |

Completed-only execution is cold n=82, p50 2,029.96/p95 2,518.67 ms; warm n=84, p50 54.87/p95 264.97 ms. These are an additional conditioning choice, not silently substituted denominators. In the two-context-turn `CW-ECTD_WORKFLOWS-03` case, execution covers both turns but preflight/main-gate fields cover the last turn. Cold/warm observations share case state and are not independent trials. No live-provider time to first token, full-answer latency, or token throughput is measured here. See [latency audit][metrics].

## Multilingual

In the live subset, one equivalent EN/ZH discovery pair correctly identified P117 in both languages; the Chinese mixed-header X04 query and direct P131 Km lookup also returned correct values. This is limited positive evidence, not a live Recall@K estimate. Persisted citations are not ranked search results, so live paper/evidence Recall@K and top-five overlap are unmeasured. The following ranked parity measurements are from the larger controlled local lane.

There are three matched EN/ZH case pairs, each run cold and warm: `lookup_p17_en_zh`, `discover_calcium`, and `ectd_discovery_a163v`. This is three independent pair clusters, not six independent bilingual tests. Cold and warm raw arrays match in these pairs.

| Matched-pair measurement | English | Chinese | Absolute EN–ZH gap |
| --- | ---: | ---: | ---: |
| Raw paper Recall@5 and @10 | 1.000 | 0.667 | 0.333 |
| Raw page-evidence Recall@5 and @10 | 0.667 | 0.667 | 0.000 |
| Context-emitted evidence Recall@5 | 1.000 | 0.667 | 0.333 |

Raw top-five Jaccard overlap is 0.514 for papers and 0.325 for page evidence. Context top-five overlap is 0.514 and 0.286 respectively. The paper recall gap's pair-bootstrap 95% interval is [0, 1]; the page-evidence gap interval is [0, 0] only for these three fixed pairs and does not establish broad bilingual parity.

The calcium pair explains the distinction: English discovery retrieves P17, Chinese discovery misses it, but the English raw hit is page 1 while the relevant frozen evidence is page 2. English context gains the evidence after the paper is opened. Accordingly, raw page-evidence equality coexists with worse Chinese paper discovery and context evidence. No final-answer language-quality or answer-language compliance score exists in the local baseline. See the [matched-pair records][ranked].

## Corpus

The live three-original-paper request invoked an entire-project snapshot of **eight papers**. Both answers displayed **8/8 analyzed, zero failed/missing**. The final saved workflow confirms eight prepared/analyzed sources, eight canonical artifacts/maps reused, zero new question projections/provider maps, and **34 `original-evidence-located` verification records**. Despite this, both final answers omitted P17 n=5 and P52 n=6. Four of six explicitly required mean/count facts were conveyed; operational coverage is not scientific completeness.

Post-score [corpus diagnosis][live-corpus-diagnosis] found that actual generated P17/P52 Paper Card findings omitted counts, while P31 retained n=6; maps and reduction inherited those omissions. Original evidence excerpts still contained the missing counts. Reconstructing the actual result preview placed the first P17 n=5 after character 42,950 and the independent P52 count after character 47,732 in a 48,643-character result, beyond the tool's default 12,000/maximum 16,000-character first page. The useful means and P31 count appeared earlier. This is a supported information-loss/truncation hypothesis; actual model read offsets were not logged, so the precise read history is unproven. Both cited result files existed: citation failure came from an unresolved catalog identity, not a physically deleted source.

Live theme coverage and long-form review quality remain insufficiently sampled. The selected case is a factual multi-paper synthesis, not a full literature review. The following corpus stress and cold-directory results belong to the controlled local lane.

The audit separates corpus snapshot/preparation/analysis from ordinary retrieval. Four actual workflows ran in both cache conditions: `CW-DISCOVERY-05`, `CW-CORPUS-01`, `CW-CORPUS-04`, and `CW-ECTD_WORKFLOWS-04`. The last case is blocked for its intended malformed-map fault, which was not reached; its actual workflow is still included in this observational workload table.

| Actual workflow measure | Cold | Warm |
| --- | ---: | ---: |
| Workflows / snapshot sources | 4 / 32 | 4 / 32 |
| Prepared sources | 32/32 | 32/32 |
| Analyzed sources | 28/32 (87.5%) | 32/32 (100%) |
| Per-workflow analysis | 7/8 in each | 8/8 in each |
| Failed source maps | 1 per workflow | 0 |
| Local question projections | 8 per workflow | 1 per workflow |
| Controlled cards generated in preflight | 8 per workflow | 0 |
| Verification records | 80 total | 92 total |

Each cold workflow encountered `EEXIST` in concurrent map-directory creation; the warm run reused seven successful maps and retried the failed one under the same workflow ID. Workflow status was `completed` even with 7/8 analyzed, so that status alone is not a coverage metric. The relevant P31 source was lost in cold `CW-CORPUS-01`. A separate real-filesystem reproducer in the [adapter audit][adapter] supports the directory-race diagnosis.

Cold preparation also reports eight cache hits/canonical-card reuses per workflow because preflight had just produced the cards. It would be incorrect to infer zero cold card work. All verification records say `original-evidence-located`; they establish source location, not claim entailment or an independently judged scientific conclusion. Provider map and native-PDF requests are zero.

Seven declared corpus cases have no actual corpus workflow: `CW-CORPUS-02`, `03`, `05`, `06`, `07`, `08`, and `CW-ECTD_WORKFLOWS-03`. The last case's two context builds are not proof of a live conversation or corpus-workflow reuse. The original `corpus.analyzedRecall` of 0.944 concerns required-gold subsets in three valid cases/six observations; it is not 94.4% coverage of every snapshot. The [metric audit][metrics] retains per-run workflow IDs, snapshot membership, failed IDs, reuse, and verification counts.

## Experiments

The live primary-domain subset passed **2/3 complete numeric requests** by deterministic comparison against frozen gold, including units, aggregation, filtering/grouping and answer-evidenced source rows. The independent adversarial reviewer recomputed the means from original fixture rows:

| Live request | Actual result | Deterministic result |
| --- | --- | --- |
| X02 completed A163V mean titer | 4.85 g/L, X02-R1/R2 | Pass |
| X02 completed T212S activity at 35°C | Claimed no matching rows; correct mean is 2.25 U/mg from X02-R3/R4 | **Fail** |
| Heldout mixed-header X04 at 42°C | A163V 4.65, T212S 3.95 g/L; correct four row citations | Pass |

Correct row selection can establish requested filter fulfillment without exposing hidden query execution. This checks requested outputs, not every incidental numeric claim in every answer. Three cases are far too few to estimate broad experiment reliability. The 100% deterministic experiment release gate is **not met**. See [live deterministic scores][live-deterministic].

### Controlled local experiment path

Exact fulfillment requires the requested field, value within frozen tolerance, unit, aggregation, filters, grouping, and source rows. A correct-looking number or winning variant is insufficient when it comes from the wrong rows. Required queries with an observed empty structured result fail fulfillment; an unavailable final answer stays unknown. The scorer does not infer a missing production field from the gold description.

All scored exact results are 0/55 observations across 28 case clusters. That broad figure includes CelluWeave fields such as `modulus_kPa`, `retention_pct`, and `water_uptake` outside the fixed production ontology, so the primary EctD denominator is reported separately: **eight cases/16 observations, zero exact requests fulfilled**.

| Primary cases | Observations | Actual outcome |
| --- | ---: | --- |
| `CW-ECTD_EXPERIMENTS-01`, `02`, `03`, `08` | 8 | Structured query unresolved; no numeric result |
| `CW-ECTD_EXPERIMENTS-04`, `06`, `07` | 6 | Aggregates emitted and preserved, but wrong requested metric/scope/rows or values |
| `CW-ECTD_EXPERIMENTS-05` | 2 | Structured query not invoked |

The adapter audit verified that the empty results in cases 01/02 were not dropped correct aggregates: raw X02 suffixed headers such as `titer_g_L` and `activity_U_mg` retain `canonicalField: null`, while variant maps to mutation. The controlled run has no live schema/semantic parser. In case 04, the frozen gold calls its field `activity`, whereas the ontology's desired field would be `specific_activity`; the emitted titer, g/L unit, and wrong rows independently establish failure without retuning that alias.

Three numeric examples make the failure mode concrete:

| Case | Frozen request | Saved result |
| --- | --- | --- |
| `CW-ECTD_EXPERIMENTS-04` | X02 completed T212S at 35°C: mean activity (2.2 + 2.3)/2 = **2.25 U/mg** | **4.075 g/L titer**, pooled from X03/X04 |
| `CW-ECTD_EXPERIMENTS-06` | X02 A163V mean titer (4.8 + 4.9)/2 = **4.85 g/L** | **4.75 g/L**, pooled from X03/X04; filters empty |
| `CW-ECTD_EXPERIMENTS-07` | X04 at 42°C: A163V **4.65**, T212S **3.95 g/L** | **4.75**, **4.075 g/L**, mixing X03 and X04 temperatures |

Case 07 retains the correct group winner while violating the requested population. These are local structured-output errors, not assertions that a final model hallucinated arithmetic. Unsupported derived final-answer calculations remain unmeasured. See [structured diagnostics][experiment-audit] and [adversarial evidence][adversarial].

### Evaluator correction after baseline capture

Scorer 1.0.0 had a grouped-component identity bug: case 07 declared a variant filter, while observed groups used `mutation` plus `groupValue`. The unmatched identity incorrectly marked otherwise matching field/unit/aggregation components as zero. The original scorer was archived with its hash before changing eval-only code. Version 1.0.1 uses explicit group metadata and the declared variant/mutation alias, without using numeric values to choose a match; duplicate, contradictory, or ambiguous groups remain unmatched. A focused regression demonstrates correct metadata components alongside wrong value and exact-result failure.

The original scorer first reproduced all 192 saved score rows. The [rescore sidecar][rescore] then records only case 07 cold/warm field/unit/aggregation changing 0→1. Value, exact fulfillment, and every hard check remain unchanged; the other 190 rows are unchanged. The focused Node scorer suite passed 27/27 tests, including the grouped-identity regression. The original baseline, summary, and frozen cases were not rewritten. Final evaluation-infrastructure validation passed 60/60 Node tests. A separate citation-alias deduplication correction in grounding scorer 1.0.1 changed none of the seven live samples or reported aggregates; the prior module and score file remain archived. This is an evaluator correction, not a production improvement or expected-answer adjustment. Future comparisons must use the same scorer version on both sides and retain any rescoring as separate derived artifacts.

## Sync

The live cold preflight processed 17 source changes, created eight L1 extracts/eight L2 cards and normalized four experiment files. All **12 unchanged follow-up preflights** reported zero changed sources, zero L1/L2 work, zero schema-mapper work within sync, and `syncAgentSpawned: false`. This supports the no-change preflight contract. Additional schema calls occurred later during context construction and are counted separately.

Post-baseline adapter corrections were replayed in **26 separate observations**, including 22 formerly blocked setup/scope observations; all completed. Frozen baseline/gold/production files stayed unchanged. The P83 addition was detected and indexed but its actual query still omitted it; P67 deletion left it marked missing/stale and excluded it from the observed retrieval; `.DS_Store` was ignored, with all three EctD papers still retrievable. These are bounded confirmations, not a blanket 100% sync/security pass. See [replay outcomes][replay-outcomes].

The frozen `sync_current_version` hard checks contain six passes and six unknowns. The continuous version metric is 1.0 on six observations/three cases, but matching bytes can coexist with missing downstream artifacts or a failed source. It does not establish complete sync readiness, successful retry, or fresh retrieval. The corrected-version P31 lookup is a concrete example of ready data that fails to reach context.

Several intended scenarios were not validly executed by the baseline adapter:

| Case / boundary | Baseline limitation | Separate evidence and remaining gap |
| --- | --- | --- |
| `CW-SYNC_FAILURE-02` added paper | Initial-version configuration was treated as overrides, so P83 already existed before the intended add | Corrected replay: cold one card/three QMD updates, warm zero/zero; artifact current, but retrieval still omitted P83 |
| `CW-SYNC_FAILURE-08` | Declared sync mutation unsupported; cold blocked, warm did not repeat failed setup | Separately saved corrected replay; original baseline unchanged |
| `CW-ECTD_WORKFLOWS-06` | `add_file` setup unsupported in original baseline | Separate corrected replay ignored real `.DS_Store` bytes; baseline remains unchanged |
| `CW-ECTD_WORKFLOWS-04` | Malformed-map injection never reached because cards were reused | Observed `EEXIST` is a different failure; cannot claim malformed-map recovery |
| `CW-ECTD_WORKFLOWS-05` | Intended recovered source still received injected `EIO` | Cannot establish retry after the fault is released; version identity is insufficient |
| Memory / permission fixtures | Native memory input mapping unverified; enterprise-ACL adapter limit mismatched native project scope | Model memory behavior and permissions remain unknown |

These adapter corrections and replay observations are stored under [adapter audit][adapter], separate from the immutable full baseline. They are not application fixes. Frozen title/page or aggregation ambiguities are documented rather than silently changing expected answers after results were seen.

### Existing regression coverage and its limits

Two additional real-byte probes (malformed PDF and deletion of one row from a retained workbook) reached fixture preparation but did not complete execution. They are explicitly **not frozen, not scored, and not passing tests**; their prepared files are outside the 96-case suite. The corresponding gaps below remain open.

The [coverage matrix][coverage] maps 17 regression classes to 38 original passing test references. Passing a mock or static test is evidence for that layer, not live release clearance.

| Regression class | Existing exercised coverage | Unestablished boundary |
| --- | --- | --- |
| 150 unchanged sources / add paper | In-memory zero extra work for 150 ready sources; three additions trigger three parses/cards | 150 real-PDF filesystem/provider performance |
| Timestamp-only change | Rehash without rebuild | Full filesystem metadata variation |
| Add experiment | XLSX bytes and production normalization | Live upload end to end |
| Delete experiment | Source-row removal | Deleting a single row while retaining its workbook |
| Delete paper | L1/L2/L3 mirrors, topics, stale synthesis invalidation in memory | All real QMD rows/files after deletion |
| Failed stage/map retry | Mocked/in-memory retry and 30/32→32/32 cache reuse | Live provider failure and process restart |
| Malformed PDF | Injected extraction failure | Actual malformed/encrypted PDF bytes |
| Invalid mapper JSON | Injected invalid structured result | Actual model returning malformed output |
| Requesty unavailable | Mocked network/auth/retry failure | A real provider outage |
| QMD failure | Mocked update failure suppresses stale output; separate real SDK smoke | Real disk/SQLite failure |
| Delete during processing | In-memory race | Real concurrent workers/provider execution |
| Ambiguous schema | Preserve raw data and withhold unsupported units/ranking | Live clarification resolution |
| `.DS_Store` | In-memory exclusion | Finder/upload flow with real metadata file |
| Repeated planning | Mocked cache/in-flight deduplication | Actual FC billing and cross-process reuse |
| Han retrieval policy | Unit/mock Light lexical policy without language-only escalation | Broad Chinese ranking quality |
| Direct Requesty restriction | Static literals and packaging scan | Runtime network denial |
| Symlink/path escape | Real temporary filesystem traversal/read/write/leaf-symlink rejection | TOCTOU and all-platform GUI behavior |

## Security/permissions

**Release gates remain unsatisfied.** A hard failure or unknown is not compensated by prose quality.

| Proposed release gate | Current evidence / decision |
| --- | --- |
| 100% deterministic experiment correctness | **Failed:** one of three live gold requests failed; local path also failed |
| Zero Side Chat Current Recommendation mutation | No mutation observed: null before/after all 13 isolated turns; non-null overwrite/adversarial mutation boundary not fully exercised live |
| Zero direct Requesty desktop calls | Static route/security tests passed; live observed requests used FC; complete runtime egress-denial audit unmeasured |
| Zero cross-project contamination/path escape | Real filesystem confinement tests passed; complete live cross-project audit unmeasured |
| Zero deleted-source retrieval | P67 controlled deletion excluded from observed results; comprehensive real-QMD/row-deletion coverage incomplete |
| 100% controlled add/delete detection and invalidation | Bounded fixture/tests support several transitions; full end-to-end matrix not established |
| Reliable citation provenance | Two live corpus citations unresolved; no PDF page localization in seven paper citation objects |

The final Chinese direct lookup stayed on Side Chat, used fast retrieval and returned P131 Km=0.55 mM without an Agent Command workflow. This is one bounded permission/routing observation. No production recommendation was changed during evaluation. The original local hard-check accounting below is preserved rather than converted into fabricated live passes.

| Required check | Pass | Fail | Unknown |
| --- | ---: | ---: | ---: |
| Permission no leak | 0 | 0 | 192 |
| No fabricated citation | 0 | 0 | 192 |
| No unrequested side effect | 0 | 0 | 192 |
| No unsupported numeric claim | 0 | 0 | 192 |
| Missing-evidence abstention | 0 | 0 | 32 |
| Valid source rows | 0 | 53 | 3 |
| Current sync version | 6 | 0 | 6 |
| Failure transparency | 0 | 0 | 10 |

All 53 failed checks concern source rows. Empty required primitive outputs, unsupported stress fields, and setup limitations contribute; these are not 53 observed unauthorized accesses. No complete access, action, citation, or numeric-claim audit exists, and the local lane produced no final answers. Native project scopes should not be misrepresented as enterprise ACL enforcement. Static absence of a direct provider credential route is narrower than runtime denial. Release eligibility remains false: unknown required checks and failed checks must be resolved explicitly, never compensated by mean retrieval performance.

## Top failures

### Live findings with the highest practical impact

| ID / case | Failure | Primary taxonomy |
| --- | --- | --- |
| LIVE-01 / ECTD_EXPERIMENTS-04 | Denies existing X02 T212S 35°C rows; misses 2.25 U/mg after 203.839 s | EXPERIMENT_NORMALIZATION |
| LIVE-02 / CORPUS-01, both runs | Says P17/P52 sample counts are unreported despite original n=5/n=6 | EVIDENCE_SELECTION |
| LIVE-03 / CORPUS-01, both runs | Sole citation has status missing and an unresolved catalog identity | GROUNDING |
| LIVE-04 / ECTD_WORKFLOWS-02 | Ignores saved titer objective, leaves variant choice conditional | REASONING |
| LIVE-05 / ECTD_PAPERS-08 | Correct insufficiency answer expands into uncited, unsupported mechanistic claims | GROUNDING |
| LIVE-06 / ECTD_WORKFLOWS-02 | Suggests integration with a CelluWeave domain absent from scientific sources | GROUNDING |
| LIVE-07 / 51 auxiliary calls | All 40 schema and 11 semantic parser requests return unavailable errors | ROBUSTNESS |
| LIVE-08 / cold discovery | 314.748 s preflight before a simple lookup; 26 FC calls total | LATENCY |
| LIVE-09 / persisted telemetry | Omits card/planner/reranker/sync calls and mixes answer-loop steps with request counts | COST |
| LIVE-10 / paper answers | Seven PDF citation objects have no page localization | EVIDENCE_SELECTION |

The unsupported-mechanism and conditional-objective judgments are semantic assessments with supplied evidence; the missing rows, counts, citation status, transport failures and timings have deterministic/log corroboration. The following ten additional failures were found independently in controlled local outputs.

The independent [adversarial review][adversarial] provides immutable output pointers, question text, expected facts, and evidence for these ten local failures. Case IDs identify the saved observations (`repeat: 0` cold, `repeat: 1` warm). Each future production fix should add a targeted example to the relevant existing regression class and replay the frozen evaluation; this report implements no production fixes.

| Priority / finding | Reproducible case | Expected → observed local behavior | Regression class for a future fix |
| --- | --- | --- | --- |
| P1 / ADR-B01 | `CW-ECTD_EXPERIMENTS-04` | Explicit activity, not titer; 2.25 U/mg → 4.075 g/L titer | Semantic intent/integration and experiment metric/units |
| P1 / ADR-B02 | `CW-ECTD_EXPERIMENTS-06` | X02 mean 4.85 → cross-source mean 4.75 g/L | Structured source filters and source-row provenance |
| P1 / ADR-B03 | `CW-ECTD_EXPERIMENTS-07` | 42°C means 4.65/3.95 → mixed-temperature 4.75/4.075 | Grouped aggregation/filter integration |
| P1 / ADR-B04 | `CW-ECTD_EXPERIMENTS-01` and `02` | Numeric X02 titer rows available → `no_numeric_values:titer` | Experiment header normalization and schema ambiguity |
| P1 / ADR-B05 | `CW-DISCOVERY-02`; related `08` | Chinese calcium discovery should find P17 → distractors/miss; water-uptake search genuinely empty | Multilingual retrieval and semantic integration |
| P2 / ADR-B06 | `CW-DISCOVERY-07` | Refrigerated P83 ready and relevant → omitted in favor of other temperature papers | Discovery relevance; heldout validation remains untuned |
| P1 / ADR-B07 | `CW-LOOKUP-03` | Current corrected P31 evidence should reach context → raw rank 3, selected context empty | Source-identified lookup routing/evidence integration |
| P2 / ADR-B08 | `CW-MULTILINGUAL-05` | Literature-only request → structured query scans 37 experiment rows | Negative capability constraint and semantic intent |
| P1 / ADR-B09 | `CW-CORPUS-01` | Analyze all eight sources → cold directory race loses P31, warm recovers | Real ProjectFilesystem concurrency and corpus retry |
| P2 / ADR-B10 | `CW-LOOKUP-05` | Nonexistent exact title should have no match → five unrelated hits | Exact-title negative retrieval |

The literature-only case concerns an unrequested query, not an observed external mutation. The nonexistent-title case concerns false-positive retrieval, not a fabricated final claim about a clinical study. Numeric misses are not all arithmetic bugs, and a source being ready does not prove it was routed to the main context. Existing test homes include [semantic intent][test-intent], [semantic integration][test-integration], [experiment semantics][test-experiments], [source system][test-sources], [preflight sync][test-sync], [ProjectFilesystem][test-filesystem], [cloud retrieval][test-retrieval], and [security boundary][test-security].

## Recommendations

Priorities reflect both live and local failures. Expected impact is qualitative; no measured improvement or implementation is claimed. First test a deployment/configuration candidate that restores the unavailable FC semantic/schema capabilities while preserving the authorized route. Then test source/condition fidelity, final-answer evidence verification and citation identity, followed by cache/call discipline. These are recommendations only.

| Priority | Recommendation | Expected quality impact | Engineering effort | Cost impact | Risk and required validation |
| --- | --- | --- | --- | --- | --- |
| P0 | Attest FC revision/model/schema compatibility and restore unavailable semantic/schema endpoints in an isolated candidate | High: current live run falls back after every such call | Small–medium, depending on configuration cause | May replace failed calls with billed calls; measure both | Deployment/security boundary; same gold cases and failure-state reruns |
| P1 | Verify requested facts against original evidence before finalizing, and return resolvable source/page citations | High: prevent false missing-count claims and broken references | Medium | Extra reads/verification may cost tokens | Evidence truncation and false entailment; corpus case plus heldout long-form sources |
| P1 | Use current versus superseded memory explicitly when resolving recommendations | High for project-context correctness | Medium | Bounded memory retrieval | Wrong objective or permission mutation; non-null recommendation boundary tests |
| P1 | Preserve requested metric, negation, source, temperature, and status through semantic planning and structured execution | High: prevent plausible results from the wrong population | Medium | Mostly local; clarification may add a call | Query-scope regressions; extend intent/integration/filter tests and replay frozen cases |
| P1 | Normalize supported suffixed numeric headers and units, withholding ambiguous mappings | High for primary EctD numeric availability | Medium | Low local work; may reduce retries | Wrong unit conversion; extend experiment/schema-ambiguity tests, retain raw provenance |
| P1 | Make concurrent corpus directory creation robust and preserve retry semantics | High first-run source coverage | Small–medium | Reduce failed work/retry | Filesystem/platform races; real concurrency reproducer plus existing corpus retry class |
| P1 | Preserve explicit paper identifiers and negative capability constraints in routing | High source access and request fidelity | Medium | Bounded source reads; avoid extra unrelated queries | Over-broad retrieval; lookup and capability-constraint integration tests |
| P2 | Improve multilingual discovery and semantic distractor handling | High for demonstrated stress failures | Medium–high | Query planning/reranking could add provider cost | Do not hardcode case keywords or escalate solely for Han text; matched-pair and heldout validation |
| P2 | Make exact-title absence a distinct retrieval outcome | Medium: reduce misleading context | Small–medium | Minimal | Over-strict matching can reduce valid recall; positive and negative lookup tests |
| P2 | Complete adapter setup/fault coverage before reporting acceptance rates | High measurement trust | Medium | Additional test runs | Keep native scope, fault release, memory mapping, malformed bytes, and row deletion separate; never overwrite baseline |
| P2 | Record actual prompt tokens, provider role usage, streaming latency, and complete access/action audits | High confidence in quality/cost/security claims | Medium | Small telemetry overhead | Redaction/privacy and missing-data semantics; unknown must stay distinct from zero |
| P2 | Reduce maintenance/context payload only after measuring the actual prompt boundary | Potential cost and latency benefit | Medium | Potential reduction, currently unquantified | Losing relevant evidence; gate changes on source coverage and exact fulfillment |

### Statistical confidence and deciding whether a future change is better

Intervals use 2,000 fixed-seed (`20260907`) percentile bootstrap samples of case means, with equal case weights and cold/warm observations kept within each case cluster. Multilingual intervals cluster by matched pair ID. They describe this curated synthetic suite; cold/warm runs are correlated and there are no repeated stochastic model-answer trials in the local baseline. Small heldout and bilingual denominators produce weak generalization evidence, even where a point estimate is 1.0 or an interval is degenerate.

A future comparison should use the same frozen dataset hash, execution boundary, source setup, cache conditions, and declared scorer version, with matched case/repeat IDs. If scoring changes, derive separate baseline and candidate rescoring artifacts under the same version while preserving the original captures. For live quality, add independent repeated generation trials and keep provider/model configuration and usage observable. Predeclare primary metrics and meaningful change thresholds; do not select a favorable metric after seeing results or tune the 24 heldout cases.

The comparator lists every regression and its valid comparable denominator, including lost observations and new hard-check failures. Use paired case-cluster bootstrap intervals for metric deltas: an interval entirely on the favorable side supports improvement on this cohort; an interval crossing zero is inconclusive. Lower is favorable for cost/latency, higher for recall/exactness. Multiple metrics and small cohorts require restraint. A retrieval gain never cancels a hard safety or source-validity failure, and missing metrics are not silently treated as zero or excluded from coverage reporting.

Absolute scientific judgments require a fresh independent judge with the frozen evidence and rubric. Pairwise judgments require blinded packets, randomized order, and a separate hidden order mapping; no comparator should invent judge preferences from its own answer. There is no pairwise win rate until actual judge choices exist. Changing expected answers requires a new frozen suite version and baseline, not a correction of the old result toward the candidate.

Documented reproduction commands (use a new output directory; preserve this baseline):

```sh
npm run eval:agent
npm run eval:agent -- --suite retrieval
npm run eval:agent -- --suite sync
npm run eval:agent -- --suite multilingual
npm run eval:agent -- --suite corpus
npm run eval:agent -- --suite experiments
npm run eval:agent -- --suite permissions
npm run eval:agent -- --suite robustness
npm run eval:test
npm run eval:compare -- --baseline BASELINE --candidate CANDIDATE --out COMPARISON
```

[baseline]: </Users/wei/Documents/Columbia University/PhD/AI4S/Dev/evals/results/baseline-2026-09-07/baseline.json>
[ranked]: </Users/wei/Documents/Columbia University/PhD/AI4S/Dev/evals/results/baseline-2026-09-07/ranked-retrieval-audit.json>
[metrics]: </Users/wei/Documents/Columbia University/PhD/AI4S/Dev/evals/results/baseline-2026-09-07/metric-audit.json>
[adversarial]: </Users/wei/Documents/Columbia University/PhD/AI4S/Dev/evals/results/baseline-2026-09-07/adversarial-findings.json>
[diagnostics]: </Users/wei/Documents/Columbia University/PhD/AI4S/Dev/evals/results/adapter-audit-2026-09-07/diagnostics.json>
[adapter]: </Users/wei/Documents/Columbia University/PhD/AI4S/Dev/evals/results/adapter-audit-2026-09-07/adapter-audit.json>
[experiment-audit]: </Users/wei/Documents/Columbia University/PhD/AI4S/Dev/evals/results/adapter-audit-2026-09-07/ectd-structured-observations.json>
[rescore]: </Users/wei/Documents/Columbia University/PhD/AI4S/Dev/evals/results/baseline-2026-09-07/rescore-sidecar.json>
[coverage]: </Users/wei/Documents/Columbia University/PhD/AI4S/Dev/evals/results/baseline-2026-09-07/coverage-matrix.json>
[existing-tests]: </Users/wei/Documents/Columbia University/PhD/AI4S/Dev/evals/results/baseline-2026-09-07/existing-tests-diagnosis.json>
[existing-benchmarks]: </Users/wei/Documents/Columbia University/PhD/AI4S/Dev/evals/results/baseline-2026-09-07/existing-benchmarks.json>
[suite]: </Users/wei/Documents/Columbia University/PhD/AI4S/Dev/evals/biodesign-eval-v1/README.md>
[runner]: </Users/wei/Documents/Columbia University/PhD/AI4S/Dev/evals/README.md>
[test-intent]: </Users/wei/Documents/Columbia University/PhD/AI4S/Dev/alibaba-fc/test/semantic-intent.test.js>
[test-integration]: </Users/wei/Documents/Columbia University/PhD/AI4S/Dev/alibaba-fc/test/semantic-integration.test.js>
[test-experiments]: </Users/wei/Documents/Columbia University/PhD/AI4S/Dev/alibaba-fc/test/experiment-semantics.test.js>
[test-sources]: </Users/wei/Documents/Columbia University/PhD/AI4S/Dev/alibaba-fc/test/source-system.test.js>
[test-sync]: </Users/wei/Documents/Columbia University/PhD/AI4S/Dev/alibaba-fc/test/preflight-knowledge-sync.test.js>
[test-filesystem]: </Users/wei/Documents/Columbia University/PhD/AI4S/Dev/desktop/test/project-filesystem.test.mjs>
[test-retrieval]: </Users/wei/Documents/Columbia University/PhD/AI4S/Dev/desktop/test/cloud-retrieval.test.mjs>
[test-security]: </Users/wei/Documents/Columbia University/PhD/AI4S/Dev/desktop/test/security-boundary.test.mjs>

[live-baseline]: </Users/wei/Documents/Columbia University/PhD/AI4S/Dev/evals/results/live-ui-2026-09-07/baseline.json>
[live-judges]: </Users/wei/Documents/Columbia University/PhD/AI4S/Dev/evals/results/live-ui-2026-09-07/judge-scores.json>
[live-grounding]: </Users/wei/Documents/Columbia University/PhD/AI4S/Dev/evals/results/live-ui-2026-09-07/grounding-scores-v1.0.1.json>
[live-citations]: </Users/wei/Documents/Columbia University/PhD/AI4S/Dev/evals/results/live-ui-2026-09-07/citation-audit.json>
[live-telemetry]: </Users/wei/Documents/Columbia University/PhD/AI4S/Dev/evals/results/live-ui-2026-09-07/telemetry-complete.json>
[live-telemetry-validation]: </Users/wei/Documents/Columbia University/PhD/AI4S/Dev/evals/results/live-ui-2026-09-07/full-telemetry-validation.json>
[live-deterministic]: </Users/wei/Documents/Columbia University/PhD/AI4S/Dev/evals/results/live-ui-2026-09-07/deterministic-scores.json>
[live-corpus-diagnosis]: </Users/wei/Documents/Columbia University/PhD/AI4S/Dev/evals/results/adapter-audit-2026-09-07/live-corpus-diagnostics.json>
[replay-outcomes]: </Users/wei/Documents/Columbia University/PhD/AI4S/Dev/evals/results/adapter-audit-2026-09-07/replay-outcomes.json>
