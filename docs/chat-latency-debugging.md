# Tracing `/chat` latency

The desktop debug console now records `chat.timing` events for each `/chat`
exchange, including each desktop-tool continuation. Client timings are enabled
whenever the existing runtime logger is present. They do not change retry policy,
model selection, deadlines, or tool execution.

For server timings, run the updated FC backend with `CHAT_TIMING_DEBUG=1`.
`CONTEXT_DEBUG=1` also enables them. Include the new `alibaba-fc/chat-timing.js`
module with `index.js`; custom HTTP runtimes additionally use the updated
`src/index.js`. The response then carries a bounded `chatTiming` diagnostic envelope,
and the desktop copies its stages into `chat.server-timing` console events. Both
buffered JSON and streaming responses carry these timings. Older servers remain
compatible and produce `serverTimingAvailable:false` instead of invented timings.

After updating local frontend code, refresh the shared renderer assets and rebuild
the renderer (`npm run desktop:prepare`), then restart the app. A packaged app needs
to be rebuilt. Updating local files alone does not update a deployed FC backend.
No deployment is performed by this change.

## Correlation and privacy

- `turnId` identifies the user turn in the desktop log.
- `requestId` identifies one desktop HTTP exchange. It is also sent as the
  UUID-only `timingRequestId` body field, not as a new request header, so this
  instrumentation does not introduce an extra CORS preflight requirement.
- `serverRequestId` in desktop server-timing events matches `requestId` in FC
  `chat_timing` logs. FC also logs `clientRequestId` once it has parsed the body.
- The custom HTTP adapter and backend handler share the server request ID, so
  body receipt and response completion can be joined with provider timings.

Only numeric measurements, bounded stage names, IDs and statuses are logged.
Prompts, image bytes, document text, tool results, credentials and raw headers are
excluded. Server responses retain at most 256 timing events; `droppedEvents`
reports overflow. Existing desktop log retention still applies.

## Reading the phases

Durations and elapsed offsets use monotonic clocks within each process. Do not
subtract desktop timestamps from server timestamps: clocks may differ. Parent
intervals include their children, so do not add every duration together.

| Events | What the interval includes |
| --- | --- |
| `request_serialization_start/end` | Building the outgoing JSON string; `requestBytes` measures its UTF-8 size, including encoded images |
| `fetch_start` → `fetch_headers` | Browser scheduling, connection/preflight, upload, platform queue/startup and server work until response headers arrive |
| `buffered_body_start/end` | Downloading and decoding a buffered JSON body after headers |
| `json_parse_start/end` | Parsing buffered JSON, independently of download |
| `first_response_bytes` / `first_stream_event` | First readable streaming bytes / first application event; these are not necessarily answer tokens |
| `response_read_start/end` | Full response reader; for SSE this includes awaited event callbacks, including streamed checkpoint saves |
| `transcript_save_start/end` | Each awaited local transcript save, including the final buffered checkpoint |
| `client_complete` | Completion of this HTTP exchange's frontend processing, before any next tool handoff |
| `handler_entry` → `handler_result` | Actual backend handler lifetime, including preparation before the recovery deadline starts |
| `authentication_done`, `body_parsed`, `validation_done` | Authentication, JSON parsing and request validation checkpoints |
| `stored_context_start/end` | Any stored-document lookup before the agent starts |
| `model_capabilities_start/end` | Model capability resolution, including a catalog request if needed |
| `recovery_deadline_started` | Where the existing model-request deadline is established; compare with handler entry |
| `agent_loop_start/end` | Entire agent execution, including recovery and all provider calls |
| `provider_fetch_start/end` | Each Requesty HTTP attempt until headers; includes request serialization, transport, upstream waiting and buffered inference |
| `provider_body_start/end` | Reading/parsing that attempt's body, including streamed generation if applicable |
| `provider_retry_wait_start/end` | Adapter retry backoff, separate from provider transport |
| `response_serialization_start/end` | Building the backend's normal JSON response |

In FC custom HTTP adapter logs, `http_entry`, `http_body_read_start/end`,
`http_headers_sent`, `http_result_ready`, and `http_response_finished` additionally
show body upload receipt and server response completion. `bodyReadMs` is returned
to the desktop when that adapter is used. A managed event handler receives an
already-buffered request, so it cannot observe earlier body receipt. Failed reads
and closed connections leave an explicit failure/close event, not a fake success.

## Finding the missing 250 seconds

For example, the desktop might report:

```json
{"stage":"fetch_headers","durationMs":289000,"transport":"json"}
{"stage":"response_read_end","durationMs":1000}
{"stage":"round_trip","clientRoundTripMs":290000,"handlerMs":40000,"clientOutsideHandlerMs":250000,"serverTimingAvailable":true}
{"stage":"transcript_save_end","durationMs":17000}
```

Here the 250 seconds occurred outside the measured backend handler. The separate
17-second transcript save happened afterward. Alternatively, if
`handlerMs` is about 290000 and `provider_fetch_end` accounts for only 40000,
the intermediate server stages identify the slow preparation phase. A long
`provider_body` or `buffered_body` interval identifies response reading; a long
`transcript_save` interval identifies local persistence.

`browser_network` supplies DNS, connection/TLS, request-to-first-byte, download
and transfer-size measurements when Resource Timing exposes them. Debug-enabled
responses include `Timing-Allow-Origin` and `Server-Timing`. Platforms can strip
these headers; unavailable phases are omitted and marked with
`networkTimingDetailed:false`, never represented as known zero durations.
Indistinguishable concurrent fetch entries are marked ambiguous rather than
assigned to the wrong request.

`requestToFirstByteMs` combines upload, platform/server waiting and execution;
browser Resource Timing does not separate those components. Likewise,
`clientOutsideHandlerMs` is a residual, **not a measurement of network delay alone**.
It can contain upload/body receipt, FC queue/cold-start time, network delivery,
browser decoding, SSE callback work and small diagnostic-envelope overhead.
Use FC access/invocation logs with the correlated handler-entry/return events to
separate platform queue/startup from network delay. `processUptimeMs` helps identify
a young process but does not measure cold-start duration. Streaming reveals
progress sooner; it does not itself eliminate an unmeasured transport/platform gap.


### Failures before response headers

`provider_fetch_end` with `outcome:failed` and no HTTP status means request execution threw before headers arrived; it is not evidence of HTTP 503, model rejection, or a context/time limit. Earlier logs discarded the exception cause, so they cannot distinguish a socket/DNS/TLS failure from a local request error. A successful HTTP 200 from `/chat` can still carry `LlmRequestFailed`; it confirms the app received the backend envelope, not that the model succeeded.

The adapter now validates request construction once before dispatch. Setup failures return `RequestyRequestInvalid`, `transportPhase:request_setup`, and zero provider attempts. Fetch exceptions retain `transportPhase:fetch`, an allowlisted `exceptionName`, and known `transportCode`/`transportCauseCode` values from nested causes (including aggregate errors). These fields appear in server timing, the Agent Work failure envelope, and exported desktop logs, so FC log access is not required for the next diagnosis. Unknown exceptions remain unknown; no raw messages, stacks, prompts, headers, credentials, addresses, or arbitrary codes are retained.

HTTP 503 allows five total attempts within the existing deadlines. Thrown fetch exceptions retain the existing two-attempt bound. Neither retries nor the generic `agent_loop_end` timing event with `outcome:completed` proves task success; inspect `main-agent.failure` and the final task outcome. The timing event indicates only that the loop function returned.
