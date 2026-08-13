// alibaba-fc/index.js
// Alibaba Cloud Function Compute HTTP backend for BioDesign Copilot
// Handler setting: index.handler
// Runtime: Node.js 20
// Required env vars:
//   REQUESTY_API_KEY
//   REQUESTY_MODEL
//   ADMIN_ACCOUNT
//   ADMIN_PASSWORD_HASH
//   JWT_SECRET
//   OSS_BUCKET
//   OSS_REGION
//   OSS_INTERNAL_ENDPOINT
//   OSS_PUBLIC_ENDPOINT

const crypto = require("node:crypto");
const OSS = require("ali-oss");
const { extractText, getDocumentProxy, getMeta } = require("unpdf");

const REQUESTY_URL = "https://router.requesty.ai/v1/chat/completions";
const MAX_REFERENCE_DOCUMENTS = 8;
const MAX_EXPERIMENT_DOCUMENTS = 36;
const MAX_EXPERIMENT_NOTES = 36;
const TOTAL_REFERENCE_TEXT_LIMIT = 26000;
const TOTAL_EXPERIMENT_TEXT_LIMIT = 26000;
const MAX_PDF_UPLOAD_BYTES = 5 * 1024 * 1024;
const MAX_STORED_PDF_DOCUMENTS = 8;
const MAX_PDF_REVIEW_CHARACTERS = 96000;
const PDF_REVIEW_CHUNK_CHARACTERS = 12000;
const PDF_REVIEW_CHUNK_OVERLAP = 500;
const PDF_REVIEW_CONCURRENCY = 3;
const PDF_UPLOAD_URL_TTL_SECONDS = 300;
const MIN_MACHINE_READABLE_PDF_CHARACTERS = 200;
const MAX_PDF_PAGES = 100;
const PDF_PARSE_TIMEOUT_MS = 30000;
const EXPERIMENT_MODULE_LABELS = {
  strainEngineering: "Strain Engineering",
  fermentation: "Fermentation",
  downstreamProcessing: "Downstream Processing"
};

const corsHeaders = {
  "Content-Type": "application/json"
};

const systemPrompt = `
You are BioDesign Copilot, an AI design-review copilot for synthetic biology teams.

Your job is to support a human-in-the-loop BioDesign Workbench for synthetic biology design, literature review, messy experiment interpretation, and planning-level recommendations.

The project may be about many goals: pathway improvement, failed experiment interpretation, enzyme variant comparison, literature synthesis, assay troubleshooting, strain/design comparison, or another synthetic-biology planning question. Do not assume the project is only about production volume, titer, yield, or productivity.

Uploaded context may include messy literature PDFs, notes, lab reports, spreadsheet batches, CSV files, TXT files, and informal experiment notes. Experiment evidence may be grouped into Strain Engineering, Fermentation, and Downstream Processing modules. Treat all uploaded context as unverified user-provided evidence. Use it to interpret evidence, identify possible explanations, suggest useful next analyses, and recommend human-reviewed next steps. Do not assume every project has clean metrics, complete metadata, or comparable experiments. Mention filenames and modules when relying on uploaded evidence and say what is missing when evidence is insufficient.

You should help with:
- benign project scoping
- documentation
- high-level design review
- evidence interpretation
- possible explanation generation
- next-analysis recommendations
- educational synthetic biology concepts
- safety and compliance reminders
- clarifying questions
- investor-ready project memos

You must avoid:
- actionable instructions for pathogen enhancement
- toxin production
- evasion of biosafety controls
- increasing virulence, transmissibility, host range, or immune evasion
- detailed wet-lab protocols for harmful biological work
- instructions that enable unsafe or unsupervised experimentation

Keep wet-lab guidance high-level and safety-aware. For side_chat requests, answer the question without claiming to update the official recommendation. Consider whether the next useful step belongs in strain engineering, fermentation, downstream processing, or additional analysis. Do not assume all problems are in strain engineering. Human scientists remain responsible for interpreting evidence and approving experimental decisions.

Return ONLY valid JSON.
Do not use markdown fences.
Do not add commentary outside the JSON.

The JSON must exactly follow this shape:

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
`.trim();

function jsonResponse(data, statusCode = 200, event = null, extraHeaders = {}) {
  return {
    statusCode,
    headers: {
      ...getApiHeaders(event),
      ...extraHeaders
    },
    body: JSON.stringify(data)
  };
}

function getApiHeaders(event) {
  return {
    ...corsHeaders
  };
}

function normalizeEvent(rawEvent) {
  if (Buffer.isBuffer(rawEvent)) {
    const text = rawEvent.toString("utf8");
    try {
      return JSON.parse(text);
    } catch {
      return { rawBody: text };
    }
  }

  if (typeof rawEvent === "string") {
    try {
      return JSON.parse(rawEvent);
    } catch {
      return { rawBody: rawEvent };
    }
  }

  return rawEvent || {};
}

function getRoute(rawEvent) {
  const event = normalizeEvent(rawEvent);

  const requestContext = event.requestContext || {};
  const httpContext = requestContext.http || {};

  const method = String(
    httpContext.method ||
      requestContext.method ||
      requestContext.httpMethod ||
      event.httpMethod ||
      event.method ||
      "GET"
  ).toUpperCase();

  const rawPath =
    httpContext.path ||
    requestContext.path ||
    event.rawPath ||
    event.path ||
    event.requestPath ||
    event.url ||
    "/";

  let path = "/";

  try {
    path = new URL(rawPath, "https://function.local").pathname;
  } catch {
    path = String(rawPath).split("?")[0] || "/";
  }

  return { method, path, event };
}

function getRequestHeader(event, name) {
  const headers = event?.headers || {};
  const target = name.toLowerCase();
  const key = Object.keys(headers).find(
    (headerName) => headerName.toLowerCase() === target
  );

  return key ? String(headers[key]) : "";
}

function getEnvString(env, name) {
  const value = env?.[name];
  return typeof value === "string" ? value.trim() : "";
}

function getOssConfig(env) {
  const requiredNames = [
    "OSS_BUCKET",
    "OSS_REGION",
    "OSS_INTERNAL_ENDPOINT"
  ];
  const missing = requiredNames.filter((name) => !getEnvString(env, name));

  if (missing.length) {
    return { ok: false, missing };
  }

  return {
    ok: true,
    bucket: getEnvString(env, "OSS_BUCKET"),
    region: getEnvString(env, "OSS_REGION"),
    endpoint: getEnvString(env, "OSS_INTERNAL_ENDPOINT"),
    publicEndpoint: getEnvString(env, "OSS_PUBLIC_ENDPOINT")
  };
}

function createOssClient(config, credentials, endpoint = config.endpoint) {
  return new OSS({
    region: config.region,
    endpoint,
    bucket: config.bucket,
    authorizationV4: true,
    accessKeyId: credentials.accessKeyId,
    accessKeySecret: credentials.accessKeySecret,
    stsToken: credentials.securityToken,
    refreshSTSTokenInterval: 30 * 60 * 1000,
    refreshSTSToken: async () => ({
      accessKeyId: credentials.accessKeyId,
      accessKeySecret: credentials.accessKeySecret,
      stsToken: credentials.securityToken
    })
  });
}

function getUserStorageSegment(account) {
  const normalizedAccount = String(account || "").normalize("NFKC");
  const readable = normalizedAccount
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40) || "user";
  const digest = crypto
    .createHash("sha256")
    .update(normalizedAccount, "utf8")
    .digest("hex")
    .slice(0, 16);

  return `${readable}-${digest}`;
}

function sanitizePdfFilename(filename) {
  const source = String(filename || "").normalize("NFKC");
  const basename = source.split(/[\\/]/).pop() || "paper.pdf";
  const withoutControlCharacters = basename.replace(/[\u0000-\u001f\u007f]/g, "");
  let safeName = withoutControlCharacters
    .replace(/[^\p{L}\p{N}._-]+/gu, "-")
    .replace(/^[.-]+/, "")
    .replace(/-+/g, "-")
    .slice(0, 160);

  if (!safeName || safeName.toLowerCase() === ".pdf") {
    safeName = "paper.pdf";
  } else if (!safeName.toLowerCase().endsWith(".pdf")) {
    safeName = `${safeName.replace(/\.[^.]*$/, "") || "paper"}.pdf`;
  }

  return safeName;
}

function buildOwnedPdfObjectKey(account, filename) {
  return [
    "uploads",
    getUserStorageSegment(account),
    crypto.randomUUID(),
    sanitizePdfFilename(filename)
  ].join("/");
}

function isOwnedPdfObjectKey(objectKey, account) {
  if (typeof objectKey !== "string" || objectKey.length > 500) return false;

  const prefix = `uploads/${getUserStorageSegment(account)}/`;
  if (!objectKey.startsWith(prefix)) return false;

  const remainder = objectKey.slice(prefix.length);
  const segments = remainder.split("/");
  if (segments.length !== 2) return false;

  const [objectId, filename] = segments;
  return (
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      objectId
    ) &&
    filename === sanitizePdfFilename(filename) &&
    filename.toLowerCase().endsWith(".pdf")
  );
}

function getObjectFilename(objectKey) {
  return String(objectKey || "").split("/").pop() || "paper.pdf";
}

function getFunctionCredentials(context, env) {
  const contextCredentials = context?.credentials || {};
  const accessKeyId =
    contextCredentials.accessKeyId ||
    contextCredentials.access_key_id ||
    getEnvString(env, "ALIBABA_CLOUD_ACCESS_KEY_ID");
  const accessKeySecret =
    contextCredentials.accessKeySecret ||
    contextCredentials.access_key_secret ||
    getEnvString(env, "ALIBABA_CLOUD_ACCESS_KEY_SECRET");
  const securityToken =
    contextCredentials.securityToken ||
    contextCredentials.security_token ||
    getEnvString(env, "ALIBABA_CLOUD_SECURITY_TOKEN");

  if (!accessKeyId || !accessKeySecret || !securityToken) {
    return null;
  }

  return {
    accessKeyId,
    accessKeySecret,
    securityToken
  };
}

function redactOssErrorMessage(message, credentials) {
  let safeMessage =
    typeof message === "string" && message.trim()
      ? message.trim()
      : "OSS request failed.";

  for (const value of [
    credentials?.accessKeyId,
    credentials?.accessKeySecret,
    credentials?.securityToken
  ]) {
    if (value) {
      safeMessage = safeMessage.split(value).join("[REDACTED]");
    }
  }

  return safeMessage
    .replace(/authorization\s*[:=][^\r\n]*/gi, "authorization=[REDACTED]")
    .slice(0, 600);
}

function getSafeOssError(error, credentials) {
  const code =
    typeof error?.code === "string" && error.code
      ? error.code
      : typeof error?.name === "string" && error.name
        ? error.name
        : "OssError";

  return {
    code: code.slice(0, 120),
    message: redactOssErrorMessage(error?.message, credentials),
    requestId:
      typeof error?.requestId === "string" ? error.requestId.slice(0, 160) : "",
    status:
      Number.isInteger(error?.status) && error.status >= 100
        ? error.status
        : null
  };
}

function logOssFailure(stage, error, details = {}) {
  const safeError = getSafeOssError(error, details.credentials);

  console.error("OSS test failed:", {
    stage,
    error: safeError.code,
    message: safeError.message,
    status: safeError.status,
    ossRequestId: safeError.requestId || undefined,
    functionRequestId: details.functionRequestId || undefined,
    bucket: details.bucket || undefined,
    key: details.key || undefined
  });

  return safeError;
}

function ossErrorResponse(event, stage, safeError, statusCode = 502) {
  return jsonResponse(
    {
      ok: false,
      stage,
      error: safeError.code,
      message: safeError.message,
      ...(safeError.requestId ? { requestId: safeError.requestId } : {})
    },
    statusCode,
    event
  );
}

async function handleOssTest(event, context, env) {
  const config = getOssConfig(env);

  if (!config.ok) {
    console.error("OSS test failed:", {
      stage: "configuration",
      error: "MissingEnvironmentVariables",
      missing: config.missing,
      functionRequestId: context?.requestId || undefined
    });
    return jsonResponse(
      {
        ok: false,
        stage: "configuration",
        error: "MissingEnvironmentVariables",
        message: `Missing required environment variables: ${config.missing.join(", ")}`
      },
      500,
      event
    );
  }

  const credentials = getFunctionCredentials(context, env);

  if (!credentials) {
    console.error("OSS test failed:", {
      stage: "clientInitialization",
      error: "CredentialUnavailable",
      functionRequestId: context?.requestId || undefined,
      bucket: config.bucket
    });
    return jsonResponse(
      {
        ok: false,
        stage: "clientInitialization",
        error: "CredentialUnavailable",
        message:
          "Function Compute RAM role credentials were not available to the runtime."
      },
      500,
      event
    );
  }

  let client;

  try {
    client = new OSS({
      region: config.region,
      endpoint: config.endpoint,
      bucket: config.bucket,
      authorizationV4: true,
      accessKeyId: credentials.accessKeyId,
      accessKeySecret: credentials.accessKeySecret,
      stsToken: credentials.securityToken
    });
  } catch (error) {
    const safeError = logOssFailure("clientInitialization", error, {
      credentials,
      functionRequestId: context?.requestId,
      bucket: config.bucket
    });
    return ossErrorResponse(event, "clientInitialization", safeError, 500);
  }

  const timestamp = new Date().toISOString();
  const key = `test/hello-${timestamp.replace(/[:.]/g, "-")}.txt`;
  const content =
    `Hello from BioDesign Copilot Function Compute.\n` +
    `Timestamp: ${timestamp}`;

  try {
    await client.put(key, Buffer.from(content, "utf8"), {
      headers: {
        "Content-Type": "text/plain; charset=utf-8"
      }
    });
  } catch (error) {
    const safeError = logOssFailure("putObject", error, {
      credentials,
      functionRequestId: context?.requestId,
      bucket: config.bucket,
      key
    });
    return ossErrorResponse(event, "putObject", safeError);
  }

  let downloadedContent;

  try {
    const result = await client.get(key);
    downloadedContent = Buffer.isBuffer(result.content)
      ? result.content.toString("utf8")
      : String(result.content ?? "");
  } catch (error) {
    const safeError = logOssFailure("getObject", error, {
      credentials,
      functionRequestId: context?.requestId,
      bucket: config.bucket,
      key
    });
    return ossErrorResponse(event, "getObject", safeError);
  }

  const verified = downloadedContent === content;

  if (!verified) {
    console.error("OSS test failed:", {
      stage: "getObject",
      error: "ContentMismatch",
      functionRequestId: context?.requestId || undefined,
      bucket: config.bucket,
      key
    });
    return jsonResponse(
      {
        ok: false,
        stage: "getObject",
        error: "ContentMismatch",
        message: "The object was uploaded, but the downloaded content did not match."
      },
      502,
      event
    );
  }

  return jsonResponse(
    {
      ok: true,
      bucket: config.bucket,
      key,
      verified: true,
      content: downloadedContent,
      message: "OSS write/read test succeeded"
    },
    200,
    event
  );
}

function documentErrorResponse(
  event,
  stage,
  error,
  message,
  statusCode = 500,
  extra = {}
) {
  return jsonResponse(
    {
      ok: false,
      stage,
      error,
      message,
      ...extra
    },
    statusCode,
    event
  );
}

function logDocumentFailure(stage, error, details = {}) {
  const safeError = details.credentials
    ? getSafeOssError(error, details.credentials)
    : {
        code:
          typeof error?.code === "string"
            ? error.code
            : typeof error?.name === "string"
              ? error.name
              : "DocumentError",
        message: String(error?.message || "Document processing failed.").slice(
          0,
          600
        ),
        requestId: "",
        status: null
      };

  console.error("PDF document operation failed:", {
    stage,
    error: safeError.code,
    message: safeError.message,
    status: safeError.status,
    ossRequestId: safeError.requestId || undefined,
    functionRequestId: details.functionRequestId || undefined,
    key: details.key || undefined,
    chunk: details.chunk || undefined
  });

  return safeError;
}

async function handlePdfUploadUrl(event, context, env, user) {
  const body = getRequestBody(event);
  const filename = typeof body.filename === "string" ? body.filename.trim() : "";
  const contentType =
    typeof body.contentType === "string" ? body.contentType.toLowerCase().trim() : "";
  const size = Number(body.size);

  if (!filename || !filename.toLowerCase().endsWith(".pdf")) {
    return documentErrorResponse(
      event,
      "upload",
      "UnsupportedFileType",
      "Only PDF files can be uploaded.",
      415
    );
  }

  if (contentType !== "application/pdf") {
    return documentErrorResponse(
      event,
      "upload",
      "UnsupportedContentType",
      "The upload Content-Type must be application/pdf.",
      415
    );
  }

  if (!Number.isInteger(size) || size <= 0 || size > MAX_PDF_UPLOAD_BYTES) {
    return documentErrorResponse(
      event,
      "upload",
      "InvalidFileSize",
      `PDF size must be between 1 byte and ${MAX_PDF_UPLOAD_BYTES} bytes.`,
      413,
      { maxBytes: MAX_PDF_UPLOAD_BYTES }
    );
  }

  const config = getOssConfig(env);
  if (!config.ok || !config.publicEndpoint) {
    const missing = [
      ...(config.missing || []),
      ...(!config.publicEndpoint ? ["OSS_PUBLIC_ENDPOINT"] : [])
    ];
    return documentErrorResponse(
      event,
      "upload",
      "MissingEnvironmentVariables",
      `Missing required environment variables: ${missing.join(", ")}`,
      500
    );
  }

  const credentials = getFunctionCredentials(context, env);
  if (!credentials) {
    return documentErrorResponse(
      event,
      "upload",
      "CredentialUnavailable",
      "Function Compute RAM role credentials were not available to the runtime.",
      500
    );
  }

  const objectKey = buildOwnedPdfObjectKey(user.account, filename);

  try {
    const client = createOssClient(config, credentials, config.publicEndpoint);
    const uploadUrl = await client.signatureUrlV4(
      "PUT",
      PDF_UPLOAD_URL_TTL_SECONDS,
      {
        headers: {
          "Content-Type": "application/pdf",
          "Content-Length": size
        }
      },
      objectKey,
      ["Content-Length", "Content-Type"]
    );

    return jsonResponse(
      {
        ok: true,
        objectKey,
        filename: getObjectFilename(objectKey),
        uploadUrl,
        method: "PUT",
        headers: {
          "Content-Type": "application/pdf"
        },
        expectedSize: size,
        expiresIn: PDF_UPLOAD_URL_TTL_SECONDS,
        maxBytes: MAX_PDF_UPLOAD_BYTES
      },
      200,
      event
    );
  } catch (error) {
    const safeError = logDocumentFailure("upload", error, {
      credentials,
      functionRequestId: context?.requestId,
      key: objectKey
    });
    return documentErrorResponse(
      event,
      "upload",
      safeError.code,
      safeError.message,
      500
    );
  }
}

function getOssObjectSize(metadata) {
  const headers = metadata?.res?.headers || {};
  const rawSize = headers["content-length"] ?? headers["x-oss-object-size"];
  const size = Number(rawSize);
  return Number.isFinite(size) && size >= 0 ? size : null;
}

function getOssObjectContentType(metadata) {
  const headers = metadata?.res?.headers || {};
  return String(headers["content-type"] || "").toLowerCase();
}

function isMissingOssObjectError(error) {
  return (
    error?.status === 404 ||
    ["NoSuchKey", "NoSuchObject", "NotFound"].includes(error?.code)
  );
}

async function readOwnedPdfFromOss({ objectKey, user, context, env }) {
  if (!isOwnedPdfObjectKey(objectKey, user.account)) {
    return {
      ok: false,
      statusCode: 403,
      stage: "ossRead",
      error: "ObjectAccessDenied",
      message: "The requested PDF does not belong to the authenticated account."
    };
  }

  const config = getOssConfig(env);
  if (!config.ok) {
    return {
      ok: false,
      statusCode: 500,
      stage: "ossRead",
      error: "MissingEnvironmentVariables",
      message: `Missing required environment variables: ${config.missing.join(", ")}`
    };
  }

  const credentials = getFunctionCredentials(context, env);
  if (!credentials) {
    return {
      ok: false,
      statusCode: 500,
      stage: "ossRead",
      error: "CredentialUnavailable",
      message: "Function Compute RAM role credentials were not available to the runtime."
    };
  }

  let client;
  try {
    client = createOssClient(config, credentials);
  } catch (error) {
    const safeError = logDocumentFailure("ossRead", error, {
      credentials,
      functionRequestId: context?.requestId,
      key: objectKey
    });
    return {
      ok: false,
      statusCode: 500,
      stage: "ossRead",
      error: safeError.code,
      message: safeError.message
    };
  }

  let metadata;
  try {
    metadata = await client.getObjectMeta(objectKey);
  } catch (error) {
    const safeError = logDocumentFailure("ossRead", error, {
      credentials,
      functionRequestId: context?.requestId,
      key: objectKey
    });
    return {
      ok: false,
      statusCode: isMissingOssObjectError(error) ? 404 : 502,
      stage: "ossRead",
      error: isMissingOssObjectError(error) ? "ObjectNotFound" : safeError.code,
      message: isMissingOssObjectError(error)
        ? "The uploaded PDF was not found in OSS."
        : safeError.message
    };
  }

  const metadataSize = getOssObjectSize(metadata);
  if (metadataSize === null) {
    return {
      ok: false,
      statusCode: 502,
      stage: "ossRead",
      error: "ObjectSizeUnavailable",
      message: "OSS did not return a usable PDF object size."
    };
  }

  if (metadataSize <= 0 || metadataSize > MAX_PDF_UPLOAD_BYTES) {
    return {
      ok: false,
      statusCode: metadataSize > MAX_PDF_UPLOAD_BYTES ? 413 : 422,
      stage: "ossRead",
      error: metadataSize > MAX_PDF_UPLOAD_BYTES ? "PdfTooLarge" : "EmptyPdf",
      message:
        metadataSize > MAX_PDF_UPLOAD_BYTES
          ? `The stored PDF exceeds the ${MAX_PDF_UPLOAD_BYTES}-byte processing limit.`
          : "The stored PDF is empty."
    };
  }

  const metadataContentType = getOssObjectContentType(metadata);
  if (metadataContentType && !metadataContentType.includes("application/pdf")) {
    return {
      ok: false,
      statusCode: 415,
      stage: "ossRead",
      error: "UnsupportedFileType",
      message: "The stored object is not an application/pdf file."
    };
  }

  try {
    const result = await client.get(objectKey);
    const buffer = Buffer.isBuffer(result.content)
      ? result.content
      : Buffer.from(result.content || "");

    if (buffer.length !== metadataSize || buffer.length > MAX_PDF_UPLOAD_BYTES) {
      return {
        ok: false,
        statusCode: buffer.length > MAX_PDF_UPLOAD_BYTES ? 413 : 502,
        stage: "ossRead",
        error:
          buffer.length > MAX_PDF_UPLOAD_BYTES
            ? "PdfTooLarge"
            : "ObjectSizeMismatch",
        message:
          buffer.length > MAX_PDF_UPLOAD_BYTES
            ? `The stored PDF exceeds the ${MAX_PDF_UPLOAD_BYTES}-byte processing limit.`
            : "The downloaded PDF size did not match OSS metadata."
      };
    }

    if (buffer.subarray(0, 5).toString("ascii") !== "%PDF-") {
      return {
        ok: false,
        statusCode: 415,
        stage: "ossRead",
        error: "UnsupportedFileType",
        message: "The stored object does not have a valid PDF file signature."
      };
    }

    return {
      ok: true,
      buffer,
      size: buffer.length,
      filename: getObjectFilename(objectKey)
    };
  } catch (error) {
    const safeError = logDocumentFailure("ossRead", error, {
      credentials,
      functionRequestId: context?.requestId,
      key: objectKey
    });
    return {
      ok: false,
      statusCode: isMissingOssObjectError(error) ? 404 : 502,
      stage: "ossRead",
      error: isMissingOssObjectError(error) ? "ObjectNotFound" : safeError.code,
      message: isMissingOssObjectError(error)
        ? "The uploaded PDF was not found in OSS."
        : safeError.message
    };
  }
}

function normalizePdfText(text) {
  return String(text || "")
    .replace(/\u0000/g, "")
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function normalizePdfMetadataTitle(value) {
  const title = String(value || "").replace(/\s+/g, " ").trim();
  if (!title || /^untitled$/i.test(title) || title.length > 300) return null;
  return title;
}

function classifyPdfParseError(error) {
  if (
    error?.name === "PasswordException" ||
    /password|encrypted/i.test(error?.message || "")
  ) {
    return {
      error: "EncryptedPdf",
      message: "Encrypted or password-protected PDFs are not supported.",
      statusCode: 422
    };
  }

  if (
    ["InvalidPDFException", "FormatError"].includes(error?.name)
  ) {
    return {
      error: "MalformedPdf",
      message: "The PDF is malformed or could not be parsed.",
      statusCode: 422
    };
  }

  return {
    error: error?.code === "PdfParseTimeout" ? "PdfParseTimeout" : "PdfParseFailed",
    message:
      error?.code === "PdfParseTimeout"
        ? "PDF text extraction exceeded the processing time limit."
        : "The PDF text could not be extracted.",
    statusCode: error?.code === "PdfParseTimeout" ? 504 : 422
  };
}

function withPdfParseTimeout(promise) {
  let timeoutId;
  const timeoutPromise = new Promise((_, reject) => {
    timeoutId = setTimeout(() => {
      const error = new Error("PDF parsing timed out.");
      error.code = "PdfParseTimeout";
      reject(error);
    }, PDF_PARSE_TIMEOUT_MS);
  });

  return Promise.race([promise, timeoutPromise]).finally(() => {
    clearTimeout(timeoutId);
  });
}

async function extractPdfDocument(buffer) {
  let pdf;

  try {
    const data = new Uint8Array(
      buffer.buffer,
      buffer.byteOffset,
      buffer.byteLength
    );
    pdf = await withPdfParseTimeout(
      getDocumentProxy(data, {
        maxImageSize: 16_777_216,
        stopAtErrors: true
      })
    );
    const pageCount = Number(pdf.numPages || 0) || null;

    if (pageCount && pageCount > MAX_PDF_PAGES) {
      return {
        ok: false,
        statusCode: 413,
        stage: "pdfParse",
        error: "PdfTooManyPages",
        message: `The PDF has more than the ${MAX_PDF_PAGES}-page processing limit.`
      };
    }

    const [metadataResult, textResult] = await withPdfParseTimeout(
      Promise.all([
        getMeta(pdf),
        extractText(pdf, { mergePages: true })
      ])
    );
    const text = normalizePdfText(textResult.text);

    if (!text) {
      return {
        ok: false,
        statusCode: 422,
        stage: "pdfParse",
        error: "PdfNoText",
        message:
          "No embedded text was found. The PDF may be scanned or image-only; OCR is not enabled."
      };
    }

    if (text.length < MIN_MACHINE_READABLE_PDF_CHARACTERS) {
      return {
        ok: false,
        statusCode: 422,
        stage: "pdfParse",
        error: "PdfInsufficientText",
        message:
          "Too little embedded text was found for a reliable review. The PDF may be scanned or image-only; OCR is not enabled."
      };
    }

    return {
      ok: true,
      text,
      pageCount: Number(textResult.totalPages || pageCount || 0) || null,
      metadataTitle: normalizePdfMetadataTitle(metadataResult?.info?.Title)
    };
  } catch (error) {
    const classified = classifyPdfParseError(error);
    return {
      ok: false,
      statusCode: classified.statusCode,
      stage: "pdfParse",
      error: classified.error,
      message: classified.message,
      cause: error
    };
  } finally {
    if (typeof pdf?.destroy === "function") {
      await pdf.destroy().catch(() => {});
    }
  }
}

function chunkPdfText(text) {
  const source = text.slice(0, MAX_PDF_REVIEW_CHARACTERS);
  const chunks = [];
  let start = 0;

  while (start < source.length) {
    let end = Math.min(start + PDF_REVIEW_CHUNK_CHARACTERS, source.length);

    if (end < source.length) {
      const paragraphBreak = source.lastIndexOf("\n\n", end);
      const sentenceBreak = source.lastIndexOf(". ", end);
      const preferredBreak = Math.max(paragraphBreak, sentenceBreak);

      if (preferredBreak > start + PDF_REVIEW_CHUNK_CHARACTERS * 0.65) {
        end = preferredBreak + (preferredBreak === sentenceBreak ? 1 : 0);
      }
    }

    const chunk = source.slice(start, end).trim();
    if (chunk) chunks.push(chunk);
    if (end >= source.length) break;

    start = Math.max(start + 1, end - PDF_REVIEW_CHUNK_OVERLAP);
  }

  return {
    chunks,
    truncated: text.length > source.length,
    processedCharacters: source.length
  };
}

function parseModelJson(text) {
  if (typeof text !== "string" || !text.trim()) return null;

  try {
    const parsed = JSON.parse(text);
    return isPlainObject(parsed) ? parsed : null;
  } catch {
    const extracted = extractFirstJsonObject(text);
    if (!extracted) return null;

    try {
      const parsed = JSON.parse(extracted);
      return isPlainObject(parsed) ? parsed : null;
    } catch {
      return null;
    }
  }
}

function normalizeReviewText(value) {
  const text = typeof value === "string" ? value.trim() : "";
  return text || null;
}

function normalizeReviewList(value) {
  return Array.isArray(value)
    ? value
        .filter((item) => typeof item === "string" && item.trim())
        .map((item) => item.trim().slice(0, 1200))
        .slice(0, 12)
    : [];
}

function normalizePaperReview(review, fallbackTitle, fallbackSummary = "") {
  const source = isPlainObject(review) ? review : {};
  return {
    title: fallbackTitle || null,
    summary:
      normalizeReviewText(source.summary) ||
      normalizeReviewText(fallbackSummary) ||
      "The model did not return a paper summary.",
    research_question: normalizeReviewText(source.research_question),
    methods: normalizeReviewText(source.methods),
    key_results: normalizeReviewList(source.key_results),
    limitations: normalizeReviewList(source.limitations),
    main_conclusion: normalizeReviewText(source.main_conclusion)
  };
}

async function mapWithConcurrency(items, concurrency, mapper) {
  const results = new Array(items.length);
  let nextIndex = 0;

  async function worker() {
    while (nextIndex < items.length) {
      const currentIndex = nextIndex;
      nextIndex += 1;
      results[currentIndex] = await mapper(items[currentIndex], currentIndex);
    }
  }

  const workerCount = Math.min(concurrency, items.length);
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return results;
}

async function callRequestyText(messages, env, temperature = 0.2) {
  const apiKey = getEnvString(env, "REQUESTY_API_KEY");
  const model = getEnvString(env, "REQUESTY_MODEL");

  if (!apiKey || !model) {
    return {
      ok: false,
      error: "MissingLlmConfiguration",
      message: "Missing REQUESTY_API_KEY or REQUESTY_MODEL environment variable."
    };
  }

  let response;
  try {
    response = await fetch(REQUESTY_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`
      },
      body: JSON.stringify({ model, messages, temperature })
    });
  } catch (error) {
    return {
      ok: false,
      error: "LlmRequestFailed",
      message: String(error?.message || "The LLM request failed.").slice(0, 500)
    };
  }

  if (!response.ok) {
    return {
      ok: false,
      error: "LlmHttpError",
      message: `Requesty returned HTTP ${response.status}.`,
      status: response.status
    };
  }

  let responseJson;
  try {
    responseJson = await response.json();
  } catch {
    return {
      ok: false,
      error: "InvalidLlmResponse",
      message: "Requesty returned invalid JSON."
    };
  }

  const text = responseJson?.choices?.[0]?.message?.content;
  if (typeof text !== "string" || !text.trim()) {
    return {
      ok: false,
      error: "EmptyLlmResponse",
      message: "Requesty did not return assistant content."
    };
  }

  return { ok: true, text: text.trim() };
}

async function reviewPdfWithLlm({
  text,
  filename,
  trustedTitle,
  language,
  context,
  env
}) {
  const chunkResult = chunkPdfText(text);
  if (!chunkResult.chunks.length) {
    console.error("PDF document operation failed:", {
      stage: "chunk",
      error: "NoPdfChunks",
      functionRequestId: context?.requestId || undefined
    });
    return {
      ok: false,
      statusCode: 422,
      stage: "chunk",
      error: "NoPdfChunks",
      message: "No usable PDF text chunks were produced."
    };
  }

  console.log("PDF review chunking complete:", {
    functionRequestId: context?.requestId || undefined,
    chunks: chunkResult.chunks.length,
    processedCharacters: chunkResult.processedCharacters,
    truncated: chunkResult.truncated
  });

  const languageInstruction =
    language === "zh"
      ? "Write all JSON values in Simplified Chinese."
      : "Write all JSON values in English.";

  let chunkSummaries;
  try {
    chunkSummaries = await mapWithConcurrency(
      chunkResult.chunks,
      PDF_REVIEW_CONCURRENCY,
      async (chunk, index) => {
        const result = await callRequestyText(
          [
            {
              role: "system",
              content:
                "You extract evidence from one excerpt of an academic paper. Use only information explicitly present in the excerpt. Do not fill missing fields by inference. Describe methods at a review level without adding operational harmful-biological instructions. Return only JSON with keys summary, research_question, methods, key_results, limitations, and main_conclusion. Missing scalar fields must be null and missing list fields must be empty arrays. Keep the response concise."
            },
            {
              role: "user",
              content: `${languageInstruction}\nFile: ${filename}\nExcerpt ${index + 1} of ${chunkResult.chunks.length}:\n\n${chunk}`
            }
          ],
          env,
          0.1
        );

        if (!result.ok) {
          const error = new Error(result.message);
          error.code = result.error;
          error.chunk = index + 1;
          throw error;
        }

        return parseModelJson(result.text) || {
          summary: result.text.slice(0, 4000),
          research_question: null,
          methods: null,
          key_results: [],
          limitations: [],
          main_conclusion: null
        };
      }
    );
  } catch (error) {
    logDocumentFailure("llmChunkSummary", error, {
      functionRequestId: context?.requestId,
      chunk: error.chunk
    });
    return {
      ok: false,
      statusCode: 502,
      stage: "llmChunkSummary",
      error: error.code || "LlmChunkSummaryFailed",
      message: String(error.message || "A PDF chunk could not be summarized.").slice(
        0,
        500
      )
    };
  }

  const finalResult = await callRequestyText(
    [
      {
        role: "system",
        content:
          "You combine evidence summaries from an academic paper into a faithful scientific review. Use only the supplied chunk summaries. Resolve overlap without inventing facts. Keep methods at a descriptive review level and do not add operational harmful-biological instructions. Return only JSON with keys summary, research_question, methods, key_results, limitations, and main_conclusion. Missing scalar fields must be null and missing list fields must be empty arrays."
      },
      {
        role: "user",
        content: `${languageInstruction}\nFile: ${filename}\nTrusted title: ${trustedTitle || "not available"}\n\nChunk summaries:\n${JSON.stringify(chunkSummaries)}`
      }
    ],
    env,
    0.1
  );

  if (!finalResult.ok) {
    logDocumentFailure(
      "llmFinalSummary",
      Object.assign(new Error(finalResult.message), { code: finalResult.error }),
      { functionRequestId: context?.requestId }
    );
    return {
      ok: false,
      statusCode: 502,
      stage: "llmFinalSummary",
      error: finalResult.error,
      message: finalResult.message
    };
  }

  const parsedFinal = parseModelJson(finalResult.text);
  return {
    ok: true,
    review: normalizePaperReview(
      parsedFinal,
      trustedTitle,
      parsedFinal ? "" : finalResult.text
    ),
    chunks: chunkResult.chunks.length,
    processedCharacters: chunkResult.processedCharacters,
    truncated: chunkResult.truncated
  };
}

async function handlePdfReview(event, context, env, user) {
  const body = getRequestBody(event);
  const objectKey =
    typeof body.objectKey === "string" ? body.objectKey.trim() : "";
  const language = body.language === "zh" ? "zh" : "en";

  if (!objectKey) {
    return documentErrorResponse(
      event,
      "ossRead",
      "ObjectKeyRequired",
      "An OSS PDF object key is required.",
      400
    );
  }

  const objectResult = await readOwnedPdfFromOss({
    objectKey,
    user,
    context,
    env
  });
  if (!objectResult.ok) {
    return documentErrorResponse(
      event,
      objectResult.stage,
      objectResult.error,
      objectResult.message,
      objectResult.statusCode
    );
  }

  const pdfResult = await extractPdfDocument(objectResult.buffer);
  if (!pdfResult.ok) {
    if (pdfResult.cause) {
      logDocumentFailure("pdfParse", pdfResult.cause, {
        functionRequestId: context?.requestId,
        key: objectKey
      });
    }
    return documentErrorResponse(
      event,
      pdfResult.stage,
      pdfResult.error,
      pdfResult.message,
      pdfResult.statusCode
    );
  }

  const filenameTitle = objectResult.filename.replace(/\.pdf$/i, "") || null;
  const trustedTitle = pdfResult.metadataTitle || filenameTitle;
  const reviewResult = await reviewPdfWithLlm({
    text: pdfResult.text,
    filename: objectResult.filename,
    trustedTitle,
    language,
    context,
    env
  });
  if (!reviewResult.ok) {
    return documentErrorResponse(
      event,
      reviewResult.stage,
      reviewResult.error,
      reviewResult.message,
      reviewResult.statusCode
    );
  }

  return jsonResponse(
    {
      ok: true,
      objectKey,
      filename: objectResult.filename,
      size: objectResult.size,
      pageCount: pdfResult.pageCount,
      extractedCharacterCount: pdfResult.text.length,
      processedCharacterCount: reviewResult.processedCharacters,
      chunks: reviewResult.chunks,
      truncated: reviewResult.truncated,
      ...reviewResult.review,
      message: "PDF review succeeded; the source PDF remains stored in OSS."
    },
    200,
    event
  );
}

async function loadStoredPdfsForChat({ documents, user, context, env }) {
  const descriptors = Array.isArray(documents)
    ? documents.slice(0, MAX_STORED_PDF_DOCUMENTS)
    : [];
  const loadedDocuments = [];
  let remainingCharacters = TOTAL_REFERENCE_TEXT_LIMIT;

  for (const descriptor of descriptors) {
    if (remainingCharacters <= 0) break;

    const objectKey =
      typeof descriptor?.objectKey === "string"
        ? descriptor.objectKey.trim()
        : "";
    if (!objectKey) continue;

    const objectResult = await readOwnedPdfFromOss({
      objectKey,
      user,
      context,
      env
    });
    if (!objectResult.ok) return objectResult;

    const pdfResult = await extractPdfDocument(objectResult.buffer);
    if (!pdfResult.ok) {
      return {
        ok: false,
        statusCode: pdfResult.statusCode,
        stage: pdfResult.stage,
        error: pdfResult.error,
        message: pdfResult.message
      };
    }

    const text = pdfResult.text.slice(0, remainingCharacters);
    remainingCharacters -= text.length;
    loadedDocuments.push({
      filename: objectResult.filename,
      type: "application/pdf",
      text,
      truncated: text.length < pdfResult.text.length,
      module: normalizeExperimentModuleKey(descriptor?.module)
    });
  }

  return { ok: true, documents: loadedDocuments };
}

function getRequestBody(event) {
  if (!event) return {};

  if (event.body) {
    let bodyText = event.body;

    if (event.isBase64Encoded) {
      bodyText = Buffer.from(bodyText, "base64").toString("utf8");
    }

    if (typeof bodyText === "object") {
      return bodyText;
    }

    try {
      return JSON.parse(bodyText);
    } catch {
      return {};
    }
  }

  if (event.rawBody) {
    try {
      return JSON.parse(event.rawBody);
    } catch {
      return {};
    }
  }

  return {};
}

function getAuthConfig(env) {
  const adminAccount = getEnvString(env, "ADMIN_ACCOUNT");
  const adminPasswordHash = getEnvString(env, "ADMIN_PASSWORD_HASH");
  const jwtSecret = getEnvString(env, "JWT_SECRET");

  if (!adminAccount || !adminPasswordHash || !jwtSecret) {
    return {
      error:
        "Authentication is not configured. Missing ADMIN_ACCOUNT, ADMIN_PASSWORD_HASH, or JWT_SECRET."
    };
  }

  return {
    adminAccount,
    adminPasswordHash,
    jwtSecret
  };
}

function getJwtConfig(env) {
  const jwtSecret = getEnvString(env, "JWT_SECRET");

  if (!jwtSecret) {
    return {
      error: "Authentication is not configured. Missing JWT_SECRET."
    };
  }

  return { jwtSecret };
}

async function handleLogin(event, env) {
  const authConfig = getAuthConfig(env);

  if (authConfig.error) {
    return jsonResponse(
      {
        error: authConfig.error
      },
      500,
      event
    );
  }

  const body = getRequestBody(event);
  const account = typeof body.account === "string" ? body.account.trim() : "";
  const password = typeof body.password === "string" ? body.password : "";

  if (!account || !password) {
    return jsonResponse(
      {
        error: "Account and password are required."
      },
      400,
      event
    );
  }

  const bcrypt = require("bcryptjs");
  const passwordMatches = bcrypt.compareSync(
    password,
    authConfig.adminPasswordHash
  );

  if (account !== authConfig.adminAccount || !passwordMatches) {
    return jsonResponse(
      {
        error: "Invalid account or password"
      },
      401,
      event
    );
  }

  const user = {
    account,
    role: "admin"
  };
  const token = signAuthToken(user, authConfig.jwtSecret);

  return jsonResponse(
    {
      ok: true,
      token,
      user
    },
    200,
    event
  );
}

function handleMe(event, env) {
  if (!getBearerToken(event)) {
    return unauthorizedResponse(event);
  }

  const jwtConfig = getJwtConfig(env);

  if (jwtConfig.error) {
    return jsonResponse(
      {
        error: jwtConfig.error
      },
      500,
      event
    );
  }

  const user = verifyAuthToken(event, jwtConfig.jwtSecret);

  if (!user) {
    return unauthorizedResponse(event);
  }

  return jsonResponse(
    {
      user
    },
    200,
    event
  );
}

function unauthorizedResponse(event) {
  return jsonResponse(
    {
      error: "Unauthorized"
    },
    401,
    event
  );
}

function internalServerErrorResponse(event) {
  return jsonResponse(
    {
      error: "Internal server error"
    },
    500,
    event
  );
}

function handleLogout(event) {
  return jsonResponse(
    {
      ok: true
    },
    200,
    event
  );
}

function requireAuth(req, env) {
  const jwtConfig = getJwtConfig(env);

  if (jwtConfig.error) {
    return {
      ok: false,
      response: jsonResponse(
        {
          error: jwtConfig.error
        },
        500,
        req
      )
    };
  }

  const user = verifyAuthToken(req, jwtConfig.jwtSecret);

  if (!user) {
    return {
      ok: false,
      response: unauthorizedResponse(req)
    };
  }

  req.user = user;
  return {
    ok: true,
    user
  };
}

function signAuthToken(user, jwtSecret) {
  const jwt = require("jsonwebtoken");

  return jwt.sign(
    {
      account: user.account,
      role: user.role
    },
    jwtSecret,
    {
      expiresIn: "12h"
    }
  );
}

function verifyAuthToken(event, jwtSecret) {
  const token = getBearerToken(event);

  if (!token) {
    return null;
  }

  try {
    const jwt = require("jsonwebtoken");
    const payload = jwt.verify(token, jwtSecret);

    if (
      !payload ||
      typeof payload.account !== "string" ||
      payload.role !== "admin"
    ) {
      return null;
    }

    return {
      account: payload.account,
      role: "admin"
    };
  } catch {
    return null;
  }
}

function getBearerToken(event) {
  const authorization = getRequestHeader(event, "authorization");
  const match = authorization.match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : "";
}

function makeFallbackResponse(reason) {
  return {
    reply:
      "I could not complete the Requesty-backed review just now. I generated a safe fallback response instead. Please retry after the backend configuration or network issue is resolved.",
    project: {
      summary: "Requesty-backed review unavailable.",
      organism: "Not assessed",
      missingInformation: [
        "Successful Requesty model response",
        reason || "Unknown backend issue"
      ],
      safetyLevel: "Not assessed",
      safetyNotes:
        "No biological design review was completed. Keep any experimental planning high-level and ensure appropriate human safety review before wet-lab work.",
      draftMemo:
        "BioDesign Copilot could not generate a Requesty-backed memo because the backend request failed."
    }
  };
}

function validateResponseShape(parsed) {
  if (!parsed || typeof parsed !== "object") return false;
  if (typeof parsed.reply !== "string") return false;
  if (!parsed.project || typeof parsed.project !== "object") return false;

  const project = parsed.project;

  return (
    typeof project.summary === "string" &&
    typeof project.organism === "string" &&
    Array.isArray(project.missingInformation) &&
    typeof project.safetyLevel === "string" &&
    typeof project.safetyNotes === "string" &&
    typeof project.draftMemo === "string"
  );
}

function extractFirstJsonObject(text) {
  if (!text || typeof text !== "string") return null;

  const firstBrace = text.indexOf("{");
  if (firstBrace === -1) return null;

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = firstBrace; i < text.length; i++) {
    const char = text[i];

    if (escaped) {
      escaped = false;
      continue;
    }

    if (char === "\\") {
      escaped = true;
      continue;
    }

    if (char === '"') {
      inString = !inString;
      continue;
    }

    if (!inString) {
      if (char === "{") depth++;
      if (char === "}") depth--;

      if (depth === 0) {
        return text.slice(firstBrace, i + 1);
      }
    }
  }

  return null;
}

function parseModelResponse(modelText) {
  try {
    const parsed = JSON.parse(modelText);
    if (validateResponseShape(parsed)) return parsed;
  } catch {
    // Continue to extraction fallback.
  }

  const extracted = extractFirstJsonObject(modelText);

  if (extracted) {
    try {
      const parsed = JSON.parse(extracted);
      if (validateResponseShape(parsed)) return parsed;
    } catch {
      // Continue to final fallback.
    }
  }

  return null;
}

function sanitizeReferenceDocuments(referenceDocuments) {
  return sanitizeUploadedDocuments(
    referenceDocuments,
    MAX_REFERENCE_DOCUMENTS,
    TOTAL_REFERENCE_TEXT_LIMIT,
    "unnamed-reference"
  );
}

function sanitizeExperimentDocuments(experimentDocuments) {
  return sanitizeUploadedDocuments(
    experimentDocuments,
    MAX_EXPERIMENT_DOCUMENTS,
    TOTAL_EXPERIMENT_TEXT_LIMIT,
    "unnamed-experiment-file"
  );
}

function sanitizeUploadedDocuments(documents, maxDocuments, totalTextLimit, fallbackName) {
  let remainingCharacters = totalTextLimit;

  return documents
    .slice(0, maxDocuments)
    .filter(
      (document) =>
        document &&
        typeof document.text === "string" &&
        document.text.trim()
    )
    .map((document) => {
      const sourceText = document.text.trim();
      const text = sourceText.slice(0, remainingCharacters);
      remainingCharacters = Math.max(0, remainingCharacters - text.length);

      return {
        filename:
          typeof document.filename === "string" && document.filename.trim()
            ? document.filename.trim().slice(0, 180)
            : fallbackName,
        type:
          typeof document.type === "string" && document.type.trim()
            ? document.type.trim().slice(0, 120)
            : "text/plain",
        text,
        truncated: Boolean(document.truncated || text.length < sourceText.length),
        module: normalizeExperimentModuleKey(document.module)
      };
    })
    .filter((document) => document.text);
}

function sanitizeExperimentNotes(experimentNotes) {
  return experimentNotes
    .slice(0, MAX_EXPERIMENT_NOTES)
    .filter((note) => note && typeof note.text === "string" && note.text.trim())
    .map((note) => ({
      text: note.text.trim().slice(0, 3000),
      createdAt:
        typeof note.createdAt === "string" ? note.createdAt.slice(0, 80) : "",
      module: normalizeExperimentModuleKey(note.module)
    }));
}

function sanitizeExperimentModules(experimentModules) {
  return Object.keys(EXPERIMENT_MODULE_LABELS).reduce((modules, moduleKey) => {
    const rawModule = isPlainObject(experimentModules[moduleKey])
      ? experimentModules[moduleKey]
      : {};
    const rawDocuments = Array.isArray(rawModule.documents)
      ? rawModule.documents
      : [];
    const rawNotes = Array.isArray(rawModule.notes) ? rawModule.notes : [];

    modules[moduleKey] = {
      label: EXPERIMENT_MODULE_LABELS[moduleKey],
      documents: sanitizeExperimentDocuments(
        rawDocuments.map((document) => ({ ...document, module: moduleKey }))
      ),
      notes: sanitizeExperimentNotes(
        rawNotes.map((note) => ({ ...note, module: moduleKey }))
      )
    };

    return modules;
  }, {});
}

function buildDocumentContext(label, documents) {
  if (!documents.length) return null;

  const sections = documents.map((document, index) => {
    const truncatedNote = document.truncated ? " (truncated)" : "";
    const moduleNote = document.module ? ` | module: ${document.module}` : "";
    return `${label} ${index + 1}: ${document.filename} [${document.type}]${moduleNote}${truncatedNote}\n${document.text}`;
  });

  return sections.join("\n\n---\n\n");
}

function buildWorkspaceContext({
  projectContext,
  referenceDocuments,
  experimentDocuments,
  experimentNotes,
  experimentModules,
  storedDocuments
}) {
  const contextSections = [];

  if (projectContext) {
    contextSections.push(`Project context / goal:\n${projectContext}`);
  }

  const referenceContext = buildDocumentContext("Reference", referenceDocuments);
  if (referenceContext) {
    contextSections.push(`Literature and reference evidence:\n${referenceContext}`);
  }

  const storedDocumentContext = buildDocumentContext(
    "Stored PDF",
    storedDocuments || []
  );
  if (storedDocumentContext) {
    contextSections.push(
      `PDF evidence retrieved from private OSS storage:\n${storedDocumentContext}`
    );
  }

  const moduleContext = buildExperimentModulesContext(experimentModules);
  if (moduleContext) {
    contextSections.push(`Experiment result evidence by module:\n${moduleContext}`);
  } else {
    const experimentContext = buildDocumentContext(
      "Experiment file",
      experimentDocuments
    );
    if (experimentContext) {
      contextSections.push(`Experiment result evidence:\n${experimentContext}`);
    }
  }

  if (!moduleContext && experimentNotes.length) {
    const notes = experimentNotes
      .map((note, index) => {
        const timestamp = note.createdAt ? ` (${note.createdAt})` : "";
        const moduleNote = note.module ? ` [module: ${note.module}]` : "";
        return `Experiment note ${index + 1}${moduleNote}${timestamp}:\n${note.text}`;
      })
      .join("\n\n---\n\n");
    contextSections.push(`Informal experiment notes:\n${notes}`);
  }

  if (!contextSections.length) return null;

  return `The user attached browser-session workspace context. Use it only as unverified supporting evidence. Mention filenames when relying on uploaded files, do not invent claims beyond extracted text, and say what is missing if context is insufficient.\n\n${contextSections.join("\n\n===\n\n")}`;
}

function buildExperimentModulesContext(experimentModules) {
  if (!isPlainObject(experimentModules)) return null;

  const sections = Object.entries(experimentModules)
    .map(([moduleKey, moduleData]) => {
      const label = moduleData.label || EXPERIMENT_MODULE_LABELS[moduleKey] || moduleKey;
      const documentContext = buildDocumentContext(
        `${label} file`,
        moduleData.documents || []
      );
      const notes = (moduleData.notes || [])
        .map((note, index) => {
          const timestamp = note.createdAt ? ` (${note.createdAt})` : "";
          return `${label} note ${index + 1}${timestamp}:\n${note.text}`;
        })
        .join("\n\n---\n\n");

      if (!documentContext && !notes) return "";

      return [`Module: ${label}`, documentContext, notes]
        .filter(Boolean)
        .join("\n\n");
    })
    .filter(Boolean);

  return sections.length ? sections.join("\n\n===\n\n") : null;
}

function summarizeExperimentModules(experimentModules) {
  if (!isPlainObject(experimentModules)) return {};

  return Object.entries(experimentModules).reduce((summary, [moduleKey, moduleData]) => {
    summary[moduleKey] = {
      files: (moduleData.documents || []).map((document) => document.filename),
      notes: (moduleData.notes || []).length
    };
    return summary;
  }, {});
}

function normalizeExperimentModuleKey(module) {
  return typeof module === "string" && EXPERIMENT_MODULE_LABELS[module]
    ? module
    : "";
}

function isPlainObject(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

async function callRequesty(messages, env, workspaceContext = {}) {
  const apiKey = env.REQUESTY_API_KEY;
  const model = env.REQUESTY_MODEL;

  if (!apiKey || !model) {
    return {
      ok: false,
      reason:
        "Missing REQUESTY_API_KEY or REQUESTY_MODEL environment variable."
    };
  }

  const cleanedMessages = Array.isArray(messages)
    ? messages
        .filter(
          (message) =>
            message &&
            typeof message.role === "string" &&
            typeof message.content === "string"
        )
        .map((message) => ({
          role: message.role,
          content: message.content
        }))
    : [];

  if (cleanedMessages.length === 0) {
    return {
      ok: false,
      reason: "No valid messages were provided."
    };
  }

  const requestMessages = [
    {
      role: "system",
      content: systemPrompt
    }
  ];
  const contextMessage = buildWorkspaceContext(workspaceContext);

  if (contextMessage) {
    requestMessages.push({
      role: "system",
      content: contextMessage
    });
  }

  requestMessages.push(...cleanedMessages);

  const requestBody = {
    model,
    messages: requestMessages,
    temperature: 0.3
  };

  let response;

  try {
    response = await fetch(REQUESTY_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`
      },
      body: JSON.stringify(requestBody)
    });
  } catch (error) {
    console.error("Requesty fetch failed:", error.message);
    return {
      ok: false,
      reason: `Requesty fetch failed: ${error.message}`
    };
  }

  if (!response.ok) {
    const errorText = await response.text().catch(() => "");
    console.error("Requesty non-200 response:", response.status, errorText);
    return {
      ok: false,
      reason: `Requesty returned HTTP ${response.status}`
    };
  }

  let responseJson;

  try {
    responseJson = await response.json();
  } catch (error) {
    console.error("Failed to parse Requesty response JSON:", error.message);
    return {
      ok: false,
      reason: "Requesty response was not valid JSON."
    };
  }

  const modelText = responseJson?.choices?.[0]?.message?.content;

  if (!modelText) {
    return {
      ok: false,
      reason: "Requesty response did not include assistant content."
    };
  }

  const parsedModelOutput = parseModelResponse(modelText);

  if (!parsedModelOutput) {
    console.error("Model returned invalid structured JSON.");
    return {
      ok: false,
      reason: "Model returned invalid structured JSON."
    };
  }

  return {
    ok: true,
    data: parsedModelOutput
  };
}

exports.handler = async function handler(rawEvent, context) {
  let method = "GET";
  let path = "/";
  let event = null;

  try {
    ({ method, path, event } = getRoute(rawEvent));

    if (method === "OPTIONS") {
      return {
        statusCode: 204,
        headers: getApiHeaders(event),
        body: ""
      };
    }

    console.log("Incoming request:", {
      method,
      path
    });

    if (method === "GET" && (path === "/" || path === "/health")) {
      return jsonResponse({
        ok: true,
        service: "BioDesign Copilot Alibaba FC"
      }, 200, event);
    }

    // Temporary debug endpoint. Remove later when everything works.
    if (path === "/debug") {
      return jsonResponse({
        method,
        path,
        eventType: typeof rawEvent,
        isBuffer: Buffer.isBuffer(rawEvent),
        eventKeys: Object.keys(event || {}),
        requestContext: event.requestContext || null,
        rawPath: event.rawPath || null,
        pathValue: event.path || null,
        requestPath: event.requestPath || null,
        url: event.url || null,
        httpMethod: event.httpMethod || null,
        methodValue: event.method || null,
        headers: event.headers || null,
        hasBody: Boolean(event.body || event.rawBody),
        bodyPreview: event.body
          ? String(event.body).slice(0, 300)
          : event.rawBody
            ? String(event.rawBody).slice(0, 300)
            : null
      }, 200, event);
    }

    if (method === "POST" && path === "/api/login") {
      try {
        return await handleLogin(event, process.env);
      } catch (error) {
        console.error("Login route error:", error);
        return internalServerErrorResponse(event);
      }
    }

    if (method === "GET" && path === "/api/me") {
      try {
        return handleMe(event, process.env);
      } catch (error) {
        console.error("Current user route error:", error);
        return internalServerErrorResponse(event);
      }
    }

    if (method === "POST" && path === "/api/logout") {
      return handleLogout(event);
    }

    if (method === "POST" && path === "/api/test-oss") {
      const auth = requireAuth(event, process.env);
      if (!auth.ok) {
        return auth.response;
      }

      return handleOssTest(event, context, process.env);
    }

    if (method === "POST" && path === "/api/documents/upload-url") {
      const auth = requireAuth(event, process.env);
      if (!auth.ok) {
        return auth.response;
      }

      return handlePdfUploadUrl(
        event,
        context,
        process.env,
        auth.user
      );
    }

    if (method === "POST" && path === "/api/documents/review") {
      const auth = requireAuth(event, process.env);
      if (!auth.ok) {
        return auth.response;
      }

      return handlePdfReview(event, context, process.env, auth.user);
    }

    if (method === "POST" && path === "/chat") {
      const auth = requireAuth(event, process.env);
      if (!auth.ok) {
        return auth.response;
      }

      const body = getRequestBody(event);
      const messages = body.messages;
      const projectContext =
        typeof body.projectContext === "string"
          ? body.projectContext.trim().slice(0, 4000)
          : "";
      const rawReferenceDocuments = body.referenceDocuments;
      const rawExperimentDocuments = body.experimentDocuments;
      const rawExperimentNotes = body.experimentNotes;
      const rawExperimentModules = body.experimentModules;
      const rawStoredDocuments = body.storedDocuments;

      if (
        rawReferenceDocuments !== undefined &&
        !Array.isArray(rawReferenceDocuments)
      ) {
        return jsonResponse(
          makeFallbackResponse(
            'The optional "referenceDocuments" field must be an array.'
          ),
          400,
          event
        );
      }

      if (
        rawExperimentDocuments !== undefined &&
        !Array.isArray(rawExperimentDocuments)
      ) {
        return jsonResponse(
          makeFallbackResponse(
            'The optional "experimentDocuments" field must be an array.'
          ),
          400,
          event
        );
      }

      if (
        rawExperimentNotes !== undefined &&
        !Array.isArray(rawExperimentNotes)
      ) {
        return jsonResponse(
          makeFallbackResponse(
            'The optional "experimentNotes" field must be an array.'
          ),
          400,
          event
        );
      }

      if (
        rawExperimentModules !== undefined &&
        !isPlainObject(rawExperimentModules)
      ) {
        return jsonResponse(
          makeFallbackResponse(
            'The optional "experimentModules" field must be an object keyed by experiment module.'
          ),
          400,
          event
        );
      }

      if (
        rawStoredDocuments !== undefined &&
        !Array.isArray(rawStoredDocuments)
      ) {
        return jsonResponse(
          makeFallbackResponse(
            'The optional "storedDocuments" field must be an array.'
          ),
          400,
          event
        );
      }

      const referenceDocuments = sanitizeReferenceDocuments(
        rawReferenceDocuments || []
      );
      const experimentDocuments = sanitizeExperimentDocuments(
        rawExperimentDocuments || []
      );
      const experimentNotes = sanitizeExperimentNotes(rawExperimentNotes || []);
      const experimentModules = sanitizeExperimentModules(
        rawExperimentModules || {}
      );
      const storedDocumentResult = await loadStoredPdfsForChat({
        documents: rawStoredDocuments || [],
        user: auth.user,
        context,
        env: process.env
      });
      if (!storedDocumentResult.ok) {
        return documentErrorResponse(
          event,
          storedDocumentResult.stage,
          storedDocumentResult.error,
          storedDocumentResult.message,
          storedDocumentResult.statusCode
        );
      }
      const result = await callRequesty(
        messages,
        process.env,
        {
          projectContext,
          referenceDocuments,
          experimentDocuments,
          experimentNotes,
          experimentModules,
          storedDocuments: storedDocumentResult.documents
        }
      );

      if (!result.ok) {
        return jsonResponse(makeFallbackResponse(result.reason), 200, event);
      }

      return jsonResponse(
        {
          ...result.data,
          referencesUsed: referenceDocuments.map((document) => document.filename),
          experimentFilesUsed: experimentDocuments.map(
            (document) => document.filename
          ),
          experimentModulesUsed: summarizeExperimentModules(experimentModules),
          storedPdfsUsed: storedDocumentResult.documents.map(
            (document) => document.filename
          )
        },
        200,
        event
      );
    }

    return jsonResponse(
      {
        error: "Not found",
        method,
        path
      },
      404,
      event
    );
  } catch (error) {
    console.error("Unhandled backend error:", error);
    return internalServerErrorResponse(event);
  }
};

exports._test = {
  buildOwnedPdfObjectKey,
  chunkPdfText,
  extractPdfDocument,
  getUserStorageSegment,
  isOwnedPdfObjectKey,
  sanitizePdfFilename
};
