(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.BioDesignBackendConfig = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";
  // Change this selector to switch every FC request, including download fallback.
  // Run npm run desktop:prepare and restart after editing; rebuild packaged apps.
  const FC_ENVIRONMENT = "development";
  const FC_ENDPOINTS = Object.freeze({
    development: "https://biodesidev-base-nkindwwsvf.cn-beijing.fcapp.run",
    // Previous deployment retained for testing; update here when it changes.
    testing: "https://biodesi-api-dev-jvvowibabk.cn-beijing.fcapp.run",
  });
  const FC_BASE_URL = FC_ENDPOINTS[FC_ENVIRONMENT];
  if (!FC_BASE_URL) throw new Error(`Unknown FC environment: ${FC_ENVIRONMENT}`);
  return Object.freeze({ FC_ENVIRONMENT, FC_ENDPOINTS, FC_BASE_URL });
});
