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

const REQUESTY_URL = "https://router.requesty.ai/v1/chat/completions";
const MAX_REFERENCE_DOCUMENTS = 3;
const TOTAL_REFERENCE_TEXT_LIMIT = 24000;

const corsHeaders = {
  "Content-Type": "application/json"
};

const systemPrompt = `
You are BioDesign Copilot, an AI design-review copilot for synthetic biology teams.

Your job is to help users convert rough synthetic-biology ideas into structured project briefs, design review notes, safety-aware planning notes, missing-information lists, and investor-ready memos.

Uploaded references may include literature, notes, lab reports, or spreadsheet data. Treat uploaded references as unverified user-provided context. Use references to improve project review, missing-information detection, and memo drafting, but do not blindly trust them. Do not claim references say something unless it is present in the extracted text. Mention filenames when using reference information. If references are insufficient, say what is missing.

You should help with:
- benign project scoping
- documentation
- high-level design review
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

Keep wet-lab guidance high-level and safety-aware.

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
  let remainingCharacters = TOTAL_REFERENCE_TEXT_LIMIT;

  return referenceDocuments
    .slice(0, MAX_REFERENCE_DOCUMENTS)
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
            : "unnamed-reference",
        type:
          typeof document.type === "string" && document.type.trim()
            ? document.type.trim().slice(0, 120)
            : "text/plain",
        text,
        truncated: Boolean(document.truncated || text.length < sourceText.length)
      };
    })
    .filter((document) => document.text);
}

function buildReferenceContext(referenceDocuments) {
  if (!referenceDocuments.length) return null;

  const sections = referenceDocuments.map((document, index) => {
    const truncatedNote = document.truncated ? " (truncated)" : "";
    return `Reference ${index + 1}: ${document.filename} [${document.type}]${truncatedNote}\n${document.text}`;
  });

  return `The user attached reference documents. Use them only as unverified supporting context. Mention filenames when relying on them, do not invent claims beyond the extracted text, and say what is missing if they are insufficient.\n\n${sections.join("\n\n---\n\n")}`;
}

async function callRequesty(messages, env, referenceDocuments = []) {
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
  const referenceContext = buildReferenceContext(referenceDocuments);

  if (referenceContext) {
    requestMessages.push({
      role: "system",
      content: referenceContext
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

    if (method === "POST" && path === "/chat") {
      const auth = requireAuth(event, process.env);
      if (!auth.ok) {
        return auth.response;
      }

      const body = getRequestBody(event);
      const messages = body.messages;
      const rawReferenceDocuments = body.referenceDocuments;

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

      const referenceDocuments = sanitizeReferenceDocuments(
        rawReferenceDocuments || []
      );
      const result = await callRequesty(
        messages,
        process.env,
        referenceDocuments
      );

      if (!result.ok) {
        return jsonResponse(makeFallbackResponse(result.reason), 200, event);
      }

      return jsonResponse(
        {
          ...result.data,
          referencesUsed: referenceDocuments.map((document) => document.filename)
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
