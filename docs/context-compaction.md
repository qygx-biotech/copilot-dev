# Resilient model context

The production path is `alibaba-fc/side-chat-agent.js` → `context-recovery.js` →
the Requesty chat-completions adapter in `index.js`. The two reference repositories
are not runtime dependencies. This policy supersedes the context/quota compaction
policy recorded in `sidechat-context-budget.md`.

## Normal requests and budgets

No fixed character ceiling is imposed on active model context. Conversation replay
uses the available retained transcript rather than the former 120,000-character
replay ceiling. Existing HTTP and persisted-history transport/storage bounds still
apply. Normal requests keep tool results intact. Large results are offloaded only
after a confirmed provider input/context or input-token-quota rejection. Every
normal decision first sends its complete available model view, even when a local
estimate or cached measurement suggests it may be too large. Transport/storage
constraints remain separate and can still reject their own oversized payloads.

The estimator measures the same request-body builder used for dispatch, including
system messages, tools, message framing, opaque tool protocol fields, and attached
images. It excludes binary image payload bytes and reserves a configurable token
allowance per image. This is a local heuristic, not a provider-exact tokenizer.
Reported input usage calibrates it upward; confirmed overflow can supply more
accurate counts and limits. Output tokens and a safety margin are reserved.

An unknown model window stays unknown and uses reactive recovery, rather than an
invented small window. Configure the selected model's documented window for
sizing recovery summaries and retries after rejection. Catalog window metadata is used when
the existing capability lookup supplies it. The backend does not guess a model's
window from its name or use a rate quota as a context limit.

Limits learned from confirmed overflow are scoped by endpoint/tool mode, provider,
model, account-key digest, configured window, output reserve, and image allowance.
Input-only limits reserve the safety margin; combined limits additionally reserve
output. Without numeric feedback, the attempted input budget drops by 20%.
Learned limits are saved atomically for 24 hours and carried in signed handoffs.
Credentials and account digests are not logged. Separate FC instances share learned
limits only when the configured archive directory is on shared storage.

## Input-token quotas

Confirmed input-token rate/allocation quotas use `input_quota` recovery, separately
from `context` capacity recovery. The agent adapter returns the first confirmed
quota rejection to the recovery manager instead of retrying unchanged. Structured
codes, metrics, details and input-quota headers take precedence over narrowly
matched messages. HTTP 429 alone, request/output quotas, billing exhaustion,
authentication errors and network failures do not activate this policy.

Quota records retain capacity, remaining allowance, reported reset/delay, metric
and scope independently of context limits. Aggregate quota usage is never treated
as this request's token count; capacity is a ceiling, not proof that allowance is
available. Output reserve is subtracted from a recovery sizing target only for
explicitly combined input/output quotas. A
reported delay does not establish the quota period. Unknown numeric feedback
reduces the attempted request target by 20%; that target is not a provider limit.

Eligible corpus results first receive the once-only complete-card projection described below, respecting provider-confirmed cooldowns. If that request is also rejected, bounded progressive Paper Card summarization runs before the archive/checkpoint/chunk pipeline below, retaining the generic retry allowance. Matching history
checkpoints can be reused. Both summary and normal dispatches honor the latest
provider-confirmed cooldown and the independent timing bounds below. Summaries are
sized using the confirmed rejection and context limits, with minimal prompts and
independent output reserves. Recovery targets are estimates, not remaining balances. If
summary calls cannot run, recovery uses an explicit incomplete extractive
checkpoint. No unchanged rejected payload is sent as a compaction retry.
If essential input cannot shrink enough, or the quota cannot become available in
time, `InputQuotaRecoveryIncomplete` explains whether to wait, reduce input or
change quota/model configuration. Compaction cannot replenish shared allowance.

Records are scoped by provider, Requesty endpoint, API-key digest and reported
quota dimensions/metric. Explicit account/project quotas may span models; unknown
scope is conservatively isolated by model. Signed handoffs carry provider
measurements and confirmed cooldowns between requests. There is no local quota
ledger that charges requests or summaries against capacity. Unknown remaining
allowance stays unknown; even a cached reported remaining value cannot prevent
a new full request. Concurrent requests share only confirmed cooldowns within
the backend process. Older synthetic `spent`/`reserved` fields are ignored and
removed from subsequent snapshots.

The observation TTL bounds metadata retention, extended through confirmed
retry/reset deadlines. It does not represent a quota period or imply a refill.
An unreported cooldown is not invented. A provider-confirmed future cooldown
is respected before both normal and summary calls; if it cannot fit the quota-wait
budget or HTTP deadline, the response explicitly asks the user to wait. Cached context
limits also serve only as recovery sizing hints, never as normal-request gates.

## Independent timing bounds and migration

`CONTEXT_RECOVERY_MS` is **retired and ignored**. Remove it from deployment
configuration. It is not an alias for the new setting, and its old value is not
silently reused. There is no aggregate active-recovery timeout.

- **Ordinary provider-call timeout:** `CONTEXT_PROVIDER_CALL_TIMEOUT_MS`, default
  90000 ms, still applies to ordinary requests, including the initial intact request.
- **Recovery provider-call timeout:** each reduced main retry, corpus summary,
  validation repair, semantic batch/merge and generic summary gets a fresh
  **180000 ms** timer, started after quota waiting and preparation immediately
  before the adapter invocation. It covers headers, body reading and streaming
  completion. The actual allowance is the smaller of 180000 ms and the remaining
  outer hard deadline. There is no cumulative corpus/recovery elapsed cutoff. Generic retries/backoff
  inside one adapter invocation consume that invocation's timeout; they do not
  receive a fresh allowance from this manager.
- **Confirmed quota waiting:** `CONTEXT_QUOTA_WAIT_MS`, default 180000 ms, counts
  cumulative time actually spent waiting on provider-confirmed input-token quota
  cooldowns. It accommodates three ordinary 60-second cooldowns when the hard
  deadline permits. It does not invent a cooldown or a quota period.
- **Hard request deadline:** the existing backend limit (at most 300 seconds in
  this path, or the earlier supplied transport deadline) includes all time and
  is never extended. Productive summaries, merging, quota waits and new agent
  decisions inside the same backend request cannot renew it.

The existing shared recovery-attempt and summary-call limits, together with
measurable reduction between retries, still bound recovery across both modes.
Successful progress never resets those counters within a model decision. When
summary calls are exhausted, a deterministic checkpoint can still support a
reduced normal request; this does not authorize more summary calls.

Elapsed durations use an injectable monotonic clock; call timers are injectable
for testing. `activeRecoveryMs` still measures compaction, summary/provider latency,
generic network backoff and processing after recovery begins, but is diagnostic
only. Only actual confirmed quota waiting is excluded. Interrupted/shortened waits
are not charged their requested duration. Scheduler overshoot beyond a requested
cooldown slice counts as active time. Cancellation interrupts waits and calls and
prevents further dispatch, even if a provider fails to settle its promise.

Provider wall-clock resets are converted to remaining durations on receipt;
process-local cooldowns then use monotonic deadlines. Signed handoffs carry
wall-clock deadlines, converted again on receipt by the next process. Cross-host
clock skew can still affect imported deadlines. A local wall-clock rollback cannot
extend an already established hard request lifetime. Before normal or summary
calls, the entire remaining confirmed delay must fit both the quota-wait allowance
and hard deadline; cancellation and bounds are rechecked after waiting.

For example, two 45-second summaries followed by a 1-second answer use 91 seconds
of active recovery and can succeed under a 180-second remaining hard deadline.
Each recovery call individually fits its 180-second timeout. With only 88 seconds
remaining initially, the second summary receives at most 43 seconds and recovery
stops at the hard deadline. Three 60-second cooldowns consume 180 seconds of quota
waiting, not active time; they still consume hard-request time.

Incomplete results identify the actual stopping cause: `provider_call_timeout`,
`hard_request_deadline_exhausted`, `quota_wait_budget_exhausted`,
`recovery_attempts_exhausted`, `summary_call_limit_exhausted`, or the specific
inability to reduce safely. They include the remaining confirmed retry delay and
actual degraded/checkpoint state. Transcripts, pending exchanges, archives and
checkpoints remain available; completed tools are not rerun. No automatic retry
or background continuation is scheduled: manual continuation is required.

## Recovery and session integrity

The manager tracks accepted non-system history H separately from pending input Δ.
Only a successful provider request advances the accepted boundary. The current
user request remains in the host's mandatory instructions and pending input is
kept outside a history summary. Completed tools are dispatched outside the retry
loop and are never re-executed because a subsequent model request failed.

Recovery begins only after a confirmed rejection, and progresses one effective
stage at a time:

1. Archive the original model view and oversized tool results. Replace large
   results with explicit incomplete previews and `read_context_archive` references.
   Retry the complete request with those previews before summarizing history.
2. If previews cannot reduce the request, or the provider rejects them, reuse a
   matching history checkpoint that measurably reduces the request, if available.
   Retry with that checkpoint before asking for a new summary.
3. Summarize accepted history using archived originals when available. Use a
   small data-only prompt, no agent tools/current images, and an independent
   output allowance. Preserve pending instructions and tool exchanges.
4. Split source history into bounded sections when necessary. Measure each
   summary call independently; rejected chunks shrink/split before another
   attempt. Merge or recursively summarize the results as needed.
5. If summarization fails or cannot run within the deadline, use a labeled,
   incomplete extractive checkpoint grounded in stored history with archive
   references, and try the reduced normal request if time remains.

After each effective reduction, rebuild the complete request, invalidate
incompatible continuation state and retry the provider. Stop escalating as soon
as it succeeds. A local recovery target cannot block that retry or force every
stage to run first. Each retry must remove at least the smaller of 64 estimated
tokens or 1% of input; its uncalibrated size must decrease across retries. Skip
stages that cannot meaningfully reduce the rejected request. Irreducible input,
exhausted recovery bounds, unavailable storage and provider cooldowns are reported
explicitly, rather than described as a locally confirmed quota exhaustion.

Checkpoint `boundary` is the cumulative accepted-message boundary in the logical
non-system model transcript (including replay metadata). `archiveBoundary` is the
corresponding non-system index in the referenced immutable archive snapshot.
`boundaryKind` makes that coordinate system explicit. These are not UI message
indices. Checkpoints and original session messages are stored separately.

The adapter currently uses stateless chat completions, not response-ID continuation.
Rebuilding a checkpoint drops replaced history's opaque state; pending tool calls
retain required signatures. The request manager clears continuation-state fields
on rewritten requests. Signed desktop handoffs retain the accepted boundary,
checkpoints, archive references, and learned budget.

The bounded UI transcript serializer is unchanged in capacity. Before it would
shorten a current-turn transcript, the backend saves an exact archive and attaches
a `transcriptArchive` reference. Later turns can read retained archives only after
the existing workspace/source-version checks accept the historical exchange.
Archive reads are scoped to the authenticated account, project, and registered session
references. Changed/out-of-scope historical evidence is not made readable through
this path.

Unrelated rate limits, authentication failures, output truncation and transport
failures retain their existing behavior. Confirmed input-token quotas enter the
separate quota recovery mode described above. Mode switches do not renew reduction,
summary-call or quota-wait allowances for the current model decision, or the hard deadline.
Output truncation is still handled by the existing response behavior, not mistaken
for input overflow. This change does not add answer continuation for output limits.

## Configuration

Set these on the FC backend. Values are bounded in `configFromEnv`.

| Variable | Default | Purpose |
| --- | --- | --- |
| `CONTEXT_MODEL_WINDOWS` | `{}` | JSON mapping exact model IDs to context windows; highest precedence |
| `CONTEXT_WINDOW_TOKENS` | unknown | Deployment-wide context window override |
| `CONTEXT_OUTPUT_TOKENS` | `8192` | Normal-request output reserve, also sent as `max_tokens` |
| `CONTEXT_SAFETY_TOKENS` | `1024` | Tokenizer/protocol uncertainty margin |
| `CONTEXT_SUMMARY_TOKENS` | `2048` | Maximum output allowance per summary; reduced when necessary |
| `CONTEXT_IMAGE_TOKENS` | `4096` | Estimated input tokens per image; tune for the provider/resolution |
| `CONTEXT_RECOVERY_ATTEMPTS` | `4` | Shared reductions/rejected-summary recoveries across both modes for one model decision |
| `CONTEXT_SUMMARY_CALLS` | `16` | Total summary calls across chunking/merging for that decision |
| `CONTEXT_PROVIDER_CALL_TIMEOUT_MS` | `90000` | Ordinary call timeout only; 100–300000 ms, capped by remaining hard-request time; recovery calls independently use 180000 ms |
| `CONTEXT_RECOVERY_MS` | retired | Ignored; remove this old aggregate-time setting. It is not a per-call alias |
| `CONTEXT_QUOTA_WAIT_MS` | `180000` | Cumulative confirmed quota waiting; 0–900000 ms, `0` disables waiting; always bounded by the hard HTTP deadline |
| `CONTEXT_QUOTA_TTL_MS` | `60000` | Provider-observation retention only; 100–300000 ms, extended through confirmed cooldown; never a quota period |
| `CONTEXT_ARCHIVE_DIR` | OS temp directory + `/biodesign-context` | Private archive and learned-limit filesystem root |
| `CONTEXT_DEBUG` | off | `1` enables structured `agent_context_recovery` console events |

Use a private persistent/shared filesystem for `CONTEXT_ARCHIVE_DIR` when FC
requests can change instances or archives must survive restart. Temporary storage
is only a best-effort fallback. Missing files produce `ARCHIVE_UNAVAILABLE`, never
invented content. Archive files contain original conversation/evidence data and use
private filesystem permissions. Operators should apply storage retention and quota
policies appropriate to their deployment; this implementation does not delete
conversation archives automatically. Existing 700,000-byte signed-continuation and
32 MiB HTTP bounds remain separate from model limits.

## Debugging

Before every outbound Requesty attempt (including retries and summary calls),
`requesty_provider_request` logs `estimatedTokens` instead of a character count.
This uses the compaction manager's local request estimator, including system
messages, tool definitions, protocol fields, and the configured image allowance.
It is an uncalibrated input estimate, not a provider-reported token count or the
reserved output allowance. The same value appears in streamed desktop debug
events. This existing request log is always emitted; `CONTEXT_DEBUG=1` enables
the additional recovery events below.

Events contain IDs and numeric measurements, never full prompts, evidence, image
bytes, credentials, or summary text. `eventKind` distinguishes `provider_rejection`,
`local_estimate`, `local_recovery_planning`, `provider_cooldown`,
`local_storage_failure`, and `recovery_budget_exhaustion`. `quotaRemaining` is the
last provider-reported observation, not an authoritative locally maintained balance.
`inputBudget`/`recoveryTarget` guide recovery sizing; neither proves exhaustion. Example (illustrative):

```json
{"requestId":"turn-42","provider":"google","model":"selected-model","stage":"learned-limit","estimatedTokens":190000,"reportedTokens":210000,"effectiveLimit":200000,"limitScope":"total","outputReserve":8192,"inputBudget":190784,"elapsedMs":20}
{"requestId":"turn-42","stage":"chunk","chunkCount":3,"summaryCalls":1,"elapsedMs":70}
{"requestId":"turn-42","stage":"checkpoint","checkpointBoundary":24,"continuationStateReset":true,"beforeTokens":210000,"afterTokens":42000,"summaryTokens":1800,"elapsedMs":3600}
{"requestId":"turn-42","stage":"outcome","outcome":"recovered","attempts":2,"elapsedMs":4700}
{"requestId":"turn-43","sessionId":"session-7","provider":"google","model":"selected-model","stage":"quota-recorded","eventKind":"provider_rejection","recoveryMode":"input_quota","classificationEvidence":"structured_input_metric","estimatedTokens":19709,"reportedTokens":null,"contextBudget":121856,"quotaCapacity":16000,"quotaRemaining":0,"quotaResetAt":null,"quotaPeriod":null,"quotaScope":"project","retryAfterMs":58000,"recoveryTarget":14976,"summaryCalls":0}
{"requestId":"turn-43","stage":"quota-wait","eventKind":"provider_cooldown","recoveryMode":"input_quota","retryAfterMs":58000,"activeRecoveryMs":80000,"quotaWaitMs":0,"providerCallTimeoutMs":180000,"quotaWaitRemainingMs":180000,"hardDeadlineRemainingMs":210000}
{"requestId":"turn-43","stage":"quota-wait-finished","eventKind":"provider_cooldown","recoveryMode":"input_quota","activeRecoveryMs":80000,"quotaWaitMs":58000,"providerCallTimeoutMs":180000,"quotaWaitRemainingMs":122000,"hardDeadlineRemainingMs":152000,"elapsedMs":138000}
{"requestId":"turn-44","stage":"outcome","outcome":"incomplete_result","reason":"quota_wait_budget_exhausted","retryAfterMs":58000,"activeRecoveryMs":3000,"quotaWaitMs":130000,"providerCallTimeoutMs":180000,"quotaWaitRemainingMs":50000,"hardDeadlineRemainingMs":150000}
```

Other outcomes are `unchanged`, `degraded`, and `incomplete_result`. Summary calls
also log their own budget and output allowance. Provider-attempt telemetry includes
summary calls; summaries never stream into the user's answer.
Cooldown progress is logged in bounded slices. Timing fields appear on every
recovery event; the final `reason` identifies the precise stopping bound.
`provider-call` events identify `callId`, `callStage`, estimated input, output
allowance, applicable `timeoutMs`, monotonic `durationMs` and outcome. Counters
`callsDispatched`, `callsCompleted`, `callsTimedOut`, and `callsCancelled` count
manager dispatches (including summaries), separately from adapter HTTP attempts.
Completed calls include provider error responses; a timeout/cancellation is not
also counted as completed. For example:

```json
{"stage":"provider-call","callId":"turn-42:3","callStage":"context-summary","callStatus":"completed","estimatedTokens":12000,"outputReserve":2048,"timeoutMs":180000,"durationMs":45000,"outcome":"summary_received","activeRecoveryMs":90000,"quotaWaitMs":0,"hardDeadlineRemainingMs":90000,"callsDispatched":3,"callsCompleted":3,"callsTimedOut":0,"callsCancelled":0}
```

A buffered HTTP response logs `response_received`; the UI then distinguishes
`tool_handoff`, `final_answer` and `incomplete_result`. A tool handoff is partial
progress, not task completion. Recovery failures propagate actual degraded state
and checkpoint boundaries instead of defaulting absent metadata to false.

## Verification and limitations

`test/input-quota-recovery.test.js` tests quota classification, cooldowns, summary
rejections, separate measurements, preserved full requests, expiry and shared recovery
bounds. `test/context-recovery.test.js` tests budgeting, calibration, chunk rejection,
recursive recovery, pending input, archive retrieval, isolation, deadlines, and
honest failure with mocked providers. `agent-context-budget.test.js` and
`corpus-continuation.test.js` exercise the authenticated FC/desktop handoff and
actual host collection path, including original receipts and no repeated tools.
`test/recovery-timing.test.js` uses fake monotonic and wall clocks to exercise
productive consecutive 45-second summaries, stalled calls, multiple cooldowns, summary/provider latency, cancellation,
shortened waits, distinct stopping bounds and clock changes. Production transport
cancellation is also covered in `agent-context-budget.test.js`.

Quota measurements can become stale when other clients consume the same quota.
Confirmed cooldowns are shared only within this backend process or through signed
handoffs, not automatically across other FC instances or external provider clients. The gateway does not always expose account/project
identity or remaining allowance; unknown scope is isolated rather than guessed.
Different API keys sharing an upstream account cannot be reliably coordinated
without a provider identity/shared quota service.

Summaries are lossy. Archive availability depends on storage. The estimator and
image allowance can underestimate a provider; reactive learning is the second
defense. Arbitrary user instructions and mandatory schemas are never silently
truncated or automatically replaced by a guessed relevant subset. If those alone
exceed the feasible budget, recovery stops with an incomplete result. Existing
historical records already shortened before this change cannot be reconstructed.
Provider outages and unavailable required content cannot be made successful by
compaction. No deployment or provider acceptance is implied by mocked tests.
Timeouts/cancellation abort local transport and prevent further dispatch. A remote
provider may still finish already submitted work; local cancellation cannot
guarantee that upstream computation or billing stops.

## Corpus card retry before generic context recovery

For new `run_corpus_workflow` receipts, the desktop card service optionally returns the complete validated card alongside its existing bounded map representation. The corpus handler sends those complete cards in a `corpusCardFallback` sidecar, separate from the unchanged canonical `result`. No generation, corpus rerun or reasoning worker is invoked to construct that sidecar. Missing/incompatible cards are recorded rather than counted as covered. Source versions and card content identities travel with each complete card.

The FC continuation admits the sidecar only for a pending corpus call. Canonical receipts keep their existing result-batch limit; the sidecar is subject to the existing HTTP request envelope. Before model dispatch, `corpus-card-fallback.js` archives it through the existing account/session context archive service and removes it from model messages. Ordinary requests therefore keep the mixed corpus projection and never carry the complete-card payload. Canonical transcript receipts retain the mixed result. Signed recovery state holds archive references and admission state, not another copy of every card.

A provider-confirmed input/context-size rejection or input-token quota rejection activates the fallback. It replaces just the relevant corpus tool result, preserving its call ID and all other messages. The new view includes complete compatible cards, source hashes, card identities, compact failures/missing-card records, and card coverage explicitly distinguished from exhaustive content coverage. It omits original passages, duplicate previews, topics and previous syntheses. Model guidance labels the cards as derived and directs exact claims/quotations to `retrieve_project_evidence`. Current host source bindings, card readiness and card cache identity are checked before each card projection; revoked or changed sources/cards are excluded.

Admission writes a deterministic durable marker before the retry. A later request, signed handoff or cold instance with the same archive session cannot return to the mixed result or take the same fallback again. Managed corpus results never become generic archive previews. Owned legacy previews are recognized by checking their archived original against the corpus call/content identity, then restored through the domain projection journal before dispatch. The extra request uses normal provider transport, usage accounting, cancellation and hard deadlines, but no agent iteration/tool slot or normal context-recovery attempt. A second confirmed size or input-quota rejection enters the progressive reduction stage below before normal generic recovery. Both rejection types share the same once-only admission marker. For input quotas, the existing ledger records the reported capacity and cooldown against the rejected mixed request before card projection; the card retry waits for any provider-confirmed cooldown and remains subject to the quota-wait allowance and hard deadline. Ordinary rate limits, request/output quotas, billing exhaustion, authentication, outages and output exhaustion do not activate card fallback. Archive I/O also observes cancellation and deadlines without being counted as a provider request.

Relevant implementation: `docs/source-system.js` (`readValidPaperCardForCorpusMap`, opt-in `completeCard`), `docs/project-context-service.js` (corpus sidecar), `alibaba-fc/agent-continuation.js` (handoff), `alibaba-fc/corpus-card-fallback.js` (archive/projection/admission), `alibaba-fc/context-recovery.js` (retry order) and `alibaba-fc/side-chat-agent.js` (current authority and accounting).

Limits: complete cards can themselves exceed a provider window; progressive reduction is attempted within the bounds below before generic recovery. Existing HTTP, canonical receipt, signed-continuation and persisted-history limits remain. Cross-host recovery needs the configured durable context-archive service; without it, unavailable archives fail explicitly. Legacy corpus receipts issued without this sidecar cannot reconstruct complete cards from truncated orientations and retain generic recovery. Compatibility/currentness is checked against host snapshots, not by continuously reading desktop files during a provider request. This change does not enable proactive compaction or fresh-window reset.

Offline validation: 401 focused tests passed, zero failed/skipped. Actual mocked Chat Completions and Responses request bodies verified the projection order and full content beyond the old card cutoff. The desktop/card-store handoff test verified missing/stale cards, one collection only, zero extra generation, canonical transcript preservation, a signed continuation and provider-request accounting. Recovery tests covered cold remote archives, pre-admission checkpoints, unavailable archives, revoked/changed bindings, second overflow, unrelated failures, cancellation and deadlines. Protected source-system, knowledge, acquisition, browser and child regressions were included; no external provider was contacted.

The input-quota extension was validated separately with 338 passing offline tests (zero failures/skips). The reported console sequence showed HTTP 429, a classified input-token capacity of 16,000 and `quota_no_safe_reduction` after generic compaction/summarization. The revised path tries complete cards first for that confirmed class of rejection. Mocked Chat Completions and native Responses request bodies verified this order; native Responses now forwards normalized quota metadata without exposing raw error prose. Tests also verified provider cooldowns, cancellation/deadlines, signed continuation reuse and one shared fallback admission across quota/size error combinations. This is not a claim that complete cards necessarily fit a live provider's remaining quota; a further rejection now enters the progressive reduction stage described below. The counts in this paragraph describe the earlier input-quota extension, not validation of progressive reduction.


## Progressive Paper Card reduction after card-only rejection

`shared/corpus-result-service.js` owns corpus-result projection policy. `docs/project-context-service.js` uses it to prepare the complete-card capsule from the existing card service; `alibaba-fc/corpus-card-reduction.js` injects the existing archive, provider and permission infrastructure. `ContextRecovery` classifies provider rejection and asks the result service for a smaller projection. No tool, domain store, card generation worker or corpus collection service is added. An accepted mixed or complete-card request does not invoke the summarizer. Only the existing confirmed input-size/input-quota classifiers admit this stage. Ordinary 429s, authentication, billing, outages, output exhaustion and local estimates do not admit it.

The internal `corpus-summary` request uses the selected model and existing provider adapter, including native reasoning configuration. It explicitly requests JSON-object output: `response_format: {type: "json_object"}` for Chat Completions, translated to `text.format: {type: "json_object"}` for native Responses. Validation repairs, semantic batches and merges retain this format; ordinary answer and generic plain-text checkpoint requests remain unchanged. It contains exactly a canonical summarizer instruction and one JSON data message: the relevant task, complete current card content with host identity bindings, deterministic handles/semantic parts, compact coverage/missing/failure metadata, and the target. Tools, conversation history, original attachments, provider continuation and private reasoning are absent. The main adapter suppresses its text stream from UI output. Only explicitly named top-level generation/debug/usage/protocol metadata is removed from cards; scientific fields are not sliced. The original store and receipt remain unchanged.

Internal output contract:

```json
{
  "papers": [{"handle":"P0001","part":"card","summary":"qualified findings","omissions":["material detail omitted"]}],
  "synthesis": [{"handles":["P0001"],"text":"attributed synthesis"}],
  "omissions": ["material corpus omissions"],
  "limitations": ["derived cards, not original evidence"]
}
```

Every supplied handle/part must occur exactly once; invented/duplicate/missing handles, unattributed synthesis, tool calls, malformed JSON and oversized output fail validation. Host code supplies the final source ID, source version and card identity. The main tool result keeps its call ID and `corpusCardProjection.key`, changes `basis` to `compressed-derived-paper-cards`, and includes `reduction`, `paperSummaries`, attributed `synthesis`, missing/failure records, non-exhaustive coverage, omissions, limitations and evidence guidance. Exact values/quotes/stronger claims can still use targeted `retrieve_project_evidence`. Structural checks cannot establish scientific faithfulness of model summaries.

The first target is half the original cleaned card-unit token estimate; each subsequent stage targets `floor(min(previous_target / 2, previous_actual_summary_size / 2))`. Actual summary size is measured from the normalized scientific JSON summary (one consolidated entry per paper, attributed synthesis, omissions and limitations), using the same estimator as target validation; host identity/protocol framing is excluded from this size but included in the final-request shrink check. Targets and actual sizes are stored with completed artifacts and restored across cold starts; older artifacts can be measured without generating them again. Both target and actual visible JSON use the existing documented estimator (ASCII/3.5, Unicode code points, JSON framing); these are estimates, not tokenizer counts. Acceptance also requires measurable shrinkage of the complete main request. Explicit provider capacity is preferred for fresh summary sizing: the heuristic learned from a small rejected main request is not itself the fresh context's capacity. Shared quota targets/cooldowns still apply. A local fixed-main-context estimate cannot veto summarization: the first summarizer request is actually attempted. After confirmed rejection, estimates may guide semantic batching. Explicit cancellation, request deadlines and recovery safety bounds still apply.

Bounds and accounting:

- At most three reduction stages and twelve internal provider requests per corpus-result set/task/configuration; rejected batches and repairs consume the twelve-request budget.
- One repair allowance per stage, shared by validation repair and final-request shrink correction; semantic batching/merge hierarchy depth at most eight. Whole cards are split deterministically into batches; a single card splits only at object fields, array items, paragraph/sentence boundaries. An unsplittable field fails honestly. Each part retains its handle and host identity. No paper is silently removed to fit.
- Minimum target is `max(256, 64 × paper count)` estimated tokens; each batch reserves at least 192 tokens per semantic unit for structured representation. Each stage prefers original cards. Attributed partial summaries are merged only when the combined representation still exceeds the stage target.
- Corpus reduction has no accumulated elapsed cutoff. Each provider call independently receives up to 180 seconds, bounded by the outer hard deadline and cancellation. Persisted `startedAt` and any legacy `bounds.elapsedMs` are historical metadata, not a new or restored deadline. Previously uncertain receipts remain non-replayable. Confirmed quota waits use the existing shared quota ledger and wait budget; a fresh context never implies fresh account quota.
- Visible target and provider output reserve are distinct. Internal reserve is `max(configured output reserve, min(32768, target + 2048))`; reasoning settings are preserved. This reserve is not a guarantee that reasoning plus visible output will fit.
- At most three compressed main retries, plus the existing once-only card retry. Internal calls and these retries use provider usage/timing accounting but no agent iteration/tool slot or generic retry allowance. Generic recovery begins after corpus reduction stops only if a validated meaningful corpus summary remains; its existing allowance is retained. It can archive eligible non-corpus tools or summarize accepted plain assistant history, preserving corpus results, all user instructions and tool exchanges byte-for-byte. Without a meaningful corpus summary, failure is explicit. A guard rejects any generic compactor that rewrites a managed corpus result. Provider unavailability/timeouts may instead return an honest incomplete outcome.

Persistence uses the existing account/project/session archive. Immutable journal records atomically claim a stage and each internal request **before** dispatch. A completed request receipt stores its artifact reference, supported usage counters and timing; pending records with no confirmed completion are uncertain, not instructions to replay. Stage manifests bind corpus keys, source/card identities, task, contract and provider profile. Signed continuation state contains references and stage metadata rather than duplicated card payloads. Immutable per-result pointers allow a later corpus result to join the context without expanding an earlier accepted compressed result, even from an older checkpoint. Completed artifacts can resume an unadmitted main retry; recorded main rejection advances the target. A pending admitted main retry without an outcome cannot be replayed. Recovery may reduce eligible non-corpus context only when a meaningful stored corpus summary exists; otherwise it returns an explicit incomplete result.

Local claims use exclusive creation plus file/directory sync. The existing OSS archive adapter uses conditional `x-oss-forbid-overwrite` writes. Missing objects are distinct from unavailable storage; adapters without atomic claims cannot perform this reduction and report the dependency honestly. Source scope/version/readiness/cache identity is rechecked after summary work and immediately before provider admission, including after quota waits. Invalid sources remove their summaries and dependent cross-paper synthesis; global model-authored omission/limitation prose is also withheld after invalidation. No managed corpus result is replaced by an omission marker or generic preview. Configuration changes invalidate cached summaries without resetting the corpus journal.

Content-free events retained in continuation state and buffered `semanticTelemetry.corpusRecovery`, as well as the streaming progress callback, identify card rejection, stage/batch start/completion, validation failure, estimated reduction, compressed main retry, quota waits, generic recovery and incomplete termination. Full cards, model summaries and private reasoning are not logged in these events.

Limits: source currentness is the host's current authoritative snapshot, not continuous filesystem monitoring. Cross-host recovery needs the configured durable archive and atomic-claim support. Usage absent from an interrupted provider response remains unknown; receipt intent is not fabricated token usage. Existing HTTP/continuation/storage limits remain. No live-provider quality evaluation or live OSS fault test is implied by mocked transport tests. Proactive compaction and fresh-window reset remain deferred.


Earlier offline validation, before the corpus ownership correction (2026-10-06): **528 tests passed, 0 failed, 0 skipped**, plus syntax checks of the changed JavaScript modules and `git diff --check`. The selected suites cover reduction/fallback, evidence access/budgets, context/quota/timing recovery, durable archives, authenticated corpus continuations, provider fidelity, source-system and L0–L4 behavior, preflight/saved knowledge, source permissions, shortlist recovery, acquisition receipts/registration, Playwright ownership/references, runtime sessions and child restrictions.

The actual native `callRequesty` path and the authenticated renderer → FC → desktop → Chat Completions path each observed: tool decision → mixed rejection → full-card rejection → isolated summary → compressed answer. Assertions checked real serialized request bodies, identical selected models, native reasoning settings, no internal tools/images/history, hidden summary streaming, source identities, canonical receipt equality, exactly one collection and no extra card generation. Cold-start tests covered older checkpoints, completed artifact reuse, recorded rejection advancing a target, pending/uncertain work not replaying, source invalidation, multiple corpus results, changed provider configuration, non-size failure classification, and absolute quota-reset restoration. Failure injection covered claim failure before dispatch, failure saving an artifact after the provider effect, and failure saving the completed request receipt. Local and mocked OSS atomic-claim tests were offline; no live service was contacted.

Observed offline validation after the corpus ownership correction (2026-10-06): **533 tests passed, 0 failed, 0 skipped** in the same selected regression suites. Mocked native Responses and authenticated Chat Completions request bodies verify mixed → complete-card → model-summary delivery, full-card tails, identity and call association, unchanged canonical receipts, and buffered telemetry. Additional tests cover generic recovery of unrelated tools and accepted assistant history while corpus summaries remain unchanged, an overestimated fixed floor, obsolete-preview migration, summary uncertainty/storage failures, complete source revocation, and cold-start reuse. These checks do not establish scientific fidelity or live-provider/OSS behavior.

Recovery timing correction: `alibaba-fc/src/index.js` starts an outer 300000 ms HTTP deadline at handler entry; `alibaba-fc/index.js` also caps the provider phase at 300000 ms or the earlier transport deadline. These remain unchanged. Thus two 170-second calls can succeed with a sufficiently long outer deadline in the recovery service, but cannot both finish inside the current five-minute HTTP invocation. A platform-enforced earlier cutoff or disconnected socket can also prevent delivery of final diagnostics. The separate quota-wait budget remains cumulative within one recovery run: 180000 ms by default (`CONTEXT_QUOTA_WAIT_MS`, configurable 0–900000 ms). It is not charged against an individual provider timer. Cold starts preserve absolute provider cooldowns and receipt journals, not a corpus elapsed deadline.

Buffered `semanticTelemetry.corpusRecovery.events` and streaming status events include `recovery-provider-call` records with configured per-call allowance, actual timeout, outer-deadline limitation, duration and reason. `provider_call_timeout` means the individual timer expired; `hard_request_deadline_exhausted` means the earlier outer deadline. Corpus validation failures expose only a structural reason (for example `malformed_summary`), stage and request identity, never rejected summary/source text.

Observed offline validation for the timeout correction (2026-10-06): the expanded regression run reported **592 passed and 7 blocked by sandbox `listen EPERM`**. All **14 HTTP/streaming-suite tests subsequently passed** with localhost binding permitted and mocked providers (the seven initially blocked tests are included). Thus all 599 distinct tests in that selection passed across the runs. After strengthening the next-stage cold-resume test to advance the clock by a full day, all 43 corpus-reduction tests passed again. Fake-clock tests cover sequential 170-second calls, quota/preparation exclusion, 180-second cancellation, body/SSE reading through both provider adapters, precise outer-deadline causes, child timeout telemetry, validation-error diagnostics and non-replay of uncertain corpus requests. Syntax checks and `git diff --check` passed. No live provider or deployed-platform timing was measured.

Corpus projection diagnostics are surfaced in the buffered app console as `backend.corpus-recovery`, `backend.corpus-projection`, and `backend.corpus-recovery-outcome`. `main-agent.failure` includes `corpusStopReason` beside the final error code. Streaming corpus statuses use the same sanitized field allowlist. Records distinguish `corpus-summary` from `context-summary` and include targets, measured summary sizes, before/after model-request estimates, validation reasons and stop causes; source text, summaries, prompts and provider payloads are excluded.

A validated summary that does not measurably shrink the final model request can receive one smaller-target correction, sharing the stage repair allowance and twelve-request bound. Its completed candidate is archived before correction. Pending/uncertain stages are never replayed on cold recovery; accepted completed stages are reused. Below-minimum targets stop honestly; no truncation or increased retry budget is introduced. Token sizes are estimates under the documented estimator, not exact provider tokenizer counts.

Observed offline validation for target progression and console diagnostics (2026-10-06): **603 regression tests passed**, plus **14 localhost HTTP/streaming tests passed** with mocked providers. The strengthened corrected-summary cold-reuse check was rerun with all **47 corpus-reduction tests passing**. Coverage includes undersized first summaries, target/actual-size persistence, measurable-request correction and exhaustion, minimum-size stopping, uncertain corrections, real buffered console handling, streaming field parity, JSON-object requests, per-call timing, receipts and protected knowledge/acquisition/browser workflows. Syntax checks and `git diff --check` passed. These are offline observations, not live model quality or deployment validation.
