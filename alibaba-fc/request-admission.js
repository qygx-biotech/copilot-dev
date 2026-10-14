"use strict";
// Lives in shared/agent/ with the desktop agent loop; the FC model proxy uses it too.
// Prefer the repository copy; deployed FC packages carry the synced copy.
module.exports = require((() => { try { return require.resolve("../shared/agent/request-admission.js"); } catch { return "./shared/agent/request-admission.js"; } })());
