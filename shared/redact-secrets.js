(function exposeRedactSecrets(root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.BioDesignRedactSecrets = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function redactSecretsFactory() {
  "use strict";

  // Best-effort removal of credentials from text that leaves the app (bug
  // reports) or is kept long term (memories). Ported from Codex
  // (codex-rs/secrets/src/sanitizer.rs), plus JSON Web Tokens, which BioDesign
  // sessions use.
  const REDACTED = "[REDACTED_SECRET]";
  const BEARER = /\bBearer[ \t]+[A-Za-z0-9._~+/-]{16,}=*/gi;
  const JWT = /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g;
  const OPENAI_KEY = /sk-[A-Za-z0-9]{20,}/g;
  const AWS_ACCESS_KEY_ID = /\bAKIA[0-9A-Z]{16}\b/g;
  const ASSIGNMENT = /\b(api[_-]?key|token|secret|password|authorization)\b(\s*[:=]\s*)(["']?)[^\s"']{8,}/gi;

  function redactSecrets(text) {
    return String(text)
      .replace(BEARER, `Bearer ${REDACTED}`)
      .replace(JWT, REDACTED)
      .replace(OPENAI_KEY, REDACTED)
      .replace(AWS_ACCESS_KEY_ID, REDACTED)
      .replace(ASSIGNMENT, `$1$2$3${REDACTED}`);
  }

  // Every string in a JSON-compatible value, keys included.
  function redactValue(value) {
    if (typeof value === "string") return redactSecrets(value);
    if (Array.isArray(value)) return value.map(redactValue);
    if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [redactSecrets(key), redactValue(item)]));
    return value;
  }

  return Object.freeze({ REDACTED, redactSecrets, redactValue });
});
