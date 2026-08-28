# BioDesign Copilot Alibaba Function Compute Backend

This folder contains an experimental Alibaba Cloud Function Compute HTTP backend for BioDesign Copilot. It is an alternative API proxy for teammates who need a China-accessible backend path:

```text
docs/ frontend -> Alibaba Function Compute HTTP endpoint -> Requesty
```

It keeps the same `/chat` response shape as the Cloudflare Worker so the existing frontend can switch providers without UI changes.

## Required Environment Variables

- `REQUESTY_API_KEY` - Requesty API key. Store this as a Function Compute environment variable or secret, never in frontend code.
- `REQUESTY_MODEL` - Requesty model name.
- `ADMIN_ACCOUNT` - Existing stable login account used in the authenticated OSS ownership prefix.
- `ADMIN_PASSWORD_HASH` - Existing bcrypt password hash.
- `JWT_SECRET` - Existing JWT signing secret.
- `OSS_BUCKET` - Legacy private OSS bucket used by retained diagnostic/document endpoints.
- `OSS_REGION` - Legacy OSS region ID, such as `oss-cn-beijing`.
- `OSS_INTERNAL_ENDPOINT` - Legacy internal OSS endpoint.
- `OSS_PUBLIC_ENDPOINT` - Legacy public OSS endpoint for signed uploads.

The OSS variables and RAM role are not used by the active local-workspace literature routes. They are still required only if the retained `/api/test-oss` or `/api/documents/*` endpoints must remain operational.

Do not configure permanent Alibaba Cloud AccessKeys for the function. OSS operations use temporary STS credentials supplied by the attached Function Compute RAM role through the Node.js invocation context (with the Function Compute-provided `ALIBABA_CLOUD_*` environment variables as a runtime fallback).

## Local Testing

The deployed handler and PDF parser require Node.js 20 or newer.

```bash
cd alibaba-fc
npm ci
npm run check
npm test
```

## Manual Alibaba Cloud Function Compute Deployment

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
7. Install production dependencies and package the root handler with `node_modules`:

   ```bash
   cd alibaba-fc
   npm ci --omit=dev
   zip -r ../alibaba-fc-local-workspace.zip index.js side-chat-agent.js package.json package-lock.json node_modules
   ```

8. Upload `alibaba-fc-local-workspace.zip`. Keep the handler set to `index.handler`.
9. The local-workspace routes process one bounded chunk per invocation and a separate bounded synthesis request. Keep the existing memory and timeout settings; the legacy server-side OSS review still benefits from 1 GB memory and a 300-second timeout.
10. Keep the existing HTTP-trigger CORS origin for the GitHub Pages frontend.
11. The local-workspace flow does not require OSS bucket CORS. Keep the old rule only if the retained legacy signed-upload endpoint is still in use elsewhere.
12. Copy the public HTTP endpoint into `docs/app.js` as `ALIBABA_FC_URL` and keep `BACKEND_PROVIDER = "alibaba"`.
13. Publish the updated `docs/` directory through the existing GitHub Pages deployment.

No production dependency was added for the local-workspace routes. The existing `unpdf@1.8.0` dependency remains for the retained legacy OSS PDF review path.

## Local-Workspace Literature Endpoints

The source-worker endpoints require the existing JWT bearer token and are stateless with respect to project storage:

- `POST /api/literature/summarize-chunk` accepts one extracted-text chunk, its bounded index/count, language, and filename.
- `POST /api/literature/synthesize` accepts bounded chunk summaries plus minimal source metadata and returns the structured content used by a local Paper Card.
- `POST /api/corpus/map-paper` accepts one bounded question plus up to eight evidence excerpts for one paper and returns a validated query-specific map note with only supplied evidence references.

None of these routes accepts a local filesystem path, PDF bytes, an OSS key, or a project folder. None reads or writes OSS.

The existing authenticated `POST /chat` route also accepts an optional bounded `localWorkspaceContext` object from the frontend. Function Compute whitelists its compact source map, hard paper/experiment scopes, coverage, project summaries, metadata-only inventory, processed evidence, and limitation notices. The complete Project context / goal is placed in its own durable system message before the workspace catalog, conversation, or Agent Work evidence. The response includes `localWorkspaceFilesUsed` and `localWorkspaceScope` for diagnostics. This route still uses the existing Requesty configuration and does not persist the context.

### Local Paper Cards and routing

Workspace open and Refresh synchronize only cheap file metadata; they perform zero content hashes, PDF parses, workbook parses, or LLM calls. A selected or automatically matched paper is hashed and parsed lazily through the browser's shared source-readiness service. A Paper Card is optional and is generated only when a broad summary/comparison benefits from it or the card operation is explicitly requested. Cards remain at `.biodesign/literature/summaries/<source_id>.json` for compatibility and are keyed in the new source registry by content hash, schema, model, and prompt version. Changed and deleted sources immediately lose their ready association, while unchanged cards are reused.

Workspace-tree selections map to stable paper and experiment source IDs. Explicit selections define hard tool scopes. With no paper selection, ready metadata and content indexes are searched first, cheap metadata identifies likely unprepared candidates, and only candidates are prepared. Precise answers use original page/chunk evidence; Paper Cards can aid broad interpretation but are never the sole evidence. Experiment CSV/XLS/XLSX/TSV/TXT files are normalized lazily into bounded structured records with raw values and file/sheet/range provenance. Retrieved evidence is request-scoped and is not copied into persistent conversation history.

Side Chat and Agent Work both use the same bounded model-driven read-only tool loop in `side-chat-agent.js`; only their final response parsers differ. The server cannot open the browser's local folder, so source preparation happens before transport through the shared browser service and the server tools progressively inspect only the bounded evidence supplied for that request.

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
