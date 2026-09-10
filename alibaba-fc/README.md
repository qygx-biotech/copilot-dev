# BioDesign Copilot Alibaba Function Compute Backend

This folder contains the authoritative cloud gateway for BioDesign Copilot. Electron's authenticated AI traffic uses this route:

```text
docs/ frontend -> Alibaba Function Compute HTTP endpoint -> Requesty
```

Electron never calls Requesty directly. The retired `worker/` implementation contains no Requesty client; Requesty credentials remain in Function Compute environment variables or secrets. The backend validates Side Chat model choices before forwarding them to Requesty.

## Side Chat model selection

The Side Chat selector replaces the former Light/Medium/High control. **Default model** uses the existing `REQUESTY_MODEL`; **Nemotron 3 Nano Omni** sends `nvidia/nemotron-3-nano-omni-30b-a3b-reasoning` through the same FC → Requesty client. The dropdown displays provider/model labels: the default uses the actual `REQUESTY_MODEL` reported by authenticated login/session responses, and NVIDIA is shortened to `nvidia/nemotron-3-nano-omni`. Hover shows the full ID. Older backends without this session metadata use the confirmed `google/gemma-4-31b-it` display fallback in `docs/index.html`; this label does not override the backend model. Authenticated model metadata takes precedence when available. The choice is saved per workspace and captured when a Side Chat turn starts. It applies to every model task triggered by that turn: image understanding, knowledge-sync Paper Cards, semantic interpretation, search planning/reranking, context routing, corpus mapping/repair, native PDF analysis when supported, and the answer/tool loop. Retries inherit the same selection. Agent Command and requests without a selection keep their existing role-specific configuration.

No new FC environment variable or API key is needed for this option. Keep the existing `REQUESTY_MODEL` and `REQUESTY_API_KEY`, ensure the Requesty account can access the NVIDIA model, and deploy the updated backend **before** releasing the updated frontend. The answer endpoint receives `model`; preparatory endpoints and their configuration requests receive the validated `X-BioDesign-Chat-Model` header. FC uses a request-local environment copy, never mutating shared configuration. `default` selects `REQUESTY_MODEL` for all tasks in that Side Chat turn. Existing clients that omit the selection keep their configured role models. Arbitrary model overrides are rejected before provider execution or streaming starts.

To make NVIDIA the global default instead, `REQUESTY_MODEL` can be changed to its full ID, but that also changes every capability that falls back to this variable. That is unnecessary for the selector. Future selectable models must be added to the shared `sideChatModelEnvironment` allowlist in `index.js` and the options in `docs/index.html`; credentials must never be added to the frontend. Local routing tests use mocked Requesty responses and do not certify live model access or tool-calling behavior.

Per-model capabilities continue to use `REQUESTY_MODEL_CAPABILITIES_JSON`. A selected model never inherits PDF support, strict JSON Schema support, or context limits from a different configured model. Existing local/text fallbacks remain in place when a capability is unavailable; the system does not silently substitute another model. Model-dependent configurations, cache keys, and learned input limits are scoped to the selection. Valid saved knowledge and completed workflows remain reusable.

## Required Environment Variables

- `REQUESTY_API_KEY` - Existing admin's Requesty API key. Store this as a Function Compute environment variable or secret, never in frontend code. Beta users use their own mapped key variables.
- `REQUESTY_MODEL` - Requesty model name.
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

## Multi-user beta login

The existing account/password screen requires no frontend change. A beta user enters their chosen `account` and **original password**. FC compares it against that user's bcrypt `passwordHash`; the hash itself is not a login password. The existing `ADMIN_ACCOUNT`, `ADMIN_PASSWORD_HASH`, `JWT_SECRET`, and `REQUESTY_API_KEY` retain their roles. The admin's stable ID is `admin`; beta users have role `beta` and a configured stable ID.

New 12-hour HS256 JWTs contain only `id`, `sub` (the same stable ID), `account`, `role`, `iat`, and `exp`. Login and `/api/me` return only public user identity and the existing `chatModel` metadata, plus the token at login. Password hashes, key mappings and Requesty keys are never returned. Existing admin JWTs without IDs remain accepted until expiry if their account matches the configured admin.

FC validates the beta configuration and rechecks the token's ID, account and active status on **every authenticated request**, including `/api/me`, images, configurations, legacy document routes and Agent Command. Removing a user or setting `active: false` rejects their next request even before JWT expiry. Changing an account or ID also invalidates its existing tokens. Each invocation snapshots FC configuration; an already-running invocation retains its starting configuration.

The user's key is placed in an invocation-local environment copy before model selection. All provider work inherits it: semantic interpretation, schema mapping, planning/reranking, Paper Cards and literature processing, corpus and native-PDF workers, image understanding, document review, repairs/retries, answer/tool loops and streaming. Side Chat's selected model and Agent Command's role models keep their existing behavior independently. Client body/header fields cannot select another identity or key. Existing account-based OSS ownership and local workspace/history behavior remain intact.

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
   zip -r ../alibaba-fc-local-workspace.zip index.js side-chat-agent.js requesty-stream.js image-understanding.js src shared bootstrap package.json package-lock.json node_modules
   ```

8. Upload `alibaba-fc-local-workspace.zip`. Keep the handler set to `index.handler`.
9. The local-workspace routes process one bounded chunk per invocation and a separate bounded synthesis request. Keep the existing memory and timeout settings; the legacy server-side OSS review still benefits from 1 GB memory and a 300-second timeout.
10. Keep the existing HTTP-trigger CORS origin for the GitHub Pages frontend.
11. The local-workspace flow does not require OSS bucket CORS. Keep the old rule only if the retained legacy signed-upload endpoint is still in use elsewhere.
12. Copy the public HTTP endpoint into `docs/app.js` as `ALIBABA_FC_URL`. There is no production provider switch or direct Requesty fallback in Electron.
13. Publish the updated `docs/` directory through the existing GitHub Pages deployment.

No production dependency was added for the local-workspace routes. The existing `unpdf@1.8.0` dependency remains for the retained legacy OSS PDF review path.

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
