(function expose(root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.BioDesignConversationTranscript = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";
  const VERSION = 1;
  const LIMITS = Object.freeze({ turns: 12, storedCharacters: 600000, replayCharacters: 120000, messageCharacters: 64000, summaryCharacters: 12000 });
  const id = value => typeof value === "string" && /^[\w.:-]{1,200}$/.test(value) ? value : "";
  const callId = value => typeof value === "string" && value.length > 0 && value.length <= 200 && !/[\x00-\x20\x7f]/.test(value) ? value : "";
  const text = (value, max = LIMITS.messageCharacters) => typeof value === "string" ? value.slice(0, max) : "";
  const copy = value => JSON.parse(JSON.stringify(value));
  const hostedCall = call => ["web_search", "web_search_preview", "web_search_call", "web_search_20250305", "web_search_tool_result"].includes(call?.type) || ["web_search", "web_search_preview"].includes(call?.function?.name);
  const unknownResult = call => ({ role: "tool", tool_call_id: call.id, name: call.function.name,
    content: JSON.stringify({ error: "HISTORICAL_RESULT_UNAVAILABLE", outcome: "unknown", message: "The turn ended before a result was recorded. Historical replay never reruns this action." }) });

  // Legal exchanges only: no system/developer roles, no duplicate/orphan results,
  // no sliced arguments or partially retained parallel tool-call groups.
  function messages(input, { closePending = true, preserveContent = false } = {}) {
    const out = [], used = new Set();
    let pending = new Map();
    const close = () => { if (closePending) for (const call of pending.values()) out.push(unknownResult(call)); pending = new Map(); };
    for (const raw of (Array.isArray(input) ? input : []).slice(0, 1000)) {
      if (!raw || !["user", "assistant", "tool"].includes(raw.role)) continue;
      if (raw.role === "tool") {
        const call = pending.get(raw.tool_call_id);
        if (!call) continue;
        out.push({ role: "tool", tool_call_id: call.id, name: call.function.name,
          content: text(raw.content, preserveContent ? Infinity : LIMITS.messageCharacters) + (!preserveContent && typeof raw.content === "string" && raw.content.length > LIMITS.messageCharacters ? "\n[Historical result truncated; reread current evidence for omitted detail.]" : "") });
        pending.delete(call.id);
        continue;
      }
      close();
      const content = text(raw.content, preserveContent ? Infinity : LIMITS.messageCharacters);
      const calls = raw.role === "assistant" && Array.isArray(raw.tool_calls) ? raw.tool_calls.flatMap(call => {
        if (hostedCall(call)) return JSON.stringify(call).length <= LIMITS.messageCharacters ? [copy(call)] : [];
        if (call?.type !== "function" || !callId(call.id) || !id(call.function?.name) || used.has(call.id) ||
            typeof call.function.arguments !== "string" || call.function.arguments.length > 32000) return [];
        used.add(call.id);
        // Opaque provider signatures are protocol fields, never reasoning text.
        const result = { id: call.id, type: "function", function: { name: call.function.name, arguments: call.function.arguments } };
        if (call.extra_content && JSON.stringify(call.extra_content).length <= 16000) result.extra_content = copy(call.extra_content);
        return [result];
      }).slice(0, 64) : [];
      if (!content && !calls.length) continue;
      const message = { role: raw.role, content: content || null, ...(calls.length ? { tool_calls: calls } : {}) };
      if (calls.length && raw.extra_content && JSON.stringify(raw.extra_content).length <= 16000) message.extra_content = copy(raw.extra_content);
      if (raw.role === "assistant") for (const key of ["annotations", "web_search", "groundingMetadata"]) {
        if (raw[key] && JSON.stringify(raw[key]).length <= 16000) message[key] = copy(raw[key]);
      }
      out.push(message);
      pending = new Map(calls.filter(call => !hostedCall(call)).map(call => [call.id, call]));
    }
    close();
    return out;
  }

  function normalizeTurn(raw) {
    if (!raw || !id(raw.turnId)) return null;
    let bindings = Array.isArray(raw.bindings) ? raw.bindings.slice(0, 1000).flatMap(binding => {
      if (!binding || !id(binding.handle) || !text(binding.identity, 600)) return [];
      return [{ handle: binding.handle, identity: text(binding.identity, 600), version: text(binding.version, 200),
        sourceId: id(binding.sourceId), path: text(binding.path, 600), current: binding.current === true }];
    }) : [];
    if (raw.bindings?.length > 1000 || JSON.stringify(bindings).length > 160000) {
      bindings = bindings.slice(0, 64);
      bindings.push({ handle: "provenance_incomplete", identity: "provenance_incomplete", version: "", sourceId: "", path: "", current: false });
    }
    return { turnId: raw.turnId, model: text(raw.model, 200), workspaceId: text(raw.workspaceId, 200),
      status: ["running", "completed", "interrupted", "failed"].includes(raw.status) ? raw.status : "interrupted",
      startedAt: text(raw.startedAt, 40), updatedAt: text(raw.updatedAt, 40),
      sequence: Number.isSafeInteger(raw.sequence) && raw.sequence >= 0 ? raw.sequence : 0,
      legacy: raw.legacy === true, compacted: raw.compacted === true, bindings,
      ...(raw.transcriptArchiveUnavailable === true ? { transcriptArchiveUnavailable: true } : {}),
      // Keep an unfinished group pending on disk. Only replay closes it with an
      // explicit unknown outcome; a later checkpoint may supply the real result.
      ...(raw.transcriptArchive && /^[a-f0-9]{64}$/.test(raw.transcriptArchive.reference) && /^[a-f0-9-]{36}$/.test(raw.transcriptArchive.session)
        ? { transcriptArchive: { reference: raw.transcriptArchive.reference, session: raw.transcriptArchive.session } } : {}),
      ...(Array.isArray(raw.contextCheckpoints) ? { contextCheckpoints: raw.contextCheckpoints.slice(-8).filter(item =>
        Number.isSafeInteger(item.boundary) && item.boundary >= 0 && /^[a-f0-9]{64}$/.test(item.archiveRef)).map(item => ({
          boundary: item.boundary, archiveRef: item.archiveRef, summary: text(item.summary, 16000), degraded: item.degraded === true,
          ...(Number.isSafeInteger(item.archiveBoundary) && item.archiveBoundary >= 0
            ? { archiveBoundary: item.archiveBoundary, boundaryKind: "non-system-model-transcript" } : {}),
        })) } : {}),
      messages: messages(raw.messages, { closePending: false }) };
  }

  function summarize(turn) {
    const firstAnswer = turn.messages.findIndex(message => message.role === "assistant");
    const requests = turn.messages.slice(0, firstAnswer < 0 ? undefined : firstAnswer).filter(message => message.role === "user");
    // The host's wrapper precedes the original request in existing saved turns.
    const request = String(requests.at(-1)?.content || "").slice(0, 1400);
    const finalAnswer = turn.messages.findLast(message => message.role === "assistant" && !message.tool_calls?.length && message.content)?.content || "";
    const toolExcerpts = turn.messages.filter(message => message.role === "tool").map(message =>
      `${message.role}${message.name ? ` (${message.name})` : ""}: ${String(message.content || "").slice(0, 700)}`).join("\n").slice(0, 2200);
    const excerpts = (`assistant final answer: ${String(finalAnswer).slice(0, 1800)}\n${toolExcerpts}`).slice(0, 2200);
    return { ...turn, compacted: true, messages: [{ role: "user", content: request || "Earlier exchange" },
      { role: "assistant", content: "Historical derived summary (extractive, incomplete, not verified knowledge):\n" + excerpts }] };
  }

  function normalize(value) {
    if (value?.version !== VERSION) return { version: VERSION, turns: [], summaries: [], discardedTurnIds: [] };
    const discardedTurnIds = [...new Set((Array.isArray(value.discardedTurnIds) ? value.discardedTurnIds : []).filter(id))].slice(-500);
    let turns = (Array.isArray(value.turns) ? value.turns : []).map(normalizeTurn).filter(Boolean);
    const seen = new Set();
    turns = turns.reverse().filter(turn => !discardedTurnIds.includes(turn.turnId) && !seen.has(turn.turnId) && seen.add(turn.turnId)).reverse();
    let summaries = (Array.isArray(value.summaries) ? value.summaries : []).map(normalizeTurn).filter(Boolean).map(turn => turn.compacted ? turn : summarize(turn));
    turns.sort((a, b) => a.startedAt && b.startedAt ? a.startedAt.localeCompare(b.startedAt) : 0);
    while (turns.length > LIMITS.turns || (turns.length > 1 && JSON.stringify(turns).length > LIMITS.storedCharacters)) summaries.push(summarize(turns.shift()));
    // A single oversized turn is compacted atomically, never sliced mid-pair.
    if (JSON.stringify(turns).length > LIMITS.storedCharacters) turns = turns.map(summarize);
    while (summaries.length && JSON.stringify(summaries).length > LIMITS.summaryCharacters) summaries.shift();
    const recent = new Set(turns.map(turn => turn.turnId));
    summaries = [...new Map(summaries.filter(turn => !discardedTurnIds.includes(turn.turnId) && !recent.has(turn.turnId)).map(turn => [turn.turnId, turn])).values()];
    return { version: VERSION, summaries, turns, discardedTurnIds };
  }

  function upsert(value, raw) {
    const transcript = normalize(value), turn = normalizeTurn(raw);
    if (!turn) return transcript;
    const existing = transcript.turns.findIndex(item => item.turnId === turn.turnId);
    if (existing >= 0) {
      if (transcript.turns[existing].sequence > turn.sequence) return transcript;
      transcript.turns[existing] = turn;
    } else transcript.turns.push(turn);
    return normalize(transcript);
  }

  function forConversation(conversation) {
    let transcript = normalize(conversation?.transcript);
    const visible = (conversation?.messages || []).filter(Boolean).map((message, index) => {
      let hash = 2166136261;
      for (const char of String(message.content || "")) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619) >>> 0;
      return { ...message, id: id(message.id) || `legacy_${index}_${hash.toString(16)}` };
    });
    const known = new Set([...transcript.summaries, ...transcript.turns].map(turn => turn.turnId));
    let legacy;
    for (const message of visible) {
      if (message.role === "user") {
        if (legacy) transcript.turns.push(normalizeTurn(legacy));
        legacy = !known.has(message.id) ? { turnId: message.id, legacy: true, status: "completed", startedAt: message.createdAt || "", messages: [], bindings: [] } : null;
      }
      if (legacy && ["user", "assistant"].includes(message.role)) legacy.messages.push({ role: message.role, content: message.content });
    }
    if (legacy) transcript.turns.push(normalizeTurn(legacy));
    // Migration needs chronological order, including legacy turns before the
    // first transcript-aware request. Never invent old tool evidence.
    const order = new Map(visible.map((message, index) => [message.id, index]));
    transcript.turns.sort((a, b) => (order.get(a.turnId) ?? -1) - (order.get(b.turnId) ?? -1));
    return normalize(transcript);
  }

  function beforeRevision(value, removedIds) {
    const transcript = normalize(value), ids = new Set(removedIds);
    return normalize({ ...transcript, discardedTurnIds: [...transcript.discardedTurnIds, ...ids] });
  }

  function merge(previous, incoming) {
    const next = normalize(incoming);
    let result = normalize(previous);
    result.discardedTurnIds = [...new Set([...result.discardedTurnIds, ...next.discardedTurnIds])];
    const summaries = new Map([...result.summaries, ...next.summaries].map(turn => [turn.turnId, turn]));
    result.summaries = [...summaries.values()];
    for (const turn of next.turns) {
      if (result.summaries.some(summary => summary.turnId === turn.turnId && summary.sequence >= turn.sequence)) continue;
      result = upsert(result, turn);
    }
    // An archived turn must not also be replayed from the recent buffer.
    const recent = new Set(result.turns.map(turn => turn.turnId));
    result.summaries = result.summaries.filter(turn => !recent.has(turn.turnId));
    return normalize(result);
  }

  // Transport sanitization bounds whole user exchanges, not individual tails.
  function boundedMessages(input, limit = LIMITS.replayCharacters) {
    const groups = [];
    for (const message of messages(input)) {
      if (message.role === "user" || !groups.length) groups.push([]);
      groups.at(-1).push(message);
    }
    let size = 0; const selected = [];
    for (const group of groups.reverse()) {
      const length = JSON.stringify(group).length;
      if (size + length > limit) break;
      selected.unshift(group); size += length;
    }
    return selected.flat();
  }

  // Send a full first checkpoint and bounded suffix patches for large turns.
  // Repeated cumulative transcripts must not exhaust the existing SSE budget.
  function checkpointEvent(previous, next) {
    const full = { conversationTurn: next };
    if (!previous || previous.turnId !== next.turnId || JSON.stringify(full).length < 32000) return full;
    let offset = 0;
    while (offset < Math.min(previous.messages.length, next.messages.length) && JSON.stringify(previous.messages[offset]) === JSON.stringify(next.messages[offset])) offset++;
    const { messages, bindings, ...metadata } = next;
    const patch = { conversationTurnPatch: { ...metadata, baseSequence: previous.sequence, offset, messages: messages.slice(offset),
      ...(JSON.stringify(bindings) !== JSON.stringify(previous.bindings) ? { bindings } : {}) } };
    return JSON.stringify(patch).length < JSON.stringify(full).length ? patch : full;
  }

  function applyCheckpoint(previous, event) {
    if (event?.conversationTurn) return normalizeTurn(event.conversationTurn);
    const patch = event?.conversationTurnPatch;
    if (!previous || !patch || patch.turnId !== previous.turnId || patch.workspaceId !== previous.workspaceId || patch.baseSequence !== previous.sequence ||
        !Number.isInteger(patch.offset) || patch.offset < 0 || patch.offset > previous.messages.length || !Array.isArray(patch.messages)) {
      throw Object.assign(new Error("The transcript checkpoint sequence is incomplete."), { code: "STREAM_INVALID" });
    }
    return normalizeTurn({ ...previous, ...patch, messages: [...previous.messages.slice(0, patch.offset), ...patch.messages] });
  }
  return Object.freeze({ VERSION, LIMITS, hostedCall, messages, normalizeTurn, normalize, upsert, merge, summarize, forConversation, beforeRevision, boundedMessages, checkpointEvent, applyCheckpoint });
});
