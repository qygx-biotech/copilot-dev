# Streaming deployment

The Mac app now requests streamed answers for Side Chat and Analyze & Recommend. The FC code calls Requesty with `stream: true` and `stream_options: { include_usage: true }`, assembles streamed tool calls, and forwards answer text through an authenticated SSE connection. Complete answers still pass the existing validation and citation resolution before they are saved or committed. Paper Cards retain their structured generation and quota fallback.

**Uploading this code to a built-in Node.js event runtime alone will not enable streaming.** Alibaba documents that SSE requires a custom runtime or container, with a chunked HTTP response. The package includes the custom-runtime HTTP server and an executable `bootstrap`; the existing `index.handler` remains compatible with buffered clients.

## Console settings

Use the supplied `alibaba-fc-streaming.zip` for an FC Web function/custom runtime:

| Setting | Value |
| --- | --- |
| Runtime | Custom runtime, Debian 12 (`custom.debian12`) |
| Startup command | `/code/bootstrap` |
| Listening port | `9000` |
| Timeout | `300` seconds |
| HTTP trigger | Keep POST and OPTIONS enabled, plus GET for health/login checks |
| Environment, RAM role and CORS | Retain the current configuration, including Requesty and JWT settings |

The bootstrap uses the installed Node.js 20 runtime. Keep the current function's endpoint if migrating it in place. If Alibaba requires a new Web function, copy its endpoint into `ALIBABA_FC_URL` in `docs/app.js` and rebuild the Mac app; until the endpoint is changed, the app will continue contacting the old backend.

After deployment, `GET /health` should report `"streamingSupported": true`. A built-in event-handler deployment reports `false`. The updated Mac app accepts both SSE and the previous JSON format, so it remains usable before deployment.

## Verify streaming

Sign in normally, open Debug Console, and ask a new Side Chat question. After knowledge preparation/tool inspection, the answer draft should grow before the final answer replaces it. The console records `main-agent.first-token`, stream stages, and completion without logging answer text or credentials. An interrupted draft is marked incomplete and is not persisted as a successful answer. Switching workspaces aborts the request.

For an HTTP check using an existing login token:

```sh
curl --no-buffer "$FC_URL/chat" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"mode":"side_chat","stream":true,"messages":[{"role":"user","content":"Briefly explain what you can help with."}]}'
```

The response should use `Content-Type: text/event-stream` and arrive as `status`, `reset`, `delta`, and finally `complete` events. Keep intermediary proxy buffering disabled. The server sends heartbeat comments every 15 seconds while waiting and handles client disconnects, backpressure, and a five-minute request deadline.

## Build the backend ZIP

```sh
cd alibaba-fc
npm ci --omit=dev
npm run sync:shared
chmod +x bootstrap
zip -r ../alibaba-fc-streaming.zip index.js side-chat-agent.js requesty-stream.js image-understanding.js src shared bootstrap package.json package-lock.json node_modules
```

References: [Requesty streaming](https://docs.requesty.ai/features/streaming), [Alibaba SSE support](https://www.alibabacloud.com/help/doc-detail/2527059.html), [custom-runtime environments](https://help.aliyun.com/en/functioncompute/custom-runtime/), [custom-runtime startup](https://help.aliyun.com/en/functioncompute/principles-1).
