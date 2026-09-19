"use strict";
const { textContent } = require("./shared/web-search.js");

// Generation stop/usage fields do not establish whether an answer exists.
function hasAssistantOutput(message) {
  return Boolean(textContent(message?.content).trim()) || Boolean(Array.isArray(message?.tool_calls) && message.tool_calls.some(call =>
    call?.type === "function" && typeof call.function?.name === "string" && call.function.name.trim()));
}

// Keep protocol identifiers and numeric usage only; never upstream messages,
// prompts, headers as a whole, reasoning, or arbitrary usage extensions.
function diagnostics(response = {}, headers, secret = "") {
  const identifier = value => typeof value === "string" && /^[\w.:/-]{1,160}$/.test(value) &&
    !(secret && value.includes(secret)) ? value : undefined;
  const choice = response.choices?.[0];
  const previous = response.responseDiagnostics || {};
  const finishReason = identifier(choice?.finish_reason ?? response.finishReason ?? previous.finishReason);
  const requestId = identifier(headers?.get?.("x-request-id") || headers?.get?.("request-id") ||
    response.request_id || response.id || response.requestId || previous.requestId);
  const providerCodes = [...new Set([
    ...(Array.isArray(previous.providerCodes) ? previous.providerCodes : []), ...(Array.isArray(response.providerCodes) ? response.providerCodes : []),
    response.error?.code, response.error?.type, response.code, response.provider_error?.code, response.error?.metadata?.code,
    choice?.error?.code, choice?.message?.error?.code, response.promptFeedback?.blockReason,
    response.prompt_feedback?.block_reason, choice?.finishReason,
  ].map(identifier).filter(Boolean))].slice(0, 8);
  const usage = {};
  const rawUsage = response.usage || previous.usage;
  for (const key of ["prompt_tokens", "completion_tokens", "total_tokens", "input_tokens", "output_tokens", "cost", "total_cost"]) {
    if (Number.isFinite(rawUsage?.[key]) && rawUsage[key] >= 0) usage[key] = rawUsage[key];
  }
  for (const key of ["prompt_tokens_details", "completion_tokens_details", "input_tokens_details", "output_tokens_details"]) {
    const details = {};
    for (const field of ["cached_tokens", "reasoning_tokens", "audio_tokens", "accepted_prediction_tokens", "rejected_prediction_tokens"]) {
      if (Number.isFinite(rawUsage?.[key]?.[field]) && rawUsage[key][field] >= 0) details[field] = rawUsage[key][field];
    }
    if (Object.keys(details).length) usage[key] = details;
  }
  return { ...(finishReason ? { finishReason } : {}), ...(requestId ? { requestId } : {}),
    ...(providerCodes.length ? { providerCodes } : {}), usage: Object.keys(usage).length ? usage : null };
}
module.exports = { hasAssistantOutput, diagnostics };
