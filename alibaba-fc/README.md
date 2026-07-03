# BioDesign Copilot Alibaba Function Compute Backend

This folder contains an experimental Alibaba Cloud Function Compute HTTP backend for BioDesign Copilot. It is an alternative API proxy for teammates who need a China-accessible backend path:

```text
docs/ frontend -> Alibaba Function Compute HTTP endpoint -> Requesty
```

It keeps the same `/chat` response shape as the Cloudflare Worker so the existing frontend can switch providers without UI changes.

## Required Environment Variables

- `REQUESTY_API_KEY` - Requesty API key. Store this as a Function Compute environment variable or secret, never in frontend code.
- `REQUESTY_MODEL` - Requesty model name.

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
