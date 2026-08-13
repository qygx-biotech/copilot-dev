# BioDesign Copilot Alibaba Function Compute Backend

This folder contains an experimental Alibaba Cloud Function Compute HTTP backend for BioDesign Copilot. It is an alternative API proxy for teammates who need a China-accessible backend path:

```text
docs/ frontend -> Alibaba Function Compute HTTP endpoint -> Requesty
```

It keeps the same `/chat` response shape as the Cloudflare Worker so the existing frontend can switch providers without UI changes.

## Required Environment Variables

- `REQUESTY_API_KEY` - Requesty API key. Store this as a Function Compute environment variable or secret, never in frontend code.
- `REQUESTY_MODEL` - Requesty model name.
- `OSS_BUCKET` - Private OSS bucket used by the temporary storage diagnostic.
- `OSS_REGION` - OSS region ID, such as `oss-cn-beijing`.
- `OSS_INTERNAL_ENDPOINT` - Internal OSS endpoint used for Function Compute-to-OSS traffic.
- `OSS_PUBLIC_ENDPOINT` - Public OSS endpoint retained for future external use; the server-side diagnostic does not use it.

Do not configure permanent Alibaba Cloud AccessKeys for the function. The OSS diagnostic uses temporary STS credentials supplied by the attached Function Compute RAM role through the Node.js invocation context (with the Function Compute-provided `ALIBABA_CLOUD_*` environment variables as a runtime fallback).

## Local Testing

This backend uses Node.js 18+ global `fetch`.

```bash
cd alibaba-fc
npm start
```

Then test:

```bash
curl http://localhost:9000/health
curl -X POST http://localhost:9000/chat \
  -H "Content-Type: application/json" \
  -d '{"messages":[{"role":"user","content":"Review a yeast pigment teaching demo."}]}'
```

Without Requesty environment variables, `/chat` returns a safe fallback object with the same frontend shape.

## Manual Alibaba Cloud Function Compute Deployment

1. Create a Function Compute service and function in Alibaba Cloud.
2. Choose a Node.js runtime, preferably Node.js 18 or newer.
3. Create an HTTP trigger for the function.
4. Use this handler setting:
   - `index.handler`
5. Set environment variables:
   - `REQUESTY_API_KEY`
   - `REQUESTY_MODEL`
   - `OSS_BUCKET`
   - `OSS_REGION`
   - `OSS_INTERNAL_ENDPOINT`
   - `OSS_PUBLIC_ENDPOINT`
6. Upload or deploy the `alibaba-fc/` code.
7. Copy the public HTTP endpoint from the HTTP trigger.
8. Paste it into `docs/app.js` as `ALIBABA_FC_URL`.
9. Set `BACKEND_PROVIDER = "alibaba"` in `docs/app.js` for testing.

## Endpoint Tests

Health check:

```bash
curl https://your-alibaba-fc-endpoint/health
```

Chat request:

```bash
curl -X POST https://your-alibaba-fc-endpoint/chat \
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
