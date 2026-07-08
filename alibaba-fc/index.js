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
const MAX_REFERENCE_DOCUMENTS = 8;
const MAX_EXPERIMENT_DOCUMENTS = 36;
const MAX_EXPERIMENT_NOTES = 36;
const TOTAL_REFERENCE_TEXT_LIMIT = 26000;
const TOTAL_EXPERIMENT_TEXT_LIMIT = 26000;
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
  experimentModules
}) {
  const contextSections = [];

  if (projectContext) {
    contextSections.push(`Project context / goal:\n${projectContext}`);
  }

  const referenceContext = buildDocumentContext("Reference", referenceDocuments);
  if (referenceContext) {
    contextSections.push(`Literature and reference evidence:\n${referenceContext}`);
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
      const result = await callRequesty(
        messages,
        process.env,
        {
          projectContext,
          referenceDocuments,
          experimentDocuments,
          experimentNotes,
          experimentModules
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
          experimentModulesUsed: summarizeExperimentModules(experimentModules)
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
