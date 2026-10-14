"use strict";
// Moved to shared/agent/ so the FC and desktop agent loops run the same code.
// Prefer the repository copy; deployed FC packages carry the synced copy.
module.exports = require((() => { try { return require.resolve("../shared/agent/requesty-response.js"); } catch { return "./shared/agent/requesty-response.js"; } })());
