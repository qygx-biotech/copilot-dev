"use strict";
const webSearch = require("./shared/web-search.js");

// Provider context is protocol data. Keep it off UI/source metadata and never
// truncate signatures or replace server invocations with local function results.
function checkContextSize(value) {
  if (JSON.stringify(value).length > 512000) {
    throw Object.assign(new Error("The provider tool context exceeded its limit."), { code: "PROVIDER_TOOL_CONTEXT_LIMIT" });
  }
  return value;
}

function mergeContext(target, delta, depth = 0) {
  if (depth > 16) throw new Error("Provider tool context nesting exceeded its limit.");
  const merged = { ...target };
  for (const [key, value] of Object.entries(delta || {})) {
    if (["__proto__", "constructor", "prototype"].includes(key)) continue;
    if (Array.isArray(value)) merged[key] = [...(Array.isArray(merged[key]) ? merged[key] : []), ...value];
    else if (value && typeof value === "object") merged[key] = mergeContext(merged[key], value, depth + 1);
    else merged[key] = value;
  }
  return checkContextSize(merged);
}

function assistantMessage(turn, localCalls) {
  const original = turn.providerMessage || turn.message || {};
  let index = 0;
  const calls = (original.tool_calls || []).map(call =>
    call?.type === "function" && !webSearch.isHostedTool(call) ? localCalls[index++] : call
  );
  return checkContextSize({ ...original, role: "assistant", content: original.content ?? null,
    tool_calls: calls.length ? calls : localCalls });
}

module.exports = { checkContextSize, mergeContext, assistantMessage };
