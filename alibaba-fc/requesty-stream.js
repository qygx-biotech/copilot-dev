"use strict";
const webSearch = require("./shared/web-search.js");
const { readEvents } = require("./shared/event-stream.js");
const { mergeContext, checkContextSize } = require("./requesty-tool-context.js");
const streamError = message => Object.assign(new Error(message), { code: "STREAM_INTERRUPTED" });

async function readRequestyStream(response, { signal, onText = () => {}, onSources = () => {} } = {}) {
  let content = "", finishReason = "", usage = null, done = false, toolBytes = 0;
  const calls = new Map();
  let responseDiagnostics = {};
  let context = {}, contentParts = null, completedMessage = null;
  let webSearchSources = [], webSearchMetadata = [];
  const metadataPaths = new Set(), containerPaths = new Set();
  let chunkCount = 0, metadataEnvelopeCount = 0;
  await readEvents(response, async event => {
    if (event.data === "[DONE]") { done = true; return false; }
    if (done) throw streamError("Unexpected data after the provider finished.");
    const chunk = JSON.parse(event.data);
    responseDiagnostics = require("./requesty-response.js").diagnostics({ ...chunk, responseDiagnostics });
    if (chunk.error) throw streamError("The provider interrupted its response.");
    if (chunk.usage && typeof chunk.usage === "object") usage = chunk.usage;
    const normalized = webSearch.normalizeResponse(chunk);
    chunkCount++;
    metadataEnvelopeCount += normalized.webSearchDiagnostics.metadataEnvelopeCount;
    for (const path of normalized.webSearchDiagnostics.metadataPaths) if (metadataPaths.size < 48) metadataPaths.add(path);
    for (const path of normalized.webSearchDiagnostics.containerPaths) if (containerPaths.size < 48) containerPaths.add(path);
    webSearchSources = webSearch.mergeSources(webSearchSources, normalized.webSearchSources);
    webSearchMetadata = webSearch.mergeMetadata(webSearchMetadata, normalized.webSearchMetadata);
    if (normalized.webSearchSources.length) await onSources(webSearchSources);
    const choice = chunk.choices?.find(choice => choice.index === 0) || chunk.choices?.[0];
    if (!choice) return;
    if (choice.finish_reason) finishReason = choice.finish_reason;
    if (choice.message) completedMessage = checkContextSize(choice.message);
    const delta = choice.delta || {};
    const { content: rawContent, tool_calls: _calls, role: _role, ...extra } = delta;
    context = mergeContext(context, extra);
    if (Array.isArray(rawContent)) contentParts = [...(contentParts || []), ...rawContent];
    const deltaText = webSearch.textContent(delta.content);
    if (deltaText) {
      content += deltaText;
      if (content.length > 512000) throw streamError("The provider response exceeded its limit.");
      await onText(deltaText);
    }
    for (const fragment of delta.tool_calls || []) {
      const indexed = Number.isInteger(fragment.index) && fragment.index >= 0 && fragment.index < 32;
      if (!indexed && !(webSearch.isHostedTool(fragment) && fragment.id)) throw streamError("Invalid tool-call index.");
      const key = indexed ? fragment.index : `hosted:${fragment.id}`;
      const previous = calls.get(key) || { id: "", type: fragment.type || "function" };
      const { index: _index, id, function: fn, ...extraCall } = fragment;
      const call = mergeContext(previous, extraCall);
      if (id && id !== call.id) call.id += id;
      if (fn) {
        const { name, arguments: args, ...extraFunction } = fn;
        call.function = mergeContext(call.function || { name: "", arguments: "" }, extraFunction);
        if (typeof name === "string") call.function.name += name;
        if (typeof args === "string") {
          call.function.arguments += args;
          toolBytes += args.length;
        }
      }
      if (toolBytes > 512000 || call.function?.name?.length > 256 || call.id.length > 256) throw streamError("The tool call exceeded its limit.");
      calls.set(key, call);
      if (calls.size > 32) throw streamError("Too many provider tool calls.");
    }
    checkContextSize({ context, contentParts, calls: [...calls.values()] });
  }, { signal });
  const providerMessage = completedMessage || { ...context, role: "assistant", content: contentParts || content,
    ...(calls.size ? { tool_calls: [...calls].sort(([a], [b]) => typeof a === "number" && typeof b === "number" ? a - b : 0).map(([, call]) => call) } : {}) };
  if (!done || (require("./requesty-response.js").hasAssistantOutput(providerMessage) &&
      !["stop", "tool_calls", "function_call"].includes(finishReason))) throw streamError("The provider response did not finish successfully.");
  checkContextSize(providerMessage);
  const localCalls = (providerMessage.tool_calls || []).filter(call => !webSearch.isHostedTool(call));
  return { responseDiagnostics, webSearchSources, webSearchMetadata, webSearchDiagnostics: { chunkCount, metadataEnvelopeCount, metadataPaths: [...metadataPaths], containerPaths: [...containerPaths] },
    providerMessage, choices: [{ message: { ...providerMessage,
    content: webSearch.textContent(providerMessage.content), tool_calls: localCalls.length ? localCalls : undefined }, finish_reason: finishReason }], usage };
}
module.exports = { readRequestyStream };
