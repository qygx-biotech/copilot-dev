const http = require("node:http");

const REQUESTY_CHAT_COMPLETIONS_URL =
  "https://router.requesty.ai/v1/chat/completions";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Max-Age": "86400",
};

const SYSTEM_PROMPT = `You are BioDesign Copilot, an AI design-review copilot for synthetic biology teams.

You help users convert rough synthetic-biology ideas into structured project briefs, missing-information lists, safety-aware notes, and investor-ready memos.

You should help with:
- benign project scoping
- design review
- documentation
- high-level planning
- educational synthetic biology concepts
- safety and compliance reminders
- clarifying questions

You must avoid:
- actionable instructions for pathogen enhancement
- toxin production
- evasion of biosafety controls
- increasing virulence, transmissibility, or host range
- detailed wet-lab protocols for harmful biological work
- instructions that enable unsafe or unsupervised experimentation

Response behavior:
- Keep responses useful but high-level.
- Prefer asking clarifying questions when information is missing.
- Make the project panel useful after every response.
- Make the draft memo sound investor-demo ready.
- Make safety notes visible but not alarmist.
- Redirect risky or underspecified requests toward safe planning, documentation, risk assessment, institutional review, and clarification questions.

Return only valid JSON. Do not include markdown fences, prose before the JSON, prose after the JSON, comments, or extra keys. The JSON must use this exact shape:
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
}`;

async function handler(req, res) {
  const { method, pathname } = getRequestRoute(req);

  if (method === "OPTIONS") {
    sendJson(res, {}, 204);
    return;
  }

  if (method === "GET" && pathname === "/health") {
    sendJson(res, {
      ok: true,
      service: "BioDesign Copilot Alibaba Function Compute backend",
      mode: "requesty",
      hasRequestyApiKey: Boolean(process.env.REQUESTY_API_KEY),
      hasRequestyModel: Boolean(process.env.REQUESTY_MODEL),
    });
    return;
  }

  if (method === "POST" && pathname === "/chat") {
    const responseBody = await handleChat(req);
    sendJson(res, responseBody, responseBody.statusCode || 200);
    return;
  }

  sendJson(
    res,
    {
      error: "Not found",
      availableRoutes: ["GET /health", "POST /chat"],
    },
    404
  );
}

async function handleChat(req) {
  let payload;

  try {
    payload = await readJsonBody(req);
  } catch {
    return withStatus(
      buildFallbackResponse(
        "",
        "I could not read the request body as JSON. Please send a valid chat request and I can produce a structured BioDesign Copilot review."
      ),
      400
    );
  }

  if (!Array.isArray(payload.messages)) {
    return withStatus(
      buildFallbackResponse(
        "",
        'The request needs a "messages" array with role/content objects. Once that is present, I can return a structured project brief.'
      ),
      400
    );
  }

  const messages = sanitizeMessages(payload.messages);
  const latestUserMessage = [...messages]
    .reverse()
    .find((message) => message.role === "user" && message.content.trim());

  if (!latestUserMessage) {
    return withStatus(
      buildFallbackResponse(
        "",
        "Please include at least one non-empty user message so BioDesign Copilot can create a useful project brief."
      ),
      400
    );
  }

  if (!process.env.REQUESTY_API_KEY || !process.env.REQUESTY_MODEL) {
    console.warn("Requesty environment variables are missing.");
    return buildFallbackResponse(
      latestUserMessage.content,
      "I could not complete the Requesty-backed review because the Alibaba Function Compute backend is missing its Requesty API key or model setting. I returned a safe planning fallback so the project panel remains useful."
    );
  }

  let completion;

  try {
    completion = await callRequesty(messages);
  } catch (error) {
    console.warn("Requesty request failed:", error.message);
    return buildFallbackResponse(
      latestUserMessage.content,
      `BioDesign Copilot could not reach Requesty right now. ${error.message}`
    );
  }

  const content = completion?.choices?.[0]?.message?.content;

  if (typeof content !== "string" || !content.trim()) {
    return buildFallbackResponse(
      latestUserMessage.content,
      "The model response did not include usable text, so I generated a safe planning summary instead."
    );
  }

  try {
    const parsed = parseModelJson(content);
    return normalizeModelResponse(parsed);
  } catch {
    console.warn("Model response was not valid JSON.");
    return buildFallbackResponse(
      latestUserMessage.content,
      "The model returned unstructured text instead of strict JSON, so I generated a safe high-level planning response and conservative project-panel defaults."
    );
  }
}

function getRequestRoute(req) {
  const host = req.headers?.host || "localhost";
  const url = new URL(req.url || "/", `http://${host}`);

  return {
    method: (req.method || "GET").toUpperCase(),
    pathname: url.pathname,
  };
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";

    req.on("data", (chunk) => {
      body += chunk;
    });

    req.on("end", () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch (error) {
        reject(error);
      }
    });

    req.on("error", reject);
  });
}

function sanitizeMessages(messages) {
  return messages
    .filter(
      (message) =>
        message &&
        (message.role === "user" || message.role === "assistant") &&
        typeof message.content === "string" &&
        message.content.trim()
    )
    .slice(-12)
    .map((message) => ({
      role: message.role,
      content: message.content.slice(0, 6000),
    }));
}

async function callRequesty(messages) {
  const response = await fetch(REQUESTY_CHAT_COMPLETIONS_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.REQUESTY_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: process.env.REQUESTY_MODEL,
      messages: [{ role: "system", content: SYSTEM_PROMPT }, ...messages],
      temperature: 0.3,
      response_format: { type: "json_object" },
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(
      `Requesty returned ${response.status}: ${errorText.slice(0, 240)}`
    );
  }

  return response.json();
}

function parseModelJson(content) {
  try {
    return JSON.parse(content);
  } catch {
    const extracted = extractFirstJsonObject(content);
    if (!extracted) throw new Error("No JSON object found.");
    return JSON.parse(extracted);
  }
}

function extractFirstJsonObject(text) {
  let start = -1;
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];

    if (start === -1) {
      if (char === "{") {
        start = index;
        depth = 1;
      }
      continue;
    }

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

    if (inString) continue;

    if (char === "{") {
      depth += 1;
    } else if (char === "}") {
      depth -= 1;
      if (depth === 0) {
        return text.slice(start, index + 1);
      }
    }
  }

  return "";
}

function normalizeModelResponse(data) {
  const project = data?.project || {};

  return {
    reply:
      typeof data?.reply === "string" && data.reply.trim()
        ? data.reply.trim()
        : "BioDesign Copilot generated a project review, but the reply text was missing.",
    project: {
      summary: normalizeString(
        project.summary,
        "Concept-stage synthetic biology project pending review."
      ),
      organism: normalizeString(project.organism, "Not specified"),
      missingInformation: normalizeStringArray(project.missingInformation, [
        "Project objective",
        "Intended organism or system",
        "Safety review context",
      ]),
      safetyLevel: normalizeString(
        project.safetyLevel,
        "Planning review only; safety level pending qualified review"
      ),
      safetyNotes: normalizeString(
        project.safetyNotes,
        "Keep the work at high-level planning until a qualified supervisor confirms permitted materials, containment, training, and institutional review requirements."
      ),
      draftMemo: normalizeString(
        project.draftMemo,
        "Draft memo unavailable. Re-run the request or add more project context."
      ),
    },
  };
}

function buildFallbackResponse(userMessage, reply) {
  const projectConcept = userMessage || "No project concept was provided.";

  return {
    reply,
    project: {
      summary:
        "Concept-stage synthetic biology idea captured for safe planning review. This fallback brief keeps the project panel useful while the Requesty-backed response is unavailable or unstructured.",
      organism: detectOrganism(projectConcept.toLowerCase()),
      missingInformation: [
        "Specific educational or product goal",
        "Approved organism, strain, or non-living system",
        "Intended setting and supervision model",
        "Containment, disposal, and institutional review path",
      ],
      safetyLevel:
        "Planning review only; safety level pending qualified biosafety review",
      safetyNotes:
        "Keep wet-lab details high-level and safety-aware. Do not proceed with practical work until a qualified supervisor confirms permitted materials, containment, waste handling, and review requirements.",
      draftMemo: `BioDesign Copilot Draft Memo

Project concept: ${projectConcept}

This concept is captured for safe design review and documentation. Because a structured Requesty-backed response was not available, the project panel uses conservative defaults and should be treated as a placeholder until the request is retried.

Recommended decision: continue with high-level planning only, clarify missing information, and involve appropriate biosafety or teaching-lab review before any practical work is considered.`,
    },
  };
}

function detectOrganism(text) {
  if (text.includes("yeast")) return "Yeast teaching strain";
  if (text.includes("e. coli") || text.includes("ecoli")) {
    return "Non-pathogenic E. coli teaching strain";
  }
  if (text.includes("lactose") || text.includes("biosensor")) {
    return "Biosensor concept system";
  }
  return "To be selected during project scoping";
}

function normalizeString(value, fallback) {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

function normalizeStringArray(value, fallback) {
  if (!Array.isArray(value)) return fallback;

  const normalized = value
    .filter((item) => typeof item === "string" && item.trim())
    .map((item) => item.trim());

  return normalized.length ? normalized : fallback;
}

function withStatus(body, statusCode) {
  return { ...body, statusCode };
}

function sendJson(res, body, statusCode = 200) {
  const { statusCode: bodyStatusCode, ...payload } = body || {};
  const responseStatus = statusCode || bodyStatusCode || 200;

  Object.entries({
    ...CORS_HEADERS,
    "Content-Type": "application/json; charset=utf-8",
  }).forEach(([key, value]) => {
    res.setHeader(key, value);
  });

  res.statusCode = responseStatus;
  res.end(responseStatus === 204 ? "" : JSON.stringify(payload, null, 2));
}

module.exports = handler;
module.exports.handler = handler;

if (require.main === module) {
  const port = Number(process.env.PORT || 9000);
  const server = http.createServer((req, res) => {
    handler(req, res).catch((error) => {
      console.error("Unhandled Alibaba FC local server error:", error.message);
      sendJson(
        res,
        buildFallbackResponse(
          "",
          "The local Alibaba Function Compute test server hit an unexpected error and returned a safe fallback response."
        ),
        500
      );
    });
  });

  server.listen(port, () => {
    console.log(`BioDesign Copilot Alibaba FC local server on port ${port}`);
  });
}
