# Literature grounding and routing: paired local evaluation

Fresh baseline commit `1fb5f536b647`, candidate branch `fix/literature-grounding-and-routing`. Both use scorer **1.0.1** and the same frozen fixture, case selection, and application execution lane. Raw snapshots are compressed and hash identified in [comparison.json](comparison.json).

There are 45 preselected literature cases (35 dev, 10 held-out), run cold and warm. The common raw-ranked cohort contains 40 observations in 20 case clusters. Original eligibility rules exclude corpus declarations and actual corpus workflows. Per-run cohorts and departures remain in the audit files.

| Metric on matched evaluable observations | Baseline | Candidate | Paired delta | 95% case-cluster interval | Observations / case clusters |
|---|---:|---:|---:|---|---:|
| ranked.paper.recall5 | 0.765 | 0.824 | 0.059 | 0.000 to 0.176 | 34 / 17 |
| ranked.evidence.recall5 | 0.454 | 0.509 | 0.056 | 0.000 to 0.167 | 36 / 18 |
| ranked.paper.mrr | 0.725 | 0.784 | 0.059 | 0.000 to 0.157 | 34 / 17 |
| ranked.evidence.mrr | 0.500 | 0.556 | 0.056 | 0.000 to 0.167 | 36 / 18 |
| context.paper.recall5 | 0.706 | 0.824 | 0.118 | 0.000 to 0.294 | 34 / 17 |
| context.evidence.recall5 | 0.640 | 0.693 | 0.053 | 0.000 to 0.158 | 38 / 19 |

Each row uses its own identical, jointly measurable observations for both means and the paired delta; empty frozen relevant sets and unknown page identities are excluded explicitly. Baseline/candidate marginal means over all separately measurable observations remain in comparison.json and must not be subtracted across different denominators. Confidence intervals that include zero do not establish improvement. Context evidence metrics measure emitted-evidence prefix coverage, independently from saved search ranks.

Missing raw-metric coverage is tracked separately from observed numeric regressions: 8 previously measurable raw/context metric entries across 1 cases became unmeasurable. Affected cases: `CW-ECTD_PAPERS-02`. Unlocalized metadata-only ranked hits make page metrics unknown under the original strict audit rule; known page-backed hits and selected context remain recorded.

| Matched EN/ZH metric | Baseline | Candidate |
|---|---:|---:|
| ranked.paper.recall5En | 1.000 | 1.000 |
| ranked.paper.recall5Zh | 0.667 | 0.667 |
| ranked.paper.top5Jaccard | 0.514 | 0.603 |

The bilingual analysis has 3 independent pair clusters; cold/warm repeats remain clustered. Top-five overlap is set Jaccard. Full paired intervals, dev/held-out breakdowns, and observed regressions are in [comparison.json](comparison.json).

The existing scorer also flags **2 bilingual metric regressions**: `ectd_discovery_a163v` repeat 0: `evidence.jaccard10` 0.900 → 0.818; `ectd_discovery_a163v` repeat 1: `evidence.jaccard10` 0.900 → 0.818. These measure cross-language overlap of the emitted context evidence prefix, separately from paper recall or supporting-evidence recall; they remain recorded as regressions.

| Local latency | Baseline | Candidate |
|---|---:|---:|
| cold p50 / p95 (ms) | 2164.584 / 2650.515 | 2416.085 / 3145.152 |
| warm p50 / p95 (ms) | 54.079 / 252.258 | 47.816 / 243.451 |

Observed workflow records with full snapshot coverage: **8/8 → 8/8**. Completed request observations with full workflow coverage: **6 → 6**. Individual snapshot/analyzed counts and controlled map creation counts are in the operations files. A stored workflow can cover all papers while its overall evaluation observation is blocked.

Declared corpus-category requests: **20 → 20**; request statuses **{"completed":18,"blocked":2} → {"completed":18,"blocked":2}**; requests with an observed workflow **6 → 6**. Missing workflow invocations and failed/blocked observations are retained separately; these are not counted as full corpus successes. Coverage does not establish factual answer completeness. See the operations files for failure-injection limitations.

Provider role counters, retrieval backend distributions, and fallback reasons are recorded separately in [baseline-operations.json](baseline-operations.json) and [candidate-operations.json](candidate-operations.json). Controlled card/map generation counters are not paid provider calls.

Live citation resolution, PDF citation page-localization coverage, unsupported/contradicted claim rates, live judge scores, and real provider calls are **unmeasured (null)** because this lane does not generate live answers. Unit regressions can validate citation mechanics but cannot supply those live metrics.

The unchanged compareReports result is preserved in [existing-scorer-comparison.json](existing-scorer-comparison.json). Its `passed` value is **false**. Of its 56 individual regressions, **56 are latency increases and 0 are non-latency metric/check/coverage regressions**. It also reports 2 aggregate operational regressions, 0 candidate hard failures, and 380 unknown hard checks. Every operational regression is retained in the JSON; a single noisy latency run is neither dismissed nor treated as a reliable performance estimate. Unknown checks remain unknown. The custom raw-ranked audit additionally exposes the missing page-metric coverage described above, which the existing context scorer does not measure. This result is not a broad release certification.

Reproduce: `node evals/results/literature-grounding-routing-2026-09-08-final/compare-literature.mjs --baseline PATH --candidate PATH --selection PATH`. Outputs are write-once; supplying different input snapshots requires a new result directory. Frozen expected answers were not edited.
