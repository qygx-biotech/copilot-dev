"use strict";

// Runs one segment of the desktop agent loop (until a host boundary or the end
// of the turn): request construction, image projection, streamed preview,
// transcript checkpoints, context recovery and the loop. Model calls go
// through `send`, which the local driver points at the FC model proxy.

const transcript = require("../conversation-transcript.js");
const eventStream = require("../event-stream.js");
const contextApi = require("./context-recovery.js");
const agentStep = require("./agent-step.js");
const { runSideChatAgent } = require("./side-chat-agent.js");
const requestContext = require("./request-context.js");
const collaborationModes = require("../collaboration-modes.js");

// Stages whose text is never streamed to the user.
const SILENT_STAGES = ["context-summary", "corpus-summary", "literature-specialist"];

function originalRequestOf(messages, desktopContext) {
  const lastUserContent = (Array.isArray(messages) ? messages : []).findLast(message => message?.role === "user")?.content;
  return desktopContext.originalRequest ?? (typeof lastUserContent === "string" ? lastUserContent.trim()
    : Array.isArray(lastUserContent) ? lastUserContent.filter(part => ["text", "input_text"].includes(part?.type)).map(part => part.text || "").join("\n").trim() : "");
}

async function runWorkspaceAgent({
  messages, workspaceContext = {}, responseMode = "agent_instruction", callContext = null, streaming = null, desktopContext = {},
  model, api, provider, toolMode, agentCapabilities, supportsWebSearch, contextConfig, loopBudget,
  providerCapabilities, providerProfile, scope,
  estimateBody = body => body, decorateRequest = request => request, send, hostBatchLimit,
}) {
  // Capture task identity before consecutive user messages are serialized.
  const originalRequest = originalRequestOf(messages, desktopContext);
  // The request governor owns context fitting. Keep permitted conversation
  // content intact here; the transport guard remains the size boundary.
  const cleanedMessages = transcript.messages(messages, { preserveContent: true });
  if (cleanedMessages.length === 0) return { ok: false, reason: "No valid messages were provided." };
  if (desktopContext.images?.length && !agentCapabilities?.supportsImages) {
    return { ok: false, error: "MODEL_IMAGE_CAPABILITY_UNAVAILABLE", reason: "Image input is unavailable or unconfirmed for the selected model. The model was not changed." };
  }
  const buildAgentRequest = ({ messages: agentMessages, tools, temperature, stage, maxTokens, response_format }) => {
    if (api === "chat_completions" && agentMessages.some(message => message.provider_context)) {
      throw Object.assign(new Error("Provider context belongs to a different API."), { code: "PROVIDER_CONTEXT_MISMATCH" });
    }
    const includeImages = !["web-search", "context-summary", "corpus-summary"].includes(stage);
    const providerMessages = agentStep.projectImages(agentMessages, {
      attachments: includeImages ? desktopContext.images || [] : [],
      supportsImages: includeImages && agentCapabilities?.supportsImages === true,
    });
    return decorateRequest({ model, messages: providerMessages, temperature,
      max_tokens: maxTokens || contextConfig.outputTokens,
      ...(response_format ? { response_format } : {}),
      ...(Array.isArray(tools) && tools.length ? { tools } : {}), ...requestContext.requestyMetadata(callContext) });
  };
  let previousTranscriptCheckpoint = null;
  return runSideChatAgent({
    toolMode, model, signal: desktopContext.signal || streaming?.signal,
    providerCapabilities,
    runtimeRevokedTools: desktopContext.runtimeRevokedTools,
    loopBudget, ...(hostBatchLimit !== undefined ? { hostBatchLimit } : {}),
    contextOptions: { providerProfile, config: contextConfig, provider, endpoint: scope.endpoint,
      signal: AbortSignal.any([desktopContext.signal, streaming?.signal].filter(Boolean)),
      account: scope.account, quotaEndpoint: scope.quotaEndpoint, quotaAccount: scope.quotaAccount,
      archiveAccount: JSON.stringify([desktopContext.account, workspaceContext.localWorkspaceContext?.project?.workspaceId || ""]), requestId: callContext?.turnId,
      measure: options => contextApi.estimateRequest(estimateBody(buildAgentRequest(options)), contextConfig.imageTokens) },
    runtimeExtensions: desktopContext.runtimeExtensions, runtimeInjections: desktopContext.runtimeInjections,
    conversationTranscript: desktopContext.conversationTranscript,
    turnId: callContext?.turnId,
    onTranscript: streaming ? async conversationTurn => {
      await streaming.emit("transcript", transcript.checkpointEvent(previousTranscriptCheckpoint, conversationTurn));
      previousTranscriptCheckpoint = conversationTurn;
    } : undefined,
    supportsWebSearch,
    ...(agentCapabilities ? { supportsTools: agentCapabilities.supportsTools, supportsImages: agentCapabilities.supportsImages === true } : {}),
    projectToolsEnabled: desktopContext.projectTools === true,
    imageCount: desktopContext.images?.length || 0,
    desktopDownloads: desktopContext.enabled === true,
    desktopLiterature: desktopContext.literature === true,
    downloadPermission: desktopContext.permission || "read_only",
    collaborationMode: desktopContext.collaborationMode || "default",
    resume: desktopContext.resume || null,
    surface: responseMode === "side_chat" ? "side_chat" : "agent_command",
    conversationMessages: cleanedMessages,
    originalRequest,
    workspaceContext,
    systemPrompt: responseMode === "side_chat" ? requestContext.sideChatSystemPrompt
      : desktopContext.collaborationMode === "plan" ? `${requestContext.systemPrompt}\n\n${collaborationModes.PLAN_PROMPT}` : requestContext.systemPrompt,
    parseFinalAnswer: responseMode === "side_chat" ? requestContext.parseSideChatResponse : requestContext.parseModelResponse,
    onProgress: streaming ? async event => {
      if (["web-search", "search-completed", "model-request", "tool-running"].includes(event.stage)) await streaming.emit("reset", {});
      if (event.webSearchSources?.length) await streaming.emit("sources", { webSearchSources: event.webSearchSources });
      await streaming.emit("status", event);
    } : undefined,
    requestTurn: async ({ messages: agentMessages, tools, temperature, stage, retryAfterMs, maxAttempts, attemptOffset, maxTokens, response_format, signal, deadlineAt: callDeadlineAt, providerCallTimeoutMs }) => {
      let accumulated = "", visible = "";
      const requestSignal = [signal, desktopContext.signal, streaming?.signal].filter(Boolean);
      const combinedSignal = requestSignal.length ? AbortSignal.any(requestSignal) : undefined;
      // Text hooks for the transport: `preview` shows only a JSON reply field
      // as it streams; `raw` forwards native Responses text unchanged.
      const stream = streaming && !SILENT_STAGES.includes(stage) ? {
        preview: async delta => {
          accumulated += delta;
          const preview = responseMode !== "side_chat" || stage === "web-search" ? accumulated : eventStream.previewReply(accumulated);
          if (preview === visible) return;
          if (!preview.startsWith(visible)) await streaming.emit("reset", {});
          const next = preview.startsWith(visible) ? preview.slice(visible.length) : preview;
          visible = preview;
          if (next) await streaming.emit("delta", { text: next });
        },
        raw: async text => streaming.emit("delta", { text }),
        sources: async sources => streaming.emit("sources", { webSearchSources: sources }),
      } : null;
      return send(buildAgentRequest({ messages: agentMessages, tools, temperature, stage, maxTokens, response_format }), {
        stage, retryAfterMs, maxAttempts, attemptOffset, deadlineAt: callDeadlineAt, providerCallTimeoutMs, signal: combinedSignal,
        stream, onAttempt: streaming ? event => streaming.emit("status", event) : undefined });
    },
  });
}

module.exports = { runWorkspaceAgent, originalRequestOf, SILENT_STAGES };
