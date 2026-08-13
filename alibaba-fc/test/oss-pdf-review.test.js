const assert = require("node:assert/strict");
const test = require("node:test");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const OSS = require("ali-oss");

process.env.JWT_SECRET = "unit-test-jwt-secret";
process.env.ADMIN_ACCOUNT = "paper-reviewer@example.com";
process.env.ADMIN_PASSWORD_HASH = bcrypt.hashSync("test-password", 4);
process.env.OSS_BUCKET = "biodesign-copilot-files-2026";
process.env.OSS_REGION = "oss-cn-beijing";
process.env.OSS_INTERNAL_ENDPOINT =
  "https://oss-cn-beijing-internal.aliyuncs.com";
process.env.OSS_PUBLIC_ENDPOINT = "https://oss-cn-beijing.aliyuncs.com";
process.env.REQUESTY_API_KEY = "requesty-test-key";
process.env.REQUESTY_MODEL = "requesty-test-model";

const objectStore = new Map();
let deleteCalls = 0;

OSS.prototype.getObjectMeta = async function getObjectMeta(objectKey) {
  assert.match(
    String(this.options.endpoint?.href || this.options.endpoint),
    /oss-cn-beijing-internal\.aliyuncs\.com/
  );
  const object = objectStore.get(objectKey);
  if (!object) {
    const error = new Error("The specified key does not exist.");
    error.code = "NoSuchKey";
    error.status = 404;
    error.requestId = "oss-missing-request";
    throw error;
  }

  return {
    status: 200,
    res: {
      headers: {
        "content-length": String(object.buffer.length),
        "content-type": object.contentType
      }
    }
  };
};

OSS.prototype.get = async function get(objectKey) {
  const object = objectStore.get(objectKey);
  if (!object) {
    const error = new Error("The specified key does not exist.");
    error.code = "NoSuchKey";
    error.status = 404;
    throw error;
  }
  return { content: object.buffer };
};

OSS.prototype.delete = async function deleteObject(objectKey) {
  deleteCalls += 1;
  objectStore.delete(objectKey);
  return {};
};

global.fetch = async (_url, options = {}) => {
  const request = JSON.parse(options.body || "{}");
  const systemMessage = String(request.messages?.[0]?.content || "");
  let content;

  if (systemMessage.includes("one excerpt of an academic paper")) {
    content = JSON.stringify({
      summary: "This excerpt describes a controlled paper review experiment.",
      research_question: "Can the proposed review workflow preserve evidence?",
      methods: "A controlled comparison with explicit observations.",
      key_results: ["The workflow retained the source evidence."],
      limitations: ["The excerpt reports a small validation study."],
      main_conclusion: "The workflow was suitable for this validation."
    });
  } else if (systemMessage.includes("combine evidence summaries")) {
    content = JSON.stringify({
      summary: "The paper evaluates a controlled evidence-review workflow.",
      research_question: "Can the workflow preserve and review paper evidence?",
      methods: "The authors used a controlled comparison and recorded outcomes.",
      key_results: ["Source evidence remained available after review."],
      limitations: ["The validation was limited in scale."],
      main_conclusion: "The tested workflow preserved evidence successfully."
    });
  } else {
    content = JSON.stringify({
      reply: "The stored PDF evidence was available to Side Chat.",
      project: {
        summary: "Stored PDF reviewed.",
        organism: "Not applicable",
        missingInformation: [],
        safetyLevel: "Planning review",
        safetyNotes: "Human review remains required.",
        draftMemo: "The stored PDF was included as evidence."
      }
    });
  }

  return new Response(
    JSON.stringify({ choices: [{ message: { content } }] }),
    { status: 200, headers: { "Content-Type": "application/json" } }
  );
};

const { handler, _test } = require("../index");

const context = {
  requestId: "fc-unit-test-request",
  credentials: {
    accessKeyId: "STS.unit-test-id",
    accessKeySecret: "unit-test-secret",
    securityToken: "unit-test-security-token"
  }
};

const authToken = jwt.sign(
  { account: process.env.ADMIN_ACCOUNT, role: "admin" },
  process.env.JWT_SECRET
);

function apiEvent(method, path, body, authenticated = true) {
  return {
    httpMethod: method,
    path,
    headers: authenticated
      ? { authorization: `Bearer ${authToken}` }
      : {},
    body: body === undefined ? undefined : JSON.stringify(body)
  };
}

function parseResponse(response) {
  return response.body ? JSON.parse(response.body) : null;
}

function makeMachineReadablePdf() {
  const lines = [
    "A machine readable academic paper evaluates a controlled evidence review workflow.",
    "The research question asks whether source documents remain available after analysis.",
    "The methods use a controlled comparison with explicit observations and recorded outcomes.",
    "The key result is that source evidence remains available after the review is completed.",
    "The authors note that the validation is small and should be repeated on more documents.",
    "The main conclusion is that persistent storage supports a reproducible review workflow."
  ];
  const escapedLines = lines.map((line) =>
    line.replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)")
  );
  const content = [
    "BT",
    "/F1 11 Tf",
    "72 730 Td",
    ...escapedLines.flatMap((line, index) => [
      index ? "0 -24 Td" : "",
      `(${line}) Tj`
    ]).filter(Boolean),
    "ET"
  ].join("\n");
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>",
    `<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"
  ];

  let pdf = "%PDF-1.4\n";
  const offsets = [0];
  objects.forEach((object, index) => {
    offsets[index + 1] = Buffer.byteLength(pdf);
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xrefOffset = Buffer.byteLength(pdf);
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (let index = 1; index <= objects.length; index += 1) {
    pdf += `${String(offsets[index]).padStart(10, "0")} 00000 n \n`;
  }
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return Buffer.from(pdf);
}

test("existing login and CORS preflight still work", async () => {
  const preflight = await handler(apiEvent("OPTIONS", "/api/login"), context);
  assert.equal(preflight.statusCode, 204);

  const login = await handler(
    apiEvent(
      "POST",
      "/api/login",
      { account: process.env.ADMIN_ACCOUNT, password: "test-password" },
      false
    ),
    context
  );
  assert.equal(login.statusCode, 200);
  assert.equal(parseResponse(login).ok, true);
});

test("document endpoints reject unauthenticated access", async () => {
  const [uploadResponse, reviewResponse] = await Promise.all([
    handler(
      apiEvent(
        "POST",
        "/api/documents/upload-url",
        { filename: "paper.pdf", contentType: "application/pdf", size: 1000 },
        false
      ),
      context
    ),
    handler(
      apiEvent(
        "POST",
        "/api/documents/review",
        { objectKey: "uploads/not-authorized/paper.pdf" },
        false
      ),
      context
    )
  ]);

  assert.equal(uploadResponse.statusCode, 401);
  assert.equal(reviewResponse.statusCode, 401);
});

test("authenticated PDF upload URL uses an owned, sanitized key", async () => {
  const response = await handler(
    apiEvent("POST", "/api/documents/upload-url", {
      filename: "../../Unsafe Paper.pdf",
      contentType: "application/pdf",
      size: 1200
    }),
    context
  );
  const body = parseResponse(response);

  assert.equal(response.statusCode, 200);
  assert.equal(body.ok, true);
  assert.match(
    body.objectKey,
    /^uploads\/paper-reviewer-example-com-[a-f0-9]{16}\//
  );
  assert.match(body.objectKey, /\/Unsafe-Paper\.pdf$/);
  assert.equal(
    _test.isOwnedPdfObjectKey(body.objectKey, process.env.ADMIN_ACCOUNT),
    true
  );
  assert.match(body.uploadUrl, /OSS4-HMAC-SHA256/);
  assert.match(body.uploadUrl, /oss-cn-beijing\.aliyuncs\.com/);
  assert.doesNotMatch(body.uploadUrl, /internal/);
});

test("upload URL endpoint rejects non-PDF files", async () => {
  const response = await handler(
    apiEvent("POST", "/api/documents/upload-url", {
      filename: "notes.txt",
      contentType: "text/plain",
      size: 100
    }),
    context
  );
  assert.equal(response.statusCode, 415);
  assert.equal(parseResponse(response).stage, "upload");
});

test("upload URL endpoint rejects oversized PDFs", async () => {
  const response = await handler(
    apiEvent("POST", "/api/documents/upload-url", {
      filename: "too-large.pdf",
      contentType: "application/pdf",
      size: 5 * 1024 * 1024 + 1
    }),
    context
  );
  assert.equal(response.statusCode, 413);
  assert.equal(parseResponse(response).error, "InvalidFileSize");
});

test("PDF text is divided into bounded overlapping review chunks", () => {
  const text = Array.from(
    { length: 4000 },
    (_, index) => `Sentence ${index} contains paper evidence. `
  ).join("");
  const result = _test.chunkPdfText(text);

  assert.ok(result.chunks.length > 1);
  assert.ok(result.chunks.every((chunk) => chunk.length <= 12000));
  assert.equal(result.truncated, true);
  assert.equal(result.processedCharacters, 96000);
});

test("machine-readable PDF extraction and review succeed without deleting the object", async () => {
  const pdf = makeMachineReadablePdf();
  const extraction = await _test.extractPdfDocument(pdf);
  assert.equal(extraction.ok, true);
  assert.ok(extraction.text.length >= 200);

  const objectKey = _test.buildOwnedPdfObjectKey(
    process.env.ADMIN_ACCOUNT,
    "review-paper.pdf"
  );
  objectStore.set(objectKey, { buffer: pdf, contentType: "application/pdf" });

  const response = await handler(
    apiEvent("POST", "/api/documents/review", {
      objectKey,
      language: "en"
    }),
    context
  );
  const body = parseResponse(response);

  assert.equal(response.statusCode, 200);
  assert.equal(body.ok, true);
  assert.equal(body.summary, "The paper evaluates a controlled evidence-review workflow.");
  assert.deepEqual(body.key_results, [
    "Source evidence remained available after review."
  ]);
  assert.ok(body.extractedCharacterCount >= 200);
  assert.equal(objectStore.has(objectKey), true);
  assert.equal(deleteCalls, 0);
});

test("missing and foreign PDF objects produce controlled errors", async () => {
  const missingKey = _test.buildOwnedPdfObjectKey(
    process.env.ADMIN_ACCOUNT,
    "missing.pdf"
  );
  const missingResponse = await handler(
    apiEvent("POST", "/api/documents/review", { objectKey: missingKey }),
    context
  );
  assert.equal(missingResponse.statusCode, 404);
  assert.equal(parseResponse(missingResponse).error, "ObjectNotFound");

  const foreignKey = _test.buildOwnedPdfObjectKey(
    "different-user@example.com",
    "foreign.pdf"
  );
  const foreignResponse = await handler(
    apiEvent("POST", "/api/documents/review", { objectKey: foreignKey }),
    context
  );
  assert.equal(foreignResponse.statusCode, 403);
  assert.equal(parseResponse(foreignResponse).error, "ObjectAccessDenied");
});

test("existing chat can retrieve an owned stored PDF as evidence", async () => {
  const objectKey = _test.buildOwnedPdfObjectKey(
    process.env.ADMIN_ACCOUNT,
    "side-chat-paper.pdf"
  );
  objectStore.set(objectKey, {
    buffer: makeMachineReadablePdf(),
    contentType: "application/pdf"
  });

  const response = await handler(
    apiEvent("POST", "/chat", {
      mode: "side_chat",
      messages: [{ role: "user", content: "What does this paper conclude?" }],
      storedDocuments: [{ objectKey }]
    }),
    context
  );
  const body = parseResponse(response);

  assert.equal(response.statusCode, 200);
  assert.equal(body.reply, "The stored PDF evidence was available to Side Chat.");
  assert.deepEqual(body.storedPdfsUsed, ["side-chat-paper.pdf"]);
});
