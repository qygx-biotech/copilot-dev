"use strict";

const crypto = require("node:crypto");
const digest = value => crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
const amount = value => value !== null && value !== undefined && value !== "" && Number.isFinite(Number(value)) && Number(value) >= 0 ? Number(value) : null;
const inputMetric = value => /input[_ -]?tokens?|prompt[_ -]?tokens?/i.test(value) && !/output|completion|requests?/i.test(value);

// Classification is independent of legacy UI rate-limit wording. Aggregate
// quota usage is deliberately never interpreted as this request's token count.
function inputQuota(result, now = Date.now()) {
  if (result?.ok) return null;
  if (result?.inputQuota) return result.inputQuota;
  if (![429, 403].includes(Number(result?.status || result?.statusCode))) return null;
  const nodes = [result];
  for (let i = 0; i < nodes.length && i < 40; i++) {
    for (const key of ["error", "details", "metadata", "raw", "violations", "quota", "cause"]) {
      let child = nodes[i]?.[key];
      if (typeof child === "string" && child.length < 64000 && child.trim().startsWith("{")) { try { child = JSON.parse(child); } catch { continue; } }
      if (Array.isArray(child)) nodes.push(...child.slice(0, 8));
      else if (child && typeof child === "object") nodes.push(child);
    }
  }
  const codes = nodes.map(n => String(n.code || n.type || "")).join(" ");
  if (/insufficient_(?:quota|balance|credits)|billing|authentication|unauthorized|permission_denied/i.test(codes)) return null;
  if (/context_(?:length|window)_exceeded|input_too_large|prompt_too_long|input_tokens_exceeded/i.test(codes)) return null;
  const messages = nodes.map(n => typeof n.message === "string" ? n.message.slice(0, 12000) : typeof n.error === "string" ? n.error.slice(0, 12000) : "").join("\n");
  if (/insufficient (?:credits|funds|balance)|(?:credit|account) balance (?:is )?(?:exhausted|depleted|zero)/i.test(messages)) return null;
  const metricNode = nodes.find(n => inputMetric(String(n.quotaMetric || n.quota_metric || n.metric || "")));
  const explicitCode = /\b(?:input_token(?:s)?_(?:rate_limit|quota)(?:_exceeded)?|prompt_token_quota_exceeded)\b/i.test(codes);
  const combined = nodes.find(n => ["input_and_output", "total_tokens"].includes(n.token_scope) && /quota|rate_limit/i.test(codes));
  const metricMatch = messages.match(/Quota exceeded for metric:\s*([A-Za-z0-9._/-]+)(?:,\s*limit:\s*(\d+))?/i);
  const otherMetric = nodes.some(n => /output|completion|requests?/i.test(String(n.quotaMetric || n.quota_metric || n.metric || ""))) ||
    (metricMatch && /output|completion|requests?/i.test(metricMatch[1]));
  if (otherMetric && !metricNode && !explicitCode && !combined) return null;
  const narrow = /\b(?:input|prompt)[ -]token (?:rate limit|quota) (?:exceeded|exhausted)\b/i.test(messages);
  const header = name => result.headers?.get?.(name) ?? result.headers?.[name];
  const headerConfirmed = amount(header("anthropic-ratelimit-input-tokens-remaining") ?? header("x-ratelimit-remaining-input-tokens")) === 0;
  const legacy = result.rateLimit?.verifiedInputTokenRateLimit === true && result.rateLimit?.rateLimitRetryable !== false;
  if (!metricNode && !explicitCode && !combined && !(metricMatch && inputMetric(metricMatch[1])) && !narrow && !headerConfirmed && !legacy) return null;
  // Explicit output/request-count failures win over ambiguous prose.
  if (!metricNode && !explicitCode && !combined && /output_token|request_count|requests_per|completion_token/i.test(codes)) return null;
  const n = metricNode || combined || nodes.find(n => /input_token.*(?:quota|rate_limit)/i.test(String(n.code))) || {};
  const read = (...keys) => { for (const node of [n, ...nodes]) for (const key of keys) if (node[key] !== undefined) return node[key]; };
  const capacity = amount(read("quotaValue", "capacity", "inputTokenLimit", "input_token_limit", "limit") ??
    header("anthropic-ratelimit-input-tokens-limit") ?? header("x-ratelimit-limit-input-tokens") ?? metricMatch?.[2] ?? result.rateLimit?.inputTokenLimit);
  const remaining = amount(read("remaining_tokens", "remaining") ?? header("anthropic-ratelimit-input-tokens-remaining") ?? header("x-ratelimit-remaining-input-tokens"));
  const resetValue = read("reset_at", "resetAt") ?? header("anthropic-ratelimit-input-tokens-reset") ?? header("x-ratelimit-reset-input-tokens");
  const resetDuration = typeof resetValue === "string" && resetValue.match(/^(\d+(?:\.\d+)?)(ms|s|m|h)$/);
  const resetAt = resetValue == null ? null : resetDuration ? now + Number(resetDuration[1]) * ({ ms: 1, s: 1000, m: 60000, h: 3600000 }[resetDuration[2]])
    : Number.isFinite(Number(resetValue)) ? Number(resetValue) * (Number(resetValue) < 1e12 ? 1000 : 1) : Date.parse(resetValue);
  const delays = [];
  const retry = header("retry-after");
  if (retry != null) delays.push(Number.isFinite(Number(retry)) ? Number(retry) * 1000 : Date.parse(retry) - now);
  const ms = amount(read("retryAfterMs", "retry_after_ms")); if (ms !== null) delays.push(ms);
  for (const node of nodes) if (/^\d+(?:\.\d+)?s$/.test(node.retryDelay || "")) delays.push(parseFloat(node.retryDelay) * 1000);
  const proseDelay = messages.match(/retry (?:in|after)\s+(\d+(?:\.\d+)?)\s*s/i); if (proseDelay) delays.push(Number(proseDelay[1]) * 1000);
  // Older adapters synthesize a 60s fallback here. Only an explicitly marked
  // provider measurement may become a shared cooldown.
  if (result.rateLimit?.retryDelayReported === true && result.rateLimit?.retryAfterMs != null) delays.push(Number(result.rateLimit.retryAfterMs));
  const valid = delays.filter(v => Number.isFinite(v) && v >= 0);
  const metric = String(n.quotaMetric || n.quota_metric || n.metric || metricMatch?.[1] || result.rateLimit?.quotaMetric || "");
  const quotaId = String(read("quotaId", "quota_id") || "");
  const period = read("period", "window", "window_seconds") ?? (/per[_ -]?minute/i.test(metric + quotaId) ? "minute" : /per[_ -]?day/i.test(metric + quotaId) ? "day" : null);
  const dimensions = read("quotaDimensions", "dimensions") || {};
  const scope = String(read("scope", "quota_scope") || (dimensions.project ? "project" : "unknown"));
  return { capacity, remaining, resetAt: Number.isFinite(resetAt) ? resetAt : null,
    retryAfterMs: valid.length ? Math.ceil(Math.max(...valid)) : 0,
    retryDelayReported: valid.length > 0, period: period == null ? null : String(period).slice(0, 80),
    scope: ["account", "project", "model", "endpoint"].includes(scope) ? scope : "unknown",
    scopeKey: digest({ scope, dimensions, account: read("account_id"), project: read("project_id"), quotaId, metric }),
    modelScoped: Boolean(dimensions.model) || scope === "model" || scope === "unknown",
    includesOutput: Boolean(combined), metric: metric.replace(/[^A-Za-z0-9._/-]/g, "_").slice(0, 180),
    requestTokens: amount(read("request_input_tokens", "requested_input_tokens")),
    evidence: metricNode ? "structured_input_metric" : explicitCode ? "structured_input_quota_code" : combined ? "structured_total_token_quota"
      : headerConfirmed ? "input_quota_headers" : legacy ? "verified_adapter_quota" : "explicit_input_quota_message" };
}

// Shared provider observations and confirmed cooldowns, never a locally inferred
// quota balance. Signed handoffs carry observations across backend requests.
const records = new Map();
// Process-local monotonic deadlines never enter signed or persisted state.
const cooldowns = new WeakMap();
class QuotaLedger {
  constructor({ root, provider, endpoint, account, model, now, monotonic = () => require("node:perf_hooks").performance.now(), state, ttlMs }) {
    this.owner = digest([root, provider, endpoint, account]); this.model = model;
    this.now = now; this.monotonic = monotonic; this.state = state; this.ttlMs = ttlMs;
    for (const record of state.quotaRecords || []) if (record.owner === this.owner && record.expiresAt > now() && !records.has(record.key)) {
      const restored = { ...record };
      this.remainingDelay(restored); // Convert at receipt, before any async work.
      records.set(record.key, restored);
    }
  }
  observation(record) {
    const { spent, reserved, ...observation } = record;
    const confirmedRetryAt = this.now() + this.remainingDelay(record);
    return { ...observation, confirmedRetryAt, expiresAt: Math.max(observation.expiresAt, confirmedRetryAt + 1) };
  }
  active() {
    const found = [];
    for (const [key, r] of records) {
      if (r.expiresAt <= this.now() && this.remainingDelay(r) <= 0) { records.delete(key); continue; }
      if (r.owner === this.owner && (!r.model || r.model === this.model)) {
        found.push(r);
      }
    }
    return found;
  }
  save() { this.state.quotaRecords = this.active().map(r => this.observation(r)); }
  record(info) {
    const now = this.now(), key = digest([this.owner, info.scopeKey, info.modelScoped ? this.model : ""]);
    const previous = records.get(key);
    // Convert wall-clock reset timestamps once at observation. Subsequent
    // elapsed waits must not grow or disappear when the wall clock changes.
    const delay = Math.max(previous ? this.remainingDelay(previous) : 0,
      info.retryDelayReported ? info.retryAfterMs : 0, (info.resetAt || 0) - now);
    const confirmedRetryAt = now + delay;
    const r = { ...info, key, owner: this.owner, model: info.modelScoped ? this.model : null,
      observedAt: now, confirmedRetryAt, expiresAt: Math.max(now + this.ttlMs, confirmedRetryAt + 1) };
    if (records.size >= 512 && !records.has(key)) records.delete(records.keys().next().value);
    cooldowns.set(r, { clock: this.monotonic, deadline: this.monotonic() + delay });
    records.set(key, r); this.save(); return r;
  }
  remainingDelay(record) {
    let cached = cooldowns.get(record);
    if (!cached) {
      // Handoffs across processes carry only wall-clock observations. Convert
      // their remaining duration on receipt, never reuse another process's ticks.
      const wallDeadline = record.confirmedRetryAt ?? Math.max(
        record.retryDelayReported ? record.observedAt + record.retryAfterMs : 0, record.resetAt || 0);
      const remaining = Math.max(0, wallDeadline - this.now());
      cached = { clock: this.monotonic, deadline: this.monotonic() + remaining };
      cooldowns.set(record, cached);
    }
    return Math.max(0, cached.deadline - cached.clock());
  }
  delay() { return Math.max(0, ...this.active().map(r => this.remainingDelay(r))); }

}
module.exports = { inputQuota, QuotaLedger };
