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

The same archive/checkpoint/chunk pipeline below is used. Matching history
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

- **Per-provider-call timeout:** `CONTEXT_PROVIDER_CALL_TIMEOUT_MS`, default
  90000 ms, applies independently to normal requests (including the initial intact
  request), recovery retries and summary calls. Each call is bounded by the smaller
  of this timeout and the remaining hard request time. Generic retries/backoff
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
Each call individually fits the default 90-second timeout. With only 88 seconds
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
| `CONTEXT_PROVIDER_CALL_TIMEOUT_MS` | `90000` | Independent timeout for each normal/summary adapter call; 100–300000 ms, capped by remaining hard-request time |
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
{"requestId":"turn-43","stage":"quota-wait","eventKind":"provider_cooldown","recoveryMode":"input_quota","retryAfterMs":58000,"activeRecoveryMs":80000,"quotaWaitMs":0,"providerCallTimeoutMs":90000,"quotaWaitRemainingMs":180000,"hardDeadlineRemainingMs":210000}
{"requestId":"turn-43","stage":"quota-wait-finished","eventKind":"provider_cooldown","recoveryMode":"input_quota","activeRecoveryMs":80000,"quotaWaitMs":58000,"providerCallTimeoutMs":90000,"quotaWaitRemainingMs":122000,"hardDeadlineRemainingMs":152000,"elapsedMs":138000}
{"requestId":"turn-44","stage":"outcome","outcome":"incomplete_result","reason":"quota_wait_budget_exhausted","retryAfterMs":58000,"activeRecoveryMs":3000,"quotaWaitMs":130000,"providerCallTimeoutMs":90000,"quotaWaitRemainingMs":50000,"hardDeadlineRemainingMs":150000}
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
{"stage":"provider-call","callId":"turn-42:3","callStage":"context-summary","callStatus":"completed","estimatedTokens":12000,"outputReserve":2048,"timeoutMs":90000,"durationMs":45000,"outcome":"summary_received","activeRecoveryMs":90000,"quotaWaitMs":0,"hardDeadlineRemainingMs":90000,"callsDispatched":3,"callsCompleted":3,"callsTimedOut":0,"callsCancelled":0}
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
