(function exposeEventStream(root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.BioDesignEventStream = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";
  const failure = (code, message) => Object.assign(new Error(message), { code });
  async function readEvents(response, onEvent, { signal, maxBytes = 8 * 1024 * 1024 } = {}) {
    if (!response.body?.getReader) throw failure("STREAM_UNAVAILABLE", "Streaming is unavailable on this connection.");
    const reader = response.body.getReader(), decoder = new TextDecoder();
    let buffer = "", data = [], type = "message", bytes = 0, frameSize = 0;
    const abort = () => { reader.cancel().catch(() => {}); };
    signal?.addEventListener("abort", abort, { once: true });
    try {
      while (true) {
        if (signal?.aborted) throw failure("OPERATION_ABORTED", "The request was cancelled.");
        const next = await reader.read();
        if (signal?.aborted) throw failure("OPERATION_ABORTED", "The request was cancelled.");
        if (next.done) break;
        bytes += next.value.byteLength;
        if (bytes > maxBytes) throw failure("STREAM_TOO_LARGE", "The response exceeded the stream limit.");
        buffer += decoder.decode(next.value, { stream: true });
        let newline;
        while ((newline = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, newline).replace(/\r$/, "");
          buffer = buffer.slice(newline + 1);
          frameSize += line.length;
          if (frameSize > 1024 * 1024) throw failure("STREAM_TOO_LARGE", "A stream event exceeded the limit.");
          if (!line) {
            if (data.length && await onEvent({ event: type, data: data.join("\n") }) === false) return;
            data = []; type = "message"; frameSize = 0;
          } else if (line.startsWith("data:")) data.push(line.slice(5).replace(/^ /, ""));
          else if (line.startsWith("event:")) type = line.slice(6).trim();
        }
        if (buffer.length > 1024 * 1024) throw failure("STREAM_TOO_LARGE", "A stream event exceeded the limit.");
      }
      buffer += decoder.decode();
      if (buffer.trim() || data.length) throw failure("STREAM_INTERRUPTED", "The response ended during a stream event.");
    } finally {
      signal?.removeEventListener("abort", abort);
      await reader.cancel().catch(() => {});
      reader.releaseLock();
    }
  }

  // Decode just the top-level reply string of an unfinished JSON response.
  // This never treats tool arguments, reasoning fields, or partial project data
  // as a completed answer. Plain Markdown remains directly streamable.
  function previewReply(content, structured = false) {
    const text = String(content || "").replace(/^\s*```(?:json)?\s*\n?/i, "");
    if (!structured && !text.trimStart().startsWith("{")) return text;
    let depth = 0;
    for (let i = 0; i < text.length; i++) {
      if (text[i] === "{") depth++;
      else if (text[i] === "}") depth--;
      else if (text[i] === '"') {
        const start = i++;
        while (i < text.length && text[i] !== '"') { if (text[i] === "\\") i++; i++; }
        if (i >= text.length) return "";
        if (depth !== 1 || text.slice(start, i + 1) !== '"reply"') continue;
        const value = text.slice(i + 1).match(/^\s*:\s*"/);
        if (!value) continue;
        let result = "";
        for (let j = i + 1 + value[0].length; j < text.length; j++) {
          const char = text[j];
          if (char === '"') return result;
          if (char !== "\\") { result += char; continue; }
          if (++j >= text.length) break;
          if (text[j] === "u") {
            const hex = text.slice(j + 1, j + 5);
            if (!/^[\da-f]{4}$/i.test(hex)) break;
            result += String.fromCharCode(parseInt(hex, 16)); j += 4;
          } else {
            const escaped = { '"': '"', "\\": "\\", "/": "/", b: "\b", f: "\f", n: "\n", r: "\r", t: "\t" }[text[j]];
            if (escaped === undefined) break;
            result += escaped;
          }
        }
        return result.replace(/[\uD800-\uDBFF]$/, "");
      }
    }
    return "";
  }

  async function readWorkbenchResponse(response, { signal, onEvent = () => {} } = {}) {
    if (!/text\/event-stream/i.test(response.headers?.get?.("content-type") || "")) return response.json();
    let result = null;
    try { await readEvents(response, async event => {
      let data;
      try { data = JSON.parse(event.data); } catch { throw failure("STREAM_INVALID", "The server returned an invalid stream event."); }
      if (result) throw failure("STREAM_INVALID", "The server sent data after the final response.");
      if (event.event === "complete") { result = data; return false; }
      else if (event.event === "error") throw failure("STREAM_INTERRUPTED", "The response was interrupted. Please retry.");
      else if (["delta", "reset", "status"].includes(event.event)) await onEvent({ ...data, type: event.event });
    }, { signal }); } catch (error) {
      if (signal?.aborted || error?.code === "OPERATION_ABORTED") throw failure("OPERATION_ABORTED", "The request was cancelled.");
      if (String(error?.code || "").startsWith("STREAM_")) throw error;
      throw failure("STREAM_INTERRUPTED", "The response was interrupted. Please retry.");
    }
    if (!result || (!result.reply && !result.project)) throw failure("STREAM_INTERRUPTED", "The response ended before a complete answer arrived.");
    return result;
  }
  return Object.freeze({ readEvents, previewReply, readWorkbenchResponse });
});
