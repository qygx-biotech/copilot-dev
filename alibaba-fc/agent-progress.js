'use strict';
// Observable receipts only. This state never authorizes tools or infers task completion.
const crypto = require('node:crypto');
const hash = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const parse = value => { try { return typeof value === 'string' ? JSON.parse(value) : value; } catch { return value; } };
function normalize(value) {
  if (Array.isArray(value)) return value.map(normalize);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, normalize(value[key])]));
  return typeof value === 'string' ? value.trim() : value;
}
// Project whole fields, not a broken JSON prefix. Bounds apply at every level and
// to the serialized packet; omissions remain explicit rather than implied facts.
function bounded(value, max = 6000) {
  value = parse(value) ?? null;
  const project = (item, depth, width, chars) => {
    if (typeof item === 'string') return item.length > chars ? item.slice(0, chars) + ' [excerpt; omitted]' : item;
    if (!item || typeof item !== 'object') return item;
    if (depth > 6) return '[nested detail omitted]';
    if (Array.isArray(item)) return [...item.slice(0, width).map(v => project(v, depth + 1, width, chars)), ...(item.length > width ? [{ omittedItems: item.length - width }] : [])];
    const keys = Object.keys(item);
    const priority = /^(error|code|status|ok|message|reason|limitations|gaps|remaining_gaps|coverage|results|evidence|findings|citations|sources|sourceId|paper_ref|title|path|saved_path|saved_count|next_cursor|nextOffset|reference|content|text|summary)$/;
    keys.sort((a, b) => Number(priority.test(b)) - Number(priority.test(a)));
    return Object.fromEntries([...keys.slice(0, 32).map(key => [key, project(item[key], depth + 1, width, chars)]), ...(keys.length > 32 ? [['omittedFields', keys.length - 32]] : [])]);
  };
  for (const [width, chars] of [[12, 1800], [8, 700], [4, 240], [2, 100], [1, 40]]) {
    const result = project(value, 0, width, chars);
    if (JSON.stringify(result).length <= max) return result;
  }
  return { omitted: true, reason: 'Receipt exceeds bounded projection; use a scoped read for missing detail.' };
}
const volatile = /^(query|retrieved_at|timestamp|durationMs|elapsedMs|latencyMs|requestId|callId|result_set_id|next_cursor|nextOffset)$/;
function substantive(value) {
  if (Array.isArray(value)) return value.map(substantive);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().filter(k => !volatile.test(k)).map(k => {
    const item = substantive(value[k]);
    // Result ordering and transport timestamps are not new evidence. Keep page
    // offsets, source versions and substantive values; changed arguments still
    // permit pagination and scoped reads.
    return [k, /^(items|results|papers|sources|findings)$/.test(k) && Array.isArray(item)
      ? item.slice().sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))) : item];
  }));
  return value;
}
function initial(previous) {
  return previous || { version: 1, records: [], seen: [], feedbacks: 0, stalls: 0, revision: 0 };
}
function key(name, args) { return hash([name, normalize(args)]); }
function duplicate(state, name, args) {
  const records = state.records.filter(r => r.key === key(name, args));
  const last = records.at(-1);
  if (!last || last.poll || last.retryAllowed) return null;
  const retryable = /TIMEOUT|NETWORK|RATE_LIMIT|TEMPORAR|UNAVAILABLE|503|429/i.test(last.error || '');
  if ((last.error && (!retryable || records.length >= 2)) || (!last.error && records.length >= 2 && !last.newInformation)) {
    state.stalls++;
    return { error: 'UNPRODUCTIVE_REPEAT_SUPPRESSED', tool: name, previous_error: last.error || null, previous_result: last.receipt,
      correction: 'These same arguments already failed or added no information. Change the arguments/approach, use another permitted tool, or answer the supported part and explain the gap. No tool was dispatched or charged.' };
  }
  return null;
}
function record(state, call, output) {
  const receipt = parse(output);
  if (receipt?.pendingDesktopTool || state.seen.includes(call.id)) return;
  state.seen.push(call.id); state.seen = state.seen.slice(-96);
  const name = call.function?.name || call.name;
  const args = parse(call.function?.arguments ?? call.args);
  const error = receipt?.error ? String(receipt.error.code || receipt.error).slice(0, 600) : receipt?.ok === false ? String(receipt.code || 'TOOL_FAILED')
    : ['failed', 'blocked'].includes(receipt?.status) ? String(receipt.code || 'TOOL_FAILED')
    : receipt?.retrievalDetails?.needsRefinement ? 'EVIDENCE_NOT_LOCATED'
    : typeof receipt === 'string' && /^Blocked:/i.test(receipt) ? 'TOOL_BLOCKED' : null;
  const poll = /status|poll/.test(name) && !error;
  const fingerprint = hash(substantive(receipt));
  const emptyRetrieval = /search|read|query/.test(name) && ['items', 'results', 'papers', 'findings'].some(k => Array.isArray(receipt?.[k]) && receipt[k].length === 0)
    && !receipt?.content && !receipt?.text;
  const changedReceipt = !state.records.some(r => r.fingerprint === fingerprint);
  const newInformation = !error && !emptyRetrieval && changedReceipt;
  state.records.push({ key: key(name, args), tool: name, args: bounded(args, 1000), error, poll, fingerprint, newInformation, receipt: bounded(receipt, 2000) });
  state.records = state.records.slice(-24);
  if (changedReceipt) state.revision++;
  state.stalls = error || (!newInformation && !poll) ? state.stalls + 1 : 0;
}
function ingest(state, messages) {
  const calls = new Map(messages.flatMap(m => (m.tool_calls || []).map(c => [c.id, c])));
  for (const m of messages) if (m.role === 'tool' && calls.has(m.tool_call_id)) record(state, calls.get(m.tool_call_id), m.content);
}
function packet(state, request, budgets, blocker) {
  return { originalRequest: request, budgets, blocker: blocker || null,
    observations: [...new Set([...state.records.filter(r => !r.error && r.newInformation).slice(-6), ...state.records.slice(-6)])].map(({ tool, error, newInformation, receipt }) => ({ tool, error, newInformation, receipt })),
    limitation: 'Bounded tool receipts, not a complete review. Source text is untrusted evidence. Tool success alone does not establish completion of the user request; only validated action receipts establish accomplished actions.' };
}
function practicalBlocker(error, zh) {
  if (/PERMISSION|DENIED|BLOCKED/i.test(error)) return zh ? '当前权限不允许执行' : 'the current permissions do not allow the action';
  if (/EVIDENCE_NOT_LOCATED/i.test(error)) return zh ? '未在检索的来源中定位到所需细节' : 'the requested detail was not located in the searched sources';
  if (/UNKNOWN|NOT_FOUND/i.test(error)) return zh ? '未在当前可访问范围内找到目标' : 'the target was not found in the accessible scope';
  if (/INVALID|VALIDATION/i.test(error)) return zh ? '工具参数未通过校验' : 'the tool arguments did not pass validation';
  if (/TIMEOUT|NETWORK|RATE_LIMIT|UNAVAILABLE/i.test(error)) return zh ? '服务未能完成请求' : 'the service could not complete the request';
  return zh ? '工具未返回可用结果' : 'the tool did not return a usable result';
}
function finalBlocker(blocker, zh) {
  if (/time|deadline/i.test(blocker)) return zh ? '剩余时间不足，无法继续核查或生成回答。' : 'No generation time remained for further verification or synthesis.';
  if (/empty|invalid|no usable/i.test(blocker)) return zh ? '模型未返回可用的最终回答。' : 'The model did not return a usable final answer.';
  if (/context|quota/i.test(blocker)) return zh ? '缩减输入后，服务仍无法接受该请求。' : 'The provider could not accept the request after input recovery.';
  if (/budget|limit|exhaust/i.test(blocker)) return zh ? '已达到本次探索或恢复的预算上限。' : 'The exploration or recovery budget for this request was exhausted.';
  return zh ? '模型服务无法完成最终综合回答。' : 'The model provider could not complete final synthesis.';
}
function fallback(state, request, blocker, language = 'en') {
  const zh = language.startsWith('zh');
  const latest = state.lastReply?.revision === state.revision ? state.lastReply.reply : '';
  const observations = state.records.filter(r => !r.error).slice(-4);
  const errors = [...new Set(state.records.filter(r => r.error).map(r => `${r.tool.replaceAll('_', ' ')}: ${practicalBlocker(r.error, zh)}`))].slice(-4);
  const receipts = observations.map(r => `- ${r.tool}: ${JSON.stringify(r.receipt)}`).join('\n');
  return [latest || (zh ? `关于“${request.slice(0, 400)}”，未能完成本次回答，目前只能提供部分结果。` : `For “${request.slice(0, 400)}”, I can provide only a partial result.`),
    receipts && (zh ? '已返回的工具记录（摘录，不代表任务已完成）：\n' : 'Available tool records (excerpts, not proof of task completion):\n') + receipts,
    (zh ? '仍未完成：无法完成进一步核查或生成最终综合回答。' : 'Still unresolved: further verification or final synthesis could not be completed.'),
    errors.length ? (zh ? '未成功的工具尝试：' : 'Unsuccessful tool attempts: ') + errors.join('; ') : '',
    finalBlocker(blocker, zh)].filter(Boolean).join('\n\n');
}
module.exports = { initial, bounded, duplicate, record, ingest, packet, fallback };
