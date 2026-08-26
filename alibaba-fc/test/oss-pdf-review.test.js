const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs");
const path = require("node:path");
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
let pdfGetCalls = 0;
let llmFetchCalls = 0;
const queuedChatCompletionTexts = [];
const queuedRouterCompletionTexts = [];
const queuedChatHttpStatuses = [];
const capturedLlmRequests = [];

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
  if (objectKey.toLowerCase().endsWith(".pdf")) pdfGetCalls += 1;
  return { content: object.buffer };
};

OSS.prototype.put = async function put(objectKey, content, options = {}) {
  objectStore.set(objectKey, {
    buffer: Buffer.isBuffer(content) ? content : Buffer.from(content || ""),
    contentType:
      options.headers?.["Content-Type"] || "application/octet-stream",
    lastModified: new Date().toISOString()
  });
  return { name: objectKey };
};

OSS.prototype.listV2 = async function listV2(query = {}) {
  assert.match(
    String(this.options.endpoint?.href || this.options.endpoint),
    /oss-cn-beijing-internal\.aliyuncs\.com/
  );
  const prefix = String(query.prefix || "");
  const objects = [...objectStore.entries()]
    .filter(([objectKey]) => objectKey.startsWith(prefix))
    .map(([name, object]) => ({
      name,
      size: object.buffer.length,
      lastModified: object.lastModified || "2026-08-14T02:00:00.000Z"
    }));

  return {
    objects,
    isTruncated: false,
    nextContinuationToken: null
  };
};

OSS.prototype.delete = async function deleteObject(objectKey) {
  deleteCalls += 1;
  objectStore.delete(objectKey);
  return {};
};

global.fetch = async (_url, options = {}) => {
  llmFetchCalls += 1;
  const request = JSON.parse(options.body || "{}");
  capturedLlmRequests.push(request);
  const systemMessage = String(request.messages?.[0]?.content || "");
  if (
    !systemMessage.includes("one excerpt of an academic paper") &&
    !systemMessage.includes("combine evidence summaries") &&
    queuedChatHttpStatuses.length
  ) {
    const status = queuedChatHttpStatuses.shift();
    if (status !== 200) {
      return new Response(JSON.stringify({ error: { message: "transient" } }), {
        status,
        headers: {
          "Content-Type": "application/json",
          "Retry-After": "0"
        }
      });
    }
  }
  let content;

  if (systemMessage.includes("lightweight context and memory router")) {
    content = queuedRouterCompletionTexts.length
      ? queuedRouterCompletionTexts.shift()
      : JSON.stringify({
          use_literature: false,
          paper_ids: [],
          use_project_memory: false,
          memory_ids: [],
          reason: "No local context is needed."
        });
  } else if (systemMessage.includes("one excerpt of an academic paper")) {
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
    content = queuedChatCompletionTexts.length
      ? queuedChatCompletionTexts.shift()
      : JSON.stringify({
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

test("frontend upload does not automatically invoke PDF review", () => {
  const frontendSource = fs.readFileSync(
    path.join(__dirname, "../../docs/app.js"),
    "utf8"
  );
  const workspaceSource = fs.readFileSync(
    path.join(__dirname, "../../docs/workspace-manager.js"),
    "utf8"
  );
  const contextSource = fs.readFileSync(
    path.join(__dirname, "../../docs/project-context-service.js"),
    "utf8"
  );
  const uploadStart = frontendSource.indexOf("async function uploadPdfToOss");
  const uploadEnd = frontendSource.indexOf(
    "async function syncStoredPdfDocuments",
    uploadStart
  );
  const uploadFunction = frontendSource.slice(uploadStart, uploadEnd);

  assert.ok(uploadStart >= 0 && uploadEnd > uploadStart);
  assert.doesNotMatch(uploadFunction, /\/api\/documents\/review/);
  assert.match(frontendSource, /USE_OSS_WORKSPACE_STORAGE = false/);
  assert.match(frontendSource, /projectContextService\.buildContext/);
  assert.match(contextSource, /this\.literature\.summarize/);
  assert.match(workspaceSource, /showDirectoryPicker/);
  assert.match(workspaceSource, /scanDirectoryTree/);
  assert.doesNotMatch(frontendSource, /await syncStoredPdfDocuments\(\)/);
  assert.match(frontendSource, /addSideChatThinking/);
  assert.doesNotMatch(frontendSource, /SIDE_CHAT_HISTORY_STORAGE_KEY/);
  assert.match(contextSource, /\.biodesign\/chat\/conversations/);
  assert.match(frontendSource, /persistSideChatConversation/);
});

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
  const [
    listResponse,
    uploadResponse,
    reviewResponse,
    deleteResponse,
    localChunkResponse,
    localSynthesisResponse,
    contextRouterResponse
  ] = await Promise.all([
    handler(apiEvent("GET", "/api/documents", undefined, false), context),
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
    ),
    handler(
      apiEvent(
        "POST",
        "/api/documents/delete",
        { objectKey: "uploads/not-authorized/paper.pdf" },
        false
      ),
      context
    ),
    handler(
      apiEvent(
        "POST",
        "/api/literature/summarize-chunk",
        { filename: "local.pdf", chunkIndex: 0, totalChunks: 1, text: "evidence" },
        false
      ),
      context
    ),
    handler(
      apiEvent(
        "POST",
        "/api/literature/synthesize",
        { filename: "local.pdf", chunkSummaries: [{ summary: "evidence" }] },
        false
      ),
      context
    ),
    handler(
      apiEvent(
        "POST",
        "/api/context/route",
        { userQuery: "Which paper?", literatureIndex: [] },
        false
      ),
      context
    )
  ]);

  assert.equal(listResponse.statusCode, 401);
  assert.equal(uploadResponse.statusCode, 401);
  assert.equal(reviewResponse.statusCode, 401);
  assert.equal(deleteResponse.statusCode, 401);
  assert.equal(localChunkResponse.statusCode, 401);
  assert.equal(localSynthesisResponse.statusCode, 401);
  assert.equal(contextRouterResponse.statusCode, 401);
});

test("local literature endpoints are stateless and never read or write OSS", async () => {
  const pdfReadsBefore = pdfGetCalls;
  const objectsBefore = objectStore.size;
  const chunkResponse = await handler(
    apiEvent("POST", "/api/literature/summarize-chunk", {
      filename: "../local-paper.pdf",
      chunkIndex: 0,
      totalChunks: 1,
      text: "Machine-readable evidence from a local academic PDF. ".repeat(20),
      language: "en"
    }),
    context
  );
  const chunkBody = parseResponse(chunkResponse);
  assert.equal(chunkResponse.statusCode, 200);
  assert.equal(chunkBody.ok, true);
  assert.equal(chunkBody.chunkSummary.summary.includes("controlled"), true);

  const synthesisResponse = await handler(
    apiEvent("POST", "/api/literature/synthesize", {
      filename: "/Users/example/private/local-paper.pdf",
      size: 1200,
      lastModified: 1780000000000,
      pageCount: 5,
      extractionTruncated: false,
      chunkSummaries: [chunkBody.chunkSummary],
      language: "en"
    }),
    context
  );
  const synthesisBody = parseResponse(synthesisResponse);
  assert.equal(synthesisResponse.statusCode, 200);
  assert.equal(synthesisBody.ok, true);
  assert.equal(synthesisBody.summary.summary.includes("controlled"), true);
  assert.equal(synthesisBody.model, process.env.REQUESTY_MODEL);
  assert.equal(pdfGetCalls, pdfReadsBefore);
  assert.equal(objectStore.size, objectsBefore);

  const lastRequest = capturedLlmRequests.at(-1);
  const userMessage = lastRequest.messages.at(-1).content;
  assert.match(userMessage, /local-paper\.pdf/);
  assert.doesNotMatch(userMessage, /Users\/example|private\//);
  assert.doesNotMatch(userMessage, /objectKey|OSS/);
});

test("context router uses only compact indexes and preserves explicit paper scope", async () => {
  queuedRouterCompletionTexts.push(
    JSON.stringify({
      use_literature: true,
      paper_ids: ["paper-b"],
      use_project_memory: true,
      memory_ids: ["project_summary", "not-available"],
      reason: "The question asks about the selected study."
    })
  );
  const response = await handler(
    apiEvent("POST", "/api/context/route", {
      userQuery: "What exact value did the selected paper report?",
      selectedPaperIds: ["paper-a"],
      recentlyReferencedPaperIds: ["paper-b"],
      literatureIndex: [
        {
          paperId: "paper-a",
          fileName: "paper-a.pdf",
          title: "Selected EctD study",
          authors: ["A. Scientist"],
          year: 2024,
          topics: ["enzyme engineering"],
          keywords: ["EctD"],
          identifiers: ["A163V"],
          shortDescription: "A compact routing description.",
          status: "ready",
          paperCardAvailable: true,
          fullPaperText: "must not be sent"
        },
        {
          paperId: "paper-b",
          fileName: "paper-b.pdf",
          title: "Unselected study",
          status: "ready",
          paperCardAvailable: true
        }
      ],
      availableMemoryDescriptions: [
        { id: "project_summary", description: "Saved project summary is available." }
      ]
    }),
    context
  );
  const body = parseResponse(response);
  assert.equal(response.statusCode, 200);
  assert.equal(body.ok, true);
  assert.deepEqual(body.routing.paperIds, ["paper-a"]);
  assert.deepEqual(body.routing.memoryIds, ["project_summary"]);

  const request = capturedLlmRequests.at(-1);
  const routerInput = JSON.parse(request.messages.at(-1).content);
  assert.equal(routerInput.literature_index.length, 2);
  assert.equal(
    Object.hasOwn(routerInput.literature_index[0], "fullPaperText"),
    false
  );
  assert.match(request.messages[0].content, /not the answering agent/i);
});

test("context router preserves an explicit scope of 100 papers", async () => {
  const paperIds = Array.from({ length: 100 }, (_, index) => `paper-${index + 1}`);
  queuedRouterCompletionTexts.push(
    JSON.stringify({
      use_literature: true,
      paper_ids: [paperIds[0]],
      use_project_memory: false,
      memory_ids: [],
      reason: "Use the complete explicitly selected paper scope."
    })
  );

  const response = await handler(
    apiEvent("POST", "/api/context/route", {
      userQuery: "Compare every selected paper.",
      selectedPaperIds: paperIds,
      literatureIndex: paperIds.map((paperId, index) => ({
        paperId,
        fileName: `${paperId}.pdf`,
        title: `Study ${index + 1}`,
        status: "ready",
        paperCardAvailable: true
      }))
    }),
    context
  );
  const body = parseResponse(response);
  assert.equal(response.statusCode, 200);
  assert.deepEqual(body.routing.paperIds, paperIds);

  const routerInput = JSON.parse(capturedLlmRequests.at(-1).messages.at(-1).content);
  assert.equal(routerInput.selected_paper_ids.length, 100);
  assert.equal(routerInput.literature_index.length, 100);
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

test("authenticated document listing discovers only the account's OSS PDFs", async () => {
  const ownKey = _test.buildOwnedPdfObjectKey(
    process.env.ADMIN_ACCOUNT,
    "persistent-paper.pdf"
  );
  const foreignKey = _test.buildOwnedPdfObjectKey(
    "different-user@example.com",
    "private-paper.pdf"
  );
  const pdf = makeMachineReadablePdf();
  objectStore.set(ownKey, {
    buffer: pdf,
    contentType: "application/pdf",
    lastModified: "2026-08-14T03:00:00.000Z"
  });
  objectStore.set(foreignKey, {
    buffer: pdf,
    contentType: "application/pdf",
    lastModified: "2026-08-14T04:00:00.000Z"
  });

  const response = await handler(
    apiEvent("GET", "/api/documents"),
    context
  );
  const body = parseResponse(response);

  assert.equal(response.statusCode, 200);
  assert.equal(body.ok, true);
  assert.deepEqual(body.documents, [
    {
      objectKey: ownKey,
      filename: "persistent-paper.pdf",
      size: pdf.length,
      lastModified: "2026-08-14T03:00:00.000Z",
      type: "application/pdf",
      summaryAvailable: false
    }
  ]);
  assert.equal(body.documents[0].url, undefined);
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
  assert.equal(body.summaryCached, true);
  assert.equal(objectStore.has(objectKey), true);
  assert.equal(deleteCalls, 0);

  const callsAfterFirstReview = llmFetchCalls;
  const cachedResponse = await handler(
    apiEvent("POST", "/api/documents/review", { objectKey, language: "en" }),
    context
  );
  assert.equal(cachedResponse.statusCode, 200);
  assert.equal(parseResponse(cachedResponse).cached, true);
  assert.equal(llmFetchCalls, callsAfterFirstReview);
});

test("deleting an owned PDF removes both the source and cached summary", async () => {
  const objectKey = _test.buildOwnedPdfObjectKey(
    process.env.ADMIN_ACCOUNT,
    "delete-paper.pdf"
  );
  const pdf = makeMachineReadablePdf();
  objectStore.set(objectKey, { buffer: pdf, contentType: "application/pdf" });

  const reviewResponse = await handler(
    apiEvent("POST", "/api/documents/review", { objectKey, language: "en" }),
    context
  );
  assert.equal(reviewResponse.statusCode, 200);
  const reviewObjectKey = objectKey.replace(/[^/]+$/, ".paper-review.json");
  assert.equal(objectStore.has(reviewObjectKey), true);

  const response = await handler(
    apiEvent("POST", "/api/documents/delete", { objectKey }),
    context
  );
  const body = parseResponse(response);
  assert.equal(response.statusCode, 200);
  assert.equal(body.deleted, true);
  assert.equal(objectStore.has(objectKey), false);
  assert.equal(objectStore.has(reviewObjectKey), false);
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

  const foreignDeleteResponse = await handler(
    apiEvent("POST", "/api/documents/delete", { objectKey: foreignKey }),
    context
  );
  assert.equal(foreignDeleteResponse.statusCode, 403);
  assert.equal(parseResponse(foreignDeleteResponse).error, "ObjectAccessDenied");
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

test("Side Chat accepts plain-text follow-ups and preserves multi-round history", async () => {
  capturedLlmRequests.length = 0;
  queuedChatCompletionTexts.push("The first conversational answer.");
  const firstResponse = await handler(
    apiEvent("POST", "/chat", {
      mode: "side_chat",
      messages: [{ role: "user", content: "Explain the main result." }]
    }),
    context
  );
  const firstBody = parseResponse(firstResponse);
  assert.equal(firstResponse.statusCode, 200);
  assert.equal(firstBody.fallback, false);
  assert.equal(firstBody.reply, "The first conversational answer.");

  queuedChatCompletionTexts.push(
    "The limitation follows from the small validation cohort."
  );
  const secondResponse = await handler(
    apiEvent("POST", "/chat", {
      mode: "side_chat",
      messages: [
        { role: "user", content: "Explain the main result." },
        { role: "assistant", content: firstBody.reply },
        { role: "user", content: "What limitation did you just mention?" }
      ]
    }),
    context
  );
  const secondBody = parseResponse(secondResponse);
  assert.equal(secondResponse.statusCode, 200);
  assert.equal(secondBody.fallback, false);
  assert.equal(
    secondBody.reply,
    "The limitation follows from the small validation cohort."
  );

  const request = capturedLlmRequests.at(-1);
  assert.equal(Object.hasOwn(request, "max_tokens"), false);
  assert.deepEqual(
    request.messages
      .filter((message) => message.role !== "system")
      .map((message) => message.role),
    ["user", "assistant", "user"]
  );
});

test("Side Chat preserves a long provider reply without imposing an output cap", async () => {
  const longReply = `## Detailed answer\n\n${Array.from(
    { length: 700 },
    () => "Evidence-backed explanation."
  ).join(" ")}`;
  assert.ok(longReply.length > 12000);
  queuedChatCompletionTexts.push(longReply);

  const response = await handler(
    apiEvent("POST", "/chat", {
      mode: "side_chat",
      messages: [{ role: "user", content: "Give me the complete analysis." }]
    }),
    context
  );
  const body = parseResponse(response);
  assert.equal(response.statusCode, 200);
  assert.equal(body.fallback, false);
  assert.equal(body.reply, longReply);
  assert.equal(
    Object.hasOwn(capturedLlmRequests.at(-1), "max_tokens"),
    false
  );
});

test("Side Chat retries one transient Requesty response", async () => {
  const callsBefore = llmFetchCalls;
  queuedChatHttpStatuses.push(429, 200);
  queuedChatCompletionTexts.push("The retry completed successfully.");
  const response = await handler(
    apiEvent("POST", "/chat", {
      mode: "side_chat",
      messages: [{ role: "user", content: "Please retry this question." }]
    }),
    context
  );
  const body = parseResponse(response);
  assert.equal(response.statusCode, 200);
  assert.equal(body.fallback, false);
  assert.equal(body.reply, "The retry completed successfully.");
  assert.equal(llmFetchCalls - callsBefore, 2);
});

test("chat history is bounded while retaining the latest turn", () => {
  const messages = Array.from({ length: 60 }, (_, index) => ({
    role: index % 2 ? "assistant" : "user",
    content: `${index}:${"x".repeat(3990)}`
  }));
  const sanitized = _test.sanitizeChatMessagesForLlm(messages);
  assert.ok(sanitized.length <= 40);
  assert.equal(sanitized[0].role, "user");
  assert.equal(sanitized.at(-1).content.startsWith("59:"), true);
  assert.ok(
    sanitized.reduce((total, message) => total + message.content.length, 0) <=
      120000
  );
});

test("a long prior Side Chat answer remains available to the next turn", () => {
  const longAnswer = "Prior answer detail. ".repeat(2500).trim();
  const sanitized = _test.sanitizeChatMessagesForLlm([
    { role: "user", content: "Give me a detailed analysis." },
    { role: "assistant", content: longAnswer },
    { role: "user", content: "Now compare its last two sections." }
  ]);

  assert.equal(sanitized[1].content, longAnswer);
  assert.equal(sanitized.at(-1).content, "Now compare its last two sections.");
});

test("side chat routes by cached summaries and avoids loading unrelated PDFs", async () => {
  const pdf = makeMachineReadablePdf();
  const alphaKey = _test.buildOwnedPdfObjectKey(
    process.env.ADMIN_ACCOUNT,
    "alpha-catalyst.pdf"
  );
  const betaKey = _test.buildOwnedPdfObjectKey(
    process.env.ADMIN_ACCOUNT,
    "beta-fermentation.pdf"
  );
  for (const [objectKey, title] of [
    [alphaKey, "Alpha catalyst study"],
    [betaKey, "Beta fermentation study"]
  ]) {
    objectStore.set(objectKey, { buffer: pdf, contentType: "application/pdf" });
    objectStore.set(objectKey.replace(/[^/]+$/, ".paper-review.json"), {
      buffer: Buffer.from(
        JSON.stringify({
          version: 1,
          objectKey,
          filename: objectKey.split("/").pop(),
          language: "en",
          updatedAt: "2026-08-14T06:00:00.000Z",
          review: {
            title,
            summary: `${title} reports a focused validation result.`,
            research_question: `What does ${title} demonstrate?`,
            methods: "Controlled comparison.",
            key_results: [`${title} produced its reported result.`],
            limitations: ["Limited validation scale."],
            main_conclusion: `${title} supports further evaluation.`
          }
        })
      ),
      contentType: "application/json"
    });
  }

  pdfGetCalls = 0;
  const focusedResponse = await handler(
    apiEvent("POST", "/chat", {
      mode: "side_chat",
      messages: [{ role: "user", content: "What does alpha conclude?" }],
      storedDocuments: [
        { objectKey: alphaKey, summaryAvailable: true },
        { objectKey: betaKey, summaryAvailable: true }
      ]
    }),
    context
  );
  const focusedBody = parseResponse(focusedResponse);
  assert.equal(focusedResponse.statusCode, 200);
  assert.deepEqual(focusedBody.storedPdfsUsed, ["alpha-catalyst.pdf"]);
  assert.equal(focusedBody.documentScope.mode, "summary-relevance");
  assert.equal(pdfGetCalls, 1);

  pdfGetCalls = 0;
  const collectionResponse = await handler(
    apiEvent("POST", "/chat", {
      mode: "side_chat",
      messages: [{ role: "user", content: "Summarize all uploaded files." }],
      storedDocuments: [
        { objectKey: alphaKey, summaryAvailable: true },
        { objectKey: betaKey, summaryAvailable: true }
      ],
      selectedDocumentKeys: [alphaKey]
    }),
    context
  );
  const collectionBody = parseResponse(collectionResponse);
  assert.equal(collectionResponse.statusCode, 200);
  assert.deepEqual(collectionBody.storedPdfsUsed, []);
  assert.deepEqual(collectionBody.storedPdfSummariesUsed.sort(), [
    "alpha-catalyst.pdf",
    "beta-fermentation.pdf"
  ]);
  assert.equal(collectionBody.documentScope.mode, "collection-summaries");
  assert.equal(pdfGetCalls, 0);
});

test("collection chat uses cached summaries for twenty papers without loading PDFs", async () => {
  const storedDocuments = [];
  for (let index = 1; index <= 20; index += 1) {
    const objectKey = _test.buildOwnedPdfObjectKey(
      process.env.ADMIN_ACCOUNT,
      `collection-paper-${String(index).padStart(2, "0")}.pdf`
    );
    objectStore.set(objectKey, {
      buffer: makeMachineReadablePdf(),
      contentType: "application/pdf"
    });
    objectStore.set(objectKey.replace(/[^/]+$/, ".paper-review.json"), {
      buffer: Buffer.from(
        JSON.stringify({
          version: 1,
          objectKey,
          filename: objectKey.split("/").pop(),
          language: "en",
          updatedAt: "2026-08-15T02:00:00.000Z",
          review: {
            title: `Collection paper ${index}`,
            summary: `Paper ${index} reports a distinct evidence result.`,
            research_question: `Research question ${index}.`,
            methods: `Method ${index}.`,
            key_results: [`Result ${index}.`],
            limitations: [`Limitation ${index}.`],
            main_conclusion: `Conclusion ${index}.`
          }
        })
      ),
      contentType: "application/json"
    });
    storedDocuments.push({ objectKey, summaryAvailable: true });
  }

  pdfGetCalls = 0;
  queuedChatCompletionTexts.push(
    "The twenty cached paper summaries were compared without loading full PDFs."
  );
  const response = await handler(
    apiEvent("POST", "/chat", {
      mode: "side_chat",
      messages: [
        { role: "user", content: "Compare all twenty papers in the collection." }
      ],
      storedDocuments
    }),
    context
  );
  const body = parseResponse(response);
  assert.equal(response.statusCode, 200);
  assert.equal(body.fallback, false);
  assert.equal(body.documentScope.mode, "collection-summaries");
  assert.equal(body.storedPdfSummariesUsed.length, 20);
  assert.equal(body.storedPdfsUsed.length, 0);
  assert.equal(pdfGetCalls, 0);
});
