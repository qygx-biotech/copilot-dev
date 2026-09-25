"use strict";
const { parseModelJsonValue } = require("./model-json.js");
const semantic = require("./shared/semantic-intent.js");

// A wire contract, not a replacement for SEMANTIC_IR_SCHEMA/validateSemanticIR.
// Keep all IR fields and meanings. Bounds and semantic invariants remain local.
const object = properties => ({ type: "object", properties, required: Object.keys(properties), additionalProperties: false });
const string = () => ({ type: "string" });
const list = items => ({ type: "array", items });
const nullable = type => ({ type: [type, "null"] });
const enumeration = values => ({ type: "string", enum: [...values] });
const operators = ["=", "!=", "<", "<=", ">", ">=", "in", "contains"];
// These small unions are necessary to preserve the existing IR value types.
const value = () => ({ anyOf: [string(), { type: "number" }, { type: "boolean" }, { type: "null" }, list(string())] });
const scope = () => ({ anyOf: [enumeration(["current-project"]), list(string()), { type: "null" }] });
const SEMANTIC_INTENT_LLM_SCHEMA = object({
  version: { type: "integer" }, retrievalScope: enumeration(semantic.RETRIEVAL_SCOPES), inputLanguage: string(), answerLanguage: string(),
  matchedPattern: { ...nullable("string"), enum: [...semantic.SEMANTIC_PATTERNS.map(pattern => pattern.patternId), null] },
  patternConfidence: { type: "number" }, goal: string(),
  operations: list(enumeration(semantic.OPERATIONS)), objects: list(string()),
  entities: list(object({ type: string(), canonicalId: string(), mention: string() })),
  metrics: list(object({ canonicalField: nullable("string"), direction: { ...nullable("string"), enum: ["maximize", "minimize", "target", null] } })),
  scope: object({ papers: scope(), experiments: scope() }),
  filters: list(object({ field: string(), operator: enumeration(operators), value: value(), unit: nullable("string") })),
  constraints: list(object({ type: string(), field: nullable("string"), operator: { ...nullable("string"), enum: [...operators, null] }, value: value(), unit: nullable("string"), description: string() })),
  comparisonVariables: list(string()), requestedOutput: object({ type: string(), limit: nullable("integer") }),
  capabilityHints: list(enumeration(semantic.CAPABILITY_REGISTRY.map(item => item.capability))), unresolvedSlots: list(string()),
});

const compatibilityCodes = new Set(["invalid_json_schema", "unsupported_json_schema", "invalid_response_format", "unsupported_response_format"]);
const safeProviderCodes = new Set([...compatibilityCodes, "invalid_argument", "invalid_request_error", "bad_request", "invalid_schema", "schema_validation_error"]);
const schemaField = field => /(?:^|[.\[/])(?:response_format|response_schema|response_json_schema|responseSchema|responseJsonSchema)(?:$|[.\[/])/i.test(field);

// Classify raw provider errors at the transport boundary, then retain only
// a boolean and an allowlisted code. Never return/log the raw provider text.
function structuredOutputErrorDetails(status, text) {
  if (![400, 422].includes(status)) return {};
  let parsed;
  try { parsed = JSON.parse(text); } catch { parsed = null; }
  const error = parsed?.error && typeof parsed.error === "object" ? parsed.error : parsed;
  const code = String(typeof error?.code === "string" ? error.code : error?.status || error?.type || "").toLowerCase();
  const fields = [error?.param, error?.parameter, error?.field,
    ...(Array.isArray(error?.details) ? error.details.flatMap(detail => (Array.isArray(detail?.fieldViolations) ? detail.fieldViolations : []).map(violation => violation?.field)) : [])]
    .filter(field => typeof field === "string" && field);
  const detail = typeof error?.message === "string" ? error.message : parsed ? "" : String(text || "");
  const excluded = /auth|permission|credential|quota|rate.limit|not.found|deployment|api.key|configuration|billing|payment/i.test(code) ||
    /api[ _-]?key|unauthori[sz]ed|permission denied|access denied|quota|rate limit|model (?:was )?not found|Requesty (?:router )?configuration|not approved|billing/i.test(detail);
  const targeted = fields.length ? fields.every(schemaField) :
    /response[ _.-]?format|(?:response[ _.-]?)?json[ _.-]?schema|response[ _.-]?schema|structured[ _-]?output/i.test(detail) &&
    /unsupported|not supported|does not support|invalid|incompatible|not allowed|unknown (?:field|keyword)|must (?:be|have)|too (?:large|complex|deep)/i.test(detail);
  return {
    structuredOutputCompatibility: !excluded && (!fields.length || fields.every(schemaField)) && (compatibilityCodes.has(code) || targeted),
    ...(safeProviderCodes.has(code) ? { providerCode: code } : {}),
  };
}

function isStructuredOutputCompatibilityError(error) {
  return error?.error === "LlmHttpError" && [400, 422].includes(error.status) &&
    error.structuredOutputCompatibility === true && !error.rateLimit && !error.verifiedContextLengthError && !error.terminalProviderFailure;
}

const logToken = value => String(value || "").replace(/[^A-Za-z0-9._:/-]/g, "_").slice(0, 160);
async function runSemanticIntentPlanner({ profile, payload, system, callContext, operationId, request, validate, log = (event, data) => console.info(event, data) }) {
  const started = Date.now();
  let mode = profile.capabilities.supportsJsonSchema ? "json_schema" : "json_object";
  let fallbackOccurred = false, attempts = 0;
  const record = (event, extra = {}) => log(`semantic-intent.${event}`, {
    provider: profile.provider, model: logToken(profile.requestyModel), structuredOutputMode: mode, fallbackOccurred,
    turnId: logToken(callContext?.turnId), operationId: logToken(operationId), durationMs: Date.now() - started, ...extra,
  });
  if (!profile.supported || (!profile.capabilities.supportsJsonSchema && !profile.capabilities.supportsJsonObject)) {
    const error = profile.supported ? "StructuredOutputUnsupported" : "MissingLlmConfiguration";
    record("request-failed", { code: error });
    return { ok: false, error, attempts: 0, fallbackOccurred };
  }
  const content = JSON.stringify(payload); // Exactly one JSON encoding inside a text message.
  for (let turn = 0; turn < 2; turn++) {
    const responseFormat = mode === "json_schema"
      ? { type: "json_schema", json_schema: { name: "semantic_intent_ir", strict: true, schema: SEMANTIC_INTENT_LLM_SCHEMA } }
      : { type: "json_object" };
    const formatInstruction = mode === "json_object"
      ? `Return exactly one JSON object matching the SemanticIntentIR structure below. Do not return Markdown, code fences, explanatory text, or any keys outside this structure.\n${JSON.stringify(SEMANTIC_INTENT_LLM_SCHEMA)}`
      : "Return exactly one JSON object matching the supplied SemanticIntentIR schema.";
    record("request", { attempt: turn + 1 });
    let result;
    try {
      result = await request({ messages: [{ role: "system", content: `${system}\n${formatInstruction}` }, { role: "user", content }], responseFormat });
    } catch (error) {
      if (error?.code === "OPERATION_ABORTED") throw error;
      record("request-failed", { code: "LlmRequestFailed" });
      return { ok: false, error: "LlmRequestFailed", attempts, structuredOutputMode: mode, fallbackOccurred };
    }
    attempts += Number.isInteger(result.attempts) ? result.attempts : 0;
    if (!result.ok) {
      if (!fallbackOccurred && mode === "json_schema" && profile.capabilities.supportsJsonObject && isStructuredOutputCompatibilityError(result)) {
        fallbackOccurred = true;
        record("structured-output-fallback", { status: result.status, code: result.providerCode || result.error, fallbackMode: "json_object" });
        mode = "json_object";
        continue;
      }
      record("request-failed", { status: result.status, code: result.providerCode || result.error });
      return { ...result, attempts, structuredOutputMode: mode, fallbackOccurred };
    }
    try {
      const raw = parseModelJsonValue(result.text);
      const parsed = validate(raw, result.text);
      record("success", { status: 200, attempts, retrievalScope: parsed.retrievalScope,
        patternShortcutCleared: raw.matchedPattern !== null && parsed.matchedPattern === null,
        objectAliasesNormalized: JSON.stringify(raw.objects) !== JSON.stringify(parsed.objects) });
      return { ...result, parsed, attempts, structuredOutputMode: mode, fallbackOccurred };
    } catch {
      record("validation-failed", { code: "InvalidStructuredOutput", attempts });
      return { ok: false, error: "InvalidStructuredOutput", attempts, structuredOutputMode: mode, fallbackOccurred };
    }
  }
}

module.exports = { SEMANTIC_INTENT_LLM_SCHEMA, structuredOutputErrorDetails, isStructuredOutputCompatibilityError, runSemanticIntentPlanner };
