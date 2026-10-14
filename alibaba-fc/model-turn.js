"use strict";

// Contract for POST /api/model/turn: one provider-neutral model call proxied
// through FC's existing Requesty and Responses transports. It holds no agent
// loop, tools, prompts or continuation state. Provider failures keep the exact
// result object the in-FC loop receives today, so a client-side
// context-recovery.js classifies them with the same overflow/inputQuota rules.

const crypto = require("node:crypto");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const webSearch = (() => { try { return require("./shared/web-search.js"); } catch { return require("../shared/web-search.js"); } })();

const LIMITS = Object.freeze({
  requestBytes: 24 * 1024 * 1024, messages: 2000, messageBytes: 8 * 1024 * 1024, contentParts: 64, images: 16,
  tools: 128, toolBytes: 64000, toolsBytes: 1000000, toolCalls: 64, toolArgumentCharacters: 512000, idCharacters: 256,
  responseFormatBytes: 64000, maxTokens: 131072, maxAttempts: 5, attemptOffset: 64, retryAfterMs: 120000,
});
const REQUEST_KEYS = new Set(["version", "model", "surface", "stage", "messages", "tools", "temperature", "max_tokens",
  "response_format", "stream", "callContext", "retry"]);
const ROLES = new Set(["system", "user", "assistant", "tool"]);
const TEXT_PARTS = new Set(["text", "input_text"]);
const IMAGE_PARTS = new Set(["image_url", "input_image"]);
const TRANSPORT_ERRORS = new Set(["LlmRequestFailed", "STREAM_INTERRUPTED", "InvalidLlmResponse", "ProviderRetryBudgetExceeded",
  "STREAM_IDENTITY_CONFLICT", "STREAM_TOO_LARGE"]);

const plain = value => Boolean(value) && typeof value === "object" && !Array.isArray(value);
const bytes = value => Buffer.byteLength(JSON.stringify(value));
const invalid = (error, message, status = 400) => ({ ok: false, status, error, message });
const boundedString = (value, max) => typeof value === "string" && value.length > 0 && value.length <= max;
const integerIn = (value, min, max) => Number.isSafeInteger(value) && value >= min && value <= max;

function validateContent(message) {
  const { role, content } = message;
  if (typeof content === "string") return { images: 0 };
  if (content === null || content === undefined) {
    return role === "assistant" ? { images: 0 } : { error: `A ${role} message requires content.` };
  }
  if (!Array.isArray(content) || content.length > LIMITS.contentParts) return { error: "Message content must be a string or a bounded part list." };
  let images = 0;
  for (const part of content) {
    if (!plain(part) || typeof part.type !== "string") return { error: "Every content part needs a type." };
    if (IMAGE_PARTS.has(part.type)) { images++; continue; }
    // Assistant parts are provider protocol output and are replayed unchanged.
    if (!TEXT_PARTS.has(part.type) && role !== "assistant") return { error: `Content part type ${part.type} is not supported.` };
    if (TEXT_PARTS.has(part.type) && typeof part.text !== "string") return { error: "Text parts require text." };
  }
  return { images };
}

function validateMessage(message) {
  if (!plain(message) || !ROLES.has(message.role)) return { error: "Every message needs a system, user, assistant or tool role." };
  if (bytes(message) > LIMITS.messageBytes) return { error: "A message exceeds the size limit.", status: 413 };
  if (message.role === "tool" && !boundedString(message.tool_call_id, LIMITS.idCharacters)) return { error: "Tool messages require a tool_call_id." };
  if (message.tool_calls !== undefined) {
    if (message.role !== "assistant" || !Array.isArray(message.tool_calls) || message.tool_calls.length > LIMITS.toolCalls) {
      return { error: "Only assistant messages may carry a bounded tool_calls list." };
    }
    for (const call of message.tool_calls) {
      if (!plain(call)) return { error: "Tool calls must be objects." };
      if (webSearch.isHostedTool(call)) continue;
      if (call.type !== "function" || !boundedString(call.id, LIMITS.idCharacters) || !plain(call.function) ||
          !boundedString(call.function.name, LIMITS.idCharacters) || typeof call.function.arguments !== "string" ||
          call.function.arguments.length > LIMITS.toolArgumentCharacters) return { error: "A function tool call is malformed or too large." };
    }
  }
  return validateContent(message);
}

function validateTools(tools) {
  if (!Array.isArray(tools) || tools.length > LIMITS.tools) return { error: `tools must be an array of at most ${LIMITS.tools}.` };
  if (bytes(tools) > LIMITS.toolsBytes) return { error: "The tool definitions exceed the size limit.", status: 413 };
  let functions = 0, hosted = 0;
  const names = new Set();
  for (const tool of tools) {
    if (!plain(tool) || bytes(tool) > LIMITS.toolBytes) return { error: "A tool definition is malformed or too large." };
    if (webSearch.isHostedTool(tool)) { hosted++; continue; }
    const fn = tool.function;
    if (tool.type !== "function" || !plain(fn) || typeof fn.name !== "string" || !/^[A-Za-z0-9_.:-]{1,128}$/.test(fn.name) ||
        names.has(fn.name) || (fn.parameters !== undefined && !plain(fn.parameters)) ||
        (fn.description !== undefined && typeof fn.description !== "string")) return { error: "A function tool definition is malformed." };
    names.add(fn.name);
    functions++;
  }
  return { functions, hosted };
}

// Shape and bounds only. Model authorization, capabilities and the provider
// call context are checked by the route against server-held configuration.
function validateRequest(body, rawBytes = 0) {
  if (rawBytes > LIMITS.requestBytes) return invalid("MODEL_TURN_TOO_LARGE", "The model request exceeds the size limit.", 413);
  if (!plain(body)) return invalid("INVALID_MODEL_TURN", "The model request must be a JSON object.");
  const unknown = Object.keys(body).filter(key => !REQUEST_KEYS.has(key));
  if (unknown.length) return invalid("INVALID_MODEL_TURN", `Unsupported field: ${unknown[0].slice(0, 80)}.`);
  if (body.version !== 1) return invalid("INVALID_MODEL_TURN", "version must be 1.");
  if (body.model !== undefined && !boundedString(body.model, 200)) return invalid("INVALID_CHAT_MODEL", "model must be a model identifier.");
  if (body.surface !== undefined && !["side_chat", "agent_command"].includes(body.surface)) return invalid("INVALID_MODEL_TURN", "surface must be side_chat or agent_command.");
  if (body.stage !== undefined && (typeof body.stage !== "string" || !/^[a-z][a-z0-9-]{0,63}$/.test(body.stage))) return invalid("INVALID_MODEL_TURN", "stage is invalid.");
  if (!Array.isArray(body.messages) || !body.messages.length) return invalid("INVALID_MODEL_TURN", "messages must be a non-empty array.");
  if (body.messages.length > LIMITS.messages) return invalid("MODEL_TURN_TOO_LARGE", `At most ${LIMITS.messages} messages are allowed.`, 413);
  let images = 0;
  for (const message of body.messages) {
    const checked = validateMessage(message);
    if (checked.error) return invalid(checked.status === 413 ? "MODEL_TURN_TOO_LARGE" : "INVALID_MODEL_TURN", checked.error, checked.status || 400);
    images += checked.images;
  }
  if (images > LIMITS.images) return invalid("MODEL_TURN_TOO_LARGE", `At most ${LIMITS.images} images are allowed.`, 413);
  let tools = { functions: 0, hosted: 0 };
  if (body.tools !== undefined) {
    tools = validateTools(body.tools);
    if (tools.error) return invalid(tools.status === 413 ? "MODEL_TURN_TOO_LARGE" : "INVALID_MODEL_TURN", tools.error, tools.status || 400);
  }
  if (body.temperature !== undefined && !(typeof body.temperature === "number" && body.temperature >= 0 && body.temperature <= 2)) {
    return invalid("INVALID_MODEL_TURN", "temperature must be between 0 and 2.");
  }
  if (body.max_tokens !== undefined && !integerIn(body.max_tokens, 1, LIMITS.maxTokens)) return invalid("INVALID_MODEL_TURN", `max_tokens must be 1–${LIMITS.maxTokens}.`);
  if (body.response_format !== undefined && (!plain(body.response_format) || !["text", "json_object", "json_schema"].includes(body.response_format.type) ||
      bytes(body.response_format) > LIMITS.responseFormatBytes)) return invalid("INVALID_MODEL_TURN", "response_format is invalid.");
  if (body.stream !== undefined && typeof body.stream !== "boolean") return invalid("INVALID_MODEL_TURN", "stream must be a boolean.");
  if (body.callContext !== undefined && !plain(body.callContext)) return invalid("INVALID_CALL_CONTEXT", "callContext must be an object.");
  const retry = body.retry || {};
  if (body.retry !== undefined && (!plain(body.retry) || Object.keys(retry).some(key => !["maxAttempts", "attemptOffset", "retryAfterMs"].includes(key)) ||
      (retry.maxAttempts !== undefined && !integerIn(retry.maxAttempts, 1, LIMITS.maxAttempts)) ||
      (retry.attemptOffset !== undefined && !integerIn(retry.attemptOffset, 0, LIMITS.attemptOffset)) ||
      (retry.retryAfterMs !== undefined && !integerIn(retry.retryAfterMs, 0, LIMITS.retryAfterMs)))) {
    return invalid("INVALID_MODEL_TURN", "retry is invalid.");
  }
  return { ok: true, images, functionTools: tools.functions, hostedTools: tools.hosted,
    request: { model: body.model, surface: body.surface || "side_chat", stage: body.stage || "model", messages: body.messages,
      ...(body.tools?.length ? { tools: body.tools } : {}), ...(body.temperature !== undefined ? { temperature: body.temperature } : {}),
      ...(body.max_tokens !== undefined ? { max_tokens: body.max_tokens } : {}), ...(body.response_format ? { response_format: body.response_format } : {}),
      stream: body.stream !== false, callContext: body.callContext, retry } };
}

// A convenience label derived from the existing classifiers. Clients that need
// exact recovery behaviour pass `result` itself to overflow()/inputQuota().
function category(result) {
  if (!result || result.ok) return null;
  if (require("./context-recovery.js").overflow(result)) return "context_overflow";
  if (require("./input-quota.js").inputQuota(result)) return "input_quota";
  if (result.rateLimit || result.status === 429 || ["rate_limit_exceeded", "insufficient_quota"].includes(result.error)) return "rate_limit";
  if ([401, 403].includes(Number(result.status)) || result.error === "invalid_api_key") return "auth";
  if (TRANSPORT_ERRORS.has(result.error) || result.transportError) return "transport";
  return "provider";
}

function usageTokens(usage) {
  if (!plain(usage)) return 0;
  const number = value => Number.isFinite(Number(value)) && Number(value) >= 0 ? Number(value) : 0;
  const total = number(usage.total_tokens);
  return total || number(usage.prompt_tokens ?? usage.input_tokens) + number(usage.completion_tokens ?? usage.output_tokens);
}

const userKey = account => crypto.createHash("sha256").update(String(account || "")).digest("hex").slice(0, 32);

// Optional, off by default. A soft per-user daily cap on provider-reported
// tokens for this endpoint. One call can overshoot; instances share counts only
// when MODEL_PROXY_USAGE_DIR is on shared storage.
function capFromEnv(env) {
  const cap = Number(env.MODEL_PROXY_DAILY_TOKEN_CAP);
  if (!Number.isSafeInteger(cap) || cap <= 0) return null;
  return { cap, dir: env.MODEL_PROXY_USAGE_DIR || path.join(os.tmpdir(), "biodesign-model-usage") };
}

const chains = new Map();
class DailyTokenLedger {
  constructor({ dir, now = Date.now }) { this.dir = dir; this.now = now; }
  file(key, at = this.now()) { return path.join(this.dir, key, new Date(at).toISOString().slice(0, 10) + ".json"); }
  async used(key) {
    try { return Number(JSON.parse(await fs.readFile(this.file(key), "utf8")).tokens) || 0; }
    catch (error) { if (error.code === "ENOENT") return 0; throw error; }
  }
  async add(key, tokens) {
    if (!tokens) return this.used(key);
    // Serialize updates for one user within this instance.
    const previous = chains.get(this.dir + key) || Promise.resolve();
    const next = previous.catch(() => {}).then(async () => {
      const file = this.file(key), total = await this.used(key) + tokens;
      await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
      const temporary = `${file}.${crypto.randomUUID()}.tmp`;
      await fs.writeFile(temporary, JSON.stringify({ tokens: total }), { mode: 0o600 });
      await fs.rename(temporary, file);
      return total;
    });
    chains.set(this.dir + key, next);
    return next;
  }
  retryAfterMs() {
    const now = this.now(), midnight = new Date(now);
    midnight.setUTCHours(24, 0, 0, 0);
    return midnight.getTime() - now;
  }
}

module.exports = { LIMITS, validateRequest, category, usageTokens, userKey, capFromEnv, DailyTokenLedger };
