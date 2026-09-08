# BioDesign agent evaluation

This infrastructure evaluates the existing application. It does not change production routing, retrieval, normalization, prompts, permissions, or provider transport.

## Commands

```sh
npm run eval:agent
npm run eval:agent -- --suite retrieval
npm run eval:agent -- --suite sync
npm run eval:agent -- --suite multilingual
npm run eval:agent -- --suite corpus
npm run eval:agent -- --suite experiments
npm run eval:agent -- --suite permissions
npm run eval:agent -- --suite robustness
npm run eval:agent -- --repeats 3
npm run eval:test
npm run eval:compare -- --baseline path/to/baseline.json --candidate path/to/candidate.json --out comparison.json
node evals/rescore.mjs --baseline path/to/baseline.json --output path/to/new-rescored.json
node evals/summarize-ui.mjs --directory path/to/complete-ui-lane --numeric-extractions path/to/numeric-extractions.json
```

The comprehensive command verifies the frozen dataset hashes, runs each selected case cold and warm, saves an immutable `baseline.json`, and runs the existing relevant regression suites and historical benchmarks. `--no-existing` skips those supplementary regressions; `--no-warm` disables repeat-cache observations. `--case ID1,ID2` is for explicitly labeled diagnostic reruns. Output directories must not already exist.

The runner uses Electron's bundled Node when the system Node is outside the project's supported major versions. It does not rebuild native modules or modify package dependencies. Native runtime failures are errors, not passing synthetic replacements.

## Boundaries and evidence classes

1. **Deterministic ground truth:** structured experiment values, units, grouping, filters, source rows; source identities/versions; sync invalidation; explicit permission checks. A missing expected primitive result fails. An unavailable observation remains unknown.
2. **Retrieval/source evidence:** real QMD and application retrieval; paper and evidence Recall@5/@10, Precision@5, MRR. Corpus jobs use snapshot/preparation/map/verification coverage, not top-K scores. Citation existence alone does not prove a claim.
3. **Independent judges:** fresh contexts receive only question, frozen allowed evidence, candidate output, and anchored rubric. Do not pass execution narratives, implementation files, hidden reasoning, or branch/model identity. Missing final answers are never replaced with fabricated prose. Structured corpus artifacts may receive separately labeled artifact judgments.
4. **Adversarial/stress:** frozen faults and regressions plus post-baseline failure reviews. New probes go in a later version or a separate diagnostic file, never into the already-run held-out dataset.

`ProjectContextService.buildContext()` is the primary local execution entry point, shared by Side Chat and Agent Command. Its actual preflight, PDF.js, structured store, QMD, literature tools, and corpus workflow run in isolated synthetic workspaces. The default substitutes explicit extractive Paper Card/map fixtures for cloud generation; it has **no live final-answer model**. Results from this mode measure application orchestration and local evidence behavior under controlled providers, not end-to-end scientific answer quality.

Original fixtures are synthetic and deliberately labeled as such. Generated PDF containers must preserve their source text through actual PDF.js extraction. Runtime source IDs are seeded from fixture identities; hashes, derived layers, records, and retrieval are produced by application code. Execution receives input/setup only; gold answers and scoring rules are withheld.

## Live provider evaluation

```sh
BIODESIGN_EVAL_FC_TOKEN=... npm run eval:agent -- --live
# Alternatively use an existing local FC-session bearer-token file:
npm run eval:agent -- --live --fc-token-file /path/to/existing-token-file
```

Use an existing authorized application session token, never a Requesty credential. Token values, headers, and token-file paths are excluded from result metadata. All application provider requests reuse `LiteratureApiClient` or `/chat` on the existing HTTPS Alibaba FC origin. Redirects and other origins are rejected. No direct provider endpoint or model-selection override is available.

An authenticated normal Side Chat UI run on an isolated materialized fixture is also valid live evidence. Preserve its exact persisted chat messages, input/setup, renderer build identity, source manifest, and observed timings in a separate lane. Do not mix UI timings or production-provider outcomes with local controlled runs. Never switch a user's real project into a destructive fixture scenario.

Run `summarize-ui.mjs` only after every predeclared case and repeat is saved. It validates the frozen one-turn conversations, timestamps and complete selection before reserving new artifact files; existing artifacts are never overwritten. Only the first chronological request is cold in a sequential shared workspace, even if a later filename describes a cold corpus sub-operation. UI reports use a distinct scorer version and execution mode so they cannot be compared with controlled-local results as a production improvement.

Optional numeric extractions use `{ "extractions": [{ "caseId": "...", "repeat": 0, "method": "literal transcription", "entries": [] }] }`. Each entry names a frozen requested result and records `answerSpan`, literal numeric `value`, and observed `unit`, `field`, `aggregation`, `filters`, `groupBy` and `sourceRows`. Filter fulfillment requires `filterSpans` mapping constraints to exact candidate text, or an exact match to frozen gold rows whose IDs occur in candidate answer/citation metadata; the latter is reported as `filterEvidence: "exact_cited_rowset"`. Extra or contradictory asserted filters still fail. This establishes the selected result's constraints, not hidden query execution. Omitted provenance is never copied from gold. An optional `declaredAbsenceSpan` must also be exact. The script compares these transcriptions deterministically against frozen gold, reports missing audits as unmeasured, and keeps semantic judgment and exhaustive claim coverage separate.

## Interpretation and comparison

Independent semantic judging is a separate stage: the default runner does not silently manufacture judge scores or launch evaluator models. Give each fresh evaluator only one packet and `judge-contract.json`, then import its strict JSON. In this baseline the evaluator agents ran in fresh Codex contexts; application calls still went through FC.

```sh
node evals/make-judge-packet.mjs --observation SAVED_UI_JSON --output NEW_PACKET_JSON
node evals/judge-results.mjs --packets PACKETS_JSON --scores SCORE_DIRECTORY --output NEW_JUDGE_REPORT
node evals/aggregate-grounding.mjs --packets PACKETS_JSON --scores NEW_JUDGE_REPORT --output NEW_GROUNDING_REPORT
node evals/analyze-runtime-log.mjs --observations UI_RESULT_DIR --output NEW_TELEMETRY_JSON LOG_PART1 LOG_PART2
node evals/assemble-report.mjs --local LOCAL_RESULT_DIR --live UI_RESULT_DIR --output NEW_COMBINED_DIR
```

`regression-candidates.json` links reproducible baseline failures to frozen cases. Later diagnostic probes and evaluator corrections remain separate from the original baseline and heldout dataset.

Reports preserve dimensions: correctness, retrieval, grounding, multilingual parity, sync, experiments, security, cost, latency, and robustness. Required security failures cannot be averaged away. An unknown hard check is not a pass. Synthetic or controlled results do not independently authorize a live release.

Every report records git commit/branch/dirty status, tracked content hashes, runtime, QMD, fixture/suite versions, and known FC configuration signatures. A dirty tree's commit alone is insufficient. Unknown FC revision or provider usage is `null`, not guessed. Zero actual provider calls in a controlled run does not mean production is free. Logical role counters, transport attempts, token usage, and dollar cost are distinct measurements.

Bootstrap intervals resample case clusters using a fixed seed; repeats are not independent new scientific tasks. Small curated held-out sets do not establish broad generalization. Report development, held-out, primary EctD, and novel-domain stress results separately.

For blinded pairwise evaluation add `--blind-out packets.json --mapping-out private-order.json` to the comparator. Keep the mapping hidden from judges. The comparator never invents a judge decision. A single baseline has no candidate win rate; self-comparison is infrastructure validation only.

Frozen `baseline.json` files must never be rewritten after diagnostics, rescoring, or judge review. Save additions separately and reference the baseline hash. Create a new result directory for reruns and a new suite version for changed gold. Do not tune production thresholds against held-out cases.

`rescore.mjs` applies the current deterministic scorer to the original report's embedded `testCases` and `observations`, using Node only. It preserves raw observations, frozen gold and execution config, records `parentSHA`, scorer version/module hash and unchanged raw-content hashes, and writes an exclusively new JSON report. An adjacent `.sha256` file is verified when present; `--expected-parent-sha SHA256` can pin the input explicitly. `--seed` and `--bootstrap-samples` control bootstrap reproducibility. It never launches Electron, calls providers, or reads the current suite gold. Rescore both frozen reports under the same scorer version before comparing them; rescoring is not a new application run.
