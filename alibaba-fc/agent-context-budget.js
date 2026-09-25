"use strict";
const { compactCorpusReceipt } = require("./corpus-context.js");

// A provider-facing view, never a mutation of persisted artifacts or transcript.
// Only prose is shortened. Identity, citations, scope, versions, errors, gaps,
// coverage and tool protocol fields are not size-fitting opportunities.
const prose = new Set(["text", "content", "summary", "abstractSummary", "description", "excerpt", "snippet"]);
const size = messages => JSON.stringify(messages).length;
function shorten(text, limit, trigger) {
  if (text.length <= limit) return text;
  const prefix = text.slice(0, limit).replace(/\[\[cite:[^\]]*$/, "");
  const references = [...new Set(text.match(/\[\[cite:[^\]]+\]\]/g) || [])].filter(ref => !prefix.includes(ref));
  return prefix + `\n[Evidence shortened after ${trigger}; omitted text is not available in this view.]` +
    (references.length ? "\nOriginal citation markers from omitted text (not support for the retained passage): " + references.join(" ") : "");
}
function compactResult(content, limit, trigger) {
  let value;
  try { value = JSON.parse(content); } catch { return shorten(String(content || ""), limit, trigger); }
  const strings = [];
  function collect(node, key = "", path = "$", protectedData = false) {
    const protectedHere = protectedData || /citation|reference|provenance|scope|coverage|gap|limitation|error|requirement|version/i.test(key);
    if (typeof node === "string" && prose.has(key) && !protectedHere) strings.push({ path, text: node });
    else if (node && typeof node === "object") for (const [k, v] of Object.entries(node)) collect(v, k, `${path}.${k}`, protectedHere);
  }
  collect(value);
  const seen = new Map(), replacements = new Map();
  for (const entry of strings) {
    if (entry.text.length > 256 && seen.has(entry.text)) replacements.set(entry.path, `[Duplicate prose omitted; identical text at ${seen.get(entry.text)}]`);
    else seen.set(entry.text, entry.path);
  }
  const unique = strings.filter(entry => !replacements.has(entry.path));
  const total = unique.reduce((sum, entry) => sum + entry.text.length, 0);
  const ratio = Math.min(1, limit / Math.max(1, total));
  for (const entry of unique) {
    const shortened = shorten(entry.text, Math.max(240, Math.floor(entry.text.length * ratio)), trigger);
    if (shortened !== entry.text) replacements.set(entry.path, shortened);
  }
  function transform(node, path = "$") {
    if (replacements.has(path)) return replacements.get(path);
    if (Array.isArray(node)) return node.map((item, index) => transform(item, `${path}.${index}`));
    if (node && typeof node === "object") return Object.fromEntries(Object.entries(node).map(([key, item]) => [key, transform(item, `${path}.${key}`)]));
    return node;
  }
  const result = transform(value);
  if (replacements.size && result && !Array.isArray(result) && typeof result === "object") result.contextCompaction = {
    trigger, shortenedOrDeduplicatedFields: replacements.size,
    limitation: "Model-facing excerpts only. Omitted text is not summarized; coverage and provenance do not prove individual claims."
  };
  return JSON.stringify(result);
}
function restoreAcademicReceipts(messages, state, aggressive = false) {
  const result = JSON.parse(JSON.stringify(messages));
  if (!state) return result;
  const planning = require("./academic-planning.js"), context = require("./academic-context.js");
  const names = new Map(result.flatMap(message => (message.tool_calls || []).map(call => [call.id, call.function?.name])));
  for (const message of result) {
    if (message.role !== "tool") continue;
    const name = message.name || names.get(message.tool_call_id);
    if (!planning.isTool(name) && !require("./shared/academic-tools.js").isTool(name)) continue;
    let value; try { value = JSON.parse(message.content); } catch { /* Legacy sliced receipts. */ }
    if (name === "plan_literature_search" && state.plan && value?.status !== "failed")
      message.content = JSON.stringify({ ...planning.planReceipt(state), compacted: true, recovered_from: "host_state" });
    else if (!value || aggressive && !value.historical_membership_unknown) message.content = JSON.stringify(context.compactResult(name, value, state, message.tool_call_id, aggressive));
  }
  return result;
}
function compactMessages(messages, _activeRequest, characterLimit = Infinity, academicState = null, trigger = "provider-context-size") {
  let result = restoreAcademicReceipts(messages, academicState);
  // First remove redundant corpus copies without shortening any passage.
  for (const message of result) if (message.role === "tool") message.content = compactCorpusReceipt(message.content) || message.content;
  if (size(result) <= characterLimit) return result;
  if (academicState) result = restoreAcademicReceipts(result, academicState, true);
  const tools = result.filter(message => message.role === "tool");
  const newestCall = result.findLast(message => message.role === "assistant" && message.tool_calls?.length);
  const freshIds = new Set((newestCall?.tool_calls || []).map(call => call.id));
  const nonToolSize = size(result.filter(message => message.role !== "tool"));
  const available = Math.max(1000, characterLimit - nonToolSize);
  const weight = tools.reduce((sum, message) => sum + (freshIds.has(message.tool_call_id) ? 3 : 1), 0);
  // Keep all message ordering and pairs. Fresh results get priority, but even
  // older passages retain a useful excerpt and all provenance/coverage fields.
  for (const message of tools) message.content = compactResult(message.content,
    Math.max(400, Math.floor(available * (freshIds.has(message.tool_call_id) ? 3 : 1) / Math.max(1, weight))), trigger);
  // Protected instructions, user requests and provenance may exceed the target.
  // The one retry decides acceptance; never destroy them to enforce a guess.
  return result;
}
module.exports = { compactMessages, restoreAcademicReceipts };
