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
    const rawMetric = String(data?.quotaMetric || metricMatch?.[1] || "");
    const exactMetric = /^[A-Za-z0-9._/-]{1,180}$/.test(rawMetric);
    const quotaMetric = rawMetric.replace(/[^A-Za-z0-9._/-]/g, "_").slice(0, 180);
    const limit = Number(data?.inputTokenLimit ?? (/input_token/i.test(quotaMetric) ? metricMatch?.[2] : undefined));
    const inputTokenLimit = Number.isFinite(limit) && limit > 0 ? limit : null;
    // Providers append generic plan/billing advice and documentation links to
    // retryable input-token errors. Those words are not billing exhaustion.
    // Prefer explicit codes and named failed quotas; never infer a hard stop
    // from a mention of "billing" anywhere in the provider's prose.
    const hardCode = /(?:insufficient_quota|insufficient_balance|insufficient_credits|billing_hard_limit|billing_limit_exceeded|daily_quota_exceeded)/i
      .test(`${data?.error?.code || data?.code || ""} ${data?.error?.type || data?.type || ""}`);
    const violations = (Array.isArray(data?.error?.details) ? data.error.details : [])
      .filter(item => /QuotaFailure$/.test(item?.["@type"] || ""))
      .flatMap(item => Array.isArray(item.violations) ? item.violations : []);
    const hardMetric = [quotaMetric, ...violations.flatMap(item => [item?.quotaMetric, item?.quotaId])]
      .some(value => /per[_ -]?day|daily|billing/i.test(String(value || "")));
    const zeroLimit = Boolean(metricMatch && Number(metricMatch[2]) === 0) ||
      violations.some(item => ["string", "number"].includes(typeof item?.quotaValue) && String(item.quotaValue).trim() !== "" && Number(item.quotaValue) === 0);
    const prose = message.replace(/https?:\/\/\S+/gi, "");
    const hardMessage = /(?:^|[.!?\n]\s*)(?:your |the )?(?:daily|per[- ]day|billing) (?:[a-z]+ ){0,3}(?:quota|limit|balance) (?:has been |is |was )?(?:exceeded|exhausted|reached|depleted)\b/i.test(prose)
      || /\binsufficient (?:credits|funds|balance)\b|\b(?:credit|account) balance (?:is )?(?:exhausted|depleted|zero)\b/i.test(prose);
    const hardQuota = hardCode || hardMetric || zeroLimit || hardMessage;
    const verifiedInputTokenRateLimit = !hardQuota && exactMetric && inputTokenLimit !== null &&
      /input[_-]?tokens?/i.test(quotaMetric) && !/output|requests?/i.test(quotaMetric);
    const quotaClassificationReason = hardCode ? "explicit_hard_quota_code" : hardMetric ? "hard_quota_metric"
      : zeroLimit ? "zero_quota_limit" : hardMessage ? "explicit_hard_quota_message"
      : data?.rateLimitRetryable === false ? "provider_non_retryable"
      : verifiedInputTokenRateLimit ? "verified_input_token_quota" : "generic_rate_limit";
    return {
      providerStatus: 429,
      retryAfterMs: Math.max(0, Math.ceil(delay)),
      quotaMetric,
      inputTokenLimit,
      verifiedInputTokenRateLimit,
      rateLimitRetryable: !hardQuota && data?.rateLimitRetryable !== false,
      quotaClassificationReason,
    };
  }
  // A conservative character budget, not a tokenizer or a model context limit.
  // It is enabled only after the provider confirms an input-token rate quota.
  function inputQuotaCharacterBudget(limit) {
    return Number(limit) > 2000 ? Math.floor((Number(limit) - 2000) * 2) : 0;
  }
  // An opaque equality check, not an inference about window length, ownership
  // or model capacity. Only two explicit, identical input-quota reports qualify.
  function sameInputTokenQuota(first, second) {
    return Boolean(first?.verifiedInputTokenRateLimit && second?.verifiedInputTokenRateLimit &&
      first.rateLimitRetryable && second.rateLimitRetryable && first.quotaMetric &&
      first.quotaMetric === second.quotaMetric && first.inputTokenLimit === second.inputTokenLimit);
  }
  return { parseRateLimit, inputQuotaCharacterBudget, sameInputTokenQuota };
});
