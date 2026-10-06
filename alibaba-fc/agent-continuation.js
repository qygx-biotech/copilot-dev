"use strict";
const crypto = require("node:crypto");
const zlib = require("node:zlib");
const invalid = () => Object.assign(new Error("The desktop tool continuation is invalid."), { code: "INVALID_TOOL_CONTINUATION" });
const digest = value => crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
const canonical = value => JSON.stringify(value, (_, item) => item && typeof item === 'object' && !Array.isArray(item)
  ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item);
const academic = require("./shared/academic-tools.js");
function seal(state, binding, secret) {
  if (!secret) throw invalid();
  const data = Buffer.from(JSON.stringify({ state, binding: digest(binding) }));
  if (data.length > 700000) throw Object.assign(new Error("Local signed-continuation payload limit exceeded."),
    { code: "LOCAL_CONTEXT_TRANSPORT_LIMIT", byteLimit: 700000, inputBytes: data.length });
  const payload = zlib.deflateSync(data).toString("base64url");
  return `${payload}.${crypto.createHmac("sha256", secret).update(`source-tools-v1:${payload}`).digest("base64url")}`;
}
function open(token, binding, secret) {
  if (typeof token !== "string" || token.length > 950000 || !secret) throw invalid();
  const [payload, signature, extra] = token.split(".");
  if (!payload || !signature || extra) throw invalid();
  const expected = crypto.createHmac("sha256", secret).update(`source-tools-v1:${payload}`).digest();
  const actual = Buffer.from(signature, "base64url");
  if (actual.length !== expected.length || !crypto.timingSafeEqual(actual, expected)) throw invalid();
  try {
    const value = JSON.parse(zlib.inflateSync(Buffer.from(payload, "base64url"), { maxOutputLength: 700000 }));
    // No wall-clock expiry, including for previously issued signed tokens.
    // The original request binding and signature still govern admission.
    if (value.binding !== digest(binding)) throw invalid();
    return value.state;
  } catch { throw invalid(); }
}
function withResults(state, results) {
  if (!Array.isArray(results) || results.length !== state.pending?.length || JSON.stringify(results).length > 32 * 1024 * 1024) throw invalid();
  // Complete corpus cards are a host-only sidecar, archived before model dispatch.
  // Canonical receipts retain the existing batch limit and validation.
  const receipts = results.map(({ corpusCardFallback, ...receipt }) => receipt);
  if (JSON.stringify(receipts).length > (state.runtimeVersion === 1 || state.academicState || state.projectToolState || state.specialist ? 180000 : 60000)) throw invalid();
  if (results.some(item => item.corpusCardFallback && !state.pending.some(call => call.id === item.id && call.name === 'run_corpus_workflow'))) throw invalid();
  for (const call of state.pending) {
    const matches = results.filter(item => item?.id === call.id);
    if (state.runtimeVersion === 1 && (call.name === 'read_skill' || call.name === 'spawn' || require('./generic-subagent.js').isAgentTool(call.name) || /^(mcp_|host_)/.test(call.name) || require('./shared/runtime-tools.js').has(call.name))) {
      if (matches.length !== 1 || !matches[0].result || typeof matches[0].result.ok !== 'boolean' || matches[0].result.runtimeCall?.name !== call.name || canonical(matches[0].result.runtimeCall?.args) !== canonical(call.args)) throw invalid();
      const nested = matches[0].result.nestedToolCalls;
      if (nested !== undefined) {
        if (!['run_code', 'wait_code'].includes(call.name) || !Number.isInteger(nested) || nested < 0 || nested > 24 || (state.totalToolCalls || 0) + nested > 24) throw invalid();
        state.totalToolCalls = (state.totalToolCalls || 0) + nested;
      }
      const message = state.agentMessages.find(item => item.role === 'tool' && item.tool_call_id === call.id);
      if (!message) throw invalid();
      message.content = JSON.stringify(matches[0].result);
      continue;
    }
    if (call.name === 'literature_worker') {
      if (!state.specialist || matches.length !== 1 || state.specialist.pendingId !== call.id) throw invalid();
      require('./literature-specialist.js').accept(state.specialist, matches[0].result);
      continue;
    }
    if (require("./shared/side-chat-tools.js").isTool(call.name)) {
      if (!state.projectToolState || matches.length !== 1 || !matches[0].result || typeof matches[0].result.ok !== "boolean") throw invalid();
      const message = state.agentMessages.find(item => item.role === "tool" && item.tool_call_id === call.id);
      if (!message) throw invalid();
      message.content = JSON.stringify(matches[0].result);
      if (call.name === 'run_corpus_workflow' && matches[0].result.ok && matches[0].corpusCardFallback?.version === 1) {
        message.corpus_card_fallback = matches[0].corpusCardFallback;
      }
      continue;
    }
    if (academic.isTool(call.name)) {
      if (!state.academicState || matches.length !== 1) throw invalid();
      try {
        academic.validateInput(call.name, call.args);
        const result = require("./academic-agent.js").recordResult(state.academicState, call, matches[0].result);
        const message = state.agentMessages.find(item => item.role === "tool" && item.tool_call_id === call.id);
        if (!message) throw invalid();
        message.content = JSON.stringify(result);
      } catch { throw invalid(); }
      continue;
    }
    if (matches.length !== 1 || !Array.isArray(matches[0].results) || matches[0].results.length !== call.args.sources.length) throw invalid();
    const output = matches[0].results.map((item, index) => {
      if (item?.url !== call.args.sources[index].url || !["downloaded", "failed"].includes(item.status)) throw invalid();
      if (item.status === "downloaded") {
        if (typeof item.path !== "string" || item.path.length > 1000 || item.path.split("/").some(part => !part || part.startsWith(".")) || /[\\:\x00-\x1f]/.test(item.path)) throw invalid();
        return { url: item.url, status: item.status, path: item.path, contentType: String(item.contentType || "").slice(0, 100),
          resolvedUrl: String(item.resolvedUrl || "").slice(0, 4096), downloadMethod: item.downloadMethod === "local" ? "local" : "fc-fallback" };
      }
      const safeError = error => ({ code: /^[A-Z_]{1,80}$/.test(error?.code || "") ? error.code : "DOWNLOAD_FAILED",
        ...(Number.isInteger(error?.httpStatus) && error.httpStatus >= 100 && error.httpStatus <= 599 ? { httpStatus: error.httpStatus } : {}) });
      return { url: item.url, status: "failed", error: safeError(item.error), ...(item.localError ? { localError: safeError(item.localError), fallbackError: safeError(item.fallbackError) } : {}) };
    });
    const message = state.agentMessages.find(item => item.role === "tool" && item.tool_call_id === call.id);
    if (!message) throw invalid();
    message.content = JSON.stringify(output);
    if (state.downloadState) {
      for (const item of output) if (!state.downloadState.results.some(result => result.url === item.url)) state.downloadState.results.push(item);
    }
  }
  return state;
}
module.exports = { seal, open, withResults };
