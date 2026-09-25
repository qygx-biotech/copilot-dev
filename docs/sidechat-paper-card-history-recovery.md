# Excerpt preparation and follow-up history

## Observed incident

The saved SurfDock `prepare:paper_card` job failed on September 22 at 01:15:43.170 UTC with `InvalidLlmResponse`: “The model did not return a valid structured chunk summary.” The source registry records L1 ready and L2 failed at 01:15:43.202. The next conversation turn started at 01:15:44.088. The screenshots show another excerpt request at 01:20:10. The old error did not retain the particular schema field, so the invalid response cannot be attributed to LaTeX or a particular field from this data.

The subsequently supplied excerpt 7 response identifies the validation cause: it is schema-valid JSON with `year: 2025`, null scalar findings and empty lists, because the excerpt contains references only. The extra `hasEvidence` check incorrectly rejected this legitimate result. Excerpt validation now accepts a complete schema-valid object even when it contributes no scientific findings. The final Paper Card still requires substantive evidence. A regression runs this exact result through excerpt 7 of 12 and reaches final synthesis with 12 excerpt calls and one synthesis call, without a retry.

`runWithConcurrency` used fail-fast `Promise.all`. One excerpt rejected the whole card task immediately, while the other worker continued taking excerpts. This skipped final synthesis, returned partial preflight to the main agent, and left provider work running afterward. The outer preflight awaited the card promise, but that promise did not represent completion of all started work.

The prior Chinese question and completed review were still in the saved transcript. Its corpus tool result alone occupied 48,941 characters. Under the smaller provider-recovery history budget, replay summarized the entire exchange. The extractive summary favored the beginning of tool output, omitting the final review. This was replay compaction, not loss of the saved conversation.

## Changes

- Excerpt workers stop taking new work after a terminal failure and settle all started work before returning. Cancellation follows the same barrier. Main answering can still proceed from valid original evidence after preparation has actually finished with a partial result.
- Only an excerpt rejected as `InvalidLlmResponse` receives one corrective retry. It uses the same model, evidence and structured-output format, with explicit schema reminders. Validation remains strict. Other successful excerpts in that run are retained. If the retry fails, no incomplete card is synthesized or published.
- After all excerpts validate, final card synthesis runs normally. Large sets first undergo bounded grouped synthesis to respect FC's summary-size limit even when no provider input quota has been observed. No raw evidence is silently dropped to meet that limit. Nonshrinking or individually oversized summaries still fail explicitly within existing reduction bounds.
- Excerpt failures now include safe stage, excerpt index, validation field and reason diagnostics. No source text or arbitrary returned JSON is logged.
- Replay first compacts large tool results while retaining user messages, the final assistant answer, tool IDs and pairing. Corpus compaction reuses `corpus-context.js`; if even that cannot fit, a paired historical omission receipt replaces the tool payload. Omitted evidence cannot support precise current claims.
- Only when the exchange still cannot fit is a historical summary used. Summaries prioritize the original request and final answer over tool-output prefixes. Source/version/scope invalidation still precedes replay, and historical tools are never executed.

No source files, saved scientific data, selected model, card compatibility signatures, corpus coverage rules, wiki policy or recommendation permissions changed. The original three compatible cards remain reusable. The failed old run did not save its excerpt summaries, so those outputs cannot be recovered from the existing job record.

## Verification

Provider fixtures exercise the real authenticated excerpt/synthesis endpoints and preflight, including 12 excerpts, one recoverable invalid response, terminal failure while another worker is blocked, cancellation, final synthesis, grouped synthesis without a learned quota, and cached card reuse. History tests cover the added-paper follow-up under a reduced provider budget, unchanged-source validity, source-change invalidation, tool pairing and preservation of the saved transcript.

A read-only replay of the actual saved conversation preserved the exact original Chinese question and complete prior model answer at history budgets of 16,000, 28,000 and 40,000 characters. At the smallest budget the detailed tool payload was explicitly omitted; the prior answer remained untrusted historical context. This is local replay verification, not a live Requesty generation.

The development health endpoint already contains the previous `corpusContinuation: bounded-synthesis-v1` fix, but lacks this change's `conversationReplay: preserve-exchanges-v2` and `paperCardPreparation: drained-excerpts-v1` markers. Deploy the current FC runtime, including the new `corpus-context.js`, and synchronized shared contracts. Reload/restart the rebuilt Electron renderer as well: the worker barrier and excerpt retry live in the client. No live provider synthesis or deployment was performed during this fix.

## Recoverable Paper Card omissions (September 22)

New provider output now passes through one shared omission normalizer before the existing schema and source-identity checks. Provider schemas, explicit JSON instructions, selected models, capability resolution, saved formats and cache signatures are unchanged. This is not a saved-data migration and does not invalidate successful cached cards.

Only absent, explicitly allowlisted **top-level** descriptive fields are filled, and only when the applicable schema permits that default:

| Output | Missing nullable fields → `null` | Missing descriptive lists → `[]` |
| --- | --- | --- |
| Excerpt | `summary`, `year`, `abstractSummary`, `researchQuestion`, `methods`, `mainConclusion` | `authors`, `mainFindings`, `keyResults`, `organisms`, `genes`, `proteins`, `pathways`, `metabolites`, `experimentalConditions`, `measurements`, `importantResults`, `limitations`, `keywords`, `topics` |
| Excerpt synthesis | `summary`, `title`, `year`, `abstractSummary`, `researchQuestion`, `methodsSummary`, `shortSummary`, `mainConclusion` | Excerpt lists plus `methods` |
| Native PDF / combined text | `title`, `year`, `abstract_summary`, `research_question`, `methods_summary`, `main_conclusion` | `authors`, `major_findings`, `methods`, `organisms`, `genes`, `proteins`, `pathways`, `metabolites`, `experimental_conditions`, `measurements`, `important_results`, `limitations`, `keywords`, `topics` |

Empty lists mean no information extracted, not confirmed scientific absence. Existing fields, including incorrectly typed fields and unexpected properties, are preserved for validation. The normalizer never descends into findings/citations or fills source IDs, hashes, versions, pages or quotes. Native/combined `short_summary` remains required because its schema does not allow null.

Reference-only excerpts may contain no findings. Final cards require nonblank summary/conclusion text or scientific findings/results; title, author, year, research question or method names alone do not qualify. Schema and native citation length/count constraints are checked before source identity and final completeness. Citation grounding against local original evidence remains the host's responsibility and is unchanged.

Safe `paper_card_output_validation` events and endpoint diagnostics contain only normalized field names, a schema-known field and the reason (`invalid_json`, `schema_mismatch`, or `insufficient_substantive_content`). Application output validation remains identified by the existing `provider_content_validation` stage, distinct from `provider_rejection` and `provider_transport`. Client debug logs retain the safe diagnostics. Recoverable omissions cost no additional provider requests.

Regression verification: **922 backend tests** and **38 focused desktop tests** passed (including 53 Electron renderer behavioral checks). Backend/root syntax checks, desktop renderer preparation/build and `git diff --check` passed. New fixtures cover missing-title synthesis, native/combined omission handling, wrong types, missing identity/hash/citations, schema bounds, reference-only excerpts, metadata-only final cards, unchanged LaTeX/Chinese, safe diagnostics, cache reuse and retention of the previous card on validation/atomic-publication failure. The missing-title fixture follows the reported reproduction; this turn did not include the full final-synthesis payload.

These are fixture/local integration results, **not live Requesty verification**. Deploy the changed FC runtime (`index.js` and `paper-card-output.js` with the existing package/shared files) to activate normalization. Reload/restart the rebuilt Electron app for expanded diagnostic reporting. No backend deployment or running-app reload was performed in this pass. All edits remained on `nanobot/sidechat`.
