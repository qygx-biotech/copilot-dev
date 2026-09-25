# Side Chat context budget — provider-reactive policy

> Historical implementation notes. The current policy is documented in
> [Resilient model context](context-compaction.md): token-aware budgeting, learned
> limits, archived originals, and bounded summary recovery. Repeated token-rate
> quotas no longer trigger compaction or a third shortened attempt.

Implemented on the existing `nanobot/sidechat` branch, without resetting prior work.

## Cause and behavior

The active agent previously compacted on every iteration, sliced tool JSON to 500/700-character prefixes (including results older than the latest three), and applied a 220,000-character target before the provider saw the evidence. This broke JSON, discarded passages, and instructed the model to retrieve the same evidence again. A confirmed input-token rate quota also fed that compactor. Rebuilding from the transcript could restore oversized payloads; copying compacted continuation messages back could instead damage saved receipts.

Initial attempts now send all already-bounded active tool results intact. There is no active character threshold or result-age slicing. Existing bounded historical replay remains separate. No mandatory retrieval, classifier, image-preprocessing or subagent call is introduced.

An explicit provider context/input-size rejection permits **one structural retry for the current set of tool results**, including the final answer at the execution limit. The target is 55% of the attempted message characters, with a 4,000-character floor; it is an advisory reduction target, not a claimed model token capacity or a new proactive limit. Required instructions, requests, provenance and protocol can exceed it. A second context rejection without newly completed tool results returns `ProviderContextLimitExceeded` rather than triggering more retrieval or another compaction.

Structural reduction first uses the existing corpus receipt projection to remove duplicate scientific text, then deduplicates identical prose and shortens allowlisted text fields. It preserves valid JSON, the complete message sequence and tool pairs, source IDs/versions, exact citation references, currentness, hard scope, requirements, gaps, and measured coverage. The newest tool-call group gets three times the prose budget of older results. Shortened text and retained citation markers from omitted text are explicitly labeled; neither is an invented summary or proof of a scientific claim. Stored artifacts and full active transcript are unchanged. Existing academic accepted-plan/legacy-receipt recovery remains compatible.

Retryable 429 responses first follow the existing Requesty adapter: initial attempt → provider cooldown → one unchanged retry. Only if **both attempts explicitly report the same retryable input-token quota** (actual HTTP 429, exact valid metric and same positive numeric limit) may the agent use the shared compaction allowance, wait for the second cooldown and make **one compacted attempt**. This is at most three HTTP attempts for that model decision, not a three-call cap on an entire tool-using conversation. The final attempt passes `maxAttempts: 1`; network, 5xx, 429 and other adapter retries cannot multiply it. A successful unchanged retry never compacts.

Quota recovery requires at least a 10% and 1,024-character reduction in the model-facing messages. This is only a meaningful-reduction heuristic, not a token estimate or inferred model capacity. The reported quota limit is never used to size the context. Matching the reported metric/limit does not establish the quota's owner or time window. Unknown/malformed metrics, generic/request-count/output-token quotas, hard daily/billing quotas and mismatched repeated reports do not qualify. A failed third quota attempt returns `ProviderInputTokenQuotaExceeded` (verified input quota) or `ProviderInputTokenQuotaRecoveryFailed` (another provider failure), with the underlying transport/content/rejection category preserved.

Cooldowns use the maximum of the provider's available hints and must be at most 120 seconds and fit the remaining five-minute HTTP request budget. The HTTP adapter's absolute deadline is carried to both adapter invocations instead of resetting the clock for compaction. Cancellation aborts the wait. `ProviderRetryBudgetExceeded` reports local time-budget exhaustion without another provider call. Longer delays and hard daily/billing quotas are reported without sleeping/retrying. `max_tokens_exceeded` alone, generic “too many tokens,” output-token limits and unrelated validation failures do not qualify as context-window rejection. No model switching occurs.

## Continuations and limits

Signed desktop state carries compaction trigger/sizes/count, the completed-tool-result watermark and retry count plus `providerRecovery` (model-decision sequence, phase, actual attempt count, trigger, cooldown and stop reason) alongside the existing model binding, request, tool IDs, step/tool budgets and conversation. Newly completed desktop results update only their corresponding persisted receipts; earlier compacted model views never overwrite saved evidence. Fresh results after a handoff are sent intact. Newly completed tool results renew the shared context/quota allowance; handoffs, retries and final-answer reminders alone do not. The cumulative compaction count is diagnostic, not a turn-wide veto. Existing step/tool budgets bound the number of new evidence states. Old signed `contextCharacterLimit` values are ignored. A new user turn starts without a reduced budget.

Retained limits include existing per-read/result/catalog limits, persisted history (12 turns, 600,000 stored characters, 120,000 replay characters, 64,000 per message), eight agent steps, 24 tool calls, signed continuation payloads of 700,000 uncompressed bytes, 180,000-character project/academic desktop result batches (60,000 for other desktop tools), the HTTP adapter's 32 MiB body safeguard and five-minute request deadline. An oversized outgoing signed continuation is a `LOCAL_CONTEXT_TRANSPORT_LIMIT` response, explicitly distinguished from provider rejection. These transport limits can still stop a long exchange before another provider call; they are not silently worked around by destructive compaction.

## Safe observability

`agent_context_send`, `agent_context_compacted`, `agent_context_recovery_stopped`, `agent_provider_recovery`, `agent_context_local_limit`, `requesty_provider_request`, and `requesty_provider_failure` record sizes, applicable limits, fixed trigger/category, status, retry counts and affected/fresh result counts. No paper text, request payload, credentials or model reasoning is logged. `freshEvidencePreserved` means fresh results and provenance remain represented; `freshResultsShortened` separately reports changed fresh representations. Compaction events are also available through the existing streaming status path and buffered `semanticTelemetry.contextRecovery`. The desktop logs `backend.context-compacted` once per new event and `backend.context-recovery` with cumulative compaction/provider counts and the current sequence attempt count. Historical replay compaction counters remain separate. Provider request counts remain distinct from configuration requests and host retrieval.

## Files in this change

- `alibaba-fc/side-chat-agent.js`: initial sends, reactive retry, continuation/transcript separation.
- `alibaba-fc/agent-context-budget.js`: structural model-view compaction and legacy academic receipt recovery.
- `alibaba-fc/index.js`: precise provider classification, rate backoff, buffered cancellation propagation, local transport error, health marker.
- `alibaba-fc/agent-continuation.js`: outgoing local payload-limit error.
- `shared/provider-rate-limit.js`: recognize explicit daily/billing quota text.
- `docs/runtime-log.js`: safe context diagnostic fields.
- `alibaba-fc/test/agent-context-budget.test.js`: actual authenticated FC/signed-continuation/provider adapter fixtures and compaction tests.
- `alibaba-fc/test/corpus-continuation.test.js`, `side-chat-agent.test.js`, `conversation-transcript.test.js`: regressions updated to the new context-versus-TPM policy.
- This document. Build scripts synchronize shared contracts and renderer assets.

## Verification and deployment

Final checks: **983 backend tests passed**, **38 focused desktop tests passed**, including **53 native Electron behavioral checks**. Backend/root syntax checks, the new module syntax check, desktop preparation/renderer build and `git diff --check` passed.

Fixture verification exercises large intact contexts, older/newest JSON receipts, provenance and coverage retention, one context retry, unchanged TPM retry/backoff, repeated-quota compaction, no nested retry multiplication, actual corpus coverage through quota recovery, mismatched and ineligible quotas, exhausted deadlines, cancellation, repeated rejection, handoffs after compaction, saved transcript preservation, new-turn reset, and the final-answer execution-limit path. Existing regressions cover hard selection, historical replay without tool execution, direct answers without retrieval, source/recommendation protections and corpus accounting.

The public configured development FC `/health` was read on September 22, 2026. The latest check reported **`contextBudget: provider-reactive-quota-v2`**, **`quotaClassification: explicit-signals-v1`**, and streaming disabled. The quota classifier is deployed, but the post-tool recovery fix still requires deployment of **`provider-reactive-tool-progress-v3`**. Run the existing shared-contract sync during packaging. Desktop preparation/build completes locally; reload a development app or rebuild/reinstall a packaged app for buffered recovery diagnostics. No app restart or deployment was performed here.

No live authenticated Requesty/SurfDock follow-up was executed. Fixture acceptance does not establish live provider acceptance or improved answer quality. Remaining limits include provider-specific error wording, large protected metadata that cannot safely fit after one retry, and retained transport/history safeguards.

## Files changed for the repeated-quota extension

- `alibaba-fc/index.js`: bounded adapter attempt override, exact repeated-quota signal, cooldown/deadline checks, safe categories and health marker.
- `alibaba-fc/side-chat-agent.js`: shared allowance, meaningful-reduction check, one-attempt recovery dispatch, signed recovery-state persistence and specific stop errors.
- `alibaba-fc/agent-context-budget.js`: accurate trigger labels for quota-shortened evidence; existing structural policy reused.
- `alibaba-fc/src/index.js`: expose the existing absolute request deadline to recovery.
- `shared/provider-rate-limit.js`: conservative metric validation and repeated-quota comparison, with explicit output/request/billing exclusions.
- `docs/runtime-log.js`: additional safe recovery fields.
- `alibaba-fc/test/agent-context-budget.test.js` and `alibaba-fc/test/corpus-continuation.test.js`: provider-adapter, authenticated signed-handoff and actual host corpus fixtures.
- This document; generated shared-contract/renderer assets are synchronized by the existing build scripts.

## Billing-advice classification correction (September 22 log)

The reported failure stopped after one provider attempt with a positive input-token metric/limit (16,000), a 5,326 ms retry hint and `non_retryable_quota`. The previous parser searched the entire error message for `billing`/`daily`; generic provider advice to “check your plan and billing details” therefore disabled input-quota recovery. The raw upstream response was not supplied, so the precise original matching phrase cannot be confirmed from the desktop log alone. A Google-style fixture with that advice reproduces the logged flags under the old predicate.

The shared parser now uses explicit hard-quota codes, named failed metrics/structured quota violations, actual zero limits and explicit exhaustion statements. Generic billing advice and documentation links do not establish exhaustion. Real billing/daily limits and an explicit provider non-retryable flag still block recovery. `quotaClassificationReason` records a fixed, safe reason without the upstream text. The bounded intact → unchanged cooldown retry → structurally compacted cooldown retry policy remains unchanged; no proactive threshold or automatic retrieval is introduced.

Three authenticated follow-up fixtures replay saved original evidence and the original Chinese review request, then exercise zero, one and two Google-style quota rejections. They verify unchanged initial evidence, unchanged retry, structural reduction only after repeated quota rejection, intact citation/scope/version metadata, unchanged saved transcript and no replayed tool execution. Additional parser tests retain hard billing/daily and explicit non-retryable denials.

This correction changes `shared/provider-rate-limit.js`, safe diagnostics/health in `alibaba-fc/index.js`, the allowlist in `docs/runtime-log.js`, `alibaba-fc/test/provider-rate-limit.test.js`, `alibaba-fc/test/agent-context-budget.test.js`, and this document. Existing build scripts synchronize the shared runtime copies. The corrected backend adds `quotaClassification: explicit-signals-v1`; deploy it and reload the desktop assets. Tests are fixtures, not live Requesty acceptance.


## Recovery after new tool results (September 22, 21:15–21:18 run)

The supplied log reached a successful corpus tool selection after three provider attempts, collected all four papers locally, then failed after two more attempts with `compaction_allowance_exhausted`. The old cumulative turn-wide gate had already been consumed before the handoff. It prevented recovery on newly collected corpus evidence. Historical `compactedTurns: 0` / `compactedToolResults: 0` do not measure active provider-triggered compaction.

The allowance now uses a host-owned completed-tool-result watermark carried inside signed `contextCompaction` state. Only newly completed tool IDs renew it; no new evidence means no new compaction allowance, including the final-answer phase. Legacy signed state lacking the watermark conservatively counts prior results excluding newly resolved pending calls. A new user turn starts fresh. Context-window and repeated verified input-token quota recovery still share one allowance for each evidence state, and the adapter still caps each quota sequence at initial → unchanged cooldown retry → compacted cooldown retry. Compacted retries cannot start nested retries. No proactive truncation, model switch, token-to-character conversion or automatic retrieval was added.

The real renderer/FC/signed-handoff/local-corpus fixture now exercises three attempts before tool selection and three after collection, for both final success and final rejection. It asserts intact initial results, unchanged cooldown attempts, two distinct reductions, preserved saved receipts and measured source coverage, no repeated tool execution or extra Paper Card generation, safe buffered diagnostics, and a specific stop after a rejected sixth attempt. Mixed context/quota fixtures exercise renewal after new evidence and rejection without new evidence.

This incremental fix changes `alibaba-fc/side-chat-agent.js`, the version marker in `alibaba-fc/index.js`, `docs/app.js`, `docs/runtime-log.js`, the two context/corpus regression files, and this document. The deployed public health endpoint still reports `provider-reactive-quota-v2` with `explicit-signals-v1` and streaming disabled; it does not yet contain this fix. Deploy the backend with `contextBudget: provider-reactive-tool-progress-v3` and reload/rebuild the desktop assets for buffered diagnostics. No deployment, app reload or live authenticated Requesty verification was performed in this pass.
