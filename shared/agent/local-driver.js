"use strict";

// The agent loop as the desktop app runs it, in the loop utility process:
//   - model calls go through the authenticated FC model proxy (`callModel`);
//     FC holds the provider keys and the desktop never sees them;
//   - loop state stays in this process: at each step boundary (host tools,
//     runtime checkpoints) the host is asked to act and the loop resumes in
//     place;
//   - context archives live under the project (`archiveRoot`). Per-call
//     timeouts and quota waits apply; a turn has no overall request deadline.

const requestContext = require("./request-context.js");
const { admitDesktopContext } = require("./request-admission.js");
const { runWorkspaceAgent } = require("./agent-host.js");
const { withResults } = require("./receipt-admission.js");

// Receipts are bounded individually by the host; a step can return at most
// one receipt per provider tool call.
const HOST_BATCH_LIMIT = 64;
const RECEIPT_CHARACTERS_PER_CALL = 90000;
const PROXY_RETRY_COOLDOWN_LIMIT_MS = 120000;
const TRANSPORT_FAILURES = new Set(["STREAM_INTERRUPTED", "STREAM_INVALID", "STREAM_TOO_LARGE", "MODEL_PROXY_UNREACHABLE",
  "MODEL_PROXY_HTTP_ERROR", "MODEL_PROXY_INVALID_RESPONSE"]);

const rejected = (code, message, status = 400) => Object.assign(new Error(message || code), { code, status });

// Proxy, session and gateway failures become ordinary failed turns. They carry
// `proxyStatus`, never `status`, so provider overflow and input-quota
// classifiers cannot mistake a proxy limit for a provider limit.
function proxyFailure(error) {
  const message = String(error?.message || "The model proxy request failed.").slice(0, 500);
  if (TRANSPORT_FAILURES.has(error?.code)) {
    return { ok: false, error: error.code === "STREAM_INTERRUPTED" ? "STREAM_INTERRUPTED" : "LlmRequestFailed", message, reason: message, attempts: 1,
      transportError: { message: "model proxy unavailable", ...(error.causeCode ? { causeCode: error.causeCode } : {}) } };
  }
  return { ok: false, error: String(error?.code || "MODEL_PROXY_FAILED"), origin: "proxy", message, reason: message, attempts: 0, terminalProviderFailure: true,
    ...(error?.status ? { proxyStatus: error.status } : {}), ...(error?.retryAfterMs !== undefined ? { retryAfterMs: error.retryAfterMs } : {}),
    ...(error?.capability ? { capability: error.capability } : {}) };
}

function admitRequest(body, capabilities, signal) {
  if (!body || typeof body !== "object" || Array.isArray(body)) throw rejected("INVALID_REQUEST", "The agent request must be an object.");
  const lastUserContent = (Array.isArray(body.messages) ? body.messages : []).findLast(message => message?.role === "user")?.content;
  const originalRequest = body.originalRequest ?? (typeof lastUserContent === "string" ? lastUserContent.trim() : Array.isArray(lastUserContent)
    ? lastUserContent.filter(part => ["text", "input_text"].includes(part?.type)).map(part => part.text || "").join("\n").trim() : "");
  if (typeof originalRequest !== "string" || !originalRequest.trim() || originalRequest.length > requestContext.MAX_CHAT_MESSAGE_CHARACTERS) {
    throw rejected("INVALID_ORIGINAL_REQUEST", "A bounded original user request is required.");
  }
  // Browser-session uploads and stored OSS documents are not loop inputs.
  const nonEmpty = value => Array.isArray(value) ? value.length > 0 : requestContext.isPlainObject(value) && Object.keys(value).length > 0;
  if (["referenceDocuments", "experimentDocuments", "experimentNotes", "experimentModules", "storedDocuments", "selectedDocumentKeys"].some(key => nonEmpty(body[key]))) {
    throw rejected("LOCAL_LOOP_UNSUPPORTED_REQUEST", "Browser-session uploads and stored documents are not supported by the agent loop.");
  }
  // The proxy validates a named model; anything else is not a model choice.
  if (body.model !== undefined && (typeof body.model !== "string" || !body.model.trim() || body.model.length > 200)) {
    throw rejected("INVALID_CHAT_MODEL", "The selected chat model is not supported.");
  }
  const responseMode = body.mode === "side_chat" ? "side_chat" : "agent_instruction";
  const callContext = requestContext.normalizeProviderCallContext(body.callContext, "answer");
  if (!callContext) throw rejected("INVALID_CALL_CONTEXT", "The answer call context is invalid.");
  if (body.localWorkspaceContext !== undefined && !requestContext.isPlainObject(body.localWorkspaceContext)) {
    throw rejected("INVALID_REQUEST", 'The optional "localWorkspaceContext" field must be an object.');
  }
  const localWorkspaceContext = requestContext.sanitizeLocalWorkspaceContext(body.localWorkspaceContext, originalRequest);
  if (responseMode === "side_chat" && localWorkspaceContext) localWorkspaceContext.semantic = null;
  if (responseMode !== "side_chat" && body.localWorkspaceContext?.semantic !== undefined && !localWorkspaceContext?.semantic) {
    throw rejected("INVALID_SEMANTIC_CONTEXT", "The semantic request context is invalid.");
  }
  const admitted = admitDesktopContext(body, { responseMode, originalRequest, localWorkspaceContext,
    account: capabilities.accountScope, signal, childModel: capabilities.model });
  if (admitted.error) throw rejected(admitted.error.body.error, admitted.error.body.message);
  const projectContext = typeof body.projectContext === "string" ? body.projectContext.trim().slice(0, 4000) : "";
  const storedDocumentResult = { documents: [], summaries: [], inventory: [], selectedObjectKeys: [],
    routingMode: requestContext.emptyDocumentRoutingMode(body.messages) };
  // The (empty) experiment modules are reported for every module.
  const experimentModules = requestContext.sanitizeExperimentModules({});
  const workspaceContext = { projectContext, referenceDocuments: [], experimentDocuments: [], experimentNotes: [], experimentModules,
    storedDocuments: [], storedDocumentSummaries: [], storedDocumentInventory: [], documentRoutingMode: storedDocumentResult.routingMode, localWorkspaceContext };
  return { originalRequest, responseMode, callContext, localWorkspaceContext, desktopContext: admitted.desktopContext, workspaceContext, storedDocumentResult };
}

// The host answers a boundary with the tool receipts, queued runtime input and
// its current workspace context (tools refresh it in place). Shape is checked
// here; content by full re-admission.
function admitBoundaryReply(reply) {
  if (!reply || typeof reply !== "object" || Array.isArray(reply)) throw rejected("INVALID_TOOL_CONTINUATION", "The host boundary reply is invalid.");
  const results = reply.desktopToolResults ?? [];
  if (!Array.isArray(results)) throw rejected("INVALID_TOOL_CONTINUATION", "The host returned invalid tool results.");
  return { results, update: { runtimeInjections: reply.runtimeInjections ?? [], runtimeRevokedTools: reply.runtimeRevokedTools ?? [],
    ...(reply.localWorkspaceContext !== undefined ? { localWorkspaceContext: reply.localWorkspaceContext } : {}) } };
}

async function runLocalAgentTurn({ body, capabilities, callModel, boundary, emit = async () => {}, signal, archiveRoot,
  hostBatchLimit = HOST_BATCH_LIMIT }) {
  // Every step re-admits the whole request, with the runtime input and
  // workspace context the host supplied at the last boundary.
  let currentBody = body;
  let admitted = admitRequest(currentBody, capabilities, signal);
  const { responseMode, callContext } = admitted;
  const surface = responseMode === "side_chat" ? "side_chat" : "agent_command";
  const streaming = { signal, emit: async (name, data) => emit({ ...data, type: name }) };
  const api = capabilities.api;
  const send = async (request, { stage, retryAfterMs, maxAttempts, attemptOffset, signal: callSignal, stream, onAttempt }) => {
    // A provider cooldown longer than the proxy's retry limit is reported
    // without dispatching.
    if (retryAfterMs > PROXY_RETRY_COOLDOWN_LIMIT_MS) {
      const message = "The provider retry does not fit the remaining request time budget.";
      return { ok: false, error: "ProviderRetryBudgetExceeded", attempts: 0, recoveryStopReason: "cooldown_exceeds_limit", message, reason: message };
    }
    // The proxy resolves the model and applies Requesty tags from callContext.
    const { model: _resolvedModel, requesty: _tags, ...providerRequest } = request;
    const retry = { ...(Number.isInteger(maxAttempts) ? { maxAttempts: Math.max(1, Math.min(5, maxAttempts)) } : {}),
      ...(attemptOffset > 0 ? { attemptOffset: Math.min(64, Math.floor(attemptOffset)) } : {}),
      ...(retryAfterMs > 0 ? { retryAfterMs: Math.ceil(retryAfterMs) } : {}) };
    let final;
    try {
      final = await callModel({ signal: callSignal, request: { ...(typeof body.model === "string" ? { model: body.model } : {}), surface,
        ...(stage ? { stage } : {}), ...providerRequest, callContext, ...(Object.keys(retry).length ? { retry } : {}) },
      onEvent: async event => {
        if (event.type === "delta" && stream) await (api === "responses" ? stream.raw(event.text) : stream.preview(event.text));
        else if (event.type === "sources" && stream) await stream.sources(event.webSearchSources);
        else if (event.type === "status") await onAttempt?.(event);
      } });
    } catch (error) {
      if (callSignal?.aborted || error?.code === "OPERATION_ABORTED") throw Object.assign(new Error("The request was cancelled."), { code: "OPERATION_ABORTED" });
      return proxyFailure(error);
    }
    const turn = final?.result;
    if (!turn || typeof turn !== "object") return proxyFailure({ code: "MODEL_PROXY_INVALID_RESPONSE", message: "The model proxy returned no result." });
    return turn.ok ? turn : { ...turn, reason: turn.message };
  };

  let resume = null;
  for (;;) {
    if (signal?.aborted) throw rejected("OPERATION_ABORTED", "The agent turn was cancelled.");
    const { localWorkspaceContext, workspaceContext, storedDocumentResult } = admitted;
    const desktopContext = { ...admitted.desktopContext, resume };
    const result = await runWorkspaceAgent({ messages: currentBody.messages, workspaceContext, responseMode, callContext, streaming, desktopContext,
      model: capabilities.model, api, provider: capabilities.provider, toolMode: capabilities.toolMode,
      agentCapabilities: capabilities.agentCapabilities, supportsWebSearch: capabilities.supportsWebSearch,
      contextConfig: { ...capabilities.contextConfig, root: archiveRoot, debug: false }, loopBudget: capabilities.loopBudget,
      providerCapabilities: capabilities.providerCapabilities, providerProfile: capabilities.providerProfile,
      scope: capabilities.scope, send, hostBatchLimit });
    if (!result.ok) {
      if (result.error === "AUTH_REQUIRED") throw rejected("AUTH_REQUIRED", "The desktop session is not authorized.", 401);
      return requestContext.agentFailureBody(result, { responseMode, originalRequest: desktopContext.originalRequest,
        answerLanguage: localWorkspaceContext?.agentLoop?.answerLanguage });
    }
    const resumable = Boolean(result.continuationState) && !result.data.evidenceRecovery;
    const data = requestContext.agentSuccessBody(result, { model: capabilities.model, storedDocumentResult, localWorkspaceContext,
      experimentModules: workspaceContext.experimentModules });
    if (!resumable) return data;
    // The host runs pending tools and runtime checkpoints, then either
    // supplies the next step's input or ends the turn.
    const reply = await boundary(data);
    if (!reply) return data;
    const next = admitBoundaryReply(reply);
    currentBody = { ...currentBody, ...next.update };
    admitted = admitRequest(currentBody, capabilities, signal);
    // An invalid receipt is a malformed host reply; it ends the turn as a
    // request rejection.
    try { resume = withResults(result.continuationState, next.results, { receiptCharacters: hostBatchLimit * RECEIPT_CHARACTERS_PER_CALL }); }
    catch (error) { throw rejected(error?.code || "INVALID_TOOL_CONTINUATION", error?.message || "The host tool receipts are invalid."); }
  }
}

module.exports = { runLocalAgentTurn, HOST_BATCH_LIMIT, RECEIPT_CHARACTERS_PER_CALL };
