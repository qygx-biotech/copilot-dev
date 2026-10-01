"use strict";
const { textContent } = require("./shared/web-search.js");

// Fixed allowlists: never expose exception messages, stacks, socket addresses,
// headers, or arbitrary provider-supplied error codes from a thrown exception.
const transportCodes = new Set(["ENOTFOUND", "EAI_AGAIN", "ECONNREFUSED", "ECONNRESET", "ETIMEDOUT", "EPIPE", "ENETUNREACH", "EHOSTUNREACH",
  "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_HEADERS_TIMEOUT", "UND_ERR_BODY_TIMEOUT", "UND_ERR_SOCKET", "UND_ERR_CONNECT", "UND_ERR_ABORTED",
  "UND_ERR_INVALID_ARG", "ERR_INVALID_ARG_TYPE", "ERR_INVALID_ARG_VALUE", "ERR_INVALID_URL", "ERR_INVALID_HTTP_TOKEN", "ERR_HTTP_INVALID_HEADER_VALUE",
  "CERT_HAS_EXPIRED", "CERT_NOT_YET_VALID", "DEPTH_ZERO_SELF_SIGNED_CERT", "SELF_SIGNED_CERT_IN_CHAIN", "UNABLE_TO_VERIFY_LEAF_SIGNATURE", "UNABLE_TO_GET_ISSUER_CERT_LOCALLY", "ERR_TLS_CERT_ALTNAME_INVALID"]);
const exceptionNames = new Set(["Error", "TypeError", "RangeError", "ReferenceError", "SyntaxError", "AggregateError", "AbortError", "TimeoutError"]);
function transportDiagnostics(value = {}) {
  return {
    ...(["request_setup", "fetch"].includes(value.transportPhase) ? { transportPhase: value.transportPhase } : {}),
    ...(exceptionNames.has(value.exceptionName) ? { exceptionName: value.exceptionName } : {}),
    ...(transportCodes.has(value.transportCode) ? { transportCode: value.transportCode } : {}),
    ...(transportCodes.has(value.transportCauseCode) ? { transportCauseCode: value.transportCauseCode } : {}),
  };
}
function fetchException(error, transportPhase = "fetch") {
  const pending = [error], seen = new Set(), codes = [];
  while (pending.length && seen.size < 12) {
    const item = pending.shift();
    if (!item || typeof item !== "object" || seen.has(item)) continue;
    seen.add(item);
    if (transportCodes.has(item.code) && !codes.includes(item.code)) codes.push(item.code);
    if (item.cause) pending.push(item.cause);
    if (Array.isArray(item.errors)) pending.push(...item.errors.slice(0, 8));
  }
  return transportDiagnostics({ transportPhase, exceptionName: error?.name, transportCode: codes[0], transportCauseCode: codes[1] });
}

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
  return { ...transportDiagnostics({ ...previous, ...response }), ...(finishReason ? { finishReason } : {}), ...(requestId ? { requestId } : {}),
    ...(providerCodes.length ? { providerCodes } : {}), usage: Object.keys(usage).length ? usage : null };
}
module.exports = { hasAssistantOutput, diagnostics, fetchException, fetchExceptionFields: transportDiagnostics };
