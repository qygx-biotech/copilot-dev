# Streaming deployment

The Mac app now requests streamed answers for Side Chat and Analyze & Recommend. The FC code calls Requesty with `stream: true` and `stream_options: { include_usage: true }`, assembles streamed tool calls, and forwards answer text through an authenticated SSE connection. Complete answers still pass the existing validation and citation resolution before they are saved or committed. Paper Cards retain their structured generation and quota fallback.

**Uploading this code to an event-handler deployment alone will not enable streaming.** Alibaba documents that Web Functions support SSE; Event and Task Functions do not. The package includes the HTTP server in `src/index.js` and an executable `bootstrap`; the existing `index.handler` remains compatible with buffered clients. An HTTP trigger on an Event Function does not turn it into a Web Function.

On 2026-09-09, the endpoint configured in `docs/app.js` (`https://biodesi-api-dev-jvvowibabk.cn-beijing.fcapp.run/health`) returned `streamingSupported: false`. That identifies the buffered handler path: `/chat` only opens streaming when the HTTP adapter supplies its transport. In that path, the handler deliberately omits Requesty's streaming options and the renderer receives the completed JSON answer. The 12 existing streaming integration tests passed, including actual local HTTP delivery before provider completion, tool calls, cancellation, and buffered-client compatibility. Requesty responses in these tests were mocked; live authenticated model streaming was not tested.

## Console settings

Use the current backend ZIP for an FC **Web Function**. `Archive-beta-users-2026-09-09.zip` already contains the current `src/index.js`, `requesty-stream.js`, `shared/event-stream.js`, and backend handler; another code-only upload to the buffered deployment is insufficient.

For the existing Beijing region, configure:

| Setting | Value |
| --- | --- |
| Function type | Web Function |
| Runtime | Custom runtime, Debian 12 (`custom.debian12`) |
| Official public layer | `Nodejs22`, version 3 (`acs:fc:cn-beijing:official:layers/Nodejs22/versions/3`) |
| Startup command | `/opt/nodejs22/bin/node` |
| Startup arguments | `/code/src/index.js` |
| Listening port | `9000` |
| Timeout | `300` seconds |
| HTTP trigger | Keep POST and OPTIONS enabled, plus GET for health/login checks |
| Environment, RAM role and CORS | Retain the current configuration, including Requesty and JWT settings |

Debian 12 alone does not supply Node.js. Add the official runtime layer, or use a Node.js Web Function template that installs it. The absolute startup command above avoids relying on `PATH`. If the console has a single command field, use `/opt/nodejs22/bin/node /code/src/index.js`. The existing `/code/bootstrap` remains usable with its documented Node.js 20 installation paths or a supported `node` on `PATH`.

Keep the current function's endpoint if FC supports migrating it in place. If a new Web Function is required, retain the existing function until the new endpoint passes health and authenticated streaming checks, then set `ALIBABA_FC_URL` in `docs/app.js` to the new endpoint. Restart `npm run desktop:dev` for development, or rebuild the packaged Mac app. Requesty model/API-key and login environment values do not need to change; a new function needs the same existing values and CORS configuration.

After deployment, `GET /health` must report `"streamingSupported": true`. This confirms the adapter is running; the authenticated check below additionally confirms streaming reaches the client. An event-handler deployment reports `false`. The Mac app accepts both SSE and the previous JSON format, so it remains usable before deployment.

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

References: [Requesty streaming](https://docs.requesty.ai/features/streaming), [Alibaba SSE support](https://help.aliyun.com/en/functioncompute/does-function-compute-support-sse-streaming-response), [custom-runtime environments](https://help.aliyun.com/en/functioncompute/custom-runtime/), [official Node.js 22 layer](https://github.com/awesome-fc/awesome-layers/blob/main/docs/Nodejs22/README.md), [custom-runtime startup](https://help.aliyun.com/en/functioncompute/principles-1).
