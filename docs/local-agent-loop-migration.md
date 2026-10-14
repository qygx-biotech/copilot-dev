# Local agent loop migration

Status: plan approved 2026-10-06 on branch `codex/combined_cc`; implemented through the removal of the FC loop (Stage 6) as of 2026-10-07, uncommitted. The desktop agent loop is the only agent path; there is no `agentLoop` flag. The sections below record the approved plan. Where the shipped code differs, the code is authoritative: the proxy shipped as `POST /api/model/capabilities` and `POST /api/model/turn`, and the loop lives in `shared/agent/` with its host in `desktop/workers/agent-loop-*.mjs`.

## Goal

Move the agent loop from Alibaba Function Compute (FC) into the Electron desktop app. FC becomes a thin authenticated proxy to Requesty or the configured Responses provider. FC keeps the provider API keys. The desktop app never holds a provider key or a `requesty.ai` URL.

The local checkout under `codex/` is the behavioural reference: Codex runs its loop locally (`codex-rs/core/src/session/turn.rs`) and keeps state in process rather than round-tripping it through a server.

## Constraints that must survive the migration

| Constraint | How it is preserved |
|---|---|
| Reactive-only context recovery | `context-recovery.js` moves unchanged in behaviour. No proactive threshold is added. Proactive compaction stays deferred for cheap, small-window models. |
| Forced final synthesis | The tool-free synthesis path in `side-chat-agent.js` moves unchanged. |
| `loopBudget` semantics | Captured once at turn start, held in turn state, same bounds (steps, tool calls, wall clock, tokens) and stop reasons. |
| Permission gates (surface × `read_only` / `workspace_write` / `full_access`) | Surface and permission are captured at turn start and bound to the turn state, as the signed continuation binding does today. Main-process and renderer authorization services are untouched. |
| Source-scope and evidence-binding checks | `knowledgeIdentity` handles in the loop and the renderer's `executeAgentTool` source-version checks are both unchanged. |
| Durable receipts | Host journals in main (`.biodesign/runtime/tool-receipts/`, the MCP journal) and the renderer's receipt fingerprints are unchanged. The `withResults` receipt validation is kept as `receipt-admission`. |
| No provider host or key in the desktop package | `desktop/scripts/audit-package.mjs` and `desktop/test/security-boundary.test.mjs` already reject `requesty.ai` URLs and `REQUESTY_*=` markers. Both are extended to the new code. |

## Decisions

1. **Proxy style:** raw passthrough. FC forwards one provider attempt and returns the upstream bytes. Parsing, error classification, retries and backoff run in the client, using the existing classifiers unchanged.
2. **Old context archives:** archives written by the FC loop (local `/tmp` or OSS) are not readable by the local loop. They report `ARCHIVE_UNAVAILABLE` explicitly, which matches the existing "never fabricate missing archives" rule. The flag keeps each conversation on one loop so new archives stay readable.
3. **Budget and context policy:** server-advised. `GET /api/agent/models` returns the `AGENT_*` loop budget and `CONTEXT_*` policy currently read from FC env, so admins keep control. The client captures them at turn start.
4. **Two local stages:** Stage 3 runs the existing `/chat` agent host in a worker one step at a time; Stage 4 moves the step driver into the worker.
5. **Cost control:** once the loop is local the client decides how many calls it makes. Per-user Requesty keys limit exposure; the proxy adds per-account concurrency and size limits with distinct `PROXY_*` error codes.

## Facts the plan depends on

- `forge.config.cjs` excludes `alibaba-fc/` from the desktop package, so moved code needs a new top-level location: `agent-core/`.
- Most tool execution already happens in the renderer: project evidence tools (`docs/project-context-service.js` `executeAgentTool`), the runtime registry and subagent manager (`docs/runtime-session.js`, `docs/generic-subagents.js`), and the academic, download and library-worker handoffs in `docs/app.js` (which include UI prompts such as the library login wait). The local loop calls back into the renderer for tools instead of reimplementing them.
- Electron 44's `net.fetch` works in utility processes and uses Chromium's network stack, so it honours system proxy settings. Node's `fetch` does not.
- `alibaba-fc/STREAMING_DEPLOYMENT.md` (2026-09-09) records the deployed FC as buffered (`streamingSupported: false`). A streaming proxy needs the Web Function deployment. Without it the proxy still works but returns buffered JSON, which the client already handles.

## Current flow

```text
renderer ──POST /chat (body + signed continuation)──► FC handler ──► side-chat-agent loop ──► Requesty
   ▲                                                          │
   └──── SSE events + desktopToolCalls + signed continuation ─┘
renderer executes host tools, then posts results back with the continuation (repeat)
```

Each FC request is bounded by 300 s. Loop state round-trips through the renderer as a signed, deflated token capped at 700 KB uncompressed (`agent-continuation.js`).

## Target flow

```text
renderer ◄──IPC events / host-tool requests──► main ◄──► agent-loop worker (utility process)
                                                              │  agent-core: loop, recovery, prompts
                                                              ▼
                                                  FC /api/agent/model-call ──► Requesty / Responses
```

Loop state stays in worker memory for the turn. No signed continuation, no 700 KB cap.

## 1. Module classification

New top-level `agent-core/` holds the moved code. It is packaged with the desktop app and synced into the FC package (like `shared/`) while both loops coexist. Modules in `agent-core/` require `../shared/…` directly.

| Module | Decision | Notes |
|---|---|---|
| `side-chat-agent.js` | Moves with changes | Stage 3 runs it as-is. Stage 4 awaits a host port instead of returning `desktopToolCalls`, and drops the `request_deadline` checkpoint and the stream-ticket early-call gating. |
| `context-recovery.js` | Moves with changes | Archive root: `<project>/.biodesign/runtime/agent/context-archives/`. Learned limits and quota ledger: the app user-data folder. `deadlineAt` meaning changes (see section 4). The learned-limit account scope comes from the proxy's `accountScope`. The OSS remote archive option is removed. |
| `agent-budget.js` | Moves with changes | `configFromEnv` is replaced by the proxy policy. Bounds and stop reasons are unchanged. `request_deadline` no longer applies locally. |
| `requesty-response.js` | Moves with changes | `diagnostics()` drops the API-key argument; the proxy redacts. |
| `provider-lifecycle.js` | Split | `configuration()` (endpoints, keys, adapter JSON) stays in FC. `requestBody`, `normalize`, `responses` and `capabilities` move local, with `fetchImpl` pointed at the proxy. `profile` is computed in FC and delivered by `/api/agent/models`. |
| `requestRequestyMessage` (in `index.js`) | Split | FC keeps one attempt, key injection, header filtering and redaction. `agent-core/provider-client.js` takes retries, backoff, the deferred input-token rule, `errorCategory`, the safe error message and usage extraction. |
| `agent-continuation.js` | Split | `seal` and `open` are deleted. `withResults` becomes `agent-core/receipt-admission.js`; receipts still come from the renderer, so validation stays (shape checks, download path checks, academic `recordResult`, nested Code Mode budget). |
| `agent-step.js`, `agent-progress.js`, `conversation-history.js`, `input-quota.js`, `corpus-card-fallback.js`, `corpus-card-reduction.js`, `corpus-context.js`, `agent-context-budget.js`, `literature-specialist.js`, `academic-agent.js`, `academic-context.js`, `academic-planning.js`, `academic-recovery.js`, `generic-subagent.js`, `requesty-tool-context.js`, `requesty-stream.js`, `requesty-search-stage.js` | Move unchanged | Require paths only. |
| `requesty-models.js` | Stays in FC | Holds the Requesty catalog URL used with the key, known capabilities, `toolMode` and `withCombinedToolConfig` (now applied by the proxy). |
| `chat-timing.js` | Stays in FC | Proxy timing. The local side uses `docs/runtime-log.js`. |
| `semantic-intent-planner.js`, `model-json.js`, `paper-card-output.js`, `wiki-generation.js`, `semantic-input-privacy.js`, `audio-transcription.js`, `image-understanding.js` | Stay in FC | Non-loop endpoints. `validImageBytes` is copied for local request admission. |
| `stream-call-ticket.js`, `context-archive-store.js` | Deleted after migration | Together with `POST /api/runtime/verify-stream-call`. |

### `shared/`

| Files | Decision |
|---|---|
| academic-tools, advanced-tools, agent-prompts, chat-images, conversation-transcript, corpus-result-service, event-stream, generic-subagent, literature-agent, provider-rate-limit, retrieval-contract, runtime-concurrency, runtime-extensions, runtime-tools, semantic-intent, side-chat-tools, source-citations, source-download, turn-observability, web-search | Used by the loop. The worker loads them from `shared/` unchanged. |
| backend-config | Used by the worker for `FC_BASE_URL`. |
| experiment-semantics, literature-wiki, retrieval-profiles, source-fetch, topic-navigation | Not part of the loop. Unchanged. |

`alibaba-fc/scripts/sync-shared.mjs` keeps syncing until Stage 6, then shrinks to what the remaining FC endpoints need.

## 2. `alibaba-fc/index.js` responsibilities

| Responsibility (functions) | Destination |
|---|---|
| Login, logout, `/api/me`, beta users, JWT (`handleLogin`, `requireAuth`, `getBetaUsers`, `userEnvironment`, …) | FC |
| Model allowlist and per-user env (`chatModelEnvironment`) | FC. The proxy validates every call; `/api/agent/models` lists the allowed models. |
| Capability resolution (`getRequestyCapabilityConfig`, `selectRequestyModel`, `requesty-models.agentCapabilities`, `provider-lifecycle.configuration`, `CONTEXT_MODEL_WINDOWS`) | FC, served by `/api/agent/models`. |
| `/chat` admission: original-request bounds, `normalizeProviderCallContext`, image validation, `runtimeExtensions` / injections / revoked-tools normalization, `desktopTools` permission parsing | Local `agent-core/agent-host.js`. `callContext` is also re-validated by the proxy for Requesty tags. |
| Context sanitizers and builders: `sanitizeLocalWorkspaceContext` (~590 lines), `buildLocalWorkspaceContext`, `buildWorkspaceContext`, `sanitizeReferenceDocuments`, `sanitizeExperiment*`, `sanitizeKnowledgeSync`, `sanitizeSemanticExperimentResult`, `sanitizeChatMessagesForLlm` | Local. They stay the trust boundary between the sandboxed renderer and the worker. |
| Prompts (`coreSystemPrompt`, `systemPrompt`, `sideChatSystemPrompt`), `buildAgentRequest`, `parseModelResponse`, `parseSideChatResponse`, `extractFirstJsonObject`, `makeSideChatFailure`, `makeFallbackResponse` | Local. |
| Semantic preflight | The IR is still produced by the FC `/api/semantic/interpret` endpoint. Its structural validation (`semanticIntent.validateSemanticIR`) moves local. The IR is not signed today, so trust does not change. |
| Catalog building and the web-search stage | Local (already inside the loop). The hosted search call goes through the proxy, which allows `web_search` only for models that support it. |
| Legacy OSS stored-PDF context (`resolveStoredPdfChatContext` and helpers) | Stays on the FC loop. The local loop rejects `storedDocuments`. |
| `callRequesty` orchestration | Local `agent-host.js`, with injected provider client, capabilities, continuation store and event emitter. |
| Usage | `turnUsage` (`shared/turn-observability.js`) is local. Requesty metadata tags (`requestyMetadata`) and server-side usage logging (`sanitizeRequestyUsage`) move to the proxy. |
| Quota and rate limits | Classification, `QuotaLedger` and cooldown waits are local. The proxy adds per-account limits with `PROXY_*` codes. |
| Streaming to the UI (`src/index.js` SSE transport) | Local IPC events with the same vocabulary. `src/index.js` stays as the proxy's HTTP adapter. |
| Signed continuations (`agentContinuation.seal/open`, `desktopContinuation` / `agentContinuation` admission, `LOCAL_CONTEXT_TRANSPORT_LIMIT`), `tool-ready` tickets, `/api/runtime/verify-stream-call` | Deleted. |
| Non-loop LLM endpoints: `/api/semantic/*`, `/api/context/route`, `/api/knowledge/plan-search`, `/api/knowledge/rerank`, `/api/knowledge/update-wiki`, `/api/literature/*`, `/api/corpus/map-paper`, `/api/chat/understand-images`, `/api/chat/transcribe` | Stay in FC. Out of scope; candidates for a later move onto the same proxy. |
| Non-LLM endpoints: `/api/sources/fetch`, `/api/documents/*`, `/api/test-oss`, `/health` | Stay in FC. |

## 3. Proxy contract

### `GET /api/agent/models` (authenticated)

```json
{
  "version": 1,
  "defaultModel": "…",
  "models": [{
    "id": "…", "api": "chat_completions | responses", "profile": "…", "nativeModel": "…", "reasoning": null,
    "supportsTools": true, "supportsImages": true, "supportsWebSearch": false, "supportsTemperature": true,
    "jsonSchema": false, "jsonObject": true, "contextWindowTokens": 128000, "toolMode": "sequential",
    "accountScope": "<sha256 of credential + account>"
  }],
  "contextPolicy": { "outputTokens": 8192, "safetyTokens": 1024, "summaryTokens": 2048, "imageTokens": 4096,
    "maxAttempts": 4, "maxSummaryCalls": 16, "providerCallMs": 90000, "quotaWaitMs": 180000, "quotaTtlMs": 60000 },
  "loopBudget": { "maxSteps": 64, "maxToolCalls": 192, "turnMs": 1800000, "turnTokens": null },
  "limits": { "maxBodyBytes": 33554432, "maxOutputTokens": 131072, "callTimeoutMs": 300000, "streaming": true },
  "localLoop": { "allowed": true, "minClientVersion": "…" }
}
```

Values shown are the current FC defaults. Capability lookups keep the existing five-minute server cache. `localLoop` is the remote kill switch.

### `POST /api/agent/model-call` (authenticated)

Request: `{ version: 1, model, surface, stage, callContext, api, request }`. `request` is the provider body without model, key or Requesty metadata.

Validation:
- the model is allowed for the surface
- only allowlisted top-level body keys per API
- `max_tokens` / `max_output_tokens` clamped to `limits.maxOutputTokens`
- `web_search` tool and image parts only when the model supports them
- Responses calls forced to `store: false`
- body at most 32 MiB

Rewriting: sets the model (the native model for Responses), injects Requesty metadata from the validated `callContext` (client-sent `requesty` fields are dropped), applies the Gemini combined-tool `toolConfig`, injects the key.

One attempt only. The client owns retry, backoff, deadline and quota-wait policy.

Responses:

| Case | HTTP | Body |
|---|---|---|
| Upstream success | 200, `x-biodesign-origin: upstream` | Upstream bytes passed through unchanged (SSE or JSON). The client keeps using `requesty-stream.js` and `provider-lifecycle.normalize`. |
| Upstream error | 200, `x-biodesign-origin: upstream-error` | `{ status, headers, body }`. `headers` is limited to `content-type`, `retry-after`, `x-ratelimit-*`, `x-request-id`, `request-id` (exactly what `input-quota.js` and `requesty-response.js` read). `body` is the upstream text with the key redacted. |
| Upstream transport failure | 200, `x-biodesign-origin: upstream-transport` | `{ causeCode }`, mapped to `LlmRequestFailed`. |
| Proxy's own failure | 4xx/5xx | `{ origin: "proxy", error }` with `PROXY_AUTH`, `PROXY_MODEL_NOT_ALLOWED`, `PROXY_BODY_INVALID`, `PROXY_TOO_LARGE`, `PROXY_RATE_LIMITED`, `PROXY_UPSTREAM_TIMEOUT`. |

For upstream errors the client rebuilds a Response-like object, so `overflow()`, `inputQuota()`, `parseRateLimit()`, `errorCategory` and the Responses error codes run unchanged. `PROXY_*` errors, and any response without `x-biodesign-origin` (for example an FC gateway 502/504), must never be classified as provider context overflow or input quota.

Cancellation: the client aborts `net.fetch`; FC sees the connection close and aborts the upstream request (existing `src/index.js` pattern). If the 300 s FC timeout ends a stream, the client sees an incomplete stream and reports `STREAM_INTERRUPTED`, as today.

Per-account limits (initial values, FC env): at most 4 concurrent model calls per account (`AGENT_PROXY_MAX_CONCURRENT`), body and output caps as above. Exceeding them returns `PROXY_RATE_LIMITED`.

Callers: the main loop, the web-search stage, context and corpus summaries, and the literature specialist. All of them already go through the loop's single provider-call function.

## 4. Local runtime

### Files

| File | Role |
|---|---|
| `agent-core/` | Moved loop modules, `agent-host.js`, `provider-client.js`, `receipt-admission.js`, local archive store. |
| `desktop/workers/agent-loop-worker.mjs` | Utility-process entry. Loads `agent-core/` with `createRequire`. |
| `desktop/workers/agent-loop-client.mjs` | Main-side client, same pattern as `QmdWorkerClient`, plus per-turn event streams and cancel. |
| `desktop/services/agent-loop-service.mjs` | Worker lifecycle, routing to the owning window, flag resolution. |
| `docs/local-agent-transport.js` | Stage 3 renderer transport (replaces the `/chat` fetch). |
| `docs/agent-host-adapter.js` | Stage 4 renderer host adapter (answers tool, checkpoint and evidence-recovery requests). |

### Worker lifecycle

- One worker per open project, started on the first turn and stopped on project close, like QMD.
- Environment: the minimal safe set used by QMD, the project root, and the user-data state directory. No credentials.
- The FC auth token is passed with each turn start and kept in memory only. Never logged or persisted.
- The worker writes only `.biodesign/runtime/agent/` in the project and its user-data state directory. It never reads project sources; tools run in the host.
- Network: `net.fetch` to `FC_BASE_URL/api/agent/*`.

### IPC

| Channel | Direction | Stage |
|---|---|---|
| `biodesign:agent:start` | renderer → main (invoke) | 3 |
| `biodesign:agent:cancel` | renderer → main (invoke) | 3 |
| `biodesign:agent:event` | main → renderer (send) | 3 |
| `biodesign:agent:host-request` | main → renderer (send) | 4 |
| `biodesign:agent:host-respond` | renderer → main (invoke) | 4 |

Preload exposes a frozen `biodesignDesktop.agent` with `start`, `cancel`, `onEvent` and (Stage 4) `respond`.

Validation:
- Main checks the envelope with `desktop/ipc/validation.mjs` helpers: allowed keys, `turnId` / `streamId` / `requestId` patterns, at most 32 MiB, sender is the main window, `workspaceId` matches the active project.
- The worker re-validates content with the moved FC admission sanitizers.
- Host responses must match `requestId`, turn and sender, and are single-use.
- Tool receipts pass `receipt-admission` before they reach model context.

Events keep the current SSE vocabulary: `status`, `delta`, `reset`, `sources`, `transcript`, `usage`, `tool-ready`, `complete`, `error`, `evidence-recovery`. The `docs/app.js` UI handlers are reused. `tool-ready` no longer needs ticket verification, because main only forwards events from the worker that owns the turn.

### Cancellation

- The renderer abort signal calls `agent.cancel`, which aborts the turn's AbortController in the worker. That aborts the proxy fetch, rejects pending host requests and interrupts quota waits (`ContextRecovery` already honours its signal).
- Main also cancels a window's turns when it is destroyed, reloaded or crashes, and all turns on project close or switch and on app quit.
- A live permission reduction already aborts the runtime session in the renderer, which cancels the turn.
- A worker crash fails every running turn with `AGENT_WORKER_EXITED`. Nothing is retried automatically, so uncertain effects are never replayed.

### Steering and injections

- Stage 3: unchanged. The renderer runs `runtimeSession.atCheckpoint` and passes `runtimeInjections` and `runtimeRevokedTools` with each step.
- Stage 4: at each step boundary the worker sends a `checkpoint` host request. The renderer runs `atCheckpoint` and replies `{ injections, revokedTools, shouldContinue }`. Accepted injection IDs are acknowledged at the next checkpoint, with the same semantics as `runtimeAccepted` today.

### Deadlines

FC's 300 s request deadline no longer bounds the loop. `ContextRecovery`'s `deadlineAt` becomes turn start + `loopBudget.turnMs` + one `providerCallMs` allowance, so forced synthesis always has time to run after the turn budget is reached. Each proxy call is still capped at 300 s by FC.

### Continuations (Stage 3 only)

The worker keeps loop state in an in-memory map keyed by an opaque handle. A handle is bound to the turn, the request-binding digest (reusing the existing `digest(binding)`) and the purpose (desktop tools or evidence recovery), and it is single-use. Stage 4 removes handles entirely.

## 5. Tests

| Group | Files |
|---|---|
| Move unchanged (require paths only) | academic-candidate-pool, academic-empty-recovery, academic-evidence-recovery, academic-planning, academic-reply, academic-search-recovery, academic-shortlist-recovery, academic-tools, academic-main-loop, academic-aggregate-download, agent-budget, agent-progress, agent-step, context-recovery, input-quota-recovery, corpus-card-fallback, corpus-card-reduction, literature-specialist, side-chat-agent, turn-observability, generic-subagent, demand-context, demand-driven-side-chat, literature-evidence-recovery, literature-follow-up, literature-routing, literature-wiki, saved-knowledge, source-citations, evidence-access, knowledge-access-audit, workspace-side-chat, preflight-knowledge-sync, semantic-integration |
| Run against both loops during the flag period, then local only | agent-context-budget, conversation-transcript, corpus-continuation, corpus-scope, direct-side-chat, evidence-budget, knowledge-guidance, knowledge-tool-identity, research-execution, retrieval-scope-routing, runtime-extensions, sequential-tools, side-chat-task-model, targeted-evidence, web-search-download, desktop-download-flow, literature-desktop-flow, academic-desktop-flow, agent-text-response, agent-work-images, provider-fidelity |
| Split between proxy and local | chat-model-selection, requesty-overload-retry, requesty-transport-error, requesty-fetch-diagnostics, recovery-timing, streaming, gemini-combined-tools, chat-images (`/chat` part only), security-boundaries |
| Obsolete after Stage 6 | agent-continuation (seal/open/binding/700 KB; the `withResults` cases move to receipt-admission), the ticket parts of provider-lifecycle, context-archive-durable (replaced by a local archive store test), the request-deadline tests in agent-budget, the signed-handoff assertions in runtime-extensions, corpus-continuation and agent-context-budget |
| Unaffected (FC endpoints or renderer only) | audio-transcription, beta-users, cloud-retrieval, experiment-semantics, literature-multilingual, local-workspace, model-json, oss-pdf-review, paper-card-configuration, paper-card-structured-output, provider-rate-limit, qmd-knowledge-layers, retrieval-profiles, runtime-log, semantic-backend, semantic-equations, semantic-intent, semantic-intent-planner, source-system, wiki-admission, wiki-provider, wiki-reliability, wiki-timeout-recovery, academic-preflight, chat-timing |

All of the above are under `alibaba-fc/test/`.

Desktop (`desktop/test/`):
- `runtime-session.test.mjs`: checkpoint and continuation assertions change in Stage 4.
- `process-output.test.mjs`: its `withResults` import moves to `receipt-admission`.
- `security-boundary.test.mjs`: extend the no-Requesty-host, no-credential check to `agent-core/` and the worker; assert the worker environment has no secrets.
- New: IPC validation, cancellation paths (renderer abort, window reload, project close, app quit), host-request routing (wrong sender or turn rejected), steering checkpoints, worker crash.

Parity harness (Stages 3–5): each test in the "both loops" group runs once through the FC `/chat` handler with a mocked Requesty fetch, and once through the local agent host with a mocked proxy that returns the same upstream bytes. The test asserts identical provider request sequences (after removing the proxy-injected model mapping and Requesty metadata) and identical final response data and events.

## 6. Stages

Flag: `agentLoop: "fc" | "local"`, resolved in main from the `BIODESIGN_AGENT_LOOP` env (development) or app settings, per surface (`side_chat`, `agent_command`, child agents). It defaults to `fc` until Stage 5.

Routing rules:
- A turn never changes loop mid-way, and a conversation stays on the loop of its first turn, so context archives remain readable.
- The `localLoop.allowed` kill switch in `/api/agent/models` forces `fc`.
- Browser (non-Electron) mode, legacy OSS document requests (`storedDocuments`, `referenceDocuments`, `experimentModules`) and requests without `localWorkspaceContext.agentLoop.version === 1` always use `fc`.

| Stage | Work | Exit criteria |
|---|---|---|
| 1. Extract `agent-core/` | Move the modules. Turn `callRequesty` and `/chat` admission into `agent-core/agent-host.js` with injected provider client, capabilities, continuation store and emitter. Split `requestRequestyMessage` into the FC attempt and `agent-core/provider-client.js`. FC still calls everything in-process. No behaviour change. | All existing backend and desktop tests pass. Package audit passes; `agent-core/` contains no provider host or key marker. |
| 2. Proxy endpoints | Add `GET /api/agent/models` and `POST /api/agent/model-call` to FC. Additive only; `/chat` unchanged. | Proxy contract tests pass (validation, rewriting, redaction, header filtering, origin header, cancellation, per-account limits, buffered fallback). Deployed as a Web Function with `streamingSupported: true`. |
| 3. Local `/chat` worker | Worker, client, service, IPC channels, preload API. The worker runs `agent-host.js` one step per renderer request through the proxy, with in-memory continuation handles. Renderer swap point: the fetch in `sendWorkbenchRequestOnce` (`docs/app.js`), behind the flag. | Parity harness green for the whole "both loops" group. Internal dogfooding of Side Chat. |
| 4. Driver moves into the worker | Host-request RPC replaces the `app.js` handoff round trips. Checkpoints and evidence recovery (`answerWithEvidenceRecovery`) become host requests. Child agents become local turns in the same worker. Continuation handles removed. | Parity retained. A 60-step turn completes without per-step payload growth. Cancellation and crash tests pass. |
| 5. Default to local | Flip the default per surface: Side Chat, then Agent Work, then child, academic and literature turns. The FC loop stays as a fallback for one release. | Telemetry (steps, tool calls, tokens, compactions, failure codes, latency) is no worse than the FC baseline on the existing evals workspace. |
| 6. Remove the FC loop | Delete the `/chat` loop path, seal/open, `stream-call-ticket.js`, `/api/runtime/verify-stream-call`, the `request_deadline` continuation, the OSS context-archive store, FC loop env handling that is now served as policy, the renderer handoff code, and obsolete tests. | FC contains only auth, the proxy and the non-loop endpoints. All remaining tests pass. |

## Risks

| Risk | Mitigation |
|---|---|
| Spend control moves to the client | Per-user Requesty keys; per-account proxy limits; `localLoop` kill switch. |
| FC still deployed as a buffered event function | The proxy returns buffered JSON; the client already handles it. No token streaming until the Web Function deployment. |
| Large IPC payloads in Stage 3 (full workspace context and images per step) | Same sizes as today's HTTP bodies; Stage 4 removes the per-step repetition. |
| Worker crash or window reload loses the running turn | Same as a renderer reload today. Transcript checkpoints are already saved; uncertain effects are not replayed. |
| Mixed loops in one conversation | Conversations stay on one loop (routing rule above). |
| `net.fetch` streaming differences from Node `fetch` | Covered by the Stage 3 streaming and cancellation tests before dogfooding. |
