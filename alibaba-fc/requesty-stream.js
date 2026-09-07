"use strict";
const { readEvents } = require("./shared/event-stream.js");
const streamError = message => Object.assign(new Error(message), { code: "STREAM_INTERRUPTED" });

async function readRequestyStream(response, { signal, onText = () => {} } = {}) {
  let content = "", finishReason = "", usage = null, done = false, toolBytes = 0;
  const calls = new Map();
  await readEvents(response, async event => {
    if (event.data === "[DONE]") { done = true; return false; }
    if (done) throw streamError("Unexpected data after the provider finished.");
    const chunk = JSON.parse(event.data);
    if (chunk.error) throw streamError("The provider interrupted its response.");
    if (chunk.usage && typeof chunk.usage === "object") usage = chunk.usage;
    const choice = chunk.choices?.find(choice => choice.index === 0) || chunk.choices?.[0];
    if (!choice) return;
    if (choice.finish_reason) finishReason = choice.finish_reason;
    const delta = choice.delta || {};
    if (typeof delta.content === "string") {
      content += delta.content;
      if (content.length > 512000) throw streamError("The provider response exceeded its limit.");
      await onText(delta.content);
    }
    for (const fragment of delta.tool_calls || []) {
      if (!Number.isInteger(fragment.index) || fragment.index < 0 || fragment.index >= 32) throw streamError("Invalid tool-call index.");
      const call = calls.get(fragment.index) || { id: "", type: "function", function: { name: "", arguments: "" } };
      if (fragment.id && fragment.id !== call.id) call.id += fragment.id;
      if (typeof fragment.function?.name === "string") call.function.name += fragment.function.name;
      if (typeof fragment.function?.arguments === "string") {
        call.function.arguments += fragment.function.arguments;
        toolBytes += fragment.function.arguments.length;
      }
      if (toolBytes > 512000 || call.function.name.length > 256 || call.id.length > 256) throw streamError("The tool call exceeded its limit.");
      calls.set(fragment.index, call);
    }
  }, { signal });
  if (!done || !["stop", "tool_calls", "function_call"].includes(finishReason)) throw streamError("The provider response did not finish successfully.");
  return { choices: [{ message: { role: "assistant", content,
    ...(calls.size ? { tool_calls: [...calls].sort(([a], [b]) => a - b).map(([, call]) => call) } : {}) }, finish_reason: finishReason }], usage };
}
module.exports = { readRequestyStream };
