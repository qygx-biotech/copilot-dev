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
- `OSS_BUCKET` - Private OSS bucket used by the storage diagnostic and persistent PDF workflow.
- `OSS_REGION` - OSS region ID, such as `oss-cn-beijing`.
- `OSS_INTERNAL_ENDPOINT` - Internal OSS endpoint used for Function Compute-to-OSS traffic.
- `OSS_PUBLIC_ENDPOINT` - Public OSS endpoint used only to create short-lived browser upload URLs. Server-side reads continue to use the internal endpoint.

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
5. Set environment variables:
   - `REQUESTY_API_KEY`
   - `REQUESTY_MODEL`
   - `ADMIN_ACCOUNT`
   - `ADMIN_PASSWORD_HASH`
   - `JWT_SECRET`
   - `OSS_BUCKET`
   - `OSS_REGION`
   - `OSS_INTERNAL_ENDPOINT`
   - `OSS_PUBLIC_ENDPOINT`
6. Attach the existing `BioDesignCopilotFCRole` execution role to the function. Do not add long-lived AccessKey values.
   In addition to its existing `GetObject` and `PutObject` permissions, its custom policy must allow prefix listing on the bucket so login can discover saved papers:

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

   `ListObjects` uses the bucket itself as the RAM resource; the `oss:Prefix` condition restricts the listable scope. Application authentication further narrows every request to the current account's exact hashed prefix.

   The object-level statement for this branch must include `oss:GetObject`, `oss:PutObject`, and `oss:DeleteObject` on `acs:oss:*:*:biodesign-copilot-files-2026/uploads/*`. `DeleteObject` is required because Remove and Clear now synchronize deletions to OSS.
7. Install production dependencies and package the root handler with `node_modules`:

   ```bash
   cd alibaba-fc
   npm ci --omit=dev
   zip -r ../alibaba-fc-oss-pdf-review.zip index.js package.json package-lock.json node_modules
   ```

8. Upload `alibaba-fc-oss-pdf-review.zip`. Keep the handler set to `index.handler`.
9. For multi-chunk paper reviews, configure at least 1 GB memory and a 300-second timeout for the initial milestone.
10. Keep the existing HTTP-trigger CORS origin for the GitHub Pages frontend.
11. Keep the private OSS bucket CORS rule that allows the GitHub Pages origin to send `PUT` requests with `Content-Type: application/pdf`.
12. Copy the public HTTP endpoint into `docs/app.js` as `ALIBABA_FC_URL` and keep `BACKEND_PROVIDER = "alibaba"`.
13. Publish the updated `docs/` directory through the existing GitHub Pages deployment.

The only new production dependency for this branch is `unpdf@1.8.0`. Its serverless PDF.js build extracts embedded text without OCR or native canvas binaries.

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

Expected review output includes `"ok": true`, `"summaryCached": true`, a non-empty `summary`, and the original `objectKey`. The list response must contain that key with `"summaryAvailable": true`. Log out, sign in again, and confirm the PDF card and View Summary action are restored under Literature & References.

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

Without a metadata database, restored PDFs are placed in Literature & References even if they were originally uploaded inside an experiment module. Up to 100 owned PDFs are shown. Full-text chat context is capped at three routed PDFs and 26,000 characters; collection questions over 10–20 papers use cached summaries and clearly identify unsummarized files. Conversation history and the current paper focus are capped at 20 messages, 24,000 characters, and three object keys; they are stored only in browser session storage for the current account, ownership-checked again by Function Compute, and can be removed with Clear chat.

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
