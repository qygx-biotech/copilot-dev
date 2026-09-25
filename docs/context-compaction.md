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
under actual or locally measured context pressure.

The estimator measures the same request-body builder used for dispatch, including
system messages, tools, message framing, opaque tool protocol fields, and attached
images. It excludes binary image payload bytes and reserves a configurable token
allowance per image. This is a local heuristic, not a provider-exact tokenizer.
Reported input usage calibrates it upward; confirmed overflow can supply more
accurate counts and limits. Output tokens and a safety margin are reserved.

An unknown model window stays unknown and uses reactive recovery, rather than an
invented small window. Configure the selected model's documented window for
proactive protection from the first request. Catalog window metadata is used when
the existing capability lookup supplies it. The backend does not guess a model's
window from its name or use a rate quota as a context limit.

Limits learned from confirmed overflow are scoped by endpoint/tool mode, provider,
model, account-key digest, configured window, output reserve, and image allowance.
Input-only limits reserve the safety margin; combined limits additionally reserve
output. Without numeric feedback, the attempted input budget drops by 20%.
Learned limits are saved atomically for 24 hours and carried in signed handoffs.
Credentials and account digests are not logged. Separate FC instances share learned
limits only when the configured archive directory is on shared storage.

## Recovery and session integrity

The manager tracks accepted non-system history H separately from pending input Δ.
Only a successful provider request advances the accepted boundary. The current
user request remains in the host's mandatory instructions and pending input is
kept outside a history summary. Completed tools are dispatched outside the retry
loop and are never re-executed because a subsequent model request failed.

Recovery proceeds as follows:

1. Archive the original model view and oversized tool results. Replace large
   results with an explicit incomplete preview and a `read_context_archive`
   reference. The tool reads bounded sections without rerunning the original tool.
   Large document-read results can also receive section summaries and merged
   findings; the original result and tool-call/result pairing remain available.
2. Summarize accepted history using archived originals when available, not merely
   their previews. Use a small data-only prompt, no agent tools,
   no attached current-turn images, and an independent output allowance.
3. Split oversized history into source sections, summarize each, then merge or
   recursively summarize. Every summary call is measured separately. A rejected
   chunk is split before retry; identical oversized payloads are not resent.
4. Replace H with a checkpoint and preserve Δ. Remeasure the complete normal
   request. A retry must remove at least the smaller of 64 estimated tokens or 1%
   of the input, and its uncalibrated size must decrease across attempts.
5. If summarization fails, use a labeled, incomplete extractive checkpoint with
   archive references. If mandatory instructions, pending input, or tool schemas
   still cannot fit, return `ContextRecoveryIncomplete` with a useful next step.

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

Rate limits, authentication failures, output truncation, and transport failures do
not trigger context compaction. Existing transient/rate backoff remains; the former
third, shortened request after two input-token-rate rejections has been removed.
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
| `CONTEXT_RECOVERY_ATTEMPTS` | `4` | Maximum reductions for one model decision |
| `CONTEXT_SUMMARY_CALLS` | `16` | Total summary calls across chunking/merging for that decision |
| `CONTEXT_RECOVERY_MS` | `90000` | Recovery wall-clock deadline; also bounded by the HTTP deadline |
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

Events contain IDs and numeric measurements, never full prompts, evidence, image
bytes, credentials, or summary text. Example (illustrative):

```json
{"requestId":"turn-42","provider":"google","model":"selected-model","stage":"learned-limit","estimatedTokens":190000,"reportedTokens":210000,"effectiveLimit":200000,"limitScope":"total","outputReserve":8192,"inputBudget":190784,"elapsedMs":20}
{"requestId":"turn-42","stage":"chunk","chunkCount":3,"summaryCalls":1,"elapsedMs":70}
{"requestId":"turn-42","stage":"checkpoint","checkpointBoundary":24,"continuationStateReset":true,"beforeTokens":210000,"afterTokens":42000,"summaryTokens":1800,"elapsedMs":3600}
{"requestId":"turn-42","stage":"outcome","outcome":"recovered","attempts":2,"elapsedMs":4700}
```

Other outcomes are `unchanged`, `degraded`, and `unable_to_continue`. Summary calls
also log their own budget and output allowance. Provider-attempt telemetry includes
summary calls; summaries never stream into the user's answer.

## Verification and limitations

`test/context-recovery.test.js` tests budgeting, calibration, chunk rejection,
recursive recovery, pending input, archive retrieval, isolation, deadlines, and
honest failure with mocked providers. `agent-context-budget.test.js` and
`corpus-continuation.test.js` exercise the authenticated FC/desktop handoff and
actual host collection path, including original receipts and no repeated tools.

Summaries are lossy. Archive availability depends on storage. The estimator and
image allowance can underestimate a provider; reactive learning is the second
defense. Arbitrary user instructions and mandatory schemas are never silently
truncated or automatically replaced by a guessed relevant subset. If those alone
exceed the feasible budget, recovery stops with an incomplete result. Existing
historical records already shortened before this change cannot be reconstructed.
Provider outages and unavailable required content cannot be made successful by
compaction. No deployment or provider acceptance is implied by mocked tests.
