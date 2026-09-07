(function exposeProviderRateLimit(root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.BioDesignProviderRateLimit = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";
  function parseRateLimit(status, body, retryAfter, now = Date.now()) {
    let data = body;
    if (typeof data === "string") { try { data = JSON.parse(data); } catch { data = { message: data }; } }
    const message = String(data?.error?.message || data?.message || "").slice(0, 12000);
    // Compatibility with older FC builds that wrapped the upstream 429 in 502.
    const legacy = data?.error === "LlmHttpError" && /^Requesty returned HTTP 429[:.]/.test(message);
    if (Number(status) !== 429 && Number(data?.providerStatus) !== 429 && !legacy) return null;
    const detail = (Array.isArray(data?.error?.details) ? data.error.details : []).find((item) => /RetryInfo$/.test(item?.["@type"] || ""));
    const delays = [];
    if (data?.retryAfterMs !== null && data?.retryAfterMs !== undefined) delays.push(Number(data.retryAfterMs));
    if (retryAfter !== null && retryAfter !== undefined && String(retryAfter).trim()) {
      delays.push(/^\d+(?:\.\d+)?$/.test(String(retryAfter).trim())
        ? Number(retryAfter) * 1000 : Date.parse(retryAfter) - now);
    }
    for (const seconds of [String(detail?.retryDelay || "").match(/^(\d+(?:\.\d+)?)s$/)?.[1],
      message.match(/retry (?:in|after)\s+(\d+(?:\.\d+)?)\s*s/i)?.[1]]) {
      if (seconds !== undefined) delays.push(Number(seconds) * 1000);
    }
    const validDelays = delays.filter(value => Number.isFinite(value) && value >= 0);
    // A gateway's shorter hint must not override the upstream model's reset.
    const delay = validDelays.length ? Math.max(...validDelays) : 60000;
    const metricMatch = message.match(/Quota exceeded for metric:\s*([A-Za-z0-9._/-]+),\s*limit:\s*(\d+)/i);
    const quotaMetric = String(data?.quotaMetric || metricMatch?.[1] || "").replace(/[^A-Za-z0-9._/-]/g, "_").slice(0, 180);
    const limit = Number(data?.inputTokenLimit ?? (/input_token/i.test(quotaMetric) ? metricMatch?.[2] : undefined));
    const inputTokenLimit = Number.isFinite(limit) && limit > 0 ? limit : null;
    const hardQuota = /(?:per[_ -]?day|daily|billing_hard_limit|insufficient_quota)/i.test(`${quotaMetric} ${data?.error?.code || ""} ${data?.error?.type || ""}`)
      || (metricMatch && Number(metricMatch[2]) === 0);
    return {
      providerStatus: 429,
      retryAfterMs: Math.max(0, Math.ceil(delay)),
      quotaMetric,
      inputTokenLimit,
      verifiedInputTokenRateLimit: !hardQuota && inputTokenLimit !== null && /input_token/i.test(quotaMetric),
      rateLimitRetryable: !hardQuota && data?.rateLimitRetryable !== false,
    };
  }
  // A conservative character budget, not a tokenizer or a model context limit.
  // It is enabled only after the provider confirms an input-token rate quota.
  function inputQuotaCharacterBudget(limit) {
    return Number(limit) > 2000 ? Math.floor((Number(limit) - 2000) * 2) : 0;
  }
  return { parseRateLimit, inputQuotaCharacterBudget };
});
