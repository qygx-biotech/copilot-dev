# Cloud-Assisted Retrieval Benchmark Report

Validation was rerun on 2026-09-02 (Asia/Shanghai) on Apple Silicon, macOS, Node `v26.3.0`, and QMD `2.8.3`. The existing controlled fixture was not changed: it contains 11 synthetic-biology paper mirrors and 10 queries covering `EctD`, `A163V`, `kcat`, `Km`, `BL21(DE3)`, DOI and author/year lookup, semantic production questions, and two Chinese→English questions. Expected paper IDs and evidence terms are checked separately.

## Retrieval-quality profile comparison

The benchmark imports the production profile selector and deterministic Medium escalation helpers. Fast includes the current local compatibility fallback when QMD returns no routed candidate; Deep replays the existing validated FC plan/rank fixtures.

| Profile | Paper recall@5 | Paper recall@10 | Evidence recall@5 | Deep queries | Cold FC / Requesty calls | Cached FC / Requesty calls | Estimated input / output tokens | Local orchestration first mean / steady p50 |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| Light | 1.00 | 1.00 | 0.90 | 2/10 (20%) | 6 / 4 | 2 / 0 | 1,176 / 208 | 0.369 / 0.143 ms |
| Medium | 1.00 | 1.00 | 0.90 | 5/10 (50%) | 15 / 10 | 5 / 0 | 3,561 / 602 | 1.131 / 0.488 ms |
| High | 1.00 | 1.00 | 1.00 | 10/10 (100%) | 30 / 20 | 10 / 0 | 6,580 / 1,078 | 0.963 / 0.945 ms |

Medium kept all five exact identifier/title/author-year fixtures local and escalated the two cross-language, semantic-insufficient, fermentation-strategy, and broad-discovery queries. Light made the fewest retrieval calls; Medium made half as many Deep/FC/Requesty calls as High; High produced the strongest measured evidence recall. Paper recall is saturated at 1.00 for all three because Light already sends the two Chinese fixtures to Deep and the local compatibility scorer finds every remaining expected paper. Consequently this unchanged small fixture cannot demonstrate a further Medium paper-recall gain over Light; it demonstrates deterministic escalation and call separation, while the High evidence-recall difference is measurable. This is a controlled replay, not production telemetry or a production average.

Cold Deep uses three FC requests (configuration, plan, rank) and two Requesty calls. A valid plan/rank cache retains one FC configuration-signature request and makes no Requesty planner/reranker call. Token counts are four-character estimates. Timings are local orchestration only and exclude unmeasured live Alibaba FC/Requesty network and provider latency.

## Current production-path replay

The command below ran with no embedding, query-expansion, or reranker model and no model download:

```bash
npm run benchmark -- --fixture --model lexical --repeats 3 --output /private/tmp/requesty-cloud-benchmark.json
```

| Backend | Paper recall@5 | Paper recall@10 | Evidence recall@5 | First-query mean | Steady p50 |
|---|---:|---:|---:|---:|---:|
| Legacy local scorer | 0.80 | 0.80 | 0.70 | 0.901 ms | 0.047 ms |
| QMD lexical | 0.20 | 0.20 | 0.20 | 0.921 ms | 0.086 ms |
| Cloud-planned lexical replay | 1.00 | 1.00 | 1.00 | 1.106 ms | 0.994 ms |
| Cloud-reranked replay | 1.00 | 1.00 | 1.00 | 1.040 ms | 0.981 ms |

For the two Chinese queries, both unexpanded lexical baselines scored `0.00/0.00/0.00`; validated English lexical expansions and the reranked replay scored `1.00/1.00/1.00`. DOI, mutation, kinetic, and strain identifiers retained correct paper and evidence recall. The representative cloud records are in `benchmark/representative-cloud-plans.json`; they contain structured plan/rank responses, not a modified query set or corpus.

These latency figures measure deterministic local plan replay, lexical search, fusion, and rerank reconstruction only. They do not include live Alibaba FC or Requesty network/provider latency. No production account credential was available, so live first/steady latency and provider-reported token usage remain unmeasured.

Across 10 cold Deep requests, the character-based estimate was 6,580 Requesty input tokens and 1,078 output tokens (30,601 serialized characters), with 30 FC requests and 20 Requesty calls. One cold request uses three FC calls—configuration signature, planning, reranking—and two Requesty calls. A plan/rank cache hit still checks the opaque FC configuration signature but uses no Requesty call. Actual billing depends on the FC-configured models and provider tokenization.

## Failure and privacy behavior

Automated tests exercise planner failure by retaining the original query, reranker failure by retaining deterministic local fusion with `fallback: "local-lexical-fusion"`, and malformed, duplicate, or hallucinated candidate IDs by rejecting the response. Candidate request construction imports the same candidate, snippet, aggregate-evidence, and request budgets as IPC/context construction. Paths, directory handles, bearer/JWT content, unrelated project data, and PDF data are rejected; final evidence is reconstructed from local candidate objects.

## Historical optional-semantic comparison

The earlier unchanged-fixture baseline remains useful for comparison but is no longer the production Deep path:

| Backend/model | Recall@5 / @10 / evidence@5 | Steady p50 | Observed process peak |
|---|---:|---:|---:|
| EmbeddingGemma hybrid | 1.00 / 1.00 / 1.00 | 12.00 ms | 1,063 MiB |
| Qwen3 embedding hybrid | 1.00 / 1.00 / 1.00 | 56.53 ms | 2,569 MiB |

Chinese hybrid recall was `1.00/1.00/1.00` for both. Cached 11-document embedding took 3.76 s for EmbeddingGemma and 3.62 s for Qwen3 in that run; cold model acquisition took 330.7 s and 618.0 s respectively. EmbeddingGemma remains the explicit optional-semantic default because it matched recall with lower measured latency and storage/memory cost. Neither model is required by Fast or cloud-backed Deep.

An attempted fresh optional-semantic reproduction with `--model default --cpu` failed on this host: QMD reported no CPU-only prebuilt backend, then Metal failed to allocate a command queue/context (`Failed to create any embedding context`). That platform limitation is recorded rather than replaced with a passing synthetic model result.

## Scale evidence

`alibaba-fc/test/qmd-knowledge-layers.test.js` retains its original 150-paper ordinary-query fixture, returns a bounded QMD candidate, and makes every legacy artifact read throw. The query succeeds with zero full-artifact reads. Existing 32-paper corpus mapping and 32→36 incremental-update fixtures also remain unchanged. Ordinary top-K limits are request/context bounds, not a total project paper-count ceiling; corpus-wide intent keeps the coverage-preserving workflow.

## Reproduce

Run the production-path replay without local model weights:

```bash
cd local-backend
npm ci
npm run benchmark -- --fixture --model lexical --repeats 3 --output /tmp/requesty-cloud-benchmark.json
```

Run optional local-semantic historical comparisons only on a host capable of initializing the native backend:

```bash
npm run benchmark -- --fixture --model both --output /tmp/qmd-optional-semantic.json
```

For a real initialized project, provide the existing query JSON schema (`id`, `language`, `query`, `expectedPaperIds`, and `expectedEvidenceTerms`) and do not change the query/corpus merely to improve results.

## Tradeoff

Cloud planning restored semantic and cross-language recall on the controlled lexical corpus without local weights, at the cost of Internet dependency, FC/Requesty latency, and provider usage. Fast stays fully local. Deep transmits only budgeted retrieval candidates, while native PDF remains the explicit whole-document exception. When the cloud path is unavailable, local evidence remains usable but conceptual and cross-language recall can fall to the lexical baseline.
