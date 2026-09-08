# BioDesign agent evaluation baseline

Run: 2026-09-07T23-24-41-852Z. Suite: biodesign-eval-v1. Commit: 2fdf562940e587314c2783f69bd2d18923e0d530; dirty tree recorded by hashes.

All sources are clearly synthetic. Application entrypoint is ProjectContextService.buildContext. Final answers and live provider billing are unmeasured unless an authenticated FC client was used.

96 frozen cases; 24 held out; 192 observations; 26 blocked/error observations.

| Metric | Mean | Case clusters | Bootstrap 95% interval |
|---|---:|---:|---|
| retrieval.paper.recall5 | 0.7222 | 18 | 0.5000 – 0.8889 |
| retrieval.paper.recall10 | 0.7222 | 18 | 0.5000 – 0.8889 |
| retrieval.paper.precision5 | 0.1778 | 18 | 0.1111 – 0.2444 |
| retrieval.paper.mrr | 0.6806 | 18 | 0.4583 – 0.8889 |
| retrieval.evidence.recall5 | 0.6083 | 20 | 0.4083 – 0.8000 |
| retrieval.evidence.recall10 | 0.6708 | 20 | 0.4749 – 0.8500 |
| retrieval.evidence.precision5 | 0.1600 | 20 | 0.1100 – 0.2200 |
| retrieval.evidence.mrr | 0.5227 | 20 | 0.3477 – 0.7000 |
| corpus.includedRecall | 1.0000 | 3 | 1.0000 – 1.0000 |
| corpus.preparedRecall | 1.0000 | 3 | 1.0000 – 1.0000 |
| corpus.analyzedRecall | 0.9444 | 3 | 0.8333 – 1.0000 |
| experiment.valueAccuracy | 0.0000 | 28 | 0.0000 – 0.0000 |
| experiment.unitAccuracy | 0.0357 | 28 | 0.0000 – 0.1071 |
| experiment.aggregationAccuracy | 0.0357 | 28 | 0.0000 – 0.1071 |
| experiment.filtersAccuracy | 0.0000 | 28 | 0.0000 – 0.0000 |
| experiment.groupByAccuracy | 0.0357 | 28 | 0.0000 – 0.1071 |
| experiment.sourceRowsAccuracy | 0.0000 | 28 | 0.0000 – 0.0000 |
| experiment.fieldAccuracy | 0.0357 | 28 | 0.0000 – 0.1071 |
| experiment.exactAccuracy | 0.0000 | 28 | 0.0000 – 0.0000 |
| sync.versionAccuracy | 1.0000 | 3 | 1.0000 – 1.0000 |
| sync.freshnessAccuracy | 1.0000 | 3 | 1.0000 – 1.0000 |

Hard gates: fail; 53 failures, 819 unknown checks. Release eligibility: false. Unknowns and protocol checks do not establish live release clearance.

Latency cold p50/p95: 2029.9592914999994/2518.6688669499968 ms; warm: 54.87183299999742/264.9700374499908 ms. These are measured local boundary timings, not full streamed-answer latency.

Independent judgments: pending-independent-evaluation. Pairwise: no candidate, n=0.

Existing tests/benchmarks:

- fc-regressions: exit 1; tests 324, pass 319, fail 5, skipped 0.
- desktop-regressions: exit 1; tests 30, pass 29, fail 1, skipped 0.
- qmd-regressions: exit 0; tests 7, pass 7, fail 0, skipped 0.
- semantic-benchmark: exit 0; tests n/a, pass n/a, fail n/a, skipped n/a.
- preflight-benchmark: exit 0; tests n/a, pass n/a, fail n/a, skipped n/a.
- retrieval-replay: exit 0; tests n/a, pass n/a, fail n/a, skipped n/a.

The immutable baseline precedes diagnosis; post-baseline reviewer results are separate artifacts. Do not rewrite this baseline after adding diagnostics.
