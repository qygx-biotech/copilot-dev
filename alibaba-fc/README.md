# BioDesign Copilot Alibaba Function Compute Backend

This folder contains the authoritative cloud gateway for BioDesign Copilot. Electron's authenticated AI traffic uses this route:

```text
docs/ frontend -> Alibaba Function Compute HTTP endpoint -> Requesty
```

Electron never calls Requesty directly. The retired `worker/` implementation contains no Requesty client; Requesty credentials remain in Function Compute environment variables or secrets. The backend validates chat model choices before forwarding them to Requesty.

## Side Chat model selection

The Side Chat selector replaces the former Light/Medium/High control. **Default model** uses the existing `REQUESTY_MODEL`; **Nemotron 3 Nano Omni** sends `nvidia/nemotron-3-nano-omni-30b-a3b-reasoning` through the same FC → Requesty client. The dropdown displays provider/model labels: the default uses the actual `REQUESTY_MODEL` reported by authenticated login/session responses, and NVIDIA is shortened to `nvidia/nemotron-3-nano-omni`. Hover shows the full ID. Older backends without this session metadata use the confirmed `google/gemma-4-31b-it` display fallback in `docs/index.html`; this label does not override the backend model. Authenticated model metadata takes precedence when available. The choice is saved per workspace and captured when a Side Chat turn starts. It applies to every model task triggered by that turn: image understanding, knowledge-sync Paper Cards, semantic interpretation, search planning/reranking, context routing, corpus mapping/repair, native PDF analysis when supported, and the answer/tool loop. Retries inherit the same selection. Agent Command Default and requests without a selection keep their existing role-specific configuration.

No new FC environment variable or API key is needed for this option. Keep the existing `REQUESTY_MODEL` and `REQUESTY_API_KEY`, ensure the Requesty account can access the NVIDIA model, and deploy the updated backend **before** releasing the updated frontend. The answer endpoint receives `model`; preparatory endpoints and their configuration requests receive the validated `X-BioDesign-Chat-Model` header. FC uses a request-local environment copy, never mutating shared configuration. `default` selects `REQUESTY_MODEL` for all tasks in that Side Chat turn. Existing clients that omit the selection keep their configured role models. Arbitrary model overrides are rejected before provider execution or streaming starts.

To make NVIDIA the global default instead, `REQUESTY_MODEL` can be changed to its full ID, but that also changes every capability that falls back to this variable. That is unnecessary for the selector. Future selectable models must be added to the shared `chatModelEnvironment` allowlist in `index.js` and the options in `docs/index.html`; credentials must never be added to the frontend. Local routing tests use mocked Requesty responses and do not certify live model access or tool-calling behavior.

Per-model capabilities continue to use `REQUESTY_MODEL_CAPABILITIES_JSON`. A selected model never inherits PDF support, strict JSON Schema support, or context limits from a different configured model. Existing local/text fallbacks remain in place when a capability is unavailable; the system does not silently substitute another model. Model-dependent configurations, cache keys, and learned input limits are scoped to the selection. Valid saved knowledge and completed workflows remain reusable.

## Required Environment Variables

- `REQUESTY_API_KEY` - Existing admin's Requesty API key. Store this as a Function Compute environment variable or secret, never in frontend code. Beta users use their own mapped key variables.
- `REQUESTY_MODEL` - Requesty model name.
- `REQUESTY_TOOL_MODE` - optional, defaults to `sequential` on both chat surfaces. Only `combined` explicitly enables mixed hosted/local tools for compatibility experiments; errors never switch mode.
- `REQUESTY_SEARCH_PLANNER_MODEL` - optional model for strict search-plan output. Falls back to `REQUESTY_MODEL` when absent.
- `REQUESTY_RERANK_MODEL` - optional model for strict candidate reranking output. Falls back to `REQUESTY_MODEL` when absent.
- `REQUESTY_PDF_MODEL` - optional PDF-capable Requesty model. Configuring it enables PDF capability unless `REQUESTY_PDF_ENABLED=false`. OpenAI PDF models are routed through the required `openai-responses/` prefix without changing the general text model.
- `REQUESTY_PDF_ENABLED`, `REQUESTY_MODEL_SUPPORTS_JSON_SCHEMA`, and `REQUESTY_PDF_SUPPORTS_JSON_SCHEMA` - explicit capability declarations. Combined-text Paper Cards use `json_schema` when declared, otherwise `json_object` with the complete schema in the prompt and the same schema/provenance validation. Missing strict-schema support does not disable text cards. Per-model overrides may be supplied with `REQUESTY_MODEL_CAPABILITIES_JSON`.
- `ADMIN_ACCOUNT` - Existing stable login account used in the authenticated OSS ownership prefix.
- `ADMIN_PASSWORD_HASH` - Existing bcrypt password hash.
- `JWT_SECRET` - Existing JWT signing secret.
- `BETA_USERS_JSON` - Optional JSON array of beta users; see the exact setup below. Omit it or use `[]` to retain admin-only login.
- `REQUESTY_KEY_BETA01`, `REQUESTY_KEY_BETA02`, etc. - Each beta user's own Requesty API key, resolved only from that user's `requestyKeyEnv` field on FC.
- `OSS_BUCKET` - Legacy private OSS bucket used by retained diagnostic/document endpoints.
- `OSS_REGION` - Legacy OSS region ID, such as `oss-cn-beijing`.
- `OSS_INTERNAL_ENDPOINT` - Legacy internal OSS endpoint.
- `OSS_PUBLIC_ENDPOINT` - Legacy public OSS endpoint for signed uploads.

The OSS variables and RAM role are not used by the active local-workspace literature routes. They are still required only if the retained `/api/test-oss` or `/api/documents/*` endpoints must remain operational.

Do not configure permanent Alibaba Cloud AccessKeys for the function. OSS operations use temporary STS credentials supplied by the attached Function Compute RAM role through the Node.js invocation context (with the Function Compute-provided `ALIBABA_CLOUD_*` environment variables as a runtime fallback).

## Sequential hosted search deployment

Deploy **`Archive-task-execution.zip`** to the current FC application and reload/rebuild the desktop client. It includes the existing sequential workflow and metadata handling, explicit original-request preservation, distinct surface prompts, a bounded completion correction and catalog/citation filtering. Keep the existing endpoint, runtime/handler, authentication, model credentials and networking settings. Nothing is deployed automatically, and earlier archives are preserved.

1. Leave `REQUESTY_TOOL_MODE` unset or set it to `sequential`.
2. Upload this ZIP with `index.js` at its root using the existing FC deployment process. For manual packaging include the new `requesty-search-stage.js` alongside all existing runtime helpers, `src`, `shared`, `bootstrap`, dependency manifests and production `node_modules`.
3. Reload/rebuild the updated desktop client. It passes `originalRequest` and preserves it through signed desktop and evidence-recovery continuations. Older continuations predate this binding; begin a new move after updating.
4. Test one web-only query, one authorized search/download move, and one web/local comparison needing evidence recovery. Check `requesty_tool_stage` for one search stage followed by local tools, semantic/request presence and at most one `completion-correction`. `agent_task_outcome` must distinguish actual save results from blocked/incomplete work; resumes must retain search status and avoid repeating downloads. Verify actual paths and MIME types before treating a requested PDF download as fulfilled.

Sequential requests never mix `{type:"web_search"}` and functions or send Google's unverified `toolConfig` flag. Only `web`/`both` semantic scope requests a search stage; missing/legacy scope remains conservative. Both stages retain the selected model and authenticated user's Requesty key. Search findings and actual citations cross the boundary as bounded untrusted evidence; raw hosted protocol traces do not. Existing local tools, permissions, downloads and knowledge ingestion remain in their current owners. See [request shapes, recovery and limitations](../docs/WEB_SEARCH_AND_SOURCE_DOWNLOAD.md).

The retained `REQUESTY_TOOL_MODE=combined` mode explicitly opts into the previous implementation and its unverified Google native-field passthrough. It is never a fallback. Verification uses mocked providers; no live Requesty behavior is certified by this deployment archive.

### Diagnosing missing web-search citations

First inspect `semantic-intent.success` for `retrievalScope`, `patternShortcutCleared`
and `objectAliasesNormalized`, then the desktop `retrieval.decision` and
`main-agent.started` scope. A successful provider generation can still fail host
validation; the reported search/store composition formerly did so because of its
optional search-only pattern. The shared normalizer now preserves the validated
composition instead of falling back to workspace retrieval.

Agent Command resolves local citations through the same verified source registry
as Side Chat. Complete supplied handles are required; bare ordinal IDs are never
guessed. The reranker sends a small wire schema, with all original bounds enforced
by FC, consistent with [Google's guidance to validate structured values in the application](https://ai.google.dev/gemini-api/docs/structured-output).
`knowledge_rerank_failed` records model, provider status/code and an explicit-schema
compatibility flag. The reported generic `INVALID_ARGUMENT` does not establish
the rejected field; no automatic model switch or blind retry is added.

An assistant message with Markdown links does not establish that structured search metadata reached FC. The shared normalizer supports Requesty's documented `choices[].delta.web_search`, annotations/citations, native Google `candidates[].groundingMetadata`, and grounding inside `extra_content.google` on response/message/delta envelopes. The native extensions are compatibility coverage, not a claim that every Requesty route returns them. [Requesty's current response example](https://docs.requesty.ai/features/web-search) describes structured streaming metadata; [Google's response reference](https://ai.google.dev/api/generate-content#groundingmetadata) describes native grounding.

After a fresh search move, inspect **FC logs** for `requesty_web_search_response`. The event records actual `transport` (`sse`/`json`), `requestedStreaming`, `sourceCount`, `retainedMetadataCount`, bounded `metadataPaths`/types, known `containerPaths`, and `metadataStatus`. No source values, text, URLs, signatures, keys or headers are logged.

- `sources_available`: provider source URLs were extracted. If the handoff still shows an empty list, investigate the stage merge/continuation rather than model instructions.
- `metadata_without_usable_urls`: recognized metadata exists but yields no usable URLs; check empty/malformed fields or metadata size limits. This does not test downloadability.
- `no_recognized_metadata`: no recognized citation fields were observed. This can mean Requesty/provider omitted metadata, search was not invoked, or an unsupported response shape was returned. A dashboard's assistant-only view cannot distinguish these. Compare the raw response at the gateway with the documented format before changing provider transport or promoting text links into citations.

`no_sources` is retained for compatibility but now explicitly describes a citation-metadata gap. It never means that a PDF does not exist or that a download failed. Text-only links remain unverified. Landing pages and Google's grounding redirects are not guaranteed PDF links; only actual download results establish content type/availability. The research prompt requests concrete papers relevant to the current task, rather than replacing discovery with a project roadmap. There is no automatic search retry, Markdown citation extraction, provider switch, or download triggered by prose.

## Agent panel model selection

The middle Agent panel adds `google/gemini-3.1-flash-lite:flex` alongside Default and Nemotron. The selected model is captured per move and sent as `model` in `POST /chat` with `mode: "agent_instruction"`. FC validates it using the same request-local model abstraction, and sends that exact ID in Requesty Chat Completions for every answer/tool-loop turn, including streaming and signed desktop download continuations. Default/older clients retain the configured answer model. Changes during a run apply to the next move.

The Gemini 3.1 update is packaged in `Archive-gemini-3.1-flash-lite.zip`. Deploy this archive to the current FC application and reload the client together. Saved Agent selections of Gemini 2.5 migrate to Gemini 3.1; historical messages retain their original model metadata.

The subsequent capability update is packaged in `Archive-gemini-capabilities.zip`; use this newer archive to enable Gemini's confirmed hosted-search and JSON-schema defaults. Reload the client for the accompanying Side Chat scope isolation fix.

The semantic-intent compatibility update is packaged in `Archive-semantic-intent-planner.zip`, superseding those archives. It adds a separate conservative LLM schema, canonical IR validation, and one JSON-object retry only for positively identified output-schema errors. Include the new `semantic-intent-planner.js` runtime module when packaging manually. Optional `REQUESTY_SEMANTIC_PLANNER_PROFILE=gemini|openai` settings reuse the same planner; OpenAI also requires `REQUESTY_SEMANTIC_OPENAI_MODEL`. Explicit UI model choices still take precedence. See [Semantic intent through Requesty](../docs/SEMANTIC_INTENT_PLANNER.md) for request shape, capability overrides, diagnostics and limitations.

The subsequent routing correction is packaged in `Archive-retrieval-scope-routing.zip`. Semantic `retrievalScope` is authoritative: external discovery bypasses local lexical/QMD retrieval, while workspace/both retain it. `search_papers` keeps its existing local meaning. See [Retrieval scope](../docs/RETRIEVAL_SCOPE.md).

`Archive-gemini-combined-tools.zip` supersedes that archive for the Gemini combined-tool correction. It adds native `toolConfig.includeServerSideToolInvocations` as an extra Requesty body field for mixed tools on the selected Gemini 3.1 Flex model and preserves returned tool context across streaming/local-tool continuations. Include `requesty-tool-context.js` when packaging manually. Requesty's public schema does not explicitly document forwarding this Google flag, so a live deployed test is still required; a gateway rejection is reported as `GEMINI_COMBINED_TOOLS_UNSUPPORTED`. See [Gemini combined tools](../docs/WEB_SEARCH_AND_SOURCE_DOWNLOAD.md#gemini-combined-tools). Deploy to the current FC application; this correction requires no new client changes.

Transport references: [Requesty extra body fields](https://docs.requesty.ai/frameworks/vercel-ai-sdk), [Requesty hosted web search](https://docs.requesty.ai/features/web-search), and [Google tool combination](https://ai.google.dev/gemini-api/docs/generate-content/tool-combination). Extra-body support does not by itself establish that a specific native provider option survives gateway translation.

An explicit Agent selection also travels through `callContext.model` and the existing `X-BioDesign-Chat-Model` header to preparation, wiki updates, semantic interpretation, planning/reranking, corpus workers and evidence recovery. These tasks use the same selected model and its own capability configuration. Agent Default and requests without a selection retain their configured role models. Gemini Flex is an Agent-only option; Side Chat selection and download permissions are unchanged. Gemini 3.1 Flex has confirmed `supportsWebSearch: true` and `jsonSchema: true` defaults in `requesty-models.js`; explicit per-model entries in `REQUESTY_MODEL_CAPABILITIES_JSON` can override them. Other models retain metadata-based search gating. Deploy the updated FC backend before using the new client selection, and ensure the user's Requesty account can access this model. Tests mock provider responses; live model access has not been verified.

For troubleshooting, the FC `chat_model_selection` log records the requested and resolved answer model, and `/chat` returns the actual request model as `model`. The client debug log includes the requested model at `main-agent.started` and the FC-reported model at `main-agent.completed`. Requesty metadata already tags each call by role (for example `biodesign:semantic_parser` or `biodesign:answer`) and turn ID, so preparation can be distinguished from the final answer.

The model-propagation fix is available in `Archive-agent-model-selection.zip`. Upload it to the current FC application using the existing handler/runtime, and reload or rebuild the updated client. It includes all runtime helpers and production dependencies; the previous `Archive.zip` remains untouched.

## Multi-user beta login

The existing account/password screen requires no frontend change. A beta user enters their chosen `account` and **original password**. FC compares it against that user's bcrypt `passwordHash`; the hash itself is not a login password. The existing `ADMIN_ACCOUNT`, `ADMIN_PASSWORD_HASH`, `JWT_SECRET`, and `REQUESTY_API_KEY` retain their roles. The admin's stable ID is `admin`; beta users have role `beta` and a configured stable ID.

New 12-hour HS256 JWTs contain only `id`, `sub` (the same stable ID), `account`, `role`, `iat`, and `exp`. Login and `/api/me` return only public user identity and the existing `chatModel` metadata, plus the token at login. Password hashes, key mappings and Requesty keys are never returned. Existing admin JWTs without IDs remain accepted until expiry if their account matches the configured admin.

FC validates the beta configuration and rechecks the token's ID, account and active status on **every authenticated request**, including `/api/me`, images, configurations, legacy document routes and Agent Command. Removing a user or setting `active: false` rejects their next request even before JWT expiry. Changing an account or ID also invalidates its existing tokens. Each invocation snapshots FC configuration; an already-running invocation retains its starting configuration.

The user's key is placed in an invocation-local environment copy before model selection. All provider work inherits it: semantic interpretation, schema mapping, planning/reranking, Paper Cards and literature processing, corpus and native-PDF workers, image understanding, document review, repairs/retries, answer/tool loops and streaming. Side Chat and Agent Command capture their selections independently for every model task in the turn; Agent Default keeps its configured role models. Client body/header fields cannot select another identity or key. Existing account-based OSS ownership and local workspace/history behavior remain intact.

### Configure the first beta user on FC

1. Keep the existing FC values for `ADMIN_ACCOUNT`, `ADMIN_PASSWORD_HASH`, `JWT_SECRET`, `REQUESTY_API_KEY`, `REQUESTY_MODEL`, model capability/role settings, and any existing OSS settings. Do not replace the admin key with a beta user's key. `JWT_SECRET` remains one shared server secret.
2. Choose an account name, stable ID such as `beta01`, and original password. Generate a bcrypt hash locally from that original password. This command prompts without echoing the password and avoids placing it in shell history or command arguments (requires Python 3 and installed backend dependencies):

   ```sh
   cd '/Users/wei/Documents/Columbia University/PhD/AI4S/Dev/alibaba-fc'
   python3 -c 'import getpass,sys; sys.stdout.write(getpass.getpass("Beta password: "))' |
     node -e 'let p=""; process.stdin.setEncoding("utf8"); process.stdin.on("data",s=>p+=s); process.stdin.on("end",async()=>console.log(await require("bcryptjs").hash(p,12)));'
   ```

   Use a password of at most 72 UTF-8 bytes; bcrypt only uses its first 72 bytes. Preserve intentional password spaces. Copy the complete 60-character hash, including its `$` characters.
3. In the FC function's environment variables, add **`REQUESTY_KEY_BETA01`** with the actual Requesty key belonging to this beta user. Store the secret value only on FC. Ensure that Requesty account has access to the configured models and any selected Side Chat models.
4. Add **`BETA_USERS_JSON`** with the following JSON, replacing the hash placeholder with the generated hash. Paste the JSON directly into the FC value field, with no Markdown fences or surrounding shell quotes:

   ```json
   [
     {
       "id": "beta01",
       "account": "example-user",
       "passwordHash": "<bcrypt hash>",
       "requestyKeyEnv": "REQUESTY_KEY_BETA01",
       "active": true
     }
   ]
   ```

   Save the matching key variable and JSON together. Do not put the actual Requesty key inside the JSON, frontend, repository or ZIP.

### Validation and adding another user

All five fields are required, and unknown fields are rejected. `active` must be the JSON boolean `true` or `false`. IDs must match `[A-Za-z0-9][A-Za-z0-9_-]{0,63}`; `admin` is reserved. Accounts must be nonempty, at most 128 characters, with no leading/trailing whitespace or control characters. IDs/accounts must be unique without regard to case; account uniqueness also uses Unicode NFKC normalization to match the existing OSS ownership boundary. A beta account cannot alias `ADMIN_ACCOUNT`.

Hashes must be canonical 60-character bcrypt `$2a$`, `$2b$` or `$2y$` values with a valid cost (the command above uses cost 12). Key variable names must match `REQUESTY_KEY_[A-Z0-9][A-Z0-9_]{0,63}` and be distinct for each configured user. Mapping to `REQUESTY_API_KEY`, `JWT_SECRET`, arbitrary environment names or inline keys is rejected.

To add another user, generate their hash, set **`REQUESTY_KEY_BETA02`** to their own key, and append a second object to the existing `BETA_USERS_JSON` array:

```json
{
  "id": "beta02",
  "account": "another-user",
  "passwordHash": "<second bcrypt hash>",
  "requestyKeyEnv": "REQUESTY_KEY_BETA02",
  "active": true
}
```

Keep existing rows and IDs. No backend rebuild is needed to add, disable or remove users. To disable a user, set their `active` to `false` or remove their row and save the FC configuration. To rotate a Requesty key, replace the value of that user's mapped FC variable; their next request uses the new value. Keep IDs and accounts stable and do not reassign a former user's identity to a different person, since account names still determine legacy OSS ownership.

Malformed JSON/configuration returns HTTP 500 with `Invalid BETA_USERS_JSON configuration.` and blocks authenticated use, including admin use, until corrected. An absent variable or `[]` is valid; a blank string is malformed. Invalid passwords and inactive/removed users return HTTP 401. An otherwise valid beta user whose mapped key is missing, empty or contains whitespace gets HTTP 503 `BETA_REQUESTY_KEY_MISSING` at login and on protected requests. This never falls back to the admin key; other properly configured users remain usable. Disabled users may have their key removed while their valid inactive row remains.

### Deploy the tested beta backend

The supplied package is **`alibaba-fc/Archive-beta-users-2026-09-09.zip`**, with a matching `.zip.sha256` checksum and `.manifest.json` file listing every archived file's SHA-256. `alibaba-fc/Archive.zip` is preserved. The package contains the tested root handler, streaming/image helpers, HTTP adapter, shared contracts, executable `bootstrap`, dependency manifests and production `node_modules`; it contains no environment files or credentials.

1. Upload `Archive-beta-users-2026-09-09.zip` as the function code ZIP with `index.js` at its root. Keep the current endpoint, trigger, CORS, role, memory and timeout settings.
2. Keep the existing runtime mode. For a built-in Node.js 20 event function, retain handler **`index.handler`**. For an existing streaming custom runtime, retain **`/code/bootstrap`** and listening port **`9000`**. The ZIP supports both; see [streaming deployment](STREAMING_DEPLOYMENT.md) if changing runtime modes separately.
3. Save the FC variables from the steps above. No frontend deployment or desktop rebuild is required for beta login.
4. Verify admin login and a normal Side Chat answer. Then log in as `example-user` using the original password; test Side Chat with Default and the alternate model, image understanding, literature preparation, and Agent Command. Verify usage in the corresponding Requesty accounts. Local tests mock Requesty/OSS and do not certify live model entitlement or FC configuration.
5. Test revocation with a beta session: set its `active` to `false` and save. `/api/me` and the next protected request must return 401. Re-enable the user when finished. Check that the admin still works.

Nothing in the local implementation or packaging process deploys code or changes live secrets. The FC upload and configuration steps above are manual.

## Local Testing

The deployed handler and PDF parser require Node.js 20 or newer.

```bash
cd alibaba-fc
npm ci
npm run check
npm test
```

## Manual Alibaba Cloud Function Compute Deployment

For live streamed answers, use the [streaming deployment instructions](STREAMING_DEPLOYMENT.md). Streaming requires the included HTTP server on an FC custom runtime. The built-in Node.js deployment below continues to return buffered JSON.

1. Create a Function Compute service and function in Alibaba Cloud.
2. Choose a Node.js 20 runtime.
3. Create an HTTP trigger for the function.
4. Use this handler setting:
   - `index.handler`
5. Set the environment variables required by login and AI requests:
   - `REQUESTY_API_KEY`
   - `REQUESTY_MODEL`
   - `ADMIN_ACCOUNT`
   - `ADMIN_PASSWORD_HASH`
   - `JWT_SECRET`
   Keep the four `OSS_*` variables as well only when deploying the retained legacy OSS endpoints.
6. If legacy OSS endpoints remain enabled, attach the existing `BioDesignCopilotFCRole` execution role to the function. Do not add long-lived AccessKey values.
   In addition to its existing `GetObject` and `PutObject` permissions, its custom policy must allow prefix listing if the legacy document-list route is retained:

   ```json
   {
     "Effect": "Allow",
     "Action": "oss:ListObjects",
     "Resource": "acs:oss:*:*:biodesign-copilot-files-2026",
     "Condition": {
       "StringLike": {
         "oss:Prefix": ["uploads", "uploads/*"]
       }
     }
   }
   ```

   `ListObjects` uses the bucket itself as the RAM resource; the `oss:Prefix` condition restricts the listable scope. Legacy application authentication further narrows every request to the current account's exact hashed prefix.

   The legacy object-level statement must include `oss:GetObject`, `oss:PutObject`, and `oss:DeleteObject` on `acs:oss:*:*:biodesign-copilot-files-2026/uploads/*` if those old endpoints remain deployed.
7. Install production dependencies, synchronize the shared retrieval contract, and package the root handler with `node_modules`:

   ```bash
   cd alibaba-fc
   npm ci --omit=dev
   npm run sync:shared
   zip -r ../alibaba-fc-local-workspace.zip ./*.js src shared bootstrap package.json package-lock.json node_modules
   ```

8. Upload `alibaba-fc-local-workspace.zip`. Keep the handler set to `index.handler`.
9. The local-workspace routes process one bounded chunk per invocation and a separate bounded synthesis request. Keep the existing memory and timeout settings; the legacy server-side OSS review still benefits from 1 GB memory and a 300-second timeout.
10. Keep the existing HTTP-trigger CORS origin for the GitHub Pages frontend.
11. The local-workspace flow does not require OSS bucket CORS. Keep the old rule only if the retained legacy signed-upload endpoint is still in use elsewhere.
12. Set the public HTTP endpoint in `FC_ENDPOINTS` in `shared/backend-config.js`, select `FC_ENVIRONMENT`, and run `npm run desktop:prepare` from the repository root. The same configuration controls renderer API calls and desktop source-download fallback. Restart/rebuild the client after switching; sign in again for the selected deployment. There is no production provider switch or direct Requesty fallback in Electron.
13. Publish the updated `docs/` directory through the existing GitHub Pages deployment.

No production dependency was added for the local-workspace routes. The existing `unpdf@1.8.0` dependency remains for the retained legacy OSS PDF review path.

## Literature shortlist validation and recovery

Semantic LLM interpretation remains the first model call for a new request. Agent Command literature acquisition uses the accepted semantic route, then plans, searches, selects and downloads. The paper MCP server remains a local bundled Electron process; the FC harness coordinates model calls and signed desktop tool continuations. Existing PDF cards are not a prerequisite for online acquisition.

`plan_literature_search` returns `coverage_topics` containing deterministic host IDs and readable labels. The next `select_literature_papers` schema constrains `covers` to those IDs with an enum generated from the accepted plan. Older v2 continuation plans are migrated lazily, and exact old subtopic labels remain valid inputs. Labels are never fuzzy-matched; unsupported coverage requires a reasoned correction, an empty `covers` array, or exclusion. Already-issued v1 continuations retain their original download behavior.

Plan-result compaction reconstructs a complete historical acceptance receipt from the host plan, preserving its IDs, labels and query/date/count constraints. Current required next steps and validation corrections live in fresh workflow-state messages, so a later error never appears as the original plan's instruction. The recorded plan is no longer advertised as a callable tool. Search-result compaction preserves complete JSON, every returned paper handle, cursor and provider status. A bounded candidate catalog supplies the current inspected pool with explicit abstract availability and supported evidence types. Fuller metadata is requested by paper handle, not by replaying a search. Signed continuations retain result membership to repair previously truncated results; older continuations without that index explicitly report unknown historical membership and use the current catalog. Selection, download and validation-error receipts also retain complete JSON.

Search input normalization removes exact duplicate query strings, including `query` repeated in `queries`, without trimming, case-folding, rewriting or dropping distinct searches. Empty normalized `queries` is omitted. Existing query counts, provider/query job limits and field limits are validated afterwards. Invalid inputs identify the field, invalid value and required correction. `INVALID_ACADEMIC_INPUT` searches participate in bounded recovery, including desktop-returned failures; accepted corrected inputs release the gate so searching, selection and authorized saving can continue. An opaque desktop validation failure is reported as an argument-level blocker when its specific field cannot be established.

The normal literature sequence is plan → collect candidate pool → select → download. Initial local MCP searches return up to the existing 20-paper response limit from the already collected, deduplicated cache, even if the model supplies a smaller `limit`. The existing 65,000-character paper-batch cap may return fewer. This consumes no extra provider requests and retains the shared 35-second provider deadline, provider/query limits, 120-candidate workflow cap and global call/time budgets. Explicit cursor requests still use their original `limit` and all original search parameters. A `next_cursor` never forces a preliminary shortlist rejection or another search; additional queries/pages are optional when relevance, evidence, requested count or topic coverage is insufficient. Older signed continuations waiting on `INSPECT_NEXT_PAGE_BEFORE_SELECTION` or `UNINSPECTED_CANDIDATES_REMAIN` are released to revalidate selection; real cursor-input, evidence and coverage errors remain enforced. `sources_exhausted` expresses the model's assessment of the inspected pool, not exhaustion of every provider record.

Validation errors carry the offending paper/value, allowed IDs and labels, and the required correction. Shortlist validation reports semantic violations across all rows together and leaves the accepted selection unchanged until the whole batch is valid. The harness supplies those errors on bounded recovery turns and suppresses identical failed tool calls before dispatch or tool-budget charging. Each unresolved episode allows at most two identical retries, four validation failures, or three recovery model turns. Resolving an issue such as pagination resets that episode's allowance; lifetime counters remain available for diagnostics, and the overall eight-model-turn / 24-tool-call limits stay unchanged. Fresh metadata that repairs missing abstracts permits revalidation, including unchanged shortlist arguments; empty refreshes preserve known evidence. Pagination errors provide `required_tool_call` with the returned cursor and original search parameters. Repeating an initial query, changing cursor parameters, failed responses and non-advancing cursors do not count as inspecting the next page.

An accepted shortlist permits the already-authorized download to continue automatically, subject to existing workspace permissions. Internal validation never creates a user-approval requirement. On exhausted recovery, host-generated output retains the concrete blocker, all reported paper violations and the stopping limit, and separately reports search candidates, accepted selections and successfully saved files. Provider failures during correction are reported alongside the original blocker.

Final literature messages preserve the assistant's `reply`, including its language, lists and explanations. The harness does not replace it with a download summary or append selection reasons/gaps. Verified execution counts and paths remain in `taskOutcome`/`downloadResults`; assessment details remain in `academicSelection`. A factual host fallback is used only when no final reply is available, including exhausted validation recovery. Known online `paper_ref` citations render as links derived from host metadata rather than unresolved workspace citations. Code examples and unrelated local-source citation behavior are preserved. `test/academic-reply.test.js`, the production desktop-flow tests and the Electron Agent Work fixture cover response, display and saved-history consistency.

An empty provider response during literature download recovery is detected from assistant content and usable function calls, independently of finish reason or token usage. The harness allows one corrective model turn within the remaining step/tool/time budgets, using the fresh host candidate catalog and existing selection/download validation. The allowance and last usable reply survive signed continuations. If recovery stays empty or a budget is exhausted, the previous reply and verified saved files are returned with an incomplete recovery status; without a reply, the host generates a factual summary. `taskOutcome.emptyResponseRecovery` records the stopping limit and allowlisted finish reason, request ID, numeric usage and provider codes. Credentials, prompts and arbitrary provider error prose are excluded. `test/academic-empty-recovery.test.js` exercises the production harness and Requesty JSON/SSE adapter with controlled responses.

Regression coverage is in `test/academic-shortlist-recovery.test.js`, `test/academic-search-recovery.test.js`, `test/academic-evidence-recovery.test.js`, `test/academic-candidate-pool.test.js` and `test/academic-desktop-flow.test.js`. Coverage includes optional cursor correction followed by several missing abstracts, batch and incremental correction through real temporary PDF saves, metadata repair, identical retries and malformed historical search results. Candidate-pool integration tests run the production harness, signed continuations, desktop execution and real stdio MCP with controlled provider workers, including deduplication, size limits, optional paging/search and direct selection/download despite a remaining cursor. Those stdio cases require the Python build environment installed by `paper:build`; host-only cases run without it. The desktop flow additionally exercises semantic routing, the production renderer and authenticated FC handler. These controlled model/MCP tests do not measure live provider availability or model quality. Include all root JavaScript modules, including `academic-recovery.js` and `academic-context.js`, when packaging the FC handler, and run `npm run sync:shared` for the shared validator. Electron preparation also synchronizes this shared contract for desktop builds; rebuilding Electron alone does not update the FC harness.

## Local-Workspace Literature Endpoints

Paper Card output follows [Requesty's structured-output contract](https://docs.requesty.ai/features/structured-outputs): strict mode sends the raw canonical schema in `response_format.json_schema`, with `strict: true`; the fallback sends `response_format: {type: "json_object"}` and includes that complete schema in the system prompt. Both modes validate field types, required fields, extra keys and exact source identity before returning a card. The Electron host also verifies quoted page evidence before persisting reusable evidence findings. The mode is included in the provider configuration signature, so a changed output contract cannot reuse an incompatible cached card. A model-support flag controls decoding mode rather than whether cards are available.

The obsolete `.biodesign/literature/cache` directory is no longer created when initializing or opening a workspace. Parsed source caches live in `.biodesign/sources/artifacts`; canonical cards still live in `.biodesign/literature/summaries`. Existing legacy-file cleanup remains for older workspaces.

The source-worker endpoints require the existing JWT bearer token and are stateless with respect to project storage:

- `GET /api/knowledge/config` returns opaque planner/ranker configuration signatures plus prompt/schema versions for deterministic client-cache invalidation. It never returns a model name or secret.
- `POST /api/knowledge/plan-search` accepts only a bounded query and retrieval intent, and returns strict JSON containing validated lexical queries, exact identifiers, source language, and a short interpretation summary.
- `POST /api/knowledge/rerank` accepts only the original query/intent plus bounded opaque candidate IDs, titles, evidence handles, and snippets. It returns strict ranked IDs, finite scores, and bounded reasons. Duplicate or unknown IDs are rejected.
- `POST /api/literature/summarize-chunk` accepts one extracted-text chunk, its bounded index/count, language, and filename.
- `POST /api/literature/synthesize` accepts bounded chunk summaries plus minimal source metadata and returns the structured content used by a local Paper Card.
- `POST /api/corpus/map-paper` accepts one bounded question plus up to eight evidence excerpts for one paper and returns a host-validated, query-specific map note with only supplied evidence references. It requests strict Requesty `json_schema` output when advertised and falls back to `json_object` plus the same host validation.
- `POST /api/literature/analyze-pdf-native` accepts one bounded task and one private base64 PDF (20 MB maximum), sends Requesty Chat Completions an `input_file` block, and returns a validated derived paper analysis or corpus map. It never accepts or creates a public URL.

Every route above reuses the existing login/JWT validation, CORS policy, Requesty helper, structured-output validation, bounded transient retries, logging, and error sanitization. Text-endpoint HTTP 429 responses return to the client scheduler with their provider status and reset delay instead of retrying early in FC. Include `shared/provider-rate-limit.js` in the deployment ZIP. The knowledge routes reject unknown input/output keys. They use values imported from `shared/retrieval-contract.js`, which centralizes the pre-existing Electron/QMD/context limits without changing them.

None of these routes accepts an OSS key, a directory handle, or a project folder, and none reads or writes OSS. The planning route receives no evidence. The reranking route rejects absolute paths, bearer/JWT-like content, PDF data, and requests beyond the existing aggregate context/request budgets. Candidate IDs and evidence handles are non-authoritative references; Electron reconstructs every final result from its local candidate object. The native-PDF route accepts PDF bytes only as an authenticated, request-scoped base64 data URI; filenames are reduced to their basename and raw PDF content is not logged.

Function Compute requests Requesty's strict `json_schema` response mode when the configured model advertises it, otherwise it uses `json_object` plus the identical host-side schema validation. Malformed structured output, chain-of-thought fields, duplicate IDs, hallucinated IDs, and out-of-range or non-finite scores fail closed. Sanitized errors never disclose credentials, model configuration, prompts, or provider response bodies.

The existing authenticated `POST /chat` route also accepts an optional bounded `localWorkspaceContext` object from the frontend. Function Compute whitelists its compact source map, hard paper/experiment scopes, coverage, project summaries, metadata-only inventory, processed evidence, and limitation notices. The complete Project context / goal is placed in its own durable system message before the workspace catalog, conversation, or Agent Work evidence. The response includes `localWorkspaceFilesUsed` and `localWorkspaceScope` for diagnostics. This route still uses the existing Requesty configuration and does not persist the context.

### Local Paper Cards and routing

Workspace open and Refresh synchronize only cheap file metadata; they perform zero content hashes, PDF parses, workbook parses, or LLM calls. A selected or automatically matched paper is hashed and parsed lazily through the browser's shared source-readiness service. A Paper Card is optional and is generated only when a broad summary/comparison benefits from it or the card operation is explicitly requested. Cards remain at `.biodesign/literature/summaries/<source_id>.json` for compatibility and are keyed in the new source registry by content hash, schema, model, and prompt version. Changed and deleted sources immediately lose their ready association, while unchanged cards are reused.

Workspace-tree selections map to stable paper and experiment source IDs. Explicit selections define hard tool scopes. With no paper selection, ready metadata and content indexes are searched first, cheap metadata identifies likely unprepared candidates, and only candidates are prepared. Precise answers use original page/chunk evidence; Paper Cards can aid broad interpretation but are never the sole evidence. Experiment CSV/XLS/XLSX/TSV/TXT files are normalized lazily into bounded structured records with raw values and file/sheet/range provenance. Retrieved evidence is request-scoped and is not copied into persistent conversation history.

Side Chat and Agent Work both use the same bounded model-driven tool loop in `side-chat-agent.js`; only authorization and final response parsing differ. Informational and internal-state effects are shared. Side Chat receives a structured denial for official result-producing actions such as `update_recommendation`; Agent Command retains its existing recommendation commit path. The server cannot open the browser's local folder, so source preparation and state persistence remain in the shared browser service and server tools inspect only request-scoped evidence.

When a PDF-capable model also supports schema output on the same request, native PDF analysis uses strict `json_schema` directly. Otherwise it performs native PDF analysis first and a second schema-constrained extraction call (or `json_object` with host validation when schema output itself is unavailable). The default literature path remains local parsed retrieval; native PDF is selected only for whole-paper/layout-sensitive work or bounded recovery.

Example smoke test after obtaining `TOKEN`:

```bash
curl -sS -X POST "$FC_URL/api/literature/summarize-chunk" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"filename":"paper.pdf","chunkIndex":0,"totalChunks":1,"language":"en","text":"Extracted machine-readable paper text..."}' \
  | jq

curl -sS -X POST "$FC_URL/api/literature/synthesize" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"filename":"paper.pdf","size":1234,"lastModified":1780000000000,"pageCount":1,"language":"en","chunkSummaries":[{"summary":"Chunk summary","researchQuestion":null,"methods":null,"keyResults":[],"limitations":[],"mainConclusion":null}]}' \
  | jq
```

## Endpoint Tests

Health check:

```bash
curl https://your-alibaba-fc-endpoint/health
```

Chat request:

Use a `TOKEN` returned by the existing `/api/login` flow (the complete login command is shown below).

```bash
curl -X POST https://your-alibaba-fc-endpoint/chat \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"messages":[{"role":"user","content":"Help draft a lactose biosensor project memo."}]}'
```

Expected `/chat` response shape:

```json
{
  "reply": "string",
  "project": {
    "summary": "string",
    "organism": "string",
    "missingInformation": ["string"],
    "safetyLevel": "string",
    "safetyNotes": "string",
    "draftMemo": "string"
  }
}
```

## Temporary OSS Write/Read Test

`POST /api/test-oss` uses the existing JWT bearer authentication. It writes a timestamped text object under `test/`, reads it back, compares the content, and deliberately leaves the object in OSS for console inspection.

After deployment, log in with the existing admin account and call the endpoint:

```bash
FC_URL="https://your-alibaba-fc-endpoint"
TOKEN=$(curl -sS -X POST "$FC_URL/api/login" \
  -H "Content-Type: application/json" \
  -d '{"account":"your-admin-account","password":"your-admin-password"}' \
  | jq -r '.token')

curl -sS -X POST "$FC_URL/api/test-oss" \
  -H "Authorization: Bearer $TOKEN"
```

The successful response includes `"ok":true`, `"verified":true`, and the generated object key. Then open `biodesign-copilot-files-2026` in the Alibaba OSS console and inspect the `test/` prefix. The endpoint does not delete the object.

## Persistent PDF Upload and Review

The PDF workflow uses the existing JWT bearer login and these document endpoints:

- `GET /api/documents` lists up to 100 PDFs and any cached review sidecars from the authenticated account's application-controlled OSS prefix. The frontend calls it after login and session restoration.
- `POST /api/documents/upload-url` validates a PDF name and size, creates an application-controlled key under the authenticated account prefix, and returns a five-minute OSS V4 signed PUT URL.
- `POST /api/documents/review` runs only after an explicit user action. It reviews an owned PDF and caches the structured result as `.paper-review.json` in the same UUID folder. A repeated request returns that cache unless `force: true` is supplied.
- `POST /api/documents/delete` permanently deletes the owned PDF and its cached review sidecar.
- `POST /chat` receives a PDF inventory, summary-availability flags, up to three selected keys, and bounded recent user/assistant history. Side Chat accepts normal plain-text model replies instead of requiring the full recommendation JSON schema. It uses cached summaries for relevance routing, reads full text only for explicit/relevant PDFs, and uses summary map-reduce for large collection-wide questions. One short retry is attempted for transient HTTP 408, 425, 429, and 5xx Requesty responses.

For the active local-workspace flow, `/chat` receives locally prepared cached summaries or bounded source excerpts through `localWorkspaceContext`; it does not receive a directory handle, arbitrary local path access, original PDF bytes, login password, JWT, API key, or Alibaba credential in the JSON body. The Authorization header continues to carry the existing JWT independently.

The browser never selects a bucket or object path. Keys have this form:

```text
uploads/<sanitized-account-and-hash>/<uuid>/<sanitized-filename>.pdf
```

PDFs are uploaded to OSS immediately rather than waiting for logout or `beforeunload`, which browsers cannot reliably complete. Upload does not invoke Requesty. While a PUT is active, the UI prevents logout and warns before closing the window. PDFs are limited to 5 MB and 100 pages. Reviews process at most 96,000 extracted characters in overlapping 12,000-character chunks. Encrypted, malformed, empty, and likely image-only PDFs return controlled errors. OCR is not included. Removing a file is permanent and cannot be recovered by this application.

### Manual end-to-end test

Set the endpoint, credentials, and a machine-readable PDF path locally:

```bash
FC_URL="https://your-alibaba-fc-endpoint"
ADMIN_ACCOUNT="your-admin-account"
PDF_PATH="/absolute/path/to/paper.pdf"

TOKEN=$(curl -sS -X POST "$FC_URL/api/login" \
  -H "Content-Type: application/json" \
  -d "{\"account\":\"$ADMIN_ACCOUNT\",\"password\":\"your-admin-password\"}" \
  | jq -r '.token')

PDF_SIZE=$(wc -c < "$PDF_PATH" | tr -d ' ')
UPLOAD_RESPONSE=$(curl -sS -X POST "$FC_URL/api/documents/upload-url" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"filename\":\"$(basename "$PDF_PATH")\",\"contentType\":\"application/pdf\",\"size\":$PDF_SIZE}")

OBJECT_KEY=$(printf '%s' "$UPLOAD_RESPONSE" | jq -r '.objectKey')
UPLOAD_URL=$(printf '%s' "$UPLOAD_RESPONSE" | jq -r '.uploadUrl')

curl -sS -X PUT "$UPLOAD_URL" \
  -H "Content-Type: application/pdf" \
  --upload-file "$PDF_PATH"

curl -sS -X POST "$FC_URL/api/documents/review" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"objectKey\":$(printf '%s' "$OBJECT_KEY" | jq -R .),\"language\":\"en\"}" \
  | jq

curl -sS "$FC_URL/api/documents" \
  -H "Authorization: Bearer $TOKEN" \
  | jq

curl -sS -X POST "$FC_URL/chat" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"mode\":\"side_chat\",\"messages\":[{\"role\":\"user\",\"content\":\"What are this paper's main limitations?\"}],\"storedDocuments\":[{\"objectKey\":$(printf '%s' "$OBJECT_KEY" | jq -R .)}]}" \
  | jq
```

Expected review output includes `"ok": true`, `"summaryCached": true`, a non-empty `summary`, and the original `objectKey`. The list response must contain that key with `"summaryAvailable": true`. These OSS document endpoints are retained for compatibility tests; the active Workspace explorer and Side Chat local-file flow do not call them.

After confirming persistence, verify permanent removal and list synchronization:

```bash
curl -sS -X POST "$FC_URL/api/documents/delete" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"objectKey\":$(printf '%s' "$OBJECT_KEY" | jq -R .)}" \
  | jq

curl -sS "$FC_URL/api/documents" \
  -H "Authorization: Bearer $TOKEN" \
  | jq
```

The delete response must contain `"deleted": true`, and the key must no longer appear in the list or under the account prefix in the OSS console.

Legacy OSS flow limitation: without a metadata database, the retained OSS listing cannot restore original module placement. Its full-text chat context remains capped at three routed PDFs and 26,000 characters, while collection questions use cached summaries. This does not describe the active local Workspace explorer: local conversations are persisted under `.biodesign/chat/`, and local file selection is path-based.

Negative checks:

```bash
# Must return 401.
curl -i -X POST "$FC_URL/api/documents/review" \
  -H "Content-Type: application/json" \
  -d '{"objectKey":"uploads/example/not-allowed.pdf"}'

# Must return 415.
curl -i -X POST "$FC_URL/api/documents/upload-url" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"filename":"notes.txt","contentType":"text/plain","size":100}'
```
# Web search and source downloading

The architectural notes are in [WEB_SEARCH_AND_SOURCE_DOWNLOAD.md](../docs/WEB_SEARCH_AND_SOURCE_DOWNLOAD.md).

The current task-execution correction is packaged as `Archive-task-execution.zip`.
Upload it manually to the existing FC application; no deployment is performed by
the packaging step. The archive includes the runtime entry points, executable
`bootstrap`, shared contracts and existing dependencies at the ZIP root, without
environment files or tests. Older deployment archives remain untouched.

After deployment, reload a development desktop after `npm run desktop:prepare`;
packaged desktops need rebuilding and relaunching to include the updated renderer
and shared contracts. Start a new move. The client now sends `originalRequest`,
and signed continuations bind it explicitly. Agent Work uses task-directed
execution prompts and one bounded correction for an eligible unattempted
download; Side Chat remains conversational and cannot download. Final
`taskOutcome` and per-source results are host-owned. See the architecture notes
for statuses, citation filtering and the regression evidence (750 passing tests).
Live Requesty selection/relevance and real publisher downloads still need testing.

The current Requesty contract was checked against the live documentation on 2026-09-11:
[native web search](https://docs.requesty.ai/features/web-search) and
[model capability metadata](https://docs.requesty.ai/api-reference/endpoint/models-list).
Chat Completions accepts the hosted descriptor `{"type":"web_search"}` and the model catalog advertises `supports_web_search`.
The existing per-model capability configuration can explicitly override this using `supportsWebSearch`.
The authenticated `/api/sources/fetch` route belongs to this FC app and returns bytes for desktop-local storage only.

### Agent routing boundary regression

Paper discovery must pass `callContext` through `LiteratureTools.searchPapers` into `ElectronQmdKnowledgeService`; otherwise Deep planning and reranking silently use the configured role models. Agent messages carry context separately from the final user instruction, because FC validates the semantic IR against that instruction. Identifiers appearing only in filenames or project background must not be treated as missing user-query identifiers. Actual query identifiers and active source scopes remain validated.

The two reproduced regressions are covered in `test/agent-model-boundaries.test.js` through real Deep retrieval and the production Agent message builder. The complete suite passed 652 tests. These functional fixes require a client reload/rebuild. `Archive-agent-routing-fix.zip` additionally includes specific `INVALID_CALL_CONTEXT` and `INVALID_SEMANTIC_CONTEXT` responses; the client logs allowlisted codes and HTTP status without logging response bodies.
