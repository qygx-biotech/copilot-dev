const REQUESTY_CHAT_COMPLETIONS_URL =
  "https://router.requesty.ai/v1/chat/completions";
const MAX_REFERENCE_DOCUMENTS = 3;
const TOTAL_REFERENCE_TEXT_LIMIT = 24000;

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Max-Age": "86400",
};

const SYSTEM_PROMPT = `You are BioDesign Copilot, an AI design-review copilot for synthetic biology teams.

You help users convert rough synthetic-biology ideas into structured project briefs, missing-information lists, safety-aware notes, and investor-ready memos.

Uploaded references may include literature, notes, lab reports, or spreadsheet data. Treat uploaded references as unverified user-provided context. Use references to improve project review, missing-information detection, and memo drafting, but do not blindly trust them. Do not claim references say something unless it is present in the extracted text. Mention filenames when using reference information. If references are insufficient, say what is missing.

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

export default {
  async fetch(request, env = {}) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    if (request.method === "GET" && url.pathname === "/health") {
      return jsonResponse({
        ok: true,
        service: "BioDesign Copilot Worker",
        mode: "requesty",
        hasRequestyApiKey: Boolean(env.REQUESTY_API_KEY),
        hasRequestyModel: Boolean(env.REQUESTY_MODEL),
      });
    }

    if (request.method === "POST" && url.pathname === "/chat") {
      return handleChat(request, env);
    }

    return jsonResponse(
      {
        error: "Not found",
        availableRoutes: ["GET /health", "POST /chat"],
      },
      404
    );
  },
};

async function handleChat(request, env) {
  let payload;

  try {
    payload = await request.json();
  } catch {
    return jsonResponse(
      buildFallbackResponse(
        "",
        "I could not read the request body as JSON. Please send a valid chat request and I can produce a structured BioDesign Copilot review."
      ),
      400
    );
  }

  if (!Array.isArray(payload.messages)) {
    return jsonResponse(
      buildFallbackResponse(
        "",
        'The request needs a "messages" array with role/content objects. Once that is present, I can return a structured project brief.'
      ),
      400
    );
  }

  if (
    payload.referenceDocuments !== undefined &&
    !Array.isArray(payload.referenceDocuments)
  ) {
    return jsonResponse(
      buildFallbackResponse(
        "",
        'The optional "referenceDocuments" field must be an array. I returned a safe fallback response so the project panel remains usable.'
      ),
      400
    );
  }

  const messages = sanitizeMessages(payload.messages);
  const referenceDocuments = sanitizeReferenceDocuments(
    payload.referenceDocuments || []
  );
  const latestUserMessage = [...messages]
    .reverse()
    .find((message) => message.role === "user" && message.content.trim());

  if (!latestUserMessage) {
    return jsonResponse(
      buildFallbackResponse(
        "",
        "Please include at least one non-empty user message so BioDesign Copilot can create a useful project brief."
      ),
      400
    );
  }

  if (!env.REQUESTY_API_KEY || !env.REQUESTY_MODEL) {
    return jsonResponse(
      buildFallbackResponse(
        latestUserMessage.content,
        "I could not complete the Requesty-backed review because the Worker is missing its Requesty API key or model setting. I returned a safe planning fallback so the project panel remains useful."
      )
    );
  }

  let completion;

  try {
    completion = await callRequesty(env, messages, referenceDocuments);
  } catch (error) {
    return jsonResponse(
      buildFallbackResponse(
        latestUserMessage.content,
        `BioDesign Copilot could not reach Requesty right now. ${error.message}`
      )
    );
  }

  const content = completion?.choices?.[0]?.message?.content;

  if (typeof content !== "string" || !content.trim()) {
    return jsonResponse(
      buildFallbackModelResponse(
        latestUserMessage.content,
        "The model response did not include usable text, so I generated a safe planning summary instead."
      )
    );
  }

  try {
    const parsed = parseModelJson(content);
    return jsonResponse({
      ...normalizeModelResponse(parsed),
      referencesUsed: referenceDocuments.map((document) => document.filename),
    });
  } catch {
    return jsonResponse(
      buildFallbackModelResponse(
        latestUserMessage.content,
        "The model returned unstructured text instead of strict JSON, so I generated a safe high-level planning response and conservative project-panel defaults."
      )
    );
  }
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
      const text = document.text.trim().slice(0, remainingCharacters);
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
        truncated: Boolean(document.truncated || text.length < document.text.trim().length),
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

async function callRequesty(env, messages, referenceDocuments = []) {
  // Requesty call: this is the only place the Worker sends chat history to the
  // OpenAI-compatible Requesty router. The API key stays server-side in env.
  const requestMessages = [{ role: "system", content: SYSTEM_PROMPT }];
  const referenceContext = buildReferenceContext(referenceDocuments);

  if (referenceContext) {
    requestMessages.push({ role: "system", content: referenceContext });
  }

  requestMessages.push(...messages);

  const response = await fetch(REQUESTY_CHAT_COMPLETIONS_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.REQUESTY_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: env.REQUESTY_MODEL,
      messages: requestMessages,
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
  // JSON parsing: try strict JSON first, then extract the first complete JSON
  // object from messy model text before giving up.
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
  const normalized = {
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

  return normalized;
}

function buildFallbackModelResponse(userMessage, reply) {
  // Fallback response: if Requesty fails or the model does not return parseable
  // JSON, this exact shape keeps the frontend and project panel usable.
  return buildFallbackResponse(userMessage, reply);
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

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: {
      ...CORS_HEADERS,
      "Content-Type": "application/json; charset=utf-8",
    },
  });
}
