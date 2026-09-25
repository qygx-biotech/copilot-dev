"use strict";
const crypto = require("node:crypto");
const cache = new Map();
// Exact tool/vision/search capabilities checked against Requesty's public
// /v1/models catalog on 2026-09-20 (supports_tool_calling / supports_vision).
// Per-model deployment configuration can override these defaults.
const knownCapabilities = new Map([
  ["google/gemini-3.1-flash-lite:flex", Object.freeze({ jsonSchema: true, jsonObject: true, supportsWebSearch: true, supportsTools: true, supportsImages: true })],
  // Confirmed by successful Paper Card requests; do not extrapolate to other Gemma models.
  ["google/gemma-4-31b-it", Object.freeze({ jsonSchema: false, jsonObject: true, supportsWebSearch: false, supportsTools: true, supportsImages: true })],
]);
function capabilityDefaults(model) {
  return { ...knownCapabilities.get(model) };
}

function toolMode(env = {}) {
  return env.REQUESTY_TOOL_MODE === "combined" ? "combined" : "sequential";
}

function withCombinedToolConfig(request, mode = toolMode()) {
  // Google GenerateContent's opt-in, carried as an extra Requesty body field.
  // Keep this limited to our confirmed Gemini catalog, not Vertex or Gemini 2.x.
  if (mode !== "combined" || request.model !== "google/gemini-3.1-flash-lite:flex" ||
      !request.tools?.some(tool => tool.type === "web_search") ||
      !request.tools?.some(tool => tool.type === "function")) return request;
  return { ...request, toolConfig: { ...request.toolConfig, includeServerSideToolInvocations: true } };
}

const plannerProfiles = Object.freeze({
  gemini: { provider: "google", modelVariable: "REQUESTY_SEMANTIC_GEMINI_MODEL", defaultModel: "google/gemini-3.1-flash-lite:flex" },
  openai: { provider: "openai", modelVariable: "REQUESTY_SEMANTIC_OPENAI_MODEL", defaultModel: "" },
});
function modelProvider(model) {
  const prefix = String(model || "").split("/")[0];
  return ["google", "vertex"].includes(prefix) ? "google" : ["openai", "openai-responses"].includes(prefix) ? "openai" : "other";
}
function plannerProfile(env, selection, getCapabilities, explicitSelection = false) {
  // A captured UI model keeps precedence over an optional planner-only profile.
  // With no profile, retain the existing dedicated role/default selection.
  const id = explicitSelection ? "" : String(env.REQUESTY_SEMANTIC_PLANNER_PROFILE || "").trim();
  const definition = Object.hasOwn(plannerProfiles, id) ? plannerProfiles[id] : null;
  const model = id ? definition && (String(env[definition.modelVariable] || "").trim() || definition.defaultModel) : selection.model;
  const provider = modelProvider(model);
  const supported = Boolean(model) && (!id || Boolean(definition && provider === definition.provider));
  const capabilities = supported ? getCapabilities(model) : {};
  return {
    id: id || "selected", requestyModel: model || "", provider, supported,
    transport: "requesty-chat-completions",
    capabilities: { supportsJsonSchema: capabilities.jsonSchema === true, supportsJsonObject: capabilities.jsonObject === true },
    selection: { ...selection, model: model || "", provider, supported, capabilities },
  };
}
// Capabilities are account-key scoped, bounded and cached. Unknown fails closed.
async function catalogCapabilities(env, model, fetchImpl = fetch) {
  if (!env.REQUESTY_API_KEY) return {};
  const key = crypto.createHash("sha256").update(env.REQUESTY_API_KEY).digest("hex");
  let entry = cache.get(key);
  if (!entry || entry.expires < Date.now()) {
    if (cache.size >= 100) cache.delete(cache.keys().next().value);
    const promise = (async () => {
      try {
        const response = await fetchImpl("https://router.requesty.ai/v1/models", { headers: { Authorization: `Bearer ${env.REQUESTY_API_KEY}` }, signal: AbortSignal.timeout(4000) });
        if (!response.ok) return new Map();
        const body = await response.json();
        return new Map((Array.isArray(body?.data) ? body.data : []).slice(0, 10000).map(item => [item.id, { contextWindowTokens: Number(item.context_window || item.context_length || item.max_context_length) || undefined, supportsWebSearch: item.supports_web_search === true, supportsTools: item.supports_tool_calling === true || item.supports_tool_calls === true || item.supports_function_calling === true, supportsImages: item.supports_vision === true || (Array.isArray(item.input_modalities) && item.input_modalities.includes("image")) }]));
      } catch { return new Map(); }
    })();
    entry = { expires: Date.now() + 300000, promise }; cache.set(key, entry);
  }
  return (await entry.promise).get(model) || {};
}
async function webSearchCapability(env, model, configured, fetchImpl = fetch) {
  if (typeof configured === "boolean") return configured;
  return (await catalogCapabilities(env, model, fetchImpl)).supportsWebSearch === true;
}
async function agentCapabilities(env, model, configured = {}) {
  const defaults = { ...capabilityDefaults(model), ...configured };
  const catalog = ["supportsTools", "supportsImages", "supportsWebSearch"].some(key => typeof defaults[key] !== "boolean") ? await catalogCapabilities(env, model) : {};
  return { ...Object.fromEntries(["supportsTools", "supportsImages", "supportsWebSearch"].map(key => [key, typeof defaults[key] === "boolean" ? defaults[key] : catalog[key] === true])),
    ...(catalog.contextWindowTokens ? { contextWindowTokens: catalog.contextWindowTokens } : {}) };
}
module.exports = { agentCapabilities, capabilityDefaults, plannerProfile, webSearchCapability, withCombinedToolConfig, toolMode };
