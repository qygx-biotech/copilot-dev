# Side Chat equation input validation

Verified locally on `nanobot/sidechat`, 2026-09-20 (America/Toronto).

## Cause and change

The saved request “这张图片里的公式是什么意思？” had a successful Gemma image interpretation containing `\psi`, `\left`, tensor products and a node update equation. `combineQuestion()` JSON-encoded the interpretation inside a text message; the HTTP body then encoded that message again. The backend privacy heuristic considered any leading pair of backslashes a Windows network path. Semantic input validation returned HTTP 400 before calling Requesty.

`shared/chat-images.js` now inserts the normalized interpretation verbatim under an explicit untrusted-image-evidence label, separate from the original request. Only the transport JSON layer encodes the resulting text. The semantic prompt also identifies the original request as the authority for task and answer language. The semantic prompt version is now 8; Paper Card and wiki compatibility versions are unchanged.

`alibaba-fc/semantic-input-privacy.js` recognizes a UNC server/share path with the appropriate separator lengths, including JSON-escaped paths, rather than rejecting a standalone double backslash. LaTeX commands, aligned equations and row separators remain intact. The same check applies to current observations, legacy double-encoded text, semantic conversation context and returned semantic content. It continues to reject private/system absolute paths, Windows drive and UNC paths, file URIs, authorization headers, credential assignments/tokens and embedded PDF material. Math labels do not exempt their contents from the check.

The semantic input validator retains its field allowlists, size limits, candidate identities and scope checks. Validation failures return only a schema field and a static reason code with `attempts: 0` and `failureStage: backend_input_validation`. The client reports these without logging rejected input. Capability resolution, provider rejection/transport, backend returned-content validation and client output validation are distinguishable. The error says answer generation did not start and acknowledges that knowledge maintenance may already have run; it no longer assumes every task is a review.

Conversation transcript storage/replay, the semantic planner, selected-model routing, the five literature layers and tool effect authorization remain in place. Historical equations do not require rewriting saved conversations or regenerating Paper Cards.

## Verification

The fixture `alibaba-fc/test/fixtures/side-chat-equation.json` copies the saved question and exact image interpretation, without attachment paths or project identifiers. The original saved conversation was read only.

`semantic-equations.test.js` reproduces the old false positive and covers natural/escaped LaTeX, multiline equations, row separators, Unicode math, Chinese, current and historical input, UNC/drive/private absolute paths, credentials (including quoted JSON headers), PDF data and oversized input. An authenticated handler fixture passes the saved request through the selected `google/gemma-4-31b-it` planner using `json_object`, validates language and hard paper scope, then runs the existing final answer/transcript loop with a Chinese response. Rejected input makes zero model or model-configuration requests. Separate fixtures distinguish provider rejection from invalid returned content, and verify safe client diagnostics.

Checks completed:

- Full FC regression suite: **816 passed**, including transcript, source protection, recommendation authorization, wiki and corpus regressions.
- Desktop chat-history and renderer/frontend adapter regressions: **27 passed**.
- `npm run desktop:prepare` (asset sync and renderer build), root and FC `check`, privacy-module syntax check, and `git diff --check`: passed.

Provider responses in these tests are fixtures. They verify application behavior and request construction, **not a live Requesty response**.

## Deployment and reload

The development FC health endpoint was checked at approximately 20:22 EDT on September 20. It reported wiki `literature-wiki-markdown-v2`, semantic planner `model-capabilities-v2` and conversation transcript version 1, but **did not report `semanticInputValidation: math-paths-v2`**. This fix is not present in that deployed runtime. Its health response also reports streaming disabled; this change does not alter streaming configuration.

Deploy the updated FC runtime, including **`semantic-input-privacy.js`**, `index.js`, the existing runtime helpers and synchronized `shared` contracts (`npm --prefix alibaba-fc run sync:shared`). Keep the existing model, credentials, handler/runtime and endpoint settings. After deployment, `/health` should include `semanticInputValidation: math-paths-v2`.

Desktop assets were rebuilt locally. The active Electron development process started at 19:31 EDT, before this fix; a renderer reload or app restart is still required to load the new client code. Installed packages require a rebuild/release. No app restart or deployment was performed in this task.

After deployment and reload, repeat the saved image request using the selected Gemma model. Confirm the semantic provider request occurs, language/scope remain correct, and a final Chinese explanation follows. That live Requesty verification remains outstanding.
