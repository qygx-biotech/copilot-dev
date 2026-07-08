const REQUESTY_CHAT_COMPLETIONS_URL =
  "https://router.requesty.ai/v1/chat/completions";
const MAX_REFERENCE_DOCUMENTS = 8;
const MAX_EXPERIMENT_DOCUMENTS = 36;
const MAX_EXPERIMENT_NOTES = 36;
const TOTAL_REFERENCE_TEXT_LIMIT = 26000;
const TOTAL_EXPERIMENT_TEXT_LIMIT = 26000;
const EXPERIMENT_MODULE_LABELS = {
  strainEngineering: "Strain Engineering",
  fermentation: "Fermentation",
  downstreamProcessing: "Downstream Processing",
};

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
  "Access-Control-Max-Age": "86400",
};

const SYSTEM_PROMPT = `You are BioDesign Copilot, an AI design-review copilot for synthetic biology teams.

You support a human-in-the-loop BioDesign Workbench for synthetic biology design, literature review, messy experiment interpretation, and planning-level recommendations.

The project may be about many goals: pathway improvement, failed experiment interpretation, enzyme variant comparison, literature synthesis, assay troubleshooting, strain/design comparison, or another synthetic-biology planning question. Do not assume the project is only about production volume, titer, yield, or productivity.

Uploaded context may include messy literature PDFs, notes, lab reports, spreadsheet batches, CSV files, TXT files, and informal experiment notes. Experiment evidence may be grouped into Strain Engineering, Fermentation, and Downstream Processing modules. Treat all uploaded context as unverified user-provided evidence. Use it to interpret evidence, identify possible explanations, suggest useful next analyses, and recommend human-reviewed next steps. Do not assume every project has clean metrics, complete metadata, or comparable experiments. Mention filenames and modules when relying on uploaded evidence and say what is missing when evidence is insufficient.

You should help with:
- benign project scoping
- design review
- documentation
- high-level planning
- evidence interpretation
- possible explanation generation
- next-analysis recommendations
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
- Make the recommendation panel useful after agent_instruction requests.
- For side_chat requests, answer the question without claiming to update the official recommendation.
- Consider whether the next useful step belongs in strain engineering, fermentation, downstream processing, or additional analysis. Do not assume all problems are in strain engineering.
- Keep draft summaries suitable for scientist review, not automatic execution.
- Make safety notes visible but not alarmist.
- Redirect risky or underspecified requests toward safe planning, documentation, risk assessment, institutional review, and clarification questions.
- Human scientists remain responsible for interpreting evidence and approving experimental decisions.

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

  if (
    payload.experimentDocuments !== undefined &&
    !Array.isArray(payload.experimentDocuments)
  ) {
    return jsonResponse(
      buildFallbackResponse(
        "",
        'The optional "experimentDocuments" field must be an array. I returned a safe fallback response so the project panel remains usable.'
      ),
      400
    );
  }

  if (
    payload.experimentNotes !== undefined &&
    !Array.isArray(payload.experimentNotes)
  ) {
    return jsonResponse(
      buildFallbackResponse(
        "",
        'The optional "experimentNotes" field must be an array. I returned a safe fallback response so the project panel remains usable.'
      ),
      400
    );
  }

  if (
    payload.experimentModules !== undefined &&
    !isPlainObject(payload.experimentModules)
  ) {
    return jsonResponse(
      buildFallbackResponse(
        "",
        'The optional "experimentModules" field must be an object keyed by experiment module.'
      ),
      400
    );
  }

  const messages = sanitizeMessages(payload.messages);
  const projectContext =
    typeof payload.projectContext === "string"
      ? payload.projectContext.trim().slice(0, 4000)
      : "";
  const referenceDocuments = sanitizeReferenceDocuments(
    payload.referenceDocuments || []
  );
  const experimentDocuments = sanitizeExperimentDocuments(
    payload.experimentDocuments || []
  );
  const experimentNotes = sanitizeExperimentNotes(payload.experimentNotes || []);
  const experimentModules = sanitizeExperimentModules(
    payload.experimentModules || {}
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
    completion = await callRequesty(env, messages, {
      projectContext,
      referenceDocuments,
      experimentDocuments,
      experimentNotes,
      experimentModules,
    });
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
      experimentFilesUsed: experimentDocuments.map((document) => document.filename),
      experimentModulesUsed: summarizeExperimentModules(experimentModules),
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
      const text = document.text.trim().slice(0, remainingCharacters);
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
        truncated: Boolean(document.truncated || text.length < document.text.trim().length),
        module: normalizeExperimentModuleKey(document.module),
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
      module: normalizeExperimentModuleKey(note.module),
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
      ),
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
      notes: (moduleData.notes || []).length,
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

async function callRequesty(env, messages, workspaceContext = {}) {
  // Requesty call: this is the only place the Worker sends chat history to the
  // OpenAI-compatible Requesty router. The API key stays server-side in env.
  const requestMessages = [{ role: "system", content: SYSTEM_PROMPT }];
  const contextMessage = buildWorkspaceContext(workspaceContext);

  if (contextMessage) {
    requestMessages.push({ role: "system", content: contextMessage });
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
